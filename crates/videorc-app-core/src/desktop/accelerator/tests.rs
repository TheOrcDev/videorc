//! `accelerator.test.ts`, `accelerator-format.test.ts` and
//! `global-shortcut-owner`'s cases.

use serde_json::json;

use super::*;

const MAC: Option<&str> = Some("darwin");
const WIN: Option<&str> = Some("win32");
const LINUX: Option<&str> = Some("linux");

fn label(accelerator: &str, platform: Option<&str>) -> String {
    accelerator_label(Some(accelerator), platform)
}

fn press(code: &str) -> KeyInput {
    KeyInput {
        code: code.into(),
        ..KeyInput::default()
    }
}

fn combo(result: KeyResult) -> String {
    match result {
        KeyResult::Combo { accelerator, .. } => accelerator,
        other => panic!("not a combo: {other:?}"),
    }
}

#[test]
fn reads_as_the_menus_do_on_each_platform() {
    assert_eq!(label("CmdOrCtrl+Shift+J", MAC), "⇧⌘J");
    assert_eq!(label("Shift+CmdOrCtrl+N", MAC), "⇧⌘N");
    assert_eq!(label("CmdOrCtrl+K", MAC), "⌘K");
    assert_eq!(label("CmdOrCtrl+,", MAC), "⌘,");
    assert_eq!(label("Ctrl+Alt+Shift+Cmd+R", MAC), "⌃⌥⇧⌘R");
    assert_eq!(label("CmdOrCtrl+Shift+J", WIN), "Ctrl+Shift+J");
    assert_eq!(label("CmdOrCtrl+1", WIN), "Ctrl+1");
    assert_eq!(label("CmdOrCtrl+K", LINUX), "Ctrl+K");
    assert_eq!(label("Super+F13", LINUX), "Win+F13");
}

#[test]
fn names_the_special_keys_with_glyphs_on_macos_and_words_elsewhere() {
    let keys = [
        "Space",
        "Backspace",
        "Enter",
        "Delete",
        "Escape",
        "Shift+Backspace",
    ];
    let mac: Vec<String> = keys.iter().map(|key| label(key, MAC)).collect();
    assert_eq!(mac, ["Space", "⌫", "↵", "⌦", "Esc", "⇧⌫"]);
    let win: Vec<String> = keys.iter().map(|key| label(key, WIN)).collect();
    assert_eq!(
        win,
        [
            "Space",
            "Backspace",
            "Enter",
            "Delete",
            "Esc",
            "Shift+Backspace"
        ]
    );
    assert_eq!(label("CmdOrCtrl+Enter", MAC), "⌘↵");
    assert_eq!(label("CmdOrCtrl+Enter", WIN), "Ctrl+Enter");
    for accelerator in [
        "CmdOrCtrl+Shift+J",
        "Alt+Backspace",
        "Ctrl+Tab",
        "Shift+Enter",
    ] {
        let words = label(accelerator, WIN);
        assert!(!words.chars().any(|c| "⌘⇧⌥⌃␣⌫↵⌦".contains(c)), "{words}");
    }
}

#[test]
fn a_modifier_alone_reads_as_itself_and_nothing_reads_as_nothing() {
    assert_eq!(label("Alt", MAC), "⌥");
    assert_eq!(label("Alt", WIN), "Alt");
    assert_eq!(label("Shift", MAC), "⇧");
    assert_eq!(label("Shift", LINUX), "Shift");
    assert_eq!(accelerator_display_keys(Some("Shift"), WIN), ["Shift"]);
    assert_eq!(label("", MAC), "");
    assert_eq!(accelerator_label(None, WIN), "");
    assert_eq!(label("Cmd+A+B", MAC), "Cmd+A+B");
    assert_eq!(
        accelerator_modifiers_label(&[Modifier::Cmd, Modifier::Shift], MAC),
        "⇧⌘"
    );
    assert_eq!(
        accelerator_modifiers_label(&[Modifier::Ctrl, Modifier::Shift], WIN),
        "Ctrl+Shift"
    );
    assert_eq!(accelerator_modifiers_label(&[], MAC), "");
}

#[test]
fn aria_names_the_keys_as_they_really_are() {
    let aria =
        |accelerator: &str, platform| accelerator_aria_key_shortcuts(Some(accelerator), platform);
    assert_eq!(aria("CmdOrCtrl+K", MAC), "Meta+K");
    assert_eq!(aria("CmdOrCtrl+K", WIN), "Control+K");
    assert_eq!(aria("CmdOrCtrl+Shift+J", MAC), "Shift+Meta+J");
    assert_eq!(aria("CmdOrCtrl+Shift+J", LINUX), "Control+Shift+J");
    assert_eq!(aria("Up", MAC), "ArrowUp");
    assert_eq!(aria("Space", WIN), "Space");
    assert_eq!(aria("", MAC), "");
    assert!(command_modifier_held(true, false, MAC));
    assert!(!command_modifier_held(false, true, MAC));
    assert!(command_modifier_held(false, true, WIN));
    assert!(!command_modifier_held(true, false, WIN));
    assert!(command_modifier_held(false, true, LINUX));
}

