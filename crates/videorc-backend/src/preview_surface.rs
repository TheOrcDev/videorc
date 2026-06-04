use std::time::Instant;

use chrono::Utc;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::diagnostics::{apply_native_preview_surface_stats, apply_preview_surface_resize};
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
    stop_tx: Option<watch::Sender<bool>>,
    render_task: Option<JoinHandle<()>>,
}

pub fn initial_preview_surface_state() -> PreviewSurfaceRuntime {
    PreviewSurfaceRuntime {
        status: unavailable_status(Some("Native preview surface is not running.".to_string())),
        run_id: None,
        stop_tx: None,
        render_task: None,
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
    let (stop_tx, stop_rx) = watch::channel(false);
    let render_task = tokio::spawn(run_synthetic_surface_loop(
        state.clone(),
        run_id.clone(),
        target_fps,
        stop_rx,
    ));

    {
        let mut slot = state.preview_surface.lock().await;
        slot.status = status.clone();
        slot.run_id = Some(run_id);
        slot.stop_tx = Some(stop_tx);
        slot.render_task = Some(render_task);
    }

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
    state.emit_event("diagnostics.stats", diagnostic_stats);
}

async fn stop_current_surface(state: &AppState) {
    let previous_task = {
        let mut slot = state.preview_surface.lock().await;
        if let Some(stop_tx) = slot.stop_tx.take() {
            let _ = stop_tx.send(true);
        }
        slot.run_id = None;
        slot.render_task.take()
    };

    if let Some(task) = previous_task {
        task.abort();
    }
}

async fn run_synthetic_surface_loop(
    state: AppState,
    run_id: String,
    target_fps: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(target_fps.max(1)));
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut frames_rendered = 0_u64;
    let mut frames_in_window = 0_u64;
    let mut window_started_at = Instant::now();
    let mut frame_times_ms = Vec::with_capacity(128);

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                let render_started_at = Instant::now();
                frames_rendered = frames_rendered.saturating_add(1);
                frames_in_window = frames_in_window.saturating_add(1);
                frame_times_ms.push(render_started_at.elapsed().as_secs_f64() * 1000.0);

                let status = {
                    let mut slot = state.preview_surface.lock().await;
                    if slot.run_id.as_deref() != Some(run_id.as_str()) {
                        break;
                    }
                    slot.status.frames_rendered = frames_rendered;
                    slot.status.updated_at = Utc::now().to_rfc3339();
                    slot.status.clone()
                };

                if window_started_at.elapsed() >= Duration::from_millis(500) {
                    let elapsed = window_started_at.elapsed().as_secs_f64().max(0.001);
                    let measured_fps = frames_in_window as f64 / elapsed;
                    let (p50, p95, p99) = preview_frame_time_percentiles(&frame_times_ms);
                    let diagnostic_stats = {
                        let mut diagnostics = state.diagnostics.lock().await;
                        let next = apply_native_preview_surface_stats(
                            diagnostics.clone(),
                            target_fps,
                            measured_fps,
                            measured_fps,
                            p50,
                            p95,
                            p99,
                        );
                        *diagnostics = next.clone();
                        next
                    };
                    state.emit_event("preview.surface.status", status);
                    state.emit_event("diagnostics.stats", diagnostic_stats);
                    window_started_at = Instant::now();
                    frames_in_window = 0;
                    frame_times_ms.clear();
                }
            }
        }
    }
}

fn preview_frame_time_percentiles(values: &[f64]) -> (f64, f64, f64) {
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
