/** Numeric checks on decoded recording windows, not a perceptual speech score. */
export function measureFloatPcmWindow(bytes, startSeconds, durationSeconds, sampleRate = 48_000) {
  if (
    !Number.isFinite(startSeconds) ||
    startSeconds < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error('Invalid RNNoise artifact analysis window.')
  }
  const first = Math.round(startSeconds * sampleRate)
  const count = Math.round(durationSeconds * sampleRate)
  if ((first + count) * 4 > bytes.length)
    throw new Error('Recording ends before the analysis window.')
  let peak = 0
  let energy = 0
  for (let index = first; index < first + count; index += 1) {
    const value = bytes.readFloatLE(index * 4)
    if (!Number.isFinite(value)) throw new Error('Decoded recording contains non-finite audio.')
    peak = Math.max(peak, Math.abs(value))
    energy += value * value
  }
  return { samples: count, peak, rms: Math.sqrt(energy / count) }
}

export function evaluateRnnoiseArtifact(windows, { speech = false } = {}) {
  const failures = []
  for (const name of [
    'dry',
    'gain',
    'rnnoise',
    'muted',
    'bypass',
    'startEnabled',
    'attachedEnabled',
    ...(speech ? ['unmuted'] : [])
  ]) {
    const window = windows?.[name]
    if (
      !window ||
      !Number.isFinite(window.rms) ||
      !Number.isFinite(window.peak) ||
      window.rms < 0 ||
      window.peak < 0 ||
      !Number.isInteger(window.samples) ||
      window.samples < 48_000
    ) {
      failures.push(`${name}: missing, non-finite or short decoded audio.`)
    } else if (window.peak > 1.01) failures.push(`${name}: output exceeded full scale.`)
  }
  if (failures.length) return { pass: false, failures }
  const { dry, gain, rnnoise, muted, bypass } = windows
  if (dry.rms < (speech ? 0.005 : 0.04) || dry.rms > 0.13)
    failures.push('Off recording did not contain the injected audible fixture.')
  const gainRatio = gain.rms / dry.rms
  if (gainRatio < 1.75 || gainRatio > 2.25)
    failures.push('+6 dB did not apply once before processing.')
  const suppressionRatio = rnnoise.rms / gain.rms
  if (!speech && suppressionRatio >= 0.9)
    failures.push('RNNoise did not attenuate the steady test tone by at least 10%.')
  if (muted.peak > 0.001 || muted.rms > 0.0001)
    failures.push('Safety mute did not silence processed audio.')
  const bypassRatio = bypass.rms / dry.rms
  if (bypassRatio < 0.85 || bypassRatio > 1.15)
    failures.push('Switching Off did not restore the original level.')
  for (const name of ['startEnabled', 'attachedEnabled']) {
    if (!speech && windows[name].rms / dry.rms >= 0.9)
      failures.push(`${name}: recording bypassed RNNoise.`)
  }
  if (speech) {
    for (const name of ['rnnoise', 'unmuted', 'startEnabled', 'attachedEnabled']) {
      const reference = ['rnnoise', 'unmuted'].includes(name) ? gain : dry
      const ratio = windows[name].rms / reference.rms
      if (ratio < 0.05 || ratio > 1.5 || windows[name].rms < 0.001)
        failures.push(`${name}: encoded speech was lost or amplified beyond the retention bounds.`)
    }
    const restoredRatio = windows.unmuted.rms / rnnoise.rms
    if (restoredRatio < 0.7 || restoredRatio > 1.3)
      failures.push('Unmuting did not restore the processed speech level.')
  }
  return { pass: failures.length === 0, failures, gainRatio, suppressionRatio, bypassRatio }
}
