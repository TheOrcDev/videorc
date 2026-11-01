use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceDeferral {
    CaptureActive,
    FinalizingActive,
    MaintenanceRunning,
}

impl MaintenanceDeferral {
    pub fn message(self) -> &'static str {
        match self {
            MaintenanceDeferral::CaptureActive => {
                "Deferred while recording or streaming is active."
            }
            MaintenanceDeferral::FinalizingActive => "Deferred while the recording is finalizing.",
            MaintenanceDeferral::MaintenanceRunning => {
                "Deferred while another recording maintenance job is running."
            }
        }
    }
}

#[derive(Debug, Default)]
struct FfmpegWorkState {
    capture_waiting: usize,
    capture_active: bool,
    /// Buffer-only sessions' captures (plan 181): the ring runs by default
    /// whenever Videorc is open, muxing a copy of the hardware encode, so it
    /// never defers, cancels or waits for maintenance; shutdown still joins
    /// it. A count: the re-arm can overlap the previous ring's teardown.
    light_captures: usize,
    finalizing_active: bool,
    /// Background MP4 exports (post-terminal finalization). They block
    /// maintenance and the shutdown lifecycle join but never a new capture.
    export_active: usize,
    maintenance_running: bool,
    priority_maintenance_waiting: usize,
    recording_file_mutation_waiting: usize,
    recording_file_mutation_active: bool,
    maintenance_cancel_generation: u64,
    maintenance_cancel_requested: bool,
    /// Blocking maintenance threads (FFmpeg analysis/repair) still running.
    /// A permit can be dropped by a timeout while its thread is still killing
    /// FFmpeg (plan 200 C6); nothing new starts and quit waits until it exits.
    maintenance_workers: usize,
    /// Process shutdown cancels every maintenance job, now and later.
    shutdown_cancel: bool,
}

#[derive(Debug, Default)]
pub struct FfmpegWorkCoordinator {
    state: Mutex<FfmpegWorkState>,
    notify: Notify,
}

