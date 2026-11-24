//! Sound check's verdict and "Set level for me" (`lib/first-run-sound.ts`,
//! plan 207 S6), over the meter's post-Gain peaks, so the verdict always
//! describes what the recording will hear.

/// A peak above this counts as speech, not room noise.
pub const SPEECH_DB: f64 = -45.0;
/// The verdict reads the last 8 s.
pub const WINDOW_MS: i64 = 8_000;
/// Speech needed inside the window before there is a verdict.
pub const SPEECH_MS: i64 = 3_000;
/// "Set level for me" puts speech peaks here: the middle of the meter's
/// speech zone (−20 to −9).
pub const TARGET_DB: f64 = -12.0;
/// Speech peaking below this reads "A bit quiet".
pub const QUIET_BELOW_DB: f64 = -24.0;
/// Speech peaking above this reads "Too loud".
pub const LOUD_ABOVE_DB: f64 = -8.0;
/// The microphone Gain fader's range.
pub const MICROPHONE_GAIN_MIN_DB: f64 = -24.0;
pub const MICROPHONE_GAIN_MAX_DB: f64 = 24.0;
/// `CLIP_THRESHOLD_DB` (`audio/zones.ts`): the clip light.
pub const CLIP_THRESHOLD_DB: f64 = -1.0;
/// A gap between readings longer than this never counts as speech time.
const MAX_SAMPLE_SPAN_MS: i64 = 200;
const SPEECH_PERCENTILE: f64 = 0.9;

/// `SoundCheckVerdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    None,
    Quiet,
    Good,
    Loud,
}

impl Verdict {
    /// `SOUND_CHECK_COPY`: the line under the meter.
    pub fn copy(self) -> &'static str {
        match self {
            Verdict::None => "Say something. The bar moves when Videorc hears you.",
            Verdict::Quiet => "A bit quiet. Raise Gain or move closer.",
            Verdict::Good => "Sounds good.",
            Verdict::Loud => "Too loud. Lower Gain.",
        }
    }
}

/// `SoundCheckSample`: one meter reading.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    /// When it arrived, in ms.
    pub at: i64,
    /// The loudest channel's peak, dBFS, after Gain.
    pub peak_db: f64,
}

/// `SoundCheckReading`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub verdict: Verdict,
    /// The 90th-percentile speech peak, once there is a verdict.
    pub speech_peak_db: Option<f64>,
}

/// `framePeakDb`: the loudest channel of one meter update; −∞ with none.
pub fn frame_peak_db(channel_peaks: &[f64]) -> f64 {
    channel_peaks
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, |peak, channel| {
            if channel > peak { channel } else { peak }
        })
}

/// `addSoundCheckSample`: the window with one more reading, the oldest
/// dropped. A reading that is not a number (NaN, +∞) is skipped; silence
/// (−∞) is kept.
pub fn add_sample(samples: &[Sample], sample: Sample) -> Vec<Sample> {
    let since = sample.at - WINDOW_MS;
    let mut kept: Vec<Sample> = samples
        .iter()
        .copied()
        .filter(|entry| entry.at > since && entry.at <= sample.at)
        .collect();
    if sample.peak_db.is_finite() || sample.peak_db == f64::NEG_INFINITY {
        kept.push(sample);
    }
    kept
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((fraction * sorted.len() as f64).ceil() as i64 - 1)
        .clamp(0, sorted.len() as i64 - 1) as usize;
    sorted[index]
}

/// `soundCheckReading`: what the last 8 s say. A clip reads "loud" at once
/// (with speech heard); otherwise there is no verdict until 3 s of speech,
/// and then the 90th-percentile speech peak decides.
pub fn reading(samples: &[Sample], now: i64) -> Reading {
    let window: Vec<Sample> = samples
        .iter()
        .copied()
        .filter(|sample| sample.at > now - WINDOW_MS && sample.at <= now)
        .collect();
    let mut speech_peaks = Vec::new();
    let mut speech_ms = 0;
    let mut clipped = false;
    for (index, sample) in window.iter().enumerate() {
        if sample.peak_db >= CLIP_THRESHOLD_DB {
            clipped = true;
        }
        // A NaN reading is not speech either.
        if sample.peak_db.partial_cmp(&SPEECH_DB) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let next = window.get(index + 1).map_or(now, |next| next.at);
        speech_ms += (next - sample.at).clamp(0, MAX_SAMPLE_SPAN_MS);
        speech_peaks.push(sample.peak_db);
    }
    if !speech_peaks.is_empty() && clipped {
        return Reading {
            verdict: Verdict::Loud,
            speech_peak_db: Some(percentile(&speech_peaks, SPEECH_PERCENTILE)),
        };
    }
    if speech_ms < SPEECH_MS {
        return Reading {
            verdict: Verdict::None,
            speech_peak_db: None,
        };
    }
    let peak = percentile(&speech_peaks, SPEECH_PERCENTILE);
    let verdict = if peak < QUIET_BELOW_DB {
        Verdict::Quiet
    } else if peak > LOUD_ABOVE_DB {
        Verdict::Loud
    } else {
        Verdict::Good
    };
    Reading {
        verdict,
        speech_peak_db: Some(peak),
    }
}

