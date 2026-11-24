//! `clips`' rules, from videorc-rust's tests and Electron's
//! `replay-buffer*.test.ts`.

use serde_json::json;

use super::*;

fn input() -> ReconcileInput {
    ReconcileInput {
        armed: true,
        replay_state: ReplayBufferState::Off,
        replay_only_buffer: false,
        recording_state: RecordingState::Idle,
        recording_replay_only: false,
        start_pending: false,
        stop_pending: false,
        start_in_flight: false,
        failed_starts: 0,
        waiting_for_camera: false,
        room_holds_camera: false,
    }
}

fn riding() -> ReconcileInput {
    ReconcileInput {
        armed: false,
        replay_state: ReplayBufferState::On,
        replay_only_buffer: true,
        recording_state: RecordingState::Recording,
        recording_replay_only: true,
        ..input()
    }
}

#[test]
fn an_armed_ring_starts_when_nothing_runs_and_gives_up_after_three() {
    assert_eq!(reconcile_action(&input()), Some(ReconcileAction::Start));
    let errored = ReconcileInput {
        replay_state: ReplayBufferState::Error,
        recording_state: RecordingState::Failed,
        ..input()
    };
    assert_eq!(reconcile_action(&errored), Some(ReconcileAction::Start));
    for busy in [
        ReconcileInput {
            start_pending: true,
            ..input()
        },
        ReconcileInput {
            stop_pending: true,
            ..input()
        },
        ReconcileInput {
            start_in_flight: true,
            ..input()
        },
        ReconcileInput {
            waiting_for_camera: true,
            ..input()
        },
        ReconcileInput {
            recording_state: RecordingState::Recording,
            ..input()
        },
        ReconcileInput {
            replay_state: ReplayBufferState::On,
            ..input()
        },
    ] {
        assert_eq!(reconcile_action(&busy), None, "{busy:?}");
    }
    assert_eq!(
        reconcile_action(&ReconcileInput {
            failed_starts: 3,
            ..input()
        }),
        Some(ReconcileAction::GiveUp)
    );
}

#[test]
fn a_disarmed_ring_stops_only_its_own_buffer_only_session() {
    assert_eq!(reconcile_action(&riding()), Some(ReconcileAction::Stop));
    assert_eq!(
        reconcile_action(&ReconcileInput {
            recording_replay_only: false,
            ..riding()
        }),
        None,
        "a ring riding a recording ends with it"
    );
    assert_eq!(
        reconcile_action(&ReconcileInput {
            stop_pending: true,
            ..riding()
        }),
        None
    );
    assert_eq!(
        reconcile_action(&ReconcileInput {
            armed: false,
            ..input()
        }),
        None
    );
}

#[test]
fn an_open_room_stops_the_buffer_only_ring_and_starts_nothing() {
    // Plan 224 D6: armed or not, the ring steps aside while the room holds
    // the camera.
    let held = ReconcileInput {
        room_holds_camera: true,
        ..input()
    };
    assert_eq!(reconcile_action(&held), None);
    assert_eq!(
        reconcile_action(&ReconcileInput {
            armed: true,
            room_holds_camera: true,
            ..riding()
        }),
        Some(ReconcileAction::Stop)
    );
    assert!(room_holds_the_camera(Some("open")));
    assert!(room_holds_the_camera(Some("opening")));
    assert!(!room_holds_the_camera(Some("closed")));
    assert!(!room_holds_the_camera(None));
}

#[test]
fn retries_back_off_and_errors_rearm_only_when_allowed() {
    assert_eq!(retry_delay(1), Duration::from_millis(500));
    assert_eq!(retry_delay(2), Duration::from_millis(1000));
    assert_eq!(retry_delay(5), Duration::from_millis(4000));
    assert_eq!(silent_camera_retry_delay(1), Duration::from_secs(1));
    assert_eq!(silent_camera_retry_delay(4), Duration::from_secs(8));
    assert_eq!(silent_camera_retry_delay(9), Duration::from_secs(8));
    assert!(should_rearm_after_error(
        false,
        ReplayBufferState::Error,
        true,
        false
    ));
    assert!(!should_rearm_after_error(
        false,
        ReplayBufferState::Error,
        true,
        true
    ));
    assert!(!should_rearm_after_error(
        true,
        ReplayBufferState::Error,
        true,
        false
    ));
    assert!(!should_rearm_after_error(
        false,
        ReplayBufferState::Off,
        true,
        false
    ));
    assert!(should_restart_for_sources(true, &RecordingState::Recording));
    assert!(!should_restart_for_sources(
        false,
        &RecordingState::Recording
    ));
    assert!(!should_restart_for_sources(true, &RecordingState::Idle));
}

