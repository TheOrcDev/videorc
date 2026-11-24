//! OS-global shortcuts (plan 260 S1.6s/S1.6f, from `videorc-rust`'s plan 220
//! S2.6a, caught up with Electron's plan 231 scene keys): the keys as
//! Electron main and the renderer run them, without the OS part.
//!
//! - [`GlobalShortcutsConfig`] is `settings.globalShortcuts`, the field
//!   Settings → Shortcuts writes. [`global_shortcut_entries`] lists it as
//!   `shared/global-shortcuts.ts` does: the scenes' own keys first, Hide
//!   screen on ⌃⌥H unless the streamer chose another key, the fixed actions,
//!   then the nine scene positions (⌃⌥1–9 on macOS, ⌃⌥⇧1–9 elsewhere,
//!   unless set). [`with_global_shortcut`] writes one action's key
//!   (`shared/global-shortcut-bindings.ts`).
//! - [`GlobalShortcutGate`] is `global-shortcut-lifecycle.ts`. It replaces
//!   only the app's own registrations: one bad key never removes its
//!   siblings, and a key claimed twice is refused the second time. It is
//!   also the shortcut recorder's suspend: while armed, every app-owned key
//!   is released so the recorder hears the combination instead of the OS
//!   firing it, and a config that arrives meanwhile is applied on disarm.
//! - [`registration_notice`] is the registrar's entry behind the bell
//!   (plan 250), word for word; [`unavailable_reason`] says why a Linux
//!   Wayland session can hold none.
//! - [`scene_shortcut_rows`] are Settings → Shortcuts' Scenes rows
//!   (`lib/scene-shortcuts.ts`); the scenes are the caller's (L7's list).
//!
//! The registry itself (`global-hotkey` on macOS and Windows) is the app's:
//! [`ShortcutRegistry`] is what the gate needs from it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `DEFAULT_SCREEN_HIDE_SHORTCUT`: Hide screen works out of the box.
pub const DEFAULT_SCREEN_HIDE_SHORTCUT: &str = "Control+Alt+H";

/// The settings field (`SettingsState.globalShortcuts`).
pub const SETTINGS_FIELD: &str = "globalShortcuts";

/// The actions with one fixed key each, in registration order.
pub const FIXED_ACTIONS: [&str; 9] = [
    "screen-hide-toggle",
    "record-toggle",
    "stream-toggle",
    "mic-toggle",
    "system-audio-toggle",
    "clip-mark",
    "clip-mark-long",
    "layout-next",
    "layout-previous",
];

/// `SCENE_SLOT_ACTIONS`: the nine scene positions (plan 231 D5).
pub const SCENE_SLOT_ACTIONS: [&str; 9] = [
    "scene-slot-1",
    "scene-slot-2",
    "scene-slot-3",
    "scene-slot-4",
    "scene-slot-5",
    "scene-slot-6",
    "scene-slot-7",
    "scene-slot-8",
    "scene-slot-9",
];

/// `GlobalShortcutsConfig`: every field optional, unknown fields kept so a
/// write-back loses nothing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutsConfig {
    /// Next and Previous scene (stored names kept for existing bindings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_next: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_previous: Option<String>,
    /// Migration input only: layout keys are no longer registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<BTreeMap<String, String>>,
    /// The position keys, by position ("1" to "9"). Missing uses the
    /// platform default; an empty string releases the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_slots: Option<BTreeMap<String, String>>,
    /// A scene's own key, by scene id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenes: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_toggle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_toggle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_hide_toggle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_toggle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_toggle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_mark: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_mark_long: Option<String>,
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

impl GlobalShortcutsConfig {
    /// The config inside the settings' fields (`settings.globalShortcuts ??
    /// {}`), or the empty config when the field is absent or unreadable.
    pub fn from_settings_rest(rest: &BTreeMap<String, Value>) -> Self {
        rest.get(SETTINGS_FIELD)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default()
    }

    /// The single-action key field for a fixed action.
    fn fixed_field(&mut self, action: &str) -> Option<&mut Option<String>> {
        Some(match action {
            "screen-hide-toggle" => &mut self.screen_hide_toggle,
            "record-toggle" => &mut self.record_toggle,
            "stream-toggle" => &mut self.stream_toggle,
            "mic-toggle" => &mut self.mic_toggle,
            "system-audio-toggle" => &mut self.system_audio_toggle,
            "clip-mark" => &mut self.clip_mark,
            "clip-mark-long" => &mut self.clip_mark_long,
            "layout-next" => &mut self.layout_next,
            "layout-previous" => &mut self.layout_previous,
            _ => return None,
        })
    }

