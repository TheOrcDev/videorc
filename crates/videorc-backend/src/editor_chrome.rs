//! Scene editor chrome geometry (plan 058, decision 2).
//!
//! While the Scene editor drags a source, the compositor draws the selection
//! frame, the eight resize handles and the snap guides itself, as a handful of
//! alpha-blended solid quads appended to the preview frame. This module is the
//! single geometry oracle for that chrome: pure, canvas-pixel output, no
//! rendering. Both the Metal path and the CPU path draw exactly these quads.
//!
//! Thickness follows `EditorChrome::scale` (preview output pixels per CSS pixel
//! of the on-screen slot) so a 1.5 px hairline is 1.5 px on screen at every
//! window size. Everything is clamped inside the canvas.

use crate::protocol::{EditorChrome, EditorGuideAxis, EditorHandleId};

/// Colour role of a chrome quad. Every render path maps these to the same
/// straight-alpha BGRA constants (`ChromeTone::bgra`) — monochrome per the
/// design language, never the brand red.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChromeTone {
    /// Black at 55 %: the underline that keeps light lines legible on white.
    Dark,
    /// `#F4F4F5` at 92 %: frame lines, guides and idle handles.
    Light,
    /// White at 100 %: the handle being dragged.
    Active,
}

impl ChromeTone {
    /// Straight-alpha BGRA pixel for the tone (source-over blended).
    pub const fn bgra(self) -> [u8; 4] {
        match self {
            ChromeTone::Dark => [0x00, 0x00, 0x00, 140],
            ChromeTone::Light => [0xF5, 0xF4, 0xF4, 235],
            ChromeTone::Active => [0xFF, 0xFF, 0xFF, 255],
        }
    }

    /// Straight (non-premultiplied) RGB + alpha for CPU blending.
    pub const fn rgba(self) -> (u8, u8, u8, u8) {
        let [b, g, r, a] = self.bgra();
        (r, g, b, a)
    }

    /// Stable per-tone index for GPU content keys.
    pub const fn index(self) -> u64 {
        match self {
            ChromeTone::Dark => 0,
            ChromeTone::Light => 1,
            ChromeTone::Active => 2,
        }
    }
}

/// Axis-aligned rectangle in output pixels, always inside the canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChromeRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// One solid quad of chrome. Quads are emitted in draw order: darks under the
/// lights they outline, handles over the frame, the active handle last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChromeQuad {
    pub rect: ChromeRect,
    pub tone: ChromeTone,
}

/// Bounds for `EditorChrome::scale`: a non-finite or absurd scale must not
/// produce a canvas-sized frame line or a zero-width one.
const MIN_SCALE: f64 = 0.25;
const MAX_SCALE: f64 = 8.0;
/// Frame/guide light line thickness in CSS pixels before scaling.
const FRAME_LINE_CSS_PX: f64 = 1.5;
/// Handle square side in CSS pixels before scaling.
const HANDLE_CSS_PX: f64 = 8.0;
/// Extra pixels the dark rim adds around a light line/handle (1 px each side).
const DARK_RIM_PX: i64 = 2;
/// Extra pixels the active handle grows by (1 px each side).
const ACTIVE_GROWTH_PX: i64 = 2;

/// Thicknesses derived from the chrome scale, in output pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChromeMetrics {
    light_line: i64,
    dark_line: i64,
    handle: i64,
    handle_rim: i64,
}

fn sanitize_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(MIN_SCALE, MAX_SCALE)
    } else {
        1.0
    }
}

fn chrome_metrics(scale: f64) -> ChromeMetrics {
    let scale = sanitize_scale(scale);
    let light_line = ((FRAME_LINE_CSS_PX * scale).round() as i64).clamp(1, 4);
    let handle = ((HANDLE_CSS_PX * scale).round() as i64).max(3);
    ChromeMetrics {
        light_line,
        dark_line: light_line + DARK_RIM_PX,
        handle,
        handle_rim: handle + DARK_RIM_PX,
    }
}

fn clean_fraction(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-1.0, 2.0)
    } else {
        0.0
    }
}

