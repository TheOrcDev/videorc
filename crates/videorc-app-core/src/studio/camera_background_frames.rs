//! Plan 258 UX (`camera-background-viewer.tsx`): the popover's "What viewers
//! see". The backend's camera store holds only processed frames while an
//! effect is on (D2), so its newest frame is what every output carries, never
//! the raw camera. It is asked for at
//! `/preview/camera/latest.bmp?token=&maxWidth=[&afterGeneration=&afterSequence=]`,
//! in the dialect of the room's pictures ([`super::room_frames`]): `200` with
//! a BMP and its cursor, `204` unchanged since the cursor asked about, and
//! `404` when there is no camera frame (the camera is off or starting).

use std::time::Duration;

use super::room_frames::{
    FrameCursor, FramePoll, MAX_FRAME_BYTES, POLL_DEADLINE, encode, read_poll,
};

/// `POLL_MS`: how often the picture asks for a newer frame while it is open.
pub const POLL_INTERVAL: Duration = Duration::from_millis(150);
/// `MAX_WIDTH`: twice the popover's width, for a sharp picture on Retina.
pub const MAX_WIDTH: u32 = 640;

/// `cameraFrameUrl`'s path and query.
pub fn camera_frame_path(token: &str, max_width: u32, after: Option<&FrameCursor>) -> String {
    let mut path = format!(
        "/preview/camera/latest.bmp?token={}&maxWidth={max_width}",
        encode(token)
    );
    if let Some(after) = after {
        path.push_str(&format!(
            "&afterGeneration={}&afterSequence={}",
            encode(&after.generation),
            after.sequence
        ));
    }
    path
}

/// An answer, as the viewer reads it: a `404` is no camera frame (back to the
/// pick's own picture); anything else reads as the room's pictures do.
pub fn read_camera_poll(status: u16, headers: &[(String, String)], body: Vec<u8>) -> FramePoll {
    match status {
        404 => FramePoll::Empty,
        _ => read_poll(status, headers, body),
    }
}

/// One poll of the camera's latest processed frame on the backend's loopback
/// server. An error is the caller's to retry on its next tick.
pub async fn poll_camera_frame(
    port: u16,
    token: &str,
    after: Option<&FrameCursor>,
) -> anyhow::Result<FramePoll> {
    let path = camera_frame_path(token, MAX_WIDTH, after);
    let (status, headers, body) =
        crate::http::get_with_headers(port, &path, "image/bmp", MAX_FRAME_BYTES, POLL_DEADLINE)
            .await?;
    Ok(read_camera_poll(status, &headers, body))
}

