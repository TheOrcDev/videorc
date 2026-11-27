//! Plan 260 S1.8 (L1), slice R3: the pictures of the people in the
//! backend's talk-show room, for the GPUI Show stage's tiles and the
//! Program monitor (the renderer's `room-remote-feed.ts`). The backend keeps
//! each remote video's latest frame (S1.8d d1) at
//! `/room/remote/latest.bmp?token=&identity=&source=camera|screen|monitor`,
//! in the HTML overlay route's dialect: `200` with a BMP and its cursor
//! (`x-videorc-frame-generation`, `x-videorc-frame-sequence`), `204`
//! unchanged since the cursor asked about, `204` with `x-videorc-layer-empty`
//! when there is no picture.

use std::time::Duration;

/// A remote picture's kind on the route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RemoteSource {
    Camera,
    Screen,
    /// The runner's return while the Program monitor takes it.
    Monitor,
}

impl RemoteSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteSource::Camera => "camera",
            RemoteSource::Screen => "screen",
            RemoteSource::Monitor => "monitor",
        }
    }
}

/// The last picture's place in its stream; asked with, the route answers
/// `204` until a newer one is there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameCursor {
    pub generation: String,
    pub sequence: u64,
}

/// One poll's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramePoll {
    /// A newer picture: a BMP and its cursor.
    Frame { cursor: FrameCursor, bmp: Vec<u8> },
    /// Nothing newer than the cursor.
    Unchanged,
    /// No picture (not published, or gone): the tile shows none.
    Empty,
}

/// The polling pace: the renderer's 30 fps.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// One poll's deadline and the biggest picture read (a 4K BGRA BMP).
const POLL_DEADLINE: Duration = Duration::from_secs(2);
const MAX_FRAME_BYTES: usize = 3840 * 2160 * 4 + 1024;

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// `remoteFrameUrl`'s path and query.
pub fn remote_frame_path(
    token: &str,
    identity: &str,
    source: RemoteSource,
    after: Option<&FrameCursor>,
) -> String {
    let mut path = format!(
        "/room/remote/latest.bmp?token={}&identity={}&source={}",
        encode(token),
        encode(identity),
        source.as_str()
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

/// An answer, as the renderer's feed reads it.
pub fn read_poll(status: u16, headers: &[(String, String)], body: Vec<u8>) -> FramePoll {
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    match status {
        200 => {
            let generation = header("x-videorc-frame-generation");
            let sequence = header("x-videorc-frame-sequence").and_then(|value| value.parse().ok());
            match (generation, sequence) {
                (Some(generation), Some(sequence)) if !body.is_empty() => FramePoll::Frame {
                    cursor: FrameCursor {
                        generation: generation.to_string(),
                        sequence,
                    },
                    bmp: body,
                },
                // A picture without its cursor is not trusted.
                _ => FramePoll::Unchanged,
            }
        }
        204 if header("x-videorc-layer-empty").is_some() => FramePoll::Empty,
        _ => FramePoll::Unchanged,
    }
}

/// One poll of a person's (or the monitor's) latest picture on the backend's
/// loopback server. An error is the caller's to retry on its next tick.
pub async fn poll_remote_frame(
    port: u16,
    token: &str,
    identity: &str,
    source: RemoteSource,
    after: Option<&FrameCursor>,
) -> anyhow::Result<FramePoll> {
    let path = remote_frame_path(token, identity, source, after);
    let (status, headers, body) =
        crate::http::get_with_headers(port, &path, "image/bmp", MAX_FRAME_BYTES, POLL_DEADLINE)
            .await?;
    Ok(read_poll(status, &headers, body))
}

/// A room picture's pixels: BGRA, rows top-down, the alpha as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomBgra {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// The pixels of the room route's BMP: the HTML overlay dialect
/// (`encode_bgra_bmp_with_alpha`: a V4 header, 32 bits, uncompressed or
/// `BI_BITFIELDS` with the BGRA masks, rows top-down for a negative height).
/// None for any other BMP, so a stranger is skipped, never drawn wrong.
pub fn bgra_from_room_bmp(bmp: &[u8]) -> Option<RoomBgra> {
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    let u32_at = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bmp.get(at..at + 4)?.try_into().ok()?))
    };
    if bmp.get(0..2) != Some(&b"BM"[..]) {
        return None;
    }
    let offset = usize::try_from(u32_at(10)?).ok()?;
    let width = i32::from_le_bytes(bmp.get(18..22)?.try_into().ok()?);
    let height = i32::from_le_bytes(bmp.get(22..26)?.try_into().ok()?);
    let bits = u16::from_le_bytes(bmp.get(28..30)?.try_into().ok()?);
    let compression = u32_at(30)?;
    if width <= 0 || height == 0 || bits != 32 || !matches!(compression, BI_RGB | BI_BITFIELDS) {
        return None;
    }
    if compression == BI_BITFIELDS
        && (u32_at(54)? != 0x00FF_0000 || u32_at(58)? != 0x0000_FF00 || u32_at(62)? != 0x0000_00FF)
    {
        return None;
    }
    let (width, height) = (width.unsigned_abs(), height.unsigned_abs());
    let stride = usize::try_from(width).ok()?.checked_mul(4)?;
    let len = stride.checked_mul(usize::try_from(height).ok()?)?;
    let source = bmp.get(offset..offset.checked_add(len)?)?;
    let pixels = if height_is_top_down(bmp)? {
        source.to_vec()
    } else {
        source
            .chunks_exact(stride)
            .rev()
            .flatten()
            .copied()
            .collect()
    };
    Some(RoomBgra {
        width,
        height,
        pixels,
    })
}

