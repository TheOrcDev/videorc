import assert from 'node:assert/strict'
import test from 'node:test'

import { previewWindowSurfaceReady } from './native-preview-window-gates.mjs'

const windowsOptions = {
  expectedTransport: 'electron-proof-surface',
  expectedBacking: 'electron-browser-window',
  expectNativeMetalPreview: false
}

const windowsEvidence = () => ({
  windowState: {
    open: true,
    visible: true,
    nativeOwnsPlacement: false,
    supervisor: {
      lifecycleState: 'surface-live',
      surfaceActive: true
    },
    surface: { exists: true, visible: true }
  },
  surfaceStatus: {
    state: 'live',
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    targetFps: 60,
    nativePreviewHostKind: 'proof-surface',
    framePollingSuppressed: false,
    firstFrameContract: 'met',
    pendingHostCommandCount: 0,
    bounds: { width: 960, height: 540 }
  }
})

test('preview host readiness rejects backend-live while main is still unavailable', () => {
  const evidence = windowsEvidence()
  evidence.surfaceStatus = {
    state: 'unavailable',
    transport: 'unavailable',
    backing: 'none',
    targetFps: 60,
    framePollingSuppressed: false,
    pendingHostCommandCount: 1
  }

  assert.equal(previewWindowSurfaceReady(evidence, windowsOptions), false)
})

test('Windows proof readiness accepts a visible unsuppressed proof host', () => {
  assert.equal(previewWindowSurfaceReady(windowsEvidence(), windowsOptions), true)
})

test('Windows proof readiness rejects a supervisor that still calls the supported host fallback', () => {
  const evidence = windowsEvidence()
  evidence.windowState.supervisor = {
    lifecycleState: 'surface-fallback',
    surfaceActive: false
  }

  assert.equal(previewWindowSurfaceReady(evidence, windowsOptions), false)
})

test('Windows proof readiness rejects hidden, suppressed, or pending hosts', () => {
  for (const mutate of [
    (evidence) => (evidence.windowState.surface.visible = false),
    (evidence) => (evidence.surfaceStatus.framePollingSuppressed = true),
    (evidence) => (evidence.surfaceStatus.firstFrameContract = 'pending'),
    (evidence) => (evidence.surfaceStatus.pendingHostCommandCount = 1),
    (evidence) => (evidence.surfaceStatus.bounds.width = 0)
  ]) {
    const evidence = windowsEvidence()
    mutate(evidence)
    assert.equal(previewWindowSurfaceReady(evidence, windowsOptions), false)
  }
})

test('preview host readiness rejects the wrong transport or backing', () => {
  for (const field of ['transport', 'backing']) {
    const evidence = windowsEvidence()
    evidence.surfaceStatus[field] = 'wrong'
    assert.equal(previewWindowSurfaceReady(evidence, windowsOptions), false)
  }
})

test('native Metal readiness accepts hidden proof host only with native placement authority', () => {
  const evidence = windowsEvidence()
  evidence.windowState.surface.visible = false
  evidence.windowState.nativeOwnsPlacement = true
  evidence.surfaceStatus.transport = 'native-surface'
  evidence.surfaceStatus.backing = 'cametal-layer'
  evidence.surfaceStatus.nativePreviewHostKind = 'in-process'
  evidence.surfaceStatus.framePollingSuppressed = true

  assert.equal(
    previewWindowSurfaceReady(evidence, {
      expectedTransport: 'native-surface',
      expectedBacking: 'cametal-layer',
      expectNativeMetalPreview: true
    }),
    true
  )
})
