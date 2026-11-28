//! The resource capability itself (plan 260 S2.6a, from `videorc-rust`'s
//! `resources::capability` and `resources::wire::answers`, plan 220
//! S3.0i): its kinds, the path checks main runs before it asks the backend
//! (`main/resource-capabilities.ts`), the `resource.capability.issue`
//! request and the checks of its answer.
//!
//! The backend owns the authority (`resource_authority.rs`): it keeps the
//! canonical path and the file's identity, counts the uses down and refuses
//! a capability that expired, was used up, names another kind or points at
//! a file that changed. The app only issues on the admin credential.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

/// `resource.capability.issue`'s lifetime when main asks for none
/// (`issueResourceCapability`'s `ttlMs`).
pub const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);
/// `issueResourceCapability`'s `useCount`: one use.
pub const DEFAULT_USES: u32 = 1;

/// `issueResourceCapability`: the backend answered another kind.
pub const KIND_MISMATCH: &str =
    "Backend resource capability kind did not match the picker request.";
/// `issueResourceCapability`: not a `resource:<uuid>`.
pub const INVALID_CAPABILITY_ID: &str = "Backend returned an invalid resource capability id.";

/// `ResourceCapabilityKind` (main's six; the backend also knows
/// `scheduled-thumbnail`, which main never issues).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceKind {
    InputFile,
    OutputDirectory,
    OpenPath,
    RevealPath,
    TrashPath,
    BackgroundAsset,
}

impl ResourceKind {
    pub const ALL: [ResourceKind; 6] = [
        ResourceKind::InputFile,
        ResourceKind::OutputDirectory,
        ResourceKind::OpenPath,
        ResourceKind::RevealPath,
        ResourceKind::TrashPath,
        ResourceKind::BackgroundAsset,
    ];

    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            ResourceKind::InputFile => "input-file",
            ResourceKind::OutputDirectory => "output-directory",
            ResourceKind::OpenPath => "open-path",
            ResourceKind::RevealPath => "reveal-path",
            ResourceKind::TrashPath => "trash-path",
            ResourceKind::BackgroundAsset => "background-asset",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    fn requires_file(self) -> bool {
        matches!(
            self,
            ResourceKind::InputFile | ResourceKind::BackgroundAsset
        )
    }

    fn requires_directory(self) -> bool {
        matches!(self, ResourceKind::OutputDirectory)
    }
}

/// How long a capability lives and how many uses it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IssueOptions {
    pub ttl: Duration,
    pub uses: u32,
}

impl Default for IssueOptions {
    /// Electron's: five minutes, one use.
    fn default() -> Self {
        Self {
            ttl: DEFAULT_TTL,
            uses: DEFAULT_USES,
        }
    }
}

/// `ResourceSelection`: what a page holds, an opaque id, its kind and the
/// name to show. Never the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceSelection {
    pub capability_id: String,
    pub kind: ResourceKind,
    pub display_name: String,
}

impl ResourceSelection {
    /// Electron's IPC shape, `{capabilityId, kind, displayName}`.
    pub fn to_json(&self) -> Value {
        json!({
            "capabilityId": self.capability_id,
            "kind": self.kind.as_str(),
            "displayName": self.display_name,
        })
    }
}

