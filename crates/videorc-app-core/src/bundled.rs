//! The files Videorc ships beside the app: electron-builder's
//! `extraResources` (`apps/desktop/electron-builder.yml`), found the same way
//! in a dev build and in a package.
//!
//! - **Dev build**: Electron's own sources in the checkout, read in place,
//!   as Electron's main reads them when it isn't packaged
//!   (`bundledBackgroundDirectory`, `bundledBuddyDirectory`,
//!   `starterSoundsDirectory`).
//! - **Package**: the resources directory, with electron-builder's layout
//!   under it, so a GPUI package copies the same folders to the same names
//!   (`background-assets/bundled`, `buddy-assets/bundled`,
//!   `sounds/starter`). [`packaged_resources_dir`] finds it.
//!
//! [`BundledAssets::backend_env`] hands the backend the managed roots
//! Electron's main sets when it spawns it, so imported and bundled pictures
//! and the shipped pet packs resolve the same way in both apps.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::studio::room_background::{MANAGED_BACKGROUND_DIR, managed_background_roots};

/// Overrides where a package keeps its resources. Setting it makes the run
/// a package: on a dev build it also moves [`run_root`] to the executable's
/// folder (`target/<profile>`) unless `--workspace` or
/// `VIDEORC_WORKSPACE_ROOT` names the checkout, which is useful for testing a
/// package's layout from a checkout.
pub const RESOURCES_DIR_ENV: &str = "VIDEORC_RESOURCES_DIR";

/// electron-builder's destinations under the resources directory.
pub const BACKGROUNDS_IN_RESOURCES: &str = "background-assets/bundled";
pub const BUDDY_IN_RESOURCES: &str = "buddy-assets/bundled";
pub const STARTER_SOUNDS_IN_RESOURCES: &str = "sounds/starter";
/// The bundled FFmpeg (macOS `mac.extraResources`: `vendor/ffmpeg/current`
/// to `ffmpeg`, `bin/ffmpeg` and `bin/ffprobe` in it).
#[cfg(not(windows))]
pub const FFMPEG_IN_RESOURCES: &str = "ffmpeg/bin/ffmpeg";
#[cfg(windows)]
pub const FFMPEG_IN_RESOURCES: &str = "ffmpeg/bin/ffmpeg.exe";
/// Where the backend takes FFmpeg from (Electron's main sets it to the
/// bundled one); FFprobe is found beside it.
pub const BUNDLED_FFMPEG_PATH_ENV: &str = "VIDEORC_BUNDLED_FFMPEG_PATH";

/// The same folders in the checkout (electron-builder's `from:`).
pub const BACKGROUNDS_IN_WORKSPACE: &str = "apps/desktop/src/renderer/src/assets/backgrounds";
pub const BUDDY_IN_WORKSPACE: &str = "apps/desktop/resources/buddy";
pub const STARTER_SOUNDS_IN_WORKSPACE: &str = "apps/desktop/resources/sounds/starter";

/// The pet packs' write root under user data (`BUDDY_ASSETS_FOLDER`).
pub const BUDDY_WRITE_FOLDER: &str = "buddy-assets";

/// Where each bundled folder is for this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledAssets {
    /// The preset pictures and every live look's poster (`*.webp`), with
    /// the live thumbnails in `live-thumbs/`.
    pub backgrounds: PathBuf,
    /// The shipped pet packs.
    pub buddy: PathBuf,
    /// The CC0 starter sounds and their `manifest.json`.
    pub starter_sounds: PathBuf,
}

impl BundledAssets {
    /// A package's: electron-builder's layout under `resources`.
    pub fn in_resources(resources: &Path) -> Self {
        Self {
            backgrounds: resources.join(BACKGROUNDS_IN_RESOURCES),
            buddy: resources.join(BUDDY_IN_RESOURCES),
            starter_sounds: resources.join(STARTER_SOUNDS_IN_RESOURCES),
        }
    }

