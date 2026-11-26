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

/// macOS's own sRGB profile: the colour space the program's pixels are in.
pub const SRGB_PROFILE: &str = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";

/// The tool that colour-matches a capture (`sips`, on every Mac).
pub const SIPS: &str = "/usr/bin/sips";

/// `sips`'s arguments that colour-match the PNG at `file` to sRGB in place.
///
/// `screencapture -l` writes the window as the display shows it: its pixels
/// in the display's colour space (Display P3 on a Mac's own screen), tagged
/// with that profile. The Preview's layer is colour-matched from sRGB to the
/// display, so a sampled sRGB cyan banner reads `[117, 251, 253]` and yellow
/// `[254, 254, 84]` (plan 260 L1). Electron's macOS oracle
/// (`preview.debug.sample`) reads the program's own sRGB pixels, so a
/// sample is matched back to sRGB first, through the profile the capture
/// carries. A PNG with no profile is left as it is.
pub fn srgb_match_args(file: &std::path::Path) -> Vec<std::ffi::OsString> {
    vec![
        "--matchTo".into(),
        SRGB_PROFILE.into(),
        file.as_os_str().to_owned(),
        "--out".into(),
        file.as_os_str().to_owned(),
    ]
}

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

/// A decoded capture: top-down BGRA rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    pub width: usize,
    pub height: usize,
    pub bgra: Vec<u8>,
}

impl Bitmap {
    /// The pixels inside `rect`, clipped to the bitmap; `None` when nothing
    /// of it is inside.
    pub fn crop(&self, rect: PixelRect) -> Option<Bitmap> {
        let x0 = (rect.x as usize).min(self.width);
        let y0 = (rect.y as usize).min(self.height);
        let x1 = (rect.x as usize + rect.width as usize).min(self.width);
        let y1 = (rect.y as usize + rect.height as usize).min(self.height);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let width = x1 - x0;
        let mut bgra = Vec::with_capacity(width * (y1 - y0) * 4);
        for y in y0..y1 {
            let start = (y * self.width + x0) * 4;
            bgra.extend_from_slice(&self.bgra[start..start + width * 4]);
        }
        Some(Bitmap {
            width,
            height: y1 - y0,
            bgra,
        })
    }
}

/// An uncompressed Windows bitmap (what `screencapture -t bmp` writes):
/// 24- or 32-bit, bottom-up or top-down, as top-down BGRA.
pub fn decode_bmp(bytes: &[u8]) -> Result<Bitmap, String> {
    let u16_at = |at: usize| -> Result<u16, String> {
        bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .ok_or_else(|| "The bitmap is cut short.".to_string())
    };
    let u32_at = |at: usize| -> Result<u32, String> {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| "The bitmap is cut short.".to_string())
    };
    if bytes.get(0..2) != Some(b"BM") {
        return Err("Not a BMP file.".into());
    }
    let offset = u32_at(10)? as usize;
    let width = u32_at(18)? as i32;
    let height = u32_at(22)? as i32;
    let bits = u16_at(28)?;
    let compression = u32_at(30)?;
    if width <= 0 || height == 0 {
        return Err(format!("Not a bitmap size: {width}x{height}"));
    }
    // BI_RGB, or BI_BITFIELDS with the usual BGRA masks.
    if compression != 0 && compression != 3 {
        return Err(format!(
            "A compressed bitmap ({compression}) is not read here."
        ));
    }
    let bytes_per_pixel = match bits {
        24 => 3,
        32 => 4,
        other => return Err(format!("A {other}-bit bitmap is not read here.")),
    };
    let width = width as usize;
    let rows = height.unsigned_abs() as usize;
    let stride = (width * bytes_per_pixel).div_ceil(4) * 4;
    if bytes.len() < offset + stride * rows {
        return Err("The bitmap is cut short.".into());
    }
    let mut bgra = Vec::with_capacity(width * rows * 4);
    for y in 0..rows {
        // Positive height: the last row comes first in the file.
        let row = if height > 0 { rows - 1 - y } else { y };
        let start = offset + row * stride;
        for x in 0..width {
            let pixel = &bytes[start + x * bytes_per_pixel..];
            let alpha = if bytes_per_pixel == 4 { pixel[3] } else { 255 };
            bgra.extend_from_slice(&[pixel[0], pixel[1], pixel[2], alpha]);
        }
    }
    Ok(Bitmap {
        width,
        height: rows,
        bgra,
    })
}