    fn fixed_value(&self, action: &str) -> Option<String> {
        match action {
            "screen-hide-toggle" => self.screen_hide_toggle.clone(),
            "record-toggle" => self.record_toggle.clone(),
            "stream-toggle" => self.stream_toggle.clone(),
            "mic-toggle" => self.mic_toggle.clone(),
            "system-audio-toggle" => self.system_audio_toggle.clone(),
            "clip-mark" => self.clip_mark.clone(),
            "clip-mark-long" => self.clip_mark_long.clone(),
            "layout-next" => self.layout_next.clone(),
            "layout-previous" => self.layout_previous.clone(),
            _ => None,
        }
    }
}

/// `sceneSlotPosition`: 1 to 9 for a position action.
pub fn scene_slot_position(action: &str) -> Option<u8> {
    let position: u8 = action.strip_prefix("scene-slot-")?.parse().ok()?;
    (1..=9).contains(&position).then_some(position)
}

/// `sceneSlotAccelerator`: the position's key, or the platform default
/// (`Control+Alt+3` on macOS, `Control+Alt+Shift+3` elsewhere). An empty
/// string is a released key and stays empty.
pub fn scene_slot_accelerator(
    config: &GlobalShortcutsConfig,
    position: u8,
    platform: Option<&str>,
) -> String {
    config
        .scene_slots
        .as_ref()
        .and_then(|slots| slots.get(&position.to_string()).cloned())
        .unwrap_or_else(|| {
            let shift = if platform == Some("darwin") {
                ""
            } else {
                "Shift+"
            };
            format!("Control+Alt+{shift}{position}")
        })
}

/// `isGlobalShortcutAction`: a fixed action, a scene position, or
/// `scene:<id>` with a non-blank id of at most 128 characters.
pub fn is_global_shortcut_action(action: &str) -> bool {
    if FIXED_ACTIONS.contains(&action) || SCENE_SLOT_ACTIONS.contains(&action) {
        return true;
    }
    match action.strip_prefix("scene:") {
        Some(id) => !id.trim().is_empty() && id.encode_utf16().count() <= 128,
        None => false,
    }
}

/// `globalShortcutEntries`: every action with its key (or none), in the
/// registration order.
pub fn global_shortcut_entries(
    config: &GlobalShortcutsConfig,
    platform: Option<&str>,
) -> Vec<(String, Option<String>)> {
    let mut entries: Vec<(String, Option<String>)> = config
        .scenes
        .iter()
        .flatten()
        .map(|(id, key)| (format!("scene:{id}"), Some(key.clone())))
        .collect();
    entries.push((
        "screen-hide-toggle".to_string(),
        Some(
            config
                .screen_hide_toggle
                .clone()
                .unwrap_or_else(|| DEFAULT_SCREEN_HIDE_SHORTCUT.to_string()),
        ),
    ));
    for action in &FIXED_ACTIONS[1..] {
        entries.push((action.to_string(), config.fixed_value(action)));
    }
    for (index, action) in SCENE_SLOT_ACTIONS.iter().enumerate() {
        let position = index as u8 + 1;
        entries.push((
            action.to_string(),
            Some(scene_slot_accelerator(config, position, platform)),
        ));
    }
    entries
}

/// `withGlobalShortcut`: the config with one action's key replaced (an empty
/// string releases it). A scene's key stays with its id; a position's with
/// its position.
pub fn with_global_shortcut(
    config: &GlobalShortcutsConfig,
    action: &str,
    accelerator: &str,
) -> GlobalShortcutsConfig {
    let mut next = config.clone();
    if let Some(id) = action.strip_prefix("scene:") {
        next.scenes
            .get_or_insert_with(BTreeMap::new)
            .insert(id.to_string(), accelerator.to_string());
    } else if let Some(position) = scene_slot_position(action) {
        next.scene_slots
            .get_or_insert_with(BTreeMap::new)
            .insert(position.to_string(), accelerator.to_string());
    } else if let Some(field) = next.fixed_field(action) {
        *field = Some(accelerator.to_string());
    }
    next
}

