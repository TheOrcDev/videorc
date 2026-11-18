import assert from 'node:assert/strict'
import { MEDIA } from './cloud-parity-media.mjs'

/** Waveform evidence at the actual program output / attached guest elements.
 * <3 dB tolerance excludes a doubled coherent copy (+6 dB). */
export function assertSoundboardWaveforms(captures, { soundDb, host, label }) {
  assert.equal(captures.length, 3, 'Program and both guests are required')
  for (const capture of captures) {
    const tones = capture.settledTones ?? capture.tones
    const actual = tones.soundboard
    if (soundDb === null)
      assert.ok(
        actual < MEDIA.analysis.absentDbfs,
        `${label}/${capture.name}: aux must be absent (${actual} dBFS)`
      )
    else
      assert.ok(
        Math.abs(actual - soundDb) < 2.8,
        `${label}/${capture.name}: one aux copy expected ${soundDb}, measured ${actual} dBFS`
      )
    const expectsMic = typeof host === 'boolean' ? host : host[capture.name]
    assert.ok(
      expectsMic ? tones.host > MEDIA.analysis.audibleDbfs : tones.host < MEDIA.analysis.absentDbfs,
      `${label}/${capture.name}: 440 Hz microphone ${expectsMic ? 'missing' : 'leaked'}`
    )
  }
}
