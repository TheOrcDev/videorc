//! UI driver gap 3, window capture (plan 260 Phase 3, L6): the shared,
//! pure half of `capture-page`, `comments-window-capture-page` and
//! `preview-surface-sample` on the GPUI app. (`main-window-id`, the main
//! window's capture number and frame, is the shell's: C1's #2133.)
//!
//! The app captures a window (`apps/videorc/src/smoke/capture.rs`); this
//! names the commands, reads their parameters and judges the pixels the way
//! Electron's `preview-surface-sample.ts` does, so every Preview oracle reads
//! the same middle fifth of each rect.
//!
//! # The commands (Electron's shapes)
//!
//! - `capture-page {name?, window?}` → `{file}`: the window (`main` by
//!   default, or `preview`, `stream-manager`, `notes`) as a PNG at
//!   `<VIDEORC_SMOKE_OUTPUT_DIR>/videorc-ui-<name>.png`
//!   ([`super::security::capture_page_file_name`]). On GPUI it is the
//!   composited window (what `screencapture -l` sees), never a page render.
//! - `comments-window-capture-page {width?, height?, name?}` → `{file, width,
//!   height}`: the Stream Manager at that size (420 × 640 by default).
//! - `preview-surface-sample {rects}` → the preview's state, then
//!   `{capturedAt, width, height, samples: [{r, g, b}]}`, or `{error}` with
//!   `no-preview`, `preview-hidden`, `stage-not-on-screen` or
//!   `empty-capture`, as Electron answers. `rects` are canvas fractions.

use serde_json::{Map, Value};

/// The commands the capture handler takes, sorted.
pub const CAPTURE_COMMANDS: &[&str] = &[
    "capture-page",
    "comments-window-capture-page",
    "preview-surface-sample",
];

/// At most this many rects per read: the strip's 16 cells plus a few banners
/// (`PREVIEW_SURFACE_SAMPLE_MAX_RECTS`).
pub const MAX_RECTS: usize = 64;

/// `comments-window-capture-page`'s default size.
pub const COMMENTS_CAPTURE_SIZE: (f64, f64) = (420.0, 640.0);

/// A rectangle in canvas fractions (0..1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A rect's mean colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RgbMean {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

/// How a bitmap's four bytes per pixel are ordered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    Bgra,
    Rgba,
}

/// `parseNormalizedRects`: `rects`, validated, or a sentence naming the bad
/// entry.
pub fn parse_normalized_rects(params: &Map<String, Value>) -> Result<Vec<NormalizedRect>, String> {
    let Some(Value::Array(list)) = params.get("rects") else {
        return Err("Expected a non-empty rects array.".into());
    };
    if list.is_empty() {
        return Err("Expected a non-empty rects array.".into());
    }
    if list.len() > MAX_RECTS {
        return Err(format!("Expected at most {MAX_RECTS} rects."));
    }
    list.iter()
        .enumerate()
        .map(|(index, entry)| {
            let Value::Object(record) = entry else {
                return Err(format!("Rect {index} is not an object."));
            };
            if record.len() != 4
                || !["x", "y", "w", "h"]
                    .iter()
                    .all(|key| record.contains_key(*key))
            {
                return Err(format!("Rect {index} must have exactly x, y, w and h."));
            }
            let field = |key: &str| record[key].as_f64().filter(|value| value.is_finite());
            let (Some(x), Some(y), Some(w), Some(h)) =
                (field("x"), field("y"), field("w"), field("h"))
            else {
                return Err(format!("Rect {index} has a non-finite field."));
            };
            if w <= 0.0 || h <= 0.0 {
                return Err(format!("Rect {index} needs a positive width and height."));
            }
            Ok(NormalizedRect { x, y, w, h })
        })
        .collect()
}

/// The middle fifth of `[start, start + size)` in pixels, at least one
/// pixel, clamped.
fn axis(start: f64, size: f64, pixels: usize) -> (usize, usize) {
    let pixels_f = pixels as f64;
    let last = pixels.saturating_sub(1) as f64;
    let lo = ((start + size * 0.4) * pixels_f).floor().clamp(0.0, last) as usize;
    let hi = ((start + size * 0.6) * pixels_f)
        .ceil()
        .clamp((lo + 1) as f64, pixels_f) as usize;
    (lo, hi)
}