/// `basename(canonicalPath) || canonicalPath`.
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Standard Win32 `MAX_PATH` length; longer verbatim paths keep their `\\?\`
/// prefix so Windows APIs and child processes do not fail on >260-char paths.
const MAX_STANDARD_WINDOWS_PATH_LEN: usize = 260;

/// Strip Windows' verbatim prefix (`\\?\`) only when what follows is a plain
/// drive path (`X:\...`) that fits within `MAX_PATH` (260 chars) and whose
/// segments will not change meaning under Win32 normalization (no `.`, `..`,
/// forward slash, or segment ending in `.` or space). Never strips `\\?\UNC\`,
/// `\\?\Volume{...}\`, `\\?\GLOBALROOT\`, `\\?\PhysicalDrive0`, or
/// drive-relative `\\?\X:foo`.
pub fn strip_verbatim_drive_prefix(raw_path: &str) -> &str {
    let Some(rest) = raw_path.strip_prefix(r"\\?\") else {
        return raw_path;
    };
    let bytes = rest.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return raw_path;
    }
    if rest.len() > MAX_STANDARD_WINDOWS_PATH_LEN || rest.contains('/') {
        return raw_path;
    }
    if rest[3..].split('\\').any(|segment| {
        segment == "." || segment == ".." || segment.ends_with('.') || segment.ends_with(' ')
    }) {
        return raw_path;
    }
    rest
}

/// Strip a plain Windows verbatim drive prefix (`\\?\X:\...`) from a `PathBuf`.
pub fn strip_verbatim_drive_prefix_path(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(text) => {
            let stripped = strip_verbatim_drive_prefix(text);
            if stripped.len() == text.len() {
                path
            } else {
                PathBuf::from(stripped)
            }
        }
        None => path,
    }
}

/// `std::fs::canonicalize` without Windows' `\\?\` verbatim drive prefix so
/// ordinary drive paths (`C:\...`) stay accepted across the app and backend.
pub fn canonicalize_plain_path(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(strip_verbatim_drive_prefix_path)
}

/// Lexical path check matching `main/resource-capabilities.ts` and the backend
/// authority. On Windows only (`cfg!(windows)`), accepts plain Windows
/// verbatim drive paths (`\\?\X:\...`) and returns the normalized ordinary
/// drive path while refusing device, UNC, and drive-relative forms on every
/// platform.
pub fn validate_resource_path_syntax(raw_path: &str) -> Result<&str, String> {
    if raw_path.is_empty() || raw_path.trim() != raw_path || raw_path.contains('\0') {
        return Err("Resource path is invalid.".to_string());
    }
    let effective = if cfg!(windows) {
        strip_verbatim_drive_prefix(raw_path)
    } else {
        raw_path
    };
    let windows = effective.replace('/', "\\").to_ascii_lowercase();
    let bytes = effective.as_bytes();
    let drive_relative = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes
            .get(2)
            .is_none_or(|separator| !matches!(separator, b'\\' | b'/'));
    if windows.starts_with("\\\\?\\")
        || windows.starts_with("\\\\.\\")
        || windows.starts_with("\\??\\")
        || windows.starts_with("\\device\\")
        || windows.starts_with("\\\\")
        || drive_relative
    {
        return Err("Windows device, UNC, and drive-relative paths are not supported.".to_string());
    }
    Ok(effective)
}

/// `canonicalResourcePath`: refuses an empty or padded path, the Windows
/// device, UNC and drive-relative forms (on every platform, as main does), a
/// relative path or one with a `..` hop, then resolves links and checks the
/// kind (a regular file for `input-file` and `background-asset`, a
/// directory for `output-directory`). The words are main's.
pub fn canonical_resource_path(raw_path: &str, kind: ResourceKind) -> Result<PathBuf, String> {
    let effective = validate_resource_path_syntax(raw_path)?;
    let path = Path::new(effective);
    if !path.is_absolute()
        || effective.split(['/', '\\']).any(|part| part == "..")
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Resource path must be absolute and traversal-free.".to_string());
    }
    let canonical = canonicalize_plain_path(path)
        .map_err(|_| "Resource path does not exist or could not be resolved.".to_string())?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "Resource path metadata could not be read.".to_string())?;
    if kind.requires_file() && !metadata.is_file() {
        return Err("Resource must be a regular file.".to_string());
    }
    if kind.requires_directory() && !metadata.is_dir() {
        return Err("Resource must be a directory.".to_string());
    }
    Ok(canonical)
}

/// The `resource.capability.issue` request main sends.
pub fn issue_params(path: &Path, kind: ResourceKind, options: IssueOptions) -> Value {
    json!({
        "path": path.to_string_lossy(),
        "kind": kind.as_str(),
        "ttlMs": u64::try_from(options.ttl.as_millis()).unwrap_or(u64::MAX),
        "useCount": options.uses,
    })
}

/// `resource:` and a hyphenated UUID, the only id the backend hands out.
pub fn capability_id_valid(value: &str) -> bool {
    let Some(id) = value.strip_prefix("resource:") else {
        return false;
    };
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        hyphen == (*byte == b'-') && (hyphen || byte.is_ascii_hexdigit())
    })
}

/// What the backend answered to `resource.capability.issue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCapability {
    pub capability_id: String,
    pub kind: ResourceKind,
    pub expires_in: Duration,
    pub uses: u32,
}

