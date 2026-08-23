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
  // Videorc account avatars uploaded on videorc.com (Vercel Blob storage).
  // Any store subdomain, matching the web's own isAccountAvatarBlobUrl check;
  // Google account photos are covered by googleusercontent.com above.
  'blob.vercel-storage.com'
]

/** Keep the cache bounded; oldest files (by mtime) are pruned past this. */
export const AVATAR_CACHE_MAX_FILES = 200

/** Refuse to store avatars past this size. Matches the web's account-avatar
 * upload cap (2 MB) — the old 512 KB desktop cap silently monogrammed any
 * avatar the web happily accepted. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/**
 * Why an avatar was not cached. Carries only what support needs to see (host,
 * scheme, size / status class) — never the path or query, which on platform
 * CDNs can embed per-user tokens.
 */
export type AvatarCacheRejection =
  | { kind: 'not-a-url' }
  | { kind: 'scheme'; scheme: string; host: string }
  | { kind: 'host'; scheme: string; host: string }
  | { kind: 'http-status'; host: string; statusClass: string }
  | { kind: 'empty-body'; host: string }
  | { kind: 'too-large'; host: string; bytes: number }
  | { kind: 'fetch-error'; host: string; message: string }

export type AvatarUrlDecision =
  | { allowed: true; host: string }
  | { allowed: false; rejection: AvatarCacheRejection }

export function avatarUrlDecision(rawUrl: unknown): AvatarUrlDecision {
  if (typeof rawUrl !== 'string') {
    return { allowed: false, rejection: { kind: 'not-a-url' } }
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, rejection: { kind: 'not-a-url' } }
  }
  const host = url.hostname.toLowerCase()
  const scheme = url.protocol.replace(/:$/, '')
  if (url.protocol !== 'https:') {
    return { allowed: false, rejection: { kind: 'scheme', scheme, host } }
  }
  const allowed = AVATAR_ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  )
  return allowed
    ? { allowed: true, host }
    : { allowed: false, rejection: { kind: 'host', scheme, host } }
}

export function avatarHostAllowed(rawUrl: string): boolean {
  return avatarUrlDecision(rawUrl).allowed
}

/** `2xx` / `4xx` / `5xx` style class; enough to tell auth from outage. */
export function httpStatusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 999) {
    return 'unknown'
  }
  return `${Math.floor(status / 100)}xx`
}

// Platform fetch errors occasionally quote the request URL; strip anything
// URL-shaped so the log line never carries a token-bearing path.
export function redactAvatarFetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 160)
}

/**
 * One line per distinct (host, reason) so a busy chat from one blocked CDN
 * does not flood the 200-line backend log ring.
 */
export function avatarCacheRejectionKey(rejection: AvatarCacheRejection): string {
  switch (rejection.kind) {
    case 'not-a-url':
      return 'not-a-url'
    case 'scheme':
      return `scheme:${rejection.scheme}:${rejection.host}`
    case 'host':
      return `host:${rejection.host}`
    case 'http-status':
      return `http-status:${rejection.host}:${rejection.statusClass}`
    case 'empty-body':
      return `empty-body:${rejection.host}`
    case 'too-large':
      return `too-large:${rejection.host}`
    case 'fetch-error':
      return `fetch-error:${rejection.host}`
  }
}

export function avatarCacheRejectionMessage(rejection: AvatarCacheRejection): string {
  const prefix = 'Chat avatar not cached:'
  switch (rejection.kind) {
    case 'not-a-url':
      return `${prefix} value is not a URL.`
    case 'scheme':
      return `${prefix} scheme ${rejection.scheme} is not https (host ${rejection.host}).`
    case 'host':
      return `${prefix} host ${rejection.host} is not an allowlisted avatar CDN.`
    case 'http-status':
      return `${prefix} ${rejection.host} answered ${rejection.statusClass}.`
    case 'empty-body':
      return `${prefix} ${rejection.host} returned an empty body.`
    case 'too-large':
      return `${prefix} ${rejection.host} returned ${rejection.bytes} bytes (cap ${AVATAR_MAX_BYTES}).`
    case 'fetch-error':
      return `${prefix} fetching from ${rejection.host} failed (${rejection.message}).`
  }
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
