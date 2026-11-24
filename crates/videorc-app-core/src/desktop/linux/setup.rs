//! What a Linux desktop is missing, in words (plan 257 S18, plan 260 S2.6c):
//! the renderer's `lib/linux-desktop-check.ts`, copy for copy.
//!
//! Three Health rows (Keyring, Device groups, Screen portal) and, for each
//! that needs the streamer, one alert that says what to install.
//! Destinations shows the keyring alert too, before any sign-in starts.
//!
//! The backend's `diagnostics.linuxDesktop` answer is mirrored here
//! ([`LinuxDesktopCheck`], the backend's `linux_desktop_check.rs`) until it
//! moves to `videorc-protocol` with the rest of diagnostics (L2). The keyring
//! status is the app's own: Electron read Chromium's `safeStorage`; the GPUI
//! app asks its own Secret Service client (the Linux store fills
//! it in S2.1), so `user_password_store` stays `None` there.

use serde::{Deserialize, Serialize};

/// A well-known D-Bus name on the session bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BusServiceState {
    Running,
    Activatable,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxPortalCheck {
    /// `org.freedesktop.portal.Desktop`, the portal frontend.
    pub frontend: BusServiceState,
    /// ScreenCast's version; absent when no portal backend offers it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_cast_version: Option<u32>,
    /// The `org.freedesktop.impl.portal.desktop.*` backends on the bus.
    #[serde(default)]
    pub backends: Vec<String>,
    /// Why ScreenCast could not be read, for support bundles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDeviceGroupCheck {
    /// `video` or `render`.
    pub name: String,
    pub exists: bool,
    /// This run carries the group; `usermod -aG` counts only after logging in again.
    pub member: bool,
    /// Device nodes the group guards.
    pub devices: u32,
    /// How many of them open read-write.
    pub accessible: u32,
}

/// `diagnostics.linuxDesktop`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDesktopCheck {
    /// `org.freedesktop.secrets`: GNOME Keyring, KWallet, KeePassXC.
    pub secret_service: BusServiceState,
    pub portal: LinuxPortalCheck,
    #[serde(default)]
    pub groups: Vec<LinuxDeviceGroupCheck>,
    /// `XDG_CURRENT_DESKTOP`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_desktop: Option<String>,
}

/// The keyring as this app sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxKeyringStatus {
    /// The store in use: `gnome_libsecret`, `kwallet6`, `basic_text`, `unknown`.
    pub backend: String,
    /// True when Videorc can seal sign-in and folder grants with it.
    pub available: bool,
    /// The `--password-store` the person passed at launch, when they did.
    #[serde(default)]
    pub user_password_store: Option<String>,
}

/// A Health row's colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckTone {
    Good,
    Warn,
    Error,
    Neutral,
}

/// A Health row's value and colour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckWords {
    pub value: String,
    pub tone: CheckTone,
}

fn words(value: impl Into<String>, tone: CheckTone) -> CheckWords {
    CheckWords {
        value: value.into(),
        tone,
    }
}

/// One Health row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthRow {
    pub id: SetupIssueId,
    pub label: &'static str,
    pub value: String,
    pub tone: CheckTone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupIssueId {
    Keyring,
    DeviceGroups,
    ScreenPortal,
}

impl SetupIssueId {
    pub fn as_str(self) -> &'static str {
        match self {
            SetupIssueId::Keyring => "keyring",
            SetupIssueId::DeviceGroups => "device-groups",
            SetupIssueId::ScreenPortal => "screen-portal",
        }
    }
}

/// One thing to fix on this desktop: a title and what to install or run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupIssue {
    pub id: SetupIssueId,
    pub title: String,
    pub description: String,
}

const KEYRING_NEEDS: &str =
    "Signing in to Videorc and remembering your recordings folder need a keyring (Secret Service).";

const KEYRING_INSTALL: &str = "Install GNOME Keyring (gnome-keyring) or KWallet, make sure it starts with your desktop, then restart Videorc.";

