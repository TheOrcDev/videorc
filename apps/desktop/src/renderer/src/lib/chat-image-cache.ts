/** Which of main's two cache kinds resolves a URL: avatars and emotes share
 * one allowlist and cap; Twitch GIFs (plan 155) have their own. */
export type CachedImageKind = 'avatar' | 'gif'

// Keep hot avatar/emote/GIF URLs shared across the renderer, but bound both
// pending and settled promises (including nulls) during long, busy streams.
const AVATAR_URL_CACHE_MAX = 256
const avatarUrlCache = new Map<string, Promise<string | null>>()

export function resolveAvatar(remoteUrl: string, kind: CachedImageKind): Promise<string | null> {
  const key = `${kind}:${remoteUrl}`
  const cached = avatarUrlCache.get(key)
  if (cached) {
    avatarUrlCache.delete(key)
    avatarUrlCache.set(key, cached)
    return cached
  }
  const resolved = (async () => {
    try {
      const api = window.videorc
      const local =
        kind === 'gif'
          ? await api?.cacheChatGif?.(remoteUrl)
          : await api?.cacheChatAvatar?.(remoteUrl)
      return local ?? null
    } catch {
      return null
    }
  })()
  avatarUrlCache.set(key, resolved)
  if (avatarUrlCache.size > AVATAR_URL_CACHE_MAX) {
    const oldest = avatarUrlCache.keys().next().value
    if (oldest !== undefined) avatarUrlCache.delete(oldest)
  }
  // Eviction drops only our reference. Existing callers still receive the
  // result; settling never reinserts an evicted promise or revokes main's URL.
  return resolved
}
