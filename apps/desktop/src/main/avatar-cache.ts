import { createHash } from 'node:crypto'

// Chat avatar caching policy (Comments window upgrade S1). Renderers never
// hot-link platform CDNs: main fetches each avatar once from an ALLOWLISTED
// host, stores it under {userData}/avatar-cache, and serves it through the
// scoped videorc-asset:// protocol. Pure decisions live here, unit-tested;
// the fetch/prune wiring stays in main/index.ts.

/** Hosts chat avatars may be fetched from — the platforms' own CDNs only. */
const AVATAR_ALLOWED_HOST_SUFFIXES = [
  // YouTube channel avatars
  'yt3.ggpht.com',
  'yt4.ggpht.com',
  'googleusercontent.com',
  // Twitch profile images
  'static-cdn.jtvnw.net',
  // Videorc account avatars uploaded on videorc.com (Vercel Blob storage);
  // Google account photos are covered by googleusercontent.com above.
  'public.blob.vercel-storage.com'
]

/** Keep the cache bounded; oldest files (by mtime) are pruned past this. */
export const AVATAR_CACHE_MAX_FILES = 200

/** Refuse to store avatars past this size. Matches the web's account-avatar
 * upload cap (2 MB) — the old 512 KB desktop cap silently monogrammed any
 * avatar the web happily accepted. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export function avatarHostAllowed(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return AVATAR_ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  )
}

/**
 * Deterministic cache file name for an avatar URL: content-address by the URL
 * so the same avatar is fetched once, with a safe extension derived from the
 * URL path (never from remote headers).
 */
export function avatarCacheFileName(rawUrl: string): string {
  const hash = createHash('sha256').update(rawUrl).digest('hex').slice(0, 32)
  const path = (() => {
    try {
      return new URL(rawUrl).pathname.toLowerCase()
    } catch {
      return ''
    }
  })()
  const extension = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].find((candidate) =>
    path.endsWith(candidate)
  )
  return `${hash}${extension ?? '.img'}`
}
