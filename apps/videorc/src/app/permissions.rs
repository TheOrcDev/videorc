//! Camera, microphone and screen permissions, and Reopen Videorc (plan 260
//! S2.6a part 3): the app's half of the core's
//! `desktop::{permissions, grant_watch, permission_restart}`, as
//! videorc-rust's `desktop/permissions.rs` runs them, with the OS calls
//! behind [`crate::platform`].
//!
//! - **The grants** are read and asked for through the platform:
//!   AVFoundation and CoreGraphics on macOS; `unknown` / `not-applicable`
//!   elsewhere, by name. The core asks only a never-asked computer; a
//!   denial's only door is System Settings.
//! - **A fresh grant** restarts the backend once (the supervisor's restart
//!   under the backend's interruption lease), deferred while capture is
//!   active or unknown and run when it goes idle. The grant watcher notices
//!   a grant made in System Settings; the main window coming to the front
//!   re-checks it.
//! - **Reopen Videorc** quits the normal way (the backend stops) and, after
//!   the shutdown, starts the app again with this launch's arguments
//!   ([`RELAUNCHED_ARG`] added, the links left out), refused while a session
//!   runs. The new process waits for this one's single-instance lock.
//!
//! Settings → Permissions, setup and the Sources page's alerts call
//! [`Permissions::request`], [`Permissions::open_settings`] and
//! [`Permissions::relaunch`] when they land (Phase 3); until then the
//! launch log, the watcher and the deferred restart run on their own.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{App, Task};
use tokio::runtime::Handle;
use tokio::sync::watch;
use videorc_app_core::desktop::capture_state::MainCaptureState;
use videorc_app_core::desktop::grant_watch::{
    DEFAULT_INTERVAL, DEFAULT_MAX_CHECKS, GrantWatcher, WatchLog,
};
use videorc_app_core::desktop::permission_restart::{PermissionRestarts, SupervisorRestarter};
use videorc_app_core::desktop::permissions::{
    MediaAccessDeps, MediaAccessPermission, MediaAccessRestartResult, MediaAccessSnapshot,
    MediaAccessStatus, MediaPane, PermissionFuture, PermissionPlatform, RelaunchRefusal,
    SystemPermissionPane, pane_restart_reason, permission_shortcut_supported,
    permission_url_for_pane, relaunch_args, request_media_access_with_restart,
    request_screen_access_with_watch,
};
use videorc_app_core::desktop::system_access::copy;
use videorc_app_core::interruption::LoopbackHttp;
use videorc_app_core::supervisor::SupervisorRestart;
use videorc_app_core::{Level, Logger};

use crate::platform;

/// What Reopen Videorc starts the new process with: it waits for this
/// one's single-instance lock (`single_instance::acquire_after_relaunch`)
/// instead of handing its links to the instance that is going away.
pub const RELAUNCHED_ARG: &str = "--relaunched";

/// The grants, the watcher, the deferred restart and Reopen Videorc.
pub struct Permissions {
    platform: PermissionPlatform,
    restarts: Arc<PermissionRestarts>,
    watcher: GrantWatcher,
    runtime: Handle,
    logger: Logger,
    /// Reopen Videorc was admitted: the app starts again after the shutdown.
    relaunch: AtomicBool,
}