/// `meanRectsFromBitmap`: the mean colour of the middle fifth of each rect,
/// alpha ignored.
pub fn mean_rects(
    bitmap: &[u8],
    width: usize,
    height: usize,
    order: PixelOrder,
    rects: &[NormalizedRect],
) -> Result<Vec<RgbMean>, String> {
    if width == 0 || height == 0 {
        return Err(format!("Not a bitmap size: {width}x{height}"));
    }
    if bitmap.len() < width * height * 4 {
        return Err(format!(
            "A {width}x{height} bitmap needs {} bytes",
            width * height * 4
        ));
    }
    let (ri, bi) = match order {
        PixelOrder::Bgra => (2, 0),
        PixelOrder::Rgba => (0, 2),
    };
    Ok(rects
        .iter()
        .map(|rect| {
            let (x0, x1) = axis(rect.x, rect.w, width);
            let (y0, y1) = axis(rect.y, rect.h, height);
            let (mut r, mut g, mut b) = (0.0, 0.0, 0.0);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * width + x) * 4;
                    r += f64::from(bitmap[i + ri]);
                    g += f64::from(bitmap[i + 1]);
                    b += f64::from(bitmap[i + bi]);
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as f64;
            RgbMean {
                r: r / n,
                g: g / n,
                b: b / n,
            }
        })
        .collect())
}

/// A rect in window pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// `stageCaptureRect`: the preview's stage (in window points) clipped to the
/// window and rounded, or `None` when nothing of it is on screen.
pub fn stage_capture_rect(
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    viewport: (f64, f64),
) -> Option<PixelRect> {
    if ![left, top, width, height]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    let x0 = left.round().max(0.0);
    let y0 = top.round().max(0.0);
    let x1 = viewport.0.min((left + width).round());
    let y1 = viewport.1.min((top + height).round());
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    Some(PixelRect {
        x: x0 as u32,
        y: y0 as u32,
        width: (x1 - x0) as u32,
        height: (y1 - y0) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn every_capture_command_is_one_the_server_admits() {
        let mut sorted = CAPTURE_COMMANDS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, CAPTURE_COMMANDS);
        for name in CAPTURE_COMMANDS {
            assert!(super::super::security::is_smoke_command(name), "{name}");
            assert!(super::super::APP_WINDOW_COMMANDS.contains(name), "{name}");
        }
    }

    #[test]
    fn rects_are_validated_as_electron_does() {
        let ok = parse_normalized_rects(&params(json!({
            "rects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4 }]
        })))
        .unwrap();
        assert_eq!(
            ok,
            vec![NormalizedRect {
                x: 0.1,
                y: 0.2,
                w: 0.3,
                h: 0.4
            }]
        );
        for bad in [
            json!({}),
            json!({ "rects": [] }),
            json!({ "rects": [1] }),
            json!({ "rects": [{ "x": 0, "y": 0, "w": 1 }] }),
            json!({ "rects": [{ "x": 0, "y": 0, "w": 0, "h": 1 }] }),
            json!({ "rects": [{ "x": "0", "y": 0, "w": 1, "h": 1 }] }),
        ] {
            assert!(
                parse_normalized_rects(&params(bad.clone())).is_err(),
                "{bad}"
            );
        }
        let many = vec![json!({ "x": 0, "y": 0, "w": 1, "h": 1 }); MAX_RECTS + 1];
        assert!(parse_normalized_rects(&params(json!({ "rects": many }))).is_err());
    }

    #[test]
    fn the_mean_reads_the_middle_fifth_in_either_order() {
        // 10 × 10: left half red, right half blue (BGRA).
        let mut bitmap = vec![0u8; 10 * 10 * 4];
        for y in 0..10 {
            for x in 0..10 {
                let i = (y * 10 + x) * 4;
                if x < 5 {
                    bitmap[i + 2] = 255;
                } else {
                    bitmap[i] = 255;
                }
                bitmap[i + 3] = 255;
            }
        }
        let left = NormalizedRect {
            x: 0.0,
            y: 0.0,
            w: 0.5,
            h: 1.0,
        };
        let right = NormalizedRect { x: 0.5, ..left };
        let means = mean_rects(&bitmap, 10, 10, PixelOrder::Bgra, &[left, right]).unwrap();
        assert_eq!(
            means[0],
            RgbMean {
                r: 255.0,
                g: 0.0,
                b: 0.0
            }
        );
        assert_eq!(
            means[1],
            RgbMean {
                r: 0.0,
                g: 0.0,
                b: 255.0
            }
        );
        let swapped = mean_rects(&bitmap, 10, 10, PixelOrder::Rgba, &[left]).unwrap();
        assert_eq!(
            swapped[0],
            RgbMean {
                r: 0.0,
                g: 0.0,
                b: 255.0
            }
        );
        assert!(mean_rects(&bitmap[..10], 10, 10, PixelOrder::Bgra, &[left]).is_err());
    }

    #[test]
    fn the_stage_is_clipped_to_the_window() {
        assert_eq!(
            stage_capture_rect(-4.0, 10.2, 100.0, 50.0, (80.0, 600.0)),
            Some(PixelRect {
                x: 0,
                y: 10,
                width: 80,
                height: 50
            })
        );
        assert_eq!(
            stage_capture_rect(900.0, 0.0, 10.0, 10.0, (800.0, 600.0)),
            None
        );
        assert_eq!(
            stage_capture_rect(f64::NAN, 0.0, 10.0, 10.0, (800.0, 600.0)),
            None
        );
    }
}