/// Main's refusal when sign-in starts with no keyring Videorc can use
/// (`shared/linux-keyring.ts`).
pub const KEYRING_SIGN_IN_REFUSAL: &str = "Signing in needs a keyring (Secret Service), and Videorc found none it can use. Install GNOME Keyring or KWallet, make sure it starts with your desktop, then restart Videorc. Health has the details.";

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
    secret_service: Option<BusServiceState>,
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
    match secret_service {
        Some(BusServiceState::Missing) => Some(KeyringProblem::NoService),
        Some(BusServiceState::Running | BusServiceState::Activatable) => {
            Some(KeyringProblem::CannotOpen)
        }
        _ => Some(KeyringProblem::Unavailable),
    }
}

pub fn keyring_check(
    keyring: &LinuxKeyringStatus,
    secret_service: Option<BusServiceState>,
) -> CheckWords {
    match keyring_problem(keyring, secret_service) {
        None => words(keyring_backend_label(&keyring.backend), CheckTone::Good),
        Some(KeyringProblem::TurnedOff) => words("Turned off", CheckTone::Error),
        Some(KeyringProblem::NoService) => words("Not found", CheckTone::Error),
        Some(KeyringProblem::CannotOpen) => words("Can't open", CheckTone::Error),
        Some(KeyringProblem::Unavailable) => words("Not available", CheckTone::Error),
    }
}

pub fn keyring_issue(
    keyring: &LinuxKeyringStatus,
    secret_service: Option<BusServiceState>,
) -> Option<SetupIssue> {
    let issue = |title: String, description: String| SetupIssue {
        id: SetupIssueId::Keyring,
        title,
        description,
    };
    match keyring_problem(keyring, secret_service)? {
        KeyringProblem::TurnedOff => {
            let store = keyring.user_password_store.as_deref().unwrap_or_default();
            Some(issue(
                format!("Videorc was started with --password-store={store}"),
                format!(
                    "{KEYRING_NEEDS} Start Videorc without --password-store, or with --password-store=gnome-libsecret."
                ),
            ))
        }
        KeyringProblem::NoService => Some(issue(
            "No keyring on this desktop".to_string(),
            format!("{KEYRING_NEEDS} {KEYRING_INSTALL}"),
        )),
        KeyringProblem::CannotOpen => Some(issue(
            "Videorc can't open your keyring".to_string(),
            format!(
                "{KEYRING_NEEDS} One is running, but Videorc couldn't use it. Unlock it if your desktop asks; otherwise install libsecret (libsecret-1-0 on Ubuntu and Debian), then restart Videorc."
            ),
        )),
        KeyringProblem::Unavailable => Some(issue(
            "No keyring Videorc can use".to_string(),
            format!("{KEYRING_NEEDS} {KEYRING_INSTALL}"),
        )),
    }
}

/// A group that exists, guards a device this run can't open, and isn't ours.
fn blocked_groups(groups: &[LinuxDeviceGroupCheck]) -> Vec<&LinuxDeviceGroupCheck> {
    groups
        .iter()
        .filter(|group| group.exists && !group.member && group.accessible < group.devices)
        .collect()
}

fn join_or(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [head @ .., last] => format!("{} or {last}", head.join(", ")),
    }
}

pub fn device_groups_check(groups: &[LinuxDeviceGroupCheck]) -> CheckWords {
    let blocked = blocked_groups(groups);
    if !blocked.is_empty() {
        let names: Vec<String> = blocked.iter().map(|group| group.name.clone()).collect();
        return words(format!("Not in {}", join_or(&names)), CheckTone::Warn);
    }
    let existing: Vec<&LinuxDeviceGroupCheck> =
        groups.iter().filter(|group| group.exists).collect();
    if !existing.is_empty() && existing.iter().all(|group| group.member) {
        let names: Vec<&str> = existing.iter().map(|group| group.name.as_str()).collect();
        return words(format!("In {}", names.join(" and ")), CheckTone::Good);
    }
    // Not in a group, but the seat ACL (uaccess) or a 0666 node opens the device.
    words("Desktop grants access", CheckTone::Good)
}

fn group_device(name: &str) -> String {
    match name {
        "video" => "your camera".to_string(),
        "render" => "the GPU encoder".to_string(),
        other => format!("{other} devices"),
    }
}

