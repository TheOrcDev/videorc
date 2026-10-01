import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateBlankFallback,
  evaluateCrashRecovery,
  evaluateDefaultLaunch,
  evaluateRememberedFallback,
  evaluateSoftwareRenderingLaunch,
  windowsBuildFromRelease
} from './main-window-recovery-gates.mjs'

const mica = { kind: 'mica', reason: null, paintCheck: 'painted' }
const solid = (reason, paintCheck = 'skipped') => ({ kind: 'solid', reason, paintCheck })
const recoveryLog = [
  'Renderer process gone (crashed, exit 1) for index.html.',
  'Reloading the main window: its renderer process is gone (crashed, exit 1) (capture state: idle).'
].join('\n')

test('reads the Windows build', () => {
  assert.equal(windowsBuildFromRelease('10.0.26100'), 26100)
  assert.equal(windowsBuildFromRelease('nope'), undefined)
})

test('default launch passes on a painted Mica window and on a solid Windows 10 window', () => {
  assert.deepEqual(
    evaluateDefaultLaunch({ mounted: true, glass: mica, osRelease: '10.0.26100' }),
    []
  )
  assert.deepEqual(
    evaluateDefaultLaunch({ mounted: true, glass: solid('platform'), osRelease: '10.0.19045' }),
    []
  )
})

test('default launch fails on an unmounted page, a missing verdict, or the wrong material', () => {
  assert.equal(
    evaluateDefaultLaunch({ mounted: false, glass: mica, osRelease: '10.0.26100' }).length,
    1
  )
  assert.equal(
    evaluateDefaultLaunch({
      mounted: true,
      glass: { ...mica, paintCheck: 'pending' },
      osRelease: '10.0.26100'
    }).length,
    1
  )
  assert.equal(
    evaluateDefaultLaunch({ mounted: true, glass: solid('platform'), osRelease: '10.0.26100' })
      .length,
    1
  )
  assert.equal(evaluateDefaultLaunch({ mounted: true, glass: undefined, osRelease: 'x' }).length, 1)
})

test('crash recovery needs the remount and both log lines', () => {
  assert.deepEqual(evaluateCrashRecovery({ crashed: true, remounted: true, log: recoveryLog }), [])
  assert.equal(
    evaluateCrashRecovery({ crashed: true, remounted: false, log: recoveryLog }).length,
    1
  )
  assert.equal(evaluateCrashRecovery({ crashed: true, remounted: true, log: '' }).length, 2)
  assert.equal(
    evaluateCrashRecovery({ crashed: false, remounted: true, log: recoveryLog }).length,
    1
  )
})

test('software rendering must be solid, for the right reason per build', () => {
  const base = { mounted: true, softwareRendering: true }
  assert.deepEqual(
    evaluateSoftwareRenderingLaunch({
      ...base,
      glass: solid('software-rendering'),
      osRelease: '10.0.26100'
    }),
    []
  )
  assert.deepEqual(
    evaluateSoftwareRenderingLaunch({ ...base, glass: solid('platform'), osRelease: '10.0.19045' }),
    []
  )
  assert.equal(
    evaluateSoftwareRenderingLaunch({ ...base, glass: mica, osRelease: '10.0.26100' }).length,
    1
  )
  assert.equal(
    evaluateSoftwareRenderingLaunch({
      mounted: true,
      softwareRendering: false,
      glass: solid('software-rendering'),
      osRelease: '10.0.26100'
    }).length,
    1
  )
})

test('the blank fallback is applied, remembered and logged', () => {
  const good = {
    mounted: true,
    glass: solid('paint-check-blank', 'blank'),
    stateFileExists: true,
    log: 'The main window drew nothing on the Mica backdrop. Switching to the solid window'
  }
  assert.deepEqual(evaluateBlankFallback(good), [])
  assert.equal(evaluateBlankFallback({ ...good, glass: mica }).length, 2)
  assert.equal(evaluateBlankFallback({ ...good, stateFileExists: false }).length, 1)
  assert.equal(evaluateBlankFallback({ ...good, log: '' }).length, 1)
  assert.deepEqual(
    evaluateRememberedFallback({ mounted: true, glass: solid('paint-check-blank') }),
    []
  )
  assert.equal(evaluateRememberedFallback({ mounted: true, glass: mica }).length, 1)
})
