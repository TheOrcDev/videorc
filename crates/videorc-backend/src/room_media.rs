//! Plan 260 S1.8c: the host's own media in the backend's room, once it
//! holds the host seat (S1.8a). Part c1, the microphone: the room
//! microphone bridge (`room_microphone.rs`) the renderer pulled from for its
//! native mode, driven here instead, its processed 48 kHz mono frames pushed
//! into a native audio source published as the room's microphone. The
//! settings come from the Studio (`cloud.room.microphone.set`, the bridge's
//! own shape).
//!
//! Part c2, the camera: the native preview camera's frames (the backend keeps
//! the device while it holds the seat; nothing is lent to a browser room),
//! through the compositor's own camera processing (`camera_role_rgba`: the
//! key, speck cleanup, despill and look of the app's scene layout), keyed
//! onto the scene background picture as the program draws it (c2b: the
//! compositor's own image cache and placement), or onto the video ground
//! without one (VP8 has no alpha), and
//! published as VP8 at up to 720p with simulcast 180p/360p. The Studio turns
//! it on and off with `cloud.room.camera.set`; the effects are the backend's
//! own scene layout, never sent twice. A background effect (blur, picture,
//! video, cutout) keeps the camera off the room, as the renderer's room does
//! until plan 258 S8. The screen (c3) and the aux track (c4) join.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use livekit::options::{VideoCodec, VideoEncoding};
use livekit::prelude::{
    LocalAudioTrack, LocalTrack, LocalVideoTrack, Room, TrackPublishOptions, TrackSid, TrackSource,
};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use tokio::sync::{Notify, oneshot};

use crate::cloud_talk::{
    CLOUD_ROOM_PRESENTATION_EVENT, CloudRoomPresentationEvent, RoomCameraSettings, RoomMediaStatus,
};
use crate::protocol::{CameraBackgroundMode, LayoutSettings};
use crate::room_microphone::{Bridge, Command, Reply, Settings};
use crate::state::AppState;

const SAMPLE_RATE: u32 = 48_000;
const FRAMES: u32 = 480;

static MICROPHONE: StdMutex<Option<Settings>> = StdMutex::new(None);
static CHANGED: Notify = Notify::const_new();

