//! Linux setup alert (P1489–P1493): one missing desktop piece and what to
//! install. Health shows every issue; Destinations shows the keyring one
//! before sign-in. Words come from
//! [`videorc_app_core::studio::linux_desktop`].

use gpui::{AnyElement, IntoElement, SharedString, div, prelude::*};
use serde_json::Value;
use videorc_app_core::studio::linux_desktop::{LinuxKeyringStatus, LinuxSetupIssue, keyring_issue};
use videorc_kit::alert::{Alert, AlertVariant};

/// Warning alert with the install copy (`LinuxSetupAlert`).
pub fn linux_setup_alert(issue: &LinuxSetupIssue) -> AnyElement {
    Alert::new(SharedString::from(format!("linux-setup-{}", issue.id)))
        .variant(AlertVariant::Warning)
        .title(issue.title.clone())
        .description(
            div()
                .id(SharedString::from(format!("linux-setup-{}-body", issue.id)))
                .child(issue.description.clone()),
        )
        .into_any_element()
}

/// Map the OS probe's status into the Health page's keyring shape. The probe
/// reports `secret_service`; Health's label helper still expects
/// `gnome_libsecret` for the good row.
pub fn studio_keyring_from_probe(
    backend: &str,
    available: bool,
    user_password_store: Option<String>,
) -> LinuxKeyringStatus {
    LinuxKeyringStatus {
        backend: if backend == "secret_service" {
            "gnome_libsecret".into()
        } else {
            backend.to_string()
        },
        available,
        user_password_store,
    }
}

fn secret_service_of(desktop: Option<&Value>) -> Option<&str> {
    desktop
        .and_then(|desktop| desktop.get("secretService"))
        .and_then(Value::as_str)
}

/// The keyring issue alone (Destinations, before any sign-in).
pub fn keyring_setup_issue(
    keyring: &LinuxKeyringStatus,
    desktop: Option<&Value>,
) -> Option<LinuxSetupIssue> {
    keyring_issue(keyring, secret_service_of(desktop))
}

/// Probe this Linux keyring. `None` off Linux or when the D-Bus secret
/// client never started.
pub fn probe_keyring_status() -> Option<LinuxKeyringStatus> {
    #[cfg(target_os = "linux")]
    {
        let linux = crate::platform::linux::platform();
        let store = linux.secret_store().ok()?;
        let status = store.status();
        Some(studio_keyring_from_probe(
            &status.backend,
            status.available,
            status.user_password_store.clone(),
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}