impl FfmpegWorkCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn begin_capture_when_available(self: &Arc<Self>) -> CapturePermit {
        let mut waiting_registered = false;
        loop {
            // Register the wakeup BEFORE inspecting the state: a permit
            // released between the state check and this waiter's first poll
            // must never be missed (lost wakeup), same contract as
            // begin_maintenance_when_idle_after_wait_registered.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let acquired = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.maintenance_running && !state.finalizing_active {
                    if waiting_registered {
                        state.capture_waiting = state.capture_waiting.saturating_sub(1);
                    }
                    state.capture_active = true;
                    true
                } else {
                    if !waiting_registered {
                        state.capture_waiting += 1;
                        waiting_registered = true;
                    }
                    if state.maintenance_running && !state.maintenance_cancel_requested {
                        state.maintenance_cancel_generation =
                            state.maintenance_cancel_generation.saturating_add(1);
                        state.maintenance_cancel_requested = true;
                        self.notify.notify_waiters();
                    }
                    false
                }
            };
            if acquired {
                return CapturePermit {
                    coordinator: self.clone(),
                    light: false,
                };
            }
            notified.await;
        }
    }

    /// A buffer-only session's permit (plan 181, redesign R2): waits only for
    /// an active finalization (the previous take's MP4 work), never for or
    /// against maintenance, so posters, quality checks and repairs keep
    /// running while the ring is on.
    pub async fn begin_light_capture_when_available(self: &Arc<Self>) -> CapturePermit {
        loop {
            let notified = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.finalizing_active {
                    state.light_captures = state.light_captures.saturating_add(1);
                    return CapturePermit {
                        coordinator: self.clone(),
                        light: true,
                    };
                }
                self.notify.notified()
            };
            notified.await;
        }
    }

    pub fn begin_finalizing(self: &Arc<Self>) -> FinalizingPermit {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.finalizing_active = true;
        }
        self.notify.notify_waiters();
        FinalizingPermit {
            coordinator: self.clone(),
        }
    }

    /// Marks a background recording export (MKV -> MP4 after the terminal
    /// status). Unlike `begin_finalizing`, it does not block the next capture:
    /// the user must be able to record again while the previous take exports.
    // Consumed by the background recording finalization job (instant-record P2).
    #[allow(dead_code)]
    pub fn begin_background_export(self: &Arc<Self>) -> ExportPermit {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.export_active = state.export_active.saturating_add(1);
        }
        self.notify.notify_waiters();
        ExportPermit {
            coordinator: self.clone(),
        }
    }

    pub fn try_begin_maintenance(
        self: &Arc<Self>,
    ) -> Result<MaintenancePermit, MaintenanceDeferral> {
        let mut state = self.state.lock().expect("ffmpeg work state poisoned");
        if state.capture_active {
            return Err(MaintenanceDeferral::CaptureActive);
        }
        if state.capture_waiting > 0 {
            return Err(MaintenanceDeferral::CaptureActive);
        }
        if state.finalizing_active || state.export_active > 0 {
            return Err(MaintenanceDeferral::FinalizingActive);
        }
        if state.maintenance_running
            || state.maintenance_workers > 0
            || state.priority_maintenance_waiting > 0
            || state.recording_file_mutation_waiting > 0
            || state.recording_file_mutation_active
        {
            return Err(MaintenanceDeferral::MaintenanceRunning);
        }
        Ok(self.begin_maintenance_locked(&mut state))
    }

    pub async fn begin_maintenance_when_idle(self: &Arc<Self>) -> MaintenancePermit {
        self.begin_maintenance_when_idle_after_wait_registered(|| {})
            .await
    }

    async fn begin_maintenance_when_idle_after_wait_registered<F>(
        self: &Arc<Self>,
        mut after_wait_registered: F,
    ) -> MaintenancePermit
    where
        F: FnMut(),
    {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            after_wait_registered();
            match self.try_begin_maintenance() {
                Ok(permit) => return permit,
                Err(_) => notified.await,
            }
        }
    }

    /// Wait for the next idle maintenance slot ahead of background maintenance.
    /// This is for short, user-visible work such as poster extraction. Capture
    /// and finalization still take precedence. An in-flight background
    /// maintenance job (post-recording quality gate, repair scan, ...) is
    /// asked to cancel — those jobs observe the token, defer, and re-run
    /// later — instead of queueing behind a multi-minute analysis, which
    /// would push a stateful caller such as sessions.poster past its
    /// execution contract and restart the backend (2026-08-29 tester log:
    /// poster queued behind a 110s-recording quality assessment).
    pub async fn begin_priority_maintenance_when_idle(self: &Arc<Self>) -> MaintenancePermit {
        let mut waiter = PriorityMaintenanceWaiter::new(self.clone());
        loop {
            // Register the wakeup BEFORE inspecting the state. Otherwise a
            // permit released between the state check and the waiter's first
            // poll is missed forever: later background maintenance stays
            // excluded by the priority waiter, nothing ever notifies again,
            // and a stateful caller such as sessions.poster wedges until its
            // execution contract restarts the backend (2026-08-29 Windows CI).
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let acquired = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.capture_active
                    && state.capture_waiting == 0
                    && !state.finalizing_active
                    && state.export_active == 0
                    && !state.maintenance_running
                    && state.maintenance_workers == 0
                    && state.recording_file_mutation_waiting == 0
                    && !state.recording_file_mutation_active
                {
                    state.priority_maintenance_waiting =
                        state.priority_maintenance_waiting.saturating_sub(1);
                    waiter.registered = false;
                    Some(self.begin_maintenance_locked(&mut state))
                } else {
                    if state.maintenance_running && !state.maintenance_cancel_requested {
                        state.maintenance_cancel_generation =
                            state.maintenance_cancel_generation.saturating_add(1);
                        state.maintenance_cancel_requested = true;
                        self.notify.notify_waiters();
                    }
                    None
                }
            };
            if let Some(permit) = acquired {
                return permit;
            }
            notified.await;
        }
    }

    fn begin_maintenance_locked(
        self: &Arc<Self>,
        state: &mut FfmpegWorkState,
    ) -> MaintenancePermit {
        state.maintenance_running = true;
        state.maintenance_cancel_requested = false;
        MaintenancePermit {
            coordinator: self.clone(),
            generation: state.maintenance_cancel_generation,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Process shutdown (quit, quit-and-update): cancel the running repair or
    /// analysis so its FFmpeg is killed, and every later one before it starts.
    pub fn cancel_maintenance_for_shutdown(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.shutdown_cancel = true;
            state.maintenance_cancel_generation =
                state.maintenance_cancel_generation.saturating_add(1);
            state.maintenance_cancel_requested = state.maintenance_running;
        }
        self.notify.notify_waiters();
    }

    /// Resolves once no maintenance thread is running (a cancelled repair has
    /// killed its FFmpeg and removed its temp).
    pub async fn wait_for_maintenance_workers(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if self
                .state
                .lock()
                .expect("ffmpeg work state poisoned")
                .maintenance_workers
                == 0
            {
                return;
            }
            notified.await;
        }
    }

    /// Gives Library deletion an atomic boundary against every repair, restore,
    /// caption burn, and other maintenance writer. A waiting deletion cancels
    /// the active maintenance process, then prevents another maintenance job
    /// from entering until the deletion has durably hidden/quarantined its
    /// exact files. This closes the copy/rename race where a late repair could
    /// otherwise recreate a recording after its Library row was deleted.
    pub async fn begin_recording_file_mutation_when_available(
        self: &Arc<Self>,
    ) -> RecordingFileMutationPermit {
        let mut waiter = RecordingFileMutationWaiter::new(self.clone());
        loop {
            // Register the wakeup BEFORE inspecting the state: a permit
            // released between the state check and this waiter's first poll
            // must never be missed (lost wakeup), same contract as
            // begin_maintenance_when_idle_after_wait_registered.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let acquired = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.maintenance_running
                    && state.maintenance_workers == 0
                    && !state.recording_file_mutation_active
                {
                    state.recording_file_mutation_waiting =
                        state.recording_file_mutation_waiting.saturating_sub(1);
                    waiter.registered = false;
                    state.recording_file_mutation_active = true;
                    true
                } else {
                    if state.maintenance_running && !state.maintenance_cancel_requested {
                        state.maintenance_cancel_generation =
                            state.maintenance_cancel_generation.saturating_add(1);
                        state.maintenance_cancel_requested = true;
                        self.notify.notify_waiters();
                    }
                    false
                }
            };
            if acquired {
                return RecordingFileMutationPermit {
                    coordinator: self.clone(),
                };
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub fn current_deferral(&self) -> Option<MaintenanceDeferral> {
        self.snapshot().current_deferral()
    }

    pub fn snapshot(&self) -> FfmpegWorkSnapshot {
        let state = self.state.lock().expect("ffmpeg work state poisoned");
        FfmpegWorkSnapshot {
            capture_waiting: state.capture_waiting,
            capture_active: state.capture_active,
            light_capture_active: state.light_captures > 0,
            finalizing_active: state.finalizing_active,
            export_active: state.export_active,
            maintenance_running: state.maintenance_running,
            maintenance_cancel_requested: state.maintenance_cancel_requested,
        }
    }

    /// Wait until the active capture permit, the monitor's finalization
    /// permit and every background export permit are released.
    /// `monitor_session` acquires finalization before retiring the
    /// ActiveRecording (and therefore before dropping capture), so there is no
    /// false-idle gap between FFmpeg exit and MP4/persistence work; a background
    /// export registers its permit before the terminal status is published.
    /// Process shutdown uses this as its exact lifecycle join.
    pub async fn wait_for_capture_and_finalization_idle(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let idle = {
                let state = self.state.lock().expect("ffmpeg work state poisoned");
                !state.capture_active
                    && state.light_captures == 0
                    && !state.finalizing_active
                    && state.export_active == 0
            };
            if idle {
                return;
            }
            notified.await;
        }
    }

    fn maintenance_cancelled_since(&self, generation: u64) -> bool {
        let state = self.state.lock().expect("ffmpeg work state poisoned");
        state.shutdown_cancel || state.maintenance_cancel_generation > generation
    }

    fn begin_maintenance_worker(&self) {
        let mut state = self.state.lock().expect("ffmpeg work state poisoned");
        state.maintenance_workers = state.maintenance_workers.saturating_add(1);
    }

    fn end_maintenance_worker(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.maintenance_workers = state.maintenance_workers.saturating_sub(1);
        }
        self.notify.notify_waiters();
    }

    fn end_capture(&self, light: bool) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            if light {
                state.light_captures = state.light_captures.saturating_sub(1);
            } else {
                state.capture_active = false;
            }
        }
        self.notify.notify_waiters();
    }

    fn end_finalizing(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.finalizing_active = false;
        }
        self.notify.notify_waiters();
    }

    #[allow(dead_code)]
    fn end_export(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.export_active = state.export_active.saturating_sub(1);
        }
        self.notify.notify_waiters();
    }

    fn end_maintenance(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.maintenance_running = false;
            state.maintenance_cancel_requested = false;
        }
        self.notify.notify_waiters();
    }

    fn end_recording_file_mutation(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.recording_file_mutation_active = false;
        }
        self.notify.notify_waiters();
    }
}

