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
    /// The Retro LCD's ink glow (`drop-shadow(0 0 3px glow)`).
    glow: bool,
}

impl TrackedText {
    /// `text` at `size` px with `tracking_em` (0.08 for `tracking-[0.08em]`).
    pub fn new(text: impl Into<SharedString>, size: f32, tracking_em: f32) -> Self {
        TrackedText {
            text: text.into(),
            size,
            tracking_em,
            glow: false,
        }
    }

    /// A soft halo in the text's own ink round each glyph, the Retro LCD's
    /// `drop-shadow(0 0 3px var(--lcd-display-glow))`: the glow is the lit
    /// ink at 60% on the dark screen and 22% on the light one. GPUI has no
    /// text shadow or blur, so four copies 1 px off each side, at half that
    /// strength, sit under the glyph.
    pub fn glow(mut self, glow: bool) -> Self {
        self.glow = glow;
        self
    }
}

/// The gap between glyphs, in px, for `size` and `tracking_em`.
pub fn tracking_px(size: f32, tracking_em: f32) -> f32 {
    (size * tracking_em).max(0.0)
}

impl RenderOnce for TrackedText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let gap = tracking_px(self.size, self.tracking_em);
        let name = self.text.clone();
        // CSS puts the spacing after every letter, the last one too.
        let glow = self.glow.then(|| {
            let t = crate::theme::resolve(None, window, cx);
            if crate::theme::is_dark(t) { 0.3 } else { 0.11 }
        });
        let glyphs = self.text.chars().map(|glyph| {
            // A lone space would shape to nothing: draw it unbreakable.
            let shown =
                SharedString::from((if glyph == ' ' { '\u{a0}' } else { glyph }).to_string());
            let halo = glow.filter(|_| glyph != ' ').map(|strength| {
                [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0)].map(|(x, y)| {
                    div()
                        .absolute()
                        .left(px(x))
                        .top(px(y))
                        .opacity(strength)
                        .child(shown.clone())
                })
            });
            div()
                .relative()
                .flex_none()
                .mr(px(gap))
                .children(halo.into_iter().flatten())
                .child(div().relative().child(shown))
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
