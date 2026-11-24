//! Settings → About and What's new (plan 220 S3.11c):
//! `components/settings/about-settings.tsx`, `lib/about-update-view.ts`,
//! `lib/release-track.ts`, `components/whats-new-dialog.tsx` and
//! `lib/whats-new.ts`, as values the app shows.
//!
//! - **About & updates**: the app's name, its version with the release
//!   track, What's new…, and the update row. The Rust app has no updater
//!   until S5.2 (S5.2a builds it, S5.2c wires this row and the sidebar's
//!   chip), so the row reads Electron's `unsupported` state: "This build
//!   doesn't update itself." with Open downloads page.
//! - **Support**: the support bundle's door to Health, and the links.
//! - **What's new**: the changelog videorc.com publishes
//!   (`/api/changelog`), parsed and filtered as the renderer does; the
//!   post-update check against the last version seen (`markWhatsNewSeen`,
//!   the store's `videorc.whatsNewLastSeenVersion`), and the latest release
//!   for About.

use serde_json::Value;

/// The page's and the dialog's words.
pub mod copy {
    pub const ABOUT_AND_UPDATES: &str = "About & updates";
    pub const ABOUT_DESCRIPTION: &str = "Your version of Videorc and its updates.";
    pub const APP_NAME: &str = "Videorc";
    pub const WHATS_NEW_BUTTON: &str = "What's new…";
    pub const UPDATES: &str = "Updates";
    pub const SUPPORT: &str = "Support";
    pub const SUPPORT_DESCRIPTION: &str = "Get help or report a problem.";
    pub const SUPPORT_BUNDLE: &str = "Support bundle";
    pub const SUPPORT_BUNDLE_DESCRIPTION: &str = "Export it from Health: redacted logs and Health's checks in one file, to send with a problem report.";
    pub const LINKS: &str = "Links";
    pub const FULL_RELEASE_NOTES: &str = "Full release notes";
    pub const CONTINUE: &str = "Continue";
    pub const NOTES_UNAVAILABLE: &str = "Release notes aren't available in Videorc right now";
    pub const NOTES_UNAVAILABLE_ID: &str = "whats-new-unavailable";
    pub const OPEN_CHANGELOG: &str = "Open changelog";
    /// `NO_VALUE`: a version not known yet.
    pub const NO_VALUE: &str = "—";

    /// `What's new in Videorc ${formatChangelogVersion(version)}`.
    pub fn whats_new_title(version: &str) -> String {
        format!(
            "What's new in Videorc {}",
            super::format_changelog_version(version)
        )
    }
}

/// `releaseTrackLabel`: Development unpackaged; Alpha on Windows and Linux,
/// Beta on macOS.
pub fn release_track_label(platform: &str, packaged: bool) -> &'static str {
    if !packaged {
        return "Development";
    }
    if platform == "win32" || platform == "linux" {
        "Alpha"
    } else {
        "Beta"
    }
}

/// The update row's one control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateControl {
    /// A link to a videorc.com page: its label and the page (`download`,
    /// `account`).
    Link {
        label: &'static str,
        page: &'static str,
    },
}

/// `updateRowView` for the state the Rust app has: `unsupported` until the
/// updater lands (S5.2). Linux's unknown version and Windows' unpublished
/// feed say their own words.
pub fn update_row(platform: &str) -> (&'static str, UpdateControl) {
    let _ = platform;
    (
        "This build doesn't update itself. Download new versions from videorc.com.",
        UpdateControl::Link {
            label: "Open downloads page",
            page: "download",
        },
    )
}

/// `ABOUT_LINKS`: the title, its quiet context, and which page.
pub const ABOUT_LINKS: [(&str, &str, &str); 4] = [
    ("Website", "videorc.com", "home"),
    ("Privacy policy", "", "privacy"),
    ("Terms of service", "", "terms"),
    ("Source code and licenses", "AGPL-3.0", "source"),
];

/// `VIDEORC_SOURCE_CODE_URL`.
pub const SOURCE_CODE_URL: &str = "https://github.com/TheOrcDev/videorc";

/// A videorc.com page by its `VIDEORC_WEB_LINKS` name, at `origin`.
pub fn web_link(origin: &str, page: &str) -> String {
    match page {
        "source" => SOURCE_CODE_URL.to_string(),
        "home" => origin.to_string(),
        "changelog-api" => format!("{origin}/api/changelog"),
        other => format!("{origin}/{other}"),
    }
}

