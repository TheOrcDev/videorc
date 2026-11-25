//! What runs after the app quits (macOS): the helper's half of an update.
//!
//! "Restart to install" cannot be done by the app itself, since it is the
//! thing being replaced. Before it quits, the app starts a process that
//! outlives it, with the arguments [`ApplyPlan::to_arguments`] builds. That
//! process calls [`apply_update`], which:
//!
//! 1. waits until the app is gone, and gives up if it never goes;
//! 2. asks again whether the app can be replaced where it is;
//! 3. checks the unpacked app once more, signature and version, since time
//!    has passed since the download;
//! 4. swaps it in ([`crate::macos_install::swap_bundle`]);
//! 5. opens the app again when the streamer asked for a restart: the new
//!    one, or the old one when the update could not be installed.
//!
//! Which executable the helper is, and how the app starts it, are the
//! app's (S5.2a). So is the rule that none of this starts while a session
//! runs ([`crate::install`]).

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::macos_install::{
    LocationRefusal, SwapFailure, Swapped, UnpackFailure, bundle_version, install_location_refusal,
    stage_beside, swap_bundle, versions_agree,
};
use crate::signature::{SignatureFailure, SigningIdentity, verify_videorc_bundle};

/// The argument that makes a launch the helper's, and not the app's.
pub const APPLY_UPDATE_FLAG: &str = "--videorc-apply-update";
/// How long the helper waits for the app to be gone.
pub const APP_EXIT_TIMEOUT: Duration = Duration::from_secs(60);
/// How often it looks.
pub const APP_EXIT_POLL: Duration = Duration::from_millis(100);

/// What the helper was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPlan {
    /// The app's process, which must be gone before anything moves.
    pub app_pid: u32,
    /// The app to replace.
    pub installed: PathBuf,
    /// The unpacked update.
    pub staged: PathBuf,
    /// The version the feed promised.
    pub version: String,
    /// Whether the app opens again afterwards.
    pub relaunch: bool,
}

/// Why the arguments are not a plan. The helper does nothing then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    Missing(&'static str),
    Twice(&'static str),
    Unknown(String),
    Pid,
    /// A path that is not absolute, or not an app's.
    Path(&'static str),
    Version,
}

impl fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => write!(formatter, "the update helper was not told {name}"),
            Self::Twice(name) => write!(formatter, "the update helper was told {name} twice"),
            Self::Unknown(argument) => {
                write!(
                    formatter,
                    "the update helper does not know the argument {argument}"
                )
            }
            Self::Pid => formatter.write_str("the update helper was given no usable process id"),
            Self::Path(name) => {
                write!(
                    formatter,
                    "the update helper needs a whole path to an app for {name}"
                )
            }
            Self::Version => formatter.write_str("the update helper was given no version"),
        }
    }
}

impl std::error::Error for PlanError {}

fn is_app_path(path: &Path) -> bool {
    path.is_absolute() && path.extension().is_some_and(|extension| extension == "app")
}

impl ApplyPlan {
    /// The helper's arguments, the flag first.
    pub fn to_arguments(&self) -> Vec<OsString> {
        let mut arguments: Vec<OsString> = vec![
            APPLY_UPDATE_FLAG.into(),
            "--pid".into(),
            self.app_pid.to_string().into(),
            "--installed".into(),
            self.installed.clone().into(),
            "--staged".into(),
            self.staged.clone().into(),
            "--version".into(),
            self.version.clone().into(),
        ];
        if self.relaunch {
            arguments.push("--relaunch".into());
        }
        arguments
    }

