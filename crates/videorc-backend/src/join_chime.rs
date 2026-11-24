//! "Ada wants to join" rings on the host's computer (owner, 2026-11-19; plan
//! 260 S1.3c moves it here from the renderer's `lib/join-request-chime.ts`).
//! The same two rising notes a fifth apart, the same envelopes and level,
//! synthesized once to the monitor's PCM and played through the soundboard
//! monitor's output (`sound_monitor.rs`): the system output only. It never
//! reaches the room, the program or a recording: System audio capture runs in
//! this process with `excludesCurrentProcessAudio`, as for the monitor.
//!
//! macOS only for now: the monitor has no output on Windows or Linux yet, so
//! their renderer still rings it (`rendererPlaysJoinChime`).

use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use crate::state::AppState;

/// Requests that land together (one poll, a group link) ring once.
const MIN_GAP: Duration = Duration::from_millis(2_000);

/// The monitor's format: interleaved stereo s16 at 48 kHz.
const SAMPLE_RATE: f64 = 48_000.0;

/// Two rising notes, a fifth apart: a doorbell, soft enough to talk over.
/// (frequency Hz, start s, length s), as `JOIN_CHIME_NOTES`.
const NOTES: [(f64, f64, f64); 2] = [(659.25, 0.0, 0.35), (987.77, 0.14, 0.55)];
const PEAK_GAIN: f64 = 0.25;
/// Silence for an exponential ramp, which can't reach zero.
const FLOOR_GAIN: f64 = 0.0001;
const ATTACK_S: f64 = 0.012;
/// The renderer scheduled the notes 10 ms ahead and stopped each 20 ms after
/// its ramp ended.
const LEAD_S: f64 = 0.01;
const TAIL_S: f64 = 0.02;

/// The monitor key the chime plays under: outside the player's voice keys,
/// so the player's own updates never stop it.
pub(crate) const CHIME_MONITOR_KEY: u64 = u64::MAX - 1;

/// The chime's gain at `t` seconds into one note (`exponentialRampToValueAtTime`
/// from the floor to the peak over the attack, then back to the floor).
fn envelope(t: f64, length: f64) -> f64 {
    let ramp =
        |from: f64, to: f64, progress: f64| from * (to / from).powf(progress.clamp(0.0, 1.0));
    if t < 0.0 {
        0.0
    } else if t < ATTACK_S {
        ramp(FLOOR_GAIN, PEAK_GAIN, t / ATTACK_S)
    } else if t < length {
        ramp(PEAK_GAIN, FLOOR_GAIN, (t - ATTACK_S) / (length - ATTACK_S))
    } else if t < length + TAIL_S {
        FLOOR_GAIN
    } else {
        0.0
    }
}

/// The chime as the monitor plays it, made once.
pub(crate) fn chime_pcm() -> Arc<[i16]> {
    static PCM: OnceLock<Arc<[i16]>> = OnceLock::new();
    PCM.get_or_init(|| {
        let end = NOTES
            .iter()
            .map(|(_, at, length)| LEAD_S + at + length + TAIL_S)
            .fold(0.0, f64::max);
        // To the nearest frame: 0.01 + 0.14 + 0.55 + 0.02 is 0.7200000000000001
        // in f64, and a ceiling would add a frame.
        let frames = (end * SAMPLE_RATE).round() as usize;
        let mut pcm = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let t = frame as f64 / SAMPLE_RATE;
            let sample: f64 = NOTES
                .iter()
                .map(|(hz, at, length)| {
                    let local = t - LEAD_S - at;
                    let phase = 2.0 * std::f64::consts::PI * hz * local.max(0.0);
                    envelope(local, *length) * phase.sin()
                })
                .sum();
            let value = (sample.clamp(-1.0, 1.0) * f64::from(i16::MAX)).round() as i16;
            pcm.push(value);
            pcm.push(value);
        }
        Arc::from(pcm)
    })
    .clone()
}

/// Rings for a new request unless one already rang within the gap. Whether
/// it played (false where the backend has no output, or within the gap).
pub(crate) fn ring(state: &AppState) -> bool {
    static LAST_RANG: StdMutex<Option<Instant>> = StdMutex::new(None);
    if !cfg!(target_os = "macos") {
        return false;
    }
    {
        let mut last = LAST_RANG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if last.is_some_and(|at| now.duration_since(at) < MIN_GAP) {
            return false;
        }
        *last = Some(now);
    }
    state.soundboard.play_cue(CHIME_MONITOR_KEY, chime_pcm())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chime_is_two_notes_at_the_renderers_level_and_length() {
        let pcm = chime_pcm();
        // 10 ms lead + 140 ms + 550 ms + 20 ms tail, stereo.
        assert_eq!(pcm.len(), 34_560 * 2);
        let peak = pcm
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap();
        // One note alone peaks at 0.25; the overlap stays under 0.5.
        assert!(peak > 6_000 && peak < 16_500, "{peak}");
        // Silent before the first note (the 10 ms lead) and at the floor
        // gain (-80 dB) by the end.
        assert!(pcm[..2 * 400].iter().all(|sample| *sample == 0));
        assert!(
            pcm[pcm.len() - 2..]
                .iter()
                .all(|sample| sample.unsigned_abs() < 10)
        );
        // Left and right are the same.
        assert!(pcm.chunks_exact(2).all(|frame| frame[0] == frame[1]));
    }

    #[test]
    fn the_envelope_rises_over_the_attack_and_falls_to_the_floor() {
        assert_eq!(envelope(-0.001, 0.35), 0.0);
        assert!((envelope(ATTACK_S, 0.35) - PEAK_GAIN).abs() < 1e-6);
        assert!(envelope(0.2, 0.35) < PEAK_GAIN && envelope(0.2, 0.35) > FLOOR_GAIN);
        assert!((envelope(0.35, 0.35) - FLOOR_GAIN).abs() < 1e-9);
        assert_eq!(envelope(0.35 + TAIL_S, 0.35), 0.0);
    }
}
