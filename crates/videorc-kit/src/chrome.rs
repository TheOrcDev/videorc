//! Liquid Chrome on S0.4's route (the owner judged it equal to Electron on
//! macOS, 2026-11-24).
//!
//! GPUI's `linear_gradient` has two stops and there is no radial, so each
//! multi-stop fill and bead is drawn as an SVG and rasterised once per size
//! and scale with resvg (already a GPUI dependency), then painted as an
//! image. The stops are sampled densely in Oklab, premultiplied, as
//! Chromium interpolates the stylesheet's `oklch()` gradients, so resvg's
//! sRGB interpolation between neighbours stays under one 8-bit step. The
//! light and shade lines, drops and rings are GPUI box shadows straight
//! from the tokens.
//!
//! Ported from the S0.4 spike (`~/gpui-scratch/spike-liquid-chrome`), which
//! built and ran against gpui-pre 0.3.14.

use std::{cell::RefCell, collections::HashMap, sync::Arc, time::Duration};

use gpui::{
    BorderStyle, Bounds, BoxShadow, ContentMask, Corners, Edges, Hsla, Pixels, RenderImage,
    TimedTransformation, Transformation, Window, canvas, div, point, prelude::*, px, quad, radians,
    relative, svg,
};

use crate::{
    theme::hsla,
    tokens::{Color, Shadow, Stop, Theme},
};

// ---------------------------------------------------------------- shadows

/// A token shadow as GPUI draws it. CSS's blur radius is two sigmas; GPUI's
/// `blur_radius` is the sigma.
pub fn box_shadow(shadow: &Shadow) -> BoxShadow {
    BoxShadow {
        color: hsla(shadow.color),
        offset: point(px(shadow.x), px(shadow.y)),
        blur_radius: px(shadow.blur / 2.0),
        spread_radius: px(shadow.spread),
        inset: shadow.inset,
    }
}

/// The inset 2 px focus ring (`ring-2 ring-inset ring-ring`).
pub fn focus_ring(t: &Theme) -> gpui::BoxShadow {
    box_shadow(&Shadow {
        inset: true,
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 2.0,
        color: t.ring,
    })
}

/// A token's shadow stack, skipping the fully transparent layers (the
/// Increase Contrast edge outside Increase Contrast).
pub fn shadows(stack: &[Shadow]) -> Vec<BoxShadow> {
    stack
        .iter()
        .filter(|shadow| shadow.color & 0xff != 0)
        .map(box_shadow)
        .collect()
}

// ---------------------------------------------------------------- oklab

fn channels(color: Color) -> [f32; 4] {
    [24, 16, 8, 0].map(|shift| ((color >> shift) & 0xff) as f32 / 255.0)
}

