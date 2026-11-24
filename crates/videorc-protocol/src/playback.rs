//! The Library's playback family (plan 220 S3.7b, P3-D3): the backend
//! decodes a finished recording into its own three-slot frame ring and plays
//! the sound itself, so the Rust app's preview element shows it on the same
//! `CAMetalLayer` path as the live preview and the sound never reaches the
//! System audio capture (`setExcludesCurrentProcessAudio`, as the soundboard
//! monitor since S1.3b).
//!
//! Methods (renderer or admin): `playback.open {sessionId, maxWidth?,
//! maxHeight?}`, `playback.play`, `playback.pause`, `playback.seek
//! {positionMs}`, `playback.mute {muted}`, `playback.close` and
//! `playback.status`, each answering a [`PlaybackStatus`]. One playback at a
//! time: a second open closes the first. Leases (admin, connection-owned
//! like the preview's): `playback.frame.acquire {leaseId, playbackId}`
//! answers a [`PlaybackFrameReady`] or null, `playback.frame.release
//! {leaseId}` answers true when it matched.
//!
//! Events: `playback.status` on every change and four times a second while
//! playing; `playback.frameReady` per published frame (coalesced, latest
//! wins).

use serde::{Deserialize, Serialize};

pub const PLAYBACK_STATUS_EVENT: &str = "playback.status";
pub const PLAYBACK_FRAME_READY_EVENT: &str = "playback.frameReady";

/// Why a recording cannot play here (Electron's `SessionMediaGrantRefusal`,
/// `main/session-media.ts`): the player's copy keys on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackRefusal {
    /// No such session, no file, a symlink, or not a regular file.
    NotFound,
    /// Only `.mp4` plays in Videorc (the Finder's player may play the rest).
    NotMp4,
    /// Empty, or its `moov` is not written yet: the take still records or
    /// finalizes.
    NotReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackState {
    /// Nothing open.
    Closed,
    /// The file is being inspected, probed and its first frame decoded.
    Opening,
    /// Open with a frame on the surface; the clock stands.
    Paused,
    Playing,
    /// The clock reached the end; `play` starts over from the top.
    Ended,
    /// The file was refused (`refusal` says why) or playback failed
    /// (`message` says how); nothing is open.
    Failed,
}

/// How the frames leave the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackSurface {
    /// macOS: each frame is an IOSurface the app imports by id (zero copy
    /// into the presenter).
    Iosurface,
    /// Windows and Linux until S4.1d's shared-memory ring carries them:
    /// the frames are decoded and counted but no surface leaves the backend.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub state: PlaybackState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// The decoded picture's size (the file's, capped at the open's
    /// `maxWidth` × `maxHeight` with its aspect kept).
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub muted: bool,
    pub surface: PlaybackSurface,
    /// Frames published to the ring since the open.
    pub frames_published: u64,
    /// Audio frames (48 kHz stereo) handed to the output since the open.
    pub audio_frames_played: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<PlaybackRefusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub updated_at: String,
}

impl PlaybackStatus {
    pub fn closed(updated_at: String) -> Self {
        Self {
            state: PlaybackState::Closed,
            playback_id: None,
            session_id: None,
            position_ms: 0,
            duration_ms: 0,
            width: 0,
            height: 0,
            fps: 0.0,
            has_audio: false,
            muted: false,
            surface: PlaybackSurface::None,
            frames_published: 0,
            audio_frames_played: 0,
            refusal: None,
            message: None,
            updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackOpenParams {
    pub session_id: String,
    /// The slot's device pixels: the decode is scaled to fit them (aspect
    /// kept, never enlarged). Absent: 1920 × 1080.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSeekParams {
    pub position_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackMuteParams {
    pub muted: bool,
}

/// One published frame: the latest in the ring at the event, the leased one
/// in a `playback.frame.acquire` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFrameReady {
    pub playback_id: String,
    /// Counts from 1 at the open; a seek keeps counting.
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    /// The frame's time in the recording.
    pub position_ms: u64,
    /// macOS: the global IOSurface the frame sits in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iosurface_id: Option<u32>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFrameAcquireParams {
    pub lease_id: String,
    pub playback_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFrameReleaseParams {
    pub lease_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_status_omits_its_options_and_names_its_state() {
        let json = serde_json::to_value(PlaybackStatus::closed("t".into())).unwrap();
        assert_eq!(json["state"], "closed");
        assert_eq!(json["surface"], "none");
        assert!(json.get("playbackId").is_none());
        assert!(json.get("refusal").is_none());
        assert!(json.get("message").is_none());
        let back: PlaybackStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back.state, PlaybackState::Closed);
    }

    #[test]
    fn refusals_and_params_use_electron_s_words() {
        assert_eq!(
            serde_json::to_string(&PlaybackRefusal::NotMp4).unwrap(),
            "\"not-mp4\""
        );
        assert_eq!(
            serde_json::to_string(&PlaybackRefusal::NotReady).unwrap(),
            "\"not-ready\""
        );
        let params: PlaybackOpenParams =
            serde_json::from_str(r#"{"sessionId":"s1","maxWidth":1280}"#).unwrap();
        assert_eq!(params.max_width, Some(1280));
        assert_eq!(params.max_height, None);
        let frame = PlaybackFrameReady {
            playback_id: "p".into(),
            frame_id: 3,
            width: 320,
            height: 180,
            position_ms: 66,
            iosurface_id: None,
            updated_at: "t".into(),
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert!(json.get("iosurfaceId").is_none());
        assert_eq!(json["frameId"], 3);
    }
}
