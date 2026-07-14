use crate::compositor::{
    CompositorFrameConsumer, CompositorStartParams, resize_preview_compositor_if_run_id,
    start_synthetic_compositor, stop_compositor_if_run_id,
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
use chrono::Utc;

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
    let _lifecycle = state.preview_surface_lifecycle.lock().await;
    let target_fps = params.target_fps.clamp(30, 120);
    let capture_active = capture_owns_compositor(&state);
    if let Some(status) = try_reuse_live_surface(&state, &params, target_fps, capture_active).await
    {
        return status;
    }

    stop_current_surface(&state).await;

    let capture_active = capture_owns_compositor(&state);
    let bounds = params.bounds;
    let source = params.source;
    let now = Utc::now().to_rfc3339();
    let message = if capture_active {
        "Native preview surface attached while recording; compositor ownership stays with the recording."
    } else {
        match &source {
            PreviewSurfaceSource::Camera => "Electron proof camera preview surface running.",
            PreviewSurfaceSource::Screen => "Electron proof screen preview surface running.",
            PreviewSurfaceSource::Window => "Electron proof window preview surface running.",
            PreviewSurfaceSource::Synthetic => "Synthetic Electron proof preview surface running.",
        }
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
        native_preview_main_scene_mismatch_count: None,
        native_preview_main_scene_mismatch_age_ms: None,
        native_preview_main_last_skipped_scene_revision: None,
        native_preview_main_last_skipped_frame_scene_revision: None,
        frame_polling_suppressed: false,
        source_pixels_present: false,
        pending_host_command_count: 0,
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
        status.pending_host_command_count = pending_host_command_count(&slot);
        slot.status = status.clone();
    }

    if !capture_active {
        let compositor_status = start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps,
                width: status.width,
                height: status.height,
                frame_consumer: CompositorFrameConsumer::NativePreview,
                stream_output: None,
                caption_overlay_on_primary: false,
                caption_overlay_on_aux: false,
                highlight_overlay_on_primary: false,
                highlight_overlay_on_aux: false,
            },
        )
        .await;
        state.preview_surface.lock().await.run_id = compositor_status.run_id;
    }
    state.emit_event("preview.surface.status", status.clone());
    status
}

/// Treat a repeated create request as an update while its existing preview
/// compositor is still live. Renderer lifecycle recovery can legitimately lose
/// its local "created" bit (for example after a websocket reconnect) while the
/// backend surface remains healthy. Restarting the compositor in that case
/// invalidates the IOSurfaces still in flight to the native host and produces a
/// visible preview cutout during window movement.
///
/// A target-FPS change still takes the full restart path because the render
/// loop cadence cannot be changed in place. While recording owns the
/// compositor, the preview surface has no independent render loop to restart,
/// so updating its requested FPS is safe.
async fn try_reuse_live_surface(
    state: &AppState,
    params: &PreviewSurfaceCreateParams,
    target_fps: u32,
    capture_active: bool,
) -> Option<PreviewSurfaceStatus> {
    let current = state.preview_surface.lock().await.status.clone();
    if current.state != PreviewSurfaceState::Live {
        return None;
    }
    if !capture_active
        && (current.target_fps != target_fps
            || !preview_surface_owns_current_compositor(state).await)
    {
        return None;
    }

    let (status, preview_run_id) = {
        let mut slot = state.preview_surface.lock().await;
        if slot.status.state != PreviewSurfaceState::Live {
            return None;
        }

        let mut next = slot.status.clone();
        next.source = params.source.clone();
        next.target_fps = target_fps;
        next.width = surface_dimension(params.bounds.width);
        next.height = surface_dimension(params.bounds.height);
        next.bounds = Some(params.bounds.clone());
        next.updated_at = Utc::now().to_rfc3339();
        let host_update = slot.native_host.update_bounds(&params.bounds);
        apply_native_host_update(
            &mut next,
            &mut slot.pending_native_host_commands,
            host_update,
        );
        next.pending_host_command_count = pending_host_command_count(&slot);
        if capture_active {
            // Any stored preview run belongs to the compositor that recording
            // replaced. Clearing it prevents later teardown from treating that
            // stale run as preview-owned.
            slot.run_id = None;
        }
        slot.status = next.clone();
        (next, slot.run_id.clone())
    };

    register_preview_surface_resize(state).await;
    if let Some(run_id) = preview_run_id {
        let _ =
            resize_preview_compositor_if_run_id(state, &run_id, status.width, status.height).await;
    }
    state.emit_event("preview.surface.status", status.clone());
    Some(status)
}

