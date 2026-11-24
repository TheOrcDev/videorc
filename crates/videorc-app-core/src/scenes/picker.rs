//! Plan 231 D6 (`lib/scene-app-picker.ts`): one picker for what a scene
//! shows. Add scene… offers the open apps (macOS: icon, a picture of the
//! front window, "Chrome · 3 windows"), the displays and Camera only; several
//! can be chosen, and each becomes a scene in the look of the scene on
//! stream, at the end of the list, without touching what's on stream. Change
//! screen… is the same picker for one scene, with "A specific window" under
//! Apps (plan 210's fixed window) and "No screen". Windows and Linux offer
//! the displays and Camera only.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::list::unique_scene_name;
use super::model::NamedScene;
use super::store::display_shows;
use super::v2::{
    MainDisplay, Orientation, Scene, SceneShows, layout_preset, layout_shows_screen,
    preset_needs_camera, same_shows,
};
use crate::studio::health_page::plural;
use crate::studio::source_selection::{capture_picker_devices, is_system_session_window_device};

/// `AppChoice`: one app the picker offers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppChoice {
    pub bundle_id: String,
    pub name: String,
    pub window_count: u32,
    pub front_window_id: Option<String>,
    pub front_window_title: Option<String>,
    /// A small JPEG of the front window (plan 210 S4, macOS 14 and up).
    pub picture: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// `AppPreview`: one app in the app pictures' answer. Plan 260: the
/// request is not in `videorc-protocol` yet (L2); until it is, the answer
/// is this crate's.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppPreview {
    pub bundle_id: String,
    pub name: String,
    pub window_count: u32,
    pub front_window_id: Option<String>,
    pub front_window_title: Option<String>,
    pub picture: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// `ScreenPick`: one thing a scene can show, as the picker offers it.
#[derive(Debug, Clone, PartialEq)]
pub enum ScreenPick {
    App(AppChoice),
    /// A fixed window (Change screen… → A specific window).
    Window(Device),
    Display(Device),
    /// Camera only in Add scene…, No screen in Change screen… (D18).
    None,
}

/// `NO_SCREEN_SCENE_NAME`.
pub const NO_SCREEN_SCENE_NAME: &str = "Camera only";

/// D1's floor: palettes and popups under 400 × 300 aren't an app's window.
const MIN_WINDOW_WIDTH: u32 = 400;
const MIN_WINDOW_HEIGHT: u32 = 300;

/// `SYSTEM_BUNDLE_IDS`: macOS's own surfaces own screen-sized windows that
/// are never an app you show.
const SYSTEM_BUNDLE_IDS: [&str; 8] = [
    "com.apple.dock",
    "com.apple.windowmanager",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.spotlight",
    "com.apple.wallpaper.agent",
    "com.apple.loginwindow",
    "com.apple.screencaptureui",
];

fn lowered(ids: &[String]) -> Vec<String> {
    ids.iter().map(|id| id.to_lowercase()).collect()
}

fn offered(bundle_id: &str, own: &[String]) -> bool {
    let key = bundle_id.to_lowercase();
    !own.contains(&key) && !SYSTEM_BUNDLE_IDS.contains(&key.as_str())
}

/// `windowTitle`: a front window's title, unless it only repeats the app's
/// name.
fn window_title(title: Option<&str>, name: &str) -> Option<String> {
    let trimmed = title?.trim();
    (!trimmed.is_empty() && trimmed.to_lowercase() != name.trim().to_lowercase())
        .then(|| trimmed.to_string())
}

fn is_app_window(device: &Device) -> bool {
    device.kind == DeviceKind::Window
        && device.status == DeviceStatus::Available
        && device
            .app
            .as_ref()
            .is_some_and(|app| !app.bundle_id.is_empty())
        && !is_system_session_window_device(device)
        && device.width.is_none_or(|width| width >= MIN_WINDOW_WIDTH)
        && device
            .height
            .is_none_or(|height| height >= MIN_WINDOW_HEIGHT)
}

