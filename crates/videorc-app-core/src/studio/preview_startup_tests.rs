use serde_json::json;

use super::*;

fn source(
    kind: PreviewStartupSourceKind,
    name: Option<&str>,
    live: bool,
    blocked: bool,
) -> PreviewStartupSource {
    PreviewStartupSource {
        kind,
        name: name.map(str::to_string),
        live,
        blocked,
    }
}

fn screen(name: Option<&str>, live: bool) -> PreviewStartupSource {
    source(PreviewStartupSourceKind::Screen, name, live, false)
}

fn camera(name: Option<&str>, live: bool) -> PreviewStartupSource {
    source(PreviewStartupSourceKind::Camera, name, live, false)
}

#[test]
fn the_step_follows_the_engine_then_the_sources() {
    assert_eq!(
        preview_startup_step(false, &[screen(None, true)]),
        PreviewStartupStep::Engine
    );
    assert_eq!(
        preview_startup_step(true, &[screen(None, true), camera(None, false)]),
        PreviewStartupStep::Sources
    );
    assert_eq!(
        preview_startup_step(true, &[screen(None, true), camera(None, true)]),
        PreviewStartupStep::FirstFrame
    );
    // No source to wait for: straight to the first frame.
    assert_eq!(
        preview_startup_step(true, &[]),
        PreviewStartupStep::FirstFrame
    );
}

#[test]
fn step_one_waits_for_the_capture_engine() {
    let view = preview_startup_view(false, &[], false);
    assert_eq!(view.title, "Starting the preview");
    assert_eq!(view.detail, "Waiting for the capture engine");
    assert_eq!(view.action, None);
    let stalled = preview_startup_view(false, &[], true);
    assert_eq!(
        stalled.detail,
        "The capture engine is taking longer than usual."
    );
    assert!(stalled.stalled);
    assert_eq!(stalled.action, None);
}

#[test]
fn step_two_names_the_sources_it_waits_for() {
    let named = [
        screen(Some("LG HDR 4K · 3840×2160"), false),
        camera(Some("ZV-E10M2"), false),
    ];
    assert_eq!(
        preview_startup_view(true, &named, false).detail,
        "Connecting LG HDR 4K and ZV-E10M2"
    );
    let unnamed = [screen(None, false), camera(Some("  "), false)];
    assert_eq!(
        preview_startup_view(true, &unnamed, false).detail,
        "Connecting your screen and camera"
    );
    // Only the ones not live yet.
    let one = [screen(Some("LG HDR 4K"), true), camera(None, false)];
    let view = preview_startup_view(true, &one, false);
    assert_eq!(view.detail, "Connecting your camera");
    assert!(!view.stalled);
    assert_eq!(view.action, None);
}

#[test]
fn a_stuck_source_says_so_and_offers_open_sources() {
    let one = [screen(None, false)];
    let view = preview_startup_view(true, &one, true);
    assert_eq!(view.detail, "Your screen hasn\u{2019}t sent a picture yet.");
    assert!(view.stalled);
    assert_eq!(view.action, Some(PreviewStartupAction::OpenSources));

    let two = [screen(Some("LG HDR 4K"), false), camera(None, false)];
    assert_eq!(
        preview_startup_view(true, &two, true).detail,
        "LG HDR 4K and your camera haven\u{2019}t sent a picture yet."
    );

    // A blocked source says so at once, without the stall.
    let blocked = [source(
        PreviewStartupSourceKind::Camera,
        Some("ZV-E10M2"),
        false,
        true,
    )];
    let view = preview_startup_view(true, &blocked, false);
    assert_eq!(view.detail, "ZV-E10M2 hasn\u{2019}t sent a picture yet.");
    assert!(view.stalled);
    assert_eq!(view.action, Some(PreviewStartupAction::OpenSources));
}

#[test]
fn three_names_join_with_commas_and_and() {
    let three = [
        screen(Some("A"), false),
        camera(Some("B"), false),
        camera(Some("C"), false),
    ];
    assert_eq!(
        preview_startup_view(true, &three, false).detail,
        "Connecting A, B and C"
    );
}

#[test]
fn step_three_draws_the_first_frame() {
    let live = [screen(None, true)];
    assert_eq!(
        preview_startup_view(true, &live, false).detail,
        "Drawing the first frame"
    );
    let view = preview_startup_view(true, &live, true);
    assert_eq!(view.detail, "The first frame is taking longer than usual.");
    assert_eq!(view.action, None);
}

#[test]
fn segments_read_done_current_stalled_next() {
    let view = preview_startup_view(true, &[screen(None, false)], false);
    let states: Vec<SegmentState> = PREVIEW_STARTUP_STEPS
        .iter()
        .map(|segment| preview_startup_segment_state(*segment, &view))
        .collect();
    assert_eq!(
        states,
        vec![
            SegmentState::Done,
            SegmentState::Current,
            SegmentState::Next
        ]
    );
    let stalled = preview_startup_view(true, &[screen(None, false)], true);
    assert_eq!(
        preview_startup_segment_state(PreviewStartupStep::Sources, &stalled),
        SegmentState::Stalled
    );
    assert_eq!(SegmentState::Next.value(), 0.0);
    assert_eq!(SegmentState::Stalled.value(), 100.0);
    assert_eq!(step_words(PreviewStartupStep::Sources), "Step 2 of 3");
}

