//! Plan 260 S1.8c c4d: the auxiliary track in the backend's room, the
//! renderer room's `RoomAuxPublisher` audio (plan 249 S3, S5, S8).
//!
//! One stereo 48 kHz track, `videorc:v2:host-aux:stereo`, published as screen
//! share audio (RED, no DTX, 128 kbps): room sounds and the room's system
//! audio, never speech. It goes out only while something is on (room sounds,
//! or system audio) and every consumer's media v2 receipt is current, as the
//! renderer's room required; who may take it is `room_routing`'s.
//!
//! Room sounds are the backend's own soundboard voices (`SoundPlayer`),
//! rendered by the same arithmetic the session bus uses (start instant plus
//! position, a loop wrapping): a one-shot pressed before the track began is
//! not owed, a loop joins at its current phase. The board level comes from
//! the sound settings. System audio is the own-app-excluded capture the
//! renderer pulled from (`room_system_audio`), opened only while the track
//! is out.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use livekit::options::AudioEncoding;
use livekit::prelude::{
    LocalAudioTrack, LocalTrack, Room, TrackPublishOptions, TrackSid, TrackSource,
};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use tokio::sync::{Notify, oneshot};

use crate::cloud_talk::{CloudRoomAuxSetParams, RoomAuxState, RoomAuxStatus, RoomSystemAudioState};
use crate::room_capability::CapabilityReceipts;
use crate::room_routing::{AUX_TRACK_NAME, Consumer};
use crate::sound_player::RoomVoice;
use crate::state::AppState;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
const FRAMES: usize = 480;
const CHUNK: Duration = Duration::from_millis(10);
/// A late tick catches up at most this many chunks, then jumps.
const CATCH_UP: u32 = 4;
const AUX_BITRATE: u64 = 128_000;
/// A consumer's hearing report counts this long.
const OBSERVED_FOR_MS: i64 = 5_000;

static AUX: StdMutex<Option<CloudRoomAuxSetParams>> = StdMutex::new(None);
static AUX_CHANGED: Notify = Notify::const_new();
/// System audio was turned off by a lost connection and waits for the
/// Studio to turn it on again.
static SYSTEM_DISARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn settings() -> Option<CloudRoomAuxSetParams> {
    AUX.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// `cloud.room.aux.set`. Turning system audio on is the fresh consent a lost
/// connection asks for.
pub(crate) fn set_aux(params: CloudRoomAuxSetParams) {
    if params.system.enabled {
        SYSTEM_DISARMED.store(false, std::sync::atomic::Ordering::Release);
    }
    *AUX.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(params);
    AUX_CHANGED.notify_waiters();
}

/// The room connection dropped (a reconnect or an end): system audio stops
/// and stays off until the Studio turns it on again, as the renderer room's
/// `RoomAuxPublisher.#lost` did. Room sounds stay as they were.
pub(crate) fn disarm_system() {
    let mut aux = AUX.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(params) = aux.as_mut()
        && params.system.enabled
    {
        params.system.enabled = false;
        SYSTEM_DISARMED.store(true, std::sync::atomic::Ordering::Release);
    }
    drop(aux);
    AUX_CHANGED.notify_waiters();
}

/// A hold ended: room sounds and system audio off again.
pub(crate) fn clear() {
    *AUX.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    SYSTEM_DISARMED.store(false, std::sync::atomic::Ordering::Release);
}

/// Why the track cannot go out, or None (`auxiliaryBlockedReason`).
pub(crate) fn blocked_reason(enabled: bool, consumers: &[Consumer]) -> Option<&'static str> {
    if !enabled {
        return Some(
            "Room sounds are off. Enable for this room to try the unqualified audio path.",
        );
    }
    if consumers.is_empty() {
        return Some("Waiting for a capable program or guest consumer.");
    }
    if consumers.iter().any(|consumer| !consumer.current) {
        return Some(
            "Room sounds paused: every active program and guest must support media v2. Reload or rejoin older pages.",
        );
    }
    None
}

