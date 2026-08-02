import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseWindowsPreviewLifecycleMode,
  windowsPreviewLifecycleDiagnosticFailures,
  windowsPreviewLifecycleOpenFailures,
  windowsPreviewPresenterFailures
} from './windows-preview-lifecycle-gates.mjs'

const d3dState = () => ({
  contentBounds: { x: 120, y: 80, width: 960, height: 540 },
  nativeOwnsPlacement: true,
  framePollingSuppressedFlag: true,
  surface: { exists: false, visible: false },
  surfaceStatus: {
    transport: 'd3d11-shared-texture',
    backing: 'directcomposition-swapchain',
    nativePreviewHostKind: 'backend-d3d11-presenter',
    firstFrameContract: 'met',
    sourcePixelsPresent: true,
    framePollingSuppressed: true,
    windowsD3d11Presenter: {
      layered: true,
      transparent: true,
      noActivate: true,
      excludedFromCapture: true,
      windowActive: false,
      windowFocused: false,
      generationMatches: true,
      ownerProcessMatches: true,
      sameAdapter: true,
      sourceLive: true,
      firstPresentSucceeded: true,
      successfulPresents: 9,
      lastPresentedSequence: 44,
      latestWinsDrops: 0,
      hiddenDrops: 0,
      busyDrops: 0,
      staleFrameDrops: 0,
      actualBounds: { x: 120, y: 80, width: 960, height: 540 }
    }
  }
})

test('preview lifecycle mode parsing is strict and mutually exclusive', () => {
  assert.equal(parseWindowsPreviewLifecycleMode([], {}), 'default')
  assert.equal(parseWindowsPreviewLifecycleMode(['--gate'], {}), 'default')
  assert.equal(parseWindowsPreviewLifecycleMode(['--report-only'], {}), 'default')
  assert.equal(
    parseWindowsPreviewLifecycleMode(['--gate'], { VIDEORC_EXPECT_WINDOWS_D3D11: '1' }),
    'windows-d3d11'
  )
  assert.equal(
    parseWindowsPreviewLifecycleMode(['--expect-fallback', 'natural'], {}),
    'windows-fallback'
  )
  assert.throws(
    () =>
      parseWindowsPreviewLifecycleMode(['--expect-fallback', 'natural'], {
        VIDEORC_EXPECT_WINDOWS_D3D11: '1'
      }),
    /mutually exclusive/
  )
  assert.throws(() => parseWindowsPreviewLifecycleMode(['--expect-fallback'], {}), /natural/)
  assert.throws(() => parseWindowsPreviewLifecycleMode(['--unknown'], {}), /Unknown/)
})

test('D3D11 lifecycle state requires the canonical triple, liveness, and no proof host', () => {
  assert.deepEqual(windowsPreviewLifecycleOpenFailures(d3dState(), 'windows-d3d11'), [])
  for (const mutate of [
    (state) => (state.surfaceStatus.transport = 'native-surface'),
    (state) => (state.surfaceStatus.backing = 'cametal-layer'),
    (state) => (state.surfaceStatus.nativePreviewHostKind = 'proof-surface'),
    (state) => (state.surfaceStatus.firstFrameContract = 'pending'),
    (state) => (state.surfaceStatus.sourcePixelsPresent = false),
    (state) => (state.surface.exists = true),
    (state) => (state.framePollingSuppressedFlag = false)
  ]) {
    const state = d3dState()
    mutate(state)
    assert.notDeepEqual(windowsPreviewLifecycleOpenFailures(state, 'windows-d3d11'), [])
  }
})

test('natural fallback requires proof identifiers and a named reason', () => {
  const state = {
    framePollingSuppressedFlag: false,
    surface: { exists: true, visible: true },
    surfaceStatus: {
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      firstFrameContract: 'fallback',
      firstFrameReason: 'D3D11 unavailable',
      framePollingSuppressed: false
    }
  }
  assert.deepEqual(windowsPreviewLifecycleOpenFailures(state, 'windows-fallback'), [])
  delete state.surfaceStatus.firstFrameReason
  assert.match(windowsPreviewLifecycleOpenFailures(state, 'windows-fallback').join('\n'), /reason/)
})

test('D3D11 diagnostics reject BMP work and fallback while natural fallback is named', () => {
  const diagnostics = {
    windowsD3d11Media: {
      state: 'live',
      previewPresents: 4,
      previewBmpRequests: 0,
      previewBmpBytes: 0
    }
  }
  assert.deepEqual(windowsPreviewLifecycleDiagnosticFailures(diagnostics, 'windows-d3d11'), [])
  diagnostics.windowsD3d11Media.previewBmpRequests = 1
  assert.match(
    windowsPreviewLifecycleDiagnosticFailures(diagnostics, 'windows-d3d11').join('\n'),
    /BMP/
  )
  assert.deepEqual(
    windowsPreviewLifecycleDiagnosticFailures(
      { windowsD3d11Media: { state: 'fallback', fallbackReason: 'unsupported adapter' } },
      'windows-fallback'
    ),
    []
  )
})

test('presenter readback proves styles, ownership, bounds, focus, and sequence progress', () => {
  const state = d3dState()
  assert.deepEqual(windowsPreviewPresenterFailures(state, { previousPresentedSequence: 43 }), [])

  state.surfaceStatus.windowsD3d11Presenter.transparent = false
  state.surfaceStatus.windowsD3d11Presenter.windowActive = true
  state.surfaceStatus.windowsD3d11Presenter.actualBounds.x += 10
  assert.deepEqual(windowsPreviewPresenterFailures(state, { previousPresentedSequence: 44 }), [
    'presenter transparent=false',
    'presenter windowActive=true',
    'presenter sequence 44 did not advance beyond 44',
    'presenter x=130 did not match content x=120'
  ])
})