/// `withoutSceneShortcut`: a deleted scene releases its key; renaming never
/// changes an id's binding.
pub fn without_scene_shortcut(config: &GlobalShortcutsConfig, id: &str) -> GlobalShortcutsConfig {
    let mut next = config.clone();
    let mut scenes = next.scenes.take().unwrap_or_default();
    scenes.remove(id);
    next.scenes = Some(scenes);
    next
}

/// What the gate needs from the OS's registry.
pub trait ShortcutRegistry {
    /// Registers `accelerator` for `action`; false when the OS (or the
    /// registry) refuses it, Err when the key cannot be read at all.
    fn register(&mut self, accelerator: &str, action: &str) -> Result<bool, String>;
    fn unregister(&mut self, accelerator: &str);
}

/// `GlobalShortcutsResult`: what one apply did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutsResult {
    /// Each requested action: true when its key is registered now.
    pub registered: BTreeMap<String, bool>,
    /// The recorder is armed: nothing registered; the config is applied on
    /// disarm, and this result says nothing about conflicts.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deferred: bool,
    /// This session can hold no global shortcut, and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
}

/// `replaceGlobalShortcutBindings`: unregisters every app-owned key, then
/// registers the requested ones; a key claimed twice (in any case) is
/// refused the second time, and one key's failure never stops the rest.
pub fn replace_bindings(
    registry: &mut impl ShortcutRegistry,
    owned: &mut BTreeSet<String>,
    requested: &[(String, Option<String>)],
) -> BTreeMap<String, bool> {
    for accelerator in owned.iter() {
        registry.unregister(accelerator);
    }
    owned.clear();
    let mut registered = BTreeMap::new();
    let mut claimed = BTreeSet::new();
    for (action, value) in requested {
        let accelerator = value.as_deref().map(str::trim).unwrap_or_default();
        if accelerator.is_empty() {
            continue;
        }
        let key = accelerator.to_lowercase();
        let ok =
            !claimed.contains(&key) && registry.register(accelerator, action).unwrap_or_default();
        registered.insert(action.clone(), ok);
        if ok {
            owned.insert(accelerator.to_string());
            claimed.insert(key);
        }
    }
    registered
}

/// `GlobalShortcutGate`: Videorc's global registrations and the Settings
/// shortcut recorder's suspend (plan 062).
#[derive(Debug)]
pub struct GlobalShortcutGate<R: ShortcutRegistry> {
    registry: R,
    armed: bool,
    requested: Vec<(String, Option<String>)>,
    owned: BTreeSet<String>,
    unavailable: Option<String>,
}

impl<R: ShortcutRegistry> GlobalShortcutGate<R> {
    /// `unavailable` keeps every key off the registry and is answered in
    /// place of a registration result.
    pub fn new(registry: R, unavailable: Option<String>) -> Self {
        Self {
            registry,
            armed: false,
            requested: Vec::new(),
            owned: BTreeSet::new(),
            unavailable,
        }
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// The keys registered now.
    pub fn owned(&self) -> &BTreeSet<String> {
        &self.owned
    }

    pub fn registry(&self) -> &R {
        &self.registry
    }

    pub fn registry_mut(&mut self) -> &mut R {
        &mut self.registry
    }

    /// The config the gate holds: registered now, or on disarm.
    pub fn requested(&self) -> &[(String, Option<String>)] {
        &self.requested
    }

    pub fn apply(&mut self, requested: Vec<(String, Option<String>)>) -> GlobalShortcutsResult {
        self.requested = requested;
        if self.armed {
            return GlobalShortcutsResult {
                deferred: true,
                ..GlobalShortcutsResult::default()
            };
        }
        let requested = self.requested.clone();
        self.replace(&requested)
    }

    /// Releases every app-owned key. Idempotent.
    pub fn arm(&mut self) {
        if self.armed {
            return;
        }
        self.armed = true;
        self.replace(&[]);
    }

    /// Registers the latest requested config again; `None` when it was not
    /// armed.
    pub fn disarm(&mut self) -> Option<GlobalShortcutsResult> {
        if !self.armed {
            return None;
        }
        self.armed = false;
        let requested = self.requested.clone();
        Some(self.replace(&requested))
    }

    /// Releases everything at quit (`unregisterGlobalShortcutsWhenReady`).
    pub fn release_all(&mut self) {
        for accelerator in std::mem::take(&mut self.owned) {
            self.registry.unregister(&accelerator);
        }
    }

    fn replace(&mut self, requested: &[(String, Option<String>)]) -> GlobalShortcutsResult {
        if let Some(reason) = &self.unavailable {
            return GlobalShortcutsResult {
                unavailable: Some(reason.clone()),
                ..GlobalShortcutsResult::default()
            };
        }
        GlobalShortcutsResult {
            registered: replace_bindings(&mut self.registry, &mut self.owned, requested),
            ..GlobalShortcutsResult::default()
        }
    }
}

/// `globalShortcutsUnavailableReason`: Linux under Wayland gives no app a key
/// grab, so the keys could never fire; X11, macOS and Windows hold them.
pub fn unavailable_reason(linux: bool, wayland: bool) -> Option<&'static str> {
    (linux && wayland).then_some(
        "Global shortcuts can't work in this Wayland session: Wayland doesn't let an app hear keys while it is in the background. App shortcuts still work while Videorc is in front, and Phone remote works while it is in the background.",
    )
}

