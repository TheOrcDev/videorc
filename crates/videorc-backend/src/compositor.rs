use std::collections::HashMap;
use std::path::Path;
use std::time::{Instant, SystemTime};

use chrono::Utc;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::compositor_synthetic::SyntheticMovingSource;
use crate::diagnostics::{
    apply_active_scene_revision, apply_compositor_stats, apply_runtime_diagnostics_snapshot,
};
use crate::preview_camera::{preview_camera_latest_frame_info, preview_camera_status};
use crate::preview_screen::{preview_screen_latest_frame_info, preview_screen_status};
use crate::protocol::{
    CameraFit, CompositorSceneSourceFit, CompositorSceneSourceKind, CompositorSceneSourceStatus,
    CompositorSceneUpdateParams, CompositorSourceKind, CompositorSourceStatus, CompositorState,
    CompositorStatus, LayoutPreset, LayoutSettings, PreviewCameraState, PreviewScreenSourceKind,
    PreviewScreenState, PreviewSurfaceState, Scene, SceneSourceKind, SceneTransform, StreamScreen,
};
use crate::state::AppState;

pub type CompositorSlot = std::sync::Arc<tokio::sync::Mutex<CompositorRuntime>>;

#[derive(Debug)]
pub struct CompositorRuntime {
    pub status: CompositorStatus,
    scene: Option<CompositorSceneSnapshot>,
    image_sources: HashMap<String, CompositorImageSource>,
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
    state: String,
    message: Option<String>,
}

pub fn initial_compositor_state() -> CompositorRuntime {
    CompositorRuntime {
        status: stopped_status(Some("Compositor is not running.".to_string())),
        scene: None,
        image_sources: HashMap::new(),
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
    }
    state.emit_event("compositor.status", status.clone());
    status
}

pub async fn compositor_status(state: &AppState) -> CompositorStatus {
    state.compositor.lock().await.status.clone()
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
            match image::image_dimensions(path) {
                Ok((width, height)) => CompositorImageSource {
                    image_path: screen.image_path.clone(),
                    file_revision,
                    width: Some(width),
                    height: Some(height),
                    state: "live".to_string(),
                    message: None,
                },
                Err(error) => CompositorImageSource {
                    image_path: screen.image_path.clone(),
                    file_revision,
                    width: None,
                    height: None,
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
}

async fn run_synthetic_compositor_loop(
    state: AppState,
    run_id: String,
    target_fps: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    let source = SyntheticMovingSource;
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut frames_rendered = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut repeated_frames = 0_u64;
    let mut dropped_frames = 0_u64;
    let mut window_started_at = Instant::now();
    let mut previous_tick_at: Option<Instant> = None;
    let mut frame_times_ms = Vec::with_capacity(128);

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
                let (width, height) = compositor_dimensions(&state).await;
                let frame = source.render(frames_rendered, width, height);
                let sources = compositor_source_statuses(&state).await;
                let frame_age_ms = compositor_frame_age_ms(
                    &sources,
                    frame.captured_at.elapsed().as_millis() as u64,
                );
                frame_times_ms.push(render_started_at.elapsed().as_secs_f64() * 1000.0);

                let surface_status = update_preview_surface_frames(&state, frames_rendered).await;

                if window_started_at.elapsed() >= Duration::from_millis(500) {
                    let elapsed = window_started_at.elapsed().as_secs_f64().max(0.001);
                    let measured_fps = frames_in_window as f64 / elapsed;
                    let (p50, p95, p99) = frame_time_percentiles(&frame_times_ms);
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
                    let diagnostic_stats = {
                        let mut diagnostics = state.diagnostics.lock().await;
                        let next = apply_compositor_stats(
                            diagnostics.clone(),
                            target_fps,
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
                    repeated_frames = 0;
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
                        Some(snapshot.layout.camera_shape.clone())
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
    use crate::protocol::StreamScreenStatus;
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

        tokio::time::sleep(Duration::from_millis(650)).await;
        let status = compositor_status(&state).await;
        stop_compositor(&state).await;

        assert_eq!(status.state, CompositorState::Live);
        assert!(status.frames_rendered >= 30);
        assert!(status.render_fps.unwrap_or_default() >= 30.0);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
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