fn microphone() -> Option<Settings> {
    MICROPHONE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// `cloud.room.microphone.set`.
pub(crate) fn set_microphone(settings: Option<Settings>) {
    *MICROPHONE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
    CHANGED.notify_waiters();
}

static CAMERA: StdMutex<Option<RoomCameraSettings>> = StdMutex::new(None);
static CAMERA_CHANGED: Notify = Notify::const_new();

fn camera() -> Option<RoomCameraSettings> {
    CAMERA
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// `cloud.room.camera.set`.
pub(crate) fn set_camera(settings: Option<RoomCameraSettings>) {
    *CAMERA
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
    CAMERA_CHANGED.notify_waiters();
}

static MEDIA: StdMutex<Option<(String, RoomMediaStatus)>> = StdMutex::new(None);

/// What the host's media tasks publish, on `cloud.room.presentation`'s
/// `media` entry, sent when it changes.
pub(crate) fn update_media(
    state: &AppState,
    show_id: &str,
    change: impl FnOnce(&mut RoomMediaStatus),
) {
    let changed = {
        let mut media = MEDIA
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A new connection's first report always goes out: the Studio learns
        // the backend holds the room before anything is published.
        let fresh = media.as_ref().is_none_or(|entry| entry.0 != show_id);
        if fresh {
            *media = Some((show_id.to_string(), RoomMediaStatus::default()));
        }
        let entry = media.get_or_insert_with(|| (show_id.to_string(), RoomMediaStatus::default()));
        let before = entry.1.clone();
        change(&mut entry.1);
        (fresh || entry.1 != before).then(|| entry.1.clone())
    };
    if let Some(media) = changed {
        state.emit_event(
            CLOUD_ROOM_PRESENTATION_EVENT,
            CloudRoomPresentationEvent {
                show_id: show_id.to_string(),
                graphics: None,
                avatar: None,
                scene: None,
                media: Some(media),
            },
        );
    }
}

/// A hold ended.
pub(crate) fn clear() {
    set_microphone(None);
    set_camera(None);
    *MEDIA
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn command(action: &str, generation: u64, show_id: &str, settings: Option<Settings>) -> Command {
    Command {
        action: action.to_string(),
        generation,
        role: "host-microphone".to_string(),
        sample_rate: SAMPLE_RATE,
        channels: 1,
        frames: FRAMES,
        show_id: show_id.to_string(),
        settings,
    }
}

/// `f32` in [-1, 1] to the native source's `i16`.
pub(crate) fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16)
        .collect()
}

/// Whether a settings change needs the device opened again (the bridge
/// takes gain, mute and noise as an update; a device or offset needs a new
/// generation).
pub(crate) fn needs_reopen(current: &Settings, next: &Settings) -> bool {
    current.device_id != next.device_id || current.offset_ms != next.offset_ms
}

/// Whether native capture owns the microphone (a recording or stream runs or
/// is starting): the room microphone bridge refuses to open then.
fn capture_owns_microphone(state: &AppState) -> bool {
    let work = state.ffmpeg_work.snapshot();
    work.capture_active
        || work.capture_waiting > 0
        || !state.capture_interruption.capture_admission_is_idle()
}

/// One 10 ms mono frame into the room's microphone.
async fn push(source: &NativeAudioSource, samples: &[f32]) {
    let mut data = to_i16(samples);
    // S1.8d d3: the guests played here are cancelled out of it first.
    crate::room_playout::cancel_echo(&mut data);
    let audio = AudioFrame {
        data: data.into(),
        sample_rate: SAMPLE_RATE,
        num_channels: 1,
        samples_per_channel: FRAMES,
    };
    if let Err(error) = source.capture_frame(&audio).await {
        tracing::debug!("A room microphone frame was dropped: {error}");
    }
}

/// One connection's microphone: published once, fed while settings stand.
/// Ends when `done` fires or its sender drops (the connection ended), closing
/// the device first: the task is never aborted while it holds the
/// microphone. While native capture owns the device (plan 260 S1.8c c4a) it
/// takes the session's own processed microphone instead of opening the
/// device a second time, and goes back to its own when the session ends.
pub(crate) async fn run_microphone(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut done: oneshot::Receiver<()>,
) {
    let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 100);
    let track =
        LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::Microphone,
        ..Default::default()
    };
    if let Err(error) = room
        .local_participant()
        .publish_track(LocalTrack::Audio(track), options)
        .await
    {
        tracing::warn!("The backend could not publish the room microphone: {error}");
        return;
    }
    let mut bridge = Bridge::default();
    let mut generation = 0u64;
    let mut open: Option<Settings> = None;
    let mut session: Option<tokio::sync::mpsc::Receiver<Vec<f32>>> = None;
    let mut carry: Vec<f32> = Vec::new();
    let mut pulse = tokio::time::interval(Duration::from_millis(10));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let live = open.is_some() || session.is_some();
        update_media(&state, &show_id, |media| media.microphone = live);
        tokio::select! {
            _ = &mut done => {
                update_media(&state, &show_id, |media| media.microphone = false);
                if session.take().is_some() {
                    crate::room_microphone::session_tap::close();
                }
                if open.is_some() {
                    let _ = bridge.command(&state, command("close", generation, &show_id, None)).await;
                }
                return;
            }
            _ = pulse.tick() => {}
            _ = CHANGED.notified() => {}
        }
        let wanted = microphone().filter(Settings::valid);
        // c4a: a recording or stream owns the device; the room takes the
        // session's processed microphone (its gain, mute, noise suppression
        // and offset, never system audio or sounds).
        if wanted.is_some() && capture_owns_microphone(&state) {
            if open.take().is_some() {
                let _ = bridge
                    .command(&state, command("close", generation, &show_id, None))
                    .await;
            }
            let receiver = session.get_or_insert_with(crate::room_microphone::session_tap::open);
            while let Ok(samples) = receiver.try_recv() {
                carry.extend_from_slice(&samples);
            }
            while carry.len() >= FRAMES as usize {
                let chunk: Vec<f32> = carry.drain(..FRAMES as usize).collect();
                push(&source, &chunk).await;
            }
            continue;
        }
        if session.take().is_some() {
            crate::room_microphone::session_tap::close();
            carry.clear();
        }
        match (open.clone(), wanted) {
            (None, None) => continue,
            (Some(_), None) => {
                let _ = bridge
                    .command(&state, command("close", generation, &show_id, None))
                    .await;
                open = None;
                continue;
            }
            (Some(current), Some(next)) if needs_reopen(&current, &next) => {
                let _ = bridge
                    .command(&state, command("close", generation, &show_id, None))
                    .await;
                open = None;
                generation += 1;
                match bridge
                    .command(
                        &state,
                        command("open", generation, &show_id, Some(next.clone())),
                    )
                    .await
                {
                    Ok(_) => open = Some(next),
                    Err(error) => {
                        tracing::warn!("The room microphone did not open: {error:#}");
                        tokio::select! {
                            _ = &mut done => return,
                            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                        }
                        continue;
                    }
                }
            }
            (Some(current), Some(next)) if current != next => {
                match bridge
                    .command(
                        &state,
                        command("update", generation, &show_id, Some(next.clone())),
                    )
                    .await
                {
                    Ok(_) => open = Some(next),
                    Err(error) => tracing::warn!("The room microphone did not update: {error:#}"),
                }
            }
            (None, Some(next)) => {
                generation += 1;
                match bridge
                    .command(
                        &state,
                        command("open", generation, &show_id, Some(next.clone())),
                    )
                    .await
                {
                    Ok(_) => open = Some(next),
                    Err(error) => {
                        tracing::warn!("The room microphone did not open: {error:#}");
                        tokio::select! {
                            _ = &mut done => return,
                            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                        }
                        continue;
                    }
                }
            }
            (Some(_), Some(_)) => {}
        }
        // Drain what the tap holds: each pull is one 10 ms frame.
        loop {
            match bridge
                .command(&state, command("pull", generation, &show_id, None))
                .await
            {
                Ok(Some(Reply::Frame(frame))) => push(&source, &frame.samples).await,
                Ok(_) => break,
                Err(error) => {
                    tracing::warn!("The room microphone stopped: {error:#}");
                    open = None;
                    let _ = bridge
                        .command(&state, command("close", generation, &show_id, None))
                        .await;
                    break;
                }
            }
        }
    }
}

