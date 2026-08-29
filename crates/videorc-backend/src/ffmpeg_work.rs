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
    finalizing_active: bool,
    maintenance_running: bool,
    priority_maintenance_waiting: usize,
    recording_file_mutation_waiting: usize,
    recording_file_mutation_active: bool,
    maintenance_cancel_generation: u64,
    maintenance_cancel_requested: bool,
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
                };
            }
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
        if state.finalizing_active {
            return Err(MaintenanceDeferral::FinalizingActive);
        }
        if state.maintenance_running
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
    /// and finalization still take precedence.
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
                    && !state.maintenance_running
                    && state.recording_file_mutation_waiting == 0
                    && !state.recording_file_mutation_active
                {
                    state.priority_maintenance_waiting =
                        state.priority_maintenance_waiting.saturating_sub(1);
                    waiter.registered = false;
                    Some(self.begin_maintenance_locked(&mut state))
                } else {
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
                if !state.maintenance_running && !state.recording_file_mutation_active {
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
            finalizing_active: state.finalizing_active,
            maintenance_running: state.maintenance_running,
            maintenance_cancel_requested: state.maintenance_cancel_requested,
        }
    }

    /// Wait until the active capture permit and the monitor's finalization
    /// permit are both released. `monitor_session` acquires finalization before
    /// retiring the ActiveRecording (and therefore before dropping capture),
    /// so there is no false-idle gap between FFmpeg exit and MP4/persistence
    /// work. Process shutdown uses this as its exact lifecycle join.
    pub async fn wait_for_capture_and_finalization_idle(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            let idle = {
                let state = self.state.lock().expect("ffmpeg work state poisoned");
                !state.capture_active && !state.finalizing_active
            };
            if idle {
                return;
            }
            notified.await;
        }
    }

    fn maintenance_cancelled_since(&self, generation: u64) -> bool {
        let state = self.state.lock().expect("ffmpeg work state poisoned");
        state.maintenance_cancel_generation > generation
    }

    fn end_capture(&self) {
        {
            let mut state = self.state.lock().expect("ffmpeg work state poisoned");
            state.capture_active = false;
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
    pub finalizing_active: bool,
    pub maintenance_running: bool,
    pub maintenance_cancel_requested: bool,
}

impl FfmpegWorkSnapshot {
    pub fn current_deferral(&self) -> Option<MaintenanceDeferral> {
        if self.capture_active || self.capture_waiting > 0 {
            Some(MaintenanceDeferral::CaptureActive)
        } else if self.finalizing_active {
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
}

impl Drop for CapturePermit {
    fn drop(&mut self) {
        self.coordinator.end_capture();
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

#[derive(Debug)]
pub struct MaintenancePermit {
    coordinator: Arc<FfmpegWorkCoordinator>,
    generation: u64,
}

impl MaintenancePermit {
    pub fn cancel_token(&self) -> MaintenanceCancelToken {
        MaintenanceCancelToken {
            coordinator: self.coordinator.clone(),
            generation: self.generation,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MaintenanceCancelToken {
    coordinator: Arc<FfmpegWorkCoordinator>,
    generation: u64,
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
        self.coordinator
            .maintenance_cancelled_since(self.generation)
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
