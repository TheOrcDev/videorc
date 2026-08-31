use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex as StdMutex, TryLockError, mpsc as std_mpsc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use futures_util::FutureExt;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use rayon::prelude::*;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::camera_capture::{
    CameraFormatSummary, CameraFrameRateEndpoint, camera_capability_matrix_for_id,
    parse_native_camera_id, parse_windows_dshow_camera_id, resolve_camera_frame_rate,
};
use crate::color::{ycbcr_bt709_full_to_bgr, ycbcr_bt709_video_to_bgr};
use crate::diagnostics::{
    PreviewCameraCaptureStats, PreviewCameraCaptureTimingStats,
    apply_preview_camera_capability_stats, apply_preview_camera_capture_stats,
    apply_preview_camera_capture_timing_stats, apply_preview_camera_source_stats,
    apply_preview_source_frame_store_stats,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::frame_store::{FrameHandle, FrameStore, FrameStoreStats, SurfaceBackingTrackerHandle};
use crate::preview_bmp::{LatestPreviewBmpPoll, PreviewBmpCursor, encode_latest_bgra_bmp};
#[cfg(any(target_os = "windows", test))]
use crate::protocol::{CameraAspect, CameraShape, CameraSize, CameraTransformMode, LayoutPreset};
use crate::protocol::{
    CameraCapabilityFormat, LayoutSettings, PreviewCameraDropReasonStats, PreviewCameraStartParams,
    PreviewCameraState, PreviewCameraStatus, SourceSelection, VideoSettings,
};
use crate::source_registry::{SourceConsumerReason, SourceKey};
use crate::source_status::SourceLifecycleStatus;
use crate::state::{AppState, CaptureRecoveryExplicitCameraMutationLease};

const PREVIEW_CAMERA_DEFAULT_PNG_WIDTH: u32 = 1280;
const PREVIEW_CAMERA_MAX_PNG_WIDTH: u32 = 1920;
#[cfg(any(target_os = "windows", test))]
const CAMERA_REFERENCE_WIDTH: u32 = 1280;
#[cfg(any(target_os = "windows", test))]
const CAMERA_REFERENCE_HEIGHT: u32 = 720;
const CAMERA_CAPTURE_CPU_COPY_ENV: &str = "VIDEORC_CAMERA_CAPTURE_CPU_COPY";
const WINDOWS_CAMERA_PREVIEW_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const CAMERA_COMMAND_TRANSITION_TIMEOUT: Duration = Duration::from_secs(15);
const CAMERA_STOP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(any(target_os = "windows", test))]
const WINDOWS_CAMERA_RATE_CAP_EPSILON_SECONDS: f64 = 0.000_001;

fn native_camera_preview_thread_startup_timeout() -> Duration {
    if cfg!(target_os = "windows") {
        WINDOWS_CAMERA_PREVIEW_STARTUP_TIMEOUT
    } else {
        Duration::from_secs(4)
    }
}

fn native_preview_surface_env_enabled() -> bool {
    // v1 default: the native CAMetalLayer surface IS the production preview. The env
    // var remains a developer kill switch only (VIDEORC_NATIVE_PREVIEW_SURFACE=0).
    match std::env::var("VIDEORC_NATIVE_PREVIEW_SURFACE").ok() {
        Some(value) => truthy_env_value(Some(value.as_str())),
        None => true,
    }
}

fn forced_camera_capture_cpu_copy_enabled() -> bool {
    truthy_env_value(std::env::var(CAMERA_CAPTURE_CPU_COPY_ENV).ok().as_deref())
}

