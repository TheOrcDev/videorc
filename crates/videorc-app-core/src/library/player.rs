//! The Library's player (plan 260 S1.6f, from `videorc-rust`'s plan 220
//! S3.7c): `lib/session-player-view.ts` ported pure (the times, the keys,
//! where the marker pins sit, the copy for every refusal), the player as one
//! value ([`player_view`]) from the backend's `PlaybackStatus` (S1.7b's
//! `playback.*` methods), and [`PlayerSession`], which carries the position
//! and play state over a re-open (Electron #1493, QA F18). No UI here: the
//! Library page draws it and the app shows the frames.

use std::future::Future;

use videorc_protocol::playback::{
    PlaybackMuteParams, PlaybackOpenParams, PlaybackRefusal, PlaybackSeekParams, PlaybackState,
    PlaybackStatus,
};

use super::markers::marker_name;
use super::markers::{SessionMarker, marker_time};
use crate::client::methods::{
    PlaybackClose, PlaybackMute, PlaybackOpen, PlaybackPause, PlaybackPlay, PlaybackSeek,
};
use crate::client::socket::ENGINE_NOT_CONNECTED;
use crate::client::{BackendClient, RpcError};

/// Arrow keys move the playhead by this much.
pub const SEEK_STEP_MS: f64 = 5_000.0;
/// J and L jump by this much (the video players' convention).
pub const JUMP_STEP_MS: f64 = 10_000.0;
/// The scrubber's resolution.
pub const SCRUB_STEP_MS: f64 = 100.0;
/// The scrubber thumb's width: its centre runs from half of it to the
/// track's width less half.
pub const PLAYHEAD_THUMB_PX: f64 = 16.0;
/// A pin's hit area; pins closer than this share one chooser.
pub const MARKER_PIN_HIT_PX: f64 = 24.0;
/// Grouping needs a width before the first measure.
pub const FALLBACK_TRACK_PX: f64 = 480.0;
const HOUR_MS: f64 = 3_600_000.0;

pub const RECORDING_PLAYER: &str = "Recording player";
pub const LOADING_RECORDING: &str = "Loading recording…";
pub const PLAYBACK_FAILED: &str = "Playback failed";
pub const TRY_AGAIN: &str = "Try again";
pub const OPEN_IN_DEFAULT_PLAYER: &str = "Open in default player";
pub const PLAY: &str = "Play";
pub const PAUSE: &str = "Pause";
pub const MUTE: &str = "Mute";
pub const UNMUTE: &str = "Unmute";
pub const PLAYHEAD: &str = "Playhead";
pub const MARKER_TIMELINE: &str = "Marker timeline";
/// The renderer's words when no `grantSessionMedia` exists: here, a
/// platform without the playback element (Windows and Linux until S4.1d).
pub const NOT_IN_THIS_WINDOW: &str = "Playback isn't available in this window.";

/// Recordings of an hour or more show hours on both the playhead and the
/// duration.
pub fn media_time_has_hours(duration_ms: f64) -> bool {
    duration_ms.is_finite() && duration_ms >= HOUR_MS
}

