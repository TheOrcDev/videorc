//! The caption bar, `renderCaptionOverlayPng` in `caption-overlay.ts`: the
//! metrics off the canvas's long edge, the greedy wrap into two lines keeping
//! the tail, the four styles' plates and text. Plan 220 S1.2e added the
//! captioned copy's cue frame (`renderCaptionCueFramePng`): the same bar at
//! its place on a transparent canvas-sized frame, which the Captions page's
//! preview shows too.

use serde::Deserialize;
use tiny_skia::Pixmap;

use super::canvas::{self, Fill, Rgba, Shadow, StrokeStyle};
use super::text::{self, Align, Baseline, Font, TextPlacement};
use super::{GLASS_FILL, GLASS_HAIRLINE, GLASS_SHEEN, js_round, measure};

/// The wire's style, size and position, the renderer's names for them.
pub(crate) use crate::captions::{CaptionOverlayPosition, CaptionStyleId, CaptionTextSize};

/// What the caption bar is drawn from (`renderCaptionOverlayPng`'s params).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptionBarState {
    pub text: String,
    pub canvas_width: u32,
    /// Absent: landscape. A portrait canvas gets the phone-sized bar.
    #[serde(default)]
    pub canvas_height: Option<u32>,
    pub text_size: CaptionTextSize,
    #[serde(default = "glass")]
    pub style_id: CaptionStyleId,
    /// The placed rect's width in pixels (plan 164).
    #[serde(default)]
    pub max_bar_width_px: Option<f64>,
}

fn glass() -> CaptionStyleId {
    CaptionStyleId::Glass
}

/// What one frame of the captioned copy is drawn from
/// (`renderCaptionCueFramePng`'s params): the cue's text at its place on the
/// whole output canvas. Empty text is the blank gap frame.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptionFrameState {
    pub text: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub position: CaptionOverlayPosition,
    pub text_size: CaptionTextSize,
    #[serde(default = "glass")]
    pub style_id: CaptionStyleId,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Plate {
    None,
    Glass,
    Band,
    Solid,
}

struct StyleDefinition {
    plate: Plate,
    align: Align,
    weight: u16,
    max_width_fraction: f64,
    wide: bool,
    line_height_factor: f64,
    padding_x_factor: f64,
    padding_y_factor: f64,
    radius_factor: f64,
    background: Rgba,
    text: Rgba,
    stroke: Option<(Rgba, f32)>,
}

/// `CAPTION_STYLE_DEFINITIONS`.
fn definition(style: CaptionStyleId) -> StyleDefinition {
    match style {
        CaptionStyleId::Classic => StyleDefinition {
            plate: Plate::None,
            align: Align::Center,
            weight: 600,
            max_width_fraction: 0.88,
            wide: false,
            line_height_factor: 1.28,
            padding_x_factor: 0.3,
            padding_y_factor: 0.24,
            radius_factor: 0.0,
            background: Rgba::new(0, 0, 0, 0.0),
            text: Rgba::hex(0xFFFFFF),
            stroke: Some((Rgba::new(0, 0, 0, 0.96), 0.105)),
        },
        CaptionStyleId::Glass => StyleDefinition {
            plate: Plate::Glass,
            align: Align::Center,
            weight: 600,
            max_width_fraction: 0.92,
            wide: false,
            line_height_factor: 1.32,
            padding_x_factor: 0.72,
            padding_y_factor: 0.4,
            radius_factor: 0.26,
            background: GLASS_FILL,
            text: Rgba::hex(0xF5F5F7),
            stroke: None,
        },
        CaptionStyleId::LowerThird => StyleDefinition {
            plate: Plate::Band,
            align: Align::Left,
            weight: 600,
            max_width_fraction: 0.92,
            wide: true,
            line_height_factor: 1.3,
            padding_x_factor: 0.7,
            padding_y_factor: 0.34,
            radius_factor: 0.12,
            background: Rgba::new(13, 13, 15, 0.9),
            text: Rgba::hex(0xF5F5F7),
            stroke: None,
        },
        CaptionStyleId::HighContrast => StyleDefinition {
            plate: Plate::Solid,
            align: Align::Center,
            weight: 700,
            max_width_fraction: 0.88,
            wide: false,
            line_height_factor: 1.4,
            padding_x_factor: 0.62,
            padding_y_factor: 0.42,
            radius_factor: 0.08,
            background: Rgba::hex(0x050506),
            text: Rgba::hex(0xFFFFFF),
            stroke: None,
        },
    }
}

const MAX_LINES: usize = 2;
const PORTRAIT_MAX_BAR_WIDTH_FRACTION: f64 = 0.76;

