//! The OS calls GPUI does not make for us, behind one small interface (the
//! shape `apps/videorc/src/platform/` takes in S2.6a). macOS and Linux are
//! written; Windows (WC-0.9) reports each call as a gap until it fills it in.

/// What a call did, for the event log and the summary.
pub type OsResult<T> = Result<T, String>;

#[cfg(target_os = "macos")]
mod imp {
    use super::OsResult;
    use gpui::Window;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSView, NSWindow, NSWindowSharingType};
    use objc2_foundation::{NSBundle, NSString};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::c_void;

    /// macOS's `NSFloatingWindowLevel`, what Electron's `setAlwaysOnTop(true)` uses.
    const FLOATING_LEVEL: isize = 3;
    const NORMAL_LEVEL: isize = 0;

    fn ns_window(window: &Window) -> OsResult<Retained<NSWindow>> {
        let handle =
            HasWindowHandle::window_handle(window).map_err(|e| format!("no window handle: {e}"))?;
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return Err("not an AppKit window".into());
        };
        // SAFETY: GPUI hands out its live content NSView; we are on the main thread.
        let view: &NSView = unsafe { h.ns_view.cast::<NSView>().as_ref() };
        view.window()
            .ok_or_else(|| "the view has no NSWindow".into())
    }

    /// Hide from stream: `NSWindow.sharingType = .none`, what Electron's
    /// `setContentProtection(true)` sets. Returns the CGWindowID, which the
    /// backend's ScreenCaptureKit filter also excludes by id.
    pub fn set_hidden_from_capture(window: &Window, hidden: bool) -> OsResult<u64> {
        let w = ns_window(window)?;
        w.setSharingType(if hidden {
            NSWindowSharingType::None
        } else {
            NSWindowSharingType::ReadOnly
        });
        if hidden && w.sharingType() != NSWindowSharingType::None {
            return Err("sharingType did not stick".into());
        }
        Ok(w.windowNumber() as u64)
    }

    /// Keep on top at run time, on a normal window (Notes and Preview toggle it).
    /// Panels (GPUI's `WindowKind::Floating`) hide when the app deactivates,
    /// so the app keeps normal windows and raises their level instead.
    pub fn set_keep_on_top(window: &Window, on_top: bool) -> OsResult<isize> {
        let w = ns_window(window)?;
        w.setLevel(if on_top { FLOATING_LEVEL } else { NORMAL_LEVEL });
        Ok(w.level())
    }

    /// The level and `hidesOnDeactivate` of a window, for the summary.
    pub fn window_facts(window: &Window) -> OsResult<(isize, bool, u64)> {
        let w = ns_window(window)?;
        Ok((w.level(), w.hidesOnDeactivate(), w.windowNumber() as u64))
    }

    /// Lets a GPUI floating panel stay up while another app is in front.
    pub fn set_hides_on_deactivate(window: &Window, hides: bool) -> OsResult<()> {
        ns_window(window)?.setHidesOnDeactivate(hides);
        Ok(())
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    const IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    /// The sleep guard: `PreventUserIdleDisplaySleep`, which `pmset -g
    /// assertions` lists under the process. Returns the assertion id.
    pub fn keep_awake_start(reason: &str) -> OsResult<u32> {
        let kind = NSString::from_str("PreventUserIdleDisplaySleep");
        let name = NSString::from_str(reason);
        let mut id = 0u32;
        // SAFETY: NSString is toll-free bridged to CFStringRef; both live for the call.
        let status = unsafe {
            IOPMAssertionCreateWithName(
                Retained::as_ptr(&kind).cast(),
                IOPM_ASSERTION_LEVEL_ON,
                Retained::as_ptr(&name).cast(),
                &mut id,
            )
        };
        if status == 0 {
            Ok(id)
        } else {
            Err(format!("IOPMAssertionCreateWithName returned {status:#x}"))
        }
    }

    pub fn keep_awake_stop(id: u32) -> OsResult<()> {
        // SAFETY: id came from IOPMAssertionCreateWithName.
        let status = unsafe { IOPMAssertionRelease(id) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("IOPMAssertionRelease returned {status:#x}"))
        }
    }

    /// The bundle id, or None for a bare binary. macOS notifications need a
    /// bundle (UNUserNotificationCenter aborts the process without one).
    pub fn bundle_id() -> Option<String> {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|s| s.to_string())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    //! Linux (plan 260 S0.7, L5). The sleep guard is the session bus's
    //! `org.freedesktop.ScreenSaver.Inhibit`, the call Chromium makes for
    //! Electron's `powerSaveBlocker` on Linux (hypridle, KDE and GNOME's
    //! shims answer it). Keep on top is EWMH's `_NET_WM_STATE_ABOVE` on X11;
    //! Wayland has no protocol for either it or Hide from stream.
    use super::OsResult;
    use gpui::Window;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::sync::Mutex;

    /// One session-bus connection for the sleep guard, kept while it holds.
    static BUS: Mutex<Option<zbus::blocking::Connection>> = Mutex::new(None);

    fn x11_window(window: &Window) -> Option<u32> {
        match HasWindowHandle::window_handle(window).ok()?.as_raw() {
            RawWindowHandle::Xcb(h) => Some(h.window.get()),
            RawWindowHandle::Xlib(h) => Some(h.window as u32),
            _ => None,
        }
    }

    fn session() -> &'static str {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            "Wayland"
        } else {
            "X11"
        }
    }

    /// Hide from stream. Neither Wayland nor X11 has a way for a window to
    /// leave a capture: on Wayland the compositor decides what a portal
    /// capture shows (Hyprland's `no_screen_share` window rule is one
    /// compositor's answer); on X11 any client can read any window. The
    /// backend's own capture can still leave the window out (plan 257 D8).
    pub fn set_hidden_from_capture(_: &Window, _: bool) -> OsResult<u64> {
        Err(format!(
            "hide from capture: {} has no protocol for it; the compositor or the \
             backend's capture filter must leave the window out (plan 257 D8)",
            session()
        ))
    }

    /// Keep on top: `_NET_WM_STATE_ABOVE` through the window manager (X11).
    /// Returns 1 when the window manager set the state, 0 when it did not.
    pub fn set_keep_on_top(window: &Window, on_top: bool) -> OsResult<isize> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{self, ConnectionExt as _};
        let Some(xid) = x11_window(window) else {
            return Err(
                "keep on top: Wayland has no protocol for it (xdg-shell has no \
                 window level; a compositor rule or layer-shell is the only way)"
                    .into(),
            );
        };
        let (conn, screen) = x11rb::connect(None).map_err(|e| format!("X connection: {e}"))?;
        let root = conn.setup().roots[screen].root;
        let atom = |name: &[u8]| -> OsResult<u32> {
            Ok(conn
                .intern_atom(false, name)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?
                .atom)
        };
        let state = atom(b"_NET_WM_STATE")?;
        let above = atom(b"_NET_WM_STATE_ABOVE")?;
        let event =
            xproto::ClientMessageEvent::new(32, xid, state, [u32::from(on_top), above, 0, 1, 0]);
        conn.send_event(
            false,
            root,
            xproto::EventMask::SUBSTRUCTURE_REDIRECT | xproto::EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(150));
        Ok(isize::from(has_state(&conn, xid, state, above)?))
    }

    fn has_state(
        conn: &impl x11rb::connection::Connection,
        xid: u32,
        state: u32,
        above: u32,
    ) -> OsResult<bool> {
        use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};
        let reply = conn
            .get_property(false, xid, state, AtomEnum::ATOM, 0, 32)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(reply
            .value32()
            .map(|mut atoms| atoms.any(|a| a == above))
            .unwrap_or(false))
    }

    /// (above: 1 or 0, hides on deactivate: false, the X window id) on X11.
    pub fn window_facts(window: &Window) -> OsResult<(isize, bool, u64)> {
        use x11rb::protocol::xproto::ConnectionExt as _;
        let Some(xid) = x11_window(window) else {
            return Err("window facts: Wayland exposes no window level or global id".into());
        };
        let (conn, _) = x11rb::connect(None).map_err(|e| format!("X connection: {e}"))?;
        let atom = |name: &[u8]| -> OsResult<u32> {
            Ok(conn
                .intern_atom(false, name)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?
                .atom)
        };
        let above = has_state(
            &conn,
            xid,
            atom(b"_NET_WM_STATE")?,
            atom(b"_NET_WM_STATE_ABOVE")?,
        )?;
        Ok((isize::from(above), false, u64::from(xid)))
    }

    pub fn set_hides_on_deactivate(_: &Window, _: bool) -> OsResult<()> {
        Ok(())
    }

    /// The sleep guard: `org.freedesktop.ScreenSaver.Inhibit` on the session
    /// bus. Returns the cookie.
    pub fn keep_awake_start(reason: &str) -> OsResult<u32> {
        let conn =
            zbus::blocking::Connection::session().map_err(|e| format!("session bus: {e}"))?;
        let reply = conn
            .call_method(
                Some("org.freedesktop.ScreenSaver"),
                "/org/freedesktop/ScreenSaver",
                Some("org.freedesktop.ScreenSaver"),
                "Inhibit",
                &("spike-desktop", reason),
            )
            .map_err(|e| format!("ScreenSaver.Inhibit: {e}"))?;
        let cookie: u32 = reply.body().deserialize().map_err(|e| e.to_string())?;
        *BUS.lock().expect("bus") = Some(conn);
        Ok(cookie)
    }

    pub fn keep_awake_stop(cookie: u32) -> OsResult<()> {
        let conn = BUS
            .lock()
            .expect("bus")
            .take()
            .ok_or("the sleep guard holds no connection")?;
        conn.call_method(
            Some("org.freedesktop.ScreenSaver"),
            "/org/freedesktop/ScreenSaver",
            Some("org.freedesktop.ScreenSaver"),
            "UnInhibit",
            &(cookie,),
        )
        .map_err(|e| format!("ScreenSaver.UnInhibit: {e}"))?;
        Ok(())
    }

    pub fn bundle_id() -> Option<String> {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    //! Windows (WC-0.9) fills these in; until then each call is reported
    //! as a gap rather than faked.
    use super::OsResult;
    use gpui::Window;

    fn gap<T>(what: &str) -> OsResult<T> {
        Err(format!(
            "{what}: not written for {} yet (WC-0.9 on Windows, L5 on Linux)",
            std::env::consts::OS
        ))
    }
    pub fn set_hidden_from_capture(_: &Window, _: bool) -> OsResult<u64> {
        gap("hide from capture")
    }
    pub fn set_keep_on_top(_: &Window, _: bool) -> OsResult<isize> {
        gap("keep on top")
    }
    pub fn window_facts(_: &Window) -> OsResult<(isize, bool, u64)> {
        gap("window facts")
    }
    pub fn set_hides_on_deactivate(_: &Window, _: bool) -> OsResult<()> {
        Ok(())
    }
    pub fn keep_awake_start(_: &str) -> OsResult<u32> {
        gap("sleep guard")
    }
    pub fn keep_awake_stop(_: u32) -> OsResult<()> {
        gap("sleep guard")
    }
    pub fn bundle_id() -> Option<String> {
        None
    }
}

pub use imp::*;

/// Whether this platform can post a system notification from this process.
pub fn can_notify() -> Result<(), String> {
    if cfg!(target_os = "macos") && bundle_id().is_none() {
        return Err(
            "macOS notifications need an app bundle: run ./bundle-macos.sh and start the .app"
                .into(),
        );
    }
    Ok(())
}
