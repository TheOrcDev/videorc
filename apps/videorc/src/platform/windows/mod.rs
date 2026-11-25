//! Windows (plan 260 platform fill-ins, C4): the Win32 calls behind
//! [`Platform`]. Hide from stream uses `SetWindowDisplayAffinity
//! (WDA_EXCLUDEFROMCAPTURE)`, matching Electron's `setContentProtection`
//! and the backend's D3D11 presenter path. Place, raise and Follow land in
//! follow-up PRs on this module.

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

use super::{OsResult, Platform};

/// The window's `HWND`, from the handle GPUI hands out.
fn hwnd(window: &Window) -> OsResult<HWND> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| format!("no window handle: {error}"))?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("not a Win32 window".into());
    };
    Ok(handle.hwnd.get() as HWND)
}

pub struct WindowsOs;

impl Platform for WindowsOs {
    fn name(&self) -> &'static str {
        "windows"
    }

    /// `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, what Electron's
    /// `setContentProtection(true)` sets on Windows. Content protection is
    /// the only Hide from stream route here (macOS uses the capture filter);
    /// Notes always, and the Stream Manager while its switch is on.
    fn set_hidden_from_capture(&self, window: &Window, hidden: bool) -> OsResult<Option<u64>> {
        let hwnd = hwnd(window)?;
        let affinity = if hidden {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        // SAFETY: a live HWND from this process's window; affinity is one of
        // the documented WINDOW_DISPLAY_AFFINITY values.
        let ok = unsafe { SetWindowDisplayAffinity(hwnd, affinity) };
        if ok == 0 {
            return Err(format!(
                "SetWindowDisplayAffinity({}) failed",
                if hidden {
                    "WDA_EXCLUDEFROMCAPTURE"
                } else {
                    "WDA_NONE"
                }
            ));
        }
        if hidden {
            let mut readback = 0u32;
            // SAFETY: same HWND; affinity out-param.
            let read_ok = unsafe { GetWindowDisplayAffinity(hwnd, &mut readback) };
            if read_ok == 0 || readback != WDA_EXCLUDEFROMCAPTURE {
                return Err("the window's display affinity did not stick".into());
            }
        }
        // Windows has no ScreenCaptureKit-style window number for the
        // backend filter; content protection is the whole route.
        Ok(None)
    }

    fn set_keep_on_top(&self, _: &Window, _: bool) -> OsResult<()> {
        Err("Keep on top isn't written for windows yet (plan 260 S2.6)".into())
    }

    fn keep_display_awake(&self, _: &str) -> OsResult<u32> {
        Err("The display sleep guard isn't written for windows yet (plan 260 S2.6)".into())
    }

    fn release_display(&self, _: u32) -> OsResult<()> {
        Err("The display sleep guard isn't written for windows yet (plan 260 S2.6)".into())
    }

    fn bundle_id(&self) -> Option<String> {
        None
    }
}
