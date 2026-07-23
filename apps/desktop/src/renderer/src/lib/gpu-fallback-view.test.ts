import { describe, expect, it } from 'vitest'

import { gpuFallbackAge, gpuRenderingLabel } from './gpu-fallback-view'
import type { RuntimeInfo } from './backend'

const runtimeInfo = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  version: '1.0.0',
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  gpuDevices: [],
  hardwareAccelerationDisabled: false,
  gpuFallback: {
    source: 'none',
    reason: null,
    crashCount: 0,
    updatedAt: null,
    retryScheduled: false,
    retryAttempts: 0
  },
  isPackaged: true,
  permissionTargetName: 'Videorc',
  permissionTargetPath: 'C:\\Program Files\\Videorc\\Videorc.exe',
  capturePermissionTargetName: 'videorc-backend.exe',
  capturePermissionTargetPath: 'C:\\Program Files\\Videorc\\videorc-backend.exe',
  nativePreviewSurfaceProofEnabled: true,
  ...overrides
})

describe('GPU fallback view', () => {
  it('formats fallback age without exposing raw timestamps', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    expect(gpuFallbackAge('2026-07-21T11:59:30.000Z', now)).toBe('less than a minute ago')
    expect(gpuFallbackAge('2026-07-21T10:00:00.000Z', now)).toBe('2 hours ago')
    expect(gpuFallbackAge('2026-07-18T12:00:00.000Z', now)).toBe('3 days ago')
  })

  it('labels normal, fallback, and retry launches honestly', () => {
    expect(gpuRenderingLabel(runtimeInfo())).toBe('Hardware accelerated')
    expect(
      gpuRenderingLabel(
        runtimeInfo({
          hardwareAccelerationDisabled: true,
          gpuFallback: {
            source: 'persisted',
            reason: 'gpu-process-crashes',
            crashCount: 2,
            updatedAt: '2026-07-21T00:00:00.000Z',
            retryScheduled: false,
            retryAttempts: 0
          }
        })
      )
    ).toBe('Software rendering')
    expect(
      gpuRenderingLabel(
        runtimeInfo({
          gpuFallback: {
            source: 'retry',
            reason: 'gpu-process-crashes',
            crashCount: 2,
            updatedAt: '2026-07-21T00:00:00.000Z',
            retryScheduled: true,
            retryAttempts: 1
          }
        })
      )
    ).toBe('Hardware retry active')
  })
})
