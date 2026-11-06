//! Low-light compensation for Windows cameras (issue #1066).
//!
//! UVC webcams ship with auto-exposure priority on: in low light the camera
//! may hold the shutter open longer than one frame, so a 30 fps camera
//! delivers 15 (the owner's C920) or 11 (an HP HD Camera in an ordinary room,
//! 91 frames in 8 s against 244 with it off). Recordings and streams then get
//! a half-rate camera. OBS calls the control "Low light compensation".
//!
//! Videorc keeps the frame rate by default: every time it opens a Windows
//! camera it writes the camera's auto-exposure priority to match the user's
//! choice for that camera (off unless they turned it on). The value lives in
//! the device and its driver, so it holds for FFmpeg's DirectShow session in
//! its own process, and a write while that session runs takes effect within
//! a second. Measured on the HP HD Camera before this module was written.
//!
//! The choice is stored per camera id in `app_settings`; a camera with no
//! entry has compensation off.

use std::collections::BTreeMap;

use crate::protocol::CameraLowLightState;
use crate::storage::Database;

pub const CAMERA_LOW_LIGHT_SETTINGS_KEY: &str = "camera.lowLightCompensation";

/// Camera id → compensation on. Only `true` entries are kept: off is the
/// default, so turning it off removes the camera's entry.
type LowLightPrefs = BTreeMap<String, bool>;

/// What the device said when Videorc read or wrote its control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceLowLight {
    /// The control exists and the device now holds `compensation`.
    /// `changed` is true when Videorc's write moved it.
    Holds { compensation: bool, changed: bool },
    /// Videorc cannot set it here, and why.
    Unsupported(String),
}

impl DeviceLowLight {
    pub fn supported(&self) -> bool {
        matches!(self, Self::Holds { .. })
    }
}

/// The value written to `KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY`:
/// 1 lets exposure lower the frame rate, 0 keeps the frame rate.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn auto_exposure_priority_value(compensation: bool) -> i32 {
    i32::from(compensation)
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn compensation_from_priority(value: i32) -> bool {
    value != 0
}

fn load_prefs(database: &Database) -> LowLightPrefs {
    match database.load_setting::<LowLightPrefs>(CAMERA_LOW_LIGHT_SETTINGS_KEY) {
        Ok(prefs) => prefs.unwrap_or_default(),
        Err(error) => {
            tracing::warn!("Camera low-light settings are unreadable; using the default: {error}");
            LowLightPrefs::default()
        }
    }
}

/// The user's choice for this camera (off unless they turned it on).
pub fn stored_compensation(database: &Database, camera_id: &str) -> bool {
    load_prefs(database)
        .get(camera_id)
        .copied()
        .unwrap_or(false)
}

fn with_compensation(
    mut prefs: LowLightPrefs,
    camera_id: &str,
    compensation: bool,
) -> LowLightPrefs {
    if compensation {
        prefs.insert(camera_id.to_string(), true);
    } else {
        prefs.remove(camera_id);
    }
    prefs
}

pub fn save_compensation(
    database: &Database,
    camera_id: &str,
    compensation: bool,
) -> anyhow::Result<()> {
    let prefs = with_compensation(load_prefs(database), camera_id, compensation);
    database.save_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY, &prefs)
}

/// The answer to `camera.lowLight.get` / `.set`: the stored choice, and
/// whether this camera has the control at all.
pub fn state_for(
    camera_id: &str,
    compensation: bool,
    device: &DeviceLowLight,
) -> CameraLowLightState {
    CameraLowLightState {
        camera_id: camera_id.to_string(),
        supported: device.supported(),
        compensation,
    }
}

/// Reads the control without changing it.
pub fn read_device(camera_id: &str) -> DeviceLowLight {
    device_control(camera_id, None)
}

/// Writes the control when it differs from `compensation`.
pub fn write_device(camera_id: &str, compensation: bool) -> DeviceLowLight {
    device_control(camera_id, Some(compensation))
}

