//! Plan 231: reading and checking the stored scene library
//! (`lib/scenes-store.ts`): the v2 reader, the main display a new user's
//! scenes wait for, the delete rule (D16), the layout twins, the #1706
//! repair of 0.34.0–0.37.0 libraries, and the autosave of an edit made
//! while a scene is on stream (D11).

use serde_json::{Map, Value, json};

use super::model::{
    NamedScene, hydrate_working_scene, normalize_saved_scene_cloud, normalize_scene_app,
    normalize_scene_audio, normalize_scene_visual, scene_name_error,
};
use super::v2::{
    DELETE_ON_STREAM_REASON, GOING_ON_STREAM_REASON, KEEP_ONE_SCENE_REASON, MainDisplay,
    Orientation, Scene, SceneLibrary, SceneShows, layout_is_freeform, layout_preset,
    preset_needs_camera, preset_needs_screen, same_shows, shows_from_sources,
};
use crate::studio::capture_config::{DEFAULT_LAST_VERTICAL_PRESET, HORIZONTAL_LAYOUT_PRESETS};
use crate::studio::js_value::{canonical_eq, get, string};

/// `SCENES_UNKNOWN_VERSION_ERROR`.
pub const SCENES_UNKNOWN_VERSION_ERROR: &str =
    "Update Videorc to open these scenes. Your saved data is preserved.";
/// `hydrateScenes`' error when an entry was dropped.
pub const SCENES_INVALID_ERROR: &str = "Some invalid scenes couldn't be loaded.";

/// Why a stored scene was rejected whole.
pub type Invalid = &'static str;

/// `normalizeShows`.
fn normalize_shows(raw: Option<&Value>) -> Result<SceneShows, Invalid> {
    let Some(data @ Value::Object(_)) = raw else {
        return Err("Invalid scene screen");
    };
    // An optional label: absent, or a string ("" reads as absent).
    let optional = |key: &str| -> Result<Option<String>, Invalid> {
        match data.get(key) {
            None => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone()).filter(|text| !text.is_empty())),
            Some(_) => Err("Invalid screen label"),
        }
    };
    match string(data.get("kind")) {
        Some("app") => {
            let app = normalize_scene_app(Some(data)).ok_or("Invalid scene app")?;
            Ok(SceneShows::App {
                bundle_id: string(app.get("bundleId")).unwrap_or_default().to_string(),
                name: string(app.get("name")).unwrap_or_default().to_string(),
                follows: app.get("follows") == Some(&Value::Bool(true)),
            })
        }
        Some("window") => {
            let window_id = string(data.get("windowId"))
                .filter(|id| !id.is_empty())
                .ok_or("Invalid window")?;
            Ok(SceneShows::Window {
                window_id: window_id.to_string(),
                window_name: optional("windowName")?,
            })
        }
        Some("display") => {
            let screen_id = string(data.get("screenId")).ok_or("Invalid display")?;
            let screen_name = optional("screenName")?;
            let screen_uuid = optional("screenUuid")?;
            Ok(SceneShows::Display {
                screen_id: screen_id.to_string(),
                // As in v1: a UUID left over without its display is no pick.
                screen_uuid: screen_uuid.filter(|_| !screen_id.is_empty() || screen_name.is_some()),
                screen_name,
            })
        }
        Some("none") => Ok(SceneShows::None),
        Some("test-pattern") => Ok(SceneShows::TestPattern),
        _ => Err("Unknown scene screen"),
    }
}

