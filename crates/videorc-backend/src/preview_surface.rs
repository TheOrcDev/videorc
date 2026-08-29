use crate::compositor::{
    CompositorFrameConsumer, CompositorStartParams,
    resize_preview_compositor_if_run_id_at_revision, start_synthetic_compositor_if_idle,
    stop_compositor_if_run_id,
};
#[cfg(test)]
use crate::compositor::{
    replace_current_compositor_worker_with_non_stopping_for_test,
    resize_preview_compositor_if_run_id, start_synthetic_compositor,
};
use crate::diagnostics::{apply_preview_surface_resize, apply_runtime_diagnostics_snapshot};
use crate::native_preview_host::{
    NativePreviewHostActivation, NativePreviewHostBounds, NativePreviewHostCommand,
    NativePreviewHostLifecycle, NativePreviewHostLifecycleUpdate,
};
use crate::protocol::{
    CompositorState, MainOwnedPreviewSurfaceBounds, MainOwnedPreviewSurfaceBoundsParams,
    PreviewSurfaceBacking, PreviewSurfaceBoundsParams, PreviewSurfaceCreateParams,
    PreviewSurfacePresentParams, PreviewSurfaceSource, PreviewSurfaceState, PreviewSurfaceStatus,
    PreviewTransport,
};
use crate::state::AppState;
#[cfg(target_os = "windows")]
use crate::windows_d3d11_device::DxgiAdapterLuid;
#[cfg(target_os = "windows")]
use crate::windows_d3d11_preview::{WindowsD3d11PresenterStatus, WindowsD3d11PreviewPlacement};
use chrono::Utc;

pub type PreviewSurfaceSlot = std::sync::Arc<tokio::sync::Mutex<PreviewSurfaceRuntime>>;

#[derive(Debug)]
pub struct PreviewSurfaceRuntime {
    pub status: PreviewSurfaceStatus,
    run_id: Option<String>,
    /// Monotonic ownership fence for create/update/destroy work that must
    /// release `preview_surface_lifecycle` before awaiting compositor work.
    lifecycle_revision: u64,
    /// Exact preview compositor runs retired by a superseded create/destroy.
    /// Reconciliation drains these outside the lifecycle mutex before it may
    /// adopt or start a run for the latest desired revision.
    retiring_run_ids: Vec<String>,
    /// Only one exact-run stop may be outstanding. The owned mutex guard is
    /// cancellation-safe: aborting a reconciler cannot leave a sticky boolean
    /// that blocks every future retirement attempt.
    retirement_stop_lane: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// A bounded process-owned retry loop owns unresolved retirement debt.
    /// Foreground reconcilers leave the successor blocked until that loop
    /// either proves the old run absent or escalates.
    retirement_retry_scheduled: bool,
    #[cfg(any(target_os = "windows", test))]
    d3d11_compositor_suspension: Option<PreviewCompositorSuspensionReservation>,
    /// Exact presenter identity authorized by the most recent backend
    /// configure attempt. Teardown clears it under the lifecycle lock so a
    /// delayed monitor refresh cannot resurrect a retired presenter status.
    #[cfg(any(target_os = "windows", test))]
    d3d11_presenter_configuration: Option<(u64, u64)>,
    native_host: NativePreviewHostLifecycle,
    pending_native_host_commands: Vec<NativePreviewHostCommand>,
    /// Privileged Electron-main identity for the backend-owned Windows
    /// presenter. It is deliberately separate from `status.bounds`.
    pub(crate) main_owned_bounds: Option<MainOwnedPreviewSurfaceBounds>,
    pub(crate) main_owned_host_bounds: Option<NativePreviewHostBounds>,
    pub(crate) main_owned_generation: Option<u64>,
}

impl PreviewSurfaceRuntime {
    /// Final synchronous fence used while the compositor ownership lock is
    /// held. `try_lock`ing this surface from the resize path makes a bounds
    /// commit and its matching pixel resize strictly ordered without awaiting
    /// compositor work under `preview_surface_lifecycle`.
    pub(crate) fn permits_compositor_resize(
        &self,
        lifecycle_revision: u64,
        run_id: &str,
        width: u32,
        height: u32,
    ) -> bool {
        self.lifecycle_revision == lifecycle_revision
            && self.status.state == PreviewSurfaceState::Live
            && self.status.width == width
            && self.status.height == height
            && self.run_id.as_deref() == Some(run_id)
            && self.retiring_run_ids.is_empty()
            && !preview_compositor_is_suspended(self)
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone)]
struct PreviewCompositorSuspensionReservation {
    media_generation: u64,
    surface_started_at: Option<String>,
    stop_pending_run_id: Option<String>,
}

/// Generation/run-scoped ownership token for a CPU preview compositor paused
/// while the Windows D3D11 presenter owns preview pixels. Dropping the token
/// schedules a best-effort restore, while `restore` provides an awaitable
/// normal-shutdown path.
#[cfg(any(target_os = "windows", test))]
pub(crate) struct PreviewCompositorSuspension {
    state: AppState,
    media_generation: u64,
    restored: bool,
}

#[cfg(any(target_os = "windows", test))]
impl std::fmt::Debug for PreviewCompositorSuspension {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreviewCompositorSuspension")
            .field("media_generation", &self.media_generation)
            .field("restored", &self.restored)
            .finish()
    }
}

#[cfg(any(target_os = "windows", test))]
impl PreviewCompositorSuspension {
    pub(crate) async fn restore(mut self) {
        restore_suspended_preview_compositor(self.state.clone(), self.media_generation).await;
        self.restored = true;
    }
}

#[cfg(any(target_os = "windows", test))]
impl Drop for PreviewCompositorSuspension {
    fn drop(&mut self) {
        if self.restored {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let state = self.state.clone();
        let media_generation = self.media_generation;
        runtime.spawn(async move {
            restore_suspended_preview_compositor(state, media_generation).await;
        });
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) async fn suspend_preview_compositor_for_d3d11(
    state: &AppState,
    media_generation: u64,
) -> Option<PreviewCompositorSuspension> {
    if media_generation == 0 {
        return None;
    }
    let run_id = {
        let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
        let mut surface = state.preview_surface.lock().await;
        if surface.status.state != PreviewSurfaceState::Live {
            return None;
        }
        if let Some(reservation) = surface.d3d11_compositor_suspension.as_mut() {
            if media_generation <= reservation.media_generation {
                return None;
            }
            reservation.media_generation = media_generation;
            match reservation.stop_pending_run_id.clone() {
                Some(run_id) => run_id,
                None => {
                    return Some(PreviewCompositorSuspension {
                        state: state.clone(),
                        media_generation,
                        restored: false,
                    });
                }
            }
        } else {
            let run_id = surface.run_id.clone()?;
            let surface_started_at = surface.status.started_at.clone();
            surface.d3d11_compositor_suspension = Some(PreviewCompositorSuspensionReservation {
                media_generation,
                surface_started_at,
                stop_pending_run_id: Some(run_id.clone()),
            });
            run_id
        }
    };
    let _ = stop_compositor_if_run_id(state, &run_id).await;
    if crate::compositor::compositor_status(state)
        .await
        .run_id
        .as_deref()
        == Some(run_id.as_str())
    {
        let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
        let mut surface = state.preview_surface.lock().await;
        if surface
            .d3d11_compositor_suspension
            .as_ref()
            .is_some_and(|reservation| {
                reservation.stop_pending_run_id.as_deref() == Some(run_id.as_str())
            })
        {
            surface.d3d11_compositor_suspension = None;
        }
        return None;
    }
    let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
    let mut surface = state.preview_surface.lock().await;
    let reservation = surface.d3d11_compositor_suspension.as_ref()?;
    if reservation.stop_pending_run_id.is_none() {
        return (surface.status.state == PreviewSurfaceState::Live
            && surface.run_id.is_none()
            && reservation.surface_started_at == surface.status.started_at
            && reservation.media_generation == media_generation)
            .then(|| PreviewCompositorSuspension {
                state: state.clone(),
                media_generation,
                restored: false,
            });
    }
    if surface.status.state != PreviewSurfaceState::Live
        || surface.run_id.as_deref() != Some(run_id.as_str())
        || reservation.surface_started_at != surface.status.started_at
        || reservation.stop_pending_run_id.as_deref() != Some(run_id.as_str())
    {
        let pending_matches = reservation.stop_pending_run_id.as_deref() == Some(run_id.as_str());
        if pending_matches {
            surface.d3d11_compositor_suspension = None;
        }
        drop(surface);
        drop(_surface_lifecycle);
        reconcile_live_preview_compositor(state).await;
        return None;
    }
    surface.run_id = None;
    let reservation = surface
        .d3d11_compositor_suspension
        .as_mut()
        .expect("the pending D3D11 suspension reservation was just validated");
    reservation.stop_pending_run_id = None;
    if reservation.media_generation != media_generation {
        return None;
    }
    Some(PreviewCompositorSuspension {
        state: state.clone(),
        media_generation,
        restored: false,
    })
}

/// Why a suspended CPU preview compositor could not be restored on the exact
/// reservation it was suspended with. Every variant used to be a silent early
/// return; on the Windows tester's box the preview surface was left with no
/// producer after stop (frame age climbing to seconds). Each is now a WARN
/// health event with a stable code, and `restore_suspended_preview_compositor`
/// falls back to starting a compositor whenever the surface is live and has
/// none.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreviewCompositorRestoreSkip {
    /// No reservation exists any more (already restored, or cleared by a
    /// surface lifecycle change).
    NoReservation,
    /// A different (newer) D3D11 generation owns the reservation now.
    GenerationMismatch { reserved: u64 },
    /// The surface changed underneath the reservation (destroyed/recreated,
    /// or it already runs another compositor), so the reservation is stale.
    SurfaceChanged,
    /// Another compositor run was active, so the idle-only start declined.
    CompositorBusy,
    /// The compositor start returned no run id.
    NoRunId,
    /// The surface changed while the compositor was starting; the new run
    /// was stopped again rather than adopted.
    SurfaceChangedDuringStart,
}

#[cfg(any(target_os = "windows", test))]
impl PreviewCompositorRestoreSkip {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NoReservation => "preview-compositor-restore-no-reservation",
            Self::GenerationMismatch { .. } => "preview-compositor-restore-generation-mismatch",
            Self::SurfaceChanged => "preview-compositor-restore-surface-changed",
            Self::CompositorBusy => "preview-compositor-restore-compositor-busy",
            Self::NoRunId => "preview-compositor-restore-no-run-id",
            Self::SurfaceChangedDuringStart => {
                "preview-compositor-restore-surface-changed-during-start"
            }
        }
    }

    pub(crate) fn message(self, media_generation: u64) -> String {
        let reason = match self {
            Self::NoReservation => "no suspension reservation exists any more".to_string(),
            Self::GenerationMismatch { reserved } => {
                format!("D3D11 generation {reserved} owns the reservation now")
            }
            Self::SurfaceChanged => {
                "the preview surface changed underneath the reservation".to_string()
            }
            Self::CompositorBusy => "another compositor run is still active".to_string(),
            Self::NoRunId => "the compositor start returned no run id".to_string(),
            Self::SurfaceChangedDuringStart => {
                "the preview surface changed while the compositor was starting".to_string()
            }
        };
        format!(
            "Suspended CPU preview compositor was not restored on its reservation after Windows D3D11 generation {media_generation} ended: {reason}."
        )
    }
}

#[cfg(any(target_os = "windows", test))]
fn report_preview_compositor_restore_skip(
    state: &AppState,
    media_generation: u64,
    skip: PreviewCompositorRestoreSkip,
) {
    let message = skip.message(media_generation);
    state.emit_log("warn", message.clone());
    let _ = crate::recording::emit_health_event(
        state,
        None,
        crate::protocol::HealthLevel::Warn,
        skip.code(),
        &message,
    );
}

