//! `lib/scene-section.test.ts`, case for case: the reads behind Studio's
//! Scenes section (plan 231 S6).

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::model::normalize_scene_visual;
use super::section::*;
use super::v2::{Orientation, SceneShows};
use crate::studio::capture_config::default_layout;

/// `{...defaultCaptureConfig.layout, layoutPreset}`.
fn layout(preset: &str) -> Value {
    let mut layout = default_layout();
    layout["layoutPreset"] = json!(preset);
    layout
}

fn device(id: &str, name: &str, kind: DeviceKind) -> Device {
    Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: id.into(),
        name: name.into(),
        kind,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
    }
}

/// `normalizeSceneVisual({layout: layout(preset), sources, background: null})`.
fn visual(preset: &str, sources: Value) -> Value {
    normalize_scene_visual(&json!({
        "layout": layout(preset),
        "sources": sources,
        "background": null
    }))
    .unwrap()
}

fn figma_app() -> Value {
    json!({"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true})
}

// ── screenFieldWords (D8) ────────────────────────────────────────────────

#[test]
fn names_what_the_scene_keeps_and_says_when_its_layout_draws_no_screen() {
    let figma = SceneShows::App {
        bundle_id: "com.figma.Desktop".into(),
        name: "Figma".into(),
        follows: true,
    };
    assert_eq!(
        screen_field_words(&figma, &layout("screen-camera")),
        ("Figma · front window".to_string(), None)
    );
    let display = SceneShows::Display {
        screen_id: "screen:1".into(),
        screen_name: Some("Display 1".into()),
        screen_uuid: None,
    };
    assert_eq!(
        screen_field_words(&display, &layout("camera-only")),
        (
            "Display 1".to_string(),
            Some("Not shown in Camera only".to_string())
        )
    );
    assert_eq!(
        screen_field_words(&SceneShows::None, &layout("camera-only")),
        ("No screen".to_string(), None)
    );
    // Freeform draws what it has.
    let mut freeform = layout("camera-only");
    freeform["arrangementMode"] = json!("freeform");
    assert_eq!(screen_field_words(&display, &freeform).1, None);
}

// ── layoutAsksForScreen (D19) ────────────────────────────────────────────

#[test]
fn asks_only_when_a_screen_layout_goes_on_a_scene_that_shows_none() {
    assert!(layout_asks_for_screen(&SceneShows::None, "screen-camera"));
    assert!(layout_asks_for_screen(&SceneShows::None, "vertical-split"));
    assert!(!layout_asks_for_screen(&SceneShows::None, "camera-only"));
    let display = SceneShows::Display {
        screen_id: "screen:1".into(),
        screen_name: None,
        screen_uuid: None,
    };
    assert!(!layout_asks_for_screen(&display, "screen-only"));
}

// ── sceneLayoutChoices ───────────────────────────────────────────────────

#[test]
fn lists_the_layouts_of_the_studios_mode_the_camera_ones_off_without_a_camera() {
    let labels: Vec<String> = scene_layout_choices(Orientation::Horizontal, true)
        .into_iter()
        .map(|choice| choice.label)
        .collect();
    assert_eq!(
        labels,
        [
            "Screen + camera",
            "Screen only",
            "Camera only",
            "Side by side"
        ]
    );
    assert_eq!(scene_layout_choices(Orientation::Vertical, true).len(), 6);
    let off = scene_layout_choices(Orientation::Horizontal, false);
    let disabled: Vec<&str> = off
        .iter()
        .filter(|choice| choice.disabled)
        .map(|choice| choice.value)
        .collect();
    assert_eq!(disabled, ["screen-camera", "camera-only", "side-by-side"]);
    assert_eq!(
        scene_layout_camera_line(&off).as_deref(),
        Some("Choose a camera in Sources to use Screen + camera, Camera only, and Side by side.")
    );
    assert_eq!(
        scene_layout_camera_line(&scene_layout_choices(Orientation::Horizontal, true)),
        None
    );
}

// ── sceneCardsCameraGaps (D9) ────────────────────────────────────────────

fn gap_devices() -> Vec<Device> {
    vec![
        device("camera:1", "FaceTime", DeviceKind::Camera),
        device("screen:screencapturekit:1", "Display 1", DeviceKind::Screen),
    ]
}

/// A card's `(id, name, visual)`: the screen, and the camera or Camera Off.
fn gap_scene(
    id: &'static str,
    name: &'static str,
    preset: &str,
    camera_id: Option<&str>,
) -> (&'static str, &'static str, Value) {
    let mut sources = json!({"screenId": "screen:screencapturekit:1"});
    match camera_id {
        Some(camera_id) => sources["cameraId"] = json!(camera_id),
        None => sources["cameraOff"] = json!(true),
    }
    (id, name, visual(preset, sources))
}

fn gaps_of(scenes: &[(&'static str, &'static str, Value)]) -> CameraGaps {
    let cards: Vec<(&str, &str, &Value)> = scenes
        .iter()
        .map(|(id, name, visual)| (*id, *name, visual))
        .collect();
    scene_cards_camera_gaps(&cards, &gap_devices())
}

#[test]
fn turns_off_the_scenes_that_need_the_one_camera_with_one_line_naming_them() {
    let gaps = gaps_of(&[
        gap_scene("a", "Figma", "screen-only", None),
        gap_scene("b", "Camera only", "camera-only", None),
        gap_scene("c", "Side by side", "side-by-side", None),
    ]);
    assert_eq!(gaps.blocked, ["b", "c"]);
    assert_eq!(
        gaps.reason.as_deref(),
        Some("Camera is off. Choose one in Sources to use Camera only and Side by side.")
    );
}

#[test]
fn says_nothing_while_the_camera_works() {
    let gaps = gaps_of(&[gap_scene(
        "b",
        "Camera only",
        "camera-only",
        Some("camera:1"),
    )]);
    assert!(gaps.blocked.is_empty());
    assert_eq!(gaps.reason, None);
}

// ── landscapeFramingShows ────────────────────────────────────────────────

#[test]
fn landscape_framing_is_for_the_landscape_screen_layouts_with_a_choice_of_fill_or_fit() {
    assert!(landscape_framing_shows(&layout("screen-camera")));
    assert!(landscape_framing_shows(&layout("screen-only")));
    assert!(!landscape_framing_shows(&layout("side-by-side")));
    assert!(!landscape_framing_shows(&layout("camera-only")));
}

// ── sceneSlotKeysLine (D5) ───────────────────────────────────────────────

#[test]
fn teaches_the_platforms_position_keys_while_they_are_the_defaults() {
    assert_eq!(
        scene_slot_keys_line(None, Some("darwin")),
        Some(("Control+Alt+1".to_string(), "Control+Alt+9".to_string()))
    );
    assert_eq!(
        scene_slot_keys_line(Some(&json!({})), Some("win32")),
        Some((
            "Control+Alt+Shift+1".to_string(),
            "Control+Alt+Shift+9".to_string()
        ))
    );
    assert_eq!(
        scene_slot_keys_line(Some(&json!({"sceneSlots": {"9": ""}})), Some("darwin")),
        None
    );
    assert_eq!(
        scene_slot_keys_line(Some(&json!({"sceneSlots": {"1": "F13"}})), Some("linux")),
        None
    );
}

// ── scenePictureTarget (D7, D17) ─────────────────────────────────────────

#[test]
fn asks_for_what_the_scene_shows_the_app_before_its_window_a_fixed_window_a_display() {
    assert_eq!(
        scene_picture_target(&visual(
            "screen-camera",
            json!({"app": figma_app(), "windowId": "window:4"})
        )),
        Some(ScenePictureTarget::App {
            bundle_id: "com.figma.Desktop".into()
        })
    );
    assert_eq!(
        scene_picture_target(&visual("screen-only", json!({"windowId": "window:9"}))),
        Some(ScenePictureTarget::Window {
            window_id: "window:9".into()
        })
    );
    assert_eq!(
        scene_picture_target(&visual("side-by-side", json!({"screenId": "screen:1"}))),
        Some(ScenePictureTarget::Display {
            screen_id: "screen:1".into()
        })
    );
}

#[test]
fn asks_for_nothing_a_card_cant_draw_no_screen_area_no_screen_or_a_test_pattern() {
    assert_eq!(
        scene_picture_target(&visual("camera-only", json!({"screenId": "screen:1"}))),
        None
    );
    assert_eq!(
        scene_picture_target(&visual("screen-only", json!({"captureOff": true}))),
        None
    );
    assert_eq!(
        scene_picture_target(&visual("screen-only", json!({"testPattern": true}))),
        None
    );
}

// ── sceneCardWords ───────────────────────────────────────────────────────

#[test]
fn says_what_the_scene_shows_in_a_few_words_never_its_own_name_again() {
    let words =
        |name: &str, preset: &str, sources: Value| scene_card_words(name, &visual(preset, sources));
    let app = json!({"app": figma_app()});
    assert_eq!(
        words("Figma", "screen-camera", app.clone()).as_deref(),
        Some("Front window")
    );
    assert_eq!(
        words("Figma 2", "screen-camera", app.clone()).as_deref(),
        Some("Front window")
    );
    assert_eq!(
        words("Design", "screen-camera", app).as_deref(),
        Some("Figma · front window")
    );
    assert_eq!(
        words(
            "Screen + camera",
            "screen-camera",
            json!({"screenId": "screen:1", "screenName": "Built-in Retina Display · 3024 × 1964"})
        )
        .as_deref(),
        Some("Built-in Retina Display")
    );
    assert_eq!(
        words(
            "Display 1",
            "screen-only",
            json!({"screenId": "screen:1", "screenName": "Display 1"})
        ),
        None
    );
    assert_eq!(
        words(
            "Notes",
            "screen-only",
            json!({"windowId": "window:9", "windowName": "Ideas"})
        )
        .as_deref(),
        Some("Ideas")
    );
    assert_eq!(
        words(
            "Camera only",
            "camera-only",
            json!({"screenId": "screen:1"})
        )
        .as_deref(),
        Some("No screen")
    );
    assert_eq!(
        words("Break", "screen-only", json!({"captureOff": true})).as_deref(),
        Some("No screen")
    );
}
