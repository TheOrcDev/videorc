//! Text as the renderer's canvas sets it: the font stack
//! `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` (the system UI
//! font on macOS, Segoe UI on Windows, the fontconfig sans-serif on Linux),
//! shaped by parley (harfrust) with fontique's per-script fallback and colour
//! emoji, and drawn with swash: outlines as coverage masks (zeno), colour
//! bitmaps (sbix, CBDT) scaled from a strike, COLR layers.
//!
//! What Chromium 142 does on macOS, measured against it (the golden cases and
//! `measureText` over 12 to 48 px, every weight): the CSS weight as San
//! Francisco's `wght` and the size as its `opsz` (advances then agree to the
//! 1/64 px); words shaped one by one, so no kerning crosses a space; the
//! fallback from the system UI font's cascade; Apple Color Emoji enlarged
//! under 24 px; `textBaseline` `middle` and `top` from the first font's em box
//! on a 1/64 grid; a `maxWidth` squeeze; glyph x on a quarter pixel and the
//! baseline rounded to a whole one; CoreText's smoothing as a small dilation
//! and Skia's mask gamma as a coverage curve.

use std::sync::{Mutex, OnceLock};

use parley::{
    FontContext, FontFamily, FontVariations, FontWeight, Layout, LayoutContext,
    PositionedLayoutItem, StyleProperty,
};
use swash::scale::image::{Content, Image};
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::{self, Format, Vector};
use swash::{FontRef, GlyphId};
use tiny_skia::{FilterQuality, Pixmap, PixmapPaint, Transform};

use super::canvas::{Rgba, blend_premultiplied, unit_to_u8};

/// The renderer's `canvasFont` family list as fontique reads it. Chromium maps
/// `-apple-system` and `BlinkMacSystemFont` to the system UI font on macOS
/// only; elsewhere both are unknown names and `'Segoe UI'` leads.
#[cfg(target_os = "macos")]
const FONT_STACK: &str = "system-ui, 'Segoe UI', sans-serif";
#[cfg(not(target_os = "macos"))]
const FONT_STACK: &str = "'Segoe UI', sans-serif";

/// `ctx.textAlign`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Align {
    Left,
    Center,
}

/// `ctx.textBaseline`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Baseline {
    #[allow(dead_code, reason = "the caption painter, switched on by S1.2b")]
    Alphabetic,
    Middle,
    Top,
}

/// `ctx.font` (size and weight; the family is the renderer's stack).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Font {
    pub px: f32,
    pub weight: u16,
}

impl Font {
    pub(crate) fn new(px: f32, weight: u16) -> Self {
        Self { px, weight }
    }
}

/// Where and how one `fillText`/`strokeText` call puts its line.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TextPlacement {
    pub x: f32,
    pub y: f32,
    pub align: Align,
    pub baseline: Baseline,
    pub max_width: Option<f32>,
}

/// One shaped glyph run: the font (bytes and collection index), its size and
/// variation coordinates, and glyphs relative to the line's start and
/// alphabetic baseline.
struct ShapedRun {
    font: parley::FontData,
    size: f32,
    coords: Vec<i16>,
    embolden: bool,
    /// The size colour bitmap glyphs are drawn at (`emoji_px`).
    bitmap_px: f32,
    glyphs: Vec<(GlyphId, f32, f32)>,
}

/// A shaped single line: its runs and its advance (the canvas `measureText`
/// width, trailing spaces included).
struct ShapedLine {
    runs: Vec<ShapedRun>,
    width: f32,
}

/// The shared font state: the system font collection (scanned once), the
/// layout scratch and the glyph scaler.
struct Engine {
    fonts: FontContext,
    layouts: LayoutContext<()>,
    scaler: ScaleContext,
    /// The first font of the stack per weight: its ascent and descent per em,
    /// which `middle` and `top` use.
    em_box: Vec<(u16, (f32, f32))>,
}

