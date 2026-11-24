//! `lib/scene-list.test.ts`, `scene-shortcuts.test.ts` and
//! `scene-shortcut-walk.test.ts`, case for case.

use std::collections::HashMap;

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceApp, DeviceKind, DeviceStatus};

use super::*;
use crate::scenes::model::{SavedScene, moved_scenes, normalize_scene_visual};
use crate::scenes::window::{AppWindowFailure, SceneAppState};
use crate::studio::capture_config::default_layout;

fn scene(id: &str, name: &str, sources: Value, preset: &str) -> SavedScene {
    let mut layout = default_layout();
    layout["layoutPreset"] = json!(preset);
    let mut with_camera = json!({"cameraId": "camera"});
    for (key, value) in sources.as_object().unwrap() {
        with_camera[key] = value.clone();
    }
    SavedScene {
        id: id.into(),
        name: name.into(),
        created_at: "2026-10-28".into(),
        updated_at: "2026-10-28".into(),
        visual: normalize_scene_visual(
            &json!({"layout": layout, "sources": with_camera, "background": null}),
        )
        .unwrap(),
        audio: None,
        cloud: None,
    }
}

fn display(id: &str, name: &str) -> SavedScene {
    scene(
        id,
        name,
        json!({"screenId": "screen:1", "screenName": "Display 1"}),
        "screen-camera",
    )
}

fn figma() -> SavedScene {
    scene(
        "figma",
        "Figma",
        json!({"windowId": "window:7", "app": {"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}}),
        "screen-camera",
    )
}

fn device(id: &str, name: &str, kind: DeviceKind, app: Option<DeviceApp>) -> Device {
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "kind": kind,
        "status": DeviceStatus::Available,
        "app": app,
    }))
    .unwrap()
}

fn window(id: &str, bundle_id: &str, name: &str) -> Device {
    device(
        id,
        &format!("{name} - Untitled"),
        DeviceKind::Window,
        Some(
            serde_json::from_value(json!({"bundleId": bundle_id, "name": name, "pid": 4})).unwrap(),
        ),
    )
}

#[test]
fn one_scene_moves_and_a_move_that_goes_nowhere_is_refused() {
    let scenes = vec![display("a", "A"), display("b", "B"), display("c", "C")];
    let ids = |moved: Option<Vec<SavedScene>>| {
        moved.map(|scenes| scenes.into_iter().map(|scene| scene.id).collect::<Vec<_>>())
    };
    assert_eq!(
        ids(moved_scenes(&scenes, "c", 0)),
        Some(vec!["c".into(), "a".into(), "b".into()])
    );
    assert_eq!(
        ids(moved_scenes(&scenes, "a", 2)),
        Some(vec!["b".into(), "c".into(), "a".into()])
    );
    assert_eq!(ids(moved_scenes(&scenes, "a", 0)), None);
    assert_eq!(ids(moved_scenes(&scenes, "a", 3)), None);
    assert_eq!(ids(moved_scenes(&scenes, "missing", 1)), None);
}

fn key(key: &str, alt: bool, ctrl: bool, meta: bool, shift: bool, axis: MoveAxis) -> Option<i32> {
    scene_move_key_step(
        MoveKey {
            key,
            alt,
            ctrl,
            meta,
            shift,
        },
        axis,
    )
}

#[test]
fn a_focused_row_moves_with_alt_up_and_down_alone() {
    let v = MoveAxis::Vertical;
    assert_eq!(key("ArrowUp", true, false, false, false, v), Some(-1));
    assert_eq!(key("ArrowDown", true, false, false, false, v), Some(1));
    assert_eq!(key("ArrowLeft", true, false, false, false, v), None);
    assert_eq!(key("ArrowUp", false, false, false, false, v), None);
    assert_eq!(key("ArrowUp", true, false, false, true, v), None);
    assert_eq!(key("ArrowDown", true, false, true, false, v), None);
}

#[test]
fn a_focused_card_moves_with_alt_left_and_right_alone() {
    let h = MoveAxis::Horizontal;
    assert_eq!(key("ArrowLeft", true, false, false, false, h), Some(-1));
    assert_eq!(key("ArrowRight", true, false, false, false, h), Some(1));
    assert_eq!(key("ArrowUp", true, false, false, false, h), None);
    assert_eq!(key("ArrowRight", false, false, false, false, h), None);
    assert_eq!(key("ArrowLeft", true, true, false, false, h), None);
}

