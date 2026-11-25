//! Keyboard accelerators (plan 260 S1.6f, from Electron's plan 062 and plan
//! 174 S1.2): one module reads, prints, records and checks the
//! `CmdOrCtrl+Shift+J` strings every shortcut is stored as.
//!
//! - Reading and printing (`renderer/src/lib/accelerator.ts`, which
//!   `shared/accelerator-format.ts` re-exports): [`parse_accelerator`] and
//!   [`accelerator_label`] ("⇧⌘J" on macOS, "Ctrl+Shift+J" elsewhere), the
//!   keycaps ([`accelerator_display_keys`]) and `aria-keyshortcuts`.
//! - Recording (`shared/accelerator.ts`): a key event becomes an
//!   accelerator by its physical key ([`accelerator_from_key_input`]), one
//!   spelling per binding ([`normalize_accelerator`]), and the rules a global
//!   key must keep ([`validate_accelerator`]).
//! - Owners (`lib/global-shortcut-owner.ts`): the action already holding a
//!   key ([`find_accelerator_owner`]) and the recorder's "Already used by …"
//!   refusal.

use std::collections::BTreeSet;

use super::global_shortcuts::{
    GlobalShortcutsConfig, global_shortcut_entries, global_shortcut_label,
};

/// `AcceleratorModifier`, in the saved order (`MODIFIER_ORDER`): Electron
/// ignores order, but one spelling per binding keeps duplicate detection
/// and diffs honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modifier {
    Cmd,
    Ctrl,
    Alt,
    Shift,
    Super,
}

impl Modifier {
    /// The accelerator's word for it.
    pub fn name(self) -> &'static str {
        match self {
            Modifier::Cmd => "Cmd",
            Modifier::Ctrl => "Ctrl",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
            Modifier::Super => "Super",
        }
    }
}

fn is_mac(platform: Option<&str>) -> bool {
    platform == Some("darwin")
}

/// `ParsedAccelerator`: the modifiers in the saved order and the one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAccelerator {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

impl ParsedAccelerator {
    /// The one spelling: modifiers in order, then the key.
    pub fn spelled(&self) -> String {
        let mut parts: Vec<&str> = self.modifiers.iter().map(|m| m.name()).collect();
        parts.push(&self.key);
        parts.join("+")
    }
}

/// The modifier one part names, or `None` for a key. Command has no effect
/// off macOS in Electron; it has always read as Ctrl there.
fn modifier_for(lower: &str, platform: Option<&str>) -> Option<Modifier> {
    match lower {
        "command" | "cmd" | "commandorcontrol" | "cmdorctrl" => Some(if is_mac(platform) {
            Modifier::Cmd
        } else {
            Modifier::Ctrl
        }),
        "control" | "ctrl" => Some(Modifier::Ctrl),
        "alt" | "option" | "altgr" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "super" | "meta" => Some(if is_mac(platform) {
            Modifier::Cmd
        } else {
            Modifier::Super
        }),
        _ => None,
    }
}

/// `KEY_ALIASES`.
fn key_alias(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "backspace" => "Backspace",
        "delete" => "Delete",
        "down" => "Down",
        "end" => "End",
        "enter" | "return" => "Enter",
        "esc" | "escape" => "Escape",
        "home" => "Home",
        "insert" => "Insert",
        "left" => "Left",
        "pagedown" => "PageDown",
        "pageup" => "PageUp",
        "plus" => "Plus",
        "right" => "Right",
        "space" => "Space",
        "tab" => "Tab",
        "up" => "Up",
        _ => return None,
    })
}

/// `/^f\d{1,2}$/i`: F1, f12 …
fn function_key_number(part: &str) -> Option<u32> {
    let digits = part.strip_prefix(['f', 'F'])?;
    let shaped = (1..=2).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit());
    shaped.then(|| digits.parse().ok()).flatten()
}

/// `keyFor`: a single character upper-cased, an alias, a function key
/// (`F05` → `F5`), a numpad key lower-cased, or the part as written.
fn key_for(part: &str) -> String {
    if part.chars().count() == 1 {
        return part.to_uppercase();
    }
    let lower = part.to_lowercase();
    if let Some(alias) = key_alias(&lower) {
        return alias.to_string();
    }
    if let Some(number) = function_key_number(part) {
        return format!("F{number}");
    }
    if lower.starts_with("num") {
        return lower;
    }
    part.to_string()
}