#[test]
fn the_disk_estimate_and_the_words() {
    // 60 s at 6 Mbps: 33 segments of 2 s at (6000 + 192) kbps.
    assert_eq!(format_bytes(estimated_disk_bytes(60, 6000)), "51 MB");
    assert_eq!(format_bytes(0.0), "0 MB");
    assert_eq!(format_bytes(f64::NAN), "0 MB");
    assert_eq!(format_bytes(1_234_000_000.0), "1.2 GB");
    assert_eq!(format_bytes(12_300_000_000.0), "12 GB");
    assert_eq!(format_timecode(3723.0), "1:02:03");
    assert_eq!(format_timecode(30.9), "0:30");
    assert_eq!(
        disk_use(6000, "1080p · 30 fps"),
        (
            "about 51 MB".to_string(),
            "At 1080p · 30 fps, however long it runs.".to_string()
        )
    );
}

#[test]
fn the_switch_says_what_the_ring_does() {
    assert_eq!(
        switch_description(Some("Software encoder."), true, false, None),
        "Off on this computer. Software encoder."
    );
    assert_eq!(switch_description(None, false, false, None), copy::OFF);
    assert_eq!(switch_description(None, true, true, None), copy::RUNNING);
    assert_eq!(
        switch_description(None, true, false, Some(copy::WAITS_FOR_SCREEN)),
        "Starts once a source is ready. No screen is chosen. Choose one in Sources to use this scene."
    );
    assert_eq!(
        switch_description(None, true, false, None),
        copy::NOT_RUNNING
    );
}

#[test]
fn the_two_lengths_and_their_words() {
    assert!(is_clip_length(30) && is_clip_length(60) && !is_clip_length(45));
    assert_eq!(parse_clip_length(None), Ok(None));
    assert_eq!(parse_clip_length(Some(&Value::Null)), Ok(None));
    assert_eq!(parse_clip_length(Some(&json!(60))), Ok(Some(60)));
    assert_eq!(parse_clip_length(Some(&json!(30.0))), Ok(Some(30)));
    assert_eq!(
        parse_clip_length(Some(&json!(45))),
        Err(INVALID_CLIP_LENGTH_MESSAGE)
    );
    assert_eq!(
        parse_clip_length(Some(&json!("30"))),
        Err(INVALID_CLIP_LENGTH_MESSAGE)
    );
    assert_eq!(clip_length_words(None), "seconds");
    assert_eq!(clip_length_words(Some(30)), "30 seconds");
    assert_eq!(clip_length_words(Some(60)), "1 minute");
    assert_eq!(clip_length_words(Some(120)), "2 minutes");
    assert_eq!(clip_length_words(Some(90)), "1.5 minutes");
    assert_eq!(clip_last_words(Some(60)), "minute");
    assert_eq!(clip_last_words(Some(30)), "30 seconds");
    assert_eq!(clip_length_label(30), "30 s");
    assert_eq!(clip_length_label(60), "1 min");
    assert_eq!(
        clip_saving_toast(true, Some(60)),
        (
            "Saving the last 1:00 as a clip".to_string(),
            "It's in Library, and this moment is marked in your recording."
        )
    );
    assert_eq!(
        clip_saving_toast(false, None).0,
        "Saving the last seconds as a clip"
    );
}

#[test]
fn a_clip_needs_the_ring_a_session_or_an_open_room() {
    assert!(clip_has_target(
        ReplayBufferState::On,
        &RecordingState::Idle,
        false
    ));
    assert!(clip_has_target(
        ReplayBufferState::Off,
        &RecordingState::Recording,
        false
    ));
    assert!(clip_has_target(
        ReplayBufferState::Off,
        &RecordingState::Idle,
        true
    ));
    assert!(!clip_has_target(
        ReplayBufferState::Starting,
        &RecordingState::Idle,
        false
    ));
    assert_eq!(
        clip_action_refusal(Some(45), true, true, false),
        Some(INVALID_CLIP_LENGTH_MESSAGE)
    );
    assert_eq!(
        clip_action_refusal(None, false, false, false),
        Some(copy::CLIPS_OFF_INTENT)
    );
    assert_eq!(clip_action_refusal(Some(60), false, true, false), None);
    assert_eq!(clip_action_refusal(None, false, false, true), None);
}

