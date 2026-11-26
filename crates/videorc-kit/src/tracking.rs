//! Letter spacing (`tracking-[…em]`) where GPUI has none: [`TrackedText`]
//! lays a short line out glyph by glyph with the tracking as the gap, as CSS
//! adds it after each letter. It is for short display lines (the Retro LCD's
//! `tracking-[0.08em]`, its keys' `0.04em`) in a monospace face, where each
//! glyph's own advance is the font's. The line is one name for assistive
//! tech; it never wraps. With [`TrackedText::truncate`] it ends in a tracked
//! `…` where it would overflow, as CSS `letter-spacing` + `text-overflow:
//! ellipsis` does.

use gpui::{
    App, Bounds, ElementId, Entity, IntoElement, Pixels, SharedString, Window, div, prelude::*, px,
};
use gpui_base::ElementExt as _;

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
    /// Ends in `…` where it would overflow; keyed by this id.
    truncate: Option<ElementId>,
}

impl TrackedText {
    /// `text` at `size` px with `tracking_em` (0.08 for `tracking-[0.08em]`).
    pub fn new(text: impl Into<SharedString>, size: f32, tracking_em: f32) -> Self {
        TrackedText {
            text: text.into(),
            size,
            tracking_em,
            glow: false,
            truncate: None,
        }
    }

    /// Cut the line with a tracked `…` where it would overflow its column,
    /// as Electron's `truncate` on letter-spaced text (`min-w-0`,
    /// `text-overflow: ellipsis`): the line shrinks in a flex row and grows
    /// back when there's room. `id` keys the measured fit; give each
    /// truncating line its own. The cut is measured in the frame before, so
    /// the very first frame is clipped without the `…`.
    pub fn truncate(mut self, id: impl Into<ElementId>) -> Self {
        self.truncate = Some(id.into());
        self
    }

    /// A soft halo in the text's own ink round each glyph, the Retro LCD's
    /// `drop-shadow(0 0 3px var(--lcd-display-glow))`: the glow is the lit
    /// ink at 60% on the dark screen and 22% on the light one. GPUI has no
    /// text shadow or blur, so eight faint copies 1 px off each side and
    /// corner sit under the glyph.
    pub fn glow(mut self, glow: bool) -> Self {
        self.glow = glow;
        self
    }
}

/// The gap between glyphs, in px, for `size` and `tracking_em`.
pub fn tracking_px(size: f32, tracking_em: f32) -> f32 {
    (size * tracking_em).max(0.0)
}

/// How many glyphs stay before the `…` when a tracked line doesn't fit
/// `available` px; `None` when it fits. `xs` are the untracked x of each
/// glyph boundary (one more than the glyphs), `gap` the tracking after each
/// glyph, `ellipsis` the `…`'s own width.
pub fn tracked_cut(xs: &[f32], gap: f32, ellipsis: f32, available: f32) -> Option<usize> {
    let glyphs = xs.len().saturating_sub(1);
    let width = |kept: usize| xs[kept] + kept as f32 * gap;
    // Half a pixel of slack: the line's own box is measured to the float.
    if glyphs == 0 || width(glyphs) <= available + 0.5 {
        return None;
    }
    Some(
        (0..glyphs)
            .rev()
            .find(|&kept| width(kept) + ellipsis <= available + 0.5)
            .unwrap_or(0),
    )
}

/// A truncating line's last measurement.
#[derive(Clone, Default, PartialEq)]
struct Fit {
    text: SharedString,
    /// The whole line's tracked width.
    natural: f32,
    cut: Option<usize>,
}

fn fit_state(id: &ElementId, window: &mut Window, cx: &mut App) -> Entity<Fit> {
    window.use_keyed_state(
        SharedString::from(format!("{id}/tracked-fit")),
        cx,
        |_, _| Fit::default(),
    )
}

/// Shapes the line in the face it inherits and records where it must cut
/// for `bounds`, redrawing once when that changes.
fn measure(
    state: &Entity<Fit>,
    text: &SharedString,
    size: f32,
    gap: f32,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let style = window.text_style();
    let shape = |words: SharedString, window: &Window| {
        let run = style.to_run(words.len());
        window
            .text_system()
            .shape_line(words, px(size), std::slice::from_ref(&run), None)
    };
    let line = shape(text.clone(), window);
    let mut xs: Vec<f32> = text
        .char_indices()
        .map(|(index, _)| f32::from(line.x_for_index(index)))
        .collect();
    xs.push(f32::from(line.width()));
    let ellipsis = f32::from(shape(SharedString::from("\u{2026}"), window).width());
    let glyphs = xs.len() - 1;
    let natural = xs[glyphs] + glyphs as f32 * gap;
    let chars: Vec<char> = text.chars().collect();
    // CSS drops the spaces before the ellipsis ("3 DESTINATIO…").
    let cut = tracked_cut(&xs, gap, ellipsis, f32::from(bounds.size.width)).map(|mut kept| {
        while kept > 0 && chars[kept - 1] == ' ' {
            kept -= 1;
        }
        kept
    });
    let next = Fit {
        text: text.clone(),
        natural,
        cut,
    };
    if *state.read(cx) != next {
        state.update(cx, |fit, _| *fit = next);
        cx.notify(window.current_view());
        window.on_next_frame(|window, _| window.refresh());
    }
}

