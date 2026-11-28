//! Windows (plan 260 platform fill-ins, C4): the Win32 calls behind
//! [`Platform`]. Hide from stream uses `SetWindowDisplayAffinity
//! (WDA_EXCLUDEFROMCAPTURE)`, matching Electron's `setContentProtection`
//! and the backend's D3D11 presenter path. Follow's front-app watcher is
//! [`front_app`]. Smoke place/raise use `SetWindowPos` without activation.

pub mod front_app;

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Globalization::{
    GetLocaleInfoEx, GetUserDefaultLocaleName, LOCALE_STIMEFORMAT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowDisplayAffinity, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_SHOWWINDOW, SetWindowDisplayAffinity, SetWindowPos, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

use super::{OsResult, Platform, ScreenFrame, SmokeWindowLevel};

/// The user's way of writing a day and a time (`format::day_label`): the
/// user locale's region ("en-GB") and its time format's hour cycle ("HH:mm"
/// is 24-hour, "h:mm tt" 12-hour), as Settings → Time & language sets them.
pub fn date_style() -> Option<videorc_app_core::format::DateStyle> {
    // LOCALE_NAME_MAX_LENGTH is 85 UTF-16 units, with the terminator.
    let mut name = [0u16; 85];
    // SAFETY: the buffer and its length in UTF-16 units are both ours.
    let name_len = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    if name_len <= 1 {
        return None;
    }
    let mut time = [0u16; 80];
    // SAFETY: `name` is NUL-terminated by the call above; `time` and its
    // length in UTF-16 units are ours.
    let time_len = unsafe {
        GetLocaleInfoEx(
            name.as_ptr(),
            LOCALE_STIMEFORMAT,
            time.as_mut_ptr(),
            time.len() as i32,
        )
    };
    let locale = String::from_utf16_lossy(&name[..name_len as usize - 1]);
    let twenty_four_hour = (time_len > 1)
        .then(|| String::from_utf16_lossy(&time[..time_len as usize - 1]).contains('H'));
    Some(videorc_app_core::format::DateStyle::for_locale(
        &locale,
        twenty_four_hour,
    ))
}

/// The window's `HWND`, from the handle GPUI hands out.
fn hwnd(window: &Window) -> OsResult<HWND> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| format!("no window handle: {error}"))?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("not a Win32 window".into());
    };
    Ok(handle.hwnd.get() as HWND)
}

/// Set Windows' DWM immersive dark-mode attribute on `window`'s caption bar so
/// Light/Dark/System theme changes keep every native title bar aligned with
/// Videorc's appearance instead of sticking to Windows' OS theme.
pub fn set_title_bar_dark_mode(window: &Window, dark: bool) -> OsResult<()> {
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
    use windows_sys::core::BOOL;
    let hwnd = hwnd(window)?;
    let value: BOOL = i32::from(dark);
    // SAFETY: live HWND from this process's window; `value` is a stack `BOOL`
    // matching `DWMWA_USE_IMMERSIVE_DARK_MODE`.
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&raw const value).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    };
    if hr < 0 {
        return Err(format!(
            "DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE, {dark}) failed: 0x{:08x}",
            hr as u32
        ));
    }
    Ok(())
}

/// Use native monitor coordinates for remote placement, including mixed-DPI
/// desktops. GPUI's per-display logical coordinates cannot be passed directly
/// to SetWindowPos. IDs and enumeration order still come from GPUI.
pub fn remote_display(id: u64) -> Option<videorc_app_core::studio::remote_screens::RemoteDisplay> {
    use videorc_app_core::desktop::window_frames::Rect;
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: GPUI display IDs are live HMONITORs; info has its required size.
    if unsafe { GetMonitorInfoW(id as usize as _, &mut info) } == 0 {
        return None;
    }
    let rect = |r: windows_sys::Win32::Foundation::RECT| {
        Rect::new(
            f64::from(r.left),
            f64::from(r.top),
            f64::from(r.right - r.left),
            f64::from(r.bottom - r.top),
        )
    };
    Some(videorc_app_core::studio::remote_screens::RemoteDisplay {
        id: id.to_string(),
        name: String::new(),
        bounds: rect(info.rcMonitor),
        work_area: rect(info.rcWork),
        primary: info.dwFlags & 1 != 0,
    })
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

    /// Electron's `setBounds` on Windows: top-left screen points, shown
    /// without taking focus (`SWP_NOACTIVATE`).
    fn set_window_frame(&self, window: &Window, frame: ScreenFrame) -> OsResult<()> {
        let hwnd = hwnd(window)?;
        let x = frame.x.round() as i32;
        let y = frame.y.round() as i32;
        let cx = frame.width.round().max(1.0) as i32;
        let cy = frame.height.round().max(1.0) as i32;
        // SAFETY: live HWND; flags keep Z-order and skip activation.
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOP,
                x,
                y,
                cx,
                cy,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if ok == 0 {
            return Err("SetWindowPos(place) failed".into());
        }
        Ok(())
    }

    fn window_frame(
        &self,
        window: &Window,
    ) -> OsResult<videorc_app_core::desktop::window_frames::Rect> {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
        let mut rect = RECT::default();
        // SAFETY: live HWND and writable RECT. Read native coordinates, not
        // GPUI's cached origin (the WM_MOVE callback runs after this intent).
        if unsafe { GetWindowRect(hwnd(window)?, &mut rect) } == 0 {
            return Err("GetWindowRect failed".into());
        }
        Ok(videorc_app_core::desktop::window_frames::Rect::new(
            f64::from(rect.left),
            f64::from(rect.top),
            f64::from(rect.right - rect.left),
            f64::from(rect.bottom - rect.top),
        ))
    }

    fn window_shown(&self, window: &Window) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
        hwnd(window).is_ok_and(|hwnd| unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 })
    }

    fn show_window(&self, window: &Window, focus: bool) -> OsResult<()> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SW_RESTORE, SW_SHOWNOACTIVATE, ShowWindow,
        };
        let hwnd = hwnd(window)?;
        unsafe {
            ShowWindow(hwnd, if focus { SW_RESTORE } else { SW_SHOWNOACTIVATE });
        }
        Ok(())
    }

    fn return_screen_key_focus(&self, window: &Window) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GW_HWNDNEXT, GetWindow, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
        };
        let Ok(own) = hwnd(window) else {
            return;
        };
        // Skip our own windows, just as Electron's bounded blur loop does.
        unsafe {
            let mut next = GetWindow(own, GW_HWNDNEXT);
            for _ in 0..128 {
                if next.is_null() {
                    break;
                }
                let mut pid = 0;
                GetWindowThreadProcessId(next, &mut pid);
                if pid != std::process::id() && IsWindowVisible(next) != 0 {
                    SetForegroundWindow(next);
                    break;
                }
                next = GetWindow(next, GW_HWNDNEXT);
            }
        }
    }

    /// Smoke `raise-window`: topmost (floating / screen-saver) without focus.
    fn raise_window(&self, window: &Window, level: SmokeWindowLevel) -> OsResult<()> {
        let hwnd = hwnd(window)?;
        let after = match level {
            SmokeWindowLevel::Floating => HWND_TOPMOST,
            // Windows has no AppKit screen-saver level; TOPMOST is the
            // closest match for the invisibility smokes' motion stimulus.
            SmokeWindowLevel::ScreenSaver => HWND_TOPMOST,
        };
        // SAFETY: live HWND; NOMOVE/NOSIZE keep the frame, NOACTIVATE skips focus.
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                after,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if ok == 0 {
            return Err(format!("SetWindowPos(raise {}) failed", level.id()));
        }
        Ok(())
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
