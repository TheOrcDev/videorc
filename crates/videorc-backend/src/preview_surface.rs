use chrono::Utc;
use uuid::Uuid;

use crate::compositor::{
    CompositorStartParams, start_synthetic_compositor, stop_compositor,
    update_compositor_surface_size,
};
use crate::diagnostics::{apply_preview_surface_resize, apply_runtime_diagnostics_snapshot};
use crate::native_preview_host::{
    NativePreviewHostActivation, NativePreviewHostCommand, NativePreviewHostLifecycle,
    NativePreviewHostLifecycleUpdate,
};
use crate::protocol::{
    PreviewSurfaceBacking, PreviewSurfaceBoundsParams, PreviewSurfaceCreateParams,
    PreviewSurfacePresentParams, PreviewSurfaceSource, PreviewSurfaceState, PreviewSurfaceStatus,
    PreviewTransport,
};
use crate::state::AppState;

pub type PreviewSurfaceSlot = std::sync::Arc<tokio::sync::Mutex<PreviewSurfaceRuntime>>;

#[derive(Debug)]
pub struct PreviewSurfaceRuntime {
    pub status: PreviewSurfaceStatus,
    run_id: Option<String>,
    native_host: NativePreviewHostLifecycle,
    pending_native_host_commands: Vec<NativePreviewHostCommand>,
}

pub fn initial_preview_surface_state() -> PreviewSurfaceRuntime {
    PreviewSurfaceRuntime {
        status: unavailable_status(Some("Native preview surface is not running.".to_string())),
        run_id: None,
        native_host: NativePreviewHostLifecycle::default(),
        pending_native_host_commands: Vec::new(),
    }
}

pub async fn create_preview_surface(
    state: AppState,
    params: PreviewSurfaceCreateParams,
) -> PreviewSurfaceStatus {
    stop_current_surface(&state).await;

    let run_id = Uuid::new_v4().to_string();
    let bounds = params.bounds;
    let source = params.source;
    let target_fps = params.target_fps.clamp(30, 120);
    let now = Utc::now().to_rfc3339();
    let message = match &source {
        PreviewSurfaceSource::Camera => "Electron proof camera preview surface running.",
        PreviewSurfaceSource::Screen => "Electron proof screen preview surface running.",
        PreviewSurfaceSource::Window => "Electron proof window preview surface running.",
        PreviewSurfaceSource::Synthetic => "Synthetic Electron proof preview surface running.",
    };
    let mut status = PreviewSurfaceStatus {
        state: PreviewSurfaceState::Live,
        source,
        transport: PreviewTransport::ElectronProofSurface,
        backing: PreviewSurfaceBacking::ElectronBrowserWindow,
        target_fps,
        width: surface_dimension(bounds.width),
        height: surface_dimension(bounds.height),
        frames_rendered: 0,
        presented_frame_id: None,
        compositor_frame_lag: None,
        dropped_frames: 0,
        input_to_present_latency_ms: None,
        input_to_present_latency_p50_ms: None,
        input_to_present_latency_p95_ms: None,
        input_to_present_latency_p99_ms: None,
        present_fps: None,
        interval_p95_ms: None,
        interval_p99_ms: None,
        bounds: Some(bounds.clone()),
        started_at: Some(now.clone()),
        updated_at: now,
        message: Some(message.to_string()),
    };
    {
        let mut slot = state.preview_surface.lock().await;
        let host_update = slot.native_host.create(&bounds);
        apply_native_host_update(
            &mut status,
            &mut slot.pending_native_host_commands,
            host_update,
        );
        slot.status = status.clone();
        slot.run_id = Some(run_id);
    }

    start_synthetic_compositor(
        state.clone(),
        CompositorStartParams {
            target_fps,
            width: status.width,
            height: status.height,
        },
    )
    .await;
    state.emit_event("preview.surface.status", status.clone());
    status
}

