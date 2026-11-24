//! Input (`components/ui/input.tsx`): gpui-base's text input for the
//! behaviour (editing, selection, IME, undo, copy and paste, the AccessKit
//! text role), the desktop control look: 28 px, 14 px text at every width,
//! a recessed fill and a 3 px focus ring.
//!
//! The text lives in an `InputState` entity the screen owns
//! (`cx.new(|cx| InputState::new(window, cx).placeholder("Name"))`), which
//! emits `InputEvent::Change`, `PressEnter`, `Focus` and `Blur`.

use gpui::{App, ElementId, Entity, Focusable, IntoElement, SharedString, Window, prelude::*, px};
use gpui_base::input::InputEditorStyle;
pub use gpui_base::input::InputState;

use crate::{
    chrome::box_shadow,
    theme::{Appearance, FONT, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, radius, size},
};

#[derive(IntoElement)]
pub struct Input {
    id: ElementId,
    state: Entity<InputState>,
    disabled: bool,
    invalid: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl Input {
    pub fn new(id: impl Into<ElementId>, state: &Entity<InputState>) -> Self {
        Input {
            id: id.into(),
            state: state.clone(),
            disabled: false,
            invalid: false,
            ground: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// `aria-invalid`: the destructive rim and ring.
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// The colour the field sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    /// The name a screen reader reads when no label names the field.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// A focus ring: `ring-3` in `color`.
fn ring(color: Color) -> gpui::BoxShadow {
    box_shadow(&Shadow {
        inset: false,
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 3.0,
        color,
    })
}

impl RenderOnce for Input {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        let fade = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let focused = {
            let state = self.state.read(cx);
            state.focus_handle(cx).is_focused(window) || state.has_selection_focus(window, cx)
        };
        // The text paints in what it inherits; the editor's own colours
        // (placeholder, caret, selection) come from the tokens, never from
        // gpui-base's fallback theme.
        self.state.update(cx, |state, cx| {
            // Only on a change: setting it notifies the editor.
            if state.presentation().is_disabled() != disabled {
                state.set_disabled(disabled, cx);
            }
            state.set_editor_style(InputEditorStyle {
                foreground: hsla(fade(t.foreground)),
                muted_foreground: hsla(fade(t.muted_foreground)),
                background: gpui::transparent_black(),
                border: gpui::transparent_black(),
                selection: hsla(with_alpha(t.foreground, 0.2)),
                caret: hsla(t.foreground),
                ..Default::default()
            });
        });
        let (rim, focus_rim, focus_ring) = if self.invalid {
            (t.destructive, t.destructive, with_alpha(t.destructive, 0.2))
        } else {
            (with_alpha(t.border, 0.0), t.ring, with_alpha(t.ring, 0.3))
        };
        let mut frame = gpui_base::InputBase::new(self.id)
            .semantic_owner(self.state.entity_id())
            .focused(focused)
            .disabled(disabled)
            .role(gpui_base::RoleOverride::Presentational)
            .flex()
            .items_center()
            .w_full()
            .min_w(px(0.0))
            .h(px(size::CONTROL))
            .px(px(10.0))
            .py(px(4.0))
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(rim))
            .bg(hsla(fade(with_alpha(t.input, 0.5))))
            .font_family(FONT)
            .text_size(px(14.0))
            .line_height(px(20.0))
            .text_color(hsla(fade(t.foreground)))
            .styles(|styles| {
                styles.focused(|style| {
                    style
                        .border_color(hsla(focus_rim))
                        .shadow(vec![ring(focus_ring)])
                })
            });
        if let Some(label) = self.accessibility_label {
            frame = frame.accessibility_label(label);
        }
        frame.child(self.state.clone())
    }
}
