//! Plan 231 S6 (`lib/scene-section.ts`): the pure reads behind Studio's
//! Scenes section (D7, D8, D19): what a scene shows in words, a card's
//! words and picture, the Screen and Layout fields, and the position keys'
//! line.

use serde_json::Value;
use videorc_protocol::Device;

use super::model::{GapSource, scene_gallery_reason, scene_source_gaps};
use super::v2::{
    Orientation, Scene, SceneShows, layout_preset, layout_preset_label, layout_shows_screen,
    preset_needs_camera, preset_needs_screen,
};
use crate::studio::capture_config::{HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS};
use crate::studio::js_value::{get, list_format, string, truthy};

/// `sceneCardsCameraGaps`' answer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CameraGaps {
    /// The cards that need the camera while it is off or gone.
    pub blocked: Vec<String>,
    /// One line under the cards that says why.
    pub reason: Option<String>,
}

/// `sceneCardsCameraGaps`: the camera is one for every scene (D9), so a
/// scene that needs it while it is off or gone is not that card's own
/// problem: the cards that need it are off, and one line says why. A screen
/// that is gone stays each card's own. `scenes` are `(id, name, visual)`.
pub fn scene_cards_camera_gaps(scenes: &[(&str, &str, &Value)], devices: &[Device]) -> CameraGaps {
    let mut blocked = Vec::new();
    let mut lines = Vec::new();
    for (id, name, visual) in scenes {
        let gaps: Vec<_> = scene_source_gaps(visual, devices)
            .into_iter()
            .filter(|gap| gap.source == GapSource::Camera)
            .collect();
        if gaps.is_empty() {
            continue;
        }
        blocked.push(id.to_string());
        lines.push((*name, gaps));
    }
    CameraGaps {
        blocked,
        reason: scene_gallery_reason(&lines),
    }
}

/// `sceneShowsWords`: what the scene puts on stream, in a few words: its
/// screen, or its layout when that shows none.
pub fn scene_shows_words(scene: &Scene, orientation: Orientation) -> String {
    let layout = scene.layout(orientation);
    if layout_shows_screen(layout) {
        shows_words(&scene.shows)
    } else {
        layout_preset_label(layout_preset(layout), false)
    }
}

/// `ScenePictureTarget`: what a card asks a picture of. Plan 260: the
/// `sources.scene_pictures` request is not in `videorc-protocol` yet (L2);
/// until it is, the target is this crate's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScenePictureTarget {
    App { bundle_id: String },
    Window { window_id: String },
    Display { screen_id: String },
}

/// `scenePictureTarget` (D7, D17): the app (its front window), the fixed
/// window or the display a scene shows, or none when its layout draws no
/// screen, or it shows none. `visual` is the v1-shaped visual.
pub fn scene_picture_target(visual: &Value) -> Option<ScenePictureTarget> {
    if !layout_shows_screen(visual.get("layout").unwrap_or(&Value::Null)) {
        return None;
    }
    let sources = visual.get("sources");
    let text = |key: &str| string(get(sources, key)).filter(|text| !text.is_empty());
    if let Some(app) = get(sources, "app").filter(|app| app.is_object()) {
        return Some(ScenePictureTarget::App {
            bundle_id: string(app.get("bundleId")).unwrap_or_default().to_string(),
        });
    }
    if let Some(window_id) = text("windowId") {
        return Some(ScenePictureTarget::Window {
            window_id: window_id.to_string(),
        });
    }
    text("screenId").map(|screen_id| ScenePictureTarget::Display {
        screen_id: screen_id.to_string(),
    })
}