fn truthy_env_value(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn should_skip_camera_capture_cpu_copy_for_config(
    zero_copy_source_handle_available: bool,
    source_zerocopy_enabled: bool,
    native_preview_surface_enabled: bool,
    forced_cpu_copy_enabled: bool,
) -> bool {
    zero_copy_source_handle_available
        && source_zerocopy_enabled
        && native_preview_surface_enabled
        && !forced_cpu_copy_enabled
}

fn should_skip_camera_capture_cpu_copy(zero_copy_source_handle_available: bool) -> bool {
    should_skip_camera_capture_cpu_copy_for_config(
        zero_copy_source_handle_available,
        source_zerocopy_enabled(),
        native_preview_surface_env_enabled(),
        forced_camera_capture_cpu_copy_enabled(),
    )
}

#[cfg(target_os = "macos")]
use crate::metal_compositor::source_zerocopy_enabled;

/// Zero-copy source handoff is Metal/IOSurface-backed and exists only on macOS.
#[cfg(not(target_os = "macos"))]
fn source_zerocopy_enabled() -> bool {
    false
}

pub type PreviewCameraSlot = Arc<tokio::sync::Mutex<PreviewCameraRuntime>>;

#[derive(Debug)]
pub struct PreviewCameraRuntime {
    pub status: PreviewCameraStatus,
    /// Source-level ownership keeps surface-backed frames observable while a
    /// capture session replaces its per-session `FrameStore`.
    surface_backing_tracker: SurfaceBackingTrackerHandle,
    run_id: Option<String>,
    source_key: Option<SourceKey>,
    starting: Option<PreviewCameraStartKey>,
    /// Completion boundary for the persistent supervisor that owns the current
    /// Starting generation. Layout work that holds shutdown admission across a
    /// delayed transition clones this token before runtime ownership can move.
    starting_transition_completion: Option<Arc<PreviewCameraTransitionCompletion>>,
    /// Present only when `starting` was admitted by capture recovery. An
    /// operator start with the same exact key must supersede that lease instead
    /// of joining a worker whose recovery ticket has just been invalidated.
    starting_recovery_epoch: Option<u64>,
    /// Layout intent that currently owns cancellation authority for this
    /// Starting generation. Same-key layout joins transfer this owner; a public
    /// camera command clears it so stale layout timeouts cannot stop that
    /// operator-owned generation.
    starting_layout_intent_id: Option<u64>,
    start_generation: u64,
    /// Desired stop generation. The native owner is deliberately retained in
    /// `active` until the transition supervisor has stopped and joined it.
    /// This lets command callers time out without losing physical ownership.
    pending_stop_generation: Option<u64>,
    /// Generation of `active`. Kept separate from the next/in-flight start
    /// lease so readers can never observe an old session under a new identity.
    active_generation: Option<u64>,
    /// Serializes stop/join/start transitions. A recovery restart must never
    /// overlap the native session it is replacing (or a concurrent user start).
    transition_gate: Arc<tokio::sync::Mutex<()>>,
    /// Opaque authority for retrying a recovery start that reached a terminal
    /// Failed state before publishing a replacement session. The token is
    /// generation-bound and is invalidated by every ordinary start/stop.
    failed_recovery_retry: Option<PreviewCameraFailedRecoveryRetry>,
    /// Native ownership registered immediately after a successful thread spawn
    /// and before startup readiness can suspend or panic.
    pending_native: Option<PendingNativeCameraThread>,
    active: Option<NativeCameraPreviewThread>,
    poll_task: Option<JoinHandle<()>>,
    /// When the current session acked Live. macOS acks Live as soon as
    /// startRunning() returns — before any frame exists — so a session can be
    /// "live" and frameless. This timestamp bounds how long that is treated
    /// as normal startup rather than a dead session (see
    /// camera_live_session_is_frameless_zombie).
    live_acked_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewCameraStartKey {
    source_key: SourceKey,
    ffmpeg_path: String,
    video: VideoSettings,
    target_fps: u32,
    /// Derived capture box (inset overlay vs full canvas). Two starts that
    /// agree on everything else but need different capture geometry must not
    /// join each other's in-flight session.
    capture_target: (u32, u32),
}

#[derive(Debug, Clone)]
struct PreviewCameraStartLease {
    key: PreviewCameraStartKey,
    generation: u64,
    transition_completion: Arc<PreviewCameraTransitionCompletion>,
}

impl PreviewCameraStartLease {
    fn new(key: PreviewCameraStartKey, generation: u64) -> Self {
        Self {
            key,
            generation,
            transition_completion: Arc::new(PreviewCameraTransitionCompletion::default()),
        }
    }
}

impl PartialEq for PreviewCameraStartLease {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key && self.generation == other.generation
    }
}

impl Eq for PreviewCameraStartLease {}

#[derive(Debug, Default)]
struct PreviewCameraTransitionCompletion {
    completed: AtomicBool,
    notify: Notify,
}

impl PreviewCameraTransitionCompletion {
    fn complete(&self) {
        if !self.completed.swap(true, AtomicOrdering::AcqRel) {
            self.notify.notify_waiters();
        }
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if self.completed.load(AtomicOrdering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

struct PreviewCameraTransitionCompletionGuard {
    completion: Arc<PreviewCameraTransitionCompletion>,
}

impl PreviewCameraTransitionCompletionGuard {
    fn new(completion: Arc<PreviewCameraTransitionCompletion>) -> Self {
        Self { completion }
    }
}

impl Drop for PreviewCameraTransitionCompletionGuard {
    fn drop(&mut self) {
        self.completion.complete();
    }
}

/// Exact authority for cancelling one camera generation that was observed
/// while it was still Starting. Layout timeout cleanup must carry this token
/// from its readiness sample to the stop CAS: a newer public camera start does
/// not share the layout-intent mutex and must never be mistaken for the expired
/// generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewCameraStartingIdentity {
    pub source_key: SourceKey,
    pub generation: u64,
    pub layout_intent_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewCameraLayoutStart {
    pub status: PreviewCameraStatus,
    /// Present only when this layout request admitted a fresh generation. A
    /// joined/reused public generation remains owned by that independent
    /// request and layout timeout cleanup must leave it alone.
    pub admitted_starting_identity: Option<PreviewCameraStartingIdentity>,
}

impl PreviewCameraLayoutStart {
    fn without_admission(status: PreviewCameraStatus) -> Self {
        Self {
            status,
            admitted_starting_identity: None,
        }
    }
}

#[derive(Debug, Clone)]
enum PreviewCameraStartRegistration {
    JoinExisting {
        admitted_starting_identity: Option<PreviewCameraStartingIdentity>,
        transition_completion: Arc<PreviewCameraTransitionCompletion>,
    },
    Reused(PreviewCameraStatus),
    RejectedSuperseded(PreviewCameraStatus),
    RejectedShutdown(PreviewCameraStatus),
    Started {
        lease: PreviewCameraStartLease,
    },
}

impl PartialEq for PreviewCameraStartRegistration {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::JoinExisting {
                    admitted_starting_identity: left,
                    ..
                },
                Self::JoinExisting {
                    admitted_starting_identity: right,
                    ..
                },
            ) => left == right,
            (Self::Reused(left), Self::Reused(right)) => left == right,
            (Self::RejectedSuperseded(left), Self::RejectedSuperseded(right)) => left == right,
            (Self::RejectedShutdown(left), Self::RejectedShutdown(right)) => left == right,
            (Self::Started { lease: left }, Self::Started { lease: right }) => left == right,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewCameraStartWait {
    Bounded,
    TransitionComplete,
}

#[derive(Debug, Clone, PartialEq)]
struct PreviewCameraRestartConfig {
    camera_id: String,
    device_unique_id: String,
    ffmpeg_path: String,
    layout: LayoutSettings,
    video: VideoSettings,
    target_fps: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct PreviewCameraFailedRecoveryRetry {
    source_key: SourceKey,
    generation: u64,
    config_fingerprint: u64,
    config: PreviewCameraRestartConfig,
}

/// Generation-bound authority to restart the exact live camera configuration.
/// The configuration stays private to this module so recovery never has to
/// reconstruct capture parameters from renderer state.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewCameraRestartSnapshot {
    pub source_key: SourceKey,
    pub generation: u64,
    pub config_fingerprint: u64,
    config: PreviewCameraRestartConfig,
}

#[derive(Debug, Clone, PartialEq)]
// Recovery consumes this result immediately. Keeping the generation-bound
// status snapshot inline avoids adding heap ownership to the restart handoff.
#[allow(clippy::large_enum_variant)]
pub(crate) enum PreviewCameraForceRestartResult {
    Restarted {
        status: PreviewCameraStatus,
        generation: u64,
    },
    RejectedStale,
}

/// A recovery generation whose source-transition ownership has already been
/// registered with the process-wide fence. Session startup may safely snapshot
/// that fence after this value is returned; waiting for native stop/start is a
/// separate, potentially blocking completion phase.
pub(crate) struct PreviewCameraForceRestartAttempt {
    generation: u64,
    source_key: SourceKey,
    completion: JoinHandle<PreviewCameraStatus>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewCameraRecoveryEvidence {
    pub source_key: SourceKey,
    pub generation: u64,
    pub target_fps: u32,
    pub source_fps: Option<f64>,
    pub capture_callback_count: u64,
    pub frame_store_publications: u64,
    pub did_drop_callback_count: u64,
    pub out_of_buffers: u64,
    pub surface_backing_live_count: u64,
    pub surface_backing_peak_count: u64,
    pub latest_sequence: Option<u64>,
    pub frame_age_ms: Option<u64>,
    pub requested_width: Option<u32>,
    pub requested_height: Option<u32>,
    pub configured_width: Option<u32>,
    pub configured_height: Option<u32>,
    pub actual_width: Option<u32>,
    pub actual_height: Option<u32>,
}

#[derive(Clone)]
struct PreparedCameraStart {
    camera_id: String,
    device_unique_id: String,
    ffmpeg_path: String,
    target_fps: u32,
    source_key: SourceKey,
    params: PreviewCameraStartParams,
    lease: PreviewCameraStartLease,
    layout_intent_id: Option<u64>,
    recovery: Option<PreparedCameraRecoveryAdmission>,
}

#[derive(Clone)]
struct PreparedCameraRecoveryAdmission {
    epoch: u64,
    previous_status: PreviewCameraStatus,
    previous_run_id: Option<String>,
    previous_live_acked_at: Option<Instant>,
}

#[derive(Debug)]
struct NativeCameraPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewCameraShared>>,
    camera_id: String,
    device_unique_id: String,
    ffmpeg_path: String,
    layout: LayoutSettings,
    video: VideoSettings,
    /// Stable cadence negotiated when this generation started. This is never
    /// replaced with the observed delivery rate: doing so would let a decaying
    /// source lower its own liveness threshold.
    effective_fps: u32,
    /// Immutable output geometry selected at startup for this generation.
    /// Recovery compares direct FrameStore dimensions against this exact box.
    configured_output: (u32, u32),
    /// The capture target box this session's AVFoundation output geometry was
    /// derived from at start. `layout` above is refreshed on reuse as
    /// bookkeeping, so it cannot answer "what geometry is this session
    /// actually delivering" — this field can.
    capture_target: (u32, u32),
}

#[derive(Debug)]
struct PendingNativeCameraThread {
    generation: u64,
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
}

/// Wait handle for a camera stop that was admitted and handed to a persistent
/// transition supervisor. Dropping this value only detaches the waiter; the
/// supervisor continues to own and retire the native session.
pub(crate) struct PreviewCameraStop {
    status: PreviewCameraStatus,
    completion: Option<JoinHandle<PreviewCameraStatus>>,
}

#[cfg(test)]
pub(crate) type PreviewCameraTransitionGuard = tokio::sync::OwnedMutexGuard<()>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewCameraPixelFormat {
    Bgra8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CameraCaptureDropReason {
    FrameWasLate,
    OutOfBuffers,
    Discontinuity,
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CameraCaptureDropReasonCounts {
    frame_was_late: u64,
    out_of_buffers: u64,
    discontinuity: u64,
    unknown: u64,
}

impl CameraCaptureDropReasonCounts {
    fn record(&mut self, reason: CameraCaptureDropReason) {
        let counter = match reason {
            CameraCaptureDropReason::FrameWasLate => &mut self.frame_was_late,
            CameraCaptureDropReason::OutOfBuffers => &mut self.out_of_buffers,
            CameraCaptureDropReason::Discontinuity => &mut self.discontinuity,
            CameraCaptureDropReason::Unknown => &mut self.unknown,
        };
        *counter = counter.saturating_add(1);
    }

    fn total(self) -> u64 {
        self.frame_was_late
            .saturating_add(self.out_of_buffers)
            .saturating_add(self.discontinuity)
            .saturating_add(self.unknown)
    }

    fn diagnostic_stats(self) -> PreviewCameraDropReasonStats {
        PreviewCameraDropReasonStats {
            frame_was_late: self.frame_was_late,
            out_of_buffers: self.out_of_buffers,
            discontinuity: self.discontinuity,
            unknown: self.unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewCameraFrameInfo {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub frame_age_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PreviewCameraFrameSource {
    shared: Arc<StdMutex<PreviewCameraShared>>,
    layout: LayoutSettings,
    source_key: Option<SourceKey>,
    target_fps: u32,
    generation: u64,
}

impl PreviewCameraFrameSource {
    pub fn source_key(&self) -> Option<&SourceKey> {
        self.source_key.as_ref()
    }

    pub fn target_fps(&self) -> u32 {
        self.target_fps
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn try_latest_frame_result(
        &self,
    ) -> Result<Option<(FrameHandle<PreviewCameraPixelFormat>, LayoutSettings)>, ()> {
        match self.shared.try_lock() {
            Ok(guard) => Ok(guard
                .frame_store
                .latest()
                .map(|frame| (frame, self.layout.clone()))),
            Err(TryLockError::WouldBlock) => Err(()),
            Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned
                .into_inner()
                .frame_store
                .latest()
                .map(|frame| (frame, self.layout.clone()))),
        }
    }

    pub fn latest_frame_blocking(
        &self,
    ) -> Option<(FrameHandle<PreviewCameraPixelFormat>, LayoutSettings)> {
        let frame = self
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .frame_store
            .latest()?;
        Some((frame, self.layout.clone()))
    }
}

#[derive(Debug, Default)]
pub struct PreviewCameraShared {
    frame_store: FrameStore<PreviewCameraPixelFormat>,
    capture_callback_count: u64,
    frames_captured: u64,
    dropped_frames: u64,
    capture_drop_reasons: CameraCaptureDropReasonCounts,
    capture_pixel_format: Option<u32>,
    frames_in_window: u64,
    window_started_at: Option<Instant>,
    source_fps: Option<f64>,
    capture_timings: CameraCaptureTimingWindow,
}

impl PreviewCameraShared {
    fn with_surface_backing_tracker(tracker: SurfaceBackingTrackerHandle) -> Self {
        Self {
            frame_store: FrameStore::new_with_surface_backing_tracker(1, tracker),
            ..Self::default()
        }
    }
}

#[derive(Debug, Default)]
struct CameraCaptureTimingWindow {
    last_callback_at: Option<Instant>,
    last_sample_pts_seconds: Option<f64>,
    callback_gap_ms: Vec<f64>,
    sample_pts_gap_ms: Vec<f64>,
    pixel_buffer_lock_ms: Vec<f64>,
    row_copy_ms: Vec<f64>,
    publish_ms: Vec<f64>,
    frame_bytes: u64,
}

impl CameraCaptureTimingWindow {
    fn record_callback_at(&mut self, now: Instant) {
        if let Some(previous) = self.last_callback_at.replace(now) {
            push_timing_sample(
                &mut self.callback_gap_ms,
                now.duration_since(previous).as_secs_f64() * 1000.0,
            );
        }
    }

    fn record_sample_pts(&mut self, sample_pts_seconds: Option<f64>) {
        let Some(sample_pts_seconds) = sample_pts_seconds else {
            return;
        };
        if let Some(previous) = self.last_sample_pts_seconds.replace(sample_pts_seconds) {
            let gap_ms = (sample_pts_seconds - previous).abs() * 1000.0;
            if gap_ms.is_finite() {
                push_timing_sample(&mut self.sample_pts_gap_ms, gap_ms);
            }
        }
    }

    fn record_valid_frame(
        &mut self,
        pixel_buffer_lock_ms: f64,
        row_copy_ms: f64,
        publish_ms: f64,
        frame_bytes: u64,
    ) {
        push_timing_sample(&mut self.pixel_buffer_lock_ms, pixel_buffer_lock_ms);
        push_timing_sample(&mut self.row_copy_ms, row_copy_ms);
        push_timing_sample(&mut self.publish_ms, publish_ms);
        self.frame_bytes = frame_bytes;
    }

    fn reset(&mut self) {
        self.last_callback_at = None;
        self.last_sample_pts_seconds = None;
        self.callback_gap_ms.clear();
        self.sample_pts_gap_ms.clear();
        self.pixel_buffer_lock_ms.clear();
        self.row_copy_ms.clear();
        self.publish_ms.clear();
    }

    fn snapshot(&self) -> PreviewCameraCaptureTimingStats {
        PreviewCameraCaptureTimingStats {
            capture_gap_p95_ms: percentile(&self.callback_gap_ms, 95),
            capture_gap_p99_ms: percentile(&self.callback_gap_ms, 99),
            capture_gap_max_ms: max_sample(&self.callback_gap_ms),
            sample_pts_gap_p95_ms: percentile(&self.sample_pts_gap_ms, 95),
            sample_pts_gap_p99_ms: percentile(&self.sample_pts_gap_ms, 99),
            sample_pts_gap_max_ms: max_sample(&self.sample_pts_gap_ms),
            pixel_buffer_lock_p95_ms: percentile(&self.pixel_buffer_lock_ms, 95),
            row_copy_p95_ms: percentile(&self.row_copy_ms, 95),
            publish_p95_ms: percentile(&self.publish_ms, 95),
            frame_bytes: self.frame_bytes,
        }
    }
}

fn push_timing_sample(samples: &mut Vec<f64>, value: f64) {
    const MAX_SAMPLES: usize = 240;
    if samples.len() >= MAX_SAMPLES {
        samples.remove(0);
    }
    samples.push(value);
}

fn percentile(samples: &[f64], p: u32) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let index = (((p as f64 / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    Some(sorted[index])
}

fn max_sample(samples: &[f64]) -> Option<f64> {
    samples.iter().copied().max_by(f64::total_cmp)
}

fn stable_capture_config_fingerprint(bytes: &[u8]) -> u64 {
    // Explicit FNV-1a keeps the diagnostic stable across processes and Rust
    // versions (unlike DefaultHasher, whose algorithm is not a contract).
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn camera_config_fingerprint(start_key: &PreviewCameraStartKey, layout: &LayoutSettings) -> u64 {
    let encoded = serde_json::to_vec(&(
        &start_key.source_key,
        &start_key.ffmpeg_path,
        &start_key.video,
        start_key.target_fps,
        start_key.capture_target,
        layout,
    ))
    .unwrap_or_default();
    stable_capture_config_fingerprint(&encoded)
}

fn camera_restart_start_key(
    source_key: &SourceKey,
    config: &PreviewCameraRestartConfig,
) -> PreviewCameraStartKey {
    PreviewCameraStartKey {
        source_key: source_key.clone(),
        ffmpeg_path: config.ffmpeg_path.clone(),
        video: config.video.clone(),
        target_fps: config.target_fps,
        capture_target: camera_capture_target_dimensions(&config.layout, &config.video),
    }
}

fn camera_restart_config_fingerprint(
    source_key: &SourceKey,
    config: &PreviewCameraRestartConfig,
) -> u64 {
    camera_config_fingerprint(
        &camera_restart_start_key(source_key, config),
        &config.layout,
    )
}

fn stable_effective_camera_fps(selected_fps: f64, requested_fps: u32) -> u32 {
    if selected_fps.is_finite() && selected_fps > 0.0 {
        selected_fps.round().clamp(1.0, 120.0) as u32
    } else {
        requested_fps.clamp(1, 120)
    }
}

fn negotiated_camera_fps(
    active_duration_fps: Option<f64>,
    applied_fps: Option<f64>,
    native_format_fallback_fps: f64,
) -> f64 {
    active_duration_fps
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .or_else(|| applied_fps.filter(|fps| fps.is_finite() && *fps > 0.0))
        .unwrap_or_else(|| {
            if native_format_fallback_fps.is_finite() && native_format_fallback_fps > 0.0 {
                native_format_fallback_fps
            } else {
                30.0
            }
        })
}

fn log_camera_generation(
    generation: u64,
    reason: &'static str,
    start_key: &PreviewCameraStartKey,
    layout: &LayoutSettings,
) {
    tracing::info!(
        "[capture-generation] source=camera generation={} reason={} config={:016x}",
        generation,
        reason,
        camera_config_fingerprint(start_key, layout),
    );
}

pub fn initial_preview_camera_state() -> PreviewCameraRuntime {
    PreviewCameraRuntime {
        status: idle_status(Some("Native camera preview is not running.".to_string())),
        surface_backing_tracker: SurfaceBackingTrackerHandle::default(),
        run_id: None,
        source_key: None,
        starting: None,
        starting_transition_completion: None,
        starting_recovery_epoch: None,
        starting_layout_intent_id: None,
        start_generation: 0,
        pending_stop_generation: None,
        active_generation: None,
        transition_gate: Arc::new(tokio::sync::Mutex::new(())),
        failed_recovery_retry: None,
        pending_native: None,
        active: None,
        poll_task: None,
        live_acked_at: None,
    }
}

/// Reconcile operator-owned camera configuration truth on the process runtime.
/// Awaiting the returned JoinHandle preserves prompt command semantics, while
/// cancellation of a disposable caller drops only its waiter: the recovery
/// reset itself still completes.
pub(crate) async fn reconcile_explicit_camera_configuration_change(state: &AppState) {
    let reconciliation_state = state.clone();
    let completion = state.spawn_process_task(async move {
        crate::capture_recovery::note_explicit_camera_configuration_changed(&reconciliation_state)
            .await;
    });
    if let Err(error) = completion.await {
        tracing::error!("Explicit camera recovery reconciliation task failed: {error}");
    }
}

/// Order an explicit scene/configuration intent against the final native
/// camera install boundary. The synchronous recovery-admission gate advances
/// the sampled camera-mutation epoch and clears physical admission together,
/// while this preview lock orders that publication against installation.
pub(crate) async fn begin_capture_recovery_explicit_camera_configuration_mutation(
    state: &AppState,
) -> CaptureRecoveryExplicitCameraMutationLease {
    let _camera_authority = state.preview_camera.lock().await;
    state.begin_capture_recovery_explicit_camera_mutation()
}

async fn finish_capture_recovery_explicit_camera_configuration_mutation(
    state: &AppState,
    mutation: CaptureRecoveryExplicitCameraMutationLease,
) {
    mutation.finish();
    reconcile_explicit_camera_configuration_change(state).await;
}

fn camera_start_rejected_for_shutdown(mut status: PreviewCameraStatus) -> PreviewCameraStatus {
    status.updated_at = Utc::now().to_rfc3339();
    status.message =
        Some("Camera start rejected because backend shutdown is already in progress.".to_string());
    status
}

pub async fn start_preview_camera(
    state: AppState,
    params: PreviewCameraStartParams,
) -> PreviewCameraStatus {
    start_preview_camera_with_owner(state, params, None, None, PreviewCameraStartWait::Bounded)
        .await
        .status
}

pub(crate) async fn start_preview_camera_for_layout(
    state: AppState,
    params: PreviewCameraStartParams,
    layout_intent_id: u64,
    admission_ready: oneshot::Sender<Option<PreviewCameraStartingIdentity>>,
) -> PreviewCameraLayoutStart {
    start_preview_camera_with_owner(
        state,
        params,
        Some(layout_intent_id),
        Some(admission_ready),
        PreviewCameraStartWait::Bounded,
    )
    .await
}

/// Layout-owned start whose caller also owns a shutdown-admission fence. Unlike
/// the command-facing start, this does not release its caller at the 15-second
/// response boundary: it waits for the persistent transition supervisor that
/// owns the exact admitted generation to finish. Same-key joins share that
/// generation completion boundary, even if runtime `starting` is superseded.
pub(crate) async fn start_preview_camera_for_layout_until_transition_complete(
    state: AppState,
    params: PreviewCameraStartParams,
    layout_intent_id: u64,
    admission_ready: oneshot::Sender<Option<PreviewCameraStartingIdentity>>,
) -> PreviewCameraLayoutStart {
    start_preview_camera_with_owner(
        state,
        params,
        Some(layout_intent_id),
        Some(admission_ready),
        PreviewCameraStartWait::TransitionComplete,
    )
    .await
}

async fn start_preview_camera_with_owner(
    state: AppState,
    params: PreviewCameraStartParams,
    layout_intent_id: Option<u64>,
    mut admission_ready: Option<oneshot::Sender<Option<PreviewCameraStartingIdentity>>>,
    wait: PreviewCameraStartWait,
) -> PreviewCameraLayoutStart {
    if state.process_shutdown_requested() {
        let status = camera_start_rejected_for_shutdown(preview_camera_status(&state).await);
        signal_camera_layout_admission(&mut admission_ready, None);
        return PreviewCameraLayoutStart::without_admission(status);
    }
    if layout_intent_id.is_some_and(|intent_id| intent_id < state.latest_layout_intent_id()) {
        let status = preview_camera_status(&state).await;
        signal_camera_layout_admission(&mut admission_ready, None);
        return PreviewCameraLayoutStart::without_admission(status);
    }
    let Some(camera_id) = params.sources.camera_id.clone() else {
        let status = status_for_missing_camera(None, "No camera is selected.");
        if layout_intent_id.is_some() {
            signal_camera_layout_admission(&mut admission_ready, None);
            return PreviewCameraLayoutStart::without_admission(status);
        }
        let explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        let stop = begin_preview_camera_stop(&state).await;
        let _ = finish_preview_camera_stop(stop).await;
        refresh_camera_capability_diagnostics(&state, None).await;
        set_camera_status(&state, status.clone()).await;
        finish_capture_recovery_explicit_camera_configuration_mutation(&state, explicit_mutation)
            .await;
        signal_camera_layout_admission(&mut admission_ready, None);
        return PreviewCameraLayoutStart::without_admission(status);
    };
    let Some(camera_source) = selected_camera_source(&camera_id) else {
        let status = status_for_missing_camera(
            Some(camera_id.clone()),
            "Selected camera is not a supported Videorc camera source.",
        );
        if layout_intent_id.is_some() {
            signal_camera_layout_admission(&mut admission_ready, None);
            return PreviewCameraLayoutStart::without_admission(status);
        }
        let explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        let stop = begin_preview_camera_stop(&state).await;
        let _ = finish_preview_camera_stop(stop).await;
        refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;
        set_camera_status(&state, status.clone()).await;
        finish_capture_recovery_explicit_camera_configuration_mutation(&state, explicit_mutation)
            .await;
        signal_camera_layout_admission(&mut admission_ready, None);
        return PreviewCameraLayoutStart::without_admission(status);
    };
    let explicit_mutation =
        begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
    let unique_id = camera_source.device_unique_id().to_string();
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());
    refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;

    let target_fps = params.video.fps.clamp(1, 120);
    let source_key = SourceKey::camera(camera_id.clone());
    let starting = PreviewCameraStatus {
        state: PreviewCameraState::Starting,
        camera_id: Some(camera_id.clone()),
        device_unique_id: Some(unique_id.clone()),
        target_fps,
        width: None,
        height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        selected_format_width: None,
        selected_format_height: None,
        selected_format_min_fps: None,
        selected_format_max_fps: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        updated_at: Utc::now().to_rfc3339(),
        message: Some("Starting native camera preview.".to_string()),
    };
    let start_key = PreviewCameraStartKey {
        source_key: source_key.clone(),
        ffmpeg_path: ffmpeg_path.clone(),
        video: params.video.clone(),
        target_fps,
        capture_target: camera_capture_target_dimensions(&params.layout, &params.video),
    };
    let start_lease = match begin_camera_start(
        &state,
        start_key.clone(),
        &params.layout,
        starting,
        layout_intent_id,
    )
    .await
    {
        PreviewCameraStartRegistration::JoinExisting {
            admitted_starting_identity,
            transition_completion,
        } => {
            signal_camera_layout_admission(
                &mut admission_ready,
                admitted_starting_identity.clone(),
            );
            let status = match wait {
                PreviewCameraStartWait::Bounded => wait_for_camera_start(&state, &start_key).await,
                PreviewCameraStartWait::TransitionComplete => {
                    transition_completion.wait().await;
                    preview_camera_status(&state).await
                }
            };
            finish_capture_recovery_explicit_camera_configuration_mutation(
                &state,
                explicit_mutation,
            )
            .await;
            return PreviewCameraLayoutStart {
                status,
                admitted_starting_identity,
            };
        }
        PreviewCameraStartRegistration::Reused(status) => {
            signal_camera_layout_admission(&mut admission_ready, None);
            finish_capture_recovery_explicit_camera_configuration_mutation(
                &state,
                explicit_mutation,
            )
            .await;
            return PreviewCameraLayoutStart::without_admission(status);
        }
        PreviewCameraStartRegistration::RejectedSuperseded(status)
        | PreviewCameraStartRegistration::RejectedShutdown(status) => {
            signal_camera_layout_admission(&mut admission_ready, None);
            finish_capture_recovery_explicit_camera_configuration_mutation(
                &state,
                explicit_mutation,
            )
            .await;
            return PreviewCameraLayoutStart::without_admission(status);
        }
        PreviewCameraStartRegistration::Started { lease } => lease,
    };

    log_camera_generation(
        start_lease.generation,
        "normal-start",
        &start_key,
        &params.layout,
    );
    let lease = start_lease.clone();
    let completion = queue_registered_preview_camera(
        state.clone(),
        PreparedCameraStart {
            camera_id,
            device_unique_id: unique_id,
            ffmpeg_path,
            target_fps,
            source_key,
            params,
            lease: start_lease,
            layout_intent_id,
            recovery: None,
        },
        Some(explicit_mutation),
    );
    // The detached process supervisor already owns the admitted generation,
    // including the explicit-mutation lease. Cancelling the command waiter
    // cannot expose recovery while native startup is still in flight. Private
    // force-recovery/retry paths bypass this public operator boundary.
    let admitted_starting_identity =
        layout_intent_id.map(|layout_intent_id| PreviewCameraStartingIdentity {
            source_key: lease.key.source_key.clone(),
            generation: lease.generation,
            layout_intent_id: Some(layout_intent_id),
        });
    signal_camera_layout_admission(&mut admission_ready, admitted_starting_identity.clone());
    PreviewCameraLayoutStart {
        status: match wait {
            PreviewCameraStartWait::Bounded => {
                wait_for_camera_transition_response(&state, completion, &lease).await
            }
            PreviewCameraStartWait::TransitionComplete => {
                wait_for_camera_transition_completion(&state, completion, &lease).await
            }
        },
        admitted_starting_identity,
    }
}

fn signal_camera_layout_admission(
    admission_ready: &mut Option<oneshot::Sender<Option<PreviewCameraStartingIdentity>>>,
    identity: Option<PreviewCameraStartingIdentity>,
) {
    if let Some(admission_ready) = admission_ready.take() {
        let _ = admission_ready.send(identity);
    }
}

/// Synchronously transfers a registered generation into a persistent Tokio
/// supervisor. There is intentionally no await between registration and this
/// spawn: cancellation of the command waiter can never strand a Starting lease
/// without an owner.
fn queue_registered_preview_camera(
    state: AppState,
    prepared: PreparedCameraStart,
    explicit_mutation: Option<CaptureRecoveryExplicitCameraMutationLease>,
) -> JoinHandle<PreviewCameraStatus> {
    let source_transition_guard = state.source_transition_fence.begin();
    let panic_prepared = prepared.clone();
    let panic_lease = prepared.lease.clone();
    let transition_completion =
        PreviewCameraTransitionCompletionGuard::new(Arc::clone(&panic_lease.transition_completion));
    let panic_status = failed_status(
        Some(prepared.camera_id.clone()),
        Some(prepared.device_unique_id.clone()),
        prepared.target_fps,
        "Native camera transition panicked after capture ownership was registered.".to_string(),
    );
    let supervisor_state = state.clone();
    state.spawn_process_task(async move {
        let _source_transition_guard = source_transition_guard;
        let _transition_completion = transition_completion;
        let transition = async {
            let transition_gate = {
                let slot = supervisor_state.preview_camera.lock().await;
                Arc::clone(&slot.transition_gate)
            };
            let _transition = transition_gate.lock().await;
            if let Err(status) =
                ensure_registered_preview_camera_start_is_current(&supervisor_state, &prepared)
                    .await
            {
                return *status;
            }
            publish_camera_start_admission(&supervisor_state, &prepared).await;
            if !camera_start_lease_is_current(&supervisor_state, &prepared.lease).await {
                return preview_camera_status(&supervisor_state).await;
            }
            start_registered_preview_camera(supervisor_state.clone(), prepared).await
        };
        let status = match std::panic::AssertUnwindSafe(transition)
            .catch_unwind()
            .await
        {
            Ok(status) => status,
            Err(_) => {
                retire_panicked_camera_generation(
                    &supervisor_state,
                    &panic_lease,
                    panic_status,
                    Some(&panic_prepared),
                )
                .await
            }
        };
        if let Some(explicit_mutation) = explicit_mutation {
            finish_capture_recovery_explicit_camera_configuration_mutation(
                &supervisor_state,
                explicit_mutation,
            )
            .await;
        }
        status
    })
}

async fn ensure_registered_preview_camera_start_is_current(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> std::result::Result<(), Box<PreviewCameraStatus>> {
    if !prepared_camera_admission_is_current(state, prepared) {
        return Err(Box::new(
            retire_superseded_camera_start(state, prepared).await,
        ));
    }
    ensure_prepared_camera_layout_is_current(state, prepared).await
}

fn prepared_camera_admission_is_current(state: &AppState, prepared: &PreparedCameraStart) -> bool {
    !state.process_shutdown_requested()
        && prepared
            .recovery
            .as_ref()
            .is_none_or(|recovery| state.capture_recovery_admission_is_current(recovery.epoch))
}

fn prepared_camera_layout_is_current_locked(
    state: &AppState,
    slot: &PreviewCameraRuntime,
    prepared: &PreparedCameraStart,
) -> bool {
    let Some(prepared_intent_id) = prepared.layout_intent_id else {
        return true;
    };
    let latest_intent_id = state.latest_layout_intent_id();
    prepared_intent_id == latest_intent_id
        || (slot.start_generation == prepared.lease.generation
            && slot.starting.as_ref() == Some(&prepared.lease.key)
            && slot.starting_layout_intent_id != Some(prepared_intent_id))
}

async fn prepared_camera_layout_is_current(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> bool {
    let slot = state.preview_camera.lock().await;
    prepared_camera_layout_is_current_locked(state, &slot, prepared)
}

async fn ensure_prepared_camera_layout_is_current(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> std::result::Result<(), Box<PreviewCameraStatus>> {
    if prepared_camera_layout_is_current(state, prepared).await {
        return Ok(());
    }
    let Some(layout_intent_id) = prepared.layout_intent_id else {
        return Ok(());
    };
    let expected = PreviewCameraStartingIdentity {
        source_key: prepared.lease.key.source_key.clone(),
        generation: prepared.lease.generation,
        layout_intent_id: Some(layout_intent_id),
    };
    if let Some(stop) = begin_preview_camera_stop_if_starting(state, &expected).await {
        return Err(Box::new(stop.status));
    }
    if prepared_camera_layout_is_current(state, prepared).await {
        Ok(())
    } else {
        Err(Box::new(preview_camera_status(state).await))
    }
}

fn camera_start_admission_is_current_locked(
    state: &AppState,
    slot: &PreviewCameraRuntime,
    lease: Option<&PreviewCameraStartLease>,
    recovery_epoch: Option<u64>,
) -> bool {
    !state.process_shutdown_requested()
        && recovery_epoch.is_none_or(|epoch| state.capture_recovery_admission_is_current(epoch))
        && lease.is_none_or(|lease| {
            slot.start_generation == lease.generation
                && slot.pending_stop_generation.is_none()
                && slot.starting.as_ref() == Some(&lease.key)
        })
}

fn claim_camera_start_if_admitted(
    state: &AppState,
    slot: &mut PreviewCameraRuntime,
    lease: &PreviewCameraStartLease,
    recovery_epoch: Option<u64>,
) -> bool {
    camera_start_admission_is_current_locked(state, slot, Some(lease), recovery_epoch)
        && claim_camera_start(slot, lease)
}

async fn retire_superseded_camera_recovery(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> PreviewCameraStatus {
    let Some(recovery) = prepared.recovery.as_ref() else {
        return camera_start_rejected_for_shutdown(preview_camera_status(state).await);
    };
    let (status, lifecycle, release_source) = {
        let mut slot = state.preview_camera.lock().await;
        if slot.start_generation != prepared.lease.generation
            || slot.starting.as_ref() != Some(&prepared.lease.key)
            || slot.starting_recovery_epoch != Some(recovery.epoch)
        {
            return slot.status.clone();
        }
        slot.starting = None;
        slot.starting_transition_completion = None;
        slot.starting_recovery_epoch = None;
        slot.starting_layout_intent_id = None;
        slot.failed_recovery_retry = None;
        if slot.active.is_some() {
            slot.status = recovery.previous_status.clone();
            slot.run_id = recovery.previous_run_id.clone();
            slot.live_acked_at = recovery.previous_live_acked_at;
            (slot.status.clone(), SourceLifecycleStatus::Live, false)
        } else if recovery.previous_status.state == PreviewCameraState::Failed {
            slot.status = recovery.previous_status.clone();
            slot.run_id = None;
            slot.live_acked_at = None;
            (slot.status.clone(), SourceLifecycleStatus::Failed, false)
        } else {
            let status = idle_status(Some(
                "Camera recovery was superseded after the previous native session retired; no replacement was started."
                    .to_string(),
            ));
            slot.status = status.clone();
            slot.run_id = None;
            slot.source_key = None;
            slot.active_generation = None;
            slot.live_acked_at = None;
            (status, SourceLifecycleStatus::Stopped, true)
        }
    };
    {
        let mut registry = state.source_registry.lock().await;
        if release_source {
            registry.release(
                &prepared.lease.key.source_key,
                &SourceConsumerReason::Preview,
            );
        }
        registry.set_status(prepared.lease.key.source_key.clone(), lifecycle);
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status.clone());
    status
}

async fn retire_superseded_camera_start(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> PreviewCameraStatus {
    if prepared.recovery.is_some() {
        return retire_superseded_camera_recovery(state, prepared).await;
    }
    if let Some(layout_intent_id) = prepared.layout_intent_id {
        let expected = PreviewCameraStartingIdentity {
            source_key: prepared.lease.key.source_key.clone(),
            generation: prepared.lease.generation,
            layout_intent_id: Some(layout_intent_id),
        };
        if let Some(stop) = begin_preview_camera_stop_if_starting(state, &expected).await {
            // The current transition supervisor may own the physical gate.
            // Stop completion is independently process-owned and will run as
            // soon as that supervisor returns, so never wait here.
            return stop.status;
        }
        return preview_camera_status(state).await;
    }
    camera_start_rejected_for_shutdown(preview_camera_status(state).await)
}

async fn current_or_retire_superseded_camera_start(
    state: &AppState,
    prepared: &PreparedCameraStart,
) -> PreviewCameraStatus {
    if !prepared_camera_admission_is_current(state, prepared) {
        retire_superseded_camera_start(state, prepared).await
    } else if let Err(status) = ensure_prepared_camera_layout_is_current(state, prepared).await {
        *status
    } else {
        preview_camera_status(state).await
    }
}

async fn wait_for_camera_transition_response(
    state: &AppState,
    mut completion: JoinHandle<PreviewCameraStatus>,
    lease: &PreviewCameraStartLease,
) -> PreviewCameraStatus {
    match tokio::time::timeout(CAMERA_COMMAND_TRANSITION_TIMEOUT, &mut completion).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            tracing::error!(
                "Camera transition supervisor failed for generation {}: {error}",
                lease.generation
            );
            preview_camera_status(state).await
        }
        Err(_) => delayed_camera_transition_status(state, lease).await,
    }
}

async fn wait_for_camera_transition_completion(
    state: &AppState,
    completion: JoinHandle<PreviewCameraStatus>,
    lease: &PreviewCameraStartLease,
) -> PreviewCameraStatus {
    match completion.await {
        Ok(status) => status,
        Err(error) => {
            tracing::error!(
                "Camera transition supervisor failed for fenced generation {}: {error}",
                lease.generation
            );
            preview_camera_status(state).await
        }
    }
}

async fn start_registered_preview_camera(
    state: AppState,
    prepared: PreparedCameraStart,
) -> PreviewCameraStatus {
    if !prepared_camera_admission_is_current(&state, &prepared) {
        return retire_superseded_camera_start(&state, &prepared).await;
    }
    if let Err(status) = ensure_prepared_camera_layout_is_current(&state, &prepared).await {
        return *status;
    }
    let retirement_prepared = prepared.clone();
    let PreparedCameraStart {
        camera_id,
        device_unique_id: unique_id,
        ffmpeg_path,
        target_fps,
        source_key,
        params,
        lease: start_lease,
        layout_intent_id: _,
        recovery: _,
    } = prepared;

    if !camera_start_lease_is_current(&state, &start_lease).await {
        return preview_camera_status(&state).await;
    }
    let recovery_epoch = retirement_prepared
        .recovery
        .as_ref()
        .map(|recovery| recovery.epoch);
    if !stop_current_camera_for_restart_if_admitted(&state, Some(&start_lease), recovery_epoch)
        .await
    {
        if !prepared_camera_admission_is_current(&state, &retirement_prepared) {
            return retire_superseded_camera_start(&state, &retirement_prepared).await;
        }
        if let Err(status) =
            ensure_prepared_camera_layout_is_current(&state, &retirement_prepared).await
        {
            return *status;
        }
        return preview_camera_status(&state).await;
    }
    // A stop or newer start can supersede this generation while the old
    // native session is synchronously stopping. Never create its replacement
    // unless the lease is still desired after the join completes.
    if !prepared_camera_admission_is_current(&state, &retirement_prepared) {
        return retire_superseded_camera_start(&state, &retirement_prepared).await;
    }
    if let Err(status) =
        ensure_prepared_camera_layout_is_current(&state, &retirement_prepared).await
    {
        return *status;
    }
    if !camera_start_lease_is_current(&state, &start_lease).await {
        return preview_camera_status(&state).await;
    }

    let run_id = Uuid::new_v4().to_string();
    let surface_backing_tracker = state
        .preview_camera
        .lock()
        .await
        .surface_backing_tracker
        .clone();
    let shared = Arc::new(StdMutex::new(
        PreviewCameraShared::with_surface_backing_tracker(surface_backing_tracker),
    ));
    let (stop_tx, stop_rx) = std_mpsc::channel();
    let (startup_tx, startup_rx) = std_mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    let thread_config = NativeCameraPreviewConfig {
        camera_id: camera_id.clone(),
        unique_id: unique_id.clone(),
        ffmpeg_path: ffmpeg_path.clone(),
        video: params.video.clone(),
        layout: params.layout.clone(),
    };

    // Acquire the runtime before spawning so there is no suspension point
    // between a successful native spawn and registration of its stop/join
    // ownership. Cancellation before this guard arrives creates no thread.
    let (mut ownership_slot, join_handle) = loop {
        let ownership_slot = state.preview_camera.lock().await;
        let layout_admission = state.lock_layout_source_admission();
        let recovery_is_stale =
            recovery_epoch.is_some_and(|epoch| !state.capture_recovery_admission_is_current(epoch));
        let physical_admission_is_current = camera_start_admission_is_current_locked(
            &state,
            &ownership_slot,
            Some(&start_lease),
            recovery_epoch,
        );
        if !prepared_camera_admission_is_current(&state, &retirement_prepared)
            || !physical_admission_is_current
        {
            let status = ownership_slot.status.clone();
            drop(ownership_slot);
            drop(layout_admission);
            if recovery_is_stale {
                return retire_superseded_camera_start(&state, &retirement_prepared).await;
            }
            return status;
        }
        if !prepared_camera_layout_is_current_locked(&state, &ownership_slot, &retirement_prepared)
        {
            drop(ownership_slot);
            drop(layout_admission);
            match ensure_prepared_camera_layout_is_current(&state, &retirement_prepared).await {
                Ok(()) => continue,
                Err(status) => return *status,
            }
        }
        let join_handle = thread::Builder::new()
            .name("videorc-preview-camera".to_string())
            .spawn(move || {
                run_native_camera_preview(thread_config, thread_shared, stop_rx, startup_tx)
            });
        drop(layout_admission);
        break (ownership_slot, join_handle);
    };

    match join_handle {
        Ok(join_handle) => {
            ownership_slot.pending_native = Some(PendingNativeCameraThread {
                generation: start_lease.generation,
                stop_tx,
                join_handle: Some(join_handle),
            });
            drop(ownership_slot);
        }
        Err(error) => {
            drop(ownership_slot);
            let status = failed_status(
                Some(camera_id),
                Some(unique_id),
                target_fps,
                format!("Could not start camera thread: {error}"),
            );
            if set_camera_status_for_start(&state, &start_lease, recovery_epoch, status.clone())
                .await
            {
                acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Failed)
                    .await;
                return status;
            }
            return current_or_retire_superseded_camera_start(&state, &retirement_prepared).await;
        }
    }

    let startup = tokio::task::spawn_blocking(move || {
        startup_rx
            .recv_timeout(native_camera_preview_thread_startup_timeout())
            .unwrap_or_else(|_| {
                NativeCameraStartup::Failed(
                    "Timed out while starting native camera preview.".to_string(),
                )
            })
    })
    .await
    .unwrap_or_else(|error| {
        NativeCameraStartup::Failed(format!("Camera startup task failed: {error}"))
    });

    match startup {
        NativeCameraStartup::Live {
            requested_width,
            requested_height,
            selected_format_width,
            selected_format_height,
            selected_format_min_fps,
            selected_format_max_fps,
            width,
            height,
            selected_fps,
            message,
        } => {
            let effective_fps = stable_effective_camera_fps(selected_fps, target_fps);
            let status = PreviewCameraStatus {
                state: PreviewCameraState::Live,
                camera_id: Some(camera_id.clone()),
                device_unique_id: Some(unique_id.clone()),
                target_fps,
                width: Some(width),
                height: Some(height),
                requested_width: Some(requested_width),
                requested_height: Some(requested_height),
                actual_width: None,
                actual_height: None,
                selected_format_width: Some(selected_format_width),
                selected_format_height: Some(selected_format_height),
                selected_format_min_fps: Some(selected_format_min_fps),
                selected_format_max_fps: Some(selected_format_max_fps),
                source_fps: Some(selected_fps),
                frame_age_ms: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                updated_at: Utc::now().to_rfc3339(),
                message,
            };
            let capture_target = camera_capture_target_dimensions(&params.layout, &params.video);
            let installed = {
                let mut slot = state.preview_camera.lock().await;
                let pending_matches = slot
                    .pending_native
                    .as_ref()
                    .is_some_and(|pending| pending.generation == start_lease.generation);
                if !pending_matches
                    || !claim_camera_start_if_admitted(
                        &state,
                        &mut slot,
                        &start_lease,
                        recovery_epoch,
                    )
                {
                    false
                } else {
                    let mut owned = slot
                        .pending_native
                        .take()
                        .expect("matching pending camera owner");
                    slot.status = status.clone();
                    slot.run_id = Some(run_id.clone());
                    slot.source_key = Some(source_key.clone());
                    slot.active = Some(NativeCameraPreviewThread {
                        stop_tx: owned.stop_tx,
                        join_handle: owned.join_handle.take(),
                        shared: Arc::clone(&shared),
                        camera_id,
                        device_unique_id: unique_id,
                        ffmpeg_path,
                        layout: params.layout,
                        video: params.video,
                        effective_fps,
                        configured_output: (width, height),
                        capture_target,
                    });
                    slot.active_generation = Some(start_lease.generation);
                    slot.failed_recovery_retry = None;
                    slot.live_acked_at = Some(Instant::now());
                    true
                }
            };
            if !installed {
                stop_pending_camera_generation(&state, start_lease.generation, "stale-start").await;
                return current_or_retire_superseded_camera_start(&state, &retirement_prepared)
                    .await;
            }
            let poll_task = state.spawn_process_task(poll_camera_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                effective_fps,
            ));
            {
                let mut slot = state.preview_camera.lock().await;
                if slot.run_id.as_deref() == Some(run_id.as_str()) {
                    slot.poll_task = Some(poll_task);
                } else {
                    poll_task.abort();
                }
            }
            acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Live).await;
            state.emit_event("preview.camera.status", status.clone());
            status
        }
        NativeCameraStartup::PermissionNeeded(message) => {
            stop_pending_camera_generation(&state, start_lease.generation, "permission-needed")
                .await;
            let status = PreviewCameraStatus {
                state: PreviewCameraState::PermissionNeeded,
                camera_id: Some(camera_id),
                device_unique_id: Some(unique_id),
                target_fps,
                width: None,
                height: None,
                requested_width: None,
                requested_height: None,
                actual_width: None,
                actual_height: None,
                selected_format_width: None,
                selected_format_height: None,
                selected_format_min_fps: None,
                selected_format_max_fps: None,
                source_fps: None,
                frame_age_ms: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                updated_at: Utc::now().to_rfc3339(),
                message: Some(message),
            };
            if set_camera_status_for_start(&state, &start_lease, recovery_epoch, status.clone())
                .await
            {
                acquire_preview_camera_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::PermissionNeeded,
                )
                .await;
                status
            } else {
                current_or_retire_superseded_camera_start(&state, &retirement_prepared).await
            }
        }
        NativeCameraStartup::DeviceMissing(message) => {
            stop_pending_camera_generation(&state, start_lease.generation, "device-missing").await;
            let status = PreviewCameraStatus {
                state: PreviewCameraState::DeviceMissing,
                camera_id: Some(camera_id),
                device_unique_id: Some(unique_id),
                target_fps,
                width: None,
                height: None,
                requested_width: None,
                requested_height: None,
                actual_width: None,
                actual_height: None,
                selected_format_width: None,
                selected_format_height: None,
                selected_format_min_fps: None,
                selected_format_max_fps: None,
                source_fps: None,
                frame_age_ms: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                updated_at: Utc::now().to_rfc3339(),
                message: Some(message),
            };
            if set_camera_status_for_start(&state, &start_lease, recovery_epoch, status.clone())
                .await
            {
                acquire_preview_camera_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::SourceMissing,
                )
                .await;
                status
            } else {
                current_or_retire_superseded_camera_start(&state, &retirement_prepared).await
            }
        }
        NativeCameraStartup::Failed(message) => {
            stop_pending_camera_generation(&state, start_lease.generation, "failed-start").await;
            let status = failed_status(Some(camera_id), Some(unique_id), target_fps, message);
            if set_camera_status_for_start(&state, &start_lease, recovery_epoch, status.clone())
                .await
            {
                acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Failed)
                    .await;
                status
            } else {
                current_or_retire_superseded_camera_start(&state, &retirement_prepared).await
            }
        }
    }
}

async fn stop_pending_camera_generation(state: &AppState, generation: u64, reason: &'static str) {
    let pending = {
        let mut slot = state.preview_camera.lock().await;
        if slot
            .pending_native
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            slot.pending_native.take()
        } else {
            None
        }
    };
    if let Some(mut pending) = pending {
        let _ = pending.stop_tx.send(());
        if let Some(join_handle) = pending.join_handle.take() {
            join_camera_capture_thread(join_handle, Some(generation), reason).await;
        }
    }
}

async fn retire_panicked_camera_generation(
    state: &AppState,
    lease: &PreviewCameraStartLease,
    failed: PreviewCameraStatus,
    prepared: Option<&PreparedCameraStart>,
) -> PreviewCameraStatus {
    let (pending, active, poll_task, terminal_candidate, owns_active, recovery_was_superseded) = {
        let mut slot = state.preview_camera.lock().await;
        // Explicit configuration invalidation shares this runtime lock. Check
        // the recovery epoch while holding it so the panic terminal cannot win
        // a TOCTOU race after an operator mutation has already been admitted.
        let recovery_was_superseded = prepared
            .and_then(|prepared| prepared.recovery.as_ref())
            .is_some_and(|recovery| !state.capture_recovery_admission_is_current(recovery.epoch));
        if recovery_was_superseded {
            (None, None, None, false, false, true)
        } else {
            // While this function runs the physical transition gate is still held.
            // Any registered pending owner, or any active owner, is therefore the
            // predecessor/current native session this panicked transition must
            // reconcile before a replacement is admitted physically.
            let pending = slot.pending_native.take();
            let owns_active = slot.active_generation == Some(lease.generation);
            let active = slot.active.take();
            let had_active = active.is_some();
            if had_active {
                slot.active_generation = None;
                slot.run_id = None;
                slot.live_acked_at = None;
            }
            let terminal_candidate = slot.start_generation == lease.generation
                && slot.pending_stop_generation.is_none()
                && (slot.starting.as_ref() == Some(&lease.key) || owns_active);
            (
                pending,
                active,
                if had_active {
                    slot.poll_task.take()
                } else {
                    None
                },
                terminal_candidate,
                owns_active,
                false,
            )
        }
    };
    if recovery_was_superseded {
        stop_pending_camera_generation(state, lease.generation, "stale-recovery-panic").await;
        return retire_superseded_camera_recovery_after_panic(
            state,
            prepared.expect("superseded recovery panic retains its prepared admission"),
            lease,
        )
        .await;
    }
    if let Some(poll_task) = poll_task {
        poll_task.abort();
    }
    if let Some(mut pending) = pending {
        let pending_generation = pending.generation;
        let _ = pending.stop_tx.send(());
        if let Some(join_handle) = pending.join_handle.take() {
            join_camera_capture_thread(join_handle, Some(pending_generation), "panic").await;
        }
    }
    if let Some(mut active) = active {
        let _ = active.stop_tx.send(());
        if let Some(join_handle) = active.join_handle.take() {
            join_camera_capture_thread(join_handle, Some(lease.generation), "panic").await;
        }
    }

    // Native joins are intentionally unbounded. A newer operator start can be
    // admitted while this supervisor waits, so Failed is committed only after
    // teardown and only while the exact lease/admission still owns public truth.
    let mut slot = state.preview_camera.lock().await;
    if prepared
        .and_then(|prepared| prepared.recovery.as_ref())
        .is_some_and(|recovery| !state.capture_recovery_admission_is_current(recovery.epoch))
    {
        drop(slot);
        return retire_superseded_camera_recovery_after_panic(
            state,
            prepared.expect("superseded recovery panic retains its prepared admission"),
            lease,
        )
        .await;
    }
    if !terminal_candidate
        || !panicked_camera_terminal_is_current_locked(state, &slot, lease, prepared, owns_active)
    {
        return slot.status.clone();
    }

    // Start admission already establishes preview-camera -> registry order.
    // Hold the same authority through diagnostics/event publication so no
    // newer Starting state can be followed by this older Failed terminal.
    let mut registry = state.source_registry.lock().await;
    let mut diagnostics = state.diagnostics.lock().await;
    if !panicked_camera_terminal_is_current_locked(state, &slot, lease, prepared, owns_active) {
        return slot.status.clone();
    }
    slot.starting = None;
    slot.starting_transition_completion = None;
    slot.starting_recovery_epoch = None;
    slot.starting_layout_intent_id = None;
    slot.source_key = Some(lease.key.source_key.clone());
    slot.status = failed.clone();
    registry.acquire(lease.key.source_key.clone(), SourceConsumerReason::Preview);
    registry.set_status(lease.key.source_key.clone(), SourceLifecycleStatus::Failed);
    *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &failed);
    state.emit_event("preview.camera.status", failed.clone());
    failed
}

fn panicked_camera_terminal_is_current_locked(
    state: &AppState,
    slot: &PreviewCameraRuntime,
    lease: &PreviewCameraStartLease,
    prepared: Option<&PreparedCameraStart>,
    owns_active: bool,
) -> bool {
    if state.process_shutdown_requested()
        || slot.start_generation != lease.generation
        || slot.pending_stop_generation.is_some()
        || slot.pending_native.is_some()
        || prepared
            .and_then(|prepared| prepared.recovery.as_ref())
            .is_some_and(|recovery| !state.capture_recovery_admission_is_current(recovery.epoch))
    {
        return false;
    }
    if slot.starting.as_ref() == Some(&lease.key) {
        return match prepared.and_then(|prepared| prepared.recovery.as_ref()) {
            Some(recovery) => slot.starting_recovery_epoch == Some(recovery.epoch),
            None => slot.starting_recovery_epoch.is_none(),
        };
    }
    owns_active
        && slot.starting.is_none()
        && slot.source_key.as_ref() == Some(&lease.key.source_key)
        && slot.active.is_none()
        && slot.active_generation.is_none()
}

async fn retire_superseded_camera_recovery_after_panic(
    state: &AppState,
    prepared: &PreparedCameraStart,
    lease: &PreviewCameraStartLease,
) -> PreviewCameraStatus {
    let status = retire_superseded_camera_recovery(state, prepared).await;
    let mut slot = state.preview_camera.lock().await;
    let orphaned_installed_generation = slot.start_generation == lease.generation
        && slot.pending_stop_generation.is_none()
        && slot.starting.is_none()
        && slot.active.is_none()
        && slot.active_generation.is_none()
        && slot.source_key.as_ref() == Some(&lease.key.source_key);
    if !orphaned_installed_generation {
        return status;
    }
    let mut registry = state.source_registry.lock().await;
    let mut diagnostics = state.diagnostics.lock().await;
    if slot.start_generation != lease.generation
        || slot.pending_stop_generation.is_some()
        || slot.starting.is_some()
        || slot.active.is_some()
        || slot.active_generation.is_some()
        || slot.source_key.as_ref() != Some(&lease.key.source_key)
    {
        return slot.status.clone();
    }
    let status = idle_status(Some(
        "Camera recovery was superseded after its panicked native generation retired.".to_string(),
    ));
    slot.status = status.clone();
    slot.run_id = None;
    slot.source_key = None;
    slot.starting_recovery_epoch = None;
    slot.starting_layout_intent_id = None;
    slot.failed_recovery_retry = None;
    slot.live_acked_at = None;
    registry.release(&lease.key.source_key, &SourceConsumerReason::Preview);
    registry.set_status(lease.key.source_key.clone(), SourceLifecycleStatus::Stopped);
    *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    state.emit_event("preview.camera.status", status.clone());
    status
}

#[cfg(test)]
async fn retire_uninstalled_camera_thread(
    mut stale_thread: NativeCameraPreviewThread,
    generation: u64,
) {
    let _ = stale_thread.stop_tx.send(());
    if let Some(join_handle) = stale_thread.join_handle.take() {
        join_camera_capture_thread(join_handle, Some(generation), "stale-start").await;
    }
}

pub(crate) async fn preview_camera_restart_snapshot(
    state: &AppState,
) -> Option<PreviewCameraRestartSnapshot> {
    let slot = state.preview_camera.lock().await;
    camera_restart_snapshot_from_slot(&slot)
}

/// True only when `expected` still names the exact stable Live generation and
/// that generation has remained frameless past the existing startup grace.
/// Health recovery uses this identity-bound query so a delayed sample from a
/// retired source cannot make its replacement immediately restartable.
pub(crate) async fn preview_camera_restart_snapshot_is_frameless_zombie(
    state: &AppState,
    expected: &PreviewCameraRestartSnapshot,
) -> bool {
    let slot = state.preview_camera.lock().await;
    camera_restart_snapshot_from_slot(&slot).as_ref() == Some(expected)
        && camera_slot_is_frameless_zombie(&slot)
}

/// Read recovery proof directly from the exact active capture generation.
/// Diagnostics are intentionally bypassed because their asynchronously-updated
/// counters may still describe the session that recovery just retired.
pub(crate) async fn preview_camera_recovery_evidence(
    state: &AppState,
    expected: &PreviewCameraRestartSnapshot,
) -> Option<PreviewCameraRecoveryEvidence> {
    let (
        shared,
        target_fps,
        requested_width,
        requested_height,
        configured_width,
        configured_height,
    ) = {
        let slot = state.preview_camera.lock().await;
        if camera_restart_snapshot_from_slot(&slot).as_ref() != Some(expected) {
            return None;
        }
        let active = slot.active.as_ref()?;
        (
            Arc::clone(&active.shared),
            active.effective_fps,
            slot.status.requested_width,
            slot.status.requested_height,
            Some(active.configured_output.0),
            Some(active.configured_output.1),
        )
    };
    let (
        source_fps,
        capture_callback_count,
        frame_store_publications,
        did_drop_callback_count,
        out_of_buffers,
        surface_backing_live_count,
        surface_backing_peak_count,
        latest_sequence,
        frame_age_ms,
        actual_width,
        actual_height,
    ) = {
        let shared = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let latest = shared.frame_store.latest();
        let frame_store_stats = shared.frame_store.stats();
        (
            shared.source_fps,
            shared.capture_callback_count,
            shared.frames_captured,
            shared.capture_drop_reasons.total(),
            shared.capture_drop_reasons.out_of_buffers,
            frame_store_stats.surface_backing_live_count,
            frame_store_stats.surface_backing_peak_count,
            latest.as_ref().map(|frame| frame.sequence),
            latest
                .as_ref()
                .map(|frame| frame.captured_at.elapsed().as_millis() as u64),
            latest.as_ref().map(|frame| frame.width),
            latest.as_ref().map(|frame| frame.height),
        )
    };
    {
        let slot = state.preview_camera.lock().await;
        if camera_restart_snapshot_from_slot(&slot).as_ref() != Some(expected)
            || !slot
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(&active.shared, &shared))
        {
            return None;
        }
    }
    Some(PreviewCameraRecoveryEvidence {
        source_key: expected.source_key.clone(),
        generation: expected.generation,
        target_fps,
        source_fps,
        capture_callback_count,
        frame_store_publications,
        did_drop_callback_count,
        out_of_buffers,
        surface_backing_live_count,
        surface_backing_peak_count,
        latest_sequence,
        frame_age_ms,
        requested_width,
        requested_height,
        configured_width,
        configured_height,
        actual_width,
        actual_height,
    })
}

/// Force-restart the exact camera session named by `expected`.
///
/// The compare-and-swap happens before the old session is touched. A user
/// source/config change or another restart therefore wins cleanly and makes
/// this request a no-op instead of restarting the wrong device.
#[cfg(test)]
pub(crate) async fn force_restart_preview_camera(
    state: AppState,
    expected: &PreviewCameraRestartSnapshot,
    recovery_epoch: u64,
) -> PreviewCameraForceRestartResult {
    let Some(attempt) = admit_force_restart_preview_camera(&state, expected, recovery_epoch).await
    else {
        return PreviewCameraForceRestartResult::RejectedStale;
    };
    complete_force_restart_preview_camera(&state, attempt).await
}

/// Compare-and-swap the exact Live camera generation and synchronously queue
/// its process-lifetime transition supervisor. No native stop/start work is
/// awaited here; callers that serialize admission with session startup must
/// release that short-lived mutex before awaiting completion.
pub(crate) async fn admit_force_restart_preview_camera(
    state: &AppState,
    expected: &PreviewCameraRestartSnapshot,
    recovery_epoch: u64,
) -> Option<PreviewCameraForceRestartAttempt> {
    if state.process_shutdown_requested()
        || !state.capture_recovery_admission_is_current(recovery_epoch)
    {
        return None;
    }
    let prepared = begin_forced_camera_restart(state, expected, recovery_epoch).await?;
    let generation = prepared.lease.generation;
    let source_key = prepared.lease.key.source_key.clone();
    log_camera_generation(
        generation,
        "force-recovery",
        &prepared.lease.key,
        &prepared.params.layout,
    );
    let completion = queue_registered_preview_camera(state.clone(), prepared, None);
    Some(PreviewCameraForceRestartAttempt {
        generation,
        source_key,
        completion,
    })
}

/// Await the native transition of an already-admitted recovery generation.
/// Dropping this future detaches only the waiter; the process-lifetime
/// supervisor and its source-transition guard remain authoritative.
pub(crate) async fn complete_force_restart_preview_camera(
    state: &AppState,
    attempt: PreviewCameraForceRestartAttempt,
) -> PreviewCameraForceRestartResult {
    let PreviewCameraForceRestartAttempt {
        generation,
        source_key,
        completion,
    } = attempt;
    // Awaiting the handle preserves the recovery API's exact result contract.
    // If its watchdog cancels this future, dropping the handle detaches only
    // the waiter; the transition supervisor and native ownership continue.
    let Ok(status) = completion.await else {
        return PreviewCameraForceRestartResult::RejectedStale;
    };
    let restart_still_current = {
        let slot = state.preview_camera.lock().await;
        slot.start_generation == generation
            && slot.source_key.as_ref() == Some(&source_key)
            && slot.starting.is_none()
    };
    if !restart_still_current {
        return PreviewCameraForceRestartResult::RejectedStale;
    }
    PreviewCameraForceRestartResult::Restarted { status, generation }
}

/// True only while `expected_generation` still names the untouched terminal
/// failure produced by a recovery restart. This is the read-only half used to
/// keep the externally reported `retryable` bit truthful; the retry operation
/// repeats the same checks while holding the transition gate.
pub(crate) async fn failed_preview_camera_retry_is_current(
    state: &AppState,
    expected_source_key: &SourceKey,
    expected_generation: u64,
) -> bool {
    let slot = state.preview_camera.lock().await;
    failed_camera_recovery_retry_from_slot(&slot, expected_source_key, expected_generation)
        .is_some()
}

/// Reserve and queue the exact retained failed-recovery configuration without
/// awaiting native completion. This mirrors `admit_force_restart_preview_camera`
/// for the one-click retry path.
pub(crate) async fn admit_failed_preview_camera_recovery_retry(
    state: &AppState,
    expected_source_key: &SourceKey,
    expected_generation: u64,
    recovery_epoch: u64,
) -> Option<PreviewCameraForceRestartAttempt> {
    if state.process_shutdown_requested()
        || !state.capture_recovery_admission_is_current(recovery_epoch)
    {
        return None;
    }
    let prepared = begin_failed_camera_recovery_retry(
        state,
        expected_source_key,
        expected_generation,
        recovery_epoch,
    )
    .await?;
    let generation = prepared.lease.generation;
    let source_key = prepared.lease.key.source_key.clone();
    log_camera_generation(
        generation,
        "force-recovery-retry",
        &prepared.lease.key,
        &prepared.params.layout,
    );
    let completion = queue_registered_preview_camera(state.clone(), prepared, None);
    Some(PreviewCameraForceRestartAttempt {
        generation,
        source_key,
        completion,
    })
}

fn camera_restart_snapshot_from_slot(
    slot: &PreviewCameraRuntime,
) -> Option<PreviewCameraRestartSnapshot> {
    if slot.status.state != PreviewCameraState::Live
        || slot.starting.is_some()
        || slot.pending_stop_generation.is_some()
    {
        return None;
    }
    let active = slot.active.as_ref()?;
    let generation = slot.active_generation?;
    let source_key = slot.source_key.clone()?;
    let camera_id = active.camera_id.clone();
    if source_key != SourceKey::camera(camera_id.clone()) {
        return None;
    }
    let device_unique_id = active.device_unique_id.clone();
    if slot.status.camera_id.as_ref() != Some(&camera_id)
        || slot.status.device_unique_id.as_ref() != Some(&device_unique_id)
    {
        return None;
    }
    let config = PreviewCameraRestartConfig {
        camera_id,
        device_unique_id,
        ffmpeg_path: active.ffmpeg_path.clone(),
        layout: active.layout.clone(),
        video: active.video.clone(),
        target_fps: slot.status.target_fps,
    };
    let mut start_key = camera_restart_start_key(&source_key, &config);
    // Preserve the session's immutable start geometry even if later layout
    // bookkeeping changed presentation-only fields.
    start_key.capture_target = active.capture_target;
    Some(PreviewCameraRestartSnapshot {
        source_key,
        generation,
        config_fingerprint: camera_config_fingerprint(&start_key, &config.layout),
        config,
    })
}

fn failed_camera_recovery_retry_from_slot<'a>(
    slot: &'a PreviewCameraRuntime,
    expected_source_key: &SourceKey,
    expected_generation: u64,
) -> Option<&'a PreviewCameraFailedRecoveryRetry> {
    let retry = slot.failed_recovery_retry.as_ref()?;
    if slot.status.state != PreviewCameraState::Failed
        || slot.active.is_some()
        || slot.active_generation.is_some()
        || slot.starting.is_some()
        || slot.pending_stop_generation.is_some()
        || slot.run_id.is_some()
        || slot.start_generation != expected_generation
        || retry.generation != expected_generation
        || &retry.source_key != expected_source_key
        || slot.source_key.as_ref() != Some(expected_source_key)
        || expected_source_key != &SourceKey::camera(retry.config.camera_id.clone())
        || slot.status.camera_id.as_ref() != Some(&retry.config.camera_id)
        || slot.status.device_unique_id.as_ref() != Some(&retry.config.device_unique_id)
        || slot.status.target_fps != retry.config.target_fps
        || retry.config_fingerprint
            != camera_restart_config_fingerprint(&retry.source_key, &retry.config)
    {
        return None;
    }
    Some(retry)
}

async fn begin_forced_camera_restart(
    state: &AppState,
    expected: &PreviewCameraRestartSnapshot,
    recovery_epoch: u64,
) -> Option<PreparedCameraStart> {
    let (prepared, starting) = {
        let mut slot = state.preview_camera.lock().await;
        if state.process_shutdown_requested()
            || !state.capture_recovery_admission_is_current(recovery_epoch)
        {
            return None;
        }
        if camera_restart_snapshot_from_slot(&slot).as_ref() != Some(expected) {
            return None;
        }

        let recovery = PreparedCameraRecoveryAdmission {
            epoch: recovery_epoch,
            previous_status: slot.status.clone(),
            previous_run_id: slot.run_id.clone(),
            previous_live_acked_at: slot.live_acked_at,
        };

        let config = expected.config.clone();
        let start_key = camera_restart_start_key(&expected.source_key, &config);
        {
            let mut registry = state.source_registry.lock().await;
            registry.acquire(expected.source_key.clone(), SourceConsumerReason::Preview);
            registry.set_status(expected.source_key.clone(), SourceLifecycleStatus::Starting);
        }
        slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
        let lease = PreviewCameraStartLease::new(start_key.clone(), slot.start_generation);
        slot.starting_transition_completion = Some(Arc::clone(&lease.transition_completion));
        slot.pending_stop_generation = None;
        slot.failed_recovery_retry = Some(PreviewCameraFailedRecoveryRetry {
            source_key: expected.source_key.clone(),
            generation: lease.generation,
            config_fingerprint: camera_config_fingerprint(&start_key, &config.layout),
            config: config.clone(),
        });
        let starting = PreviewCameraStatus {
            state: PreviewCameraState::Starting,
            camera_id: Some(config.camera_id.clone()),
            device_unique_id: Some(config.device_unique_id.clone()),
            target_fps: config.target_fps,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            updated_at: Utc::now().to_rfc3339(),
            message: Some(
                "Restarting native camera capture after verified degradation.".to_string(),
            ),
        };
        slot.status = starting.clone();
        slot.run_id = None;
        slot.source_key = Some(expected.source_key.clone());
        slot.starting = Some(start_key);
        slot.starting_recovery_epoch = Some(recovery_epoch);
        slot.starting_layout_intent_id = None;

        let params = PreviewCameraStartParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: Some(config.camera_id.clone()),
                microphone_id: None,
                test_pattern: false,
            },
            layout: config.layout,
            video: config.video,
            ffmpeg_path: Some(config.ffmpeg_path.clone()),
        };
        (
            PreparedCameraStart {
                camera_id: config.camera_id,
                device_unique_id: config.device_unique_id,
                ffmpeg_path: config.ffmpeg_path,
                target_fps: config.target_fps,
                source_key: expected.source_key.clone(),
                params,
                lease,
                layout_intent_id: None,
                recovery: Some(recovery),
            },
            starting,
        )
    };

    // No await is allowed after the lease becomes visible: the caller queues
    // its persistent supervisor immediately after this function returns.
    state.emit_event("preview.camera.status", starting);
    Some(prepared)
}

async fn begin_failed_camera_recovery_retry(
    state: &AppState,
    expected_source_key: &SourceKey,
    expected_generation: u64,
    recovery_epoch: u64,
) -> Option<PreparedCameraStart> {
    let (prepared, starting) = {
        let mut slot = state.preview_camera.lock().await;
        if state.process_shutdown_requested()
            || !state.capture_recovery_admission_is_current(recovery_epoch)
        {
            return None;
        }
        let config = failed_camera_recovery_retry_from_slot(
            &slot,
            expected_source_key,
            expected_generation,
        )?
        .config
        .clone();
        let recovery = PreparedCameraRecoveryAdmission {
            epoch: recovery_epoch,
            previous_status: slot.status.clone(),
            previous_run_id: slot.run_id.clone(),
            previous_live_acked_at: slot.live_acked_at,
        };
        let start_key = camera_restart_start_key(expected_source_key, &config);
        {
            let mut registry = state.source_registry.lock().await;
            registry.acquire(expected_source_key.clone(), SourceConsumerReason::Preview);
            registry.set_status(expected_source_key.clone(), SourceLifecycleStatus::Starting);
        }
        slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
        let lease = PreviewCameraStartLease::new(start_key.clone(), slot.start_generation);
        slot.starting_transition_completion = Some(Arc::clone(&lease.transition_completion));
        slot.pending_stop_generation = None;
        slot.failed_recovery_retry = Some(PreviewCameraFailedRecoveryRetry {
            source_key: expected_source_key.clone(),
            generation: lease.generation,
            config_fingerprint: camera_config_fingerprint(&start_key, &config.layout),
            config: config.clone(),
        });
        let starting = PreviewCameraStatus {
            state: PreviewCameraState::Starting,
            camera_id: Some(config.camera_id.clone()),
            device_unique_id: Some(config.device_unique_id.clone()),
            target_fps: config.target_fps,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Retrying the failed native camera recovery generation.".to_string()),
        };
        slot.status = starting.clone();
        slot.run_id = None;
        slot.source_key = Some(expected_source_key.clone());
        slot.starting = Some(start_key);
        slot.starting_recovery_epoch = Some(recovery_epoch);
        slot.starting_layout_intent_id = None;

        let params = PreviewCameraStartParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: Some(config.camera_id.clone()),
                microphone_id: None,
                test_pattern: false,
            },
            layout: config.layout,
            video: config.video,
            ffmpeg_path: Some(config.ffmpeg_path.clone()),
        };
        (
            PreparedCameraStart {
                camera_id: config.camera_id,
                device_unique_id: config.device_unique_id,
                ffmpeg_path: config.ffmpeg_path,
                target_fps: config.target_fps,
                source_key: expected_source_key.clone(),
                params,
                lease,
                layout_intent_id: None,
                recovery: Some(recovery),
            },
            starting,
        )
    };

    state.emit_event("preview.camera.status", starting);
    Some(prepared)
}

