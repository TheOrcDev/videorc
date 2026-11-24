//! `lib/scenes.test.ts`, case for case, on Electron's own migration
//! fixtures (`lib/__fixtures__/scenes/*.json`): each is what a profile's
//! localStorage holds, parsed, by key.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::migration::*;
use super::model::{
    SCENE_LIBRARY_KEY, SavedScene, WORKING_SCENE_KEY, WorkingScene, hydrate_scene_library,
    hydrate_working_scene, normalize_scene_visual,
};
use super::store::*;
use super::v2::*;
use super::view::*;
use crate::studio::capture_config::load_capture_config;
use crate::studio::js_value::canonical_eq;

const NOW: &str = "2026-11-15T12:00:00.000Z";

const FIXTURES: [&str; 10] = [
    "new-user",
    "plan-210-user",
    "builtin-user-layout-keys",
    "vertical-follow-on",
    "vertical-follow-off",
    "saved-vertical-scene",
    "working-freeform",
    "saved-scene-left-by-screen-pick",
    "default-equals-saved",
    "vertical-key-without-scene",
];

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/renderer/src/lib/__fixtures__/scenes")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

struct Inputs {
    v1: Vec<SavedScene>,
    working: Option<WorkingScene>,
    config: Value,
    shortcuts: Option<Value>,
}

fn inputs(storage: &Value) -> Inputs {
    Inputs {
        v1: hydrate_scene_library(storage.get(SCENE_LIBRARY_KEY)).scenes,
        working: hydrate_working_scene(storage.get(WORKING_SCENE_KEY)),
        config: load_capture_config(storage.get("videorc.captureConfig"), NOW),
        shortcuts: storage
            .get("videorc.settings")
            .and_then(|settings| settings.get("globalShortcuts"))
            .cloned(),
    }
}

fn migrate_with(name: &str, platform: Option<&str>) -> Migrated {
    let input = inputs(&fixture(name));
    migrate_to_scenes(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        input.shortcuts.as_ref(),
        NOW,
        platform,
    )
    .unwrap()
}

fn migrate(name: &str) -> Migrated {
    migrate_with(name, None)
}

fn shows_tag(shows: &SceneShows) -> String {
    match shows {
        SceneShows::App {
            bundle_id, follows, ..
        } => format!("app:{bundle_id}{}", if *follows { ":follows" } else { "" }),
        SceneShows::Window { window_id, .. } => format!("window:{window_id}"),
        SceneShows::Display { screen_id, .. } => format!("display:{screen_id}"),
        other => other.kind().to_string(),
    }
}

/// Order, names, each scene's 16:9 and 9:16 layout, and what it shows.
fn rows(library: &SceneLibrary) -> Vec<[String; 5]> {
    library
        .scenes
        .iter()
        .map(|scene| {
            [
                scene.id.clone(),
                scene.name.clone(),
                layout_preset(&scene.horizontal).to_string(),
                layout_preset(&scene.vertical).to_string(),
                shows_tag(&scene.shows),
            ]
        })
        .collect()
}

fn row(id: &str, name: &str, horizontal: &str, vertical: &str, shows: &str) -> [String; 5] {
    [id, name, horizontal, vertical, shows].map(str::to_string)
}

fn defaults_on(shows: &str) -> Vec<[String; 5]> {
    vec![
        row(
            "default-screen-camera",
            "Screen + camera",
            "screen-camera",
            "vertical-camera-top",
            shows,
        ),
        row(
            "default-screen-only",
            "Screen only",
            "screen-only",
            "vertical-screen-only",
            shows,
        ),
        row(
            "default-camera-only",
            "Camera only",
            "camera-only",
            "vertical-camera-only",
            shows,
        ),
        row(
            "default-side-by-side",
            "Side by side",
            "side-by-side",
            "vertical-camera-top",
            shows,
        ),
    ]
}

/// What the vertical stream showed for a 16:9 program before plan 231 (the
/// old leg builder, frozen here): Follow mirrored Camera only and Screen
/// only, anything else streamed the remembered 9:16 layout, with the leg's
/// own Fill or Fit and the program's look in preset arrangement.
fn leg_before_plan_231(config: &Value, program: &Value) -> Value {
    let follows = config["simulcastFollowsProgram"] == json!(true);
    let preset = match layout_preset(program) {
        "camera-only" if follows => "vertical-camera-only",
        "screen-only" if follows => "vertical-screen-only",
        _ => config["lastVerticalPreset"].as_str().unwrap(),
    };
    let mut leg = program.as_object().unwrap().clone();
    leg.insert("layoutPreset".into(), json!(preset));
    leg.insert(
        "verticalScreenFraming".into(),
        config["simulcastScreenFraming"].clone(),
    );
    leg.insert("cameraTransformMode".into(), json!("preset"));
    leg.insert("cameraTransform".into(), Value::Null);
    leg.insert("arrangementMode".into(), json!("preset"));
    leg.insert("sourceTransformOverrides".into(), json!({}));
    Value::Object(leg)
}

/// `simulcastLegLayout`'s parts this slice reads: the scene's 9:16 layout,
/// with the program's camera look (plan 231 S3). The vertical stream
/// monitor that owns it is ported in S1.6b's editor part; here the fixture
/// rule needs only that the scene's 9:16 preset and framing are the old
/// leg's.
fn leg_preset_and_framing(layout: &Value) -> (String, Value) {
    (
        layout_preset(layout).to_string(),
        layout
            .get("verticalScreenFraming")
            .cloned()
            .unwrap_or(Value::Null),
    )
}

#[test]
fn every_fixture_keeps_what_is_on_stream_and_reads_back() {
    for name in FIXTURES {
        let input = inputs(&fixture(name));
        let library = migrate(name).library;
        let on = library.on_stream();
        let visual = match &input.working {
            Some(working) => working.visual.clone(),
            None => normalize_scene_visual(&json!({
                "layout": input.config["layout"],
                "sources": input.config["sources"],
                "background": null,
            }))
            .unwrap(),
        };
        let orientation = Orientation::of_layout(&visual["layout"]);
        // The program: the working layout, background and screen, exactly.
        assert!(
            canonical_eq(on.layout(orientation), &visual["layout"]),
            "{name}"
        );
        assert_eq!(on.background, visual["background"], "{name}");
        assert!(
            same_shows(&on.shows, &shows_from_sources(&visual["sources"])),
            "{name}"
        );
        // The vertical stream: the scene on stream's 9:16 layout streams
        // the preset and framing the leg showed before plan 231.
        if orientation == Orientation::Horizontal {
            assert_eq!(
                leg_preset_and_framing(&on.vertical),
                leg_preset_and_framing(&leg_before_plan_231(&input.config, &visual["layout"])),
                "{name}"
            );
        }
        // Every scene is valid, and the stored library hydrates to itself.
        for scene in &library.scenes {
            assert_eq!(
                normalize_scene(&scene.to_json()).as_ref(),
                Ok(scene),
                "{name}"
            );
            assert_eq!(
                Orientation::of_layout(&scene.horizontal),
                Orientation::Horizontal
            );
            assert_eq!(
                Orientation::of_layout(&scene.vertical),
                Orientation::Vertical
            );
        }
        let mut ids: Vec<&str> = library.scenes.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), library.scenes.len(), "{name}");
        let mut names: Vec<String> = library
            .scenes
            .iter()
            .map(|s| s.name.to_lowercase())
            .collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), library.scenes.len(), "{name}");
        let stored = library.to_json();
        assert_eq!(
            hydrate_scenes(Some(&stored)),
            HydratedScenes {
                library: Some(library.clone()),
                read_only: false,
                error: None
            },
            "{name}"
        );
        // D9: no scene names a camera device.
        let text = stored.to_string();
        for key in ["\"cameraId\"", "\"cameraName\"", "\"cameraOff\""] {
            assert!(!text.contains(key), "{name}: {key}");
        }
    }
}

