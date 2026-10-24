import { describe, expect, it } from 'vitest'

import {
  GPU_CRASH_PERSIST_THRESHOLD,
  armGpuFallbackVersionRetry,
  decideGpuFallback,
  gpuCrashFallbackState,
  gpuFallbackStatePath,
  isGpuCrashReason,
  readGpuFallbackState,
  scheduleGpuFallbackRetry,
  startGpuFallbackRetry,
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

  it('runs one explicit accelerated retry without clearing the failure evidence', () => {
    const retry = scheduleGpuFallbackRetry(persisted, '2026-07-10T00:00:00.000Z')

    expect(retry).toEqual({
      ...persisted,
      disableHardwareAcceleration: false,
      retryRequestedAt: '2026-07-10T00:00:00.000Z',
      retryAttempts: 1
    })
    expect(decideGpuFallback({ env: {}, persisted: retry })).toEqual({
      disable: false,
      source: 'retry',
      clearPersisted: false
    })
  })

  it('increments explicit retries without creating an automatic launch loop', () => {
    const first = scheduleGpuFallbackRetry(persisted, '2026-07-10T00:00:00.000Z')
    const failed: GpuFallbackState = {
      ...first,
      disableHardwareAcceleration: true,
      reason: 'gpu-retry-failed',
      updatedAt: '2026-07-10T00:01:00.000Z'
    }

    expect(decideGpuFallback({ env: {}, persisted: failed }).source).toBe('persisted')
    expect(scheduleGpuFallbackRetry(failed, '2026-07-11T00:00:00.000Z').retryAttempts).toBe(2)
  })

  it('fails closed on the next launch when a retry never reached stability', () => {
    const retry = scheduleGpuFallbackRetry(persisted, '2026-07-10T00:00:00.000Z')
    const started = startGpuFallbackRetry(retry, '2026-07-10T00:00:01.000Z', '0.9.12')

    expect(started.appVersion).toBe('0.9.12')
    expect(decideGpuFallback({ env: {}, persisted: started })).toEqual({
      disable: true,
      source: 'persisted',
      clearPersisted: false
    })
  })
})

