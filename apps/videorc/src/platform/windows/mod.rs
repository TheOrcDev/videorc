//! Windows (plan 260 platform fill-ins, C4): the Win32 calls behind
//! [`Platform`]. Hide from stream uses `SetWindowDisplayAffinity
//! (WDA_EXCLUDEFROMCAPTURE)`, matching Electron's `setContentProtection`
//! and the backend's D3D11 presenter path. Follow's front-app watcher is
//! [`front_app`]. Smoke place/raise use `SetWindowPos` without activation.

pub mod front_app;

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use videorc_app_core::desktop::permissions::{MediaAccessPermission, MediaAccessStatus};
use windows::Devices::Enumeration::{DeviceAccessInformation, DeviceAccessStatus, DeviceClass};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Globalization::{
    GetLocaleInfoEx, GetUserDefaultLocaleName, LOCALE_STIMEFORMAT,
};
use windows_sys::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
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

    /// `DWMWA_USE_IMMERSIVE_DARK_MODE`, the attribute GPUI sets from the
    /// system's look when the window opens and when the system's changes.
    fn set_frame_dark(&self, window: &Window, dark: bool) -> OsResult<()> {
        set_immersive_dark_mode(hwnd(window)?, dark)
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

    /// Electron's `getMediaAccessStatus` on Windows: the camera and
    /// microphone privacy switches as `DeviceAccessInformation` reads them
    /// for this app. Windows keeps no per-app screen grant, so the screen is
    /// `not-applicable` (Electron's snapshot never reads it off macOS).
    fn media_access(&self, permission: MediaAccessPermission) -> OsResult<MediaAccessStatus> {
        let class = match permission {
            MediaAccessPermission::Camera => DeviceClass::VideoCapture,
            MediaAccessPermission::Microphone => DeviceClass::AudioCapture,
            MediaAccessPermission::Screen => return Ok(MediaAccessStatus::NotApplicable),
        };
        let status = DeviceAccessInformation::CreateFromDeviceClass(class)
            .and_then(|info| info.CurrentStatus())
            .map_err(|error| format!("DeviceAccessInformation: {error}"))?;
        Ok(media_access_status(status))
    }
}

/// The native title bar (and the Mica under the window) dark or light.
fn set_immersive_dark_mode(hwnd: HWND, dark: bool) -> OsResult<()> {
    let value: i32 = dark.into();
    // SAFETY: a live HWND from this process; the attribute takes a BOOL,
    // passed by pointer with its size.
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of::<i32>() as u32,
        )
    };
    if result < 0 {
        return Err(format!(
            "DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE) failed: {result:#010x}"
        ));
    }
    Ok(())
}

/// Electron's `ConvertDeviceAccessStatus`: never asked, allowed, turned off
/// by a policy or the device-wide switch, or turned off by the user.
fn media_access_status(status: DeviceAccessStatus) -> MediaAccessStatus {
    match status {
        DeviceAccessStatus::Unspecified => MediaAccessStatus::NotDetermined,
        DeviceAccessStatus::Allowed => MediaAccessStatus::Granted,
        DeviceAccessStatus::DeniedBySystem => MediaAccessStatus::Restricted,
        DeviceAccessStatus::DeniedByUser => MediaAccessStatus::Denied,
        _ => MediaAccessStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_access_reads_as_electron_words() {
        let cases = [
            (
                DeviceAccessStatus::Unspecified,
                MediaAccessStatus::NotDetermined,
            ),
            (DeviceAccessStatus::Allowed, MediaAccessStatus::Granted),
            (
                DeviceAccessStatus::DeniedBySystem,
                MediaAccessStatus::Restricted,
            ),
            (DeviceAccessStatus::DeniedByUser, MediaAccessStatus::Denied),
            (DeviceAccessStatus(99), MediaAccessStatus::Unknown),
        ];
        for (status, words) in cases {
            assert_eq!(media_access_status(status), words);
        }
    }

    #[test]
    fn the_screen_keeps_no_grant_on_windows() {
        assert_eq!(
            WindowsOs.media_access(MediaAccessPermission::Screen),
            Ok(MediaAccessStatus::NotApplicable)
        );
    }

    /// This PC's real switches: whatever they are, the read answers one of
    /// Electron's words, never `unknown`, so first-run's rows can load.
    #[test]
    fn camera_and_microphone_are_read_from_the_os() {
        for permission in [
            MediaAccessPermission::Camera,
            MediaAccessPermission::Microphone,
        ] {
            let status = WindowsOs.media_access(permission).expect("read");
            assert_ne!(status, MediaAccessStatus::Unknown, "{permission:?}");
        }
    }

    /// A real, never-shown top-level window: DWM keeps what was set, both
    /// ways, which is what the title bar draws from.
    #[test]
    fn the_title_bar_takes_dark_and_light() {
        use windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW,
        };

        // SAFETY: the system STATIC class, no parent, menu or extra data.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                windows_sys::w!("STATIC"),
                windows_sys::w!("videorc title bar test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                200,
                100,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "CreateWindowExW");
        let read = || {
            let mut value = -1i32;
            // SAFETY: the window above; a BOOL out-param with its size.
            let result = unsafe {
                DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                    std::ptr::from_mut(&mut value).cast(),
                    std::mem::size_of::<i32>() as u32,
                )
            };
            assert!(result >= 0, "DwmGetWindowAttribute: {result:#010x}");
            value
        };
        let answers = [true, false, true].map(|dark| {
            set_immersive_dark_mode(hwnd, dark).expect("set");
            read()
        });
        // SAFETY: the window this test made, on this thread.
        unsafe { DestroyWindow(hwnd) };
        assert_eq!(answers, [1, 0, 1]);
    }
}