/// `byText`: `localeCompare` with base sensitivity, case not counted.
/// Accents are compared as they are (`Intl` folds them).
fn by_text(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// `appChoicesFromDevices`: before the app pictures come (or when they
/// fail), the device list is the picker: window sources grouped by their
/// app, counted, the first one standing in for the front window. Videorc's
/// own app is never offered.
pub fn app_choices_from_devices(devices: &[Device], own_bundle_ids: &[String]) -> Vec<AppChoice> {
    let own = lowered(own_bundle_ids);
    let mut order: Vec<String> = Vec::new();
    let mut apps: HashMap<String, AppChoice> = HashMap::new();
    for device in devices {
        if !is_app_window(device) {
            continue;
        }
        let app = device.app.as_ref().expect("an app window has its app");
        if !offered(&app.bundle_id, &own) {
            continue;
        }
        let key = app.bundle_id.to_lowercase();
        if let Some(existing) = apps.get_mut(&key) {
            existing.window_count += 1;
            continue;
        }
        order.push(key.clone());
        apps.insert(
            key,
            AppChoice {
                bundle_id: app.bundle_id.clone(),
                name: app.name.clone(),
                window_count: 1,
                front_window_id: Some(device.id.clone()),
                front_window_title: window_title(device.window_title.as_deref(), &app.name),
                ..AppChoice::default()
            },
        );
    }
    let mut choices: Vec<AppChoice> = order
        .into_iter()
        .filter_map(|key| apps.remove(&key))
        .collect();
    choices.sort_by(|a, b| by_text(&a.name, &b.name));
    choices
}

/// `appChoicesFromPreviews`: the app pictures' answer, without Videorc
/// itself and without apps that have no window.
pub fn app_choices_from_previews(
    previews: &[AppPreview],
    own_bundle_ids: &[String],
) -> Vec<AppChoice> {
    let own = lowered(own_bundle_ids);
    let mut seen: Vec<String> = Vec::new();
    let mut apps = Vec::new();
    for preview in previews {
        let key = preview.bundle_id.to_lowercase();
        if !offered(&preview.bundle_id, &own) || seen.contains(&key) || preview.window_count < 1 {
            continue;
        }
        seen.push(key);
        apps.push(AppChoice {
            bundle_id: preview.bundle_id.clone(),
            name: preview.name.clone(),
            window_count: preview.window_count,
            front_window_id: preview.front_window_id.clone(),
            front_window_title: window_title(preview.front_window_title.as_deref(), &preview.name),
            picture: preview.picture.clone(),
            width: preview.width,
            height: preview.height,
        });
    }
    apps.sort_by(|a, b| by_text(&a.name, &b.name));
    apps
}

/// `displayChoices`: on macOS the screens (windows are apps, or "A specific
/// window"); on Windows and Linux what Sources offers there.
pub fn display_choices<'a>(devices: &'a [Device], platform: Option<&str>) -> Vec<&'a Device> {
    capture_picker_devices(devices)
        .into_iter()
        .filter(|device| device.status == DeviceStatus::Available)
        .filter(|device| platform != Some("darwin") || device.kind == DeviceKind::Screen)
        .collect()
}

/// `windowChoices`: every app window, by app then title, never Videorc's
/// own.
pub fn window_choices<'a>(devices: &'a [Device], own_bundle_ids: &[String]) -> Vec<&'a Device> {
    let own = lowered(own_bundle_ids);
    let mut windows: Vec<&Device> = devices
        .iter()
        .filter(|device| {
            is_app_window(device)
                && offered(&device.app.as_ref().expect("an app window").bundle_id, &own)
        })
        .collect();
    windows.sort_by(|a, b| {
        let app = |device: &Device| {
            device
                .app
                .as_ref()
                .map(|app| app.name.clone())
                .unwrap_or_default()
        };
        by_text(&app(a), &app(b)).then_with(|| by_text(&window_label(a), &window_label(b)))
    });
    windows
}

/// `windowLabel`: a window's own words, its title, else its source name.
pub fn window_label(device: &Device) -> String {
    device
        .window_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&device.name)
        .to_string()
}

/// `matchesSearch`: a search matches any of a choice's words.
pub fn matches_search(words: &[Option<&str>], query: &str) -> bool {
    let needle = query.trim().to_lowercase();
    needle.is_empty()
        || words
            .iter()
            .any(|word| word.unwrap_or_default().to_lowercase().contains(&needle))
}

/// `searchAppChoices`: an app's name or its front window's title.
pub fn search_app_choices(choices: &[AppChoice], query: &str) -> Vec<AppChoice> {
    choices
        .iter()
        .filter(|choice| {
            matches_search(
                &[Some(&choice.name), choice.front_window_title.as_deref()],
                query,
            )
        })
        .cloned()
        .collect()
}

/// `addScenesLabel`: "Add scene", or "Add 3 scenes".
pub fn add_scenes_label(count: usize) -> String {
    if count > 1 {
        format!("Add {}", plural(count as i64, "scene"))
    } else {
        "Add scene".to_string()
    }
}

