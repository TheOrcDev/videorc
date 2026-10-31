import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LINUX_SOURCE_GATES,
  LINUX_RUNTIME_GATES,
  assessLinuxGateExit,
  linuxGateEnvironment
} from './linux-local-gates.mjs'

test('Linux gate runner cannot certify runtime skips, report-only or absent proof', () => {
  const step = LINUX_RUNTIME_GATES.find((step) => step.id === 'portal-preview')
  const pass =
    'Linux portal preview proof smoke PASS (sourcePixelsPresent=true, surfaceSource=portal)'
  assert.equal(assessLinuxGateExit(step, { code: 0, output: pass }).status, 'pass')
  for (const output of [
    'Linux portal preview proof smoke PASS (portal cancelled; proof skipped)',
    'PASS',
    `${pass}\nSKIP camera`,
    `${pass}\nreport-only`
  ])
    assert.notEqual(assessLinuxGateExit(step, { code: 0, output }).status, 'pass')
  for (const exit of [{ code: 1 }, { code: null, signal: 'SIGTERM' }, { code: 0, timedOut: true }])
    assert.equal(assessLinuxGateExit(step, { ...exit, output: pass }).status, 'failed')
  assert.equal(assessLinuxGateExit(LINUX_SOURCE_GATES[0], { code: 0, output: '' }).status, 'pass')
  const matrix = LINUX_RUNTIME_GATES.find((step) => step.id === 'recording-matrix')
  for (const counts of ['0/0', '13/14'])
    assert.equal(
      assessLinuxGateExit(matrix, { code: 0, output: `Recording matrix: ${counts} combos PASS` })
        .status,
      'failed'
    )
  assert.equal(
    assessLinuxGateExit(matrix, { code: 0, output: 'Recording matrix: 14/14 combos PASS' }).status,
    'pass'
  )
})

test('child environment strips authority and refuses inherited gate relaxations', () => {
  const env = linuxGateEnvironment(
    {
      PATH: '/bin',
      VIDEORC_WEB_DIR: '/private/read-only-web-checkout',
      VIDEORC_LINUX_VAAPI_DEVICE: '/dev/dri/renderD128',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GH_TOKEN: 'secret',
      VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'secret',
      VIDEORC_PORTAL_EXPECT: 'any',
      VIDEORC_PORTAL_RECORD_MOTION: '0',
      VIDEORC_MATRIX_ONLY: '1080p30',
      VIDEORC_PACKAGED_TEST_HOOKS: '1'
    },
    '/tmp/isolated'
  )
  assert.equal(env.VIDEORC_LINUX_VAAPI_DEVICE, '/dev/dri/renderD128')
  assert.equal(env.VIDEORC_WEB_DIR, '/private/read-only-web-checkout')
  assert.equal(env.VIDEORC_PORTAL_EXPECT, 'granted')
  assert.equal(env.VIDEORC_PORTAL_RECORD_MOTION, '1')
  assert.equal(env.VIDEORC_APP_DATA_DIR, '/tmp/isolated/profile')
  for (const key of [
    'AWS_SECRET_ACCESS_KEY',
    'GH_TOKEN',
    'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
    'VIDEORC_MATRIX_ONLY',
    'VIDEORC_PACKAGED_TEST_HOOKS'
  ])
    assert.equal(env[key], undefined)
})

test('first-run Skip setup is an exercised action, while skipped proof still blocks', () => {
  const step = LINUX_RUNTIME_GATES.find((step) => step.id === 'first-run')
  const proof = 'PASS skip-look/skip-look\nPASS first-run smoke: all steps passed'
  assert.equal(assessLinuxGateExit(step, { code: 0, output: proof }).status, 'pass')
  for (const result of ['; skipped: layout click', 'SKIP camera', 'SKIP: camera', 'report-only'])
    assert.equal(
      assessLinuxGateExit(step, { code: 0, output: `${proof}\n${result}` }).status,
      'blocked'
    )
})