impl Permissions {
    /// Sets everything up on the core's runtime: the deferred restart
    /// follows main's capture state from here on.
    pub fn install(
        runtime: &Handle,
        restart: SupervisorRestart,
        mut capture: watch::Receiver<MainCaptureState>,
        logger: Logger,
    ) -> Arc<Self> {
        let log: WatchLog = {
            let logger = logger.clone();
            Arc::new(move |level, message| logger.log(level, &format!("[permissions] {message}")))
        };
        let restarts = Arc::new(PermissionRestarts::new(
            Arc::new(SupervisorRestarter {
                restart,
                transport: Arc::new(LoopbackHttp),
            }),
            log.clone(),
        ));
        let watcher = {
            let restarts = restarts.clone();
            GrantWatcher::new(
                Arc::new(|permission: MediaAccessPermission| {
                    platform::current().media_access(permission)
                }),
                Arc::new(move |reason| {
                    let restarts = restarts.clone();
                    Box::pin(async move { restarts.request(reason).await.map(|_| ()) })
                }),
                log,
                DEFAULT_INTERVAL,
                DEFAULT_MAX_CHECKS,
            )
        };
        let permissions = Arc::new(Self {
            platform: PermissionPlatform::current(),
            restarts,
            watcher,
            runtime: runtime.clone(),
            logger,
            relaunch: AtomicBool::new(false),
        });
        permissions.log_launch_grant();

        // A restart a grant asked for while capture was busy runs once
        // capture is idle.
        let follower = permissions.clone();
        runtime.spawn(async move {
            loop {
                let state = *capture.borrow_and_update();
                if let Some(reason) = follower.restarts.capture_changed(state) {
                    let runner = follower.clone();
                    tokio::spawn(async move {
                        if let Err(error) = runner.restarts.run(reason).await {
                            runner.logger.warn(format!(
                                "[permissions] Could not run the deferred permission restart: {error}"
                            ));
                        }
                    });
                }
                if capture.changed().await.is_err() {
                    break;
                }
            }
        });
        permissions
    }

    /// The grant now, `unknown` (logged) when it can't be read.
    fn status(&self, permission: MediaAccessPermission) -> MediaAccessStatus {
        platform::current()
            .media_access(permission)
            .unwrap_or_else(|error| {
                self.logger.warn(format!(
                    "[permissions] Could not read {} access status: {error}",
                    permission.as_str()
                ));
                MediaAccessStatus::Unknown
            })
    }

    /// The OS's exact grants, for the permission rows and the Clips ring.
    #[allow(dead_code)]
    pub fn snapshot(&self) -> MediaAccessSnapshot {
        MediaAccessSnapshot {
            camera: self.status(MediaAccessPermission::Camera),
            microphone: self.status(MediaAccessPermission::Microphone),
            screen: self.status(MediaAccessPermission::Screen),
        }
    }

    /// `primeScreenCapturePermission`: launch only logs the screen grant.
    fn log_launch_grant(&self) {
        if self.platform != PermissionPlatform::MacOs {
            return;
        }
        match platform::current().media_access(MediaAccessPermission::Screen) {
            Ok(MediaAccessStatus::Granted) => {}
            Ok(status) => {
                let asked = status != MediaAccessStatus::NotDetermined;
                self.logger.log(
                    if asked { Level::Warn } else { Level::Info },
                    &format!(
                        "[permissions] Screen Recording permission is {} for Videorc; capture runs in videorc-backend. {}",
                        status.as_str(),
                        if asked {
                            "Grant it in System Settings."
                        } else {
                            "Setup asks in place."
                        }
                    ),
                );
            }
            Err(error) => self.logger.warn(format!(
                "[permissions] Could not read Screen Recording permission: {error}"
            )),
        }
    }

    /// `handleSystemPermission`'s prompt: the OS's own camera or microphone
    /// prompt, or the screen asked in place (plan 203 S2). True when the
    /// grant is there now; a fresh one restarts the backend once.
    #[allow(dead_code)]
    pub fn request(
        self: &Arc<Self>,
        cx: &App,
        pane: SystemPermissionPane,
    ) -> Task<Result<bool, String>> {
        let permissions = self.clone();
        let job = self.runtime.spawn(async move {
            let deps: &dyn MediaAccessDeps = &*permissions;
            match pane {
                SystemPermissionPane::Camera => {
                    request_media_access_with_restart(deps, MediaPane::Camera)
                        .await
                        .map(|result| result.granted)
                }
                SystemPermissionPane::Microphone => {
                    request_media_access_with_restart(deps, MediaPane::Microphone)
                        .await
                        .map(|result| result.granted)
                }
                SystemPermissionPane::ScreenRecording => {
                    request_screen_access_with_watch(deps, permissions.platform)
                        .await
                        .map(|result| result.granted)
                }
                SystemPermissionPane::Privacy => {
                    Err("The privacy pane has no prompt; open System Settings.".to_string())
                }
            }
        });
        cx.spawn(async move |_| job.await.map_err(|error| error.to_string())?)
    }

