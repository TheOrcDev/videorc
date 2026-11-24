//! `scene-presets.test.ts` and `scene-autosave.test.ts`, case for case
//! where the case reads the model this slice ports.

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::model::*;
use crate::studio::capture_config::default_layout;

fn device(id: &str, kind: DeviceKind) -> Device {
    Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: id.into(),
        name: id.into(),
        kind,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
    }
}

fn visual() -> Value {
    normalize_scene_visual(&json!({
        "layout": default_layout(),
        "sources": {"cameraId": "cam", "screenId": "screen", "microphoneId": "secret-mic", "streamKey": "secret"},
        "background": null
    }))
    .unwrap()
}

fn saved() -> Value {
    json!({"id": "first", "name": "First", "createdAt": "2026-09-22", "updatedAt": "2026-09-22", "visual": visual()})
}

fn with(mut value: Value, path: &[&str], field: Value) -> Value {
    let mut target = &mut value;
    for key in &path[..path.len() - 1] {
        target = target.get_mut(*key).expect("path");
    }
    target[path[path.len() - 1]] = field;
    value
}

#[test]
fn normalizes_hidden_visual_roles_through_saved_and_working_snapshots() {
    let hidden = normalize_scene_visual(&with(
        visual(),
        &["layout", "sourceVisibility"],
        json!({"camera": false, "capture": true}),
    ))
    .unwrap();
    assert_eq!(
        hidden["layout"]["sourceVisibility"],
        json!({"camera": false, "capture": true})
    );
    let entry = with(saved(), &["visual"], hidden.clone());
    let library = hydrate_scene_library(Some(&json!({"version": 1, "scenes": [entry]})));
    let checkpoint = hydrate_working_scene(Some(
        &json!({"version": 1, "sceneId": "first", "visual": hidden}),
    ))
    .unwrap();
    assert_eq!(
        library.scenes[0].visual["layout"]["sourceVisibility"],
        json!({"camera": false, "capture": true})
    );
    assert!(same_scene_visual(&hidden, &checkpoint.visual));
    assert!(!same_scene_visual(&hidden, &visual()));
    assert_eq!(hidden["sources"]["cameraId"], "cam");
    assert_eq!(hidden["sources"]["cameraOff"], false);
    assert_eq!(checkpoint.origin, Origin::Saved);
}

#[test]
fn copies_normalized_visual_fields_and_excludes_output_audio_and_secrets() {
    let mut layout = default_layout();
    layout["audio"] = json!({"microphoneId": "secret"});
    layout["streamKey"] = json!("secret");
    layout["sourceTransformOverrides"] =
        json!({"cam": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}});
    let snapshot = normalize_scene_visual(&json!({
        "layout": layout,
        "sources": {"cameraId": "cam", "microphoneId": "mic", "microphoneName": "Private"},
        "background": null
    }))
    .unwrap();
    let text = snapshot.to_string();
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains("microphone"), "{text}");
    assert_eq!(
        snapshot["layout"]["sourceTransformOverrides"]["cam"]["x"],
        0.1
    );
}

#[test]
fn retains_valid_entries_independently_and_protects_unknown_future_schemas() {
    let state = hydrate_scene_library(Some(&json!({
        "version": 1,
        "scenes": [saved(), with(with(saved(), &["id"], json!("bad")), &["visual"], Value::Null), saved()]
    })));
    assert_eq!(state.scenes.len(), 1);
    assert_eq!(state.error, Some(LIBRARY_INVALID_ERROR));
    let future = hydrate_scene_library(Some(&json!({"version": 2, "scenes": [saved()]})));
    assert!(future.read_only);
    assert_eq!(future.error, Some(LIBRARY_FUTURE_ERROR));
    let first: Vec<SavedScene> = state.scenes.clone();
    assert!(scene_name_error(" first ", &first, None).is_some());
    assert!(scene_name_error::<SavedScene>("    ", &[], None).is_some());
    assert!(scene_name_error::<SavedScene>(&"x".repeat(81), &[], None).is_some());
    assert_eq!(
        scene_name_error::<SavedScene>(&"x".repeat(80), &[], None),
        None
    );
    assert_eq!(hydrate_scene_library(None), HydratedLibrary::default());
}

#[test]
fn rejects_an_untrusted_camera_off_value() {
    for camera_off in [Value::Null, json!("true"), json!(1), json!({}), json!([])] {
        let raw = with(visual(), &["sources"], json!({"cameraOff": camera_off}));
        assert_eq!(
            normalize_scene_visual(&raw),
            Err("Invalid camera Off intent"),
            "{camera_off}"
        );
    }
}

