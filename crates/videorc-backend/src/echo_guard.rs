//! Plan 076 B: System audio re-captures the streamer's own stream.
//!
//! A streamer who opens their own live stream in a browser tab while System
//! audio is on sends the stream back into itself: ScreenCaptureKit (and WASAPI
//! loopback) capture what apps play whatever the output device, so headphones
//! do not help. Viewers hear every word again one player latency later
//! (owner stream, 2026-09-28: a Twitch tab 3.16 s behind, and a second pass at
//! 6.31 s).
//!
//! The signature is the microphone's own voice arriving in the system signal
//! a fixed 0.3–30 s later. [`EchoDetector`] looks for exactly that: the speech
//! band envelope of the last 4 s of system audio against the microphone's
//! history, one correlation per lag, every second. A loop holds one lag for as
//! long as it runs; nothing else does. Another voice, or music heard through
//! the speakers, can match at some lag for a moment, but the best lag wanders
//! from one second to the next, so four agreeing seconds are required. Lags
//! under 0.3 s are the microphone hearing the speakers, a different problem.
//!
//! Tuned on synthetic fixtures (speech-like voice, strictly periodic music,
//! recursive loops through a codec-like low-pass): every loop from 2.5 to
//! 20 s at -10 dB or louder is found within about 7–10 s of System audio
//! coming on, and 150 minutes of negatives (other voices, music, speaker
//! pickup, and their mixes) never fire.
//!
//! The bus computes one band energy per 10 ms chunk for each source
//! ([`BandEnergy`]); [`EchoWatch`] carries them to a detector thread, so no
//! correlation ever runs on the bus thread.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

/// One feature per bus chunk (10 ms).
const FRAME_MS: u32 = 10;
/// System audio compared per evaluation: 4 s.
const WINDOW: usize = 400;
/// The shortest loop considered, 0.3 s. Anything closer is the microphone
/// hearing the speakers.
const MIN_LAG: usize = 30;
/// The longest, 30 s: YouTube's normal latency.
const MAX_LAG: usize = 3_000;
const MICROPHONE_HISTORY: usize = WINDOW + MAX_LAG;
/// Evaluate every second.
const EVALUATE_EVERY: usize = 100;
/// Mean |x| of the band-limited signal counted as activity.
const SYSTEM_ACTIVE_LEVEL: f32 = 0.001_8; // about -55 dBFS
const MICROPHONE_VOICE_LEVEL: f32 = 0.005_6; // about -45 dBFS
/// At least this share of the system window is sound…
const SYSTEM_ACTIVE_SHARE: f32 = 0.3;
/// …and of the microphone window it is compared with, voice.
const MICROPHONE_VOICE_SHARE: f32 = 0.2;
/// The best lag's correlation must clear this…
const MIN_CORRELATION: f32 = 0.25;
/// …and stand this far above the 99th percentile of every other lag.
const MIN_PROMINENCE: f32 = 1.8;
/// Lags within this many frames (±300 ms) of the best, or of its double and
/// half (the loop's second pass), are the same echo, not background: an
/// envelope peak is as wide as a syllable.
const PEAK_WIDTH: usize = 30;
/// Consecutive evaluations (seconds) that must agree on the lag, within
/// ±30 ms. The first and last windows share only 1 s.
const CONFIRMATIONS: u32 = 4;
const LAG_TOLERANCE: usize = 3;

/// A confirmed loop: the microphone came back through System audio this late.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct EchoDetection {
    pub lag_ms: u32,
    pub correlation: f32,
}

/// Per-chunk energy of the speech band (about 300 Hz – 4 kHz) of an
/// interleaved stereo chunk: mono, one-pole high-pass, one-pole low-pass,
/// mean magnitude. Cheap enough for the bus thread (two multiplies per
/// sample).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct BandEnergy {
    high_pass_input: f32,
    high_pass_output: f32,
    low_pass: f32,
}
impl BandEnergy {
    // Coefficients for 48 kHz: high-pass at ~300 Hz, low-pass at ~4 kHz.
    const HIGH_PASS: f32 = 0.961;
    const LOW_PASS: f32 = 0.408;

    pub(crate) fn chunk(&mut self, interleaved: &[f32]) -> f32 {
        let frames = interleaved.len() / 2;
        if frames == 0 {
            return 0.0;
        }
        let mut sum = 0.0;
        for frame in interleaved.chunks_exact(2) {
            let mono = (frame[0] + frame[1]) * 0.5;
            self.high_pass_output =
                Self::HIGH_PASS * (self.high_pass_output + mono - self.high_pass_input);
            self.high_pass_input = mono;
            self.low_pass += Self::LOW_PASS * (self.high_pass_output - self.low_pass);
            sum += self.low_pass.abs();
        }
        sum / frames as f32
    }
}