#[test]
fn app_scenes_and_known_fixed_windows_draw_the_app_icon() {
    let devices = vec![window("window:1", "com.apple.Notes", "Notes")];
    assert_eq!(
        scene_glyph(&figma().visual, &[]),
        SceneGlyph::App {
            bundle_id: "com.figma.Desktop".into()
        }
    );
    let fixed = |id: &str| scene("w", "W", json!({"windowId": id}), "screen-camera");
    assert_eq!(
        scene_glyph(&fixed("window:1").visual, &devices),
        SceneGlyph::App {
            bundle_id: "com.apple.Notes".into()
        }
    );
    assert_eq!(
        scene_glyph(&fixed("window:9").visual, &devices),
        SceneGlyph::Window
    );
    assert_eq!(
        scene_glyph(&display("d", "D").visual, &devices),
        SceneGlyph::Display
    );
    let camera_only = scene("c", "C", json!({}), "camera-only");
    assert_eq!(
        scene_glyph(&camera_only.visual, &devices),
        SceneGlyph::Camera
    );
}

#[test]
fn a_scene_whose_app_is_not_ready_is_off_in_the_switchs_words() {
    let camera = device("camera", "FaceTime", DeviceKind::Camera, None);
    let blocked = |state: Option<SceneAppState>| {
        saved_scene_blocked_reason(&figma().visual, state, std::slice::from_ref(&camera))
    };
    assert_eq!(blocked(Some(SceneAppState::Ready)), None);
    assert_eq!(blocked(None), None);
    assert_eq!(
        blocked(Some(SceneAppState::Failed(AppWindowFailure::NotRunning))).as_deref(),
        Some("Figma isn't open")
    );
    assert_eq!(
        blocked(Some(SceneAppState::Failed(AppWindowFailure::NoWindow))).as_deref(),
        Some("Figma has no window open")
    );
    assert_eq!(
        blocked(Some(SceneAppState::Failed(AppWindowFailure::Minimized))).as_deref(),
        Some("Figma's window is minimized")
    );
    // Plan 231 D4: every scene has a layout for each orientation.
    let vertical = scene("v", "V", json!({}), "vertical-screen-camera");
    assert_eq!(
        saved_scene_blocked_reason(&vertical.visual, None, std::slice::from_ref(&camera)),
        None
    );
    // An app's scene can't ask to resolve its sources: its camera says so.
    assert_eq!(
        saved_scene_blocked_reason(&figma().visual, Some(SceneAppState::Ready), &[]).as_deref(),
        Some("Camera unavailable. Choose a replacement in Sources.")
    );
}

#[test]
fn a_scene_is_named_uniquely() {
    let scenes = vec![display("a", "Figma"), display("b", "figma 2")];
    assert_eq!(unique_scene_name("Figma", &scenes, None), "Figma 3");
    assert_eq!(unique_scene_name("Figma", &scenes, Some("a")), "Figma");
    assert_eq!(unique_scene_name::<SavedScene>("  ", &[], None), "Scene");
    let long = vec![display("a", &"x".repeat(80))];
    assert_eq!(
        unique_scene_name(&"x".repeat(90), &long, None),
        format!("{} 2", "x".repeat(78))
    );
}

#[test]
fn following_turns_off_and_on_only_for_app_scenes() {
    let off = scene_with_follow(&figma(), false, "now");
    assert_eq!(off.visual["sources"]["app"]["follows"], false);
    assert_eq!(off.updated_at, "now");
    let shown = display("d", "D");
    assert_eq!(scene_with_follow(&shown, true, "now"), shown);
}

#[test]
fn save_audio_to_scene_writes_the_microphone_and_system_audio() {
    let audio = crate::scenes::model::SceneAudio {
        microphone_id: None,
        microphone_name: Some("Shure".into()),
        microphone_off: true,
        system_audio_enabled: true,
    };
    let saved = scene_with_audio(&figma(), audio.clone(), "now");
    assert_eq!(saved.audio, Some(audio));
}

/// A scene known only by id and name, as the key lists take them.
#[derive(Clone)]
struct Named(&'static str, &'static str);

impl crate::scenes::model::NamedScene for Named {
    fn scene_id(&self) -> &str {
        self.0
    }
    fn scene_name(&self) -> &str {
        self.1
    }
}

fn shortcut(action: &str, label: &str, accelerator: &str) -> SceneShortcut {
    SceneShortcut {
        action: action.into(),
        label: label.into(),
        accelerator: accelerator.into(),
    }
}