    /// Reads a process's arguments, the program's own name left out.
    /// `Ok(None)` is a launch without the flag: the app itself. With the
    /// flag, anything but a whole plan is an error, so a helper never acts
    /// on half of one.
    pub fn from_arguments(
        arguments: impl IntoIterator<Item = OsString>,
    ) -> Result<Option<Self>, PlanError> {
        let mut arguments = arguments.into_iter();
        if !arguments
            .by_ref()
            .any(|argument| argument == APPLY_UPDATE_FLAG)
        {
            return Ok(None);
        }
        let (mut pid, mut installed, mut staged, mut version) = (None, None, None, None);
        let mut relaunch = false;
        while let Some(argument) = arguments.next() {
            let name: &'static str = match argument.to_str() {
                Some("--pid") => "--pid",
                Some("--installed") => "--installed",
                Some("--staged") => "--staged",
                Some("--version") => "--version",
                Some("--relaunch") if !relaunch => {
                    relaunch = true;
                    continue;
                }
                Some("--relaunch") => return Err(PlanError::Twice("--relaunch")),
                _ => return Err(PlanError::Unknown(argument.to_string_lossy().into_owned())),
            };
            let value = arguments.next().ok_or(PlanError::Missing(name))?;
            let slot = match name {
                "--pid" => &mut pid,
                "--installed" => &mut installed,
                "--staged" => &mut staged,
                _ => &mut version,
            };
            if slot.replace(value).is_some() {
                return Err(PlanError::Twice(name));
            }
        }

        let app_pid = pid
            .ok_or(PlanError::Missing("--pid"))?
            .to_str()
            .and_then(|text| text.parse::<u32>().ok())
            // 0 is "every process of this group" to `kill`, and 1 is launchd.
            .filter(|pid| *pid > 1 && i32::try_from(*pid).is_ok())
            .ok_or(PlanError::Pid)?;
        let installed = PathBuf::from(installed.ok_or(PlanError::Missing("--installed"))?);
        if !is_app_path(&installed) {
            return Err(PlanError::Path("--installed"));
        }
        let staged = PathBuf::from(staged.ok_or(PlanError::Missing("--staged"))?);
        if !is_app_path(&staged) || staged == installed {
            return Err(PlanError::Path("--staged"));
        }
        let version = version
            .ok_or(PlanError::Missing("--version"))?
            .into_string()
            .ok()
            .filter(|version| !version.trim().is_empty())
            .ok_or(PlanError::Version)?;
        Ok(Some(Self {
            app_pid,
            installed,
            staged,
            version,
            relaunch,
        }))
    }
}

/// Whether a process with this id exists.
pub fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only asks whether `pid` exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    // "Not allowed" still means it is there.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Waits until the process is gone. `false` when it is still there after
/// `timeout`.
pub fn wait_for_exit(pid: u32, timeout: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_is_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(poll);
    }
}

/// The helper's dealings with the system, so that a test can stand in.
pub trait ApplySystem {
    /// Whether the app's process went away in time.
    fn wait_for_exit(&mut self, pid: u32) -> bool;
    /// Whether the bundle is Videorc's.
    fn verify(&mut self, bundle: &Path) -> Result<(), SignatureFailure>;
    fn swap(&mut self, installed: &Path, staged: &Path) -> Result<Swapped, SwapFailure> {
        swap_bundle(installed, staged)
    }
    /// Opens the app. `false` when it could not be opened.
    fn open(&mut self, bundle: &Path) -> bool;
}

/// The real thing.
pub struct MacSystem {
    pub identity: SigningIdentity,
    pub exit_timeout: Duration,
    pub exit_poll: Duration,
}

impl MacSystem {
    pub fn new(identity: SigningIdentity) -> Self {
        Self {
            identity,
            exit_timeout: APP_EXIT_TIMEOUT,
            exit_poll: APP_EXIT_POLL,
        }
    }
}

impl ApplySystem for MacSystem {
    fn wait_for_exit(&mut self, pid: u32) -> bool {
        wait_for_exit(pid, self.exit_timeout, self.exit_poll)
    }

    fn verify(&mut self, bundle: &Path) -> Result<(), SignatureFailure> {
        verify_videorc_bundle(bundle, &self.identity)
    }

    fn open(&mut self, bundle: &Path) -> bool {
        // `-n`: a new instance, even while the system still lists the one
        // that just quit.
        Command::new("/usr/bin/open")
            .arg("-n")
            .arg(bundle)
            .status()
            .is_ok_and(|status| status.success())
    }
}

