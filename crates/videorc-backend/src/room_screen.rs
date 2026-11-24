//! Plan 260 S1.8c c3: the host's screen in the backend's room, behind Hide
//! screen, on the renderer room's wire contract (plan 249 S2, S14).
//!
//! The room shares the screen or window `cloud.room.screen.set` names by its
//! native source id: the preview screen's frames while it runs that source
//! (the scene's own), else the room's own capture of it (c4b, one the host
//! picked on the stage), whose store holds the same Hide screen gate. Every privacy change and every new source is a fresh
//! publication named `vrc-privacy:<epoch>:<generation>:<hidden>`, announced
//! first on the privacy topic so receivers drop cached pictures. While hidden
//! the track carries neutral grey frames (`#808080`) and the screen is never
//! read; receivers draw the designed still over the grey and acknowledge it
//! on the acknowledgement topic. The status (hiding, then observed or
//! unconfirmed after 5 s; visible; paused) goes to the Studio on
//! `cloud.room.presentation`'s `media` entry.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use livekit::options::{VideoCodec, VideoEncoding};
use livekit::prelude::{
    DataPacket, LocalTrack, LocalVideoTrack, Room, TrackPublishOptions, TrackSid, TrackSource,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::cloud_talk::{RoomScreenPrivacyState, RoomScreenSettings, RoomScreenStatus};
use crate::state::AppState;

pub(crate) const PRIVACY_TOPIC: &str = "videorc.screen-privacy.v1";
pub(crate) const PRIVACY_ACK_TOPIC: &str = "videorc.screen-privacy.ack.v1";
/// The renderer's bound on one acknowledgement.
pub(crate) const PRIVACY_ACK_MAX_BYTES: usize = 2048;
const RECORDER_IDENTITY_PREFIX: &str = "EG_";
/// The renderer's capture asked for 1920 x 1080 at 30 fps, 4 Mbps, no
/// simulcast, so shared text stays crisp.
const SCREEN_MAX: (u32, u32) = (1920, 1080);
const SCREEN_BITRATE: u64 = 4_000_000;
const SCREEN_FPS: f64 = 30.0;
/// How long a hide waits for acknowledgements before it says unconfirmed.
const CONFIRM_AFTER: Duration = Duration::from_secs(5);
/// `#808080` as I420 (libyuv's BT.601 limited range): what a hidden screen
/// carries on the wire.
const FROST_Y: u8 = 126;
const FROST_CHROMA: u8 = 128;

/// The screen the Studio wants shared, and how often it asked (a paused share
/// waits for the next ask).
static SCREEN: StdMutex<(Option<RoomScreenSettings>, u64)> = StdMutex::new((None, 0));
static SCREEN_CHANGED: Notify = Notify::const_new();

fn screen() -> (Option<RoomScreenSettings>, u64) {
    SCREEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// `cloud.room.screen.set`.
pub(crate) fn set_screen(settings: Option<RoomScreenSettings>) {
    {
        let mut screen = SCREEN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        screen.0 = settings;
        screen.1 = screen.1.wrapping_add(1);
    }
    SCREEN_CHANGED.notify_waiters();
}

/// A hold ended.
pub(crate) fn clear() {
    set_screen(None);
}

/// What the room host hands the screen task.
pub(crate) enum ScreenSignal {
    /// A data message on [`PRIVACY_ACK_TOPIC`].
    Ack(Vec<u8>),
    /// A participant left.
    Left(String),
    /// The connection is reconnecting: no acknowledgement stands.
    Reconnecting,
}

pub(crate) fn track_name(epoch: &str, generation: u64, hidden: bool) -> String {
    format!("vrc-privacy:{epoch}:{generation}:{}", u8::from(hidden))
}

/// A receiver's acknowledgement of this publication's frost (the renderer's
/// `privacyObservationMatches`): who applied it, its session, and when.
pub(crate) fn observation(
    payload: &[u8],
    epoch: &str,
    generation: u64,
) -> Option<(String, Option<String>, i64)> {
    if payload.len() > PRIVACY_ACK_MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(payload).ok()?;
    let matches = value.get("epoch")?.as_str()? == epoch
        && value.get("generation")?.as_u64()? == generation
        && value.get("hidden")?.as_bool()?;
    let receiver = value.get("receiver")?.as_str()?.to_string();
    let session = value
        .get("receiverSession")
        .and_then(Value::as_str)
        .map(str::to_string);
    let applied_at = value.get("appliedAt")?.as_i64()?;
    (matches && applied_at > 0 && applied_at <= 9_007_199_254_740_991)
        .then_some((receiver, session, applied_at))
}

/// Who may acknowledge, as the renderer's room admits them: a program page
/// by its receiver name, or a guest in the room now, named with its current
/// session.
pub(crate) fn receiver_admitted(
    receiver: &str,
    session: Option<&str>,
    visible: &std::collections::HashMap<String, String>,
) -> bool {
    let program = receiver
        .strip_prefix("program:")
        .is_some_and(|rest| matches!(rest, "wide" | "tall" | "wide:recording" | "tall:recording"));
    program
        || session.is_some_and(|session| visible.get(receiver).is_some_and(|sid| sid == session))
}

/// A participant left: its acknowledgement goes, and a recorder takes the
/// program pages' with it. A hidden screen is unconfirmed again.
pub(crate) fn participant_left(status: &mut RoomScreenStatus, identity: &str) {
    status.observations.remove(identity);
    if identity.starts_with(RECORDER_IDENTITY_PREFIX) {
        status
            .observations
            .retain(|receiver, _| !receiver.starts_with("program:"));
    }
    if status.hidden {
        status.status = RoomScreenPrivacyState::Unconfirmed;
    }
}

fn new_epoch() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A hidden screen's frame: neutral grey, never read from the screen.
fn frost_frame((width, height): (u32, u32)) -> I420Buffer {
    let mut buffer = I420Buffer::new(width, height);
    let (y, u, v) = buffer.data_mut();
    y.fill(FROST_Y);
    u.fill(FROST_CHROMA);
    v.fill(FROST_CHROMA);
    buffer
}

/// A live BGRA screen frame as I420 within 1920 x 1080.
fn screen_frame(bgra: &[u8], width: u32, height: u32) -> Option<(I420Buffer, (u32, u32))> {
    if width < 2 || height < 2 || bgra.len() < width as usize * height as usize * 4 {
        return None;
    }
    let size = crate::room_media::fit_within(width, height, SCREEN_MAX)?;
    let mut full = I420Buffer::new(width, height);
    let (stride_y, stride_u, stride_v) = full.strides();
    let (y, u, v) = full.data_mut();
    // BGRA in memory is libyuv's ARGB.
    yuv_helper::argb_to_i420(
        bgra,
        width * 4,
        y,
        stride_y,
        u,
        stride_u,
        v,
        stride_v,
        width as i32,
        height as i32,
    );
    if size == (width, height) {
        return Some((full, size));
    }
    Some((full.scale(size.0 as i32, size.1 as i32), size))
}

/// The publication this task holds: which source, hidden or not, which span
/// of the gate; the track once a frame went out.
struct Publication {
    key: (String, bool, u64),
    track: Option<(TrackSid, NativeVideoSource)>,
}

async fn unpublish(room: &Room, current: &mut Option<Publication>) {
    if let Some(Publication {
        track: Some((sid, _)),
        ..
    }) = current.take()
        && let Err(error) = room.local_participant().unpublish_track(&sid).await
    {
        tracing::warn!("The backend could not take the room screen off: {error}");
    }
}

async fn publish(
    room: &Room,
    name: String,
    (width, height): (u32, u32),
) -> anyhow::Result<(TrackSid, NativeVideoSource)> {
    let source = NativeVideoSource::new(VideoResolution { width, height }, true);
    let track = LocalVideoTrack::create_video_track(&name, RtcVideoSource::Native(source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: VideoCodec::VP8,
        simulcast: false,
        video_encoding: Some(VideoEncoding {
            max_bitrate: SCREEN_BITRATE,
            max_framerate: SCREEN_FPS,
        }),
        ..Default::default()
    };
    let publication = room
        .local_participant()
        .publish_track(LocalTrack::Video(track), options)
        .await?;
    Ok((publication.sid(), source))
}

/// Tell receivers a new publication comes (they drop cached pictures). Not
/// an acknowledgement.
async fn announce(room: &Room, epoch: &str, generation: u64, hidden: bool) {
    let payload = json!({ "epoch": epoch, "generation": generation, "hidden": hidden });
    let packet = DataPacket {
        payload: payload.to_string().into_bytes(),
        topic: Some(PRIVACY_TOPIC.to_string()),
        reliable: true,
        ..DataPacket::default()
    };
    if let Err(error) = room.local_participant().publish_data(packet).await {
        tracing::warn!("The screen privacy notice did not reach the room: {error}");
    }
}

fn report(state: &AppState, show_id: &str, status: Option<&RoomScreenStatus>) {
    let status = status.cloned();
    crate::room_media::update_media(state, show_id, |media| media.screen = status);
}

/// One connection's screen. Ends when `done` fires, or a sender drops (the
/// connection ended), taking the screen off first.
pub(crate) async fn run_screen(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut signals: mpsc::UnboundedReceiver<ScreenSignal>,
    mut done: oneshot::Receiver<()>,
) {
    let started = Instant::now();
    let mut epoch = new_epoch();
    let mut generation = 0u64;
    let mut current: Option<Publication> = None;
    let mut status: Option<RoomScreenStatus> = None;
    let mut confirm_at: Option<Instant> = None;
    let mut paused_ask: Option<u64> = None;
    let mut last_size: Option<(u32, u32)> = None;
    let mut last_frame: Option<(u64, u64)> = None;
    // c4b: the room's own capture of a source the preview does not run, and
    // a start that failed (not retried until the Studio asks again).
    let mut own_capture: Option<(String, crate::preview_screen::RoomScreenCapture)> = None;
    let mut capture_failed: Option<(String, u64, String)> = None;
    let mut pulse = tokio::time::interval(Duration::from_secs_f64(1.0 / SCREEN_FPS));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            signal = signals.recv() => {
                match signal {
                    None => break,
                    Some(ScreenSignal::Ack(payload)) => {
                        let visible: std::collections::HashMap<String, String> = room
                            .remote_participants()
                            .values()
                            .map(|participant| {
                                (
                                    participant.identity().as_str().to_string(),
                                    participant.sid().as_str().to_string(),
                                )
                            })
                            .collect();
                        if let Some(screen) = status.as_mut().filter(|screen| screen.hidden)
                            && let Some((receiver, session, applied_at)) =
                                observation(&payload, &screen.epoch, screen.generation)
                            && receiver_admitted(&receiver, session.as_deref(), &visible)
                        {
                            screen.observations.insert(receiver, applied_at);
                            screen.status = RoomScreenPrivacyState::Observed;
                            report(&state, &show_id, status.as_ref());
                        }
                    }
                    Some(ScreenSignal::Left(identity)) => {
                        if let Some(screen) = status.as_mut() {
                            participant_left(screen, &identity);
                            report(&state, &show_id, status.as_ref());
                        }
                    }
                    Some(ScreenSignal::Reconnecting) => {
                        if let Some(screen) = status.as_mut() {
                            screen.observations.clear();
                            if screen.hidden {
                                screen.status = RoomScreenPrivacyState::Unconfirmed;
                            }
                            report(&state, &show_id, status.as_ref());
                        }
                    }
                }
                continue;
            }
            _ = pulse.tick() => {}
            _ = SCREEN_CHANGED.notified() => {}
        }
        // A hide waits 5 s for acknowledgements.
        if let Some(at) = confirm_at
            && Instant::now() >= at
        {
            confirm_at = None;
            if let Some(screen) = status
                .as_mut()
                .filter(|screen| screen.status == RoomScreenPrivacyState::Hiding)
            {
                screen.status = if screen.observations.is_empty() {
                    RoomScreenPrivacyState::Unconfirmed
                } else {
                    RoomScreenPrivacyState::Observed
                };
                report(&state, &show_id, status.as_ref());
            }
        }
        let (wanted, ask) = screen();
        let Some(wanted) = wanted.filter(RoomScreenSettings::valid) else {
            unpublish(&room, &mut current).await;
            own_capture = None;
            capture_failed = None;
            paused_ask = None;
            if status.take().is_some() {
                report(&state, &show_id, None);
            }
            continue;
        };
        // Paused: until the Studio asks again.
        if paused_ask == Some(ask) {
            continue;
        }
        paused_ask = None;
        let view = state.screen_privacy.view();
        let preview = crate::preview_screen::preview_screen_frame_source(&state).await;
        let preview_runs_it = preview
            .as_ref()
            .and_then(|source| source.source_key())
            .is_some_and(|key| key.id == wanted.source_id);
        // c4b: a screen or window the preview does not run (one the host
        // picked on the stage) gets the room's own capture.
        if preview_runs_it {
            own_capture = None;
            capture_failed = None;
        } else if own_capture
            .as_ref()
            .is_none_or(|(source_id, _)| *source_id != wanted.source_id)
        {
            own_capture = None;
            let tried = capture_failed
                .as_ref()
                .is_some_and(|(source_id, failed_ask, _)| {
                    *source_id == wanted.source_id && *failed_ask == ask
                });
            if !tried {
                match crate::preview_screen::RoomScreenCapture::start(&state, &wanted.source_id)
                    .await
                {
                    Ok(capture) => {
                        own_capture = Some((wanted.source_id.clone(), capture));
                        capture_failed = None;
                    }
                    Err(message) => {
                        tracing::warn!("The room's own screen capture did not start: {message}");
                        capture_failed = Some((wanted.source_id.clone(), ask, message));
                    }
                }
            }
        }
        let frame_source = if preview_runs_it {
            preview.as_ref()
        } else {
            own_capture
                .as_ref()
                .map(|(_, capture)| capture.frame_source())
        };
        if frame_source.is_none() {
            unpublish(&room, &mut current).await;
            let reason = capture_failed
                .as_ref()
                .map(|(_, _, message)| message.clone())
                .unwrap_or_else(|| "The room's screen did not start.".to_string());
            if status.as_ref().is_none_or(|screen| {
                screen.published || screen.reason.as_deref() != Some(reason.as_str())
            }) {
                status = Some(RoomScreenStatus {
                    source_id: wanted.source_id.clone(),
                    epoch: epoch.clone(),
                    generation,
                    hidden: view.hidden,
                    published: false,
                    source_blocked_at: None,
                    status: if view.hidden {
                        RoomScreenPrivacyState::Unconfirmed
                    } else {
                        RoomScreenPrivacyState::Visible
                    },
                    observations: BTreeMap::new(),
                    reason: Some(reason),
                });
                report(&state, &show_id, status.as_ref());
            }
            continue;
        }
        // The live frame's pixels, taken now (never while hidden: the screen
        // is not read), and the preview handle let go before any wait.
        let taken = if view.hidden {
            None
        } else {
            frame_source.and_then(|source| {
                let generation = source.generation();
                let frame = source.latest_frame_blocking()?;
                let key = (generation, frame.sequence);
                if last_frame == Some(key) {
                    return None;
                }
                let bytes = if frame.bytes.is_empty() {
                    let surface = frame.source_iosurface.as_ref()?;
                    crate::screen_privacy::macos::read_bgra_from_iosurface(
                        surface,
                        frame.width,
                        frame.height,
                    )?
                } else {
                    frame.bytes.clone()
                };
                Some((key, bytes, frame.width, frame.height))
            })
        };
        // A fresh publication for a new source, a hide or a show.
        let key = (wanted.source_id.clone(), view.hidden, view.span);
        if current
            .as_ref()
            .is_none_or(|publication| publication.key != key)
        {
            let new_source = current
                .as_ref()
                .is_none_or(|publication| publication.key.0 != key.0);
            unpublish(&room, &mut current).await;
            if new_source {
                epoch = new_epoch();
                last_size = None;
            }
            generation += 1;
            announce(&room, &epoch, generation, view.hidden).await;
            status = Some(RoomScreenStatus {
                source_id: wanted.source_id.clone(),
                epoch: epoch.clone(),
                generation,
                hidden: view.hidden,
                published: false,
                source_blocked_at: view.hidden.then(now_ms),
                status: if view.hidden {
                    RoomScreenPrivacyState::Hiding
                } else {
                    RoomScreenPrivacyState::Visible
                },
                observations: BTreeMap::new(),
                reason: None,
            });
            confirm_at = view.hidden.then(|| Instant::now() + CONFIRM_AFTER);
            current = Some(Publication { key, track: None });
            report(&state, &show_id, status.as_ref());
        }
        // The frame: grey while hidden, else the live frame as I420.
        let framed = if view.hidden {
            let size = last_size.unwrap_or(SCREEN_MAX);
            Some((frost_frame(size), size))
        } else {
            match taken {
                Some((key, bytes, width, height)) => {
                    last_frame = Some(key);
                    tokio::task::spawn_blocking(move || screen_frame(&bytes, width, height))
                        .await
                        .ok()
                        .flatten()
                }
                None => None,
            }
        };
        let Some((buffer, size)) = framed else {
            continue;
        };
        // The gate moved while the frame was made: it never goes out.
        let now = state.screen_privacy.view();
        if now.hidden != view.hidden || now.span != view.span {
            continue;
        }
        if !view.hidden {
            last_size = Some(size);
        }
        let Some(publication) = current.as_mut() else {
            continue;
        };
        if publication.track.is_none() {
            match publish(&room, track_name(&epoch, generation, view.hidden), size).await {
                Ok(track) => {
                    publication.track = Some(track);
                    if let Some(screen) = status.as_mut() {
                        screen.published = true;
                    }
                    report(&state, &show_id, status.as_ref());
                }
                Err(error) => {
                    tracing::warn!("The backend could not publish the room screen: {error:#}");
                    unpublish(&room, &mut current).await;
                    paused_ask = Some(ask);
                    if let Some(screen) = status.as_mut() {
                        screen.status = RoomScreenPrivacyState::Paused;
                        screen.published = false;
                        screen.reason = Some(
                            "Screen share paused: the room did not take it. Share the screen again to retry."
                                .to_string(),
                        );
                    }
                    report(&state, &show_id, status.as_ref());
                    continue;
                }
            }
        }
        // Re-checked after the publish's await too.
        let now = state.screen_privacy.view();
        if now.hidden != view.hidden || now.span != view.span {
            continue;
        }
        if let Some((_, source)) = current
            .as_ref()
            .and_then(|publication| publication.track.as_ref())
        {
            source.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: started.elapsed().as_micros() as i64,
                frame_metadata: None,
                buffer,
            });
        }
    }
    unpublish(&room, &mut current).await;
    report(&state, &show_id, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden_status() -> RoomScreenStatus {
        RoomScreenStatus {
            source_id: "screen:screencapturekit:1".to_string(),
            epoch: "e".repeat(32),
            generation: 3,
            hidden: true,
            published: true,
            source_blocked_at: Some(1),
            status: RoomScreenPrivacyState::Observed,
            observations: BTreeMap::from([
                ("guest:a".to_string(), 10),
                ("program:h".to_string(), 11),
                ("program:v".to_string(), 12),
            ]),
            reason: None,
        }
    }

    #[test]
    fn the_track_is_named_as_the_renderer_names_it() {
        assert_eq!(track_name("abc", 7, true), "vrc-privacy:abc:7:1");
        assert_eq!(track_name("abc", 8, false), "vrc-privacy:abc:8:0");
    }

    #[test]
    fn only_this_publications_frost_counts() {
        let ack = |epoch: &str, generation: u64, hidden: bool, applied: Value| {
            json!({
                "epoch": epoch, "generation": generation, "hidden": hidden,
                "receiver": "guest:a", "appliedAt": applied
            })
            .to_string()
            .into_bytes()
        };
        assert_eq!(
            observation(&ack("e1", 2, true, json!(1700)), "e1", 2),
            Some(("guest:a".to_string(), None, 1700))
        );
        assert_eq!(observation(&ack("e0", 2, true, json!(1700)), "e1", 2), None);
        assert_eq!(observation(&ack("e1", 1, true, json!(1700)), "e1", 2), None);
        assert_eq!(
            observation(&ack("e1", 2, false, json!(1700)), "e1", 2),
            None
        );
        assert_eq!(observation(&ack("e1", 2, true, json!(0)), "e1", 2), None);
        assert_eq!(observation(&ack("e1", 2, true, json!(1.5)), "e1", 2), None);
        assert_eq!(observation(b"not json", "e1", 2), None);
    }

    #[test]
    fn only_program_pages_and_current_guest_sessions_acknowledge() {
        let visible =
            std::collections::HashMap::from([("g_ada".to_string(), "PA_ada_now".to_string())]);
        for program in ["program:wide", "program:tall", "program:wide:recording"] {
            assert!(receiver_admitted(program, None, &visible), "{program}");
        }
        assert!(!receiver_admitted("program:square", None, &visible));
        assert!(receiver_admitted("g_ada", Some("PA_ada_now"), &visible));
        assert!(!receiver_admitted("g_ada", Some("PA_ada_before"), &visible));
        assert!(!receiver_admitted("g_ada", None, &visible));
        assert!(!receiver_admitted("g_gone", Some("PA_gone"), &visible));
        let big = vec![b' '; PRIVACY_ACK_MAX_BYTES + 1];
        assert_eq!(observation(&big, "e1", 2), None);
    }

    #[test]
    fn a_guest_leaving_takes_its_acknowledgement() {
        let mut status = hidden_status();
        participant_left(&mut status, "guest:a");
        assert_eq!(status.observations.len(), 2);
        assert_eq!(status.status, RoomScreenPrivacyState::Unconfirmed);
    }

    #[test]
    fn a_recorder_leaving_takes_the_program_pages() {
        let mut status = hidden_status();
        participant_left(&mut status, "EG_abc");
        assert_eq!(
            status.observations.keys().collect::<Vec<_>>(),
            vec!["guest:a"]
        );
    }

    #[test]
    fn a_hidden_screen_is_neutral_grey() {
        // `#808080` through the same conversion the live screen takes.
        let grey = [0x80u8, 0x80, 0x80, 0xff].repeat(4);
        let mut converted = I420Buffer::new(2, 2);
        let (stride_y, stride_u, stride_v) = converted.strides();
        let (y, u, v) = converted.data_mut();
        yuv_helper::argb_to_i420(&grey, 8, y, stride_y, u, stride_u, v, stride_v, 2, 2);
        let mut frost = frost_frame((2, 2));
        let (fy, fu, fv) = frost.data_mut();
        assert_eq!((y[0], u[0], v[0]), (fy[0], fu[0], fv[0]));
        assert_eq!(fy.len(), 4);
    }

    #[test]
    fn a_big_screen_goes_out_within_1080p() {
        let bgra = [10u8, 20, 30, 255].repeat(3840 * 2160);
        let (_, size) = screen_frame(&bgra, 3840, 2160).unwrap();
        assert_eq!(size, (1920, 1080));
        let small = [10u8, 20, 30, 255].repeat(1280 * 800);
        let (_, size) = screen_frame(&small, 1280, 800).unwrap();
        assert_eq!(size, (1280, 800));
    }
}
