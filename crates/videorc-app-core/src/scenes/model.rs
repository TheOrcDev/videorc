//! The saved scenes and the working scene as the renderer keeps them
//! (`lib/scene-presets.ts`, `lib/scene-autosave.ts`, `lib/scene-order.ts`,
//! `hooks/use-scene-presets.ts`).
//!
//! **The model is the JSON**, as for the capture config (S3.0d): a scene's
//! `visual` is the normalized `SceneVisual` object (`layout`, `sources`,
//! `background`), compared and stored as the renderer does, so a library
//! Electron wrote reads here unchanged and the Rust app writes what
//! Electron's writer would. Every function keeps its TypeScript name in its
//! doc line.

use serde::Serialize;
use serde_json::{Map, Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::background::{Invalid, normalize_saved_background};
use crate::studio::capture_config::{
    HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS, default_layout, normalize_layout_settings,
    parse_preset, wanted_source_selection,
};
use crate::studio::js_value::{get, json_parse, list_format, stored_text, string, truthy};
use crate::studio::preview_scene::{layout_preset_needs_camera, layout_preset_needs_screen};

/// `SCENE_LIBRARY_KEY`.
pub const SCENE_LIBRARY_KEY: &str = "videorc.scene-presets.v1";
/// `WORKING_SCENE_KEY`.
pub const WORKING_SCENE_KEY: &str = "videorc.working-scene.v1";

/// `sceneNameError`'s sentences.
pub const NAME_LENGTH_ERROR: &str = "Use a name between 1 and 80 characters.";
pub const NAME_TAKEN_ERROR: &str = "A scene with this name already exists.";
/// `hydrateSceneLibrary`'s sentences.
pub const LIBRARY_FUTURE_ERROR: &str =
    "Update Videorc to open these scenes. Your saved data is preserved.";
pub const LIBRARY_INVALID_ERROR: &str = "Some invalid scenes couldn't be loaded.";

/// `loadJson(key, null)`: the stored text parsed, or nothing for no value,
/// an empty one or text that is not JSON.
pub fn load_json(stored: Option<&Value>) -> Option<Value> {
    stored_text(stored)
        .filter(|text| !text.is_empty())
        .and_then(|text| json_parse(&text))
}

/// `SceneAudio`: what a saved scene hears (owner, 2026-10-27): its
/// microphone, None included, and System audio On or Off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAudio {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone_name: Option<String>,
    pub microphone_off: bool,
    pub system_audio_enabled: bool,
}

/// `SceneMicrophone`: the microphone a saved scene switches to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneMicrophone {
    pub microphone_id: Option<String>,
    pub microphone_name: Option<String>,
    pub microphone_off: bool,
}

/// `SavedScene`.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedScene {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// The normalized `SceneVisual`.
    pub visual: Value,
    /// Absent on a scene saved before scenes kept audio.
    pub audio: Option<SceneAudio>,
    /// Plan 249 S12: the room's guest roles, a versioned extension kept as
    /// saved ([`normalize_saved_scene_cloud`]).
    pub cloud: Option<Value>,
}

impl SavedScene {
    /// The scene as the library stores it.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("name".into(), json!(self.name));
        out.insert("createdAt".into(), json!(self.created_at));
        out.insert("updatedAt".into(), json!(self.updated_at));
        out.insert("visual".into(), self.visual.clone());
        if let Some(audio) = &self.audio {
            out.insert("audio".into(), json!(audio));
        }
        if let Some(cloud) = &self.cloud {
            out.insert("cloud".into(), cloud.clone());
        }
        Value::Object(out)
    }

    /// The scene made for an app, when it is one (`visual.sources.app`).
    pub fn app(&self) -> Option<&Value> {
        get(get(Some(&self.visual), "sources"), "app").filter(|app| app.is_object())
    }

    /// The layout's preset (`visual.layout.layoutPreset`).
    pub fn layout_preset(&self) -> &str {
        string(get(get(Some(&self.visual), "layout"), "layoutPreset")).unwrap_or_default()
    }
}

