//! Linux's "a newer version is available" notice.
//!
//! Linux builds never update themselves: no `latest-linux.yml` feed is
//! published, and the Alpha AppImage is a sign-in download. Instead the app
//! asks the public, unauthenticated changelog (videorc-web `/api/changelog`,
//! compiled from `changelog/` on each release) for the newest entry that
//! names `linux`, and says so in Settings → About with a link to the
//! downloads page. It never downloads anything.
//!
//! The changelog only publishes a Linux entry once that Linux release is
//! public, so an entry is the release process's own "this version is out"
//! signal. Until the changelog lists the running Linux line, the check
//! proves nothing either way and reports `Unknown`: never "You're on the
//! latest version" on a guess, and never a version that was not published.
//!
//! A port of `linux-update-notice.ts` with its tests. The request itself is
//! the app's; offline, a timeout, a 401 or a 404 are all `Unknown`, quietly.

use semver::{Prerelease, Version};
use serde_json::Value;

use crate::status::{UnsupportedReason, UpdateStatus};

pub const LINUX_UPDATE_NOTICE_URL: &str = "https://www.videorc.com/api/changelog";
/// Dev-only override, for checking against a local endpoint. Packaged builds
/// refuse it (see [`linux_update_notice_source`]).
pub const LINUX_UPDATE_NOTICE_URL_ENV: &str = "VIDEORC_LINUX_UPDATE_NOTICE_URL";
pub const LINUX_UPDATE_NOTICE_TIMEOUT_MS: u64 = 15_000;

/// A release version: `major.minor.patch`, with an optional pre-release.
/// Anything else is refused. Build metadata is read and ignored.
pub fn parse_release_version(version: &str) -> Option<Version> {
    let mut parsed = Version::parse(version.trim()).ok()?;
    parsed.build = semver::BuildMetadata::EMPTY;
    Some(parsed)
}

/// Whether a published release is newer than the running app. A Linux
/// AppImage reports its package version (0.14.0) for the release id it
/// shipped as (0.14.0-alpha.1), so against a running version with no
/// pre-release only the core counts: 0.14.0-alpha.2 is not news to a 0.14.0
/// build.
pub fn is_newer_release(published: &str, running: &str) -> bool {
    let (Some(mut candidate), Some(current)) = (
        parse_release_version(published),
        parse_release_version(running),
    ) else {
        return false;
    };
    if current.pre.is_empty() {
        candidate.pre = Prerelease::EMPTY;
    }
    candidate > current
}

fn same_release_line(published: &Version, running: &Version) -> bool {
    published.major == running.major
        && published.minor == running.minor
        && published.patch == running.patch
}

/// What the changelog says about this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxVersionCheck {
    Newer {
        version: String,
    },
    Current,
    /// The source failed, or does not list this Linux line: say nothing
    /// either way.
    Unknown,
}

/// Reads the `/api/changelog` answer. `Newer` needs a published Linux entry
/// newer than the running build; `Current` needs the running build's own
/// line to be listed for Linux with nothing newer, which proves the
/// changelog publishes Linux releases at all.
pub fn evaluate_linux_changelog(raw: &Value, running_version: &str) -> LinuxVersionCheck {
    let Some(running) = parse_release_version(running_version) else {
        return LinuxVersionCheck::Unknown;
    };
    let Some(entries) = raw.get("entries").and_then(Value::as_array) else {
        return LinuxVersionCheck::Unknown;
    };

    let mut newest: Option<(&str, Version)> = None;
    let mut lists_running_line = false;
    for entry in entries {
        let Some(version) = entry.get("version").and_then(Value::as_str) else {
            continue;
        };
        let names_linux = entry
            .get("platforms")
            .and_then(Value::as_array)
            .is_some_and(|platforms| {
                platforms
                    .iter()
                    .any(|platform| platform.as_str() == Some("linux"))
            });
        if !names_linux {
            continue;
        }
        let Some(parsed) = parse_release_version(version) else {
            continue;
        };
        if same_release_line(&parsed, &running) {
            lists_running_line = true;
        }
        if is_newer_release(version, running_version)
            && newest.as_ref().is_none_or(|(_, known)| parsed > *known)
        {
            newest = Some((version, parsed));
        }
    }

    match newest {
        Some((version, _)) => LinuxVersionCheck::Newer {
            version: version.to_string(),
        },
        None if lists_running_line => LinuxVersionCheck::Current,
        None => LinuxVersionCheck::Unknown,
    }
}

