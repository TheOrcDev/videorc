use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Instant, SystemTime};

use chrono::Utc;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior, sleep};
use uuid::Uuid;

use crate::compositor_synthetic::SyntheticMovingSource;
use crate::diagnostics::{
    apply_active_scene_revision, apply_compositor_stats, apply_runtime_diagnostics_snapshot,
};
use crate::frame_store::{FrameHandle, FrameStore};
use crate::preview_camera::{
    PreviewCameraPixelFormat, preview_camera_latest_frame, preview_camera_latest_frame_info,
    preview_camera_status,
};
use crate::preview_screen::{
    PreviewScreenPixelFormat, preview_screen_latest_frame, preview_screen_latest_frame_info,
    preview_screen_status,
};
use crate::protocol::{
    CameraFit, CameraShape, CompositorBackend, CompositorSceneSourceFit, CompositorSceneSourceKind,
    CompositorSceneSourceStatus, CompositorSceneUpdateParams, CompositorSourceKind,
    CompositorSourceStatus, CompositorState, CompositorStatus, LayoutPreset, LayoutSettings,
    PreviewCameraState, PreviewScreenSourceKind, PreviewScreenState, PreviewSurfaceState,
    PreviewTransport, Scene, SceneSourceKind, SceneTransform, StreamScreen,
};
use crate::state::AppState;

const COMPOSITOR_DIAGNOSTIC_WINDOW: Duration = Duration::from_secs(2);

pub type CompositorSlot = std::sync::Arc<tokio::sync::Mutex<CompositorRuntime>>;
pub type CompositorFrameStore = Arc<StdMutex<FrameStore<CompositorPixelFormat>>>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositorPixelFormat {
    Yuv420p,
}

#[derive(Debug)]
pub struct CompositorRuntime {
    pub status: CompositorStatus,
    scene: Option<CompositorSceneSnapshot>,
    image_sources: HashMap<String, CompositorImageSource>,
    frame_store: CompositorFrameStore,
    latest_frame_evidence: Option<CompositorFrameEvidence>,
    run_id: Option<String>,
    stop_tx: Option<watch::Sender<bool>>,
    render_task: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Copy)]
