use std::sync::{Arc, Mutex as StdMutex, TryLockError, mpsc as std_mpsc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use rayon::prelude::*;
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
    PreviewCameraState, PreviewCameraStatus, VideoSettings,
};
use crate::source_registry::{SourceConsumerReason, SourceKey};
use crate::source_status::SourceLifecycleStatus;
use crate::state::AppState;

const PREVIEW_CAMERA_DEFAULT_PNG_WIDTH: u32 = 1280;
const PREVIEW_CAMERA_MAX_PNG_WIDTH: u32 = 1920;
#[cfg(any(target_os = "windows", test))]
const CAMERA_REFERENCE_WIDTH: u32 = 1280;
#[cfg(any(target_os = "windows", test))]
const CAMERA_REFERENCE_HEIGHT: u32 = 720;
const CAMERA_CAPTURE_CPU_COPY_ENV: &str = "VIDEORC_CAMERA_CAPTURE_CPU_COPY";
const WINDOWS_CAMERA_PREVIEW_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
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
    /// The params of the most recent start, retained so capture-health can
    /// restart the source with the user's exact configuration (auto-heal for
    /// the 2026-08-28 quantized-6fps camera collapse).
    last_start_params: Option<PreviewCameraStartParams>,
    /// Source-level ownership keeps surface-backed frames observable while a
    /// capture session replaces its per-session `FrameStore`.
    surface_backing_tracker: SurfaceBackingTrackerHandle,
    run_id: Option<String>,
    source_key: Option<SourceKey>,
    starting: Option<PreviewCameraStartKey>,
    start_generation: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewCameraStartLease {
    key: PreviewCameraStartKey,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreviewCameraStartRegistration {
    JoinExisting,
    Started(PreviewCameraStartLease),
}

#[derive(Debug)]
struct NativeCameraPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewCameraShared>>,
    ffmpeg_path: String,
    layout: LayoutSettings,
    video: VideoSettings,
    /// The capture target box this session's AVFoundation output geometry was
    /// derived from at start. `layout` above is refreshed on reuse as
    /// bookkeeping, so it cannot answer "what geometry is this session
    /// actually delivering" — this field can.
    capture_target: (u32, u32),
}

/// Fast half of a camera stop. Runtime ownership has already been detached and
/// the capture thread has been signalled; only the potentially slow thread join
/// remains. This lets layout retirement make its intent check and detach atomic
/// without holding the layout-intent mutex across a blocking join.
pub(crate) struct PreviewCameraStop {
    status: PreviewCameraStatus,
    join_handle: Option<thread::JoinHandle<()>>,
}

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
}

impl PreviewCameraFrameSource {
    pub fn source_key(&self) -> Option<&SourceKey> {
        self.source_key.as_ref()
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

pub fn initial_preview_camera_state() -> PreviewCameraRuntime {
    PreviewCameraRuntime {
        status: idle_status(Some("Native camera preview is not running.".to_string())),
        last_start_params: None,
        surface_backing_tracker: SurfaceBackingTrackerHandle::default(),
        run_id: None,
        source_key: None,
        starting: None,
        start_generation: 0,
        active: None,
        poll_task: None,
        live_acked_at: None,
    }
}

pub async fn start_preview_camera(
    state: AppState,
    params: PreviewCameraStartParams,
) -> PreviewCameraStatus {
    let Some(camera_id) = params.sources.camera_id.clone() else {
        stop_preview_camera(&state).await;
        refresh_camera_capability_diagnostics(&state, None).await;
        let status = status_for_missing_camera(None, "No camera is selected.");
        set_camera_status(&state, status.clone()).await;
        return status;
    };
    let Some(camera_source) = selected_camera_source(&camera_id) else {
        stop_preview_camera(&state).await;
        refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;
        let status = status_for_missing_camera(
            Some(camera_id),
            "Selected camera is not a supported Videorc camera source.",
        );
        set_camera_status(&state, status.clone()).await;
        return status;
    };
    let unique_id = camera_source.device_unique_id().to_string();
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());
    refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;

    let target_fps = params.video.fps.clamp(1, 120);
    let source_key = SourceKey::camera(camera_id.clone());
    let existing_source_key = current_camera_source_key(&state).await;
    if existing_source_key.as_ref() != Some(&source_key) {
        let keep_alive = release_current_preview_camera_source(&state).await;
        if !keep_alive {
            stop_current_camera(&state).await;
        }
    } else if camera_live_session_is_frameless_zombie(&state).await {
        // Same source key, status Live — but the session never delivered a
        // single frame and its first-frame grace has elapsed. Exclusive
        // devices (Elgato Cam Link) get here when startRunning() succeeds
        // while the device is mid-renegotiation or still held by a closing
        // session: AVFoundation reports running, no sample buffer ever
        // arrives, and the reuse path below would hand that dead status back
        // forever. Tear the session down so this start is a real restart.
        stop_current_camera(&state).await;
    }
    acquire_preview_camera_source(&state, source_key.clone(), SourceLifecycleStatus::Starting)
        .await;
    if let Some(status) = reuse_current_camera_source(
        &state,
        &source_key,
        &ffmpeg_path,
        &params.layout,
        &params.video,
        target_fps,
    )
    .await
    {
        acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Live).await;
        state.emit_event("preview.camera.status", status.clone());
        return status;
    }

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
    let start_lease = match begin_camera_start(&state, start_key.clone(), starting).await {
        PreviewCameraStartRegistration::JoinExisting => {
            return wait_for_camera_start(&state, &start_key).await;
        }
        PreviewCameraStartRegistration::Started(lease) => lease,
    };

