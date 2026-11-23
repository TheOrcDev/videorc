import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EXPECT_ROOM_HIDDEN, EXPECT_ROOM_VISIBLE } from './camera-background-leak.mjs'
import {
  CAMERA_BACKGROUND_OUTPUTS,
  IMAGE_ASSET_ID,
  cameraBackgroundFor,
  controlChoiceFor,
  controlsMatchPass,
  effectRequestFrom,
  expectationFor,
  finalVerdict,
  isFullPass,
  judgeStall,
  layoutBackgroundFromControls,
  neutralGroundFraction,
  parseSmokeArgs,
  passesFor,
  stallCoverBudgetMs
} from './camera-background-smoke-plan.mjs'

const applied = { applied: true, reason: null }

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
    assert.deepEqual(parseSmokeArgs(['--effect', 'all']), { effect: 'all' })
    assert.throws(() => parseSmokeArgs(['--effect', 'green']), /unknown effect/)
    assert.throws(() => parseSmokeArgs(['--fast']), /unknown argument/)
  })

  it('expects the room visible with Off and hidden with any effect', () => {
    assert.equal(expectationFor('off'), EXPECT_ROOM_VISIBLE)
    for (const effect of ['slight-blur', 'strong-blur', 'image']) {
      assert.equal(expectationFor(effect), EXPECT_ROOM_HIDDEN)
    }
  })

  it('runs Off then every effect-on pass for all, one pass otherwise', () => {
    assert.deepEqual(passesFor('all'), [
      'off',
      'strong-blur',
      'image',
      'stall',
      'camera-switch-record',
      'relaunch'
    ])
    assert.deepEqual(passesFor('image'), ['image'])
    assert.equal(isFullPass('strong-blur'), true)
    assert.equal(isFullPass('stall'), false)
  })

  it('puts the renderer-shaped background on the layout for each pass', () => {
    assert.equal(cameraBackgroundFor('off'), null)
    assert.deepEqual(cameraBackgroundFor('strong-blur'), {
      mode: 'blur',
      blurPct: 70,
      edges: 'balanced'
    })
    assert.equal(cameraBackgroundFor('slight-blur').blurPct, 30)
    assert.equal(cameraBackgroundFor('image').assetId, IMAGE_ASSET_ID)
    for (const pass of ['stall', 'camera-switch-record', 'relaunch']) {
      assert.equal(cameraBackgroundFor(pass).mode, 'blur')
    }
    assert.throws(() => cameraBackgroundFor('sepia'), /unknown pass/)
  })

  it('turns each pass on through the Studio tile a streamer clicks (plan 258 S5)', () => {
    assert.equal(controlChoiceFor('off'), 'off')
    assert.equal(controlChoiceFor('strong-blur'), 'strong-blur')
    assert.equal(controlChoiceFor('slight-blur'), 'slight-blur')
    assert.equal(controlChoiceFor('image'), `image:${IMAGE_ASSET_ID}`)
    for (const pass of ['stall', 'camera-switch-record', 'relaunch'])
      assert.equal(controlChoiceFor(pass), 'strong-blur')
  })

  it('reads the pass from the renderer’s stored background, and sends none for Off', () => {
    const strong = { mode: 'blur', blurPct: 70, edges: 'balanced' }
    assert.equal(controlsMatchPass('off', null), true)
    assert.equal(controlsMatchPass('off', { ...strong, mode: 'off' }), true)
    assert.equal(controlsMatchPass('off', strong), false)
    assert.equal(controlsMatchPass('strong-blur', strong), true)
    assert.equal(controlsMatchPass('relaunch', strong), true)
    assert.equal(controlsMatchPass('strong-blur', { ...strong, blurPct: 30 }), false)
    assert.equal(controlsMatchPass('strong-blur', null), false)
    assert.equal(
      controlsMatchPass('image', { ...strong, mode: 'image', assetId: IMAGE_ASSET_ID }),
      true
    )
    assert.equal(controlsMatchPass('image', { ...strong, mode: 'image', assetId: 'other' }), false)
    assert.equal(layoutBackgroundFromControls(null), null)
    assert.equal(layoutBackgroundFromControls({ ...strong, mode: 'off' }), null)
    assert.equal(layoutBackgroundFromControls(strong), strong)
  })

  it('reads whether the stage applied the background from the camera status', () => {
    assert.equal(effectRequestFrom('off', {}).applied, true)
    assert.match(
      effectRequestFrom('off', { cameraBackground: { mode: 'blur' } }).reason,
      /still runs blur/
    )
    assert.match(effectRequestFrom('strong-blur', {}).reason, /never armed/)
    assert.match(
      effectRequestFrom('image', { cameraBackground: { mode: 'blur', state: 'running' } }).reason,
      /runs blur, not image/
    )
    assert.match(
      effectRequestFrom('strong-blur', {
        cameraBackground: { mode: 'blur', state: 'unavailable', message: 'no Vision' }
      }).reason,
      /unavailable: no Vision/
    )
    assert.equal(
      effectRequestFrom('strong-blur', { cameraBackground: { mode: 'blur', state: 'cover' } })
        .applied,
      true
    )
  })

  it('holds the stall to D6: the cover at the first capture past 100 ms, then back', () => {
    assert.equal(stallCoverBudgetMs(30), 134)
    assert.equal(stallCoverBudgetMs(60), 117)
    const good = { coverSeen: true, coverAfterMaskAgeMs: 101, recovered: true, fps: 30 }
    assert.equal(judgeStall(good).ok, true)
    assert.match(
      judgeStall({ ...good, coverAfterMaskAgeMs: 400 }).failures[0],
      /400 ms old matte; D6 allows 134 ms/
    )
    assert.match(judgeStall({ ...good, coverAfterMaskAgeMs: 40 }).failures[0], /early/)
    assert.match(judgeStall({ ...good, coverSeen: false }).failures[0], /never said cover/)
    assert.match(judgeStall({ ...good, coverAfterMaskAgeMs: null }).failures[0], /matte age/)
    assert.match(judgeStall({ ...good, recovered: false }).failures[0], /never came back/)
  })

  it('measures how much of a frame is the neutral ground', () => {
    const rgb = new Uint8Array([0x1a, 0x1c, 0x1f, 200, 30, 30, 0x1b, 0x1d, 0x1e, 0, 0, 0])
    assert.equal(neutralGroundFraction({ width: 2, height: 2, rgb }), 0.5)
  })

  it('judges a short pass on the outputs it makes only', () => {
    const verdict = finalVerdict({
      effect: 'stall',
      effectRequest: applied,
      outputs: { recording: ok, preview: ok, stall: ok },
      outputIds: ['recording', 'preview', 'stall']
    })
    assert.equal(verdict.ok, true, verdict.failures.join('; '))
    assert.equal(verdict.judged, 3)
    const failed = finalVerdict({
      effect: 'stall',
      effectRequest: applied,
      outputs: { recording: ok, preview: ok, stall: { ok: false, failures: ['late cover'] } },
      outputIds: ['recording', 'preview', 'stall']
    })
    assert.deepEqual(failed.failures, ['stall: late cover'])
  })

  it('passes Off when every judged output passes, listing the pending ones', () => {
    const verdict = finalVerdict({
      effect: 'off',
      effectRequest: applied,
      outputs: allOutputs()
    })
    assert.equal(verdict.ok, true, verdict.failures.join('; '))
    assert.equal(verdict.judged, 6)
    assert.match(
      verdict.lines.find((line) => line.startsWith('Videorc Camera')),
      /^Videorc Camera: SKIP \(S3: .*Owed by the owner/
    )
  })

  it('fails an effect that was not applied first, then each leaking output', () => {
    const verdict = finalVerdict({
      effect: 'strong-blur',
      effectRequest: { applied: false, reason: 'the stage never armed' },
      outputs: allOutputs({
        recording: { ok: false, failures: ['the real room leaked: 20/20 frames'] }
      })
    })
    assert.equal(verdict.ok, false)
    assert.match(
      verdict.failures[0],
      /^strong-blur was requested but not applied: the stage never armed/
    )
    assert.match(verdict.failures[1], /^Recording: the real room leaked/)
  })

  it('fails an output that was never judged, and a run that judged nothing', () => {
    const missing = allOutputs()
    delete missing.clip
    assert.match(
      finalVerdict({ effect: 'off', effectRequest: applied, outputs: missing }).failures[0],
      /Clips save: never judged/
    )
    const skippedAll = Object.fromEntries(
      CAMERA_BACKGROUND_OUTPUTS.map((output) => [
        output.id,
        { ok: true, skipped: true, reason: 'x' }
      ])
    )
    assert.deepEqual(
      finalVerdict({ effect: 'off', effectRequest: applied, outputs: skippedAll }).failures,
      ['no output was judged']
    )
  })
})
