//! Plan 260 S1.8c: the host's own media in the backend's room, once it
//! holds the host seat (S1.8a). Part c1, the microphone: the room
//! microphone bridge (`room_microphone.rs`) the renderer pulled from for its
//! native mode, driven here instead, its processed 48 kHz mono frames pushed
//! into a native audio source published as the room's microphone. The
//! settings come from the Studio (`cloud.room.microphone.set`, the bridge's
//! own shape). The camera (c2), the screen (c3) and the aux track (c4) join.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use livekit::prelude::{LocalAudioTrack, LocalTrack, Room, TrackPublishOptions, TrackSource};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use tokio::sync::{Notify, oneshot};

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

/// A hold ended.
pub(crate) fn clear() {
    set_microphone(None);
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