#[test]
fn the_ring_waits_for_grants() {
    let snapshot = |screen| MediaAccessSnapshot {
        camera: MediaAccessStatus::Granted,
        microphone: MediaAccessStatus::Granted,
        screen,
    };
    let sources = json!({"screenId": "screen:1"});
    assert_eq!(
        waits_for_grant(None, &sources, &LayoutPreset::ScreenOnly),
        Some(copy::WAITS_FOR_PERMISSIONS)
    );
    assert_eq!(
        waits_for_grant(
            Some(&snapshot(MediaAccessStatus::NotDetermined)),
            &sources,
            &LayoutPreset::ScreenOnly
        ),
        Some(copy::SCREEN_NOT_ALLOWED)
    );
    assert_eq!(
        waits_for_grant(
            Some(&snapshot(MediaAccessStatus::Denied)),
            &sources,
            &LayoutPreset::ScreenOnly
        ),
        None,
        "a denied grant is not waited for"
    );
    assert_eq!(
        waits_for_grant(
            None,
            &json!({"cameraId": "camera:synthetic-preview-smoke"}),
            &LayoutPreset::CameraOnly
        ),
        None
    );
    assert_eq!(
        waits_for_grant(
            None,
            &json!({"cameraId": "camera:1", "captureOff": true}),
            &LayoutPreset::ScreenOnly
        ),
        None,
        "a screen-only scene doesn't use the camera"
    );
}

#[test]
fn the_ring_waits_for_a_screen_and_its_preview() {
    let preset = ArrangementMode::Preset;
    let screen_only = LayoutPreset::ScreenOnly;
    let sources = json!({"screenId": "screen:1"});
    assert_eq!(
        waits_for_screen(&json!({}), &screen_only, &preset, None, None, true),
        Some(copy::WAITS_FOR_SCREEN)
    );
    assert_eq!(
        waits_for_screen(
            &json!({"testPattern": true}),
            &screen_only,
            &preset,
            None,
            None,
            true
        ),
        None
    );
    assert_eq!(
        waits_for_screen(
            &json!({}),
            &screen_only,
            &ArrangementMode::Freeform,
            None,
            None,
            true
        ),
        None
    );
    assert_eq!(
        waits_for_screen(
            &json!({}),
            &LayoutPreset::CameraOnly,
            &preset,
            None,
            None,
            true
        ),
        None
    );
    let idle = json!({"state": "source-missing"});
    assert_eq!(
        waits_for_screen(&sources, &screen_only, &preset, None, Some(&idle), true),
        Some(copy::WAITS_FOR_PREVIEW)
    );
    assert_eq!(
        waits_for_screen(&sources, &screen_only, &preset, None, Some(&idle), false),
        None,
        "only where the app starts the preview itself"
    );
}

#[test]
fn waits_on_the_portal_placeholder_until_this_run_shares_a_screen() {
    let preset = ArrangementMode::Preset;
    let layout = LayoutPreset::ScreenCamera;
    let portal = json!({"screenId": PORTAL_MONITOR_SOURCE_ID});
    assert_eq!(
        waits_for_screen(&portal, &layout, &preset, None, None, true),
        Some(copy::WAITS_FOR_PORTAL_SHARE)
    );
    assert_eq!(
        waits_for_screen(
            &json!({"windowId": PORTAL_WINDOW_SOURCE_ID}),
            &layout,
            &preset,
            None,
            None,
            true
        ),
        Some(copy::WAITS_FOR_PORTAL_SHARE)
    );
    let dialog = json!({"state": "starting", "message": SCREEN_SHARE_DIALOG_PENDING_MESSAGE});
    assert_eq!(
        waits_for_screen(&portal, &layout, &preset, None, Some(&dialog), true),
        Some(copy::WAITS_FOR_SHARE_DIALOG)
    );
    assert_eq!(
        waits_for_screen(
            &portal,
            &layout,
            &preset,
            Some(PORTAL_MONITOR_SOURCE_ID),
            None,
            true
        ),
        None
    );
    assert_eq!(
        waits_for_screen(
            &portal,
            &layout,
            &preset,
            Some(PORTAL_WINDOW_SOURCE_ID),
            None,
            true
        ),
        Some(copy::WAITS_FOR_PORTAL_SHARE),
        "a granted window share does not stand in for a screen share"
    );
    assert_eq!(
        waits_for_screen(
            &portal,
            &LayoutPreset::CameraOnly,
            &preset,
            None,
            None,
            true
        ),
        None
    );
}

