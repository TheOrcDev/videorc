use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use chrono::Utc;
use tokio::sync::{Notify, broadcast, watch};

use crate::capture_health::{CaptureHealthStageLatchesSlot, new_capture_health_stage_latches_slot};
use crate::capture_interruption::CaptureInterruptionCoordinator;
use crate::capture_recovery::{
    CaptureRecoveryCompositorEvidenceSlot, CaptureRecoverySlot,
    INITIAL_CAPTURE_RECOVERY_CAMERA_MUTATION_EPOCH, new_capture_recovery_compositor_evidence_slot,
    new_capture_recovery_slot,
};
#[cfg(debug_assertions)]
use crate::capture_recovery::{
    CaptureRecoverySmokeFaultSlot, new_capture_recovery_smoke_fault_slot,
};
use crate::compositor::{CompositorSlot, initial_compositor_state};
use crate::diagnostics::idle_diagnostics;
use crate::ffmpeg_work::FfmpegWorkCoordinator;
use crate::live_chat::{LiveChatCoordinator, LiveChatSlot};
use crate::live_chat_persistence::LiveChatPersistence;
use crate::oauth::OAuthSessions;
use crate::preview_camera::{PreviewCameraSlot, initial_preview_camera_state};
use crate::preview_screen::{PreviewScreenSlot, initial_preview_screen_state};
use crate::preview_surface::{PreviewSurfaceSlot, initial_preview_surface_state};
use crate::protocol::{
    AudioMeterSampleSnapshot, BackendLogEvent, DiagnosticStats, Scene, ServerEvent,
    VideorcAccountSnapshot, WebSocketCommandLaneDiagnosticStats, WebSocketQueueDiagnosticStats,
    WebSocketTransportDiagnosticStats,
};
use crate::recording::{LivePreviewSlot, RecordingSlot, initial_live_preview_state};
use crate::resource_authority::ResourceAuthority;
use crate::scene::default_scene;
use crate::source_registry::SourceRegistry;
use crate::storage::Database;
use crate::windows_d3d11_device::{
    DxgiAdapterLuid, WindowsD3d11CoordinatorReleaseAction, WindowsD3d11Error,
    WindowsD3d11MediaCoordinatorState,
};
#[cfg(target_os = "windows")]
use crate::windows_d3d11_device::{
    WindowsD3d11MediaClient, WindowsD3d11MediaRole, WindowsD3d11MediaThread, WindowsD3d11RoleLease,
    WindowsD3d11TexturePoolConfig, WindowsDxgiOutputSelection,
};

const PREVIEW_FRAME_CHANNEL_CAPACITY: usize = 256;
const LOG_HISTORY_LIMIT: usize = 200;

#[derive(Debug)]
struct CaptureRecoveryAdmissionState {
    camera_mutation_epoch: u64,
    admission_epoch: u64,
    next_explicit_camera_mutation_lease_id: u64,
    active_explicit_camera_mutation_leases: BTreeSet<u64>,
}

impl CaptureRecoveryAdmissionState {
    fn advance_camera_mutation_epoch_and_revoke_admission(&mut self) -> u64 {
        self.camera_mutation_epoch = self
            .camera_mutation_epoch
            .checked_add(1)
            .expect("capture recovery camera mutation epoch exhausted");
        self.admission_epoch = 0;
        self.camera_mutation_epoch
    }
}

/// Transaction-scoped explicit camera mutation boundary. Each unique lease is
/// nesting-safe. Dropping it on success, error, cancellation, or panic revokes
/// recovery admission again and advances the sampling epoch, making every
/// health window collected inside the transaction stale.
#[must_use = "the explicit camera mutation lease must live for the whole transaction"]
pub(crate) struct CaptureRecoveryExplicitCameraMutationLease {
    state: AppState,
    lease_id: Option<u64>,
}

impl CaptureRecoveryExplicitCameraMutationLease {
    pub(crate) fn finish(mut self) {
        self.release();
    }

    fn release(&mut self) {
        let Some(lease_id) = self.lease_id.take() else {
            return;
        };
        let mut admission = self
            .state
            .capture_recovery_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let released = admission
            .active_explicit_camera_mutation_leases
            .remove(&lease_id);
        if released {
            admission.advance_camera_mutation_epoch_and_revoke_admission();
        }
        drop(admission);
        if released {
            self.state
                .schedule_capture_recovery_explicit_mutation_reconciliation();
        }
    }
}

impl Drop for CaptureRecoveryExplicitCameraMutationLease {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) struct CaptureRecoveryAdmissionGuard<'a> {
    state: std::sync::MutexGuard<'a, CaptureRecoveryAdmissionState>,
}

impl CaptureRecoveryAdmissionGuard<'_> {
    pub(crate) fn camera_mutation_epoch(&self) -> u64 {
        self.state.camera_mutation_epoch
    }

    pub(crate) fn camera_mutation_epoch_is_current(&self, epoch: u64) -> bool {
        self.state.camera_mutation_epoch == epoch
    }

    pub(crate) fn explicit_camera_mutation_is_active(&self) -> bool {
        !self.state.active_explicit_camera_mutation_leases.is_empty()
    }

    pub(crate) fn admission_epoch_is_current(&self, epoch: u64) -> bool {
        epoch > 0 && self.state.admission_epoch == epoch
    }

    pub(crate) fn set_admission_epoch(&mut self, epoch: u64) {
        assert!(
            epoch > 0,
            "capture recovery admission epoch must be positive"
        );
        self.state.admission_epoch = epoch;
    }

    pub(crate) fn revoke_admission(&mut self) {
        self.state.admission_epoch = 0;
    }
}

pub(crate) type WindowsD3d11MediaCoordinatorSlot = Arc<StdMutex<WindowsD3d11MediaCoordinator>>;

/// Process-local owner for the one Windows D3D11 media authority.
///
/// The state machine is compiled and tested on every platform. The COM/D3D
/// thread and its client exist only on Windows, never cross this mutex, and
/// are drained before a retired generation can be reused.
#[derive(Debug)]
pub(crate) struct WindowsD3d11MediaCoordinator {
    state: WindowsD3d11MediaCoordinatorState,
    active_adapter_luid: Option<DxgiAdapterLuid>,
    #[cfg(target_os = "windows")]
    media_thread: Option<WindowsD3d11MediaThread>,
    #[cfg(target_os = "windows")]
    client: Option<WindowsD3d11MediaClient>,
}

impl WindowsD3d11MediaCoordinator {
    fn new() -> Self {
        Self {
            state: WindowsD3d11MediaCoordinatorState::new(1)
                .expect("the initial Windows D3D11 generation is valid"),
            active_adapter_luid: None,
            #[cfg(target_os = "windows")]
            media_thread: None,
            #[cfg(target_os = "windows")]
            client: None,
        }
    }

