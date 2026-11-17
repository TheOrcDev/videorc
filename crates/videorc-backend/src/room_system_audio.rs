//! Room-owned, opt-in own-app-excluded capture. No encoder/session or speaker fallback.
//!
//! Clock (Plan 249 S13a): the generation's epoch is taken once when the
//! capture opens. The open reply and every frame carry `originUs` (that epoch
//! measured from the `room_clock` anchor) and `incarnation`, both null when
//! unavailable and never zero. `firstSampleUs` and `observedAtUs` stay
//! relative to the epoch. `originUs + firstSampleUs` is the CAPTURE timeline:
//! the native capture time of the first sample, with a discontinuity kept as
//! a jump (not the processed timeline of the microphone). No drift, latency or
//! A/V alignment is measured or claimed.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
/// JavaScript readers add `originUs + observedAtUs`; never past this.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static CLAIMED: AtomicBool = AtomicBool::new(false);
pub(crate) fn sources() -> usize {
    usize::from(CLAIMED.load(Ordering::Acquire))
}
pub(crate) fn cleanup_ready() -> bool {
    let until = Instant::now() + Duration::from_secs(5);
    while sources() > 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    sources() == 0
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Command {
    action: String,
    generation: u64,
    show_id: String,
    role: String,
    sample_rate: u32,
    channels: u32,
    frames: u32,
}
impl Command {
    fn valid(&self) -> bool {
        self.generation > 0
            && self.generation <= 9_007_199_254_740_991
            && !self.show_id.is_empty()
            && self.show_id.len() <= 128
            && self.role == "host-system-audio"
            && self.sample_rate == 48000
            && self.channels == 2
            && self.frames == 480
            && matches!(self.action.as_str(), "open" | "pull" | "close")
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    generation: u64,
    sequence: u64,
    first_sample: u64,
    first_sample_us: u64,
    observed_at_us: u64,
    dropped_frames: u64,
    sample_rate: u32,
    channels: u32,
    frames: u32,
    // Never skipped: absent serializes as null, never as 0 or a missing key.
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    samples: Vec<f32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened {
    generation: u64,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
}
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum Reply {
    Opened(Opened),
    Frame(Frame),
}
/// The generation's epoch and its place on the shared anchor, fixed for its life.
#[derive(Clone, Copy)]
struct Clock {
    epoch: Instant,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
}
impl Clock {
    fn now() -> Self {
        let epoch = Instant::now();
        Self {
            epoch,
            origin_us: crate::room_clock::origin_us(epoch),
            incarnation: crate::room_clock::incarnation(),
        }
    }
    /// Refuses a pull whose `originUs + observedAtUs` would pass 2^53 - 1.
    fn readable(&self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.epoch).as_micros() as u64;
        self.origin_us.is_none_or(|origin| {
            origin
                .checked_add(elapsed)
                .is_some_and(|sum| sum <= MAX_SAFE_INTEGER)
        })
    }
}
#[derive(Default)]
struct Queue {
    frames: VecDeque<Frame>,
    failure: Option<String>,
    dropped: u64,
}
impl Queue {
    fn push(&mut self, mut frame: Frame) {
        if self.frames.len() == 4 {
            self.frames.pop_front();
            self.dropped += 480;
        }
        frame.dropped_frames += self.dropped;
        self.frames.push_back(frame);
    }
}
struct Tap {
    stop: Arc<AtomicBool>,
    queue: Arc<Mutex<Queue>>,
    clock: Clock,
}
impl Drop for Tap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub(crate) struct Bridge {
    tap: Option<Tap>,
    generation: u64,
    show_id: String,
}
impl Bridge {
    pub(crate) async fn command(
        &mut self,
        state: &AppState,
        command: Command,
    ) -> anyhow::Result<Option<Reply>> {
        anyhow::ensure!(command.valid(), "Invalid system audio contract");
        if command.action == "close" {
            anyhow::ensure!(
                self.generation == command.generation && self.show_id == command.show_id,
                "Stale system owner"
            );
            self.tap.take();
            anyhow::ensure!(
                tokio::task::spawn_blocking(cleanup_ready).await?,
                "System capture cleanup unconfirmed"
            );
            return Ok(None);
        }
        let owns_room = || {
            crate::cloud_show::lock(&state.cloud_show)
                .talk_show_room_show_id()
                .as_deref()
                == Some(command.show_id.as_str())
        };
        if !owns_room() {
            self.tap.take();
            anyhow::bail!("System audio room owner lost");
        }
        if command.action == "open" {
            anyhow::ensure!(
                self.tap.is_none() && command.generation > self.generation,
                "Stale system generation"
            );
            let tap = open(command.generation).await?;
            anyhow::ensure!(owns_room(), "Room closed while system capture opened");
            let opened = Opened {
                generation: command.generation,
                origin_us: tap.clock.origin_us,
                incarnation: tap.clock.incarnation,
            };
            self.tap = Some(tap);
            self.generation = command.generation;
            self.show_id = command.show_id;
            return Ok(Some(Reply::Opened(opened)));
        }
        anyhow::ensure!(
            self.generation == command.generation && self.show_id == command.show_id,
            "Stale system owner"
        );
        let tap = self
            .tap
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("System capture closed"))?;
        // Refused before draining: a frame is never taken and then dropped.
        anyhow::ensure!(
            tap.clock.readable(Instant::now()),
            "System audio clock exceeds its bound"
        );
        let mut q = tap.queue.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(reason) = &q.failure {
            anyhow::bail!("System audio unavailable: {reason}");
        }
        Ok(q.frames.pop_front().map(Reply::Frame))
    }
}
#[cfg(not(any(target_os = "macos", windows)))]
async fn open(_generation: u64) -> anyhow::Result<Tap> {
    anyhow::bail!("Own-app-excluded system capture is unavailable on this platform")
}
#[cfg(any(target_os = "macos", windows))]
async fn open(generation: u64) -> anyhow::Result<Tap> {
    use crate::system_audio_capture::{SystemAudioCapture, SystemAudioCaptureOptions};
    anyhow::ensure!(
        CLAIMED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok(),
        "System capture already owned or cleanup unconfirmed"
    );
    let tap = Tap {
        stop: Arc::new(AtomicBool::new(false)),
        queue: Arc::new(Mutex::new(Queue::default())),
        clock: Clock::now(),
    };
    let stop = tap.stop.clone();
    let queue = tap.queue.clone();
    let clock = tap.clock;
    let (started, ready) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("room-system-audio".into())
        .spawn(move || {
            let origin = clock.epoch;
            // Platform defaults exclude Videorc's process tree / bundle and Electron parent.
            // A small producer queue and four output chunks bound this lane independently of IPC.
            let options = SystemAudioCaptureOptions {
                queue_capacity: 4,
                ..Default::default()
            };
            let mut capture = match SystemAudioCapture::start(options) {
                Ok(capture) => capture,
                Err(error) => {
                    CLAIMED.store(false, Ordering::Release);
                    let _ = started.send(Err(error.to_string()));
                    return;
                }
            };
            // Excluding only the backend is insufficient: Electron owns the monitor.
            if !capture.info().pid_excluded {
                if capture.stop() {
                    CLAIMED.store(false, Ordering::Release);
                }
                let _ = started.send(Err("Own-app parent exclusion is unconfirmed".into()));
                return;
            }
            let receiver = capture.take_receiver().expect("new capture owns receiver");
            if started.send(Ok(())).is_err() {
                stop.store(true, Ordering::Release);
            }
            let mut pending = VecDeque::<f32>::with_capacity(960);
            let mut cursor = 0u64;
            let mut sequence = 0u64;
            let mut expected_end = None;
            while !stop.load(Ordering::Acquire) {
                if let Some(failure) = capture.failure() {
                    queue.lock().unwrap_or_else(|p| p.into_inner()).failure =
                        Some(failure.to_string());
                    break;
                }
                let input = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(frame) => frame,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue, // Silence is not loss.
                    Err(_) => {
                        queue.lock().unwrap_or_else(|p| p.into_inner()).failure =
                            Some("Capture disconnected".into());
                        break;
                    }
                };
                if input.sample_rate != 48000
                    || input.channels != 2
                    || input.samples.len() % 2 != 0
                    || input.samples.len() > 48000 * 2
                    || input.samples.iter().any(|v| !v.is_finite())
                {
                    queue.lock().unwrap_or_else(|p| p.into_inner()).failure =
                        Some("Invalid capture format".into());
                    break;
                }
                let captured = input
                    .captured_at
                    .checked_sub(input.duration())
                    .unwrap_or(input.captured_at);
                let start = (captured.saturating_duration_since(origin).as_nanos() * 48000
                    / 1_000_000_000) as u64;
                // Preserve a discontinuity rather than repeating data or hiding source stalls.
                if expected_end.is_none_or(|end: u64| end.abs_diff(start) > 48) {
                    let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
                    q.dropped += (pending.len() / 2) as u64;
                    pending.clear();
                    cursor = start;
                }
                expected_end = Some(start + input.frame_count() as u64);
                for pair in input.samples.chunks_exact(2) {
                    pending.extend(pair.iter().map(|v| v.clamp(-1.0, 1.0)));
                    if pending.len() == 960 {
                        let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
                        let dropped = capture.stats().dropped_frames;
                        q.push(Frame {
                            generation,
                            sequence,
                            first_sample: cursor,
                            first_sample_us: cursor * 1_000_000 / 48000,
                            observed_at_us: origin.elapsed().as_micros() as u64,
                            dropped_frames: dropped,
                            sample_rate: 48000,
                            channels: 2,
                            frames: 480,
                            origin_us: clock.origin_us,
                            incarnation: clock.incarnation,
                            samples: pending.drain(..).collect(),
                        });
                        cursor += 480;
                        sequence += 1;
                    }
                }
            }
            // A failed native stop is quarantined: never report zero or allow a successor.
            if capture.stop() {
                CLAIMED.store(false, Ordering::Release);
            } else {
                queue.lock().unwrap_or_else(|p| p.into_inner()).failure =
                    Some("Native stop acknowledgement unavailable; restart required".into());
            }
        });
    if let Err(error) = spawned {
        CLAIMED.store(false, Ordering::Release);
        return Err(error.into());
    }
    ready
        .await
        .map_err(|_| anyhow::anyhow!("System capture startup lost"))?
        .map_err(anyhow::Error::msg)?;
    Ok(tap)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_consumer_keeps_four_newest_chunks_with_explicit_loss() {
        let mut queue = Queue::default();
        for sequence in 0..8 {
            queue.push(Frame {
                generation: 1,
                sequence,
                first_sample: sequence * 480,
                first_sample_us: sequence * 10000,
                observed_at_us: (sequence + 1) * 10000,
                dropped_frames: 0,
                sample_rate: 48000,
                channels: 2,
                frames: 480,
                origin_us: None,
                incarnation: None,
                samples: vec![0.0; 960],
            });
        }
        assert_eq!(queue.frames.len(), 4);
        assert_eq!(queue.frames.front().unwrap().sequence, 4);
        assert_eq!(queue.frames.back().unwrap().dropped_frames, 1920);
        assert_eq!(queue.dropped, 1920);
    }
    #[test]
    fn bounded_stereo_command_rejects_wrong_roles_rates_and_extra_keys() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/room-system-audio.json"
        ))
        .unwrap();
        let mut c: Command = serde_json::from_value(fixture["open"].clone()).unwrap();
        assert!(c.valid());
        c.channels = 1;
        assert!(!c.valid());
        c.channels = 2;
        c.frames = 481;
        assert!(!c.valid());
        let mut value = fixture["open"].clone();
        value["captureSpeakers"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<Command>(value).is_err());
    }
    #[test]
    fn open_reply_and_frames_carry_the_shared_nullable_clock() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/room-system-audio.json"
        ))
        .unwrap();
        assert_eq!(fixture["clockQualification"], "unavailable");
        assert_eq!(fixture["clock"]["timeline"], "capture");
        assert!(fixture["clock"]["absent"].is_null());
        let absent = serde_json::to_value(Reply::Opened(Opened {
            generation: 2,
            origin_us: None,
            incarnation: None,
        }))
        .unwrap();
        assert_eq!(
            absent,
            serde_json::json!({ "generation": 2, "originUs": null, "incarnation": null })
        );
        let frame = serde_json::to_value(Reply::Frame(Frame {
            generation: 2,
            sequence: 3,
            first_sample: 1440,
            first_sample_us: 30_000,
            observed_at_us: 70_000,
            dropped_frames: 0,
            sample_rate: 48000,
            channels: 2,
            frames: 480,
            origin_us: Some(1_000_000),
            incarnation: Some(9),
            samples: vec![0.0; 960],
        }))
        .unwrap();
        for field in fixture["clock"]["fields"].as_array().unwrap() {
            let field = field.as_str().unwrap();
            assert!(absent.as_object().unwrap().contains_key(field));
            assert!(frame.as_object().unwrap().contains_key(field));
        }
        assert_eq!(frame["originUs"], 1_000_000);
        assert_eq!(frame["incarnation"], 9);
    }
    #[test]
    fn the_clock_uses_the_shared_anchor_and_refuses_unsafe_sums() {
        crate::room_clock::init();
        let clock = Clock::now();
        assert_eq!(clock.origin_us, crate::room_clock::origin_us(clock.epoch));
        assert!(clock.origin_us.is_some() && clock.incarnation.is_some());
        assert!(clock.readable(Instant::now()));
        let edge = Clock {
            origin_us: Some(MAX_SAFE_INTEGER - 45_000),
            ..clock
        };
        assert!(edge.readable(clock.epoch));
        assert!(!edge.readable(clock.epoch + Duration::from_millis(50)));
        let absent = Clock {
            origin_us: None,
            incarnation: None,
            ..clock
        };
        assert!(absent.readable(clock.epoch + Duration::from_secs(3600)));
    }
}
