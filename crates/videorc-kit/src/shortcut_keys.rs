//! ShortcutKeys: the one way to show a shortcut
//! (`components/ui/shortcut-keys.tsx`). It reads the binding from GPUI's
//! keymap, so the chip cannot drift from the key that runs the action, and
//! prints it the way the platform's own menus do: one keycap in system
//! order on macOS (⇧⌘J, ⌘↵, Space), words joined by "+" on Windows and
//! Linux (Ctrl+Shift+J, Ctrl+Enter, Backspace).
//!
//! This is the one module that may spell a key glyph; the design guards
//! reject them anywhere else.

use std::cell::RefCell;

use gpui::{
    Action, App, FontWeight, IntoElement, KeyBinding, Keystroke, Modifiers, OperatingSystem,
    SharedString, Window, div, prelude::*,
};

use crate::{kbd::Kbd, theme::Appearance, tokens::Color};

/// How a shortcut reads: a keycap, or the status bar's quiet text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShortcutStyle {
    #[default]
    Chip,
    Text,
}

enum Source {
    Action(Box<dyn Action>),
    Keystrokes(Vec<Keystroke>),
}

#[derive(IntoElement)]
pub struct ShortcutKeys {
    source: Source,
    style: ShortcutStyle,
    mac: bool,
    on_filled: Option<Color>,
    appearance: Option<Appearance>,
}

impl ShortcutKeys {
    /// The binding the keymap gives `action`: the one that matches the
    /// rendered frame's contexts, else the last one bound in any context;
    /// shows nothing when the action has no binding at all.
    pub fn for_action(action: &dyn Action) -> Self {
        Self::from_source(Source::Action(action.boxed_clone()))
    }

    /// A fixed keystroke sequence in GPUI's syntax (`cmd-shift-j`), for the
    /// docs and the gallery; screens use `for_action`.
    pub fn keystrokes(source: &'static str) -> Self {
        Self::keystrokes_owned(source)
    }

    /// Runtime GPUI keystrokes (`cmd-shift-j`), for tooltips fed by a live
    /// keymap without `Box::leak`.
    pub fn keystrokes_owned(source: impl Into<SharedString>) -> Self {
        let source = source.into();
        let os = if cfg!(target_os = "macos") {
            OperatingSystem::Mac
        } else if cfg!(target_os = "windows") {
            OperatingSystem::Windows
        } else {
            OperatingSystem::Linux
        };
        let strokes = source
            .split_whitespace()
            .filter_map(|stroke| Keystroke::parse_with_os(stroke, os).ok())
            .collect();
        Self::from_source(Source::Keystrokes(strokes))
    }

    /// An Electron accelerator (`CmdOrCtrl+Shift+J`) printed the way the
    /// platform's menus do. Runtime string; for tooltips from a live keymap.
    pub fn accelerator(source: impl Into<SharedString>) -> Self {
        let source = source.into();
        let mac = cfg!(target_os = "macos");
        let strokes = parse_accelerator(&source, mac).into_iter().collect();
        Self::from_source(Source::Keystrokes(strokes))
    }

    fn from_source(source: Source) -> Self {
        ShortcutKeys {
            source,
            style: ShortcutStyle::Chip,
            mac: cfg!(target_os = "macos"),
            on_filled: None,
            appearance: None,
        }
    }

    pub fn style(mut self, style: ShortcutStyle) -> Self {
        self.style = style;
        self
    }

    /// Prints for macOS (`true`) or for Windows and Linux, whatever this
    /// build runs on (the docs show both).
    pub fn mac(mut self, mac: bool) -> Self {
        self.mac = mac;
        self
    }

