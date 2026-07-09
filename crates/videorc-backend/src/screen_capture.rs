use std::time::Duration;

use crate::protocol::{Device, DeviceKind, DeviceStatus};

const SCREEN_CAPTUREKIT_PREFIX: &str = "screen:screencapturekit:";
const WINDOW_CAPTUREKIT_PREFIX: &str = "window:screencapturekit:";
const WINDOWS_DXGI_SCREEN_PREFIX: &str = "screen:dxgi:";
const WINDOWS_GDIGRAB_DESKTOP_ID: &str = "screen:gdigrab:desktop";
const SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCaptureSources {
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
}

pub fn parse_screencapturekit_display_id(id: &str) -> Option<u32> {
    id.strip_prefix(SCREEN_CAPTUREKIT_PREFIX)?.parse().ok()
}

pub fn parse_screencapturekit_window_id(id: &str) -> Option<u32> {
    id.strip_prefix(WINDOW_CAPTUREKIT_PREFIX)?.parse().ok()
}

pub fn parse_windows_dxgi_output_index(id: &str) -> Option<u32> {
    let value = id.strip_prefix(WINDOWS_DXGI_SCREEN_PREFIX)?;
    let (adapter_luid, output_index) = value.rsplit_once(':')?;
    if adapter_luid.is_empty() {
        return None;
    }
    output_index.parse().ok()
}

pub fn is_windows_gdigrab_desktop_screen_id(id: &str) -> bool {
    id == WINDOWS_GDIGRAB_DESKTOP_ID
}

#[cfg(target_os = "macos")]
pub fn list_native_capture_sources() -> NativeCaptureSources {
    macos::list_native_capture_sources()
}

#[cfg(target_os = "windows")]
pub fn list_native_capture_sources() -> NativeCaptureSources {
    windows_native::list_native_capture_sources()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn list_native_capture_sources() -> NativeCaptureSources {
    NativeCaptureSources {
        devices: Vec::new(),
        warnings: vec!["ScreenCaptureKit is only available on macOS.".to_string()],
    }
}

#[cfg(any(test, target_os = "windows"))]
fn windows_dxgi_screen_device_id(adapter_luid: u64, output_index: u32) -> String {
    format!("{WINDOWS_DXGI_SCREEN_PREFIX}{adapter_luid:016x}:{output_index}")
}

#[cfg(target_os = "windows")]
fn windows_gdigrab_desktop_device() -> Device {
    Device {
        id: WINDOWS_GDIGRAB_DESKTOP_ID.to_string(),
        name: "Desktop".to_string(),
        kind: DeviceKind::Screen,
        status: DeviceStatus::Available,
        detail: Some(
            "Windows gdigrab desktop fallback. Use when DXGI Desktop Duplication is unavailable."
                .to_string(),
        ),
        width: None,
        height: None,
    }
}

fn permission_or_unavailable(error: &str) -> DeviceStatus {
    let normalized = error.to_lowercase();
    if normalized.contains("permission")
        || normalized.contains("denied")
        || normalized.contains("not authorized")
        || normalized.contains("tcc")
    {
        DeviceStatus::PermissionRequired
    } else {
        DeviceStatus::Unavailable
    }
}

fn should_include_window_metadata(
    is_on_screen: bool,
    layer: isize,
    title: Option<&str>,
    app_name: Option<&str>,
) -> bool {
    // The macOS login window belongs to another GUI session: building an
    // SCContentFilter for it aborts the whole process inside SkyLight
    // (SLSGetDisplaysWithRect assert — F-013). It is also the only "window"
    // ScreenCaptureKit reports while Screen Recording permission is missing,
    // which made it the accidental first-run default. Never offer it.
    if is_foreign_session_window_app(app_name) {
        return false;
    }
    is_on_screen
        && layer >= 0
        && (title.is_some_and(|value| !value.is_empty())
            || app_name.is_some_and(|value| !value.is_empty()))
}

pub(crate) fn is_foreign_session_window_app(app_name: Option<&str>) -> bool {
    app_name.is_some_and(|value| value.eq_ignore_ascii_case("loginwindow"))
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::*;
    use windows::Win32::Foundation::{LUID, RECT};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1,
    };

    pub fn list_native_capture_sources() -> NativeCaptureSources {
        match list_dxgi_displays() {
            Ok(mut devices) => {
                let mut warnings = Vec::new();
                if devices.is_empty() {
                    warnings.push(
                        "DXGI did not report any attached outputs; offering gdigrab desktop fallback."
                            .to_string(),
                    );
                    devices.push(windows_gdigrab_desktop_device());
                }
                NativeCaptureSources { devices, warnings }
            }
            Err(error) => NativeCaptureSources {
                devices: vec![windows_gdigrab_desktop_device()],
                warnings: vec![format!(
                    "DXGI display discovery failed; offering gdigrab desktop fallback: {error}"
                )],
            },
        }
    }

    fn list_dxgi_displays() -> windows::core::Result<Vec<Device>> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        let mut devices = Vec::new();
        let mut adapter_index = 0;

        loop {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error),
            };

            append_adapter_outputs(&mut devices, &adapter)?;
            adapter_index += 1;
        }

        Ok(devices)
    }

    fn append_adapter_outputs(
        devices: &mut Vec<Device>,
        adapter: &IDXGIAdapter1,
    ) -> windows::core::Result<()> {
        let adapter_desc = unsafe { adapter.GetDesc1()? };
        let adapter_luid = adapter_luid_u64(adapter_desc.AdapterLuid);
        let adapter_name = utf16_z(&adapter_desc.Description);
        let mut output_index = 0;

        loop {
            let output = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(output) => output,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error),
            };
            let output_desc = unsafe { output.GetDesc()? };
            let output_name = utf16_z(&output_desc.DeviceName)
                .unwrap_or_else(|| format!("DXGI output {output_index}"));
            let (width, height) = rect_dimensions(output_desc.DesktopCoordinates);
            devices.push(Device {
                id: windows_dxgi_screen_device_id(adapter_luid, output_index),
                name: format!("Display {}", devices.len() + 1),
                kind: DeviceKind::Screen,
                status: DeviceStatus::Available,
                detail: Some(windows_dxgi_display_detail(
                    adapter_name.as_deref(),
                    &output_name,
                )),
                width,
                height,
            });
            output_index += 1;
        }

        Ok(())
    }

    fn adapter_luid_u64(luid: LUID) -> u64 {
        (u64::from(luid.HighPart as u32) << 32) | u64::from(luid.LowPart)
    }

    fn rect_dimensions(rect: RECT) -> (Option<u32>, Option<u32>) {
        (
            positive_span(rect.left, rect.right),
            positive_span(rect.top, rect.bottom),
        )
    }

    fn positive_span(start: i32, end: i32) -> Option<u32> {
        end.checked_sub(start)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
    }
}

