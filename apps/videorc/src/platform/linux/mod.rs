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
pub mod front_app;
mod inhibit;
pub mod secrets;
pub mod shortcuts;
pub mod v4l2loopback;
pub mod x11_scale;

use std::sync::{Arc, Mutex, OnceLock};

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use videorc_app_core::desktop::linux::secret_store::SecretStore;
use videorc_app_core::desktop::linux::sleep_inhibit::LinuxSleepInhibitor;

use super::{OsResult, Platform, ScreenFrame, SmokeWindowLevel};
use bus::Bus;
use inhibit::DbusInhibit;
use secrets::SecretService;
use shortcuts::PortalShortcutsHandle;

/// The app's id on Linux: Electron's `appId`, which the GPUI app keeps on
/// every platform (coordinator, plan 260 S5.0), so the portal permissions,
/// the shortcuts and the `videorc://` handler carry over. The Wayland
/// `app_id` its windows carry (`main.rs`) and the portal host Registry use it;
/// the `.desktop` entry keeps Electron's `videorc.desktop`.
pub const APP_ID: &str = crate::APP_ID;

/// `CAPTURE_PROTECTION_UNSUPPORTED_REASON` (`shared/capture-protection.ts`):
/// neither Wayland nor X11 lets an app keep its window out of a capture.
pub const HIDE_FROM_STREAM_UNSUPPORTED: &str =
    "This system cannot hide a window from screen capture.";

const KEEP_ON_TOP_WAYLAND: &str =
    "Wayland doesn't let an app keep its window above other apps' windows.";
const KEEP_ON_TOP_X11: &str = "Keep on top isn't written for X11 yet (plan 260 S2.6c).";
const PLACE_WAYLAND: &str =
    "Placing a window isn't available on Wayland yet (plan 260 platform fill-ins).";
const RAISE_WAYLAND: &str =
    "Raising a window isn't available on Wayland yet (plan 260 platform fill-ins).";

fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// The window's X11 id from GPUI's raw handle (Xlib or Xcb).
fn x11_window_id(window: &Window) -> OsResult<u32> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| format!("no window handle: {error}"))?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => {
            u32::try_from(handle.window).map_err(|_| "Xlib window id does not fit u32".to_string())
        }
        RawWindowHandle::Xcb(handle) => Ok(handle.window.get()),
        RawWindowHandle::Wayland(_) => Err("not an X11 window".into()),
        _ => Err("not an X11 window".into()),
    }
}

fn x11_place(window: u32, frame: ScreenFrame) -> OsResult<()> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt, StackMode};

    let (conn, _) = x11rb::connect(None).map_err(|error| format!("the X connection: {error}"))?;
    let x = frame.x.round() as i32;
    let y = frame.y.round() as i32;
    let width = frame.width.round().max(1.0) as u32;
    let height = frame.height.round().max(1.0) as u32;
    conn.configure_window(
        window,
        &ConfigureWindowAux::new()
            .x(x)
            .y(y)
            .width(width)
            .height(height)
            .stack_mode(StackMode::ABOVE),
    )
    .map_err(|error| format!("configure_window(place): {error}"))?;
    conn.flush()
        .map_err(|error| format!("flush(place): {error}"))?;
    Ok(())
}

fn x11_raise(window: u32, level: SmokeWindowLevel) -> OsResult<()> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        ClientMessageEvent, ConfigureWindowAux, ConnectionExt, EventMask, StackMode,
    };

    let (conn, _) = x11rb::connect(None).map_err(|error| format!("the X connection: {error}"))?;
    conn.configure_window(
        window,
        &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
    )
    .map_err(|error| format!("configure_window(raise): {error}"))?;

    // Floating / screen-saver ask for `_NET_WM_STATE_ABOVE` so the window
    // stays over the motion stimulus the invisibility smokes draw.
    if matches!(
        level,
        SmokeWindowLevel::ScreenSaver | SmokeWindowLevel::Floating
    ) {
        let intern = |name: &str| -> OsResult<u32> {
            let reply = conn
                .intern_atom(false, name.as_bytes())
                .map_err(|error| format!("intern_atom({name}): {error}"))?
                .reply()
                .map_err(|error| format!("intern_atom({name}) reply: {error}"))?;
            Ok(reply.atom)
        };
        let state = intern("_NET_WM_STATE")?;
        let above = intern("_NET_WM_STATE_ABOVE")?;
        let root = conn.setup().roots.first().map(|s| s.root).unwrap_or(0);
        // _NET_WM_STATE: action 1 = add
        let event = ClientMessageEvent::new(32, window, state, [1u32, above, 0, 0, 0]);
        conn.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|error| format!("send_event(_NET_WM_STATE): {error}"))?;
    }

    conn.flush()
        .map_err(|error| format!("flush(raise): {error}"))?;
    Ok(())
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

    fn set_window_frame(&self, window: &Window, frame: ScreenFrame) -> OsResult<()> {
        if wayland() {
            return Err(PLACE_WAYLAND.into());
        }
        x11_place(x11_window_id(window)?, frame)
    }

    fn raise_window(&self, window: &Window, level: SmokeWindowLevel) -> OsResult<()> {
        if wayland() {
            return Err(RAISE_WAYLAND.into());
        }
        x11_raise(x11_window_id(window)?, level)
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