#[cfg(any(target_os = "windows", test))]
async fn restore_suspended_preview_compositor(state: AppState, media_generation: u64) {
    if let Err(skip) =
        restore_suspended_preview_compositor_on_reservation(&state, media_generation).await
    {
        report_preview_compositor_restore_skip(&state, media_generation, skip);
        // A newer generation still owns the preview pixels; its own restore
        // runs when it ends. Every other skip may leave the surface with no
        // producer, so start one whenever the surface is live and idle.
        if !matches!(
            skip,
            PreviewCompositorRestoreSkip::GenerationMismatch { .. }
        ) {
            ensure_live_preview_surface_has_compositor(&state, media_generation).await;
        }
    }
}

/// The exact-reservation restore. It takes the reservation in a short surface
/// transaction, starts outside the lifecycle mutex, then generation-fences the
/// install (or stops that exact orphaned run).
#[cfg(any(target_os = "windows", test))]
async fn restore_suspended_preview_compositor_on_reservation(
    state: &AppState,
    media_generation: u64,
) -> Result<(), PreviewCompositorRestoreSkip> {
    restore_suspended_preview_compositor_on_reservation_with_hook(state, media_generation, |_| {})
        .await
}

#[cfg(any(target_os = "windows", test))]
async fn restore_suspended_preview_compositor_on_reservation_with_hook(
    state: &AppState,
    media_generation: u64,
    before_compositor_action: impl FnMut(PreviewCompositorReconcilePoint),
) -> Result<(), PreviewCompositorRestoreSkip> {
    let _reservation = {
        let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
        let mut surface = state.preview_surface.lock().await;
        let Some(reservation) = surface.d3d11_compositor_suspension.as_ref() else {
            return Err(PreviewCompositorRestoreSkip::NoReservation);
        };
        if reservation.media_generation != media_generation {
            return Err(PreviewCompositorRestoreSkip::GenerationMismatch {
                reserved: reservation.media_generation,
            });
        }
        if surface.status.state != PreviewSurfaceState::Live
            || surface.status.started_at != reservation.surface_started_at
            || surface.run_id.is_some()
            || reservation.stop_pending_run_id.is_some()
        {
            surface.d3d11_compositor_suspension = None;
            return Err(PreviewCompositorRestoreSkip::SurfaceChanged);
        }
        surface
            .d3d11_compositor_suspension
            .take()
            .expect("the exact D3D11 suspension reservation was just validated")
    };
    // Restoration is only a desired-state transition. The shared reconciler
    // owns every external stop/start/adopt action, so a newer bounds/create
    // revision can safely adopt a run which this older D3D generation caused
    // to start. The old restore path must never stop such an adopted run.
    reconcile_live_preview_compositor_with_hook(state, before_compositor_action).await;

    let (surface_state, surface_run_id, suspended_generation) = {
        let surface = state.preview_surface.lock().await;
        (
            surface.status.state.clone(),
            surface.run_id.clone(),
            surface
                .d3d11_compositor_suspension
                .as_ref()
                .map(|reservation| reservation.media_generation),
        )
    };
    if let Some(reserved) = suspended_generation {
        return Err(PreviewCompositorRestoreSkip::GenerationMismatch { reserved });
    }
    if surface_state != PreviewSurfaceState::Live {
        return Err(PreviewCompositorRestoreSkip::SurfaceChanged);
    }
    let compositor = crate::compositor::compositor_status(state).await;
    if surface_run_id.is_some()
        && surface_run_id == compositor.run_id
        && compositor.state == CompositorState::Live
        && compositor.frame_pipeline.consumer.as_deref() == Some("native-preview")
    {
        Ok(())
    } else if compositor.run_id.is_none() {
        Err(PreviewCompositorRestoreSkip::NoRunId)
    } else {
        Err(PreviewCompositorRestoreSkip::CompositorBusy)
    }
}

/// Fallback after a skipped restore: a live preview surface with no
/// compositor run and no outstanding reservation gets a compositor started
/// from its own status. Start/stop work remains outside the lifecycle mutex.
#[cfg(any(target_os = "windows", test))]
async fn ensure_live_preview_surface_has_compositor(state: &AppState, media_generation: u64) {
    reconcile_live_preview_compositor(state).await;
    let (surface_state, surface_run_id, suspended) = {
        let surface = state.preview_surface.lock().await;
        (
            surface.status.state.clone(),
            surface.run_id.clone(),
            surface.d3d11_compositor_suspension.is_some(),
        )
    };
    let compositor = crate::compositor::compositor_status(state).await;
    let restored = surface_state == PreviewSurfaceState::Live
        && !suspended
        && surface_run_id.is_some()
        && surface_run_id == compositor.run_id
        && compositor.state == CompositorState::Live
        && compositor.frame_pipeline.consumer.as_deref() == Some("native-preview");
    if restored {
        state.emit_log(
            "info",
            format!(
                "Started a replacement CPU preview compositor for the live preview surface after Windows D3D11 generation {media_generation} ended."
            ),
        );
    } else {
        state.emit_log(
            "warn",
            format!(
                "Live preview surface has no proven live compositor after Windows D3D11 generation {media_generation} ended."
            ),
        );
    }
}

pub fn initial_preview_surface_state() -> PreviewSurfaceRuntime {
    PreviewSurfaceRuntime {
        status: unavailable_status(Some("Native preview surface is not running.".to_string())),
        run_id: None,
        lifecycle_revision: 0,
        retiring_run_ids: Vec::new(),
        retirement_stop_lane: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        retirement_retry_scheduled: false,
        #[cfg(any(target_os = "windows", test))]
        d3d11_compositor_suspension: None,
        #[cfg(any(target_os = "windows", test))]
        d3d11_presenter_configuration: None,
        native_host: NativePreviewHostLifecycle::default(),
        pending_native_host_commands: Vec::new(),
        main_owned_bounds: None,
        main_owned_host_bounds: None,
        main_owned_generation: None,
    }
}

pub async fn apply_main_owned_preview_surface_bounds(
    state: &AppState,
    params: MainOwnedPreviewSurfaceBoundsParams,
) -> Result<PreviewSurfaceStatus, String> {
    // HWND liveness/ownership checks cross into user32 on Windows. Do them
    // before taking the finalization-critical surface lifecycle mutex.
    validate_main_owned_preview_window(&params.bounds)?;
    {
        let _lifecycle = acquire_preview_surface_lifecycle(state)
            .await
            .map_err(|_| PreviewSurfaceBusy::MESSAGE.to_string())?;
        let mut slot = state.preview_surface.lock().await;
        apply_validated_main_owned_preview_surface_bounds(&mut slot, params)?;
        slot.lifecycle_revision = slot.lifecycle_revision.saturating_add(1);
    }

    reconcile_live_preview_compositor(state).await;
    let status = emit_current_preview_surface_status(state).await;
    Ok(status)
}

fn apply_validated_main_owned_preview_surface_bounds(
    slot: &mut PreviewSurfaceRuntime,
    params: MainOwnedPreviewSurfaceBoundsParams,
) -> Result<PreviewSurfaceStatus, String> {
    if !matches!(
        slot.status.state,
        PreviewSurfaceState::Starting | PreviewSurfaceState::Live
    ) {
        return Err("preview presenter bounds require an active preview surface".to_string());
    }
    if let Some(active_generation) = slot.main_owned_generation {
        if params.generation < active_generation {
            return Err(format!(
                "stale preview generation {} cannot replace active generation {active_generation}",
                params.generation
            ));
        }
        if params.generation > active_generation {
            slot.main_owned_bounds = None;
            slot.main_owned_host_bounds = None;
            #[cfg(any(target_os = "windows", test))]
            {
                slot.d3d11_presenter_configuration = None;
                if let Some(presenter) = slot.status.windows_d3d11_presenter.as_mut() {
                    let reason = "windows-d3d11-preview-generation-superseded";
                    presenter.source_live = false;
                    presenter.first_present_succeeded = false;
                    presenter.fallback_reason = Some(reason.to_string());
                    slot.status.transport = PreviewTransport::ElectronProofSurface;
                    slot.status.backing = PreviewSurfaceBacking::ElectronBrowserWindow;
                    slot.status.frame_polling_suppressed = false;
                    slot.status.source_pixels_present = false;
                    slot.status.message = Some(format!(
                        "Windows native preview presenter stopped; Electron proof fallback is active: {reason}."
                    ));
                }
            }
        }
    }

    let safe_bounds = params.bounds.bounds.clone();
    let host_bounds = NativePreviewHostBounds::from_main_owned(&params.bounds, params.generation);
    slot.main_owned_generation = Some(params.generation);
    slot.main_owned_bounds = Some(params.bounds);
    slot.main_owned_host_bounds = Some(host_bounds);
    slot.status.width = surface_render_dimension(safe_bounds.width, safe_bounds.scale_factor);
    slot.status.height = surface_render_dimension(safe_bounds.height, safe_bounds.scale_factor);
    slot.status.bounds = Some(safe_bounds);
    slot.status.updated_at = Utc::now().to_rfc3339();
    Ok(slot.status.clone())
}

#[cfg(not(target_os = "windows"))]
fn validate_main_owned_preview_window(
    bounds: &MainOwnedPreviewSurfaceBounds,
) -> Result<(), String> {
    if bounds.order_above_window_handle.is_some() {
        return Err("a Windows HWND is not accepted on this platform".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_main_owned_preview_window(
    bounds: &MainOwnedPreviewSurfaceBounds,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let handle = bounds
        .order_above_window_handle
        .as_ref()
        .ok_or_else(|| "the Windows preview presenter requires a main-owned HWND".to_string())?;
    let pointer = usize::try_from(handle.as_u64())
        .map_err(|_| "the preview HWND does not fit this process pointer width".to_string())?;
    let hwnd = HWND(pointer as *mut core::ffi::c_void);
    // SAFETY: these calls only inspect the opaque HWND. `IsWindow` is checked
    // before ownership is queried, and the handle is never dereferenced.
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("the main-owned preview HWND is no longer a live window".to_string());
    }
    let expected_pid = std::env::var("VIDEORC_SUPERVISOR_PID")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| "the authenticated Electron supervisor PID is unavailable".to_string())?;
    let mut owner_pid = 0_u32;
    // SAFETY: `owner_pid` is a live writable u32 for the duration of the call.
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner_pid)) };
    if thread_id == 0 || owner_pid != expected_pid {
        return Err(format!(
            "the preview HWND belongs to process {owner_pid}, expected Electron supervisor {expected_pid}"
        ));
    }
    Ok(())
}

/// How long a surface RPC may wait for the lifecycle mutex before answering
/// `surface-busy`. 2026-08-27 live incident: a healing destroy/create cycle
/// held the lifecycle lock while an `update_bounds` sat inside the ordered
/// dispatcher's single stateful-mutation slot for 30+ seconds — silently
/// barriering every later command until the lane filled. A bounded wait turns
/// that into a fast, retryable error the renderer's latest-wins bounds loop
/// absorbs without user-visible noise.
const PREVIEW_SURFACE_LIFECYCLE_ACQUIRE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(3);

/// The lifecycle mutex could not be acquired inside the budget: another
/// surface lifecycle operation (create/destroy/heal) is still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewSurfaceBusy;

impl PreviewSurfaceBusy {
    pub const CODE: &'static str = "surface-busy";
    pub const MESSAGE: &'static str =
        "The preview surface is busy with another lifecycle operation; retry shortly.";
}

async fn acquire_preview_surface_lifecycle(
    state: &AppState,
) -> Result<tokio::sync::OwnedMutexGuard<()>, PreviewSurfaceBusy> {
    tokio::time::timeout(
        PREVIEW_SURFACE_LIFECYCLE_ACQUIRE_TIMEOUT,
        state.preview_surface_lifecycle.clone().lock_owned(),
    )
    .await
    .map_err(|_| PreviewSurfaceBusy)
}

