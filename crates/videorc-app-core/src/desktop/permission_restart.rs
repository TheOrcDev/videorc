//! The backend restart a permission grant asks for, and Reopen Videorc
//! (plan 220 S2.6b), as Electron main runs them (`index.ts`:
//! `requestPermissionBackendRestart`, `runPermissionBackendRestart`,
//! `updateMainCaptureState`'s flush, `relaunchForPermission`).
//!
//! A fresh camera, microphone or screen grant restarts the backend so
//! capture starts with it. The restart waits while capture is active or
//! unknown ([`DeferredPermissionRestart`]) and runs once capture is idle;
//! it runs only after the backend admits it (the interruption lease), and a
//! refusal keeps it waiting. Reopen Videorc takes the same admission.
//!
//! Both guards read the guarded capture state (`guardedCaptureState`): a
//! cloud room this computer has on air or recording counts as live activity
//! while the local session is idle, so a grant never cuts the room.

use std::sync::{Arc, Mutex};

use crate::interruption::{
    InterruptionAction, InterruptionTransport, Lease, LeaseEndpoint, acquire_interruption_lease,
    run_interrupting_action,
};
use crate::log::Level;
use crate::supervisor::{BackendState, SupervisorRestart};

use super::capture_state::{CloudRoomActivity, MainCaptureState, guard_capture_state};
use super::grant_watch::WatchLog;
use super::permissions::{
    BackendRestartBoundary, DeferredPermissionRestart, MediaAccessRestartResult, PermissionFuture,
    RelaunchForPermissionResult, relaunch_for_permission_with_interruption_lease,
};

/// What a restart needs from the backend.
pub trait BackendRestarter: Send + Sync {
    /// `currentBackendRestartBoundary`: the backend whose capture predates
    /// the grant.
    fn boundary(&self) -> Option<BackendRestartBoundary>;
    /// `backendAdminConnection !== null`.
    fn backend_connected(&self) -> bool;
    /// `acquireCurrentBackendInterruption`: `None` when there is no backend,
    /// when it refuses, or when it changed while admitting.
    fn acquire(
        &self,
        action: InterruptionAction,
        reason: String,
    ) -> PermissionFuture<'_, Result<Option<Arc<dyn Lease>>, String>>;
    /// `restartBackend`: stop and start, the backend's lease held.
    fn restart(&self, reason: String) -> PermissionFuture<'_, Result<(), String>>;
}

/// `Reopening Videorc after a permission grant.`
pub const RELAUNCH_REASON: &str = "Reopening Videorc after a permission grant.";

/// The restarts and the relaunch, with main's capture state and the cloud
/// room's activity.
pub struct PermissionRestarts {
    restarter: Arc<dyn BackendRestarter>,
    state: Mutex<GuardState>,
    log: WatchLog,
}

struct GuardState {
    deferred: DeferredPermissionRestart,
    capture: MainCaptureState,
    room: Option<CloudRoomActivity>,
}

impl GuardState {
    /// `guardedCaptureState()`.
    fn guarded(&self) -> MainCaptureState {
        guard_capture_state(self.capture, self.room)
    }

    /// `applyGuardedCaptureState`'s flush.
    fn flush(&mut self) -> Option<String> {
        let guarded = self.guarded();
        self.deferred.flush(guarded)
    }
}

