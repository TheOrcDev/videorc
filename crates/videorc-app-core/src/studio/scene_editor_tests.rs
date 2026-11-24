//! videorc-rust's editor action tests (`freeform-memory.test.ts`, the
//! committed boxes, the visibility), with the plan 231 undo slot and the
//! banner refusals.

use serde_json::{Value, json};
use videorc_protocol::Scene;

use super::*;

fn scene(sources: Value) -> Scene {
    serde_json::from_value(json!({
        "id": "scene", "name": "Scene", "outputs": [], "sources": sources,
    }))
    .unwrap()
}

fn source(id: &str, kind: &str, x: f64, crop_left: f64) -> Value {
    let transform = json!({"x": x, "y": 0.1, "width": 0.3, "height": 0.3, "cropLeft": crop_left});
    json!({"id": id, "name": id, "kind": kind, "transform": transform, "defaultTransform": transform})
}

/// `syncSourceTransformsToLayout`'s two arms.
#[test]
fn a_committed_scene_writes_back_freeforms_boxes_or_the_cameras() {
    let scene = scene(json!([
        source("source:screen", "screen", 0.2, 0.1),
        source("source:camera", "camera", 0.6, 0.0),
    ]));
    let freeform = layout_patch_for(
        &json!({"arrangementMode": "freeform"}),
        &scene,
        Some("source:screen"),
    )
    .unwrap();
    assert_eq!(
        freeform["sourceTransformOverrides"]["source:screen"],
        json!({"x": 0.2, "y": 0.1, "width": 0.3, "height": 0.3, "cropLeft": 0.1})
    );
    assert_eq!(
        freeform["sourceTransformOverrides"]["source:camera"],
        json!({"x": 0.6, "y": 0.1, "width": 0.3, "height": 0.3})
    );
    let preset = layout_patch_for(
        &json!({"arrangementMode": "preset"}),
        &scene,
        Some("source:camera"),
    )
    .unwrap();
    assert_eq!(preset["cameraTransformMode"], json!("custom"));
    assert_eq!(preset["cameraTransform"]["x"], json!(0.6));
    assert!(layout_patch_for(&json!({}), &scene, Some("source:screen")).is_none());
}

/// S3.3x.2 (`freeform-memory.test.ts`): a Freeform layout is remembered
/// by its orientation; a preset, or a Freeform with no overrides, is not.
#[test]
fn freeform_is_remembered_by_orientation_and_a_preset_changes_nothing() {
    let mut memory = FreeformMemory::new();
    let boxes = json!({"source:screen": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5}});
    remember_freeform(
        &mut memory,
        &json!({"layoutPreset": "screen-camera", "arrangementMode": "preset", "sourceTransformOverrides": boxes}),
    );
    assert!(memory.is_empty());
    remember_freeform(
        &mut memory,
        &json!({"layoutPreset": "screen-camera", "arrangementMode": "freeform", "sourceTransformOverrides": {}}),
    );
    assert!(memory.is_empty());
    remember_freeform(
        &mut memory,
        &json!({"layoutPreset": "screen-camera", "arrangementMode": "freeform", "sourceTransformOverrides": boxes}),
    );
    remember_freeform(
        &mut memory,
        &json!({"layoutPreset": "vertical-split", "arrangementMode": "freeform", "sourceTransformOverrides": {"source:camera": {"x": 0.0, "y": 0.5, "width": 1.0, "height": 0.5}}}),
    );
    assert_eq!(Value::Object(memory["horizontal"].clone()), boxes);
    assert_eq!(
        memory["vertical"]["source:camera"],
        json!({"x": 0.0, "y": 0.5, "width": 1.0, "height": 0.5})
    );
    assert_eq!(
        layout_orientation(&json!({"layoutPreset": "vertical-camera-top"})),
        "vertical"
    );
    assert_eq!(layout_orientation(&json!({})), "horizontal");
}