struct PriorityMaintenanceWaiter {
    coordinator: Arc<FfmpegWorkCoordinator>,
    registered: bool,
}

impl PriorityMaintenanceWaiter {
    fn new(coordinator: Arc<FfmpegWorkCoordinator>) -> Self {
        {
            let mut state = coordinator
                .state
                .lock()
                .expect("ffmpeg work state poisoned");
            state.priority_maintenance_waiting += 1;
        }
        Self {
            coordinator,
            registered: true,
        }
    }
}

impl Drop for PriorityMaintenanceWaiter {
    fn drop(&mut self) {
        if !self.registered {
            return;
        }
        {
            let mut state = self
                .coordinator
                .state
                .lock()
                .expect("ffmpeg work state poisoned");
            state.priority_maintenance_waiting =
                state.priority_maintenance_waiting.saturating_sub(1);
        }
        self.coordinator.notify.notify_waiters();
    }
}

struct RecordingFileMutationWaiter {
    coordinator: Arc<FfmpegWorkCoordinator>,
    registered: bool,
}

impl RecordingFileMutationWaiter {
    fn new(coordinator: Arc<FfmpegWorkCoordinator>) -> Self {
        {
            let mut state = coordinator
                .state
                .lock()
                .expect("ffmpeg work state poisoned");
            state.recording_file_mutation_waiting += 1;
        }
        Self {
            coordinator,
            registered: true,
        }
    }
}

