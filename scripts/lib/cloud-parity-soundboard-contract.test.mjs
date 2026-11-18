import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSoundboardWaveforms } from './cloud-parity-soundboard-contract.mjs'
const captures = (soundboard, host = -22) =>
  ['program', 'guest1', 'guest2'].map((name) => ({ name, tones: { soundboard, host } }))
test('waveform gate rejects missing, doubled, muted-mic and incomplete destination evidence', () => {
  assert.doesNotThrow(() =>
    assertSoundboardWaveforms(captures(-20), { soundDb: -20, host: true, label: 'single' })
  )
  for (const level of [-70, -14])
    assert.throws(() =>
      assertSoundboardWaveforms(captures(level), { soundDb: -20, host: true, label: 'invalid' })
    )
  assert.throws(() =>
    assertSoundboardWaveforms(captures(-20, -70), { soundDb: -20, host: true, label: 'mic' })
  )
  assert.throws(() =>
    assertSoundboardWaveforms(captures(-20).slice(0, 2), {
      soundDb: -20,
      host: true,
      label: 'partial'
    })
  )
  assert.doesNotThrow(() =>
    assertSoundboardWaveforms(captures(-70, -70), { soundDb: null, host: false, label: 'stopped' })
  )
})
