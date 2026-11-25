//! One check and one download, with the mirror fallback and the pilot feed.
//!
//! This is the order of work in Electron's `updater.ts`, without its window
//! and its timers: what is asked of which feed, what is tried again, and
//! what the streamer is told at each step. The requests themselves are the
//! [`Transport`]'s.

use std::io::Read;

use semver::Version;

use crate::feed::{FeedFile, UpdateInfo, parse_update_info, verify_download};
use crate::mirror::{FeedRoute, UpdateFailure, should_retry_update_on_mirror};
use crate::status::{UnsupportedReason, UpdateStatus, UpdaterEvent, update_status_from_event};
use crate::windows_pilot::{
    PublicFeedOutcome, WindowsPilotUpdateGrant, WindowsPilotUpdaterConfig,
    account_pilot_updater_config, is_windows_pilot_update_grant, should_probe_account_pilot_feed,
};

/// Where a feed and its files are read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedSource<'a> {
    /// The public feed, on one of its two routes.
    Public(FeedRoute),
    /// The Windows pilot feed, through the branded proxy, with this bearer.
    /// The bearer never follows a redirect to another origin.
    Pilot(&'a WindowsPilotUpdaterConfig),
}

/// The requests an updater makes.
pub trait Transport {
    /// What a download can be read back from, to be checked.
    type Download: Read;

    /// The text of a feed file. A 404 on the feed file itself is
    /// [`UpdateFailure::MissingFeed`].
    fn fetch_feed(
        &mut self,
        source: FeedSource<'_>,
        feed_file: &str,
    ) -> Result<String, UpdateFailure>;

    /// Downloads one of a release's files, telling `progress` the percent
    /// done as it goes.
    fn download(
        &mut self,
        source: FeedSource<'_>,
        file: &FeedFile,
        progress: &mut dyn FnMut(f64),
    ) -> Result<Self::Download, UpdateFailure>;
}

/// The platforms that update themselves. Linux only learns that a newer
/// release exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePlatform {
    MacOs,
    Windows,
}

/// What the streamer is told when a pilot download finds its access gone.
/// These are Electron's words.
pub const PILOT_ACCESS_ENDED: &str = "Windows pilot update access ended. Check for updates again.";

/// What the streamer is told when a check or a download fails. These are
/// new words: Electron shows `electron-updater`'s own message. S5.2c puts
/// them in front of the owner with the update row.
pub fn failure_message(failure: UpdateFailure) -> String {
    match failure {
        UpdateFailure::Transport => "Videorc couldn't reach the update server.".to_string(),
        UpdateFailure::Status(status) => {
            format!("The update server answered with an error ({status}).")
        }
        UpdateFailure::MissingFeed => "No update is published for this build yet.".to_string(),
        UpdateFailure::Feed => "The update information couldn't be read.".to_string(),
        UpdateFailure::Integrity => {
            "The downloaded update didn't match what was published, so it wasn't installed."
                .to_string()
        }
        UpdateFailure::Signature => {
            "The downloaded update isn't signed by Videorc, so it wasn't installed.".to_string()
        }
        UpdateFailure::Cancelled => "The update was cancelled.".to_string(),
        UpdateFailure::Disk => {
            "There isn't enough room, or permission, to save the update.".to_string()
        }
        UpdateFailure::Other => "The update didn't finish.".to_string(),
    }
}

/// The feed an update was found on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoundOn {
    Public(FeedRoute),
    Pilot,
}

/// Asks the account for a pilot grant and keeps it only when it is well
/// formed. `None` when the account is signed out, the pilot is closed, or
/// the backend is unavailable.
fn account_pilot_config(
    account_grant: &mut dyn FnMut() -> Option<WindowsPilotUpdateGrant>,
) -> Option<WindowsPilotUpdaterConfig> {
    let grant = account_grant()?;
    is_windows_pilot_update_grant(&grant).then(|| account_pilot_updater_config(&grant))
}

/// The updater's own state between a check and a download.
pub struct UpdateFlow<T: Transport> {
    transport: T,
    current: Version,
    platform: UpdatePlatform,
    feed_file: &'static str,
    /// Operator mode: every check is pinned to the pilot feed, with the
    /// operator's bearer, and never leaves it.
    operator_pilot: Option<WindowsPilotUpdaterConfig>,
    status: UpdateStatus,
    /// The update the last check found, and the feed that answered.
    found: Option<(FoundOn, UpdateInfo)>,
}

impl<T: Transport> UpdateFlow<T> {
    pub fn new(
        transport: T,
        current: Version,
        platform: UpdatePlatform,
        feed_file: &'static str,
        operator_pilot: Option<WindowsPilotUpdaterConfig>,
    ) -> Self {
        Self {
            transport,
            current,
            platform,
            feed_file,
            operator_pilot,
            status: UpdateStatus::Idle,
            found: None,
        }
    }

