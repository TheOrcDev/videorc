use std::sync::{Arc, Mutex as StdMutex, TryLockError, mpsc as std_mpsc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::diagnostics::{
    PreviewScreenCaptureTimingStats, apply_preview_screen_capture_timing_stats,
    apply_preview_screen_source_stats, apply_preview_source_frame_store_stats,
};
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::frame_store::{FrameHandle, FrameStore, FrameStoreStats};
use crate::preview_bmp::{LatestPreviewBmpPoll, PreviewBmpCursor, encode_latest_bgra_bmp};
use crate::protocol::{
    PreviewScreenSourceKind, PreviewScreenStartParams, PreviewScreenState, PreviewScreenStatus,
    VideoSettings,
};
use crate::screen_capture::{
    is_windows_gdigrab_desktop_screen_id, parse_screencapturekit_display_id,
    parse_screencapturekit_window_id, parse_windows_dxgi_output_index,
};
use crate::source_registry::{SourceConsumerReason, SourceIdentityConfidence, SourceKey};
use crate::source_status::SourceLifecycleStatus;
use crate::state::AppState;

const PREVIEW_SCREEN_DEFAULT_DEBUG_PNG_WIDTH: u32 = 1600;
const PREVIEW_SCREEN_MAX_DEBUG_PNG_WIDTH: u32 = 2560;
const PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_WIDTH: u32 = 3840;
const PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_HEIGHT: u32 = 2160;
const PREVIEW_SCREEN_CAPTURE_QUEUE_DEPTH: u32 = 3;
const PREVIEW_SCREEN_TIMING_WINDOW: usize = 180;
const SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const SCREEN_CAPTUREKIT_DISCOVERY_ATTEMPTS: u32 = 2;
const SCREEN_CAPTUREKIT_STREAM_START_TIMEOUT: Duration = Duration::from_secs(30);
const SCREEN_CAPTURE_CPU_COPY_ENV: &str = "VIDEORC_SCREEN_CAPTURE_CPU_COPY";
const SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT_MESSAGE: &str = "ScreenCaptureKit source discovery timed out after Screen Recording permission preflight passed.";

fn native_screen_preview_thread_startup_timeout() -> Duration {
    SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT
        .saturating_mul(SCREEN_CAPTUREKIT_DISCOVERY_ATTEMPTS)
        .saturating_add(SCREEN_CAPTUREKIT_STREAM_START_TIMEOUT)
        .saturating_add(Duration::from_secs(5))
}

fn native_preview_surface_env_enabled() -> bool {
    // v1 default: the native CAMetalLayer surface IS the production preview. The env
    // var remains a developer kill switch only (VIDEORC_NATIVE_PREVIEW_SURFACE=0).
    match std::env::var("VIDEORC_NATIVE_PREVIEW_SURFACE").ok() {
        Some(value) => truthy_env_value(Some(value.as_str())),
        None => true,
    }
}

fn forced_screen_capture_cpu_copy_enabled() -> bool {
    truthy_env_value(std::env::var(SCREEN_CAPTURE_CPU_COPY_ENV).ok().as_deref())
}

fn truthy_env_value(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn should_skip_screen_capture_cpu_copy_for_config(
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

fn should_skip_screen_capture_cpu_copy(zero_copy_source_handle_available: bool) -> bool {
    should_skip_screen_capture_cpu_copy_for_config(
        zero_copy_source_handle_available,
        source_zerocopy_enabled(),
        native_preview_surface_env_enabled(),
        forced_screen_capture_cpu_copy_enabled(),
    )
}

#[cfg(target_os = "macos")]
use crate::metal_compositor::source_zerocopy_enabled;

/// Zero-copy source handoff is Metal/IOSurface-backed and exists only on macOS.
#[cfg(not(target_os = "macos"))]
fn source_zerocopy_enabled() -> bool {
    false
}

pub type PreviewScreenSlot = Arc<tokio::sync::Mutex<PreviewScreenRuntime>>;

#[derive(Debug)]
pub struct PreviewScreenRuntime {
    pub status: PreviewScreenStatus,
    run_id: Option<String>,
    source_key: Option<SourceKey>,
    starting: Option<PreviewScreenStartKey>,
    start_generation: u64,
    active: Option<NativeScreenPreviewThread>,
    poll_task: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewScreenStartKey {
    source_key: SourceKey,
    ffmpeg_path: String,
    video: VideoSettings,
    target_fps: u32,
    protected_overlay_window_ids: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewScreenStartLease {
    key: PreviewScreenStartKey,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreviewScreenStartRegistration {
    JoinExisting,
    Started(PreviewScreenStartLease),
}

#[derive(Debug)]
struct NativeScreenPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    ffmpeg_path: String,
    video: VideoSettings,
    protected_overlay_window_ids: Vec<u32>,
}

/// Fast half of a screen stop. Runtime ownership has already been detached and
/// the capture thread has been signalled; only the potentially slow thread join
/// remains. Layout retirement can therefore keep its intent check and detach on
/// one atomic edge without holding the intent mutex during the join.
pub(crate) struct PreviewScreenStop {
    status: PreviewScreenStatus,
    join_handle: Option<thread::JoinHandle<()>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewScreenPixelFormat {
    Bgra8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewScreenFrameInfo {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub frame_age_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PreviewScreenFrameSource {
    shared: Arc<StdMutex<PreviewScreenShared>>,
    source_key: Option<SourceKey>,
}

impl PreviewScreenFrameSource {
    pub fn source_key(&self) -> Option<&SourceKey> {
        self.source_key.as_ref()
    }

    pub fn try_latest_frame_result(
        &self,
    ) -> Result<Option<FrameHandle<PreviewScreenPixelFormat>>, ()> {
        match self.shared.try_lock() {
            Ok(guard) => Ok(guard.frame_store.latest()),
            Err(TryLockError::WouldBlock) => Err(()),
            Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner().frame_store.latest()),
        }
    }

    pub fn latest_frame_blocking(&self) -> Option<FrameHandle<PreviewScreenPixelFormat>> {
        self.shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .frame_store
            .latest()
    }
}

#[derive(Debug, Default)]
pub struct PreviewScreenShared {
    frame_store: FrameStore<PreviewScreenPixelFormat>,
    frames_captured: u64,
    dropped_frames: u64,
    frames_in_window: u64,
    window_started_at: Option<Instant>,
    source_fps: Option<f64>,
    last_error: Option<String>,
    capture_timings: ScreenCaptureTimingWindow,
}

#[derive(Debug, Default)]
struct ScreenCaptureTimingWindow {
    last_callback_at: Option<Instant>,
    callback_gap_ms: Vec<f64>,
    pixel_buffer_lock_ms: Vec<f64>,
    row_copy_ms: Vec<f64>,
    publish_ms: Vec<f64>,
    frame_bytes: u64,
}

impl ScreenCaptureTimingWindow {
    fn record_callback_at(&mut self, now: Instant) {
        if let Some(previous) = self.last_callback_at.replace(now) {
            push_timing_sample(
                &mut self.callback_gap_ms,
                now.duration_since(previous).as_secs_f64() * 1000.0,
            );
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

    fn snapshot(&self) -> PreviewScreenCaptureTimingStats {
        PreviewScreenCaptureTimingStats {
            capture_gap_p95_ms: percentile(&self.callback_gap_ms, 95),
            capture_gap_max_ms: max_sample(&self.callback_gap_ms),
            pixel_buffer_lock_p95_ms: percentile(&self.pixel_buffer_lock_ms, 95),
            row_copy_p95_ms: percentile(&self.row_copy_ms, 95),
            publish_p95_ms: percentile(&self.publish_ms, 95),
            frame_bytes: self.frame_bytes,
            capture_queue_depth: PREVIEW_SCREEN_CAPTURE_QUEUE_DEPTH,
        }
    }
}

fn push_timing_sample(samples: &mut Vec<f64>, value: f64) {
    if !value.is_finite() {
        return;
    }
    if samples.len() >= PREVIEW_SCREEN_TIMING_WINDOW {
        samples.remove(0);
    }
    samples.push(value);
}

fn percentile(samples: &[f64], p: u32) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let clamped = p.min(100) as f64 / 100.0;
    let index = ((sorted.len() - 1) as f64 * clamped).round() as usize;
    sorted.get(index).copied()
}

fn max_sample(samples: &[f64]) -> Option<f64> {
    samples.iter().copied().reduce(f64::max)
}

pub fn initial_preview_screen_state() -> PreviewScreenRuntime {
    PreviewScreenRuntime {
        status: idle_status(Some("Native screen preview is not running.".to_string())),
        run_id: None,
        source_key: None,
        starting: None,
        start_generation: 0,
        active: None,
        poll_task: None,
    }
}

pub async fn start_preview_screen(
    state: AppState,
    params: PreviewScreenStartParams,
) -> PreviewScreenStatus {
    let Some(source) = selected_screen_source(&params) else {
        stop_preview_screen(&state).await;
        let status =
            status_for_missing_source(None, None, "No screen or window source is selected.");
        set_screen_status(&state, status.clone()).await;
        return status;
    };

    let target_fps = params.video.fps.clamp(1, 120);
    let include_cursor = true;
    // OBS-parity default: capture EVERYTHING on the display, including Videorc
    // itself (the preview-tunnel effect is expected behavior in every streaming
    // tool). The exclusion flag remains available for smoke/diagnostic runs, but
    // hiding windows from the user's recording is never a product default — it
    // already cost a real stream a browser window whose tab title matched the
    // old name heuristic.
    let exclude_current_process_windows = false;
    let protected_overlay_window_ids =
        normalized_protected_overlay_window_ids(params.protected_overlay_window_ids.clone());
    if let Some(window_id) = source.window_id
        && protected_overlay_window_ids.contains(&window_id)
    {
        stop_preview_screen(&state).await;
        let status = status_for_missing_source(
            Some(source.source_id),
            Some(source.source_kind),
            "The Videorc Notes window cannot be selected as a capture source.",
        );
        set_screen_status(&state, status.clone()).await;
        return status;
    }
    let source_key = source_key_for_source(&source);
    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path.clone());
    let start_key = PreviewScreenStartKey {
        source_key: source_key.clone(),
        ffmpeg_path: ffmpeg_path.clone(),
        video: params.video.clone(),
        target_fps,
        protected_overlay_window_ids: protected_overlay_window_ids.clone(),
    };
    let existing_source_key = current_screen_source_key(&state).await;
    if existing_source_key.as_ref() != Some(&source_key) {
        let keep_alive = release_current_preview_screen_source(&state).await;
        if !keep_alive {
            stop_current_screen(&state).await;
        }
    }
    acquire_preview_screen_source(
        &state,
        source_key.clone(),
        SourceLifecycleStatus::Starting,
        SourceIdentityConfidence::Exact,
    )
    .await;
    if let Some(status) = reuse_current_screen_source(
        &state,
        &source_key,
        &ffmpeg_path,
        &params.video,
        target_fps,
        &protected_overlay_window_ids,
    )
    .await
    {
        acquire_preview_screen_source(
            &state,
            source_key,
            SourceLifecycleStatus::Live,
            SourceIdentityConfidence::Exact,
        )
        .await;
        state.emit_event("preview.screen.status", status.clone());
        return status;
    }

    let starting = PreviewScreenStatus {
        state: PreviewScreenState::Starting,
        source_id: Some(source.source_id.clone()),
        source_kind: Some(source.source_kind.clone()),
        target_fps,
        width: None,
        height: None,
        native_width: None,
        native_height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        iosurface_available: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor,
        exclude_current_process_windows,
        updated_at: Utc::now().to_rfc3339(),
        message: Some("Starting native screen preview.".to_string()),
    };
    let start_lease = match begin_screen_start(&state, start_key.clone(), starting).await {
        PreviewScreenStartRegistration::JoinExisting => {
            return wait_for_screen_start(&state, &start_key).await;
        }
        PreviewScreenStartRegistration::Started(lease) => lease,
    };

    stop_current_screen_for_restart(&state).await;

    let run_id = Uuid::new_v4().to_string();
    let shared = Arc::new(StdMutex::new(PreviewScreenShared::default()));
    let (stop_tx, stop_rx) = std_mpsc::channel();
    let (startup_tx, startup_rx) = std_mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    let thread_config = NativeScreenPreviewConfig {
        source_id: source.source_id.clone(),
        source_kind: source.source_kind.clone(),
        display_id: source.display_id,
        window_id: source.window_id,
        ffmpeg_path: ffmpeg_path.clone(),
        video: params.video.clone(),
        include_cursor,
        exclude_current_process_windows,
        protected_overlay_window_ids,
    };

    let join_handle = thread::Builder::new()
        .name("videorc-preview-screen".to_string())
        .spawn(move || {
            run_native_screen_preview(thread_config, thread_shared, stop_rx, startup_tx)
        });

    let join_handle = match join_handle {
        Ok(join_handle) => join_handle,
        Err(error) => {
            let status = failed_status(
                Some(source.source_id),
                Some(source.source_kind),
                target_fps,
                include_cursor,
                exclude_current_process_windows,
                format!("Could not start screen preview thread: {error}"),
            );
            if set_screen_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_screen_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::Failed,
                    SourceIdentityConfidence::Exact,
                )
                .await;
                return status;
            }
            return preview_screen_status(&state).await;
        }
    };

    let startup_timeout = native_screen_preview_thread_startup_timeout();
    let startup = tokio::task::spawn_blocking(move || {
        startup_rx
            .recv_timeout(startup_timeout)
            .unwrap_or_else(|_| {
                NativeScreenStartup::Failed(format!(
                    "Timed out after {:.0}s while starting native screen preview.",
                    startup_timeout.as_secs_f64()
                ))
            })
    })
    .await
    .unwrap_or_else(|error| {
        NativeScreenStartup::Failed(format!("Screen startup task failed: {error}"))
    });

    match startup {
        NativeScreenStartup::Live {
            native_width,
            native_height,
            requested_width,
            requested_height,
            width,
            height,
            selected_fps,
            message,
        } => {
            let initial_frame = {
                let guard = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                (
                    guard.frames_captured,
                    guard.dropped_frames,
                    guard.source_fps,
                    guard.frame_store.latest(),
                )
            };
            let mut status = PreviewScreenStatus {
                state: PreviewScreenState::Live,
                source_id: Some(source.source_id),
                source_kind: Some(source.source_kind),
                target_fps,
                width: Some(width),
                height: Some(height),
                native_width: Some(native_width),
                native_height: Some(native_height),
                requested_width: Some(requested_width),
                requested_height: Some(requested_height),
                actual_width: None,
                actual_height: None,
                iosurface_available: None,
                source_fps: Some(selected_fps),
                frame_age_ms: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                include_cursor,
                exclude_current_process_windows,
                updated_at: Utc::now().to_rfc3339(),
                message,
            };
            status.frames_captured = initial_frame.0;
            status.dropped_frames = initial_frame.1;
            status.source_fps = initial_frame.2.or(Some(selected_fps));
            if let Some(frame) = initial_frame.3 {
                status.width = Some(frame.width);
                status.height = Some(frame.height);
                status.actual_width = Some(frame.width);
                status.actual_height = Some(frame.height);
                status.iosurface_available =
                    Some(frame.source_iosurface.is_some() || frame.source_pixel_buffer.is_some());
                status.sequence = Some(frame.sequence);
                status.frame_age_ms = Some(frame.captured_at.elapsed().as_millis() as u64);
            }
            let mut started_thread = Some(NativeScreenPreviewThread {
                stop_tx,
                join_handle: Some(join_handle),
                shared: Arc::clone(&shared),
                ffmpeg_path,
                video: params.video,
                protected_overlay_window_ids: start_key.protected_overlay_window_ids.clone(),
            });
            let installed = {
                let mut slot = state.preview_screen.lock().await;
                if !claim_screen_start(&mut slot, &start_lease) {
                    false
                } else {
                    slot.status = status.clone();
                    slot.run_id = Some(run_id.clone());
                    slot.source_key = Some(source_key.clone());
                    slot.active = started_thread.take();
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
                return preview_screen_status(&state).await;
            }
            let poll_task = tokio::spawn(poll_screen_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                target_fps,
            ));
            {
                let mut slot = state.preview_screen.lock().await;
                if slot.run_id.as_deref() == Some(run_id.as_str()) {
                    slot.poll_task = Some(poll_task);
                } else {
                    poll_task.abort();
                }
            }
            acquire_preview_screen_source(
                &state,
                source_key,
                SourceLifecycleStatus::Live,
                SourceIdentityConfidence::Exact,
            )
            .await;
            state.emit_event("preview.screen.status", status.clone());
            status
        }
        NativeScreenStartup::PermissionNeeded(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = PreviewScreenStatus {
                state: PreviewScreenState::PermissionNeeded,
                source_id: Some(source.source_id),
                source_kind: Some(source.source_kind),
                target_fps,
                width: None,
                height: None,
                native_width: None,
                native_height: None,
                requested_width: None,
                requested_height: None,
                actual_width: None,
                actual_height: None,
                iosurface_available: None,
                source_fps: None,
                frame_age_ms: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                include_cursor,
                exclude_current_process_windows,
                updated_at: Utc::now().to_rfc3339(),
                message: Some(message),
            };
            if set_screen_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_screen_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::PermissionNeeded,
                    SourceIdentityConfidence::Exact,
                )
                .await;
                status
            } else {
                preview_screen_status(&state).await
            }
        }
        NativeScreenStartup::SourceMissing(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = status_for_missing_source(
                Some(source.source_id),
                Some(source.source_kind),
                &message,
            );
            if set_screen_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_screen_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::SourceMissing,
                    SourceIdentityConfidence::Exact,
                )
                .await;
                status
            } else {
                preview_screen_status(&state).await
            }
        }
        NativeScreenStartup::Failed(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = failed_status(
                Some(source.source_id),
                Some(source.source_kind),
                target_fps,
                include_cursor,
                exclude_current_process_windows,
                message,
            );
            if set_screen_status_for_start(&state, &start_lease, status.clone()).await {
                acquire_preview_screen_source(
                    &state,
                    source_key,
                    SourceLifecycleStatus::Failed,
                    SourceIdentityConfidence::Exact,
                )
                .await;
                status
            } else {
                preview_screen_status(&state).await
            }
        }
    }
}

pub async fn stop_preview_screen(state: &AppState) -> PreviewScreenStatus {
    let stop = begin_preview_screen_stop(state).await;
    finish_preview_screen_stop(stop).await
}

pub(crate) async fn begin_preview_screen_stop(state: &AppState) -> PreviewScreenStop {
    let keep_alive = release_current_preview_screen_source(state).await;
    if keep_alive {
        let status = {
            let mut slot = state.preview_screen.lock().await;
            let mut status = slot.status.clone();
            status.updated_at = Utc::now().to_rfc3339();
            status.message =
                Some("Preview consumer released; screen source is still in use.".to_string());
            slot.status = status.clone();
            status
        };
        state.emit_event("preview.screen.status", status.clone());
        return PreviewScreenStop {
            status,
            join_handle: None,
        };
    }

    let status = idle_status(Some("Native screen preview stopped.".to_string()));
    let (previous, poll_task) = {
        let mut slot = state.preview_screen.lock().await;
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = None;
        slot.starting = None;
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
        *diagnostics = apply_preview_screen_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.screen.status", status.clone());
    PreviewScreenStop {
        status,
        join_handle,
    }
}

pub(crate) async fn finish_preview_screen_stop(mut stop: PreviewScreenStop) -> PreviewScreenStatus {
    if let Some(join_handle) = stop.join_handle.take() {
        let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
    }
    stop.status
}

pub async fn preview_screen_status(state: &AppState) -> PreviewScreenStatus {
    let (shared, target_fps) = {
        let slot = state.preview_screen.lock().await;
        let Some(active) = slot.active.as_ref() else {
            return slot.status.clone();
        };
        (Arc::clone(&active.shared), slot.status.target_fps)
    };

    let snapshot = screen_shared_snapshot(&shared);
    let status = {
        let mut slot = state.preview_screen.lock().await;
        if slot
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.shared, &shared))
        {
            apply_screen_snapshot_to_status(&mut slot.status, &snapshot, target_fps);
        }
        slot.status.clone()
    };

    {
        let camera_frame_store_stats =
            crate::preview_camera::preview_camera_frame_store_stats(state).await;
        let mut diagnostics = state.diagnostics.lock().await;
        let stats = apply_preview_screen_source_stats(diagnostics.clone(), &status);
        let stats = apply_preview_screen_capture_timing_stats(stats, snapshot.capture_timings);
        *diagnostics = apply_preview_source_frame_store_stats(
            stats,
            camera_frame_store_stats,
            snapshot.frame_store_stats,
        );
    }

    status
}

