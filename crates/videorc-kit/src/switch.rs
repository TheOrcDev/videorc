//! Switch (`components/ui/switch.tsx`): gpui-base's Switch for the
//! behaviour (pointer, Space, focus, the AccessKit role and checked state),
//! Liquid Chrome for the look. On, the track is the chrome fill and the knob
//! the inverse bead; off, the track is recessed and the knob a chrome bead.
//! `small` is a 16 px track, not a control height.

use std::rc::Rc;

use gpui::{App, ElementId, IntoElement, SharedString, Window, div, prelude::*, px};

use crate::{
    chrome::{self, Direction, box_shadow},
    theme::{Appearance, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, Stop},
};

type ChangeHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type TooltipBuilder = Rc<dyn Fn(&mut Window, &mut App) -> gpui::AnyView>;

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    checked: bool,
    disabled: bool,
    small: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    tooltip: Option<TooltipBuilder>,
    on_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Switch {
            id: id.into(),
            checked: false,
            disabled: false,
            small: false,
            ground: None,
            accessibility_label: None,
            tooltip: None,
            on_change: None,
            appearance: None,
        }
    }

    /// The value to show; the app renders the value `on_change` reports.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The 24 × 16 px switch.
    pub fn small(mut self, small: bool) -> Self {
        self.small = small;
        self
    }

    /// The colour the switch sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    /// The name a screen reader reads when no label names the switch.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Called with the next value when the switch is toggled.
    /// A tooltip in the float glass's tooltip tier.
    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(Rc::new(crate::tooltip::tooltip(text)));
        self
    }

    /// A tooltip with the key chip `action` is bound to in the live keymap
    /// (`ShortcutTooltip`: System audio's key lives here, not on its row).
    pub fn tooltip_with_action(
        mut self,
        text: impl Into<SharedString>,
        action: &dyn gpui::Action,
    ) -> Self {
        self.tooltip = Some(Rc::new(crate::tooltip::tooltip_with_action(text, action)));
        self
    }

    /// A tooltip with an Electron accelerator's chips ("CmdOrCtrl+Shift+A"),
    /// for a key the app registers outside the keymap.
    pub fn tooltip_with_accelerator(
        mut self,
        text: impl Into<SharedString>,
        accelerator: impl Into<SharedString>,
    ) -> Self {
        self.tooltip = Some(Rc::new(crate::tooltip::tooltip_with_accelerator(
            text,
            accelerator,
        )));
        self
    }

    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// A bead on its rim: `ring-1 ring-knob-ring` over the bead's own drop.
pub(crate) fn knob(stops: &'static [Stop], drop: Color, ring: Color, size: f32) -> gpui::Div {
    div()
        .relative()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .shadow(vec![
            box_shadow(&Shadow {
                inset: false,
                x: 0.0,
                y: 1.0,
                blur: 2.0,
                spread: 0.0,
                color: drop,
            }),
            box_shadow(&Shadow {
                inset: false,
                x: 0.0,
                y: 0.0,
                blur: 0.0,
                spread: 1.0,
                color: ring,
            }),
        ])
        .child(chrome::bead(stops))
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let (w, h, size) = if self.small {
            (24.0, 16.0, 12.0)
        } else {
            (32.0, 20.0, 16.0)
        };
        let on = self.checked;
        let mut switch = gpui_base::Switch::new(self.id)
            .checked(on)
            .disabled(self.disabled)
            .relative()
            .flex_none()
            .w(px(w))
            .h(px(h))
            .p(px(2.0))
            .flex()
            .items_center()
            .rounded_full();
        if let Some(label) = self.accessibility_label {
            switch = switch.accessibility_label(label);
        }
        if let Some(tooltip) = self.tooltip {
            switch = switch.tooltip(move |window, cx| tooltip(window, cx));
        }
        if let Some(on_change) = self.on_change {
            switch = switch.on_change(move |next, _, window, cx| on_change(next, window, cx));
        }
        // On, the knob slides to the far end: translate-x(100% - 4px).
        let offset = if on { size - 4.0 } else { 0.0 };
        if self.disabled {
            // Flat and pre-blended over the ground, as Chromium's group fade
            // reads: the track's tone and a plain knob.
            let track = if on {
                t.chrome_fill_flat
            } else {
                with_alpha(t.input, 0.9)
            };
            return switch.bg(hsla(faded_over(track, ground, 0.5))).child(
                div()
                    .ml(px(offset))
                    .size(px(size))
                    .rounded_full()
                    .bg(hsla(faded_over(t.knob, ground, 0.5))),
            );
        }
        if on {
            switch
                .shadow(chrome::shadows(t.chrome_fill_shadow))
                .child(chrome::metal(
                    t.chrome_fill_stops,
                    [h / 2.0; 4],
                    Direction::Down,
                ))
                .child(div().relative().ml(px(offset)).child(knob(
                    t.chrome_bead_ink_stops,
                    t.chrome_bead_ink_drop,
                    t.knob_ring,
                    size,
                )))
        } else {
            switch.bg(hsla(with_alpha(t.input, 0.9))).child(knob(
                t.chrome_bead_stops,
                t.chrome_bead_drop,
                t.knob_ring,
                size,
            ))
        }
    }
}
