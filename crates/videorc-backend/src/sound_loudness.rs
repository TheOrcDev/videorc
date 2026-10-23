//! Integrated loudness for soundboard sounds (plan 189 D5): ITU-R BS.1770-4
//! in pure Rust. Every imported sound is measured once and given a level
//! that brings it toward -18 LUFS, so the board never jumps 20 dB between
//! pads. The recording and the stream are never measured here; this runs on
//! the import lane only.
//!
//! The algorithm, for 48 kHz stereo: K-weighting (a high shelf, then a
//! high-pass), 400 ms blocks with 75 % overlap, mean square per block, the
//! absolute gate at -70 LKFS, then the relative gate 10 LU under the mean of
//! the surviving blocks. A sound shorter than one block is measured as one
//! block, so a 100 ms "ding" still gets a level.

/// The sample rate the filter coefficients are tabulated for.
pub(crate) const SAMPLE_RATE: u32 = 48_000;
/// A gating block: 400 ms.
const BLOCK_FRAMES: usize = 19_200;
/// Block hop at 75 % overlap: 100 ms.
const HOP_FRAMES: usize = 4_800;
/// The absolute gate (BS.1770-4 §4.3).
const ABSOLUTE_GATE_LKFS: f64 = -70.0;
/// The relative gate sits this far under the absolutely gated mean.
const RELATIVE_GATE_LU: f64 = 10.0;
/// The constant that makes a 0 dBFS 997 Hz sine on two channels read 0 LKFS.
const LOUDNESS_OFFSET: f64 = -0.691;

/// The target every sound is levelled toward (D5).
pub(crate) const TARGET_LUFS: f64 = -18.0;
/// At most this much boost (D5).
pub(crate) const MAX_BOOST_DB: f64 = 12.0;
/// The level never pushes the peak over this (D5).
pub(crate) const PEAK_CEILING_DBFS: f64 = -1.0;

/// One biquad in direct form I.
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    const fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// The K-weighting chain for one channel at 48 kHz (BS.1770-4 Table 1 and
/// Table 2): the head-shaped high shelf, then the RLB high-pass.
#[derive(Debug, Clone, Copy)]
struct KWeighting {
    shelf: Biquad,
    high_pass: Biquad,
}

