//! What a Linux desktop is missing, in words (plan 257 S18, #1678): three
//! Health rows (Keyring, Device groups, Screen portal) and, for each that
//! needs the streamer, one alert that says what to install.
//! `lib/linux-desktop-check.ts`, word for word, over the backend's
//! `diagnostics.linuxDesktop` answer as JSON.

use serde_json::Value;

use super::health_page::{CheckWords, Tone};

/// The OS keyring as the app found it (Electron reads it from `safeStorage`;
/// the GPUI app's shell reports its own).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxKeyringStatus {
    /// `gnome_libsecret`, `kwallet6`, `basic_text`, `unknown`.
    pub backend: String,
    /// Sign-in and folder grants can be sealed with it.
    pub available: bool,
    /// The `--password-store` the person passed at launch, when they did.
    pub user_password_store: Option<String>,
}

/// `LinuxSetupIssue`: one thing to fix on this desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxSetupIssue {
    /// `keyring`, `device-groups`, `screen-portal`.
    pub id: &'static str,
    pub title: String,
    pub description: String,
}

/// One Health row: `id`, label and words.
#[derive(Debug, Clone, PartialEq)]
pub struct LinuxCheckRow {
    pub id: &'static str,
    pub label: &'static str,
    pub words: CheckWords,
}

const KEYRING_NEEDS: &str =
    "Signing in to Videorc and remembering your recordings folder need a keyring (Secret Service).";
const KEYRING_INSTALL: &str = "Install GNOME Keyring (gnome-keyring) or KWallet, make sure it starts with your desktop, then restart Videorc.";

fn words(value: impl Into<String>, tone: Tone) -> CheckWords {
    CheckWords {
        value: value.into(),
        tone,
    }
}

fn keyring_backend_label(backend: &str) -> &'static str {
    if backend.starts_with("kwallet") {
        "KWallet"
    } else if backend == "gnome_libsecret" {
        "Secret Service"
    } else {
        "Available"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyringProblem {
    TurnedOff,
    NoService,
    CannotOpen,
    Unavailable,
}

fn keyring_problem(
    keyring: &LinuxKeyringStatus,
    secret_service: Option<&str>,
) -> Option<KeyringProblem> {
    if keyring.available {
        return None;
    }
    if keyring
        .user_password_store
        .as_deref()
        .is_some_and(|store| !store.is_empty() && store != "gnome-libsecret")
    {
        return Some(KeyringProblem::TurnedOff);
    }
    Some(match secret_service {
        Some("missing") => KeyringProblem::NoService,
        Some("running" | "activatable") => KeyringProblem::CannotOpen,
        _ => KeyringProblem::Unavailable,
    })
}

/// `keyringCheck`.
pub fn keyring_check(keyring: &LinuxKeyringStatus, secret_service: Option<&str>) -> CheckWords {
    match keyring_problem(keyring, secret_service) {
        None => words(keyring_backend_label(&keyring.backend), Tone::Good),
        Some(KeyringProblem::TurnedOff) => words("Turned off", Tone::Error),
        Some(KeyringProblem::NoService) => words("Not found", Tone::Error),
        Some(KeyringProblem::CannotOpen) => words("Can't open", Tone::Error),
        Some(KeyringProblem::Unavailable) => words("Not available", Tone::Error),
    }
}

/// `keyringIssue`.
pub fn keyring_issue(
    keyring: &LinuxKeyringStatus,
    secret_service: Option<&str>,
) -> Option<LinuxSetupIssue> {
    let issue = |title: String, description: String| LinuxSetupIssue {
        id: "keyring",
        title,
        description,
    };
    Some(match keyring_problem(keyring, secret_service)? {
        KeyringProblem::TurnedOff => issue(
            format!(
                "Videorc was started with --password-store={}",
                keyring.user_password_store.as_deref().unwrap_or_default()
            ),
            format!(
                "{KEYRING_NEEDS} Start Videorc without --password-store, or with --password-store=gnome-libsecret."
            ),
        ),
        KeyringProblem::NoService => issue(
            "No keyring on this desktop".to_string(),
            format!("{KEYRING_NEEDS} {KEYRING_INSTALL}"),
        ),
        KeyringProblem::CannotOpen => issue(
            "Videorc can't open your keyring".to_string(),
            format!(
                "{KEYRING_NEEDS} One is running, but Videorc couldn't use it. Unlock it if your desktop asks; otherwise install libsecret (libsecret-1-0 on Ubuntu and Debian), then restart Videorc."
            ),
        ),
        KeyringProblem::Unavailable => issue(
            "No keyring Videorc can use".to_string(),
            format!("{KEYRING_NEEDS} {KEYRING_INSTALL}"),
        ),
    })
}

struct Group<'a> {
    name: &'a str,
    exists: bool,
    member: bool,
    accessible: f64,
    devices: f64,
}

