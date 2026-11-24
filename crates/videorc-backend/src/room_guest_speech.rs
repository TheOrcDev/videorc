//! Plan 260 S1.8d d4: the guest captions mix, in-process, for the backend's
//! room. The renderer's room mixed the on-stage, unmuted guest microphones
//! in Web Audio and sent each chunk back (`cloud.speech.guests.sync` and
//! `.audio`, `room-guest-speech.ts`); here the backend decodes those same
//! tracks (`NativeAudioStream`, 48 kHz mono), mixes them in 100 ms chunks and
//! feeds the same captions lane directly. The lane's own rules stand: only
//! the Live captions switch starts it, it never reaches the host's caption
//! tap or Sidekick, and the source lease lapses without the 250 ms sync.
//! Nothing here plays: hearing the guests is d3's.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::StreamExt;
use livekit::prelude::{RemoteTrack, Room, TrackSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::state::AppState;

const RATE: u32 = 48_000;
/// One 100 ms chunk, the lane's bound.
const CHUNK: usize = 4_800;
/// A guest's buffered audio is kept to one second; older is dropped.
const MAX_BUFFER: usize = 48_000;
const TICK: Duration = Duration::from_millis(100);
/// The source lease (two seconds) is renewed every other tick.
const SYNC_EVERY_TICKS: u32 = 2;

static CAPTIONING: AtomicBool = AtomicBool::new(false);
/// The guest captions' state changed: the stage message carries it.
pub(crate) static CAPTIONING_CHANGED: Notify = Notify::const_new();

/// The guests' words are being captioned (the guest page says so).
pub(crate) fn captioning() -> bool {
    CAPTIONING.load(Ordering::Acquire)
}

fn set_captioning(on: bool) {
    if CAPTIONING.swap(on, Ordering::AcqRel) != on {
        CAPTIONING_CHANGED.notify_waiters();
    }
}

/// A hold ended.
pub(crate) fn clear() {
    set_captioning(false);
}

/// Whether an identity's microphone belongs in the mix: a guest (never the
/// host, the runner or an egress page) who is on stage.
pub(crate) fn mixes(identity: &str, on_stage: &[String]) -> bool {
    !identity.starts_with("host:")
        && !identity.starts_with("runner:")
        && !identity.starts_with("EG_")
        && on_stage.iter().any(|on| on == identity)
}

/// The next chunk: each buffer's first `frames` samples summed (a short
/// buffer adds silence), drained, clamped.
pub(crate) fn mix(buffers: &mut [VecDeque<f32>], frames: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; frames];
    for buffer in buffers.iter_mut() {
        let take = buffer.len().min(frames);
        for (slot, sample) in out.iter_mut().zip(buffer.drain(..take)) {
            *slot += sample;
        }
    }
    for sample in &mut out {
        *sample = sample.clamp(-1.0, 1.0);
    }
    out
}

type Buffer = Arc<StdMutex<VecDeque<f32>>>;

/// Decodes one guest microphone into its buffer until it ends.
async fn decode(track: livekit::prelude::RemoteAudioTrack, buffer: Buffer) {
    let mut stream = NativeAudioStream::new(track.rtc_track(), RATE as i32, 1);
    while let Some(frame) = stream.next().await {
        let mut buffer = buffer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        buffer.extend(
            frame
                .data
                .iter()
                .map(|sample| f32::from(*sample) / 32_768.0),
        );
        let excess = buffer.len().saturating_sub(MAX_BUFFER);
        buffer.drain(..excess);
    }
}