impl KWeighting {
    const fn new() -> Self {
        Self {
            shelf: Biquad::new(
                1.535_124_859_586_97,
                -2.691_696_189_406_38,
                1.198_392_810_852_85,
                -1.690_659_293_182_41,
                0.732_480_774_215_85,
            ),
            high_pass: Biquad::new(1.0, -2.0, 1.0, -1.990_047_454_833_98, 0.990_072_250_366_21),
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        self.high_pass.process(self.shelf.process(x))
    }
}

/// K-weights interleaved stereo s16 PCM into per-channel f64 samples in
/// -1..1.
fn k_weighted_channels(samples: &[i16]) -> [Vec<f64>; 2] {
    let frames = samples.len() / 2;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    let mut filters = [KWeighting::new(), KWeighting::new()];
    for frame in samples.chunks_exact(2) {
        left.push(filters[0].process(f64::from(frame[0]) / 32_768.0));
        right.push(filters[1].process(f64::from(frame[1]) / 32_768.0));
    }
    [left, right]
}

/// Mean square of `channel[start..end]`.
fn mean_square(channel: &[f64], start: usize, end: usize) -> f64 {
    let window = &channel[start..end];
    if window.is_empty() {
        return 0.0;
    }
    window.iter().map(|sample| sample * sample).sum::<f64>() / window.len() as f64
}

/// Loudness of one block from the sum of its channel mean squares (both
/// channels weigh 1.0: no surround weighting on a stereo board).
fn block_loudness(power: f64) -> f64 {
    if power <= 0.0 {
        f64::NEG_INFINITY
    } else {
        LOUDNESS_OFFSET + 10.0 * power.log10()
    }
}

/// Integrated loudness in LUFS of interleaved stereo s16 at 48 kHz. `None`
/// when no block passes the absolute gate (silence, or a sound entirely
/// under -70 LKFS): the sound has no loudness to level against.
pub(crate) fn integrated_loudness_lufs(samples: &[i16]) -> Option<f64> {
    let frames = samples.len() / 2;
    if frames == 0 {
        return None;
    }
    let [left, right] = k_weighted_channels(samples);
    // Block powers: whole 400 ms blocks every 100 ms, or the whole sound as
    // one block when it is shorter than a block.
    let mut powers = Vec::new();
    if frames < BLOCK_FRAMES {
        powers.push(mean_square(&left, 0, frames) + mean_square(&right, 0, frames));
    } else {
        let mut start = 0;
        while start + BLOCK_FRAMES <= frames {
            let end = start + BLOCK_FRAMES;
            powers.push(mean_square(&left, start, end) + mean_square(&right, start, end));
            start += HOP_FRAMES;
        }
    }
    let absolutely_gated: Vec<f64> = powers
        .into_iter()
        .filter(|power| block_loudness(*power) > ABSOLUTE_GATE_LKFS)
        .collect();
    if absolutely_gated.is_empty() {
        return None;
    }
    let mean = absolutely_gated.iter().sum::<f64>() / absolutely_gated.len() as f64;
    let relative_gate = block_loudness(mean) - RELATIVE_GATE_LU;
    let relatively_gated: Vec<f64> = absolutely_gated
        .into_iter()
        .filter(|power| block_loudness(*power) > relative_gate)
        .collect();
    if relatively_gated.is_empty() {
        return None;
    }
    let mean = relatively_gated.iter().sum::<f64>() / relatively_gated.len() as f64;
    Some(block_loudness(mean))
}

/// The sample peak of interleaved s16 PCM in dBFS; `None` for digital
/// silence.
pub(crate) fn peak_dbfs(samples: &[i16]) -> Option<f64> {
    let peak = samples
        .iter()
        .map(|sample| i32::from(*sample).unsigned_abs())
        .max()
        .unwrap_or(0);
    (peak > 0).then(|| 20.0 * (f64::from(peak) / 32_768.0).log10())
}

/// The auto-level gain (D5): toward -18 LUFS, at most +12 dB, and never a
/// peak over -1 dBFS. A sound with no measurable loudness is only bounded by
/// the boost cap and its peak.
pub(crate) fn level_db(loudness_lufs: Option<f64>, peak_dbfs: Option<f64>) -> f64 {
    let toward_target = loudness_lufs.map_or(MAX_BOOST_DB, |loudness| TARGET_LUFS - loudness);
    let under_ceiling = peak_dbfs.map_or(MAX_BOOST_DB, |peak| PEAK_CEILING_DBFS - peak);
    toward_target.min(MAX_BOOST_DB).min(under_ceiling)
}

/// One decimal, the precision the wire carries.
pub(crate) fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1 kHz sine of `amplitude` (full scale 1.0) for `frames` frames, on
    /// the left channel, the right channel, or both.
    fn sine(frames: usize, amplitude: f64, left: bool, right: bool) -> Vec<i16> {
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = amplitude
                * (std::f64::consts::TAU * 1_000.0 * frame as f64 / f64::from(SAMPLE_RATE)).sin();
            let sample = (value * 32_767.0).round() as i16;
            samples.push(if left { sample } else { 0 });
            samples.push(if right { sample } else { 0 });
        }
        samples
    }

    /// -20 dBFS as a linear amplitude.
    const MINUS_20_DBFS: f64 = 0.1;

    #[test]
    fn a_minus_20_dbfs_sine_on_both_channels_reads_minus_20_lufs() {
        let loudness =
            integrated_loudness_lufs(&sine(SAMPLE_RATE as usize * 3, MINUS_20_DBFS, true, true))
                .expect("a tone has a loudness");
        assert!((loudness + 20.0).abs() < 0.1, "{loudness}");
    }

    #[test]
    fn the_same_sine_on_one_channel_reads_3_db_lower() {
        for (left, right) in [(true, false), (false, true)] {
            let loudness = integrated_loudness_lufs(&sine(
                SAMPLE_RATE as usize * 3,
                MINUS_20_DBFS,
                left,
                right,
            ))
            .expect("a tone has a loudness");
            assert!((loudness + 23.0).abs() < 0.1, "{loudness}");
        }
    }

    #[test]
    fn silence_is_ungated() {
        assert_eq!(
            integrated_loudness_lufs(&vec![0; SAMPLE_RATE as usize * 2]),
            None
        );
        assert_eq!(integrated_loudness_lufs(&[]), None);
        // Under the absolute gate: a tone at -80 dBFS.
        assert_eq!(
            integrated_loudness_lufs(&sine(SAMPLE_RATE as usize, 0.0001, true, true)),
            None
        );
        assert_eq!(peak_dbfs(&[0, 0, 0, 0]), None);
    }

    #[test]
    fn a_100ms_tone_is_measured_as_one_block() {
        let loudness = integrated_loudness_lufs(&sine(4_800, MINUS_20_DBFS, true, true))
            .expect("a short tone still measures");
        // The filters settle within the first few milliseconds; the rest of
        // the block is the steady tone.
        assert!((loudness + 20.0).abs() < 0.5, "{loudness}");
    }

    #[test]
    fn the_relative_gate_drops_a_quiet_tail() {
        // Two seconds of tone, then two seconds 30 dB down: the tail is gated
        // out and the reading stays at the tone's loudness.
        let mut samples = sine(SAMPLE_RATE as usize * 2, MINUS_20_DBFS, true, true);
        samples.extend(sine(
            SAMPLE_RATE as usize * 2,
            MINUS_20_DBFS / 31.6,
            true,
            true,
        ));
        let loudness = integrated_loudness_lufs(&samples).unwrap();
        // The blocks straddling the drop stay in (they are within 10 LU);
        // the quiet blocks are out, so the reading sits near the tone, well
        // above the ungated mean of about -23.
        assert!((loudness + 20.0).abs() < 0.5, "{loudness}");
        assert!(loudness > -21.0, "{loudness}");
    }

    #[test]
    fn the_level_never_pushes_the_peak_over_minus_1_dbfs() {
        // A -20 LUFS tone peaks at -20 dBFS: +2 dB toward the target.
        assert!((level_db(Some(-20.0), Some(-20.0)) - 2.0).abs() < 1.0e-9);
        // A -40 LUFS whisper is capped at +12 dB.
        assert!((level_db(Some(-40.0), Some(-30.0)) - 12.0).abs() < 1.0e-9);
        // A sound that already peaks near full scale cannot be boosted past
        // the ceiling, however quiet it reads.
        assert!((level_db(Some(-30.0), Some(-0.5)) + 0.5).abs() < 1.0e-9);
        // A loud sound is turned down.
        assert!((level_db(Some(-8.0), Some(-1.0)) + 10.0).abs() < 1.0e-9);
        for (loudness, peak) in [(-30.0, -0.5), (-20.0, -5.0), (-8.0, -1.0), (-45.0, -40.0)] {
            assert!(level_db(Some(loudness), Some(peak)) + peak <= PEAK_CEILING_DBFS + 1.0e-9);
        }
        // No measurable loudness: the boost cap and the peak still bound it.
        assert!((level_db(None, Some(-20.0)) - 12.0).abs() < 1.0e-9);
        assert!((level_db(None, Some(-3.0)) - 2.0).abs() < 1.0e-9);
    }

    #[test]
    fn peak_is_the_loudest_sample() {
        let peak = peak_dbfs(&[0, 100, -3_277, 50]).unwrap();
        assert!((peak + 20.0).abs() < 0.01, "{peak}");
        assert!(peak_dbfs(&[i16::MIN]).unwrap().abs() < 0.01);
        assert_eq!(round_tenth(-2.66), -2.7);
    }
}
