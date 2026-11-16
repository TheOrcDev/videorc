import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertControlAudio, assertIndependentStop } from './cloud-parity-controls-contract.mjs'

test('mute needs measured host silence and preserves the guest tones', () => {
  const captures = [
    {
      name: 'program',
      settledAfterMs: 1000,
      settledTones: { host: -120, guest1: -12, guest2: -12 }
    }
  ]
  assert.doesNotThrow(() => assertControlAudio(captures, true))
  assert.throws(() => assertControlAudio([], true))
  assert.throws(() => assertControlAudio(captures, false))
  captures[0].settledTones.guest1 = -120
  assert.throws(() => assertControlAudio(captures, true))
})
test('Stop is independent and never closes the room', () => {
  assert.doesNotThrow(() =>
    assertIndependentStop(
      { room: { phase: 'open', live: true }, recording: { active: false } },
      'recording'
    )
  )
  assert.doesNotThrow(() =>
    assertIndependentStop(
      { room: { phase: 'open', live: false }, recording: { active: true } },
      'live'
    )
  )
  assert.throws(() =>
    assertIndependentStop(
      { room: { phase: 'closed', live: true }, recording: { active: false } },
      'recording'
    )
  )
  assert.throws(() =>
    assertIndependentStop(
      { room: { phase: 'open', live: false }, recording: { active: false } },
      'recording'
    )
  )
})
