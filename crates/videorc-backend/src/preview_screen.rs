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
use crate::frame_store::{FrameHandle, FrameStore, FrameStoreStats};
use crate::protocol::{
    PreviewScreenSourceKind, PreviewScreenStartParams, PreviewScreenState, PreviewScreenStatus,
    VideoSettings,
};
use crate::screen_capture::{parse_screencapturekit_display_id, parse_screencapturekit_window_id};
use crate::source_registry::{SourceConsumerReason, SourceIdentityConfidence, SourceKey};
use crate::source_status::SourceLifecycleStatus;
use crate::state::AppState;

const PREVIEW_SCREEN_DEFAULT_DEBUG_PNG_WIDTH: u32 = 960;
const PREVIEW_SCREEN_MAX_DEBUG_PNG_WIDTH: u32 = 2560;
const PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_WIDTH: u32 = 3840;
const PREVIEW_SCREEN_MAX_PRODUCTION_CAPTURE_HEIGHT: u32 = 2160;
const PREVIEW_SCREEN_CAPTURE_QUEUE_DEPTH: u32 = 3;
const PREVIEW_SCREEN_TIMING_WINDOW: usize = 180;
const SCREEN_CAPTUREKIT_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);

fn native_screen_preview_thread_startup_timeout() -> Duration {
    SCREEN_CAPTUREKIT_STARTUP_TIMEOUT
        .saturating_mul(2)
        .saturating_add(Duration::from_secs(5))
}

pub type PreviewScreenSlot = Arc<tokio::sync::Mutex<PreviewScreenRuntime>>;

#[derive(Debug)]
pub struct PreviewScreenRuntime {
    pub status: PreviewScreenStatus,
    run_id: Option<String>,
    source_key: Option<SourceKey>,
    active: Option<NativeScreenPreviewThread>,
    poll_task: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct NativeScreenPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    video: VideoSettings,
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
    let exclude_current_process_windows = true;
    let source_key = source_key_for_source(&source);
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
    if let Some(status) =
        reuse_current_screen_source(&state, &source_key, &params.video, target_fps).await
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

    stop_current_screen(&state).await;

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
        video: params.video.clone(),
        include_cursor,
        exclude_current_process_windows,
    };

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
    set_screen_status(&state, starting).await;

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
            acquire_preview_screen_source(
                &state,
                source_key,
                SourceLifecycleStatus::Failed,
                SourceIdentityConfidence::Exact,
            )
            .await;
            set_screen_status(&state, status.clone()).await;
            return status;
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
            let poll_task = tokio::spawn(poll_screen_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                target_fps,
            ));
            let status = PreviewScreenStatus {
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
            {
                let mut slot = state.preview_screen.lock().await;
                slot.status = status.clone();
                slot.run_id = Some(run_id);
                slot.source_key = Some(source_key.clone());
                slot.active = Some(NativeScreenPreviewThread {
                    stop_tx,
                    join_handle: Some(join_handle),
                    shared,
                    video: params.video,
                });
                slot.poll_task = Some(poll_task);
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
            acquire_preview_screen_source(
                &state,
                source_key,
                SourceLifecycleStatus::PermissionNeeded,
                SourceIdentityConfidence::Exact,
            )
            .await;
            set_screen_status(&state, status.clone()).await;
            status
        }
        NativeScreenStartup::SourceMissing(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = status_for_missing_source(
                Some(source.source_id),
                Some(source.source_kind),
                &message,
            );
            acquire_preview_screen_source(
                &state,
                source_key,
                SourceLifecycleStatus::SourceMissing,
                SourceIdentityConfidence::Exact,
            )
            .await;
            set_screen_status(&state, status.clone()).await;
            status
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
            acquire_preview_screen_source(
                &state,
                source_key,
                SourceLifecycleStatus::Failed,
                SourceIdentityConfidence::Exact,
            )
            .await;
            set_screen_status(&state, status.clone()).await;
            status
        }
    }
}

pub async fn stop_preview_screen(state: &AppState) -> PreviewScreenStatus {
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
        return status;
    }

    stop_current_screen(state).await;
    let status = idle_status(Some("Native screen preview stopped.".to_string()));
    set_screen_status(state, status.clone()).await;
    status
}

pub async fn preview_screen_status(state: &AppState) -> PreviewScreenStatus {
    state.preview_screen.lock().await.status.clone()
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

    let mut rgba = Vec::with_capacity(frame.bytes.len());
    for pixel in frame.bytes.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    let (rgba, width, height) = downscale_rgba_for_preview(
        rgba,
        frame.width,
        frame.height,
        preview_screen_png_max_width(requested_max_width),
    );

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
        return parse_screencapturekit_display_id(&screen_id).map(|native_display_id| {
            SelectedScreenSource {
                source_id: screen_id,
                source_kind: PreviewScreenSourceKind::Screen,
                display_id: Some(native_display_id),
                window_id: None,
            }
        });
    }

    None
}