fn height_is_top_down(bmp: &[u8]) -> Option<bool> {
    Some(i32::from_le_bytes(bmp.get(22..26)?.try_into().ok()?) < 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room_bmp(compression: u32, height: i32, pixels: &[u8]) -> Vec<u8> {
        let mut bmp = vec![0; 122];
        bmp[0..2].copy_from_slice(b"BM");
        bmp[10..14].copy_from_slice(&122_u32.to_le_bytes());
        bmp[14..18].copy_from_slice(&108_u32.to_le_bytes());
        bmp[18..22].copy_from_slice(&2_i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&height.to_le_bytes());
        bmp[26..28].copy_from_slice(&1_u16.to_le_bytes());
        bmp[28..30].copy_from_slice(&32_u16.to_le_bytes());
        bmp[30..34].copy_from_slice(&compression.to_le_bytes());
        bmp[54..58].copy_from_slice(&0x00FF_0000_u32.to_le_bytes());
        bmp[58..62].copy_from_slice(&0x0000_FF00_u32.to_le_bytes());
        bmp[62..66].copy_from_slice(&0x0000_00FF_u32.to_le_bytes());
        bmp.extend_from_slice(pixels);
        bmp
    }

    #[test]
    fn the_rooms_v4_bmp_decodes_to_bgra_rows_top_down() {
        // Two rows of two pixels: top-down keeps them, bottom-up flips them.
        let rows = [1, 2, 3, 255, 4, 5, 6, 200, 7, 8, 9, 255, 10, 11, 12, 100];
        let top_down = bgra_from_room_bmp(&room_bmp(3, -2, &rows)).unwrap();
        assert_eq!((top_down.width, top_down.height), (2, 2));
        assert_eq!(top_down.pixels, rows);
        let bottom_up = bgra_from_room_bmp(&room_bmp(3, 2, &rows)).unwrap();
        assert_eq!(&bottom_up.pixels[..8], &rows[8..]);
        assert_eq!(&bottom_up.pixels[8..], &rows[..8]);
        assert!(bgra_from_room_bmp(&room_bmp(0, -2, &rows)).is_some());
    }

    #[test]
    fn a_bmp_that_is_not_the_rooms_dialect_is_skipped() {
        let rows = [0_u8; 16];
        assert_eq!(bgra_from_room_bmp(&room_bmp(1, -2, &rows)), None);
        assert_eq!(bgra_from_room_bmp(&room_bmp(3, -2, &rows[..8])), None);
        assert_eq!(bgra_from_room_bmp(b"PNG"), None);
    }

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn the_path_carries_the_token_the_person_and_the_cursor() {
        assert_eq!(
            remote_frame_path("t k", "guest:a&b", RemoteSource::Camera, None),
            "/room/remote/latest.bmp?token=t+k&identity=guest%3Aa%26b&source=camera"
        );
        let after = FrameCursor {
            generation: "g1".into(),
            sequence: 7,
        };
        assert_eq!(
            remote_frame_path("t", "runner:x", RemoteSource::Monitor, Some(&after)),
            "/room/remote/latest.bmp?token=t&identity=runner%3Ax&source=monitor&afterGeneration=g1&afterSequence=7"
        );
    }

    #[test]
    fn answers_read_as_the_renderers_feed_reads_them() {
        let frame = read_poll(
            200,
            &headers(&[
                ("x-videorc-frame-generation", "g2"),
                ("x-videorc-frame-sequence", "12"),
            ]),
            vec![1, 2, 3],
        );
        assert_eq!(
            frame,
            FramePoll::Frame {
                cursor: FrameCursor {
                    generation: "g2".into(),
                    sequence: 12
                },
                bmp: vec![1, 2, 3]
            }
        );
        assert_eq!(read_poll(200, &[], vec![1]), FramePoll::Unchanged);
        assert_eq!(read_poll(204, &[], Vec::new()), FramePoll::Unchanged);
        assert_eq!(
            read_poll(204, &headers(&[("x-videorc-layer-empty", "1")]), Vec::new()),
            FramePoll::Empty
        );
        assert_eq!(read_poll(401, &[], Vec::new()), FramePoll::Unchanged);
    }
}
