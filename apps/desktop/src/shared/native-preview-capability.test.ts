import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from './backend'
import {
  hasCanonicalWindowsD3d11PresenterEvidence,
  isCanonicalWindowsD3d11PreviewStatus,
  isNativePreviewCapability,
  isWindowsD3d11PreviewCapability,
  nativePreviewCapability
} from './native-preview-capability'

describe('nativePreviewCapability', () => {
  it('accepts the Metal pair only on macOS', () => {
    const metal = {
      transport: 'native-surface' as const,
      backing: 'cametal-layer' as const,
      nativePreviewHostKind: 'in-process' as const
    }

    expect(nativePreviewCapability(metal, 'darwin')).toBe('macos-metal')
    expect(nativePreviewCapability(metal, 'win32')).toBeNull()
  })

  it('requires the complete backend-owned D3D11 triple on Windows', () => {
    const d3d11 = {
      transport: 'd3d11-shared-texture' as const,
      backing: 'directcomposition-swapchain' as const,
      nativePreviewHostKind: 'backend-d3d11-presenter' as const
    }

    expect(nativePreviewCapability(d3d11, 'win32')).toBe('windows-d3d11')
    expect(isWindowsD3d11PreviewCapability(d3d11, 'win32')).toBe(true)
    expect(isNativePreviewCapability(d3d11, 'darwin')).toBe(false)
    expect(
      isNativePreviewCapability({ ...d3d11, nativePreviewHostKind: 'proof-surface' }, 'win32')
    ).toBe(false)
  })

  it('never treats proof or polling transports as native', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        isNativePreviewCapability(
          {
            transport: 'electron-proof-surface',
            backing: 'electron-browser-window',
            nativePreviewHostKind: 'proof-surface'
          },
          platform
        )
      ).toBe(false)
      expect(
        isNativePreviewCapability(
          {
            transport: 'latest-jpeg-polling',
            backing: 'none'
          },
          platform
        )
      ).toBe(false)
    }
  })

  it('requires complete current-generation presenter evidence before granting Windows ownership', () => {
    const status = canonicalWindowsStatus()

    expect(hasCanonicalWindowsD3d11PresenterEvidence(status, 7)).toBe(true)
    expect(isCanonicalWindowsD3d11PreviewStatus(status, 7)).toBe(true)
    expect(isCanonicalWindowsD3d11PreviewStatus(status, 8)).toBe(false)
    expect(
      isCanonicalWindowsD3d11PreviewStatus(
        {
          ...status,
          windowsD3d11Presenter: {
            ...status.windowsD3d11Presenter!,
            firstPresentSucceeded: false,
            fallbackReason: 'present-failed'
          }
        },
        7
      )
    ).toBe(false)
  })
})

function canonicalWindowsStatus(): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'screen',
    transport: 'd3d11-shared-texture',
    backing: 'directcomposition-swapchain',
    targetFps: 60,
    width: 1920,
    height: 1080,
    framesRendered: 42,
    presentedFrameId: 42,
    droppedFrames: 0,
    framePollingSuppressed: true,
    sourcePixelsPresent: true,
    nativePreviewHostKind: 'backend-d3d11-presenter',
    nativePreviewHostAttached: true,
    pendingHostCommandCount: 0,
    updatedAt: '2026-07-30T00:00:01.000Z',
    windowsD3d11Presenter: {
      layered: true,
      transparent: true,
      noActivate: true,
      excludedFromCapture: true,
      windowActive: false,
      windowFocused: false,
      previewGeneration: 7,
      mediaGeneration: 11,
      generationMatches: true,
      ownerProcessMatches: true,
      sameAdapter: true,
      sourceLive: true,
      firstPresentSucceeded: true,
      successfulPresents: 42,
      lastPresentedSequence: 42,
      latestWinsDrops: 0,
      hiddenDrops: 0,
      busyDrops: 0,
      staleFrameDrops: 0
    }
  }
}
