import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimsNativePreview,
  formatTransportHonesty,
  strongestPreviewBacking,
  strongestPreviewTransport
} from './native-preview-claim.mjs'

test('macOS native preview claim requires both native transport and CAMetal backing', () => {
  assert.equal(
    claimsNativePreview({
      previewTransport: 'native-surface',
      diagnostics: { previewSurfaceBacking: 'electron-browser-window' },
      platform: 'darwin'
    }),
    false
  )

  assert.equal(
    claimsNativePreview({
      previewTransport: 'electron-proof-surface',
      diagnostics: {
        transports: ['native-surface'],
        previewSurfaceBacking: 'cametal-layer'
      },
      platform: 'darwin'
    }),
    true
  )

  assert.equal(
    claimsNativePreview({
      previewTransport: 'native-surface',
      diagnostics: { surfaceBackings: ['cametal-layer'] },
      platform: 'darwin'
    }),
    true
  )
})

test('Windows native preview claim requires the complete backend-owned D3D11 triple', () => {
  const complete = {
    previewTransport: 'd3d11-shared-texture',
    diagnostics: {
      previewSurfaceBacking: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter'
    },
    platform: 'win32'
  }
  assert.equal(claimsNativePreview(complete), true)

  for (const input of [
    {
      ...complete,
      diagnostics: {
        ...complete.diagnostics,
        previewSurfaceBacking: 'electron-browser-window'
      }
    },
    {
      ...complete,
      previewTransport: 'electron-proof-surface'
    },
    {
      ...complete,
      diagnostics: {
        ...complete.diagnostics,
        nativePreviewHostKind: 'proof-surface'
      }
    }
  ]) {
    assert.equal(claimsNativePreview(input), false)
  }
})

test('native preview claims reject crossed platform pairs', () => {
  assert.equal(
    claimsNativePreview({
      previewTransport: 'd3d11-shared-texture',
      diagnostics: {
        previewSurfaceBacking: 'directcomposition-swapchain',
        nativePreviewHostKind: 'backend-d3d11-presenter'
      },
      platform: 'darwin'
    }),
    false
  )
  assert.equal(
    claimsNativePreview({
      previewTransport: 'native-surface',
      diagnostics: {
        previewSurfaceBacking: 'cametal-layer',
        nativePreviewHostKind: 'in-process'
      },
      platform: 'win32'
    }),
    false
  )
})

test('transport honesty summary does not call proof transport native just because polling is zero', () => {
  assert.match(
    formatTransportHonesty({
      previewTransport: 'electron-proof-surface',
      diagnostics: {
        transports: ['electron-proof-surface'],
        previewSurfaceBacking: 'electron-browser-window',
        imagePollDuringSession: { total: 0 }
      },
      platform: 'darwin'
    }),
    /^NOT native/
  )

  assert.equal(
    formatTransportHonesty({
      previewTransport: 'native-surface',
      diagnostics: {
        transports: ['native-surface'],
        previewSurfaceBacking: 'cametal-layer',
        imagePollDuringSession: { total: 0 }
      },
      platform: 'darwin'
    }),
    'native (0 image polls)'
  )

  assert.equal(
    formatTransportHonesty({
      previewTransport: 'd3d11-shared-texture',
      diagnostics: {
        previewSurfaceBacking: 'directcomposition-swapchain',
        nativePreviewHostKind: 'backend-d3d11-presenter',
        imagePollDuringSession: { total: 0 }
      },
      platform: 'win32'
    }),
    'native (0 image polls)'
  )
})

test('strongest preview status keeps live proof/native evidence over teardown samples', () => {
  assert.equal(
    strongestPreviewTransport(['unavailable', 'electron-proof-surface', 'unavailable']),
    'electron-proof-surface'
  )
  assert.equal(
    strongestPreviewTransport(['electron-proof-surface', 'native-surface']),
    'native-surface'
  )
  assert.equal(
    strongestPreviewTransport(['electron-proof-surface', 'd3d11-shared-texture']),
    'd3d11-shared-texture'
  )
  assert.equal(
    strongestPreviewBacking(['none', 'electron-browser-window', 'none']),
    'electron-browser-window'
  )
  assert.equal(
    strongestPreviewBacking(['electron-browser-window', 'cametal-layer']),
    'cametal-layer'
  )
  assert.equal(
    strongestPreviewBacking(['electron-browser-window', 'directcomposition-swapchain']),
    'directcomposition-swapchain'
  )
})