/// The renderer room's video ground behind a key, `--video-ground`
/// (`oklch(0.13 0 0)`, the same in both themes).
const GROUND: u8 = 7;
/// The camera's top layer, VideoPresets.h720 (1280 x 720, 1.7 Mbps, 30 fps).
const CAMERA_MAX: (u32, u32) = (1280, 720);
const CAMERA_BITRATE: u64 = 1_700_000;
const CAMERA_FPS: f64 = 30.0;

/// The size the room's camera goes out at: the source's own shape, at most
/// 1280 x 720, never scaled up, even on both sides.
pub(crate) fn camera_size(width: u32, height: u32) -> Option<(u32, u32)> {
    fit_within(width, height, CAMERA_MAX)
}

/// A source's own shape within `max`, never scaled up, even on both sides.
pub(crate) fn fit_within(width: u32, height: u32, max: (u32, u32)) -> Option<(u32, u32)> {
    if width < 2 || height < 2 {
        return None;
    }
    let (w, h) = (f64::from(width), f64::from(height));
    let scale = (f64::from(max.0) / w).min(f64::from(max.1) / h).min(1.0);
    let even = |value: f64| ((((value + 1e-6) / 2.0).floor() as u32) * 2).max(2);
    Some((even(w * scale), even(h * scale)))
}

/// Whether the layout's camera background is an effect the room cannot
/// carry yet (the renderer's `cameraBackgroundIsEffect`).
pub(crate) fn background_is_effect(layout: &LayoutSettings) -> bool {
    layout.camera_background.as_ref().is_some_and(|background| {
        matches!(
            background.mode,
            CameraBackgroundMode::Blur
                | CameraBackgroundMode::Image
                | CameraBackgroundMode::Video
                | CameraBackgroundMode::Cutout
        )
    })
}

/// Straight-alpha RGBA keyed onto `behind` (opaque RGBA of the same size:
/// the scene background as the program draws it), opaque.
pub(crate) fn over_picture(rgba: &mut [u8], behind: &[u8]) {
    for (pixel, under) in rgba.chunks_exact_mut(4).zip(behind.chunks_exact(4)) {
        let alpha = u16::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for (channel, value) in pixel[..3].iter_mut().zip(&under[..3]) {
            *channel = ((u16::from(*channel) * alpha + u16::from(*value) * (255 - alpha) + 127)
                / 255) as u8;
        }
        pixel[3] = 255;
    }
}

