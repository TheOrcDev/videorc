//! Plan 220 S3.1c: the source choice as the renderer makes it, over the
//! capture config's `sources` object (the JSON Electron stores, S3.0d):
//! `lib/capture.ts`'s pickers and builders (`capturePickerDevices`,
//! `buildCaptureSources`, `buildCameraSources`, `mergeSourceKind`), the
//! reconcile every device list runs (`reconcileSourceSelection`, with plan
//! 213 E1's stand-ins), what a stand-in says (`sourceStandIn`,
//! `standInLine`), the fallbacks a reconcile makes
//! (`sourceSelectionChangeEvents`), the device picker's words
//! (`lib/source-select-state.ts`) and the sources-off start reason
//! (`sceneSourcesTurnedOff`, `sceneSourceOffBlockedReason`).
//!
//! An `undefined` field in the renderer is an absent key here; every
//! function keeps its TypeScript name in its doc line.

use serde_json::{Map, Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::js_value::{get, string, truthy};
use crate::scenes::model::{GapSource, GapState, find_remembered_source, scene_source_gaps};

/// `SessionSourceKind`: what one picker chooses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Capture,
    Camera,
    Microphone,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Camera => "camera",
            Self::Microphone => "microphone",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "capture" => Some(Self::Capture),
            "camera" => Some(Self::Camera),
            "microphone" => Some(Self::Microphone),
            _ => None,
        }
    }
}

// ── Which devices a picker offers ────────────────────────────────────────

/// `isNativeScreenSourceId`.
pub fn is_native_screen_source_id(id: &str) -> bool {
    id.starts_with("screen:screencapturekit:")
        || id.starts_with("screen:dxgi:")
        || id == "screen:gdigrab:desktop"
}

/// `isNativeWindowSourceId`.
pub fn is_native_window_source_id(id: &str) -> bool {
    id.starts_with("window:screencapturekit:")
}

/// `PORTAL_MONITOR_SOURCE_ID` and `PORTAL_WINDOW_SOURCE_ID`.
pub const PORTAL_MONITOR_SOURCE_ID: &str = "screen:portal:monitor";
pub const PORTAL_WINDOW_SOURCE_ID: &str = "window:portal:window";

/// `isPreviewFeedableScreenSourceId`.
pub fn is_preview_feedable_screen_source_id(id: &str) -> bool {
    is_native_screen_source_id(id) || id == PORTAL_MONITOR_SOURCE_ID
}

/// `isPreviewFeedableWindowSourceId`.
pub fn is_preview_feedable_window_source_id(id: &str) -> bool {
    is_native_window_source_id(id) || id == PORTAL_WINDOW_SOURCE_ID
}

fn is_av_foundation_screen_source_id(id: &str) -> bool {
    id.starts_with("screen:avfoundation:")
}

/// `isAvFoundationMicrophoneId`.
pub fn is_av_foundation_microphone_id(id: &str) -> bool {
    id.starts_with("microphone:avfoundation:")
}

const SCREEN_CAPTUREKIT_STATUS_IDS: [&str; 4] = [
    "screen:screencapturekit-permission",
    "screen:screencapturekit-unavailable",
    "screen:screencapturekit-timeout",
    "screen:screencapturekit-missing",
];
const WINDOW_CAPTUREKIT_STATUS_IDS: [&str; 4] = [
    "window:screencapturekit-permission",
    "window:screencapturekit-unavailable",
    "window:screencapturekit-timeout",
    "window:screencapturekit-missing",
];

/// `isNativeCaptureDevice`.
pub fn is_native_capture_device(device: &Device) -> bool {
    (device.kind == DeviceKind::Screen && is_native_screen_source_id(&device.id))
        || (device.kind == DeviceKind::Window && is_native_window_source_id(&device.id))
}

/// `isPortalCaptureDevice`.
pub fn is_portal_capture_device(device: &Device) -> bool {
    (device.kind == DeviceKind::Screen && device.id == PORTAL_MONITOR_SOURCE_ID)
        || (device.kind == DeviceKind::Window && device.id == PORTAL_WINDOW_SOURCE_ID)
}

fn is_av_foundation_screen_capture_device(device: &Device) -> bool {
    device.kind == DeviceKind::Screen && is_av_foundation_screen_source_id(&device.id)
}

/// `isScreenCaptureKitCaptureDevice`.
pub fn is_screen_capture_kit_capture_device(device: &Device) -> bool {
    (device.kind == DeviceKind::Screen
        && (is_native_screen_source_id(&device.id)
            || SCREEN_CAPTUREKIT_STATUS_IDS.contains(&device.id.as_str())))
        || (device.kind == DeviceKind::Window
            && (is_native_window_source_id(&device.id)
                || WINDOW_CAPTUREKIT_STATUS_IDS.contains(&device.id.as_str())))
}

/// `isSystemSessionWindowDevice`: the macOS login window belongs to another
/// GUI session; capturing it aborts the backend (F-013). Never offered.
pub fn is_system_session_window_device(device: &Device) -> bool {
    device.kind == DeviceKind::Window && device.name == "loginwindow"
}