pub struct CompositorStartParams {
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositorFrameEvidence {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub has_real_source: bool,
    pub camera_sequence: Option<u64>,
    pub screen_sequence: Option<u64>,
    pub published_at: Instant,
}

#[derive(Debug, Clone, Copy)]
pub struct CompositorStartupBarrierParams {
    pub width: u32,
    pub height: u32,
    pub min_consecutive_frames: u32,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositorStartupBarrierResult {
    pub ready: bool,
    pub wait_ms: u64,
    pub frames_observed: u32,
    pub first_source_frame_ms: Option<u64>,
    pub first_full_resolution_frame_ms: Option<u64>,
    pub timeout_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct CompositorMetrics {
    render_fps: f64,
    frames_rendered: u64,
    repeated_frames: u64,
    dropped_frames: u64,
    frame_age_ms: u64,
    frame_time_p95_ms: f64,
    sources: Vec<CompositorSourceStatus>,
}

#[derive(Debug, Clone, PartialEq)]
struct CompositorSceneSnapshot {
    revision: u64,
    scene: Option<Scene>,
    layout: LayoutSettings,
    active_screen: Option<StreamScreen>,
}

#[derive(Debug, Clone, PartialEq)]
struct CompositorImageSource {
    image_path: String,
    file_revision: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    rgba: Option<Arc<Vec<u8>>>,
    state: String,
    message: Option<String>,
}

pub fn initial_compositor_state() -> CompositorRuntime {
    CompositorRuntime {
        status: stopped_status(Some("Compositor is not running.".to_string())),
        scene: None,
        image_sources: HashMap::new(),
        frame_store: Arc::new(StdMutex::new(FrameStore::new(2))),
        latest_frame_evidence: None,
        run_id: None,
        stop_tx: None,
        render_task: None,
    }
}

pub async fn start_synthetic_compositor(
    state: AppState,
    params: CompositorStartParams,
) -> CompositorStatus {
    stop_current_compositor(&state).await;

    let previous_scene_status = {
        let compositor = state.compositor.lock().await;
        (
            compositor.status.scene_revision,
            compositor.status.scene_id.clone(),
            compositor.status.scene_layout.clone(),
            compositor.status.active_screen_id.clone(),
            compositor.status.scene_sources.clone(),
        )
    };
    let run_id = Uuid::new_v4().to_string();
    let target_fps = params.target_fps.clamp(30, 120);
    let status = CompositorStatus {
        state: CompositorState::Live,
        target_fps,
        width: params.width.max(1),
        height: params.height.max(1),
        scene_revision: previous_scene_status.0,
        scene_id: previous_scene_status.1,
        scene_layout: previous_scene_status.2,
        active_screen_id: previous_scene_status.3,
        scene_sources: previous_scene_status.4,
        sources: Vec::new(),
        render_fps: None,
        frames_rendered: 0,
        repeated_frames: 0,
        dropped_frames: 0,
        frame_age_ms: None,
        frame_time_p95_ms: None,
        updated_at: Utc::now().to_rfc3339(),
        message: Some("Synthetic compositor running.".to_string()),
    };
    let (stop_tx, stop_rx) = watch::channel(false);
    let render_task = tokio::spawn(run_synthetic_compositor_loop(
        state.clone(),
        run_id.clone(),
        target_fps,
        stop_rx,
    ));

    {
        let mut compositor = state.compositor.lock().await;
        compositor.frame_store = Arc::new(StdMutex::new(FrameStore::new(2)));
        compositor.latest_frame_evidence = None;
        compositor.status = status.clone();
        compositor.run_id = Some(run_id);
        compositor.stop_tx = Some(stop_tx);
        compositor.render_task = Some(render_task);
    }

    state.emit_event("compositor.status", status.clone());
    status
}

pub async fn update_compositor_surface_size(
    state: &AppState,
    width: u32,
    height: u32,
) -> CompositorStatus {
    let status = {
        let mut compositor = state.compositor.lock().await;
        compositor.status.width = width.max(1);
        compositor.status.height = height.max(1);
        compositor.status.updated_at = Utc::now().to_rfc3339();
        compositor.status.clone()
    };
    state.emit_event("compositor.status", status.clone());
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let next = apply_active_scene_revision(diagnostics.clone(), status.scene_revision);
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
    status
}

pub async fn stop_compositor(state: &AppState) -> CompositorStatus {
    stop_current_compositor(state).await;
    let status = stopped_status(Some("Compositor stopped.".to_string()));
    {
        let mut compositor = state.compositor.lock().await;
        compositor.status = status.clone();
        compositor.latest_frame_evidence = None;
    }
    state.emit_event("compositor.status", status.clone());
    status
}

pub async fn compositor_status(state: &AppState) -> CompositorStatus {
    state.compositor.lock().await.status.clone()
}

pub async fn compositor_frame_store(state: &AppState) -> CompositorFrameStore {
    state.compositor.lock().await.frame_store.clone()
}

pub async fn compositor_latest_frame_evidence(state: &AppState) -> Option<CompositorFrameEvidence> {
    state.compositor.lock().await.latest_frame_evidence
}

pub async fn wait_for_compositor_startup_frames(
    state: &AppState,
    params: CompositorStartupBarrierParams,
) -> CompositorStartupBarrierResult {
    let started_at = Instant::now();
    let min_consecutive = params.min_consecutive_frames.max(1);
    let mut frames_observed = 0_u32;
    let mut last_sequence = None;
    let mut first_source_frame_ms = None;
    let mut first_full_resolution_frame_ms = None;
    let mut timeout_reason = "waiting for compositor frame".to_string();

    loop {
        if let Some(evidence) = compositor_latest_frame_evidence(state).await {
            if evidence.has_real_source && first_source_frame_ms.is_none() {
                first_source_frame_ms = Some(started_at.elapsed().as_millis() as u64);
            }

            if evidence.width == params.width
                && evidence.height == params.height
                && evidence.has_real_source
            {
                if first_full_resolution_frame_ms.is_none() {
                    first_full_resolution_frame_ms = Some(started_at.elapsed().as_millis() as u64);
                }
                if last_sequence != Some(evidence.sequence) {
                    frames_observed = frames_observed.saturating_add(1);
                    last_sequence = Some(evidence.sequence);
                }
                if frames_observed >= min_consecutive {
                    return CompositorStartupBarrierResult {
                        ready: true,
                        wait_ms: started_at.elapsed().as_millis() as u64,
                        frames_observed,
                        first_source_frame_ms,
                        first_full_resolution_frame_ms,
                        timeout_reason: None,
                    };
                }
                timeout_reason = format!(
                    "only {frames_observed}/{min_consecutive} target-resolution compositor frame(s) observed"
                );
            } else {
                frames_observed = 0;
                last_sequence = None;
                timeout_reason =
                    if evidence.width != params.width || evidence.height != params.height {
                        format!(
                            "latest compositor frame is {}x{}, expected {}x{}",
                            evidence.width, evidence.height, params.width, params.height
                        )
                    } else {
                        "latest compositor frame has no real source".to_string()
                    };
            }
        }

        if started_at.elapsed() >= params.timeout {
            return CompositorStartupBarrierResult {
                ready: false,
                wait_ms: started_at.elapsed().as_millis() as u64,
                frames_observed,
                first_source_frame_ms,
                first_full_resolution_frame_ms,
                timeout_reason: Some(timeout_reason),
            };
        }

        sleep(Duration::from_millis(10)).await;
    }
}

pub async fn update_compositor_scene(
    state: &AppState,
    params: CompositorSceneUpdateParams,
) -> CompositorStatus {
    let status = {
        let mut compositor = state.compositor.lock().await;
        if compositor
            .scene
            .as_ref()
            .is_some_and(|current| params.revision < current.revision)
        {
            return compositor.status.clone();
        }

        let snapshot = CompositorSceneSnapshot {
            revision: params.revision,
            scene: params.scene,
            layout: params.layout,
            active_screen: params.active_screen,
        };
        let active_image_source = snapshot
            .active_screen
            .as_ref()
            .map(|screen| compositor.cache_image_source(screen));
        compositor.status.scene_revision = Some(snapshot.revision);
        compositor.status.scene_id = snapshot.scene.as_ref().map(|scene| scene.id.clone());
        compositor.status.scene_layout = Some(snapshot.layout.clone());
        compositor.status.active_screen_id = snapshot
            .active_screen
            .as_ref()
            .map(|screen| screen.id.clone());
        compositor.status.scene_sources =
            compositor_scene_sources(&snapshot, active_image_source.as_ref());
        compositor.status.updated_at = Utc::now().to_rfc3339();
        compositor.scene = Some(snapshot);
        compositor.status.clone()
    };
    state.emit_event("compositor.status", status.clone());
    status
}

pub async fn update_compositor_active_screen(
    state: &AppState,
    active_screen: Option<StreamScreen>,
) -> CompositorStatus {
    let (revision, scene, layout) = {
        let compositor = state.compositor.lock().await;
        let Some(snapshot) = compositor.scene.as_ref() else {
            return compositor.status.clone();
        };
        (
            snapshot.revision.saturating_add(1),
            snapshot.scene.clone(),
            snapshot.layout.clone(),
        )
    };

    update_compositor_scene(
        state,
        CompositorSceneUpdateParams {
            revision,
            scene,
            layout,
            active_screen,
        },
    )
    .await
}

impl CompositorRuntime {
    fn cache_image_source(&mut self, screen: &StreamScreen) -> CompositorImageSource {
        let path = Path::new(&screen.image_path);
        let file_revision = image_file_revision(path);
        if let Some(cached) = self.image_sources.get(&screen.id)
            && cached.image_path == screen.image_path
            && cached.file_revision == file_revision
        {
            return cached.clone();
        }

        let source = if file_revision.is_some() {
            match image::open(path).map(|image| image.into_rgba8()) {
                Ok(image) => {
                    let (width, height) = image.dimensions();
                    CompositorImageSource {
                        image_path: screen.image_path.clone(),
                        file_revision,
                        width: Some(width),
                        height: Some(height),
                        rgba: Some(Arc::new(image.into_raw())),
                        state: "live".to_string(),
                        message: None,
                    }
                }
                Err(error) => CompositorImageSource {
                    image_path: screen.image_path.clone(),
                    file_revision,
                    width: None,
                    height: None,
                    rgba: None,
                    state: "source-missing".to_string(),
                    message: Some(format!("Could not read uploaded screen image: {error}")),
                },
            }
        } else {
            CompositorImageSource {
                image_path: screen.image_path.clone(),
                file_revision,
                width: None,
                height: None,
                rgba: None,
                state: "source-missing".to_string(),
                message: Some("Uploaded screen image file is missing.".to_string()),
            }
        };
        self.image_sources.insert(screen.id.clone(), source.clone());
        source
    }
}

async fn stop_current_compositor(state: &AppState) {
    let previous_task = {
        let mut compositor = state.compositor.lock().await;
        if let Some(stop_tx) = compositor.stop_tx.take() {
            let _ = stop_tx.send(true);
        }
        compositor.run_id = None;
        compositor.render_task.take()
    };

    if let Some(task) = previous_task {
        task.abort();
    }
    let mut compositor = state.compositor.lock().await;
    compositor.latest_frame_evidence = None;
}

async fn run_synthetic_compositor_loop(
    state: AppState,
    run_id: String,
    target_fps: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let (width, height) = compositor_dimensions(&state).await;
    // Persisted GPU compositor (Some only on macOS with VIDEORC_METAL_COMPOSITOR + a GPU);
    // built once and reused per frame. Held across the loop's awaits (it is Send).
    let gpu_compositor = new_gpu_compositor();

    let mut frames_rendered = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut repeated_frames = 0_u64;
    let mut dropped_frames = 0_u64;
    let mut window_started_at = Instant::now();
    let mut previous_tick_at: Option<Instant> = None;
    let mut previous_fingerprint: Option<SourceFrameFingerprint> = None;
    let mut frame_times_ms = Vec::with_capacity(128);
    let mut cpu_fallback_frames = 0_u64;

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                let ticked_at = Instant::now();
                if let Some(previous_tick_at) = previous_tick_at {
                    let expected_frames =
                        (ticked_at.duration_since(previous_tick_at).as_secs_f64() / frame_interval.as_secs_f64())
                            .floor() as u64;
                    if expected_frames > 1 {
                        dropped_frames = dropped_frames.saturating_add(expected_frames - 1);
                    }
                }
                previous_tick_at = Some(ticked_at);

                let render_started_at = Instant::now();
                frames_rendered = frames_rendered.saturating_add(1);
                frames_in_window = frames_in_window.saturating_add(1);
                let published =
                    publish_compositor_frame(&state, frames_rendered, width, height, gpu_compositor.as_ref())
                        .await;
                let fallback_frame_age_ms = published.fallback_frame_age_ms;
                if published.compositor_backend == CompositorBackend::CpuFallback {
                    cpu_fallback_frames = cpu_fallback_frames.saturating_add(1);
                }
                if is_repeated_compositor_frame(previous_fingerprint, published.fingerprint) {
                    repeated_frames = repeated_frames.saturating_add(1);
                }
                previous_fingerprint = Some(published.fingerprint);
                frame_times_ms.push(render_started_at.elapsed().as_secs_f64() * 1000.0);

                let surface_status = update_preview_surface_frames(&state, frames_rendered).await;

                if window_started_at.elapsed() >= COMPOSITOR_DIAGNOSTIC_WINDOW {
                    let elapsed = window_started_at.elapsed().as_secs_f64().max(0.001);
                    let measured_fps = frames_in_window as f64 / elapsed;
                    let (p50, p95, p99) = frame_time_percentiles(&frame_times_ms);
                    let sources = compositor_source_statuses(&state).await;
                    let frame_age_ms = compositor_frame_age_ms(
                        &sources,
                        fallback_frame_age_ms,
                    );
                    let status = update_compositor_status(
                        &state,
                        &run_id,
                        CompositorMetrics {
                            render_fps: measured_fps,
                            frames_rendered,
                            repeated_frames,
                            dropped_frames,
                            frame_age_ms,
                            frame_time_p95_ms: p95,
                            sources,
                        },
                    )
                    .await;
                    let Some(status) = status else {
                        break;
                    };
                    let preview_transport = surface_status
                        .as_ref()
                        .map(|status| status.transport)
                        .unwrap_or(PreviewTransport::Unavailable);
                    let preview_surface_backing = surface_status
                        .as_ref()
                        .map(|status| status.backing)
                        .unwrap_or_default();
                    let diagnostic_stats = {
                        let mut diagnostics = state.diagnostics.lock().await;
                        let next = apply_compositor_stats(
                            diagnostics.clone(),
                            target_fps,
                            preview_transport,
                            preview_surface_backing,
                            published.compositor_backend,
                            published.compositor_fallback_reason.clone(),
                            cpu_fallback_frames,
                            measured_fps,
                            frame_age_ms,
                            repeated_frames,
                            dropped_frames,
                            p50,
                            p95,
                            p99,
                        );
                        *diagnostics = next.clone();
                        next
                    };
                    if let Some(surface_status) = surface_status {
                        state.emit_event("preview.surface.status", surface_status);
                    }
                    state.emit_event("compositor.status", status);
                    state.emit_event(
                        "diagnostics.stats",
                        apply_runtime_diagnostics_snapshot(
                            diagnostic_stats,
                            state.ffmpeg_work.snapshot(),
                        ),
                    );
                    window_started_at = Instant::now();
                    frames_in_window = 0;
                    // repeated_frames and dropped_frames accumulate over the whole run
                    // (cumulative totals, like dropped_frames) — not reset per window.
                    frame_times_ms.clear();
                }
            }
        }
    }
}