/// Straight-alpha RGBA keyed onto the video ground, opaque.
pub(crate) fn over_ground(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u16::from(*channel) * alpha + u16::from(GROUND) * (255 - alpha) + 127)
                / 255) as u8;
        }
        pixel[3] = 255;
    }
}

/// One camera frame for the room: processed as the compositor processes
/// this camera, keyed onto the scene background (or the ground), as I420.
fn camera_frame(
    bytes: &[u8],
    width: u32,
    height: u32,
    layout: &LayoutSettings,
    (out_width, out_height): (u32, u32),
    behind: Option<&[u8]>,
) -> Option<I420Buffer> {
    let mut rgba = crate::compositor::camera_role_rgba(
        bytes, width, height, true, layout, out_width, out_height,
    )?;
    match behind {
        Some(behind) if behind.len() == rgba.len() => over_picture(&mut rgba, behind),
        _ => over_ground(&mut rgba),
    }
    let mut buffer = I420Buffer::new(out_width, out_height);
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (y, u, v) = buffer.data_mut();
    // RGBA in memory is libyuv's ABGR.
    yuv_helper::abgr_to_i420(
        &rgba,
        out_width * 4,
        y,
        stride_y,
        u,
        stride_u,
        v,
        stride_v,
        out_width as i32,
        out_height as i32,
    );
    Some(buffer)
}

/// Plan 260 L1: the backend-host talk-show smoke's room camera, `WxH:RRGGBB`
/// (a `#` allowed), a flat colour standing in for the preview camera's
/// device only: the Studio's camera on/off, the processing, the key and the
/// publish stay production. Debug builds with smoke RPC only.
pub(crate) const CAMERA_FIXTURE_ENV: &str = "VIDEORC_ROOM_CAMERA_FIXTURE";

/// [`CAMERA_FIXTURE_ENV`]'s camera.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CameraFixture {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgb: [u8; 3],
}

impl CameraFixture {
    /// `WxH:RRGGBB`: even sides from 2 to 4096, six hex digits.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let (size, colour) = value.trim().split_once(':')?;
        let (width, height) = size.split_once('x')?;
        let (width, height) = (width.parse::<u32>().ok()?, height.parse::<u32>().ok()?);
        let side = |value: u32| (2..=4096).contains(&value) && value.is_multiple_of(2);
        if !side(width) || !side(height) {
            return None;
        }
        let hex = colour.strip_prefix('#').unwrap_or(colour);
        if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
        Some(Self {
            width,
            height,
            rgb: [channel(0)?, channel(2)?, channel(4)?],
        })
    }

    /// The fixture's frame, BGRA as the preview camera gives it.
    pub(crate) fn bgra(&self) -> Vec<u8> {
        let [r, g, b] = self.rgb;
        [b, g, r, 255].repeat(self.width as usize * self.height as usize)
    }
}

/// The fixture camera, when every gate is open: a debug build, smoke RPC
/// and [`CAMERA_FIXTURE_ENV`].
fn camera_fixture(smoke_rpc_enabled: bool) -> Option<CameraFixture> {
    if !cfg!(debug_assertions) || !smoke_rpc_enabled {
        return None;
    }
    CameraFixture::parse(&std::env::var(CAMERA_FIXTURE_ENV).ok()?)
}

/// What the drawn background behind the key was drawn from.
#[derive(PartialEq)]
struct BehindKey {
    background: crate::protocol::EffectiveSceneBackground,
    pixels: usize,
    size: (u32, u32),
}

/// The camera as it is published now.
struct PublishedCamera {
    sid: TrackSid,
    source: NativeVideoSource,
    size: (u32, u32),
}

