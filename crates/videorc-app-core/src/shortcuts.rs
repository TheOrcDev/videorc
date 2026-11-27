//! The keys that work inside Videorc, and the shortcut recorder (plan 260
//! S1.6f, from Electron's `lib/shortcuts.ts` and `lib/shortcut-recorder.ts`).
//!
//! - [`app_shortcuts`] is the one table of in-app keys: Settings →
//!   Shortcuts' reference list, the app menu's mirror and the recorder's
//!   refusals read it. The page keys come from [`crate::nav::page_keys`]
//!   (one home for their order and map).
//! - [`shortcut_recorder_step`] is what the Settings recorder does with one
//!   key event: commit, cancel, clear, or a refusal in words.

use crate::desktop::accelerator::{
    AcceleratorRefusal, KeyInput, KeyResult, Modifier, accelerator_from_key_input,
    accelerator_label, normalize_accelerator, validate_accelerator,
};
use crate::desktop::global_shortcuts::RECORD_SHORTCUT_LABEL;
use crate::desktop::menu::WINDOWS;
use crate::nav::page_keys;

/// Each group's name and its rows: a row's label and its keys as
/// accelerators.
pub type ShortcutGroupRows = Vec<(&'static str, Vec<(String, Vec<String>)>)>;

/// `ShortcutEntry['group']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ShortcutGroup {
    Navigation,
    Studio,
    Windows,
    StreamManager,
    Appearance,
}

impl ShortcutGroup {
    pub fn label(self) -> &'static str {
        match self {
            ShortcutGroup::Navigation => "Navigation",
            ShortcutGroup::Studio => "Studio",
            ShortcutGroup::Windows => "Windows",
            ShortcutGroup::StreamManager => "Stream Manager",
            ShortcutGroup::Appearance => "Appearance",
        }
    }
}

/// `ShortcutEntry`: one row, its keys as accelerators (usually one; a pair
/// that shares a row, ↑ and ↓, lists both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutEntry {
    pub id: String,
    pub accelerators: Vec<String>,
    pub label: String,
    pub group: ShortcutGroup,
}

fn entry(id: &str, keys: &[&str], label: &str, group: ShortcutGroup) -> ShortcutEntry {
    ShortcutEntry {
        id: id.to_string(),
        accelerators: keys.iter().map(|key| key.to_string()).collect(),
        label: label.to_string(),
        group,
    }
}

/// `WINDOW_NAMES` by window, as the Window menu has them.
fn window_name(index: usize) -> &'static str {
    WINDOWS[index].title
}

