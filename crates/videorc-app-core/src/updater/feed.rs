//! The drivers that read the GPUI app's feed (plan 260 S5.2, L2).
//!
//! - [`FeedDriver`] (macOS; Windows once WC-4.3 brings its installer): one
//!   check of the feed (`videorc_updater::flow`), then the download of what
//!   it found, as Electron downloads what any check finds. The bytes are
//!   checked against the feed (size and SHA-512), then by the platform's own
//!   [`Installer::admit`] (on macOS: unpacked, and the app in it signed by
//!   Videorc's team for Videorc's bundle id, at the promised version). Only
//!   then is the update "ready". Restart & install hands the ready update to
//!   [`Installer::install`].
//! - [`LinuxNotice`]: Linux never updates itself; a check reads the public
//!   changelog and says whether a newer Linux release is out
//!   (`linux-update-notice.ts`).
//! - [`background_checks`]: the silent check at launch and the recheck
//!   every thirty minutes from a settled status (`initAutoUpdater`).
//!
//! The requests are the app's ([`Transport`], [`Fetch`]); checks run off
//! the window's thread ([`Spawn`]). Every status change and every failure's
//! reason go to the updater's log (`videorc_updater::log`), which the
//! support bundle reads; Settings never shows the reason itself.

use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use videorc_updater::feed::{UpdateInfo, Version};
use videorc_updater::flow::{Transport, UpdateFlow, UpdatePlatform};
use videorc_updater::linux_notice::{
    LinuxVersionCheck, evaluate_linux_changelog_text, linux_update_notice_status,
    linux_update_notice_url,
};
use videorc_updater::log::UpdaterLog;
use videorc_updater::mirror::UpdateFailure;
use videorc_updater::status::{
    BACKGROUND_RECHECK_INTERVAL_MS, UpdateStatus, should_auto_download, should_background_recheck,
};
use videorc_updater::windows_pilot::WindowsPilotUpdateGrant;

use super::{Reporter, Updater, UpdaterDriver};

/// What the platform does around the flow.
pub trait Installer: Send + Sync + 'static {
    /// The platform's own check of a download whose size and SHA-512 are
    /// the feed's. The update is ready only when it passes; a refusal is
    /// [`UpdateFailure::Signature`] (or [`UpdateFailure::Disk`]), and the
    /// installer logs its own detail.
    fn admit(&self, info: &UpdateInfo) -> Result<(), UpdateFailure>;
    /// Restart & install, for the update [`Self::admit`] passed. Called only
    /// when it is installable (downloaded, nothing records or streams).
    fn install(&self, info: &UpdateInfo);
}

/// Where a check runs: never on the window's thread, since the requests
/// and the download block.
pub type Spawn = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// Each check on a thread of its own.
pub fn own_thread() -> Spawn {
    Arc::new(|job: Box<dyn FnOnce() + Send>| {
        if let Err(error) = std::thread::Builder::new()
            .name("videorc-updater".to_string())
            .spawn(job)
        {
            eprintln!("[videorc-app] [updater] couldn't start a check: {error}");
        }
    })
}

/// The updater's last lines, shared with the support bundle.
pub type SharedLog = Arc<Mutex<UpdaterLog>>;

/// A log line for each status a streamer would see change. Progress is
/// left out: it would push every other line out.
fn note(log: &Mutex<UpdaterLog>, status: &UpdateStatus) {
    let mut log = log.lock().unwrap_or_else(PoisonError::into_inner);
    match status {
        UpdateStatus::Checking => log.info("checking for updates"),
        UpdateStatus::Available { version } => {
            log.info(&format!("update {version} is available; downloading"));
        }
        UpdateStatus::NotAvailable { current_version } => {
            log.info(&format!("no update: {current_version} is the latest"));
        }
        UpdateStatus::Downloaded { version } => {
            log.info(&format!(
                "update {version} is downloaded, checked and ready"
            ));
        }
        UpdateStatus::Error { message } => log.error(message),
        UpdateStatus::DownloadAvailable { version } => {
            log.info(&format!("a newer Linux release is published: {version}"));
        }
        UpdateStatus::Unsupported { reason } => {
            log.info(&format!("no update for this build ({reason:?})"));
        }
        UpdateStatus::Idle | UpdateStatus::Downloading { .. } => {}
    }
}

