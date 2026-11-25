//! The system's idle time (Electron's `powerMonitor.getSystemIdleTime`),
//! for the watchdog's still-there (plan 223): seconds since the last
//! keyboard or pointer input anywhere on this computer.
//!
//! - macOS: `CGEventSourceSecondsSinceLastEventType` over the combined
//!   session state and any input event, as Chromium reads it.
//! - Windows: `GetLastInputInfo` against `GetTickCount`.
//! - Linux on X11: the MIT-SCREEN-SAVER extension's `QueryInfo`
//!   (`ms_since_user_input`, what `XScreenSaverQueryInfo` and Chromium's
//!   X11 idle read), through the app's `x11rb` with its `screensaver`
//!   feature. A Wayland session is a named no-op: Wayland has no portable
//!   idle query, and XWayland's counter only sees X clients' input.
//! - Elsewhere `None`: nothing is reported, and the backend's still-there
//!   stays quiet rather than guessing.
//!
//! The macOS and Windows calls are declared here so the app's dependency
//! list does not change for them.

/// Whole seconds since the last input, or `None` where the platform has no
/// answer.
pub fn system_idle_seconds() -> Option<u64> {
    imp::system_idle_seconds()
}

#[cfg(target_os = "macos")]
mod imp {
    /// `kCGEventSourceStateCombinedSessionState`.
    const COMBINED_SESSION_STATE: i32 = 0;
    /// `kCGAnyInputEventType`.
    const ANY_INPUT_EVENT: u32 = !0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    pub fn system_idle_seconds() -> Option<u64> {
        // SAFETY: a pure query with constant arguments; no pointers.
        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT)
        };
        seconds.is_finite().then(|| seconds.max(0.0).floor() as u64)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    /// `LASTINPUTINFO`.
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount() -> u32;
    }

    pub fn system_idle_seconds() -> Option<u64> {
        let mut info = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        // SAFETY: `info` is a live, correctly sized LASTINPUTINFO.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // SAFETY: no arguments. Both clocks wrap at 49.7 days together.
        let now = unsafe { GetTickCount() };
        Some(u64::from(now.wrapping_sub(info.dw_time)) / 1000)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::sync::Mutex;

    use x11rb::connection::Connection;
    use x11rb::protocol::screensaver::ConnectionExt as _;
    use x11rb::rust_connection::RustConnection;

    /// One X connection and its root window, kept across the 30 s reports;
    /// dropped after a failed query so the next report opens a fresh one.
    static X11: Mutex<Option<(RustConnection, u32)>> = Mutex::new(None);

    /// Same rule as `linux/front_app.rs`: any Wayland session is a named
    /// no-op, even when XWayland also exports DISPLAY.
    fn wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    pub fn system_idle_seconds() -> Option<u64> {
        if wayland() {
            return None;
        }
        let mut slot = X11.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            *slot = Some((conn, root));
        }
        let (conn, root) = slot.as_ref()?;
        // No MIT-SCREEN-SAVER on this server, or the connection broke:
        // nothing to report, and the next report tries again.
        let info = conn
            .screensaver_query_info(*root)
            .ok()
            .and_then(|cookie| cookie.reply().ok());
        match info {
            Some(info) => Some(u64::from(info.ms_since_user_input) / 1000),
            None => {
                *slot = None;
                None
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    pub fn system_idle_seconds() -> Option<u64> {
        None
    }
}
