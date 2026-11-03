//! Videorc Camera's backend glue (plan 214 A3, A4): the saved switch, the
//! output's lifecycle, the weak lease over the preview run, and the status
//! every surface reads.
//!
//! The pure half (geometry, cadence, converters, the sink trait, the output
//! thread) is `virtual_camera.rs`. This module owns:
//!
//! - the switch in the backend settings store (D4: off by default,
//!   remembered across launches),
//! - starting and stopping the output when the switch flips,
//! - the supervisor task: about twice a second it arms the preview run for
//!   the camera (`CompositorLeaseKind::VirtualCamera`, 1920×1080) while a
//!   viewer holds the camera and no capture holds the run, releases it when
//!   the viewer leaves, and publishes `virtualCamera.changed` on any change,
//! - `virtualCamera.status`, `virtualCamera.set` and
//!   `virtualCamera.platform.report` (what main reports about the extension
//!   or the Windows setup step).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use crate::compositor::{
    CompositorArmParams, CompositorArmRefusal, CompositorFrameConsumer, CompositorLeaseKind,
    arm_compositor_for_capture, release_compositor_capture_lease,
};
use crate::protocol::{VirtualCameraPlatformStep, VirtualCameraStatus};
use crate::state::AppState;
use crate::virtual_camera::{
    OutputEngine, OutputShared, StatusInputs, VIRTUAL_CAMERA_FPS, VIRTUAL_CAMERA_HEIGHT,
    VIRTUAL_CAMERA_LEASE_SESSION_ID, VIRTUAL_CAMERA_SETTING_KEY, VIRTUAL_CAMERA_WIDTH,
    VirtualCameraCountersSnapshot, VirtualCameraOutput, VirtualCameraSink,
    VirtualCameraUnavailable, derive_status, platform_sink,
};

/// The event every change of the status rides.
pub const VIRTUAL_CAMERA_CHANGED_EVENT: &str = "virtualCamera.changed";
/// How often the supervisor reconciles the lease and the status.
const SUPERVISOR_INTERVAL: Duration = Duration::from_millis(500);

/// The saved switch (D4), as stored under `virtualCamera`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualCameraSettings {
    #[serde(default)]
    pub on: bool,
}

pub type SinkFactory =
    Box<dyn Fn() -> Result<Box<dyn VirtualCameraSink>, VirtualCameraUnavailable> + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    on: bool,
    platform: Option<(VirtualCameraPlatformStep, Option<String>)>,
    /// Why this build has no sink (`platform_sink` refused); set when the
    /// switch is turned on and the factory fails, cleared when it succeeds.
    sink_unavailable: Option<VirtualCameraUnavailable>,
    output: Option<VirtualCameraOutput>,
    last_published: Option<VirtualCameraStatus>,
    supervisor_started: bool,
}

/// One per process, on `AppState`.
pub struct VirtualCameraService {
    state: StdMutex<ServiceState>,
    /// `lease_wanted` reads this without the service lock: the compositor's
    /// release path runs under its own locks and must never wait on ours.
    wants_lease: AtomicBool,
    sink_factory: SinkFactory,
    /// Owner, 2026-11-03: a platform whose camera hasn't passed its spike is
    /// hidden from the first status on, switch or no switch. Probed once from
    /// the factory at construction (a hidden refusal is static).
    hidden: Option<VirtualCameraUnavailable>,
    canvas: (u32, u32),
}

impl std::fmt::Debug for VirtualCameraService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VirtualCameraService")
            .field("wants_lease", &self.wants_lease.load(Ordering::Relaxed))
            .field("canvas", &self.canvas)
            .finish()
    }
}

impl Default for VirtualCameraService {
    fn default() -> Self {
        Self::with_sink_factory(
            Box::new(platform_sink),
            (VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT),
        )
    }
}