/// One connection's guest captions mix. Ends when `done` fires or its sender
/// drops, settling the lane's lease.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut done: oneshot::Receiver<()>,
) {
    let source_id = format!("guests-backend-{}", uuid::Uuid::new_v4().simple());
    // The renderer's scale (milliseconds times 1000): a newer generation than
    // any the renderer's room used before.
    let generation = (chrono::Utc::now().timestamp_millis().max(1) as u64).saturating_mul(1000);
    // By identity: the microphone track's sid, its decoder and its buffer.
    let mut feeds: HashMap<String, (String, JoinHandle<()>, Buffer)> = HashMap::new();
    let mut sequence = 0u64;
    let mut ticks = 0u32;
    let mut upload_allowed = false;
    let mut pulse = tokio::time::interval(TICK);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            _ = pulse.tick() => {}
        }
        // The guests whose microphone belongs in the mix now.
        let on_stage = crate::cloud_show::lock(&state.cloud_show)
            .status()
            .room
            .map(|room| room.stage.on_stage)
            .unwrap_or_default();
        let mut wanted: HashMap<String, (String, livekit::prelude::RemoteAudioTrack)> =
            HashMap::new();
        for participant in room.remote_participants().values() {
            let identity = participant.identity().as_str().to_string();
            if !mixes(&identity, &on_stage) {
                continue;
            }
            for publication in participant.track_publications().values() {
                if publication.source() != TrackSource::Microphone
                    || !publication.is_subscribed()
                    || publication.is_muted()
                {
                    continue;
                }
                if let Some(RemoteTrack::Audio(track)) = publication.track() {
                    wanted.insert(
                        identity.clone(),
                        (publication.sid().as_str().to_string(), track),
                    );
                }
            }
        }
        feeds.retain(|identity, (sid, decoder, _)| {
            let keep = wanted.get(identity).is_some_and(|(want, _)| want == sid);
            if !keep {
                decoder.abort();
            }
            keep
        });
        for (identity, (sid, track)) in wanted {
            if feeds.contains_key(&identity) {
                continue;
            }
            let buffer: Buffer = Arc::new(StdMutex::new(VecDeque::new()));
            let decoder = tokio::spawn(decode(track, buffer.clone()));
            feeds.insert(identity, (sid, decoder, buffer));
        }
        // The source lease, renewed every other tick; zero guests stops the lane.
        ticks += 1;
        if ticks % SYNC_EVERY_TICKS == 1 || feeds.is_empty() {
            let sync = crate::captions::guest_lane::GuestSync::new(
                &show_id,
                &source_id,
                generation,
                feeds.len() as u32,
            );
            match crate::captions::guest_lane::sync(&state, sync).await {
                Ok(status) => {
                    upload_allowed = status.upload_allowed();
                    set_captioning(status.captioning());
                }
                Err(error) => {
                    tracing::debug!("The guest captions source was refused: {error:#}");
                    upload_allowed = false;
                    set_captioning(false);
                }
            }
        }
        // One 100 ms chunk of the mix.
        let mut buffers: Vec<VecDeque<f32>> = feeds
            .values()
            .map(|(_, _, buffer)| {
                let mut buffer = buffer
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let take = buffer.len().min(CHUNK);
                buffer.drain(..take).collect()
            })
            .collect();
        if !upload_allowed || feeds.is_empty() {
            continue;
        }
        let samples = mix(&mut buffers, CHUNK);
        sequence += 1;
        let pcm = crate::captions::guest_lane::GuestPcm::new(&source_id, sequence, RATE, samples);
        if let Err(error) = crate::captions::guest_lane::audio(&state, pcm).await {
            tracing::debug!("A guest captions chunk was refused: {error:#}");
        }
    }
    for (_, (_, decoder, _)) in feeds.drain() {
        decoder.abort();
    }
    let stop = crate::captions::guest_lane::GuestSync::new(&show_id, &source_id, generation, 0);
    let _ = crate::captions::guest_lane::sync(&state, stop).await;
    set_captioning(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_on_stage_guests_are_mixed() {
        let on_stage = vec!["g_ada".to_string(), "host:show".to_string()];
        assert!(mixes("g_ada", &on_stage));
        assert!(!mixes("g_bob", &on_stage));
        assert!(!mixes("host:show", &on_stage));
        assert!(!mixes("runner:show", &["runner:show".to_string()]));
        assert!(!mixes("EG_program", &["EG_program".to_string()]));
    }

    #[test]
    fn the_mix_sums_pads_and_clamps() {
        let mut buffers = vec![
            VecDeque::from(vec![0.5, 0.5, 0.5]),
            VecDeque::from(vec![0.75]),
        ];
        assert_eq!(mix(&mut buffers, 3), vec![1.0, 0.5, 0.5]);
        assert!(buffers.iter().all(VecDeque::is_empty));
    }
}