/// The GPUI app has no Windows pilot grant yet (WC-4.3): the pilot feed is
/// never asked.
fn no_pilot_grant() -> Option<WindowsPilotUpdateGrant> {
    None
}

/// One check, then the download of what it found, each status said as the
/// flow sets it.
fn check_and_download<T: Transport>(
    flow: &mut UpdateFlow<T>,
    installer: &dyn Installer,
    log: &Mutex<UpdaterLog>,
    reporter: &Reporter,
) {
    let mut on_status = |status: &UpdateStatus| {
        note(log, status);
        reporter.status(status.clone());
    };
    let mut grant = no_pilot_grant;
    flow.check_all_feeds(&mut grant, &mut on_status);
    if should_auto_download(flow.status()) {
        let mut admit = |info: &UpdateInfo| installer.admit(info);
        flow.download(&mut grant, &mut admit, &mut on_status);
    }
}

/// The feed's driver: [`UpdateFlow`] over the app's [`Transport`].
pub struct FeedDriver<T: Transport + Send + 'static> {
    flow: Arc<Mutex<UpdateFlow<T>>>,
    installer: Arc<dyn Installer>,
    log: SharedLog,
    spawn: Spawn,
}

impl<T: Transport + Send + 'static> FeedDriver<T> {
    /// `current` is this build's release version; `feed_file` the
    /// platform's (`latest-mac.yml`).
    pub fn new(
        transport: T,
        current: Version,
        platform: UpdatePlatform,
        feed_file: &'static str,
        installer: Arc<dyn Installer>,
        log: SharedLog,
        spawn: Spawn,
    ) -> Self {
        let flow = UpdateFlow::new(transport, current, platform, feed_file, None);
        Self {
            flow: Arc::new(Mutex::new(flow)),
            installer,
            log,
            spawn,
        }
    }
}

impl<T: Transport + Send + 'static> UpdaterDriver for FeedDriver<T> {
    fn check(&self, reporter: Reporter) {
        let flow = self.flow.clone();
        let installer = self.installer.clone();
        let log = self.log.clone();
        (self.spawn)(Box::new(move || {
            {
                let mut flow = flow.lock().unwrap_or_else(PoisonError::into_inner);
                check_and_download(&mut *flow, installer.as_ref(), &log, &reporter);
            }
            reporter.check_ended();
        }));
    }

    fn install(&self) {
        let ready = self
            .flow
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .found()
            .cloned();
        match ready {
            Some(info) => self.installer.install(&info),
            None => self
                .log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .warn("Restart to install found no update that is ready"),
        }
    }
}

/// A GET that answers the body, or `None` for anything else (offline, a
/// timeout, a status that isn't 2xx): the Linux notice says nothing then.
pub type Fetch = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Linux's notice: a check asks the public changelog.
pub struct LinuxNotice {
    source: String,
    running_version: String,
    fetch: Fetch,
    log: SharedLog,
    spawn: Spawn,
}

impl LinuxNotice {
    /// `source` is `linux_update_notice_source`'s answer.
    pub fn new(
        source: String,
        running_version: String,
        fetch: Fetch,
        log: SharedLog,
        spawn: Spawn,
    ) -> Self {
        Self {
            source,
            running_version,
            fetch,
            log,
            spawn,
        }
    }
}

impl UpdaterDriver for LinuxNotice {
    fn check(&self, reporter: Reporter) {
        let url = linux_update_notice_url(&self.source, &self.running_version);
        let running = self.running_version.clone();
        let fetch = self.fetch.clone();
        let log = self.log.clone();
        (self.spawn)(Box::new(move || {
            let check = match fetch(&url) {
                Some(body) => evaluate_linux_changelog_text(&body, &running),
                None => LinuxVersionCheck::Unknown,
            };
            let status = linux_update_notice_status(&check, &running);
            note(&log, &status);
            reporter.status(status);
            reporter.check_ended();
        }));
    }

    /// Linux downloads and installs nothing.
    fn install(&self) {}
}