/// The one timecode (plan 174 S1.4, E-20): `m:ss`, or `h:mm:ss` from an
/// hour and whenever `with_hours`; negative, NaN and infinite times read as
/// zero.
pub fn format_media_time(ms: f64, with_hours: bool) -> String {
    let total = if ms.is_finite() && ms > 0.0 {
        (ms / 1000.0).floor() as i64
    } else {
        0
    };
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if with_hours || hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// The scrubber's spoken value (plan 174 S0.5, E-3): "2:05 of 41:10".
pub fn playhead_value_text(position_ms: f64, duration_ms: f64) -> String {
    let with_hours = media_time_has_hours(duration_ms);
    format!(
        "{} of {}",
        format_media_time(position_ms, with_hours),
        format_media_time(duration_ms, with_hours)
    )
}

/// Keeps a seek inside the recording. Unknown durations clamp at zero only.
pub fn clamp_seek_ms(ms: f64, duration_ms: f64) -> f64 {
    if !ms.is_finite() {
        return 0.0;
    }
    let upper = if duration_ms.is_finite() && duration_ms > 0.0 {
        duration_ms
    } else {
        f64::INFINITY
    };
    ms.max(0.0).min(upper)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerKeyAction {
    Toggle,
    SeekBack,
    SeekForward,
    JumpBack,
    JumpForward,
    Start,
    End,
    Mute,
}

/// What has the focus when the key lands: a button takes its own Space, the
/// scrubber its own arrows, Home and End.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlayerKeyTarget {
    pub button: bool,
    pub slider: bool,
}

/// The player's keys, only while it has focus (plan 174 S3.12, E-30): Space
/// and K toggle, the arrows seek 5 s, J and L jump 10 s, Home and End go to
/// the start and the end, M mutes. A key with ⌘, Ctrl or ⌥ is never the
/// player's. `key` is the DOM's name (`ArrowLeft`, `Home`, " ", "k").
pub fn player_key_action(
    key: &str,
    target: PlayerKeyTarget,
    modifier: bool,
) -> Option<PlayerKeyAction> {
    if modifier {
        return None;
    }
    match key {
        " " | "Spacebar" => {
            if target.button {
                None
            } else {
                Some(PlayerKeyAction::Toggle)
            }
        }
        "ArrowLeft" | "ArrowRight" => {
            if target.slider {
                None
            } else if key == "ArrowLeft" {
                Some(PlayerKeyAction::SeekBack)
            } else {
                Some(PlayerKeyAction::SeekForward)
            }
        }
        "Home" | "End" => {
            if target.slider {
                None
            } else if key == "Home" {
                Some(PlayerKeyAction::Start)
            } else {
                Some(PlayerKeyAction::End)
            }
        }
        _ => match key.to_ascii_lowercase().as_str() {
            "k" => Some(PlayerKeyAction::Toggle),
            "j" => Some(PlayerKeyAction::JumpBack),
            "l" => Some(PlayerKeyAction::JumpForward),
            "m" => Some(PlayerKeyAction::Mute),
            _ => None,
        },
    }
}

/// Where a key sends the playhead, or none for a key that doesn't seek.
pub fn player_key_target_ms(
    action: PlayerKeyAction,
    current_ms: f64,
    duration_ms: f64,
) -> Option<f64> {
    match action {
        PlayerKeyAction::SeekBack => Some(current_ms - SEEK_STEP_MS),
        PlayerKeyAction::SeekForward => Some(current_ms + SEEK_STEP_MS),
        PlayerKeyAction::JumpBack => Some(current_ms - JUMP_STEP_MS),
        PlayerKeyAction::JumpForward => Some(current_ms + JUMP_STEP_MS),
        PlayerKeyAction::Start => Some(0.0),
        PlayerKeyAction::End => {
            (duration_ms.is_finite() && duration_ms > 0.0).then_some(duration_ms)
        }
        PlayerKeyAction::Toggle | PlayerKeyAction::Mute => None,
    }
}

/// Pins in time order; pins closer than one hit area merge into one group
/// (a chooser).
#[derive(Debug, Clone, PartialEq)]
pub struct MarkerPinGroup {
    /// The first marker's id: stable while the markers don't move.
    pub key: String,
    pub markers: Vec<SessionMarker>,
    /// Where the pin sits, 0..1 of the recording: the group's middle.
    pub fraction: f64,
}

fn fraction_of(at_seconds: f64, duration_ms: f64) -> f64 {
    let fraction = at_seconds * 1000.0 / duration_ms;
    if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// `groupMarkerPins`: nothing until the duration is known, so pins never
/// pile up at the end while the recording loads.
pub fn group_marker_pins(
    markers: &[SessionMarker],
    duration_ms: f64,
    track_width_px: f64,
) -> Vec<MarkerPinGroup> {
    if duration_ms.is_nan() || duration_ms <= 0.0 || markers.is_empty() {
        return Vec::new();
    }
    let usable_px = (track_width_px - PLAYHEAD_THUMB_PX).max(1.0);
    let mut sorted: Vec<&SessionMarker> = markers.iter().collect();
    sorted.sort_by(|left, right| left.at_seconds.total_cmp(&right.at_seconds));
    struct Open {
        markers: Vec<SessionMarker>,
        start_px: f64,
        first: f64,
        last: f64,
    }
    let mut groups: Vec<Open> = Vec::new();
    for marker in sorted {
        let fraction = fraction_of(marker.at_seconds, duration_ms);
        let px = fraction * usable_px;
        match groups.last_mut() {
            Some(open) if px - open.start_px < MARKER_PIN_HIT_PX => {
                open.markers.push(marker.clone());
                open.last = fraction;
            }
            _ => groups.push(Open {
                markers: vec![marker.clone()],
                start_px: px,
                first: fraction,
                last: fraction,
            }),
        }
    }
    groups
        .into_iter()
        .map(|group| MarkerPinGroup {
            key: group.markers[0].id.clone(),
            fraction: (group.first + group.last) / 2.0,
            markers: group.markers,
        })
        .collect()
}

/// `markerPinLeft`: a pin's centre over the scrubber, exactly under the
/// thumb's centre at that time (the thumb stays inside the track, so its
/// centre runs from 8 px to the width less 8 px).
pub fn marker_pin_centre_px(fraction: f64, track_width_px: f64) -> f64 {
    let clamped = if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    clamped * track_width_px + (PLAYHEAD_THUMB_PX / 2.0 - PLAYHEAD_THUMB_PX * clamped)
}

/// Why a grant was refused, in the player's own words.
pub fn refusal_copy(refusal: PlaybackRefusal) -> (&'static str, &'static str) {
    match refusal {
        PlaybackRefusal::NotFound => (
            "Recording file missing",
            "The file for this recording isn't where Videorc saved it.",
        ),
        PlaybackRefusal::NotMp4 => ("Not playable here", "Only MP4 recordings play in Videorc."),
        PlaybackRefusal::NotReady => (
            "Still finalizing",
            "Playback opens as soon as the recording is finished.",
        ),
    }
}

/// What a `<video>` error means to the person watching (the backend sends
/// codes 2 and 3's words itself; the rest are here for the same table).
pub fn media_error_copy(code: Option<u32>) -> &'static str {
    match code {
        Some(1) => "Playback was interrupted.",
        Some(2) => "The recording couldn't be read.",
        Some(3) => "This recording couldn't be decoded.",
        Some(4) => "This recording can't play here.",
        _ => "Playback failed.",
    }
}

/// One pin over the scrubber.
#[derive(Debug, Clone, PartialEq)]
pub struct PinView {
    /// The first marker's id (what a single pin selects).
    pub id: String,
    pub fraction: f64,
    pub several: bool,
    /// The button's name: "Intro · 1:05", or "3 markers near 1:05".
    pub label: String,
    /// A single pin's tooltip: "1:05 · Intro".
    pub tooltip: String,
    /// A chooser's items: id, time, name.
    pub entries: Vec<(String, String, String)>,
}

/// The player as one value.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerView {
    pub ready: bool,
    pub loading: bool,
    pub playing: bool,
    pub muted: bool,
    /// The pane over the picture while there is nothing to play.
    pub status_title: String,
    pub status_description: String,
    pub retry: bool,
    pub open_externally: bool,
    pub reveal: bool,
    pub position_text: String,
    pub duration_text: String,
    /// The time labels' width, in characters (5, or 7 from an hour).
    pub time_chars: u32,
    pub slider_max: f64,
    pub slider_value: f64,
    pub playhead_value: String,
    pub toggle_label: &'static str,
    pub mute_label: &'static str,
    pub pins: Vec<PinView>,
}

