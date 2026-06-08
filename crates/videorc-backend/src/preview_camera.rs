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

use crate::camera_capture::{
    CameraFormatSummary, camera_capability_matrix_for_id, parse_native_camera_id,
};
use crate::diagnostics::{
    PreviewCameraCaptureTimingStats, apply_preview_camera_capability_stats,
    apply_preview_camera_capture_timing_stats, apply_preview_camera_source_stats,
    apply_preview_source_frame_store_stats,
};
use crate::frame_store::{FrameHandle, FrameStore, FrameStoreStats};
use crate::protocol::{
    CameraCapabilityFormat, CameraShape, CameraSize, CameraTransformMode, LayoutPreset,
    LayoutSettings, PreviewCameraStartParams, PreviewCameraState, PreviewCameraStatus,
    VideoSettings,
};
use crate::source_registry::{SourceConsumerReason, SourceKey};
use crate::source_status::SourceLifecycleStatus;
use crate::state::AppState;

const PREVIEW_CAMERA_DEFAULT_PNG_WIDTH: u32 = 640;
const PREVIEW_CAMERA_MAX_PNG_WIDTH: u32 = 1920;
const CAMERA_REFERENCE_WIDTH: u32 = 1280;
const CAMERA_REFERENCE_HEIGHT: u32 = 720;
const CAMERA_OVERLAY_CAPTURE_MIN_WIDTH: u32 = 1280;
const CAMERA_OVERLAY_CAPTURE_MIN_HEIGHT: u32 = 720;

pub type PreviewCameraSlot = Arc<tokio::sync::Mutex<PreviewCameraRuntime>>;

#[derive(Debug)]
pub struct PreviewCameraRuntime {
    pub status: PreviewCameraStatus,
    run_id: Option<String>,
    source_key: Option<SourceKey>,
    active: Option<NativeCameraPreviewThread>,
    poll_task: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct NativeCameraPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewCameraShared>>,
    layout: LayoutSettings,
    video: VideoSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewCameraPixelFormat {
    Bgra8,
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
    frames_captured: u64,
    dropped_frames: u64,
    frames_in_window: u64,
    window_started_at: Option<Instant>,
    source_fps: Option<f64>,
    capture_timings: CameraCaptureTimingWindow,
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
        run_id: None,
        source_key: None,
        active: None,
        poll_task: None,
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
    let Some(unique_id) = parse_native_camera_id(&camera_id) else {
        stop_preview_camera(&state).await;
        refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;
        let status = status_for_missing_camera(
            Some(camera_id),
            "Selected camera is not a native AVFoundation camera.",
        );
        set_camera_status(&state, status.clone()).await;
        return status;
    };
    refresh_camera_capability_diagnostics(&state, Some(camera_id.clone())).await;

    let target_fps = params.video.fps.clamp(1, 120);
    let source_key = SourceKey::camera(camera_id.clone());
    let existing_source_key = current_camera_source_key(&state).await;
    if existing_source_key.as_ref() != Some(&source_key) {
        let keep_alive = release_current_preview_camera_source(&state).await;
        if !keep_alive {
            stop_current_camera(&state).await;
        }
    }
    acquire_preview_camera_source(&state, source_key.clone(), SourceLifecycleStatus::Starting)
        .await;
    if let Some(status) = reuse_current_camera_source(
        &state,
        &source_key,
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

    stop_current_camera(&state).await;

    let run_id = Uuid::new_v4().to_string();
    let shared = Arc::new(StdMutex::new(PreviewCameraShared::default()));
    let (stop_tx, stop_rx) = std_mpsc::channel();
    let (startup_tx, startup_rx) = std_mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    let thread_config = NativeCameraPreviewConfig {
        camera_id: camera_id.clone(),
        unique_id: unique_id.clone(),
        video: params.video.clone(),
        layout: params.layout.clone(),
    };

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
    set_camera_status(&state, starting.clone()).await;

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
            set_camera_status(&state, status.clone()).await;
            return status;
        }
    };

    let startup = tokio::task::spawn_blocking(move || {
        startup_rx
            .recv_timeout(Duration::from_secs(4))
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
            let poll_task = tokio::spawn(poll_camera_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                target_fps,
            ));
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
            {
                let mut slot = state.preview_camera.lock().await;
                slot.status = status.clone();
                slot.run_id = Some(run_id);
                slot.source_key = Some(source_key.clone());
                slot.active = Some(NativeCameraPreviewThread {
                    stop_tx,
                    join_handle: Some(join_handle),
                    shared,
                    layout: params.layout,
                    video: params.video,
                });
                slot.poll_task = Some(poll_task);
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
            acquire_preview_camera_source(
                &state,
                source_key,
                SourceLifecycleStatus::PermissionNeeded,
            )
            .await;
            set_camera_status(&state, status.clone()).await;
            status
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
            acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::SourceMissing)
                .await;
            set_camera_status(&state, status.clone()).await;
            status
        }
        NativeCameraStartup::Failed(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = failed_status(Some(camera_id), Some(unique_id), target_fps, message);
            acquire_preview_camera_source(&state, source_key, SourceLifecycleStatus::Failed).await;
            set_camera_status(&state, status.clone()).await;
            status
        }
    }
}

