import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SOUNDBOARD_GATES,
  evaluateIdlePress,
  evaluateNotDoubled,
  evaluatePressedTone
} from './soundboard-gates.mjs'

const region = (start, durationMs, medianDbfs = -15) => ({
  start,
  end: start + durationMs / 1000,
  durationMs,
  medianDbfs
})

describe('soundboard smoke gates (plan 189 S8)', () => {
  it('passes one region of the right length near the press', () => {
    const result = evaluatePressedTone({ regions: [region(3.08, 598)], pressFileSeconds: 3 })
    assert.equal(result.pass, true)
    assert.equal(Math.round(result.offsetMs), 80)
  })

  it('fails a missing, doubled, misplaced or stretched sound', () => {
    assert.equal(evaluatePressedTone({ regions: [], pressFileSeconds: 3 }).pass, false)
    assert.equal(
      evaluatePressedTone({ regions: [region(3, 600), region(4, 600)], pressFileSeconds: 3 }).pass,
      false
    )
    const late = evaluatePressedTone({ regions: [region(3.4, 600)], pressFileSeconds: 3 })
    assert.match(late.failures[0], /starts 400 ms from the press/)
    const early = evaluatePressedTone({ regions: [region(2.6, 600)], pressFileSeconds: 3 })
    assert.equal(early.pass, false)
    const long = evaluatePressedTone({ regions: [region(3, 700)], pressFileSeconds: 3 })
    assert.match(long.failures[0], /lasts 700 ms/)
    assert.equal(SOUNDBOARD_GATES.toneSeconds, 0.6)
  })

  it('fails a sound that came back louder through System audio', () => {
    const reference = evaluatePressedTone({ regions: [region(3, 600, -15)], pressFileSeconds: 3 })
    const same = evaluatePressedTone({ regions: [region(3, 610, -14.5)], pressFileSeconds: 3 })
    assert.equal(evaluateNotDoubled({ withSystemAudio: same, reference }).pass, true)
    const louder = evaluatePressedTone({ regions: [region(3, 620, -11)], pressFileSeconds: 3 })
    const doubled = evaluateNotDoubled({ withSystemAudio: louder, reference })
    assert.equal(doubled.pass, false)
    assert.match(doubled.failures[0], /second copy came back/)
  })

  it('needs the idle press listed, and never on air', () => {
    const voice = { voiceId: 'v', soundId: 's', startedAtMs: 1, durationMs: 600, loop: false }
    assert.equal(
      evaluateIdlePress({ playback: { voices: [{ ...voice, onAir: false }] }, soundId: 's' }).pass,
      true
    )
    assert.equal(
      evaluateIdlePress({ playback: { voices: [{ ...voice, onAir: true }] }, soundId: 's' }).pass,
      false
    )
    assert.equal(evaluateIdlePress({ playback: { voices: [] }, soundId: 's' }).pass, false)
  })
})
