//! Single-flight, generation-scoped recovery for capture delivery decay.
//!
//! Detection remains owned by `capture_health`. This module is the mutation
//! authority: it admits at most two exact-generation automatic restarts per
//! incident, verifies that capture cadence was actually restored, latches
//! failures for explicit operator retry, and ignores completions from
//! superseded source/config generations. A compositor-render verdict is
//! intentionally observable but can never route to a source restart.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::capture_health::{
    CaptureHealthCameraEpoch, CaptureHealthScreenEpoch, CaptureHealthTransition, CaptureStage,
    DEGRADED_RATE_FRACTION,
};
use crate::compositor::compositor_status;
use crate::diagnostics::{apply_capture_health, apply_capture_recovery_status};
use crate::preview_camera::{
    PreviewCameraForceRestartAttempt, PreviewCameraForceRestartResult,
    PreviewCameraRecoveryEvidence, admit_failed_preview_camera_recovery_retry,
    admit_force_restart_preview_camera, complete_force_restart_preview_camera,
    failed_preview_camera_retry_is_current, preview_camera_recovery_evidence,
    preview_camera_restart_snapshot,
};
use crate::preview_screen::{
    PreviewScreenForceRestartAttempt, PreviewScreenForceRestartResult,
    PreviewScreenRecoveryEvidence, admit_failed_preview_screen_recovery_retry,
    admit_force_restart_preview_screen, complete_force_restart_preview_screen,
    failed_preview_screen_retry_is_current, preview_screen_recovery_evidence,
    preview_screen_restart_snapshot,
};
use crate::protocol::{
    CaptureRecoveryPhase, CaptureRecoverySource, CaptureRecoveryStage, CaptureRecoveryStatus,
    CaptureRecoveryTrigger, HealthLevel, PreviewCameraState, PreviewScreenState,
};
use crate::source_registry::SourceKey;
use crate::state::AppState;

const CAPTURE_RECOVERY_VERIFICATION_WINDOW: Duration = Duration::from_secs(2);
const CAPTURE_RECOVERY_DOWNSTREAM_VERIFICATION_WINDOW: Duration = Duration::from_secs(5);
const CAPTURE_RECOVERY_DOWNSTREAM_RATE_WINDOW: Duration = Duration::from_secs(2);
const CAPTURE_RECOVERY_DOWNSTREAM_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CAPTURE_RECOVERY_RECOVERED_DWELL: Duration = Duration::from_secs(5);
/// Recovery awaits the fenced camera transition rather than the shorter stop
/// response. Keep this aligned with `CAMERA_COMMAND_TRANSITION_TIMEOUT` in
/// `preview_camera`.
const CAPTURE_RECOVERY_CAMERA_NATIVE_RESTART_CONTRACT: Duration = Duration::from_secs(15);
/// Preserve the former 60-second public bound for a stalled screen restart,
/// but apply it only to predecessor teardown. The native join itself remains
/// process-owned and unbounded so a replacement can never overlap it.
const CAPTURE_RECOVERY_SCREEN_NATIVE_TEARDOWN_PUBLIC_CONTRACT: Duration = Duration::from_secs(59);
/// Screen recovery awaits ScreenCaptureKit's two discovery attempts, stream
/// startup, and the native startup margin (12s * 2 + 30s + 5s). Keep this
/// aligned with `native_screen_preview_thread_startup_timeout`.
const CAPTURE_RECOVERY_SCREEN_NATIVE_RESTART_CONTRACT: Duration = Duration::from_secs(59);
/// Let a native contract or verification window finish at its exact boundary
/// before public recovery state is failed. The physical owner remains
/// non-cancellable even after this bounded scheduler margin expires.
const CAPTURE_RECOVERY_WATCHDOG_SCHEDULER_SLACK: Duration = Duration::from_secs(1);
pub(crate) const MAX_AUTOMATIC_ATTEMPTS: u32 = 2;
#[cfg(debug_assertions)]
const CAPTURE_RECOVERY_SMOKE_ARM_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) const INITIAL_CAPTURE_RECOVERY_CAMERA_MUTATION_EPOCH: u64 = 1;

fn capture_recovery_restart_watchdog_timeout(source: CaptureRecoverySource) -> Duration {
    let native_contract = match source {
        CaptureRecoverySource::Camera => CAPTURE_RECOVERY_CAMERA_NATIVE_RESTART_CONTRACT,
        CaptureRecoverySource::Screen => CAPTURE_RECOVERY_SCREEN_NATIVE_RESTART_CONTRACT,
    };
    native_contract.saturating_add(CAPTURE_RECOVERY_WATCHDOG_SCHEDULER_SLACK)
}

fn capture_recovery_screen_teardown_watchdog_timeout() -> Duration {
    CAPTURE_RECOVERY_SCREEN_NATIVE_TEARDOWN_PUBLIC_CONTRACT
        .saturating_add(CAPTURE_RECOVERY_WATCHDOG_SCHEDULER_SLACK)
}

fn capture_recovery_verification_watchdog_timeout() -> Duration {
    CAPTURE_RECOVERY_VERIFICATION_WINDOW
        .saturating_add(CAPTURE_RECOVERY_DOWNSTREAM_VERIFICATION_WINDOW)
        .saturating_add(CAPTURE_RECOVERY_WATCHDOG_SCHEDULER_SLACK)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureRecoveryWatchdogStage {
    ScreenTeardown,
    Restarting,
    Verifying,
}

impl CaptureRecoveryWatchdogStage {
    fn phase(self) -> CaptureRecoveryPhase {
        match self {
            Self::ScreenTeardown | Self::Restarting => CaptureRecoveryPhase::Restarting,
            Self::Verifying => CaptureRecoveryPhase::Verifying,
        }
    }
}

pub(crate) type CaptureRecoverySlot = Arc<tokio::sync::Mutex<CaptureRecoveryCoordinator>>;

pub(crate) type CaptureRecoveryCompositorEvidenceSlot =
    Arc<StdMutex<CaptureRecoveryCompositorEvidenceSet>>;

#[derive(Debug, Clone, Default)]
pub(crate) struct CaptureRecoveryCompositorEvidenceSet {
    camera: Option<CaptureRecoveryCompositorEvidence>,
    screen: Option<CaptureRecoveryCompositorEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaptureRecoveryCompositorEvidence {
    pub(crate) source: CaptureRecoverySource,
    pub(crate) compositor_run_id: String,
    pub(crate) source_key: SourceKey,
    pub(crate) generation: u64,
    pub(crate) baseline_fresh_serves: u64,
    pub(crate) baseline_observed_at: Instant,
    pub(crate) current_fresh_serves: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CaptureRecoveryHealthEvent {
    pub(crate) compositor_run_id: String,
    pub(crate) sequence: u64,
    /// Explicit camera selection/configuration boundary sampled by the
    /// compositor with this evidence window. Render-health events carry None.
    pub(crate) camera_mutation_epoch: Option<u64>,
    pub(crate) transition: CaptureHealthTransition,
}

#[cfg(debug_assertions)]
pub(crate) type CaptureRecoverySmokeFaultSlot = Arc<StdMutex<CaptureRecoverySmokeFaultRuntime>>;

#[cfg(debug_assertions)]
#[derive(Debug, Default)]
pub(crate) struct CaptureRecoverySmokeFaultRuntime {
    next_id: u64,
    active: Option<CaptureRecoverySmokeFault>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone)]
struct CaptureRecoverySmokeFault {
    fault_id: u64,
    scope: CaptureRecoveryScope,
    capture_callbacks: u64,
    frame_store_publications: u64,
    fresh_serves: Option<u64>,
    first_sampled: bool,
    sampled: Arc<tokio::sync::Notify>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CaptureRecoverySmokeSample {
    pub(crate) fresh_serves: u64,
    pub(crate) capture_callbacks: u64,
    pub(crate) frame_store_publications: u64,
    pub(crate) first_sample: bool,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRecoverySmokeInjectionAck {
    pub(crate) armed: bool,
    pub(crate) fault_id: u64,
    pub(crate) source_generation: u64,
    pub(crate) message: String,
}

/// Debug-runner-only, generation-coherent cadence counters. The public preview
/// status intentionally does not expose generation internals; this snapshot is
/// the proof seam used by the real-source recovery smoke.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRecoverySmokeCadenceEvidence {
    pub(crate) source: CaptureRecoverySource,
    pub(crate) source_generation: u64,
    pub(crate) compositor_run_id: String,
    pub(crate) producer_target_fps: u32,
    pub(crate) compositor_target_fps: u32,
    pub(crate) capture_callback_count: u64,
    pub(crate) frame_store_publications: u64,
    pub(crate) fresh_serves: u64,
}

pub(crate) fn new_capture_recovery_slot() -> CaptureRecoverySlot {
    Arc::new(tokio::sync::Mutex::new(
        CaptureRecoveryCoordinator::default(),
    ))
}

pub(crate) fn new_capture_recovery_compositor_evidence_slot()
-> CaptureRecoveryCompositorEvidenceSlot {
    Arc::new(StdMutex::new(
        CaptureRecoveryCompositorEvidenceSet::default(),
    ))
}

#[cfg(debug_assertions)]
pub(crate) fn new_capture_recovery_smoke_fault_slot() -> CaptureRecoverySmokeFaultSlot {
    Arc::new(StdMutex::new(CaptureRecoverySmokeFaultRuntime::default()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaptureRecoveryScope {
    pub(crate) source: CaptureRecoverySource,
    pub(crate) source_key: SourceKey,
    pub(crate) generation: u64,
}

impl CaptureRecoveryScope {
    fn camera(source_key: SourceKey, generation: u64) -> Self {
        Self {
            source: CaptureRecoverySource::Camera,
            source_key,
            generation,
        }
    }

    fn screen(source_key: SourceKey, generation: u64) -> Self {
        Self {
            source: CaptureRecoverySource::Screen,
            source_key,
            generation,
        }
    }
}

pub(crate) fn record_compositor_camera_delivery_evidence(
    state: &AppState,
    compositor_run_id: &str,
    source: Option<(SourceKey, u64)>,
    fresh_serves: u64,
) {
    record_compositor_delivery_evidence(
        state,
        CaptureRecoverySource::Camera,
        compositor_run_id,
        source,
        fresh_serves,
    );
}

pub(crate) fn record_compositor_screen_delivery_evidence(
    state: &AppState,
    compositor_run_id: &str,
    source: Option<(SourceKey, u64)>,
    fresh_serves: u64,
) {
    record_compositor_delivery_evidence(
        state,
        CaptureRecoverySource::Screen,
        compositor_run_id,
        source,
        fresh_serves,
    );
}

fn record_compositor_delivery_evidence(
    state: &AppState,
    source_kind: CaptureRecoverySource,
    compositor_run_id: &str,
    source: Option<(SourceKey, u64)>,
    fresh_serves: u64,
) {
    let mut slot = state
        .capture_recovery_compositor_evidence
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = match source_kind {
        CaptureRecoverySource::Camera => &mut slot.camera,
        CaptureRecoverySource::Screen => &mut slot.screen,
    };
    let Some((source_key, generation)) = source else {
        *target = None;
        return;
    };

    match target.as_mut() {
        Some(current)
            if current.compositor_run_id == compositor_run_id
                && current.source_key == source_key
                && current.generation == generation
                && fresh_serves >= current.current_fresh_serves =>
        {
            current.current_fresh_serves = fresh_serves;
        }
        _ => {
            *target = Some(CaptureRecoveryCompositorEvidence {
                source: source_kind,
                compositor_run_id: compositor_run_id.to_string(),
                source_key,
                generation,
                baseline_fresh_serves: fresh_serves,
                baseline_observed_at: Instant::now(),
                current_fresh_serves: fresh_serves,
            });
        }
    }
}

fn compositor_camera_delivery_evidence(
    state: &AppState,
) -> Option<CaptureRecoveryCompositorEvidence> {
    state
        .capture_recovery_compositor_evidence
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .camera
        .clone()
}

fn compositor_screen_delivery_evidence(
    state: &AppState,
) -> Option<CaptureRecoveryCompositorEvidence> {
    state
        .capture_recovery_compositor_evidence
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .screen
        .clone()
}

#[derive(Debug, Clone)]
struct CaptureRecoveryAttemptTicket {
    epoch: u64,
    trigger: CaptureRecoveryTrigger,
    scope: CaptureRecoveryScope,
    started_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureRecoveryRecoveredGuard {
    epoch: u64,
    stage: Option<CaptureRecoveryStage>,
    scope: Option<CaptureRecoveryScope>,
}

/// The render watchdog and camera-delivery monitor are independent health
/// authorities. A camera incident may temporarily own the public recovery
/// state because it is actionable, but it must not erase a render incident
/// whose watchdog remains latched and therefore will not emit Degraded again.
#[derive(Debug, Clone)]
struct RetainedRenderIncident {
    detected_at: String,
    updated_at: String,
    detail: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CaptureRecoveryRestartEvidence {
    pub(crate) scope: CaptureRecoveryScope,
    pub(crate) baseline: CaptureRecoveryProducerEvidence,
    pub(crate) compositor_run_id: Option<String>,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum CaptureRecoveryProducerEvidence {
    Camera(PreviewCameraRecoveryEvidence),
    Screen(PreviewScreenRecoveryEvidence),
}

#[derive(Debug, Clone)]
pub(crate) enum CaptureRecoveryRestartOutcome {
    Restarted(Box<CaptureRecoveryRestartEvidence>),
    Superseded,
    Failed {
        error: String,
        retry_scope: Option<CaptureRecoveryScope>,
    },
}

#[derive(Debug, Clone)]
pub(crate) enum CaptureRecoveryVerificationOutcome {
    Recovered(String),
    Superseded,
    Failed(String),
}

type CaptureRecoveryDriverFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One-shot edge between independently bounded screen teardown and startup
/// phases. Screen recovery holds it until the previous ScreenCaptureKit owner
/// has joined. Crossing the edge cancels the public teardown timer and starts
/// a fresh discovery/stream-start timer; neither timer can cancel the physical
/// process-owned transition or permit overlapping native owners.
#[derive(Clone)]
pub(crate) struct CaptureRecoveryRestartWatchdogArm {
    startup_sender: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
    teardown_cancel_sender: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
}

impl CaptureRecoveryRestartWatchdogArm {
    fn channel(
        include_teardown_watchdog: bool,
    ) -> (Self, oneshot::Receiver<()>, Option<oneshot::Receiver<()>>) {
        let (startup_sender, startup_receiver) = oneshot::channel();
        let (teardown_cancel_sender, teardown_cancel_receiver) = include_teardown_watchdog
            .then(oneshot::channel)
            .map_or((None, None), |(sender, receiver)| {
                (Some(sender), Some(receiver))
            });
        (
            Self {
                startup_sender: Arc::new(StdMutex::new(Some(startup_sender))),
                teardown_cancel_sender: Arc::new(StdMutex::new(teardown_cancel_sender)),
            },
            startup_receiver,
            teardown_cancel_receiver,
        )
    }

    fn arm(&self) {
        // Cancel the teardown deadline first. At an exact boundary the
        // teardown watchdog uses a biased select so completed ownership
        // retirement wins over a simultaneous public timeout.
        if let Some(sender) = self
            .teardown_cancel_sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = sender.send(());
        }
        if let Some(sender) = self
            .startup_sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = sender.send(());
        }
    }
}

/// Restart/verification boundary. Tests can prove coordinator behavior without
/// capture devices, while production uses the generation-CAS preview seam.
pub(crate) trait CaptureRecoveryDriver: Send + Sync + 'static {
    fn restart(
        &self,
        state: AppState,
        scope: CaptureRecoveryScope,
        recovery_epoch: u64,
        restart_watchdog: CaptureRecoveryRestartWatchdogArm,
    ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome>;

    fn verify(
        &self,
        state: AppState,
        evidence: CaptureRecoveryRestartEvidence,
    ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome>;
}

#[derive(Debug, Default)]
struct BackendCaptureRecoveryDriver;

/// Serialize only the recovery admission edge with session startup. Both
/// preview-camera admission functions synchronously register a persistent
/// source-transition guard before they return, so the shared mutex can be
/// released before native AVCaptureSession teardown/startup is awaited. This
/// keeps a wedged `stopRunning` from blocking recording finalization or process
/// shutdown while preserving session-start ordering through the source fence.
async fn admit_backend_camera_recovery(
    state: &AppState,
    scope: &CaptureRecoveryScope,
    recovery_epoch: u64,
) -> Option<PreviewCameraForceRestartAttempt> {
    let _session_start_source_transition_fence = state
        .session_start_source_transition_fence
        .clone()
        .lock_owned()
        .await;
    if state.process_shutdown_requested() {
        return None;
    }

    match preview_camera_restart_snapshot(state).await {
        Some(snapshot)
            if snapshot.source_key == scope.source_key
                && snapshot.generation == scope.generation =>
        {
            admit_force_restart_preview_camera(state, &snapshot, recovery_epoch).await
        }
        Some(_) => None,
        None => {
            admit_failed_preview_camera_recovery_retry(
                state,
                &scope.source_key,
                scope.generation,
                recovery_epoch,
            )
            .await
        }
    }
}

async fn admit_backend_screen_recovery(
    state: &AppState,
    scope: &CaptureRecoveryScope,
    recovery_epoch: u64,
) -> Option<PreviewScreenForceRestartAttempt> {
    let _session_start_source_transition_fence = state
        .session_start_source_transition_fence
        .clone()
        .lock_owned()
        .await;
    if state.process_shutdown_requested() {
        return None;
    }

    match preview_screen_restart_snapshot(state).await {
        Some(snapshot)
            if snapshot.source_key == scope.source_key
                && snapshot.generation == scope.generation =>
        {
            admit_force_restart_preview_screen(state, &snapshot, recovery_epoch).await
        }
        Some(_) => None,
        None => {
            admit_failed_preview_screen_recovery_retry(
                state,
                &scope.source_key,
                scope.generation,
                recovery_epoch,
            )
            .await
        }
    }
}

async fn current_recovery_producer_evidence(
    state: &AppState,
    scope: &CaptureRecoveryScope,
) -> Option<CaptureRecoveryProducerEvidence> {
    match scope.source {
        CaptureRecoverySource::Camera => {
            let snapshot = preview_camera_restart_snapshot(state).await?;
            if snapshot.source_key != scope.source_key || snapshot.generation != scope.generation {
                return None;
            }
            preview_camera_recovery_evidence(state, &snapshot)
                .await
                .map(CaptureRecoveryProducerEvidence::Camera)
        }
        CaptureRecoverySource::Screen => {
            let snapshot = preview_screen_restart_snapshot(state).await?;
            if snapshot.source_key != scope.source_key || snapshot.generation != scope.generation {
                return None;
            }
            preview_screen_recovery_evidence(state, &snapshot)
                .await
                .map(CaptureRecoveryProducerEvidence::Screen)
        }
    }
}

fn verify_recovery_producer_evidence(
    baseline: &CaptureRecoveryProducerEvidence,
    current: &CaptureRecoveryProducerEvidence,
    elapsed: Duration,
) -> Result<String, String> {
    match (baseline, current) {
        (
            CaptureRecoveryProducerEvidence::Camera(baseline),
            CaptureRecoveryProducerEvidence::Camera(current),
        ) => verify_camera_recovery_evidence(baseline, current, elapsed),
        (
            CaptureRecoveryProducerEvidence::Screen(baseline),
            CaptureRecoveryProducerEvidence::Screen(current),
        ) => verify_screen_recovery_evidence(baseline, current, elapsed),
        _ => Err("Capture recovery producer kind changed during verification.".to_string()),
    }
}

fn recovery_producer_target_fps(evidence: &CaptureRecoveryProducerEvidence) -> u32 {
    match evidence {
        CaptureRecoveryProducerEvidence::Camera(evidence) => evidence.target_fps,
        CaptureRecoveryProducerEvidence::Screen(evidence) => evidence.target_fps,
    }
}

fn compositor_delivery_evidence(
    state: &AppState,
    source: CaptureRecoverySource,
) -> Option<CaptureRecoveryCompositorEvidence> {
    match source {
        CaptureRecoverySource::Camera => compositor_camera_delivery_evidence(state),
        CaptureRecoverySource::Screen => compositor_screen_delivery_evidence(state),
    }
}

fn recovery_source_label(source: CaptureRecoverySource) -> &'static str {
    match source {
        CaptureRecoverySource::Camera => "camera",
        CaptureRecoverySource::Screen => "screen",
    }
}

#[cfg(debug_assertions)]
struct CaptureRecoverySmokeCadenceSnapshot<'a> {
    source: CaptureRecoverySource,
    before: &'a CaptureRecoveryScope,
    producer: &'a CaptureRecoveryProducerEvidence,
    compositor: &'a CaptureRecoveryCompositorEvidence,
    after: &'a CaptureRecoveryScope,
    compositor_run_before: Option<&'a str>,
    compositor_run_after: Option<&'a str>,
    compositor_target_fps_before: u32,
    compositor_target_fps_after: u32,
}

#[cfg(debug_assertions)]
fn capture_recovery_smoke_cadence_evidence_for_snapshot(
    snapshot: CaptureRecoverySmokeCadenceSnapshot<'_>,
) -> Result<CaptureRecoverySmokeCadenceEvidence, String> {
    let CaptureRecoverySmokeCadenceSnapshot {
        source,
        before,
        producer,
        compositor,
        after,
        compositor_run_before,
        compositor_run_after,
        compositor_target_fps_before,
        compositor_target_fps_after,
    } = snapshot;
    let label = recovery_source_label(source);
    if before.source != source {
        return Err(format!(
            "Capture recovery {label} cadence evidence began with the wrong source."
        ));
    }
    if after != before {
        return Err(format!(
            "Capture recovery {label} generation was superseded while cadence evidence was sampled."
        ));
    }
    let (
        producer_source_key,
        producer_generation,
        producer_target_fps,
        capture_callback_count,
        publications,
    ) = match producer {
        CaptureRecoveryProducerEvidence::Camera(evidence)
            if source == CaptureRecoverySource::Camera =>
        {
            (
                &evidence.source_key,
                evidence.generation,
                evidence.target_fps,
                evidence.capture_callback_count,
                evidence.frame_store_publications,
            )
        }
        CaptureRecoveryProducerEvidence::Screen(evidence)
            if source == CaptureRecoverySource::Screen =>
        {
            (
                &evidence.source_key,
                evidence.generation,
                evidence.target_fps,
                evidence.capture_callback_count,
                evidence.frame_store_publications,
            )
        }
        _ => {
            return Err(format!(
                "Capture recovery {label} cadence producer changed source while sampled."
            ));
        }
    };
    if producer_source_key != &before.source_key || producer_generation != before.generation {
        return Err(format!(
            "Capture recovery {label} cadence producer did not match the active generation."
        ));
    }
    if producer_target_fps == 0 {
        return Err(format!(
            "Capture recovery {label} cadence producer has no positive target FPS."
        ));
    }
    if compositor.source != source
        || compositor.source_key != before.source_key
        || compositor.generation != before.generation
    {
        return Err(format!(
            "Capture recovery {label} cadence compositor did not match the active generation."
        ));
    }
    if compositor_run_before != Some(compositor.compositor_run_id.as_str())
        || compositor_run_after != compositor_run_before
    {
        return Err(format!(
            "Capture recovery {label} compositor run was superseded while cadence evidence was sampled."
        ));
    }
    if compositor_target_fps_before == 0
        || compositor_target_fps_after != compositor_target_fps_before
    {
        return Err(format!(
            "Capture recovery {label} compositor target FPS changed while cadence evidence was sampled."
        ));
    }
    Ok(CaptureRecoverySmokeCadenceEvidence {
        source,
        source_generation: before.generation,
        compositor_run_id: compositor.compositor_run_id.clone(),
        producer_target_fps,
        compositor_target_fps: compositor_target_fps_before,
        capture_callback_count,
        frame_store_publications: publications,
        fresh_serves: compositor.current_fresh_serves,
    })
}

/// Samples producer and compositor counters for one exact active generation.
/// Re-reading the active scope after both counter snapshots closes the race
/// where a source replacement occurs midway through the observation.
#[cfg(debug_assertions)]
pub(crate) async fn capture_recovery_smoke_cadence_evidence(
    state: &AppState,
    source: CaptureRecoverySource,
) -> Result<CaptureRecoverySmokeCadenceEvidence, String> {
    async fn active_scope(
        state: &AppState,
        source: CaptureRecoverySource,
    ) -> Option<CaptureRecoveryScope> {
        match source {
            CaptureRecoverySource::Camera => {
                preview_camera_restart_snapshot(state)
                    .await
                    .map(|snapshot| {
                        CaptureRecoveryScope::camera(snapshot.source_key, snapshot.generation)
                    })
            }
            CaptureRecoverySource::Screen => {
                preview_screen_restart_snapshot(state)
                    .await
                    .map(|snapshot| {
                        CaptureRecoveryScope::screen(snapshot.source_key, snapshot.generation)
                    })
            }
        }
    }

    let label = recovery_source_label(source);
    let before = active_scope(state, source)
        .await
        .ok_or_else(|| format!("Capture recovery {label} source is not active."))?;
    let compositor_before = compositor_status(state).await;
    let producer = current_recovery_producer_evidence(state, &before)
        .await
        .ok_or_else(|| {
            format!("Capture recovery {label} generation changed before producer sampling.")
        })?;
    let compositor = compositor_delivery_evidence(state, source)
        .ok_or_else(|| format!("Capture recovery {label} has no compositor delivery evidence."))?;
    let after = active_scope(state, source)
        .await
        .ok_or_else(|| format!("Capture recovery {label} source stopped while sampled."))?;
    let compositor_after = compositor_status(state).await;
    capture_recovery_smoke_cadence_evidence_for_snapshot(CaptureRecoverySmokeCadenceSnapshot {
        source,
        before: &before,
        producer: &producer,
        compositor: &compositor,
        after: &after,
        compositor_run_before: compositor_before.run_id.as_deref(),
        compositor_run_after: compositor_after.run_id.as_deref(),
        compositor_target_fps_before: compositor_before.target_fps,
        compositor_target_fps_after: compositor_after.target_fps,
    })
}

impl CaptureRecoveryDriver for BackendCaptureRecoveryDriver {
    fn restart(
        &self,
        state: AppState,
        scope: CaptureRecoveryScope,
        recovery_epoch: u64,
        restart_watchdog: CaptureRecoveryRestartWatchdogArm,
    ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
        Box::pin(async move {
            if state.process_shutdown_requested() {
                return CaptureRecoveryRestartOutcome::Superseded;
            }
            match scope.source {
                CaptureRecoverySource::Camera => {
                    // Preserve the camera contract: its bounded restart budget
                    // begins at the driver boundary, as it did before the
                    // screen-specific teardown/startup split.
                    restart_watchdog.arm();
                    let Some(restart_attempt) =
                        admit_backend_camera_recovery(&state, &scope, recovery_epoch).await
                    else {
                        return CaptureRecoveryRestartOutcome::Superseded;
                    };
                    // Admission has already registered the exact generation's
                    // source-transition guard. Native completion may block, but
                    // it no longer owns the session-start/shutdown mutex.
                    let compositor_run_id = compositor_status(&state).await.run_id;
                    let session_id = state.diagnostics.lock().await.session_id.clone();
                    let restart =
                        complete_force_restart_preview_camera(&state, restart_attempt).await;

                    match restart {
                        PreviewCameraForceRestartResult::Restarted { status, generation } => {
                            if generation == scope.generation {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: "Camera restart did not advance the capture generation."
                                        .to_string(),
                                    retry_scope: None,
                                };
                            }
                            let restarted_scope =
                                CaptureRecoveryScope::camera(scope.source_key.clone(), generation);
                            if status.state == PreviewCameraState::Failed {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: status.message.unwrap_or_else(|| {
                                        "Camera restart failed during native startup.".to_string()
                                    }),
                                    retry_scope: Some(restarted_scope),
                                };
                            }
                            let Some(restarted_snapshot) =
                                preview_camera_restart_snapshot(&state).await
                            else {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error:
                                        "Camera restart did not publish a live generation snapshot."
                                            .to_string(),
                                    retry_scope: None,
                                };
                            };
                            if restarted_snapshot.source_key != scope.source_key
                                || restarted_snapshot.generation != generation
                            {
                                return CaptureRecoveryRestartOutcome::Superseded;
                            }
                            let Some(baseline) =
                                preview_camera_recovery_evidence(&state, &restarted_snapshot).await
                            else {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: "Camera restart did not publish generation-bound frame evidence."
                                        .to_string(),
                                    retry_scope: Some(restarted_scope),
                                };
                            };
                            CaptureRecoveryRestartOutcome::Restarted(Box::new(
                                CaptureRecoveryRestartEvidence {
                                    scope: restarted_scope,
                                    baseline: CaptureRecoveryProducerEvidence::Camera(baseline),
                                    compositor_run_id,
                                    session_id,
                                },
                            ))
                        }
                        PreviewCameraForceRestartResult::RejectedStale => {
                            CaptureRecoveryRestartOutcome::Superseded
                        }
                    }
                }
                CaptureRecoverySource::Screen => {
                    let Some(mut restart_attempt) =
                        admit_backend_screen_recovery(&state, &scope, recovery_epoch).await
                    else {
                        return CaptureRecoveryRestartOutcome::Superseded;
                    };
                    let compositor_run_id = compositor_status(&state).await.run_id;
                    let session_id = state.diagnostics.lock().await.session_id.clone();

                    // `await_native_startup_ready` is signalled only after the
                    // old native owner has fully joined. Do not count that
                    // exclusive, intentionally unbounded teardown against the
                    // 59-second ScreenCaptureKit startup contract.
                    if restart_attempt.await_native_startup_ready().await {
                        restart_watchdog.arm();
                    }
                    let restart =
                        complete_force_restart_preview_screen(&state, restart_attempt).await;

                    match restart {
                        PreviewScreenForceRestartResult::Restarted { status, generation } => {
                            if generation == scope.generation {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: "Screen restart did not advance the capture generation."
                                        .to_string(),
                                    retry_scope: None,
                                };
                            }
                            let restarted_scope =
                                CaptureRecoveryScope::screen(scope.source_key.clone(), generation);
                            if status.state != PreviewScreenState::Live {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: status.message.unwrap_or_else(|| {
                                        "Screen restart failed during native startup.".to_string()
                                    }),
                                    retry_scope: Some(restarted_scope),
                                };
                            }
                            let Some(restarted_snapshot) =
                                preview_screen_restart_snapshot(&state).await
                            else {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error:
                                        "Screen restart did not publish a live generation snapshot."
                                            .to_string(),
                                    retry_scope: None,
                                };
                            };
                            if restarted_snapshot.source_key != scope.source_key
                                || restarted_snapshot.generation != generation
                            {
                                return CaptureRecoveryRestartOutcome::Superseded;
                            }
                            let Some(baseline) =
                                preview_screen_recovery_evidence(&state, &restarted_snapshot).await
                            else {
                                return CaptureRecoveryRestartOutcome::Failed {
                                    error: "Screen restart did not publish generation-bound frame evidence."
                                        .to_string(),
                                    retry_scope: Some(restarted_scope),
                                };
                            };
                            CaptureRecoveryRestartOutcome::Restarted(Box::new(
                                CaptureRecoveryRestartEvidence {
                                    scope: restarted_scope,
                                    baseline: CaptureRecoveryProducerEvidence::Screen(baseline),
                                    compositor_run_id,
                                    session_id,
                                },
                            ))
                        }
                        PreviewScreenForceRestartResult::RejectedStale => {
                            CaptureRecoveryRestartOutcome::Superseded
                        }
                    }
                }
            }
        })
    }

    fn verify(
        &self,
        state: AppState,
        evidence: CaptureRecoveryRestartEvidence,
    ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
        Box::pin(async move {
            let verification_started = Instant::now();
            tokio::time::sleep(CAPTURE_RECOVERY_VERIFICATION_WINDOW).await;

            let Some(current_evidence) =
                current_recovery_producer_evidence(&state, &evidence.scope).await
            else {
                return CaptureRecoveryVerificationOutcome::Superseded;
            };
            let current_compositor_run_id = compositor_status(&state).await.run_id;
            let current_session_id = state.diagnostics.lock().await.session_id.clone();
            if current_compositor_run_id != evidence.compositor_run_id {
                return CaptureRecoveryVerificationOutcome::Superseded;
            }
            if current_session_id != evidence.session_id {
                return CaptureRecoveryVerificationOutcome::Superseded;
            }
            let _initial_cadence_message = match verify_recovery_producer_evidence(
                &evidence.baseline,
                &current_evidence,
                verification_started.elapsed(),
            ) {
                Ok(message) => message,
                Err(error) => return CaptureRecoveryVerificationOutcome::Failed(error),
            };

            let downstream_started = Instant::now();
            loop {
                let Some(current_evidence) =
                    current_recovery_producer_evidence(&state, &evidence.scope).await
                else {
                    return CaptureRecoveryVerificationOutcome::Superseded;
                };
                let current_compositor = compositor_status(&state).await;
                if current_compositor.run_id != evidence.compositor_run_id
                    || state.diagnostics.lock().await.session_id != evidence.session_id
                {
                    // Recording/compositor lifecycle changes are legitimate
                    // ownership handoffs, not failed source recovery.
                    return CaptureRecoveryVerificationOutcome::Superseded;
                }

                if let Some(downstream) =
                    compositor_delivery_evidence(&state, evidence.scope.source)
                    && evidence.compositor_run_id.as_deref()
                        == Some(downstream.compositor_run_id.as_str())
                    && downstream.source == evidence.scope.source
                    && downstream.source_key == evidence.scope.source_key
                    && downstream.generation == evidence.scope.generation
                    && let Ok((fresh_fps, required_fps)) = verify_compositor_delivery_rate(
                        downstream.baseline_fresh_serves,
                        downstream.current_fresh_serves,
                        downstream.baseline_observed_at.elapsed(),
                        recovery_producer_target_fps(&current_evidence),
                        current_compositor.target_fps,
                    )
                {
                    let Some(terminal_producer) =
                        current_recovery_producer_evidence(&state, &evidence.scope).await
                    else {
                        return CaptureRecoveryVerificationOutcome::Superseded;
                    };
                    let terminal_cadence_message = match verify_recovery_producer_evidence(
                        &evidence.baseline,
                        &terminal_producer,
                        verification_started.elapsed(),
                    ) {
                        Ok(message) => message,
                        Err(error) => {
                            return CaptureRecoveryVerificationOutcome::Failed(error);
                        }
                    };
                    if compositor_status(&state).await.run_id != evidence.compositor_run_id
                        || state.diagnostics.lock().await.session_id != evidence.session_id
                    {
                        return CaptureRecoveryVerificationOutcome::Superseded;
                    }
                    let source_label = recovery_source_label(evidence.scope.source);
                    return CaptureRecoveryVerificationOutcome::Recovered(format!(
                        "{terminal_cadence_message} Compositor fresh {source_label} serves recovered at {fresh_fps:.1}fps (required {required_fps:.1}fps) for the exact replacement generation."
                    ));
                }

                if downstream_started.elapsed() >= CAPTURE_RECOVERY_DOWNSTREAM_VERIFICATION_WINDOW {
                    let source_label = recovery_source_label(evidence.scope.source);
                    return CaptureRecoveryVerificationOutcome::Failed(format!(
                        "{} callbacks and publications recovered, but generation-bound compositor fresh serves did not advance before the downstream verification deadline.",
                        source_label.to_ascii_uppercase()
                    ));
                }
                tokio::time::sleep(CAPTURE_RECOVERY_DOWNSTREAM_POLL_INTERVAL).await;
            }
        })
    }
}

