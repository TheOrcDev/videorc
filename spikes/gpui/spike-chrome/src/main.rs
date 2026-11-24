//! Plan 260 S0.4 (lane L3): Videorc's Liquid Chrome controls drawn by GPUI.
//!
//! Plan 260 WC-0.6 takes the same shots on Windows (README.md).
//!
//! The same surfaces as the Electron static render (`../electron-harness`):
//! a sidebar with the Studio slab and a plated row, a 40 px toolbar, every
//! Button variant, Record (idle and lit), Go Live, Switch and Slider. Tokens
//! are copied from `apps/desktop/src/renderer/src/styles.css` on origin/main.
//!
//! Two routes for the multi-stop metal (GPUI's `linear_gradient` has two
//! stops and there is no radial):
//!   LC_ROUTE=bands   stacked two-stop bands, each a full-size rounded quad
//!                    clipped to its band by a rectangular content mask;
//!                    beads are three vertical bands plus a soft highlight.
//!   LC_ROUTE=raster  the metal rasterised once per size and scale with resvg
//!                    (already a GPUI dependency): every stop, oklab
//!                    interpolation like Chromium, real radial beads.
//! In both routes the light and shade (inset top and bottom lines, the drop,
//! the Increase Contrast edge, lit Record's glow) are GPUI box shadows.
//!
//! LC_THEME=dark|light, LC_CONTRAST=1 for Increase Contrast, LC_SECS to quit.

use std::{cell::RefCell, collections::HashMap, sync::Arc, time::Duration};

use gpui::{
    AnyElement, App, BorderStyle, Bounds, BoxShadow, ColorSpace, ContentMask, Context, Corners,
    Edges, FontWeight, Hsla, Pixels, RenderImage, Rgba, TimedTransformation, TitlebarOptions,
    Transformation, Window, WindowBounds, WindowOptions, canvas, div, linear_color_stop,
    linear_gradient, point, prelude::*, px, quad, radians, relative, size, svg,
};

// ---------------------------------------------------------------- colour

/// A CSS `oklch(l c h / a)` colour.
#[derive(Clone, Copy, Debug)]
struct Ok {
    l: f32,
    c: f32,
    h: f32,
    a: f32,
}

const fn ok(l: f32, c: f32, h: f32, a: f32) -> Ok {
    Ok { l, c, h, a }
}
const fn gray(l: f32) -> Ok {
    ok(l, 0., 0., 1.)
}
const fn white(a: f32) -> Ok {
    ok(1., 0., 0., a)
}
const fn black(a: f32) -> Ok {
    ok(0., 0., 0., a)
}

impl Ok {
    fn alpha(self, a: f32) -> Ok {
        Ok { a: self.a * a, ..self }
    }
    fn lab(self) -> [f32; 3] {
        let h = self.h.to_radians();
        [self.l, self.c * h.cos(), self.c * h.sin()]
    }
    fn hsla(self) -> Hsla {
        let [r, g, b] = lab_to_srgb(self.lab());
        Rgba { r, g, b, a: self.a }.into()
    }
}

fn lab_to_srgb([l, a, b]: [f32; 3]) -> [f32; 3] {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let lin = [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ];
    lin.map(|c| {
        let c = c.clamp(0., 1.);
        if c <= 0.003_130_8 {
            12.92 * c
        } else {
            1.055 * c.powf(1. / 2.4) - 0.055
        }
    })
}

/// `color` at `opacity` over the opaque `ground`, blended in sRGB as a
/// compositor blends a faded group.
fn faded_over(color: Ok, ground: Ok, opacity: f32) -> Hsla {
    let [r, g, b] = lab_to_srgb(color.lab());
    let [gr, gg, gb] = lab_to_srgb(ground.lab());
    let a = color.a * opacity;
    Rgba { r: gr + (r - gr) * a, g: gg + (g - gg) * a, b: gb + (b - gb) * a, a: 1. }.into()
}

#[derive(Clone, Copy, Debug)]
struct Stop {
    color: Ok,
    pos: f32,
}
const fn st(color: Ok, pos: f32) -> Stop {
    Stop { color, pos }
}

/// Chromium interpolates a gradient with oklch stops in Oklab, premultiplied.
fn sample(stops: &[Stop], t: f32) -> [f32; 4] {
    let (a, b) = match stops.iter().position(|s| s.pos >= t) {
        Some(0) => (stops[0], stops[0]),
        Some(i) => (stops[i - 1], stops[i]),
        None => (stops[stops.len() - 1], stops[stops.len() - 1]),
    };
    let f = if b.pos > a.pos { ((t - a.pos) / (b.pos - a.pos)).clamp(0., 1.) } else { 0. };
    let (la, lb) = (a.color.lab(), b.color.lab());
    let alpha = a.color.a + (b.color.a - a.color.a) * f;
    let mut lab = [0.; 3];
    for i in 0..3 {
        let pa = la[i] * a.color.a;
        let pb = lb[i] * b.color.a;
        lab[i] = if alpha > 0. { (pa + (pb - pa) * f) / alpha } else { 0. };
    }
    let [r, g, b] = lab_to_srgb(lab);
    [r, g, b, alpha]
}

// ---------------------------------------------------------------- tokens