/// Device writes run one at a time, and each reads the saved choice inside
/// the lock: a switch flipped while a camera opens can never be overwritten
/// by the value the open read before it.
static DEVICE_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn write_stored(database: &Database, camera_id: &str) -> DeviceLowLight {
    let _serialized = DEVICE_WRITES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    write_device(camera_id, stored_compensation(database, camera_id))
}

/// `camera.lowLight.get`: the stored choice, and whether the camera has the
/// control (read from the device, without changing it).
pub async fn get(state: &crate::state::AppState, camera_id: String) -> CameraLowLightState {
    let compensation = stored_compensation(&state.database, &camera_id);
    let id = camera_id.clone();
    let device = tokio::task::spawn_blocking(move || read_device(&id))
        .await
        .unwrap_or_else(|error| DeviceLowLight::Unsupported(error.to_string()));
    state_for(&camera_id, compensation, &device)
}

/// `camera.lowLight.set`: saves the choice and writes it to the device now,
/// whether or not Videorc has the camera open (the device keeps it).
pub async fn set(
    state: &crate::state::AppState,
    camera_id: String,
    compensation: bool,
) -> Result<CameraLowLightState, String> {
    if camera_id.trim().is_empty() {
        return Err("cameraId must name a camera.".to_string());
    }
    save_compensation(&state.database, &camera_id, compensation)
        .map_err(|error| format!("Low-light compensation was not saved: {error}"))?;
    let id = camera_id.clone();
    let database = state.database.clone();
    let device = tokio::task::spawn_blocking(move || write_stored(&database, &id))
        .await
        .unwrap_or_else(|error| DeviceLowLight::Unsupported(error.to_string()));
    match &device {
        DeviceLowLight::Holds { changed, .. } => tracing::info!(
            camera = %camera_id,
            compensation,
            changed,
            "Camera low-light compensation set"
        ),
        DeviceLowLight::Unsupported(reason) => tracing::info!(
            camera = %camera_id,
            compensation,
            "Camera low-light compensation saved, not written: {reason}"
        ),
    }
    Ok(state_for(&camera_id, compensation, &device))
}

/// Called as Videorc opens a camera: writes the stored choice to the device
/// on its own thread, so the camera's start never waits on it (a write while
/// FFmpeg already streams takes effect within a second).
pub fn apply_stored_on_open(database: &Database, camera_id: &str) {
    // Unit tests start cameras with made-up dshow names; they must never
    // write to a real camera on the machine running them.
    if cfg!(test) || crate::camera_capture::parse_windows_dshow_camera_id(camera_id).is_none() {
        return;
    }
    let database = database.clone();
    let camera_id = camera_id.to_string();
    let spawned = std::thread::Builder::new()
        .name("videorc-camera-low-light".to_string())
        .spawn(move || match write_stored(&database, &camera_id) {
            DeviceLowLight::Holds {
                compensation,
                changed,
            } => tracing::info!(
                camera = %camera_id,
                compensation,
                changed,
                "Camera low-light compensation applied"
            ),
            DeviceLowLight::Unsupported(reason) => tracing::info!(
                camera = %camera_id,
                "Camera low-light compensation not available: {reason}"
            ),
        });
    if let Err(error) = spawned {
        tracing::warn!("Camera low-light compensation thread did not start: {error}");
    }
}

#[cfg(not(target_os = "windows"))]
fn device_control(_camera_id: &str, _write: Option<bool>) -> DeviceLowLight {
    DeviceLowLight::Unsupported("Videorc sets low-light compensation on Windows only.".to_string())
}

#[cfg(target_os = "windows")]
fn device_control(camera_id: &str, write: Option<bool>) -> DeviceLowLight {
    let Some(device_name) = crate::camera_capture::parse_windows_dshow_camera_id(camera_id) else {
        return DeviceLowLight::Unsupported("Not a Windows camera.".to_string());
    };
    match windows_device::control(&device_name, write) {
        Ok(device) => device,
        Err(error) => DeviceLowLight::Unsupported(error),
    }
}

