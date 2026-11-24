//! Plan 260 S1.2 (plan 220 S1.2a, ported from `videorc-rust`): the backend
//! draws what the renderer's OffscreenCanvas draws.
//!
//! Today the renderer paints the caption bar, the chat highlight card, the
//! Sidekick bubble and the chat box with `OffscreenCanvas`
//! (`renderer/src/lib/caption-overlay.ts`, `buddy-overlay.ts`, with the
//! layouts in `comment-highlight*.ts` and `chat-overlay.ts`) and sends each
//! here as a PNG (`captions.overlay.set`, `comments.highlight.set`,
//! `buddy.overlay.set`, `chat.overlay.set`). This module is the same painting
//! in Rust, layout for layout: text through parley (fontique's system fonts
//! with the renderer's font stack, per-script fallback and colour emoji)
//! rasterised with swash, shapes (rounded rects, gradients, strokes, canvas
//! shadows) on tiny-skia. Its output is the straight-alpha RGBA the PNG path
//! decodes to.
//!
//! S1.2a lands the painter for the caption bar and the captioned copy's cue
//! frames, held to the renderer's own PNGs (`golden_tests`); no production
//! path uses it yet. The later S1.2 slices switch each overlay over and add
//! the card, chat box and Sidekick painters.
//!
//! The goldens (`tests/fixtures/overlay-raster/`) are the renderer's own PNGs
//! (`node scripts/overlay-raster-goldens.mjs`); `golden_tests` holds the
//! drawing to them.

mod canvas;
mod caption;
mod text;

#[cfg(test)]
mod golden_tests;

use serde::Deserialize;
use tiny_skia::Pixmap;

use canvas::Rgba;
pub(crate) use caption::CaptionFrameState;
use caption::{CaptionBarState, CaptionOverlayPosition, CaptionStyleId, CaptionTextSize};

pub(crate) use crate::overlay_layout::OverlayRect;

/// One overlay to draw, tagged as the golden cases are.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "overlay", rename_all = "lowercase")]
pub(crate) enum OverlayState {
    Caption(CaptionBarState),
    /// A captioned copy's cue frame, or the Captions page's preview.
    #[serde(rename = "captionFrame")]
    CaptionFrame(CaptionFrameState),
}

/// A drawn overlay: straight-alpha RGBA rows, as a decoded PNG.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverlayImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl OverlayImage {
    fn from_pixmap(pixmap: Pixmap) -> Self {
        Self {
            width: pixmap.width(),
            height: pixmap.height(),
            rgba: pixmap.take_demultiplied(),
        }
    }
}

/// Draws one overlay the way the renderer would, or None where the renderer
/// sends nothing (empty text, no room).
pub(crate) fn render(state: &OverlayState) -> Option<OverlayImage> {
    render_premultiplied(state).map(OverlayImage::from_pixmap)
}

fn render_premultiplied(state: &OverlayState) -> Option<Pixmap> {
    match state {
        OverlayState::Caption(state) => caption::render(state),
        OverlayState::CaptionFrame(state) => caption::render_frame(state),
    }
}

/// The caption bar for one line on a leg's canvas: what the renderer's
/// burn-in driver asked `renderCaptionOverlayPng` for, the bar wrapping to
/// the placed rect's width in whole pixels (plan 164) when there is one.
pub(crate) fn caption_bar(
    text: &str,
    canvas: (u32, u32),
    text_size: CaptionTextSize,
    style_id: CaptionStyleId,
    rect: Option<OverlayRect>,
) -> CaptionBarState {
    CaptionBarState {
        text: text.to_string(),
        canvas_width: canvas.0,
        canvas_height: Some(canvas.1),
        text_size,
        style_id,
        max_bar_width_px: rect.map(|rect| (rect.w * f64::from(canvas.0)).floor()),
    }
}

/// One frame of the captioned copy (or the Captions page's preview): what
/// `renderCaptionCueFramePng` drew for a cue on the session's output canvas,
/// in its frozen caption style. Empty text is the blank gap frame.
pub(crate) fn caption_frame(
    text: &str,
    canvas: (u32, u32),
    position: CaptionOverlayPosition,
    text_size: CaptionTextSize,
    style_id: CaptionStyleId,
) -> CaptionFrameState {
    CaptionFrameState {
        text: text.to_string(),
        canvas_width: canvas.0,
        canvas_height: canvas.1,
        position,
        text_size,
        style_id,
    }
}

/// The highlight card's glass (`paintCaptionBar`'s recipe), shared by the
/// glass caption, the highlight card and the chat box.
const GLASS_FILL: Rgba = Rgba::new(16, 16, 18, 0.78);
const GLASS_SHEEN: [(f32, Rgba); 3] = [
    (0.0, Rgba::new(255, 255, 255, 0.07)),
    (0.35, Rgba::new(255, 255, 255, 0.015)),
    (1.0, Rgba::new(255, 255, 255, 0.0)),
];
const GLASS_HAIRLINE: Rgba = Rgba::new(255, 255, 255, 0.1);

/// JavaScript's `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `ctx.measureText(text).width` in the layouts' arithmetic.
fn measure(text: &str, font: text::Font) -> f64 {
    f64::from(text::measure(text, font))
}
