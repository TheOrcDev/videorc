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

#[cfg(test)]
mod tests {
    use super::*;

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