fn portal_status(state: &str, extra: Value) -> Value {
    let mut status = json!({
        "state": state,
        "sourceId": PORTAL_MONITOR_SOURCE_ID,
        "framesCaptured": 0
    });
    if let (Some(status), Value::Object(extra)) = (status.as_object_mut(), extra) {
        status.extend(extra);
    }
    status
}

#[test]
fn latches_and_drops_the_portal_share() {
    let granted = Some(PORTAL_MONITOR_SOURCE_ID.to_string());
    assert_eq!(
        next_portal_share_grant(None, &portal_status("source-missing", json!({}))),
        None
    );
    assert_eq!(
        next_portal_share_grant(None, &portal_status("starting", json!({}))),
        None
    );
    assert_eq!(
        next_portal_share_grant(
            None,
            &portal_status("starting", json!({"message": SCREEN_SHARE_GRANTED_MESSAGE}))
        ),
        granted
    );
    assert_eq!(
        next_portal_share_grant(None, &portal_status("live", json!({"framesCaptured": 1}))),
        granted
    );
    // A grant whose share later produces nothing is kept: that still fails.
    assert_eq!(
        next_portal_share_grant(granted.clone(), &portal_status("failed", json!({}))),
        granted
    );
    // A new dialog, or a cancelled one, drops it.
    assert_eq!(
        next_portal_share_grant(
            granted.clone(),
            &portal_status("permission-needed", json!({}))
        ),
        None
    );
    assert_eq!(
        next_portal_share_grant(
            granted.clone(),
            &portal_status(
                "starting",
                json!({"message": SCREEN_SHARE_DIALOG_PENDING_MESSAGE})
            )
        ),
        None
    );
    // Another source's dialog leaves it alone; a non-portal source is ignored.
    assert_eq!(
        next_portal_share_grant(
            granted.clone(),
            &portal_status(
                "permission-needed",
                json!({"sourceId": PORTAL_WINDOW_SOURCE_ID})
            )
        ),
        granted
    );
    assert_eq!(
        next_portal_share_grant(
            None,
            &json!({"state": "live", "sourceId": "screen:screencapturekit:1", "framesCaptured": 3})
        ),
        None
    );
}

#[test]
fn the_ring_waits_for_the_previews_the_studio_opens() {
    let sources = json!({"screenId": "screen:dxgi:1", "cameraId": "camera:windows-dshow:1"});
    let layout = LayoutPreset::ScreenCamera;
    let idle_camera = json!({"state": "device-missing", "framesCaptured": 0});
    let idle_screen = json!({"state": "source-missing", "framesCaptured": 0});
    let live_camera =
        json!({"state": "live", "cameraId": "camera:windows-dshow:1", "framesCaptured": 12});
    let live_screen = json!({"state": "live", "sourceId": "screen:dxgi:1", "framesCaptured": 9});
    let wait = |camera: &Value, screen: &Value| {
        waits_for_preview(true, &sources, &layout, Some(camera), Some(screen))
    };
    assert_eq!(
        wait(&idle_camera, &idle_screen),
        Some(copy::WAITS_FOR_SCREEN_PREVIEW)
    );
    assert_eq!(
        wait(&idle_camera, &live_screen),
        Some(copy::WAITS_FOR_CAMERA_PREVIEW)
    );
    assert_eq!(
        wait(
            &live_camera,
            &json!({"state": "live", "sourceId": "screen:dxgi:2", "framesCaptured": 30})
        ),
        Some(copy::WAITS_FOR_SCREEN_PREVIEW),
        "another source's report"
    );
    let starting = json!({"state": "starting", "sourceId": "screen:dxgi:1", "framesCaptured": 0});
    assert_eq!(
        wait(&live_camera, &starting),
        Some(copy::WAITS_FOR_SCREEN_PREVIEW)
    );
    assert_eq!(wait(&live_camera, &live_screen), None);
    for state in ["device-missing", "permission-denied", "failed"] {
        assert_eq!(
            wait(
                &json!({"state": state, "cameraId": "camera:windows-dshow:1", "framesCaptured": 0}),
                &live_screen
            ),
            None,
            "{state}"
        );
    }
    assert_eq!(
        waits_for_preview(false, &sources, &layout, None, None),
        None
    );
}