pub fn device_groups_issue(groups: &[LinuxDeviceGroupCheck]) -> Option<SetupIssue> {
    let blocked = blocked_groups(groups);
    if blocked.is_empty() {
        return None;
    }
    let names: Vec<String> = blocked.iter().map(|group| group.name.clone()).collect();
    let devices: Vec<String> = blocked
        .iter()
        .map(|group| group_device(&group.name))
        .collect();
    let plural = if names.len() > 1 { "s" } else { "" };
    Some(SetupIssue {
        id: SetupIssueId::DeviceGroups,
        title: format!("Videorc can't open {}", join_or(&devices)),
        description: format!(
            "Your user isn't in the {} group{plural}. Run “sudo usermod -aG {} $USER”, then log out and back in.",
            join_or(&names),
            names.join(",")
        ),
    })
}

/// The portal backend package for this desktop, from `XDG_CURRENT_DESKTOP`.
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
        .and_then(|value| value.split(':').next())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    match (portal_backend_package(current_desktop), name) {
        (Some(package), Some(name)) => format!("{package} (the one for {name})"),
        _ => "the portal for your desktop (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr)"
            .to_string(),
    }
}

/// A portal frontend that did not answer in time proves nothing either way.
fn portal_timed_out(portal: &LinuxPortalCheck) -> bool {
    portal
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("in time"))
}

/// True when the answer is worth keeping: the bus answered and the portal did too.
pub fn linux_desktop_check_settled(check: &LinuxDesktopCheck) -> bool {
    check.portal.frontend != BusServiceState::Unknown && !portal_timed_out(&check.portal)
}

pub fn screen_portal_check(portal: &LinuxPortalCheck) -> CheckWords {
    match portal.frontend {
        BusServiceState::Unknown => return words("Couldn't check", CheckTone::Neutral),
        BusServiceState::Missing => return words("Not installed", CheckTone::Error),
        _ => {}
    }
    if portal.screen_cast_version.is_none() {
        // A frontend that did not answer in time is not proof of a missing backend.
        if portal_timed_out(portal) {
            return words("Couldn't check", CheckTone::Neutral);
        }
        return words("No screen sharing", CheckTone::Error);
    }
    words("Ready", CheckTone::Good)
}

pub fn screen_portal_issue(
    portal: &LinuxPortalCheck,
    current_desktop: Option<&str>,
) -> Option<SetupIssue> {
    if screen_portal_check(portal).tone != CheckTone::Error {
        return None;
    }
    if portal.frontend == BusServiceState::Missing {
        return Some(SetupIssue {
            id: SetupIssueId::ScreenPortal,
            title: "Screen capture needs xdg-desktop-portal".to_string(),
            description: format!(
                "Install xdg-desktop-portal and {}, then log out and back in.",
                portal_install_line(current_desktop)
            ),
        });
    }
    let found = if portal.backends.is_empty() {
        String::new()
    } else {
        format!(" ({})", portal.backends.join(", "))
    };
    Some(SetupIssue {
        id: SetupIssueId::ScreenPortal,
        title: "Your desktop's portal can't share the screen".to_string(),
        description: format!(
            "xdg-desktop-portal is running, but none of the portals installed here{found} can share the screen. Install {}, then log out and back in.",
            portal_install_line(current_desktop)
        ),
    })
}

/// The Linux rows for Health, in order; none before data arrives.
pub fn linux_desktop_checks(
    keyring: Option<&LinuxKeyringStatus>,
    desktop: Option<&LinuxDesktopCheck>,
) -> Vec<HealthRow> {
    let mut rows = Vec::new();
    let row = |id, label, words: CheckWords| HealthRow {
        id,
        label,
        value: words.value,
        tone: words.tone,
    };
    if let Some(keyring) = keyring {
        rows.push(row(
            SetupIssueId::Keyring,
            "Keyring",
            keyring_check(keyring, desktop.map(|desktop| desktop.secret_service)),
        ));
    }
    if let Some(desktop) = desktop {
        rows.push(row(
            SetupIssueId::DeviceGroups,
            "Device groups",
            device_groups_check(&desktop.groups),
        ));
        rows.push(row(
            SetupIssueId::ScreenPortal,
            "Screen portal",
            screen_portal_check(&desktop.portal),
        ));
    }
    rows
}