    pub fn status(&self) -> &UpdateStatus {
        &self.status
    }

    /// The release the last check found, when it is newer than this build.
    pub fn found(&self) -> Option<&UpdateInfo> {
        self.found.as_ref().map(|(_, info)| info)
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// Checks the public feed, or the pilot feed in operator mode. A public
    /// check starts on the primary route and falls back to the mirror once
    /// when the primary fails in transport (a blocked storage origin). If
    /// the mirror fails too, the primary's failure is the one worth
    /// reporting. `on_status` hears each status as it is set; nothing is
    /// said between the primary's failure and the mirror's answer, so the
    /// window never flashes an error.
    pub fn check(&mut self, on_status: &mut dyn FnMut(&UpdateStatus)) -> &UpdateStatus {
        self.check_first_feed(on_status);
        &self.status
    }

    /// Checks the public feed first, with its mirror fallback. A signed-in
    /// Windows install then asks the pilot feed when the public one has
    /// nothing for it: no feed yet, or nothing newer. The public feed always
    /// wins when it has something newer, and a public failure is reported
    /// as it is. A pilot failure leaves the public answer standing; it never
    /// shows an error of its own. `account_grant` is asked only when the
    /// pilot feed is about to be read.
    pub fn check_all_feeds(
        &mut self,
        account_grant: &mut dyn FnMut() -> Option<WindowsPilotUpdateGrant>,
        on_status: &mut dyn FnMut(&UpdateStatus),
    ) -> &UpdateStatus {
        let public_outcome = self.check_first_feed(on_status);
        let probes = should_probe_account_pilot_feed(
            self.operator_pilot.is_some(),
            self.platform == UpdatePlatform::Windows,
            public_outcome,
        );
        if probes
            && let Some(config) = account_pilot_config(account_grant)
            && let Ok(info) = self.read_feed(FeedSource::Pilot(&config))
        {
            self.offer(FoundOn::Pilot, info, on_status);
        }
        &self.status
    }

    /// Downloads the update the last check found and checks its bytes. A
    /// download is bound to the update info of the feed that was checked,
    /// so a fallback checks again on the mirror before it downloads from
    /// there. A pilot download asks `account_grant` for a fresh bearer,
    /// since it can come long after the check, and never goes to the
    /// mirror. Without a found update it does nothing.
    ///
    /// `admit` is the platform's own check of what was downloaded, asked
    /// once its size and SHA-512 are right: on macOS the zip is unpacked
    /// and the app in it checked, on Windows the installer's publisher is
    /// checked. The status says the update is ready only when it passes. A
    /// refusal is not tried again on the mirror: the bytes were the
    /// published ones.
    pub fn download(
        &mut self,
        account_grant: &mut dyn FnMut() -> Option<WindowsPilotUpdateGrant>,
        admit: &mut dyn FnMut(&UpdateInfo) -> Result<(), UpdateFailure>,
        on_status: &mut dyn FnMut(&UpdateStatus),
    ) -> &UpdateStatus {
        let Some((on, info)) = self.found.clone() else {
            return &self.status;
        };
        match on {
            FoundOn::Public(route) => self.download_public(route, &info, admit, on_status),
            FoundOn::Pilot => {
                let config = match self.operator_pilot.clone() {
                    Some(config) => Some(config),
                    None => account_pilot_config(account_grant),
                };
                match config {
                    Some(config) => {
                        let source = FeedSource::Pilot(&config);
                        if let Err(failure) = self.download_from(source, &info, admit, on_status) {
                            self.fail(failure, on_status);
                        }
                    }
                    None => {
                        self.found = None;
                        let message = PILOT_ACCESS_ENDED.to_string();
                        self.set(UpdaterEvent::Error { message }, on_status);
                    }
                }
            }
        }
        &self.status
    }

    /// Checks the first feed and says what it answered.
    fn check_first_feed(&mut self, on_status: &mut dyn FnMut(&UpdateStatus)) -> PublicFeedOutcome {
        self.found = None;
        self.set(UpdaterEvent::Checking, on_status);
        let answer = match self.operator_pilot.clone() {
            Some(config) => self
                .read_feed(FeedSource::Pilot(&config))
                .map(|info| (FoundOn::Pilot, info)),
            None => self
                .read_public_feed_with_fallback()
                .map(|(route, info)| (FoundOn::Public(route), info)),
        };
        match answer {
            Ok((on, info)) => {
                if self.offer(on, info, on_status) {
                    PublicFeedOutcome::Available
                } else {
                    PublicFeedOutcome::NotAvailable
                }
            }
            Err(failure) => {
                self.fail(failure, on_status);
                if failure == UpdateFailure::MissingFeed {
                    PublicFeedOutcome::MissingFeed
                } else {
                    PublicFeedOutcome::Failed
                }
            }
        }
    }

    /// Says "available" or "nothing newer" for a feed's answer. True when
    /// the release is newer than this build.
    fn offer(
        &mut self,
        on: FoundOn,
        info: UpdateInfo,
        on_status: &mut dyn FnMut(&UpdateStatus),
    ) -> bool {
        if info.is_newer_than(&self.current) {
            let version = info.version.to_string();
            self.found = Some((on, info));
            self.set(UpdaterEvent::Available { version }, on_status);
            true
        } else {
            self.found = None;
            let current_version = self.current.to_string();
            self.set(UpdaterEvent::NotAvailable { current_version }, on_status);
            false
        }
    }

    fn download_public(
        &mut self,
        route: FeedRoute,
        info: &UpdateInfo,
        admit: &mut dyn FnMut(&UpdateInfo) -> Result<(), UpdateFailure>,
        on_status: &mut dyn FnMut(&UpdateStatus),
    ) {
        match self.download_from(FeedSource::Public(route), info, admit, on_status) {
            Ok(()) => {}
            Err(failure) if should_retry_update_on_mirror(failure, false, route) => {
                let mirror = FeedSource::Public(FeedRoute::Mirror);
                let on_mirror = self
                    .read_feed(mirror)
                    .and_then(|info| self.download_from(mirror, &info, admit, on_status));
                if on_mirror.is_err() {
                    self.fail(failure, on_status);
                }
            }
            Err(failure) => self.fail(failure, on_status),
        }
    }

    fn download_from(
        &mut self,
        source: FeedSource<'_>,
        info: &UpdateInfo,
        admit: &mut dyn FnMut(&UpdateInfo) -> Result<(), UpdateFailure>,
        on_status: &mut dyn FnMut(&UpdateStatus),
    ) -> Result<(), UpdateFailure> {
        let package = info.package().clone();
        // The transport and the status are separate fields, so each report
        // reaches the window while the download still runs.
        let Self {
            transport, status, ..
        } = self;
        let download = transport.download(source, &package, &mut |percent| {
            *status = update_status_from_event(UpdaterEvent::Progress { percent });
            on_status(status);
        })?;
        match verify_download(download, &package) {
            Ok(Ok(())) => {
                // The bytes are the published ones. Whether they are
                // Videorc's is the platform's to say, before "ready".
                admit(info)?;
                let on = match source {
                    FeedSource::Public(route) => FoundOn::Public(route),
                    FeedSource::Pilot(_) => FoundOn::Pilot,
                };
                self.found = Some((on, info.clone()));
                let version = info.version.to_string();
                self.set(UpdaterEvent::Downloaded { version }, on_status);
                Ok(())
            }
            Ok(Err(_)) => Err(UpdateFailure::Integrity),
            Err(_) => Err(UpdateFailure::Disk),
        }
    }

    fn read_public_feed_with_fallback(&mut self) -> Result<(FeedRoute, UpdateInfo), UpdateFailure> {
        match self.read_feed(FeedSource::Public(FeedRoute::Primary)) {
            Ok(info) => Ok((FeedRoute::Primary, info)),
            Err(failure) if should_retry_update_on_mirror(failure, false, FeedRoute::Primary) => {
                match self.read_feed(FeedSource::Public(FeedRoute::Mirror)) {
                    Ok(info) => Ok((FeedRoute::Mirror, info)),
                    Err(_) => Err(failure),
                }
            }
            Err(failure) => Err(failure),
        }
    }

    fn read_feed(&mut self, source: FeedSource<'_>) -> Result<UpdateInfo, UpdateFailure> {
        let text = self.transport.fetch_feed(source, self.feed_file)?;
        parse_update_info(&text).map_err(|_| UpdateFailure::Feed)
    }

    /// A failure becomes the benign "unsupported" state when it is only an
    /// unpublished feed (no channel for this platform yet); otherwise it is
    /// a real error the streamer reads.
    fn fail(&mut self, failure: UpdateFailure, on_status: &mut dyn FnMut(&UpdateStatus)) {
        let event = match (failure, self.platform) {
            (UpdateFailure::MissingFeed, UpdatePlatform::Windows) => UpdaterEvent::Unsupported {
                reason: Some(UnsupportedReason::WindowsFeedUnpublished),
            },
            (UpdateFailure::MissingFeed, UpdatePlatform::MacOs) => {
                UpdaterEvent::Unsupported { reason: None }
            }
            _ => UpdaterEvent::Error {
                message: failure_message(failure),
            },
        };
        self.set(event, on_status);
    }

    fn set(&mut self, event: UpdaterEvent, on_status: &mut dyn FnMut(&UpdateStatus)) {
        self.status = update_status_from_event(event);
        on_status(&self.status);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use sha2::{Digest, Sha512};

    use super::*;
    use crate::feed::{MACOS_FEED_FILE, WINDOWS_FEED_FILE};
    use crate::windows_pilot::windows_pilot_updater_config;

    const PACKAGE: &[u8] = b"the new Videorc, zipped";

    /// A feed for `version` whose one file is [`PACKAGE`].
    fn feed(version: &str) -> String {
        let digest = STANDARD.encode(Sha512::digest(PACKAGE));
        format!(
            "version: {version}\nfiles:\n  - url: Videorc-{version}-mac-arm64.zip\n    sha512: {digest}\n    size: {}\npath: Videorc-{version}-mac-arm64.zip\n",
            PACKAGE.len()
        )
    }

    /// A transport that answers what the test scripted, and remembers what
    /// it was asked.
    #[derive(Default)]
    struct Scripted {
        primary_feed: Option<Result<String, UpdateFailure>>,
        mirror_feed: Option<Result<String, UpdateFailure>>,
        pilot_feed: Option<Result<String, UpdateFailure>>,
        primary_download: Option<Result<Vec<u8>, UpdateFailure>>,
        mirror_download: Option<Result<Vec<u8>, UpdateFailure>>,
        pilot_download: Option<Result<Vec<u8>, UpdateFailure>>,
        progress: Vec<f64>,
        asked: Vec<String>,
        /// The `Authorization` of each pilot request, in order.
        bearers: Vec<String>,
    }

    impl Scripted {
        /// Notes a request, and its bearer when it goes to the pilot feed.
        fn note(&mut self, what: &str, source: FeedSource<'_>, name: &str) {
            let feed = match source {
                FeedSource::Public(FeedRoute::Primary) => "Primary",
                FeedSource::Public(FeedRoute::Mirror) => "Mirror",
                FeedSource::Pilot(config) => {
                    self.bearers.push(config.authorization.clone());
                    "Pilot"
                }
            };
            self.asked.push(format!("{what} {feed} {name}"));
        }
    }

    impl Transport for Scripted {
        type Download = Cursor<Vec<u8>>;

        fn fetch_feed(
            &mut self,
            source: FeedSource<'_>,
            feed_file: &str,
        ) -> Result<String, UpdateFailure> {
            self.note("feed", source, feed_file);
            let answer = match source {
                FeedSource::Public(FeedRoute::Primary) => self.primary_feed.clone(),
                FeedSource::Public(FeedRoute::Mirror) => self.mirror_feed.clone(),
                FeedSource::Pilot(_) => self.pilot_feed.clone(),
            };
            answer.unwrap_or(Err(UpdateFailure::Other))
        }

        fn download(
            &mut self,
            source: FeedSource<'_>,
            file: &FeedFile,
            progress: &mut dyn FnMut(f64),
        ) -> Result<Self::Download, UpdateFailure> {
            self.note("download", source, &file.url);
            for percent in &self.progress {
                progress(*percent);
            }
            let answer = match source {
                FeedSource::Public(FeedRoute::Primary) => self.primary_download.clone(),
                FeedSource::Public(FeedRoute::Mirror) => self.mirror_download.clone(),
                FeedSource::Pilot(_) => self.pilot_download.clone(),
            };
            answer.unwrap_or(Err(UpdateFailure::Other)).map(Cursor::new)
        }
    }

    fn flow(transport: Scripted) -> UpdateFlow<Scripted> {
        UpdateFlow::new(
            transport,
            Version::parse("0.25.2").unwrap(),
            UpdatePlatform::MacOs,
            MACOS_FEED_FILE,
            None,
        )
    }

    /// A signed-in Windows install, not in operator mode.
    fn windows(transport: Scripted) -> UpdateFlow<Scripted> {
        UpdateFlow::new(
            transport,
            Version::parse("0.25.2").unwrap(),
            UpdatePlatform::Windows,
            WINDOWS_FEED_FILE,
            None,
        )
    }

    fn grant(token: &str) -> WindowsPilotUpdateGrant {
        WindowsPilotUpdateGrant {
            token: token.to_string(),
            expires_at: "2026-11-15T12:00:00.000Z".to_string(),
        }
    }

    /// Checks every feed with an account whose grant is `token`, and returns
    /// the statuses in order and how often the account was asked.
    fn check_all(flow: &mut UpdateFlow<Scripted>, token: Option<&str>) -> (Vec<UpdateStatus>, u32) {
        let mut seen = Vec::new();
        let mut asked = 0;
        flow.check_all_feeds(
            &mut || {
                asked += 1;
                token.map(grant)
            },
            &mut |status| seen.push(status.clone()),
        );
        (seen, asked)
    }

    fn download_with(flow: &mut UpdateFlow<Scripted>, token: Option<&str>) -> Vec<UpdateStatus> {
        let mut seen = Vec::new();
        flow.download(&mut || token.map(grant), &mut |_| Ok(()), &mut |status| {
            seen.push(status.clone())
        });
        seen
    }

    fn not_available() -> UpdateStatus {
        UpdateStatus::NotAvailable {
            current_version: "0.25.2".to_string(),
        }
    }

    fn unpublished() -> UpdateStatus {
        UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::WindowsFeedUnpublished),
        }
    }

