//! Disabled S7a synthetic microphone. No device, recording, RNNoise or speaker tap.
//! Pull credits bound delivery: at most four 10 ms blocks are represented by
//! indices, one block allocated per pull; late pulls discard oldest blocks.
//!
//! Clock (Plan 249 S13a): `firstSampleUs` is the synthetic timeline position
//! and `observedAtUs` the actual native pull time, both relative to the
//! generation epoch (`Source.start`). `originUs` is that same epoch measured
//! from the process anchor in `room_clock` (absent, never zero, when
//! unavailable) and `incarnation` names the backend process it belongs to.
//! Absolute native time = `originUs + firstSampleUs`; audio and video pair by
//! origin only within one incarnation. The open reply and every frame carry both.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
static ACTIVE_SOURCES: AtomicUsize = AtomicUsize::new(0);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub fn active_sources() -> usize {
    ACTIVE_SOURCES.load(Ordering::SeqCst)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub action: String,
    pub generation: u64,
    role: String,
    sample_rate: u32,
    channels: u32,
    frames: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    generation: u64,
    sequence: u64,
    first_sample: u64,
    first_sample_us: u64,
    observed_at_us: u64,
    sample_rate: u32,
    channels: u32,
    frames: u32,
    dropped_frames: u64,
    // Never skipped: absent serializes as null, never as 0 or a missing key.
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    samples: Vec<f32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    generation: u64,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum Reply {
    Opened(Opened),
    Frame(Frame),
}
#[derive(Default)]
pub struct Bridge {
    last_generation: u64,
    active: Option<Source>,
}
struct Source {
    generation: u64,
    start: Instant,
    // Captured once from `start`; never a second epoch.
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    next: u64,
    dropped: u64,
}
impl Drop for Source {
    fn drop(&mut self) {
        ACTIVE_SOURCES.fetch_sub(1, Ordering::SeqCst);
    }
}
// The first 280 ms of each second carry a sync tone and 12-bit second ID.
// IDs let the receiver distinguish delayed/repeated pulses from current audio.
fn fixture_sample(sample: u64) -> f32 {
    let position = sample % 48_000;
    if position < 48 {
        return 0.5;
    }
    let (hz, amplitude) = if position < 1920 {
        (3500.0, 0.4)
    } else if position < 13_440 {
        let bit = 11 - (position - 1920) / 960;
        let second = sample / 48_000;
        (
            if (second >> bit) & 1 == 0 {
                1500.0
            } else {
                2500.0
            },
            0.4,
        )
    } else {
        (440.0, 0.1)
    };
    (std::f64::consts::TAU * hz * sample as f64 / 48_000.0).sin() as f32 * amplitude
}
impl Bridge {
    pub fn command(
        &mut self,
        command: Command,
        now: Instant,
    ) -> Result<Option<Reply>, &'static str> {
        if command.generation == 0
            || command.generation > MAX_SAFE_INTEGER
            || command.role != "host-microphone-test"
            || command.sample_rate != 48_000
            || command.channels != 1
            || command.frames != 480
        {
            return Err("Invalid PCM contract");
        }
        match command.action.as_str() {
            "open" => {
                if self.active.is_some() || command.generation <= self.last_generation {
                    return Err("Stale or already open PCM generation");
                }
                self.last_generation = command.generation;
                ACTIVE_SOURCES.fetch_add(1, Ordering::SeqCst);
                let source = Source {
                    generation: command.generation,
                    start: now,
                    origin_us: crate::room_clock::origin_us(now),
                    incarnation: crate::room_clock::incarnation(),
                    next: 0,
                    dropped: 0,
                };
                let opened = Opened {
                    generation: source.generation,
                    origin_us: source.origin_us,
                    incarnation: source.incarnation,
                };
                self.active = Some(source);
                Ok(Some(Reply::Opened(opened)))
            }
            "close" => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.generation != command.generation)
                {
                    return Err("Stale PCM generation");
                }
                self.active = None;
                Ok(None)
            }
            "pull" => {
                let source = self.active.as_mut().ok_or("PCM source closed")?;
                if source.generation != command.generation {
                    return Err("Stale PCM generation");
                }
                let observed_at_us = now.duration_since(source.start).as_micros() as u64;
                let due = observed_at_us / 10_000;
                if due <= source.next {
                    return Ok(None);
                }
                // Checked before mutation or sample allocation; JS readers add these.
                if source.origin_us.is_some_and(|origin| {
                    origin
                        .checked_add(observed_at_us)
                        .is_none_or(|sum| sum > MAX_SAFE_INTEGER)
                }) {
                    return Err("PCM clock exceeds its bound");
                }
                if due - source.next > 4 {
                    source.dropped += (due - source.next - 4) * 480;
                    source.next = due - 4;
                }
                let sequence = source.next;
                source.next += 1;
                let samples = (0..480)
                    .map(|i| fixture_sample(sequence * 480 + i))
                    .collect();
                Ok(Some(Reply::Frame(Frame {
                    generation: source.generation,
                    sequence,
                    first_sample: sequence * 480,
                    first_sample_us: sequence * 10_000,
                    observed_at_us,
                    sample_rate: 48_000,
                    channels: 1,
                    frames: 480,
                    dropped_frames: source.dropped,
                    origin_us: source.origin_us,
                    incarnation: source.incarnation,
                    samples,
                })))
            }
            _ => Err("Invalid PCM action"),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn command(action: &str, generation: u64) -> Command {
        Command {
            action: action.into(),
            generation,
            role: "host-microphone-test".into(),
            sample_rate: 48_000,
            channels: 1,
            frames: 480,
        }
    }
    fn frame(reply: Option<Reply>) -> Frame {
        match reply {
            Some(Reply::Frame(frame)) => frame,
            _ => panic!("expected a PCM frame"),
        }
    }
    fn opened(reply: Option<Reply>) -> Opened {
        match reply {
            Some(Reply::Opened(opened)) => opened,
            _ => panic!("expected an open reply"),
        }
    }
    #[test]
    fn pull_clock_bounds_and_epochs() {
        let now = Instant::now();
        let mut bridge = Bridge::default();
        bridge.command(command("open", 1), now).unwrap();
        assert!(bridge.command(command("pull", 1), now).unwrap().is_none());
        let frame = frame(
            bridge
                .command(command("pull", 1), now + Duration::from_secs(1))
                .unwrap(),
        );
        assert_eq!(frame.sequence, 96);
        assert_eq!(frame.dropped_frames, 96 * 480);
        assert_eq!(frame.samples.len(), 480);
        assert_eq!(frame.first_sample_us, 960_000);
        assert!(bridge.command(command("pull", 2), now).is_err());
        bridge.command(command("close", 1), now).unwrap();
        assert!(bridge.command(command("open", 1), now).is_err());
        bridge.command(command("open", 2), now).unwrap();
    }
    #[test]
    fn shared_fixture_matches_native_wire_and_clock() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol-fixtures/room-pcm.json")).unwrap();
        assert_eq!(fixture["role"], "host-microphone-test");
        assert_eq!(fixture["sampleRate"], 48_000);
        assert_eq!(fixture["frames"], 480);
        assert_eq!(fixture["queueFrames"], 1920);
        assert_eq!(fixture["productionQualified"], false);
        assert_eq!(fixture["marker"]["syncHz"], 3500);
        assert_eq!(fixture["marker"]["zeroHz"], 1500);
        assert_eq!(fixture["marker"]["oneHz"], 2500);
        assert_eq!(fixture["marker"]["bits"], 12);
        assert_eq!(fixture["marker"]["frames"], 13_440);
        assert_eq!(fixture_sample(0), 0.5);
        assert_eq!(fixture_sample(48_000), 0.5);
        assert_eq!(fixture["clock"]["timeline"], "synthetic");
        assert!(fixture["clock"]["absent"].is_null());
        let now = Instant::now();
        let mut bridge = Bridge::default();
        let open = serde_json::to_value(bridge.command(command("open", 1), now).unwrap()).unwrap();
        let frame = frame(
            bridge
                .command(command("pull", 1), now + Duration::from_millis(10))
                .unwrap(),
        );
        let json = serde_json::to_value(frame).unwrap();
        for key in ["sampleRate", "channels", "frames"] {
            assert_eq!(json[key], fixture[key]);
        }
        assert_eq!(json["firstSample"], 0);
        assert_eq!(json["firstSampleUs"], 0);
        assert_eq!(json["observedAtUs"], 10_000);
        assert_eq!(open["generation"], 1);
        for field in fixture["clock"]["fields"].as_array().unwrap() {
            let field = field.as_str().unwrap();
            // Present on the wire as a number or null; never skipped, never 0.
            assert!(open.as_object().unwrap().contains_key(field));
            assert!(json.as_object().unwrap().contains_key(field));
            assert_eq!(json[field], open[field], "one origin per generation");
        }
        assert!(json["incarnation"].is_null() || json["incarnation"].as_u64() > Some(0));
        assert!(!json["originUs"].is_u64() || !json["incarnation"].is_null());
    }

    #[test]
    fn absent_origin_serializes_as_null_never_zero() {
        let json = serde_json::to_value(Reply::Opened(Opened {
            generation: 3,
            origin_us: None,
            incarnation: None,
        }))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "generation": 3, "originUs": null, "incarnation": null })
        );
    }

    #[test]
    fn origin_reuses_the_generation_epoch_and_bounds_the_sum() {
        crate::room_clock::init();
        let now = Instant::now();
        let mut bridge = Bridge::default();
        let opened = opened(bridge.command(command("open", 1), now).unwrap());
        assert_eq!(opened.origin_us, crate::room_clock::origin_us(now));
        assert!(opened.origin_us.is_some());
        assert_eq!(opened.incarnation, crate::room_clock::incarnation());
        let first = frame(
            bridge
                .command(command("pull", 1), now + Duration::from_millis(20))
                .unwrap(),
        );
        assert_eq!(first.origin_us, opened.origin_us);
        assert_eq!(first.incarnation, opened.incarnation);
        let source = bridge.active.as_mut().unwrap();
        source.origin_us = Some(MAX_SAFE_INTEGER - 5_000);
        let next = source.next;
        assert!(
            bridge
                .command(command("pull", 1), now + Duration::from_millis(40))
                .is_err()
        );
        assert_eq!(bridge.active.as_ref().unwrap().next, next);
    }

    #[test]
    fn invalid_contract_never_opens() {
        let mut bridge = Bridge::default();
        let mut request = command("open", 1);
        request.frames = u32::MAX;
        assert!(bridge.command(request, Instant::now()).is_err());
        assert!(bridge.active.is_none());
    }
}