#[derive(Debug)]
pub(crate) struct CaptureRecoveryCoordinator {
    epoch: u64,
    camera_mutation_epoch: u64,
    revision: u64,
    compositor_run_id: Option<String>,
    camera_health_sequence: u64,
    screen_health_sequence: u64,
    render_health_sequence: u64,
    phase: CaptureRecoveryPhase,
    stage: Option<CaptureRecoveryStage>,
    scope: Option<CaptureRecoveryScope>,
    restarted_scope: Option<CaptureRecoveryScope>,
    retry_scope: Option<CaptureRecoveryScope>,
    compositor_adopted_scope: Option<CaptureRecoveryScope>,
    trigger: Option<CaptureRecoveryTrigger>,
    attempts: u32,
    automatic_attempted: bool,
    /// Once an automatic attempt reaches a terminal/watchdog failure, only an
    /// explicit operator retry may start another physical restart. A late
    /// completion may reconcile its exact generation, but cannot reopen
    /// automatic admission for either camera or screen.
    automatic_attempts_operator_latched: bool,
    /// Warning delivery is camera-specific and must not carry mutation
    /// authority. This flag only deduplicates the terminal health warning.
    terminal_camera_warning_emitted: bool,
    detected_at: Option<String>,
    updated_at: Option<String>,
    message: Option<String>,
    last_error: Option<String>,
    last_duration_ms: Option<f64>,
    cadence_verified_message: Option<String>,
    watchdog_expired: bool,
    render_incident: Option<RetainedRenderIncident>,
}

impl Default for CaptureRecoveryCoordinator {
    fn default() -> Self {
        Self {
            epoch: 0,
            camera_mutation_epoch: INITIAL_CAPTURE_RECOVERY_CAMERA_MUTATION_EPOCH,
            revision: 0,
            compositor_run_id: None,
            camera_health_sequence: 0,
            screen_health_sequence: 0,
            render_health_sequence: 0,
            phase: CaptureRecoveryPhase::Idle,
            stage: None,
            scope: None,
            restarted_scope: None,
            retry_scope: None,
            compositor_adopted_scope: None,
            trigger: None,
            attempts: 0,
            automatic_attempted: false,
            automatic_attempts_operator_latched: false,
            terminal_camera_warning_emitted: false,
            detected_at: None,
            updated_at: None,
            message: None,
            last_error: None,
            last_duration_ms: None,
            cadence_verified_message: None,
            watchdog_expired: false,
            render_incident: None,
        }
    }
}

impl CaptureRecoveryCoordinator {
    pub(crate) fn status(&self) -> CaptureRecoveryStatus {
        let current_scope = self.restarted_scope.as_ref().or(self.scope.as_ref());
        CaptureRecoveryStatus {
            revision: self.revision,
            phase: self.phase,
            retryable: self.phase == CaptureRecoveryPhase::Failed && self.retry_scope.is_some(),
            attempts: self.attempts,
            stage: self.stage,
            source: current_scope.map(|scope| scope.source),
            trigger: self.trigger,
            source_generation: current_scope.map(|scope| scope.generation),
            detected_at: self.detected_at.clone(),
            updated_at: self.updated_at.clone(),
            message: self.message.clone(),
            last_error: self.last_error.clone(),
            last_duration_ms: self
                .last_duration_ms
                .filter(|duration| duration.is_finite() && *duration >= 0.0),
        }
    }

    fn advance_revision(&mut self) {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("capture recovery publication revision exhausted");
    }

    fn reconcile_camera_mutation_epoch(
        &mut self,
        camera_mutation_epoch: u64,
    ) -> Option<CaptureRecoveryStatus> {
        assert!(
            camera_mutation_epoch >= self.camera_mutation_epoch,
            "capture recovery camera mutation epoch cannot move backward"
        );
        if camera_mutation_epoch == self.camera_mutation_epoch {
            return None;
        }
        self.camera_mutation_epoch = camera_mutation_epoch;
        self.explicit_camera_configuration_changed()
    }

    fn observe_compositor_lifecycle(
        &mut self,
        compositor_run_id: Option<String>,
    ) -> Option<CaptureRecoveryStatus> {
        if self.compositor_run_id == compositor_run_id {
            return None;
        }
        self.compositor_run_id = compositor_run_id;
        self.camera_health_sequence = 0;
        self.screen_health_sequence = 0;
        self.render_health_sequence = 0;
        self.render_incident = None;

        let stale_render_incident = self.stage == Some(CaptureRecoveryStage::CompositorRender)
            && self.phase != CaptureRecoveryPhase::Idle;
        // A compositor handoff is allowed to retire verification because the
        // replacement run can no longer satisfy evidence captured for the old
        // run. It must not retire Restarting, though: the driver may already
        // have removed the old native camera owner and be synchronously joining
        // it before installing the replacement. That physical transition is
        // intentionally non-cancellable and keeps its exact admission until
        // the driver returns.
        let verification_in_flight = self.phase == CaptureRecoveryPhase::Verifying;
        if stale_render_incident || verification_in_flight {
            self.reset_to_idle();
            return Some(self.status());
        }
        None
    }

    fn camera_restart_may_own_physical_transition(&self) -> bool {
        matches!(
            (self.stage, self.scope.as_ref().map(|scope| scope.source)),
            (
                Some(CaptureRecoveryStage::CameraDelivery),
                Some(CaptureRecoverySource::Camera)
            ) | (
                Some(CaptureRecoveryStage::ScreenDelivery),
                Some(CaptureRecoverySource::Screen)
            )
        ) && (self.phase == CaptureRecoveryPhase::Restarting
            || (self.phase == CaptureRecoveryPhase::Failed
                && self.watchdog_expired
                && self.restarted_scope.is_none()))
    }

    fn admit_health_event(
        &mut self,
        compositor_run_id: &str,
        stage: CaptureRecoveryStage,
        sequence: u64,
    ) -> bool {
        if self.compositor_run_id.as_deref() != Some(compositor_run_id) {
            return false;
        }
        let cursor = match stage {
            CaptureRecoveryStage::CameraDelivery => &mut self.camera_health_sequence,
            CaptureRecoveryStage::ScreenDelivery => &mut self.screen_health_sequence,
            CaptureRecoveryStage::CompositorRender => &mut self.render_health_sequence,
        };
        if sequence <= *cursor {
            return false;
        }
        *cursor = sequence;
        true
    }

    fn reconciliation_target(&self) -> Option<(CaptureRecoveryPhase, CaptureRecoveryScope)> {
        match self.phase {
            CaptureRecoveryPhase::Failed => self
                .retry_scope
                .clone()
                .map(|scope| (CaptureRecoveryPhase::Failed, scope)),
            CaptureRecoveryPhase::Recovered => self
                .scope
                .clone()
                .map(|scope| (CaptureRecoveryPhase::Recovered, scope)),
            _ => None,
        }
    }

    fn invalidate_scoped_phase_if_current(
        &mut self,
        phase: CaptureRecoveryPhase,
        scope: &CaptureRecoveryScope,
    ) -> Option<CaptureRecoveryStatus> {
        let current_scope = self.restarted_scope.as_ref().or(self.scope.as_ref());
        if self.phase != phase || current_scope != Some(scope) {
            return None;
        }
        self.clear_camera_and_reveal_render();
        Some(self.status())
    }

    /// Returns true only for a new incident. Duplicate degraded edges for the
    /// same source/config are coalesced while work is running, and `Failed`
    /// remains latched until manual retry or a genuinely new source epoch.
    fn observe_degraded(
        &mut self,
        stage: CaptureRecoveryStage,
        scope: Option<CaptureRecoveryScope>,
        detail: String,
        now: String,
    ) -> bool {
        if stage == CaptureRecoveryStage::CompositorRender {
            let first_render_edge = self.render_incident.is_none();
            let detected_at = self
                .render_incident
                .as_ref()
                .map_or_else(|| now.clone(), |incident| incident.detected_at.clone());
            self.render_incident = Some(RetainedRenderIncident {
                detected_at,
                updated_at: now.clone(),
                detail: detail.clone(),
            });
            if matches!(
                self.stage,
                Some(CaptureRecoveryStage::CameraDelivery | CaptureRecoveryStage::ScreenDelivery)
            ) && self.phase != CaptureRecoveryPhase::Idle
            {
                // Source recovery/failure remains the actionable public
                // incident, but the render latch is retained and will be
                // revealed as soon as camera authority clears.
                return false;
            }
            if !first_render_edge
                && self.stage == Some(CaptureRecoveryStage::CompositorRender)
                && self.phase != CaptureRecoveryPhase::Idle
            {
                return false;
            }
        }
        if matches!(
            self.phase,
            CaptureRecoveryPhase::Restarting | CaptureRecoveryPhase::Verifying
        ) {
            // Health classifications are observations, not mutation authority.
            // Once an attempt owns the incident, only an explicit source,
            // configuration, or compositor-lifecycle edge may supersede it.
            return false;
        }
        if self.phase == CaptureRecoveryPhase::Failed && self.watchdog_expired {
            // The non-cancellable physical owner retains reconciliation
            // authority after the public watchdog fires. Health observations
            // of any stage/scope cannot replace that ticket or admit overlap;
            // an explicit source/config/lifecycle mutation may still do so.
            return false;
        }
        let same_scope = self.stage == Some(stage)
            && (self.scope.as_ref() == scope.as_ref()
                || self.restarted_scope.as_ref() == scope.as_ref());
        if self.phase == CaptureRecoveryPhase::Failed && scope.is_none() {
            // A failed incident remains authoritative when capture no longer
            // exposes a live restart snapshot. A late health edge must not
            // erase its retained manual-retry token with an unroutable fault.
            return false;
        }
        if same_scope
            && matches!(
                self.phase,
                CaptureRecoveryPhase::Degraded
                    | CaptureRecoveryPhase::Restarting
                    | CaptureRecoveryPhase::Verifying
                    | CaptureRecoveryPhase::Failed
            )
        {
            return false;
        }

        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.phase = CaptureRecoveryPhase::Degraded;
        self.stage = Some(stage);
        self.scope = scope;
        self.restarted_scope = None;
        self.retry_scope = None;
        self.compositor_adopted_scope = None;
        self.trigger = None;
        self.attempts = 0;
        self.automatic_attempted = false;
        self.automatic_attempts_operator_latched = false;
        self.terminal_camera_warning_emitted = false;
        self.detected_at = Some(now.clone());
        self.updated_at = Some(now);
        self.message = Some(detail);
        self.last_error = None;
        self.last_duration_ms = None;
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        true
    }

    fn begin_automatic(
        &mut self,
        now_wall: String,
        now_mono: Instant,
    ) -> Option<CaptureRecoveryAttemptTicket> {
        if self.phase != CaptureRecoveryPhase::Degraded
            || !matches!(
                self.stage,
                Some(CaptureRecoveryStage::CameraDelivery | CaptureRecoveryStage::ScreenDelivery)
            )
            || self.automatic_attempted
        {
            return None;
        }
        let scope = self.scope.clone()?;
        self.automatic_attempted = true;
        self.phase = CaptureRecoveryPhase::Restarting;
        self.trigger = Some(CaptureRecoveryTrigger::Automatic);
        self.attempts = self.attempts.saturating_add(1);
        self.updated_at = Some(now_wall);
        self.message = Some(format!(
            "Restarting the degraded {} capture source.",
            recovery_source_label(scope.source)
        ));
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        Some(CaptureRecoveryAttemptTicket {
            epoch: self.epoch,
            trigger: CaptureRecoveryTrigger::Automatic,
            scope,
            started_at: now_mono,
        })
    }

    fn begin_manual_retry(
        &mut self,
        now_wall: String,
        now_mono: Instant,
    ) -> Option<CaptureRecoveryAttemptTicket> {
        if self.phase != CaptureRecoveryPhase::Failed {
            return None;
        }
        let scope = self.retry_scope.clone()?;
        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.scope = Some(scope.clone());
        self.restarted_scope = None;
        self.retry_scope = None;
        self.compositor_adopted_scope = None;
        self.automatic_attempts_operator_latched = false;
        self.phase = CaptureRecoveryPhase::Restarting;
        self.trigger = Some(CaptureRecoveryTrigger::Manual);
        self.attempts = self.attempts.saturating_add(1);
        self.updated_at = Some(now_wall);
        self.message = Some(format!(
            "Retrying {} capture recovery.",
            recovery_source_label(scope.source)
        ));
        self.last_error = None;
        self.last_duration_ms = None;
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        Some(CaptureRecoveryAttemptTicket {
            epoch: self.epoch,
            trigger: CaptureRecoveryTrigger::Manual,
            scope,
            started_at: now_mono,
        })
    }

    fn begin_automatic_retry(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        retry_scope: CaptureRecoveryScope,
        now_wall: String,
        now_mono: Instant,
    ) -> Option<CaptureRecoveryAttemptTicket> {
        if !self.ticket_is_current(ticket)
            || ticket.trigger != CaptureRecoveryTrigger::Automatic
            || !matches!(
                self.phase,
                CaptureRecoveryPhase::Restarting | CaptureRecoveryPhase::Verifying
            )
            || self.automatic_attempts_operator_latched
            || self.attempts >= MAX_AUTOMATIC_ATTEMPTS
            || retry_scope.source != ticket.scope.source
            || retry_scope.source_key != ticket.scope.source_key
            || retry_scope.generation == ticket.scope.generation
        {
            return None;
        }

        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.scope = Some(retry_scope.clone());
        self.restarted_scope = None;
        self.retry_scope = None;
        self.compositor_adopted_scope = None;
        self.phase = CaptureRecoveryPhase::Restarting;
        self.trigger = Some(CaptureRecoveryTrigger::Automatic);
        self.attempts = self.attempts.saturating_add(1);
        self.updated_at = Some(now_wall);
        self.message = Some(format!(
            "Retrying the degraded {} capture source automatically (attempt {} of {}).",
            recovery_source_label(retry_scope.source),
            self.attempts,
            MAX_AUTOMATIC_ATTEMPTS
        ));
        self.last_error = None;
        self.last_duration_ms = None;
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        Some(CaptureRecoveryAttemptTicket {
            epoch: self.epoch,
            trigger: CaptureRecoveryTrigger::Automatic,
            scope: retry_scope,
            started_at: now_mono,
        })
    }

    fn restart_succeeded(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        evidence: &CaptureRecoveryRestartEvidence,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket)
            || !(self.phase == CaptureRecoveryPhase::Restarting
                || (self.phase == CaptureRecoveryPhase::Failed && self.watchdog_expired))
        {
            return None;
        }
        if ticket.scope.source != evidence.scope.source
            || ticket.scope.source_key != evidence.scope.source_key
            || ticket.scope.generation == evidence.scope.generation
        {
            return self.fail_current_attempt(
                ticket,
                "Capture restart returned invalid source-generation evidence.".to_string(),
                None,
                now,
            );
        }