fn parts(value: Option<&str>) -> Vec<&str> {
    value
        .unwrap_or_default()
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

/// `parseAccelerator`: any Electron spelling, typed by hand too
/// (`Command+Shift+R`, `Control+Alt+C`, `CmdOrCtrl+K`); `None` for an empty
/// value or one without exactly one key.
pub fn parse_accelerator(value: Option<&str>, platform: Option<&str>) -> Option<ParsedAccelerator> {
    let parts = parts(value);
    if parts.is_empty() {
        return None;
    }
    let mut held = BTreeSet::new();
    let mut key: Option<String> = None;
    for part in parts {
        if let Some(modifier) = modifier_for(&part.to_lowercase(), platform) {
            held.insert(modifier);
        } else if key.is_none() {
            key = Some(key_for(part));
        } else {
            return None;
        }
    }
    Some(ParsedAccelerator {
        key: key?,
        modifiers: held.into_iter().collect(),
    })
}

/// macOS menus print ⌃⌥⇧⌘; Windows prints Ctrl+Alt+Shift+Win.
const MAC_DISPLAY_ORDER: [Modifier; 4] = [
    Modifier::Ctrl,
    Modifier::Alt,
    Modifier::Shift,
    Modifier::Cmd,
];
const OTHER_DISPLAY_ORDER: [Modifier; 4] = [
    Modifier::Ctrl,
    Modifier::Alt,
    Modifier::Shift,
    Modifier::Super,
];

fn modifier_glyph(modifier: Modifier, platform: Option<&str>) -> &'static str {
    if is_mac(platform) {
        match modifier {
            Modifier::Alt => "⌥",
            Modifier::Cmd | Modifier::Super => "⌘",
            Modifier::Ctrl => "⌃",
            Modifier::Shift => "⇧",
        }
    } else {
        match modifier {
            Modifier::Alt => "Alt",
            Modifier::Cmd | Modifier::Ctrl => "Ctrl",
            Modifier::Shift => "Shift",
            Modifier::Super => "Win",
        }
    }
}

/// macOS draws its own key glyphs; Windows and Linux say the key's name,
/// never a Mac glyph (I-18).
fn key_glyph(key: &str, platform: Option<&str>) -> Option<&'static str> {
    let mac = is_mac(platform);
    Some(match key {
        "Backspace" if mac => "⌫",
        "Delete" if mac => "⌦",
        "Enter" if mac => "↵",
        "Tab" if mac => "⇥",
        "Down" => "↓",
        "Escape" => "Esc",
        "Left" => "←",
        "Plus" => "+",
        "Right" => "→",
        "Up" => "↑",
        _ => return None,
    })
}

/// `acceleratorModifierLabels`: the modifiers in display order. Cmd reads as
/// Ctrl off macOS, and Super as Cmd on it.
pub fn accelerator_modifier_labels(modifiers: &[Modifier], platform: Option<&str>) -> Vec<String> {
    let mac = is_mac(platform);
    let present: BTreeSet<Modifier> = modifiers
        .iter()
        .map(|modifier| match modifier {
            Modifier::Cmd if !mac => Modifier::Ctrl,
            Modifier::Super if mac => Modifier::Cmd,
            other => *other,
        })
        .collect();
    let order = if mac {
        MAC_DISPLAY_ORDER
    } else {
        OTHER_DISPLAY_ORDER
    };
    order
        .iter()
        .filter(|modifier| present.contains(*modifier))
        .map(|modifier| modifier_glyph(*modifier, platform).to_string())
        .collect()
}

/// `parseModifiersOnly`: a modifier named alone (`Shift`, `Alt`), as a hint
/// for a drag, or `None` when the value names a key too.
fn parse_modifiers_only(value: Option<&str>, platform: Option<&str>) -> Option<Vec<Modifier>> {
    let parts = parts(value);
    if parts.is_empty() {
        return None;
    }
    let mut held = BTreeSet::new();
    for part in parts {
        let modifier = match part.to_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "cmd" => {
                if is_mac(platform) {
                    Modifier::Cmd
                } else {
                    Modifier::Ctrl
                }
            }
            "ctrl" | "control" => Modifier::Ctrl,
            "alt" | "option" => Modifier::Alt,
            "shift" => Modifier::Shift,
            _ => return None,
        };
        held.insert(modifier);
    }
    Some(held.into_iter().collect())
}