pub async fn update_preview_surface_bounds(
    state: &AppState,
    params: PreviewSurfaceBoundsParams,
) -> PreviewSurfaceStatus {
    let status = {
        let mut slot = state.preview_surface.lock().await;
        let mut next = slot.status.clone();
        next.width = surface_dimension(params.bounds.width);
        next.height = surface_dimension(params.bounds.height);
        next.bounds = Some(params.bounds.clone());
        next.updated_at = Utc::now().to_rfc3339();
        if next.state == PreviewSurfaceState::Unavailable
            || next.state == PreviewSurfaceState::Stopped
        {
            next.message =
                Some("Native preview surface bounds saved; surface is not live.".to_string());
        } else {
            let host_update = slot.native_host.update_bounds(&params.bounds);
            apply_native_host_update(
                &mut next,
                &mut slot.pending_native_host_commands,
                host_update,
            );
        }
        slot.status = next.clone();
        next
    };

    register_preview_surface_resize(state).await;
    update_compositor_surface_size(state, status.width, status.height).await;
    state.emit_event("preview.surface.status", status.clone());
    status
}

pub async fn destroy_preview_surface(state: &AppState) -> PreviewSurfaceStatus {
    stop_current_surface(state).await;
    let status = {
        let mut slot = state.preview_surface.lock().await;
        let mut next = slot.status.clone();
        next.state = PreviewSurfaceState::Stopped;
        next.transport = PreviewTransport::Unavailable;
        next.backing = PreviewSurfaceBacking::None;
        next.frames_rendered = 0;
        next.presented_frame_id = None;
        next.compositor_frame_lag = None;
        next.dropped_frames = 0;
        next.input_to_present_latency_ms = None;
        next.input_to_present_latency_p50_ms = None;
        next.input_to_present_latency_p95_ms = None;
        next.input_to_present_latency_p99_ms = None;
        next.present_fps = None;
        next.interval_p95_ms = None;
        next.interval_p99_ms = None;
        next.started_at = None;
        next.updated_at = Utc::now().to_rfc3339();
        next.message = Some("Native preview surface stopped.".to_string());
        slot.status = next.clone();
        next
    };
    state.emit_event("preview.surface.status", status.clone());
    status
}

pub async fn preview_surface_status(state: &AppState) -> PreviewSurfaceStatus {
    state.preview_surface.lock().await.status.clone()
}

pub async fn take_native_preview_host_commands(state: &AppState) -> Vec<NativePreviewHostCommand> {
    std::mem::take(
        &mut state
            .preview_surface
            .lock()
            .await
            .pending_native_host_commands,
    )
}

pub async fn update_preview_surface_present(
    state: &AppState,
    params: PreviewSurfacePresentParams,
) -> PreviewSurfaceStatus {
    let status = {
        let mut slot = state.preview_surface.lock().await;
        let mut next = slot.status.clone();
        if let Some(transport) = params.transport {
            next.transport = transport;
        }
        if let Some(backing) = params.backing {
            next.backing = backing;
        }
        if let Some(frame_id) = params.presented_frame_id {
            next.presented_frame_id = Some(frame_id);
            next.frames_rendered = next.frames_rendered.max(frame_id);
        }
        next.compositor_frame_lag = params.compositor_frame_lag;
        next.dropped_frames = params.dropped_frames;
        next.input_to_present_latency_ms = params.input_to_present_latency_ms;
        next.input_to_present_latency_p50_ms = params.input_to_present_latency_p50_ms;
        next.input_to_present_latency_p95_ms = params.input_to_present_latency_p95_ms;
        next.input_to_present_latency_p99_ms = params.input_to_present_latency_p99_ms;
        next.present_fps = params.present_fps;
        next.interval_p95_ms = params.interval_p95_ms;
        next.interval_p99_ms = params.interval_p99_ms;
        next.updated_at = Utc::now().to_rfc3339();
        slot.status = next.clone();
        next
    };

    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let mut next = diagnostics.clone();
        next.preview_present_fps = status.present_fps;
        next.preview_input_to_present_latency_ms = status.input_to_present_latency_ms;
        next.preview_input_to_present_latency_p50_ms = status.input_to_present_latency_p50_ms;
        next.preview_input_to_present_latency_p95_ms = status.input_to_present_latency_p95_ms;
        next.preview_input_to_present_latency_p99_ms = status.input_to_present_latency_p99_ms;
        next.preview_compositor_frame_lag = status.compositor_frame_lag;
        next.preview_dropped_frames = status.dropped_frames;
        next.preview_frame_age_ms = status.input_to_present_latency_ms;
        next.preview_render_frame_time_p95_ms = status.interval_p95_ms;
        next.preview_render_frame_time_p99_ms = status.interval_p99_ms;
        next.preview_surface_backing = status.backing;
        next.updated_at = Utc::now().to_rfc3339();
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
    state.emit_event("preview.surface.status", status.clone());
    status
}

