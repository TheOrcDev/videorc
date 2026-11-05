import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRnnoiseArtifact, measureFloatPcmWindow } from './rnnoise-artifact-gate.mjs'

const level = (rms) => ({ rms, peak: rms * Math.SQRT2, samples: 72_000 })
const windows = () => ({
  dry: level(0.085),
  gain: level(0.17),
  rnnoise: level(0.015),
  muted: level(0),
  bypass: level(0.085),
  startEnabled: level(0.01),
  attachedEnabled: level(0.01)
})
test('accepts attenuation, live bypass, one gain and downstream mute', () => {
  assert.equal(evaluateRnnoiseArtifact(windows()).pass, true)
})
test('rejects a bypassed processor, double gain, audible mute and missing output', () => {
  for (const patch of [
    { rnnoise: level(0.17) },
    { gain: level(0.34) },
    { muted: level(0.005) },
    { startEnabled: level(0.085) },
    { dry: level(0) }
  ]) {
    assert.equal(evaluateRnnoiseArtifact({ ...windows(), ...patch }).pass, false)
  }
})
test('measures only the requested complete float window and rejects non-finite or truncated audio', () => {
  const pcm = Buffer.alloc(48_000 * 4)
  for (let index = 24_000; index < 48_000; index += 1) pcm.writeFloatLE(0.25, index * 4)
  assert.equal(measureFloatPcmWindow(pcm, 0, 0.5).rms, 0)
  assert.equal(measureFloatPcmWindow(pcm, 0.5, 0.5).rms, 0.25)
  assert.throws(() => measureFloatPcmWindow(pcm, 0.5, 1), /ends before/)
  pcm.writeFloatLE(Number.NaN, 0)
  assert.throws(() => measureFloatPcmWindow(pcm, 0, 1), /non-finite/)
})

test('rejects absent required windows and invalid sample counts without throwing', () => {
  for (const name of ['dry', 'rnnoise']) {
    const incomplete = windows()
    delete incomplete[name]
    assert.equal(evaluateRnnoiseArtifact(incomplete).pass, false)
  }
  for (const samples of [undefined, NaN, 48_000.5, 47_999]) {
    assert.equal(
      evaluateRnnoiseArtifact({ ...windows(), dry: { ...level(0.085), samples } }).pass,
      false
    )
  }
  assert.equal(evaluateRnnoiseArtifact(undefined).pass, false)
})

test('speech acceptance rejects total muting, silent startup/attach and failed unmute', () => {
  const speech = { ...windows(), unmuted: level(0.015) }
  assert.equal(evaluateRnnoiseArtifact(speech, { speech: true }).pass, true)
  for (const name of ['rnnoise', 'startEnabled', 'attachedEnabled', 'unmuted']) {
    assert.equal(
      evaluateRnnoiseArtifact({ ...speech, [name]: level(0) }, { speech: true }).pass,
      false
    )
  }
  assert.equal(
    evaluateRnnoiseArtifact({ ...speech, muted: level(0.015) }, { speech: true }).pass,
    false
  )
})

test('tone acceptance rejects unprocessed initial and attached microphone modes', () => {
  for (const name of ['startEnabled', 'attachedEnabled']) {
    assert.equal(evaluateRnnoiseArtifact({ ...windows(), [name]: level(0.085) }).pass, false)
  }
})