pub async fn update_preview_surface_bounds(
    state: &AppState,
    params: PreviewSurfaceBoundsParams,
) -> PreviewSurfaceStatus {
    let _lifecycle = state.preview_surface_lifecycle.lock().await;
    let (status, preview_run_id) = {
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
        next.pending_host_command_count = pending_host_command_count(&slot);
        slot.status = next.clone();
        (next, slot.run_id.clone())
    };

    register_preview_surface_resize(state).await;
    if let Some(run_id) = preview_run_id {
        let _ =
            resize_preview_compositor_if_run_id(state, &run_id, status.width, status.height).await;
    }
    state.emit_event("preview.surface.status", status.clone());
    status
}

pub async fn destroy_preview_surface(state: &AppState) -> PreviewSurfaceStatus {
    let _lifecycle = state.preview_surface_lifecycle.lock().await;
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
        next.frame_polling_suppressed = false;
        next.source_pixels_present = false;
        next.pending_host_command_count = pending_host_command_count(&slot);
        next.started_at = None;
        next.updated_at = Utc::now().to_rfc3339();
        next.message = Some("Native preview surface stopped.".to_string());
        slot.status = next.clone();
        next
    };
    let diagnostic_stats = {
        let mut diagnostics = state.diagnostics.lock().await;
        let mut next = diagnostics.clone();
        next.preview_transport = PreviewTransport::Unavailable;
        next.preview_target_fps = None;
        next.preview_frame_age_ms = None;
        next.preview_surface_backing = PreviewSurfaceBacking::None;
        next.preview_frame_polling_suppressed = false;
        next.preview_source_pixels_present = false;
        next.preview_present_fps = None;
        next.preview_input_to_present_latency_ms = None;
        next.preview_input_to_present_latency_p50_ms = None;
        next.preview_input_to_present_latency_p95_ms = None;
        next.preview_input_to_present_latency_p99_ms = None;
        next.preview_compositor_frame_lag = None;
        next.preview_render_frame_time_p50_ms = None;
        next.preview_render_frame_time_p95_ms = None;
        next.preview_render_frame_time_p99_ms = None;
        next.preview_repeated_frames = 0;
        next.preview_latency_ms = None;
        next.preview_dropped_frames = 0;
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

pub async fn preview_surface_status(state: &AppState) -> PreviewSurfaceStatus {
    state.preview_surface.lock().await.status.clone()
}

pub async fn take_native_preview_host_commands(state: &AppState) -> Vec<NativePreviewHostCommand> {
    let mut slot = state.preview_surface.lock().await;
    let commands = std::mem::take(&mut slot.pending_native_host_commands);
    slot.status.pending_host_command_count = pending_host_command_count(&slot);
    commands
}

pub async fn update_preview_surface_present(
    state: &AppState,
    params: PreviewSurfacePresentParams,
) -> PreviewSurfaceStatus {
    let status = {
        let mut slot = state.preview_surface.lock().await;
        if is_stale_present_update(&slot.status, &params) {
            return slot.status.clone();
        }
        let mut next = slot.status.clone();
        let native_claim_allowed = native_present_claim_allowed(&slot.status, &params);
        let blocked_native_claim = present_update_claims_native(&params) && !native_claim_allowed;
        if let Some(transport) = params.transport
            && (transport != PreviewTransport::NativeSurface || native_claim_allowed)
        {
            next.transport = transport;
        }
        if let Some(backing) = params.backing
            && (backing != PreviewSurfaceBacking::CaMetalLayer || native_claim_allowed)
        {
            next.backing = backing;
        }
        if let Some(frame_id) = params.presented_frame_id {
            next.presented_frame_id = Some(frame_id);
            next.frames_rendered = next.frames_rendered.max(frame_id);
        }
        if blocked_native_claim {
            next.message = Some(
                "Native preview surface is waiting for its first presented compositor frame."
                    .to_string(),
            );
        }
        next.compositor_frame_lag = params.compositor_frame_lag;
        next.dropped_frames = next.dropped_frames.max(params.dropped_frames);
        next.input_to_present_latency_ms = params.input_to_present_latency_ms;
        next.input_to_present_latency_p50_ms = params.input_to_present_latency_p50_ms;
        next.input_to_present_latency_p95_ms = params.input_to_present_latency_p95_ms;
        next.input_to_present_latency_p99_ms = params.input_to_present_latency_p99_ms;
        next.present_fps = params.present_fps;
        next.interval_p95_ms = params.interval_p95_ms;
        next.interval_p99_ms = params.interval_p99_ms;
        next.native_preview_main_scene_mismatch_count =
            params.native_preview_main_scene_mismatch_count;
        next.native_preview_main_scene_mismatch_age_ms =
            params.native_preview_main_scene_mismatch_age_ms;
        next.native_preview_main_last_skipped_scene_revision =
            params.native_preview_main_last_skipped_scene_revision;
        next.native_preview_main_last_skipped_frame_scene_revision =
            params.native_preview_main_last_skipped_frame_scene_revision;
        if params.message.is_some() {
            next.message = params.message;
        }
        next.frame_polling_suppressed = params.frame_polling_suppressed;
        next.source_pixels_present = params.source_pixels_present;
        next.updated_at = Utc::now().to_rfc3339();
        slot.status = next.clone();
        next
    };

    emit_preview_surface_present_diagnostics(state, &status).await;
    state.emit_event("preview.surface.status", status.clone());
    status
}

#[allow(dead_code)]
pub async fn activate_native_preview_host(
    state: &AppState,
    activation: NativePreviewHostActivation,
) -> PreviewSurfaceStatus {
    let status = {
        let mut slot = state.preview_surface.lock().await;
        let mut next = slot.status.clone();
        if next.state != PreviewSurfaceState::Live {
            return next;
        }
        apply_native_host_activation(&mut next, activation);
        next.updated_at = Utc::now().to_rfc3339();
        slot.status = next.clone();
        next
    };

    emit_preview_surface_present_diagnostics(state, &status).await;
    state.emit_event("preview.surface.status", status.clone());
    status
}

fn is_stale_present_update(
    current: &PreviewSurfaceStatus,
    params: &PreviewSurfacePresentParams,
) -> bool {
    matches!(
        (current.presented_frame_id, params.presented_frame_id),
        (Some(current_frame), Some(next_frame)) if next_frame < current_frame
    )
}

fn present_update_claims_native(params: &PreviewSurfacePresentParams) -> bool {
    matches!(params.transport, Some(PreviewTransport::NativeSurface))
        || matches!(params.backing, Some(PreviewSurfaceBacking::CaMetalLayer))
}

fn native_present_claim_allowed(
    current: &PreviewSurfaceStatus,
    params: &PreviewSurfacePresentParams,
) -> bool {
    params.presented_frame_id.is_some()
        || (current.transport == PreviewTransport::NativeSurface
            && current.backing == PreviewSurfaceBacking::CaMetalLayer
            && current.presented_frame_id.is_some())
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
    let owned_compositor_run_id = {
        let mut slot = state.preview_surface.lock().await;
        let had_surface = slot.run_id.is_some() || slot.status.state == PreviewSurfaceState::Live;
        let host_update = slot.native_host.destroy();
        if had_surface && let Some(command) = host_update.command {
            slot.pending_native_host_commands.push(command);
        }
        slot.run_id.take()
    };
    if let Some(run_id) = owned_compositor_run_id {
        stop_compositor_if_run_id(state, &run_id).await;
    }
}

fn capture_owns_compositor(state: &AppState) -> bool {
    let snapshot = state.ffmpeg_work.snapshot();
    snapshot.capture_active || snapshot.capture_waiting > 0
}

async fn preview_surface_owns_current_compositor(state: &AppState) -> bool {
    let surface_run_id = state.preview_surface.lock().await.run_id.clone();
    let Some(surface_run_id) = surface_run_id else {
        return false;
    };
    let compositor_run_id = crate::compositor::compositor_status(state).await.run_id;
    compositor_run_id.as_deref() == Some(surface_run_id.as_str())
}

fn apply_native_host_update(
    status: &mut PreviewSurfaceStatus,
    pending_commands: &mut Vec<NativePreviewHostCommand>,
    update: NativePreviewHostLifecycleUpdate,
) {
    if let Some(command) = update.command {
        pending_commands.push(command);
    }

    if let Some(activation) = update.activation {
        apply_native_host_activation(status, activation);
    }
}

fn apply_native_host_activation(
    status: &mut PreviewSurfaceStatus,
    NativePreviewHostActivation {
        transport,
        backing,
        presented_frame_id,
        frame_polling_suppressed,
        source_pixels_present,
        message,
    }: NativePreviewHostActivation,
) {
    let presented_frame_id = status
        .presented_frame_id
        .map(|current_frame_id| current_frame_id.max(presented_frame_id))
        .unwrap_or(presented_frame_id);
    status.transport = transport;
    status.backing = backing;
    status.presented_frame_id = Some(presented_frame_id);
    status.frames_rendered = status.frames_rendered.max(presented_frame_id);
    status.frame_polling_suppressed = frame_polling_suppressed;
    status.source_pixels_present = source_pixels_present;
    if let Some(message) = message {
        status.message = Some(message);
    }
}

async fn emit_preview_surface_present_diagnostics(state: &AppState, status: &PreviewSurfaceStatus) {
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
        next.preview_transport = status.transport;
        next.preview_surface_backing = status.backing;
        next.preview_frame_polling_suppressed = status.frame_polling_suppressed;
        next.preview_source_pixels_present = status.source_pixels_present;
        next.updated_at = Utc::now().to_rfc3339();
        *diagnostics = next.clone();
        next
    };
    state.emit_event(
        "diagnostics.stats",
        apply_runtime_diagnostics_snapshot(diagnostic_stats, state.ffmpeg_work.snapshot()),
    );
}

