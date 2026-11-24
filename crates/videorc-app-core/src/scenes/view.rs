//! Plan 231 S2 (`lib/scene-studio.ts`): the Studio runs on scenes. Its
//! apply, preflight, swap in place and follow paths read a scene as a visual
//! snapshot (plan 210's saved-scene shape): the scene's layout for the
//! studio's orientation, the screen it shows, and the one camera every
//! scene shares (D9). These are the two directions between that shape and
//! a stored scene, and the D18/D19 rules for a scene that draws no screen.

use serde_json::{Map, Value, json};
use videorc_protocol::Device;

use super::model::{SavedScene, scene_display_refresh, using_visual_sources};
use super::v2::{
    Orientation, Scene, SceneShows, first_scene_with_layout, layout_preset, layout_shows_screen,
    same_shows, shows_from_sources, shows_sources,
};
use crate::studio::js_value::truthy;

/// `CAPTURE_KEYS`: the screen part of a snapshot's sources.
pub const CAPTURE_KEYS: [&str; 7] = [
    "screenId",
    "screenName",
    "screenUuid",
    "windowId",
    "windowName",
    "captureOff",
    "testPattern",
];
/// `CAMERA_KEYS`: the camera every scene shares.
pub const CAMERA_KEYS: [&str; 3] = ["cameraId", "cameraName", "cameraOff"];

fn pick(sources: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| Some(((*key).to_string(), sources.get(*key)?.clone())))
        .collect()
}

/// `captureSources`: the screen part of a snapshot's sources. Every key is
/// meant: apply it with [`apply_capture_sources`] so the previous screen
/// clears.
pub fn capture_sources(sources: &Value) -> Map<String, Value> {
    pick(sources, &CAPTURE_KEYS)
}

/// `{...sources, ...captureSources(from)}`: every capture key is written,
/// an absent one removed.
pub fn apply_capture_sources(sources: &mut Map<String, Value>, from: &Value) {
    for key in CAPTURE_KEYS {
        match from.get(key) {
            Some(value) => sources.insert(key.into(), value.clone()),
            None => sources.remove(key),
        };
    }
}

/// `cameraSources`: the camera part of a snapshot's sources.
pub fn camera_sources(sources: &Value) -> Map<String, Value> {
    pick(sources, &CAMERA_KEYS)
}

/// `savedSceneView`: a scene as the Studio applies and lists it, in one
/// orientation, with the shared camera.
pub fn saved_scene_view(scene: &Scene, orientation: Orientation, camera: &Value) -> SavedScene {
    let mut sources = camera_sources(camera);
    shows_sources(&scene.shows).apply_to(&mut sources);
    SavedScene {
        id: scene.id.clone(),
        name: scene.name.clone(),
        created_at: scene.created_at.clone(),
        updated_at: scene.updated_at.clone(),
        visual: json!({
            "layout": scene.layout(orientation),
            "sources": using_visual_sources(&Value::Object(sources)),
            "background": scene.background,
        }),
        audio: scene.audio.clone(),
        cloud: scene.cloud.clone(),
    }
}

/// `sceneFromSaved`: the stored scene for a snapshot: its screen, its
/// layout in the snapshot's orientation, its background and audio. The
/// other orientation's layout comes from `template` (the scene itself on an
/// edit, its original on a duplicate, the scene on stream for a new one,
/// D6). The snapshot's camera is dropped (D9).
pub fn scene_from_saved(saved: &SavedScene, template: &Scene) -> Scene {
    let layout = saved.visual.get("layout").cloned().unwrap_or(Value::Null);
    let mut scene = Scene {
        id: saved.id.clone(),
        name: saved.name.clone(),
        created_at: saved.created_at.clone(),
        updated_at: saved.updated_at.clone(),
        shows: shows_from_sources(saved.visual.get("sources").unwrap_or(&Value::Null)),
        horizontal: template.horizontal.clone(),
        vertical: template.vertical.clone(),
        background: saved
            .visual
            .get("background")
            .cloned()
            .unwrap_or(Value::Null),
        audio: saved.audio.clone(),
        cloud: saved.cloud.clone(),
    };
    scene.set_layout(Orientation::of_layout(&layout), layout);
    scene
}