/// What the view is made of.
#[derive(Debug, Clone)]
pub struct PlayerInput<'a> {
    pub status: &'a PlaybackStatus,
    /// The feed's socket is up.
    pub connected: bool,
    pub markers: &'a [SessionMarker],
    /// The scrubber's value while it is dragged (shown in place of the
    /// clock).
    pub scrub_ms: Option<f64>,
    pub track_width_px: f64,
    /// The platform has a playback element at all.
    pub available: bool,
}

pub fn player_view(input: &PlayerInput<'_>) -> PlayerView {
    let status = input.status;
    let duration_ms = status.duration_ms as f64;
    let open = matches!(
        status.state,
        PlaybackState::Paused | PlaybackState::Playing | PlaybackState::Ended
    );
    let ready = input.available && open && duration_ms > 0.0;
    let (loading, title, description, retry, externally, reveal) = if !input.available {
        (
            false,
            PLAYBACK_FAILED,
            NOT_IN_THIS_WINDOW.to_string(),
            false,
            true,
            false,
        )
    } else if status.state == PlaybackState::Failed {
        match status.refusal {
            Some(refusal) => {
                let (title, description) = refusal_copy(refusal);
                let not_mp4 = refusal == PlaybackRefusal::NotMp4;
                (
                    false,
                    title,
                    description.to_string(),
                    false,
                    not_mp4,
                    not_mp4,
                )
            }
            None => (
                false,
                PLAYBACK_FAILED,
                status
                    .message
                    .clone()
                    .unwrap_or_else(|| media_error_copy(None).to_string()),
                true,
                true,
                false,
            ),
        }
    } else if !input.connected {
        (
            false,
            PLAYBACK_FAILED,
            ENGINE_NOT_CONNECTED.to_string(),
            true,
            true,
            false,
        )
    } else if ready {
        (false, "", String::new(), false, false, false)
    } else {
        (true, "", String::new(), false, false, false)
    };
    let position_ms = input.scrub_ms.unwrap_or(status.position_ms as f64);
    let with_hours = media_time_has_hours(duration_ms);
    let slider_max = duration_ms.max(SCRUB_STEP_MS);
    let playing = status.state == PlaybackState::Playing;
    let track = if input.track_width_px > 0.0 {
        input.track_width_px
    } else {
        FALLBACK_TRACK_PX
    };
    let pins = if ready {
        group_marker_pins(input.markers, duration_ms, track)
            .into_iter()
            .map(|group| {
                let first = &group.markers[0];
                let several = group.markers.len() > 1;
                PinView {
                    id: first.id.clone(),
                    fraction: group.fraction,
                    several,
                    label: if several {
                        format!(
                            "{} markers near {}",
                            group.markers.len(),
                            marker_time(first.at_seconds)
                        )
                    } else {
                        format!("{} · {}", marker_name(first), marker_time(first.at_seconds))
                    },
                    tooltip: format!("{} · {}", marker_time(first.at_seconds), marker_name(first)),
                    entries: group
                        .markers
                        .iter()
                        .map(|marker| {
                            (
                                marker.id.clone(),
                                marker_time(marker.at_seconds),
                                marker_name(marker),
                            )
                        })
                        .collect(),
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    PlayerView {
        ready,
        loading,
        playing,
        muted: status.muted,
        status_title: title.to_string(),
        status_description: description,
        retry,
        open_externally: externally,
        reveal,
        position_text: format_media_time(position_ms, with_hours),
        duration_text: format_media_time(duration_ms, with_hours),
        time_chars: if with_hours { 7 } else { 5 },
        slider_max,
        slider_value: position_ms.max(0.0).min(slider_max),
        playhead_value: playhead_value_text(position_ms, duration_ms),
        toggle_label: if playing { PAUSE } else { PLAY },
        mute_label: if status.muted { UNMUTE } else { MUTE },
        pins,
    }
}

// ── The playback, across re-opens (QA F18, Electron #1493) ──────────────

/// The `playback.*` family, as the player asks it.
pub trait PlaybackBackend: Send + Sync + 'static {
    fn open(
        &self,
        params: PlaybackOpenParams,
    ) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
    fn play(&self) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
    fn pause(&self) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
    fn seek(
        &self,
        position_ms: u64,
    ) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
    fn mute(&self, muted: bool) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
    fn close(&self) -> impl Future<Output = Result<PlaybackStatus, RpcError>> + Send;
}

impl PlaybackBackend for BackendClient {
    async fn open(&self, params: PlaybackOpenParams) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackOpen>(&params).await
    }
    async fn play(&self) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackPlay>(&()).await
    }
    async fn pause(&self) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackPause>(&()).await
    }
    async fn seek(&self, position_ms: u64) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackSeek>(&PlaybackSeekParams { position_ms })
            .await
    }
    async fn mute(&self, muted: bool) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackMute>(&PlaybackMuteParams { muted })
            .await
    }
    async fn close(&self) -> Result<PlaybackStatus, RpcError> {
        self.call::<PlaybackClose>(&()).await
    }
}