fn source_key_for_source(source: &SelectedScreenSource) -> SourceKey {
    match source.source_kind {
        PreviewScreenSourceKind::Screen => SourceKey::screen(source.source_id.clone()),
        PreviewScreenSourceKind::Window => SourceKey::window(source.source_id.clone()),
    }
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
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_screen_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.screen.status", status);
}

async fn stop_current_screen(state: &AppState) {
    let (previous, poll_task) = {
        let mut slot = state.preview_screen.lock().await;
        slot.run_id = None;
        slot.source_key = None;
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
    video: &VideoSettings,
    target_fps: u32,
) -> Option<PreviewScreenStatus> {
    let mut slot = state.preview_screen.lock().await;
    if slot.source_key.as_ref() != Some(source_key) {
        return None;
    }
    let can_reuse = slot
        .active
        .as_ref()
        .is_some_and(|active| active.video == *video && slot.status.target_fps == target_fps);
    if !can_reuse {
        return None;
    }

    let mut status = slot.status.clone();
    status.updated_at = Utc::now().to_rfc3339();
    status.message = Some("Native screen preview source reused.".to_string());
    slot.status = status.clone();
    Some(status)
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
        let snapshot = {
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
        };

        let status = {
            let mut slot = state.preview_screen.lock().await;
            if slot.run_id.as_deref() != Some(run_id.as_str()) {
                break;
            }
            slot.status.frames_captured = snapshot.frames_captured;
            slot.status.dropped_frames = snapshot.dropped_frames;
            slot.status.source_fps = snapshot.source_fps.or(Some(f64::from(target_fps)));
            if let Some(frame) = snapshot.latest_frame {
                slot.status.state = PreviewScreenState::Live;
                slot.status.width = Some(frame.width);
                slot.status.height = Some(frame.height);
                slot.status.actual_width = Some(frame.width);
                slot.status.actual_height = Some(frame.height);
                slot.status.iosurface_available = Some(frame.source_iosurface.is_some());
                slot.status.sequence = Some(frame.sequence);
                let _frame_bytes = frame.bytes.len();
                slot.status.frame_age_ms = Some(frame.captured_at.elapsed().as_millis() as u64);
                match frame.pixel_format {
                    PreviewScreenPixelFormat::Bgra8 => {}
                }
            }
            if let Some(error) = snapshot.last_error {
                slot.status.state = PreviewScreenState::Failed;
                slot.status.message = Some(error);
            }
            slot.status.updated_at = Utc::now().to_rfc3339();
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
    video: VideoSettings,
    include_cursor: bool,
    exclude_current_process_windows: bool,
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
    #[cfg(target_os = "macos")]
    macos::run_native_screen_preview(config, shared, stop_rx, startup_tx);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = config;
        let _ = shared;
        let _ = stop_rx;
        let _ = startup_tx.send(NativeScreenStartup::Failed(
            "Native screen preview is only available on macOS.".to_string(),
        ));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::slice;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
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

    struct ScreenDelegateIvars {
        shared: Arc<StdMutex<PreviewScreenShared>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[ivars = ScreenDelegateIvars]
        struct ScreenPreviewDelegate;

        unsafe impl NSObjectProtocol for ScreenPreviewDelegate {}

        unsafe impl SCStreamOutput for ScreenPreviewDelegate {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            fn stream_did_output_sample_buffer(
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

        unsafe impl SCStreamDelegate for ScreenPreviewDelegate {
            #[unsafe(method(stream:didStopWithError:))]
            fn stream_did_stop_with_error(&self, _stream: &SCStream, error: &NSError) {
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
        let content = load_shareable_content()?;
        let selected = select_content(&content, &config)?;
        let capture_request = select_preview_screen_capture_request(
            &config.source_kind,
            selected.source_width,
            selected.source_height,
            &config.video,
            config.include_cursor,
            config.exclude_current_process_windows,
        );
        let stream_config = unsafe { SCStreamConfiguration::new() };
        configure_stream(&stream_config, &capture_request);
        let delegate = ScreenPreviewDelegate::new(shared);
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
        start_capture(&stream)?;

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
                let excluded = if config.exclude_current_process_windows {
                    videorc_windows(content)
                } else {
                    NSArray::<SCWindow>::new()
                };
                let filter = unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &excluded,
                    )
                };
                Ok(SelectedContent {
                    source_width: positive_u32(unsafe { display.width() }),
                    source_height: positive_u32(unsafe { display.height() }),
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
                let frame = unsafe { window.frame() };
                let filter = unsafe {
                    SCContentFilter::initWithDesktopIndependentWindow(
                        SCContentFilter::alloc(),
                        &window,
                    )
                };
                Ok(SelectedContent {
                    source_width: frame.size.width.round().max(1.0) as u32,
                    source_height: frame.size.height.round().max(1.0) as u32,
                    filter,
                })
            }
        }
    }

    fn load_shareable_content() -> Result<Retained<SCShareableContent>, NativeScreenStartup> {
        enum ShareableContentResult {
            Content(usize),
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
                    ShareableContentResult::Content(Retained::into_raw(retained) as usize)
                } else {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit shareable content could not be retained.".to_string(),
                    )
                };
                let _ = tx.send(result);
            },
        );

        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true, true, &handler,
            );
        }

        match rx.recv_timeout(SCREEN_CAPTUREKIT_STARTUP_TIMEOUT) {
            Ok(ShareableContentResult::Content(raw)) => {
                let content = unsafe { Retained::from_raw(raw as *mut SCShareableContent) }
                    .ok_or_else(|| {
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
                "ScreenCaptureKit source discovery timed out.".to_string(),
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

    fn start_capture(stream: &SCStream) -> Result<(), NativeScreenStartup> {
        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(if error.is_null() {
                Ok(())
            } else {
                Err(error_description(error))
            });
        });

        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&handler));
        }

        match rx.recv_timeout(SCREEN_CAPTUREKIT_STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) if is_permission_error(&error) => {
                Err(NativeScreenStartup::PermissionNeeded(error))
            }
            Ok(Err(error)) => Err(NativeScreenStartup::Failed(format!(
                "ScreenCaptureKit stream failed to start: {error}"
            ))),
            Err(_) => Err(NativeScreenStartup::Failed(
                "ScreenCaptureKit stream start timed out.".to_string(),
            )),
        }
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

        let width = CVPixelBufferGetWidth(&pixel_buffer) as u32;
        let height = CVPixelBufferGetHeight(&pixel_buffer) as u32;
        let bytes_per_row = CVPixelBufferGetBytesPerRow(&pixel_buffer);
        let base_address = CVPixelBufferGetBaseAddress(&pixel_buffer);

        if base_address.is_null() || width == 0 || height == 0 {
            unsafe {
                CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
            };
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
        unsafe {
            let copy_started_at = Instant::now();
            let source = base_address.cast::<u8>();
            for row in 0..height_usize {
                let source_row = source.add(row * bytes_per_row);
                let target_row = &mut bytes[row * row_bytes..(row + 1) * row_bytes];
                target_row.copy_from_slice(slice::from_raw_parts(source_row, row_bytes));
            }
            let row_copy_ms = copy_started_at.elapsed().as_secs_f64() * 1000.0;
            CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly);

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
            // Zero-copy: retain the capture IOSurface so the compositor can import it as a Metal
            // texture instead of re-uploading these bytes. Opt-in until validated on-device; the
            // BGRA `bytes` above remain the fallback and the encoder/source-readiness path.
            let source_iosurface = if crate::metal_compositor::source_zerocopy_enabled() {
                CVPixelBufferGetIOSurface(Some(&pixel_buffer))
                    .map(crate::frame_store::RetainedIoSurface::new)
            } else {
                None
            };
            guard.frame_store.publish_with_iosurface(
                sequence,
                width,
                height,
                PreviewScreenPixelFormat::Bgra8,
                now,
                bytes,
                source_iosurface,
            );
            let publish_ms = publish_started_at.elapsed().as_secs_f64() * 1000.0;
            guard.capture_timings.record_valid_frame(
                pixel_buffer_lock_ms,
                row_copy_ms,
                publish_ms,
                frame_bytes as u64,
            );
        }
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
        let title = unsafe { window.title() }
            .as_ref()
            .and_then(|title| ns_string_to_string(title))
            .unwrap_or_default()
            .to_lowercase();
        let process_id_matches = app
            .as_ref()
            .map(|app| unsafe { app.processID() } == current_pid)
            .unwrap_or(false);

        process_id_matches || app_name.contains("videorc") || title.contains("videorc")
    }

    fn positive_u32(value: isize) -> u32 {
        value.max(1) as u32
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
    use tokio::sync::broadcast;

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
        assert_eq!(preview_screen_png_max_width(None), 960);
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

        assert!(timeout >= SCREEN_CAPTUREKIT_STARTUP_TIMEOUT.saturating_mul(2));
        assert!(timeout > Duration::from_secs(5));
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
                video: video.clone(),
            });
        }

        let status = reuse_current_screen_source(&state, &source_key, &video, video.fps)
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
}
