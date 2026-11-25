//! Putting a downloaded update in place (macOS).
//!
//! Electron leaves this to Squirrel.Mac. The Rust app does it itself, in
//! this order, for a zip that already passed the feed's size and SHA-512
//! check ([`crate::feed::verify_download`]):
//!
//! 1. Is this copy of the app one that can be replaced at all
//!    ([`install_location_refusal`])? If not, nothing is downloaded.
//! 2. Unpack the zip and find the one app in it ([`unpack_update`]).
//! 3. Check that app: its signature
//!    ([`crate::signature::verify_videorc_bundle`]) and its version
//!    ([`bundle_version`], [`versions_agree`]). [`prepare_update`] does 2
//!    and 3 in the updater's own staging folder, and leaves nothing there
//!    that failed a check.
//! 4. At quit, from a helper that outlives the app, swap it in
//!    ([`swap_bundle`]). When the swap fails the old app is back in its
//!    place, or was never moved.
//!
//! The helper, the wait for the app to quit and the relaunch are the app's
//! (S5.2a). So is the rule that the swap never runs while a session does
//! ([`crate::install`]).
//!
//! The zip is unpacked by `ditto`, as Squirrel.Mac unpacks it. Nothing in
//! the unpacked folder is opened or run before the signature check passes.

use std::ffi::CString;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use semver::Version;

use crate::signature::SignatureFailure;

/// Why this copy of the app cannot replace itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationRefusal {
    /// It is not an app bundle: a build run from its build folder.
    NotABundle,
    /// macOS runs it from a read-only copy of its own ("translocation"),
    /// because it was opened where it was downloaded and never moved.
    Translocated,
    /// The folder it is in cannot be changed: a disk image, or a folder
    /// this account may not write to. That folder can be Applications
    /// itself, on an account that is not an administrator's, so the
    /// sentence does not only say "move it to Applications".
    FolderNotWritable,
}

impl fmt::Display for LocationRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotABundle => "This build doesn't update itself.",
            Self::Translocated => {
                "Move Videorc to the Applications folder and open it from there. Then it can update itself."
            }
            Self::FolderNotWritable => {
                "Videorc can't update itself here: the folder it is in can't be changed. Move Videorc to the Applications folder, or to a folder you can change, then check again."
            }
        })
    }
}

/// The bundle an executable runs from: `…/Videorc.app` for
/// `…/Videorc.app/Contents/MacOS/Videorc`. `None` for anything else.
pub fn bundle_of_executable(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let shaped = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    shaped.then(|| bundle.to_path_buf())
}

/// What the bundle's path alone says. Touches no disk.
pub fn bundle_path_refusal(bundle: &Path) -> Option<LocationRefusal> {
    if bundle
        .extension()
        .is_none_or(|extension| extension != "app")
    {
        return Some(LocationRefusal::NotABundle);
    }
    let translocated = bundle.components().any(
        |component| matches!(component, Component::Normal(name) if name == "AppTranslocation"),
    );
    translocated.then_some(LocationRefusal::Translocated)
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a path with a NUL byte"))
}

/// Whether this account may add and remove entries in `folder`.
fn folder_is_writable(folder: &Path) -> bool {
    let Ok(folder) = c_path(folder) else {
        return false;
    };
    // SAFETY: `folder` is a valid NUL-terminated string for the call.
    unsafe { libc::access(folder.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

/// Whether the app at `bundle` can be replaced where it is. `None` means
/// it can.
pub fn install_location_refusal(bundle: &Path) -> Option<LocationRefusal> {
    if let Some(refusal) = bundle_path_refusal(bundle) {
        return Some(refusal);
    }
    let writable = bundle.parent().is_some_and(folder_is_writable);
    (!writable).then_some(LocationRefusal::FolderNotWritable)
}

/// Why a zip did not give one app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnpackFailure {
    /// The folder to unpack into could not be made, or is not empty.
    Folder(String),
    /// `ditto` could not be run.
    Tool(String),
    /// `ditto` refused the zip. The text is its own.
    Refused(String),
    /// There is no app at the top of the zip.
    NoApp,
    /// There is more than one.
    SeveralApps,
}

impl fmt::Display for UnpackFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Folder(detail) => {
                write!(formatter, "the update's folder is not usable: {detail}")
            }
            Self::Tool(detail) => write!(formatter, "ditto could not run: {detail}"),
            Self::Refused(detail) => {
                write!(formatter, "the update could not be unpacked: {detail}")
            }
            Self::NoApp => formatter.write_str("the update holds no app"),
            Self::SeveralApps => formatter.write_str("the update holds more than one app"),
        }
    }
}

impl std::error::Error for UnpackFailure {}