/// Intersect a signed rect with the canvas; `None` when nothing is left.
fn clamp_rect(x: i64, y: i64, width: i64, height: i64, canvas: (i64, i64)) -> Option<ChromeRect> {
    let left = x.max(0);
    let top = y.max(0);
    let right = x.saturating_add(width).min(canvas.0);
    let bottom = y.saturating_add(height).min(canvas.1);
    if right <= left || bottom <= top {
        return None;
    }
    Some(ChromeRect {
        x: left as u32,
        y: top as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// A line of `thickness` centred on the segment between two canvas points.
/// Horizontal when `y0 == y1`, vertical when `x0 == x1`.
fn centred_line(
    x0: i64,
    y0: i64,
    x1: i64,
    y1: i64,
    thickness: i64,
    canvas: (i64, i64),
) -> Option<ChromeRect> {
    let half = thickness / 2;
    if y0 == y1 {
        let left = x0.min(x1) - half;
        let right = x0.max(x1) + (thickness - half);
        clamp_rect(left, y0 - half, right - left, thickness, canvas)
    } else {
        let top = y0.min(y1) - half;
        let bottom = y0.max(y1) + (thickness - half);
        clamp_rect(x0 - half, top, thickness, bottom - top, canvas)
    }
}

/// A square of `side` centred on a canvas point.
fn centred_square(cx: i64, cy: i64, side: i64, canvas: (i64, i64)) -> Option<ChromeRect> {
    let half = side / 2;
    clamp_rect(cx - half, cy - half, side, side, canvas)
}

/// The eight handle anchor points of a selection rect, in stable order.
fn handle_points(x0: i64, y0: i64, x1: i64, y1: i64) -> [(EditorHandleId, i64, i64); 8] {
    let mid_x = (x0 + x1) / 2;
    let mid_y = (y0 + y1) / 2;
    [
        (EditorHandleId::Nw, x0, y0),
        (EditorHandleId::N, mid_x, y0),
        (EditorHandleId::Ne, x1, y0),
        (EditorHandleId::E, x1, mid_y),
        (EditorHandleId::Se, x1, y1),
        (EditorHandleId::S, mid_x, y1),
        (EditorHandleId::Sw, x0, y1),
        (EditorHandleId::W, x0, mid_y),
    ]
}

/// Chrome quads for one draft frame, in draw order, all inside the canvas.
///
/// - Guides first (dark underline, then light line), full canvas span.
/// - The selection frame: four edges, dark under light, centred on the edge.
/// - Handles when `chrome.handles`: a dark rim square under a light square at
///   each of the eight anchors; the active handle is drawn last, 2 px larger
///   and in the `Active` tone.
///
/// A frame without handles or guides yields only the eight frame quads; a
/// degenerate canvas yields nothing.
pub fn editor_chrome_quads(
    chrome: &EditorChrome,
    canvas_width: u32,
    canvas_height: u32,
) -> Vec<ChromeQuad> {
    if canvas_width == 0 || canvas_height == 0 {
        return Vec::new();
    }
    let canvas = (i64::from(canvas_width), i64::from(canvas_height));
    let metrics = chrome_metrics(chrome.scale);
    let width = f64::from(canvas_width);
    let height = f64::from(canvas_height);

    let selected = &chrome.selected;
    let sel_x = clean_fraction(selected.x);
    let sel_y = clean_fraction(selected.y);
    let sel_w = clean_fraction(selected.width).max(0.0);
    let sel_h = clean_fraction(selected.height).max(0.0);
    let x0 = (sel_x * width).round() as i64;
    let y0 = (sel_y * height).round() as i64;
    let x1 = ((sel_x + sel_w) * width).round() as i64;
    let y1 = ((sel_y + sel_h) * height).round() as i64;

    let mut quads = Vec::with_capacity(8 + chrome.guides.len() * 2 + 16);
    let mut push = |rect: Option<ChromeRect>, tone: ChromeTone| {
        if let Some(rect) = rect {
            quads.push(ChromeQuad { rect, tone });
        }
    };

    // Guides: full-span lines, dark under light.
    for guide in &chrome.guides {
        let position = clean_fraction(guide.position);
        let (start, end) = match guide.axis {
            EditorGuideAxis::X => {
                let px = (position * width).round() as i64;
                ((px, 0), (px, canvas.1))
            }
            EditorGuideAxis::Y => {
                let py = (position * height).round() as i64;
                ((0, py), (canvas.0, py))
            }
        };
        for (thickness, tone) in [
            (metrics.dark_line, ChromeTone::Dark),
            (metrics.light_line, ChromeTone::Light),
        ] {
            push(
                centred_line(start.0, start.1, end.0, end.1, thickness, canvas),
                tone,
            );
        }
    }

    // Selection frame: four edges, dark pass then light pass.
    let edges = [
        (x0, y0, x1, y0),
        (x0, y1, x1, y1),
        (x0, y0, x0, y1),
        (x1, y0, x1, y1),
    ];
    for (thickness, tone) in [
        (metrics.dark_line, ChromeTone::Dark),
        (metrics.light_line, ChromeTone::Light),
    ] {
        for (ex0, ey0, ex1, ey1) in edges {
            push(centred_line(ex0, ey0, ex1, ey1, thickness, canvas), tone);
        }
    }

    // Handles: rims first so every light square sits over every rim, the
    // active handle last so nothing overdraws it.
    if chrome.handles {
        let points = handle_points(x0, y0, x1, y1);
        let is_active = |id: EditorHandleId| chrome.active_handle == Some(id);
        for (id, cx, cy) in points {
            let growth = if is_active(id) { ACTIVE_GROWTH_PX } else { 0 };
            push(
                centred_square(cx, cy, metrics.handle_rim + growth, canvas),
                ChromeTone::Dark,
            );
        }
        for (id, cx, cy) in points {
            if !is_active(id) {
                push(
                    centred_square(cx, cy, metrics.handle, canvas),
                    ChromeTone::Light,
                );
            }
        }
        for (id, cx, cy) in points {
            if is_active(id) {
                push(
                    centred_square(cx, cy, metrics.handle + ACTIVE_GROWTH_PX, canvas),
                    ChromeTone::Active,
                );
            }
        }
    }

    quads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CameraTransform, EditorGuide};

    fn chrome(handles: bool, scale: f64) -> EditorChrome {
        EditorChrome {
            selected: CameraTransform {
                x: 0.25,
                y: 0.25,
                width: 0.5,
                height: 0.5,
            },
            handles,
            active_handle: None,
            guides: Vec::new(),
            scale,
        }
    }

    fn inside(rect: &ChromeRect, width: u32, height: u32) -> bool {
        rect.width > 0
            && rect.height > 0
            && rect.x + rect.width <= width
            && rect.y + rect.height <= height
    }

    #[test]
    fn frame_only_chrome_is_eight_edge_quads_dark_then_light() {
        let quads = editor_chrome_quads(&chrome(false, 1.0), 1280, 720);
        assert_eq!(quads.len(), 8);
        assert!(quads[..4].iter().all(|quad| quad.tone == ChromeTone::Dark));
        assert!(quads[4..].iter().all(|quad| quad.tone == ChromeTone::Light));
        // Light line at scale 1 = round(1.5) = 2 px; dark = 4 px, centred.
        let top_dark = quads[0].rect;
        let top_light = quads[4].rect;
        assert_eq!(top_light.height, 2);
        assert_eq!(top_dark.height, 4);
        assert_eq!(top_light.y, 179, "centred on y = 0.25 * 720 = 180");
        assert_eq!(top_dark.y, 178);
        assert_eq!(top_light.x, 319);
        assert_eq!(
            top_light.width, 642,
            "spans the edge plus half a line each side"
        );
    }

    #[test]
    fn every_quad_stays_inside_the_canvas_even_when_the_selection_overhangs() {
        let mut overhanging = chrome(true, 2.0);
        overhanging.selected = CameraTransform {
            x: -0.2,
            y: 0.8,
            width: 0.6,
            height: 0.6,
        };
        overhanging.active_handle = Some(EditorHandleId::Se);
        overhanging.guides = vec![
            EditorGuide {
                axis: EditorGuideAxis::X,
                position: 0.0,
            },
            EditorGuide {
                axis: EditorGuideAxis::Y,
                position: 1.0,
            },
        ];
        for (width, height) in [(1280, 720), (720, 1280), (16, 8), (1, 1)] {
            let quads = editor_chrome_quads(&overhanging, width, height);
            assert!(!quads.is_empty(), "{width}x{height} still draws something");
            for quad in &quads {
                assert!(
                    inside(&quad.rect, width, height),
                    "{quad:?} escapes {width}x{height}"
                );
            }
        }
        assert!(editor_chrome_quads(&overhanging, 0, 720).is_empty());
        assert!(editor_chrome_quads(&overhanging, 1280, 0).is_empty());
    }

    #[test]
    fn thickness_follows_scale_and_is_bounded() {
        let light = |scale: f64| {
            editor_chrome_quads(&chrome(false, scale), 1280, 720)[4]
                .rect
                .height
        };
        assert_eq!(light(0.5), 1, "0.75 rounds to 1");
        assert_eq!(light(1.0), 2);
        assert_eq!(light(2.0), 3);
        assert_eq!(light(4.0), 4, "capped at 4 px");
        assert_eq!(light(100.0), 4, "absurd scale is clamped");
        assert_eq!(light(f64::NAN), 2, "non-finite scale falls back to 1.0");
        assert_eq!(light(-3.0), 1, "negative scale clamps to the floor");
        for scale in [0.5, 1.0, 2.0, 4.0] {
            let quads = editor_chrome_quads(&chrome(false, scale), 1280, 720);
            assert_eq!(
                quads[0].rect.height,
                quads[4].rect.height + 2,
                "dark underline is 2 px wider than the light line at scale {scale}"
            );
        }
    }

    #[test]
    fn handles_are_eight_light_squares_over_dark_rims_and_the_active_one_is_distinct() {
        let mut with_handles = chrome(true, 1.0);
        let idle = editor_chrome_quads(&with_handles, 1280, 720);
        // 8 frame quads + 8 rims + 8 squares.
        assert_eq!(idle.len(), 24);
        let rims: Vec<_> = idle[8..16].iter().collect();
        let squares: Vec<_> = idle[16..].iter().collect();
        assert!(rims.iter().all(|quad| quad.tone == ChromeTone::Dark));
        assert!(squares.iter().all(|quad| quad.tone == ChromeTone::Light));
        assert!(
            squares
                .iter()
                .all(|quad| quad.rect.width == 8 && quad.rect.height == 8)
        );
        assert!(
            rims.iter()
                .all(|quad| quad.rect.width == 10 && quad.rect.height == 10)
        );
        // The NW handle is centred on the selection corner (320, 180).
        assert_eq!(squares[0].rect.x, 316);
        assert_eq!(squares[0].rect.y, 176);
        assert!(idle.iter().all(|quad| quad.tone != ChromeTone::Active));

        with_handles.active_handle = Some(EditorHandleId::Se);
        let active = editor_chrome_quads(&with_handles, 1280, 720);
        assert_eq!(active.len(), 24);
        let last = active.last().unwrap();
        assert_eq!(
            last.tone,
            ChromeTone::Active,
            "the active handle is drawn last"
        );
        assert_eq!(last.rect.width, 10, "2 px larger than an idle handle");
        assert_eq!(
            active
                .iter()
                .filter(|quad| quad.tone == ChromeTone::Light)
                .count(),
            4 + 7,
            "four light frame edges plus seven idle handles"
        );
        // Its rim grew with it and is centred on the SE corner (960, 540).
        let se_rim = active[8..16]
            .iter()
            .find(|quad| quad.rect.width == 12)
            .expect("the active rim is 2 px larger");
        assert_eq!((se_rim.rect.x, se_rim.rect.y), (954, 534));
        assert_eq!(handle_points(0, 0, 10, 10)[4].0, EditorHandleId::Se);
    }

    #[test]
    fn handle_size_scales_with_the_slot_and_never_collapses() {
        let square = |scale: f64| {
            let quads = editor_chrome_quads(&chrome(true, scale), 1280, 720);
            quads[16].rect.width
        };
        assert_eq!(square(1.0), 8);
        assert_eq!(square(2.0), 16);
        assert_eq!(square(0.25), 3, "floor of 3 px");
    }

    #[test]
    fn guides_span_the_whole_canvas_and_come_before_the_frame() {
        let mut guided = chrome(false, 1.0);
        guided.guides = vec![
            EditorGuide {
                axis: EditorGuideAxis::X,
                position: 0.5,
            },
            EditorGuide {
                axis: EditorGuideAxis::Y,
                position: 0.25,
            },
        ];
        let quads = editor_chrome_quads(&guided, 1280, 720);
        assert_eq!(quads.len(), 4 + 8);
        let vertical_dark = quads[0].rect;
        let vertical_light = quads[1].rect;
        assert_eq!(quads[0].tone, ChromeTone::Dark);
        assert_eq!(quads[1].tone, ChromeTone::Light);
        assert_eq!((vertical_light.y, vertical_light.height), (0, 720));
        assert_eq!(vertical_light.width, 2);
        assert_eq!(vertical_light.x, 639, "centred on x = 640");
        assert_eq!((vertical_dark.x, vertical_dark.width), (638, 4));
        let horizontal_light = quads[3].rect;
        assert_eq!((horizontal_light.x, horizontal_light.width), (0, 1280));
        assert_eq!(horizontal_light.y, 179);
        assert_eq!(horizontal_light.height, 2);
    }

    #[test]
    fn tones_map_to_the_design_language_constants() {
        assert_eq!(ChromeTone::Light.bgra(), [0xF5, 0xF4, 0xF4, 235]);
        assert_eq!(ChromeTone::Dark.bgra(), [0, 0, 0, 140]);
        assert_eq!(ChromeTone::Active.bgra(), [255, 255, 255, 255]);
        assert_eq!(ChromeTone::Light.rgba(), (0xF4, 0xF4, 0xF5, 235));
        assert_ne!(ChromeTone::Light.index(), ChromeTone::Dark.index());
        assert_ne!(ChromeTone::Light.index(), ChromeTone::Active.index());
    }
}