/// Where a re-open of the same recording picks up again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resume {
    pub at_ms: u64,
    pub playing: bool,
}

/// One recording in the player. It remembers where the playback was and
/// whether it played, so a re-open of the same recording (the one silent
/// re-open after a failure, and Retry) picks up there instead of at 0:00
/// and paused. Another recording is another session, from the top.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerSession {
    pub session_id: String,
    last: Option<Resume>,
    auto_retried: bool,
}

impl PlayerSession {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            last: None,
            auto_retried: false,
        }
    }

    /// Every `playback.status` for the player. While this recording is open
    /// its position and play state are kept. A failure that is not a
    /// refusal answers a [`Resume`] once: re-open now, silently (Electron's
    /// one automatic re-grant after a network or source error). A refusal,
    /// or a second failure, shows the failure with Retry.
    pub fn note(&mut self, status: &PlaybackStatus) -> Option<Resume> {
        if status.session_id.as_deref() != Some(self.session_id.as_str())
            && status.state != PlaybackState::Failed
        {
            return None;
        }
        match status.state {
            PlaybackState::Paused | PlaybackState::Playing => {
                self.last = Some(Resume {
                    at_ms: status.position_ms,
                    playing: status.state == PlaybackState::Playing,
                });
                None
            }
            PlaybackState::Ended => {
                self.last = Some(Resume {
                    at_ms: status.position_ms,
                    playing: false,
                });
                None
            }
            PlaybackState::Failed if status.refusal.is_none() && !self.auto_retried => {
                self.auto_retried = true;
                Some(self.resume())
            }
            _ => None,
        }
    }

    /// Retry: re-open where it was, with the silent re-open armed again.
    pub fn retry(&mut self) -> Resume {
        self.auto_retried = false;
        self.resume()
    }

    fn resume(&self) -> Resume {
        self.last.unwrap_or(Resume {
            at_ms: 0,
            playing: false,
        })
    }

    /// Opens the recording; with `resume`, seeks back and plays again if it
    /// played. The answer is the last status.
    pub async fn open(
        &self,
        backend: &impl PlaybackBackend,
        max_size: Option<(u32, u32)>,
        resume: Option<Resume>,
    ) -> Result<PlaybackStatus, RpcError> {
        let mut status = backend
            .open(PlaybackOpenParams {
                session_id: self.session_id.clone(),
                max_width: max_size.map(|(width, _)| width),
                max_height: max_size.map(|(_, height)| height),
            })
            .await?;
        let open = matches!(status.state, PlaybackState::Paused | PlaybackState::Ended);
        if let (true, Some(resume)) = (open, resume) {
            if resume.at_ms > 0 {
                status = backend.seek(resume.at_ms.min(status.duration_ms)).await?;
            }
            if resume.playing {
                status = backend.play().await?;
            }
        }
        Ok(status)
    }
}

