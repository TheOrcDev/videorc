//! Plan 231 D2, D8: one list of scenes, in library order (`lib/scene-list.ts`,
//! `lib/scene-shortcuts.ts`, `lib/scene-shortcut-walk.ts`). A new scene goes
//! at the end; a drag, or ⌥← ⌥→ on a card and ⌥↑ ⌥↓ on a row, moves one.
//! A scene is always on stream. Studio's Scenes section (cards), the Scene
//! page (rows), Next scene and Previous scene follow the same order.
//!
//! The v1 Scene page videorc-rust ported (the Unsaved scene row, the Layouts
//! group, Save scene…, `sceneShows`) is gone from Electron, and so from here.

use std::collections::HashMap;

use serde_json::Value;
use videorc_protocol::Device;

use super::model::{NamedScene, SavedScene, SceneAudio, scene_source_problems};
use super::section::scene_slot_accelerator;
use super::v2::{Scene, layout_shows_screen, scene_at_position};
use super::window::{SceneAppState, app_window_failure_copy};
use crate::studio::js_value::{get, string};

/// The keys a row answers to move (WCAG 2.1.1: never only by dragging).
pub const MOVE_SCENE_UP_ACCELERATOR: &str = "Alt+Up";
pub const MOVE_SCENE_DOWN_ACCELERATOR: &str = "Alt+Down";
/// The keys a card in Studio's grid answers to move (D8).
pub const MOVE_SCENE_LEFT_ACCELERATOR: &str = "Alt+Left";
pub const MOVE_SCENE_RIGHT_ACCELERATOR: &str = "Alt+Right";

/// A key press, as the move keys read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveKey<'a> {
    /// The DOM `key` (`ArrowUp`, `ArrowLeft`, …).
    pub key: &'a str,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
}

/// Rows move up and down; cards in a row move left and right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveAxis {
    Vertical,
    Horizontal,
}

/// `sceneMoveKeyStep`: ⌥↑ or ⌥↓ alone on a focused row (⌥← or ⌥→ on a
/// card): the step, else none.
pub fn scene_move_key_step(event: MoveKey, axis: MoveAxis) -> Option<i32> {
    if !event.alt || event.ctrl || event.meta || event.shift {
        return None;
    }
    let (back, forward) = match axis {
        MoveAxis::Horizontal => ("ArrowLeft", "ArrowRight"),
        MoveAxis::Vertical => ("ArrowUp", "ArrowDown"),
    };
    if event.key == back {
        Some(-1)
    } else if event.key == forward {
        Some(1)
    } else {
        None
    }
}

/// `SceneGlyph`: the row's icon, the app's own or a glyph for what the scene
/// shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneGlyph {
    App { bundle_id: String },
    Window,
    Display,
    Camera,
}

/// `sceneGlyph`: a fixed window shows its app's icon when the device list
/// knows the app. `visual` is the v1-shaped visual.
pub fn scene_glyph(visual: &Value, devices: &[Device]) -> SceneGlyph {
    let sources = visual.get("sources");
    if !layout_shows_screen(visual.get("layout").unwrap_or(&Value::Null)) {
        return SceneGlyph::Camera;
    }
    if let Some(app) = get(sources, "app").filter(|app| app.is_object()) {
        return SceneGlyph::App {
            bundle_id: string(app.get("bundleId")).unwrap_or_default().to_string(),
        };
    }
    if let Some(window_id) = string(get(sources, "windowId")).filter(|id| !id.is_empty()) {
        let bundle_id = devices
            .iter()
            .find(|device| device.id == window_id)
            .and_then(|device| device.app.as_ref())
            .map(|app| app.bundle_id.clone());
        return match bundle_id {
            Some(bundle_id) => SceneGlyph::App { bundle_id },
            None => SceneGlyph::Window,
        };
    }
    SceneGlyph::Display
}

/// `savedSceneBlockedReason`: why a scene can't go on stream now, or none.
/// An app that isn't ready says so ("Figma isn't open"). Every scene has a
/// layout for each orientation (D4), so none waits for the take to end. A
/// scene made for an app never asks for its window to be resolved, so a
/// camera it needs and can't use is said here too.
pub fn saved_scene_blocked_reason(
    visual: &Value,
    app_state: Option<SceneAppState>,
    devices: &[Device],
) -> Option<String> {
    let app = get(visual.get("sources"), "app").filter(|app| app.is_object())?;
    if let Some(SceneAppState::Failed(failure)) = app_state {
        return Some(app_window_failure_copy(
            string(app.get("name")).unwrap_or_default(),
            failure,
        ));
    }
    // For an app's scene, the problems are its camera's alone (the switch
    // resolves the app).
    scene_source_problems(visual, devices)
        .first()
        .map(|problem| problem.to_string())
}