pub async fn preview_screen_frame_store_stats(state: &AppState) -> FrameStoreStats {
    let shared = {
        let slot = state.preview_screen.lock().await;
        let Some(active) = slot.active.as_ref() else {
            return FrameStoreStats::default();
        };
        Arc::clone(&active.shared)
    };

    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .frame_store
        .stats()
}

pub async fn preview_screen_latest_frame_info(state: &AppState) -> Option<PreviewScreenFrameInfo> {
    let shared = {
        let slot = state.preview_screen.lock().await;
        Arc::clone(&slot.active.as_ref()?.shared)
    };
    let frame = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .frame_store
        .latest()?;
    Some(PreviewScreenFrameInfo {
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        frame_age_ms: frame.captured_at.elapsed().as_millis() as u64,
    })
}

pub async fn preview_screen_frame_source(state: &AppState) -> Option<PreviewScreenFrameSource> {
    let slot = state.preview_screen.lock().await;
    let active = slot.active.as_ref()?;
    Some(PreviewScreenFrameSource {
        shared: Arc::clone(&active.shared),
        source_key: slot.source_key.clone(),
    })
}

pub fn try_preview_screen_frame_source(
    state: &AppState,
) -> Result<Option<PreviewScreenFrameSource>, ()> {
    let slot = state.preview_screen.try_lock().map_err(|_| ())?;
    let Some(active) = slot.active.as_ref() else {
        return Ok(None);
    };
    Ok(Some(PreviewScreenFrameSource {
        shared: Arc::clone(&active.shared),
        source_key: slot.source_key.clone(),
    }))
}

pub async fn latest_preview_screen_png(
    state: &AppState,
    requested_max_width: Option<u32>,
) -> Option<Vec<u8>> {
    let frame = {
        let slot = state.preview_screen.lock().await;
        let active = slot.active.as_ref()?;
        let shared = Arc::clone(&active.shared);
        drop(slot);
        let guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.frame_store.latest()?
    };

    let max_width = preview_screen_png_max_width(requested_max_width);
    tokio::task::spawn_blocking(move || encode_preview_screen_png(frame, max_width))
        .await
        .ok()
        .flatten()
}

/// Latest-wins, uncompressed proof-surface transport for Windows. The BMP
/// wrapper carries the capture store's newest BGRA frame without PNG encode
/// work and exposes its sequence so clients can skip duplicate frames.
pub async fn latest_preview_screen_bmp(
    state: &AppState,
    requested_max_width: Option<u32>,
    cursor: Option<PreviewBmpCursor>,
) -> Option<LatestPreviewBmpPoll> {
    let (generation, frame) = {
        let slot = state.preview_screen.lock().await;
        let active = slot.active.as_ref()?;
        let generation = slot.run_id.clone()?;
        let shared = Arc::clone(&active.shared);
        drop(slot);
        let guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (generation, guard.frame_store.latest()?)
    };

    let max_width = preview_screen_png_max_width(requested_max_width);
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

fn encode_preview_screen_png(
    frame: FrameHandle<PreviewScreenPixelFormat>,
    max_width: u32,
) -> Option<Vec<u8>> {
    let expected_len = frame.width as usize * frame.height as usize * 4;
    if frame.bytes.len() < expected_len {
        return None;
    }
    let mut rgba = Vec::with_capacity(frame.bytes.len());
    for pixel in frame.bytes.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
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

fn preview_screen_png_max_width(requested_max_width: Option<u32>) -> u32 {
    requested_max_width
        .unwrap_or(PREVIEW_SCREEN_DEFAULT_DEBUG_PNG_WIDTH)
        .clamp(1, PREVIEW_SCREEN_MAX_DEBUG_PNG_WIDTH)
}

fn choose_preview_dimensions(
    source_width: u32,
    source_height: u32,
    video: &VideoSettings,
) -> (u32, u32) {
    let source_width = source_width.max(1);
    let source_height = source_height.max(1);
    let max_width = video
        .width
        .clamp(1, PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_WIDTH);
    let max_height = video
        .height
        .clamp(1, PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_HEIGHT);
    let scale = (f64::from(max_width) / f64::from(source_width))
        .min(f64::from(max_height) / f64::from(source_height))
        .clamp(0.001, 1.0);
    let width = (f64::from(source_width) * scale).round().max(1.0) as u32;
    let height = (f64::from(source_height) * scale).round().max(1.0) as u32;
    (width, height)
}

// Backing scales live in [1, 4] on shipping Macs (2x Retina, fractional
// "looks like" modes land between); anything outside that range is a broken
// display-mode readback and must not distort the capture request.
fn clamp_backing_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(1.0, 4.0)
    } else {
        1.0
    }
}