async fn compositor_dimensions(state: &AppState) -> (u32, u32) {
    let compositor = state.compositor.lock().await;
    (
        compositor.status.width.max(1),
        compositor.status.height.max(1),
    )
}

/// Identifies which real source frames fed one composited frame, so consecutive ticks
/// can be compared to detect compositor-level repeated frames.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SourceFrameFingerprint {
    camera: Option<u64>,
    screen: Option<u64>,
}

impl SourceFrameFingerprint {
    fn has_real_source(self) -> bool {
        self.camera.is_some() || self.screen.is_some()
    }
}

/// The result of compositing and publishing one frame: how stale the frame was, plus
/// the fingerprint of the real source frames that fed it.
struct CompositorPublishResult {
    fallback_frame_age_ms: u64,
    fingerprint: SourceFrameFingerprint,
    compositor_backend: CompositorBackend,
    compositor_fallback_reason: Option<String>,
}

/// Whether the composited frame for this tick repeats the previous one. A repeat means
/// at least one real source fed the frame and NONE of the real sources changed (same
/// sequence, none appeared or disappeared) since the previous tick. Pure-synthetic
/// frames (no real source) are never counted, because the synthetic generator animates
/// every tick. This honestly counts compositor ticks that re-presented stale source
/// content: a 60fps compositor pulling a 30fps source repeats ~every other tick, while
/// a stalled real source repeats every tick.
fn is_repeated_compositor_frame(
    previous: Option<SourceFrameFingerprint>,
    current: SourceFrameFingerprint,
) -> bool {
    match previous {
        Some(previous) => current.has_real_source() && previous == current,
        None => false,
    }
}

/// Whether the flag-gated Metal/GPU compositor path is requested.
fn metal_compositor_enabled() -> bool {
    std::env::var("VIDEORC_METAL_COMPOSITOR").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on"
        )
    })
}

#[cfg(target_os = "macos")]
use crate::metal_compositor::MetalSceneCompositor as GpuCompositor;
/// Uninhabited stand-in so signatures stay platform-uniform off macOS (always `None`).
#[cfg(not(target_os = "macos"))]
enum GpuCompositor {}

