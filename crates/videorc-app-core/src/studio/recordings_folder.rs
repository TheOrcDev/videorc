//! Output → Where recordings go, as data (plan 260 S1.6a part 6b, from
//! `videorc-rust`'s plan 220 S3.6b): `lib/recordings-folder.ts`,
//! `lib/format.ts`'s `formatBytes`, `lib/platform-copy.ts`'s
//! `defaultRecordingsPath`, and main's `checkDirectoryFactsForCapability`
//! and `outputDirectoryUnavailableMessage`
//! (`main/persistent-directory-authority.ts`), caught up with today's
//! Electron (none of them changed since 81e756ca but the named refusal,
//! which videorc-rust never had).
//!
//! **Where the folder lives (P3-D1).** Electron keeps the chosen folder in
//! `output-directory-authority.json` under `safeStorage`, which this app
//! can't read faithfully. The folder is a plain path in the backend's store,
//! which both apps read ([`keys::RECORDINGS_FOLDER`]); Electron's bridge
//! release (S5.4c, S5.4d) hands its own choice over to the same key. Until
//! then a folder chosen only in Electron is not seen here, and this app
//! records into the backend's default folder.
//!
//! **Before every start** the stored folder is authorized by the app's
//! issuer (`Resources::authorize_output_directory`) and the capability
//! rides in `session.start`'s `output.outputDirectoryCapability`
//! ([`super::StudioBackend::session_start_into`]). A folder that is gone
//! refuses the start by name ([`copy::folder_missing`]); one that can't be
//! authorized refuses it with [`copy::FOLDER_UNAVAILABLE`], as
//! `startSession` does.
//!
//! [`keys::RECORDINGS_FOLDER`]: super::settings::keys::RECORDINGS_FOLDER

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::settings::{UiSettingsCache, keys};

/// The page's and the start's words (P3-D2: Electron's exactly).
pub mod copy {
    pub const RECORDINGS_FOLDER: &str = "Recordings folder";
    pub const CHOOSE: &str = "Choose…";
    pub const USE_DEFAULT: &str = "Use default";
    pub const CHOSEN_FOLDER: &str = "Chosen folder";
    pub const EXPIRED: &str =
        "Videorc lost access to this folder. Choose it again, or use the default.";
    pub const NOT_WRITABLE: &str =
        "Videorc can't save to this folder, so recordings would fail. Choose another folder.";
    /// `startSession`'s refusal for a chosen folder that can't be authorized.
    pub const FOLDER_UNAVAILABLE: &str = "The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.";

    /// `outputDirectoryUnavailableMessage`: what Record, Clips, Import and
    /// Show in folder say when the chosen folder is gone (deleted, moved,
    /// or on a drive that was unplugged).
    pub fn folder_missing(display_name: &str) -> String {
        format!(
            "Videorc can’t find your recordings folder “{display_name}”. If it’s on a drive, reconnect the drive. Otherwise choose a folder in Output → Where recordings go."
        )
    }

    /// `platformCopy(platform).defaultRecordingsPath`.
    pub fn default_path(platform: &str) -> &'static str {
        match platform {
            "darwin" => "~/Movies/Videorc/Recordings",
            "win32" => "Videos\\Videorc\\Recordings in your user folder",
            _ => "Videorc/Recordings in your Videos folder (~/Movies if you recorded there before)",
        }
    }

    /// The free space under the path: "120 GB free".
    pub fn free(bytes: &str) -> String {
        format!("{bytes} free")
    }
}

/// This computer as `process.platform` names it, for the default path's
/// words.
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// The stored folder (`videorc.recordingsFolder`): a plain path the backend
/// owns, and the name to show, stored as the store keeps every value (its
/// JSON text, `localStorage`'s convention).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFolder {
    pub path: PathBuf,
    #[serde(default)]
    pub display_name: String,
}

impl StoredFolder {
    /// From the store's text; anything else (a relative path, nothing) is
    /// no folder, so recordings go to the default.
    pub fn from_stored(text: Option<&str>) -> Option<Self> {
        let folder: StoredFolder = serde_json::from_str(text?).ok()?;
        folder.path.is_absolute().then_some(folder)
    }

