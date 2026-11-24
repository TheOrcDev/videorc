//! `videorc://` links on Linux (plan 260 S2.6c): Electron main's
//! `linux-desktop-entry.ts` and its IO in `registerLinuxAppImageUrlHandler`.
//!
//! An AppImage installs no desktop entry, so nothing handles
//! `x-scheme-handler/videorc` and `videorc://buddy` (plan 170 D18) or an X
//! sign-in's app-protocol fallback could not open Videorc. The packaged
//! AppImage writes its own user entry, `~/.local/share/applications/videorc.desktop`,
//! pointing at the AppImage file, and registers it with `xdg-mime`.
//!
//! An entry without the `X-Videorc-Managed` marker belongs to the user or to
//! an integration tool (AppImageLauncher, Gear Lever) and is never
//! overwritten.
//!
//! The decisions are pure; [`apply_registration`] does the file work and
//! hands each desktop tool to the caller's runner (`apps/videorc`'s
//! `platform::linux` runs them bounded, without a shell, and logs a failure).

use std::io;
use std::path::{Path, PathBuf};

pub const DESKTOP_FILE_NAME: &str = "videorc.desktop";
pub const URL_MIME_TYPE: &str = "x-scheme-handler/videorc";
pub const DESKTOP_ICON_NAME: &str = "videorc";
pub const MANAGED_KEY: &str = "X-Videorc-Managed";

/// The AppImage file to register, or `None` when this run must not touch the
/// desktop: an unpackaged build, a run that is not an AppImage (`$APPIMAGE`
/// unset or empty), or a relative path.
pub fn appimage_to_register(is_packaged: bool, appimage: Option<&str>) -> Option<&str> {
    let appimage = appimage?;
    (is_packaged && appimage.starts_with('/')).then_some(appimage)
}

/// Where the entry and its icon go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntryPaths {
    pub desktop_file: PathBuf,
    pub applications_dir: PathBuf,
    pub icon_dir: PathBuf,
    pub icon_file: PathBuf,
}

/// `XDG_DATA_HOME` wins when it is an absolute path (the spec ignores
/// relative values); otherwise `~/.local/share`.
pub fn desktop_entry_paths(
    home_dir: &Path,
    xdg_data_home: Option<&str>,
    icon_size: u32,
) -> DesktopEntryPaths {
    let data_home = match xdg_data_home {
        Some(value) if value.starts_with('/') => PathBuf::from(value),
        _ => home_dir.join(".local").join("share"),
    };
    let applications_dir = data_home.join("applications");
    let icon_dir = data_home
        .join("icons")
        .join("hicolor")
        .join(format!("{icon_size}x{icon_size}"))
        .join("apps");
    DesktopEntryPaths {
        desktop_file: applications_dir.join(DESKTOP_FILE_NAME),
        icon_file: icon_dir.join(format!("{DESKTOP_ICON_NAME}.png")),
        applications_dir,
        icon_dir,
    }
}

/// A plain string value (`TryExec`): only the backslash is escaped.
pub fn escape_desktop_string(value: &str) -> String {
    value.replace('\\', "\\\\")
}

fn is_representable_path(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(|c| c.is_control())
}

/// One `Exec` argument per the Desktop Entry spec ("The Exec key"). An
/// argument with a reserved character is double-quoted, with `"`, `` ` ``,
/// `$` and `\` backslash-escaped inside; a plain path stays bare, because the
/// xdg-open generic launcher (xdg-utils 1.2, used on Hyprland, Sway and other
/// bare window managers) splits `Exec` on spaces and does not strip quotes.
/// `%` is written `%%`, and then the whole value gets the string-value
/// escaping, which doubles every backslash again. `None` for a path the
/// format cannot carry.
pub fn quote_desktop_exec_argument(value: &str) -> Option<String> {
    if !is_representable_path(value) {
        return None;
    }
    let needs_quotes = value.chars().any(|c| {
        c.is_whitespace()
            || matches!(
                c,
                '"' | '\''
                    | '\\'
                    | '>'
                    | '<'
                    | '~'
                    | '|'
                    | '&'
                    | ';'
                    | '$'
                    | '*'
                    | '?'
                    | '#'
                    | '('
                    | ')'
                    | '`'
            )
    });
    let argument = if needs_quotes {
        let mut quoted = String::with_capacity(value.len() + 2);
        quoted.push('"');
        for c in value.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
        quoted
    } else {
        value.to_string()
    };
    Some(escape_desktop_string(&argument.replace('%', "%%")))
}

