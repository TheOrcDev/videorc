//! StatusBarAction (`components/status-bar-action.tsx`): one action in a
//! status bar, as an icon, a word, or both, and optionally its shortcut.
//!
//! `label` is the action's name: what a screen reader says, and the tooltip
//! of an icon alone. `text` is the visible word when there is room for one
//! ("Clip", "Clear"). `hint` says more than the name, in the tooltip.
//! [`StatusBarAction::tooltip`] overrides the tooltip's words when they are
//! neither (the bell is named "Notifications, 2 unread"; its tooltip says
//! "Notifications"), with the shortcut the bar has no room to print. Never
//! a native title. `pressed` marks a toggle that is on.

use std::rc::Rc;

use gpui::{AnyElement, App, ClickEvent, ElementId, IntoElement, SharedString, Window, prelude::*};

use crate::{
    shortcut_keys::ShortcutKeys,
    status_bar::{ClickHandler, Press, TooltipBuilder, keys},
    theme::{Appearance, resolve},
    tooltip::{tooltip, tooltip_with_shortcut},
};

#[derive(IntoElement)]
pub struct StatusBarAction {
    id: ElementId,
    label: SharedString,
    icon: Option<AnyElement>,
    text: Option<SharedString>,
    hint: Option<SharedString>,
    shortcut: Option<ShortcutKeys>,
    pressed: Option<bool>,
    disabled: bool,
    tooltip: Option<SharedString>,
    tooltip_shortcut: Option<&'static str>,
    on_click: Option<ClickHandler>,
    appearance: Option<Appearance>,
    expanded: bool,
}

/// The tooltip's words: the override, else the hint, else the name of an
/// icon alone. A word on the chip needs no tooltip.
pub fn tooltip_words<'a>(
    tooltip: Option<&'a str>,
    hint: Option<&'a str>,
    label: &'a str,
    has_text: bool,
) -> Option<&'a str> {
    tooltip.or(hint).or((!has_text).then_some(label))
}

impl StatusBarAction {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        StatusBarAction {
            id: id.into(),
            label: label.into(),
            icon: None,
            text: None,
            hint: None,
            shortcut: None,
            pressed: None,
            disabled: false,
            tooltip: None,
            tooltip_shortcut: None,
            on_click: None,
            appearance: None,
            expanded: false,
        }
    }

    /// A 14 px icon (`icon(name, ACTION_ICON, …)`).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The visible word.
    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// More than the name, in the tooltip.
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// The shortcut, printed on the chip from the action's own binding.
    pub fn shortcut(mut self, shortcut: ShortcutKeys) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    /// A toggle, on or off.
    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = Some(pressed);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The tooltip's own words, and the shortcut the bar has no room for
    /// (GPUI keystroke syntax, `cmd-shift-j`).
    pub fn tooltip(
        mut self,
        words: impl Into<SharedString>,
        shortcut: Option<&'static str>,
    ) -> Self {
        self.tooltip = Some(words.into());
        self.tooltip_shortcut = shortcut;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// A status-bar action opens a menu (the Stream Manager's Highlight
/// position): it shows as expanded while open.
impl gpui_base::Selectable for StatusBarAction {
    fn selected(mut self, selected: bool) -> Self {
        self.expanded = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.expanded
    }
}

impl RenderOnce for StatusBarAction {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let words = tooltip_words(
            self.tooltip.as_deref(),
            self.hint.as_deref(),
            &self.label,
            self.text.is_some(),
        )
        .map(SharedString::from);
        let tip: Option<TooltipBuilder> = words.map(|words| match self.tooltip_shortcut {
            Some(shortcut) => Box::new(tooltip_with_shortcut(words, shortcut)) as TooltipBuilder,
            None => Box::new(tooltip(words)) as TooltipBuilder,
        });
        let icon_only = self.icon.is_some() && self.text.is_none();
        let mut children = Vec::new();
        children.extend(self.icon);
        if let Some(shortcut) = self.shortcut {
            let shortcut = match self.appearance {
                Some(appearance) => shortcut.appearance(appearance),
                None => shortcut,
            };
            children.push(keys(t, shortcut));
        }
        if let Some(text) = self.text {
            children.push(text.into_any_element());
        }
        Press {
            id: self.id,
            label: self.label,
            pressed: self.pressed,
            disabled: self.disabled,
            expanded: self.expanded,
            icon_only,
            tooltip: tip,
            on_click: self.on_click,
        }
        .render(t, children)
    }
}

#[cfg(test)]
mod tests {
    use super::tooltip_words;

    #[test]
    fn the_tooltip_says_the_override_the_hint_or_an_icon_s_name() {
        assert_eq!(
            tooltip_words(
                Some("Notifications"),
                Some("More"),
                "Notifications, 2 unread",
                false
            ),
            Some("Notifications")
        );
        assert_eq!(
            tooltip_words(None, Some("Saves a clip"), "Clip", true),
            Some("Saves a clip")
        );
        assert_eq!(tooltip_words(None, None, "Pin", false), Some("Pin"));
        assert_eq!(tooltip_words(None, None, "Clip", true), None);
    }
}