/// The one app at the top of `folder`. A link is never taken for an app,
/// and `__MACOSX` and hidden entries are passed over.
pub fn find_unpacked_bundle(folder: &Path) -> Result<PathBuf, UnpackFailure> {
    let entries = fs::read_dir(folder).map_err(|error| UnpackFailure::Folder(error.to_string()))?;
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(|error| UnpackFailure::Folder(error.to_string()))?;
        let path = entry.path();
        let name = entry.file_name();
        let hidden = name.as_bytes().starts_with(b".") || name == "__MACOSX";
        if hidden || path.extension().is_none_or(|extension| extension != "app") {
            continue;
        }
        // `symlink_metadata` does not follow a link.
        let is_real_folder = fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir());
        if !is_real_folder {
            continue;
        }
        if found.is_some() {
            return Err(UnpackFailure::SeveralApps);
        }
        found = Some(path);
    }
    found.ok_or(UnpackFailure::NoApp)
}

/// Unpacks the update's zip into `folder`, which must be new or empty, and
/// returns the app it holds.
pub fn unpack_update(zip: &Path, folder: &Path) -> Result<PathBuf, UnpackFailure> {
    fs::create_dir_all(folder).map_err(|error| UnpackFailure::Folder(error.to_string()))?;
    let is_empty = fs::read_dir(folder)
        .map_err(|error| UnpackFailure::Folder(error.to_string()))?
        .next()
        .is_none();
    if !is_empty {
        return Err(UnpackFailure::Folder("it is not empty".to_string()));
    }
    let output = Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(folder)
        .output()
        .map_err(|error| UnpackFailure::Tool(error.to_string()))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        let detail = said
            .lines()
            .last()
            .unwrap_or("no reason given")
            .trim()
            .to_string();
        return Err(UnpackFailure::Refused(detail));
    }
    find_unpacked_bundle(folder)
}

/// The version a bundle says it is (`CFBundleShortVersionString`), read by
/// `plutil`, which reads both spellings of a property list. `None` when the
/// bundle does not say.
pub fn bundle_version(bundle: &Path) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(bundle.join("Contents").join("Info.plist"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Whether an unpacked bundle is the release the feed promised. A bundle
/// carries its package version (0.27.0) for the release it shipped as
/// (0.27.0-beta.1), so the numbers must agree and the rest is not compared.
pub fn versions_agree(bundle_version: &str, feed_version: &str) -> bool {
    let (Ok(bundle), Ok(feed)) = (
        Version::parse(bundle_version.trim()),
        Version::parse(feed_version.trim()),
    ) else {
        return false;
    };
    (bundle.major, bundle.minor, bundle.patch) == (feed.major, feed.minor, feed.patch)
}

/// The name of the folder updates are unpacked in. [`clear_staging`]
/// empties only a folder of this name.
pub const STAGING_FOLDER_NAME: &str = "videorc-update";

/// Where updates are unpacked: a folder of the updater's own inside the
/// app's cache folder.
pub fn staging_root(cache_folder: &Path) -> PathBuf {
    cache_folder.join(STAGING_FOLDER_NAME)
}

/// Removes everything in the staging folder: an update that was never
/// installed, or one that was refused. Only a folder named
/// [`STAGING_FOLDER_NAME`] is ever emptied, so a wrong path cannot cost
/// the streamer anything else. A link is removed as a link; what it points
/// at is left alone.
pub fn clear_staging(staging: &Path) -> io::Result<()> {
    if staging
        .file_name()
        .is_none_or(|name| name != STAGING_FOLDER_NAME)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not the updater's staging folder",
        ));
    }
    match fs::symlink_metadata(staging) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() => return fs::remove_file(staging),
        Ok(_) => {}
    }
    for entry in fs::read_dir(staging)? {
        let path = entry?.path();
        if is_real_folder(&path) {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Why a download did not become an update that is ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareFailure {
    /// The staging folder could not be emptied.
    Staging(String),
    Unpack(UnpackFailure),
    Signature(SignatureFailure),
    /// The app in the zip is not the release the feed promised.
    Version {
        found: Option<String>,
    },
}

impl fmt::Display for PrepareFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Staging(detail) => {
                write!(
                    formatter,
                    "the update's folder could not be emptied: {detail}"
                )
            }
            Self::Unpack(failure) => write!(formatter, "{failure}"),
            Self::Signature(failure) => write!(formatter, "{failure}"),
            Self::Version { found: Some(found) } => {
                write!(
                    formatter,
                    "the update is version {found}, not the one that was published"
                )
            }
            Self::Version { found: None } => {
                formatter.write_str("the update does not say which version it is")
            }
        }
    }
}

impl std::error::Error for PrepareFailure {}

fn unpack_and_check(
    zip: &Path,
    folder: &Path,
    feed_version: &str,
    verify: &mut dyn FnMut(&Path) -> Result<(), SignatureFailure>,
) -> Result<PathBuf, PrepareFailure> {
    let bundle = unpack_update(zip, folder).map_err(PrepareFailure::Unpack)?;
    verify(&bundle).map_err(PrepareFailure::Signature)?;
    match bundle_version(&bundle) {
        Some(found) if versions_agree(&found, feed_version) => Ok(bundle),
        found => Err(PrepareFailure::Version { found }),
    }
}

