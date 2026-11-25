//! The GPUI app's update feed (plan 260 S5.2, L2): the requests, the macOS
//! install and its helper, and which driver each build runs.
//!
//! - **macOS:** an installed build (or a rehearsal pointed at a feed on this
//!   computer, `VIDEORC_UPDATE_FEED_URL`) reads the GPUI app's own feed
//!   (`second_feed`, P5-D6). It checks at launch and every thirty minutes
//!   (`VIDEORC_DISABLE_AUTO_UPDATE=1` leaves only Check for updates),
//!   downloads what it finds, checks the bytes against the feed, unpacks
//!   the zip and checks the app in it: signed by Videorc's team for
//!   Videorc's bundle id, at the promised version. Only then is it ready.
//!   At quit, or at Restart & install (under the backend's interruption
//!   lease), the app starts itself as the helper
//!   (`macos_apply::APPLY_UPDATE_FLAG`), which waits for the app to be gone,
//!   checks the new app once more and swaps it in; a failed swap leaves the
//!   old app where it was. The helper's outcome is read at the next launch.
//! - **Linux:** the changelog notice; nothing is downloaded.
//! - **Windows:** doesn't update itself yet: the installer's run is
//!   WC-4.3's. Settings says so and links to the downloads page.
//!
//! A copy that can't be replaced where it is (run from the disk image, or
//! from a folder this account can't change) checks nothing and says it
//! doesn't update itself; the reason goes to the log.

#[cfg(target_os = "macos")]
pub use mac::{apply_at_quit, quit_requests, run_helper_if_asked};

use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::runtime::Handle;
use videorc_app_core::log::Logger;
use videorc_app_core::supervisor::SupervisorRestart;
use videorc_app_core::updater::feed::SharedLog;
use videorc_app_core::updater::rules::log::{UpdaterLog, UpdaterLogLevel};
use videorc_app_core::updater::{NoFeed, UpdateStatus, Updater};

/// The updater's own log, its lines also in the app log.
fn updater_log(logger: &Logger) -> SharedLog {
    let mut log = UpdaterLog::new();
    let sink = logger.clone();
    log.set_sink(Box::new(
        move |level: UpdaterLogLevel, line: &str| -> std::io::Result<()> {
            let line = format!("[updater] {line}");
            match level {
                UpdaterLogLevel::Info => sink.info(line),
                UpdaterLogLevel::Warn => sink.warn(line),
                UpdaterLogLevel::Error => sink.error(line),
            }
            Ok(())
        },
    ));
    Arc::new(Mutex::new(log))
}

/// A build that doesn't update itself, and says so at once.
fn no_feed() -> Arc<Updater> {
    Updater::new(NoFeed, UpdateStatus::Unsupported { reason: None })
}

/// The app's updater: this build's driver, and its silent checks.
/// `packaged` is an installed release build (`smoke::shell::packaged`).
#[cfg(target_os = "macos")]
pub fn start(
    runtime: &Handle,
    user_data_dir: &Path,
    restart: SupervisorRestart,
    packaged: bool,
    logger: &Logger,
) -> Arc<Updater> {
    mac::start(
        runtime,
        user_data_dir,
        restart,
        packaged,
        updater_log(logger),
    )
}

/// The app's updater: the changelog notice.
#[cfg(target_os = "linux")]
pub fn start(
    runtime: &Handle,
    _user_data_dir: &Path,
    _restart: SupervisorRestart,
    packaged: bool,
    logger: &Logger,
) -> Arc<Updater> {
    linux::start(runtime, packaged, updater_log(logger))
}

/// The app's updater: none yet (the Windows installer's run is WC-4.3).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn start(
    _runtime: &Handle,
    _user_data_dir: &Path,
    _restart: SupervisorRestart,
    _packaged: bool,
    logger: &Logger,
) -> Arc<Updater> {
    updater_log(logger)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .info("this build doesn't update itself yet (the Windows installer's run is WC-4.3)");
    no_feed()
}

/// The version this build is released as: the running app's own
/// `CFBundleShortVersionString` (the packaging sets it).
#[cfg(target_os = "macos")]
fn running_version() -> String {
    use videorc_app_core::updater::rules::macos_install::{bundle_of_executable, bundle_version};
    std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_of_executable(&exe))
        .and_then(|bundle| bundle_version(&bundle))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