    /// Runs a check and returns every status it set, in order.
    fn check(flow: &mut UpdateFlow<Scripted>) -> Vec<UpdateStatus> {
        let mut seen = Vec::new();
        flow.check(&mut |status| seen.push(status.clone()));
        seen
    }

    fn download(flow: &mut UpdateFlow<Scripted>) -> Vec<UpdateStatus> {
        let mut seen = Vec::new();
        flow.download(&mut || None, &mut |_| Ok(()), &mut |status| {
            seen.push(status.clone())
        });
        seen
    }

    fn available(version: &str) -> UpdateStatus {
        UpdateStatus::Available {
            version: version.to_string(),
        }
    }

    fn error(failure: UpdateFailure) -> UpdateStatus {
        UpdateStatus::Error {
            message: failure_message(failure),
        }
    }

    // a check

    #[test]
    fn finds_a_newer_release_on_the_primary_route() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, available("0.26.0")]
        );
        assert_eq!(
            flow.found().map(|info| info.version.to_string()).as_deref(),
            Some("0.26.0")
        );
        assert_eq!(flow.transport().asked, vec!["feed Primary latest-mac.yml"]);
    }

    #[test]
    fn says_there_is_nothing_newer_when_the_feed_has_this_version_or_an_older_one() {
        for published in ["0.25.2", "0.25.1", "0.25.2-alpha.3"] {
            let mut flow = flow(Scripted {
                primary_feed: Some(Ok(feed(published))),
                ..Scripted::default()
            });
            assert_eq!(
                check(&mut flow),
                vec![
                    UpdateStatus::Checking,
                    UpdateStatus::NotAvailable {
                        current_version: "0.25.2".to_string()
                    }
                ],
                "{published}"
            );
            assert!(flow.found().is_none());
        }
    }

    #[test]
    fn falls_back_to_the_mirror_once_and_says_nothing_in_between() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Err(UpdateFailure::Transport)),
            mirror_feed: Some(Ok(feed("0.26.0"))),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, available("0.26.0")]
        );
        assert_eq!(
            flow.transport().asked,
            vec!["feed Primary latest-mac.yml", "feed Mirror latest-mac.yml"]
        );
    }

    #[test]
    fn reports_the_primary_failure_when_the_mirror_fails_too() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Err(UpdateFailure::Status(503))),
            mirror_feed: Some(Err(UpdateFailure::Transport)),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, error(UpdateFailure::Status(503))]
        );
    }

    #[test]
    fn never_asks_the_mirror_about_a_failure_of_the_update_itself() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok("version: latest\n".to_string())),
            mirror_feed: Some(Ok(feed("0.26.0"))),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, error(UpdateFailure::Feed)]
        );
        assert_eq!(flow.transport().asked, vec!["feed Primary latest-mac.yml"]);
    }

    #[test]
    fn operator_mode_reads_only_the_pilot_feed_with_the_operators_bearer() {
        let token = "o".repeat(32);
        let operator = windows_pilot_updater_config(Some("1"), Some(&token), true).unwrap();
        let mut flow = UpdateFlow::new(
            Scripted {
                primary_feed: Some(Ok(feed("0.27.0"))),
                mirror_feed: Some(Ok(feed("0.27.0"))),
                pilot_feed: Some(Err(UpdateFailure::Transport)),
                ..Scripted::default()
            },
            Version::parse("0.25.2").unwrap(),
            UpdatePlatform::Windows,
            WINDOWS_FEED_FILE,
            operator,
        );
        // A failure of the road, and still nothing is asked of the mirror
        // or of the public feed.
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, error(UpdateFailure::Transport)]
        );
        assert_eq!(flow.transport().asked, vec!["feed Pilot latest.yml"]);
        assert_eq!(flow.transport().bearers, vec![format!("Bearer {token}")]);
        // The account is never asked for a grant in operator mode.
        let (_, asked) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(asked, 0);
        assert_eq!(flow.transport().bearers.len(), 2);
        assert!(
            flow.transport()
                .bearers
                .iter()
                .all(|bearer| *bearer == format!("Bearer {token}"))
        );
    }

    #[test]
    fn an_unpublished_feed_is_not_an_error() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Err(UpdateFailure::MissingFeed)),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut flow),
            vec![
                UpdateStatus::Checking,
                UpdateStatus::Unsupported { reason: None }
            ]
        );

        let mut windows = windows(Scripted {
            primary_feed: Some(Err(UpdateFailure::MissingFeed)),
            ..Scripted::default()
        });
        assert_eq!(
            check(&mut windows),
            vec![
                UpdateStatus::Checking,
                UpdateStatus::Unsupported {
                    reason: Some(UnsupportedReason::WindowsFeedUnpublished)
                }
            ]
        );
    }

    // a download

    #[test]
    fn downloads_what_the_check_found_and_checks_its_bytes() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Ok(PACKAGE.to_vec())),
            progress: vec![12.4, 60.0, 130.0],
            ..Scripted::default()
        });
        check(&mut flow);
        assert_eq!(
            download(&mut flow),
            vec![
                UpdateStatus::Downloading {
                    percent: 12,
                    version: None
                },
                UpdateStatus::Downloading {
                    percent: 60,
                    version: None
                },
                UpdateStatus::Downloading {
                    percent: 100,
                    version: None
                },
                UpdateStatus::Downloaded {
                    version: "0.26.0".to_string()
                },
            ]
        );
        assert_eq!(
            flow.transport().asked[1],
            "download Primary Videorc-0.26.0-mac-arm64.zip"
        );
    }

    #[test]
    fn does_nothing_when_no_check_found_an_update() {
        let mut flow = flow(Scripted {
            primary_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        assert!(download(&mut flow).is_empty());
        assert_eq!(flow.status(), &UpdateStatus::Idle);
        assert!(flow.transport().asked.is_empty());
    }

    #[test]
    fn refuses_bytes_that_are_not_the_release_and_never_tries_them_elsewhere() {
        let mut changed = PACKAGE.to_vec();
        changed[0] ^= 1;
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Ok(changed)),
            mirror_feed: Some(Ok(feed("0.26.0"))),
            mirror_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        check(&mut flow);
        assert_eq!(download(&mut flow), vec![error(UpdateFailure::Integrity)]);
        assert_eq!(flow.transport().asked.len(), 2);
    }

    #[test]
    fn checks_again_on_the_mirror_before_it_downloads_from_there() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Err(UpdateFailure::Transport)),
            mirror_feed: Some(Ok(feed("0.26.1"))),
            mirror_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        check(&mut flow);
        // The mirror's own update info decides what is downloaded from it.
        assert_eq!(
            download(&mut flow),
            vec![UpdateStatus::Downloaded {
                version: "0.26.1".to_string()
            }]
        );
        assert_eq!(
            flow.transport().asked,
            vec![
                "feed Primary latest-mac.yml",
                "download Primary Videorc-0.26.0-mac-arm64.zip",
                "feed Mirror latest-mac.yml",
                "download Mirror Videorc-0.26.1-mac-arm64.zip",
            ]
        );
    }

    #[test]
    fn reports_the_primary_download_failure_when_the_mirror_fails_too() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Err(UpdateFailure::Status(403))),
            mirror_feed: Some(Ok(feed("0.26.0"))),
            mirror_download: Some(Err(UpdateFailure::Transport)),
            ..Scripted::default()
        });
        check(&mut flow);
        assert_eq!(download(&mut flow), vec![error(UpdateFailure::Status(403))]);
    }

    #[test]
    fn a_download_that_fails_can_be_tried_again_by_checking_again() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Err(UpdateFailure::Disk)),
            ..Scripted::default()
        });
        check(&mut flow);
        assert_eq!(download(&mut flow), vec![error(UpdateFailure::Disk)]);
        // A settled error is a state the background re-check starts from.
        assert!(crate::status::should_background_recheck(flow.status()));
        assert_eq!(
            check(&mut flow),
            vec![UpdateStatus::Checking, available("0.26.0")]
        );
    }

    // the Windows pilot feed

    #[test]
    fn asks_the_pilot_feed_when_the_public_feed_has_nothing_newer() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Ok(feed("0.25.2"))),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            ..Scripted::default()
        });
        let (seen, asked) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(
            seen,
            vec![
                UpdateStatus::Checking,
                not_available(),
                available("0.26.0-alpha.1")
            ]
        );
        assert_eq!(asked, 1);
        assert_eq!(
            flow.transport().asked,
            vec!["feed Primary latest.yml", "feed Pilot latest.yml"]
        );
        assert_eq!(flow.transport().bearers, vec!["Bearer wpu1.abc"]);
    }

    #[test]
    fn asks_the_pilot_feed_when_no_public_feed_is_published_yet() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Err(UpdateFailure::MissingFeed)),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            ..Scripted::default()
        });
        let (seen, _) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(
            seen,
            vec![
                UpdateStatus::Checking,
                unpublished(),
                available("0.26.0-alpha.1")
            ]
        );
    }

    #[test]
    fn the_public_feed_wins_when_it_has_something_newer() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            pilot_feed: Some(Ok(feed("0.27.0-alpha.1"))),
            ..Scripted::default()
        });
        let (seen, asked) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(seen, vec![UpdateStatus::Checking, available("0.26.0")]);
        // The account is not even asked for a grant.
        assert_eq!(asked, 0);
        assert_eq!(flow.transport().asked, vec!["feed Primary latest.yml"]);
    }

    #[test]
    fn a_public_failure_is_reported_as_it_is_and_never_probes() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Err(UpdateFailure::Transport)),
            mirror_feed: Some(Err(UpdateFailure::Transport)),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            ..Scripted::default()
        });
        let (seen, asked) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(
            seen,
            vec![UpdateStatus::Checking, error(UpdateFailure::Transport)]
        );
        assert_eq!(asked, 0);
        assert!(flow.transport().bearers.is_empty());
    }

    #[test]
    fn an_install_with_no_grant_keeps_the_public_answer() {
        // Signed out, the pilot closed, or the backend away: no grant at all.
        // Then a grant that is not well formed.
        for token in [None, Some("not-a-grant"), Some("wpu1.")] {
            let mut flow = windows(Scripted {
                primary_feed: Some(Ok(feed("0.25.2"))),
                pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
                ..Scripted::default()
            });
            let (seen, asked) = check_all(&mut flow, token);
            assert_eq!(
                seen,
                vec![UpdateStatus::Checking, not_available()],
                "{token:?}"
            );
            assert_eq!(asked, 1);
            assert_eq!(flow.transport().asked, vec!["feed Primary latest.yml"]);
        }
    }

    #[test]
    fn a_pilot_failure_leaves_the_public_answer_standing() {
        for failure in [
            UpdateFailure::Transport,
            UpdateFailure::Status(401),
            UpdateFailure::MissingFeed,
        ] {
            let mut flow = windows(Scripted {
                primary_feed: Some(Ok(feed("0.25.2"))),
                mirror_feed: Some(Ok(feed("0.26.0"))),
                pilot_feed: Some(Err(failure)),
                ..Scripted::default()
            });
            let (seen, _) = check_all(&mut flow, Some("wpu1.abc"));
            // Never a pilot-only error, and never the mirror with the bearer.
            assert_eq!(
                seen,
                vec![UpdateStatus::Checking, not_available()],
                "{failure:?}"
            );
            assert_eq!(flow.status(), &not_available());
            assert_eq!(
                flow.transport().asked,
                vec!["feed Primary latest.yml", "feed Pilot latest.yml"]
            );
        }
        // The same for a pilot feed that cannot be read.
        let mut flow = windows(Scripted {
            primary_feed: Some(Err(UpdateFailure::MissingFeed)),
            pilot_feed: Some(Ok("version: latest\n".to_string())),
            ..Scripted::default()
        });
        let (seen, _) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(seen, vec![UpdateStatus::Checking, unpublished()]);
    }

    #[test]
    fn says_there_is_nothing_newer_when_the_pilot_feed_has_nothing_newer_either() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Err(UpdateFailure::MissingFeed)),
            pilot_feed: Some(Ok(feed("0.25.2"))),
            ..Scripted::default()
        });
        let (seen, _) = check_all(&mut flow, Some("wpu1.abc"));
        // The pilot feed exists for this install, so it is no longer "no feed".
        assert_eq!(
            seen,
            vec![UpdateStatus::Checking, unpublished(), not_available()]
        );
        assert!(flow.found().is_none());
    }

    #[test]
    fn never_asks_the_pilot_feed_on_macos() {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.25.2"))),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            ..Scripted::default()
        });
        let (seen, asked) = check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(seen, vec![UpdateStatus::Checking, not_available()]);
        assert_eq!(asked, 0);
    }

    #[test]
    fn downloads_from_the_pilot_feed_with_a_fresh_grant() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Ok(feed("0.25.2"))),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            pilot_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        check_all(&mut flow, Some("wpu1.first"));
        // The bearer is short-lived: the download asks again.
        assert_eq!(
            download_with(&mut flow, Some("wpu1.second")),
            vec![UpdateStatus::Downloaded {
                version: "0.26.0-alpha.1".to_string()
            }]
        );
        assert_eq!(
            flow.transport().bearers,
            vec!["Bearer wpu1.first", "Bearer wpu1.second"]
        );
        assert_eq!(
            flow.transport().asked[2],
            "download Pilot Videorc-0.26.0-alpha.1-mac-arm64.zip"
        );
    }

    #[test]
    fn says_pilot_access_ended_when_the_grant_is_gone_at_download() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Ok(feed("0.25.2"))),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            pilot_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        check_all(&mut flow, Some("wpu1.first"));
        assert_eq!(
            download_with(&mut flow, None),
            vec![UpdateStatus::Error {
                message: "Windows pilot update access ended. Check for updates again.".to_string()
            }]
        );
        // Nothing was downloaded, and the next download has nothing to take.
        assert_eq!(flow.transport().asked.len(), 2);
        assert!(flow.found().is_none());
        assert!(download_with(&mut flow, Some("wpu1.second")).is_empty());
    }

    #[test]
    fn never_takes_a_pilot_download_to_the_mirror() {
        let mut flow = windows(Scripted {
            primary_feed: Some(Ok(feed("0.25.2"))),
            pilot_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            pilot_download: Some(Err(UpdateFailure::Transport)),
            mirror_feed: Some(Ok(feed("0.26.0-alpha.1"))),
            mirror_download: Some(Ok(PACKAGE.to_vec())),
            ..Scripted::default()
        });
        check_all(&mut flow, Some("wpu1.abc"));
        assert_eq!(
            download_with(&mut flow, Some("wpu1.abc")),
            vec![error(UpdateFailure::Transport)]
        );
        assert!(
            flow.transport()
                .asked
                .iter()
                .all(|asked| !asked.contains("Mirror"))
        );
    }

    #[test]
    fn says_each_failure_in_plain_words() {
        for failure in [
            UpdateFailure::Transport,
            UpdateFailure::Status(503),
            UpdateFailure::MissingFeed,
            UpdateFailure::Feed,
            UpdateFailure::Integrity,
            UpdateFailure::Signature,
            UpdateFailure::Cancelled,
            UpdateFailure::Disk,
            UpdateFailure::Other,
        ] {
            let message = failure_message(failure);
            assert!(message.ends_with('.'), "{message}");
            assert!(!message.contains("net::"), "{message}");
            assert!(!message.to_lowercase().contains("sha"), "{message}");
        }
        assert_eq!(
            failure_message(UpdateFailure::Status(503)),
            "The update server answered with an error (503)."
        );
    }

    // the platform's own check

    fn ready_to_download(package: &[u8]) -> UpdateFlow<Scripted> {
        let mut flow = flow(Scripted {
            primary_feed: Some(Ok(feed("0.26.0"))),
            primary_download: Some(Ok(package.to_vec())),
            mirror_feed: Some(Ok(feed("0.26.0"))),
            mirror_download: Some(Ok(package.to_vec())),
            ..Scripted::default()
        });
        check(&mut flow);
        flow
    }

    #[test]
    fn says_ready_only_after_the_platforms_own_check_passes() {
        let mut flow = ready_to_download(PACKAGE);
        let mut admitted = Vec::new();
        let mut seen = Vec::new();
        flow.download(
            &mut || None,
            &mut |info| {
                // Nothing has said "ready" yet when the check is asked.
                admitted.push(info.version.to_string());
                Ok(())
            },
            &mut |status| seen.push(status.clone()),
        );
        assert_eq!(admitted, ["0.26.0"]);
        assert_eq!(
            seen.last(),
            Some(&UpdateStatus::Downloaded {
                version: "0.26.0".to_string()
            })
        );
    }

    #[test]
    fn never_says_ready_for_an_update_the_platforms_check_refuses() {
        let mut flow = ready_to_download(PACKAGE);
        let mut seen = Vec::new();
        flow.download(
            &mut || None,
            &mut |_| Err(UpdateFailure::Signature),
            &mut |status| seen.push(status.clone()),
        );
        assert!(
            !seen
                .iter()
                .any(|status| matches!(status, UpdateStatus::Downloaded { .. }))
        );
        assert_eq!(seen.last(), Some(&error(UpdateFailure::Signature)));
        // It is not fetched again from the mirror: these were the
        // published bytes.
        assert_eq!(
            flow.transport().asked,
            [
                "feed Primary latest-mac.yml",
                "download Primary Videorc-0.26.0-mac-arm64.zip"
            ]
        );
        // A second try asks the check again, and may pass.
        let mut seen = Vec::new();
        flow.download(&mut || None, &mut |_| Ok(()), &mut |status| {
            seen.push(status.clone())
        });
        assert_eq!(
            seen.last(),
            Some(&UpdateStatus::Downloaded {
                version: "0.26.0".to_string()
            })
        );
    }

    #[test]
    fn does_not_ask_the_platforms_check_about_bytes_that_failed_the_hash() {
        let mut flow = ready_to_download(b"not what was published");
        let mut asked = 0;
        let mut seen = Vec::new();
        flow.download(
            &mut || None,
            &mut |_| {
                asked += 1;
                Ok(())
            },
            &mut |status| seen.push(status.clone()),
        );
        assert_eq!(asked, 0);
        assert_eq!(seen.last(), Some(&error(UpdateFailure::Integrity)));
    }
}