/// `releaseNotesUrl`.
pub fn release_notes_url(origin: &str, version: &str) -> String {
    format!("{origin}/releases/{version}")
}

// --- What's new ---------------------------------------------------------------

/// `ChangelogEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangelogEntry {
    pub version: String,
    pub date: String,
    pub channel: String,
    pub platforms: Vec<String>,
    pub title: String,
    pub summary: String,
    pub highlights: Vec<String>,
}

/// `CHANGELOG_PLATFORMS`.
const CHANGELOG_PLATFORMS: [&str; 3] = ["macos", "windows", "linux"];

/// `changelogPlatformForRuntime`.
pub fn changelog_platform(platform: &str) -> Option<&'static str> {
    match platform {
        "darwin" => Some("macos"),
        "win32" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

fn nonempty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// `parseChangelogPlatforms`: schema v1 entries (no platforms) are macOS's.
fn parse_platforms(candidate: Option<&Value>) -> Option<Vec<String>> {
    let Some(candidate) = candidate else {
        return Some(vec!["macos".to_string()]);
    };
    let list = candidate.as_array().filter(|list| !list.is_empty())?;
    let mut platforms: Vec<String> = Vec::new();
    for item in list {
        let name = item
            .as_str()
            .filter(|name| CHANGELOG_PLATFORMS.contains(name))?;
        if platforms.iter().any(|known| known == name) {
            return None;
        }
        platforms.push(name.to_string());
    }
    Some(platforms)
}

fn parse_entry(candidate: &Value) -> Option<ChangelogEntry> {
    let entry = candidate.as_object()?;
    let platforms = parse_platforms(entry.get("platforms"))?;
    let highlights: Vec<String> = entry
        .get("highlights")?
        .as_array()?
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect::<Option<Vec<_>>>()?;
    if highlights.is_empty() {
        return None;
    }
    Some(ChangelogEntry {
        version: nonempty_text(entry.get("version"))?,
        date: entry.get("date")?.as_str()?.to_string(),
        channel: entry.get("channel")?.as_str()?.to_string(),
        platforms,
        title: nonempty_text(entry.get("title"))?,
        summary: nonempty_text(entry.get("summary"))?,
        highlights,
    })
}

/// `parseChangelogEntries`: the entries that match the published contract;
/// one malformed entry never breaks the rest.
pub fn parse_changelog_entries(raw: &Value) -> Vec<ChangelogEntry> {
    raw.get("entries")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_entry).collect())
        .unwrap_or_default()
}

/// `filterChangelogEntriesByPlatform`.
pub fn entries_for_platform(entries: Vec<ChangelogEntry>, platform: &str) -> Vec<ChangelogEntry> {
    entries
        .into_iter()
        .filter(|entry| entry.platforms.iter().any(|name| name == platform))
        .collect()
}

/// `resolveWhatsNewAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhatsNewAction {
    Idle,
    /// The first run with the feature: remember this version silently.
    Initialize,
    /// Updated since the version seen last: ask the changelog.
    Check,
}

pub fn resolve_whats_new_action(version: &str, last_seen: Option<&str>) -> WhatsNewAction {
    if version.is_empty() {
        return WhatsNewAction::Idle;
    }
    match last_seen {
        None => WhatsNewAction::Initialize,
        Some(seen) if seen == version => WhatsNewAction::Idle,
        Some(_) => WhatsNewAction::Check,
    }
}

/// `WhatsNewResult`: the newest release, and the ones between it and the
/// last seen, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhatsNew {
    pub entry: ChangelogEntry,
    pub skipped: Vec<String>,
}

impl WhatsNew {
    /// The newest of `entries` (newest first), `None` for none.
    pub fn from_entries(entries: Vec<ChangelogEntry>) -> Option<Self> {
        let mut entries = entries.into_iter();
        let entry = entries.next()?;
        Some(Self {
            entry,
            skipped: entries.map(|entry| entry.version).collect(),
        })
    }
}

/// `formatChangelogVersion`: "0.9.2-beta.1" → "0.9.2 Beta 1".
pub fn format_changelog_version(version: &str) -> String {
    let mut parts = version.splitn(2, '-');
    let core = parts.next().unwrap_or_default();
    let Some(pre) = parts.next().filter(|pre| !pre.is_empty()) else {
        return core.to_string();
    };
    // `split('-')` keeps only the first piece after the hyphen.
    let pre = pre.split('-').next().unwrap_or_default();
    let mut bits = pre.splitn(2, '.');
    let tag = bits.next().unwrap_or_default();
    let number = bits
        .next()
        .map(|rest| rest.split('.').next().unwrap_or_default());
    let mut chars = tag.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    match number.filter(|number| !number.is_empty()) {
        Some(number) => format!("{core} {capitalized} {number}"),
        None => format!("{core} {capitalized}"),
    }
}