/// Where the working scene came from: a built-in layout, or a saved scene
/// (on, or left).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Origin {
    #[default]
    Builtin,
    Saved,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Builtin => "builtin",
            Origin::Saved => "saved",
        }
    }
}

/// `WorkingScene`: the look on stream and the saved scene it is.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkingScene {
    pub origin: Origin,
    pub scene_id: Option<String>,
    pub visual: Value,
}

impl WorkingScene {
    /// `JSON.stringify({version: 1, origin, sceneId, visual})`.
    pub fn to_json(&self) -> Value {
        json!({
            "version": 1,
            "origin": self.origin.as_str(),
            "sceneId": self.scene_id,
            "visual": self.visual,
        })
    }
}

/// `hydrateSceneLibrary`'s answer.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HydratedLibrary {
    pub scenes: Vec<SavedScene>,
    /// A library from a newer Videorc: shown empty, never written.
    pub read_only: bool,
    pub error: Option<&'static str>,
}

/// `normalizeSceneApp`: invalid optional fields never discard a scene or
/// opt it into following.
pub fn normalize_scene_app(raw: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(_)) = raw else {
        return None;
    };
    let bundle_id = string(get(raw, "bundleId")).filter(|id| is_bundle_id(id))?;
    let name = string(get(raw, "name"))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(bundle_id);
    Some(json!({
        "bundleId": bundle_id,
        "name": name,
        "follows": get(raw, "follows") == Some(&Value::Bool(true)),
    }))
}