fn pending_host_command_count(slot: &PreviewSurfaceRuntime) -> u64 {
    slot.pending_native_host_commands.len() as u64
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
        native_preview_main_scene_mismatch_count: None,
        native_preview_main_scene_mismatch_age_ms: None,
        native_preview_main_last_skipped_scene_revision: None,
        native_preview_main_last_skipped_frame_scene_revision: None,
        frame_polling_suppressed: false,
        source_pixels_present: false,
        pending_host_command_count: 0,
        bounds: None,
        started_at: None,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compositor::{
        CompositorFrameEvidence, compositor_latest_frame_evidence, compositor_status,
        stop_compositor,
    };
    use crate::native_preview_host::{NativePreviewHostActivation, NativePreviewHostCommandKind};
    use crate::protocol::{CompositorState, PreviewSurfaceBounds};
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
            ..Default::default()
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

        let surface = state.preview_surface.lock().await;
        let last_command_kind = surface.native_host.last_command_kind();
        let drawable_size = surface
            .native_host
            .bounds()
            .map(|bounds| bounds.drawable_size());
        drop(surface);
        let compositor = compositor_status(&state).await;
        destroy_preview_surface(&state).await;

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.transport, PreviewTransport::ElectronProofSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::ElectronBrowserWindow);
        assert_eq!(status.target_fps, 60);
        assert_eq!(status.width, 800);
        assert_eq!(status.height, 450);
        assert_eq!(status.pending_host_command_count, 1);
        assert_eq!(
            compositor.frame_pipeline.consumer.as_deref(),
            Some("native-preview")
        );
        assert_eq!(compositor.frame_pipeline.gpu_readbacks, 0);
        assert_eq!(compositor.frame_pipeline.yuv_frames_converted, 0);
        assert_eq!(
            last_command_kind,
            Some(NativePreviewHostCommandKind::Create)
        );
        assert_eq!(drawable_size, Some((1600.0, 900.0)));
    }

    #[tokio::test]
    async fn duplicate_create_preserves_live_compositor_and_native_present_state() {
        let state = test_state();
        let first = create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;
        take_native_preview_host_commands(&state).await;
        let first_compositor = compositor_status(&state).await;
        update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::NativeSurface),
                backing: Some(PreviewSurfaceBacking::CaMetalLayer),
                presented_frame_id: Some(42),
                compositor_frame_lag: Some(0),
                dropped_frames: 0,
                input_to_present_latency_ms: Some(18),
                input_to_present_latency_p50_ms: Some(17),
                input_to_present_latency_p95_ms: Some(20),
                input_to_present_latency_p99_ms: Some(23),
                present_fps: Some(60.0),
                interval_p95_ms: Some(17.0),
                interval_p99_ms: Some(18.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: Some("Native preview is healthy.".to_string()),
                frame_polling_suppressed: true,
                source_pixels_present: true,
            },
        )
        .await;

        let duplicate = create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Screen,
            },
        )
        .await;

        let second_compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        destroy_preview_surface(&state).await;

        assert_eq!(second_compositor.run_id, first_compositor.run_id);
        assert_eq!(second_compositor.width, 640);
        assert_eq!(second_compositor.height, 360);
        assert_eq!(duplicate.started_at, first.started_at);
        assert_eq!(duplicate.source, PreviewSurfaceSource::Screen);
        assert_eq!(duplicate.width, 640);
        assert_eq!(duplicate.height, 360);
        assert_eq!(duplicate.transport, PreviewTransport::NativeSurface);
        assert_eq!(duplicate.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(duplicate.presented_frame_id, Some(42));
        assert_eq!(duplicate.frames_rendered, 42);
        assert_eq!(
            duplicate.message.as_deref(),
            Some("Native preview is healthy.")
        );
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].kind, NativePreviewHostCommandKind::UpdateBounds);
    }

    #[tokio::test]
    async fn duplicate_create_restarts_compositor_when_target_fps_changes() {
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
        take_native_preview_host_commands(&state).await;
        let first_compositor = compositor_status(&state).await;

        let duplicate = create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 30,
                source: PreviewSurfaceSource::Screen,
            },
        )
        .await;

        let second_compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        destroy_preview_surface(&state).await;

        assert_ne!(second_compositor.run_id, first_compositor.run_id);
        assert_eq!(second_compositor.target_fps, 30);
        assert_eq!(duplicate.target_fps, 30);
        assert_eq!(
            commands
                .iter()
                .map(|command| command.kind)
                .collect::<Vec<_>>(),
            vec![
                NativePreviewHostCommandKind::Destroy,
                NativePreviewHostCommandKind::Create,
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_duplicate_creates_publish_one_host_create() {
        const REQUEST_COUNT: usize = 8;

        let state = test_state();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(REQUEST_COUNT + 1));
        let mut requests = Vec::with_capacity(REQUEST_COUNT);
        for _ in 0..REQUEST_COUNT {
            let state = state.clone();
            let barrier = barrier.clone();
            requests.push(tokio::spawn(async move {
                barrier.wait().await;
                create_preview_surface(
                    state,
                    PreviewSurfaceCreateParams {
                        bounds: bounds(800.0, 450.0),
                        target_fps: 60,
                        source: PreviewSurfaceSource::Synthetic,
                    },
                )
                .await
            }));
        }
        barrier.wait().await;

        for request in requests {
            let status = request.await.expect("concurrent create task should finish");
            assert_eq!(status.state, PreviewSurfaceState::Live);
        }

        let compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        destroy_preview_surface(&state).await;

        assert_eq!(compositor.state, CompositorState::Live);
        assert_eq!(
            commands
                .iter()
                .filter(|command| command.kind == NativePreviewHostCommandKind::Create)
                .count(),
            1
        );
        assert_eq!(
            commands
                .iter()
                .filter(|command| command.kind == NativePreviewHostCommandKind::Destroy)
                .count(),
            0
        );
        assert_eq!(
            commands
                .iter()
                .filter(|command| command.kind == NativePreviewHostCommandKind::UpdateBounds)
                .count(),
            REQUEST_COUNT - 1
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

        let resize_count = state.diagnostics.lock().await.preview_surface_resize_count;
        let surface = state.preview_surface.lock().await;
        let last_command_kind = surface.native_host.last_command_kind();
        let drawable_size = surface
            .native_host
            .bounds()
            .map(|bounds| bounds.drawable_size());
        drop(surface);
        destroy_preview_surface(&state).await;

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
        assert_eq!(resize_count, 1);
        assert_eq!(
            last_command_kind,
            Some(NativePreviewHostCommandKind::UpdateBounds)
        );
        assert_eq!(drawable_size, Some((1280.0, 720.0)));
    }

    #[tokio::test]
    async fn destroy_surface_does_not_stop_newer_recording_compositor() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(960.0, 540.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;

        let recording_status = start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps: 30,
                width: 640,
                height: 360,
                frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                stream_output: None,
                caption_overlay_on_primary: false,
                caption_overlay_on_aux: false,
                highlight_overlay_on_primary: false,
                highlight_overlay_on_aux: false,
            },
        )
        .await;

        destroy_preview_surface(&state).await;
        let status = compositor_status(&state).await;
        stop_compositor(&state).await;

        assert_eq!(status.state, CompositorState::Live);
        assert_eq!(status.run_id, recording_status.run_id);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
    }

    async fn wait_for_frame_dimensions_after(
        state: &AppState,
        width: u32,
        height: u32,
        after_sequence: Option<u64>,
    ) -> Result<CompositorFrameEvidence, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let latest = compositor_latest_frame_evidence(state).await;
            if let Some(evidence) = latest
                && evidence.width == width
                && evidence.height == height
                && after_sequence.is_none_or(|sequence| evidence.sequence > sequence)
            {
                return Ok(evidence);
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "compositor never published a {width}x{height} frame after sequence {after_sequence:?} (latest: {latest:?})"
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn bounds_update_reshapes_the_live_preview_compositor() {
        // The stale-orientation preview bug: the render loop latched its
        // spawn-time dimensions, so an off-air canvas flip (orientation
        // toggle) resized the surface bounds and the compositor STATUS while
        // frames kept publishing at the OLD size until the next recording
        // start rebuilt the pipeline. The loop must reshape mid-stream.
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(160.0, 90.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;
        let verification = async {
            let initial = wait_for_frame_dimensions_after(&state, 160, 90, None).await?;
            let initial_status = compositor_status(&state).await;

            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(90.0, 160.0),
                },
            )
            .await;
            let portrait =
                wait_for_frame_dimensions_after(&state, 90, 160, Some(initial.sequence)).await?;

            // The owner's 2026-07-14 regression was this reverse direction:
            // horizontal mode returned while the compositor kept publishing
            // the previous portrait canvas inside the landscape preview.
            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(160.0, 90.0),
                },
            )
            .await;
            let landscape =
                wait_for_frame_dimensions_after(&state, 160, 90, Some(portrait.sequence)).await?;
            let final_status = compositor_status(&state).await;
            Ok::<_, String>((initial_status, portrait, landscape, final_status))
        }
        .await;
        destroy_preview_surface(&state).await;

        let (initial_status, portrait, landscape, final_status) =
            verification.expect("preview compositor should follow both orientation changes");
        assert_eq!(portrait.width, 90);
        assert_eq!(portrait.height, 160);
        assert_eq!(landscape.width, 160);
        assert_eq!(landscape.height, 90);
        assert_eq!(final_status.run_id, initial_status.run_id);
        assert_eq!(final_status.width, 160);
        assert_eq!(final_status.height, 90);
    }

    #[tokio::test]
    async fn update_bounds_does_not_resize_newer_recording_compositor() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(160.0, 90.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;
        wait_for_frame_dimensions_after(&state, 160, 90, None)
            .await
            .expect("preview compositor should publish before ownership changes");
        let preview_run_id = compositor_status(&state)
            .await
            .run_id
            .expect("preview compositor run id");

        let recording_status = start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps: 30,
                width: 160,
                height: 90,
                frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                stream_output: None,
                caption_overlay_on_primary: false,
                caption_overlay_on_aux: false,
                highlight_overlay_on_primary: false,
                highlight_overlay_on_aux: false,
            },
        )
        .await;

        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(90.0, 160.0),
            },
        )
        .await;
        let stale_run_resize =
            resize_preview_compositor_if_run_id(&state, &preview_run_id, 90, 160).await;
        let recording_run_resize = resize_preview_compositor_if_run_id(
            &state,
            recording_status
                .run_id
                .as_deref()
                .expect("recording run id"),
            90,
            160,
        )
        .await;
        let status = compositor_status(&state).await;
        stop_compositor(&state).await;

        assert_ne!(
            recording_status.run_id.as_deref(),
            Some(preview_run_id.as_str())
        );
        assert!(stale_run_resize.is_none());
        assert!(recording_run_resize.is_none());
        assert_eq!(status.run_id, recording_status.run_id);
        assert_eq!(status.width, 160);
        assert_eq!(status.height, 90);
    }

    #[tokio::test]
    async fn preview_surface_does_not_take_compositor_during_capture_startup() {
        let state = test_state();
        let _capture = state.ffmpeg_work.begin_capture_when_available().await;
        let recording_status = start_synthetic_compositor(
            state.clone(),
            CompositorStartParams {
                target_fps: 30,
                width: 640,
                height: 360,
                frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                stream_output: None,
                caption_overlay_on_primary: false,
                caption_overlay_on_aux: false,
                highlight_overlay_on_primary: false,
                highlight_overlay_on_aux: false,
            },
        )
        .await;

        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(960.0, 540.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await;
        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(1280.0, 720.0),
            },
        )
        .await;

        let status = compositor_status(&state).await;
        let preview_run_id = state.preview_surface.lock().await.run_id.clone();
        stop_compositor(&state).await;

        assert_eq!(status.state, CompositorState::Live);
        assert_eq!(status.run_id, recording_status.run_id);
        assert_eq!(status.width, 640);
        assert_eq!(status.height, 360);
        assert_eq!(preview_run_id, None);
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
        let destroyed = destroy_preview_surface(&state).await;

        assert_eq!(destroyed.pending_host_command_count, 3);

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
        assert_eq!(
            preview_surface_status(&state)
                .await
                .pending_host_command_count,
            0
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
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: true,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state).await;

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
        assert!(status.frame_polling_suppressed);
        assert!(!status.source_pixels_present);
        assert_eq!(
            diagnostics.preview_transport,
            PreviewTransport::NativeSurface
        );
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
        assert!(diagnostics.preview_frame_polling_suppressed);
        assert!(!diagnostics.preview_source_pixels_present);
        assert_eq!(diagnostics.preview_compositor_frame_lag, Some(1));
        assert_eq!(diagnostics.preview_dropped_frames, 3);
        assert_eq!(diagnostics.preview_render_frame_time_p95_ms, Some(19.0));
        assert_eq!(diagnostics.preview_render_frame_time_p99_ms, Some(24.0));
    }

    #[tokio::test]
    async fn native_host_activation_marks_cametal_layer_after_presented_frame() {
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

        let status = activate_native_preview_host(
            &state,
            NativePreviewHostActivation::cametal_layer_presented(12),
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state).await;

        assert_eq!(status.transport, PreviewTransport::NativeSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(status.presented_frame_id, Some(12));
        assert_eq!(status.frames_rendered, 12);
        assert!(status.frame_polling_suppressed);
        assert!(status.source_pixels_present);
        assert!(
            status
                .message
                .as_deref()
                .is_some_and(|message| message.contains("CAMetalLayer"))
        );
        assert_eq!(
            diagnostics.preview_transport,
            PreviewTransport::NativeSurface
        );
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::CaMetalLayer
        );
        assert!(diagnostics.preview_frame_polling_suppressed);
        assert!(diagnostics.preview_source_pixels_present);
    }

    #[tokio::test]
    async fn native_host_activation_does_not_rewind_presented_frame_id() {
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
        activate_native_preview_host(
            &state,
            NativePreviewHostActivation::cametal_layer_presented(12),
        )
        .await;

        let status = activate_native_preview_host(
            &state,
            NativePreviewHostActivation::cametal_layer_presented(10),
        )
        .await;
        destroy_preview_surface(&state).await;

        assert_eq!(status.presented_frame_id, Some(12));
        assert!(status.frames_rendered >= 12);
    }

    #[tokio::test]
    async fn native_host_activation_is_ignored_when_surface_is_not_live() {
        let state = test_state();

        let status = activate_native_preview_host(
            &state,
            NativePreviewHostActivation::cametal_layer_presented(12),
        )
        .await;

        assert_eq!(status.transport, PreviewTransport::Unavailable);
        assert_eq!(status.backing, PreviewSurfaceBacking::None);
        assert_eq!(status.presented_frame_id, None);

        let diagnostics = state.diagnostics.lock().await;
        assert_eq!(diagnostics.preview_transport, PreviewTransport::Unavailable);
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::None
        );
    }

    #[tokio::test]
    async fn native_surface_claim_waits_for_presented_frame_id() {
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
                presented_frame_id: None,
                compositor_frame_lag: None,
                dropped_frames: 0,
                input_to_present_latency_ms: Some(37),
                input_to_present_latency_p50_ms: Some(31),
                input_to_present_latency_p95_ms: Some(48),
                input_to_present_latency_p99_ms: Some(73),
                present_fps: Some(58.5),
                interval_p95_ms: Some(19.0),
                interval_p99_ms: Some(24.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state).await;

        assert_eq!(status.transport, PreviewTransport::ElectronProofSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::ElectronBrowserWindow);
        assert_eq!(status.presented_frame_id, None);
        assert!(
            status
                .message
                .as_deref()
                .is_some_and(|message| message.contains("first presented compositor frame"))
        );
        assert_eq!(
            diagnostics.preview_transport,
            PreviewTransport::ElectronProofSurface
        );
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::ElectronBrowserWindow
        );
    }

    #[tokio::test]
    async fn native_surface_claim_stays_live_after_first_presented_frame() {
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

        update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::NativeSurface),
                backing: Some(PreviewSurfaceBacking::CaMetalLayer),
                presented_frame_id: Some(42),
                compositor_frame_lag: Some(0),
                dropped_frames: 0,
                input_to_present_latency_ms: Some(37),
                input_to_present_latency_p50_ms: Some(31),
                input_to_present_latency_p95_ms: Some(48),
                input_to_present_latency_p99_ms: Some(73),
                present_fps: Some(58.5),
                interval_p95_ms: Some(19.0),
                interval_p99_ms: Some(24.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let status = update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::NativeSurface),
                backing: Some(PreviewSurfaceBacking::CaMetalLayer),
                presented_frame_id: None,
                compositor_frame_lag: Some(0),
                dropped_frames: 1,
                input_to_present_latency_ms: Some(20),
                input_to_present_latency_p50_ms: Some(18),
                input_to_present_latency_p95_ms: Some(24),
                input_to_present_latency_p99_ms: Some(30),
                present_fps: Some(60.0),
                interval_p95_ms: Some(17.0),
                interval_p99_ms: Some(18.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        destroy_preview_surface(&state).await;

        assert_eq!(status.transport, PreviewTransport::NativeSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(status.presented_frame_id, Some(42));
        assert_eq!(status.dropped_frames, 1);
        assert_eq!(status.input_to_present_latency_ms, Some(20));
    }

    #[tokio::test]
    async fn stale_present_update_does_not_rewind_surface_metrics() {
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
        update_preview_surface_present(
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
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let stale = update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::ElectronProofSurface),
                backing: Some(PreviewSurfaceBacking::ElectronBrowserWindow),
                presented_frame_id: Some(40),
                compositor_frame_lag: Some(9),
                dropped_frames: 1,
                input_to_present_latency_ms: Some(120),
                input_to_present_latency_p50_ms: Some(110),
                input_to_present_latency_p95_ms: Some(130),
                input_to_present_latency_p99_ms: Some(150),
                present_fps: Some(12.0),
                interval_p95_ms: Some(80.0),
                interval_p99_ms: Some(100.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state).await;

        assert_eq!(stale.transport, PreviewTransport::NativeSurface);
        assert_eq!(stale.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(stale.presented_frame_id, Some(42));
        assert_eq!(stale.compositor_frame_lag, Some(1));
        assert_eq!(stale.dropped_frames, 3);
        assert_eq!(stale.input_to_present_latency_ms, Some(37));
        assert_eq!(stale.input_to_present_latency_p95_ms, Some(48));
        assert_eq!(stale.present_fps, Some(58.5));
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::CaMetalLayer
        );
        assert_eq!(diagnostics.preview_compositor_frame_lag, Some(1));
        assert_eq!(diagnostics.preview_dropped_frames, 3);
        assert_eq!(diagnostics.preview_input_to_present_latency_ms, Some(37));
        assert_eq!(
            diagnostics.preview_input_to_present_latency_p95_ms,
            Some(48)
        );
    }

    #[tokio::test]
    async fn fresh_present_update_keeps_preview_drop_count_monotonic() {
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
        update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::ElectronProofSurface),
                backing: Some(PreviewSurfaceBacking::ElectronBrowserWindow),
                presented_frame_id: Some(42),
                compositor_frame_lag: Some(1),
                dropped_frames: 7,
                input_to_present_latency_ms: Some(37),
                input_to_present_latency_p50_ms: Some(31),
                input_to_present_latency_p95_ms: Some(48),
                input_to_present_latency_p99_ms: Some(73),
                present_fps: Some(58.5),
                interval_p95_ms: Some(19.0),
                interval_p99_ms: Some(24.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let status = update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::ElectronProofSurface),
                backing: Some(PreviewSurfaceBacking::ElectronBrowserWindow),
                presented_frame_id: Some(43),
                compositor_frame_lag: Some(0),
                dropped_frames: 2,
                input_to_present_latency_ms: Some(20),
                input_to_present_latency_p50_ms: Some(18),
                input_to_present_latency_p95_ms: Some(24),
                input_to_present_latency_p99_ms: Some(30),
                present_fps: Some(60.0),
                interval_p95_ms: Some(17.0),
                interval_p99_ms: Some(18.0),
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state).await;

        assert_eq!(status.presented_frame_id, Some(43));
        assert_eq!(status.compositor_frame_lag, Some(0));
        assert_eq!(status.dropped_frames, 7);
        assert_eq!(status.input_to_present_latency_ms, Some(20));
        assert_eq!(diagnostics.preview_dropped_frames, 7);
        assert_eq!(diagnostics.preview_input_to_present_latency_ms, Some(20));
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
        update_preview_surface_present(
            &state,
            PreviewSurfacePresentParams {
                transport: Some(PreviewTransport::ElectronProofSurface),
                backing: Some(PreviewSurfaceBacking::ElectronBrowserWindow),
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
                native_preview_main_scene_mismatch_count: None,
                native_preview_main_scene_mismatch_age_ms: None,
                native_preview_main_last_skipped_scene_revision: None,
                native_preview_main_last_skipped_frame_scene_revision: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
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
        drop(surface);

        let diagnostics = state.diagnostics.lock().await;
        assert_eq!(diagnostics.preview_transport, PreviewTransport::Unavailable);
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::None
        );
        assert_eq!(diagnostics.preview_present_fps, None);
        assert_eq!(diagnostics.preview_input_to_present_latency_p95_ms, None);
        assert_eq!(diagnostics.preview_input_to_present_latency_p99_ms, None);
        assert_eq!(diagnostics.preview_compositor_frame_lag, None);
        assert!(!diagnostics.preview_frame_polling_suppressed);
        assert!(!diagnostics.preview_source_pixels_present);
        assert_eq!(diagnostics.preview_render_frame_time_p95_ms, None);
        assert_eq!(diagnostics.preview_dropped_frames, 0);
    }
}
