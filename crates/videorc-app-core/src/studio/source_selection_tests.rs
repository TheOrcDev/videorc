//! S3.1c: `smoke:sources`' cases (`scripts/smoke-source-reconciliation.mjs`,
//! the ledger's `logic` row) as a core test, and the pickers' words.

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::*;

fn device(id: &str, name: &str, kind: DeviceKind) -> Device {
    Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: id.to_string(),
        name: name.to_string(),
        kind,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
    }
}

fn devices() -> Vec<Device> {
    vec![
        device(
            "screen:screencapturekit:222",
            "Built-in Display",
            DeviceKind::Screen,
        ),
        device(
            "screen:screencapturekit:333",
            "Studio Monitor",
            DeviceKind::Screen,
        ),
        device("window:screencapturekit:111", "Editor", DeviceKind::Window),
        device(
            "camera:avfoundation-native:face-time",
            "FaceTime HD Camera",
            DeviceKind::Camera,
        ),
        device(
            "camera:avfoundation-native:desk",
            "Desk Camera",
            DeviceKind::Camera,
        ),
        device(
            "microphone:coreaudio:podcast",
            "Podcast Mic",
            DeviceKind::Microphone,
        ),
        device(
            "microphone:coreaudio:laptop",
            "Laptop Mic",
            DeviceKind::Microphone,
        ),
    ]
}

fn reconcile(sources: Value, devices: &[Device]) -> Value {
    reconcile_source_selection(&sources, devices, &ReconcileOptions::default())
}

fn reasons(previous: &Value, next: &Value) -> Vec<(&'static str, &'static str)> {
    source_selection_change_events(previous, next)
        .into_iter()
        .map(|event| (event.kind.as_str(), event.reason.as_str()))
        .collect()
}

const OLD: &str = r#"{
    "screenId": "screen-old", "screenName": "Built-in Display",
    "cameraId": "camera-old", "cameraName": "FaceTime HD Camera",
    "microphoneId": "mic-old", "microphoneName": "Podcast Mic"
}"#;

#[test]
fn a_stale_id_is_found_again_by_its_name() {
    let loaded: Value = serde_json::from_str(OLD).unwrap();
    let mut with_flag = loaded.clone();
    with_flag["testPattern"] = json!(false);
    let reloaded = reconcile(with_flag.clone(), &devices());
    assert_eq!(
        reloaded,
        json!({
            "screenId": "screen:screencapturekit:222",
            "screenName": "Built-in Display",
            "cameraId": "camera:avfoundation-native:face-time",
            "cameraName": "FaceTime HD Camera",
            "microphoneId": "microphone:coreaudio:podcast",
            "microphoneName": "Podcast Mic",
            "testPattern": false
        })
    );
    assert_eq!(
        reasons(&with_flag, &reloaded),
        vec![
            ("capture", "restored-by-name"),
            ("camera", "restored-by-name"),
            ("microphone", "restored-by-name")
        ]
    );
    assert_eq!(
        reconcile(loaded, &devices()),
        json!({
            "screenId": "screen:screencapturekit:222",
            "screenName": "Built-in Display",
            "cameraId": "camera:avfoundation-native:face-time",
            "cameraName": "FaceTime HD Camera",
            "microphoneId": "microphone:coreaudio:podcast",
            "microphoneName": "Podcast Mic"
        })
    );
}

#[test]
fn a_window_pick_wins_over_a_stale_screen() {
    assert_eq!(
        reconcile(
            json!({
                "windowId": "window:screencapturekit:111", "windowName": "Editor",
                "screenId": "screen-old", "screenName": "Built-in Display",
                "cameraId": "camera:avfoundation-native:desk", "cameraName": "Desk Camera",
                "microphoneId": "microphone:coreaudio:laptop", "microphoneName": "Laptop Mic"
            }),
            &devices()
        ),
        json!({
            "windowId": "window:screencapturekit:111",
            "windowName": "Editor",
            "cameraId": "camera:avfoundation-native:desk",
            "cameraName": "Desk Camera",
            "microphoneId": "microphone:coreaudio:laptop",
            "microphoneName": "Laptop Mic"
        })
    );
}