pub async fn stop_preview_camera(state: &AppState) -> PreviewCameraStatus {
    let stop = begin_preview_camera_stop(state).await;
    finish_preview_camera_stop(stop).await
}

pub(crate) async fn begin_preview_camera_stop(state: &AppState) -> PreviewCameraStop {
    try_begin_preview_camera_stop_supervised(state, false, None)
        .await
        .expect("unconditional camera stop admission")
}

/// Cancel only the exact generation sampled while it was pending startup. The
/// identity CAS, Starting check, and desired-generation invalidation share the
/// preview-runtime lock, so neither a native Live callback nor a newer camera
/// start can be torn down by a stale layout-readiness sample.
pub(crate) async fn begin_preview_camera_stop_if_starting(
    state: &AppState,
    expected: &PreviewCameraStartingIdentity,
) -> Option<PreviewCameraStop> {
    try_begin_preview_camera_stop_supervised(state, false, Some(expected)).await
}

fn camera_starting_identity_from_slot(
    slot: &PreviewCameraRuntime,
) -> Option<PreviewCameraStartingIdentity> {
    let starting = slot.starting.as_ref()?;
    (slot.status.state == PreviewCameraState::Starting && slot.pending_stop_generation.is_none())
        .then(|| PreviewCameraStartingIdentity {
            source_key: starting.source_key.clone(),
            generation: slot.start_generation,
            layout_intent_id: slot.starting_layout_intent_id,
        })
}

/// Return status and its pending-start identity from one runtime-lock sample.
/// Keeping these together prevents timeout code from pairing an old status
/// with a newer generation.
#[cfg(test)]
pub(crate) async fn preview_camera_status_and_starting_identity(
    state: &AppState,
) -> (PreviewCameraStatus, Option<PreviewCameraStartingIdentity>) {
    let slot = state.preview_camera.lock().await;
    (
        slot.status.clone(),
        camera_starting_identity_from_slot(&slot),
    )
}

/// Legacy test seam for proving physical exclusivity. Production callers must
/// not wait for this gate before registering intent: stop/start supersession is
/// admitted under the runtime lock and the persistent supervisor waits here.
#[cfg(test)]
pub(crate) async fn acquire_preview_camera_transition(
    state: &AppState,
) -> PreviewCameraTransitionGuard {
    let transition_gate = {
        let slot = state.preview_camera.lock().await;
        Arc::clone(&slot.transition_gate)
    };
    transition_gate.lock_owned().await
}

async fn try_begin_preview_camera_stop_supervised(
    state: &AppState,
    force_shutdown: bool,
    expected_starting: Option<&PreviewCameraStartingIdentity>,
) -> Option<PreviewCameraStop> {
    let (status, generation, poll_task, explicit_mutation) = {
        // Same preview-runtime -> source-registry order as start admission.
        // No mutation precedes the registry await, and there is no suspension
        // between consumer release and desired-generation invalidation.
        let mut slot = state.preview_camera.lock().await;
        if let Some(expected) = expected_starting
            && camera_starting_identity_from_slot(&slot).as_ref() != Some(expected)
        {
            return None;
        }
        let explicit_mutation =
            (!force_shutdown).then(|| state.begin_capture_recovery_explicit_camera_mutation());
        let keep_alive = if let Some(source_key) = slot.source_key.as_ref() {
            let snapshot = state
                .source_registry
                .lock()
                .await
                .release(source_key, &SourceConsumerReason::Preview);
            !force_shutdown
                && snapshot
                    .entries
                    .iter()
                    .find(|entry| &entry.key == source_key)
                    .is_some_and(|entry| !entry.consumers.is_empty())
        } else {
            false
        };
        slot.failed_recovery_retry = None;
        if keep_alive {
            let mut status = slot.status.clone();
            status.updated_at = Utc::now().to_rfc3339();
            status.message =
                Some("Preview consumer released; camera source is still in use.".to_string());
            slot.status = status.clone();
            slot.starting = None;
            slot.starting_transition_completion = None;
            slot.starting_recovery_epoch = None;
            slot.starting_layout_intent_id = None;
            (status, None, None, explicit_mutation)
        } else {
            slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
            let generation = slot.start_generation;
            slot.pending_stop_generation = Some(generation);
            let status = idle_status(Some(
                "Stopping native camera preview; teardown remains exclusively owned.".to_string(),
            ));
            slot.status = status.clone();
            slot.run_id = None;
            slot.source_key = None;
            slot.starting = None;
            slot.starting_transition_completion = None;
            slot.starting_recovery_epoch = None;
            slot.starting_layout_intent_id = None;
            let poll_task = slot.poll_task.take();
            (status, Some(generation), poll_task, explicit_mutation)
        }
    };

    if let Some(task) = poll_task {
        task.abort();
    }
    state.emit_event("preview.camera.status", status.clone());

    let completion = if let Some(generation) = generation {
        let source_transition_guard = state.source_transition_fence.begin();
        let supervisor_state = state.clone();
        let admitted_status = status.clone();
        // Spawn is synchronous and immediately follows admission. Dropping the
        // returned wait handle never cancels this process-lifetime physical
        // owner, even when admission originated on a disposable compositor
        // runtime.
        Some(state.spawn_process_task(async move {
            let _source_transition_guard = source_transition_guard;
            let status =
                run_camera_stop_supervisor(supervisor_state.clone(), generation, admitted_status)
                    .await;
            if let Some(explicit_mutation) = explicit_mutation {
                finish_capture_recovery_explicit_camera_configuration_mutation(
                    &supervisor_state,
                    explicit_mutation,
                )
                .await;
            }
            status
        }))
    } else {
        if let Some(explicit_mutation) = explicit_mutation {
            finish_capture_recovery_explicit_camera_configuration_mutation(
                state,
                explicit_mutation,
            )
            .await;
        }
        None
    };
    Some(PreviewCameraStop { status, completion })
}

async fn run_camera_stop_supervisor(
    state: AppState,
    generation: u64,
    admitted_status: PreviewCameraStatus,
) -> PreviewCameraStatus {
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &admitted_status);
    }

    let transition_gate = {
        let slot = state.preview_camera.lock().await;
        Arc::clone(&slot.transition_gate)
    };
    let _transition = transition_gate.lock().await;
    let (previous, active_generation) = {
        let mut slot = state.preview_camera.lock().await;
        if slot.start_generation != generation || slot.pending_stop_generation != Some(generation) {
            return slot.status.clone();
        }
        let active_generation = slot.active_generation.take();
        slot.live_acked_at = None;
        (slot.active.take(), active_generation)
    };

    if let Some(mut previous) = previous {
        let _ = previous.stop_tx.send(());
        if let Some(join_handle) = previous.join_handle.take() {
            join_camera_capture_thread(join_handle, active_generation, "stop").await;
        }
    }

    let status = {
        let mut slot = state.preview_camera.lock().await;
        if slot.start_generation != generation || slot.pending_stop_generation != Some(generation) {
            return slot.status.clone();
        }
        slot.pending_stop_generation = None;
        if slot.status == admitted_status {
            let status = idle_status(Some("Native camera preview stopped.".to_string()));
            slot.status = status.clone();
            status
        } else {
            // A later explicit selection error may have replaced the admitted
            // stopping copy while physical teardown was in flight. Preserve
            // that newer public status; only native ownership is finalized.
            slot.status.clone()
        }
    };
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status.clone());
    status
}

pub(crate) async fn finish_preview_camera_stop(stop: PreviewCameraStop) -> PreviewCameraStatus {
    finish_preview_camera_stop_with_timeout(stop, CAMERA_STOP_RESPONSE_TIMEOUT).await
}

/// Graceful application shutdown must request native release and wait for the
/// supervised join, even if another logical consumer was still registered.
/// The wait remains bounded; on an unusually slow driver teardown the detached
/// supervisor retains the physical owner while the process shutdown continues.
pub(crate) async fn shutdown_preview_camera(state: &AppState) -> bool {
    shutdown_preview_camera_with_timeout(state, CAMERA_STOP_RESPONSE_TIMEOUT).await
}

async fn shutdown_preview_camera_with_timeout(state: &AppState, timeout: Duration) -> bool {
    let mut stop = try_begin_preview_camera_stop_supervised(state, true, None)
        .await
        .expect("unconditional camera shutdown admission");
    let Some(mut completion) = stop.completion.take() else {
        return true;
    };
    matches!(
        tokio::time::timeout(timeout, &mut completion).await,
        Ok(Ok(_))
    )
}

async fn finish_preview_camera_stop_with_timeout(
    mut stop: PreviewCameraStop,
    response_timeout: Duration,
) -> PreviewCameraStatus {
    let Some(mut completion) = stop.completion.take() else {
        return stop.status;
    };
    match tokio::time::timeout(response_timeout, &mut completion).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            tracing::error!("Camera stop supervisor failed: {error}");
            stop.status
        }
        Err(_) => stop.status,
    }
}

pub async fn preview_camera_status(state: &AppState) -> PreviewCameraStatus {
    state.preview_camera.lock().await.status.clone()
}

pub async fn preview_camera_frame_store_stats(state: &AppState) -> FrameStoreStats {
    let shared = {
        let slot = state.preview_camera.lock().await;
        let Some(active) = slot.active.as_ref() else {
            return FrameStoreStats::from_surface_backing(slot.surface_backing_tracker.snapshot());
        };
        Arc::clone(&active.shared)
    };

    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .frame_store
        .stats()
}

pub async fn preview_camera_latest_frame_info(state: &AppState) -> Option<PreviewCameraFrameInfo> {
    let shared = {
        let slot = state.preview_camera.lock().await;
        Arc::clone(&slot.active.as_ref()?.shared)
    };
    let frame = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .frame_store
        .latest()?;
    Some(PreviewCameraFrameInfo {
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        frame_age_ms: frame.captured_at.elapsed().as_millis() as u64,
    })
}

pub async fn preview_camera_frame_source(state: &AppState) -> Option<PreviewCameraFrameSource> {
    let slot = state.preview_camera.lock().await;
    let active = slot.active.as_ref()?;
    let generation = slot.active_generation?;
    Some(PreviewCameraFrameSource {
        shared: Arc::clone(&active.shared),
        layout: active.layout.clone(),
        source_key: slot.source_key.clone(),
        target_fps: active.effective_fps,
        generation,
    })
}

pub fn try_preview_camera_frame_source(
    state: &AppState,
) -> Result<Option<PreviewCameraFrameSource>, ()> {
    let slot = state.preview_camera.try_lock().map_err(|_| ())?;
    let Some(active) = slot.active.as_ref() else {
        return Ok(None);
    };
    let Some(generation) = slot.active_generation else {
        return Ok(None);
    };
    Ok(Some(PreviewCameraFrameSource {
        shared: Arc::clone(&active.shared),
        layout: active.layout.clone(),
        source_key: slot.source_key.clone(),
        target_fps: active.effective_fps,
        generation,
    }))
}

pub async fn reset_preview_camera_capture_timings(state: &AppState) {
    let shared = {
        let slot = state.preview_camera.lock().await;
        slot.active
            .as_ref()
            .map(|active| Arc::clone(&active.shared))
    };
    if let Some(shared) = shared {
        let mut guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.capture_timings.reset();
    }
}

pub async fn latest_preview_camera_png(
    state: &AppState,
    requested_max_width: Option<u32>,
) -> Option<Vec<u8>> {
    let (frame, layout) = {
        let slot = state.preview_camera.lock().await;
        let active = slot.active.as_ref()?;
        let shared = Arc::clone(&active.shared);
        let layout = active.layout.clone();
        drop(slot);
        let guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (guard.frame_store.latest()?, layout)
    };

    let max_width = preview_camera_png_max_width(requested_max_width);
    tokio::task::spawn_blocking(move || encode_preview_camera_png(frame, layout, max_width))
        .await
        .ok()
        .flatten()
}

/// Latest-wins BGRA/BMP transport used by the production Windows proof
/// surface. Unlike the debug PNG route this performs no compression and
/// preserves the capture frame sequence for duplicate suppression.
pub async fn latest_preview_camera_bmp(
    state: &AppState,
    requested_max_width: Option<u32>,
    cursor: Option<PreviewBmpCursor>,
) -> Option<LatestPreviewBmpPoll> {
    let (generation, frame) = {
        let slot = state.preview_camera.lock().await;
        let active = slot.active.as_ref()?;
        let generation = slot.run_id.clone()?;
        let shared = Arc::clone(&active.shared);
        drop(slot);
        let guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (generation, guard.frame_store.latest()?)
    };

    let max_width = preview_camera_png_max_width(requested_max_width);
    tokio::task::spawn_blocking(move || {
        encode_latest_bgra_bmp(
            cursor.as_ref(),
            generation,
            frame.sequence,
            frame.width,
            frame.height,
            &frame.bytes,
            max_width,
        )
    })
    .await
    .ok()
    .flatten()
}