#[test]
fn a_new_user_gets_the_four_defaults_with_screen_and_camera_on_stream() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("new-user");
    let mut expected = defaults_on("display:");
    expected[2][4] = "none".into();
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "default-screen-camera");
    assert_eq!(global_shortcuts, json!({"scenes": {}}));
    assert_eq!(library.scenes, default_scenes(None, NOW));
    // Owner call O1: a new user starts in 16:9, where a scene's 9:16 layout
    // is first the vertical stream's, so it is Fit.
    for scene in &library.scenes {
        assert_eq!(scene.vertical["verticalScreenFraming"], "fit");
    }
}

#[test]
fn a_plan_210_user_keeps_figma_first_on_stream_and_t3_codes_key() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("plan-210-user");
    // The default Screen + camera would show Figma like the saved scene:
    // left out.
    assert_eq!(
        rows(&library),
        vec![
            row(
                "5d0c8a4e-figma",
                "Figma",
                "screen-camera",
                "vertical-camera-top",
                "app:com.figma.Desktop:follows"
            ),
            row(
                "9b7e21c3-t3code",
                "T3 Code",
                "screen-camera",
                "vertical-camera-top",
                "app:tools.t3.code:follows"
            ),
            row(
                "default-screen-only",
                "Screen only",
                "screen-only",
                "vertical-screen-only",
                "app:com.figma.Desktop"
            ),
            row(
                "default-camera-only",
                "Camera only",
                "camera-only",
                "vertical-camera-only",
                "app:com.figma.Desktop"
            ),
            row(
                "default-side-by-side",
                "Side by side",
                "side-by-side",
                "vertical-camera-top",
                "app:com.figma.Desktop"
            ),
        ]
    );
    assert_eq!(library.on_stream_id, "5d0c8a4e-figma");
    assert_eq!(scene_at_position(&library.scenes, 1).unwrap().name, "Figma");
    assert_eq!(
        scene_position(&library.scenes, &library.on_stream_id),
        Some(1)
    );
    assert_eq!(
        scene_at_position(&library.scenes, 2).unwrap().name,
        "T3 Code"
    );
    assert_eq!(
        library.scenes[0].shows.to_json(),
        json!({"kind": "app", "bundleId": "com.figma.Desktop", "name": "Figma", "follows": true})
    );
    assert_eq!(
        global_shortcuts,
        json!({"scenes": {"9b7e21c3-t3code": "Control+Alt+T"}})
    );
}

#[test]
fn a_builtin_user_is_on_its_default_scene_and_the_layout_keys_move() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("builtin-user-layout-keys");
    assert_eq!(rows(&library), defaults_on("display:screen:1"));
    assert_eq!(library.on_stream_id, "default-screen-only");
    // Today's look goes to every default, as the built-in layouts share it.
    for scene in &library.scenes {
        assert_eq!(scene.horizontal["cameraCorner"], "top-left");
        assert_eq!(scene.horizontal["cameraShape"], "circle");
        assert_eq!(scene.vertical["cameraShape"], "circle");
    }
    assert_eq!(
        library.scenes[0].shows.to_json(),
        json!({
            "kind": "display",
            "screenId": "screen:1",
            "screenName": "Display 1",
            "screenUuid": "37D8832A-2D66-02CA-B9F7-8F30A301B230"
        })
    );
    assert_eq!(
        global_shortcuts,
        json!({
            "layoutNext": "Control+Alt+Right",
            "recordToggle": "Control+Alt+R",
            "scenes": {
                "default-screen-camera": "Control+Alt+1",
                "default-camera-only": "Control+Alt+3",
                "default-side-by-side": "Control+Alt+7"
            }
        })
    );
}

#[test]
fn on_macos_no_moved_key_collides_with_a_position_key() {
    let mac = migrate_with("builtin-user-layout-keys", Some("darwin"));
    assert_eq!(
        mac.global_shortcuts["scenes"],
        json!({"default-side-by-side": "Control+Alt+7"})
    );
    assert_eq!(mac.global_shortcuts["sceneSlots"], json!({"7": ""}));
    assert_eq!(
        scene_at_position(&mac.library.scenes, 1).unwrap().id,
        "default-screen-camera"
    );
    assert_eq!(
        scene_at_position(&mac.library.scenes, 3).unwrap().id,
        "default-camera-only"
    );
    // Elsewhere the position keys carry Shift: nothing collides.
    let windows = migrate_with("builtin-user-layout-keys", Some("win32"));
    assert_eq!(
        windows.global_shortcuts["scenes"],
        json!({
            "default-screen-camera": "Control+Alt+1",
            "default-camera-only": "Control+Alt+3",
            "default-side-by-side": "Control+Alt+7"
        })
    );
    assert!(windows.global_shortcuts.get("sceneSlots").is_none());
}

fn presets(library: &SceneLibrary) -> Vec<[String; 2]> {
    rows(library)
        .into_iter()
        .map(|[_, _, horizontal, vertical, _]| [horizontal, vertical])
        .collect()
}

fn pair(horizontal: &str, vertical: &str) -> [String; 2] {
    [horizontal.to_string(), vertical.to_string()]
}

#[test]
fn the_vertical_stream_follow_on_keeps_camera_only_and_screen_only_twins() {
    let library = migrate("vertical-follow-on").library;
    assert_eq!(
        presets(&library),
        vec![
            pair("screen-camera", "vertical-split"),
            pair("screen-only", "vertical-screen-only"),
            pair("camera-only", "vertical-camera-only"),
            pair("side-by-side", "vertical-split"),
        ]
    );
    assert_eq!(library.on_stream_id, "default-screen-camera");
    for scene in &library.scenes {
        assert_eq!(scene.vertical["verticalScreenFraming"], "fit");
    }
}

#[test]
fn the_vertical_stream_follow_off_keeps_the_remembered_layout_where_it_shows_the_same() {
    let library = migrate("vertical-follow-off").library;
    assert_eq!(
        presets(&library),
        vec![
            pair("screen-camera", "vertical-camera-bottom"),
            pair("screen-only", "vertical-screen-only"),
            pair("camera-only", "vertical-camera-only"),
            pair("side-by-side", "vertical-camera-bottom"),
        ]
    );
    assert_eq!(library.on_stream_id, "default-screen-camera");
    assert!(library.vertical_layouts_repaired);
    for scene in &library.scenes {
        assert_eq!(scene.vertical["verticalScreenFraming"], "fill");
        assert_eq!(shows_tag(&scene.shows), "display:screen:1");
    }
}

#[test]
fn remembering_camera_only_still_gives_screen_scenes_their_screen_in_9_16() {
    let mut input = inputs(&fixture("vertical-follow-on"));
    input.config["lastVerticalPreset"] = json!("vertical-camera-only");
    let library = migrate_to_scenes(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        input.shortcuts.as_ref(),
        NOW,
        None,
    )
    .unwrap()
    .library;
    assert_eq!(
        presets(&library),
        vec![
            pair("screen-camera", "vertical-camera-top"),
            pair("screen-only", "vertical-screen-only"),
            pair("camera-only", "vertical-camera-only"),
            pair("side-by-side", "vertical-camera-top"),
        ]
    );
    for scene in &library.scenes {
        assert_eq!(
            layout_shows_screen(&scene.vertical),
            layout_shows_screen(&scene.horizontal)
        );
    }
}

