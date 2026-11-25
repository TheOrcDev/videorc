//! Where `videorc-mcp`, the stdio bridge an agent app runs, lives on this
//! computer (plan 209 S7, D6, D20): a port of Electron main's
//! `agent-bridge.ts` with its rules. Settings → Remote → Connect an agent
//! puts this path in the line the streamer pastes into Claude Desktop,
//! Cursor, Codex and the rest, and "Add to …" writes it into the app's own
//! config (the backend's admin `agents.config.add`), so it must be absolute
//! and must stay put:
//!
//! - macOS points at the app's own copy, beside the backend, which an update
//!   replaces in place;
//! - a packaged Linux app copies it to `~/.local/share/videorc/bin/`, out of
//!   an AppImage whose mount path changes every launch;
//! - a packaged Windows app copies it to `%LOCALAPPDATA%\Videorc\bin\`, out
//!   of the install the updater closes every process in, and writes the
//!   app's own path beside it so the bridge can open this Videorc;
//! - development points at the cargo build in the repo, beside the backend.
//!
//! Reading the path for Settings never writes anything; Connect and "Add to
//! …" also put the copy in place (`install`).

use std::io;
use std::path::{Path, PathBuf};

/// `AGENT_BRIDGE_FILE`.
pub const BRIDGE_FILE: &str = "videorc-mcp";
/// `AGENT_BRIDGE_APP_POINTER`: beside the Windows copy, the Videorc.exe that
/// last refreshed it, one line.
pub const APP_POINTER: &str = "videorc-app-path.txt";

/// Which platform's rules apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgePlatform {
    Mac,
    Linux,
    Windows,
}

impl BridgePlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Mac
        }
    }

    fn file(self) -> &'static str {
        match self {
            Self::Windows => "videorc-mcp.exe",
            _ => BRIDGE_FILE,
        }
    }
}

/// `AgentBridgeLocation`: where this install keeps the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLocation {
    pub packaged: bool,
    pub platform: BridgePlatform,
    /// The folder the bridge ships in: the backend's (the app's resources
    /// when packaged, `target/<profile>` in development).
    pub bundled_dir: PathBuf,
    pub home_dir: PathBuf,
    /// `%LOCALAPPDATA%` (Windows); `<home>\AppData\Local` when unset.
    pub local_app_data: Option<PathBuf>,
    /// This app's executable: the Windows copy records it beside itself.
    pub app_executable: Option<PathBuf>,
}

/// `AgentBridgeInfo`: the path a config line names, and whether this
/// install has the bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeInfo {
    pub path: String,
    pub exists: bool,
}

/// What putting the copy in place did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOutcome {
    Installed,
    /// An identical copy was already there.
    Current,
    /// Windows: a running copy could not be replaced; it still works, and
    /// the next start tries again.
    Busy,
}

/// `bundledAgentBridgePath`.
pub fn bundled_path(location: &BridgeLocation) -> PathBuf {
    location.bundled_dir.join(location.platform.file())
}

/// `linuxAgentBridgeCopyPath`.
pub fn linux_copy_path(home_dir: &Path) -> PathBuf {
    home_dir
        .join(".local")
        .join("share")
        .join("videorc")
        .join("bin")
        .join(BRIDGE_FILE)
}

/// `windowsAgentBridgeCopyPath`.
pub fn windows_copy_path(home_dir: &Path, local_app_data: Option<&Path>) -> PathBuf {
    local_app_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home_dir.join("AppData").join("Local"))
        .join("Videorc")
        .join("bin")
        .join("videorc-mcp.exe")
}

/// `agentBridgeUsesCopy`: the packaged Linux and Windows apps keep a copy.
pub fn uses_copy(location: &BridgeLocation) -> bool {
    location.packaged
        && matches!(
            location.platform,
            BridgePlatform::Linux | BridgePlatform::Windows
        )
}

/// `agentBridgeCopyPath`.
pub fn copy_path(location: &BridgeLocation) -> PathBuf {
    match location.platform {
        BridgePlatform::Windows => {
            windows_copy_path(&location.home_dir, location.local_app_data.as_deref())
        }
        _ => linux_copy_path(&location.home_dir),
    }
}

/// Windows has no execute bit: a readable .exe is a runnable one.
fn is_runnable(path: &Path, platform: BridgePlatform) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if platform != BridgePlatform::Windows {
            return metadata.permissions().mode() & 0o111 != 0;
        }
    }
    let _ = platform;
    true
}

fn same_bytes(left: &Path, right: &Path) -> bool {
    match (std::fs::read(left), std::fs::read(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn busy(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
    )
}

/// `installAgentBridgeCopy`: the bundled bridge at `copy` unless an
/// identical one is there. Written beside it and renamed over it, so an
/// agent app running the old copy keeps its file. On Windows a running copy
/// moves aside to `<copy>.old` first; when even that fails the old copy
/// stays (`Busy`).
pub fn install_copy(
    bundled: &Path,
    copy: &Path,
    platform: BridgePlatform,
) -> io::Result<CopyOutcome> {
    let aside = PathBuf::from(format!("{}.old", copy.display()));
    if platform == BridgePlatform::Windows {
        let _ = std::fs::remove_file(&aside);
    }
    if same_bytes(bundled, copy) {
        return Ok(CopyOutcome::Current);
    }
    if let Some(dir) = copy.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
        }
    }
    let staging = PathBuf::from(format!("{}.{}.tmp", copy.display(), std::process::id()));
    let drop_staging = || {
        let _ = std::fs::remove_file(&staging);
    };
    let first = (|| -> io::Result<()> {
        std::fs::copy(bundled, &staging)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&staging, copy)
    })();
    match first {
        Ok(()) => return Ok(CopyOutcome::Installed),
        Err(error) if platform == BridgePlatform::Windows && busy(&error) => {}
        Err(error) => {
            drop_staging();
            return Err(error);
        }
    }
    if std::fs::rename(copy, &aside).is_err() {
        drop_staging();
        return Ok(CopyOutcome::Busy);
    }
    if std::fs::rename(&staging, copy).is_err() {
        let _ = std::fs::rename(&aside, copy);
        drop_staging();
        return Ok(CopyOutcome::Busy);
    }
    let _ = std::fs::remove_file(&aside);
    Ok(CopyOutcome::Installed)
}