        self.restarted_scope = Some(evidence.scope.clone());
        self.retry_scope = None;
        self.phase = CaptureRecoveryPhase::Verifying;
        self.updated_at = Some(now);
        self.message = Some(format!(
            "Capture source restarted at generation {}; verifying cadence.",
            evidence.scope.generation
        ));
        self.cadence_verified_message = None;
        self.advance_revision();
        Some(self.status())
    }

    fn restart_superseded(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket) {
            return None;
        }
        self.clear_camera_and_reveal_render();
        Some(self.status())
    }

    fn restart_failed(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        error: String,
        retry_scope: Option<CaptureRecoveryScope>,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        self.fail_current_attempt(ticket, error, retry_scope, now)
    }

    fn verification_recovered(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        message: String,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket)
            || !(self.phase == CaptureRecoveryPhase::Verifying
                || (self.phase == CaptureRecoveryPhase::Failed && self.watchdog_expired))
        {
            return None;
        }
        self.last_duration_ms = finite_duration_ms(ticket.started_at.elapsed());
        self.updated_at = Some(now);
        self.last_error = None;
        self.watchdog_expired = false;
        if self
            .restarted_scope
            .as_ref()
            .is_some_and(|scope| self.compositor_adopted_scope.as_ref() == Some(scope))
        {
            if self.render_incident.is_some() {
                self.clear_camera_and_reveal_render();
                return Some(self.status());
            } else {
                self.scope = self.restarted_scope.take().or_else(|| self.scope.take());
                self.retry_scope = None;
                self.phase = CaptureRecoveryPhase::Recovered;
                self.message = Some(message);
                self.cadence_verified_message = None;
            }
        } else {
            self.phase = CaptureRecoveryPhase::Verifying;
            self.cadence_verified_message = Some(message);
            let source_label = self
                .restarted_scope
                .as_ref()
                .map(|scope| recovery_source_label(scope.source))
                .unwrap_or("capture");
            self.message = Some(format!(
                "{} cadence recovered; waiting for the compositor to adopt the exact replacement generation.",
                source_label.to_ascii_uppercase()
            ));
        }
        self.advance_revision();
        Some(self.status())
    }

    fn verification_superseded(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket)
            || (self.phase == CaptureRecoveryPhase::Failed && !self.watchdog_expired)
        {
            return None;
        }
        self.clear_camera_and_reveal_render();
        Some(self.status())
    }

    fn verification_failed(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        error: String,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket)
            || !(self.phase == CaptureRecoveryPhase::Verifying
                || (self.phase == CaptureRecoveryPhase::Failed && self.watchdog_expired))
        {
            return None;
        }
        if ticket.trigger == CaptureRecoveryTrigger::Automatic {
            self.automatic_attempts_operator_latched = true;
        }
        self.scope = self.restarted_scope.take().or_else(|| self.scope.take());
        self.retry_scope = self.scope.clone();
        self.phase = CaptureRecoveryPhase::Failed;
        self.updated_at = Some(now);
        self.message = Some(
            "Capture recovery failed. Use Restart capture to retry once you are ready.".to_string(),
        );
        self.last_error = Some(error);
        self.last_duration_ms = finite_duration_ms(ticket.started_at.elapsed());
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        Some(self.status())
    }

    fn observe_pipeline_recovered(
        &mut self,
        stage: CaptureRecoveryStage,
        detail: String,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        match stage {
            CaptureRecoveryStage::CompositorRender => {
                self.render_incident = None;
                if self.stage != Some(CaptureRecoveryStage::CompositorRender)
                    || self.phase != CaptureRecoveryPhase::Degraded
                {
                    // A render recovery clears only the retained render
                    // authority. Camera recovery/failure remains untouched.
                    return None;
                }
            }
            CaptureRecoveryStage::CameraDelivery | CaptureRecoveryStage::ScreenDelivery => {
                // A generic health edge cannot certify an in-flight restart
                // and must never clear an explicit failure latch.
                if self.phase != CaptureRecoveryPhase::Degraded || self.stage != Some(stage) {
                    return None;
                }
                if self.render_incident.is_some() {
                    self.clear_camera_and_reveal_render();
                    return Some(self.status());
                }
            }
        }
        if self.phase != CaptureRecoveryPhase::Degraded || self.stage != Some(stage) {
            return None;
        }
        self.phase = CaptureRecoveryPhase::Recovered;
        self.updated_at = Some(now);
        self.message = Some(detail);
        self.advance_revision();
        Some(self.status())
    }

    fn recovered_guard(&self) -> Option<CaptureRecoveryRecoveredGuard> {
        (self.phase == CaptureRecoveryPhase::Recovered).then(|| CaptureRecoveryRecoveredGuard {
            epoch: self.epoch,
            stage: self.stage,
            scope: self.scope.clone(),
        })
    }

    fn reset_recovered_if_current(
        &mut self,
        guard: &CaptureRecoveryRecoveredGuard,
    ) -> Option<CaptureRecoveryStatus> {
        if self.phase != CaptureRecoveryPhase::Recovered
            || self.epoch != guard.epoch
            || self.stage != guard.stage
            || self.scope != guard.scope
        {
            return None;
        }
        if matches!(
            guard.stage,
            Some(CaptureRecoveryStage::CameraDelivery | CaptureRecoveryStage::ScreenDelivery)
        ) {
            self.clear_camera_and_reveal_render();
        } else {
            self.reset_to_idle();
        }
        Some(self.status())
    }

    fn fail_unroutable_degradation(
        &mut self,
        error: String,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if self.phase != CaptureRecoveryPhase::Degraded || self.scope.is_some() {
            return None;
        }
        self.phase = CaptureRecoveryPhase::Failed;
        self.updated_at = Some(now);
        self.message = Some(
            "Capture degradation was detected, but the active source changed before a safe restart could be admitted."
                .to_string(),
        );
        self.last_error = Some(error);
        self.retry_scope = None;
        self.cadence_verified_message = None;
        self.advance_revision();
        Some(self.status())
    }

    fn observe_compositor_source(
        &mut self,
        source: CaptureRecoverySource,
        observed: Option<CaptureRecoveryScope>,
    ) -> Option<CaptureRecoveryStatus> {
        let expected_stage = match source {
            CaptureRecoverySource::Camera => CaptureRecoveryStage::CameraDelivery,
            CaptureRecoverySource::Screen => CaptureRecoveryStage::ScreenDelivery,
        };
        if self.stage != Some(expected_stage)
            || observed
                .as_ref()
                .is_some_and(|observed| observed.source != source)
        {
            return None;
        }

        match self.phase {
            CaptureRecoveryPhase::Restarting => match observed {
                Some(scope)
                    if self.scope.as_ref().is_some_and(|expected| {
                        expected.source == scope.source
                            && expected.source_key == scope.source_key
                            && expected.generation != scope.generation
                    }) =>
                {
                    // This is the expected internal recovery handoff. It is
                    // evidence for verification, never source-epoch invalidation.
                    self.compositor_adopted_scope = Some(scope);
                }
                Some(scope)
                    if self
                        .scope
                        .as_ref()
                        .is_some_and(|expected| expected.source_key != scope.source_key) =>
                {
                    self.clear_camera_and_reveal_render();
                    return Some(self.status());
                }
                // Recovery intentionally removes the old source before the
                // replacement starts, so None cannot invalidate Restarting.
                _ => {}
            },
            CaptureRecoveryPhase::Verifying => {
                // The compositor can report the intentional old-generation
                // removal after the replacement is already live and the
                // driver has entered Verifying. Generic None is therefore not
                // generation-bound evidence. Explicit camera mutation owns
                // operator removal, while driver verification detects a
                // replacement that really disappeared.
                let scope = observed?;
                // Likewise, a delayed adoption for the retired generation can
                // arrive after the replacement entered Verifying. Only the
                // exact replacement scope may advance recovery; every other
                // compositor cache observation is neutral and the generation-
                // bound driver decides whether verification was superseded.
                if self.restarted_scope.as_ref() == Some(&scope) {
                    self.compositor_adopted_scope = Some(scope);
                    if let Some(message) = self.cadence_verified_message.take() {
                        if self.render_incident.is_some() {
                            self.clear_camera_and_reveal_render();
                            return Some(self.status());
                        }
                        self.scope = self.restarted_scope.take().or_else(|| self.scope.take());
                        self.retry_scope = None;
                        self.phase = CaptureRecoveryPhase::Recovered;
                        self.updated_at = Some(now_timestamp());
                        self.message = Some(message);
                        self.last_error = None;
                        self.advance_revision();
                        return Some(self.status());
                    }
                }
            }
            CaptureRecoveryPhase::Degraded
            | CaptureRecoveryPhase::Recovered
            | CaptureRecoveryPhase::Failed => {
                let current_scope = self.restarted_scope.as_ref().or(self.scope.as_ref());
                if self.phase == CaptureRecoveryPhase::Failed
                    && self.watchdog_expired
                    && current_scope.is_some_and(|current| {
                        observed.as_ref().is_none_or(|next| {
                            next.source == current.source && next.source_key == current.source_key
                        })
                    })
                {
                    // A restart which physically finishes after its public
                    // watchdog may first remove the old source and then adopt
                    // a late same-key generation. Both edges belong to that
                    // timed-out attempt. Preserve the terminal status until an
                    // explicit camera mutation.
                    if let Some(next) = observed
                        && current_scope.is_some_and(|current| {
                            next.source == current.source
                                && next.source_key == current.source_key
                                && next.generation != current.generation
                        })
                    {
                        self.compositor_adopted_scope = Some(next);
                    }
                    return None;
                }
                let unscoped_failure_gained_a_source = self.phase == CaptureRecoveryPhase::Failed
                    && current_scope.is_none()
                    && observed.is_some();
                if unscoped_failure_gained_a_source
                    || (current_scope.is_some() && observed.as_ref() != current_scope)
                {
                    self.clear_camera_and_reveal_render();
                    return Some(self.status());
                }
            }
            CaptureRecoveryPhase::Idle => {}
        }
        None
    }

    fn observe_compositor_camera_source(
        &mut self,
        observed: Option<CaptureRecoveryScope>,
    ) -> Option<CaptureRecoveryStatus> {
        self.observe_compositor_source(CaptureRecoverySource::Camera, observed)
    }

    fn observe_compositor_screen_source(
        &mut self,
        observed: Option<CaptureRecoveryScope>,
    ) -> Option<CaptureRecoveryStatus> {
        self.observe_compositor_source(CaptureRecoverySource::Screen, observed)
    }

    fn explicit_camera_configuration_changed(&mut self) -> Option<CaptureRecoveryStatus> {
        if self.stage != Some(CaptureRecoveryStage::CameraDelivery)
            || self.phase == CaptureRecoveryPhase::Idle
        {
            return None;
        }
        self.clear_camera_and_reveal_render();
        Some(self.status())
    }

    fn attempt_watchdog_expired(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        watchdog_stage: CaptureRecoveryWatchdogStage,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket) || self.phase != watchdog_stage.phase() {
            return None;
        }

        let source_label = recovery_source_label(ticket.scope.source);
        let error = match (watchdog_stage, ticket.scope.source) {
            (
                CaptureRecoveryWatchdogStage::ScreenTeardown,
                CaptureRecoverySource::Screen,
            ) => "screen teardown is still pending beyond the recovery latency contract. Native ownership remains exclusive; replacement startup is still process-owned and cannot overlap it."
                .to_string(),
            (
                CaptureRecoveryWatchdogStage::Restarting,
                CaptureRecoverySource::Screen,
            ) => "screen native startup did not complete within the ScreenCaptureKit recovery latency contract after the previous owner retired. Native ownership remains exclusive."
                .to_string(),
            (
                CaptureRecoveryWatchdogStage::Restarting,
                CaptureRecoverySource::Camera,
            ) => format!(
                "{source_label} teardown is still pending beyond the recovery latency contract. Native ownership remains exclusive; no replacement will start until teardown really finishes."
            ),
            (
                CaptureRecoveryWatchdogStage::ScreenTeardown,
                CaptureRecoverySource::Camera,
            ) => unreachable!("screen teardown watchdog cannot own a camera ticket"),
            (CaptureRecoveryWatchdogStage::Verifying, _) => format!(
                "{source_label} recovery verification did not complete within the bounded recovery latency contract."
            ),
        };
        if ticket.trigger == CaptureRecoveryTrigger::Automatic {
            self.automatic_attempts_operator_latched = true;
        }
        self.retry_scope = None;
        self.phase = CaptureRecoveryPhase::Failed;
        self.updated_at = Some(now);
        self.message = Some(
            "Capture recovery exceeded its bounded latency contract; native capture ownership remains exclusive."
                .to_string(),
        );
        self.last_error = Some(error);
        self.last_duration_ms = finite_duration_ms(ticket.started_at.elapsed());
        self.cadence_verified_message = None;
        self.watchdog_expired = true;
        self.advance_revision();
        Some(self.status())
    }

    fn fail_current_attempt(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        error: String,
        retry_scope: Option<CaptureRecoveryScope>,
        now: String,
    ) -> Option<CaptureRecoveryStatus> {
        if !self.ticket_is_current(ticket)
            || !(self.phase == CaptureRecoveryPhase::Restarting
                || (self.phase == CaptureRecoveryPhase::Failed && self.watchdog_expired))
        {
            return None;
        }
        if ticket.trigger == CaptureRecoveryTrigger::Automatic {
            self.automatic_attempts_operator_latched = true;
        }
        self.phase = CaptureRecoveryPhase::Failed;
        let retryable = retry_scope.is_some();
        if let Some(retry_scope) = retry_scope {
            self.scope = Some(retry_scope.clone());
            self.restarted_scope = None;
            self.retry_scope = Some(retry_scope);
        } else {
            self.retry_scope = None;
        }
        self.updated_at = Some(now);
        self.message = Some(if retryable {
            "Capture recovery failed. Use Restart capture to retry once you are ready.".to_string()
        } else {
            "Capture recovery failed, and the source is no longer safe to restart automatically."
                .to_string()
        });
        self.last_error = Some(error);
        self.last_duration_ms = finite_duration_ms(ticket.started_at.elapsed());
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.advance_revision();
        Some(self.status())
    }

    fn ticket_is_current(&self, ticket: &CaptureRecoveryAttemptTicket) -> bool {
        self.epoch == ticket.epoch
            && self.trigger == Some(ticket.trigger)
            && self.scope.as_ref() == Some(&ticket.scope)
    }

    fn claim_terminal_automatic_camera_warning(
        &mut self,
        ticket: &CaptureRecoveryAttemptTicket,
        status: Option<&CaptureRecoveryStatus>,
    ) -> bool {
        if self.terminal_camera_warning_emitted
            || !is_terminal_automatic_camera_failure(ticket, status)
        {
            return false;
        }
        self.terminal_camera_warning_emitted = true;
        true
    }

    fn restart_ticket_is_admitted(&self, ticket: &CaptureRecoveryAttemptTicket) -> bool {
        self.phase == CaptureRecoveryPhase::Restarting && self.ticket_is_current(ticket)
    }

    fn clear_camera_and_reveal_render(&mut self) {
        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.scope = None;
        self.restarted_scope = None;
        self.retry_scope = None;
        self.compositor_adopted_scope = None;
        self.trigger = None;
        self.attempts = 0;
        self.automatic_attempted = false;
        self.automatic_attempts_operator_latched = false;
        self.terminal_camera_warning_emitted = false;
        self.last_error = None;
        self.last_duration_ms = None;
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        if let Some(render) = self.render_incident.as_ref() {
            self.phase = CaptureRecoveryPhase::Degraded;
            self.stage = Some(CaptureRecoveryStage::CompositorRender);
            self.detected_at = Some(render.detected_at.clone());
            self.updated_at = Some(render.updated_at.clone());
            self.message = Some(render.detail.clone());
        } else {
            self.phase = CaptureRecoveryPhase::Idle;
            self.stage = None;
            self.detected_at = None;
            self.updated_at = None;
            self.message = None;
        }
        self.advance_revision();
    }

    fn reset_to_idle(&mut self) {
        self.epoch = self.epoch.wrapping_add(1).max(1);
        self.phase = CaptureRecoveryPhase::Idle;
        self.stage = None;
        self.scope = None;
        self.restarted_scope = None;
        self.retry_scope = None;
        self.compositor_adopted_scope = None;
        self.trigger = None;
        self.attempts = 0;
        self.automatic_attempted = false;
        self.automatic_attempts_operator_latched = false;
        self.terminal_camera_warning_emitted = false;
        self.detected_at = None;
        self.updated_at = None;
        self.message = None;
        self.last_error = None;
        self.last_duration_ms = None;
        self.cadence_verified_message = None;
        self.watchdog_expired = false;
        self.render_incident = None;
        self.advance_revision();
    }
}

fn finite_duration_ms(duration: Duration) -> Option<f64> {
    let duration_ms = duration.as_secs_f64() * 1_000.0;
    (duration_ms.is_finite() && duration_ms >= 0.0).then_some(duration_ms)
}

fn verify_compositor_delivery_rate(
    baseline_fresh_serves: u64,
    current_fresh_serves: u64,
    elapsed: Duration,
    camera_target_fps: u32,
    compositor_target_fps: u32,
) -> Result<(f64, f64), String> {
    if elapsed < CAPTURE_RECOVERY_DOWNSTREAM_RATE_WINDOW {
        return Err("Downstream compositor verification window is not yet meaningful.".to_string());
    }
    let elapsed_secs = elapsed.as_secs_f64();
    let required_fps =
        f64::from(camera_target_fps.min(compositor_target_fps)) * DEGRADED_RATE_FRACTION;
    if !elapsed_secs.is_finite()
        || elapsed_secs <= 0.0
        || !required_fps.is_finite()
        || required_fps <= 0.0
    {
        return Err("Downstream compositor cadence contract is invalid.".to_string());
    }
    let fresh_delta = current_fresh_serves.saturating_sub(baseline_fresh_serves);
    let fresh_fps = fresh_delta as f64 / elapsed_secs;
    if !fresh_fps.is_finite() || fresh_fps < required_fps {
        return Err(format!(
            "Compositor fresh camera serves remained at {fresh_fps:.1}fps, below the required {required_fps:.1}fps."
        ));
    }
    Ok((fresh_fps, required_fps))
}

