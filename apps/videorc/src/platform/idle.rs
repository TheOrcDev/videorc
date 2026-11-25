//! The system's idle time (Electron's `powerMonitor.getSystemIdleTime`),
//! for the watchdog's still-there (plan 223): seconds since the last
//! keyboard or pointer input anywhere on this computer.
//!
//! - macOS: `CGEventSourceSecondsSinceLastEventType` over the combined
//!   session state and any input event, as Chromium reads it.
//! - Windows: `GetLastInputInfo` against `GetTickCount`.
//! - Elsewhere `None`: nothing is reported, and the backend's still-there
//!   stays quiet rather than guessing.
//!
//! The two calls are declared here so the app's dependency list does not
//! change for them.

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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn system_idle_seconds() -> Option<u64> {
        None
    }
}
