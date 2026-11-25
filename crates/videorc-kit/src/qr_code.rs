//! QrCode (`components/ui/qr-code.tsx`): dark modules on white paper in both
//! themes. Scanners need the contrast; the style guard allowlists the fixed
//! black/white ink. ECC Medium and a quiet zone of 2 modules match Electron
//! Phone Pair (`uqr` + `qrCodePath`). C5 Sweep B wires Pair a phone against
//! [`QrCode::new`].

use std::sync::Arc;

use gpui::{
    App, Bounds, ElementId, IntoElement, RenderImage, SharedString, Window, canvas, div,
    prelude::*, px,
};
use qrcode::{Color as ModuleColor, EcLevel, QrCode as Encoder};

use crate::{
    chrome,
    theme::{Appearance, hsla, resolve},
    tokens::{Color, radius},
};

/// Paper under the modules (`bg-white`). Fixed for scanners in both themes.
const PAPER: Color = 0xffff_ffff;
/// Default on-screen edge, matching Electron's `size-56` (14 rem).
pub const DEFAULT_SIZE: f32 = 224.0;
/// Electron's `p-1` around the modules.
const PAD: f32 = 4.0;

/// One SVG path for the whole code (a run per dark span), matching
/// Electron's `qrCodePath`. Quiet zone of 2 modules is included in `size`.
pub fn path_for(text: &str) -> Option<(String, usize)> {
    if text.is_empty() {
        return None;
    }
    let code = Encoder::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    let width = code.width();
    let border = 2;
    let size = width + border * 2;
    let mut path = String::new();
    for y in 0..width {
        let mut x = 0;
        while x < width {
            if code[(x, y)] != ModuleColor::Dark {
                x += 1;
                continue;
            }
            let mut run = 1;
            while x + run < width && code[(x + run, y)] == ModuleColor::Dark {
                run += 1;
            }
            let px = x + border;
            let py = y + border;
            path.push_str(&format!("M{px} {py}h{run}v1h-{run}z"));
            x += run;
        }
    }
    Some((path, size))
}

fn svg_for(text: &str) -> Option<String> {
    let (path, size) = path_for(text)?;
    Some(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="{path}" fill="#000000"/></svg>"##
    ))
}

#[derive(IntoElement)]
pub struct QrCode {
    id: ElementId,
    text: SharedString,
    size: f32,
    accessibility_label: SharedString,
    appearance: Option<Appearance>,
}

impl QrCode {
    /// Pairing URL (or any payload) to encode.
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        QrCode {
            id: id.into(),
            text: text.into(),
            size: DEFAULT_SIZE,
            accessibility_label: "QR code".into(),
            appearance: None,
        }
    }

    /// Outer edge length in px (default [`DEFAULT_SIZE`]).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = label.into();
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

fn paint_qr(window: &mut Window, bounds: Bounds<gpui::Pixels>, image: Arc<RenderImage>) {
    let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), image, 0, false);
}

impl RenderOnce for QrCode {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let edge = px(self.size);
        let label = self.accessibility_label.clone();
        let text = self.text.to_string();
        let raster = svg_for(&text).and_then(|svg| {
            let d = self.size.round().max(1.0) as u32;
            chrome::rasterise_for_kit(&svg, d, d)
        });
        div()
            .id(self.id)
            .role(gpui::Role::Image)
            .aria_label(label)
            .size(edge)
            .flex_none()
            // Electron uses rounded-row; CHIP is too tight for the paper.
            .rounded(px(radius::ROW))
            .bg(hsla(PAPER))
            .p(px(PAD))
            .overflow_hidden()
            .child(match raster {
                Some(image) => div()
                    .size_full()
                    .child(
                        canvas(
                            move |_, _, _| (),
                            move |bounds, _, window, _| {
                                paint_qr(window, bounds, image.clone());
                            },
                        )
                        .size_full(),
                    )
                    .into_any_element(),
                None => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(hsla(t.muted_foreground))
                    .child("Couldn't draw the code.")
                    .into_any_element(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_url_encodes_to_a_path() {
        let (path, size) = path_for("http://192.168.1.10:8787/pair#secret").unwrap();
        assert!(size >= 21);
        assert!(path.contains('M'));
        assert!(path.contains('h'));
    }

    #[test]
    fn empty_text_has_no_path() {
        assert!(path_for("").is_none());
    }
}
