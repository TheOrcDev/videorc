use std::borrow::Cow;

use image::imageops::FilterType;

/// One immutable latest-frame response for the Windows proof surface.
///
/// The capture stores already retain only the newest frame. This payload keeps
/// that latest-wins contract while avoiding PNG compression on every poll. A
/// top-down 32-bit BMP can carry the capture store's BGRA bytes directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestPreviewBmp {
    pub generation: String,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixel_format: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewBmpCursor {
    pub generation: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LatestPreviewBmpPoll {
    Frame(LatestPreviewBmp),
    Unchanged { generation: String, sequence: u64 },
}

pub fn encode_latest_bgra_bmp(
    cursor: Option<&PreviewBmpCursor>,
    generation: String,
    sequence: u64,
    width: u32,
    height: u32,
    bytes: &[u8],
    max_width: u32,
) -> Option<LatestPreviewBmpPoll> {
    // Capture-local frame sequences restart at one whenever a source runtime is
    // replaced. Suppress only within the same runtime generation, and do it
    // before copying, resizing, or wrapping the frame as BMP.
    if cursor.is_some_and(|cursor| cursor.generation == generation && sequence <= cursor.sequence) {
        return Some(LatestPreviewBmpPoll::Unchanged {
            generation,
            sequence,
        });
    }

    let width = width.max(1);
    let height = height.max(1);
    let expected_len = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(4)?;
    if bytes.len() < expected_len {
        return None;
    }

    let max_width = max_width.max(1);
    let (pixels, width, height) =
        bounded_bgra_pixels(&bytes[..expected_len], width, height, max_width)?;

    let stride = width.checked_mul(4)?;
    let pixel_bytes = stride.checked_mul(height)?;
    let file_size = 54_u32.checked_add(pixel_bytes)?;
    let width_i32 = i32::try_from(width).ok()?;
    let height_i32 = i32::try_from(height).ok()?.checked_neg()?;
    let mut bmp = Vec::with_capacity(file_size as usize);

    // BITMAPFILEHEADER (14 bytes).
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&54_u32.to_le_bytes());
    // BITMAPINFOHEADER (40 bytes). A negative height makes rows top-down, so
    // the capture store's row order does not need a second full-frame copy.
    bmp.extend_from_slice(&40_u32.to_le_bytes());
    bmp.extend_from_slice(&width_i32.to_le_bytes());
    bmp.extend_from_slice(&height_i32.to_le_bytes());
    bmp.extend_from_slice(&1_u16.to_le_bytes());
    bmp.extend_from_slice(&32_u16.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&pixel_bytes.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&pixels);

    Some(LatestPreviewBmpPoll::Frame(LatestPreviewBmp {
        generation,
        sequence,
        width,
        height,
        stride,
        pixel_format: "bgra8",
        bytes: bmp,
    }))
}

fn bounded_bgra_pixels(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_width: u32,
) -> Option<(Cow<'_, [u8]>, u32, u32)> {
    if width <= max_width {
        // FrameHandle already retains immutable Arc-backed bytes for this call;
        // append them directly into the BMP instead of cloning a second raw
        // full-frame allocation first.
        return Some((Cow::Borrowed(bytes), width, height));
    }

    let target_height = ((u64::from(height) * u64::from(max_width)) / u64::from(width))
        .max(1)
        .min(u64::from(u32::MAX)) as u32;
    let image = image::RgbaImage::from_raw(width, height, bytes.to_vec())?;
    let resized = image::imageops::resize(&image, max_width, target_height, FilterType::Triangle);
    Some((Cow::Owned(resized.into_raw()), max_width, target_height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_top_down_bgra_with_explicit_dimensions_and_stride() {
        let LatestPreviewBmpPoll::Frame(frame) = encode_latest_bgra_bmp(
            None,
            "camera-run-a".to_string(),
            42,
            2,
            1,
            &[1, 2, 3, 255, 4, 5, 6, 255],
            2,
        )
        .unwrap() else {
            panic!("expected a frame");
        };

        assert_eq!(frame.generation, "camera-run-a");
        assert_eq!(frame.sequence, 42);
        assert_eq!((frame.width, frame.height, frame.stride), (2, 1, 8));
        assert_eq!(frame.pixel_format, "bgra8");
        assert_eq!(&frame.bytes[..2], b"BM");
        assert_eq!(
            i32::from_le_bytes(frame.bytes[18..22].try_into().unwrap()),
            2
        );
        assert_eq!(
            i32::from_le_bytes(frame.bytes[22..26].try_into().unwrap()),
            -1
        );
        assert_eq!(&frame.bytes[54..], &[1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn downscales_to_the_bounded_preview_width() {
        let LatestPreviewBmpPoll::Frame(frame) =
            encode_latest_bgra_bmp(None, "screen-run-a".to_string(), 9, 4, 2, &[255; 32], 2)
                .unwrap()
        else {
            panic!("expected a frame");
        };
        assert_eq!((frame.width, frame.height, frame.stride), (2, 1, 8));
        assert_eq!(frame.bytes.len(), 54 + 8);
    }

    #[test]
    fn no_resize_path_borrows_the_retained_frame_bytes() {
        let pixels = [1, 2, 3, 255, 4, 5, 6, 255];
        let (bounded, width, height) = bounded_bgra_pixels(&pixels, 2, 1, 2).unwrap();

        let Cow::Borrowed(bounded) = bounded else {
            panic!("no-resize BMP transport must not clone the raw frame");
        };
        assert_eq!((width, height), (2, 1));
        assert!(std::ptr::eq(bounded.as_ptr(), pixels.as_ptr()));
    }

    #[test]
    fn rejects_truncated_capture_bytes() {
        assert!(
            encode_latest_bgra_bmp(None, "screen-run-a".to_string(), 1, 2, 2, &[0; 15], 2,)
                .is_none()
        );
    }

    #[test]
    fn matching_generation_suppresses_duplicates_before_validating_or_copying_pixels() {
        let cursor = PreviewBmpCursor {
            generation: "screen-run-a".to_string(),
            sequence: 12,
        };

        assert_eq!(
            encode_latest_bgra_bmp(
                Some(&cursor),
                "screen-run-a".to_string(),
                12,
                3840,
                2160,
                &[],
                1920,
            ),
            Some(LatestPreviewBmpPoll::Unchanged {
                generation: "screen-run-a".to_string(),
                sequence: 12,
            })
        );
    }

    #[test]
    fn a_new_generation_publishes_after_its_sequence_restarts() {
        let cursor = PreviewBmpCursor {
            generation: "screen-run-a".to_string(),
            sequence: 500,
        };
        let LatestPreviewBmpPoll::Frame(frame) = encode_latest_bgra_bmp(
            Some(&cursor),
            "screen-run-b".to_string(),
            1,
            1,
            1,
            &[1, 2, 3, 255],
            1,
        )
        .unwrap() else {
            panic!("new source generation must publish its first frame");
        };

        assert_eq!(frame.generation, "screen-run-b");
        assert_eq!(frame.sequence, 1);
    }
}