fn available(device: &Device) -> bool {
    device.status == DeviceStatus::Available
}

/// `capturePickerDevices`: ScreenCaptureKit's screens and windows (the
/// login window never), else the portal's, else the legacy avfoundation
/// screens.
pub fn capture_picker_devices(devices: &[Device]) -> Vec<&Device> {
    let sck: Vec<&Device> = devices
        .iter()
        .filter(|device| is_screen_capture_kit_capture_device(device))
        .filter(|device| !is_system_session_window_device(device))
        .collect();
    if sck
        .iter()
        .any(|device| available(device) && is_native_capture_device(device))
    {
        return sck;
    }
    let portal: Vec<&Device> = devices
        .iter()
        .filter(|device| is_portal_capture_device(device))
        .collect();
    if portal.iter().any(|device| available(device)) {
        return portal;
    }
    let legacy = devices
        .iter()
        .filter(|device| is_av_foundation_screen_capture_device(device));
    if !sck.is_empty() {
        return sck.into_iter().chain(legacy).collect();
    }
    legacy.collect()
}

/// The cameras a picker offers (`deviceList.devices` of kind camera).
pub fn camera_picker_devices(devices: &[Device]) -> Vec<&Device> {
    devices
        .iter()
        .filter(|device| device.kind == DeviceKind::Camera)
        .collect()
}

/// `microphonePickerDevices`: the avfoundation rows only when no native
/// input exists at all.
pub fn microphone_picker_devices(devices: &[Device]) -> Vec<&Device> {
    let microphones: Vec<&Device> = devices
        .iter()
        .filter(|device| device.kind == DeviceKind::Microphone)
        .collect();
    let native: Vec<&Device> = microphones
        .iter()
        .copied()
        .filter(|device| !is_av_foundation_microphone_id(&device.id))
        .collect();
    if native.is_empty() {
        microphones
    } else {
        native
    }
}

// ── The builders a pick writes ───────────────────────────────────────────

fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => map.insert(key.to_string(), value),
        None => map.remove(key),
    };
}

fn object(sources: &Value) -> Map<String, Value> {
    sources.as_object().cloned().unwrap_or_default()
}

fn text_of(sources: &Value, key: &str) -> Option<String> {
    string(get(Some(sources), key))
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// `buildCaptureSources`: a screen or window by id (or None), every
/// stand-in's pick replaced, the test pattern off and the scene's app gone.
pub fn build_capture_sources(
    current: &Value,
    capture_devices: &[&Device],
    capture_id: Option<&str>,
) -> Value {
    let selected = capture_id.and_then(|id| capture_devices.iter().find(|device| device.id == id));
    let mut next = object(current);
    next.remove("app");
    let screen = selected.filter(|device| device.kind == DeviceKind::Screen);
    let window = selected.filter(|device| device.kind == DeviceKind::Window);
    put(
        &mut next,
        "screenId",
        screen.and(capture_id).map(|id| json!(id)),
    );
    put(
        &mut next,
        "screenName",
        screen.map(|device| json!(device.name)),
    );
    put(
        &mut next,
        "screenUuid",
        screen.and_then(|device| device.display_uuid.as_ref().map(|uuid| json!(uuid))),
    );
    put(
        &mut next,
        "windowId",
        window.and(capture_id).map(|id| json!(id)),
    );
    put(
        &mut next,
        "windowName",
        window.map(|device| json!(device.name)),
    );
    put(
        &mut next,
        "captureOff",
        capture_id.is_none().then_some(json!(true)),
    );
    for key in [
        "wantedScreenId",
        "wantedScreenName",
        "wantedScreenUuid",
        "wantedWindowId",
        "wantedWindowName",
    ] {
        next.remove(key);
    }
    next.insert("testPattern".into(), json!(false));
    Value::Object(next)
}

/// `buildCameraSources`: a camera by id, or Off (a choice that outlives
/// reconcile, plan 080 S4); either way the stand-in's pick goes.
pub fn build_camera_sources(
    current: &Value,
    cameras: &[&Device],
    camera_id: Option<&str>,
) -> Value {
    let mut next = object(current);
    next.remove("wantedCameraId");
    next.remove("wantedCameraName");
    match camera_id {
        Some(id) => {
            let name = cameras
                .iter()
                .find(|device| device.id == id)
                .map(|device| json!(device.name));
            next.insert("cameraId".into(), json!(id));
            put(&mut next, "cameraName", name);
            next.remove("cameraOff");
        }
        None => {
            next.remove("cameraId");
            next.remove("cameraName");
            next.insert("cameraOff".into(), json!(true));
        }
    }
    Value::Object(next)
}

/// `buildMicrophoneSources`: a microphone by id, or None (plan 0027).
pub fn build_microphone_sources(
    current: &Value,
    microphones: &[&Device],
    microphone_id: Option<&str>,
) -> Value {
    let mut next = object(current);
    match microphone_id {
        Some(id) => {
            let name = microphones
                .iter()
                .find(|device| device.id == id)
                .map(|device| json!(device.name));
            next.insert("microphoneId".into(), json!(id));
            put(&mut next, "microphoneName", name);
            next.remove("microphoneOff");
        }
        None => {
            next.remove("microphoneId");
            next.remove("microphoneName");
            next.insert("microphoneOff".into(), json!(true));
        }
    }
    Value::Object(next)
}

/// `SOURCE_KIND_FIELDS`: the fields one picker owns.
pub fn source_kind_fields(kind: SourceKind) -> &'static [&'static str] {
    match kind {
        SourceKind::Capture => &[
            "screenId",
            "screenName",
            "screenUuid",
            "windowId",
            "windowName",
            "captureOff",
            "testPattern",
            "wantedScreenId",
            "wantedScreenName",
            "wantedScreenUuid",
            "wantedWindowId",
            "wantedWindowName",
        ],
        SourceKind::Camera => &[
            "cameraId",
            "cameraName",
            "cameraOff",
            "wantedCameraId",
            "wantedCameraName",
        ],
        SourceKind::Microphone => &["microphoneId", "microphoneName", "microphoneOff"],
    }
}