pub async fn create_preview_surface(
    state: AppState,
    params: PreviewSurfaceCreateParams,
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    create_preview_surface_with_reconcile_hook(state, params, |_| {}).await
}

async fn create_preview_surface_with_reconcile_hook(
    state: AppState,
    params: PreviewSurfaceCreateParams,
    before_compositor_action: impl FnMut(PreviewCompositorReconcilePoint),
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    let target_fps = params.target_fps.clamp(30, 120);
    let capture_active = capture_owns_compositor(&state);
    let bounds = params.bounds;
    let source = params.source;
    let reused = {
        let _lifecycle = acquire_preview_surface_lifecycle(&state).await?;
        let mut slot = state.preview_surface.lock().await;
        slot.lifecycle_revision = slot.lifecycle_revision.saturating_add(1);
        let reused = slot.status.state == PreviewSurfaceState::Live
            && (capture_active || slot.status.target_fps == target_fps);
        if reused {
            let mut next = slot.status.clone();
            next.source = source;
            next.target_fps = target_fps;
            next.width = surface_render_dimension(bounds.width, bounds.scale_factor);
            next.height = surface_render_dimension(bounds.height, bounds.scale_factor);
            next.bounds = Some(bounds.clone());
            next.updated_at = Utc::now().to_rfc3339();
            let host_update = slot.native_host.update_bounds(&bounds);
            apply_native_host_update(
                &mut next,
                &mut slot.pending_native_host_commands,
                host_update,
            );
            next.pending_host_command_count = pending_host_command_count(&slot);
            if capture_active {
                // Recording startup replaces any preview-owned compositor.
                // Never let later surface teardown target that stale run id.
                slot.run_id = None;
            }
            slot.status = next.clone();
            true
        } else {
            let had_surface = slot.run_id.is_some()
                || matches!(
                    slot.status.state,
                    PreviewSurfaceState::Starting | PreviewSurfaceState::Live
                );
            let host_destroy = slot.native_host.destroy();
            if had_surface && let Some(command) = host_destroy.command {
                slot.pending_native_host_commands.push(command);
            }
            if let Some(run_id) = slot.run_id.take() {
                queue_retiring_preview_run(&mut slot, run_id);
            }
            #[cfg(any(target_os = "windows", test))]
            {
                slot.d3d11_compositor_suspension = None;
                slot.d3d11_presenter_configuration = None;
            }

            let now = Utc::now().to_rfc3339();
            let message = if capture_active {
                "Native preview surface attached while recording; compositor ownership stays with the recording."
            } else {
                match &source {
                    PreviewSurfaceSource::Camera => {
                        "Electron proof camera preview surface running."
                    }
                    PreviewSurfaceSource::Screen => {
                        "Electron proof screen preview surface running."
                    }
                    PreviewSurfaceSource::Window => {
                        "Electron proof window preview surface running."
                    }
                    PreviewSurfaceSource::Synthetic => {
                        "Synthetic Electron proof preview surface running."
                    }
                }
            };
            let mut next = PreviewSurfaceStatus {
                state: PreviewSurfaceState::Live,
                source,
                transport: PreviewTransport::ElectronProofSurface,
                backing: PreviewSurfaceBacking::ElectronBrowserWindow,
                target_fps,
                width: surface_render_dimension(bounds.width, bounds.scale_factor),
                height: surface_render_dimension(bounds.height, bounds.scale_factor),
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
                pending_host_command_count: 0,
                bounds: Some(bounds.clone()),
                windows_d3d11_presenter: None,
                started_at: Some(now.clone()),
                updated_at: now,
                message: Some(message.to_string()),
            };
            let host_update = slot.native_host.create(&bounds);
            apply_native_host_update(
                &mut next,
                &mut slot.pending_native_host_commands,
                host_update,
            );
            next.pending_host_command_count = pending_host_command_count(&slot);
            slot.status = next.clone();
            false
        }
    };

    if reused {
        register_preview_surface_resize(&state).await;
    }
    reconcile_live_preview_compositor_with_hook(&state, before_compositor_action).await;
    let response = emit_current_preview_surface_status(&state).await;
    Ok(response)
}

pub async fn update_preview_surface_bounds(
    state: &AppState,
    params: PreviewSurfaceBoundsParams,
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    update_preview_surface_bounds_with_reconcile_hook(state, params, |_| {}).await
}

async fn update_preview_surface_bounds_with_reconcile_hook(
    state: &AppState,
    params: PreviewSurfaceBoundsParams,
    before_compositor_action: impl FnMut(PreviewCompositorReconcilePoint),
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    {
        let _lifecycle = acquire_preview_surface_lifecycle(state).await?;
        let mut slot = state.preview_surface.lock().await;
        slot.lifecycle_revision = slot.lifecycle_revision.saturating_add(1);
        let mut next = slot.status.clone();
        next.width = surface_render_dimension(params.bounds.width, params.bounds.scale_factor);
        next.height = surface_render_dimension(params.bounds.height, params.bounds.scale_factor);
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
    }

    register_preview_surface_resize(state).await;
    reconcile_live_preview_compositor_with_hook(state, before_compositor_action).await;
    let response = emit_current_preview_surface_status(state).await;
    Ok(response)
}

pub async fn destroy_preview_surface(
    state: &AppState,
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    destroy_preview_surface_with_reconcile_hook(state, |_| {}).await
}

