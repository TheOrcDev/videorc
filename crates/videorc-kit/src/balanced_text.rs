//! Balanced wrapping (`text-wrap: balance`, Tailwind's `text-balance`):
//! a short block of text broken into lines of near-equal length instead of
//! full lines and a short last one. Electron's FieldDescription in a
//! horizontal field (SettingsRow descriptions) and Empty use it.
//!
//! GPUI wraps greedily, so [`BalancedText`] finds the narrowest width that
//! keeps the line count the text has at its full width (a binary search
//! with GPUI's own line wrapping) and wraps the text there. The search runs
//! in the layout pass, with the width the text is given, so the very frame
//! it is laid out in is balanced: no stored width, no second frame.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, FontWeight, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, SharedString, Size, TextAlign, TextRun,
    Window, WrappedLine, div, prelude::*, px,
};
use smallvec::SmallVec;

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

/// How many lines shaped text takes.
fn line_count(lines: &[WrappedLine]) -> usize {
    lines
        .iter()
        .map(|line| line.wrap_boundaries().len() + 1)
        .sum()
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

impl RenderOnce for BalancedText {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id(self.id)
            .w_full()
            .min_w(px(0.0))
            .when(self.centered, |outer| outer.flex().justify_center())
            .child(
                div()
                    .min_w(px(0.0))
                    .when(self.centered, |text| text.text_center())
                    .text_size(px(self.size))
                    .line_height(px(self.line_height))
                    .font_weight(self.weight)
                    .child(BalancedLines {
                        text: self.text,
                        shaped: Rc::default(),
                    }),
            )
    }
}

/// The text's lines, balanced for the width layout gives them.
struct BalancedLines {
    text: SharedString,
    shaped: Rc<RefCell<Option<Shaped>>>,
}

/// The lines measured in the layout pass, painted in the same frame.
struct Shaped {
    lines: SmallVec<[WrappedLine; 1]>,
    line_height: Pixels,
    align: TextAlign,
}

impl IntoElement for BalancedLines {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for BalancedLines {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        // The face, size, weight, ink and alignment the parent sets.
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = style.line_height_in_pixels(window.rem_size());
        let align = style.text_align;
        let run: TextRun = style.to_run(self.text.len());
        let text = self.text.clone();
        let shaped = self.shaped.clone();
        let layout_id = window.request_measured_layout(
            Default::default(),
            move |known, available, window, _cx| {
                let shape = |width: Option<Pixels>| {
                    window
                        .text_system()
                        .shape_text(
                            text.clone(),
                            font_size,
                            std::slice::from_ref(&run),
                            width,
                            None,
                        )
                        .unwrap_or_default()
                };
                let full = known.width.or(match available.width {
                    AvailableSpace::Definite(width) => Some(width),
                    _ => None,
                });
                // A hair over the found width, so the measured lines never
                // wrap a word the search kept.
                let wrap = full.map(|full| {
                    let found = balanced_width(f32::from(full), |width| {
                        line_count(&shape(Some(px(width))))
                    });
                    let capped = px(found + 0.5);
                    if capped < full { capped } else { full }
                });
                let lines = shape(wrap);
                let mut size: Size<Pixels> = Size::default();
                for line in &lines {
                    let line_size = line.size(line_height);
                    size.height += line_size.height;
                    size.width = size.width.max(line_size.width).ceil();
                }
                *shaped.borrow_mut() = Some(Shaped {
                    lines,
                    line_height,
                    align,
                });
                size
            },
        );
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let shaped = self.shaped.borrow();
        let Some(shaped) = shaped.as_ref() else {
            return;
        };
        let mut origin = bounds.origin;
        for line in &shaped.lines {
            let _ = line.paint(
                origin,
                shaped.line_height,
                shaped.align,
                Some(bounds),
                window,
                cx,
            );
            origin.y += line.size(shaped.line_height).height;
        }
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