/// `RECORD_SHORTCUT_LABEL` and `GO_LIVE_SHORTCUT_LABEL` (`go-live-copy.ts`).
pub const RECORD_SHORTCUT_LABEL: &str = "Record / stop recording";
pub const GO_LIVE_SHORTCUT_LABEL: &str = "Go Live / end livestream";

/// `globalShortcutLabel`: what a global shortcut does, in words, never its
/// id (plan 174 A-22). A position reads "Scene 3"; a scene's own key names
/// the scene where the caller has its list ([`scene_shortcut_rows`]).
pub fn global_shortcut_label(action: &str) -> String {
    if !is_global_shortcut_action(action) {
        return action.to_string();
    }
    if let Some(position) = scene_slot_position(action) {
        return format!("Scene {position}");
    }
    match action {
        "screen-hide-toggle" => "Hide screen",
        "record-toggle" => RECORD_SHORTCUT_LABEL,
        "stream-toggle" => GO_LIVE_SHORTCUT_LABEL,
        "mic-toggle" => "Mute / unmute microphone",
        "system-audio-toggle" => "Turn system audio on or off",
        "clip-mark" => "Save a 30-second clip",
        "clip-mark-long" => "Save a 1-minute clip",
        "layout-next" => "Next scene",
        "layout-previous" => "Previous scene",
        other => other,
    }
    .to_string()
}

/// What the registrar puts behind the bell after an apply (plan 250).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationNotice {
    /// `publishGlobalShortcutsProblem`, open until a later registration
    /// takes every key.
    Problem { title: String, description: String },
    /// Every key registered: the problem is over.
    Resolve,
    /// Nothing can register here and nothing the streamer set is left to
    /// warn about.
    Withdraw,
}

/// The registration failed at the boundary itself: the streamer's keys
/// silently not working is the one thing this must never do quietly.
pub const REGISTRATION_BROKE_TITLE: &str = "Global shortcuts didn't register";
pub const REGISTRATION_BROKE_DESCRIPTION: &str = "Restart Videorc if they still don't work.";