#[test]
fn a_missing_pick_stays_the_pick_while_a_stand_in_holds_its_place() {
    let missing = json!({
        "screenId": "missing-screen", "screenName": "Missing Display",
        "cameraId": "missing-camera", "cameraName": "Missing Camera",
        "microphoneId": "missing-mic", "microphoneName": "Missing Mic"
    });
    let next = reconcile(missing.clone(), &devices());
    assert_eq!(
        next,
        json!({
            "wantedScreenId": "missing-screen",
            "wantedScreenName": "Missing Display",
            "wantedCameraId": "missing-camera",
            "wantedCameraName": "Missing Camera",
            "screenId": "screen:screencapturekit:222",
            "screenName": "Built-in Display",
            "cameraId": "camera:avfoundation-native:face-time",
            "cameraName": "FaceTime HD Camera",
            "microphoneId": "microphone:coreaudio:podcast",
            "microphoneName": "Podcast Mic"
        })
    );
    let events = source_selection_change_events(&missing, &next);
    let summary: Vec<_> = events
        .iter()
        .map(|event| {
            (
                event.kind.as_str(),
                event.reason.as_str(),
                event.next_name.clone().unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "capture",
                "unavailable-selected",
                "Built-in Display".to_string()
            ),
            (
                "camera",
                "unavailable-selected",
                "FaceTime HD Camera".to_string()
            ),
            (
                "microphone",
                "unavailable-selected",
                "Podcast Mic".to_string()
            ),
        ]
    );
    // What a stand-in says, idle too (plan 213 E1).
    let stand_in = source_stand_in(&next, SourceKind::Capture, &devices()).unwrap();
    assert_eq!(
        stand_in_line(&stand_in),
        "Missing Display isn't connected · using Built-in Display"
    );
    let camera = source_stand_in(&next, SourceKind::Camera, &devices()).unwrap();
    assert_eq!(
        stand_in_line(&camera),
        "Missing Camera isn't connected · using FaceTime HD Camera"
    );
}

#[test]
fn an_unavailable_camera_is_kept_as_the_pick_with_nothing_in_its_place() {
    let unplugged: Vec<Device> = devices()
        .into_iter()
        .map(|mut item| {
            if item.kind == DeviceKind::Camera {
                item.status = DeviceStatus::Unavailable;
            }
            item
        })
        .collect();
    assert_eq!(
        reconcile(
            json!({
                "screenId": "screen:screencapturekit:222", "screenName": "Built-in Display",
                "cameraId": "camera:avfoundation-native:face-time", "cameraName": "FaceTime HD Camera",
                "microphoneId": "microphone:coreaudio:podcast", "microphoneName": "Podcast Mic"
            }),
            &unplugged
        ),
        json!({
            "wantedCameraId": "camera:avfoundation-native:face-time",
            "wantedCameraName": "FaceTime HD Camera",
            "screenId": "screen:screencapturekit:222",
            "screenName": "Built-in Display",
            "microphoneId": "microphone:coreaudio:podcast",
            "microphoneName": "Podcast Mic"
        })
    );
}

#[test]
fn camera_off_microphone_none_and_screen_none_survive_every_refresh() {
    let reversed: Vec<Device> = devices().into_iter().rev().collect();
    let camera_off = json!({
        "screenId": "screen:screencapturekit:222", "screenName": "Built-in Display",
        "cameraOff": true,
        "microphoneId": "microphone:coreaudio:podcast", "microphoneName": "Podcast Mic"
    });
    let off = reconcile(camera_off.clone(), &devices());
    assert_eq!(off, camera_off);
    assert!(reasons(&camera_off, &off).is_empty());
    assert_eq!(reconcile(off.clone(), &reversed), off);

    let microphone_none = json!({
        "screenId": "screen:screencapturekit:222", "screenName": "Built-in Display",
        "cameraId": "camera:avfoundation-native:face-time", "cameraName": "FaceTime HD Camera",
        "microphoneOff": true
    });
    let none = reconcile(microphone_none, &devices());
    assert_eq!(none.get("microphoneId"), None);
    assert_eq!(none["microphoneOff"], json!(true));
    assert_eq!(reconcile(none.clone(), &reversed), none);

    let capture_none = json!({
        "captureOff": true,
        "cameraId": "camera:avfoundation-native:face-time", "cameraName": "FaceTime HD Camera",
        "microphoneId": "microphone:coreaudio:podcast", "microphoneName": "Podcast Mic"
    });
    let none = reconcile(capture_none.clone(), &devices());
    assert_eq!(none.get("screenId"), None);
    assert_eq!(none.get("windowId"), None);
    assert_eq!(none["captureOff"], json!(true));
    assert!(reasons(&capture_none, &none).is_empty());
    assert_eq!(reconcile(none.clone(), &reversed), none);
}

