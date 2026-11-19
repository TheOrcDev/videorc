import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  defaultRingVerdict,
  SOFTWARE_ENCODER_GUARD_PREFIX,
  STREAM_MANAGER_WAYLAND_REFUSAL,
  streamManagerScreenKeyPlan
} from './remote-control-smoke-gates.mjs'

const guardReason = `${SOFTWARE_ENCODER_GUARD_PREFIX} (OpenH264), so keeping the last seconds would run a second encode. Turn it on here if the computer keeps up.`

test('the default ring is on, or off with the software encoder guard reason', () => {
  assert.deepEqual(defaultRingVerdict({ state: 'on', seconds: 60, bufferedSeconds: 2 }), {
    kind: 'on'
  })
  assert.deepEqual(
    defaultRingVerdict({ state: 'off', seconds: 60, bufferedSeconds: 0, reason: guardReason }),
    { kind: 'guarded', reason: guardReason }
  )
})

test('a bare off, a failed start or a ring still starting is not an answer', () => {
  assert.equal(defaultRingVerdict({ state: 'off', seconds: 60, bufferedSeconds: 0 }), null)
  assert.equal(defaultRingVerdict({ state: 'off', reason: 'The session did not start.' }), null)
  assert.equal(defaultRingVerdict({ state: 'error', reason: guardReason }), null)
  assert.equal(defaultRingVerdict({ state: 'starting' }), null)
  assert.equal(defaultRingVerdict(null), null)
})

test('the Screen key plan follows what describe reports, not the environment', () => {
  const one = [{ id: '1', name: 'Built-in' }]
  const two = [...one, { id: '2', name: 'External' }]
  assert.equal(streamManagerScreenKeyPlan({ screenMoves: 'supported', screens: two }), 'move')
  assert.equal(streamManagerScreenKeyPlan({ screenMoves: 'wayland', screens: two }), 'wayland')
  assert.equal(
    streamManagerScreenKeyPlan({
      screenMoves: 'wayland',
      screens: [...two, { id: '3', name: 'C' }]
    }),
    'wayland'
  )
  assert.equal(streamManagerScreenKeyPlan({ screenMoves: 'supported', screens: one }), 'one-screen')
  assert.equal(streamManagerScreenKeyPlan({ screenMoves: 'wayland', screens: one }), 'one-screen')
  assert.equal(streamManagerScreenKeyPlan({ screens: two }), null)
  assert.equal(streamManagerScreenKeyPlan({ screenMoves: 'x11', screens: two }), null)
  assert.equal(streamManagerScreenKeyPlan(undefined), null)
})

test('the Wayland refusal is the copy the Studio sends', () => {
  const copy = readFileSync(
    new URL('../../apps/desktop/src/renderer/src/lib/studio-actions/copy.ts', import.meta.url),
    'utf8'
  )
  assert.ok(copy.includes(JSON.stringify(STREAM_MANAGER_WAYLAND_REFUSAL)))
})