#[test]
fn a_saved_9_16_scene_keeps_its_layout_and_takes_its_16_9_twin() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("saved-vertical-scene");
    let mut expected = vec![row(
        "c41f77aa-shorts",
        "Shorts",
        "screen-camera",
        "vertical-split",
        "display:screen:1",
    )];
    expected.extend(defaults_on("display:screen:1"));
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "default-screen-camera");
    let shorts = &library.scenes[0];
    let saved = &fixture("saved-vertical-scene")[SCENE_LIBRARY_KEY]["scenes"][0];
    assert!(canonical_eq(
        &shorts.vertical,
        &normalize_scene_visual(&saved["visual"]).unwrap()["layout"]
    ));
    assert_eq!(shorts.vertical["verticalScreenFraming"], "fill");
    assert_eq!(shorts.horizontal["cameraZoom"], 140);
    assert_eq!(global_shortcuts, json!({"scenes": {}}));
}

#[test]
fn a_working_freeform_arrangement_becomes_a_scene_named_after_its_display() {
    let library = migrate("working-freeform").library;
    let mut expected = defaults_on("display:screen:1");
    expected.push(row(
        "migrated-working",
        "Display 1",
        "screen-camera",
        "vertical-camera-top",
        "display:screen:1",
    ));
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "migrated-working");
    let on = library.on_stream();
    assert_eq!(on.horizontal["arrangementMode"], "freeform");
    let overrides: Vec<&String> = on.horizontal["sourceTransformOverrides"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(overrides, ["camera", "capture"]);
    // The freeform arrangement never leaks into 9:16 or into the defaults.
    assert_eq!(on.vertical["arrangementMode"], "preset");
    assert_eq!(on.vertical["sourceTransformOverrides"], json!({}));
    for scene in &library.scenes[..4] {
        assert_eq!(scene.horizontal["arrangementMode"], "preset");
        assert_eq!(scene.horizontal["sourceTransformOverrides"], json!({}));
    }
}

#[test]
fn a_saved_scene_left_by_a_screen_pick_stays_and_what_is_on_becomes_a_scene() {
    let library = migrate("saved-scene-left-by-screen-pick").library;
    let mut expected = vec![row(
        "5d0c8a4e-figma",
        "Figma",
        "screen-camera",
        "vertical-camera-top",
        "app:com.figma.Desktop:follows",
    )];
    expected.extend(defaults_on("display:screen:2"));
    expected.push(row(
        "migrated-working",
        "Display 2",
        "screen-camera",
        "vertical-camera-top",
        "display:screen:2",
    ));
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "migrated-working");
    // The dragged camera is the scene's and the working look's, never a
    // default's.
    assert_eq!(
        library.scenes[0].horizontal["cameraTransformMode"],
        "custom"
    );
    assert_eq!(
        library.on_stream().horizontal["cameraTransformMode"],
        "custom"
    );
    assert_eq!(
        library.scenes[1].horizontal["cameraTransformMode"],
        "preset"
    );
    assert_eq!(library.on_stream().vertical["cameraTransform"], Value::Null);
}

#[test]
fn a_default_equal_to_a_saved_scene_is_left_out_and_its_key_goes_there() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("default-equals-saved");
    let mut expected = vec![row(
        "0e6b5d10-my-screen",
        "My screen",
        "screen-only",
        "vertical-screen-only",
        "display:screen:1",
    )];
    let defaults = defaults_on("display:screen:1");
    expected.extend([
        defaults[0].clone(),
        defaults[2].clone(),
        defaults[3].clone(),
    ]);
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "default-screen-camera");
    assert_eq!(
        global_shortcuts,
        json!({"scenes": {"0e6b5d10-my-screen": "Control+Alt+2"}})
    );
}

#[test]
fn a_9_16_layout_key_with_no_scene_adds_one() {
    let Migrated {
        library,
        global_shortcuts,
    } = migrate("vertical-key-without-scene");
    let mut expected = defaults_on("display:screen:1");
    expected.push(row(
        "layout-vertical-camera-bottom",
        "Camera bottom",
        "screen-camera",
        "vertical-camera-bottom",
        "display:screen:1",
    ));
    assert_eq!(rows(&library), expected);
    assert_eq!(library.on_stream_id, "default-screen-camera");
    assert_eq!(
        global_shortcuts,
        json!({"scenes": {"layout-vertical-camera-bottom": "Control+Alt+8"}})
    );
}

#[test]
fn an_unknown_version_is_read_only() {
    assert_eq!(
        hydrate_scenes(fixture("unknown-version").get(SCENES_KEY)),
        HydratedScenes {
            library: None,
            read_only: true,
            error: Some(SCENES_UNKNOWN_VERSION_ERROR),
        }
    );
}

// ── migrateToScenes rules ────────────────────────────────────────────────

fn base() -> Inputs {
    inputs(&fixture("default-equals-saved"))
}

fn display1() -> Value {
    fixture("default-equals-saved")[WORKING_SCENE_KEY]["visual"]["sources"].clone()
}

fn working(
    origin: &str,
    scene_id: Option<&str>,
    layout: Value,
    sources: Option<Value>,
) -> WorkingScene {
    let mut merged = crate::studio::capture_config::default_layout();
    for (key, value) in layout.as_object().unwrap() {
        merged[key] = value.clone();
    }
    hydrate_working_scene(Some(&json!({
        "version": 1,
        "origin": origin,
        "sceneId": scene_id,
        "visual": {"layout": merged, "sources": sources.unwrap_or_else(display1), "background": null},
    })))
    .unwrap()
}

fn run(
    v1: Option<&[SavedScene]>,
    working: Option<&WorkingScene>,
    config: &Value,
    shortcuts: Option<&Value>,
) -> Migrated {
    migrate_to_scenes(v1, working, config, shortcuts, NOW, None).unwrap()
}

#[test]
fn a_saved_scenes_room_guest_roles_survive_the_migration() {
    let input = base();
    let cloud = json!({
        "version": 1,
        "placement": "over",
        "guests": {"host": {"x": 0, "y": 0, "w": 1, "h": 1}, "region": {"x": 0, "y": 0.78, "w": 1, "h": 0.22}}
    });
    let mut v1 = input.v1.clone();
    v1[0].cloud = Some(cloud.clone());
    let first = v1[0].id.clone();
    let library = run(Some(&v1), None, &input.config, None).library;
    let migrated = library
        .scenes
        .iter()
        .find(|scene| scene.id == first)
        .unwrap();
    assert_eq!(migrated.cloud.as_ref(), Some(&cloud));
    for scene in library.scenes.iter().filter(|scene| scene.id != first) {
        assert_eq!(scene.cloud, None);
    }
    let stored = hydrate_scenes(Some(&library.to_json())).library.unwrap();
    let again = stored
        .scenes
        .iter()
        .find(|scene| scene.id == first)
        .unwrap();
    assert_eq!(again.cloud.as_ref(), Some(&cloud));
    let camera = json!({"cameraId": "camera:1"});
    for orientation in [Orientation::Horizontal, Orientation::Vertical] {
        assert_eq!(
            saved_scene_view(migrated, orientation, &camera)
                .cloud
                .as_ref(),
            Some(&cloud)
        );
    }
    let view = saved_scene_view(migrated, Orientation::Vertical, &camera);
    assert_eq!(
        scene_from_saved(&view, migrated).cloud.as_ref(),
        Some(&cloud)
    );
}