fn verify_camera_recovery_evidence(
    baseline: &PreviewCameraRecoveryEvidence,
    current: &PreviewCameraRecoveryEvidence,
    elapsed: Duration,
) -> Result<String, String> {
    if baseline.source_key != current.source_key || baseline.generation != current.generation {
        return Err(
            "Camera recovery evidence changed source generation during verification.".to_string(),
        );
    }
    if baseline.target_fps == 0 || current.target_fps != baseline.target_fps {
        return Err("Camera recovery has no stable positive target cadence.".to_string());
    }
    let elapsed_secs = elapsed.as_secs_f64();
    if !elapsed_secs.is_finite() || elapsed_secs <= 0.0 {
        return Err("Camera recovery verification window was not measurable.".to_string());
    }
    let callback_delta = current
        .capture_callback_count
        .saturating_sub(baseline.capture_callback_count);
    let publication_delta = current
        .frame_store_publications
        .saturating_sub(baseline.frame_store_publications);
    let callback_fps = callback_delta as f64 / elapsed_secs;
    let publication_fps = publication_delta as f64 / elapsed_secs;
    let required_fps = f64::from(current.target_fps) * DEGRADED_RATE_FRACTION;
    if !callback_fps.is_finite() || callback_fps < required_fps {
        return Err(format!(
            "Camera callbacks did not recover: measured {callback_fps:.1}fps, required {required_fps:.1}fps over {elapsed_secs:.1}s."
        ));
    }
    if !publication_fps.is_finite() || publication_fps < required_fps {
        return Err(format!(
            "Camera FrameStore publications did not recover: measured {publication_fps:.1}fps, required {required_fps:.1}fps over {elapsed_secs:.1}s."
        ));
    }

    let sequence_advanced = match (baseline.latest_sequence, current.latest_sequence) {
        (Some(previous), Some(current)) => current > previous,
        (None, Some(current)) => current > 0,
        _ => false,
    };
    if !sequence_advanced {
        return Err("Camera recovery produced no advancing FrameStore sequence.".to_string());
    }

    let frame_age_limit_ms = (4_000_u64 / u64::from(current.target_fps)).max(500);
    if !current
        .frame_age_ms
        .is_some_and(|age_ms| age_ms <= frame_age_limit_ms)
    {
        return Err(format!(
            "Camera recovery did not publish a fresh frame within {frame_age_limit_ms}ms."
        ));
    }

    let requested_geometry = baseline
        .requested_width
        .zip(baseline.requested_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    let current_requested_geometry = current.requested_width.zip(current.requested_height);
    if requested_geometry.is_none() || current_requested_geometry != requested_geometry {
        return Err(format!(
            "Camera recovery request geometry changed: baseline {:?}, current {:?}.",
            requested_geometry, current_requested_geometry
        ));
    }

    let configured_geometry = baseline
        .configured_width
        .zip(baseline.configured_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    let current_configured_geometry = current.configured_width.zip(current.configured_height);
    if configured_geometry.is_none() || current_configured_geometry != configured_geometry {
        return Err(format!(
            "Camera recovery configured geometry changed: baseline {:?}, current {:?}.",
            configured_geometry, current_configured_geometry
        ));
    }

    let baseline_actual_geometry = baseline
        .actual_width
        .zip(baseline.actual_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    let current_actual_geometry = current
        .actual_width
        .zip(current.actual_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    if baseline_actual_geometry.is_some_and(|actual| Some(actual) != configured_geometry)
        || current_actual_geometry != configured_geometry
    {
        return Err(format!(
            "Camera recovery geometry mismatch: configured {:?}, baseline actual {:?}, current actual {:?}, requested {:?}.",
            configured_geometry,
            baseline_actual_geometry,
            current_actual_geometry,
            requested_geometry
        ));
    }

    Ok(format!(
        "Camera recovery verified generation {}: callbacks {callback_fps:.1}fps, publications {publication_fps:.1}fps, fresh geometry {:?}.",
        current.generation, current_actual_geometry
    ))
}

fn verify_screen_recovery_evidence(
    baseline: &PreviewScreenRecoveryEvidence,
    current: &PreviewScreenRecoveryEvidence,
    elapsed: Duration,
) -> Result<String, String> {
    if baseline.source_key != current.source_key || baseline.generation != current.generation {
        return Err(
            "Screen recovery evidence changed source generation during verification.".to_string(),
        );
    }
    if baseline.target_fps == 0 || current.target_fps != baseline.target_fps {
        return Err("Screen recovery has no stable positive target cadence.".to_string());
    }
    let elapsed_secs = elapsed.as_secs_f64();
    if !elapsed_secs.is_finite() || elapsed_secs <= 0.0 {
        return Err("Screen recovery verification window was not measurable.".to_string());
    }
    let callback_fps = current
        .capture_callback_count
        .saturating_sub(baseline.capture_callback_count) as f64
        / elapsed_secs;
    let publication_fps = current
        .frame_store_publications
        .saturating_sub(baseline.frame_store_publications) as f64
        / elapsed_secs;
    let required_fps = f64::from(current.target_fps) * DEGRADED_RATE_FRACTION;
    if !callback_fps.is_finite() || callback_fps < required_fps {
        return Err(format!(
            "Screen callbacks did not recover: measured {callback_fps:.1}fps, required {required_fps:.1}fps over {elapsed_secs:.1}s."
        ));
    }
    if !publication_fps.is_finite() || publication_fps < required_fps {
        return Err(format!(
            "Screen FrameStore publications did not recover: measured {publication_fps:.1}fps, required {required_fps:.1}fps over {elapsed_secs:.1}s."
        ));
    }
    let sequence_advanced = match (baseline.latest_sequence, current.latest_sequence) {
        (Some(previous), Some(current)) => current > previous,
        (None, Some(current)) => current > 0,
        _ => false,
    };
    if !sequence_advanced {
        return Err("Screen recovery produced no advancing FrameStore sequence.".to_string());
    }
    let frame_age_limit_ms = (4_000_u64 / u64::from(current.target_fps)).max(500);
    if !current
        .frame_age_ms
        .is_some_and(|age_ms| age_ms <= frame_age_limit_ms)
    {
        return Err(format!(
            "Screen recovery did not publish a fresh frame within {frame_age_limit_ms}ms."
        ));
    }
    let baseline_configured = (baseline.configured_width, baseline.configured_height);
    let current_configured = (current.configured_width, current.configured_height);
    if baseline_configured.0 == 0
        || baseline_configured.1 == 0
        || current_configured != baseline_configured
    {
        return Err(format!(
            "Screen recovery configured geometry changed: baseline {:?}, current {:?}.",
            baseline_configured, current_configured
        ));
    }
    let baseline_actual = baseline
        .actual_width
        .zip(baseline.actual_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    let current_actual = current
        .actual_width
        .zip(current.actual_height)
        .filter(|(width, height)| *width > 0 && *height > 0);
    if current_actual.is_none()
        || baseline_actual.is_some_and(|geometry| Some(geometry) != current_actual)
    {
        return Err(format!(
            "Screen recovery geometry mismatch: baseline actual {:?}, current actual {:?}, configured {:?}.",
            baseline_actual, current_actual, baseline_configured
        ));
    }

    Ok(format!(
        "Screen recovery verified generation {}: callbacks {callback_fps:.1}fps, publications {publication_fps:.1}fps, fresh geometry {:?}.",
        current.generation, current_actual
    ))
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339()
}

async fn publish_recovery_status(state: &AppState, status: CaptureRecoveryStatus) -> bool {
    // Renderer events are emitted synchronously at the coordinator commit
    // edge. This ancillary path mirrors only the latest authoritative status
    // into diagnostics and may safely be delayed or cancelled.
    let mut diagnostics = state.diagnostics.lock().await;
    let mut published_revision = state.capture_recovery_published_revision.lock().await;
    if status.revision <= *published_revision {
        return false;
    }
    let coordinator = state.capture_recovery.lock().await;
    if status.revision != coordinator.status().revision {
        return false;
    }
    *diagnostics = apply_capture_recovery_status(diagnostics.clone(), &status);
    *published_revision = status.revision;
    true
}

/// Must be called while the coordinator mutation lock is still held. Event
/// order then exactly matches revision order and cannot be changed by task
/// scheduling or diagnostics-lock contention.
fn emit_recovery_status_at_commit(state: &AppState, status: &CaptureRecoveryStatus) {
    state.emit_event("capture.recovery.status", status);
}

fn emit_terminal_camera_recovery_warning(state: &AppState) {
    let _ = crate::recording::emit_health_event(
        state,
        None,
        HealthLevel::Warn,
        "camera-degraded-restart-failed",
        "The camera is delivering frames far below its target rate and automatic restarts did not recover it. Check the camera connection, or restart Videorc.",
    );
}

fn is_terminal_automatic_camera_failure(
    ticket: &CaptureRecoveryAttemptTicket,
    status: Option<&CaptureRecoveryStatus>,
) -> bool {
    ticket.trigger == CaptureRecoveryTrigger::Automatic
        && ticket.scope.source == CaptureRecoverySource::Camera
        && status.is_some_and(|status| status.phase == CaptureRecoveryPhase::Failed)
}

fn schedule_recovery_status_publication(state: &AppState, status: CaptureRecoveryStatus) {
    let publish_state = state.clone();
    state.spawn_process_task(async move {
        publish_recovery_status(&publish_state, status).await;
    });
}

fn schedule_recovered_reset(state: AppState, guard: CaptureRecoveryRecoveredGuard) {
    let spawn_state = state.clone();
    state.spawn_process_task(async move {
        tokio::time::sleep(CAPTURE_RECOVERY_RECOVERED_DWELL).await;
        let idle = {
            let mut coordinator = spawn_state.capture_recovery.lock().await;
            let status = coordinator.reset_recovered_if_current(&guard);
            if let Some(status) = status.as_ref() {
                emit_recovery_status_at_commit(&spawn_state, status);
            }
            status
        };
        if let Some(idle) = idle {
            publish_recovery_status(&spawn_state, idle).await;
        }
    });
}

async fn schedule_reset_if_recovered(state: &AppState) {
    let guard = state.capture_recovery.lock().await.recovered_guard();
    if let Some(guard) = guard {
        schedule_recovered_reset(state.clone(), guard);
    }
}

async fn commit_compositor_camera_source_observation(
    state: &AppState,
    observed: Option<CaptureRecoveryScope>,
) -> Option<CaptureRecoveryStatus> {
    let mut coordinator = state.capture_recovery.lock().await;
    let mut admission = state.lock_capture_recovery_admission_gate();
    let camera_mutation_epoch = admission.camera_mutation_epoch();
    let explicit_camera_mutation_supersedes = admission.explicit_camera_mutation_is_active()
        || camera_mutation_epoch != coordinator.camera_mutation_epoch;
    let status = if explicit_camera_mutation_supersedes {
        // Linearize the compositor acknowledgement against the synchronous
        // transaction boundary. An observation sampled before an operator
        // camera/layout mutation cannot complete recovery inside that mutation.
        coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch)
    } else {
        coordinator.observe_compositor_camera_source(observed)
    };
    if let Some(status) = status.as_ref() {
        // Revoke only the admission owned by this observation while the
        // coordinator -> admission linearization guards are still held. A
        // later degradation may admit a newer epoch immediately after this
        // commit; no post-commit tail may clear that newer ticket.
        admission.revoke_admission();
        emit_recovery_status_at_commit(state, status);
    }
    status
}

/// Exact compositor-adoption acknowledgement. The compositor calls this only
/// after replacing its cached camera source, not merely after observing camera
/// runtime status. Recovery verification consumes the matching generation.
pub(crate) async fn note_compositor_camera_source_adopted(
    state: &AppState,
    source_key: SourceKey,
    generation: u64,
) {
    // Reject an older/delayed adoption if a newer preview generation became
    // current before this acknowledgement ran; otherwise a late N edge could
    // erase verification for the already-adopted N+1 generation.
    if !preview_camera_restart_snapshot(state)
        .await
        .is_some_and(|snapshot| {
            snapshot.source_key == source_key && snapshot.generation == generation
        })
    {
        return;
    }
    let status = commit_compositor_camera_source_observation(
        state,
        Some(CaptureRecoveryScope::camera(source_key, generation)),
    )
    .await;
    if let Some(status) = status {
        let recovered = status.phase == CaptureRecoveryPhase::Recovered;
        if recovered {
            schedule_reset_if_recovered(state).await;
        }
        publish_recovery_status(state, status).await;
    }
}

/// Camera removal is a source-epoch edge unless it is the intentional gap
/// inside a recovery restart. A retained failed-start token also keeps its
/// incident alive: that exact no-active state is what manual retry repairs.
pub(crate) async fn note_compositor_camera_source_removed(state: &AppState) {
    // If a camera is already live again, this removal belongs to an older cache
    // refresh and must not erase Verifying after the exact adoption edge.
    if preview_camera_restart_snapshot(state).await.is_some() {
        return;
    }

    let retained_failed_scope = {
        let coordinator = state.capture_recovery.lock().await;
        coordinator
            .reconciliation_target()
            .and_then(|(phase, scope)| (phase == CaptureRecoveryPhase::Failed).then_some(scope))
    };
    if let Some(scope) = retained_failed_scope
        && failed_preview_camera_retry_is_current(state, &scope.source_key, scope.generation).await
    {
        return;
    }

    let status = commit_compositor_camera_source_observation(state, None).await;
    if let Some(status) = status {
        publish_recovery_status(state, status).await;
    }
}

async fn commit_compositor_screen_source_observation(
    state: &AppState,
    observed: Option<CaptureRecoveryScope>,
) -> Option<CaptureRecoveryStatus> {
    let mut coordinator = state.capture_recovery.lock().await;
    let mut admission = state.lock_capture_recovery_admission_gate();
    let status = coordinator.observe_compositor_screen_source(observed);
    if let Some(status) = status.as_ref() {
        admission.revoke_admission();
        emit_recovery_status_at_commit(state, status);
    }
    status
}

/// Exact compositor-cache acknowledgement for a replacement screen/window
/// generation. Verification consumes only this generation and its matching
/// fresh-serve counter.
pub(crate) async fn note_compositor_screen_source_adopted(
    state: &AppState,
    source_key: SourceKey,
    generation: u64,
) {
    if !preview_screen_restart_snapshot(state)
        .await
        .is_some_and(|snapshot| {
            snapshot.source_key == source_key && snapshot.generation == generation
        })
    {
        return;
    }
    let status = commit_compositor_screen_source_observation(
        state,
        Some(CaptureRecoveryScope::screen(source_key, generation)),
    )
    .await;
    if let Some(status) = status {
        if status.phase == CaptureRecoveryPhase::Recovered {
            schedule_reset_if_recovered(state).await;
        }
        publish_recovery_status(state, status).await;
    }
}

/// A transient None during the admitted restart is neutral. Any other exact
/// screen removal retires a stale scoped incident unless its failed retry
/// token still owns that no-active state.
pub(crate) async fn note_compositor_screen_source_removed(state: &AppState) {
    if preview_screen_restart_snapshot(state).await.is_some() {
        return;
    }
    let retained_failed_scope = {
        let coordinator = state.capture_recovery.lock().await;
        coordinator
            .reconciliation_target()
            .and_then(|(phase, scope)| {
                (phase == CaptureRecoveryPhase::Failed
                    && scope.source == CaptureRecoverySource::Screen)
                    .then_some(scope)
            })
    };
    if let Some(scope) = retained_failed_scope
        && failed_preview_screen_retry_is_current(state, &scope.source_key, scope.generation).await
    {
        return;
    }
    let status = commit_compositor_screen_source_observation(state, None).await;
    if let Some(status) = status {
        publish_recovery_status(state, status).await;
    }
}

/// Explicit camera selection/configuration mutations supersede any recovery
/// incident, including a failure that was latched after the compositor had
/// already observed `None`. This is the authoritative reconciliation edge;
/// read-only status/diagnostics queries never mutate recovery state.
pub(crate) async fn note_explicit_camera_configuration_changed(state: &AppState) {
    #[cfg(debug_assertions)]
    {
        state
            .capture_recovery_smoke_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active = None;
    }
    let status = {
        let mut coordinator = state.capture_recovery.lock().await;
        // The preview-locked synchronous gate published the mutation boundary
        // and invalidated physical admission before the operator mutation.
        // Reconciliation adopts that exact already-visible epoch; it never
        // creates a second boundary after scene/config commit.
        let status = coordinator
            .reconcile_camera_mutation_epoch(state.capture_recovery_camera_mutation_epoch());
        if let Some(status) = status.as_ref() {
            emit_recovery_status_at_commit(state, status);
        }
        status
    };
    if let Some(status) = status {
        publish_recovery_status(state, status).await;
    }
}

/// Bind recovery health ordering and render incidents to one compositor run.
/// A run retirement/replacement clears stale run-scoped render/verification
/// authority, but cannot cancel a camera restart that may already own native
/// teardown.
pub(crate) async fn note_compositor_lifecycle_changed(
    state: &AppState,
    compositor_run_id: Option<String>,
) {
    if compositor_run_id.is_none() {
        *state
            .capture_recovery_compositor_evidence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            CaptureRecoveryCompositorEvidenceSet::default();
    }
    state
        .capture_health_stage_latches
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear_all();
    let status = {
        let mut coordinator = state.capture_recovery.lock().await;
        let changed = coordinator.compositor_run_id != compositor_run_id;
        // A preview/recording compositor replacement is downstream churn, not
        // an operator camera mutation. Once the physical camera restart has
        // been admitted, revoking it here can strand the source after the old
        // owner was removed but before its native join completed. Verification
        // remains run-scoped and will retire neutrally after the driver returns.
        let preserve_physical_camera_restart =
            coordinator.camera_restart_may_own_physical_transition();
        let status = coordinator.observe_compositor_lifecycle(compositor_run_id);
        if changed && !preserve_physical_camera_restart {
            state.invalidate_capture_recovery_admission();
        }
        if let Some(status) = status.as_ref() {
            emit_recovery_status_at_commit(state, status);
        }
        status
    };
    let diagnostics_state = state.clone();
    state.spawn_process_task(async move {
        publish_current_capture_health_diagnostics(&diagnostics_state).await;
    });
    if let Some(status) = status {
        schedule_recovery_status_publication(state, status);
    }
}

async fn publish_current_capture_health_diagnostics(state: &AppState) {
    let diagnostics = {
        let mut diagnostics = state.diagnostics.lock().await;
        let latches = state
            .capture_health_stage_latches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = apply_capture_health(
            diagnostics.clone(),
            latches.current().map(|stage| stage.label()),
        );
        *diagnostics = next.clone();
        next
    };
    state.emit_event("diagnostics.stats", diagnostics);
}

pub(crate) async fn capture_recovery_status(state: &AppState) -> CaptureRecoveryStatus {
    state.capture_recovery.lock().await.status()
}

/// Deterministic cross-module seam for native camera transition tests. It
/// models the coordinator + physical-admission state created by a real
/// camera-delivery health edge without requiring the compositor sampler.
#[cfg(test)]
pub(crate) async fn test_admit_camera_recovery_attempt(
    state: &AppState,
    source_key: SourceKey,
    generation: u64,
) -> u64 {
    let ticket = {
        let mut coordinator = state.capture_recovery.lock().await;
        assert!(
            coordinator.observe_degraded(
                CaptureRecoveryStage::CameraDelivery,
                Some(CaptureRecoveryScope::camera(source_key, generation)),
                "test camera delivery degradation".to_string(),
                now_timestamp(),
            ),
            "test recovery admission requires an idle coordinator"
        );
        coordinator
            .begin_automatic(now_timestamp(), Instant::now())
            .expect("test camera degradation admits one automatic restart")
    };
    state.set_capture_recovery_admission_epoch(ticket.epoch);
    ticket.epoch
}

#[cfg(test)]
pub(crate) async fn test_admit_screen_recovery_attempt(
    state: &AppState,
    source_key: SourceKey,
    generation: u64,
) -> u64 {
    let ticket = {
        let mut coordinator = state.capture_recovery.lock().await;
        assert!(
            coordinator.observe_degraded(
                CaptureRecoveryStage::ScreenDelivery,
                Some(CaptureRecoveryScope::screen(source_key, generation)),
                "test screen delivery degradation".to_string(),
                now_timestamp(),
            ),
            "test screen recovery admission requires an idle coordinator"
        );
        coordinator
            .begin_automatic(now_timestamp(), Instant::now())
            .expect("test screen degradation admits one automatic restart")
    };
    state.set_capture_recovery_admission_epoch(ticket.epoch);
    ticket.epoch
}

/// Deterministic observation seam for compositor startup-adoption tests. The
/// public recovery status intentionally does not expose this internal
/// handshake because it is useful only for proving cache/driver ordering.
#[cfg(test)]
pub(crate) async fn test_compositor_adopted_camera_scope(
    state: &AppState,
) -> Option<(SourceKey, u64)> {
    state
        .capture_recovery
        .lock()
        .await
        .compositor_adopted_scope
        .as_ref()
        .map(|scope| (scope.source_key.clone(), scope.generation))
}

#[cfg(test)]
pub(crate) async fn test_compositor_adopted_screen_scope(
    state: &AppState,
) -> Option<(SourceKey, u64)> {
    state
        .capture_recovery
        .lock()
        .await
        .compositor_adopted_scope
        .as_ref()
        .filter(|scope| scope.source == CaptureRecoverySource::Screen)
        .map(|scope| (scope.source_key.clone(), scope.generation))
}

#[cfg(test)]
pub(crate) async fn seed_terminal_capture_recovery_failure_for_transport_test(
    state: &AppState,
) -> CaptureRecoveryStatus {
    let status = {
        let mut coordinator = state.capture_recovery.lock().await;
        let _ = coordinator.observe_degraded(
            CaptureRecoveryStage::CameraDelivery,
            None,
            "transport test camera degradation".to_string(),
            now_timestamp(),
        );
        coordinator
            .fail_unroutable_degradation(
                "transport test terminal failure".to_string(),
                now_timestamp(),
            )
            .map(|status| {
                emit_recovery_status_at_commit(state, &status);
                status
            })
            .expect("transport test failure transition")
    };
    publish_recovery_status(state, status.clone()).await;
    status
}

async fn compositor_health_run_is_current(state: &AppState, compositor_run_id: &str) -> bool {
    compositor_status(state).await.run_id.as_deref() == Some(compositor_run_id)
}

async fn retry_scope_is_current(state: &AppState, scope: &CaptureRecoveryScope) -> bool {
    match scope.source {
        CaptureRecoverySource::Camera => {
            if preview_camera_restart_snapshot(state)
                .await
                .is_some_and(|snapshot| {
                    snapshot.source_key == scope.source_key
                        && snapshot.generation == scope.generation
                })
            {
                return true;
            }
            failed_preview_camera_retry_is_current(state, &scope.source_key, scope.generation).await
        }
        CaptureRecoverySource::Screen => {
            if preview_screen_restart_snapshot(state)
                .await
                .is_some_and(|snapshot| {
                    snapshot.source_key == scope.source_key
                        && snapshot.generation == scope.generation
                })
            {
                return true;
            }
            failed_preview_screen_retry_is_current(state, &scope.source_key, scope.generation).await
        }
    }
}

async fn reconcile_retry_authority_before_mutation(state: &AppState) {
    let failed_scope = state
        .capture_recovery
        .lock()
        .await
        .reconciliation_target()
        .and_then(|(phase, scope)| (phase == CaptureRecoveryPhase::Failed).then_some(scope));
    let Some(failed_scope) = failed_scope else {
        return;
    };
    if retry_scope_is_current(state, &failed_scope).await {
        return;
    }
    let status = {
        let mut coordinator = state.capture_recovery.lock().await;
        let status = coordinator
            .invalidate_scoped_phase_if_current(CaptureRecoveryPhase::Failed, &failed_scope);
        if let Some(status) = status.as_ref() {
            emit_recovery_status_at_commit(state, status);
        }
        status
    };
    if let Some(status) = status {
        publish_recovery_status(state, status).await;
    }
}

/// Health-monitor integration point for generation-bound camera and screen
/// producer decay. Render-only degradation remains observational.
pub(crate) async fn handle_capture_health_transition(
    state: AppState,
    event: CaptureRecoveryHealthEvent,
) -> CaptureRecoveryStatus {
    handle_capture_health_transition_with_driver(
        state,
        event,
        Arc::new(BackendCaptureRecoveryDriver),
    )
    .await
}

async fn handle_capture_health_transition_with_driver(
    state: AppState,
    event: CaptureRecoveryHealthEvent,
    driver: Arc<dyn CaptureRecoveryDriver>,
) -> CaptureRecoveryStatus {
    if state.process_shutdown_requested() {
        return capture_recovery_status(&state).await;
    }
    if !compositor_health_run_is_current(&state, &event.compositor_run_id).await {
        return capture_recovery_status(&state).await;
    }

    let CaptureRecoveryHealthEvent {
        compositor_run_id,
        sequence,
        camera_mutation_epoch,
        transition,
    } = event;
    match transition {
        CaptureHealthTransition::Degraded {
            stage,
            detail,
            camera_epoch,
            screen_epoch,
        } => {
            let (recovery_stage, scope) = match stage {
                CaptureStage::CameraDelivery => {
                    let scope = camera_epoch.map(|epoch| {
                        CaptureRecoveryScope::camera(epoch.source_key, epoch.generation)
                    });
                    if let Some(sampled) = scope.as_ref() {
                        let current_matches = preview_camera_restart_snapshot(&state)
                            .await
                            .is_some_and(|current| {
                                current.source_key == sampled.source_key
                                    && current.generation == sampled.generation
                            });
                        if !current_matches {
                            // The compositor sampled this edge from an older
                            // generation. Never reinterpret it against the
                            // camera that happens to be current after an await.
                            return capture_recovery_status(&state).await;
                        }
                    }
                    (CaptureRecoveryStage::CameraDelivery, scope)
                }
                CaptureStage::ScreenDelivery => {
                    let scope = screen_epoch.map(|epoch| {
                        CaptureRecoveryScope::screen(epoch.source_key, epoch.generation)
                    });
                    if let Some(sampled) = scope.as_ref() {
                        let current_matches = preview_screen_restart_snapshot(&state)
                            .await
                            .is_some_and(|current| {
                                current.source_key == sampled.source_key
                                    && current.generation == sampled.generation
                            });
                        if !current_matches {
                            return capture_recovery_status(&state).await;
                        }
                    }
                    (CaptureRecoveryStage::ScreenDelivery, scope)
                }
                CaptureStage::CompositorRender => (CaptureRecoveryStage::CompositorRender, None),
            };
            let missing_restart_scope = matches!(
                recovery_stage,
                CaptureRecoveryStage::CameraDelivery | CaptureRecoveryStage::ScreenDelivery
            ) && scope.is_none();

            // Camera snapshot validation awaited above. Revalidate the run and
            // then consume its monotonic cursor under the coordinator lock so
            // delayed old-run or reverse-scheduled edges cannot mutate state.
            if !compositor_health_run_is_current(&state, &compositor_run_id).await {
                return capture_recovery_status(&state).await;
            }
            let (status, ticket) = {
                let mut coordinator = state.capture_recovery.lock().await;
                let mut admission = state.lock_capture_recovery_admission_gate();
                let current_camera_mutation_epoch =
                    if recovery_stage == CaptureRecoveryStage::CameraDelivery {
                        if admission.explicit_camera_mutation_is_active() {
                            return coordinator.status();
                        }
                        let Some(camera_mutation_epoch) = camera_mutation_epoch else {
                            return coordinator.status();
                        };
                        if !admission.camera_mutation_epoch_is_current(camera_mutation_epoch) {
                            return coordinator.status();
                        }
                        Some(camera_mutation_epoch)
                    } else {
                        None
                    };
                if !coordinator.admit_health_event(&compositor_run_id, recovery_stage, sequence) {
                    return coordinator.status();
                }
                let explicit_reconciled = current_camera_mutation_epoch
                    .and_then(|epoch| coordinator.reconcile_camera_mutation_epoch(epoch))
                    .is_some();
                let health_changed =
                    coordinator.observe_degraded(recovery_stage, scope, detail, now_timestamp());
                if health_changed && missing_restart_scope {
                    let source_label = match recovery_stage {
                        CaptureRecoveryStage::CameraDelivery => "camera",
                        CaptureRecoveryStage::ScreenDelivery => "screen",
                        CaptureRecoveryStage::CompositorRender => "capture",
                    };
                    let _ = coordinator.fail_unroutable_degradation(
                        format!(
                            "No stable live {source_label} source/configuration was available for a generation-safe restart."
                        ),
                        now_timestamp(),
                    );
                }
                let ticket = health_changed
                    .then(|| coordinator.begin_automatic(now_timestamp(), Instant::now()))
                    .flatten();
                if let Some(ticket) = ticket.as_ref() {
                    admission.set_admission_epoch(ticket.epoch);
                }
                let status = coordinator.status();
                if health_changed || explicit_reconciled {
                    emit_recovery_status_at_commit(&state, &status);
                }
                (status, ticket)
            };
            if let Some(ticket) = ticket {
                // Admission and persistent work handoff are synchronous. A
                // blocked/cancelled diagnostics publication cannot strand the
                // coordinator in Restarting without its attempt or watchdog.
                state.spawn_process_task(run_recovery_attempt(state.clone(), ticket, driver));
            }
            schedule_recovery_status_publication(&state, status);
        }
        CaptureHealthTransition::Recovered {
            stage,
            detail,
            camera_epoch,
            screen_epoch,
        } => {
            let recovery_stage = match stage {
                CaptureStage::CameraDelivery => CaptureRecoveryStage::CameraDelivery,
                CaptureStage::ScreenDelivery => CaptureRecoveryStage::ScreenDelivery,
                CaptureStage::CompositorRender => CaptureRecoveryStage::CompositorRender,
            };
            debug_assert_eq!(
                camera_epoch.is_some(),
                stage == CaptureStage::CameraDelivery
            );
            debug_assert_eq!(
                screen_epoch.is_some(),
                stage == CaptureStage::ScreenDelivery
            );
            if let Some(sampled) = camera_epoch {
                let current_matches =
                    preview_camera_restart_snapshot(&state)
                        .await
                        .is_some_and(|current| {
                            current.source_key == sampled.source_key
                                && current.generation == sampled.generation
                        });
                if !current_matches {
                    return capture_recovery_status(&state).await;
                }
            }
            if let Some(sampled) = screen_epoch {
                let current_matches =
                    preview_screen_restart_snapshot(&state)
                        .await
                        .is_some_and(|current| {
                            current.source_key == sampled.source_key
                                && current.generation == sampled.generation
                        });
                if !current_matches {
                    return capture_recovery_status(&state).await;
                }
            }
            if !compositor_health_run_is_current(&state, &compositor_run_id).await {
                return capture_recovery_status(&state).await;
            }
            let recovered = {
                let mut coordinator = state.capture_recovery.lock().await;
                let admission = state.lock_capture_recovery_admission_gate();
                let current_camera_mutation_epoch =
                    if recovery_stage == CaptureRecoveryStage::CameraDelivery {
                        if admission.explicit_camera_mutation_is_active() {
                            return coordinator.status();
                        }
                        let Some(camera_mutation_epoch) = camera_mutation_epoch else {
                            return coordinator.status();
                        };
                        if !admission.camera_mutation_epoch_is_current(camera_mutation_epoch) {
                            return coordinator.status();
                        }
                        Some(camera_mutation_epoch)
                    } else {
                        None
                    };
                if !coordinator.admit_health_event(&compositor_run_id, recovery_stage, sequence) {
                    return coordinator.status();
                }
                let reconciled = current_camera_mutation_epoch
                    .and_then(|epoch| coordinator.reconcile_camera_mutation_epoch(epoch));
                let status =
                    coordinator.observe_pipeline_recovered(recovery_stage, detail, now_timestamp());
                let publication = status.or(reconciled);
                if let Some(status) = publication.as_ref() {
                    emit_recovery_status_at_commit(&state, status);
                }
                publication
            };
            if let Some(recovered) = recovered {
                schedule_recovery_status_publication(&state, recovered);
                schedule_reset_if_recovered(&state).await;
            }
        }
        CaptureHealthTransition::Advisory { .. } => {}
    }
    capture_recovery_status(&state).await
}

/// Arm a generation-bound producer stall for the maintained debug smoke. The
/// RPC does not inject a health transition: the compositor's real 2-second
/// sampler sees frozen consumer + native callback/publication counters for the
/// exact old generation, and the normal three-window detector owns timing.
#[cfg(debug_assertions)]
pub(crate) async fn arm_camera_delivery_degradation(
    state: &AppState,
) -> Result<CaptureRecoverySmokeInjectionAck, String> {
    let recovery = capture_recovery_status(state).await;
    if recovery.phase != CaptureRecoveryPhase::Idle {
        return Err(
            "Capture recovery is already active; wait for idle before arming another smoke fault."
                .to_string(),
        );
    }
    let snapshot = preview_camera_restart_snapshot(state)
        .await
        .ok_or_else(|| "No stable live camera generation is available to arm.".to_string())?;
    let evidence = preview_camera_recovery_evidence(state, &snapshot)
        .await
        .ok_or_else(|| {
            "The live camera generation changed before producer evidence could be armed."
                .to_string()
        })?;
    let (fault_id, sampled) = {
        let mut runtime = state
            .capture_recovery_smoke_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.next_id = runtime.next_id.wrapping_add(1).max(1);
        let fault_id = runtime.next_id;
        let sampled = Arc::new(tokio::sync::Notify::new());
        runtime.active = Some(CaptureRecoverySmokeFault {
            fault_id,
            scope: CaptureRecoveryScope::camera(snapshot.source_key, snapshot.generation),
            capture_callbacks: evidence.capture_callback_count,
            frame_store_publications: evidence.frame_store_publications,
            fresh_serves: None,
            first_sampled: false,
            sampled: sampled.clone(),
        });
        (fault_id, sampled)
    };

    // The RPC acknowledgement is the soak timer's zero point. Return it only
    // after the compositor's natural sampler has consumed the first frozen
    // window; the remaining two 2-second windows then retain deterministic
    // headroom below the strict 6-second ack→active contract.
    if tokio::time::timeout(CAPTURE_RECOVERY_SMOKE_ARM_TIMEOUT, sampled.notified())
        .await
        .is_err()
    {
        let mut runtime = state
            .capture_recovery_smoke_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime
            .active
            .as_ref()
            .is_some_and(|active| active.fault_id == fault_id)
        {
            runtime.active = None;
        }
        return Err(
            "The compositor did not sample the armed camera stall before the acknowledgement deadline."
                .to_string(),
        );
    }
    Ok(CaptureRecoverySmokeInjectionAck {
        armed: true,
        fault_id,
        source_generation: snapshot.generation,
        message: "Generation-bound camera producer stall armed; natural capture-health sampling now owns detection."
            .to_string(),
    })
}

/// Apply the debug fault only to the exact generation that was armed. A
/// replacement generation automatically clears the fault and receives its
/// real producer/consumer counters.
#[cfg(debug_assertions)]
pub(crate) fn apply_camera_delivery_smoke_fault(
    state: &AppState,
    epoch: &CaptureHealthCameraEpoch,
    camera_fresh_serves: u64,
    _capture_callbacks: u64,
    _frame_store_publications: u64,
) -> Option<CaptureRecoverySmokeSample> {
    let mut runtime = state
        .capture_recovery_smoke_fault
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active = runtime.active.as_mut()?;
    if active.scope.source != CaptureRecoverySource::Camera {
        return None;
    }
    if active.scope.source_key != epoch.source_key || active.scope.generation != epoch.generation {
        runtime.active = None;
        return None;
    }
    let first_sample = !active.first_sampled;
    active.first_sampled = true;
    if first_sample {
        active.sampled.notify_one();
    }
    let frozen_fresh_serves = *active.fresh_serves.get_or_insert(camera_fresh_serves);
    Some(CaptureRecoverySmokeSample {
        fresh_serves: frozen_fresh_serves,
        capture_callbacks: active.capture_callbacks,
        frame_store_publications: active.frame_store_publications,
        first_sample,
    })
}

/// Arm the same generation-bound producer stall for a live
/// ScreenCaptureKit generation. No recovery state is fabricated: the
/// compositor's production sampler must observe three real frozen windows.
#[cfg(debug_assertions)]
pub(crate) async fn arm_screen_delivery_degradation(
    state: &AppState,
) -> Result<CaptureRecoverySmokeInjectionAck, String> {
    let recovery = capture_recovery_status(state).await;
    if recovery.phase != CaptureRecoveryPhase::Idle {
        return Err(
            "Capture recovery is already active; wait for idle before arming another smoke fault."
                .to_string(),
        );
    }
    let snapshot = preview_screen_restart_snapshot(state)
        .await
        .ok_or_else(|| {
            "No stable live ScreenCaptureKit generation is available to arm.".to_string()
        })?;
    let evidence = preview_screen_recovery_evidence(state, &snapshot)
        .await
        .ok_or_else(|| {
            "The live ScreenCaptureKit generation changed before producer evidence could be armed."
                .to_string()
        })?;
    let (fault_id, sampled) = {
        let mut runtime = state
            .capture_recovery_smoke_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.next_id = runtime.next_id.wrapping_add(1).max(1);
        let fault_id = runtime.next_id;
        let sampled = Arc::new(tokio::sync::Notify::new());
        runtime.active = Some(CaptureRecoverySmokeFault {
            fault_id,
            scope: CaptureRecoveryScope::screen(snapshot.source_key, snapshot.generation),
            capture_callbacks: evidence.capture_callback_count,
            frame_store_publications: evidence.frame_store_publications,
            fresh_serves: None,
            first_sampled: false,
            sampled: sampled.clone(),
        });
        (fault_id, sampled)
    };

    if tokio::time::timeout(CAPTURE_RECOVERY_SMOKE_ARM_TIMEOUT, sampled.notified())
        .await
        .is_err()
    {
        let mut runtime = state
            .capture_recovery_smoke_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime
            .active
            .as_ref()
            .is_some_and(|active| active.fault_id == fault_id)
        {
            runtime.active = None;
        }
        return Err(
            "The compositor did not sample the armed screen stall before the acknowledgement deadline."
                .to_string(),
        );
    }
    Ok(CaptureRecoverySmokeInjectionAck {
        armed: true,
        fault_id,
        source_generation: snapshot.generation,
        message: "Generation-bound ScreenCaptureKit producer stall armed; natural capture-health sampling now owns detection."
            .to_string(),
    })
}

/// Apply a screen fault only while the compositor is sampling the exact
/// generation which was armed. The first sample of any replacement generation
/// clears the fault, so recovery verification observes real SCK delivery.
#[cfg(debug_assertions)]
pub(crate) fn apply_screen_delivery_smoke_fault(
    state: &AppState,
    epoch: &CaptureHealthScreenEpoch,
    screen_fresh_serves: u64,
    _capture_callbacks: u64,
    _frame_store_publications: u64,
) -> Option<CaptureRecoverySmokeSample> {
    let mut runtime = state
        .capture_recovery_smoke_fault
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active = runtime.active.as_mut()?;
    if active.scope.source != CaptureRecoverySource::Screen {
        return None;
    }
    if active.scope.source_key != epoch.source_key || active.scope.generation != epoch.generation {
        runtime.active = None;
        return None;
    }
    let first_sample = !active.first_sampled;
    active.first_sampled = true;
    if first_sample {
        active.sampled.notify_one();
    }
    let frozen_fresh_serves = *active.fresh_serves.get_or_insert(screen_fresh_serves);
    Some(CaptureRecoverySmokeSample {
        fresh_serves: frozen_fresh_serves,
        capture_callbacks: active.capture_callbacks,
        frame_store_publications: active.frame_store_publications,
        first_sample,
    })
}

/// Parameterless, idempotent operator retry. Only a latched, source-scoped
/// failure admits work; duplicate clicks return the current status and do not
/// create another capture restart.
pub(crate) async fn retry_capture_recovery(state: AppState) -> CaptureRecoveryStatus {
    retry_capture_recovery_with_driver(state, Arc::new(BackendCaptureRecoveryDriver)).await
}

async fn retry_capture_recovery_with_driver(
    state: AppState,
    driver: Arc<dyn CaptureRecoveryDriver>,
) -> CaptureRecoveryStatus {
    if state.process_shutdown_requested() {
        return capture_recovery_status(&state).await;
    }
    reconcile_retry_authority_before_mutation(&state).await;
    let (status, ticket) = {
        let mut coordinator = state.capture_recovery.lock().await;
        let mut admission = state.lock_capture_recovery_admission_gate();
        let published_camera_mutation_epoch = admission.camera_mutation_epoch();
        let explicit_camera_mutation_active = admission.explicit_camera_mutation_is_active();
        let reconciled_explicit_mutation =
            published_camera_mutation_epoch != coordinator.camera_mutation_epoch;
        let retry_source = coordinator.retry_scope.as_ref().map(|scope| scope.source);
        if reconciled_explicit_mutation {
            let _ = coordinator.reconcile_camera_mutation_epoch(published_camera_mutation_epoch);
        }
        let camera_retry_blocked = retry_source == Some(CaptureRecoverySource::Camera)
            && (explicit_camera_mutation_active || reconciled_explicit_mutation);
        let ticket = if camera_retry_blocked {
            None
        } else {
            let ticket = coordinator.begin_manual_retry(now_timestamp(), Instant::now());
            if let Some(ticket) = ticket.as_ref() {
                admission.set_admission_epoch(ticket.epoch);
            }
            ticket
        };
        let status = coordinator.status();
        if ticket.is_some() || reconciled_explicit_mutation {
            emit_recovery_status_at_commit(&state, &status);
        }
        (status, ticket)
    };
    if let Some(ticket) = ticket {
        // Hand persistent ownership to the process runtime before diagnostics
        // publication can await, block, or be cancelled.
        state.spawn_process_task(run_recovery_attempt(state.clone(), ticket, driver));
    }
    schedule_recovery_status_publication(&state, status);
    capture_recovery_status(&state).await
}

async fn commit_recovery_verification_outcome(
    state: &AppState,
    ticket: &CaptureRecoveryAttemptTicket,
    verification: CaptureRecoveryVerificationOutcome,
) -> Option<CaptureRecoveryStatus> {
    let mut coordinator = state.capture_recovery.lock().await;
    let admission = state.lock_capture_recovery_admission_gate();
    let camera_mutation_epoch = admission.camera_mutation_epoch();
    let camera_mutation_changed = camera_mutation_epoch != coordinator.camera_mutation_epoch;
    let explicit_camera_mutation_supersedes = ticket.scope.source == CaptureRecoverySource::Camera
        && (admission.explicit_camera_mutation_is_active() || camera_mutation_changed);
    let status = if explicit_camera_mutation_supersedes {
        // Verification was sampled before an operator-owned transaction
        // boundary. Reconcile that boundary under the same coordinator ->
        // admission lock order used by health admission, and never publish
        // Recovered/Failed for evidence collected inside the transaction.
        coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch)
    } else if !admission.admission_epoch_is_current(ticket.epoch) {
        // Compositor/session lifecycle may retire the exact run after the
        // driver's final evidence check, including after the public watchdog
        // has moved Verifying to Failed. Admission is the synchronous commit
        // token for that ownership boundary; a revoked ticket can never turn
        // stale evidence into Recovered or a retryable failure.
        coordinator.verification_superseded(ticket)
    } else {
        if camera_mutation_changed {
            let _ = coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch);
        }
        match verification {
            CaptureRecoveryVerificationOutcome::Recovered(message) => {
                coordinator.verification_recovered(ticket, message, now_timestamp())
            }
            CaptureRecoveryVerificationOutcome::Superseded => {
                coordinator.verification_superseded(ticket)
            }
            CaptureRecoveryVerificationOutcome::Failed(error) => {
                coordinator.verification_failed(ticket, error, now_timestamp())
            }
        }
    };
    if let Some(status) = status.as_ref() {
        emit_recovery_status_at_commit(state, status);
    }
    status
}

struct RecoveryFailureCommit {
    status: Option<CaptureRecoveryStatus>,
    retry_ticket: Option<CaptureRecoveryAttemptTicket>,
    warn_camera: bool,
}

async fn commit_restart_failure_or_retry(
    state: &AppState,
    ticket: &CaptureRecoveryAttemptTicket,
    error: String,
    retry_scope: Option<CaptureRecoveryScope>,
) -> RecoveryFailureCommit {
    let mut coordinator = state.capture_recovery.lock().await;
    let mut admission = state.lock_capture_recovery_admission_gate();
    let camera_mutation_epoch = admission.camera_mutation_epoch();
    let camera_mutation_changed = camera_mutation_epoch != coordinator.camera_mutation_epoch;
    let explicit_camera_mutation_supersedes = ticket.scope.source == CaptureRecoverySource::Camera
        && (admission.explicit_camera_mutation_is_active() || camera_mutation_changed);

    let mut retry_ticket = None;
    let status = if explicit_camera_mutation_supersedes {
        coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch)
    } else if !admission.admission_epoch_is_current(ticket.epoch) {
        coordinator.restart_superseded(ticket)
    } else {
        if camera_mutation_changed {
            let _ = coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch);
        }
        retry_ticket = retry_scope.clone().and_then(|scope| {
            coordinator.begin_automatic_retry(ticket, scope, now_timestamp(), Instant::now())
        });
        if let Some(retry_ticket) = retry_ticket.as_ref() {
            admission.set_admission_epoch(retry_ticket.epoch);
            Some(coordinator.status())
        } else {
            coordinator.restart_failed(ticket, error, retry_scope, now_timestamp())
        }
    };
    if let Some(status) = status.as_ref() {
        emit_recovery_status_at_commit(state, status);
    }
    let warn_camera = coordinator.claim_terminal_automatic_camera_warning(ticket, status.as_ref());
    RecoveryFailureCommit {
        status,
        retry_ticket,
        warn_camera,
    }
}

async fn commit_verification_failure_or_retry(
    state: &AppState,
    ticket: &CaptureRecoveryAttemptTicket,
    error: String,
) -> RecoveryFailureCommit {
    let mut coordinator = state.capture_recovery.lock().await;
    let mut admission = state.lock_capture_recovery_admission_gate();
    let camera_mutation_epoch = admission.camera_mutation_epoch();
    let camera_mutation_changed = camera_mutation_epoch != coordinator.camera_mutation_epoch;
    let explicit_camera_mutation_supersedes = ticket.scope.source == CaptureRecoverySource::Camera
        && (admission.explicit_camera_mutation_is_active() || camera_mutation_changed);

    let mut retry_ticket = None;
    let status = if explicit_camera_mutation_supersedes {
        coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch)
    } else if !admission.admission_epoch_is_current(ticket.epoch) {
        coordinator.verification_superseded(ticket)
    } else {
        if camera_mutation_changed {
            let _ = coordinator.reconcile_camera_mutation_epoch(camera_mutation_epoch);
        }
        let retry_scope = coordinator.restarted_scope.clone();
        retry_ticket = retry_scope.and_then(|scope| {
            coordinator.begin_automatic_retry(ticket, scope, now_timestamp(), Instant::now())
        });
        if let Some(retry_ticket) = retry_ticket.as_ref() {
            admission.set_admission_epoch(retry_ticket.epoch);
            Some(coordinator.status())
        } else {
            coordinator.verification_failed(ticket, error, now_timestamp())
        }
    };
    if let Some(status) = status.as_ref() {
        emit_recovery_status_at_commit(state, status);
    }
    let warn_camera = coordinator.claim_terminal_automatic_camera_warning(ticket, status.as_ref());
    RecoveryFailureCommit {
        status,
        retry_ticket,
        warn_camera,
    }
}

