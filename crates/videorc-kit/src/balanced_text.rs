//! Balanced wrapping (`text-wrap: balance`, Tailwind's `text-balance`):
//! a short block of text broken into lines of near-equal length instead of
//! full lines and a short last one. Electron's FieldDescription in a
//! horizontal field (SettingsRow descriptions) and Empty use it.
//!
//! GPUI wraps greedily, so [`BalancedText`] finds the narrowest width that
//! keeps the line count the text has at its full width (a binary search
//! with GPUI's own line wrapping) and caps the text there. Its own width is
//! measured in the frame before; until then the text wraps greedily.

use gpui::{
    App, Bounds, ElementId, Entity, FontWeight, IntoElement, Pixels, SharedString, TextRun, Window,
    div, prelude::*, px,
};
use gpui_base::ElementExt as _;

use crate::theme::FONT;

/// One block of text, its lines balanced.
#[derive(IntoElement)]
pub struct BalancedText {
    id: ElementId,
    text: SharedString,
    size: f32,
    line_height: f32,
    weight: FontWeight,
    centered: bool,
}

impl BalancedText {
    /// `text` at `size` px on `line_height` px lines, in the kit's face.
    pub fn new(
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        size: f32,
        line_height: f32,
    ) -> Self {
        BalancedText {
            id: id.into(),
            text: text.into(),
            size,
            line_height,
            weight: FontWeight::NORMAL,
            centered: false,
        }
    }

    /// Centred lines in a centred block (Empty's `text-center`).
    pub fn centered(mut self, centered: bool) -> Self {
        self.centered = centered;
        self
    }

    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }
}

/// How many lines `text` takes at `width`.
fn line_count(window: &Window, text: &SharedString, run: &TextRun, size: f32, width: f32) -> usize {
    window
        .text_system()
        .shape_text(
            text.clone(),
            px(size),
            std::slice::from_ref(run),
            Some(px(width)),
            None,
        )
        .map(|lines| {
            lines
                .iter()
                .map(|line| line.wrap_boundaries().len() + 1)
                .sum()
        })
        .unwrap_or(1)
}

/// The narrowest width, to half a pixel, that keeps the line count `full`
/// has at `full`: `text-wrap: balance`.
pub fn balanced_width(full: f32, lines_at: impl Fn(f32) -> usize) -> f32 {
    let target = lines_at(full);
    if target < 2 {
        return full;
    }
    // At least the share of one line, at most the whole width.
    let (mut lo, mut hi) = (full / target as f32, full);
    while hi - lo > 0.5 {
        let mid = (lo + hi) / 2.0;
        if lines_at(mid) <= target {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

fn width_state(id: &ElementId, window: &mut Window, cx: &mut App) -> Entity<f32> {
    window.use_keyed_state(
        SharedString::from(format!("{id}/balanced-width")),
        cx,
        |_, _| 0.0_f32,
    )
}

fn record(state: &Entity<f32>, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let width = f32::from(bounds.size.width);
    if (state.read(cx) - width).abs() > 0.5 {
        state.update(cx, |w, _| *w = width);
        cx.notify(window.current_view());
        window.on_next_frame(|window, _| window.refresh());
    }
}

impl RenderOnce for BalancedText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = width_state(&self.id, window, cx);
        let full = *state.read(cx);
        let cap = (full > 0.0).then(|| {
            let mut font = gpui::font(FONT);
            font.weight = self.weight;
            let run = TextRun {
                len: self.text.len(),
                font,
                color: gpui::transparent_black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let (text, size) = (self.text.clone(), self.size);
            balanced_width(full, |width| line_count(window, &text, &run, size, width))
        });
        div()
            .id(self.id)
            .w_full()
            .min_w(px(0.0))
            .when(self.centered, |outer| outer.flex().justify_center())
            .on_prepaint(move |bounds, window, cx| record(&state, bounds, window, cx))
            .child(
                div()
                    .when(self.centered, |text| text.text_center())
                    .text_size(px(self.size))
                    .line_height(px(self.line_height))
                    .font_weight(self.weight)
                    // A hair over, so the measured width never wraps a line
                    // the search kept.
                    .when_some(cap, |text, cap| text.max_w(px(cap + 0.5)))
                    .child(self.text),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::balanced_width;

    #[test]
    fn balances_two_lines_to_the_narrowest_width() {
        // A 300 px text: one line from 300, two from 150, three from 100.
        let lines = |w: f32| (300.0 / w).ceil() as usize;
        assert_eq!(balanced_width(400.0, lines), 400.0);
        let w = balanced_width(200.0, lines);
        assert!((150.0..=150.5).contains(&w), "{w}");
    }
}