    /// A dev build's: Electron's sources in the checkout.
    pub fn in_workspace(workspace_root: &Path) -> Self {
        Self {
            backgrounds: workspace_root.join(BACKGROUNDS_IN_WORKSPACE),
            buddy: workspace_root.join(BUDDY_IN_WORKSPACE),
            starter_sounds: workspace_root.join(STARTER_SOUNDS_IN_WORKSPACE),
        }
    }

    /// The package's resources when the app runs from one, else the
    /// checkout.
    pub fn locate(workspace_root: &Path, resources: Option<&Path>) -> Self {
        match resources {
            Some(resources) => Self::in_resources(resources),
            None => Self::in_workspace(workspace_root),
        }
    }

    /// The managed roots Electron's main gives the backend: the write root
    /// under user data first, then the bundled folder.
    ///
    /// - `VIDEORC_MANAGED_BACKGROUND_ROOTS`: imported pictures, then the
    ///   presets and live posters (`videorc-asset://background/<file>`).
    /// - `VIDEORC_MANAGED_BACKGROUND_IMPORT_DIR`: where `backgrounds.import`
    ///   copies a picture.
    /// - `VIDEORC_MANAGED_BUDDY_ROOTS`: uploaded and generated pets, then the
    ///   shipped packs.
    pub fn backend_env(&self, user_data_dir: &Path) -> Vec<(String, String)> {
        let backgrounds = managed_background_roots(user_data_dir, Some(&self.backgrounds));
        let buddy = [user_data_dir.join(BUDDY_WRITE_FOLDER), self.buddy.clone()];
        let mut env = Vec::new();
        if let Some(joined) = join_roots(&backgrounds) {
            env.push(("VIDEORC_MANAGED_BACKGROUND_ROOTS".to_string(), joined));
        }
        env.push((
            "VIDEORC_MANAGED_BACKGROUND_IMPORT_DIR".to_string(),
            user_data_dir
                .join(MANAGED_BACKGROUND_DIR)
                .to_string_lossy()
                .into_owned(),
        ));
        if let Some(joined) = join_roots(&buddy) {
            env.push(("VIDEORC_MANAGED_BUDDY_ROOTS".to_string(), joined));
        }
        env
    }
}

/// The roots joined with the platform's path list separator (Electron's
/// `delimiter`); `None` when a path can't be joined.
fn join_roots(roots: &[PathBuf]) -> Option<String> {
    std::env::join_paths(roots)
        .ok()
        .map(|joined| joined.to_string_lossy().into_owned())
}