fn engine() -> &'static Mutex<Engine> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let fonts = FontContext::new();
        #[cfg(target_os = "macos")]
        let fonts = {
            let mut fonts = fonts;
            ui_fallbacks::install(&mut fonts);
            fonts
        };
        Mutex::new(Engine {
            fonts,
            layouts: LayoutContext::new(),
            scaler: ScaleContext::new(),
            em_box: Vec::new(),
        })
    })
}

/// Chromium's fallback on macOS asks CoreText for a font from the system UI
/// font's cascade (`CTFontCreateForString` in
/// `FontCache::PlatformFallbackFontForCharacter`), which holds the UI faces
/// (`.CJK Symbols Fallback SC` for kana, `.Apple SD Gothic NeoI` for Hangul,
/// `.ThonburiUI`…). fontique asks from the default font and gets the document
/// faces, set wider. This puts the UI face first for each script CoreText
/// answers with a face fontique has.
#[cfg(target_os = "macos")]
mod ui_fallbacks {
    use objc2_core_foundation::{CFRange, CFString};
    use objc2_core_text::{CTFont, CTFontUIFontType};
    use parley::FontContext;
    use parley::fontique::{FallbackKey, Script};

    /// Scripts the system font does not cover, with a sample CoreText matches.
    const SAMPLES: &[(&[u8; 4], &str)] = &[
        (b"Hira", "ひらがな"),
        (b"Kana", "カタカナ"),
        (b"Hani", "漢字"),
        (b"Hang", "한국어"),
        (b"Arab", "العربية"),
        (b"Hebr", "עברית"),
        (b"Thai", "ภาษาไทย"),
        (b"Deva", "हिन्दी"),
        (b"Beng", "বাংলা"),
        (b"Taml", "தமிழ்"),
        (b"Telu", "తెలుగు"),
        (b"Knda", "ಕನ್ನಡ"),
        (b"Mlym", "മലയാളം"),
        (b"Gujr", "ગુજરાતી"),
        (b"Guru", "ਗੁਰਮੁਖੀ"),
        (b"Khmr", "ភាសាខ្មែរ"),
        (b"Laoo", "ພາສາລາວ"),
        (b"Mymr", "မြန်မာ"),
        (b"Sinh", "සිංහල"),
        (b"Ethi", "አማርኛ"),
        (b"Armn", "Հայերեն"),
        (b"Geor", "ქართული"),
    ];

    pub(super) fn install(fonts: &mut FontContext) {
        // SAFETY: plain CoreText queries on values owned for the call.
        let Some(base) =
            (unsafe { CTFont::new_ui_font_for_language(CTFontUIFontType::System, 0.0, None) })
        else {
            return;
        };
        for (script, sample) in SAMPLES {
            let text = CFString::from_str(sample);
            let range = CFRange {
                location: 0,
                length: text.length(),
            };
            // SAFETY: as above; the range is the whole string.
            let font = unsafe { base.for_string(&text, range) };
            // SAFETY: as above.
            let family = unsafe { font.family_name() }.to_string();
            let Some(ui) = fonts.collection.family_id(&family) else {
                continue;
            };
            let key = FallbackKey::new(Script::from_bytes(**script), None);
            let rest: Vec<_> = fonts
                .collection
                .fallback_families(key)
                .filter(|id| *id != ui)
                .collect();
            fonts
                .collection
                .set_fallbacks(key, std::iter::once(ui).chain(rest));
        }
    }
}

fn with_engine<R>(work: impl FnOnce(&mut Engine) -> R) -> R {
    let mut guard = engine()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    work(&mut guard)
}

/// `ctx.measureText(text).width`.
pub(crate) fn measure(text: &str, font: Font) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    with_engine(|engine| engine.shape(text, font).width)
}

/// `ctx.fillText(text, x, y, maxWidth)` in `color`, moved by (`dx`, `dy`) (a
/// shadow pass).
pub(crate) fn fill_text(
    target: &mut Pixmap,
    text: &str,
    font: Font,
    place: TextPlacement,
    color: Rgba,
    dx: f32,
    dy: f32,
) {
    draw_text(target, text, font, place, color, None, dx, dy);
}