struct Metrics {
    font_px: f64,
    line_height_px: f64,
    padding_x_px: f64,
    padding_y_px: f64,
    radius_px: f64,
    max_text_width_px: f64,
}

struct Layout {
    style: StyleDefinition,
    metrics: Metrics,
    lines: Vec<String>,
    bar_width_px: f64,
    bar_height_px: f64,
}

fn portrait(state: &CaptionBarState) -> bool {
    state
        .canvas_height
        .is_some_and(|height| height > state.canvas_width)
}

/// `captionBarMaxWidthPx`.
fn max_bar_width(state: &CaptionBarState, style: &StyleDefinition) -> f64 {
    let canvas_width = f64::from(state.canvas_width);
    let fraction = if portrait(state) {
        style
            .max_width_fraction
            .min(PORTRAIT_MAX_BAR_WIDTH_FRACTION)
    } else {
        style.max_width_fraction
    };
    match state
        .max_bar_width_px
        .filter(|width| width.is_finite() && *width > 0.0)
    {
        Some(width) => width.min(canvas_width).floor().max(1.0),
        None => (canvas_width * fraction).floor(),
    }
}

/// `captionBarMetrics`.
fn metrics(state: &CaptionBarState, style: &StyleDefinition) -> Metrics {
    let scale_edge = f64::from(if portrait(state) {
        state.canvas_height.unwrap_or(state.canvas_width)
    } else {
        state.canvas_width
    });
    let size_factor = match state.text_size {
        CaptionTextSize::S => 0.8,
        CaptionTextSize::M => 1.0,
        CaptionTextSize::L => 1.25,
    };
    let font_px = js_round(scale_edge / 40.0 * size_factor).max(24.0);
    let padding_x_px = js_round(font_px * style.padding_x_factor);
    Metrics {
        font_px,
        line_height_px: js_round(font_px * style.line_height_factor),
        padding_x_px,
        padding_y_px: js_round(font_px * style.padding_y_factor),
        radius_px: js_round(font_px * style.radius_factor),
        max_text_width_px: max_bar_width(state, style) - padding_x_px * 2.0,
    }
}

/// `wrapCaptionText`: greedy, at most two lines, the tail kept behind a
/// leading ellipsis.
fn wrap(text: &str, metrics: &Metrics, font: Font) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };
        if !current.is_empty() && measure(&candidate, font) > metrics.max_text_width_px {
            lines.push(std::mem::replace(&mut current, word.to_string()));
        } else {
            current = candidate;
        }
    }
    if current.is_empty() {
        return lines;
    }
    lines.push(current);
    if lines.len() <= MAX_LINES {
        return lines;
    }
    let mut kept = lines.split_off(lines.len() - MAX_LINES);
    kept[0] = format!("…{}", kept[0]);
    kept
}

/// `layoutCaptionBar`.
fn layout(state: &CaptionBarState) -> Option<Layout> {
    let style = definition(state.style_id);
    let metrics = metrics(state, &style);
    let font = Font::new(metrics.font_px as f32, style.weight);
    let lines = wrap(&state.text, &metrics, font);
    if lines.is_empty() {
        return None;
    }
    let widest = lines
        .iter()
        .map(|line| measure(line, font))
        .fold(0.0f64, f64::max);
    let max_bar_width = max_bar_width(state, &style);
    let bar_width_px = if style.wide {
        max_bar_width
    } else {
        (widest.ceil() + metrics.padding_x_px * 2.0).min(max_bar_width)
    };
    let bar_height_px = metrics.padding_y_px * 2.0 + metrics.line_height_px * lines.len() as f64;
    Some(Layout {
        style,
        metrics,
        lines,
        bar_width_px,
        bar_height_px,
    })
}

/// `captionShadowPadPx`.
fn shadow_pad(font_px: f64) -> f64 {
    (font_px * 0.65).ceil()
}

/// The bar as the renderer pushes it: the bar inside a transparent margin for
/// its shadow. None for empty text.
pub(crate) fn render(state: &CaptionBarState) -> Option<Pixmap> {
    let layout = layout(state)?;
    let pad = shadow_pad(layout.metrics.font_px);
    let mut pixmap = Pixmap::new(
        (layout.bar_width_px + pad * 2.0) as u32,
        (layout.bar_height_px + pad * 2.0) as u32,
    )?;
    paint(&mut pixmap, &layout, pad, pad);
    Some(pixmap)
}