fn to_linear(c: f32) -> f32 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn to_gamma(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_to_oklab([r, g, b]: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = [r, g, b].map(to_linear);
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn oklab_to_srgb([l, a, b]: [f32; 3]) -> [f32; 3] {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ]
    .map(to_gamma)
}

/// The gradient's colour at `t` (0 to 1 along the stops' own scale), as
/// sRGB and alpha from 0 to 1: Oklab, premultiplied, as Chromium does.
pub fn sample(stops: &[Stop], t: f32) -> [f32; 4] {
    let Some(last) = stops.last() else {
        return [0.0; 4];
    };
    let (a, b) = match stops.iter().position(|stop| stop.at >= t) {
        Some(0) => (stops[0], stops[0]),
        Some(index) => (stops[index - 1], stops[index]),
        None => (*last, *last),
    };
    let f = if b.at > a.at {
        ((t - a.at) / (b.at - a.at)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let [ar, ag, ab, aa] = channels(a.color);
    let [br, bg, bb, ba] = channels(b.color);
    let (la, lb) = (srgb_to_oklab([ar, ag, ab]), srgb_to_oklab([br, bg, bb]));
    let alpha = aa + (ba - aa) * f;
    let mut lab = [0.0; 3];
    for index in 0..3 {
        let (pa, pb) = (la[index] * aa, lb[index] * ba);
        lab[index] = if alpha > 0.0 {
            (pa + (pb - pa) * f) / alpha
        } else {
            0.0
        };
    }
    let [r, g, b] = oklab_to_srgb(lab);
    [r, g, b, alpha]
}

/// `color-mix(in oklch, a t, b)` for opaque colours where `b` is a grey (the
/// chips' ink over its base). With an achromatic `b` the hue is `a`'s, so
/// Oklab's straight line gives the same colour.
pub fn mix(a: Color, b: Color, t: f32) -> Color {
    let [ar, ag, ab, aa] = channels(a);
    let [br, bg, bb, ba] = channels(b);
    let (la, lb) = (srgb_to_oklab([ar, ag, ab]), srgb_to_oklab([br, bg, bb]));
    let t = t.clamp(0.0, 1.0);
    let lab = [0, 1, 2].map(|index| lb[index] + (la[index] - lb[index]) * t);
    let [r, g, b] = oklab_to_srgb(lab);
    let alpha = ba + (aa - ba) * t;
    let byte = |c: f32| ((c * 255.0).round() as u32).min(0xff);
    (byte(r) << 24) | (byte(g) << 16) | (byte(b) << 8) | byte(alpha)
}

// ---------------------------------------------------------------- raster

thread_local! {
    static RASTERS: RefCell<HashMap<String, Arc<RenderImage>>> = RefCell::new(HashMap::new());
    static MASKS: RefCell<HashMap<String, Arc<[u8]>>> = RefCell::new(HashMap::new());
}

/// 65 stops sampled from the gradient, for an SVG gradient.
fn svg_stops(stops: &[Stop]) -> String {
    let mut out = String::new();
    for index in 0..=64 {
        let t = index as f32 / 64.0;
        let [r, g, b, a] = sample(stops, t);
        out.push_str(&format!(
            "<stop offset=\"{t}\" stop-color=\"rgb({},{},{})\" stop-opacity=\"{a}\"/>",
            (r * 255.0).round(),
            (g * 255.0).round(),
            (b * 255.0).round()
        ));
    }
    out
}

/// A rounded rectangle's outline; `radii` run top-left, top-right,
/// bottom-right, bottom-left.
fn rounded_path(w: f32, h: f32, radii: [f32; 4]) -> String {
    let [tl, tr, br, bl] = radii.map(|r| r.min(w / 2.0).min(h / 2.0));
    format!(
        "M{tl},0 H{} A{tr},{tr} 0 0 1 {w},{tr} V{} A{br},{br} 0 0 1 {},{h} H{bl} A{bl},{bl} 0 0 1 0,{} V{tl} A{tl},{tl} 0 0 1 {tl},0 Z",
        w - tr,
        h - br,
        w - br,
        h - bl
    )
}

/// The SVG drawn once into an image, cached by its source.
pub(crate) fn rasterise_for_kit(svg: &str, w: u32, h: u32) -> Option<Arc<RenderImage>> {
    rasterise(svg, w, h)
}

fn rasterise(svg: &str, w: u32, h: u32) -> Option<Arc<RenderImage>> {
    if let Some(hit) = RASTERS.with(|cache| cache.borrow().get(svg).cloned()) {
        return Some(hit);
    }
    let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w.max(1), h.max(1))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    let (width, height) = (pixmap.width(), pixmap.height());
    let mut data = pixmap.take();
    for pixel in data.as_chunks_mut::<4>().0 {
        // Premultiplied RGBA to straight BGRA, as GPUI's own SVG images are.
        let alpha = pixel[3] as f32 / 255.0;
        let straight = |c: u8| {
            if alpha > 0.0 {
                (c as f32 / alpha).round().min(255.0) as u8
            } else {
                0
            }
        };
        let (r, g, b) = (straight(pixel[0]), straight(pixel[1]), straight(pixel[2]));
        pixel[0] = b;
        pixel[1] = g;
        pixel[2] = r;
    }
    let buffer = image::RgbaImage::from_raw(width, height, data)?;
    let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
        buffer
    )]));
    RASTERS.with(|cache| cache.borrow_mut().insert(svg.to_string(), image.clone()));
    Some(image)
}

fn device_size(bounds: Bounds<Pixels>, scale: f32) -> (u32, u32) {
    (
        (f32::from(bounds.size.width) * scale).round() as u32,
        (f32::from(bounds.size.height) * scale).round() as u32,
    )
}

/// Which way a metal fill runs: `Down` is `linear-gradient(to bottom, …)`,
/// `Up` the pressed control's concave turn (`to top`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Down,
    Up,
}

