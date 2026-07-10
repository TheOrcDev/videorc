import { describe, expect, it, vi } from 'vitest'

import { loadNativePreviewInProcessDriver } from './native-preview-in-process-loader'

describe('native preview in-process loader', () => {
  it('loads the packaged addon and binds it to the Electron native view handle', async () => {
    const nativeHandle = Buffer.from('0100000000000000', 'hex')
    const attachNativePreview = vi.fn()
    const loaded = loadNativePreviewInProcessDriver({
      modulePath: '/app/Contents/Resources/videorc_native_preview.node',
      loadModule: () => ({
        attachNativePreview,
        updateNativePreview: vi.fn(),
        presentNativePreview: vi.fn(() => ({ presented: true })),
        destroyNativePreview: vi.fn(),
        nativePreviewAttached: vi.fn(() => true),
        nativePreviewMetrics: vi.fn(() => ({
          iosurfaceCacheHits: 0,
          iosurfaceImports: 0,
          iosurfaceInvalidations: 0,
          iosurfaceImportFailures: 0
        }))
      }),
      getNativeWindowHandle: () => nativeHandle
    })

    expect(loaded.unavailableReason).toBeUndefined()
    await loaded.driver?.applyHostCommands([
      {
        kind: 'create',
        bounds: {
          screenX: 100,
          screenY: 100,
          width: 640,
          height: 360,
          scaleFactor: 2,
          visible: true
        }
      }
    ])
    expect(attachNativePreview).toHaveBeenCalledWith(nativeHandle, 640, 360, 2, true)
  })

  it('returns the exact module load or export failure instead of claiming native ownership', () => {
    expect(
      loadNativePreviewInProcessDriver({
        modulePath: '/broken.node',
        loadModule: () => {
          throw new Error('wrong architecture')
        },
        getNativeWindowHandle: () => null
      })
    ).toEqual({
      driver: null,
      unavailableReason:
        'In-process CAMetalLayer addon failed to load from /broken.node: wrong architecture'
    })

    expect(
      loadNativePreviewInProcessDriver({
        modulePath: '/invalid.node',
        loadModule: () => ({}),
        getNativeWindowHandle: () => null
      })
    ).toEqual({
      driver: null,
      unavailableReason:
        'In-process CAMetalLayer addon at /invalid.node did not export the required attachment, presentation, and metrics functions'
    })
  })
})