/// The loop detector (pure: fed one energy pair per 10 ms chunk).
#[derive(Debug, Default)]
pub(crate) struct EchoDetector {
    microphone: VecDeque<f32>,
    system: VecDeque<f32>,
    since_evaluation: usize,
    candidate: Option<(usize, u32)>,
}

impl EchoDetector {
    /// One chunk. `system` is `None` while no system audio is mixed: only
    /// the microphone history grows, so a loop is found soon after System
    /// audio turns on.
    pub(crate) fn push(&mut self, microphone: f32, system: Option<f32>) -> Option<EchoDetection> {
        push_bounded(&mut self.microphone, microphone, MICROPHONE_HISTORY);
        let Some(system) = system else {
            self.system_changed();
            return None;
        };
        push_bounded(&mut self.system, system, WINDOW + 1);
        self.since_evaluation += 1;
        if self.since_evaluation < EVALUATE_EVERY || self.system.len() <= WINDOW {
            return None;
        }
        self.since_evaluation = 0;
        let Some((lag, correlation)) = self.evaluate() else {
            self.candidate = None;
            return None;
        };
        let hits = match self.candidate {
            Some((previous, hits)) if previous.abs_diff(lag) <= LAG_TOLERANCE => hits + 1,
            _ => 1,
        };
        self.candidate = Some((lag, hits));
        (hits >= CONFIRMATIONS).then_some(EchoDetection {
            lag_ms: lag as u32 * FRAME_MS,
            correlation,
        })
    }

    /// A different system source (a new slot, or none): its history no
    /// longer applies. The microphone history does.
    pub(crate) fn system_changed(&mut self) {
        self.system.clear();
        self.since_evaluation = 0;
        self.candidate = None;
    }

    /// The best lag and its correlation, when it stands out.
    fn evaluate(&self) -> Option<(usize, f32)> {
        let system = self.system.iter().copied().collect::<Vec<_>>();
        let window = &system[system.len() - WINDOW..];
        let active = self
            .system
            .iter()
            .rev()
            .take(WINDOW)
            .filter(|level| **level >= SYSTEM_ACTIVE_LEVEL)
            .count();
        if (active as f32) < SYSTEM_ACTIVE_SHARE * WINDOW as f32 {
            return None;
        }
        let microphone = self.microphone.iter().copied().collect::<Vec<_>>();
        let voice = self
            .microphone
            .iter()
            .map(|level| u32::from(*level >= MICROPHONE_VOICE_LEVEL))
            .collect::<Vec<_>>();
        let end = microphone.len();
        // Prefix sums: every lagged microphone window's mean, spread and
        // voice share in O(1).
        let mut sum = vec![0.0_f64; end + 1];
        let mut squares = vec![0.0_f64; end + 1];
        let mut voiced = vec![0_u32; end + 1];
        for index in 0..end {
            let value = f64::from(microphone[index]);
            sum[index + 1] = sum[index] + value;
            squares[index + 1] = squares[index] + value * value;
            voiced[index + 1] = voiced[index] + voice[index];
        }
        let n = WINDOW as f64;
        let system_sum: f64 = window.iter().map(|value| f64::from(*value)).sum();
        let system_mean = system_sum / n;
        let system_spread = window
            .iter()
            .map(|value| (f64::from(*value) - system_mean).powi(2))
            .sum::<f64>();
        if system_spread <= f64::EPSILON {
            return None;
        }
        let mut correlations = Vec::with_capacity(MAX_LAG);
        for lag in MIN_LAG..=MAX_LAG.min(end.saturating_sub(WINDOW)) {
            let stop = end - lag;
            let start = stop - WINDOW;
            if ((voiced[stop] - voiced[start]) as f32) < MICROPHONE_VOICE_SHARE * WINDOW as f32 {
                correlations.push((lag, 0.0));
                continue;
            }
            let mean = (sum[stop] - sum[start]) / n;
            let spread = (squares[stop] - squares[start]) - n * mean * mean;
            if spread <= f64::EPSILON {
                correlations.push((lag, 0.0));
                continue;
            }
            let cross: f64 = window
                .iter()
                .zip(&microphone[start..stop])
                .map(|(system, microphone)| {
                    (f64::from(*system) - system_mean) * f64::from(*microphone)
                })
                .sum();
            correlations.push((lag, (cross / (system_spread * spread).sqrt()) as f32));
        }
        let &(best, correlation) = correlations.iter().max_by(|a, b| a.1.total_cmp(&b.1))?;
        if correlation < MIN_CORRELATION {
            return None;
        }
        let near = |lag: usize, target: usize| lag.abs_diff(target) <= PEAK_WIDTH;
        let mut background = correlations
            .iter()
            .filter(|(lag, _)| !near(*lag, best) && !near(*lag, best * 2) && !near(*lag * 2, best))
            .map(|(_, value)| *value)
            .collect::<Vec<_>>();
        if background.is_empty() {
            return None;
        }
        let rank = (background.len() * 99 / 100).min(background.len() - 1);
        let (_, p99, _) = background.select_nth_unstable_by(rank, f32::total_cmp);
        (correlation >= MIN_PROMINENCE * p99.max(0.02)).then_some((best, correlation))
    }
}