    /// The folder the store holds now.
    pub fn read(settings: &UiSettingsCache) -> Option<Self> {
        Self::from_stored(settings.get_item(keys::RECORDINGS_FOLDER).as_deref())
    }

    /// A picked folder, named by its last component (`basename(path) || path`).
    pub fn picked(path: PathBuf) -> Self {
        let display_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path.display().to_string());
        Self { path, display_name }
    }

    /// The name the refusal says: the stored name, else the path.
    pub fn name(&self) -> String {
        let name = self.display_name.trim();
        if name.is_empty() {
            self.path.display().to_string()
        } else {
            name.to_string()
        }
    }
}

/// `DirectoryFacts`: whether the folder is there, takes files, and its free
/// space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DirectoryFacts {
    pub exists: bool,
    pub writable: bool,
    pub free_bytes: Option<u64>,
}

/// `checkDirectoryFactsForCapability`: a folder (not a file), writable by
/// this process, and the space left to it. Blocking: read it off the async
/// runtime.
pub fn directory_facts(path: &Path) -> DirectoryFacts {
    let exists = std::fs::metadata(path).is_ok_and(|meta| meta.is_dir());
    if !exists {
        return DirectoryFacts::default();
    }
    DirectoryFacts {
        exists,
        writable: os::writable(path),
        free_bytes: os::free_bytes(path),
    }
}

/// `missingPathError` on the stored path (ENOENT, ENOTDIR): the folder was
/// deleted, moved away, or is on a drive that was unplugged. A file where
/// the folder was is gone too. Blocking.
pub fn folder_missing(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => !meta.is_dir(),
        Err(error) => matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        ),
    }
}

#[cfg(unix)]
mod os {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    fn c_path(path: &Path) -> Option<CString> {
        CString::new(path.as_os_str().as_bytes()).ok()
    }

    pub fn writable(path: &Path) -> bool {
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        c_path(path).is_some_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
    }

    pub fn free_bytes(path: &Path) -> Option<u64> {
        let path = c_path(path)?;
        // SAFETY: `statvfs` is plain data; zeroed is a valid value, and the
        // call only writes into it.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `path` is NUL-terminated and `stat` is a valid out pointer.
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
}

#[cfg(not(unix))]
mod os {
    use std::path::Path;

    /// Windows: the folder's read-only flag (the ACL check is Phase 4's).
    pub fn writable(path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|meta| !meta.permissions().readonly())
    }

    /// Windows' free space is Phase 4's (Node's `statfs` reads it there).
    pub fn free_bytes(_path: &Path) -> Option<u64> {
        None
    }
}

/// `formatBytes` (`lib/format.ts`): binary units, the unit chosen by the
/// value as shown ("1 MB", never "1024 KB"), one decimal under 100.
pub fn format_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes < 0.0 {
        return "-".to_string();
    }
    if bytes < 1024.0 {
        return format!("{} B", bytes.round());
    }
    let shown = |value: f64| {
        if value >= 100.0 {
            value.round()
        } else {
            (value * 10.0).round() / 10.0
        }
    };
    let mut value = bytes;
    let mut unit = "B";
    for candidate in ["KB", "MB", "GB", "TB"] {
        value /= 1024.0;
        unit = candidate;
        if shown(value) < 1024.0 {
            break;
        }
    }
    format!("{} {unit}", shown(value))
}

/// The row as one value (`RecordingsFolderView`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecordingsFolderView {
    /// The chosen folder's name, or the default path in words.
    pub path: String,
    /// A folder was chosen, so Use default applies.
    pub custom: bool,
    /// Free space, once checked.
    pub detail: Option<String>,
    /// Why recordings can't be saved there, and the fix.
    pub problem: Option<&'static str>,
    /// The chosen folder exists, so it can be shown in Finder.
    pub can_reveal: bool,
}