/// `uniqueSceneName`: "Figma", then "Figma 2" while taken, within the
/// 80-character limit.
pub fn unique_scene_name<S: NamedScene>(
    base: &str,
    scenes: &[S],
    except_id: Option<&str>,
) -> String {
    let taken: Vec<String> = scenes
        .iter()
        .filter(|scene| Some(scene.scene_id()) != except_id)
        .map(|scene| scene.scene_name().to_lowercase())
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

/// `duplicatedScene` (D6): "another one like this", both layouts, its
/// screen, background and audio, under "{name} 2". It goes at the end like
/// every new scene (D5), and its keys stay with the original.
pub fn duplicated_scene(scene: &Scene, scenes: &[Scene], id: &str, now: &str) -> Scene {
    Scene {
        id: id.to_string(),
        name: unique_scene_name(&scene.name, scenes, None),
        created_at: now.to_string(),
        updated_at: now.to_string(),
        ..scene.clone()
    }
}

/// `sceneWithFollow` (D10): Stop following / Follow the app, on the row's
/// v1-shaped view; only scenes made for an app follow. The same scene when
/// nothing changes.
pub fn scene_with_follow(scene: &SavedScene, follows: bool, now: &str) -> SavedScene {
    let Some(app) = scene.app() else {
        return scene.clone();
    };
    if app.get("follows") == Some(&Value::Bool(follows)) {
        return scene.clone();
    }
    let mut next = scene.clone();
    next.visual["sources"]["app"]["follows"] = Value::Bool(follows);
    next.updated_at = now.to_string();
    next
}

/// `sceneWithAudio` (D4): Save audio to scene, the microphone and System
/// audio it switches to from now on.
pub fn scene_with_audio(scene: &SavedScene, audio: SceneAudio, now: &str) -> SavedScene {
    SavedScene {
        audio: Some(audio),
        updated_at: now.to_string(),
        ..scene.clone()
    }
}

// ── keys (`lib/scene-shortcuts.ts`) ──────────────────────────────────────

/// One shortcut row or binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneShortcut {
    /// `scene-slot-N` or `scene:<id>`.
    pub action: String,
    pub label: String,
    pub accelerator: String,
}

fn custom_key(config: Option<&Value>, id: &str) -> Option<String> {
    string(get(get(config, "scenes"), id))
        .filter(|key| !key.trim().is_empty())
        .map(str::to_string)
}

/// `sceneShortcutRows`: Settings lists all nine positions, then the custom
/// keys that belong to a scene.
pub fn scene_shortcut_rows<S: NamedScene>(
    scenes: &[S],
    config: Option<&Value>,
    platform: Option<&str>,
) -> Vec<SceneShortcut> {
    let mut rows: Vec<SceneShortcut> = (1..=9)
        .map(|position| SceneShortcut {
            action: format!("scene-slot-{position}"),
            label: format!(
                "Scene {position} · {}",
                scene_at_position(scenes, position).map_or("no scene", |scene| scene.scene_name())
            ),
            accelerator: scene_slot_accelerator(config, position, platform),
        })
        .collect();
    for scene in scenes {
        if let Some(accelerator) = custom_key(config, scene.scene_id()) {
            rows.push(SceneShortcut {
                action: format!("scene:{}", scene.scene_id()),
                label: scene.scene_name().to_string(),
                accelerator,
            });
        }
    }
    rows
}

/// `sceneShortcutBindings`: a card's position key moves on reorder; its
/// custom key stays with its id. `label` is the scene's name.
pub fn scene_shortcut_bindings(
    scene_id: &str,
    position: usize,
    config: Option<&Value>,
    platform: Option<&str>,
) -> Vec<(String, String)> {
    let mut bindings = Vec::new();
    if (1..=9).contains(&position) {
        let accelerator = scene_slot_accelerator(config, position, platform);
        if !accelerator.trim().is_empty() {
            bindings.push((format!("scene-slot-{position}"), accelerator));
        }
    }
    if let Some(custom) = custom_key(config, scene_id) {
        bindings.push((format!("scene:{scene_id}"), custom));
    }
    bindings
}

/// `nextEligibleScene` (`lib/scene-shortcut-walk.ts`): Next and Previous
/// walk library order only. Unavailable scenes keep their place and are
/// skipped. `current` and the answer are `scene:<id>` actions.
pub fn next_eligible_scene<S: NamedScene>(
    current: &str,
    forward: bool,
    scenes: &[S],
    app_states: &HashMap<String, SceneAppState>,
    unavailable: &[String],
) -> Option<String> {
    let catalog: Vec<String> = scenes
        .iter()
        .map(|scene| format!("scene:{}", scene.scene_id()))
        .collect();
    let eligible = |index: usize| {
        let id = scenes[index].scene_id();
        !unavailable.iter().any(|gone| gone == id)
            && app_states
                .get(id)
                .is_none_or(|state| *state == SceneAppState::Ready)
    };
    let len = catalog.len() as isize;
    let direction: isize = if forward { 1 } else { -1 };
    let start = match catalog.iter().position(|action| action == current) {
        Some(index) => index as isize,
        None if forward => -1,
        None => 0,
    };
    for step in 1..=len {
        let index = ((start + direction * step + len) % len) as usize;
        if catalog[index] != current && eligible(index) {
            return Some(catalog[index].clone());
        }
    }
    None
}

#[cfg(test)]
#[path = "list_tests.rs"]
mod tests;
