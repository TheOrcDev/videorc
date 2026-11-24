//! The permission grant watcher (plan 220 S2.6b):
//! `main/system-permission-watch.ts`.
//!
//! Opening System Settings, or a screen request macOS answers there, starts a
//! watch: the grant is read every second, up to 90 times. A real
//! not-granted → granted transition restarts the backend exactly once, so
//! capture starts with the new grant; a pane already granted when the watch
//! starts never restarts anything (opening Settings is navigation, not a
//! grant). The watched grant is kept past the polling window, so a late
//! re-check (window focus, setup open longer) still notices it, once; a poll
//! and a re-check for the same grant restart once between them.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::log::Level;

use super::permissions::{
    MediaAccessPermission, MediaAccessStatus, PermissionFuture, SystemPermissionPane,
};

/// `getStatus`.
pub type StatusReader =
    Arc<dyn Fn(MediaAccessPermission) -> Result<MediaAccessStatus, String> + Send + Sync>;
/// `restartBackend`: asks for the restart (it may defer it).
pub type GrantRestart =
    Arc<dyn Fn(String) -> PermissionFuture<'static, Result<(), String>> + Send + Sync>;
pub type WatchLog = Arc<dyn Fn(Level, String) + Send + Sync>;

/// Electron's defaults: every second, 90 times.
pub const DEFAULT_INTERVAL: Duration = Duration::from_millis(1_000);
pub const DEFAULT_MAX_CHECKS: u32 = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrackedGrant {
    pane: SystemPermissionPane,
    permission: MediaAccessPermission,
    reason: String,
    status: MediaAccessStatus,
}

#[derive(Default)]
struct Inner {
    watch_id: u64,
    task: Option<JoinHandle<()>>,
    /// The grant still awaited: set by a watch from a non-granted status,
    /// kept past the polling window, cleared by the one restart or `stop`.
    tracked: Option<TrackedGrant>,
}

/// What the watcher is waiting for, for the smokes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedGrant {
    pub pane: SystemPermissionPane,
    pub status: MediaAccessStatus,
    pub polling: bool,
}

#[derive(Clone)]
pub struct GrantWatcher {
    inner: Arc<Mutex<Inner>>,
    get_status: StatusReader,
    restart: GrantRestart,
    sink: WatchLog,
    interval: Duration,
    max_checks: u32,
}