fn push_bounded(values: &mut VecDeque<f32>, value: f32, capacity: usize) {
    if values.len() == capacity {
        values.pop_front();
    }
    values.push_back(value);
}

enum Sample {
    Chunk {
        microphone: f32,
        system: Option<f32>,
    },
    SystemChanged,
}

/// The bus's side of the detector: band energies in, a detection out. The
/// detector thread starts with the first system chunk and ends with the bus.
#[derive(Default)]
pub(crate) struct EchoWatch {
    microphone_band: BandEnergy,
    system_band: BandEnergy,
    /// Microphone energies kept on the bus until the thread starts.
    history: VecDeque<f32>,
    worker: Option<Worker>,
}
struct Worker {
    samples: mpsc::SyncSender<Sample>,
    detection: Arc<Mutex<Option<EchoDetection>>>,
}

impl EchoWatch {
    /// One written chunk: the processed microphone, and the system
    /// contribution while a slot mixes.
    pub(crate) fn chunk(&mut self, microphone: &[f32], system: Option<&[f32]>) {
        let microphone = self.microphone_band.chunk(microphone);
        let system = system.map(|system| self.system_band.chunk(system));
        if self.worker.is_none() {
            if system.is_none() {
                push_bounded(&mut self.history, microphone, MICROPHONE_HISTORY);
                return;
            }
            self.worker = spawn_worker(std::mem::take(&mut self.history));
        }
        if let Some(worker) = self.worker.as_ref() {
            // A busy detector skips a chunk rather than stall the bus.
            let _ = worker
                .samples
                .try_send(Sample::Chunk { microphone, system });
        }
    }

    /// A system slot attached or left: start its detection afresh.
    pub(crate) fn system_changed(&mut self) {
        self.system_band = BandEnergy::default();
        if let Some(worker) = self.worker.as_ref() {
            *worker.detection.lock().unwrap_or_else(|p| p.into_inner()) = None;
            let _ = worker.samples.try_send(Sample::SystemChanged);
        }
    }

    pub(crate) fn take_detection(&self) -> Option<EchoDetection> {
        self.worker.as_ref().and_then(|worker| {
            worker
                .detection
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take()
        })
    }
}

fn spawn_worker(history: VecDeque<f32>) -> Option<Worker> {
    let (samples, receiver) = mpsc::sync_channel(1_024);
    let detection = Arc::new(Mutex::new(None));
    let published = detection.clone();
    let spawned = thread::Builder::new()
        .name("videorc-echo-guard".into())
        .spawn(move || {
            let mut detector = EchoDetector::default();
            for level in history {
                detector.push(level, None);
            }
            // Ends when the bus drops its sender.
            while let Ok(sample) = receiver.recv() {
                match sample {
                    Sample::Chunk { microphone, system } => {
                        if let Some(found) = detector.push(microphone, system) {
                            *published.lock().unwrap_or_else(|p| p.into_inner()) = Some(found);
                            detector.system_changed();
                        }
                    }
                    Sample::SystemChanged => detector.system_changed(),
                }
            }
        });
    match spawned {
        Ok(_) => Some(Worker { samples, detection }),
        Err(error) => {
            tracing::warn!("The System audio echo guard could not start: {error}");
            None
        }
    }
}

/// Synthetic audio for the detector's tests and the bus's end-to-end guard
/// test: speech-like voice, strictly periodic music, and recursive loops.
#[cfg(test)]
pub(crate) mod fixtures {
    pub(crate) const RATE: usize = 48_000;

