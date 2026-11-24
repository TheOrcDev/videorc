//! Plan 231 (#1543): every scene shows its own screen (`lib/scenes.ts`).
//!
//! A scene is what it shows (an app's front window, a fixed window, a
//! display, or nothing) plus how it is arranged in each orientation. The
//! built-in layouts are a scene's Layout choice, never something to switch
//! to (D2), and one scene works in 16:9 and in 9:16 (D4). The camera device
//! is one for every scene and lives in `captureConfig.sources` only (D9).
//!
//! As in [`super::model`], a layout and a background are the renderer's
//! normalized JSON; the scene and the library around them are typed, and
//! [`Scene::to_json`] / [`SceneLibrary::to_json`] write what Electron's
//! writer would.

use serde_json::{Map, Value, json};

use super::model::{NamedScene, SceneAudio, normalize_scene_app};
use crate::studio::capture_config::{layout_preset_is_vertical, parse_preset};
use crate::studio::js_value::{get, string, truthy};
use crate::studio::preview_scene::{layout_preset_needs_camera, layout_preset_needs_screen};

/// `SCENES_KEY`.
pub const SCENES_KEY: &str = "videorc.scenes.v2";

/// `KEEP_ONE_SCENE_REASON`.
pub const KEEP_ONE_SCENE_REASON: &str = "Keep at least one scene.";
/// `DELETE_ON_STREAM_REASON`.
pub const DELETE_ON_STREAM_REASON: &str = "Switch to another scene first.";
/// `GOING_ON_STREAM_REASON`.
pub const GOING_ON_STREAM_REASON: &str = "This scene is going on stream. Try again in a moment.";

/// `SceneOrientation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Horizontal,
    Vertical,
}

impl Orientation {
    /// `layoutPresetOrientation`.
    pub fn of_preset(preset: &str) -> Self {
        if layout_preset_is_vertical(preset) {
            Orientation::Vertical
        } else {
            Orientation::Horizontal
        }
    }

    /// The orientation of a layout's `layoutPreset`.
    pub fn of_layout(layout: &Value) -> Self {
        Self::of_preset(layout_preset(layout))
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Orientation::Horizontal => "horizontal",
            Orientation::Vertical => "vertical",
        }
    }
}

/// A layout's `layoutPreset`, `""` when it has none.
pub fn layout_preset(layout: &Value) -> &str {
    string(get(Some(layout), "layoutPreset")).unwrap_or_default()
}

/// A layout in Freeform arrangement.
pub fn layout_is_freeform(layout: &Value) -> bool {
    string(get(Some(layout), "arrangementMode")) == Some("freeform")
}

/// `layoutPresetNeedsScreen` by wire id; an unknown id needs nothing.
pub fn preset_needs_screen(preset: &str) -> bool {
    parse_preset(preset).is_some_and(|preset| layout_preset_needs_screen(&preset))
}

/// `layoutPresetNeedsCamera` by wire id; an unknown id needs nothing.
pub fn preset_needs_camera(preset: &str) -> bool {
    parse_preset(preset).is_some_and(|preset| layout_preset_needs_camera(&preset))
}

/// `SceneShows`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneShows {
    App {
        bundle_id: String,
        name: String,
        follows: bool,
    },
    Window {
        window_id: String,
        window_name: Option<String>,
    },
    /// An empty `screen_id` is the main display before the device list has
    /// named it (a new user's defaults): `with_main_display` writes the real
    /// one.
    Display {
        screen_id: String,
        screen_name: Option<String>,
        screen_uuid: Option<String>,
    },
    /// Shows no screen (Camera only); D18.
    None,
    /// Development builds.
    TestPattern,
}

impl SceneShows {
    /// The main display, not named yet.
    pub fn unnamed_display() -> Self {
        SceneShows::Display {
            screen_id: String::new(),
            screen_name: None,
            screen_uuid: None,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            SceneShows::App { .. } => "app",
            SceneShows::Window { .. } => "window",
            SceneShows::Display { .. } => "display",
            SceneShows::None => "none",
            SceneShows::TestPattern => "test-pattern",
        }
    }