impl RenderOnce for TrackedText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let gap = tracking_px(self.size, self.tracking_em);
        let name = self.text.clone();
        // CSS puts the spacing after every letter, the last one too.
        let glow = self.glow.then(|| {
            let t = crate::theme::resolve(None, window, cx);
            // Faint enough that the letter-spaced labels keep Electron's
            // crisp medium weight: stronger copies read as a bold, blurred
            // face (L7's 2x crops on 0127cb4cc and 301eabc92). Electron's
            // light glow barely shows on the pale screen.
            if crate::theme::is_dark(t) { 0.2 } else { 0.12 }
        });
        let fit = self.truncate.as_ref().map(|id| fit_state(id, window, cx));
        let (natural, cut) = fit
            .as_ref()
            .map(|state| state.read(cx))
            .filter(|fit| fit.text == self.text)
            .map_or((0.0, None), |fit| (fit.natural, fit.cut));
        let shown: Vec<char> = match cut {
            Some(kept) => self
                .text
                .chars()
                .take(kept)
                .chain(std::iter::once('\u{2026}'))
                .collect(),
            None => self.text.chars().collect(),
        };
        let glyphs = shown.into_iter().map(|glyph| {
            // A lone space would shape to nothing: draw it unbreakable.
            let shown =
                SharedString::from((if glyph == ' ' { '\u{a0}' } else { glyph }).to_string());
            let halo = glow.filter(|_| glyph != ' ').map(|strength| {
                [
                    (-1.0, 0.0),
                    (1.0, 0.0),
                    (0.0, -1.0),
                    (0.0, 1.0),
                    (-1.0, -1.0),
                    (1.0, -1.0),
                    (-1.0, 1.0),
                    (1.0, 1.0),
                ]
                .map(|(x, y)| {
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
        let row = div()
            .flex()
            .flex_none()
            .items_baseline()
            .whitespace_nowrap()
            .children(glyphs);
        let root = div()
            .id(SharedString::from(format!("tracked/{}", self.text)))
            .text_size(px(self.size))
            .aria_label(name);
        let Some(state) = fit else {
            return root.flex().flex_none().child(row).into_any_element();
        };
        let (text, size) = (self.text.clone(), self.size);
        // GPUI items shrink by default (flex-shrink 1); `min-w-0` lets it.
        root.relative()
            .min_w(px(0.0))
            .overflow_hidden()
            .whitespace_nowrap()
            .on_prepaint(move |bounds, window, cx| {
                measure(&state, &text, size, gap, bounds, window, cx)
            })
            .map(|root| {
                if natural > 0.0 {
                    // The whole line's width sizes the box, so it shrinks
                    // and grows like CSS text; the cut line paints over it.
                    root.child(div().w(px(natural)).child("\u{a0}"))
                        .child(row.absolute().top(px(0.0)).left(px(0.0)))
                } else {
                    root.child(row)
                }
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{tracked_cut, tracking_px};

    #[test]
    fn a_line_that_fits_is_not_cut() {
        // Four 10 px glyphs with a 1 px gap: 44 px.
        let xs = [0.0, 10.0, 20.0, 30.0, 40.0];
        assert_eq!(tracked_cut(&xs, 1.0, 10.0, 44.0), None);
        assert_eq!(tracked_cut(&[0.0], 1.0, 10.0, 0.0), None);
    }

    #[test]
    fn an_overflowing_line_keeps_what_fits_before_the_ellipsis() {
        let xs = [0.0, 10.0, 20.0, 30.0, 40.0];
        // 43 px: three glyphs (33) + the ellipsis (10) fit; all four (44) don't.
        assert_eq!(tracked_cut(&xs, 1.0, 10.0, 43.0), Some(3));
        assert_eq!(tracked_cut(&xs, 1.0, 10.0, 32.0), Some(2));
        assert_eq!(tracked_cut(&xs, 1.0, 10.0, 5.0), Some(0));
    }

    #[test]
    fn tracking_is_em_of_the_size() {
        assert!((tracking_px(14.0, 0.08) - 1.12).abs() < 1e-6);
        assert_eq!(tracking_px(14.0, -0.1), 0.0);
    }
}