#[derive(Clone)]
struct Theme {
    dark: bool,
    contrast: bool,
    solid: Ok,
    fg: Ok,
    muted_fg: Ok,
    subtle: Ok,
    border: Ok,
    primary: Ok,
    primary_fg: Ok,
    destructive: Ok,
    destructive_bg: f32,
    live_fg: Ok,
    input: Ok,
    chip_top: Ok,
    chip_bottom: Ok,
    chip_rim: Ok,
    chip_hi: Ok,
    chip_drop: Ok,
    fill: Vec<Stop>,
    fill_flat: Ok,
    fill_ink: Ok,
    fill_hi: Ok,
    fill_lo: Ok,
    fill_drop: Ok,
    plate_top: Ok,
    plate_bottom: Ok,
    plate_hi: Ok,
    plate_rim: Ok,
    bead: Vec<Stop>,
    bead_drop: Ok,
    bead_ink: Vec<Stop>,
    bead_ink_drop: Ok,
    led_off: Vec<Stop>,
    led_off_flat: Ok,
    led: Vec<Stop>,
    led_hi: Ok,
    led_lo: Ok,
    led_drop: Ok,
    glow: Ok,
    copper: Vec<Stop>,
    copper_ink: Ok,
    copper_hi: Ok,
    copper_lo: Ok,
    copper_drop: Ok,
    edge: Ok,
    knob_ring: Ok,
    chroma_face: Vec<Stop>,
    chroma_bands: Vec<Stop>,
    chroma_recess: Ok,
    chroma_rim: Ok,
}

fn led_off() -> Vec<Stop> {
    vec![
        st(ok(0.55, 0.2, 25., 1.), 0.),
        st(ok(0.46, 0.19, 25., 1.), 0.4),
        st(ok(0.31, 0.13, 25., 1.), 0.53),
        st(ok(0.39, 0.16, 25., 1.), 0.8),
        st(ok(0.5, 0.19, 25., 1.), 1.),
    ]
}
fn led_lit() -> Vec<Stop> {
    vec![
        st(ok(0.58, 0.23, 27., 1.), 0.),
        st(ok(0.52, 0.23, 27., 1.), 0.4),
        st(ok(0.36, 0.17, 27., 1.), 0.53),
        st(ok(0.45, 0.21, 27., 1.), 0.8),
        st(ok(0.56, 0.22, 27., 1.), 1.),
    ]
}
fn copper() -> Vec<Stop> {
    vec![
        st(ok(0.86, 0.09, 62., 1.), 0.),
        st(ok(0.76, 0.12, 55., 1.), 0.4),
        st(ok(0.63, 0.12, 48., 1.), 0.53),
        st(ok(0.7, 0.12, 52., 1.), 0.8),
        st(ok(0.8, 0.1, 58., 1.), 1.),
    ]
}

/// `--chrome-chromatic-bands`: one band of metal per 120deg, at these
/// lightnesses at 0, 34, 46, 54, 74, 96 and 120 degrees.
fn bands(l: [f32; 7]) -> Vec<Stop> {
    [0., 34., 46., 54., 74., 96., 120.]
        .into_iter()
        .zip(l)
        .map(|(deg, l)| st(gray(l), deg / 120.))
        .collect()
}

impl Theme {
    fn new(dark: bool, contrast: bool) -> Self {
        let ic = |normal: Ok, more: Ok| if contrast { more } else { normal };
        if dark {
            let live = ok(0.62, 0.24, 27., 1.);
            Theme {
                dark,
                contrast,
                solid: gray(0.13),
                fg: gray(0.97),
                muted_fg: ic(gray(0.71), gray(0.8)),
                subtle: ic(gray(0.62), gray(0.68)),
                border: ic(white(0.10), white(0.24)),
                primary: gray(0.97),
                primary_fg: gray(0.13),
                destructive: ok(0.6, 0.23, 27., 1.),
                destructive_bg: 0.2,
                live_fg: gray(0.985),
                input: ic(white(0.10), white(0.24)),
                chip_top: white(0.13),
                chip_bottom: white(0.03),
                chip_rim: ic(white(0.09), white(0.30)),
                chip_hi: white(0.18),
                chip_drop: black(0.30),
                fill: vec![
                    st(gray(1.), 0.),
                    st(gray(0.93), 0.4),
                    st(gray(0.75), 0.52),
                    st(gray(0.88), 0.78),
                    st(gray(0.97), 1.),
                ],
                fill_flat: gray(0.88),
                fill_ink: gray(0.13),
                fill_hi: white(1.),
                fill_lo: black(0.30),
                fill_drop: black(0.60),
                plate_top: white(0.14),
                plate_bottom: white(0.04),
                plate_hi: white(0.16),
                plate_rim: ic(white(0.05), white(0.30)),
                bead: vec![st(gray(1.), 0.), st(gray(0.85), 0.55), st(gray(0.6), 1.)],
                bead_drop: black(0.70),
                bead_ink: vec![st(gray(0.5), 0.), st(gray(0.22), 0.55), st(gray(0.1), 1.)],
                bead_ink_drop: black(0.50),
                led_off: led_off(),
                led_off_flat: ok(0.42, 0.17, 25., 1.),
                led: led_lit(),
                led_hi: white(0.45),
                led_lo: black(0.30),
                led_drop: black(0.50),
                glow: live.alpha(0.6),
                copper: copper(),
                copper_ink: ok(0.2, 0.04, 45., 1.),
                copper_hi: white(0.55),
                copper_lo: ok(0.35, 0.08, 45., 0.45),
                copper_drop: black(0.60),
                edge: ic(white(0.), white(0.55)),
                knob_ring: black(0.35),
                chroma_face: vec![st(gray(0.22), 0.), st(gray(0.16), 0.6), st(gray(0.13), 1.)],
                chroma_bands: bands([0.3, 0.7, 1., 0.82, 0.5, 0.16, 0.3]),
                chroma_recess: black(0.9),
                chroma_rim: black(0.7),
            }
        } else {
            let live = ok(0.55, 0.24, 27., 1.);
            Theme {
                dark,
                contrast,
                solid: gray(0.985),
                fg: gray(0.17),
                muted_fg: ic(gray(0.47), gray(0.38)),
                subtle: ic(gray(0.54), gray(0.45)),
                border: ic(black(0.12), black(0.28)),
                primary: gray(0.17),
                primary_fg: gray(0.985),
                destructive: ok(0.55, 0.24, 27., 1.),
                destructive_bg: 0.1,
                live_fg: gray(0.985),
                input: ic(black(0.12), black(0.28)),
                chip_top: white(0.95),
                chip_bottom: white(0.55),
                chip_rim: ic(black(0.09), black(0.24)),
                chip_hi: white(1.),
                chip_drop: black(0.05),
                fill: vec![
                    st(gray(0.45), 0.),
                    st(gray(0.27), 0.4),
                    st(gray(0.13), 0.54),
                    st(gray(0.23), 0.82),
                    st(gray(0.4), 1.),
                ],
                fill_flat: gray(0.27),
                fill_ink: gray(0.985),
                fill_hi: white(0.35),
                fill_lo: black(0.35),
                fill_drop: black(0.35),
                plate_top: black(0.09),
                plate_bottom: black(0.03),
                plate_hi: white(0.90),
                plate_rim: ic(black(0.07), black(0.28)),
                bead: vec![st(gray(1.), 0.), st(gray(0.9), 0.55), st(gray(0.7), 1.)],
                bead_drop: black(0.35),
                bead_ink: vec![st(gray(1.), 0.), st(gray(0.95), 0.55), st(gray(0.8), 1.)],
                bead_ink_drop: black(0.50),
                led_off: led_off(),
                led_off_flat: ok(0.42, 0.17, 25., 1.),
                led: led_lit(),
                led_hi: white(0.45),
                led_lo: black(0.25),
                led_drop: black(0.30),
                glow: live.alpha(0.45),
                copper: copper(),
                copper_ink: ok(0.2, 0.04, 45., 1.),
                copper_hi: white(0.55),
                copper_lo: ok(0.35, 0.08, 45., 0.45),
                copper_drop: ok(0.3, 0.06, 45., 0.35),
                edge: ic(black(0.), black(0.60)),
                knob_ring: black(0.20),
                chroma_face: vec![st(gray(1.), 0.), st(gray(0.985), 0.6), st(gray(0.95), 1.)],
                chroma_bands: bands([0.27, 0.63, 0.92, 0.74, 0.45, 0.14, 0.27]),
                chroma_recess: black(0.28),
                chroma_rim: black(0.18),
            }
        }
    }
}

