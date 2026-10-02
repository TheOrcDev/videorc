// The highlight card reads cached chat images as BYTES over IPC (plan 095,
// S3). The card is painted on an OffscreenCanvas in the main renderer, and a
// `videorc-asset://avatar/...` URL cannot get there: the scheme has no CORS
// (`fetch` from the renderer origin fails), and drawing a `videorc-asset:`
// <img> would taint the canvas so `convertToBlob` throws. Main hands over the
// managed file's bytes instead, and the renderer decodes them with
// `createImageBitmap`. Pure parsing lives here so the preload contract and the
// main handler agree, unit-tested.

/** Refuse to serve a cached image past this size. Matches the fetch cap in
 * `main/avatar-cache.ts` (the web's 2 MB account-avatar upload cap). */
export const CHAT_AVATAR_MAX_BYTES = 2 * 1024 * 1024

export const CHAT_AVATAR_LOCAL_URL_PREFIX = 'videorc-asset://avatar/'

/** A cache file name is `<32 hex of sha256(url)>.<extension>` (see
 * `avatarCacheFileName`). Nothing else is ever handed to the filesystem. */
const MANAGED_AVATAR_FILE_NAME = /^[a-f0-9]{32}\.[a-z0-9]{1,5}$/

/**
 * The bare cache file name a `videorc-asset://avatar/<file>` URL names, or
 * null for anything else: another host of the scheme, another scheme, a path
 * with separators or `..`, or a name that is not a cache file name. The main
 * handler still resolves the name inside the cache directory with the same
 * symlink and realpath checks as the asset protocol.
 */
export function managedAvatarFileName(localUrl: unknown): string | null {
  if (typeof localUrl !== 'string' || localUrl.length > 512) return null
  if (!localUrl.startsWith(CHAT_AVATAR_LOCAL_URL_PREFIX)) return null
  const fileName = localUrl.slice(CHAT_AVATAR_LOCAL_URL_PREFIX.length)
  return MANAGED_AVATAR_FILE_NAME.test(fileName) ? fileName : null
}

/** Bytes a renderer may receive for one cached image: present and within the cap. */
export function chatAvatarBytesWithinCap(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength <= CHAT_AVATAR_MAX_BYTES
}