/// Windows: the app that refreshed the copy names itself beside it, written
/// only when it changed. Best effort.
fn point_at_this_app(location: &BridgeLocation, copy: &Path) {
    if location.platform != BridgePlatform::Windows {
        return;
    }
    let (Some(exe), Some(dir)) = (&location.app_executable, copy.parent()) else {
        return;
    };
    let pointer = dir.join(APP_POINTER);
    let line = format!("{}\r\n", exe.display());
    if std::fs::read_to_string(&pointer).ok().as_deref() != Some(line.as_str()) {
        let _ = std::fs::write(&pointer, line);
    }
}

/// `resolveAgentBridge`: the path a config line names, and whether this
/// install has the bridge. `install` (Connect, "Add to …") also puts the
/// Linux or Windows copy in place; a copy that couldn't be written keeps
/// the old one, which still runs.
pub fn resolve(location: &BridgeLocation, install: bool) -> BridgeInfo {
    let bundled = bundled_path(location);
    let exists = is_runnable(&bundled, location.platform);
    if !uses_copy(location) {
        return BridgeInfo {
            path: bundled.display().to_string(),
            exists,
        };
    }
    let copy = copy_path(location);
    if exists && install {
        let _ = install_copy(&bundled, &copy, location.platform);
        point_at_this_app(location, &copy);
    }
    BridgeInfo {
        path: copy.display().to_string(),
        exists,
    }
}

/// `refreshAgentBridgeCopy`: after an update the copy is the old version;
/// refresh it only when the streamer connected an agent (the copy exists).
/// Never creates it.
pub fn refresh_copy(location: &BridgeLocation) -> Option<CopyOutcome> {
    if !uses_copy(location) {
        return None;
    }
    let bundled = bundled_path(location);
    let copy = copy_path(location);
    if !is_runnable(&copy, location.platform) || !is_runnable(&bundled, location.platform) {
        return None;
    }
    let outcome = install_copy(&bundled, &copy, location.platform).ok();
    point_at_this_app(location, &copy);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(dir: &Path, packaged: bool, platform: BridgePlatform) -> BridgeLocation {
        BridgeLocation {
            packaged,
            platform,
            bundled_dir: dir.join("bundle"),
            home_dir: dir.join("home"),
            local_app_data: None,
            app_executable: None,
        }
    }

    #[cfg(unix)]
    fn bridge(path: &Path, body: &[u8]) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_paths_follow_electron() {
        let home = Path::new("/home/ana");
        assert_eq!(
            linux_copy_path(home),
            Path::new("/home/ana/.local/share/videorc/bin/videorc-mcp")
        );
        let windows = windows_copy_path(Path::new("C:/Users/Ana"), None);
        assert!(windows.ends_with("AppData/Local/Videorc/bin/videorc-mcp.exe"));
        let local = windows_copy_path(Path::new("C:/Users/Ana"), Some(Path::new("D:/Local")));
        assert!(local.ends_with("Videorc/bin/videorc-mcp.exe"));
        let dir = Path::new("/x");
        assert!(!uses_copy(&location(dir, false, BridgePlatform::Linux)));
        assert!(!uses_copy(&location(dir, true, BridgePlatform::Mac)));
        assert!(uses_copy(&location(dir, true, BridgePlatform::Windows)));
        assert!(
            bundled_path(&location(dir, true, BridgePlatform::Windows))
                .ends_with("videorc-mcp.exe")
        );
    }

    #[cfg(unix)]
    #[test]
    fn mac_and_development_name_the_bundled_bridge_and_write_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let at = location(dir.path(), false, BridgePlatform::Mac);
        assert!(!resolve(&at, true).exists);
        bridge(&bundled_path(&at), b"v1");
        let info = resolve(&at, true);
        assert!(info.exists);
        assert_eq!(info.path, bundled_path(&at).display().to_string());
        assert!(!dir.path().join("home").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_packaged_linux_app_copies_the_bridge_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let at = location(dir.path(), true, BridgePlatform::Linux);
        bridge(&bundled_path(&at), b"v1");
        let copy = copy_path(&at);
        // Settings reads the path without writing.
        let read = resolve(&at, false);
        assert_eq!(read.path, copy.display().to_string());
        assert!(!copy.exists());
        // Connect puts the copy in place, runnable.
        assert!(resolve(&at, true).exists);
        assert_eq!(std::fs::read(&copy).unwrap(), b"v1");
        assert!(is_runnable(&copy, BridgePlatform::Linux));
        assert_eq!(
            install_copy(&bundled_path(&at), &copy, BridgePlatform::Linux).unwrap(),
            CopyOutcome::Current
        );
        // An update: the copy refreshes; with no copy, nothing is made.
        bridge(&bundled_path(&at), b"v2");
        assert_eq!(refresh_copy(&at), Some(CopyOutcome::Installed));
        assert_eq!(std::fs::read(&copy).unwrap(), b"v2");
        std::fs::remove_file(&copy).unwrap();
        assert_eq!(refresh_copy(&at), None);
        assert!(!copy.exists());
    }
}