// ---------------------------------------------------------------- metal

#[derive(Clone, Copy, PartialEq, Debug)]
enum Route {
    Bands,
    Raster,
}

fn shadow(color: Ok, x: f32, y: f32, blur_css: f32, spread: f32, inset: bool) -> BoxShadow {
    BoxShadow {
        color: color.hsla(),
        offset: point(px(x), px(y)),
        // CSS blur radius is two sigmas; GPUI's blur_radius is the sigma.
        blur_radius: px(blur_css / 2.),
        spread_radius: px(spread),
        inset,
    }
}

thread_local! {
    static RASTERS: RefCell<HashMap<String, Arc<RenderImage>>> = RefCell::new(HashMap::new());
    static RASTER_COUNT: RefCell<usize> = const { RefCell::new(0) };
    static RASTER_MICROS: RefCell<u128> = const { RefCell::new(0) };
}

fn rounded_path(w: f32, h: f32, r: [f32; 4]) -> String {
    // r = [top-left, top-right, bottom-right, bottom-left]
    let [tl, tr, br, bl] = r.map(|r| r.min(w / 2.).min(h / 2.));
    format!(
        "M{tl},0 H{} A{tr},{tr} 0 0 1 {w},{tr} V{} A{br},{br} 0 0 1 {},{h} H{bl} A{bl},{bl} 0 0 1 0,{} V{tl} A{tl},{tl} 0 0 1 {tl},0 Z",
        w - tr,
        h - br,
        w - br,
        h - bl
    )
}

fn svg_stops(stops: &[Stop]) -> String {
    // Dense stops sampled in Oklab, so resvg's sRGB interpolation between
    // them matches Chromium's Oklab gradient to well under one 8-bit step.
    let mut out = String::new();
    for i in 0..=64 {
        let t = i as f32 / 64.;
        let [r, g, b, a] = sample(stops, t);
        out.push_str(&format!(
            "<stop offset=\"{t}\" stop-color=\"rgb({},{},{})\" stop-opacity=\"{a}\"/>",
            (r * 255.).round(),
            (g * 255.).round(),
            (b * 255.).round()
        ));
    }
    out
}

fn rasterise(svg: &str, w: u32, h: u32) -> Arc<RenderImage> {
    if let Some(hit) = RASTERS.with(|c| c.borrow().get(svg).cloned()) {
        return hit;
    }
    let started = std::time::Instant::now();
    let opt = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(svg, &opt).expect("svg");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w.max(1), h.max(1)).expect("pixmap");
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let (pw, ph) = (pixmap.width(), pixmap.height());
    let mut data = pixmap.take();
    for px in data.chunks_exact_mut(4) {
        // Premultiplied RGBA → straight BGRA, as GPUI's own SVG images are.
        let a = px[3] as f32 / 255.;
        let un = |c: u8| if a > 0. { ((c as f32 / a).round()).min(255.) as u8 } else { 0 };
        let (r, g, b) = (un(px[0]), un(px[1]), un(px[2]));
        px[0] = b;
        px[1] = g;
        px[2] = r;
    }
    let buffer = image::RgbaImage::from_raw(pw, ph, data).unwrap();
    let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
    RASTERS.with(|c| c.borrow_mut().insert(svg.to_string(), image.clone()));
    RASTER_COUNT.with(|c| *c.borrow_mut() += 1);
    RASTER_MICROS.with(|c| *c.borrow_mut() += started.elapsed().as_micros());
    image
}

fn device_size(bounds: Bounds<Pixels>, scale: f32) -> (u32, u32) {
    (
        (f32::from(bounds.size.width) * scale).round() as u32,
        (f32::from(bounds.size.height) * scale).round() as u32,
    )
}