/// The silent checks: one at launch, then one every thirty minutes
/// (`BACKGROUND_RECHECK_INTERVAL_MS`) while the status is settled
/// (`should_background_recheck`: never mid-check, mid-download or once an
/// update waits to install). Ends when the updater is gone.
pub async fn background_checks(updater: Weak<Updater>) {
    let every = Duration::from_millis(BACKGROUND_RECHECK_INTERVAL_MS);
    match updater.upgrade() {
        Some(live) => live.check(),
        None => return,
    }
    loop {
        tokio::time::sleep(every).await;
        let Some(live) = updater.upgrade() else {
            return;
        };
        if should_background_recheck(&live.status()) {
            live.check();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use videorc_updater::feed::{FeedFile, MACOS_FEED_FILE, sha512_base64};
    use videorc_updater::flow::FeedSource;
    use videorc_updater::mirror::FeedRoute;
    use videorc_updater::status::{UnsupportedReason, UpdaterEvent};

    use super::*;

    const PACKAGE: &[u8] = b"the new Videorc, zipped";

    /// A feed for `version` whose one file is `bytes`.
    fn feed(version: &str, bytes: &[u8]) -> String {
        format!(
            "version: {version}\nfiles:\n  - url: Videorc-{version}-mac-arm64.zip\n    sha512: {}\n    size: {}\npath: Videorc-{version}-mac-arm64.zip\n",
            sha512_base64(bytes),
            bytes.len()
        )
    }

    fn route(source: FeedSource<'_>) -> &'static str {
        match source {
            FeedSource::Public(FeedRoute::Primary) => "primary",
            FeedSource::Public(FeedRoute::Mirror) => "mirror",
            FeedSource::Pilot(_) => "pilot",
        }
    }

    /// A feed on fixtures: what each route answers, the bytes it serves,
    /// and what it was asked.
    #[derive(Default)]
    struct Fixture {
        primary: Option<Result<String, UpdateFailure>>,
        mirror: Option<Result<String, UpdateFailure>>,
        primary_download: Option<UpdateFailure>,
        package: Vec<u8>,
        asked: Arc<Mutex<Vec<String>>>,
    }

    impl Transport for Fixture {
        type Download = Cursor<Vec<u8>>;

        fn fetch_feed(
            &mut self,
            source: FeedSource<'_>,
            feed_file: &str,
        ) -> Result<String, UpdateFailure> {
            self.asked
                .lock()
                .unwrap()
                .push(format!("feed {} {feed_file}", route(source)));
            let answer = match source {
                FeedSource::Public(FeedRoute::Primary) => self.primary.clone(),
                FeedSource::Public(FeedRoute::Mirror) => self.mirror.clone(),
                FeedSource::Pilot(_) => None,
            };
            answer.unwrap_or(Err(UpdateFailure::Other))
        }

        fn download(
            &mut self,
            source: FeedSource<'_>,
            file: &FeedFile,
            progress: &mut dyn FnMut(f64),
        ) -> Result<Self::Download, UpdateFailure> {
            self.asked
                .lock()
                .unwrap()
                .push(format!("download {} {}", route(source), file.url));
            if let (FeedSource::Public(FeedRoute::Primary), Some(failure)) =
                (source, self.primary_download)
            {
                return Err(failure);
            }
            progress(50.0);
            progress(100.0);
            Ok(Cursor::new(self.package.clone()))
        }
    }

    /// The platform: what it admitted and installed, and a refusal.
    #[derive(Default)]
    struct Platform {
        refuse: Option<UpdateFailure>,
        admitted: Mutex<Vec<String>>,
        installed: Mutex<Vec<String>>,
    }

    impl Installer for Platform {
        fn admit(&self, info: &UpdateInfo) -> Result<(), UpdateFailure> {
            self.admitted.lock().unwrap().push(info.version.to_string());
            match self.refuse {
                Some(failure) => Err(failure),
                None => Ok(()),
            }
        }

        fn install(&self, info: &UpdateInfo) {
            self.installed
                .lock()
                .unwrap()
                .push(info.version.to_string());
        }
    }

    /// Runs each check at once, on the test's thread.
    fn inline() -> Spawn {
        Arc::new(|job: Box<dyn FnOnce() + Send>| job())
    }

    fn new_log() -> SharedLog {
        Arc::new(Mutex::new(UpdaterLog::new()))
    }

    fn lines(log: &SharedLog) -> Vec<String> {
        log.lock()
            .unwrap()
            .snapshot()
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    /// This build is 0.40.0 on macOS.
    fn updater(transport: Fixture, platform: Arc<Platform>) -> (Arc<Updater>, SharedLog) {
        let log = new_log();
        let driver = FeedDriver::new(
            transport,
            Version::parse("0.40.0").unwrap(),
            UpdatePlatform::MacOs,
            MACOS_FEED_FILE,
            platform,
            log.clone(),
            inline(),
        );
        (Updater::new(driver, UpdateStatus::Idle), log)
    }

    #[test]
    fn a_check_downloads_admits_and_installs_the_newer_release() {
        let platform = Arc::new(Platform::default());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (updater, log) = updater(
            Fixture {
                primary: Some(Ok(feed("0.41.0", PACKAGE))),
                package: PACKAGE.to_vec(),
                asked: asked.clone(),
                ..Fixture::default()
            },
            platform.clone(),
        );
        updater.check();
        assert_eq!(
            updater.status(),
            UpdateStatus::Downloaded {
                version: "0.41.0".into()
            }
        );
        assert_eq!(
            *asked.lock().unwrap(),
            vec![
                "feed primary latest-mac.yml".to_string(),
                "download primary Videorc-0.41.0-mac-arm64.zip".to_string(),
            ]
        );
        assert_eq!(*platform.admitted.lock().unwrap(), vec!["0.41.0"]);
        assert!(platform.installed.lock().unwrap().is_empty());
        assert!(!updater.install(true), "never mid-capture");
        assert!(updater.install(false));
        assert_eq!(*platform.installed.lock().unwrap(), vec!["0.41.0"]);
        assert!(
            lines(&log)
                .iter()
                .any(|line| line == "update 0.41.0 is downloaded, checked and ready")
        );
    }

    #[test]
    fn a_tampered_download_is_never_admitted_or_ready() {
        let platform = Arc::new(Platform::default());
        let (updater, log) = updater(
            Fixture {
                primary: Some(Ok(feed("0.41.0", PACKAGE))),
                package: b"something else, zipped".to_vec(),
                ..Fixture::default()
            },
            platform.clone(),
        );
        updater.check();
        assert!(matches!(updater.status(), UpdateStatus::Error { .. }));
        assert!(platform.admitted.lock().unwrap().is_empty());
        assert!(!updater.install(false));
        assert!(platform.installed.lock().unwrap().is_empty());
        assert!(
            lines(&log)
                .iter()
                .any(|line| line.contains("didn't match what was published"))
        );
    }

    #[test]
    fn an_update_the_platform_refuses_is_an_error_not_ready() {
        let platform = Arc::new(Platform {
            refuse: Some(UpdateFailure::Signature),
            ..Platform::default()
        });
        let (updater, log) = updater(
            Fixture {
                primary: Some(Ok(feed("0.41.0", PACKAGE))),
                package: PACKAGE.to_vec(),
                ..Fixture::default()
            },
            platform.clone(),
        );
        updater.check();
        assert!(matches!(updater.status(), UpdateStatus::Error { .. }));
        assert_eq!(*platform.admitted.lock().unwrap(), vec!["0.41.0"]);
        assert!(!updater.install(false));
        assert!(
            lines(&log)
                .iter()
                .any(|line| line.contains("isn't signed by Videorc"))
        );
    }

    #[test]
    fn an_unpublished_feed_says_this_build_does_not_update_itself() {
        // What the GPUI app reads until S5.2d's web route exists: a 404.
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (updater, _) = updater(
            Fixture {
                primary: Some(Err(UpdateFailure::MissingFeed)),
                mirror: Some(Ok(feed("0.41.0", PACKAGE))),
                asked: asked.clone(),
                ..Fixture::default()
            },
            Arc::new(Platform::default()),
        );
        updater.check();
        assert_eq!(updater.status(), UpdateStatus::Unsupported { reason: None });
        // A missing file is not the road: the mirror is not asked.
        assert_eq!(
            *asked.lock().unwrap(),
            vec!["feed primary latest-mac.yml".to_string()]
        );
    }

    #[test]
    fn a_blocked_primary_falls_back_to_the_mirror() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (updater, _) = updater(
            Fixture {
                primary: Some(Ok(feed("0.41.0", PACKAGE))),
                mirror: Some(Ok(feed("0.41.0", PACKAGE))),
                primary_download: Some(UpdateFailure::Transport),
                package: PACKAGE.to_vec(),
                asked: asked.clone(),
            },
            Arc::new(Platform::default()),
        );
        updater.check();
        assert_eq!(
            updater.status(),
            UpdateStatus::Downloaded {
                version: "0.41.0".into()
            }
        );
        assert_eq!(
            *asked.lock().unwrap(),
            vec![
                "feed primary latest-mac.yml".to_string(),
                "download primary Videorc-0.41.0-mac-arm64.zip".to_string(),
                "feed mirror latest-mac.yml".to_string(),
                "download mirror Videorc-0.41.0-mac-arm64.zip".to_string(),
            ]
        );
    }

    #[test]
    fn the_same_release_is_up_to_date_and_downloads_nothing() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (updater, _) = updater(
            Fixture {
                primary: Some(Ok(feed("0.40.0", PACKAGE))),
                package: PACKAGE.to_vec(),
                asked: asked.clone(),
                ..Fixture::default()
            },
            Arc::new(Platform::default()),
        );
        updater.check();
        assert_eq!(
            updater.status(),
            UpdateStatus::NotAvailable {
                current_version: "0.40.0".into()
            }
        );
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    fn linux(body: Option<&'static str>) -> Arc<Updater> {
        let fetch: Fetch = Arc::new(move |url: &str| {
            assert!(url.starts_with("https://www.videorc.com/api/changelog?since="));
            body.map(str::to_string)
        });
        let driver = LinuxNotice::new(
            "https://www.videorc.com/api/changelog".into(),
            "0.40.0".into(),
            fetch,
            new_log(),
            inline(),
        );
        Updater::new(driver, UpdateStatus::Idle)
    }

    #[test]
    fn linux_reads_the_changelog_and_never_installs() {
        let newer = linux(Some(
            r#"{"entries":[{"version":"0.41.0-beta.1","platforms":["linux"]},{"version":"0.40.0-beta.1","platforms":["linux"]}]}"#,
        ));
        newer.check();
        assert_eq!(
            newer.status(),
            UpdateStatus::DownloadAvailable {
                version: "0.41.0-beta.1".into()
            }
        );
        assert!(!newer.install(false));

        let offline = linux(None);
        offline.check();
        assert_eq!(
            offline.status(),
            UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown)
            }
        );
    }

    /// Counts checks and answers `answer`.
    struct Counting(Arc<Mutex<u32>>, UpdateStatus);

    impl UpdaterDriver for Counting {
        fn check(&self, reporter: Reporter) {
            *self.0.lock().unwrap() += 1;
            reporter.status(self.1.clone());
            reporter.check_ended();
        }

        fn install(&self) {}
    }

    #[tokio::test(start_paused = true)]
    async fn the_silent_checks_run_at_launch_and_every_half_hour_while_settled() {
        let checks = Arc::new(Mutex::new(0));
        let updater = Updater::new(
            Counting(
                checks.clone(),
                UpdateStatus::NotAvailable {
                    current_version: "0.40.0".into(),
                },
            ),
            UpdateStatus::Idle,
        );
        let silent = tokio::spawn(background_checks(Arc::downgrade(&updater)));
        tokio::task::yield_now().await;
        assert_eq!(*checks.lock().unwrap(), 1, "at launch");

        let half_hour = Duration::from_millis(BACKGROUND_RECHECK_INTERVAL_MS);
        tokio::time::sleep(half_hour + Duration::from_millis(1)).await;
        assert_eq!(*checks.lock().unwrap(), 2, "thirty minutes on");

        // An update that waits to install stops them.
        updater.on_event(UpdaterEvent::Downloaded {
            version: "0.41.0".into(),
        });
        tokio::time::sleep(half_hour).await;
        assert_eq!(*checks.lock().unwrap(), 2);

        // They end with the updater.
        drop(updater);
        tokio::time::sleep(half_hour).await;
        assert!(silent.is_finished());
    }
}