/// `/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/`.
fn is_bundle_id(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// Copies `key` when the object has it (`{key: sources.key}`: an absent
/// key stays absent, as `undefined` does in `JSON.stringify`).
fn copy_key(out: &mut Map<String, Value>, from: &Value, key: &str) {
    if let Some(value) = get(Some(from), key) {
        out.insert(key.into(), value.clone());
    }
}

/// `usingVisualSources`: availability checks judge the sources in use,
/// while saved scenes keep the choice. A chosen id wins over a stale Off;
/// a UUID left without its display is dropped.
pub fn using_visual_sources(sources: &Value) -> Value {
    let field = |key: &str| get(Some(sources), key);
    let app = normalize_scene_app(field("app"));
    let mut out = Map::new();
    copy_key(&mut out, sources, "cameraId");
    copy_key(&mut out, sources, "cameraName");
    out.insert(
        "cameraOff".into(),
        json!(field("cameraOff") == Some(&Value::Bool(true)) && !truthy(field("cameraId"))),
    );
    out.insert(
        "captureOff".into(),
        json!(
            field("captureOff") == Some(&Value::Bool(true))
                && !truthy(field("screenId"))
                && !truthy(field("windowId"))
        ),
    );
    copy_key(&mut out, sources, "screenId");
    copy_key(&mut out, sources, "screenName");
    if let Some(uuid) = string(field("screenUuid"))
        && !uuid.is_empty()
        && (truthy(field("screenId")) || truthy(field("screenName")))
    {
        out.insert("screenUuid".into(), json!(uuid));
    }
    copy_key(&mut out, sources, "windowId");
    copy_key(&mut out, sources, "windowName");
    if let Some(app) = app {
        out.insert("app".into(), app);
    }
    out.insert(
        "testPattern".into(),
        json!(field("testPattern") == Some(&Value::Bool(true))),
    );
    Value::Object(out)
}

/// The keys `usingVisualSources` always writes (an absent one is an
/// explicit `undefined` in the renderer's object).
pub const VISUAL_SOURCE_KEYS: [&str; 10] = [
    "cameraId",
    "cameraName",
    "cameraOff",
    "captureOff",
    "screenId",
    "screenName",
    "screenUuid",
    "windowId",
    "windowName",
    "testPattern",
];

/// `{...current, ...visual.sources}`: a scene's visual sources over the
/// capture config's. A visual source the scene leaves unset clears the
/// current one, as the renderer's spread of an explicit `undefined` does
/// (a scene saved with Camera Off has no camera); the app rides along only
/// when the scene has one.
pub fn merge_visual_sources(current: &Value, visual_sources: &Value) -> Value {
    let mut merged = current.as_object().cloned().unwrap_or_default();
    for key in VISUAL_SOURCE_KEYS {
        match visual_sources.get(key) {
            Some(value) => merged.insert(key.into(), value.clone()),
            None => merged.remove(key),
        };
    }
    if let Some(app) = visual_sources.get("app") {
        merged.insert("app".into(), app.clone());
    }
    Value::Object(merged)
}

/// `visualSources`: the wanted sources (never a stand-in) with the scene's
/// app, as availability reads them.
pub fn visual_sources(sources: &Value) -> Value {
    let mut wanted = wanted_source_selection(sources);
    if let (Value::Object(map), Some(app)) = (&mut wanted, get(Some(sources), "app")) {
        map.insert("app".into(), app.clone());
    } else if let Value::Object(map) = &mut wanted {
        map.remove("app");
    }
    using_visual_sources(&wanted)
}

/// `withoutSceneApp`: app identity belongs to the scene memory, never to
/// the capture config's sources.
pub fn without_scene_app(sources: &Value) -> Value {
    let mut next = sources.clone();
    if let Value::Object(map) = &mut next {
        map.remove("app");
    }
    next
}

/// `sceneAudio(sources, audio)`: a chosen microphone wins over a stale None.
pub fn scene_audio(sources: &Value, system_audio_enabled: bool) -> SceneAudio {
    let field = |key: &str| get(Some(sources), key);
    SceneAudio {
        microphone_id: string(field("microphoneId")).map(str::to_string),
        microphone_name: string(field("microphoneName")).map(str::to_string),
        microphone_off: field("microphoneOff") == Some(&Value::Bool(true))
            && !truthy(field("microphoneId")),
        system_audio_enabled,
    }
}

/// `normalizeSceneAudio`: absent is no opinion; anything else must be the
/// shape `sceneAudio` writes.
pub fn normalize_scene_audio(raw: Option<&Value>) -> Result<Option<SceneAudio>, Invalid> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if !raw.is_object() {
        return Err("Invalid scene audio");
    }
    let field = |key: &str| get(Some(raw), key);
    if let Some(id) = field("microphoneId")
        && string(Some(id)).is_none_or(str::is_empty)
    {
        return Err("Invalid microphone identity");
    }
    if field("microphoneName").is_some_and(|name| !name.is_string()) {
        return Err("Invalid microphone label");
    }
    let (Some(Value::Bool(off)), Some(Value::Bool(system))) =
        (field("microphoneOff"), field("systemAudioEnabled"))
    else {
        return Err("Invalid scene audio");
    };
    let id = string(field("microphoneId")).map(str::to_string);
    Ok(Some(SceneAudio {
        microphone_off: *off && id.is_none(),
        microphone_id: id,
        microphone_name: string(field("microphoneName")).map(str::to_string),
        system_audio_enabled: *system,
    }))
}

/// `sameSceneAudio`: a scene saved before scenes kept audio, or with no
/// microphone ever chosen, holds no opinion on that part.
pub fn same_scene_audio(saved: Option<&SceneAudio>, working: &SceneAudio) -> bool {
    let Some(saved) = saved else {
        return true;
    };
    let chosen = saved.microphone_id.is_some() || saved.microphone_off;
    saved.system_audio_enabled == working.system_audio_enabled
        && (!chosen
            || (saved.microphone_id == working.microphone_id
                && saved.microphone_off == working.microphone_off))
}