/// `SHORTCUTS`: every in-app key, in the reference list's order.
pub fn app_shortcuts(guests_shown: bool) -> Vec<ShortcutEntry> {
    use ShortcutGroup::*;
    // Navigation: one row per page with a key, in sidebar order.
    let mut list: Vec<ShortcutEntry> = page_keys(guests_shown)
        .into_iter()
        .map(|(page, key)| ShortcutEntry {
            id: format!("nav-{}", page.id()),
            accelerators: vec![key.accelerator()],
            label: page.label().to_string(),
            group: Navigation,
        })
        .collect();
    let preview = window_name(0);
    let notes = window_name(1);
    let stream_manager = window_name(2);
    let captions = window_name(3);
    list.extend([
        // ⌘K is "Search" everywhere it is named (plan 174 A-13).
        entry("search", &["CmdOrCtrl+K"], "Search", Navigation),
        // The list behind the bell (plan 250, D10).
        entry(
            "notifications",
            &["CmdOrCtrl+Shift+B"],
            "Notifications",
            Navigation,
        ),
        entry(
            "shortcuts-page",
            &["CmdOrCtrl+/"],
            "Settings → Shortcuts",
            Navigation,
        ),
        // Space works on the Studio page only (plan 174 D1).
        entry("record-toggle", &["Space"], RECORD_SHORTCUT_LABEL, Studio),
        entry(
            "go-live-confirm",
            &["CmdOrCtrl+Enter"],
            "Go live, in the Go Live dialog",
            Studio,
        ),
        entry(
            "preview-window",
            &["CmdOrCtrl+P"],
            &format!("Open {preview}"),
            Windows,
        ),
        entry(
            "notes-window",
            &["CmdOrCtrl+Shift+N"],
            &format!("Open {notes}"),
            Windows,
        ),
        entry(
            "comments-window",
            &["CmdOrCtrl+Shift+J"],
            &format!("Open {stream_manager}"),
            Windows,
        ),
        entry(
            "comments-window-show",
            &["CmdOrCtrl+J"],
            &format!("Show {stream_manager}"),
            Windows,
        ),
        entry(
            "captions-window",
            &["CmdOrCtrl+Shift+C"],
            &format!("Open {captions}"),
            Windows,
        ),
        entry(
            "cohost-focus",
            &["CmdOrCtrl+J"],
            "Focus Sidekick",
            StreamManager,
        ),
        entry(
            "cohost-move",
            &["Up", "Down"],
            "Move between questions",
            StreamManager,
        ),
        entry("cohost-reply", &["R"], "Draft a reply", StreamManager),
        entry(
            "cohost-highlight",
            &["H"],
            "Show the question on stream",
            StreamManager,
        ),
        entry("cohost-answered", &["A"], "Mark answered", StreamManager),
        entry("cohost-dismiss", &["Backspace"], "Dismiss", StreamManager),
        entry(
            "cohost-remove-flagged",
            &["Shift+Backspace"],
            "Remove the flagged message from chat",
            StreamManager,
        ),
        entry(
            "buddy-card-send",
            &["Enter"],
            "Send Sidekick's proposed post",
            StreamManager,
        ),
        entry(
            "buddy-card-dismiss",
            &["Escape", "Backspace"],
            "Dismiss Sidekick's proposed post",
            StreamManager,
        ),
        entry(
            "buddy-say",
            &["Enter"],
            "Say it on stream (the Say box)",
            StreamManager,
        ),
        entry(
            "buddy-say-laugh",
            &["CmdOrCtrl+Enter"],
            "Say it laughing",
            StreamManager,
        ),
        entry(
            "chat-search",
            &["CmdOrCtrl+F"],
            "Search chat",
            StreamManager,
        ),
        entry(
            "chat-composer",
            &["CmdOrCtrl+L"],
            "Write in chat",
            StreamManager,
        ),
        entry(
            "chat-move",
            &["Up", "Down"],
            "Move between messages",
            StreamManager,
        ),
        entry("chat-reply", &["R"], "Reply to the message", StreamManager),
        entry("chat-copy", &["C"], "Copy the message", StreamManager),
        entry(
            "chat-remove",
            &["Shift+Backspace"],
            "Remove the message from chat",
            StreamManager,
        ),
        entry(
            "theme-toggle",
            &["D"],
            "Toggle light / dark theme",
            Appearance,
        ),
    ]);
    list
}

/// `shortcutAccelerator`: a row's (first) key.
pub fn shortcut_accelerator(id: &str) -> Option<String> {
    app_shortcuts(true)
        .into_iter()
        .find(|entry| entry.id == id)
        .and_then(|entry| entry.accelerators.into_iter().next())
}

/// `shortcutsByGroup`: the rows by group, groups in first-seen order.
pub fn shortcuts_by_group(guests_shown: bool) -> Vec<(ShortcutGroup, Vec<ShortcutEntry>)> {
    let mut groups: Vec<(ShortcutGroup, Vec<ShortcutEntry>)> = Vec::new();
    for entry in app_shortcuts(guests_shown) {
        match groups.iter_mut().find(|(group, _)| *group == entry.group) {
            Some((_, rows)) => rows.push(entry),
            None => groups.push((entry.group, vec![entry])),
        }
    }
    groups
}

/// `appShortcutOwner`: Videorc's own key for this combination, if any (plan
/// 174 I-17). A global binding takes the key from every app, Videorc too, so
/// ⌘K or ⌘1 bound globally would stop opening Search or Studio.
pub fn app_shortcut_owner(
    accelerator: &str,
    platform: Option<&str>,
    guests_shown: bool,
) -> Option<ShortcutEntry> {
    let wanted = normalize_accelerator(Some(accelerator), platform)?;
    app_shortcuts(guests_shown).into_iter().find(|entry| {
        entry.accelerators.iter().any(|key| {
            normalize_accelerator(Some(key.as_str()), platform).as_deref() == Some(wanted.as_str())
        })
    })
}

