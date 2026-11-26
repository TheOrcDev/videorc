//! PowerSlider (`components/power-slider.tsx`): a labelled slider for one
//! engine setting. The label row has an optional icon, the label and a
//! status chip; the value (or a typed number, `value_slot`) and a reset to
//! the default sit at its end. Then the track, which returns to the default
//! on a double-click, optional marks under it, and the reason a disabled
//! slider waits. The value math is `lib/power-slider-math`'s:
//! [`format_value`] and [`clamp_to_range`].
//!
//! The value lives in the screen's `SliderState`, as for [`Slider`]; the
//! screen applies a reset from [`PowerSlider::on_reset`].

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FontWeight, IntoElement, SharedString, Window, div,
    prelude::*, px, relative,
};

use crate::{
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    icon::{IconName, icon},
    label::Label,
    slider::{Slider, SliderState},
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::text,
};

type ResetHandler = Rc<dyn Fn(f32, &mut Window, &mut App)>;

/// The decimals a step implies (`0.1` → 1).
fn step_decimals(step: f32) -> usize {
    if !step.is_finite() || step <= 0.0 {
        return 0;
    }
    let text = format!("{step}");
    text.find('.').map_or(0, |dot| text.len() - dot - 1)
}

/// `clampToRange`: into `[min, max]`, snapped to the step grid from `min`.
pub fn clamp_to_range(value: f32, min: f32, max: f32, step: f32) -> f32 {
    if value.is_nan() {
        return min;
    }
    let bounded = value.clamp(min, max);
    if !step.is_finite() || step <= 0.0 {
        return bounded;
    }
    let snapped = (min + ((bounded - min) / step).round() * step).clamp(min, max);
    let factor = 10f32.powi(step_decimals(step) as i32);
    (snapped * factor).round() / factor
}

/// `formatValue`: fixed decimals (the step's unless given), the unit, and a
/// "+" on a positive value either side of zero (`bipolar`).
pub fn format_value(
    value: f32,
    step: f32,
    decimals: Option<usize>,
    suffix: &str,
    bipolar: bool,
) -> String {
    let decimals = decimals.unwrap_or_else(|| step_decimals(step));
    let factor = 10f32.powi(decimals as i32);
    let rounded = (value * factor).round() / factor;
    let sign = if bipolar && rounded > 0.0 { "+" } else { "" };
    format!("{sign}{rounded:.decimals$}{suffix}")
}

/// A labelled point under the track.
#[derive(Clone, Debug, PartialEq)]
pub struct PowerSliderMark {
    pub value: f32,
    pub label: Option<SharedString>,
}

#[derive(IntoElement)]
pub struct PowerSlider {
    id: ElementId,
    label: SharedString,
    state: Entity<SliderState>,
    step: f32,
    decimals: Option<usize>,
    suffix: SharedString,
    bipolar: bool,
    default_value: Option<f32>,
    on_reset: Option<ResetHandler>,
    icon: Option<IconName>,
    status: Option<(SharedString, BadgeVariant)>,
    marks: Vec<PowerSliderMark>,
    range_hints: bool,
    value_slot: Option<AnyElement>,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl PowerSlider {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        state: &Entity<SliderState>,
    ) -> Self {
        PowerSlider {
            id: id.into(),
            label: label.into(),
            state: state.clone(),
            step: 1.0,
            decimals: None,
            suffix: SharedString::default(),
            bipolar: false,
            default_value: None,
            on_reset: None,
            icon: None,
            status: None,
            marks: Vec::new(),
            range_hints: false,
            value_slot: None,
            disabled: false,
            disabled_reason: None,
            appearance: None,
        }
    }

    /// The step the readout's decimals follow (1 by default); the state
    /// keeps its own for the keys.
    pub fn step(mut self, step: f32) -> Self {
        self.step = step;
        self
    }

    /// Decimals in the readout, instead of the step's.
    pub fn decimals(mut self, decimals: usize) -> Self {
        self.decimals = Some(decimals);
        self
    }

    /// The unit after the value: "%", " ms", " dB".
    pub fn suffix(mut self, suffix: impl Into<SharedString>) -> Self {
        self.suffix = suffix.into();
        self
    }

    /// A value either side of zero: positives read "+12", and the range
    /// hints add the midpoint.
    pub fn bipolar(mut self, bipolar: bool) -> Self {
        self.bipolar = bipolar;
        self
    }

    /// Enables the reset (the button and a double-click on the track) once
    /// the value drifts from it.
    pub fn default_value(mut self, value: f32) -> Self {
        self.default_value = Some(value);
        self
    }

    /// Called with the default after a reset has moved the state to it, so
    /// the screen applies it as a commit.
    pub fn on_reset(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_reset = Some(Rc::new(handler));
        self
    }

    /// A 14 px glyph before the label (Electron draws it duotone).
    pub fn icon(mut self, name: IconName) -> Self {
        self.icon = Some(name);
        self
    }

    /// A chip after the label ("Premium", "Not supported").
    pub fn status(mut self, label: impl Into<SharedString>, variant: BadgeVariant) -> Self {
        self.status = Some((label.into(), variant));
        self
    }

    /// Labelled points under the track.
    pub fn marks(mut self, marks: Vec<PowerSliderMark>) -> Self {
        self.marks = marks;
        self
    }

    /// The ends (and a bipolar midpoint) under the track, when there are no
    /// marks.
    pub fn range_hints(mut self, hints: bool) -> Self {
        self.range_hints = hints;
        self
    }

