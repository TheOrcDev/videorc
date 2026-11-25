//! Encode a managed scene background for `cloud.room.scene.commit` (Electron
//! `encodePictureInBrowser` / plan 249 S14). Resolves
//! `videorc-asset://background/…` under the app's background-assets and the
//! bundled pictures, then fits and encodes under the room asset caps.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageReader, RgbImage, RgbaImage};
use serde_json::Value;
use videorc_app_core::cloud_scene::types::BackgroundMime;
use videorc_app_core::studio::js_value::{get, string};
use videorc_app_core::studio::room_background::{
    BACKGROUND_ASSET_MAX_BYTES, managed_background_file_name, managed_background_roots,
    picture_size, resolve_managed_background_file,
};

/// Electron's quality ladder for `canvas.convertToBlob` (0.9 → 0.55).
const JPEG_QUALITIES: [u8; 4] = [90, 80, 70, 55];

/// Bundled pictures next to the Electron assets (dev) or resources
/// (packaged): [`videorc_app_core::bundled`].
pub fn bundled_background_dir() -> PathBuf {
    videorc_app_core::bundled::current().backgrounds.clone()
}

/// Load and encode the working background's managed picture, or `None` when
/// it is live / has no managed path (prepare handles those).
pub fn encode_working_background_picture(
    background: &Value,
    user_data_dir: &Path,
) -> Result<Option<EncodedRoomPicture>, String> {
    if get(Some(background), "live").is_some() {
        return Ok(None);
    }
    let path = string(get(Some(background), "managedAssetPath"))
        .ok_or_else(|| "The background picture has no managed path.".to_string())?;
    let file_name = managed_background_file_name(path)
        .ok_or_else(|| "The background picture path is not a managed asset.".to_string())?;
    let roots = managed_background_roots(user_data_dir, Some(&bundled_background_dir()));
    let file = resolve_managed_background_file(&file_name, &roots)
        .ok_or_else(|| "The background picture couldn't be found.".to_string())?;
    let raw = std::fs::read(&file).map_err(|_| "The background picture couldn't be read.")?;
    Ok(Some(encode_room_picture(&raw)?))
}

/// Working-background JSON with the encoded picture's size and mime filled
/// in so [`videorc_app_core::studio::room_background::prepare_room_background`]
/// attaches the right asset header.
pub fn background_with_encoded(background: &Value, encoded: &EncodedRoomPicture) -> Value {
    let mut next = background.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("width".into(), Value::from(encoded.width));
        object.insert("height".into(), Value::from(encoded.height));
        object.insert(
            "mime".into(),
            Value::from(match encoded.mime {
                BackgroundMime::Webp => "image/webp",
                BackgroundMime::Jpeg => "image/jpeg",
                BackgroundMime::Png => "image/png",
            }),
        );
    }
    next
}

/// One encoded room picture (WebP when it fits, else JPEG), sized to the
/// room asset max side.
pub struct EncodedRoomPicture {
    pub bytes: Vec<u8>,
    pub mime: BackgroundMime,
    pub width: u32,
    pub height: u32,
}

/// Decode, fit, and encode under [`BACKGROUND_ASSET_MAX_BYTES`].
pub fn encode_room_picture(bytes: &[u8]) -> Result<EncodedRoomPicture, String> {
    let picture = decode(bytes).ok_or_else(|| "The background picture couldn't be decoded.")?;
    let (src_w, src_h) = (picture.width(), picture.height());
    if src_w == 0 || src_h == 0 {
        return Err("The background picture couldn't be decoded.".into());
    }
    let (width, height) = picture_size(src_w, src_h);
    let drawn = if (width, height) == (src_w, src_h) {
        picture
    } else {
        picture.resize_exact(width, height, FilterType::Lanczos3)
    };
    let rgba = drawn.to_rgba8();
    if let Some(webp) = encode_webp(&rgba).filter(|bytes| bytes.len() <= BACKGROUND_ASSET_MAX_BYTES)
    {
        return Ok(EncodedRoomPicture {
            bytes: webp,
            mime: BackgroundMime::Webp,
            width,
            height,
        });
    }
    let rgb = drawn.to_rgb8();
    for quality in JPEG_QUALITIES {
        if let Some(jpeg) =
            encode_jpeg(&rgb, quality).filter(|bytes| bytes.len() <= BACKGROUND_ASSET_MAX_BYTES)
        {
            return Ok(EncodedRoomPicture {
                bytes: jpeg,
                mime: BackgroundMime::Jpeg,
                width,
                height,
            });
        }
    }
    Err("The background picture is too large to send.".into())
}

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()
}

fn encode_webp(rgba: &RgbaImage) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    WebPEncoder::new_lossless(&mut out)
        .encode(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(out)
}

fn encode_jpeg(rgb: &RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, Rgba, RgbaImage};

    #[test]
    fn encodes_a_small_picture_under_the_cap() {
        let mut rgba = RgbaImage::new(32, 24);
        for pixel in rgba.pixels_mut() {
            *pixel = Rgba([10, 20, 30, 255]);
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        let encoded = encode_room_picture(&png).expect("encode");
        assert!(!encoded.bytes.is_empty());
        assert!(encoded.bytes.len() <= BACKGROUND_ASSET_MAX_BYTES);
        assert_eq!(encoded.width, 32);
        assert_eq!(encoded.height, 24);
    }

    #[test]
    fn bundled_dir_holds_a_builtin_picture() {
        let path = bundled_background_dir().join("code-demo.webp");
        assert!(
            path.is_file(),
            "expected bundled background at {}",
            path.display()
        );
    }
}
