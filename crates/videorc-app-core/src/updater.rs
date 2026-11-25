//! The updater in the app (plan 260, L4): one status for the sidebar's chip
//! (P021) and Settings → About's update row (P1430, P1431), the requests
//! they make, and the rules of `videorc-updater` they read.
//!
//! - [`Updater`] holds the status (Electron's `UpdateStatus`) and turns the
//!   updater's events into it (`updateStatusFromEvent`); a check that ends
//!   while it still says checking settles as unsupported
//!   (`settleStatusAfterCheck`).
//! - Check (Check for updates, Check again, Try again) and Restart & install
//!   go to an [`UpdaterDriver`], which does the work and reports back through
//!   a [`Reporter`]. Install asks only when the update is downloaded and
//!   nothing records or streams (`isUpdateInstallable`); the driver still
//!   takes the backend's interruption lease before it quits
//!   (`videorc_updater::install`).
//! - [`feed`] is the driver that reads the GPUI app's feed (plan 260 S5.2):
//!   a check, the download it starts, and the platform's own check before
//!   "ready"; and on Linux the changelog notice. A build that can't update
//!   itself (a dev run, a Windows build until WC-4.3) runs [`NoFeed`]: it
//!   reaches no server, downloads nothing, and every check answers that this
//!   build doesn't update itself.

use std::sync::{Arc, Weak};

pub mod feed;

/// The update rules crate, for the app's platform halves (the transport,
/// the macOS install and its helper).
pub use videorc_updater as rules;

use tokio::sync::watch;

pub use videorc_updater::about_view::{
    UPDATE_INSTALL_BLOCKED, UpdateRowControl, UpdateRowView, update_row_view,
};
pub use videorc_updater::chip::{
    ChipAction, ChipTone, UpdateChip, is_update_installable, update_chip,
};
pub use videorc_updater::status::{
    UnsupportedReason, UpdateReadyNotification, UpdateStatus, UpdaterEvent,
    settle_status_after_check, update_ready_notification, update_status_from_event,
};

/// Settings → About's words around the row.
pub mod copy {
    /// The row's label.
    pub const UPDATES: &str = "Updates";
    /// The error alert's one action.
    pub const TRY_AGAIN: &str = "Try again";
    /// The progress bar's name.
    pub const UPDATE_DOWNLOAD: &str = "Update download";
    /// The checking button.
    pub const CHECKING: &str = "Checking…";
}

/// Where the updater's events go: the [`Updater`] that asked.
#[derive(Clone)]
pub struct Reporter(Weak<Updater>);

impl Reporter {
    /// An updater event (checking, available, progress, downloaded, …).
    pub fn event(&self, event: UpdaterEvent) {
        if let Some(updater) = self.0.upgrade() {
            updater.on_event(event);
        }
    }

    /// The status as the update flow set it (the flow keeps its own copy
    /// and says each one it sets).
    pub fn status(&self, status: UpdateStatus) {
        if let Some(updater) = self.0.upgrade() {
            updater.set_status(status);
        }
    }

    /// The check is over; a status still on "checking" settles.
    pub fn check_ended(&self) {
        if let Some(updater) = self.0.upgrade() {
            updater.check_ended();
        }
    }
}

/// What checks, downloads and installs: [`feed::FeedDriver`],
/// [`feed::LinuxNotice`] or [`NoFeed`].
pub trait UpdaterDriver: Send + Sync + 'static {
    /// One check (and, when one is available, its download), reported
    /// through `reporter`, ending with [`Reporter::check_ended`].
    fn check(&self, reporter: Reporter);
    /// Quit and install the downloaded update. Called only when it is
    /// installable.
    fn install(&self);
}

/// A build with no feed yet: no request, no download, and every check says
/// this build doesn't update itself.
pub struct NoFeed;

impl UpdaterDriver for NoFeed {
    fn check(&self, reporter: Reporter) {
        reporter.event(UpdaterEvent::Unsupported { reason: None });
        reporter.check_ended();
    }

    fn install(&self) {}
}

/// The app's updater: its status, and the requests the chip and Settings
/// make.
pub struct Updater {
    me: Weak<Updater>,
    status: watch::Sender<UpdateStatus>,
    driver: Box<dyn UpdaterDriver>,
}