    /// `openSystemPermissions`: the OS settings page for `pane`, the grant
    /// watched from now (opening it is navigation, never a grant).
    #[allow(dead_code)]
    pub fn open_settings(&self, cx: &App, pane: SystemPermissionPane) -> Result<(), String> {
        permission_shortcut_supported(self.platform)?;
        {
            // The watcher's polling task runs on the core's runtime.
            let _runtime = self.runtime.enter();
            self.watcher.watch(pane, &pane_restart_reason(pane));
        }
        cx.open_url(permission_url_for_pane(pane, self.platform));
        Ok(())
    }

    /// `recheckPermissionGrants`: the main window came to the front, maybe
    /// from System Settings with the grant made.
    pub fn recheck(self: &Arc<Self>) {
        let permissions = self.clone();
        self.runtime.spawn(async move {
            permissions.watcher.recheck().await;
        });
    }

    /// Reopen Videorc: refused while a session runs (or isn't known to be
    /// idle) and when the backend won't admit it; otherwise the app quits
    /// the normal way and [`Self::relaunch_if_requested`] starts it again.
    /// True when the quit is under way.
    #[allow(dead_code)]
    pub fn relaunch(self: &Arc<Self>, cx: &App) -> Task<Result<bool, String>> {
        let permissions = self.clone();
        let job = self.runtime.spawn(async move {
            let flag = &permissions.relaunch;
            permissions
                .restarts
                .relaunch(|| flag.store(true, Ordering::SeqCst))
                .await
        });
        let logger = self.logger.clone();
        cx.spawn(async move |cx| {
            let result = job.await.map_err(|error| error.to_string())??;
            if result.relaunched {
                eprintln!("[videorc-app] reopening Videorc after a permission grant");
                cx.update(|cx| cx.quit());
                return Ok(true);
            }
            // The toast lands with the toast layer; its words are logged now.
            logger.warn(format!(
                "[permissions] {}: {}",
                copy::RELAUNCH_REFUSED_TITLE,
                if result.reason == Some(RelaunchRefusal::BackendBusy) {
                    copy::RELAUNCH_REFUSED_BUSY
                } else {
                    copy::RELAUNCH_REFUSED_CAPTURE_ACTIVE
                }
            ));
            Ok(false)
        })
    }

    /// After the shutdown: when Reopen Videorc was admitted, the app starts
    /// again with this launch's arguments (the links and any old marker left
    /// out, [`RELAUNCHED_ARG`] added) and environment.
    pub fn relaunch_if_requested(&self) {
        if !self.relaunch.load(Ordering::SeqCst) {
            return;
        }
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(error) => {
                eprintln!("[videorc-app] cannot reopen Videorc: {error}");
                return;
            }
        };
        let mut args: Vec<_> = relaunch_args(&std::env::args_os().skip(1).collect::<Vec<_>>())
            .into_iter()
            .filter(|arg| arg != RELAUNCHED_ARG)
            .collect();
        args.push(RELAUNCHED_ARG.into());
        match std::process::Command::new(&exe).args(&args).spawn() {
            Ok(child) => eprintln!(
                "[videorc-app] reopened Videorc as pid {} ({})",
                child.id(),
                exe.display()
            ),
            Err(error) => eprintln!("[videorc-app] cannot reopen Videorc: {error}"),
        }
    }
}

/// What the core's request flows need: the platform's grants and prompts,
/// the watcher, and the restart.
impl MediaAccessDeps for Permissions {
    fn get_status(&self, permission: MediaAccessPermission) -> Result<MediaAccessStatus, String> {
        platform::current().media_access(permission)
    }

    fn ask_for_access(&self, pane: MediaPane) -> PermissionFuture<'_, Result<bool, String>> {
        platform::current().ask_media_access(pane)
    }

    fn request_screen_access(&self) -> PermissionFuture<'_, Result<(), String>> {
        let requested = platform::current().request_screen_access();
        Box::pin(async move { requested })
    }

    fn watch_grant(&self, pane: SystemPermissionPane, reason: &str) {
        self.watcher.watch(pane, reason);
    }

    fn restart_backend(
        &self,
        reason: String,
    ) -> PermissionFuture<'_, Result<MediaAccessRestartResult, String>> {
        Box::pin(self.restarts.request(reason))
    }

    fn stop_grant_watcher(&self) {
        self.watcher.stop();
    }

    fn log(&self, level: Level, message: String) {
        self.logger.log(level, &format!("[permissions] {message}"));
    }
}