    /// Inside a filled button: the chip takes the button's ink.
    pub fn on_filled(mut self, ink: Color) -> Self {
        self.on_filled = Some(ink);
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for ShortcutKeys {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let strokes: Vec<(Modifiers, String)> = match &self.source {
            Source::Action(action) => window
                .highest_precedence_binding_for_action(action.as_ref())
                .or_else(|| any_context_binding(action.as_ref(), cx))
                .map(|binding| {
                    binding
                        .keystrokes()
                        .iter()
                        .map(|stroke| (*stroke.modifiers(), stroke.key().to_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            Source::Keystrokes(strokes) => strokes
                .iter()
                .map(|stroke| (stroke.modifiers, stroke.key.clone()))
                .collect(),
        };
        let text = label(
            strokes
                .iter()
                .map(|(modifiers, key)| (*modifiers, key.as_str())),
            self.mac,
        );
        if text.is_empty() {
            return div().into_any_element();
        }
        match self.style {
            ShortcutStyle::Text => div()
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(text))
                .into_any_element(),
            ShortcutStyle::Chip => {
                let mut chip = Kbd::new(text);
                if let Some(ink) = self.on_filled {
                    chip = chip.on_filled(ink);
                }
                if let Some(appearance) = self.appearance {
                    chip = chip.appearance(appearance);
                }
                chip.into_any_element()
            }
        }
    }
}

/// The last binding the keymap holds for `action` in any context.
///
/// `Window::highest_precedence_binding_for_action` matches against the
/// rendered frame's build-time context stack, which is empty once the frame
/// is done, so every binding gated on a key context (`Workspace`,
/// `StudioScreen`, ...) came back as none and the chip drew blank. The chip
/// names the key that runs the action where it is bound, like Electron's
/// menus and chips do, so it falls back to the keymap itself; the last
/// binding added wins, as GPUI orders them for display.
fn any_context_binding(action: &dyn Action, cx: &App) -> Option<KeyBinding> {
    let keymap = cx.key_bindings();
    let keymap = RefCell::borrow(&keymap);

    keymap.bindings_for_action(action).next_back().cloned()
}

/// A key's name as the platform prints it.
fn key_label(key: &str, mac: bool) -> String {
    let named = match (key, mac) {
        ("backspace", true) => "⌫",
        ("delete", true) => "⌦",
        ("enter", true) => "↵",
        ("tab", true) => "⇥",
        ("backspace", false) => "Backspace",
        ("delete", false) => "Delete",
        ("enter", false) => "Enter",
        ("tab", false) => "Tab",
        ("escape", _) => "Esc",
        ("space", _) => "Space",
        ("up", _) => "↑",
        ("down", _) => "↓",
        ("left", _) => "←",
        ("right", _) => "→",
        ("pageup", _) => "PageUp",
        ("pagedown", _) => "PageDown",
        ("home", _) => "Home",
        ("end", _) => "End",
        ("insert", _) => "Insert",
        _ => "",
    };
    if !named.is_empty() {
        return named.to_owned();
    }
    if key.len() > 1 && key.starts_with('f') && key[1..].chars().all(|c| c.is_ascii_digit()) {
        return key.to_uppercase();
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(only), None) => only.to_uppercase().collect(),
        _ => key.to_owned(),
    }
}

/// Electron accelerator (`CmdOrCtrl+Shift+J`) → GPUI [`Keystroke`]s for this
/// platform. Several strokes may be space-separated in one accelerator.
pub fn parse_accelerator(source: &str, mac: bool) -> Vec<Keystroke> {
    source
        .split_whitespace()
        .filter_map(|stroke| parse_one_accelerator(stroke, mac))
        .collect()
}

fn parse_one_accelerator(source: &str, mac: bool) -> Option<Keystroke> {
    let mut modifiers = Modifiers::default();
    let mut key = None::<String>;
    for part in source.split('+') {
        let lower = part.trim().to_ascii_lowercase();
        match lower.as_str() {
            "command" | "cmd" | "commandorcontrol" | "cmdorctrl" => {
                if mac {
                    modifiers.platform = true;
                } else {
                    modifiers.control = true;
                }
            }
            "control" | "ctrl" => modifiers.control = true,
            "alt" | "option" => modifiers.alt = true,
            "shift" => modifiers.shift = true,
            "super" | "meta" | "win" => modifiers.platform = true,
            "" => {}
            other => {
                let aliased = match other {
                    "return" => "enter",
                    "esc" => "escape",
                    "plus" => "+",
                    _ => other,
                };
                key = Some(aliased.to_owned());
            }
        }
    }
    let key = key?;
    // Rebuild through GPUI's parser so key aliases stay consistent.
    let mut parts = Vec::new();
    if modifiers.control {
        parts.push("ctrl");
    }
    if modifiers.alt {
        parts.push("alt");
    }
    if modifiers.shift {
        parts.push("shift");
    }
    if modifiers.platform {
        parts.push("cmd");
    }
    parts.push(key.as_str());
    let os = if mac {
        OperatingSystem::Mac
    } else {
        OperatingSystem::Windows
    };
    Keystroke::parse_with_os(&parts.join("-"), os).ok()
}

/// A keystroke sequence as the platform's menus print it: macOS glyphs in
/// system order (⌃⌥⇧⌘) with no separator, words joined by "+" elsewhere;
/// strokes in a sequence are spaced.
pub fn label<'a>(strokes: impl IntoIterator<Item = (Modifiers, &'a str)>, mac: bool) -> String {
    strokes
        .into_iter()
        .map(|(modifiers, key)| {
            let mut parts: Vec<String> = Vec::new();
            let held = [
                (modifiers.control, "⌃", "Ctrl"),
                (modifiers.alt, "⌥", "Alt"),
                (modifiers.shift, "⇧", "Shift"),
                (modifiers.platform, "⌘", "Win"),
            ];
            for (down, glyph, word) in held {
                if down {
                    parts.push(if mac { glyph } else { word }.to_owned());
                }
            }
            parts.push(key_label(key, mac));
            parts.join(if mac { "" } else { "+" })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &'static str) -> Keystroke {
        Keystroke::parse(source).expect(source)
    }

    fn read(source: &'static str, mac: bool) -> String {
        let stroke = parse(source);
        label([(stroke.modifiers, stroke.key.as_str())], mac)
    }

    #[test]
    fn prints_macos_glyphs_in_system_order() {
        assert_eq!(read("cmd-shift-j", true), "⇧⌘J");
        assert_eq!(read("cmd-enter", true), "⌘↵");
        assert_eq!(read("ctrl-alt-shift-cmd-k", true), "⌃⌥⇧⌘K");
        assert_eq!(read("space", true), "Space");
    }

    #[test]
    fn parses_electron_accelerators() {
        let mac = parse_accelerator("CmdOrCtrl+Shift+J", true);
        assert_eq!(mac.len(), 1);
        assert_eq!(
            label([(mac[0].modifiers, mac[0].key.as_str())], true),
            "⇧⌘J"
        );
        let win = parse_accelerator("CmdOrCtrl+Shift+J", false);
        assert_eq!(
            label([(win[0].modifiers, win[0].key.as_str())], false),
            "Ctrl+Shift+J"
        );
    }

    #[test]
    fn prints_words_elsewhere() {
        assert_eq!(read("ctrl-shift-j", false), "Ctrl+Shift+J");
        assert_eq!(read("ctrl-enter", false), "Ctrl+Enter");
        assert_eq!(read("backspace", false), "Backspace");
        assert_eq!(read("f5", false), "F5");
    }
}