/// `mergeSourceKind`: only the picked kind's fields onto the latest
/// selection, so a pick built from an older snapshot never reverts another
/// update.
pub fn merge_source_kind(current: &Value, picked: &Value, kind: SourceKind) -> Value {
    let mut next = object(current);
    if kind == SourceKind::Capture {
        next.remove("app");
    }
    for field in source_kind_fields(kind) {
        put(&mut next, field, get(Some(picked), field).cloned());
    }
    Value::Object(next)
}

// ── Reconcile ────────────────────────────────────────────────────────────

/// `ReconcileSourceSelectionOptions`.
#[derive(Debug, Clone, Default)]
pub struct ReconcileOptions {
    /// Plan 213 D6: during a session a stand-in stays until a click.
    pub hold_stand_ins: bool,
    /// A running disconnected camera keeps its last frame until it returns.
    pub disconnected_camera_id: Option<String>,
    /// S3.1c: no first screen, camera or microphone for a slot nobody chose
    /// (a remembered pick is still found again). The smoke harness: the
    /// Rust app inherits the terminal's camera, microphone and Screen
    /// Recording grants, which Electron's dev app does not have, so a fresh
    /// smoke profile must not open the owner's real devices on its own.
    pub withhold_defaults: bool,
}

/// `WantedSource`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Wanted {
    kind: DeviceKind,
    id: Option<String>,
    name: Option<String>,
    display_uuid: Option<String>,
    stand_in: bool,
}

/// `wantedCapture`: the pick a stand-in holds for, else the one in use.
fn wanted_capture(sources: &Value) -> Wanted {
    let field = |key: &str| text_of(sources, key);
    if field("wantedWindowId").is_some() || field("wantedWindowName").is_some() {
        return Wanted {
            kind: DeviceKind::Window,
            id: field("wantedWindowId"),
            name: field("wantedWindowName"),
            display_uuid: None,
            stand_in: true,
        };
    }
    if field("wantedScreenId").is_some() || field("wantedScreenName").is_some() {
        return Wanted {
            kind: DeviceKind::Screen,
            id: field("wantedScreenId"),
            name: field("wantedScreenName"),
            display_uuid: field("wantedScreenUuid"),
            stand_in: true,
        };
    }
    if let Some(window) = field("windowId") {
        return Wanted {
            kind: DeviceKind::Window,
            id: Some(window),
            name: field("windowName"),
            display_uuid: None,
            stand_in: false,
        };
    }
    let picked = field("screenId").is_some() || field("screenName").is_some();
    Wanted {
        kind: DeviceKind::Screen,
        id: field("screenId"),
        name: field("screenName"),
        display_uuid: picked.then(|| field("screenUuid")).flatten(),
        stand_in: false,
    }
}

/// `wantedCamera`.
fn wanted_camera(sources: &Value) -> Wanted {
    let field = |key: &str| text_of(sources, key);
    if field("wantedCameraId").is_some() || field("wantedCameraName").is_some() {
        Wanted {
            kind: DeviceKind::Camera,
            id: field("wantedCameraId"),
            name: field("wantedCameraName"),
            display_uuid: None,
            stand_in: true,
        }
    } else {
        Wanted {
            kind: DeviceKind::Camera,
            id: field("cameraId"),
            name: field("cameraName"),
            display_uuid: None,
            stand_in: false,
        }
    }
}

const FALLBACK_MICROPHONE_NAME_PREFIX: &str = "Fallback - ";

/// `nativeMicrophoneNameFor`.
fn native_microphone_name_for(name: Option<&str>) -> Option<&str> {
    name.map(|name| {
        name.strip_prefix(FALLBACK_MICROPHONE_NAME_PREFIX)
            .unwrap_or(name)
    })
}