    /// As stored: `kind` first, absent optional fields left out.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("kind".into(), json!(self.kind()));
        fn optional(out: &mut Map<String, Value>, key: &str, value: &Option<String>) {
            if let Some(value) = value {
                out.insert(key.into(), json!(value));
            }
        }
        match self {
            SceneShows::App {
                bundle_id,
                name,
                follows,
            } => {
                out.insert("bundleId".into(), json!(bundle_id));
                out.insert("name".into(), json!(name));
                out.insert("follows".into(), json!(follows));
            }
            SceneShows::Window {
                window_id,
                window_name,
            } => {
                out.insert("windowId".into(), json!(window_id));
                optional(&mut out, "windowName", window_name);
            }
            SceneShows::Display {
                screen_id,
                screen_name,
                screen_uuid,
            } => {
                out.insert("screenId".into(), json!(screen_id));
                optional(&mut out, "screenName", screen_name);
                optional(&mut out, "screenUuid", screen_uuid);
            }
            SceneShows::None | SceneShows::TestPattern => {}
        }
        Value::Object(out)
    }

    /// The same scene following its app or not (`{...shows, follows}`).
    pub fn with_follows(&self, follows: bool) -> Self {
        match self {
            SceneShows::App {
                bundle_id, name, ..
            } => SceneShows::App {
                bundle_id: bundle_id.clone(),
                name: name.clone(),
                follows,
            },
            other => other.clone(),
        }
    }
}

/// A non-empty string field (`value || undefined`).
fn non_empty(value: Option<&Value>) -> Option<String> {
    string(value)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// `showsFromSources`: what a v1 scene's or the working setup's sources show.
pub fn shows_from_sources(sources: &Value) -> SceneShows {
    if let Some(app) = normalize_scene_app(get(Some(sources), "app")) {
        return SceneShows::App {
            bundle_id: string(app.get("bundleId")).unwrap_or_default().to_string(),
            name: string(app.get("name")).unwrap_or_default().to_string(),
            follows: app.get("follows") == Some(&Value::Bool(true)),
        };
    }
    let field = |key: &str| get(Some(sources), key);
    if let Some(window_id) = non_empty(field("windowId")) {
        return SceneShows::Window {
            window_id,
            window_name: non_empty(field("windowName")),
        };
    }
    let screen_id = non_empty(field("screenId"));
    let screen_name = non_empty(field("screenName"));
    if screen_id.is_some() || screen_name.is_some() {
        return SceneShows::Display {
            screen_id: screen_id.unwrap_or_default(),
            screen_name,
            screen_uuid: non_empty(field("screenUuid")),
        };
    }
    if truthy(field("testPattern")) {
        return SceneShows::TestPattern;
    }
    if truthy(field("captureOff")) {
        return SceneShows::None;
    }
    // Nothing chosen yet is automatic selection in v1: the main display.
    SceneShows::unnamed_display()
}

/// `ShowsSources`: the capture part of a source selection for what a scene
/// shows. Every key is written: `None` clears it, so applying it over a
/// selection clears the previous screen. An app's front window is resolved
/// when the scene goes on stream.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShowsSources {
    pub screen_id: Option<String>,
    pub screen_name: Option<String>,
    pub screen_uuid: Option<String>,
    pub window_id: Option<String>,
    pub window_name: Option<String>,
    /// `{bundleId, name, follows}`.
    pub app: Option<Value>,
    pub capture_off: bool,
    pub test_pattern: bool,
}

impl ShowsSources {
    /// `{...sources, ...showsSources(shows)}`: a key that is `undefined` in
    /// JavaScript is absent here.
    pub fn apply_to(&self, sources: &mut Map<String, Value>) {
        let mut set = |key: &str, value: Option<Value>| match value {
            Some(value) => {
                sources.insert(key.into(), value);
            }
            None => {
                sources.remove(key);
            }
        };
        set("screenId", self.screen_id.clone().map(Value::String));
        set("screenName", self.screen_name.clone().map(Value::String));
        set("screenUuid", self.screen_uuid.clone().map(Value::String));
        set("windowId", self.window_id.clone().map(Value::String));
        set("windowName", self.window_name.clone().map(Value::String));
        set("app", self.app.clone());
        set("captureOff", Some(Value::Bool(self.capture_off)));
        set("testPattern", Some(Value::Bool(self.test_pattern)));
    }

    /// The selection as an object of its own (`showsSources(shows)` spread
    /// over nothing).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        self.apply_to(&mut out);
        Value::Object(out)
    }
}