fn corners(radii: [f32; 4]) -> Corners<Pixels> {
    Corners {
        top_left: px(radii[0]),
        top_right: px(radii[1]),
        bottom_right: px(radii[2]),
        bottom_left: px(radii[3]),
    }
}

/// A vertical multi-stop metal fill, as `linear-gradient(to bottom, …)`.
fn paint_metal(window: &mut Window, bounds: Bounds<Pixels>, stops: &[Stop], radii: [f32; 4], route: Route) {
    let h = f32::from(bounds.size.height);
    let w = f32::from(bounds.size.width);
    let radii = radii.map(|r| r.min(h / 2.).min(w / 2.));
    match route {
        Route::Bands => {
            for pair in stops.windows(2) {
                let (a, b) = (pair[0], pair[1]);
                let top = bounds.origin.y + px(h * a.pos);
                let bottom = bounds.origin.y + px(h * b.pos);
                let band = Bounds::from_corners(point(bounds.left(), top), point(bounds.right(), bottom));
                window.with_content_mask(Some(ContentMask { bounds: band }), |window| {
                    window.paint_quad(quad(
                        bounds,
                        corners(radii),
                        linear_gradient(
                            180.,
                            linear_color_stop(a.color.hsla(), a.pos),
                            linear_color_stop(b.color.hsla(), b.pos),
                        )
                        .color_space(ColorSpace::Oklab),
                        Edges::default(),
                        Hsla::transparent_black(),
                        BorderStyle::default(),
                    ));
                });
            }
        }
        Route::Raster => {
            let s = window.scale_factor();
            let (dw, dh) = device_size(bounds, s);
            let svg = format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{dw}\" height=\"{dh}\"><defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">{}</linearGradient></defs><path d=\"{}\" fill=\"url(#g)\"/></svg>",
                svg_stops(stops),
                rounded_path(dw as f32, dh as f32, radii.map(|r| r * s))
            );
            let image = rasterise(&svg, dw, dh);
            let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
        }
    }
}

/// `radial-gradient(circle at 35% 30%, …)` on a round knob.
fn paint_bead(window: &mut Window, bounds: Bounds<Pixels>, stops: &[Stop], route: Route) {
    let d = f32::from(bounds.size.width);
    match route {
        Route::Bands => {
            // No radial in GPUI: the bead's three stops top to bottom, and a
            // soft highlight where the radial's centre sits.
            paint_metal(window, bounds, stops, [d / 2.; 4], Route::Bands);
            let c = point(bounds.origin.x + px(d * 0.35), bounds.origin.y + px(d * 0.30));
            let r = d * 0.12;
            let spot = Bounds::from_corners(point(c.x - px(r), c.y - px(r)), point(c.x + px(r), c.y + px(r)));
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                window.paint_drop_shadows(
                    spot,
                    Corners::all(px(r)),
                    &[shadow(stops[0].color.alpha(0.9), 0., 0., d * 0.25, 0., false)],
                );
            });
        }
        Route::Raster => {
            let s = window.scale_factor();
            let (dw, _) = device_size(bounds, s);
            let dd = dw as f32;
            let (cx, cy) = (dd * 0.35, dd * 0.30);
            // farthest-corner, the CSS default size
            let r = ((dd - cx).powi(2) + (dd - cy).powi(2)).sqrt();
            let svg = format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{dw}\" height=\"{dw}\"><defs><radialGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\">{}</radialGradient></defs><circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"url(#g)\"/></svg>",
                svg_stops(stops),
                dd / 2.,
                dd / 2.,
                dd / 2.
            );
            let image = rasterise(&svg, dw, dw);
            let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
        }
    }
}

fn metal(stops: Vec<Stop>, radii: [f32; 4], route: Route) -> impl IntoElement {
    canvas(|_, _, _| (), move |bounds, _, window, _| paint_metal(window, bounds, &stops, radii, route))
        .absolute()
        .top_0()
        .left_0()
        .size_full()
}

/// The inset top and bottom lines a chrome control carries over its metal.
fn sheen(hi: Ok, lo: Option<Ok>, radius: f32) -> impl IntoElement {
    let mut shadows = vec![shadow(hi, 0., 1., 0., 0., true)];
    if let Some(lo) = lo {
        shadows.push(shadow(lo, 0., -1., 0., 0., true));
    }
    div().absolute().top_0().left_0().size_full().rounded(px(radius)).shadow(shadows)
}

// ---------------------------------------------------------------- controls

#[derive(Clone, Copy, PartialEq)]
enum Variant {
    Default,
    Solid,
    Secondary,
    Outline,
    Ghost,
    Destructive,
    Link,
    Record,
    GoLive,
}

const FONT: &str = ".SystemUIFont";

