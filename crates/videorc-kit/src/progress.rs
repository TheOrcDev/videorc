//! Progress (`components/ui/progress.tsx`): one determinate bar, a 6 px
//! round track with the chrome fill. Name it with a label or
//! `accessibility_label`, and say the number in words beside it when the
//! streamer needs it.

use gpui::{App, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px, relative};

use crate::{
    chrome::{self, Direction},
    theme::{Appearance, FONT, hsla, resolve},
};

const DEFAULT_MAX: f32 = 100.0;
const TRACK_H: f32 = 6.0;

#[derive(IntoElement)]
pub struct Progress {
    /// Its element id: the accessibility role needs a stateful element.
    /// Bars that share a parent need their own (`Self::id`).
    id: gpui::ElementId,
    value: f32,
    max: f32,
    label: Option<SharedString>,
    value_text: Option<SharedString>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl Progress {
    /// A bar from 0 to `max` (100 by default). A non-positive `max` reads as 100.
    pub fn new(value: f32) -> Self {
        Progress {
            id: "progress".into(),
            value,
            max: DEFAULT_MAX,
            label: None,
            value_text: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    /// Its element id, for bars that share a parent.
    pub fn id(mut self, id: impl Into<gpui::ElementId>) -> Self {
        self.id = id.into();
        self
    }

    pub fn max(mut self, max: f32) -> Self {
        self.max = if max > 0.0 { max } else { DEFAULT_MAX };
        self
    }

    /// Words above the bar (`ProgressLabel`).
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Tabular value beside the label (`ProgressValue`).
    pub fn value_text(mut self, text: impl Into<SharedString>) -> Self {
        self.value_text = Some(text.into());
        self
    }

    /// The name a screen reader reads when no label names the bar.
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

impl RenderOnce for Progress {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let max = if self.max > 0.0 {
            self.max
        } else {
            DEFAULT_MAX
        };
        let fraction = (self.value / max).clamp(0.0, 1.0);
        let aria = self
            .accessibility_label
            .or_else(|| self.label.clone())
            .unwrap_or_else(|| "Progress".into());

        let header = match (self.label, self.value_text) {
            (None, None) => None,
            (label, value_text) => Some(
                div()
                    .flex()
                    .w_full()
                    .flex_row()
                    .items_center()
                    .gap(px(12.0))
                    .children(label.map(|words| {
                        div()
                            .font_family(FONT)
                            .text_size(px(14.0))
                            .line_height(px(20.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(t.foreground))
                            .child(words)
                    }))
                    .children(value_text.map(|words| {
                        div()
                            .ml_auto()
                            .font_family(FONT)
                            .text_size(px(14.0))
                            .line_height(px(20.0))
                            .text_color(hsla(t.muted_foreground))
                            .child(words)
                    })),
            ),
        };

        div()
            .id(self.id)
            .flex()
            .w_full()
            .flex_col()
            .gap(px(6.0))
            .role(gpui::Role::ProgressIndicator)
            .aria_label(aria)
            .aria_numeric_value(f64::from(self.value))
            .aria_min_numeric_value(0.0)
            .aria_max_numeric_value(f64::from(max))
            .children(header)
            .child(
                div()
                    .relative()
                    .flex()
                    .w_full()
                    .h(px(TRACK_H))
                    .items_center()
                    .overflow_hidden()
                    .rounded_full()
                    .bg(hsla(t.muted))
                    .child(
                        div()
                            .h_full()
                            .w(relative(fraction))
                            .rounded_full()
                            .shadow(chrome::shadows(t.chrome_fill_shadow))
                            .child(chrome::metal(
                                t.chrome_fill_stops,
                                [TRACK_H, 0.0, 0.0, TRACK_H],
                                Direction::Down,
                            )),
                    ),
            )
    }
}