#[test]
fn a_9_16_studio_lands_on_the_default_the_16_9_toggle_would() {
    let mut config = base().config;
    config["lastHorizontalPreset"] = json!("side-by-side");
    config["lastVerticalPreset"] = json!("vertical-split");
    let vertical = working(
        "builtin",
        None,
        json!({"layoutPreset": "vertical-split", "verticalScreenFraming": "fill"}),
        None,
    );
    let library = run(None, Some(&vertical), &config, None).library;
    assert_eq!(
        presets(&library),
        vec![
            pair("screen-camera", "vertical-split"),
            pair("screen-only", "vertical-screen-only"),
            pair("camera-only", "vertical-camera-only"),
            pair("side-by-side", "vertical-split"),
        ]
    );
    assert_eq!(library.on_stream_id, "default-side-by-side");
    assert_eq!(library.on_stream().vertical, vertical.visual["layout"]);
    for scene in &library.scenes {
        assert_eq!(scene.vertical["verticalScreenFraming"], "fill");
    }
}

#[test]
fn a_9_16_studio_on_a_layout_no_default_streams_becomes_its_own_scene() {
    let vertical = working(
        "builtin",
        None,
        json!({"layoutPreset": "vertical-camera-bottom"}),
        None,
    );
    let library = run(None, Some(&vertical), &base().config, None).library;
    assert_eq!(
        rows(&library).last().unwrap(),
        &row(
            "migrated-working",
            "Display 1",
            "screen-camera",
            "vertical-camera-bottom",
            "display:screen:1"
        )
    );
    assert_eq!(library.on_stream_id, "migrated-working");
}

#[test]
fn the_default_on_stream_is_left_out_only_for_a_saved_scene_with_the_same_look() {
    let input = base();
    let on_screen_only = working(
        "builtin",
        None,
        json!({"layoutPreset": "screen-only"}),
        None,
    );
    let same = run(Some(&input.v1), Some(&on_screen_only), &input.config, None).library;
    assert!(
        !same
            .scenes
            .iter()
            .any(|scene| scene.id == "default-screen-only")
    );
    assert_eq!(same.on_stream_id, "0e6b5d10-my-screen");
    let mirrored = working(
        "builtin",
        None,
        json!({"layoutPreset": "screen-only", "cameraMirror": true}),
        None,
    );
    let other = run(Some(&input.v1), Some(&mirrored), &input.config, None).library;
    assert_eq!(other.on_stream_id, "default-screen-only");
    let names: Vec<&str> = other
        .scenes
        .iter()
        .map(|scene| scene.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "My screen",
            "Screen + camera",
            "Screen only",
            "Camera only",
            "Side by side"
        ]
    );
}

#[test]
fn a_default_stays_when_its_layout_key_could_not_move() {
    let input = base();
    let shortcuts = json!({
        "scenes": {"0e6b5d10-my-screen": "Control+Alt+M"},
        "layouts": {"screen-only": "Control+Alt+2"}
    });
    let migrated = run(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        Some(&shortcuts),
    );
    assert!(
        migrated
            .library
            .scenes
            .iter()
            .any(|scene| scene.id == "default-screen-only")
    );
    assert_eq!(
        migrated.global_shortcuts["scenes"],
        json!({"0e6b5d10-my-screen": "Control+Alt+M", "default-screen-only": "Control+Alt+2"})
    );
}

#[test]
fn a_look_that_drifted_from_its_saved_scene_stays_on_stream_in_that_scene() {
    let input = base();
    let drifted = working(
        "saved",
        Some("0e6b5d10-my-screen"),
        json!({"layoutPreset": "side-by-side", "sideBySideSplit": "50-50"}),
        None,
    );
    let library = run(Some(&input.v1), Some(&drifted), &input.config, None).library;
    assert_eq!(library.on_stream_id, "0e6b5d10-my-screen");
    assert_eq!(library.scenes[0].horizontal, drifted.visual["layout"]);
    assert_eq!(
        layout_preset(&library.scenes[0].vertical),
        "vertical-camera-top"
    );
}

#[test]
fn a_working_look_that_is_exactly_a_default_goes_on_that_default() {
    let input = base();
    let left = working("saved", None, json!({"layoutPreset": "side-by-side"}), None);
    let library = run(Some(&input.v1), Some(&left), &input.config, None).library;
    assert_eq!(library.on_stream_id, "default-side-by-side");
    assert!(
        !library
            .scenes
            .iter()
            .any(|scene| scene.id == "migrated-working")
    );
}

#[test]
fn a_working_scene_whose_saved_scene_is_gone_is_named_apart() {
    let gone = working(
        "saved",
        Some("deleted"),
        json!({
            "layoutPreset": "camera-only",
            "cameraTransformMode": "custom",
            "cameraTransform": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}
        }),
        None,
    );
    let library = run(None, Some(&gone), &base().config, None).library;
    assert_eq!(
        rows(&library).last().unwrap(),
        &row(
            "migrated-working",
            "Camera only 2",
            "camera-only",
            "vertical-camera-only",
            "display:screen:1"
        )
    );
    assert_eq!(library.on_stream_id, "migrated-working");
}

#[test]
fn screen_none_and_the_test_pattern_are_what_the_defaults_show() {
    let config = base().config;
    let none = working(
        "builtin",
        None,
        json!({"layoutPreset": "camera-only"}),
        Some(json!({"captureOff": true})),
    );
    let shows: Vec<SceneShows> = run(None, Some(&none), &config, None)
        .library
        .scenes
        .into_iter()
        .map(|scene| scene.shows)
        .collect();
    assert_eq!(shows, vec![SceneShows::None; 4]);
    let pattern = working(
        "builtin",
        None,
        json!({}),
        Some(json!({"testPattern": true})),
    );
    assert_eq!(
        run(None, Some(&pattern), &config, None).library.scenes[0].shows,
        SceneShows::TestPattern
    );
}

#[test]
fn a_second_run_over_its_own_shortcuts_keeps_every_key() {
    let input = inputs(&fixture("builtin-user-layout-keys"));
    let first = run(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        input.shortcuts.as_ref(),
    );
    let second = run(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        Some(&first.global_shortcuts),
    );
    assert_eq!(second, first);
}

#[test]
fn shortcut_entries_that_are_not_keys_are_ignored() {
    let input = base();
    let shortcuts = json!({"scenes": {"a": "", "b": 3}, "layouts": {"screen-camera": ""}});
    let migrated = run(
        Some(&input.v1),
        input.working.as_ref(),
        &input.config,
        Some(&shortcuts),
    );
    assert_eq!(migrated.global_shortcuts, json!({"scenes": {}}));
}

// ── defaultScenes (D3) ───────────────────────────────────────────────────

#[test]
fn default_scenes_show_the_main_display_except_camera_only() {
    let main = MainDisplay {
        id: "screen:7".into(),
        name: "Studio Display".into(),
        display_uuid: Some("U-7".into()),
    };
    let scenes = default_scenes(Some(&main), NOW);
    let display = json!({"kind": "display", "screenId": "screen:7", "screenName": "Studio Display", "screenUuid": "U-7"});
    let listed: Vec<(String, Value)> = scenes
        .iter()
        .map(|scene| (scene.name.clone(), scene.shows.to_json()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("Screen + camera".to_string(), display.clone()),
            ("Screen only".to_string(), display.clone()),
            ("Camera only".to_string(), json!({"kind": "none"})),
            ("Side by side".to_string(), display),
        ]
    );
    assert!(
        scenes
            .iter()
            .all(|scene| scene.created_at == NOW && scene.background.is_null())
    );
}

