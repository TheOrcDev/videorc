import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudSmokeWaitScale } from './cloud-managed-smoke.mjs'

test('the cloud smoke wait scale defaults to 1 and refuses nonsense', () => {
  assert.equal(cloudSmokeWaitScale({}), 1)
  assert.equal(cloudSmokeWaitScale({ VIDEORC_CLOUD_SMOKE_WAIT_SCALE: '' }), 1)
  assert.equal(cloudSmokeWaitScale({ VIDEORC_CLOUD_SMOKE_WAIT_SCALE: '3' }), 3)
  for (const bad of ['0', '0.5', '11', 'slow'])
    assert.throws(() => cloudSmokeWaitScale({ VIDEORC_CLOUD_SMOKE_WAIT_SCALE: bad }), /1 to 10/)
})