impl Drop for RecordingFileMutationWaiter {
    fn drop(&mut self) {
        if !self.registered {
            return;
        }
        {
            let mut state = self
                .coordinator
                .state
                .lock()
                .expect("ffmpeg work state poisoned");
            state.recording_file_mutation_waiting =
                state.recording_file_mutation_waiting.saturating_sub(1);
        }
        self.coordinator.notify.notify_waiters();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegWorkSnapshot {
    pub capture_waiting: usize,
    pub capture_active: bool,
    /// A buffer-only session's capture (plan 181): never a deferral.
    pub light_capture_active: bool,
    pub finalizing_active: bool,
    pub export_active: usize,
    pub maintenance_running: bool,
    pub maintenance_cancel_requested: bool,
}

impl FfmpegWorkSnapshot {
    pub fn current_deferral(&self) -> Option<MaintenanceDeferral> {
        if self.capture_active || self.capture_waiting > 0 {
            Some(MaintenanceDeferral::CaptureActive)
        } else if self.finalizing_active || self.export_active > 0 {
            Some(MaintenanceDeferral::FinalizingActive)
        } else if self.maintenance_running {
            Some(MaintenanceDeferral::MaintenanceRunning)
        } else {
            None
        }
    }
}

#[derive(Debug)]
pub struct CapturePermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
    light: bool,
}

impl Drop for CapturePermit {
    fn drop(&mut self) {
        self.coordinator.end_capture(self.light);
    }
}

#[derive(Debug)]
pub struct FinalizingPermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
}

