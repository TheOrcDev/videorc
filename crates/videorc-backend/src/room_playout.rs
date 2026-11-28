//! Plan 260 S1.8d d3: the guests heard on this Mac, natively, with echo
//! cancellation, while the backend holds the room's host seat.
//!
//! The renderer's room attached every subscribed guest audio track (their
//! microphones and shared-screen audio, never the runner's) to a hidden
//! `<audio>` element, and the browser's echo cancellation kept them out of
//! the host's microphone. Here the backend decodes those tracks
//! (`NativeAudioStream`, 48 kHz mono), mixes them every 10 ms and plays the
//! mix through S1.3b's device output (`sound_monitor::DeviceOutput`:
//! CoreAudio on macOS, PipeWire on Linux).
//! Each mixed chunk is the far end of LiveKit's own libwebrtc
//! `AudioProcessingModule` (`process_reverse_stream`); every room microphone
//! frame (its own tap or the session's, `room_media`) passes through the
//! same module (`process_stream`) before it is published, so a host on
//! speakers does not send the guests back to them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::StreamExt;
use livekit::prelude::{RemoteTrack, Room, TrackKind};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::native::apm::AudioProcessingModule;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::state::AppState;

const RATE: u32 = 48_000;
/// One 10 ms chunk, the APM's unit.
const CHUNK: usize = 480;
/// A guest's buffer, and the output's, kept short: late audio is dropped,
/// never played seconds behind.
const MAX_GUEST_BUFFER: usize = 9_600;
const MAX_OUTPUT_FRAMES: usize = 9_600;
const TICK: Duration = Duration::from_millis(10);
/// The echo path the canceller is told about: the output's buffer and the
/// device on the way out, the capture on the way in. Unqualified; the by-ear
/// check tunes it.
const STREAM_DELAY_MS: i32 = 60;

type Apm = Arc<StdMutex<AudioProcessingModule>>;

static APM: StdMutex<Option<Apm>> = StdMutex::new(None);
/// The Program monitor's Listen toggle (S1.8d d5): the runner's return is
/// played too while it is on (and the monitor takes the runner at all).
static LISTEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `cloud.room.monitor.set`'s `listen`.
pub(crate) fn set_listen(listen: bool) {
    LISTEN.store(listen, std::sync::atomic::Ordering::Release);
}

/// A hold ended.
pub(crate) fn clear() {
    set_listen(false);
}

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The near end: one 10 ms room microphone frame (48 kHz mono `i16`) through
/// the echo canceller, while the guests are played here. Without playout it
/// is left as it is.
pub(crate) fn cancel_echo(frame: &mut [i16]) {
    let Some(apm) = lock(&APM).clone() else {
        return;
    };
    let mut apm = lock(&apm);
    let _ = apm.set_stream_delay_ms(STREAM_DELAY_MS);
    if let Err(error) = apm.process_stream(frame, RATE as i32, 1) {
        tracing::debug!("The room microphone frame skipped echo cancellation: {error}");
    }
}

/// Whether a participant's audio is played: a guest's; the runner's (the
/// Program monitor's return) only while its Listen toggle is on; never an
/// egress page's.
pub(crate) fn plays(identity: &str, listen: bool) -> bool {
    if identity.starts_with("runner:") {
        return listen;
    }
    !identity.starts_with("EG_")
}

/// One 10 ms mono chunk of the guests: each buffer's next samples summed (a
/// short one adds silence), drained, clamped.
pub(crate) fn mix(buffers: &mut [&mut VecDeque<f32>]) -> Vec<f32> {
    let mut out = vec![0.0f32; CHUNK];
    for buffer in buffers.iter_mut() {
        let take = buffer.len().min(CHUNK);
        for (slot, sample) in out.iter_mut().zip(buffer.drain(..take)) {
            *slot += sample;
        }
    }
    for sample in &mut out {
        *sample = sample.clamp(-1.0, 1.0);
    }
    out
}

pub(crate) fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16)
        .collect()
}

type Buffer = Arc<StdMutex<VecDeque<f32>>>;

async fn decode(track: livekit::prelude::RemoteAudioTrack, buffer: Buffer) {
    let mut stream = NativeAudioStream::new(track.rtc_track(), RATE as i32, 1);
    while let Some(frame) = stream.next().await {
        let mut buffer = lock(&buffer);
        buffer.extend(
            frame
                .data
                .iter()
                .map(|sample| f32::from(*sample) / 32_768.0),
        );
        let excess = buffer.len().saturating_sub(MAX_GUEST_BUFFER);
        buffer.drain(..excess);
    }
}