/// `ctx.strokeText(text, x, y, maxWidth)` with round joins, `width` wide.
#[allow(clippy::too_many_arguments)]
pub(crate) fn stroke_text(
    target: &mut Pixmap,
    text: &str,
    font: Font,
    place: TextPlacement,
    color: Rgba,
    width: f32,
    dx: f32,
    dy: f32,
) {
    draw_text(target, text, font, place, color, Some(width), dx, dy);
}

#[allow(clippy::too_many_arguments)]
fn draw_text(
    target: &mut Pixmap,
    text: &str,
    font: Font,
    place: TextPlacement,
    color: Rgba,
    stroke_width: Option<f32>,
    dx: f32,
    dy: f32,
) {
    if text.is_empty() || color.a <= 0.0 {
        return;
    }
    with_engine(|engine| {
        let line = engine.shape(text, font);
        if line.width <= 0.0 {
            return;
        }
        let squeeze = place
            .max_width
            .filter(|max| *max > 0.0 && *max < line.width)
            .map(|max| max / line.width);
        let width = squeeze.map_or(line.width, |scale| line.width * scale);
        let left = match place.align {
            Align::Left => place.x,
            Align::Center => place.x - width / 2.0,
        } + dx;
        let ascent = em_ascent_px(engine.em_box(font), font.px);
        let baseline = place.y
            + dy
            + match place.baseline {
                // (ascent - descent) / 2 with ascent + descent = 1 em.
                Baseline::Middle => ascent - font.px / 2.0,
                Baseline::Top => ascent,
                Baseline::Alphabetic => 0.0,
            };
        let scale_x = squeeze.unwrap_or(1.0);
        for run in &line.runs {
            engine.draw_run(target, run, left, baseline, scale_x, color, stroke_width);
        }
    });
}

impl Engine {
    /// Shapes a line word by word, as Blink's `CachingWordShaper` does: each
    /// run of non-spaces and each space on its own, laid end to end. Kerning
    /// never crosses a space (San Francisco kerns a comma against the space
    /// after it in `kerx`, which Chromium's word cache never sees).
    fn shape(&mut self, text: &str, font: Font) -> ShapedLine {
        let mut runs = Vec::new();
        let mut pen = 0.0;
        for segment in words(text) {
            pen += self.shape_segment(segment, font, pen, &mut runs);
        }
        ShapedLine { runs, width: pen }
    }