/// `recordingsFolderView`.
pub fn recordings_folder_view(
    folder: Option<&StoredFolder>,
    facts: Option<DirectoryFacts>,
    platform: &str,
) -> RecordingsFolderView {
    let Some(folder) = folder else {
        return RecordingsFolderView {
            path: copy::default_path(platform).to_string(),
            ..RecordingsFolderView::default()
        };
    };
    let name = folder.display_name.trim();
    let path = if name.is_empty() {
        copy::CHOSEN_FOLDER.to_string()
    } else {
        name.to_string()
    };
    let custom = RecordingsFolderView {
        path,
        custom: true,
        ..RecordingsFolderView::default()
    };
    let Some(facts) = facts else {
        return custom;
    };
    if !facts.exists {
        return RecordingsFolderView {
            problem: Some(copy::EXPIRED),
            ..custom
        };
    }
    if !facts.writable {
        return RecordingsFolderView {
            problem: Some(copy::NOT_WRITABLE),
            can_reveal: true,
            ..custom
        };
    }
    RecordingsFolderView {
        detail: facts
            .free_bytes
            .map(|bytes| copy::free(&format_bytes(bytes as f64))),
        can_reveal: true,
        ..custom
    }
}

/// The folder as the Studio's snapshot holds it: the stored choice, read
/// with the settings, and its facts once a page asked for them
/// ([`super::Studio::read_recordings_folder_facts`]). Electron reads the
/// facts only where they show (the Output page, the Library's free space),
/// never at launch, and a result counts only for the folder still chosen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordingsFolderState {
    pub folder: Option<StoredFolder>,
    pub facts: Option<DirectoryFacts>,
}

impl RecordingsFolderState {
    /// The stored folder, with the facts read for that same path.
    pub fn of(settings: &UiSettingsCache, facts: Option<&(PathBuf, DirectoryFacts)>) -> Self {
        let folder = StoredFolder::read(settings);
        let facts = match (&folder, facts) {
            (Some(folder), Some((path, facts))) if *path == folder.path => Some(*facts),
            _ => None,
        };
        Self { folder, facts }
    }