/// `reconcileSourceSelection`: the selection against a device list. A
/// remembered device is found by its display UUID, id or name; a pick that
/// is gone keeps its place as the pick (`wanted*`) while the first device of
/// its kind stands in; an explicit None or Off stays; the test pattern
/// holds the screen empty; a profile that never chose gets the first
/// screen, camera and microphone. An empty list (no answer yet) changes
/// nothing.
pub fn reconcile_source_selection(
    sources: &Value,
    devices: &[Device],
    options: &ReconcileOptions,
) -> Value {
    let mut next = object(sources);
    if devices.is_empty() {
        return Value::Object(next);
    }
    let sck: Vec<&Device> = devices
        .iter()
        .filter(|device| is_screen_capture_kit_capture_device(device))
        .filter(|device| !is_system_session_window_device(device))
        .collect();
    let capture_devices: Vec<&Device> = devices
        .iter()
        .filter(|device| {
            matches!(device.kind, DeviceKind::Screen | DeviceKind::Window) && available(device)
        })
        .collect();
    let native: Vec<&Device> = sck
        .iter()
        .copied()
        .filter(|device| available(device) && is_native_capture_device(device))
        .collect();
    let portal: Vec<&Device> = devices
        .iter()
        .filter(|device| available(device) && is_portal_capture_device(device))
        .collect();
    let legacy: Vec<&Device> = if native.is_empty() && portal.is_empty() {
        capture_devices
            .iter()
            .copied()
            .filter(|device| is_av_foundation_screen_capture_device(device))
            .collect()
    } else {
        Vec::new()
    };
    let selectable = if !native.is_empty() {
        native
    } else if !portal.is_empty() {
        portal
    } else {
        legacy
    };
    let cameras: Vec<&Device> = devices
        .iter()
        .filter(|device| device.kind == DeviceKind::Camera && available(device))
        .collect();
    let microphones: Vec<&Device> = microphone_picker_devices(devices)
        .into_iter()
        .filter(|device| available(device))
        .collect();
    // Never auto-default to a window (F-013): a display or nothing.
    let default_capture = selectable
        .iter()
        .copied()
        .find(|device| device.kind == DeviceKind::Screen)
        .filter(|_| !options.withhold_defaults);

    let sources_value = Value::Object(next.clone());
    let field = |key: &str| text_of(&sources_value, key);
    if truthy(get(Some(&sources_value), "testPattern")) {
        for key in [
            "screenId",
            "screenName",
            "screenUuid",
            "windowId",
            "windowName",
        ] {
            next.remove(key);
        }
    } else if get(Some(&sources_value), "captureOff") == Some(&Value::Bool(true))
        && field("screenId").is_none()
        && field("windowId").is_none()
    {
        // Plan 0002: an explicit None stays None.
        next.remove("screenName");
        next.remove("screenUuid");
        next.remove("windowName");
    } else {
        let pick = wanted_capture(&sources_value);
        let using_id = field("windowId").or_else(|| field("screenId"));
        let holding = options.hold_stand_ins && pick.stand_in;
        let held = holding
            .then(|| {
                selectable
                    .iter()
                    .copied()
                    .find(|device| Some(&device.id) == using_id.as_ref())
            })
            .flatten();
        let of_kind: Vec<&Device> = selectable
            .iter()
            .copied()
            .filter(|device| device.kind == pick.kind)
            .collect();
        let remembered = held.or_else(|| {
            find_remembered_source(
                pick.id.as_deref(),
                pick.name.as_deref(),
                &of_kind,
                pick.display_uuid.as_deref(),
            )
        });
        let selected = if holding {
            selectable
                .iter()
                .copied()
                .find(|device| Some(&device.id) == using_id.as_ref())
        } else {
            remembered.or(default_capture)
        };
        let stand_in =
            holding || (remembered.is_none() && (pick.id.is_some() || pick.name.is_some()));
        let screen = selected.filter(|device| device.kind == DeviceKind::Screen);
        let window = selected.filter(|device| device.kind == DeviceKind::Window);
        put(&mut next, "screenId", screen.map(|device| json!(device.id)));
        put(
            &mut next,
            "screenName",
            screen.map(|device| json!(device.name)),
        );
        put(
            &mut next,
            "screenUuid",
            screen.and_then(|device| device.display_uuid.as_ref().map(|uuid| json!(uuid))),
        );
        put(&mut next, "windowId", window.map(|device| json!(device.id)));
        put(
            &mut next,
            "windowName",
            window.map(|device| json!(device.name)),
        );
        next.remove("captureOff");
        let wanted_screen = stand_in && pick.kind == DeviceKind::Screen;
        let wanted_window = stand_in && pick.kind == DeviceKind::Window;
        put(
            &mut next,
            "wantedScreenId",
            pick.id.clone().filter(|_| wanted_screen).map(Value::String),
        );
        put(
            &mut next,
            "wantedScreenName",
            pick.name
                .clone()
                .filter(|_| wanted_screen)
                .map(Value::String),
        );
        put(
            &mut next,
            "wantedScreenUuid",
            pick.display_uuid
                .clone()
                .filter(|_| wanted_screen)
                .map(Value::String),
        );
        put(
            &mut next,
            "wantedWindowId",
            pick.id.clone().filter(|_| wanted_window).map(Value::String),
        );
        put(
            &mut next,
            "wantedWindowName",
            pick.name
                .clone()
                .filter(|_| wanted_window)
                .map(Value::String),
        );
    }

    // Plan 080 S4: an explicit Off stays off; a vanished pick stays the pick
    // behind its stand-in (plan 213 E1).
    let camera_id = field("cameraId");
    let camera_off =
        get(Some(&sources_value), "cameraOff") == Some(&Value::Bool(true)) && camera_id.is_none();
    let camera_pick = wanted_camera(&sources_value);
    let holding_camera = options.hold_stand_ins && camera_pick.stand_in && !camera_off;
    let held_camera = holding_camera
        .then(|| {
            cameras
                .iter()
                .copied()
                .find(|device| Some(&device.id) == camera_id.as_ref())
        })
        .flatten();
    let remembered_camera = if camera_off {
        None
    } else {
        held_camera.or_else(|| {
            find_remembered_source(
                camera_pick.id.as_deref(),
                camera_pick.name.as_deref(),
                &cameras,
                None,
            )
        })
    };
    let disconnected = camera_id.is_some()
        && options.disconnected_camera_id == camera_id
        && (holding_camera || !camera_pick.stand_in || remembered_camera.is_none());
    let (selected_camera_id, selected_camera_name): (Option<String>, Option<String>) = if camera_off
    {
        (None, None)
    } else if disconnected {
        (
            camera_id.clone(),
            Some(field("cameraName").unwrap_or_else(|| "Camera".to_string())),
        )
    } else {
        let device = if holding_camera {
            cameras
                .iter()
                .copied()
                .find(|device| Some(&device.id) == camera_id.as_ref())
        } else {
            remembered_camera.or_else(|| {
                (!options.withhold_defaults)
                    .then(|| cameras.first().copied())
                    .flatten()
            })
        };
        (
            device.map(|device| device.id.clone()),
            device.map(|device| device.name.clone()),
        )
    };
    let camera_stand_in = !camera_off
        && (holding_camera
            || if disconnected {
                camera_pick.stand_in
            } else {
                remembered_camera.is_none()
                    && (camera_pick.id.is_some() || camera_pick.name.is_some())
            });
    put(&mut next, "cameraOff", camera_off.then_some(json!(true)));
    put(
        &mut next,
        "wantedCameraId",
        camera_pick
            .id
            .clone()
            .filter(|_| camera_stand_in)
            .map(Value::String),
    );
    put(
        &mut next,
        "wantedCameraName",
        camera_pick
            .name
            .clone()
            .filter(|_| camera_stand_in)
            .map(Value::String),
    );

    // The retired "Fallback - X" rows: a native row by the unprefixed name.
    let native_microphone = microphones
        .iter()
        .any(|device| !is_av_foundation_microphone_id(&device.id));
    let microphone_id = field("microphoneId");
    let remembered_microphone_id = microphone_id
        .clone()
        .filter(|id| !(native_microphone && is_av_foundation_microphone_id(id)));
    let microphone_off = get(Some(&sources_value), "microphoneOff") == Some(&Value::Bool(true))
        && microphone_id.is_none();
    let microphone_name = field("microphoneName");
    let selected_microphone = if microphone_off {
        None
    } else {
        find_remembered_source(
            remembered_microphone_id.as_deref(),
            native_microphone_name_for(microphone_name.as_deref()),
            &microphones,
            None,
        )
        .or_else(|| {
            (!options.withhold_defaults)
                .then(|| microphones.first().copied())
                .flatten()
        })
    };
    put(
        &mut next,
        "microphoneOff",
        microphone_off.then_some(json!(true)),
    );
    put(&mut next, "cameraId", selected_camera_id.map(Value::String));
    put(
        &mut next,
        "cameraName",
        selected_camera_name.map(Value::String),
    );
    put(
        &mut next,
        "microphoneId",
        selected_microphone.map(|device| json!(device.id)),
    );
    put(
        &mut next,
        "microphoneName",
        selected_microphone.map(|device| json!(device.name)),
    );
    Value::Object(next)
}

