//! Plan 260 S1.8d d1: the room's other people, back as preview feeds, in the
//! backend's room. The renderer's room client subscribed to every guest
//! publication and to the runner's return only while the Program monitor
//! wanted it (`#applySubscriptions`), then handed the tracks to the stage
//! (`#publish()`). Here the backend subscribes the same way, decodes each
//! remote video track into a latest-frame store the Studio polls at
//! `/room/remote/latest.bmp` (the HTML overlay route's dialect), and reports
//! the people (camera, screen, microphone, speaking, quality) and the
//! monitor on `cloud.room.presentation`'s media entry. Audio playback (d3),
//! the captions mix (d4) and the monitor's audio (d5) build on it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use livekit::prelude::{
    ConnectionQuality, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent,
    TrackKind, TrackSource,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::cloud_talk::{RoomRemoteMonitor, RoomRemotePerson};
use crate::state::AppState;

const RUNNER_IDENTITY_PREFIX: &str = "runner:";
const RECORDER_IDENTITY_PREFIX: &str = "EG_";
/// A camera reaches the stage at up to 720p, a shared screen (text) and the
/// program at up to 1080p, at most 30 frames a second.
const CAMERA_MAX: (u32, u32) = (1280, 720);
const SCREEN_MAX: (u32, u32) = (1920, 1080);
const FRAME_GAP: Duration = Duration::from_millis(33);

/// One remote picture: its track (generation) and frame number (sequence).
#[derive(Debug, Clone)]
pub(crate) struct RemoteFrame {
    pub(crate) generation: String,
    pub(crate) sequence: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bgra: Arc<Vec<u8>>,
}

/// By `(identity, source)`: `camera`, `screen`, or `monitor` (the runner).
static FRAMES: StdMutex<BTreeMap<(String, String), RemoteFrame>> = StdMutex::new(BTreeMap::new());
static MONITOR: AtomicBool = AtomicBool::new(false);
static MONITOR_CHANGED: Notify = Notify::const_new();

fn frames() -> std::sync::MutexGuard<'static, BTreeMap<(String, String), RemoteFrame>> {
    FRAMES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The latest picture of one person's camera or screen, or the monitor's
/// (by its source alone: the Studio does not know the runner's identity).
pub(crate) fn latest(identity: &str, source: &str) -> Option<RemoteFrame> {
    let frames = frames();
    if source == "monitor" {
        return frames
            .iter()
            .find(|((_, kind), _)| kind == "monitor")
            .map(|(_, frame)| frame.clone());
    }
    frames
        .get(&(identity.to_string(), source.to_string()))
        .cloned()
}

/// `cloud.room.monitor.set`: the Program monitor shows the runner's return.
pub(crate) fn set_monitor(enabled: bool) {
    MONITOR.store(enabled, Ordering::Release);
    MONITOR_CHANGED.notify_waiters();
}

/// A hold ended.
pub(crate) fn clear() {
    MONITOR.store(false, Ordering::Release);
    frames().clear();
}

fn is_runner(identity: &str) -> bool {
    identity.starts_with(RUNNER_IDENTITY_PREFIX)
}

/// Whether the host takes this participant's publications (the renderer's
/// `#applySubscriptions`): every guest's; the runner's only with the
/// monitor; never an egress page's.
pub(crate) fn wants(identity: &str, monitor: bool) -> bool {
    !identity.starts_with(RECORDER_IDENTITY_PREFIX) && (!is_runner(identity) || monitor)
}

/// The store key a video publication's frames go under, or None.
pub(crate) fn video_source(identity: &str, source: TrackSource) -> Option<&'static str> {
    if is_runner(identity) {
        return Some("monitor");
    }
    match source {
        TrackSource::Camera => Some("camera"),
        TrackSource::Screenshare => Some("screen"),
        _ => None,
    }
}

/// A size within `max`, never scaled up, even on both sides.
pub(crate) fn fit(width: u32, height: u32, max: (u32, u32)) -> (u32, u32) {
    let scale = (f64::from(max.0) / f64::from(width.max(1)))
        .min(f64::from(max.1) / f64::from(height.max(1)))
        .min(1.0);
    let even = |value: f64| ((((value + 1e-6) / 2.0).floor() as u32) * 2).max(2);
    (
        even(f64::from(width) * scale),
        even(f64::from(height) * scale),
    )
}

