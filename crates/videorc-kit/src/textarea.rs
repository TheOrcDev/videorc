//! Textarea (`components/ui/textarea.tsx`): gpui-base's multi-line editor for
//! the behaviour (editing, selection, IME, undo, copy and paste, soft wrap,
//! the AccessKit text role), the desktop control look: 14 px text at every
//! width, a recessed fill, the chip radius, a 64 px minimum height and a
//! 3 px focus ring.
//!
//! The text lives in a `TextareaState` entity the screen owns
//! (`cx.new(|cx| TextareaState::new(window, cx).placeholder("Notes"))`),
//! which emits `InputEvent::Change`, `PressEnter`, `Focus` and `Blur`.
//!
//! Notes and other full-bleed surfaces call [`Textarea::plain`] to drop the
//! fill, rim and ring (Electron's `bg-transparent border-0 focus-visible:ring-0`).

use gpui::{
    App, ElementId, Entity, Focusable, IntoElement, Pixels, SharedString, Window, prelude::*, px,
};
use gpui_base::input::InputEditorStyle;
pub use gpui_base::input::TextareaState;

use crate::{
    chrome::ring_outline,
    theme::{Appearance, FONT, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, radius},
};

/// Default text size: React's `text-sm`.
const TEXT: f32 = 14.0;
/// React's `min-h-16`.
const MIN_HEIGHT: f32 = 64.0;

#[derive(IntoElement)]
pub struct Textarea {
    id: ElementId,
    state: Entity<TextareaState>,
    disabled: bool,
    invalid: bool,
    plain: bool,
    text_size: Option<Pixels>,
    /// A call site's `min-h-*` over the 64 px default.
    min_height: Option<f32>,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl Textarea {
    pub fn new(id: impl Into<ElementId>, state: &Entity<TextareaState>) -> Self {
        Textarea {
            id: id.into(),
            state: state.clone(),
            disabled: false,
            invalid: false,
            plain: false,
            text_size: None,
            min_height: None,
            ground: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    /// The least height instead of `min-h-16` (Stream details' description
    /// is `min-h-20`: 80).
    pub fn min_height(mut self, height: f32) -> Self {
        self.min_height = Some(height);
        self
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

    /// No recessed fill, rim or focus ring: a teleprompter or other full-bleed
    /// surface (Notes). Padding and type size stay with the caller or
    /// [`Textarea::text_size`].
    pub fn plain(mut self, plain: bool) -> Self {
        self.plain = plain;
        self
    }

    /// Overrides the default 14 px text (Notes' sm / md / lg scales).
    pub fn text_size(mut self, size: impl Into<Pixels>) -> Self {
        self.text_size = Some(size.into());
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

impl RenderOnce for Textarea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        let plain = self.plain;
        let fade = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let text_size = self.text_size.unwrap_or(px(TEXT));
        let line_height = if plain { text_size * 1.45 } else { px(20.0) };
        let focused = {
            let state = self.state.read(cx);
            state.focus_handle(cx).is_focused(window) || state.has_selection_focus(window, cx)
        };
        self.state.update(cx, |state, cx| {
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
        let (rim, focus_rim, focus_ring) = if plain {
            (
                with_alpha(t.border, 0.0),
                with_alpha(t.border, 0.0),
                with_alpha(t.border, 0.0),
            )
        } else if self.invalid {
            (t.destructive, t.destructive, with_alpha(t.destructive, 0.2))
        } else {
            (with_alpha(t.border, 0.0), t.ring, with_alpha(t.ring, 0.3))
        };
        let fill = if plain {
            gpui::transparent_black()
        } else {
            hsla(fade(with_alpha(t.input, 0.5)))
        };
        let mut frame = gpui_base::InputBase::new(self.id)
            .semantic_owner(self.state.entity_id())
            .focused(focused)
            .disabled(disabled)
            .role(gpui_base::RoleOverride::Presentational)
            .flex()
            .w_full()
            .min_w(px(0.0))
            .when(plain, |frame| frame.flex_1().h_full().min_h(px(0.0)))
            .when(!plain, |frame| {
                frame.min_h(px(self.min_height.unwrap_or(MIN_HEIGHT)))
            })
            .px(if plain { px(0.0) } else { px(10.0) })
            .py(if plain { px(0.0) } else { px(8.0) })
            .rounded(if plain { px(0.0) } else { px(radius::CHIP) })
            .border_1()
            .border_color(hsla(rim))
            .bg(fill)
            .font_family(FONT)
            .text_size(text_size)
            .line_height(line_height)
            .text_color(hsla(fade(t.foreground)))
            .styles(|styles| styles.focused(|style| style.border_color(hsla(focus_rim))));
        if focused && !plain {
            frame = frame
                .relative()
                .child(ring_outline(focus_ring, radius::CHIP));
        }
        if let Some(label) = self.accessibility_label {
            frame = frame.accessibility_label(label);
        }
        frame.child(self.state.clone())
    }
}