/// `windowCountLabel`: "3 windows" under an app with several.
pub fn window_count_label(count: u32) -> Option<String> {
    (count > 1).then(|| plural(i64::from(count), "window"))
}

/// `pickKey`: one key per choice, for the selection.
pub fn pick_key(pick: &ScreenPick) -> String {
    match pick {
        ScreenPick::App(app) => format!("app:{}", app.bundle_id.to_lowercase()),
        ScreenPick::Window(device) => format!("window:{}", device.id),
        ScreenPick::Display(device) => format!("display:{}", device.id),
        ScreenPick::None => "none".to_string(),
    }
}

/// `pickShows`: what a scene made from the pick shows. A new app scene
/// follows its app (plan 210 D10).
pub fn pick_shows(pick: &ScreenPick, follows: bool) -> SceneShows {
    match pick {
        ScreenPick::App(app) => SceneShows::App {
            bundle_id: app.bundle_id.clone(),
            name: app.name.clone(),
            follows,
        },
        ScreenPick::Window(device) => SceneShows::Window {
            window_id: device.id.clone(),
            window_name: Some(device.name.clone()),
        },
        ScreenPick::Display(device) => display_shows(Some(&MainDisplay {
            id: device.id.clone(),
            name: device.name.clone(),
            display_uuid: device.display_uuid.clone(),
        })),
        ScreenPick::None => SceneShows::None,
    }
}

/// `pickName`: the name a scene made from the pick takes, what it shows.
pub fn pick_name(pick: &ScreenPick) -> String {
    match pick {
        ScreenPick::App(app) => app.name.clone(),
        ScreenPick::Window(device) => device
            .app
            .as_ref()
            .map(|app| app.name.clone())
            .unwrap_or_else(|| window_label(device)),
        ScreenPick::Display(device) => device.name.clone(),
        ScreenPick::None => NO_SCREEN_SCENE_NAME.to_string(),
    }
}

/// `showsPick`: the scene already shows what the pick shows (Change
/// screen… has nothing to do).
pub fn shows_pick(shows: &SceneShows, pick: &ScreenPick) -> bool {
    same_shows(shows, &pick_shows(pick, true))
}

/// `showsName`: the name of what a scene shows, when a scene named after
/// it reads so. "Camera only" is a layout's name (a default scene, D3): the
/// scene keeps it.
fn shows_name(shows: &SceneShows) -> Option<&str> {
    match shows {
        SceneShows::App { name, .. } => Some(name),
        SceneShows::Window { window_name, .. } => window_name.as_deref(),
        SceneShows::Display { screen_name, .. } => screen_name.as_deref(),
        SceneShows::None | SceneShows::TestPattern => None,
    }
}

/// `namedAfter`: "Figma", "Figma 2", a name that is what the scene shows,
/// not one the streamer typed (`/^base( \d+)?$/i`).
fn named_after(name: &str, base: Option<&str>) -> bool {
    let Some(base) = base else {
        return false;
    };
    let name = name.trim().to_lowercase();
    let base = base.trim().to_lowercase();
    let Some(rest) = name.strip_prefix(&base) else {
        return false;
    };
    rest.is_empty()
        || rest
            .strip_prefix(' ')
            .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn screen_layout_for(preset: &str, camera_on: bool) -> &'static str {
    let camera = camera_on && preset_needs_camera(preset);
    match (Orientation::of_preset(preset), camera) {
        (Orientation::Vertical, true) => "vertical-screen-camera",
        (Orientation::Vertical, false) => "vertical-screen-only",
        (Orientation::Horizontal, true) => "screen-camera",
        (Orientation::Horizontal, false) => "screen-only",
    }
}