#[test]
fn nine_positions_then_custom_keys_only() {
    let scenes = [Named("figma", "Figma"), Named("t3", "T3 Code")];
    let config = json!({"scenes": {"figma": "F13", "t3": ""}});
    let rows = scene_shortcut_rows(&scenes, Some(&config), Some("darwin"));
    assert_eq!(rows.len(), 10);
    assert_eq!(
        rows[0],
        shortcut("scene-slot-1", "Scene 1 · Figma", "Control+Alt+1")
    );
    assert_eq!(
        rows[2],
        shortcut("scene-slot-3", "Scene 3 · no scene", "Control+Alt+3")
    );
    assert_eq!(rows[9], shortcut("scene:figma", "Figma", "F13"));
    let reversed = [Named("t3", "T3 Code"), Named("figma", "Figma")];
    assert_eq!(
        scene_shortcut_rows(&reversed, Some(&json!({})), Some("win32"))[0],
        shortcut("scene-slot-1", "Scene 1 · T3 Code", "Control+Alt+Shift+1")
    );
    assert_eq!(
        scene_shortcut_rows::<Named>(&[], None, Some("linux")).len(),
        9
    );
}

#[test]
fn the_custom_key_stays_beside_a_position_key() {
    let config = json!({"scenes": {"figma": "F13"}, "sceneSlots": {"2": "F14", "3": ""}});
    let pairs = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    };
    assert_eq!(
        scene_shortcut_bindings("figma", 1, Some(&config), Some("darwin")),
        pairs(&[("scene-slot-1", "Control+Alt+1"), ("scene:figma", "F13")])
    );
    assert_eq!(
        scene_shortcut_bindings("figma", 2, Some(&config), Some("darwin")),
        pairs(&[("scene-slot-2", "F14"), ("scene:figma", "F13")])
    );
    for position in [3, 10] {
        assert_eq!(
            scene_shortcut_bindings("figma", position, Some(&config), Some("darwin")),
            pairs(&[("scene:figma", "F13")])
        );
    }
    assert!(scene_shortcut_bindings("t3", 10, Some(&config), Some("darwin")).is_empty());
}

fn walk(
    current: &str,
    forward: bool,
    scenes: &[Named],
    app_states: &[(&str, SceneAppState)],
    unavailable: &[&str],
) -> Option<String> {
    let states: HashMap<String, SceneAppState> = app_states
        .iter()
        .map(|(id, state)| (id.to_string(), *state))
        .collect();
    let gone: Vec<String> = unavailable.iter().map(|id| id.to_string()).collect();
    next_eligible_scene(current, forward, scenes, &states, &gone)
}

#[test]
fn the_walk_follows_library_order_and_wraps_both_ways() {
    let scenes = [
        Named("a", "Figma"),
        Named("b", "T3 Code"),
        Named("c", "Chrome"),
    ];
    assert_eq!(
        walk("scene:a", true, &scenes, &[], &[]).as_deref(),
        Some("scene:b")
    );
    assert_eq!(
        walk("scene:b", true, &scenes, &[], &[]).as_deref(),
        Some("scene:c")
    );
    assert_eq!(
        walk("scene:c", false, &scenes, &[], &[]).as_deref(),
        Some("scene:b")
    );
    assert_eq!(
        walk("scene:a", false, &scenes, &[], &[]).as_deref(),
        Some("scene:c")
    );
    assert_eq!(
        walk("scene:c", true, &scenes, &[], &[]).as_deref(),
        Some("scene:a")
    );
}

#[test]
fn the_walk_skips_unavailable_scenes_without_moving_them() {
    let scenes = [
        Named("a", "Figma"),
        Named("b", "T3 Code"),
        Named("c", "Chrome"),
    ];
    let closed = [("b", SceneAppState::Failed(AppWindowFailure::NotRunning))];
    assert_eq!(
        walk("scene:a", true, &scenes, &closed, &[]).as_deref(),
        Some("scene:c")
    );
    assert_eq!(
        walk("scene:deleted", true, &scenes, &[], &[]).as_deref(),
        Some("scene:a")
    );
    assert_eq!(
        walk("scene:deleted", false, &scenes, &[], &[]).as_deref(),
        Some("scene:c")
    );
    assert_eq!(
        walk("scene:a", true, &scenes, &[], &["b"]).as_deref(),
        Some("scene:c")
    );
    assert_eq!(walk("scene:a", true, &scenes, &[], &["b", "c"]), None);
    assert_eq!(walk("scene:a", true, &[], &[], &[]), None);
    assert_eq!(walk("scene:a", true, &scenes[..1], &[], &[]), None);
    let reordered = [
        Named("c", "Chrome"),
        Named("b", "T3 Code"),
        Named("a", "Figma"),
    ];
    assert_eq!(
        walk("scene:a", true, &reordered, &[], &[]).as_deref(),
        Some("scene:c")
    );
}
