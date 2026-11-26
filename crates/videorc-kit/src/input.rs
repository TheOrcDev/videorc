//! Input (`components/ui/input.tsx`): gpui-base's text input for the
//! behaviour (editing, selection, IME, undo, copy and paste, the AccessKit
//! text role), the desktop control look: 28 px, 14 px text at every width,
//! a recessed fill and a 3 px focus ring.
//!
//! The text lives in an `InputState` entity the screen owns
//! (`cx.new(|cx| InputState::new(window, cx).placeholder("Name"))`), which
//! emits `InputEvent::Change`, `PressEnter`, `Focus` and `Blur`.
//!
//! [`Input::revert_on_escape`] snapshots the value on focus and restores it
//! (then blurs) when Escape is pressed — Scene transform fields (P549).

use gpui::{
    App, ElementId, Entity, Focusable, IntoElement, SharedString, Window, div, prelude::*, px,
};
pub use gpui_base::input::InputState;
use gpui_base::input::{Escape, InputEditorStyle};

use crate::{
    chrome::box_shadow,
    icon::{IconName, icon},
    theme::{Appearance, FONT, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, radius, size},
};

#[derive(IntoElement)]
pub struct Input {
    id: ElementId,
    state: Entity<InputState>,
    disabled: bool,
    /// Selectable and copyable, never editable (`readOnly`): Guests' invite link.
    readonly: bool,
    invalid: bool,
    /// No own rim, fill or focus ring: an [`crate::input_group::InputGroup`] owns them.
    plain: bool,
    /// Escape restores the value from when the field gained focus (P549).
    revert_on_escape: bool,
    /// Show Electron-style number steppers; `None` hides them.
    step: Option<f64>,
    /// `text-right`: the value reads from the right edge (a number box).
    align_right: bool,
    /// A call site's `text-base font-medium` (Avatar's name: 16 / 500).
    text_size: Option<f32>,
    font_weight: Option<gpui::FontWeight>,
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
            readonly: false,
            invalid: false,
            plain: false,
            revert_on_escape: false,
            step: None,
            align_right: false,
            text_size: None,
            font_weight: None,
            ground: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    /// Number steppers (Output Width/Height/FPS/Bitrate). Step defaults to 1.
    pub fn stepper(mut self, step: f64) -> Self {
        self.step = Some(step.max(0.000_001));
        self
    }