/// The same launch as the entry the AppImage bundles (`AppRun %U`). The
/// AppImage's `chrome-sandbox` concern of Electron does not apply to the
/// GPUI app, and the entry never adds launch flags of its own.
pub fn build_desktop_entry(appimage_path: &str) -> Option<String> {
    let exec = quote_desktop_exec_argument(appimage_path)?;
    Some(
        [
            "[Desktop Entry]".to_string(),
            "Name=Videorc".to_string(),
            "Comment=Videorc desktop app.".to_string(),
            format!("Exec={exec} %U"),
            format!("TryExec={}", escape_desktop_string(appimage_path)),
            "Terminal=false".to_string(),
            "Type=Application".to_string(),
            format!("Icon={DESKTOP_ICON_NAME}"),
            "StartupWMClass=Videorc".to_string(),
            "Categories=AudioVideo;Video;".to_string(),
            format!("MimeType={URL_MIME_TYPE};"),
            format!("{MANAGED_KEY}=true"),
            String::new(),
        ]
        .join("\n"),
    )
}

/// What to do with the entry on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryDecision {
    Write(WriteReason),
    Keep(KeepReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteReason {
    Missing,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepReason {
    Current,
    Unmanaged,
}

/// `existing` is the current file's text, or `None` when there is none.
pub fn decide_desktop_entry(existing: Option<&str>, desired: &str) -> EntryDecision {
    let Some(existing) = existing else {
        return EntryDecision::Write(WriteReason::Missing);
    };
    if !is_managed_entry(existing) {
        return EntryDecision::Keep(KeepReason::Unmanaged);
    }
    if normalize_entry(existing) == normalize_entry(desired) {
        EntryDecision::Keep(KeepReason::Current)
    } else {
        EntryDecision::Write(WriteReason::Stale)
    }
}

pub fn is_managed_entry(text: &str) -> bool {
    desktop_entry_value(text, MANAGED_KEY).is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

/// A key's value from the `[Desktop Entry]` group (not from `Desktop Action`
/// groups).
pub fn desktop_entry_value(text: &str, key: &str) -> Option<String> {
    let mut in_main_group = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_main_group || line.starts_with('#') {
            continue;
        }
        if let Some((name, value)) = line.split_once('=')
            && !name.is_empty()
            && name.trim() == key
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn normalize_entry(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

/// A desktop tool and its arguments, for the caller's runner.
pub type DesktopTool = (&'static str, Vec<String>);

/// What one launch's registration did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationOutcome {
    /// The path cannot go in a desktop entry; `videorc://` links stay off.
    Unrepresentable,
    /// The entry is the user's or a tool's: left alone, no `xdg-mime`.
    LeftAlone(PathBuf),
    /// The entry was written (or was already current) and the handler set.
    Registered {
        desktop_file: PathBuf,
        decision: EntryDecision,
        icon_installed: bool,
    },
}

/// The icon to install: a source PNG and its size in pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconSource {
    pub path: PathBuf,
    pub size: u32,
}

/// Registers the AppImage for `videorc://` links: writes the entry when it is
/// missing or stale (never one Videorc did not write), installs the icon when
/// none is there, re-asserts the handler with `xdg-mime` every launch (so a
/// handler another app took is reclaimed), and refreshes the desktop
/// database after a write. `run_tool` runs one desktop tool; its failure is
/// the caller's to log, never a failed launch.
pub fn apply_registration(
    appimage_path: &str,
    home_dir: &Path,
    xdg_data_home: Option<&str>,
    icon: Option<&IconSource>,
    mut run_tool: impl FnMut(DesktopTool),
) -> io::Result<RegistrationOutcome> {
    let Some(desired) = build_desktop_entry(appimage_path) else {
        return Ok(RegistrationOutcome::Unrepresentable);
    };
    let paths = desktop_entry_paths(home_dir, xdg_data_home, icon.map_or(512, |icon| icon.size));
    let existing = match std::fs::read_to_string(&paths.desktop_file) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let decision = decide_desktop_entry(existing.as_deref(), &desired);
    if decision == EntryDecision::Keep(KeepReason::Unmanaged) {
        return Ok(RegistrationOutcome::LeftAlone(paths.desktop_file));
    }
    if let EntryDecision::Write(_) = decision {
        std::fs::create_dir_all(&paths.applications_dir)?;
        std::fs::write(&paths.desktop_file, &desired)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&paths.desktop_file, std::fs::Permissions::from_mode(0o644))?;
        }
    }
    let mut icon_installed = false;
    if let Some(icon) = icon
        && icon.path.is_file()
        && !paths.icon_file.exists()
    {
        std::fs::create_dir_all(&paths.icon_dir)?;
        std::fs::copy(&icon.path, &paths.icon_file)?;
        icon_installed = true;
    }
    run_tool((
        "xdg-mime",
        vec![
            "default".to_string(),
            DESKTOP_FILE_NAME.to_string(),
            URL_MIME_TYPE.to_string(),
        ],
    ));
    if let EntryDecision::Write(_) = decision {
        run_tool((
            "update-desktop-database",
            vec![paths.applications_dir.to_string_lossy().into_owned()],
        ));
    }
    Ok(RegistrationOutcome::Registered {
        desktop_file: paths.desktop_file,
        decision,
        icon_installed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPIMAGE: &str = "/home/ana/Applications/Videorc-0.15.1.AppImage";

    fn entry_for(path: &str) -> String {
        build_desktop_entry(path).expect("representable")
    }

    #[test]
    fn registers_only_a_packaged_appimage_run() {
        assert_eq!(appimage_to_register(true, Some(APPIMAGE)), Some(APPIMAGE));
        assert_eq!(appimage_to_register(false, Some(APPIMAGE)), None);
        assert_eq!(appimage_to_register(true, None), None);
        assert_eq!(appimage_to_register(true, Some("")), None);
        assert_eq!(appimage_to_register(true, Some("Videorc.AppImage")), None);
    }

    #[test]
    fn defaults_to_local_share() {
        let paths = desktop_entry_paths(Path::new("/home/ana"), None, 512);
        assert_eq!(
            paths,
            DesktopEntryPaths {
                desktop_file: PathBuf::from("/home/ana/.local/share/applications/videorc.desktop"),
                applications_dir: PathBuf::from("/home/ana/.local/share/applications"),
                icon_dir: PathBuf::from("/home/ana/.local/share/icons/hicolor/512x512/apps"),
                icon_file: PathBuf::from(
                    "/home/ana/.local/share/icons/hicolor/512x512/apps/videorc.png"
                ),
            }
        );
    }

    #[test]
    fn respects_an_absolute_xdg_data_home_and_ignores_a_relative_one() {
        let home = Path::new("/home/ana");
        assert_eq!(
            desktop_entry_paths(home, Some("/data/xdg"), 256).desktop_file,
            PathBuf::from("/data/xdg/applications/videorc.desktop")
        );
        assert_eq!(
            desktop_entry_paths(home, Some("/data/xdg"), 256).icon_file,
            PathBuf::from("/data/xdg/icons/hicolor/256x256/apps/videorc.png")
        );
        assert_eq!(
            desktop_entry_paths(home, Some("rel/xdg"), 512).desktop_file,
            PathBuf::from("/home/ana/.local/share/applications/videorc.desktop")
        );
        assert_eq!(
            desktop_entry_paths(home, Some(""), 512).desktop_file,
            PathBuf::from("/home/ana/.local/share/applications/videorc.desktop")
        );
    }

    #[test]
    fn leaves_a_plain_path_bare_and_quotes_one_with_spaces() {
        assert_eq!(
            quote_desktop_exec_argument("/opt/Videorc-0.15.1.AppImage").as_deref(),
            Some("/opt/Videorc-0.15.1.AppImage")
        );
        assert_eq!(
            quote_desktop_exec_argument("/home/ana/My Apps/Videorc.AppImage").as_deref(),
            Some("\"/home/ana/My Apps/Videorc.AppImage\"")
        );
    }

    #[test]
    fn escapes_the_reserved_characters_field_code_percent_and_backslashes() {
        assert_eq!(
            quote_desktop_exec_argument("/a\"b").as_deref(),
            Some("\"/a\\\\\"b\"")
        );
        assert_eq!(
            quote_desktop_exec_argument("/a$b").as_deref(),
            Some("\"/a\\\\$b\"")
        );
        assert_eq!(
            quote_desktop_exec_argument("/a`b").as_deref(),
            Some("\"/a\\\\`b\"")
        );
        assert_eq!(
            quote_desktop_exec_argument("/a\\b").as_deref(),
            Some("\"/a\\\\\\\\b\"")
        );
        assert_eq!(
            quote_desktop_exec_argument("/100%/Videorc").as_deref(),
            Some("/100%%/Videorc")
        );
        assert_eq!(
            quote_desktop_exec_argument("/ana's/V").as_deref(),
            Some("\"/ana's/V\"")
        );
    }

    #[test]
    fn refuses_a_path_the_format_cannot_carry() {
        assert_eq!(quote_desktop_exec_argument(""), None);
        assert_eq!(quote_desktop_exec_argument("/a\nb"), None);
        assert_eq!(quote_desktop_exec_argument("/a\tb"), None);
    }

    #[test]
    fn writes_a_managed_entry_that_handles_videorc_links() {
        assert_eq!(
            entry_for(APPIMAGE),
            [
                "[Desktop Entry]",
                "Name=Videorc",
                "Comment=Videorc desktop app.",
                "Exec=/home/ana/Applications/Videorc-0.15.1.AppImage %U",
                "TryExec=/home/ana/Applications/Videorc-0.15.1.AppImage",
                "Terminal=false",
                "Type=Application",
                "Icon=videorc",
                "StartupWMClass=Videorc",
                "Categories=AudioVideo;Video;",
                "MimeType=x-scheme-handler/videorc;",
                "X-Videorc-Managed=true",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn quotes_a_path_with_spaces_and_refuses_an_unrepresentable_one() {
        let entry = entry_for("/home/ana/My Apps/V.AppImage");
        assert_eq!(
            desktop_entry_value(&entry, "Exec").as_deref(),
            Some("\"/home/ana/My Apps/V.AppImage\" %U")
        );
        assert_eq!(
            desktop_entry_value(&entry, "TryExec").as_deref(),
            Some("/home/ana/My Apps/V.AppImage")
        );
        assert_eq!(
            desktop_entry_value(&entry_for("/a\\b"), "TryExec").as_deref(),
            Some("/a\\\\b")
        );
        assert_eq!(build_desktop_entry("/a\nb"), None);
        assert!(!entry.contains("--no-sandbox"));
    }

    #[test]
    fn writes_a_missing_entry_and_keeps_a_current_one() {
        let desired = entry_for(APPIMAGE);
        assert_eq!(
            decide_desktop_entry(None, &desired),
            EntryDecision::Write(WriteReason::Missing)
        );
        assert_eq!(
            decide_desktop_entry(Some(&desired), &desired),
            EntryDecision::Keep(KeepReason::Current)
        );
        let crlf = format!("{}\n\n", desired.replace('\n', "\r\n"));
        assert_eq!(
            decide_desktop_entry(Some(&crlf), &desired),
            EntryDecision::Keep(KeepReason::Current)
        );
    }

    #[test]
    fn rewrites_a_managed_entry_for_another_appimage() {
        let desired = entry_for(APPIMAGE);
        let old = entry_for("/home/ana/Applications/Videorc-0.14.0.AppImage");
        assert_eq!(
            decide_desktop_entry(Some(&old), &desired),
            EntryDecision::Write(WriteReason::Stale)
        );
        let with_flag = desired.replace(" %U", " --no-sandbox %U");
        assert_eq!(
            decide_desktop_entry(Some(&with_flag), &desired),
            EntryDecision::Write(WriteReason::Stale)
        );
    }

    #[test]
    fn never_touches_an_entry_it_did_not_write() {
        let desired = entry_for(APPIMAGE);
        let launcher = "[Desktop Entry]\nName=Videorc\nExec=/opt/appimagelauncher/Videorc.AppImage %U\nX-AppImage-Integrate=true\n";
        assert_eq!(
            decide_desktop_entry(Some(launcher), &desired),
            EntryDecision::Keep(KeepReason::Unmanaged)
        );
        assert_eq!(
            decide_desktop_entry(Some(""), &desired),
            EntryDecision::Keep(KeepReason::Unmanaged)
        );
        // The marker only counts in the main group.
        let action =
            format!("[Desktop Entry]\nName=Videorc\n[Desktop Action new]\n{MANAGED_KEY}=true\n");
        assert_eq!(
            decide_desktop_entry(Some(&action), &desired),
            EntryDecision::Keep(KeepReason::Unmanaged)
        );
    }

    #[test]
    fn registration_writes_the_entry_installs_the_icon_and_sets_the_handler() {
        let home = tempfile::tempdir().unwrap();
        let icon_dir = tempfile::tempdir().unwrap();
        let icon_path = icon_dir.path().join("videorc-logo.png");
        std::fs::write(&icon_path, b"png").unwrap();
        let icon = IconSource {
            path: icon_path,
            size: 256,
        };
        let mut tools = Vec::new();
        let outcome = apply_registration(APPIMAGE, home.path(), None, Some(&icon), |tool| {
            tools.push(tool)
        })
        .unwrap();
        let paths = desktop_entry_paths(home.path(), None, 256);
        assert_eq!(
            outcome,
            RegistrationOutcome::Registered {
                desktop_file: paths.desktop_file.clone(),
                decision: EntryDecision::Write(WriteReason::Missing),
                icon_installed: true,
            }
        );
        assert_eq!(
            std::fs::read_to_string(&paths.desktop_file).unwrap(),
            entry_for(APPIMAGE)
        );
        assert_eq!(std::fs::read(&paths.icon_file).unwrap(), b"png");
        assert_eq!(
            tools,
            vec![
                (
                    "xdg-mime",
                    vec![
                        "default".to_string(),
                        DESKTOP_FILE_NAME.to_string(),
                        URL_MIME_TYPE.to_string()
                    ]
                ),
                (
                    "update-desktop-database",
                    vec![paths.applications_dir.to_string_lossy().into_owned()]
                ),
            ]
        );

        // The next launch: the entry is current, the icon is there; only the
        // handler is re-asserted.
        tools.clear();
        let outcome = apply_registration(APPIMAGE, home.path(), None, Some(&icon), |tool| {
            tools.push(tool)
        })
        .unwrap();
        assert_eq!(
            outcome,
            RegistrationOutcome::Registered {
                desktop_file: paths.desktop_file,
                decision: EntryDecision::Keep(KeepReason::Current),
                icon_installed: false,
            }
        );
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "xdg-mime");
    }

    #[test]
    fn registration_leaves_someone_elses_entry_and_its_handler_alone() {
        let home = tempfile::tempdir().unwrap();
        let paths = desktop_entry_paths(home.path(), None, 512);
        std::fs::create_dir_all(&paths.applications_dir).unwrap();
        let theirs = "[Desktop Entry]\nName=Videorc\nExec=/opt/Videorc.AppImage %U\n";
        std::fs::write(&paths.desktop_file, theirs).unwrap();
        let mut tools = Vec::new();
        let outcome =
            apply_registration(APPIMAGE, home.path(), None, None, |tool| tools.push(tool)).unwrap();
        assert_eq!(
            outcome,
            RegistrationOutcome::LeftAlone(paths.desktop_file.clone())
        );
        assert_eq!(
            std::fs::read_to_string(&paths.desktop_file).unwrap(),
            theirs
        );
        assert!(tools.is_empty());
    }

    #[test]
    fn registration_refuses_an_unrepresentable_path_without_touching_the_disk() {
        let home = tempfile::tempdir().unwrap();
        let mut tools = Vec::new();
        let outcome =
            apply_registration("/a\nb", home.path(), None, None, |tool| tools.push(tool)).unwrap();
        assert_eq!(outcome, RegistrationOutcome::Unrepresentable);
        assert!(tools.is_empty());
        assert!(!home.path().join(".local").exists());
    }
}