async fn publish_camera(
    room: &Room,
    (width, height): (u32, u32),
) -> anyhow::Result<PublishedCamera> {
    let source = NativeVideoSource::new(VideoResolution { width, height }, false);
    let track =
        LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::Camera,
        video_codec: VideoCodec::VP8,
        simulcast: true,
        video_encoding: Some(VideoEncoding {
            max_bitrate: CAMERA_BITRATE,
            max_framerate: CAMERA_FPS,
        }),
        ..Default::default()
    };
    let publication = room
        .local_participant()
        .publish_track(LocalTrack::Video(track), options)
        .await?;
    Ok(PublishedCamera {
        sid: publication.sid(),
        source,
        size: (width, height),
    })
}

async fn unpublish_camera(room: &Room, published: &mut Option<PublishedCamera>) {
    if let Some(camera) = published.take()
        && let Err(error) = room.local_participant().unpublish_track(&camera.sid).await
    {
        tracing::warn!("The backend could not take the room camera off: {error}");
    }
}

/// One connection's camera: published while the Studio has it on and the
/// preview camera gives frames, taken off otherwise. Ends when `done` fires
/// or its sender drops (the connection ended).
pub(crate) async fn run_camera(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut done: oneshot::Receiver<()>,
) {
    let started = std::time::Instant::now();
    let mut published: Option<PublishedCamera> = None;
    let mut last: Option<(u64, u64)> = None;
    // The scene background behind the key, drawn once per picture, placement
    // and camera size.
    let mut behind_drawn: Option<(BehindKey, Arc<Vec<u8>>)> = None;
    let mut pulse = tokio::time::interval(Duration::from_secs_f64(1.0 / CAMERA_FPS));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // The debug fixture camera (plan 260 L1): its frame, drawn once, and its
    // own frame count.
    let fixture = camera_fixture(state.smoke_rpc_enabled).map(|fixture| {
        tracing::info!(
            "The backend's room camera is the debug fixture ({CAMERA_FIXTURE_ENV}={}x{})",
            fixture.width,
            fixture.height
        );
        (fixture, fixture.bgra())
    });
    let mut fixture_sequence = 0u64;
    loop {
        update_media(&state, &show_id, |media| media.camera = published.is_some());
        tokio::select! {
            _ = &mut done => {
                unpublish_camera(&room, &mut published).await;
                update_media(&state, &show_id, |media| media.camera = false);
                return;
            }
            _ = pulse.tick() => {}
            _ = CAMERA_CHANGED.notified() => {}
        }
        if !camera().is_some_and(|settings| settings.valid()) {
            unpublish_camera(&room, &mut published).await;
            continue;
        }
        // The app's scene layout (the key and look the compositor applies to
        // this camera) and, with the key on, the scene background picture the
        // program draws under it.
        let (layout, room_background) = {
            let compositor = state.compositor.lock().await;
            let layout = compositor
                .status
                .scene_layout
                .clone()
                .unwrap_or_else(crate::protocol::default_layout_settings);
            let background = if layout.camera_chroma_key_enabled {
                compositor.room_background()
            } else {
                None
            };
            (layout, background)
        };
        if background_is_effect(&layout) {
            unpublish_camera(&room, &mut published).await;
            continue;
        }
        let taken = if let Some((fixture, bytes)) = fixture.as_ref() {
            fixture_sequence += 1;
            Some((
                (0, fixture_sequence),
                bytes.clone(),
                fixture.width,
                fixture.height,
            ))
        } else {
            if crate::preview_camera::camera_lent_to_talk_show(&state).await {
                continue;
            }
            let Some(frame_source) =
                crate::preview_camera::preview_camera_frame_source(&state).await
            else {
                continue;
            };
            let generation = frame_source.generation();
            frame_source.latest_frame_blocking().and_then(|(frame, _)| {
                let key = (generation, frame.sequence);
                // A zero-copy frame has no CPU bytes; the capture keeps them
                // while the room keeps the camera.
                (last != Some(key) && !frame.bytes.is_empty())
                    .then(|| (key, frame.bytes.clone(), frame.width, frame.height))
            })
        };
        let Some((key, bytes, width, height)) = taken else {
            continue;
        };
        last = Some(key);
        let Some(size) = camera_size(width, height) else {
            continue;
        };
        let behind = match room_background {
            None => None,
            Some(room) => {
                let key = BehindKey {
                    background: room.background.clone(),
                    pixels: Arc::as_ptr(&room.pixels) as usize,
                    size,
                };
                let kept = behind_drawn
                    .as_ref()
                    .filter(|(drawn, _)| *drawn == key)
                    .map(|(_, picture)| picture.clone());
                if kept.is_some() {
                    kept
                } else {
                    let picture = tokio::task::spawn_blocking(move || {
                        crate::compositor::room_background_rgba(&room, size.0, size.1, GROUND)
                    })
                    .await
                    .ok()
                    .flatten()
                    .map(Arc::new);
                    behind_drawn = picture.clone().map(|picture| (key, picture));
                    picture
                }
            }
        };
        let Ok(Some(buffer)) = tokio::task::spawn_blocking(move || {
            camera_frame(
                &bytes,
                width,
                height,
                &layout,
                size,
                behind.as_deref().map(Vec::as_slice),
            )
        })
        .await
        else {
            continue;
        };
        if published.as_ref().is_some_and(|camera| camera.size != size) {
            unpublish_camera(&room, &mut published).await;
        }
        if published.is_none() {
            match publish_camera(&room, size).await {
                Ok(camera) => published = Some(camera),
                Err(error) => {
                    tracing::warn!("The backend could not publish the room camera: {error:#}");
                    tokio::select! {
                        _ = &mut done => return,
                        _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                    }
                    continue;
                }
            }
        }
        if let Some(camera) = &published {
            camera.source.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: started.elapsed().as_micros() as i64,
                frame_metadata: None,
                buffer,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MicrophoneNoiseSuppression;

    fn settings(device: &str, gain: f32, offset: u32) -> Settings {
        Settings {
            device_id: device.to_string(),
            gain_db: gain,
            muted: false,
            noise: MicrophoneNoiseSuppression::Rnnoise,
            offset_ms: offset,
        }
    }

    #[test]
    fn samples_become_clamped_i16() {
        assert_eq!(
            to_i16(&[0.0, 1.0, -1.0, 2.0, -2.0]),
            vec![0, 32767, -32767, 32767, -32767]
        );
    }

    #[test]
    fn the_camera_keeps_its_shape_within_720p() {
        assert_eq!(camera_size(1920, 1080), Some((1280, 720)));
        assert_eq!(camera_size(1440, 1080), Some((960, 720)));
        assert_eq!(camera_size(640, 480), Some((640, 480)));
        assert_eq!(camera_size(1080, 1920), Some((404, 720)));
        assert_eq!(camera_size(0, 720), None);
    }

    fn picture(fit: &str) -> crate::compositor::RoomBackground {
        // 4 x 2: the left half red, the right half blue.
        let mut pixels = Vec::new();
        for _row in 0..2 {
            pixels.extend_from_slice(&[
                255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
            ]);
        }
        crate::compositor::RoomBackground {
            background: serde_json::from_value(serde_json::json!({
                "assetId": "a", "managedAssetPath": "/tmp/a.webp", "fit": fit,
                "scale": 100.0, "offsetX": 0.0, "offsetY": 0.0, "blurPx": 0.0,
                "dimPercent": 0.0, "saturationPercent": 100.0, "vignettePercent": 0.0
            }))
            .unwrap(),
            pixels: Arc::new(pixels),
            size: (4, 2),
            bgra: false,
        }
    }

    #[test]
    fn the_scene_picture_is_placed_as_the_program_places_it() {
        // Fill covers a square from the middle: red left, blue right.
        let filled =
            crate::compositor::room_background_rgba(&picture("fill"), 2, 2, GROUND).unwrap();
        assert_eq!(filled.len(), 2 * 2 * 4);
        assert!(filled[0] > 200 && filled[2] < 50, "{filled:?}");
        assert!(filled[4] < 50 && filled[6] > 200, "{filled:?}");
        // Fit keeps the whole picture with bars of ground above and below.
        let fitted =
            crate::compositor::room_background_rgba(&picture("fit"), 4, 4, GROUND).unwrap();
        assert_eq!(&fitted[..16], &[GROUND, GROUND, GROUND, 255].repeat(4)[..]);
        assert_eq!(&fitted[48..], &[GROUND, GROUND, GROUND, 255].repeat(4)[..]);
        assert!(fitted[16] > 200 && fitted[28 + 2] > 200, "{fitted:?}");
        assert!(fitted.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }

    #[test]
    fn a_key_lands_on_the_scene_picture() {
        let mut rgba = vec![200, 100, 50, 255, 200, 100, 50, 0, 255, 255, 255, 128];
        let behind = vec![1, 2, 3, 255, 40, 80, 120, 255, 0, 0, 0, 255];
        over_picture(&mut rgba, &behind);
        assert_eq!(
            rgba,
            vec![200, 100, 50, 255, 40, 80, 120, 255, 128, 128, 128, 255]
        );
    }

    #[test]
    fn a_key_lands_on_the_video_ground() {
        let mut rgba = vec![200, 100, 50, 255, 200, 100, 50, 0, 255, 255, 255, 128];
        over_ground(&mut rgba);
        assert_eq!(
            rgba,
            vec![200, 100, 50, 255, 7, 7, 7, 255, 131, 131, 131, 255]
        );
    }

    #[test]
    fn only_a_background_effect_keeps_the_camera_off() {
        let mut layout = crate::protocol::default_layout_settings();
        assert!(!background_is_effect(&layout));
        for (mode, effect) in [
            (CameraBackgroundMode::Off, false),
            (CameraBackgroundMode::Green, false),
            (CameraBackgroundMode::Blue, false),
            (CameraBackgroundMode::Blur, true),
            (CameraBackgroundMode::Image, true),
            (CameraBackgroundMode::Video, true),
            (CameraBackgroundMode::Cutout, true),
        ] {
            let mut background: crate::protocol::CameraBackground =
                serde_json::from_value(serde_json::json!({
                    "mode": "off", "blurPct": 30, "edges": "balanced"
                }))
                .unwrap();
            background.mode = mode;
            layout.camera_background = Some(background);
            assert_eq!(background_is_effect(&layout), effect, "{mode:?}");
        }
    }

    #[test]
    fn the_fixture_camera_is_a_size_and_a_colour() {
        assert_eq!(
            CameraFixture::parse("1280x720:40C0FF"),
            Some(CameraFixture {
                width: 1280,
                height: 720,
                rgb: [0x40, 0xC0, 0xFF]
            })
        );
        assert_eq!(
            CameraFixture::parse(" 640x360:#c02020 ").map(|fixture| fixture.rgb),
            Some([0xC0, 0x20, 0x20])
        );
        for refused in [
            "",
            "1280x720",
            "1280x720:",
            "1281x720:40C0FF",
            "0x720:40C0FF",
            "8192x720:40C0FF",
            "1280x720:40C0F",
            "1280x720:40C0FFF",
            "1280x720:+0C0FF",
            "1280x720:40C0FG",
            "1280x720:40C0é",
            "1280:720:40C0FF",
        ] {
            assert_eq!(CameraFixture::parse(refused), None, "{refused}");
        }
    }

    #[test]
    fn the_fixture_camera_frame_is_flat_bgra() {
        let fixture = CameraFixture::parse("4x2:40C0FF").unwrap();
        let frame = fixture.bgra();
        assert_eq!(frame.len(), 4 * 2 * 4);
        assert!(
            frame
                .chunks_exact(4)
                .all(|pixel| pixel == [0xFF, 0xC0, 0x40, 255])
        );
        // Through the room camera's own processing with the default layout,
        // the colour is the colour the smoke's tile probe expects.
        let layout = crate::protocol::default_layout_settings();
        let rgba = crate::compositor::camera_role_rgba(&frame, 4, 2, true, &layout, 4, 2).unwrap();
        assert!(
            rgba.chunks_exact(4)
                .all(|pixel| pixel == [0x40, 0xC0, 0xFF, 255]),
            "{rgba:?}"
        );
    }

    #[test]
    fn the_fixture_camera_needs_a_debug_build_with_smoke_rpc() {
        assert_eq!(camera_fixture(false), None);
    }

    #[test]
    fn only_a_device_or_offset_change_reopens() {
        let a = settings("microphone:coreaudio:7", 0.0, 0);
        assert!(!needs_reopen(
            &a,
            &settings("microphone:coreaudio:7", 6.0, 0)
        ));
        assert!(needs_reopen(
            &a,
            &settings("microphone:coreaudio:8", 0.0, 0)
        ));
        assert!(needs_reopen(
            &a,
            &settings("microphone:coreaudio:7", 0.0, 40)
        ));
    }
}
