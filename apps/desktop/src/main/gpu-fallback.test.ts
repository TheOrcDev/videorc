import { describe, expect, it } from 'vitest'

import {
  GPU_CRASH_PERSIST_THRESHOLD,
  decideGpuFallback,
  gpuFallbackStatePath,
  isGpuCrashReason,
  readGpuFallbackState,
  shouldPersistGpuFallback,
  writeGpuFallbackState,
  type GpuFallbackState
} from './gpu-fallback'

const persisted: GpuFallbackState = {
  disableHardwareAcceleration: true,
  reason: 'gpu-process-crashes',
  crashCount: 2,
  updatedAt: '2026-07-09T00:00:00.000Z'
}

describe('decideGpuFallback', () => {
  it('honors the explicit escape hatch every launch', () => {
    expect(decideGpuFallback({ env: { VIDEORC_DISABLE_GPU: '1' }, persisted: null })).toEqual({
      disable: true,
      source: 'env',
      clearPersisted: false
    })
  })

  it('applies a persisted crash fallback on the next launch', () => {
    expect(decideGpuFallback({ env: {}, persisted })).toEqual({
      disable: true,
      source: 'persisted',
      clearPersisted: false
    })
  })

  it('VIDEORC_FORCE_GPU overrides and clears the persisted flag', () => {
    expect(decideGpuFallback({ env: { VIDEORC_FORCE_GPU: '1' }, persisted })).toEqual({
      disable: false,
      source: 'none',
      clearPersisted: true
    })
    // Nothing persisted → nothing to clear.
    expect(decideGpuFallback({ env: { VIDEORC_FORCE_GPU: '1' }, persisted: null })).toEqual({
      disable: false,
      source: 'none',
      clearPersisted: false
    })
  })

  it('defaults to hardware acceleration', () => {
    expect(decideGpuFallback({ env: {}, persisted: null })).toEqual({
      disable: false,
      source: 'none',
      clearPersisted: false
    })
  })
})

describe('crash counting', () => {
  it('persists only after repeated crashes (first crash can be a fluke)', () => {
    expect(shouldPersistGpuFallback(1)).toBe(false)
    expect(shouldPersistGpuFallback(GPU_CRASH_PERSIST_THRESHOLD)).toBe(true)
  })

  it('counts only genuine crash reasons, never clean shutdowns', () => {
    expect(isGpuCrashReason('crashed')).toBe(true)
    expect(isGpuCrashReason('launch-failed')).toBe(true)
    expect(isGpuCrashReason('abnormal-exit')).toBe(true)
    expect(isGpuCrashReason('oom')).toBe(true)
    expect(isGpuCrashReason('clean-exit')).toBe(false)
    expect(isGpuCrashReason('killed')).toBe(false)
  })
})

describe('state persistence', () => {
  it('round-trips through the injected store', () => {
    let written = ''
    writeGpuFallbackState(gpuFallbackStatePath('/data'), persisted, {
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined
    })
    const roundTripped = readGpuFallbackState('/data/gpu-fallback.json', {
      readFile: () => written
    })
    expect(roundTripped).toEqual(persisted)
  })

  it('treats missing or corrupt state as no fallback (never blocks startup)', () => {
    expect(
      readGpuFallbackState('/data/gpu-fallback.json', {
        readFile: () => {
          throw new Error('ENOENT')
        }
      })
    ).toBeNull()
    expect(readGpuFallbackState('/data/gpu-fallback.json', { readFile: () => 'not json' })).toBe(
      null
    )
    expect(readGpuFallbackState('/data/gpu-fallback.json', { readFile: () => '{"x":1}' })).toBe(
      null
    )
  })
})