#[test]
fn retains_explicit_off_and_a_screen_set_to_none() {
    let off =
        normalize_scene_visual(&with(visual(), &["sources"], json!({"cameraOff": true}))).unwrap();
    let entry = with(saved(), &["visual"], off.clone());
    let library = hydrate_scene_library(Some(&json!({"version": 1, "scenes": [entry]})));
    let checkpoint = hydrate_working_scene(Some(
        &json!({"version": 1, "sceneId": "first", "visual": off}),
    ))
    .unwrap();
    assert_eq!(library.scenes[0].visual["sources"]["cameraOff"], true);
    assert_eq!(checkpoint.visual["sources"]["cameraOff"], true);
    assert!(checkpoint.visual["sources"].get("cameraId").is_none());
    assert!(same_scene_visual(
        &library.scenes[0].visual,
        &checkpoint.visual
    ));

    let none =
        normalize_scene_visual(&with(visual(), &["sources"], json!({"captureOff": true}))).unwrap();
    assert_eq!(none["sources"]["captureOff"], true);
    assert_eq!(
        normalize_scene_visual(&with(visual(), &["sources"], json!({"captureOff": "yes"}))),
        Err("Invalid screen None intent")
    );
    let chosen = normalize_scene_visual(&with(
        visual(),
        &["sources"],
        json!({"screenId": "screen:1", "captureOff": true}),
    ))
    .unwrap();
    assert_eq!(chosen["sources"]["captureOff"], false);
    let contradictory = normalize_scene_visual(&with(
        visual(),
        &["sources"],
        json!({"cameraId": "cam", "cameraOff": true}),
    ))
    .unwrap();
    assert_eq!(contradictory["sources"]["cameraOff"], false);
}

#[test]
fn on_and_legacy_absent_flags_are_the_same_scene() {
    let on = visual();
    let mut absent = on.clone();
    absent["sources"]
        .as_object_mut()
        .unwrap()
        .remove("cameraOff");
    assert!(same_scene_visual(&on, &absent));
    let mut modified = on.clone();
    modified["layout"]["cameraZoom"] = json!(165);
    let checkpoint = hydrate_working_scene(Some(
        &json!({"version": 1, "sceneId": "first", "visual": modified}),
    ))
    .unwrap();
    assert_eq!(checkpoint.visual["layout"]["cameraZoom"], 165);
    assert!(!same_scene_visual(&on, &checkpoint.visual));
    // A visual without its background key is not a scene (the renderer's
    // `normalizeSavedBackground(undefined)` throws).
    let mut no_background = on.clone();
    no_background.as_object_mut().unwrap().remove("background");
    assert!(normalize_scene_visual(&no_background).is_err());
}

#[test]
fn checks_exact_available_source_ids_with_layout_aware_and_freeform_requirements() {
    let devices = vec![device("cam", DeviceKind::Camera)];
    let mut target = visual();
    target["layout"]["layoutPreset"] = json!("camera-only");
    assert!(scene_source_problems(&target, &devices).is_empty());
    target["layout"]["arrangementMode"] = json!("freeform");
    assert_eq!(scene_source_problems(&target, &devices).len(), 1);
    target["layout"]["layoutPreset"] = json!("screen-only");
    target["sources"]["testPattern"] = json!(true);
    target["sources"]
        .as_object_mut()
        .unwrap()
        .remove("screenId");
    assert_eq!(scene_source_problems(&target, &[]).len(), 1);
    target["layout"]["arrangementMode"] = json!("preset");
    target["sources"]["windowId"] = json!("closed-window");
    assert_eq!(scene_source_problems(&target, &devices).len(), 1);
    target["sources"]
        .as_object_mut()
        .unwrap()
        .remove("windowId");
    target["sources"]["screenId"] = json!("missing-screen");
    assert_eq!(scene_source_problems(&target, &devices).len(), 1);
    let missing = normalize_scene_visual(&json!({
        "layout": with(default_layout(), &["layoutPreset"], json!("camera-only")),
        "sources": {"cameraId": "missing", "cameraOff": true},
        "background": null
    }))
    .unwrap();
    assert_eq!(
        scene_source_problems(&missing, &devices),
        vec![CAMERA_GONE_PROBLEM]
    );
}

#[test]
fn the_gallery_reason_tells_a_camera_turned_off_from_one_that_is_gone() {
    let off = SourceGap {
        source: GapSource::Camera,
        state: GapState::Off,
    };
    let gone = SourceGap {
        source: GapSource::Camera,
        state: GapState::Unavailable,
    };
    let screen = SourceGap {
        source: GapSource::Screen,
        state: GapState::Unavailable,
    };
    assert_eq!(
        scene_gallery_reason(&[("Screen + camera", vec![off]), ("Camera only", vec![off])]),
        Some("Camera is off. Choose one in Sources to use Screen + camera and Camera only.".into())
    );
    assert_eq!(
        scene_gallery_reason(&[
            ("Screen + camera", vec![gone, screen]),
            ("Screen only", vec![screen]),
            ("Camera only", vec![gone]),
            ("Side by side", vec![gone, screen]),
        ]),
        Some(
            "Your camera isn't available. Choose another in Sources to use Screen + camera, Camera only, and Side by side. Your screen isn't available. Choose another in Sources to use Screen + camera, Screen only, and Side by side."
                .into()
        )
    );
    assert_eq!(scene_gallery_reason(&[("Screen only", vec![])]), None);
}