    /// Deterministic noise.
    pub(crate) struct Noise(pub(crate) u64);
    impl Noise {
        pub(crate) fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
        pub(crate) fn range(&mut self, low: f32, high: f32) -> f32 {
            low + (self.next() * 0.5 + 0.5) * (high - low)
        }
    }

    /// Speech-like mono: voiced syllables (harmonics on a wandering pitch,
    /// plus breath noise) of 80–260 ms, short gaps, and word pauses.
    pub(crate) fn speech(seconds: f32, seed: u64, level: f32) -> Vec<f32> {
        let total = (seconds * RATE as f32) as usize;
        let mut noise = Noise(seed);
        let mut out = vec![0.0; total];
        let mut position = 0;
        let mut syllables_left = 0;
        while position < total {
            if syllables_left == 0 {
                position += (noise.range(0.25, 0.9) * RATE as f32) as usize;
                syllables_left = noise.range(2.0, 7.0) as u32;
                continue;
            }
            syllables_left -= 1;
            let length = (noise.range(0.08, 0.26) * RATE as f32) as usize;
            let pitch = noise.range(95.0, 210.0);
            let loudness = level * noise.range(0.5, 1.0);
            for index in 0..length {
                let Some(slot) = out.get_mut(position + index) else {
                    break;
                };
                let t = index as f32 / RATE as f32;
                let envelope = (std::f32::consts::PI * index as f32 / length as f32).sin();
                let phase = std::f32::consts::TAU * pitch * t;
                let voiced = phase.sin()
                    + 0.6 * (2.0 * phase).sin()
                    + 0.4 * (3.0 * phase).sin()
                    + 0.3 * (5.0 * phase).sin()
                    + 0.2 * (8.0 * phase).sin();
                *slot = loudness * envelope * (0.35 * voiced + 0.25 * noise.next());
            }
            position += length + (noise.range(0.03, 0.14) * RATE as f32) as usize;
        }
        out
    }

    /// Strictly periodic music (120 BPM, one bar repeating): the worst case
    /// for a detector that correlates onsets.
    pub(crate) fn music(seconds: f32, level: f32) -> Vec<f32> {
        let total = (seconds * RATE as f32) as usize;
        let beat = RATE / 2;
        let mut noise = Noise(99);
        let hat = (0..RATE / 20).map(|_| noise.next()).collect::<Vec<_>>();
        (0..total)
            .map(|index| {
                let in_beat = index % beat;
                let bar_beat = (index / beat) % 4;
                let t = index as f32 / RATE as f32;
                let decay = (-(in_beat as f32) / (0.08 * RATE as f32)).exp();
                let kick = if bar_beat % 2 == 0 {
                    (std::f32::consts::TAU * 60.0 * t).sin() * decay
                } else {
                    0.0
                };
                let snare = if bar_beat % 2 == 1 {
                    hat[in_beat % hat.len()] * decay
                } else {
                    0.0
                };
                let hat = hat[(index % (beat / 2)) % hat.len()]
                    * (-((index % (beat / 2)) as f32) / (0.02 * RATE as f32)).exp();
                let chord = [220.0, 277.2, 329.6]
                    .iter()
                    .map(|frequency| (std::f32::consts::TAU * frequency * t).sin())
                    .sum::<f32>()
                    / 3.0;
                level * (0.5 * kick + 0.4 * snare + 0.25 * hat + 0.3 * chord)
            })
            .collect()
    }