#[test]
fn default_scenes_wait_for_the_main_display_and_take_it_once() {
    let library = SceneLibrary {
        scenes: default_scenes(None, NOW),
        on_stream_id: "default-screen-camera".into(),
        pending_shortcuts: None,
        vertical_layouts_repaired: false,
    };
    let first = MainDisplay {
        id: "screen:1".into(),
        name: "Display 1".into(),
        display_uuid: None,
    };
    let pinned = with_main_display(&library, &first).unwrap();
    let tags: Vec<String> = pinned
        .scenes
        .iter()
        .map(|scene| shows_tag(&scene.shows))
        .collect();
    assert_eq!(
        tags,
        [
            "display:screen:1",
            "display:screen:1",
            "none",
            "display:screen:1"
        ]
    );
    assert_eq!(pinned.scenes, default_scenes(Some(&first), NOW));
    let second = MainDisplay {
        id: "screen:2".into(),
        name: "Display 2".into(),
        display_uuid: None,
    };
    assert_eq!(with_main_display(&pinned, &second), None);
}

// ── repairStoredSceneVerticals (#1706) ──────────────────────────────────

/// A library 0.34.0's migration made for a streamer whose last 9:16 pick was
/// Camera only: Screen + camera and Side by side show only the camera in
/// 9:16, with their screen assigned.
fn owner() -> Value {
    fixture("v2-vertical-camera-only")
}

fn hydrated(raw: &Value) -> SceneLibrary {
    hydrate_scenes(Some(raw)).library.unwrap()
}

fn by_id<'a>(library: &'a SceneLibrary, id: &str) -> &'a Scene {
    library.scenes.iter().find(|scene| scene.id == id).unwrap()
}

fn without_preset(layout: &Value) -> Value {
    let mut layout = layout.clone();
    layout["layoutPreset"] = Value::Null;
    layout
}

#[test]
fn the_repair_puts_screen_scenes_back_on_a_9_16_layout_with_their_screen() {
    let before = hydrated(&owner()[SCENES_KEY]);
    let names_and_vertical: Vec<[String; 2]> = rows(&before)
        .into_iter()
        .map(|[_, name, _, vertical, _]| [name, vertical])
        .collect();
    assert_eq!(
        names_and_vertical,
        vec![
            pair("Screen + camera", "vertical-camera-only"),
            pair("Screen only", "vertical-screen-only"),
            pair("Camera only", "vertical-camera-only"),
            pair("Side by side", "vertical-camera-only"),
        ]
    );
    let repair =
        repair_stored_scene_verticals(&owner()[SCENES_KEY], owner().get(WORKING_SCENE_KEY))
            .unwrap();
    assert_eq!(
        repair.repaired,
        ["default-screen-camera", "default-side-by-side"]
    );
    let after = hydrated(&repair.library);
    assert!(after.vertical_layouts_repaired);
    assert_eq!(
        presets(&after),
        vec![
            pair("screen-camera", "vertical-camera-top"),
            pair("screen-only", "vertical-screen-only"),
            pair("camera-only", "vertical-camera-only"),
            pair("side-by-side", "vertical-camera-top"),
        ]
    );
    for scene in &after.scenes {
        let was = by_id(&before, &scene.id);
        assert_eq!(
            layout_shows_screen(&scene.vertical),
            layout_shows_screen(&scene.horizontal)
        );
        // 16:9, the screen, the name, the dates and the background stay.
        assert_eq!(scene.horizontal, was.horizontal);
        assert_eq!(scene.shows, was.shows);
        assert_eq!(
            (&scene.name, &scene.created_at, &scene.updated_at),
            (&was.name, &was.created_at, &was.updated_at)
        );
        assert_eq!(scene.background, was.background);
        // The 9:16 look and framing stay; only the layout changes.
        assert_eq!(
            without_preset(&scene.vertical),
            without_preset(&was.vertical)
        );
    }
    assert_eq!(
        by_id(&after, "default-screen-only"),
        by_id(&before, "default-screen-only")
    );
    assert_eq!(
        by_id(&after, "default-camera-only"),
        by_id(&before, "default-camera-only")
    );
    assert_eq!(after.on_stream_id, before.on_stream_id);
    // Camera only is on stream: the working setup is not moved.
    assert_eq!(repair.working, None);
}

#[test]
fn the_repair_runs_once() {
    let repaired = repair_stored_scene_verticals(&owner()[SCENES_KEY], None)
        .unwrap()
        .library;
    assert_eq!(repair_stored_scene_verticals(&repaired, None), None);
    let mut picked = hydrated(&repaired);
    let index = picked
        .scenes
        .iter()
        .position(|scene| scene.id == "default-side-by-side")
        .unwrap();
    picked.scenes[index].vertical["layoutPreset"] = json!("vertical-camera-only");
    assert_eq!(repair_stored_scene_verticals(&picked.to_json(), None), None);
    // A library the migration makes now needs no repair.
    let migrated = migrate("vertical-follow-on").library.to_json();
    assert_eq!(repair_stored_scene_verticals(&migrated, None), None);
}

#[test]
fn the_repair_moves_the_working_setup_only_when_it_is_exactly_the_stored_layout() {
    let library = owner()[SCENES_KEY].clone();
    let screen_camera = by_id(&hydrated(&library), "default-screen-camera").clone();
    let mut working = owner()[WORKING_SCENE_KEY].clone();
    working["sceneId"] = json!("default-screen-camera");
    working["visual"]["layout"] = screen_camera.vertical.clone();
    let repair = repair_stored_scene_verticals(&library, Some(&working)).unwrap();
    let moved = hydrate_working_scene(repair.working.as_ref()).unwrap();
    assert_eq!(moved.scene_id.as_deref(), Some("default-screen-camera"));
    assert_eq!(
        moved.visual["layout"],
        by_id(&hydrated(&repair.library), "default-screen-camera").vertical
    );
    assert_eq!(
        moved.visual["sources"],
        hydrate_working_scene(Some(&working)).unwrap().visual["sources"]
    );
    // A working look that drifted from the scene is the streamer's.
    let mut drifted = working.clone();
    drifted["visual"]["layout"]["cameraZoom"] = json!(150);
    assert_eq!(
        repair_stored_scene_verticals(&library, Some(&drifted))
            .unwrap()
            .working,
        None
    );
    // A 16:9 studio's program is the 16:9 layout: nothing to move.
    let mut horizontal = working.clone();
    horizontal["visual"]["layout"] = screen_camera.horizontal.clone();
    assert_eq!(
        repair_stored_scene_verticals(&library, Some(&horizontal))
            .unwrap()
            .working,
        None
    );
}

#[test]
fn the_repair_touches_only_default_scenes_on_their_own_16_9_layout() {
    let library = owner()[SCENES_KEY].clone();
    let mut scenes: Vec<Value> = library["scenes"].as_array().unwrap().clone();
    for scene in &mut scenes {
        match scene["id"].as_str().unwrap() {
            "default-screen-camera" => {
                scene["layouts"]["horizontal"]["layoutPreset"] = json!("screen-only")
            }
            "default-side-by-side" => {
                scene["layouts"]["vertical"]["arrangementMode"] = json!("freeform")
            }
            _ => {}
        }
    }
    let mut saved = scenes[0].clone();
    saved["id"] = json!("scene-figma");
    saved["name"] = json!("Figma");
    saved["layouts"] = library["scenes"][0]["layouts"].clone();
    let mut all = scenes.clone();
    all.push(saved);
    all.push(json!({"broken": true}));
    let mut raw = library.clone();
    raw["scenes"] = Value::Array(all.clone());
    let repair = repair_stored_scene_verticals(&raw, None).unwrap();
    assert!(repair.repaired.is_empty());
    // Still marked; the invalid entry stays as stored.
    assert_eq!(repair.library["verticalLayoutsRepaired"], true);
    assert_eq!(repair.library["scenes"], Value::Array(all));
}