/// `ShortcutRecorderAppKey`: the key that already does the row's action
/// inside Videorc, shown while nothing is recorded there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppKey {
    pub accelerator: String,
    /// Where the key works, read after it: "in Studio".
    pub place: String,
}

/// `GLOBAL_ROW_APP_KEYS`: Space records on the Studio page (plan 174 D1), so
/// the Record row shows it until a global key is recorded.
pub fn global_row_app_key(action: &str) -> Option<AppKey> {
    (action == "record-toggle").then(|| AppKey {
        accelerator: shortcut_accelerator("record-toggle").unwrap_or_default(),
        place: "in Studio".into(),
    })
}

/// `shortcutRecorderName`: the recorder's accessible name, the action and
/// what is set, so a screen reader hears it (plan 174 I-17).
pub fn shortcut_recorder_name(
    label: &str,
    value: Option<&str>,
    app_key: Option<&AppKey>,
    armed: bool,
    platform: Option<&str>,
) -> String {
    if armed {
        return format!("{label}: press the new shortcut");
    }
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        return format!("{label}: {}", accelerator_label(Some(value), platform));
    }
    if let Some(app_key) = app_key {
        return format!(
            "{label}: {} {}",
            accelerator_label(Some(app_key.accelerator.as_str()), platform),
            app_key.place
        );
    }
    format!("{label}: Unassigned")
}

/// `ShortcutRecorderStep`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecorderStep {
    Held(Vec<Modifier>),
    Commit(String),
    Cancel,
    Clear,
    Reject(String),
}

/// `shortcutRecorderStep`: one key event while armed. `validate` is the
/// caller's own refusal ("Already used by …").
pub fn shortcut_recorder_step(
    input: &KeyInput,
    platform: Option<&str>,
    validate: impl Fn(&str) -> Option<String>,
    guests_shown: bool,
) -> RecorderStep {
    let mac = platform == Some("darwin");
    match accelerator_from_key_input(input, platform) {
        KeyResult::Modifiers(modifiers) => RecorderStep::Held(modifiers),
        KeyResult::Cancel => RecorderStep::Cancel,
        KeyResult::Clear => RecorderStep::Clear,
        KeyResult::Unsupported(_) => {
            RecorderStep::Reject("That key can't be part of a shortcut. Try another.".into())
        }
        KeyResult::Combo { accelerator, .. } => {
            let shown = accelerator_label(Some(accelerator.as_str()), platform);
            match validate_accelerator(&accelerator, platform) {
                Err(AcceleratorRefusal::NeedsModifier) => {
                    return RecorderStep::Reject(if mac {
                        "Add ⌘, ⌃ or ⌥ so the key still types in other apps.".into()
                    } else {
                        "Add Ctrl, Alt or Win so the key still types in other apps.".into()
                    });
                }
                Err(AcceleratorRefusal::SystemReserved) => {
                    return RecorderStep::Reject(format!(
                        "{shown} is a system shortcut in every app. Pick another."
                    ));
                }
                Ok(()) => {}
            }
            if let Some(owner) = app_shortcut_owner(&accelerator, platform, guests_shown) {
                return RecorderStep::Reject(format!(
                    "{shown} is Videorc's shortcut for “{}”. Pick another.",
                    owner.label
                ));
            }
            match validate(accelerator.as_str()) {
                Some(refusal) => RecorderStep::Reject(refusal),
                None => RecorderStep::Commit(accelerator),
            }
        }
    }
}

// ── Settings → Shortcuts (`shortcuts-settings.tsx`) ─────────────────────

