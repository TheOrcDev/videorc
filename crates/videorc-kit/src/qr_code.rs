//! QR code (`phone-remote-section.tsx`'s pairing SVG): dark modules on
//! white paper in both themes — scanners need the contrast. Encodes the
//! text (pairing URL) with medium ECC and a 2-module quiet border, then
//! paints via the kit's SVG raster (same path as SoundPad's ring).

use std::sync::Arc;

use gpui::{
    App, Bounds, ElementId, IntoElement, RenderImage, SharedString, Window, canvas, div,
    prelude::*, px,
};
use qrcode::{Color, EcLevel, QrCode as Encoder};

use crate::{
    chrome,
    theme::{Appearance, hsla, resolve},
    tokens::radius,
};

/// Default on-screen edge, matching Electron's `size-56` (14 rem).
pub const DEFAULT_SIZE: f32 = 224.0;

/// One SVG path for the whole code (a run per dark span), matching
/// Electron's `qrCodePath`.
pub fn path_for(text: &str) -> Option<(String, usize)> {
    let code = Encoder::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    let width = code.width();
    let border = 2;
    let size = width + border * 2;
    let mut path = String::new();
    for y in 0..width {
        let mut x = 0;
        while x < width {
            if code[(x, y)] != Color::Dark {
                x += 1;
                continue;
            }
            let mut run = 1;
            while x + run < width && code[(x + run, y)] == Color::Dark {
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
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        QrCode {
            id: id.into(),
            text: text.into(),
            size: DEFAULT_SIZE,
            accessibility_label: "QR code".into(),
            appearance: None,
        }
    }

    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = label.into();
        self
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
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
            .size(edge)
            .flex_none()
            .rounded(px(radius::CHIP))
            .bg(hsla(0xffffff_ff))
            .p(px(4.))
            .overflow_hidden()
            .aria_label(label)
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
                    .text_color(hsla(t.muted_foreground))
                    .child("Couldn't draw the code.")
                    .into_any_element(),
            })
    }
}

fn paint_qr(window: &mut Window, bounds: Bounds<gpui::Pixels>, image: Arc<RenderImage>) {
    let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), image, 0, false);
}

/// Gallery / tests: the encoded path exists for a short URL.
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
}