/// A package's resources directory (Electron's `process.resourcesPath`):
/// [`RESOURCES_DIR_ENV`], else `Contents/Resources` beside a macOS bundle's
/// `Contents/MacOS`, else `resources` beside the executable (Windows,
/// Linux). A folder counts only when it holds the bundled backgrounds, so a
/// dev build, whose executable sits in `target/`, finds none.
pub fn packaged_resources_dir(exe: &Path, env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(dir) = env(RESOURCES_DIR_ENV).filter(|value| !value.trim().is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let exe_dir = exe.parent()?;
    let candidates = [
        exe_dir.parent().map(|contents| contents.join("Resources")),
        Some(exe_dir.join("resources")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|dir| dir.join(BACKGROUNDS_IN_RESOURCES).is_dir())
}

/// The folder this run works from: the backend's working directory and the
/// owned-process ledger's key. In order:
///
/// 1. A checkout the run was pointed at (`--workspace`,
///    `VIDEORC_WORKSPACE_ROOT`).
/// 2. In a package (its resources found), the executable's folder, where
///    the backend ships beside it. A package never adopts a checkout it
///    merely finds (the compile-time manifest path, the working directory):
///    that root would share a dev app's ledger, and each could reap the
///    other's recorded backend.
/// 3. A checkout found without being asked (`discovered`, a dev build's).
/// 4. None: the app can't start.
pub fn run_root(
    explicit: Option<PathBuf>,
    resources: Option<&Path>,
    exe: &Path,
    discovered: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    if explicit.is_some() {
        return explicit;
    }
    if resources.is_some() {
        return exe.parent().map(Path::to_path_buf);
    }
    discovered()
}

/// The package's FFmpeg, for [`BUNDLED_FFMPEG_PATH_ENV`]: `None` outside a
/// package (a dev build: [`workspace_ffmpeg`]), or when the package has none
/// (the backend then runs the `ffmpeg` on `PATH`).
pub fn bundled_ffmpeg(resources: &Path) -> Option<PathBuf> {
    let ffmpeg = resources.join(FFMPEG_IN_RESOURCES);
    ffmpeg.is_file().then_some(ffmpeg)
}

/// A dev build's FFmpeg on Windows: the pinned vendor build in the checkout
/// (`pnpm ffmpeg:fetch:windows`), so a dev run uses the exact binary a
/// package ships, as Electron's dev main does (`resolvePackagedFfmpegBinDir`).
/// `None` elsewhere (macOS and Linux keep `PATH`, unchanged by #2512's
/// Windows fixes) and when it hasn't been fetched.
pub fn workspace_ffmpeg(workspace_root: &Path) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let ffmpeg = workspace_root.join("vendor/ffmpeg/windows-x64/bin/ffmpeg.exe");
    ffmpeg.is_file().then_some(ffmpeg)
}

static BUNDLED: OnceLock<BundledAssets> = OnceLock::new();

/// Sets this run's folders, once, at startup; later calls get the first.
pub fn init(assets: BundledAssets) -> &'static BundledAssets {
    BUNDLED.get_or_init(|| assets)
}

