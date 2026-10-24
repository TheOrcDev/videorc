import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearStaleHttpCacheOnce,
  HTTP_CACHE_CLEANUP_MARKER,
  HTTP_CACHE_CLEANUP_VERSION
} from './http-cache-cleanup'

const roots: string[] = []
function userDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'http-cache-cleanup-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-24T09:30:00.000Z')

/** `session.defaultSession.clearCache()` as main hands it in, counted. */
function countedClear(result: () => Promise<void> = async () => {}): {
  calls: () => number
  clearCache: () => Promise<void>
} {
  let calls = 0
  return {
    calls: () => calls,
    clearCache: () => {
      calls += 1
      return result()
    }
  }
}

function readMarker(userData: string): unknown {
  return JSON.parse(readFileSync(join(userData, HTTP_CACHE_CLEANUP_MARKER), 'utf8'))
}

describe('the stale HTTP cache is cleared once per profile (plan 191)', () => {
  it('clears on the first start and writes the marker', async () => {
    const userData = userDataDir()
    const clear = countedClear()

    expect(
      await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache, now: () => NOW })
    ).toEqual({ kind: 'cleared' })
    expect(clear.calls()).toBe(1)
    expect(readMarker(userData)).toEqual({
      version: HTTP_CACHE_CLEANUP_VERSION,
      clearedAt: '2026-10-24T09:30:00.000Z'
    })
  })

  it('is already done on the next start and never clears again', async () => {
    const userData = userDataDir()
    const clear = countedClear()
    await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache, now: () => NOW })

    expect(await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache })).toEqual({
      kind: 'already-done'
    })
    expect(await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache })).toEqual({
      kind: 'already-done'
    })
    expect(clear.calls()).toBe(1)
    // The first clear's record stays as it was.
    expect(readMarker(userData)).toEqual({
      version: HTTP_CACHE_CLEANUP_VERSION,
      clearedAt: '2026-10-24T09:30:00.000Z'
    })
  })

  it('writes no marker when the clear fails, so the next start tries again', async () => {
    const userData = userDataDir()
    const failing = countedClear(async () => {
      throw new Error('The cache backend is busy.')
    })

    expect(await clearStaleHttpCacheOnce({ userData, clearCache: failing.clearCache })).toEqual({
      kind: 'failed',
      message: 'The cache backend is busy.'
    })
    expect(failing.calls()).toBe(1)
    expect(existsSync(join(userData, HTTP_CACHE_CLEANUP_MARKER))).toBe(false)

    const clear = countedClear()
    expect(
      await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache, now: () => NOW })
    ).toEqual({ kind: 'cleared' })
    expect(clear.calls()).toBe(1)
    expect(readMarker(userData)).toEqual({
      version: HTTP_CACHE_CLEANUP_VERSION,
      clearedAt: '2026-10-24T09:30:00.000Z'
    })
  })

  it('clears over a malformed marker, or one from before version 1', async () => {
    for (const contents of [
      '',
      '{"version":',
      'null',
      '[]',
      '"done"',
      '{}',
      '{"version":"1"}',
      '{"version":0}'
    ]) {
      const userData = userDataDir()
      writeFileSync(join(userData, HTTP_CACHE_CLEANUP_MARKER), contents)
      const clear = countedClear()

      expect(
        await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache, now: () => NOW }),
        contents
      ).toEqual({ kind: 'cleared' })
      expect(clear.calls(), contents).toBe(1)
      expect(readMarker(userData), contents).toEqual({
        version: HTTP_CACHE_CLEANUP_VERSION,
        clearedAt: '2026-10-24T09:30:00.000Z'
      })
    }
  })

  it('reports a marker it cannot write as failed, never a throw', async () => {
    const userData = userDataDir()
    // A folder where the marker goes: it reads as no marker and cannot be written.
    mkdirSync(join(userData, HTTP_CACHE_CLEANUP_MARKER))
    const clear = countedClear()

    const outcome = await clearStaleHttpCacheOnce({ userData, clearCache: clear.clearCache })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.message.length > 0).toBe(true)
    expect(clear.calls()).toBe(1)
  })
})
