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

/// A 16:9 studio with one vertical destination armed.
fn armed_config() -> Value {
    json!({
        "recordEnabled": true,
        "streamEnabled": true,
        "video": {
            "preset": "tutorial-1080p30", "width": 1920, "height": 1080,
            "fps": 30, "bitrateKbps": 6000
        },
        "layout": {"layoutPreset": "screen-camera", "cameraMirror": true},
        "sources": {"cameraId": "camera:1", "screenId": "screen:1"},
        "streaming": {
            "enabled": true,
            "targets": [{
                "id": "shorts", "platform": "youtube", "label": "Shorts",
                "enabled": true, "outputOrientation": "vertical"
            }],
            "defaultOutputPreset": "tutorial-1080p30",
            "defaultBitrateKbps": 6000,
            "enabledTargetIds": ["shorts"]
        }
    })
}

fn portrait(video: &Value) -> bool {
    video["width"].as_u64().unwrap() < video["height"].as_u64().unwrap()
}

#[test]
fn the_legs_canvas_is_portrait_and_only_while_a_vertical_stream_is_armed() {
    let config = armed_config();
    let video = simulcast_leg_video(&config).expect("armed");
    assert!(portrait(&video), "{video}");
    assert_eq!(video["preset"], "custom", "a transposed canvas is Custom");
    assert_eq!(video["fps"], 30);

    // The Output switch off, the destination off or left out, or a 9:16
    // studio: no second leg.
    let mut off = config.clone();
    off["streamEnabled"] = json!(false);
    assert_eq!(simulcast_leg_video(&off), None);
    let mut disabled = config.clone();
    disabled["streaming"]["targets"][0]["enabled"] = json!(false);
    assert_eq!(simulcast_leg_video(&disabled), None);
    let mut left_out = config.clone();
    left_out["streaming"]["enabledTargetIds"] = json!([]);
    assert_eq!(simulcast_leg_video(&left_out), None);
    let mut vertical_studio = config.clone();
    vertical_studio["layout"]["layoutPreset"] = json!("vertical-camera-top");
    assert_eq!(simulcast_leg_video(&vertical_studio), None);
}

#[test]
fn a_start_carries_the_leg_of_the_scene_on_stream_for_what_it_starts() {
    let talk = scene(
        json!({
            "layoutPreset": "vertical-camera-top", "cameraMirror": false,
            "cameraCorner": "bottom-right", "cameraSize": "medium",
            "cameraShape": "circle", "cameraMargin": 24
        }),
        SceneShows::None,
    );
    // The saved mode is Record only; Go Live streams to the destinations
    // this start goes to (`captureConfigForIntent`).
    let mut saved = armed_config();
    saved["streamEnabled"] = json!(false);
    let streaming = saved["streaming"].clone();
    let layout = json!({"layoutPreset": "screen-camera", "cameraMirror": true});
    let go_live = session_capture_config(&saved, false, true, Some(streaming), layout.clone());
    assert_eq!(go_live["recordEnabled"], false);
    assert_eq!(go_live["streamEnabled"], true);
    let leg = start_simulcast(&go_live, Some(&talk)).expect("a leg");
    assert_eq!(leg["layout"]["layoutPreset"], "vertical-camera-top");
    assert_eq!(leg["layout"]["cameraMirror"], true, "the program's look");
    assert!(portrait(&leg["video"]));
    // The typed params the start sends read it.
    let typed: videorc_protocol::SimulcastParams = serde_json::from_value(leg).unwrap();
    assert!(typed.video.width < typed.video.height);
    assert!(typed.scene.is_none());
    assert!(typed.layout.camera_mirror);

    // Record never streams, whatever the saved mode says; no scene on
    // stream, no leg.
    let record = session_capture_config(&armed_config(), true, false, None, layout);
    assert_eq!(start_simulcast(&record, Some(&talk)), None);
    assert_eq!(start_simulcast(&go_live, None), None);
    // A start to destinations with no vertical one has no leg.
    let mut horizontal = armed_config()["streaming"].clone();
    horizontal["targets"][0]["outputOrientation"] = json!("horizontal");
    let plain = session_capture_config(
        &armed_config(),
        false,
        true,
        Some(horizontal),
        json!({"layoutPreset": "screen-camera"}),
    );
    assert_eq!(start_simulcast(&plain, Some(&talk)), None);
}

#[test]
fn a_live_edit_of_the_leg_is_built_like_the_start() {
    let talk = scene(
        json!({"layoutPreset": "vertical-camera-top"}),
        SceneShows::None,
    );
    let config = armed_config();
    let request = simulcast_leg_live_request_of(&config, Some(&talk)).expect("armed");
    let start = start_simulcast(&config, Some(&talk)).unwrap();
    assert_eq!(request["simulcastLeg"], true);
    assert_eq!(request["sources"], config["sources"]);
    assert_eq!(request["layout"], start["layout"]);
    assert_eq!(request["video"], start["video"]);
    assert!(request.get("background").is_none());
    assert_eq!(simulcast_leg_live_request_of(&config, None), None);
}