#[test]
fn display_keys_in_menu_order_and_legacy_cmd_as_ctrl() {
    assert_eq!(
        accelerator_display_keys(Some("Cmd+Shift+M"), MAC),
        ["⇧", "⌘", "M"]
    );
    assert_eq!(
        accelerator_display_keys(Some("Cmd+Ctrl+Alt+Up"), MAC),
        ["⌃", "⌥", "⌘", "↑"]
    );
    assert_eq!(
        accelerator_display_keys(Some("Ctrl+Shift+M"), WIN),
        ["Ctrl", "Shift", "M"]
    );
    assert_eq!(
        accelerator_display_keys(Some("Cmd+Shift+R"), WIN),
        ["Ctrl", "Shift", "R"]
    );
    assert_eq!(
        accelerator_display_keys(Some("Super+F13"), LINUX),
        ["Win", "F13"]
    );
    assert!(accelerator_display_keys(Some(""), MAC).is_empty());
    assert_eq!(accelerator_display_keys(Some("Cmd+A+B"), MAC), ["Cmd+A+B"]);
}

#[test]
fn records_by_the_physical_key_in_the_saved_order() {
    let cmd_shift_m = KeyInput {
        meta: true,
        shift: true,
        ..press("KeyM")
    };
    assert_eq!(
        accelerator_from_key_input(&cmd_shift_m, MAC),
        KeyResult::Combo {
            accelerator: "Cmd+Shift+M".into(),
            modifiers: vec![Modifier::Cmd, Modifier::Shift],
        }
    );
    let alt_m = KeyInput {
        alt: true,
        ..press("KeyM")
    };
    assert_eq!(combo(accelerator_from_key_input(&alt_m, MAC)), "Alt+M");
    let ctrl_shift_m = KeyInput {
        control: true,
        shift: true,
        ..press("KeyM")
    };
    assert_eq!(
        combo(accelerator_from_key_input(&ctrl_shift_m, WIN)),
        "Ctrl+Shift+M"
    );
    let win_m = KeyInput {
        meta: true,
        ..press("KeyM")
    };
    assert_eq!(combo(accelerator_from_key_input(&win_m, WIN)), "Super+M");
    let with_ctrl = |code: &str| {
        accelerator_from_key_input(
            &KeyInput {
                control: true,
                ..press(code)
            },
            MAC,
        )
    };
    assert_eq!(combo(with_ctrl("F13")), "Ctrl+F13");
    assert_eq!(combo(with_ctrl("Digit1")), "Ctrl+1");
    assert_eq!(combo(with_ctrl("ArrowLeft")), "Ctrl+Left");
    assert_eq!(combo(with_ctrl("Numpad4")), "Ctrl+num4");
    assert_eq!(combo(with_ctrl("BracketLeft")), "Ctrl+[");
    assert_eq!(
        with_ctrl("IntlRo"),
        KeyResult::Unsupported(vec![Modifier::Ctrl])
    );
    assert_eq!(accelerator_key_from_code("F25"), None);
    assert_eq!(accelerator_key_from_code("Keym"), None);
}

#[test]
fn shows_held_modifiers_and_reads_bare_escape_and_backspace() {
    let meta = KeyInput {
        meta: true,
        ..press("MetaLeft")
    };
    assert_eq!(
        accelerator_from_key_input(&meta, MAC),
        KeyResult::Modifiers(vec![Modifier::Cmd])
    );
    let released = KeyInput {
        key_up: true,
        shift: true,
        ..press("KeyM")
    };
    assert_eq!(
        accelerator_from_key_input(&released, MAC),
        KeyResult::Modifiers(vec![Modifier::Shift])
    );
    assert_eq!(
        accelerator_from_key_input(&press("Escape"), MAC),
        KeyResult::Cancel
    );
    assert_eq!(
        accelerator_from_key_input(&press("Backspace"), MAC),
        KeyResult::Clear
    );
    assert_eq!(
        accelerator_from_key_input(&press("Delete"), WIN),
        KeyResult::Clear
    );
    let cmd_backspace = KeyInput {
        meta: true,
        ..press("Backspace")
    };
    assert_eq!(
        combo(accelerator_from_key_input(&cmd_backspace, MAC)),
        "Cmd+Backspace"
    );
}

