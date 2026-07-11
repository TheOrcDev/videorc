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
            let notified = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.maintenance_running && !state.finalizing_active {
                    if waiting_registered {
                        state.capture_waiting = state.capture_waiting.saturating_sub(1);
                    }
                    state.capture_active = true;
                    return CapturePermit {
                        coordinator: self.clone(),
                    };
                }
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
        if state.maintenance_running || state.priority_maintenance_waiting > 0 {
            return Err(MaintenanceDeferral::MaintenanceRunning);
        }
        Ok(self.begin_maintenance_locked(&mut state))
    }

    pub async fn begin_maintenance_when_idle(self: &Arc<Self>) -> MaintenancePermit {
        loop {
            match self.try_begin_maintenance() {
                Ok(permit) => return permit,
                Err(_) => self.notify.notified().await,
            }
        }
    }

    /// Wait for the next idle maintenance slot ahead of background maintenance.
    /// This is for short, user-visible work such as poster extraction. Capture
    /// and finalization still take precedence.
    pub async fn begin_priority_maintenance_when_idle(self: &Arc<Self>) -> MaintenancePermit {
        let mut waiter = PriorityMaintenanceWaiter::new(self.clone());
        loop {
            let notified = {
                let mut state = self.state.lock().expect("ffmpeg work state poisoned");
                if !state.capture_active
                    && state.capture_waiting == 0
                    && !state.finalizing_active
                    && !state.maintenance_running
                {
                    state.priority_maintenance_waiting =
                        state.priority_maintenance_waiting.saturating_sub(1);
                    waiter.registered = false;
                    return self.begin_maintenance_locked(&mut state);
                }
                self.notify.notified()
            };
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
}
