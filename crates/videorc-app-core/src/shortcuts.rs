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
pub fn app_shortcuts() -> Vec<ShortcutEntry> {
    use ShortcutGroup::*;
    // Navigation: one row per page with a key, in sidebar order.
    let mut list: Vec<ShortcutEntry> = page_keys()
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
    app_shortcuts()
        .into_iter()
        .find(|entry| entry.id == id)
        .and_then(|entry| entry.accelerators.into_iter().next())
}

/// `shortcutsByGroup`: the rows by group, groups in first-seen order.
pub fn shortcuts_by_group() -> Vec<(ShortcutGroup, Vec<ShortcutEntry>)> {
    let mut groups: Vec<(ShortcutGroup, Vec<ShortcutEntry>)> = Vec::new();
    for entry in app_shortcuts() {
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
pub fn app_shortcut_owner(accelerator: &str, platform: Option<&str>) -> Option<ShortcutEntry> {
    let wanted = normalize_accelerator(Some(accelerator), platform)?;
    app_shortcuts().into_iter().find(|entry| {
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
            if let Some(owner) = app_shortcut_owner(&accelerator, platform) {
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

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: Option<&str> = Some("darwin");
    const WIN: Option<&str> = Some("win32");

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
        let list = app_shortcuts();
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
        let groups: Vec<&str> = shortcuts_by_group()
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
        let windows = app_shortcuts()
            .into_iter()
            .find(|entry| entry.id == "comments-window-show")
            .unwrap();
        assert_eq!(windows.label, "Show Stream Manager");
    }

    #[test]
    fn the_recorder_commits_or_refuses_in_words() {
        let step = |input: KeyInput, platform| shortcut_recorder_step(&input, platform, free);
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
        let taken = shortcut_recorder_step(&press("KeyM", true, false, true, false), MAC, |_| {
            Some("Already used by Hide screen.".into())
        });
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
        for entry in app_shortcuts()
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
            app_shortcuts()
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
}
