//! The Retro LCD's glass (`components/ui/lcd-display.tsx`'s `LcdScreen`):
//! unlit dots behind the ink, the ink broken into dots, and the sheen and
//! scanlines in front. CSS does this with a radial-gradient background, a
//! radial mask on the content and a repeating gradient; GPUI has none of
//! them, so [`LcdScreen`] paints three rasters, each rendered once per size
//! at the display's pixel scale and cached:
//!
//! 1. behind the content, the unlit dots: a dot every `pitch`, the ink at
//!    7% (`before:bg-[radial-gradient(circle, ink-unlit 45%, transparent
//!    55%)]`);
//! 2. over the content, the glass with a hole on every dot: what shows
//!    through is the ink dotted, as the content's `mask-[radial-gradient(
//!    circle, #000 58%, transparent 64%)]` leaves it;
//! 3. on top, the sheen (`linear-gradient(sheen, transparent 45%)`) and a
//!    1 px scanline every 3 px (`repeating-linear-gradient(transparent 0
//!    2px, scanline 2px 3px)`).
//!
//! The holes' layer is painted in `ground`, the colour the glass shows under
//! the ink, so pass the screen's opaque colour there.

use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, IntoElement, Pixels, RenderImage, Window, canvas, div, prelude::*,
};
use smallvec::SmallVec;

use crate::{chrome, tokens::Color};

/// The dot grid's pitch (`--lcd-display-pitch: 2px`).
pub const LCD_PITCH: f32 = 2.0;

/// The screen's colours in one appearance (`LIGHT_SCREEN` / `DARK_SCREEN`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LcdGlassColors {
    /// The lit ink; the unlit dots are it at 7%.
    pub ink: Color,
    /// What the glass shows under the ink, opaque.
    pub ground: Color,
    /// `--lcd-display-sheen`.
    pub sheen: Color,
    /// `--lcd-display-scanline`.
    pub scanline: Color,
    /// `--lcd-display-glow`: the ink's halo (60% dark, 22% light).
    pub glow: Color,
}

impl LcdGlassColors {
    /// Electron's values: dark is unlit glass where the ink glows
    /// (scanlines 22%, sheen 5%); light is a backlit screen with dark
    /// pixels (scanlines 4%, sheen 35%).
    pub fn new(dark: bool, ink: Color, ground: Color) -> Self {
        let (sheen, scanline, glow) = if dark {
            (0xffffff0d, 0x00000038, alpha(ink, 0.6))
        } else {
            (0xffffff59, 0x0000000a, alpha(ink, 0.22))
        };
        LcdGlassColors {
            ink,
            ground,
            sheen,
            scanline,
            glow,
        }
    }
}

fn alpha(color: Color, factor: f32) -> Color {
    let a = ((color & 0xff) as f32 * factor.clamp(0.0, 1.0)).round() as u32;
    (color & 0xffff_ff00) | a.min(0xff)
}

/// `#rrggbb` and an opacity for SVG.
fn svg_color(color: Color) -> (String, f32) {
    (
        format!("#{:06x}", color >> 8),
        (color & 0xff) as f32 / 255.0,
    )
}

/// The unlit dots: a dot of radius 0.7 px every pitch (the 45-55% stops of
/// a circle gradient across a 2 px tile).
fn dots_svg(w: u32, h: u32, scale: f32, ink: Color) -> String {
    let p = LCD_PITCH * scale;
    let (fill, opacity) = svg_color(alpha(ink, 0.07));
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\"><defs><pattern id=\"d\" width=\"{p}\" height=\"{p}\" patternUnits=\"userSpaceOnUse\"><circle cx=\"{c}\" cy=\"{c}\" r=\"{r}\" fill=\"{fill}\" fill-opacity=\"{opacity}\"/></pattern></defs><rect width=\"{w}\" height=\"{h}\" fill=\"url(#d)\"/></svg>",
        c = p / 2.0,
        r = 0.7 * scale,
    )
}

/// The glass over the ink with a hole of radius 0.86 px on every dot (the
/// mask's 58-64% stops): the ink shows only through the holes.
fn holes_svg(w: u32, h: u32, scale: f32, ground: Color) -> String {
    let p = LCD_PITCH * scale;
    let (fill, opacity) = svg_color(ground);
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\"><defs><pattern id=\"h\" width=\"{p}\" height=\"{p}\" patternUnits=\"userSpaceOnUse\"><circle cx=\"{c}\" cy=\"{c}\" r=\"{r}\" fill=\"black\"/></pattern><mask id=\"m\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\"><rect width=\"{w}\" height=\"{h}\" fill=\"white\"/><rect width=\"{w}\" height=\"{h}\" fill=\"url(#h)\"/></mask></defs><rect width=\"{w}\" height=\"{h}\" fill=\"{fill}\" fill-opacity=\"{opacity}\" mask=\"url(#m)\"/></svg>",
        c = p / 2.0,
        r = 0.86 * scale,
    )
}