#[cfg(target_os = "macos")]
fn new_gpu_compositor() -> Option<GpuCompositor> {
    if !metal_compositor_enabled() {
        return None;
    }
    match GpuCompositor::new() {
        Some(compositor) => {
            tracing::info!("Metal GPU compositor enabled (VIDEORC_METAL_COMPOSITOR)");
            Some(compositor)
        }
        None => {
            tracing::warn!(
                "VIDEORC_METAL_COMPOSITOR set but no Metal device is available; using the CPU compositor"
            );
            None
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn new_gpu_compositor() -> Option<GpuCompositor> {
    None
}

/// Compose the scene on the GPU for the cases the GPU path reproduces exactly:
/// Screen/Window/Camera sources with transform crop, cover/contain fitting, camera
/// mirror, and camera circle masks. Uploaded-image and test-pattern sources still fall
/// back to the CPU compositor, so enabling the flag never produces a frame for a case the
/// GPU path cannot match.
#[cfg(target_os = "macos")]
fn try_gpu_compose(
    gpu: Option<&GpuCompositor>,
    inputs: &CompositorRenderInputs<'_>,
) -> Result<Vec<u8>, &'static str> {
    let gpu = gpu.ok_or_else(|| {
        if metal_compositor_enabled() {
            "Metal compositor unavailable"
        } else {
            "VIDEORC_METAL_COMPOSITOR disabled"
        }
    })?;
    let snapshot = inputs.snapshot.ok_or("compositor scene unavailable")?;
    if let Some(image) = inputs
        .active_image_source
        .and_then(|source| source.rgba.as_ref().zip(source.width.zip(source.height)))
    {
        let (rgba, (image_width, image_height)) = image;
        let bgra = rgba_to_bgra_bytes(rgba);
        let sources = [crate::metal_compositor::GpuSource {
            bgra: &bgra,
            width: image_width as usize,
            height: image_height as usize,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            circle: false,
        }];
        return gpu
            .compose_yuv420p(inputs.width as usize, inputs.height as usize, &sources)
            .ok_or("Metal compositor failed to render cached image");
    }
    if inputs.active_image_source.is_some() {
        return Err("active screen image is not cached");
    }
    let scene = snapshot
        .scene
        .as_ref()
        .ok_or("compositor scene unavailable")?;
    let layout = &snapshot.layout;
    let mut sources = Vec::new();
    for source in scene.sources.iter().filter(|source| source.visible) {
        let transform = &source.transform;
        let rect = scene_source_rect_pixels(transform, inputs.width, inputs.height)
            .ok_or("source rectangle is outside compositor bounds")?;
        let source_crop = source_crop_from_transform(transform);
        match source.kind {
            SceneSourceKind::Camera => {
                let frame = inputs.camera_frame.ok_or("camera frame unavailable")?;
                let (dest, crop) = gpu_source_placement(
                    frame.width,
                    frame.height,
                    rect,
                    matches!(layout.camera_fit, CameraFit::Fit) && layout.camera_zoom <= 100,
                    source_crop,
                    inputs.width,
                    inputs.height,
                )
                .ok_or("camera source placement failed")?;
                sources.push(crate::metal_compositor::GpuSource {
                    bgra: &frame.bytes,
                    width: frame.width as usize,
                    height: frame.height as usize,
                    dest,
                    crop,
                    mirror: layout.camera_mirror,
                    circle: camera_circle_mask_applies(layout),
                });
            }
            SceneSourceKind::Screen | SceneSourceKind::Window => {
                let frame = inputs.screen_frame.ok_or("screen frame unavailable")?;
                let (dest, crop) = gpu_source_placement(
                    frame.width,
                    frame.height,
                    rect,
                    false,
                    source_crop,
                    inputs.width,
                    inputs.height,
                )
                .ok_or("screen source placement failed")?;
                sources.push(crate::metal_compositor::GpuSource {
                    bgra: &frame.bytes,
                    width: frame.width as usize,
                    height: frame.height as usize,
                    dest,
                    crop,
                    mirror: false,
                    circle: false,
                });
            }
            SceneSourceKind::TestPattern => return Err("test-pattern source unsupported by Metal"),
        }
    }
    if sources.is_empty() {
        return Err("no visible compositor sources");
    }
    gpu.compose_yuv420p(inputs.width as usize, inputs.height as usize, &sources)
        .ok_or("Metal compositor failed to render scene")
}

#[cfg(target_os = "macos")]
fn gpu_source_placement(
    source_width: u32,
    source_height: u32,
    rect: PixelRect,
    contain: bool,
    crop: SourceCrop,
    output_width: u32,
    output_height: u32,
) -> Option<([f32; 4], [f32; 4])> {
    let fit = source_fit(source_width, source_height, rect, contain, crop)?;
    let output_width = f64::from(output_width.max(1));
    let output_height = f64::from(output_height.max(1));
    let source_width = f64::from(source_width.max(1));
    let source_height = f64::from(source_height.max(1));
    let dest = [
        (f64::from(fit.x) / output_width) as f32,
        (f64::from(fit.y) / output_height) as f32,
        (f64::from(fit.width) / output_width) as f32,
        (f64::from(fit.height) / output_height) as f32,
    ];
    let crop = [
        (fit.source_x / source_width).clamp(0.0, 1.0) as f32,
        (fit.source_y / source_height).clamp(0.0, 1.0) as f32,
        (1.0 - ((fit.source_x + fit.source_width) / source_width)).clamp(0.0, 1.0) as f32,
        (1.0 - ((fit.source_y + fit.source_height) / source_height)).clamp(0.0, 1.0) as f32,
    ];
    Some((dest, crop))
}

#[cfg(target_os = "macos")]
fn rgba_to_bgra_bytes(rgba: &[u8]) -> Vec<u8> {
    let mut bgra = Vec::with_capacity(rgba.len());
    for pixel in rgba.chunks_exact(4) {
        bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    bgra
}
#[cfg(not(target_os = "macos"))]
fn try_gpu_compose(
    _gpu: Option<&GpuCompositor>,
    _inputs: &CompositorRenderInputs<'_>,
) -> Result<Vec<u8>, &'static str> {
    Err("Metal compositor unavailable on this OS")
}

async fn publish_compositor_frame(
    state: &AppState,
    sequence: u64,
    width: u32,
    height: u32,
    gpu: Option<&GpuCompositor>,
) -> CompositorPublishResult {
    let (frame_store, snapshot, active_image_source) = {
        let compositor = state.compositor.lock().await;
        let active_image_source = compositor
            .scene
            .as_ref()
            .and_then(|snapshot| snapshot.active_screen.as_ref())
            .and_then(|screen| compositor.image_sources.get(&screen.id))
            .cloned();
        (
            compositor.frame_store.clone(),
            compositor.scene.clone(),
            active_image_source,
        )
    };
    let camera_frame = preview_camera_latest_frame(state).await;
    let screen_frame = preview_screen_latest_frame(state).await;
    let has_image_source = active_image_source
        .as_ref()
        .is_some_and(|source| source.rgba.is_some());
    let fingerprint = SourceFrameFingerprint {
        camera: camera_frame.as_ref().map(|(frame, _layout)| frame.sequence),
        screen: screen_frame.as_ref().map(|frame| frame.sequence),
    };
    let captured_at = Instant::now();
    let mut compositor_backend = CompositorBackend::CpuFallback;
    let mut compositor_fallback_reason = None;
    {
        let mut store = frame_store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut bytes = store.checkout_buffer(raw_yuv420p_len(width, height));
        let inputs = CompositorRenderInputs {
            sequence,
            width,
            height,
            snapshot: snapshot.as_ref(),
            active_image_source: active_image_source.as_ref(),
            camera_frame: camera_frame.as_ref().map(|(frame, _layout)| frame),
            screen_frame: screen_frame.as_ref(),
        };
        // GPU path for the cases it reproduces exactly; otherwise the CPU compositor.
        match try_gpu_compose(gpu, &inputs) {
            Ok(yuv) => {
                let len = bytes.len().min(yuv.len());
                bytes[..len].copy_from_slice(&yuv[..len]);
                compositor_backend = CompositorBackend::Metal;
            }
            Err(reason) => {
                compositor_fallback_reason = Some(reason.to_string());
                render_compositor_yuv420p_frame(inputs, &mut bytes);
            }
        }
        store.publish(
            sequence,
            width,
            height,
            CompositorPixelFormat::Yuv420p,
            captured_at,
            bytes,
        );
    }
    let evidence = CompositorFrameEvidence {
        sequence,
        width,
        height,
        has_real_source: fingerprint.has_real_source() || has_image_source,
        camera_sequence: fingerprint.camera,
        screen_sequence: fingerprint.screen,
        published_at: captured_at,
    };
    let mut compositor = state.compositor.lock().await;
    compositor.latest_frame_evidence = Some(evidence);
    CompositorPublishResult {
        fallback_frame_age_ms: captured_at.elapsed().as_millis() as u64,
        fingerprint,
        compositor_backend,
        compositor_fallback_reason,
    }
}

struct CompositorRenderInputs<'a> {
    sequence: u64,
    width: u32,
    height: u32,
    snapshot: Option<&'a CompositorSceneSnapshot>,
    active_image_source: Option<&'a CompositorImageSource>,
    camera_frame: Option<&'a FrameHandle<PreviewCameraPixelFormat>>,
    screen_frame: Option<&'a FrameHandle<PreviewScreenPixelFormat>>,
}

fn render_compositor_yuv420p_frame(inputs: CompositorRenderInputs<'_>, bytes: &mut [u8]) {
    let CompositorRenderInputs {
        sequence,
        width,
        height,
        snapshot,
        active_image_source,
        camera_frame,
        screen_frame,
    } = inputs;
    fill_yuv420p(bytes, width, height, 16, 128, 128);

    let Some(snapshot) = snapshot else {
        render_synthetic_yuv420p_frame(sequence, width, height, bytes);
        return;
    };
    let Some(scene) = snapshot.scene.as_ref() else {
        render_synthetic_yuv420p_frame(sequence, width, height, bytes);
        return;
    };

    if let Some(image) = active_image_source
        .and_then(|source| source.rgba.as_ref().zip(source.width.zip(source.height)))
    {
        let (rgba, (image_width, image_height)) = image;
        if blit_rgba_to_yuv420p(
            &RgbaSource {
                bytes: rgba,
                width: image_width,
                height: image_height,
                format: SourcePixelFormat::Rgba,
            },
            bytes,
            width,
            height,
            PixelRect {
                x: 0,
                y: 0,
                width,
                height,
            },
            SourceRenderOptions {
                crop: SourceCrop::none(),
                contain: false,
                mirror_x: false,
                circle_mask: false,
            },
        ) {
            return;
        }
    }

    let mut rendered_sources = 0_u32;
    for source in scene.sources.iter().filter(|source| source.visible) {
        let Some(rect) = scene_source_rect_pixels(&source.transform, width, height) else {
            continue;
        };
        let rendered = match source.kind {
            SceneSourceKind::TestPattern => {
                render_synthetic_source_rect(sequence, width, height, rect, bytes);
                true
            }
            SceneSourceKind::Screen | SceneSourceKind::Window => {
                if let Some(image) = active_image_source
                    .and_then(|source| source.rgba.as_ref().zip(source.width.zip(source.height)))
                {
                    let (rgba, (image_width, image_height)) = image;
                    blit_rgba_to_yuv420p(
                        &RgbaSource {
                            bytes: rgba,
                            width: image_width,
                            height: image_height,
                            format: SourcePixelFormat::Rgba,
                        },
                        bytes,
                        width,
                        height,
                        rect,
                        SourceRenderOptions {
                            crop: source_crop_from_transform(&source.transform),
                            contain: false,
                            mirror_x: false,
                            circle_mask: false,
                        },
                    )
                } else if let Some(frame) = screen_frame {
                    blit_rgba_to_yuv420p(
                        &RgbaSource {
                            bytes: &frame.bytes,
                            width: frame.width,
                            height: frame.height,
                            format: SourcePixelFormat::Bgra,
                        },
                        bytes,
                        width,
                        height,
                        rect,
                        SourceRenderOptions {
                            crop: source_crop_from_transform(&source.transform),
                            contain: false,
                            mirror_x: false,
                            circle_mask: false,
                        },
                    )
                } else {
                    false
                }
            }
            SceneSourceKind::Camera => camera_frame.is_some_and(|frame| {
                blit_rgba_to_yuv420p(
                    &RgbaSource {
                        bytes: &frame.bytes,
                        width: frame.width,
                        height: frame.height,
                        format: SourcePixelFormat::Bgra,
                    },
                    bytes,
                    width,
                    height,
                    rect,
                    SourceRenderOptions {
                        crop: source_crop_from_transform(&source.transform),
                        contain: matches!(snapshot.layout.camera_fit, CameraFit::Fit)
                            && snapshot.layout.camera_zoom <= 100,
                        mirror_x: snapshot.layout.camera_mirror,
                        circle_mask: camera_circle_mask_applies(&snapshot.layout),
                    },
                )
            }),
        };
        if rendered {
            rendered_sources = rendered_sources.saturating_add(1);
        }
    }

    if rendered_sources == 0 {
        render_synthetic_yuv420p_frame(sequence, width, height, bytes);
    }
}

async fn update_preview_surface_frames(
    state: &AppState,
    frames_rendered: u64,
) -> Option<crate::protocol::PreviewSurfaceStatus> {
    let mut surface = state.preview_surface.lock().await;
    if surface.status.state != PreviewSurfaceState::Live {
        return None;
    }
    surface.status.frames_rendered = frames_rendered;
    surface.status.updated_at = Utc::now().to_rfc3339();
    Some(surface.status.clone())
}

async fn update_compositor_status(
    state: &AppState,
    run_id: &str,
    metrics: CompositorMetrics,
) -> Option<CompositorStatus> {
    let mut compositor = state.compositor.lock().await;
    if compositor.run_id.as_deref() != Some(run_id) {
        return None;
    }
    compositor.status.state = CompositorState::Live;
    compositor.status.render_fps = Some(metrics.render_fps);
    compositor.status.frames_rendered = metrics.frames_rendered;
    compositor.status.repeated_frames = metrics.repeated_frames;
    compositor.status.dropped_frames = metrics.dropped_frames;
    compositor.status.frame_age_ms = Some(metrics.frame_age_ms);
    compositor.status.frame_time_p95_ms = Some(metrics.frame_time_p95_ms);
    compositor.status.sources = metrics.sources;
    compositor.status.updated_at = Utc::now().to_rfc3339();
    Some(compositor.status.clone())
}

async fn compositor_source_statuses(state: &AppState) -> Vec<CompositorSourceStatus> {
    let camera = preview_camera_status(state).await;
    let camera_frame = preview_camera_latest_frame_info(state).await;
    let screen = preview_screen_status(state).await;
    let screen_frame = preview_screen_latest_frame_info(state).await;

    let mut sources = Vec::with_capacity(2);
    if camera.camera_id.is_some() || camera.state == PreviewCameraState::Live {
        sources.push(CompositorSourceStatus {
            kind: CompositorSourceKind::Camera,
            state: camera_state_name(&camera.state).to_string(),
            source_id: camera.camera_id,
            sequence: camera_frame.map(|frame| frame.sequence).or(camera.sequence),
            width: camera_frame.map(|frame| frame.width).or(camera.width),
            height: camera_frame.map(|frame| frame.height).or(camera.height),
            source_fps: camera.source_fps,
            frame_age_ms: camera_frame
                .map(|frame| frame.frame_age_ms)
                .or(camera.frame_age_ms),
            message: camera.message,
        });
    }
    if screen.source_id.is_some() || screen.state == PreviewScreenState::Live {
        let kind = match screen.source_kind {
            Some(PreviewScreenSourceKind::Window) => CompositorSourceKind::Window,
            Some(PreviewScreenSourceKind::Screen) | None => CompositorSourceKind::Screen,
        };
        sources.push(CompositorSourceStatus {
            kind,
            state: screen_state_name(&screen.state).to_string(),
            source_id: screen.source_id,
            sequence: screen_frame.map(|frame| frame.sequence).or(screen.sequence),
            width: screen_frame.map(|frame| frame.width).or(screen.width),
            height: screen_frame.map(|frame| frame.height).or(screen.height),
            source_fps: screen.source_fps,
            frame_age_ms: screen_frame
                .map(|frame| frame.frame_age_ms)
                .or(screen.frame_age_ms),
            message: screen.message,
        });
    }
    sources
}

fn compositor_frame_age_ms(sources: &[CompositorSourceStatus], fallback: u64) -> u64 {
    sources
        .iter()
        .filter_map(|source| source.frame_age_ms)
        .max()
        .unwrap_or(fallback)
}

fn raw_yuv420p_len(width: u32, height: u32) -> usize {
    let width = width.max(1) as usize;
    let height = height.max(1) as usize;
    let y = width * height;
    let uv = width.div_ceil(2) * height.div_ceil(2) * 2;
    y + uv
}

#[derive(Debug, Clone, Copy)]
struct PixelRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
enum SourcePixelFormat {
    Bgra,
    Rgba,
}

#[derive(Debug, Clone, Copy)]
struct SourceRenderOptions {
    crop: SourceCrop,
    contain: bool,
    mirror_x: bool,
    circle_mask: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SourceCrop {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl SourceCrop {
    fn none() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        }
    }

    fn kept_width(self) -> f64 {
        (1.0 - self.left - self.right).max(0.001)
    }

    fn kept_height(self) -> f64 {
        (1.0 - self.top - self.bottom).max(0.001)
    }
}

fn source_crop_from_transform(transform: &SceneTransform) -> SourceCrop {
    SourceCrop {
        left: transform.crop_left.clamp(0.0, 0.95),
        top: transform.crop_top.clamp(0.0, 0.95),
        right: transform.crop_right.clamp(0.0, 0.95),
        bottom: transform.crop_bottom.clamp(0.0, 0.95),
    }
}

struct RgbaSource<'a> {
    bytes: &'a [u8],
    width: u32,
    height: u32,
    format: SourcePixelFormat,
}