fn points_to_pixels(points: f64, scale: f64) -> u32 {
    (points.max(0.0) * clamp_backing_scale(scale))
        .round()
        .max(1.0) as u32
}

#[allow(clippy::too_many_arguments)]
fn rects_intersect(
    a_x: f64,
    a_y: f64,
    a_width: f64,
    a_height: f64,
    b_x: f64,
    b_y: f64,
    b_width: f64,
    b_height: f64,
) -> bool {
    a_width > 0.0
        && a_height > 0.0
        && b_width > 0.0
        && b_height > 0.0
        && a_x < b_x + b_width
        && b_x < a_x + a_width
        && a_y < b_y + b_height
        && b_y < a_y + a_height
}

fn rect_contains_point(
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
) -> bool {
    x >= origin_x
        && x < origin_x + width.max(0.0)
        && y >= origin_y
        && y < origin_y + height.max(0.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreviewScreenCaptureRequest {
    native_width: u32,
    native_height: u32,
    requested_width: u32,
    requested_height: u32,
    requested_fps: u32,
    include_cursor: bool,
    exclude_current_process_windows: bool,
    queue_depth: u32,
    preserves_aspect_ratio: bool,
    scales_to_fit: bool,
}

fn select_preview_screen_capture_request(
    source_kind: &PreviewScreenSourceKind,
    source_width: u32,
    source_height: u32,
    video: &VideoSettings,
    include_cursor: bool,
    exclude_current_process_windows: bool,
) -> PreviewScreenCaptureRequest {
    let native_width = source_width.max(1);
    let native_height = source_height.max(1);
    let (requested_width, requested_height) =
        choose_preview_dimensions(native_width, native_height, video);

    PreviewScreenCaptureRequest {
        native_width,
        native_height,
        requested_width,
        requested_height,
        requested_fps: video.fps.clamp(1, 120),
        include_cursor,
        exclude_current_process_windows,
        queue_depth: PREVIEW_SCREEN_CAPTURE_QUEUE_DEPTH,
        preserves_aspect_ratio: true,
        scales_to_fit: matches!(source_kind, PreviewScreenSourceKind::Window),
    }
}

#[derive(Debug, Clone)]
struct SelectedScreenSource {
    source_id: String,
    source_kind: PreviewScreenSourceKind,
    display_id: Option<u32>,
    window_id: Option<u32>,
}

fn normalized_protected_overlay_window_ids(mut window_ids: Vec<u32>) -> Vec<u32> {
    window_ids.retain(|id| *id > 0);
    window_ids.sort_unstable();
    window_ids.dedup();
    window_ids
}

fn should_exclude_protected_overlay_window(window_id: u32, protected_ids: &[u32]) -> bool {
    protected_ids.binary_search(&window_id).is_ok()
}

fn selected_screen_source(params: &PreviewScreenStartParams) -> Option<SelectedScreenSource> {
    if let Some(window_id) = params.sources.window_id.clone() {
        return parse_screencapturekit_window_id(&window_id).map(|native_window_id| {
            SelectedScreenSource {
                source_id: window_id,
                source_kind: PreviewScreenSourceKind::Window,
                display_id: None,
                window_id: Some(native_window_id),
            }
        });
    }

    if let Some(screen_id) = params.sources.screen_id.clone() {
        if let Some(native_display_id) = parse_screencapturekit_display_id(&screen_id) {
            return Some(SelectedScreenSource {
                source_id: screen_id,
                source_kind: PreviewScreenSourceKind::Screen,
                display_id: Some(native_display_id),
                window_id: None,
            });
        }
        if let Some(output_index) = parse_windows_dxgi_output_index(&screen_id) {
            return Some(SelectedScreenSource {
                source_id: screen_id,
                source_kind: PreviewScreenSourceKind::Screen,
                display_id: Some(output_index),
                window_id: None,
            });
        }
        if is_windows_gdigrab_desktop_screen_id(&screen_id) {
            return Some(SelectedScreenSource {
                source_id: screen_id,
                source_kind: PreviewScreenSourceKind::Screen,
                display_id: None,
                window_id: None,
            });
        }
    }

    None
}

fn source_key_for_source(source: &SelectedScreenSource) -> SourceKey {
    match source.source_kind {
        PreviewScreenSourceKind::Screen => SourceKey::screen(source.source_id.clone()),
        PreviewScreenSourceKind::Window => SourceKey::window(source.source_id.clone()),
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_screen_preview_backend(
    config: &NativeScreenPreviewConfig,
) -> Result<crate::capture_input::WindowsScreenCaptureBackend, String> {
    if config.source_kind != PreviewScreenSourceKind::Screen {
        return Err(
            "Windows FFmpeg screen preview does not support window sources yet.".to_string(),
        );
    }
    if let Some(output_index) = config.display_id {
        return Ok(crate::capture_input::WindowsScreenCaptureBackend::Ddagrab { output_index });
    }
    if is_windows_gdigrab_desktop_screen_id(&config.source_id) {
        return Ok(crate::capture_input::WindowsScreenCaptureBackend::GdiGrabDesktop);
    }
    Err(format!(
        "Windows FFmpeg screen preview does not recognize source {}.",
        config.source_id
    ))
}

#[cfg(any(target_os = "windows", test))]
fn windows_screen_preview_output_dimensions(config: &NativeScreenPreviewConfig) -> (u32, u32) {
    (
        config
            .video
            .width
            .clamp(1, PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_WIDTH),
        config
            .video
            .height
            .clamp(1, PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_HEIGHT),
    )
}

#[cfg(any(target_os = "windows", test))]
fn windows_screen_preview_ffmpeg_args(
    backend: &crate::capture_input::WindowsScreenCaptureBackend,
    width: u32,
    height: u32,
    fps: u32,
    include_cursor: bool,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-nostdin".to_string(),
    ];
    crate::capture_input::append_windows_screen_video_input(
        &mut args,
        backend,
        fps,
        include_cursor,
    );
    args.extend([
        "-an".to_string(),
        "-vf".to_string(),
        format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=bgra"
        ),
        // Preserve the capture filter's real cadence. FFmpeg's default output
        // sync can otherwise manufacture duplicate raw frames when desktop
        // capture misses a requested tick, hiding the stall from diagnostics
        // and making the Windows preview/recording visibly hitch.
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

fn source_key_from_status(status: &PreviewScreenStatus) -> Option<SourceKey> {
    let source_id = status.source_id.clone()?;
    match status.source_kind {
        Some(PreviewScreenSourceKind::Screen) => Some(SourceKey::screen(source_id)),
        Some(PreviewScreenSourceKind::Window) => Some(SourceKey::window(source_id)),
        None => None,
    }
}

async fn set_screen_status(state: &AppState, status: PreviewScreenStatus) {
    {
        let mut slot = state.preview_screen.lock().await;
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = source_key_from_status(&status);
        slot.starting = None;
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_screen_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.screen.status", status);
}

async fn set_screen_status_for_start(
    state: &AppState,
    lease: &PreviewScreenStartLease,
    status: PreviewScreenStatus,
) -> bool {
    {
        let mut slot = state.preview_screen.lock().await;
        if !claim_screen_start(&mut slot, lease) {
            return false;
        }
        slot.status = status.clone();
        slot.run_id = None;
        slot.source_key = source_key_from_status(&status);
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_screen_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.screen.status", status);
    true
}

async fn stop_current_screen(state: &AppState) {
    stop_current_screen_inner(state, true).await;
}

async fn stop_current_screen_for_restart(state: &AppState) {
    stop_current_screen_inner(state, false).await;
}

async fn stop_current_screen_inner(state: &AppState, clear_starting: bool) {
    let (previous, poll_task) = {
        let mut slot = state.preview_screen.lock().await;
        slot.run_id = None;
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

async fn begin_screen_start(
    state: &AppState,
    start_key: PreviewScreenStartKey,
    status: PreviewScreenStatus,
) -> PreviewScreenStartRegistration {
    let mut slot = state.preview_screen.lock().await;
    if slot.starting.as_ref() == Some(&start_key) {
        return PreviewScreenStartRegistration::JoinExisting;
    }
    slot.start_generation = slot.start_generation.wrapping_add(1).max(1);
    let lease = PreviewScreenStartLease {
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
        *diagnostics = apply_preview_screen_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.screen.status", status);
    PreviewScreenStartRegistration::Started(lease)
}

fn claim_screen_start(slot: &mut PreviewScreenRuntime, lease: &PreviewScreenStartLease) -> bool {
    if slot.start_generation != lease.generation || slot.starting.as_ref() != Some(&lease.key) {
        return false;
    }
    slot.starting = None;
    true
}

async fn wait_for_screen_start(
    state: &AppState,
    start_key: &PreviewScreenStartKey,
) -> PreviewScreenStatus {
    let timeout =
        native_screen_preview_thread_startup_timeout().saturating_add(Duration::from_secs(1));
    let started_at = Instant::now();
    loop {
        let (still_starting, status) = {
            let slot = state.preview_screen.lock().await;
            (
                slot.starting.as_ref() == Some(start_key)
                    && matches!(slot.status.state, PreviewScreenState::Starting),
                slot.status.clone(),
            )
        };
        if !still_starting || started_at.elapsed() >= timeout {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn current_screen_source_key(state: &AppState) -> Option<SourceKey> {
    state.preview_screen.lock().await.source_key.clone()
}

async fn acquire_preview_screen_source(
    state: &AppState,
    source_key: SourceKey,
    status: SourceLifecycleStatus,
    confidence: SourceIdentityConfidence,
) {
    let mut registry = state.source_registry.lock().await;
    registry.acquire(source_key.clone(), SourceConsumerReason::Preview);
    registry.set_status(source_key.clone(), status);
    registry.set_identity_confidence(source_key, confidence);
}

async fn release_current_preview_screen_source(state: &AppState) -> bool {
    let Some(source_key) = current_screen_source_key(state).await else {
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

async fn reuse_current_screen_source(
    state: &AppState,
    source_key: &SourceKey,
    ffmpeg_path: &str,
    video: &VideoSettings,
    target_fps: u32,
    protected_overlay_window_ids: &[u32],
) -> Option<PreviewScreenStatus> {
    let mut slot = state.preview_screen.lock().await;
    if slot.source_key.as_ref() != Some(source_key) {
        return None;
    }
    let can_reuse = slot.active.as_ref().is_some_and(|active| {
        active.ffmpeg_path == ffmpeg_path
            && active.video == *video
            && slot.status.target_fps == target_fps
            && active.protected_overlay_window_ids == protected_overlay_window_ids
    });
    if !can_reuse {
        return None;
    }
    let mut status = slot.status.clone();
    status.updated_at = Utc::now().to_rfc3339();
    status.message = Some("Native screen preview source reused.".to_string());
    slot.status = status.clone();
    Some(status)
}

fn screen_shared_snapshot(shared: &Arc<StdMutex<PreviewScreenShared>>) -> ScreenSharedSnapshot {
    let guard = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ScreenSharedSnapshot {
        frames_captured: guard.frames_captured,
        dropped_frames: guard.dropped_frames,
        source_fps: guard.source_fps,
        latest_frame: guard.frame_store.latest(),
        frame_store_stats: guard.frame_store.stats(),
        last_error: guard.last_error.clone(),
        capture_timings: guard.capture_timings.snapshot(),
    }
}

fn apply_screen_snapshot_to_status(
    status: &mut PreviewScreenStatus,
    snapshot: &ScreenSharedSnapshot,
    target_fps: u32,
) {
    status.frames_captured = snapshot.frames_captured;
    status.dropped_frames = snapshot.dropped_frames;
    status.source_fps = snapshot.source_fps.or(Some(f64::from(target_fps)));
    if let Some(frame) = snapshot.latest_frame.as_ref() {
        status.state = PreviewScreenState::Live;
        status.width = Some(frame.width);
        status.height = Some(frame.height);
        status.actual_width = Some(frame.width);
        status.actual_height = Some(frame.height);
        status.iosurface_available =
            Some(frame.source_iosurface.is_some() || frame.source_pixel_buffer.is_some());
        status.sequence = Some(frame.sequence);
        status.frame_age_ms = Some(frame.captured_at.elapsed().as_millis() as u64);
        match frame.pixel_format {
            PreviewScreenPixelFormat::Bgra8 => {}
        }
    }
    if let Some(error) = snapshot.last_error.as_ref() {
        status.state = PreviewScreenState::Failed;
        status.message = Some(error.clone());
    }
    status.updated_at = Utc::now().to_rfc3339();
}

async fn poll_screen_metrics(
    state: AppState,
    run_id: String,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    target_fps: u32,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        let snapshot = screen_shared_snapshot(&shared);

        let status = {
            let mut slot = state.preview_screen.lock().await;
            if slot.run_id.as_deref() != Some(run_id.as_str()) {
                break;
            }
            apply_screen_snapshot_to_status(&mut slot.status, &snapshot, target_fps);
            slot.status.clone()
        };
        {
            let camera_frame_store_stats =
                crate::preview_camera::preview_camera_frame_store_stats(&state).await;
            let mut diagnostics = state.diagnostics.lock().await;
            let stats = apply_preview_screen_source_stats(diagnostics.clone(), &status);
            let stats = apply_preview_screen_capture_timing_stats(stats, snapshot.capture_timings);
            *diagnostics = apply_preview_source_frame_store_stats(
                stats,
                camera_frame_store_stats,
                snapshot.frame_store_stats,
            );
        }
        state.emit_event("preview.screen.status", status);
    }
}

#[derive(Debug)]
struct ScreenSharedSnapshot {
    frames_captured: u64,
    dropped_frames: u64,
    source_fps: Option<f64>,
    latest_frame: Option<FrameHandle<PreviewScreenPixelFormat>>,
    frame_store_stats: FrameStoreStats,
    last_error: Option<String>,
    capture_timings: PreviewScreenCaptureTimingStats,
}

fn idle_status(message: Option<String>) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::SourceMissing,
        source_id: None,
        source_kind: None,
        target_fps: 0,
        width: None,
        height: None,
        native_width: None,
        native_height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        iosurface_available: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor: true,
        exclude_current_process_windows: true,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

fn status_for_missing_source(
    source_id: Option<String>,
    source_kind: Option<PreviewScreenSourceKind>,
    message: &str,
) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::SourceMissing,
        source_id,
        source_kind,
        target_fps: 0,
        width: None,
        height: None,
        native_width: None,
        native_height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        iosurface_available: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor: true,
        exclude_current_process_windows: true,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message.to_string()),
    }
}

fn failed_status(
    source_id: Option<String>,
    source_kind: Option<PreviewScreenSourceKind>,
    target_fps: u32,
    include_cursor: bool,
    exclude_current_process_windows: bool,
    message: String,
) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::Failed,
        source_id,
        source_kind,
        target_fps,
        width: None,
        height: None,
        native_width: None,
        native_height: None,
        requested_width: None,
        requested_height: None,
        actual_width: None,
        actual_height: None,
        iosurface_available: None,
        source_fps: None,
        frame_age_ms: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor,
        exclude_current_process_windows,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message),
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

#[derive(Clone)]
struct NativeScreenPreviewConfig {
    source_id: String,
    source_kind: PreviewScreenSourceKind,
    display_id: Option<u32>,
    window_id: Option<u32>,
    ffmpeg_path: String,
    video: VideoSettings,
    include_cursor: bool,
    exclude_current_process_windows: bool,
    protected_overlay_window_ids: Vec<u32>,
}

#[derive(Debug)]
enum NativeScreenStartup {
    Live {
        native_width: u32,
        native_height: u32,
        requested_width: u32,
        requested_height: u32,
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    },
    PermissionNeeded(String),
    SourceMissing(String),
    Failed(String),
}

fn run_native_screen_preview(
    config: NativeScreenPreviewConfig,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    stop_rx: std_mpsc::Receiver<()>,
    startup_tx: std_mpsc::Sender<NativeScreenStartup>,
) {
    let _ = config.ffmpeg_path.as_str();

    #[cfg(target_os = "macos")]
    macos::run_native_screen_preview(config, shared, stop_rx, startup_tx);

    #[cfg(target_os = "windows")]
    {
        windows::run_native_screen_preview(config, shared, stop_rx, startup_tx);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = config;
        let _ = shared;
        let _ = stop_rx;
        let _ = startup_tx.send(NativeScreenStartup::Failed(
            "Native screen preview is only available on macOS.".to_string(),
        ));
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::capture_input::WindowsScreenCaptureBackend;
    use crate::process_job::spawn_owned_std;

    pub fn run_native_screen_preview(
        config: NativeScreenPreviewConfig,
        shared: Arc<StdMutex<PreviewScreenShared>>,
        stop_rx: std_mpsc::Receiver<()>,
        startup_tx: std_mpsc::Sender<NativeScreenStartup>,
    ) {
        let backend = match windows_screen_preview_backend(&config) {
            Ok(backend) => backend,
            Err(message) => {
                let _ = startup_tx.send(NativeScreenStartup::SourceMissing(message));
                return;
            }
        };
        let (width, height) = windows_screen_preview_output_dimensions(&config);
        let fps = config.video.fps.clamp(1, 120);
        let Some(frame_len) = bgra_frame_len(width, height) else {
            let _ = startup_tx.send(NativeScreenStartup::Failed(
                "Windows screen preview dimensions are too large.".to_string(),
            ));
            return;
        };
        let args =
            windows_screen_preview_ffmpeg_args(&backend, width, height, fps, config.include_cursor);
        let mut command = Command::new(&config.ffmpeg_path);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match spawn_owned_std(&mut command) {
            Ok(child) => child,
            Err(error) => {
                let _ = startup_tx.send(NativeScreenStartup::Failed(format!(
                    "Could not start {} for Windows screen preview: {error}",
                    config.ffmpeg_path
                )));
                return;
            }
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = startup_tx.send(NativeScreenStartup::Failed(
                "Windows screen preview did not expose FFmpeg stdout.".to_string(),
            ));
            return;
        };
        let stderr = collect_stderr(child.stderr.take());
        let child = Arc::new(StdMutex::new(child));
        let done = Arc::new(AtomicBool::new(false));
        let stop_thread = spawn_stop_killer(Arc::clone(&child), Arc::clone(&done), stop_rx);

        let mut startup_sent = false;
        let mut buffer = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .frame_store
            .checkout_overwrite_buffer(frame_len);
        loop {
            match stdout.read_exact(&mut buffer) {
                Ok(()) => {
                    buffer = publish_bgra_frame(&shared, width, height, buffer);
                    if !startup_sent {
                        let _ = startup_tx.send(NativeScreenStartup::Live {
                            native_width: width,
                            native_height: height,
                            requested_width: width,
                            requested_height: height,
                            width,
                            height,
                            selected_fps: fps as f64,
                            message: Some(format!(
                                "Windows FFmpeg screen preview is using {}.",
                                backend_label(&backend)
                            )),
                        });
                        startup_sent = true;
                    }
                }
                Err(error) => {
                    if !startup_sent {
                        let _ = startup_tx.send(NativeScreenStartup::Failed(format!(
                            "Windows FFmpeg screen preview ended before the first frame: {error}{}",
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
        let _ = stop_thread.join();
    }

    fn bgra_frame_len(width: u32, height: u32) -> Option<usize> {
        (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)
    }

    fn backend_label(backend: &WindowsScreenCaptureBackend) -> &'static str {
        match backend {
            WindowsScreenCaptureBackend::Ddagrab { .. } => "ddagrab",
            WindowsScreenCaptureBackend::GdiGrabDesktop => "gdigrab",
        }
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

    fn spawn_stop_killer(
        child: Arc<StdMutex<Child>>,
        done: Arc<AtomicBool>,
        stop_rx: std_mpsc::Receiver<()>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match stop_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) => {
                        let _ = child
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .kill();
                        return;
                    }
                    Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        })
    }

    fn publish_bgra_frame(
        shared: &Arc<StdMutex<PreviewScreenShared>>,
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
            PreviewScreenPixelFormat::Bgra8,
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

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;
    use std::slice;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_core_graphics::{
        CGDirectDisplayID, CGDisplayCopyDisplayMode, CGDisplayMode, CGPreflightScreenCaptureAccess,
    };
    use objc2_core_media::{CMSampleBuffer, CMTime};
    use objc2_core_video::{
        CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
        CVPixelBufferGetIOSurface, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
        kCVPixelFormatType_32BGRA,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCDisplay, SCFrameStatus, SCShareableContent, SCStream,
        SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
    };

    use super::*;

    struct RetainedTransfer<T> {
        raw: Option<NonNull<T>>,
        release: unsafe fn(NonNull<T>),
    }

    impl<T> RetainedTransfer<T> {
        unsafe fn new(raw: NonNull<T>, release: unsafe fn(NonNull<T>)) -> Self {
            Self {
                raw: Some(raw),
                release,
            }
        }

        fn consume(mut self) -> NonNull<T> {
            self.raw
                .take()
                .expect("retained transfer must own a value until consumed")
        }
    }

    impl<T> Drop for RetainedTransfer<T> {
        fn drop(&mut self) {
            if let Some(raw) = self.raw.take() {
                unsafe { (self.release)(raw) };
            }
        }
    }

    struct ShareableContentTransfer(RetainedTransfer<SCShareableContent>);

    // SAFETY: the token never dereferences the ScreenCaptureKit object. It only
    // transfers one retained owner to the receiver or releases that owner when
    // the channel discards the value. This is the same cross-thread ownership
    // transfer performed by ScreenCaptureKit's asynchronous completion API,
    // now kept behind an RAII boundary instead of an unowned integer.
    unsafe impl Send for ShareableContentTransfer {}

    impl ShareableContentTransfer {
        fn new(content: Retained<SCShareableContent>) -> Self {
            let raw = NonNull::new(Retained::into_raw(content))
                .expect("a retained ScreenCaptureKit object must be non-null");
            Self(unsafe { RetainedTransfer::new(raw, release_shareable_content) })
        }

        fn consume(self) -> Option<Retained<SCShareableContent>> {
            let raw = self.0.consume();
            unsafe { Retained::from_raw(raw.as_ptr()) }
        }
    }

    unsafe fn release_shareable_content(raw: NonNull<SCShareableContent>) {
        drop(unsafe { Retained::from_raw(raw.as_ptr()) });
    }

    #[cfg(test)]
    mod retained_transfer_tests {
        use std::ptr::NonNull;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        use super::RetainedTransfer;

        struct DropProbe {
            drops: Arc<AtomicUsize>,
        }

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.drops.fetch_add(1, Ordering::SeqCst);
            }
        }

        unsafe fn release_probe(raw: NonNull<DropProbe>) {
            drop(unsafe { Box::from_raw(raw.as_ptr()) });
        }

        fn retained_probe(drops: &Arc<AtomicUsize>) -> RetainedTransfer<DropProbe> {
            let raw = NonNull::from(Box::leak(Box::new(DropProbe {
                drops: Arc::clone(drops),
            })));
            unsafe { RetainedTransfer::new(raw, release_probe) }
        }

        #[test]
        fn successful_receive_and_consume_transfers_the_retained_owner() {
            let drops = Arc::new(AtomicUsize::new(0));
            let (tx, rx) = std::sync::mpsc::channel();

            tx.send(retained_probe(&drops))
                .expect("receiver should accept the retained owner");
            let raw = rx
                .recv()
                .expect("receiver should receive the retained owner")
                .consume();

            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(unsafe { Box::from_raw(raw.as_ptr()) });
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn failed_send_after_receiver_drop_releases_the_retained_owner() {
            let drops = Arc::new(AtomicUsize::new(0));
            let (tx, rx) = std::sync::mpsc::channel();
            drop(rx);

            let error = tx
                .send(retained_probe(&drops))
                .expect_err("send should fail after the receiver is dropped");
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(error);

            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn unread_receiver_drop_releases_the_enqueued_retained_owner() {
            let drops = Arc::new(AtomicUsize::new(0));
            let (tx, rx) = std::sync::mpsc::channel();

            tx.send(retained_probe(&drops))
                .expect("receiver should accept the retained owner");
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(rx);

            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }
    }

    struct ScreenDelegateIvars {
        shared: Arc<StdMutex<PreviewScreenShared>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[ivars = ScreenDelegateIvars]
        struct ScreenPreviewDelegate;

        unsafe impl NSObjectProtocol for ScreenPreviewDelegate {}

        #[allow(non_snake_case)]
        unsafe impl SCStreamOutput for ScreenPreviewDelegate {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_didOutputSampleBuffer_ofType(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                output_type: SCStreamOutputType,
            ) {
                if output_type != SCStreamOutputType::Screen {
                    return;
                }
                copy_sample_buffer(sample_buffer, &self.ivars().shared);
            }
        }

        #[allow(non_snake_case)]
        unsafe impl SCStreamDelegate for ScreenPreviewDelegate {
            #[unsafe(method(stream:didStopWithError:))]
            unsafe fn stream_didStopWithError(&self, _stream: &SCStream, error: &NSError) {
                let description = error.localizedDescription();
                let mut guard = self
                    .ivars()
                    .shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.last_error = Some(format!(
                    "ScreenCaptureKit stream stopped: {}",
                    ns_string_to_string(&description)
                        .unwrap_or_else(|| "unknown error".to_string())
                ));
            }
        }
    );

    impl ScreenPreviewDelegate {
        fn new(shared: Arc<StdMutex<PreviewScreenShared>>) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(ScreenDelegateIvars { shared });
            unsafe { msg_send![super(delegate), init] }
        }
    }

    pub fn run_native_screen_preview(
        config: NativeScreenPreviewConfig,
        shared: Arc<StdMutex<PreviewScreenShared>>,
        stop_rx: std_mpsc::Receiver<()>,
        startup_tx: std_mpsc::Sender<NativeScreenStartup>,
    ) {
        autoreleasepool(|_| match start_stream(config, Arc::clone(&shared)) {
            Ok(session) => {
                let _ = startup_tx.send(NativeScreenStartup::Live {
                    native_width: session.native_width,
                    native_height: session.native_height,
                    requested_width: session.requested_width,
                    requested_height: session.requested_height,
                    width: session.width,
                    height: session.height,
                    selected_fps: session.selected_fps,
                    message: session.message,
                });
                let _ = stop_rx.recv();
                stop_stream(&session.stream);
                unsafe {
                    let _ = session.stream.removeStreamOutput_type_error(
                        ProtocolObject::from_ref(&*session.delegate),
                        SCStreamOutputType::Screen,
                    );
                }
            }
            Err(error) => {
                let _ = startup_tx.send(error);
            }
        });
    }

    struct ScreenSession {
        stream: Retained<SCStream>,
        delegate: Retained<ScreenPreviewDelegate>,
        _filter: Retained<SCContentFilter>,
        _configuration: Retained<SCStreamConfiguration>,
        _queue: dispatch2::DispatchRetained<DispatchQueue>,
        _start_handler: RcBlock<dyn Fn(*mut NSError)>,
        native_width: u32,
        native_height: u32,
        requested_width: u32,
        requested_height: u32,
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    }

    fn start_stream(
        config: NativeScreenPreviewConfig,
        shared: Arc<StdMutex<PreviewScreenShared>>,
    ) -> Result<ScreenSession, NativeScreenStartup> {
        if !CGPreflightScreenCaptureAccess() {
            return Err(NativeScreenStartup::PermissionNeeded(
                screen_capture_permission_message(),
            ));
        }

        let content = load_shareable_content(&config.source_kind)?;
        let selected = select_content(&content, &config)?;
        let capture_request = select_preview_screen_capture_request(
            &config.source_kind,
            selected.source_width,
            selected.source_height,
            &config.video,
            config.include_cursor,
            config.exclude_current_process_windows,
        );
        // PT1 diagnostic (preview res/tearing plan): pins whether a soft source
        // was captured below its native pixel size (e.g. the window path
        // reporting points) before blaming the surface or present path.
        tracing::info!(
            "[videorc-capture-sizing] kind={:?} native={}x{} requested={}x{} session={}x{} scales_to_fit={}",
            config.source_kind,
            capture_request.native_width,
            capture_request.native_height,
            capture_request.requested_width,
            capture_request.requested_height,
            config.video.width,
            config.video.height,
            capture_request.scales_to_fit,
        );
        let stream_config = unsafe { SCStreamConfiguration::new() };
        configure_stream(&stream_config, &capture_request);
        let delegate = ScreenPreviewDelegate::new(Arc::clone(&shared));
        let delegate_protocol = ProtocolObject::from_ref(&*delegate);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &selected.filter,
                &stream_config,
                Some(delegate_protocol),
            )
        };
        let queue = DispatchQueue::new("com.videorc.preview.screen", None);

        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*delegate),
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
                .map_err(|error| {
                    NativeScreenStartup::Failed(format!(
                        "Could not attach ScreenCaptureKit output: {}",
                        ns_error_description(&error)
                    ))
                })?;
        }
        let start_handler = start_capture(&stream, &shared);

        let selected_fps = f64::from(capture_request.requested_fps);
        let message = Some(format!(
            "Native {} preview running at {}x{} from {}x{} source and {:.0} fps. Cursor {}, Videorc windows excluded {}.",
            match config.source_kind {
                PreviewScreenSourceKind::Screen => "screen",
                PreviewScreenSourceKind::Window => "window",
            },
            capture_request.requested_width,
            capture_request.requested_height,
            capture_request.native_width,
            capture_request.native_height,
            selected_fps,
            if config.include_cursor {
                "visible"
            } else {
                "hidden"
            },
            if config.exclude_current_process_windows {
                "yes"
            } else {
                "no"
            }
        ));

        Ok(ScreenSession {
            stream,
            delegate,
            _filter: selected.filter,
            _configuration: stream_config,
            _queue: queue,
            _start_handler: start_handler,
            native_width: capture_request.native_width,
            native_height: capture_request.native_height,
            requested_width: capture_request.requested_width,
            requested_height: capture_request.requested_height,
            width: capture_request.requested_width,
            height: capture_request.requested_height,
            selected_fps,
            message,
        })
    }

    struct SelectedContent {
        filter: Retained<SCContentFilter>,
        source_width: u32,
        source_height: u32,
    }

    fn select_content(
        content: &SCShareableContent,
        config: &NativeScreenPreviewConfig,
    ) -> Result<SelectedContent, NativeScreenStartup> {
        match config.source_kind {
            PreviewScreenSourceKind::Screen => {
                let display_id = config.display_id.ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "Screen source is not a ScreenCaptureKit display: {}",
                        config.source_id
                    ))
                })?;
                let display = find_display(content, display_id).ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit display is missing: {}",
                        config.source_id
                    ))
                })?;
                let broad_excluded = if config.exclude_current_process_windows {
                    videorc_windows(content)
                } else {
                    NSArray::<SCWindow>::new()
                };
                let excluded = protected_overlay_windows(
                    content,
                    &config.protected_overlay_window_ids,
                    broad_excluded,
                );
                let filter = unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &excluded,
                    )
                };
                let logical_width = positive_u32(unsafe { display.width() });
                let logical_height = positive_u32(unsafe { display.height() });
                let (source_width, source_height) =
                    display_capture_dimensions(display_id, logical_width, logical_height);
                Ok(SelectedContent {
                    source_width,
                    source_height,
                    filter,
                })
            }
            PreviewScreenSourceKind::Window => {
                let window_id = config.window_id.ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "Window source is not a ScreenCaptureKit window: {}",
                        config.source_id
                    ))
                })?;
                let window = find_window(content, window_id).ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit window is missing: {}",
                        config.source_id
                    ))
                })?;
                // F-013: a foreign-session window (the macOS login window)
                // ABORTS the process inside SkyLight when wrapped in an
                // SCContentFilter — reject it as source-missing instead, so a
                // stale persisted scene can never crash the backend on restore.
                let owning_app = unsafe { window.owningApplication() }
                    .map(|app| unsafe { app.applicationName() }.to_string());
                if crate::screen_capture::is_foreign_session_window_app(owning_app.as_deref()) {
                    return Err(NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit window {} belongs to another login session and cannot be captured",
                        config.source_id
                    )));
                }
                let frame = unsafe { window.frame() };
                // F-021 (same class as F-013): wrapping a window whose frame
                // SkyLight cannot map to a live display ABORTS the process
                // inside SLSGetDisplaysWithRect (assert → SIGABRT) during
                // SCContentFilter init — seen as a crash loop when a window
                // sits on a disconnected display. Reject it as source-missing
                // BEFORE ScreenCaptureKit touches it.
                if !window_frame_is_capturable(content, &frame) {
                    return Err(NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit window {} has no on-display frame (degenerate rect or a disconnected display) and cannot be captured",
                        config.source_id
                    )));
                }
                let filter = unsafe {
                    SCContentFilter::initWithDesktopIndependentWindow(
                        SCContentFilter::alloc(),
                        &window,
                    )
                };
                // SCWindow.frame is in display POINTS; sizing the capture from
                // it directly runs at half resolution on Retina. Convert to
                // real pixels via the containing display's point→pixel scale,
                // mirroring the display path's pixel_width intent (see
                // display_capture_dimensions).
                let scale = window_backing_scale(content, &frame);
                Ok(SelectedContent {
                    source_width: points_to_pixels(frame.size.width, scale),
                    source_height: points_to_pixels(frame.size.height, scale),
                    filter,
                })
            }
        }
    }

    enum ShareableContentQuery {
        FullOnScreenContent,
        CurrentProcessContent,
    }

    fn load_shareable_content(
        source_kind: &PreviewScreenSourceKind,
    ) -> Result<Retained<SCShareableContent>, NativeScreenStartup> {
        let mut timed_out = false;
        for attempt in 1..=SCREEN_CAPTUREKIT_DISCOVERY_ATTEMPTS {
            match load_shareable_content_once(ShareableContentQuery::FullOnScreenContent) {
                Ok(content) => return Ok(content),
                Err(NativeScreenStartup::Failed(message))
                    if message == SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT_MESSAGE =>
                {
                    timed_out = true;
                    if attempt < SCREEN_CAPTUREKIT_DISCOVERY_ATTEMPTS {
                        thread::sleep(Duration::from_millis(150));
                    }
                }
                Err(error) => return Err(error),
            }
        }

        if timed_out {
            if matches!(source_kind, PreviewScreenSourceKind::Screen)
                && let Ok(content) =
                    load_shareable_content_once(ShareableContentQuery::CurrentProcessContent)
            {
                return Ok(content);
            }
            return Err(NativeScreenStartup::Failed(format!(
                "{SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT_MESSAGE} Retried {SCREEN_CAPTUREKIT_DISCOVERY_ATTEMPTS} times."
            )));
        }

        Err(NativeScreenStartup::Failed(
            SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT_MESSAGE.to_string(),
        ))
    }

    fn load_shareable_content_once(
        query: ShareableContentQuery,
    ) -> Result<Retained<SCShareableContent>, NativeScreenStartup> {
        enum ShareableContentResult {
            Content(ShareableContentTransfer),
            Error(String),
        }

        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !error.is_null() {
                    ShareableContentResult::Error(error_description(error))
                } else if content.is_null() {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit returned no shareable content.".to_string(),
                    )
                } else if let Some(retained) = unsafe { Retained::retain(content) } {
                    ShareableContentResult::Content(ShareableContentTransfer::new(retained))
                } else {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit shareable content could not be retained.".to_string(),
                    )
                };
                let _ = tx.send(result);
            },
        );

        unsafe {
            match query {
                ShareableContentQuery::FullOnScreenContent => {
                    SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                        true, true, &handler,
                    );
                }
                ShareableContentQuery::CurrentProcessContent => {
                    SCShareableContent::getCurrentProcessShareableContentWithCompletionHandler(
                        &handler,
                    );
                }
            }
        }

        match rx.recv_timeout(SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT) {
            Ok(ShareableContentResult::Content(content)) => {
                let content = content.consume().ok_or_else(|| {
                    NativeScreenStartup::Failed(
                        "ScreenCaptureKit shareable content pointer was invalid.".to_string(),
                    )
                })?;
                Ok(content)
            }
            Ok(ShareableContentResult::Error(error)) => {
                if is_permission_error(&error) {
                    Err(NativeScreenStartup::PermissionNeeded(error))
                } else {
                    Err(NativeScreenStartup::Failed(error))
                }
            }
            Err(_) => Err(NativeScreenStartup::Failed(
                SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT_MESSAGE.to_string(),
            )),
        }
    }

    fn configure_stream(
        stream_config: &SCStreamConfiguration,
        capture_request: &PreviewScreenCaptureRequest,
    ) {
        unsafe {
            stream_config.setWidth(capture_request.requested_width as usize);
            stream_config.setHeight(capture_request.requested_height as usize);
            stream_config.setPixelFormat(kCVPixelFormatType_32BGRA);
            stream_config
                .setMinimumFrameInterval(CMTime::new(1, capture_request.requested_fps as i32));
            stream_config.setQueueDepth(capture_request.queue_depth as isize);
            stream_config.setShowsCursor(capture_request.include_cursor);
            stream_config.setScalesToFit(capture_request.scales_to_fit);
            stream_config.setPreservesAspectRatio(capture_request.preserves_aspect_ratio);
            stream_config.setCapturesAudio(false);
            stream_config.setCaptureMicrophone(false);
        }
    }

    fn start_capture(
        stream: &SCStream,
        shared: &Arc<StdMutex<PreviewScreenShared>>,
    ) -> RcBlock<dyn Fn(*mut NSError)> {
        let shared = Arc::clone(shared);
        let handler = RcBlock::new(move |error: *mut NSError| {
            if error.is_null() {
                return;
            }

            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.last_error = Some(format!(
                "ScreenCaptureKit stream failed to start: {}",
                error_description(error)
            ));
        });

        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&handler));
        }
        handler
    }

    fn screen_capture_permission_message() -> String {
        let target = std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "the Videorc capture helper".to_string());
        format!(
            "macOS Screen Recording permission is not granted for {target}. Grant Screen Recording permission to this capture helper, then quit and relaunch Videorc."
        )
    }

    fn stop_stream(stream: &SCStream) {
        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        unsafe {
            stream.stopCaptureWithCompletionHandler(Some(&handler));
        }
        let _ = rx.recv_timeout(Duration::from_secs(2));
    }

    fn copy_sample_buffer(
        sample_buffer: &CMSampleBuffer,
        shared: &Arc<StdMutex<PreviewScreenShared>>,
    ) {
        let callback_started_at = Instant::now();
        {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard
                .capture_timings
                .record_callback_at(callback_started_at);
        }

        if !sample_buffer_is_complete(sample_buffer) {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let Some(pixel_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
            let mut guard = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        };

        let pixel_format = CVPixelBufferGetPixelFormatType(&pixel_buffer);
        if pixel_format != kCVPixelFormatType_32BGRA {
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

        // Zero-copy native preview and recording use retained CoreVideo storage directly.
        // Avoiding the extra 4K BGRA row copy keeps ScreenCaptureKit callbacks short under
        // recording load; `bytes` stays only as a diagnostic/fallback path.
        let source_zerocopy_enabled = crate::metal_compositor::source_zerocopy_enabled();
        let source_iosurface = if source_zerocopy_enabled {
            CVPixelBufferGetIOSurface(Some(&pixel_buffer))
                .map(crate::frame_store::RetainedIoSurface::new)
        } else {
            None
        };
        let source_pixel_buffer = if source_zerocopy_enabled {
            Some(crate::frame_store::RetainedPixelBuffer::new(
                pixel_buffer.clone(),
            ))
        } else {
            None
        };
        let skip_cpu_copy = should_skip_screen_capture_cpu_copy(
            source_iosurface.is_some() || source_pixel_buffer.is_some(),
        );
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

            let bytes_per_row = CVPixelBufferGetBytesPerRow(&pixel_buffer);
            let base_address = CVPixelBufferGetBaseAddress(&pixel_buffer);
            if base_address.is_null() {
                unsafe {
                    CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
                };
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
            let copy_started_at = Instant::now();
            unsafe {
                let source = base_address.cast::<u8>();
                for row in 0..height_usize {
                    let source_row = source.add(row * bytes_per_row);
                    let target_row = &mut bytes[row * row_bytes..(row + 1) * row_bytes];
                    target_row.copy_from_slice(slice::from_raw_parts(source_row, row_bytes));
                }
                CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
            }
            (
                bytes,
                pixel_buffer_lock_ms,
                copy_started_at.elapsed().as_secs_f64() * 1000.0,
            )
        };

        let publish_started_at = Instant::now();
        let mut guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        guard.frame_store.publish_with_source_handles(
            sequence,
            width,
            height,
            PreviewScreenPixelFormat::Bgra8,
            now,
            bytes,
            source_iosurface,
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

    fn sample_buffer_is_complete(_sample_buffer: &CMSampleBuffer) -> bool {
        let _ = SCFrameStatus::Complete;
        true
    }

    fn find_display(content: &SCShareableContent, display_id: u32) -> Option<Retained<SCDisplay>> {
        let displays = unsafe { content.displays() };
        for index in 0..displays.count() {
            let display = displays.objectAtIndex(index);
            if unsafe { display.displayID() } == display_id {
                return Some(display);
            }
        }
        None
    }

    fn find_window(content: &SCShareableContent, window_id: u32) -> Option<Retained<SCWindow>> {
        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            if unsafe { window.windowID() } == window_id {
                return Some(window);
            }
        }
        None
    }

    fn videorc_windows(content: &SCShareableContent) -> Retained<NSArray<SCWindow>> {
        let mut excluded = NSArray::<SCWindow>::new();
        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            if is_videorc_window(&window) {
                excluded = excluded.arrayByAddingObject(&window);
            }
        }
        excluded
    }

    fn protected_overlay_windows(
        content: &SCShareableContent,
        protected_ids: &[u32],
        mut excluded: Retained<NSArray<SCWindow>>,
    ) -> Retained<NSArray<SCWindow>> {
        if protected_ids.is_empty() {
            return excluded;
        }
        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            let window_id = unsafe { window.windowID() };
            if should_exclude_protected_overlay_window(window_id, protected_ids) {
                excluded = excluded.arrayByAddingObject(&window);
            }
        }
        excluded
    }

    fn is_videorc_window(window: &SCWindow) -> bool {
        let current_pid = unsafe { libc::getpid() };
        let app = unsafe { window.owningApplication() };
        let app_name = app
            .as_ref()
            .and_then(|app| {
                let name = unsafe { app.applicationName() };
                ns_string_to_string(&name)
            })
            .unwrap_or_default()
            .to_lowercase();
        let process_id_matches = app
            .as_ref()
            .map(|app| unsafe { app.processID() } == current_pid)
            .unwrap_or(false);

        // Match by owning process or application name only. NEVER by window title:
        // title substrings silently removed unrelated apps from recordings (a browser
        // window became invisible because its active tab title contained "Videorc").
        process_id_matches || app_name.contains("videorc")
    }

    fn positive_u32(value: isize) -> u32 {
        value.max(1) as u32
    }

    // A window frame is capturable when it is a real rect (finite, ≥1pt) that
    // overlaps at least one CURRENT display — SkyLight asserts (aborts the
    // process) on rects it cannot map to a display, e.g. after that display
    // disconnects.
    fn window_frame_is_capturable(
        content: &SCShareableContent,
        window_frame: &objc2_core_foundation::CGRect,
    ) -> bool {
        let (x, y) = (window_frame.origin.x, window_frame.origin.y);
        let (width, height) = (window_frame.size.width, window_frame.size.height);
        if ![x, y, width, height].iter().all(|value| value.is_finite())
            || width < 1.0
            || height < 1.0
        {
            return false;
        }
        let displays = unsafe { content.displays() };
        for index in 0..displays.count() {
            let display_frame = unsafe { displays.objectAtIndex(index).frame() };
            if rects_intersect(
                display_frame.origin.x,
                display_frame.origin.y,
                display_frame.size.width,
                display_frame.size.height,
                x,
                y,
                width,
                height,
            ) {
                return true;
            }
        }
        false
    }

    // Resolve the point→pixel scale of the display containing the window's
    // midpoint (SCWindow.frame and SCDisplay.frame share the global CG point
    // space). Falls back to the first display's scale, then 1.0 — a wrong 1.0
    // only reproduces the old too-soft behavior, never an upscaled capture,
    // because choose_preview_dimensions still clamps at the source size.
    fn window_backing_scale(
        content: &SCShareableContent,
        window_frame: &objc2_core_foundation::CGRect,
    ) -> f64 {
        let mid_x = window_frame.origin.x + window_frame.size.width / 2.0;
        let mid_y = window_frame.origin.y + window_frame.size.height / 2.0;
        let displays = unsafe { content.displays() };
        let mut first_display_scale: Option<f64> = None;
        for index in 0..displays.count() {
            let display = displays.objectAtIndex(index);
            let scale =
                display_point_scale(unsafe { display.displayID() }, unsafe { display.width() }
                    as f64);
            if first_display_scale.is_none() {
                first_display_scale = scale;
            }
            let frame = unsafe { display.frame() };
            let contains = rect_contains_point(
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
                mid_x,
                mid_y,
            );
            if contains && let Some(scale) = scale {
                return scale;
            }
        }
        first_display_scale.unwrap_or(1.0)
    }

    fn display_point_scale(display_id: CGDirectDisplayID, logical_width: f64) -> Option<f64> {
        if !(logical_width.is_finite() && logical_width >= 1.0) {
            return None;
        }
        let mode = CGDisplayCopyDisplayMode(display_id)?;
        let pixel_width = positive_usize_u32(CGDisplayMode::pixel_width(Some(&mode)))?;
        Some(clamp_backing_scale(f64::from(pixel_width) / logical_width))
    }

    fn display_capture_dimensions(
        display_id: CGDirectDisplayID,
        fallback_width: u32,
        fallback_height: u32,
    ) -> (u32, u32) {
        let Some(mode) = CGDisplayCopyDisplayMode(display_id) else {
            return (fallback_width, fallback_height);
        };
        let pixel_width = positive_usize_u32(CGDisplayMode::pixel_width(Some(&mode)));
        let pixel_height = positive_usize_u32(CGDisplayMode::pixel_height(Some(&mode)));
        match (pixel_width, pixel_height) {
            (Some(width), Some(height)) => (width, height),
            _ => (fallback_width, fallback_height),
        }
    }

    fn positive_usize_u32(value: usize) -> Option<u32> {
        if value == 0 {
            None
        } else {
            Some(u32::try_from(value).unwrap_or(u32::MAX))
        }
    }

    fn is_permission_error(error: &str) -> bool {
        let normalized = error.to_lowercase();
        normalized.contains("permission")
            || normalized.contains("denied")
            || normalized.contains("not authorized")
            || normalized.contains("tcc")
            || normalized.contains("declined")
    }

    fn error_description(error: *mut NSError) -> String {
        if error.is_null() {
            return "Unknown ScreenCaptureKit error.".to_string();
        }
        ns_error_description(unsafe { &*error })
    }

    fn ns_error_description(error: &NSError) -> String {
        let description = error.localizedDescription();
        ns_string_to_string(&description)
            .unwrap_or_else(|| "Unknown ScreenCaptureKit error.".to_string())
    }

    fn ns_string_to_string(value: &NSString) -> Option<String> {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SourceSelection, VideoPreset};
    use crate::storage::Database;
    use tokio::sync::{broadcast, oneshot};

    #[test]
    fn backing_scale_clamps_to_shipping_range() {
        assert_eq!(clamp_backing_scale(1.0), 1.0);
        assert_eq!(clamp_backing_scale(2.0), 2.0);
        assert!((clamp_backing_scale(1.497) - 1.497).abs() < 1e-9);
        assert_eq!(clamp_backing_scale(0.5), 1.0);
        assert_eq!(clamp_backing_scale(8.0), 4.0);
        assert_eq!(clamp_backing_scale(f64::NAN), 1.0);
        assert_eq!(clamp_backing_scale(f64::INFINITY), 1.0);
    }

    #[test]
    fn window_points_convert_to_pixels_per_scale() {
        // The PT2 regression: a 1200x800-pt window on a 2x display must
        // request a 2400x1600-px capture, not 1200x800.
        assert_eq!(points_to_pixels(1200.0, 2.0), 2400);
        assert_eq!(points_to_pixels(800.0, 2.0), 1600);
        assert_eq!(points_to_pixels(1200.0, 1.0), 1200);
        // Fractional "looks like" modes round to whole pixels.
        assert_eq!(points_to_pixels(1000.0, 1.497), 1497);
        // Degenerate inputs stay harmless.
        assert_eq!(points_to_pixels(0.0, 2.0), 1);
        assert_eq!(points_to_pixels(-50.0, 2.0), 1);
    }

    #[test]
    fn window_pixel_capture_still_clamps_to_session_size() {
        // Doubling the source must not upscale the REQUEST past the session
        // output: the existing chooser stays the single clamp.
        let (width, height) = choose_preview_dimensions(2400, 1600, &test_video());
        let video = test_video();
        assert!(width <= video.width && height <= video.height);
        assert!(width >= 1 && height >= 1);
    }

    // F-021 regression: a window rect that maps to no live display must be
    // rejected before SCContentFilter init (SkyLight aborts the process on
    // such rects — seen as a backend crash loop after a display disconnect).
    #[test]
    fn window_rects_off_every_display_are_not_capturable() {
        let display = (0.0, 0.0, 1512.0, 982.0);
        // On-display window intersects.
        assert!(rects_intersect(
            display.0, display.1, display.2, display.3, 100.0, 100.0, 800.0, 600.0
        ));
        // A window parked on a disconnected display to the right: no overlap.
        assert!(!rects_intersect(
            display.0, display.1, display.2, display.3, 1600.0, 0.0, 800.0, 600.0
        ));
        // Straddling the edge still counts as capturable.
        assert!(rects_intersect(
            display.0, display.1, display.2, display.3, 1400.0, 100.0, 800.0, 600.0
        ));
        // Degenerate/negative sizes never intersect.
        assert!(!rects_intersect(
            display.0, display.1, display.2, display.3, 100.0, 100.0, 0.0, 0.0
        ));
        assert!(!rects_intersect(
            display.0, display.1, display.2, display.3, 100.0, 100.0, -50.0, -50.0
        ));
    }

    #[test]
    fn rect_containment_handles_negative_origin_displays() {
        // A second display arranged left of the primary has a negative origin
        // in the global CG space.
        assert!(rect_contains_point(
            -1920.0, 0.0, 1920.0, 1080.0, -960.0, 540.0
        ));
        assert!(!rect_contains_point(
            -1920.0, 0.0, 1920.0, 1080.0, 10.0, 540.0
        ));
        assert!(!rect_contains_point(0.0, 0.0, 1920.0, 1080.0, 1920.0, 0.0));
        assert!(!rect_contains_point(0.0, 0.0, -10.0, -10.0, 0.0, 0.0));
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

    fn test_video() -> VideoSettings {
        VideoSettings {
            preset: VideoPreset::Tutorial1080p30,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate_kbps: 6000,
        }
    }

    fn test_video_with_dimensions(width: u32, height: u32) -> VideoSettings {
        VideoSettings {
            preset: VideoPreset::Record4k30,
            width,
            height,
            fps: 30,
            bitrate_kbps: 30_000,
        }
    }

    fn screen_params(screen_id: Option<&str>, window_id: Option<&str>) -> PreviewScreenStartParams {
        PreviewScreenStartParams {
            sources: SourceSelection {
                screen_id: screen_id.map(str::to_string),
                window_id: window_id.map(str::to_string),
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            video: test_video(),
            protected_overlay_window_ids: Vec::new(),
            ffmpeg_path: None,
        }
    }

    #[test]
    fn selects_window_source_before_screen_source() {
        let params = screen_params(
            Some("screen:screencapturekit:5"),
            Some("window:screencapturekit:42"),
        );

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Window);
        assert_eq!(selected.window_id, Some(42));
        assert_eq!(selected.display_id, None);
    }

    #[test]
    fn selects_screen_source_when_no_window_source_exists() {
        let params = screen_params(Some("screen:screencapturekit:5"), None);

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Screen);
        assert_eq!(selected.display_id, Some(5));
    }

    #[test]
    fn selects_windows_dxgi_screen_source() {
        let params = screen_params(Some("screen:dxgi:00000000000003f1:2"), None);

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Screen);
        assert_eq!(selected.source_id, "screen:dxgi:00000000000003f1:2");
        assert_eq!(selected.display_id, Some(2));
        assert_eq!(
            source_key_for_source(&selected),
            SourceKey::screen(selected.source_id.clone())
        );
    }

    #[test]
    fn selects_windows_gdigrab_screen_source() {
        let params = screen_params(Some("screen:gdigrab:desktop"), None);

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Screen);
        assert_eq!(selected.source_id, "screen:gdigrab:desktop");
        assert_eq!(selected.display_id, None);
        assert_eq!(
            source_key_for_source(&selected),
            SourceKey::screen(selected.source_id.clone())
        );
    }

    #[test]
    fn windows_screen_preview_ffmpeg_args_emit_raw_bgra_frames() {
        let config = NativeScreenPreviewConfig {
            source_id: "screen:dxgi:00000000000003f1:2".to_string(),
            source_kind: PreviewScreenSourceKind::Screen,
            display_id: Some(2),
            window_id: None,
            ffmpeg_path: "C:\\ffmpeg\\bin\\ffmpeg.exe".to_string(),
            video: test_video(),
            include_cursor: true,
            exclude_current_process_windows: false,
            protected_overlay_window_ids: Vec::new(),
        };
        let backend = windows_screen_preview_backend(&config).unwrap();
        let (width, height) = windows_screen_preview_output_dimensions(&config);
        let args = windows_screen_preview_ffmpeg_args(&backend, width, height, 30, true);

        assert_eq!(
            backend,
            crate::capture_input::WindowsScreenCaptureBackend::Ddagrab { output_index: 2 }
        );
        assert_eq!((width, height), (1920, 1080));
        assert!(args.windows(2).any(|pair| pair == ["-f", "lavfi"]));
        assert!(args.iter().any(|arg| arg.contains("ddagrab=output_idx=2")));
        assert!(args.iter().any(|arg| arg.contains("draw_mouse=1")));
        assert!(args.iter().any(|arg| arg.contains("scale=1920:1080")));
        assert!(!args.iter().any(|arg| arg.starts_with("fps=")));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-fps_mode", "passthrough"])
        );
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "bgra"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "rawvideo"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn windows_gdigrab_preview_uses_desktop_backend() {
        let config = NativeScreenPreviewConfig {
            source_id: "screen:gdigrab:desktop".to_string(),
            source_kind: PreviewScreenSourceKind::Screen,
            display_id: None,
            window_id: None,
            ffmpeg_path: "ffmpeg".to_string(),
            video: test_video(),
            include_cursor: false,
            exclude_current_process_windows: false,
            protected_overlay_window_ids: Vec::new(),
        };
        let backend = windows_screen_preview_backend(&config).unwrap();
        let args = windows_screen_preview_ffmpeg_args(&backend, 1280, 720, 30, false);

        assert_eq!(
            backend,
            crate::capture_input::WindowsScreenCaptureBackend::GdiGrabDesktop
        );
        assert!(args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
        assert!(args.windows(2).any(|pair| pair == ["-i", "desktop"]));
        assert!(args.windows(2).any(|pair| pair == ["-draw_mouse", "0"]));
    }

    #[test]
    fn ignores_non_native_screen_sources() {
        let params = screen_params(Some("screen:avfoundation:1"), None);

        assert!(selected_screen_source(&params).is_none());
    }

    #[test]
    fn source_key_preserves_screen_or_window_kind() {
        let screen =
            selected_screen_source(&screen_params(Some("screen:screencapturekit:5"), None))
                .unwrap();
        let window =
            selected_screen_source(&screen_params(None, Some("window:screencapturekit:42")))
                .unwrap();

        assert_eq!(
            source_key_for_source(&screen),
            SourceKey::screen("screen:screencapturekit:5")
        );
        assert_eq!(
            source_key_for_source(&window),
            SourceKey::window("window:screencapturekit:42")
        );
    }

    #[test]
    fn protected_overlay_window_ids_are_normalized_and_exact() {
        let ids = normalized_protected_overlay_window_ids(vec![42, 0, 7, 42]);

        assert_eq!(ids, vec![7, 42]);
        assert!(should_exclude_protected_overlay_window(42, &ids));
        assert!(should_exclude_protected_overlay_window(7, &ids));
        assert!(!should_exclude_protected_overlay_window(4, &ids));
        assert!(!should_exclude_protected_overlay_window(420, &ids));
    }

    #[tokio::test]
    async fn rejects_protected_overlay_window_as_selected_source() {
        let state = test_state();
        let mut params = screen_params(None, Some("window:screencapturekit:42"));
        params.protected_overlay_window_ids = vec![42];

        let status = start_preview_screen(state, params).await;

        assert_eq!(status.state, PreviewScreenState::SourceMissing);
        assert_eq!(
            status.source_id.as_deref(),
            Some("window:screencapturekit:42")
        );
        assert_eq!(status.source_kind, Some(PreviewScreenSourceKind::Window));
        assert_eq!(
            status.message.as_deref(),
            Some("The Videorc Notes window cannot be selected as a capture source.")
        );
    }

    #[test]
    fn downscales_screen_preview_png_payload() {
        let bytes = vec![255; 8 * 4 * 4];

        let (scaled, width, height) = downscale_rgba_for_preview(bytes, 8, 4, 4);

        assert_eq!(width, 4);
        assert_eq!(height, 2);
        assert_eq!(scaled.len(), 4 * 2 * 4);
    }

    #[test]
    fn downscales_screen_preview_with_filtered_sampling() {
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
    fn screen_png_width_defaults_and_clamps_requested_quality() {
        assert_eq!(preview_screen_png_max_width(None), 1600);
        assert_eq!(preview_screen_png_max_width(Some(0)), 1);
        assert_eq!(preview_screen_png_max_width(Some(1920)), 1920);
        assert_eq!(preview_screen_png_max_width(Some(4096)), 2560);
    }

    #[test]
    fn production_capture_dimensions_allow_4k_output() {
        let video = test_video_with_dimensions(3840, 2160);

        assert_eq!(choose_preview_dimensions(3840, 2160, &video), (3840, 2160));
    }

    #[test]
    fn production_capture_dimensions_are_not_limited_by_debug_png_cap() {
        let video = test_video_with_dimensions(3840, 2160);

        assert_eq!(preview_screen_png_max_width(Some(4096)), 2560);
        assert_eq!(choose_preview_dimensions(3840, 2160, &video), (3840, 2160));
    }

    #[test]
    fn screen_capture_request_selects_native_4k_output_dimensions() {
        let video = test_video_with_dimensions(3840, 2160);

        let request = select_preview_screen_capture_request(
            &PreviewScreenSourceKind::Screen,
            3840,
            2160,
            &video,
            true,
            true,
        );

        assert_eq!(request.native_width, 3840);
        assert_eq!(request.native_height, 2160);
        assert_eq!(request.requested_width, 3840);
        assert_eq!(request.requested_height, 2160);
        assert_eq!(request.requested_fps, 30);
        assert!(request.include_cursor);
        assert!(request.exclude_current_process_windows);
        assert!(request.preserves_aspect_ratio);
        assert!(!request.scales_to_fit);
        assert!((1..=8).contains(&request.queue_depth));
    }

    #[test]
    fn screen_capture_request_preserves_source_aspect_ratio() {
        let video = test_video_with_dimensions(3840, 2160);

        let request = select_preview_screen_capture_request(
            &PreviewScreenSourceKind::Screen,
            3840,
            2400,
            &video,
            true,
            true,
        );

        assert_eq!(request.native_width, 3840);
        assert_eq!(request.native_height, 2400);
        assert_eq!(request.requested_width, 3456);
        assert_eq!(request.requested_height, 2160);
    }

    #[test]
    fn thread_startup_timeout_covers_screencapturekit_discovery_and_start() {
        let timeout = native_screen_preview_thread_startup_timeout();

        assert!(
            timeout
                >= SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT
                    .saturating_add(SCREEN_CAPTUREKIT_STREAM_START_TIMEOUT)
        );
        assert!(timeout > Duration::from_secs(5));
    }

    #[tokio::test]
    async fn duplicate_screen_start_waits_for_in_flight_start() {
        let state = test_state();
        let video = test_video();
        let source_key = SourceKey::screen("screen:screencapturekit:5");
        let start_key = PreviewScreenStartKey {
            source_key: source_key.clone(),
            ffmpeg_path: "ffmpeg".to_string(),
            video: video.clone(),
            target_fps: video.fps,
            protected_overlay_window_ids: Vec::new(),
        };
        let starting = PreviewScreenStatus {
            state: PreviewScreenState::Starting,
            source_id: Some(source_key.id.clone()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: video.fps,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            include_cursor: true,
            exclude_current_process_windows: false,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Starting native screen preview.".to_string()),
        };

        assert!(matches!(
            begin_screen_start(&state, start_key.clone(), starting.clone()).await,
            PreviewScreenStartRegistration::Started(_)
        ));
        assert_eq!(
            begin_screen_start(&state, start_key.clone(), starting).await,
            PreviewScreenStartRegistration::JoinExisting
        );

        let waiter_state = state.clone();
        let waiter_key = start_key.clone();
        let waiter =
            tokio::spawn(async move { wait_for_screen_start(&waiter_state, &waiter_key).await });
        tokio::time::sleep(Duration::from_millis(25)).await;

        let live = PreviewScreenStatus {
            state: PreviewScreenState::Live,
            source_id: Some(source_key.id.clone()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: video.fps,
            width: Some(video.width),
            height: Some(video.height),
            native_width: Some(video.width),
            native_height: Some(video.height),
            requested_width: Some(video.width),
            requested_height: Some(video.height),
            actual_width: Some(video.width),
            actual_height: Some(video.height),
            iosurface_available: Some(true),
            source_fps: Some(f64::from(video.fps)),
            frame_age_ms: Some(1),
            frames_captured: 1,
            dropped_frames: 0,
            sequence: Some(1),
            include_cursor: true,
            exclude_current_process_windows: false,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Native screen preview source reused.".to_string()),
        };
        set_screen_status(&state, live.clone()).await;

        let waited = waiter.await.expect("waiter task");
        assert_eq!(waited.state, PreviewScreenState::Live);
        assert_eq!(waited.frames_captured, 1);
        assert_eq!(waited.sequence, Some(1));
        assert!(state.preview_screen.lock().await.starting.is_none());
    }

    #[tokio::test]
    async fn screen_start_cannot_install_after_camera_only_retirement() {
        let state = test_state();
        let video = test_video();
        let source_key = SourceKey::screen("screen:screencapturekit:5");
        let start_key = PreviewScreenStartKey {
            source_key: source_key.clone(),
            ffmpeg_path: "ffmpeg".to_string(),
            video: video.clone(),
            target_fps: video.fps,
            protected_overlay_window_ids: Vec::new(),
        };
        let starting = PreviewScreenStatus {
            state: PreviewScreenState::Starting,
            source_id: Some(source_key.id.clone()),
            source_kind: Some(PreviewScreenSourceKind::Screen),
            target_fps: video.fps,
            width: None,
            height: None,
            native_width: None,
            native_height: None,
            requested_width: None,
            requested_height: None,
            actual_width: None,
            actual_height: None,
            iosurface_available: None,
            source_fps: None,
            frame_age_ms: None,
            frames_captured: 0,
            dropped_frames: 0,
            sequence: None,
            include_cursor: true,
            exclude_current_process_windows: false,
            updated_at: Utc::now().to_rfc3339(),
            message: Some("Starting native screen preview.".to_string()),
        };

        let lease = match begin_screen_start(&state, start_key, starting).await {
            PreviewScreenStartRegistration::Started(lease) => lease,
            PreviewScreenStartRegistration::JoinExisting => panic!("first start must own a lease"),
        };

        let completion_state = state.clone();
        let (release_completion, completion_blocked) = oneshot::channel();
        let stale_completion = tokio::spawn(async move {
            completion_blocked
                .await
                .expect("stale completion should be released");
            let mut slot = completion_state.preview_screen.lock().await;
            claim_screen_start(&mut slot, &lease)
        });

        // Camera-only retires screen capture while the old native startup thread
        // is still discovering/starting its ScreenCaptureKit source.
        let stopped = stop_preview_screen(&state).await;
        assert_eq!(stopped.state, PreviewScreenState::SourceMissing);
        release_completion
            .send(())
            .expect("stale completion task should still be waiting");
        let stale_start_claimed = stale_completion.await.expect("stale completion task");

        assert!(!stale_start_claimed);
        assert_eq!(
            preview_screen_status(&state).await.state,
            PreviewScreenState::SourceMissing
        );
    }

    #[test]
    fn window_capture_request_preserves_cursor_and_fit_policy() {
        let video = test_video_with_dimensions(3840, 2160);
        let video = VideoSettings { fps: 240, ..video };

        let request = select_preview_screen_capture_request(
            &PreviewScreenSourceKind::Window,
            1920,
            1080,
            &video,
            false,
            false,
        );

        assert_eq!(request.requested_width, 1920);
        assert_eq!(request.requested_height, 1080);
        assert_eq!(request.requested_fps, 120);
        assert!(!request.include_cursor);
        assert!(!request.exclude_current_process_windows);
        assert!(request.preserves_aspect_ratio);
        assert!(request.scales_to_fit);
    }

    #[test]
    fn screen_capture_cpu_copy_is_skipped_only_for_native_zero_copy_source_handle() {
        assert!(should_skip_screen_capture_cpu_copy_for_config(
            true, true, true, false
        ));
        assert!(!should_skip_screen_capture_cpu_copy_for_config(
            false, true, true, false
        ));
        assert!(!should_skip_screen_capture_cpu_copy_for_config(
            true, false, true, false
        ));
        assert!(!should_skip_screen_capture_cpu_copy_for_config(
            true, true, false, false
        ));
        assert!(!should_skip_screen_capture_cpu_copy_for_config(
            true, true, true, true
        ));
    }

    #[tokio::test]
    async fn screen_registry_preview_consumer_releases_on_stop() {
        let state = test_state();
        let source_key = SourceKey::screen("screen:screencapturekit:5");
        {
            let mut slot = state.preview_screen.lock().await;
            slot.source_key = Some(source_key.clone());
        }

        acquire_preview_screen_source(
            &state,
            source_key.clone(),
            SourceLifecycleStatus::Live,
            SourceIdentityConfidence::Exact,
        )
        .await;
        let keep_alive = release_current_preview_screen_source(&state).await;
        let snapshot = state.source_registry.lock().await.snapshot();
        let entry = snapshot
            .entries
            .iter()
            .find(|entry| entry.key == source_key)
            .expect("screen source entry");

        assert!(!keep_alive);
        assert!(entry.consumers.is_empty());
        assert_eq!(entry.status, SourceLifecycleStatus::Stopped);
        assert_eq!(entry.identity_confidence, SourceIdentityConfidence::Exact);
    }

    #[tokio::test]
    async fn same_screen_source_reuse_keeps_run_and_status_sequence() {
        let state = test_state();
        let source_key = SourceKey::screen("screen:screencapturekit:5");
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        let video = test_video();
        {
            let mut slot = state.preview_screen.lock().await;
            slot.source_key = Some(source_key.clone());
            slot.run_id = Some("run-1".to_string());
            slot.status = PreviewScreenStatus {
                state: PreviewScreenState::Live,
                source_id: Some(source_key.id.clone()),
                source_kind: Some(PreviewScreenSourceKind::Screen),
                target_fps: video.fps,
                width: Some(video.width),
                height: Some(video.height),
                native_width: Some(video.width),
                native_height: Some(video.height),
                requested_width: Some(video.width),
                requested_height: Some(video.height),
                actual_width: Some(video.width),
                actual_height: Some(video.height),
                iosurface_available: Some(false),
                source_fps: Some(f64::from(video.fps)),
                frame_age_ms: Some(6),
                frames_captured: 24,
                dropped_frames: 0,
                sequence: Some(24),
                include_cursor: true,
                exclude_current_process_windows: true,
                updated_at: Utc::now().to_rfc3339(),
                message: Some("Live".to_string()),
            };
            slot.active = Some(NativeScreenPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewScreenShared::default())),
                ffmpeg_path: "ffmpeg".to_string(),
                video: video.clone(),
                protected_overlay_window_ids: Vec::new(),
            });
        }

        assert!(
            reuse_current_screen_source(
                &state,
                &source_key,
                "/custom/ffmpeg",
                &video,
                video.fps,
                &[]
            )
            .await
            .is_none()
        );

        let status =
            reuse_current_screen_source(&state, &source_key, "ffmpeg", &video, video.fps, &[])
                .await
                .expect("screen source should be reused");
        let slot = state.preview_screen.lock().await;

        assert_eq!(status.sequence, Some(24));
        assert_eq!(slot.run_id.as_deref(), Some("run-1"));
        assert_eq!(
            status.message.as_deref(),
            Some("Native screen preview source reused.")
        );
    }

    #[tokio::test]
    async fn changed_protected_overlay_windows_prevent_screen_source_reuse() {
        let state = test_state();
        let source_key = SourceKey::screen("screen:screencapturekit:5");
        let (stop_tx, _stop_rx) = std_mpsc::channel();
        let video = test_video();
        {
            let mut slot = state.preview_screen.lock().await;
            slot.source_key = Some(source_key.clone());
            slot.run_id = Some("run-1".to_string());
            slot.status = PreviewScreenStatus {
                state: PreviewScreenState::Live,
                source_id: Some(source_key.id.clone()),
                source_kind: Some(PreviewScreenSourceKind::Screen),
                target_fps: video.fps,
                width: Some(video.width),
                height: Some(video.height),
                native_width: Some(video.width),
                native_height: Some(video.height),
                requested_width: Some(video.width),
                requested_height: Some(video.height),
                actual_width: Some(video.width),
                actual_height: Some(video.height),
                iosurface_available: Some(false),
                source_fps: Some(f64::from(video.fps)),
                frame_age_ms: Some(6),
                frames_captured: 24,
                dropped_frames: 0,
                sequence: Some(24),
                include_cursor: true,
                exclude_current_process_windows: false,
                updated_at: Utc::now().to_rfc3339(),
                message: Some("Live".to_string()),
            };
            slot.active = Some(NativeScreenPreviewThread {
                stop_tx,
                join_handle: None,
                shared: Arc::new(StdMutex::new(PreviewScreenShared::default())),
                ffmpeg_path: "ffmpeg".to_string(),
                video: video.clone(),
                protected_overlay_window_ids: vec![42],
            });
        }

        assert!(
            reuse_current_screen_source(&state, &source_key, "ffmpeg", &video, video.fps, &[42])
                .await
                .is_some()
        );
        assert!(
            reuse_current_screen_source(&state, &source_key, "ffmpeg", &video, video.fps, &[7])
                .await
                .is_none()
        );
    }
}