    /// Output → Where recordings go, on this computer.
    pub fn view(&self) -> RecordingsFolderView {
        recordings_folder_view(self.folder.as_ref(), self.facts, platform_name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn format_bytes_picks_the_unit_by_the_value_shown() {
        assert_eq!(format_bytes(-1.0), "-");
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(1536.0), "1.5 KB");
        assert_eq!(format_bytes(1023.96 * 1024.0), "1 MB", "never 1024 KB");
        assert_eq!(format_bytes(120.4 * 1024.0 * 1024.0 * 1024.0), "120 GB");
        assert_eq!(format_bytes(45.26 * 1024.0 * 1024.0 * 1024.0), "45.3 GB");
    }

    #[test]
    fn the_store_holds_an_absolute_path_or_nothing() {
        let path = std::env::temp_dir().join("Takes");
        let stored = json!({"path": path, "displayName": "Takes"}).to_string();
        let folder = StoredFolder::from_stored(Some(&stored)).unwrap();
        assert_eq!(folder.path, path);
        assert_eq!(
            StoredFolder::from_stored(Some(r#"{"path":"Takes"}"#)),
            None,
            "a relative path is no folder"
        );
        assert_eq!(StoredFolder::from_stored(Some("Takes")), None);
        assert_eq!(StoredFolder::from_stored(None), None);
        assert_eq!(StoredFolder::picked(path.clone()).display_name, "Takes");
        let root = path.ancestors().last().unwrap();
        assert_eq!(
            StoredFolder::picked(root.to_path_buf()).display_name,
            root.to_string_lossy()
        );
        #[cfg(target_os = "windows")]
        for relative in [r"\Takes", r"C:Takes"] {
            let stored = json!({"path": relative}).to_string();
            assert_eq!(
                StoredFolder::from_stored(Some(&stored)),
                None,
                "a rooted or drive-relative path is not absolute: {relative}"
            );
        }
    }

    #[test]
    fn the_row_says_where_and_what_is_wrong() {
        let default = recordings_folder_view(None, None, "darwin");
        assert_eq!(default.path, "~/Movies/Videorc/Recordings");
        assert!(!default.custom && !default.can_reveal && default.problem.is_none());
        assert_eq!(
            recordings_folder_view(None, None, "win32").path,
            "Videos\\Videorc\\Recordings in your user folder"
        );

        let folder = StoredFolder::picked(PathBuf::from("/Volumes/Media/Takes"));
        let unread = recordings_folder_view(Some(&folder), None, "darwin");
        assert_eq!(unread.path, "Takes");
        assert!(unread.custom && !unread.can_reveal && unread.detail.is_none());

        let gone = recordings_folder_view(Some(&folder), Some(DirectoryFacts::default()), "darwin");
        assert_eq!(gone.problem, Some(copy::EXPIRED));
        assert!(!gone.can_reveal);

        let read_only = DirectoryFacts {
            exists: true,
            writable: false,
            free_bytes: Some(1),
        };
        let locked = recordings_folder_view(Some(&folder), Some(read_only), "darwin");
        assert_eq!(locked.problem, Some(copy::NOT_WRITABLE));
        assert!(locked.can_reveal);

        let fine = DirectoryFacts {
            exists: true,
            writable: true,
            free_bytes: Some(120 * 1024 * 1024 * 1024),
        };
        let ok = recordings_folder_view(Some(&folder), Some(fine), "darwin");
        assert_eq!(ok.detail.as_deref(), Some("120 GB free"));
        assert!(ok.can_reveal && ok.problem.is_none());

        let unnamed = StoredFolder {
            path: PathBuf::from("/x"),
            display_name: "  ".to_string(),
        };
        assert_eq!(
            recordings_folder_view(Some(&unnamed), None, "darwin").path,
            copy::CHOSEN_FOLDER
        );
        assert_eq!(unnamed.name(), "/x", "the refusal names the path");
    }

    #[test]
    fn a_missing_folder_is_refused_by_name() {
        assert_eq!(
            copy::folder_missing("Videorc"),
            "Videorc can’t find your recordings folder “Videorc”. If it’s on a drive, reconnect the drive. Otherwise choose a folder in Output → Where recordings go."
        );
        let dir = tempfile::tempdir().unwrap();
        assert!(!folder_missing(dir.path()));
        let file = dir.path().join("not-a-folder");
        std::fs::write(&file, b"x").unwrap();
        assert!(folder_missing(&file), "a file where the folder was");
        assert!(folder_missing(&file.join("below")), "ENOTDIR");
        assert!(folder_missing(&dir.path().join("gone")), "ENOENT");
    }

    #[test]
    fn the_facts_read_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let facts = directory_facts(dir.path());
        assert!(facts.exists && facts.writable);
        #[cfg(unix)]
        assert!(facts.free_bytes.is_some_and(|bytes| bytes > 0));
        let file = dir.path().join("not-a-folder");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            directory_facts(&file),
            DirectoryFacts::default(),
            "a file is no folder"
        );
        assert_eq!(
            directory_facts(&dir.path().join("gone")),
            DirectoryFacts::default()
        );
    }

    #[test]
    fn the_snapshot_keeps_facts_only_for_the_folder_still_chosen() {
        let base = std::env::temp_dir();
        let path = base.join("Takes");
        let mut settings = UiSettingsCache::new();
        settings.put_local(
            keys::RECORDINGS_FOLDER,
            serde_json::Value::String(json!({"path": path, "displayName": "Takes"}).to_string()),
        );
        let facts = DirectoryFacts {
            exists: true,
            writable: true,
            free_bytes: Some(1024),
        };
        let same = RecordingsFolderState::of(&settings, Some(&(path, facts)));
        assert_eq!(same.facts, Some(facts));
        assert_eq!(same.view().path, "Takes");
        let other = RecordingsFolderState::of(&settings, Some(&(base.join("Old"), facts)));
        assert_eq!(other.facts, None, "another folder's facts are stale");
        let none =
            RecordingsFolderState::of(&UiSettingsCache::new(), Some(&(base.join("x"), facts)));
        assert_eq!(none, RecordingsFolderState::default());
        assert!(!none.view().custom);
    }
}
