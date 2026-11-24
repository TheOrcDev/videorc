//! `lib/scene-app-picker.test.ts`, case for case: Add scene… and Change
//! screen… (plan 231 D6).

use std::collections::HashSet;

use serde_json::{Value, json};
use videorc_protocol::Device;

use super::list::duplicated_scene;
use super::model::SceneAudio;
use super::picker::*;
use super::section::scene_slot_accelerator;
use super::v2::{Scene, SceneShows, layout_preset, scene_position};
use crate::studio::capture_config::default_layout;

/// `{...base, ...patch}` on JSON objects.
fn spread(base: Value, patch: Value) -> Value {
    let mut out = base;
    for (key, value) in patch.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn device(raw: Value) -> Device {
    serde_json::from_value(raw).unwrap()
}

fn window(id: &str, bundle_id: &str, name: &str, extra: Value) -> Device {
    device(spread(
        json!({
            "id": id,
            "name": format!("{name} - {id}"),
            "windowTitle": id,
            "kind": "window",
            "status": "available",
            "width": 1280,
            "height": 800,
            "app": {"bundleId": bundle_id, "name": name, "pid": 4}
        }),
        extra,
    ))
}

fn layout(preset: &str, extra: Value) -> Value {
    spread(
        default_layout(),
        spread(
            json!({"layoutPreset": preset, "cameraZoom": 140, "cameraShape": "circle"}),
            extra,
        ),
    )
}

/// The scene on stream: Figma in Screen + camera, Camera top on the
/// vertical leg.
fn on_stream_with(horizontal: Value, vertical: Value) -> Scene {
    Scene {
        id: "figma".into(),
        name: "Figma".into(),
        created_at: "2026-11-01".into(),
        updated_at: "2026-11-01".into(),
        shows: SceneShows::App {
            bundle_id: "com.figma.Desktop".into(),
            name: "Figma".into(),
            follows: true,
        },
        horizontal,
        vertical,
        background: json!({
            "assetId": "builtin-bg-01",
            "fit": "fill",
            "scale": 100,
            "offsetX": 0,
            "offsetY": 0,
            "blurPx": 0,
            "dimPercent": 0,
            "saturationPercent": 100,
            "vignettePercent": 0,
            "visibilityPercent": 20
        }),
        audio: None,
        cloud: None,
    }
}

fn on_stream() -> Scene {
    on_stream_with(
        layout("screen-camera", json!({})),
        layout("vertical-camera-top", json!({})),
    )
}

/// `ids()`: `scene-1`, `scene-2`, … and one stamp.
fn make(picks: &[ScreenPick], template: &Scene, existing: &[Scene], camera_on: bool) -> NewScenes {
    let mut n = 0;
    new_scenes(
        picks,
        template,
        existing,
        camera_on,
        move || {
            n += 1;
            format!("scene-{n}")
        },
        || "2026-11-15".to_string(),
    )
}

fn app(bundle_id: &str, name: &str, front_window_id: Option<&str>) -> ScreenPick {
    ScreenPick::App(AppChoice {
        bundle_id: bundle_id.into(),
        name: name.into(),
        window_count: 1,
        front_window_id: front_window_id.map(str::to_string),
        ..AppChoice::default()
    })
}

fn display1() -> Device {
    device(json!({
        "id": "screen:screencapturekit:1",
        "name": "Display 1",
        "kind": "screen",
        "status": "available",
        "displayUuid": "uuid-1"
    }))
}

const DEFAULTS: [&str; 4] = [
    "Screen + camera",
    "Screen only",
    "Camera only",
    "Side by side",
];

/// A scene with this id and name (the TS `{id, name}` rows).
fn named(id: &str, name: &str) -> Scene {
    Scene {
        id: id.into(),
        name: name.into(),
        ..on_stream()
    }
}

/// `expect(actual).toMatchObject(expected)` on JSON objects.
fn assert_matches(actual: &Value, expected: Value) {
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(actual.get(key), Some(value), "{key} in {actual}");
    }
}

fn own() -> Vec<String> {
    vec!["dev.theorcdev.videorc".to_string()]
}

// ── the apps Add scene… offers (plan 210 S5, plan 231 D6) ────────────────

