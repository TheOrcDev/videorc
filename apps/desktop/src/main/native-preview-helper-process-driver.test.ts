import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { createNativePreviewHelperProcessDriver } from './native-preview-helper-process-driver'

class FakeStream extends EventEmitter {
  writes: string[] = []
  writable?: boolean

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    void callback
    this.writes.push(chunk)
    return true
  }
}

// Mimics writing to a killed helper: the EPIPE arrives asynchronously via the
// write callback AND the stream 'error' event, never as a synchronous throw.
class BrokenPipeStream extends FakeStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk)
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    setImmediate(() => {
      callback?.(error)
      this.emit('error', error)
    })
    return false
  }
}

class FakeChild extends EventEmitter {
  pid = 7654
  stdin = new FakeStream()
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }

  lastRequest(): Record<string, unknown> {
    const line = this.stdin.writes.at(-1)
    if (!line) {
      throw new Error('expected helper request')
    }
    return JSON.parse(line) as Record<string, unknown>
  }

  respond(payload: unknown): void {
    this.respondTo(this.stdin.writes.length - 1, payload)
  }

  respondTo(index: number, payload: unknown): void {
    const line = this.stdin.writes[index]
    if (!line) {
      throw new Error(`expected helper request at index ${index}`)
    }
    const request = JSON.parse(line) as Record<string, unknown>
    this.stdout.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ok: true,
        payload
      })}\n`
    )
  }
}

describe('native-preview-helper-process-driver', () => {
  it('forwards host commands to the helper process', async () => {
    const child = new FakeChild()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never
    })

    const promise = driver.applyHostCommands([{ kind: 'create', bounds: surfaceBounds() }])
    expect(child.lastRequest().method).toBe('applyHostCommands')
    child.respond({ hasOverlay: true })

    await expect(promise).resolves.toBeNull()
  })

  it('rejects the request instead of crashing when the helper pipe breaks at quit', async () => {
    const child = new FakeChild()
    child.stdin = new BrokenPipeStream()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never
    })

    // Pre-fix this killed the process: the EPIPE 'error' event had no listener.
    await expect(driver.applyHostCommands([{ kind: 'destroy' }])).rejects.toThrow(
      /write failed: write EPIPE/
    )
  })

  it('rejects immediately when the helper stdin is already unwritable', async () => {
    const child = new FakeChild()
    child.stdin.writable = false
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never
    })

    await expect(driver.applyHostCommands([{ kind: 'destroy' }])).rejects.toThrow(
      /stdin is not writable/
    )
    expect(child.stdin.writes).toHaveLength(0)
  })

  it('reports helper process start and exit pids to the owner registry callbacks', async () => {
    const child = new FakeChild()
    const started: Array<{ pid: number; label: string }> = []
    const exited: number[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never,
      onProcessStarted: (pid, label) => started.push({ pid, label }),
      onProcessExited: (pid) => exited.push(pid)
    })

    const promise = driver.applyHostCommands([{ kind: 'create', bounds: surfaceBounds() }])
    child.respond({ hasOverlay: true })
    await expect(promise).resolves.toBeNull()
    child.emit('close', 0, null)

    expect(started).toEqual([{ pid: 7654, label: 'native-preview-helper' }])
    expect(exited).toEqual([7654])
  })

  it('kills the helper wrapper when durable process registration fails', async () => {
    const child = new FakeChild()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never,
      onProcessStarted: () => {
        throw new Error('exact process identity is unavailable')
      }
    })

    await expect(
      driver.applyHostCommands([{ kind: 'create', bounds: surfaceBounds() }])
    ).rejects.toThrow('exact process identity is unavailable')
    expect(child.killed).toBe(true)
  })

  it('kills the direct helper and wrapper when ready-pid registration fails', async () => {
    const child = new FakeChild()
    const terminated: number[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'cargo',
      args: ['run', '--quiet', '-p', 'videorc-backend', '--bin', 'native_preview_host_helper'],
      spawnProcess: () => child as never,
      onProcessStarted: (pid) => {
        if (pid === 8765) {
          throw new Error('exact process identity is unavailable')
        }
      },
      terminateProcess: (pid) => {
        terminated.push(pid)
        return true
      }
    })

    const pending = driver.applyHostCommands([{ kind: 'create', bounds: surfaceBounds() }])
    expect(() =>
      child.stdout.emit(
        'data',
        `${JSON.stringify({
          event: 'helper.ready',
          payload: { pid: 8765, parentPid: 7654 }
        })}\n`
      )
    ).not.toThrow()

    await expect(pending).rejects.toThrow('exact process identity is unavailable')
    expect(terminated).toEqual([8765])
    expect(child.killed).toBe(true)
  })

  it('records cargo wrapper and real helper pids separately when helper.ready arrives', async () => {
    const child = new FakeChild()
    const started: Array<{ pid: number; label: string }> = []
    const exited: number[] = []
    const logs: string[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'cargo',
      args: ['run', '--quiet', '-p', 'videorc-backend', '--bin', 'native_preview_host_helper'],
      spawnProcess: () => child as never,
      onProcessStarted: (pid, label) => started.push({ pid, label }),
      onProcessExited: (pid) => exited.push(pid),
      onLog: (_level, message) => logs.push(message)
    })

    const promise = driver.applyHostCommands([{ kind: 'create', bounds: surfaceBounds() }])
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        event: 'helper.ready',
        payload: { pid: 8765, parentPid: 7654 }
      })}\n`
    )
    child.respond({ hasOverlay: true })
    await expect(promise).resolves.toBeNull()
    child.emit('close', 0, null)

    expect(started).toEqual([
      { pid: 7654, label: 'cargo-run-native-preview-helper' },
      { pid: 8765, label: 'native-preview-helper' }
    ])
    expect(exited).toEqual([7654, 8765])
    expect(logs).toContain('Native preview host helper ready pid=8765 parentPid=7654')
  })

  it('normalizes host command bounds before sending them to the helper process', async () => {
    const child = new FakeChild()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never
    })

    const promise = driver.applyHostCommands([
      {
        kind: 'create',
        bounds: {
          screenX: Number.NaN,
          screenY: Number.POSITIVE_INFINITY,
          width: 0,
          height: -10,
          scaleFactor: 0,
          screenHeight: Number.NaN
        }
      }
    ])
    expect(child.lastRequest()).toMatchObject({
      method: 'applyHostCommands',
      commands: [
        {
          kind: 'create',
          bounds: {
            screenX: 0,
            screenY: 0,
            width: 1,
            height: 1,
            scaleFactor: 1
          }
        }
      ]
    })
    child.respond({ hasOverlay: true })

    await expect(promise).resolves.toBeNull()
  })

  it('maps confirmed helper activation into a native preview surface status', async () => {
    const child = new FakeChild()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      now: () => '2026-06-06T12:00:00.000Z',
      nowMs: () => Date.parse('2026-06-06T12:00:00.040Z'),
      spawnProcess: () => child as never
    })

    const promise = driver.presentCompositorHandoff({
      handoff: {
        iosurfaceId: 44,
        width: 1920,
        height: 1080,
        frameId: 12,
        runId: 'helper-run-1'
      },
      bounds: surfaceBounds(),
      scene: {
        revision: 1,
        layout: { layoutPreset: 'screen-camera' } as never,
        sources: [
          {
            id: 'screen',
            name: 'Screen',
            kind: 'screen',
            transform: {} as never,
            visible: true,
            fit: 'contain',
            mirror: false
          }
        ],
        updatedAt: '2026-06-06T12:00:00.000Z'
      },
      suppressFramePolling: true,
      frameAgeMs: 22,
      compositorUpdatedAt: '2026-06-06T12:00:00.010Z'
    })

    expect(child.lastRequest()).toMatchObject({
      method: 'presentCompositorHandoff',
      handoff: {
        iosurfaceId: 44,
        width: 1920,
        height: 1080,
        frameId: 12
      }
    })
    child.respond({
      hasOverlay: true,
      activation: {
        transport: 'native-surface',
        backing: 'cametal-layer',
        presentedFrameId: 12,
        framePollingSuppressed: true,
        sourcePixelsPresent: true,
        message: 'presented'
      }
    })

    await expect(promise).resolves.toMatchObject({
      state: 'live',
      source: 'screen',
      transport: 'native-surface',
      backing: 'cametal-layer',
      width: 640,
      height: 360,
      framesRendered: 12,
      presentedFrameId: 12,
      inputToPresentLatencyMs: 52,
      inputToPresentLatencyP95Ms: 52,
      inputToPresentLatencyP99Ms: 52,
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      nativePreviewPresentedSceneRevision: 1,
      nativePreviewCompositorRunId: 'helper-run-1'
    })
  })

  it('keeps presentation cadence metrics across placement commands', async () => {
    const child = new FakeChild()
    let clockMs = 0
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      nowMs: () => clockMs,
      spawnProcess: () => child as never
    })
    const present = async (frameId: number, presentedAtMs: number) => {
      const promise = driver.presentCompositorHandoff({
        handoff: { iosurfaceId: frameId, width: 16, height: 16, frameId },
        suppressFramePolling: true
      })
      clockMs = presentedAtMs
      child.respond({
        hasOverlay: true,
        activation: {
          transport: 'native-surface',
          backing: 'cametal-layer',
          presentedFrameId: frameId,
          framePollingSuppressed: true,
          sourcePixelsPresent: true
        }
      })
      return promise
    }

    await present(1, 10)
    clockMs = 20
    await expect(present(2, 30)).resolves.toMatchObject({ presentFps: 50 })

    clockMs = 35
    const placement = driver.applyHostCommands([{ kind: 'update-bounds', bounds: surfaceBounds() }])
    clockMs = 36
    child.respond({ hasOverlay: true })
    await placement

    clockMs = 40
    const afterPlacement = await present(3, 300)
    expect(afterPlacement).toMatchObject({
      intervalP95Ms: 270,
      nativePreviewPlacementRoundTripP95Ms: 1,
      nativePreviewPresentRoundTripP95Ms: 260
    })
    expect(afterPlacement?.presentFps).toBeCloseTo((2 * 1000) / 290)
  })

  it('reports other helper requests that remain pending when a frame activates', async () => {
    const child = new FakeChild()
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      spawnProcess: () => child as never
    })
    const hostCommand = driver.applyHostCommands([
      { kind: 'update-bounds', bounds: surfaceBounds() }
    ])
    const present = driver.presentCompositorHandoff({
      handoff: { iosurfaceId: 7, width: 16, height: 16, frameId: 9 },
      suppressFramePolling: true
    })

    child.respondTo(1, {
      hasOverlay: true,
      nativePreviewIosurfaceCacheHits: 12,
      nativePreviewIosurfaceImports: 4,
      nativePreviewIosurfaceInvalidations: 1,
      nativePreviewIosurfaceImportFailures: 2,
      activation: {
        transport: 'native-surface',
        backing: 'cametal-layer',
        presentedFrameId: 9,
        framePollingSuppressed: true,
        sourcePixelsPresent: true
      }
    })

    await expect(present).resolves.toMatchObject({
      pendingHostCommandCount: 1,
      nativePreviewHostKind: 'helper-process',
      nativePreviewHostAttached: true,
      nativePreviewIosurfaceCacheHits: 12,
      nativePreviewIosurfaceImports: 4,
      nativePreviewIosurfaceInvalidations: 1,
      nativePreviewIosurfaceImportFailures: 2
    })
    child.respondTo(0, { hasOverlay: true })
    await hostCommand
  })

  it('returns null when the helper has no real layer activation yet', async () => {
    const child = new FakeChild()
    const logs: string[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      onLog: (_level, message) => logs.push(message),
      spawnProcess: () => child as never
    })

    const promise = driver.presentCompositorHandoff({
      handoff: {
        iosurfaceId: 1,
        width: 8,
        height: 4,
        frameId: 2
      },
      suppressFramePolling: true
    })
    child.respond({
      hasOverlay: false,
      presentFailureReason: 'missing-overlay',
      activation: null
    })

    await expect(promise).resolves.toBeNull()
    expect(logs.at(-1)).toContain('reason=missing-overlay')
  })

  it('retries one transient IOSurface import failure before logging fallback', async () => {
    const child = new FakeChild()
    const logs: string[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      iosurfaceImportRetryDelayMs: 0,
      now: () => '2026-06-06T12:00:00.000Z',
      onLog: (level, message) => {
        if (level === 'warn') {
          logs.push(message)
        }
      },
      spawnProcess: () => child as never
    })

    const promise = driver.presentCompositorHandoff({
      handoff: {
        iosurfaceId: 99,
        width: 16,
        height: 16,
        frameId: 7
      },
      suppressFramePolling: true
    })
    child.respond({
      hasOverlay: true,
      presentFailureReason: 'iosurface-import-failed',
      activation: null
    })
    await waitForWrites(child, 2)
    expect(child.stdin.writes).toHaveLength(2)
    child.respond({
      hasOverlay: true,
      activation: {
        transport: 'native-surface',
        backing: 'cametal-layer',
        presentedFrameId: 7,
        framePollingSuppressed: true,
        sourcePixelsPresent: true,
        message: 'presented'
      }
    })

    await expect(promise).resolves.toMatchObject({
      transport: 'native-surface',
      backing: 'cametal-layer',
      presentedFrameId: 7
    })
    expect(logs.some((message) => message.includes('iosurface-import-failed'))).toBe(false)
  })

  it('keeps isolated cold-start IOSurface import misses quiet', async () => {
    const child = new FakeChild()
    const logs: string[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      iosurfaceImportRetryAttempts: 1,
      iosurfaceImportRetryDelayMs: 0,
      now: () => '2026-06-06T12:00:00.000Z',
      onLog: (level, message) => {
        if (level === 'warn') {
          logs.push(message)
        }
      },
      spawnProcess: () => child as never
    })

    const missedHandoff = driver.presentCompositorHandoff({
      handoff: {
        iosurfaceId: 99,
        width: 16,
        height: 16,
        frameId: 7
      },
      suppressFramePolling: true
    })
    child.respond({
      hasOverlay: true,
      presentFailureReason: 'iosurface-import-failed',
      activation: null
    })

    await expect(missedHandoff).resolves.toBeNull()
    expect(logs).toEqual([])

    const successfulHandoff = driver.presentCompositorHandoff({
      handoff: {
        iosurfaceId: 100,
        width: 16,
        height: 16,
        frameId: 8
      },
      suppressFramePolling: true
    })
    child.respond({
      hasOverlay: true,
      activation: {
        transport: 'native-surface',
        backing: 'cametal-layer',
        presentedFrameId: 8,
        framePollingSuppressed: true,
        sourcePixelsPresent: true,
        message: 'presented'
      }
    })

    await expect(successfulHandoff).resolves.toMatchObject({
      transport: 'native-surface',
      backing: 'cametal-layer',
      presentedFrameId: 8
    })
    expect(logs).toEqual([])
  })

  it('logs persistent IOSurface import failures after the warning threshold', async () => {
    const child = new FakeChild()
    const logs: string[] = []
    const driver = createNativePreviewHelperProcessDriver({
      command: 'helper',
      iosurfaceImportFailureWarnThreshold: 2,
      iosurfaceImportRetryAttempts: 1,
      iosurfaceImportRetryDelayMs: 0,
      onLog: (level, message) => {
        if (level === 'warn') {
          logs.push(message)
        }
      },
      spawnProcess: () => child as never
    })

    for (const frameId of [7, 8]) {
      const promise = driver.presentCompositorHandoff({
        handoff: {
          iosurfaceId: 90 + frameId,
          width: 16,
          height: 16,
          frameId
        },
        suppressFramePolling: true
      })
      child.respond({
        hasOverlay: true,
        presentFailureReason: 'iosurface-import-failed',
        activation: null
      })

      await expect(promise).resolves.toBeNull()
    }

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('compositor frame 8')
    expect(logs[0]).toContain('reason=iosurface-import-failed')
  })
})

function surfaceBounds() {
  return {
    screenX: 10,
    screenY: 20,
    width: 640,
    height: 360,
    scaleFactor: 2,
    screenHeight: 1000
  }
}

async function waitForWrites(child: FakeChild, count: number): Promise<void> {
  const deadline = Date.now() + 100
  while (Date.now() < deadline) {
    if (child.stdin.writes.length >= count) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