fn visibility(layout: &Value, key: &str) -> bool {
    layout
        .get("sourceVisibility")
        .and_then(|visibility| visibility.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// `layoutShowingScreen`: a layout made to show a screen. A camera layout
/// with the camera off becomes its screen-only twin, so every new scene can
/// go on stream. The orientation never changes.
pub fn layout_showing_screen(layout: &Value, camera_on: bool) -> Value {
    let preset = layout_preset(layout);
    let fits = layout_shows_screen(layout) && (camera_on || !preset_needs_camera(preset));
    let next_preset = if fits {
        preset.to_string()
    } else {
        screen_layout_for(preset, camera_on).to_string()
    };
    let mut next = layout.as_object().cloned().unwrap_or_default();
    if next_preset != preset {
        next.insert("arrangementMode".into(), json!("preset"));
        next.insert("sourceTransformOverrides".into(), json!({}));
    }
    next.insert("layoutPreset".into(), json!(next_preset));
    next.insert(
        "sourceVisibility".into(),
        json!({"camera": visibility(layout, "camera"), "capture": true}),
    );
    Value::Object(next)
}

/// `layoutShowingNoScreen` (D18, D19): Camera only in its orientation.
pub fn layout_showing_no_screen(layout: &Value) -> Value {
    if !layout_shows_screen(layout) {
        return layout.clone();
    }
    let mut next = layout.as_object().cloned().unwrap_or_default();
    let preset = match Orientation::of_layout(layout) {
        Orientation::Vertical => "vertical-camera-only",
        Orientation::Horizontal => "camera-only",
    };
    next.insert("layoutPreset".into(), json!(preset));
    next.insert("arrangementMode".into(), json!("preset"));
    next.insert("sourceTransformOverrides".into(), json!({}));
    next.insert(
        "sourceVisibility".into(),
        json!({"camera": true, "capture": visibility(layout, "capture")}),
    );
    Value::Object(next)
}

/// `newScenes`' answer.
#[derive(Debug, Clone, PartialEq)]
pub struct NewScenes {
    pub scenes: Vec<Scene>,
    /// An app's front window, where its scene looks first (plan 210 D5).
    pub window_hints: Vec<(String, String)>,
}

/// `newScenes` (D6): Add scene…'s scenes. Each is named after what it
/// shows ("Figma", then "Figma 2"), takes the look of the scene on stream
/// (both layouts and the background) made to show its screen, or Camera
/// only, and keeps no audio (D10).
pub fn new_scenes(
    picks: &[ScreenPick],
    template: &Scene,
    existing: &[Scene],
    camera_on: bool,
    mut id: impl FnMut() -> String,
    mut now: impl FnMut() -> String,
) -> NewScenes {
    let mut taken: Vec<(String, String)> = existing
        .iter()
        .map(|scene| (scene.id.clone(), scene.name.clone()))
        .collect();
    let mut window_hints = Vec::new();
    let mut scenes = Vec::new();
    for pick in picks {
        let scene_id = id();
        let stamp = now();
        let name = unique_scene_name(&pick_name(pick), &taken, None);
        taken.push((scene_id.clone(), name.clone()));
        if let ScreenPick::App(app) = pick
            && let Some(window) = &app.front_window_id
        {
            window_hints.push((scene_id.clone(), window.clone()));
        }
        let look = |layout: &Value| match pick {
            ScreenPick::None => layout_showing_no_screen(layout),
            _ => layout_showing_screen(layout, camera_on),
        };
        scenes.push(Scene {
            id: scene_id,
            name,
            created_at: stamp.clone(),
            updated_at: stamp,
            shows: pick_shows(pick, true),
            horizontal: look(&template.horizontal),
            vertical: look(&template.vertical),
            background: template.background.clone(),
            audio: None,
            cloud: None,
        });
    }
    NewScenes {
        scenes,
        window_hints,
    }
}

impl NamedScene for (String, String) {
    fn scene_id(&self) -> &str {
        &self.0
    }
    fn scene_name(&self) -> &str {
        &self.1
    }
}

/// `sceneShowingPick` (D6): Change screen…. The scene shows what was picked
/// and keeps its look, keys and audio; an app keeps the scene's following.
/// No screen puts the scene's layouts on Camera only (D19). A name that was
/// what the scene showed becomes the new one's; a name the streamer typed
/// stays.
pub fn scene_showing_pick<S: NamedScene>(
    scene: &Scene,
    pick: &ScreenPick,
    scenes: &[S],
    now: &str,
) -> Scene {
    let follows = match &scene.shows {
        SceneShows::App { follows, .. } => *follows,
        _ => true,
    };
    let name = if named_after(&scene.name, shows_name(&scene.shows)) {
        unique_scene_name(&pick_name(pick), scenes, Some(&scene.id))
    } else {
        scene.name.clone()
    };
    let (horizontal, vertical) = match pick {
        ScreenPick::None => (
            layout_showing_no_screen(&scene.horizontal),
            layout_showing_no_screen(&scene.vertical),
        ),
        _ => (scene.horizontal.clone(), scene.vertical.clone()),
    };
    Scene {
        name,
        updated_at: now.to_string(),
        shows: pick_shows(pick, follows),
        horizontal,
        vertical,
        ..scene.clone()
    }
}