/// `DISPLAY_SIZE_SUFFIX` (`/ · \d+ × \d+$/`): macOS names a display with its
/// size ("Built-in Retina Display · 3024 × 1964").
fn without_display_size(name: &str) -> &str {
    let Some(at) = name.rfind(" · ") else {
        return name;
    };
    let size = &name[at + " · ".len()..];
    let mut parts = size.split(" × ");
    let digits = |part: Option<&str>| {
        part.is_some_and(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    };
    if digits(parts.next()) && digits(parts.next()) && parts.next().is_none() {
        &name[..at]
    } else {
        name
    }
}

/// `sceneCardWords`: a card's meta words when nothing is wrong: what the
/// scene shows, short, never its own name again. `visual` is the v1-shaped
/// visual.
pub fn scene_card_words(name: &str, visual: &Value) -> Option<String> {
    let sources = visual.get("sources");
    let text = |key: &str| string(get(sources, key)).filter(|text| !text.is_empty());
    let words = if !layout_shows_screen(visual.get("layout").unwrap_or(&Value::Null)) {
        "No screen".to_string()
    } else if let Some(app) = get(sources, "app").filter(|app| app.is_object()) {
        let app_name = string(app.get("name")).unwrap_or_default();
        if name.starts_with(app_name) {
            "Front window".to_string()
        } else {
            format!("{app_name} · front window")
        }
    } else if text("windowId").is_some() {
        string(get(sources, "windowName"))
            .unwrap_or("Window")
            .to_string()
    } else if text("screenId").is_some() || text("screenName").is_some() {
        without_display_size(string(get(sources, "screenName")).unwrap_or("Display")).to_string()
    } else if truthy(get(sources, "testPattern")) {
        "Test pattern".to_string()
    } else {
        "No screen".to_string()
    };
    (words != name).then_some(words)
}

/// `showsWords`: the screen a scene keeps, in a few words, whatever its
/// layout draws.
pub fn shows_words(shows: &SceneShows) -> String {
    match shows {
        SceneShows::App { name, .. } => format!("{name} · front window"),
        SceneShows::Window {
            window_name: Some(name),
            ..
        } => format!("Window · {name}"),
        SceneShows::Window { .. } => "Window".to_string(),
        SceneShows::Display { screen_name, .. } => {
            screen_name.clone().unwrap_or_else(|| "Display".to_string())
        }
        SceneShows::TestPattern => "Test pattern".to_string(),
        SceneShows::None => "No screen".to_string(),
    }
}

/// `screenFieldWords` (D8): the screen the scene keeps, and a note when its
/// layout draws no screen ("Not shown in Camera only").
pub fn screen_field_words(shows: &SceneShows, layout: &Value) -> (String, Option<String>) {
    let words = shows_words(shows);
    if *shows == SceneShows::None || layout_shows_screen(layout) {
        return (words, None);
    }
    let note = format!(
        "Not shown in {}",
        layout_preset_label(layout_preset(layout), false)
    );
    (words, Some(note))
}

/// `layoutAsksForScreen` (D19): a layout that draws a screen, chosen for a
/// scene that shows none, asks for a screen first.
pub fn layout_asks_for_screen(shows: &SceneShows, preset: &str) -> bool {
    *shows == SceneShows::None && preset_needs_screen(preset)
}

/// One Layout field choice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutChoice {
    pub value: &'static str,
    pub label: String,
    pub disabled: bool,
}

/// `sceneLayoutChoices`: the four 16:9 layouts or the six 9:16 ones.
pub fn scene_layout_choices(orientation: Orientation, has_camera: bool) -> Vec<LayoutChoice> {
    let presets: &[&'static str] = match orientation {
        Orientation::Vertical => &VERTICAL_LAYOUT_PRESETS,
        Orientation::Horizontal => &HORIZONTAL_LAYOUT_PRESETS,
    };
    presets
        .iter()
        .map(|preset| LayoutChoice {
            value: preset,
            label: layout_preset_label(preset, false),
            disabled: !has_camera && preset_needs_camera(preset),
        })
        .collect()
}

/// `sceneLayoutCameraLine`: why some layouts are off, said once.
pub fn scene_layout_camera_line(choices: &[LayoutChoice]) -> Option<String> {
    let off: Vec<&str> = choices
        .iter()
        .filter(|choice| choice.disabled)
        .map(|choice| choice.label.as_str())
        .collect();
    (!off.is_empty()).then(|| format!("Choose a camera in Sources to use {}.", list_format(&off)))
}

/// `landscapeFramingShows` (plan 213 G3): Screen + camera and Screen only
/// fit or fill by choice.
pub fn landscape_framing_shows(layout: &Value) -> bool {
    matches!(layout_preset(layout), "screen-camera" | "screen-only")
}

/// `sceneSlotAccelerator`: a stored position key, or the platform's
/// default (⌃⌥N on macOS, Ctrl+Alt+Shift+N elsewhere); "" releases it.
pub fn scene_slot_accelerator(
    config: Option<&Value>,
    position: usize,
    platform: Option<&str>,
) -> String {
    if let Some(stored) = string(get(get(config, "sceneSlots"), &position.to_string())) {
        return stored.to_string();
    }
    let shift = if platform == Some("darwin") {
        ""
    } else {
        "Shift+"
    };
    format!("Control+Alt+{shift}{position}")
}

/// `sceneSlotKeysLine` (D5): the first and the ninth position keys while
/// both are the platform's own, else none.
pub fn scene_slot_keys_line(
    config: Option<&Value>,
    platform: Option<&str>,
) -> Option<(String, String)> {
    let first = scene_slot_accelerator(config, 1, platform);
    let last = scene_slot_accelerator(config, 9, platform);
    (first == scene_slot_accelerator(None, 1, platform)
        && last == scene_slot_accelerator(None, 9, platform))
    .then_some((first, last))
}