impl Updater {
    /// `initial` is what the build says before its first check (a build
    /// that can't update says so at once).
    pub fn new(driver: impl UpdaterDriver, initial: UpdateStatus) -> Arc<Self> {
        let (status, _) = watch::channel(initial);
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            status,
            driver: Box::new(driver),
        })
    }

    /// The status, as it changes.
    pub fn watch(&self) -> watch::Receiver<UpdateStatus> {
        self.status.subscribe()
    }

    /// The status now.
    pub fn status(&self) -> UpdateStatus {
        self.status.borrow().clone()
    }

    /// An updater event becomes the status (`updateStatusFromEvent`, as
    /// `updater.ts` sets it: a download's progress names no version).
    pub fn on_event(&self, event: UpdaterEvent) {
        self.status.send_if_modified(|status| {
            let next = update_status_from_event(event);
            let changed = *status != next;
            *status = next;
            changed
        });
    }

    fn set_status(&self, next: UpdateStatus) {
        self.status.send_if_modified(|status| {
            let changed = *status != next;
            *status = next;
            changed
        });
    }

    fn check_ended(&self) {
        self.status.send_if_modified(|status| {
            let settled = settle_status_after_check(status.clone());
            let changed = *status != settled;
            *status = settled;
            changed
        });
    }

    /// Check for updates, Check again, Try again. Nothing while a check or a
    /// download runs, or once an update waits to install.
    pub fn check(&self) {
        if matches!(
            self.status(),
            UpdateStatus::Checking
                | UpdateStatus::Downloading { .. }
                | UpdateStatus::Downloaded { .. }
        ) {
            return;
        }
        self.on_event(UpdaterEvent::Checking);
        self.driver.check(Reporter(self.me.clone()));
    }

    /// Restart & install, or the chip's Restart to update. `false` when the
    /// update isn't installable now (not downloaded, or a capture runs).
    pub fn install(&self, capture_active: bool) -> bool {
        if !is_update_installable(&self.status(), capture_active) {
            return false;
        }
        self.driver.install();
        true
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A driver that answers from a script and records installs.
    #[derive(Default)]
    struct Fixture {
        script: Mutex<Vec<UpdaterEvent>>,
        installs: Mutex<u32>,
        checks: Mutex<u32>,
    }

    impl UpdaterDriver for Arc<Fixture> {
        fn check(&self, reporter: Reporter) {
            *self.checks.lock().unwrap() += 1;
            for event in self.script.lock().unwrap().drain(..) {
                reporter.event(event);
            }
            reporter.check_ended();
        }

        fn install(&self) {
            *self.installs.lock().unwrap() += 1;
        }
    }

    fn updater(script: Vec<UpdaterEvent>) -> (Arc<Updater>, Arc<Fixture>) {
        let fixture = Arc::new(Fixture {
            script: Mutex::new(script),
            ..Fixture::default()
        });
        (Updater::new(fixture.clone(), UpdateStatus::Idle), fixture)
    }

    #[test]
    fn no_feed_says_this_build_does_not_update_itself() {
        let updater = Updater::new(NoFeed, UpdateStatus::Idle);
        updater.check();
        assert_eq!(updater.status(), UpdateStatus::Unsupported { reason: None });
        assert!(matches!(
            update_row_view(&updater.status(), false),
            UpdateRowView::Row {
                control: Some(UpdateRowControl::Link {
                    page: "download",
                    ..
                }),
                ..
            }
        ));
        assert_eq!(update_chip(&updater.status(), false), None);
        assert!(!updater.install(false));
    }

    #[test]
    fn a_check_downloads_and_the_chip_and_row_follow() {
        let (updater, fixture) = updater(vec![
            UpdaterEvent::Available {
                version: "1.2.0".into(),
            },
            UpdaterEvent::Progress { percent: 41.6 },
        ]);
        updater.check();
        assert_eq!(
            updater.status(),
            UpdateStatus::Downloading {
                percent: 42,
                version: None
            }
        );
        let chip = update_chip(&updater.status(), false).unwrap();
        assert_eq!(chip.label, "Downloading… 42%");
        assert_eq!(chip.detail, "Downloading update… 42%");
        // A check while it downloads does nothing.
        updater.check();
        assert_eq!(*fixture.checks.lock().unwrap(), 1);
        updater.on_event(UpdaterEvent::Downloaded {
            version: "1.2.0".into(),
        });
        assert_eq!(
            update_chip(&updater.status(), false).map(|chip| chip.action),
            Some(ChipAction::Install)
        );
        assert!(!updater.install(true), "never mid-capture");
        assert_eq!(*fixture.installs.lock().unwrap(), 0);
        assert!(updater.install(false));
        assert_eq!(*fixture.installs.lock().unwrap(), 1);
    }

    #[test]
    fn a_failed_check_shows_the_calm_alert_and_try_again_checks() {
        let (updater, fixture) = updater(vec![UpdaterEvent::Error {
            message: "HTTP 503 https://example.invalid/feed".into(),
        }]);
        updater.check();
        match update_row_view(&updater.status(), false) {
            UpdateRowView::Error { title, description } => {
                assert_eq!(title, "Couldn't check for updates");
                assert!(!description.contains("503"));
            }
            other => panic!("{other:?}"),
        }
        updater.check();
        assert_eq!(*fixture.checks.lock().unwrap(), 2);
    }

    #[test]
    fn a_check_with_no_answer_settles() {
        let (updater, _) = updater(Vec::new());
        updater.check();
        assert_eq!(updater.status(), UpdateStatus::Unsupported { reason: None });
    }

    #[test]
    fn up_to_date_offers_check_again() {
        let (updater, _) = updater(vec![UpdaterEvent::NotAvailable {
            current_version: "1.0.0".into(),
        }]);
        updater.check();
        assert_eq!(
            update_row_view(&updater.status(), false),
            UpdateRowView::Row {
                description: "You're on the latest version (1.0.0).".into(),
                control: Some(UpdateRowControl::Check {
                    label: "Check again"
                }),
            }
        );
    }
}