/// `acceleratorDisplayKeys`: the parts in display order (`["⇧", "⌘", "M"]`,
/// `["Ctrl", "Shift", "M"]`); nothing when unassigned, the raw value when it
/// cannot be read.
pub fn accelerator_display_keys(accelerator: Option<&str>, platform: Option<&str>) -> Vec<String> {
    let Some(parsed) = parse_accelerator(accelerator, platform) else {
        if let Some(modifiers) = parse_modifiers_only(accelerator, platform) {
            return accelerator_modifier_labels(&modifiers, platform);
        }
        return accelerator
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
            .map(|raw| vec![raw.to_string()])
            .unwrap_or_default();
    };
    let mut keys = accelerator_modifier_labels(&parsed.modifiers, platform);
    keys.push(
        key_glyph(&parsed.key, platform)
            .map(str::to_string)
            .unwrap_or(parsed.key),
    );
    keys
}

/// `acceleratorLabel`: the one way a combination reads. macOS glyphs in
/// system order with no separator ("⇧⌘J", "⌘↵", "Space"); words joined by
/// "+" elsewhere ("Ctrl+Shift+J", "Ctrl+Enter", "Backspace").
pub fn accelerator_label(accelerator: Option<&str>, platform: Option<&str>) -> String {
    let separator = if is_mac(platform) { "" } else { "+" };
    accelerator_display_keys(accelerator, platform).join(separator)
}

/// `acceleratorModifiersLabel`: modifiers held mid-press: "⇧⌘", "Ctrl+Shift".
pub fn accelerator_modifiers_label(modifiers: &[Modifier], platform: Option<&str>) -> String {
    let separator = if is_mac(platform) { "" } else { "+" };
    accelerator_modifier_labels(modifiers, platform).join(separator)
}

/// `acceleratorAriaKeyShortcuts`: UI Events key names, Meta on macOS and
/// Control elsewhere, as the keys really are; empty when nothing parses.
pub fn accelerator_aria_key_shortcuts(accelerator: Option<&str>, platform: Option<&str>) -> String {
    let Some(parsed) = parse_accelerator(accelerator, platform) else {
        return String::new();
    };
    let order = [
        Modifier::Ctrl,
        Modifier::Alt,
        Modifier::Shift,
        Modifier::Cmd,
        Modifier::Super,
    ];
    let mut names: Vec<&str> = Vec::new();
    for modifier in order {
        if !parsed.modifiers.contains(&modifier) {
            continue;
        }
        let name = match modifier {
            Modifier::Alt => "Alt",
            Modifier::Cmd | Modifier::Super => "Meta",
            Modifier::Ctrl => "Control",
            Modifier::Shift => "Shift",
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let key = match parsed.key.as_str() {
        "Down" => "ArrowDown",
        "Left" => "ArrowLeft",
        "Plus" => "+",
        "Right" => "ArrowRight",
        "Up" => "ArrowUp",
        other => other,
    };
    names.push(key);
    names.join("+")
}

/// `commandModifierHeld`: ⌘ on macOS, Ctrl elsewhere. A shell shortcut takes
/// only that key, so ⌃K and ⌃P stay text editing on a Mac (A-17).
pub fn command_modifier_held(meta: bool, control: bool, platform: Option<&str>) -> bool {
    if is_mac(platform) { meta } else { control }
}

// ── Recording a key (`shared/accelerator.ts`) ─────────────────────────────

/// `AcceleratorKeyInput`: the part of a key event the recorder reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyInput {
    /// `keyUp` (true) or `keyDown`.
    pub key_up: bool,
    /// The physical key (`KeyM`, `Digit1`, `ArrowLeft`), never the character.
    pub code: String,
    pub meta: bool,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

/// `AcceleratorKeyResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyResult {
    /// Only modifiers are held (or one was released): show them live.
    Modifiers(Vec<Modifier>),
    Combo {
        accelerator: String,
        modifiers: Vec<Modifier>,
    },
    /// Esc with no modifiers.
    Cancel,
    /// Backspace or Delete with no modifiers.
    Clear,
    /// A key with no accelerator name (IME, media, AltGr …).
    Unsupported(Vec<Modifier>),
}

const MODIFIER_CODES: [&str; 12] = [
    "MetaLeft",
    "MetaRight",
    "OSLeft",
    "OSRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "ShiftLeft",
    "ShiftRight",
    "CapsLock",
    "Fn",
];

/// `NAMED_CODES`.
fn named_code(code: &str) -> Option<&'static str> {
    Some(match code {
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Space" => "Space",
        "Enter" | "NumpadEnter" => "Enter",
        "Tab" => "Tab",
        "Backspace" => "Backspace",
        "Delete" => "Delete",
        "Insert" => "Insert",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "PageUp",
        "PageDown" => "PageDown",
        "Escape" => "Escape",
        "Minus" => "-",
        "Equal" => "=",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Backquote" => "`",
        "NumpadAdd" => "numadd",
        "NumpadSubtract" => "numsub",
        "NumpadMultiply" => "nummult",
        "NumpadDivide" => "numdiv",
        "NumpadDecimal" => "numdec",
        _ => return None,
    })
}

/// GPUI's key name (`m`, `5`, `f12`, `up`, `-`; the unmodified key, so ⌥M is
/// `m`) as the DOM `code` [`KeyInput::code`] carries (`KeyM`, `Digit5`,
/// `F12`, `ArrowUp`, `Minus`). A key no shortcut can hold is `Unsupported`,
/// which the recorder refuses.
pub fn code_for_gpui_key(key: &str) -> String {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return format!("Key{}", c.to_ascii_uppercase());
        }
        if c.is_ascii_digit() {
            return format!("Digit{c}");
        }
    }
    if key
        .strip_prefix('f')
        .is_some_and(|n| n.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)))
    {
        return key.to_ascii_uppercase();
    }
    match key {
        "escape" => "Escape",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "enter" => "Enter",
        "space" => "Space",
        "tab" => "Tab",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        "-" => "Minus",
        "=" => "Equal",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "\\" => "Backslash",
        ";" => "Semicolon",
        "'" => "Quote",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        "`" => "Backquote",
        _ => "Unsupported",
    }
    .into()
}

/// `acceleratorKeyFromCode`: the physical key's Electron name. By `code`,
/// not `key`: on macOS ⌥M reports `µ`, and a non-US layout would otherwise
/// save a character Electron cannot register.
pub fn accelerator_key_from_code(code: &str) -> Option<String> {
    let single_digit = |rest: &str| rest.len() == 1 && rest.bytes().all(|b| b.is_ascii_digit());
    if let Some(letter) = code.strip_prefix("Key")
        && letter.len() == 1
        && letter.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Some(letter.to_string());
    }
    if let Some(digit) = code.strip_prefix("Digit")
        && single_digit(digit)
    {
        return Some(digit.to_string());
    }
    if let Some(digit) = code.strip_prefix("Numpad")
        && single_digit(digit)
    {
        return Some(format!("num{digit}"));
    }
    if let Some(number) = code.strip_prefix('F')
        && (1..=2).contains(&number.len())
        && number.bytes().all(|b| b.is_ascii_digit())
    {
        let number: u32 = number.parse().unwrap_or(0);
        if (1..=24).contains(&number) {
            return Some(format!("F{number}"));
        }
    }
    named_code(code).map(str::to_string)
}