    /// Escape restores the text from when the field gained focus, then blurs
    /// (Electron transform fields: Enter commits, Escape reverts).
    pub fn revert_on_escape(mut self, enabled: bool) -> Self {
        self.revert_on_escape = enabled;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// `aria-invalid`: the destructive rim and ring.
    /// The value's size instead of 14 px (`text-base`: 16, with a 24 px line).
    pub fn text_size(mut self, size: f32) -> Self {
        self.text_size = Some(size);
        self
    }

    /// The value's weight (`font-medium`).
    pub fn font_weight(mut self, weight: gpui::FontWeight) -> Self {
        self.font_weight = Some(weight);
        self
    }

    /// `text-right`: the value sits at the right edge, as a number box's
    /// does (PowerSlider's typed value, Electron's `w-20 text-right`).
    pub fn align_right(mut self, right: bool) -> Self {
        self.align_right = right;
        self
    }

    /// `readOnly`: the value can be selected and copied but not edited. The
    /// field keeps its full colours and focus ring, as Electron's does.
    pub fn readonly(mut self, readonly: bool) -> Self {
        self.readonly = readonly;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Transparent control for an [`crate::input_group::InputGroup`] shell.
    pub fn plain(mut self, plain: bool) -> Self {
        self.plain = plain;
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
        let readonly = self.readonly;
        // Inside an InputGroup the group fades as one (`opacity-50`), so a
        // plain control keeps its colours rather than fading twice.
        let fades = disabled && !self.plain;
        let fade = |color: Color| {
            if fades {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let focused = {
            let state = self.state.read(cx);
            state.focus_handle(cx).is_focused(window) || state.has_selection_focus(window, cx)
        };
        // Escape-revert: snapshot on focus edge; restore when Escape propagates.
        let revert = self.revert_on_escape;
        let snap_key = SharedString::from(format!("{}/escape-snap", self.id));
        let focus_key = SharedString::from(format!("{}/escape-focus", self.id));
        let snap = window.use_keyed_state(snap_key, cx, |_, _| SharedString::default());
        let had_focus = window.use_keyed_state(focus_key, cx, |_, _| false);
        if revert {
            let was = *had_focus.read(cx);
            if focused && !was {
                let value = self.state.read(cx).value();
                snap.update(cx, |s, _| *s = value);
            }
            had_focus.update(cx, |s, _| *s = focused);
        }
        // The text paints in what it inherits; the editor's own colours
        // (placeholder, caret, selection) come from the tokens, never from
        // gpui-base's fallback theme.
        self.state.update(cx, |state, cx| {
            // Only on a change: setting it notifies the editor.
            if state.presentation().is_disabled() != disabled {
                state.set_disabled(disabled, cx);
            }
            if state.presentation().is_readonly() != readonly {
                state.set_readonly(readonly, cx);
            }
            let align = if self.align_right {
                gpui::TextAlign::Right
            } else {
                gpui::TextAlign::Left
            };
            if state.presentation().text_align() != align {
                state.set_text_align(align, cx);
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
        let mut frame = gpui_base::InputBase::new(self.id.clone())
            .semantic_owner(self.state.entity_id())
            .focused(focused && !self.plain)
            .disabled(disabled)
            .role(gpui_base::RoleOverride::Presentational)
            .flex()
            .items_center()
            .w_full()
            .min_w(px(0.0))
            .h(px(size::CONTROL))
            .px(if self.plain { px(4.0) } else { px(10.0) })
            .py(px(4.0))
            .rounded(px(radius::CHIP))
            .font_family(FONT)
            .text_size(px(self.text_size.unwrap_or(14.0)))
            .line_height(px(if self.text_size.is_some_and(|size| size >= 16.0) {
                24.0
            } else {
                20.0
            }))
            .when_some(self.font_weight, |frame, weight| frame.font_weight(weight))
            .text_color(hsla(fade(t.foreground)));
        if self.plain {
            frame = frame
                .border_0()
                .border_color(gpui::transparent_black())
                .bg(gpui::transparent_black());
        } else {
            frame = frame
                .border_1()
                .border_color(hsla(rim))
                .bg(hsla(fade(with_alpha(t.input, 0.5))))
                .styles(|styles| {
                    styles.focused(|style| {
                        style
                            .border_color(hsla(focus_rim))
                            .shadow(vec![ring(focus_ring)])
                    })
                });
        }
        if let Some(label) = self.accessibility_label {
            frame = frame.accessibility_label(label);
        }
        if revert {
            let state = self.state.clone();
            let snap = snap.clone();
            frame = frame.on_action(move |_: &Escape, window, cx| {
                let restore = snap.read(cx).clone();
                state.update(cx, |state, cx| {
                    state.set_value(restore, window, cx);
                });
                window.blur(cx);
                cx.stop_propagation();
            });
        }
        let editor = frame.child(self.state.clone());
        let Some(step) = self.step.filter(|_| !self.plain) else {
            return editor.into_any_element();
        };
        let state_up = self.state.clone();
        let state_down = self.state.clone();
        // Two stepped fields under one parent must not share the buttons'
        // keyed state.
        let up_id = SharedString::from(format!("{}/step-up", self.id));
        let down_id = SharedString::from(format!("{}/step-down", self.id));
        let disabled = self.disabled || readonly;
        // A native number field shows its spin buttons only while it is
        // hovered or focused (Output's shot: only the focused Width's).
        let group = SharedString::from(format!("{}/stepper", self.id));
        div()
            .relative()
            .w_full()
            .min_w(px(0.0))
            .group(group.clone())
            .child(editor)
            .child(
                div()
                    .absolute()
                    .right(px(2.0))
                    .top(px(2.0))
                    .bottom(px(2.0))
                    .flex()
                    .flex_col()
                    .w(px(16.0))
                    .justify_between()
                    .when(!focused, |steppers| {
                        steppers
                            .invisible()
                            .group_hover(group, |style| style.visible())
                    })
                    .child(stepper_btn(
                        up_id,
                        IconName::CaretUp,
                        disabled,
                        t.muted_foreground,
                        move |window, cx| nudge_number(&state_up, step, window, cx),
                    ))
                    .child(stepper_btn(
                        down_id,
                        IconName::CaretDown,
                        disabled,
                        t.muted_foreground,
                        move |window, cx| nudge_number(&state_down, -step, window, cx),
                    )),
            )
            .into_any_element()
    }
}

fn stepper_btn(
    id: SharedString,
    name: IconName,
    disabled: bool,
    ink: Color,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    gpui_base::Button::new(id)
        .disabled(disabled)
        // The field keeps focus: a press neither moves the focus ring nor
        // blurs the field (which reset an unfocused Output field's value on
        // the next redraw). The field's own arrow keys stay the keyboard path.
        .focusable(false)
        .flex_none()
        .h(px(11.0))
        .w(px(16.0))
        .items_center()
        .justify_center()
        .child(icon(name, 10.0, hsla(ink)))
        .on_click(move |_, window, cx| on_click(window, cx))
}

fn nudge_number(state: &Entity<InputState>, delta: f64, window: &mut Window, cx: &mut App) {
    let raw = state.read(cx).value().to_string();
    let next = match raw.trim().parse::<f64>() {
        Ok(n) => {
            let n = n + delta;
            if delta.fract().abs() < f64::EPSILON && n.fract().abs() < f64::EPSILON {
                format!("{}", n as i64)
            } else {
                format!("{n}")
            }
        }
        Err(_) => {
            if delta > 0.0 {
                "1".into()
            } else {
                "0".into()
            }
        }
    };
    state.update(cx, |state, cx| {
        state.set_value(SharedString::from(next), window, cx);
    });
}
