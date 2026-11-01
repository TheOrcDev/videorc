#[cfg(target_os = "macos")]
use std::time::Duration;

use crate::protocol::Device;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::protocol::DeviceKind;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use crate::protocol::DeviceStatus;
use crate::protocol::{AppWindowUnavailableReason, ResolveAppWindowParams, ResolveAppWindowResult};

const SCREEN_CAPTUREKIT_PREFIX: &str = "screen:screencapturekit:";
const WINDOW_CAPTUREKIT_PREFIX: &str = "window:screencapturekit:";
const WINDOWS_DXGI_SCREEN_PREFIX: &str = "screen:dxgi:";
const WINDOWS_GDIGRAB_DESKTOP_ID: &str = "screen:gdigrab:desktop";
#[cfg(target_os = "macos")]
const SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);

/// Whether native capture callbacks provide a continuous cadence signal that
/// can corroborate complete-frame and compositor-fresh rate decay.
///
/// ScreenCaptureKit reports idle/status callbacks even when a desktop is
/// static. Windows desktop duplication and gdigrab are damage-driven here, so
/// their callback/publication counters cannot prove a capture-rate collapse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScreenCaptureCallbackCadence {
    Authoritative,
    DamageDriven,
}

impl ScreenCaptureCallbackCadence {
    pub(crate) fn is_authoritative(self) -> bool {
        self == Self::Authoritative
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsDxgiSourceId {
    pub adapter_luid: u64,
    pub output_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCaptureSources {
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
}

#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppPreviewsParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreview {
    bundle_id: String,
    name: String,
    pid: i32,
    window_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    front_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    front_window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

pub fn app_previews(params: AppPreviewsParams) -> Result<Vec<AppPreview>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::app_previews(params)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = params;
        Ok(Vec::new())
    }
}

#[cfg(any(target_os = "macos", test))]
fn preview_size(width: u32, height: u32, max_width: Option<u32>) -> (u32, u32) {
    let max_width = max_width.unwrap_or(320).clamp(160, 640);
    let target_width = width.max(1).min(max_width);
    (
        target_width,
        ((height as f64 * target_width as f64 / width.max(1) as f64).round() as u32).max(1),
    )
}

#[cfg(any(target_os = "macos", test))]
fn preview_data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    if bytes.len().div_ceil(3) * 4 + 23 > 2_000_000 {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(any(target_os = "macos", test))]
fn build_app_previews(windows: &[AppWindow], host_pid: i32) -> Vec<AppPreview> {
    // Filter before grouping/selection: development Electron apps can share a
    // bundle id with our host, so filtering only the group seed is insufficient.
    let windows: Vec<_> = windows
        .iter()
        .filter(|w| {
            w.pid != host_pid
                && w.pid != std::process::id() as i32
                && w.bundle_id != "dev.theorcdev.videorc"
        })
        .cloned()
        .collect();
    let mut apps = Vec::new();
    for w in &windows {
        if w.bundle_id.is_empty()
            || w.protected
            || is_foreign_session_window_app(Some(&w.app_name))
            || w.layer != 0
            || w.width < 400
            || w.height < 300
            || apps.iter().any(|a: &AppPreview| a.bundle_id == w.bundle_id)
        {
            continue;
        }
        let params = ResolveAppWindowParams {
            bundle_id: w.bundle_id.clone(),
            prefer_window_id: None,
            min_width: None,
            min_height: None,
        };
        let (front_window_id, front_window_title) = match select_app_window(&params, true, &windows)
        {
            ResolveAppWindowResult::Found {
                window_id, title, ..
            } => (Some(window_id), Some(title)),
            _ => (None, None),
        };
        let window_count = windows
            .iter()
            .filter(|other| {
                other.bundle_id == w.bundle_id
                    && !other.protected
                    && other.layer == 0
                    && other.width >= 400
                    && other.height >= 300
            })
            .count();
        apps.push(AppPreview {
            bundle_id: w.bundle_id.clone(),
            name: w.app_name.clone(),
            pid: w.pid,
            window_count,
            front_window_id,
            front_window_title,
            picture: None,
            width: None,
            height: None,
        });
    }
    apps.truncate(512);
    apps
}

/// Plain metadata in front-to-back order; independent of ScreenCaptureKit.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone)]
struct AppWindow {
    pid: i32,
    id: u32,
    bundle_id: String,
    app_name: String,
    title: String,
    width: u32,
    height: u32,
    layer: isize,
    on_screen: bool,
    protected: bool,
}

#[cfg(any(target_os = "macos", test))]
fn select_app_window(
    params: &ResolveAppWindowParams,
    running: bool,
    windows: &[AppWindow],
) -> ResolveAppWindowResult {
    use AppWindowUnavailableReason::*;
    let eligible: Vec<_> = windows
        .iter()
        .filter(|w| {
            w.bundle_id == params.bundle_id
                && !w.protected
                && !is_foreign_session_window_app(Some(&w.app_name))
                && w.layer == 0
                && w.width >= params.min_width.unwrap_or(400)
                && w.height >= params.min_height.unwrap_or(300)
        })
        .collect();
    let preferred = params
        .prefer_window_id
        .as_deref()
        .and_then(parse_screencapturekit_window_id);
    let selected = eligible
        .iter()
        .find(|w| w.on_screen && Some(w.id) == preferred)
        .or_else(|| eligible.iter().find(|w| w.on_screen));
    if let Some(w) = selected {
        ResolveAppWindowResult::Found {
            ok: true,
            window_id: format!("{WINDOW_CAPTUREKIT_PREFIX}{}", w.id),
            title: w.title.clone(),
            width: w.width,
            height: w.height,
        }
    } else {
        ResolveAppWindowResult::Unavailable {
            ok: false,
            reason: if !running {
                NotRunning
            } else if eligible.iter().any(|w| !w.on_screen) {
                Minimized
            } else {
                NoWindow
            },
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn is_protected_notes_window(app: &crate::protocol::DeviceApp, title: &str, host_pid: i32) -> bool {
    title == "Notes"
        && (app.bundle_id == "dev.theorcdev.videorc"
            || app.name == "Videorc"
            || app.pid == host_pid)
}

/// App scenes are macOS-only. Other platforms report not-running.
pub fn resolve_app_window(
    params: &ResolveAppWindowParams,
) -> Result<ResolveAppWindowResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::resolve_app_window(params)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = params;
        Ok(ResolveAppWindowResult::Unavailable {
            ok: false,
            reason: AppWindowUnavailableReason::NotRunning,
        })
    }
}

pub fn parse_screencapturekit_display_id(id: &str) -> Option<u32> {
    id.strip_prefix(SCREEN_CAPTUREKIT_PREFIX)?.parse().ok()
}

pub fn parse_screencapturekit_window_id(id: &str) -> Option<u32> {
    id.strip_prefix(WINDOW_CAPTUREKIT_PREFIX)?.parse().ok()
}

pub fn parse_windows_dxgi_output_index(id: &str) -> Option<u32> {
    parse_windows_dxgi_source_id(id).map(|source| source.output_index)
}

pub fn parse_windows_dxgi_source_id(id: &str) -> Option<WindowsDxgiSourceId> {
    let value = id.strip_prefix(WINDOWS_DXGI_SCREEN_PREFIX)?;
    let (adapter_luid, output_index) = value.rsplit_once(':')?;
    if adapter_luid.len() != 16 {
        return None;
    }
    Some(WindowsDxgiSourceId {
        adapter_luid: u64::from_str_radix(adapter_luid, 16).ok()?,
        output_index: output_index.parse().ok()?,
    })
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

/// Stable material for invalidating Windows GPU capability verdicts when the
/// adapter or its user-mode D3D11 driver changes. On non-Windows platforms the
/// explicit marker keeps shared key construction portable without pretending
/// that a Windows adapter was inspected.
#[cfg(target_os = "windows")]
#[allow(dead_code)] // Reserved for the shared Windows GPU capability-cache key.
pub(crate) fn graphics_adapter_driver_identity() -> String {
    windows_native::graphics_adapter_driver_identity().unwrap_or_else(|reason| {
        // A missing identity must disable cross-call cache reuse. Reusing a
        // verdict under an unknown driver is less safe than probing again.
        format!(
            "windows-adapter-driver-unavailable:{reason}:{}",
            uuid::Uuid::new_v4()
        )
    })
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)] // Portable counterpart for the shared capability-cache key.
pub(crate) fn graphics_adapter_driver_identity() -> String {
    format!(
        "platform={};windows-adapter-driver=not-applicable",
        std::env::consts::OS
    )
}

/// Linux: the desktop portal owns the picker, so the list carries exactly one
/// monitor entry and one window entry whose availability reflects the
/// session environment (Plan 0006).
#[cfg(target_os = "linux")]
pub fn list_native_capture_sources() -> NativeCaptureSources {
    let environment =
        crate::linux_portal_capture::portal_environment_available(&|key| std::env::var(key).ok());
    let warnings = environment
        .as_ref()
        .err()
        .map(|reason| {
            vec![format!(
                "Desktop portal screen capture is unavailable: {reason}."
            )]
        })
        .unwrap_or_default();
    NativeCaptureSources {
        devices: crate::linux_portal_capture::portal_capture_devices(environment),
        warnings,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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

#[cfg(any(test, target_os = "windows"))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct WindowsAdapterDriverIdentity {
    adapter_luid: u64,
    vendor_id: u32,
    device_id: u32,
    subsystem_id: u32,
    revision: u32,
    driver_version: u64,
}

#[cfg(any(test, target_os = "windows"))]
fn windows_adapter_driver_identity_material(
    mut adapters: Vec<WindowsAdapterDriverIdentity>,
) -> Option<String> {
    if adapters.is_empty() {
        return None;
    }
    adapters.sort_unstable();
    Some(
        adapters
            .into_iter()
            .map(|adapter| {
                format!(
                    "luid={:016x};pci={:04x}:{:04x}:{:08x}:{:02x};d3d11-driver={:016x}",
                    adapter.adapter_luid,
                    adapter.vendor_id,
                    adapter.device_id,
                    adapter.subsystem_id,
                    adapter.revision,
                    adapter.driver_version,
                )
            })
            .collect::<Vec<_>>()
            .join("|"),
    )
}

#[cfg(target_os = "windows")]
fn windows_gdigrab_desktop_device() -> Device {
    Device {
        app: None,
        window_title: None,
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

#[cfg(any(target_os = "macos", test))]
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

#[cfg(any(target_os = "macos", test))]
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

#[cfg(any(target_os = "macos", test))]
pub(crate) fn is_foreign_session_window_app(app_name: Option<&str>) -> bool {
    app_name.is_some_and(|value| value.eq_ignore_ascii_case("loginwindow"))
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::*;
    use windows::Win32::Foundation::{LUID, RECT};
    use windows::Win32::Graphics::Direct3D11::ID3D11Device;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1,
        IDXGIFactory1,
    };
    use windows::core::Interface;

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

    pub fn graphics_adapter_driver_identity() -> Result<String, String> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(windows_error_code)?;
        let mut identities = Vec::new();
        let mut adapter_index = 0;
        loop {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(windows_error_code(error)),
            };
            adapter_index += 1;

            let description = unsafe { adapter.GetDesc1() }.map_err(windows_error_code)?;
            if description.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let driver_version = unsafe { adapter.CheckInterfaceSupport(&ID3D11Device::IID) }
                .map_err(windows_error_code)?;
            identities.push(WindowsAdapterDriverIdentity {
                adapter_luid: adapter_luid_u64(description.AdapterLuid),
                vendor_id: description.VendorId,
                device_id: description.DeviceId,
                subsystem_id: description.SubSysId,
                revision: description.Revision,
                driver_version: driver_version as u64,
            });
        }
        windows_adapter_driver_identity_material(identities)
            .ok_or_else(|| "no-hardware-dxgi-adapter".to_string())
    }

    fn windows_error_code(error: windows::core::Error) -> String {
        format!("hresult-{:08x}", error.code().0 as u32)
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
                app: None,
                window_title: None,
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
pub(crate) mod macos {
    use super::*;
    use block2::RcBlock;
    // Scoped here (not at the top of the file) so the Windows arm never sees
    // an unused import — PR #59 deleted the top-level `use std::sync::mpsc`
    // as apparently-unused and broke the macOS build.
    use objc2_core_graphics::{
        CGDirectDisplayID, CGDisplayCopyDisplayMode, CGDisplayMode, CGPreflightScreenCaptureAccess,
    };
    use objc2_foundation::{NSError, NSString};
    use objc2_screen_capture_kit::{SCShareableContent, SCWindow};
    use std::sync::mpsc;

    use objc2::rc::Retained;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    // SCK content is an immutable discovery snapshot. Access is serialized by
    // the cache lock; retaining keeps it alive beyond its completion callback.
    #[derive(Clone)]
    struct Content(Retained<SCShareableContent>);
    unsafe impl Send for Content {}
    static CONTENT: OnceLock<Mutex<Option<(Instant, Content)>>> = OnceLock::new();

    fn load_shareable_content() -> Result<Content, String> {
        let mut cache = CONTENT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some((at, content)) = cache.as_ref()
            && at.elapsed() < Duration::from_secs(1)
        {
            return Ok(content.clone());
        }
        *cache = None;
        if !screen_capture_access_granted() {
            return Err(screen_capture_permission_message());
        }
        for attempt in 0..2 {
            let (tx, rx) = mpsc::channel();
            let handler = RcBlock::new(
                move |content: *mut SCShareableContent, error: *mut NSError| {
                    let result = if !error.is_null() {
                        Err(error_description(error))
                    } else {
                        unsafe { Retained::retain(content) }
                            .map(Content)
                            .ok_or_else(|| {
                                "ScreenCaptureKit returned no shareable content.".to_string()
                            })
                    };
                    let _ = tx.send(result);
                },
            );
            unsafe {
                SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, false, &handler);
            }
            match rx.recv_timeout(SCREEN_CAPTUREKIT_DISCOVERY_TIMEOUT) {
                Ok(Ok(content)) => {
                    *cache = Some((Instant::now(), content.clone()));
                    return Ok(content);
                }
                Ok(Err(error)) => return Err(error),
                Err(_) if attempt == 0 => continue,
                Err(_) => {
                    return Err(
                        "ScreenCaptureKit discovery timed out after two attempts.".to_string()
                    );
                }
            }
        }
        unreachable!()
    }

    /// Plan 210 S3: the discovery snapshot the listing or the resolver loaded
    /// within the last second, for a capture swap that follows them; `None`
    /// makes the caller load its own.
    pub(crate) fn recent_shareable_content() -> Option<Retained<SCShareableContent>> {
        let cache = CONTENT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        cache
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(1))
            .map(|(_, content)| content.0.clone())
    }

    pub fn resolve_app_window(
        params: &ResolveAppWindowParams,
    ) -> Result<ResolveAppWindowResult, String> {
        let content = load_shareable_content()?;
        let running = unsafe { content.0.applications() }
            .iter()
            .any(|a| unsafe { a.bundleIdentifier() }.to_string() == params.bundle_id);
        let windows = ordered_app_windows(&content)?;
        Ok(select_app_window(params, running, &windows))
    }

    fn ordered_app_windows(content: &Content) -> Result<Vec<AppWindow>, String> {
        // CGWindowListCopyWindowInfo supplies documented front-to-back order;
        // SCShareableContent.windows does not promise a z-order.
        use objc2_core_graphics::{CGWindowListCopyWindowInfo, CGWindowListOption};
        use objc2_foundation::{NSDictionary, NSNumber};
        let order = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, 0)
            .ok_or_else(|| "Could not read on-screen window order.".to_string())?;
        let mut ids = Vec::new();
        for i in 0..order.count() {
            // CFDictionary/NSDictionary are toll-free bridged. CG's documented
            // kCGWindowNumber value is an NSNumber.
            let dict =
                unsafe { &*(order.value_at_index(i) as *const NSDictionary<NSString, NSNumber>) };
            if let Some(id) = dict.objectForKey(&NSString::from_str("kCGWindowNumber")) {
                ids.push(id.unsignedIntValue());
            }
        }
        let mut windows: Vec<_> = unsafe { content.0.windows() }
            .iter()
            .filter_map(|w| {
                let app = window_application(&w)?;
                let frame = unsafe { w.frame() };
                let title = window_title(&w).unwrap_or_default();
                Some(AppWindow {
                    pid: app.pid,
                    id: unsafe { w.windowID() },
                    protected: is_protected_notes_window(&app, &title, unsafe { libc::getppid() }),
                    bundle_id: app.bundle_id,
                    app_name: app.name,
                    title,
                    width: frame.size.width.max(0.0) as u32,
                    height: frame.size.height.max(0.0) as u32,
                    layer: unsafe { w.windowLayer() },
                    on_screen: unsafe { w.isOnScreen() } && ids.contains(&unsafe { w.windowID() }),
                })
            })
            .collect();
        windows.sort_by_key(|w| ids.iter().position(|id| *id == w.id).unwrap_or(usize::MAX));
        Ok(windows)
    }

    pub fn app_previews(params: AppPreviewsParams) -> Result<Vec<AppPreview>, String> {
        use objc2::{AnyThread, msg_send, runtime::AnyClass};
        use objc2_screen_capture_kit::{SCContentFilter, SCStreamConfiguration};
        let content = load_shareable_content()?;
        let windows = ordered_app_windows(&content)?;
        let mut apps = build_app_previews(&windows, unsafe { libc::getppid() });
        // The class does not exist before macOS 14. Never send a newer selector there.
        let Some(manager) = AnyClass::get(c"SCScreenshotManager") else {
            return Ok(apps);
        };
        let deadline = Instant::now() + Duration::from_millis(1500);
        let mut pending = Vec::new();
        for (index, app) in apps.iter().enumerate() {
            let Some(id) = app
                .front_window_id
                .as_deref()
                .and_then(parse_screencapturekit_window_id)
            else {
                continue;
            };
            let Some(window) = (unsafe { content.0.windows() })
                .iter()
                .find(|w| unsafe { w.windowID() } == id)
            else {
                continue;
            };
            let frame = unsafe { window.frame() };
            let (width, height) = preview_size(
                frame.size.width.max(1.0) as u32,
                frame.size.height.max(1.0) as u32,
                params.max_width,
            );
            let (tx, rx) = mpsc::channel();
            let handler = RcBlock::new(
                move |image: *mut objc2_core_graphics::CGImage, error: *mut NSError| {
                    // Encode inside the completion: the borrowed CGImage lives only for this call.
                    let result = if image.is_null() || !error.is_null() {
                        None
                    } else {
                        unsafe { screenshot_jpeg(image) }.and_then(|bytes| preview_data_url(&bytes))
                    };
                    let _ = tx.send(result);
                },
            );
            unsafe {
                let filter = SCContentFilter::initWithDesktopIndependentWindow(
                    SCContentFilter::alloc(),
                    &window,
                );
                let config = SCStreamConfiguration::new();
                config.setWidth(width as usize);
                config.setHeight(height as usize);
                config.setShowsCursor(false);
                let _: () = msg_send![manager, captureImageWithFilter: &*filter, configuration: &*config, completionHandler: &*handler];
            }
            pending.push((index, width, height, rx));
        }
        for (index, width, height, rx) in pending {
            if let Ok(Some(picture)) =
                rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                apps[index].picture = Some(picture);
                apps[index].width = Some(width);
                apps[index].height = Some(height);
            }
        }
        Ok(apps)
    }