// ── A reopened window at Record (plan 219 S3) ────────────────────────────

/// `shouldRefreshWindowListBeforeStart`: a picked ScreenCaptureKit window
/// that the preview's screen capture is not already live on (the window may
/// have been closed and reopened under a new id). `preview_screen` is
/// `preview.screen.status` as the telemetry holds it.
pub fn should_refresh_window_list_before_start(
    sources: &Value,
    preview_screen: Option<&Value>,
) -> bool {
    let Some(window) = text_of(sources, "windowId").filter(|id| is_native_window_source_id(id))
    else {
        return false;
    };
    let live = preview_screen.is_some_and(|status| {
        status.get("state").and_then(Value::as_str) == Some("live")
            && status.get("sourceId").and_then(Value::as_str) == Some(window.as_str())
    });
    !live
}

/// `rebindRememberedWindow`: the window pick under its new id (by its id,
/// then its exact name), or `None` when it is not a window, is listed under
/// its id, or has no match. Never a display or another app's window: a
/// window pick is a privacy promise.
pub fn rebind_remembered_window(sources: &Value, devices: &[Device]) -> Option<(String, String)> {
    let window = text_of(sources, "windowId").filter(|id| is_native_window_source_id(id))?;
    let windows: Vec<&Device> = devices
        .iter()
        .filter(|device| {
            device.kind == DeviceKind::Window
                && available(device)
                && is_native_window_source_id(&device.id)
        })
        .collect();
    let found = find_remembered_source(
        Some(&window),
        text_of(sources, "windowName").as_deref(),
        &windows,
        None,
    )?;
    (found.kind == DeviceKind::Window && found.id != window)
        .then(|| (found.id.clone(), found.name.clone()))
}