fn run_recovery_attempt(
    state: AppState,
    ticket: CaptureRecoveryAttemptTicket,
    driver: Arc<dyn CaptureRecoveryDriver>,
) -> CaptureRecoveryDriverFuture<()> {
    Box::pin(async move {
        // A task may be queued behind process-runtime work while an explicit
        // camera/configuration/lifecycle mutation supersedes its ticket. Never
        // cross the physical restart boundary without revalidating admission.
        if state.process_shutdown_requested() {
            let status = {
                let mut coordinator = state.capture_recovery.lock().await;
                let status = coordinator.restart_superseded(&ticket);
                if let Some(status) = status.as_ref() {
                    emit_recovery_status_at_commit(&state, status);
                }
                status
            };
            if let Some(status) = status {
                publish_recovery_status(&state, status).await;
            }
            state.clear_capture_recovery_admission_if(ticket.epoch);
            return;
        }
        if !state
            .capture_recovery
            .lock()
            .await
            .restart_ticket_is_admitted(&ticket)
        {
            state.clear_capture_recovery_admission_if(ticket.epoch);
            return;
        }
        let screen_teardown_watchdog = ticket.scope.source == CaptureRecoverySource::Screen;
        let (restart_watchdog, restart_watchdog_armed, teardown_cancelled) =
            CaptureRecoveryRestartWatchdogArm::channel(screen_teardown_watchdog);
        if let Some(teardown_cancelled) = teardown_cancelled {
            schedule_attempt_watchdog_until_cancelled(
                state.clone(),
                ticket.clone(),
                CaptureRecoveryWatchdogStage::ScreenTeardown,
                capture_recovery_screen_teardown_watchdog_timeout(),
                teardown_cancelled,
            );
        }
        schedule_attempt_watchdog_after_arm(
            state.clone(),
            ticket.clone(),
            CaptureRecoveryWatchdogStage::Restarting,
            capture_recovery_restart_watchdog_timeout(ticket.scope.source),
            restart_watchdog_armed,
        );
        let restart = driver
            .restart(
                state.clone(),
                ticket.scope.clone(),
                ticket.epoch,
                restart_watchdog,
            )
            .await;
        let evidence = match restart {
            CaptureRecoveryRestartOutcome::Restarted(evidence) => {
                let (status, warn_camera) = {
                    let mut coordinator = state.capture_recovery.lock().await;
                    let status = coordinator.restart_succeeded(&ticket, &evidence, now_timestamp());
                    if let Some(status) = status.as_ref() {
                        emit_recovery_status_at_commit(&state, status);
                    }
                    let warn_camera = coordinator
                        .claim_terminal_automatic_camera_warning(&ticket, status.as_ref());
                    (status, warn_camera)
                };
                if warn_camera {
                    emit_terminal_camera_recovery_warning(&state);
                }
                let Some(status) = status else {
                    // The physical driver already returned. A newer coordinator
                    // epoch owns public truth, but the old exact admission must not
                    // remain armed indefinitely.
                    state.clear_capture_recovery_admission_if(ticket.epoch);
                    return;
                };
                if status.phase != CaptureRecoveryPhase::Verifying {
                    state.clear_capture_recovery_admission_if(ticket.epoch);
                    publish_recovery_status(&state, status).await;
                    return;
                }
                schedule_attempt_watchdog(
                    state.clone(),
                    ticket.clone(),
                    CaptureRecoveryWatchdogStage::Verifying,
                    capture_recovery_verification_watchdog_timeout(),
                );
                schedule_recovery_status_publication(&state, status);
                evidence
            }
            CaptureRecoveryRestartOutcome::Superseded => {
                let status = {
                    let mut coordinator = state.capture_recovery.lock().await;
                    let status = coordinator.restart_superseded(&ticket);
                    if let Some(status) = status.as_ref() {
                        emit_recovery_status_at_commit(&state, status);
                    }
                    status
                };
                if let Some(status) = status {
                    publish_recovery_status(&state, status).await;
                }
                state.clear_capture_recovery_admission_if(ticket.epoch);
                return;
            }
            CaptureRecoveryRestartOutcome::Failed { error, retry_scope } => {
                let commit =
                    commit_restart_failure_or_retry(&state, &ticket, error, retry_scope).await;
                if commit.warn_camera {
                    emit_terminal_camera_recovery_warning(&state);
                }
                if let Some(retry_ticket) = commit.retry_ticket {
                    let retry_state = state.clone();
                    state.spawn_process_task(run_recovery_attempt(
                        retry_state,
                        retry_ticket,
                        driver,
                    ));
                }
                if let Some(status) = commit.status {
                    publish_recovery_status(&state, status).await;
                }
                state.clear_capture_recovery_admission_if(ticket.epoch);
                return;
            }
        };

        let verification = driver.verify(state.clone(), *evidence).await;
        let commit = match verification {
            CaptureRecoveryVerificationOutcome::Failed(error) => {
                Some(commit_verification_failure_or_retry(&state, &ticket, error).await)
            }
            verification => {
                let status =
                    commit_recovery_verification_outcome(&state, &ticket, verification).await;
                status.map(|status| RecoveryFailureCommit {
                    status: Some(status),
                    retry_ticket: None,
                    warn_camera: false,
                })
            }
        };
        if let Some(commit) = commit {
            if commit.warn_camera {
                emit_terminal_camera_recovery_warning(&state);
            }
            if let Some(retry_ticket) = commit.retry_ticket {
                let retry_state = state.clone();
                state.spawn_process_task(run_recovery_attempt(retry_state, retry_ticket, driver));
            }
            if let Some(status) = commit.status {
                let recovered = status.phase == CaptureRecoveryPhase::Recovered;
                if recovered {
                    schedule_reset_if_recovered(&state).await;
                }
                publish_recovery_status(&state, status).await;
            }
            state.clear_capture_recovery_admission_if(ticket.epoch);
            return;
        }
        state.clear_capture_recovery_admission_if(ticket.epoch);
    })
}

fn schedule_attempt_watchdog(
    state: AppState,
    ticket: CaptureRecoveryAttemptTicket,
    watchdog_stage: CaptureRecoveryWatchdogStage,
    deadline: Duration,
) {
    let spawn_state = state.clone();
    state.spawn_process_task(async move {
        tokio::time::sleep(deadline).await;
        expire_attempt_watchdog(&spawn_state, &ticket, watchdog_stage).await;
    });
}

fn schedule_attempt_watchdog_until_cancelled(
    state: AppState,
    ticket: CaptureRecoveryAttemptTicket,
    watchdog_stage: CaptureRecoveryWatchdogStage,
    deadline: Duration,
    mut cancelled: oneshot::Receiver<()>,
) {
    let spawn_state = state.clone();
    state.spawn_process_task(async move {
        let deadline = tokio::time::sleep(deadline);
        tokio::pin!(deadline);
        tokio::select! {
            biased;
            Ok(()) = &mut cancelled => return,
            _ = &mut deadline => {}
        }
        expire_attempt_watchdog(&spawn_state, &ticket, watchdog_stage).await;
    });
}

async fn expire_attempt_watchdog(
    state: &AppState,
    ticket: &CaptureRecoveryAttemptTicket,
    watchdog_stage: CaptureRecoveryWatchdogStage,
) {
    let (status, warn_camera) = {
        let mut coordinator = state.capture_recovery.lock().await;
        let status = coordinator.attempt_watchdog_expired(ticket, watchdog_stage, now_timestamp());
        if let Some(status) = status.as_ref() {
            emit_recovery_status_at_commit(state, status);
        }
        let warn_camera =
            coordinator.claim_terminal_automatic_camera_warning(ticket, status.as_ref());
        (status, warn_camera)
    };
    if let Some(status) = status {
        if warn_camera {
            emit_terminal_camera_recovery_warning(state);
        }
        publish_recovery_status(state, status).await;
    }
}

