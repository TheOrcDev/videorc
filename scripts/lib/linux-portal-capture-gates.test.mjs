import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PORTAL_MONITOR_SOURCE_ID,
  PORTAL_WINDOW_SOURCE_ID,
  assessPortalDeviceList,
  assessPortalPreviewProof,
  assessPortalRecording,
  assessPortalScreenStatus
} from './linux-portal-capture-gates.mjs'

const portalDevices = [
  { id: PORTAL_MONITOR_SOURCE_ID, kind: 'screen', status: 'available' },
  { id: PORTAL_WINDOW_SOURCE_ID, kind: 'window', status: 'available' },
  { id: 'system-audio:default', kind: 'system-audio', status: 'unavailable' }
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

test('a portal recording must carry video at the requested size over most of the take', () => {
  const expected = { width: 1920, height: 1080, recordingMs: 6000 }
  const good = {
    metrics: { hasVideo: true, width: 1920, height: 1080, durationSeconds: 5.9 },
    sizeBytes: 2_000_000
  }
  assert.deepEqual(assessPortalRecording(good, expected), { ok: true, failures: [] })

  const noVideo = assessPortalRecording(
    { metrics: { hasVideo: false, durationSeconds: 5.8 }, sizeBytes: 2_000_000 },
    expected
  )
  assert.equal(noVideo.ok, false)
  assert.match(noVideo.failures.join(';'), /no video stream/)

  const wrongSize = assessPortalRecording(
    { ...good, metrics: { ...good.metrics, width: 2880, height: 1800 } },
    expected
  )
  assert.match(wrongSize.failures.join(';'), /2880x1800 != requested 1920x1080/)

  const short = assessPortalRecording(
    { ...good, metrics: { ...good.metrics, durationSeconds: 1.2 } },
    expected
  )
  assert.match(short.failures.join(';'), /duration 1.2s < 5.9s/)

  assert.equal(
    assessPortalRecording({ ...good, metrics: { ...good.metrics, durationSeconds: 3.6 } }, expected)
      .ok,
    false,
    'a take missing 40% of its requested duration is not acceptance evidence'
  )

  const empty = assessPortalRecording({ ...good, sizeBytes: 900 }, expected)
  assert.match(empty.failures.join(';'), /file size 900 bytes/)

  assert.equal(assessPortalRecording(undefined, expected).ok, false)
})