    /// Shapes one word (or one space) at `pen`, appending its runs; returns
    /// its advance.
    fn shape_segment(
        &mut self,
        text: &str,
        font: Font,
        pen: f32,
        runs: &mut Vec<ShapedRun>,
    ) -> f32 {
        let mut builder = self
            .layouts
            .ranged_builder(&mut self.fonts, text, 1.0, false);
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            FONT_STACK.into(),
        )));
        builder.push_default(StyleProperty::FontSize(font.px));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(f32::from(
            font.weight,
        ))));
        if let Some(variations) = optical_size(font.px) {
            builder.push_default(StyleProperty::FontVariations(FontVariations::Source(
                variations.into(),
            )));
        }
        let mut layout: Layout<()> = builder.build(text);
        layout.break_all_lines(None);
        // Colour bitmap glyphs advance by the size they are drawn at.
        let mut shift = 0.0;
        for line in layout.lines() {
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let run = glyph_run.run();
                let baseline = glyph_run.baseline();
                let font = run.font().clone();
                let size = run.font_size();
                let bitmap_px = if has_color_bitmaps(&font) {
                    emoji_px(size)
                } else {
                    size
                };
                let mut glyphs = Vec::new();
                for glyph in glyph_run.positioned_glyphs() {
                    glyphs.push((
                        glyph.id as GlyphId,
                        pen + shift + glyph.x,
                        glyph.y - baseline,
                    ));
                    if bitmap_px != size {
                        shift += glyph.advance * (bitmap_px / size) - glyph.advance;
                    }
                }
                runs.push(ShapedRun {
                    font,
                    size,
                    coords: run.normalized_coords().to_vec(),
                    embolden: run.synthesis().embolden(),
                    bitmap_px,
                    glyphs,
                });
            }
        }
        layout.full_width() + shift
    }

    /// The first font's ascent and descent per em (OS/2 `sTypoAscender` and
    /// `sTypoDescender`, the font's own when it has no usable OS/2 table).
    fn em_box(&mut self, font: Font) -> (f32, f32) {
        if let Some((_, value)) = self.em_box.iter().find(|(w, _)| *w == font.weight) {
            return *value;
        }
        // The stack's first font is whatever shapes a Latin letter.
        let probe = self.shape("x", Font::new(64.0, font.weight));
        let value = probe
            .runs
            .first()
            .and_then(|run| {
                let font_ref = FontRef::from_index(run.font.data.data(), run.font.index as usize)?;
                typo_metrics(&font_ref).or_else(|| {
                    let metrics = font_ref.metrics(&run.coords);
                    let units = f32::from(metrics.units_per_em.max(1));
                    Some((metrics.ascent / units, metrics.descent / units))
                })
            })
            .unwrap_or((0.8, 0.2));
        self.em_box.push((font.weight, value));
        value
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_run(
        &mut self,
        target: &mut Pixmap,
        run: &ShapedRun,
        left: f32,
        baseline: f32,
        scale_x: f32,
        color: Rgba,
        stroke_width: Option<f32>,
    ) {
        let Some(font_ref) = FontRef::from_index(run.font.data.data(), run.font.index as usize)
        else {
            return;
        };
        let mut scaler = self
            .scaler
            .builder(font_ref)
            .size(run.size)
            .hint(false)
            .normalized_coords(run.coords.iter())
            .build();
        let color_bitmaps = scaler.has_color_bitmaps();
        let color_outlines = scaler.has_color_outlines();
        // Skia's fake bold for a face without the asked weight, plus the
        // platform's own stem darkening.
        let fake_bold = if run.embolden {
            fake_bold_outset(run.size)
        } else {
            0.0
        };
        let (dilate_x, dilate_y) = smoothing_dilation();
        let baseline_px = baseline.round();
        for &(glyph, x, y) in &run.glyphs {
            let glyph_x = left + x * scale_x;
            let glyph_y = baseline_px + y;
            if color_bitmaps
                && draw_color_bitmap(
                    target,
                    &font_ref,
                    glyph,
                    run.bitmap_px,
                    run.size,
                    glyph_x,
                    glyph_y,
                    scale_x,
                    color.a,
                )
            {
                continue;
            }
            // Quarter-pixel x, as Skia's glyph cache positions it.
            let snapped_x = (glyph_x * 4.0).round() / 4.0;
            let whole_x = snapped_x.floor();
            let whole_y = glyph_y.round();
            let offset = Vector::new(snapped_x - whole_x, 0.0);
            let transform = (scale_x != 1.0).then(|| zeno::Transform::scale(scale_x, 1.0));
            if color_outlines && stroke_width.is_none() {
                let image = Render::new(&[Source::ColorOutline(0)])
                    .offset(offset)
                    .transform(transform)
                    .render(&mut scaler, glyph);
                if let Some(image) = image
                    && image.content == Content::Color
                {
                    blit_color(target, &image, whole_x, whole_y, color.a);
                    continue;
                }
            }
            let Some(mut outline) = scaler.scale_outline(glyph) else {
                continue;
            };
            if let Some(transform) = &transform {
                outline.transform(transform);
            }
            // A stroke is Skia's path stroke of the exact outline; only the
            // filled glyph mask carries CoreText's smoothing.
            let (dilate_x, dilate_y) = if stroke_width.is_some() {
                (0.0, 0.0)
            } else {
                (dilate_x, dilate_y)
            };
            let dilate = (fake_bold + dilate_x * 2.0, fake_bold + dilate_y * 2.0);
            if dilate.0 > 0.0 || dilate.1 > 0.0 {
                outline.embolden(dilate.0, dilate.1);
            }
            let mut image = Image::new();
            let mut stroke = zeno::Stroke::new(stroke_width.unwrap_or(0.0));
            stroke.join(zeno::Join::Round);
            let mut mask = zeno::Mask::new(outline.path());
            if stroke_width.is_some() {
                mask.style(stroke);
            } else {
                mask.style(zeno::Fill::NonZero);
            }
            image.placement = mask
                .format(Format::Alpha)
                .origin(zeno::Origin::BottomLeft)
                .offset(offset)
                .render_offset(offset)
                .inspect(|format, w, h| image.data.resize(format.buffer_size(w, h), 0))
                .render_into(&mut image.data[..], None);
            image.content = Content::Mask;
            blit_mask(target, &image, whole_x, whole_y, color);
        }
    }
}

