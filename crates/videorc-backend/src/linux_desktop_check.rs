//! What a Linux desktop needs before Videorc can sign in, capture the screen
//! and open devices (plan 257 S18). `diagnostics.linuxDesktop` answers with:
//!
//! - whether a Secret Service (`org.freedesktop.secrets`: GNOME Keyring,
//!   KWallet, KeePassXC) is on the session bus, running or activatable. The
//!   renderer pairs it with Electron's own password-store verdict, which is
//!   what sign-in actually needs; this says *why* that verdict is basic_text.
//! - whether xdg-desktop-portal is on the bus and exposes ScreenCast, which it
//!   does only when a backend for this desktop (hyprland, gnome, kde, wlr)
//!   implements it, plus the backends it can see.
//! - for `video` and `render`, whether this process is in the group and
//!   whether it can open the device nodes the group guards. On logind desktops
//!   the seat ACL (uaccess) or a 0666 render node grants access without the
//!   group, so membership alone never means "broken".
//!
//! Read-only and cheap: one short-lived D-Bus connection, a few `access(2)`
//! calls. The classification is pure so it is tested on every platform.
//! Off Linux only the tests use it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// A well-known D-Bus name as the session bus reports it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BusServiceState {
    /// Someone owns the name now.
    Running,
    /// Nobody owns it, but the bus can start it on the first call.
    Activatable,
    /// Neither: calls to it fail.
    Missing,
    /// The session bus itself could not be asked.
    Unknown,
}

pub fn bus_service_state(owned: bool, activatable: bool) -> BusServiceState {
    if owned {
        BusServiceState::Running
    } else if activatable {
        BusServiceState::Activatable
    } else {
        BusServiceState::Missing
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinuxPortalCheck {
    /// `org.freedesktop.portal.Desktop`, the portal frontend.
    pub frontend: BusServiceState,
    /// `org.freedesktop.portal.ScreenCast`'s `version`; absent when the
    /// frontend exposes no ScreenCast (no backend implements it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_cast_version: Option<u32>,
    /// The `org.freedesktop.impl.portal.desktop.*` backends on the bus,
    /// running or activatable, by their last name segment (`hyprland`, `gtk`).
    pub backends: Vec<String>,
    /// Why the ScreenCast question has no answer, for support bundles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDeviceGroupCheck {
    /// `video` or `render`.
    pub name: String,
    /// The group exists on this system (`getgrnam`).
    pub exists: bool,
    /// This process carries the group (primary or supplementary). A user
    /// added with `usermod -aG` gets it only after logging in again.
    pub member: bool,
    /// Device nodes the group guards (`/dev/video*`, `/dev/dri/renderD*`).
    pub devices: u32,
    /// How many of them this process can open read-write.
    pub accessible: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDesktopCheck {
    /// `org.freedesktop.secrets`.
    pub secret_service: BusServiceState,
    pub portal: LinuxPortalCheck,
    pub groups: Vec<LinuxDeviceGroupCheck>,
    /// `XDG_CURRENT_DESKTOP`, so the advice can name this desktop's portal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_desktop: Option<String>,
}

pub const SECRET_SERVICE_NAME: &str = "org.freedesktop.secrets";
pub const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";
pub const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
pub const SCREEN_CAST_INTERFACE: &str = "org.freedesktop.portal.ScreenCast";
const PORTAL_BACKEND_PREFIX: &str = "org.freedesktop.impl.portal.desktop.";

/// The groups Videorc's devices need, and where their nodes live.
pub const DEVICE_GROUPS: [(&str, &str, &str); 2] = [
    ("video", "/dev", "video"),
    ("render", "/dev/dri", "renderD"),
];

/// The portal backends among the bus's names, sorted and deduplicated.
pub fn portal_backends<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut backends: Vec<String> = names
        .into_iter()
        .filter_map(|name| name.strip_prefix(PORTAL_BACKEND_PREFIX))
        .filter(|rest| !rest.is_empty() && !rest.contains('.'))
        .map(str::to_owned)
        .collect();
    backends.sort();
    backends.dedup();
    backends
}

/// One group's row from what the system said. `gid` is None when the group
/// does not exist; `devices` pairs each node with whether it opens read-write.
pub fn device_group_check(
    name: &str,
    gid: Option<u32>,
    process_gids: &[u32],
    devices: &[bool],
) -> LinuxDeviceGroupCheck {
    LinuxDeviceGroupCheck {
        name: name.to_owned(),
        exists: gid.is_some(),
        member: gid.is_some_and(|gid| process_gids.contains(&gid)),
        devices: devices.len() as u32,
        accessible: devices.iter().filter(|accessible| **accessible).count() as u32,
    }
}

/// Character-device-looking entries in `dir` whose name starts with `prefix`
/// and continues with a digit (`video0`, `renderD128`), sorted.
pub fn device_nodes(dir: &std::path::Path, prefix: &str) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut nodes: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix(prefix))
                .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        })
        .map(|entry| entry.path())
        .collect();
    nodes.sort();
    nodes
}