#[test]
fn sources_come_from_the_choice_and_the_live_statuses() {
    let choice = json!({
        "screenId": "screen:1",
        "screenName": "LG HDR 4K",
        "cameraId": "cam:1",
        "cameraName": "ZV-E10M2",
    });
    let screen_live = json!({ "state": "live", "targetFps": 30 });
    let camera_starting = json!({ "state": "starting", "targetFps": 30 });
    let sources = preview_startup_sources(&choice, Some(&screen_live), Some(&camera_starting));
    assert_eq!(
        sources,
        vec![
            source(
                PreviewStartupSourceKind::Screen,
                Some("LG HDR 4K"),
                true,
                false
            ),
            source(
                PreviewStartupSourceKind::Camera,
                Some("ZV-E10M2"),
                false,
                false
            ),
        ]
    );
}

#[test]
fn a_live_camera_without_video_still_waits() {
    let choice = json!({ "cameraId": "cam:1" });
    let no_video = json!({ "state": "live", "noVideo": true });
    let sources = preview_startup_sources(&choice, None, Some(&no_video));
    assert_eq!(
        sources,
        vec![source(PreviewStartupSourceKind::Camera, None, false, false)]
    );
}

#[test]
fn blocked_states_and_no_status_yet() {
    let choice =
        json!({ "windowId": "window:9", "windowName": "Notes", "wantedCameraId": "cam:2" });
    let missing = json!({ "state": "source-missing" });
    let denied = json!({ "state": "permission-needed" });
    let sources = preview_startup_sources(&choice, Some(&missing), Some(&denied));
    assert!(sources.iter().all(|source| source.blocked && !source.live));
    assert_eq!(sources[0].name.as_deref(), Some("Notes"));
    // No status yet: waiting, not blocked.
    let sources = preview_startup_sources(&choice, None, None);
    assert!(sources.iter().all(|source| !source.blocked && !source.live));
    // A camera's `source-missing` is the screen's word, not the camera's.
    let camera_only = json!({ "cameraId": "cam:1" });
    let sources = preview_startup_sources(&camera_only, None, Some(&missing));
    assert!(!sources[0].blocked);
}

#[test]
fn the_test_pattern_and_switched_off_sources_are_never_waited_for() {
    let pattern = json!({ "screenId": "screen:1", "testPattern": true, "cameraId": "cam:1", "cameraOff": true });
    assert!(preview_startup_sources(&pattern, None, None).is_empty());
    let off = json!({ "screenId": "screen:1", "captureOff": true });
    assert!(preview_startup_sources(&off, None, None).is_empty());
    assert!(preview_startup_sources(&json!({}), None, None).is_empty());
}

#[test]
fn names_fall_back_in_electrons_order() {
    // `screenName ?? windowName ?? wantedWindowName ?? wantedScreenName`.
    let choice = json!({
        "wantedScreenId": "screen:2",
        "wantedWindowName": "Keynote",
        "wantedScreenName": "Studio Display",
    });
    let sources = preview_startup_sources(&choice, None, None);
    assert_eq!(sources[0].name.as_deref(), Some("Keynote"));
    // `??` keeps an empty name, which then reads as the kind.
    let empty = json!({ "screenId": "screen:1", "screenName": "", "windowName": "Notes" });
    let sources = preview_startup_sources(&empty, None, None);
    assert_eq!(sources[0].name.as_deref(), Some(""));
    assert_eq!(preview_startup_source_name(&sources[0]), "your screen");
    let camera = json!({ "wantedCameraId": "cam:2", "wantedCameraName": "FaceTime HD" });
    let sources = preview_startup_sources(&camera, None, None);
    assert_eq!(sources[0].name.as_deref(), Some("FaceTime HD"));
}

#[test]
fn the_stall_clock_restarts_with_each_step() {
    let start = Instant::now();
    let mut clock = StallClock::default();
    assert_eq!(clock.deadline(), None);
    assert!(!clock.observe(PreviewStartupStep::Engine, start));
    assert_eq!(clock.deadline(), Some(start + PREVIEW_STARTUP_STALL));
    let later = start + PREVIEW_STARTUP_STALL - Duration::from_millis(1);
    assert!(!clock.observe(PreviewStartupStep::Engine, later));
    let stalled_at = start + PREVIEW_STARTUP_STALL;
    assert!(clock.observe(PreviewStartupStep::Engine, stalled_at));
    // A new step gets its own full budget.
    assert!(!clock.observe(PreviewStartupStep::Sources, stalled_at));
    // A revisit after a reconnect starts over.
    let back = stalled_at + PREVIEW_STARTUP_STALL;
    assert!(clock.observe(PreviewStartupStep::Sources, back));
    assert!(!clock.observe(PreviewStartupStep::Engine, back));
    // The card left: its next showing starts the clock again.
    clock.reset();
    assert_eq!(clock.deadline(), None);
    assert!(!clock.observe(PreviewStartupStep::Engine, back + PREVIEW_STARTUP_STALL));
}