#[test]
fn groups_window_sources_by_app_counts_them_and_takes_the_first_as_front() {
    let choices = app_choices_from_devices(
        &[
            window("window:1", "com.google.Chrome", "Chrome", json!({})),
            window("window:2", "com.figma.Desktop", "Figma", json!({})),
            window("window:3", "com.google.Chrome", "Chrome", json!({})),
            window("window:4", "com.google.Chrome", "Chrome", json!({})),
            device(
                json!({"id": "screen:1", "name": "Display 1", "kind": "screen", "status": "available"}),
            ),
        ],
        &[],
    );
    assert_eq!(
        choices,
        vec![
            AppChoice {
                bundle_id: "com.google.Chrome".into(),
                name: "Chrome".into(),
                window_count: 3,
                front_window_id: Some("window:1".into()),
                front_window_title: Some("window:1".into()),
                ..AppChoice::default()
            },
            AppChoice {
                bundle_id: "com.figma.Desktop".into(),
                name: "Figma".into(),
                window_count: 1,
                front_window_id: Some("window:2".into()),
                front_window_title: Some("window:2".into()),
                ..AppChoice::default()
            },
        ]
    );
}

#[test]
fn never_offers_videorc_the_dock_palettes_unavailable_windows_the_login_window_or_windowless_apps()
{
    let choices = app_choices_from_devices(
        &[
            window("window:1", "dev.theorcdev.videorc", "Videorc", json!({})),
            window("window:6", "com.apple.dock", "Dock", json!({})),
            window(
                "window:2",
                "com.figma.Desktop",
                "Figma",
                json!({"width": 320, "height": 200}),
            ),
            window(
                "window:3",
                "com.figma.Desktop",
                "Figma",
                json!({"status": "unavailable"}),
            ),
            window(
                "window:4",
                "com.apple.loginwindow",
                "loginwindow",
                json!({"name": "loginwindow"}),
            ),
            device(
                json!({"id": "window:5", "name": "Mystery", "kind": "window", "status": "available"}),
            ),
        ],
        &own(),
    );
    assert_eq!(choices, vec![]);
}

#[test]
fn takes_s4_pictures_when_they_come_without_videorc_or_windowless_apps() {
    let previews = [
        AppPreview {
            bundle_id: "com.t3.code".into(),
            name: "T3 Code".into(),
            window_count: 1,
            front_window_id: Some("window:1".into()),
            picture: Some("data:image/jpeg;base64,AA".into()),
            ..AppPreview::default()
        },
        AppPreview {
            bundle_id: "com.figma.Desktop".into(),
            name: "Figma".into(),
            window_count: 3,
            ..AppPreview::default()
        },
        AppPreview {
            bundle_id: "dev.theorcdev.videorc".into(),
            name: "Videorc".into(),
            window_count: 2,
            ..AppPreview::default()
        },
        AppPreview {
            bundle_id: "com.apple.finder".into(),
            name: "Finder".into(),
            window_count: 0,
            ..AppPreview::default()
        },
    ];
    let rows: Vec<(String, u32, bool)> =
        app_choices_from_previews(&previews, &["DEV.theorcdev.videorc".to_string()])
            .into_iter()
            .map(|app| (app.name, app.window_count, app.picture.is_some()))
            .collect();
    assert_eq!(
        rows,
        [
            ("Figma".to_string(), 3, false),
            ("T3 Code".to_string(), 1, true)
        ]
    );
}

#[test]
fn drops_a_front_window_title_that_only_repeats_the_app_name() {
    let choices = app_choices_from_devices(
        &[window(
            "window:1",
            "com.apple.ActivityMonitor",
            "Activity Monitor",
            json!({"windowTitle": "Activity Monitor"}),
        )],
        &[],
    );
    assert_eq!(choices[0].front_window_title, None);
}

#[test]
fn searches_names_and_front_window_titles() {
    let choices = app_choices_from_devices(
        &[
            window("Inbox", "com.google.Chrome", "Chrome", json!({})),
            window("Board", "com.figma.Desktop", "Figma", json!({})),
        ],
        &[],
    );
    let names = |query: &str| -> Vec<String> {
        search_app_choices(&choices, query)
            .into_iter()
            .map(|app| app.name)
            .collect()
    };
    assert_eq!(names("fig"), ["Figma"]);
    assert_eq!(names("INBOX"), ["Chrome"]);
    assert_eq!(search_app_choices(&choices, "  ").len(), 2);
}

#[test]
fn labels_the_primary_and_the_window_count() {
    assert_eq!(add_scenes_label(0), "Add scene");
    assert_eq!(add_scenes_label(1), "Add scene");
    assert_eq!(add_scenes_label(2), "Add 2 scenes");
    assert_eq!(add_scenes_label(3), "Add 3 scenes");
    assert_eq!(window_count_label(1), None);
    assert_eq!(window_count_label(3).as_deref(), Some("3 windows"));
}

