//! `lib/scene-studio.test.ts`, case for case: a scene as the Studio applies
//! it (plan 231 S2), the D18/D19 rules, and the store reads the file also
//! covers (D11 autosave, D14, D16). The first-run look case is not here:
//! `scenesWithFirstRunLook` is not ported.

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::migration::default_scenes;
use super::model::{SavedScene, SceneAudio, normalize_scene_visual};
use super::store::{DeleteRule, EditAutosave, can_delete_scene, scene_edit_autosave};
use super::v2::*;
use super::view::*;

const NOW: &str = "2026-11-15T12:00:00.000Z";
const LATER: &str = "2026-11-15T13:00:00.000Z";

fn display1() -> MainDisplay {
    MainDisplay {
        id: "screen:1".into(),
        name: "Display 1".into(),
        display_uuid: Some("uuid-1".into()),
    }
}

fn camera() -> Value {
    json!({"cameraId": "camera:1", "cameraName": "FaceTime", "cameraOff": false})
}

/// A new user's four scenes: Screen + camera, Screen only, Camera only,
/// Side by side.
fn defaults() -> Vec<Scene> {
    default_scenes(Some(&display1()), NOW)
}

fn by_layout(scenes: &[Scene], preset: &str) -> Scene {
    scenes
        .iter()
        .find(|scene| layout_preset(&scene.horizontal) == preset)
        .unwrap()
        .clone()
}

fn figma_shows() -> SceneShows {
    SceneShows::App {
        bundle_id: "com.figma.Desktop".into(),
        name: "Figma".into(),
        follows: true,
    }
}

fn figma() -> Scene {
    Scene {
        id: "figma".into(),
        name: "Figma".into(),
        shows: figma_shows(),
        ..by_layout(&defaults(), "screen-camera")
    }
}

fn t3() -> SceneShows {
    SceneShows::App {
        bundle_id: "dev.t3".into(),
        name: "T3 Code".into(),
        follows: true,
    }
}