/// `sceneOnStreamAtLaunch`: the scene the library names, while the look that
/// launched has its layout; a look with another layout is on the first
/// scene with that layout instead.
pub fn scene_on_stream_at_launch(scenes: &[Scene], on_stream_id: &str, layout: &Value) -> String {
    let orientation = Orientation::of_layout(layout);
    let preset = layout_preset(layout);
    let named = scenes.iter().find(|scene| scene.id == on_stream_id);
    if named.is_some_and(|scene| layout_preset(scene.layout(orientation)) == preset) {
        return on_stream_id.to_string();
    }
    first_scene_with_layout(scenes, orientation, preset)
        .map(|scene| scene.id.clone())
        .unwrap_or_else(|| on_stream_id.to_string())
}

/// `sceneLegLayouts` (D4): the program's layout, plus the scene's 9:16
/// layout on the vertical stream while one is armed or live beside a 16:9
/// studio.
pub fn scene_leg_layouts<'a>(
    scene: &'a Scene,
    program: &'a Value,
    vertical_leg: bool,
) -> Vec<&'a Value> {
    if vertical_leg && Orientation::of_layout(program) == Orientation::Horizontal {
        vec![program, &scene.vertical]
    } else {
        vec![program]
    }
}

/// `sceneDrawsScreen` (D4, D18): a leg that is on draws a screen for it.
pub fn scene_draws_screen(scene: &Scene, program: &Value, vertical_leg: bool) -> bool {
    scene_leg_layouts(scene, program, vertical_leg)
        .into_iter()
        .any(layout_shows_screen)
}

/// `sceneKeepsCapture` (D18): no leg draws a screen for the scene, so the
/// running capture keeps running.
pub fn scene_keeps_capture(scene: Option<&Scene>, program: &Value, vertical_leg: bool) -> bool {
    scene.is_some_and(|scene| !scene_draws_screen(scene, program, vertical_leg))
}

/// `sceneCaptureIsBorrowed` (D18): the capture now is one an earlier scene
/// left, not the one this scene shows. A scene that shows none has no screen
/// of its own: Change screen… decides (D19).
pub fn scene_capture_is_borrowed(scene: &Scene, working: &SceneShows) -> bool {
    scene.shows != SceneShows::None && !same_shows(&scene.shows, working)
}

/// `verticalLegBorrowsScreen` (D18): the vertical leg would show a capture
/// the scene doesn't own.
pub fn vertical_leg_borrows_screen(
    scene: &Scene,
    program: &Value,
    vertical_leg: bool,
    working: &SceneShows,
) -> bool {
    vertical_leg
        && Orientation::of_layout(program) == Orientation::Horizontal
        && !layout_shows_screen(program)
        && layout_shows_screen(&scene.vertical)
        && scene_capture_is_borrowed(scene, working)
}

/// `sameCaptureTarget` (D18): two selections capture the same thing.
pub fn same_capture_target(a: &Value, b: &Value) -> bool {
    let text =
        |sources: &Value, key: &str| sources.get(key).filter(|value| !value.is_null()).cloned();
    text(a, "windowId") == text(b, "windowId")
        && text(a, "screenId") == text(b, "screenId")
        && truthy(a.get("testPattern")) == truthy(b.get("testPattern"))
}

/// `noScreenLayoutReason` (D19).
pub fn no_screen_layout_reason(scene_name: &str) -> String {
    format!("“{scene_name}” shows no screen. Choose one with Change screen… first.")
}

/// `sceneWithShows` (D2): a Screen pick's scene, or none when it shows the
/// screen already.
pub fn scene_with_shows(scene: &Scene, shows: SceneShows, now: &str) -> Option<Scene> {
    (scene.shows != shows).then(|| Scene {
        shows,
        updated_at: now.to_string(),
        ..scene.clone()
    })
}

/// `sceneDisplayRefreshed` (plan 213 F1): a scene's display as it is listed
/// now, or none when nothing changed. Not an edit: `updatedAt` stays.
pub fn scene_display_refreshed(scene: &Scene, devices: &[Device]) -> Option<Scene> {
    if !matches!(scene.shows, SceneShows::Display { .. }) {
        return None;
    }
    let (id, name, uuid) = scene_display_refresh(&shows_sources(&scene.shows).to_json(), devices)?;
    let mut display = Map::new();
    display.insert("screenId".into(), json!(id));
    display.insert("screenName".into(), json!(name));
    if let Some(uuid) = uuid {
        display.insert("screenUuid".into(), json!(uuid));
    }
    Some(Scene {
        shows: shows_from_sources(&Value::Object(display)),
        ..scene.clone()
    })
}