// ── the scenes Add scene… makes (plan 231 D6) ────────────────────────────

#[test]
fn names_each_after_what_it_shows_figma_2_then_figma_3() {
    let mut existing = vec![on_stream()];
    existing.extend(DEFAULTS.iter().map(|name| named(name, name)));
    let NewScenes { scenes, .. } = make(
        &[
            app("com.figma.Desktop", "Figma", None),
            app("com.figma.Desktop", "Figma", None),
            app("com.t3tools.t3code", "T3 Code", None),
            ScreenPick::Display(display1()),
            ScreenPick::None,
        ],
        &on_stream(),
        &existing,
        true,
    );
    let names: Vec<&str> = scenes.iter().map(|scene| scene.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Figma 2",
            "Figma 3",
            "T3 Code",
            "Display 1",
            "Camera only 2"
        ]
    );
    let ids: HashSet<&str> = scenes.iter().map(|scene| scene.id.as_str()).collect();
    assert_eq!(ids.len(), 5);
}

#[test]
fn takes_the_look_of_the_scene_on_stream_both_layouts_and_the_background_with_no_audio() {
    let template = Scene {
        audio: Some(SceneAudio {
            microphone_id: None,
            microphone_name: None,
            microphone_off: true,
            system_audio_enabled: false,
        }),
        ..on_stream()
    };
    let NewScenes {
        mut scenes,
        window_hints,
    } = make(
        &[app("com.t3tools.t3code", "T3 Code", Some("window:9"))],
        &template,
        &[],
        true,
    );
    let scene = &mut scenes[0];
    assert_eq!(scene.id, "scene-1");
    assert_eq!(scene.created_at, "2026-11-15");
    assert_eq!(
        scene.shows,
        SceneShows::App {
            bundle_id: "com.t3tools.t3code".into(),
            name: "T3 Code".into(),
            follows: true
        }
    );
    assert_matches(&scene.background, json!({"assetId": "builtin-bg-01"}));
    assert_eq!(scene.audio, None);
    assert_matches(
        &scene.horizontal,
        json!({"layoutPreset": "screen-camera", "cameraZoom": 140, "cameraShape": "circle"}),
    );
    assert_matches(
        &scene.vertical,
        json!({"layoutPreset": "vertical-camera-top", "cameraShape": "circle"}),
    );
    // The picker's front window is where the app's scene looks first.
    assert_eq!(
        window_hints,
        [("scene-1".to_string(), "window:9".to_string())]
    );
    // A copy: the scene on stream isn't edited through it.
    scene.horizontal["cameraZoom"] = json!(99);
    assert_eq!(template.horizontal["cameraZoom"], 140);
}

#[test]
fn shows_the_screen_even_when_the_scene_on_stream_is_camera_only() {
    let camera_only = on_stream_with(
        layout("camera-only", json!({})),
        layout("vertical-camera-only", json!({})),
    );
    let NewScenes { scenes, .. } =
        make(&[ScreenPick::Display(display1())], &camera_only, &[], true);
    assert_eq!(
        scenes[0].shows,
        SceneShows::Display {
            screen_id: display1().id,
            screen_name: Some("Display 1".into()),
            screen_uuid: Some("uuid-1".into())
        }
    );
    assert_eq!(layout_preset(&scenes[0].horizontal), "screen-camera");
    assert_eq!(layout_preset(&scenes[0].vertical), "vertical-screen-camera");
    // With the camera off, a camera layout becomes its screen-only twin.
    assert_eq!(
        layout_preset(&layout_showing_screen(
            &layout("screen-camera", json!({})),
            false
        )),
        "screen-only"
    );
    assert_eq!(
        layout_preset(&layout_showing_screen(
            &layout("vertical-split", json!({})),
            true
        )),
        "vertical-split"
    );
    let hidden = layout_showing_screen(
        &layout(
            "screen-only",
            json!({"sourceVisibility": {"camera": true, "capture": false}}),
        ),
        true,
    );
    assert_eq!(
        hidden["sourceVisibility"],
        json!({"camera": true, "capture": true})
    );
}

#[test]
fn makes_camera_only_show_no_screen_in_both_orientations_d18() {
    let NewScenes { scenes, .. } = make(&[ScreenPick::None], &on_stream(), &[], true);
    assert_eq!(scenes[0].name, "Camera only");
    assert_eq!(scenes[0].shows, SceneShows::None);
    assert_matches(
        &scenes[0].horizontal,
        json!({"layoutPreset": "camera-only", "arrangementMode": "preset", "cameraShape": "circle"}),
    );
    assert_eq!(layout_preset(&scenes[0].vertical), "vertical-camera-only");
    assert_eq!(
        layout_preset(&layout_showing_no_screen(&layout("camera-only", json!({})))),
        "camera-only"
    );
}