// ── Stand-ins ────────────────────────────────────────────────────────────

/// `SourceStandIn`: the pick isn't connected and another source stands in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStandIn {
    pub kind: DeviceKind,
    pub wanted_name: Option<String>,
    pub using_name: Option<String>,
    pub available: bool,
}

/// `sourceStandIn`.
pub fn source_stand_in(
    sources: &Value,
    kind: SourceKind,
    devices: &[Device],
) -> Option<SourceStandIn> {
    let pick = if kind == SourceKind::Camera {
        wanted_camera(sources)
    } else {
        wanted_capture(sources)
    };
    if !pick.stand_in {
        return None;
    }
    let using_name = if kind == SourceKind::Camera {
        text_of(sources, "cameraName")
    } else {
        text_of(sources, "screenName").or_else(|| text_of(sources, "windowName"))
    };
    let of_kind: Vec<&Device> = devices
        .iter()
        .filter(|device| device.kind == pick.kind && available(device))
        .collect();
    let available = find_remembered_source(
        pick.id.as_deref(),
        pick.name.as_deref(),
        &of_kind,
        pick.display_uuid.as_deref(),
    )
    .is_some();
    Some(SourceStandIn {
        kind: pick.kind,
        wanted_name: pick.name,
        using_name,
        available,
    })
}

/// `standInLine`: "Studio Display isn't connected · using Built-in Display".
pub fn stand_in_line(stand_in: &SourceStandIn) -> String {
    let noun = match stand_in.kind {
        DeviceKind::Camera => "camera",
        DeviceKind::Window => "window",
        _ => "screen",
    };
    let wanted = stand_in
        .wanted_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or_else(|| format!("Your {noun}"), str::to_string);
    let missing = if stand_in.available {
        "is back"
    } else if stand_in.kind == DeviceKind::Window {
        "isn't open"
    } else {
        "isn't connected"
    };
    match stand_in
        .using_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(using) => format!("{wanted} {missing} · using {using}"),
        None => format!("{wanted} {missing}"),
    }
}

/// `returningSourceChoices`: each stand-in's pick (camera, screen or
/// window) that is listed again, found by its display UUID, id or name.
pub fn returning_source_choices(sources: &Value, devices: &[Device]) -> Vec<(SourceKind, Device)> {
    let mut choices = Vec::new();
    for kind in [SourceKind::Camera, SourceKind::Capture] {
        let (id, name, device_kind) = if kind == SourceKind::Camera {
            (
                text_of(sources, "wantedCameraId"),
                text_of(sources, "wantedCameraName"),
                DeviceKind::Camera,
            )
        } else {
            let window = text_of(sources, "wantedWindowId").is_some()
                || text_of(sources, "wantedWindowName").is_some();
            (
                text_of(sources, "wantedWindowId").or_else(|| text_of(sources, "wantedScreenId")),
                text_of(sources, "wantedWindowName")
                    .or_else(|| text_of(sources, "wantedScreenName")),
                if window {
                    DeviceKind::Window
                } else {
                    DeviceKind::Screen
                },
            )
        };
        if id.is_none() && name.is_none() {
            continue;
        }
        let listed: Vec<&Device> = devices
            .iter()
            .filter(|device| device.kind == device_kind && available(device))
            .collect();
        let uuid = (device_kind == DeviceKind::Screen)
            .then(|| text_of(sources, "wantedScreenUuid"))
            .flatten();
        if let Some(device) =
            find_remembered_source(id.as_deref(), name.as_deref(), &listed, uuid.as_deref())
        {
            choices.push((kind, device.clone()));
        }
    }
    choices
}

// ── The fallbacks a reconcile makes ──────────────────────────────────────

/// `AutomaticSourceFallbackEvent['reason']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    UnavailableCleared,
    WantedRestored,
    RestoredByName,
    UnavailableSelected,
}

impl FallbackReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnavailableCleared => "unavailable-cleared",
            Self::WantedRestored => "wanted-restored",
            Self::RestoredByName => "restored-by-name",
            Self::UnavailableSelected => "unavailable-selected",
        }
    }
}

/// `AutomaticSourceFallbackEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFallback {
    pub kind: SourceKind,
    pub reason: FallbackReason,
    pub previous_id: Option<String>,
    pub previous_name: Option<String>,
    pub next_id: Option<String>,
    pub next_name: Option<String>,
}

