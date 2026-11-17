import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCENE_CONTROL_CASES,
  SCENE_PRESETS,
  compareSceneTiles,
  cornerOf,
  expectedCorner,
  guestsKept,
  judgeGlide,
  p95,
  sceneCaseMatrix,
  sceneRoster
} from './cloud-parity-scenes-contract.mjs'
import { readParityJson } from './cloud-parity-contract.mjs'

test('the scenes case covers every shipped preset at every real guest count, freeform both ways, guest roles, hidden camera and transitions', () => {
  const cases = sceneCaseMatrix()
  for (const preset of [...SCENE_PRESETS.h, ...SCENE_PRESETS.v])
    for (const guests of [0, 1, 2])
      assert.ok(
        cases.some((c) => c.id === `preset:${preset}:${guests}`),
        `${preset} ${guests}`
      )
  for (const id of [
    'freeform:h:0',
    'freeform:h:2',
    'freeform:v:0',
    'freeform:v:2',
    'saved:guest-roles:2',
    'saved:camera-hidden:1',
    'transition:motion',
    'transition:cut'
  ])
    assert.ok(
      cases.some((c) => c.id === id),
      id
    )
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
  const freeform = cases.find((c) => c.id === 'freeform:h:0').scene.visual.layout
  assert.equal(freeform.arrangementMode, 'freeform')
  assert.equal(freeform.cameraShape, 'circle')
  assert.equal(freeform.cameraMirror, true)
  // The registry owns this case for S12.
  assert.equal(readParityJson('plan').slices.find((s) => s.case === 'scenes').id, 'S12')
})

test('tile comparison names missing, unexpected and moved boxes', () => {
  const tile = (role, x) => ({ role, identity: role, rect: { x, y: 0, w: 10, h: 10 } })
  assert.deepEqual(compareSceneTiles([tile('screen', 0)], [tile('screen', 1)]), [])
  assert.deepEqual(compareSceneTiles([tile('screen', 0)], [tile('screen', 3)]), [
    'screen: x 3 != 0'
  ])
  assert.deepEqual(compareSceneTiles([tile('screen', 0)], [tile('guest:0', 0)]), [
    'screen: missing',
    'guest:0: unexpected'
  ])
  assert.deepEqual(
    guestsKept(['g_a', 'g_b'], [{ role: 'guest:0', identity: 'g_a' }]),
    ['g_b'],
    'a guest the scene dropped is named'
  )
  assert.throws(() => sceneRoster({ host: 'h', guestIds: ['g_a'], guests: 2, screen: null }))
})

test('corner markers survive a mirror by swapping sides', () => {
  assert.equal(cornerOf([250, 5, 5]), 'tl')
  assert.equal(cornerOf([128, 128, 128]), null)
  assert.equal(expectedCorner('tl', true), 'tr')
  assert.equal(expectedCorner('bl', false), 'bl')
})

test('a glide must pass between, settle near 320 ms and never overshoot; a jump fails', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 }
  const to = { x: 200, y: 0, w: 300, h: 100 }
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
  const glide = Array.from({ length: 30 }, (_, i) => {
    const p = ease(Math.min(1, (i * 16) / 320))
    return {
      t: i * 16,
      rect: { x: 200 * p, y: 0, w: 100 + 200 * p, h: 100 }
    }
  })
  assert.deepEqual(judgeGlide(glide, from, to), [])
  const jump = [0, 16, 32, 48].map((t) => ({ t, rect: t ? to : from }))
  assert.ok(judgeGlide(jump, from, to).includes('no intermediate frame'))
  assert.equal(p95([5, 1, 9, 3, 7]), 9)
})

test('the real controls the scenes case must drive while a scene is on the program', () => {
  assert.deepEqual(SCENE_CONTROL_CASES, [
    'control:freeform-drag',
    'control:rapid-drags',
    'control:hide-camera',
    'control:show-camera',
    'control:guest-roles-over',
    'control:edits-then-clear'
  ])
})
