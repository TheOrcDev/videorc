//! Where the app keeps its data: Electron's `app.getPath('userData')`, which
//! is `~/Library/Application Support/Videorc` on macOS, `%APPDATA%\Videorc`
//! on Windows and `$XDG_CONFIG_HOME/Videorc` (`~/.config/Videorc`) on Linux.
//! The backend's own defaults resolve to the same directory on macOS and
//! Windows (`storage.rs`), so a [`Isolation::RealUserData`] run shares one
//! profile with Electron.
//!
//! A `--profile <dir>` run (tests, smokes, a second instance beside the
//! owner's real app) keeps everything inside that one directory.

/// The Studio's UI-local settings file (`studio::ui_local` reads it, S1.6a).
pub const UI_LOCAL_FILE: &str = "ui-local.json";

use std::path::{Path, PathBuf};

use crate::process::Isolation;

/// The app's data directory and whether it is an isolated profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub user_data_dir: PathBuf,
    pub isolation: Isolation,
}

impl AppPaths {
    /// The owner's real profile: Electron's `userData` for this platform.
    pub fn real() -> Self {
        Self {
            user_data_dir: default_user_data_dir(),
            isolation: Isolation::RealUserData,
        }
    }

    /// An isolated profile: every path under `dir`.
    pub fn profile(dir: impl Into<PathBuf>) -> Self {
        Self {
            user_data_dir: dir.into(),
            isolation: Isolation::Profile,
        }
    }

    /// `userData/logs`: the app log, the backend's metrics journal and
    /// per-session FFmpeg logs (`VIDEORC_LOGS_DIR`).
    pub fn logs_dir(&self) -> PathBuf {
        self.user_data_dir.join("logs")
    }

    /// `userData/logs/backend.log` (`backend-log-file.ts`).
    pub fn backend_log_file(&self) -> PathBuf {
        self.logs_dir().join("backend.log")
    }

    /// S3.0d: the Rust app's journal of UI settings writes the store has not
    /// confirmed (the renderer kept one per window in `localStorage`).
    pub fn ui_settings_journal_file(&self) -> PathBuf {
        self.user_data_dir.join("ui-settings-journal.json")
    }

    /// S3.0d (P3-D5): the per-device conveniences, `ui-local.json`
    /// (the Studio's UI-local settings file).
    pub fn ui_local_file(&self) -> PathBuf {
        self.user_data_dir.join(UI_LOCAL_FILE)
    }

    /// `userData/backend-crashes.json` (`backend-crash-log.ts`).
    pub fn backend_crash_log_file(&self) -> PathBuf {
        self.user_data_dir.join("backend-crashes.json")
    }

    /// The owned-process ledger for one workspace
    /// (`backend-owned-processes.ts`: `userData/owned-processes/<key>.json`).
    /// The Rust app keeps its own file beside Electron's: the two apps may
    /// run side by side on one profile, and each reaps only what it recorded.
    pub fn owned_process_ledger(&self, workspace_root: &Path) -> PathBuf {
        self.user_data_dir
            .join("owned-processes")
            .join(format!("rust-{}.json", workspace_key(workspace_root)))
    }
}

/// The first 16 hex digits of the workspace path's SHA-256, as Electron keys
/// its ledgers.
pub fn workspace_key(workspace_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(workspace_root.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..16].to_string()
}

/// Electron's `userData` for the app named `Videorc`.
pub fn default_user_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("Videorc")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("Videorc")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("Videorc")
    }
}

/// `~/.cargo/bin`, which Electron prepends to the backend's `PATH` so the
/// dev chain finds cargo and the toolchain.
pub fn cargo_bin_dir() -> PathBuf {
    home_dir().join(".cargo").join("bin")
}

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_paths_stay_inside_the_profile() {
        let paths = AppPaths::profile("/tmp/videorc-profile");
        assert_eq!(paths.isolation, Isolation::Profile);
        assert_eq!(
            paths.backend_log_file(),
            PathBuf::from("/tmp/videorc-profile/logs/backend.log")
        );
        assert_eq!(
            paths.backend_crash_log_file(),
            PathBuf::from("/tmp/videorc-profile/backend-crashes.json")
        );
        let ledger = paths.owned_process_ledger(Path::new("/w"));
        assert!(ledger.starts_with("/tmp/videorc-profile/owned-processes"));
        assert!(
            ledger
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rust-")
        );
    }

    #[test]
    fn workspace_key_is_sixteen_hex_digits_of_sha256() {
        // echo -n /w | shasum -a 256 → 0f...; only the shape is asserted here
        // (the exact digest is the library's), plus determinism.
        let key = workspace_key(Path::new("/w"));
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(key, workspace_key(Path::new("/w")));
        assert_ne!(key, workspace_key(Path::new("/x")));
    }

    #[test]
    fn real_user_data_dir_is_named_videorc() {
        let dir = default_user_data_dir();
        assert_eq!(dir.file_name().unwrap(), "Videorc");
        assert_eq!(AppPaths::real().isolation, Isolation::RealUserData);
    }
}
