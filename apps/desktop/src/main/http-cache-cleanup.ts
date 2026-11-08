import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plan 191: builds from June–July 2026 polled the backend's
 * `/preview/{camera,screen}/live.png` with a fresh `t=` on every request, and
 * the backend answered its errors with no Cache-Control header, so Chromium's
 * HTTP cache kept every empty 404. On the owner's profile that is ~472K
 * entries, ~2 GB on disk (each one still takes a 4 KB block), and Chromium
 * never evicts them because their logical size stays under its cap. The
 * backend now sends `no-store` on every response, so nothing new piles up;
 * main clears the default session's HTTP cache once per profile to reclaim
 * what is already there, and a marker in userData says it is done.
 */

/** The userData file that records the one-time clear. */
export const HTTP_CACHE_CLEANUP_MARKER = 'http-cache-cleanup.json'
/** The marker's version. Raising it clears every profile's cache once more. */
export const HTTP_CACHE_CLEANUP_VERSION = 1

export type StaleHttpCacheCleanup =
  | { kind: 'cleared' }
  | { kind: 'already-done' }
  | { kind: 'failed'; message: string }

/**
 * Clear the HTTP cache once per profile. A marker at the current version means
 * it is done, and `clearCache` is not called; a missing or malformed marker
 * means it is not. The marker is written only after a clear succeeds, so a
 * clear that fails is tried again on the next start. Never throws: a failure,
 * writing the marker included, comes back as `failed` and the caller logs why.
 */
export async function clearStaleHttpCacheOnce(params: {
  userData: string
  clearCache: () => Promise<void>
  now?: () => number
}): Promise<StaleHttpCacheCleanup> {
  const marker = join(params.userData, HTTP_CACHE_CLEANUP_MARKER)
  if (isMarkerCurrent(marker)) return { kind: 'already-done' }
  try {
    await params.clearCache()
    const clearedAt = new Date(params.now ? params.now() : Date.now()).toISOString()
    writeFileSync(
      marker,
      `${JSON.stringify({ version: HTTP_CACHE_CLEANUP_VERSION, clearedAt }, null, 2)}\n`
    )
    return { kind: 'cleared' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

function isMarkerCurrent(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return false
    const { version } = parsed as { version?: unknown }
    return typeof version === 'number' && version >= HTTP_CACHE_CLEANUP_VERSION
  } catch {
    // Missing, unreadable or not JSON: the clear has not happened.
    return false
  }
}