pub const GLOBAL_TITLE: &str = "Global shortcuts";
pub const GLOBAL_DESCRIPTION: &str = "Work system-wide, even when Videorc is in the background. Click a field and press the keys. Stream Deck hotkeys and F13 to F24 work too.";
/// Linux on Wayland: the keys are kept for sessions that allow them.
pub const GLOBAL_DESCRIPTION_UNAVAILABLE: &str =
    "Kept for sessions that allow them, such as X11. Click a field and press the keys.";
pub const SCENES_LABEL: &str = "Scenes";
pub const APP_TITLE: &str = "App shortcuts";
pub const APP_DESCRIPTION: &str = "Keys that work while Videorc is in front.";

/// One recorder row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecorderRow {
    pub action: String,
    pub label: String,
    /// The key set now (`None`: unassigned).
    pub value: Option<String>,
    /// Videorc's own key for the action, shown while nothing is set.
    pub app_key: Option<AppKey>,
    /// The OS refused the key: "Another app uses ⇧⌘R" under the field.
    pub conflict: Option<String>,
}

/// The page as one value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutsView {
    pub global_description: &'static str,
    /// Why this session holds no global key (Linux on Wayland).
    pub unavailable: Option<String>,
    pub action_rows: Vec<RecorderRow>,
    pub scene_rows: Vec<RecorderRow>,
    /// The reference list: each group's rows with their keys as
    /// accelerators ("CmdOrCtrl+Shift+G"), for the key chips to print.
    pub app_groups: ShortcutGroupRows,
}

/// What the page reads.
#[derive(Debug, Clone, Copy)]
pub struct ShortcutsInput<'a> {
    pub guests_shown: bool,
    pub config: &'a crate::desktop::global_shortcuts::GlobalShortcutsConfig,
    pub platform: Option<&'a str>,
    /// `runtimeInfo.globalShortcutsUnavailable`.
    pub unavailable: Option<&'a str>,
    /// The system-audio device exists and is not unavailable.
    pub system_audio_available: bool,
    /// The saved scenes in order, as (id, name) (L7's list).
    pub scenes: &'a [(String, String)],
    /// The last registration: each action, true when its key took.
    pub registered: &'a std::collections::BTreeMap<String, bool>,
}