/// How far each glyph edge moves out (x, y), in pixels: CoreText's font
/// smoothing dilates the outlines it rasterises, and Chromium's canvas text on
/// macOS is CoreText's masks; zeno draws the exact outline. Fitted to
/// Chromium 142's white text at 18 to 38 px (`coverage_curve` is the other
/// half of the fit).
#[cfg(target_os = "macos")]
fn smoothing_dilation() -> (f32, f32) {
    (0.025, 0.075)
}

#[cfg(not(target_os = "macos"))]
fn smoothing_dilation() -> (f32, f32) {
    (0.0, 0.0)
}

/// Skia's mask gamma on macOS: light text's coverage is lifted (an edge pixel
/// a third covered draws two thirds), dark text's is left as it is. The
/// exponent follows the text colour's luminance from 1 (black) to 0.4
/// (white), fitted with the dilation above; dark text on the Buddy bubble
/// moved by under 2 % across 0.6 to 2.4.
#[cfg(target_os = "macos")]
fn coverage_curve(coverage: f32, color: Rgba) -> f32 {
    let luminance =
        (0.2126 * f32::from(color.r) + 0.7152 * f32::from(color.g) + 0.0722 * f32::from(color.b))
            / 255.0;
    coverage.powf(1.0 - 0.6 * luminance)
}

#[cfg(not(target_os = "macos"))]
fn coverage_curve(coverage: f32, _color: Rgba) -> f32 {
    coverage
}

/// The system font's optical size follows the point size on macOS (AppKit
/// sets San Francisco's `opsz` axis from the size); other fonts have no such
/// axis or ignore it.
#[cfg(target_os = "macos")]
fn optical_size(px: f32) -> Option<String> {
    Some(format!("'opsz' {px}"))
}

#[cfg(not(target_os = "macos"))]
fn optical_size(_px: f32) -> Option<String> {
    None
}

/// Whether a font draws colour bitmaps (sbix, CBDT): the emoji fonts.
fn has_color_bitmaps(font: &parley::FontData) -> bool {
    FontRef::from_index(font.data.data(), font.index as usize).is_some_and(|font| {
        font.table(u32::from_be_bytes(*b"sbix")).is_some()
            || font.table(u32::from_be_bytes(*b"CBDT")).is_some()
    })
}

/// The size CoreText draws Apple Color Emoji at, and advances it by: under
/// 24 px it is enlarged, by a quarter of the size up to 16 px, the extra
/// tapering to nothing at 24 px (read off Chromium 142 on macOS 26:
/// `measureText('👋')` is 10 at 8 px, 18 at 14, 21 at 18, 22 at 20, 24 at
/// 24, then the size). Other platforms draw emoji at the text size.
#[cfg(target_os = "macos")]
fn emoji_px(px: f32) -> f32 {
    let taper = ((24.0 - px) / 8.0).clamp(0.0, 1.0);
    px + (px.min(16.0) / 4.0 * taper + 0.5).floor()
}

#[cfg(not(target_os = "macos"))]
fn emoji_px(px: f32) -> f32 {
    px
}

