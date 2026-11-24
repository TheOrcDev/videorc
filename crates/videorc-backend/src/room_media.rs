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
//! onto the video ground as the renderer's room does (VP8 has no alpha), and
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

use crate::cloud_talk::RoomCameraSettings;
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

/// A hold ended.
pub(crate) fn clear() {
    set_microphone(None);
    set_camera(None);
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

/// One connection's microphone: published once, fed while settings stand.
/// Ends when `done` fires or its sender drops (the connection ended), closing
/// the device first: the task is never aborted while it holds the
/// microphone.
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
    let mut pulse = tokio::time::interval(Duration::from_millis(10));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => {
                if open.is_some() {
                    let _ = bridge.command(&state, command("close", generation, &show_id, None)).await;
                }
                return;
            }
            _ = pulse.tick() => {}
            _ = CHANGED.notified() => {}
        }
        let wanted = microphone().filter(Settings::valid);
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
                Ok(Some(Reply::Frame(frame))) => {
                    let audio = AudioFrame {
                        data: to_i16(&frame.samples).into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: 1,
                        samples_per_channel: FRAMES,
                    };
                    if let Err(error) = source.capture_frame(&audio).await {
                        tracing::debug!("A room microphone frame was dropped: {error}");
                    }
                }
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
    if width < 2 || height < 2 {
        return None;
    }
    let (w, h) = (f64::from(width), f64::from(height));
    let scale = (f64::from(CAMERA_MAX.0) / w)
        .min(f64::from(CAMERA_MAX.1) / h)
        .min(1.0);
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
/// this camera, keyed onto the ground, as I420.
fn camera_frame(
    bytes: &[u8],
    width: u32,
    height: u32,
    layout: &LayoutSettings,
    (out_width, out_height): (u32, u32),
) -> Option<I420Buffer> {
    let mut rgba = crate::compositor::camera_role_rgba(
        bytes, width, height, true, layout, out_width, out_height,
    )?;
    over_ground(&mut rgba);
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
pub(crate) async fn run_camera(state: AppState, room: Arc<Room>, mut done: oneshot::Receiver<()>) {
    let started = std::time::Instant::now();
    let mut published: Option<PublishedCamera> = None;
    let mut last: Option<(u64, u64)> = None;
    let mut pulse = tokio::time::interval(Duration::from_secs_f64(1.0 / CAMERA_FPS));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => {
                unpublish_camera(&room, &mut published).await;
                return;
            }
            _ = pulse.tick() => {}
            _ = CAMERA_CHANGED.notified() => {}
        }
        if !camera().is_some_and(|settings| settings.valid()) {
            unpublish_camera(&room, &mut published).await;
            continue;
        }
        // The app's scene layout: the key and look the compositor applies to
        // this camera.
        let layout = state
            .compositor
            .lock()
            .await
            .status
            .scene_layout
            .clone()
            .unwrap_or_else(crate::protocol::default_layout_settings);
        if background_is_effect(&layout) {
            unpublish_camera(&room, &mut published).await;
            continue;
        }
        if crate::preview_camera::camera_lent_to_talk_show(&state).await {
            continue;
        }
        let Some(frame_source) = crate::preview_camera::preview_camera_frame_source(&state).await
        else {
            continue;
        };
        let taken = {
            let generation = frame_source.generation();
            frame_source.latest_frame_blocking().and_then(|(frame, _)| {
                let key = (generation, frame.sequence);
                // A zero-copy frame has no CPU bytes; the capture keeps them
                // while the room keeps the camera.
                (last != Some(key) && !frame.bytes.is_empty())
                    .then(|| (key, frame.bytes.clone(), frame.width, frame.height))
            })
        };
        drop(frame_source);
        let Some((key, bytes, width, height)) = taken else {
            continue;
        };
        last = Some(key);
        let Some(size) = camera_size(width, height) else {
            continue;
        };
        let Ok(Some(buffer)) =
            tokio::task::spawn_blocking(move || camera_frame(&bytes, width, height, &layout, size))
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