impl GrantWatcher {
    pub fn new(
        get_status: StatusReader,
        restart: GrantRestart,
        log: WatchLog,
        interval: Duration,
        max_checks: u32,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            get_status,
            restart,
            sink: log,
            interval,
            max_checks: max_checks.max(1),
        }
    }

    fn log(&self, level: Level, message: String) {
        (self.sink)(level, message);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Retires the watch and forgets the grant.
    pub fn stop(&self) {
        let mut inner = self.lock();
        inner.watch_id += 1;
        inner.tracked = None;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
    }

    /// The grant awaited, if any.
    pub fn watched(&self) -> Option<WatchedGrant> {
        let inner = self.lock();
        inner.tracked.as_ref().map(|grant| WatchedGrant {
            pane: grant.pane,
            status: grant.status,
            polling: inner.task.as_ref().is_some_and(|task| !task.is_finished()),
        })
    }

    /// Starts watching `pane` (replacing any older watch). Needs a tokio
    /// runtime.
    pub fn watch(&self, pane: SystemPermissionPane, reason: &str) {
        let Some(permission) = pane.permission() else {
            return;
        };
        self.stop();
        let previous = match (self.get_status)(permission) {
            Ok(status) => status,
            Err(error) => {
                self.log(
                    Level::Warn,
                    format!(
                        "Could not read {} permission before Settings opened: {error}",
                        pane.as_str()
                    ),
                );
                return;
            }
        };
        // Opening Settings is navigation, not a transition: an already
        // granted pane must never restart the backend.
        if previous == MediaAccessStatus::Granted {
            return;
        }
        let mut inner = self.lock();
        inner.tracked = Some(TrackedGrant {
            pane,
            permission,
            reason: reason.to_string(),
            status: previous,
        });
        let watch_id = inner.watch_id;
        let watcher = self.clone();
        let reason = reason.to_string();
        inner.task = Some(tokio::spawn(async move {
            watcher
                .poll(watch_id, pane, permission, reason, previous)
                .await;
        }));
    }

    async fn poll(
        &self,
        watch_id: u64,
        pane: SystemPermissionPane,
        permission: MediaAccessPermission,
        reason: String,
        mut previous: MediaAccessStatus,
    ) {
        let mut remaining = self.max_checks;
        loop {
            tokio::time::sleep(self.interval).await;
            if self.lock().watch_id != watch_id {
                return;
            }
            let status = match (self.get_status)(permission) {
                Ok(status) => status,
                Err(error) => {
                    self.log(
                        Level::Warn,
                        format!(
                            "Could not check {} permission after Settings opened: {error}",
                            pane.as_str()
                        ),
                    );
                    return;
                }
            };
            if status == MediaAccessStatus::Granted && previous != MediaAccessStatus::Granted {
                let grant = TrackedGrant {
                    pane,
                    permission,
                    reason,
                    status: previous,
                };
                // This task's own handle is dropped (detached, not aborted),
                // so a later `stop` cannot cut the restart short.
                if self.claim(watch_id).is_some() {
                    self.restart_once(grant, "polled").await;
                }
                return;
            }
            previous = status;
            {
                let mut inner = self.lock();
                if let Some(tracked) = inner.tracked.as_mut()
                    && tracked.permission == permission
                {
                    tracked.status = status;
                }
            }
            remaining -= 1;
            if remaining == 0 {
                self.log(
                    Level::Warn,
                    format!(
                        "{} permission did not become granted before the watcher timed out; it is re-checked on focus.",
                        pane.as_str()
                    ),
                );
                return;
            }
        }
    }

    /// Takes the grant for one restart: the tracking is cleared and the poll
    /// retired before the restart runs, so a poll and a re-check can never
    /// both restart for it. `None` when a re-check or a stop took it first;
    /// otherwise the poll's handle, taken out so nothing aborts it later.
    fn claim(&self, watch_id: u64) -> Option<Option<JoinHandle<()>>> {
        let mut inner = self.lock();
        if inner.watch_id != watch_id {
            return None;
        }
        inner.tracked = None;
        inner.watch_id += 1;
        Some(inner.task.take())
    }

    async fn restart_once(&self, grant: TrackedGrant, how: &str) {
        self.log(
            Level::Info,
            format!(
                "{} permission is now granted ({how}); requesting a capture backend restart.",
                grant.pane.as_str()
            ),
        );
        if let Err(error) = (self.restart)(grant.reason.clone()).await {
            self.log(
                Level::Warn,
                format!(
                    "Could not restart capture backend after {} permission grant: {error}",
                    grant.pane.as_str()
                ),
            );
        }
    }

    /// Re-reads the watched grant now (window focus, setup open past the
    /// polling window). True when a real transition restarted capture just
    /// now; a pane already granted, or never watched, never restarts.
    pub async fn recheck(&self) -> bool {
        let (grant, watch_id) = {
            let inner = self.lock();
            match inner.tracked.clone() {
                Some(grant) => (grant, inner.watch_id),
                None => return false,
            }
        };
        let status = match (self.get_status)(grant.permission) {
            Ok(status) => status,
            Err(error) => {
                self.log(
                    Level::Warn,
                    format!(
                        "Could not re-check {} permission: {error}",
                        grant.pane.as_str()
                    ),
                );
                return false;
            }
        };
        if status != MediaAccessStatus::Granted {
            let mut inner = self.lock();
            if let Some(tracked) = inner.tracked.as_mut() {
                tracked.status = status;
            }
            return false;
        }
        if grant.status == MediaAccessStatus::Granted {
            return false;
        }
        let Some(poll) = self.claim(watch_id) else {
            return false;
        };
        if let Some(poll) = poll {
            poll.abort();
        }
        self.restart_once(grant, "noticed on re-check").await;
        true
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use MediaAccessStatus::*;

    struct Harness {
        status: Arc<Mutex<HashMap<MediaAccessPermission, MediaAccessStatus>>>,
        restarts: Arc<Mutex<Vec<String>>>,
        logs: Arc<Mutex<Vec<String>>>,
        watcher: GrantWatcher,
    }

    const INTERVAL: Duration = Duration::from_millis(20);

    fn harness(initial: MediaAccessStatus, max_checks: u32) -> Harness {
        let status = Arc::new(Mutex::new(HashMap::from([
            (MediaAccessPermission::Camera, initial),
            (MediaAccessPermission::Microphone, initial),
            (MediaAccessPermission::Screen, initial),
        ])));
        let restarts = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let read = status.clone();
        let restarted = restarts.clone();
        let logged = logs.clone();
        let watcher = GrantWatcher::new(
            Arc::new(move |permission| Ok(read.lock().unwrap()[&permission])),
            Arc::new(move |reason| {
                restarted.lock().unwrap().push(reason);
                Box::pin(async { Ok(()) })
            }),
            Arc::new(move |level, message| {
                logged
                    .lock()
                    .unwrap()
                    .push(format!("{}:{message}", level.as_str()))
            }),
            INTERVAL,
            max_checks,
        );
        Harness {
            status,
            restarts,
            logs,
            watcher,
        }
    }

    impl Harness {
        fn set(&self, permission: MediaAccessPermission, status: MediaAccessStatus) {
            self.status.lock().unwrap().insert(permission, status);
        }
        fn restarts(&self) -> Vec<String> {
            self.restarts.lock().unwrap().clone()
        }
    }

    async fn ticks(n: u32) {
        tokio::time::sleep(INTERVAL * n + INTERVAL / 2).await;
    }

    #[tokio::test]
    async fn an_already_granted_pane_never_restarts() {
        let h = harness(Granted, 2);
        h.watcher
            .watch(SystemPermissionPane::Camera, "restart after camera grant");
        ticks(3).await;
        assert!(h.restarts().is_empty());
        assert_eq!(h.watcher.watched(), None);
    }

    #[tokio::test]
    async fn a_grant_after_settings_opened_restarts_once_with_its_reason() {
        let h = harness(Denied, 50);
        h.watcher
            .watch(SystemPermissionPane::Camera, "restart after camera grant");
        ticks(2).await;
        h.set(MediaAccessPermission::Camera, Granted);
        ticks(3).await;
        assert_eq!(h.restarts(), ["restart after camera grant"]);
        assert_eq!(h.watcher.watched(), None);
    }

    #[tokio::test]
    async fn a_grant_that_never_comes_never_restarts_and_the_watch_times_out() {
        let h = harness(Denied, 2);
        h.watcher.watch(
            SystemPermissionPane::ScreenRecording,
            "restart after screen grant",
        );
        ticks(4).await;
        assert!(h.restarts().is_empty());
        assert!(h.logs.lock().unwrap().contains(&"warn:screen-recording permission did not become granted before the watcher timed out; it is re-checked on focus.".to_string()));
        let watched = h.watcher.watched().unwrap();
        assert_eq!(watched.status, Denied);
        assert!(!watched.polling);
    }

    #[tokio::test]
    async fn a_newer_watch_replaces_an_older_one() {
        let h = harness(Denied, 50);
        h.watcher
            .watch(SystemPermissionPane::Camera, "restart after camera grant");
        h.watcher.watch(
            SystemPermissionPane::Microphone,
            "restart after microphone grant",
        );
        h.set(MediaAccessPermission::Camera, Granted);
        ticks(3).await;
        assert!(h.restarts().is_empty());
        assert_eq!(
            h.watcher.watched().unwrap().pane,
            SystemPermissionPane::Microphone
        );
    }

    #[tokio::test]
    async fn a_recheck_restarts_exactly_once_for_a_late_grant() {
        let h = harness(NotDetermined, 2);
        h.watcher.watch(
            SystemPermissionPane::ScreenRecording,
            "restart after screen grant",
        );
        ticks(4).await;
        assert!(h.restarts().is_empty());
        assert!(!h.watcher.recheck().await);
        h.set(MediaAccessPermission::Screen, Granted);
        assert!(h.watcher.recheck().await);
        assert_eq!(h.restarts(), ["restart after screen grant"]);
        assert!(!h.watcher.recheck().await);
        ticks(4).await;
        assert_eq!(h.restarts().len(), 1);
        assert!(h.logs.lock().unwrap().contains(
            &"info:screen-recording permission is now granted (noticed on re-check); requesting a capture backend restart.".to_string()
        ));
    }

    #[tokio::test]
    async fn a_recheck_never_restarts_for_granted_unwatched_or_stopped() {
        let h = harness(Granted, 2);
        assert!(!h.watcher.recheck().await);
        h.watcher
            .watch(SystemPermissionPane::Camera, "restart after camera grant");
        assert!(!h.watcher.recheck().await);
        assert!(h.restarts().is_empty());

        let stopped = harness(Denied, 2);
        stopped.watcher.watch(
            SystemPermissionPane::Microphone,
            "restart after microphone grant",
        );
        stopped.watcher.stop();
        stopped.set(MediaAccessPermission::Microphone, Granted);
        assert!(!stopped.watcher.recheck().await);
        ticks(3).await;
        assert!(stopped.restarts().is_empty());
    }

    #[tokio::test]
    async fn a_poll_and_a_recheck_for_one_grant_restart_once() {
        let h = harness(Denied, 50);
        h.watcher.watch(
            SystemPermissionPane::ScreenRecording,
            "restart after screen grant",
        );
        ticks(1).await;
        h.set(MediaAccessPermission::Screen, Granted);
        assert!(h.watcher.recheck().await);
        ticks(5).await;
        assert_eq!(h.restarts().len(), 1);
    }

    #[tokio::test]
    async fn privacy_is_never_watched() {
        let h = harness(Denied, 2);
        h.watcher
            .watch(SystemPermissionPane::Privacy, "restart after privacy");
        assert_eq!(h.watcher.watched(), None);
    }
}