#[test]
fn the_wait_reads_setup_then_grants_then_the_screen_then_previews() {
    let sources = json!({"screenId": "screen:1"});
    let base = WaitInput {
        first_run_setup_open: false,
        media: None,
        grants_apply: true,
        sources: &sources,
        layout_preset: &LayoutPreset::ScreenOnly,
        arrangement: &ArrangementMode::Preset,
        portal_share_granted: None,
        preview_camera: None,
        preview_screen: None,
        auto_preview: true,
    };
    assert_eq!(
        wait(&WaitInput {
            first_run_setup_open: true,
            ..base
        }),
        Some(ClipsWait::FirstRunSetup)
    );
    assert_eq!(ClipsWait::FirstRunSetup.reason(), None);
    assert_eq!(
        wait(&base),
        Some(ClipsWait::Reason(copy::WAITS_FOR_PERMISSIONS))
    );
    // Off macOS there is no grant gate: the preview is next.
    assert_eq!(
        wait(&WaitInput {
            grants_apply: false,
            ..base
        }),
        Some(ClipsWait::Reason(copy::WAITS_FOR_SCREEN_PREVIEW))
    );
    let live = json!({"state": "live", "sourceId": "screen:1", "framesCaptured": 1});
    assert_eq!(
        wait(&WaitInput {
            grants_apply: false,
            preview_screen: Some(&live),
            ..base
        }),
        None
    );
}

fn camera(state: &str, id: Option<&str>, frames: u64, no_video: bool) -> CameraReport {
    CameraReport {
        state: state.to_string(),
        camera_id: id.map(str::to_string),
        frames_captured: frames,
        no_video,
    }
}

#[test]
fn a_silent_camera_backs_off_then_waits_for_its_frame() {
    let chosen = Some("camera:1");
    let live = camera("live", Some("camera:1"), 0, false);
    assert_eq!(
        after_sources_not_ready(&live, chosen, 1),
        SourcesNotReadyNext::Retry(Duration::from_secs(1))
    );
    assert_eq!(
        after_sources_not_ready(&live, chosen, 4),
        SourcesNotReadyNext::Retry(Duration::from_secs(8))
    );
    assert_eq!(
        after_sources_not_ready(&live, chosen, 5),
        SourcesNotReadyNext::WaitForFrames
    );
    assert_eq!(
        after_sources_not_ready(&camera("live", Some("camera:1"), 0, true), chosen, 1),
        SourcesNotReadyNext::WaitForFrames,
        "the backend already gave up on a picture"
    );
    assert_eq!(
        after_sources_not_ready(&camera("starting", Some("camera:1"), 0, false), chosen, 0),
        SourcesNotReadyNext::WaitForLive
    );
    assert_eq!(
        after_sources_not_ready(&camera("device-missing", None, 0, false), chosen, 0),
        SourcesNotReadyNext::WaitForLive,
        "no report for a camera yet"
    );
    assert_eq!(
        after_sources_not_ready(&camera("failed", Some("camera:2"), 0, false), chosen, 0),
        SourcesNotReadyNext::WaitForLive,
        "being switched"
    );
    assert_eq!(
        after_sources_not_ready(&camera("failed", Some("camera:1"), 0, false), chosen, 0),
        SourcesNotReadyNext::Failed
    );
    assert!(camera("live", Some("camera:1"), 3, false).delivers());
    assert!(!camera("live", Some("camera:1"), 3, true).delivers());
    assert!(!camera("starting", Some("camera:1"), 3, false).delivers());
    assert_eq!(
        CameraReport::from_status(&json!({
            "state": "live", "cameraId": "camera:1", "framesCaptured": 2, "noVideo": true
        })),
        camera("live", Some("camera:1"), 2, true)
    );
}