#[test]
fn a_profile_that_never_chose_gets_the_first_camera_and_the_test_pattern_holds() {
    let legacy = json!({
        "screenId": "screen:screencapturekit:222", "screenName": "Built-in Display",
        "microphoneId": "microphone:coreaudio:podcast", "microphoneName": "Podcast Mic"
    });
    assert_eq!(
        reconcile(legacy, &devices())["cameraId"],
        json!("camera:avfoundation-native:face-time")
    );
    // The diagnostic pattern keeps the screen empty on every refresh.
    let pattern = reconcile(
        json!({ "testPattern": true, "cameraOff": true, "microphoneOff": true }),
        &devices(),
    );
    assert_eq!(
        pattern,
        json!({ "testPattern": true, "cameraOff": true, "microphoneOff": true })
    );
    // No device list yet changes nothing.
    let unknown = json!({ "screenId": "screen-old" });
    assert_eq!(reconcile(unknown.clone(), &[]), unknown);
    // A window is never the default (F-013).
    let windows_only = vec![device(
        "window:screencapturekit:1",
        "loginwindow",
        DeviceKind::Window,
    )];
    assert_eq!(reconcile(json!({}), &windows_only), json!({}));
}

#[test]
fn fallback_microphone_rows_migrate_to_the_native_device() {
    let rows = vec![
        device(
            "microphone:avfoundation:2",
            "Shure MV7+",
            DeviceKind::Microphone,
        ),
        device(
            "microphone:coreaudio:shure",
            "Shure MV7+",
            DeviceKind::Microphone,
        ),
    ];
    let migrated = reconcile(
        json!({ "microphoneId": "microphone:avfoundation:2", "microphoneName": "Fallback - Shure MV7+" }),
        &rows,
    );
    assert_eq!(
        migrated["microphoneId"],
        json!("microphone:coreaudio:shure")
    );
    assert_eq!(migrated["microphoneName"], json!("Shure MV7+"));
    assert_eq!(
        reconcile(json!({}), &rows)["microphoneId"],
        json!("microphone:coreaudio:shure")
    );
    let only = reconcile(
        json!({ "microphoneId": "microphone:avfoundation:2", "microphoneName": "Shure MV7+" }),
        &rows[..1],
    );
    assert_eq!(only["microphoneId"], json!("microphone:avfoundation:2"));
}

#[test]
fn a_held_stand_in_stays_during_a_session_and_a_disconnected_camera_keeps_its_place() {
    let standing = reconcile(
        json!({ "screenId": "gone", "screenName": "Gone" }),
        &devices(),
    );
    let held = reconcile_source_selection(
        &standing,
        &devices(),
        &ReconcileOptions {
            hold_stand_ins: true,
            ..ReconcileOptions::default()
        },
    );
    assert_eq!(held["screenId"], json!("screen:screencapturekit:222"));
    assert_eq!(held["wantedScreenId"], json!("gone"));
    let unplugged: Vec<Device> = devices()
        .into_iter()
        .filter(|item| item.kind != DeviceKind::Camera)
        .collect();
    let kept = reconcile_source_selection(
        &json!({ "cameraId": "camera:avfoundation-native:desk", "cameraName": "Desk Camera" }),
        &unplugged,
        &ReconcileOptions {
            disconnected_camera_id: Some("camera:avfoundation-native:desk".into()),
            ..ReconcileOptions::default()
        },
    );
    assert_eq!(kept["cameraId"], json!("camera:avfoundation-native:desk"));
    assert_eq!(kept.get("wantedCameraId"), None);
}

#[test]
fn the_builders_write_one_kind_and_merge_keeps_the_rest() {
    let list = devices();
    let capture = capture_picker_devices(&list);
    assert_eq!(capture.len(), 3);
    let current = json!({
        "testPattern": true, "app": { "bundleId": "com.figma.Desktop" },
        "wantedScreenId": "gone", "cameraId": "camera:avfoundation-native:desk"
    });
    let window = build_capture_sources(&current, &capture, Some("window:screencapturekit:111"));
    assert_eq!(
        window,
        json!({
            "windowId": "window:screencapturekit:111", "windowName": "Editor",
            "testPattern": false, "cameraId": "camera:avfoundation-native:desk"
        })
    );
    let none = build_capture_sources(&current, &capture, None);
    assert_eq!(none["captureOff"], json!(true));
    let cameras = camera_picker_devices(&list);
    let off = build_camera_sources(&window, &cameras, None);
    assert_eq!(off["cameraOff"], json!(true));
    assert_eq!(off.get("cameraId"), None);
    let on = build_camera_sources(&off, &cameras, Some("camera:avfoundation-native:face-time"));
    assert_eq!(on["cameraName"], json!("FaceTime HD Camera"));
    assert_eq!(on.get("cameraOff"), None);
    // Only the camera's fields land on a newer selection.
    let newer = json!({ "screenId": "screen:screencapturekit:333", "cameraOff": true });
    assert_eq!(
        merge_source_kind(&newer, &on, SourceKind::Camera),
        json!({
            "screenId": "screen:screencapturekit:333",
            "cameraId": "camera:avfoundation-native:face-time",
            "cameraName": "FaceTime HD Camera"
        })
    );
}

