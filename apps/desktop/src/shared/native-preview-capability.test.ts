import { describe, expect, it } from 'vitest'

import {
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
})
