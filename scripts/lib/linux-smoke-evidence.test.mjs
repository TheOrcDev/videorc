import assert from 'node:assert/strict'
import test from 'node:test'

import { isLinuxSmokeEvidenceLine } from './linux-smoke-evidence.mjs'

test('the VAAPI probe command and prebuild progress always reach the smoke log', () => {
  assert.equal(
    isLinuxSmokeEvidenceLine(
      '[backend:info] VAAPI probe on renderD128 (standard profile): /x/ffmpeg -hide_banner'
    ),
    true
  )
  assert.equal(isLinuxSmokeEvidenceLine('[smoke:prebuild] cargo build -p videorc-backend'), true)
  assert.equal(isLinuxSmokeEvidenceLine('[backend:info] Backend runtime pid=1'), false)
  assert.equal(isLinuxSmokeEvidenceLine('[smoke] backend-ready {}'), false)
  assert.equal(isLinuxSmokeEvidenceLine(undefined), false)
})
