//! Disabled S7a synthetic microphone. No device, recording, RNNoise or speaker tap.
//! Pull credits bound delivery: at most four 10 ms blocks are represented by
//! indices, one block allocated per pull; late pulls discard oldest blocks.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
static ACTIVE_SOURCES: AtomicUsize = AtomicUsize::new(0);
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
    samples: Vec<f32>,
}
#[derive(Default)]
pub struct Bridge {
    last_generation: u64,
    active: Option<Source>,
}
struct Source {
    generation: u64,
    start: Instant,
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
    ) -> Result<Option<Frame>, &'static str> {
        if command.generation == 0
            || command.generation > 9_007_199_254_740_991
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
                self.active = Some(Source {
                    generation: command.generation,
                    start: now,
                    next: 0,
                    dropped: 0,
                });
                Ok(None)
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
                let due = now.duration_since(source.start).as_micros() as u64 / 10_000;
                if due <= source.next {
                    return Ok(None);
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
                Ok(Some(Frame {
                    generation: source.generation,
                    sequence,
                    first_sample: sequence * 480,
                    first_sample_us: sequence * 10_000,
                    observed_at_us: now.duration_since(source.start).as_micros() as u64,
                    sample_rate: 48_000,
                    channels: 1,
                    frames: 480,
                    dropped_frames: source.dropped,
                    samples,
                }))
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
    #[test]
    fn pull_clock_bounds_and_epochs() {
        let now = Instant::now();
        let mut bridge = Bridge::default();
        bridge.command(command("open", 1), now).unwrap();
        assert!(bridge.command(command("pull", 1), now).unwrap().is_none());
        let frame = bridge
            .command(command("pull", 1), now + Duration::from_secs(1))
            .unwrap()
            .unwrap();
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
        let now = Instant::now();
        let mut bridge = Bridge::default();
        bridge.command(command("open", 1), now).unwrap();
        let frame = bridge
            .command(command("pull", 1), now + Duration::from_millis(10))
            .unwrap()
            .unwrap();
        let json = serde_json::to_value(frame).unwrap();
        for key in ["sampleRate", "channels", "frames"] {
            assert_eq!(json[key], fixture[key]);
        }
        assert_eq!(json["firstSample"], 0);
        assert_eq!(json["firstSampleUs"], 0);
        assert_eq!(json["observedAtUs"], 10_000);
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