#[test]
fn lands_at_the_end_each_with_the_next_position_key_the_tenth_has_none_d5() {
    let mut library = vec![on_stream()];
    library.extend(DEFAULTS.iter().map(|name| named(name, name)));
    let NewScenes { scenes, .. } = make(
        &[
            app("com.t3tools.t3code", "T3 Code", None),
            app("com.google.Chrome", "Chrome", None),
            ScreenPick::Display(display1()),
            ScreenPick::None,
            app("com.apple.Safari", "Safari", None),
        ],
        &on_stream(),
        &library,
        true,
    );
    // The library hook appends them (use-scenes `insert`, at the end).
    let mut after = library.clone();
    after.extend(scenes.iter().cloned());
    assert_eq!(&after[..library.len()], &library[..]);
    let positions: Vec<Option<usize>> = scenes
        .iter()
        .map(|scene| scene_position(&after, &scene.id))
        .collect();
    assert_eq!(positions, [Some(6), Some(7), Some(8), Some(9), Some(10)]);
    let keys: Vec<Option<String>> = positions
        .iter()
        .map(|position| {
            let position = position.unwrap();
            (position <= 9).then(|| scene_slot_accelerator(None, position, Some("darwin")))
        })
        .collect();
    assert_eq!(
        keys,
        [
            Some("Control+Alt+6".to_string()),
            Some("Control+Alt+7".to_string()),
            Some("Control+Alt+8".to_string()),
            Some("Control+Alt+9".to_string()),
            None
        ]
    );
}

#[test]
fn offers_displays_by_platform_and_windows_by_app_for_a_specific_window() {
    let devices = [
        display1(),
        device(json!({
            "id": "screen:screencapturekit:2",
            "name": "Display 2",
            "kind": "screen",
            "status": "unavailable"
        })),
        window(
            "window:2",
            "com.google.Chrome",
            "Chrome",
            json!({"windowTitle": "Inbox"}),
        ),
        window(
            "window:1",
            "com.figma.Desktop",
            "Figma",
            json!({"windowTitle": "Board"}),
        ),
        window(
            "window:3",
            "dev.theorcdev.videorc",
            "Videorc",
            json!({"windowTitle": "Notes"}),
        ),
        window(
            "window:4",
            "com.figma.Desktop",
            "Figma",
            json!({"width": 200, "height": 120}),
        ),
    ];
    let ids = |choices: Vec<&Device>| -> Vec<String> {
        choices
            .into_iter()
            .map(|device| device.id.clone())
            .collect()
    };
    assert_eq!(
        ids(display_choices(&devices, Some("darwin"))),
        ["screen:screencapturekit:1"]
    );
    let titles: Vec<Option<String>> = window_choices(&devices, &own())
        .into_iter()
        .map(|device| device.window_title.clone())
        .collect();
    assert_eq!(
        titles,
        [Some("Inbox".to_string()), Some("Board".to_string())]
    );
    let windows = [
        device(
            json!({"id": "screen:dxgi:1", "name": "Display 1", "kind": "screen", "status": "available"}),
        ),
        device(
            json!({"id": "screen:dxgi:2", "name": "Display 2", "kind": "screen", "status": "unavailable"}),
        ),
    ];
    assert_eq!(
        ids(display_choices(&windows, Some("win32"))),
        ["screen:dxgi:1"]
    );
}

// ── Change screen… (plan 231 D6) ─────────────────────────────────────────

#[test]
fn changes_only_what_the_scene_shows_and_an_app_named_scene_takes_the_new_name() {
    let scene = on_stream();
    let scenes = [scene.clone(), named("chrome", "Chrome")];
    let next = scene_showing_pick(
        &scene,
        &app("com.google.Chrome", "Chrome", None),
        &scenes,
        "now",
    );
    assert_eq!(next.id, "figma");
    assert_eq!(next.name, "Chrome 2");
    assert_eq!(next.updated_at, "now");
    assert_eq!(
        next.shows,
        SceneShows::App {
            bundle_id: "com.google.Chrome".into(),
            name: "Chrome".into(),
            follows: true
        }
    );
    assert_eq!(next.horizontal, scene.horizontal);
    assert_eq!(next.vertical, scene.vertical);
    assert_eq!(next.background, scene.background);
    // A name the streamer typed stays.
    let design = Scene {
        name: "Design".into(),
        ..scene.clone()
    };
    let none: [Scene; 0] = [];
    assert_eq!(
        scene_showing_pick(&design, &ScreenPick::Display(display1()), &none, "now").name,
        "Design"
    );
}