impl VirtualCameraService {
    /// A service with its own sink and canvas (tests; the dev smokes later).
    pub fn with_sink_factory(sink_factory: SinkFactory, canvas: (u32, u32)) -> Self {
        let hidden = match sink_factory() {
            Err(unavailable) if unavailable.hidden => Some(unavailable),
            // A sink, or a shown refusal: nothing to remember; the switch
            // asks the factory again when it turns on.
            Ok(_) | Err(_) => None,
        };
        Self {
            state: StdMutex::new(ServiceState::default()),
            wants_lease: AtomicBool::new(false),
            sink_factory,
            hidden,
            canvas,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ServiceState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The output's counters for `framePipeline`; `None` while off.
    pub fn counters(&self) -> Option<VirtualCameraCountersSnapshot> {
        self.lock()
            .output
            .as_ref()
            .map(|output| output.shared().counters().snapshot())
    }

    fn status_inputs(&self, state: &ServiceState) -> StatusInputs {
        let shared: Option<Arc<OutputShared>> =
            state.output.as_ref().map(|output| output.shared().clone());
        StatusInputs {
            on: state.on,
            sink: match self.hidden.as_ref().or(state.sink_unavailable.as_ref()) {
                Some(unavailable) => Err(unavailable.clone()),
                None => Ok(()),
            },
            platform: state.platform.clone(),
            health: shared.as_ref().map(|shared| shared.health()),
            viewers: shared.as_ref().and_then(|shared| shared.viewers()),
        }
    }

    /// The status as of now, without publishing it.
    pub fn status(&self) -> VirtualCameraStatus {
        let state = self.lock();
        derive_status(&self.status_inputs(&state))
    }

    /// Whether the camera wants the preview run right now: on, a sink
    /// connected, and a viewer holding the camera (D13).
    fn refresh_wants_lease(&self, state: &ServiceState) -> bool {
        let wants = state.on
            && state.output.as_ref().is_some_and(|output| {
                let shared = output.shared();
                shared.health().connected && shared.demanded()
            });
        self.wants_lease.store(wants, Ordering::Release);
        wants
    }

    /// Tests drive `reconcile_lease` themselves; the supervisor would race.
    #[cfg(test)]
    fn without_supervisor(self) -> Self {
        self.lock().supervisor_started = true;
        self
    }
}

/// Plan 214 A3: the canvas the camera wants the preview run armed at, when it
/// wants it at all. Read by `release_compositor_capture_lease` under the
/// compositor's locks, so it reads one atomic and nothing else.
pub fn lease_wanted(state: &AppState) -> Option<(u32, u32)> {
    let service = &state.virtual_camera;
    service
        .wants_lease
        .load(Ordering::Acquire)
        .then_some(service.canvas)
}

/// Publish the status when it changed since the last publish.
fn publish_if_changed(state: &AppState) -> VirtualCameraStatus {
    let service = &state.virtual_camera;
    let (status, changed) = {
        let mut inner = service.lock();
        let status = derive_status(&service.status_inputs(&inner));
        let changed = inner.last_published.as_ref() != Some(&status);
        if changed {
            inner.last_published = Some(status.clone());
        }
        (status, changed)
    };
    if changed {
        state.emit_event(VIRTUAL_CAMERA_CHANGED_EVENT, status.clone());
    }
    status
}

/// `virtualCamera.status`.
pub fn status(state: &AppState) -> VirtualCameraStatus {
    state.virtual_camera.status()
}

/// At launch (D4): a switch saved on comes back on, with the status it
/// earns now (never a remembered "ready").
pub async fn start_from_settings(state: &AppState) {
    let saved = match state
        .virtual_camera_setting()
        .map_err(|error| error.to_string())
    {
        Ok(settings) => settings,
        Err(error) => {
            tracing::warn!("Could not read the Videorc Camera setting: {error}");
            VirtualCameraSettings::default()
        }
    };
    ensure_supervisor(state);
    if saved.on {
        let status = set_on_without_saving(state, true).await;
        tracing::info!(
            "Videorc Camera comes back on from the saved setting: {:?}",
            status.state
        );
    }
}

/// `virtualCamera.set { on }`: save it (D4), start or stop the output, and
/// answer the status it earns now.
pub async fn set_on(state: &AppState, on: bool) -> Result<VirtualCameraStatus, String> {
    state
        .database
        .save_setting(VIRTUAL_CAMERA_SETTING_KEY, &VirtualCameraSettings { on })
        .map_err(|error| format!("Could not save the Videorc Camera setting: {error}"))?;
    ensure_supervisor(state);
    Ok(set_on_without_saving(state, on).await)
}

async fn set_on_without_saving(state: &AppState, on: bool) -> VirtualCameraStatus {
    let service = &state.virtual_camera;
    if on {
        let pixel_demand = crate::compositor::pixel_demand(state).await;
        let mut inner = service.lock();
        inner.on = true;
        if inner.output.is_none() {
            match (service.sink_factory)() {
                Ok(sink) => {
                    inner.sink_unavailable = None;
                    let compositor = state.compositor.clone();
                    let picker = Box::new(move || {
                        compositor.try_lock().ok().map(|compositor| {
                            crate::compositor::preview_frame_lease::presented_frame_store(
                                &compositor,
                            )
                        })
                    });
                    let engine = OutputEngine::new(
                        sink,
                        picker,
                        pixel_demand,
                        Arc::new(OutputShared::default()),
                    );
                    match VirtualCameraOutput::spawn(engine) {
                        Ok(output) => inner.output = Some(output),
                        Err(error) => {
                            inner.sink_unavailable = Some(VirtualCameraUnavailable::new(format!(
                                "Could not start the Videorc Camera output: {error}"
                            )));
                        }
                    }
                }
                Err(unavailable) => {
                    tracing::warn!("Videorc Camera is unavailable here: {}", unavailable.reason);
                    inner.sink_unavailable = Some(unavailable);
                }
            }
        }
        service.refresh_wants_lease(&inner);
    } else {
        let output = {
            let mut inner = service.lock();
            inner.on = false;
            service.refresh_wants_lease(&inner);
            inner.output.take()
        };
        // Stop outside the service lock: the join waits for the current
        // tick, which may be inside the sink's push.
        if let Some(output) = output {
            output.stop();
        }
        release_camera_lease(state).await;
    }
    publish_if_changed(state)
}

/// `virtualCamera.platform.report`: main's word on the extension or the
/// Windows setup step. The backend never guesses it.
pub fn report_platform(
    state: &AppState,
    step: VirtualCameraPlatformStep,
    message: Option<String>,
) -> VirtualCameraStatus {
    {
        let mut inner = state.virtual_camera.lock();
        inner.platform = Some((step, message));
    }
    publish_if_changed(state)
}

fn camera_arm_params(state: &AppState, canvas: (u32, u32)) -> CompositorArmParams {
    let overlays = crate::compositor::idle_overlay_flags(state);
    CompositorArmParams {
        target_fps: VIRTUAL_CAMERA_FPS,
        width: canvas.0,
        height: canvas.1,
        frame_consumer: CompositorFrameConsumer::NativePreview,
        lease: CompositorLeaseKind::VirtualCamera,
        benchmark: false,
        replay_only: true,
        caption_overlay_on_primary: false,
        caption_overlay_on_aux: false,
        highlight_overlay_on_primary: overlays.highlight_on_primary,
        highlight_overlay_on_aux: overlays.highlight_on_aux,
        buddy_overlay_on_primary: overlays.buddy_on_primary,
        buddy_overlay_on_aux: overlays.buddy_on_aux,
        highlight_overlay_on_program: overlays.highlight_on_program,
        buddy_overlay_on_program: overlays.buddy_on_program,
        chat_overlay_on_primary: overlays.chat_on_primary,
        chat_overlay_on_aux: overlays.chat_on_aux,
        chat_overlay_on_program: overlays.chat_on_program,
    }
}

/// Arm the preview run for the camera when it wants it and nothing holds
/// the run; a capture's `AlreadyLeased` is fine (the camera reads their
/// store, and their release hands the run over). Returns what happened.
pub(crate) async fn reconcile_lease(state: &AppState) -> LeaseReconcile {
    let service = &state.virtual_camera;
    let wants = {
        let inner = service.lock();
        service.refresh_wants_lease(&inner)
    };
    let held = crate::compositor::compositor_virtual_camera_lease_active(state).await;
    match (wants, held) {
        (true, true) | (false, false) => LeaseReconcile::Unchanged,
        (true, false) => {
            let params = camera_arm_params(state, service.canvas);
            match arm_compositor_for_capture(state, VIRTUAL_CAMERA_LEASE_SESSION_ID, params).await {
                Ok(_) => LeaseReconcile::Armed,
                Err(CompositorArmRefusal::AlreadyLeased) => LeaseReconcile::CaptureHoldsTheRun,
                Err(refusal) => LeaseReconcile::NoRun(refusal),
            }
        }
        (false, true) => {
            release_camera_lease(state).await;
            LeaseReconcile::Released
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeaseReconcile {
    Unchanged,
    Armed,
    Released,
    /// A session or Clips holds the run; the camera reads their store.
    CaptureHoldsTheRun,
    NoRun(CompositorArmRefusal),
}

async fn release_camera_lease(state: &AppState) {
    let _ = release_compositor_capture_lease(state, VIRTUAL_CAMERA_LEASE_SESSION_ID).await;
}

fn ensure_supervisor(state: &AppState) {
    let mut inner = state.virtual_camera.lock();
    if inner.supervisor_started {
        return;
    }
    inner.supervisor_started = true;
    drop(inner);
    tokio::spawn(run_supervisor(state.clone()));
}

/// The lease and the status, reconciled twice a second while the process
/// lives. Cheap while off: one atomic and one short lock per pass.
async fn run_supervisor(state: AppState) {
    #[cfg(target_os = "linux")]
    let mut linux_probe = LinuxProbe::default();
    loop {
        tokio::time::sleep(SUPERVISOR_INTERVAL).await;
        let on = state.virtual_camera.lock().on;
        if on {
            let outcome = reconcile_lease(&state).await;
            if let LeaseReconcile::Armed = outcome {
                tracing::info!("Videorc Camera armed the preview run at its canvas");
            }
        }
        #[cfg(target_os = "linux")]
        linux_probe_pass(&state, &mut linux_probe).await;
        publish_if_changed(&state);
    }
}

/// Plan 214 D1: the supervisor's v4l2loopback probe on Linux.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct LinuxProbe {
    next_at: Option<std::time::Instant>,
    memory: crate::virtual_camera_linux::ProbeMemory,
}

/// Plan 214 D1: on Linux the backend probes v4l2loopback itself (main only
/// reports `setting-up` while its `pkexec modprobe` runs, and `failed` when
/// it is refused): once a second until the device is there, every ten
/// seconds after, and never while the camera is hidden (`PROVEN` false).
/// Main's word stands until the box changes (`ProbeMemory`). The caller
/// publishes the change.
#[cfg(target_os = "linux")]
async fn linux_probe_pass(state: &AppState, probe: &mut LinuxProbe) {
    use crate::virtual_camera_linux as linux;
    let now = std::time::Instant::now();
    if !linux::PROVEN || probe.next_at.is_some_and(|at| now < at) {
        return;
    }
    // `modinfo` is a process: off the runtime's threads.
    let Ok(report) = tokio::task::spawn_blocking(linux::platform_report_now).await else {
        return;
    };
    let ready = report.0 == VirtualCameraPlatformStep::Ready;
    probe.next_at = Some(std::time::Instant::now() + linux::next_probe_interval(ready));
    let mut inner = state.virtual_camera.lock();
    if let Some(merged) = probe.memory.merge(inner.platform.as_ref(), report) {
        inner.platform = Some(merged);
    }
}

impl AppState {
    /// The saved switch (D4), off when nothing was saved.
    pub fn virtual_camera_setting(&self) -> anyhow::Result<VirtualCameraSettings> {
        Ok(self
            .database
            .load_setting::<VirtualCameraSettings>(VIRTUAL_CAMERA_SETTING_KEY)?
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compositor::{
        CompositorFrameConsumer, CompositorStartParams, compositor_capture_lease_run_id,
        compositor_status, start_synthetic_compositor, stop_compositor,
    };
    use crate::protocol::VirtualCameraState;
    use crate::storage::Database;
    use crate::virtual_camera::test_support::{FakeSink, FakeSinkState};
    use tokio::sync::broadcast;

    fn test_state_with(service: VirtualCameraService) -> AppState {
        let (events, _) = broadcast::channel(64);
        let mut state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        state.virtual_camera = Arc::new(service);
        state
    }

    fn fake_service(viewers: Option<u32>) -> (VirtualCameraService, Arc<StdMutex<FakeSinkState>>) {
        let shared = Arc::new(StdMutex::new(FakeSinkState {
            viewers,
            ..FakeSinkState::default()
        }));
        let factory_shared = shared.clone();
        let service = VirtualCameraService::with_sink_factory(
            Box::new(move || {
                Ok(Box::new(FakeSink {
                    state: factory_shared.clone(),
                }) as Box<dyn VirtualCameraSink>)
            }),
            (192, 108),
        )
        .without_supervisor();
        (service, shared)
    }

    fn preview_params(width: u32, height: u32) -> CompositorStartParams {
        CompositorStartParams {
            benchmark: false,
            target_fps: 60,
            width,
            height,
            frame_consumer: CompositorFrameConsumer::NativePreview,
            stream_output: None,
            source_iso_output: None,
            caption_overlay_on_primary: false,
            caption_overlay_on_aux: false,
            highlight_overlay_on_primary: false,
            highlight_overlay_on_aux: false,
            buddy_overlay_on_primary: false,
            buddy_overlay_on_aux: false,
            replay_only: false,
            highlight_overlay_on_program: false,
            buddy_overlay_on_program: false,
        }
    }

    fn session_params(width: u32, height: u32, replay_only: bool) -> CompositorArmParams {
        CompositorArmParams {
            benchmark: false,
            target_fps: 30,
            width,
            height,
            frame_consumer: CompositorFrameConsumer::VideoToolboxEncoder,
            lease: CompositorLeaseKind::Capture,
            replay_only,
            caption_overlay_on_primary: false,
            caption_overlay_on_aux: false,
            highlight_overlay_on_primary: false,
            highlight_overlay_on_aux: false,
            buddy_overlay_on_primary: false,
            buddy_overlay_on_aux: false,
            highlight_overlay_on_program: false,
            buddy_overlay_on_program: false,
        }
    }

    async fn wait_until_demanded(state: &AppState) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let demanded = state
                .virtual_camera
                .lock()
                .output
                .as_ref()
                .is_some_and(|output| output.shared().demanded());
            if demanded {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the output never saw a viewer"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn the_switch_is_saved_off_by_default_and_remembered() {
        let (service, _) = fake_service(Some(0));
        let state = test_state_with(service);
        assert_eq!(
            state.virtual_camera_setting().unwrap(),
            VirtualCameraSettings { on: false }
        );
        let status = set_on(&state, true).await.unwrap();
        assert!(status.on);
        assert_eq!(
            state.virtual_camera_setting().unwrap(),
            VirtualCameraSettings { on: true }
        );
        // A second process reads the saved switch and comes back on.
        let (service, _) = fake_service(Some(0));
        let mut relaunched = test_state_with(service);
        relaunched.database = state.database.clone();
        assert!(relaunched.virtual_camera_setting().unwrap().on);
        start_from_settings(&relaunched).await;
        assert!(relaunched.virtual_camera.status().on);
        assert!(relaunched.virtual_camera.lock().output.is_some());
        let off = set_on(&state, false).await.unwrap();
        assert!(!off.on);
        assert_eq!(off.state, VirtualCameraState::Off);
        assert!(state.virtual_camera.lock().output.is_none());
    }

    #[tokio::test]
    async fn a_build_without_a_sink_says_unavailable_and_never_claims_success() {
        let service = VirtualCameraService::with_sink_factory(
            Box::new(|| {
                Err(VirtualCameraUnavailable::new(
                    "No sink on this platform yet.",
                ))
            }),
            (192, 108),
        )
        .without_supervisor();
        let state = test_state_with(service);
        // A shown refusal is only learned when the switch turns on.
        let off = state.virtual_camera.status();
        assert_eq!(off.state, VirtualCameraState::Off);
        assert!(off.available && off.platform_step.is_none());
        let mut events = state.events.subscribe();
        let status = set_on(&state, true).await.unwrap();
        assert!(status.on && !status.available);
        assert_eq!(status.state, VirtualCameraState::Unavailable);
        assert_eq!(
            status.message.as_deref(),
            Some("No sink on this platform yet.")
        );
        assert!(status.platform_step.is_none(), "shown, with the reason");
        assert!(state.virtual_camera.lock().output.is_none());
        let event = events.try_recv().expect("the change event");
        assert_eq!(event.event, VIRTUAL_CAMERA_CHANGED_EVENT);
        assert!(lease_wanted(&state).is_none());
    }

    /// Owner, 2026-11-03: a platform that hasn't passed its spike is hidden
    /// from the first status on, before and after the switch, and no report
    /// from main un-hides it.
    #[tokio::test]
    async fn a_hidden_platform_reports_unsupported_before_and_after_the_switch() {
        let service = VirtualCameraService::with_sink_factory(
            Box::new(|| Err(VirtualCameraUnavailable::hidden_until_proven("Windows"))),
            (192, 108),
        )
        .without_supervisor();
        let state = test_state_with(service);
        let off = state.virtual_camera.status();
        assert!(!off.on && !off.available);
        assert_eq!(off.state, VirtualCameraState::Unavailable);
        assert_eq!(
            off.platform_step,
            Some(VirtualCameraPlatformStep::Unsupported)
        );
        assert_eq!(
            off.message.as_deref(),
            Some("Videorc Camera isn't available on Windows yet.")
        );
        let on = set_on(&state, true).await.unwrap();
        assert!(on.on && !on.available);
        assert_eq!(
            on.platform_step,
            Some(VirtualCameraPlatformStep::Unsupported)
        );
        assert!(state.virtual_camera.lock().output.is_none());
        let reported = report_platform(&state, VirtualCameraPlatformStep::Ready, None);
        assert_eq!(
            reported.platform_step,
            Some(VirtualCameraPlatformStep::Unsupported),
            "hidden outranks main's report"
        );
        assert!(lease_wanted(&state).is_none());
        set_on(&state, false).await.unwrap();
    }

    #[tokio::test]
    async fn a_platform_report_feeds_the_status_and_publishes_once_per_change() {
        let (service, _) = fake_service(Some(0));
        let state = test_state_with(service);
        let mut events = state.events.subscribe();
        let status = report_platform(
            &state,
            VirtualCameraPlatformStep::NeedsApproval,
            Some("Allow it in System Settings.".to_string()),
        );
        assert_eq!(status.state, VirtualCameraState::NeedsApproval);
        assert_eq!(
            status.platform_step,
            Some(VirtualCameraPlatformStep::NeedsApproval)
        );
        assert_eq!(
            events.try_recv().unwrap().event,
            VIRTUAL_CAMERA_CHANGED_EVENT
        );
        // The same report again: nothing new to say.
        report_platform(
            &state,
            VirtualCameraPlatformStep::NeedsApproval,
            Some("Allow it in System Settings.".to_string()),
        );
        assert!(events.try_recv().is_err());
        let ready = report_platform(&state, VirtualCameraPlatformStep::Ready, None);
        assert_eq!(ready.state, VirtualCameraState::Off);
        assert_eq!(ready.platform_step, Some(VirtualCameraPlatformStep::Ready));
        assert_eq!(
            events.try_recv().unwrap().event,
            VIRTUAL_CAMERA_CHANGED_EVENT
        );
    }

    /// A3: camera → record → stop → camera. The camera's weak lease is
    /// replaced in place by the session (no `AlreadyLeased`, no restart
    /// path), and the session's release hands the run back to the camera at
    /// its canvas while a viewer still holds it.
    #[tokio::test]
    async fn the_camera_lease_yields_to_a_session_and_returns_after_it() {
        let (service, sink) = fake_service(Some(1));
        let state = test_state_with(service);
        let preview = start_synthetic_compositor(state.clone(), preview_params(64, 36)).await;
        let run_id = preview.run_id.clone().expect("preview run id");

        set_on(&state, true).await.unwrap();
        wait_until_demanded(&state).await;
        assert_eq!(reconcile_lease(&state).await, LeaseReconcile::Armed);
        assert_eq!(
            compositor_capture_lease_run_id(&state).await.as_deref(),
            Some(run_id.as_str())
        );
        let armed = compositor_status(&state).await;
        assert_eq!((armed.width, armed.height), (192, 108));
        assert_eq!(
            armed.frame_pipeline.consumer.as_deref(),
            Some("native-preview")
        );
        assert_eq!(reconcile_lease(&state).await, LeaseReconcile::Unchanged);

        // Record: the session arms over the camera's lease, same run.
        let session =
            arm_compositor_for_capture(&state, "session-1", session_params(128, 72, false))
                .await
                .expect("a session arms over the camera's weak lease");
        assert_eq!(session.run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!((session.width, session.height), (128, 72));
        assert_eq!(
            session.frame_pipeline.consumer.as_deref(),
            Some("videotoolbox-encoder")
        );
        assert!(!crate::compositor::compositor_virtual_camera_lease_active(&state).await);
        // The camera is told a capture holds the run and does nothing.
        assert_eq!(
            reconcile_lease(&state).await,
            LeaseReconcile::CaptureHoldsTheRun
        );
        // A second session is still refused: the session's lease is strong.
        assert_eq!(
            arm_compositor_for_capture(&state, "session-2", session_params(128, 72, false))
                .await
                .map(|_| ()),
            Err(CompositorArmRefusal::AlreadyLeased)
        );

        // Stop: the run goes to the camera, in place, at the camera canvas.
        let released = release_compositor_capture_lease(&state, "session-1")
            .await
            .expect("the session held the lease");
        assert_eq!(released.run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!((released.width, released.height), (192, 108));
        assert_eq!(
            released.frame_pipeline.consumer.as_deref(),
            Some("native-preview")
        );
        assert!(crate::compositor::compositor_virtual_camera_lease_active(&state).await);
        assert_eq!(reconcile_lease(&state).await, LeaseReconcile::Unchanged);

        // The viewer leaves: the camera releases the run (no surface: stopped).
        sink.lock().unwrap().viewers = Some(0);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while state
            .virtual_camera
            .lock()
            .output
            .as_ref()
            .is_some_and(|output| output.shared().demanded())
        {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(reconcile_lease(&state).await, LeaseReconcile::Released);
        assert!(compositor_capture_lease_run_id(&state).await.is_none());
        set_on(&state, false).await.unwrap();
        stop_compositor(&state).await;
    }

    /// A3 with Clips on: the ring's lease is strong, so the camera reads the
    /// ring's store and takes the run only when Clips releases it.
    #[tokio::test]
    async fn with_clips_on_the_camera_reads_the_ring_and_takes_the_run_after() {
        let (service, _sink) = fake_service(Some(1));
        let state = test_state_with(service);
        let preview = start_synthetic_compositor(state.clone(), preview_params(64, 36)).await;
        let run_id = preview.run_id.clone().expect("preview run id");
        arm_compositor_for_capture(&state, "clips", session_params(128, 72, true))
            .await
            .expect("Clips arms the idle run");

        set_on(&state, true).await.unwrap();
        wait_until_demanded(&state).await;
        assert_eq!(
            reconcile_lease(&state).await,
            LeaseReconcile::CaptureHoldsTheRun
        );
        let status = compositor_status(&state).await;
        assert_eq!(
            (status.width, status.height),
            (128, 72),
            "Clips keeps its canvas"
        );

        let released = release_compositor_capture_lease(&state, "clips")
            .await
            .expect("Clips held the lease");
        assert_eq!(released.run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!((released.width, released.height), (192, 108));
        assert!(crate::compositor::compositor_virtual_camera_lease_active(&state).await);
        set_on(&state, false).await.unwrap();
        assert!(compositor_capture_lease_run_id(&state).await.is_none());
        stop_compositor(&state).await;
    }

    /// A3 with Clips off: the camera arms the idle run directly, and turning
    /// the camera off hands the run back (here: stops it, no surface).
    #[tokio::test]
    async fn with_clips_off_the_camera_arms_the_idle_run_and_off_releases_it() {
        let (service, _sink) = fake_service(None);
        let state = test_state_with(service);
        start_synthetic_compositor(state.clone(), preview_params(64, 36)).await;
        set_on(&state, true).await.unwrap();
        wait_until_demanded(&state).await;
        assert_eq!(reconcile_lease(&state).await, LeaseReconcile::Armed);
        let status = state.virtual_camera.status();
        assert_eq!(
            status.state,
            VirtualCameraState::Streaming,
            "unknown viewers count as held"
        );
        assert_eq!(status.viewers, None);
        let off = set_on(&state, false).await.unwrap();
        assert_eq!(off.state, VirtualCameraState::Off);
        assert!(compositor_capture_lease_run_id(&state).await.is_none());
        assert!(!lease_wanted(&state).is_some());
        stop_compositor(&state).await;
    }

    #[tokio::test]
    async fn without_a_live_run_the_camera_waits_for_one() {
        let (service, _sink) = fake_service(Some(1));
        let state = test_state_with(service);
        set_on(&state, true).await.unwrap();
        wait_until_demanded(&state).await;
        assert_eq!(
            reconcile_lease(&state).await,
            LeaseReconcile::NoRun(CompositorArmRefusal::NoLiveRun)
        );
        assert_eq!(
            state.virtual_camera.status().state,
            VirtualCameraState::Streaming
        );
        set_on(&state, false).await.unwrap();
    }
}