/// `normalizeScene`: one stored scene, or why not. A scene with a broken
/// screen, a layout that is not a built-in one, or a layout in the wrong
/// orientation is rejected whole; invalid optional fields are dropped,
/// never the scene.
pub fn normalize_scene(raw: &Value) -> Result<Scene, Invalid> {
    if !raw.is_object() {
        return Err("Invalid scene");
    }
    let field = |key: &str| raw.get(key);
    let (Some(id), Some(name), Some(created_at), Some(updated_at)) = (
        string(field("id")).filter(|id| !id.is_empty() && id.encode_utf16().count() <= 128),
        string(field("name")),
        string(field("createdAt")),
        string(field("updatedAt")),
    ) else {
        return Err("Invalid scene");
    };
    if scene_name_error::<Scene>(name, &[], None).is_some() {
        return Err("Invalid scene");
    }
    let Some(layouts @ Value::Object(_)) = field("layouts") else {
        return Err("Invalid scene");
    };
    let background = field("background").cloned().unwrap_or(Value::Null);
    // The v1 visual check is the layout and background check: one rule for
    // both.
    let visual = |orientation: Orientation| -> Result<Value, Invalid> {
        let layout = layouts
            .get(orientation.as_str())
            .cloned()
            .unwrap_or(Value::Null);
        let normalized = normalize_scene_visual(
            &json!({"layout": layout, "sources": {}, "background": background}),
        )?;
        if Orientation::of_layout(&normalized["layout"]) != orientation {
            return Err("Layout in the wrong orientation");
        }
        Ok(normalized)
    };
    let horizontal = visual(Orientation::Horizontal)?;
    let vertical = visual(Orientation::Vertical)?;
    // A broken audio rejects the scene (`normalizeSceneAudio` throws).
    let audio = normalize_scene_audio(field("audio"))?;
    Ok(Scene {
        id: id.to_string(),
        name: name.trim().to_string(),
        created_at: created_at.to_string(),
        updated_at: updated_at.to_string(),
        shows: normalize_shows(field("shows"))?,
        horizontal: horizontal["layout"].clone(),
        vertical: vertical["layout"].clone(),
        background: horizontal["background"].clone(),
        audio,
        cloud: normalize_saved_scene_cloud(field("cloud")),
    })
}

/// `hydrateScenes`' answer.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HydratedScenes {
    /// None when nothing is stored (migrate from v1), when the version is
    /// one this build doesn't know (read-only), or when no stored scene is
    /// usable.
    pub library: Option<SceneLibrary>,
    /// A library from a newer Videorc: the stored data must not be written
    /// over.
    pub read_only: bool,
    pub error: Option<&'static str>,
}

/// `hydrateScenes`: the stored v2 library.
pub fn hydrate_scenes(raw: Option<&Value>) -> HydratedScenes {
    let Some(raw) = raw.filter(|raw| !raw.is_null()) else {
        return HydratedScenes::default();
    };
    if raw.get("version").and_then(Value::as_f64) != Some(2.0) {
        return HydratedScenes {
            library: None,
            read_only: true,
            error: Some(SCENES_UNKNOWN_VERSION_ERROR),
        };
    }
    let entries: &[Value] = match raw.get("scenes") {
        Some(Value::Array(entries)) => entries,
        _ => &[],
    };
    let mut scenes: Vec<Scene> = Vec::new();
    for entry in entries {
        // Reject only the malformed entry.
        let Ok(scene) = normalize_scene(entry) else {
            continue;
        };
        if scenes.iter().any(|other| other.id == scene.id)
            || scene_name_error(&scene.name, &scenes, None).is_some()
        {
            continue;
        }
        scenes.push(scene);
    }
    let error = (scenes.len() != entries.len()).then_some(SCENES_INVALID_ERROR);
    if scenes.is_empty() {
        return HydratedScenes {
            library: None,
            read_only: false,
            error,
        };
    }
    let stored_on = string(raw.get("onStreamId"));
    // A scene is always on stream: a lost id falls to the first scene.
    let on_stream_id = stored_on
        .filter(|id| scenes.iter().any(|scene| scene.id == *id))
        .unwrap_or(&scenes[0].id)
        .to_string();
    let pending_shortcuts = raw
        .get("pendingShortcuts")
        .filter(|pending| pending.is_object());
    HydratedScenes {
        library: Some(SceneLibrary {
            on_stream_id,
            scenes,
            pending_shortcuts: pending_shortcuts.cloned(),
            vertical_layouts_repaired: raw.get("verticalLayoutsRepaired")
                == Some(&Value::Bool(true)),
        }),
        read_only: false,
        error,
    }
}

/// `withMainDisplay`: the main display written into every scene that shows
/// it without knowing which it is; none when there is nothing to write
/// (not an edit: `updatedAt` stays).
pub fn with_main_display(library: &SceneLibrary, main: &MainDisplay) -> Option<SceneLibrary> {
    let waits = |scene: &Scene| matches!(&scene.shows, SceneShows::Display { screen_id, screen_name: None, .. } if screen_id.is_empty());
    if main.id.is_empty() || !library.scenes.iter().any(waits) {
        return None;
    }
    let mut next = library.clone();
    for scene in &mut next.scenes {
        if waits(scene) {
            scene.shows = display_shows(Some(main));
        }
    }
    Some(next)
}

/// `canDeleteScene`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteRule {
    /// Off air, deleting the scene on stream first switches to `switch_to`.
    Allowed { switch_to: Option<String> },
    /// The reason to say; none for a scene the library doesn't have.
    Refused(Option<&'static str>),
}