    unsafe fn screenshot_jpeg(image: *mut objc2_core_graphics::CGImage) -> Option<Vec<u8>> {
        use objc2::{
            msg_send,
            runtime::{AnyClass, AnyObject},
        };
        use objc2_foundation::{NSDictionary, NSNumber};
        unsafe {
            let class = AnyClass::get(c"NSBitmapImageRep")?;
            let allocated: objc2::rc::Allocated<AnyObject> = msg_send![class, alloc];
            let bitmap: Option<Retained<AnyObject>> = msg_send![allocated, initWithCGImage: image];
            let bitmap = bitmap?;
            let properties = NSDictionary::from_slices(
                &[&*NSString::from_str("NSImageCompressionFactor")],
                &[&*NSNumber::new_f64(0.7)],
            );
            let data: Option<Retained<AnyObject>> =
                msg_send![&*bitmap, representationUsingType: 3usize, properties: &*properties];
            let data = data?;
            let length: usize = msg_send![&*data, length];
            if length == 0 || length > 1_500_000 {
                return None;
            }
            let bytes: *const std::ffi::c_void = msg_send![&*data, bytes];
            Some(std::slice::from_raw_parts(bytes.cast::<u8>(), length).to_vec())
        }
    }

    fn window_application(window: &SCWindow) -> Option<crate::protocol::DeviceApp> {
        let application = unsafe { window.owningApplication()? };
        let bundle_id = unsafe { application.bundleIdentifier() };
        let name = unsafe { application.applicationName() };
        Some(crate::protocol::DeviceApp {
            bundle_id: ns_string_to_string(&bundle_id)?,
            name: ns_string_to_string(&name)?,
            pid: unsafe { application.processID() },
        })
    }

