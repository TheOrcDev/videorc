//! The golden harness: each case in `tests/fixtures/overlay-raster/cases.json`
//! drawn here and compared with the renderer's own PNG for it.
//!
//! The metric, in premultiplied RGBA (what the compositor blends; a straight
//! colour under alpha 0 or 1 is noise): per pixel, the largest channel
//! difference `d` (0 to 255), over the ink (pixels either image covers).
//! A case holds when:
//!
//! - the size is equal: the bitmap is the layout's measured widths and line
//!   heights, so one pixel off is a layout fault;
//! - `over64`, the share of ink pixels with `d > 64`, is at most 2 %. Two
//!   rasterisers disagree on glyph edges (CoreText's smoothed coverage under
//!   Skia's mask gamma against zeno's exact area with the fitted dilation and
//!   curve): an edge pixel moves by a quarter of full scale or so, rarely
//!   more. On the cases here it is 0.06 to 0.7 %. A layout fault moves whole
//!   stems: a text line one pixel low measured 5.2 % (the Buddy bubble) and
//!   7.1 % (the lower third), a colour emoji drawn at 14 px instead of
//!   CoreText's 18 measured 10.9 %;
//! - `mean`, the mean `d` over the ink, is at most 12: the gate for a wrong
//!   fill, gradient or shadow, which shifts every plate pixel without
//!   touching the shape. Plate cases measure 1.3 to 2.6; the outlined
//!   classic caption, all edges and no plate, measures 9.6 (its edges,
//!   fill on stroke and stroke on shadow, are nearly all of its ink); a
//!   0.07 change of the glass's alpha alone is 18 over the plate.
//!
//! The comparison runs only on a Mac of the macOS major version that made the
//! goldens (`made.macos`): the fonts are the host's. Elsewhere each case is
//! still drawn (`every_case_draws_on_any_platform`).
//!
//! `VIDEORC_OVERLAY_RASTER_OUT=<dir>` writes each case's drawing and a
//! difference image there.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tiny_skia::Pixmap;

use super::{OverlayState, caption_bar, render, render_premultiplied};

const MAX_OVER_64: f64 = 0.02;
const MAX_MEAN: f64 = 12.0;

#[derive(Deserialize)]
struct Fixture {
    made: Made,
    cases: Vec<Case>,
}

/// Where the goldens were made. The fonts are the host's, so a golden holds
/// only on the macOS it came from.
#[derive(Deserialize)]
struct Made {
    macos: String,
}