/// The words and spaces of a line in order: a run of non-spaces, or one
/// U+0020.
fn words(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = if rest.starts_with(' ') {
            1
        } else {
            rest.find(' ').unwrap_or(rest.len())
        };
        let (word, tail) = rest.split_at(end);
        rest = tail;
        Some(word)
    })
}

/// The em box's ascent in pixels as Chromium sets `top` and `middle`
/// (`SimpleFontData::NormalizedTypoAscentAndDescent`): the ascent scaled so
/// ascent and descent make one em, on `LayoutUnit`'s 1/64 grid. (At 14 px San
/// Francisco's 11.49 becomes 11.5, so `middle` is 4.5 above the baseline and
/// a line at y 27 sits on 31.5, which the glyphs round to 32.)
fn em_ascent_px((ascent, descent): (f32, f32), px: f32) -> f32 {
    let share = if ascent + descent > 0.0 && ascent >= 0.0 {
        ascent / (ascent + descent)
    } else {
        0.8
    };
    (share * px * 64.0).round() / 64.0
}

/// OS/2 `sTypoAscender` and `-sTypoDescender` per em.
fn typo_metrics(font: &FontRef<'_>) -> Option<(f32, f32)> {
    let os2 = font.table(u32::from_be_bytes(*b"OS/2"))?;
    let read = |at: usize| -> Option<f32> {
        let bytes = os2.get(at..at + 2)?;
        Some(f32::from(i16::from_be_bytes([bytes[0], bytes[1]])))
    };
    let units = f32::from(font.metrics(&[]).units_per_em.max(1));
    let ascent = read(68)? / units;
    let descent = -read(70)? / units;
    (ascent + descent > 0.0 && ascent >= 0.0).then_some((ascent, descent))
}

/// Skia's fake bold (`SkScalerContext`'s interpolation between 1/24 of the
/// size at 9 px and 1/32 at 36 px), as a total outset.
fn fake_bold_outset(size: f32) -> f32 {
    let t = ((size - 9.0) / 27.0).clamp(0.0, 1.0);
    size * (1.0 / 24.0 + (1.0 / 32.0 - 1.0 / 24.0) * t)
}

/// Source-over of a coverage mask in `color` with its top-left at the glyph's
/// placement from the pen at (`pen_x`, `pen_y`) (whole pixels).
fn blit_mask(target: &mut Pixmap, image: &Image, pen_x: f32, pen_y: f32, color: Rgba) {
    let placement = image.placement;
    let left = pen_x as i32 + placement.left;
    let top = pen_y as i32 - placement.top;
    let (width, height) = (target.width() as i32, target.height() as i32);
    let (r, g, b) = (
        f32::from(color.r) / 255.0,
        f32::from(color.g) / 255.0,
        f32::from(color.b) / 255.0,
    );
    let stride = placement.width as usize;
    let data = target.data_mut();
    for row in 0..placement.height as i32 {
        let y = top + row;
        if y < 0 || y >= height {
            continue;
        }
        for column in 0..placement.width as i32 {
            let x = left + column;
            if x < 0 || x >= width {
                continue;
            }
            let coverage = image.data[row as usize * stride + column as usize];
            if coverage == 0 {
                continue;
            }
            let alpha = color.a * coverage_curve(f32::from(coverage) / 255.0, color);
            let at = (y * width + x) as usize * 4;
            blend_premultiplied(
                &mut data[at..at + 4],
                [r * alpha, g * alpha, b * alpha, alpha],
            );
        }
    }
}

