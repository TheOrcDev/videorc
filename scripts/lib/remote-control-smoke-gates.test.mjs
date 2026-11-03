import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultRingVerdict, SOFTWARE_ENCODER_GUARD_PREFIX } from './remote-control-smoke-gates.mjs'

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
