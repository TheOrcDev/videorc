import { describe, expect, it } from 'vitest'

import type { NativePreviewHostCommand, PreviewSurfaceBounds } from '../shared/backend'
import {
  createNativePreviewInProcessDriver,
  nativePreviewInProcessBindingFromModule,
  type NativePreviewInProcessBinding
} from './native-preview-in-process-driver'

const bounds = (overrides: Partial<PreviewSurfaceBounds> = {}): PreviewSurfaceBounds => ({
  screenX: 120,
  screenY: 80,
  width: 960,
  height: 540,
  scaleFactor: 2,
  visible: true,
  ...overrides
})

describe('native preview in-process driver', () => {
  it('attaches once and ignores position-only window movement', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const binding: NativePreviewInProcessBinding = {
      attach: (...args) => {
        calls.push({ method: 'attach', args })
      },
      update: (...args) => {
        calls.push({ method: 'update', args })
      },
      present: (...args) => {
        calls.push({ method: 'present', args })
        return { presented: true }
      },
      destroy: () => {
        calls.push({ method: 'destroy', args: [] })
      },
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const nativeWindowHandle = Buffer.from('0100000000000000', 'hex')
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => nativeWindowHandle
    })

    const create: NativePreviewHostCommand = { kind: 'create', bounds: bounds() }
    const move: NativePreviewHostCommand = {
      kind: 'update-bounds',
      bounds: bounds({ screenX: 480, screenY: 260 })
    }

    await driver.applyHostCommands([create])
    await driver.applyHostCommands([move])

    expect(calls).toEqual([
      {
        method: 'attach',
        args: [nativeWindowHandle, 960, 540, 2, true]
      }
    ])
  })

  it('adopts fast-move bounds from the next present without updating the child layer', async () => {
    const calls: string[] = []
    const binding: NativePreviewInProcessBinding = {
      attach: () => calls.push('attach'),
      update: () => calls.push('update'),
      present: () => {
        calls.push('present')
        return { presented: true }
      },
      destroy: () => calls.push('destroy'),
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    const movedBounds = bounds({ screenX: 480, screenY: 260 })

    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const status = await driver.presentCompositorHandoff({
      handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3, runId: 'run-a' },
      bounds: movedBounds,
      scene: null,
      suppressFramePolling: false
    })

    expect(status?.bounds).toEqual(movedBounds)
    expect(calls).toEqual(['attach', 'present'])
  })

  it('keeps fast-move bounds when the next compositor request is stale', async () => {
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: () => ({ presented: true }),
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    await driver.presentCompositorHandoff({
      handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3, runId: 'run-a' },
      bounds: bounds(),
      scene: null,
      suppressFramePolling: false
    })
    const movedBounds = bounds({ screenX: 480, screenY: 260 })

    await expect(
      driver.presentCompositorHandoff({
        handoff: { iosurfaceId: 8, width: 1920, height: 1080, frameId: 2, runId: 'run-a' },
        bounds: movedBounds,
        scene: null,
        suppressFramePolling: false
      })
    ).resolves.toMatchObject({ bounds: movedBounds, presentedFrameId: 3 })
  })

  it('fails the presenter when the binding loses its native layer attachment', async () => {
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: () => ({ presented: true }),
      destroy: () => undefined,
      attached: () => false,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })

    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    await expect(
      driver.presentCompositorHandoff({
        handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3 },
        bounds: bounds(),
        scene: null,
        suppressFramePolling: false
      })
    ).rejects.toThrow(/native preview layer is no longer attached/i)
  })

  it('does not acquire a CAMetalLayer drawable while the preview is hidden', async () => {
    const presentedFrames: number[] = []
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: (_iosurfaceId, _width, _height, frameId) => {
        presentedFrames.push(frameId)
        return { presented: true }
      },
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    const hiddenBounds = bounds({ visible: false })
    await driver.applyHostCommands([{ kind: 'create', bounds: hiddenBounds }])

    await expect(
      driver.presentCompositorHandoff({
        handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3, runId: 'run-a' },
        bounds: hiddenBounds,
        scene: null,
        suppressFramePolling: true
      })
    ).resolves.toBeNull()
    expect(presentedFrames).toEqual([])
  })

  it('counts failed native presents without treating coalesced compositor frames as drops', async () => {
    let shouldPresent = false
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: () => ({ presented: shouldPresent, reason: 'drawable-unavailable' }),
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const request = {
      handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3 },
      bounds: bounds(),
      scene: null,
      suppressFramePolling: false
    }

    await expect(driver.presentCompositorHandoff(request)).resolves.toBeNull()
    shouldPresent = true
    await expect(
      driver.presentCompositorHandoff({
        ...request,
        handoff: { ...request.handoff, frameId: 8 }
      })
    ).resolves.toMatchObject({ droppedFrames: 1, presentedFrameId: 8 })
  })

  it('reports real in-process cadence and input-to-present measurements', async () => {
    let nowMs = 1_000
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: () => ({ presented: true }),
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex'),
      nowMs: () => nowMs,
      percentileCacheTtlMs: 0
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const request = {
      handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId: 3 },
      bounds: bounds(),
      scene: null,
      suppressFramePolling: false,
      frameAgeMs: 5,
      compositorUpdatedAt: new Date(990).toISOString()
    }

    await driver.presentCompositorHandoff(request)
    nowMs = 1_016
    const status = await driver.presentCompositorHandoff({
      ...request,
      handoff: { ...request.handoff, frameId: 4 }
    })

    expect(status).toMatchObject({
      presentFps: 62.5,
      intervalP95Ms: 16,
      inputToPresentLatencyMs: 31,
      inputToPresentLatencyP95Ms: 31
    })
  })

  it('queries native metrics on telemetry ticks rather than every present', async () => {
    let nowMs = 10_000
    let metricsCalls = 0
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: () => ({ presented: true }),
      destroy: () => undefined,
      attached: () => true,
      metrics: () => {
        metricsCalls += 1
        return emptyMetrics()
      }
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex'),
      nowMs: () => nowMs,
      percentileCacheTtlMs: 250
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])

    for (let index = 0; index < 10_000; index += 1) {
      await driver.presentCompositorHandoff({
        handoff: {
          iosurfaceId: 9,
          width: 1920,
          height: 1080,
          frameId: index + 1,
          runId: 'telemetry-run'
        },
        bounds: bounds(),
        scene: null,
        suppressFramePolling: true
      })
      nowMs += 1
    }

    expect(metricsCalls).toBeGreaterThanOrEqual(40)
    expect(metricsCalls).toBeLessThanOrEqual(41)
  })

  it('reports a native CAMetalLayer activation only after the binding presents', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const binding: NativePreviewInProcessBinding = {
      attach: (...args) => {
        calls.push({ method: 'attach', args })
      },
      update: () => undefined,
      present: (...args) => {
        calls.push({ method: 'present', args })
        return { presented: true }
      },
      destroy: () => undefined,
      attached: () => true,
      metrics: () => ({
        iosurfaceCacheHits: 9,
        iosurfaceImports: 2,
        iosurfaceInvalidations: 1,
        iosurfaceImportFailures: 0,
        drawableWidth: 1920,
        drawableHeight: 1080,
        contentsScale: 2
      })
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })

    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const status = await driver.presentCompositorHandoff({
      handoff: { iosurfaceId: 41, width: 1920, height: 1080, frameId: 77 },
      bounds: bounds(),
      scene: null,
      suppressFramePolling: false,
      frameAgeMs: 4,
      compositorUpdatedAt: new Date().toISOString()
    })

    expect(calls.at(-1)).toEqual({ method: 'present', args: [41, 1920, 1080, 77] })
    expect(status).toMatchObject({
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      framesRendered: 77,
      presentedFrameId: 77,
      sourcePixelsPresent: true,
      pendingHostCommandCount: 0,
      nativePreviewHostKind: 'in-process',
      nativePreviewHostAttached: true,
      nativePreviewPlacementEventsReceived: 1,
      nativePreviewPlacementsApplied: 1,
      nativePreviewPlacementsCoalesced: 0,
      nativePreviewIosurfaceCacheHits: 9,
      nativePreviewIosurfaceImports: 2,
      nativePreviewIosurfaceInvalidations: 1,
      nativePreviewIosurfaceImportFailures: 0,
      nativePreviewDrawableWidth: 1920,
      nativePreviewDrawableHeight: 1080,
      nativePreviewContentsScale: 2,
      bounds: bounds()
    })
  })

  it('never presents an older frame from the same compositor run', async () => {
    const presentedFrames: number[] = []
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: (_iosurfaceId, _width, _height, frameId) => {
        presentedFrames.push(frameId)
        return { presented: true }
      },
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])

    const request = {
      handoff: {
        iosurfaceId: 9,
        width: 1920,
        height: 1080,
        frameId: 36,
        runId: 'run-a'
      },
      bounds: bounds(),
      scene: null,
      suppressFramePolling: false
    }
    await expect(driver.presentCompositorHandoff(request)).resolves.toMatchObject({
      presentedFrameId: 36,
      nativePreviewCompositorRunId: 'run-a'
    })
    await expect(
      driver.presentCompositorHandoff({
        ...request,
        handoff: { ...request.handoff, frameId: 35 }
      })
    ).resolves.toMatchObject({ presentedFrameId: 36 })

    expect(presentedFrames).toEqual([36])
  })

  it('allows duplicate frames and a legitimate frame reset from a new compositor run', async () => {
    const presentedFrames: Array<{ runId: string | undefined; frameId: number }> = []
    let currentRunId: string | undefined
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: (_iosurfaceId, _width, _height, frameId) => {
        presentedFrames.push({ runId: currentRunId, frameId })
        return { presented: true }
      },
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const present = async (runId: string, frameId: number) => {
      currentRunId = runId
      return driver.presentCompositorHandoff({
        handoff: { iosurfaceId: 9, width: 1920, height: 1080, frameId, runId },
        bounds: bounds(),
        scene: null,
        suppressFramePolling: false
      })
    }

    await present('run-a', 36)
    await present('run-a', 36)
    await expect(present('run-b', 1)).resolves.toMatchObject({
      presentedFrameId: 1,
      nativePreviewCompositorRunId: 'run-b'
    })

    expect(presentedFrames).toEqual([
      { runId: 'run-a', frameId: 36 },
      { runId: 'run-a', frameId: 36 },
      { runId: 'run-b', frameId: 1 }
    ])
  })

  it('does not let a retired compositor run reclaim the layer after a newer run presents', async () => {
    const presentedFrames: number[] = []
    const binding: NativePreviewInProcessBinding = {
      attach: () => undefined,
      update: () => undefined,
      present: (_iosurfaceId, _width, _height, frameId) => {
        presentedFrames.push(frameId)
        return { presented: true }
      },
      destroy: () => undefined,
      attached: () => true,
      metrics: () => emptyMetrics()
    }
    const driver = createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex')
    })
    await driver.applyHostCommands([{ kind: 'create', bounds: bounds() }])
    const present = (runId: string, frameId: number) =>
      driver.presentCompositorHandoff({
        handoff: { iosurfaceId: frameId, width: 1920, height: 1080, frameId, runId },
        bounds: bounds(),
        scene: null,
        suppressFramePolling: false
      })

    await present('run-a', 36)
    await present('run-b', 1)
    await expect(present('run-a', 37)).resolves.toMatchObject({
      presentedFrameId: 1,
      nativePreviewCompositorRunId: 'run-b'
    })
    expect(presentedFrames).toEqual([36, 1])
  })

  it('adapts the packaged native addon exports to the driver binding', () => {
    const module = {
      attachNativePreview: () => undefined,
      updateNativePreview: () => undefined,
      presentNativePreview: () => ({ presented: true }),
      destroyNativePreview: () => undefined,
      nativePreviewAttached: () => true,
      nativePreviewMetrics: () => ({
        iosurfaceCacheHits: 4,
        iosurfaceImports: 1,
        iosurfaceInvalidations: 0,
        iosurfaceImportFailures: 0
      })
    }

    const binding = nativePreviewInProcessBindingFromModule(module)

    expect(binding).not.toBeNull()
    expect(binding?.present(7, 1280, 720, 12)).toEqual({ presented: true })
    expect(binding?.attached()).toBe(true)
    expect(binding?.metrics().iosurfaceCacheHits).toBe(4)
    expect(nativePreviewInProcessBindingFromModule({})).toBeNull()
  })
})

function emptyMetrics() {
  return {
    iosurfaceCacheHits: 0,
    iosurfaceImports: 0,
    iosurfaceInvalidations: 0,
    iosurfaceImportFailures: 0
  }
}
