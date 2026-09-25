import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PORTAL_MONITOR_SOURCE_ID,
  PORTAL_WINDOW_SOURCE_ID,
  assessPortalDeviceList,
  assessPortalPreviewProof,
  assessPortalScreenStatus
} from './linux-portal-capture-gates.mjs'

const portalDevices = [
  { id: PORTAL_MONITOR_SOURCE_ID, kind: 'screen', status: 'available' },
  { id: PORTAL_WINDOW_SOURCE_ID, kind: 'window', status: 'available' },
  { id: 'audio:system', kind: 'systemAudio', status: 'unavailable' }
]

test('the Linux device list carries one available portal monitor and window entry', () => {
  assert.deepEqual(assessPortalDeviceList(portalDevices), { ok: true, failures: [] })
  const missing = assessPortalDeviceList(portalDevices.slice(1))
  assert.equal(missing.ok, false)
  assert.match(missing.failures.join('\n'), /lacks screen:portal:monitor/)
  const unavailable = assessPortalDeviceList([
    { ...portalDevices[0], status: 'unavailable', detail: 'no graphical session' },
    portalDevices[1]
  ])
  assert.match(unavailable.failures.join('\n'), /status=unavailable: no graphical session/)
})

test('a granted portal stream must be live with frames and portal copy', () => {
  const live = {
    state: 'live',
    framesCaptured: 42,
    width: 1920,
    height: 1080,
    message: 'Portal screen capture is live over PipeWire.'
  }
  assert.deepEqual(assessPortalScreenStatus(live), { ok: true, failures: [], outcome: 'granted' })
  const starved = assessPortalScreenStatus({ ...live, framesCaptured: 1 })
  assert.match(starved.failures.join('\n'), /framesCaptured=1 < 5/)
})

test('refusals are named states with a reason, accepted only when expected', () => {
  const cancelled = {
    state: 'permission-needed',
    message:
      'Screen sharing was cancelled in the desktop portal dialog; pick a source to try again.'
  }
  const strict = assessPortalScreenStatus(cancelled)
  assert.equal(strict.ok, false)
  assert.equal(strict.outcome, 'cancelled')
  assert.match(strict.failures.join('\n'), /expected a granted portal stream/)
  const lenient = assessPortalScreenStatus(cancelled, { expect: 'any' })
  assert.deepEqual(lenient, { ok: true, failures: [], outcome: 'cancelled' })
  const silent = assessPortalScreenStatus({ state: 'failed', message: '' }, { expect: 'any' })
  assert.equal(silent.ok, false)
  assert.equal(silent.outcome, 'failed')
  const missing = assessPortalScreenStatus(
    {
      state: 'source-missing',
      message: 'Portal screen capture is unavailable: no D-Bus session bus'
    },
    { expect: 'any' }
  )
  assert.deepEqual(missing, { ok: true, failures: [], outcome: 'missing' })
})

test('Phase D proof requires live compositor, portal layer, and non-synthetic pixels', () => {
  const passing = assessPortalPreviewProof({
    compositor: {
      state: 'live',
      runId: 'run-1',
      sceneSources: [
        {
          id: 'source:screen',
          kind: 'screen',
          visible: true,
          deviceId: PORTAL_MONITOR_SOURCE_ID
        }
      ]
    },
    surface: {
      source: 'screen',
      sourcePixelsPresent: true,
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface'
    }
  })
  assert.deepEqual(passing, { ok: true, failures: [] })

  const synthetic = assessPortalPreviewProof({
    compositor: { state: 'stopped', sceneSources: [] },
    surface: {
      source: 'synthetic',
      sourcePixelsPresent: false,
      transport: 'electron-proof-surface'
    }
  })
  assert.equal(synthetic.ok, false)
  assert.match(synthetic.failures.join('\n'), /compositorState=stopped/)
  assert.match(synthetic.failures.join('\n'), /surfaceSource=synthetic/)
  assert.match(synthetic.failures.join('\n'), /sourcePixelsPresent=false/)
  assert.match(synthetic.failures.join('\n'), /portal screen\/window layer/)

  const nativeClaim = assessPortalPreviewProof({
    compositor: {
      state: 'live',
      runId: 'run-2',
      sceneSources: [
        {
          id: 'source:screen',
          kind: 'screen',
          visible: true,
          deviceId: PORTAL_MONITOR_SOURCE_ID
        }
      ]
    },
    surface: {
      source: 'screen',
      sourcePixelsPresent: true,
      transport: 'native-surface',
      backing: 'cametal-layer',
      nativePreviewHostKind: 'in-process'
    }
  })
  assert.equal(nativeClaim.ok, false)
  assert.match(nativeClaim.failures.join('\n'), /electron-proof-surface/)
  assert.match(nativeClaim.failures.join('\n'), /cametal-layer/)
})