/// `CAPTION_FRAME_MARGIN_FRACTION`, and the portrait platforms' safe area
/// (`PORTRAIT_FRAME_*_MARGIN_FRACTION`, the compositor's
/// `PORTRAIT_OVERLAY_*_MARGIN`).
const FRAME_MARGIN_FRACTION: f64 = 0.04;
const PORTRAIT_FRAME_TOP_MARGIN_FRACTION: f64 = 0.08;
const PORTRAIT_FRAME_BOTTOM_MARGIN_FRACTION: f64 = 0.22;

/// `captionBarFramePosition`: centred, inset from the top or the bottom edge
/// by the margin plus the shadow room the live bar's bitmap carries, so the
/// burned copy and the live bar sit at the same height.
fn frame_origin(state: &CaptionFrameState, layout: &Layout) -> (f64, f64) {
    let canvas_width = f64::from(state.canvas_width);
    let canvas_height = f64::from(state.canvas_height);
    let top = state.position == CaptionOverlayPosition::Top;
    let fraction = if state.canvas_height <= state.canvas_width {
        FRAME_MARGIN_FRACTION
    } else if top {
        PORTRAIT_FRAME_TOP_MARGIN_FRACTION
    } else {
        PORTRAIT_FRAME_BOTTOM_MARGIN_FRACTION
    };
    let margin = js_round(canvas_height * fraction) + shadow_pad(layout.metrics.font_px);
    let x = js_round((canvas_width - layout.bar_width_px) / 2.0);
    let y = if top {
        margin
    } else {
        (canvas_height - layout.bar_height_px - margin).max(0.0)
    };
    (x, y)
}

/// The cue frame as the renderer submitted it: the whole canvas (at least
/// 2x2), transparent, with the bar painted at its place. Empty text draws
/// the blank gap frame.
pub(crate) fn render_frame(state: &CaptionFrameState) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(state.canvas_width.max(2), state.canvas_height.max(2))?;
    if state.text.trim().is_empty() {
        return Some(pixmap);
    }
    let bar = CaptionBarState {
        text: state.text.clone(),
        canvas_width: state.canvas_width,
        canvas_height: Some(state.canvas_height),
        text_size: state.text_size,
        style_id: state.style_id,
        max_bar_width_px: None,
    };
    if let Some(layout) = layout(&bar) {
        let (x, y) = frame_origin(state, &layout);
        paint(&mut pixmap, &layout, x, y);
    }
    Some(pixmap)
}

