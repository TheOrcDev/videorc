//! The image files the overlays draw: chat avatars and emotes. The renderer
//! decoded each with `createImageBitmap` (the first frame of a GIF or an
//! animated WebP) and painted it with `drawImage` at the canvas defaults
//! (bilinear, no mipmaps; a destination rect that is not anti-aliased unless
//! it is under a pixel); this is the same drawing on tiny-skia.
//!
//! The bytes come from the backend's chat image cache (plan 220 S1.6a), never
//! from the network: the caller collects them before drawing
//! (`DecodedImages::load`).

use std::collections::HashMap;
use std::sync::Arc;

use tiny_skia::{
    FilterQuality, Mask, Paint, Pattern, Pixmap, PremultipliedColorU8, Rect, SpreadMode, Transform,
};

/// A card never decodes a picture larger than this on either side (the
/// renderer's 2 MB cap keeps real ones far smaller).
const MAX_IMAGE_SIDE: u32 = 4096;

/// One decoded image, premultiplied, as the canvas holds an `ImageBitmap`.
#[derive(Debug)]
pub(crate) struct DecodedImage {
    pixmap: Pixmap,
}

impl DecodedImage {
    pub(crate) fn width(&self) -> u32 {
        self.pixmap.width()
    }

    pub(crate) fn height(&self) -> u32 {
        self.pixmap.height()
    }
}

/// A PNG, JPEG, WebP or GIF (its first frame), or None for anything else.
pub(crate) fn decode(bytes: &[u8]) -> Option<DecodedImage> {
    let image = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return None;
    }
    let mut pixmap = Pixmap::new(width, height)?;
    for (pixel, rgba) in pixmap
        .pixels_mut()
        .iter_mut()
        .zip(image.as_raw().chunks_exact(4))
    {
        let alpha = rgba[3];
        let premultiply =
            |channel: u8| -> u8 { ((u16::from(channel) * u16::from(alpha) + 127) / 255) as u8 };
        *pixel = PremultipliedColorU8::from_rgba(
            premultiply(rgba[0]),
            premultiply(rgba[1]),
            premultiply(rgba[2]),
            alpha,
        )?;
    }
    Some(DecodedImage { pixmap })
}

/// The images one overlay draws, decoded once and shared by its landscape
/// and portrait rasters. A URL with no bytes, or bytes that do not decode,
/// is absent: the card then draws the monogram, or the emote's name.
#[derive(Debug, Default)]
pub(crate) struct DecodedImages {
    images: HashMap<String, Arc<DecodedImage>>,
    missing: Vec<String>,
}

impl DecodedImages {
    /// Decodes each URL's bytes as `read` returns them.
    pub(crate) fn load<'a>(
        urls: impl IntoIterator<Item = &'a str>,
        mut read: impl FnMut(&str) -> Option<Vec<u8>>,
    ) -> Self {
        let mut decoded = Self::default();
        for url in urls {
            if decoded.images.contains_key(url) || decoded.missing.iter().any(|seen| seen == url) {
                continue;
            }
            match read(url).as_deref().and_then(decode) {
                Some(image) => {
                    decoded.images.insert(url.to_string(), Arc::new(image));
                }
                None => decoded.missing.push(url.to_string()),
            }
        }
        decoded
    }

    pub(crate) fn get(&self, url: &str) -> Option<&DecodedImage> {
        self.images.get(url).map(Arc::as_ref)
    }

    /// The URLs that had no decodable bytes, in the order asked.
    pub(crate) fn missing(&self) -> &[String] {
        &self.missing
    }
}

/// `ctx.drawImage(image, x, y, w, h)`, moved by (`dx`, `dy`) (a shadow pass),
/// inside `clip` when there is one. Blink anti-aliases the destination rect
/// only when it is under a device pixel on a side.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_image(
    target: &mut Pixmap,
    image: &DecodedImage,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    clip: Option<&Mask>,
    dx: f32,
    dy: f32,
) {
    let (x, y) = (x + dx, y + dy);
    let Some(rect) = Rect::from_xywh(x, y, w, h) else {
        return;
    };
    let scale_x = w / image.width() as f32;
    let scale_y = h / image.height() as f32;
    let paint = Paint {
        shader: Pattern::new(
            image.pixmap.as_ref(),
            SpreadMode::Pad,
            FilterQuality::Bilinear,
            1.0,
            Transform::from_row(scale_x, 0.0, 0.0, scale_y, x, y),
        ),
        anti_alias: w < 1.0 || h < 1.0,
        ..Paint::default()
    };
    target.fill_rect(rect, &paint, Transform::identity(), clip);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba(rgba));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("png");
        bytes.into_inner()
    }

    #[test]
    fn images_decode_once_and_a_missing_one_is_named() {
        let red = png(4, 2, [255, 0, 0, 255]);
        let mut reads = 0;
        let images = DecodedImages::load(["a", "b", "a"], |url| {
            reads += 1;
            (url == "a").then(|| red.clone())
        });
        assert_eq!(reads, 2);
        let a = images.get("a").expect("decoded");
        assert_eq!((a.width(), a.height()), (4, 2));
        assert!(images.get("b").is_none());
        assert_eq!(images.missing(), ["b".to_string()]);
        assert!(decode(b"not an image").is_none());
    }

    #[test]
    fn an_image_fills_its_destination_rect_scaled() {
        let image = decode(&png(2, 2, [0, 0, 255, 255])).expect("decoded");
        let mut target = Pixmap::new(10, 10).expect("pixmap");
        draw_image(&mut target, &image, 2.0, 2.0, 6.0, 4.0, None, 0.0, 0.0);
        let inside = target.pixel(4, 4).expect("pixel");
        assert_eq!((inside.blue(), inside.alpha()), (255, 255));
        assert_eq!(target.pixel(1, 4).expect("pixel").alpha(), 0);
        assert_eq!(target.pixel(4, 6).expect("pixel").alpha(), 0);
    }
}
