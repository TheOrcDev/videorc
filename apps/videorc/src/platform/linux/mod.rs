//! Linux (plan 260 S2.6c, lane L5): [`Platform`] and the Linux-only OS calls,
//! over the policy in `videorc_app_core::desktop::linux` (#1809, #1815).
//!
//! - The display sleep guard: the Inhibit portal, then
//!   `org.freedesktop.ScreenSaver` (`inhibit.rs`, the core's
//!   `LinuxSleepInhibitor`).
//! - Tokens: the Secret Service (`secrets.rs`, the core's `SecretStore`).
//! - Global shortcuts on Wayland: the GlobalShortcuts portal
//!   (`shortcuts.rs`, the core's `PortalShortcuts`); X11 keeps
//!   `global-hotkey` (`app/hotkeys.rs`).
//! - `videorc://` and the `.desktop` entry (`desktop.rs`).
//! - Hide from stream and Keep on top say why they can't, in Electron's
//!   words where it had them.
//!
//! Every D-Bus call goes through one small runtime of its own (`bus.rs`)
//! with a deadline, so no caller waits on a silent bus.
//!
//! The app wires the Linux-only parts (the entry at launch, the portal under
//! Wayland, the keyring for sign-in) as the screens that need them land.

// Wired by the app as its Linux screens land (see above).
#![allow(dead_code)]

mod bus;
pub mod desktop;
mod inhibit;
pub mod secrets;
pub mod shortcuts;

use std::sync::{Arc, Mutex, OnceLock};

use gpui::Window;
use videorc_app_core::desktop::linux::secret_store::SecretStore;
use videorc_app_core::desktop::linux::sleep_inhibit::LinuxSleepInhibitor;

use super::{OsResult, Platform};
use bus::Bus;
use inhibit::DbusInhibit;
use secrets::SecretService;
use shortcuts::PortalShortcutsHandle;

/// The app's id on Linux: Electron's `appId`, which the GPUI app keeps on
/// every platform (coordinator, plan 260 S5.0), so the portal permissions,
/// the shortcuts and the `videorc://` handler carry over. The Wayland
/// `app_id` its windows carry (`main.rs`) and the portal host Registry use it;
/// the `.desktop` entry keeps Electron's `videorc.desktop`.
pub const APP_ID: &str = "dev.theorcdev.videorc";

/// `CAPTURE_PROTECTION_UNSUPPORTED_REASON` (`shared/capture-protection.ts`):
/// neither Wayland nor X11 lets an app keep its window out of a capture.
pub const HIDE_FROM_STREAM_UNSUPPORTED: &str =
    "This system cannot hide a window from screen capture.";

const KEEP_ON_TOP_WAYLAND: &str =
    "Wayland doesn't let an app keep its window above other apps' windows.";
const KEEP_ON_TOP_X11: &str = "Keep on top isn't written for X11 yet (plan 260 S2.6c).";

fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}

pub struct Linux {
    bus: Option<Arc<Bus>>,
    sleep: Mutex<Option<LinuxSleepInhibitor<DbusInhibit>>>,
}

static LINUX: OnceLock<Linux> = OnceLock::new();

/// This computer's Linux platform, created on first use.
pub fn platform() -> &'static Linux {
    LINUX.get_or_init(Linux::new)
}

impl Linux {
    fn new() -> Self {
        match Bus::new() {
            Ok(bus) => {
                let bus = Arc::new(bus);
                Self {
                    sleep: Mutex::new(Some(LinuxSleepInhibitor::new(DbusInhibit::new(
                        bus.clone(),
                    )))),
                    bus: Some(bus),
                }
            }
            Err(error) => {
                eprintln!("[videorc-app] no D-Bus on this platform: {error}");
                Self {
                    bus: None,
                    sleep: Mutex::new(None),
                }
            }
        }
    }

    fn bus(&self) -> OsResult<Arc<Bus>> {
        self.bus
            .clone()
            .ok_or_else(|| "the D-Bus runtime didn't start".to_string())
    }

    /// The keyring, probed (a write, read and delete of a probe item). Blocks
    /// for up to a few seconds on a silent bus: call it off the main thread.
    pub fn secret_store(&self) -> OsResult<SecretStore<SecretService>> {
        Ok(SecretStore::new(SecretService::new(self.bus()?)))
    }

    /// The GlobalShortcuts portal client (Wayland's global shortcuts).
    pub fn portal_shortcuts(&self) -> OsResult<PortalShortcutsHandle> {
        PortalShortcutsHandle::start(self.bus()?)
    }

    /// Which route holds the display, and the last error, for Health.
    pub fn sleep_route(&self) -> Option<(String, Option<String>)> {
        let sleep = self
            .sleep
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sleep.as_ref().map(|inhibitor| {
            (
                format!("{:?}", inhibitor.route()),
                inhibitor.last_error().map(str::to_string),
            )
        })
    }
}

impl Platform for Linux {
    fn name(&self) -> &'static str {
        "linux"
    }

    fn set_hidden_from_capture(&self, _window: &Window, _hidden: bool) -> OsResult<Option<u64>> {
        Err(HIDE_FROM_STREAM_UNSUPPORTED.to_string())
    }

    fn set_keep_on_top(&self, _window: &Window, _on_top: bool) -> OsResult<()> {
        Err(if wayland() {
            KEEP_ON_TOP_WAYLAND
        } else {
            KEEP_ON_TOP_X11
        }
        .to_string())
    }

    /// The core's inhibitor picks the route (the portal, then ScreenSaver)
    /// and its words; `reason` is the same sentence the core sends.
    fn keep_display_awake(&self, _reason: &str) -> OsResult<u32> {
        let mut sleep = self
            .sleep
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let inhibitor = sleep
            .as_mut()
            .ok_or_else(|| "the D-Bus runtime didn't start".to_string())?;
        inhibitor.start().ok_or_else(|| {
            inhibitor
                .last_error()
                .unwrap_or("nothing on the session bus would hold the display")
                .to_string()
        })
    }

    fn release_display(&self, blocker: u32) -> OsResult<()> {
        let mut sleep = self
            .sleep
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let inhibitor = sleep
            .as_mut()
            .ok_or_else(|| "the D-Bus runtime didn't start".to_string())?;
        inhibitor.stop(blocker);
        Ok(())
    }

    /// The app id, when this run is the packaged AppImage.
    fn bundle_id(&self) -> Option<String> {
        std::env::var_os("APPIMAGE").map(|_| APP_ID.to_string())
    }
}