/// `GlobalShortcutsRegistrar`'s answer to a result. `None` while the
/// recorder holds the config (the next sync learns the real outcome).
pub fn registration_notice(
    config: &GlobalShortcutsConfig,
    result: &GlobalShortcutsResult,
) -> Option<RegistrationNotice> {
    if result.deferred {
        return None;
    }
    if let Some(reason) = &result.unavailable {
        // Keys someone set would otherwise do nothing without a word; with
        // only the default Hide screen and position keys, Settings says it.
        let user_set = GlobalShortcutsConfig {
            screen_hide_toggle: Some(config.screen_hide_toggle.clone().unwrap_or_default()),
            ..config.clone()
        };
        let set_any = global_shortcut_entries(&user_set, None)
            .iter()
            .any(|(action, value)| {
                let set = value.as_deref().is_some_and(|key| !key.trim().is_empty());
                set && match scene_slot_position(action) {
                    None => true,
                    Some(position) => config
                        .scene_slots
                        .as_ref()
                        .is_some_and(|slots| slots.contains_key(&position.to_string())),
                }
            });
        return Some(if set_any {
            RegistrationNotice::Problem {
                title: "Global shortcuts don't work here".into(),
                description: reason.clone(),
            }
        } else {
            RegistrationNotice::Withdraw
        });
    }
    let failed: Vec<&str> = result
        .registered
        .iter()
        .filter(|(_, ok)| !**ok)
        .map(|(action, _)| action.as_str())
        .collect();
    if failed.is_empty() {
        return Some(RegistrationNotice::Resolve);
    }
    let title = if failed.len() == 1 {
        "A global shortcut didn't register"
    } else {
        "Some global shortcuts didn't register"
    };
    let names: Vec<String> = failed
        .iter()
        .map(|action| global_shortcut_label(action))
        .collect();
    let pronoun = if failed.len() == 1 { "it" } else { "them" };
    Some(RegistrationNotice::Problem {
        title: title.into(),
        description: format!(
            "{}: another app uses {pronoun}, or the keys are taken twice. Choose different keys in Settings → Shortcuts.",
            names.join(", ")
        ),
    })
}

/// One of Settings → Shortcuts' Scenes rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneShortcutRow {
    pub action: String,
    pub label: String,
    pub accelerator: String,
}

/// `sceneShortcutRows`: all nine positions ("Scene 1 · Intro", or "· no
/// scene"), then the custom keys that belong to a scene. `scenes` is the
/// saved scenes in order, as (id, name).
pub fn scene_shortcut_rows(
    scenes: &[(String, String)],
    config: &GlobalShortcutsConfig,
    platform: Option<&str>,
) -> Vec<SceneShortcutRow> {
    let mut rows: Vec<SceneShortcutRow> = SCENE_SLOT_ACTIONS
        .iter()
        .enumerate()
        .map(|(index, action)| SceneShortcutRow {
            action: action.to_string(),
            label: format!(
                "Scene {} · {}",
                index + 1,
                scenes
                    .get(index)
                    .map_or("no scene", |(_, name)| name.as_str())
            ),
            accelerator: scene_slot_accelerator(config, index as u8 + 1, platform),
        })
        .collect();
    for (id, name) in scenes {
        let custom = config.scenes.as_ref().and_then(|keys| keys.get(id));
        if let Some(accelerator) = custom.filter(|key| !key.trim().is_empty()) {
            rows.push(SceneShortcutRow {
                action: format!("scene:{id}"),
                label: name.clone(),
                accelerator: accelerator.clone(),
            });
        }
    }
    rows
}

/// `sceneShortcutBindings`: a scene card's keys. Its position key moves on
/// reorder; its custom key stays with its id.
pub fn scene_shortcut_bindings(
    scene_id: &str,
    position: usize,
    config: &GlobalShortcutsConfig,
    platform: Option<&str>,
) -> Vec<(String, String)> {
    let mut bindings = Vec::new();
    if (1..=9).contains(&position) {
        let accelerator = scene_slot_accelerator(config, position as u8, platform);
        if !accelerator.trim().is_empty() {
            bindings.push((SCENE_SLOT_ACTIONS[position - 1].to_string(), accelerator));
        }
    }
    let custom = config.scenes.as_ref().and_then(|keys| keys.get(scene_id));
    if let Some(custom) = custom.filter(|key| !key.trim().is_empty()) {
        bindings.push((format!("scene:{scene_id}"), custom.clone()));
    }
    bindings
}

/// `GLOBAL_ACTION_ROWS` (`shortcuts-settings.tsx`): Settings → Shortcuts'
/// action rows.
pub const GLOBAL_ACTION_ROWS: [&str; 9] = FIXED_ACTIONS;

/// `globalShortcutRows`: the rows this computer can act on. System audio
/// has no producer on Linux, so its row shows only where it is available,
/// or when a key saved elsewhere is bound, so it can be cleared.
pub fn global_shortcut_rows(
    system_audio_available: bool,
    system_audio_bound: bool,
) -> Vec<&'static str> {
    GLOBAL_ACTION_ROWS
        .into_iter()
        .filter(|action| {
            *action != "system-audio-toggle" || system_audio_available || system_audio_bound
        })
        .collect()
}

#[cfg(test)]
mod tests;
