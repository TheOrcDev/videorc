//! The updater in the app (plan 260, L4): the core's [`Updater`] for the
//! sidebar's update chip (P021) and Settings → About's update row (P1430,
//! P1431). The window redraws when the status changes, so both read it as
//! they draw.
//!
//! The build runs [`NoFeed`] until the feed lands (plan 260 S5.2, L2): no
//! request, no download, and the row says this build doesn't update itself.

use std::sync::Arc;

use gpui::{App, Global};
use videorc_app_core::studio::scenes_section::session_active;
use videorc_app_core::updater::{NoFeed, UpdateStatus, Updater};
use videorc_app_core::{BackendClient, Studio};

/// What the chip and the row reach the updater through.
#[derive(Clone)]
pub struct Shared {
    pub updater: Arc<Updater>,
    pub studio: Arc<Studio<BackendClient>>,
}

impl Global for Shared {}

/// The app's updater: this build's driver, and what it says before its
/// first check (a build that can't update says so at once, as Electron's
/// unpackaged builds do).
pub fn start() -> Arc<Updater> {
    Updater::new(NoFeed, UpdateStatus::Unsupported { reason: None })
}

/// Makes the updater reachable from the chip and Settings, and redraws the
/// windows when its status changes.
pub fn install(cx: &mut App, updater: Arc<Updater>, studio: Arc<Studio<BackendClient>>) {
    let mut status = updater.watch();
    cx.set_global(Shared { updater, studio });
    cx.spawn(async move |cx| {
        while status.changed().await.is_ok() {
            cx.update(|cx| cx.refresh_windows());
        }
    })
    .detach();
}

/// The status now; unsupported before the updater is installed.
pub fn status(cx: &App) -> UpdateStatus {
    cx.try_global::<Shared>()
        .map(|shared| shared.updater.status())
        .unwrap_or(UpdateStatus::Unsupported { reason: None })
}

/// Whether Videorc records or is on air (or starts or stops): an update
/// never installs then.
pub fn capture_active(cx: &App) -> bool {
    cx.try_global::<Shared>()
        .is_some_and(|shared| session_active(&shared.studio.snapshot()))
}

/// Check for updates, Check again, Try again.
pub fn check(cx: &mut App) {
    if let Some(shared) = cx.try_global::<Shared>() {
        shared.updater.check();
    }
}

/// Restart & install, and the chip's Restart to update.
pub fn install_update(cx: &mut App) {
    let capture = capture_active(cx);
    if let Some(shared) = cx.try_global::<Shared>() {
        shared.updater.install(capture);
    }
}