/// `ShortcutsSettings`: the global shortcuts you record, beside every key
/// that works inside Videorc. The recorders are the only home of a global
/// binding, so the in-app list does not repeat them.
pub fn shortcuts_view(input: ShortcutsInput<'_>) -> ShortcutsView {
    use crate::desktop::accelerator::global_shortcut_conflict_reason;
    use crate::desktop::global_shortcuts::{
        global_shortcut_entries, global_shortcut_label, global_shortcut_rows, scene_shortcut_rows,
    };
    let entries = global_shortcut_entries(input.config, input.platform);
    let value_of = |action: &str| {
        entries
            .iter()
            .find(|(id, _)| id == action)
            .and_then(|(_, value)| value.clone())
    };
    let failed = |action: &str| input.registered.get(action) == Some(&false);
    let row = |action: &str, label: String, value: Option<String>| RecorderRow {
        action: action.to_string(),
        label,
        conflict: global_shortcut_conflict_reason(value.as_deref(), input.platform, failed(action)),
        app_key: global_row_app_key(action),
        value,
    };
    let system_audio_bound = input
        .config
        .system_audio_toggle
        .as_deref()
        .is_some_and(|key| !key.is_empty());
    let action_rows: Vec<RecorderRow> =
        global_shortcut_rows(input.system_audio_available, system_audio_bound)
            .into_iter()
            .map(|action| row(action, global_shortcut_label(action), value_of(action)))
            .collect();
    let scene_rows: Vec<RecorderRow> =
        scene_shortcut_rows(input.scenes, input.config, input.platform)
            .into_iter()
            .map(|scene| {
                let mut scene_row = row(&scene.action, scene.label, Some(scene.accelerator));
                scene_row.app_key = None;
                scene_row
            })
            .collect();
    let app_groups: ShortcutGroupRows = shortcuts_by_group(input.guests_shown)
        .into_iter()
        .map(|(group, rows)| {
            // Raw accelerators: the page's key chips parse them, so a
            // letter shows as "⇧⌘G", not a label re-read as one key.
            let rows: Vec<(String, Vec<String>)> = rows
                .into_iter()
                .map(|entry| (entry.label, entry.accelerators))
                .collect();
            (group.label(), rows)
        })
        .collect();
    ShortcutsView {
        global_description: if input.unavailable.is_some() {
            GLOBAL_DESCRIPTION_UNAVAILABLE
        } else {
            GLOBAL_DESCRIPTION
        },
        unavailable: input.unavailable.map(str::to_string),
        action_rows,
        scene_rows,
        app_groups,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: Option<&str> = Some("darwin");
    const WIN: Option<&str> = Some("win32");

    #[test]
    fn visible_page_shortcut_hints_and_recorder_owners_follow_availability() {
        for shown in [false, true, false] {
            let entries = app_shortcuts(shown);
            assert_eq!(entries.iter().any(|row| row.id == "nav-guests"), shown);
            for (page, key) in page_keys(shown) {
                let row = entries
                    .iter()
                    .find(|row| row.id == format!("nav-{}", page.id()))
                    .unwrap();
                assert_eq!(row.accelerators, [key.accelerator()]);
            }
            assert_eq!(
                app_shortcut_owner("CmdOrCtrl+7", MAC, shown).unwrap().label,
                if shown { "Guests" } else { "Avatar" }
            );
            assert_eq!(
                app_shortcut_owner("CmdOrCtrl+8", MAC, shown).unwrap().label,
                if shown { "Avatar" } else { "Sidekick" }
            );
            let view = shortcuts_view(ShortcutsInput {
                guests_shown: shown,
                config: &Default::default(),
                platform: MAC,
                unavailable: None,
                system_audio_available: false,
                scenes: &[],
                registered: &Default::default(),
            });
            let nav = &view.app_groups[0].1;
            assert!(nav.iter().any(|(label, keys)| label == "Avatar"
                && keys == &[format!("CmdOrCtrl+{}", if shown { 8 } else { 7 })]));
            assert_eq!(nav.iter().any(|(label, _)| label == "Guests"), shown);
        }
    }

    #[test]
    fn a_lone_modifier_from_gpui_is_held_never_refused() {
        // GPUI sends a lone modifier's press or release as its own keystroke
        // (`key` shift/control/alt/platform/function); every recorder maps it
        // through `code_for_gpui_key` (#2284), so the step holds it, never
        // "That key can't be part of a shortcut".
        for key in ["shift", "control", "alt", "platform", "function"] {
            let code = crate::desktop::accelerator::code_for_gpui_key(key);
            for held in [false, true] {
                let input = KeyInput {
                    key_up: false,
                    code: code.clone(),
                    meta: held && key == "platform",
                    control: held && key == "control",
                    alt: held && key == "alt",
                    shift: held && key == "shift",
                };
                let step = shortcut_recorder_step(&input, MAC, |_| None, true);
                assert!(
                    matches!(step, RecorderStep::Held(_)),
                    "{key} held={held}: {step:?}"
                );
            }
        }
    }

    fn press(code: &str, meta: bool, control: bool, alt: bool, shift: bool) -> KeyInput {
        KeyInput {
            key_up: false,
            code: code.into(),
            meta,
            control,
            alt,
            shift,
        }
    }

    fn free(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_table_starts_with_the_page_keys_and_groups_in_order() {
        let list = app_shortcuts(true);
        assert_eq!(list[0].id, "nav-studio");
        assert_eq!(list[0].accelerators, ["CmdOrCtrl+1"]);
        assert_eq!(list[0].label, "Studio");
        assert!(
            list.iter()
                .any(|entry| entry.id == "nav-settings" && entry.accelerators == ["CmdOrCtrl+,"])
        );
        assert_eq!(
            shortcut_accelerator("record-toggle").as_deref(),
            Some("Space")
        );
        assert_eq!(shortcut_accelerator("nope"), None);
        let groups: Vec<&str> = shortcuts_by_group(true)
            .iter()
            .map(|(group, _)| group.label())
            .collect();
        assert_eq!(
            groups,
            [
                "Navigation",
                "Studio",
                "Windows",
                "Stream Manager",
                "Appearance"
            ]
        );
        let windows = app_shortcuts(true)
            .into_iter()
            .find(|entry| entry.id == "comments-window-show")
            .unwrap();
        assert_eq!(windows.label, "Show Stream Manager");
    }

    #[test]
    fn the_recorder_commits_or_refuses_in_words() {
        let step = |input: KeyInput, platform| shortcut_recorder_step(&input, platform, free, true);
        assert_eq!(
            step(press("KeyM", true, false, false, true), MAC),
            RecorderStep::Commit("Cmd+Shift+M".into())
        );
        assert_eq!(
            step(press("KeyM", false, false, false, true), MAC),
            RecorderStep::Reject("Add ⌘, ⌃ or ⌥ so the key still types in other apps.".into())
        );
        assert_eq!(
            step(press("KeyM", false, false, false, false), WIN),
            RecorderStep::Reject(
                "Add Ctrl, Alt or Win so the key still types in other apps.".into()
            )
        );
        assert_eq!(
            step(press("KeyQ", true, false, false, false), MAC),
            RecorderStep::Reject("⌘Q is a system shortcut in every app. Pick another.".into())
        );
        assert_eq!(
            step(press("KeyK", true, false, false, false), MAC),
            RecorderStep::Reject("⌘K is Videorc's shortcut for “Search”. Pick another.".into())
        );
        assert_eq!(
            step(press("IntlRo", true, false, false, false), MAC),
            RecorderStep::Reject("That key can't be part of a shortcut. Try another.".into())
        );
        assert_eq!(
            step(press("Escape", false, false, false, false), MAC),
            RecorderStep::Cancel
        );
        assert_eq!(
            step(press("Delete", false, false, false, false), MAC),
            RecorderStep::Clear
        );
        assert_eq!(
            step(press("ShiftLeft", false, false, false, true), MAC),
            RecorderStep::Held(vec![Modifier::Shift])
        );
        let taken = shortcut_recorder_step(
            &press("KeyM", true, false, true, false),
            MAC,
            |_| Some("Already used by Hide screen.".into()),
            true,
        );
        assert_eq!(
            taken,
            RecorderStep::Reject("Already used by Hide screen.".into())
        );
    }

    #[test]
    fn the_recorders_name_says_what_is_set() {
        let space = global_row_app_key("record-toggle").unwrap();
        assert_eq!(space.accelerator, "Space");
        assert_eq!(global_row_app_key("mic-toggle"), None);
        assert_eq!(
            shortcut_recorder_name("Record", None, Some(&space), false, MAC),
            "Record: Space in Studio"
        );
        assert_eq!(
            shortcut_recorder_name("Mute", Some("Cmd+Shift+M"), None, false, MAC),
            "Mute: ⇧⌘M"
        );
        assert_eq!(
            shortcut_recorder_name("Mute", None, None, true, MAC),
            "Mute: press the new shortcut"
        );
        assert_eq!(
            shortcut_recorder_name("Mute", None, None, false, WIN),
            "Mute: Unassigned"
        );
    }

    /// The table and the recorder's words are still Electron's.
    #[test]
    fn the_table_and_the_words_are_the_renderers() {
        let table = include_str!("../../../apps/desktop/src/renderer/src/lib/shortcuts.ts");
        let recorder =
            include_str!("../../../apps/desktop/src/renderer/src/lib/shortcut-recorder.ts");
        for entry in app_shortcuts(true)
            .iter()
            .filter(|entry| !entry.id.starts_with("nav-"))
        {
            assert!(
                table.contains(&format!("id: '{}'", entry.id)),
                "{}",
                entry.id
            );
            for key in &entry.accelerators {
                assert!(table.contains(&format!("'{key}'")), "{key}");
            }
            if !entry.label.contains("Open ")
                && !entry.label.contains("Show ")
                && entry.id != "record-toggle"
            {
                let quoted = format!("'{}'", entry.label);
                let double = format!("\"{}\"", entry.label);
                assert!(
                    table.contains(&quoted) || table.contains(&double),
                    "{}",
                    entry.label
                );
            }
        }
        let rows = table.matches("    id: '").count() + table.matches("  { id: '").count();
        assert_eq!(
            rows,
            app_shortcuts(true)
                .iter()
                .filter(|entry| !entry.id.starts_with("nav-"))
                .count(),
            "a row was added or removed"
        );
        for line in [
            "\"That key can't be part of a shortcut. Try another.\"",
            "'Add ⌘, ⌃ or ⌥ so the key still types in other apps.'",
            "'Add Ctrl, Alt or Win so the key still types in other apps.'",
            "is a system shortcut in every app. Pick another.",
            "is Videorc's shortcut for “${owner.label}”. Pick another.",
            "return `${label}: press the new shortcut`",
            "return `${label}: Unassigned`",
        ] {
            assert!(recorder.contains(line), "{line}");
        }
    }

    #[test]
    fn the_settings_page_lists_recorders_then_the_reference() {
        use crate::desktop::global_shortcuts::GlobalShortcutsConfig;
        use std::collections::BTreeMap;
        let config: GlobalShortcutsConfig = serde_json::from_value(serde_json::json!({
            "recordToggle": "Cmd+Shift+R",
            "scenes": { "b": "F15" }
        }))
        .unwrap();
        let scenes = vec![
            ("a".to_string(), "Intro".to_string()),
            ("b".to_string(), "Talk".to_string()),
        ];
        let registered = BTreeMap::from([("record-toggle".to_string(), false)]);
        let view = shortcuts_view(ShortcutsInput {
            guests_shown: true,
            config: &config,
            platform: MAC,
            unavailable: None,
            system_audio_available: false,
            scenes: &scenes,
            registered: &registered,
        });
        assert_eq!(view.global_description, GLOBAL_DESCRIPTION);
        // System audio is not here and nothing is bound to it.
        assert_eq!(view.action_rows.len(), 8);
        let record = &view.action_rows[1];
        assert_eq!(record.label, "Record / stop recording");
        assert_eq!(record.value.as_deref(), Some("Cmd+Shift+R"));
        assert_eq!(record.conflict.as_deref(), Some("Another app uses ⇧⌘R"));
        assert_eq!(
            record.app_key.as_ref().map(|key| key.accelerator.as_str()),
            Some("Space")
        );
        let hide = &view.action_rows[0];
        assert_eq!(hide.value.as_deref(), Some("Control+Alt+H"));
        assert_eq!(hide.conflict, None);
        assert_eq!(view.scene_rows.len(), 10);
        assert_eq!(view.scene_rows[0].label, "Scene 1 · Intro");
        assert_eq!(view.scene_rows[9].label, "Talk");
        assert_eq!(view.app_groups[0].0, "Navigation");
        assert_eq!(
            view.app_groups[0].1[0],
            ("Studio".to_string(), vec!["CmdOrCtrl+1".to_string()])
        );

        let wayland = shortcuts_view(ShortcutsInput {
            guests_shown: true,
            config: &config,
            platform: Some("linux"),
            unavailable: Some("No key grab here."),
            system_audio_available: true,
            scenes: &[],
            registered: &BTreeMap::new(),
        });
        assert_eq!(wayland.global_description, GLOBAL_DESCRIPTION_UNAVAILABLE);
        assert_eq!(wayland.unavailable.as_deref(), Some("No key grab here."));
        assert_eq!(wayland.action_rows.len(), 9);
        assert_eq!(
            wayland.scene_rows[0].value.as_deref(),
            Some("Control+Alt+Shift+1")
        );
    }

    #[test]
    fn the_pages_words_are_the_renderers() {
        let page = include_str!(
            "../../../apps/desktop/src/renderer/src/components/settings/shortcuts-settings.tsx"
        );
        for line in [
            GLOBAL_TITLE,
            GLOBAL_DESCRIPTION,
            GLOBAL_DESCRIPTION_UNAVAILABLE,
            SCENES_LABEL,
            APP_TITLE,
            APP_DESCRIPTION,
        ] {
            assert!(page.contains(line), "{line}");
        }
        assert!(page.contains("where: 'in Studio'"));
    }
}
