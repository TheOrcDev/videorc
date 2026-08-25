use crate::protocol::{Device, DeviceKind, DeviceStatus};

const NATIVE_CAMERA_PREFIX: &str = "camera:avfoundation-native:";
const WINDOWS_DSHOW_CAMERA_PREFIX: &str = "camera:windows-dshow:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCameraDevices {
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CameraFormatSummary {
    pub width: u32,
    pub height: u32,
    pub min_fps: f64,
    pub max_fps: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CameraFormatChoice {
    pub format: CameraFormatSummary,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeCameraPermission {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    Unknown,
}

#[cfg(target_os = "macos")]
pub fn list_native_cameras() -> NativeCameraDevices {
    macos::list_native_cameras()
}

#[cfg(target_os = "windows")]
pub fn list_native_cameras() -> NativeCameraDevices {
    windows_native::list_native_cameras()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn list_native_cameras() -> NativeCameraDevices {
    NativeCameraDevices {
        devices: Vec::new(),
        warnings: vec!["Native camera discovery is only available on macOS/Windows.".to_string()],
    }
}

pub fn native_camera_name_for_id(camera_id: &str) -> Option<String> {
    let unique_id = parse_native_camera_id(camera_id)?;

    #[cfg(target_os = "macos")]
    {
        macos::camera_name_for_unique_id(&unique_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = unique_id;
        None
    }
}

pub fn camera_capability_matrix_for_id(
    camera_id: &str,
) -> Result<Vec<CameraFormatSummary>, String> {
    if parse_windows_dshow_camera_id(camera_id).is_some() {
        return Err(
            "Windows camera capability diagnostics need on-box dshow format probing.".to_string(),
        );
    }

    let unique_id = parse_native_camera_id(camera_id)
        .ok_or_else(|| "Selected camera is not a native AVFoundation camera.".to_string())?;

    #[cfg(target_os = "macos")]
    {
        macos::camera_capability_matrix_for_unique_id(&unique_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = unique_id;
        Err(
            "Native AVFoundation camera capability diagnostics are only available on macOS."
                .to_string(),
        )
    }
}

pub fn native_camera_device_id(unique_id: &str) -> String {
    format!("{NATIVE_CAMERA_PREFIX}{}", encode_hex(unique_id.as_bytes()))
}

pub fn parse_native_camera_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(NATIVE_CAMERA_PREFIX)?;
    let bytes = decode_hex(encoded)?;
    String::from_utf8(bytes).ok()
}

pub fn parse_windows_dshow_camera_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(WINDOWS_DSHOW_CAMERA_PREFIX)?;
    let bytes = decode_hex(encoded)?;
    String::from_utf8(bytes).ok()
}

#[cfg(any(test, target_os = "windows"))]
fn windows_dshow_camera_device_id(device_name: &str) -> String {
    format!(
        "{WINDOWS_DSHOW_CAMERA_PREFIX}{}",
        encode_hex(device_name.as_bytes())
    )
}

pub fn camera_permission_status(permission: NativeCameraPermission) -> DeviceStatus {
    match permission {
        NativeCameraPermission::Authorized => DeviceStatus::Available,
        NativeCameraPermission::NotDetermined
        | NativeCameraPermission::Denied
        | NativeCameraPermission::Restricted => DeviceStatus::PermissionRequired,
        NativeCameraPermission::Unknown => DeviceStatus::Unavailable,
    }
}

pub fn choose_camera_format(
    formats: &[CameraFormatSummary],
    target_width: u32,
    target_height: u32,
    target_fps: u32,
) -> Option<CameraFormatChoice> {
    let target_fps = f64::from(target_fps);
    let supports_target = |format: &&CameraFormatSummary| {
        format.width == target_width
            && format.height == target_height
            && format_supports_fps(format, target_fps)
    };

    if let Some(format) = formats.iter().find(supports_target) {
        return Some(CameraFormatChoice {
            format: (*format).clone(),
            fallback_reason: None,
        });
    }

    let target_pixels = u64::from(target_width) * u64::from(target_height);
    let fps_capable = formats
        .iter()
        .filter(|format| format_supports_fps(format, target_fps))
        .collect::<Vec<_>>();
    // Resolution first among the fps-capable formats: a format that covers the
    // requested pixels keeps the image native, while a smaller one is upscaled
    // for the rest of the session. The nearest covering format wins so a 4K ask
    // does not grab an 8K sensor mode it does not need.
    let selected = fps_capable
        .iter()
        .copied()
        .filter(|format| camera_format_pixels(format) >= target_pixels)
        .min_by_key(|format| camera_format_pixels(format).saturating_sub(target_pixels))
        .or_else(|| {
            fps_capable.iter().copied().max_by_key(|format| {
                (
                    camera_format_pixels(format),
                    format.max_fps.round().max(0.0) as u64,
                )
            })
        })
        .or_else(|| {
            formats.iter().max_by_key(|format| {
                (
                    camera_format_pixels(format),
                    format.max_fps.round().max(0.0) as u64,
                )
            })
        })?;

    Some(CameraFormatChoice {
        format: selected.clone(),
        fallback_reason: Some(format!(
            "Requested {target_width}x{target_height}@{target_fps:.0} was not available; selected native {}x{} at {:.0}-{:.0} fps.",
            selected.width, selected.height, selected.min_fps, selected.max_fps
        )),
    })
}

pub fn normalize_camera_formats(mut formats: Vec<CameraFormatSummary>) -> Vec<CameraFormatSummary> {
    formats.retain(|format| {
        format.width > 0
            && format.height > 0
            && format.min_fps.is_finite()
            && format.max_fps.is_finite()
            && format.max_fps > 0.0
            && format.min_fps <= format.max_fps
    });
    formats.sort_by(|left, right| {
        left.width
            .cmp(&right.width)
            .then(left.height.cmp(&right.height))
            .then(left.min_fps.total_cmp(&right.min_fps))
            .then(left.max_fps.total_cmp(&right.max_fps))
    });
    formats.dedup_by(|left, right| {
        left.width == right.width
            && left.height == right.height
            && left.min_fps == right.min_fps
            && left.max_fps == right.max_fps
    });
    formats
}

/// Capture devices advertise the fractional NTSC rates (29.97, 59.94) that
/// broadcast video actually uses, while sessions are configured in whole
/// numbers. Without a tolerance an Elgato Cam Link 4K — whose 2160p format
/// tops out at 29.97 — fails a 30 fps request by 0.03, is dropped from the
/// fps-capable set, and loses to 1080p60: the camera then captures 1080p and
/// the 4K session upscales it, with only a "closest format" warning to show
/// for it. One frame of slack costs nothing and matches the renderer's own
/// FPS_TOLERANCE in camera-format-shortfall.ts.
const FPS_TOLERANCE: f64 = 1.0;

fn format_supports_fps(format: &CameraFormatSummary, target_fps: f64) -> bool {
    format.min_fps <= target_fps + FPS_TOLERANCE && format.max_fps >= target_fps - FPS_TOLERANCE
}

fn camera_format_pixels(format: &CameraFormatSummary) -> u64 {
    u64::from(format.width) * u64::from(format.height)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }

    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| {
            let high = hex_value(chunk[0])?;
            let low = hex_value(chunk[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
mod windows_native {
    use super::*;
    use windows::Win32::Media::MediaFoundation::{
        IMFActivate, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_VERSION, MFCreateAttributes,
        MFEnumDeviceSources, MFSTARTUP_FULL, MFShutdown, MFStartup,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::core::GUID;

    pub fn list_native_cameras() -> NativeCameraDevices {
        match list_media_foundation_cameras() {
            Ok(mut devices) => {
                let mut warnings = Vec::new();
                if devices.is_empty() {
                    warnings.push(
                        "MediaFoundation did not report any video capture devices.".to_string(),
                    );
                    devices.push(unavailable_camera(
                        "camera:windows-mediafoundation-missing",
                        "MediaFoundation did not report any video capture devices.",
                    ));
                }
                NativeCameraDevices { devices, warnings }
            }
            Err(error) => NativeCameraDevices {
                devices: vec![unavailable_camera(
                    "camera:windows-mediafoundation-unavailable",
                    &format!("MediaFoundation camera discovery failed: {error}"),
                )],
                warnings: vec![format!("MediaFoundation camera discovery failed: {error}")],
            },
        }
    }

    fn list_media_foundation_cameras() -> windows::core::Result<Vec<Device>> {
        let _media_foundation = MediaFoundationSession::start()?;
        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 1)? };
        let attributes =
            attributes.expect("MFCreateAttributes returned success without attributes");
        unsafe {
            attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )?
        };

        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0;
        unsafe { MFEnumDeviceSources(&attributes, &mut activates, &mut count)? };

        let mut devices = Vec::new();
        for index in 0..count {
            let activate = unsafe { activates.add(index as usize).read() };
            if let Some(activate) = activate {
                devices.push(device_from_activate(&activate, index));
            }
        }
        unsafe { CoTaskMemFree(Some(activates.cast())) };

        Ok(devices)
    }

    fn device_from_activate(activate: &IMFActivate, index: u32) -> Device {
        let friendly_name = mf_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
            .unwrap_or_else(|| format!("Camera {}", index + 1));
        let symbolic_link = mf_string(
            activate,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
        );
        // The capture name is what ffmpeg's dshow demuxer receives as
        // `-i video=<name>`. dshow's device selector is the DirectShow FRIENDLY
        // NAME, not the MediaFoundation symbolic link — feeding it the MF
        // symbolic link (`@\\?\usb#...#{mf-guid}`) made dshow report "Could not
        // find video device" and the preview produced zero frames (the Windows
        // tester "camera granted but not working" report). The symbolic link
        // stays in the detail for support triage, not as the ffmpeg arg.
        let capture_name = friendly_name.clone();
        Device {
            id: windows_dshow_camera_device_id(&capture_name),
            name: friendly_name.clone(),
            kind: DeviceKind::Camera,
            status: DeviceStatus::Available,
            detail: Some(windows_media_foundation_camera_detail(
                &friendly_name,
                symbolic_link.as_deref().unwrap_or(&capture_name),
            )),
            width: None,
            height: None,
        }
    }

    fn mf_string(activate: &IMFActivate, key: &GUID) -> Option<String> {
        let len = unsafe { activate.GetStringLength(key).ok()? };
        if len == 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let mut written = 0;
        unsafe {
            activate
                .GetString(key, &mut buffer, Some(&mut written))
                .ok()?;
        }
        utf16_z(&buffer[..written as usize])
    }

    struct MediaFoundationSession;

    impl MediaFoundationSession {
        fn start() -> windows::core::Result<Self> {
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
            Ok(Self)
        }
    }

    impl Drop for MediaFoundationSession {
        fn drop(&mut self) {
            let _ = unsafe { MFShutdown() };
        }
    }

    fn unavailable_camera(id: &str, detail: &str) -> Device {
        Device {
            id: id.to_string(),
            name: "Camera".to_string(),
            kind: DeviceKind::Camera,
            status: DeviceStatus::Unavailable,
            detail: Some(detail.to_string()),
            width: None,
            height: None,
        }
    }
}

#[cfg(any(test, target_os = "windows"))]
fn windows_media_foundation_camera_detail(friendly_name: &str, capture_name: &str) -> String {
    if capture_name == friendly_name {
        format!("Windows MediaFoundation camera. Recording uses dshow device `{capture_name}`.")
    } else {
        format!(
            "Windows MediaFoundation camera `{friendly_name}`. Recording uses dshow device `{capture_name}`."
        )
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
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeVideo};
    use objc2_core_media::CMVideoFormatDescriptionGetDimensions;
    use objc2_foundation::NSString;

    pub fn list_native_cameras() -> NativeCameraDevices {
        let Some(video_media_type) = video_media_type() else {
            return NativeCameraDevices {
                devices: vec![unavailable_camera(
                    "camera:avfoundation-native-media-type-missing",
                    "AVFoundation video media type is unavailable.",
                )],
                warnings: vec!["AVFoundation video media type is unavailable.".to_string()],
            };
        };

        let permission = native_camera_permission();
        let status = camera_permission_status(permission);
        #[allow(deprecated)]
        let devices = unsafe { AVCaptureDevice::devicesWithMediaType(video_media_type) };
        let mut camera_devices = Vec::new();

        for index in 0..devices.count() {
            let camera = devices.objectAtIndex(index);
            let unique_id = unsafe { camera.uniqueID() };
            let unique_id =
                ns_string_to_string(&unique_id).unwrap_or_else(|| format!("unknown-{index}"));
            let name = unsafe { camera.localizedName() };
            let name =
                ns_string_to_string(&name).unwrap_or_else(|| format!("Camera {}", index + 1));
            let formats = normalize_camera_formats(camera_formats(&camera));
            let active_format = active_camera_format_detail(&camera);
            let permission_detail = camera_permission_detail(permission);
            let detail = match (active_format, permission_detail) {
                (Some(active_format), Some(permission_detail)) => {
                    format!("{permission_detail} {active_format}")
                }
                (Some(active_format), None) => active_format,
                (None, Some(permission_detail)) => permission_detail.to_string(),
                (None, None) => {
                    "Native AVFoundation camera. Recording currently uses the FFmpeg fallback bridge."
                        .to_string()
                }
            };

            let choice = choose_camera_format(&formats, 1920, 1080, 30);
            let detail = if let Some(reason) = choice.and_then(|choice| choice.fallback_reason) {
                format!("{detail} {reason}")
            } else {
                detail
            };

            camera_devices.push(Device {
                id: native_camera_device_id(&unique_id),
                name,
                kind: DeviceKind::Camera,
                status: status.clone(),
                detail: Some(detail),
                width: None,
                height: None,
            });
        }

        if camera_devices.is_empty() {
            camera_devices.push(unavailable_camera(
                "camera:avfoundation-native-missing",
                if status == DeviceStatus::PermissionRequired {
                    "AVFoundation did not return cameras. Camera permission may be missing."
                } else {
                    "AVFoundation did not return any video cameras."
                },
            ));
        }

        NativeCameraDevices {
            devices: camera_devices,
            warnings: camera_permission_warning(permission).into_iter().collect(),
        }
    }

    pub fn camera_name_for_unique_id(unique_id: &str) -> Option<String> {
        let unique_id = NSString::from_str(unique_id);
        let camera = unsafe { AVCaptureDevice::deviceWithUniqueID(&unique_id) }?;
        let name = unsafe { camera.localizedName() };
        ns_string_to_string(&name)
    }

    pub fn camera_capability_matrix_for_unique_id(
        unique_id: &str,
    ) -> Result<Vec<CameraFormatSummary>, String> {
        let unique_id = NSString::from_str(unique_id);
        let camera = unsafe { AVCaptureDevice::deviceWithUniqueID(&unique_id) }
            .ok_or_else(|| "Camera device is missing.".to_string())?;
        let formats = normalize_camera_formats(camera_formats(&camera));
        if formats.is_empty() {
            Err("Camera did not report usable AVFoundation video formats.".to_string())
        } else {
            Ok(formats)
        }
    }

    fn native_camera_permission() -> NativeCameraPermission {
        let Some(video_media_type) = video_media_type() else {
            return NativeCameraPermission::Unknown;
        };
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(video_media_type) } {
            status if status == AVAuthorizationStatus::Authorized => {
                NativeCameraPermission::Authorized
            }
            status if status == AVAuthorizationStatus::NotDetermined => {
                NativeCameraPermission::NotDetermined
            }
            status if status == AVAuthorizationStatus::Denied => NativeCameraPermission::Denied,
            status if status == AVAuthorizationStatus::Restricted => {
                NativeCameraPermission::Restricted
            }
            _ => NativeCameraPermission::Unknown,
        }
    }

    fn video_media_type() -> Option<&'static objc2_av_foundation::AVMediaType> {
        unsafe { AVMediaTypeVideo }
    }

    fn camera_permission_detail(permission: NativeCameraPermission) -> Option<&'static str> {
        match permission {
            NativeCameraPermission::Authorized => None,
            NativeCameraPermission::NotDetermined => {
                Some("Camera permission has not been granted yet.")
            }
            NativeCameraPermission::Denied => Some("Camera permission is denied."),
            NativeCameraPermission::Restricted => Some("Camera permission is restricted by macOS."),
            NativeCameraPermission::Unknown => Some("Camera permission state is unknown."),
        }
    }

    fn camera_permission_warning(permission: NativeCameraPermission) -> Option<String> {
        match permission {
            NativeCameraPermission::Authorized => None,
            NativeCameraPermission::NotDetermined => Some(
                "Camera permission has not been granted yet. Open Camera privacy settings if preview shows black frames."
                    .to_string(),
            ),
            NativeCameraPermission::Denied | NativeCameraPermission::Restricted => Some(
                "Camera permission is blocked. Open macOS Camera privacy settings and enable Videorc or the development shell."
                    .to_string(),
            ),
            NativeCameraPermission::Unknown => {
                Some("Could not determine Camera permission state.".to_string())
            }
        }
    }

    fn camera_formats(camera: &AVCaptureDevice) -> Vec<CameraFormatSummary> {
        let formats = unsafe { camera.formats() };
        let mut summaries = Vec::new();

        for index in 0..formats.count() {
            let format = formats.objectAtIndex(index);
            let description = unsafe { format.formatDescription() };
            let dimensions = unsafe { CMVideoFormatDescriptionGetDimensions(&description) };
            let ranges = unsafe { format.videoSupportedFrameRateRanges() };

            for range_index in 0..ranges.count() {
                let range = ranges.objectAtIndex(range_index);
                summaries.push(CameraFormatSummary {
                    width: dimensions.width.max(0) as u32,
                    height: dimensions.height.max(0) as u32,
                    min_fps: unsafe { range.minFrameRate() },
                    max_fps: unsafe { range.maxFrameRate() },
                });
            }
        }

        summaries
    }

    fn active_camera_format_detail(camera: &AVCaptureDevice) -> Option<String> {
        let active_format = unsafe { camera.activeFormat() };
        let description = unsafe { active_format.formatDescription() };
        let dimensions = unsafe { CMVideoFormatDescriptionGetDimensions(&description) };
        let ranges = unsafe { active_format.videoSupportedFrameRateRanges() };
        let max_fps = max_frame_rate(&ranges);
        let width = dimensions.width.max(0);
        let height = dimensions.height.max(0);

        if width == 0 || height == 0 {
            return None;
        }

        Some(match max_fps {
            Some(max_fps) => format!(
                "Native AVFoundation camera active format: {width}x{height} up to {max_fps:.0} fps. Recording currently uses the FFmpeg fallback bridge."
            ),
            None => format!(
                "Native AVFoundation camera active format: {width}x{height}. Recording currently uses the FFmpeg fallback bridge."
            ),
        })
    }

    fn max_frame_rate(
        ranges: &objc2_foundation::NSArray<objc2_av_foundation::AVFrameRateRange>,
    ) -> Option<f64> {
        let mut max_fps: Option<f64> = None;
        for index in 0..ranges.count() {
            let range = ranges.objectAtIndex(index);
            let fps = unsafe { range.maxFrameRate() };
            max_fps = Some(max_fps.map_or(fps, |current| current.max(fps)));
        }
        max_fps
    }

    fn unavailable_camera(id: &str, detail: &str) -> Device {
        Device {
            id: id.to_string(),
            name: "Camera".to_string(),
            kind: DeviceKind::Camera,
            status: DeviceStatus::Unavailable,
            detail: Some(detail.to_string()),
            width: None,
            height: None,
        }
    }

    fn ns_string_to_string(value: &NSString) -> Option<String> {
        let value = value.to_string();
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_camera_ids_round_trip_unique_ids() {
        let unique_id = "AppleCamera-0x8020000005ac8514";
        let device_id = native_camera_device_id(unique_id);

        assert_eq!(
            parse_native_camera_id(&device_id).as_deref(),
            Some(unique_id)
        );
        assert_eq!(parse_native_camera_id("camera:avfoundation:0"), None);
        assert_eq!(
            parse_native_camera_id("camera:avfoundation-native:not-hex"),
            None
        );
    }

    #[test]
    fn parses_windows_dshow_camera_ids() {
        assert_eq!(
            parse_windows_dshow_camera_id("camera:windows-dshow:5553422043616d657261").as_deref(),
            Some("USB Camera")
        );
        assert_eq!(
            parse_windows_dshow_camera_id(&windows_dshow_camera_device_id(
                r"@\\?\usb#vid_1234&pid_5678"
            ))
            .as_deref(),
            Some(r"@\\?\usb#vid_1234&pid_5678")
        );
        assert_eq!(
            parse_windows_dshow_camera_id("camera:windows-dshow:not-hex"),
            None
        );
        assert_eq!(parse_windows_dshow_camera_id("camera:avfoundation:0"), None);
    }

    #[test]
    fn windows_dshow_camera_capabilities_report_pending_format_probe() {
        let error = camera_capability_matrix_for_id("camera:windows-dshow:5553422043616d657261")
            .unwrap_err();

        assert_eq!(
            error,
            "Windows camera capability diagnostics need on-box dshow format probing."
        );
    }

    #[test]
    fn describes_windows_mediafoundation_camera_detail() {
        assert_eq!(
            windows_media_foundation_camera_detail("USB Camera", r"@\\?\usb#vid_1234"),
            r"Windows MediaFoundation camera `USB Camera`. Recording uses dshow device `@\\?\usb#vid_1234`."
        );
        assert_eq!(
            windows_media_foundation_camera_detail("USB Camera", "USB Camera"),
            "Windows MediaFoundation camera. Recording uses dshow device `USB Camera`."
        );
    }

    #[test]
    fn trims_utf16_null_terminated_camera_names() {
        let mut value = [0u16; 8];
        value[0] = 'C' as u16;
        value[1] = 'a' as u16;
        value[2] = 'm' as u16;

        assert_eq!(utf16_z(&value).as_deref(), Some("Cam"));
        assert_eq!(utf16_z(&[0, 0, 0]), None);
    }

    #[test]
    fn maps_camera_permission_to_device_status() {
        assert_eq!(
            camera_permission_status(NativeCameraPermission::Authorized),
            DeviceStatus::Available
        );
        assert_eq!(
            camera_permission_status(NativeCameraPermission::Denied),
            DeviceStatus::PermissionRequired
        );
        assert_eq!(
            camera_permission_status(NativeCameraPermission::Unknown),
            DeviceStatus::Unavailable
        );
    }

    #[test]
    fn chooses_exact_camera_format_when_available() {
        let formats = vec![
            CameraFormatSummary {
                width: 1280,
                height: 720,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 30.0,
            },
        ];

        let choice = choose_camera_format(&formats, 1920, 1080, 30).unwrap();

        assert_eq!(choice.format.width, 1920);
        assert_eq!(choice.format.height, 1080);
        assert_eq!(choice.fallback_reason, None);
    }

    #[test]
    fn chooses_clear_camera_format_fallback() {
        let formats = vec![CameraFormatSummary {
            width: 1280,
            height: 720,
            min_fps: 1.0,
            max_fps: 60.0,
        }];

        let choice = choose_camera_format(&formats, 1920, 1080, 30).unwrap();

        assert_eq!(choice.format.width, 1280);
        assert!(choice.fallback_reason.unwrap().contains("not available"));
    }

    #[test]
    fn chooses_smallest_native_format_covering_target_at_requested_fps() {
        let formats = vec![
            CameraFormatSummary {
                width: 640,
                height: 360,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 30.0,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 30.0,
            },
        ];

        let choice = choose_camera_format(&formats, 1280, 720, 30).unwrap();

        assert_eq!(choice.format.width, 1920);
        assert_eq!(choice.format.height, 1080);
    }

    #[test]
    fn chooses_largest_format_at_requested_fps_when_no_mode_covers_target() {
        let formats = vec![
            CameraFormatSummary {
                width: 1280,
                height: 720,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 30.0,
            },
        ];

        let choice = choose_camera_format(&formats, 3840, 2160, 60).unwrap();

        assert_eq!(choice.format.width, 1920);
        assert_eq!(choice.format.height, 1080);
        assert!(
            choice
                .fallback_reason
                .unwrap()
                .contains("selected native 1920x1080")
        );
    }

    #[test]
    fn falls_back_to_largest_mode_when_requested_fps_is_unavailable() {
        let formats = vec![
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 30.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 30.0,
            },
        ];

        let choice = choose_camera_format(&formats, 3840, 2160, 60).unwrap();

        assert_eq!(choice.format.width, 3840);
        assert_eq!(choice.format.height, 2160);
        assert!(choice.fallback_reason.unwrap().contains("1-30 fps"));
    }

    /// The owner's Elgato Cam Link 4K, as macOS enumerates it: the 2160p mode
    /// runs at the fractional NTSC rate, the 1080p modes go faster.
    fn cam_link_4k_formats() -> Vec<CameraFormatSummary> {
        vec![
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 29.97,
                max_fps: 29.97,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 59.94,
                max_fps: 59.94,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 29.97,
                max_fps: 29.97,
            },
            CameraFormatSummary {
                width: 1280,
                height: 720,
                min_fps: 59.94,
                max_fps: 59.94,
            },
        ]
    }

    #[test]
    fn captures_4k_natively_when_the_camera_runs_at_the_fractional_ntsc_rate() {
        // 29.97 is not 30, and demanding an exact match made a 4K30 session
        // capture 1080p60 and upscale it — the camera's own 4K mode was
        // discarded for being 0.03 fps short.
        let choice = choose_camera_format(&cam_link_4k_formats(), 3840, 2160, 30).unwrap();

        assert_eq!((choice.format.width, choice.format.height), (3840, 2160));
        assert!(
            choice.fallback_reason.is_none(),
            "a native-resolution capture at the device's own rate is not a fallback: {:?}",
            choice.fallback_reason
        );
    }

    #[test]
    fn still_reports_a_shortfall_when_the_camera_truly_cannot_reach_the_request() {
        // 60 fps at 4K is genuinely beyond this device, so the warning the
        // owner sees in that case is honest and must survive.
        let choice = choose_camera_format(&cam_link_4k_formats(), 3840, 2160, 60).unwrap();

        assert_eq!((choice.format.width, choice.format.height), (1920, 1080));
        assert!(choice.fallback_reason.is_some());
    }

    #[test]
    fn prefers_covering_resolution_over_a_faster_smaller_format() {
        // Both satisfy 30 fps; only one keeps the image native for a 4K canvas.
        let formats = vec![
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 120.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 30.0,
            },
        ];

        let choice = choose_camera_format(&formats, 3840, 2160, 30).unwrap();

        assert_eq!((choice.format.width, choice.format.height), (3840, 2160));
    }

    #[test]
    fn fps_tolerance_does_not_accept_a_format_that_is_a_whole_tier_short() {
        // Tolerance is one frame, not a licence to call 30 fps "close to 60".
        let formats = vec![CameraFormatSummary {
            width: 1920,
            height: 1080,
            min_fps: 1.0,
            max_fps: 30.0,
        }];

        let choice = choose_camera_format(&formats, 1920, 1080, 60).unwrap();

        assert!(choice.fallback_reason.is_some());
    }

    #[test]
    fn normalizes_camera_format_matrix_for_diagnostics() {
        let formats = normalize_camera_formats(vec![
            CameraFormatSummary {
                width: 0,
                height: 2160,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 60.0,
            },
            CameraFormatSummary {
                width: 1920,
                height: 1080,
                min_fps: 1.0,
                max_fps: 30.0,
            },
            CameraFormatSummary {
                width: 3840,
                height: 2160,
                min_fps: 1.0,
                max_fps: 60.0,
            },
        ]);

        assert_eq!(
            formats,
            vec![
                CameraFormatSummary {
                    width: 1920,
                    height: 1080,
                    min_fps: 1.0,
                    max_fps: 30.0,
                },
                CameraFormatSummary {
                    width: 3840,
                    height: 2160,
                    min_fps: 1.0,
                    max_fps: 60.0,
                },
            ]
        );
    }
}