#[test]
fn the_repair_puts_screen_only_and_camera_only_on_their_own_twin() {
    let mut library = owner()[SCENES_KEY].clone();
    for scene in library["scenes"].as_array_mut().unwrap() {
        if matches!(
            scene["id"].as_str(),
            Some("default-camera-only" | "default-screen-only")
        ) {
            scene["layouts"]["vertical"]["layoutPreset"] = json!("vertical-camera-bottom");
        }
    }
    let repaired = hydrated(
        &repair_stored_scene_verticals(&library, None)
            .unwrap()
            .library,
    );
    assert_eq!(
        layout_preset(&by_id(&repaired, "default-screen-only").vertical),
        "vertical-screen-only"
    );
    assert_eq!(
        layout_preset(&by_id(&repaired, "default-camera-only").vertical),
        "vertical-camera-only"
    );
}

#[test]
fn nothing_usable_stored_is_nothing_to_repair() {
    assert_eq!(repair_stored_scene_verticals(&Value::Null, None), None);
    assert_eq!(
        repair_stored_scene_verticals(&json!({"version": 3, "scenes": []}), None),
        None
    );
}

#[test]
fn each_16_9_layout_has_the_9_16_twin_that_shows_the_same_sources() {
    assert_eq!(vertical_twin_preset("screen-camera"), "vertical-camera-top");
    assert_eq!(vertical_twin_preset("side-by-side"), "vertical-camera-top");
    assert_eq!(vertical_twin_preset("screen-only"), "vertical-screen-only");
    assert_eq!(vertical_twin_preset("camera-only"), "vertical-camera-only");
    assert_eq!(vertical_twin_preset("vertical-split"), "vertical-split");
    assert_eq!(horizontal_twin("vertical-camera-only"), "camera-only");
    assert_eq!(horizontal_twin("vertical-screen-only"), "screen-only");
    assert_eq!(horizontal_twin("vertical-split"), "screen-camera");
}

// ── hydrateScenes and normalizeScene ─────────────────────────────────────

fn display_one() -> MainDisplay {
    MainDisplay {
        id: "screen:1".into(),
        name: "Display 1".into(),
        display_uuid: None,
    }
}

fn good_library() -> SceneLibrary {
    SceneLibrary {
        scenes: default_scenes(Some(&display_one()), NOW),
        on_stream_id: "default-screen-only".into(),
        pending_shortcuts: None,
        vertical_layouts_repaired: false,
    }
}

fn first_scene() -> Value {
    good_library().scenes[0].to_json()
}

fn with(mut scene: Value, patch: Value) -> Value {
    for (key, value) in patch.as_object().unwrap() {
        if value.is_null() {
            scene.as_object_mut().unwrap().remove(key);
        } else {
            scene[key] = value.clone();
        }
    }
    scene
}

#[test]
fn nothing_stored_is_no_library_and_writable() {
    assert_eq!(hydrate_scenes(None), HydratedScenes::default());
    assert_eq!(
        hydrate_scenes(Some(&Value::Null)),
        HydratedScenes::default()
    );
}

#[test]
fn anything_but_version_2_is_read_only() {
    for raw in [
        json!({"version": 1, "scenes": []}),
        json!({"scenes": []}),
        json!("scenes"),
        json!(7),
        json!([]),
    ] {
        let hydrated = hydrate_scenes(Some(&raw));
        assert_eq!(
            (hydrated.library, hydrated.read_only),
            (None, true),
            "{raw}"
        );
    }
}

#[test]
fn only_the_malformed_entries_are_rejected_and_it_says_so() {
    let good = good_library();
    let scene = first_scene();
    let mut entries = vec![
        Value::Null,
        json!("scene"),
        with(scene.clone(), json!({"id": ""})),
        with(scene.clone(), json!({"id": "x".repeat(129)})),
        with(scene.clone(), json!({"id": "no-name", "name": "  "})),
        with(
            scene.clone(),
            json!({"id": "no-shows", "name": "A", "shows": null}),
        ),
        with(
            scene.clone(),
            json!({"id": "odd-shows", "name": "B", "shows": {"kind": "hologram"}}),
        ),
        with(
            scene.clone(),
            json!({"id": "no-window", "name": "C", "shows": {"kind": "window", "windowId": ""}}),
        ),
        with(
            scene.clone(),
            json!({"id": "bad-app", "name": "D", "shows": {"kind": "app", "bundleId": "figma"}}),
        ),
        with(
            scene.clone(),
            json!({"id": "no-display", "name": "E", "shows": {"kind": "display"}}),
        ),
        with(
            scene.clone(),
            json!({"id": "no-layouts", "name": "F", "layouts": null}),
        ),
        with(
            scene.clone(),
            json!({"id": "swapped", "name": "G", "layouts": {
                "horizontal": scene["layouts"]["vertical"],
                "vertical": scene["layouts"]["horizontal"]
            }}),
        ),
        {
            let mut odd = with(scene.clone(), json!({"id": "odd-layout", "name": "H"}));
            odd["layouts"]["horizontal"]["layoutPreset"] = json!("mosaic");
            odd
        },
        with(
            scene.clone(),
            json!({"id": "bad-background", "name": "I", "background": {"assetId": "../x"}}),
        ),
        with(
            scene.clone(),
            json!({"id": "bad-audio", "name": "J", "audio": {"microphoneOff": "yes"}}),
        ),
    ];
    entries.extend(good.scenes.iter().map(Scene::to_json));
    entries.push(with(good.scenes[1].to_json(), json!({"id": "same-name"})));
    entries.push(with(good.scenes[1].to_json(), json!({"name": "Same id"})));
    let mut raw = good.to_json();
    raw["scenes"] = Value::Array(entries);
    let result = hydrate_scenes(Some(&raw));
    assert_eq!(result.library, Some(good));
    assert!(!result.read_only);
    assert_eq!(result.error, Some(SCENES_INVALID_ERROR));
}

#[test]
fn a_lost_on_stream_id_falls_to_the_first_scene() {
    for lost in [json!("gone"), json!(4)] {
        let mut raw = good_library().to_json();
        raw["onStreamId"] = lost;
        assert_eq!(
            hydrate_scenes(Some(&raw)).library.unwrap().on_stream_id,
            "default-screen-camera"
        );
    }
}

#[test]
fn no_usable_scene_is_no_library_still_writable() {
    assert_eq!(
        hydrate_scenes(Some(
            &json!({"version": 2, "scenes": [], "onStreamId": "x"})
        )),
        HydratedScenes::default()
    );
    assert_eq!(
        hydrate_scenes(Some(
            &json!({"version": 2, "scenes": [{}], "onStreamId": "x"})
        )),
        HydratedScenes {
            library: None,
            read_only: false,
            error: Some(SCENES_INVALID_ERROR)
        }
    );
}