/// `paintCaptionBar`.
fn paint(target: &mut Pixmap, layout: &Layout, x: f64, y: f64) {
    let Layout { style, metrics, .. } = layout;
    let (x, y) = (x as f32, y as f32);
    let (w, h) = (layout.bar_width_px as f32, layout.bar_height_px as f32);
    let font_px = metrics.font_px as f32;
    let radius = metrics.radius_px as f32;
    if style.plate != Plate::None
        && let Some(plate) = canvas::round_rect(x, y, w, h, radius)
    {
        let shadow = (style.plate == Plate::Glass).then(|| Shadow {
            color: Rgba::new(0, 0, 0, 0.4),
            blur: font_px * 0.45,
            offset_x: 0.0,
            offset_y: font_px * 0.1,
        });
        canvas::with_shadow(target, shadow, |layer, dx, dy| {
            canvas::fill_path(layer, &plate, &Fill::Color(style.background), dx, dy);
        });
        if style.plate == Plate::Glass {
            canvas::fill_path(
                target,
                &plate,
                &Fill::VerticalGradient {
                    y0: y,
                    y1: y + h,
                    stops: &GLASS_SHEEN,
                },
                0.0,
                0.0,
            );
            if let Some(hairline) = canvas::round_rect(x + 0.5, y + 0.5, w - 1.0, h - 1.0, radius) {
                canvas::stroke_path(
                    target,
                    &hairline,
                    StrokeStyle::new(GLASS_HAIRLINE, 1.0),
                    0.0,
                    0.0,
                );
            }
        }
    }

    // Crisp text with a whisper of shadow so it survives bright video.
    let shadow = Shadow {
        color: Rgba::new(0, 0, 0, 0.58),
        blur: font_px
            * if style.plate == Plate::None {
                0.12
            } else {
                0.08
            },
        offset_x: 0.0,
        offset_y: js_round(metrics.font_px * 0.03).max(1.0) as f32,
    };
    let font = Font::new(font_px, style.weight);
    let padding_x = metrics.padding_x_px as f32;
    let text_x = match style.align {
        Align::Left => x + padding_x,
        Align::Center => x + w / 2.0,
    };
    let max_width = Some(w - padding_x * 2.0);
    for (index, line) in layout.lines.iter().enumerate() {
        let place = TextPlacement {
            x: text_x,
            y: (f64::from(y) + metrics.padding_y_px + metrics.line_height_px * (index as f64 + 0.5))
                as f32,
            align: style.align,
            baseline: Baseline::Middle,
            max_width,
        };
        if let Some((stroke, factor)) = style.stroke {
            let width = (font_px * factor).max(2.0);
            canvas::with_shadow(target, Some(shadow), |layer, dx, dy| {
                text::stroke_text(layer, line, font, place, stroke, width, dx, dy);
            });
        }
        canvas::with_shadow(target, Some(shadow), |layer, dx, dy| {
            text::fill_text(layer, line, font, place, style.text, dx, dy);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(text: &str, width: u32, height: Option<u32>) -> CaptionBarState {
        CaptionBarState {
            text: text.to_string(),
            canvas_width: width,
            canvas_height: height,
            text_size: CaptionTextSize::M,
            style_id: CaptionStyleId::Glass,
            max_bar_width_px: None,
        }
    }

    #[test]
    fn the_type_scales_off_the_long_edge() {
        let style = definition(CaptionStyleId::Glass);
        assert_eq!(metrics(&state("x", 1920, Some(1080)), &style).font_px, 48.0);
        assert_eq!(metrics(&state("x", 1080, Some(1920)), &style).font_px, 48.0);
        // Never under 24 px.
        assert_eq!(metrics(&state("x", 640, Some(360)), &style).font_px, 24.0);
    }

    #[test]
    fn empty_text_draws_nothing() {
        assert!(render(&state("   ", 1280, Some(720))).is_none());
    }

    fn frame(
        text: &str,
        width: u32,
        height: u32,
        position: CaptionOverlayPosition,
    ) -> CaptionFrameState {
        CaptionFrameState {
            text: text.to_string(),
            canvas_width: width,
            canvas_height: height,
            position,
            text_size: CaptionTextSize::M,
            style_id: CaptionStyleId::Glass,
        }
    }

    #[test]
    fn a_blank_cue_frame_is_the_whole_canvas_and_transparent() {
        let blank =
            render_frame(&frame("", 1280, 720, CaptionOverlayPosition::Bottom)).expect("frame");
        assert_eq!((blank.width(), blank.height()), (1280, 720));
        assert!(blank.pixels().iter().all(|pixel| pixel.alpha() == 0));
        // A canvas under 2 px is drawn 2 px, as the renderer's was.
        let tiny = render_frame(&frame("", 0, 1, CaptionOverlayPosition::Bottom)).expect("frame");
        assert_eq!((tiny.width(), tiny.height()), (2, 2));
    }

    #[test]
    fn a_cue_frame_puts_the_bar_where_the_live_bar_sits() {
        // 32 px glass type on both canvases: a 68 px bar, 21 px of shadow
        // room. Landscape insets 4 % of the height; portrait 8 % from the
        // top and 22 % from the bottom (the platforms' own chrome).
        let cases = [
            (
                1280,
                720,
                CaptionOverlayPosition::Bottom,
                720.0 - 68.0 - (29.0 + 21.0),
            ),
            (1280, 720, CaptionOverlayPosition::Top, 29.0 + 21.0),
            (
                720,
                1280,
                CaptionOverlayPosition::Bottom,
                1280.0 - 68.0 - (282.0 + 21.0),
            ),
            (720, 1280, CaptionOverlayPosition::Top, 102.0 + 21.0),
        ];
        for (width, height, position, expected_y) in cases {
            let state = frame("Captions stay clear", width, height, position);
            let bar = CaptionBarState {
                text: state.text.clone(),
                canvas_width: width,
                canvas_height: Some(height),
                text_size: state.text_size,
                style_id: state.style_id,
                max_bar_width_px: None,
            };
            let layout = layout(&bar).expect("layout");
            assert_eq!(layout.metrics.font_px, 32.0);
            assert_eq!(layout.bar_height_px, 68.0);
            let (x, y) = frame_origin(&state, &layout);
            assert_eq!(y, expected_y, "{width}x{height} {position:?}");
            assert_eq!(x, js_round((f64::from(width) - layout.bar_width_px) / 2.0));
            let drawn = render_frame(&state).expect("frame");
            assert_eq!((drawn.width(), drawn.height()), (width, height));
            let centre = drawn
                .pixel(width / 2, (y + layout.bar_height_px / 2.0) as u32)
                .expect("pixel");
            assert!(
                centre.alpha() > 0,
                "{width}x{height} {position:?}: no bar at its place"
            );
            assert_eq!(drawn.pixel(width / 2, 0).expect("pixel").alpha(), 0);
        }
    }
}
