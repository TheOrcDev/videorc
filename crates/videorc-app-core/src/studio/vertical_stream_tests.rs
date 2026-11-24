//! `vertical-stream-layout-control.test.ts` and `camera-background.test.ts`'
//! leg cases, with the leg's builders.

use serde_json::{Map, Value, json};

use super::*;
use crate::scenes::v2::{Scene, SceneShows};

fn scene(vertical: Value, shows: SceneShows) -> Scene {
    Scene {
        id: "talk".into(),
        name: "Talk".into(),
        created_at: String::new(),
        updated_at: String::new(),
        shows,
        horizontal: json!({"layoutPreset": "screen-camera"}),
        vertical,
        background: Value::Null,
        audio: None,
        cloud: None,
    }
}

fn patch(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

#[test]
fn the_leg_is_the_scenes_9_16_layout_with_the_programs_source_looks() {
    let vertical = json!({
        "layoutPreset": "vertical-screen-camera",
        "verticalScreenFraming": "fit",
        "cameraShape": "circle",
        "cameraMirror": false,
        "cameraChromaKeyEnabled": true,
        "sourceVisibility": {"camera": false, "capture": true}
    });
    let program = json!({
        "layoutPreset": "screen-camera",
        "cameraShape": "rectangle",
        "cameraMirror": true,
        "cameraChromaKeyEnabled": false,
        "cameraBackground": {"mode": "blur", "blurPct": 70, "edges": "balanced"},
        "sourceVisibility": {"camera": true, "capture": true}
    });
    let leg = simulcast_leg_layout(&vertical, &program);
    // The scene's own layout, framing and camera shape.
    assert_eq!(leg["layoutPreset"], "vertical-screen-camera");
    assert_eq!(leg["verticalScreenFraming"], "fit");
    assert_eq!(leg["cameraShape"], "circle");
    // The program's look of the sources.
    assert_eq!(leg["cameraMirror"], true);
    assert_eq!(leg["cameraChromaKeyEnabled"], false);
    assert_eq!(leg["cameraBackground"]["mode"], "blur");
    assert_eq!(
        leg["sourceVisibility"],
        json!({"camera": true, "capture": true})
    );
    // A key the program doesn't have is dropped from the leg.
    let bare = simulcast_leg_layout(&vertical, &json!({"layoutPreset": "screen-camera"}));
    assert!(bare.get("cameraMirror").is_none());
    assert!(bare.get("sourceVisibility").is_none());
}

#[test]
fn no_scene_or_no_canvas_means_no_leg() {
    let on = scene(
        json!({"layoutPreset": "vertical-split"}),
        SceneShows::TestPattern,
    );
    let program = json!({"layoutPreset": "screen-camera"});
    let video = json!({"width": 1080, "height": 1920, "fps": 30});
    assert_eq!(simulcast_params(None, &program, Some(&video)), None);
    assert_eq!(simulcast_params(Some(&on), &program, None), None);
    let request = simulcast_leg_live_request(
        &json!({"cameraId": "camera:1"}),
        Some(&on),
        &program,
        Some(&video),
    )
    .unwrap();
    assert_eq!(request["simulcastLeg"], true);
    assert_eq!(request["layout"]["layoutPreset"], "vertical-split");
    assert_eq!(request["video"], video);
    assert_eq!(request["sources"]["cameraId"], "camera:1");
    assert!(request.get("background").is_none());
}

#[test]
fn fill_or_fit_keeps_the_arrangement() {
    let arranged = json!({
        "layoutPreset": "vertical-screen-camera",
        "verticalScreenFraming": "fit",
        "cameraTransformMode": "custom",
        "cameraTransform": {"x": 0.6, "y": 0.7, "width": 0.3, "height": 0.2},
        "cameraShape": "circle"
    });
    let mut expected = arranged.clone();
    expected["verticalScreenFraming"] = json!("fill");
    assert_eq!(
        vertical_stream_layout(
            &arranged,
            &patch(json!({"verticalScreenFraming": "fill"})),
            &json!({"version": 1, "layouts": {}})
        ),
        expected
    );
}

#[test]
fn another_layout_is_a_layout_pick() {
    let arranged = json!({
        "layoutPreset": "vertical-screen-camera",
        "verticalScreenFraming": "fit",
        "cameraTransformMode": "custom",
        "cameraTransform": {"x": 0.6, "y": 0.7, "width": 0.3, "height": 0.2},
        "cameraShape": "circle"
    });
    let memory = json!({"version": 1, "layouts": {"vertical-split": {"cameraZoom": 140}}});
    let next = vertical_stream_layout(
        &arranged,
        &patch(json!({"layoutPreset": "vertical-split"})),
        &memory,
    );
    assert_eq!(next["layoutPreset"], "vertical-split");
    assert_eq!(next["verticalScreenFraming"], "fit");
    assert_eq!(next["cameraShape"], "circle");
    assert_eq!(next["cameraZoom"], 140);
    assert_eq!(next["cameraTransformMode"], "preset");
    assert_eq!(next["cameraTransform"], Value::Null);
    assert_eq!(next["arrangementMode"], "preset");
    assert_eq!(next["sourceTransformOverrides"], json!({}));
}

#[test]
fn the_panel_shows_beside_a_16_9_studio_and_says_what_a_source_blocks() {
    let on = scene(
        json!({"layoutPreset": "vertical-camera-only", "verticalScreenFraming": "fill"}),
        SceneShows::None,
    );
    let capture = json!({
        "layout": {"layoutPreset": "camera-only"},
        "sources": {"cameraId": "camera:1"}
    });
    let view = vertical_stream_layout_view(Some(&on), &capture, false).unwrap();
    assert_eq!(
        view.description,
        "The 9:16 layout of Talk, the scene on stream. Each scene keeps its own."
    );
    assert_eq!(view.preset, "vertical-camera-only");
    assert!(!view.fit);
    // The scene shows no screen: every screen layout is blocked.
    let open: Vec<&str> = view
        .choices
        .iter()
        .filter(|choice| !choice.disabled)
        .map(|choice| choice.preset)
        .collect();
    assert_eq!(open, ["vertical-camera-only"]);
    assert!(view.reason.unwrap().starts_with("No screen is chosen."));
    assert_eq!(view.read_only_reason, None);
    // A 9:16 studio has no second leg: no panel.
    let portrait = json!({"layout": {"layoutPreset": "vertical-camera-only"}, "sources": {}});
    assert_eq!(
        vertical_stream_layout_view(Some(&on), &portrait, false),
        None
    );
    assert_eq!(vertical_stream_layout_view(None, &capture, false), None);
    assert_eq!(
        vertical_stream_layout_view(Some(&on), &capture, true)
            .unwrap()
            .read_only_reason,
        Some(READ_ONLY_REASON)
    );
}