#[test]
fn a_scene_keeps_what_it_may_hold_and_drops_what_it_may_not() {
    let scene = first_scene();
    let mut horizontal = scene["layouts"]["horizontal"].clone();
    horizontal["cameraZoom"] = json!(900);
    horizontal["madeUp"] = json!(true);
    let normalized = normalize_scene(&with(
        scene.clone(),
        json!({
            "name": "  Figma  ",
            "shows": {"kind": "app", "bundleId": "com.figma.Desktop", "name": " Figma ", "follows": "yes", "windowId": "window:1"},
            "layouts": {"horizontal": horizontal, "vertical": scene["layouts"]["vertical"]},
            "audio": {"microphoneId": "mic:1", "microphoneOff": false, "systemAudioEnabled": true},
            "cameraId": "camera:1"
        }),
    ))
    .unwrap();
    assert_eq!(normalized.name, "Figma");
    assert_eq!(
        normalized.shows,
        SceneShows::App {
            bundle_id: "com.figma.Desktop".into(),
            name: "Figma".into(),
            follows: false
        }
    );
    assert_eq!(normalized.horizontal["cameraZoom"], 200);
    assert!(normalized.horizontal.get("madeUp").is_none());
    assert_eq!(
        json!(normalized.audio.as_ref().unwrap()),
        json!({"microphoneId": "mic:1", "microphoneOff": false, "systemAudioEnabled": true})
    );
    assert!(normalized.to_json().get("cameraId").is_none());
    let uuid_alone = with(
        scene.clone(),
        json!({"shows": {"kind": "display", "screenId": "", "screenUuid": "U"}}),
    );
    assert_eq!(
        normalize_scene(&uuid_alone).unwrap().shows,
        SceneShows::unnamed_display()
    );
    let window = with(
        scene,
        json!({"shows": {"kind": "window", "windowId": "w", "windowName": "Notes"}}),
    );
    assert_eq!(
        normalize_scene(&window).unwrap().shows.to_json(),
        json!({"kind": "window", "windowId": "w", "windowName": "Notes"})
    );
}

// ── scene helpers ────────────────────────────────────────────────────────

fn plan_210_scenes() -> Vec<Scene> {
    migrate("plan-210-user").library.scenes
}

fn with_shows(shows: SceneShows, patch: Value) -> Scene {
    let mut scene = default_scenes(None, NOW).remove(0);
    scene.shows = shows;
    for (key, value) in patch.as_object().unwrap() {
        scene.horizontal[key] = value.clone();
    }
    scene
}

#[test]
fn scenes_are_found_by_position_and_positions_by_id() {
    let list = plan_210_scenes();
    assert_eq!(scene_at_position(&list, 1).unwrap().id, "5d0c8a4e-figma");
    assert_eq!(
        scene_at_position(&list, 5).unwrap().id,
        "default-side-by-side"
    );
    for position in [0, 6] {
        assert!(scene_at_position(&list, position).is_none());
    }
    assert_eq!(scene_position(&list, "9b7e21c3-t3code"), Some(2));
    assert_eq!(scene_position(&list, "gone"), None);
    let scene = &list[2];
    assert_eq!(
        layout_preset(scene.layout(Orientation::Horizontal)),
        "screen-only"
    );
    assert_eq!(
        layout_preset(scene.layout(Orientation::Vertical)),
        "vertical-screen-only"
    );
}

#[test]
fn the_first_scene_with_a_layout_is_found_per_orientation() {
    let list = plan_210_scenes();
    let first = |list: &[Scene], orientation, preset| {
        first_scene_with_layout(list, orientation, preset).map(|scene| scene.id.clone())
    };
    assert_eq!(
        first(&list, Orientation::Horizontal, "screen-camera").as_deref(),
        Some("5d0c8a4e-figma")
    );
    assert_eq!(
        first(&list, Orientation::Horizontal, "side-by-side").as_deref(),
        Some("default-side-by-side")
    );
    assert_eq!(
        first(&list, Orientation::Vertical, "vertical-screen-only").as_deref(),
        Some("default-screen-only")
    );
    assert_eq!(first(&list, Orientation::Vertical, "vertical-split"), None);
    assert_eq!(
        first(&list, Orientation::Horizontal, "vertical-camera-top"),
        None
    );
    // A Freeform arrangement is not the layout underneath it.
    let mut with_freeform = vec![with_shows(
        SceneShows::None,
        json!({"arrangementMode": "freeform"}),
    )];
    with_freeform.extend(list);
    assert_eq!(
        first(&with_freeform, Orientation::Horizontal, "screen-camera").as_deref(),
        Some("5d0c8a4e-figma")
    );
}

#[test]
fn whether_a_scene_can_be_deleted_d16() {
    let named = |id: &str| -> Scene {
        let mut scene = default_scenes(None, NOW).remove(0);
        scene.id = id.to_string();
        scene
    };
    let list = vec![named("a"), named("b"), named("c")];
    let ask = |id: &str, on: &str, active: bool| can_delete_scene(&list, id, on, active, false);
    assert_eq!(
        can_delete_scene(&[named("a")], "a", "a", false, false),
        DeleteRule::Refused(Some(KEEP_ONE_SCENE_REASON))
    );
    assert_eq!(
        ask("b", "a", false),
        DeleteRule::Allowed { switch_to: None }
    );
    assert_eq!(ask("b", "a", true), DeleteRule::Allowed { switch_to: None });
    // Off air, the scene on stream goes after a switch to the one before it.
    assert_eq!(
        ask("c", "c", false),
        DeleteRule::Allowed {
            switch_to: Some("b".into())
        }
    );
    assert_eq!(
        ask("b", "b", false),
        DeleteRule::Allowed {
            switch_to: Some("a".into())
        }
    );
    assert_eq!(
        ask("a", "a", false),
        DeleteRule::Allowed {
            switch_to: Some("b".into())
        }
    );
    assert_eq!(
        ask("b", "b", true),
        DeleteRule::Refused(Some(DELETE_ON_STREAM_REASON))
    );
    assert_eq!(ask("gone", "a", false), DeleteRule::Refused(None));
    assert_eq!(
        can_delete_scene(&list, "b", "a", false, true),
        DeleteRule::Refused(Some(GOING_ON_STREAM_REASON))
    );
}

#[test]
fn what_two_scenes_show_is_compared() {
    let display = |id: &str, uuid: Option<&str>| SceneShows::Display {
        screen_id: id.into(),
        screen_name: None,
        screen_uuid: uuid.map(str::to_string),
    };
    let app = |follows| SceneShows::App {
        bundle_id: "a.b".into(),
        name: "A".into(),
        follows,
    };
    assert!(same_shows(
        &display("1", Some("U")),
        &display("9", Some("U"))
    ));
    assert!(!same_shows(
        &display("1", Some("U")),
        &display("1", Some("V"))
    ));
    assert!(same_shows(&display("1", Some("U")), &display("1", None)));
    assert!(!same_shows(&display("1", None), &display("2", None)));
    assert!(same_shows(&display("", None), &display("", None)));
    assert!(same_shows(&app(true), &app(false)));
    let window = SceneShows::Window {
        window_id: "w".into(),
        window_name: None,
    };
    assert!(!same_shows(&window, &app(true)));
    assert!(same_shows(&SceneShows::None, &SceneShows::None));
    assert!(!same_shows(&SceneShows::None, &SceneShows::TestPattern));
}

#[test]
fn sources_turn_into_what_a_scene_shows_and_back() {
    let cases = [
        (
            json!({"windowId": "w", "app": {"bundleId": "a.b", "name": "A", "follows": true}}),
            json!({"kind": "app", "bundleId": "a.b", "name": "A", "follows": true}),
        ),
        (
            json!({"windowId": "w", "windowName": "Notes"}),
            json!({"kind": "window", "windowId": "w", "windowName": "Notes"}),
        ),
        (
            json!({"screenId": "s", "screenName": "Display 1", "screenUuid": "U"}),
            json!({"kind": "display", "screenId": "s", "screenName": "Display 1", "screenUuid": "U"}),
        ),
        (
            json!({"testPattern": true}),
            json!({"kind": "test-pattern"}),
        ),
        (json!({"captureOff": true}), json!({"kind": "none"})),
        (
            json!({"cameraId": "c"}),
            json!({"kind": "display", "screenId": ""}),
        ),
    ];
    for (sources, shows) in &cases {
        let from = shows_from_sources(sources);
        assert_eq!(&from.to_json(), shows);
        assert_eq!(shows_from_sources(&shows_sources(&from).to_json()), from);
    }
    // Every capture key is written, so the previous screen never survives.
    let mut sources = serde_json::Map::new();
    sources.insert("screenId".into(), json!("old"));
    sources.insert("cameraId".into(), json!("camera:1"));
    shows_sources(&SceneShows::None).apply_to(&mut sources);
    assert_eq!(
        Value::Object(sources),
        json!({"cameraId": "camera:1", "captureOff": true, "testPattern": false})
    );
}