/// The scrubber or a key asks for a time: clamped to the recording, whole
/// milliseconds.
pub async fn seek_to(
    backend: &impl PlaybackBackend,
    ms: f64,
    duration_ms: u64,
) -> Result<PlaybackStatus, RpcError> {
    let target = clamp_seek_ms(ms, duration_ms as f64);
    backend.seek(target.round() as u64).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(id: &str, at: f64, label: Option<&str>) -> SessionMarker {
        SessionMarker {
            id: id.into(),
            session_id: "s".into(),
            at_seconds: at,
            label: label.map(str::to_string),
            source: "typed".into(),
            created_at: String::new(),
            revision: 1,
        }
    }

    fn status(state: PlaybackState, position_ms: u64, duration_ms: u64) -> PlaybackStatus {
        PlaybackStatus {
            state,
            position_ms,
            duration_ms,
            ..PlaybackStatus::closed(String::new())
        }
    }

    #[test]
    fn the_times_read_as_electron_s() {
        assert_eq!(format_media_time(0.0, false), "0:00");
        assert_eq!(format_media_time(65_000.0, false), "1:05");
        assert_eq!(format_media_time(65_000.0, true), "0:01:05");
        assert_eq!(format_media_time(3_725_000.0, false), "1:02:05");
        assert_eq!(format_media_time(-5.0, false), "0:00");
        assert_eq!(format_media_time(f64::NAN, true), "0:00:00");
        assert!(media_time_has_hours(3_600_000.0));
        assert!(!media_time_has_hours(3_599_999.0));
        assert_eq!(playhead_value_text(125_000.0, 2_470_000.0), "2:05 of 41:10");
        assert_eq!(
            playhead_value_text(1_000.0, 7_200_000.0),
            "0:00:01 of 2:00:00"
        );
        assert_eq!(clamp_seek_ms(-10.0, 1_000.0), 0.0);
        assert_eq!(clamp_seek_ms(5_000.0, 1_000.0), 1_000.0);
        assert_eq!(clamp_seek_ms(5_000.0, 0.0), 5_000.0);
        assert_eq!(clamp_seek_ms(f64::NAN, 1_000.0), 0.0);
    }

    #[test]
    fn the_keys_follow_the_player_s_rules() {
        let none = PlayerKeyTarget::default();
        let button = PlayerKeyTarget {
            button: true,
            slider: false,
        };
        let slider = PlayerKeyTarget {
            button: false,
            slider: true,
        };
        assert_eq!(
            player_key_action(" ", none, false),
            Some(PlayerKeyAction::Toggle)
        );
        assert_eq!(player_key_action(" ", button, false), None);
        assert_eq!(
            player_key_action("K", none, false),
            Some(PlayerKeyAction::Toggle)
        );
        assert_eq!(
            player_key_action("j", none, false),
            Some(PlayerKeyAction::JumpBack)
        );
        assert_eq!(
            player_key_action("l", none, false),
            Some(PlayerKeyAction::JumpForward)
        );
        assert_eq!(
            player_key_action("m", none, false),
            Some(PlayerKeyAction::Mute)
        );
        assert_eq!(
            player_key_action("ArrowLeft", none, false),
            Some(PlayerKeyAction::SeekBack)
        );
        assert_eq!(player_key_action("ArrowRight", slider, false), None);
        assert_eq!(
            player_key_action("Home", none, false),
            Some(PlayerKeyAction::Start)
        );
        assert_eq!(player_key_action("End", slider, false), None);
        assert_eq!(player_key_action("k", none, true), None, "⌘K is Search");
        assert_eq!(player_key_action("x", none, false), None);
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::SeekBack, 12_000.0, 60_000.0),
            Some(7_000.0)
        );
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::JumpForward, 12_000.0, 60_000.0),
            Some(22_000.0)
        );
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::Start, 12_000.0, 60_000.0),
            Some(0.0)
        );
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::End, 12_000.0, 60_000.0),
            Some(60_000.0)
        );
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::End, 12_000.0, 0.0),
            None
        );
        assert_eq!(
            player_key_target_ms(PlayerKeyAction::Toggle, 12_000.0, 60_000.0),
            None
        );
    }

    #[test]
    fn pins_merge_within_a_hit_area_and_sit_under_the_thumb() {
        let markers = [
            marker("c", 50.0, Some("Late")),
            marker("a", 10.0, Some("Intro")),
            marker("b", 10.5, None),
        ];
        assert!(group_marker_pins(&markers, 0.0, 480.0).is_empty());
        let groups = group_marker_pins(&markers, 100_000.0, 480.0);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].key, "a");
        assert_eq!(
            groups[0].markers.len(),
            2,
            "10 s and 10.5 s share one pin on a 480 px track"
        );
        assert!((groups[0].fraction - 0.1025).abs() < 1e-9);
        assert_eq!(groups[1].key, "c");
        assert_eq!(groups[1].fraction, 0.5);
        // A wide track separates them.
        let wide = group_marker_pins(&markers, 100_000.0, 10_000.0);
        assert_eq!(wide.len(), 3);
        assert_eq!(marker_pin_centre_px(0.0, 480.0), 8.0);
        assert_eq!(marker_pin_centre_px(1.0, 480.0), 472.0);
        assert_eq!(marker_pin_centre_px(0.5, 480.0), 240.0);
        assert_eq!(marker_pin_centre_px(f64::NAN, 480.0), 8.0);
    }

    #[test]
    fn the_view_says_what_covers_the_picture_and_what_the_controls_show() {
        let markers = [marker("a", 65.0, Some("Intro")), marker("b", 65.2, None)];
        let base = |status: &PlaybackStatus, connected: bool, available: bool| {
            player_view(&PlayerInput {
                status,
                connected,
                markers: &markers,
                scrub_ms: None,
                track_width_px: 600.0,
                available,
            })
        };
        // Loading: closed or opening, connected.
        let view = base(&status(PlaybackState::Closed, 0, 0), true, true);
        assert!(view.loading && !view.ready);
        assert_eq!(view.status_title, "");
        assert!(view.pins.is_empty());
        // Playing: the controls, the pins, the labels.
        let playing = status(PlaybackState::Playing, 125_000, 2_470_000);
        let view = base(&playing, true, true);
        assert!(view.ready && view.playing && !view.loading);
        assert_eq!(view.position_text, "2:05");
        assert_eq!(view.duration_text, "41:10");
        assert_eq!(view.time_chars, 5);
        assert_eq!(view.slider_max, 2_470_000.0);
        assert_eq!(view.slider_value, 125_000.0);
        assert_eq!(view.playhead_value, "2:05 of 41:10");
        assert_eq!(view.toggle_label, "Pause");
        assert_eq!(view.mute_label, "Mute");
        assert_eq!(view.pins.len(), 1);
        assert!(view.pins[0].several);
        assert_eq!(view.pins[0].label, "2 markers near 1:05");
        assert_eq!(view.pins[0].entries[1].2, "Untitled marker");
        // A drag shows the scrubbed time.
        let dragged = player_view(&PlayerInput {
            status: &playing,
            connected: true,
            markers: &markers,
            scrub_ms: Some(600_000.0),
            track_width_px: 600.0,
            available: true,
        });
        assert_eq!(dragged.position_text, "10:00");
        // Paused and muted, with hours.
        let mut paused = status(PlaybackState::Paused, 61_000, 7_200_000);
        paused.muted = true;
        let view = base(&paused, true, true);
        assert_eq!(view.toggle_label, "Play");
        assert_eq!(view.mute_label, "Unmute");
        assert_eq!(view.position_text, "0:01:01");
        assert_eq!(view.time_chars, 7);
        // Two hours wide, the two markers still share a pin; alone, the
        // marker is its own pin named after itself.
        assert_eq!(view.pins[0].label, "2 markers near 1:05");
        let alone = player_view(&PlayerInput {
            status: &paused,
            connected: true,
            markers: &markers[..1],
            scrub_ms: None,
            track_width_px: 600.0,
            available: true,
        });
        assert!(!alone.pins[0].several);
        assert_eq!(alone.pins[0].label, "Intro · 1:05");
        assert_eq!(alone.pins[0].tooltip, "1:05 · Intro");
        // Refused: no retry; an MKV offers the other player and the file.
        let mut refused = status(PlaybackState::Failed, 0, 0);
        refused.refusal = Some(PlaybackRefusal::NotMp4);
        let view = base(&refused, true, true);
        assert_eq!(view.status_title, "Not playable here");
        assert!(!view.retry && view.open_externally && view.reveal && !view.ready);
        refused.refusal = Some(PlaybackRefusal::NotReady);
        let view = base(&refused, true, true);
        assert_eq!(
            view.status_description,
            "Playback opens as soon as the recording is finished."
        );
        assert!(!view.open_externally && !view.reveal);
        // Failed: the backend's words, Try again and the other player.
        let mut failed = status(PlaybackState::Failed, 0, 0);
        failed.message = Some("This recording couldn't be decoded.".into());
        let view = base(&failed, true, true);
        assert_eq!(view.status_title, "Playback failed");
        assert_eq!(
            view.status_description,
            "This recording couldn't be decoded."
        );
        assert!(view.retry && view.open_externally && !view.reveal);
        // Not connected, and no element on this platform.
        let view = base(&status(PlaybackState::Closed, 0, 0), false, true);
        assert_eq!(view.status_description, ENGINE_NOT_CONNECTED);
        assert!(view.retry);
        let view = base(&playing, true, false);
        assert_eq!(view.status_description, NOT_IN_THIS_WINDOW);
        assert!(!view.ready && !view.retry && view.open_externally);
        assert_eq!(media_error_copy(Some(4)), "This recording can't play here.");
        assert_eq!(media_error_copy(None), "Playback failed.");
    }

    /// A backend that answers from a script and records the calls.
    struct Scripted {
        calls: std::sync::Mutex<Vec<String>>,
        duration_ms: u64,
        open_state: PlaybackState,
    }

    impl Scripted {
        fn new(open_state: PlaybackState) -> Self {
            Self {
                calls: std::sync::Mutex::new(Vec::new()),
                duration_ms: 60_000,
                open_state,
            }
        }

        fn answer(&self, call: String, state: PlaybackState, at: u64) -> PlaybackStatus {
            self.calls.lock().unwrap().push(call);
            let mut answer = status(state, at, self.duration_ms);
            answer.session_id = Some("s1".into());
            answer
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl PlaybackBackend for Scripted {
        async fn open(&self, params: PlaybackOpenParams) -> Result<PlaybackStatus, RpcError> {
            let call = format!("open {} {:?}", params.session_id, params.max_width);
            Ok(self.answer(call, self.open_state, 0))
        }
        async fn play(&self) -> Result<PlaybackStatus, RpcError> {
            Ok(self.answer("play".into(), PlaybackState::Playing, 0))
        }
        async fn pause(&self) -> Result<PlaybackStatus, RpcError> {
            Ok(self.answer("pause".into(), PlaybackState::Paused, 0))
        }
        async fn seek(&self, position_ms: u64) -> Result<PlaybackStatus, RpcError> {
            let call = format!("seek {position_ms}");
            Ok(self.answer(call, PlaybackState::Paused, position_ms))
        }
        async fn mute(&self, muted: bool) -> Result<PlaybackStatus, RpcError> {
            Ok(self.answer(format!("mute {muted}"), PlaybackState::Paused, 0))
        }
        async fn close(&self) -> Result<PlaybackStatus, RpcError> {
            Ok(self.answer("close".into(), PlaybackState::Closed, 0))
        }
    }

    fn of(state: PlaybackState, at: u64, session: &str) -> PlaybackStatus {
        let mut status = status(state, at, 60_000);
        status.session_id = Some(session.into());
        status
    }

    /// Electron #1493 (QA F18): a re-open after a failure, and Retry, pick
    /// up where the recording was and whether it played.
    #[tokio::test]
    async fn a_reopen_keeps_the_position_and_the_play_state() {
        let mut session = PlayerSession::new("s1");
        assert_eq!(
            session.note(&of(PlaybackState::Playing, 12_000, "s1")),
            None
        );
        // Another recording's status is not this one's.
        assert_eq!(session.note(&of(PlaybackState::Paused, 50_000, "s2")), None);
        let failed = status(PlaybackState::Failed, 0, 0);
        let resume = session.note(&failed).expect("one silent re-open");
        assert_eq!(
            resume,
            Resume {
                at_ms: 12_000,
                playing: true
            }
        );
        // A second failure is shown, with Retry.
        assert_eq!(session.note(&failed), None);
        let backend = Scripted::new(PlaybackState::Paused);
        let opened = session
            .open(&backend, Some((1280, 720)), Some(resume))
            .await
            .unwrap();
        assert_eq!(opened.state, PlaybackState::Playing);
        assert_eq!(
            backend.calls(),
            ["open s1 Some(1280)", "seek 12000", "play"]
        );

        // Retry re-arms the silent re-open and keeps the place.
        assert_eq!(
            session.retry(),
            Resume {
                at_ms: 12_000,
                playing: true
            }
        );
        assert!(session.note(&failed).is_some());

        // A refusal is never retried silently.
        let mut refused = failed.clone();
        refused.refusal = Some(PlaybackRefusal::NotReady);
        assert_eq!(PlayerSession::new("s1").note(&refused), None);
    }

    #[tokio::test]
    async fn a_fresh_open_starts_from_the_top_and_a_refusal_is_left_alone() {
        let session = PlayerSession::new("s1");
        let backend = Scripted::new(PlaybackState::Paused);
        session.open(&backend, None, None).await.unwrap();
        assert_eq!(backend.calls(), ["open s1 None"]);
        let paused_at_zero = Resume {
            at_ms: 0,
            playing: false,
        };
        session
            .open(&backend, None, Some(paused_at_zero))
            .await
            .unwrap();
        assert_eq!(backend.calls(), ["open s1 None", "open s1 None"]);
        let refused = Scripted::new(PlaybackState::Failed);
        let resume = Resume {
            at_ms: 5_000,
            playing: true,
        };
        session.open(&refused, None, Some(resume)).await.unwrap();
        assert_eq!(refused.calls(), ["open s1 None"]);
        // The end: a seek clamps to the recording.
        let backend = Scripted::new(PlaybackState::Paused);
        seek_to(&backend, 90_000.4, 60_000).await.unwrap();
        seek_to(&backend, -3.0, 60_000).await.unwrap();
        assert_eq!(backend.calls(), ["seek 60000", "seek 0"]);
    }

    /// The player's words are still Electron's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let sources = [
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/media/session-player.tsx"
            ),
            include_str!("../../../../apps/desktop/src/renderer/src/lib/session-player-view.ts"),
            include_str!(
                "../../../../apps/desktop/src/renderer/src/components/media/marker-pins.tsx"
            ),
        ];
        let this = include_str!("player.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = super::super::copy::tests::unseen_constants(this, &sources);
        assert!(
            checked >= 12,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
    }
}