/// The sheen from the top to 45% of the height, and a 1 px scanline at the
/// third pixel of every 3.
fn front_svg(w: u32, h: u32, scale: f32, colors: &LcdGlassColors, scanlines: bool) -> String {
    let (sheen, sheen_opacity) = svg_color(colors.sheen);
    let (line, line_opacity) = svg_color(colors.scanline);
    let lines = if scanlines {
        format!(
            "<pattern id=\"s\" width=\"{w}\" height=\"{period}\" patternUnits=\"userSpaceOnUse\"><rect y=\"{y}\" width=\"{w}\" height=\"{t}\" fill=\"{line}\" fill-opacity=\"{line_opacity}\"/></pattern>",
            period = 3.0 * scale,
            y = 2.0 * scale,
            t = scale,
        )
    } else {
        String::new()
    };
    let line_rect = if scanlines {
        format!("<rect width=\"{w}\" height=\"{h}\" fill=\"url(#s)\"/>")
    } else {
        String::new()
    };
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\"><defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"{sheen}\" stop-opacity=\"{sheen_opacity}\"/><stop offset=\"0.45\" stop-color=\"{sheen}\" stop-opacity=\"0\"/></linearGradient>{lines}</defs><rect width=\"{w}\" height=\"{h}\" fill=\"url(#g)\"/>{line_rect}</svg>"
    )
}

/// One full-size raster layer, rendered at the window's scale when painted,
/// with the screen's rounded corners (GPUI clips to a rectangle).
fn layer(radius: f32, build: impl Fn(u32, u32, f32) -> String + 'static) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, _, window: &mut Window, _| {
            let scale = window.scale_factor().max(1.0);
            let w = (f32::from(bounds.size.width) * scale).round().max(1.0) as u32;
            let h = (f32::from(bounds.size.height) * scale).round().max(1.0) as u32;
            let image: Option<Arc<RenderImage>> =
                chrome::rasterise_for_kit(&build(w, h, scale), w, h);
            if let Some(image) = image {
                let corners = gpui::Corners::all(gpui::px(radius));
                let _ = window.paint_image(bounds, bounds, corners, image, 0, false);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// The screen's effects around its content: unlit dots behind, the ink in
/// dots, sheen and scanlines in front, over the whole screen as CSS's
/// `inset-0` layers are. Put it as the screen's only child with no padding
/// on the screen (the content carries the padding, `px-4 py-2`), and give
/// it the screen's corner radius.
#[derive(IntoElement)]
pub struct LcdScreen {
    colors: LcdGlassColors,
    radius: f32,
    matrix: bool,
    scanlines: bool,
    children: SmallVec<[AnyElement; 2]>,
}

impl LcdScreen {
    pub fn new(colors: LcdGlassColors) -> Self {
        LcdScreen {
            colors,
            radius: 0.0,
            matrix: true,
            scanlines: true,
            children: SmallVec::new(),
        }
    }

    /// The screen's corner radius, which the layers keep.
    pub fn radius(mut self, radius: f32) -> Self {
        self.radius = radius;
        self
    }

    /// The dot grid: unlit dots and the ink in dots (`matrix`, default on).
    pub fn matrix(mut self, matrix: bool) -> Self {
        self.matrix = matrix;
        self
    }

    /// Faint horizontal scanlines (`scanlines`, default on).
    pub fn scanlines(mut self, scanlines: bool) -> Self {
        self.scanlines = scanlines;
        self
    }
}

impl ParentElement for LcdScreen {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for LcdScreen {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let colors = self.colors;
        let scanlines = self.scanlines;
        let matrix = self.matrix;
        let r = self.radius;
        div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .when(matrix, |screen| {
                screen.child(layer(r, move |w, h, scale| {
                    dots_svg(w, h, scale, colors.ink)
                }))
            })
            .child(div().relative().flex().flex_col().children(self.children))
            .when(matrix, |screen| {
                screen.child(layer(r, move |w, h, scale| {
                    holes_svg(w, h, scale, colors.ground)
                }))
            })
            .child(layer(r, move |w, h, scale| {
                front_svg(w, h, scale, &colors, scanlines)
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_values_per_appearance() {
        let dark = LcdGlassColors::new(true, 0xff8800ff, 0x101010ff);
        assert_eq!(dark.scanline & 0xff, 0x38); // 22%
        assert_eq!(dark.glow & 0xff, 153); // 60%
        let light = LcdGlassColors::new(false, 0xff8800ff, 0xeeeeeeff);
        assert_eq!(light.scanline & 0xff, 0x0a); // 4%
        assert_eq!(light.sheen & 0xff, 0x59); // 35%
    }

    #[test]
    fn patterns_follow_the_pitch_at_scale() {
        assert!(dots_svg(40, 20, 2.0, 0xffffffff).contains("width=\"4\" height=\"4\""));
        assert!(holes_svg(40, 20, 2.0, 0x000000ff).contains("r=\"1.72\""));
        assert!(
            front_svg(40, 20, 2.0, &LcdGlassColors::new(true, 0xffffffff, 0), true)
                .contains("height=\"6\"")
        );
    }
}