impl Drop for FinalizingPermit {
    fn drop(&mut self) {
        self.coordinator.end_finalizing();
    }
}

#[allow(dead_code)]
pub struct ExportPermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
}

impl Drop for ExportPermit {
    fn drop(&mut self) {
        self.coordinator.end_export();
    }
}

#[derive(Debug)]
pub struct MaintenancePermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
    generation: u64,
    /// This job's own cancellation (a timeout), shared by its tokens.
    cancelled: Arc<AtomicBool>,
}

impl MaintenancePermit {
    pub fn cancel_token(&self) -> MaintenanceCancelToken {
        MaintenanceCancelToken {
            coordinator: self.coordinator.clone(),
            generation: self.generation,
            cancelled: self.cancelled.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MaintenanceCancelToken {
    coordinator: Arc<FfmpegWorkCoordinator>,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

/// Counts one blocking maintenance thread for as long as it lives (moved
/// into the `spawn_blocking` closure).
#[derive(Debug)]
pub struct MaintenanceWorker {
    coordinator: Arc<FfmpegWorkCoordinator>,
}

impl Drop for MaintenanceWorker {
    fn drop(&mut self) {
        self.coordinator.end_maintenance_worker();
    }
}

/// Cancels its job when dropped before [`MaintenanceCancelOnDrop::disarm`]:
/// a `timeout` that drops the waiting future then kills the FFmpeg child
/// instead of leaving it running unowned.
#[derive(Debug)]
pub struct MaintenanceCancelOnDrop {
    token: Option<MaintenanceCancelToken>,
}

impl MaintenanceCancelOnDrop {
    pub fn disarm(mut self) {
        self.token = None;
    }
}

impl Drop for MaintenanceCancelOnDrop {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            token.cancel();
        }
    }
}

#[derive(Debug)]
pub struct RecordingFileMutationPermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
}

impl Drop for RecordingFileMutationPermit {
    fn drop(&mut self) {
        self.coordinator.end_recording_file_mutation();
    }
}

impl MaintenanceCancelToken {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
            || self
                .coordinator
                .maintenance_cancelled_since(self.generation)
    }

    /// Cancels this job only (its timeout fired).
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn worker(&self) -> MaintenanceWorker {
        self.coordinator.begin_maintenance_worker();
        MaintenanceWorker {
            coordinator: self.coordinator.clone(),
        }
    }

    pub fn cancel_on_drop(&self) -> MaintenanceCancelOnDrop {
        MaintenanceCancelOnDrop {
            token: Some(self.clone()),
        }
    }
}

