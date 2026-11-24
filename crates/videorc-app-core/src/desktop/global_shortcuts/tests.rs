//! `global-shortcut-lifecycle.test.ts`, `global-shortcuts.test.ts`,
//! `scene-shortcuts.test.ts` and the registrar's notices.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;

use super::*;

/// A registry that refuses "Conflict" and "Taken", cannot read "Invalid",
/// and remembers what is active.
#[derive(Debug, Default)]
struct FakeRegistry {
    active: BTreeMap<String, String>,
    foreign: BTreeSet<String>,
    registers: usize,
    unregisters: Vec<String>,
}

impl ShortcutRegistry for FakeRegistry {
    fn register(&mut self, accelerator: &str, action: &str) -> Result<bool, String> {
        self.registers += 1;
        match accelerator {
            "Invalid" => Err("unreadable".to_string()),
            "Conflict" | "Taken" => Ok(false),
            _ => {
                self.active
                    .insert(accelerator.to_string(), action.to_string());
                Ok(true)
            }
        }
    }

    fn unregister(&mut self, accelerator: &str) {
        self.unregisters.push(accelerator.to_string());
        self.active.remove(accelerator);
    }
}

impl FakeRegistry {
    fn keys(&self) -> Vec<String> {
        self.active
            .keys()
            .chain(self.foreign.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

fn entry(action: &str, key: &str) -> (String, Option<String>) {
    (action.to_string(), Some(key.to_string()))
}

fn config(value: serde_json::Value) -> GlobalShortcutsConfig {
    serde_json::from_value(value).unwrap()
}

#[test]
fn unregisters_owned_keys_skips_blank_fields_and_reports_each_conflict_independently() {
    let mut registry = FakeRegistry::default();
    let mut owned = BTreeSet::from(["Control+Old".to_string()]);
    let registered = replace_bindings(
        &mut registry,
        &mut owned,
        &[
            entry("layout-next", "Control+Next"),
            entry("layout-previous", "control+next"),
            entry("scene-slot-2", "Conflict"),
            entry("mic-toggle", "Invalid"),
            entry("stream-toggle", "  "),
            ("clip-mark".to_string(), None),
            entry("record-toggle", "Control+Record"),
        ],
    );
    assert_eq!(registry.unregisters, ["Control+Old"]);
    assert_eq!(
        registered,
        BTreeMap::from([
            ("layout-next".to_string(), true),
            ("layout-previous".to_string(), false),
            ("scene-slot-2".to_string(), false),
            ("mic-toggle".to_string(), false),
            ("record-toggle".to_string(), true),
        ])
    );
    assert_eq!(registry.active["Control+Next"], "layout-next");
    replace_bindings(&mut registry, &mut owned, &[]);
    assert!(owned.is_empty());
    assert!(registry.unregisters.contains(&"Control+Record".to_string()));
}

#[test]
fn releases_only_app_owned_keys_while_armed_and_restores_exactly_the_last_config() {
    let registry = FakeRegistry {
        foreign: BTreeSet::from(["Other+App".to_string()]),
        ..FakeRegistry::default()
    };
    let mut gate = GlobalShortcutGate::new(registry, None);
    gate.apply(vec![
        entry("record-toggle", "Cmd+Shift+R"),
        entry("mic-toggle", "Cmd+Shift+M"),
    ]);
    assert_eq!(
        gate.registry().keys(),
        ["Cmd+Shift+M", "Cmd+Shift+R", "Other+App"]
    );
    gate.arm();
    assert!(gate.is_armed());
    assert_eq!(gate.registry().keys(), ["Other+App"]);
    let restored = gate.disarm().unwrap();
    assert_eq!(
        restored.registered,
        BTreeMap::from([
            ("mic-toggle".to_string(), true),
            ("record-toggle".to_string(), true)
        ])
    );
    assert_eq!(
        gate.registry().keys(),
        ["Cmd+Shift+M", "Cmd+Shift+R", "Other+App"]
    );
}

#[test]
fn defers_a_config_change_made_while_armed_and_applies_it_on_disarm() {
    let mut gate = GlobalShortcutGate::new(FakeRegistry::default(), None);
    gate.apply(vec![entry("record-toggle", "Cmd+Shift+R")]);
    gate.arm();
    let held = gate.apply(vec![entry("record-toggle", "Cmd+Shift+X")]);
    assert!(held.deferred);
    assert!(held.registered.is_empty());
    assert!(gate.registry().active.is_empty());
    gate.disarm();
    assert_eq!(gate.registry().keys(), ["Cmd+Shift+X"]);
}

#[test]
fn treats_a_double_arm_or_double_disarm_as_a_no_op() {
    let mut gate = GlobalShortcutGate::new(FakeRegistry::default(), None);
    gate.apply(vec![entry("record-toggle", "Cmd+Shift+R")]);
    gate.arm();
    gate.arm();
    assert!(gate.registry().active.is_empty());
    assert!(gate.disarm().is_some());
    assert!(gate.disarm().is_none());
    assert_eq!(gate.registry().registers, 2);
    assert_eq!(gate.registry().keys(), ["Cmd+Shift+R"]);
}

#[test]
fn registers_nothing_through_the_recorder_too_and_says_why() {
    let mut gate =
        GlobalShortcutGate::new(FakeRegistry::default(), Some("No key grab here.".into()));
    let result = gate.apply(vec![entry("record-toggle", "Control+Shift+R")]);
    assert_eq!(result.unavailable.as_deref(), Some("No key grab here."));
    assert!(result.registered.is_empty());
    gate.arm();
    assert!(
        gate.apply(vec![entry("record-toggle", "Control+Shift+X")])
            .deferred
    );
    let disarmed = gate.disarm().unwrap();
    assert_eq!(disarmed.unavailable.as_deref(), Some("No key grab here."));
    assert_eq!(gate.registry().registers, 0);
    assert!(gate.registry().unregisters.is_empty());
}

#[test]
fn names_wayland_as_the_reason_only_on_linux() {
    assert!(
        unavailable_reason(true, true)
            .unwrap()
            .contains("Wayland session")
    );
    assert_eq!(unavailable_reason(true, false), None);
    assert_eq!(unavailable_reason(false, true), None);
}

#[test]
fn release_all_unregisters_every_owned_key() {
    let mut gate = GlobalShortcutGate::new(FakeRegistry::default(), None);
    gate.apply(vec![
        entry("record-toggle", "Cmd+Shift+R"),
        entry("screen-hide-toggle", "Control+Alt+H"),
    ]);
    gate.release_all();
    assert!(gate.owned().is_empty());
    assert!(gate.registry().active.is_empty());
}

#[test]
fn the_entries_put_scenes_first_then_hide_screen_the_actions_and_the_nine_positions() {
    let config = config(json!({
        "recordToggle": "Cmd+Shift+R",
        "scenes": { "abc": "Cmd+1" },
        "layouts": { "camera-only": "Cmd+2" },
        "sceneSlots": { "2": "F14", "3": "" },
        "somethingNew": true
    }));
    let entries = global_shortcut_entries(&config, Some("darwin"));
    assert_eq!(entries[0], entry("scene:abc", "Cmd+1"));
    assert_eq!(entries[1], entry("screen-hide-toggle", "Control+Alt+H"));
    assert_eq!(entries[2], entry("record-toggle", "Cmd+Shift+R"));
    assert_eq!(entries.len(), 1 + 9 + 9);
    // Layout keys are migration input only: never registered.
    assert!(
        entries
            .iter()
            .all(|(action, _)| !action.starts_with("layout:"))
    );
    assert_eq!(entries[10], entry("scene-slot-1", "Control+Alt+1"));
    assert_eq!(entries[11], entry("scene-slot-2", "F14"));
    assert_eq!(entries[12], entry("scene-slot-3", ""));
    assert!(
        entries
            .iter()
            .all(|(action, _)| is_global_shortcut_action(action))
    );
    assert_eq!(config.rest["somethingNew"], true);
    let windows = global_shortcut_entries(&config, Some("win32"));
    assert_eq!(windows[10], entry("scene-slot-1", "Control+Alt+Shift+1"));

    // An emptied Hide screen key is the streamer's choice: no default.
    let chosen = GlobalShortcutsConfig {
        screen_hide_toggle: Some(String::new()),
        ..GlobalShortcutsConfig::default()
    };
    assert_eq!(
        global_shortcut_entries(&chosen, None)[0],
        entry("screen-hide-toggle", "")
    );

    let rest = BTreeMap::from([(SETTINGS_FIELD.to_string(), json!({ "micToggle": "F9" }))]);
    assert_eq!(
        GlobalShortcutsConfig::from_settings_rest(&rest)
            .mic_toggle
            .as_deref(),
        Some("F9")
    );
    assert_eq!(
        GlobalShortcutsConfig::from_settings_rest(&BTreeMap::new()),
        GlobalShortcutsConfig::default()
    );
}

#[test]
fn validates_actions_like_the_renderer() {
    assert!(is_global_shortcut_action("record-toggle"));
    assert!(is_global_shortcut_action("scene-slot-9"));
    assert!(!is_global_shortcut_action("scene-slot-10"));
    assert!(!is_global_shortcut_action("layout:screen-only"));
    assert!(is_global_shortcut_action("scene:x"));
    assert!(!is_global_shortcut_action("scene: "));
    assert!(!is_global_shortcut_action(&format!(
        "scene:{}",
        "a".repeat(129)
    )));
    assert!(!is_global_shortcut_action("reload"));
    assert_eq!(scene_slot_position("scene-slot-4"), Some(4));
    assert_eq!(scene_slot_position("scene-slot-0"), None);
    assert_eq!(scene_slot_position("record-toggle"), None);
}

#[test]
fn writes_one_actions_key_and_releases_a_deleted_scenes() {
    let empty = GlobalShortcutsConfig::default();
    let record = with_global_shortcut(&empty, "record-toggle", "Cmd+R");
    assert_eq!(record.record_toggle.as_deref(), Some("Cmd+R"));
    let slot = with_global_shortcut(&record, "scene-slot-3", "");
    assert_eq!(slot.scene_slots.unwrap()["3"], "");
    let scene = with_global_shortcut(&record, "scene:abc", "F13");
    assert_eq!(scene.scenes.as_ref().unwrap()["abc"], "F13");
    assert_eq!(scene.record_toggle.as_deref(), Some("Cmd+R"));
    let gone = without_scene_shortcut(&scene, "abc");
    assert!(gone.scenes.unwrap().is_empty());
    // An unknown action changes nothing.
    assert_eq!(with_global_shortcut(&empty, "reload", "F1"), empty);
}

#[test]
fn labels_say_what_a_key_does() {
    assert_eq!(
        global_shortcut_label("record-toggle"),
        "Record / stop recording"
    );
    assert_eq!(
        global_shortcut_label("stream-toggle"),
        "Go Live / end livestream"
    );
    assert_eq!(global_shortcut_label("scene-slot-3"), "Scene 3");
    assert_eq!(global_shortcut_label("layout-next"), "Next scene");
    assert_eq!(global_shortcut_label("reload"), "reload");
    assert_eq!(global_shortcut_label("scene:abc"), "scene:abc");
}

#[test]
fn the_registrar_says_what_failed_or_resolves() {
    let none = GlobalShortcutsConfig::default();
    let mut result = GlobalShortcutsResult::default();
    result.registered.insert("record-toggle".to_string(), true);
    assert_eq!(
        registration_notice(&none, &result),
        Some(RegistrationNotice::Resolve)
    );
    result.registered.insert("mic-toggle".to_string(), false);
    assert_eq!(
        registration_notice(&none, &result),
        Some(RegistrationNotice::Problem {
            title: "A global shortcut didn't register".into(),
            description: "Mute / unmute microphone: another app uses it, or the keys are taken twice. Choose different keys in Settings → Shortcuts.".into(),
        })
    );
    result.registered.insert("clip-mark".to_string(), false);
    let Some(RegistrationNotice::Problem { title, description }) =
        registration_notice(&none, &result)
    else {
        panic!("a problem");
    };
    assert_eq!(title, "Some global shortcuts didn't register");
    assert!(
        description
            .starts_with("Save a 30-second clip, Mute / unmute microphone: another app uses them"),
        "{description}"
    );
    result.deferred = true;
    assert_eq!(registration_notice(&none, &result), None);
}

#[test]
fn on_wayland_it_warns_only_about_keys_someone_set() {
    let unavailable = GlobalShortcutsResult {
        unavailable: Some("No key grab here.".into()),
        ..GlobalShortcutsResult::default()
    };
    // Only the defaults (Hide screen, the positions): nothing to say.
    assert_eq!(
        registration_notice(&GlobalShortcutsConfig::default(), &unavailable),
        Some(RegistrationNotice::Withdraw)
    );
    let set_slot = config(json!({ "sceneSlots": { "1": "F13" } }));
    let set_record = config(json!({ "recordToggle": "Control+Shift+R" }));
    let set_hide = config(json!({ "screenHideToggle": "Control+Alt+H" }));
    for set in [set_slot, set_record, set_hide] {
        assert_eq!(
            registration_notice(&set, &unavailable),
            Some(RegistrationNotice::Problem {
                title: "Global shortcuts don't work here".into(),
                description: "No key grab here.".into(),
            })
        );
    }
    // A released key is not a key someone set.
    let released = config(json!({ "recordToggle": "  ", "sceneSlots": { "2": "" } }));
    assert_eq!(
        registration_notice(&released, &unavailable),
        Some(RegistrationNotice::Withdraw)
    );
}

#[test]
fn the_scenes_rows_list_nine_positions_then_custom_keys() {
    let scenes = vec![
        ("a".to_string(), "Intro".to_string()),
        ("b".to_string(), "Talk".to_string()),
    ];
    let config = config(json!({ "scenes": { "b": "F15", "a": " " } }));
    let rows = scene_shortcut_rows(&scenes, &config, Some("darwin"));
    assert_eq!(rows.len(), 10);
    assert_eq!(rows[0].label, "Scene 1 · Intro");
    assert_eq!(rows[0].accelerator, "Control+Alt+1");
    assert_eq!(rows[2].label, "Scene 3 · no scene");
    assert_eq!(
        rows[9],
        SceneShortcutRow {
            action: "scene:b".into(),
            label: "Talk".into(),
            accelerator: "F15".into(),
        }
    );
    let bindings = scene_shortcut_bindings("b", 2, &config, Some("win32"));
    assert_eq!(
        bindings,
        [
            (
                "scene-slot-2".to_string(),
                "Control+Alt+Shift+2".to_string()
            ),
            ("scene:b".to_string(), "F15".to_string()),
        ]
    );
    assert!(scene_shortcut_bindings("a", 12, &config, None).is_empty());
}

#[test]
fn the_action_rows_hide_system_audio_only_when_it_cannot_work() {
    assert_eq!(global_shortcut_rows(true, false).len(), 9);
    assert!(!global_shortcut_rows(false, false).contains(&"system-audio-toggle"));
    assert!(global_shortcut_rows(false, true).contains(&"system-audio-toggle"));
}

/// The tables are still Electron's.
#[test]
fn the_actions_labels_and_defaults_are_the_renderers() {
    let shared = include_str!("../../../../../apps/desktop/src/shared/global-shortcuts.ts");
    let renderer =
        include_str!("../../../../../apps/desktop/src/renderer/src/lib/global-shortcuts.ts");
    let settings = include_str!(
        "../../../../../apps/desktop/src/renderer/src/components/settings/shortcuts-settings.tsx"
    );
    let go_live = include_str!("../../../../../apps/desktop/src/renderer/src/lib/go-live-copy.ts");
    assert!(shared.contains(&format!(
        "DEFAULT_SCREEN_HIDE_SHORTCUT = '{DEFAULT_SCREEN_HIDE_SHORTCUT}'"
    )));
    assert!(shared.contains("`Control+Alt+${platform === 'darwin' ? '' : 'Shift+'}${position}`"));
    for action in FIXED_ACTIONS.iter().chain(SCENE_SLOT_ACTIONS.iter()) {
        assert!(shared.contains(&format!("'{action}'")), "{action}");
        assert!(settings.contains(&format!("'{action}'")) || action.starts_with("scene-slot-"));
    }
    for action in FIXED_ACTIONS {
        let label = global_shortcut_label(action);
        assert!(
            renderer.contains(&format!("'{label}'")) || go_live.contains(&format!("'{label}'")),
            "{label}"
        );
    }
    for line in [
        "\"A global shortcut didn't register\"",
        "\"Some global shortcuts didn't register\"",
        "\"Global shortcuts don't work here\"",
        "\"Global shortcuts didn't register\"",
        "\"Restart Videorc if they still don't work.\"",
        "another app uses ${failed.length === 1 ? 'it' : 'them'}, or the keys are taken twice. Choose different keys in Settings → Shortcuts.",
    ] {
        assert!(renderer.contains(line), "{line}");
    }
}