/// `freeformEntryOverrides`: the remembered box of each source the scene
/// still has, the seed for the rest; a remembered source the scene lost
/// is left out.
#[test]
fn freeform_starts_from_the_memory_and_seeds_the_rest() {
    let scene = scene(json!([
        source("source:screen", "screen", 0.2, 0.0),
        source("source:camera", "camera", 0.6, 0.0),
    ]));
    let mut memory = FreeformMemory::new();
    remember_freeform(
        &mut memory,
        &json!({"layoutPreset": "screen-camera", "arrangementMode": "freeform", "sourceTransformOverrides": {
            "source:screen": {"x": 0.05, "y": 0.05, "width": 0.6, "height": 0.6, "cropLeft": 0.1},
            "source:gone": {"x": 0.5, "y": 0.5, "width": 0.1, "height": 0.1},
        }}),
    );
    let overrides =
        freeform_entry_overrides(&memory, "horizontal", &scene.sources, source_override);
    assert_eq!(overrides.len(), 2);
    assert_eq!(
        overrides["source:screen"],
        json!({"x": 0.05, "y": 0.05, "width": 0.6, "height": 0.6, "cropLeft": 0.1})
    );
    assert_eq!(
        overrides["source:camera"],
        json!({"x": 0.6, "y": 0.1, "width": 0.3, "height": 0.3})
    );
    // The other orientation has no memory: every source is seeded.
    let vertical = freeform_entry_overrides(&memory, "vertical", &scene.sources, source_override);
    assert_eq!(vertical["source:screen"]["x"], json!(0.2));
}

#[test]
fn the_layouts_intent_leaves_out_the_committed_boxes() {
    let layout = json!({"layoutPreset": "screen-camera", "sourceTransformOverrides": {"a": 1}, "cameraTransform": null, "cameraTransformMode": "custom"});
    assert_eq!(
        transform_layout_intent(&layout),
        json!({"layoutPreset": "screen-camera"})
    );
}

fn the_layouts_visibility_follows_the_committed_scene() {
    let scene: Scene = serde_json::from_value(json!({
        "id": "scene", "name": "Scene", "outputs": [],
        "sources": [
            {"id": "source:camera", "name": "Camera", "kind": "camera", "visible": false,
             "transform": {"x": 0, "y": 0, "width": 0.2, "height": 0.2},
             "defaultTransform": {"x": 0, "y": 0, "width": 0.2, "height": 0.2}},
        ],
    }))
    .unwrap();
    assert_eq!(
        source_visibility_from_scene(&scene, Some(&json!({"capture": false}))),
        json!({"camera": false, "capture": false})
    );
}

fn entry(preset: &str, saved: Option<&str>) -> LayoutUndoEntry {
    LayoutUndoEntry {
        layout: json!({"layoutPreset": preset}),
        saved_id: saved.map(str::to_string),
        origin: Origin::Saved,
    }
}

/// `layoutUndoAfterCommit`: a commit that changes the layout takes the
/// layout it replaced; one that leaves it as it was keeps the slot.
#[test]
fn the_undo_slot_holds_the_layout_a_change_replaced() {
    let slot = Some(entry("screen-only", Some("a")));
    assert_eq!(
        layout_undo_after_commit(
            slot.clone(),
            Some(entry("screen-camera", Some("b"))),
            &json!({"layoutPreset": "camera-only"})
        ),
        Some(entry("screen-camera", Some("b")))
    );
    // A background edit commits the same layout: the slot stays.
    assert_eq!(
        layout_undo_after_commit(
            slot.clone(),
            Some(entry("screen-camera", Some("b"))),
            &json!({"layoutPreset": "screen-camera"})
        ),
        slot
    );
    assert_eq!(
        layout_undo_after_commit(None, None, &json!({"layoutPreset": "camera-only"})),
        None
    );
}

#[test]
fn a_banner_refusal_is_said_as_it_is() {
    assert_eq!(
        banner_refusal("banners.show failed: Four banners are showing. Hide one first."),
        Some("Four banners are showing. Hide one first.")
    );
    assert_eq!(
        banner_refusal("HTML banners can't join this recording. Hide it, or record at 30 fps."),
        Some("HTML banners can't join this recording. Hide it, or record at 30 fps.")
    );
    assert_eq!(banner_refusal("connection reset"), None);
}
