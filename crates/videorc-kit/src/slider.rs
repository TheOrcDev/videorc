//! Slider (`components/ui/slider.tsx`): gpui-base's Slider for the
//! behaviour (pointer, arrows, Page Up and Down, Home and End, the AccessKit
//! slider role), Liquid Chrome for the look. The range is the chrome fill
//! and the thumb a chrome bead on its rim, inside the track at both ends
//! (`thumbAlignment="edge"`).
//!
//! The value lives in a `SliderState` entity the screen owns
//! (`cx.new(|_| SliderState::new().min(0.).max(100.).default_value(40.))`),
//! which emits `SliderEvent::Change` and `Release`.
//!
//! As a gain fader (audiocn's `Fader`), [`Slider::origin`] starts the range
//! at 0 dB instead of the left end, so at unity nothing is filled. A skin (the
//! Retro LCD's `LCD_FADER`) replaces the colours with [`Slider::track_color`],
//! [`Slider::range_color`] and [`Slider::thumb_color`]: flat fills, no chrome.

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
    /// Where the range starts, as a fraction of the travel (0 = left end).
    origin: f32,
    track: Option<Color>,
    range: Option<Color>,
    thumb: Option<(Color, Color)>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl Slider {
    pub fn new(state: &Entity<SliderState>) -> Self {
        Slider {
            state: state.clone(),
            disabled: false,
            ground: None,
            origin: 0.0,
            track: None,
            range: None,
            thumb: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    /// The range runs from here to the thumb, as a fraction of the travel:
    /// a gain fader's 0 dB (`FaderRange` from `originPosition`).
    pub fn origin(mut self, fraction: f32) -> Self {
        self.origin = fraction.clamp(0.0, 1.0);
        self
    }

    /// The track's colour instead of `bg-foreground/15`.
    pub fn track_color(mut self, color: Color) -> Self {
        self.track = Some(color);
        self
    }

    /// A flat range in this colour instead of the chrome fill.
    pub fn range_color(mut self, color: Color) -> Self {
        self.range = Some(color);
        self
    }

    /// A flat thumb in `fill` on a 1 px `ring` instead of the chrome bead.
    pub fn thumb_color(mut self, fill: Color, ring: Color) -> Self {
        self.thumb = Some((fill, ring));
        self
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
        let travel = (width - THUMB).max(0.0);
        let thumb_left = (fraction * travel).max(0.0);
        // The range runs between the origin and the thumb's centre.
        let thumb_centre = thumb_left + THUMB / 2.0;
        let origin_x = if self.origin > 0.0 {
            self.origin * travel + THUMB / 2.0
        } else {
            0.0
        };
        let range_left = origin_x.min(thumb_centre);
        let range = (origin_x.max(thumb_centre) - range_left).max(0.0);
        let well = self.track.unwrap_or(with_alpha(t.foreground, 0.15));
        let fade = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };

        let range_fill = div()
            .absolute()
            .top_0()
            .left(px(range_left))
            .h_full()
            .w(px(range))
            .rounded_full();
        let range_fill = match self.range {
            Some(color) => range_fill.bg(hsla(fade(color))),
            None if disabled => range_fill.bg(hsla(fade(t.chrome_fill_flat))),
            None => range_fill
                .shadow(chrome::shadows(t.chrome_fill_shadow))
                .child(chrome::metal(
                    t.chrome_fill_stops,
                    [2.0, 2.0, 2.0, 2.0],
                    Direction::Down,
                )),
        };
        let thumb = gpui_base::SliderThumb::new(&self.state)
            .disabled(disabled)
            .absolute()
            .top(px(-6.0))
            .left(px(thumb_left))
            .size(px(THUMB))
            .rounded_full();
        let thumb = if let Some((fill, ring)) = self.thumb {
            thumb.bg(hsla(fade(fill))).shadow(vec![box_shadow(&Shadow {
                inset: false,
                x: 0.0,
                y: 0.0,
                blur: 0.0,
                spread: 1.0,
                color: fade(ring),
            })])
        } else if disabled {
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
                        .bg(hsla(fade(well)))
                        .child(range_fill)
                        .child(thumb),
                ),
        )
    }
}