/// Makes a checked download ready to install: unpacks it in the staging
/// folder and checks the app in it, its signature first and then its
/// version. `verify` is the signature check
/// ([`crate::signature::verify_videorc_bundle`] with the app's identity).
///
/// The staging folder is emptied first, so an older update never waits
/// beside a newer one, and emptied again on any refusal, so nothing that
/// failed a check stays on disk. Returns the app that is ready.
pub fn prepare_update(
    zip: &Path,
    staging: &Path,
    feed_version: &str,
    verify: &mut dyn FnMut(&Path) -> Result<(), SignatureFailure>,
) -> Result<PathBuf, PrepareFailure> {
    clear_staging(staging).map_err(|error| PrepareFailure::Staging(error.to_string()))?;
    let ready = unpack_and_check(zip, &staging.join("unpacked"), feed_version, verify);
    if ready.is_err() {
        let _ = clear_staging(staging);
    }
    ready
}

/// The three moves a swap is made of.
pub trait BundleMoves {
    /// Exchanges two entries in one step.
    fn exchange(&mut self, first: &Path, second: &Path) -> io::Result<()>;
    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove(&mut self, bundle: &Path) -> io::Result<()>;
}

/// The moves, made by the system.
pub struct SystemMoves;

impl BundleMoves for SystemMoves {
    fn exchange(&mut self, first: &Path, second: &Path) -> io::Result<()> {
        let (first, second) = (c_path(first)?, c_path(second)?);
        // SAFETY: both are valid NUL-terminated strings for the call.
        let answer =
            unsafe { libc::renamex_np(first.as_ptr(), second.as_ptr(), libc::RENAME_SWAP) };
        if answer == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn remove(&mut self, bundle: &Path) -> io::Result<()> {
        fs::remove_dir_all(bundle)
    }
}

/// Why the new app is not in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapFailure {
    /// Nothing was moved.
    NotStarted(String),
    /// The new app is on another volume than the installed one. Nothing
    /// was moved. Stage it beside the app ([`stage_beside`]), check that
    /// copy, and swap again.
    OtherVolume,
    /// The old app was moved aside and the new one could not take its
    /// place. `old_app_restored` says whether the old app is back.
    Failed {
        detail: String,
        old_app_restored: bool,
    },
}

impl fmt::Display for SwapFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotStarted(detail) => write!(formatter, "the update was not installed: {detail}"),
            Self::OtherVolume => {
                formatter.write_str("the update is on another volume than the app")
            }
            Self::Failed {
                detail,
                old_app_restored: true,
            } => {
                write!(
                    formatter,
                    "the update could not be installed, and the app is as it was: {detail}"
                )
            }
            Self::Failed {
                detail,
                old_app_restored: false,
            } => {
                write!(
                    formatter,
                    "the update could not be installed, and the app was not put back: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for SwapFailure {}

/// A swap that worked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Swapped {
    /// Whether the old app is gone from the disk. When it is not, it lies
    /// where the new one was staged, or aside under a hidden name, and the
    /// next swap removes it.
    pub old_app_removed: bool,
}

fn is_real_folder(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// Where the old app waits during a swap in two steps: beside the app,
/// hidden.
fn aside_path(installed: &Path) -> Option<PathBuf> {
    let mut name = std::ffi::OsString::from(".");
    name.push(installed.file_name()?);
    name.push(".previous");
    Some(installed.parent()?.join(name))
}

/// Puts the app at `staged` where the app at `installed` is.
///
/// On a file system that can exchange two entries in one step (APFS, HFS+)
/// there is no moment without an app at `installed`. Elsewhere the old app
/// is moved aside first, and moved back when the new one cannot take its
/// place.
pub fn swap_bundle_with(
    moves: &mut dyn BundleMoves,
    installed: &Path,
    staged: &Path,
) -> Result<Swapped, SwapFailure> {
    if !is_real_folder(installed) {
        return Err(SwapFailure::NotStarted(
            "there is no installed app to replace".to_string(),
        ));
    }
    if !is_real_folder(staged) {
        return Err(SwapFailure::NotStarted(
            "there is no unpacked app to install".to_string(),
        ));
    }

    match moves.exchange(staged, installed) {
        Ok(()) => {
            // The old app is now where the new one was.
            return Ok(Swapped {
                old_app_removed: moves.remove(staged).is_ok(),
            });
        }
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            return Err(SwapFailure::OtherVolume);
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTSUP) | Some(libc::EINVAL)
            ) => {}
        Err(error) => return Err(SwapFailure::NotStarted(error.to_string())),
    }

    // This file system cannot exchange. Two steps, with the way back.
    let aside = aside_path(installed)
        .ok_or_else(|| SwapFailure::NotStarted("the app has no folder around it".to_string()))?;
    if fs::symlink_metadata(&aside).is_ok() {
        // Left by a swap that could not tidy up.
        moves.remove(&aside).map_err(|error| {
            SwapFailure::NotStarted(format!("an old copy is in the way: {error}"))
        })?;
    }
    if let Err(error) = moves.rename(installed, &aside) {
        return Err(if error.raw_os_error() == Some(libc::EXDEV) {
            SwapFailure::OtherVolume
        } else {
            SwapFailure::NotStarted(error.to_string())
        });
    }
    if let Err(error) = moves.rename(staged, installed) {
        let old_app_restored = moves.rename(&aside, installed).is_ok();
        return Err(
            if old_app_restored && error.raw_os_error() == Some(libc::EXDEV) {
                SwapFailure::OtherVolume
            } else {
                SwapFailure::Failed {
                    detail: error.to_string(),
                    old_app_restored,
                }
            },
        );
    }
    Ok(Swapped {
        old_app_removed: moves.remove(&aside).is_ok(),
    })
}