pub async fn stop_preview_camera(state: &AppState) -> PreviewCameraStatus {
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
        return status;
    }

    stop_current_camera(state).await;
    let status = idle_status(Some("Native camera preview stopped.".to_string()));
    set_camera_status(state, status.clone()).await;
    status
}

pub async fn preview_camera_status(state: &AppState) -> PreviewCameraStatus {
    state.preview_camera.lock().await.status.clone()
}

pub async fn preview_camera_frame_store_stats(state: &AppState) -> FrameStoreStats {
    let shared = {
        let slot = state.preview_camera.lock().await;
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

    let mut rgba = Vec::with_capacity(frame.bytes.len());
    for pixel in frame.bytes.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    if layout.camera_mirror {
        mirror_rgba_in_place(&mut rgba, frame.width as usize, frame.height as usize);
    }
    let (rgba, width, height) = downscale_rgba_for_preview(
        rgba,
        frame.width,
        frame.height,
        preview_camera_png_max_width(requested_max_width),
    );

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
    }
    {
        let mut diagnostics = state.diagnostics.lock().await;
        *diagnostics = apply_preview_camera_source_stats(diagnostics.clone(), &status);
    }
    state.emit_event("preview.camera.status", status);
}

async fn stop_current_camera(state: &AppState) {
    let (previous, poll_task) = {
        let mut slot = state.preview_camera.lock().await;
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

async fn reuse_current_camera_source(
    state: &AppState,
    source_key: &SourceKey,
    layout: &LayoutSettings,
    video: &VideoSettings,
    target_fps: u32,
) -> Option<PreviewCameraStatus> {
    let mut slot = state.preview_camera.lock().await;
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
            CameraSharedSnapshot {
                frames_captured: guard.frames_captured,
                dropped_frames: guard.dropped_frames,
                source_fps: guard.source_fps,
                latest_frame: guard.frame_store.latest(),
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
    latest_frame: Option<FrameHandle<PreviewCameraPixelFormat>>,
    frame_store_stats: FrameStoreStats,
    capture_timings: PreviewCameraCaptureTimingStats,
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
    video: VideoSettings,
    layout: LayoutSettings,
}

fn camera_capture_target_dimensions(layout: &LayoutSettings, video: &VideoSettings) -> (u32, u32) {
    if layout.layout_preset != LayoutPreset::ScreenCamera {
        return (video.width, video.height);
    }

    let (overlay_width, overlay_height) = if let (CameraTransformMode::Custom, Some(transform)) =
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
        scaled_camera_box_size(&layout.camera_size, &layout.camera_shape, video)
    };

    (
        overlay_width
            .max(CAMERA_OVERLAY_CAPTURE_MIN_WIDTH)
            .min(video.width.max(1)),
        overlay_height
            .max(CAMERA_OVERLAY_CAPTURE_MIN_HEIGHT)
            .min(video.height.max(1)),
    )
}

fn scaled_camera_box_size(
    size: &CameraSize,
    shape: &CameraShape,
    video: &VideoSettings,
) -> (u32, u32) {
    let scale = camera_output_scale(video);
    let width = match size {
        CameraSize::Small => 260,
        CameraSize::Medium => 360,
        CameraSize::Large => 480,
    };
    let height = match shape {
        CameraShape::Rectangle => (width * 9 + 8) / 16,
        CameraShape::Circle => width,
    };

    (
        scale_camera_dimension(f64::from(width) * scale),
        scale_camera_dimension(f64::from(height) * scale),
    )
}

fn camera_output_scale(video: &VideoSettings) -> f64 {
    (f64::from(video.width) / f64::from(CAMERA_REFERENCE_WIDTH))
        .min(f64::from(video.height) / f64::from(CAMERA_REFERENCE_HEIGHT))
}

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
    #[cfg(target_os = "macos")]
    macos::run_native_camera_preview(config, shared, stop_rx, startup_tx);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = config;
        let _ = shared;
        let _ = stop_rx;
        let _ = startup_tx.send(NativeCameraStartup::Failed(
            "Native camera preview is only available on macOS.".to_string(),
        ));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::slice;

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
    use objc2_core_media::{CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetDimensions};
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
    use rayon::prelude::*;

    use super::*;
    use crate::camera_capture::{
        CameraFormatSummary, NativeCameraPermission, choose_camera_format,
    };
    use crate::color::{ycbcr_bt709_full_to_bgr, ycbcr_bt709_video_to_bgr};

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
                _sample_buffer: &CMSampleBuffer,
                _connection: &AVCaptureConnection,
            ) {
                let mut guard = self
                    .ivars()
                    .shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            }
        }
    );

    impl CameraPreviewDelegate {
        fn new(shared: Arc<StdMutex<PreviewCameraShared>>) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(CameraDelegateIvars { shared });
            unsafe { msg_send![super(delegate), init] }
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
                let capture_pixel_format = preferred_capture_pixel_format(&output);
                tracing::info!(
                    "Native camera capture pixel format: {} ({})",
                    format_fourcc(capture_pixel_format),
                    if capture_pixel_format == kCVPixelFormatType_32BGRA {
                        "BGRA, full bandwidth"
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

        let fps = requested_fps
            .clamp(1, 120)
            .min(format.format.max_fps.floor().max(1.0) as u32)
            .max(format.format.min_fps.ceil().max(1.0) as u32)
            .max(1);
        let frame_duration = unsafe { CMTime::new(1, fps as i32) };
        let frame_rate_result = unsafe {
            objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                device.setActiveVideoMinFrameDuration(frame_duration);
                device.setActiveVideoMaxFrameDuration(frame_duration);
            }))
        };
        if let Err(exception) = frame_rate_result {
            tracing::warn!(
                "Camera kept its native frame cadence ({fps} fps frame duration was rejected): {}",
                describe_camera_exception(exception)
            );
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

    /// Pick the most bandwidth-efficient capture pixel format the output advertises.
    /// 4:2:0 / 4:2:2 Y'CbCr are ~3/8 and ~1/2 the bytes of BGRA, so a bandwidth-limited
    /// USB capture card (e.g. a Cam Link 4K at 4K) can deliver more frames per second.
    /// `availableVideoCVPixelFormatTypes` is ordered most-efficient-first, so the first
    /// entry is the device's native wire format. Requesting a *non*-native format forces
    /// a slow host conversion (NV12 on a 4:2:2 card drops it to a few fps), so we take the
    /// first advertised format we can convert ourselves; BGRA only if no YUV is offered.
    fn preferred_capture_pixel_format(output: &AVCaptureVideoDataOutput) -> u32 {
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
        formats
            .into_iter()
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

        if width == 0 || height == 0 {
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
        let source_pixel_buffer = if crate::metal_compositor::source_zerocopy_enabled() {
            Some(crate::frame_store::RetainedPixelBuffer::new(
                pixel_buffer.clone(),
            ))
        } else {
            None
        };
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
    fn format_fourcc(format: u32) -> String {
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

    /// NV12 (4:2:0 bi-planar Y'CbCr) -> BGRA, parallelized across output rows.
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
                for (x, pixel) in out_row.chunks_exact_mut(4).enumerate() {
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
    /// order: UYVY (`2vuy`, Cb Y0 Cr Y1) when true, YUY2 (`yuvs`, Y0 Cb Y1 Cr) when false.
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
                for (pair, out8) in out_row.chunks_exact_mut(8).enumerate() {
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
            camera_margin: 24,
            camera_fit: CameraFit::Fill,
            camera_mirror,
            camera_zoom: 100,
            camera_offset_x: 0,
            camera_offset_y: 0,
            side_by_side_split: SideBySideSplit::Even,
            side_by_side_camera_side: SideBySideCameraSide::Right,
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
        assert_eq!(preview_camera_png_max_width(None), 640);
        assert_eq!(preview_camera_png_max_width(Some(0)), 1);
        assert_eq!(preview_camera_png_max_width(Some(1280)), 1280);
        assert_eq!(preview_camera_png_max_width(Some(4096)), 1920);
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
        };

        assert_eq!(params.video.fps, 60);
        assert!(params.layout.camera_mirror);
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
    fn screen_camera_overlay_capture_target_uses_overlay_quality_floor() {
        let mut layout = test_layout(false);
        layout.layout_preset = LayoutPreset::ScreenCamera;
        layout.camera_size = CameraSize::Medium;
        layout.camera_shape = CameraShape::Rectangle;

        assert_eq!(
            camera_capture_target_dimensions(&layout, &test_video()),
            (1280, 720)
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
                layout: test_layout(false),
                video: video.clone(),
            });
        }

        let status =
            reuse_current_camera_source(&state, &source_key, &test_layout(true), &video, video.fps)
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
}