/// Adds the voices' 10 ms at `chunk_start` into `out` (interleaved stereo).
/// A one-shot that began before `since` is not owed; a loop wraps.
pub(crate) fn mix_voices(
    voices: &[RoomVoice],
    chunk_start: Instant,
    since: Instant,
    board_gain: f32,
    out: &mut [f32],
) {
    for voice in voices {
        if !voice.looping && voice.started < since {
            continue;
        }
        let frames = voice.pcm.len() / 2;
        if frames == 0 {
            continue;
        }
        let gain = voice.gain * board_gain / 32_768.0;
        // The voice's position at the chunk's first frame; frames before it
        // started stay silent.
        let (skip, offset) = if chunk_start >= voice.started {
            let elapsed = chunk_start.duration_since(voice.started);
            (
                0usize,
                (elapsed.as_nanos() * u128::from(SAMPLE_RATE) / 1_000_000_000) as usize,
            )
        } else {
            let ahead = voice.started.duration_since(chunk_start);
            (
                (ahead.as_nanos() * u128::from(SAMPLE_RATE) / 1_000_000_000) as usize,
                0usize,
            )
        };
        for frame in skip..FRAMES {
            let mut index = offset + (frame - skip);
            if voice.looping {
                index %= frames;
            } else if index >= frames {
                break;
            }
            out[frame * 2] += f32::from(voice.pcm[index * 2]) * gain;
            out[frame * 2 + 1] += f32::from(voice.pcm[index * 2 + 1]) * gain;
        }
    }
}

/// `f32` stereo to the source's `i16`, clamped.
fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16)
        .collect()
}

fn db_gain(db: f64) -> f32 {
    10f32.powf(db as f32 / 20.0)
}

struct Published {
    sid: TrackSid,
    source: NativeAudioSource,
}

async fn publish(room: &Room) -> anyhow::Result<Published> {
    let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, CHANNELS, 100);
    let track =
        LocalAudioTrack::create_audio_track(AUX_TRACK_NAME, RtcAudioSource::Native(source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::ScreenshareAudio,
        dtx: false,
        red: true,
        audio_encoding: Some(AudioEncoding {
            max_bitrate: AUX_BITRATE,
        }),
        ..Default::default()
    };
    let publication = room
        .local_participant()
        .publish_track(LocalTrack::Audio(track), options)
        .await?;
    Ok(Published {
        sid: publication.sid(),
        source,
    })
}

async fn unpublish(room: &Room, published: &mut Option<Published>) {
    if let Some(track) = published.take()
        && let Err(error) = room.local_participant().unpublish_track(&track.sid).await
    {
        tracing::warn!("The backend could not take the room's aux track off: {error}");
    }
}

/// The room's system capture, as the task drives it.
struct System {
    bridge: crate::room_system_audio::Bridge,
    generation: u64,
    open: bool,
    state: RoomSystemAudioState,
    reason: Option<String>,
}

impl System {
    async fn close(&mut self, state: &AppState, show_id: &str) {
        if self.open {
            let _ = self
                .bridge
                .command(
                    state,
                    crate::room_system_audio::Command::new("close", self.generation, show_id),
                )
                .await;
            self.open = false;
        }
    }
}

