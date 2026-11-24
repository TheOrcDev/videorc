//! StatusBar and StatusBarHint (`components/status-bar.tsx`): the window's
//! 26 px status bar, the state on the left and quiet shortcut hints on the
//! right. It replaces a footer shortcut bar; the hints stay clickable, so
//! the app is still keyboard-first, only quieter.
//!
//! Every clickable thing in a status bar is the same chip ([`action_chip`]):
//! 20 px, 11 px text at the body's weight in the tertiary tier that
//! brightens on hover, the foreground while pressed, on the chip radius.
//! Icons inside are 14 px. StatusBarHint and StatusBarAction
//! (`status_bar_action.rs`) share it.

use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, ClickEvent, ElementId, FontWeight, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    shortcut_keys::{ShortcutKeys, ShortcutStyle},
    theme::{Appearance, faded_over, hsla, resolve},
    tokens::{Theme, radius, size, text},
};

pub(crate) type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
pub(crate) type TooltipBuilder = Box<dyn Fn(&mut Window, &mut App) -> AnyView>;

/// A status bar chip's height.
pub const ACTION_HEIGHT: f32 = 20.0;
/// The icons inside a chip.
pub const ACTION_ICON: f32 = 14.0;

/// The window's status bar.
#[derive(IntoElement)]
pub struct StatusBar {
    leading: SmallVec<[AnyElement; 2]>,
    children: SmallVec<[AnyElement; 4]>,
    appearance: Option<Appearance>,
}

impl StatusBar {
    pub fn new() -> Self {
        StatusBar {
            leading: SmallVec::new(),
            children: SmallVec::new(),
            appearance: None,
        }
    }

    /// The state, on the left: the session's own words. The children are
    /// the hints and actions, on the right.
    pub fn leading(mut self, element: impl IntoElement) -> Self {
        self.leading.push(element.into_any_element());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for StatusBar {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for StatusBar {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for StatusBar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        div()
            .flex_none()
            .w_full()
            .h(px(size::STATUS_BAR))
            .flex()
            .items_center()
            .gap(px(12.0))
            .pl(px(12.0))
            .pr(px(6.0))
            .border_t_1()
            .border_color(hsla(t.border))
            .text_size(px(text::LABEL.size))
            .line_height(px(text::LABEL.line_height))
            .font_weight(FontWeight::NORMAL)
            .text_color(hsla(t.muted_foreground))
            .child(
                div()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .children(self.leading),
            )
            .child(
                div()
                    .ml_auto()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .children(self.children),
            )
    }
}

/// The chip every status bar control wears. `icon_only` drops the side
/// bearing a word needs, so a full bar of icons still fits.
pub(crate) fn action_chip<E>(
    element: E,
    t: &Theme,
    pressed: bool,
    disabled: bool,
    icon_only: bool,
) -> E
where
    E: Styled + InteractiveElement,
{
    let ink = if disabled {
        faded_over(t.subtle, t.glass_solid, 0.5)
    } else if pressed {
        t.foreground
    } else {
        t.subtle
    };
    let chip = element
        .flex_none()
        .h(px(ACTION_HEIGHT))
        .flex()
        .items_center()
        .gap(px(4.0))
        .px(px(if icon_only { 4.0 } else { 6.0 }))
        .rounded(px(radius::CHIP))
        .whitespace_nowrap()
        .text_size(px(text::LABEL.size))
        .line_height(px(text::LABEL.line_height))
        .font_weight(FontWeight::NORMAL)
        .text_color(hsla(ink));
    if disabled {
        return chip;
    }
    let (accent, foreground) = (hsla(t.accent), hsla(t.foreground));
    chip.hover(move |style| style.bg(accent).text_color(foreground))
}

/// The chip's control: a toggle when it has a pressed state, else a button.
/// Both carry focus, the keyboard and the accessibility name.
pub(crate) struct Press {
    pub id: ElementId,
    pub label: SharedString,
    pub pressed: Option<bool>,
    pub disabled: bool,
    pub icon_only: bool,
    pub tooltip: Option<TooltipBuilder>,
    pub on_click: Option<ClickHandler>,
}

impl Press {
    pub fn render(self, t: &Theme, children: Vec<AnyElement>) -> AnyElement {
        let on = self.pressed.unwrap_or(false);
        let Press {
            id,
            label,
            pressed,
            disabled,
            icon_only,
            tooltip,
            on_click,
        } = self;
        if pressed.is_some() {
            let mut toggle = gpui_base::Toggle::new(id)
                .pressed(on)
                .disabled(disabled)
                .accessibility_label(label);
            toggle = action_chip(toggle, t, on, disabled, icon_only);
            if let Some(tooltip) = tooltip {
                toggle = toggle.tooltip(move |window, cx| tooltip(window, cx));
            }
            if let Some(on_click) = on_click {
                toggle = toggle.on_change(move |_, event, window, cx| on_click(event, window, cx));
            }
            return toggle.children(children).into_any_element();
        }
        let mut button = gpui_base::Button::new(id)
            .disabled(disabled)
            .accessibility_label(label);
        button = action_chip(button, t, false, disabled, icon_only);
        if let Some(tooltip) = tooltip {
            button = button.tooltip(move |window, cx| tooltip(window, cx));
        }
        if let Some(on_click) = on_click {
            button = button.on_click(move |event, window, cx| on_click(event, window, cx));
        }
        button.children(children).into_any_element()
    }
}

/// The shortcut in the secondary tier, a step above its tertiary word.
pub(crate) fn keys(t: &Theme, shortcut: ShortcutKeys) -> AnyElement {
    div()
        .text_color(hsla(t.muted_foreground))
        .child(shortcut.style(ShortcutStyle::Text))
        .into_any_element()
}

/// One clickable hint: the shortcut, then the action. `pressed` marks a
/// window that is open (the hint then closes it).
#[derive(IntoElement)]
pub struct StatusBarHint {
    id: ElementId,
    label: SharedString,
    shortcut: ShortcutKeys,
    show_label: bool,
    pressed: Option<bool>,
    on_click: Option<ClickHandler>,
    appearance: Option<Appearance>,
}

impl StatusBarHint {
    /// `shortcut` is the action's own binding
    /// (`ShortcutKeys::for_action(&ToggleNotes)`), so the hint cannot drift
    /// from the key.
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        shortcut: ShortcutKeys,
    ) -> Self {
        StatusBarHint {
            id: id.into(),
            label: label.into(),
            shortcut,
            show_label: true,
            pressed: None,
            on_click: None,
            appearance: None,
        }
    }

    /// Hides the word and keeps the key alone (a narrow window); the word
    /// stays the control's accessible name.
    pub fn show_label(mut self, show: bool) -> Self {
        self.show_label = show;
        self
    }

    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = Some(pressed);
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

impl RenderOnce for StatusBarHint {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let shortcut = match self.appearance {
            Some(appearance) => self.shortcut.appearance(appearance),
            None => self.shortcut,
        };
        let mut children = vec![keys(t, shortcut)];
        if self.show_label {
            children.push(self.label.clone().into_any_element());
        }
        Press {
            id: self.id,
            label: self.label,
            pressed: self.pressed,
            disabled: false,
            icon_only: false,
            tooltip: None,
            on_click: self.on_click,
        }
        .render(t, children)
    }
}