/// The canvas contain-fit into the slot, centred (the layer's
/// `contain_dest_rect`): the stage the frames are drawn in, as
/// `(left, top, width, height)` in the slot's units.
pub fn contain(slot: (f64, f64, f64, f64), canvas: (u32, u32)) -> (f64, f64, f64, f64) {
    let (x, y, w, h) = slot;
    if canvas.0 == 0 || canvas.1 == 0 || w <= 0.0 || h <= 0.0 {
        return slot;
    }
    let aspect = f64::from(canvas.0) / f64::from(canvas.1);
    let (fw, fh) = if w / h > aspect {
        (h * aspect, h)
    } else {
        (w, w / aspect)
    };
    (x + (w - fw) / 2.0, y + (h - fh) / 2.0, fw, fh)
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

    /// A 2 × 2 bottom-up 24-bit bitmap: bottom row red, blue; top row
    /// green, white.
    fn tiny_bmp() -> Vec<u8> {
        let mut bytes = vec![0u8; 54];
        bytes[0..2].copy_from_slice(b"BM");
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&2i32.to_le_bytes());
        bytes[22..26].copy_from_slice(&2i32.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24u16.to_le_bytes());
        // Rows pad to 4 bytes: 6 bytes of pixels, 2 of padding.
        bytes.extend_from_slice(&[0, 0, 255, 255, 0, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 255, 0, 255, 255, 255, 0, 0]);
        bytes
    }

    #[test]
    fn a_bottom_up_bitmap_reads_top_down() {
        let bitmap = decode_bmp(&tiny_bmp()).unwrap();
        assert_eq!((bitmap.width, bitmap.height), (2, 2));
        assert_eq!(
            bitmap.bgra,
            vec![
                0, 255, 0, 255, 255, 255, 255, 255, // top: green, white
                0, 0, 255, 255, 255, 0, 0, 255, // bottom: red, blue
            ]
        );
        let corner = bitmap
            .crop(PixelRect {
                x: 1,
                y: 1,
                width: 5,
                height: 5,
            })
            .unwrap();
        assert_eq!(corner.bgra, vec![255, 0, 0, 255]);
        assert!(decode_bmp(b"PNG").is_err());
        assert!(decode_bmp(&tiny_bmp()[..60]).is_err());
    }

    #[test]
    fn the_canvas_is_contain_fit_in_the_slot() {
        // Wider slot: pillarboxed.
        assert_eq!(
            contain((0.0, 0.0, 300.0, 100.0), (200, 100)),
            (50.0, 0.0, 200.0, 100.0)
        );
        // Taller slot: letterboxed.
        assert_eq!(
            contain((10.0, 0.0, 160.0, 180.0), (200, 100)),
            (10.0, 50.0, 160.0, 80.0)
        );
    }

    #[test]
    fn a_capture_is_matched_to_srgb_in_place() {
        let file = std::path::Path::new("/tmp/videorc preview sample.png");
        assert_eq!(
            srgb_match_args(file),
            vec![
                std::ffi::OsString::from("--matchTo"),
                SRGB_PROFILE.into(),
                file.as_os_str().to_owned(),
                "--out".into(),
                file.as_os_str().to_owned(),
            ]
        );
    }

    /// The profile and the tool are the system's own, on every Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_srgb_profile_and_sips_exist_on_macos() {
        assert!(
            std::path::Path::new(SRGB_PROFILE).is_file(),
            "{SRGB_PROFILE}"
        );
        assert!(std::path::Path::new(SIPS).is_file(), "{SIPS}");
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