/// `{...base, ...patch}` on JSON objects.
fn spread(base: &Value, patch: Value) -> Value {
    let mut out = base.clone();
    for (key, value) in patch.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

/// The working look and sources a commit confirms.
fn working(scene: &Scene, sources: Value, layout: Value) -> Value {
    normalize_scene_visual(&json!({
        "layout": spread(&scene.horizontal, layout),
        "sources": spread(&camera(), sources),
        "background": scene.background,
    }))
    .unwrap()
}

/// `expect(sources).toMatchObject(expected)`: every expected key, an
/// absent one for `null` (`undefined`).
fn assert_matches(actual: &Value, expected: Value) {
    for (key, value) in expected.as_object().unwrap() {
        if value.is_null() {
            assert_eq!(actual.get(key), None, "{key} in {actual}");
        } else {
            assert_eq!(actual.get(key), Some(value), "{key} in {actual}");
        }
    }
}

fn sources_of(saved: &SavedScene) -> &Value {
    &saved.visual["sources"]
}

// ── a scene as the Studio applies it (plan 231 S2) ───────────────────────

#[test]
fn reads_a_scene_in_the_studio_orientation_with_the_one_shared_camera_d9() {
    let scene = figma();
    let horizontal = saved_scene_view(&scene, Orientation::Horizontal, &camera());
    assert_eq!(horizontal.visual["layout"], scene.horizontal);
    assert_matches(
        sources_of(&horizontal),
        json!({
            "cameraId": "camera:1",
            "cameraName": "FaceTime",
            "app": {"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}
        }),
    );
    assert_eq!(sources_of(&horizontal).get("windowId"), None);
    assert_eq!(
        saved_scene_view(&scene, Orientation::Vertical, &camera()).visual["layout"],
        scene.vertical
    );
    // Another camera in Sources is every scene's camera: the scene keeps none.
    let other = saved_scene_view(
        &scene,
        Orientation::Horizontal,
        &json!({"cameraId": "camera:2", "cameraName": "USB"}),
    );
    assert_matches(
        sources_of(&other),
        json!({"cameraId": "camera:2", "cameraName": "USB"}),
    );
}

#[test]
fn a_scene_that_shows_no_screen_reads_as_screen_none() {
    let none = by_layout(&defaults(), "camera-only");
    assert_eq!(none.shows, SceneShows::None);
    assert_matches(
        sources_of(&saved_scene_view(&none, Orientation::Horizontal, &camera())),
        json!({"captureOff": true, "screenId": null, "windowId": null}),
    );
}

#[test]
fn writes_an_edited_snapshot_back_without_its_camera_keeping_the_other_layout() {
    let scene = figma();
    let view = saved_scene_view(&scene, Orientation::Horizontal, &camera());
    let edited = SavedScene {
        name: "Figma board".into(),
        visual: normalize_scene_visual(&spread(
            &view.visual,
            json!({
                "layout": spread(&view.visual["layout"], json!({"layoutPreset": "side-by-side"})),
                "sources": {"cameraId": "camera:9", "windowId": "window:7", "windowName": "Board"}
            }),
        ))
        .unwrap(),
        ..view.clone()
    };
    let stored = scene_from_saved(&edited, &scene);
    assert_eq!(stored.name, "Figma board");
    assert_eq!(
        stored.shows,
        SceneShows::Window {
            window_id: "window:7".into(),
            window_name: Some("Board".into())
        }
    );
    assert_eq!(layout_preset(&stored.horizontal), "side-by-side");
    assert_eq!(stored.vertical, scene.vertical);
    assert!(!stored.to_json().to_string().contains("camera:9"));
}

#[test]
fn a_new_scene_takes_the_9_16_layout_of_the_scene_it_is_made_from_d6() {
    let on_stream = by_layout(&defaults(), "screen-only");
    let view = saved_scene_view(&figma(), Orientation::Horizontal, &camera());
    let stored = scene_from_saved(
        &SavedScene {
            id: "new".into(),
            name: "New".into(),
            ..view.clone()
        },
        &on_stream,
    );
    assert_eq!(stored.horizontal, view.visual["layout"]);
    assert_eq!(stored.vertical, on_stream.vertical);
}

#[test]
fn splits_a_snapshot_into_its_screen_and_its_camera() {
    let view = saved_scene_view(&figma(), Orientation::Horizontal, &camera());
    let sources = sources_of(&view);
    // `Object.keys(captureSources(sources))` is every capture key, an absent
    // one `undefined`. Rust can't hold `undefined`: `CAPTURE_KEYS` is the
    // list, `capture_sources` keeps the present ones, and
    // `apply_capture_sources` clears the rest.
    let mut keys = CAPTURE_KEYS.to_vec();
    keys.sort();
    assert_eq!(
        keys,
        [
            "captureOff",
            "screenId",
            "screenName",
            "screenUuid",
            "testPattern",
            "windowId",
            "windowName"
        ]
    );
    let capture = capture_sources(sources);
    assert!(
        capture
            .keys()
            .all(|key| CAPTURE_KEYS.contains(&key.as_str()))
    );
    let mut stale = json!({
        "screenId": "screen:old",
        "screenName": "Old",
        "screenUuid": "uuid-old",
        "windowId": "window:old",
        "windowName": "Old",
        "captureOff": true,
        "testPattern": true,
        "cameraId": "camera:1"
    })
    .as_object()
    .unwrap()
    .clone();
    apply_capture_sources(&mut stale, sources);
    let mut expected = capture.clone();
    expected.insert("cameraId".into(), json!("camera:1"));
    assert_eq!(stale, expected);
    assert_eq!(Value::Object(camera_sources(sources)), camera());
}

// ── the scene on stream at launch ────────────────────────────────────────

#[test]
fn on_stream_at_launch_is_the_one_the_library_names_while_the_look_has_its_layout() {
    let all = defaults();
    let screen_only = &all[1];
    assert_eq!(
        scene_on_stream_at_launch(&all, &screen_only.id, &screen_only.horizontal),
        screen_only.id
    );
    // A Freeform arrangement keeps the scene it was made on.
    assert_eq!(
        scene_on_stream_at_launch(
            &all,
            &screen_only.id,
            &spread(
                &screen_only.horizontal,
                json!({"arrangementMode": "freeform"})
            )
        ),
        screen_only.id
    );
    // In a 9:16 studio the scene's 9:16 layout decides.
    assert_eq!(
        scene_on_stream_at_launch(&all, &screen_only.id, &screen_only.vertical),
        screen_only.id
    );
}

#[test]
fn on_stream_at_launch_is_the_first_scene_with_the_layout_that_launched_when_the_named_one_has_another()
 {
    let all = defaults();
    let (screen_camera, screen_only) = (&all[0], &all[1]);
    // A capture config seeded from outside: Screen only is what is on stream.
    assert_eq!(
        scene_on_stream_at_launch(&all, &screen_camera.id, &screen_only.horizontal),
        screen_only.id
    );
    // No scene has the layout: the named scene stays.
    assert_eq!(
        scene_on_stream_at_launch(&all[..1], &screen_camera.id, &screen_only.horizontal),
        screen_camera.id
    );
}

// ── a scene that shows no screen keeps the capture (D18) ─────────────────

#[test]
fn keeps_the_capture_only_while_its_layout_draws_no_screen() {
    let none = by_layout(&defaults(), "camera-only");
    assert!(scene_keeps_capture(Some(&none), &none.horizontal, false));
    // A layout with a screen on a scene that shows none asks for one instead.
    assert!(!scene_keeps_capture(
        Some(&none),
        &spread(&none.horizontal, json!({"layoutPreset": "screen-camera"})),
        false
    ));
    assert!(!scene_keeps_capture(
        Some(&none),
        &spread(&none.horizontal, json!({"arrangementMode": "freeform"})),
        false
    ));
}

#[test]
fn also_keeps_a_screen_owning_scenes_capture_while_its_layout_draws_no_screen() {
    let scene = figma();
    assert!(scene_keeps_capture(
        Some(&scene),
        &spread(&scene.horizontal, json!({"layoutPreset": "camera-only"})),
        false
    ));
    assert!(!scene_keeps_capture(None, &scene.horizontal, false));
}

/// Review #1: the vertical stream is a leg too. A scene with Camera only on
/// the program and its screen on the 9:16 leg shows its own screen there.
fn camera_only_then_screen() -> Scene {
    let scene = figma();
    Scene {
        horizontal: spread(&scene.horizontal, json!({"layoutPreset": "camera-only"})),
        vertical: spread(
            &scene.vertical,
            json!({"layoutPreset": "vertical-screen-only"}),
        ),
        ..scene
    }
}

#[test]
fn judges_every_leg_that_is_on_the_program_and_the_vertical_stream_while_armed() {
    let scene = camera_only_then_screen();
    let program = &scene.horizontal;
    assert_eq!(scene_leg_layouts(&scene, program, false), vec![program]);
    assert_eq!(
        scene_leg_layouts(&scene, program, true),
        vec![program, &scene.vertical]
    );
    assert!(!scene_draws_screen(&scene, program, false));
    assert!(scene_draws_screen(&scene, program, true));
    assert!(scene_keeps_capture(Some(&scene), program, false));
    assert!(!scene_keeps_capture(Some(&scene), program, true));
    // A 9:16 studio's program is the 9:16 layout: there is no second leg.
    assert_eq!(
        scene_leg_layouts(&scene, &scene.vertical, true),
        vec![&scene.vertical]
    );
    // A scene no leg draws a screen for keeps the capture with the leg armed.
    let none = by_layout(&defaults(), "camera-only");
    assert!(scene_keeps_capture(Some(&none), &none.horizontal, true));
}

#[test]
fn a_capture_kept_from_another_scene_is_never_the_scenes_own_d18() {
    let scene = figma();
    assert!(scene_capture_is_borrowed(&scene, &t3()));
    assert!(!scene_capture_is_borrowed(
        &scene,
        &scene.shows.with_follows(false)
    ));
    // A scene that shows none has no screen of its own: Change screen… decides.
    assert!(!scene_capture_is_borrowed(
        &by_layout(&defaults(), "camera-only"),
        &t3()
    ));
    assert_eq!(
        no_screen_layout_reason("Camera only"),
        "“Camera only” shows no screen. Choose one with Change screen… first."
    );
}

#[test]
fn the_vertical_leg_borrows_a_screen_only_while_the_program_draws_none() {
    let scene = camera_only_then_screen();
    assert!(vertical_leg_borrows_screen(
        &scene,
        &scene.horizontal,
        true,
        &t3()
    ));
    assert!(!vertical_leg_borrows_screen(
        &scene,
        &scene.horizontal,
        false,
        &t3()
    ));
    assert!(!vertical_leg_borrows_screen(
        &scene,
        &scene.horizontal,
        true,
        &scene.shows
    ));
    assert!(!vertical_leg_borrows_screen(
        &scene,
        &spread(&scene.horizontal, json!({"layoutPreset": "screen-camera"})),
        true,
        &t3()
    ));
}

#[test]
fn keeps_a_running_capture_only_for_the_target_it_captures() {
    assert!(same_capture_target(
        &json!({"screenId": "screen:1"}),
        &json!({"screenId": "screen:1"})
    ));
    assert!(!same_capture_target(
        &json!({"screenId": "screen:1"}),
        &json!({"screenId": "screen:2"})
    ));
    assert!(!same_capture_target(
        &json!({"windowId": "window:1"}),
        &json!({"screenId": "screen:1"})
    ));
    assert!(!same_capture_target(
        &json!({"testPattern": true}),
        &json!({})
    ));
}

// ── edits save into the scene on stream (D11) ────────────────────────────

fn edit_scenes() -> Vec<Scene> {
    let mut all = vec![figma()];
    all.extend(defaults());
    all
}

fn figma_sources() -> Value {
    json!({
        "windowId": "window:3",
        "windowName": "Figma - Untitled",
        "app": {"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}
    })
}

fn autosave(
    previous_scene_id: Option<&str>,
    previous_shows: Option<&SceneShows>,
    scene_id: &str,
    scenes: &[Scene],
    visual: &Value,
) -> Option<Scene> {
    scene_edit_autosave(&EditAutosave {
        previous_scene_id,
        previous_shows,
        scene_id: Some(scene_id),
        scenes,
        visual,
        now: LATER,
    })
}

#[test]
fn saves_the_look_into_the_layout_of_the_committed_orientation() {
    let all = edit_scenes();
    let visual = working(&all[0], figma_sources(), json!({"cameraZoom": 150}));
    let saved = autosave(Some("figma"), Some(&all[0].shows), "figma", &all, &visual).unwrap();
    assert_eq!(saved.horizontal["cameraZoom"], 150);
    assert_eq!(saved.vertical, all[0].vertical);
    assert_eq!(saved.shows, all[0].shows);
    assert_eq!(saved.updated_at, LATER);
}

#[test]
fn a_9_16_commit_saves_into_the_9_16_layout_and_leaves_the_16_9_one() {
    let all = edit_scenes();
    let visual = normalize_scene_visual(&json!({
        "layout": spread(&all[0].vertical, json!({"cameraZoom": 130})),
        "sources": spread(&camera(), figma_sources()),
        "background": null
    }))
    .unwrap();
    let saved = autosave(Some("figma"), Some(&all[0].shows), "figma", &all, &visual).unwrap();
    assert_eq!(saved.vertical["cameraZoom"], 130);
    assert_eq!(saved.horizontal, all[0].horizontal);
}

#[test]
fn the_commit_that_puts_a_scene_on_stream_is_a_switch_never_an_edit() {
    let all = edit_scenes();
    let visual = working(&all[0], figma_sources(), json!({"cameraZoom": 150}));
    for previous_scene_id in [None, Some(all[1].id.as_str())] {
        assert_eq!(
            autosave(previous_scene_id, None, "figma", &all, &visual),
            None
        );
    }
}

#[test]
fn writes_nothing_when_the_scene_already_keeps_the_look_and_the_screen() {
    let all = edit_scenes();
    let visual = working(&all[0], figma_sources(), json!({}));
    assert_eq!(
        autosave(Some("figma"), Some(&all[0].shows), "figma", &all, &visual),
        None
    );
}

#[test]
fn a_screen_pick_changes_the_screen_of_the_scene_on_stream_d2() {
    let all = edit_scenes();
    let visual = working(
        &all[0],
        json!({"screenId": "screen:2", "screenName": "Display 2", "screenUuid": "uuid-2"}),
        json!({}),
    );
    let saved = autosave(Some("figma"), Some(&all[0].shows), "figma", &all, &visual).unwrap();
    assert_eq!(saved.id, "figma");
    assert_eq!(
        saved.shows,
        SceneShows::Display {
            screen_id: "screen:2".into(),
            screen_name: Some("Display 2".into()),
            screen_uuid: Some("uuid-2".into())
        }
    );
    // Only the screen changed: no other scene is written, none is left.
    assert_eq!(saved.horizontal, all[0].horizontal);
    assert_eq!(saved.vertical, all[0].vertical);
}

#[test]
fn an_apps_front_window_changing_is_not_a_pick() {
    let all = edit_scenes();
    let visual = working(
        &all[0],
        spread(
            &figma_sources(),
            json!({"windowId": "window:9", "windowName": "Other"}),
        ),
        json!({}),
    );
    assert_eq!(
        autosave(Some("figma"), Some(&all[0].shows), "figma", &all, &visual),
        None
    );
}

#[test]
fn a_scene_that_shows_no_screen_keeps_showing_none_under_a_kept_capture_d18() {
    let all = edit_scenes();
    let none = by_layout(&all, "camera-only");
    // Camera only went on stream over Figma's running capture, then its
    // camera was zoomed: the screen under it is no pick.
    let visual = working(&none, figma_sources(), json!({"cameraZoom": 140}));
    let saved = autosave(
        Some(none.id.as_str()),
        Some(&all[0].shows),
        &none.id,
        &all,
        &visual,
    )
    .unwrap();
    assert_eq!(saved.shows, SceneShows::None);
    assert_eq!(saved.horizontal["cameraZoom"], 140);
}

/// Review #1, #4: the capture another scene left running never becomes the
/// screen of a scene that shows none, whatever layout it takes (D19 asks).
#[test]
fn never_takes_a_kept_capture_as_its_screen_even_under_a_screen_layout() {
    let all = edit_scenes();
    let none = by_layout(&all, "camera-only");
    let visual = working(
        &none,
        figma_sources(),
        json!({"layoutPreset": "screen-camera"}),
    );
    let saved = autosave(
        Some(none.id.as_str()),
        Some(&all[0].shows),
        &none.id,
        &all,
        &visual,
    )
    .unwrap();
    assert_eq!(saved.shows, SceneShows::None);
}

#[test]
fn an_edit_never_writes_audio() {
    let all = edit_scenes();
    let pinned = Scene {
        audio: Some(SceneAudio {
            microphone_id: Some("mic:1".into()),
            microphone_name: None,
            microphone_off: false,
            system_audio_enabled: true,
        }),
        ..all[0].clone()
    };
    let mut scenes = vec![pinned.clone()];
    scenes.extend(all[1..].iter().cloned());
    let visual = working(&pinned, figma_sources(), json!({"cameraZoom": 120}));
    let saved = autosave(
        Some("figma"),
        Some(&pinned.shows),
        "figma",
        &scenes,
        &visual,
    )
    .unwrap();
    assert_eq!(saved.audio, pinned.audio);
}

#[test]
fn a_pick_writes_the_screen_at_once_and_nothing_when_it_is_the_same() {
    let scene = figma();
    let picked = scene_with_shows(&scene, SceneShows::None, LATER).unwrap();
    assert_eq!(picked.shows, SceneShows::None);
    assert_eq!(picked.updated_at, LATER);
    assert_eq!(scene_with_shows(&scene, scene.shows.clone(), LATER), None);
}

// ── a scene's display, as listed now (plan 213 F1) ───────────────────────

fn screen(id: &str, display_uuid: &str) -> Device {
    Device {
        app: None,
        window_title: None,
        display_uuid: Some(display_uuid.into()),
        id: id.into(),
        name: "Display 1".into(),
        kind: DeviceKind::Screen,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
    }
}

#[test]
fn follows_its_display_to_a_new_id_without_counting_as_an_edit() {
    let scene = by_layout(&defaults(), "screen-only");
    let refreshed = scene_display_refreshed(&scene, &[screen("screen:7", "uuid-1")]).unwrap();
    assert!(matches!(
        &refreshed.shows,
        SceneShows::Display { screen_id, .. } if screen_id == "screen:7"
    ));
    assert_eq!(refreshed.updated_at, scene.updated_at);
    assert_eq!(
        scene_display_refreshed(&scene, &[screen("screen:1", "uuid-1")]),
        None
    );
    assert_eq!(
        scene_display_refreshed(&figma(), &[screen("screen:7", "uuid-1")]),
        None
    );
}

// ── what a layout means to a key or a remote (D14) ───────────────────────

#[test]
fn a_layout_is_the_first_scene_with_that_layout_in_the_studio_orientation_or_none() {
    let all = edit_scenes();
    let first = |preset: &str| {
        first_scene_with_layout(&all, Orientation::Horizontal, preset).map(|scene| scene.id.clone())
    };
    // Figma is Screen + camera and comes first.
    assert_eq!(first("screen-camera").as_deref(), Some("figma"));
    assert_eq!(
        first("side-by-side"),
        Some(by_layout(&all, "side-by-side").id)
    );
    // No scene uses a 9:16 layout in a 16:9 studio: the switch is refused.
    assert_eq!(first("vertical-split"), None);
}

// ── deleting a scene (D16) ───────────────────────────────────────────────

#[test]
fn off_air_the_scene_on_stream_gives_way_to_the_one_before_it() {
    let all = defaults();
    assert_eq!(
        can_delete_scene(&all, &all[2].id, &all[2].id, false, false),
        DeleteRule::Allowed {
            switch_to: Some(all[1].id.clone())
        }
    );
    assert_eq!(
        can_delete_scene(&all, &all[0].id, &all[0].id, false, false),
        DeleteRule::Allowed {
            switch_to: Some(all[1].id.clone())
        }
    );
}

#[test]
fn while_recording_or_live_the_scene_on_stream_stays_the_last_scene_always_does() {
    let all = defaults();
    assert_eq!(
        can_delete_scene(&all, &all[2].id, &all[2].id, true, false),
        DeleteRule::Refused(Some("Switch to another scene first."))
    );
    assert_eq!(
        can_delete_scene(&all, &all[1].id, &all[2].id, true, false),
        DeleteRule::Allowed { switch_to: None }
    );
    assert_eq!(
        can_delete_scene(&all[..1], &all[0].id, &all[0].id, false, false),
        DeleteRule::Refused(Some("Keep at least one scene."))
    );
}

/// Review #2: a scene going on stream can't be deleted under its switch,
/// idle or live, on stream or not.
#[test]
fn a_scene_going_on_stream_stays_until_its_switch_is_over() {
    let all = defaults();
    for session_active in [false, true] {
        assert_eq!(
            can_delete_scene(&all, &all[1].id, &all[2].id, session_active, true),
            DeleteRule::Refused(Some(
                "This scene is going on stream. Try again in a moment."
            ))
        );
    }
}