#[cfg(target_os = "linux")]
mod system {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::time::Duration;

    use ashpd::zbus;

    const BUS_TIMEOUT: Duration = Duration::from_secs(4);

    pub fn process_gids() -> Vec<u32> {
        // SAFETY: getgroups(0, NULL) returns the count; the second call fills
        // a buffer of exactly that many entries.
        let mut gids = unsafe {
            let count = libc::getgroups(0, std::ptr::null_mut());
            if count < 0 {
                Vec::new()
            } else {
                let mut buffer = vec![0 as libc::gid_t; count as usize];
                let filled = libc::getgroups(count, buffer.as_mut_ptr());
                buffer.truncate(filled.max(0) as usize);
                buffer
            }
        };
        // SAFETY: getegid never fails.
        gids.push(unsafe { libc::getegid() });
        gids
    }

    /// `getgrnam_r`, so NSS groups (LDAP, systemd-homed) count too.
    pub fn group_id(name: &str) -> Option<u32> {
        let name = CString::new(name).ok()?;
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        // SAFETY: zeroed `group` is a valid out-parameter; buffer outlives the call.
        let mut group: libc::group = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::group = std::ptr::null_mut();
        let status = unsafe {
            libc::getgrnam_r(
                name.as_ptr(),
                &mut group,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut result,
            )
        };
        (status == 0 && !result.is_null()).then_some(group.gr_gid)
    }

    pub fn can_open_read_write(path: &std::path::Path) -> bool {
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: a valid NUL-terminated path.
        unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
    }

    pub fn device_groups() -> Vec<LinuxDeviceGroupCheck> {
        let gids = process_gids();
        DEVICE_GROUPS
            .iter()
            .map(|(name, dir, prefix)| {
                let access: Vec<bool> = device_nodes(std::path::Path::new(dir), prefix)
                    .iter()
                    .map(|node| can_open_read_write(node))
                    .collect();
                device_group_check(name, group_id(name), &gids, &access)
            })
            .collect()
    }

    pub struct BusAnswers {
        pub secret_service: BusServiceState,
        pub portal: LinuxPortalCheck,
    }

    fn unknown(detail: String) -> BusAnswers {
        BusAnswers {
            secret_service: BusServiceState::Unknown,
            portal: LinuxPortalCheck {
                frontend: BusServiceState::Unknown,
                screen_cast_version: None,
                backends: Vec::new(),
                detail: Some(detail),
            },
        }
    }

    pub async fn bus_answers() -> BusAnswers {
        match tokio::time::timeout(BUS_TIMEOUT * 2, ask_bus()).await {
            Ok(Ok(answers)) => answers,
            Ok(Err(error)) => unknown(format!("session bus: {error}")),
            Err(_) => unknown("session bus did not answer in time".to_owned()),
        }
    }

    async fn ask_bus() -> zbus::Result<BusAnswers> {
        // A connection of our own, dropped at the end: ashpd's process-wide
        // one belongs to the portal runtime (linux_portal_session.rs).
        let connection = zbus::connection::Builder::session()?.build().await?;
        let dbus = zbus::fdo::DBusProxy::new(&connection).await?;
        let owned: Vec<String> = dbus
            .list_names()
            .await?
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        let activatable: Vec<String> = dbus
            .list_activatable_names()
            .await?
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        let state = |name: &str| {
            bus_service_state(
                owned.iter().any(|owner| owner == name),
                activatable.iter().any(|candidate| candidate == name),
            )
        };
        let secret_service = state(SECRET_SERVICE_NAME);
        let frontend = state(PORTAL_NAME);
        let backends = portal_backends(owned.iter().chain(activatable.iter()).map(String::as_str));
        let (screen_cast_version, detail) = if frontend == BusServiceState::Missing {
            (None, None)
        } else {
            match tokio::time::timeout(BUS_TIMEOUT, screen_cast_version(&connection)).await {
                Ok(Ok(version)) => (Some(version), None),
                Ok(Err(error)) => (None, Some(format!("ScreenCast: {error}"))),
                Err(_) => (
                    None,
                    Some("ScreenCast: the portal did not answer in time".to_owned()),
                ),
            }
        };
        Ok(BusAnswers {
            secret_service,
            portal: LinuxPortalCheck {
                frontend,
                screen_cast_version,
                backends,
                detail,
            },
        })
    }