/// Source-over of a straight-alpha RGBA glyph image (a COLR glyph) at the
/// glyph's placement, its alpha scaled by `opacity`.
fn blit_color(target: &mut Pixmap, image: &Image, pen_x: f32, pen_y: f32, opacity: f32) {
    let placement = image.placement;
    let left = pen_x as i32 + placement.left;
    let top = pen_y as i32 - placement.top;
    let (width, height) = (target.width() as i32, target.height() as i32);
    let stride = placement.width as usize * 4;
    let data = target.data_mut();
    for row in 0..placement.height as i32 {
        let y = top + row;
        if y < 0 || y >= height {
            continue;
        }
        for column in 0..placement.width as i32 {
            let x = left + column;
            if x < 0 || x >= width {
                continue;
            }
            let at_source = row as usize * stride + column as usize * 4;
            let pixel = &image.data[at_source..at_source + 4];
            let alpha = f32::from(pixel[3]) / 255.0 * opacity;
            if alpha <= 0.0 {
                continue;
            }
            let at = (y * width + x) as usize * 4;
            blend_premultiplied(
                &mut data[at..at + 4],
                [
                    f32::from(pixel[0]) / 255.0 * alpha,
                    f32::from(pixel[1]) / 255.0 * alpha,
                    f32::from(pixel[2]) / 255.0 * alpha,
                    alpha,
                ],
            );
        }
    }
}

/// A colour bitmap glyph (Apple Color Emoji's sbix, Noto's CBDT): the nearest
/// strike at or above the size (the largest when none is), scaled with a
/// bicubic filter to the run's size at the glyph's exact position, its alpha
/// scaled by `opacity` (Skia applies the paint's alpha to colour glyphs).
/// False when the font has no bitmap for the glyph.
#[allow(clippy::too_many_arguments)]
fn draw_color_bitmap(
    target: &mut Pixmap,
    font: &FontRef<'_>,
    glyph: GlyphId,
    size: f32,
    strike_px: f32,
    pen_x: f32,
    pen_y: f32,
    scale_x: f32,
    opacity: f32,
) -> bool {
    let ppems: Vec<u16> = font
        .color_strikes()
        .filter(|strike| strike.contains(glyph))
        .map(|strike| strike.ppem())
        .collect();
    let Some(ppem) = ppems
        .iter()
        .copied()
        .filter(|ppem| f32::from(*ppem) >= strike_px)
        .min()
        .or_else(|| ppems.iter().copied().max())
    else {
        return false;
    };
    let mut context = ScaleContext::new();
    let mut scaler = context.builder(*font).size(f32::from(ppem)).build();
    let Some(image) = scaler.scale_color_bitmap(glyph, StrikeWith::ExactSize) else {
        return false;
    };
    let placement = image.placement;
    if placement.width == 0 || placement.height == 0 || image.content != Content::Color {
        return false;
    }
    let Some(mut pixmap) = Pixmap::new(placement.width, placement.height) else {
        return false;
    };
    for (pixel, source) in pixmap
        .data_mut()
        .chunks_exact_mut(4)
        .zip(image.data.chunks_exact(4))
    {
        let alpha = u16::from(source[3]);
        for (out, value) in pixel.iter_mut().zip(&source[..3]) {
            *out = ((u16::from(*value) * alpha + 127) / 255) as u8;
        }
        pixel[3] = source[3];
    }
    let scale = size / f32::from(ppem);
    let transform = Transform::from_row(
        scale * scale_x,
        0.0,
        0.0,
        scale,
        pen_x + placement.left as f32 * scale * scale_x,
        pen_y - placement.top as f32 * scale,
    );
    target.draw_pixmap(
        0,
        0,
        pixmap.as_ref(),
        &PixmapPaint {
            opacity: f32::from(unit_to_u8(opacity)) / 255.0,
            quality: FilterQuality::Bicubic,
            ..PixmapPaint::default()
        },
        transform,
        None,
    );
    true
}

/// The fonts a line uses, by family name (tests and diagnostics).
#[cfg(test)]
pub(crate) fn fonts_for(text: &str, font: Font) -> Vec<String> {
    with_engine(|engine| {
        let line = engine.shape(text, font);
        line.runs
            .iter()
            .filter_map(|run| {
                let font_ref = FontRef::from_index(run.font.data.data(), run.font.index as usize)?;
                font_ref
                    .localized_strings()
                    .find_by_id(swash::StringId::Family, None)
                    .map(|name| name.to_string())
            })
            .collect()
    })
}