/// `sceneMicrophone`: None, or the scene's microphone while it is listed as
/// available; nothing keeps the current one.
pub fn scene_microphone(audio: &SceneAudio, devices: &[Device]) -> Option<SceneMicrophone> {
    if audio.microphone_off {
        return Some(SceneMicrophone {
            microphone_id: None,
            microphone_name: None,
            microphone_off: true,
        });
    }
    let id = audio.microphone_id.as_deref()?;
    devices
        .iter()
        .any(|device| {
            device.id == id
                && device.kind == DeviceKind::Microphone
                && device.status == DeviceStatus::Available
        })
        .then(|| SceneMicrophone {
            microphone_id: Some(id.to_string()),
            microphone_name: audio.microphone_name.clone(),
            microphone_off: false,
        })
}

/// Every built-in layout's id (`BUILTIN_LAYOUTS`).
pub fn is_builtin_layout(id: &str) -> bool {
    HORIZONTAL_LAYOUT_PRESETS.contains(&id) || VERTICAL_LAYOUT_PRESETS.contains(&id)
}

/// `normalizeSceneVisual`: the layout's known fields normalized (a field
/// the renderer's normalizer passes through stays absent when the scene
/// lacks it), the visual sources, and the background; anything malformed
/// refuses the whole visual.
pub fn normalize_scene_visual(raw: &Value) -> Result<Value, Invalid> {
    if !raw.is_object() {
        return Err("Invalid visual snapshot");
    }
    let layout = get(Some(raw), "layout");
    let sources = get(Some(raw), "sources");
    if !truthy(layout)
        || !string(get(layout, "layoutPreset")).is_some_and(is_builtin_layout)
        || !matches!(sources, Some(Value::Object(_)))
    {
        return Err("Invalid scene layout or sources");
    }
    if let Some(visibility) = get(layout, "sourceVisibility") {
        let Value::Object(entries) = visibility else {
            return Err("Invalid source visibility");
        };
        if entries.iter().any(|(role, value)| {
            !matches!(role.as_str(), "camera" | "capture") || !value.is_boolean()
        }) {
            return Err("Invalid source visibility");
        }
    }
    if get(sources, "cameraOff").is_some_and(|value| !value.is_boolean()) {
        return Err("Invalid camera Off intent");
    }
    if get(sources, "captureOff").is_some_and(|value| !value.is_boolean()) {
        return Err("Invalid screen None intent");
    }
    for key in ["cameraId", "screenId", "windowId"] {
        if get(sources, key).is_some_and(|value| string(Some(value)).is_none_or(str::is_empty)) {
            return Err("Invalid source identity");
        }
    }
    for key in ["cameraName", "screenName", "windowName"] {
        if get(sources, key).is_some_and(|value| !value.is_string()) {
            return Err("Invalid source label");
        }
    }
    // `Object.fromEntries(Object.keys(defaultCaptureConfig.layout).map(...))`:
    // the known keys only, each the scene's value or `undefined`.
    let defaults = default_layout();
    let mut allowed = Map::new();
    for key in defaults.as_object().into_iter().flat_map(|map| map.keys()) {
        if let Some(value) = get(layout, key) {
            allowed.insert(key.clone(), value.clone());
        }
    }
    let mut layout = normalize_layout_settings(Some(&Value::Object(allowed.clone())));
    // `{...defaults, ...candidate}` with `key: undefined` drops the default
    // of a field the normalizer never repairs.
    if let Value::Object(map) = &mut layout {
        for key in ["cameraCorner", "cameraSize"] {
            if !allowed.contains_key(key) {
                map.remove(key);
            }
        }
    }
    Ok(json!({
        "layout": layout,
        "sources": visual_sources(sources.unwrap_or(&Value::Null)),
        "background": normalize_saved_background(get(Some(raw), "background"))?,
    }))
}

/// `toLocaleLowerCase` for names.
fn fold(name: &str) -> String {
    name.to_lowercase()
}

/// A scene with an id and a name: a v1 saved scene or a v2 scene
/// (`Pick<SavedScene, 'id' | 'name'>`).
pub trait NamedScene {
    fn scene_id(&self) -> &str;
    fn scene_name(&self) -> &str;
}

