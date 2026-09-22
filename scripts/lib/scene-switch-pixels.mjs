import assert from 'node:assert/strict'

// Compare every decoded sample with a deterministic compositor reference.
// Orange is valid user content; checking the expected frame rather than a
// global forbidden color also catches wrong-window pixels and frozen frames.
export function assertSceneSwitchPixels(reference, decoded, { width, height, label }) {
  const frameBytes = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
  assert.equal(reference.length % frameBytes, 0, `${label}: incomplete reference frame`)
  assert.equal(decoded.length, reference.length, `${label}: missing or extra decoded frames`)
  let worstMean = 0
  for (let offset = 0; offset < reference.length; offset += frameBytes) {
    let total = 0
    let largeErrors = 0
    for (let i = offset; i < offset + frameBytes; i++) {
      const error = Math.abs(reference[i] - decoded[i])
      total += error
      if (error > 40) largeErrors++
    }
    const mean = total / frameBytes
    worstMean = Math.max(worstMean, mean)
    assert.ok(
      mean <= 5 && largeErrors / frameBytes <= 0.01,
      `${label}: frame ${offset / frameBytes} differs from expected scene (mean ${mean.toFixed(2)}, large errors ${largeErrors})`
    )
  }
  return { frames: reference.length / frameBytes, worstMean }
}
