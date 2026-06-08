import { describe, expect, it } from 'vitest'

import { previewImageFallbackEnabled } from './preview-stage'

describe('previewImageFallbackEnabled', () => {
  it('keeps preview image polling disabled for packaged production builds', () => {
    expect(
      previewImageFallbackEnabled({
        nativePreviewSurfaceEnabled: false,
        runtimeInfo: { isPackaged: true } as never
      })
    ).toBe(false)
  })

  it('keeps preview image polling disabled when the native surface path is enabled', () => {
    expect(
      previewImageFallbackEnabled({
        nativePreviewSurfaceEnabled: true,
        runtimeInfo: { isPackaged: false } as never
      })
    ).toBe(false)
  })

  it('allows preview image polling only for explicit dev fallback runs', () => {
    expect(
      previewImageFallbackEnabled({
        nativePreviewSurfaceEnabled: false,
        runtimeInfo: { isPackaged: false } as never
      })
    ).toBe(true)
  })

  it('defaults to disabled until runtime packaging status is known', () => {
    expect(
      previewImageFallbackEnabled({
        nativePreviewSurfaceEnabled: false,
        runtimeInfo: null
      })
    ).toBe(false)
  })
})