async fn destroy_preview_surface_with_reconcile_hook(
    state: &AppState,
    mut before_compositor_action: impl FnMut(PreviewCompositorReconcilePoint),
) -> Result<PreviewSurfaceStatus, PreviewSurfaceBusy> {
    let lifecycle_revision = {
        let _lifecycle = acquire_preview_surface_lifecycle(state).await?;
        let mut slot = state.preview_surface.lock().await;
        slot.lifecycle_revision = slot.lifecycle_revision.saturating_add(1);
        let lifecycle_revision = slot.lifecycle_revision;
        let had_surface = slot.run_id.is_some()
            || matches!(
                slot.status.state,
                PreviewSurfaceState::Starting | PreviewSurfaceState::Live
            );
        let host_update = slot.native_host.destroy();
        if had_surface && let Some(command) = host_update.command {
            slot.pending_native_host_commands.push(command);
        }
        #[cfg(any(target_os = "windows", test))]
        {
            slot.d3d11_compositor_suspension = None;
            slot.d3d11_presenter_configuration = None;
        }
        if let Some(run_id) = slot.run_id.take() {
            queue_retiring_preview_run(&mut slot, run_id);
        }
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
        if next.native_preview_iosurface_import_live_count.is_some()
            || next.native_preview_iosurface_import_peak_count.is_some()
            || next.native_preview_iosurface_import_ceiling.is_some()
        {
            next.native_preview_iosurface_import_live_count = Some(0);
        }
        next.frame_polling_suppressed = false;
        next.source_pixels_present = false;
        next.pending_host_command_count = pending_host_command_count(&slot);
        next.started_at = None;
        next.updated_at = Utc::now().to_rfc3339();
        next.message = Some("Native preview surface stopped.".to_string());
        slot.main_owned_bounds = None;
        slot.main_owned_host_bounds = None;
        slot.status = next.clone();
        lifecycle_revision
    };

    reconcile_live_preview_compositor_with_hook(state, &mut before_compositor_action).await;
    before_compositor_action(PreviewCompositorReconcilePoint::BeforeDestroyDiagnostics {
        lifecycle_revision,
    });
    let diagnostic_stats = {
        // Keep the lifecycle fence through the diagnostics publication. A
        // newer create/update therefore either happens before this exact
        // revision check (and suppresses the stale reset) or after the reset
        // and publishes newer Live diagnostics in order.
        let _lifecycle = state.preview_surface_lifecycle.lock().await;
        let current_status = {
            let slot = state.preview_surface.lock().await;
            if slot.lifecycle_revision != lifecycle_revision
                || slot.status.state != PreviewSurfaceState::Stopped
            {
                None
            } else {
                Some(slot.status.clone())
            }
        };
        if let Some(current_status) = current_status {
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
            next.native_preview_iosurface_import_live_count =
                current_status.native_preview_iosurface_import_live_count;
            next.native_preview_iosurface_import_peak_count =
                current_status.native_preview_iosurface_import_peak_count;
            next.native_preview_iosurface_import_ceiling =
                current_status.native_preview_iosurface_import_ceiling;
            next.preview_repeated_frames = 0;
            next.preview_latency_ms = None;
            next.preview_dropped_frames = 0;
            next.updated_at = Utc::now().to_rfc3339();
            *diagnostics = next.clone();
            state.emit_event(
                "diagnostics.stats",
                apply_runtime_diagnostics_snapshot(next.clone(), state.ffmpeg_work.snapshot()),
            );
            Some(next)
        } else {
            None
        }
    };
    if diagnostic_stats.is_none() {
        return Ok(emit_current_preview_surface_status(state).await);
    }
    Ok(emit_current_preview_surface_status(state).await)
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
        next.native_preview_iosurface_import_live_count =
            params.native_preview_iosurface_import_live_count;
        next.native_preview_iosurface_import_peak_count =
            params.native_preview_iosurface_import_peak_count;
        next.native_preview_iosurface_import_ceiling =
            params.native_preview_iosurface_import_ceiling;
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

/// Mirrors every backend presenter transition into renderer-safe preview
/// status. Canonical D3D identifiers are claimed only after the presenter
/// contract proves a live source and first successful present.
#[cfg(target_os = "windows")]
pub async fn begin_windows_d3d11_presenter_configuration(
    state: &AppState,
    media_generation: u64,
    preview_generation: u64,
) -> Result<(), String> {
    let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
    let mut slot = state.preview_surface.lock().await;
    validate_windows_d3d11_presenter_update_identity(
        media_generation,
        Some(preview_generation),
        slot.main_owned_generation,
    )?;
    if slot.status.state != PreviewSurfaceState::Live {
        return Err("Windows D3D11 presenter configuration requires a live preview surface".into());
    }
    slot.d3d11_presenter_configuration = Some((media_generation, preview_generation));
    Ok(())
}

#[cfg(target_os = "windows")]
pub async fn cancel_windows_d3d11_presenter_configuration(
    state: &AppState,
    media_generation: u64,
    preview_generation: u64,
) {
    let _surface_lifecycle = state.preview_surface_lifecycle.lock().await;
    let mut slot = state.preview_surface.lock().await;
    if slot.d3d11_presenter_configuration == Some((media_generation, preview_generation)) {
        slot.d3d11_presenter_configuration = None;
    }
}

#[cfg(any(target_os = "windows", test))]
fn validate_windows_d3d11_presenter_update_identity(
    media_generation: u64,
    preview_generation: Option<u64>,
    main_owned_generation: Option<u64>,
) -> Result<(u64, u64), String> {
    let preview_generation = preview_generation
        .filter(|generation| *generation != 0)
        .ok_or_else(|| {
            "Windows D3D11 presenter update requires a nonzero preview generation".to_string()
        })?;
    if media_generation == 0 {
        return Err("Windows D3D11 presenter update requires a nonzero media generation".into());
    }
    if main_owned_generation != Some(preview_generation) {
        return Err(format!(
            "stale Windows D3D11 presenter update for preview generation {preview_generation}; current main-owned generation is {main_owned_generation:?}"
        ));
    }
    Ok((media_generation, preview_generation))
}

#[cfg(any(target_os = "windows", test))]
fn validate_windows_d3d11_presenter_configuration_authority(
    identity: (u64, u64),
    configured_identity: Option<(u64, u64)>,
) -> Result<(), String> {
    if configured_identity != Some(identity) {
        return Err(format!(
            "Windows D3D11 presenter update {identity:?} has no current configuration authority"
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub async fn update_windows_d3d11_presenter_status(
    state: &AppState,
    presenter: WindowsD3d11PresenterStatus,
) -> Result<PreviewSurfaceStatus, String> {
    let surface_lifecycle = state.preview_surface_lifecycle.lock().await;
    let status = {
        let mut slot = state.preview_surface.lock().await;
        let identity = validate_windows_d3d11_presenter_update_identity(
            presenter.diagnostics.media_generation,
            presenter.diagnostics.preview_generation,
            slot.main_owned_generation,
        )?;
        validate_windows_d3d11_presenter_configuration_authority(
            identity,
            slot.d3d11_presenter_configuration,
        )?;
        let mut next = slot.status.clone();
        next.windows_d3d11_presenter = Some(presenter.diagnostics.clone());
        if presenter.canonical_claim_ready {
            let presented_frame_id = presenter
                .diagnostics
                .last_presented_sequence
                .unwrap_or(presenter.diagnostics.successful_presents);
            next.transport = PreviewTransport::D3d11SharedTexture;
            next.backing = PreviewSurfaceBacking::DirectcompositionSwapChain;
            next.presented_frame_id = Some(presented_frame_id);
            next.frames_rendered = next.frames_rendered.max(presented_frame_id);
            next.frame_polling_suppressed = true;
            next.source_pixels_present = true;
            next.message =
                Some("Backend D3D11 DirectComposition preview is presenting.".to_string());
        } else {
            next.transport = PreviewTransport::ElectronProofSurface;
            next.backing = PreviewSurfaceBacking::ElectronBrowserWindow;
            next.frame_polling_suppressed = false;
            next.source_pixels_present = false;
            next.message = Some(format!(
                "Windows native preview is using the Electron proof fallback: {}.",
                presenter
                    .diagnostics
                    .fallback_reason
                    .as_deref()
                    .unwrap_or("waiting-first-present")
            ));
        }
        next.updated_at = Utc::now().to_rfc3339();
        slot.status = next.clone();
        next
    };
    drop(surface_lifecycle);
    emit_preview_surface_present_diagnostics(state, &status).await;
    state.emit_event("preview.surface.status", status.clone());
    Ok(status)
}

#[cfg(target_os = "windows")]
pub async fn trusted_windows_d3d11_preview_placement(
    state: &AppState,
    media_generation: u64,
    adapter_luid: DxgiAdapterLuid,
) -> Result<WindowsD3d11PreviewPlacement, String> {
    let trusted_bounds = state
        .preview_surface
        .lock()
        .await
        .main_owned_host_bounds
        .clone()
        .ok_or_else(|| {
            "Electron main has not supplied trusted Windows preview bounds".to_string()
        })?;
    WindowsD3d11PreviewPlacement::from_trusted_host_bounds(
        media_generation,
        adapter_luid,
        &trusted_bounds,
    )
}

#[cfg(any(target_os = "windows", test))]
fn validate_windows_d3d11_presenter_teardown_identity(
    media_generation: u64,
    preview_generation: u64,
    main_owned_generation: Option<u64>,
    presenter: Option<&crate::protocol::WindowsD3d11PresenterDiagnostics>,
) -> Result<(), String> {
    if media_generation == 0 || preview_generation == 0 {
        return Err(
            "Windows D3D11 presenter teardown requires nonzero media and preview generations"
                .to_string(),
        );
    }
    if main_owned_generation != Some(preview_generation) {
        return Err(format!(
            "stale Windows D3D11 presenter teardown for preview generation {preview_generation}; current main-owned generation is {main_owned_generation:?}"
        ));
    }
    let presenter = presenter.ok_or_else(|| {
        "Windows D3D11 presenter teardown requires an existing presenter identity".to_string()
    })?;
    if presenter.media_generation != media_generation
        || presenter.preview_generation != Some(preview_generation)
    {
        return Err(format!(
            "stale Windows D3D11 presenter teardown for media/preview generation {media_generation}/{preview_generation}; current presenter identity is {}/{:?}",
            presenter.media_generation, presenter.preview_generation
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
pub async fn teardown_windows_d3d11_presenter_status(
    state: &AppState,
    media_generation: u64,
    preview_generation: u64,
    fallback_reason: impl Into<String>,
) -> Result<PreviewSurfaceStatus, String> {
    let fallback_reason = fallback_reason.into();
    let surface_lifecycle = state.preview_surface_lifecycle.lock().await;
    let status = {
        let mut slot = state.preview_surface.lock().await;
        if !matches!(
            slot.status.state,
            PreviewSurfaceState::Starting | PreviewSurfaceState::Live
        ) {
            return Err(format!(
                "Windows D3D11 presenter teardown requires an active preview surface, found {:?}",
                slot.status.state
            ));
        }
        validate_windows_d3d11_presenter_teardown_identity(
            media_generation,
            preview_generation,
            slot.main_owned_generation,
            slot.status.windows_d3d11_presenter.as_ref(),
        )?;
        slot.d3d11_presenter_configuration = None;
        let mut next = slot.status.clone();
        let diagnostics = next
            .windows_d3d11_presenter
            .as_mut()
            .expect("the exact presenter identity was just validated");
        diagnostics.source_live = false;
        diagnostics.first_present_succeeded = false;
        diagnostics.fallback_reason = Some(fallback_reason.clone());
        next.transport = PreviewTransport::ElectronProofSurface;
        next.backing = PreviewSurfaceBacking::ElectronBrowserWindow;
        next.frame_polling_suppressed = false;
        next.source_pixels_present = false;
        next.message = Some(format!(
            "Windows native preview presenter stopped; Electron proof fallback is active: {fallback_reason}."
        ));
        next.updated_at = Utc::now().to_rfc3339();
        slot.status = next.clone();
        next
    };
    drop(surface_lifecycle);
    emit_preview_surface_present_diagnostics(state, &status).await;
    state.emit_event("preview.surface.status", status.clone());
    Ok(status)
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

fn queue_retiring_preview_run(slot: &mut PreviewSurfaceRuntime, run_id: String) {
    if !slot.retiring_run_ids.iter().any(|queued| queued == &run_id) {
        slot.retiring_run_ids.push(run_id);
    }
}

/// Attempt one bounded exact-run retirement. A compositor stop timeout keeps
/// the worker handle installed and marks the compositor Failed, so absence of
/// the exact run ID—not the stop call's return value—is the commit proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewRetirementAttempt {
    Retired,
    InProgress,
    Retained,
}

async fn try_retire_preview_run(state: &AppState, run_id: &str) -> PreviewRetirementAttempt {
    let stop_lane = {
        let slot = state.preview_surface.lock().await;
        if !slot.retiring_run_ids.iter().any(|queued| queued == run_id) {
            return PreviewRetirementAttempt::Retired;
        }
        slot.retirement_stop_lane.clone()
    };
    let Ok(_stop_lane) = stop_lane.try_lock_owned() else {
        return PreviewRetirementAttempt::InProgress;
    };
    // Debt may have cleared while this attempt was waiting to claim the lane.
    if !state
        .preview_surface
        .lock()
        .await
        .retiring_run_ids
        .iter()
        .any(|queued| queued == run_id)
    {
        return PreviewRetirementAttempt::Retired;
    }

    let _ = stop_compositor_if_run_id(state, run_id).await;
    let exact_run_absent = crate::compositor::compositor_status(state)
        .await
        .run_id
        .as_deref()
        != Some(run_id);
    let mut slot = state.preview_surface.lock().await;
    if exact_run_absent {
        slot.retiring_run_ids.retain(|queued| queued != run_id);
        if slot.run_id.as_deref() == Some(run_id) {
            slot.run_id = None;
        }
        PreviewRetirementAttempt::Retired
    } else {
        PreviewRetirementAttempt::Retained
    }
}

/// A foreground surface RPC performs at most one bounded stop attempt. If the
/// worker misses that deadline, this process-owned task retries with bounded
/// backoff while the retained debt blocks any overlapping successor run.
async fn claim_preview_retirement_retry(state: &AppState) -> bool {
    let mut slot = state.preview_surface.lock().await;
    if slot.retiring_run_ids.is_empty() || slot.retirement_retry_scheduled {
        false
    } else {
        slot.retirement_retry_scheduled = true;
        true
    }
}

fn spawn_preview_retirement_retry(retry_state: AppState) {
    tokio::spawn(async move {
        let mut resolved = false;
        for delay in [
            std::time::Duration::from_millis(100),
            std::time::Duration::from_millis(250),
            std::time::Duration::from_millis(500),
        ] {
            tokio::time::sleep(delay).await;
            // Contention with another exact-run stop is not a failed retry.
            // Let that bounded attempt publish its result before consuming this
            // backoff slot, otherwise several reconcilers can exhaust every
            // retry while the first stop is still legitimately awaiting its
            // worker deadline.
            loop {
                let run_id = {
                    retry_state
                        .preview_surface
                        .lock()
                        .await
                        .retiring_run_ids
                        .first()
                        .cloned()
                };
                let Some(run_id) = run_id else {
                    resolved = true;
                    break;
                };
                match try_retire_preview_run(&retry_state, &run_id).await {
                    PreviewRetirementAttempt::Retired => {
                        resolved = retry_state
                            .preview_surface
                            .lock()
                            .await
                            .retiring_run_ids
                            .is_empty();
                        break;
                    }
                    PreviewRetirementAttempt::Retained => break,
                    PreviewRetirementAttempt::InProgress => {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                }
            }
            if resolved {
                break;
            }
        }

        {
            let mut slot = retry_state.preview_surface.lock().await;
            slot.retirement_retry_scheduled = false;
            resolved = resolved || slot.retiring_run_ids.is_empty();
        }
        if resolved {
            reconcile_live_preview_compositor(&retry_state).await;
        } else {
            let message = "Native preview compositor retirement still owns an exact run after bounded retries; a successor remains blocked to prevent overlapping workers.";
            retry_state.emit_log("error", message);
            let _ = crate::recording::emit_health_event(
                &retry_state,
                None,
                crate::protocol::HealthLevel::Error,
                "preview-compositor-retirement-timeout",
                message,
            );
        }
    });
}

/// Status replies and their matching surface events are serialized with the
/// short lifecycle transaction. A superseded request therefore reports the
/// current surface and may emit a duplicate current event, but can never
/// publish its captured older state after a newer request.
async fn emit_current_preview_surface_status(state: &AppState) -> PreviewSurfaceStatus {
    let _lifecycle = state.preview_surface_lifecycle.lock().await;
    let status = state.preview_surface.lock().await.status.clone();
    state.emit_event("preview.surface.status", status.clone());
    status
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum PreviewCompositorReconcilePoint {
    BeforeDestroyDiagnostics {
        lifecycle_revision: u64,
    },
    BeforeStop {
        run_id: String,
    },
    BeforeResize {
        lifecycle_revision: u64,
        run_id: String,
        width: u32,
        height: u32,
    },
    AfterResize {
        lifecycle_revision: u64,
        run_id: String,
        width: u32,
        height: u32,
    },
    BeforeStart {
        lifecycle_revision: u64,
        width: u32,
        height: u32,
    },
    AfterStartBeforeAdopt {
        lifecycle_revision: u64,
        run_id: String,
    },
}

/// Bring the latest desired surface revision into agreement with the global
/// preview compositor. This is deliberately a convergence loop rather than a
/// one-shot continuation for the caller's captured revision: an older
/// stop/start finishing late helps the newest create/update complete instead
/// of abandoning a live surface without a run.
async fn reconcile_live_preview_compositor(state: &AppState) {
    reconcile_live_preview_compositor_with_hook(state, |_| {}).await;
}

async fn reconcile_live_preview_compositor_with_hook(
    state: &AppState,
    mut before_compositor_action: impl FnMut(PreviewCompositorReconcilePoint),
) {
    let mut convergence_iterations = 0_u16;
    loop {
        convergence_iterations = convergence_iterations.saturating_add(1);
        if convergence_iterations > 256 {
            let compositor = crate::compositor::compositor_status(state).await;
            let surface = state.preview_surface.lock().await;
            let message = format!(
                "Native preview reconciliation did not converge after 256 state transitions (surface revision {}, state {:?}, run {:?}; compositor state {:?}, run {:?}).",
                surface.lifecycle_revision,
                surface.status.state,
                surface.run_id,
                compositor.state,
                compositor.run_id,
            );
            drop(surface);
            state.emit_log("error", message.clone());
            let _ = crate::recording::emit_health_event(
                state,
                None,
                crate::protocol::HealthLevel::Error,
                "preview-surface-reconciliation-exhausted",
                &message,
            );
            return;
        }
        // Superseded runs are process-owned cleanup debt. Any overlapping
        // reconciler may drain it, but every stop remains exact-run fenced.
        let retiring_run_id = {
            let slot = state.preview_surface.lock().await;
            slot.retiring_run_ids.first().cloned()
        };
        if let Some(run_id) = retiring_run_id {
            before_compositor_action(PreviewCompositorReconcilePoint::BeforeStop {
                run_id: run_id.clone(),
            });
            let still_retiring = {
                let slot = state.preview_surface.lock().await;
                slot.retiring_run_ids.iter().any(|queued| queued == &run_id)
            };
            if !still_retiring {
                continue;
            }
            match try_retire_preview_run(state, &run_id).await {
                PreviewRetirementAttempt::Retired => continue,
                PreviewRetirementAttempt::InProgress | PreviewRetirementAttempt::Retained => {}
            }
            if claim_preview_retirement_retry(state).await {
                spawn_preview_retirement_retry(state.clone());
            }
            return;
        }

        let compositor = crate::compositor::compositor_status(state).await;
        let (lifecycle_revision, status, surface_run_id, suspended, retirement_appeared) = {
            let slot = state.preview_surface.lock().await;
            (
                slot.lifecycle_revision,
                slot.status.clone(),
                slot.run_id.clone(),
                preview_compositor_is_suspended(&slot),
                !slot.retiring_run_ids.is_empty(),
            )
        };
        if retirement_appeared {
            continue;
        }
        let global_preview_run_id = (compositor.frame_pipeline.consumer.as_deref()
            == Some("native-preview"))
        .then(|| compositor.run_id.clone())
        .flatten();
        let global_live_preview_run_id = (compositor.state == CompositorState::Live)
            .then(|| global_preview_run_id.clone())
            .flatten();

        if status.state != PreviewSurfaceState::Live {
            let mut slot = state.preview_surface.lock().await;
            if slot.lifecycle_revision != lifecycle_revision
                || slot.status.state == PreviewSurfaceState::Live
            {
                continue;
            }
            if let Some(run_id) = slot.run_id.take() {
                queue_retiring_preview_run(&mut slot, run_id);
            }
            if let Some(run_id) = global_preview_run_id {
                queue_retiring_preview_run(&mut slot, run_id);
            }
            if slot.retiring_run_ids.is_empty() {
                return;
            }
            continue;
        }

        // D3D11 owns preview production while this reservation is present;
        // its exact generation restores the CPU compositor when it releases.
        if suspended {
            return;
        }

        if capture_owns_compositor(state) {
            let mut slot = state.preview_surface.lock().await;
            if slot.lifecycle_revision != lifecycle_revision
                || slot.status.state != PreviewSurfaceState::Live
            {
                continue;
            }
            if let Some(run_id) = slot.run_id.take() {
                queue_retiring_preview_run(&mut slot, run_id);
            }
            if let Some(run_id) = global_preview_run_id {
                queue_retiring_preview_run(&mut slot, run_id);
            }
            if slot.retiring_run_ids.is_empty() {
                return;
            }
            continue;
        }

        if let Some(run_id) = surface_run_id {
            if global_live_preview_run_id.as_deref() != Some(run_id.as_str()) {
                let mut slot = state.preview_surface.lock().await;
                if slot.lifecycle_revision == lifecycle_revision
                    && slot.run_id.as_deref() == Some(run_id.as_str())
                {
                    slot.run_id = None;
                    if global_preview_run_id.as_deref() == Some(run_id.as_str()) {
                        queue_retiring_preview_run(&mut slot, run_id);
                    }
                }
                continue;
            }
            if compositor.target_fps != status.target_fps {
                let mut slot = state.preview_surface.lock().await;
                if slot.lifecycle_revision == lifecycle_revision
                    && slot.run_id.as_deref() == Some(run_id.as_str())
                {
                    slot.run_id = None;
                    queue_retiring_preview_run(&mut slot, run_id);
                }
                continue;
            }

            before_compositor_action(PreviewCompositorReconcilePoint::BeforeResize {
                lifecycle_revision,
                run_id: run_id.clone(),
                width: status.width,
                height: status.height,
            });

            // The hook represents any slow external scheduling gap. Re-read
            // both owners afterwards; the resize function then repeats the
            // surface check synchronously while holding compositor ownership.
            let checked_compositor = crate::compositor::compositor_status(state).await;
            let resize_still_current = {
                let slot = state.preview_surface.lock().await;
                slot.permits_compositor_resize(
                    lifecycle_revision,
                    &run_id,
                    status.width,
                    status.height,
                )
            } && checked_compositor.run_id.as_deref()
                == Some(run_id.as_str())
                && checked_compositor.frame_pipeline.consumer.as_deref() == Some("native-preview")
                && checked_compositor.target_fps == status.target_fps
                && !capture_owns_compositor(state);
            if !resize_still_current {
                continue;
            }

            let resized = resize_preview_compositor_if_run_id_at_revision(
                state,
                &run_id,
                lifecycle_revision,
                status.width,
                status.height,
            )
            .await;
            before_compositor_action(PreviewCompositorReconcilePoint::AfterResize {
                lifecycle_revision,
                run_id: run_id.clone(),
                width: status.width,
                height: status.height,
            });

            let latest_compositor = crate::compositor::compositor_status(state).await;
            let converged = resized.is_some()
                && latest_compositor.run_id.as_deref() == Some(run_id.as_str())
                && latest_compositor.state == CompositorState::Live
                && latest_compositor.frame_pipeline.consumer.as_deref() == Some("native-preview")
                && latest_compositor.target_fps == status.target_fps
                && latest_compositor.width == status.width
                && latest_compositor.height == status.height
                && {
                    let slot = state.preview_surface.lock().await;
                    slot.permits_compositor_resize(
                        lifecycle_revision,
                        &run_id,
                        status.width,
                        status.height,
                    )
                };
            if converged {
                return;
            }
            tokio::task::yield_now().await;
            continue;
        }

        if let Some(run_id) = global_preview_run_id {
            let mut slot = state.preview_surface.lock().await;
            if slot.lifecycle_revision != lifecycle_revision
                || slot.status.state != PreviewSurfaceState::Live
                || slot.run_id.is_some()
                || !slot.retiring_run_ids.is_empty()
                || preview_compositor_is_suspended(&slot)
            {
                continue;
            }
            if compositor.state != CompositorState::Live
                || compositor.target_fps != slot.status.target_fps
            {
                queue_retiring_preview_run(&mut slot, run_id);
            } else {
                // A concurrent starter publishes globally before it can
                // install into the surface slot. Adopt that exact preview run
                // and let the next iteration resize it to the latest revision.
                slot.run_id = Some(run_id);
            }
            continue;
        }

        // Never adopt, resize, or stop recording/stream compositor runs.
        if compositor.run_id.is_some() {
            return;
        }

        before_compositor_action(PreviewCompositorReconcilePoint::BeforeStart {
            lifecycle_revision,
            width: status.width,
            height: status.height,
        });
        let checked_compositor = crate::compositor::compositor_status(state).await;
        let start_still_current =
            checked_compositor.run_id.is_none() && !capture_owns_compositor(state) && {
                let slot = state.preview_surface.lock().await;
                slot.lifecycle_revision == lifecycle_revision
                    && slot.status.state == PreviewSurfaceState::Live
                    && slot.status.target_fps == status.target_fps
                    && slot.status.width == status.width
                    && slot.status.height == status.height
                    && slot.run_id.is_none()
                    && slot.retiring_run_ids.is_empty()
                    && !preview_compositor_is_suspended(&slot)
            };
        if !start_still_current {
            continue;
        }

        let started_run_id = start_synthetic_compositor_if_idle(
            state.clone(),
            CompositorStartParams {
                target_fps: status.target_fps,
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
        .await
        .and_then(|status| status.run_id);
        if let Some(run_id) = started_run_id.as_ref() {
            before_compositor_action(PreviewCompositorReconcilePoint::AfterStartBeforeAdopt {
                lifecycle_revision,
                run_id: run_id.clone(),
            });
        }
        // Never install from the captured pre-start surface. Re-enter via the
        // global-run adoption branch, which reads the latest desired revision.
        if started_run_id.is_none()
            && crate::compositor::compositor_status(state)
                .await
                .run_id
                .is_none()
        {
            return;
        }
    }
}

fn preview_compositor_is_suspended(slot: &PreviewSurfaceRuntime) -> bool {
    #[cfg(any(target_os = "windows", test))]
    {
        slot.d3d11_compositor_suspension.is_some()
    }
    #[cfg(not(any(target_os = "windows", test)))]
    {
        let _ = slot;
        false
    }
}

fn capture_owns_compositor(state: &AppState) -> bool {
    let snapshot = state.ffmpeg_work.snapshot();
    snapshot.capture_active || snapshot.capture_waiting > 0
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
        windows_d3d11_presenter,
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
    status.windows_d3d11_presenter = windows_d3d11_presenter;
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
        next.native_preview_iosurface_import_live_count =
            status.native_preview_iosurface_import_live_count;
        next.native_preview_iosurface_import_peak_count =
            status.native_preview_iosurface_import_peak_count;
        next.native_preview_iosurface_import_ceiling =
            status.native_preview_iosurface_import_ceiling;
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

/// Preview canvas dimensions in device pixels. The dock-slot bounds arrive in
/// CSS points; compositing the scene at point size and upscaling to a Retina
/// drawable throws away half the resolution before the present blit can do
/// anything about it. The scale is clamped so a corrupt renderer value cannot
/// balloon the canvas.
fn surface_render_dimension(value: f64, scale_factor: f64) -> u32 {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor.clamp(1.0, 3.0)
    } else {
        1.0
    };
    surface_dimension(value * scale)
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
        native_preview_iosurface_import_live_count: None,
        native_preview_iosurface_import_peak_count: None,
        native_preview_iosurface_import_ceiling: None,
        frame_polling_suppressed: false,
        source_pixels_present: false,
        pending_host_command_count: 0,
        bounds: None,
        windows_d3d11_presenter: None,
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
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::broadcast;

    fn test_state() -> AppState {
        test_state_with_event_capacity(16)
    }

    fn test_state_with_event_capacity(capacity: usize) -> AppState {
        let (events, _) = broadcast::channel(capacity);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn surface_render_dimension_scales_to_device_pixels() {
        // Bounds arrive in CSS points; the canvas must render at device pixels.
        assert_eq!(surface_render_dimension(700.0, 2.0), 1400);
        assert_eq!(surface_render_dimension(700.0, 1.0), 700);
        // Corrupt or missing scale factors fall back to 1x, and runaway
        // values clamp so the canvas cannot balloon.
        assert_eq!(surface_render_dimension(700.0, f64::NAN), 700);
        assert_eq!(surface_render_dimension(700.0, 0.0), 700);
        assert_eq!(surface_render_dimension(700.0, 10.0), 2100);
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

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn windows_d3d11_main_owned_preview_bounds_are_generation_bound_and_redacted() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let first = apply_main_owned_preview_surface_bounds(
            &state,
            MainOwnedPreviewSurfaceBoundsParams {
                bounds: MainOwnedPreviewSurfaceBounds {
                    bounds: bounds(1280.0, 720.0),
                    order_above_window_handle: None,
                },
                generation: 7,
            },
        )
        .await
        .unwrap();
        assert_eq!(first.width, 2560);
        assert_eq!(first.height, 1440);
        assert!(
            serde_json::to_value(&first)
                .unwrap()
                .pointer("/bounds/orderAboveWindowHandle")
                .is_none()
        );

        let stale = apply_main_owned_preview_surface_bounds(
            &state,
            MainOwnedPreviewSurfaceBoundsParams {
                bounds: MainOwnedPreviewSurfaceBounds {
                    bounds: bounds(320.0, 180.0),
                    order_above_window_handle: None,
                },
                generation: 6,
            },
        )
        .await
        .unwrap_err();
        assert!(stale.contains("stale preview generation"));
        assert_eq!(
            state.preview_surface.lock().await.main_owned_generation,
            Some(7)
        );

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
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
        .await
        .expect("preview surface lifecycle available");

        let surface = state.preview_surface.lock().await;
        let last_command_kind = surface.native_host.last_command_kind();
        let drawable_size = surface
            .native_host
            .bounds()
            .map(|bounds| bounds.drawable_size());
        drop(surface);
        let compositor = compositor_status(&state).await;
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.transport, PreviewTransport::ElectronProofSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::ElectronBrowserWindow);
        assert_eq!(status.target_fps, 60);
        assert_eq!(status.width, 1600);
        assert_eq!(status.height, 900);
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
        .await
        .expect("preview surface lifecycle available");
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
                native_preview_iosurface_import_live_count: Some(2),
                native_preview_iosurface_import_peak_count: Some(4),
                native_preview_iosurface_import_ceiling: Some(4),
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
        .await
        .expect("preview surface lifecycle available");

        let second_compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        let stopped = destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        assert_eq!(second_compositor.run_id, first_compositor.run_id);
        assert_eq!(second_compositor.width, 1280);
        assert_eq!(second_compositor.height, 720);
        assert_eq!(duplicate.started_at, first.started_at);
        assert_eq!(duplicate.source, PreviewSurfaceSource::Screen);
        assert_eq!(duplicate.width, 1280);
        assert_eq!(duplicate.height, 720);
        assert_eq!(duplicate.transport, PreviewTransport::NativeSurface);
        assert_eq!(duplicate.backing, PreviewSurfaceBacking::CaMetalLayer);
        assert_eq!(duplicate.presented_frame_id, Some(42));
        assert_eq!(duplicate.frames_rendered, 42);
        assert_eq!(
            duplicate.native_preview_iosurface_import_live_count,
            Some(2)
        );
        assert_eq!(
            duplicate.native_preview_iosurface_import_peak_count,
            Some(4)
        );
        assert_eq!(duplicate.native_preview_iosurface_import_ceiling, Some(4));
        assert_eq!(stopped.native_preview_iosurface_import_live_count, Some(0));
        assert_eq!(stopped.native_preview_iosurface_import_peak_count, Some(4));
        assert_eq!(stopped.native_preview_iosurface_import_ceiling, Some(4));
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
        .await
        .expect("preview surface lifecycle available");
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
        .await
        .expect("preview surface lifecycle available");

        let second_compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
                .expect("preview surface lifecycle available")
            }));
        }
        barrier.wait().await;

        for request in requests {
            let status = request.await.expect("concurrent create task should finish");
            assert_eq!(status.state, PreviewSurfaceState::Live);
        }

        let compositor = compositor_status(&state).await;
        let commands = take_native_preview_host_commands(&state).await;
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");

        let status = update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(640.0, 360.0),
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let resize_count = state.diagnostics.lock().await.preview_surface_resize_count;
        let surface = state.preview_surface.lock().await;
        let last_command_kind = surface.native_host.last_command_kind();
        let drawable_size = surface
            .native_host
            .bounds()
            .map(|bounds| bounds.drawable_size());
        drop(surface);
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        assert_eq!(status.state, PreviewSurfaceState::Live);
        assert_eq!(status.width, 1280);
        assert_eq!(status.height, 720);
        assert_eq!(resize_count, 1);
        assert_eq!(
            last_command_kind,
            Some(NativePreviewHostCommandKind::UpdateBounds)
        );
        assert_eq!(drawable_size, Some((1280.0, 720.0)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn d3d11_suspend_and_restore_progress_while_bounds_reconcile_is_blocked() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let update_state = state.clone();
        let update = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            update_preview_surface_bounds_with_reconcile_hook(
                &update_state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(800.0, 450.0),
                },
                move |point| {
                    if !matches!(point, PreviewCompositorReconcilePoint::BeforeResize { .. }) {
                        return;
                    }
                    if let Some(entered_tx) = entered_tx.take() {
                        let _ = entered_tx.send(());
                    }
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        entered_rx
            .await
            .expect("bounds update reached external compositor reconcile");

        let suspension = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            suspend_preview_compositor_for_d3d11(&state, 91),
        )
        .await;
        let restored = match suspension {
            Ok(Some(suspension)) => {
                tokio::time::timeout(std::time::Duration::from_secs(3), suspension.restore())
                    .await
                    .is_ok()
            }
            _ => false,
        };

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        update
            .await
            .expect("bounds update task joined")
            .expect("bounds update completed");

        assert!(
            restored,
            "D3D11 finalization and preview restore must not wait behind slow bounds reconcile"
        );
        assert!(compositor_status(&state).await.run_id.is_some());
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn blocked_destroy_cleanup_converges_a_newer_create_and_returns_current_status() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let destroy_state = state.clone();
        let destroy = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            destroy_preview_surface_with_reconcile_hook(&destroy_state, move |point| {
                if !matches!(point, PreviewCompositorReconcilePoint::BeforeStop { .. }) {
                    return;
                }
                let Some(entered_tx) = entered_tx.take() else {
                    return;
                };
                let _ = entered_tx.send(());
                let (released, wake) = &*blocked_gate;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
            })
            .await
        });
        entered_rx
            .await
            .expect("destroy reached exact-run compositor cleanup");

        let recreated = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            create_preview_surface(
                state.clone(),
                PreviewSurfaceCreateParams {
                    bounds: bounds(800.0, 450.0),
                    target_fps: 60,
                    source: PreviewSurfaceSource::Screen,
                },
            ),
        )
        .await
        .expect("new create must help drain old cleanup")
        .expect("preview surface lifecycle available");
        assert_eq!(recreated.state, PreviewSurfaceState::Live);
        assert_eq!((recreated.width, recreated.height), (1600, 900));

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let superseded_destroy = destroy
            .await
            .expect("destroy task joined")
            .expect("preview surface lifecycle available");
        assert_eq!(superseded_destroy.state, PreviewSurfaceState::Live);
        assert_eq!(
            (superseded_destroy.width, superseded_destroy.height),
            (1600, 900)
        );

        let compositor = compositor_status(&state).await;
        let surface = state.preview_surface.lock().await;
        assert_eq!(surface.status.state, PreviewSurfaceState::Live);
        assert_eq!(surface.run_id, compositor.run_id);
        assert!(
            surface.run_id.is_some(),
            "a live idle surface must own a run"
        );
        assert!(surface.retiring_run_ids.is_empty());
        drop(surface);
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn superseded_destroy_cannot_reset_newer_live_preview_diagnostics() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let destroy_state = state.clone();
        let destroy = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            destroy_preview_surface_with_reconcile_hook(&destroy_state, move |point| {
                if !matches!(
                    point,
                    PreviewCompositorReconcilePoint::BeforeDestroyDiagnostics { .. }
                ) {
                    return;
                }
                let Some(entered_tx) = entered_tx.take() else {
                    return;
                };
                let _ = entered_tx.send(());
                let (released, wake) = &*blocked_gate;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
            })
            .await
        });
        entered_rx
            .await
            .expect("destroy reached its diagnostics publication fence");

        let recreated = create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(800.0, 450.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Screen,
            },
        )
        .await
        .expect("newer preview create succeeds");
        assert_eq!(recreated.state, PreviewSurfaceState::Live);
        {
            let mut diagnostics = state.diagnostics.lock().await;
            diagnostics.preview_transport = PreviewTransport::ElectronProofSurface;
            diagnostics.preview_target_fps = Some(60.0);
            diagnostics.preview_surface_backing = PreviewSurfaceBacking::ElectronBrowserWindow;
            diagnostics.preview_source_pixels_present = true;
        }

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let stale_reply = destroy
            .await
            .expect("destroy task joined")
            .expect("preview surface lifecycle available");
        assert_eq!(stale_reply.state, PreviewSurfaceState::Live);
        let diagnostics = state.diagnostics.lock().await;
        assert_eq!(
            diagnostics.preview_transport,
            PreviewTransport::ElectronProofSurface
        );
        assert_eq!(diagnostics.preview_target_fps, Some(60.0));
        assert_eq!(
            diagnostics.preview_surface_backing,
            PreviewSurfaceBacking::ElectronBrowserWindow
        );
        assert!(diagnostics.preview_source_pixels_present);
        drop(diagnostics);

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn timed_out_preview_retirement_blocks_overlap_then_auto_heals() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let stubborn = replace_current_compositor_worker_with_non_stopping_for_test(&state).await;

        let stopped = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            destroy_preview_surface(&state),
        )
        .await
        .expect("destroy returns after one bounded exact-run stop attempt")
        .expect("preview surface lifecycle available");
        assert_eq!(stopped.state, PreviewSurfaceState::Stopped);
        assert_eq!(
            compositor_status(&state).await.run_id.as_deref(),
            Some(stubborn.run_id.as_str()),
            "a timed-out worker remains the sole global compositor owner"
        );
        {
            let surface = state.preview_surface.lock().await;
            assert!(surface.run_id.is_none());
            assert_eq!(surface.retiring_run_ids, vec![stubborn.run_id.clone()]);
        }

        let recreated = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            create_preview_surface(
                state.clone(),
                PreviewSurfaceCreateParams {
                    bounds: bounds(800.0, 450.0),
                    target_fps: 60,
                    source: PreviewSurfaceSource::Screen,
                },
            ),
        )
        .await
        .expect("a successor returns without stacking an unbounded stop wait")
        .expect("preview surface lifecycle available");
        assert_eq!(recreated.state, PreviewSurfaceState::Live);
        assert_eq!(
            compositor_status(&state).await.run_id.as_deref(),
            Some(stubborn.run_id.as_str()),
            "the live intent cannot start an overlapping replacement"
        );
        assert!(state.preview_surface.lock().await.run_id.is_none());

        stubborn.release();
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            loop {
                let compositor = compositor_status(&state).await;
                let surface = state.preview_surface.lock().await;
                let converged = compositor.state == CompositorState::Live
                    && compositor.run_id.is_some()
                    && compositor.run_id.as_deref() != Some(stubborn.run_id.as_str())
                    && surface.run_id == compositor.run_id
                    && surface.retiring_run_ids.is_empty();
                drop(surface);
                if converged {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("process-owned retirement retry restores the latest live intent");

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn blocked_old_bounds_never_resize_after_a_newer_revision() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let points = Arc::new(StdMutex::new(Vec::new()));
        let blocked_gate = gate.clone();
        let captured_points = points.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let update_state = state.clone();
        let old_update = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            update_preview_surface_bounds_with_reconcile_hook(
                &update_state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(700.0, 400.0),
                },
                move |point| {
                    captured_points.lock().unwrap().push(point.clone());
                    let PreviewCompositorReconcilePoint::BeforeResize {
                        lifecycle_revision, ..
                    } = point
                    else {
                        return;
                    };
                    let Some(entered_tx) = entered_tx.take() else {
                        return;
                    };
                    let _ = entered_tx.send(lifecycle_revision);
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        let old_revision = entered_rx
            .await
            .expect("old bounds update reached its resize gate");

        let latest = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(900.0, 500.0),
                },
            ),
        )
        .await
        .expect("new bounds must not wait behind old external work")
        .expect("preview surface lifecycle available");
        assert_eq!((latest.width, latest.height), (1800, 1000));

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let superseded = old_update
            .await
            .expect("old bounds task joined")
            .expect("preview surface lifecycle available");
        assert_eq!((superseded.width, superseded.height), (1800, 1000));
        assert!(
            !points.lock().unwrap().iter().any(|point| matches!(
                point,
                PreviewCompositorReconcilePoint::AfterResize {
                    lifecycle_revision,
                    ..
                } if *lifecycle_revision == old_revision
            )),
            "the superseded revision must be rejected before resize"
        );

        let compositor = compositor_status(&state).await;
        assert_eq!((compositor.width, compositor.height), (1800, 1000));
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn superseded_bounds_reply_and_event_never_publish_captured_old_status() {
        let state = test_state_with_event_capacity(256);
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let mut events = state.events.subscribe();

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let old_state = state.clone();
        let old_update = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            update_preview_surface_bounds_with_reconcile_hook(
                &old_state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(700.0, 400.0),
                },
                move |point| {
                    if !matches!(point, PreviewCompositorReconcilePoint::BeforeResize { .. }) {
                        return;
                    }
                    let Some(entered_tx) = entered_tx.take() else {
                        return;
                    };
                    let _ = entered_tx.send(());
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        entered_rx
            .await
            .expect("old bounds update reached its resize gate");

        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(960.0, 540.0),
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let old_reply = old_update
            .await
            .expect("old bounds task joined")
            .expect("preview surface lifecycle available");
        assert_eq!((old_reply.width, old_reply.height), (1920, 1080));

        let mut surface_events = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "preview.surface.status" {
                surface_events.push(
                    serde_json::from_value::<PreviewSurfaceStatus>(event.payload)
                        .expect("preview status event payload"),
                );
            }
        }
        assert!(!surface_events.is_empty());
        assert!(
            surface_events
                .iter()
                .all(|status| (status.width, status.height) == (1920, 1080)),
            "no late event may publish the superseded 1400x800 status: {surface_events:?}"
        );
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn globally_started_preview_is_adopted_when_newer_bounds_win_before_slot_install() {
        let state = test_state();
        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let create_state = state.clone();
        let create = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            create_preview_surface_with_reconcile_hook(
                create_state,
                PreviewSurfaceCreateParams {
                    bounds: bounds(640.0, 360.0),
                    target_fps: 60,
                    source: PreviewSurfaceSource::Synthetic,
                },
                move |point| {
                    let PreviewCompositorReconcilePoint::AfterStartBeforeAdopt { run_id, .. } =
                        point
                    else {
                        return;
                    };
                    let Some(entered_tx) = entered_tx.take() else {
                        return;
                    };
                    let _ = entered_tx.send(run_id);
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        let globally_started_run = entered_rx
            .await
            .expect("preview start published globally before slot adoption");
        assert_eq!(
            compositor_status(&state).await.run_id.as_deref(),
            Some(globally_started_run.as_str())
        );
        {
            let surface = state.preview_surface.lock().await;
            assert_eq!(surface.status.state, PreviewSurfaceState::Live);
            assert!(surface.run_id.is_none());
        }

        let latest = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(800.0, 450.0),
                },
            ),
        )
        .await
        .expect("new bounds reconciler must adopt the globally installed run")
        .expect("preview surface lifecycle available");
        assert_eq!((latest.width, latest.height), (1600, 900));

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let old_create_reply = create
            .await
            .expect("create task joined")
            .expect("preview surface lifecycle available");
        assert_eq!(
            (old_create_reply.width, old_create_reply.height),
            (1600, 900)
        );

        let compositor = compositor_status(&state).await;
        let surface = state.preview_surface.lock().await;
        assert_eq!(
            surface.run_id.as_deref(),
            Some(globally_started_run.as_str())
        );
        assert_eq!(surface.run_id, compositor.run_id);
        assert_eq!((compositor.width, compositor.height), (1600, 900));
        drop(surface);
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn d3d11_restore_started_run_can_be_adopted_by_newer_bounds() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let mut suspension = suspend_preview_compositor_for_d3d11(&state, 51)
            .await
            .expect("live preview owns a suspendable compositor");
        suspension.restored = true;
        drop(suspension);

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let restore_state = state.clone();
        let restore = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            restore_suspended_preview_compositor_on_reservation_with_hook(
                &restore_state,
                51,
                move |point| {
                    let PreviewCompositorReconcilePoint::AfterStartBeforeAdopt { run_id, .. } =
                        point
                    else {
                        return;
                    };
                    let Some(entered_tx) = entered_tx.take() else {
                        return;
                    };
                    let _ = entered_tx.send(run_id);
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        let restore_started_run = entered_rx
            .await
            .expect("D3D11 restore published a global preview run before slot adoption");

        let updated = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(800.0, 450.0),
                },
            ),
        )
        .await
        .expect("newer bounds adopts the globally started restore run")
        .expect("preview surface lifecycle available");
        assert_eq!((updated.width, updated.height), (1600, 900));
        assert_eq!(
            state.preview_surface.lock().await.run_id.as_deref(),
            Some(restore_started_run.as_str())
        );

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        restore
            .await
            .expect("restore task joined")
            .expect("the adopted restore run satisfies the reservation");
        assert_eq!(
            compositor_status(&state).await.run_id.as_deref(),
            Some(restore_started_run.as_str()),
            "the older restore continuation must not stop a run adopted by newer bounds"
        );
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_destroy_retires_a_d3d11_restore_started_before_adoption() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let mut suspension = suspend_preview_compositor_for_d3d11(&state, 52)
            .await
            .expect("live preview owns a suspendable compositor");
        suspension.restored = true;
        drop(suspension);

        let gate = Arc::new((StdMutex::new(false), std::sync::Condvar::new()));
        let blocked_gate = gate.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let restore_state = state.clone();
        let restore = tokio::spawn(async move {
            let mut entered_tx = Some(entered_tx);
            restore_suspended_preview_compositor_on_reservation_with_hook(
                &restore_state,
                52,
                move |point| {
                    if !matches!(
                        point,
                        PreviewCompositorReconcilePoint::AfterStartBeforeAdopt { .. }
                    ) {
                        return;
                    }
                    let Some(entered_tx) = entered_tx.take() else {
                        return;
                    };
                    let _ = entered_tx.send(());
                    let (released, wake) = &*blocked_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                },
            )
            .await
        });
        entered_rx
            .await
            .expect("D3D11 restore reached its pre-adoption gap");

        let stopped = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            destroy_preview_surface(&state),
        )
        .await
        .expect("destroy can retire the unadopted global restore run")
        .expect("preview surface lifecycle available");
        assert_eq!(stopped.state, PreviewSurfaceState::Stopped);
        assert!(compositor_status(&state).await.run_id.is_none());

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        assert_eq!(
            restore.await.expect("restore task joined"),
            Err(PreviewCompositorRestoreSkip::SurfaceChanged)
        );
        assert!(compositor_status(&state).await.run_id.is_none());
        let surface = state.preview_surface.lock().await;
        assert_eq!(surface.status.state, PreviewSurfaceState::Stopped);
        assert!(surface.run_id.is_none());
        assert!(surface.retiring_run_ids.is_empty());
    }

    #[tokio::test]
    async fn d3d11_preview_suspension_restores_only_its_live_surface() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let original_run = compositor_status(&state).await.run_id.unwrap();

        let suspension = suspend_preview_compositor_for_d3d11(&state, 11)
            .await
            .expect("live preview owns a suspendable compositor");
        assert!(compositor_status(&state).await.run_id.is_none());
        assert!(state.preview_surface.lock().await.run_id.is_none());

        suspension.restore().await;
        let restored_run = compositor_status(&state).await.run_id.unwrap();
        assert_ne!(restored_run, original_run);
        assert_eq!(
            state.preview_surface.lock().await.run_id.as_deref(),
            Some(restored_run.as_str())
        );
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test]
    async fn d3d11_preview_restore_never_replaces_a_newer_compositor_run() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let suspension = suspend_preview_compositor_for_d3d11(&state, 11)
            .await
            .expect("live preview owns a suspendable compositor");
        let newer = start_synthetic_compositor(
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

        suspension.restore().await;
        assert_eq!(compositor_status(&state).await.run_id, newer.run_id);
        assert!(state.preview_surface.lock().await.run_id.is_none());
        stop_compositor(&state).await;
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test]
    async fn newer_d3d11_generation_supersedes_suspended_preview_restoration() {
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");

        let retired = suspend_preview_compositor_for_d3d11(&state, 21)
            .await
            .expect("the first D3D11 generation suspends CPU preview");
        let current = suspend_preview_compositor_for_d3d11(&state, 22)
            .await
            .expect("a newer D3D11 generation supersedes the reservation");
        assert!(compositor_status(&state).await.run_id.is_none());

        retired.restore().await;
        assert!(compositor_status(&state).await.run_id.is_none());
        assert_eq!(
            state
                .preview_surface
                .lock()
                .await
                .d3d11_compositor_suspension
                .as_ref()
                .map(|reservation| reservation.media_generation),
            Some(22)
        );

        current.restore().await;
        let restored_run = compositor_status(&state).await.run_id.unwrap();
        assert_eq!(
            state.preview_surface.lock().await.run_id.as_deref(),
            Some(restored_run.as_str())
        );
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test]
    async fn lost_d3d11_reservation_still_restores_a_live_preview_surface() {
        // Windows tester: after stop the preview surface sat with no producer
        // because the restore's early return was silent. A lost reservation
        // must now be reported AND the live, idle surface must get a
        // compositor anyway.
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let suspension = suspend_preview_compositor_for_d3d11(&state, 31)
            .await
            .expect("live preview owns a suspendable compositor");
        assert!(compositor_status(&state).await.run_id.is_none());
        // Simulate the reservation being cleared underneath the suspension.
        state
            .preview_surface
            .lock()
            .await
            .d3d11_compositor_suspension = None;

        suspension.restore().await;

        let restored_run = compositor_status(&state)
            .await
            .run_id
            .expect("fallback starts a compositor for the live surface");
        assert_eq!(
            state.preview_surface.lock().await.run_id.as_deref(),
            Some(restored_run.as_str())
        );
        let logs = state.recent_logs(50);
        assert!(
            logs.iter().any(|log| log.level == "warn"
                && log
                    .message
                    .contains("no suspension reservation exists any more")),
            "skip reason must be logged: {logs:?}"
        );
        assert!(
            logs.iter().any(|log| log.level == "info"
                && log
                    .message
                    .contains("Started a replacement CPU preview compositor")),
            "fallback start must be logged: {logs:?}"
        );
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test]
    async fn stale_d3d11_reservation_on_a_destroyed_surface_does_not_start_a_compositor() {
        // The fallback is for a LIVE surface only: a destroyed surface must
        // stay without a compositor, and the skip is still reported.
        let state = test_state();
        create_preview_surface(
            state.clone(),
            PreviewSurfaceCreateParams {
                bounds: bounds(640.0, 360.0),
                target_fps: 60,
                source: PreviewSurfaceSource::Synthetic,
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let suspension = suspend_preview_compositor_for_d3d11(&state, 41)
            .await
            .expect("live preview owns a suspendable compositor");
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        suspension.restore().await;

        assert!(compositor_status(&state).await.run_id.is_none());
        assert!(state.preview_surface.lock().await.run_id.is_none());
        let logs = state.recent_logs(50);
        assert!(
            logs.iter()
                .any(|log| log.level == "warn" && log.message.contains("generation 41 ended")),
            "skip reason must be logged: {logs:?}"
        );
    }

    #[test]
    fn preview_compositor_restore_skip_codes_are_stable_and_distinct() {
        let skips = [
            PreviewCompositorRestoreSkip::NoReservation,
            PreviewCompositorRestoreSkip::GenerationMismatch { reserved: 9 },
            PreviewCompositorRestoreSkip::SurfaceChanged,
            PreviewCompositorRestoreSkip::CompositorBusy,
            PreviewCompositorRestoreSkip::NoRunId,
            PreviewCompositorRestoreSkip::SurfaceChangedDuringStart,
        ];
        let codes = skips.iter().map(|skip| skip.code()).collect::<Vec<_>>();
        let mut unique = codes.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), codes.len());
        assert!(
            codes
                .iter()
                .all(|code| code.starts_with("preview-compositor-restore-"))
        );
        assert_eq!(
            PreviewCompositorRestoreSkip::GenerationMismatch { reserved: 9 }.message(8),
            "Suspended CPU preview compositor was not restored on its reservation after Windows D3D11 generation 8 ended: D3D11 generation 9 owns the reservation now."
        );
    }

    #[test]
    fn d3d11_presenter_teardown_identity_requires_exact_nonzero_generations() {
        let presenter = crate::protocol::WindowsD3d11PresenterDiagnostics {
            media_generation: 31,
            preview_generation: Some(41),
            ..Default::default()
        };

        assert!(
            validate_windows_d3d11_presenter_teardown_identity(31, 41, Some(41), Some(&presenter))
                .is_ok()
        );
        assert!(
            validate_windows_d3d11_presenter_teardown_identity(0, 41, Some(41), Some(&presenter))
                .is_err()
        );
        assert!(
            validate_windows_d3d11_presenter_teardown_identity(31, 0, Some(41), Some(&presenter))
                .is_err()
        );
        assert!(
            validate_windows_d3d11_presenter_teardown_identity(31, 41, Some(40), Some(&presenter))
                .is_err()
        );
        assert!(
            validate_windows_d3d11_presenter_teardown_identity(30, 41, Some(41), Some(&presenter))
                .is_err()
        );
        assert!(
            validate_windows_d3d11_presenter_teardown_identity(31, 40, Some(40), Some(&presenter))
                .is_err()
        );
    }

    #[test]
    fn d3d11_presenter_update_requires_current_generation_and_configuration_authority() {
        let identity = validate_windows_d3d11_presenter_update_identity(31, Some(41), Some(41))
            .expect("exact nonzero identity is current");
        assert_eq!(identity, (31, 41));
        assert!(
            validate_windows_d3d11_presenter_configuration_authority(identity, Some(identity))
                .is_ok()
        );
        assert!(
            validate_windows_d3d11_presenter_configuration_authority(identity, Some((30, 41)))
                .is_err()
        );
        assert!(validate_windows_d3d11_presenter_configuration_authority(identity, None).is_err());
        assert!(validate_windows_d3d11_presenter_update_identity(0, Some(41), Some(41)).is_err());
        assert!(validate_windows_d3d11_presenter_update_identity(31, Some(0), Some(41)).is_err());
        assert!(validate_windows_d3d11_presenter_update_identity(31, Some(41), Some(42)).is_err());
    }

    #[tokio::test]
    async fn advancing_main_owned_generation_invalidates_old_canonical_presenter() {
        let state = test_state();
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.status.transport = PreviewTransport::D3d11SharedTexture;
            surface.status.backing = PreviewSurfaceBacking::DirectcompositionSwapChain;
            surface.status.frame_polling_suppressed = true;
            surface.status.source_pixels_present = true;
            surface.main_owned_generation = Some(41);
            surface.d3d11_presenter_configuration = Some((31, 41));
            surface.status.windows_d3d11_presenter =
                Some(crate::protocol::WindowsD3d11PresenterDiagnostics {
                    media_generation: 31,
                    preview_generation: Some(41),
                    source_live: true,
                    first_present_succeeded: true,
                    ..Default::default()
                });
        }

        let params = MainOwnedPreviewSurfaceBoundsParams {
            bounds: MainOwnedPreviewSurfaceBounds {
                bounds: bounds(1280.0, 720.0),
                order_above_window_handle: None,
            },
            generation: 42,
        };
        #[cfg(target_os = "windows")]
        let status = {
            let mut surface = state.preview_surface.lock().await;
            apply_validated_main_owned_preview_surface_bounds(&mut surface, params)
        }
        .expect("a newer validated preview generation replaces the old one");
        #[cfg(not(target_os = "windows"))]
        let status = apply_main_owned_preview_surface_bounds(&state, params)
            .await
            .expect("a newer trusted preview generation replaces the old one");

        let presenter = status
            .windows_d3d11_presenter
            .expect("retired presenter diagnostics remain explicit");
        assert!(!presenter.source_live);
        assert!(!presenter.first_present_succeeded);
        assert_eq!(
            presenter.fallback_reason.as_deref(),
            Some("windows-d3d11-preview-generation-superseded")
        );
        assert_eq!(status.transport, PreviewTransport::ElectronProofSurface);
        assert_eq!(status.backing, PreviewSurfaceBacking::ElectronBrowserWindow);
        assert!(!status.frame_polling_suppressed);
        assert!(!status.source_pixels_present);
        assert_eq!(
            state
                .preview_surface
                .lock()
                .await
                .d3d11_presenter_configuration,
            None
        );
        // The non-Windows path exercises the complete reconciliation route,
        // which starts the Electron-proof fallback compositor. Retire it
        // explicitly so dropping this test's Tokio runtime can never wait on
        // a still-live blocking render worker.
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
    }

    #[tokio::test]
    async fn d3d11_presenter_teardown_rejects_stale_identity_without_emitting() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let presenter = crate::protocol::WindowsD3d11PresenterDiagnostics {
            media_generation: 31,
            preview_generation: Some(41),
            source_live: true,
            first_present_succeeded: true,
            ..Default::default()
        };
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.main_owned_generation = Some(41);
            surface.status.windows_d3d11_presenter = Some(presenter);
        }
        let before = state.preview_surface.lock().await.status.clone();

        let error =
            teardown_windows_d3d11_presenter_status(&state, 30, 41, "retired-media-generation")
                .await
                .unwrap_err();

        assert!(error.contains("stale Windows D3D11 presenter teardown"));
        assert_eq!(state.preview_surface.lock().await.status, before);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn d3d11_presenter_teardown_preserves_exact_nonzero_identity() {
        let state = test_state();
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.main_owned_generation = Some(41);
            surface.d3d11_presenter_configuration = Some((31, 41));
            surface.status.windows_d3d11_presenter =
                Some(crate::protocol::WindowsD3d11PresenterDiagnostics {
                    media_generation: 31,
                    preview_generation: Some(41),
                    source_live: true,
                    first_present_succeeded: true,
                    ..Default::default()
                });
        }

        let status =
            teardown_windows_d3d11_presenter_status(&state, 31, 41, "exact-generation-stopped")
                .await
                .expect("the exact current presenter may be torn down");
        let diagnostics = status
            .windows_d3d11_presenter
            .expect("teardown preserves the presenter identity");

        assert_eq!(diagnostics.media_generation, 31);
        assert_eq!(diagnostics.preview_generation, Some(41));
        assert!(!diagnostics.source_live);
        assert!(!diagnostics.first_present_succeeded);
        assert_eq!(
            diagnostics.fallback_reason.as_deref(),
            Some("exact-generation-stopped")
        );
        assert_eq!(
            state
                .preview_surface
                .lock()
                .await
                .d3d11_presenter_configuration,
            None
        );
    }

    #[tokio::test]
    async fn destroyed_surface_rejects_late_exact_presenter_teardown() {
        let state = test_state();
        {
            let mut surface = state.preview_surface.lock().await;
            surface.status.state = PreviewSurfaceState::Live;
            surface.status.transport = PreviewTransport::D3d11SharedTexture;
            surface.status.backing = PreviewSurfaceBacking::DirectcompositionSwapChain;
            surface.main_owned_generation = Some(41);
            surface.d3d11_presenter_configuration = Some((31, 41));
            surface.status.windows_d3d11_presenter =
                Some(crate::protocol::WindowsD3d11PresenterDiagnostics {
                    media_generation: 31,
                    preview_generation: Some(41),
                    source_live: true,
                    first_present_succeeded: true,
                    ..Default::default()
                });
        }

        let destroyed = destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
        assert_eq!(destroyed.state, PreviewSurfaceState::Stopped);
        assert_eq!(destroyed.transport, PreviewTransport::Unavailable);
        assert_eq!(destroyed.backing, PreviewSurfaceBacking::None);

        let error =
            teardown_windows_d3d11_presenter_status(&state, 31, 41, "late-monitor-teardown")
                .await
                .unwrap_err();
        assert!(
            error.contains("requires an active preview surface"),
            "{error}"
        );
        assert_eq!(state.preview_surface.lock().await.status, destroyed);
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
        .await
        .expect("preview surface lifecycle available");

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

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");
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
        .await
        .expect("preview surface lifecycle available");
        let verification = async {
            let initial = wait_for_frame_dimensions_after(&state, 320, 180, None).await?;
            let initial_status = compositor_status(&state).await;

            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(90.0, 160.0),
                },
            )
            .await
            .expect("preview surface lifecycle available");
            let portrait =
                wait_for_frame_dimensions_after(&state, 180, 320, Some(initial.sequence)).await?;

            // The owner's 2026-07-14 regression was this reverse direction:
            // horizontal mode returned while the compositor kept publishing
            // the previous portrait canvas inside the landscape preview.
            update_preview_surface_bounds(
                &state,
                PreviewSurfaceBoundsParams {
                    bounds: bounds(160.0, 90.0),
                },
            )
            .await
            .expect("preview surface lifecycle available");
            let landscape =
                wait_for_frame_dimensions_after(&state, 320, 180, Some(portrait.sequence)).await?;
            let final_status = compositor_status(&state).await;
            Ok::<_, String>((initial_status, portrait, landscape, final_status))
        }
        .await;
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        let (initial_status, portrait, landscape, final_status) =
            verification.expect("preview compositor should follow both orientation changes");
        assert_eq!(portrait.width, 180);
        assert_eq!(portrait.height, 320);
        assert_eq!(landscape.width, 320);
        assert_eq!(landscape.height, 180);
        assert_eq!(final_status.run_id, initial_status.run_id);
        assert_eq!(final_status.width, 320);
        assert_eq!(final_status.height, 180);
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
        .await
        .expect("preview surface lifecycle available");
        wait_for_frame_dimensions_after(&state, 320, 180, None)
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
        .await
        .expect("preview surface lifecycle available");
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
        .await
        .expect("preview surface lifecycle available");
        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(1280.0, 720.0),
            },
        )
        .await
        .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");
        update_preview_surface_bounds(
            &state,
            PreviewSurfaceBoundsParams {
                bounds: bounds(640.0, 360.0),
            },
        )
        .await
        .expect("preview surface lifecycle available");
        let destroyed = destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");

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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: true,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");

        let status = activate_native_preview_host(
            &state,
            NativePreviewHostActivation::cametal_layer_presented(12),
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");
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
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");

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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");

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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let diagnostics = state.diagnostics.lock().await.clone();
        destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

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
        .await
        .expect("preview surface lifecycle available");
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
                native_preview_iosurface_import_live_count: None,
                native_preview_iosurface_import_peak_count: None,
                native_preview_iosurface_import_ceiling: None,
                message: None,
                frame_polling_suppressed: false,
                source_pixels_present: false,
            },
        )
        .await;

        let status = destroy_preview_surface(&state)
            .await
            .expect("preview surface lifecycle available");

        assert_eq!(status.state, PreviewSurfaceState::Stopped);
        assert_eq!(status.transport, PreviewTransport::Unavailable);
        assert_eq!(status.backing, PreviewSurfaceBacking::None);
        assert_eq!(status.started_at, None);
        assert_eq!(status.native_preview_iosurface_import_live_count, None);
        assert_eq!(status.native_preview_iosurface_import_peak_count, None);
        assert_eq!(status.native_preview_iosurface_import_ceiling, None);
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