fn source_change(
    kind: SourceKind,
    previous: (Option<String>, Option<String>),
    next: (Option<String>, Option<String>),
    wanted_id: Option<String>,
) -> Option<SourceFallback> {
    let (previous_id, previous_name) = previous;
    let (next_id, next_name) = next;
    if previous_id.is_none() && previous_name.is_none() {
        return None;
    }
    if previous_id == next_id && (previous_id.is_some() || previous_name == next_name) {
        return None;
    }
    let reason = if next_id.is_none() && next_name.is_none() {
        FallbackReason::UnavailableCleared
    } else if wanted_id.is_some() && next_id == wanted_id {
        FallbackReason::WantedRestored
    } else if previous_name.is_some() && previous_name == next_name && previous_id != next_id {
        FallbackReason::RestoredByName
    } else {
        FallbackReason::UnavailableSelected
    };
    Some(SourceFallback {
        kind,
        reason,
        previous_id,
        previous_name,
        next_id,
        next_name,
    })
}

/// `sourceSelectionChangeEvents`: what a reconcile changed for the
/// streamer, in the log's words (the same display under a new id is no
/// change, plan 213 F1).
pub fn source_selection_change_events(previous: &Value, next: &Value) -> Vec<SourceFallback> {
    let field = |sources: &Value, key: &str| text_of(sources, key);
    let same_display = field(previous, "windowId").is_none()
        && field(next, "windowId").is_none()
        && field(previous, "screenUuid").is_some()
        && field(previous, "screenUuid") == field(next, "screenUuid");
    let capture = |sources: &Value| {
        (
            field(sources, "windowId").or_else(|| field(sources, "screenId")),
            field(sources, "windowName").or_else(|| field(sources, "screenName")),
        )
    };
    let pair = |sources: &Value, id: &str, name: &str| (field(sources, id), field(sources, name));
    let mut events = Vec::new();
    if !same_display {
        events.extend(source_change(
            SourceKind::Capture,
            capture(previous),
            capture(next),
            field(previous, "wantedWindowId").or_else(|| field(previous, "wantedScreenId")),
        ));
    }
    events.extend(source_change(
        SourceKind::Camera,
        pair(previous, "cameraId", "cameraName"),
        pair(next, "cameraId", "cameraName"),
        field(previous, "wantedCameraId"),
    ));
    events.extend(source_change(
        SourceKind::Microphone,
        pair(previous, "microphoneId", "microphoneName"),
        pair(next, "microphoneId", "microphoneName"),
        None,
    ));
    events
}

// ── The sources-off start reason ─────────────────────────────────────────

/// `sceneSourcesTurnedOff`: the scene shows a source the streamer turned
/// off (Screen None, Camera Off).
pub fn scene_sources_turned_off(visual: &Value, devices: &[Device]) -> (bool, bool) {
    let gaps = scene_source_gaps(visual, devices);
    let off = |source: GapSource| {
        gaps.iter()
            .any(|gap| gap.source == source && gap.state == GapState::Off)
    };
    let sources = get(Some(visual), "sources");
    (
        get(sources, "captureOff") == Some(&Value::Bool(true)) && off(GapSource::Screen),
        get(sources, "cameraOff") == Some(&Value::Bool(true)) && off(GapSource::Camera),
    )
}

/// `sceneSourceOffBlockedReason`'s sentences.
pub mod source_off_copy {
    pub const BOTH: &str =
        "This scene shows a screen and a camera, but both are off. Choose them in Sources.";
    pub const SCREEN: &str = "This scene shows a screen, but Screen is set to None. Choose a screen in Sources, or pick a scene without one.";
    pub const CAMERA: &str = "This scene shows a camera, but Camera is off. Turn it on in Sources, or pick a scene without one.";
}

/// `sceneSourceOffBlockedReason`.
pub fn scene_source_off_blocked_reason(screen: bool, camera: bool) -> Option<&'static str> {
    match (screen, camera) {
        (true, true) => Some(source_off_copy::BOTH),
        (true, false) => Some(source_off_copy::SCREEN),
        (false, true) => Some(source_off_copy::CAMERA),
        (false, false) => None,
    }
}

// ── The device picker's words (`lib/source-select-state.ts`) ────────────

/// `DevicePickerCopy`.
#[derive(Debug, Clone, Copy)]
pub struct PickerCopy {
    pub finding: &'static str,
    pub empty: &'static str,
    pub saved: &'static str,
    pub select: &'static str,
}

/// `devicePickerCopy(kind)`.
pub fn picker_copy(kind: SourceKind) -> PickerCopy {
    match kind {
        SourceKind::Camera => PickerCopy {
            finding: "Finding cameras…",
            empty: "No cameras found",
            saved: "Saved camera",
            select: "Choose a camera",
        },
        SourceKind::Capture => PickerCopy {
            finding: "Finding screens and windows…",
            empty: "No screens or windows found",
            saved: "Saved screen or window",
            select: "Choose a screen or window",
        },
        SourceKind::Microphone => PickerCopy {
            finding: "Finding microphones…",
            empty: "No microphones found",
            saved: "Saved microphone",
            select: "Choose a microphone",
        },
    }
}

/// `deviceStatusLabel`: the muted word after a device that can't run.
pub fn device_status_label(status: Option<&DeviceStatus>) -> Option<&'static str> {
    match status {
        Some(DeviceStatus::PermissionRequired) => Some("Needs permission"),
        Some(DeviceStatus::Unavailable) => Some("Unavailable"),
        Some(DeviceStatus::Available) => None,
        None => Some("Not found"),
    }
}