/// Why the update was not installed. The old app is in place in every
/// case but a [`SwapFailure::Failed`] that says otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyFailure {
    /// The app never quit, so nothing was touched.
    AppStillRunning,
    Location(LocationRefusal),
    Signature(SignatureFailure),
    /// The unpacked app is not the release the feed promised.
    Version {
        found: Option<String>,
    },
    /// The copy beside the app, for an update on another volume, could not
    /// be made.
    Staging(UnpackFailure),
    Swap(SwapFailure),
}

impl fmt::Display for ApplyFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AppStillRunning => {
                formatter.write_str("Videorc did not quit, so the update was not installed")
            }
            Self::Location(refusal) => write!(formatter, "{refusal}"),
            Self::Signature(failure) => {
                write!(formatter, "the update was not installed: {failure}")
            }
            Self::Version { found: Some(found) } => {
                write!(
                    formatter,
                    "the update was not installed: it is version {found}"
                )
            }
            Self::Version { found: None } => {
                formatter.write_str("the update was not installed: it does not say its version")
            }
            Self::Staging(failure) => write!(formatter, "the update was not installed: {failure}"),
            Self::Swap(failure) => write!(formatter, "{failure}"),
        }
    }
}

impl std::error::Error for ApplyFailure {}

/// How the helper's run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// `None` when the new app is in place.
    pub failure: Option<ApplyFailure>,
    /// Whether the old app is gone from the disk after a swap that worked.
    pub old_app_removed: bool,
    /// Whether the app was opened again: the new one, or the old one when
    /// the update was not installed.
    pub opened: bool,
}

/// Whether `bundle` is Videorc's and is the release the feed promised.
fn check_bundle(
    plan: &ApplyPlan,
    bundle: &Path,
    system: &mut dyn ApplySystem,
) -> Result<(), ApplyFailure> {
    system.verify(bundle).map_err(ApplyFailure::Signature)?;
    match bundle_version(bundle) {
        Some(found) if versions_agree(&found, &plan.version) => Ok(()),
        found => Err(ApplyFailure::Version { found }),
    }
}

/// Checks the unpacked app and swaps it in. The copy that is swapped in is
/// the copy that was checked.
fn check_and_swap(plan: &ApplyPlan, system: &mut dyn ApplySystem) -> Result<Swapped, ApplyFailure> {
    if let Some(refusal) = install_location_refusal(&plan.installed) {
        return Err(ApplyFailure::Location(refusal));
    }
    check_bundle(plan, &plan.staged, system)?;
    match system.swap(&plan.installed, &plan.staged) {
        Ok(swapped) => Ok(swapped),
        Err(SwapFailure::OtherVolume) => {
            let copy =
                stage_beside(&plan.installed, &plan.staged).map_err(ApplyFailure::Staging)?;
            let swapped = match check_bundle(plan, &copy, system) {
                Ok(()) => system
                    .swap(&plan.installed, &copy)
                    .map_err(ApplyFailure::Swap),
                Err(failure) => Err(failure),
            };
            if swapped.is_err() {
                let _ = fs::remove_dir_all(&copy);
            }
            swapped
        }
        Err(failure) => Err(ApplyFailure::Swap(failure)),
    }
}