fn scene_source_rect_pixels(
    transform: &SceneTransform,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<PixelRect> {
    if transform.width <= 0.0 || transform.height <= 0.0 {
        return None;
    }
    let x = normalized_to_pixel(transform.x, canvas_width).min(canvas_width.saturating_sub(1));
    let y = normalized_to_pixel(transform.y, canvas_height).min(canvas_height.saturating_sub(1));
    let max_width = canvas_width.saturating_sub(x).max(1);
    let max_height = canvas_height.saturating_sub(y).max(1);
    let width = normalized_to_span(transform.width, canvas_width).min(max_width);
    let height = normalized_to_span(transform.height, canvas_height).min(max_height);
    Some(PixelRect {
        x,
        y,
        width,
        height,
    })
}

fn normalized_to_pixel(value: f64, span: u32) -> u32 {
    (value.clamp(0.0, 1.0) * f64::from(span)).round() as u32
}

fn normalized_to_span(value: f64, span: u32) -> u32 {
    (value.clamp(0.0, 1.0) * f64::from(span)).round().max(1.0) as u32
}

fn fill_yuv420p(bytes: &mut [u8], width: u32, height: u32, y_value: u8, u_value: u8, v_value: u8) {
    let width = width.max(1) as usize;
    let height = height.max(1) as usize;
    let y_len = width * height;
    let uv_len = width.div_ceil(2) * height.div_ceil(2);
    bytes[..y_len].fill(y_value);
    bytes[y_len..y_len + uv_len].fill(u_value);
    bytes[y_len + uv_len..].fill(v_value);
}

fn render_synthetic_yuv420p_frame(sequence: u64, width: u32, height: u32, bytes: &mut [u8]) {
    let width = width.max(1) as usize;
    let height = height.max(1) as usize;
    let y_len = width * height;
    let uv_width = width.div_ceil(2);
    let uv_height = height.div_ceil(2);
    let u_start = y_len;
    let v_start = y_len + uv_width * uv_height;
    let source = SyntheticMovingSource;
    let frame = source.render(sequence, width as u32, height as u32);
    let marker_size = (width.min(height) / 10).clamp(8, 48);
    let marker_x = (frame.marker_x as usize).min(width.saturating_sub(1));
    let marker_y = (frame.marker_y as usize).min(height.saturating_sub(1));
    let marker_left = marker_x.saturating_sub(marker_size);
    let marker_top = marker_y.saturating_sub(marker_size);
    let marker_right = marker_x.saturating_add(marker_size).min(width);
    let marker_bottom = marker_y.saturating_add(marker_size).min(height);

    bytes[..y_len].fill(48_u8.saturating_add((sequence % 96) as u8));
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

fn render_synthetic_source_rect(
    sequence: u64,
    canvas_width: u32,
    canvas_height: u32,
    rect: PixelRect,
    bytes: &mut [u8],
) {
    let canvas_width = canvas_width.max(1) as usize;
    let canvas_height = canvas_height.max(1) as usize;
    let y_len = canvas_width * canvas_height;
    let uv_width = canvas_width.div_ceil(2);
    let uv_height = canvas_height.div_ceil(2);
    let u_start = y_len;
    let v_start = y_len + uv_width * uv_height;
    let left = rect.x as usize;
    let top = rect.y as usize;
    let right = rect.x.saturating_add(rect.width).min(canvas_width as u32) as usize;
    let bottom = rect.y.saturating_add(rect.height).min(canvas_height as u32) as usize;

    for y in top..bottom {
        let row_start = y * canvas_width + left;
        let row_end = y * canvas_width + right;
        bytes[row_start..row_end].fill(48_u8.saturating_add((sequence % 96) as u8));
    }

    let uv_left = left / 2;
    let uv_top = top / 2;
    let uv_right = right.div_ceil(2).min(uv_width);
    let uv_bottom = bottom.div_ceil(2).min(uv_height);
    for y in uv_top..uv_bottom {
        let row_start = y * uv_width + uv_left;
        let row_end = y * uv_width + uv_right;
        bytes[u_start + row_start..u_start + row_end].fill(128);
        bytes[v_start + row_start..v_start + row_end].fill(128);
    }
}

fn blit_rgba_to_yuv420p(
    source: &RgbaSource<'_>,
    dest: &mut [u8],
    canvas_width: u32,
    canvas_height: u32,
    rect: PixelRect,
    options: SourceRenderOptions,
) -> bool {
    if source.width == 0 || source.height == 0 || source.bytes.len() < source_pixel_len(source) {
        return false;
    }
    let Some(fit) = source_fit(
        source.width,
        source.height,
        rect,
        options.contain,
        options.crop,
    ) else {
        return false;
    };
    let canvas_width = canvas_width.max(1) as usize;
    let canvas_height = canvas_height.max(1) as usize;
    let y_len = canvas_width * canvas_height;
    let uv_width = canvas_width.div_ceil(2);
    let uv_height = canvas_height.div_ceil(2);
    let u_start = y_len;
    let v_start = y_len + uv_width * uv_height;
    let draw_left = fit.x as usize;
    let draw_top = fit.y as usize;
    let draw_right = fit.x.saturating_add(fit.width).min(canvas_width as u32) as usize;
    let draw_bottom = fit.y.saturating_add(fit.height).min(canvas_height as u32) as usize;

    for dest_y in draw_top..draw_bottom {
        for dest_x in draw_left..draw_right {
            if options.circle_mask && !inside_ellipse(dest_x, dest_y, &fit) {
                continue;
            }
            let Some((source_x, source_y)) =
                map_source_pixel(dest_x as u32, dest_y as u32, source, &fit, options.mirror_x)
            else {
                continue;
            };
            let (r, g, b, a) = read_source_rgba(source, source_x, source_y);
            if a < 16 {
                continue;
            }
            let (y_value, _u_value, _v_value) = rgb_to_yuv(r, g, b);
            dest[dest_y * canvas_width + dest_x] = y_value;
        }
    }

    let uv_left = draw_left / 2;
    let uv_top = draw_top / 2;
    let uv_right = draw_right.div_ceil(2).min(uv_width);
    let uv_bottom = draw_bottom.div_ceil(2).min(uv_height);
    for uv_y in uv_top..uv_bottom {
        for uv_x in uv_left..uv_right {
            let dest_x = (uv_x * 2).min(draw_right.saturating_sub(1));
            let dest_y = (uv_y * 2).min(draw_bottom.saturating_sub(1));
            if options.circle_mask && !inside_ellipse(dest_x, dest_y, &fit) {
                continue;
            }
            let Some((source_x, source_y)) =
                map_source_pixel(dest_x as u32, dest_y as u32, source, &fit, options.mirror_x)
            else {
                continue;
            };
            let (r, g, b, a) = read_source_rgba(source, source_x, source_y);
            if a < 16 {
                continue;
            }
            let (_y_value, u_value, v_value) = rgb_to_yuv(r, g, b);
            let uv_index = uv_y * uv_width + uv_x;
            dest[u_start + uv_index] = u_value;
            dest[v_start + uv_index] = v_value;
        }
    }
    true
}

#[derive(Debug, Clone, Copy)]
struct SourceFit {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    source_x: f64,
    source_y: f64,
    source_width: f64,
    source_height: f64,
}

fn source_fit(
    source_width: u32,
    source_height: u32,
    rect: PixelRect,
    contain: bool,
    crop: SourceCrop,
) -> Option<SourceFit> {
    if rect.width == 0 || rect.height == 0 || source_width == 0 || source_height == 0 {
        return None;
    }
    let source_x = crop.left * f64::from(source_width);
    let source_y = crop.top * f64::from(source_height);
    let source_w = f64::from(source_width) * crop.kept_width();
    let source_h = f64::from(source_height) * crop.kept_height();
    let source_aspect = source_w / source_h;
    let rect_aspect = f64::from(rect.width) / f64::from(rect.height);
    if contain {
        let (width, height) = if source_aspect > rect_aspect {
            let width = rect.width;
            let height = (f64::from(width) / source_aspect).round().max(1.0) as u32;
            (width, height.min(rect.height))
        } else {
            let height = rect.height;
            let width = (f64::from(height) * source_aspect).round().max(1.0) as u32;
            (width.min(rect.width), height)
        };
        Some(SourceFit {
            x: rect.x + (rect.width - width) / 2,
            y: rect.y + (rect.height - height) / 2,
            width,
            height,
            source_x,
            source_y,
            source_width: source_w,
            source_height: source_h,
        })
    } else {
        let (source_x, source_y, fitted_source_width, fitted_source_height) =
            if source_aspect > rect_aspect {
                let fitted_source_width = source_h * rect_aspect;
                (
                    source_x + (source_w - fitted_source_width) / 2.0,
                    source_y,
                    fitted_source_width,
                    source_h,
                )
            } else {
                let fitted_source_height = source_w / rect_aspect;
                (
                    source_x,
                    source_y + (source_h - fitted_source_height) / 2.0,
                    source_w,
                    fitted_source_height,
                )
            };
        Some(SourceFit {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            source_x,
            source_y,
            source_width: fitted_source_width,
            source_height: fitted_source_height,
        })
    }
}

fn map_source_pixel(
    dest_x: u32,
    dest_y: u32,
    source: &RgbaSource<'_>,
    fit: &SourceFit,
    mirror_x: bool,
) -> Option<(u32, u32)> {
    if dest_x < fit.x || dest_y < fit.y || fit.width == 0 || fit.height == 0 {
        return None;
    }
    let local_x = f64::from(dest_x - fit.x) / f64::from(fit.width);
    let local_y = f64::from(dest_y - fit.y) / f64::from(fit.height);
    if !(0.0..=1.0).contains(&local_x) || !(0.0..=1.0).contains(&local_y) {
        return None;
    }
    let source_x = fit.source_x + local_x * fit.source_width;
    let source_y = fit.source_y + local_y * fit.source_height;
    let source_x = source_x
        .floor()
        .clamp(0.0, f64::from(source.width.saturating_sub(1))) as u32;
    let source_y = source_y
        .floor()
        .clamp(0.0, f64::from(source.height.saturating_sub(1))) as u32;
    let source_x = if mirror_x {
        source.width.saturating_sub(1).saturating_sub(source_x)
    } else {
        source_x
    };
    Some((source_x, source_y))
}

fn inside_ellipse(dest_x: usize, dest_y: usize, fit: &SourceFit) -> bool {
    let center_x = f64::from(fit.x) + f64::from(fit.width) / 2.0;
    let center_y = f64::from(fit.y) + f64::from(fit.height) / 2.0;
    let radius_x = f64::from(fit.width) / 2.0;
    let radius_y = f64::from(fit.height) / 2.0;
    if radius_x <= 0.0 || radius_y <= 0.0 {
        return false;
    }
    let dx = (dest_x as f64 + 0.5 - center_x) / radius_x;
    let dy = (dest_y as f64 + 0.5 - center_y) / radius_y;
    dx * dx + dy * dy <= 1.0
}

fn source_pixel_len(source: &RgbaSource<'_>) -> usize {
    source.width as usize * source.height as usize * 4
}

fn read_source_rgba(source: &RgbaSource<'_>, x: u32, y: u32) -> (u8, u8, u8, u8) {
    let index = (y as usize * source.width as usize + x as usize) * 4;
    match source.format {
        SourcePixelFormat::Bgra => (
            source.bytes[index + 2],
            source.bytes[index + 1],
            source.bytes[index],
            source.bytes[index + 3],
        ),
        SourcePixelFormat::Rgba => (
            source.bytes[index],
            source.bytes[index + 1],
            source.bytes[index + 2],
            source.bytes[index + 3],
        ),
    }
}

fn rgb_to_yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = ((77 * r + 150 * g + 29 * b) >> 8).clamp(0, 255) as u8;
    let u = (128 + ((-43 * r - 85 * g + 128 * b) >> 8)).clamp(0, 255) as u8;
    let v = (128 + ((128 * r - 107 * g - 21 * b) >> 8)).clamp(0, 255) as u8;
    (y, u, v)
}

fn camera_state_name(state: &PreviewCameraState) -> &'static str {
    match state {
        PreviewCameraState::DeviceMissing => "device-missing",
        PreviewCameraState::PermissionNeeded => "permission-needed",
        PreviewCameraState::Starting => "starting",
        PreviewCameraState::Live => "live",
        PreviewCameraState::Failed => "failed",
    }
}