/// `showsSources`.
pub fn shows_sources(shows: &SceneShows) -> ShowsSources {
    let none = ShowsSources::default();
    match shows {
        SceneShows::App {
            bundle_id,
            name,
            follows,
        } => ShowsSources {
            app: Some(json!({"bundleId": bundle_id, "name": name, "follows": follows})),
            ..none
        },
        SceneShows::Window {
            window_id,
            window_name,
        } => ShowsSources {
            window_id: Some(window_id.clone()),
            window_name: window_name.clone(),
            ..none
        },
        SceneShows::Display {
            screen_id,
            screen_name,
            screen_uuid,
        } => ShowsSources {
            screen_id: Some(screen_id.clone()).filter(|id| !id.is_empty()),
            screen_name: screen_name.clone(),
            screen_uuid: screen_uuid.clone(),
            ..none
        },
        SceneShows::None => ShowsSources {
            capture_off: true,
            ..none
        },
        SceneShows::TestPattern => ShowsSources {
            test_pattern: true,
            ..none
        },
    }
}

/// `sameShows`: whether two scenes show the same screen. A display's UUID
/// decides when both have one (plan 213 F1), else its id. Following is not
/// part of it.
pub fn same_shows(a: &SceneShows, b: &SceneShows) -> bool {
    match (a, b) {
        (SceneShows::App { bundle_id: a, .. }, SceneShows::App { bundle_id: b, .. }) => a == b,
        (SceneShows::Window { window_id: a, .. }, SceneShows::Window { window_id: b, .. }) => {
            a == b
        }
        (
            SceneShows::Display {
                screen_id: a_id,
                screen_name: a_name,
                screen_uuid: a_uuid,
            },
            SceneShows::Display {
                screen_id: b_id,
                screen_name: b_name,
                screen_uuid: b_uuid,
            },
        ) => match (a_uuid, b_uuid) {
            (Some(a), Some(b)) => a == b,
            _ => a_id == b_id && (!a_id.is_empty() || a_name == b_name),
        },
        _ => a.kind() == b.kind(),
    }
}

/// `Scene`.
#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub shows: SceneShows,
    /// The normalized `LayoutSettings` in 16:9.
    pub horizontal: Value,
    /// The normalized `LayoutSettings` in 9:16.
    pub vertical: Value,
    /// The saved background, or `Value::Null` for none.
    pub background: Value,
    /// Only when pinned with Save audio to scene (D10).
    pub audio: Option<SceneAudio>,
    /// Plan 249 S12: the room's guest roles, kept as saved.
    pub cloud: Option<Value>,
}

impl NamedScene for Scene {
    fn scene_id(&self) -> &str {
        &self.id
    }
    fn scene_name(&self) -> &str {
        &self.name
    }
}

impl Scene {
    /// `sceneLayout`: the scene's layout in a 16:9 or a 9:16 studio, or on
    /// that leg of a dual stream (D4).
    pub fn layout(&self, orientation: Orientation) -> &Value {
        match orientation {
            Orientation::Horizontal => &self.horizontal,
            Orientation::Vertical => &self.vertical,
        }
    }

    /// `layouts[orientation] = layout`.
    pub fn set_layout(&mut self, orientation: Orientation, layout: Value) {
        match orientation {
            Orientation::Horizontal => self.horizontal = layout,
            Orientation::Vertical => self.vertical = layout,
        }
    }

    /// As stored, in Electron's key order.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("name".into(), json!(self.name));
        out.insert("createdAt".into(), json!(self.created_at));
        out.insert("updatedAt".into(), json!(self.updated_at));
        out.insert("shows".into(), self.shows.to_json());
        out.insert(
            "layouts".into(),
            json!({"horizontal": self.horizontal, "vertical": self.vertical}),
        );
        out.insert("background".into(), self.background.clone());
        if let Some(audio) = &self.audio {
            out.insert("audio".into(), json!(audio));
        }
        if let Some(cloud) = &self.cloud {
            out.insert("cloud".into(), cloud.clone());
        }
        Value::Object(out)
    }
}

