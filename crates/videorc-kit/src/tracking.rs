//! Letter spacing (`tracking-[…em]`) where GPUI has none: [`TrackedText`]
//! lays a short line out glyph by glyph with the tracking as the gap, as CSS
//! adds it after each letter. It is for short display lines (the Retro LCD's
//! `tracking-[0.08em]`, its keys' `0.04em`) in a monospace face, where each
//! glyph's own advance is the font's. The line is one name for assistive
//! tech; it never wraps.

use gpui::{App, IntoElement, SharedString, Window, div, prelude::*, px};

/// One line with CSS letter spacing.
#[derive(IntoElement)]
pub struct TrackedText {
    text: SharedString,
    /// The font size the `em` is taken from.
    size: f32,
    /// Extra space after each glyph, in `em`.
    tracking_em: f32,
}

impl TrackedText {
    /// `text` at `size` px with `tracking_em` (0.08 for `tracking-[0.08em]`).
    pub fn new(text: impl Into<SharedString>, size: f32, tracking_em: f32) -> Self {
        TrackedText {
            text: text.into(),
            size,
            tracking_em,
        }
    }
}

/// The gap between glyphs, in px, for `size` and `tracking_em`.
pub fn tracking_px(size: f32, tracking_em: f32) -> f32 {
    (size * tracking_em).max(0.0)
}

impl RenderOnce for TrackedText {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let gap = tracking_px(self.size, self.tracking_em);
        let name = self.text.clone();
        // CSS puts the spacing after every letter, the last one too.
        let glyphs = self.text.chars().map(|glyph| {
            div()
                .flex_none()
                .mr(px(gap))
                // A lone space would shape to nothing: draw it unbreakable.
                .child(SharedString::from(
                    (if glyph == ' ' { '\u{a0}' } else { glyph }).to_string(),
                ))
        });
        div()
            .id(SharedString::from(format!("tracked/{}", self.text)))
            .flex()
            .flex_none()
            .items_baseline()
            .whitespace_nowrap()
            .text_size(px(self.size))
            .aria_label(name)
            .children(glyphs)
    }
}

#[cfg(test)]
mod tests {
    use super::tracking_px;

    #[test]
    fn tracking_is_em_of_the_size() {
        assert!((tracking_px(14.0, 0.08) - 1.12).abs() < 1e-6);
        assert_eq!(tracking_px(14.0, -0.1), 0.0);
    }
}