/// `canDeleteScene` (D16): the last scene never can be deleted, nor a scene
/// a switch is putting on stream (`going_on`). Off air, deleting the scene
/// on stream first switches to the scene before it (the one after, for the
/// first scene); while recording or live, it can't be deleted.
pub fn can_delete_scene<S: NamedScene>(
    scenes: &[S],
    id: &str,
    on_stream_id: &str,
    session_active: bool,
    going_on: bool,
) -> DeleteRule {
    let Some(index) = scenes.iter().position(|scene| scene.scene_id() == id) else {
        return DeleteRule::Refused(None);
    };
    if scenes.len() <= 1 {
        return DeleteRule::Refused(Some(KEEP_ONE_SCENE_REASON));
    }
    if going_on {
        return DeleteRule::Refused(Some(GOING_ON_STREAM_REASON));
    }
    if id != on_stream_id {
        return DeleteRule::Allowed { switch_to: None };
    }
    if session_active {
        return DeleteRule::Refused(Some(DELETE_ON_STREAM_REASON));
    }
    let next = if index > 0 { index - 1 } else { 1 };
    DeleteRule::Allowed {
        switch_to: Some(scenes[next].scene_id().to_string()),
    }
}

/// `displayShows`: a display as a scene shows it; the main display not
/// named yet when there is none.
pub fn display_shows(display: Option<&MainDisplay>) -> SceneShows {
    let id = display
        .map(|display| display.id.clone())
        .unwrap_or_default();
    SceneShows::Display {
        screen_uuid: display
            .and_then(|display| display.display_uuid.clone())
            .filter(|uuid| !uuid.is_empty() && !id.is_empty()),
        screen_name: display
            .map(|display| display.name.clone())
            .filter(|name| !name.is_empty()),
        screen_id: id,
    }
}

/// `defaultSceneId`: the ids the migration gives the four default scenes,
/// stable so a second run names the same scenes.
pub fn default_scene_id(preset: &str) -> String {
    format!("default-{preset}")
}

/// `presetsShowSameSources`: a screen or not, a camera or not.
pub fn presets_show_same_sources(a: &str, b: &str) -> bool {
    preset_needs_screen(a) == preset_needs_screen(b)
        && preset_needs_camera(a) == preset_needs_camera(b)
}

/// `verticalTwinPreset`: Camera only and Screen only their own, a screen
/// with a camera the 9:16 layout a new user starts on, Camera top.
pub fn vertical_twin_preset(preset: &str) -> &str {
    if Orientation::of_preset(preset) == Orientation::Vertical {
        return preset;
    }
    match preset {
        "camera-only" => "vertical-camera-only",
        "screen-only" => "vertical-screen-only",
        _ => DEFAULT_LAST_VERTICAL_PRESET,
    }
}

/// `layout` as the plain built-in `preset`: preset arrangement, no camera
/// transform, no source overrides; its look and framing kept.
pub(crate) fn on_preset(layout: &Value, preset: &str) -> Value {
    let mut next = layout.as_object().cloned().unwrap_or_default();
    next.insert("layoutPreset".into(), json!(preset));
    next.insert("cameraTransformMode".into(), json!("preset"));
    next.insert("cameraTransform".into(), Value::Null);
    next.insert("arrangementMode".into(), json!("preset"));
    next.insert("sourceTransformOverrides".into(), json!({}));
    Value::Object(next)
}

/// `repairStoredSceneVerticals`' answer: what to store.
#[derive(Debug, Clone, PartialEq)]
pub struct VerticalRepair {
    /// The stored library with the repaired scenes and the mark.
    pub library: Value,
    /// The working setup moved with its scene, when a 9:16 studio shows it
    /// exactly as stored; none to leave it.
    pub working: Option<Value>,
    pub repaired: Vec<String>,
}