    pub fn list_native_capture_sources() -> NativeCaptureSources {
        if !screen_capture_access_granted() {
            *CONTENT
                .get_or_init(|| Mutex::new(None))
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
            return NativeCaptureSources {
                devices: vec![
                    Device {
                        app: None,
                        window_title: None,
                        id: "screen:screencapturekit-permission".to_string(),
                        name: "Primary Display".to_string(),
                        kind: DeviceKind::Screen,
                        status: DeviceStatus::PermissionRequired,
                        detail: Some(screen_capture_permission_message()),
                        width: None,
                        height: None,
                    },
                    Device {
                        app: None,
                        window_title: None,
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

        match load_shareable_content() {
            Ok(content) => NativeCaptureSources {
                devices: unsafe { devices_from_shareable_content(&content.0) },
                warnings: Vec::new(),
            },
            Err(error) => {
                let status = permission_or_unavailable(&error);
                NativeCaptureSources {
                    devices: vec![
                        Device {
                            app: None,
                            window_title: None,
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
                            app: None,
                            window_title: None,
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
        }
    }

    // Preflight only (plan 203 S2). Device listing runs on every launch and
    // every refresh; a request here raised macOS's own Screen Recording
    // prompt before Videorc had explained anything. The in-place request now
    // lives in the app (`system:request-screen-access`), behind a button.
    fn screen_capture_access_granted() -> bool {
        CGPreflightScreenCaptureAccess()
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
                app: None,
                window_title: None,
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
                app: window_application(&window),
                window_title: window_title(&window),
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
                app: None,
                window_title: None,
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
                app: None,
                window_title: None,
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

        if let Some(app) = window_application(window)
            && is_protected_notes_window(&app, title.as_deref().unwrap_or_default(), unsafe {
                libc::getppid()
            })
        {
            return false;
        }
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
    fn app_previews_group_count_front_and_exclusions() {
        let mut hidden = app_window(1);
        hidden.on_screen = false;
        let mut own = app_window(3);
        own.pid = 42;
        let mut notes = app_window(4);
        notes.protected = true;
        let mut palette = app_window(5);
        palette.layer = 1;
        let mut tiny = app_window(6);
        tiny.width = 399;
        let mut login = app_window(7);
        login.app_name = "loginwindow".into();
        login.bundle_id = "login.app".into();
        let apps = build_app_previews(
            &[
                own,
                hidden.clone(),
                app_window(2),
                notes,
                palette,
                tiny,
                login,
            ],
            42,
        );
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].window_count, 2);
        assert_eq!(
            apps[0].front_window_id.as_deref(),
            Some("window:screencapturekit:2")
        );
        assert_eq!(apps[0].front_window_title.as_deref(), Some("Window 2"));
        let minimized = build_app_previews(&[hidden], 42);
        assert_eq!(
            serde_json::to_value(&minimized[0]).unwrap(),
            serde_json::json!({"bundleId":"test.app", "name":"App", "pid":12345,"windowCount":1})
        );
        assert_eq!(
            serde_json::to_value(AppPreviewsParams::default()).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn app_previews_scale_and_data_url_budget() {
        assert_eq!(preview_size(1920, 1080, None), (320, 180));
        assert_eq!(preview_size(800, 600, Some(1)), (160, 120));
        assert_eq!(preview_size(800, 600, Some(900)), (640, 480));
        assert_eq!(preview_size(200, 400, None), (200, 400));
        assert_eq!(preview_size(0, 0, None), (1, 1));
        assert_eq!(
            preview_data_url(&[0xff, 0xd8, 0xff]).unwrap(),
            "data:image/jpeg;base64,/9j/"
        );
        assert!(preview_data_url(&vec![0; 1_500_000]).is_none());
        assert!(preview_data_url(&vec![0; 1_499_980]).unwrap().len() <= 2_000_000);
    }

    fn app_window(id: u32) -> AppWindow {
        AppWindow {
            id,
            pid: 12345,
            bundle_id: "test.app".into(),
            app_name: "App".into(),
            title: format!("Window {id}"),
            width: 800,
            height: 600,
            layer: 0,
            on_screen: true,
            protected: false,
        }
    }

    fn resolve_params() -> ResolveAppWindowParams {
        ResolveAppWindowParams {
            bundle_id: "test.app".into(),
            prefer_window_id: None,
            min_width: None,
            min_height: None,
        }
    }

    #[test]
    fn app_window_selection_z_order_floor_and_preference() {
        let mut params = resolve_params();
        let mut small = app_window(1);
        small.width = 399;
        let mut palette = app_window(2);
        palette.layer = 1;
        let windows = vec![small, palette, app_window(3), app_window(4)];
        let selected_id = |p: &ResolveAppWindowParams| match select_app_window(p, true, &windows) {
            ResolveAppWindowResult::Found { window_id, .. } => window_id,
            other => panic!("{other:?}"),
        };
        assert_eq!(selected_id(&params), "window:screencapturekit:3");
        params.prefer_window_id = Some("window:screencapturekit:4".into());
        assert_eq!(selected_id(&params), "window:screencapturekit:4");
        for id in [1, 2, 99] {
            params.prefer_window_id = Some(format!("window:screencapturekit:{id}"));
            assert_eq!(selected_id(&params), "window:screencapturekit:3");
        }
        params.min_width = Some(399);
        params.min_height = Some(600);
        assert_eq!(selected_id(&params), "window:screencapturekit:1");
    }

    #[test]
    fn app_window_selection_reasons_and_exclusions() {
        let params = resolve_params();
        let unavailable = |running, windows: &[AppWindow], reason| {
            assert_eq!(
                select_app_window(&params, running, windows),
                ResolveAppWindowResult::Unavailable { ok: false, reason }
            )
        };
        unavailable(false, &[], AppWindowUnavailableReason::NotRunning);
        unavailable(true, &[], AppWindowUnavailableReason::NoWindow);
        let mut hidden = app_window(1);
        hidden.on_screen = false;
        unavailable(
            true,
            &[hidden.clone()],
            AppWindowUnavailableReason::Minimized,
        );
        let mut protected = app_window(2);
        protected.protected = true;
        let mut login = app_window(3);
        login.app_name = "loginwindow".into();
        unavailable(
            true,
            &[protected, login],
            AppWindowUnavailableReason::NoWindow,
        );
        let mut foreign = app_window(4);
        foreign.bundle_id = "other.app".into();
        unavailable(true, &[foreign], AppWindowUnavailableReason::NoWindow);
        let mut params = params.clone();
        params.prefer_window_id = Some("window:screencapturekit:1".into());
        assert!(
            matches!(select_app_window(&params, true, &[hidden, app_window(5)]), ResolveAppWindowResult::Found { window_id, .. } if window_id == "window:screencapturekit:5")
        );
        let mut short = app_window(6);
        short.height = 299;
        unavailable(true, &[short], AppWindowUnavailableReason::NoWindow);
    }

    #[test]
    fn app_window_notes_exclusion_identifies_the_host_without_hiding_other_apps() {
        use crate::protocol::DeviceApp;
        let mut app = DeviceApp {
            bundle_id: "com.github.Electron".into(),
            name: "Electron".into(),
            pid: 42,
        };
        assert!(is_protected_notes_window(&app, "Notes", 42));
        assert!(!is_protected_notes_window(&app, "Notes", 43));
        app.bundle_id = "dev.theorcdev.videorc".into();
        assert!(is_protected_notes_window(&app, "Notes", 43));
        assert!(!is_protected_notes_window(&app, "Editor", 42));
    }

    #[test]
    fn app_window_device_serialization_omits_absent_metadata() {
        let mut device = Device {
            app: None,
            window_title: None,
            id: "screen:test".into(),
            name: "Screen".into(),
            kind: DeviceKind::Screen,
            status: DeviceStatus::Available,
            detail: None,
            width: None,
            height: None,
        };
        assert_eq!(
            serde_json::to_value(resolve_params()).unwrap(),
            serde_json::json!({"bundleId":"test.app"})
        );
        assert_eq!(
            serde_json::to_value(select_app_window(&resolve_params(), false, &[])).unwrap(),
            serde_json::json!({"ok": false, "reason": "not-running"})
        );
        let absent = serde_json::to_value(&device).unwrap();
        assert_eq!(
            absent,
            serde_json::json!({"id":"screen:test", "name":"Screen", "kind":"screen", "status":"available"})
        );
        device.app = Some(crate::protocol::DeviceApp {
            bundle_id: "test.app".into(),
            name: "App".into(),
            pid: 42,
        });
        device.window_title = Some("Editor".into());
        let present = serde_json::to_value(device).unwrap();
        assert_eq!(
            present["app"],
            serde_json::json!({"bundleId":"test.app", "name":"App", "pid":42})
        );
        assert_eq!(present["windowTitle"], "Editor");
        assert_eq!(
            serde_json::to_value(select_app_window(&resolve_params(), true, &[app_window(7)]))
                .unwrap(),
            serde_json::json!({"ok":true,"windowId":"window:screencapturekit:7","title":"Window 7","width":800,"height":600})
        );
    }

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
    fn callback_cadence_capability_distinguishes_continuous_and_damage_driven_sources() {
        assert!(ScreenCaptureCallbackCadence::Authoritative.is_authoritative());
        assert!(!ScreenCaptureCallbackCadence::DamageDriven.is_authoritative());
    }

    #[test]
    fn parses_windows_screen_source_ids() {
        assert_eq!(
            parse_windows_dxgi_source_id("screen:dxgi:00000000000003f1:2"),
            Some(WindowsDxgiSourceId {
                adapter_luid: 0x3f1,
                output_index: 2,
            })
        );
        assert_eq!(
            parse_windows_dxgi_output_index("screen:dxgi:00000000000003f1:2"),
            Some(2)
        );
        assert_eq!(parse_windows_dxgi_output_index("screen:dxgi::2"), None);
        assert_eq!(
            parse_windows_dxgi_output_index("screen:dxgi:not-a-luid-value:2"),
            None
        );
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
    fn windows_adapter_driver_identity_is_order_stable_and_driver_sensitive() {
        let integrated = WindowsAdapterDriverIdentity {
            adapter_luid: 0x0000_0001_0000_0002,
            vendor_id: 0x8086,
            device_id: 0x46a6,
            subsystem_id: 0x0000_0001,
            revision: 3,
            driver_version: 0x0001_0002_0003_0004,
        };
        let discrete = WindowsAdapterDriverIdentity {
            adapter_luid: 0x0000_0003_0000_0004,
            vendor_id: 0x10de,
            device_id: 0x2684,
            subsystem_id: 0x0000_0002,
            revision: 1,
            driver_version: 0x0005_0006_0007_0008,
        };
        let first =
            windows_adapter_driver_identity_material(vec![discrete.clone(), integrated.clone()])
                .unwrap();
        assert_eq!(
            first,
            windows_adapter_driver_identity_material(vec![integrated.clone(), discrete.clone()])
                .unwrap(),
            "DXGI enumeration order must not perturb a capability key"
        );

        let mut updated = discrete;
        updated.driver_version += 1;
        assert_ne!(
            first,
            windows_adapter_driver_identity_material(vec![integrated, updated]).unwrap(),
            "a driver update must invalidate cached GPU capability verdicts"
        );
        assert_eq!(windows_adapter_driver_identity_material(Vec::new()), None);
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
