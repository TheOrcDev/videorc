use chrono::Utc;
use uuid::Uuid;

use crate::compositor::{
    CompositorStartParams, start_synthetic_compositor, stop_compositor,
    update_compositor_surface_size,
};
use crate::diagnostics::{apply_preview_surface_resize, apply_runtime_diagnostics_snapshot};
use crate::protocol::{
    PreviewSurfaceBoundsParams, PreviewSurfaceCreateParams, PreviewSurfaceSource,
    PreviewSurfaceState, PreviewSurfaceStatus, PreviewTransport,
};
use crate::state::AppState;

pub type PreviewSurfaceSlot = std::sync::Arc<tokio::sync::Mutex<PreviewSurfaceRuntime>>;

#[derive(Debug)]
pub struct PreviewSurfaceRuntime {
    pub status: PreviewSurfaceStatus,
    run_id: Option<String>,
}

pub fn initial_preview_surface_state() -> PreviewSurfaceRuntime {
    PreviewSurfaceRuntime {
        status: unavailable_status(Some("Native preview surface is not running.".to_string())),
        run_id: None,
    }
}

pub async fn create_preview_surface(
    state: AppState,
    params: PreviewSurfaceCreateParams,
) -> PreviewSurfaceStatus {
    stop_current_surface(&state).await;

    let run_id = Uuid::new_v4().to_string();
    let target_fps = params.target_fps.clamp(30, 120);
    let now = Utc::now().to_rfc3339();
    let message = match params.source {
        PreviewSurfaceSource::Camera => "Native camera preview surface running.",
        PreviewSurfaceSource::Screen => "Native screen preview surface running.",
        PreviewSurfaceSource::Window => "Native window preview surface running.",
        PreviewSurfaceSource::Synthetic => "Synthetic native preview surface running.",
    };
    let status = PreviewSurfaceStatus {
        state: PreviewSurfaceState::Live,
        source: params.source,
        transport: PreviewTransport::NativeSurface,
        target_fps,
        width: surface_dimension(params.bounds.width),
        height: surface_dimension(params.bounds.height),
        frames_rendered: 0,
        bounds: Some(params.bounds),
        started_at: Some(now.clone()),
        updated_at: now,
        message: Some(message.to_string()),
    };
    {
        let mut slot = state.preview_surface.lock().await;
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
        next.bounds = Some(params.bounds);
        next.updated_at = Utc::now().to_rfc3339();
        if next.state == PreviewSurfaceState::Unavailable
            || next.state == PreviewSurfaceState::Stopped
        {
            next.message =
                Some("Native preview surface bounds saved; surface is not live.".to_string());
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
        next.frames_rendered = 0;
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
        slot.run_id = None;
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
        target_fps: 60,
        width: 0,
        height: 0,
        frames_rendered: 0,
        bounds: None,
        started_at: None,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        }
    }

    #[tokio::test]
    async fn create_surface_starts_synthetic_native_status() {
        let state = test_state();
        let status = create_preview_surface(
            state,
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.transport, PreviewTransport::NativeSurface);
        assert_eq!(status.target_fps, 60);
        assert_eq!(status.width, 800);
        assert_eq!(status.height, 450);
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
        assert_eq!(status.started_at, None);
    }
}