    stop_current_camera_for_restart(&state).await;
    state.preview_camera.lock().await.last_start_params = Some(params.clone());

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

    let join_handle = thread::Builder::new()
        .name("videorc-preview-camera".to_string())
        .spawn(move || {
            run_native_camera_preview(thread_config, thread_shared, stop_rx, startup_tx)
        });

    let join_handle = match join_handle {
        Ok(join_handle) => join_handle,
        Err(error) => {
            let status = failed_status(
                Some(camera_id),
                Some(unique_id),
                target_fps,
                format!("Could not start camera thread: {error}"),
            );
            if set_camera_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Failed)
                    .await;
                return status;
            }
            return preview_camera_status(&state).await;
        }
    };

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
            let status = PreviewCameraStatus {
                state: PreviewCameraState::Live,
                camera_id: Some(camera_id),
                device_unique_id: Some(unique_id),
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
            let mut started_thread = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: Some(join_handle),
                shared: Arc::clone(&shared),
                ffmpeg_path,
                layout: params.layout,
                video: params.video,
                capture_target,
            });
            let installed = {
                let mut slot = state.preview_camera.lock().await;
                if !claim_camera_start(&mut slot, &start_lease) {
                    false
                } else {
                    slot.status = status.clone();
                    slot.run_id = Some(run_id.clone());
                    slot.source_key = Some(source_key.clone());
                    slot.active = started_thread.take();
                    slot.live_acked_at = Some(Instant::now());
                    true
                }
            };
            if !installed {
                if let Some(mut stale_thread) = started_thread {
                    let _ = stale_thread.stop_tx.send(());
                    if let Some(join_handle) = stale_thread.join_handle.take() {
                        let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
                    }
                }
                return preview_camera_status(&state).await;
            }
            let poll_task = tokio::spawn(poll_camera_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                target_fps,
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
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
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
            if set_camera_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_camera_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::PermissionNeeded,
                )
                .await;
                status
            } else {
                preview_camera_status(&state).await
            }
        }
        NativeCameraStartup::DeviceMissing(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
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
            if set_camera_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_camera_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::SourceMissing,
                )
                .await;
                status
            } else {
                preview_camera_status(&state).await
            }
        }
        NativeCameraStartup::Failed(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = failed_status(Some(camera_id), Some(unique_id), target_fps, message);
            if set_camera_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Failed)
                    .await;
                status
            } else {
                preview_camera_status(&state).await
            }
        }
    }
}

pub async fn stop_preview_camera(state: &AppState) -> PreviewCameraStatus {
    let stop = begin_preview_camera_stop(state).await;
    finish_preview_camera_stop(stop).await
}

pub(crate) async fn begin_preview_camera_stop(state: &AppState) -> PreviewCameraStop {
    let keep_alive = release_current_preview_camera_source(state).await;
    if keep_alive {
        let status = {
            let mut slot = state.preview_camera.lock().await;
            let mut status = slot.status.clone();
            status.updated_at = Utc::now().to_rfc3339();
            status.message =
                Some("Preview consumer released; camera source is still in use.".to_string());
            slot.status = status.clone();
            status
        };
        state.emit_event("preview.camera.status", status.clone());
        return PreviewCameraStop {
            status,
            join_handle: None,
        };
    }

    let status = idle_status(Some("Native camera preview stopped.".to_string()));
    let (previous, poll_task) = {
        let mut slot = state.preview_camera.lock().await;
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = None;
        slot.starting = None;
        slot.live_acked_at = None;
        (slot.active.take(), slot.poll_task.take())
    };
    if let Some(task) = poll_task {
        task.abort();
    }
    let join_handle = previous.and_then(|mut previous| {
        let _ = previous.stop_tx.send(());
        previous.join_handle.take()
    });
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status.clone());
    PreviewCameraStop {
        status,
        join_handle,
    }
}

