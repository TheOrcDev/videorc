//! PinWindowButton (`components/pin-window-button.tsx`): Keep on top, the
//! pin every detached window shares. One name in every window, a filled pin
//! while the window stays over other apps, a pressed state a screen reader
//! hears, and a header or a status-bar look.
//!
//! The header look sits in a [`WindowHeader`](crate::WindowHeader) (Notes,
//! the Captions reader). The status-bar look is a
//! [`StatusBarAction`](crate::StatusBarAction) (Stream Manager, whose title
//! row stays bare).

use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, InteractiveElement, IntoElement, SharedString, Window, prelude::*,
    px,
};

use crate::{
    chrome::focus_ring,
    icon::{IconName, icon},
    status_bar::ACTION_ICON,
    status_bar_action::StatusBarAction,
    theme::{Appearance, hsla, resolve},
    tokens::{radius, size},
    tooltip::tooltip,
};

/// The control's one name in every window.
pub const PIN_WINDOW_LABEL: &str = "Keep on top";

/// The pin's size in a WindowHeader (the ghost icon button).
const HEADER_ICON: f32 = 16.0;

type ChangeHandler = Rc<dyn Fn(bool, &ClickEvent, &mut Window, &mut App)>;

/// Where the pin sits: in a header, or in a status bar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PinLook {
    #[default]
    Header,
    StatusBar,
}

#[derive(IntoElement)]
pub struct PinWindowButton {
    id: ElementId,
    pinned: bool,
    look: PinLook,
    on_pinned_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl PinWindowButton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        PinWindowButton {
            id: id.into(),
            pinned: false,
            look: PinLook::Header,
            on_pinned_change: None,
            appearance: None,
        }
    }

    /// The window stays over other apps.
    pub fn pinned(mut self, pinned: bool) -> Self {
        self.pinned = pinned;
        self
    }

    /// The status-bar look: a [`StatusBarAction`] for a window whose title
    /// row stays bare (Stream Manager).
    pub fn status_bar(mut self) -> Self {
        self.look = PinLook::StatusBar;
        self
    }

    /// Called with the state a click asks for.
    pub fn on_pinned_change(
        mut self,
        handler: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_pinned_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for PinWindowButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let pinned = self.pinned;
        let next = !pinned;
        let glyph = icon(
            if pinned {
                IconName::PushPinFill
            } else {
                IconName::PushPin
            },
            match self.look {
                PinLook::Header => HEADER_ICON,
                PinLook::StatusBar => ACTION_ICON,
            },
            hsla(if pinned {
                t.foreground
            } else {
                t.muted_foreground
            }),
        );
        match self.look {
            PinLook::StatusBar => {
                let mut action = StatusBarAction::new(self.id, PIN_WINDOW_LABEL)
                    .icon(glyph)
                    .pressed(pinned);
                if let Some(appearance) = self.appearance {
                    action = action.appearance(appearance);
                }
                if let Some(on_change) = self.on_pinned_change {
                    action = action.on_click(move |event, window, cx| {
                        on_change(next, event, window, cx);
                    });
                }
                action.into_any_element()
            }
            PinLook::Header => {
                let hover = if crate::theme::is_dark(t) {
                    crate::theme::with_alpha(t.muted, 0.5)
                } else {
                    t.muted
                };
                let ring = focus_ring(t);
                let mut toggle = gpui_base::Toggle::new(self.id)
                    .pressed(pinned)
                    .accessibility_label(SharedString::from(PIN_WINDOW_LABEL))
                    .flex_none()
                    .size(px(size::CONTROL))
                    .rounded(px(radius::CHIP))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(hsla(if pinned {
                        t.foreground
                    } else {
                        t.muted_foreground
                    }))
                    .hover(move |style| style.bg(hsla(hover)).text_color(hsla(t.foreground)))
                    .focus(|style| style.shadow(vec![ring]))
                    .tooltip(tooltip(SharedString::from(PIN_WINDOW_LABEL)));
                if let Some(on_change) = self.on_pinned_change {
                    toggle = toggle.on_change(move |_, event, window, cx| {
                        on_change(next, event, window, cx);
                    });
                }
                toggle.child(glyph).into_any_element()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PIN_WINDOW_LABEL;

    #[test]
    fn the_name_is_keep_on_top_in_every_window() {
        assert_eq!(PIN_WINDOW_LABEL, "Keep on top");
    }
}