#[cfg(any(test, target_os = "windows"))]
fn windows_dxgi_display_detail(adapter_name: Option<&str>, output_name: &str) -> String {
    match adapter_name {
        Some(adapter_name) if !adapter_name.is_empty() => {
            format!("Windows DXGI output {output_name} on {adapter_name}.")
        }
        _ => format!("Windows DXGI output {output_name}."),
    }
}

#[cfg(any(test, target_os = "windows"))]
fn utf16_z(value: &[u16]) -> Option<String> {
    let len = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    let text = String::from_utf16_lossy(&value[..len]);
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    // Scoped here (not at the top of the file) so the Windows arm never sees
    // an unused import — PR #59 deleted the top-level `use std::sync::mpsc`
    // as apparently-unused and broke the macOS build.
    use objc2_core_graphics::{
        CGDirectDisplayID, CGDisplayCopyDisplayMode, CGDisplayMode, CGPreflightScreenCaptureAccess,
        CGRequestScreenCaptureAccess,
    };
    use objc2_foundation::{NSError, NSString};
    use objc2_screen_capture_kit::{SCShareableContent, SCWindow};
    use std::sync::mpsc;

    enum ShareableContentResult {
        Devices(Vec<Device>),
        Error(String),
    }

    pub fn list_native_capture_sources() -> NativeCaptureSources {
        if !screen_capture_access_granted() {
            return NativeCaptureSources {
                devices: vec![
                    Device {
                        id: "screen:screencapturekit-permission".to_string(),
                        name: "Primary Display".to_string(),
                        kind: DeviceKind::Screen,
                        status: DeviceStatus::PermissionRequired,
                        detail: Some(screen_capture_permission_message()),
                        width: None,
                        height: None,
                    },
                    Device {
                        id: "window:screencapturekit-permission".to_string(),
                        name: "Window Capture".to_string(),
                        kind: DeviceKind::Window,
                        status: DeviceStatus::PermissionRequired,
                        detail: Some(screen_capture_permission_message()),
                        width: None,
                        height: None,
                    },
                ],
                warnings: vec![screen_capture_permission_message()],
            };
        }

        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !error.is_null() {
                    ShareableContentResult::Error(error_description(error))
                } else if content.is_null() {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit returned no shareable content.".to_string(),
                    )
                } else {
                    // SAFETY: ScreenCaptureKit owns the content object for this callback. We copy the
                    // display/window metadata before the callback returns and do not retain references.
                    ShareableContentResult::Devices(unsafe {
                        devices_from_shareable_content(&*content)
                    })
                };
                let _ = tx.send(result);
            },
        );

        // SAFETY: The block stays alive while we wait for the completion callback below.
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true, true, &handler,
            );
        }

        match rx.recv_timeout(SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT) {
            Ok(ShareableContentResult::Devices(devices)) => NativeCaptureSources {
                devices,
                warnings: Vec::new(),
            },
            Ok(ShareableContentResult::Error(error)) => {
                let status = permission_or_unavailable(&error);
                NativeCaptureSources {
                    devices: vec![
                        Device {
                            id: "screen:screencapturekit-unavailable".to_string(),
                            name: "Primary Display".to_string(),
                            kind: DeviceKind::Screen,
                            status: status.clone(),
                            detail: Some(format!(
                                "ScreenCaptureKit display discovery failed: {error}"
                            )),
                            width: None,
                            height: None,
                        },
                        Device {
                            id: "window:screencapturekit-unavailable".to_string(),
                            name: "Window Capture".to_string(),
                            kind: DeviceKind::Window,
                            status,
                            detail: Some(format!(
                                "ScreenCaptureKit window discovery failed: {error}"
                            )),
                            width: None,
                            height: None,
                        },
                    ],
                    warnings: vec![format!("ScreenCaptureKit source discovery failed: {error}")],
                }
            }
            Err(_) => NativeCaptureSources {
                devices: vec![
                    Device {
                        id: "screen:screencapturekit-timeout".to_string(),
                        name: "Primary Display".to_string(),
                        kind: DeviceKind::Screen,
                        status: DeviceStatus::Unavailable,
                        detail: Some(
                            "ScreenCaptureKit display discovery timed out after Screen Recording permission preflight passed."
                                .to_string(),
                        ),
                        width: None,
                        height: None,
                    },
                    Device {
                        id: "window:screencapturekit-timeout".to_string(),
                        name: "Window Capture".to_string(),
                        kind: DeviceKind::Window,
                        status: DeviceStatus::Unavailable,
                        detail: Some(
                            "ScreenCaptureKit window discovery timed out after Screen Recording permission preflight passed."
                                .to_string(),
                        ),
                        width: None,
                        height: None,
                    },
                ],
                warnings: vec![
                    "ScreenCaptureKit source discovery timed out after Screen Recording permission preflight passed."
                        .to_string(),
                ],
            },
        }
    }

    fn screen_capture_access_granted() -> bool {
        CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    }

    fn screen_capture_permission_message() -> String {
        let target = std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "the Videorc capture helper".to_string());
        format!(
            "macOS Screen Recording permission is not granted for {target}. Grant Screen Recording permission to this capture helper, then quit and relaunch Videorc."
        )
    }

    unsafe fn devices_from_shareable_content(content: &SCShareableContent) -> Vec<Device> {
        let mut devices = Vec::new();
        let displays = unsafe { content.displays() };
        for index in 0..displays.count() {
            let display = displays.objectAtIndex(index);
            let display_id = unsafe { display.displayID() };
            let logical_width = positive_i32_u32(unsafe { display.width() });
            let logical_height = positive_i32_u32(unsafe { display.height() });
            let (capture_width, capture_height) =
                display_capture_dimensions(display_id, logical_width, logical_height);
            let dimension_detail = display_dimension_detail(
                logical_width,
                logical_height,
                capture_width,
                capture_height,
            );
            devices.push(Device {
                id: format!("{SCREEN_CAPTUREKIT_PREFIX}{display_id}"),
                name: format!("Display {}", index + 1),
                kind: DeviceKind::Screen,
                status: DeviceStatus::Available,
                detail: Some(format!(
                    "Native ScreenCaptureKit display {display_id} ({dimension_detail}). Recording currently uses the FFmpeg fallback bridge."
                )),
                width: Some(capture_width),
                height: Some(capture_height),
            });
        }

        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            if !include_window(&window) {
                continue;
            }
            let window_id = unsafe { window.windowID() };
            let frame = unsafe { window.frame() };
            let app_name = window_application_name(&window);
            let title = window_title(&window);
            let name = window_name(app_name.as_deref(), title.as_deref(), window_id, index);
            let detail = match app_name {
                Some(app_name) => format!(
                    "Native ScreenCaptureKit window {window_id} from {app_name}. Recording currently uses the FFmpeg fallback bridge."
                ),
                None => format!(
                    "Native ScreenCaptureKit window {window_id}. Recording currently uses the FFmpeg fallback bridge."
                ),
            };

            devices.push(Device {
                id: format!("{WINDOW_CAPTUREKIT_PREFIX}{window_id}"),
                name,
                kind: DeviceKind::Window,
                status: DeviceStatus::Available,
                detail: Some(detail),
                width: Some(frame.size.width.round().max(1.0) as u32),
                height: Some(frame.size.height.round().max(1.0) as u32),
            });
        }

        if !devices
            .iter()
            .any(|device| device.kind == DeviceKind::Screen)
        {
            devices.push(Device {
                id: "screen:screencapturekit-missing".to_string(),
                name: "Primary Display".to_string(),
                kind: DeviceKind::Screen,
                status: DeviceStatus::PermissionRequired,
                detail: Some(
                    "ScreenCaptureKit did not return a display. macOS Screen Recording permission may be missing."
                        .to_string(),
                ),
                width: None,
                height: None,
            });
        }

        if !devices
            .iter()
            .any(|device| device.kind == DeviceKind::Window)
        {
            devices.push(Device {
                id: "window:screencapturekit-missing".to_string(),
                name: "Window Capture".to_string(),
                kind: DeviceKind::Window,
                status: DeviceStatus::Unavailable,
                detail: Some("ScreenCaptureKit did not return any on-screen windows.".to_string()),
                width: None,
                height: None,
            });
        }

        devices
    }

    fn include_window(window: &SCWindow) -> bool {
        let is_on_screen = unsafe { window.isOnScreen() };
        let layer = unsafe { window.windowLayer() };
        let title = window_title(window);
        let app_name = window_application_name(window);

        super::should_include_window_metadata(
            is_on_screen,
            layer,
            title.as_deref(),
            app_name.as_deref(),
        )
    }

    fn display_capture_dimensions(
        display_id: CGDirectDisplayID,
        fallback_width: u32,
        fallback_height: u32,
    ) -> (u32, u32) {
        let Some(mode) = CGDisplayCopyDisplayMode(display_id) else {
            return (fallback_width, fallback_height);
        };
        let pixel_width = positive_usize_u32(CGDisplayMode::pixel_width(Some(&mode)));
        let pixel_height = positive_usize_u32(CGDisplayMode::pixel_height(Some(&mode)));
        match (pixel_width, pixel_height) {
            (Some(width), Some(height)) => (width, height),
            _ => (fallback_width, fallback_height),
        }
    }

    fn display_dimension_detail(
        logical_width: u32,
        logical_height: u32,
        capture_width: u32,
        capture_height: u32,
    ) -> String {
        if logical_width == capture_width && logical_height == capture_height {
            format!("{capture_width}x{capture_height}")
        } else {
            format!(
                "{capture_width}x{capture_height} backing pixels, {logical_width}x{logical_height} logical"
            )
        }
    }

    fn positive_i32_u32(value: isize) -> u32 {
        u32::try_from(value.max(1)).unwrap_or(u32::MAX)
    }

    fn positive_usize_u32(value: usize) -> Option<u32> {
        if value == 0 {
            None
        } else {
            Some(u32::try_from(value).unwrap_or(u32::MAX))
        }
    }

    fn window_name(
        app_name: Option<&str>,
        title: Option<&str>,
        window_id: u32,
        index: usize,
    ) -> String {
        match (app_name, title) {
            (Some(app_name), Some(title)) if !app_name.is_empty() && !title.is_empty() => {
                format!("{app_name} - {title}")
            }
            (Some(app_name), _) if !app_name.is_empty() => app_name.to_string(),
            (_, Some(title)) if !title.is_empty() => title.to_string(),
            _ => format!("Window {} ({window_id})", index + 1),
        }
    }

    fn window_title(window: &SCWindow) -> Option<String> {
        let title = unsafe { window.title()? };
        ns_string_to_string(&title)
    }

    fn window_application_name(window: &SCWindow) -> Option<String> {
        let application = unsafe { window.owningApplication()? };
        let name = unsafe { application.applicationName() };
        ns_string_to_string(&name)
    }

    fn ns_string_to_string(value: &NSString) -> Option<String> {
        let value = value.to_string();
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }

    fn error_description(error: *mut NSError) -> String {
        // SAFETY: The NSError pointer is provided by ScreenCaptureKit for this callback.
        let description = unsafe { (&*error).localizedDescription() };
        let description = description.to_string();
        if description.trim().is_empty() {
            "Unknown ScreenCaptureKit error.".to_string()
        } else {
            description
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_screencapturekit_source_ids() {
        assert_eq!(
            parse_screencapturekit_display_id("screen:screencapturekit:2"),
            Some(2)
        );
        assert_eq!(
            parse_screencapturekit_window_id("window:screencapturekit:42"),
            Some(42)
        );
        assert_eq!(
            parse_screencapturekit_display_id("screen:avfoundation:2"),
            None
        );
        assert_eq!(
            parse_screencapturekit_window_id("screen:screencapturekit:2"),
            None
        );
    }

    #[test]
    fn parses_windows_screen_source_ids() {
        assert_eq!(
            parse_windows_dxgi_output_index("screen:dxgi:00000000000003f1:2"),
            Some(2)
        );
        assert_eq!(parse_windows_dxgi_output_index("screen:dxgi::2"), None);
        assert_eq!(
            parse_windows_dxgi_output_index("screen:screencapturekit:2"),
            None
        );
        assert!(is_windows_gdigrab_desktop_screen_id(
            "screen:gdigrab:desktop"
        ));
        assert!(!is_windows_gdigrab_desktop_screen_id(
            "screen:dxgi:00000000000003f1:2"
        ));
    }

    #[test]
    fn formats_windows_dxgi_screen_device_ids() {
        assert_eq!(
            windows_dxgi_screen_device_id(0x0000_0000_0000_03f1, 2),
            "screen:dxgi:00000000000003f1:2"
        );
    }

    #[test]
    fn trims_utf16_null_terminated_windows_names() {
        let mut value = [0u16; 8];
        value[0] = 'D' as u16;
        value[1] = 'X' as u16;
        value[2] = 'G' as u16;
        value[3] = 'I' as u16;

        assert_eq!(utf16_z(&value).as_deref(), Some("DXGI"));
        assert_eq!(utf16_z(&[0, 0, 0]), None);
    }

    #[test]
    fn describes_windows_dxgi_display_detail() {
        assert_eq!(
            windows_dxgi_display_detail(Some("NVIDIA RTX"), r"\\.\DISPLAY1"),
            r"Windows DXGI output \\.\DISPLAY1 on NVIDIA RTX."
        );
        assert_eq!(
            windows_dxgi_display_detail(None, r"\\.\DISPLAY1"),
            r"Windows DXGI output \\.\DISPLAY1."
        );
    }

    #[test]
    fn maps_permission_like_errors_to_permission_status() {
        assert_eq!(
            permission_or_unavailable("User denied Screen Recording permission"),
            DeviceStatus::PermissionRequired
        );
        assert_eq!(
            permission_or_unavailable("Window server returned no content"),
            DeviceStatus::Unavailable
        );
    }

    #[test]
    fn source_picker_keeps_named_on_screen_windows_across_layers() {
        assert!(should_include_window_metadata(
            true,
            0,
            Some("Editor"),
            Some("Code")
        ));
        assert!(should_include_window_metadata(
            true,
            7,
            None,
            Some("Browser")
        ));
        assert!(!should_include_window_metadata(
            false,
            0,
            Some("Editor"),
            Some("Code")
        ));
        assert!(!should_include_window_metadata(true, 0, None, None));
        assert!(!should_include_window_metadata(
            true,
            -1,
            Some("Desktop"),
            Some("Window Server")
        ));
    }

    #[test]
    fn source_picker_never_offers_foreign_session_windows() {
        // F-013: capturing the login window aborts the process inside SkyLight;
        // it must never be enumerable regardless of on-screen state or layer.
        assert!(!should_include_window_metadata(
            true,
            0,
            Some(""),
            Some("loginwindow")
        ));
        assert!(!should_include_window_metadata(
            true,
            7,
            Some("Login"),
            Some("LoginWindow")
        ));
        assert!(is_foreign_session_window_app(Some("loginwindow")));
        assert!(!is_foreign_session_window_app(Some("Code")));
        assert!(!is_foreign_session_window_app(None));
    }
}