/// `issueResourceCapability`'s checks of the answer: the kind asked for and
/// a `resource:<uuid>` id.
pub fn parse_issued(answer: &Value, asked: ResourceKind) -> Result<IssuedCapability, String> {
    let kind = answer
        .get("kind")
        .and_then(Value::as_str)
        .and_then(ResourceKind::parse);
    if kind != Some(asked) {
        return Err(KIND_MISMATCH.into());
    }
    let capability_id = answer
        .get("capabilityId")
        .and_then(Value::as_str)
        .filter(|id| capability_id_valid(id))
        .ok_or(INVALID_CAPABILITY_ID)?;
    let expires_in = Duration::from_millis(
        answer
            .get("expiresInMs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .max(1),
    );
    let uses = answer
        .get("useCount")
        .and_then(Value::as_u64)
        .and_then(|uses| u32::try_from(uses).ok())
        .unwrap_or(DEFAULT_USES);
    Ok(IssuedCapability {
        capability_id: capability_id.to_string(),
        kind: asked,
        expires_in,
        uses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "resource:0f8e5a52-6d1b-4f3e-9a6c-2b7d1e4c9a10";

    #[test]
    fn kinds_keep_mains_wire_names() {
        for kind in ResourceKind::ALL {
            assert_eq!(ResourceKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(ResourceKind::OutputDirectory.as_str(), "output-directory");
        assert_eq!(ResourceKind::parse("scheduled-thumbnail"), None);
    }

    #[test]
    fn a_path_main_would_refuse_never_reaches_the_backend() {
        let kind = ResourceKind::OutputDirectory;
        for (raw, words) in [
            ("", "Resource path is invalid."),
            (" /tmp", "Resource path is invalid."),
            ("/tmp\0x", "Resource path is invalid."),
            (
                "\\\\server\\share",
                "Windows device, UNC, and drive-relative paths are not supported.",
            ),
            (
                "//?/C:/x",
                "Windows device, UNC, and drive-relative paths are not supported.",
            ),
            (
                "C:relative",
                "Windows device, UNC, and drive-relative paths are not supported.",
            ),
            (
                "relative/folder",
                "Resource path must be absolute and traversal-free.",
            ),
        ] {
            assert_eq!(
                canonical_resource_path(raw, kind).unwrap_err(),
                words,
                "{raw:?}"
            );
        }
        let dir = tempfile::tempdir().expect("temp dir");
        let hop = format!("{}/../x", dir.path().display());
        assert_eq!(
            canonical_resource_path(&hop, kind).unwrap_err(),
            "Resource path must be absolute and traversal-free."
        );
        let missing = dir.path().join("missing");
        assert_eq!(
            canonical_resource_path(missing.to_str().unwrap(), kind).unwrap_err(),
            "Resource path does not exist or could not be resolved."
        );
        let file = dir.path().join("take.mp4");
        std::fs::write(&file, b"x").expect("write");
        assert_eq!(
            canonical_resource_path(file.to_str().unwrap(), kind).unwrap_err(),
            "Resource must be a directory."
        );
        assert_eq!(
            canonical_resource_path(dir.path().to_str().unwrap(), ResourceKind::InputFile)
                .unwrap_err(),
            "Resource must be a regular file."
        );
    }

    #[test]
    fn a_chosen_folder_resolves_to_its_canonical_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let folder = dir.path().join("Recordings");
        std::fs::create_dir(&folder).expect("mkdir");
        let canonical =
            canonical_resource_path(folder.to_str().unwrap(), ResourceKind::OutputDirectory)
                .expect("a folder");
        assert_eq!(canonical, canonicalize_plain_path(&folder).unwrap());
        assert!(!canonical.to_string_lossy().starts_with(r"\\?\"));
        canonical_resource_path(canonical.to_str().unwrap(), ResourceKind::OutputDirectory)
            .expect("its own answer is accepted again");
        assert_eq!(display_name(&canonical), "Recordings");
    }

    #[test]
    fn windows_verbatim_drive_paths_normalize_while_device_and_unc_stay_refused() {
        assert_eq!(
            strip_verbatim_drive_prefix(r"\\?\C:\Users\alice\clip.mp4"),
            r"C:\Users\alice\clip.mp4"
        );
        assert_eq!(
            strip_verbatim_drive_prefix(
                r"\\?\F:\videorc\apps\desktop\resources\sounds\starter\airhorn.wav"
            ),
            r"F:\videorc\apps\desktop\resources\sounds\starter\airhorn.wav"
        );
        assert_eq!(
            strip_verbatim_drive_prefix_path(PathBuf::from(r"\\?\F:\videorc")),
            PathBuf::from(r"F:\videorc")
        );
        #[cfg(windows)]
        assert_eq!(
            validate_resource_path_syntax(r"\\?\C:\Users\alice\clip.mp4"),
            Ok(r"C:\Users\alice\clip.mp4")
        );
        #[cfg(not(windows))]
        assert_eq!(
            validate_resource_path_syntax(r"\\?\C:\Windows\System32\cmd.exe").unwrap_err(),
            "Windows device, UNC, and drive-relative paths are not supported."
        );

        let long_path = format!(r"\\?\C:\{}\clip.mp4", "a".repeat(260));
        assert_eq!(strip_verbatim_drive_prefix(&long_path), long_path);
        assert_eq!(
            strip_verbatim_drive_prefix(r"\\?\C:\clips\take "),
            r"\\?\C:\clips\take "
        );
        assert_eq!(
            validate_resource_path_syntax(r"\\?\C:\clips\take ").unwrap_err(),
            "Resource path is invalid."
        );

        for refused in [
            r"\\server\share\file.mp4",
            r"\\?\UNC\server\share\file.mp4",
            r"\\?\unc\server\share\file.mp4",
            r"\\?\UnC\server\share\file.mp4",
            r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\file.mp4",
            r"\\?\volume{12345678-1234-1234-1234-123456789abc}\file.mp4",
            r"\\?\GLOBALROOT\Device\Harddisk0\file",
            r"\\?\globalroot\Device\Harddisk0\file",
            r"\\?\PhysicalDrive0",
            r"\\?\C:relative\file.mp4",
            r"\\?\c:relative\file.mp4",
            r"\\?\C:",
            r"\\?\",
            r"\\?\\\?\C:\x",
            r"\\?\1:\x",
            r"\\?\C:\a\.\b.mp4",
            r"\\?\C:\clips\take.mp4.",
            r"\\?\C:\clips \take.mp4",
            r"\\?/C:\x",
            r"\\?\C:/x",
            r"/\?\C:\x",
            r"\\.\PhysicalDrive0",
            r"\\.\C:\Users\alice\clip.mp4",
            r"\??\C:\Windows\System32",
            r"\Device\HarddiskVolume1\file",
            r"\DEVICE\HarddiskVolume1\file",
            r"//?/C:/Users/alice/clip.mp4",
            r"C:",
            long_path.as_str(),
        ] {
            assert_eq!(
                validate_resource_path_syntax(refused).unwrap_err(),
                "Windows device, UNC, and drive-relative paths are not supported.",
                "{refused}"
            );
        }

        // Two-hop traversal through canonical_resource_path is refused on every platform.
        for traversal in [r"\\?\C:\a\..\..\Windows", r"\\?\C:\a/../x"] {
            assert!(
                canonical_resource_path(traversal, ResourceKind::InputFile).is_err(),
                "accepted traversal {traversal}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_tempdir_resolves_to_plain_drive_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let plain = canonicalize_plain_path(dir.path()).expect("plain canonical");
        let verbatim = format!(r"\\?\{}", plain.display());
        let resolved =
            canonical_resource_path(&verbatim, ResourceKind::OutputDirectory).expect("resolved");
        assert_eq!(resolved, plain);
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn the_request_is_mains_one_use_five_minutes() {
        assert_eq!(
            issue_params(
                Path::new("/Users/me/Movies"),
                ResourceKind::OutputDirectory,
                IssueOptions::default()
            ),
            json!({
                "path": "/Users/me/Movies",
                "kind": "output-directory",
                "ttlMs": 300_000,
                "useCount": 1,
            })
        );
    }

    #[test]
    fn the_backends_answer_is_checked() {
        let kind = ResourceKind::OutputDirectory;
        let issued = parse_issued(
            &json!({"capabilityId": ID, "kind": "output-directory", "expiresInMs": 300_000, "useCount": 1}),
            kind,
        )
        .expect("issued");
        assert_eq!(issued.capability_id, ID);
        assert_eq!(issued.expires_in, DEFAULT_TTL);
        assert_eq!(issued.uses, 1);
        assert_eq!(
            parse_issued(&json!({"capabilityId": ID, "kind": "input-file"}), kind).unwrap_err(),
            KIND_MISMATCH
        );
        for bad in [
            "resource:not-a-uuid",
            "0f8e5a52-6d1b-4f3e-9a6c-2b7d1e4c9a10",
            "resource:0f8e5a52x6d1b-4f3e-9a6c-2b7d1e4c9a10",
        ] {
            assert_eq!(
                parse_issued(
                    &json!({"capabilityId": bad, "kind": "output-directory"}),
                    kind
                )
                .unwrap_err(),
                INVALID_CAPABILITY_ID,
                "{bad}"
            );
        }
        assert!(capability_id_valid(ID));
    }
}