/// `repairStoredSceneVerticals` (#1706, owner report 2026-11-23): once per
/// library (`verticalLayoutsRepaired`), each default scene the migration
/// made (its id, its own 16:9 layout, neither in Freeform) whose 9:16 layout
/// shows other sources than its 16:9 one is put on its 9:16 twin, keeping
/// its look and framing. Nothing else is touched: invalid entries a
/// hydrate would drop stay as stored. Takes and answers the stored JSON;
/// none when there is nothing to write.
pub fn repair_stored_scene_verticals(
    raw_library: &Value,
    raw_working: Option<&Value>,
) -> Option<VerticalRepair> {
    let library = hydrate_scenes(Some(raw_library)).library?;
    if library.vertical_layouts_repaired {
        return None;
    }
    let mut repaired: Vec<Scene> = Vec::new();
    let mut before: Vec<(String, Value)> = Vec::new();
    for preset in HORIZONTAL_LAYOUT_PRESETS {
        let id = default_scene_id(preset);
        let Some(scene) = library.scenes.iter().find(|scene| scene.id == id) else {
            continue;
        };
        if layout_preset(&scene.horizontal) != preset
            || layout_is_freeform(&scene.horizontal)
            || layout_is_freeform(&scene.vertical)
            || presets_show_same_sources(preset, layout_preset(&scene.vertical))
        {
            continue;
        }
        before.push((scene.id.clone(), scene.vertical.clone()));
        let mut next = scene.clone();
        next.vertical = on_preset(&scene.vertical, vertical_twin_preset(preset));
        repaired.push(next);
    }
    let find = |id: &str| repaired.iter().find(|scene| scene.id == id);
    let mut next_library: Map<String, Value> = raw_library.as_object().cloned().unwrap_or_default();
    let entries = match raw_library.get("scenes") {
        Some(Value::Array(entries)) => entries.clone(),
        _ => Vec::new(),
    };
    next_library.insert(
        "scenes".into(),
        Value::Array(
            entries
                .into_iter()
                .map(|entry| match string(entry.get("id")).and_then(find) {
                    Some(scene) => scene.to_json(),
                    None => entry,
                })
                .collect(),
        ),
    );
    next_library.insert("verticalLayoutsRepaired".into(), json!(true));

    let working = hydrate_working_scene(raw_working);
    let moved = working.as_ref().and_then(|working| {
        let id = working.scene_id.as_deref()?;
        let scene = find(id)?;
        let (_, was) = before.iter().find(|(before_id, _)| before_id == id)?;
        let layout = &working.visual["layout"];
        (Orientation::of_layout(layout) == Orientation::Vertical && canonical_eq(layout, was))
            .then_some(scene)
    });
    let working = moved.and_then(|scene| {
        let mut raw = raw_working?.as_object()?.clone();
        let mut visual = get(raw_working, "visual")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        visual.insert("layout".into(), scene.vertical.clone());
        raw.insert("visual".into(), Value::Object(visual));
        Some(Value::Object(raw))
    });
    Some(VerticalRepair {
        library: Value::Object(next_library),
        working,
        repaired: repaired.into_iter().map(|scene| scene.id).collect(),
    })
}

/// `sceneEditAutosave` (D11): the scene a confirmed commit writes, or none.
///
/// - Only a commit made while the scene was already on stream writes: the
///   commit that puts a scene on stream is a switch, not an edit.
/// - The look goes into the layout of the committed orientation; the other
///   orientation's layout stays.
/// - The screen is written when it changed while the scene was on (a
///   Screen pick, D2). An app's front window changing is not a pick.
/// - A capture kept running under a scene that shows no screen (D18) is
///   never its screen.
/// - Audio never changes this way (D10).
pub struct EditAutosave<'a> {
    /// The scene on stream before this commit, and what the capture showed
    /// then.
    pub previous_scene_id: Option<&'a str>,
    pub previous_shows: Option<&'a SceneShows>,
    pub scene_id: Option<&'a str>,
    pub scenes: &'a [Scene],
    /// The committed working look and sources (`SceneVisual`).
    pub visual: &'a Value,
    pub now: &'a str,
}

/// `sceneEditAutosave`.
pub fn scene_edit_autosave(input: &EditAutosave) -> Option<Scene> {
    let scene_id = input.scene_id?;
    if input.previous_scene_id != Some(scene_id) {
        return None;
    }
    let scene = input.scenes.iter().find(|scene| scene.id == scene_id)?;
    let layout = input.visual.get("layout").cloned().unwrap_or(Value::Null);
    let background = input
        .visual
        .get("background")
        .cloned()
        .unwrap_or(Value::Null);
    let orientation = Orientation::of_layout(&layout);
    let working = shows_from_sources(input.visual.get("sources").unwrap_or(&Value::Null));
    let picked = input
        .previous_shows
        .is_some_and(|previous| !same_shows(previous, &working));
    let shows = if picked { working } else { scene.shows.clone() };
    if canonical_eq(scene.layout(orientation), &layout)
        && canonical_eq(&scene.background, &background)
        && scene.shows == shows
    {
        return None;
    }
    let mut next = scene.clone();
    next.shows = shows;
    next.set_layout(orientation, layout);
    next.background = background;
    next.updated_at = input.now.to_string();
    Some(next)
}