/// A frame's pixels: opaque BGRA, rows top-down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BgraFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// The pixels of the route's BMP (32-bit uncompressed, as `preview_bmp.rs`
/// writes it; rows top-down for a negative height), every pixel opaque, and
/// each row turned around when the camera is mirrored (the outputs mirror in
/// the compositor, after the store this frame comes from). None for anything
/// else.
pub fn bgra_from_bmp(bmp: &[u8], mirror: bool) -> Option<BgraFrame> {
    let u32_at = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bmp.get(at..at + 4)?.try_into().ok()?))
    };
    let i32_at = |at: usize| -> Option<i32> {
        Some(i32::from_le_bytes(bmp.get(at..at + 4)?.try_into().ok()?))
    };
    if bmp.get(0..2) != Some(&b"BM"[..]) {
        return None;
    }
    let offset = usize::try_from(u32_at(10)?).ok()?;
    let width = i32_at(18)?;
    let height = i32_at(22)?;
    let bits = u16::from_le_bytes(bmp.get(28..30)?.try_into().ok()?);
    let compression = u32_at(30)?;
    if width <= 0 || height == 0 || bits != 32 || compression != 0 {
        return None;
    }
    let top_down = height < 0;
    let (width, height) = (width.unsigned_abs(), height.unsigned_abs());
    let stride = usize::try_from(width).ok()?.checked_mul(4)?;
    let len = stride.checked_mul(usize::try_from(height).ok()?)?;
    let source = bmp.get(offset..offset.checked_add(len)?)?;
    let mut pixels = Vec::with_capacity(len);
    let rows = source.chunks_exact(stride);
    let mut push_row = |row: &[u8]| {
        let mut push =
            |pixel: &[u8]| pixels.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
        if mirror {
            row.chunks_exact(4).rev().for_each(&mut push);
        } else {
            row.chunks_exact(4).for_each(&mut push);
        }
    };
    if top_down {
        rows.for_each(&mut push_row);
    } else {
        rows.rev().for_each(&mut push_row);
    }
    Some(BgraFrame {
        width,
        height,
        pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    /// A 32-bit BMP as the backend writes it (`height` negative: top-down).
    fn bmp(width: i32, height: i32, pixels: &[[u8; 4]]) -> Vec<u8> {
        let bytes = pixels.len() as u32 * 4;
        let mut out = Vec::new();
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(54 + bytes).to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&54_u32.to_le_bytes());
        out.extend_from_slice(&40_u32.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&32_u16.to_le_bytes());
        out.extend_from_slice(&0_u32.to_le_bytes());
        out.extend_from_slice(&bytes.to_le_bytes());
        out.extend_from_slice(&[0; 16]);
        for pixel in pixels {
            out.extend_from_slice(pixel);
        }
        out
    }

    #[test]
    fn the_camera_path_carries_the_token_the_width_and_the_cursor() {
        assert_eq!(
            camera_frame_path("t k", MAX_WIDTH, None),
            "/preview/camera/latest.bmp?token=t+k&maxWidth=640"
        );
        let after = FrameCursor {
            generation: "camera:1&2".into(),
            sequence: 41,
        };
        assert_eq!(
            camera_frame_path("t", 320, Some(&after)),
            "/preview/camera/latest.bmp?token=t&maxWidth=320&afterGeneration=camera%3A1%262&afterSequence=41"
        );
    }

    #[test]
    fn camera_answers_read_as_the_viewer_reads_them() {
        let cursor = headers(&[
            ("x-videorc-frame-generation", "g2"),
            ("x-videorc-frame-sequence", "12"),
        ]);
        assert_eq!(
            read_camera_poll(200, &cursor, vec![1, 2, 3]),
            FramePoll::Frame {
                cursor: FrameCursor {
                    generation: "g2".into(),
                    sequence: 12
                },
                bmp: vec![1, 2, 3]
            }
        );
        // Unchanged since the cursor: the last frame stays.
        assert_eq!(
            read_camera_poll(204, &cursor, Vec::new()),
            FramePoll::Unchanged
        );
        // No camera frame (camera off or starting): back to the picture.
        assert_eq!(read_camera_poll(404, &[], Vec::new()), FramePoll::Empty);
        // A refused or failed poll keeps the last frame and is asked again.
        assert_eq!(read_camera_poll(401, &[], Vec::new()), FramePoll::Unchanged);
        assert_eq!(read_camera_poll(500, &[], Vec::new()), FramePoll::Unchanged);
        assert_eq!(read_camera_poll(200, &[], vec![1]), FramePoll::Unchanged);
    }

    #[test]
    fn a_top_down_bmp_reads_as_opaque_rows_in_order() {
        let frame = bgra_from_bmp(
            &bmp(
                2,
                -2,
                &[[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 9, 9], [10, 11, 12, 255]],
            ),
            false,
        )
        .unwrap();
        assert_eq!((frame.width, frame.height), (2, 2));
        assert_eq!(
            frame.pixels,
            vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]
        );
    }

    #[test]
    fn a_mirrored_camera_turns_each_row_around() {
        let frame = bgra_from_bmp(
            &bmp(
                2,
                -2,
                &[[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 9, 0], [10, 11, 12, 0]],
            ),
            true,
        )
        .unwrap();
        assert_eq!(
            frame.pixels,
            vec![4, 5, 6, 255, 1, 2, 3, 255, 10, 11, 12, 255, 7, 8, 9, 255]
        );
    }

    #[test]
    fn a_bottom_up_bmp_is_turned_the_right_way_up() {
        let frame = bgra_from_bmp(&bmp(1, 2, &[[1, 1, 1, 0], [2, 2, 2, 0]]), false).unwrap();
        assert_eq!(frame.pixels, vec![2, 2, 2, 255, 1, 1, 1, 255]);
    }

    #[test]
    fn anything_but_a_whole_32_bit_bmp_is_no_frame() {
        assert_eq!(bgra_from_bmp(&[], false), None);
        assert_eq!(
            bgra_from_bmp(b"not a bmp at all, just some text here", false),
            None
        );
        let whole = bmp(2, -1, &[[1, 2, 3, 0], [4, 5, 6, 0]]);
        // Cut short: the pixels it promises are not all there.
        assert_eq!(bgra_from_bmp(&whole[..whole.len() - 1], false), None);
        // 24-bit.
        let mut other = whole.clone();
        other[28] = 24;
        assert_eq!(bgra_from_bmp(&other, false), None);
        // No width.
        let mut flat = whole;
        flat[18..22].copy_from_slice(&0_i32.to_le_bytes());
        assert_eq!(bgra_from_bmp(&flat, false), None);
    }
}
