//! Checkbox (`components/ui/checkbox.tsx`): gpui-base's Checkbox for the
//! behaviour (pointer, Space, focus, AccessKit checked / mixed), Liquid
//! Chrome for the look. Checked and mixed wear the chrome fill; mixed draws
//! a dash instead of the check. A header "Select all" over some of its rows
//! is mixed. Disabled with a reason shows the reason under the control.

use std::rc::Rc;

use gpui::{App, ElementId, IntoElement, SharedString, Window, div, prelude::*, px};

use crate::{
    chrome::{self, Direction},
    icon::{IconName, icon},
    theme::{Appearance, TypeScale, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, radius, text},
};

/// Checked, unchecked, or mixed (indeterminate) — a "Select all" over some
/// of its rows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CheckboxChecked {
    #[default]
    Unchecked,
    Checked,
    /// Some of the rows under a header checkbox are selected.
    Mixed,
}

impl From<CheckboxChecked> for gpui_base::CheckboxState {
    fn from(value: CheckboxChecked) -> Self {
        match value {
            CheckboxChecked::Unchecked => gpui_base::CheckboxState::Unchecked,
            CheckboxChecked::Checked => gpui_base::CheckboxState::Checked,
            CheckboxChecked::Mixed => gpui_base::CheckboxState::Indeterminate,
        }
    }
}

impl From<gpui_base::CheckboxState> for CheckboxChecked {
    fn from(value: gpui_base::CheckboxState) -> Self {
        match value {
            gpui_base::CheckboxState::Unchecked => CheckboxChecked::Unchecked,
            gpui_base::CheckboxState::Checked => CheckboxChecked::Checked,
            gpui_base::CheckboxState::Indeterminate => CheckboxChecked::Mixed,
        }
    }
}

type ChangeHandler = Rc<dyn Fn(CheckboxChecked, &mut Window, &mut App)>;

const SIZE: f32 = 16.0;

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: CheckboxChecked,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Checkbox {
            id: id.into(),
            checked: CheckboxChecked::Unchecked,
            disabled: false,
            disabled_reason: None,
            ground: None,
            accessibility_label: None,
            on_change: None,
            appearance: None,
        }
    }

    /// Checked or unchecked. Clears mixed.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = if checked {
            CheckboxChecked::Checked
        } else {
            CheckboxChecked::Unchecked
        };
        self
    }

    /// Mixed (indeterminate): a header over some selected rows. When true,
    /// overrides [`Checkbox::checked`].
    pub fn mixed(mut self, mixed: bool) -> Self {
        if mixed {
            self.checked = CheckboxChecked::Mixed;
        } else if self.checked == CheckboxChecked::Mixed {
            self.checked = CheckboxChecked::Unchecked;
        }
        self
    }

    /// Sets checked, unchecked or mixed in one call.
    pub fn state(mut self, state: CheckboxChecked) -> Self {
        self.checked = state;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Why the control is disabled: shown under it while `disabled`.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// The colour the checkbox sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    /// The name a screen reader reads when no label names the checkbox.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Called with the next state. Mixed activates to checked (Select all).
    pub fn on_change(
        mut self,
        handler: impl Fn(CheckboxChecked, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let state = self.checked;
        let on = state != CheckboxChecked::Unchecked;
        let mixed = state == CheckboxChecked::Mixed;
        let disabled = self.disabled;
        let radius = [radius::CHIP; 4];

        let mut box_ = gpui_base::Checkbox::new(self.id)
            .state(state.into())
            .disabled(disabled)
            .relative()
            .flex_none()
            .size(px(SIZE))
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(gpui::transparent_black())
            .flex()
            .items_center()
            .justify_center();
        if let Some(label) = self.accessibility_label {
            box_ = box_.accessibility_label(label);
        }
        if let Some(on_change) = self.on_change {
            box_ = box_.on_change(move |next, _, window, cx| {
                on_change(CheckboxChecked::from(next), window, cx);
            });
        }

        let mark = if mixed {
            div()
                .w(px(8.0))
                .h(px(2.0))
                .rounded_full()
                .bg(hsla(if disabled {
                    faded_over(t.chrome_fill_ink, ground, 0.5)
                } else {
                    t.chrome_fill_ink
                }))
                .into_any_element()
        } else if on {
            icon(
                IconName::Check,
                14.0,
                hsla(if disabled {
                    faded_over(t.chrome_fill_ink, ground, 0.5)
                } else {
                    t.chrome_fill_ink
                }),
            )
            .into_any_element()
        } else {
            div().into_any_element()
        };

        let face = if disabled {
            box_.bg(hsla(faded_over(
                if on {
                    t.chrome_fill_flat
                } else {
                    with_alpha(t.input, 0.9)
                },
                ground,
                0.5,
            )))
            .child(mark)
        } else if on {
            box_.shadow(chrome::shadows(t.chrome_fill_shadow))
                .child(chrome::metal(t.chrome_fill_stops, radius, Direction::Down))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(mark),
                )
        } else {
            box_.bg(hsla(with_alpha(t.input, 0.9)))
                .hover(|style| style.bg(hsla(t.muted)))
                .child(mark)
        };

        let show_reason = disabled && self.disabled_reason.is_some();
        if !show_reason {
            return face.into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(face)
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(self.disabled_reason.unwrap_or_default()),
            )
            .into_any_element()
    }
}