/// Paints a vertical multi-stop fill into `bounds` with the corner radii.
pub fn paint_metal(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    stops: &[Stop],
    radii: [f32; 4],
    direction: Direction,
) {
    let scale = window.scale_factor();
    let (w, h) = device_size(bounds, scale);
    if w == 0 || h == 0 || stops.is_empty() {
        return;
    }
    let (y1, y2) = match direction {
        Direction::Down => (0, 1),
        Direction::Up => (1, 0),
    };
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\"><defs><linearGradient id=\"g\" x1=\"0\" y1=\"{y1}\" x2=\"0\" y2=\"{y2}\">{}</linearGradient></defs><path d=\"{}\" fill=\"url(#g)\"/></svg>",
        svg_stops(stops),
        rounded_path(w as f32, h as f32, radii.map(|r| r * scale))
    );
    if let Some(image) = rasterise(&svg, w, h) {
        let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
    }
}

/// Paints `radial-gradient(circle at 35% 30%, …)` on a round knob.
pub fn paint_bead(window: &mut Window, bounds: Bounds<Pixels>, stops: &[Stop]) {
    let scale = window.scale_factor();
    let (d, _) = device_size(bounds, scale);
    if d == 0 || stops.is_empty() {
        return;
    }
    let size = d as f32;
    let (cx, cy) = (size * 0.35, size * 0.30);
    // farthest-corner, CSS's default size.
    let r = ((size - cx).powi(2) + (size - cy).powi(2)).sqrt();
    let half = size / 2.0;
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d}\" height=\"{d}\"><defs><radialGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\">{}</radialGradient></defs><circle cx=\"{half}\" cy=\"{half}\" r=\"{half}\" fill=\"url(#g)\"/></svg>",
        svg_stops(stops)
    );
    if let Some(image) = rasterise(&svg, d, d) {
        let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
    }
}

/// A metal fill filling its parent, which must be `relative()`.
pub fn metal(stops: &'static [Stop], radii: [f32; 4], direction: Direction) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| paint_metal(window, bounds, stops, radii, direction),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A bead filling its parent, which must be `relative()` and round.
pub fn bead(stops: &'static [Stop]) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| paint_bead(window, bounds, stops),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A flat colour layer filling its parent: a hover's lift over the metal.
pub fn layer(color: Color, radius: f32) -> gpui::Div {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(px(radius))
        .bg(hsla(color))
}

/// A 1 px ring outside `bounds`, as `0 0 0 1px` paints it.
pub fn paint_ring(window: &mut Window, bounds: Bounds<Pixels>, radius: f32, color: Color) {
    if color & 0xff == 0 {
        return;
    }
    window.paint_quad(quad(
        bounds.dilate(px(1.0)),
        Corners::all(px(radius + 1.0)),
        Hsla::transparent_black(),
        Edges::all(px(1.0)),
        hsla(color),
        BorderStyle::Solid,
    ));
}

/// Covers the square corners outside a rounded box with the ground it sits
/// on (content masks are rectangles, so a turning sprite fills them).
pub fn paint_corners(window: &mut Window, bounds: Bounds<Pixels>, radius: f32, ground: Color) {
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        window.paint_quad(quad(
            bounds.dilate(px(4.0)),
            Corners::all(px(radius + 4.0)),
            Hsla::transparent_black(),
            Edges::all(px(4.0)),
            hsla(ground),
            BorderStyle::Solid,
        ));
    });
}

// ---------------------------------------------------------------- the ring

/// The ring's mask channels: a sprite's opacity lives in its mask, and
/// these tint it to light or shade. They are channels, not theme colours:
/// the ring's bands are grey in every appearance (`--chrome-chromatic-bands`
/// sets their lightness, which becomes the mask's opacity).
pub const MASK_WHITE: Color = 0xffffffff;
pub const MASK_BLACK: Color = 0x000000ff;

/// The scrim under a dialog: the stylesheet's `bg-black/30` on
/// `DialogOverlay`, a literal there too, the same in every appearance.
pub const SCRIM: Color = 0x0000004d;

/// The square every ring sprite fills: wider than a button's diagonal, so a
/// turned sprite still covers every corner.
pub const RING_SPRITE: f32 = 220.0;