impl NamedScene for SavedScene {
    fn scene_id(&self) -> &str {
        &self.id
    }
    fn scene_name(&self) -> &str {
        &self.name
    }
}

/// `SAVED_SCENE_CLOUD_MAX_CHARS`.
const SAVED_SCENE_CLOUD_MAX_CHARS: usize = 4096;

/// `normalizeSavedSceneCloud` (plan 249 S12): a versioned object of at most
/// 4096 characters as JSON, kept as saved; anything else is dropped, never
/// the scene.
pub fn normalize_saved_scene_cloud(raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|raw| raw.is_object())?;
    // `Number.isSafeInteger(version) && version >= 1`.
    let version = raw.get("version").and_then(Value::as_f64)?;
    if version.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&version) {
        return None;
    }
    let text = serde_json::to_string(raw).ok()?;
    (text.encode_utf16().count() <= SAVED_SCENE_CLOUD_MAX_CHARS).then(|| raw.clone())
}

/// `sceneNameError`: 1 to 80 characters, unique without regard to case.
pub fn scene_name_error<S: NamedScene>(
    name: &str,
    scenes: &[S],
    except_id: Option<&str>,
) -> Option<&'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.encode_utf16().count() > 80 {
        return Some(NAME_LENGTH_ERROR);
    }
    let folded = fold(trimmed);
    scenes
        .iter()
        .any(|scene| Some(scene.scene_id()) != except_id && fold(scene.scene_name()) == folded)
        .then_some(NAME_TAKEN_ERROR)
}

/// `hydrateSceneLibrary`: every valid entry kept on its own, a library from
/// a newer Videorc kept read-only.
pub fn hydrate_scene_library(raw: Option<&Value>) -> HydratedLibrary {
    let Some(raw) = raw.filter(|raw| !raw.is_null()) else {
        return HydratedLibrary::default();
    };
    if get(Some(raw), "version").and_then(Value::as_f64) != Some(1.0) {
        return HydratedLibrary {
            scenes: Vec::new(),
            read_only: true,
            error: Some(LIBRARY_FUTURE_ERROR),
        };
    }
    let entries: &[Value] = match get(Some(raw), "scenes") {
        Some(Value::Array(entries)) => entries,
        _ => &[],
    };
    let mut scenes: Vec<SavedScene> = Vec::new();
    for entry in entries {
        let field = |key: &str| get(Some(entry), key);
        let (Some(id), Some(name), Some(created), Some(updated)) = (
            string(field("id")).filter(|id| !id.is_empty()),
            string(field("name")),
            string(field("createdAt")),
            string(field("updatedAt")),
        ) else {
            continue;
        };
        if scenes.iter().any(|scene| scene.id == id)
            || scene_name_error(name, &scenes, None).is_some()
        {
            continue;
        }
        let Ok(audio) = normalize_scene_audio(field("audio")) else {
            continue;
        };
        let Ok(visual) = normalize_scene_visual(field("visual").unwrap_or(&Value::Null)) else {
            continue;
        };
        scenes.push(SavedScene {
            id: id.to_string(),
            name: name.trim().to_string(),
            created_at: created.to_string(),
            updated_at: updated.to_string(),
            visual,
            audio,
            cloud: normalize_saved_scene_cloud(field("cloud")),
        });
    }
    let error = (scenes.len() != entries.len()).then_some(LIBRARY_INVALID_ERROR);
    HydratedLibrary {
        scenes,
        read_only: false,
        error,
    }
}

/// `hydrateWorkingScene`: nothing unless it is a version-1 checkpoint with a
/// visual that reads.
pub fn hydrate_working_scene(raw: Option<&Value>) -> Option<WorkingScene> {
    let raw = raw?;
    if get(Some(raw), "version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let scene_id = match get(Some(raw), "sceneId") {
        Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        _ => return None,
    };
    let origin = if string(get(Some(raw), "origin")) == Some("saved")
        || scene_id.as_deref().is_some_and(|id| !id.is_empty())
    {
        Origin::Saved
    } else {
        Origin::Builtin
    };
    let visual = normalize_scene_visual(get(Some(raw), "visual")?).ok()?;
    Some(WorkingScene {
        origin,
        scene_id,
        visual,
    })
}

