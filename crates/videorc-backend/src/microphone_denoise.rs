//! The pinned float RNNoise model consumes gained, normalized mono PCM.
//!
//! Process each input frame once and retain its result through output retries.
//! Output frame N belongs to source frame N - 2. The session bus supplies that
//! lookahead before emitting the original source timestamp; this module must
//! never alter source clocks or apply microphone gain/mute a second time.

pub(crate) const FRAME_SIZE: usize = rnnoise::FRAME_SIZE;
pub(crate) const DELAY_SAMPLES: usize = 2 * FRAME_SIZE;
const PCM_SCALE: f32 = 32768.0;
// The UI permits +24 dB gain. Keep that headroom, with another 12 dB for
// capture overshoot. Reject corrupt/extreme input before it poisons recurrent
// state or overflows spectral energy products. This is not a full-scale clip.
const MAX_INPUT_MAGNITUDE: f32 = 64.0;

pub(crate) struct RnnoiseProcessor {
    state: rnnoise::DenoiseState,
}

impl RnnoiseProcessor {
    pub(crate) fn new() -> Self {
        Self {
            state: rnnoise::DenoiseState::new(),
        }
    }

    /// A source generation or discontinuity cannot inherit the old voice's
    /// pitch, overlap-add history, or recurrent state. Embedded weights and
    /// transform tables remain shared and require no I/O on reset.
    pub(crate) fn reset(&mut self) {
        self.state = rnnoise::DenoiseState::new();
    }

    /// Returns an owned frame so retries cannot advance RNNoise twice.
    ///
    /// No input/output clipping occurs within the supported headroom. An
    /// error never stops the bus: the session stage silences the chunk,
    /// resets and re-syncs (see `MicrophoneDenoiseTimeline::prepare_or_silence`).
    /// A rejected frame does not advance state. An internal numerical failure
    /// resets state before returning an error.
    pub(crate) fn process_frame(
        &mut self,
        input: &[f32; FRAME_SIZE],
    ) -> Result<[f32; FRAME_SIZE], &'static str> {
        if input
            .iter()
            .any(|sample| !sample.is_finite() || sample.abs() > MAX_INPUT_MAGNITUDE)
        {
            return Err("Microphone input is non-finite or exceeds +36 dBFS headroom");
        }
        let scaled = input.map(|sample| sample * PCM_SCALE);
        let mut output = [0.0; FRAME_SIZE];
        self.state.process_frame(&mut output, &scaled);
        for sample in &mut output {
            *sample /= PCM_SCALE;
        }
        if output.iter().any(|sample| !sample.is_finite()) {
            self.reset();
            return Err("Noise reduction produced non-finite microphone output");
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn render(input: &[f32]) -> Vec<f32> {
        let mut processor = RnnoiseProcessor::new();
        let mut output = Vec::new();
        for chunk in input.chunks(FRAME_SIZE) {
            let mut frame = [0.0; FRAME_SIZE];
            frame[..chunk.len()].copy_from_slice(chunk);
            output.extend(processor.process_frame(&frame).unwrap());
        }
        for _ in 0..DELAY_SAMPLES / FRAME_SIZE {
            output.extend(processor.process_frame(&[0.0; FRAME_SIZE]).unwrap());
        }
        output
    }

    fn tone_frame(index: usize, amplitude: f32) -> [f32; FRAME_SIZE] {
        std::array::from_fn(|sample| {
            amplitude * (TAU * 220.0 * (index * FRAME_SIZE + sample) as f32 / 48000.0).sin()
        })
    }

    #[test]
    fn silence_stays_silent_and_reset_is_deterministic() {
        let mut processor = RnnoiseProcessor::new();
        for _ in 0..8 {
            assert_eq!(
                processor.process_frame(&[0.0; FRAME_SIZE]).unwrap(),
                [0.0; FRAME_SIZE]
            );
        }
        let mut first = Vec::new();
        for index in 0..20 {
            first.extend(processor.process_frame(&tone_frame(index, 0.3)).unwrap());
        }
        processor.reset();
        let mut second = Vec::new();
        for index in 0..20 {
            second.extend(processor.process_frame(&tone_frame(index, 0.3)).unwrap());
        }
        assert_eq!(first, second);
        assert!(second.iter().any(|sample| sample.abs() > 0.001));
    }

    #[test]
    fn impulse_delay_and_partial_tail_are_two_frames() {
        for position in [0, 1, 479, 480, 3000, 4807] {
            let mut input = vec![0.0; position + 1];
            input[position] = 2.0;
            let output = render(&input);
            let peak = output
                .iter()
                .enumerate()
                .max_by(|(_, left), (_, right)| left.abs().total_cmp(&right.abs()))
                .unwrap();
            assert_eq!(peak.0, position + DELAY_SAMPLES, "impulse at {position}");
            assert!(peak.1.abs() > 0.0001);
            assert!(output.iter().all(|sample| sample.is_finite()));
        }
    }

    #[test]
    fn normalized_conversion_matches_native_float_api_without_clipping() {
        let mut processor = RnnoiseProcessor::new();
        let mut reference = rnnoise::DenoiseState::new();
        let mut peak: f32 = 0.0;
        for index in 0..30 {
            let input = tone_frame(index, 2.0);
            let actual = processor.process_frame(&input).unwrap();
            let mut expected = [0.0; FRAME_SIZE];
            reference.process_frame(&mut expected, &input.map(|sample| sample * PCM_SCALE));
            assert_eq!(actual, expected.map(|sample| sample / PCM_SCALE));
            for sample in actual {
                peak = peak.max(sample.abs());
            }
        }
        assert!(peak > 1.0, "RNNoise output headroom must survive: {peak}");
    }

    #[test]
    fn invalid_input_does_not_poison_or_advance_state() {
        let mut processor = RnnoiseProcessor::new();
        let mut reference = RnnoiseProcessor::new();
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::MAX, 65.0] {
            let mut input = [0.0; FRAME_SIZE];
            input[12] = value;
            assert!(processor.process_frame(&input).is_err());
        }
        for index in 0..6 {
            let frame = tone_frame(index, 16.0);
            assert_eq!(
                processor.process_frame(&frame),
                reference.process_frame(&frame)
            );
        }
    }

    #[test]
    fn stationary_noise_is_suppressed_after_warmup() {
        let mut seed: u32 = 17;
        let mut input = vec![0.0; 48000];
        for sample in &mut input {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *sample = ((seed >> 8) as f32 / 16777216.0 - 0.5) * 0.1;
        }
        let output = render(&input);
        let dry_energy: f32 = input[24000..].iter().map(|sample| sample * sample).sum();
        let wet_energy: f32 = output[24000 + DELAY_SAMPLES..48000 + DELAY_SAMPLES]
            .iter()
            .map(|sample| sample * sample)
            .sum();
        assert!(
            wet_energy < dry_energy * 0.25,
            "dry={dry_energy} wet={wet_energy}"
        );
    }
}