#[test]
fn the_layout_names_read_as_electrons() {
    assert_eq!(
        layout_preset_label("screen-camera", false),
        "Screen + camera"
    );
    assert_eq!(
        layout_preset_label("vertical-screen-camera", false),
        "Screen + camera"
    );
    assert_eq!(
        layout_preset_label("vertical-screen-camera", true),
        "Vertical screen + camera"
    );
    assert_eq!(
        layout_preset_label("vertical-camera-bottom", true),
        "Camera bottom"
    );
    assert_eq!(layout_preset_label("mosaic", false), "mosaic");
}

#[test]
fn an_edit_on_stream_saves_into_its_scene_d11() {
    let scenes = default_scenes(Some(&display_one()), NOW);
    let on = &scenes[0];
    let sources = shows_sources(&on.shows).to_json();
    let mut layout = on.horizontal.clone();
    layout["cameraMirror"] = json!(true);
    let visual = json!({"layout": layout, "sources": sources, "background": null});
    let input = |previous: Option<&str>, previous_shows: Option<&SceneShows>, visual: &Value| {
        scene_edit_autosave(&EditAutosave {
            previous_scene_id: previous,
            previous_shows,
            scene_id: Some(&on.id),
            scenes: &scenes,
            visual,
            now: "later",
        })
    };
    // The commit that puts a scene on stream is a switch, not an edit.
    assert_eq!(input(None, None, &visual), None);
    let saved = input(Some(&on.id), Some(&on.shows), &visual).unwrap();
    assert_eq!(saved.horizontal["cameraMirror"], true);
    assert_eq!(saved.vertical, on.vertical);
    assert_eq!(saved.updated_at, "later");
    // Nothing changed: nothing written.
    let same = json!({"layout": on.horizontal, "sources": sources, "background": null});
    assert_eq!(input(Some(&on.id), Some(&on.shows), &same), None);
    // A Screen pick while on stream writes the screen (D2).
    let picked =
        json!({"layout": on.horizontal, "sources": {"screenId": "screen:2"}, "background": null});
    let saved = input(Some(&on.id), Some(&on.shows), &picked).unwrap();
    assert_eq!(shows_tag(&saved.shows), "display:screen:2");
    // Without what the capture showed before, a different capture is not a
    // pick (D18: a capture kept under a scene that shows none).
    assert_eq!(input(Some(&on.id), None, &picked), None);
}

#[test]
fn a_scene_that_draws_no_screen_keeps_the_capture_d18() {
    let scenes = default_scenes(Some(&display_one()), NOW);
    let camera_only = &scenes[2];
    let screen = &scenes[0];
    assert!(scene_keeps_capture(
        Some(camera_only),
        &camera_only.horizontal,
        false
    ));
    assert!(!scene_keeps_capture(
        Some(screen),
        &screen.horizontal,
        false
    ));
    assert!(!scene_keeps_capture(None, &screen.horizontal, false));
    // A vertical leg that draws a screen needs the scene's own.
    let mut vertical_screen = camera_only.clone();
    vertical_screen.vertical["layoutPreset"] = json!("vertical-camera-top");
    assert!(!scene_keeps_capture(
        Some(&vertical_screen),
        &camera_only.horizontal,
        true
    ));
    let working = SceneShows::Display {
        screen_id: "screen:9".into(),
        screen_name: None,
        screen_uuid: None,
    };
    assert!(!scene_capture_is_borrowed(camera_only, &working));
    assert!(scene_capture_is_borrowed(screen, &working));
    let mut borrowed = screen.clone();
    borrowed.horizontal["layoutPreset"] = json!("camera-only");
    assert!(vertical_leg_borrows_screen(
        &borrowed,
        &borrowed.horizontal,
        true,
        &working
    ));
    assert!(!vertical_leg_borrows_screen(
        &borrowed,
        &borrowed.horizontal,
        false,
        &working
    ));
    assert_eq!(
        no_screen_layout_reason("Talk"),
        "“Talk” shows no screen. Choose one with Change screen… first."
    );
    assert!(same_capture_target(
        &json!({"screenId": "s"}),
        &json!({"screenId": "s", "testPattern": false})
    ));
    assert!(!same_capture_target(
        &json!({"screenId": "s"}),
        &json!({"windowId": "w"})
    ));
}

#[test]
fn what_a_scene_shows_is_said_in_words() {
    use super::section::scene_shows_words;
    let app = SceneShows::App {
        bundle_id: "com.figma.Desktop".into(),
        name: "Figma".into(),
        follows: true,
    };
    let words = |shows: SceneShows, patch: Value| {
        scene_shows_words(&with_shows(shows, patch), Orientation::Horizontal)
    };
    assert_eq!(words(app.clone(), json!({})), "Figma · front window");
    let window = |name: Option<&str>| SceneShows::Window {
        window_id: "w".into(),
        window_name: name.map(str::to_string),
    };
    assert_eq!(words(window(Some("Notes")), json!({})), "Window · Notes");
    assert_eq!(words(window(None), json!({})), "Window");
    let display = SceneShows::Display {
        screen_id: "s".into(),
        screen_name: Some("Display 1".into()),
        screen_uuid: None,
    };
    assert_eq!(words(display, json!({})), "Display 1");
    assert_eq!(words(SceneShows::unnamed_display(), json!({})), "Display");
    assert_eq!(words(SceneShows::TestPattern, json!({})), "Test pattern");
    assert_eq!(words(SceneShows::None, json!({})), "No screen");
    // A layout with no screen says the layout; Freeform shows what it has.
    assert_eq!(
        words(app.clone(), json!({"layoutPreset": "camera-only"})),
        "Camera only"
    );
    assert_eq!(
        words(
            app.clone(),
            json!({"layoutPreset": "camera-only", "arrangementMode": "freeform"})
        ),
        "Figma · front window"
    );
    // Each orientation by its own layout.
    let mut camera_only = default_scenes(Some(&display_one()), NOW).remove(2);
    camera_only.shows = app;
    assert_eq!(
        scene_shows_words(&camera_only, Orientation::Vertical),
        "Camera only"
    );
    // #1706: after the repair, a screen scene says its screen in 9:16 too.
    let before = hydrated(&owner()[SCENES_KEY]);
    let after = hydrated(
        &repair_stored_scene_verticals(&owner()[SCENES_KEY], None)
            .unwrap()
            .library,
    );
    for scene in &after.scenes {
        assert_eq!(
            scene_shows_words(scene, Orientation::Vertical),
            scene_shows_words(scene, Orientation::Horizontal)
        );
    }
    assert_eq!(
        scene_shows_words(
            by_id(&before, "default-screen-camera"),
            Orientation::Vertical
        ),
        "Camera only"
    );
    assert_eq!(
        scene_shows_words(
            by_id(&after, "default-screen-camera"),
            Orientation::Vertical
        ),
        "Display 1"
    );
}