fn encode_preview_camera_png(
    frame: FrameHandle<PreviewCameraPixelFormat>,
    layout: LayoutSettings,
    max_width: u32,
) -> Option<Vec<u8>> {
    let expected_len = frame.width as usize * frame.height as usize * 4;
    if frame.bytes.len() < expected_len {
        return None;
    }
    let mut rgba = Vec::with_capacity(frame.bytes.len());
    for pixel in frame.bytes.as_chunks::<4>().0 {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    if layout.camera_mirror {
        mirror_rgba_in_place(&mut rgba, frame.width as usize, frame.height as usize);
    }
    let (rgba, width, height) =
        downscale_rgba_for_preview(rgba, frame.width, frame.height, max_width);

    let mut png = Vec::new();
    let encoder = PngEncoder::new(&mut png);
    encoder
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

async fn refresh_camera_capability_diagnostics(state: &AppState, camera_id: Option<String>) {
    let (formats, error) = match camera_id.as_deref() {
        Some(camera_id) => match camera_capability_matrix_for_id(camera_id) {
            Ok(formats) => (
                formats
                    .into_iter()
                    .map(camera_capability_format_for_protocol)
                    .collect(),
                None,
            ),
            Err(error) => (Vec::new(), Some(error)),
        },
        None => (Vec::new(), None),
    };

    let mut diagnostics = state.diagnostics.lock().await;
    *diagnostics =
        apply_preview_camera_capability_stats(diagnostics.clone(), camera_id, formats, error);
}

fn camera_capability_format_for_protocol(format: CameraFormatSummary) -> CameraCapabilityFormat {
    CameraCapabilityFormat {
        width: format.width,
        height: format.height,
        min_fps: format.min_fps,
        max_fps: format.max_fps,
    }
}

fn preview_camera_png_max_width(requested_max_width: Option<u32>) -> u32 {
    requested_max_width
        .unwrap_or(PREVIEW_CAMERA_DEFAULT_PNG_WIDTH)
        .clamp(1, PREVIEW_CAMERA_MAX_PNG_WIDTH)
}

async fn set_camera_status(state: &AppState, status: PreviewCameraStatus) {
    {
        let mut slot = state.preview_camera.lock().await;
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = status.camera_id.clone().map(SourceKey::camera);
        slot.starting = None;
        slot.starting_transition_completion = None;
        slot.starting_recovery_epoch = None;
        slot.starting_layout_intent_id = None;
        slot.failed_recovery_retry = None;
        if slot.active.is_none() {
            slot.active_generation = None;
        }
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
}

#[cfg(test)]
async fn stop_current_camera_for_restart(state: &AppState) {
    let _ = stop_current_camera_for_restart_if_admitted(state, None, None).await;
}

async fn stop_current_camera_for_restart_if_admitted(
    state: &AppState,
    lease: Option<&PreviewCameraStartLease>,
    recovery_epoch: Option<u64>,
) -> bool {
    let (previous, poll_task, generation) = {
        let mut slot = state.preview_camera.lock().await;
        if !camera_start_admission_is_current_locked(state, &slot, lease, recovery_epoch) {
            return false;
        }
        let generation = slot.active_generation;
        slot.run_id = None;
        slot.active_generation = None;
        slot.live_acked_at = None;
        (slot.active.take(), slot.poll_task.take(), generation)
    };

    if let Some(task) = poll_task {
        task.abort();
    }

    if let Some(mut previous) = previous {
        let _ = previous.stop_tx.send(());
        if let Some(join_handle) = previous.join_handle.take() {
            join_camera_capture_thread(join_handle, generation, "restart").await;
        }
    }
    true
}

async fn join_camera_capture_thread(
    join_handle: thread::JoinHandle<()>,
    generation: Option<u64>,
    reason: &'static str,
) {
    let started_at = Instant::now();
    // AVCaptureSession::stopRunning is synchronous and exposes no independent
    // cancellation handle. A Tokio timeout would only abandon this join while
    // the native session kept the device; starting its replacement then would
    // overlap exclusive capture sessions. Preserve the no-overlap invariant and
    // make any over-target Apple stop explicit in diagnostics instead.
    let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    if elapsed_ms > 2_000 {
        tracing::warn!(
            "[capture-generation] source=camera generation={} reason={} stop_join_ms={} target_ms=2000 bounded=false",
            generation.unwrap_or_default(),
            reason,
            elapsed_ms,
        );
    } else {
        tracing::info!(
            "[capture-generation] source=camera generation={} reason={} stop_join_ms={}",
            generation.unwrap_or_default(),
            reason,
            elapsed_ms,
        );
    }
}

async fn begin_camera_start(
    state: &AppState,
    start_key: PreviewCameraStartKey,
    layout: &LayoutSettings,
    status: PreviewCameraStatus,
    layout_intent_id: Option<u64>,
) -> PreviewCameraStartRegistration {
    // Lock-order invariant for atomic admission: a preview runtime may acquire
    // the source registry, but code holding the source registry must never wait
    // for a preview runtime. Cancellation while this function waits for the
    // registry therefore happens before any observable admission mutation.
    let mut slot = state.preview_camera.lock().await;
    if state.process_shutdown_requested() {
        return PreviewCameraStartRegistration::RejectedShutdown(
            camera_start_rejected_for_shutdown(slot.status.clone()),
        );
    }
    {
        let _layout_admission = state.lock_layout_source_admission();
        if layout_intent_id.is_some_and(|intent_id| intent_id < state.latest_layout_intent_id()) {
            return PreviewCameraStartRegistration::RejectedSuperseded(slot.status.clone());
        }
        if slot.starting.as_ref() == Some(&start_key) && slot.starting_recovery_epoch.is_none() {
            let transition_completion = Arc::clone(
                slot.starting_transition_completion
                    .as_ref()
                    .expect("Starting camera generation must retain its transition completion"),
            );
            let admitted_starting_identity =
                match (slot.starting_layout_intent_id, layout_intent_id) {
                    // A newer layout joining an older layout-owned generation becomes
                    // its sole timeout owner. The stale intent's token stops matching.
                    (Some(current_owner), Some(intent_id)) if intent_id >= current_owner => {
                        slot.starting_layout_intent_id = Some(intent_id);
                        Some(PreviewCameraStartingIdentity {
                            source_key: start_key.source_key.clone(),
                            generation: slot.start_generation,
                            layout_intent_id: Some(intent_id),
                        })
                    }
                    // A superseded layout task can reach admission after the winning
                    // task because both transition supervisors are detached. Never
                    // transfer authority backward to that stale intent.
                    (Some(_), Some(_)) => None,
                    // A public camera command takes durable ownership from any layout
                    // warm-up. No layout timeout may cancel it afterward.
                    (Some(_), None) => {
                        slot.starting_layout_intent_id = None;
                        None
                    }
                    // A layout may observe a matching public-owned warm-up, but it
                    // does not acquire cancellation authority over that command.
                    (None, Some(_)) | (None, None) => None,
                };
            return PreviewCameraStartRegistration::JoinExisting {
                admitted_starting_identity,
                transition_completion,
            };
        }
    }
    let can_reuse = slot.pending_stop_generation.is_none()
        && slot.starting.is_none()
        && slot.status.state == PreviewCameraState::Live
        && slot.source_key.as_ref() == Some(&start_key.source_key)
        && !camera_slot_is_frameless_zombie(&slot)
        && slot.active.as_ref().is_some_and(|active| {
            active.ffmpeg_path == start_key.ffmpeg_path
                && active.video == start_key.video
                && slot.status.target_fps == start_key.target_fps
                && active.capture_target == start_key.capture_target
        });
    if can_reuse {
        // Reacquiring the preview consumer and committing reuse happen under
        // the same fast admission authority. A concurrent stop/new start
        // cannot invalidate the active generation between the check and the
        // Live result returned to this caller.
        let mut registry = state.source_registry.lock().await;
        let _layout_admission = state.lock_layout_source_admission();
        if layout_intent_id.is_some_and(|intent_id| intent_id < state.latest_layout_intent_id()) {
            return PreviewCameraStartRegistration::RejectedSuperseded(slot.status.clone());
        }
        registry.acquire(start_key.source_key.clone(), SourceConsumerReason::Preview);
        registry.set_status(start_key.source_key.clone(), SourceLifecycleStatus::Live);
        if let Some(active) = slot.active.as_mut() {
            active.layout = layout.clone();
        }
        let mut reused = slot.status.clone();
        reused.updated_at = Utc::now().to_rfc3339();
        reused.message = Some("Native camera preview source reused.".to_string());
        slot.status = reused.clone();
        log_camera_generation(
            slot.active_generation.unwrap_or(slot.start_generation),
            "reuse",
            &start_key,
            layout,
        );
        drop(slot);
        state.emit_event("preview.camera.status", reused.clone());
        return PreviewCameraStartRegistration::Reused(reused);
    }
    let previous_source_key = slot.source_key.clone();
    let mut registry = state.source_registry.lock().await;
    let _layout_admission = state.lock_layout_source_admission();
    if layout_intent_id.is_some_and(|intent_id| intent_id < state.latest_layout_intent_id()) {
        return PreviewCameraStartRegistration::RejectedSuperseded(slot.status.clone());
    }
    if let Some(previous_source_key) = previous_source_key.as_ref()
        && previous_source_key != &start_key.source_key
    {
        registry.release(previous_source_key, &SourceConsumerReason::Preview);
    }
    registry.acquire(start_key.source_key.clone(), SourceConsumerReason::Preview);
    registry.set_status(
        start_key.source_key.clone(),
        SourceLifecycleStatus::Starting,
    );
    slot.failed_recovery_retry = None;
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    slot.pending_stop_generation = None;
    let lease = PreviewCameraStartLease::new(start_key.clone(), slot.start_generation);
    slot.starting_transition_completion = Some(Arc::clone(&lease.transition_completion));
    slot.status = status.clone();
    slot.run_id = None;
    slot.source_key = Some(start_key.source_key.clone());
    slot.starting = Some(start_key);
    slot.starting_recovery_epoch = None;
    slot.starting_layout_intent_id = layout_intent_id;
    drop(registry);
    drop(_layout_admission);
    drop(slot);
    // Emission is synchronous, so registration is followed by an immediate
    // return to the caller, which queues the persistent supervisor without a
    // cancellation point.
    state.emit_event("preview.camera.status", status);
    PreviewCameraStartRegistration::Started { lease }
}

async fn camera_start_lease_is_current(state: &AppState, lease: &PreviewCameraStartLease) -> bool {
    let slot = state.preview_camera.lock().await;
    slot.start_generation == lease.generation
        && slot.pending_stop_generation.is_none()
        && slot.starting.as_ref() == Some(&lease.key)
}

async fn publish_camera_start_admission(state: &AppState, prepared: &PreparedCameraStart) {
    if !camera_start_lease_is_current(state, &prepared.lease).await {
        return;
    }
    let status = {
        let slot = state.preview_camera.lock().await;
        if slot.start_generation != prepared.lease.generation
            || slot.starting.as_ref() != Some(&prepared.lease.key)
        {
            return;
        }
        slot.status.clone()
    };
    let mut diagnostics = state.diagnostics.lock().await;
    *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
}

async fn delayed_camera_transition_status(
    state: &AppState,
    lease: &PreviewCameraStartLease,
) -> PreviewCameraStatus {
    let status = {
        let mut slot = state.preview_camera.lock().await;
        if slot.start_generation == lease.generation && slot.starting.as_ref() == Some(&lease.key) {
            slot.status.updated_at = Utc::now().to_rfc3339();
            slot.status.message = Some(
                "Camera transition is still retiring the previous native session; cleanup continues without overlapping capture."
                    .to_string(),
            );
        }
        slot.status.clone()
    };
    state.emit_event("preview.camera.status", status.clone());
    status
}

fn claim_camera_start(slot: &mut PreviewCameraRuntime, lease: &PreviewCameraStartLease) -> bool {
    if slot.start_generation != lease.generation
        || slot.pending_stop_generation.is_some()
        || slot.starting.as_ref() != Some(&lease.key)
    {
        return false;
    }
    slot.starting = None;
    slot.starting_transition_completion = None;
    slot.starting_recovery_epoch = None;
    slot.starting_layout_intent_id = None;
    true
}

async fn wait_for_camera_start(
    state: &AppState,
    start_key: &PreviewCameraStartKey,
) -> PreviewCameraStatus {
    let timeout =
        native_camera_preview_thread_startup_timeout().saturating_add(Duration::from_secs(1));
    let started_at = Instant::now();
    loop {
        let (still_starting, status) = {
            let slot = state.preview_camera.lock().await;
            (
                slot.starting.as_ref() == Some(start_key)
                    && matches!(slot.status.state, PreviewCameraState::Starting),
                slot.status.clone(),
            )
        };
        if !still_starting || started_at.elapsed() >= timeout {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn set_camera_status_for_start(
    state: &AppState,
    lease: &PreviewCameraStartLease,
    recovery_epoch: Option<u64>,
    status: PreviewCameraStatus,
) -> bool {
    let source_key = status.camera_id.clone().map(SourceKey::camera);
    {
        let mut slot = state.preview_camera.lock().await;
        if !claim_camera_start_if_admitted(state, &mut slot, lease, recovery_epoch) {
            return false;
        }
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = source_key;
        if status.state != PreviewCameraState::Failed {
            slot.failed_recovery_retry = None;
        }
        if slot.active.is_none() {
            slot.active_generation = None;
        }
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
    true
}

#[cfg(test)]
async fn current_camera_source_key(state: &AppState) -> Option<SourceKey> {
    state.preview_camera.lock().await.source_key.clone()
}

async fn acquire_preview_camera_source(
    state: &AppState,
    source_key: SourceKey,
    status: SourceLifecycleStatus,
) {
    let mut registry = state.source_registry.lock().await;
    registry.acquire(source_key.clone(), SourceConsumerReason::Preview);
    registry.set_status(source_key, status);
}

#[cfg(test)]
async fn release_current_preview_camera_source(state: &AppState) -> bool {
    let Some(source_key) = current_camera_source_key(state).await else {
        return false;
    };
    release_preview_camera_source(state, &source_key).await
}

#[cfg(test)]
async fn release_preview_camera_source(state: &AppState, source_key: &SourceKey) -> bool {
    let snapshot = state
        .source_registry
        .lock()
        .await
        .release(source_key, &SourceConsumerReason::Preview);
    snapshot
        .entries
        .iter()
        .find(|entry| &entry.key == source_key)
        .is_some_and(|entry| !entry.consumers.is_empty())
}

/// How long a Live-acked session may stay frameless before reuse treats it as
/// dead. This MUST exceed the camera's layout warm-start budget
/// (`live_layout::WARM_CAMERA_START_TIMEOUT`): a readiness bail deliberately
/// leaves the still-warming session in place, and the next switch attempt has
/// to JOIN that warm-up — tearing it down restarts the device clock from zero,
/// so a camera whose first frame is slower than the grace could never come
/// back (0.9.51 Cam Link retry-storm regression). Only a session frameless
/// longer than any legitimate warm-up is treated as dead.
pub(crate) const CAMERA_FIRST_FRAME_REUSE_GRACE: Duration = Duration::from_secs(20);

/// True when the current camera session acked Live, has never produced any
/// frame evidence (no captured-frame count, nothing in the frame store), and
/// has been in that state longer than the first-frame grace.
#[cfg(test)]
async fn camera_live_session_is_frameless_zombie(state: &AppState) -> bool {
    let slot = state.preview_camera.lock().await;
    camera_slot_is_frameless_zombie(&slot)
}

fn camera_slot_is_frameless_zombie(slot: &PreviewCameraRuntime) -> bool {
    if slot.status.state != PreviewCameraState::Live {
        return false;
    }
    let has_frame_evidence = slot.status.frames_captured > 0
        || slot.status.sequence.is_some()
        || slot.active.as_ref().is_some_and(|active| {
            // WouldBlock means the capture thread holds the frame lock right
            // now — that is evidence of life, not a zombie.
            match active.shared.try_lock() {
                Ok(shared) => shared.frame_store.latest().is_some(),
                Err(TryLockError::WouldBlock) => true,
                Err(TryLockError::Poisoned(poisoned)) => {
                    poisoned.into_inner().frame_store.latest().is_some()
                }
            }
        });
    if has_frame_evidence {
        return false;
    }
    slot.live_acked_at
        .is_none_or(|acked| acked.elapsed() >= CAMERA_FIRST_FRAME_REUSE_GRACE)
}

/// Test-only: install a healthy Live camera slot whose capture target was
/// derived from `layout`, so cross-module tests (live_layout's geometry
/// resync) can arm a staleness scenario without reaching into private slot
/// fields.
#[cfg(test)]
pub(crate) async fn test_install_live_camera_for_layout(
    state: &AppState,
    camera_id: &str,
    layout: &LayoutSettings,
    video: &VideoSettings,
) {
    let (stop_tx, _stop_rx) = std_mpsc::channel();
    let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
    shared.lock().unwrap().frame_store.publish(
        42,
        video.width,
        video.height,
        PreviewCameraPixelFormat::Bgra8,
        Instant::now(),
        vec![0; video.width as usize * video.height as usize * 4],
    );
    let mut slot = state.preview_camera.lock().await;
    slot.source_key = Some(SourceKey::camera(camera_id.to_string()));
    slot.status.state = PreviewCameraState::Live;
    slot.status.camera_id = Some(camera_id.to_string());
    slot.status.device_unique_id = Some(camera_id.to_string());
    slot.status.target_fps = video.fps;
    slot.status.width = Some(video.width);
    slot.status.height = Some(video.height);
    slot.status.requested_width = Some(video.width);
    slot.status.requested_height = Some(video.height);
    slot.status.actual_width = Some(video.width);
    slot.status.actual_height = Some(video.height);
    slot.status.frames_captured = 42;
    slot.status.sequence = Some(42);
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    slot.active_generation = Some(slot.start_generation);
    slot.live_acked_at = Some(Instant::now());
    slot.active = Some(NativeCameraPreviewThread {
        stop_tx,
        join_handle: None,
        shared,
        camera_id: camera_id.to_string(),
        device_unique_id: camera_id.to_string(),
        ffmpeg_path: "ffmpeg".to_string(),
        layout: layout.clone(),
        video: video.clone(),
        effective_fps: video.fps,
        configured_output: (video.width, video.height),
        capture_target: camera_capture_target_dimensions(layout, video),
    });
}

/// Test-only: register a fully identified Starting generation without touching
/// a physical camera. Cross-module race tests use the returned identity to
/// exercise the same generation-and-key CAS as production timeout cleanup.
#[cfg(test)]
pub(crate) async fn test_install_starting_camera_generation(
    state: &AppState,
    camera_id: &str,
    layout: &LayoutSettings,
    video: &VideoSettings,
    layout_intent_id: Option<u64>,
) -> PreviewCameraStartingIdentity {
    let source_key = SourceKey::camera(camera_id.to_string());
    let start_key = PreviewCameraStartKey {
        source_key: source_key.clone(),
        ffmpeg_path: "ffmpeg".to_string(),
        video: video.clone(),
        target_fps: video.fps,
        capture_target: camera_capture_target_dimensions(layout, video),
    };
    let mut slot = state.preview_camera.lock().await;
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    slot.pending_stop_generation = None;
    slot.active_generation = None;
    slot.source_key = Some(source_key.clone());
    slot.starting = Some(start_key);
    slot.starting_recovery_epoch = None;
    slot.starting_layout_intent_id = layout_intent_id;
    slot.status.state = PreviewCameraState::Starting;
    slot.status.camera_id = Some(camera_id.to_string());
    slot.status.device_unique_id = Some(camera_id.to_string());
    slot.status.target_fps = video.fps;
    slot.status.frames_captured = 0;
    slot.status.sequence = None;
    slot.active = None;
    PreviewCameraStartingIdentity {
        source_key,
        generation: slot.start_generation,
        layout_intent_id,
    }
}

/// Test-only: publish Live for the exact Starting generation without advancing
/// its identity. This models the native callback racing timeout cancellation.
#[cfg(test)]
pub(crate) async fn test_publish_starting_camera_live(
    state: &AppState,
    expected: &PreviewCameraStartingIdentity,
    camera_id: &str,
    layout: &LayoutSettings,
    video: &VideoSettings,
) {
    let (stop_tx, _stop_rx) = std_mpsc::channel();
    let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
    shared.lock().unwrap().frame_store.publish(
        42,
        video.width,
        video.height,
        PreviewCameraPixelFormat::Bgra8,
        Instant::now(),
        vec![0; video.width as usize * video.height as usize * 4],
    );
    let mut slot = state.preview_camera.lock().await;
    assert_eq!(
        camera_starting_identity_from_slot(&slot).as_ref(),
        Some(expected),
        "test callback must publish the sampled generation"
    );
    slot.status.state = PreviewCameraState::Live;
    slot.status.camera_id = Some(camera_id.to_string());
    slot.status.device_unique_id = Some(camera_id.to_string());
    slot.status.target_fps = video.fps;
    slot.status.width = Some(video.width);
    slot.status.height = Some(video.height);
    slot.status.actual_width = Some(video.width);
    slot.status.actual_height = Some(video.height);
    slot.status.frames_captured = 42;
    slot.status.sequence = Some(42);
    slot.active_generation = Some(expected.generation);
    slot.starting = None;
    slot.starting_transition_completion = None;
    slot.starting_layout_intent_id = None;
    slot.live_acked_at = Some(Instant::now());
    slot.active = Some(NativeCameraPreviewThread {
        stop_tx,
        join_handle: None,
        shared,
        camera_id: camera_id.to_string(),
        device_unique_id: camera_id.to_string(),
        ffmpeg_path: "ffmpeg".to_string(),
        layout: layout.clone(),
        video: video.clone(),
        effective_fps: video.fps,
        configured_output: (video.width, video.height),
        capture_target: camera_capture_target_dimensions(layout, video),
    });
}

/// Test-only: replace a Live camera session with a same-key, new-generation
/// owner and a deterministic frame. Cross-module compositor tests use this to
/// prove held-frame/fetch state is reset on generation identity, not source key.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) async fn test_advance_live_camera_generation(state: &AppState, sequence: u64) -> u64 {
    let mut slot = state.preview_camera.lock().await;
    let active = slot.active.as_ref().expect("test live camera");
    let camera_id = active.camera_id.clone();
    let device_unique_id = active.device_unique_id.clone();
    let ffmpeg_path = active.ffmpeg_path.clone();
    let layout = active.layout.clone();
    let video = active.video.clone();
    let effective_fps = active.effective_fps;
    let configured_output = active.configured_output;
    let capture_target = active.capture_target;
    let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
    shared.lock().unwrap().frame_store.publish(
        sequence,
        configured_output.0,
        configured_output.1,
        PreviewCameraPixelFormat::Bgra8,
        Instant::now(),
        vec![0; configured_output.0 as usize * configured_output.1 as usize * 4],
    );
    let (stop_tx, _stop_rx) = std_mpsc::channel();
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    let generation = slot.start_generation;
    slot.active_generation = Some(generation);
    slot.failed_recovery_retry = None;
    slot.status.state = PreviewCameraState::Live;
    slot.status.frames_captured = sequence;
    slot.status.sequence = Some(sequence);
    slot.status.actual_width = Some(configured_output.0);
    slot.status.actual_height = Some(configured_output.1);
    slot.active = Some(NativeCameraPreviewThread {
        stop_tx,
        join_handle: None,
        shared,
        camera_id,
        device_unique_id,
        ffmpeg_path,
        layout,
        video,
        effective_fps,
        configured_output,
        capture_target,
    });
    generation
}

/// True when the live camera session's configured capture box no longer
/// matches what `layout`/`video` require. A hot preset switch (inset overlay
/// <-> full canvas) keeps the session alive while its AVFoundation output
/// stays sized for the old scene; only a restart re-derives the geometry.
pub(crate) async fn camera_capture_geometry_is_stale(
    state: &AppState,
    layout: &LayoutSettings,
    video: &VideoSettings,
) -> bool {
    let slot = state.preview_camera.lock().await;
    if slot.status.state != PreviewCameraState::Live {
        return false;
    }
    slot.active.as_ref().is_some_and(|active| {
        active.capture_target != camera_capture_target_dimensions(layout, video)
    })
}

#[cfg(test)]
async fn reuse_current_camera_source(
    state: &AppState,
    source_key: &SourceKey,
    ffmpeg_path: &str,
    layout: &LayoutSettings,
    video: &VideoSettings,
    target_fps: u32,
) -> Option<PreviewCameraStatus> {
    let mut slot = state.preview_camera.lock().await;
    if slot.source_key.as_ref() != Some(source_key)
        || slot.starting.is_some()
        || slot.pending_stop_generation.is_some()
        || camera_slot_is_frameless_zombie(&slot)
    {
        return None;
    }
    let can_reuse = slot.active.as_ref().is_some_and(|active| {
        active.ffmpeg_path == ffmpeg_path
            && active.video == *video
            && slot.status.target_fps == target_fps
            // AVFoundation output geometry is fixed at session start; a layout
            // whose capture box differs (inset overlay vs full canvas) must
            // restart the session, not adopt frames sized for the old scene.
            && active.capture_target == camera_capture_target_dimensions(layout, video)
    });
    if !can_reuse {
        return None;
    }

    if let Some(active) = slot.active.as_mut() {
        active.layout = layout.clone();
    }
    let mut status = slot.status.clone();
    status.updated_at = Utc::now().to_rfc3339();
    status.message = Some("Native camera preview source reused.".to_string());
    slot.status = status.clone();
    let start_key = PreviewCameraStartKey {
        source_key: source_key.clone(),
        ffmpeg_path: ffmpeg_path.to_string(),
        video: video.clone(),
        target_fps,
        capture_target: camera_capture_target_dimensions(layout, video),
    };
    log_camera_generation(
        slot.active_generation.unwrap_or(slot.start_generation),
        "reuse",
        &start_key,
        layout,
    );
    Some(status)
}

async fn poll_camera_metrics(
    state: AppState,
    run_id: String,
    shared: Arc<StdMutex<PreviewCameraShared>>,
    target_fps: u32,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        let snapshot = {
            let guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let latest_frame = guard.frame_store.latest();
            CameraSharedSnapshot {
                frames_captured: guard.frames_captured,
                dropped_frames: guard.dropped_frames,
                source_fps: guard.source_fps,
                capture: PreviewCameraCaptureStats {
                    callback_count: guard.capture_callback_count,
                    did_drop_callback_count: guard.capture_drop_reasons.total(),
                    frame_store_publications: guard.frames_captured,
                    callback_age_ms: guard
                        .capture_timings
                        .last_callback_at
                        .map(|at| at.elapsed().as_millis() as u64),
                    latest_sequence: latest_frame.as_ref().map(|frame| frame.sequence),
                    pixel_format: camera_capture_pixel_format_label(guard.capture_pixel_format),
                    drop_reasons: guard.capture_drop_reasons.diagnostic_stats(),
                },
                latest_frame,
                frame_store_stats: guard.frame_store.stats(),
                capture_timings: guard.capture_timings.snapshot(),
            }
        };

        let status = {
            let mut slot = state.preview_camera.lock().await;
            if slot.run_id.as_deref() != Some(run_id.as_str()) {
                break;
            }
            slot.status.frames_captured = snapshot.frames_captured;
            slot.status.dropped_frames = snapshot.dropped_frames;
            slot.status.source_fps = snapshot.source_fps.or(Some(f64::from(target_fps)));
            if let Some(frame) = snapshot.latest_frame {
                slot.status.state = PreviewCameraState::Live;
                slot.status.width = Some(frame.width);
                slot.status.height = Some(frame.height);
                slot.status.actual_width = Some(frame.width);
                slot.status.actual_height = Some(frame.height);
                slot.status.sequence = Some(frame.sequence);
                let _frame_bytes = frame.bytes.len();
                slot.status.frame_age_ms = Some(frame.captured_at.elapsed().as_millis() as u64);
                match frame.pixel_format {
                    PreviewCameraPixelFormat::Bgra8 => {}
                }
            }
            slot.status.updated_at = Utc::now().to_rfc3339();
            slot.status.clone()
        };
        {
            let screen_frame_store_stats =
                crate::preview_screen::preview_screen_frame_store_stats(&state).await;
            let mut diagnostics = state.diagnostics.lock().await;
            let stats = apply_preview_camera_source_stats(diagnostics.clone(), &status);
            let stats = apply_preview_camera_capture_stats(stats, snapshot.capture);
            let stats = apply_preview_camera_capture_timing_stats(stats, snapshot.capture_timings);
            *diagnostics = apply_preview_source_frame_store_stats(
                stats,
                snapshot.frame_store_stats,
                screen_frame_store_stats,
            );
        }
        state.emit_event("preview.camera.status", status);
    }
}

#[derive(Debug)]
struct CameraSharedSnapshot {
    frames_captured: u64,
    dropped_frames: u64,
    source_fps: Option<f64>,
    capture: PreviewCameraCaptureStats,
    latest_frame: Option<FrameHandle<PreviewCameraPixelFormat>>,
    frame_store_stats: FrameStoreStats,
    capture_timings: PreviewCameraCaptureTimingStats,
}

#[cfg(target_os = "macos")]
fn camera_capture_pixel_format_label(pixel_format: Option<u32>) -> Option<String> {
    pixel_format.map(macos::format_fourcc)
}

#[cfg(not(target_os = "macos"))]
fn camera_capture_pixel_format_label(_pixel_format: Option<u32>) -> Option<String> {
    None
}

fn idle_status(message: Option<String>) -> PreviewCameraStatus {
    PreviewCameraStatus {
        state: PreviewCameraState::DeviceMissing,
        camera_id: None,
        device_unique_id: None,
        target_fps: 0,
        width: None,
        height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        selected_format_width: None,
        selected_format_height: None,
        selected_format_min_fps: None,
        selected_format_max_fps: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

fn status_for_missing_camera(camera_id: Option<String>, message: &str) -> PreviewCameraStatus {
    PreviewCameraStatus {
        state: PreviewCameraState::DeviceMissing,
        camera_id,
        device_unique_id: None,
        target_fps: 0,
        width: None,
        height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        selected_format_width: None,
        selected_format_height: None,
        selected_format_min_fps: None,
        selected_format_max_fps: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message.to_string()),
    }
}

fn failed_status(
    camera_id: Option<String>,
    unique_id: Option<String>,
    target_fps: u32,
    message: String,
) -> PreviewCameraStatus {
    PreviewCameraStatus {
        state: PreviewCameraState::Failed,
        camera_id,
        device_unique_id: unique_id,
        target_fps,
        width: None,
        height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        selected_format_width: None,
        selected_format_height: None,
        selected_format_min_fps: None,
        selected_format_max_fps: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message),
    }
}

fn mirror_rgba_in_place(bytes: &mut [u8], width: usize, height: usize) {
    let row_bytes = width.saturating_mul(4);
    if row_bytes == 0 || bytes.len() < row_bytes.saturating_mul(height) {
        return;
    }
    for row in 0..height {
        let start = row * row_bytes;
        let end = start + row_bytes;
        let row = &mut bytes[start..end];
        for column in 0..(width / 2) {
            let left = column * 4;
            let right = (width - 1 - column) * 4;
            for channel in 0..4 {
                row.swap(left + channel, right + channel);
            }
        }
    }
}

fn downscale_rgba_for_preview(
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    max_width: u32,
) -> (Vec<u8>, u32, u32) {
    if width <= max_width || width == 0 || height == 0 {
        return (bytes, width, height);
    }

    let next_width = max_width.max(1);
    let next_height = ((u64::from(height) * u64::from(next_width)) / u64::from(width))
        .clamp(1, u64::from(u32::MAX)) as u32;

    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4));
    if expected_len != Some(bytes.len()) {
        return (bytes, width, height);
    }
    let image = image::RgbaImage::from_raw(width, height, bytes).expect("valid RGBA buffer length");
    let next = image::imageops::resize(&image, next_width, next_height, FilterType::Lanczos3);

    (next.into_raw(), next_width, next_height)
}

fn fit_camera_source_in_target_box(
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> (u32, u32) {
    if source_width == 0 || source_height == 0 || target_width == 0 || target_height == 0 {
        return (source_width, source_height);
    }

    let box_width = target_width.min(source_width).max(1);
    let box_height = target_height.min(source_height).max(1);
    let height_for_width = scale_preserving_aspect(source_height, box_width, source_width);
    if height_for_width <= box_height {
        return (box_width, height_for_width.max(1));
    }

    (
        scale_preserving_aspect(source_width, box_height, source_height).max(1),
        box_height,
    )
}

fn scale_preserving_aspect(source_dimension: u32, target_dimension: u32, source_basis: u32) -> u32 {
    if source_basis == 0 {
        return target_dimension;
    }
    ((u64::from(source_dimension) * u64::from(target_dimension) + (u64::from(source_basis) / 2))
        / u64::from(source_basis))
    .clamp(1, u64::from(u32::MAX)) as u32
}

#[derive(Clone)]
struct NativeCameraPreviewConfig {
    camera_id: String,
    unique_id: String,
    ffmpeg_path: String,
    video: VideoSettings,
    layout: LayoutSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SelectedCameraSource {
    MacAvFoundation { unique_id: String },
    WindowsDshow { device_name: String },
}

impl SelectedCameraSource {
    fn device_unique_id(&self) -> &str {
        match self {
            SelectedCameraSource::MacAvFoundation { unique_id } => unique_id,
            SelectedCameraSource::WindowsDshow { device_name } => device_name,
        }
    }
}

fn selected_camera_source(camera_id: &str) -> Option<SelectedCameraSource> {
    parse_native_camera_id(camera_id)
        .map(|unique_id| SelectedCameraSource::MacAvFoundation { unique_id })
        .or_else(|| {
            parse_windows_dshow_camera_id(camera_id)
                .map(|device_name| SelectedCameraSource::WindowsDshow { device_name })
        })
}

#[cfg(any(target_os = "windows", test))]
fn windows_camera_preview_output_dimensions(config: &NativeCameraPreviewConfig) -> (u32, u32) {
    if matches!(
        config.layout.layout_preset,
        LayoutPreset::ScreenCamera | LayoutPreset::VerticalScreenCamera
    ) {
        return camera_overlay_target_dimensions(&config.layout, &config.video);
    }
    camera_capture_target_dimensions(&config.layout, &config.video)
}

#[cfg(any(target_os = "windows", test))]
fn windows_camera_preview_ffmpeg_args(
    config: &NativeCameraPreviewConfig,
    width: u32,
    height: u32,
    fps: u32,
) -> Vec<String> {
    windows_camera_preview_ffmpeg_args_opts(config, width, height, fps, Some(fps))
}

#[cfg(any(target_os = "windows", test))]
fn windows_camera_preview_ffmpeg_args_opts(
    config: &NativeCameraPreviewConfig,
    width: u32,
    height: u32,
    fps: u32,
    request_fps: Option<u32>,
) -> Vec<String> {
    windows_camera_preview_ffmpeg_args_mode(config, width, height, fps, request_fps, None)
}

#[cfg(any(target_os = "windows", test))]
fn windows_camera_preview_ffmpeg_args_mode(
    config: &NativeCameraPreviewConfig,
    width: u32,
    height: u32,
    fps: u32,
    request_fps: Option<u32>,
    mjpeg_capture_size: Option<(u32, u32)>,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-nostdin".to_string(),
    ];
    crate::capture_input::append_windows_dshow_video_input_mode_opts(
        &mut args,
        &config.unique_id,
        request_fps,
        mjpeg_capture_size,
        mjpeg_capture_size.map(|_| "mjpeg"),
    );
    let mut filters = Vec::with_capacity(3);
    if request_fps.is_none() {
        // The retry lets dshow negotiate a native cadence. Cap devices whose
        // default exceeds the session target without manufacturing duplicates
        // for 10/15/25fps cameras (the `fps` filter does both).
        filters.push(format!(
            "select='isnan(prev_selected_t)+gte(t-prev_selected_t+{WINDOWS_CAMERA_RATE_CAP_EPSILON_SECONDS:.6}\\,1/{fps})'"
        ));
    }
    filters.push(format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    ));
    filters.push("format=bgra".to_string());
    args.extend([
        "-an".to_string(),
        "-vf".to_string(),
        filters.join(","),
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "bgra".to_string(),
        "-".to_string(),
    ]);
    args
}

#[cfg(any(target_os = "windows", test))]
fn windows_camera_mjpeg_capture_modes(width: u32, height: u32) -> Vec<(u32, u32)> {
    const COMMON_MODES: &[(u32, u32)] = &[
        (160, 90),
        (160, 120),
        (176, 144),
        (320, 180),
        (320, 240),
        (352, 288),
        (432, 240),
        (640, 360),
        (640, 480),
        (800, 448),
        (800, 600),
        (864, 480),
        (960, 720),
        (1024, 576),
        (1280, 720),
        (1600, 896),
        (1920, 1080),
    ];
    let target_width = u64::from(width.max(1));
    let target_height = u64::from(height.max(1));
    let target_pixels = target_width.saturating_mul(target_height);
    let mut modes = COMMON_MODES.to_vec();
    modes.sort_by_key(|&(mode_width, mode_height)| {
        let mode_width = u64::from(mode_width);
        let mode_height = u64::from(mode_height);
        let mode_pixels = mode_width.saturating_mul(mode_height);
        let undersized = u8::from(mode_width < target_width || mode_height < target_height);
        let aspect_error = mode_width
            .saturating_mul(target_height)
            .abs_diff(target_width.saturating_mul(mode_height));
        (
            undersized,
            aspect_error,
            mode_pixels.abs_diff(target_pixels),
        )
    });
    modes
}

fn camera_capture_target_dimensions(_layout: &LayoutSettings, video: &VideoSettings) -> (u32, u32) {
    // Capture geometry is LAYOUT-INVARIANT on purpose: always the full output
    // canvas, for every preset. The inset scenes used to capture a small
    // overlay box as an optimization, which made camera-only <-> screen+camera
    // the one preset pair whose capture boxes differed — so exactly those
    // switches force-restarted the camera (device power-cycles, renegotiation
    // garbage on screen; owner-reported through 0.9.64). The compositor's
    // scene math scales the full-size frame into any inset, capturing big and
    // scaling down only improves inset quality, and a preset switch can now
    // NEVER invalidate a running camera session. Only genuine output-canvas
    // changes (video preset/orientation) re-derive capture geometry.
    // The Windows D3D11 overlay path does its own overlay sizing in
    // windows_camera_preview_output_dimensions.
    (video.width, video.height)
}

#[cfg(any(target_os = "windows", test))]
fn camera_overlay_target_dimensions(layout: &LayoutSettings, video: &VideoSettings) -> (u32, u32) {
    if let (CameraTransformMode::Custom, Some(transform)) =
        (layout.camera_transform_mode, layout.camera_transform)
    {
        (
            scale_camera_dimension(
                (transform.width.clamp(0.0, 1.0) * f64::from(video.width.max(1))).round(),
            ),
            scale_camera_dimension(
                (transform.height.clamp(0.0, 1.0) * f64::from(video.height.max(1))).round(),
            ),
        )
    } else {
        scaled_camera_box_size(
            &layout.camera_size,
            &layout.camera_shape,
            &layout.camera_aspect,
            video,
        )
    }
}

#[cfg(any(target_os = "windows", test))]
fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    aspect: &CameraAspect,
    video: &VideoSettings,
) -> (u32, u32) {
    let scale = camera_output_scale(video);
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    // Must mirror scene::camera_box_size — the preview box and the composed
    // box are the same box or the preview lies.
    let height = match shape {
        CameraShape::Circle => width,
        CameraShape::Rectangle | CameraShape::Rounded => match aspect {
            CameraAspect::Source => (width * 9 + 8) / 16,
            CameraAspect::Square => width,
            CameraAspect::Portrait => (width * 4u32).div_ceil(3),
        },
    };

    (
        scale_camera_dimension(f64::from(width) * scale),
        scale_camera_dimension(f64::from(height) * scale),
    )
}

#[cfg(any(target_os = "windows", test))]
fn camera_output_scale(video: &VideoSettings) -> f64 {
    (f64::from(video.width) / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(f64::from(video.height) / f64::from(CAMERA_REFERENCE_HEIGHT))
}

#[cfg(any(target_os = "windows", test))]
fn scale_camera_dimension(value: f64) -> u32 {
    value.round().max(1.0).min(f64::from(u32::MAX)) as u32
}

#[derive(Debug)]
enum NativeCameraStartup {
    Live {
        requested_width: u32,
        requested_height: u32,
        selected_format_width: u32,
        selected_format_height: u32,
        selected_format_min_fps: f64,
        selected_format_max_fps: f64,
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    },
    PermissionNeeded(String),
    DeviceMissing(String),
    Failed(String),
}

fn run_native_camera_preview(
    config: NativeCameraPreviewConfig,
    shared: Arc<StdMutex<PreviewCameraShared>>,
    stop_rx: std_mpsc::Receiver<()>,
    startup_tx: std_mpsc::Sender<NativeCameraStartup>,
) {
    let _ = config.ffmpeg_path.as_str();

    #[cfg(target_os = "macos")]
    macos::run_native_camera_preview(config, shared, stop_rx, startup_tx);

    #[cfg(target_os = "windows")]
    {
        windows::run_native_camera_preview(config, shared, stop_rx, startup_tx);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = config;
        let _ = shared;
        let _ = stop_rx;
        let _ = startup_tx.send(NativeCameraStartup::Failed(
            "Native camera preview is only available on macOS.".to_string(),
        ));
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::process_job::spawn_owned_std;

    pub fn run_native_camera_preview(
        config: NativeCameraPreviewConfig,
        shared: Arc<StdMutex<PreviewCameraShared>>,
        stop_rx: std_mpsc::Receiver<()>,
        startup_tx: std_mpsc::Sender<NativeCameraStartup>,
    ) {
        let (width, height) = windows_camera_preview_output_dimensions(&config);
        let fps = config.video.fps.clamp(1, 120);
        let Some(frame_len) = bgra_frame_len(width, height) else {
            let _ = startup_tx.send(NativeCameraStartup::Failed(
                "Windows camera preview dimensions are too large.".to_string(),
            ));
            return;
        };

        // One stop signal shared across attempts; a per-attempt killer reacts
        // to it (the read loop unblocks when the ffmpeg child is killed).
        let stop_flag = Arc::new(AtomicBool::new(false));
        {
            let stop_flag = Arc::clone(&stop_flag);
            thread::spawn(move || {
                let _ = stop_rx.recv();
                stop_flag.store(true, Ordering::Release);
            });
        }

        // Prefer an explicit MJPEG mode. Consumer webcams commonly reserve
        // 720p30 for MJPEG while their uncompressed DirectShow mode tops out
        // at 5-10 fps. Retain the exact-rate and negotiated-default fallbacks
        // for cameras that do not expose MJPEG.
        let mut attempts = windows_camera_mjpeg_capture_modes(width, height)
            .into_iter()
            .map(|capture_size| (Some(fps), Some(capture_size)))
            .collect::<Vec<_>>();
        attempts.extend([(Some(fps), None), (None, None)]);
        let attempt_count = attempts.len();
        for (attempt_index, (request_fps, mjpeg_capture_size)) in attempts.into_iter().enumerate() {
            if stop_flag.load(Ordering::Acquire) {
                return;
            }
            let last_attempt = attempt_index + 1 == attempt_count;
            match run_windows_camera_preview_attempt(
                &config,
                &shared,
                &startup_tx,
                &stop_flag,
                width,
                height,
                fps,
                frame_len,
                request_fps,
                mjpeg_capture_size,
                last_attempt,
            ) {
                CameraPreviewAttempt::ProducedFrames | CameraPreviewAttempt::Stopped => return,
                CameraPreviewAttempt::FailedBeforeFirstFrame => {
                    // Retry the next attempt (or, if this was the last, the
                    // Failed status was already sent by the attempt).
                }
            }
        }
    }

    enum CameraPreviewAttempt {
        ProducedFrames,
        Stopped,
        FailedBeforeFirstFrame,
    }

    #[allow(clippy::too_many_arguments)]
    fn run_windows_camera_preview_attempt(
        config: &NativeCameraPreviewConfig,
        shared: &Arc<StdMutex<PreviewCameraShared>>,
        startup_tx: &std_mpsc::Sender<NativeCameraStartup>,
        stop_flag: &Arc<AtomicBool>,
        width: u32,
        height: u32,
        fps: u32,
        frame_len: usize,
        request_fps: Option<u32>,
        mjpeg_capture_size: Option<(u32, u32)>,
        last_attempt: bool,
    ) -> CameraPreviewAttempt {
        let args = windows_camera_preview_ffmpeg_args_mode(
            config,
            width,
            height,
            fps,
            request_fps,
            mjpeg_capture_size,
        );
        let mut command = Command::new(&config.ffmpeg_path);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match spawn_owned_std(&mut command) {
            Ok(child) => child,
            Err(error) => {
                if last_attempt {
                    let _ = startup_tx.send(NativeCameraStartup::Failed(format!(
                        "Could not start {} for Windows camera preview: {error}",
                        config.ffmpeg_path
                    )));
                }
                return CameraPreviewAttempt::FailedBeforeFirstFrame;
            }
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            if last_attempt {
                let _ = startup_tx.send(NativeCameraStartup::Failed(
                    "Windows camera preview did not expose FFmpeg stdout.".to_string(),
                ));
            }
            return CameraPreviewAttempt::FailedBeforeFirstFrame;
        };
        let stderr = collect_stderr(child.stderr.take());
        let child = Arc::new(StdMutex::new(child));
        let done = Arc::new(AtomicBool::new(false));
        let killer =
            spawn_stop_flag_killer(Arc::clone(&child), Arc::clone(&done), Arc::clone(stop_flag));

        let mut startup_sent = false;
        let mut buffer = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .frame_store
            .checkout_overwrite_buffer(frame_len);
        let mut outcome = CameraPreviewAttempt::FailedBeforeFirstFrame;
        loop {
            match stdout.read_exact(&mut buffer) {
                Ok(()) => {
                    buffer = publish_bgra_frame(shared, width, height, buffer);
                    if !startup_sent {
                        let _ = startup_tx.send(NativeCameraStartup::Live {
                            requested_width: width,
                            requested_height: height,
                            selected_format_width: mjpeg_capture_size
                                .map_or(width, |size| size.0),
                            selected_format_height: mjpeg_capture_size
                                .map_or(height, |size| size.1),
                            selected_format_min_fps: fps as f64,
                            selected_format_max_fps: fps as f64,
                            width,
                            height,
                            selected_fps: fps as f64,
                            message: Some(if let Some((capture_width, capture_height)) =
                                mjpeg_capture_size
                            {
                                format!(
                                    "Windows FFmpeg camera preview is using explicit dshow MJPEG {capture_width}x{capture_height}@{fps}, scaled to {width}x{height}."
                                )
                            } else if request_fps.is_some() {
                                "Windows FFmpeg camera preview is using an explicit dshow frame rate."
                                    .to_string()
                            } else {
                                "Windows FFmpeg camera preview is using the negotiated dshow default."
                                    .to_string()
                            }),
                        });
                        startup_sent = true;
                        outcome = CameraPreviewAttempt::ProducedFrames;
                    }
                }
                Err(error) => {
                    if startup_sent {
                        // Ran and then ended (stop, unplug, or EOF); the caller
                        // must not retry a preview that already went live.
                        outcome = CameraPreviewAttempt::ProducedFrames;
                    } else if stop_flag.load(Ordering::Acquire) {
                        outcome = CameraPreviewAttempt::Stopped;
                    } else if last_attempt {
                        let _ = startup_tx.send(NativeCameraStartup::Failed(format!(
                            "Windows FFmpeg camera preview ended before the first frame: {error}{}",
                            stderr_suffix(&stderr)
                        )));
                    }
                    break;
                }
            }
        }

        done.store(true, Ordering::Release);
        let _ = child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .wait();
        let _ = killer.join();
        outcome
    }

    fn bgra_frame_len(width: u32, height: u32) -> Option<usize> {
        (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)
    }

    fn collect_stderr(stderr: Option<std::process::ChildStderr>) -> Arc<StdMutex<Vec<u8>>> {
        let bytes = Arc::new(StdMutex::new(Vec::new()));
        if let Some(mut stderr) = stderr {
            let target = Arc::clone(&bytes);
            thread::spawn(move || {
                let mut buffer = Vec::new();
                let _ = stderr.read_to_end(&mut buffer);
                *target
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = buffer;
            });
        }
        bytes
    }

    fn spawn_stop_flag_killer(
        child: Arc<StdMutex<Child>>,
        done: Arc<AtomicBool>,
        stop_flag: Arc<AtomicBool>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                if stop_flag.load(Ordering::Acquire) {
                    let _ = child
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .kill();
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        })
    }

    fn publish_bgra_frame(
        shared: &Arc<StdMutex<PreviewCameraShared>>,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    ) -> Vec<u8> {
        let callback_started_at = Instant::now();
        let publish_started_at = Instant::now();
        let frame_len = bytes.len();
        let frame_bytes = frame_len as u64;
        let mut guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .capture_timings
            .record_callback_at(callback_started_at);
        let now = Instant::now();
        guard.frames_captured = guard.frames_captured.saturating_add(1);
        guard.frames_in_window = guard.frames_in_window.saturating_add(1);
        let window_started = *guard.window_started_at.get_or_insert(now);
        let elapsed = window_started.elapsed();
        if elapsed >= Duration::from_millis(500) {
            guard.source_fps =
                Some(guard.frames_in_window as f64 / elapsed.as_secs_f64().max(0.001));
            guard.frames_in_window = 0;
            guard.window_started_at = Some(now);
        }
        let sequence = guard.frames_captured;
        guard.frame_store.publish_with_metadata(
            sequence,
            width,
            height,
            PreviewCameraPixelFormat::Bgra8,
            (),
            now,
            bytes,
        );
        let next_buffer = guard.frame_store.checkout_overwrite_buffer(frame_len);
        let publish_ms = publish_started_at.elapsed().as_secs_f64() * 1000.0;
        guard
            .capture_timings
            .record_valid_frame(0.0, 0.0, publish_ms, frame_bytes);
        next_buffer
    }

    fn stderr_suffix(stderr: &Arc<StdMutex<Vec<u8>>>) -> String {
        let bytes = stderr
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let message = String::from_utf8_lossy(&bytes).trim().to_string();
        if message.is_empty() {
            String::new()
        } else {
            format!(": {message}")
        }
    }
}

/// NV12 (4:2:0 bi-planar Y'CbCr) -> BGRA, parallelized across output rows.
///
/// The conversion is platform-neutral even though AVFoundation is currently
/// its only production caller. Keeping it outside the macOS module makes the
/// pixel seam available to future Linux PipeWire capture without importing an
/// Apple framework module.
#[allow(clippy::too_many_arguments)]
fn nv12_to_bgra(
    y: &[u8],
    y_stride: usize,
    cbcr: &[u8],
    cbcr_stride: usize,
    width: usize,
    height: usize,
    full_range: bool,
    out: &mut [u8],
) {
    let row_bytes = width * 4;
    out.par_chunks_mut(row_bytes)
        .enumerate()
        .for_each(|(row, out_row)| {
            if row >= height {
                return;
            }
            let y_row = &y[row * y_stride..];
            let cbcr_row = &cbcr[(row / 2) * cbcr_stride..];
            for (x, pixel) in out_row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let chroma = (x / 2) * 2;
                let (b, g, r) = if full_range {
                    ycbcr_bt709_full_to_bgr(y_row[x], cbcr_row[chroma], cbcr_row[chroma + 1])
                } else {
                    ycbcr_bt709_video_to_bgr(y_row[x], cbcr_row[chroma], cbcr_row[chroma + 1])
                };
                pixel[0] = b;
                pixel[1] = g;
                pixel[2] = r;
                pixel[3] = 255;
            }
        });
}

/// Packed 4:2:2 Y'CbCr -> BGRA, parallelized by row. `uyvy` selects the byte
/// order: UYVY (`2vuy`, Cb Y0 Cr Y1) when true, YUY2 (`yuvs`, Y0 Cb Y1 Cr)
/// when false.
fn yuv422_to_bgra(
    plane: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    uyvy: bool,
    out: &mut [u8],
) {
    let row_bytes = width * 4;
    out.par_chunks_mut(row_bytes)
        .enumerate()
        .for_each(|(row, out_row)| {
            if row >= height {
                return;
            }
            let src = &plane[row * stride..];
            for (pair, out8) in out_row.as_chunks_mut::<8>().0.iter_mut().enumerate() {
                let i = pair * 4;
                let (cb, y0, cr, y1) = if uyvy {
                    (src[i], src[i + 1], src[i + 2], src[i + 3])
                } else {
                    (src[i + 1], src[i], src[i + 3], src[i + 2])
                };
                let (b0, g0, r0) = ycbcr_bt709_video_to_bgr(y0, cb, cr);
                let (b1, g1, r1) = ycbcr_bt709_video_to_bgr(y1, cb, cr);
                out8[0] = b0;
                out8[1] = g0;
                out8[2] = r0;
                out8[3] = 255;
                out8[4] = b1;
                out8[5] = g1;
                out8[6] = r1;
                out8[7] = 255;
            }
        });
}

#[cfg(target_os = "macos")]
mod macos {
    use std::slice;

    use super::*;
    use crate::camera_capture::{
        CameraFormatSummary, NativeCameraPermission, choose_camera_format,
    };
    use dispatch2::DispatchQueue;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceFormat,
        AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
        AVCaptureSessionPresetInputPriority, AVCaptureVideoDataOutput,
        AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeVideo,
    };
    use objc2_core_foundation::{CFString, CFType};
    use objc2_core_media::{
        CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetDimensions,
        kCMSampleBufferAttachmentKey_DroppedFrameReason,
        kCMSampleBufferDroppedFrameReason_Discontinuity,
        kCMSampleBufferDroppedFrameReason_FrameWasLate,
        kCMSampleBufferDroppedFrameReason_OutOfBuffers,
    };
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBaseAddressOfPlane,
        CVPixelBufferGetBytesPerRow, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
        CVPixelBufferGetHeightOfPlane, CVPixelBufferGetPixelFormatType, CVPixelBufferGetPlaneCount,
        CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
        CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey,
        kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_422YpCbCr8,
        kCVPixelFormatType_422YpCbCr8_yuvs,
    };
    use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

    unsafe extern "C-unwind" {
        /// Borrow an existing CoreMedia attachment without retaining or allocating on the
        /// AVFoundation callback queue. objc2-core-media gates its owning wrapper behind the
        /// optional CMAttachment feature, so keep this narrow declaration local.
        #[link_name = "CMGetAttachment"]
        fn cm_get_attachment_borrowed(
            target: &CFType,
            key: &CFString,
            attachment_mode_out: *mut u32,
        ) -> *const CFType;
    }

    struct CameraDelegateIvars {
        shared: Arc<StdMutex<PreviewCameraShared>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[ivars = CameraDelegateIvars]
        struct CameraPreviewDelegate;

        unsafe impl NSObjectProtocol for CameraPreviewDelegate {}

        unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for CameraPreviewDelegate {
            #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
            fn capture_output(
                &self,
                _output: &AVCaptureOutput,
                sample_buffer: &CMSampleBuffer,
                _connection: &AVCaptureConnection,
            ) {
                copy_sample_buffer(sample_buffer, &self.ivars().shared);
            }

            #[unsafe(method(captureOutput:didDropSampleBuffer:fromConnection:))]
            fn capture_drop(
                &self,
                _output: &AVCaptureOutput,
                sample_buffer: &CMSampleBuffer,
                _connection: &AVCaptureConnection,
            ) {
                let reason = capture_drop_reason(sample_buffer);
                let mut guard = self
                    .ivars()
                    .shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.dropped_frames = guard.dropped_frames.saturating_add(1);
                guard.capture_drop_reasons.record(reason);
            }
        }
    );

    impl CameraPreviewDelegate {
        fn new(shared: Arc<StdMutex<PreviewCameraShared>>) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(CameraDelegateIvars { shared });
            unsafe { msg_send![super(delegate), init] }
        }
    }

    fn capture_drop_reason(sample_buffer: &CMSampleBuffer) -> CameraCaptureDropReason {
        // SAFETY: CMSampleBuffer is a CoreFoundation attachment bearer. AVFoundation owns both the
        // sample buffer and its attachment throughout this callback, so the borrowed attachment is
        // valid for these bounded type/constant comparisons.
        let bearer = unsafe { &*(std::ptr::from_ref(sample_buffer).cast::<CFType>()) };
        let reason = unsafe {
            cm_get_attachment_borrowed(
                bearer,
                kCMSampleBufferAttachmentKey_DroppedFrameReason,
                std::ptr::null_mut(),
            )
        };
        classify_capture_drop_reason_value(unsafe { reason.as_ref() })
    }

    pub(super) fn classify_capture_drop_reason_value(
        reason: Option<&CFType>,
    ) -> CameraCaptureDropReason {
        let Some(reason) = reason else {
            return CameraCaptureDropReason::Unknown;
        };
        let Some(reason) = reason.downcast_ref::<CFString>() else {
            return CameraCaptureDropReason::Unknown;
        };
        if reason == unsafe { kCMSampleBufferDroppedFrameReason_FrameWasLate } {
            CameraCaptureDropReason::FrameWasLate
        } else if reason == unsafe { kCMSampleBufferDroppedFrameReason_OutOfBuffers } {
            CameraCaptureDropReason::OutOfBuffers
        } else if reason == unsafe { kCMSampleBufferDroppedFrameReason_Discontinuity } {
            CameraCaptureDropReason::Discontinuity
        } else {
            CameraCaptureDropReason::Unknown
        }
    }

    pub fn run_native_camera_preview(
        config: NativeCameraPreviewConfig,
        shared: Arc<StdMutex<PreviewCameraShared>>,
        stop_rx: std_mpsc::Receiver<()>,
        startup_tx: std_mpsc::Sender<NativeCameraStartup>,
    ) {
        autoreleasepool(|_| match start_session(config, Arc::clone(&shared)) {
            Ok(session) => {
                let _ = startup_tx.send(NativeCameraStartup::Live {
                    requested_width: session.requested_width,
                    requested_height: session.requested_height,
                    selected_format_width: session.selected_format_width,
                    selected_format_height: session.selected_format_height,
                    selected_format_min_fps: session.selected_format_min_fps,
                    selected_format_max_fps: session.selected_format_max_fps,
                    width: session.width,
                    height: session.height,
                    selected_fps: session.selected_fps,
                    message: session.message,
                });
                let _ = stop_rx.recv();
                unsafe {
                    session.session.stopRunning();
                    session.output.setSampleBufferDelegate_queue(None, None);
                }
            }
            Err(error) => {
                let _ = startup_tx.send(error);
            }
        });
    }

    struct CameraSession {
        session: Retained<AVCaptureSession>,
        output: Retained<AVCaptureVideoDataOutput>,
        _input: Retained<AVCaptureDeviceInput>,
        _delegate: Retained<CameraPreviewDelegate>,
        _queue: dispatch2::DispatchRetained<DispatchQueue>,
        requested_width: u32,
        requested_height: u32,
        selected_format_width: u32,
        selected_format_height: u32,
        selected_format_min_fps: f64,
        selected_format_max_fps: f64,
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    }

    fn start_session(
        config: NativeCameraPreviewConfig,
        shared: Arc<StdMutex<PreviewCameraShared>>,
    ) -> Result<CameraSession, NativeCameraStartup> {
        let permission = native_camera_permission();
        if permission != NativeCameraPermission::Authorized {
            return Err(NativeCameraStartup::PermissionNeeded(
                permission_message(permission).to_string(),
            ));
        }

        let unique_id = NSString::from_str(&config.unique_id);
        let Some(device) = (unsafe { AVCaptureDevice::deviceWithUniqueID(&unique_id) }) else {
            return Err(NativeCameraStartup::DeviceMissing(format!(
                "Camera device is missing: {}",
                config.camera_id
            )));
        };

        let selected =
            select_camera_format(&device, &config.layout, &config.video).ok_or_else(|| {
                NativeCameraStartup::Failed("Camera did not report usable formats.".to_string())
            })?;
        let configured_fps = configure_device(&device, &selected, config.video.fps)?;

        let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }.map_err(
            |error| NativeCameraStartup::Failed(format!("Could not open camera: {error}")),
        )?;
        let session = unsafe { AVCaptureSession::new() };
        let output = unsafe { AVCaptureVideoDataOutput::new() };
        let delegate = CameraPreviewDelegate::new(shared);
        // Camera delivery feeds the live preview and the recording. Under
        // system load (2026-08-31 field capture: load ~10/10 cores, camera
        // delivered 17fps into a healthy callback) the default QoS lets
        // macOS starve capture before our own encode/diagnostics work.
        // Targeting the UserInitiated global queue at CREATION confers that
        // QoS; a property setter after creation is a libdispatch client bug
        // that SIGTRAPs on every camera start (the 0.9.88 crash loop —
        // "dispatch queue property setter called after activation").
        let queue = DispatchQueue::new_with_target(
            "com.videorc.preview.camera",
            None,
            Some(&DispatchQueue::global_queue(
                dispatch2::GlobalQueueIdentifier::QualityOfService(
                    dispatch2::DispatchQoS::UserInitiated,
                ),
            )),
        );

        // AVCaptureSession mutators (`addInput`/`addOutput`/`startRunning`) can also
        // raise NSExceptions for sources AVFoundation refuses; guard them so a
        // refusal fails the camera gracefully instead of aborting the backend.
        let session_result = unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                session.beginConfiguration();
                if session.canSetSessionPreset(AVCaptureSessionPresetInputPriority) {
                    session.setSessionPreset(AVCaptureSessionPresetInputPriority);
                }
                // VIDEORC_CAMERA_NATIVE_FORMAT=1 opts the camera out of the
                // BGRA zero-copy preference: the device's native YUV wire
                // format halves-or-better the per-frame bytes crossing the
                // system CMIO/XPC camera path AND removes the system-side
                // format conversion (UVCAssistant measured at 45% CPU
                // converting for us, 2026-08-31). Our own CPU converter
                // takes over; A/B with the self_cpu telemetry before making
                // it the default via Metal YUV ingestion.
                let camera_native_format_override =
                    std::env::var("VIDEORC_CAMERA_NATIVE_FORMAT").as_deref() == Ok("1");
                let prefer_zero_copy_source_format =
                    crate::metal_compositor::source_zerocopy_enabled()
                        && !camera_native_format_override;
                let capture_pixel_format =
                    preferred_capture_pixel_format(&output, prefer_zero_copy_source_format);
                tracing::info!(
                    "Native camera capture pixel format: {} ({})",
                    format_fourcc(capture_pixel_format),
                    if capture_pixel_format == kCVPixelFormatType_32BGRA {
                        "BGRA, zero-copy source import"
                    } else {
                        "Y'CbCr, reduced bandwidth"
                    }
                );
                set_capture_video_settings(
                    &output,
                    capture_pixel_format,
                    selected.output_width,
                    selected.output_height,
                );
                output.setAlwaysDiscardsLateVideoFrames(true);
                output.setSampleBufferDelegate_queue(
                    Some(ProtocolObject::from_ref(&*delegate)),
                    Some(&queue),
                );
                if !session.canAddInput(&input) {
                    session.commitConfiguration();
                    return Err(NativeCameraStartup::Failed(
                        "AVFoundation refused the camera input.".to_string(),
                    ));
                }
                session.addInput(&input);
                if !session.canAddOutput(&output) {
                    session.commitConfiguration();
                    return Err(NativeCameraStartup::Failed(
                        "AVFoundation refused the camera preview output.".to_string(),
                    ));
                }
                session.addOutput(&output);
                session.commitConfiguration();
                session.startRunning();
                Ok(negotiated_camera_fps(
                    active_camera_fps(&device),
                    Some(configured_fps),
                    selected.format.max_fps,
                ))
            }))
        };
        let negotiated_fps = match session_result {
            Err(exception) => {
                return Err(NativeCameraStartup::Failed(format!(
                    "Camera capture session was rejected by AVFoundation: {}",
                    describe_camera_exception(exception)
                )));
            }
            Ok(Err(startup)) => return Err(startup),
            Ok(Ok(negotiated_fps)) => negotiated_fps,
        };

        let layout_detail = layout_detail(&config.layout);
        let message = selected
            .fallback_reason
            .map(|reason| format!("{reason} {layout_detail}"))
            .or_else(|| {
                Some(format!(
                    "Native camera preview running with {}x{} at {:.0} fps. {layout_detail}",
                    selected.output_width, selected.output_height, negotiated_fps
                ))
            });

        Ok(CameraSession {
            session,
            output,
            _input: input,
            _delegate: delegate,
            _queue: queue,
            requested_width: selected.requested_width,
            requested_height: selected.requested_height,
            selected_format_width: selected.format.width,
            selected_format_height: selected.format.height,
            selected_format_min_fps: selected.format.min_fps,
            selected_format_max_fps: selected.format.max_fps,
            width: selected.output_width,
            height: selected.output_height,
            selected_fps: negotiated_fps,
            message,
        })
    }

    struct NativeCameraFormatSelection {
        format: CameraFormatSummary,
        native_format: Retained<AVCaptureDeviceFormat>,
        requested_width: u32,
        requested_height: u32,
        output_width: u32,
        output_height: u32,
        fallback_reason: Option<String>,
    }

    fn select_camera_format(
        camera: &AVCaptureDevice,
        layout: &LayoutSettings,
        video: &VideoSettings,
    ) -> Option<NativeCameraFormatSelection> {
        let formats = unsafe { camera.formats() };
        let mut entries = Vec::new();

        for index in 0..formats.count() {
            let native_format = formats.objectAtIndex(index);
            let description = unsafe { native_format.formatDescription() };
            let dimensions = unsafe { CMVideoFormatDescriptionGetDimensions(&description) };
            let ranges = unsafe { native_format.videoSupportedFrameRateRanges() };
            for range_index in 0..ranges.count() {
                let range = ranges.objectAtIndex(range_index);
                entries.push((
                    CameraFormatSummary {
                        width: dimensions.width.max(0) as u32,
                        height: dimensions.height.max(0) as u32,
                        min_fps: unsafe { range.minFrameRate() },
                        max_fps: unsafe { range.maxFrameRate() },
                    },
                    native_format.clone(),
                ));
            }
        }

        let summaries = entries
            .iter()
            .map(|(summary, _)| summary.clone())
            .collect::<Vec<_>>();
        let (target_width, target_height) = camera_capture_target_dimensions(layout, video);
        let choice = choose_camera_format(&summaries, target_width, target_height, video.fps)?;
        let selected_entry = entries
            .into_iter()
            .find(|(summary, _)| *summary == choice.format)?;
        let (output_width, output_height) = fit_camera_source_in_target_box(
            selected_entry.0.width,
            selected_entry.0.height,
            target_width,
            target_height,
        );

        Some(NativeCameraFormatSelection {
            format: selected_entry.0,
            native_format: selected_entry.1,
            requested_width: target_width,
            requested_height: target_height,
            output_width,
            output_height,
            fallback_reason: choice.fallback_reason,
        })
    }

    fn configure_device(
        device: &AVCaptureDevice,
        format: &NativeCameraFormatSelection,
        requested_fps: u32,
    ) -> Result<f64, NativeCameraStartup> {
        unsafe { device.lockForConfiguration() }.map_err(|error| {
            NativeCameraStartup::Failed(format!("Could not configure camera: {error}"))
        })?;

        // `setActiveFormat` and the frame-duration setters raise Objective-C
        // NSExceptions for inputs the device rejects — capture cards such as the
        // Cam Link 4K only run at a fixed fractional rate (e.g. 59.94fps), so an
        // integer frame duration like 1/60 is "not supported". A foreign exception
        // unwinding into Rust aborts the entire backend (SIGABRT), so every
        // throwing call is guarded with `objc2::exception::catch`. The active format
        // is essential (fail gracefully if rejected); the frame-duration is
        // best-effort (keep the device's native cadence if rejected).
        let format_result = unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                device.setActiveFormat(&format.native_format)
            }))
        };
        if let Err(exception) = format_result {
            unsafe { device.unlockForConfiguration() };
            return Err(NativeCameraStartup::Failed(format!(
                "Camera rejected the selected {}x{} format: {}",
                format.output_width,
                format.output_height,
                describe_camera_exception(exception)
            )));
        }

        // Resolve the requested rate against the ACTIVE format's own advertised
        // ranges, and at a range endpoint request the range's own CMTime
        // verbatim — AVFoundation validates the duration against those
        // rationals exactly, so no decimal approximation of a fractional
        // endpoint (29.97, 30.00003) survives the comparison.
        let ranges = unsafe { format.native_format.videoSupportedFrameRateRanges() };
        let range_bounds = (0..ranges.count())
            .map(|index| {
                let range = ranges.objectAtIndex(index);
                unsafe { (range.minFrameRate(), range.maxFrameRate()) }
            })
            .collect::<Vec<_>>();
        tracing::info!(
            "Camera capture configured: {}x{} (requested {}x{}), advertised ranges {:?}, requesting {} fps",
            format.format.width,
            format.format.height,
            format.requested_width,
            format.requested_height,
            range_bounds,
            requested_fps,
        );
        let mut applied_fps = None;
        if let Some(resolution) = resolve_camera_frame_rate(requested_fps, &range_bounds) {
            let range = ranges.objectAtIndex(resolution.range_index);
            let frame_duration = match resolution.endpoint {
                CameraFrameRateEndpoint::RangeMax => unsafe { range.minFrameDuration() },
                CameraFrameRateEndpoint::RangeMin => unsafe { range.maxFrameDuration() },
                CameraFrameRateEndpoint::Interior => {
                    // Nanosecond timescale keeps an interior rate within any
                    // range wide enough to contain it.
                    let timescale = 1_000_000_000_i32;
                    let value = (f64::from(timescale) / resolution.effective_fps).round() as i64;
                    unsafe { CMTime::new(value.max(1), timescale) }
                }
            };
            let effective_fps = resolution.effective_fps;
            let frame_rate_result = unsafe {
                objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                    device.setActiveVideoMinFrameDuration(frame_duration);
                    device.setActiveVideoMaxFrameDuration(frame_duration);
                }))
            };
            if let Err(exception) = frame_rate_result {
                tracing::warn!(
                    "Camera kept its native frame cadence ({effective_fps:.3} fps frame duration was rejected): {}",
                    describe_camera_exception(exception)
                );
            } else {
                tracing::info!(
                    "Camera frame duration set: {effective_fps:.3} fps ({:?} of range {})",
                    resolution.endpoint,
                    resolution.range_index,
                );
                applied_fps = Some(effective_fps);
            }
        }

        let negotiated_fps = negotiated_camera_fps(
            active_camera_fps(device),
            applied_fps,
            format.format.max_fps,
        );
        unsafe { device.unlockForConfiguration() };
        Ok(negotiated_fps)
    }

    fn active_camera_fps(device: &AVCaptureDevice) -> Option<f64> {
        unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                let seconds = device.activeVideoMinFrameDuration().seconds();
                if seconds.is_finite() && seconds > 0.0 {
                    Some(1.0 / seconds)
                } else {
                    None
                }
            }))
        }
        .ok()
        .flatten()
    }

    /// Format an Objective-C exception caught around an AVFoundation call into a
    /// human-readable reason (name + reason), for diagnostics instead of a crash.
    fn describe_camera_exception(
        exception: Option<objc2::rc::Retained<objc2::exception::Exception>>,
    ) -> String {
        match exception {
            Some(exception) => format!("{exception:?}"),
            None => "unknown Objective-C exception".to_string(),
        }
    }

    /// Whether a capture pixel format is a Y'CbCr format the conversion path handles.
    fn is_yuv_capture_format(format: u32) -> bool {
        format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || format == kCVPixelFormatType_422YpCbCr8
            || format == kCVPixelFormatType_422YpCbCr8_yuvs
    }

    /// Pick the best capture pixel format for the current source import mode.
    /// Source zero-copy needs a BGRA CoreVideo texture view today; otherwise keep the
    /// previous bandwidth-efficient Y'CbCr preference.
    fn preferred_capture_pixel_format(
        output: &AVCaptureVideoDataOutput,
        prefer_zero_copy_source_format: bool,
    ) -> u32 {
        let available = unsafe { output.availableVideoCVPixelFormatTypes() };
        let formats: Vec<u32> = (0..available.count())
            .map(|index| available.objectAtIndex(index).unsignedIntValue())
            .collect();
        tracing::info!(
            "Camera advertises capture formats (native first): {}",
            formats
                .iter()
                .map(|format| format_fourcc(*format))
                .collect::<Vec<_>>()
                .join(", ")
        );
        select_preferred_capture_pixel_format(&formats, prefer_zero_copy_source_format)
    }

    /// Pick the best capture pixel format from an advertised list.
    /// 4:2:0 / 4:2:2 Y'CbCr are ~3/8 and ~1/2 the bytes of BGRA, so a bandwidth-limited
    /// USB capture card (e.g. a Cam Link 4K at 4K) can deliver more frames per second.
    /// `availableVideoCVPixelFormatTypes` is ordered most-efficient-first, so without
    /// source zero-copy the first entry is the device's native wire format. Requesting a
    /// *non*-native format forces a slow host conversion (NV12 on a 4:2:2 card drops it
    /// to a few fps), so we take the first advertised format we can convert ourselves;
    /// BGRA only if no YUV is offered.
    pub(super) fn select_preferred_capture_pixel_format(
        formats: &[u32],
        prefer_zero_copy_source_format: bool,
    ) -> u32 {
        if prefer_zero_copy_source_format && formats.contains(&kCVPixelFormatType_32BGRA) {
            return kCVPixelFormatType_32BGRA;
        }
        formats
            .iter()
            .copied()
            .find(|format| is_yuv_capture_format(*format))
            .unwrap_or(kCVPixelFormatType_32BGRA)
    }

    unsafe fn set_capture_video_settings(
        output: &AVCaptureVideoDataOutput,
        pixel_format_type: u32,
        width: u32,
        height: u32,
    ) {
        let pixel_format_key: &NSString =
            unsafe { &*(kCVPixelBufferPixelFormatTypeKey as *const _ as *const NSString) };
        let width_key: &NSString =
            unsafe { &*(kCVPixelBufferWidthKey as *const _ as *const NSString) };
        let height_key: &NSString =
            unsafe { &*(kCVPixelBufferHeightKey as *const _ as *const NSString) };
        let pixel_format = NSNumber::new_u32(pixel_format_type);
        let width = NSNumber::new_u32(width);
        let height = NSNumber::new_u32(height);
        let settings = NSDictionary::<NSString, NSNumber>::from_slices(
            &[pixel_format_key, width_key, height_key],
            &[&pixel_format, &width, &height],
        );
        let settings = unsafe { settings.cast_unchecked::<NSString, AnyObject>() };
        unsafe {
            output.setVideoSettings(Some(settings));
        }
    }

    fn copy_sample_buffer(
        sample_buffer: &CMSampleBuffer,
        shared: &Arc<StdMutex<PreviewCameraShared>>,
    ) {
        let callback_started_at = Instant::now();
        let sample_pts_seconds =
            cm_time_seconds(unsafe { sample_buffer.presentation_time_stamp() });
        {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard
                .capture_timings
                .record_callback_at(callback_started_at);
            guard.capture_timings.record_sample_pts(sample_pts_seconds);
            guard.capture_callback_count = guard.capture_callback_count.saturating_add(1);
        }

        let Some(pixel_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        };

        let pixel_format = CVPixelBufferGetPixelFormatType(&pixel_buffer);
        if !is_supported_capture_format(pixel_format) {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let width = CVPixelBufferGetWidth(&pixel_buffer) as u32;
        let height = CVPixelBufferGetHeight(&pixel_buffer) as u32;

        if width == 0 || height == 0 {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let width_usize = width as usize;
        let height_usize = height as usize;
        let row_bytes = width_usize * 4;
        let frame_bytes = row_bytes * height_usize;
        let source_zerocopy_enabled = crate::metal_compositor::source_zerocopy_enabled();
        let source_pixel_buffer =
            if source_zerocopy_enabled && pixel_format == kCVPixelFormatType_32BGRA {
                Some(crate::frame_store::RetainedPixelBuffer::new(
                    pixel_buffer.clone(),
                ))
            } else {
                None
            };
        let skip_cpu_copy = should_skip_camera_capture_cpu_copy(source_pixel_buffer.is_some());
        let (bytes, pixel_buffer_lock_ms, row_copy_ms) = if skip_cpu_copy {
            (Vec::new(), 0.0, 0.0)
        } else {
            let lock_started_at = Instant::now();
            let lock_result = unsafe {
                CVPixelBufferLockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
            };
            let pixel_buffer_lock_ms = lock_started_at.elapsed().as_secs_f64() * 1000.0;
            if lock_result != 0 {
                let mut guard = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.dropped_frames = guard.dropped_frames.saturating_add(1);
                return;
            }

            let mut bytes = {
                let mut guard = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(buffer) = guard.frame_store.checkout_spare_buffer(frame_bytes) {
                    buffer
                } else {
                    guard.frame_store.record_buffer_allocation();
                    drop(guard);
                    vec![0; frame_bytes]
                }
            };

            // Fill `bytes` with BGRA, converting from whichever pixel format the device
            // delivers (BGRA passthrough, or NV12 / UYVY Y'CbCr -> BGRA). The downstream
            // pipeline stays BGRA, so only this fill changes per format.
            let copy_started_at = Instant::now();
            let filled = unsafe {
                fill_bgra_from_pixel_buffer(
                    &pixel_buffer,
                    pixel_format,
                    width_usize,
                    height_usize,
                    &mut bytes,
                )
            };
            let row_copy_ms = copy_started_at.elapsed().as_secs_f64() * 1000.0;
            unsafe {
                CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
            }
            if !filled {
                let mut guard = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.dropped_frames = guard.dropped_frames.saturating_add(1);
                return;
            }
            (bytes, pixel_buffer_lock_ms, row_copy_ms)
        };

        let publish_started_at = Instant::now();
        let mut guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        guard.frames_captured = guard.frames_captured.saturating_add(1);
        guard.capture_pixel_format = Some(pixel_format);
        guard.frames_in_window = guard.frames_in_window.saturating_add(1);
        let window_started = *guard.window_started_at.get_or_insert(now);
        let elapsed = window_started.elapsed();
        if elapsed >= Duration::from_millis(500) {
            guard.source_fps =
                Some(guard.frames_in_window as f64 / elapsed.as_secs_f64().max(0.001));
            guard.frames_in_window = 0;
            guard.window_started_at = Some(now);
        }
        let sequence = guard.frames_captured;
        guard.frame_store.publish_with_source_handles(
            sequence,
            width,
            height,
            PreviewCameraPixelFormat::Bgra8,
            now,
            bytes,
            None,
            source_pixel_buffer,
        );
        let publish_ms = publish_started_at.elapsed().as_secs_f64() * 1000.0;
        guard.capture_timings.record_valid_frame(
            pixel_buffer_lock_ms,
            row_copy_ms,
            publish_ms,
            frame_bytes as u64,
        );
    }

    /// Render a CoreVideo pixel-format OSType as its FourCC string (e.g. `420v`).
    pub(super) fn format_fourcc(format: u32) -> String {
        String::from_utf8_lossy(&format.to_be_bytes()).into_owned()
    }

    /// Capture pixel formats the conversion path can turn into BGRA.
    fn is_supported_capture_format(format: u32) -> bool {
        format == kCVPixelFormatType_32BGRA || is_yuv_capture_format(format)
    }

    /// Fill `out` (width*height*4 BGRA) from a locked capture `CVPixelBuffer`,
    /// converting Y'CbCr (NV12 / UYVY) to BGRA when needed. Returns false if the
    /// buffer's planes are unexpectedly missing. The caller holds the buffer lock.
    unsafe fn fill_bgra_from_pixel_buffer(
        pixel_buffer: &CVPixelBuffer,
        pixel_format: u32,
        width: usize,
        height: usize,
        out: &mut [u8],
    ) -> bool {
        if pixel_format == kCVPixelFormatType_32BGRA {
            let base = CVPixelBufferGetBaseAddress(pixel_buffer);
            if base.is_null() {
                return false;
            }
            let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
            let row_bytes = width * 4;
            let source = base.cast::<u8>();
            for row in 0..height {
                let source_row =
                    unsafe { slice::from_raw_parts(source.add(row * stride), row_bytes) };
                out[row * row_bytes..(row + 1) * row_bytes].copy_from_slice(source_row);
            }
            return true;
        }

        if pixel_format == kCVPixelFormatType_422YpCbCr8
            || pixel_format == kCVPixelFormatType_422YpCbCr8_yuvs
        {
            let base = CVPixelBufferGetBaseAddress(pixel_buffer);
            if base.is_null() {
                return false;
            }
            let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
            let plane = unsafe { slice::from_raw_parts(base.cast::<u8>(), stride * height) };
            // '2vuy' is UYVY (Cb Y0 Cr Y1); 'yuvs' is YUY2 (Y0 Cb Y1 Cr).
            let uyvy = pixel_format == kCVPixelFormatType_422YpCbCr8;
            yuv422_to_bgra(plane, stride, width, height, uyvy, out);
            return true;
        }

        // Bi-planar NV12: plane 0 = Y, plane 1 = interleaved CbCr (Cb, Cr, ...).
        if CVPixelBufferGetPlaneCount(pixel_buffer) < 2 {
            return false;
        }
        let full_range = pixel_format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
        let y_base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 0);
        let cbcr_base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 1);
        if y_base.is_null() || cbcr_base.is_null() {
            return false;
        }
        let y_stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 0);
        let cbcr_stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 1);
        let y_height = CVPixelBufferGetHeightOfPlane(pixel_buffer, 0);
        let cbcr_height = CVPixelBufferGetHeightOfPlane(pixel_buffer, 1);
        let y = unsafe { slice::from_raw_parts(y_base.cast::<u8>(), y_stride * y_height) };
        let cbcr =
            unsafe { slice::from_raw_parts(cbcr_base.cast::<u8>(), cbcr_stride * cbcr_height) };
        nv12_to_bgra(
            y,
            y_stride,
            cbcr,
            cbcr_stride,
            width,
            height,
            full_range,
            out,
        );
        true
    }

    fn cm_time_seconds(time: CMTime) -> Option<f64> {
        let seconds = unsafe { time.seconds() };
        seconds.is_finite().then_some(seconds)
    }

    fn native_camera_permission() -> NativeCameraPermission {
        let Some(video_media_type) = (unsafe { AVMediaTypeVideo }) else {
            return NativeCameraPermission::Unknown;
        };
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(video_media_type) } {
            status if status == AVAuthorizationStatus::Authorized => {
                NativeCameraPermission::Authorized
            }
            status if status == AVAuthorizationStatus::NotDetermined => {
                NativeCameraPermission::NotDetermined
            }
            status if status == AVAuthorizationStatus::Denied => NativeCameraPermission::Denied,
            status if status == AVAuthorizationStatus::Restricted => {
                NativeCameraPermission::Restricted
            }
            _ => NativeCameraPermission::Unknown,
        }
    }

    fn permission_message(permission: NativeCameraPermission) -> &'static str {
        match permission {
            NativeCameraPermission::Authorized => "Camera permission is authorized.",
            NativeCameraPermission::NotDetermined => "Camera permission has not been granted yet.",
            NativeCameraPermission::Denied => "Camera permission is denied.",
            NativeCameraPermission::Restricted => "Camera permission is restricted by macOS.",
            NativeCameraPermission::Unknown => "Camera permission state is unknown.",
        }
    }

    fn layout_detail(layout: &LayoutSettings) -> String {
        format!(
            "Layout preserves {:?} fit, mirror {}, zoom {}%.",
            layout.camera_fit,
            if layout.camera_mirror { "on" } else { "off" },
            layout.camera_zoom
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode, LayoutPreset,
        SideBySideCameraSide, SideBySideSplit, VideoPreset,
    };
    use crate::storage::Database;
    use tokio::sync::{broadcast, oneshot};

    #[test]
    fn capture_drop_reason_counts_preserve_every_bucket() {
        let mut counts = CameraCaptureDropReasonCounts::default();
        for reason in [
            CameraCaptureDropReason::FrameWasLate,
            CameraCaptureDropReason::OutOfBuffers,
            CameraCaptureDropReason::Discontinuity,
            CameraCaptureDropReason::Unknown,
        ] {
            counts.record(reason);
        }

        assert_eq!(counts.frame_was_late, 1);
        assert_eq!(counts.out_of_buffers, 1);
        assert_eq!(counts.discontinuity, 1);
        assert_eq!(counts.unknown, 1);
        assert_eq!(counts.total(), 4);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_drop_reason_classifies_every_apple_fixture() {
        use objc2_core_foundation::{CFString, CFType};
        use objc2_core_media::{
            kCMSampleBufferAttachmentKey_DroppedFrameReason,
            kCMSampleBufferDroppedFrameReason_Discontinuity,
            kCMSampleBufferDroppedFrameReason_FrameWasLate,
            kCMSampleBufferDroppedFrameReason_OutOfBuffers,
        };

        fn as_cf_type(value: &CFString) -> &CFType {
            // SAFETY: Every concrete CoreFoundation value has the CFType root representation.
            unsafe { &*(std::ptr::from_ref(value).cast::<CFType>()) }
        }

        for (value, expected) in [
            (
                unsafe { kCMSampleBufferDroppedFrameReason_FrameWasLate },
                CameraCaptureDropReason::FrameWasLate,
            ),
            (
                unsafe { kCMSampleBufferDroppedFrameReason_OutOfBuffers },
                CameraCaptureDropReason::OutOfBuffers,
            ),
            (
                unsafe { kCMSampleBufferDroppedFrameReason_Discontinuity },
                CameraCaptureDropReason::Discontinuity,
            ),
            (
                unsafe { kCMSampleBufferAttachmentKey_DroppedFrameReason },
                CameraCaptureDropReason::Unknown,
            ),
        ] {
            assert_eq!(
                macos::classify_capture_drop_reason_value(Some(as_cf_type(value))),
                expected
            );
        }
        assert_eq!(
            macos::classify_capture_drop_reason_value(None),
            CameraCaptureDropReason::Unknown
        );
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn test_layout(camera_mirror: bool) -> LayoutSettings {
        LayoutSettings {
            layout_preset: LayoutPreset::CameraOnly,
            camera_transform_mode: CameraTransformMode::Preset,
            camera_transform: None,
            camera_corner: CameraCorner::TopRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Rectangle,
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
            camera_margin: 24,
            camera_fit: CameraFit::Fill,
            camera_mirror,
            camera_zoom: 100,
            camera_offset_x: 0,
            camera_offset_y: 0,
            side_by_side_split: SideBySideSplit::Even,
            side_by_side_camera_side: SideBySideCameraSide::Right,
            camera_chroma_key_enabled: false,
            camera_chroma_key_color: "#00FF00".to_string(),
            camera_chroma_key_similarity_pct: 40,
            camera_chroma_key_smoothness_pct: 8,
            camera_chroma_key_spill_pct: 10,
        }
    }

    fn test_video() -> VideoSettings {
        VideoSettings {
            preset: VideoPreset::Stream1080p60,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 9000,
        }
    }

    fn test_camera_start_key(
        source_key: SourceKey,
        layout: &LayoutSettings,
        video: &VideoSettings,
    ) -> PreviewCameraStartKey {
        PreviewCameraStartKey {
            source_key,
            ffmpeg_path: "ffmpeg".to_string(),
            video: video.clone(),
            target_fps: video.fps,
            capture_target: camera_capture_target_dimensions(layout, video),
        }
    }

    fn test_camera_starting_status(
        source_key: &SourceKey,
        video: &VideoSettings,
    ) -> PreviewCameraStatus {
        PreviewCameraStatus {
            state: PreviewCameraState::Starting,
            camera_id: Some(source_key.id.clone()),
            device_unique_id: Some("fake-supervisor".to_string()),
            target_fps: video.fps,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Starting fake native camera.".to_string()),
        }
    }

    fn test_camera_params(
        camera_id: Option<&str>,
        layout: &LayoutSettings,
        video: &VideoSettings,
    ) -> PreviewCameraStartParams {
        PreviewCameraStartParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: camera_id.map(str::to_string),
                microphone_id: None,
                test_pattern: false,
            },
            layout: layout.clone(),
            video: video.clone(),
            ffmpeg_path: Some("ffmpeg".to_string()),
        }
    }

    fn test_prepared_camera_start(
        source_key: &SourceKey,
        layout: &LayoutSettings,
        video: &VideoSettings,
        lease: PreviewCameraStartLease,
        layout_intent_id: Option<u64>,
    ) -> PreparedCameraStart {
        PreparedCameraStart {
            camera_id: source_key.id.clone(),
            device_unique_id: "fake-supervisor".to_string(),
            ffmpeg_path: "ffmpeg".to_string(),
            target_fps: video.fps,
            source_key: source_key.clone(),
            params: test_camera_params(Some(&source_key.id), layout, video),
            lease,
            layout_intent_id,
            recovery: None,
        }
    }

    async fn assert_queued_camera_supervisor_survives_owner_transfer(
        next_layout_intent_id: Option<u64>,
    ) {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:queued-owner-transfer");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        state.publish_latest_layout_intent_id(100);
        let held_transition = acquire_preview_camera_transition(&state).await;
        let lease = match begin_camera_start(
            &state,
            start_key.clone(),
            &layout,
            test_camera_starting_status(&source_key, &video),
            Some(100),
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("first layout must own the queued generation: {other:?}"),
        };
        let prepared =
            test_prepared_camera_start(&source_key, &layout, &video, lease.clone(), Some(100));
        let transition_gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let queued_state = state.clone();
        let (queued_tx, queued_rx) = oneshot::channel();
        let queued = tokio::spawn(async move {
            let mut transition = Box::pin(transition_gate.lock_owned());
            assert!(
                futures_util::poll!(&mut transition).is_pending(),
                "the held physical gate must queue the registered supervisor"
            );
            let _ = queued_tx.send(());
            let _transition = transition.await;
            ensure_registered_preview_camera_start_is_current(&queued_state, &prepared).await
        });
        queued_rx.await.expect("camera supervisor queued");

        {
            let _layout_admission = state.lock_layout_source_admission();
            state.publish_latest_layout_intent_id(101);
        }
        let transfer = begin_camera_start(
            &state,
            start_key,
            &layout,
            test_camera_starting_status(&source_key, &video),
            next_layout_intent_id,
        )
        .await;
        match next_layout_intent_id {
            Some(101) => assert!(matches!(
                transfer,
                PreviewCameraStartRegistration::JoinExisting {
                    admitted_starting_identity: Some(_),
                    ..
                }
            )),
            None => assert!(matches!(
                transfer,
                PreviewCameraStartRegistration::JoinExisting {
                    admitted_starting_identity: None,
                    ..
                }
            )),
            other => panic!("unexpected test owner transfer: {other:?}"),
        }

        drop(held_transition);
        tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .expect("queued camera supervisor must resume")
            .expect("queued camera supervisor task")
            .expect("owner transfer must preserve the registered generation");
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.start_generation, lease.generation);
        assert_eq!(slot.starting.as_ref(), Some(&lease.key));
        assert_eq!(slot.starting_layout_intent_id, next_layout_intent_id);
    }

    struct FakeNativeCameraControl {
        release_tx: std_mpsc::Sender<()>,
        stop_seen_rx: oneshot::Receiver<()>,
        exited_rx: oneshot::Receiver<()>,
    }

    async fn install_blocking_fake_native_camera(
        state: &AppState,
        live_sessions: Arc<AtomicUsize>,
        max_live_sessions: Arc<AtomicUsize>,
    ) -> FakeNativeCameraControl {
        let layout = test_layout(false);
        let video = test_video();
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        let (stop_tx, stop_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (stop_seen_tx, stop_seen_rx) = oneshot::channel();
        let (exited_tx, exited_rx) = oneshot::channel();
        let thread_live_sessions = Arc::clone(&live_sessions);
        let thread_max_live_sessions = Arc::clone(&max_live_sessions);
        let join_handle = thread::Builder::new()
            .name("videorc-test-fake-camera".to_string())
            .spawn(move || {
                let live = thread_live_sessions.fetch_add(1, Ordering::SeqCst) + 1;
                thread_max_live_sessions.fetch_max(live, Ordering::SeqCst);
                let _ = ready_tx.send(());
                let _ = stop_rx.recv();
                let _ = stop_seen_tx.send(());
                let _ = release_rx.recv();
                thread_live_sessions.fetch_sub(1, Ordering::SeqCst);
                let _ = exited_tx.send(());
            })
            .expect("spawn fake camera native thread");
        tokio::time::timeout(Duration::from_secs(1), ready_rx)
            .await
            .expect("fake native camera readiness deadline")
            .expect("fake native camera readiness sender");

        let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
        let mut slot = state.preview_camera.lock().await;
        slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
        let generation = slot.start_generation;
        slot.pending_stop_generation = None;
        slot.active_generation = Some(generation);
        slot.source_key = Some(source_key.clone());
        slot.status = PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: Some(source_key.id.clone()),
            device_unique_id: Some("fake-supervisor".to_string()),
            target_fps: video.fps,
            width: Some(video.width),
            height: Some(video.height),
            requested_width: Some(video.width),
            requested_height: Some(video.height),
            actual_width: Some(video.width),
            actual_height: Some(video.height),
            selected_format_width: Some(video.width),
            selected_format_height: Some(video.height),
            selected_format_min_fps: Some(f64::from(video.fps)),
            selected_format_max_fps: Some(f64::from(video.fps)),
            source_fps: Some(f64::from(video.fps)),
            frame_age_ms: Some(0),
            frames_captured: 1,
            dropped_frames: 0,
            sequence: Some(1),
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Fake native camera live.".to_string()),
        };
        slot.active = Some(NativeCameraPreviewThread {
            stop_tx,
            join_handle: Some(join_handle),
            shared,
            camera_id: source_key.id,
            device_unique_id: "fake-supervisor".to_string(),
            ffmpeg_path: "ffmpeg".to_string(),
            layout: layout.clone(),
            video: video.clone(),
            effective_fps: video.fps,
            configured_output: (video.width, video.height),
            capture_target: camera_capture_target_dimensions(&layout, &video),
        });
        drop(slot);

        FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        }
    }

    #[test]
    fn rejected_requested_duration_freezes_the_observed_native_camera_cadence() {
        let observed_fractional_fps = 60_000.0 / 1_001.0;
        let selected = negotiated_camera_fps(Some(observed_fractional_fps), None, 60.0);

        assert!((selected - observed_fractional_fps).abs() < f64::EPSILON);
        assert_ne!(
            selected, 60.0,
            "the rejected requested cadence must not leak"
        );
        assert_eq!(stable_effective_camera_fps(selected, 60), 60);
        assert_eq!(
            negotiated_camera_fps(None, None, observed_fractional_fps),
            observed_fractional_fps,
            "getter failure must fall back to the native format range, not the request"
        );
    }

    #[tokio::test]
    async fn same_key_camera_start_joins_while_the_physical_gate_is_busy() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        let transition_gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let physical_guard = transition_gate.lock_owned().await;

        let first = begin_camera_start(
            &state,
            start_key.clone(),
            &layout,
            test_camera_starting_status(&source_key, &video),
            None,
        )
        .await;
        let lease = match first {
            PreviewCameraStartRegistration::Started { lease, .. } => lease,
            PreviewCameraStartRegistration::JoinExisting { .. } => {
                panic!("first start must own")
            }
            PreviewCameraStartRegistration::Reused(_) => panic!("first start cannot reuse"),
            PreviewCameraStartRegistration::RejectedSuperseded(_)
            | PreviewCameraStartRegistration::RejectedShutdown(_) => {
                panic!("test process is not shutting down")
            }
        };
        let joined = tokio::time::timeout(
            Duration::from_millis(100),
            begin_camera_start(
                &state,
                start_key,
                &layout,
                test_camera_starting_status(&source_key, &video),
                None,
            ),
        )
        .await
        .expect("same-key admission must not wait for native teardown");
        assert!(matches!(
            joined,
            PreviewCameraStartRegistration::JoinExisting { .. }
        ));

        let stop = begin_preview_camera_stop(&state).await;
        assert!(
            !state
                .preview_camera
                .lock()
                .await
                .starting
                .as_ref()
                .is_some_and(|starting| starting == &lease.key),
            "stop admission must invalidate the abandoned test lease"
        );
        drop(physical_guard);
        let _ = finish_preview_camera_stop(stop).await;
    }

    #[tokio::test]
    async fn layout_join_transfers_timeout_owner_forward_and_never_backward() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:layout-transfer");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);

        let first_lease = match begin_camera_start(
            &state,
            start_key.clone(),
            &layout,
            test_camera_starting_status(&source_key, &video),
            Some(100),
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("first layout must own a fresh generation: {other:?}"),
        };
        let stale_owner = PreviewCameraStartingIdentity {
            source_key: source_key.clone(),
            generation: first_lease.generation,
            layout_intent_id: Some(100),
        };

        let winner = match begin_camera_start(
            &state,
            start_key.clone(),
            &layout,
            test_camera_starting_status(&source_key, &video),
            Some(101),
        )
        .await
        {
            PreviewCameraStartRegistration::JoinExisting {
                admitted_starting_identity: Some(identity),
                ..
            } => identity,
            other => panic!("same-key winner must inherit the generation: {other:?}"),
        };
        assert_eq!(winner.generation, first_lease.generation);
        assert_eq!(winner.layout_intent_id, Some(101));

        let delayed_stale = begin_camera_start(
            &state,
            start_key,
            &layout,
            test_camera_starting_status(&source_key, &video),
            Some(100),
        )
        .await;
        assert!(matches!(
            delayed_stale,
            PreviewCameraStartRegistration::JoinExisting {
                admitted_starting_identity: None,
                ..
            }
        ));
        assert_eq!(
            state.preview_camera.lock().await.starting_layout_intent_id,
            Some(101),
            "a delayed superseded source task must not steal timeout ownership backward"
        );
        assert!(
            begin_preview_camera_stop_if_starting(&state, &stale_owner)
                .await
                .is_none(),
            "superseded layout token must stop matching after ownership transfer"
        );

        let stop = begin_preview_camera_stop_if_starting(&state, &winner)
            .await
            .expect("winning layout retains exact timeout cleanup authority");
        let status = finish_preview_camera_stop(stop).await;
        assert_ne!(status.state, PreviewCameraState::Starting);
    }

    #[tokio::test]
    async fn different_key_layout_rechecks_supersession_after_registry_wait() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let current_key = SourceKey::camera("camera:avfoundation-native:current-layout");
        let stale_key = SourceKey::camera("camera:avfoundation-native:blocked-layout");
        state.publish_latest_layout_intent_id(300);

        let current_lease = match begin_camera_start(
            &state,
            test_camera_start_key(current_key.clone(), &layout, &video),
            &layout,
            test_camera_starting_status(&current_key, &video),
            Some(300),
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("current layout must own a fresh generation: {other:?}"),
        };
        let registry_guard = state.source_registry.lock().await;
        let registry_before = registry_guard.snapshot();
        let blocked_state = state.clone();
        let blocked_layout = layout.clone();
        let blocked_video = video.clone();
        let blocked_key = stale_key.clone();
        let blocked = tokio::spawn(async move {
            begin_camera_start(
                &blocked_state,
                test_camera_start_key(blocked_key.clone(), &blocked_layout, &blocked_video),
                &blocked_layout,
                test_camera_starting_status(&blocked_key, &blocked_video),
                Some(300),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.preview_camera.try_lock().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("different-key camera admission must reach the registry wait");
        {
            let _layout_admission = state.lock_layout_source_admission();
            state.publish_latest_layout_intent_id(301);
        }
        drop(registry_guard);
        let stale = blocked.await.expect("blocked camera admission task");

        assert!(matches!(
            stale,
            PreviewCameraStartRegistration::RejectedSuperseded(_)
        ));
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.start_generation, current_lease.generation);
        assert_eq!(slot.starting.as_ref(), Some(&current_lease.key));
        assert_eq!(slot.source_key.as_ref(), Some(&current_key));
        drop(slot);
        assert_eq!(
            state.source_registry.lock().await.snapshot(),
            registry_before
        );
    }

    #[tokio::test]
    async fn queued_camera_supervisor_survives_newer_layout_adoption() {
        assert_queued_camera_supervisor_survives_owner_transfer(Some(101)).await;
    }

    #[tokio::test]
    async fn queued_camera_supervisor_survives_public_owner_transfer() {
        assert_queued_camera_supervisor_survives_owner_transfer(None).await;
    }

    #[tokio::test(start_paused = true)]
    async fn camera_start_response_timeout_does_not_release_source_transition_fence() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:fenced-timeout");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        let held_transition = acquire_preview_camera_transition(&state).await;
        let lease = match begin_camera_start(
            &state,
            start_key,
            &layout,
            test_camera_starting_status(&source_key, &video),
            None,
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("camera timeout test must own a fresh generation: {other:?}"),
        };
        let completion = queue_registered_preview_camera(
            state.clone(),
            test_prepared_camera_start(&source_key, &layout, &video, lease.clone(), None),
            None,
        );
        let transition_snapshot = state.source_transition_fence.observe();
        let response_state = state.clone();
        let response_lease = lease.clone();
        let response = tokio::spawn(async move {
            wait_for_camera_transition_response(&response_state, completion, &response_lease).await
        });

        tokio::time::advance(CAMERA_COMMAND_TRANSITION_TIMEOUT + Duration::from_secs(1)).await;
        let status = response.await.expect("bounded camera response task");
        assert_eq!(status.state, PreviewCameraState::Starting);
        let mut transition_wait = Box::pin(transition_snapshot.wait());
        assert!(
            futures_util::poll!(&mut transition_wait).is_pending(),
            "caller timeout must not release physical camera transition ownership"
        );

        {
            let mut slot = state.preview_camera.lock().await;
            slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
            slot.starting = None;
            slot.starting_transition_completion = None;
            slot.starting_layout_intent_id = None;
        }
        drop(held_transition);
        transition_wait.await;
    }

    #[tokio::test(start_paused = true)]
    async fn fenced_layout_join_waits_past_command_timeout_and_starting_clear() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:616263");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        state.publish_latest_layout_intent_id(100);
        let lease = match begin_camera_start(
            &state,
            start_key,
            &layout,
            test_camera_starting_status(&source_key, &video),
            Some(100),
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("first layout must own the fenced generation: {other:?}"),
        };

        // Deterministic stand-in for the persistent transition owner. The
        // completion token, not the mutable runtime `starting` field, is the
        // physical ownership boundary used by the fenced join below.
        let completion_guard =
            PreviewCameraTransitionCompletionGuard::new(Arc::clone(&lease.transition_completion));
        let (release_tx, release_rx) = oneshot::channel();
        let supervisor = tokio::spawn(async move {
            let _completion_guard = completion_guard;
            let _ = release_rx.await;
        });

        {
            let _layout_admission = state.lock_layout_source_admission();
            state.publish_latest_layout_intent_id(101);
        }
        let (admission_tx, admission_rx) = oneshot::channel();
        let fenced_state = state.clone();
        let fenced_layout = layout.clone();
        let fenced_video = video.clone();
        let fenced_source_id = source_key.id.clone();
        let fenced = tokio::spawn(async move {
            start_preview_camera_for_layout_until_transition_complete(
                fenced_state,
                test_camera_params(Some(&fenced_source_id), &fenced_layout, &fenced_video),
                101,
                admission_tx,
            )
            .await
        });
        let admitted = admission_rx
            .await
            .expect("fenced layout join admission")
            .expect("newer layout adopts the starting generation");
        assert_eq!(admitted.generation, lease.generation);
        assert_eq!(admitted.layout_intent_id, Some(101));

        tokio::time::advance(CAMERA_COMMAND_TRANSITION_TIMEOUT + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(
            !fenced.is_finished(),
            "fenced layout work must remain live beyond the command response cap"
        );

        {
            let mut slot = state.preview_camera.lock().await;
            slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
            slot.starting = None;
            slot.starting_transition_completion = None;
            slot.starting_layout_intent_id = None;
            slot.source_key = None;
            slot.status = idle_status(Some("Fenced generation superseded.".to_string()));
        }
        tokio::task::yield_now().await;
        assert!(
            !fenced.is_finished(),
            "clearing logical Starting must not outrun physical supervisor completion"
        );

        release_tx
            .send(())
            .expect("release fake persistent transition owner");
        supervisor.await.expect("fake persistent transition owner");
        let result = fenced.await.expect("fenced layout join task");
        assert_eq!(result.status.state, PreviewCameraState::DeviceMissing);
        assert_eq!(result.admitted_starting_identity, Some(admitted));
    }

    #[tokio::test]
    async fn layout_invalid_camera_sources_do_not_mutate_public_start() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let public_key = SourceKey::camera("camera:avfoundation-native:public-owner");
        let public_lease = match begin_camera_start(
            &state,
            test_camera_start_key(public_key.clone(), &layout, &video),
            &layout,
            test_camera_starting_status(&public_key, &video),
            None,
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            other => panic!("public camera start must own a generation: {other:?}"),
        };
        let public_status = state.preview_camera.lock().await.status.clone();
        let registry_before = state.source_registry.lock().await.snapshot();
        let mutation_epoch_before = state.capture_recovery_camera_mutation_epoch();
        state.publish_latest_layout_intent_id(400);

        for invalid_camera_id in [None, Some("camera:unsupported:device")] {
            let result = start_preview_camera_with_owner(
                state.clone(),
                test_camera_params(invalid_camera_id, &layout, &video),
                Some(400),
                None,
                PreviewCameraStartWait::Bounded,
            )
            .await;
            assert_eq!(result.status.state, PreviewCameraState::DeviceMissing);
            assert!(result.admitted_starting_identity.is_none());
            let slot = state.preview_camera.lock().await;
            assert_eq!(slot.start_generation, public_lease.generation);
            assert_eq!(slot.starting.as_ref(), Some(&public_lease.key));
            assert_eq!(slot.starting_layout_intent_id, None);
            assert_eq!(slot.source_key.as_ref(), Some(&public_key));
            assert_eq!(slot.status, public_status);
            drop(slot);
            assert_eq!(
                state.source_registry.lock().await.snapshot(),
                registry_before
            );
            assert_eq!(
                state.capture_recovery_camera_mutation_epoch(),
                mutation_epoch_before,
                "layout validation failures must not enter the public camera mutation path"
            );
        }
    }

    #[tokio::test]
    async fn public_invalid_camera_sources_still_stop_and_publish_missing_status() {
        let video = test_video();
        let layout = test_layout(false);
        for invalid_camera_id in [None, Some("camera:unsupported:device")] {
            let state = test_state();
            let public_key = SourceKey::camera("camera:avfoundation-native:public-owner");
            assert!(matches!(
                begin_camera_start(
                    &state,
                    test_camera_start_key(public_key.clone(), &layout, &video),
                    &layout,
                    test_camera_starting_status(&public_key, &video),
                    None,
                )
                .await,
                PreviewCameraStartRegistration::Started { .. }
            ));
            let mutation_epoch_before = state.capture_recovery_camera_mutation_epoch();

            let status = start_preview_camera(
                state.clone(),
                test_camera_params(invalid_camera_id, &layout, &video),
            )
            .await;

            assert_eq!(status.state, PreviewCameraState::DeviceMissing);
            let slot = state.preview_camera.lock().await;
            assert!(slot.starting.is_none());
            assert_eq!(slot.status, status);
            drop(slot);
            assert!(
                state.capture_recovery_camera_mutation_epoch() > mutation_epoch_before,
                "public validation failures retain explicit stop/recovery reconciliation"
            );
            let snapshot = state.source_registry.lock().await.snapshot();
            assert!(snapshot.entries.iter().all(|entry| {
                entry.key != public_key || !entry.consumers.contains(&SourceConsumerReason::Preview)
            }));
        }
    }

    #[tokio::test]
    async fn queued_camera_start_retains_explicit_mutation_until_terminal_supervisor_state() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        let held_transition = acquire_preview_camera_transition(&state).await;
        let explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        let lease = match begin_camera_start(
            &state,
            start_key,
            &layout,
            test_camera_starting_status(&source_key, &video),
            None,
        )
        .await
        {
            PreviewCameraStartRegistration::Started { lease } => lease,
            PreviewCameraStartRegistration::JoinExisting { .. } => {
                panic!("first start must own")
            }
            PreviewCameraStartRegistration::Reused(_) => panic!("first start cannot reuse"),
            PreviewCameraStartRegistration::RejectedSuperseded(_)
            | PreviewCameraStartRegistration::RejectedShutdown(_) => {
                panic!("test process is not shutting down")
            }
        };
        let completion = queue_registered_preview_camera(
            state.clone(),
            PreparedCameraStart {
                camera_id: source_key.id.clone(),
                device_unique_id: "fake-supervisor".to_string(),
                ffmpeg_path: "ffmpeg".to_string(),
                target_fps: video.fps,
                source_key: source_key.clone(),
                params: PreviewCameraStartParams {
                    sources: SourceSelection {
                        screen_id: None,
                        window_id: None,
                        camera_id: Some(source_key.id.clone()),
                        microphone_id: None,
                        test_pattern: false,
                    },
                    layout,
                    video,
                    ffmpeg_path: Some("ffmpeg".to_string()),
                },
                lease: lease.clone(),
                layout_intent_id: None,
                recovery: None,
            },
            Some(explicit_mutation),
        );
        let in_flight_mutation_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(
            state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "the queued process supervisor must own the start mutation lease"
        );

        // End this generation deterministically before releasing the physical
        // gate, so the test never opens a platform camera device.
        {
            let mut slot = state.preview_camera.lock().await;
            slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
            slot.starting = None;
        }
        drop(held_transition);
        tokio::time::timeout(Duration::from_secs(1), completion)
            .await
            .expect("superseded start supervisor deadline")
            .expect("superseded start supervisor task");
        assert!(
            !state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "terminal supervisor state must release the start mutation lease"
        );
        assert!(
            state.capture_recovery_camera_mutation_epoch() > in_flight_mutation_epoch,
            "terminal start must stale health sampled while the transition gate was blocked"
        );
    }

    #[tokio::test]
    async fn camera_cancellation_at_registry_admission_preserves_old_runtime_and_consumer() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let old_source_key = SourceKey::camera("camera:avfoundation-native:old");
        let new_source_key = SourceKey::camera("camera:avfoundation-native:new");
        let mut old_status = test_camera_starting_status(&old_source_key, &video);
        old_status.state = PreviewCameraState::Live;
        old_status.message = Some("Existing camera session remains live.".to_string());
        {
            let mut slot = state.preview_camera.lock().await;
            slot.source_key = Some(old_source_key.clone());
            slot.status = old_status.clone();
            slot.start_generation = 7;
        }

        let mut registry_guard = state.source_registry.lock().await;
        registry_guard.acquire(old_source_key.clone(), SourceConsumerReason::Preview);
        registry_guard.set_status(old_source_key.clone(), SourceLifecycleStatus::Live);

        let caller_state = state.clone();
        let caller_new_source_key = new_source_key.clone();
        let caller_video = video.clone();
        let caller_layout = layout.clone();
        let caller = tokio::spawn(async move {
            begin_camera_start(
                &caller_state,
                test_camera_start_key(caller_new_source_key.clone(), &caller_layout, &caller_video),
                &caller_layout,
                test_camera_starting_status(&caller_new_source_key, &caller_video),
                None,
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if state.preview_camera.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("camera admission must reach the registry boundary");
        caller.abort();
        assert!(
            caller
                .await
                .expect_err("camera admission caller must abort")
                .is_cancelled()
        );
        drop(registry_guard);

        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.source_key.as_ref(), Some(&old_source_key));
        assert_eq!(slot.status, old_status);
        assert_eq!(slot.start_generation, 7);
        assert!(slot.starting.is_none());
        assert!(slot.pending_stop_generation.is_none());
        drop(slot);

        let snapshot = state.source_registry.lock().await.snapshot();
        let old_entry = snapshot
            .entries
            .iter()
            .find(|entry| entry.key == old_source_key)
            .expect("old camera registry entry");
        assert_eq!(old_entry.consumers, vec![SourceConsumerReason::Preview]);
        assert!(
            snapshot
                .entries
                .iter()
                .all(|entry| entry.key != new_source_key),
            "a cancelled camera admission must not register the new Preview consumer"
        );
    }

    #[tokio::test]
    async fn cancelling_camera_stop_waiter_does_not_abandon_native_ownership() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;

        let stop = begin_preview_camera_stop(&state).await;
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("supervisor must signal the fake native stop")
            .expect("fake native stop sender");
        let waiter = tokio::spawn(async move { finish_preview_camera_stop(stop).await });
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "native join is still deliberately blocked"
        );
        waiter.abort();
        assert!(waiter.await.expect_err("waiter must abort").is_cancelled());

        release_tx.send(()).expect("release fake native join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("fake native must exit after caller cancellation")
            .expect("fake native exit sender");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let finished = {
                    let slot = state.preview_camera.lock().await;
                    slot.active.is_none() && slot.pending_stop_generation.is_none()
                };
                if finished {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached stop supervisor must finish cleanup");
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let _guard = tokio::time::timeout(Duration::from_secs(1), gate.lock_owned())
            .await
            .expect("physical transition authority must be released");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn graceful_camera_shutdown_forces_release_and_joins_the_native_owner() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        {
            let mut registry = state.source_registry.lock().await;
            registry.acquire(source_key.clone(), SourceConsumerReason::Preview);
            registry.acquire(source_key, SourceConsumerReason::Recording);
        }

        let shutdown_state = state.clone();
        let shutdown = tokio::spawn(async move {
            shutdown_preview_camera_with_timeout(&shutdown_state, Duration::from_secs(1)).await
        });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("graceful shutdown must signal the camera owner")
            .expect("fake camera stop sender");
        assert!(
            !shutdown.is_finished(),
            "shutdown must retain the join until native teardown completes"
        );

        release_tx.send(()).expect("release shutdown camera join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("shutdown camera exit deadline")
            .expect("shutdown camera exit sender");
        assert!(
            shutdown.await.expect("camera shutdown supervisor"),
            "the graceful shutdown deadline must observe the completed join"
        );
        let slot = state.preview_camera.lock().await;
        assert!(slot.active.is_none());
        assert!(slot.pending_native.is_none());
        assert!(slot.pending_stop_generation.is_none());
        assert_eq!(slot.status.state, PreviewCameraState::DeviceMissing);
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn graceful_camera_shutdown_deadline_keeps_slow_join_process_owned() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;

        let started_at = Instant::now();
        assert!(
            !shutdown_preview_camera_with_timeout(&state, Duration::from_millis(20)).await,
            "a blocked native join must be reported as continuing"
        );
        assert!(started_at.elapsed() < Duration::from_millis(500));
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("bounded shutdown must still signal the camera owner")
            .expect("fake camera stop sender");
        {
            let slot = state.preview_camera.lock().await;
            assert!(slot.active.is_none());
            assert!(slot.pending_stop_generation.is_some());
            assert!(
                slot.status
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("exclusively owned"))
            );
        }

        release_tx
            .send(())
            .expect("release slow graceful camera join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("slow graceful camera exit deadline")
            .expect("slow graceful camera exit sender");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let terminal = {
                    let slot = state.preview_camera.lock().await;
                    slot.pending_stop_generation.is_none()
                        && slot.status.state == PreviewCameraState::DeviceMissing
                };
                if terminal {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("process-owned camera join must finish after deadline return");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_latch_rejects_late_camera_start_and_recovery_without_new_native_generation() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let restart = preview_camera_restart_snapshot(&state)
            .await
            .expect("fake live camera must expose an exact restart snapshot");
        let generation = state.preview_camera.lock().await.start_generation;

        assert!(state.request_process_shutdown());
        let rejected = start_preview_camera(
            state.clone(),
            PreviewCameraStartParams {
                sources: SourceSelection {
                    screen_id: None,
                    window_id: None,
                    camera_id: Some("camera:avfoundation-native:fake-supervisor".to_string()),
                    microphone_id: None,
                    test_pattern: false,
                },
                layout: test_layout(false),
                video: test_video(),
                ffmpeg_path: Some("ffmpeg".to_string()),
            },
        )
        .await;
        assert!(
            rejected
                .message
                .as_deref()
                .is_some_and(|message| message.contains("shutdown"))
        );
        assert_eq!(
            state.preview_camera.lock().await.start_generation,
            generation
        );
        assert_eq!(
            force_restart_preview_camera(state.clone(), &restart, 1).await,
            PreviewCameraForceRestartResult::RejectedStale
        );
        assert_eq!(
            state.preview_camera.lock().await.start_generation,
            generation
        );
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);

        let started_at = Instant::now();
        assert!(
            !shutdown_preview_camera_with_timeout(&state, Duration::from_millis(20)).await,
            "the process shutdown drain must stay bounded while the fake driver is blocked"
        );
        assert!(started_at.elapsed() < Duration::from_millis(500));
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("shutdown must signal the original camera generation")
            .expect("fake camera stop sender");
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);

        release_tx
            .send(())
            .expect("release shutdown-latched camera join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("shutdown-latched camera exit deadline")
            .expect("shutdown-latched camera exit sender");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let terminal = {
                    let slot = state.preview_camera.lock().await;
                    slot.pending_stop_generation.is_none()
                        && slot.status.state == PreviewCameraState::DeviceMissing
                };
                if terminal {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("process-owned camera drain must reach terminal state");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn camera_stop_survives_disposable_caller_runtime_drop_without_overlap() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;

        let caller_state = state.clone();
        let caller = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("disposable camera caller runtime");
            runtime.block_on(async move {
                let stop = begin_preview_camera_stop(&caller_state).await;
                // Dropping both the waiter and this runtime must not own or
                // cancel the process-lifetime physical transition.
                drop(stop);
            });
        });
        tokio::task::spawn_blocking(move || caller.join())
            .await
            .expect("disposable camera caller join task")
            .expect("disposable camera caller thread");

        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("process supervisor must outlive the caller runtime")
            .expect("fake camera stop sender");
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let replacement_live = Arc::clone(&live_sessions);
        let replacement_max = Arc::clone(&max_live_sessions);
        let (replacement_started_tx, mut replacement_started_rx) = oneshot::channel();
        let replacement = tokio::spawn(async move {
            let _physical_guard = gate.lock_owned().await;
            let live = replacement_live.fetch_add(1, Ordering::SeqCst) + 1;
            replacement_max.fetch_max(live, Ordering::SeqCst);
            let _ = replacement_started_tx.send(());
            replacement_live.fetch_sub(1, Ordering::SeqCst);
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut replacement_started_rx)
                .await
                .is_err(),
            "runtime drop must not release the gate before the native join"
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 1);

        release_tx
            .send(())
            .expect("release camera join after caller runtime drop");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("camera exit after caller runtime drop")
            .expect("fake camera exit sender");
        replacement_started_rx
            .await
            .expect("replacement starts after old camera joins");
        replacement.await.expect("replacement camera task");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let terminal = {
                    let slot = state.preview_camera.lock().await;
                    slot.active.is_none()
                        && slot.pending_native.is_none()
                        && slot.pending_stop_generation.is_none()
                        && slot.status.state == PreviewCameraState::DeviceMissing
                };
                if terminal {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("camera supervisor publishes terminal state");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_supersession_promptly_blocks_same_session_reuse_and_stale_install() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        let start_key = test_camera_start_key(source_key.clone(), &layout, &video);
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let physical_guard = gate.lock_owned().await;

        let first_stop = begin_preview_camera_stop(&state).await;
        let registration = tokio::time::timeout(
            Duration::from_millis(100),
            begin_camera_start(
                &state,
                start_key,
                &layout,
                test_camera_starting_status(&source_key, &video),
                None,
            ),
        )
        .await
        .expect("superseding start admission must not wait for physical teardown");
        let lease = match registration {
            PreviewCameraStartRegistration::Started { lease, .. } => lease,
            PreviewCameraStartRegistration::JoinExisting { .. } => {
                panic!("the stopped generation must not remain joinable")
            }
            PreviewCameraStartRegistration::Reused(_) => {
                panic!("a teardown-pending native session must never be reused")
            }
            PreviewCameraStartRegistration::RejectedSuperseded(_)
            | PreviewCameraStartRegistration::RejectedShutdown(_) => {
                panic!("test process is not shutting down")
            }
        };
        let final_stop = begin_preview_camera_stop(&state).await;
        let stale_install_claimed = {
            let mut slot = state.preview_camera.lock().await;
            claim_camera_start(&mut slot, &lease)
        };
        assert!(
            !stale_install_claimed,
            "newer stop intent must immediately invalidate the unstarted lease"
        );

        drop(physical_guard);
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("the current stop generation must retire the old native owner")
            .expect("fake native stop sender");
        release_tx.send(()).expect("release fake native join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("fake native exit deadline")
            .expect("fake native exit sender");
        let (_first_status, _final_status) = tokio::join!(
            finish_preview_camera_stop(first_stop),
            finish_preview_camera_stop(final_stop),
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn bounded_camera_stop_response_keeps_the_next_native_session_exclusive() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;

        let stop = begin_preview_camera_stop(&state).await;
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("fake native must receive stop")
            .expect("fake native stop sender");
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let next_live_sessions = Arc::clone(&live_sessions);
        let next_max_live_sessions = Arc::clone(&max_live_sessions);
        let (next_started_tx, mut next_started_rx) = oneshot::channel();
        let next_session = tokio::spawn(async move {
            let _physical_guard = gate.lock_owned().await;
            let live = next_live_sessions.fetch_add(1, Ordering::SeqCst) + 1;
            next_max_live_sessions.fetch_max(live, Ordering::SeqCst);
            let _ = next_started_tx.send(());
            next_live_sessions.fetch_sub(1, Ordering::SeqCst);
        });

        let returned =
            finish_preview_camera_stop_with_timeout(stop, Duration::from_millis(20)).await;
        assert!(
            returned
                .message
                .as_deref()
                .is_some_and(|message| message.contains("exclusively owned")),
            "the bounded response must truthfully report delayed teardown"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut next_started_rx)
                .await
                .is_err(),
            "a replacement native session must remain behind the blocked join"
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 1);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
        let in_flight_mutation_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(
            state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "the explicit stop mutation must remain active after its bounded waiter detaches"
        );

        release_tx.send(()).expect("release fake native join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("old native session exit deadline")
            .expect("old native session exit sender");
        tokio::time::timeout(Duration::from_secs(1), &mut next_started_rx)
            .await
            .expect("next native session starts after retirement")
            .expect("next native start sender");
        next_session.await.expect("next fake native session task");
        tokio::time::timeout(Duration::from_secs(1), async {
            while state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the terminal stop supervisor must release its mutation lease");
        assert!(
            state.capture_recovery_camera_mutation_epoch() > in_flight_mutation_epoch,
            "the terminal stop edge must stale health sampled during native join"
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn late_unneeded_live_camera_thread_is_stopped_and_joined() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let stale_thread = {
            let mut slot = state.preview_camera.lock().await;
            slot.source_key = None;
            slot.active_generation = None;
            slot.status = idle_status(Some("The late session is no longer desired.".to_string()));
            slot.active.take().expect("fake late native thread")
        };

        let retirement =
            tokio::spawn(async move { retire_uninstalled_camera_thread(stale_thread, 99).await });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("late Live must be told to stop")
            .expect("fake native stop sender");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 1);
        assert!(
            !retirement.is_finished(),
            "retirement must retain the native join"
        );

        release_tx.send(()).expect("release late fake native join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("late fake native exit deadline")
            .expect("late fake native exit sender");
        tokio::time::timeout(Duration::from_secs(1), retirement)
            .await
            .expect("late native retirement deadline")
            .expect("late native retirement task");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn panic_after_camera_spawn_reaps_pending_owner_before_replacement_starts() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:fake-supervisor");
        let lease = PreviewCameraStartLease::new(
            test_camera_start_key(source_key.clone(), &layout, &video),
            99,
        );
        {
            let mut slot = state.preview_camera.lock().await;
            let mut spawned = slot.active.take().expect("fake spawned native camera");
            slot.active_generation = None;
            slot.start_generation = lease.generation;
            slot.starting = Some(lease.key.clone());
            slot.source_key = Some(source_key.clone());
            slot.status = test_camera_starting_status(&source_key, &video);
            slot.pending_native = Some(PendingNativeCameraThread {
                generation: lease.generation,
                stop_tx: spawned.stop_tx,
                join_handle: spawned.join_handle.take(),
            });
        }

        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let cleanup_state = state.clone();
        let cleanup_lease = lease.clone();
        let cleanup = tokio::spawn(async move {
            let _physical_guard = gate.lock_owned().await;
            let panicked = std::panic::AssertUnwindSafe(async {
                panic!("injected panic after pending camera ownership registration");
            })
            .catch_unwind()
            .await;
            assert!(panicked.is_err());
            retire_panicked_camera_generation(
                &cleanup_state,
                &cleanup_lease,
                failed_status(
                    Some(source_key.id.clone()),
                    Some("fake-supervisor".to_string()),
                    video.fps,
                    "Injected camera transition panic.".to_string(),
                ),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("panic cleanup must signal pending camera")
            .expect("fake camera stop sender");

        let replacement_gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let replacement_live_sessions = Arc::clone(&live_sessions);
        let replacement_max_live_sessions = Arc::clone(&max_live_sessions);
        let (replacement_started_tx, mut replacement_started_rx) = oneshot::channel();
        let replacement = tokio::spawn(async move {
            let _physical_guard = replacement_gate.lock_owned().await;
            let live = replacement_live_sessions.fetch_add(1, Ordering::SeqCst) + 1;
            replacement_max_live_sessions.fetch_max(live, Ordering::SeqCst);
            let _ = replacement_started_tx.send(());
            replacement_live_sessions.fetch_sub(1, Ordering::SeqCst);
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut replacement_started_rx)
                .await
                .is_err(),
            "replacement must remain behind the panicked owner's native join"
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 1);

        release_tx.send(()).expect("release pending camera join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("pending camera exit deadline")
            .expect("pending camera exit sender");
        let failed = cleanup.await.expect("camera panic cleanup task");
        assert_eq!(failed.state, PreviewCameraState::Failed);
        replacement_started_rx
            .await
            .expect("replacement starts after camera join");
        replacement.await.expect("replacement camera task");
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
        assert!(state.preview_camera.lock().await.pending_native.is_none());
    }

    #[tokio::test]
    async fn panic_before_camera_detach_reconciles_old_native_and_runtime_owner() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:replacement");
        let lease = PreviewCameraStartLease::new(
            test_camera_start_key(source_key.clone(), &layout, &video),
            2,
        );
        {
            let mut slot = state.preview_camera.lock().await;
            slot.start_generation = lease.generation;
            slot.starting = Some(lease.key.clone());
            slot.source_key = Some(source_key.clone());
            slot.status = test_camera_starting_status(&source_key, &video);
            assert_eq!(slot.active_generation, Some(1));
        }

        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let cleanup_state = state.clone();
        let cleanup_lease = lease.clone();
        let cleanup = tokio::spawn(async move {
            let _physical_guard = gate.lock_owned().await;
            retire_panicked_camera_generation(
                &cleanup_state,
                &cleanup_lease,
                failed_status(
                    Some(source_key.id),
                    Some("replacement".to_string()),
                    video.fps,
                    "Injected panic before old camera detachment.".to_string(),
                ),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("pre-detach panic must stop the old camera owner")
            .expect("fake camera stop sender");
        assert!(
            !cleanup.is_finished(),
            "cleanup must retain the old native join"
        );
        {
            let slot = state.preview_camera.lock().await;
            assert!(slot.active.is_none());
            assert!(slot.active_generation.is_none());
        }

        release_tx.send(()).expect("release old camera join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("old camera exit deadline")
            .expect("old camera exit sender");
        let failed = cleanup.await.expect("pre-detach panic cleanup");
        assert_eq!(failed.state, PreviewCameraState::Failed);
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    async fn install_restartable_camera(
        state: &AppState,
        generation: u64,
        layout: &LayoutSettings,
        video: &VideoSettings,
    ) -> (SourceKey, Arc<StdMutex<PreviewCameraShared>>) {
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        let mut slot = state.preview_camera.lock().await;
        slot.source_key = Some(source_key.clone());
        slot.start_generation = generation;
        slot.active_generation = Some(generation);
        slot.status = PreviewCameraStatus {
            state: PreviewCameraState::Live,
            camera_id: Some(source_key.id.clone()),
            device_unique_id: Some("test".to_string()),
            target_fps: video.fps,
            width: Some(video.width),
            height: Some(video.height),
            requested_width: Some(video.width),
            requested_height: Some(video.height),
            actual_width: Some(video.width),
            actual_height: Some(video.height),
            selected_format_width: Some(video.width),
            selected_format_height: Some(video.height),
            selected_format_min_fps: Some(1.0),
            selected_format_max_fps: Some(f64::from(video.fps)),
            source_fps: Some(f64::from(video.fps)),
            frame_age_ms: Some(1),
            frames_captured: 1,
            dropped_frames: 0,
            sequence: Some(1),
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Live".to_string()),
        };
        slot.active = Some(NativeCameraPreviewThread {
            stop_tx,
            join_handle: None,
            shared: Arc::clone(&shared),
            camera_id: source_key.id.clone(),
            device_unique_id: "test".to_string(),
            ffmpeg_path: "/resolved/ffmpeg".to_string(),
            layout: layout.clone(),
            video: video.clone(),
            effective_fps: video.fps,
            configured_output: (video.width, video.height),
            capture_target: camera_capture_target_dimensions(layout, video),
        });
        (source_key, shared)
    }

    #[tokio::test]
    async fn forced_camera_restart_is_generation_and_key_cas_and_preserves_exact_config() {
        let state = test_state();
        let layout = test_layout(true);
        let video = test_video();
        let (source_key, _) = install_restartable_camera(&state, 7, &layout, &video).await;

        assert!(
            reuse_current_camera_source(
                &state,
                &source_key,
                "/resolved/ffmpeg",
                &layout,
                &video,
                video.fps,
            )
            .await
            .is_some(),
            "the fixture is intentionally eligible for ordinary same-key reuse"
        );
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        assert_eq!(expected.source_key, source_key);
        assert_eq!(expected.generation, 7);
        assert_eq!(expected.config.layout, layout);
        assert_eq!(expected.config.video, video);
        assert_eq!(expected.config.ffmpeg_path, "/resolved/ffmpeg");
        assert_eq!(expected.config.device_unique_id, "test");
        let recovery_epoch = 101;
        state.set_capture_recovery_admission_epoch(recovery_epoch);

        let mut stale_generation = expected.clone();
        stale_generation.generation = 6;
        assert!(
            begin_forced_camera_restart(&state, &stale_generation, recovery_epoch)
                .await
                .is_none()
        );
        let mut stale_key = expected.clone();
        stale_key.source_key = SourceKey::camera("camera:avfoundation-native:other");
        assert!(
            begin_forced_camera_restart(&state, &stale_key, recovery_epoch)
                .await
                .is_none()
        );

        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("exact snapshot must reserve a forced restart");
        assert_eq!(prepared.lease.generation, 8);
        assert_eq!(prepared.lease.key.source_key, source_key);
        assert_eq!(prepared.params.layout, layout);
        assert_eq!(prepared.params.video, video);
        assert_eq!(
            prepared.params.ffmpeg_path.as_deref(),
            Some("/resolved/ffmpeg")
        );
        assert_eq!(
            prepared.params.sources.camera_id.as_deref(),
            Some("camera:avfoundation-native:test")
        );
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.start_generation, 8);
        assert_eq!(slot.active_generation, Some(7));
        assert!(
            slot.active.is_some(),
            "CAS alone must not overlap or discard the old session"
        );
        drop(slot);
        stop_current_camera_for_restart(&state).await;
    }

    #[tokio::test]
    async fn same_generation_operator_reuse_invalidates_recovery_before_force_cas() {
        let state = test_state();
        let old_layout = test_layout(false);
        let new_layout = test_layout(true);
        let video = test_video();
        let (source_key, _) = install_restartable_camera(&state, 17, &old_layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 201;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let start_key = camera_restart_start_key(&source_key, &expected.config);
        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;

        let registration = begin_camera_start(
            &state,
            start_key,
            &new_layout,
            test_camera_starting_status(&source_key, &video),
            None,
        )
        .await;
        assert!(matches!(
            registration,
            PreviewCameraStartRegistration::Reused(_)
        ));
        assert!(
            !state.capture_recovery_admission_is_current(recovery_epoch),
            "same-generation operator reuse must invalidate the queued recovery ticket"
        );
        assert_eq!(state.preview_camera.lock().await.start_generation, 17);
        assert!(
            begin_forced_camera_restart(&state, &expected, recovery_epoch)
                .await
                .is_none(),
            "the stale recovery ticket cannot turn a Hot layout reuse into a physical restart"
        );
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.active_generation, Some(17));
        assert!(
            slot.active
                .as_ref()
                .expect("reused active camera")
                .layout
                .camera_mirror
        );
    }

    #[tokio::test]
    async fn same_key_operator_start_supersedes_recovery_owned_starting_generation() {
        let state = test_state();
        let old_layout = test_layout(false);
        let new_layout = test_layout(true);
        let video = test_video();
        let (source_key, _) = install_restartable_camera(&state, 19, &old_layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 211;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let recovery = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");
        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;

        let registration = begin_camera_start(
            &state,
            recovery.lease.key.clone(),
            &new_layout,
            test_camera_starting_status(&source_key, &video),
            None,
        )
        .await;
        let operator_lease = match registration {
            PreviewCameraStartRegistration::Started { lease } => lease,
            PreviewCameraStartRegistration::JoinExisting { .. } => {
                panic!("operator start must not join a recovery-owned generation")
            }
            PreviewCameraStartRegistration::Reused(_) => {
                panic!("a recovery-owned Starting generation cannot be reused")
            }
            PreviewCameraStartRegistration::RejectedSuperseded(_)
            | PreviewCameraStartRegistration::RejectedShutdown(_) => {
                panic!("test process is not shutting down")
            }
        };
        assert_eq!(operator_lease.generation, recovery.lease.generation + 1);
        assert!(!state.capture_recovery_admission_is_current(recovery_epoch));
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.starting.as_ref(), Some(&operator_lease.key));
        assert_eq!(slot.starting_recovery_epoch, None);
        assert_eq!(slot.active_generation, Some(expected.generation));
    }

    #[tokio::test]
    async fn invalidated_recovery_panic_preserves_predecessor_and_rejects_failed_terminal() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        let (_, old_shared) = install_restartable_camera(&state, 20, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let predecessor_status = preview_camera_status(&state).await;
        let recovery_epoch = 214;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");

        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        let status = retire_panicked_camera_generation(
            &state,
            &prepared.lease,
            failed_status(
                Some(prepared.camera_id.clone()),
                Some(prepared.device_unique_id.clone()),
                prepared.target_fps,
                "Injected stale recovery panic.".to_string(),
            ),
            Some(&prepared),
        )
        .await;

        assert_eq!(status.state, PreviewCameraState::Live);
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.status, predecessor_status);
        assert_eq!(slot.active_generation, Some(expected.generation));
        assert!(slot.starting.is_none());
        assert!(slot.starting_recovery_epoch.is_none());
        assert!(
            slot.active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(&active.shared, &old_shared)),
            "stale panic cleanup must not detach the predecessor"
        );
    }

    #[tokio::test]
    async fn invalidation_during_blocked_recovery_panic_join_rejects_late_failed_terminal() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("blocking camera restart snapshot");
        let recovery_epoch = 215;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let cleanup_state = state.clone();
        let cleanup = tokio::spawn(async move {
            let _physical_guard = gate.lock_owned().await;
            retire_panicked_camera_generation(
                &cleanup_state,
                &prepared.lease,
                failed_status(
                    Some(prepared.camera_id.clone()),
                    Some(prepared.device_unique_id.clone()),
                    prepared.target_fps,
                    "Injected recovery panic with blocked predecessor join.".to_string(),
                ),
                Some(&prepared),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("panic cleanup must signal predecessor stop")
            .expect("blocking predecessor stop sender");

        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        assert_eq!(
            preview_camera_status(&state).await.state,
            PreviewCameraState::Starting,
            "Failed must not be committed before the native join finishes"
        );

        release_tx.send(()).expect("release blocked panic join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("predecessor exit deadline")
            .expect("predecessor exit sender");
        let status = cleanup.await.expect("panic cleanup task");
        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
        assert_ne!(status.state, PreviewCameraState::Failed);
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.status, status);
        assert!(slot.active.is_none());
        assert!(slot.starting.is_none());
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn compositor_lifecycle_churn_during_blocked_recovery_join_keeps_replacement_live() {
        let state = test_state();
        let live_sessions = Arc::new(AtomicUsize::new(0));
        let max_live_sessions = Arc::new(AtomicUsize::new(0));
        let FakeNativeCameraControl {
            release_tx,
            stop_seen_rx,
            exited_rx,
        } = install_blocking_fake_native_camera(
            &state,
            Arc::clone(&live_sessions),
            Arc::clone(&max_live_sessions),
        )
        .await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("blocking camera restart snapshot");
        let recovery_epoch = crate::capture_recovery::test_admit_camera_recovery_attempt(
            &state,
            expected.source_key.clone(),
            expected.generation,
        )
        .await;
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");
        let replacement_generation = prepared.lease.generation;
        let stop_state = state.clone();
        let stop_lease = prepared.lease.clone();
        let stop = tokio::spawn(async move {
            stop_current_camera_for_restart_if_admitted(
                &stop_state,
                Some(&stop_lease),
                Some(recovery_epoch),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), stop_seen_rx)
            .await
            .expect("recovery restart must signal predecessor stop")
            .expect("blocking predecessor stop sender");
        assert!(
            state.preview_camera.lock().await.active.is_none(),
            "the predecessor must already be detached while its native join blocks"
        );

        crate::capture_recovery::note_compositor_lifecycle_changed(
            &state,
            Some("compositor-after-surface-restart".to_string()),
        )
        .await;
        assert!(
            state.capture_recovery_admission_is_current(recovery_epoch),
            "downstream compositor churn must not revoke an admitted physical camera replacement"
        );

        release_tx
            .send(())
            .expect("release blocked predecessor join");
        tokio::time::timeout(Duration::from_secs(1), exited_rx)
            .await
            .expect("predecessor exit deadline")
            .expect("predecessor exit sender");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stop)
                .await
                .expect("predecessor retirement deadline")
                .expect("predecessor retirement task"),
            "compositor churn must not supersede the camera restart lease"
        );

        // Exercise the exact admission claim used by the real native Live
        // install without opening a platform camera in this deterministic test.
        let layout = prepared.params.layout.clone();
        let video = prepared.params.video.clone();
        let source_key = prepared.source_key.clone();
        let mut live_status = test_camera_starting_status(&source_key, &video);
        live_status.state = PreviewCameraState::Live;
        live_status.width = Some(video.width);
        live_status.height = Some(video.height);
        live_status.actual_width = Some(video.width);
        live_status.actual_height = Some(video.height);
        live_status.frames_captured = 1;
        live_status.sequence = Some(1);
        live_status.message = Some("Replacement fake native camera live.".to_string());
        let (replacement_stop_tx, _replacement_stop_rx) = std_mpsc::channel();
        let installed = {
            let mut slot = state.preview_camera.lock().await;
            if !claim_camera_start_if_admitted(
                &state,
                &mut slot,
                &prepared.lease,
                Some(recovery_epoch),
            ) {
                false
            } else {
                slot.status = live_status.clone();
                slot.run_id = Some("replacement-camera-run".to_string());
                slot.source_key = Some(source_key.clone());
                slot.active = Some(NativeCameraPreviewThread {
                    stop_tx: replacement_stop_tx,
                    join_handle: None,
                    shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
                    camera_id: prepared.camera_id,
                    device_unique_id: prepared.device_unique_id,
                    ffmpeg_path: prepared.ffmpeg_path,
                    layout: layout.clone(),
                    video: video.clone(),
                    effective_fps: video.fps,
                    configured_output: (video.width, video.height),
                    capture_target: camera_capture_target_dimensions(&layout, &video),
                });
                slot.active_generation = Some(replacement_generation);
                slot.live_acked_at = Some(Instant::now());
                true
            }
        };
        assert!(
            installed,
            "the admitted replacement must cross Live install"
        );
        acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Live).await;
        assert_eq!(
            preview_camera_status(&state).await.state,
            PreviewCameraState::Live
        );
        assert_eq!(
            state.preview_camera.lock().await.active_generation,
            Some(replacement_generation)
        );
        assert_eq!(live_sessions.load(Ordering::SeqCst), 0);
        assert_eq!(max_live_sessions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recovery_invalidated_after_old_stop_cannot_cross_native_spawn_boundary() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        let (_, old_shared) = install_restartable_camera(&state, 21, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 212;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");

        assert!(
            stop_current_camera_for_restart_if_admitted(
                &state,
                Some(&prepared.lease),
                Some(recovery_epoch),
            )
            .await,
            "the current ticket may retire its old generation"
        );
        assert_eq!(Arc::strong_count(&old_shared), 1);
        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;

        {
            let slot = state.preview_camera.lock().await;
            assert!(
                !camera_start_admission_is_current_locked(
                    &state,
                    &slot,
                    Some(&prepared.lease),
                    Some(recovery_epoch),
                ),
                "an operator intent admitted after the old join must prevent native spawn"
            );
            assert!(slot.pending_native.is_none());
            assert!(slot.active.is_none());
        }
        let status = current_or_retire_superseded_camera_start(&state, &prepared).await;
        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
        let slot = state.preview_camera.lock().await;
        assert!(slot.starting.is_none());
        assert!(slot.pending_native.is_none());
        assert!(slot.active.is_none());
    }

    #[tokio::test]
    async fn recovery_invalidated_after_native_spawn_cannot_cross_live_install_boundary() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        let _ = install_restartable_camera(&state, 25, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 213;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");
        assert!(
            stop_current_camera_for_restart_if_admitted(
                &state,
                Some(&prepared.lease),
                Some(recovery_epoch),
            )
            .await
        );

        let (stop_tx, stop_rx) = std_mpsc::channel();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.pending_native = Some(PendingNativeCameraThread {
                generation: prepared.lease.generation,
                stop_tx,
                join_handle: None,
            });
        }
        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;

        {
            let mut slot = state.preview_camera.lock().await;
            assert!(
                !claim_camera_start_if_admitted(
                    &state,
                    &mut slot,
                    &prepared.lease,
                    Some(recovery_epoch),
                ),
                "a registered pending native owner must not install after operator supersession"
            );
            assert!(slot.active.is_none());
            assert!(slot.pending_native.is_some());
        }
        stop_pending_camera_generation(&state, prepared.lease.generation, "test-superseded").await;
        stop_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("superseded pending native owner receives stop");
        let status = current_or_retire_superseded_camera_start(&state, &prepared).await;
        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
        let slot = state.preview_camera.lock().await;
        assert!(slot.starting.is_none());
        assert!(slot.pending_native.is_none());
        assert!(slot.active.is_none());
    }

    #[tokio::test]
    async fn recovery_epoch_invalidated_after_queue_check_cannot_stop_old_or_spawn_new_camera() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        let (_source_key, old_shared) =
            install_restartable_camera(&state, 23, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 202;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("recovery generation admitted");
        assert!(
            prepared_camera_admission_is_current(&state, &prepared),
            "fixture crosses the queue supervisor's first epoch check"
        );

        // This is the adversarial barrier: explicit configuration wins after
        // the queue-level check but before start_registered acquires physical
        // stop authority.
        let _explicit_mutation =
            begin_capture_recovery_explicit_camera_configuration_mutation(&state).await;
        let status = start_registered_preview_camera(state.clone(), prepared).await;

        assert_eq!(status.state, PreviewCameraState::Live);
        let slot = state.preview_camera.lock().await;
        assert_eq!(slot.start_generation, 24);
        assert_eq!(slot.active_generation, Some(23));
        assert!(slot.starting.is_none());
        assert!(slot.starting_recovery_epoch.is_none());
        assert!(
            slot.active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(&active.shared, &old_shared))
        );
        assert!(slot.pending_native.is_none());
    }

    #[tokio::test]
    async fn failed_recovery_retry_is_generation_cas_and_preserves_private_config() {
        let state = test_state();
        let layout = test_layout(true);
        let video = test_video();
        let (source_key, _) = install_restartable_camera(&state, 31, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 102;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("forced reservation");
        let failed_generation = prepared.lease.generation;
        stop_current_camera_for_restart(&state).await;
        let failure = failed_status(
            Some(prepared.camera_id.clone()),
            Some(prepared.device_unique_id.clone()),
            prepared.target_fps,
            "synthetic startup failure".to_string(),
        );
        assert!(
            set_camera_status_for_start(&state, &prepared.lease, Some(recovery_epoch), failure,)
                .await
        );

        assert!(
            failed_preview_camera_retry_is_current(&state, &source_key, failed_generation).await
        );
        assert!(
            !failed_preview_camera_retry_is_current(&state, &source_key, expected.generation).await
        );
        assert!(
            !failed_preview_camera_retry_is_current(
                &state,
                &SourceKey::camera("camera:avfoundation-native:other"),
                failed_generation,
            )
            .await
        );

        let retry = begin_failed_camera_recovery_retry(
            &state,
            &source_key,
            failed_generation,
            recovery_epoch,
        )
        .await
        .expect("exact failed generation is retryable");
        assert_eq!(retry.lease.generation, failed_generation + 1);
        assert_eq!(retry.params.layout, layout);
        assert_eq!(retry.params.video, video);
        assert_eq!(retry.ffmpeg_path, "/resolved/ffmpeg");
        assert_eq!(retry.device_unique_id, "test");
        assert!(
            !failed_preview_camera_retry_is_current(&state, &source_key, failed_generation).await,
            "reserving the next generation consumes the old failed token"
        );

        stop_current_camera_for_restart(&state).await;
        let second_failure = failed_status(
            Some(retry.camera_id.clone()),
            Some(retry.device_unique_id.clone()),
            retry.target_fps,
            "synthetic retry failure".to_string(),
        );
        assert!(
            set_camera_status_for_start(
                &state,
                &retry.lease,
                Some(recovery_epoch),
                second_failure,
            )
            .await
        );
        assert!(
            failed_preview_camera_retry_is_current(&state, &source_key, retry.lease.generation)
                .await
        );

        let stop = begin_preview_camera_stop(&state).await;
        let _ = finish_preview_camera_stop(stop).await;
        assert!(
            !failed_preview_camera_retry_is_current(&state, &source_key, retry.lease.generation)
                .await,
            "an ordinary stop invalidates the opaque retry authority"
        );
    }

    #[tokio::test]
    async fn same_key_new_camera_generation_replaces_source_and_releases_old_owner() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        let (source_key, old_shared) =
            install_restartable_camera(&state, 11, &layout, &video).await;
        let old_source = preview_camera_frame_source(&state)
            .await
            .expect("old frame source");
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("restart snapshot");
        let recovery_epoch = 103;
        state.set_capture_recovery_admission_epoch(recovery_epoch);
        let prepared = begin_forced_camera_restart(&state, &expected, recovery_epoch)
            .await
            .expect("forced restart reservation");
        stop_current_camera_for_restart(&state).await;
        assert_eq!(
            Arc::strong_count(&old_shared),
            2,
            "only test + old reader remain"
        );

        let new_shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        {
            let mut slot = state.preview_camera.lock().await;
            assert!(claim_camera_start(&mut slot, &prepared.lease));
            slot.status.state = PreviewCameraState::Live;
            slot.source_key = Some(source_key.clone());
            slot.active_generation = Some(prepared.lease.generation);
            slot.active = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::clone(&new_shared),
                camera_id: prepared.camera_id,
                device_unique_id: prepared.device_unique_id,
                ffmpeg_path: prepared.ffmpeg_path,
                layout: prepared.params.layout,
                video: prepared.params.video,
                effective_fps: prepared.target_fps,
                configured_output: (video.width, video.height),
                capture_target: prepared.lease.key.capture_target,
            });
        }
        let new_source = preview_camera_frame_source(&state)
            .await
            .expect("new frame source");
        assert_eq!(old_source.source_key(), new_source.source_key());
        assert_eq!(old_source.generation(), 11);
        assert_eq!(new_source.generation(), 12);
        assert!(!Arc::ptr_eq(&old_source.shared, &new_source.shared));

        drop(old_source);
        assert_eq!(
            Arc::strong_count(&old_shared),
            1,
            "old reader releases its session owner"
        );
    }

    #[tokio::test]
    async fn camera_recovery_evidence_is_bound_to_exact_active_generation() {
        let state = test_state();
        let video = test_video();
        let (_, shared) = install_restartable_camera(&state, 21, &test_layout(false), &video).await;
        {
            let mut shared = shared.lock().unwrap();
            shared.capture_callback_count = 4;
            shared.frames_captured = 3;
            shared.source_fps = Some(29.97);
            shared
                .capture_drop_reasons
                .record(CameraCaptureDropReason::FrameWasLate);
            shared
                .capture_drop_reasons
                .record(CameraCaptureDropReason::OutOfBuffers);
            shared
                .capture_drop_reasons
                .record(CameraCaptureDropReason::OutOfBuffers);
            shared.frame_store.publish(
                9,
                video.width,
                video.height,
                PreviewCameraPixelFormat::Bgra8,
                Instant::now(),
                vec![0; 4],
            );
        }
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.actual_width = None;
            slot.status.actual_height = None;
        }
        let snapshot = preview_camera_restart_snapshot(&state)
            .await
            .expect("restart snapshot");
        let evidence = preview_camera_recovery_evidence(&state, &snapshot)
            .await
            .expect("current evidence");
        assert_eq!(evidence.generation, 21);
        assert_eq!(evidence.capture_callback_count, 4);
        assert_eq!(evidence.frame_store_publications, 3);
        assert_eq!(evidence.source_fps, Some(29.97));
        assert_eq!(evidence.did_drop_callback_count, 3);
        assert_eq!(evidence.out_of_buffers, 2);
        assert_eq!(evidence.surface_backing_live_count, 0);
        assert_eq!(evidence.surface_backing_peak_count, 0);
        assert_eq!(evidence.latest_sequence, Some(9));
        assert_eq!(evidence.requested_width, Some(video.width));
        assert_eq!(evidence.configured_width, Some(video.width));
        assert_eq!(evidence.configured_height, Some(video.height));
        assert_eq!(evidence.actual_width, Some(video.width));
        assert_eq!(evidence.actual_height, Some(video.height));

        state.preview_camera.lock().await.active_generation = Some(22);
        assert!(
            preview_camera_recovery_evidence(&state, &snapshot)
                .await
                .is_none(),
            "a same-key replacement must invalidate old evidence authority"
        );
    }

    #[tokio::test]
    async fn negotiated_low_camera_fps_remains_the_generation_liveness_target() {
        let state = test_state();
        let mut video = test_video();
        video.fps = 30;
        let (_, shared) = install_restartable_camera(&state, 25, &test_layout(false), &video).await;
        shared.lock().unwrap().frame_store.publish(
            2,
            video.width,
            video.height,
            PreviewCameraPixelFormat::Bgra8,
            Instant::now(),
            vec![0; 4],
        );
        {
            let mut slot = state.preview_camera.lock().await;
            slot.active.as_mut().unwrap().effective_fps =
                stable_effective_camera_fps(14.985, video.fps);
            // Dynamic delivery can decay below the negotiated cadence; it must
            // not lower the expected-rate oracle for its own generation.
            slot.status.source_fps = Some(3.0);
        }

        let source = preview_camera_frame_source(&state)
            .await
            .expect("camera frame source");
        assert_eq!(source.target_fps(), 15);
        let snapshot = preview_camera_restart_snapshot(&state)
            .await
            .expect("restart snapshot");
        let evidence = preview_camera_recovery_evidence(&state, &snapshot)
            .await
            .expect("generation evidence");
        assert_eq!(evidence.target_fps, 15);
        assert_eq!(evidence.configured_width, Some(video.width));
        assert_eq!(evidence.actual_width, Some(video.width));
    }

    #[tokio::test]
    async fn public_camera_stop_waits_for_the_capture_transition_gate() {
        let state = test_state();
        let gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let guard = gate.lock_owned().await;
        let stop_state = state.clone();
        let stop = tokio::spawn(async move { stop_preview_camera(&stop_state).await });
        tokio::task::yield_now().await;
        assert!(
            !stop.is_finished(),
            "stop must not cross an active start/restart edge"
        );

        drop(guard);
        let status = tokio::time::timeout(Duration::from_secs(1), stop)
            .await
            .expect("stop should proceed once transition completes")
            .expect("stop task");
        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
    }

    #[test]
    fn shared_nv12_conversion_preserves_bt709_video_range_pixels() {
        let y = [16, 235, 81, 145];
        let cbcr = [128, 128];
        let mut out = [0; 16];

        nv12_to_bgra(&y, 2, &cbcr, 2, 2, 2, false, &mut out);

        for (index, luma) in y.into_iter().enumerate() {
            let (b, g, r) = ycbcr_bt709_video_to_bgr(luma, 128, 128);
            assert_eq!(&out[index * 4..index * 4 + 4], &[b, g, r, 255]);
        }
    }

    #[test]
    fn shared_yuv422_conversion_accepts_uyvy_and_yuy2_ordering() {
        let mut uyvy_out = [0; 8];
        let mut yuy2_out = [0; 8];

        yuv422_to_bgra(&[128, 16, 128, 235], 4, 2, 1, true, &mut uyvy_out);
        yuv422_to_bgra(&[16, 128, 235, 128], 4, 2, 1, false, &mut yuy2_out);

        assert_eq!(uyvy_out, yuy2_out);
        assert_eq!(uyvy_out[3], 255);
        assert_eq!(uyvy_out[7], 255);
    }

    #[test]
    fn missing_camera_status_is_device_missing() {
        let status = status_for_missing_camera(None, "No camera");

        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
        assert_eq!(status.frames_captured, 0);
        assert_eq!(status.dropped_frames, 0);
    }

    #[test]
    fn idle_status_has_no_active_camera_identity() {
        let status = idle_status(None);

        assert_eq!(status.state, PreviewCameraState::DeviceMissing);
        assert_eq!(status.camera_id, None);
        assert_eq!(status.device_unique_id, None);
    }

    #[test]
    fn mirrors_rgba_rows_in_place() {
        let mut pixels = vec![1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255];

        mirror_rgba_in_place(&mut pixels, 4, 1);

        assert_eq!(
            pixels,
            vec![4, 0, 0, 255, 3, 0, 0, 255, 2, 0, 0, 255, 1, 0, 0, 255]
        );
    }

    #[test]
    fn downscales_camera_preview_png_payload() {
        let bytes = vec![255; 8 * 4 * 4];

        let (scaled, width, height) = downscale_rgba_for_preview(bytes, 8, 4, 4);

        assert_eq!(width, 4);
        assert_eq!(height, 2);
        assert_eq!(scaled.len(), 4 * 2 * 4);
    }

    #[test]
    fn downscales_camera_preview_with_filtered_sampling() {
        let bytes = vec![0, 0, 0, 255, 255, 255, 255, 255];

        let (scaled, width, height) = downscale_rgba_for_preview(bytes, 2, 1, 1);

        assert_eq!(width, 1);
        assert_eq!(height, 1);
        assert!(
            scaled[0] > 0 && scaled[0] < 255,
            "expected filtered red channel, got {}",
            scaled[0]
        );
        assert_eq!(scaled[0], scaled[1]);
        assert_eq!(scaled[1], scaled[2]);
        assert_eq!(scaled[3], 255);
    }

    #[test]
    fn camera_png_width_defaults_and_clamps_requested_quality() {
        assert_eq!(preview_camera_png_max_width(None), 1280);
        assert_eq!(preview_camera_png_max_width(Some(0)), 1);
        assert_eq!(preview_camera_png_max_width(Some(1280)), 1280);
        assert_eq!(preview_camera_png_max_width(Some(4096)), 1920);
    }

    #[test]
    fn camera_capture_cpu_copy_is_skipped_only_for_native_zero_copy_source_handle() {
        assert!(should_skip_camera_capture_cpu_copy_for_config(
            true, true, true, false
        ));
        assert!(!should_skip_camera_capture_cpu_copy_for_config(
            false, true, true, false
        ));
        assert!(!should_skip_camera_capture_cpu_copy_for_config(
            true, false, true, false
        ));
        assert!(!should_skip_camera_capture_cpu_copy_for_config(
            true, true, false, false
        ));
        assert!(!should_skip_camera_capture_cpu_copy_for_config(
            true, true, true, true
        ));
    }

    #[test]
    fn camera_start_params_keep_layout_and_video_contract() {
        let params = PreviewCameraStartParams {
            sources: crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: Some("camera:avfoundation-native:abc123".to_string()),
                microphone_id: None,
                test_pattern: false,
            },
            layout: test_layout(true),
            video: test_video(),
            ffmpeg_path: None,
        };

        assert_eq!(params.video.fps, 60);
        assert!(params.layout.camera_mirror);
    }

    #[test]
    fn selects_avfoundation_camera_source() {
        assert_eq!(
            selected_camera_source("camera:avfoundation-native:616263").unwrap(),
            SelectedCameraSource::MacAvFoundation {
                unique_id: "abc".to_string()
            }
        );
    }

    #[test]
    fn selects_windows_dshow_camera_source() {
        assert_eq!(
            selected_camera_source("camera:windows-dshow:5553422043616d657261").unwrap(),
            SelectedCameraSource::WindowsDshow {
                device_name: "USB Camera".to_string()
            }
        );
    }

    #[test]
    fn windows_camera_preview_ffmpeg_args_emit_raw_bgra_frames() {
        let config = NativeCameraPreviewConfig {
            camera_id: "camera:windows-dshow:5553422043616d657261".to_string(),
            unique_id: "USB Camera".to_string(),
            ffmpeg_path: "C:\\ffmpeg\\bin\\ffmpeg.exe".to_string(),
            video: test_video(),
            layout: test_layout(false),
        };
        let (width, height) = windows_camera_preview_output_dimensions(&config);
        let args = windows_camera_preview_ffmpeg_args(&config, width, height, config.video.fps);

        assert_eq!((width, height), (1920, 1080));
        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-i", "video=USB Camera"])
        );
        assert!(args.iter().any(|arg| arg.contains("scale=1920:1080")));
        assert!(!args.iter().any(|arg| arg.starts_with("fps=")));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "bgra"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "rawvideo"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn windows_camera_preview_prefers_explicit_mjpeg_device_mode() {
        let config = NativeCameraPreviewConfig {
            camera_id: "camera:windows-dshow:5553422043616d657261".to_string(),
            unique_id: "USB Camera".to_string(),
            ffmpeg_path: "C:\\ffmpeg\\bin\\ffmpeg.exe".to_string(),
            video: test_video(),
            layout: test_layout(false),
        };
        let args = windows_camera_preview_ffmpeg_args_mode(
            &config,
            1280,
            720,
            30,
            Some(30),
            Some((1280, 720)),
        );

        let input_index = args
            .iter()
            .position(|arg| arg == "-i")
            .expect("DirectShow input marker");
        assert!(
            args[..input_index]
                .windows(2)
                .any(|pair| { pair == ["-video_size", "1280x720"] })
        );
        assert!(
            args[..input_index]
                .windows(2)
                .any(|pair| pair == ["-vcodec", "mjpeg"])
        );
        assert!(
            args[..input_index]
                .windows(2)
                .any(|pair| pair == ["-framerate", "30"])
        );
    }

    #[test]
    fn windows_camera_overlay_uses_supported_mjpeg_capture_shape() {
        let modes = windows_camera_mjpeg_capture_modes(360, 203);

        assert_eq!(modes.first().copied(), Some((640, 360)));
    }

    #[test]
    fn windows_camera_default_format_retry_caps_high_fps_without_duplicating_low_fps() {
        fn selected_frame_count(source_fps: u32, target_fps: u32) -> usize {
            let mut previous_selected_t = None;
            let mut selected = 0;
            for frame_index in 0..source_fps {
                let timestamp = f64::from(frame_index) / f64::from(source_fps);
                let should_select = previous_selected_t.is_none_or(|previous| {
                    timestamp - previous + WINDOWS_CAMERA_RATE_CAP_EPSILON_SECONDS
                        >= 1.0 / f64::from(target_fps)
                });
                if should_select {
                    previous_selected_t = Some(timestamp);
                    selected += 1;
                }
            }
            selected
        }

        let config = NativeCameraPreviewConfig {
            camera_id: "camera:windows-dshow:5553422043616d657261".to_string(),
            unique_id: "USB Camera".to_string(),
            ffmpeg_path: "C:\\ffmpeg\\bin\\ffmpeg.exe".to_string(),
            video: test_video(),
            layout: test_layout(false),
        };

        let args = windows_camera_preview_ffmpeg_args_opts(&config, 1920, 1080, 30, None);
        let filter = args
            .windows(2)
            .find_map(|pair| (pair[0] == "-vf").then_some(pair[1].as_str()))
            .expect("video filter");

        assert!(!args.iter().any(|arg| arg == "-framerate"));
        assert!(filter.contains("select='isnan(prev_selected_t)"));
        assert!(filter.contains("gte(t-prev_selected_t+0.000001\\,1/30)"));
        assert!(!filter.starts_with("fps="));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-fps_mode", "passthrough"])
        );
        assert_eq!(selected_frame_count(60, 30), 30);
        assert_eq!(selected_frame_count(15, 30), 15);

        let just_below_boundary = (1.0 / 30.0) - (WINDOWS_CAMERA_RATE_CAP_EPSILON_SECONDS / 2.0);
        assert!(
            just_below_boundary + WINDOWS_CAMERA_RATE_CAP_EPSILON_SECONDS >= 1.0 / 30.0,
            "the epsilon must retain a frame whose timestamp rounds just below the boundary"
        );
    }

    #[test]
    fn rejects_unsupported_camera_source_ids() {
        assert!(selected_camera_source("camera:avfoundation:0").is_none());
        assert!(selected_camera_source("camera:windows-dshow:not-hex").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn zero_copy_camera_capture_prefers_bgra_when_available() {
        use objc2_core_video::{kCVPixelFormatType_32BGRA, kCVPixelFormatType_422YpCbCr8};

        let selected = super::macos::select_preferred_capture_pixel_format(
            &[kCVPixelFormatType_422YpCbCr8, kCVPixelFormatType_32BGRA],
            true,
        );

        assert_eq!(selected, kCVPixelFormatType_32BGRA);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn non_zero_copy_camera_capture_keeps_yuv_preference() {
        use objc2_core_video::{kCVPixelFormatType_32BGRA, kCVPixelFormatType_422YpCbCr8};

        let selected = super::macos::select_preferred_capture_pixel_format(
            &[kCVPixelFormatType_422YpCbCr8, kCVPixelFormatType_32BGRA],
            false,
        );

        assert_eq!(selected, kCVPixelFormatType_422YpCbCr8);
    }

    #[test]
    fn camera_only_capture_target_keeps_output_resolution() {
        let layout = test_layout(false);
        let video = test_video();

        assert_eq!(
            camera_capture_target_dimensions(&layout, &video),
            (video.width, video.height)
        );
    }

    #[test]
    fn side_by_side_capture_target_keeps_output_resolution() {
        let mut layout = test_layout(false);
        layout.layout_preset = LayoutPreset::SideBySide;
        let video = test_video();

        assert_eq!(
            camera_capture_target_dimensions(&layout, &video),
            (video.width, video.height)
        );
    }

    #[test]
    fn screen_camera_capture_target_keeps_output_resolution() {
        // Capture geometry is layout-invariant: the inset preset captures the
        // SAME full canvas as every other preset, so a camera-only <->
        // screen+camera switch can never invalidate a running camera session
        // (owner-reported restarts with renegotiation garbage through 0.9.64).
        let mut layout = test_layout(false);
        layout.layout_preset = LayoutPreset::ScreenCamera;
        layout.camera_size = CameraSize::Medium;
        layout.camera_shape = CameraShape::Rectangle;
        let video = test_video();

        assert_eq!(
            camera_capture_target_dimensions(&layout, &video),
            (video.width, video.height)
        );
    }

    #[test]
    fn windows_screen_camera_preview_uses_overlay_sized_bgra_buffer() {
        let mut layout = test_layout(false);
        layout.layout_preset = LayoutPreset::ScreenCamera;
        layout.camera_size = CameraSize::Medium;
        layout.camera_shape = CameraShape::Rectangle;
        let config = NativeCameraPreviewConfig {
            camera_id: "camera:windows-dshow:5553422043616d657261".to_string(),
            unique_id: "USB Camera".to_string(),
            ffmpeg_path: "C:\\ffmpeg\\bin\\ffmpeg.exe".to_string(),
            video: test_video(),
            layout,
        };

        assert_eq!(
            windows_camera_preview_output_dimensions(&config),
            (540, 305)
        );
    }

    #[test]
    fn camera_overlay_publish_dimensions_preserve_source_aspect() {
        assert_eq!(
            fit_camera_source_in_target_box(1920, 1080, 1280, 720),
            (1280, 720)
        );
        assert_eq!(
            fit_camera_source_in_target_box(1920, 1080, 1000, 720),
            (1000, 563)
        );
    }

    #[test]
    fn camera_overlay_publish_dimensions_do_not_upscale_source() {
        assert_eq!(
            fit_camera_source_in_target_box(640, 480, 1280, 720),
            (640, 480)
        );
    }

    #[test]
    fn camera_capture_timing_window_reset_drops_warmup_gaps() {
        let mut timings = CameraCaptureTimingWindow::default();
        let now = Instant::now();

        timings.record_callback_at(now);
        timings.record_callback_at(now + Duration::from_millis(180));
        timings.record_sample_pts(Some(0.0));
        timings.record_sample_pts(Some(0.180));
        assert_eq!(timings.snapshot().sample_pts_gap_p95_ms, Some(180.0));

        timings.reset();
        let reset_snapshot = timings.snapshot();
        assert_eq!(reset_snapshot.capture_gap_p95_ms, None);
        assert_eq!(reset_snapshot.sample_pts_gap_p95_ms, None);

        timings.record_callback_at(now + Duration::from_millis(220));
        timings.record_callback_at(now + Duration::from_millis(253));
        timings.record_sample_pts(Some(0.220));
        timings.record_sample_pts(Some(0.253));

        assert_eq!(timings.snapshot().capture_gap_p95_ms, Some(33.0));
        assert_eq!(timings.snapshot().sample_pts_gap_p95_ms, Some(33.0));
    }

    #[tokio::test]
    async fn camera_registry_preview_consumer_releases_on_stop() {
        let state = test_state();
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        {
            let mut slot = state.preview_camera.lock().await;
            slot.source_key = Some(source_key.clone());
        }

        acquire_preview_camera_source(&state, source_key.clone(), SourceLifecycleStatus::Live)
            .await;
        let keep_alive = release_current_preview_camera_source(&state).await;
        let snapshot = state.source_registry.lock().await.snapshot();
        let entry = snapshot
            .entries
            .iter()
            .find(|entry| entry.key == source_key)
            .expect("camera source entry");

        assert!(!keep_alive);
        assert!(entry.consumers.is_empty());
        assert_eq!(entry.status, SourceLifecycleStatus::Stopped);
    }

    #[tokio::test]
    async fn camera_start_cannot_install_after_screen_only_retirement() {
        let state = test_state();
        let video = test_video();
        let layout = test_layout(false);
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        let start_key = PreviewCameraStartKey {
            source_key: source_key.clone(),
            ffmpeg_path: "ffmpeg".to_string(),
            video: video.clone(),
            target_fps: video.fps,
            capture_target: camera_capture_target_dimensions(&layout, &video),
        };
        let starting = PreviewCameraStatus {
            state: PreviewCameraState::Starting,
            camera_id: Some(source_key.id.clone()),
            device_unique_id: Some("test".to_string()),
            target_fps: video.fps,
            width: None,
            height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            selected_format_width: None,
            selected_format_height: None,
            selected_format_min_fps: None,
            selected_format_max_fps: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Starting native camera preview.".to_string()),
        };

        let lease = match begin_camera_start(&state, start_key, &layout, starting, None).await {
            PreviewCameraStartRegistration::Started { lease } => lease,
            PreviewCameraStartRegistration::JoinExisting { .. } => {
                panic!("first start must own a lease")
            }
            PreviewCameraStartRegistration::Reused(_) => panic!("first start cannot reuse"),
            PreviewCameraStartRegistration::RejectedSuperseded(_)
            | PreviewCameraStartRegistration::RejectedShutdown(_) => {
                panic!("test process is not shutting down")
            }
        };

        // Screen-only retires camera capture while the old native startup thread
        // is still discovering/starting its device.
        let stopped = stop_preview_camera(&state).await;
        assert_eq!(stopped.state, PreviewCameraState::DeviceMissing);
        let stale_start_claimed = {
            let mut slot = state.preview_camera.lock().await;
            claim_camera_start(&mut slot, &lease)
        };

        assert!(!stale_start_claimed);
        assert_eq!(
            preview_camera_status(&state).await.state,
            PreviewCameraState::DeviceMissing
        );
    }

    #[tokio::test]
    async fn layout_only_reuse_updates_camera_layout_without_new_run() {
        let state = test_state();
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        let video = test_video();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.source_key = Some(source_key.clone());
            slot.run_id = Some("run-1".to_string());
            slot.status = PreviewCameraStatus {
                state: PreviewCameraState::Live,
                camera_id: Some(source_key.id.clone()),
                device_unique_id: Some("test".to_string()),
                target_fps: video.fps,
                width: Some(video.width),
                height: Some(video.height),
                requested_width: Some(video.width),
                requested_height: Some(video.height),
                actual_width: Some(video.width),
                actual_height: Some(video.height),
                selected_format_width: Some(video.width),
                selected_format_height: Some(video.height),
                selected_format_min_fps: Some(1.0),
                selected_format_max_fps: Some(f64::from(video.fps)),
                source_fps: Some(f64::from(video.fps)),
                frame_age_ms: Some(5),
                frames_captured: 42,
                dropped_frames: 0,
                sequence: Some(42),
                updated_at: Utc::now().to_rfc3339(),
                message: Some("Live".to_string()),
            };
            slot.start_generation = 1;
            slot.active_generation = Some(1);
            slot.active = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
                camera_id: source_key.id.clone(),
                device_unique_id: "test".to_string(),
                ffmpeg_path: "ffmpeg".to_string(),
                layout: test_layout(false),
                video: video.clone(),
                effective_fps: video.fps,
                configured_output: (video.width, video.height),
                capture_target: camera_capture_target_dimensions(&test_layout(false), &video),
            });
        }

        assert!(
            reuse_current_camera_source(
                &state,
                &source_key,
                "/custom/ffmpeg",
                &test_layout(true),
                &video,
                video.fps
            )
            .await
            .is_none()
        );

        let status = reuse_current_camera_source(
            &state,
            &source_key,
            "ffmpeg",
            &test_layout(true),
            &video,
            video.fps,
        )
        .await
        .expect("camera source should be reused");
        let slot = state.preview_camera.lock().await;

        assert_eq!(status.sequence, Some(42));
        assert_eq!(slot.run_id.as_deref(), Some("run-1"));
        assert!(
            slot.active
                .as_ref()
                .expect("active camera")
                .layout
                .camera_mirror
        );
        assert_eq!(
            status.message.as_deref(),
            Some("Native camera preview source reused.")
        );
    }
    #[tokio::test]
    async fn reuse_refuses_a_session_with_stale_capture_geometry() {
        // Capture geometry is layout-invariant, so only a genuine output
        // canvas change (video preset/orientation) can make it stale. A
        // session capturing the old canvas keeps delivering frames sized for
        // it, so reuse must force a restart instead of adopting them.
        let state = test_state();
        let video = test_video();
        let mut larger_canvas = test_video();
        larger_canvas.preset = VideoPreset::Tutorial1440p30;
        larger_canvas.width = 2560;
        larger_canvas.height = 1440;
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        let full_canvas_layout = test_layout(false);
        let inset_layout = {
            let mut layout = test_layout(false);
            layout.layout_preset = LayoutPreset::ScreenCamera;
            layout
        };
        assert_eq!(
            camera_capture_target_dimensions(&full_canvas_layout, &video),
            camera_capture_target_dimensions(&inset_layout, &video),
            "presets must share ONE capture box — a preset switch never restarts the camera"
        );
        assert_ne!(
            camera_capture_target_dimensions(&full_canvas_layout, &video),
            camera_capture_target_dimensions(&full_canvas_layout, &larger_canvas),
            "an output canvas change must derive a different capture box for this test"
        );
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.source_key = Some(source_key.clone());
            slot.status.state = PreviewCameraState::Live;
            slot.status.target_fps = video.fps;
            slot.start_generation = 1;
            slot.active_generation = Some(1);
            slot.active = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
                camera_id: source_key.id.clone(),
                device_unique_id: "test".to_string(),
                ffmpeg_path: "ffmpeg".to_string(),
                layout: inset_layout.clone(),
                video: video.clone(),
                effective_fps: video.fps,
                configured_output: (video.width, video.height),
                capture_target: camera_capture_target_dimensions(&inset_layout, &video),
            });
        }

        assert!(
            reuse_current_camera_source(
                &state,
                &source_key,
                "ffmpeg",
                &full_canvas_layout,
                &larger_canvas,
                larger_canvas.fps
            )
            .await
            .is_none(),
            "a capture-geometry mismatch must not be reused"
        );
        assert!(
            camera_capture_geometry_is_stale(&state, &full_canvas_layout, &larger_canvas).await,
            "the staleness probe must agree with reuse"
        );
        assert!(
            !camera_capture_geometry_is_stale(&state, &full_canvas_layout, &video).await,
            "the same canvas must not report stale — regardless of preset"
        );
        assert!(
            !camera_capture_geometry_is_stale(&state, &inset_layout, &video).await,
            "a preset switch alone must NEVER report stale"
        );
    }

    #[tokio::test]
    async fn frameless_live_slot_past_grace_is_a_zombie() {
        // The Cam Link failure shape: Live acked, zero frames ever, grace long
        // gone. The next same-key start must tear down and truly restart.
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Live;
            slot.status.camera_id = Some("camera:test".to_string());
            slot.status.frames_captured = 0;
            slot.status.sequence = None;
            slot.source_key = Some(SourceKey::camera("camera:test".to_string()));
            slot.live_acked_at =
                Some(Instant::now() - CAMERA_FIRST_FRAME_REUSE_GRACE - Duration::from_millis(1));
        }
        assert!(camera_live_session_is_frameless_zombie(&state).await);
    }

    #[tokio::test]
    async fn frameless_recovery_eligibility_is_live_generation_exact() {
        let state = test_state();
        let layout = crate::protocol::default_layout_settings();
        let video = test_video();
        test_install_live_camera_for_layout(&state, "camera:test", &layout, &video).await;
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.frames_captured = 0;
            slot.status.sequence = None;
            slot.status.actual_width = None;
            slot.status.actual_height = None;
            slot.live_acked_at = Some(Instant::now());
            slot.active.as_mut().unwrap().shared =
                Arc::new(StdMutex::new(PreviewCameraShared::default()));
        }
        let snapshot = preview_camera_restart_snapshot(&state)
            .await
            .expect("stable frameless Live generation");
        assert!(
            !preview_camera_restart_snapshot_is_frameless_zombie(&state, &snapshot).await,
            "the exact Live generation remains protected during first-frame warm-up"
        );

        {
            let mut slot = state.preview_camera.lock().await;
            slot.live_acked_at =
                Some(Instant::now() - CAMERA_FIRST_FRAME_REUSE_GRACE - Duration::from_millis(1));
        }
        assert!(
            preview_camera_restart_snapshot_is_frameless_zombie(&state, &snapshot).await,
            "the exact generation becomes recovery-eligible after the shared grace"
        );

        let mut stale = snapshot;
        stale.generation = stale.generation.wrapping_add(1);
        assert!(
            !preview_camera_restart_snapshot_is_frameless_zombie(&state, &stale).await,
            "a retired/source-switch generation cannot authorize recovery"
        );
    }

    #[tokio::test]
    async fn forced_recovery_registers_source_transition_before_native_completion() {
        let state = test_state();
        let layout = test_layout(false);
        let video = test_video();
        install_restartable_camera(&state, 41, &layout, &video).await;
        let expected = preview_camera_restart_snapshot(&state)
            .await
            .expect("live restart snapshot");
        let recovery_epoch = 303;
        state.set_capture_recovery_admission_epoch(recovery_epoch);

        let transition_gate = Arc::clone(&state.preview_camera.lock().await.transition_gate);
        let held_native_transition = transition_gate.lock_owned().await;
        let prior_sequence = state.source_transition_fence.accepted_sequence();
        let attempt = admit_force_restart_preview_camera(&state, &expected, recovery_epoch)
            .await
            .expect("exact recovery admission");

        assert_eq!(
            state.source_transition_fence.accepted_sequence(),
            prior_sequence + 1,
            "admission must publish transition ownership before returning"
        );
        let transition = state.source_transition_fence.observe();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), transition.wait())
                .await
                .is_err(),
            "native completion is still blocked behind the physical transition gate"
        );

        state.request_process_shutdown();
        drop(held_native_transition);
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            complete_force_restart_preview_camera(&state, attempt),
        )
        .await
        .expect("shutdown-latched recovery supervisor must retire");
        tokio::time::timeout(Duration::from_secs(1), transition.wait())
            .await
            .expect("source-transition guard must release after retirement");
    }

    #[tokio::test]
    async fn frameless_live_slot_within_grace_is_not_a_zombie() {
        // A camera that acked Live a moment ago is still warming up; the
        // readiness wait owns that window, not a forced restart.
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Live;
            slot.status.frames_captured = 0;
            slot.status.sequence = None;
            slot.live_acked_at = Some(Instant::now());
        }
        assert!(!camera_live_session_is_frameless_zombie(&state).await);
    }

    #[tokio::test]
    async fn frameless_live_slot_inside_the_warm_start_budget_is_not_a_zombie() {
        // The 0.9.51 Cam Link retry storm: a slow external device 10s into its
        // warm-up (past the old 4s grace) was torn down by every retry, so its
        // first frame could never arrive. A retry must JOIN this warm-up.
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Live;
            slot.status.camera_id = Some("camera:test".to_string());
            slot.status.frames_captured = 0;
            slot.status.sequence = None;
            slot.source_key = Some(SourceKey::camera("camera:test".to_string()));
            slot.live_acked_at = Some(Instant::now() - Duration::from_secs(10));
        }
        assert!(!camera_live_session_is_frameless_zombie(&state).await);
    }

    #[tokio::test]
    async fn live_slot_with_frame_evidence_is_never_a_zombie() {
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Live;
            slot.status.frames_captured = 42;
            slot.live_acked_at =
                Some(Instant::now() - CAMERA_FIRST_FRAME_REUSE_GRACE - Duration::from_secs(60));
        }
        assert!(!camera_live_session_is_frameless_zombie(&state).await);
    }

    #[tokio::test]
    async fn non_live_slot_is_not_a_zombie() {
        // Starting/Failed/DeviceMissing states have their own handling; the
        // zombie teardown must never fire for them.
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Starting;
            slot.live_acked_at =
                Some(Instant::now() - CAMERA_FIRST_FRAME_REUSE_GRACE - Duration::from_secs(60));
        }
        assert!(!camera_live_session_is_frameless_zombie(&state).await);
    }

    #[tokio::test]
    async fn frameless_live_slot_with_no_ack_timestamp_is_a_zombie() {
        // A Live status with no recorded ack time (state restored oddly, or a
        // pre-fix session) has no claim to the warmup grace.
        let state = test_state();
        {
            let mut slot = state.preview_camera.lock().await;
            slot.status.state = PreviewCameraState::Live;
            slot.status.frames_captured = 0;
            slot.live_acked_at = None;
        }
        assert!(camera_live_session_is_frameless_zombie(&state).await);
    }
}