/// `sameSceneVisual`: the two visuals normalized; a display's name and
/// UUID describe the display, so the same UUID is the same display under
/// any id and another UUID another display under the same one. A visual
/// that does not read is never the same.
pub fn same_scene_visual(a: &Value, b: &Value) -> bool {
    let (Ok(left), Ok(right)) = (normalize_scene_visual(a), normalize_scene_visual(b)) else {
        return false;
    };
    let uuid = |visual: &Value| {
        string(get(get(Some(visual), "sources"), "screenUuid"))
            .filter(|uuid| !uuid.is_empty())
            .map(str::to_string)
    };
    let (left_uuid, right_uuid) = (uuid(&left), uuid(&right));
    if let (Some(l), Some(r)) = (&left_uuid, &right_uuid)
        && l != r
    {
        return false;
    }
    let same_display = left_uuid.is_some() && left_uuid == right_uuid;
    let comparable = |mut visual: Value| {
        if let Some(Value::Object(sources)) = visual.get_mut("sources")
            && sources.get("screenId").is_some_and(|id| truthy(Some(id)))
        {
            sources.remove("screenName");
            sources.remove("screenUuid");
            if same_display {
                sources.remove("screenId");
            }
        }
        visual
    };
    comparable(left) == comparable(right)
}

/// `findRememberedSource`: a display's UUID first (it outlives the id macOS
/// gives it), then the id, then the name (and 0.18.0's iPhone tag).
pub fn find_remembered_source<'a>(
    source_id: Option<&str>,
    source_name: Option<&str>,
    devices: &[&'a Device],
    display_uuid: Option<&str>,
) -> Option<&'a Device> {
    let display_uuid = display_uuid.filter(|uuid| !uuid.is_empty());
    if let Some(uuid) = display_uuid
        && let Some(display) = devices
            .iter()
            .find(|device| device.display_uuid.as_deref() == Some(uuid))
    {
        return Some(display);
    }
    let candidates: Vec<&&Device> = devices
        .iter()
        .filter(|device| display_uuid.is_none() || device.display_uuid.is_none())
        .collect();
    if let Some(id) = source_id.filter(|id| !id.is_empty())
        && let Some(exact) = candidates.iter().find(|device| device.id == id)
    {
        return Some(exact);
    }
    let name = source_name.map(str::trim).filter(|name| !name.is_empty())?;
    candidates
        .iter()
        .find(|device| device.name.trim() == name)
        .or_else(|| {
            candidates.iter().find(|device| {
                device.kind == DeviceKind::Camera
                    && format!("{} · iPhone camera", device.name.trim()) == name
            })
        })
        .map(|device| **device)
}

fn source_str<'a>(sources: &'a Value, key: &str) -> Option<&'a str> {
    string(get(Some(sources), key)).filter(|text| !text.is_empty())
}

/// `sceneDisplay`: the display a scene shows, listed now (UUID first).
pub fn scene_display<'a>(sources: &Value, devices: &'a [Device]) -> Option<&'a Device> {
    if truthy(get(Some(sources), "windowId")) || truthy(get(Some(sources), "app")) {
        return None;
    }
    let screens: Vec<&Device> = devices
        .iter()
        .filter(|device| {
            device.kind == DeviceKind::Screen && device.status == DeviceStatus::Available
        })
        .collect();
    find_remembered_source(
        source_str(sources, "screenId"),
        source_str(sources, "screenName"),
        &screens,
        source_str(sources, "screenUuid"),
    )
}