impl PermissionRestarts {
    pub fn new(restarter: Arc<dyn BackendRestarter>, log: WatchLog) -> Self {
        Self {
            restarter,
            state: Mutex::new(GuardState {
                deferred: DeferredPermissionRestart::default(),
                capture: MainCaptureState::Unknown,
                room: None,
            }),
            log,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GuardState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The local session's state, as the backend last reported it.
    pub fn capture(&self) -> MainCaptureState {
        self.lock().capture
    }

    /// What the guards read: the local state, or the cloud room's activity
    /// while the local session is idle.
    pub fn guarded_capture(&self) -> MainCaptureState {
        self.lock().guarded()
    }

    pub fn pending_reason(&self) -> Option<String> {
        self.lock().deferred.pending_reason().map(str::to_string)
    }

    /// `updateMainCaptureState`'s flush: the waiting restart's reason when
    /// the guarded state just became idle. The caller runs it ([`Self::run`]).
    pub fn capture_changed(&self, capture: MainCaptureState) -> Option<String> {
        let mut state = self.lock();
        state.capture = capture;
        state.flush()
    }

    /// `observeCloudRoomActivity`: the room went on or off air (or its
    /// recording started or ended). Its end can be the idle a waiting
    /// restart needs; the caller runs the returned reason ([`Self::run`]).
    pub fn room_changed(&self, room: Option<CloudRoomActivity>) -> Option<String> {
        let mut state = self.lock();
        if state.room == room {
            return None;
        }
        state.room = room;
        state.flush()
    }

    /// `retainDeferredPermissionRestart`.
    fn retain(&self, reason: &str) {
        self.lock()
            .deferred
            .request(MainCaptureState::Unknown, reason);
    }

    /// `requestPermissionBackendRestart`: runs now, or waits for idle.
    pub async fn request(&self, reason: String) -> Result<MediaAccessRestartResult, String> {
        let run = {
            let mut state = self.lock();
            let guarded = state.guarded();
            state.deferred.request(guarded, &reason)
        };
        let Some(reason) = run else {
            (self.log)(
                Level::Info,
                "Permission restart deferred until the active capture is idle.".to_string(),
            );
            return Ok(MediaAccessRestartResult {
                restarted: false,
                stale_backend: self.restarter.boundary(),
            });
        };
        self.run(reason).await
    }

    /// `runPermissionBackendRestart`: the restart under the backend's lease;
    /// a refusal or a failure keeps it waiting.
    pub async fn run(&self, reason: String) -> Result<MediaAccessRestartResult, String> {
        let stale = Arc::new(Mutex::new(self.restarter.boundary()));
        let lease = match self
            .restarter
            .acquire(InterruptionAction::PermissionRestart, reason.clone())
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                self.retain(&reason);
                return Err(error);
            }
        };
        let restarter = self.restarter.clone();
        let seen = stale.clone();
        let restart_reason = reason.clone();
        let admitted = run_interrupting_action(lease, async move {
            *seen.lock().unwrap_or_else(|p| p.into_inner()) = restarter.boundary();
            restarter.restart(restart_reason).await
        })
        .await;
        let stale_backend = stale.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match admitted {
            Ok(true) => Ok(MediaAccessRestartResult {
                restarted: true,
                stale_backend,
            }),
            Ok(false) => {
                self.retain(&reason);
                (self.log)(
                    Level::Info,
                    "Permission restart deferred because capture became active, started, or could not be confirmed idle.".to_string(),
                );
                Ok(MediaAccessRestartResult {
                    restarted: false,
                    stale_backend,
                })
            }
            Err(error) => {
                self.retain(&reason);
                Err(error)
            }
        }
    }

    /// `relaunchForPermission`: refused while capture is active (or not
    /// known to be idle), run only under the backend's lease. `relaunch`
    /// quits the app the normal way and marks it to start again.
    pub async fn relaunch(
        &self,
        relaunch: impl FnOnce(),
    ) -> Result<RelaunchForPermissionResult, String> {
        let connected = self.restarter.backend_connected();
        let blocked = self.guarded_capture().blocks_interruption(connected);
        let restarter = self.restarter.clone();
        relaunch_for_permission_with_interruption_lease(
            blocked,
            connected,
            async move {
                restarter
                    .acquire(
                        InterruptionAction::PermissionRestart,
                        RELAUNCH_REASON.to_string(),
                    )
                    .await
            },
            || {
                (self.log)(Level::Info, RELAUNCH_REASON.to_string());
                relaunch();
            },
        )
        .await
    }
}

/// The real restarter: the supervisor's restart and the backend's lease on
/// its admin credential.
pub struct SupervisorRestarter {
    pub restart: SupervisorRestart,
    pub transport: Arc<dyn InterruptionTransport>,
}

impl SupervisorRestarter {
    fn ready(&self) -> Option<(u32, crate::process::BackendBootstrap)> {
        match &*self.restart.state().borrow() {
            BackendState::Ready {
                generation,
                bootstrap,
            } => Some((*generation, bootstrap.clone())),
            _ => None,
        }
    }
}