pub async fn register_preview_surface_resize(state: &AppState) {
    let resize_count = {
        let mut metrics = state.preview_metrics.lock().await;
        metrics.surface_resize_count = metrics.surface_resize_count.saturating_add(1);
        metrics.surface_resize_count
    };
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let next = apply_preview_surface_resize(diagnostics.clone(), resize_count);
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

async fn stop_current_surface(state: &AppState) {
    stop_compositor(state).await;
    {
        let mut slot = state.preview_surface.lock().await;
        let had_surface = slot.run_id.is_some() || slot.status.state == PreviewSurfaceState::Live;
        let host_update = slot.native_host.destroy();
        if had_surface && let Some(command) = host_update.command {
            slot.pending_native_host_commands.push(command);
        }
        slot.run_id = None;
    }
}

fn apply_native_host_update(
    status: &mut PreviewSurfaceStatus,
    pending_commands: &mut Vec<NativePreviewHostCommand>,
    update: NativePreviewHostLifecycleUpdate,
) {
    if let Some(command) = update.command {
        pending_commands.push(command);
    }

    let Some(NativePreviewHostActivation {
        transport,
        backing,
        message,
    }) = update.activation
    else {
        return;
    };

    status.transport = transport;
    status.backing = backing;
    if let Some(message) = message {
        status.message = Some(message);
    }
}

fn surface_dimension(value: f64) -> u32 {
    value.round().clamp(1.0, f64::from(u32::MAX)) as u32
}

fn unavailable_status(message: Option<String>) -> PreviewSurfaceStatus {
    PreviewSurfaceStatus {
        state: PreviewSurfaceState::Unavailable,
        source: PreviewSurfaceSource::Synthetic,
        transport: PreviewTransport::Unavailable,
        backing: PreviewSurfaceBacking::None,
        target_fps: 60,
        width: 0,
        height: 0,
        frames_rendered: 0,
        presented_frame_id: None,
        compositor_frame_lag: None,
        dropped_frames: 0,
        input_to_present_latency_ms: None,
        input_to_present_latency_p50_ms: None,
        input_to_present_latency_p95_ms: None,
        input_to_present_latency_p99_ms: None,
        present_fps: None,
        interval_p95_ms: None,
        interval_p99_ms: None,
        bounds: None,
        started_at: None,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_preview_host::NativePreviewHostCommandKind;
    use crate::protocol::PreviewSurfaceBounds;
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

    fn bounds(width: f64, height: f64) -> PreviewSurfaceBounds {
        PreviewSurfaceBounds {
            screen_x: 100.0,
            screen_y: 120.0,
            width,
            height,
            scale_factor: 2.0,
            screen_height: Some(1080.0),
        }
    }

    #[tokio::test]
    async fn create_surface_starts_synthetic_native_status() {
        let state = test_state();
        let status = create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.transport, PreviewTransport::ElectronProofSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::ElectronBrowserWindow);
        assert_eq!(status.target_fps, 60);
        assert_eq!(status.width, 800);
        assert_eq!(status.height, 450);
        let surface = state.preview_surface.lock().await;
        assert_eq!(
            surface.native_host.last_command_kind(),
            Some(NativePreviewHostCommandKind::Create)
        );
        assert_eq!(
            surface
                .native_host
                .bounds()
                .map(|bounds| bounds.drawable_size()),
            Some((1600.0, 900.0))
        );
    }

    #[tokio::test]
    async fn update_bounds_preserves_running_surface() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        let status = update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(640.0, 360.0),
            },
        )
        .await;

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
        assert_eq!(
            state.diagnostics.lock().await.preview_surface_resize_count,
            1
        );
        let surface = state.preview_surface.lock().await;
        assert_eq!(
            surface.native_host.last_command_kind(),
            Some(NativePreviewHostCommandKind::UpdateBounds)
        );
        assert_eq!(
            surface
                .native_host
                .bounds()
                .map(|bounds| bounds.drawable_size()),
            Some((1280.0, 720.0))
        );
    }

    #[tokio::test]
    async fn native_host_commands_drain_in_lifecycle_order() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;
        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(640.0, 360.0),
            },
        )
        .await;
        destroy_preview_surface(&state).await;

        let commands = take_native_preview_host_commands(&state).await;

        let kinds = commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                NativePreviewHostCommandKind::Create,
                NativePreviewHostCommandKind::UpdateBounds,
                NativePreviewHostCommandKind::Destroy,
            ]
        );
        assert!(commands[0].bounds.is_some());
        assert!(commands[1].bounds.is_some());
        assert_eq!(commands[2].bounds, None);
        assert!(take_native_preview_host_commands(&state).await.is_empty());
    }

    #[tokio::test]
    async fn present_metrics_update_surface_status_and_diagnostics() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        let status = update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::NativeSurface),
                backing: Some(PreviewSurfaceBacking::CaMetalLayer),
                presented_frame_id: Some(42),
                compositor_frame_lag: Some(1),
                dropped_frames: 3,
                input_to_present_latency_ms: Some(37),
                input_to_present_latency_p50_ms: Some(31),
                input_to_present_latency_p95_ms: Some(48),
                input_to_present_latency_p99_ms: Some(73),
                present_fps: Some(58.5),
                interval_p95_ms: Some(19.0),
                interval_p99_ms: Some(24.0),
            },
        )
        .await;

        assert_eq!(status.transport, PreviewTransport::NativeSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(status.presented_frame_id, Some(42));
        assert_eq!(status.compositor_frame_lag, Some(1));
        assert_eq!(status.dropped_frames, 3);
        assert_eq!(status.input_to_present_latency_ms, Some(37));
        assert_eq!(status.input_to_present_latency_p50_ms, Some(31));
        assert_eq!(status.input_to_present_latency_p95_ms, Some(48));
        assert_eq!(status.input_to_present_latency_p99_ms, Some(73));
        assert_eq!(status.present_fps, Some(58.5));

        let diagnostics = state.diagnostics.lock().await;
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::CaMetalLayer
        );
        assert_eq!(diagnostics.preview_present_fps, Some(58.5));
        assert_eq!(diagnostics.preview_input_to_present_latency_ms, Some(37));
        assert_eq!(
            diagnostics.preview_input_to_present_latency_p50_ms,
            Some(31)
        );
        assert_eq!(
            diagnostics.preview_input_to_present_latency_p95_ms,
            Some(48)
        );
        assert_eq!(
            diagnostics.preview_input_to_present_latency_p99_ms,
            Some(73)
        );
        assert_eq!(diagnostics.preview_compositor_frame_lag, Some(1));
        assert_eq!(diagnostics.preview_dropped_frames, 3);
        assert_eq!(diagnostics.preview_render_frame_time_p95_ms, Some(19.0));
        assert_eq!(diagnostics.preview_render_frame_time_p99_ms, Some(24.0));
    }

    #[tokio::test]
    async fn destroy_surface_stops_native_transport() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        let status = destroy_preview_surface(&state).await;

        assert_eq!(status.state, PreviewSurfaceState::Stopped);
        assert_eq!(status.transport, PreviewTransport::Unavailable);
        assert_eq!(status.backing, PreviewSurfaceBacking::None);
        assert_eq!(status.started_at, None);
        let surface = state.preview_surface.lock().await;
        assert_eq!(
            surface.native_host.last_command_kind(),
            Some(NativePreviewHostCommandKind::Destroy)
        );
        assert_eq!(surface.native_host.bounds(), None);
    }
}