fn schedule_attempt_watchdog_after_arm(
    state: AppState,
    ticket: CaptureRecoveryAttemptTicket,
    watchdog_stage: CaptureRecoveryWatchdogStage,
    deadline: Duration,
    armed: oneshot::Receiver<()>,
) {
    let spawn_state = state.clone();
    state.spawn_process_task(async move {
        if armed.await.is_err() {
            return;
        }
        schedule_attempt_watchdog(spawn_state, ticket, watchdog_stage, deadline);
    });
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use tokio::sync::{Notify, broadcast};

    use super::*;
    use crate::storage::Database;

    fn camera_scope(id: &str, generation: u64) -> CaptureRecoveryScope {
        CaptureRecoveryScope::camera(SourceKey::camera(id), generation)
    }

    fn screen_scope(id: &str, generation: u64) -> CaptureRecoveryScope {
        CaptureRecoveryScope::screen(SourceKey::screen(id), generation)
    }

    fn camera_evidence(
        id: &str,
        generation: u64,
        callbacks: u64,
        publications: u64,
        sequence: u64,
    ) -> PreviewCameraRecoveryEvidence {
        PreviewCameraRecoveryEvidence {
            source_key: SourceKey::camera(id),
            generation,
            target_fps: 30,
            source_fps: Some(30.0),
            capture_callback_count: callbacks,
            frame_store_publications: publications,
            did_drop_callback_count: 0,
            out_of_buffers: 0,
            surface_backing_live_count: 1,
            surface_backing_peak_count: 1,
            latest_sequence: Some(sequence),
            frame_age_ms: Some(20),
            requested_width: Some(1280),
            requested_height: Some(720),
            configured_width: Some(1280),
            configured_height: Some(720),
            actual_width: Some(1280),
            actual_height: Some(720),
        }
    }

    fn screen_evidence(
        id: &str,
        generation: u64,
        callbacks: u64,
        publications: u64,
        sequence: u64,
    ) -> PreviewScreenRecoveryEvidence {
        PreviewScreenRecoveryEvidence {
            source_key: SourceKey::screen(id),
            generation,
            target_fps: 30,
            capture_callback_count: callbacks,
            frame_store_publications: publications,
            latest_sequence: Some(sequence),
            frame_age_ms: Some(20),
            configured_width: 1280,
            configured_height: 720,
            actual_width: Some(1280),
            actual_height: Some(720),
        }
    }

    #[test]
    fn smoke_cadence_evidence_rejects_generation_superseded_mid_sample() {
        let before = camera_scope("camera-1", 8);
        let after = camera_scope("camera-1", 9);
        let producer =
            CaptureRecoveryProducerEvidence::Camera(camera_evidence("camera-1", 8, 120, 119, 119));
        let compositor = CaptureRecoveryCompositorEvidence {
            source: CaptureRecoverySource::Camera,
            compositor_run_id: "compositor-1".to_string(),
            source_key: SourceKey::camera("camera-1"),
            generation: 8,
            baseline_fresh_serves: 100,
            baseline_observed_at: Instant::now(),
            current_fresh_serves: 118,
        };

        let stable = capture_recovery_smoke_cadence_evidence_for_snapshot(
            CaptureRecoverySmokeCadenceSnapshot {
                source: CaptureRecoverySource::Camera,
                before: &before,
                producer: &producer,
                compositor: &compositor,
                after: &before,
                compositor_run_before: Some("compositor-1"),
                compositor_run_after: Some("compositor-1"),
                compositor_target_fps_before: 30,
                compositor_target_fps_after: 30,
            },
        )
        .unwrap();
        assert_eq!(stable.producer_target_fps, 30);
        assert_eq!(stable.compositor_target_fps, 30);

        let error = capture_recovery_smoke_cadence_evidence_for_snapshot(
            CaptureRecoverySmokeCadenceSnapshot {
                source: CaptureRecoverySource::Camera,
                before: &before,
                producer: &producer,
                compositor: &compositor,
                after: &after,
                compositor_run_before: Some("compositor-1"),
                compositor_run_after: Some("compositor-1"),
                compositor_target_fps_before: 30,
                compositor_target_fps_after: 30,
            },
        )
        .unwrap_err();

        assert!(error.contains("superseded while cadence evidence was sampled"));
    }

    fn restart_evidence(id: &str, generation: u64) -> CaptureRecoveryRestartEvidence {
        CaptureRecoveryRestartEvidence {
            scope: camera_scope(id, generation),
            baseline: CaptureRecoveryProducerEvidence::Camera(camera_evidence(
                id, generation, 0, 0, 1,
            )),
            compositor_run_id: Some("compositor-a".to_string()),
            session_id: Some("session-a".to_string()),
        }
    }

    fn screen_restart_evidence(id: &str, generation: u64) -> CaptureRecoveryRestartEvidence {
        CaptureRecoveryRestartEvidence {
            scope: screen_scope(id, generation),
            baseline: CaptureRecoveryProducerEvidence::Screen(screen_evidence(
                id, generation, 0, 0, 1,
            )),
            compositor_run_id: Some("compositor-a".to_string()),
            session_id: Some("session-a".to_string()),
        }
    }

    fn boxed_restart_evidence(id: &str, generation: u64) -> Box<CaptureRecoveryRestartEvidence> {
        Box::new(restart_evidence(id, generation))
    }

    fn boxed_screen_restart_evidence(
        id: &str,
        generation: u64,
    ) -> Box<CaptureRecoveryRestartEvidence> {
        Box::new(screen_restart_evidence(id, generation))
    }

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(32);
        AppState::new(
            "capture-recovery-test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backend_restart_serializes_with_session_start_admission() {
        let state = test_state();
        let session_start = state
            .session_start_source_transition_fence
            .clone()
            .lock_owned()
            .await;
        let (restart_watchdog, _restart_watchdog_armed, _teardown_cancelled) =
            CaptureRecoveryRestartWatchdogArm::channel(false);
        let restart = tokio::spawn(BackendCaptureRecoveryDriver.restart(
            state,
            camera_scope("camera:missing", 7),
            1,
            restart_watchdog,
        ));

        tokio::task::yield_now().await;
        assert!(
            !restart.is_finished(),
            "automatic recovery must not snapshot or mutate camera ownership while session.start owns admission"
        );

        drop(session_start);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), restart)
                .await
                .expect("recovery should resume after session-start admission")
                .expect("recovery restart task"),
            CaptureRecoveryRestartOutcome::Superseded
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backend_screen_restart_serializes_with_session_start_admission() {
        let state = test_state();
        let session_start = state
            .session_start_source_transition_fence
            .clone()
            .lock_owned()
            .await;
        let (restart_watchdog, _restart_watchdog_armed, _teardown_cancelled) =
            CaptureRecoveryRestartWatchdogArm::channel(false);
        let restart = tokio::spawn(BackendCaptureRecoveryDriver.restart(
            state,
            screen_scope("screen:missing", 7),
            1,
            restart_watchdog,
        ));

        tokio::task::yield_now().await;
        assert!(
            !restart.is_finished(),
            "automatic recovery must not snapshot or mutate screen ownership while session.start owns admission"
        );

        drop(session_start);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), restart)
                .await
                .expect("screen recovery should resume after session-start admission")
                .expect("screen recovery restart task"),
            CaptureRecoveryRestartOutcome::Superseded
        ));
    }

    async fn install_test_compositor_run(state: &AppState, run_id: &str) {
        state.compositor.lock().await.status.run_id = Some(run_id.to_string());
        note_compositor_lifecycle_changed(state, Some(run_id.to_string())).await;
    }

    async fn install_test_camera(
        state: &AppState,
        camera_id: &str,
    ) -> crate::preview_camera::PreviewCameraRestartSnapshot {
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            state, camera_id, &layout, &video,
        )
        .await;
        preview_camera_restart_snapshot(state)
            .await
            .expect("test camera snapshot")
    }

    struct ScriptedRecoveryDriver {
        restarts: StdMutex<VecDeque<CaptureRecoveryRestartOutcome>>,
        verifications: StdMutex<VecDeque<CaptureRecoveryVerificationOutcome>>,
        restart_calls: AtomicUsize,
    }

    impl ScriptedRecoveryDriver {
        fn new(
            restarts: impl IntoIterator<Item = CaptureRecoveryRestartOutcome>,
            verifications: impl IntoIterator<Item = CaptureRecoveryVerificationOutcome>,
        ) -> Self {
            Self {
                restarts: StdMutex::new(restarts.into_iter().collect()),
                verifications: StdMutex::new(verifications.into_iter().collect()),
                restart_calls: AtomicUsize::new(0),
            }
        }

        fn restart_calls(&self) -> usize {
            self.restart_calls.load(AtomicOrdering::SeqCst)
        }
    }

    impl CaptureRecoveryDriver for ScriptedRecoveryDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            self.restart_calls.fetch_add(1, AtomicOrdering::SeqCst);
            let outcome = self
                .restarts
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted restart outcome");
            Box::pin(async move { outcome })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            let outcome = self
                .verifications
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted verification outcome");
            Box::pin(async move { outcome })
        }
    }

    struct GatedRestartDriver {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        outcome: StdMutex<Option<CaptureRecoveryRestartOutcome>>,
    }

    struct GatedOutcomeDriver {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        outcome: StdMutex<Option<CaptureRecoveryRestartOutcome>>,
        verification: StdMutex<Option<CaptureRecoveryVerificationOutcome>>,
    }

    struct GatedVerificationDriver {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        restart: StdMutex<Option<CaptureRecoveryRestartOutcome>>,
        verification: StdMutex<Option<CaptureRecoveryVerificationOutcome>>,
    }

    struct GatedRecoveryStagesDriver {
        restart_entered: Arc<Notify>,
        restart_release: Arc<Notify>,
        verification_entered: Arc<Notify>,
        verification_release: Arc<Notify>,
        restart: StdMutex<Option<CaptureRecoveryRestartOutcome>>,
        verification: StdMutex<Option<CaptureRecoveryVerificationOutcome>>,
    }

    struct DelayedScreenStartupBudgetDriver {
        teardown_entered: Arc<Notify>,
        teardown_release: Arc<Notify>,
        startup_entered: Arc<Notify>,
        startup_release: Arc<Notify>,
        startup_calls: Arc<AtomicUsize>,
        restart: StdMutex<Option<CaptureRecoveryRestartOutcome>>,
        verification: StdMutex<Option<CaptureRecoveryVerificationOutcome>>,
    }

    struct NeverResolvingRestartDriver {
        entered: Arc<Notify>,
    }

    struct CountingRestartDriver {
        restarts: Arc<AtomicUsize>,
    }

    struct RuntimeSurvivalDriver {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        completed: Arc<Notify>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
    }

    impl CaptureRecoveryDriver for CountingRestartDriver {
        fn restart(
            &self,
            state: AppState,
            _scope: CaptureRecoveryScope,
            recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            if state.capture_recovery_admission_is_current(recovery_epoch) {
                self.restarts.fetch_add(1, AtomicOrdering::AcqRel);
            }
            Box::pin(async { CaptureRecoveryRestartOutcome::Superseded })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            Box::pin(async { panic!("superseded restart cannot reach verification") })
        }
    }

    impl CaptureRecoveryDriver for RuntimeSurvivalDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            let completed = Arc::clone(&self.completed);
            let active = Arc::clone(&self.active);
            let max_active = Arc::clone(&self.max_active);
            Box::pin(async move {
                let now_active = active.fetch_add(1, AtomicOrdering::AcqRel) + 1;
                max_active.fetch_max(now_active, AtomicOrdering::AcqRel);
                entered.notify_one();
                release.notified().await;
                active.fetch_sub(1, AtomicOrdering::AcqRel);
                completed.notify_one();
                CaptureRecoveryRestartOutcome::Superseded
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            Box::pin(async { panic!("superseded restart cannot reach verification") })
        }
    }

    impl CaptureRecoveryDriver for NeverResolvingRestartDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let entered = Arc::clone(&self.entered);
            Box::pin(async move {
                entered.notify_one();
                std::future::pending::<CaptureRecoveryRestartOutcome>().await
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            Box::pin(async { panic!("a never-resolving restart cannot reach verification") })
        }
    }

    impl CaptureRecoveryDriver for GatedRestartDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            let outcome = self
                .outcome
                .lock()
                .unwrap()
                .take()
                .expect("one gated restart outcome");
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                outcome
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            Box::pin(async { panic!("stale restart completion must not reach verification") })
        }
    }

    impl CaptureRecoveryDriver for GatedOutcomeDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            let outcome = self
                .outcome
                .lock()
                .unwrap()
                .take()
                .expect("one gated outcome");
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                outcome
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            let outcome = self
                .verification
                .lock()
                .unwrap()
                .take()
                .expect("one verification outcome");
            Box::pin(async move { outcome })
        }
    }

    impl CaptureRecoveryDriver for GatedVerificationDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let outcome = self
                .restart
                .lock()
                .unwrap()
                .take()
                .expect("one restart outcome");
            Box::pin(async move { outcome })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            let outcome = self
                .verification
                .lock()
                .unwrap()
                .take()
                .expect("one verification outcome");
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                outcome
            })
        }
    }

    impl CaptureRecoveryDriver for GatedRecoveryStagesDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            restart_watchdog.arm();
            let entered = Arc::clone(&self.restart_entered);
            let release = Arc::clone(&self.restart_release);
            let outcome = self
                .restart
                .lock()
                .unwrap()
                .take()
                .expect("one restart outcome");
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                outcome
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            let entered = Arc::clone(&self.verification_entered);
            let release = Arc::clone(&self.verification_release);
            let outcome = self
                .verification
                .lock()
                .unwrap()
                .take()
                .expect("one verification outcome");
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                outcome
            })
        }
    }

    impl CaptureRecoveryDriver for DelayedScreenStartupBudgetDriver {
        fn restart(
            &self,
            _state: AppState,
            _scope: CaptureRecoveryScope,
            _recovery_epoch: u64,
            restart_watchdog: CaptureRecoveryRestartWatchdogArm,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryRestartOutcome> {
            let teardown_entered = Arc::clone(&self.teardown_entered);
            let teardown_release = Arc::clone(&self.teardown_release);
            let startup_entered = Arc::clone(&self.startup_entered);
            let startup_release = Arc::clone(&self.startup_release);
            let startup_calls = Arc::clone(&self.startup_calls);
            let outcome = self
                .restart
                .lock()
                .unwrap()
                .take()
                .expect("one delayed screen restart outcome");
            Box::pin(async move {
                teardown_entered.notify_one();
                teardown_release.notified().await;
                restart_watchdog.arm();
                startup_calls.fetch_add(1, AtomicOrdering::SeqCst);
                startup_entered.notify_one();
                startup_release.notified().await;
                outcome
            })
        }

        fn verify(
            &self,
            _state: AppState,
            _evidence: CaptureRecoveryRestartEvidence,
        ) -> CaptureRecoveryDriverFuture<CaptureRecoveryVerificationOutcome> {
            let outcome = self
                .verification
                .lock()
                .unwrap()
                .take()
                .expect("one delayed screen verification outcome");
            Box::pin(async move { outcome })
        }
    }

    fn recovery_event_phases(
        events: &mut broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<String> {
        let mut phases = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "capture.recovery.status" {
                phases.push(
                    event.payload["phase"]
                        .as_str()
                        .expect("recovery event phase")
                        .to_string(),
                );
            }
        }
        phases
    }

    fn observe_camera(
        coordinator: &mut CaptureRecoveryCoordinator,
        scope: CaptureRecoveryScope,
    ) -> bool {
        coordinator.observe_degraded(
            CaptureRecoveryStage::CameraDelivery,
            Some(scope),
            "camera delivery degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        )
    }

    fn observe_screen(
        coordinator: &mut CaptureRecoveryCoordinator,
        scope: CaptureRecoveryScope,
    ) -> bool {
        coordinator.observe_degraded(
            CaptureRecoveryStage::ScreenDelivery,
            Some(scope),
            "screen delivery degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        )
    }

    #[test]
    fn screen_delivery_owns_one_generation_scoped_automatic_attempt() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        let scope = screen_scope("screen:a", 7);
        assert!(observe_screen(&mut coordinator, scope.clone()));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .expect("screen delivery admits automatic recovery");
        assert_eq!(ticket.scope, scope);
        assert_eq!(ticket.scope.source, CaptureRecoverySource::Screen);
        assert_eq!(
            coordinator.status().stage,
            Some(CaptureRecoveryStage::ScreenDelivery)
        );
        assert_eq!(coordinator.status().attempts, 1);
        assert!(
            coordinator
                .begin_automatic("2026-08-28T10:00:02Z".to_string(), Instant::now())
                .is_none(),
            "the incident remains single-flight"
        );
    }

    #[test]
    fn screen_recovery_requires_exact_replacement_compositor_adoption() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_screen(
            &mut coordinator,
            screen_scope("screen:a", 7),
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        coordinator
            .restart_succeeded(
                &ticket,
                &screen_restart_evidence("screen:a", 8),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();

        assert!(
            coordinator
                .observe_compositor_screen_source(Some(screen_scope("screen:a", 7)))
                .is_none(),
            "retired generation adoption is neutral"
        );
        assert!(
            coordinator
                .observe_compositor_screen_source(Some(screen_scope("screen:a", 8)))
                .is_none(),
            "adoption records evidence but producer verification is still pending"
        );
        let recovered = coordinator
            .verification_recovered(
                &ticket,
                "screen cadence restored".to_string(),
                "2026-08-28T10:00:04Z".to_string(),
            )
            .unwrap();
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.source, Some(CaptureRecoverySource::Screen));
        assert_eq!(recovered.source_generation, Some(8));
    }

    #[test]
    fn duplicate_edges_coalesce_into_one_automatic_attempt() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        let scope = camera_scope("camera:a", 7);
        assert!(observe_camera(&mut coordinator, scope.clone()));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .expect("first edge starts recovery");

        assert!(!observe_camera(&mut coordinator, scope));
        assert!(
            coordinator
                .begin_automatic("2026-08-28T10:00:02Z".to_string(), Instant::now())
                .is_none(),
            "duplicate detection must not start a second restart"
        );
        assert_eq!(ticket.epoch, coordinator.epoch);
        assert_eq!(coordinator.status().attempts, 1);
        assert_eq!(coordinator.status().phase, CaptureRecoveryPhase::Restarting);
    }

    #[test]
    fn different_health_stage_cannot_supersede_an_admitted_camera_attempt() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .expect("camera incident admits one restart");

        assert!(!coordinator.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "render health changed while camera restart owns the incident".to_string(),
            "2026-08-28T10:00:02Z".to_string(),
        ));
        let current = coordinator.status();
        assert_eq!(current.phase, CaptureRecoveryPhase::Restarting);
        assert_eq!(current.stage, Some(CaptureRecoveryStage::CameraDelivery));
        assert_eq!(current.source_generation, Some(7));

        assert_eq!(
            coordinator
                .attempt_watchdog_expired(
                    &ticket,
                    CaptureRecoveryWatchdogStage::Restarting,
                    "2026-08-28T10:00:12Z".to_string(),
                )
                .expect("the original watchdog ticket remains current")
                .phase,
            CaptureRecoveryPhase::Failed
        );
        let revealed = coordinator
            .explicit_camera_configuration_changed()
            .expect("clearing camera authority reveals the retained render incident");
        assert_eq!(revealed.phase, CaptureRecoveryPhase::Degraded);
        assert_eq!(revealed.stage, Some(CaptureRecoveryStage::CompositorRender));
    }

    #[test]
    fn compositor_lifecycle_retires_render_incident_and_health_cursor() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(
            coordinator
                .observe_compositor_lifecycle(Some("run-a".to_string()))
                .is_none()
        );
        assert!(
            coordinator.admit_health_event("run-a", CaptureRecoveryStage::CompositorRender, 2,)
        );
        assert!(
            coordinator.admit_health_event("run-a", CaptureRecoveryStage::CameraDelivery, 1,),
            "a later-dispatched render edge must not consume the camera authority cursor"
        );
        assert!(coordinator.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "run-a render stalled".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        assert!(!coordinator.admit_health_event(
            "run-a",
            CaptureRecoveryStage::CompositorRender,
            1,
        ));

        let idle = coordinator
            .observe_compositor_lifecycle(Some("run-b".to_string()))
            .expect("run replacement supersedes the old render incident");
        assert_eq!(idle.phase, CaptureRecoveryPhase::Idle);
        assert!(!coordinator.admit_health_event(
            "run-a",
            CaptureRecoveryStage::CompositorRender,
            3,
        ));
        assert!(
            coordinator.admit_health_event("run-b", CaptureRecoveryStage::CompositorRender, 1,)
        );
    }

    #[test]
    fn camera_health_cursor_rejects_old_runs_independently() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(
            coordinator
                .observe_compositor_lifecycle(Some("run-a".to_string()))
                .is_none()
        );
        assert!(
            coordinator.admit_health_event("run-a", CaptureRecoveryStage::CameraDelivery, 1,),
            "the active run owns its camera cursor"
        );

        coordinator.observe_compositor_lifecycle(Some("run-b".to_string()));
        assert!(
            !coordinator.admit_health_event("run-a", CaptureRecoveryStage::CameraDelivery, 2,),
            "run identity remains an independent admission dimension"
        );
    }

    #[test]
    fn automatic_failure_latches_until_one_manual_retry_is_admitted() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        let scope = camera_scope("camera:a", 7);
        assert!(observe_camera(&mut coordinator, scope.clone()));
        let automatic = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        let failed = coordinator
            .restart_failed(
                &automatic,
                "restart failed".to_string(),
                Some(scope.clone()),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert!(failed.retryable);

        assert!(!observe_camera(&mut coordinator, scope));
        assert!(
            coordinator
                .begin_automatic("2026-08-28T10:00:03Z".to_string(), Instant::now())
                .is_none(),
            "failed incidents must never auto-loop"
        );

        let manual = coordinator
            .begin_manual_retry("2026-08-28T10:00:04Z".to_string(), Instant::now())
            .expect("failed recovery is manually retryable");
        assert_eq!(manual.trigger, CaptureRecoveryTrigger::Manual);
        assert_eq!(coordinator.status().attempts, 2);
        assert!(
            coordinator
                .begin_manual_retry("2026-08-28T10:00:05Z".to_string(), Instant::now())
                .is_none(),
            "duplicate retry clicks are idempotent"
        );
    }

    #[test]
    fn automatic_retry_is_bounded_and_late_completion_cannot_clear_terminal_failure() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let first = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        coordinator
            .restart_succeeded(
                &first,
                &restart_evidence("camera:a", 8),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        let second = coordinator
            .begin_automatic_retry(
                &first,
                camera_scope("camera:a", 8),
                "2026-08-28T10:00:03Z".to_string(),
                Instant::now(),
            )
            .expect("the exact replacement generation owns the one retry");
        coordinator
            .restart_succeeded(
                &second,
                &restart_evidence("camera:a", 9),
                "2026-08-28T10:00:04Z".to_string(),
            )
            .unwrap();
        let failed = coordinator
            .verification_failed(
                &second,
                "cadence still degraded".to_string(),
                "2026-08-28T10:00:05Z".to_string(),
            )
            .unwrap();
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(failed.attempts, MAX_AUTOMATIC_ATTEMPTS);
        assert_eq!(failed.source_generation, Some(9));
        assert!(failed.retryable);
        assert!(
            coordinator
                .begin_automatic_retry(
                    &second,
                    camera_scope("camera:a", 9),
                    "2026-08-28T10:00:06Z".to_string(),
                    Instant::now(),
                )
                .is_none(),
            "a third automatic attempt is never admitted"
        );
        assert!(coordinator.verification_superseded(&second).is_none());
        assert_eq!(coordinator.status().phase, CaptureRecoveryPhase::Failed);
        assert!(coordinator.claim_terminal_automatic_camera_warning(&second, Some(&failed)));
        assert!(!coordinator.claim_terminal_automatic_camera_warning(&second, Some(&failed)));

        let manual = coordinator
            .begin_manual_retry("2026-08-28T10:00:07Z".to_string(), Instant::now())
            .expect("the exact terminal generation remains manually retryable");
        assert_eq!(manual.trigger, CaptureRecoveryTrigger::Manual);
        assert_eq!(manual.scope, camera_scope("camera:a", 9));
        assert_eq!(coordinator.status().attempts, 3);
    }

    fn assert_watchdog_latched_source_requires_operator_retry(
        initial_scope: CaptureRecoveryScope,
        restarted_evidence: CaptureRecoveryRestartEvidence,
        expects_camera_warning: bool,
    ) {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(coordinator.observe_degraded(
            match initial_scope.source {
                CaptureRecoverySource::Camera => CaptureRecoveryStage::CameraDelivery,
                CaptureRecoverySource::Screen => CaptureRecoveryStage::ScreenDelivery,
            },
            Some(initial_scope),
            "generation-bound delivery decay".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        let automatic = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .expect("delivery decay admits its first automatic attempt");
        let watchdog_failure = coordinator
            .attempt_watchdog_expired(
                &automatic,
                CaptureRecoveryWatchdogStage::Restarting,
                "2026-08-28T10:00:11Z".to_string(),
            )
            .expect("the current automatic attempt reaches its watchdog");
        assert_eq!(watchdog_failure.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(watchdog_failure.attempts, 1);
        assert_eq!(
            coordinator
                .claim_terminal_automatic_camera_warning(&automatic, Some(&watchdog_failure),),
            expects_camera_warning,
        );

        coordinator
            .restart_succeeded(
                &automatic,
                &restarted_evidence,
                "2026-08-28T10:00:12Z".to_string(),
            )
            .expect("the non-cancellable physical owner may reconcile late restart evidence");
        let restarted_scope = restarted_evidence.scope.clone();
        assert!(
            coordinator
                .begin_automatic_retry(
                    &automatic,
                    restarted_scope.clone(),
                    "2026-08-28T10:00:13Z".to_string(),
                    Instant::now(),
                )
                .is_none(),
            "a watchdog-latched failure must never reopen automatic admission"
        );

        let terminal = coordinator
            .verification_failed(
                &automatic,
                "late replacement cadence remained degraded".to_string(),
                "2026-08-28T10:00:14Z".to_string(),
            )
            .expect("late verification failure retains the exact replacement scope");
        assert_eq!(terminal.phase, CaptureRecoveryPhase::Failed);
        assert!(terminal.retryable);
        let manual = coordinator
            .begin_manual_retry("2026-08-28T10:00:15Z".to_string(), Instant::now())
            .expect("operator retry remains available for the exact failed generation");
        assert_eq!(manual.trigger, CaptureRecoveryTrigger::Manual);
        assert_eq!(manual.scope, restarted_scope);
    }

    #[test]
    fn watchdog_latched_screen_failure_cannot_spawn_a_late_automatic_retry() {
        assert_watchdog_latched_source_requires_operator_retry(
            screen_scope("screen:a", 7),
            screen_restart_evidence("screen:a", 8),
            false,
        );
    }

    #[test]
    fn watchdog_latched_camera_failure_has_the_same_operator_retry_contract() {
        assert_watchdog_latched_source_requires_operator_retry(
            camera_scope("camera:a", 7),
            restart_evidence("camera:a", 8),
            true,
        );
    }

    #[test]
    fn failed_restart_reports_retryable_only_with_a_retained_scope() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        let original_scope = camera_scope("camera:a", 7);
        assert!(observe_camera(&mut coordinator, original_scope));
        let automatic = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        let failed_generation = camera_scope("camera:a", 8);
        let failed = coordinator
            .restart_failed(
                &automatic,
                "forced startup failed".to_string(),
                Some(failed_generation.clone()),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        assert!(failed.retryable);
        assert_eq!(failed.source_generation, Some(8));

        assert!(!coordinator.observe_degraded(
            CaptureRecoveryStage::CameraDelivery,
            None,
            "late unroutable edge".to_string(),
            "2026-08-28T10:00:03Z".to_string(),
        ));
        assert_eq!(coordinator.status().phase, CaptureRecoveryPhase::Failed);
        assert_eq!(coordinator.status().source_generation, Some(8));

        let manual = coordinator
            .begin_manual_retry("2026-08-28T10:00:04Z".to_string(), Instant::now())
            .expect("retained failed generation must admit one manual retry");
        assert_eq!(manual.scope, failed_generation);
    }

    #[test]
    fn failed_restart_without_a_safe_scope_is_not_retryable() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let automatic = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        let failed = coordinator
            .restart_failed(
                &automatic,
                "restart proof unavailable".to_string(),
                None,
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        assert!(!failed.retryable);
        assert!(
            coordinator
                .begin_manual_retry("2026-08-28T10:00:03Z".to_string(), Instant::now())
                .is_none()
        );
    }

    #[test]
    fn stale_completion_cannot_overwrite_a_newer_source_epoch() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let stale = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();

        coordinator
            .explicit_camera_configuration_changed()
            .expect("explicit source mutation supersedes the in-flight ticket");
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:b", 11)
        ));
        let current = coordinator
            .begin_automatic("2026-08-28T10:00:02Z".to_string(), Instant::now())
            .unwrap();
        assert_ne!(stale.epoch, current.epoch);

        let stale_evidence = CaptureRecoveryRestartEvidence {
            scope: camera_scope("camera:a", 8),
            baseline: CaptureRecoveryProducerEvidence::Camera(camera_evidence(
                "camera:a", 8, 0, 0, 1,
            )),
            compositor_run_id: Some("compositor-a".to_string()),
            session_id: None,
        };
        assert!(
            coordinator
                .restart_succeeded(&stale, &stale_evidence, "2026-08-28T10:00:03Z".to_string())
                .is_none()
        );
        let status = coordinator.status();
        assert_eq!(status.phase, CaptureRecoveryPhase::Restarting);
        assert_eq!(status.source_generation, Some(11));
        assert_eq!(status.trigger, Some(CaptureRecoveryTrigger::Automatic));
    }

    #[test]
    fn compositor_render_degradation_never_admits_a_source_restart() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(coordinator.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "render cadence degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        assert!(
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .is_none()
        );
        let status = coordinator.status();
        assert_eq!(status.phase, CaptureRecoveryPhase::Degraded);
        assert_eq!(status.stage, Some(CaptureRecoveryStage::CompositorRender));
        assert_eq!(status.source, None);
        assert!(!status.retryable);
    }

    #[test]
    fn recovered_health_edges_are_stage_matched() {
        let mut render = CaptureRecoveryCoordinator::default();
        assert!(render.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "render degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        assert!(
            render
                .observe_pipeline_recovered(
                    CaptureRecoveryStage::CameraDelivery,
                    "camera recovered".to_string(),
                    "2026-08-28T10:00:01Z".to_string(),
                )
                .is_none()
        );
        assert_eq!(render.status().phase, CaptureRecoveryPhase::Degraded);

        let mut camera = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(&mut camera, camera_scope("camera:a", 7)));
        assert!(
            camera
                .observe_pipeline_recovered(
                    CaptureRecoveryStage::CompositorRender,
                    "render recovered".to_string(),
                    "2026-08-28T10:00:01Z".to_string(),
                )
                .is_none()
        );
        assert_eq!(camera.status().phase, CaptureRecoveryPhase::Degraded);
    }

    #[test]
    fn successful_restart_requires_generation_advance_and_verification() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        assert!(
            coordinator
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 7)))
                .is_none()
        );
        assert_ne!(
            coordinator.compositor_adopted_scope.as_ref(),
            Some(&camera_scope("camera:a", 7)),
            "the compositor's old cached generation is not recovery evidence"
        );
        assert!(
            coordinator
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
                .is_none(),
            "internal recovery adoption must not clear its own incident"
        );
        let evidence = CaptureRecoveryRestartEvidence {
            scope: camera_scope("camera:a", 8),
            baseline: CaptureRecoveryProducerEvidence::Camera(camera_evidence(
                "camera:a", 8, 2, 2, 2,
            )),
            compositor_run_id: Some("compositor-a".to_string()),
            session_id: None,
        };
        let verifying = coordinator
            .restart_succeeded(&ticket, &evidence, "2026-08-28T10:00:02Z".to_string())
            .unwrap();
        assert_eq!(verifying.phase, CaptureRecoveryPhase::Verifying);
        assert_eq!(verifying.source_generation, Some(8));
        assert_eq!(
            coordinator.compositor_adopted_scope.as_ref(),
            Some(&camera_scope("camera:a", 8))
        );

        let recovered = coordinator
            .verification_recovered(
                &ticket,
                "cadence restored".to_string(),
                "2026-08-28T10:00:04Z".to_string(),
            )
            .unwrap();
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.source_generation, Some(8));
        assert!(!recovered.retryable);
        assert!(recovered.last_duration_ms.is_some());
    }

    #[test]
    fn delayed_exact_compositor_adoption_completes_verified_recovery() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        let evidence = restart_evidence("camera:a", 8);
        coordinator
            .restart_succeeded(&ticket, &evidence, "2026-08-28T10:00:02Z".to_string())
            .unwrap();

        let waiting = coordinator
            .verification_recovered(
                &ticket,
                "cadence restored".to_string(),
                "2026-08-28T10:00:04Z".to_string(),
            )
            .unwrap();
        assert_eq!(waiting.phase, CaptureRecoveryPhase::Verifying);
        assert!(
            waiting
                .message
                .as_deref()
                .is_some_and(|message| message.contains("waiting for the compositor"))
        );

        let recovered = coordinator
            .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
            .expect("late exact adoption resumes and completes verification");
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.message.as_deref(), Some("cadence restored"));
        assert_eq!(recovered.source_generation, Some(8));
    }

    #[test]
    fn delayed_retired_compositor_observations_cannot_erase_verifying() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        coordinator
            .restart_succeeded(
                &ticket,
                &restart_evidence("camera:a", 8),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();

        assert!(
            coordinator.observe_compositor_camera_source(None).is_none(),
            "a delayed old-generation removal is not replacement-bound evidence"
        );
        assert!(
            coordinator
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 7)))
                .is_none(),
            "a delayed old-generation adoption is neutral after replacement verification starts"
        );
        let status = coordinator.status();
        assert_eq!(status.phase, CaptureRecoveryPhase::Verifying);
        assert_eq!(status.source_generation, Some(8));
        assert!(coordinator.compositor_adopted_scope.is_none());
    }

    #[test]
    fn verification_requires_callbacks_publications_and_fresh_geometry() {
        let baseline = camera_evidence("camera:a", 8, 10, 10, 10);
        let current = camera_evidence("camera:a", 8, 70, 70, 70);
        let verified = verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(2))
            .expect("complete generation-bound evidence should verify");
        assert!(verified.contains("callbacks 30.0fps"));
        assert!(verified.contains("publications 30.0fps"));

        let mut no_publications = current.clone();
        no_publications.frame_store_publications = baseline.frame_store_publications;
        assert!(
            verify_camera_recovery_evidence(&baseline, &no_publications, Duration::from_secs(2),)
                .unwrap_err()
                .contains("FrameStore publications")
        );

        let mut stale = current.clone();
        stale.frame_age_ms = Some(2_000);
        assert!(
            verify_camera_recovery_evidence(&baseline, &stale, Duration::from_secs(2))
                .unwrap_err()
                .contains("fresh frame")
        );

        let mut wrong_geometry = current.clone();
        wrong_geometry.actual_width = Some(640);
        assert!(
            verify_camera_recovery_evidence(&baseline, &wrong_geometry, Duration::from_secs(2),)
                .unwrap_err()
                .contains("geometry mismatch")
        );
    }

    #[test]
    fn screen_verification_requires_callbacks_publications_sequence_and_fresh_geometry() {
        let baseline = screen_evidence("screen:a", 8, 10, 10, 10);
        let current = screen_evidence("screen:a", 8, 70, 70, 70);
        let verified = verify_screen_recovery_evidence(&baseline, &current, Duration::from_secs(2))
            .expect("complete generation-bound screen evidence should verify");
        assert!(verified.contains("callbacks 30.0fps"));
        assert!(verified.contains("publications 30.0fps"));

        let mut no_publications = current.clone();
        no_publications.frame_store_publications = baseline.frame_store_publications;
        assert!(
            verify_screen_recovery_evidence(&baseline, &no_publications, Duration::from_secs(2))
                .unwrap_err()
                .contains("FrameStore publications")
        );

        let mut wrong_generation = current.clone();
        wrong_generation.generation += 1;
        assert!(
            verify_screen_recovery_evidence(&baseline, &wrong_generation, Duration::from_secs(2))
                .unwrap_err()
                .contains("source generation")
        );
    }

    #[test]
    fn verification_accepts_stable_aspect_fitted_geometry() {
        let mut baseline = camera_evidence("camera:a", 8, 10, 10, 10);
        baseline.requested_width = Some(1_000);
        baseline.requested_height = Some(720);
        baseline.actual_width = Some(1_000);
        baseline.actual_height = Some(563);
        baseline.configured_width = Some(1_000);
        baseline.configured_height = Some(563);
        let mut current = baseline.clone();
        current.capture_callback_count = 70;
        current.frame_store_publications = 70;
        current.latest_sequence = Some(70);

        verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(2))
            .expect("stable aspect-fit output must be accepted");
    }

    #[test]
    fn verification_accepts_stable_native_geometry_without_upscaling() {
        let mut baseline = camera_evidence("camera:a", 8, 10, 10, 10);
        baseline.requested_width = Some(1_280);
        baseline.requested_height = Some(720);
        baseline.actual_width = Some(640);
        baseline.actual_height = Some(480);
        baseline.configured_width = Some(640);
        baseline.configured_height = Some(480);
        let mut current = baseline.clone();
        current.capture_callback_count = 70;
        current.frame_store_publications = 70;
        current.latest_sequence = Some(70);

        verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(2))
            .expect("stable native-resolution output must be accepted without upscaling");
    }

    #[test]
    fn verification_uses_configured_output_when_live_ack_has_no_baseline_frame() {
        let mut baseline = camera_evidence("camera:a", 8, 10, 10, 10);
        baseline.requested_width = Some(1_280);
        baseline.requested_height = Some(720);
        baseline.configured_width = Some(640);
        baseline.configured_height = Some(480);
        baseline.actual_width = None;
        baseline.actual_height = None;
        baseline.latest_sequence = None;
        let mut current = baseline.clone();
        current.capture_callback_count = 40;
        current.frame_store_publications = 40;
        current.latest_sequence = Some(30);
        current.actual_width = Some(640);
        current.actual_height = Some(480);

        verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(1))
            .expect("first post-ack frame must match immutable configured output");

        current.actual_width = Some(1);
        current.actual_height = Some(1);
        assert!(
            verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(1))
                .unwrap_err()
                .contains("geometry mismatch"),
            "nonzero-but-corrupt geometry must not satisfy recovery"
        );
    }

    #[test]
    fn verification_floor_uses_stable_negotiated_camera_cadence() {
        let mut baseline = camera_evidence("camera:a", 8, 10, 10, 10);
        baseline.target_fps = 15;
        let mut current = baseline.clone();
        current.capture_callback_count = 20;
        current.frame_store_publications = 20;
        current.latest_sequence = Some(20);

        let message = verify_camera_recovery_evidence(&baseline, &current, Duration::from_secs(1))
            .expect("10fps delivery satisfies the 60% floor of negotiated 15fps");
        assert!(message.contains("callbacks 10.0fps"));
    }

    #[test]
    fn downstream_verification_requires_sustained_exact_generation_serve_rate() {
        let meaningful = CAPTURE_RECOVERY_DOWNSTREAM_RATE_WINDOW;
        assert!(
            verify_compositor_delivery_rate(100, 101, meaningful, 60, 30)
                .unwrap_err()
                .contains("below the required"),
            "one fresh compositor serve followed by a flat consumer must not certify recovery"
        );
        assert!(
            verify_compositor_delivery_rate(100, 136, meaningful, 60, 30).is_ok(),
            "18fps satisfies the negotiated min(camera 60, compositor 30) × 60% floor"
        );
        assert!(
            verify_compositor_delivery_rate(
                100,
                200,
                meaningful - Duration::from_millis(1),
                60,
                30,
            )
            .unwrap_err()
            .contains("not yet meaningful")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn prompt_downstream_evidence_matures_concurrently_with_producer_window() {
        let state = test_state();
        let started = Instant::now();
        record_compositor_camera_delivery_evidence(
            &state,
            "run-a",
            Some((SourceKey::camera("camera:a"), 8)),
            100,
        );

        tokio::time::advance(CAPTURE_RECOVERY_VERIFICATION_WINDOW).await;
        record_compositor_camera_delivery_evidence(
            &state,
            "run-a",
            Some((SourceKey::camera("camera:a"), 8)),
            136,
        );
        let evidence = compositor_camera_delivery_evidence(&state).unwrap();
        assert!(
            verify_compositor_delivery_rate(
                evidence.baseline_fresh_serves,
                evidence.current_fresh_serves,
                evidence.baseline_observed_at.elapsed(),
                60,
                30,
            )
            .is_ok()
        );
        assert!(
            started.elapsed() <= Duration::from_secs(4),
            "a prompt healthy restart must not serialize two 2-second verification windows"
        );
    }

    #[test]
    fn camera_and_screen_compositor_evidence_are_generation_scoped_independently() {
        let state = test_state();
        record_compositor_camera_delivery_evidence(
            &state,
            "run-a",
            Some((SourceKey::camera("camera:a"), 8)),
            40,
        );
        record_compositor_screen_delivery_evidence(
            &state,
            "run-a",
            Some((SourceKey::screen("screen:a"), 13)),
            70,
        );
        record_compositor_camera_delivery_evidence(
            &state,
            "run-a",
            Some((SourceKey::camera("camera:a"), 8)),
            45,
        );

        let camera = compositor_camera_delivery_evidence(&state).expect("camera evidence");
        let screen = compositor_screen_delivery_evidence(&state).expect("screen evidence");
        assert_eq!(camera.source, CaptureRecoverySource::Camera);
        assert_eq!(camera.source_key, SourceKey::camera("camera:a"));
        assert_eq!(camera.generation, 8);
        assert_eq!(camera.baseline_fresh_serves, 40);
        assert_eq!(camera.current_fresh_serves, 45);
        assert_eq!(screen.source, CaptureRecoverySource::Screen);
        assert_eq!(screen.source_key, SourceKey::screen("screen:a"));
        assert_eq!(screen.generation, 13);
        assert_eq!(screen.baseline_fresh_serves, 70);
        assert_eq!(screen.current_fresh_serves, 70);

        record_compositor_screen_delivery_evidence(&state, "run-a", None, 0);
        assert!(compositor_screen_delivery_evidence(&state).is_none());
        assert!(
            compositor_camera_delivery_evidence(&state).is_some(),
            "removing screen evidence must not clear camera verification state"
        );
    }

    #[test]
    fn missing_safe_restart_scope_becomes_explicit_non_retryable_failure() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(coordinator.observe_degraded(
            CaptureRecoveryStage::CameraDelivery,
            None,
            "camera delivery degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        let failed = coordinator
            .fail_unroutable_degradation(
                "no generation snapshot".to_string(),
                "2026-08-28T10:00:01Z".to_string(),
            )
            .expect("unroutable camera degradation must become explicit");
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert!(!failed.retryable);
        assert_eq!(failed.source, None);
        assert_eq!(failed.last_error.as_deref(), Some("no generation snapshot"));
    }

    #[test]
    fn recovered_dwell_resets_to_idle_without_overwriting_a_new_epoch() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(coordinator.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "render degraded".to_string(),
            "2026-08-28T10:00:00Z".to_string(),
        ));
        let recovered = coordinator
            .observe_pipeline_recovered(
                CaptureRecoveryStage::CompositorRender,
                "render recovered".to_string(),
                "2026-08-28T10:00:01Z".to_string(),
            )
            .unwrap();
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        let guard = coordinator.recovered_guard().unwrap();
        assert_eq!(
            coordinator
                .reset_recovered_if_current(&guard)
                .unwrap()
                .phase,
            CaptureRecoveryPhase::Idle
        );

        assert!(coordinator.observe_degraded(
            CaptureRecoveryStage::CompositorRender,
            None,
            "new render incident".to_string(),
            "2026-08-28T10:00:02Z".to_string(),
        ));
        assert!(
            coordinator.reset_recovered_if_current(&guard).is_none(),
            "the old dwell timer must not clear a newer incident"
        );
        assert_eq!(coordinator.status().phase, CaptureRecoveryPhase::Degraded);
    }

    #[test]
    fn camera_source_epoch_change_or_removal_invalidates_terminal_incidents() {
        let mut unscoped_failed = CaptureRecoveryCoordinator::default();
        assert!(unscoped_failed.observe_degraded(
            CaptureRecoveryStage::CameraDelivery,
            None,
            "camera delivery degraded without a restart snapshot".to_string(),
            "2026-08-28T09:59:58Z".to_string(),
        ));
        unscoped_failed
            .fail_unroutable_degradation(
                "no stable camera".to_string(),
                "2026-08-28T09:59:59Z".to_string(),
            )
            .unwrap();
        assert_eq!(
            unscoped_failed
                .observe_compositor_camera_source(Some(camera_scope("camera:new", 1)))
                .unwrap()
                .phase,
            CaptureRecoveryPhase::Idle,
            "adopting a real camera must clear an unscoped advisory failure"
        );

        let mut failed = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(&mut failed, camera_scope("camera:a", 7)));
        let ticket = failed
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        failed
            .restart_failed(
                &ticket,
                "forced startup failed".to_string(),
                Some(camera_scope("camera:a", 8)),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        assert!(
            failed
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
                .is_none(),
            "the exact failed generation remains the current incident"
        );
        assert_eq!(failed.status().phase, CaptureRecoveryPhase::Failed);
        assert_eq!(
            failed
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 9)))
                .unwrap()
                .phase,
            CaptureRecoveryPhase::Idle,
            "a user-owned generation change invalidates the failed incident"
        );

        let mut recovered = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(&mut recovered, camera_scope("camera:b", 11)));
        recovered
            .observe_pipeline_recovered(
                CaptureRecoveryStage::CameraDelivery,
                "camera recovered".to_string(),
                "2026-08-28T10:00:03Z".to_string(),
            )
            .unwrap();
        assert_eq!(
            recovered
                .observe_compositor_camera_source(None)
                .unwrap()
                .phase,
            CaptureRecoveryPhase::Idle,
            "camera removal invalidates a recovered incident and its dwell timer"
        );
    }

    #[test]
    fn explicit_disable_clears_failure_even_when_compositor_was_already_none() {
        let mut coordinator = CaptureRecoveryCoordinator::default();
        assert!(observe_camera(
            &mut coordinator,
            camera_scope("camera:a", 7)
        ));
        let ticket = coordinator
            .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
            .unwrap();
        assert!(
            coordinator.observe_compositor_camera_source(None).is_none(),
            "the intentional restart gap is neutral while Restarting"
        );
        coordinator
            .restart_failed(
                &ticket,
                "native restart failed".to_string(),
                Some(camera_scope("camera:a", 8)),
                "2026-08-28T10:00:02Z".to_string(),
            )
            .unwrap();
        assert_eq!(coordinator.status().phase, CaptureRecoveryPhase::Failed);

        let idle = coordinator
            .explicit_camera_configuration_changed()
            .expect("explicit disable is authoritative even without a new compositor edge");
        assert_eq!(idle.phase, CaptureRecoveryPhase::Idle);
    }

    #[tokio::test]
    async fn compositor_camera_epoch_invalidation_publishes_idle() {
        let state = test_state();
        let mut events = state.events.subscribe();
        {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .observe_pipeline_recovered(
                    CaptureRecoveryStage::CameraDelivery,
                    "camera recovered".to_string(),
                    "2026-08-28T10:00:01Z".to_string(),
                )
                .unwrap();
        }

        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:b", &layout, &video,
        )
        .await;
        let generation = preview_camera_restart_snapshot(&state)
            .await
            .expect("replacement camera snapshot")
            .generation;

        note_compositor_camera_source_adopted(&state, SourceKey::camera("camera:b"), generation)
            .await;
        assert_eq!(
            state.capture_recovery.lock().await.status().phase,
            CaptureRecoveryPhase::Idle
        );
        assert_eq!(recovery_event_phases(&mut events), vec!["idle"]);
    }

    #[tokio::test]
    async fn reverse_scheduled_publication_cannot_regress_status_revision() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let (older, newer) = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let older = coordinator.status();
            emit_recovery_status_at_commit(&state, &older);
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            let newer = coordinator.status();
            emit_recovery_status_at_commit(&state, &newer);
            (older, newer)
        };
        assert!(newer.revision > older.revision);

        assert!(publish_recovery_status(&state, newer.clone()).await);
        assert!(
            !publish_recovery_status(&state, older).await,
            "a stale publisher must be rejected after the newer revision"
        );

        assert_eq!(
            recovery_event_phases(&mut events),
            vec!["degraded", "restarting"]
        );
        assert_eq!(
            state.diagnostics.lock().await.capture_recovery_phase,
            Some(CaptureRecoveryPhase::Restarting)
        );
    }

    #[tokio::test]
    async fn cancelled_blocked_publication_does_not_consume_revision() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let status = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let status = coordinator.status();
            emit_recovery_status_at_commit(&state, &status);
            status
        };
        let diagnostics_guard = state.diagnostics.lock().await;
        let publish_state = state.clone();
        let publish_status = status.clone();
        let blocked =
            tokio::spawn(
                async move { publish_recovery_status(&publish_state, publish_status).await },
            );
        assert!(
            state.capture_recovery_published_revision.try_lock().is_ok(),
            "a diagnostics waiter must not consume the revision before its mirror commit"
        );
        blocked.abort();
        assert!(blocked.await.unwrap_err().is_cancelled());
        drop(diagnostics_guard);

        assert_eq!(
            *state.capture_recovery_published_revision.lock().await,
            0,
            "cancelled publication must leave its revision retryable"
        );
        assert!(publish_recovery_status(&state, status.clone()).await);
        let event = events.try_recv().expect("synchronous commit event");
        assert_eq!(event.payload["revision"], status.revision);
        assert!(
            events.try_recv().is_err(),
            "diagnostics retry emits no duplicate event"
        );
    }

    #[tokio::test]
    async fn status_advanced_while_diagnostics_blocked_rejects_stale_publication() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let older = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let status = coordinator.status();
            emit_recovery_status_at_commit(&state, &status);
            status
        };

        let diagnostics_guard = state.diagnostics.lock().await;
        let publish_state = state.clone();
        let blocked =
            tokio::spawn(async move { publish_recovery_status(&publish_state, older).await });
        tokio::task::yield_now().await;

        let newer = {
            let mut coordinator = state.capture_recovery.lock().await;
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            let status = coordinator.status();
            emit_recovery_status_at_commit(&state, &status);
            status
        };
        drop(diagnostics_guard);

        assert!(
            !blocked.await.unwrap(),
            "the publisher must revalidate after the diagnostics await"
        );
        assert_eq!(*state.capture_recovery_published_revision.lock().await, 0);
        assert_eq!(
            recovery_event_phases(&mut events),
            vec!["degraded", "restarting"]
        );
        assert_eq!(state.diagnostics.lock().await.capture_recovery_phase, None);

        assert!(publish_recovery_status(&state, newer.clone()).await);
        assert!(
            events.try_recv().is_err(),
            "diagnostics mirror emits no event"
        );
    }

    #[tokio::test]
    async fn delayed_lifecycle_diagnostics_commit_uses_the_current_aggregate() {
        let state = test_state();
        let diagnostics_guard = state.diagnostics.lock().await;
        let publish_state = state.clone();
        let publish = tokio::spawn(async move {
            publish_current_capture_health_diagnostics(&publish_state).await;
        });
        tokio::task::yield_now().await;
        state
            .capture_health_stage_latches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set(CaptureStage::CameraDelivery, true);
        drop(diagnostics_guard);
        publish.await.unwrap();

        assert_eq!(
            state
                .diagnostics
                .lock()
                .await
                .capture_pipeline_degraded_stage
                .as_deref(),
            Some(CaptureStage::CameraDelivery.label()),
            "a delayed lifecycle task must not erase a newer camera latch"
        );
    }

    #[tokio::test]
    async fn automatic_attempt_is_process_spawned_before_diagnostics_publication() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;
        let camera = install_test_camera(&state, "camera:a").await;
        let diagnostics_guard = state.diagnostics.lock().await;
        let entered = Arc::new(Notify::new());

        let status = handle_capture_health_transition_with_driver(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 1,
                camera_mutation_epoch: Some(state.capture_recovery_camera_mutation_epoch()),
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CameraDelivery,
                    detail: "camera delivery stalled".to_string(),
                    camera_epoch: Some(CaptureHealthCameraEpoch {
                        source_key: camera.source_key,
                        generation: camera.generation,
                    }),
                    screen_epoch: None,
                },
            },
            Arc::new(NeverResolvingRestartDriver {
                entered: Arc::clone(&entered),
            }),
        )
        .await;

        assert_eq!(status.phase, CaptureRecoveryPhase::Restarting);
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("driver entered while diagnostics publication remained blocked");
        drop(diagnostics_guard);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn automatic_attempt_survives_disposable_compositor_runtime_retirement() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;
        let camera = install_test_camera(&state, "camera:a").await;
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let completed = Arc::new(Notify::new());
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let driver: Arc<dyn CaptureRecoveryDriver> = Arc::new(RuntimeSurvivalDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            completed: Arc::clone(&completed),
            active: Arc::clone(&active),
            max_active: Arc::clone(&max_active),
        });
        let camera_mutation_epoch = state.capture_recovery_camera_mutation_epoch();
        let disposable_state = state.clone();
        let disposable = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(handle_capture_health_transition_with_driver(
                disposable_state,
                CaptureRecoveryHealthEvent {
                    compositor_run_id: "run-a".to_string(),
                    sequence: 1,
                    camera_mutation_epoch: Some(camera_mutation_epoch),
                    transition: CaptureHealthTransition::Degraded {
                        stage: CaptureStage::CameraDelivery,
                        detail: "camera stalled on disposable compositor runtime".to_string(),
                        camera_epoch: Some(CaptureHealthCameraEpoch {
                            source_key: camera.source_key,
                            generation: camera.generation,
                        }),
                        screen_epoch: None,
                    },
                },
                driver,
            ));
        });
        disposable.join().unwrap();

        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("process-owned recovery entered after caller runtime dropped");
        let recovery_epoch = state.capture_recovery.lock().await.epoch;
        assert!(state.capture_recovery_admission_is_current(recovery_epoch));

        // A real compositor replacement publishes both the retired run and
        // its successor. Neither downstream edge may revoke a camera restart
        // whose non-cancellable native join is already in flight.
        note_compositor_lifecycle_changed(&state, None).await;
        install_test_compositor_run(&state, "run-b").await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Restarting
        );
        assert_eq!(active.load(AtomicOrdering::Acquire), 1);
        assert!(
            state.capture_recovery_admission_is_current(recovery_epoch),
            "compositor churn must preserve the exact physical restart admission"
        );

        release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), completed.notified())
            .await
            .expect("native owner survived retirement and completed");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if capture_recovery_status(&state).await.phase == CaptureRecoveryPhase::Idle
                    && !state.capture_recovery_admission_is_current(recovery_epoch)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("completed driver clears its exact physical admission");
        assert_eq!(active.load(AtomicOrdering::Acquire), 0);
        assert_eq!(max_active.load(AtomicOrdering::Acquire), 1);
    }

    #[tokio::test]
    async fn manual_attempt_is_process_spawned_before_diagnostics_publication() {
        let state = test_state();
        let camera = install_test_camera(&state, "camera:a").await;
        {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                CaptureRecoveryScope::camera(camera.source_key, camera.generation)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            coordinator
                .restart_failed(
                    &ticket,
                    "test retryable failure".to_string(),
                    Some(ticket.scope.clone()),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
        }
        let diagnostics_guard = state.diagnostics.lock().await;
        let entered = Arc::new(Notify::new());
        let status = retry_capture_recovery_with_driver(
            state.clone(),
            Arc::new(NeverResolvingRestartDriver {
                entered: Arc::clone(&entered),
            }),
        )
        .await;

        assert_eq!(status.phase, CaptureRecoveryPhase::Restarting);
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("manual driver entered while diagnostics publication remained blocked");
        drop(diagnostics_guard);
    }

    #[tokio::test]
    async fn superseded_queued_ticket_never_crosses_physical_restart_boundary() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let release = Arc::new(Notify::new());
        let restarts = Arc::new(AtomicUsize::new(0));
        let queued_state = state.clone();
        let queued_release = Arc::clone(&release);
        let queued_restarts = Arc::clone(&restarts);
        let queued = state.spawn_process_task(async move {
            queued_release.notified().await;
            run_recovery_attempt(
                queued_state,
                ticket,
                Arc::new(CountingRestartDriver {
                    restarts: queued_restarts,
                }),
            )
            .await;
        });

        // Model the preview-locked explicit boundary while coordinator
        // reconciliation is deliberately still delayed. The physical driver
        // must already see admission revoked.
        let _explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();
        release.notify_one();
        queued.await.unwrap();
        assert_eq!(restarts.load(AtomicOrdering::Acquire), 0);
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle
        );
    }

    #[tokio::test]
    async fn delayed_pre_mutation_health_edge_cannot_start_a_post_mutation_restart() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;
        let camera = install_test_camera(&state, "camera:a").await;
        let sampled_camera_mutation_epoch = state.capture_recovery_camera_mutation_epoch();
        let delayed_event = CaptureRecoveryHealthEvent {
            compositor_run_id: "run-a".to_string(),
            sequence: 1,
            camera_mutation_epoch: Some(sampled_camera_mutation_epoch),
            transition: CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                detail: "camera decay sampled before explicit mutation".to_string(),
                camera_epoch: Some(CaptureHealthCameraEpoch {
                    source_key: camera.source_key,
                    generation: camera.generation,
                }),
                screen_epoch: None,
            },
        };
        let restarts = Arc::new(AtomicUsize::new(0));

        let _explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();
        note_explicit_camera_configuration_changed(&state).await;
        assert_ne!(
            state.capture_recovery_camera_mutation_epoch(),
            sampled_camera_mutation_epoch
        );
        let status = handle_capture_health_transition_with_driver(
            state.clone(),
            delayed_event,
            Arc::new(CountingRestartDriver {
                restarts: Arc::clone(&restarts),
            }),
        )
        .await;

        assert_eq!(status.phase, CaptureRecoveryPhase::Idle);
        assert_eq!(status.attempts, 0);
        assert_eq!(restarts.load(AtomicOrdering::Acquire), 0);
    }

    #[tokio::test]
    async fn active_explicit_mutation_lease_rejects_a_fresh_same_epoch_health_event() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;
        let camera = install_test_camera(&state, "camera:a").await;
        let explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();
        let inside_transaction_epoch = state.capture_recovery_camera_mutation_epoch();
        let restarts = Arc::new(AtomicUsize::new(0));

        let status = handle_capture_health_transition_with_driver(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 1,
                camera_mutation_epoch: Some(inside_transaction_epoch),
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CameraDelivery,
                    detail: "three bad windows accumulated inside layout mutation".to_string(),
                    camera_epoch: Some(CaptureHealthCameraEpoch {
                        source_key: camera.source_key,
                        generation: camera.generation,
                    }),
                    screen_epoch: None,
                },
            },
            Arc::new(CountingRestartDriver {
                restarts: Arc::clone(&restarts),
            }),
        )
        .await;

        assert_eq!(status.phase, CaptureRecoveryPhase::Idle);
        assert_eq!(status.attempts, 0);
        assert_eq!(restarts.load(AtomicOrdering::Acquire), 0);
        explicit_mutation.finish();
        assert_ne!(
            state.capture_recovery_camera_mutation_epoch(),
            inside_transaction_epoch,
            "transaction end makes all inside-transaction evidence stale"
        );
    }

    #[tokio::test]
    async fn explicit_mutation_leases_are_unique_and_nesting_safe() {
        let state = test_state();
        let initial_epoch = state.capture_recovery_camera_mutation_epoch();
        let outer = state.begin_capture_recovery_explicit_camera_mutation();
        let outer_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(outer_epoch > initial_epoch);
        let inner = state.begin_capture_recovery_explicit_camera_mutation();
        let inner_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(inner_epoch > outer_epoch);

        outer.finish();
        let outer_end_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(outer_end_epoch > inner_epoch);
        assert!(
            state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active(),
            "ending one nested lease must not expose the remaining transaction"
        );

        inner.finish();
        assert!(state.capture_recovery_camera_mutation_epoch() > outer_end_epoch);
        assert!(
            !state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active()
        );
    }

    #[tokio::test]
    async fn cancelling_a_task_drops_its_lease_and_reconciles_failed_authority() {
        let state = test_state();
        {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            coordinator
                .restart_failed(
                    &ticket,
                    "failure before cancelled operator mutation".to_string(),
                    Some(camera_scope("camera:a", 7)),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
        }
        let entered = Arc::new(Notify::new());
        let task_state = state.clone();
        let task_entered = Arc::clone(&entered);
        let task = tokio::spawn(async move {
            let _explicit_mutation = task_state.begin_capture_recovery_explicit_camera_mutation();
            task_entered.notify_one();
            std::future::pending::<()>().await;
        });
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("mutation task entered");
        let inside_transaction_epoch = state.capture_recovery_camera_mutation_epoch();
        assert!(
            state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active()
        );
        state.set_capture_recovery_admission_epoch(91);

        task.abort();
        let _ = task.await;

        assert!(state.capture_recovery_camera_mutation_epoch() > inside_transaction_epoch);
        assert!(
            !state
                .lock_capture_recovery_admission_gate()
                .explicit_camera_mutation_is_active()
        );
        assert!(
            !state.capture_recovery_admission_is_current(91),
            "Drop must revoke any admission published while its transaction was active"
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let published_epoch = state.capture_recovery_camera_mutation_epoch();
                let coordinator = state.capture_recovery.lock().await;
                if coordinator.phase == CaptureRecoveryPhase::Idle
                    && coordinator.camera_mutation_epoch == published_epoch
                {
                    break;
                }
                drop(coordinator);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Drop schedules process-owned failed-authority reconciliation");
    }

    #[tokio::test]
    async fn dropped_lease_eventually_reconciles_degraded_authority_to_its_end_epoch() {
        let state = test_state();
        {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
        }
        {
            let _explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();
        }
        let lease_end_epoch = state.capture_recovery_camera_mutation_epoch();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let coordinator = state.capture_recovery.lock().await;
                if coordinator.phase == CaptureRecoveryPhase::Idle
                    && coordinator.camera_mutation_epoch == lease_end_epoch
                {
                    break;
                }
                drop(coordinator);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Drop schedules process-owned degraded-authority reconciliation");
    }

    #[tokio::test]
    async fn late_reconciliation_cannot_clear_an_incident_admitted_for_the_new_mutation_epoch() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;
        let camera = install_test_camera(&state, "camera:a").await;
        state
            .begin_capture_recovery_explicit_camera_mutation()
            .finish();
        let entered = Arc::new(Notify::new());

        let status = handle_capture_health_transition_with_driver(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 1,
                camera_mutation_epoch: Some(state.capture_recovery_camera_mutation_epoch()),
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CameraDelivery,
                    detail: "post-mutation camera decay".to_string(),
                    camera_epoch: Some(CaptureHealthCameraEpoch {
                        source_key: camera.source_key,
                        generation: camera.generation,
                    }),
                    screen_epoch: None,
                },
            },
            Arc::new(NeverResolvingRestartDriver {
                entered: Arc::clone(&entered),
            }),
        )
        .await;
        assert_eq!(status.phase, CaptureRecoveryPhase::Restarting);
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("post-boundary recovery driver entered");

        note_explicit_camera_configuration_changed(&state).await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Restarting,
            "reconciliation adopts an already-published epoch exactly once"
        );
    }

    #[tokio::test]
    async fn shutdown_latch_rejects_late_queued_recovery_before_driver_admission() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        let restarts = Arc::new(AtomicUsize::new(0));
        assert!(state.request_process_shutdown());

        run_recovery_attempt(
            state.clone(),
            ticket,
            Arc::new(CountingRestartDriver {
                restarts: Arc::clone(&restarts),
            }),
        )
        .await;

        assert_eq!(restarts.load(AtomicOrdering::Acquire), 0);
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle
        );
    }

    #[tokio::test]
    async fn stale_async_compositor_adoption_cannot_erase_newer_generation_incident() {
        let state = test_state();
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:a", &layout, &video,
        )
        .await;
        let stale_generation = preview_camera_restart_snapshot(&state)
            .await
            .expect("initial camera snapshot")
            .generation;
        let current_generation =
            crate::preview_camera::test_advance_live_camera_generation(&state, 43).await;
        assert_ne!(stale_generation, current_generation);
        {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", current_generation)
            ));
            coordinator
                .observe_pipeline_recovered(
                    CaptureRecoveryStage::CameraDelivery,
                    "new generation recovered".to_string(),
                    "2026-08-28T10:00:01Z".to_string(),
                )
                .unwrap();
        }

        note_compositor_camera_source_adopted(
            &state,
            SourceKey::camera("camera:a"),
            stale_generation,
        )
        .await;

        assert_eq!(
            state.capture_recovery.lock().await.status().phase,
            CaptureRecoveryPhase::Recovered
        );
    }

    #[tokio::test]
    async fn delayed_post_validation_compositor_observations_preserve_verifying_admission() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            coordinator
                .restart_succeeded(
                    &ticket,
                    &restart_evidence("camera:a", 8),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
            ticket
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);

        assert!(
            commit_compositor_camera_source_observation(&state, None)
                .await
                .is_none(),
            "a delayed removal cannot retire replacement verification"
        );
        assert!(
            commit_compositor_camera_source_observation(&state, Some(camera_scope("camera:a", 7)),)
                .await
                .is_none(),
            "a delayed retired-generation adoption cannot retire replacement verification"
        );
        let status = capture_recovery_status(&state).await;
        assert_eq!(status.phase, CaptureRecoveryPhase::Verifying);
        assert_eq!(status.source_generation, Some(8));
        assert!(state.capture_recovery_admission_is_current(ticket.epoch));
    }

    #[tokio::test]
    async fn compositor_observation_cannot_revoke_a_newer_post_commit_admission() {
        let state = test_state();
        let first_ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            coordinator
                .restart_succeeded(
                    &ticket,
                    &restart_evidence("camera:a", 8),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
            let waiting = coordinator
                .verification_recovered(
                    &ticket,
                    "first recovery cadence verified".to_string(),
                    "2026-08-28T10:00:04Z".to_string(),
                )
                .unwrap();
            assert_eq!(waiting.phase, CaptureRecoveryPhase::Verifying);
            ticket
        };
        state.set_capture_recovery_admission_epoch(first_ticket.epoch);

        let recovered =
            commit_compositor_camera_source_observation(&state, Some(camera_scope("camera:a", 8)))
                .await
                .expect("exact adoption completes the first recovery");
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert!(
            !state.capture_recovery_admission_is_current(first_ticket.epoch),
            "the commit must revoke its own admission before releasing either ordering guard"
        );

        // Deterministically occupy the old commit->post-publication race with
        // a newer degradation. The observation tail may publish the older
        // status, but it must never revoke this new physical-restart ticket.
        let newer_ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(coordinator.observe_degraded(
                CaptureRecoveryStage::CameraDelivery,
                Some(camera_scope("camera:a", 8)),
                "new post-recovery degradation".to_string(),
                "2026-08-28T10:00:05Z".to_string(),
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:06Z".to_string(), Instant::now())
                .expect("new degradation admits a new restart");
            state
                .lock_capture_recovery_admission_gate()
                .set_admission_epoch(ticket.epoch);
            ticket
        };
        schedule_reset_if_recovered(&state).await;
        assert!(!publish_recovery_status(&state, recovered).await);
        assert!(
            state.capture_recovery_admission_is_current(newer_ticket.epoch),
            "post-commit work must preserve the newer admitted restart"
        );
    }

    #[tokio::test]
    async fn active_explicit_mutation_rejects_verification_recovered_commit() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            assert!(
                coordinator
                    .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
                    .is_none()
            );
            coordinator
                .restart_succeeded(
                    &ticket,
                    &restart_evidence("camera:a", 8),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
            ticket
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();

        let status = commit_recovery_verification_outcome(
            &state,
            &ticket,
            CaptureRecoveryVerificationOutcome::Recovered("stale pre-mutation cadence".to_string()),
        )
        .await
        .expect("the explicit boundary reconciles the in-flight attempt");
        assert_eq!(status.phase, CaptureRecoveryPhase::Idle);
        assert_ne!(status.phase, CaptureRecoveryPhase::Recovered);
        assert!(!state.capture_recovery_admission_is_current(ticket.epoch));

        explicit_mutation.finish();
    }

    #[tokio::test]
    async fn active_explicit_mutation_rejects_restart_failure_automatic_retry() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();

        let committed = commit_restart_failure_or_retry(
            &state,
            &ticket,
            "stale restart failed during operator mutation".to_string(),
            Some(camera_scope("camera:a", 8)),
        )
        .await;

        assert!(committed.retry_ticket.is_none());
        assert!(!committed.warn_camera);
        assert_eq!(
            committed
                .status
                .expect("the explicit boundary reconciles the in-flight restart")
                .phase,
            CaptureRecoveryPhase::Idle
        );
        assert!(!state.capture_recovery_admission_is_current(ticket.epoch));
        assert_eq!(capture_recovery_status(&state).await.attempts, 0);

        explicit_mutation.finish();
    }

    #[tokio::test]
    async fn active_explicit_mutation_rejects_delayed_exact_adoption_recovered_commit() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            coordinator
                .restart_succeeded(
                    &ticket,
                    &restart_evidence("camera:a", 8),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
            let waiting = coordinator
                .verification_recovered(
                    &ticket,
                    "stale pre-mutation cadence".to_string(),
                    "2026-08-28T10:00:04Z".to_string(),
                )
                .unwrap();
            assert_eq!(waiting.phase, CaptureRecoveryPhase::Verifying);
            ticket
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();

        let status =
            commit_compositor_camera_source_observation(&state, Some(camera_scope("camera:a", 8)))
                .await
                .expect("the explicit boundary reconciles delayed adoption");
        assert_eq!(status.phase, CaptureRecoveryPhase::Idle);
        assert_ne!(status.phase, CaptureRecoveryPhase::Recovered);
        assert!(!state.capture_recovery_admission_is_current(ticket.epoch));

        explicit_mutation.finish();
    }

    #[tokio::test]
    async fn paused_old_generation_health_edge_cannot_restart_new_camera_generation() {
        let state = test_state();
        install_test_compositor_run(&state, "compositor-a").await;
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:a", &layout, &video,
        )
        .await;
        let old_generation = preview_camera_restart_snapshot(&state)
            .await
            .unwrap()
            .generation;
        let newer_generation =
            crate::preview_camera::test_advance_live_camera_generation(&state, 43).await;

        let status = handle_capture_health_transition(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "compositor-a".to_string(),
                sequence: 1,
                camera_mutation_epoch: Some(state.capture_recovery_camera_mutation_epoch()),
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CameraDelivery,
                    detail: "old paused edge".to_string(),
                    camera_epoch: Some(CaptureHealthCameraEpoch {
                        source_key: SourceKey::camera("camera:a"),
                        generation: old_generation,
                    }),
                    screen_epoch: None,
                },
            },
        )
        .await;

        assert_ne!(old_generation, newer_generation);
        assert_eq!(status.phase, CaptureRecoveryPhase::Idle);
        assert_eq!(status.attempts, 0);
        assert_eq!(
            preview_camera_restart_snapshot(&state)
                .await
                .unwrap()
                .generation,
            newer_generation
        );
    }

    #[tokio::test]
    async fn compositor_health_events_reject_old_runs_and_reverse_order() {
        let state = test_state();
        install_test_compositor_run(&state, "run-a").await;

        let degraded = handle_capture_health_transition(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 2,
                camera_mutation_epoch: None,
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CompositorRender,
                    detail: "run-a stalled".to_string(),
                    camera_epoch: None,
                    screen_epoch: None,
                },
            },
        )
        .await;
        assert_eq!(degraded.phase, CaptureRecoveryPhase::Degraded);

        let reverse_recovered = handle_capture_health_transition(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 1,
                camera_mutation_epoch: None,
                transition: CaptureHealthTransition::Recovered {
                    stage: CaptureStage::CompositorRender,
                    detail: "delayed earlier edge".to_string(),
                    camera_epoch: None,
                    screen_epoch: None,
                },
            },
        )
        .await;
        assert_eq!(reverse_recovered.phase, CaptureRecoveryPhase::Degraded);

        install_test_compositor_run(&state, "run-b").await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle,
            "run replacement explicitly retires run-a's render incident"
        );
        let delayed_old_run = handle_capture_health_transition(
            state.clone(),
            CaptureRecoveryHealthEvent {
                compositor_run_id: "run-a".to_string(),
                sequence: 3,
                camera_mutation_epoch: None,
                transition: CaptureHealthTransition::Degraded {
                    stage: CaptureStage::CompositorRender,
                    detail: "late old-run edge".to_string(),
                    camera_epoch: None,
                    screen_epoch: None,
                },
            },
        )
        .await;
        assert_eq!(delayed_old_run.phase, CaptureRecoveryPhase::Idle);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn armed_smoke_stall_is_bound_to_old_generation_and_auto_clears() {
        let state = test_state();
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:a", &layout, &video,
        )
        .await;
        let old = preview_camera_restart_snapshot(&state).await.unwrap();
        let old_epoch = CaptureHealthCameraEpoch {
            source_key: old.source_key.clone(),
            generation: old.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move { arm_camera_delivery_degradation(&arm_state).await });
        let first = loop {
            if let Some(sample) =
                apply_camera_delivery_smoke_fault(&state, &old_epoch, 500, 600, 600)
            {
                break sample;
            }
            tokio::task::yield_now().await;
        };
        let ack = arm.await.unwrap().expect("live generation arms");
        assert_eq!(ack.source_generation, old.generation);
        assert!(first.first_sample);
        let second = apply_camera_delivery_smoke_fault(&state, &old_epoch, 700, 800, 800)
            .expect("same old generation remains stalled");
        assert!(!second.first_sample);
        assert_eq!(second.fresh_serves, first.fresh_serves);
        assert_eq!(second.capture_callbacks, first.capture_callbacks);

        let new_generation =
            crate::preview_camera::test_advance_live_camera_generation(&state, 43).await;
        let new_epoch = CaptureHealthCameraEpoch {
            source_key: old.source_key,
            generation: new_generation,
        };
        assert!(
            apply_camera_delivery_smoke_fault(&state, &new_epoch, 1, 1, 1).is_none(),
            "a replacement generation receives real evidence and clears the old fault"
        );
        assert!(
            apply_camera_delivery_smoke_fault(&state, &old_epoch, 900, 900, 900).is_none(),
            "cleared old fault cannot reactivate"
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn armed_screen_smoke_stall_is_bound_to_old_generation_and_auto_clears() {
        let state = test_state();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        let screen_id = "screen:screencapturekit:smoke-generation";
        crate::preview_screen::test_install_live_screen_generation(
            &state, screen_id, 7, 41, &video,
        )
        .await;
        let old = preview_screen_restart_snapshot(&state).await.unwrap();
        let old_epoch = CaptureHealthScreenEpoch {
            source_key: old.source_key.clone(),
            generation: old.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move { arm_screen_delivery_degradation(&arm_state).await });
        let first = loop {
            if let Some(sample) =
                apply_screen_delivery_smoke_fault(&state, &old_epoch, 500, 600, 600)
            {
                break sample;
            }
            tokio::task::yield_now().await;
        };
        let ack = arm.await.unwrap().expect("live screen generation arms");
        assert_eq!(ack.source_generation, old.generation);
        assert!(first.first_sample);
        assert!(
            apply_camera_delivery_smoke_fault(
                &state,
                &CaptureHealthCameraEpoch {
                    source_key: SourceKey::camera("camera:unrelated"),
                    generation: 1,
                },
                1,
                1,
                1,
            )
            .is_none(),
            "sampling the concurrently live camera must not clear a screen-scoped fault"
        );
        let second = apply_screen_delivery_smoke_fault(&state, &old_epoch, 700, 800, 800)
            .expect("same old generation remains stalled");
        assert!(!second.first_sample);
        assert_eq!(second.fresh_serves, first.fresh_serves);
        assert_eq!(second.capture_callbacks, first.capture_callbacks);

        let new_generation =
            crate::preview_screen::test_advance_live_screen_generation(&state, 43).await;
        let new_epoch = CaptureHealthScreenEpoch {
            source_key: old.source_key,
            generation: new_generation,
        };
        assert!(
            apply_screen_delivery_smoke_fault(&state, &new_epoch, 1, 1, 1).is_none(),
            "a replacement screen generation receives real evidence and clears the old fault"
        );
        assert!(
            apply_screen_delivery_smoke_fault(&state, &old_epoch, 900, 900, 900).is_none(),
            "cleared old screen fault cannot reactivate"
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test(start_paused = true)]
    async fn smoke_ack_starts_after_first_natural_window_with_sub_six_second_headroom() {
        let state = test_state();
        let camera = install_test_camera(&state, "camera:a").await;
        let epoch = CaptureHealthCameraEpoch {
            source_key: camera.source_key,
            generation: camera.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move { arm_camera_delivery_degradation(&arm_state).await });
        tokio::task::yield_now().await;

        // Worst tick phase: arming happens immediately after the preceding
        // diagnostics sample, so the first natural frozen window is 2s later.
        tokio::time::advance(Duration::from_secs(2)).await;
        let first = apply_camera_delivery_smoke_fault(&state, &epoch, 100, 100, 100)
            .expect("first natural frozen sample");
        let mut monitor = crate::capture_health::CaptureHealthMonitor::new();
        monitor.arm_camera_producer_stall(
            epoch.clone(),
            first.fresh_serves,
            first.capture_callbacks,
            first.frame_store_publications,
        );
        let stalled_sample =
            |stall: CaptureRecoverySmokeSample| crate::capture_health::CaptureHealthSample {
                target_fps: 30.0,
                render_fps: 30.0,
                camera_present: true,
                camera_target_fps: Some(30.0),
                camera_fresh_serves: stall.fresh_serves,
                camera_producer: Some(crate::capture_health::CaptureHealthCameraProducerSample {
                    epoch: epoch.clone(),
                    source_fps: None,
                    capture_callbacks: stall.capture_callbacks,
                    frame_store_publications: stall.frame_store_publications,
                    did_drop_callback_count: 0,
                    out_of_buffers: 0,
                    surface_backing_live_count: 0,
                    surface_backing_peak_count: 0,
                }),
                screen_present: false,
                screen_target_fps: None,
                screen_fresh_serves: 0,
                screen_producer: None,
                window_secs: 2.0,
            };
        assert!(monitor.observe(stalled_sample(first)).is_none());
        let ack = arm.await.unwrap().expect("first sample acknowledges arm");
        assert!(ack.armed);
        let ack_at = Instant::now();

        tokio::time::advance(Duration::from_secs(2)).await;
        let second = apply_camera_delivery_smoke_fault(&state, &epoch, 200, 200, 200).unwrap();
        assert!(monitor.observe(stalled_sample(second)).is_none());
        tokio::time::advance(Duration::from_secs(2)).await;
        let third = apply_camera_delivery_smoke_fault(&state, &epoch, 300, 300, 300).unwrap();
        assert!(matches!(
            monitor.observe(stalled_sample(third)),
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::CameraDelivery,
                ..
            })
        ));
        assert!(
            ack_at.elapsed() < Duration::from_secs(6),
            "ack→active keeps two full seconds of headroom under the strict harness limit"
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test(start_paused = true)]
    async fn screen_smoke_ack_starts_after_first_natural_window_with_sub_six_second_headroom() {
        let state = test_state();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        let screen_id = "screen:screencapturekit:smoke-timing";
        crate::preview_screen::test_install_live_screen_generation(
            &state, screen_id, 7, 41, &video,
        )
        .await;
        let screen = preview_screen_restart_snapshot(&state).await.unwrap();
        let epoch = CaptureHealthScreenEpoch {
            source_key: screen.source_key,
            generation: screen.generation,
        };
        let arm_state = state.clone();
        let arm = tokio::spawn(async move { arm_screen_delivery_degradation(&arm_state).await });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(2)).await;
        let first = apply_screen_delivery_smoke_fault(&state, &epoch, 100, 100, 100)
            .expect("first natural frozen screen sample");
        let mut monitor = crate::capture_health::CaptureHealthMonitor::new();
        monitor.arm_screen_producer_stall(
            epoch.clone(),
            first.fresh_serves,
            first.capture_callbacks,
            first.frame_store_publications,
        );
        let stalled_sample =
            |stall: CaptureRecoverySmokeSample| crate::capture_health::CaptureHealthSample {
                target_fps: 30.0,
                render_fps: 30.0,
                camera_present: false,
                camera_target_fps: None,
                camera_fresh_serves: 0,
                camera_producer: None,
                screen_present: true,
                screen_target_fps: Some(30.0),
                screen_fresh_serves: stall.fresh_serves,
                screen_producer: Some(crate::capture_health::CaptureHealthScreenProducerSample {
                    epoch: epoch.clone(),
                    capture_callbacks: stall.capture_callbacks,
                    frame_store_publications: stall.frame_store_publications,
                }),
                window_secs: 2.0,
            };
        assert!(monitor.observe(stalled_sample(first)).is_none());
        let ack = arm
            .await
            .unwrap()
            .expect("first sample acknowledges screen arm");
        assert!(ack.armed);
        let ack_at = Instant::now();

        tokio::time::advance(Duration::from_secs(2)).await;
        let second = apply_screen_delivery_smoke_fault(&state, &epoch, 200, 200, 200).unwrap();
        assert!(monitor.observe(stalled_sample(second)).is_none());
        tokio::time::advance(Duration::from_secs(2)).await;
        let third = apply_screen_delivery_smoke_fault(&state, &epoch, 300, 300, 300).unwrap();
        assert!(matches!(
            monitor.observe(stalled_sample(third)),
            Some(CaptureHealthTransition::Degraded {
                stage: CaptureStage::ScreenDelivery,
                ..
            })
        ));
        assert!(
            ack_at.elapsed() < Duration::from_secs(6),
            "screen ack→active keeps two full seconds of headroom under the strict harness limit"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn compositor_or_session_lifecycle_change_supersedes_verification_neutrally() {
        let state = test_state();
        let layout = crate::protocol::default_layout_settings();
        let video = crate::protocol::VideoSettings {
            preset: crate::protocol::VideoPreset::Custom,
            width: 8,
            height: 4,
            fps: 30,
            bitrate_kbps: 2_000,
        };
        crate::preview_camera::test_install_live_camera_for_layout(
            &state, "camera:a", &layout, &video,
        )
        .await;
        let snapshot = preview_camera_restart_snapshot(&state).await.unwrap();
        let baseline = preview_camera_recovery_evidence(&state, &snapshot)
            .await
            .unwrap();
        let current_run_id = compositor_status(&state).await.run_id;
        let current_session_id = state.diagnostics.lock().await.session_id.clone();

        for evidence in [
            CaptureRecoveryRestartEvidence {
                scope: CaptureRecoveryScope::camera(
                    snapshot.source_key.clone(),
                    snapshot.generation,
                ),
                baseline: CaptureRecoveryProducerEvidence::Camera(baseline.clone()),
                compositor_run_id: Some("retired-compositor".to_string()),
                session_id: current_session_id.clone(),
            },
            CaptureRecoveryRestartEvidence {
                scope: CaptureRecoveryScope::camera(
                    snapshot.source_key.clone(),
                    snapshot.generation,
                ),
                baseline: CaptureRecoveryProducerEvidence::Camera(baseline.clone()),
                compositor_run_id: current_run_id.clone(),
                session_id: Some("retired-session".to_string()),
            },
        ] {
            let verify = BackendCaptureRecoveryDriver.verify(state.clone(), evidence);
            let task = tokio::spawn(verify);
            tokio::task::yield_now().await;
            tokio::time::advance(CAPTURE_RECOVERY_VERIFICATION_WINDOW).await;
            tokio::task::yield_now().await;
            assert!(matches!(
                task.await.unwrap(),
                CaptureRecoveryVerificationOutcome::Superseded
            ));
        }
    }

    #[tokio::test]
    async fn status_is_pure_and_explicit_camera_mutation_reconciles_failed_authority() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let failed_status = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            let status = coordinator
                .restart_failed(
                    &ticket,
                    "forced startup failed".to_string(),
                    Some(camera_scope("camera:a", 8)),
                    "2026-08-28T10:00:02Z".to_string(),
                )
                .unwrap();
            emit_recovery_status_at_commit(&state, &status);
            status
        };
        publish_recovery_status(&state, failed_status).await;
        assert_eq!(
            state.diagnostics.lock().await.capture_recovery_phase,
            Some(CaptureRecoveryPhase::Failed)
        );

        let queried = capture_recovery_status(&state).await;
        assert_eq!(queried.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(
            state.diagnostics.lock().await.capture_recovery_phase,
            Some(CaptureRecoveryPhase::Failed),
            "a read-only query must not reconcile or emit"
        );

        let explicit_mutation = state.begin_capture_recovery_explicit_camera_mutation();
        note_explicit_camera_configuration_changed(&state).await;
        explicit_mutation.finish();
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle
        );
        let diagnostics = state.diagnostics.lock().await.clone();
        assert_eq!(diagnostics.capture_recovery_phase, None);
        assert_eq!(diagnostics.capture_recovery_source, None);
        assert_eq!(diagnostics.capture_recovery_attempts, None);
        assert_eq!(recovery_event_phases(&mut events), vec!["failed", "idle"]);
    }

    #[tokio::test(start_paused = true)]
    async fn run_attempt_emits_full_automatic_recovery_and_guarded_idle_lifecycle() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let driver = Arc::new(ScriptedRecoveryDriver::new(
            [CaptureRecoveryRestartOutcome::Restarted(
                boxed_restart_evidence("camera:a", 8),
            )],
            [CaptureRecoveryVerificationOutcome::Recovered(
                "camera cadence restored".to_string(),
            )],
        ));

        state
            .capture_recovery
            .lock()
            .await
            .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)));

        run_recovery_attempt(state.clone(), ticket, driver).await;
        let recovered = capture_recovery_status(&state).await;
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.trigger, Some(CaptureRecoveryTrigger::Automatic));
        assert_eq!(recovered.source_generation, Some(8));
        assert_eq!(recovered.attempts, 1);
        assert_eq!(
            recovery_event_phases(&mut events),
            vec!["verifying", "recovered"]
        );

        tokio::task::yield_now().await;
        tokio::time::advance(CAPTURE_RECOVERY_RECOVERED_DWELL).await;
        tokio::task::yield_now().await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle
        );
        assert_eq!(recovery_event_phases(&mut events), vec!["idle"]);
    }

    #[tokio::test(start_paused = true)]
    async fn blocked_intermediate_publication_cannot_delay_verify_or_idle_reset() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            let ticket = coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap();
            emit_recovery_status_at_commit(&state, &coordinator.status());
            ticket
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        state
            .capture_recovery
            .lock()
            .await
            .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)));
        let diagnostics_guard = state.diagnostics.lock().await;
        let attempt = tokio::spawn(run_recovery_attempt(
            state.clone(),
            ticket,
            Arc::new(ScriptedRecoveryDriver::new(
                [CaptureRecoveryRestartOutcome::Restarted(
                    boxed_restart_evidence("camera:a", 8),
                )],
                [CaptureRecoveryVerificationOutcome::Recovered(
                    "camera cadence restored despite blocked publication".to_string(),
                )],
            )),
        ));

        for _ in 0..100 {
            if capture_recovery_status(&state).await.phase == CaptureRecoveryPhase::Recovered {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Recovered,
            "verification control flow must outrun a blocked Verifying publication"
        );

        tokio::time::advance(CAPTURE_RECOVERY_RECOVERED_DWELL).await;
        tokio::task::yield_now().await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle,
            "the recovered dwell reset must be scheduled before terminal publication awaits"
        );
        assert_eq!(
            recovery_event_phases(&mut events),
            vec!["restarting", "verifying", "recovered", "idle"],
            "event history is committed in revision order even while diagnostics is blocked"
        );

        drop(diagnostics_guard);
        attempt.await.unwrap();
    }

    #[tokio::test]
    async fn run_attempt_retries_one_automatic_failure_without_intermediate_failed() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let automatic = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(automatic.epoch);
        let driver = Arc::new(ScriptedRecoveryDriver::new(
            [
                CaptureRecoveryRestartOutcome::Restarted(boxed_restart_evidence("camera:a", 8)),
                CaptureRecoveryRestartOutcome::Restarted(boxed_restart_evidence("camera:a", 9)),
            ],
            [
                CaptureRecoveryVerificationOutcome::Failed("cadence remained degraded".to_string()),
                CaptureRecoveryVerificationOutcome::Recovered(
                    "camera cadence restored".to_string(),
                ),
            ],
        ));

        run_recovery_attempt(state.clone(), automatic, driver.clone()).await;
        for _ in 0..100 {
            let status = capture_recovery_status(&state).await;
            if status.phase == CaptureRecoveryPhase::Verifying
                && status.source_generation == Some(9)
                && status
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("waiting for the compositor"))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        commit_compositor_camera_source_observation(&state, Some(camera_scope("camera:a", 9)))
            .await
            .expect("exact second replacement adoption completes recovery");

        let recovered = capture_recovery_status(&state).await;
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.trigger, Some(CaptureRecoveryTrigger::Automatic));
        assert_eq!(recovered.source_generation, Some(9));
        assert_eq!(recovered.attempts, 2);
        assert!(!recovered.retryable);
        assert_eq!(
            recovery_event_phases(&mut events),
            vec![
                "verifying",
                "restarting",
                "verifying",
                "verifying",
                "recovered"
            ],
            "the first definitive failure must flow directly into the retained-scope retry"
        );
        assert_eq!(driver.restart_calls(), MAX_AUTOMATIC_ATTEMPTS as usize);
    }

    #[tokio::test]
    async fn run_attempt_exhausts_two_automatic_attempts_and_warns_once() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let automatic = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(automatic.epoch);
        let driver = Arc::new(ScriptedRecoveryDriver::new(
            [
                CaptureRecoveryRestartOutcome::Restarted(boxed_restart_evidence("camera:a", 8)),
                CaptureRecoveryRestartOutcome::Restarted(boxed_restart_evidence("camera:a", 9)),
            ],
            [
                CaptureRecoveryVerificationOutcome::Failed("first cadence failure".to_string()),
                CaptureRecoveryVerificationOutcome::Failed("second cadence failure".to_string()),
            ],
        ));

        let delayed_first_ticket = automatic.clone();
        run_recovery_attempt(state.clone(), automatic, driver.clone()).await;
        for _ in 0..100 {
            if capture_recovery_status(&state).await.phase == CaptureRecoveryPhase::Failed {
                break;
            }
            tokio::task::yield_now().await;
        }

        let failed = capture_recovery_status(&state).await;
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(failed.trigger, Some(CaptureRecoveryTrigger::Automatic));
        assert_eq!(failed.source_generation, Some(9));
        assert_eq!(failed.attempts, 2);
        assert!(
            failed.retryable,
            "the exact failed generation remains manually retryable"
        );

        let mut recovery_phases = Vec::new();
        let mut warning_codes = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "capture.recovery.status" {
                recovery_phases.push(event.payload["phase"].as_str().unwrap().to_string());
            } else if event.event == "health.event" {
                warning_codes.push(event.payload["code"].as_str().unwrap().to_string());
                assert_eq!(event.payload["level"], "warn");
            }
        }
        assert_eq!(
            recovery_phases,
            vec!["verifying", "restarting", "verifying", "failed"]
        );
        assert_eq!(warning_codes, vec!["camera-degraded-restart-failed"]);
        assert_eq!(driver.restart_calls(), MAX_AUTOMATIC_ATTEMPTS as usize);

        let late = commit_verification_failure_or_retry(
            &state,
            &delayed_first_ticket,
            "late duplicate failure".to_string(),
        )
        .await;
        assert!(late.status.is_none());
        assert!(late.retry_ticket.is_none());
        assert!(!late.warn_camera);
        assert!(
            events.try_recv().is_err(),
            "late completion must emit nothing"
        );

        let manual = state
            .capture_recovery
            .lock()
            .await
            .begin_manual_retry(now_timestamp(), Instant::now())
            .expect("terminal exact generation stays manually retryable");
        assert_eq!(manual.trigger, CaptureRecoveryTrigger::Manual);
        assert_eq!(manual.scope, camera_scope("camera:a", 9));
        assert_eq!(capture_recovery_status(&state).await.attempts, 3);
    }

    #[tokio::test]
    async fn run_attempt_stale_completion_cannot_publish_over_a_new_epoch() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let stale = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = Arc::new(GatedRestartDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            outcome: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_restart_evidence("camera:a", 8),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), stale, driver));
        entered.notified().await;

        {
            let mut coordinator = state.capture_recovery.lock().await;
            coordinator
                .explicit_camera_configuration_changed()
                .expect("explicit source mutation supersedes the old attempt");
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:b", 11)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:02Z".to_string(), Instant::now())
                .expect("new source epoch owns its own automatic attempt");
        }
        release.notify_one();
        attempt.await.unwrap();

        let current = capture_recovery_status(&state).await;
        assert_eq!(current.phase, CaptureRecoveryPhase::Restarting);
        assert_eq!(current.source_generation, Some(11));
        assert_eq!(current.trigger, Some(CaptureRecoveryTrigger::Automatic));
        assert_eq!(current.attempts, 1);
        assert!(
            recovery_event_phases(&mut events).is_empty(),
            "stale completion must not publish an authoritative status"
        );
    }

    #[tokio::test]
    async fn stale_post_driver_completion_clears_its_exact_admission() {
        let state = test_state();
        let stale = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(stale.epoch);
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = Arc::new(GatedRestartDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            outcome: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_restart_evidence("camera:a", 8),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), stale.clone(), driver));
        entered.notified().await;

        state
            .capture_recovery
            .lock()
            .await
            .explicit_camera_configuration_changed()
            .expect("a newer coordinator epoch supersedes the blocked driver");
        assert!(state.capture_recovery_admission_is_current(stale.epoch));

        release.notify_one();
        attempt.await.unwrap();

        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Idle
        );
        assert!(
            !state.capture_recovery_admission_is_current(stale.epoch),
            "a stale post-driver None exit must release its exact admission"
        );
    }

    async fn assert_restart_contract_gets_a_fresh_verification_window(
        initial_scope: CaptureRecoveryScope,
        restarted_evidence: CaptureRecoveryRestartEvidence,
        native_restart_contract: Duration,
    ) {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(coordinator.observe_degraded(
                match initial_scope.source {
                    CaptureRecoverySource::Camera => CaptureRecoveryStage::CameraDelivery,
                    CaptureRecoverySource::Screen => CaptureRecoveryStage::ScreenDelivery,
                },
                Some(initial_scope),
                "generation-bound delivery decay".to_string(),
                "2026-08-28T10:00:00Z".to_string(),
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .expect("delivery decay admits its first automatic attempt")
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let restarted_scope = restarted_evidence.scope.clone();
        {
            let mut coordinator = state.capture_recovery.lock().await;
            match restarted_scope.source {
                CaptureRecoverySource::Camera => {
                    coordinator.observe_compositor_camera_source(Some(restarted_scope.clone()));
                }
                CaptureRecoverySource::Screen => {
                    coordinator.observe_compositor_screen_source(Some(restarted_scope.clone()));
                }
            }
        }

        let restart_entered = Arc::new(Notify::new());
        let restart_release = Arc::new(Notify::new());
        let verification_entered = Arc::new(Notify::new());
        let verification_release = Arc::new(Notify::new());
        let driver = Arc::new(GatedRecoveryStagesDriver {
            restart_entered: Arc::clone(&restart_entered),
            restart_release: Arc::clone(&restart_release),
            verification_entered: Arc::clone(&verification_entered),
            verification_release: Arc::clone(&verification_release),
            restart: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(Box::new(
                restarted_evidence,
            )))),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Recovered(
                "replacement cadence recovered".to_string(),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket, driver));
        restart_entered.notified().await;

        tokio::time::advance(native_restart_contract).await;
        tokio::task::yield_now().await;
        let restarting = state.capture_recovery.lock().await;
        assert_eq!(restarting.status().phase, CaptureRecoveryPhase::Restarting);
        assert!(
            !restarting.automatic_attempts_operator_latched,
            "a restart inside its native latency contract must not latch operator recovery"
        );
        drop(restarting);

        restart_release.notify_one();
        verification_entered.notified().await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Verifying
        );

        tokio::time::advance(
            CAPTURE_RECOVERY_VERIFICATION_WINDOW
                .saturating_add(CAPTURE_RECOVERY_DOWNSTREAM_VERIFICATION_WINDOW),
        )
        .await;
        tokio::task::yield_now().await;
        let verifying = state.capture_recovery.lock().await;
        assert_eq!(verifying.status().phase, CaptureRecoveryPhase::Verifying);
        assert!(
            !verifying.automatic_attempts_operator_latched,
            "verification gets a fresh deadline after a valid slow restart"
        );
        drop(verifying);

        verification_release.notify_one();
        attempt.await.expect("recovery attempt completes");
        let recovered = capture_recovery_status(&state).await;
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(
            recovered.source_generation,
            Some(restarted_scope.generation)
        );
        assert!(!recovered.retryable);
    }

    #[tokio::test(start_paused = true)]
    async fn camera_restart_contract_gets_a_fresh_verification_window() {
        assert_restart_contract_gets_a_fresh_verification_window(
            camera_scope("camera:a", 7),
            restart_evidence("camera:a", 8),
            CAPTURE_RECOVERY_CAMERA_NATIVE_RESTART_CONTRACT,
        )
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn screen_restart_contract_gets_a_fresh_verification_window() {
        assert_restart_contract_gets_a_fresh_verification_window(
            screen_scope("screen:a", 7),
            screen_restart_evidence("screen:a", 8),
            CAPTURE_RECOVERY_SCREEN_NATIVE_RESTART_CONTRACT,
        )
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn screen_teardown_watchdog_fails_publicly_without_cancelling_the_owner() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_screen(
                &mut coordinator,
                screen_scope("screen:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .expect("screen delivery decay admits its first automatic attempt")
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        {
            let mut coordinator = state.capture_recovery.lock().await;
            coordinator.observe_compositor_screen_source(Some(screen_scope("screen:a", 8)));
        }

        let teardown_entered = Arc::new(Notify::new());
        let teardown_release = Arc::new(Notify::new());
        let startup_entered = Arc::new(Notify::new());
        let startup_release = Arc::new(Notify::new());
        let startup_calls = Arc::new(AtomicUsize::new(0));
        let driver = Arc::new(DelayedScreenStartupBudgetDriver {
            teardown_entered: Arc::clone(&teardown_entered),
            teardown_release: Arc::clone(&teardown_release),
            startup_entered: Arc::clone(&startup_entered),
            startup_release: Arc::clone(&startup_release),
            startup_calls: Arc::clone(&startup_calls),
            restart: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_screen_restart_evidence("screen:a", 8),
            ))),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Recovered(
                "screen replacement cadence recovered".to_string(),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket, driver));
        teardown_entered.notified().await;
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }

        tokio::time::advance(capture_recovery_screen_teardown_watchdog_timeout()).await;
        tokio::task::yield_now().await;
        let teardown_status = state.capture_recovery.lock().await;
        assert_eq!(
            teardown_status.status().phase,
            CaptureRecoveryPhase::Failed,
            "a wedged old-owner join must fail public recovery within its teardown contract"
        );
        assert!(
            teardown_status.automatic_attempts_operator_latched,
            "automatic recovery remains operator-latched after the public teardown deadline"
        );
        assert!(
            teardown_status
                .status()
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("teardown is still pending"))
        );
        drop(teardown_status);
        assert!(
            !attempt.is_finished(),
            "the public watchdog must not cancel the process-owned native join"
        );
        assert_eq!(
            startup_calls.load(AtomicOrdering::SeqCst),
            0,
            "replacement startup cannot cross the blocked teardown owner"
        );

        teardown_release.notify_one();
        startup_entered.notified().await;
        assert_eq!(
            startup_calls.load(AtomicOrdering::SeqCst),
            1,
            "exactly one replacement may begin after teardown really finishes"
        );
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Failed,
            "late physical progress remains subordinate to the public watchdog until generation-bound evidence returns"
        );

        startup_release.notify_one();
        attempt
            .await
            .expect("late process-owned screen recovery reconciles");
        let recovered = capture_recovery_status(&state).await;
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.source_generation, Some(8));
        assert!(!recovered.retryable);
    }

    #[tokio::test(start_paused = true)]
    async fn watchdog_latched_screen_attempt_cannot_spawn_retry_after_late_verification_failure() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_screen(
                &mut coordinator,
                screen_scope("screen:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .expect("screen delivery decay admits its first automatic attempt")
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = Arc::new(GatedOutcomeDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            outcome: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_screen_restart_evidence("screen:a", 8),
            ))),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Failed(
                "late screen cadence remained degraded".to_string(),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket, driver));
        entered.notified().await;

        tokio::time::advance(capture_recovery_restart_watchdog_timeout(
            CaptureRecoverySource::Screen,
        ))
        .await;
        tokio::task::yield_now().await;
        let watchdog = capture_recovery_status(&state).await;
        assert_eq!(watchdog.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(watchdog.attempts, 1);

        release.notify_one();
        attempt.await.expect("late physical owner reconciles");
        let terminal = capture_recovery_status(&state).await;
        assert_eq!(terminal.phase, CaptureRecoveryPhase::Failed);
        assert_eq!(terminal.attempts, 1);
        assert_eq!(terminal.source_generation, Some(8));
        assert!(terminal.retryable);

        let manual = state
            .capture_recovery
            .lock()
            .await
            .begin_manual_retry(now_timestamp(), Instant::now())
            .expect("the exact failed screen generation remains operator-retryable");
        assert_eq!(manual.trigger, CaptureRecoveryTrigger::Manual);
        assert_eq!(manual.scope, screen_scope("screen:a", 8));
    }

    #[tokio::test(start_paused = true)]
    async fn watchdog_late_restart_success_retains_authority_and_recovers() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = Arc::new(GatedOutcomeDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            outcome: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_restart_evidence("camera:a", 8),
            ))),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Recovered(
                "late physical owner recovered cadence".to_string(),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket, driver));
        entered.notified().await;

        tokio::time::advance(capture_recovery_restart_watchdog_timeout(
            CaptureRecoverySource::Camera,
        ))
        .await;
        tokio::task::yield_now().await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Failed
        );
        assert!(
            state
                .capture_recovery
                .lock()
                .await
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
                .is_none(),
            "late same-key adoption remains owned by the timed-out ticket"
        );

        release.notify_one();
        attempt.await.unwrap();
        let recovered = capture_recovery_status(&state).await;
        assert_eq!(recovered.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(recovered.source_generation, Some(8));
        assert!(!recovered.retryable);
    }

    #[tokio::test(start_paused = true)]
    async fn revoked_lifecycle_admission_rejects_late_watchdog_verification_success() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let verification_entered = Arc::new(Notify::new());
        let verification_release = Arc::new(Notify::new());
        let driver = Arc::new(GatedVerificationDriver {
            entered: Arc::clone(&verification_entered),
            release: Arc::clone(&verification_release),
            restart: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Restarted(
                boxed_restart_evidence("camera:a", 8),
            ))),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Recovered(
                "retired compositor cadence".to_string(),
            ))),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket.clone(), driver));
        verification_entered.notified().await;

        tokio::time::advance(capture_recovery_verification_watchdog_timeout()).await;
        tokio::task::yield_now().await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Failed
        );
        note_compositor_lifecycle_changed(&state, Some("replacement-run".to_string())).await;
        assert!(
            !state.capture_recovery_admission_is_current(ticket.epoch),
            "the lifecycle boundary revokes the retired verification ticket"
        );

        verification_release.notify_one();
        attempt.await.unwrap();
        let terminal = capture_recovery_status(&state).await;
        assert_ne!(terminal.phase, CaptureRecoveryPhase::Recovered);
        assert_eq!(terminal.phase, CaptureRecoveryPhase::Idle);
        assert!(!state.capture_recovery_admission_is_current(ticket.epoch));
    }

    #[tokio::test(start_paused = true)]
    async fn watchdog_late_failed_start_exposes_exact_safe_retry_scope() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = Arc::new(GatedOutcomeDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            outcome: StdMutex::new(Some(CaptureRecoveryRestartOutcome::Failed {
                error: "late native start failed".to_string(),
                retry_scope: Some(camera_scope("camera:a", 8)),
            })),
            verification: StdMutex::new(Some(CaptureRecoveryVerificationOutcome::Superseded)),
        });
        let attempt = tokio::spawn(run_recovery_attempt(state.clone(), ticket, driver));
        entered.notified().await;

        tokio::time::advance(capture_recovery_restart_watchdog_timeout(
            CaptureRecoverySource::Camera,
        ))
        .await;
        tokio::task::yield_now().await;
        assert!(!capture_recovery_status(&state).await.retryable);

        release.notify_one();
        attempt.await.unwrap();
        let failed = capture_recovery_status(&state).await;
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert!(failed.retryable);
        assert_eq!(failed.source_generation, Some(8));
        assert_eq!(
            failed.last_error.as_deref(),
            Some("late native start failed")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn never_resolving_restart_hits_public_watchdog_without_cancelling_owner() {
        let state = test_state();
        let ticket = {
            let mut coordinator = state.capture_recovery.lock().await;
            assert!(observe_camera(
                &mut coordinator,
                camera_scope("camera:a", 7)
            ));
            coordinator
                .begin_automatic("2026-08-28T10:00:01Z".to_string(), Instant::now())
                .unwrap()
        };
        state.set_capture_recovery_admission_epoch(ticket.epoch);
        let entered = Arc::new(Notify::new());
        let attempt = tokio::spawn(run_recovery_attempt(
            state.clone(),
            ticket,
            Arc::new(NeverResolvingRestartDriver {
                entered: Arc::clone(&entered),
            }),
        ));
        entered.notified().await;

        tokio::time::advance(capture_recovery_restart_watchdog_timeout(
            CaptureRecoverySource::Camera,
        ))
        .await;
        tokio::task::yield_now().await;
        let failed = capture_recovery_status(&state).await;
        assert_eq!(failed.phase, CaptureRecoveryPhase::Failed);
        assert!(!failed.retryable);
        assert!(
            failed
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("teardown is still pending"))
        );
        assert!(
            !attempt.is_finished(),
            "the watchdog must leave the native owner future alive so its transition guard remains held"
        );

        note_compositor_camera_source_removed(&state).await;
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Failed,
            "the timed-out owner's late internal removal must preserve the teardown-pending latch"
        );
        assert!(
            state
                .capture_recovery
                .lock()
                .await
                .observe_compositor_camera_source(Some(camera_scope("camera:a", 8)))
                .is_none(),
            "a late unverified generation from the timed-out attempt must not erase its terminal status"
        );
        assert!(
            !state.capture_recovery.lock().await.observe_degraded(
                CaptureRecoveryStage::CameraDelivery,
                Some(camera_scope("camera:a", 8)),
                "late same-key generation health edge".to_string(),
                "2026-08-28T10:00:12Z".to_string(),
            ),
            "a late same-key generation cannot admit a second automatic incident while teardown remains owned"
        );
        assert_eq!(
            capture_recovery_status(&state).await.phase,
            CaptureRecoveryPhase::Failed
        );

        // This is a fake never-resolving driver with no native resource. The
        // production path deliberately remains alive until physical teardown.
        attempt.abort();
    }
}