impl BackendRestarter for SupervisorRestarter {
    fn boundary(&self) -> Option<BackendRestartBoundary> {
        self.ready().map(|(_, bootstrap)| BackendRestartBoundary {
            port: bootstrap.port,
            pid: Some(bootstrap.pid),
        })
    }

    fn backend_connected(&self) -> bool {
        self.ready().is_some()
    }

    fn acquire(
        &self,
        action: InterruptionAction,
        reason: String,
    ) -> PermissionFuture<'_, Result<Option<Arc<dyn Lease>>, String>> {
        Box::pin(async move {
            let Some((generation, bootstrap)) = self.ready() else {
                return Ok(None);
            };
            let lease = acquire_interruption_lease(
                LeaseEndpoint::admin(&bootstrap),
                action,
                &reason,
                None,
                self.transport.clone(),
            )
            .await?;
            let Some(lease) = lease else {
                return Ok(None);
            };
            // A backend restart between admission and now makes the lease
            // irrelevant to the new process: fail closed.
            if self.ready().map(|(current, _)| current) != Some(generation) {
                let _ = lease.release().await;
                return Ok(None);
            }
            Ok(Some(Arc::new(lease) as Arc<dyn Lease>))
        })
    }

    fn restart(&self, reason: String) -> PermissionFuture<'_, Result<(), String>> {
        Box::pin(async move { self.restart.restart(reason).await })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::interruption::LeaseFuture;

    struct FakeLease;

    impl Lease for FakeLease {
        fn id(&self) -> &str {
            "lease-1"
        }
        fn expires_in_ms(&self) -> u64 {
            30_000
        }
        fn consume(&self) -> LeaseFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn renew(&self) -> LeaseFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn release(&self) -> LeaseFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct Fake {
        admit: bool,
        connected: bool,
        restarts: Mutex<Vec<String>>,
        acquired: AtomicUsize,
        port: Mutex<u16>,
    }

    impl Fake {
        fn new(admit: bool) -> Arc<Self> {
            Arc::new(Self {
                admit,
                connected: true,
                restarts: Mutex::new(Vec::new()),
                acquired: AtomicUsize::new(0),
                port: Mutex::new(9988),
            })
        }
    }

    impl BackendRestarter for Fake {
        fn boundary(&self) -> Option<BackendRestartBoundary> {
            self.connected.then(|| BackendRestartBoundary {
                port: *self.port.lock().unwrap(),
                pid: Some(42),
            })
        }
        fn backend_connected(&self) -> bool {
            self.connected
        }
        fn acquire(
            &self,
            _action: InterruptionAction,
            _reason: String,
        ) -> PermissionFuture<'_, Result<Option<Arc<dyn Lease>>, String>> {
            self.acquired.fetch_add(1, Ordering::SeqCst);
            let admit = self.admit;
            Box::pin(async move { Ok(admit.then(|| Arc::new(FakeLease) as Arc<dyn Lease>)) })
        }
        fn restart(&self, reason: String) -> PermissionFuture<'_, Result<(), String>> {
            self.restarts.lock().unwrap().push(reason);
            *self.port.lock().unwrap() += 1;
            Box::pin(async { Ok(()) })
        }
    }

    fn flow(fake: Arc<Fake>) -> (PermissionRestarts, Arc<Mutex<Vec<String>>>) {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let logged = logs.clone();
        (
            PermissionRestarts::new(
                fake,
                Arc::new(move |_, message| logged.lock().unwrap().push(message)),
            ),
            logs,
        )
    }

    #[tokio::test]
    async fn an_idle_grant_restarts_under_the_lease_and_names_the_old_backend() {
        let fake = Fake::new(true);
        let (flow, _) = flow(fake.clone());
        flow.capture_changed(MainCaptureState::Idle);
        let result = flow.request("camera granted".to_string()).await.unwrap();
        assert!(result.restarted);
        assert_eq!(result.stale_backend.unwrap().port, 9988);
        assert_eq!(*fake.restarts.lock().unwrap(), ["camera granted"]);
        assert_eq!(flow.pending_reason(), None);
    }

    #[tokio::test]
    async fn a_grant_during_a_recording_waits_and_runs_once_at_idle() {
        let fake = Fake::new(true);
        let (flow, logs) = flow(fake.clone());
        flow.capture_changed(MainCaptureState::Recording);
        let result = flow.request("camera granted".to_string()).await.unwrap();
        assert!(!result.restarted);
        assert_eq!(result.stale_backend.unwrap().port, 9988);
        assert_eq!(fake.acquired.load(Ordering::SeqCst), 0);
        assert!(logs.lock().unwrap().contains(
            &"Permission restart deferred until the active capture is idle.".to_string()
        ));
        assert_eq!(flow.capture_changed(MainCaptureState::Stopping), None);
        let reason = flow.capture_changed(MainCaptureState::Idle).unwrap();
        assert_eq!(reason, "camera granted");
        assert!(flow.run(reason).await.unwrap().restarted);
        assert_eq!(flow.capture_changed(MainCaptureState::Idle), None);
        assert_eq!(fake.restarts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_refused_lease_keeps_the_restart_waiting() {
        let fake = Fake::new(false);
        let (flow, logs) = flow(fake.clone());
        flow.capture_changed(MainCaptureState::Idle);
        let result = flow
            .request("microphone granted".to_string())
            .await
            .unwrap();
        assert!(!result.restarted);
        assert!(fake.restarts.lock().unwrap().is_empty());
        assert_eq!(flow.pending_reason().as_deref(), Some("microphone granted"));
        assert!(logs.lock().unwrap().contains(&"Permission restart deferred because capture became active, started, or could not be confirmed idle.".to_string()));
        // The next idle status flushes it.
        assert_eq!(
            flow.capture_changed(MainCaptureState::Idle).as_deref(),
            Some("microphone granted")
        );
    }

    #[tokio::test]
    async fn a_live_cloud_room_defers_a_grant_and_blocks_reopen_until_it_ends() {
        let fake = Fake::new(true);
        let (flow, logs) = flow(fake.clone());
        flow.capture_changed(MainCaptureState::Idle);
        assert_eq!(flow.room_changed(Some(CloudRoomActivity::Live)), None);
        assert_eq!(flow.guarded_capture(), MainCaptureState::Streaming);
        let result = flow.request("camera granted".to_string()).await.unwrap();
        assert!(!result.restarted, "a grant must not cut the room");
        assert_eq!(fake.acquired.load(Ordering::SeqCst), 0);
        assert!(logs.lock().unwrap().contains(
            &"Permission restart deferred until the active capture is idle.".to_string()
        ));
        let relaunched = AtomicUsize::new(0);
        let refused = flow
            .relaunch(|| {
                relaunched.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
        assert!(!refused.relaunched);
        // The local session going idle again does not flush it: the room is
        // still on air.
        assert_eq!(flow.capture_changed(MainCaptureState::Idle), None);
        // A cloud recording alone still counts.
        assert_eq!(flow.room_changed(Some(CloudRoomActivity::Recording)), None);
        // The room ending is the idle the restart waited for.
        assert_eq!(flow.room_changed(None).as_deref(), Some("camera granted"));
        assert_eq!(relaunched.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reopen_is_refused_while_recording_and_runs_under_the_lease_when_idle() {
        let fake = Fake::new(true);
        let (flow, _) = flow(fake.clone());
        let relaunched = AtomicUsize::new(0);
        flow.capture_changed(MainCaptureState::Recording);
        let refused = flow
            .relaunch(|| {
                relaunched.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
        assert!(!refused.relaunched);
        // Unknown (no status yet) refuses too while a backend is connected.
        flow.capture_changed(MainCaptureState::Unknown);
        assert!(
            !flow
                .relaunch(|| {
                    relaunched.fetch_add(1, Ordering::SeqCst);
                })
                .await
                .unwrap()
                .relaunched
        );
        flow.capture_changed(MainCaptureState::Idle);
        let ok = flow
            .relaunch(|| {
                relaunched.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
        assert!(ok.relaunched);
        assert_eq!(relaunched.load(Ordering::SeqCst), 1);
        assert_eq!(fake.acquired.load(Ordering::SeqCst), 1);
    }
}
