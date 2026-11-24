//! Plan 231 D15 (`lib/scenes-migration.ts`): the scene library for a
//! profile that has none yet, made from its v1 saved scenes, its working
//! setup and its layout keys. Nothing on stream changes on update.
//!
//! The capture config and the shortcuts are the renderer's JSON, as the
//! rest of the Studio reads them.

use serde_json::{Map, Value, json};

use super::model::{SavedScene, WorkingScene, normalize_scene_visual};
use super::store::{
    Invalid, default_scene_id, display_shows, on_preset, presets_show_same_sources,
    vertical_twin_preset,
};
use super::v2::{
    MainDisplay, Orientation, Scene, SceneLibrary, SceneShows, layout_is_freeform, layout_preset,
    layout_preset_label, layout_shows_screen, preset_needs_screen, same_shows, shows_from_sources,
    shows_sources,
};
use crate::studio::capture_config::{
    HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS, default_capture_config,
};
use crate::studio::js_value::{canonical_eq, get, string};

/// `WORKING_SCENE_ID`.
pub const WORKING_SCENE_ID: &str = "migrated-working";

/// `horizontalTwin`: a 9:16 layout's 16:9 twin: Camera only, Screen only,
/// else Screen + camera.
pub fn horizontal_twin(preset: &str) -> &'static str {
    match preset {
        "vertical-camera-only" => "camera-only",
        "vertical-screen-only" => "screen-only",
        _ => "screen-camera",
    }
}