/// `soundCheckGainDb`: "Set level for me", the Gain that moves the measured
/// speech peak to −12 dBFS, in whole dB, inside the fader's range. The peak
/// was measured after the current Gain, so the change is relative to it.
pub fn gain_db(current_gain_db: f64, speech_peak_db: f64) -> f64 {
    // `Math.round`: halves toward +∞.
    let next = (current_gain_db + (TARGET_DB - speech_peak_db) + 0.5).floor();
    next.clamp(MICROPHONE_GAIN_MIN_DB, MICROPHONE_GAIN_MAX_DB)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Readings every 50 ms (the warm microphone's rate).
    fn talk(peak_db: f64, ms: i64, from: i64) -> Vec<Sample> {
        (from..from + ms)
            .step_by(50)
            .map(|at| Sample { at, peak_db })
            .collect()
    }

    #[test]
    fn the_loudest_channel_or_silence() {
        assert_eq!(frame_peak_db(&[-30.0, -12.0]), -12.0);
        assert_eq!(frame_peak_db(&[]), f64::NEG_INFINITY);
    }

    #[test]
    fn the_verdict_reads_speech_in_the_window() {
        assert_eq!(
            reading(&talk(-14.0, 2_500, 0), 2_500),
            Reading {
                verdict: Verdict::None,
                speech_peak_db: None
            }
        );
        assert_eq!(
            reading(&talk(-52.0, 6_000, 0), 6_000).verdict,
            Verdict::None
        );
        assert_eq!(
            reading(&talk(-14.0, 4_000, 0), 4_000),
            Reading {
                verdict: Verdict::Good,
                speech_peak_db: Some(-14.0)
            }
        );
        assert_eq!(
            reading(&talk(-32.0, 4_000, 0), 4_000).verdict,
            Verdict::Quiet
        );
        assert_eq!(reading(&talk(-5.0, 4_000, 0), 4_000).verdict, Verdict::Loud);
        let mut clip = talk(-14.0, 500, 0);
        clip.push(Sample {
            at: 500,
            peak_db: -0.5,
        });
        assert_eq!(reading(&clip, 550).verdict, Verdict::Loud);
        let mut stray = talk(-16.0, 4_000, 0);
        stray[10].peak_db = -4.0;
        assert_eq!(reading(&stray, 4_000).verdict, Verdict::Good);
        assert_eq!(
            reading(&talk(-14.0, 4_000, 0), 4_000 + WINDOW_MS).verdict,
            Verdict::None
        );
        let sparse: Vec<Sample> = [0, 1_000, 2_000, 3_000, 4_000]
            .into_iter()
            .map(|at| Sample { at, peak_db: -14.0 })
            .collect();
        assert_eq!(reading(&sparse, 4_000).verdict, Verdict::None);
    }

    #[test]
    fn the_window_drops_old_readings_and_skips_nan() {
        let first = [Sample {
            at: 0,
            peak_db: -20.0,
        }];
        let late = Sample {
            at: WINDOW_MS + 10,
            peak_db: -18.0,
        };
        assert_eq!(add_sample(&first, late), [late]);
        let nan = Sample {
            at: 0,
            peak_db: f64::NAN,
        };
        assert!(add_sample(&[], nan).is_empty());
        let silent = Sample {
            at: 0,
            peak_db: f64::NEG_INFINITY,
        };
        assert_eq!(add_sample(&[], silent).len(), 1);
    }

    #[test]
    fn set_level_moves_speech_to_minus_12_in_whole_db_inside_the_fader() {
        assert_eq!(gain_db(0.0, -30.0), 18.0);
        assert_eq!(gain_db(4.0, -6.0), -2.0);
        assert_eq!(gain_db(0.0, -20.4), 8.0);
        assert_eq!(gain_db(10.0, -50.0), 24.0);
        assert_eq!(gain_db(-20.0, 0.0), -24.0);
    }

    /// The lines are still Electron's.
    #[test]
    fn every_verdict_line_is_the_renderers() {
        let source =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/first-run-sound.ts");
        for verdict in [Verdict::None, Verdict::Quiet, Verdict::Good, Verdict::Loud] {
            assert!(
                source.contains(&format!("'{}'", verdict.copy())),
                "{verdict:?}"
            );
        }
        let zones = include_str!("../../../../apps/desktop/src/renderer/src/lib/audio/zones.ts");
        assert!(zones.contains("export const CLIP_THRESHOLD_DB = -1\n"));
    }
}
