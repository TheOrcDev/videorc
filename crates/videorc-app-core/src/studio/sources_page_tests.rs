//! The Sources page's rules, ported with Electron's tests
//! (`source-status.test.ts`, `source-facts.test.ts`,
//! `camera-format-shortfall.test.ts`, `camera-frame-rate.test.ts`,
//! `screen-share-recovery.test.ts`, `source-permissions.test.ts`).

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::*;

fn device(id: &str, kind: DeviceKind, status: DeviceStatus) -> Device {
    let mut device: Device = serde_json::from_value(json!({
        "id": id, "name": format!("{id} name"), "kind": "camera", "status": "available",
    }))
    .unwrap();
    device.kind = kind;
    device.status = status;
    device
}

fn screen(input: VideoStatusInput<'_>) -> Option<SourceStatus> {
    video_source_status(&VideoStatusInput {
        kind: Some(VideoKind::Screen),
        ..input
    })
}

fn camera(input: VideoStatusInput<'_>) -> Option<SourceStatus> {
    video_source_status(&VideoStatusInput {
        kind: Some(VideoKind::Camera),
        ..input
    })
}

fn live() -> PreviewSource<'static> {
    PreviewSource {
        state: Some("live"),
        ..PreviewSource::default()
    }
}

#[test]
fn selected_device_is_missing_when_its_id_is_not_listed() {
    let devices = [device("a", DeviceKind::Camera, DeviceStatus::Available)];
    assert_eq!(selected_device_status(&devices, None), None);
    assert_eq!(
        selected_device_status(&devices, Some("a")),
        Some(SelectedDevice::Listed(DeviceStatus::Available))
    );
    assert_eq!(
        selected_device_status(&devices, Some("b")),
        Some(SelectedDevice::Missing)
    );
}

