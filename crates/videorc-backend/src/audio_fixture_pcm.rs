//! Bounded, debug-only speech fixture for the maintained native RNNoise smoke.

use std::io::Read;

use anyhow::{Context, Result, bail};

const MAX_BYTES: usize = 48_000 * 5 * 4;

pub(super) fn load_from_env() -> Result<Option<Vec<f32>>> {
    let Some(path) = std::env::var_os("VIDEORC_RNNOISE_TEST_PCM_PATH") else {
        return Ok(None);
    };
    if !super::caption_contract_test_audio_enabled() {
        bail!("RNNoise PCM fixtures require the debug caption contract test opt-in.");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .context("Cannot open RNNoise test PCM fixture")?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("Cannot read RNNoise test PCM fixture")?;
    Ok(Some(parse(&bytes)?))
}

fn parse(bytes: &[u8]) -> Result<Vec<f32>> {
    if bytes.len() < 48_000 * 4 || bytes.len() > MAX_BYTES || !bytes.len().is_multiple_of(4) {
        bail!("RNNoise test PCM must contain 1 to 5 seconds of mono 48 kHz f32le samples.");
    }
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    let mut peak = 0.0_f32;
    for chunk in bytes.chunks_exact(4) {
        let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if !value.is_finite() || value.abs() > 1.0 {
            bail!("RNNoise test PCM samples must be finite and within full scale.");
        }
        peak = peak.max(value.abs());
        samples.push(value);
    }
    if peak < 0.001 {
        bail!("RNNoise test PCM fixture must contain audible samples.");
    }
    // The existing injection rawPeak sets a deterministic peak for both tone
    // and speech fixtures, preserving headroom for the +6 dB phase.
    for sample in &mut samples {
        *sample /= peak;
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn fixture_validation_bounds_size_and_rejects_silence_or_invalid_samples() {
        for size in [0, 47_999 * 4, 48_000 * 4 + 1, 240_001 * 4] {
            assert!(parse(&vec![0; size]).is_err());
        }
        for value in [0.0_f32, f32::NAN, f32::INFINITY, 1.001] {
            assert!(parse(&value.to_le_bytes().repeat(48_000)).is_err());
        }
    }

    #[test]
    fn fixture_normalizes_peak_without_changing_length_or_sign() {
        let bytes = [0.25_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()]
            .concat()
            .repeat(24_000);
        let samples = parse(&bytes).expect("valid fixture");
        assert_eq!(samples.len(), 48_000);
        assert_eq!(&samples[..2], &[0.5, -1.0]);
    }
}