    async fn screen_cast_version(connection: &zbus::Connection) -> zbus::Result<u32> {
        let properties = zbus::fdo::PropertiesProxy::builder(connection)
            .destination(PORTAL_NAME)?
            .path(PORTAL_PATH)?
            .build()
            .await?;
        let interface = zbus::names::InterfaceName::try_from(SCREEN_CAST_INTERFACE)?;
        let value = properties.get(interface, "version").await?;
        u32::try_from(value).map_err(zbus::Error::from)
    }
}

/// The whole answer for `diagnostics.linuxDesktop`; None off Linux.
#[cfg(target_os = "linux")]
pub async fn linux_desktop_check() -> Option<LinuxDesktopCheck> {
    let bus = system::bus_answers().await;
    let groups = tokio::task::spawn_blocking(system::device_groups)
        .await
        .unwrap_or_default();
    Some(LinuxDesktopCheck {
        secret_service: bus.secret_service,
        portal: bus.portal,
        groups,
        current_desktop: std::env::var("XDG_CURRENT_DESKTOP")
            .ok()
            .filter(|value| !value.trim().is_empty()),
    })
}

#[cfg(not(target_os = "linux"))]
pub async fn linux_desktop_check() -> Option<LinuxDesktopCheck> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_running_activatable_or_missing() {
        assert_eq!(bus_service_state(true, false), BusServiceState::Running);
        assert_eq!(bus_service_state(true, true), BusServiceState::Running);
        assert_eq!(bus_service_state(false, true), BusServiceState::Activatable);
        assert_eq!(bus_service_state(false, false), BusServiceState::Missing);
    }

    #[test]
    fn portal_backends_are_the_last_segment_sorted_once() {
        let names = [
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.impl.portal.desktop.hyprland",
            "org.freedesktop.impl.portal.desktop.gtk",
            "org.freedesktop.impl.portal.desktop.gtk",
            "org.freedesktop.impl.portal.PermissionStore",
            "org.freedesktop.impl.portal.desktop.",
            "org.freedesktop.impl.portal.desktop.kde.extra",
            ":1.42",
        ];
        assert_eq!(portal_backends(names), vec!["gtk", "hyprland"]);
        assert!(portal_backends(["org.freedesktop.secrets"]).is_empty());
    }

    #[test]
    fn a_group_counts_membership_and_device_access_apart() {
        let in_group = device_group_check("video", Some(983), &[1000, 983], &[true, true]);
        assert!(in_group.exists && in_group.member);
        assert_eq!((in_group.devices, in_group.accessible), (2, 2));

        // Fedora: not in `video`, the seat ACL still opens the camera.
        let seat_acl = device_group_check("video", Some(983), &[1000], &[true]);
        assert!(seat_acl.exists && !seat_acl.member);
        assert_eq!(seat_acl.accessible, 1);

        let denied = device_group_check("render", Some(987), &[1000], &[false, false]);
        assert!(!denied.member);
        assert_eq!((denied.devices, denied.accessible), (2, 0));

        let absent = device_group_check("render", None, &[1000, 987], &[]);
        assert!(!absent.exists && !absent.member);
    }

    #[test]
    fn device_nodes_match_the_prefix_and_a_number_only() {
        let dir = crate::test_temp_dir::TestTempDir::new("linux-desktop-check");
        for name in [
            "video0",
            "video10",
            "videoX",
            "video",
            "renderD128",
            "card1",
        ] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        let names = |prefix: &str| -> Vec<String> {
            device_nodes(&dir, prefix)
                .iter()
                .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(names("video"), vec!["video0", "video10"]);
        assert_eq!(names("renderD"), vec!["renderD128"]);
        assert!(device_nodes(&dir.join("missing"), "video").is_empty());
    }

    #[test]
    fn the_answer_serializes_in_the_renderer_contract_shape() {
        let check = LinuxDesktopCheck {
            secret_service: BusServiceState::Activatable,
            portal: LinuxPortalCheck {
                frontend: BusServiceState::Running,
                screen_cast_version: Some(5),
                backends: vec!["hyprland".to_owned()],
                detail: None,
            },
            groups: vec![device_group_check("video", Some(983), &[983], &[true])],
            current_desktop: Some("Hyprland".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&check).unwrap(),
            serde_json::json!({
                "secretService": "activatable",
                "portal": {
                    "frontend": "running",
                    "screenCastVersion": 5,
                    "backends": ["hyprland"]
                },
                "groups": [{
                    "name": "video",
                    "exists": true,
                    "member": true,
                    "devices": 1,
                    "accessible": 1
                }],
                "currentDesktop": "Hyprland"
            })
        );
    }
}