    pub(crate) fn delayed(signal: &[f32], frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; signal.len()];
        out[frames.min(signal.len())..]
            .copy_from_slice(&signal[..signal.len().saturating_sub(frames)]);
        out
    }

    pub(crate) fn add(a: &[f32], b: &[f32], gain: f32) -> Vec<f32> {
        a.iter().zip(b).map(|(a, b)| a + gain * b).collect()
    }

    /// The loop: system = `extra` plus the stream (mic + system) played back
    /// `lag` later through a codec-ish low-pass at `gain`. Recursive, as a
    /// real loop is.
    pub(crate) fn looped(
        microphone: &[f32],
        extra: &[f32],
        lag_seconds: f32,
        gain: f32,
    ) -> Vec<f32> {
        let lag = (lag_seconds * RATE as f32) as usize;
        let mut system = extra.to_vec();
        let mut smooth = 0.0;
        for index in lag..system.len() {
            let stream = microphone[index - lag] + system[index - lag];
            smooth += 0.55 * (stream - smooth);
            system[index] += gain * smooth;
        }
        system
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    const CHUNK: usize = 480;

    fn stereo(mono: &[f32], from: usize) -> Vec<f32> {
        mono[from..from + CHUNK]
            .iter()
            .flat_map(|sample| [*sample, *sample])
            .collect()
    }

    /// Runs the detector over `microphone`, with System audio on from
    /// `system_from` seconds. Returns the first detection and when it came.
    fn run(microphone: &[f32], system: &[f32], system_from: f32) -> Option<(f32, EchoDetection)> {
        let mut detector = EchoDetector::default();
        let (mut mic_band, mut system_band) = (BandEnergy::default(), BandEnergy::default());
        let start = (system_from * 100.0) as usize;
        for chunk in 0..microphone.len() / CHUNK {
            let mic = mic_band.chunk(&stereo(microphone, chunk * CHUNK));
            let sys = (chunk >= start).then(|| system_band.chunk(&stereo(system, chunk * CHUNK)));
            if let Some(found) = detector.push(mic, sys) {
                return Some((chunk as f32 / 100.0, found));
            }
        }
        None
    }

    #[test]
    fn the_owners_twitch_loop_is_found_within_seconds_at_its_lag() {
        for (lag, gain, with_music) in [
            (3.16, 0.7, true),
            (3.16, 0.3, true),
            (3.16, 0.3, false),
            (2.5, 0.5, true),
            (8.0, 0.4, true),
            (20.0, 0.5, false),
        ] {
            let voice = speech(60.0, 7, 0.25);
            let extra = if with_music {
                music(60.0, 0.12)
            } else {
                vec![0.0; voice.len()]
            };
            let system = looped(&voice, &extra, lag, gain);
            // System audio turns on 30 s in, with the tab already playing.
            let (at, found) = run(&voice, &system, 30.0)
                .unwrap_or_else(|| panic!("lag {lag} s, gain {gain}: not found"));
            assert!(
                found.lag_ms.abs_diff((lag * 1_000.0) as u32) <= 30,
                "lag {lag} s: found {found:?}"
            );
            assert!(
                at - 30.0 <= 11.0,
                "lag {lag} s: found {:.1} s after on",
                at - 30.0
            );
        }
    }

    #[test]
    fn music_other_voices_speakers_and_silence_never_trip_it() {
        let voice = speech(90.0, 7, 0.25);
        let songs = music(90.0, 0.15);
        let other = speech(90.0, 1_234, 0.25);
        let quiet = vec![0.0; voice.len()];
        let cases: [(&str, Vec<f32>, Vec<f32>); 6] = [
            ("periodic music", voice.clone(), songs.clone()),
            (
                "another voice over music",
                voice.clone(),
                add(&other, &songs, 1.0),
            ),
            (
                "an old recording of the same kind",
                voice.clone(),
                other.clone(),
            ),
            (
                "music through speakers the mic hears",
                add(&voice, &delayed(&songs, 960), 0.3),
                songs.clone(),
            ),
            ("nothing playing", voice.clone(), quiet.clone()),
            (
                "a muted microphone with a loop",
                quiet.clone(),
                looped(&quiet, &songs, 3.16, 0.7),
            ),
        ];
        for (name, microphone, system) in cases {
            assert_eq!(run(&microphone, &system, 0.0), None, "{name}");
        }
    }

    #[test]
    fn band_energy_keeps_the_speech_band_and_drops_rumble() {
        let tone = |frequency: f32| {
            (0..CHUNK * 20)
                .map(|index| {
                    0.5 * (std::f32::consts::TAU * frequency * index as f32 / RATE as f32).sin()
                })
                .collect::<Vec<_>>()
        };
        let level = |signal: &[f32]| {
            let mut band = BandEnergy::default();
            (0..20)
                .map(|chunk| band.chunk(&stereo(signal, chunk * CHUNK)))
                .last()
                .unwrap()
        };
        // A 0.5 sine's mean magnitude is 0.318.
        let (rumble, voice, hiss) = (
            level(&tone(30.0)),
            level(&tone(1_000.0)),
            level(&tone(15_000.0)),
        );
        assert!(rumble < 0.04, "30 Hz rumble {rumble}");
        assert!(voice > 0.2, "1 kHz {voice}");
        // One pole: about -10 dB at 15 kHz, enough to keep cymbals from
        // dominating the envelope.
        assert!(hiss < 0.12, "15 kHz hiss {hiss}");
    }
}