#[test]
fn saved_scenes_keep_the_microphone_and_system_audio() {
    let audio = scene_audio(
        &json!({"microphoneId": "mic", "microphoneName": "USB"}),
        true,
    );
    let entry = with(saved(), &["audio"], json!(audio));
    let library = hydrate_scene_library(Some(&json!({"version": 1, "scenes": [entry]})));
    assert_eq!(library.scenes[0].audio.as_ref(), Some(&audio));
    let legacy = hydrate_scene_library(Some(&json!({"version": 1, "scenes": [saved()]})));
    assert_eq!(legacy.scenes[0].audio, None);
    assert!(same_scene_audio(None, &audio));
    let other = SceneAudio {
        system_audio_enabled: false,
        ..audio.clone()
    };
    assert!(!same_scene_audio(Some(&audio), &other));
    let mics = vec![device("mic", DeviceKind::Microphone)];
    assert_eq!(
        scene_microphone(&audio, &mics)
            .unwrap()
            .microphone_id
            .as_deref(),
        Some("mic")
    );
    assert_eq!(scene_microphone(&audio, &[]), None);
    let none = SceneAudio {
        microphone_id: None,
        microphone_name: None,
        microphone_off: true,
        system_audio_enabled: false,
    };
    assert!(scene_microphone(&none, &[]).unwrap().microphone_off);
    assert!(
        hydrate_scene_library(Some(
            &json!({"version": 1, "scenes": [with(saved(), &["audio"], json!({"microphoneId": ""}))]})
        ))
        .scenes
        .is_empty()
    );
}

#[test]
fn a_saved_scene_finds_its_display_by_uuid_first() {
    let mut display = device("screen:2", DeviceKind::Screen);
    display.name = "Studio Display".into();
    display.display_uuid = Some("UUID-A".into());
    let mut other = device("screen:1", DeviceKind::Screen);
    other.display_uuid = Some("UUID-B".into());
    let devices = vec![other.clone(), display.clone()];
    let sources =
        json!({"screenId": "screen:1", "screenName": "Studio Display", "screenUuid": "UUID-A"});
    assert_eq!(
        scene_display(&sources, &devices).map(|d| d.id.as_str()),
        Some("screen:2")
    );
    let visual = json!({"layout": default_layout(), "sources": sources, "background": null});
    let moved = with_scene_display(&visual, &devices);
    assert_eq!(moved["sources"]["screenId"], "screen:2");
    assert_eq!(
        scene_display_refresh(&visual["sources"], &devices),
        Some((
            "screen:2".into(),
            "Studio Display".into(),
            Some("UUID-A".into())
        ))
    );
    // A name or a new id under the same UUID is not a modified scene.
    assert!(same_scene_visual(
        &normalize_scene_visual(&visual).unwrap(),
        &normalize_scene_visual(&moved).unwrap()
    ));
    // Another UUID is another display, whatever its id.
    let elsewhere = with(visual.clone(), &["sources", "screenUuid"], json!("UUID-C"));
    assert!(!same_scene_visual(
        &normalize_scene_visual(&visual).unwrap(),
        &normalize_scene_visual(&elsewhere).unwrap()
    ));
    // A UUID without its display is dropped, never the scene.
    let orphan = normalize_scene_visual(&json!({"layout": default_layout(), "sources": {"screenUuid": "UUID-A"}, "background": null})).unwrap();
    assert!(orphan["sources"].get("screenUuid").is_none());
}

/// `scene-autosave.test.ts`'s `mergeVisualSources` case (`sceneAutosave`
/// went with plan 231; the merge stays).
#[test]
fn a_scenes_unset_visual_sources_clear_the_current_ones() {
    let current = json!({"cameraId": "cam", "cameraName": "FaceTime", "screenId": "screen:1", "microphoneId": "mic"});
    let off = normalize_scene_visual(&with(
        visual(),
        &["sources"],
        json!({"cameraOff": true, "testPattern": true}),
    ))
    .unwrap();
    let merged = merge_visual_sources(&current, &off["sources"]);
    assert!(merged.get("cameraId").is_none());
    assert!(merged.get("cameraName").is_none());
    assert!(merged.get("screenId").is_none());
    assert_eq!(merged["cameraOff"], true);
    assert_eq!(merged["testPattern"], true);
    assert_eq!(merged["microphoneId"], "mic", "not a visual source");
    assert!(merged.get("app").is_none());
}