/// What to fix, one alert per row that needs the streamer.
pub fn linux_desktop_issues(
    keyring: Option<&LinuxKeyringStatus>,
    desktop: Option<&LinuxDesktopCheck>,
) -> Vec<SetupIssue> {
    [
        keyring.and_then(|keyring| {
            keyring_issue(keyring, desktop.map(|desktop| desktop.secret_service))
        }),
        desktop.and_then(|desktop| device_groups_issue(&desktop.groups)),
        desktop.and_then(|desktop| {
            screen_portal_issue(&desktop.portal, desktop.current_desktop.as_deref())
        }),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use BusServiceState::*;

    fn keyring(backend: &str, available: bool, user: Option<&str>) -> LinuxKeyringStatus {
        LinuxKeyringStatus {
            backend: backend.to_string(),
            available,
            user_password_store: user.map(str::to_string),
        }
    }

    fn group(
        name: &str,
        exists: bool,
        member: bool,
        devices: u32,
        accessible: u32,
    ) -> LinuxDeviceGroupCheck {
        LinuxDeviceGroupCheck {
            name: name.to_string(),
            exists,
            member,
            devices,
            accessible,
        }
    }

    fn portal(
        frontend: BusServiceState,
        version: Option<u32>,
        backends: &[&str],
    ) -> LinuxPortalCheck {
        LinuxPortalCheck {
            frontend,
            screen_cast_version: version,
            backends: backends.iter().map(|b| b.to_string()).collect(),
            detail: None,
        }
    }

    #[test]
    fn names_the_store_that_works() {
        assert_eq!(
            keyring_check(&keyring("gnome_libsecret", true, None), Some(Running)),
            words("Secret Service", CheckTone::Good)
        );
        assert_eq!(
            keyring_check(&keyring("kwallet6", true, None), Some(Running)).value,
            "KWallet"
        );
        assert_eq!(
            keyring_issue(&keyring("gnome_libsecret", true, None), Some(Running)),
            None
        );
    }

    #[test]
    fn says_what_to_install_when_no_secret_service_is_on_the_bus() {
        let k = keyring("basic_text", false, None);
        assert_eq!(
            keyring_check(&k, Some(Missing)),
            words("Not found", CheckTone::Error)
        );
        let issue = keyring_issue(&k, Some(Missing)).unwrap();
        assert_eq!(issue.title, "No keyring on this desktop");
        assert_eq!(
            issue.description,
            format!("{KEYRING_NEEDS} {KEYRING_INSTALL}")
        );
    }

    #[test]
    fn points_at_libsecret_when_a_keyring_runs_but_videorc_could_not_use_it() {
        let k = keyring("basic_text", false, None);
        assert_eq!(keyring_check(&k, Some(Running)).value, "Can't open");
        assert_eq!(keyring_check(&k, Some(Activatable)).value, "Can't open");
        let issue = keyring_issue(&k, Some(Running)).unwrap();
        assert_eq!(issue.title, "Videorc can't open your keyring");
        assert!(issue.description.contains("libsecret-1-0"));
    }

    #[test]
    fn blames_the_password_store_the_person_passed_before_the_bus() {
        let k = keyring("basic_text", false, Some("basic"));
        assert_eq!(
            keyring_check(&k, Some(Missing)),
            words("Turned off", CheckTone::Error)
        );
        let issue = keyring_issue(&k, Some(Missing)).unwrap();
        assert_eq!(
            issue.title,
            "Videorc was started with --password-store=basic"
        );
        assert!(
            issue
                .description
                .ends_with("or with --password-store=gnome-libsecret.")
        );
        // Asking for libsecret is not turning it off.
        let asked = keyring("basic_text", false, Some("gnome-libsecret"));
        assert_eq!(keyring_check(&asked, Some(Missing)).value, "Not found");
    }

    #[test]
    fn still_says_what_to_install_before_the_backend_answers() {
        let k = keyring("basic_text", false, None);
        assert_eq!(
            keyring_check(&k, None),
            words("Not available", CheckTone::Error)
        );
        assert_eq!(
            keyring_issue(&k, None).unwrap().title,
            "No keyring Videorc can use"
        );
    }

    #[test]
    fn device_groups_are_quiet_when_in_both() {
        let groups = [
            group("video", true, true, 1, 1),
            group("render", true, true, 2, 2),
        ];
        assert_eq!(
            device_groups_check(&groups),
            words("In video and render", CheckTone::Good)
        );
        assert_eq!(device_groups_issue(&groups), None);
    }

    #[test]
    fn device_groups_are_quiet_when_the_desktop_grants_access_without_the_group() {
        let groups = [
            group("video", true, false, 1, 1),
            group("render", true, false, 1, 1),
        ];
        assert_eq!(
            device_groups_check(&groups),
            words("Desktop grants access", CheckTone::Good)
        );
        assert_eq!(device_groups_issue(&groups), None);
    }

    #[test]
    fn device_groups_are_quiet_with_no_device_and_ignore_a_group_the_system_lacks() {
        let groups = [
            group("video", true, false, 0, 0),
            group("render", false, false, 1, 0),
        ];
        assert_eq!(device_groups_issue(&groups), None);
        assert_eq!(device_groups_check(&groups).tone, CheckTone::Good);
    }

    #[test]
    fn names_the_group_and_the_command_when_a_device_is_closed() {
        let one = [
            group("video", true, false, 1, 0),
            group("render", true, true, 1, 1),
        ];
        assert_eq!(
            device_groups_check(&one),
            words("Not in video", CheckTone::Warn)
        );
        let issue = device_groups_issue(&one).unwrap();
        assert_eq!(issue.title, "Videorc can't open your camera");
        assert_eq!(
            issue.description,
            "Your user isn't in the video group. Run “sudo usermod -aG video $USER”, then log out and back in."
        );
        let both = [
            group("video", true, false, 1, 0),
            group("render", true, false, 2, 0),
        ];
        assert_eq!(device_groups_check(&both).value, "Not in video or render");
        let issue = device_groups_issue(&both).unwrap();
        assert_eq!(
            issue.title,
            "Videorc can't open your camera or the GPU encoder"
        );
        assert_eq!(
            issue.description,
            "Your user isn't in the video or render groups. Run “sudo usermod -aG video,render $USER”, then log out and back in."
        );
    }

    #[test]
    fn the_screen_portal_is_ready_when_screen_cast_answers() {
        let p = portal(Running, Some(5), &["hyprland"]);
        assert_eq!(screen_portal_check(&p), words("Ready", CheckTone::Good));
        assert_eq!(screen_portal_issue(&p, Some("Hyprland")), None);
    }

    #[test]
    fn asks_for_the_frontend_and_this_desktops_backend_when_the_frontend_is_missing() {
        let p = portal(Missing, None, &[]);
        assert_eq!(
            screen_portal_check(&p),
            words("Not installed", CheckTone::Error)
        );
        let issue = screen_portal_issue(&p, Some("Hyprland")).unwrap();
        assert_eq!(issue.title, "Screen capture needs xdg-desktop-portal");
        assert_eq!(
            issue.description,
            "Install xdg-desktop-portal and xdg-desktop-portal-hyprland (the one for Hyprland), then log out and back in."
        );
    }

    #[test]
    fn names_the_portals_found_when_none_shares_the_screen() {
        let p = portal(Running, None, &["gtk"]);
        assert_eq!(
            screen_portal_check(&p),
            words("No screen sharing", CheckTone::Error)
        );
        let issue = screen_portal_issue(&p, Some("sway")).unwrap();
        assert_eq!(issue.title, "Your desktop's portal can't share the screen");
        assert_eq!(
            issue.description,
            "xdg-desktop-portal is running, but none of the portals installed here (gtk) can share the screen. Install xdg-desktop-portal-wlr (the one for sway), then log out and back in."
        );
    }

    #[test]
    fn falls_back_to_the_list_of_backends_on_an_unknown_desktop() {
        let issue = screen_portal_issue(&portal(Missing, None, &[]), Some("Openbox")).unwrap();
        assert!(issue.description.contains(
            "the portal for your desktop (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr)"
        ));
    }

    #[test]
    fn never_blames_the_desktop_for_a_bus_or_portal_that_did_not_answer() {
        let unknown = portal(Unknown, None, &[]);
        assert_eq!(
            screen_portal_check(&unknown),
            words("Couldn't check", CheckTone::Neutral)
        );
        assert_eq!(screen_portal_issue(&unknown, None), None);
        let mut late = portal(Running, None, &["hyprland"]);
        late.detail = Some("ScreenCast did not answer in time".to_string());
        assert_eq!(screen_portal_check(&late).tone, CheckTone::Neutral);
        assert_eq!(screen_portal_issue(&late, None), None);
    }

    #[test]
    fn maps_desktops_to_their_portal_package() {
        assert_eq!(
            portal_backend_package(Some("Hyprland")),
            Some("xdg-desktop-portal-hyprland")
        );
        assert_eq!(
            portal_backend_package(Some("ubuntu:GNOME")),
            Some("xdg-desktop-portal-gnome")
        );
        assert_eq!(
            portal_backend_package(Some("KDE")),
            Some("xdg-desktop-portal-kde")
        );
        assert_eq!(
            portal_backend_package(Some("niri")),
            Some("xdg-desktop-portal-gnome")
        );
        assert_eq!(
            portal_backend_package(Some("labwc:wlroots")),
            Some("xdg-desktop-portal-wlr")
        );
        assert_eq!(portal_backend_package(Some("Openbox")), None);
        assert_eq!(portal_backend_package(Some("")), None);
        assert_eq!(portal_backend_package(None), None);
    }

    fn desktop(secret: BusServiceState) -> LinuxDesktopCheck {
        LinuxDesktopCheck {
            secret_service: secret,
            portal: portal(Missing, None, &[]),
            groups: vec![group("video", true, false, 1, 0)],
            current_desktop: Some("Hyprland".to_string()),
        }
    }

    #[test]
    fn adds_nothing_until_data_arrives_and_shows_the_keyring_first() {
        assert!(linux_desktop_checks(None, None).is_empty());
        assert!(linux_desktop_issues(None, None).is_empty());
        let k = keyring("basic_text", false, None);
        let rows = linux_desktop_checks(Some(&k), None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Keyring");
        assert_eq!(rows[0].value, "Not available");
    }

    #[test]
    fn lists_three_rows_and_one_alert_per_problem_in_order() {
        let k = keyring("basic_text", false, None);
        let d = desktop(Missing);
        let rows = linux_desktop_checks(Some(&k), Some(&d));
        let labels: Vec<&str> = rows.iter().map(|row| row.label).collect();
        assert_eq!(labels, ["Keyring", "Device groups", "Screen portal"]);
        assert_eq!(rows[0].value, "Not found");
        let ids: Vec<&str> = linux_desktop_issues(Some(&k), Some(&d))
            .iter()
            .map(|issue| issue.id.as_str())
            .collect();
        assert_eq!(ids, ["keyring", "device-groups", "screen-portal"]);
    }

    #[test]
    fn keeps_answers_only_where_the_bus_and_the_portal_both_answered() {
        let mut d = desktop(Running);
        d.portal = portal(Running, Some(5), &["hyprland"]);
        assert!(linux_desktop_check_settled(&d));
        d.portal = portal(Unknown, None, &[]);
        assert!(!linux_desktop_check_settled(&d));
        d.portal = portal(Running, None, &[]);
        d.portal.detail = Some("The portal did not answer in time".to_string());
        assert!(!linux_desktop_check_settled(&d));
    }

    #[test]
    fn reads_the_backends_answer_as_sent() {
        let wire = serde_json::json!({
            "secretService": "activatable",
            "portal": { "frontend": "running", "screenCastVersion": 5, "backends": ["hyprland", "gtk"] },
            "groups": [{ "name": "render", "exists": true, "member": false, "devices": 2, "accessible": 1 }],
            "currentDesktop": "Hyprland"
        });
        let check: LinuxDesktopCheck = serde_json::from_value(wire).unwrap();
        assert_eq!(check.secret_service, Activatable);
        assert_eq!(check.portal.screen_cast_version, Some(5));
        assert_eq!(check.groups[0].accessible, 1);
        assert_eq!(check.current_desktop.as_deref(), Some("Hyprland"));
    }
}
