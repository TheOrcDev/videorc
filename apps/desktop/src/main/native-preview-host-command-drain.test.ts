import { describe, expect, it, vi } from 'vitest'

import type { NativePreviewHostCommand, PreviewSurfaceStatus } from '../shared/backend'
import { drainNativePreviewHostCommands } from './native-preview-host-command-drain'

function status(message: string): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'synthetic',
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    targetFps: 60,
    width: 960,
    height: 540,
    framesRendered: 1,
    droppedFrames: 0,
    framePollingSuppressed: false,
    sourcePixelsPresent: true,
    pendingHostCommandCount: 0,
    updatedAt: '2026-07-12T00:00:00.000Z',
    message
  }
}

describe('native preview host command drain', () => {
  it('applies only lifecycle commands with the supplied preview generation', async () => {
    const bounds = {
      screenX: 100,
      screenY: 80,
      width: 960,
      height: 540,
      scaleFactor: 2
    }
    const queued: NativePreviewHostCommand[] = [
      { kind: 'update-bounds', bounds: { ...bounds, screenX: 90 } },
      { kind: 'destroy' },
      { kind: 'create', bounds }
    ]
    const applied = status('applied')
    const applyCommands = vi.fn(async () => applied)

    await expect(
      drainNativePreviewHostCommands({
        generation: 7,
        takeCommands: async () => queued,
        applyCommands,
        currentStatus: () => status('current')
      })
    ).resolves.toBe(applied)

    expect(applyCommands).toHaveBeenCalledWith([{ kind: 'destroy' }, { kind: 'create', bounds }], 7)
  })

  it('returns current main status when the backend only echoed placement', async () => {
    const current = status('current')
    const applyCommands = vi.fn()

    await expect(
      drainNativePreviewHostCommands({
        generation: 3,
        takeCommands: async () => [
          {
            kind: 'update-bounds',
            bounds: {
              screenX: 10,
              screenY: 20,
              width: 800,
              height: 450,
              scaleFactor: 1
            }
          }
        ],
        applyCommands,
        currentStatus: () => current
      })
    ).resolves.toBe(current)

    expect(applyCommands).not.toHaveBeenCalled()
  })
})