/// `withSceneDisplay`: the scene's sources with its display as listed now,
/// when that is another id.
pub fn with_scene_display(visual: &Value, devices: &[Device]) -> Value {
    let sources = visual.get("sources").cloned().unwrap_or(Value::Null);
    let Some(display) = scene_display(&sources, devices) else {
        return visual.clone();
    };
    if source_str(&sources, "screenId") == Some(display.id.as_str()) {
        return visual.clone();
    }
    let mut next = visual.clone();
    if let Some(Value::Object(map)) = next.get_mut("sources") {
        map.insert("screenId".into(), json!(display.id));
        map.insert("screenName".into(), json!(display.name));
        match &display.display_uuid {
            Some(uuid) => map.insert("screenUuid".into(), json!(uuid)),
            None => map.remove("screenUuid"),
        };
    }
    next
}

/// `sceneDisplayRefresh`: the id, name and UUID a saved scene's display is
/// listed under now, when it is the same display and something changed.
pub fn scene_display_refresh(
    sources: &Value,
    devices: &[Device],
) -> Option<(String, String, Option<String>)> {
    let display = scene_display(sources, devices)?;
    let same = match source_str(sources, "screenUuid") {
        Some(uuid) => display.display_uuid.as_deref() == Some(uuid),
        None => source_str(sources, "screenId") == Some(display.id.as_str()),
    };
    let unchanged = source_str(sources, "screenId") == Some(display.id.as_str())
        && string(get(Some(sources), "screenName")) == Some(display.name.as_str())
        && source_str(sources, "screenUuid") == display.display_uuid.as_deref();
    (same && !unchanged).then(|| {
        (
            display.id.clone(),
            display.name.clone(),
            display.display_uuid.clone(),
        )
    })
}

/// `SceneSourceGap['source']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapSource {
    Camera,
    Screen,
}

/// `SceneSourceGap['state']`: nothing chosen, or chosen but not listed as
/// available.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapState {
    Off,
    Unavailable,
}

/// `SceneSourceGap`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceGap {
    pub source: GapSource,
    pub state: GapState,
}

fn kind_of(source: GapSource, window: bool) -> DeviceKind {
    match source {
        GapSource::Camera => DeviceKind::Camera,
        GapSource::Screen if window => DeviceKind::Window,
        GapSource::Screen => DeviceKind::Screen,
    }
}

/// `sceneSourceGaps`: the camera when the layout shows one, the screen or
/// window when it shows one (a test pattern stands in for no screen);
/// Freeform needs what it has. An app scene's window is the resolver's.
pub fn scene_source_gaps(visual: &Value, devices: &[Device]) -> Vec<SourceGap> {
    let layout = get(Some(visual), "layout");
    let sources = get(Some(visual), "sources").cloned().unwrap_or(Value::Null);
    let freeform = string(get(layout, "arrangementMode")) == Some("freeform");
    let preset = string(get(layout, "layoutPreset")).and_then(parse_preset);
    let mut gaps = Vec::new();
    let check =
        |gaps: &mut Vec<SourceGap>, id: Option<&str>, source: GapSource, window: bool| match id {
            None => gaps.push(SourceGap {
                source,
                state: GapState::Off,
            }),
            Some(id) => {
                let kind = kind_of(source, window);
                if !devices.iter().any(|device| {
                    device.id == id
                        && device.kind == kind
                        && device.status == DeviceStatus::Available
                }) {
                    gaps.push(SourceGap {
                        source,
                        state: GapState::Unavailable,
                    });
                }
            }
        };
    let camera_id = source_str(&sources, "cameraId");
    let needs_camera = if freeform {
        camera_id.is_some()
    } else {
        preset.as_ref().is_some_and(layout_preset_needs_camera)
    };
    if needs_camera {
        check(&mut gaps, camera_id, GapSource::Camera, false);
    }
    let window_id = source_str(&sources, "windowId");
    let base_id = window_id.or_else(|| source_str(&sources, "screenId"));
    let needs_screen = freeform || preset.as_ref().is_some_and(layout_preset_needs_screen);
    if needs_screen && (!truthy(get(Some(&sources), "testPattern")) || base_id.is_some()) {
        if truthy(get(Some(&sources), "app")) {
            return gaps;
        }
        if window_id.is_some() {
            check(&mut gaps, base_id, GapSource::Screen, true);
        } else if scene_display(&sources, devices).is_none() {
            gaps.push(SourceGap {
                source: GapSource::Screen,
                state: if base_id.is_some() {
                    GapState::Unavailable
                } else {
                    GapState::Off
                },
            });
        }
    }
    gaps
}