/// The pixel comparison runs on a Mac whose major version made the goldens:
/// another macOS ships other system fonts (CI's runner image among them).
fn host_matches_goldens(made: &Made) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the goldens are the macOS renderer's (macOS system fonts)".into());
    }
    let host = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    let major = |version: &str| version.split('.').next().unwrap_or_default().to_string();
    if major(&host) != major(&made.macos) {
        return Err(format!(
            "this is macOS {host}; the goldens are macOS {}'s fonts",
            made.macos
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Case {
    id: String,
    request: OverlayState,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/overlay-raster")
}

fn load() -> Fixture {
    let path = fixture_dir().join("cases.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("cases.json"))
        .expect("cases.json parses")
}

/// A PNG as premultiplied RGBA.
fn golden(id: &str) -> Pixmap {
    let bytes = std::fs::read(fixture_dir().join(format!("{id}.png"))).expect("golden png");
    // `decode_png` premultiplies.
    Pixmap::decode_png(&bytes).expect("golden decodes")
}

struct Difference {
    size: (u32, u32),
    golden_size: (u32, u32),
    ink: usize,
    max: u8,
    mean: f64,
    over32: f64,
    over64: f64,
}

fn compare(drawn: &Pixmap, golden: &Pixmap) -> Difference {
    let size = (drawn.width(), drawn.height());
    let golden_size = (golden.width(), golden.height());
    let width = size.0.min(golden_size.0);
    let height = size.1.min(golden_size.1);
    let (mut ink, mut sum, mut max, mut over32, mut over64) = (0usize, 0u64, 0u8, 0usize, 0usize);
    for y in 0..height {
        for x in 0..width {
            let a = drawn.pixel(x, y).expect("pixel");
            let b = golden.pixel(x, y).expect("pixel");
            if a.alpha() == 0 && b.alpha() == 0 {
                continue;
            }
            let d = [
                a.red().abs_diff(b.red()),
                a.green().abs_diff(b.green()),
                a.blue().abs_diff(b.blue()),
                a.alpha().abs_diff(b.alpha()),
            ]
            .into_iter()
            .max()
            .unwrap_or(0);
            ink += 1;
            sum += u64::from(d);
            max = max.max(d);
            over32 += usize::from(d > 32);
            over64 += usize::from(d > 64);
        }
    }
    let share = |count: usize| count as f64 / ink.max(1) as f64;
    Difference {
        size,
        golden_size,
        ink,
        max,
        mean: sum as f64 / ink.max(1) as f64,
        over32: share(over32),
        over64: share(over64),
    }
}

/// The drawing and a difference image (white = 255 apart) for a look by eye.
fn write_diagnostics(dir: &Path, id: &str, drawn: &Pixmap, golden: &Pixmap) {
    let _ = std::fs::create_dir_all(dir);
    let _ = drawn.save_png(dir.join(format!("{id}.rust.png")));
    let _ = golden.save_png(dir.join(format!("{id}.golden.png")));
    let width = drawn.width().max(golden.width());
    let height = drawn.height().max(golden.height());
    let Some(mut diff) = Pixmap::new(width, height) else {
        return;
    };
    for y in 0..height {
        for x in 0..width {
            let d = match (drawn.pixel(x, y), golden.pixel(x, y)) {
                (Some(a), Some(b)) => [
                    a.red().abs_diff(b.red()),
                    a.green().abs_diff(b.green()),
                    a.blue().abs_diff(b.blue()),
                    a.alpha().abs_diff(b.alpha()),
                ]
                .into_iter()
                .max()
                .unwrap_or(0),
                _ => 255,
            };
            let at = ((y * width + x) * 4) as usize;
            diff.data_mut()[at..at + 4].copy_from_slice(&[d, d, d, 255]);
        }
    }
    let _ = diff.save_png(dir.join(format!("{id}.diff.png")));
}

#[test]
fn every_golden_case_is_drawn_within_the_agreed_difference() {
    let fixture = load();
    if let Err(why) = host_matches_goldens(&fixture.made) {
        eprintln!("skipping the pixel comparison: {why}");
        return;
    }
    let out = std::env::var_os("VIDEORC_OVERLAY_RASTER_OUT").map(PathBuf::from);
    let mut failures = Vec::new();
    for case in fixture.cases {
        let golden = golden(&case.id);
        let drawn = render_premultiplied(&case.request)
            .unwrap_or_else(|| panic!("{}: the backend drew nothing", case.id));
        let difference = compare(&drawn, &golden);
        println!(
            "{}: {}x{} (golden {}x{}), ink {} px, max {}, mean {:.2}, >32 {:.2} %, >64 {:.2} %",
            case.id,
            difference.size.0,
            difference.size.1,
            difference.golden_size.0,
            difference.golden_size.1,
            difference.ink,
            difference.max,
            difference.mean,
            difference.over32 * 100.0,
            difference.over64 * 100.0
        );
        if let Some(dir) = &out {
            write_diagnostics(dir, &case.id, &drawn, &golden);
        }
        if difference.size != difference.golden_size
            || difference.over64 > MAX_OVER_64
            || difference.mean > MAX_MEAN
        {
            failures.push(case.id);
        }
    }
    assert!(
        failures.is_empty(),
        "outside the agreed difference: {failures:?}"
    );
}

#[test]
fn every_case_draws_on_any_platform() {
    for case in load().cases {
        let image = render(&case.request).unwrap_or_else(|| panic!("{}: nothing drawn", case.id));
        assert_eq!(
            image.rgba.len(),
            (image.width * image.height * 4) as usize,
            "{}",
            case.id
        );
        assert!(
            image.rgba.chunks_exact(4).any(|pixel| pixel[3] == 255),
            "{}: no opaque pixel",
            case.id
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn emoji_and_japanese_fall_back_to_their_fonts() {
    let fonts = super::text::fonts_for("Hi 👋 こんにちは", super::text::Font::new(32.0, 600));
    assert!(
        fonts.iter().any(|name| name == "Apple Color Emoji"),
        "{fonts:?}"
    );
    assert!(fonts.len() >= 3, "{fonts:?}");
}

/// macOS (Apple Color Emoji) and Windows (Segoe UI Emoji) ship a colour emoji
/// font; a Linux box (or CI image) may not, so the Linux beta checks it with
/// its own fonts.
#[cfg(not(target_os = "linux"))]
#[test]
fn an_emoji_draws_in_colour() {
    let state: OverlayState = serde_json::from_value(serde_json::json!({
        "overlay": "caption",
        "text": "🔥🔥🔥",
        "canvasWidth": 1280,
        "canvasHeight": 720,
        "textSize": "m",
        "styleId": "high-contrast"
    }))
    .expect("state");
    let image = render(&state).expect("drawn");
    let saturated = image
        .rgba
        .chunks_exact(4)
        .filter(|pixel| pixel[3] > 200 && pixel[0] > 180 && pixel[2] < 90)
        .count();
    assert!(saturated > 50, "{saturated} orange pixels");
}

/// Plan 220 S1.2b: the bars `captions.overlay.set` draws for the two caption
/// smokes' legs, from the default placed rects, are exactly golden cases'
/// states: `smoke:captions-live`'s 640x360 aux leg and
/// `smoke:captions-dual-orientation`'s 720x1280 vertical leg.
#[test]
fn the_caption_smokes_bars_are_golden_cases() {
    use crate::captions::{CaptionStyleId, CaptionTextSize};
    use crate::overlay_layout::{OverlayItem, OverlayOrientation, OverlaySnap, overlay_snap_rect};

    let rect = |orientation| {
        Some(overlay_snap_rect(
            OverlayItem::Captions,
            orientation,
            OverlaySnap::BottomCenter,
        ))
    };
    let live = [
        (
            "caption-high-contrast-l-360p-live",
            caption_bar(
                "VIDEORC LIVE CAPTION RENDERER PROOF",
                (640, 360),
                CaptionTextSize::L,
                CaptionStyleId::HighContrast,
                rect(OverlayOrientation::Horizontal),
            ),
        ),
        (
            "caption-high-contrast-m-portrait-rect",
            caption_bar(
                "VIDEORC DUAL ORIENTATION CAPTION PROOF",
                (720, 1280),
                CaptionTextSize::M,
                CaptionStyleId::HighContrast,
                rect(OverlayOrientation::Vertical),
            ),
        ),
    ];
    let cases = load().cases;
    for (id, drawn) in live {
        let case = cases.iter().find(|case| case.id == id).expect(id);
        let OverlayState::Caption(golden) = &case.request else {
            panic!("{id} is not a caption case");
        };
        assert_eq!(drawn.text, golden.text, "{id}");
        assert_eq!(
            (drawn.canvas_width, drawn.canvas_height),
            (golden.canvas_width, golden.canvas_height),
            "{id}"
        );
        assert_eq!(
            (drawn.text_size, drawn.style_id),
            (golden.text_size, golden.style_id),
            "{id}"
        );
        assert_eq!(drawn.max_bar_width_px, golden.max_bar_width_px, "{id}");
    }
}

/// Plan 220 S1.2e: the cue frame the backend draws for `smoke:captions-live`'s
/// captioned copy (its line on the 640x360 recording, high contrast, large,
/// at the bottom: the session's frozen caption style) is exactly a golden
/// case's state, as is the Captions page preview's sample at 960x540.
#[test]
fn the_captioned_copys_frames_are_golden_cases() {
    use crate::captions::{CaptionOverlayPosition, CaptionStyleId, CaptionTextSize};

    let drawn = [
        (
            "caption-frame-high-contrast-l-360p-smoke",
            super::caption_frame(
                "VIDEORC LIVE CAPTION RENDERER PROOF",
                (640, 360),
                CaptionOverlayPosition::Bottom,
                CaptionTextSize::L,
                CaptionStyleId::HighContrast,
            ),
        ),
        (
            "caption-preview-classic-m-960x540",
            super::caption_frame(
                "Your words become clear, live captions.",
                (960, 540),
                CaptionOverlayPosition::Bottom,
                CaptionTextSize::M,
                CaptionStyleId::Classic,
            ),
        ),
    ];
    let cases = load().cases;
    for (id, drawn) in drawn {
        let case = cases.iter().find(|case| case.id == id).expect(id);
        let OverlayState::CaptionFrame(golden) = &case.request else {
            panic!("{id} is not a caption frame case");
        };
        assert_eq!(drawn.text, golden.text, "{id}");
        assert_eq!(
            (drawn.canvas_width, drawn.canvas_height),
            (golden.canvas_width, golden.canvas_height),
            "{id}"
        );
        assert_eq!(
            (drawn.position, drawn.text_size, drawn.style_id),
            (golden.position, golden.text_size, golden.style_id),
            "{id}"
        );
    }
}