fn held_modifiers(input: &KeyInput, platform: Option<&str>) -> Vec<Modifier> {
    let mut held = BTreeSet::new();
    if input.meta {
        held.insert(if is_mac(platform) {
            Modifier::Cmd
        } else {
            Modifier::Super
        });
    }
    if input.control {
        held.insert(Modifier::Ctrl);
    }
    if input.alt {
        held.insert(Modifier::Alt);
    }
    if input.shift {
        held.insert(Modifier::Shift);
    }
    held.into_iter().collect()
}

/// `acceleratorFromKeyInput`: one key event while the recorder is armed.
pub fn accelerator_from_key_input(input: &KeyInput, platform: Option<&str>) -> KeyResult {
    let modifiers = held_modifiers(input, platform);
    if input.key_up || MODIFIER_CODES.contains(&input.code.as_str()) {
        return KeyResult::Modifiers(modifiers);
    }
    if modifiers.is_empty() && input.code == "Escape" {
        return KeyResult::Cancel;
    }
    if modifiers.is_empty() && (input.code == "Backspace" || input.code == "Delete") {
        return KeyResult::Clear;
    }
    let Some(key) = accelerator_key_from_code(&input.code) else {
        return KeyResult::Unsupported(modifiers);
    };
    let mut parts: Vec<&str> = modifiers.iter().map(|m| m.name()).collect();
    parts.push(&key);
    KeyResult::Combo {
        accelerator: parts.join("+"),
        modifiers,
    }
}

/// `normalizeAccelerator`: one spelling per binding for this platform, or
/// `None` when there is nothing to register. A pre-062 `Cmd+Shift+R` on
/// Windows binds Ctrl+Shift+R, which the UI always showed.
pub fn normalize_accelerator(value: Option<&str>, platform: Option<&str>) -> Option<String> {
    parse_accelerator(value, platform).map(|parsed| parsed.spelled())
}