// Plan 195 S5: a Windows tester ran 0.9.150 in software rendering three months
// after two GPU crashes on an older build: the fallback was never retried.
describe('one accelerated retry per app version', () => {
  const at = '2026-10-25T00:00:00.000Z'

  /** One launch of `appVersion`, as index.ts runs it before app.ready. */
  function launch(
    state: GpuFallbackState | null,
    appVersion: string,
    env: Parameters<typeof armGpuFallbackVersionRetry>[0]['env'] = {}
  ): { state: GpuFallbackState | null; disable: boolean; retry: boolean } {
    const armed = armGpuFallbackVersionRetry({ env, persisted: state, appVersion, requestedAt: at })
    const current = armed ?? state
    const decision = decideGpuFallback({ env, persisted: current })
    if (decision.source === 'retry' && current) {
      return { state: startGpuFallbackRetry(current, at, appVersion), disable: false, retry: true }
    }
    return { state: current, disable: decision.disable, retry: false }
  }

  it('arms one retry for a fallback an older version recorded, keeping its evidence', () => {
    // The tester's file: written before versions were recorded.
    const armed = armGpuFallbackVersionRetry({
      env: {},
      persisted,
      appVersion: '0.9.151',
      requestedAt: at
    })
    expect(armed).toEqual({
      ...persisted,
      disableHardwareAcceleration: false,
      retryRequestedAt: at,
      retryAttempts: 1
    })
    expect(decideGpuFallback({ env: {}, persisted: armed }).source).toBe('retry')
    expect(
      armGpuFallbackVersionRetry({
        env: {},
        persisted: { ...persisted, appVersion: '0.9.150' },
        appVersion: '0.9.151',
        requestedAt: at
      })?.disableHardwareAcceleration
    ).toBe(false)
  })

  it('never re-enables acceleration an explicit launch setting turned off', () => {
    for (const env of [
      { VIDEORC_DISABLE_GPU: '1' },
      { VIDEORC_FORCE_GPU: '1' },
      { VIDEORC_SMOKE_DISABLE_ELECTRON_GPU: '1' }
    ]) {
      expect(
        armGpuFallbackVersionRetry({ env, persisted, appVersion: '0.9.151', requestedAt: at })
      ).toBeNull()
    }
    expect(launch(persisted, '0.9.151', { VIDEORC_DISABLE_GPU: '1' })).toMatchObject({
      disable: true,
      retry: false
    })
  })

  it('arms nothing without a fallback, with a retry already pending, or on the same version', () => {
    const arm = (state: GpuFallbackState | null): GpuFallbackState | null =>
      armGpuFallbackVersionRetry({
        env: {},
        persisted: state,
        appVersion: '0.9.151',
        requestedAt: at
      })
    expect(arm(null)).toBeNull()
    expect(arm(scheduleGpuFallbackRetry(persisted, at))).toBeNull()
    expect(arm({ ...persisted, appVersion: '0.9.151' })).toBeNull()
  })

  it('a crash during the retry restores the fallback for that version, and the next version tries once', () => {
    const first = launch(persisted, '0.9.151')
    expect(first).toMatchObject({ disable: false, retry: true })
    expect(first.state?.appVersion).toBe('0.9.151')

    // Two GPU crashes in that launch: index.ts persists the fallback again.
    const crashed = gpuCrashFallbackState({
      previous: first.state,
      crashCount: 2,
      duringRetry: true,
      appVersion: '0.9.151',
      updatedAt: at
    })
    expect(crashed).toEqual({
      disableHardwareAcceleration: true,
      reason: 'gpu-retry-failed',
      crashCount: 2,
      updatedAt: at,
      retryRequestedAt: at,
      retryAttempts: 1,
      appVersion: '0.9.151'
    })

    // No crash loop: every later launch of 0.9.151 stays in software rendering.
    expect(launch(crashed, '0.9.151')).toMatchObject({ disable: true, retry: false })
    expect(launch(crashed, '0.9.151')).toMatchObject({ disable: true, retry: false })
    // The next version gets its one retry.
    const next = launch(crashed, '0.9.152')
    expect(next).toMatchObject({ disable: false, retry: true })
    expect(next.state?.retryAttempts).toBe(2)
  })

  it('a retry that never reached the stability window is not retried again on that version', () => {
    // The retry launch quit before a stable minute: its started state is on disk.
    const started = launch(persisted, '0.9.151').state
    expect(launch(started, '0.9.151')).toMatchObject({ disable: true, retry: false })
    // index.ts records that as `gpu-retry-incomplete`, keeping the version.
    const incomplete: GpuFallbackState = {
      ...started!,
      disableHardwareAcceleration: true,
      reason: 'gpu-retry-incomplete'
    }
    expect(launch(incomplete, '0.9.151')).toMatchObject({ disable: true, retry: false })
    expect(launch(incomplete, '0.9.152')).toMatchObject({ disable: false, retry: true })
  })

  it('records the version with a first crash fallback, so only a new version retries it', () => {
    const fallback = gpuCrashFallbackState({
      previous: null,
      crashCount: 2,
      duringRetry: false,
      appVersion: '0.9.151',
      updatedAt: at
    })
    expect(fallback).toEqual({
      disableHardwareAcceleration: true,
      reason: 'gpu-process-crashes',
      crashCount: 2,
      updatedAt: at,
      appVersion: '0.9.151'
    })
    expect(launch(fallback, '0.9.151')).toMatchObject({ disable: true, retry: false })
    expect(launch(fallback, '0.9.152')).toMatchObject({ disable: false, retry: true })
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
    expect(readGpuFallbackState('/data/gpu-fallback.json', { readFile: () => written })).toEqual(
      persisted
    )
    const versioned = { ...persisted, appVersion: '0.9.151' }
    writeGpuFallbackState(gpuFallbackStatePath('/data'), versioned, {
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined
    })
    const roundTripped = readGpuFallbackState('/data/gpu-fallback.json', {
      readFile: () => written
    })
    expect(roundTripped).toEqual(versioned)
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