/// The version this build is released as (the packaging sets the crate's).
#[cfg(target_os = "linux")]
fn running_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::runtime::Handle;
    use videorc_app_core::updater::feed::{
        Fetch, LinuxNotice, SharedLog, background_checks, own_thread,
    };
    use videorc_app_core::updater::rules::launch::{
        LaunchFacts, LaunchPlan, UpdaterHost, launch_plan,
    };
    use videorc_app_core::updater::rules::linux_notice::{
        LINUX_UPDATE_NOTICE_TIMEOUT_MS, LINUX_UPDATE_NOTICE_URL_ENV, linux_update_notice_source,
    };
    use videorc_app_core::updater::rules::windows_pilot::DISABLE_AUTO_UPDATE_ENV;
    use videorc_app_core::updater::{UpdateStatus, Updater};

    /// The changelog's answer is small; anything bigger is not it.
    const CHANGELOG_MAX_BYTES: usize = 1024 * 1024;

    pub fn start(runtime: &Handle, packaged: bool, log: SharedLog) -> Arc<Updater> {
        let override_url = std::env::var(LINUX_UPDATE_NOTICE_URL_ENV).ok();
        let source = linux_update_notice_source(override_url.as_deref(), packaged);
        let facts = LaunchFacts {
            host: UpdaterHost::Linux,
            packaged,
            background_disabled: std::env::var(DISABLE_AUTO_UPDATE_ENV).as_deref() == Ok("1"),
            pilot_config_refused: false,
            linux_notice_source: source.is_some(),
        };
        let plan = launch_plan(&facts);
        let Some(source) = source else {
            return super::no_feed();
        };
        let initial = match plan {
            LaunchPlan::Unsupported { reason } => UpdateStatus::Unsupported { reason },
            _ => UpdateStatus::Idle,
        };
        let driver = LinuxNotice::new(
            source,
            super::running_version(),
            fetch(runtime.clone()),
            log,
            own_thread(),
        );
        let updater = Updater::new(driver, initial);
        if plan == LaunchPlan::Background {
            runtime.spawn(background_checks(Arc::downgrade(&updater)));
        }
        updater
    }

    /// One GET on the app's runtime, from the check's own thread.
    fn fetch(runtime: Handle) -> Fetch {
        Arc::new(move |url: &str| {
            let url = url.to_string();
            runtime.block_on(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_millis(LINUX_UPDATE_NOTICE_TIMEOUT_MS))
                    .build()
                    .ok()?;
                let mut response = client.get(&url).send().await.ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.ok()? {
                    if bytes.len() + chunk.len() > CHANGELOG_MAX_BYTES {
                        return None;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                String::from_utf8(bytes).ok()
            })
        })
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::OsString;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock, PoisonError};
    use std::time::Duration;

    use tokio::runtime::Handle;
    use tokio::sync::watch;
    use videorc_app_core::desktop::permission_restart::{BackendRestarter, SupervisorRestarter};
    use videorc_app_core::interruption::{
        InterruptionAction, LoopbackHttp, run_interrupting_action,
    };
    use videorc_app_core::supervisor::SupervisorRestart;
    use videorc_app_core::updater::feed::{
        FeedDriver, Installer, SharedLog, background_checks, own_thread,
    };
    use videorc_app_core::updater::rules::feed::{
        FeedFile, MACOS_FEED_FILE, UpdateInfo, Version, file_url,
    };
    use videorc_app_core::updater::rules::flow::{FeedSource, Transport, UpdatePlatform};
    use videorc_app_core::updater::rules::launch::{
        LaunchFacts, LaunchPlan, UpdaterHost, launch_plan,
    };
    use videorc_app_core::updater::rules::macos_apply::{ApplyPlan, MacSystem, apply_update};
    use videorc_app_core::updater::rules::macos_install::{
        PrepareFailure, bundle_of_executable, install_location_refusal, prepare_update,
        staging_root,
    };
    use videorc_app_core::updater::rules::mirror::UpdateFailure;
    use videorc_app_core::updater::rules::second_feed::{
        FeedBases, UPDATE_FEED_URL_ENV, feed_bases,
    };
    use videorc_app_core::updater::rules::signature::{SigningIdentity, verify_videorc_bundle};
    use videorc_app_core::updater::rules::windows_pilot::DISABLE_AUTO_UPDATE_ENV;
    use videorc_app_core::updater::{UpdateStatus, Updater};

    /// Videorc's Developer ID team, as the release lanes sign with it.
    const TEAM_ID: &str = "C2PA37RB58";
    /// Where the helper writes what became of the install, for the next
    /// launch's log.
    const HELPER_LOG_ENV: &str = "VIDEORC_UPDATE_HELPER_LOG";
    /// Electron's reason for the lease.
    const INSTALL_REASON: &str = "Installing a downloaded Videorc update.";
    /// The feed file is small; anything bigger is not it.
    const FEED_MAX_BYTES: usize = 256 * 1024;
    const FEED_TIMEOUT: Duration = Duration::from_secs(30);
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
    /// A download that sends nothing for this long has stalled.
    const STALL_TIMEOUT: Duration = Duration::from_secs(60);

    fn identity() -> SigningIdentity {
        SigningIdentity {
            team_id: TEAM_ID.to_string(),
            bundle_id: crate::APP_ID.to_string(),
        }
    }

    /// The updater's folders inside the data directory: the download, and
    /// the staging folder it is unpacked in (`staging_root`, which only the
    /// updater empties).
    struct Folders {
        downloads: PathBuf,
        staging: PathBuf,
        helper_log: PathBuf,
    }

    impl Folders {
        fn of(user_data_dir: &Path) -> Self {
            let root = user_data_dir.join("updater");
            Self {
                downloads: root.join("download"),
                staging: staging_root(&root),
                helper_log: root.join("last-install.log"),
            }
        }
    }

    /// Where a release's file is saved: its own name, in the download
    /// folder. `None` for a name that is a path or hidden.
    fn download_path(folder: &Path, file: &FeedFile) -> Option<PathBuf> {
        let name = Path::new(&file.url).file_name()?.to_str()?;
        if name.starts_with('.') || name.contains('\\') {
            return None;
        }
        Some(folder.join(name))
    }

    /// The requests, over the app's runtime from the check's own thread.
    struct HttpTransport {
        runtime: Handle,
        client: reqwest::Client,
        bases: FeedBases,
        downloads: PathBuf,
    }

    impl HttpTransport {
        fn new(runtime: Handle, bases: FeedBases, downloads: PathBuf) -> Option<Self> {
            let client = reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                // videorc.com redirects to a presigned storage address; only
                // https is followed.
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() < 5 && attempt.url().scheme() == "https" {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }))
                .user_agent(concat!("Videorc/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok()?;
            Some(Self {
                runtime,
                client,
                bases,
                downloads,
            })
        }

        /// The pilot feed is Windows' and not wired here.
        fn base(&self, source: FeedSource<'_>) -> Result<String, UpdateFailure> {
            match source {
                FeedSource::Public(route) => Ok(self.bases.base(route).to_string()),
                FeedSource::Pilot(_) => Err(UpdateFailure::Other),
            }
        }
    }

    impl Transport for HttpTransport {
        type Download = File;

        fn fetch_feed(
            &mut self,
            source: FeedSource<'_>,
            feed_file: &str,
        ) -> Result<String, UpdateFailure> {
            let url = format!("{}{feed_file}", self.base(source)?);
            let client = self.client.clone();
            self.runtime.block_on(async move {
                let mut response = client
                    .get(&url)
                    .timeout(FEED_TIMEOUT)
                    .send()
                    .await
                    .map_err(|_| UpdateFailure::Transport)?;
                let status = response.status();
                if status.as_u16() == 404 {
                    return Err(UpdateFailure::MissingFeed);
                }
                if !status.is_success() {
                    return Err(UpdateFailure::Status(status.as_u16()));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| UpdateFailure::Transport)?
                {
                    if bytes.len() + chunk.len() > FEED_MAX_BYTES {
                        return Err(UpdateFailure::Feed);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                String::from_utf8(bytes).map_err(|_| UpdateFailure::Feed)
            })
        }

        fn download(
            &mut self,
            source: FeedSource<'_>,
            file: &FeedFile,
            progress: &mut dyn FnMut(f64),
        ) -> Result<File, UpdateFailure> {
            let url = file_url(&self.base(source)?, file);
            let path = download_path(&self.downloads, file).ok_or(UpdateFailure::Feed)?;
            fs::create_dir_all(&self.downloads).map_err(|_| UpdateFailure::Disk)?;
            if let Err(failure) = self.save(&url, &path, file.size, progress) {
                let _ = fs::remove_file(&path);
                return Err(failure);
            }
            File::open(&path).map_err(|_| UpdateFailure::Disk)
        }
    }

    impl HttpTransport {
        /// Saves the file at `url` to `path`, saying the percent done.
        fn save(
            &self,
            url: &str,
            path: &Path,
            size: u64,
            progress: &mut dyn FnMut(f64),
        ) -> Result<(), UpdateFailure> {
            let mut response = self
                .runtime
                .block_on(self.client.get(url).send())
                .map_err(|_| UpdateFailure::Transport)?;
            let status = response.status();
            if !status.is_success() {
                return Err(UpdateFailure::Status(status.as_u16()));
            }
            let mut out = File::create(path).map_err(|_| UpdateFailure::Disk)?;
            let mut done: u64 = 0;
            loop {
                let next = self
                    .runtime
                    .block_on(tokio::time::timeout(STALL_TIMEOUT, response.chunk()))
                    .map_err(|_| UpdateFailure::Transport)?
                    .map_err(|_| UpdateFailure::Transport)?;
                let Some(chunk) = next else {
                    break;
                };
                done += chunk.len() as u64;
                // More than the feed promised is not the release.
                if done > size {
                    return Err(UpdateFailure::Integrity);
                }
                out.write_all(&chunk).map_err(|_| UpdateFailure::Disk)?;
                progress(done as f64 * 100.0 / size.max(1) as f64);
            }
            out.flush().map_err(|_| UpdateFailure::Disk)
        }
    }

    /// An update unpacked, checked and waiting for the quit.
    struct Ready {
        bundle: PathBuf,
        version: String,
    }

    /// What the macOS install keeps between the check, Restart & install
    /// and the quit.
    struct MacUpdates {
        installed: PathBuf,
        folders: Folders,
        ready: Mutex<Option<Ready>>,
        /// Restart & install was admitted: the app opens again afterwards.
        relaunch: AtomicBool,
        quit: watch::Sender<bool>,
    }

    static UPDATES: OnceLock<Arc<MacUpdates>> = OnceLock::new();

    /// The platform's half of the flow.
    struct MacInstaller {
        updates: Arc<MacUpdates>,
        runtime: Handle,
        restarter: Arc<SupervisorRestarter>,
        log: SharedLog,
    }

    impl MacInstaller {
        fn warn(&self, line: &str) {
            self.log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .warn(line);
        }
    }

    impl Installer for MacInstaller {
        fn admit(&self, info: &UpdateInfo) -> Result<(), UpdateFailure> {
            let version = info.version.to_string();
            let Some(zip) = download_path(&self.updates.folders.downloads, info.package()) else {
                return Err(UpdateFailure::Feed);
            };
            let identity = identity();
            let mut verify = |bundle: &Path| verify_videorc_bundle(bundle, &identity);
            let prepared =
                prepare_update(&zip, &self.updates.folders.staging, &version, &mut verify);
            // The zip is unpacked or refused; either way it is not kept.
            let _ = fs::remove_file(&zip);
            match prepared {
                Ok(bundle) => {
                    *self
                        .updates
                        .ready
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(Ready { bundle, version });
                    Ok(())
                }
                Err(failure) => {
                    self.warn(&format!("update {version} refused: {failure}"));
                    Err(match failure {
                        PrepareFailure::Staging(_) => UpdateFailure::Disk,
                        PrepareFailure::Unpack(_) => UpdateFailure::Other,
                        PrepareFailure::Signature(_) | PrepareFailure::Version { .. } => {
                            UpdateFailure::Signature
                        }
                    })
                }
            }
        }

        /// Restart & install: the backend's lease first (nothing may start
        /// in between), then the quit; the helper starts at the quit.
        fn install(&self, info: &UpdateInfo) {
            let waiting = self
                .updates
                .ready
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
                .map(|ready| ready.version.clone());
            if waiting.as_deref() != Some(info.version.to_string().as_str()) {
                self.warn("Restart to install found no unpacked update for that version");
                return;
            }
            let updates = self.updates.clone();
            let restarter = self.restarter.clone();
            let log = self.log.clone();
            self.runtime.spawn(async move {
                let admitted = if restarter.backend_connected() {
                    match restarter
                        .acquire(
                            InterruptionAction::UpdateInstall,
                            INSTALL_REASON.to_string(),
                        )
                        .await
                    {
                        Ok(lease) => run_interrupting_action(lease, async {
                            updates.relaunch.store(true, Ordering::SeqCst);
                            Ok(())
                        })
                        .await
                        .unwrap_or(false),
                        Err(error) => {
                            log.lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .warn(&format!("the install's lease failed: {error}"));
                            false
                        }
                    }
                } else {
                    updates.relaunch.store(true, Ordering::SeqCst);
                    true
                };
                if admitted {
                    let _ = updates.quit.send_replace(true);
                } else {
                    log.lock().unwrap_or_else(PoisonError::into_inner).warn(
                        "the backend didn't admit the install: a recording or stream started",
                    );
                }
            });
        }
    }

    pub fn start(
        runtime: &Handle,
        user_data_dir: &Path,
        restart: SupervisorRestart,
        packaged: bool,
        log: SharedLog,
    ) -> Arc<Updater> {
        let say = |line: &str| {
            log.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .info(line);
        };
        let folders = Folders::of(user_data_dir);
        read_last_install(&folders.helper_log, &say);

        let (bases, ignored) = feed_bases(std::env::var(UPDATE_FEED_URL_ENV).ok().as_deref());
        if ignored {
            say("VIDEORC_UPDATE_FEED_URL is not a feed on this computer; ignored");
        }
        if !packaged && !bases.is_local() {
            return super::no_feed();
        }
        let Some(installed) = std::env::current_exe()
            .ok()
            .and_then(|exe| bundle_of_executable(&exe))
        else {
            say("this copy is not an app bundle, so it doesn't update itself");
            return super::no_feed();
        };
        if let Some(refusal) = install_location_refusal(&installed) {
            say(&format!(
                "this copy can't be replaced where it is: {refusal}"
            ));
            return super::no_feed();
        }
        let current = match Version::parse(&super::running_version()) {
            Ok(version) => version,
            Err(_) => {
                say("this build doesn't say its version, so it doesn't update itself");
                return super::no_feed();
            }
        };
        let Some(transport) = HttpTransport::new(runtime.clone(), bases, folders.downloads.clone())
        else {
            say("the update client couldn't start");
            return super::no_feed();
        };
        let facts = LaunchFacts {
            host: UpdaterHost::MacOs,
            packaged: true,
            background_disabled: std::env::var(DISABLE_AUTO_UPDATE_ENV).as_deref() == Ok("1"),
            pilot_config_refused: false,
            linux_notice_source: false,
        };
        let plan = launch_plan(&facts);

        let (quit, _) = watch::channel(false);
        let updates = Arc::new(MacUpdates {
            installed,
            folders,
            ready: Mutex::new(None),
            relaunch: AtomicBool::new(false),
            quit,
        });
        let _ = UPDATES.set(updates.clone());
        let installer = MacInstaller {
            updates,
            runtime: runtime.clone(),
            restarter: Arc::new(SupervisorRestarter {
                restart,
                transport: Arc::new(LoopbackHttp),
            }),
            log: log.clone(),
        };
        let driver = FeedDriver::new(
            transport,
            current,
            UpdatePlatform::MacOs,
            MACOS_FEED_FILE,
            Arc::new(installer),
            log,
            own_thread(),
        );
        let updater = Updater::new(driver, UpdateStatus::Idle);
        if plan == LaunchPlan::Background {
            runtime.spawn(background_checks(Arc::downgrade(&updater)));
        }
        updater
    }

    /// Restart & install was admitted: the window quits the normal way.
    pub fn quit_requests() -> Option<watch::Receiver<bool>> {
        UPDATES.get().map(|updates| updates.quit.subscribe())
    }

    /// At the quit, after the backend stopped: a ready update is handed to
    /// the helper, which installs it once this process is gone (Electron's
    /// `autoInstallOnAppQuit`), and opens the app again after Restart &
    /// install. Once only.
    pub fn apply_at_quit() {
        let Some(updates) = UPDATES.get() else {
            return;
        };
        let Some(ready) = updates
            .ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            return;
        };
        let plan = ApplyPlan {
            app_pid: std::process::id(),
            installed: updates.installed.clone(),
            staged: ready.bundle,
            version: ready.version,
            relaunch: updates.relaunch.load(Ordering::SeqCst),
        };
        let helper = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(error) => {
                eprintln!("[videorc-app] [updater] the update helper can't start: {error}");
                return;
            }
        };
        match Command::new(&helper)
            .args(plan.to_arguments())
            .env(HELPER_LOG_ENV, &updates.folders.helper_log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => eprintln!(
                "[videorc-app] [updater] installing {} after the quit (helper pid {})",
                plan.version,
                child.id()
            ),
            Err(error) => {
                eprintln!("[videorc-app] [updater] the update helper can't start: {error}")
            }
        }
    }

    /// A launch as the update helper: does the install and answers its exit
    /// code; `None` for the app's own launches.
    pub fn run_helper_if_asked() -> Option<i32> {
        let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
        let plan = match ApplyPlan::from_arguments(arguments) {
            Ok(None) => return None,
            Ok(Some(plan)) => plan,
            Err(error) => {
                helper_note(&format!("the update helper did nothing: {error}"));
                return Some(2);
            }
        };
        let mut system = MacSystem::new(identity());
        let outcome = apply_update(&plan, &mut system);
        match &outcome.failure {
            None => helper_note(&format!(
                "update {} installed{}",
                plan.version,
                if outcome.opened { " and opened" } else { "" }
            )),
            Some(failure) => {
                helper_note(&format!("update {} not installed: {failure}", plan.version))
            }
        }
        Some(if outcome.failure.is_none() { 0 } else { 1 })
    }

    fn helper_note(line: &str) {
        eprintln!("[videorc-update-helper] {line}");
        let Some(path) = std::env::var_os(HELPER_LOG_ENV) else {
            return;
        };
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }

    /// The last helper's lines go to the updater's log once.
    fn read_last_install(path: &Path, say: &dyn Fn(&str)) {
        let Ok(text) = fs::read_to_string(path) else {
            return;
        };
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            say(&format!("last install: {line}"));
        }
        let _ = fs::remove_file(path);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn file(url: &str) -> FeedFile {
            FeedFile {
                url: url.to_string(),
                sha512: String::new(),
                size: 0,
            }
        }

        #[test]
        fn a_download_keeps_only_its_own_name() {
            let folder = Path::new("/tmp/videorc-update-download");
            assert_eq!(
                download_path(folder, &file("Videorc-0.41.0-mac-arm64.zip")),
                Some(folder.join("Videorc-0.41.0-mac-arm64.zip"))
            );
            assert_eq!(
                download_path(folder, &file("../../Videorc.zip")),
                Some(folder.join("Videorc.zip"))
            );
            assert_eq!(download_path(folder, &file(".hidden.zip")), None);
            assert_eq!(download_path(folder, &file("..")), None);
            assert_eq!(download_path(folder, &file("")), None);
        }

        #[test]
        fn the_updaters_folders_live_in_the_data_directory() {
            let folders = Folders::of(Path::new("/tmp/profile"));
            assert_eq!(
                folders.downloads,
                Path::new("/tmp/profile/updater/download")
            );
            assert_eq!(
                folders.staging,
                Path::new("/tmp/profile/updater/videorc-update")
            );
            assert!(!folders.downloads.starts_with(&folders.staging));
        }
    }
}