/// One connection's guest playout. Ends when `done` fires or its sender
/// drops; the output closes and the echo canceller is let go.
pub(crate) async fn run(_state: AppState, room: Arc<Room>, mut done: oneshot::Receiver<()>) {
    let apm: Apm = Arc::new(StdMutex::new(AudioProcessingModule::new(
        true, false, true, false,
    )));
    *lock(&APM) = Some(apm.clone());
    // The played mix, interleaved stereo, read by the output device's thread.
    let output_ring: Buffer = Arc::new(StdMutex::new(VecDeque::new()));
    let mut output: Option<crate::sound_monitor::DeviceOutput> = None;
    let mut output_failed = false;
    let mut feeds: HashMap<String, (JoinHandle<()>, Buffer)> = HashMap::new();
    let mut pulse = tokio::time::interval(TICK);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            _ = pulse.tick() => {}
        }
        // Every subscribed guest audio track: microphones and screen audio.
        let mut wanted: HashMap<String, livekit::prelude::RemoteAudioTrack> = HashMap::new();
        for participant in room.remote_participants().values() {
            if !plays(
                participant.identity().as_str(),
                LISTEN.load(std::sync::atomic::Ordering::Acquire),
            ) {
                continue;
            }
            for publication in participant.track_publications().values() {
                if publication.kind() != TrackKind::Audio || !publication.is_subscribed() {
                    continue;
                }
                if let Some(RemoteTrack::Audio(track)) = publication.track() {
                    wanted.insert(publication.sid().as_str().to_string(), track);
                }
            }
        }
        feeds.retain(|sid, (decoder, _)| {
            let keep = wanted.contains_key(sid);
            if !keep {
                decoder.abort();
            }
            keep
        });
        for (sid, track) in wanted {
            if feeds.contains_key(&sid) {
                continue;
            }
            let buffer: Buffer = Arc::new(StdMutex::new(VecDeque::new()));
            feeds.insert(sid, (tokio::spawn(decode(track, buffer.clone())), buffer));
        }
        if feeds.is_empty() {
            continue;
        }
        // The output opens with the first guest and stays for the connection.
        if output.is_none() && !output_failed {
            let ring = output_ring.clone();
            match crate::sound_monitor::DeviceOutput::open_with(move |out| {
                let mut ring = lock(&ring);
                for slot in out.iter_mut() {
                    *slot = ring.pop_front().unwrap_or(0.0);
                }
            }) {
                Ok(opened) => {
                    tracing::info!("The room's guests play to {}.", opened.device_name);
                    output = Some(opened);
                }
                Err(error) => {
                    output_failed = true;
                    tracing::warn!("The room's guests cannot play here: {error:#}");
                }
            }
        }
        // One 10 ms chunk: the far end first, then out.
        let mut guards: Vec<std::sync::MutexGuard<'_, VecDeque<f32>>> =
            feeds.values().map(|(_, buffer)| lock(buffer)).collect();
        let mut buffers: Vec<&mut VecDeque<f32>> =
            guards.iter_mut().map(|guard| &mut **guard).collect();
        let chunk = mix(&mut buffers);
        drop(buffers);
        drop(guards);
        let mut far = to_i16(&chunk);
        if let Err(error) = lock(&apm).process_reverse_stream(&mut far, RATE as i32, 1) {
            tracing::debug!("A guest chunk skipped the echo canceller: {error}");
        }
        if output.is_some() {
            let mut ring = lock(&output_ring);
            for sample in chunk {
                ring.push_back(sample);
                ring.push_back(sample);
            }
            let excess = ring.len().saturating_sub(MAX_OUTPUT_FRAMES * 2);
            ring.drain(..excess);
        }
    }
    for (_, (decoder, _)) in feeds.drain() {
        decoder.abort();
    }
    drop(output);
    let mut current = lock(&APM);
    if current.as_ref().is_some_and(|held| Arc::ptr_eq(held, &apm)) {
        *current = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guests_are_played_the_runner_only_with_listen_never_an_egress_page() {
        assert!(plays("g_ada", false));
        assert!(!plays("runner:show", false));
        assert!(plays("runner:show", true));
        assert!(!plays("EG_program", true));
    }

    #[test]
    fn a_chunk_mixes_ten_milliseconds() {
        let mut a = VecDeque::from(vec![0.25; CHUNK + 10]);
        let mut b = VecDeque::from(vec![0.5; 100]);
        let chunk = mix(&mut [&mut a, &mut b]);
        assert_eq!(chunk.len(), CHUNK);
        assert_eq!(chunk[0], 0.75);
        assert_eq!(chunk[CHUNK - 1], 0.25);
        assert_eq!(a.len(), 10);
        assert!(b.is_empty());
    }

    #[test]
    fn without_playout_a_microphone_frame_is_left_as_it_is() {
        let mut frame = vec![100i16; CHUNK];
        cancel_echo(&mut frame);
        assert!(frame.iter().all(|sample| *sample == 100));
    }
}