fn button(t: &Theme, route: Route, variant: Variant, label: &'static str, lit: bool, disabled: bool) -> AnyElement {
    let r = 6.;
    let base = || div()
        .relative()
        .h(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(r))
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(FontWeight::MEDIUM);
    let base = base;
    let text = |color: Ok| div().relative().px(px(12.)).text_color(color.hsla()).child(label);
    let edge = shadow(t.edge, 0., 0., 0., 1., false);
    let metal_button = |stops: &Vec<Stop>, flat: Ok, ink: Ok, hi: Ok, lo: Ok, drop: Ok, glow: Option<Ok>| {
        if disabled {
            // Chromium fades a disabled button as one group (opacity: 0.5),
            // so its label keeps its contrast against its own fill. GPUI
            // fades each primitive on its own, which drops the label into
            // the fill: paint the group's result instead, each colour taken
            // halfway to the solid the button sits on.
            let half = |c: Ok| faded_over(c, t.solid, 0.5);
            return base()
                .bg(half(flat))
                .shadow(vec![BoxShadow { color: t.edge.alpha(0.5).hsla(), ..edge.clone() }])
                .child(div().relative().px(px(12.)).text_color(half(ink)).child(label))
                .into_any_element();
        }
        let mut drops = vec![shadow(drop, 0., 1., 3., 0., false), edge.clone()];
        if let Some(glow) = glow {
            // lit Record's ::after: 0 0 12px 1px, at the breath's peak.
            drops.push(shadow(glow, 0., 0., 12., 1., false));
        }
        base()
            .shadow(drops)
            .child(metal(stops.clone(), [r; 4], route))
            .child(sheen(hi, Some(lo), r))
            .child(text(ink))
            .into_any_element()
    };
    match variant {
        Variant::Default => metal_button(&t.fill, t.fill_flat, t.fill_ink, t.fill_hi, t.fill_lo, t.fill_drop, None),
        Variant::Record if lit => metal_button(&t.led, t.led_off_flat, t.live_fg, t.led_hi, t.led_lo, t.led_drop, Some(t.glow)),
        Variant::Record => metal_button(&t.led_off, t.led_off_flat, t.live_fg, t.led_hi, t.led_lo, t.led_drop, None),
        Variant::GoLive => metal_button(&t.copper, gray(0.72), t.copper_ink, t.copper_hi, t.copper_lo, t.copper_drop, None),
        Variant::Solid => base()
            .border_1()
            .border_color(Hsla::transparent_black())
            .child(div().absolute().top(px(1.)).left(px(1.)).right(px(1.)).bottom(px(1.)).rounded(px(r - 1.)).bg(t.primary.hsla()))
            .child(text(t.primary_fg))
            .into_any_element(),
        Variant::Secondary => base()
            .border_1()
            .border_color(t.chip_rim.hsla())
            .bg(linear_gradient(180., linear_color_stop(t.chip_top.hsla(), 0.), linear_color_stop(t.chip_bottom.hsla(), 1.)).color_space(ColorSpace::Oklab))
            .shadow(vec![shadow(t.chip_hi, 0., 1., 0., 0., true), shadow(t.chip_drop, 0., 1., 2., 0., false)])
            .child(text(t.fg))
            .into_any_element(),
        Variant::Outline => base().border_1().border_color(t.border.hsla()).child(text(t.fg)).into_any_element(),
        Variant::Ghost => base().border_1().border_color(Hsla::transparent_black()).child(text(t.fg)).into_any_element(),
        Variant::Destructive => base()
            .border_1()
            .border_color(Hsla::transparent_black())
            .child(div().absolute().top(px(1.)).left(px(1.)).right(px(1.)).bottom(px(1.)).rounded(px(r - 1.)).bg(t.destructive.alpha(t.destructive_bg).hsla()))
            .child(text(t.destructive))
            .into_any_element(),
        Variant::Link => base().border_1().border_color(Hsla::transparent_black()).child(text(t.primary)).into_any_element(),
    }
}

fn bead(t: &Theme, route: Route, ink: bool, d: f32) -> impl IntoElement {
    let (stops, drop) = if ink { (t.bead_ink.clone(), t.bead_ink_drop) } else { (t.bead.clone(), t.bead_drop) };
    div()
        .relative()
        .size(px(d))
        .rounded_full()
        // ring-1 ring-knob-ring over the bead's own 0 1px 2px drop
        .shadow(vec![shadow(drop, 0., 1., 2., 0., false), shadow(t.knob_ring, 0., 0., 0., 1., false)])
        .child(
            canvas(|_, _, _| (), move |bounds, _, window, _| paint_bead(window, bounds, &stops, route))
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
        )
}

fn switch(t: &Theme, route: Route, on: bool, small: bool) -> AnyElement {
    let (w, h, knob) = if small { (24., 16., 12.) } else { (32., 20., 16.) };
    let track = div().relative().w(px(w)).h(px(h)).rounded_full().flex().items_center().p(px(2.));
    let knob_el = div().relative().when(on, |d| d.ml(px(knob - 4.))).child(bead(t, route, on, knob));
    if on {
        track
            .shadow(vec![shadow(t.fill_drop, 0., 1., 3., 0., false), shadow(t.edge, 0., 0., 0., 1., false)])
            .child(metal(t.fill.clone(), [h / 2.; 4], route))
            .child(sheen(t.fill_hi, Some(t.fill_lo), h / 2.))
            .child(knob_el)
            .into_any_element()
    } else {
        track.bg(t.input.alpha(0.9).hsla()).child(knob_el).into_any_element()
    }
}

fn slider(t: &Theme, route: Route, value: f32, width: f32) -> AnyElement {
    // thumbAlignment="edge": the 16 px thumb stays inside the track and the
    // range ends under its centre.
    let thumb_left = value * (width - 16.);
    let range = thumb_left + 8.;
    div()
        .relative()
        .w(px(width))
        .h(px(4.))
        .child(
            div()
                .relative()
                .w_full()
                .h(px(4.))
                .rounded_full()
                .bg(t.fg.alpha(0.15).hsla())
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .h_full()
                        .w(px(range))
                        .shadow(vec![shadow(t.fill_drop, 0., 1., 3., 0., false), shadow(t.edge, 0., 0., 0., 1., false)])
                        .child(metal(t.fill.clone(), [2., 0., 0., 2.], route))
                        .child(sheen_corners(t.fill_hi, t.fill_lo)),
                ),
        )
        .child(div().absolute().top(px(-6.)).left(px(thumb_left)).child(bead(t, route, false, 16.)))
        .into_any_element()
}

fn sheen_corners(hi: Ok, lo: Ok) -> impl IntoElement {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded_l(px(2.))
        .shadow(vec![shadow(hi, 0., 1., 0., 0., true), shadow(lo, 0., -1., 0., 0., true)])
}