/// `SceneLibrary`.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneLibrary {
    pub scenes: Vec<Scene>,
    pub on_stream_id: String,
    /// D15: the shortcuts after the layout keys moved to scene keys, kept
    /// until the settings that hold them are stored too.
    pub pending_shortcuts: Option<Value>,
    /// #1706: every default scene's 9:16 layout shows what its 16:9 layout
    /// shows; from then on a 9:16 layout the streamer picks is theirs.
    pub vertical_layouts_repaired: bool,
}

impl SceneLibrary {
    /// As stored (`version: 2`).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("version".into(), json!(2));
        out.insert(
            "scenes".into(),
            Value::Array(self.scenes.iter().map(Scene::to_json).collect()),
        );
        out.insert("onStreamId".into(), json!(self.on_stream_id));
        if let Some(pending) = &self.pending_shortcuts {
            out.insert("pendingShortcuts".into(), pending.clone());
        }
        if self.vertical_layouts_repaired {
            out.insert("verticalLayoutsRepaired".into(), json!(true));
        }
        Value::Object(out)
    }

    /// `sceneOnStream`.
    pub fn on_stream(&self) -> &Scene {
        self.scenes
            .iter()
            .find(|scene| scene.id == self.on_stream_id)
            .unwrap_or(&self.scenes[0])
    }
}

/// `MainDisplay`: the device list's main display.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MainDisplay {
    pub id: String,
    pub name: String,
    pub display_uuid: Option<String>,
}

/// `sceneAtPosition`: position 1 answers to the first scene key (D5).
pub fn scene_at_position<T>(scenes: &[T], position: usize) -> Option<&T> {
    position.checked_sub(1).and_then(|index| scenes.get(index))
}

/// `scenePosition`: a scene's 1-based position, or none when it is not in
/// the list.
pub fn scene_position<T: NamedScene>(scenes: &[T], id: &str) -> Option<usize> {
    scenes
        .iter()
        .position(|scene| scene.scene_id() == id)
        .map(|index| index + 1)
}

/// `layoutShowsScreen`: Freeform, or a built-in layout with a screen.
pub fn layout_shows_screen(layout: &Value) -> bool {
    layout_is_freeform(layout) || preset_needs_screen(layout_preset(layout))
}

/// `firstSceneWithLayout` (D14: where a remote's legacy `layoutPreset`
/// goes). A Freeform arrangement is not its underlying layout.
pub fn first_scene_with_layout<'a>(
    scenes: &'a [Scene],
    orientation: Orientation,
    preset: &str,
) -> Option<&'a Scene> {
    scenes.iter().find(|scene| {
        let layout = scene.layout(orientation);
        layout_preset(layout) == preset && !layout_is_freeform(layout)
    })
}

/// `LAYOUT_PRESET_LABELS` (`lib/layout-labels.ts`, plan 174 S1.4): one name
/// per built-in layout everywhere. A vertical layout reads like its
/// horizontal twin.
pub const LAYOUT_PRESET_LABELS: [(&str, &str); 10] = [
    ("screen-camera", "Screen + camera"),
    ("screen-only", "Screen only"),
    ("camera-only", "Camera only"),
    ("side-by-side", "Side by side"),
    ("vertical-camera-top", "Camera top"),
    ("vertical-camera-bottom", "Camera bottom"),
    ("vertical-split", "Split"),
    ("vertical-screen-camera", "Screen + camera"),
    ("vertical-screen-only", "Screen only"),
    ("vertical-camera-only", "Camera only"),
];

fn preset_label(preset: &str) -> Option<&'static str> {
    LAYOUT_PRESET_LABELS
        .iter()
        .find(|(id, _)| *id == preset)
        .map(|(_, label)| *label)
}

/// `layoutPresetLabel`: a built-in layout's name. `both_orientations` is
/// for a list that holds both orientations: there the vertical twins of
/// horizontal layouts say so ("Vertical screen + camera").
pub fn layout_preset_label(preset: &str, both_orientations: bool) -> String {
    let label = preset_label(preset).unwrap_or(preset);
    let Some(twin) = preset.strip_prefix("vertical-") else {
        return label.to_string();
    };
    if !both_orientations || preset_label(twin).is_none() {
        return label.to_string();
    }
    let mut chars = label.chars();
    let first = chars
        .next()
        .map(|c| c.to_lowercase().to_string())
        .unwrap_or_default();
    format!("Vertical {first}{}", chars.as_str())
}
