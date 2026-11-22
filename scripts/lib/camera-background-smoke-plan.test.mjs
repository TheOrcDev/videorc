import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EXPECT_ROOM_HIDDEN, EXPECT_ROOM_VISIBLE } from './camera-background-leak.mjs'
import {
  CAMERA_BACKGROUND_OUTPUTS,
  effectRequestToday,
  expectationFor,
  finalVerdict,
  parseSmokeArgs
} from './camera-background-smoke-plan.mjs'

const ok = { ok: true, failures: [] }

function allOutputs(overrides = {}) {
  const outputs = {}
  for (const output of CAMERA_BACKGROUND_OUTPUTS) {
    outputs[output.id] = output.pending ? { ok: true, skipped: true, reason: output.pending } : ok
  }
  return { ...outputs, ...overrides }
}

describe('camera background smoke plan', () => {
  it('lists every output plan 258 promises, each once', () => {
    const ids = CAMERA_BACKGROUND_OUTPUTS.map((output) => output.id)
    assert.deepEqual(ids, [
      'recording',
      'stream-horizontal',
      'stream-vertical',
      'clip',
      'camera-file',
      'preview',
      'videorc-camera',
      'room'
    ])
    for (const output of CAMERA_BACKGROUND_OUTPUTS.filter((entry) => entry.pending)) {
      assert.match(output.pending, /^S\d+: /, `${output.id} names the slice that fills it in`)
    }
  })

  it('parses --effect and refuses anything unknown', () => {
    assert.deepEqual(parseSmokeArgs([]), { effect: 'off' })
    assert.deepEqual(parseSmokeArgs(['--', '--effect', 'strong-blur']), { effect: 'strong-blur' })
    assert.deepEqual(parseSmokeArgs(['--effect=image']), { effect: 'image' })
    assert.throws(() => parseSmokeArgs(['--effect', 'green']), /unknown effect/)
    assert.throws(() => parseSmokeArgs(['--fast']), /unknown argument/)
  })

  it('expects the room visible with Off and hidden with any effect', () => {
    assert.equal(expectationFor('off'), EXPECT_ROOM_VISIBLE)
    for (const effect of ['slight-blur', 'strong-blur', 'image']) {
      assert.equal(expectationFor(effect), EXPECT_ROOM_HIDDEN)
    }
  })

  it('says today that no effect can be applied, and why', () => {
    assert.equal(effectRequestToday('off').applied, true)
    const blur = effectRequestToday('strong-blur')
    assert.equal(blur.applied, false)
    assert.match(blur.reason, /S1 adds the setting, S3 the macOS stage/)
  })

  it('passes Off when every judged output passes, listing the pending ones', () => {
    const verdict = finalVerdict({
      effect: 'off',
      effectRequest: effectRequestToday('off'),
      outputs: allOutputs()
    })
    assert.equal(verdict.ok, true, verdict.failures.join('; '))
    assert.equal(verdict.judged, 6)
    assert.match(
      verdict.lines.find((line) => line.startsWith('Videorc Camera')),
      /^Videorc Camera: SKIP \(S3: /
    )
  })

  it('fails an effect that was not applied first, then each leaking output', () => {
    const verdict = finalVerdict({
      effect: 'strong-blur',
      effectRequest: effectRequestToday('strong-blur'),
      outputs: allOutputs({
        recording: { ok: false, failures: ['the real room leaked: 20/20 frames'] }
      })
    })
    assert.equal(verdict.ok, false)
    assert.match(
      verdict.failures[0],
      /^strong-blur was requested but not applied: this build has no camera/
    )
    assert.match(verdict.failures[1], /^Recording: the real room leaked/)
  })

  it('fails an output that was never judged, and a run that judged nothing', () => {
    const missing = allOutputs()
    delete missing.clip
    assert.match(
      finalVerdict({ effect: 'off', effectRequest: effectRequestToday('off'), outputs: missing })
        .failures[0],
      /Clips save: never judged/
    )
    const skippedAll = Object.fromEntries(
      CAMERA_BACKGROUND_OUTPUTS.map((output) => [
        output.id,
        { ok: true, skipped: true, reason: 'x' }
      ])
    )
    assert.deepEqual(
      finalVerdict({ effect: 'off', effectRequest: effectRequestToday('off'), outputs: skippedAll })
        .failures,
      ['no output was judged']
    )
  })
})
