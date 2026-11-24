//! Slider (`components/ui/slider.tsx`): gpui-base's Slider for the
//! behaviour (pointer, arrows, Page Up and Down, Home and End, the AccessKit
//! slider role), Liquid Chrome for the look. The range is the chrome fill
//! and the thumb a chrome bead on its rim, inside the track at both ends
//! (`thumbAlignment="edge"`).
//!
//! The value lives in a `SliderState` entity the screen owns
//! (`cx.new(|_| SliderState::new().min(0.).max(100.).default_value(40.))`),
//! which emits `SliderEvent::Change` and `Release`.

use gpui::{
    App, ElementId, Entity, FocusHandle, IntoElement, SharedString, Window, div, prelude::*, px,
};
pub use gpui_base::slider::{SliderEvent, SliderState, SliderValue};

use crate::{
    chrome::{self, Direction, box_shadow},
    switch::knob,
    theme::{Appearance, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Shadow},
};

/// The thumb's diameter.
const THUMB: f32 = 16.0;

#[derive(IntoElement)]
pub struct Slider {
    state: Entity<SliderState>,
    disabled: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl Slider {
    pub fn new(state: &Entity<SliderState>) -> Self {
        Slider {
            state: state.clone(),
            disabled: false,
            ground: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The colour the slider sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    /// The name a screen reader reads when no label names the slider.
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

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        // The keys work while this handle has focus; one per slider state.
        let focus: FocusHandle = window
            .use_keyed_state(ElementId::View(self.state.entity_id()), cx, |_, cx| {
                cx.focus_handle()
            })
            .read(cx)
            .clone();
        let (width, fraction) = {
            let state = self.state.read(cx);
            (f32::from(state.bounds().size.width), state.percentage().end)
        };
        // Edge alignment: the thumb travels the track less its own width,
        // and the range ends under the thumb's centre.
        let thumb_left = (fraction * (width - THUMB)).max(0.0);
        let range = thumb_left + THUMB / 2.0;
        let well = with_alpha(t.foreground, 0.15);

        let range_fill = if disabled {
            div()
                .absolute()
                .top_0()
                .left_0()
                .h_full()
                .w(px(range))
                .bg(hsla(faded_over(t.chrome_fill_flat, ground, 0.5)))
        } else {
            div()
                .absolute()
                .top_0()
                .left_0()
                .h_full()
                .w(px(range))
                .shadow(chrome::shadows(t.chrome_fill_shadow))
                .child(chrome::metal(
                    t.chrome_fill_stops,
                    [2.0, 0.0, 0.0, 2.0],
                    Direction::Down,
                ))
        };
        let thumb = gpui_base::SliderThumb::new(&self.state)
            .disabled(disabled)
            .absolute()
            .top(px(-6.0))
            .left(px(thumb_left))
            .size(px(THUMB))
            .rounded_full();
        let thumb = if disabled {
            thumb.bg(hsla(faded_over(t.knob, ground, 0.5)))
        } else {
            // hover:ring-4 ring-ring/30 around the bead.
            thumb
                .hover(|style| {
                    style.shadow(vec![box_shadow(&Shadow {
                        inset: false,
                        x: 0.0,
                        y: 0.0,
                        blur: 0.0,
                        spread: 4.0,
                        color: with_alpha(t.ring, 0.3),
                    })])
                })
                .child(knob(
                    t.chrome_bead_stops,
                    t.chrome_bead_drop,
                    t.knob_ring,
                    THUMB,
                ))
        };

        let mut slider = gpui_base::Slider::new(&self.state)
            .horizontal()
            .disabled(disabled);
        if !disabled {
            slider = slider.track_focus(&focus);
        }
        if let Some(label) = self.accessibility_label {
            slider = slider.accessibility_label(label);
        }
        slider.flex().w_full().items_center().child(
            gpui_base::SliderTrack::new(&self.state)
                .disabled(disabled)
                .flex()
                .items_center()
                .w_full()
                .h(px(THUMB))
                .child(
                    gpui_base::SliderIndicator::new(&self.state)
                        .relative()
                        .w_full()
                        .h(px(4.0))
                        .rounded_full()
                        .bg(hsla(if disabled {
                            faded_over(well, ground, 0.5)
                        } else {
                            well
                        }))
                        .child(range_fill)
                        .child(thumb),
                ),
        )
    }
}