// ---------------------------------------------------------------- chromatic

/// How the chromatic ring moves.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Motion {
    /// GPUI turns the ring's sprites on its animation clock and presents the
    /// scene it has, without rendering the view again.
    Timed { max_fps: Option<f32> },
    /// The view renders again every frame and paints each sprite at its angle
    /// (the per-frame redraw route, for the cost comparison).
    Redraw,
    /// Held at `secs` into the loop, for the side-by-side shots.
    Freeze(f32),
}

/// The ring's two layers turn at the CSS rates: the bands one turn per 9 s
/// clockwise (`--chrome-chromatic-flow`), the glints 1.5 turns per 9 s the
/// other way.
const BANDS_TURN: f32 = 9.;
const GLINTS_TURN: f32 = 6.;
/// The square every ring sprite fills: wider than the button's diagonal, so
/// a turned sprite still covers every corner.
const RING_SPRITE: f32 = 220.;

thread_local! {
    static FRAMES: RefCell<u64> = const { RefCell::new(0) };
    static RENDERS: RefCell<u64> = const { RefCell::new(0) };
}

/// LC_FRAMES=1: count display-link frames with a chained next-frame
/// callback (the same small demand in every mode).
fn count_frames(window: &Window) {
    window.on_next_frame(|window, _| {
        FRAMES.with(|f| *f.borrow_mut() += 1);
        count_frames(window);
    });
}

thread_local! {
    static RING_SVGS: RefCell<HashMap<String, Arc<[u8]>>> = RefCell::new(HashMap::new());
}

/// A conic gradient of one colour as an SVG alpha mask: 720 half-degree
/// wedges with `alpha(deg)` as their opacity, drawn without antialiasing so
/// neighbours meet without a seam or an overlap (the steps between them are
/// far below one 8-bit level, and GPUI filters the mask as it turns it). GPUI keeps the opacity in the sprite's mask, and tints
/// the mask with the element's text colour.
fn conic_mask(key: &str, alpha: impl Fn(f32) -> f32) -> Arc<[u8]> {
    if let Some(hit) = RING_SVGS.with(|c| c.borrow().get(key).cloned()) {
        return hit;
    }
    let d = RING_SPRITE;
    let c = d / 2.;
    let r = d;
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{d}\" height=\"{d}\" viewBox=\"0 0 {d} {d}\" shape-rendering=\"crispEdges\">");
    for i in 0..720 {
        let deg = i as f32 / 2.;
        let a = alpha(deg + 0.25).clamp(0., 1.);
        if a < 0.002 {
            continue;
        }
        let (t0, t1) = (deg.to_radians(), (deg + 0.5).to_radians());
        // CSS conic angles start at the top and run clockwise.
        svg.push_str(&format!(
            "<path d=\"M{c},{c} L{},{} L{},{} Z\" fill=\"#fff\" fill-opacity=\"{a:.4}\"/>",
            c + r * t0.sin(),
            c - r * t0.cos(),
            c + r * t1.sin(),
            c - r * t1.cos()
        ));
    }
    svg.push_str("</svg>");
    let bytes: Arc<[u8]> = Arc::from(svg.into_bytes());
    RING_SVGS.with(|c| c.borrow_mut().insert(key.to_string(), bytes.clone()));
    bytes
}

/// `--chrome-chromatic-glints`, repeating every 90deg: a white glint at 8deg
/// and a black one at 62deg, each fading to transparent.
fn glint_white(deg: f32) -> f32 {
    let g = deg.rem_euclid(90.);
    if g < 8. { 0.65 * g / 8. } else if g < 18. { 0.65 * (18. - g) / 10. } else { 0. }
}
fn glint_black(deg: f32) -> f32 {
    let g = deg.rem_euclid(90.);
    if (50. ..62.).contains(&g) { 0.4 * (g - 50.) / 12. } else if (62. ..74.).contains(&g) { 0.4 * (74. - g) / 12. } else { 0. }
}

fn ring_sprite(mask: Arc<[u8]>, color: Ok, turn_secs: f32, clockwise: bool, motion: Motion, now: f32) -> impl IntoElement {
    let sign = if clockwise { 1. } else { -1. };
    let pose = |secs: f32| Transformation::rotate(radians(sign * std::f32::consts::TAU * (secs / turn_secs).fract()));
    let sprite = svg()
        .data(&mask)
        .absolute()
        .left(relative(0.5))
        .top(relative(0.5))
        .ml(px(-RING_SPRITE / 2.))
        .mt(px(-RING_SPRITE / 2.))
        .size(px(RING_SPRITE))
        .text_color(color.hsla());
    match motion {
        Motion::Timed { max_fps } => {
            let turn = TimedTransformation::new(Duration::from_secs_f32(turn_secs))
                .from(Transformation::default())
                .to(Transformation::rotate(radians(sign * std::f32::consts::TAU)));
            let turn = match max_fps {
                Some(fps) => turn.with_max_fps(fps),
                None => turn,
            };
            sprite.with_timed_transformation(turn)
        }
        Motion::Redraw => sprite.with_transformation(pose(now)),
        Motion::Freeze(secs) => sprite.with_transformation(pose(secs)),
    }
}

