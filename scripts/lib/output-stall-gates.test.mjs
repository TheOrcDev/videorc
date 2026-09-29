import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateOutputStall, OUTPUT_STALL_GATES } from './output-stall-gates.mjs'

/** Half-second windows over `seconds`, the tone present where `audible(t)`. */
function windows(seconds, audible) {
  const result = []
  for (let start = 0; start + 0.5 <= seconds; start += 0.5) {
    result.push({
      startSeconds: start,
      durationSeconds: 0.5,
      amplitude440: audible(start) ? 0.08 : 0
    })
  }
  return result
}

const stall = { code: 'audio-output-stalled', message: 'Output fell behind for 3.0 seconds.' }
const base = { pauseStartSeconds: 4, pauseSeconds: 3, fileSeconds: 12 }

describe('evaluateOutputStall (plan 076)', () => {
  it('passes when the microphone is back right after a reported stall', () => {
    const result = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => t < 4.5 || t >= 7.5),
      health: [stall]
    })
    assert.deepEqual(result.failures, [])
    assert.equal(result.resumedAt, 7.5)
  })

  it('fails the 0.9.120 shape: the microphone never comes back and is reported lost', () => {
    const result = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => t < 4.5),
      health: [{ code: 'microphone-timeline-lost' }]
    })
    assert.ok(result.failures.some((failure) => failure.includes('never came back')))
    assert.ok(result.failures.some((failure) => failure.includes('reported lost')))
    assert.ok(result.failures.some((failure) => failure.includes('No audio-output-stalled')))
  })

  it('fails a late recovery, a second dropout, and a silent start', () => {
    const late = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => t < 4 || t >= 10),
      health: [stall]
    })
    assert.ok(late.failures.some((failure) => failure.includes('later than 9.5 s')))
    const again = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => (t < 4 || t >= 7.5) && t !== 9),
      health: [stall]
    })
    assert.ok(again.failures.some((failure) => failure.includes('dropped out again')))
    const silent = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => t >= 2),
      health: [stall]
    })
    assert.ok(silent.failures.some((failure) => failure.includes('already silent')))
  })

  it('is vacuous without a stall event, and ignores the file edges', () => {
    const result = evaluateOutputStall({ ...base, windows: windows(12, () => true), health: [] })
    assert.deepEqual(result.failures, [
      'No audio-output-stalled event: the pause never stalled the audio output, so this run proves nothing.'
    ])
    const edges = evaluateOutputStall({
      ...base,
      windows: windows(12, (t) => t >= 0.5 && t < 11.5 && (t < 4.5 || t >= 7.5)),
      health: [stall]
    })
    assert.deepEqual(edges.failures, [])
    assert.equal(OUTPUT_STALL_GATES.edgeSeconds, 1)
  })
})