impl Drop for MaintenancePermit {
    fn drop(&mut self) {
        self.coordinator.end_maintenance();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_timed_out_repair_is_cancelled_and_holds_maintenance_until_it_exits() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let permit = coordinator.try_begin_maintenance().unwrap();
        let token = permit.cancel_token();
        let worker = token.worker();
        let waiting = tokio::spawn({
            let token = token.clone();
            async move {
                let _cancel_on_drop = token.cancel_on_drop();
                std::future::pending::<()>().await;
            }
        });
        tokio::task::yield_now().await;
        assert!(!token.is_cancelled());
        // The timeout drops the waiting future: the job is cancelled.
        waiting.abort();
        let _ = waiting.await;
        assert!(token.is_cancelled());
        // The job's permit is gone, but its thread is still killing FFmpeg.
        drop(permit);
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::MaintenanceRunning
        );
        let joined = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.wait_for_maintenance_workers().await }
        });
        tokio::task::yield_now().await;
        assert!(!joined.is_finished());
        drop(worker);
        tokio::time::timeout(std::time::Duration::from_secs(1), joined)
            .await
            .unwrap()
            .unwrap();
        // A later job is not cancelled by the earlier timeout.
        let next = coordinator.try_begin_maintenance().unwrap();
        assert!(!next.cancel_token().is_cancelled());
    }

    #[tokio::test]
    async fn a_disarmed_cancel_guard_leaves_the_job_running() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let permit = coordinator.try_begin_maintenance().unwrap();
        let token = permit.cancel_token();
        token.cancel_on_drop().disarm();
        assert!(!token.is_cancelled());
    }

    #[tokio::test]
    async fn shutdown_cancels_the_running_repair_and_every_later_one() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let permit = coordinator.try_begin_maintenance().unwrap();
        let token = permit.cancel_token();
        coordinator.cancel_maintenance_for_shutdown();
        assert!(token.is_cancelled());
        drop(permit);
        let later = coordinator.try_begin_maintenance().unwrap();
        assert!(later.cancel_token().is_cancelled());
    }

    #[tokio::test]
    async fn maintenance_is_deferred_while_capture_is_active() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let capture = coordinator.begin_capture_when_available().await;

        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );

        drop(capture);
        assert!(coordinator.try_begin_maintenance().is_ok());
    }

    #[tokio::test]
    async fn capture_waits_for_active_maintenance_to_finish() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let maintenance = coordinator.try_begin_maintenance().unwrap();

        assert_eq!(
            coordinator.current_deferral(),
            Some(MaintenanceDeferral::MaintenanceRunning)
        );

        drop(maintenance);
        let capture = coordinator.begin_capture_when_available().await;
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );
        drop(capture);
    }

    #[tokio::test]
    async fn waiting_capture_requests_active_maintenance_cancellation() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let maintenance = coordinator.try_begin_maintenance().unwrap();
        let cancel_token = maintenance.cancel_token();

        let waiting_capture = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.begin_capture_when_available().await }
        });
        tokio::task::yield_now().await;

        let snapshot = coordinator.snapshot();
        assert!(snapshot.maintenance_running);
        assert!(snapshot.maintenance_cancel_requested);
        assert!(cancel_token.is_cancelled());

        drop(maintenance);
        let capture = waiting_capture.await.unwrap();
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );
        drop(capture);
    }

    #[tokio::test]
    async fn capture_waits_for_finalization_to_finish() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let finalizing = coordinator.begin_finalizing();

        assert_eq!(
            coordinator.current_deferral(),
            Some(MaintenanceDeferral::FinalizingActive)
        );

        drop(finalizing);
        let capture = coordinator.begin_capture_when_available().await;
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );
        drop(capture);
    }

    #[tokio::test]
    async fn capture_admits_while_background_export_active() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let export = coordinator.begin_background_export();

        // Record-after-stop must never wait on the previous take's MP4 export.
        let capture = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            coordinator.begin_capture_when_available(),
        )
        .await
        .expect("capture must be admitted while an export runs");
        assert!(coordinator.snapshot().capture_active);
        assert_eq!(coordinator.snapshot().export_active, 1);
        drop(capture);
        drop(export);
        assert_eq!(coordinator.snapshot().export_active, 0);
    }

    /// Plan 181 (redesign R2): the default ring's capture is light. Posters
    /// and other maintenance run beside it, a waiting maintenance job is not
    /// cancelled by it, and shutdown still joins it.
    #[tokio::test]
    async fn light_capture_never_defers_maintenance_but_shutdown_joins_it() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let ring = coordinator.begin_light_capture_when_available().await;
        assert!(coordinator.snapshot().light_capture_active);
        assert!(!coordinator.snapshot().capture_active);
        let maintenance = coordinator
            .try_begin_maintenance()
            .expect("maintenance runs beside a light capture");
        assert!(!coordinator.snapshot().maintenance_cancel_requested);
        // A second light capture (the re-arm) starts beside running maintenance.
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            coordinator.begin_light_capture_when_available(),
        )
        .await
        .expect("a light capture never waits for maintenance");
        assert!(!coordinator.snapshot().maintenance_cancel_requested);
        drop(maintenance);
        drop(next);
        let join = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.wait_for_capture_and_finalization_idle().await }
        });
        tokio::task::yield_now().await;
        assert!(!join.is_finished(), "shutdown join must wait for the ring");
        drop(ring);
        tokio::time::timeout(std::time::Duration::from_secs(1), join)
            .await
            .expect("shutdown join must resolve once the ring's permit drops")
            .unwrap();
    }

    #[tokio::test]
    async fn maintenance_defers_while_background_export_active() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let export = coordinator.begin_background_export();

        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::FinalizingActive
        );
        assert_eq!(
            coordinator.current_deferral(),
            Some(MaintenanceDeferral::FinalizingActive)
        );

        drop(export);
        assert!(coordinator.try_begin_maintenance().is_ok());
    }

    #[tokio::test]
    async fn shutdown_wait_covers_background_export() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let export = coordinator.begin_background_export();
        let join = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.wait_for_capture_and_finalization_idle().await }
        });
        tokio::task::yield_now().await;
        assert!(
            !join.is_finished(),
            "shutdown join must wait for the export"
        );

        drop(export);
        tokio::time::timeout(std::time::Duration::from_secs(1), join)
            .await
            .expect("shutdown join must resolve once the export permit drops")
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_join_has_no_false_idle_gap_between_capture_and_finalization() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let capture = coordinator.begin_capture_when_available().await;
        let joined = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.wait_for_capture_and_finalization_idle().await }
        });
        tokio::task::yield_now().await;
        assert!(!joined.is_finished());

        let finalizing = coordinator.begin_finalizing();
        drop(capture);
        tokio::task::yield_now().await;
        assert!(
            !joined.is_finished(),
            "the monitor's finalization permit must bridge capture retirement"
        );

        drop(finalizing);
        tokio::time::timeout(std::time::Duration::from_secs(1), joined)
            .await
            .expect("shutdown join")
            .expect("shutdown join task");
    }

    #[tokio::test]
    async fn waiting_capture_defers_pending_maintenance() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let finalizing = coordinator.begin_finalizing();
        let waiting_capture = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.begin_capture_when_available().await }
        });

        tokio::task::yield_now().await;
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );

        drop(finalizing);
        let capture = waiting_capture.await.unwrap();
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::CaptureActive
        );
        drop(capture);
    }

    #[tokio::test]
    async fn priority_maintenance_runs_before_waiting_background_maintenance() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let finalizing = coordinator.begin_finalizing();
        let background = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.begin_maintenance_when_idle().await }
        });
        tokio::task::yield_now().await;
        let priority = tokio::spawn({
            let coordinator = coordinator.clone();
            async move { coordinator.begin_priority_maintenance_when_idle().await }
        });
        tokio::task::yield_now().await;

        drop(finalizing);
        let priority_permit = priority.await.unwrap();
        assert!(!background.is_finished());

        drop(priority_permit);
        drop(background.await.unwrap());
    }

    /// 2026-08-29 Windows CI: a priority waiter that checked the state while a
    /// maintenance permit was still held could miss the release notification
    /// (its Notify future registered only on first poll), stay wedged behind
    /// its own `priority_maintenance_waiting` registration forever, and force
    /// the backend to restart on the mutation execution contract. The waiter
    /// must always acquire after the release, across many interleavings.
    #[tokio::test]
    async fn released_maintenance_wakes_a_waiting_priority_waiter() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        for _ in 0..200 {
            let maintenance = coordinator.try_begin_maintenance().unwrap();
            let waiter = tokio::spawn({
                let coordinator = coordinator.clone();
                async move { coordinator.begin_priority_maintenance_when_idle().await }
            });
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
            drop(maintenance);
            let permit = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("priority waiter must acquire after the release")
                .expect("priority waiter task");
            drop(permit);
        }
    }

    #[tokio::test]
    async fn released_maintenance_wakes_a_waiting_capture() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        for _ in 0..200 {
            let maintenance = coordinator.try_begin_maintenance().unwrap();
            let waiter = tokio::spawn({
                let coordinator = coordinator.clone();
                async move { coordinator.begin_capture_when_available().await }
            });
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
            drop(maintenance);
            let capture = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("capture waiter must acquire after the release")
                .expect("capture waiter task");
            drop(capture);
        }
    }

    /// 2026-08-29 tester log: a priority waiter (sessions.poster) queued
    /// behind a still-running post-recording quality assessment for minutes
    /// and blew its 25s execution contract, restarting the backend. Priority
    /// maintenance is short, user-visible work: it must request cancellation
    /// of the active background job (which defers and re-runs later) instead
    /// of queueing behind it.
    #[tokio::test]
    async fn priority_maintenance_cancels_the_active_maintenance_and_acquires() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        for _ in 0..25 {
            let maintenance = coordinator.try_begin_maintenance().unwrap();
            let cancel_token = maintenance.cancel_token();
            let waiter = tokio::spawn({
                let coordinator = coordinator.clone();
                async move { coordinator.begin_priority_maintenance_when_idle().await }
            });
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while !cancel_token.is_cancelled() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("priority waiter must request cancellation of the active maintenance");
            drop(maintenance);
            let permit = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("priority waiter must acquire after the cancelled job releases")
                .expect("priority waiter task");
            drop(permit);
        }
    }

    #[tokio::test]
    async fn background_maintenance_observes_mutation_release_at_wait_registration_boundary() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let mut mutation = Some(
            coordinator
                .begin_recording_file_mutation_when_available()
                .await,
        );

        let maintenance = coordinator
            .begin_maintenance_when_idle_after_wait_registered(|| drop(mutation.take()))
            .await;

        assert!(coordinator.snapshot().maintenance_running);
        drop(maintenance);
    }

    #[tokio::test]
    async fn recording_file_mutation_cancels_and_excludes_active_maintenance() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let maintenance = coordinator.try_begin_maintenance().unwrap();
        let cancel_token = maintenance.cancel_token();
        let mutation = tokio::spawn({
            let coordinator = coordinator.clone();
            async move {
                coordinator
                    .begin_recording_file_mutation_when_available()
                    .await
            }
        });

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !cancel_token.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("recording-file mutation requests maintenance cancellation");
        assert!(cancel_token.is_cancelled());
        assert!(!mutation.is_finished());

        drop(maintenance);
        let mutation = mutation.await.unwrap();
        assert_eq!(
            coordinator.try_begin_maintenance().unwrap_err(),
            MaintenanceDeferral::MaintenanceRunning
        );

        drop(mutation);
        assert!(coordinator.try_begin_maintenance().is_ok());
    }

    #[tokio::test]
    async fn cancelled_recording_file_mutation_waiter_does_not_starve_maintenance() {
        let coordinator = Arc::new(FfmpegWorkCoordinator::new());
        let maintenance = coordinator.try_begin_maintenance().unwrap();
        let cancel_token = maintenance.cancel_token();
        let mutation = tokio::spawn({
            let coordinator = coordinator.clone();
            async move {
                coordinator
                    .begin_recording_file_mutation_when_available()
                    .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !cancel_token.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("recording-file mutation waiter registration");
        mutation.abort();
        let _ = mutation.await;
        drop(maintenance);

        assert!(coordinator.try_begin_maintenance().is_ok());
    }
}