#[test]
fn a_global_key_needs_a_real_modifier_and_never_the_systems() {
    use AcceleratorRefusal::*;
    assert_eq!(validate_accelerator("M", MAC), Err(NeedsModifier));
    assert_eq!(validate_accelerator("Shift+M", MAC), Err(NeedsModifier));
    assert_eq!(validate_accelerator("F13", MAC), Ok(()));
    assert_eq!(validate_accelerator("Alt+M", WIN), Ok(()));
    assert_eq!(validate_accelerator("Cmd+M", MAC), Err(SystemReserved));
    assert_eq!(validate_accelerator("Cmd+Q", MAC), Err(SystemReserved));
    assert_eq!(validate_accelerator("Cmd+Shift+M", MAC), Ok(()));
    assert_eq!(validate_accelerator("Alt+F4", WIN), Err(SystemReserved));
    assert_eq!(validate_accelerator("Ctrl+M", WIN), Ok(()));
}

#[test]
fn one_spelling_per_binding() {
    let norm = |value: &str, platform| normalize_accelerator(Some(value), platform);
    assert_eq!(norm("cmd+shift+m", MAC).as_deref(), Some("Cmd+Shift+M"));
    assert_eq!(norm("Shift+Command+M", MAC).as_deref(), Some("Cmd+Shift+M"));
    assert_eq!(
        norm("Control+Option+return", MAC).as_deref(),
        Some("Ctrl+Alt+Enter")
    );
    assert_eq!(norm("CmdOrCtrl+K", MAC).as_deref(), Some("Cmd+K"));
    assert_eq!(norm("Cmd+Shift+R", WIN).as_deref(), Some("Ctrl+Shift+R"));
    assert_eq!(norm("CommandOrControl+K", LINUX).as_deref(), Some("Ctrl+K"));
    assert_eq!(norm("", MAC), None);
    assert_eq!(normalize_accelerator(None, MAC), None);
    assert_eq!(norm("Cmd+Shift", MAC), None);
    assert_eq!(norm("Cmd+A+B", MAC), None);
    assert_eq!(norm("Ctrl+f05", WIN).as_deref(), Some("Ctrl+F5"));
}

#[test]
fn finds_who_holds_a_key_and_says_so() {
    let config: GlobalShortcutsConfig = serde_json::from_value(json!({
        "recordToggle": "Cmd+Shift+R",
        "scenes": { "figma": "F13" }
    }))
    .unwrap();
    let owner =
        |accelerator: &str, except: &str| find_accelerator_owner(&config, accelerator, except, MAC);
    assert_eq!(
        owner("Shift+Cmd+R", "mic-toggle").as_deref(),
        Some("record-toggle")
    );
    assert_eq!(
        owner("Ctrl+Alt+1", "scene:figma").as_deref(),
        Some("scene-slot-1")
    );
    assert_eq!(owner("F13", "scene-slot-1").as_deref(), Some("scene:figma"));
    assert_eq!(owner("Cmd+Shift+R", "record-toggle"), None);
    assert_eq!(owner("Cmd+Shift+M", "mic-toggle"), None);

    let scenes = vec![("figma".to_string(), "Figma walkthrough".to_string())];
    assert_eq!(
        global_shortcut_taken_reason(&config, "Cmd+Shift+R", "mic-toggle", MAC, &scenes).as_deref(),
        Some("Already used by Record / stop recording.")
    );
    assert_eq!(
        global_shortcut_taken_reason(&config, "F13", "mic-toggle", MAC, &scenes).as_deref(),
        Some("Already used by Figma walkthrough.")
    );
    assert_eq!(
        global_shortcut_taken_reason(&config, "Ctrl+Alt+2", "mic-toggle", MAC, &[]).as_deref(),
        Some("Already used by Scene 2.")
    );
    assert_eq!(
        global_shortcut_conflict_reason(Some("Cmd+Shift+R"), MAC, true).as_deref(),
        Some("Another app uses ⇧⌘R")
    );
    assert_eq!(
        global_shortcut_conflict_reason(Some("Cmd+Shift+R"), MAC, false),
        None
    );
    assert_eq!(global_shortcut_conflict_reason(Some("  "), MAC, true), None);
}

/// The tables are still Electron's.
#[test]
fn the_tables_are_the_renderers() {
    let shared = include_str!("../../../../../apps/desktop/src/shared/accelerator.ts");
    let format = include_str!("../../../../../apps/desktop/src/renderer/src/lib/accelerator.ts");
    let owner =
        include_str!("../../../../../apps/desktop/src/renderer/src/lib/global-shortcut-owner.ts");
    for key in RESERVED_MAC.iter().chain(RESERVED_OTHER.iter()) {
        assert!(shared.contains(&format!("'{key}'")), "{key}");
    }
    for code in MODIFIER_CODES {
        assert!(shared.contains(&format!("'{code}'")), "{code}");
    }
    for glyph in ["⌥", "⌘", "⌃", "⇧", "⌫", "⌦", "↵", "⇥", "'Win'"] {
        assert!(format.contains(glyph), "{glyph}");
    }
    assert!(owner.contains("return `Already used by ${label}.`"));
    assert!(owner.contains("return `Another app uses ${acceleratorLabel(accelerator, platform)}`"));
}