/// The helper's whole run.
pub fn apply_update(plan: &ApplyPlan, system: &mut dyn ApplySystem) -> ApplyOutcome {
    if !system.wait_for_exit(plan.app_pid) {
        // The app is still there: nothing moves, and nothing is opened
        // over it.
        return ApplyOutcome {
            failure: Some(ApplyFailure::AppStillRunning),
            old_app_removed: false,
            opened: false,
        };
    }
    let result = check_and_swap(plan, system);
    if result.is_ok() {
        // Leave nothing of the update behind: what is left of the unpacked
        // app, then its folder when that is empty.
        let _ = fs::remove_dir_all(&plan.staged);
        if let Some(folder) = plan.staged.parent() {
            let _ = fs::remove_dir(folder);
        }
    }
    // A failed swap that did not put the old app back leaves nothing to
    // open.
    let app_in_place = !matches!(
        result,
        Err(ApplyFailure::Swap(SwapFailure::Failed {
            old_app_restored: false,
            ..
        }))
    );
    let opened = plan.relaunch && app_in_place && system.open(&plan.installed);
    match result {
        Ok(swapped) => ApplyOutcome {
            failure: None,
            old_app_removed: swapped.old_app_removed,
            opened,
        },
        Err(failure) => ApplyOutcome {
            failure: Some(failure),
            old_app_removed: false,
            opened,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A folder of this test's own, removed when it goes out of scope.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "videorc-updater-apply-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make_bundle(bundle: &Path, version: &str) {
        let contents = bundle.join("Contents");
        fs::create_dir_all(contents.join("MacOS")).unwrap();
        fs::write(
            contents.join("Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>CFBundleShortVersionString</key><string>{version}</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        let executable = contents.join("MacOS").join("Test");
        fs::write(&executable, format!("#!/bin/sh\necho {version}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn said(bundle: &Path) -> String {
        fs::read_to_string(bundle.join("Contents").join("MacOS").join("Test")).unwrap()
    }

    /// An installed 1.0.0, an unpacked 2.0.0, and the plan to swap them.
    fn fixture(scratch: &Scratch) -> ApplyPlan {
        let installed = scratch.0.join("Applications").join("Videorc.app");
        let staged = scratch.0.join("update").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");
        ApplyPlan {
            app_pid: 4242,
            installed,
            staged,
            version: "2.0.0".to_string(),
            relaunch: true,
        }
    }

    /// Stands in for the system, and keeps what it was asked.
    struct FakeSystem {
        app_exits: bool,
        refuse_signature: bool,
        other_volume_once: bool,
        open_works: bool,
        calls: Vec<String>,
    }

    impl Default for FakeSystem {
        fn default() -> Self {
            Self {
                app_exits: true,
                refuse_signature: false,
                other_volume_once: false,
                open_works: true,
                calls: Vec::new(),
            }
        }
    }

    fn name_of(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    impl ApplySystem for FakeSystem {
        fn wait_for_exit(&mut self, pid: u32) -> bool {
            self.calls.push(format!("wait {pid}"));
            self.app_exits
        }

        fn verify(&mut self, bundle: &Path) -> Result<(), SignatureFailure> {
            self.calls.push(format!("verify {}", name_of(bundle)));
            if self.refuse_signature {
                return Err(SignatureFailure::Refused(
                    "code object is not signed at all".into(),
                ));
            }
            Ok(())
        }

        fn swap(&mut self, installed: &Path, staged: &Path) -> Result<Swapped, SwapFailure> {
            self.calls.push(format!("swap {}", name_of(staged)));
            if self.other_volume_once {
                self.other_volume_once = false;
                return Err(SwapFailure::OtherVolume);
            }
            swap_bundle(installed, staged)
        }

        fn open(&mut self, bundle: &Path) -> bool {
            self.calls
                .push(format!("open {}", said(bundle).trim().replace('\n', " ")));
            self.open_works
        }
    }

    // the arguments

    #[test]
    fn carries_a_plan_through_the_arguments_and_back() {
        let plan = ApplyPlan {
            app_pid: 4242,
            installed: PathBuf::from("/Applications/Videorc.app"),
            staged: PathBuf::from("/Users/a b/Library/Caches/update/Videorc.app"),
            version: "0.27.0".to_string(),
            relaunch: true,
        };
        let arguments = plan.to_arguments();
        assert_eq!(arguments[0], APPLY_UPDATE_FLAG);
        assert_eq!(ApplyPlan::from_arguments(arguments), Ok(Some(plan.clone())));

        let quiet = ApplyPlan {
            relaunch: false,
            ..plan
        };
        assert!(!quiet.to_arguments().contains(&OsString::from("--relaunch")));
        assert_eq!(
            ApplyPlan::from_arguments(quiet.to_arguments()),
            Ok(Some(quiet))
        );
    }

    fn parse(arguments: &[&str]) -> Result<Option<ApplyPlan>, PlanError> {
        ApplyPlan::from_arguments(arguments.iter().map(OsString::from))
    }

    #[test]
    fn is_the_app_itself_without_the_flag() {
        assert_eq!(parse(&[]), Ok(None));
        assert_eq!(parse(&["--profile", "work"]), Ok(None));
        // The flag's own arguments alone do nothing.
        assert_eq!(parse(&["--pid", "4242", "--relaunch"]), Ok(None));
        // What the app was started with before the flag is not the helper's.
        let plan = parse(&[
            "--profile",
            "work",
            APPLY_UPDATE_FLAG,
            "--version",
            "2.0.0",
            "--staged",
            "/tmp/u/Videorc.app",
            "--installed",
            "/Applications/Videorc.app",
            "--pid",
            "77",
        ]);
        assert_eq!(
            plan,
            Ok(Some(ApplyPlan {
                app_pid: 77,
                installed: PathBuf::from("/Applications/Videorc.app"),
                staged: PathBuf::from("/tmp/u/Videorc.app"),
                version: "2.0.0".to_string(),
                relaunch: false,
            }))
        );
    }

    #[test]
    fn never_acts_on_half_a_plan() {
        let whole = [
            APPLY_UPDATE_FLAG,
            "--pid",
            "77",
            "--installed",
            "/Applications/Videorc.app",
            "--staged",
            "/tmp/u/Videorc.app",
            "--version",
            "2.0.0",
        ];
        assert!(parse(&whole).unwrap().is_some());

        // Each pair taken out in turn.
        for (at, name) in [
            (1, "--pid"),
            (3, "--installed"),
            (5, "--staged"),
            (7, "--version"),
        ] {
            let mut short = whole.to_vec();
            short.drain(at..at + 2);
            assert_eq!(parse(&short), Err(PlanError::Missing(name)), "{name}");
        }
        assert_eq!(parse(&whole[..8]), Err(PlanError::Missing("--version")));

        let with = |extra: &[&'static str]| {
            let mut arguments = whole.to_vec();
            arguments.extend_from_slice(extra);
            parse(&arguments)
        };
        assert_eq!(with(&["--pid", "78"]), Err(PlanError::Twice("--pid")));
        assert_eq!(
            with(&["--relaunch", "--relaunch"]),
            Err(PlanError::Twice("--relaunch"))
        );
        assert_eq!(
            with(&["--force"]),
            Err(PlanError::Unknown("--force".to_string()))
        );
        assert_eq!(
            with(&["extra"]),
            Err(PlanError::Unknown("extra".to_string()))
        );

        let swapped = |at: usize, value: &'static str| {
            let mut arguments = whole.to_vec();
            arguments[at] = value;
            parse(&arguments)
        };
        for pid in ["0", "1", "-5", "abc", "", "4294967295", "99999999999"] {
            assert_eq!(swapped(2, pid), Err(PlanError::Pid), "{pid}");
        }
        for path in [
            "Videorc.app",
            "/Applications/Videorc",
            "",
            "/Applications/Videorc.app/x",
        ] {
            assert_eq!(
                swapped(4, path),
                Err(PlanError::Path("--installed")),
                "{path}"
            );
            assert_eq!(swapped(6, path), Err(PlanError::Path("--staged")), "{path}");
        }
        // The update cannot be the app it replaces.
        assert_eq!(
            swapped(6, "/Applications/Videorc.app"),
            Err(PlanError::Path("--staged"))
        );
        assert_eq!(swapped(8, " "), Err(PlanError::Version));
    }

    // the wait

    #[test]
    fn waits_until_a_process_is_gone() {
        assert!(process_is_alive(std::process::id()));
        assert!(!process_is_alive(0));
        assert!(!process_is_alive(u32::MAX));

        let mut child = Command::new("/bin/sleep").arg("0.3").spawn().unwrap();
        let pid = child.id();
        assert!(process_is_alive(pid));
        // A child that ended stays listed until its parent collects it.
        let reaper = std::thread::spawn(move || child.wait());
        assert!(wait_for_exit(
            pid,
            Duration::from_secs(10),
            Duration::from_millis(20)
        ));
        assert!(!process_is_alive(pid));
        reaper.join().unwrap().unwrap();
    }

    #[test]
    fn gives_up_on_a_process_that_stays() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let started = Instant::now();
        let gone = wait_for_exit(
            child.id(),
            Duration::from_millis(150),
            Duration::from_millis(20),
        );
        let waited = started.elapsed();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!gone);
        assert!(waited >= Duration::from_millis(150), "{waited:?}");
        assert!(waited < Duration::from_secs(10), "{waited:?}");
    }

    // the run

    #[test]
    fn installs_the_update_and_opens_the_new_app() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let mut system = FakeSystem::default();
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome,
            ApplyOutcome {
                failure: None,
                old_app_removed: true,
                opened: true
            }
        );
        assert_eq!(
            system.calls,
            [
                "wait 4242",
                "verify Videorc.app",
                "swap Videorc.app",
                "open #!/bin/sh echo 2.0.0"
            ]
        );
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 2.0.0\n");
        // Nothing of the update is left behind.
        assert!(!scratch.0.join("update").exists());
    }

    #[test]
    fn installs_without_opening_when_no_restart_was_asked_for() {
        let scratch = Scratch::new();
        let plan = ApplyPlan {
            relaunch: false,
            ..fixture(&scratch)
        };
        let mut system = FakeSystem::default();
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome,
            ApplyOutcome {
                failure: None,
                old_app_removed: true,
                opened: false
            }
        );
        assert!(!system.calls.iter().any(|call| call.starts_with("open")));
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 2.0.0\n");
    }

    #[test]
    fn touches_nothing_while_the_app_is_still_running() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let mut system = FakeSystem {
            app_exits: false,
            ..FakeSystem::default()
        };
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(outcome.failure, Some(ApplyFailure::AppStillRunning));
        assert!(!outcome.opened);
        assert_eq!(system.calls, ["wait 4242"]);
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 1.0.0\n");
        assert_eq!(said(&plan.staged), "#!/bin/sh\necho 2.0.0\n");
    }

    #[test]
    fn refuses_an_update_that_is_not_videorcs_and_opens_the_old_app() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let mut system = FakeSystem {
            refuse_signature: true,
            ..FakeSystem::default()
        };
        let outcome = apply_update(&plan, &mut system);
        assert!(
            matches!(outcome.failure, Some(ApplyFailure::Signature(_))),
            "{:?}",
            outcome.failure
        );
        assert!(outcome.opened);
        assert_eq!(
            system.calls,
            [
                "wait 4242",
                "verify Videorc.app",
                "open #!/bin/sh echo 1.0.0"
            ]
        );
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 1.0.0\n");
    }

    #[test]
    fn refuses_an_update_that_is_not_the_version_the_feed_promised() {
        let scratch = Scratch::new();
        let plan = ApplyPlan {
            version: "2.1.0".to_string(),
            ..fixture(&scratch)
        };
        let mut system = FakeSystem::default();
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome.failure,
            Some(ApplyFailure::Version {
                found: Some("2.0.0".to_string())
            })
        );
        assert!(!system.calls.iter().any(|call| call.starts_with("swap")));
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 1.0.0\n");

        // An unpacked app that does not say its version is refused too.
        fs::remove_file(plan.staged.join("Contents").join("Info.plist")).unwrap();
        let outcome = apply_update(&plan, &mut FakeSystem::default());
        assert_eq!(outcome.failure, Some(ApplyFailure::Version { found: None }));
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 1.0.0\n");
    }

    #[test]
    fn refuses_an_app_that_cannot_be_replaced_where_it_is() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let translocated = scratch
            .0
            .join("AppTranslocation")
            .join("X")
            .join("d")
            .join("Videorc.app");
        make_bundle(&translocated, "1.0.0");
        let plan = ApplyPlan {
            installed: translocated,
            ..plan
        };
        let mut system = FakeSystem::default();
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome.failure,
            Some(ApplyFailure::Location(LocationRefusal::Translocated))
        );
        // Not even the signature is asked about.
        assert_eq!(system.calls, ["wait 4242", "open #!/bin/sh echo 1.0.0"]);
    }

    #[test]
    fn checks_the_copy_it_makes_for_an_update_on_another_volume() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let mut system = FakeSystem {
            other_volume_once: true,
            ..FakeSystem::default()
        };
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome,
            ApplyOutcome {
                failure: None,
                old_app_removed: true,
                opened: true
            }
        );
        assert_eq!(
            system.calls,
            [
                "wait 4242",
                "verify Videorc.app",
                "swap Videorc.app",
                "verify .Videorc.app.update",
                "swap .Videorc.app.update",
                "open #!/bin/sh echo 2.0.0",
            ]
        );
        assert_eq!(said(&plan.installed), "#!/bin/sh\necho 2.0.0\n");
        // Neither the copy nor the unpacked app is left.
        let mut left: Vec<String> = fs::read_dir(scratch.0.join("Applications"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["Videorc.app"]);
        assert!(!scratch.0.join("update").exists());
    }

    #[test]
    fn reports_an_app_that_would_not_open() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);
        let mut system = FakeSystem {
            open_works: false,
            ..FakeSystem::default()
        };
        let outcome = apply_update(&plan, &mut system);
        assert_eq!(
            outcome,
            ApplyOutcome {
                failure: None,
                old_app_removed: true,
                opened: false
            }
        );
    }

    #[test]
    fn opens_nothing_when_the_old_app_could_not_be_put_back() {
        let scratch = Scratch::new();
        let plan = fixture(&scratch);

        /// A swap that lost the app.
        struct Lost(Vec<String>);
        impl ApplySystem for Lost {
            fn wait_for_exit(&mut self, _: u32) -> bool {
                true
            }
            fn verify(&mut self, _: &Path) -> Result<(), SignatureFailure> {
                Ok(())
            }
            fn swap(&mut self, _: &Path, _: &Path) -> Result<Swapped, SwapFailure> {
                Err(SwapFailure::Failed {
                    detail: "disk error".into(),
                    old_app_restored: false,
                })
            }
            fn open(&mut self, _: &Path) -> bool {
                self.0.push("open".to_string());
                true
            }
        }
        let mut system = Lost(Vec::new());
        let outcome = apply_update(&plan, &mut system);
        assert!(
            matches!(outcome.failure, Some(ApplyFailure::Swap(_))),
            "{:?}",
            outcome.failure
        );
        assert!(!outcome.opened);
        assert!(system.0.is_empty());
        // The unpacked app is kept: it is the only whole copy left.
        assert_eq!(said(&plan.staged), "#!/bin/sh\necho 2.0.0\n");
    }

    #[test]
    fn says_each_failure_in_words() {
        for (failure, words) in [
            (
                ApplyFailure::AppStillRunning,
                "Videorc did not quit, so the update was not installed",
            ),
            (
                ApplyFailure::Version {
                    found: Some("2.0.0".into()),
                },
                "the update was not installed: it is version 2.0.0",
            ),
            (
                ApplyFailure::Version { found: None },
                "the update was not installed: it does not say its version",
            ),
            (
                ApplyFailure::Swap(SwapFailure::OtherVolume),
                "the update is on another volume than the app",
            ),
        ] {
            assert_eq!(failure.to_string(), words);
        }
        assert_eq!(
            PlanError::Missing("--pid").to_string(),
            "the update helper was not told --pid"
        );
    }
}