/// Button `variant="chromatic"`: a face of the theme's solid in a 2 px ring
/// of liquid chrome whose bands flow around it while glints run against
/// them. The bands are grey, so each layer is one tinted, turning sprite: the
/// bands a white mask over black, the glints a white and a black mask.
fn chromatic(t: &Theme, route: Route, label: &'static str, motion: Motion, now: f32) -> AnyElement {
    let r = 6.;
    let theme_key = if t.dark { "dark" } else { "light" };
    let band_stops = t.chroma_bands.clone();
    let bands = conic_mask(&format!("bands-{theme_key}"), move |deg| sample(&band_stops, deg.rem_euclid(120.) / 120.)[0]);
    let white_glints = conic_mask("glints-white", glint_white);
    let black_glints = conic_mask("glints-black", glint_black);
    let ground = t.solid;
    let sheen = vec![st(white(0.35), 0.), st(white(0.), 0.3), st(black(0.), 0.7), st(black(0.35), 1.)];
    let (rim, edge) = (t.chroma_rim, t.edge);
    div()
        .relative()
        .h(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(r))
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(FontWeight::MEDIUM)
        .shadow(vec![shadow(t.fill_drop, 0., 1., 3., 0., false)])
        // The ring: the bands over black, then the glints, clipped to the
        // button's box.
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .bg(black(1.).hsla())
                .child(ring_sprite(bands, white(1.), BANDS_TURN, true, motion, now))
                .child(ring_sprite(white_glints, white(1.), GLINTS_TURN, false, motion, now))
                .child(ring_sprite(black_glints, black(1.), GLINTS_TURN, false, motion, now)),
        )
        .child(
            canvas(|_, _, _| (), move |bounds, _, window, _| {
                // Content masks are rectangles, so the turning sprites fill
                // the box's square corners: cover them with the ground the
                // button sits on (a border whose inner edge is the button's
                // rounded corner), then lay the ring's sheen.
                window.with_content_mask(Some(ContentMask { bounds }), |window| {
                    window.paint_quad(quad(
                        bounds.dilate(px(4.)),
                        Corners::all(px(r + 4.)),
                        Hsla::transparent_black(),
                        Edges::all(px(4.)),
                        ground.hsla(),
                        BorderStyle::Solid,
                    ));
                });
                paint_metal(window, bounds, &sheen, [r; 4], route);
            })
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
        // The face, inside the 2 px ring, with the recess under its top.
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(2.))
                .right(px(2.))
                .bottom(px(2.))
                .child(metal(t.chroma_face.clone(), [r - 2.; 4], route))
                .child(div().absolute().top_0().left_0().size_full().rounded(px(r - 2.)).shadow(vec![shadow(t.chroma_recess, 0., 1., 3., 0., true)])),
        )
        // The rim and the Increase Contrast edge: 1 px rings outside the box.
        .child(
            canvas(|_, _, _| (), move |bounds, _, window, _| {
                for color in [rim, edge] {
                    window.paint_quad(quad(
                        bounds.dilate(px(1.)),
                        Corners::all(px(r + 1.)),
                        Hsla::transparent_black(),
                        Edges::all(px(1.)),
                        color.hsla(),
                        BorderStyle::Solid,
                    ));
                }
            })
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
        .child(div().relative().px(px(14.)).text_color(t.fg.hsla()).child(label))
        .into_any_element()
}

// ---------------------------------------------------------------- page

struct Page {
    theme: Theme,
    route: Route,
    motion: Motion,
    chromatic: bool,
    started: std::time::Instant,
}

fn section_label(t: &Theme, label: &'static str) -> impl IntoElement {
    div()
        .text_size(px(11.))
        .line_height(px(16.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.subtle.hsla())
        .child(label)
}

fn section_label_tight(t: &Theme, label: &'static str) -> impl IntoElement {
    div()
        .text_size(px(11.))
        .line_height(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(t.subtle.hsla())
        .child(label)
}

fn nav_row(t: &Theme, label: &'static str, active: bool) -> impl IntoElement {
    let row = div()
        .relative()
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .text_size(px(14.))
        .line_height(px(20.));
    if active {
        row.bg(linear_gradient(180., linear_color_stop(t.plate_top.hsla(), 0.), linear_color_stop(t.plate_bottom.hsla(), 1.)).color_space(ColorSpace::Oklab))
            .shadow(vec![shadow(t.plate_hi, 0., 1., 0., 0., true), shadow(t.plate_rim, 0., 0., 0., 1., true)])
            .font_weight(FontWeight::MEDIUM)
            .text_color(t.fg.hsla())
            .child(label)
    } else {
        row.text_color(t.muted_fg.hsla()).child(label)
    }
}

fn studio_slab(t: &Theme, route: Route) -> impl IntoElement {
    div()
        .relative()
        .h(px(40.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(FontWeight::MEDIUM)
        .shadow(vec![shadow(t.fill_drop, 0., 1., 3., 0., false), shadow(t.edge, 0., 0., 0., 1., false)])
        .child(metal(t.fill.clone(), [8.; 4], route))
        .child(sheen(t.fill_hi, Some(t.fill_lo), 8.))
        .child(div().relative().text_color(t.fill_ink.hsla()).child("Studio"))
}

fn group(t: &Theme, label: &'static str, children: Vec<AnyElement>) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(section_label(t, label))
        .child(div().flex().flex_wrap().items_center().gap(px(8.)).children(children))
}

impl Render for Page {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.theme;
        let r = self.route;
        let now = self.started.elapsed().as_secs_f32();
        RENDERS.with(|r| *r.borrow_mut() += 1);
        if self.chromatic && self.motion == Motion::Redraw {
            window.request_animation_frame();
        }
        let sidebar = div()
            .w(px(208.))
            .h_full()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(t.border.hsla())
            .child(div().h(px(40.)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .px(px(12.))
                    .pt(px(4.))
                    .child(studio_slab(t, r))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().px(px(10.)).pb(px(4.)).line_height(px(11.)).child(section_label_tight(t, "Setup")))
                            .child(nav_row(t, "Scenes", false))
                            .child(nav_row(t, "Sources", false))
                            .child(nav_row(t, "Assets", false)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().px(px(10.)).pb(px(4.)).child(section_label_tight(t, "Livestream")))
                            .child(nav_row(t, "Destinations", true))
                            .child(nav_row(t, "Stream Manager", false))
                            .child(nav_row(t, "Sidekick", false)),
                    ),
            );
        let body = div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .p(px(16.))
            .child(group(
                t,
                "Buttons",
                vec![
                    button(t, r, Variant::Default, "Continue", false, false),
                    button(t, r, Variant::Solid, "Save", false, false),
                    button(t, r, Variant::Secondary, "Secondary", false, false),
                    button(t, r, Variant::Outline, "Outline", false, false),
                    button(t, r, Variant::Ghost, "Ghost", false, false),
                    button(t, r, Variant::Destructive, "Delete", false, false),
                    button(t, r, Variant::Link, "Link", false, false),
                    button(t, r, Variant::Default, "Disabled", false, true),
                ]
                .into_iter()
                .chain(self.chromatic.then(|| chromatic(t, r, "Chromatic", self.motion, now)))
                .collect(),
            ))
            .child(group(
                t,
                "Record and Go Live",
                vec![
                    button(t, r, Variant::Record, "Record", false, false),
                    button(t, r, Variant::Record, "Stop recording", true, false),
                    button(t, r, Variant::GoLive, "Go Live", false, false),
                    button(t, r, Variant::Record, "Record", false, true),
                ],
            ))
            .child(group(
                t,
                "Switch",
                vec![
                    switch(t, r, false, false),
                    switch(t, r, true, false),
                    switch(t, r, false, true),
                    switch(t, r, true, true),
                ],
            ))
            .child(group(t, "Slider", vec![slider(t, r, 0.4, 240.), slider(t, r, 0.75, 240.)]))
            .when(std::env::var("LC_PROBE").as_deref() == Ok("1"), |d| {
                d.child(group(
                    t,
                    "Weight probe",
                    [400., 450., 500., 510., 550., 560., 590., 600.]
                        .into_iter()
                        .map(|w| {
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight(w))
                                .child(format!("Continue {w}"))
                                .into_any_element()
                        })
                        .collect(),
                ))
            });
        let content = div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(40.))
                    .flex_none()
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(t.border.hsla())
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(t.fg.hsla())
                    .child("Liquid Chrome"),
            )
            .child(body);
        div()
            .size_full()
            .flex()
            .bg(t.solid.hsla())
            .font_family(FONT)
            .text_color(t.fg.hsla())
            .child(sidebar)
            .child(content)
    }
}

