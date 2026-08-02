import { describe, expect, it } from 'vitest'

import { studioHealth, type StudioHealthInput } from './studio-health'

function stats(overrides: Partial<StudioHealthInput> = {}): StudioHealthInput {
  return {
    compositorBackend: 'metal',
    compositorCpuFallbackFrames: 0,
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    ...overrides
  }
}

describe('studioHealth', () => {
  it('reports Live on a healthy Metal session while active', () => {
    expect(studioHealth(stats(), true)).toMatchObject({ tone: 'good', value: 'Live' })
  })

  it('reports Ready on a healthy Metal session while idle', () => {
    expect(studioHealth(stats(), false)).toMatchObject({ tone: 'good', value: 'Ready' })
  })

  it('degrades to "Preview may not match recording" on CPU fallback', () => {
    const result = studioHealth(stats({ compositorBackend: 'cpu-fallback' }), false)
    expect(result.tone).toBe('error')
    expect(result.value).toBe('Degraded')
    expect(result.detail).toContain('Preview may not match recording')
  })

  it('includes the fallback reason in the degraded detail when known', () => {
    const result = studioHealth(
      stats({ compositorBackend: 'cpu-fallback', compositorFallbackReason: 'Metal disabled' }),
      true
    )
    expect(result.detail).toBe('Preview may not match recording — Metal disabled')
  })

  it('degrades when CPU fallback frames appear mid-recording even if the backend label is metal', () => {
    expect(studioHealth(stats({ compositorCpuFallbackFrames: 5 }), true).tone).toBe('error')
  })

  it('does not degrade on stale CPU fallback frames while idle', () => {
    expect(studioHealth(stats({ compositorCpuFallbackFrames: 5 }), false)).toMatchObject({
      tone: 'good',
      value: 'Ready'
    })
  })

  it('warns when preview present latency exceeds the live budget', () => {
    expect(studioHealth(stats({ previewInputToPresentLatencyP95Ms: 120 }), true)).toMatchObject({
      tone: 'warn',
      value: 'Lagging'
    })
  })

  // The red "requires native CAMetalLayer" Blocked state is GONE (owner,
  // 2026-07-07): it fired for transient startup states and read as jargon.
  // Non-native transports warn with a readable message; absent transports are
  // not a health problem — the preview window's presenting watch (plan 021 F1)
  // owns preview-path health.
  it('warns when image polling is the active transport', () => {
    expect(studioHealth(stats({ previewTransport: 'latest-jpeg-polling' }), true)).toMatchObject({
      tone: 'warn',
      value: 'Fallback'
    })
  })

  it('warns when the Electron proof surface is the active transport', () => {
    expect(
      studioHealth(
        stats({
          previewTransport: 'electron-proof-surface',
          previewSurfaceBacking: 'electron-browser-window'
        }),
        false
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('never reds an active session whose preview has no transport yet', () => {
    expect(
      studioHealth(stats({ previewTransport: 'unavailable', previewSurfaceBacking: 'none' }), true)
    ).toMatchObject({ tone: 'good', value: 'Live' })
  })

  it('keeps showing Fallback over Lagging when polling with high latency (no flapping)', () => {
    expect(
      studioHealth(
        stats({ previewTransport: 'latest-jpeg-polling', previewInputToPresentLatencyP95Ms: 200 }),
        true
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('is neutral when no compositor has reported yet', () => {
    expect(studioHealth(stats({ compositorBackend: undefined }), false)).toMatchObject({
      tone: 'neutral',
      value: 'Idle'
    })
  })

  it('reports the retained CPU/proof Windows path as a named fallback', () => {
    expect(
      studioHealth(
        stats({
          compositorBackend: 'cpu',
          compositorCpuFallbackFrames: 0,
          previewTransport: 'electron-proof-surface',
          previewSurfaceBacking: 'electron-browser-window'
        }),
        true,
        'win32',
        'proof-surface'
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('warns on image polling / proof surface on Windows', () => {
    expect(
      studioHealth(stats({ previewTransport: 'latest-jpeg-polling' }), true, 'win32')
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
    expect(
      studioHealth(stats({ previewTransport: 'electron-proof-surface' }), true, 'win32')
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('reads healthy only for the canonical Windows D3D11 presenter', () => {
    expect(
      studioHealth(
        stats({
          compositorBackend: 'd3d11',
          previewTransport: 'd3d11-shared-texture',
          previewSurfaceBacking: 'directcomposition-swapchain'
        }),
        true,
        'win32',
        'backend-d3d11-presenter'
      )
    ).toMatchObject({ tone: 'good', value: 'Live' })
    expect(
      studioHealth(
        stats({
          compositorBackend: 'd3d11',
          previewTransport: 'd3d11-shared-texture',
          previewSurfaceBacking: 'directcomposition-swapchain'
        }),
        true,
        'win32',
        'proof-surface'
      )
    ).toMatchObject({ tone: 'warn', value: 'Fallback' })
  })

  it('still degrades on a genuine macOS Metal fallback', () => {
    expect(studioHealth(stats({ compositorBackend: 'cpu-fallback' }), true, 'darwin').tone).toBe(
      'error'
    )
  })
})