/// [`swap_bundle_with`], with the system's moves.
pub fn swap_bundle(installed: &Path, staged: &Path) -> Result<Swapped, SwapFailure> {
    swap_bundle_with(&mut SystemMoves, installed, staged)
}

/// Copies the unpacked app beside the installed one, hidden, for an update
/// that was unpacked on another volume. Returns the copy. `ditto` keeps
/// links, modes and extended attributes, so the signature still holds;
/// check the copy before it is swapped in, since the copy is what runs.
pub fn stage_beside(installed: &Path, staged: &Path) -> Result<PathBuf, UnpackFailure> {
    let (Some(folder), Some(name)) = (installed.parent(), installed.file_name()) else {
        return Err(UnpackFailure::Folder(
            "the app has no folder around it".to_string(),
        ));
    };
    let mut hidden = std::ffi::OsString::from(".");
    hidden.push(name);
    hidden.push(".update");
    let copy = folder.join(hidden);
    if fs::symlink_metadata(&copy).is_ok() {
        fs::remove_dir_all(&copy).map_err(|error| UnpackFailure::Folder(error.to_string()))?;
    }
    let output = Command::new("/usr/bin/ditto")
        .arg(staged)
        .arg(&copy)
        .output()
        .map_err(|error| UnpackFailure::Tool(error.to_string()))?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&copy);
        let said = String::from_utf8_lossy(&output.stderr);
        let detail = said
            .lines()
            .last()
            .unwrap_or("no reason given")
            .trim()
            .to_string();
        return Err(UnpackFailure::Refused(detail));
    }
    Ok(copy)
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
                "videorc-updater-install-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A small bundle that says which build it is.
    fn make_bundle(bundle: &Path, version: &str) {
        let contents = bundle.join("Contents");
        fs::create_dir_all(contents.join("MacOS")).unwrap();
        fs::create_dir_all(contents.join("Resources")).unwrap();
        fs::write(
            contents.join("Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key><string>dev.videorc.test</string>\n<key>CFBundleExecutable</key><string>Test</string>\n<key>CFBundleShortVersionString</key><string>{version}</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        let executable = contents.join("MacOS").join("Test");
        fs::write(&executable, format!("#!/bin/sh\necho {version}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("../MacOS/Test", contents.join("Resources").join("link"))
            .unwrap();
    }

    fn said(bundle: &Path) -> String {
        fs::read_to_string(bundle.join("Contents").join("MacOS").join("Test")).unwrap()
    }

    fn zip_of(sources: &[&Path], zip: &Path) -> bool {
        // `ditto -c -k` takes one source, so several go through a folder.
        let (source, keep_parent) = match sources {
            [one] => (one.to_path_buf(), true),
            _ => {
                let folder = zip.with_extension("sources");
                fs::create_dir_all(&folder).unwrap();
                for source in sources {
                    let copied = Command::new("/usr/bin/ditto")
                        .arg(source)
                        .arg(folder.join(source.file_name().unwrap()))
                        .status();
                    if !copied.is_ok_and(|status| status.success()) {
                        return false;
                    }
                }
                (folder, false)
            }
        };
        let mut command = Command::new("/usr/bin/ditto");
        command.arg("-c").arg("-k");
        if keep_parent {
            command.arg("--keepParent");
        }
        command
            .arg(source)
            .arg(zip)
            .status()
            .is_ok_and(|status| status.success())
    }

    fn names_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The system's moves, with failures a test asks for.
    #[derive(Default)]
    struct Faulty {
        exchange_fails_with: Option<i32>,
        rename_fails_at: Option<(usize, i32)>,
        remove_fails: bool,
        renames: usize,
    }

    impl BundleMoves for Faulty {
        fn exchange(&mut self, first: &Path, second: &Path) -> io::Result<()> {
            match self.exchange_fails_with {
                Some(code) => Err(io::Error::from_raw_os_error(code)),
                None => SystemMoves.exchange(first, second),
            }
        }

        fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
            self.renames += 1;
            match self.rename_fails_at {
                Some((at, code)) if at == self.renames => Err(io::Error::from_raw_os_error(code)),
                _ => SystemMoves.rename(from, to),
            }
        }

        fn remove(&mut self, bundle: &Path) -> io::Result<()> {
            if self.remove_fails {
                return Err(io::Error::from_raw_os_error(libc::EACCES));
            }
            SystemMoves.remove(bundle)
        }
    }

    // where the app is

    #[test]
    fn finds_the_bundle_an_executable_runs_from() {
        assert_eq!(
            bundle_of_executable(Path::new(
                "/Applications/Videorc.app/Contents/MacOS/Videorc"
            )),
            Some(PathBuf::from("/Applications/Videorc.app"))
        );
        for not_a_bundle in [
            "/Users/dev/videorc/target/debug/videorc",
            "/Applications/Videorc.app/Contents/Helpers/tool",
            "/Applications/Videorc/Contents/MacOS/Videorc",
            "Videorc",
            "/",
        ] {
            assert_eq!(
                bundle_of_executable(Path::new(not_a_bundle)),
                None,
                "{not_a_bundle}"
            );
        }
    }

    #[test]
    fn refuses_a_copy_macos_runs_from_somewhere_else() {
        assert_eq!(
            bundle_path_refusal(Path::new("/Applications/Videorc.app")),
            None
        );
        assert_eq!(
            bundle_path_refusal(Path::new(
                "/private/var/folders/zz/abc123/T/AppTranslocation/3F2504E0-4F89-11D3-9A0C-0305E82C3301/d/Videorc.app"
            )),
            Some(LocationRefusal::Translocated)
        );
        assert_eq!(
            bundle_path_refusal(Path::new("/Users/dev/videorc/target/debug")),
            Some(LocationRefusal::NotABundle)
        );
        // A folder that only has the word in its name is not translocation.
        assert_eq!(
            bundle_path_refusal(Path::new("/Users/dev/AppTranslocation notes/Videorc.app")),
            None
        );
    }

    #[test]
    fn refuses_an_app_in_a_folder_that_cannot_be_changed() {
        let scratch = Scratch::new();
        let folder = scratch.path("Applications");
        let bundle = folder.join("Videorc.app");
        make_bundle(&bundle, "1.0.0");
        assert_eq!(install_location_refusal(&bundle), None);

        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let refusal = install_location_refusal(&bundle);
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        // Root may write anywhere, so this line proves nothing for root.
        // SAFETY: `geteuid` has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("SKIP: running as root");
            return;
        }
        assert_eq!(refusal, Some(LocationRefusal::FolderNotWritable));
        assert_eq!(
            install_location_refusal(Path::new("/nowhere-at-all/Videorc.app")),
            Some(LocationRefusal::FolderNotWritable)
        );
    }

    // the zip

    #[test]
    fn unpacks_the_one_app_a_zip_holds() {
        let scratch = Scratch::new();
        let source = scratch.path("made").join("Videorc.app");
        make_bundle(&source, "1.2.3");
        let zip = scratch.path("update.zip");
        if !zip_of(&[&source], &zip) {
            eprintln!("SKIP: this Mac could not make a zip");
            return;
        }
        let unpacked = unpack_update(&zip, &scratch.path("unpacked")).unwrap();
        assert_eq!(unpacked.file_name().unwrap(), "Videorc.app");
        assert_eq!(said(&unpacked), "#!/bin/sh\necho 1.2.3\n");
        // The link is still a link, and the program can still be run.
        let link = unpacked.join("Contents").join("Resources").join("link");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let mode = fs::metadata(unpacked.join("Contents").join("MacOS").join("Test"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
        assert_eq!(bundle_version(&unpacked).as_deref(), Some("1.2.3"));
    }

    #[test]
    fn refuses_a_folder_that_already_holds_something() {
        let scratch = Scratch::new();
        let folder = scratch.path("unpacked");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("left-over"), "x").unwrap();
        let refused = unpack_update(&scratch.path("update.zip"), &folder);
        assert_eq!(
            refused,
            Err(UnpackFailure::Folder("it is not empty".to_string()))
        );
    }

    #[test]
    fn refuses_a_zip_that_is_not_one() {
        let scratch = Scratch::new();
        let zip = scratch.path("update.zip");
        fs::write(&zip, "this is not a zip").unwrap();
        let refused = unpack_update(&zip, &scratch.path("unpacked"));
        assert!(
            matches!(refused, Err(UnpackFailure::Refused(_))),
            "{refused:?}"
        );
        let missing = unpack_update(&scratch.path("missing.zip"), &scratch.path("other"));
        assert!(
            matches!(missing, Err(UnpackFailure::Refused(_))),
            "{missing:?}"
        );
    }

    #[test]
    fn refuses_a_zip_with_no_app_or_with_two() {
        let scratch = Scratch::new();
        let first = scratch.path("made").join("Videorc.app");
        let second = scratch.path("made").join("Other.app");
        make_bundle(&first, "1.0.0");
        make_bundle(&second, "1.0.0");
        let two = scratch.path("two.zip");
        if !zip_of(&[&first, &second], &two) {
            eprintln!("SKIP: this Mac could not make a zip");
            return;
        }
        assert_eq!(
            unpack_update(&two, &scratch.path("unpacked-two")),
            Err(UnpackFailure::SeveralApps)
        );

        let note = scratch.path("made").join("notes");
        fs::create_dir_all(&note).unwrap();
        fs::write(note.join("read me.txt"), "hello").unwrap();
        let none = scratch.path("none.zip");
        assert!(zip_of(&[&note], &none));
        assert_eq!(
            unpack_update(&none, &scratch.path("unpacked-none")),
            Err(UnpackFailure::NoApp)
        );
    }

    #[test]
    fn never_takes_a_link_or_a_file_for_the_app() {
        let scratch = Scratch::new();
        let elsewhere = scratch.path("elsewhere").join("Real.app");
        make_bundle(&elsewhere, "1.0.0");
        let folder = scratch.path("unpacked");
        fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(&elsewhere, folder.join("Videorc.app")).unwrap();
        fs::write(folder.join("File.app"), "a file").unwrap();
        fs::create_dir_all(folder.join("__MACOSX").join("Videorc.app")).unwrap();
        fs::create_dir_all(folder.join(".Hidden.app")).unwrap();
        assert_eq!(find_unpacked_bundle(&folder), Err(UnpackFailure::NoApp));
        // Beside those, the real one is found.
        make_bundle(&folder.join("Videorc 2.app"), "1.0.0");
        assert_eq!(
            find_unpacked_bundle(&folder),
            Ok(folder.join("Videorc 2.app"))
        );
    }

    // the version

    #[test]
    fn reads_the_version_a_bundle_says_it_is() {
        let scratch = Scratch::new();
        let bundle = scratch.path("Videorc.app");
        make_bundle(&bundle, "0.27.0");
        assert_eq!(bundle_version(&bundle).as_deref(), Some("0.27.0"));

        // The binary spelling of the same list reads the same.
        let plist = bundle.join("Contents").join("Info.plist");
        let converted = Command::new("/usr/bin/plutil")
            .args(["-convert", "binary1"])
            .arg(&plist)
            .status()
            .is_ok_and(|status| status.success());
        if converted {
            assert!(fs::read(&plist).unwrap().starts_with(b"bplist"));
            assert_eq!(bundle_version(&bundle).as_deref(), Some("0.27.0"));
        }

        fs::write(
            &plist,
            "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict/></plist>\n",
        )
        .unwrap();
        assert_eq!(bundle_version(&bundle), None);
        assert_eq!(bundle_version(&scratch.path("Missing.app")), None);
    }

    #[test]
    fn takes_only_the_release_the_feed_promised() {
        assert!(versions_agree("0.27.0", "0.27.0"));
        assert!(versions_agree("0.27.0", "0.27.0-beta.1"));
        assert!(versions_agree(" 0.27.0\n", "0.27.0"));
        for (bundle, feed) in [
            ("0.26.0", "0.27.0"),
            ("0.27.1", "0.27.0"),
            ("1.27.0", "0.27.0"),
            ("0.27", "0.27.0"),
            ("", "0.27.0"),
            ("0.27.0", "latest"),
        ] {
            assert!(!versions_agree(bundle, feed), "{bundle} {feed}");
        }
    }

    // the swap

    #[test]
    fn puts_the_new_app_in_place_and_removes_the_old_one() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch
            .path("Applications")
            .join(".update")
            .join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");
        assert_eq!(
            swap_bundle(&installed, &staged),
            Ok(Swapped {
                old_app_removed: true
            })
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 2.0.0\n");
        assert!(!staged.exists());
        assert_eq!(
            names_in(&scratch.path("Applications")),
            [".update", "Videorc.app"]
        );
    }

    #[test]
    fn swaps_in_two_steps_where_the_file_system_cannot_exchange() {
        for code in [libc::ENOTSUP, libc::EINVAL] {
            let scratch = Scratch::new();
            let installed = scratch.path("Applications").join("Videorc.app");
            let staged = scratch.path("staging").join("Videorc.app");
            make_bundle(&installed, "1.0.0");
            make_bundle(&staged, "2.0.0");
            let mut moves = Faulty {
                exchange_fails_with: Some(code),
                ..Faulty::default()
            };
            assert_eq!(
                swap_bundle_with(&mut moves, &installed, &staged),
                Ok(Swapped {
                    old_app_removed: true
                })
            );
            assert_eq!(said(&installed), "#!/bin/sh\necho 2.0.0\n");
            assert!(!staged.exists());
            // Nothing is left beside the app.
            assert_eq!(names_in(&scratch.path("Applications")), ["Videorc.app"]);
        }
    }

    #[test]
    fn puts_the_old_app_back_when_the_new_one_cannot_take_its_place() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch.path("staging").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");
        let mut moves = Faulty {
            exchange_fails_with: Some(libc::ENOTSUP),
            // The first rename moves the old app aside; the second fails.
            rename_fails_at: Some((2, libc::EACCES)),
            ..Faulty::default()
        };
        let failed = swap_bundle_with(&mut moves, &installed, &staged);
        assert!(
            matches!(
                failed,
                Err(SwapFailure::Failed {
                    old_app_restored: true,
                    ..
                })
            ),
            "{failed:?}"
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 1.0.0\n");
        assert_eq!(said(&staged), "#!/bin/sh\necho 2.0.0\n");
        assert_eq!(names_in(&scratch.path("Applications")), ["Videorc.app"]);
    }

    #[test]
    fn says_so_when_the_old_app_could_not_be_put_back() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch.path("staging").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");

        /// Fails every rename after the first.
        struct Stuck(usize);
        impl BundleMoves for Stuck {
            fn exchange(&mut self, _: &Path, _: &Path) -> io::Result<()> {
                Err(io::Error::from_raw_os_error(libc::ENOTSUP))
            }
            fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
                self.0 += 1;
                if self.0 > 1 {
                    return Err(io::Error::from_raw_os_error(libc::EIO));
                }
                fs::rename(from, to)
            }
            fn remove(&mut self, bundle: &Path) -> io::Result<()> {
                fs::remove_dir_all(bundle)
            }
        }
        let failed = swap_bundle_with(&mut Stuck(0), &installed, &staged);
        assert!(
            matches!(
                failed,
                Err(SwapFailure::Failed {
                    old_app_restored: false,
                    ..
                })
            ),
            "{failed:?}"
        );
        // The old app is not lost: it waits beside where it was.
        let aside = scratch.path("Applications").join(".Videorc.app.previous");
        assert_eq!(said(&aside), "#!/bin/sh\necho 1.0.0\n");
        assert!(failed.unwrap_err().to_string().contains("was not put back"));
    }

    #[test]
    fn changes_nothing_when_there_is_nothing_to_swap() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch.path("staging").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        assert!(matches!(
            swap_bundle(&installed, &staged),
            Err(SwapFailure::NotStarted(_))
        ));
        assert_eq!(said(&installed), "#!/bin/sh\necho 1.0.0\n");

        // A link where the unpacked app should be is not an app.
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&installed, &staged).unwrap();
        assert!(matches!(
            swap_bundle(&installed, &staged),
            Err(SwapFailure::NotStarted(_))
        ));

        fs::remove_file(&staged).unwrap();
        make_bundle(&staged, "2.0.0");
        let nowhere = scratch.path("Applications").join("Missing.app");
        assert!(matches!(
            swap_bundle(&nowhere, &staged),
            Err(SwapFailure::NotStarted(_))
        ));
        assert_eq!(said(&staged), "#!/bin/sh\necho 2.0.0\n");
    }

    #[test]
    fn asks_for_a_copy_beside_the_app_when_the_update_is_on_another_volume() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch.path("staging").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");
        let mut moves = Faulty {
            exchange_fails_with: Some(libc::EXDEV),
            ..Faulty::default()
        };
        assert_eq!(
            swap_bundle_with(&mut moves, &installed, &staged),
            Err(SwapFailure::OtherVolume)
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 1.0.0\n");

        // The same from the two-step way, with the old app put back.
        let mut moves = Faulty {
            exchange_fails_with: Some(libc::ENOTSUP),
            rename_fails_at: Some((2, libc::EXDEV)),
            ..Faulty::default()
        };
        assert_eq!(
            swap_bundle_with(&mut moves, &installed, &staged),
            Err(SwapFailure::OtherVolume)
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 1.0.0\n");

        // The copy beside the app keeps the link and the program's mode,
        // and swaps in.
        let copy = stage_beside(&installed, &staged).unwrap();
        assert_eq!(
            copy,
            scratch.path("Applications").join(".Videorc.app.update")
        );
        let link = copy.join("Contents").join("Resources").join("link");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            swap_bundle(&installed, &copy),
            Ok(Swapped {
                old_app_removed: true
            })
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 2.0.0\n");
        assert_eq!(names_in(&scratch.path("Applications")), ["Videorc.app"]);
    }

    #[test]
    fn reports_an_old_app_it_could_not_remove_and_clears_it_next_time() {
        let scratch = Scratch::new();
        let installed = scratch.path("Applications").join("Videorc.app");
        let staged = scratch.path("staging").join("Videorc.app");
        make_bundle(&installed, "1.0.0");
        make_bundle(&staged, "2.0.0");
        let mut moves = Faulty {
            exchange_fails_with: Some(libc::ENOTSUP),
            remove_fails: true,
            ..Faulty::default()
        };
        assert_eq!(
            swap_bundle_with(&mut moves, &installed, &staged),
            Ok(Swapped {
                old_app_removed: false
            })
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 2.0.0\n");
        let aside = scratch.path("Applications").join(".Videorc.app.previous");
        assert!(aside.exists());

        // The next update finds it in the way and removes it first.
        make_bundle(&staged, "3.0.0");
        let mut moves = Faulty {
            exchange_fails_with: Some(libc::ENOTSUP),
            ..Faulty::default()
        };
        assert_eq!(
            swap_bundle_with(&mut moves, &installed, &staged),
            Ok(Swapped {
                old_app_removed: true
            })
        );
        assert_eq!(said(&installed), "#!/bin/sh\necho 3.0.0\n");
        assert_eq!(names_in(&scratch.path("Applications")), ["Videorc.app"]);
    }

    #[test]
    fn says_each_refusal_in_plain_words() {
        for refusal in [
            LocationRefusal::NotABundle,
            LocationRefusal::Translocated,
            LocationRefusal::FolderNotWritable,
        ] {
            let words = refusal.to_string();
            assert!(
                words.ends_with('.') && !words.contains("translocat"),
                "{words}"
            );
        }
        // True for an app that already is in Applications, on an account
        // that may not change that folder.
        let words = LocationRefusal::FolderNotWritable.to_string();
        assert!(words.contains("or to a folder you can change"), "{words}");
    }

    // from a download to an update that is ready

    /// A zip of `Videorc.app` at `version`, or `None` when this Mac could
    /// not make one.
    fn update_zip(scratch: &Scratch, version: &str) -> Option<PathBuf> {
        let source = scratch.path("made").join("Videorc.app");
        make_bundle(&source, version);
        let zip = scratch.path("update.zip");
        zip_of(&[&source], &zip).then_some(zip)
    }

    #[test]
    fn makes_a_checked_download_ready_in_the_staging_folder() {
        let scratch = Scratch::new();
        let Some(zip) = update_zip(&scratch, "2.0.0") else {
            eprintln!("SKIP: this Mac could not make a zip");
            return;
        };
        let staging = staging_root(&scratch.path("Caches"));
        assert_eq!(staging, scratch.path("Caches").join("videorc-update"));
        // An older update still waits there, with a stray file beside it.
        make_bundle(&staging.join("unpacked").join("Videorc.app"), "1.5.0");
        fs::write(staging.join("left-over"), "x").unwrap();

        let mut asked = Vec::new();
        let ready = prepare_update(&zip, &staging, "2.0.0", &mut |bundle| {
            asked.push(bundle.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(ready, staging.join("unpacked").join("Videorc.app"));
        assert_eq!(asked, std::slice::from_ref(&ready));
        assert_eq!(said(&ready), "#!/bin/sh\necho 2.0.0\n");
        assert_eq!(names_in(&staging), ["unpacked"]);
    }

    #[test]
    fn leaves_nothing_on_disk_that_failed_a_check() {
        let scratch = Scratch::new();
        let Some(zip) = update_zip(&scratch, "2.0.0") else {
            eprintln!("SKIP: this Mac could not make a zip");
            return;
        };
        let staging = staging_root(&scratch.path("Caches"));

        // Someone else's signature.
        let refused = prepare_update(&zip, &staging, "2.0.0", &mut |_| {
            Err(SignatureFailure::Refused(
                "test requirement not met".to_string(),
            ))
        });
        assert!(
            matches!(refused, Err(PrepareFailure::Signature(_))),
            "{refused:?}"
        );
        assert!(names_in(&staging).is_empty());

        // Not the release the feed promised. The signature is asked first.
        let mut asked = 0;
        let refused = prepare_update(&zip, &staging, "2.1.0", &mut |_| {
            asked += 1;
            Ok(())
        });
        assert_eq!(
            refused,
            Err(PrepareFailure::Version {
                found: Some("2.0.0".to_string())
            })
        );
        assert_eq!(asked, 1);
        assert!(names_in(&staging).is_empty());

        // Not a zip at all: the signature is never asked.
        let garbage = scratch.path("garbage.zip");
        fs::write(&garbage, "not a zip").unwrap();
        let refused = prepare_update(&garbage, &staging, "2.0.0", &mut |_| {
            panic!("nothing was unpacked, so there is nothing to check")
        });
        assert!(
            matches!(refused, Err(PrepareFailure::Unpack(_))),
            "{refused:?}"
        );
        assert!(names_in(&staging).is_empty());
    }

    #[test]
    fn empties_only_its_own_staging_folder() {
        let scratch = Scratch::new();
        // A folder by another name is never emptied.
        let documents = scratch.path("Documents");
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("thesis.txt"), "years of work").unwrap();
        assert!(clear_staging(&documents).is_err());
        assert!(clear_staging(Path::new("/")).is_err());
        assert_eq!(names_in(&documents), ["thesis.txt"]);
        let refused = prepare_update(&scratch.path("u.zip"), &documents, "1.0.0", &mut |_| Ok(()));
        assert!(
            matches!(refused, Err(PrepareFailure::Staging(_))),
            "{refused:?}"
        );
        assert_eq!(names_in(&documents), ["thesis.txt"]);

        // A staging folder that is not there yet is already empty.
        let staging = staging_root(&scratch.path("Caches"));
        assert!(clear_staging(&staging).is_ok());
        assert!(!staging.exists());

        // A link inside it is removed as a link.
        fs::create_dir_all(&staging).unwrap();
        std::os::unix::fs::symlink(&documents, staging.join("link")).unwrap();
        fs::create_dir_all(staging.join("unpacked").join("deep")).unwrap();
        assert!(clear_staging(&staging).is_ok());
        assert!(names_in(&staging).is_empty());
        assert_eq!(names_in(&documents), ["thesis.txt"]);

        // And so is a link standing where the folder should be.
        fs::remove_dir(&staging).unwrap();
        std::os::unix::fs::symlink(&documents, &staging).unwrap();
        assert!(clear_staging(&staging).is_ok());
        assert!(fs::symlink_metadata(&staging).is_err());
        assert_eq!(names_in(&documents), ["thesis.txt"]);
    }
}