/// `sceneSourceProblems`' sentences.
pub const CAMERA_OFF_PROBLEM: &str = "Camera is off. Turn it on in Sources to use this scene.";
pub const CAMERA_GONE_PROBLEM: &str = "Camera unavailable. Choose a replacement in Sources.";
pub const SCREEN_OFF_PROBLEM: &str =
    "No screen is chosen. Choose one in Sources to use this scene.";
pub const SCREEN_GONE_PROBLEM: &str =
    "Screen or window unavailable. Choose a replacement in Sources.";

/// `sceneSourceProblems`: a source turned off on purpose is not
/// "unavailable", and there is nothing to replace.
pub fn scene_source_problems(visual: &Value, devices: &[Device]) -> Vec<&'static str> {
    scene_source_gaps(visual, devices)
        .into_iter()
        .map(|gap| match (gap.source, gap.state) {
            (GapSource::Camera, GapState::Off) => CAMERA_OFF_PROBLEM,
            (GapSource::Camera, GapState::Unavailable) => CAMERA_GONE_PROBLEM,
            (GapSource::Screen, GapState::Off) => SCREEN_OFF_PROBLEM,
            (GapSource::Screen, GapState::Unavailable) => SCREEN_GONE_PROBLEM,
        })
        .collect()
}

/// A layout in Freeform (`arrangementMode === 'freeform'`).
pub fn is_freeform(layout: Option<&Value>) -> bool {
    string(get(layout, "arrangementMode")) == Some("freeform")
}

/// `sceneGalleryReason`: one sentence per missing source, naming the
/// scenes it blocks; a camera turned off is told from one that is gone.
pub fn scene_gallery_reason(blocked: &[(&str, Vec<SourceGap>)]) -> Option<String> {
    let mut sentences = Vec::new();
    for source in [GapSource::Camera, GapSource::Screen] {
        let scenes: Vec<&(&str, Vec<SourceGap>)> = blocked
            .iter()
            .filter(|(_, gaps)| gaps.iter().any(|gap| gap.source == source))
            .collect();
        if scenes.is_empty() {
            continue;
        }
        let mut labels: Vec<&str> = Vec::new();
        for (label, _) in &scenes {
            if !labels.contains(label) {
                labels.push(label);
            }
        }
        let labels = list_format(&labels);
        let off = scenes.iter().any(|(_, gaps)| {
            gaps.iter()
                .any(|gap| gap.source == source && gap.state == GapState::Off)
        });
        sentences.push(match (source, off) {
            (GapSource::Camera, true) => {
                format!("Camera is off. Choose one in Sources to use {labels}.")
            }
            (GapSource::Camera, false) => {
                format!("Your camera isn't available. Choose another in Sources to use {labels}.")
            }
            (GapSource::Screen, true) => {
                format!("No screen is chosen. Choose one in Sources to use {labels}.")
            }
            (GapSource::Screen, false) => {
                format!("Your screen isn't available. Choose another in Sources to use {labels}.")
            }
        });
    }
    (!sentences.is_empty()).then(|| sentences.join(" "))
}

/// `movedScenes`: the library with one scene moved to `to_index`, or
/// nothing when nothing moves.
pub fn moved_scenes<S: NamedScene + Clone>(
    scenes: &[S],
    id: &str,
    to_index: usize,
) -> Option<Vec<S>> {
    let from = scenes.iter().position(|scene| scene.scene_id() == id)?;
    if to_index >= scenes.len() || to_index == from {
        return None;
    }
    let mut next = scenes.to_vec();
    let scene = next.remove(from);
    next.insert(to_index, scene);
    Some(next)
}