/// `text.slice(0, n)` in UTF-16 units.
fn slice_utf16(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

/// `uniqueName`: "Figma", then "Figma 2" while taken, within the
/// 80-character limit.
fn unique_name(base: &str, scenes: &[Scene]) -> String {
    let taken: Vec<String> = scenes
        .iter()
        .map(|scene| scene.name.to_lowercase())
        .collect();
    let trimmed = match slice_utf16(base.trim(), 80) {
        "" => "Scene",
        text => text,
    };
    let mut name = trimmed.to_string();
    let mut n = 2;
    while taken.contains(&name.to_lowercase()) {
        let suffix = format!(" {n}");
        name = format!(
            "{}{suffix}",
            slice_utf16(trimmed, 80 - suffix.len()).trim_end()
        );
        n += 1;
    }
    name
}

/// `uniqueId`.
fn unique_id(base: &str, scenes: &[Scene]) -> String {
    let mut id = base.to_string();
    let mut n = 2;
    while scenes.iter().any(|scene| scene.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// `{...base, ...recalled}` as the plain built-in `preset`.
fn preset_layout(base: &Value, preset: &str, recalled: Option<&Value>) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(recalled)) = recalled {
        for (key, value) in recalled {
            merged.insert(key.clone(), value.clone());
        }
    }
    on_preset(&Value::Object(merged), preset)
}

/// A non-empty string key from a shortcuts map.
fn key_in(map: Option<&Value>, id: &str) -> Option<String> {
    string(get(map, id))
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// `migrateToScenes`' answer: the library and the shortcuts to store.
#[derive(Debug, Clone, PartialEq)]
pub struct Migrated {
    pub library: SceneLibrary,
    pub global_shortcuts: Value,
}

/// `migrateToScenes`: the v2 library for a v1 user, and their shortcuts
/// with the layout keys moved to scene keys (D15). Pure: the caller writes
/// both.
///
/// Order: the saved scenes in their order; the four default scenes with
/// today's screen, without one that equals a saved scene; the working setup
/// when it is none of them; then a scene for each 9:16 layout key that no
/// scene could take. The scene on stream is the one matching what was on,
/// and its layout in the studio's orientation and its background are the
/// working ones exactly.
pub fn migrate_to_scenes(
    v1: Option<&[SavedScene]>,
    working_scene: Option<&WorkingScene>,
    capture_config: &Value,
    global_shortcuts: Option<&Value>,
    now: &str,
    platform: Option<&str>,
) -> Result<Migrated, Invalid> {
    let saved = v1.unwrap_or_default();
    let working = match working_scene {
        Some(working) => working.visual.clone(),
        None => normalize_scene_visual(&json!({
            "layout": capture_config.get("layout").cloned().unwrap_or(Value::Null),
            "sources": capture_config.get("sources").cloned().unwrap_or(Value::Null),
            "background": null,
        }))?,
    };
    let working_layout = working.get("layout").cloned().unwrap_or(Value::Null);
    let working_background = working.get("background").cloned().unwrap_or(Value::Null);
    let working_preset = layout_preset(&working_layout).to_string();
    let orientation = Orientation::of_layout(&working_layout);
    let today = shows_from_sources(working.get("sources").unwrap_or(&Value::Null));
    // Only the saved scenes follow their app: a scene made here never
    // competes with them for "Follow the app in front".
    let today_unfollowed = today.with_follows(false);
    let framing = |preset: &str| {
        get(
            get(capture_config.get("layoutFramingMemory"), "layouts"),
            preset,
        )
    };
    let follows_program = capture_config.get("simulcastFollowsProgram") == Some(&Value::Bool(true));
    let last_vertical = string(capture_config.get("lastVerticalPreset")).unwrap_or_default();
    let last_horizontal = string(capture_config.get("lastHorizontalPreset")).unwrap_or_default();

    // A 16:9 layout's 9:16 layout: what the vertical stream shows for it
    // today when that shows the same sources, else its 9:16 twin, so a
    // "Screen + camera" is never only a camera in 9:16 (#1706). In a 9:16
    // studio no vertical leg runs, so the layout's own Fill or Fit stays.
    let leg_preset = |preset: &str| -> String {
        let streamed = if follows_program && preset == "camera-only" {
            "vertical-camera-only"
        } else if follows_program && preset == "screen-only" {
            "vertical-screen-only"
        } else {
            last_vertical
        };
        if presets_show_same_sources(preset, streamed) {
            streamed.to_string()
        } else {
            vertical_twin_preset(preset).to_string()
        }
    };
    let leg_layout = |layout: &Value| -> Value {
        let mut next = preset_layout(layout, &leg_preset(layout_preset(layout)), None);
        let framing = if orientation == Orientation::Vertical {
            layout.get("verticalScreenFraming")
        } else {
            capture_config.get("simulcastScreenFraming")
        };
        if let Value::Object(map) = &mut next {
            match framing {
                Some(value) => map.insert("verticalScreenFraming".into(), value.clone()),
                None => map.remove("verticalScreenFraming"),
            };
        }
        next
    };
    // Both layouts of a scene from the one layout v1 kept.
    let layouts_from = |layout: &Value| -> (Value, Value) {
        if Orientation::of_layout(layout) == Orientation::Vertical {
            let twin = horizontal_twin(layout_preset(layout));
            (preset_layout(layout, twin, None), layout.clone())
        } else {
            (layout.clone(), leg_layout(layout))
        }
    };

    // 1. The saved scenes, in their order. The camera device is dropped (D9).
    let mut scenes: Vec<Scene> = saved
        .iter()
        .map(|scene| {
            let layout = scene.visual.get("layout").cloned().unwrap_or(Value::Null);
            let (horizontal, vertical) = layouts_from(&layout);
            Scene {
                id: scene.id.clone(),
                name: scene.name.clone(),
                created_at: scene.created_at.clone(),
                updated_at: scene.updated_at.clone(),
                shows: shows_from_sources(scene.visual.get("sources").unwrap_or(&Value::Null)),
                horizontal,
                vertical,
                background: scene
                    .visual
                    .get("background")
                    .cloned()
                    .unwrap_or(Value::Null),
                audio: scene.audio.clone(),
                // Plan 249 S12: the room's guest roles survive the move to v2.
                cloud: scene.cloud.clone(),
            }
        })
        .collect();
    let saved_count = scenes.len();

    // 2. The four default scenes with today's screen and today's look.
    let working_scene_id = working_scene
        .and_then(|working| working.scene_id.as_deref())
        .filter(|id| !id.is_empty());
    let plain_builtin = working_scene_id.is_none()
        && working_scene.is_none_or(|working| working.origin == super::model::Origin::Builtin)
        && !layout_is_freeform(&working_layout);
    let new_user = saved.is_empty() && working_scene.is_none();
    let mut defaults: Vec<Scene> = Vec::new();
    for preset in HORIZONTAL_LAYOUT_PRESETS {
        let horizontal = if plain_builtin && preset == working_preset {
            working_layout.clone()
        } else {
            preset_layout(&working_layout, preset, framing(preset))
        };
        let vertical = leg_layout(&horizontal);
        let taken: Vec<Scene> = scenes.iter().chain(defaults.iter()).cloned().collect();
        // D3: a new user's Camera only shows no screen.
        let shows = if new_user
            && preset == "camera-only"
            && !preset_needs_screen(layout_preset(&vertical))
        {
            SceneShows::None
        } else {
            today_unfollowed.clone()
        };
        defaults.push(Scene {
            id: unique_id(&default_scene_id(preset), &taken),
            name: unique_name(&layout_preset_label(preset, false), &taken),
            created_at: now.to_string(),
            updated_at: now.to_string(),
            shows,
            horizontal,
            vertical,
            background: working_background.clone(),
            audio: None,
            cloud: None,
        });
    }

    // The scene on stream: the one matching what was on. Ids are unique
    // across the saved scenes and the defaults, so it is kept by id.
    let same_look = |scene: &Scene| {
        canonical_eq(scene.layout(orientation), &working_layout)
            && canonical_eq(&scene.background, &working_background)
    };
    let mut on_stream: Option<String> = None;
    let saved_on = working_scene_id.and_then(|id| scenes.iter().position(|scene| scene.id == id));
    if let Some(index) = saved_on {
        // The working look is what is on stream: a look that drifted from
        // its saved scene before edits saved into scenes stays on stream.
        if !same_look(&scenes[index]) {
            let scene = &mut scenes[index];
            if orientation == Orientation::Vertical {
                scene.vertical = working_layout.clone();
            } else {
                (scene.horizontal, scene.vertical) = layouts_from(&working_layout);
            }
            scene.background = working_background.clone();
        }
        on_stream = Some(scenes[index].id.clone());
    } else if plain_builtin && orientation == Orientation::Horizontal {
        on_stream = HORIZONTAL_LAYOUT_PRESETS
            .iter()
            .position(|preset| *preset == working_preset)
            .map(|index| defaults[index].id.clone());
    } else if plain_builtin {
        // A 9:16 studio on a built-in layout: the default that shows it,
        // the one the 16:9 toggle would land on first.
        let shows: Vec<usize> = (0..defaults.len())
            .filter(|&index| layout_preset(&defaults[index].vertical) == working_preset)
            .collect();
        let pick = shows
            .iter()
            .copied()
            .find(|&index| layout_preset(&defaults[index].horizontal) == last_horizontal)
            .or(shows.first().copied());
        if let Some(index) = pick {
            defaults[index].vertical = working_layout.clone();
            on_stream = Some(defaults[index].id.clone());
        }
    } else {
        on_stream = scenes
            .iter()
            .chain(defaults.iter())
            .find(|scene| same_shows(&scene.shows, &today) && same_look(scene))
            .map(|scene| scene.id.clone());
    }

    // A default equal to a saved scene (same screen, same layouts) is left
    // out, unless that would change the stream or lose a layout key.
    let mut custom_keys: Map<String, Value> = Map::new();
    if let Some(Value::Object(keys)) = get(global_shortcuts, "scenes") {
        for (id, key) in keys {
            if let Some(key) = string(Some(key)).filter(|key| !key.is_empty()) {
                custom_keys.insert(id.clone(), json!(key));
            }
        }
    }
    let layout_keys = get(global_shortcuts, "layouts");
    let custom = |keys: &Map<String, Value>, id: &str| key_in_map(keys, id);
    for (index, preset) in HORIZONTAL_LAYOUT_PRESETS.iter().enumerate() {
        let scene = defaults[index].clone();
        let key = key_in(layout_keys, preset);
        let is_on = on_stream.as_deref() == Some(scene.id.as_str());
        let equal = scenes[..saved_count].iter().find(|entry| {
            same_shows(&entry.shows, &scene.shows)
                && layout_preset(&entry.horizontal) == *preset
                && !layout_is_freeform(&entry.horizontal)
                && layout_preset(&entry.vertical) == layout_preset(&scene.vertical)
                && !layout_is_freeform(&entry.vertical)
                && (!is_on || same_look(entry))
                && (key.is_none()
                    || custom(&custom_keys, &entry.id).is_none()
                    || custom(&custom_keys, &entry.id) == key)
        });
        if let Some(equal) = equal {
            let equal_id = equal.id.clone();
            if is_on {
                on_stream = Some(equal_id.clone());
            }
            // A 16:9 layout key goes to the scene standing in for its default.
            if let Some(key) = &key {
                custom_keys.insert(equal_id, json!(key));
            }
            continue;
        }
        if let Some(key) = &key
            && custom(&custom_keys, &scene.id).is_none()
        {
            custom_keys.insert(scene.id.clone(), json!(key));
        }
        scenes.push(scene);
    }

    // 3. The working setup, when it is none of them: a Freeform
    // arrangement, or a saved scene left by a Screen pick. Named after what
    // it shows.
    let on_stream_id = match on_stream {
        Some(id) => id,
        None => {
            let (horizontal, vertical) = layouts_from(&working_layout);
            let scene = Scene {
                id: unique_id(WORKING_SCENE_ID, &scenes),
                name: unique_name(&migrated_name(&today, &working_layout), &scenes),
                created_at: now.to_string(),
                updated_at: now.to_string(),
                shows: today.clone(),
                horizontal,
                vertical,
                background: working_background.clone(),
                audio: None,
                cloud: None,
            };
            let id = scene.id.clone();
            scenes.push(scene);
            id
        }
    };

    // A 9:16 layout key goes to the first scene with that 9:16 layout that
    // has no key yet; a scene is added when there is none, so the key keeps
    // working.
    for preset in VERTICAL_LAYOUT_PRESETS {
        let Some(key) = key_in(layout_keys, preset) else {
            continue;
        };
        let found = scenes.iter().find(|entry| {
            custom(&custom_keys, &entry.id).is_none()
                && layout_preset(&entry.vertical) == preset
                && !layout_is_freeform(&entry.vertical)
        });
        let id = match found {
            Some(scene) => scene.id.clone(),
            None => {
                let twin = horizontal_twin(preset);
                let mut vertical = leg_layout(&working_layout);
                if let (Value::Object(map), Some(Value::Object(recalled))) =
                    (&mut vertical, framing(preset))
                {
                    for (key, value) in recalled {
                        map.insert(key.clone(), value.clone());
                    }
                }
                if let Value::Object(map) = &mut vertical {
                    map.insert("layoutPreset".into(), json!(preset));
                }
                let scene = Scene {
                    id: unique_id(&format!("layout-{preset}"), &scenes),
                    name: unique_name(&layout_preset_label(preset, true), &scenes),
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                    shows: today_unfollowed.clone(),
                    horizontal: preset_layout(&working_layout, twin, framing(twin)),
                    vertical,
                    background: working_background.clone(),
                    audio: None,
                    cloud: None,
                };
                let id = scene.id.clone();
                scenes.push(scene);
                id
            }
        };
        custom_keys.insert(id, json!(key));
    }

    let mut shortcuts: Map<String, Value> = global_shortcuts
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    shortcuts.remove("layouts");
    let scene_slots = settle_slot_keys(&scenes, &mut custom_keys, &shortcuts, platform);
    shortcuts.insert("scenes".into(), Value::Object(custom_keys));
    if let Some(slots) = scene_slots {
        shortcuts.insert("sceneSlots".into(), slots);
    }
    Ok(Migrated {
        // Made with each 9:16 layout showing what its 16:9 one shows:
        // nothing to repair.
        library: SceneLibrary {
            scenes,
            on_stream_id,
            pending_shortcuts: None,
            vertical_layouts_repaired: true,
        },
        global_shortcuts: Value::Object(shortcuts),
    })
}

fn key_in_map(keys: &Map<String, Value>, id: &str) -> Option<String> {
    string(keys.get(id))
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// `sceneSlotAccelerator({}, position, platform)` (`shared/global-shortcuts.ts`,
/// D5): ⌃⌥N on macOS, Ctrl+Alt+Shift+N elsewhere.
fn default_slot_accelerator(position: usize, platform: Option<&str>) -> String {
    let shift = if platform == Some("darwin") {
        ""
    } else {
        "Shift+"
    };
    format!("Control+Alt+{shift}{position}")
}

/// `normalizeAccelerator` (`shared/accelerator.ts`): one spelling per
/// binding for this platform, or none.
///
/// Plan 260: the global shortcuts are L4's (`desktop/`); this private copy
/// serves only the migration's slot-key clash rule until L4's port lands.
fn normalize_accelerator(value: &str, platform: Option<&str>) -> Option<String> {
    const ORDER: [&str; 5] = ["Cmd", "Ctrl", "Alt", "Shift", "Super"];
    let mac = platform == Some("darwin");
    let mut held: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for part in value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let modifier = match part.to_lowercase().as_str() {
            "command" | "cmd" | "commandorcontrol" | "cmdorctrl" => {
                Some(if mac { "Cmd" } else { "Ctrl" })
            }
            "control" | "ctrl" => Some("Ctrl"),
            "alt" | "option" | "altgr" => Some("Alt"),
            "shift" => Some("Shift"),
            "super" | "meta" => Some(if mac { "Cmd" } else { "Super" }),
            _ => None,
        };
        match modifier {
            Some(modifier) => held.push(modifier),
            None if key.is_none() => key = Some(accelerator_key(part)),
            None => return None,
        }
    }
    let key = key?;
    let mut parts: Vec<String> = ORDER
        .iter()
        .filter(|modifier| held.contains(modifier))
        .map(|modifier| modifier.to_string())
        .collect();
    parts.push(key);
    Some(parts.join("+"))
}

/// `keyFor`: one spelling for an accelerator's key.
fn accelerator_key(part: &str) -> String {
    const ALIASES: [(&str, &str); 18] = [
        ("backspace", "Backspace"),
        ("delete", "Delete"),
        ("down", "Down"),
        ("end", "End"),
        ("enter", "Enter"),
        ("esc", "Escape"),
        ("escape", "Escape"),
        ("home", "Home"),
        ("insert", "Insert"),
        ("left", "Left"),
        ("pagedown", "PageDown"),
        ("pageup", "PageUp"),
        ("plus", "Plus"),
        ("return", "Enter"),
        ("right", "Right"),
        ("space", "Space"),
        ("tab", "Tab"),
        ("up", "Up"),
    ];
    if part.chars().count() == 1 {
        return part.to_uppercase();
    }
    let lower = part.to_lowercase();
    if let Some((_, alias)) = ALIASES.iter().find(|(name, _)| *name == lower) {
        return alias.to_string();
    }
    // `/^f\d{1,2}$/i`.
    if let Some(digits) = lower.strip_prefix('f')
        && (1..=2).contains(&digits.len())
        && digits.chars().all(|c| c.is_ascii_digit())
    {
        return format!("F{}", digits.parse::<u32>().unwrap_or_default());
    }
    if lower.starts_with("num") {
        return lower;
    }
    part.to_string()
}

/// `settleSlotKeys`: a key moved here can be a position key's default (D5).
/// The scene at that position needs no key of its own, so it drops it; any
/// other scene keeps the key the streamer set, and that position's default
/// is released. Answers the position keys to store, or none.
fn settle_slot_keys(
    scenes: &[Scene],
    custom_keys: &mut Map<String, Value>,
    shortcuts: &Map<String, Value>,
    platform: Option<&str>,
) -> Option<Value> {
    let stored = shortcuts.get("sceneSlots").and_then(Value::as_object);
    let mut slots: Map<String, Value> = stored.cloned().unwrap_or_default();
    let mut changed = false;
    for position in 1..=9 {
        let slot = position.to_string();
        if stored.is_some_and(|stored| stored.contains_key(&slot)) {
            continue;
        }
        let slot_key =
            normalize_accelerator(&default_slot_accelerator(position, platform), platform);
        let ids: Vec<(String, String)> = custom_keys
            .iter()
            .filter_map(|(id, key)| Some((id.clone(), string(Some(key))?.to_string())))
            .collect();
        for (id, key) in ids {
            if normalize_accelerator(&key, platform) != slot_key {
                continue;
            }
            if scenes.get(position - 1).is_some_and(|scene| scene.id == id) {
                custom_keys.remove(&id);
            } else {
                slots.insert(slot.clone(), json!(""));
                changed = true;
            }
        }
    }
    changed.then_some(Value::Object(slots))
}

/// `migratedName`: what the working setup shows ("Figma", "Display 1"), or
/// its layout when that shows no screen.
fn migrated_name(shows: &SceneShows, layout: &Value) -> String {
    if !layout_shows_screen(layout) || *shows == SceneShows::None {
        return layout_preset_label(layout_preset(layout), false);
    }
    match shows {
        SceneShows::App { name, .. } => name.clone(),
        SceneShows::Window { window_name, .. } => {
            window_name.clone().unwrap_or_else(|| "Window".into())
        }
        SceneShows::Display { screen_name, .. } => {
            screen_name.clone().unwrap_or_else(|| "Display".into())
        }
        SceneShows::TestPattern => "Test pattern".into(),
        SceneShows::None => unreachable!("handled above"),
    }
}

/// `defaultScenes` (D3): a new user's four scenes. Screen + camera, Screen
/// only and Side by side show the main display, Camera only shows no
/// screen; each has its 16:9 layout and the 9:16 layout the vertical stream
/// shows for it.
pub fn default_scenes(main: Option<&MainDisplay>, now: &str) -> Vec<Scene> {
    let mut config = default_capture_config(now);
    config["sources"] = shows_sources(&display_shows(main)).to_json();
    migrate_to_scenes(None, None, &config, None, now, None)
        .map(|migrated| migrated.library.scenes)
        .unwrap_or_default()
}

/// `migrateStoredScenes`: the migration of what this profile has stored,
/// its v1 library (left alone when `read_only`, a v2 version this build
/// doesn't know), its working setup, its capture config and its shortcuts.
/// Reads only; anything that doesn't read migrates the defaults.
pub struct StoredForMigration<'a> {
    pub read_only: bool,
    /// `videorc.scene-presets.v1`.
    pub v1_library: Option<&'a Value>,
    /// `videorc.working-scene.v1`.
    pub working_scene: Option<&'a Value>,
    /// The capture config, loaded (`loadCaptureConfig`).
    pub capture_config: &'a Value,
    /// `settings.globalShortcuts`.
    pub global_shortcuts: Option<&'a Value>,
    pub now: &'a str,
    pub platform: Option<&'a str>,
}

/// `migrateStoredScenes`.
pub fn migrate_stored_scenes(stored: &StoredForMigration) -> Migrated {
    let v1 =
        (!stored.read_only).then(|| super::model::hydrate_scene_library(stored.v1_library).scenes);
    let working = super::model::hydrate_working_scene(stored.working_scene);
    migrate_to_scenes(
        v1.as_deref(),
        working.as_ref(),
        stored.capture_config,
        stored.global_shortcuts,
        stored.now,
        stored.platform,
    )
    .or_else(|_| {
        migrate_to_scenes(
            None,
            None,
            &default_capture_config(stored.now),
            None,
            stored.now,
            None,
        )
    })
    .expect("the default capture config always migrates")
}