    fn finish_release_action(
        &mut self,
        action: WindowsD3d11CoordinatorReleaseAction,
    ) -> Result<(), WindowsD3d11Error> {
        match action {
            WindowsD3d11CoordinatorReleaseAction::KeepMediaThread => Ok(()),
            WindowsD3d11CoordinatorReleaseAction::DrainAndJoin {
                retired_generation, ..
            } => {
                #[cfg(target_os = "windows")]
                let shutdown_result = {
                    self.client.take();
                    if let Some(media_thread) = self.media_thread.take() {
                        media_thread.shutdown()
                    } else {
                        Ok(())
                    }
                };
                self.active_adapter_luid = None;
                let finish_result = self.state.finish_shutdown(retired_generation);
                #[cfg(target_os = "windows")]
                {
                    shutdown_result.and(finish_result)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    finish_result
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn release_role(&mut self, lease: WindowsD3d11RoleLease) -> Result<(), WindowsD3d11Error> {
        let action = self.state.release(lease)?;
        self.finish_release_action(action)
    }

    pub(crate) fn shutdown(&mut self) -> Result<(), WindowsD3d11Error> {
        let Some(action) = self.state.retire_for_shutdown()? else {
            return Ok(());
        };
        self.finish_release_action(action)
    }

    #[cfg(target_os = "windows")]
    fn retire_device_loss_once(&mut self, generation: u64) -> Result<bool, WindowsD3d11Error> {
        let Some(action) = self.state.retire_for_device_loss_once(generation)? else {
            return Ok(false);
        };
        self.finish_release_action(action)?;
        Ok(true)
    }
}

impl Drop for WindowsD3d11MediaCoordinator {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
pub(crate) struct WindowsD3d11MediaRoleHandle {
    lease: Option<WindowsD3d11RoleLease>,
    client: WindowsD3d11MediaClient,
    coordinator: std::sync::Weak<StdMutex<WindowsD3d11MediaCoordinator>>,
}

#[cfg(target_os = "windows")]
impl WindowsD3d11MediaRoleHandle {
    pub(crate) fn client(&self) -> WindowsD3d11MediaClient {
        self.client.clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.lease.as_ref().map_or(0, |lease| lease.generation)
    }

    pub(crate) fn role(&self) -> WindowsD3d11MediaRole {
        self.lease
            .as_ref()
            .map_or(WindowsD3d11MediaRole::Preview, |lease| lease.role)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsD3d11MediaRoleHandle {
    fn drop(&mut self) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let Some(coordinator) = self.coordinator.upgrade() else {
            return;
        };
        let mut coordinator = coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = coordinator.release_role(lease);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn acquire_windows_d3d11_media(
    coordinator: &WindowsD3d11MediaCoordinatorSlot,
    screen_id: &str,
    role: WindowsD3d11MediaRole,
    pool_config: WindowsD3d11TexturePoolConfig,
) -> Result<WindowsD3d11MediaRoleHandle, WindowsD3d11Error> {
    let selection = WindowsDxgiOutputSelection::parse(screen_id)?;
    let mut owner = coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (lease, action) = owner.state.acquire(selection.adapter_luid, role)?;
    match action {
        crate::windows_d3d11_device::WindowsD3d11CoordinatorAcquireAction::StartMediaThread => {
            match WindowsD3d11MediaThread::spawn(selection, lease.generation, pool_config) {
                Ok(media_thread) => {
                    owner.client = Some(media_thread.client());
                    owner.media_thread = Some(media_thread);
                    owner.active_adapter_luid = Some(selection.adapter_luid);
                }
                Err(error) => {
                    let rollback = owner.state.release(lease)?;
                    owner.finish_release_action(rollback)?;
                    return Err(error);
                }
            }
        }
        crate::windows_d3d11_device::WindowsD3d11CoordinatorAcquireAction::ReuseMediaThread => {
            if owner.active_adapter_luid != Some(selection.adapter_luid)
                || owner.client.is_none()
                || owner.media_thread.is_none()
            {
                let rollback = owner.state.release(lease)?;
                owner.finish_release_action(rollback)?;
                return Err(WindowsD3d11Error::new(
                    crate::windows_d3d11_device::WindowsD3d11ErrorCode::AdapterMismatch,
                    "D3D11 coordinator state has no matching live media thread",
                ));
            }
        }
    }
    let client = owner.client.clone().ok_or_else(|| {
        WindowsD3d11Error::new(
            crate::windows_d3d11_device::WindowsD3d11ErrorCode::CommandChannelClosed,
            "D3D11 coordinator did not publish its media client",
        )
    })?;
    drop(owner);
    Ok(WindowsD3d11MediaRoleHandle {
        lease: Some(lease),
        client,
        coordinator: Arc::downgrade(coordinator),
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn retire_windows_d3d11_media_for_device_loss(
    coordinator: &WindowsD3d11MediaCoordinatorSlot,
    generation: u64,
) -> Result<bool, WindowsD3d11Error> {
    coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retire_device_loss_once(generation)
}

#[derive(Clone)]
pub struct PreviewFrame {
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub published_at: Instant,
}

#[derive(Debug, Default)]
pub struct PreviewMetricsState {
    pub next_sequence: u64,
    pub last_presented_at: Option<Instant>,
    pub last_presented_sequence: Option<u64>,
    pub present_fps: Option<f64>,
    pub repeated_frames: u64,
    pub surface_resize_count: u64,
}

#[derive(Debug, Default)]
pub struct LayoutIntentState {
    pub latest_intent_id: u64,
    pub latest_needs_camera: bool,
    pub latest_needs_screen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebSocketQueueTicket {
    enqueued_at: Instant,
    sequence: u64,
}

#[derive(Debug, Default)]
struct WebSocketQueueTotals {
    current_depth: AtomicU64,
    max_depth: AtomicU64,
    coalesced_count: AtomicU64,
    evicted_or_dropped_count: AtomicU64,
}

#[derive(Debug)]
struct WebSocketQueueMetricsInner {
    pending: StdMutex<BTreeMap<(Instant, u64), ()>>,
    next_sequence: AtomicU64,
    totals: Arc<WebSocketQueueTotals>,
    changed: Notify,
}

impl Drop for WebSocketQueueMetricsInner {
    fn drop(&mut self) {
        let remaining = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len() as u64;
        if remaining == 0 {
            return;
        }
        let _ = self.totals.current_depth.fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |current| Some(current.saturating_sub(remaining)),
        );
        self.totals
            .evicted_or_dropped_count
            .fetch_add(remaining, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone)]
pub struct TrackedWebSocketQueueMetrics(Arc<WebSocketQueueMetricsInner>);

impl TrackedWebSocketQueueMetrics {
    fn new(totals: Arc<WebSocketQueueTotals>) -> Self {
        Self(Arc::new(WebSocketQueueMetricsInner {
            pending: StdMutex::new(BTreeMap::new()),
            next_sequence: AtomicU64::new(0),
            totals,
            changed: Notify::new(),
        }))
    }

    pub fn record_enqueue(&self) -> WebSocketQueueTicket {
        self.record_enqueue_at(Instant::now())
    }

    fn record_enqueue_at(&self, enqueued_at: Instant) -> WebSocketQueueTicket {
        let sequence = self.0.next_sequence.fetch_add(1, Ordering::AcqRel);
        let ticket = WebSocketQueueTicket {
            enqueued_at,
            sequence,
        };
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((ticket.enqueued_at, ticket.sequence), ());
        let current = self.0.totals.current_depth.fetch_add(1, Ordering::AcqRel) + 1;
        self.0.totals.max_depth.fetch_max(current, Ordering::AcqRel);
        self.0.changed.notify_one();
        ticket
    }

    pub fn record_dequeue_oldest(&self) {
        let removed = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_first()
            .is_some();
        if removed {
            self.0.totals.current_depth.fetch_sub(1, Ordering::AcqRel);
            self.0.changed.notify_one();
        }
    }

    pub fn record_dequeue(&self, ticket: WebSocketQueueTicket) {
        self.finish(ticket, false);
    }

    pub fn record_evicted_or_dropped(&self, ticket: WebSocketQueueTicket) {
        self.finish(ticket, true);
    }

    pub fn record_rejected_or_dropped(&self) {
        self.0
            .totals
            .evicted_or_dropped_count
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn record_coalesced_replacement(
        &self,
        replaced: WebSocketQueueTicket,
    ) -> WebSocketQueueTicket {
        let replacement = WebSocketQueueTicket {
            enqueued_at: Instant::now(),
            sequence: self.0.next_sequence.fetch_add(1, Ordering::AcqRel),
        };
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending
            .remove(&(replaced.enqueued_at, replaced.sequence))
            .is_some()
        {
            pending.insert((replacement.enqueued_at, replacement.sequence), ());
            self.0.totals.coalesced_count.fetch_add(1, Ordering::AcqRel);
            drop(pending);
            self.0.changed.notify_one();
            replacement
        } else {
            drop(pending);
            self.record_enqueue()
        }
    }

    fn finish(&self, ticket: WebSocketQueueTicket, dropped: bool) {
        let removed = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(ticket.enqueued_at, ticket.sequence))
            .is_some();
        if !removed {
            return;
        }
        self.0.totals.current_depth.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_one();
        if dropped {
            self.0
                .totals
                .evicted_or_dropped_count
                .fetch_add(1, Ordering::AcqRel);
        }
    }

    fn oldest_age_ms(&self, now: Instant) -> Option<u64> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first_key_value()
            .map(|((enqueued_at, _), _)| {
                now.saturating_duration_since(*enqueued_at).as_millis() as u64
            })
    }

    fn remaining_until_oldest_age_at(
        &self,
        now: Instant,
        oldest_age_limit: Duration,
    ) -> Option<Duration> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first_key_value()
            .map(|((enqueued_at, _), _)| {
                oldest_age_limit.saturating_sub(now.saturating_duration_since(*enqueued_at))
            })
    }

    pub fn remaining_until_oldest_age(&self, oldest_age_limit: Duration) -> Option<Duration> {
        self.remaining_until_oldest_age_at(Instant::now(), oldest_age_limit)
    }

    pub async fn wait_until_oldest_age_reaches(&self, oldest_age_limit: Duration) {
        loop {
            // `notify_one` stores a permit when this future has not been polled yet,
            // so a queue change between this line and the age read cannot be lost.
            let changed = self.0.changed.notified();
            match self.remaining_until_oldest_age(oldest_age_limit) {
                Some(remaining) if remaining.is_zero() => return,
                Some(remaining) => {
                    tokio::select! {
                        _ = tokio::time::sleep(remaining) => {}
                        _ = changed => {}
                    }
                }
                None => changed.await,
            }
        }
    }
}

#[derive(Debug, Default)]
struct WebSocketQueueRegistry {
    totals: Arc<WebSocketQueueTotals>,
    connections: StdMutex<Vec<Weak<WebSocketQueueMetricsInner>>>,
}

impl WebSocketQueueRegistry {
    fn register(&self) -> TrackedWebSocketQueueMetrics {
        let metrics = TrackedWebSocketQueueMetrics::new(self.totals.clone());
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connections.retain(|connection| connection.strong_count() > 0);
        connections.push(Arc::downgrade(&metrics.0));
        metrics
    }

    fn snapshot(&self, now: Instant) -> WebSocketQueueDiagnosticStats {
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut oldest_age_ms = None;
        connections.retain(|connection| {
            let Some(connection) = connection.upgrade() else {
                return false;
            };
            let metrics = TrackedWebSocketQueueMetrics(connection);
            if let Some(age_ms) = metrics.oldest_age_ms(now) {
                oldest_age_ms =
                    Some(oldest_age_ms.map_or(age_ms, |oldest: u64| oldest.max(age_ms)));
            }
            true
        });
        WebSocketQueueDiagnosticStats {
            current_depth: self.totals.current_depth.load(Ordering::Acquire),
            max_depth: self.totals.max_depth.load(Ordering::Acquire),
            oldest_age_ms,
            coalesced_count: self.totals.coalesced_count.load(Ordering::Acquire),
            evicted_or_dropped_count: self.totals.evicted_or_dropped_count.load(Ordering::Acquire),
        }
    }
}

#[derive(Debug, Default)]
struct WebSocketCommandLaneRegistry {
    queue: WebSocketQueueRegistry,
    expired_before_dispatch_count: AtomicU64,
    rejected_before_dispatch_count: AtomicU64,
}

impl WebSocketCommandLaneRegistry {
    fn snapshot(&self, now: Instant) -> WebSocketCommandLaneDiagnosticStats {
        WebSocketCommandLaneDiagnosticStats {
            queue: self.queue.snapshot(now),
            expired_before_dispatch_count: self
                .expired_before_dispatch_count
                .load(Ordering::Acquire),
            rejected_before_dispatch_count: self
                .rejected_before_dispatch_count
                .load(Ordering::Acquire),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrackedWebSocketCommandLaneMetrics {
    queue: TrackedWebSocketQueueMetrics,
    registry: Arc<WebSocketCommandLaneRegistry>,
}

impl TrackedWebSocketCommandLaneMetrics {
    pub fn record_enqueue(&self) -> WebSocketQueueTicket {
        self.queue.record_enqueue()
    }

    pub fn record_dispatch(&self, ticket: WebSocketQueueTicket) {
        self.queue.record_dequeue(ticket);
    }

    pub fn record_expired_before_dispatch(&self) {
        self.registry
            .expired_before_dispatch_count
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn record_rejected_before_dispatch(&self) {
        self.registry
            .rejected_before_dispatch_count
            .fetch_add(1, Ordering::AcqRel);
    }
}

#[derive(Debug)]
pub struct WebSocketConnectionTransportMetrics {
    pub reliable_response_queue: TrackedWebSocketQueueMetrics,
    pub incoming_command_queue: TrackedWebSocketQueueMetrics,
    pub coalesced_telemetry_queue: TrackedWebSocketQueueMetrics,
}

#[derive(Debug, Default)]
pub struct WebSocketTransportMetrics {
    reliable_response_queue: WebSocketQueueRegistry,
    incoming_command_queue: WebSocketQueueRegistry,
    coalesced_telemetry_queue: WebSocketQueueRegistry,
    command_lanes: StdMutex<BTreeMap<String, Arc<WebSocketCommandLaneRegistry>>>,
    slow_pressure_disconnect_count: AtomicU64,
}

impl WebSocketTransportMetrics {
    pub fn register_connection(&self) -> WebSocketConnectionTransportMetrics {
        WebSocketConnectionTransportMetrics {
            reliable_response_queue: self.reliable_response_queue.register(),
            incoming_command_queue: self.incoming_command_queue.register(),
            coalesced_telemetry_queue: self.coalesced_telemetry_queue.register(),
        }
    }

    pub fn record_slow_pressure_disconnect(&self) {
        self.slow_pressure_disconnect_count
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn register_command_lane(&self, name: &str) -> TrackedWebSocketCommandLaneMetrics {
        let registry = {
            let mut command_lanes = self
                .command_lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            command_lanes
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(WebSocketCommandLaneRegistry::default()))
                .clone()
        };
        TrackedWebSocketCommandLaneMetrics {
            queue: registry.queue.register(),
            registry,
        }
    }

    pub fn snapshot(&self) -> WebSocketTransportDiagnosticStats {
        self.snapshot_at(Instant::now())
    }

    fn snapshot_at(&self, now: Instant) -> WebSocketTransportDiagnosticStats {
        let command_lanes = self
            .command_lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(name, lane)| (name.clone(), lane.snapshot(now)))
            .collect();
        WebSocketTransportDiagnosticStats {
            reliable_response_queue: self.reliable_response_queue.snapshot(now),
            incoming_command_queue: self.incoming_command_queue.snapshot(now),
            coalesced_telemetry_queue: self.coalesced_telemetry_queue.snapshot(now),
            command_lanes,
            slow_pressure_disconnect_count: self
                .slow_pressure_disconnect_count
                .load(Ordering::Acquire),
        }
    }
}

/// Debug-only synchronization seam for the maintained command-lane smoke.
///
/// The smoke holds one AccountMaintenance command inside the real WebSocket
/// dispatcher, observes this generation through a separate status request,
/// then proves the operator lanes still reply. The RPCs which reach this
/// object remain protected by the normal admin + explicit smoke admission
/// policy; release builds do not carry the state at all.
#[cfg(debug_assertions)]
#[derive(Debug, Default)]
pub struct CommandLaneSmokeBlocker {
    next_generation: AtomicU64,
    active_generation: AtomicU64,
    released: Notify,
}

#[cfg(debug_assertions)]
impl CommandLaneSmokeBlocker {
    pub async fn block(&self) -> Result<u64, u64> {
        let generation = self
            .next_generation
            .load(Ordering::Acquire)
            .saturating_add(1);
        self.active_generation.compare_exchange(
            0,
            generation,
            Ordering::AcqRel,
            Ordering::Acquire,
        )?;
        self.next_generation.store(generation, Ordering::Release);

        loop {
            // Register the waiter before checking the state so a release which
            // races this edge cannot be lost between the load and await.
            let released = self.released.notified();
            if self.active_generation.load(Ordering::Acquire) != generation {
                return Ok(generation);
            }
            released.await;
        }
    }

    pub fn release(&self) -> Option<u64> {
        let generation = self.active_generation.swap(0, Ordering::AcqRel);
        if generation == 0 {
            return None;
        }
        self.released.notify_waiters();
        Some(generation)
    }

    pub fn status(&self) -> (bool, u64, Option<u64>) {
        let generation = self.next_generation.load(Ordering::Acquire);
        let active_generation = self.active_generation.load(Ordering::Acquire);
        (
            active_generation != 0,
            generation,
            (active_generation != 0).then_some(active_generation),
        )
    }
}

/// Process-global receipt/completion fence shared by every WebSocket
/// dispatcher. A disconnected socket deliberately drains accepted work, so a
/// per-connection fence cannot make a new socket's reconciliation or Stop
/// authoritative.
#[derive(Default)]
pub struct CommandCompletionFence {
    state: StdMutex<CommandCompletionFenceState>,
    changed: Notify,
}

#[derive(Default)]
struct CommandCompletionFenceState {
    next_sequence: u64,
    pending: std::collections::BTreeSet<u64>,
}

impl CommandCompletionFence {
    pub fn begin(self: &Arc<Self>) -> CommandCompletionGuard {
        // Allocation and insertion are one lock edge. Observation can never
        // snapshot a generation whose pending guard is not visible yet.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sequence = state
            .next_sequence
            .checked_add(1)
            .expect("command completion fence sequence exhausted");
        state.next_sequence = sequence;
        state.pending.insert(sequence);
        drop(state);
        CommandCompletionGuard {
            fence: self.clone(),
            sequence,
        }
    }

    pub fn observe(self: &Arc<Self>) -> CommandCompletionSnapshot {
        let through_sequence = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .next_sequence;
        CommandCompletionSnapshot {
            fence: self.clone(),
            through_sequence,
        }
    }

    #[cfg(test)]
    pub fn accepted_sequence(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .next_sequence
    }

    async fn wait_through(&self, through_sequence: u64) {
        loop {
            // Enable registration before inspecting pending so
            // `notify_waiters` cannot land between the check and await.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            let _ = changed.as_mut().enable();
            let prior_pending = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pending
                .range(..=through_sequence)
                .next()
                .is_some();
            if !prior_pending {
                return;
            }
            changed.await;
        }
    }
}

pub struct CommandCompletionGuard {
    fence: Arc<CommandCompletionFence>,
    sequence: u64,
}

impl CommandCompletionGuard {
    /// Global FIFO admission for commands that lack intent IDs. Layout
    /// mutations intentionally do not call this: their established path is
    /// concurrent/latest-wins.
    pub async fn wait_for_turn(&self) {
        loop {
            let changed = self.fence.changed.notified();
            tokio::pin!(changed);
            let _ = changed.as_mut().enable();
            let prior_pending = self
                .fence
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pending
                .range(..self.sequence)
                .next()
                .is_some();
            if !prior_pending {
                return;
            }
            changed.await;
        }
    }
}

impl Drop for CommandCompletionGuard {
    fn drop(&mut self) {
        self.fence
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .remove(&self.sequence);
        self.fence.changed.notify_waiters();
    }
}

pub struct CommandCompletionSnapshot {
    fence: Arc<CommandCompletionFence>,
    through_sequence: u64,
}

impl CommandCompletionSnapshot {
    pub async fn wait(&self) {
        self.fence.wait_through(self.through_sequence).await;
    }
}

#[derive(Clone)]
pub struct AppState {
    /// Handle for the process-lifetime Tokio runtime captured before any
    /// compositor-owned current-thread runtime is entered. Detached capture
    /// and preview supervisors must use this authority so retiring a
    /// compositor run cannot cancel native teardown or recovery ownership.
    process_runtime: Option<tokio::runtime::Handle>,
    /// Process-wide intake fence set before graceful capture cleanup begins.
    /// Capture/preview admissions read this atomically and fail closed so an
    /// HTTP/WebSocket request cannot create new native ownership during drain.
    process_shutdown_requested: Arc<AtomicBool>,
    /// Wakes the graceful server shutdown task for an authenticated main-
    /// process preparation request. This avoids `SIGTERM`, which Electron
    /// implements as an immediate TerminateProcess on Windows.
    process_shutdown_requested_notify: Arc<Notify>,
    /// Shared terminal result produced only by the process-owned graceful
    /// shutdown future. HTTP request cancellation can therefore never cancel
    /// the recording finalizer that authorizes Electron's shutdown receipt.
    process_shutdown_preparation: Arc<watch::Sender<Option<Result<(), String>>>>,
    /// Linearizes session-start source snapshots with automatic recovery and
    /// idle geometry resync admission. A recovery owns this only until its
    /// persistent source-transition guard is registered; native completion is
    /// deliberately outside this mutex.
    pub(crate) session_start_source_transition_fence: Arc<tokio::sync::Mutex<()>>,
    /// Linearizes only observable recording publication with process cleanup.
    /// Recovery/native source waits never own this fence, so shutdown cannot
    /// be stranded behind AVCaptureSession::stopRunning.
    pub(crate) session_start_publication_fence: Arc<tokio::sync::Mutex<()>>,
    /// Least-privilege renderer transport credential.
    pub token: String,
    /// Electron-main/admin transport credential. Never serialize this through
    /// `BackendConnection` or renderer-facing events.
    pub admin_token: String,
    /// Test RPCs require both a debug build and this explicit runtime switch.
    pub smoke_rpc_enabled: bool,
    pub port: u16,
    /// Fixed-port loopback listener for OAuth callbacks. Providers like X match
    /// redirect URIs EXACTLY (port included), so callbacks cannot ride the
    /// randomly-bound main port; None means the candidate ports were all busy
    /// and redirects fall back to the main port.
    pub oauth_callback_port: Option<u16>,
    pub events: broadcast::Sender<ServerEvent>,
    pub recording: RecordingSlot,
    /// Serializes user Stop/Force-stop with the shutdown-only idempotent stop
    /// join so process shutdown can never reinterpret an in-flight graceful
    /// stop as a second force request.
    pub(crate) recording_stop_fence: Arc<tokio::sync::Mutex<()>>,
    /// Atomic admission edge shared by session startup and privileged process
    /// interruptions. Main-process status events are UX hints, not authority.
    pub capture_interruption: Arc<CaptureInterruptionCoordinator>,
    pub live_preview: LivePreviewSlot,
    pub preview_frames: broadcast::Sender<Vec<u8>>,
    pub preview_latest_frame: Arc<tokio::sync::RwLock<Option<PreviewFrame>>>,
    pub preview_metrics: Arc<tokio::sync::Mutex<PreviewMetricsState>>,
    pub preview_camera: PreviewCameraSlot,
    pub preview_screen: PreviewScreenSlot,
    pub preview_surface: PreviewSurfaceSlot,
    /// Serializes preview-surface create/update/destroy transactions. The
    /// compositor lifecycle lock only protects worker ownership; it does not
    /// make the surface status, native-host commands, and owned run id one
    /// atomic transition.
    pub preview_surface_lifecycle: Arc<tokio::sync::Mutex<()>>,
    /// One generation-scoped D3D11 device/media-thread authority shared by
    /// preview, recording, and streaming roles. This slot contains no
    /// renderer-serializable resource handle.
    pub(crate) windows_d3d11_media: WindowsD3d11MediaCoordinatorSlot,
    pub compositor: CompositorSlot,
    /// Serializes compositor worker stop/start handoffs so concurrent preview and
    /// recording ownership changes cannot orphan a `spawn_blocking` render worker.
    pub compositor_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub scene: Arc<tokio::sync::Mutex<Scene>>,
    /// Serializes scene storage, revision allocation, compositor publication,
    /// and the scene-changed event as one commit edge.
    pub scene_commit: Arc<tokio::sync::Mutex<()>>,
    /// Serializes takeover output publication with the persisted active-screen
    /// pointer so authoritative `screens.active` reads cannot observe a
    /// different takeover than the recording/compositor output.
    pub active_screen_transition: Arc<tokio::sync::Mutex<()>>,
    /// Serializes the commit edge of layout transactions while allowing source
    /// warm-up to run concurrently. A newer registered intent supersedes older
    /// waiters before they can replace the last good scene.
    pub layout_intents: Arc<tokio::sync::Mutex<LayoutIntentState>>,
    /// Lock-free mirror of `layout_intents.latest_intent_id`. Registration
    /// publishes this while holding the intent mutex, so detached camera and
    /// screen workers can reject stale admission without introducing a
    /// layout-intent/preview-runtime lock-order cycle.
    latest_layout_intent_id: Arc<AtomicU64>,
    /// Synchronous linearization gate shared by layout registration and the
    /// final, non-awaiting mutation edge of camera/screen admission.
    layout_source_admission: Arc<StdMutex<()>>,
    pub source_registry: Arc<tokio::sync::Mutex<SourceRegistry>>,
    pub diagnostics: Arc<tokio::sync::Mutex<DiagnosticStats>>,
    /// Shared camera/render health authority latches. Every diagnostics writer
    /// derives the published stage from this camera-first aggregate so the
    /// independent render supervisor cannot transiently erase camera decay.
    pub(crate) capture_health_stage_latches: CaptureHealthStageLatchesSlot,
    /// Single mutation authority for capture auto-heal and operator retry.
    /// Source restart work is generation-scoped inside the coordinator so a
    /// stale completion cannot overwrite a newer capture configuration.
    pub capture_recovery: CaptureRecoverySlot,
    /// One synchronous gate linearizes an explicit camera mutation's
    /// `{mutation epoch + 1, admission = 0}` with a health handler's
    /// `{sampled mutation epoch matches, admission = ticket}`. Preview camera
    /// checks the same gate while holding native mutation authority.
    capture_recovery_admission: Arc<StdMutex<CaptureRecoveryAdmissionState>>,
    /// Exact compositor-consumer delivery evidence for recovery verification.
    /// This is a synchronous slot because the render loop updates it on every
    /// tick; identity changes reset the generation-bound baseline.
    pub capture_recovery_compositor_evidence: CaptureRecoveryCompositorEvidenceSlot,
    /// Serializes the ancillary diagnostics mirror and remembers the newest
    /// recovery revision mirrored there. Renderer events are committed
    /// synchronously under the coordinator lock and never await this lane.
    pub capture_recovery_published_revision: Arc<tokio::sync::Mutex<u64>>,
    /// Debug+smoke-only generation-bound producer-stall injection. Production
    /// builds contain neither this state nor the arming RPC.
    #[cfg(debug_assertions)]
    pub capture_recovery_smoke_fault: CaptureRecoverySmokeFaultSlot,
    pub websocket_transport_metrics: Arc<WebSocketTransportMetrics>,
    /// Defines one process-wide intake order while global fence/order metadata
    /// is attached to a command before it enters a per-socket queue.
    pub websocket_command_admission: Arc<StdMutex<()>>,
    /// Completion truth for layout/live-control mutations across reconnects.
    pub operator_command_fence: Arc<CommandCompletionFence>,
    /// Physical camera/screen transition completion, independent from the
    /// bounded command response that admitted the transition. Session startup
    /// snapshots this fence after command ordering so it cannot publish while
    /// an older native source supervisor is still changing device ownership.
    pub source_transition_fence: Arc<CommandCompletionFence>,
    /// FIFO receipt order for non-idempotent live controls across reconnects.
    pub live_control_command_order: Arc<CommandCompletionFence>,
    /// Start completion truth used by Stop across reconnects/admin sockets.
    pub session_start_command_fence: Arc<CommandCompletionFence>,
    #[cfg(debug_assertions)]
    pub command_lane_smoke_blocker: Arc<CommandLaneSmokeBlocker>,
    pub last_audio_meter: Arc<tokio::sync::Mutex<Option<AudioMeterSampleSnapshot>>>,
    pub logs: Arc<StdMutex<Vec<BackendLogEvent>>>,
    pub database: Database,
    /// Remote-control surface (Stream Deck et al): enabled flag, rotatable
    /// token, renderer-published describe/state snapshots, intent debounce.
    pub remote_control: crate::remote_control::RemoteControlSlot,
    /// Bumped on remote token regenerate/disable: live remote sockets watch
    /// it and close, so a rotated token cuts existing clients immediately.
    pub remote_generation: tokio::sync::watch::Sender<u64>,
    pub resource_authority: ResourceAuthority,
    pub oauth: Arc<OAuthSessions>,
    /// Pending 3-legged OAuth 1.0a authorizations for X Live (keyed by
    /// request token — OAuth 1.0a callbacks carry no `state` param).
    pub x_oauth1: Arc<crate::x_oauth1::XOauth1Sessions>,
    pub ffmpeg_work: Arc<FfmpegWorkCoordinator>,
    pub noise_cleanup: Arc<crate::noise_cleanup::NoiseCleanupRegistry>,
    pub live_chat: LiveChatSlot,
    pub live_chat_persistence: LiveChatPersistence,
    /// In-memory product-account session override (deep-link sign-in / Sign out).
    /// None falls back to the dev env mock; persistent token storage replaces it.
    pub account_session: Arc<tokio::sync::Mutex<Option<VideorcAccountSnapshot>>>,
    /// Serializes product-account intent generation, remote code exchange,
    /// refresh, and sign-out so a stale completion cannot publish after a newer
    /// sign-in intent or explicit sign-out.
    pub account_auth_transition: Arc<tokio::sync::Mutex<()>>,
    /// Latest accepted product-account refresh. This is separate from sign-in
    /// intent generation so overlapping refreshes for the same account remain
    /// latest-request-wins across WebSocket reconnects.
    pub account_refresh_generation: Arc<AtomicU64>,
    /// Latest accepted entitlement refresh. This is separate from sign-in
    /// intent generation so overlapping refreshes for the same account are
    /// still latest-request-wins.
    pub account_entitlement_refresh_generation: Arc<AtomicU64>,
    pub captions: crate::captions::CaptionsSlot,
    /// Per-output burn-in caption bars (std mutex: read from the synchronous
    /// compositor render thread). Primary and auxiliary may use different
    /// raster dimensions for split 4K-record/1080p-stream sessions.
    pub caption_overlay: crate::captions::CaptionOverlaySlots,
    /// Comment-highlight overlay (Comments upgrade S2): independent from the
    /// captions bar — highlight top, captions bottom, coexisting.
    pub highlight_overlay: crate::captions::CaptionOverlaySlot,
    /// Backend-owned acknowledgement/lifetime for the viewer-facing comment
    /// card. The image slot above and this state are mutated under this
    /// state-machine lock so stale expiry tasks cannot clear newer cards.
    pub comment_highlight: crate::comment_highlight::CommentHighlightSlot,
    /// Linearizes the bounded comment-card commit edge with authoritative
    /// message tombstones and compositor Live -> non-Live invalidation. Image
    /// decode and chat persistence must stay outside this fence.
    pub(crate) comment_highlight_commit: Arc<tokio::sync::Mutex<()>>,
    /// Live Co-host engine: per-session open questions, flags, mood, and the
    /// tick scheduler. Settings are loaded from `app_settings` at startup.
    pub cohost: crate::cohost::CohostSlot,
}

impl AppState {
    pub fn new(
        token: String,
        port: u16,
        events: broadcast::Sender<ServerEvent>,
        database: Database,
    ) -> Self {
        let oauth_store_path = (database.path().to_string_lossy() != ":memory:")
            .then(|| database.path().with_extension("oauth-pending.json"));
        let cohost_settings = crate::cohost::load_cohost_settings(&database);
        Self {
            process_runtime: tokio::runtime::Handle::try_current().ok(),
            process_shutdown_requested: Arc::new(AtomicBool::new(false)),
            process_shutdown_requested_notify: Arc::new(Notify::new()),
            process_shutdown_preparation: Arc::new(watch::channel(None).0),
            session_start_source_transition_fence: Arc::new(tokio::sync::Mutex::new(())),
            session_start_publication_fence: Arc::new(tokio::sync::Mutex::new(())),
            token,
            admin_token: uuid::Uuid::new_v4().to_string(),
            smoke_rpc_enabled: cfg!(debug_assertions)
                && std::env::var("VIDEORC_ENABLE_SMOKE_RPC").as_deref() == Ok("1"),
            port,
            oauth_callback_port: None,
            events,
            recording: Arc::new(tokio::sync::Mutex::new(None)),
            recording_stop_fence: Arc::new(tokio::sync::Mutex::new(())),
            capture_interruption: Arc::new(CaptureInterruptionCoordinator::default()),
            live_preview: Arc::new(tokio::sync::Mutex::new(initial_live_preview_state())),
            preview_frames: broadcast::channel(PREVIEW_FRAME_CHANNEL_CAPACITY).0,
            preview_latest_frame: Arc::new(tokio::sync::RwLock::new(None)),
            preview_metrics: Arc::new(tokio::sync::Mutex::new(PreviewMetricsState::default())),
            preview_camera: Arc::new(tokio::sync::Mutex::new(initial_preview_camera_state())),
            preview_screen: Arc::new(tokio::sync::Mutex::new(initial_preview_screen_state())),
            preview_surface: Arc::new(tokio::sync::Mutex::new(initial_preview_surface_state())),
            preview_surface_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            windows_d3d11_media: Arc::new(StdMutex::new(WindowsD3d11MediaCoordinator::new())),
            compositor: Arc::new(tokio::sync::Mutex::new(initial_compositor_state())),
            compositor_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            scene: Arc::new(tokio::sync::Mutex::new(default_scene())),
            scene_commit: Arc::new(tokio::sync::Mutex::new(())),
            active_screen_transition: Arc::new(tokio::sync::Mutex::new(())),
            layout_intents: Arc::new(tokio::sync::Mutex::new(LayoutIntentState::default())),
            latest_layout_intent_id: Arc::new(AtomicU64::new(0)),
            layout_source_admission: Arc::new(StdMutex::new(())),
            source_registry: Arc::new(tokio::sync::Mutex::new(SourceRegistry::new())),
            diagnostics: Arc::new(tokio::sync::Mutex::new(idle_diagnostics())),
            capture_health_stage_latches: new_capture_health_stage_latches_slot(),
            capture_recovery: new_capture_recovery_slot(),
            capture_recovery_admission: Arc::new(StdMutex::new(CaptureRecoveryAdmissionState {
                camera_mutation_epoch: INITIAL_CAPTURE_RECOVERY_CAMERA_MUTATION_EPOCH,
                admission_epoch: 0,
                next_explicit_camera_mutation_lease_id: 1,
                active_explicit_camera_mutation_leases: BTreeSet::new(),
            })),
            capture_recovery_compositor_evidence: new_capture_recovery_compositor_evidence_slot(),
            capture_recovery_published_revision: Arc::new(tokio::sync::Mutex::new(0)),
            #[cfg(debug_assertions)]
            capture_recovery_smoke_fault: new_capture_recovery_smoke_fault_slot(),
            websocket_transport_metrics: Arc::new(WebSocketTransportMetrics::default()),
            websocket_command_admission: Arc::new(StdMutex::new(())),
            operator_command_fence: Arc::new(CommandCompletionFence::default()),
            source_transition_fence: Arc::new(CommandCompletionFence::default()),
            live_control_command_order: Arc::new(CommandCompletionFence::default()),
            session_start_command_fence: Arc::new(CommandCompletionFence::default()),
            #[cfg(debug_assertions)]
            command_lane_smoke_blocker: Arc::new(CommandLaneSmokeBlocker::default()),
            last_audio_meter: Arc::new(tokio::sync::Mutex::new(None)),
            logs: Arc::new(StdMutex::new(Vec::new())),
            live_chat_persistence: LiveChatPersistence::new(database.clone()),
            database,
            remote_control: std::sync::Arc::new(StdMutex::new(
                crate::remote_control::RemoteControlRuntime::load_from_secrets(),
            )),
            remote_generation: tokio::sync::watch::channel(0).0,
            resource_authority: ResourceAuthority::default(),
            oauth: Arc::new(OAuthSessions::new_with_secret_store(
                oauth_store_path,
                crate::secrets::put_secret,
                crate::secrets::delete_secret,
            )),
            x_oauth1: Arc::new(crate::x_oauth1::XOauth1Sessions::default()),
            ffmpeg_work: Arc::new(FfmpegWorkCoordinator::new()),
            noise_cleanup: Arc::new(crate::noise_cleanup::NoiseCleanupRegistry::default()),
            live_chat: Arc::new(tokio::sync::Mutex::new(LiveChatCoordinator::default())),
            account_session: Arc::new(tokio::sync::Mutex::new(
                crate::account::restore_persisted_account(),
            )),
            account_auth_transition: Arc::new(tokio::sync::Mutex::new(())),
            account_refresh_generation: Arc::new(AtomicU64::new(0)),
            account_entitlement_refresh_generation: Arc::new(AtomicU64::new(0)),
            captions: crate::captions::new_captions_slot(),
            caption_overlay: crate::captions::new_caption_overlay_slots(),
            highlight_overlay: crate::captions::new_caption_overlay_slot(),
            comment_highlight: crate::comment_highlight::new_comment_highlight_slot(),
            comment_highlight_commit: Arc::new(tokio::sync::Mutex::new(())),
            cohost: crate::cohost::new_cohost_slot(cohost_settings),
        }
    }

    /// The port OAuth redirect URIs must use: the fixed callback listener when
    /// it bound, else the dynamic main port (still fine for providers that
    /// accept any loopback port, like Google).
    pub fn oauth_redirect_port(&self) -> u16 {
        self.oauth_callback_port.unwrap_or(self.port)
    }

    pub(crate) fn publish_latest_layout_intent_id(&self, intent_id: u64) {
        self.latest_layout_intent_id
            .store(intent_id, Ordering::Release);
    }

    pub(crate) fn latest_layout_intent_id(&self) -> u64 {
        self.latest_layout_intent_id.load(Ordering::Acquire)
    }

    pub(crate) fn lock_layout_source_admission(&self) -> std::sync::MutexGuard<'_, ()> {
        self.layout_source_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn emit_event<T: serde::Serialize>(&self, event: impl Into<String>, payload: T) {
        let mut event = ServerEvent::new(event, payload);
        crate::resource_authority::redact_managed_background_paths(&mut event.payload);
        if event.event == "diagnostics.stats"
            && let Some(payload) = event.payload.as_object_mut()
        {
            payload.insert(
                "websocketTransport".to_string(),
                serde_json::to_value(self.websocket_transport_metrics.snapshot())
                    .expect("serializable WebSocket transport diagnostics"),
            );
        }
        let _ = self.events.send(event);
    }

    /// Spawn process-owned work independently of the caller's Tokio runtime.
    ///
    /// Production constructs `AppState` inside the process runtime. Tests
    /// which exercise detached ownership must do the same; deliberately panic
    /// instead of falling back to a disposable caller runtime when the handle
    /// was not captured.
    pub(crate) fn spawn_process_task<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.process_runtime
            .as_ref()
            .expect("AppState process runtime was not captured")
            .spawn(future)
    }

    /// Drop paths cannot await, but cancellation/error must still reconcile a
    /// terminal recovery incident against the lease's final epoch. A missing
    /// process runtime is possible only in narrow construction tests; Drop
    /// remains non-panicking there and the next health edge still adopts the
    /// published epoch synchronously.
    fn schedule_capture_recovery_explicit_mutation_reconciliation(&self) {
        if self.process_shutdown_requested() {
            return;
        }
        let Some(process_runtime) = self.process_runtime.clone() else {
            return;
        };
        let state = self.clone();
        process_runtime.spawn(async move {
            crate::capture_recovery::note_explicit_camera_configuration_changed(&state).await;
        });
    }

    pub(crate) fn request_process_shutdown(&self) -> bool {
        let first_request = !self.process_shutdown_requested.swap(true, Ordering::AcqRel);
        if first_request {
            self.process_shutdown_requested_notify.notify_waiters();
        }
        first_request
    }

    pub(crate) fn process_shutdown_requested(&self) -> bool {
        self.process_shutdown_requested.load(Ordering::Acquire)
    }

    pub(crate) async fn wait_for_process_shutdown_request(&self) {
        loop {
            let notified = self.process_shutdown_requested_notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if self.process_shutdown_requested() {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn publish_process_shutdown_preparation(&self, result: Result<(), String>) {
        debug_assert!(
            self.process_shutdown_preparation.borrow().is_none(),
            "process shutdown preparation may be published only once"
        );
        self.process_shutdown_preparation.send_replace(Some(result));
    }

    pub(crate) async fn wait_for_process_shutdown_preparation(&self) -> Result<(), String> {
        let mut receiver = self.process_shutdown_preparation.subscribe();
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .expect("AppState owns the process shutdown preparation sender");
        }
    }

    #[cfg(test)]
    pub(crate) fn set_capture_recovery_admission_epoch(&self, epoch: u64) {
        self.lock_capture_recovery_admission_gate()
            .set_admission_epoch(epoch);
    }

    pub(crate) fn capture_recovery_camera_mutation_epoch(&self) -> u64 {
        self.capture_recovery_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .camera_mutation_epoch
    }

    /// Begin while holding the preview-camera mutation authority, then retain
    /// the returned lease across the entire explicit operator/configuration
    /// transaction. Begin and Drop/finish are both epoch boundaries.
    pub(crate) fn begin_capture_recovery_explicit_camera_mutation(
        &self,
    ) -> CaptureRecoveryExplicitCameraMutationLease {
        let mut admission = self
            .capture_recovery_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lease_id = admission.next_explicit_camera_mutation_lease_id;
        admission.next_explicit_camera_mutation_lease_id = admission
            .next_explicit_camera_mutation_lease_id
            .checked_add(1)
            .expect("capture recovery explicit mutation lease id exhausted");
        assert!(
            admission
                .active_explicit_camera_mutation_leases
                .insert(lease_id),
            "capture recovery explicit mutation lease id reused"
        );
        admission.advance_camera_mutation_epoch_and_revoke_admission();
        drop(admission);
        CaptureRecoveryExplicitCameraMutationLease {
            state: self.clone(),
            lease_id: Some(lease_id),
        }
    }

    pub(crate) fn lock_capture_recovery_admission_gate(&self) -> CaptureRecoveryAdmissionGuard<'_> {
        CaptureRecoveryAdmissionGuard {
            state: self
                .capture_recovery_admission
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        }
    }

    pub(crate) fn invalidate_capture_recovery_admission(&self) {
        self.capture_recovery_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .admission_epoch = 0;
    }

    pub(crate) fn capture_recovery_admission_is_current(&self, epoch: u64) -> bool {
        epoch > 0
            && self
                .capture_recovery_admission
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .admission_epoch
                == epoch
    }

    pub(crate) fn clear_capture_recovery_admission_if(&self, epoch: u64) {
        let mut admission = self
            .capture_recovery_admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if admission.admission_epoch == epoch {
            admission.admission_epoch = 0;
        }
    }

    pub fn emit_log(&self, level: impl Into<String>, message: impl Into<String>) {
        let payload = BackendLogEvent {
            level: level.into(),
            message: message.into(),
            timestamp: Utc::now().to_rfc3339(),
        };
        let level = payload.level.clone();
        let message = payload.message.clone();
        match level.as_str() {
            "error" => tracing::error!("{message}"),
            "warn" => tracing::warn!("{message}"),
            _ => tracing::info!("{message}"),
        }
        self.remember_log(payload.clone());
        self.emit_event("log", payload);
    }

    pub fn recent_logs(&self, limit: usize) -> Vec<BackendLogEvent> {
        self.logs
            .lock()
            .map(|logs| {
                let start = logs.len().saturating_sub(limit);
                logs[start..].to_vec()
            })
            .unwrap_or_default()
    }

    fn remember_log(&self, event: BackendLogEvent) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push(event);
            let overflow = logs.len().saturating_sub(LOG_HISTORY_LIMIT);
            if overflow > 0 {
                logs.drain(0..overflow);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn command_completion_fence_snapshots_pending_work_and_orders_turns() {
        let fence = Arc::new(CommandCompletionFence::default());
        let first = fence.begin();
        let second = fence.begin();
        let snapshot = fence.observe();
        assert_eq!(fence.accepted_sequence(), 2);

        let second_turn = tokio::spawn(async move {
            second.wait_for_turn().await;
            drop(second);
        });
        let snapshot_complete = tokio::spawn(async move { snapshot.wait().await });
        tokio::task::yield_now().await;
        assert!(!second_turn.is_finished());
        assert!(!snapshot_complete.is_finished());

        drop(first);
        second_turn.await.unwrap();
        snapshot_complete.await.unwrap();
    }

    #[test]
    fn websocket_queue_metrics_track_depth_oldest_age_and_lifetime_counters() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let reliable = &connection.reliable_response_queue;

        let oldest = reliable.record_enqueue_at(now - Duration::from_millis(120));
        let newest = reliable.record_enqueue_at(now - Duration::from_millis(25));
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 2);
        assert_eq!(snapshot.reliable_response_queue.max_depth, 2);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, Some(120));
        assert_eq!(snapshot.reliable_response_queue.evicted_or_dropped_count, 0);

        reliable.record_dequeue(oldest);
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 1);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, Some(25));

        reliable.record_evicted_or_dropped(newest);
        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.reliable_response_queue.current_depth, 0);
        assert_eq!(snapshot.reliable_response_queue.oldest_age_ms, None);
        assert_eq!(snapshot.reliable_response_queue.evicted_or_dropped_count, 1);
    }

    #[test]
    fn websocket_queue_metrics_expose_exact_remaining_oldest_age_budget() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let reliable = &connection.reliable_response_queue;

        assert_eq!(
            reliable.remaining_until_oldest_age_at(now, Duration::from_secs(5)),
            None
        );
        reliable.record_enqueue_at(now - Duration::from_secs(3));
        assert_eq!(
            reliable.remaining_until_oldest_age_at(now, Duration::from_secs(5)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            reliable.remaining_until_oldest_age_at(
                now + Duration::from_secs(3),
                Duration::from_secs(5),
            ),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn websocket_transport_metrics_keep_lanes_separate_and_count_coalescing_pressure() {
        let now = Instant::now();
        let transport = WebSocketTransportMetrics::default();
        let connection = transport.register_connection();
        let command = connection
            .incoming_command_queue
            .record_enqueue_at(now - Duration::from_millis(40));
        let telemetry = connection
            .coalesced_telemetry_queue
            .record_enqueue_at(now - Duration::from_millis(70));
        let replacement = connection
            .coalesced_telemetry_queue
            .record_coalesced_replacement(telemetry);
        connection
            .coalesced_telemetry_queue
            .record_evicted_or_dropped(replacement);
        transport.record_slow_pressure_disconnect();

        let snapshot = transport.snapshot_at(now);
        assert_eq!(snapshot.incoming_command_queue.current_depth, 1);
        assert_eq!(snapshot.incoming_command_queue.oldest_age_ms, Some(40));
        assert_eq!(snapshot.coalesced_telemetry_queue.current_depth, 0);
        assert_eq!(snapshot.coalesced_telemetry_queue.max_depth, 1);
        assert_eq!(snapshot.coalesced_telemetry_queue.coalesced_count, 1);
        assert_eq!(
            snapshot.coalesced_telemetry_queue.evicted_or_dropped_count,
            1
        );
        assert_eq!(snapshot.slow_pressure_disconnect_count, 1);

        connection.incoming_command_queue.record_dequeue(command);
        assert_eq!(
            transport
                .snapshot_at(now)
                .incoming_command_queue
                .current_depth,
            0
        );
    }
}