/// Reads the changelog's answer as text. A body that is not JSON is
/// `Unknown`, quietly, like an answer that never came.
pub fn evaluate_linux_changelog_text(body: &str, running_version: &str) -> LinuxVersionCheck {
    match serde_json::from_str::<Value>(body) {
        Ok(raw) => evaluate_linux_changelog(&raw, running_version),
        Err(_) => LinuxVersionCheck::Unknown,
    }
}

/// The changelog URL, asking only for entries from the running line on
/// (`since` is exclusive and release-id shaped, so `<core>-alpha.0` keeps
/// the running line's own entries). The answer is still filtered here, so a
/// server that ignores `since` only costs bytes.
pub fn linux_update_notice_url(base_url: &str, running_version: &str) -> String {
    let Some(running) = parse_release_version(running_version) else {
        return base_url.to_string();
    };
    let since = format!(
        "since={}.{}.{}-alpha.0",
        running.major, running.minor, running.patch
    );
    let (address, fragment) = match base_url.split_once('#') {
        Some((address, fragment)) => (address, Some(fragment)),
        None => (base_url, None),
    };
    let mut url = match address.split_once('?') {
        None => format!("{address}?{since}"),
        Some((path, query)) => {
            let mut kept: Vec<&str> = query
                .split('&')
                .filter(|pair| !pair.is_empty() && !pair.starts_with("since="))
                .collect();
            kept.push(&since);
            format!("{path}?{}", kept.join("&"))
        }
    };
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

/// Where the check goes, or `None` when it must not run. Packaged Linux
/// builds always ask videorc.com; a dev run checks only when pointed at a
/// local endpoint, so a dev run never calls production. `override_url` is
/// the value of [`LINUX_UPDATE_NOTICE_URL_ENV`], when it is set.
pub fn linux_update_notice_source(override_url: Option<&str>, is_packaged: bool) -> Option<String> {
    if is_packaged {
        return Some(LINUX_UPDATE_NOTICE_URL.to_string());
    }
    let override_url = override_url?.trim();
    (!override_url.is_empty()).then(|| override_url.to_string())
}

/// The Settings status for a check's outcome.
pub fn linux_update_notice_status(
    check: &LinuxVersionCheck,
    running_version: &str,
) -> UpdateStatus {
    match check {
        LinuxVersionCheck::Newer { version } => UpdateStatus::DownloadAvailable {
            version: version.clone(),
        },
        LinuxVersionCheck::Current => UpdateStatus::NotAvailable {
            current_version: running_version.to_string(),
        },
        LinuxVersionCheck::Unknown => UpdateStatus::Unsupported {
            reason: Some(UnsupportedReason::LinuxVersionUnknown),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use serde_json::json;

    use super::*;

    fn compare(a: &str, b: &str) -> Ordering {
        let left = parse_release_version(a).unwrap_or_else(|| panic!("unparsable {a}"));
        let right = parse_release_version(b).unwrap_or_else(|| panic!("unparsable {b}"));
        left.cmp(&right)
    }

    fn entry(version: &str, platforms: &[&str]) -> Value {
        json!({
            "version": version,
            "platforms": platforms,
            "channel": "alpha",
            "title": "t",
            "summary": "s",
            "highlights": ["h"]
        })
    }

    /// An entry for Windows and Linux, as most are.
    fn both(version: &str) -> Value {
        entry(version, &["windows", "linux"])
    }

    fn newer(version: &str) -> LinuxVersionCheck {
        LinuxVersionCheck::Newer {
            version: version.to_string(),
        }
    }

    // release version precedence

    #[test]
    fn orders_cores_numerically_not_as_strings() {
        assert_eq!(compare("0.10.0", "0.9.150"), Ordering::Greater);
        assert_eq!(compare("0.9.119", "0.13.0"), Ordering::Less);
        assert_eq!(compare("1.0.0", "0.99.99"), Ordering::Greater);
    }

    #[test]
    fn orders_alpha_n_numerically_and_below_the_release() {
        assert_eq!(
            compare("0.14.0-alpha.10", "0.14.0-alpha.2"),
            Ordering::Greater
        );
        assert_eq!(compare("0.14.0-alpha.1", "0.14.0"), Ordering::Less);
        assert_eq!(compare("0.14.0-alpha.1", "0.14.0-beta.1"), Ordering::Less);
        assert_eq!(compare("0.14.0-alpha", "0.14.0-alpha.1"), Ordering::Less);
        assert_eq!(compare("0.14.0-alpha.1", "0.14.0-alpha.1"), Ordering::Equal);
        // Build metadata never orders two versions.
        assert_eq!(compare("0.14.0+a", "0.14.0+b"), Ordering::Equal);
    }

    #[test]
    fn refuses_anything_that_is_not_a_release_version() {
        for bad in [
            "",
            "latest",
            "0.14",
            "v0.14.0",
            "0.14.0-",
            "0.14.0-alpha..1",
        ] {
            assert_eq!(parse_release_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn compares_only_the_core_against_a_build_that_reports_no_pre_release() {
        // The 0.14.0-alpha.1 AppImage reports 0.14.0.
        assert!(is_newer_release("0.15.0-alpha.1", "0.14.0"));
        assert!(is_newer_release("0.14.1-alpha.1", "0.14.0"));
        assert!(!is_newer_release("0.14.0-alpha.1", "0.14.0"));
        assert!(!is_newer_release("0.14.0-alpha.2", "0.14.0"));
        assert!(!is_newer_release("0.13.0-alpha.1", "0.14.0"));
    }

    #[test]
    fn compares_the_full_version_against_a_build_that_reports_its_pre_release() {
        assert!(is_newer_release("0.14.0-alpha.2", "0.14.0-alpha.1"));
        assert!(!is_newer_release("0.14.0-alpha.1", "0.14.0-alpha.1"));
        assert!(!is_newer_release("garbage", "0.14.0"));
    }

    // evaluateLinuxChangelog

    #[test]
    fn reports_the_newest_published_linux_release_newer_than_the_running_build() {
        let changelog = json!({ "entries": [
            entry("0.16.0-beta.1", &["macos"]),
            both("0.15.0-alpha.1"),
            entry("0.15.1-alpha.1", &["linux"]),
            both("0.14.0-alpha.1")
        ]});
        assert_eq!(
            evaluate_linux_changelog(&changelog, "0.14.0"),
            newer("0.15.1-alpha.1")
        );
    }

    #[test]
    fn is_current_only_when_the_running_linux_line_is_listed_and_nothing_is_newer() {
        let changelog =
            json!({ "entries": [entry("0.14.0-beta.1", &["macos"]), both("0.14.0-alpha.1")] });
        assert_eq!(
            evaluate_linux_changelog(&changelog, "0.14.0"),
            LinuxVersionCheck::Current
        );
    }

    #[test]
    fn never_claims_latest_when_the_changelog_lists_no_linux_release_for_this_line() {
        // Linux entries withheld, only macOS and Windows public.
        let changelog = json!({ "entries": [
            entry("0.14.0-beta.1", &["macos"]),
            entry("0.9.91-alpha.1", &["windows"])
        ]});
        assert_eq!(
            evaluate_linux_changelog(&changelog, "0.14.0"),
            LinuxVersionCheck::Unknown
        );
        assert_eq!(
            evaluate_linux_changelog(&json!({ "entries": [] }), "0.14.0"),
            LinuxVersionCheck::Unknown
        );
    }

    #[test]
    fn never_notices_a_macos_only_or_windows_only_release() {
        let changelog = json!({ "entries": [
            entry("0.20.0-beta.1", &["macos"]),
            entry("0.20.0-alpha.1", &["windows"])
        ]});
        assert_eq!(
            evaluate_linux_changelog(&changelog, "0.14.0"),
            LinuxVersionCheck::Unknown
        );
    }

    #[test]
    fn skips_malformed_entries_and_answers() {
        let changelog = json!({ "entries": [
            null,
            "x",
            { "version": 15, "platforms": ["linux"] },
            { "version": "0.99.0-alpha.1", "platforms": "linux" },
            both("not-a-version"),
            both("0.15.0-alpha.1")
        ]});
        assert_eq!(
            evaluate_linux_changelog(&changelog, "0.14.0"),
            newer("0.15.0-alpha.1")
        );
        assert_eq!(
            evaluate_linux_changelog(&Value::Null, "0.14.0"),
            LinuxVersionCheck::Unknown
        );
        assert_eq!(
            evaluate_linux_changelog(&json!({ "entries": "nope" }), "0.14.0"),
            LinuxVersionCheck::Unknown
        );
        assert_eq!(
            evaluate_linux_changelog(&json!({ "entries": [both("0.15.0-alpha.1")] }), "dev"),
            LinuxVersionCheck::Unknown
        );
    }

    // linuxUpdateNoticeUrl

    #[test]
    fn asks_only_for_the_running_line_on_keeping_its_own_entries() {
        assert_eq!(
            linux_update_notice_url(LINUX_UPDATE_NOTICE_URL, "0.14.0"),
            "https://www.videorc.com/api/changelog?since=0.14.0-alpha.0"
        );
        assert_eq!(
            linux_update_notice_url("http://127.0.0.1:4100/api/changelog", "0.14.0-alpha.3"),
            "http://127.0.0.1:4100/api/changelog?since=0.14.0-alpha.0"
        );
        // Beyond the original's cases: a base that already has a query.
        assert_eq!(
            linux_update_notice_url(
                "http://127.0.0.1:4100/api/changelog?since=old&x=1",
                "0.14.0"
            ),
            "http://127.0.0.1:4100/api/changelog?x=1&since=0.14.0-alpha.0"
        );
        assert_eq!(
            linux_update_notice_url(LINUX_UPDATE_NOTICE_URL, "dev"),
            LINUX_UPDATE_NOTICE_URL
        );
    }

    // linuxUpdateNoticeSource

    #[test]
    fn always_asks_videorc_com_from_a_packaged_build_whatever_the_environment_says() {
        assert_eq!(
            linux_update_notice_source(Some("http://evil.test/"), true).as_deref(),
            Some(LINUX_UPDATE_NOTICE_URL)
        );
    }

    #[test]
    fn checks_a_dev_build_only_against_an_explicit_local_endpoint() {
        assert_eq!(linux_update_notice_source(None, false), None);
        assert_eq!(linux_update_notice_source(Some(" "), false), None);
        assert_eq!(
            linux_update_notice_source(Some("http://127.0.0.1:4100/api/changelog"), false)
                .as_deref(),
            Some("http://127.0.0.1:4100/api/changelog")
        );
    }

    // checkLinuxUpdateNotice

    #[test]
    fn reads_a_newer_release_from_the_endpoints_answer() {
        let body = json!({ "entries": [both("0.15.0-alpha.1"), both("0.14.0-alpha.1")] });
        assert_eq!(
            evaluate_linux_changelog_text(&body.to_string(), "0.14.0"),
            newer("0.15.0-alpha.1")
        );
    }

    #[test]
    fn stays_quiet_on_a_body_that_is_not_json() {
        assert_eq!(
            evaluate_linux_changelog_text("<html>503</html>", "0.14.0"),
            LinuxVersionCheck::Unknown
        );
        assert_eq!(
            evaluate_linux_changelog_text("", "0.14.0"),
            LinuxVersionCheck::Unknown
        );
    }

    // linuxUpdateNoticeStatus

    #[test]
    fn maps_each_outcome_to_the_settings_status() {
        assert_eq!(
            linux_update_notice_status(&newer("0.15.0-alpha.1"), "0.14.0"),
            UpdateStatus::DownloadAvailable {
                version: "0.15.0-alpha.1".to_string()
            }
        );
        assert_eq!(
            linux_update_notice_status(&LinuxVersionCheck::Current, "0.14.0"),
            UpdateStatus::NotAvailable {
                current_version: "0.14.0".to_string()
            }
        );
        assert_eq!(
            linux_update_notice_status(&LinuxVersionCheck::Unknown, "0.14.0"),
            UpdateStatus::Unsupported {
                reason: Some(UnsupportedReason::LinuxVersionUnknown)
            }
        );
    }
}