pub(crate) async fn finish_preview_camera_stop(mut stop: PreviewCameraStop) -> PreviewCameraStatus {
    if let Some(join_handle) = stop.join_handle.take() {
        let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
    }
    stop.status
}

/// Restarts the camera with its retained start parameters — the capture-health
/// auto-heal path. Returns false when there is nothing to restart (no camera
/// was started this run, or it was deliberately stopped).
pub async fn restart_preview_camera_for_health(state: &AppState) -> bool {
    let params = {
        let slot = state.preview_camera.lock().await;
        if slot.run_id.is_none() {
            None
        } else {
            slot.last_start_params.clone()
        }
    };
    let Some(params) = params else {
        return false;
    };
    let status = start_preview_camera(state.clone(), params).await;
    tracing::info!(
        "Camera auto-restart requested by capture-health finished with state {:?}.",
        status.state
    );
    true
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
    Some(PreviewCameraFrameSource {
        shared: Arc::clone(&active.shared),
        layout: active.layout.clone(),
        source_key: slot.source_key.clone(),
    })
}

pub fn try_preview_camera_frame_source(
    state: &AppState,
) -> Result<Option<PreviewCameraFrameSource>, ()> {
    let slot = state.preview_camera.try_lock().map_err(|_| ())?;
    let Some(active) = slot.active.as_ref() else {
        return Ok(None);
    };
    Ok(Some(PreviewCameraFrameSource {
        shared: Arc::clone(&active.shared),
        layout: active.layout.clone(),
        source_key: slot.source_key.clone(),
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
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
}

async fn stop_current_camera(state: &AppState) {
    stop_current_camera_inner(state, true).await;
}

async fn stop_current_camera_for_restart(state: &AppState) {
    stop_current_camera_inner(state, false).await;
}

async fn stop_current_camera_inner(state: &AppState, clear_starting: bool) {
    let (previous, poll_task) = {
        let mut slot = state.preview_camera.lock().await;
        slot.run_id = None;
        slot.live_acked_at = None;
        if clear_starting {
            slot.source_key = None;
            slot.starting = None;
        }
        (slot.active.take(), slot.poll_task.take())
    };

    if let Some(task) = poll_task {
        task.abort();
    }

    if let Some(mut previous) = previous {
        let _ = previous.stop_tx.send(());
        if let Some(join_handle) = previous.join_handle.take() {
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
        }
    }
}

async fn begin_camera_start(
    state: &AppState,
    start_key: PreviewCameraStartKey,
    status: PreviewCameraStatus,
) -> PreviewCameraStartRegistration {
    let mut slot = state.preview_camera.lock().await;
    if slot.starting.as_ref() == Some(&start_key) {
        return PreviewCameraStartRegistration::JoinExisting;
    }
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    let lease = PreviewCameraStartLease {
        key: start_key.clone(),
        generation: slot.start_generation,
    };
    slot.status = status.clone();
    slot.run_id = None;
    slot.source_key = Some(start_key.source_key.clone());
    slot.starting = Some(start_key);
    drop(slot);

    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
    PreviewCameraStartRegistration::Started(lease)
}

fn claim_camera_start(slot: &mut PreviewCameraRuntime, lease: &PreviewCameraStartLease) -> bool {
    if slot.start_generation != lease.generation || slot.starting.as_ref() != Some(&lease.key) {
        return false;
    }
    slot.starting = None;
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
    status: PreviewCameraStatus,
) -> bool {
    let source_key = status.camera_id.clone().map(SourceKey::camera);
    {
        let mut slot = state.preview_camera.lock().await;
        if !claim_camera_start(&mut slot, lease) {
            return false;
        }
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = source_key;
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
    true
}

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

async fn release_current_preview_camera_source(state: &AppState) -> bool {
    let Some(source_key) = current_camera_source_key(state).await else {
        return false;
    };
    let snapshot = state
        .source_registry
        .lock()
        .await
        .release(&source_key, &SourceConsumerReason::Preview);
    snapshot
        .entries
        .iter()
        .find(|entry| entry.key == source_key)
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
async fn camera_live_session_is_frameless_zombie(state: &AppState) -> bool {
    let slot = state.preview_camera.lock().await;
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
    let mut slot = state.preview_camera.lock().await;
    slot.source_key = Some(SourceKey::camera(camera_id.to_string()));
    slot.status.state = PreviewCameraState::Live;
    slot.status.camera_id = Some(camera_id.to_string());
    slot.status.target_fps = video.fps;
    slot.status.frames_captured = 42;
    slot.status.sequence = Some(42);
    slot.live_acked_at = Some(Instant::now());
    slot.active = Some(NativeCameraPreviewThread {
        stop_tx,
        join_handle: None,
        shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
        ffmpeg_path: "ffmpeg".to_string(),
        layout: layout.clone(),
        video: video.clone(),
        capture_target: camera_capture_target_dimensions(layout, video),
    });
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

async fn reuse_current_camera_source(
    state: &AppState,
    source_key: &SourceKey,
    ffmpeg_path: &str,
    layout: &LayoutSettings,
    video: &VideoSettings,
    target_fps: u32,
) -> Option<PreviewCameraStatus> {
    let mut slot = state.preview_camera.lock().await;
    if slot.source_key.as_ref() != Some(source_key) {
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
        configure_device(&device, &selected, config.video.fps)?;

        let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }.map_err(
            |error| NativeCameraStartup::Failed(format!("Could not open camera: {error}")),
        )?;
        let session = unsafe { AVCaptureSession::new() };
        let output = unsafe { AVCaptureVideoDataOutput::new() };
        let delegate = CameraPreviewDelegate::new(shared);
        let queue = DispatchQueue::new("com.videorc.preview.camera", None);

        // AVCaptureSession mutators (`addInput`/`addOutput`/`startRunning`) can also
        // raise NSExceptions for sources AVFoundation refuses; guard them so a
        // refusal fails the camera gracefully instead of aborting the backend.
        let session_result = unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                session.beginConfiguration();
                if session.canSetSessionPreset(AVCaptureSessionPresetInputPriority) {
                    session.setSessionPreset(AVCaptureSessionPresetInputPriority);
                }
                let prefer_zero_copy_source_format =
                    crate::metal_compositor::source_zerocopy_enabled();
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
                Ok(())
            }))
        };
        match session_result {
            Err(exception) => {
                return Err(NativeCameraStartup::Failed(format!(
                    "Camera capture session was rejected by AVFoundation: {}",
                    describe_camera_exception(exception)
                )));
            }
            Ok(Err(startup)) => return Err(startup),
            Ok(Ok(())) => {}
        }

        let layout_detail = layout_detail(&config.layout);
        let message = selected
            .fallback_reason
            .map(|reason| format!("{reason} {layout_detail}"))
            .or_else(|| {
                Some(format!(
                    "Native camera preview running with {}x{} at {:.0} fps. {layout_detail}",
                    selected.output_width, selected.output_height, selected.selected_fps
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
            selected_fps: selected.selected_fps,
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
        selected_fps: f64,
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
        let selected_fps = f64::from(video.fps).clamp(
            selected_entry.0.min_fps.max(1.0),
            selected_entry.0.max_fps.max(1.0),
        );
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
            selected_fps,
            fallback_reason: choice.fallback_reason,
        })
    }

    fn configure_device(
        device: &AVCaptureDevice,
        format: &NativeCameraFormatSelection,
        requested_fps: u32,
    ) -> Result<(), NativeCameraStartup> {
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
            match frame_rate_result {
                Ok(()) => tracing::info!(
                    "Camera frame duration set: {effective_fps:.3} fps ({:?} of range {})",
                    resolution.endpoint,
                    resolution.range_index,
                ),
                Err(exception) => tracing::warn!(
                    "Camera kept its native frame cadence ({effective_fps:.3} fps frame duration was rejected): {}",
                    describe_camera_exception(exception)
                ),
            }
        }

        unsafe { device.unlockForConfiguration() };
        Ok(())
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
    use super::*;
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode, LayoutPreset,
        SideBySideCameraSide, SideBySideSplit, VideoPreset,
    };
    use crate::storage::Database;
    use tokio::sync::broadcast;

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
        let source_key = SourceKey::camera("camera:avfoundation-native:test");
        let start_key = PreviewCameraStartKey {
            source_key: source_key.clone(),
            ffmpeg_path: "ffmpeg".to_string(),
            video: video.clone(),
            target_fps: video.fps,
            capture_target: camera_capture_target_dimensions(&test_layout(false), &video),
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

        let lease = match begin_camera_start(&state, start_key, starting).await {
            PreviewCameraStartRegistration::Started(lease) => lease,
            PreviewCameraStartRegistration::JoinExisting => panic!("first start must own a lease"),
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
            slot.active = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
                ffmpeg_path: "ffmpeg".to_string(),
                layout: test_layout(false),
                video: video.clone(),
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
            slot.active = Some(NativeCameraPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewCameraShared::default())),
                ffmpeg_path: "ffmpeg".to_string(),
                layout: inset_layout.clone(),
                video: video.clone(),
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