/// `skippedReleasesLine`: "Also includes 0.9.1 and 0.9.0.".
pub fn skipped_releases_line(versions: &[String]) -> Option<String> {
    let names: Vec<String> = versions
        .iter()
        .map(|version| format_changelog_version(version))
        .collect();
    let list = match names.as_slice() {
        [] => return None,
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    Some(format!("Also includes {list}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(version: &str, platforms: Option<Value>) -> Value {
        let mut entry = json!({
            "version": version, "date": "2026-11-01", "channel": "beta",
            "title": "T", "summary": "S", "highlights": ["One", "Two"],
        });
        if let Some(platforms) = platforms {
            entry["platforms"] = platforms;
        }
        entry
    }

    #[test]
    fn the_changelog_keeps_good_entries_for_this_platform() {
        let raw = json!({"entries": [
            entry("0.22.0", Some(json!(["macos", "windows"]))),
            entry("0.21.0", None),
            entry("0.20.0", Some(json!(["windows"]))),
            {"version": "", "date": "x", "channel": "beta", "title": "T", "summary": "S", "highlights": ["a"]},
            entry("0.19.0", Some(json!(["macos", "macos"]))),
            entry("0.18.0", Some(json!(["amiga"]))),
        ]});
        let entries = parse_changelog_entries(&raw);
        assert_eq!(entries.len(), 3);
        let mac = entries_for_platform(entries, "macos");
        let versions: Vec<&str> = mac.iter().map(|e| e.version.as_str()).collect();
        assert_eq!(versions, ["0.22.0", "0.21.0"]);
        let whats_new = WhatsNew::from_entries(mac).unwrap();
        assert_eq!(whats_new.skipped, ["0.21.0"]);
        assert_eq!(parse_changelog_entries(&json!({})), Vec::new());
    }

    #[test]
    fn the_post_update_check_initializes_then_checks() {
        assert_eq!(resolve_whats_new_action("", None), WhatsNewAction::Idle);
        assert_eq!(
            resolve_whats_new_action("1.0.0", None),
            WhatsNewAction::Initialize
        );
        assert_eq!(
            resolve_whats_new_action("1.0.0", Some("1.0.0")),
            WhatsNewAction::Idle
        );
        assert_eq!(
            resolve_whats_new_action("1.0.1", Some("1.0.0")),
            WhatsNewAction::Check
        );
    }

    #[test]
    fn versions_read_as_the_dialog_names_them() {
        assert_eq!(format_changelog_version("0.9.2-beta.1"), "0.9.2 Beta 1");
        assert_eq!(format_changelog_version("0.9.2-beta"), "0.9.2 Beta");
        assert_eq!(format_changelog_version("0.9.2"), "0.9.2");
        assert_eq!(
            copy::whats_new_title("1.0.0-alpha.2"),
            "What's new in Videorc 1.0.0 Alpha 2"
        );
        assert_eq!(skipped_releases_line(&[]), None);
        assert_eq!(
            skipped_releases_line(&["0.9.1".into()]).as_deref(),
            Some("Also includes 0.9.1.")
        );
        assert_eq!(
            skipped_releases_line(&["0.9.2".into(), "0.9.1".into(), "0.9.0-beta.3".into()])
                .as_deref(),
            Some("Also includes 0.9.2, 0.9.1 and 0.9.0 Beta 3.")
        );
    }

    #[test]
    fn the_track_and_the_links_are_electrons() {
        assert_eq!(release_track_label("darwin", false), "Development");
        assert_eq!(release_track_label("darwin", true), "Beta");
        assert_eq!(release_track_label("win32", true), "Alpha");
        assert_eq!(
            web_link("https://www.videorc.com", "download"),
            "https://www.videorc.com/download"
        );
        assert_eq!(
            web_link("https://www.videorc.com", "home"),
            "https://www.videorc.com"
        );
        assert_eq!(web_link("x", "source"), SOURCE_CODE_URL);
        assert_eq!(release_notes_url("o", "1.0.0"), "o/releases/1.0.0");
        let (line, control) = update_row("darwin");
        assert!(line.starts_with("This build doesn't update itself."));
        assert_eq!(
            control,
            UpdateControl::Link {
                label: "Open downloads page",
                page: "download"
            }
        );
    }
}