#[cfg(target_os = "windows")]
mod windows_device {
    use super::{DeviceLowLight, auto_exposure_priority_value, compensation_from_priority};
    use windows::Win32::Media::KernelStreaming::{
        IKsControl, KSIDENTIFIER, KSIDENTIFIER_0, KSIDENTIFIER_0_0,
        KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY, KSPROPERTY_CAMERACONTROL_FLAGS_MANUAL,
        KSPROPERTY_CAMERACONTROL_S, KSPROPERTY_TYPE_GET, KSPROPERTY_TYPE_SET,
        PROPSETID_VIDCAP_CAMERACONTROL,
    };
    use windows::Win32::Media::MediaFoundation::{
        IMFActivate, IMFMediaSource, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        MF_VERSION, MFCreateAttributes, MFEnumDeviceSources, MFSTARTUP_FULL, MFShutdown, MFStartup,
    };
    use windows::Win32::System::Com::{
        COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
    };
    use windows::core::Interface;

    struct ComScope(bool);

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    struct MediaFoundationScope;

    impl Drop for MediaFoundationScope {
        fn drop(&mut self) {
            let _ = unsafe { MFShutdown() };
        }
    }

    /// Every camera whose DirectShow friendly name is `device_name` (the name
    /// FFmpeg opens). Two identical cameras share a name; both get the write.
    pub(super) fn control(
        device_name: &str,
        write: Option<bool>,
    ) -> Result<DeviceLowLight, String> {
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let _com = ComScope(com.is_ok());
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
            .map_err(|error| format!("Media Foundation did not start: {error}"))?;
        let _media_foundation = MediaFoundationScope;

        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 1) }
            .map_err(|error| format!("Camera enumeration failed: {error}"))?;
        let attributes = attributes.ok_or("Camera enumeration returned no attributes.")?;
        unsafe {
            attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )
        }
        .map_err(|error| format!("Camera enumeration failed: {error}"))?;
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0;
        unsafe { MFEnumDeviceSources(&attributes, &mut activates, &mut count) }
            .map_err(|error| format!("Camera enumeration failed: {error}"))?;
        let mut matches = Vec::new();
        for index in 0..count {
            // Reading takes ownership, so every activate is released.
            if let Some(activate) = unsafe { activates.add(index as usize).read() }
                && friendly_name(&activate).as_deref() == Some(device_name)
            {
                matches.push(activate);
            }
        }
        unsafe { CoTaskMemFree(Some(activates.cast())) };

        if matches.is_empty() {
            return Err(format!("No camera named `{device_name}` is connected."));
        }
        let mut result = None;
        let mut last_error = None;
        for activate in matches {
            match control_one(&activate, write) {
                Ok(device) => {
                    result.get_or_insert(device);
                }
                Err(error) => last_error = Some(error),
            }
            let _ = unsafe { activate.ShutdownObject() };
        }
        result.ok_or_else(|| last_error.unwrap_or_default())
    }

    fn friendly_name(activate: &IMFActivate) -> Option<String> {
        let len =
            unsafe { activate.GetStringLength(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME) }.ok()?;
        let mut buffer = vec![0u16; len as usize + 1];
        let mut written = 0;
        unsafe {
            activate.GetString(
                &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                &mut buffer,
                Some(&mut written),
            )
        }
        .ok()?;
        let name = String::from_utf16_lossy(&buffer[..written as usize]);
        let name = name.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    fn control_one(activate: &IMFActivate, write: Option<bool>) -> Result<DeviceLowLight, String> {
        // The camera's frame server shares the device, so this opens it
        // beside a running FFmpeg capture without taking it over.
        let source: IMFMediaSource = unsafe { activate.ActivateObject() }
            .map_err(|error| format!("The camera did not open for its controls: {error}"))?;
        let outcome = source
            .cast::<IKsControl>()
            .map_err(|_| "The camera's driver exposes no camera controls.".to_string())
            .and_then(|control| {
                let current =
                    auto_exposure_priority(&control, KSPROPERTY_TYPE_GET, 0).map_err(|error| {
                        format!("The camera has no auto-exposure priority control: {error}")
                    })?;
                let current = compensation_from_priority(current);
                match write {
                    Some(wanted) if wanted != current => {
                        auto_exposure_priority(
                            &control,
                            KSPROPERTY_TYPE_SET,
                            auto_exposure_priority_value(wanted),
                        )
                        .map_err(|error| {
                            format!("The camera refused its auto-exposure priority: {error}")
                        })?;
                        Ok(DeviceLowLight::Holds {
                            compensation: wanted,
                            changed: true,
                        })
                    }
                    _ => Ok(DeviceLowLight::Holds {
                        compensation: current,
                        changed: false,
                    }),
                }
            });
        let _ = unsafe { source.Shutdown() };
        outcome
    }

    fn auto_exposure_priority(
        control: &IKsControl,
        kind: u32,
        value: i32,
    ) -> windows::core::Result<i32> {
        let property = KSPROPERTY_CAMERACONTROL_S {
            Property: KSIDENTIFIER {
                Anonymous: KSIDENTIFIER_0 {
                    Anonymous: KSIDENTIFIER_0_0 {
                        Set: PROPSETID_VIDCAP_CAMERACONTROL,
                        Id: KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY.0 as u32,
                        Flags: kind,
                    },
                },
            },
            Value: value,
            Flags: KSPROPERTY_CAMERACONTROL_FLAGS_MANUAL as u32,
            Capabilities: 0,
        };
        let mut data = property;
        let size = std::mem::size_of::<KSPROPERTY_CAMERACONTROL_S>() as u32;
        let mut returned = 0u32;
        unsafe {
            control.KsProperty(
                &property.Property,
                size,
                (&mut data as *mut KSPROPERTY_CAMERACONTROL_S).cast(),
                size,
                &mut returned,
            )
        }?;
        Ok(data.Value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CameraLowLightParams, CameraLowLightSetParams};

    /// The shared wire fixture; the renderer's contract test reads it too.
    #[test]
    fn camera_low_light_fixture_matches_the_backend_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-low-light.json"
        ))
        .expect("protocol-fixtures/camera-low-light.json is valid JSON");
        let camera_id = fixture["getParams"]["cameraId"].as_str().unwrap();
        assert_eq!(
            crate::camera_capture::parse_windows_dshow_camera_id(camera_id).as_deref(),
            Some("HP HD Camera")
        );

        let get: CameraLowLightParams =
            serde_json::from_value(fixture["getParams"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&get).unwrap(), fixture["getParams"]);
        let set: CameraLowLightSetParams =
            serde_json::from_value(fixture["setParams"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&set).unwrap(), fixture["setParams"]);

        let holds = DeviceLowLight::Holds {
            compensation: false,
            changed: false,
        };
        assert_eq!(
            serde_json::to_value(state_for(camera_id, false, &holds)).unwrap(),
            fixture["keepsFrameRate"]
        );
        assert_eq!(
            serde_json::to_value(state_for(camera_id, true, &holds)).unwrap(),
            fixture["compensating"]
        );
        let unsupported = DeviceLowLight::Unsupported("off Windows".to_string());
        assert_eq!(
            serde_json::to_value(state_for("camera:avfoundation:0", false, &unsupported)).unwrap(),
            fixture["unsupported"]
        );

        // Shape errors fail to parse; an empty id parses and `set` refuses it.
        for bad in fixture["rejectedParams"].as_array().unwrap() {
            let parsed = serde_json::from_value::<CameraLowLightParams>(bad.clone());
            assert!(
                parsed.is_err() || parsed.unwrap().camera_id.is_empty(),
                "{bad}"
            );
        }
        for bad in fixture["rejectedSetParams"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<CameraLowLightSetParams>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_control_value_lets_exposure_lower_the_rate_only_when_compensation_is_on() {
        assert_eq!(auto_exposure_priority_value(true), 1);
        assert_eq!(auto_exposure_priority_value(false), 0);
        assert!(compensation_from_priority(1));
        assert!(!compensation_from_priority(0));
    }

    #[test]
    fn a_camera_with_no_entry_keeps_its_frame_rate() {
        let database = Database::open_in_memory_for_tests();
        assert!(!stored_compensation(&database, "camera:windows-dshow:00"));
    }

    #[test]
    fn the_choice_is_kept_per_camera_and_off_removes_the_entry() {
        let database = Database::open_in_memory_for_tests();
        save_compensation(&database, "camera:windows-dshow:aa", true).unwrap();
        save_compensation(&database, "camera:windows-dshow:bb", false).unwrap();
        assert!(stored_compensation(&database, "camera:windows-dshow:aa"));
        assert!(!stored_compensation(&database, "camera:windows-dshow:bb"));

        save_compensation(&database, "camera:windows-dshow:aa", false).unwrap();
        let prefs: LowLightPrefs = database
            .load_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY)
            .unwrap()
            .unwrap();
        assert!(prefs.is_empty(), "{prefs:?}");
    }

    #[test]
    fn unreadable_settings_fall_back_to_keeping_the_frame_rate() {
        let database = Database::open_in_memory_for_tests();
        database
            .save_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY, &"not a map")
            .unwrap();
        assert!(!stored_compensation(&database, "camera:windows-dshow:aa"));
    }

    #[test]
    fn the_state_reports_support_from_the_device() {
        let held = DeviceLowLight::Holds {
            compensation: false,
            changed: true,
        };
        let state = state_for("camera:windows-dshow:aa", true, &held);
        assert!(state.supported);
        assert!(state.compensation);
        let missing = DeviceLowLight::Unsupported("no control".to_string());
        assert!(!state_for("camera:windows-dshow:aa", false, &missing).supported);
    }

    /// On a Windows box with a UVC camera that has the control:
    /// `VIDEORC_LOW_LIGHT_CAMERA="HP HD Camera" cargo test -p videorc-backend
    /// camera_low_light_on_box -- --ignored`. Flips the camera's control,
    /// reads it back from a fresh open, and puts the original value back.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real camera named by VIDEORC_LOW_LIGHT_CAMERA"]
    fn camera_low_light_on_box_round_trip() {
        let name = std::env::var("VIDEORC_LOW_LIGHT_CAMERA")
            .expect("set VIDEORC_LOW_LIGHT_CAMERA to the camera's name");
        let id = crate::camera_capture::windows_dshow_camera_device_id(&name);
        let DeviceLowLight::Holds {
            compensation: original,
            ..
        } = read_device(&id)
        else {
            panic!("{name} has no low-light control: {:?}", read_device(&id));
        };
        let flipped = write_device(&id, !original);
        let reread = read_device(&id);
        let again = write_device(&id, !original);
        let restored = write_device(&id, original);
        assert_eq!(
            flipped,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: true
            }
        );
        assert_eq!(
            reread,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: false
            },
            "a fresh open must see the write"
        );
        assert_eq!(
            again,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: false
            },
            "an unchanged value is not written twice"
        );
        assert_eq!(
            restored,
            DeviceLowLight::Holds {
                compensation: original,
                changed: true
            }
        );
    }

    #[test]
    fn non_windows_camera_ids_are_never_written() {
        // An AVFoundation or V4L2 id has no dshow name; the Windows path
        // refuses it and other platforms refuse every id.
        assert!(!read_device("camera:avfoundation:0").supported());
    }
}