/// One connection's aux track. Ends when `done` fires or its sender drops.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut done: oneshot::Receiver<()>,
) {
    let mut published: Option<Published> = None;
    let mut since = Instant::now();
    let mut cursor = Instant::now();
    let mut system = System {
        bridge: crate::room_system_audio::Bridge::default(),
        generation: 0,
        open: false,
        state: RoomSystemAudioState::Off,
        reason: None,
    };
    let mut board_gain = 1.0f32;
    let mut board_read: Option<Instant> = None;
    let mut pulse = tokio::time::interval(CHUNK);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            _ = pulse.tick() => {}
            _ = AUX_CHANGED.notified() => {}
        }
        let wanted = settings().unwrap_or(CloudRoomAuxSetParams {
            sounds: false,
            system: Default::default(),
        });
        let enabled = wanted.sounds || wanted.system.enabled;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let consumers = crate::room_routing::consumers(&room, &receipts, now_ms);
        let reason = blocked_reason(enabled, &consumers);
        if reason.is_some() {
            unpublish(&room, &mut published).await;
            system.close(&state, &show_id).await;
        } else if published.is_none() {
            match publish(&room).await {
                Ok(track) => {
                    published = Some(track);
                    since = Instant::now();
                    cursor = since;
                }
                Err(error) => {
                    tracing::warn!("The backend could not publish the room's aux track: {error:#}");
                }
            }
        }
        // The room's system audio: open while the track is out and it is on.
        let want_system = published.is_some() && wanted.system.enabled;
        if !want_system {
            system.close(&state, &show_id).await;
            system.state = RoomSystemAudioState::Off;
            system.reason = None;
        } else if !system.open && system.state != RoomSystemAudioState::Blocked {
            system.generation += 1;
            system.state = RoomSystemAudioState::Opening;
            match system
                .bridge
                .command(
                    &state,
                    crate::room_system_audio::Command::new("open", system.generation, &show_id),
                )
                .await
            {
                Ok(_) => {
                    system.open = true;
                    system.state = RoomSystemAudioState::Capturing;
                    system.reason = Some(
                        "System source attached. Final audibility and clock sync are unqualified."
                            .to_string(),
                    );
                }
                Err(error) => {
                    system.state = RoomSystemAudioState::Blocked;
                    system.reason = Some(format!("{error:#}"));
                }
            }
        }
        if !wanted.system.enabled && system.state == RoomSystemAudioState::Blocked {
            system.state = RoomSystemAudioState::Off;
            system.reason = None;
        }
        // The mix: every 10 ms chunk due since the last tick.
        if let Some(track) = &published {
            if board_read.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                board_gain = state
                    .database
                    .sound_settings()
                    .map(|settings| db_gain(f64::from(settings.volume_db)))
                    .unwrap_or(1.0);
                board_read = Some(Instant::now());
            }
            let now = Instant::now();
            if now.saturating_duration_since(cursor) > CHUNK * CATCH_UP {
                cursor = now - CHUNK;
            }
            let voices = if wanted.sounds {
                state.soundboard.room_voices()
            } else {
                Vec::new()
            };
            let system_gain = if wanted.system.muted {
                0.0
            } else {
                db_gain(wanted.system.gain_db)
            };
            while cursor + CHUNK <= now {
                let mut out = vec![0.0f32; FRAMES * 2];
                mix_voices(&voices, cursor, since, board_gain, &mut out);
                if system.open {
                    match system
                        .bridge
                        .command(
                            &state,
                            crate::room_system_audio::Command::new(
                                "pull",
                                system.generation,
                                &show_id,
                            ),
                        )
                        .await
                    {
                        Ok(Some(crate::room_system_audio::Reply::Frame(frame))) => {
                            for (sample, value) in out.iter_mut().zip(frame.samples()) {
                                *sample += value * system_gain;
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            system.open = false;
                            system.state = RoomSystemAudioState::Blocked;
                            system.reason = Some(format!("{error:#}"));
                        }
                    }
                }
                let frame = AudioFrame {
                    data: to_i16(&out).into(),
                    sample_rate: SAMPLE_RATE,
                    num_channels: CHANNELS,
                    samples_per_channel: FRAMES as u32,
                };
                if let Err(error) = track.source.capture_frame(&frame).await {
                    tracing::debug!("A room aux frame was dropped: {error}");
                }
                cursor += CHUNK;
            }
        }
        // The status, as the renderer's room showed it.
        let observed: BTreeMap<String, i64> = published
            .as_ref()
            .map(|track| {
                let receipts = receipts
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                consumers
                    .iter()
                    .filter(|consumer| consumer.current)
                    .filter_map(|consumer| {
                        let report = receipts
                            .get(&consumer.identity)?
                            .capability
                            .auxiliary
                            .as_ref()?;
                        let at = i64::try_from(report.observed_at).ok()?;
                        (report.track_sid == track.sid.as_str()
                            && at <= now_ms + 1000
                            && now_ms - at < OBSERVED_FOR_MS)
                            .then(|| (consumer.identity.clone(), at))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let status = RoomAuxStatus {
            enabled: wanted.sounds,
            state: if !enabled {
                RoomAuxState::Off
            } else if reason.is_some() {
                RoomAuxState::Blocked
            } else if published.is_some() {
                RoomAuxState::Published
            } else {
                RoomAuxState::Queued
            },
            reason: reason.map(str::to_string),
            track_sid: published
                .as_ref()
                .map(|track| track.sid.as_str().to_string()),
            observed,
            system_state: system.state,
            system_reason: if SYSTEM_DISARMED.load(std::sync::atomic::Ordering::Acquire) {
                Some(
                    "System audio turned off when the room connection dropped. Turn it on again."
                        .to_string(),
                )
            } else {
                system.reason.clone()
            },
            system_disarmed: SYSTEM_DISARMED.load(std::sync::atomic::Ordering::Acquire),
        };
        crate::room_media::update_media(&state, &show_id, |media| media.aux = Some(status));
    }
    unpublish(&room, &mut published).await;
    system.close(&state, &show_id).await;
    crate::room_media::update_media(&state, &show_id, |media| media.aux = None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(started: Instant, looping: bool, frames: usize) -> RoomVoice {
        // Left 1000, right -1000 on every frame.
        let pcm: Vec<i16> = (0..frames).flat_map(|_| [1000i16, -1000]).collect();
        RoomVoice {
            pcm: pcm.into(),
            gain: 1.0,
            started,
            looping,
        }
    }

    #[test]
    fn a_one_shot_pressed_before_the_track_is_not_owed() {
        let since = Instant::now();
        let before = since - Duration::from_millis(5);
        let mut out = vec![0.0; FRAMES * 2];
        mix_voices(&[voice(before, false, 48_000)], since, since, 1.0, &mut out);
        assert!(out.iter().all(|sample| *sample == 0.0));
        // A loop joins at its phase.
        mix_voices(&[voice(before, true, 48_000)], since, since, 1.0, &mut out);
        assert!((out[0] - 1000.0 / 32_768.0).abs() < 1e-6);
        assert!((out[1] + 1000.0 / 32_768.0).abs() < 1e-6);
    }

    #[test]
    fn a_voice_starts_inside_the_chunk_and_ends_on_its_last_frame() {
        let chunk = Instant::now();
        let started = chunk + Duration::from_millis(5);
        let mut out = vec![0.0; FRAMES * 2];
        // 100 frames long, starting 240 frames into the chunk.
        mix_voices(&[voice(started, false, 100)], chunk, chunk, 0.5, &mut out);
        let heard: Vec<usize> = (0..FRAMES).filter(|frame| out[frame * 2] != 0.0).collect();
        assert_eq!(heard.first(), Some(&240));
        assert_eq!(heard.len(), 100);
        assert!((out[240 * 2] - 500.0 / 32_768.0).abs() < 1e-6);
    }

    #[test]
    fn the_track_waits_for_every_consumer_to_be_current() {
        let consumer = |identity: &str, current: bool| Consumer {
            identity: identity.to_string(),
            current,
            routing: true,
        };
        assert!(blocked_reason(false, &[consumer("EG_a", true)]).is_some());
        assert!(blocked_reason(true, &[]).is_some());
        assert!(
            blocked_reason(true, &[consumer("EG_a", true), consumer("g_old", false)]).is_some()
        );
        assert_eq!(
            blocked_reason(true, &[consumer("EG_a", true), consumer("g_b", true)]),
            None
        );
    }
}