fn quality_name(quality: ConnectionQuality) -> &'static str {
    match quality {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

/// Decodes one remote video track into the store until it ends.
async fn decode(
    identity: String,
    source: &'static str,
    generation: String,
    track: livekit::prelude::RemoteVideoTrack,
) {
    let max = if source == "camera" {
        CAMERA_MAX
    } else {
        SCREEN_MAX
    };
    let key = (identity, source.to_string());
    let mut stream = NativeVideoStream::new(track.rtc_track());
    let mut sequence = 0u64;
    let mut last: Option<Instant> = None;
    while let Some(frame) = stream.next().await {
        if last.is_some_and(|at| at.elapsed() < FRAME_GAP) {
            continue;
        }
        last = Some(Instant::now());
        let mut i420 = frame.buffer.to_i420();
        let (width, height) = (
            livekit::webrtc::prelude::VideoBuffer::width(&i420),
            livekit::webrtc::prelude::VideoBuffer::height(&i420),
        );
        if width < 2 || height < 2 {
            continue;
        }
        let (out_width, out_height) = fit(width, height, max);
        if (out_width, out_height) != (width, height) {
            i420 = i420.scale(out_width as i32, out_height as i32);
        }
        let (stride_y, stride_u, stride_v) = i420.strides();
        let (y, u, v) = i420.data();
        let mut bgra = vec![0u8; out_width as usize * out_height as usize * 4];
        // libyuv's ARGB is BGRA in memory.
        yuv_helper::i420_to_argb(
            y,
            stride_y,
            u,
            stride_u,
            v,
            stride_v,
            &mut bgra,
            out_width * 4,
            out_width as i32,
            out_height as i32,
        );
        sequence += 1;
        frames().insert(
            key.clone(),
            RemoteFrame {
                generation: generation.clone(),
                sequence,
                width: out_width,
                height: out_height,
                bgra: Arc::new(bgra),
            },
        );
    }
    let mut frames = frames();
    if frames
        .get(&key)
        .is_some_and(|frame| frame.generation == generation)
    {
        frames.remove(&key);
    }
}

fn subscribe_all(room: &Room, monitor: bool) {
    for participant in room.remote_participants().values() {
        let want = wants(participant.identity().as_str(), monitor);
        for publication in participant.track_publications().values() {
            if publication.is_subscribed() != want {
                publication.set_subscribed(want);
            }
        }
    }
}

fn start_decoding(
    decoders: &mut HashMap<String, JoinHandle<()>>,
    track: RemoteTrack,
    publication: &RemoteTrackPublication,
    participant: &RemoteParticipant,
) {
    let RemoteTrack::Video(video) = track else {
        return;
    };
    let identity = participant.identity().as_str().to_string();
    let Some(source) = video_source(&identity, publication.source()) else {
        return;
    };
    let sid = publication.sid().as_str().to_string();
    if let Some(old) = decoders.remove(&sid) {
        old.abort();
    }
    decoders.insert(
        sid.clone(),
        tokio::spawn(decode(identity, source, sid, video)),
    );
}

/// The people and the monitor, as the stage needs them.
fn people(
    room: &Room,
    speaking: &BTreeSet<String>,
) -> (Vec<RoomRemotePerson>, Option<RoomRemoteMonitor>) {
    let mut people = Vec::new();
    let mut monitor = None;
    let mut participants: Vec<RemoteParticipant> =
        room.remote_participants().into_values().collect();
    participants.sort_by(|a, b| a.identity().as_str().cmp(b.identity().as_str()));
    for participant in participants {
        let identity = participant.identity().as_str().to_string();
        if identity.starts_with(RECORDER_IDENTITY_PREFIX) {
            continue;
        }
        let publications: Vec<RemoteTrackPublication> =
            participant.track_publications().into_values().collect();
        let live = |source: TrackSource, kind: TrackKind| {
            publications.iter().any(|publication| {
                publication.source() == source
                    && publication.kind() == kind
                    && publication.is_subscribed()
                    && publication.track().is_some()
                    && !publication.is_muted()
            })
        };
        let published = |source: TrackSource| {
            publications
                .iter()
                .find(|publication| publication.source() == source)
                .map(|publication| publication.is_muted())
        };
        if is_runner(&identity) {
            monitor = Some(RoomRemoteMonitor {
                video: publications.iter().any(|publication| {
                    publication.kind() == TrackKind::Video && publication.track().is_some()
                }),
                audio: publications.iter().any(|publication| {
                    publication.kind() == TrackKind::Audio && publication.track().is_some()
                }),
            });
            continue;
        }
        people.push(RoomRemotePerson {
            name: participant.name(),
            camera: live(TrackSource::Camera, TrackKind::Video),
            screen: live(TrackSource::Screenshare, TrackKind::Video),
            audio: live(TrackSource::Microphone, TrackKind::Audio),
            mic_muted: published(TrackSource::Microphone).unwrap_or(true),
            camera_off: published(TrackSource::Camera).unwrap_or(true),
            speaking: speaking.contains(&identity),
            quality: quality_name(participant.connection_quality()).to_string(),
            identity,
        });
    }
    (people, monitor)
}

/// One connection's subscriptions and decoders. Ends when `done` fires or
/// its sender drops.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut done: oneshot::Receiver<()>,
) {
    let mut events = room.subscribe();
    let mut decoders: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut speaking: BTreeSet<String> = BTreeSet::new();
    let mut pulse = tokio::time::interval(Duration::from_secs(1));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    RoomEvent::TrackPublished { publication, participant } => {
                        let want = wants(participant.identity().as_str(), MONITOR.load(Ordering::Acquire));
                        publication.set_subscribed(want);
                    }
                    RoomEvent::TrackSubscribed { track, publication, participant } => {
                        start_decoding(&mut decoders, track, &publication, &participant);
                    }
                    RoomEvent::TrackUnsubscribed { publication, .. }
                    | RoomEvent::TrackUnpublished { publication, .. } => {
                        if let Some(decoder) = decoders.remove(publication.sid().as_str()) {
                            decoder.abort();
                        }
                        let sid = publication.sid().as_str().to_string();
                        frames().retain(|_, frame| frame.generation != sid);
                    }
                    RoomEvent::ActiveSpeakersChanged { speakers } => {
                        speaking = speakers
                            .iter()
                            .map(|participant| participant.identity().as_str().to_string())
                            .collect();
                    }
                    RoomEvent::ParticipantConnected(_)
                    | RoomEvent::ParticipantDisconnected(_)
                    | RoomEvent::TrackMuted { .. }
                    | RoomEvent::TrackUnmuted { .. }
                    | RoomEvent::ConnectionQualityChanged { .. }
                    | RoomEvent::Reconnected => {}
                    _ => continue,
                }
            }
            _ = MONITOR_CHANGED.notified() => {}
            _ = pulse.tick() => {}
        }
        subscribe_all(&room, MONITOR.load(Ordering::Acquire));
        let (people, monitor) = people(&room, &speaking);
        crate::room_media::update_media(&state, &show_id, |media| {
            media.people = people;
            media.monitor = monitor;
        });
    }
    for (_, decoder) in decoders.drain() {
        decoder.abort();
    }
    frames().clear();
    crate::room_media::update_media(&state, &show_id, |media| {
        media.people = Vec::new();
        media.monitor = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_takes_guests_always_and_the_runner_with_the_monitor() {
        assert!(wants("g_ada", false));
        assert!(!wants("runner:show", false));
        assert!(wants("runner:show", true));
        assert!(!wants("EG_program", true));
    }

    #[test]
    fn frames_go_under_their_source() {
        assert_eq!(video_source("g_ada", TrackSource::Camera), Some("camera"));
        assert_eq!(
            video_source("g_ada", TrackSource::Screenshare),
            Some("screen")
        );
        assert_eq!(video_source("g_ada", TrackSource::Microphone), None);
        assert_eq!(
            video_source("runner:show", TrackSource::Camera),
            Some("monitor")
        );
    }

    #[test]
    fn a_picture_keeps_its_shape_within_its_bound() {
        assert_eq!(fit(1920, 1080, CAMERA_MAX), (1280, 720));
        assert_eq!(fit(640, 480, CAMERA_MAX), (640, 480));
        assert_eq!(fit(2560, 1600, SCREEN_MAX), (1728, 1080));
    }
}