/// A conic gradient of one colour as an SVG alpha mask: 720 half-degree
/// wedges with `alpha(turn)` as their opacity, drawn without antialiasing
/// so neighbours meet without a seam. GPUI keeps the opacity in the
/// sprite's mask and tints it with the element's text colour.
pub fn conic_mask(key: &str, alpha: impl Fn(f32) -> f32) -> Arc<[u8]> {
    if let Some(hit) = MASKS.with(|cache| cache.borrow().get(key).cloned()) {
        return hit;
    }
    let d = RING_SPRITE;
    let c = d / 2.0;
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d}\" height=\"{d}\" viewBox=\"0 0 {d} {d}\" shape-rendering=\"crispEdges\">"
    );
    for index in 0..720 {
        let deg = index as f32 / 2.0;
        let a = alpha((deg + 0.25) / 360.0).clamp(0.0, 1.0);
        if a < 0.002 {
            continue;
        }
        let (t0, t1) = (deg.to_radians(), (deg + 0.5).to_radians());
        // CSS conic angles start at the top and run clockwise.
        svg.push_str(&format!(
            "<path d=\"M{c},{c} L{},{} L{},{} Z\" fill=\"white\" fill-opacity=\"{a:.4}\"/>",
            c + d * t0.sin(),
            c - d * t0.cos(),
            c + d * t1.sin(),
            c - d * t1.cos()
        ));
    }
    svg.push_str("</svg>");
    let bytes: Arc<[u8]> = Arc::from(svg.into_bytes());
    MASKS.with(|cache| cache.borrow_mut().insert(key.to_string(), bytes.clone()));
    bytes
}

/// One turning layer of a ring, centred on its parent: `turn` is the time
/// one full turn takes; `motion: false` holds it still (Reduce Motion).
pub fn ring_sprite(
    mask: Arc<[u8]>,
    color: Color,
    turn: Duration,
    clockwise: bool,
    motion: bool,
) -> impl IntoElement {
    let sign = if clockwise { 1.0 } else { -1.0 };
    let sprite = svg()
        .data(&mask)
        .absolute()
        .left(relative(0.5))
        .top(relative(0.5))
        .ml(px(-RING_SPRITE / 2.0))
        .mt(px(-RING_SPRITE / 2.0))
        .size(px(RING_SPRITE))
        .text_color(hsla(color));
    if motion {
        // GPUI turns the sprite on its animation clock without rendering
        // the view again; 60 fps at most (owner, 2026-11-24).
        sprite.with_timed_transformation(
            TimedTransformation::new(turn)
                .from(Transformation::default())
                .to(Transformation::rotate(radians(
                    sign * std::f32::consts::TAU,
                )))
                .with_max_fps(60.0),
        )
    } else {
        sprite.with_transformation(Transformation::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{DARK, LIGHT};

    #[test]
    fn samples_the_stops_at_their_ends() {
        let stops = DARK.chrome_fill_stops;
        let first = channels(stops[0].color);
        let [r, g, b, a] = sample(stops, 0.0);
        assert!((r - first[0]).abs() < 0.01 && (g - first[1]).abs() < 0.01);
        assert!((b - first[2]).abs() < 0.01 && (a - 1.0).abs() < 0.001);
        let last = channels(stops[stops.len() - 1].color);
        assert!((sample(stops, 1.0)[0] - last[0]).abs() < 0.01);
    }

    #[test]
    fn oklab_round_trips() {
        for color in [0x070707ff, 0xfafafaff, 0xea2126ff, 0x4c9debff] {
            let [r, g, b, _] = channels(color);
            let back = oklab_to_srgb(srgb_to_oklab([r, g, b]));
            for (x, y) in [r, g, b].into_iter().zip(back) {
                assert!((x - y).abs() < 0.002, "{color:08x}");
            }
        }
    }

    #[test]
    fn drops_the_transparent_layers() {
        // The Increase Contrast edge is transparent outside Increase Contrast.
        assert_eq!(
            shadows(DARK.chrome_fill_shadow).len(),
            DARK.chrome_fill_shadow.len() - 1
        );
        assert_eq!(
            shadows(LIGHT.chrome_fill_shadow).len(),
            LIGHT.chrome_fill_shadow.len() - 1
        );
    }

    #[test]
    fn halves_the_blur() {
        let shadow = box_shadow(&Shadow {
            inset: false,
            x: 0.0,
            y: 1.0,
            blur: 3.0,
            spread: 0.0,
            color: 0x00000099,
        });
        assert_eq!(shadow.blur_radius, px(1.5));
        assert!(!shadow.inset);
    }

    #[test]
    fn rounds_the_path_within_the_box() {
        assert!(rounded_path(20.0, 10.0, [8.0; 4]).starts_with("M5,0 H15 A5,5"));
    }
}