#[test]
fn switching_leads_and_nothing_selected_has_no_chip() {
    let switching = screen(VideoStatusInput {
        switching: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        (switching.label.as_str(), switching.tone),
        ("Switching", ChipTone::Warn)
    );
    assert_eq!(screen(VideoStatusInput::default()), None);
}

#[test]
fn a_delivering_source_says_receiving() {
    let status = screen(VideoStatusInput {
        selected: true,
        preview: live(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        (status.label.as_str(), status.tone),
        ("Receiving", ChipTone::Good)
    );
}

#[test]
fn a_camera_that_sends_no_video_is_named() {
    let status = camera(VideoStatusInput {
        selected: true,
        name: Some("FaceTime HD Camera"),
        preview: PreviewSource {
            no_video: true,
            ..live()
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(status.label, "No video");
    assert_eq!(
        status.hint.as_deref(),
        Some(
            "FaceTime HD Camera isn't sending video. Close other apps that use it, or choose another camera."
        )
    );
}

#[test]
fn a_stale_camera_is_reported_never_a_stale_screen() {
    let stale = PreviewSource {
        frame_age_ms: Some(4200.0),
        ..live()
    };
    let status = camera(VideoStatusInput {
        selected: true,
        preview: stale.clone(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(status.label, "Stale 4s");
    assert_eq!(
        status.hint.as_deref(),
        Some("No fresh frames. Choose it again to restart it.")
    );
    let screen_status = screen(VideoStatusInput {
        selected: true,
        preview: stale,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(screen_status.label, "Receiving");
}

#[test]
fn a_slow_camera_says_low_frame_rate() {
    let status = camera(VideoStatusInput {
        selected: true,
        name: Some("C920"),
        preview: live(),
        low_frame_rate: Some(CameraLowFrameRate {
            fps: 14.7,
            expected_fps: 30.0,
        }),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(status.label, "Low frame rate");
    assert_eq!(
        status.hint.as_deref(),
        Some("C920 is sending 15 of 30 fps. More light usually helps.")
    );
}

#[test]
fn permission_missing_and_idle_states() {
    let needs = camera(VideoStatusInput {
        selected: true,
        device: Some(SelectedDevice::Listed(DeviceStatus::PermissionRequired)),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        (needs.label.as_str(), needs.hint),
        ("Needs permission", None)
    );
    let gone = screen(VideoStatusInput {
        selected: true,
        device: Some(SelectedDevice::Missing),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(gone.label, "Not found");
    assert_eq!(
        gone.hint.as_deref(),
        Some("That screen or window is gone. Choose another.")
    );
    // The preview's own idle state is never "Not found".
    assert_eq!(
        screen(VideoStatusInput {
            selected: true,
            device: Some(SelectedDevice::Listed(DeviceStatus::Available)),
            preview: PreviewSource {
                state: Some("source-missing"),
                ..PreviewSource::default()
            },
            ..Default::default()
        }),
        None
    );
}

#[test]
fn starting_failed_and_the_share_dialog() {
    let starting = screen(VideoStatusInput {
        selected: true,
        preview: PreviewSource {
            state: Some("starting"),
            ..PreviewSource::default()
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(starting.label, "Starting");
    let waiting = screen(VideoStatusInput {
        selected: true,
        preview: PreviewSource {
            state: Some("starting"),
            message: Some(copy::SHARE_DIALOG_PENDING),
            ..PreviewSource::default()
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(waiting.label, "Waiting for you");
    let failed = camera(VideoStatusInput {
        selected: true,
        preview: PreviewSource {
            state: Some("failed"),
            message: Some("raw backend words"),
            ..PreviewSource::default()
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        (failed.label.as_str(), failed.tone),
        ("Failed", ChipTone::Error)
    );
    assert_eq!(
        failed.hint.as_deref(),
        Some("Couldn't start it. Choose it again to retry.")
    );
}

#[test]
fn a_stand_in_explains_itself_idle_too() {
    let stand_in = SourceStandIn {
        kind: DeviceKind::Camera,
        wanted_name: Some("Brio".into()),
        using_name: Some("FaceTime HD Camera".into()),
        available: false,
    };
    let quiet = camera(VideoStatusInput {
        selected: true,
        stand_in: Some(stand_in.clone()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(quiet.label, "Stand-in");
    assert_eq!(
        quiet.hint.as_deref(),
        Some("Brio isn't connected · using FaceTime HD Camera")
    );
    let receiving = camera(VideoStatusInput {
        selected: true,
        preview: live(),
        stand_in: Some(stand_in),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(receiving.label, "Receiving");
    assert!(receiving.hint.unwrap().starts_with("Brio isn't connected"));
}

#[test]
fn a_lost_share_dialog_is_not_a_permission() {
    let preview = PreviewSource {
        state: Some("permission-needed"),
        message: Some(copy::SHARE_DIALOG_LOST),
        ..PreviewSource::default()
    };
    let status = screen_share_lost_status(true, false, &preview).unwrap();
    assert_eq!(status.label, "Not shared");
    assert_eq!(screen_share_lost_status(true, true, &preview), None);
    assert!(screen_share_needs_asking(
        Some("screen:portal:1"),
        Some("failed")
    ));
    assert!(!screen_share_needs_asking(
        Some("screen:portal:1"),
        Some("live")
    ));
    assert!(!screen_share_needs_asking(
        Some("screen:screencapturekit:1"),
        None
    ));
}

#[test]
fn facts_say_only_what_was_measured() {
    let screen = json!({
        "state": "live", "nativeWidth": 3024, "nativeHeight": 1964, "width": 1920, "height": 1247,
    });
    assert_eq!(screen_facts(Some(&screen)).as_deref(), Some("3024 × 1964"));
    assert_eq!(
        screen_facts(Some(
            &json!({"state": "live", "width": 1920, "height": 1080})
        ))
        .as_deref(),
        Some("1920 × 1080")
    );
    assert_eq!(
        screen_facts(Some(&json!({"state": "starting", "width": 1}))),
        None
    );
    let camera = json!({
        "state": "live", "targetFps": 30, "selectedFormatWidth": 1920,
        "selectedFormatHeight": 1080, "selectedFormatMaxFps": 60,
    });
    assert_eq!(
        camera_facts(Some(&camera)).as_deref(),
        Some("1920 × 1080 · 30 fps")
    );
    let mut capped = camera.clone();
    capped["targetFps"] = json!(60);
    capped["selectedFormatMaxFps"] = json!(29.97);
    assert_eq!(
        camera_facts(Some(&capped)).as_deref(),
        Some("1920 × 1080 · 30 fps")
    );
    assert_eq!(
        camera_facts(Some(&json!({
            "state": "live", "targetFps": 0, "actualWidth": 1280, "actualHeight": 720,
        })))
        .as_deref(),
        Some("1280 × 720")
    );
    assert_eq!(camera_facts(None), None);
    assert_eq!(
        camera_facts(Some(&json!({"state": "live", "targetFps": 30}))),
        None
    );
}

fn stats(overrides: Value) -> Value {
    let mut stats = json!({
        "previewCameraState": "live",
        "previewCameraRequestedWidth": 1920,
        "previewCameraRequestedHeight": 1080,
        "previewCameraSelectedFormatWidth": 3840,
        "previewCameraSelectedFormatHeight": 2160,
        "previewCameraSelectedFormatMaxFps": 25,
        "previewCameraStatusMessage":
            "Requested 1280x720@30 was not available; selected native 3840x2160 at 25-25 fps.",
        "previewCameraCapabilityFormats": [{"width": 3840, "height": 2160, "minFps": 25, "maxFps": 25}],
    });
    for (key, value) in overrides.as_object().unwrap() {
        if value.is_null() {
            stats.as_object_mut().unwrap().remove(key);
        } else {
            stats[key] = value.clone();
        }
    }
    stats
}

#[test]
fn a_camera_format_shortfall_is_named() {
    let shortfall = camera_format_shortfall(Some(&stats(json!({})))).unwrap();
    assert!(shortfall.fps_unmet && !shortfall.resolution_unmet && shortfall.single_format);
    let message = camera_format_shortfall_message(&shortfall);
    assert!(
        message.contains("only offers 3840 × 2160 at 25 fps"),
        "{message}"
    );
    assert!(message.contains("can't reach 30 fps"), "{message}");
    assert_eq!(
        camera_format_shortfall(Some(&stats(json!({
            "previewCameraSelectedFormatMaxFps": 30,
            "previewCameraStatusMessage": "Requested 1920x1080@30; selected native 3840x2160 at 30 fps.",
        })))),
        None
    );
    let small = camera_format_shortfall(Some(&stats(json!({
        "previewCameraSelectedFormatWidth": 640,
        "previewCameraSelectedFormatHeight": 480,
        "previewCameraSelectedFormatMaxFps": 30,
        "previewCameraStatusMessage": "Requested 1920x1080@30; selected native 640x480 at 30 fps.",
    }))))
    .unwrap();
    assert!(small.resolution_unmet && !small.fps_unmet);
    assert_eq!(
        camera_format_shortfall_message(&small),
        "This camera's closest format is 640 × 480 at 30 fps, so the image is upscaled to fill the 1920 × 1080 canvas."
    );
    assert_eq!(
        camera_format_shortfall(Some(&stats(json!({"previewCameraState": "starting"})))),
        None
    );
    assert_eq!(
        camera_format_shortfall(Some(&stats(
            json!({"previewCameraSelectedFormatMaxFps": null})
        ))),
        None
    );
    assert_eq!(
        camera_format_shortfall(Some(&stats(json!({"previewCameraStatusMessage": "live"})))),
        None
    );
    assert_eq!(
        camera_format_shortfall(Some(&stats(json!({
            "previewCameraSelectedFormatMaxFps": 30,
            "previewCameraStatusMessage": "Requested 1920x1080@29.97; selected native 3840x2160 at 30 fps.",
        })))),
        None
    );
}

#[test]
fn compensation_on_names_the_switch_in_the_low_frame_rate_line() {
    // `camera-frame-rate.test.ts`: the camera may be trading frames for
    // exposure on purpose.
    let status = camera(VideoStatusInput {
        selected: true,
        name: Some("HP HD Camera"),
        preview: live(),
        low_frame_rate: Some(CameraLowFrameRate {
            fps: 11.4,
            expected_fps: 30.0,
        }),
        low_light_compensation: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(status.label, "Low frame rate");
    assert_eq!(
        status.hint.as_deref(),
        Some(
            "HP HD Camera is sending 11 of 30 fps. Turning off Low-light compensation can bring it back to 30 fps."
        )
    );
}

#[test]
fn every_permission_warning_is_the_alerts_own() {
    let warnings = vec![
        "Camera permission is required".to_string(),
        "screen recording permission missing".to_string(),
        "Something else broke".to_string(),
    ];
    assert_eq!(
        unknown_device_warnings(&warnings),
        vec!["Something else broke"]
    );
}

fn media(
    state: Option<GrantState>,
    action: Option<GrantAction>,
    chosen: bool,
) -> MediaPermissionInput {
    MediaPermissionInput {
        state,
        action,
        chosen,
        detail: None,
    }
}

#[test]
fn one_alert_per_missing_permission_in_page_order() {
    let granted = media(Some(GrantState::Granted), None, true);
    assert!(permission_alerts("darwin", "Videorc", None, &granted, &granted).is_empty());
    let denied = media(
        Some(GrantState::NotGranted),
        Some(GrantAction::OpenSettings),
        false,
    );
    assert!(permission_alerts("darwin", "Videorc", None, &denied, &denied).is_empty());
    let microphone = media(
        Some(GrantState::NotGranted),
        Some(GrantAction::OpenSettings),
        true,
    );
    let alerts = permission_alerts("darwin", "Videorc", None, &granted, &microphone);
    assert_eq!(
        alerts,
        vec![SourcePermissionAlert {
            pane: SystemPermissionPane::Microphone,
            title: "Microphone permission is required for Videorc.".into(),
            description: "Turn on Videorc in System Settings → Privacy & Security → Microphone."
                .into(),
            action_label: "Open Microphone settings".into(),
        }]
    );
    let first = media(
        Some(GrantState::FirstUse),
        Some(GrantAction::RequestMediaAccess),
        true,
    );
    let camera = &permission_alerts("darwin", "Videorc", None, &first, &granted)[0];
    assert_eq!(camera.action_label, "Allow…");
    assert_eq!(camera.description, "macOS asks once. Choose Allow.");
    let windows = &permission_alerts("win32", "Videorc", None, &microphone, &granted)[0];
    assert_eq!(
        windows.description,
        "In Windows Settings → Privacy & security → Camera, turn on access and “Let desktop apps access your camera”."
    );
    assert!(
        permission_alerts(
            "darwin",
            "Videorc",
            None,
            &media(Some(GrantState::NotGranted), None, true),
            &granted
        )
        .is_empty()
    );
    assert!(
        permission_alerts(
            "darwin",
            "Videorc",
            None,
            &media(None, Some(GrantAction::OpenSettings), true),
            &granted
        )
        .is_empty()
    );
}

fn grant(state: GrantState, action: Option<GrantAction>) -> GrantRow {
    GrantRow {
        state,
        checking: false,
        detail: String::new(),
        action,
    }
}

#[test]
fn the_screen_alert_follows_settings_permissions_rows() {
    let input = |screen: GrantRow| PermissionInputs {
        platform: "darwin",
        target_name: "Videorc",
        screen: Some(screen),
        camera: Some(grant(GrantState::Granted, None)),
        microphone: Some(grant(GrantState::Granted, None)),
        media_known: true,
    };
    let first = source_permission_alerts(
        &input(grant(
            GrantState::FirstUse,
            Some(GrantAction::RequestMediaAccess),
        )),
        false,
        false,
    );
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].pane, SystemPermissionPane::ScreenRecording);
    assert_eq!(
        first[0].title,
        "Screen Recording permission is required for Videorc."
    );
    assert_eq!(first[0].description, "macOS asks once. Choose Allow.");
    assert_eq!(first[0].action_label, "Allow…");
    let waiting = source_permission_alerts(
        &input(grant(GrantState::Waiting, Some(GrantAction::OpenSettings))),
        false,
        false,
    );
    assert_eq!(waiting[0].action_label, "Open System Settings…");
    let relaunch = source_permission_alerts(
        &input(grant(
            GrantState::NeedsRelaunch,
            Some(GrantAction::Relaunch),
        )),
        false,
        false,
    );
    assert_eq!(relaunch[0].title, "Reopen Videorc to record your screen.");
    assert_eq!(relaunch[0].action_label, "Reopen Videorc");
    // Still being checked, or nothing to do: no alert.
    let mut checking = grant(GrantState::NotGranted, Some(GrantAction::OpenSettings));
    checking.checking = true;
    assert!(source_permission_alerts(&input(checking), true, true).is_empty());
    assert!(
        source_permission_alerts(&input(grant(GrantState::Granted, None)), true, true).is_empty()
    );
}

#[test]
fn the_camera_chip_and_alert_wait_for_the_media_snapshot() {
    let camera = grant(GrantState::NotGranted, Some(GrantAction::OpenSettings));
    let mut input = PermissionInputs {
        platform: "darwin",
        target_name: "Videorc",
        camera: Some(camera),
        media_known: false,
        ..PermissionInputs::default()
    };
    assert!(input.camera_permission_required());
    assert!(source_permission_alerts(&input, true, false).is_empty());
    input.media_known = true;
    let alerts = source_permission_alerts(&input, true, false);
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].pane, SystemPermissionPane::Camera);
    assert_eq!(alerts[0].action_label, "Open Camera settings");
}

#[test]
fn the_screen_item_names_the_scene_on_stream() {
    // `video-sources.test.ts`'s `screenSceneLine`.
    assert_eq!(
        screen_scene_line("Figma", true),
        "Shown by “Figma”, the scene on stream. Each scene keeps its own screen."
    );
    assert_eq!(
        screen_scene_line("Camera only", false),
        "“Camera only”, the scene on stream, shows no screen. Each scene keeps its own screen."
    );
}

#[test]
fn the_description_names_linux_apart() {
    assert_eq!(
        sources_page_description("darwin"),
        "What gets recorded and streamed. Changes apply live."
    );
    assert_eq!(
        sources_page_description("linux"),
        "What gets recorded and streamed. On Linux, change them while nothing is recording or live."
    );
}