fn main() {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let dark = env("LC_THEME") != "light";
    let contrast = env("LC_CONTRAST") == "1";
    let route = if env("LC_ROUTE") == "raster" { Route::Raster } else { Route::Bands };
    let secs: u64 = env("LC_SECS").parse().unwrap_or(12);
    let chromatic_on = env("LC_CHROMATIC") != "0";
    let motion = match (env("LC_MOTION").as_str(), env("LC_FREEZE").parse::<f32>()) {
        (_, Ok(secs)) => Motion::Freeze(secs),
        ("redraw", _) => Motion::Redraw,
        _ => Motion::Timed { max_fps: env("LC_MAX_FPS").parse().ok() },
    };
    let system_titlebar = env("LC_TITLEBAR") == "system";
    let minimize_after: Option<u64> = env("LC_MINIMIZE_AFTER").parse().ok();
    println!("[lc] chromatic {chromatic_on} motion {motion:?}");
    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1650.), px(962.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                // The kit's window chrome, as window-glass.ts gives Electron's
                // main window: the title bar hidden, the traffic lights inset
                // on the 40 px toolbar band (x 14, y (40 - 14) / 2), the
                // theme's solid behind everything. LC_TITLEBAR=system shows
                // GPUI's default instead: AppKit's own title bar, a grey strip
                // over the app's solid.
                titlebar: Some(if system_titlebar {
                    TitlebarOptions { title: Some("Liquid Chrome (GPUI)".into()), appears_transparent: false, traffic_light_position: None }
                } else {
                    TitlebarOptions {
                        title: Some("Liquid Chrome (GPUI)".into()),
                        appears_transparent: true,
                        traffic_light_position: Some(point(px(14.), px(13.))),
                    }
                }),
                ..Default::default()
            },
            move |window, cx| {
                // macOS: the window number, for `screencapture -l`.
                #[cfg(target_os = "macos")]
                {
                    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                    if let Ok(h) = window.window_handle() {
                        if let RawWindowHandle::AppKit(a) = h.as_raw() {
                            let ns_view: &objc2::runtime::AnyObject = unsafe { a.ns_view.cast().as_ref() };
                            let ns_window: *mut objc2::runtime::AnyObject = unsafe { objc2::msg_send![ns_view, window] };
                            let number: isize = unsafe { objc2::msg_send![ns_window, windowNumber] };
                            println!("[lc] window-number {number} scale {}", window.scale_factor());
                        }
                    }
                }
                println!("[lc] window open, scale {}", window.scale_factor());
                if std::env::var("LC_FRAMES").as_deref() == Ok("1") {
                    count_frames(window);
                }
                cx.new(|_| Page {
                    theme: Theme::new(dark, contrast),
                    route,
                    motion,
                    chromatic: chromatic_on,
                    started: std::time::Instant::now(),
                })
            },
        )
        .expect("open window");
        cx.activate(true);
        if let Some(after) = minimize_after {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(after)).await;
                cx.update(|cx| {
                    if let Some(window) = cx.windows().first() {
                        window.update(cx, |_, window, _| window.minimize_window()).ok();
                        println!("[lc] minimized");
                    }
                });
            })
            .detach();
        }
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_secs(secs)).await;
            println!("[lc] rasters built: {} in {} us", RASTER_COUNT.with(|c| *c.borrow()), RASTER_MICROS.with(|c| *c.borrow()));
            println!("[lc] frames {} renders {} in {secs} s", FRAMES.with(|f| *f.borrow()), RENDERS.with(|r| *r.borrow()));
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}