fn groups(value: &Value) -> Vec<Group<'_>> {
    value
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .map(|group| Group {
                    name: group
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    exists: group
                        .get("exists")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    member: group
                        .get("member")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    accessible: group
                        .get("accessible")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    devices: group.get("devices").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A group that exists, guards a device this run can't open, and isn't ours.
fn blocked<'a>(groups: &'a [Group<'a>]) -> Vec<&'a Group<'a>> {
    groups
        .iter()
        .filter(|group| group.exists && !group.member && group.accessible < group.devices)
        .collect()
}

fn join_or(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

/// `deviceGroupsCheck`.
pub fn device_groups_check(value: &Value) -> CheckWords {
    let groups = groups(value);
    let blocked = blocked(&groups);
    if !blocked.is_empty() {
        let names: Vec<String> = blocked.iter().map(|group| group.name.to_string()).collect();
        return words(format!("Not in {}", join_or(&names)), Tone::Warn);
    }
    let existing: Vec<&Group> = groups.iter().filter(|group| group.exists).collect();
    if !existing.is_empty() && existing.iter().all(|group| group.member) {
        let names: Vec<&str> = existing.iter().map(|group| group.name).collect();
        return words(format!("In {}", names.join(" and ")), Tone::Good);
    }
    // Not in a group, but the seat ACL (uaccess) or a 0666 node opens it.
    words("Desktop grants access", Tone::Good)
}

/// `deviceGroupsIssue`.
pub fn device_groups_issue(value: &Value) -> Option<LinuxSetupIssue> {
    let groups = groups(value);
    let blocked = blocked(&groups);
    if blocked.is_empty() {
        return None;
    }
    let names: Vec<String> = blocked.iter().map(|group| group.name.to_string()).collect();
    let devices: Vec<String> = blocked
        .iter()
        .map(|group| match group.name {
            "video" => "your camera".to_string(),
            "render" => "the GPU encoder".to_string(),
            other => format!("{other} devices"),
        })
        .collect();
    Some(LinuxSetupIssue {
        id: "device-groups",
        title: format!("Videorc can't open {}", join_or(&devices)),
        description: format!(
            "Your user isn't in the {} group{}. Run “sudo usermod -aG {} $USER”, then log out and back in.",
            join_or(&names),
            if names.len() > 1 { "s" } else { "" },
            names.join(",")
        ),
    })
}

/// `portalBackendPackage`: the portal backend for this desktop, from
/// `XDG_CURRENT_DESKTOP`.
pub fn portal_backend_package(current_desktop: Option<&str>) -> Option<&'static str> {
    for desktop in current_desktop
        .unwrap_or_default()
        .split(':')
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
    {
        match desktop.as_str() {
            "hyprland" => return Some("xdg-desktop-portal-hyprland"),
            "kde" => return Some("xdg-desktop-portal-kde"),
            "gnome" | "niri" => return Some("xdg-desktop-portal-gnome"),
            "cosmic" => return Some("xdg-desktop-portal-cosmic"),
            "sway" | "river" | "wayfire" | "labwc" | "wlroots" => {
                return Some("xdg-desktop-portal-wlr");
            }
            _ => {}
        }
    }
    None
}

fn portal_install_line(current_desktop: Option<&str>) -> String {
    let name = current_desktop
        .and_then(|desktop| desktop.split(':').next())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    match (portal_backend_package(current_desktop), name) {
        (Some(package), Some(name)) => format!("{package} (the one for {name})"),
        _ => "the portal for your desktop (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr)"
            .to_string(),
    }
}

fn portal_timed_out(portal: &Value) -> bool {
    portal
        .get("detail")
        .and_then(Value::as_str)
        .is_some_and(|detail| detail.contains("in time"))
}

/// `linuxDesktopCheckSettled`: the bus answered and the portal did too.
pub fn linux_desktop_check_settled(check: &Value) -> bool {
    let portal = check.get("portal").unwrap_or(&Value::Null);
    portal.get("frontend").and_then(Value::as_str) != Some("unknown") && !portal_timed_out(portal)
}

/// `screenPortalCheck`.
pub fn screen_portal_check(portal: &Value) -> CheckWords {
    match portal.get("frontend").and_then(Value::as_str) {
        Some("unknown") => return words("Couldn't check", Tone::Neutral),
        Some("missing") => return words("Not installed", Tone::Error),
        _ => {}
    }
    if portal.get("screenCastVersion").is_none_or(Value::is_null) {
        // A frontend that did not answer in time is not proof of a missing
        // backend.
        if portal_timed_out(portal) {
            return words("Couldn't check", Tone::Neutral);
        }
        return words("No screen sharing", Tone::Error);
    }
    words("Ready", Tone::Good)
}

/// `screenPortalIssue`.
pub fn screen_portal_issue(
    portal: &Value,
    current_desktop: Option<&str>,
) -> Option<LinuxSetupIssue> {
    if screen_portal_check(portal).tone != Tone::Error {
        return None;
    }
    if portal.get("frontend").and_then(Value::as_str) == Some("missing") {
        return Some(LinuxSetupIssue {
            id: "screen-portal",
            title: "Screen capture needs xdg-desktop-portal".to_string(),
            description: format!(
                "Install xdg-desktop-portal and {}, then log out and back in.",
                portal_install_line(current_desktop)
            ),
        });
    }
    let backends: Vec<&str> = portal
        .get("backends")
        .and_then(Value::as_array)
        .map(|backends| backends.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let found = if backends.is_empty() {
        String::new()
    } else {
        format!(" ({})", backends.join(", "))
    };
    Some(LinuxSetupIssue {
        id: "screen-portal",
        title: "Your desktop's portal can't share the screen".to_string(),
        description: format!(
            "xdg-desktop-portal is running, but none of the portals installed here{found} can share the screen. Install {}, then log out and back in.",
            portal_install_line(current_desktop)
        ),
    })
}

fn secret_service(desktop: Option<&Value>) -> Option<&str> {
    desktop
        .and_then(|desktop| desktop.get("secretService"))
        .and_then(Value::as_str)
}

/// `linuxDesktopChecks`: the Linux rows for Health, in order; none off
/// Linux or before the data arrives.
pub fn linux_desktop_checks(
    keyring: Option<&LinuxKeyringStatus>,
    desktop: Option<&Value>,
) -> Vec<LinuxCheckRow> {
    let mut rows = Vec::new();
    if let Some(keyring) = keyring {
        rows.push(LinuxCheckRow {
            id: "keyring",
            label: "Keyring",
            words: keyring_check(keyring, secret_service(desktop)),
        });
    }
    if let Some(desktop) = desktop {
        rows.push(LinuxCheckRow {
            id: "device-groups",
            label: "Device groups",
            words: device_groups_check(desktop.get("groups").unwrap_or(&Value::Null)),
        });
        rows.push(LinuxCheckRow {
            id: "screen-portal",
            label: "Screen portal",
            words: screen_portal_check(desktop.get("portal").unwrap_or(&Value::Null)),
        });
    }
    rows
}

/// `linuxDesktopIssues`: what to fix, one alert per row that needs it.
pub fn linux_desktop_issues(
    keyring: Option<&LinuxKeyringStatus>,
    desktop: Option<&Value>,
) -> Vec<LinuxSetupIssue> {
    [
        keyring.and_then(|keyring| keyring_issue(keyring, secret_service(desktop))),
        desktop
            .and_then(|desktop| device_groups_issue(desktop.get("groups").unwrap_or(&Value::Null))),
        desktop.and_then(|desktop| {
            screen_portal_issue(
                desktop.get("portal").unwrap_or(&Value::Null),
                desktop.get("currentDesktop").and_then(Value::as_str),
            )
        }),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn keyring(available: bool, store: Option<&str>) -> LinuxKeyringStatus {
        LinuxKeyringStatus {
            backend: "gnome_libsecret".to_string(),
            available,
            user_password_store: store.map(str::to_string),
        }
    }

    #[test]
    fn the_keyring_row_and_its_alert() {
        assert_eq!(
            keyring_check(&keyring(true, None), None).value,
            "Secret Service"
        );
        assert_eq!(
            keyring_check(&keyring(false, Some("basic")), None).value,
            "Turned off"
        );
        assert_eq!(
            keyring_issue(&keyring(false, Some("basic")), None)
                .unwrap()
                .title,
            "Videorc was started with --password-store=basic"
        );
        assert_eq!(
            keyring_check(&keyring(false, None), Some("missing")).value,
            "Not found"
        );
        assert_eq!(
            keyring_check(&keyring(false, None), Some("running")).value,
            "Can't open"
        );
        let issue = keyring_issue(&keyring(false, None), None).unwrap();
        assert_eq!(issue.title, "No keyring Videorc can use");
        assert!(issue.description.ends_with("then restart Videorc."));
    }

    #[test]
    fn device_groups_say_which_group_and_the_command() {
        let blocked = json!([
            {"name": "video", "exists": true, "member": false, "accessible": 0, "devices": 1},
            {"name": "render", "exists": true, "member": false, "accessible": 0, "devices": 1}
        ]);
        assert_eq!(
            device_groups_check(&blocked).value,
            "Not in video or render"
        );
        let issue = device_groups_issue(&blocked).unwrap();
        assert_eq!(
            issue.title,
            "Videorc can't open your camera or the GPU encoder"
        );
        assert_eq!(
            issue.description,
            "Your user isn't in the video or render groups. Run “sudo usermod -aG video,render $USER”, then log out and back in."
        );
        let member = json!([
            {"name": "video", "exists": true, "member": true, "accessible": 1, "devices": 1},
            {"name": "render", "exists": true, "member": true, "accessible": 1, "devices": 1}
        ]);
        assert_eq!(device_groups_check(&member).value, "In video and render");
        let acl = json!([{"name": "video", "exists": true, "member": false, "accessible": 1, "devices": 1}]);
        assert_eq!(device_groups_check(&acl).value, "Desktop grants access");
    }

    #[test]
    fn the_portal_row_names_the_package_for_this_desktop() {
        assert_eq!(
            screen_portal_check(&json!({"frontend": "unknown"})).value,
            "Couldn't check"
        );
        assert_eq!(
            screen_portal_check(&json!({"frontend": "running", "detail": "no answer in time"}))
                .value,
            "Couldn't check"
        );
        assert_eq!(
            screen_portal_check(&json!({"frontend": "running", "screenCastVersion": 5})).value,
            "Ready"
        );
        let missing = json!({"frontend": "missing", "backends": []});
        assert_eq!(
            screen_portal_issue(&missing, Some("Hyprland"))
                .unwrap()
                .description,
            "Install xdg-desktop-portal and xdg-desktop-portal-hyprland (the one for Hyprland), then log out and back in."
        );
        let none = json!({"frontend": "running", "backends": ["gtk"]});
        assert_eq!(
            screen_portal_issue(&none, None).unwrap().description,
            "xdg-desktop-portal is running, but none of the portals installed here (gtk) can share the screen. Install the portal for your desktop (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr), then log out and back in."
        );
        assert_eq!(
            portal_backend_package(Some("ubuntu:GNOME")),
            Some("xdg-desktop-portal-gnome")
        );
    }

    #[test]
    fn the_rows_appear_only_with_their_data() {
        assert!(linux_desktop_checks(None, None).is_empty());
        let desktop = json!({"groups": [], "portal": {"frontend": "unknown"}});
        let rows = linux_desktop_checks(Some(&keyring(true, None)), Some(&desktop));
        let labels: Vec<&str> = rows.iter().map(|row| row.label).collect();
        assert_eq!(labels, ["Keyring", "Device groups", "Screen portal"]);
        assert!(linux_desktop_issues(Some(&keyring(true, None)), Some(&desktop)).is_empty());
    }
}