#[test]
fn the_pickers_say_every_state() {
    let list = devices();
    let capture = capture_picker_devices(&list);
    let input = |value: Option<&str>, pending: bool| PickerInput {
        kind: SourceKind::Capture,
        devices: capture.clone(),
        value: value.map(str::to_string),
        selected_name: None,
        selected_device: None,
        discovery_pending: pending,
        none_label: Some("None"),
        selection_label: None,
        group_by_kind: true,
    };
    let view = picker_view(&input(Some("window:screencapturekit:111"), false));
    assert_eq!(view.label, "Editor");
    let headings: Vec<&str> = view
        .items
        .iter()
        .filter(|item| !item.heading.is_empty())
        .map(|item| item.heading.as_str())
        .collect();
    assert_eq!(headings, vec!["Screens", "Windows"]);
    assert_eq!(view.items[0].label, "None");
    assert!(!view.items[0].selected);
    assert!(
        view.items
            .iter()
            .any(|item| item.selected && item.label == "Editor")
    );
    assert_eq!(picker_view(&input(None, false)).label, "None");
    let pending = picker_view(&PickerInput {
        devices: Vec::new(),
        ..input(None, true)
    });
    assert_eq!(pending.label, "Finding screens and windows…");
    assert!(pending.placeholder);
    assert_eq!(pending.list_status, "Finding screens and windows…");
    let gone = picker_view(&PickerInput {
        selected_name: Some("Studio Display".into()),
        ..input(Some("screen:gone"), false)
    });
    assert_eq!(
        (gone.label.as_str(), gone.status.as_str()),
        ("Studio Display", "Not found")
    );
    assert!(gone.items[1].disabled && gone.items[1].selected);
    let pattern = picker_view(&PickerInput {
        selection_label: Some("Test pattern"),
        ..input(None, false)
    });
    assert_eq!(pattern.label, "Test pattern");
}

#[test]
fn a_scene_that_shows_a_source_turned_off_says_so() {
    let visual = |sources: Value| json!({ "layout": { "layoutPreset": "screen-camera" }, "sources": sources });
    let both = visual(json!({ "captureOff": true, "cameraOff": true }));
    let (screen, camera) = scene_sources_turned_off(&both, &devices());
    assert_eq!(
        scene_source_off_blocked_reason(screen, camera),
        Some(source_off_copy::BOTH)
    );
    let camera_only = visual(json!({
        "screenId": "screen:screencapturekit:222", "cameraOff": true
    }));
    let (screen, camera) = scene_sources_turned_off(&camera_only, &devices());
    assert_eq!(
        scene_source_off_blocked_reason(screen, camera),
        Some(source_off_copy::CAMERA)
    );
    let fine =
        visual(json!({ "testPattern": true, "cameraId": "camera:avfoundation-native:desk" }));
    let (screen, camera) = scene_sources_turned_off(&fine, &devices());
    assert_eq!(scene_source_off_blocked_reason(screen, camera), None);
}

#[test]
fn the_smoke_harness_withholds_the_first_devices_but_finds_a_remembered_pick() {
    let options = ReconcileOptions {
        withhold_defaults: true,
        ..ReconcileOptions::default()
    };
    assert_eq!(
        reconcile_source_selection(&json!({}), &devices(), &options),
        json!({})
    );
    let remembered = reconcile_source_selection(
        &json!({ "cameraId": "camera-old", "cameraName": "Desk Camera" }),
        &devices(),
        &options,
    );
    assert_eq!(
        remembered["cameraId"],
        json!("camera:avfoundation-native:desk")
    );
}

#[test]
fn a_reopened_window_is_found_again_at_record_and_never_becomes_another() {
    let sources = json!({ "windowId": "window:screencapturekit:111", "windowName": "Editor" });
    // Live on that id: no read.
    assert!(!should_refresh_window_list_before_start(
        &sources,
        Some(&json!({ "state": "live", "sourceId": "window:screencapturekit:111" }))
    ));
    assert!(should_refresh_window_list_before_start(&sources, None));
    assert!(!should_refresh_window_list_before_start(
        &json!({ "screenId": "screen:screencapturekit:1" }),
        None
    ));
    let reopened = vec![
        device("window:screencapturekit:999", "Editor", DeviceKind::Window),
        device("screen:screencapturekit:1", "Editor", DeviceKind::Screen),
    ];
    assert_eq!(
        rebind_remembered_window(&sources, &reopened),
        Some(("window:screencapturekit:999".into(), "Editor".into()))
    );
    // Listed under its own id: nothing to rebind; no match: the pick stays.
    assert_eq!(rebind_remembered_window(&sources, &devices()), None);
    let other = vec![device(
        "window:screencapturekit:5",
        "Notes",
        DeviceKind::Window,
    )];
    assert_eq!(rebind_remembered_window(&sources, &other), None);
}