/// `DEVICE_PICKER_NONE_VALUE`.
pub const PICKER_NONE_VALUE: &str = "__none__";

/// What a picker reads (`DevicePickerSelectionInput` with the trigger's
/// and the list's options).
#[derive(Debug, Clone)]
pub struct PickerInput<'a> {
    pub kind: SourceKind,
    pub devices: Vec<&'a Device>,
    pub value: Option<String>,
    pub selected_name: Option<String>,
    pub selected_device: Option<&'a Device>,
    pub discovery_pending: bool,
    pub none_label: Option<&'static str>,
    pub selection_label: Option<&'static str>,
    pub group_by_kind: bool,
}

/// One row of a picker's open list (`DevicePickerItem`), or a group's
/// heading (`heading` set, nothing else).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PickerItem {
    pub value: String,
    pub label: String,
    pub status: String,
    pub disabled: bool,
    pub selected: bool,
    pub heading: String,
}

/// A picker as one value: the closed trigger and the open list.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PickerView {
    pub label: String,
    pub status: String,
    /// A prompt or a state, not a choice (the secondary tone).
    pub placeholder: bool,
    pub items: Vec<PickerItem>,
    /// `devicePickerListStatus`: the list's one status line.
    pub list_status: String,
}

fn unlisted(input: &PickerInput<'_>) -> Option<(String, String, Option<&'static str>)> {
    let value = input.value.as_deref()?;
    if input.devices.iter().any(|device| device.id == value) {
        return None;
    }
    if let Some(known) = input.selected_device.filter(|device| device.id == value) {
        return Some((
            value.to_string(),
            known.name.clone(),
            device_status_label(Some(&known.status)),
        ));
    }
    Some((
        value.to_string(),
        input
            .selected_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| picker_copy(input.kind).saved.to_string()),
        if input.discovery_pending {
            None
        } else {
            device_status_label(None)
        },
    ))
}

/// `devicePickerTriggerView`, `devicePickerGroups` and
/// `devicePickerListStatus` (no search: the Studio's pickers have none).
pub fn picker_view(input: &PickerInput<'_>) -> PickerView {
    let copy = picker_copy(input.kind);
    let (label, status, placeholder) = if let Some(selection) = input.selection_label {
        (selection.to_string(), None, false)
    } else if let Some(device) = input
        .value
        .as_deref()
        .and_then(|value| input.devices.iter().find(|device| device.id == value))
    {
        (
            device.name.clone(),
            device_status_label(Some(&device.status)),
            false,
        )
    } else if let Some((_, label, status)) = input.value.as_ref().and(unlisted(input)) {
        (label, status, false)
    } else if input.discovery_pending {
        (copy.finding.to_string(), None, true)
    } else if input.devices.is_empty() {
        (copy.empty.to_string(), None, true)
    } else if let Some(none) = input.none_label {
        (none.to_string(), None, false)
    } else {
        (copy.select.to_string(), None, true)
    };
    let mut items = Vec::new();
    if let Some(none) = input.none_label {
        items.push(PickerItem {
            value: PICKER_NONE_VALUE.to_string(),
            label: none.to_string(),
            selected: input.value.is_none(),
            ..PickerItem::default()
        });
    }
    if let Some((value, label, status)) = unlisted(input) {
        items.push(PickerItem {
            value,
            label,
            status: status.unwrap_or_default().to_string(),
            disabled: true,
            selected: true,
            heading: String::new(),
        });
    }
    let item = |device: &&Device| PickerItem {
        value: device.id.clone(),
        label: device.name.clone(),
        status: device_status_label(Some(&device.status))
            .unwrap_or_default()
            .to_string(),
        disabled: device.status != DeviceStatus::Available,
        selected: input.value.as_deref() == Some(device.id.as_str()),
        heading: String::new(),
    };
    let screens: Vec<&&Device> = input
        .devices
        .iter()
        .filter(|device| device.kind == DeviceKind::Screen)
        .collect();
    let windows: Vec<&&Device> = input
        .devices
        .iter()
        .filter(|device| device.kind == DeviceKind::Window)
        .collect();
    let heading = |text: &str| PickerItem {
        heading: text.to_string(),
        ..PickerItem::default()
    };
    if input.group_by_kind && !screens.is_empty() && !windows.is_empty() {
        items.push(heading("Screens"));
        items.extend(screens.into_iter().map(item));
        items.push(heading("Windows"));
        items.extend(windows.into_iter().map(item));
    } else {
        items.extend(input.devices.iter().map(item));
    }
    let list_status = if input.discovery_pending {
        copy.finding
    } else if input.devices.is_empty() {
        copy.empty
    } else {
        ""
    };
    PickerView {
        label,
        status: status.unwrap_or_default().to_string(),
        placeholder,
        items,
        list_status: list_status.to_string(),
    }
}

#[cfg(test)]
#[path = "source_selection_tests.rs"]
mod tests;