fn screen_state_name(state: &PreviewScreenState) -> &'static str {
    match state {
        PreviewScreenState::SourceMissing => "source-missing",
        PreviewScreenState::PermissionNeeded => "permission-needed",
        PreviewScreenState::Starting => "starting",
        PreviewScreenState::Live => "live",
        PreviewScreenState::Failed => "failed",
    }
}

fn stopped_status(message: Option<String>) -> CompositorStatus {
    CompositorStatus {
        state: CompositorState::Stopped,
        target_fps: 0,
        width: 0,
        height: 0,
        scene_revision: None,
        scene_id: None,
        scene_layout: None,
        active_screen_id: None,
        scene_sources: Vec::new(),
        sources: Vec::new(),
        render_fps: None,
        frames_rendered: 0,
        repeated_frames: 0,
        dropped_frames: 0,
        frame_age_ms: None,
        frame_time_p95_ms: None,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

fn compositor_scene_sources(
    snapshot: &CompositorSceneSnapshot,
    active_image_source: Option<&CompositorImageSource>,
) -> Vec<CompositorSceneSourceStatus> {
    let scene_source_count = snapshot
        .scene
        .as_ref()
        .map(|scene| scene.sources.len())
        .unwrap_or(0);
    let mut sources =
        Vec::with_capacity(scene_source_count + usize::from(snapshot.active_screen.is_some()));
    if let Some(scene) = &snapshot.scene {
        sources.extend(
            scene
                .sources
                .iter()
                .map(|source| CompositorSceneSourceStatus {
                    id: source.id.clone(),
                    name: source.name.clone(),
                    kind: compositor_scene_source_kind(&source.kind),
                    state: "referenced".to_string(),
                    device_id: source.device_id.clone(),
                    visible: source.visible,
                    transform: source.transform.clone(),
                    fit: compositor_scene_source_fit(&source.kind, &snapshot.layout),
                    mirror: matches!(source.kind, SceneSourceKind::Camera)
                        && snapshot.layout.camera_mirror,
                    shape: if matches!(source.kind, SceneSourceKind::Camera) {
                        Some(if camera_circle_mask_applies(&snapshot.layout) {
                            CameraShape::Circle
                        } else {
                            CameraShape::Rectangle
                        })
                    } else {
                        None
                    },
                    image_path: None,
                    file_revision: None,
                    width: None,
                    height: None,
                    message: None,
                }),
        );
    }
    if let Some(active_screen) = &snapshot.active_screen {
        sources.push(CompositorSceneSourceStatus {
            id: format!("screen-image:{}", active_screen.id),
            name: active_screen.name.clone(),
            kind: CompositorSceneSourceKind::ScreenImage,
            state: active_image_source
                .map(|source| source.state.clone())
                .unwrap_or_else(|| "source-missing".to_string()),
            device_id: None,
            visible: true,
            transform: full_frame_transform(),
            fit: CompositorSceneSourceFit::Cover,
            mirror: false,
            shape: None,
            image_path: active_image_source.map(|source| source.image_path.clone()),
            file_revision: active_image_source.and_then(|source| source.file_revision.clone()),
            width: active_image_source.and_then(|source| source.width),
            height: active_image_source.and_then(|source| source.height),
            message: active_image_source.and_then(|source| source.message.clone()),
        });
    }
    sources
}

fn image_file_revision(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Some(format!("{}:{modified_ms}", metadata.len()))
}

fn compositor_scene_source_kind(kind: &SceneSourceKind) -> CompositorSceneSourceKind {
    match kind {
        SceneSourceKind::Screen => CompositorSceneSourceKind::Screen,
        SceneSourceKind::Window => CompositorSceneSourceKind::Window,
        SceneSourceKind::Camera => CompositorSceneSourceKind::Camera,
        SceneSourceKind::TestPattern => CompositorSceneSourceKind::TestPattern,
    }
}

fn compositor_scene_source_fit(
    kind: &SceneSourceKind,
    layout: &LayoutSettings,
) -> CompositorSceneSourceFit {
    if matches!(kind, SceneSourceKind::Camera) {
        return match layout.camera_fit {
            CameraFit::Fit => CompositorSceneSourceFit::Contain,
            CameraFit::Fill => CompositorSceneSourceFit::Cover,
        };
    }
    if layout.layout_preset == LayoutPreset::SideBySide {
        CompositorSceneSourceFit::Cover
    } else {
        CompositorSceneSourceFit::Contain
    }
}

fn camera_circle_mask_applies(layout: &LayoutSettings) -> bool {
    matches!(layout.layout_preset, LayoutPreset::ScreenCamera)
        && matches!(layout.camera_shape, CameraShape::Circle)
}

fn full_frame_transform() -> SceneTransform {
    SceneTransform {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

fn frame_time_percentiles(values: &[f64]) -> (f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    (
        percentile(&sorted, 50),
        percentile(&sorted, 95),
        percentile(&sorted, 99),
    )
}

fn percentile(sorted: &[f64], p: u32) -> f64 {
    let index = (((p as f64 / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SceneConfigParams, StreamScreenStatus, VideoPreset, VideoSettings};
    use crate::storage::Database;
    use tokio::sync::broadcast;

    fn fp(camera: Option<u64>, screen: Option<u64>) -> SourceFrameFingerprint {
        SourceFrameFingerprint { camera, screen }
    }

    #[test]
    fn first_tick_is_never_a_repeat() {
        assert!(!is_repeated_compositor_frame(None, fp(Some(1), None)));
    }

    #[test]
    fn pure_synthetic_frames_are_never_repeats() {
        let none = SourceFrameFingerprint::default();
        assert!(!is_repeated_compositor_frame(Some(none), none));
    }

    #[test]
    fn unchanged_real_source_is_a_repeat() {
        let f = fp(Some(5), Some(9));
        assert!(is_repeated_compositor_frame(Some(f), f));
        // A stalled camera with no screen still repeats.
        let c = fp(Some(7), None);
        assert!(is_repeated_compositor_frame(Some(c), c));
    }

    #[test]
    fn an_advancing_source_is_not_a_repeat() {
        let prev = fp(Some(5), Some(9));
        assert!(!is_repeated_compositor_frame(
            Some(prev),
            fp(Some(6), Some(9))
        ));
        assert!(!is_repeated_compositor_frame(
            Some(prev),
            fp(Some(5), Some(10))
        ));
    }

    #[test]
    fn an_appearing_or_disappearing_source_is_not_a_repeat() {
        let prev = fp(None, Some(9));
        assert!(!is_repeated_compositor_frame(
            Some(prev),
            fp(Some(1), Some(9))
        ));
        let prev = fp(Some(1), Some(9));
        assert!(!is_repeated_compositor_frame(Some(prev), fp(None, Some(9))));
    }

    #[test]
    fn yuv_blit_applies_transform_crop_before_cover_fit() {
        let mut source = Vec::new();
        for _ in 0..2 {
            source.extend([255, 0, 0, 255].repeat(2));
            source.extend([0, 0, 255, 255].repeat(2));
        }
        let mut bytes = vec![0; raw_yuv420p_len(4, 2)];

        assert!(blit_rgba_to_yuv420p(
            &RgbaSource {
                bytes: &source,
                width: 4,
                height: 2,
                format: SourcePixelFormat::Rgba,
            },
            &mut bytes,
            4,
            2,
            PixelRect {
                x: 0,
                y: 0,
                width: 4,
                height: 2,
            },
            SourceRenderOptions {
                crop: SourceCrop {
                    left: 0.5,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                },
                contain: false,
                mirror_x: false,
                circle_mask: false,
            },
        ));

        let (blue_y, _, _) = rgb_to_yuv(0, 0, 255);
        assert!(bytes[..8].iter().all(|&value| value == blue_y));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gpu_source_placement_reports_transform_crop_to_shader() {
        let (dest, crop) = gpu_source_placement(
            4,
            2,
            PixelRect {
                x: 0,
                y: 0,
                width: 4,
                height: 2,
            },
            false,
            SourceCrop {
                left: 0.5,
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
            },
            4,
            2,
        )
        .expect("gpu placement");

        assert_eq!(dest, [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(crop, [0.5, 0.25, 0.0, 0.25]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn gpu_source_placement_reports_contain_inset_as_quad() {
        let (dest, crop) = gpu_source_placement(
            4,
            2,
            PixelRect {
                x: 0,
                y: 0,
                width: 4,
                height: 4,
            },
            true,
            SourceCrop::none(),
            4,
            4,
        )
        .expect("gpu placement");

        assert_eq!(dest, [0.0, 0.25, 1.0, 0.5]);
        assert_eq!(crop, [0.0, 0.0, 0.0, 0.0]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rgba_to_bgra_bytes_prepares_cached_images_for_metal() {
        assert_eq!(
            rgba_to_bgra_bytes(&[10, 20, 30, 40, 50, 60, 70, 80]),
            vec![30, 20, 10, 40, 70, 60, 50, 80]
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

    async fn set_latest_frame_evidence(
        state: &AppState,
        sequence: u64,
        width: u32,
        height: u32,
        has_real_source: bool,
    ) {
        let mut compositor = state.compositor.lock().await;
        compositor.latest_frame_evidence = Some(CompositorFrameEvidence {
            sequence,
            width,
            height,
            has_real_source,
            camera_sequence: has_real_source.then_some(sequence),
            screen_sequence: None,
            published_at: Instant::now(),
        });
    }

    #[tokio::test]
    async fn synthetic_compositor_reports_render_cadence() {
        let state = test_state();
        start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps: 60,
                width: 640,
                height: 360,
            },
        )
        .await;

        tokio::time::sleep(COMPOSITOR_DIAGNOSTIC_WINDOW + Duration::from_millis(250)).await;
        let status = compositor_status(&state).await;
        stop_compositor(&state).await;

        assert_eq!(status.state, CompositorState::Live);
        assert!(status.frames_rendered >= 30);
        assert!(status.render_fps.unwrap_or_default() >= 30.0);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
    }

    #[tokio::test]
    async fn startup_barrier_waits_for_consecutive_target_real_frames() {
        let state = test_state();
        let writer_state = state.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(10)).await;
            set_latest_frame_evidence(&writer_state, 1, 1920, 1080, true).await;
            sleep(Duration::from_millis(10)).await;
            set_latest_frame_evidence(&writer_state, 2, 1920, 1080, true).await;
        });

        let result = wait_for_compositor_startup_frames(
            &state,
            CompositorStartupBarrierParams {
                width: 1920,
                height: 1080,
                min_consecutive_frames: 2,
                timeout: Duration::from_millis(250),
            },
        )
        .await;

        assert!(result.ready, "{result:?}");
        assert_eq!(result.frames_observed, 2);
        assert!(result.first_source_frame_ms.is_some());
        assert!(result.first_full_resolution_frame_ms.is_some());
        assert_eq!(result.timeout_reason, None);
    }

    #[tokio::test]
    async fn startup_barrier_times_out_on_preview_sized_or_synthetic_frames() {
        let state = test_state();
        set_latest_frame_evidence(&state, 1, 640, 360, true).await;

        let preview_sized = wait_for_compositor_startup_frames(
            &state,
            CompositorStartupBarrierParams {
                width: 1920,
                height: 1080,
                min_consecutive_frames: 1,
                timeout: Duration::from_millis(20),
            },
        )
        .await;
        assert!(!preview_sized.ready);
        assert!(
            preview_sized
                .timeout_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("640x360"))
        );

        set_latest_frame_evidence(&state, 2, 1920, 1080, false).await;
        let synthetic = wait_for_compositor_startup_frames(
            &state,
            CompositorStartupBarrierParams {
                width: 1920,
                height: 1080,
                min_consecutive_frames: 1,
                timeout: Duration::from_millis(20),
            },
        )
        .await;
        assert!(!synthetic.ready);
        assert!(
            synthetic
                .timeout_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("no real source"))
        );
    }

    #[tokio::test]
    async fn compositor_start_replaces_stale_frame_store() {
        let state = test_state();
        let old_store = compositor_frame_store(&state).await;
        {
            let mut store = old_store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            store.publish(
                99,
                640,
                360,
                CompositorPixelFormat::Yuv420p,
                Instant::now(),
                vec![0; raw_yuv420p_len(640, 360)],
            );
        }

        start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps: 30,
                width: 1920,
                height: 1080,
            },
        )
        .await;
        let new_store = compositor_frame_store(&state).await;
        stop_compositor(&state).await;

        assert!(!Arc::ptr_eq(&old_store, &new_store));
    }

    #[tokio::test]
    async fn compositor_scene_update_keeps_latest_revision() {
        let state = test_state();
        let scene = crate::scene::default_scene();
        let layout = crate::protocol::default_layout_settings();
        let status = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 10,
                scene: Some(scene.clone()),
                layout: layout.clone(),
                active_screen: None,
            },
        )
        .await;

        assert_eq!(status.scene_revision, Some(10));
        assert_eq!(status.scene_sources.len(), scene.sources.len());

        let stale = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 9,
                scene: None,
                layout: layout.clone(),
                active_screen: Some(test_stream_screen("stale-screen")),
            },
        )
        .await;

        assert_eq!(stale.scene_revision, Some(10));
        assert_eq!(stale.scene_sources.len(), scene.sources.len());

        let newest = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 11,
                scene: None,
                layout,
                active_screen: Some(test_stream_screen("new-screen")),
            },
        )
        .await;

        assert_eq!(newest.scene_revision, Some(11));
        assert_eq!(newest.scene_sources.len(), 1);
        assert_eq!(newest.scene_sources[0].id, "screen-image:new-screen");
        assert_eq!(
            newest.scene_sources[0].kind,
            CompositorSceneSourceKind::ScreenImage
        );
    }

    #[tokio::test]
    async fn compositor_image_source_cache_reports_live_and_missing_states() {
        let state = test_state();
        let layout = crate::protocol::default_layout_settings();
        let image_path =
            std::env::temp_dir().join(format!("videorc-compositor-image-{}.png", Uuid::new_v4()));
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 0]));
        image.save(&image_path).unwrap();
        let screen = test_stream_screen_with_path("cached-screen", &image_path);

        let first = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 1,
                scene: None,
                layout: layout.clone(),
                active_screen: Some(screen.clone()),
            },
        )
        .await;

        let first_source = &first.scene_sources[0];
        assert_eq!(first_source.state, "live");
        assert_eq!(first_source.width, Some(1));
        assert_eq!(first_source.height, Some(1));
        assert!(first_source.file_revision.is_some());
        let first_revision = first_source.file_revision.clone();

        let second = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 2,
                scene: None,
                layout: layout.clone(),
                active_screen: Some(screen.clone()),
            },
        )
        .await;

        assert_eq!(second.scene_sources[0].file_revision, first_revision);
        assert_eq!(state.compositor.lock().await.image_sources.len(), 1);

        std::fs::remove_file(&image_path).unwrap();
        let missing = update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 3,
                scene: None,
                layout,
                active_screen: Some(screen),
            },
        )
        .await;

        assert_eq!(missing.scene_sources[0].state, "source-missing");
        assert!(missing.scene_sources[0].message.is_some());
        assert_eq!(state.compositor.lock().await.image_sources.len(), 1);
    }

    #[test]
    fn active_screen_image_overrides_test_pattern_frame() {
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = LayoutPreset::ScreenOnly;
        let scene = crate::scene::scene_from_capture_config(SceneConfigParams {
            sources: crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: layout.clone(),
            video: Some(VideoSettings {
                preset: VideoPreset::Custom,
                width: 4,
                height: 4,
                fps: 30,
                bitrate_kbps: 2000,
            }),
        });
        let snapshot = CompositorSceneSnapshot {
            revision: 1,
            scene: Some(scene),
            layout,
            active_screen: Some(test_stream_screen("red")),
        };
        let active_image_source = CompositorImageSource {
            image_path: "red.png".to_string(),
            file_revision: None,
            width: Some(2),
            height: Some(2),
            rgba: Some(Arc::new(vec![
                255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
            ])),
            state: "live".to_string(),
            message: None,
        };
        let mut bytes = vec![0; raw_yuv420p_len(4, 4)];

        render_compositor_yuv420p_frame(
            CompositorRenderInputs {
                sequence: 1,
                width: 4,
                height: 4,
                snapshot: Some(&snapshot),
                active_image_source: Some(&active_image_source),
                camera_frame: None,
                screen_frame: None,
            },
            &mut bytes,
        );

        let y_len = 4 * 4;
        let uv_len = 2 * 2;
        let (red_y, red_u, red_v) = rgb_to_yuv(255, 0, 0);
        assert_eq!(bytes[0], red_y);
        assert_eq!(bytes[y_len], red_u);
        assert_eq!(bytes[y_len + uv_len], red_v);
    }

    #[test]
    fn camera_only_scene_ignores_circle_shape_mask() {
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = LayoutPreset::CameraOnly;
        layout.camera_shape = CameraShape::Circle;
        let scene = crate::scene::scene_from_capture_config(SceneConfigParams {
            sources: crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: Some("camera:avfoundation:0".to_string()),
                microphone_id: None,
                test_pattern: false,
            },
            layout: layout.clone(),
            video: Some(VideoSettings {
                preset: VideoPreset::Custom,
                width: 4,
                height: 4,
                fps: 30,
                bitrate_kbps: 2000,
            }),
        });
        let snapshot = CompositorSceneSnapshot {
            revision: 1,
            scene: Some(scene),
            layout,
            active_screen: None,
        };
        let camera_frame = Arc::new(crate::frame_store::StoredFrame {
            sequence: 1,
            width: 4,
            height: 4,
            pixel_format: PreviewCameraPixelFormat::Bgra8,
            bytes: [0, 0, 255, 255].repeat(16),
            captured_at: Instant::now(),
        });
        let mut bytes = vec![0; raw_yuv420p_len(4, 4)];

        render_compositor_yuv420p_frame(
            CompositorRenderInputs {
                sequence: 1,
                width: 4,
                height: 4,
                snapshot: Some(&snapshot),
                active_image_source: None,
                camera_frame: Some(&camera_frame),
                screen_frame: None,
            },
            &mut bytes,
        );

        let (red_y, _, _) = rgb_to_yuv(255, 0, 0);
        assert_eq!(bytes[0], red_y);
    }

    #[tokio::test]
    async fn active_screen_update_preserves_current_scene() {
        let state = test_state();
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = LayoutPreset::ScreenOnly;
        let scene = crate::scene::scene_from_capture_config(SceneConfigParams {
            sources: crate::protocol::SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: layout.clone(),
            video: None,
        });
        let scene_source_count = scene.sources.len();

        update_compositor_scene(
            &state,
            CompositorSceneUpdateParams {
                revision: 20,
                scene: Some(scene),
                layout,
                active_screen: None,
            },
        )
        .await;

        let active =
            update_compositor_active_screen(&state, Some(test_stream_screen("active"))).await;
        assert_eq!(active.scene_sources.len(), scene_source_count + 1);
        assert_eq!(active.active_screen_id.as_deref(), Some("active"));
        assert!(
            active
                .scene_sources
                .iter()
                .any(|source| source.id == "source:test-pattern")
        );
        assert!(
            active
                .scene_sources
                .iter()
                .any(|source| source.id == "screen-image:active")
        );

        let cleared = update_compositor_active_screen(&state, None).await;
        assert_eq!(cleared.scene_sources.len(), scene_source_count);
        assert_eq!(cleared.active_screen_id, None);
        assert!(
            cleared
                .scene_sources
                .iter()
                .all(|source| source.kind != CompositorSceneSourceKind::ScreenImage)
        );
    }

    #[test]
    fn compositor_frame_age_uses_latest_real_source_age() {
        let sources = vec![
            CompositorSourceStatus {
                kind: CompositorSourceKind::Camera,
                state: "live".to_string(),
                source_id: Some("camera:1".to_string()),
                sequence: Some(12),
                width: Some(640),
                height: Some(360),
                source_fps: Some(60.0),
                frame_age_ms: Some(42),
                message: None,
            },
            CompositorSourceStatus {
                kind: CompositorSourceKind::Screen,
                state: "source-missing".to_string(),
                source_id: Some("screen:1".to_string()),
                sequence: None,
                width: None,
                height: None,
                source_fps: None,
                frame_age_ms: Some(130),
                message: Some("Screen missing".to_string()),
            },
        ];

        assert_eq!(compositor_frame_age_ms(&sources, 0), 130);
    }

    fn test_stream_screen(id: &str) -> StreamScreen {
        test_stream_screen_with_path(id, &std::path::PathBuf::from(format!("/tmp/{id}.png")))
    }

    fn test_stream_screen_with_path(id: &str, image_path: &std::path::Path) -> StreamScreen {
        StreamScreen {
            id: id.to_string(),
            name: format!("Screen {id}"),
            image_path: image_path.display().to_string(),
            thumbnail_path: None,
            sort_order: 1,
            status: StreamScreenStatus::Ready,
            created_at: "2026-06-04T00:00:00Z".to_string(),
            updated_at: "2026-06-04T00:00:00Z".to_string(),
        }
    }
}
