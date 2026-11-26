//! Letter spacing (`tracking-[…em]`) where GPUI has none: [`TrackedText`]
//! lays a short line out glyph by glyph with the tracking as the gap, as CSS
//! adds it after each letter. It is for short display lines (the Retro LCD's
//! `tracking-[0.08em]`, its keys' `0.04em`) in a monospace face, where each
//! glyph's own advance is the font's. The line is one name for assistive
//! tech; it never wraps. With [`TrackedText::truncate`] it ends in a tracked
//! `…` where it would overflow, as CSS `letter-spacing` + `text-overflow:
//! ellipsis` does.

use gpui::{
    App, ElementId, Font, Hsla, IntoElement, Pixels, ShapedLine, SharedString, TextAlign, TextRun,
    Window, canvas, div, point, prelude::*, px,
};

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
    /// back when there's room, and the cut is painted in the same frame, for
    /// its final width. `id` names the line's element; give each its own.
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

/// The glow's eight copies, 1 px off each side and corner.
const GLOW_OFFSETS: [(f32, f32); 8] = [
    (-1.0, 0.0),
    (1.0, 0.0),
    (0.0, -1.0),
    (0.0, 1.0),
    (-1.0, -1.0),
    (1.0, -1.0),
    (-1.0, 1.0),
    (1.0, 1.0),
];

/// One glyph shaped on its own (as the glyph-by-glyph row lays it out): its
/// ink, and its glow copy in the ink at the glow's strength.
struct Glyph {
    ink: ShapedLine,
    glow: Option<ShapedLine>,
}

fn shape_glyph(
    window: &Window,
    glyph: char,
    font: &Font,
    size: Pixels,
    color: Hsla,
    glow: Option<f32>,
) -> Glyph {
    // A lone space would shape to nothing: draw it unbreakable.
    let text = SharedString::from((if glyph == ' ' { '\u{a0}' } else { glyph }).to_string());
    let shape = |color: Hsla| {
        let run = TextRun {
            len: text.len(),
            font: font.clone(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        window
            .text_system()
            .shape_line(text.clone(), size, std::slice::from_ref(&run), None)
    };
    Glyph {
        ink: shape(color),
        glow: glow
            .filter(|_| glyph != ' ')
            .map(|strength| shape(color.opacity(strength))),
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
        if let Some(id) = self.truncate {
            return truncated(id, self.text, self.size, gap, glow, window);
        }
        let glyphs = self.text.chars().map(|glyph| {
            // A lone space would shape to nothing: draw it unbreakable.
            let shown =
                SharedString::from((if glyph == ' ' { '\u{a0}' } else { glyph }).to_string());
            let halo = glow.filter(|_| glyph != ' ').map(|strength| {
                GLOW_OFFSETS.map(|(x, y)| {
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
        root.flex().flex_none().child(row).into_any_element()
    }
}

/// The truncating line, cut in the frame it's laid out in: its box is the
/// whole tracked width (so it shrinks in a flex row, `min-w-0`, and grows
/// back), and a canvas paints the glyphs that fit its final width, then the
/// tracked `…`. The glyphs are shaped here, in the face, size and ink the line
/// inherits (a component renders inside its parent's text style).
fn truncated(
    id: ElementId,
    text: SharedString,
    size: f32,
    gap: f32,
    glow: Option<f32>,
    window: &mut Window,
) -> gpui::AnyElement {
    let mut style = window.text_style();
    style.font_size = px(size).into();
    let font = style.font();
    let line_height = style.line_height_in_pixels(window.rem_size());
    let chars: Vec<char> = text.chars().collect();
    let shape = |glyph: char| shape_glyph(window, glyph, &font, px(size), style.color, glow);
    let glyphs: Vec<Glyph> = chars.iter().map(|&glyph| shape(glyph)).collect();
    let ellipsis = shape('\u{2026}');
    // Untracked x at each glyph boundary.
    let mut xs = Vec::with_capacity(glyphs.len() + 1);
    xs.push(0.0_f32);
    for glyph in &glyphs {
        xs.push(xs[xs.len() - 1] + f32::from(glyph.ink.width()));
    }
    let natural = xs[glyphs.len()] + glyphs.len() as f32 * gap;
    let ellipsis_width = f32::from(ellipsis.ink.width());
    div()
        .id(id)
        .w(px(natural))
        .h(line_height)
        .min_w(px(0.0))
        .overflow_hidden()
        .aria_label(text)
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, cx| {
                    let available = f32::from(bounds.size.width);
                    // CSS drops the spaces before the ellipsis ("3 DESTINATIO…").
                    let cut = tracked_cut(&xs, gap, ellipsis_width, available).map(|mut kept| {
                        while kept > 0 && chars[kept - 1] == ' ' {
                            kept -= 1;
                        }
                        kept
                    });
                    let shown: Vec<&Glyph> = match cut {
                        Some(kept) => glyphs[..kept]
                            .iter()
                            .chain(std::iter::once(&ellipsis))
                            .collect(),
                        None => glyphs.iter().collect(),
                    };
                    let mut x = bounds.origin.x;
                    for glyph in shown {
                        let origin = point(x, bounds.origin.y);
                        if let Some(halo) = &glyph.glow {
                            for (dx, dy) in GLOW_OFFSETS {
                                let at = origin + point(px(dx), px(dy));
                                let _ =
                                    halo.paint(at, line_height, TextAlign::Left, None, window, cx);
                            }
                        }
                        let _ =
                            glyph
                                .ink
                                .paint(origin, line_height, TextAlign::Left, None, window, cx);
                        x += glyph.ink.width() + px(gap);
                    }
                },
            )
            .size_full(),
        )
        .into_any_element()
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