    /// The typed number in place of the readout (`numericInput`): an
    /// `Input` 80 px wide, right-aligned, named "<label> value". The screen
    /// owns its state and commits it to the slider.
    pub fn value_slot(mut self, slot: impl IntoElement) -> Self {
        self.value_slot = Some(slot.into_any_element());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Why it is disabled, in one line under the track.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for PowerSlider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let (value, min, max) = {
            let state = self.state.read(cx);
            (state.value().end(), state.min_value(), state.max_value())
        };
        let step = self.step;
        let bipolar = self.bipolar;
        let decimals = self.decimals;
        let suffix = self.suffix.clone();
        let disabled = self.disabled;
        let can_reset = self.default_value.is_some_and(|default| {
            clamp_to_range(value, min, max, step) != clamp_to_range(default, min, max, step)
        });
        // Moves the state to the default and tells the screen.
        let reset: Option<Rc<dyn Fn(&mut Window, &mut App)>> =
            self.default_value.filter(|_| !disabled).map(|default| {
                let state = self.state.clone();
                let on_reset = self.on_reset.clone();
                Rc::new(move |window: &mut Window, cx: &mut App| {
                    state.update(cx, |s, cx| s.set_value(default, window, cx));
                    if let Some(on_reset) = on_reset.as_ref() {
                        on_reset(default, window, cx);
                    }
                }) as Rc<dyn Fn(&mut Window, &mut App)>
            });

        let id = self.id.clone();
        let label = self.label.clone();
        let readout = self.value_slot.unwrap_or_else(|| {
            div()
                .min_w(px(24.0))
                .text_right()
                .text_size(px(14.0))
                .line_height(px(20.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(hsla(t.foreground))
                .child(format_value(value, step, decimals, &suffix, bipolar))
                .into_any_element()
        });
        let reset_button = (can_reset).then(|| {
            let reset = reset.clone();
            Button::new(SharedString::from(format!("{id}/reset")))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Icon)
                .disabled(disabled)
                .accessibility_label(SharedString::from(format!("Reset {label}")))
                .tooltip("Reset to default")
                .child(icon(
                    IconName::ArrowCounterClockwise,
                    14.0,
                    hsla(t.muted_foreground),
                ))
                .on_click(move |_, window, cx| {
                    if let Some(reset) = reset.as_ref() {
                        reset(window, cx);
                    }
                })
        });

        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .min_w(px(0.0))
                    .items_center()
                    .gap(px(6.0))
                    .children(
                        self.icon
                            .map(|name| icon(name, 14.0, hsla(t.muted_foreground))),
                    )
                    .child(
                        div()
                            .min_w(px(0.0))
                            .truncate()
                            .child(Label::new(label.clone())),
                    )
                    .children(
                        self.status
                            .map(|(words, variant)| Badge::new(words).variant(variant)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.0))
                    .child(readout)
                    .children(reset_button),
            );

        // Double-click anywhere on the track returns to the default.
        let track = div()
            .id(SharedString::from(format!("{id}/track")))
            .relative()
            .child(
                Slider::new(&self.state)
                    .disabled(disabled)
                    .accessibility_label(label.clone()),
            )
            .when_some(reset, |track, reset| {
                track.on_click(move |event, window, cx| {
                    if event.click_count() == 2 {
                        reset(window, cx);
                    }
                })
            });

        let points: Vec<PowerSliderMark> = if !self.marks.is_empty() {
            self.marks
        } else if self.range_hints {
            let mut points = vec![PowerSliderMark {
                value: min,
                label: None,
            }];
            if bipolar {
                points.push(PowerSliderMark {
                    value: min + (max - min) / 2.0,
                    label: None,
                });
            }
            points.push(PowerSliderMark {
                value: max,
                label: None,
            });
            points
        } else {
            Vec::new()
        };
        let span = (max - min).max(f32::EPSILON);
        let marks = (!points.is_empty()).then(|| {
            div()
                .relative()
                .h(px(16.0))
                .type_scale(text::LABEL)
                .font_weight(FontWeight::NORMAL)
                .text_color(hsla(t.muted_foreground))
                .children(points.into_iter().map(|point| {
                    let at = ((point.value.clamp(min, max) - min) / span).clamp(0.0, 1.0);
                    let words = point.label.unwrap_or_else(|| {
                        SharedString::from(format_value(
                            point.value,
                            step,
                            decimals,
                            &suffix,
                            bipolar,
                        ))
                    });
                    // `-translate-x-1/2`: a box centred on the point.
                    div()
                        .absolute()
                        .left(relative(at))
                        .ml(px(-40.0))
                        .w(px(80.0))
                        .flex()
                        .justify_center()
                        .whitespace_nowrap()
                        .child(words)
                }))
        });

        div()
            .id(self.id)
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(header)
            .child(track)
            .children(marks)
            .children(self.disabled_reason.filter(|_| disabled).map(|reason| {
                div()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(hsla(t.muted_foreground))
                    .child(reason)
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readout_matches_power_slider_math() {
        assert_eq!(format_value(12.0, 1.0, None, "%", false), "12%");
        assert_eq!(format_value(12.0, 1.0, None, "", true), "+12");
        assert_eq!(format_value(0.25, 0.1, None, " dB", false), "0.3 dB");
        assert_eq!(format_value(-3.0, 1.0, None, "", true), "-3");
    }

    #[test]
    fn clamps_and_snaps_to_the_step() {
        assert_eq!(clamp_to_range(105.0, 0.0, 100.0, 5.0), 100.0);
        assert_eq!(clamp_to_range(12.0, 0.0, 100.0, 5.0), 10.0);
        assert_eq!(clamp_to_range(0.30000004, 0.0, 1.0, 0.1), 0.3);
        assert_eq!(clamp_to_range(f32::NAN, 2.0, 9.0, 1.0), 2.0);
    }
}