/// This run's folders: what [`init`] set, else this checkout's (tests and
/// tools that never call it).
pub fn current() -> &'static BundledAssets {
    BUNDLED.get_or_init(|| {
        BundledAssets::in_workspace(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dev_build_reads_electrons_sources_in_the_checkout() {
        let assets = BundledAssets::in_workspace(Path::new("/repo"));
        assert_eq!(
            assets.backgrounds,
            Path::new("/repo/apps/desktop/src/renderer/src/assets/backgrounds")
        );
        assert_eq!(
            assets.buddy,
            Path::new("/repo/apps/desktop/resources/buddy")
        );
        assert_eq!(
            assets.starter_sounds,
            Path::new("/repo/apps/desktop/resources/sounds/starter")
        );
    }

    #[test]
    fn a_package_uses_electron_builders_layout() {
        let assets = BundledAssets::locate(Path::new("/repo"), Some(Path::new("/App/Resources")));
        assert_eq!(
            assets.backgrounds,
            Path::new("/App/Resources/background-assets/bundled")
        );
        assert_eq!(
            assets.buddy,
            Path::new("/App/Resources/buddy-assets/bundled")
        );
        assert_eq!(
            assets.starter_sounds,
            Path::new("/App/Resources/sounds/starter")
        );
    }

    #[test]
    fn the_checkout_holds_every_bundled_folder() {
        let assets =
            BundledAssets::in_workspace(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
        assert!(assets.backgrounds.join("code-demo.webp").is_file());
        assert!(assets.backgrounds.join("live-thumbs").is_dir());
        assert!(assets.buddy.is_dir());
        assert!(assets.starter_sounds.join("manifest.json").is_file());
    }

    #[test]
    fn the_backend_gets_the_write_root_then_the_bundled_folder() {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let assets = BundledAssets::in_workspace(&checkout);
        let user_data = Path::new("/data");
        let env = assets.backend_env(user_data);
        let value = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        let backgrounds: Vec<PathBuf> =
            std::env::split_paths(&value("VIDEORC_MANAGED_BACKGROUND_ROOTS")).collect();
        assert_eq!(
            backgrounds,
            vec![
                user_data.join("background-assets"),
                assets.backgrounds.clone()
            ]
        );
        assert_eq!(
            PathBuf::from(value("VIDEORC_MANAGED_BACKGROUND_IMPORT_DIR")),
            user_data.join("background-assets")
        );
        let buddy: Vec<PathBuf> =
            std::env::split_paths(&value("VIDEORC_MANAGED_BUDDY_ROOTS")).collect();
        assert_eq!(buddy, vec![user_data.join("buddy-assets"), assets.buddy]);
    }

    #[test]
    fn a_dev_executable_has_no_resources_and_the_variable_wins() {
        let none = |_: &str| None;
        assert_eq!(
            packaged_resources_dir(Path::new("/repo/target/release/videorc"), none),
            None
        );
        let set = |name: &str| (name == RESOURCES_DIR_ENV).then(|| "/opt/videorc".to_string());
        assert_eq!(
            packaged_resources_dir(Path::new("/repo/target/release/videorc"), set),
            Some(PathBuf::from("/opt/videorc"))
        );
    }

    #[test]
    fn a_package_hands_the_backend_its_own_ffmpeg() {
        let root = std::env::temp_dir().join(format!("videorc-ffmpeg-{}", std::process::id()));
        assert_eq!(bundled_ffmpeg(&root), None);
        let ffmpeg = root.join(FFMPEG_IN_RESOURCES);
        std::fs::create_dir_all(ffmpeg.parent().unwrap()).unwrap();
        std::fs::write(&ffmpeg, b"").unwrap();
        assert_eq!(bundled_ffmpeg(&root), Some(ffmpeg));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_dev_build_takes_the_checkouts_pinned_ffmpeg_off_macos() {
        let root = std::env::temp_dir().join(format!("videorc-dev-ffmpeg-{}", std::process::id()));
        assert_eq!(workspace_ffmpeg(&root), None);
        let ffmpeg = root.join("vendor/ffmpeg/windows-x64/bin/ffmpeg.exe");
        std::fs::create_dir_all(ffmpeg.parent().unwrap()).unwrap();
        std::fs::write(&ffmpeg, b"").unwrap();
        // Windows only: macOS and Linux keep `PATH` even with one fetched.
        let expected = cfg!(windows).then(|| ffmpeg.clone());
        assert_eq!(workspace_ffmpeg(&root), expected);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_macos_bundle_finds_contents_resources() {
        let root = std::env::temp_dir().join(format!("videorc-bundled-{}", std::process::id()));
        let resources = root.join("Videorc.app/Contents/Resources");
        std::fs::create_dir_all(resources.join(BACKGROUNDS_IN_RESOURCES)).unwrap();
        let exe = root.join("Videorc.app/Contents/MacOS/videorc");
        assert_eq!(packaged_resources_dir(&exe, |_| None), Some(resources));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_package_runs_from_its_executables_folder_unless_pointed_at_a_checkout() {
        let exe = Path::new("/Applications/Videorc.app/Contents/MacOS/videorc");
        let resources = Some(Path::new("/Applications/Videorc.app/Contents/Resources"));
        let found = || Some(PathBuf::from("/repo"));
        let macos = Some(PathBuf::from("/Applications/Videorc.app/Contents/MacOS"));
        // Packaged, with a checkout merely found on this Mac: the package's own folder.
        assert_eq!(run_root(None, resources, exe, found), macos);
        // Packaged, pointed at a checkout (--workspace): the checkout.
        assert_eq!(
            run_root(Some(PathBuf::from("/work")), resources, exe, found),
            Some(PathBuf::from("/work"))
        );
        // A dev build (no resources): the checkout it finds.
        let dev = Path::new("/repo/target/release/videorc");
        assert_eq!(
            run_root(None, None, dev, found),
            Some(PathBuf::from("/repo"))
        );
        // Neither: nothing to run from.
        assert_eq!(run_root(None, None, dev, || None), None);
    }
}