/// Why a combination cannot be a global key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceleratorRefusal {
    /// It needs ⌘, ⌃ or ⌥ (Ctrl, Alt or Win), or it is a bare letter.
    NeedsModifier,
    /// The system's own key in every app (⌘Q, Alt+F4 …).
    SystemReserved,
}

/// A global key takes the key away from every app, so these would break the
/// machine rather than add a shortcut. Stored normalized.
const RESERVED_MAC: [&str; 12] = [
    "Cmd+Q",
    "Cmd+W",
    "Cmd+H",
    "Cmd+M",
    "Cmd+Tab",
    "Cmd+Space",
    "Cmd+C",
    "Cmd+V",
    "Cmd+X",
    "Cmd+Z",
    "Cmd+Shift+Z",
    "Cmd+A",
];
const RESERVED_OTHER: [&str; 10] = [
    "Ctrl+C",
    "Ctrl+V",
    "Ctrl+X",
    "Ctrl+Z",
    "Ctrl+Y",
    "Ctrl+A",
    "Alt+F4",
    "Alt+Tab",
    "Ctrl+Alt+Delete",
    "Ctrl+Shift+Escape",
];

/// `validateAccelerator`. Shift alone does not count (a global Shift+M would
/// take capital M from every app); a bare F-key is allowed, since Stream
/// Deck hotkeys commonly send F13–F24, which no keyboard types with.
pub fn validate_accelerator(
    accelerator: &str,
    platform: Option<&str>,
) -> Result<(), AcceleratorRefusal> {
    let parsed =
        parse_accelerator(Some(accelerator), platform).ok_or(AcceleratorRefusal::NeedsModifier)?;
    let function_key = parsed
        .key
        .strip_prefix('F')
        .is_some_and(|n| (1..=2).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()));
    let real_modifier = parsed
        .modifiers
        .iter()
        .any(|modifier| *modifier != Modifier::Shift);
    if !real_modifier && !function_key {
        return Err(AcceleratorRefusal::NeedsModifier);
    }
    let reserved: &[&str] = if is_mac(platform) {
        &RESERVED_MAC
    } else {
        &RESERVED_OTHER
    };
    if reserved.contains(&parsed.spelled().as_str()) {
        return Err(AcceleratorRefusal::SystemReserved);
    }
    Ok(())
}

/// `findAcceleratorOwner`: the other action that already holds this
/// combination, across the action rows, the default positions and the
/// scenes' own keys.
pub fn find_accelerator_owner(
    config: &GlobalShortcutsConfig,
    accelerator: &str,
    except_action: &str,
    platform: Option<&str>,
) -> Option<String> {
    let wanted = normalize_accelerator(Some(accelerator), platform)?;
    global_shortcut_entries(config, platform)
        .into_iter()
        .find(|(action, value)| {
            action != except_action
                && normalize_accelerator(value.as_deref(), platform).as_deref()
                    == Some(wanted.as_str())
        })
        .map(|(action, _)| action)
}

/// `globalShortcutTakenReason`: the recorder's refusal when another action
/// has the keys: "Already used by Record / stop recording.", or by a saved
/// scene's name (`scenes` as (id, name)).
pub fn global_shortcut_taken_reason(
    config: &GlobalShortcutsConfig,
    accelerator: &str,
    action: &str,
    platform: Option<&str>,
    scenes: &[(String, String)],
) -> Option<String> {
    let owner = find_accelerator_owner(config, accelerator, action, platform)?;
    let scene_name = owner.strip_prefix("scene:").and_then(|id| {
        scenes
            .iter()
            .find(|(scene_id, _)| scene_id == id)
            .map(|(_, name)| name.clone())
    });
    let label = scene_name.unwrap_or_else(|| global_shortcut_label(&owner));
    Some(format!("Already used by {label}."))
}

/// `globalShortcutConflictReason`: the failed OS registration, named on its
/// Settings row and scene chip.
pub fn global_shortcut_conflict_reason(
    accelerator: Option<&str>,
    platform: Option<&str>,
    registration_failed: bool,
) -> Option<String> {
    let accelerator = accelerator.filter(|key| !key.trim().is_empty())?;
    registration_failed.then(|| {
        format!(
            "Another app uses {}",
            accelerator_label(Some(accelerator), platform)
        )
    })
}

#[cfg(test)]
mod tests;