#[test]
fn keeps_one_window_with_a_specific_window_and_the_app_scenes_following() {
    let scene = Scene {
        shows: on_stream().shows.with_follows(false),
        ..on_stream()
    };
    let board = window(
        "window:1",
        "com.figma.Desktop",
        "Figma",
        json!({"windowTitle": "Board"}),
    );
    let fixed = scene_showing_pick(
        &scene,
        &ScreenPick::Window(board.clone()),
        std::slice::from_ref(&scene),
        "now",
    );
    assert_eq!(
        fixed.shows,
        SceneShows::Window {
            window_id: "window:1".into(),
            window_name: Some(board.name.clone())
        }
    );
    assert_eq!(fixed.name, "Figma");
    let back = scene_showing_pick(
        &fixed,
        &app("com.figma.Desktop", "Figma", None),
        std::slice::from_ref(&fixed),
        "now",
    );
    assert!(matches!(back.shows, SceneShows::App { follows: true, .. }));
    assert!(matches!(
        scene_showing_pick(
            &scene,
            &app("com.google.Chrome", "Chrome", None),
            std::slice::from_ref(&scene),
            "now"
        )
        .shows,
        SceneShows::App { follows: false, .. }
    ));
}

#[test]
fn no_screen_puts_the_scene_on_camera_only_in_both_orientations_d19() {
    let scene = on_stream();
    let none = scene_showing_pick(
        &scene,
        &ScreenPick::None,
        std::slice::from_ref(&scene),
        "now",
    );
    assert_eq!(none.shows, SceneShows::None);
    assert_eq!(none.name, "Camera only");
    assert_matches(
        &none.horizontal,
        json!({"layoutPreset": "camera-only", "cameraShape": "circle"}),
    );
    assert_eq!(layout_preset(&none.vertical), "vertical-camera-only");
}

#[test]
fn keeps_a_default_scenes_layout_name_when_it_takes_a_screen_d3_d19() {
    let camera_only = Scene {
        id: "default-camera-only".into(),
        name: "Camera only".into(),
        shows: SceneShows::None,
        ..on_stream_with(
            layout("camera-only", json!({})),
            layout("vertical-camera-only", json!({})),
        )
    };
    let with_screen = scene_showing_pick(
        &camera_only,
        &ScreenPick::Display(display1()),
        std::slice::from_ref(&camera_only),
        "now",
    );
    assert_eq!(with_screen.name, "Camera only");
    assert!(matches!(
        &with_screen.shows,
        SceneShows::Display { screen_name: Some(name), .. } if name == "Display 1"
    ));
    // Its layouts stay: the Layout field (or D19) puts a screen layout on.
    assert_eq!(with_screen.horizontal, camera_only.horizontal);
    assert_eq!(with_screen.vertical, camera_only.vertical);
}

#[test]
fn knows_what_the_scene_shows_already() {
    let scene = on_stream();
    assert!(shows_pick(
        &scene.shows,
        &app("com.figma.Desktop", "Figma", None)
    ));
    assert!(!shows_pick(
        &scene.shows,
        &app("com.google.Chrome", "Chrome", None)
    ));
    assert!(shows_pick(&SceneShows::None, &ScreenPick::None));
    assert!(matches!(
        pick_shows(&ScreenPick::Display(display1()), true),
        SceneShows::Display { screen_uuid: Some(uuid), .. } if uuid == "uuid-1"
    ));
}

// ── Duplicate (plan 231 D6) ──────────────────────────────────────────────

#[test]
fn duplicate_copies_both_layouts_the_screen_and_the_audio_under_a_new_name_for_the_end() {
    let scene = Scene {
        audio: Some(SceneAudio {
            microphone_id: None,
            microphone_name: None,
            microphone_off: true,
            system_audio_enabled: true,
        }),
        ..on_stream()
    };
    let mut copy = duplicated_scene(&scene, std::slice::from_ref(&scene), "copy", "now");
    assert_eq!(
        copy,
        Scene {
            id: "copy".into(),
            name: "Figma 2".into(),
            created_at: "now".into(),
            updated_at: "now".into(),
            ..scene.clone()
        }
    );
    copy.horizontal["cameraZoom"] = json!(1);
    assert_eq!(scene.horizontal["cameraZoom"], 140);
}
