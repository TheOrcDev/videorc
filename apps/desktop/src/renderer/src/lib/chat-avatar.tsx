import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'

import { chatImageRoute } from '../../../shared/chat-avatar-bytes'
import { cn } from '@/lib/utils'
import type { CachedImageKind } from './chat-image-cache'

export type { CachedImageKind } from './chat-image-cache'

// Chat avatar display (Comments window upgrade S1). Avatars, emotes and GIFs
// resolve through the backend's allowlisted cache (plan 220 S1.6a): main
// forwards `cacheChatAvatar` / `cacheChatGif` and the answer is the backend's
// loopback route for the file, never a hot-linked CDN URL. A monogram (or the
// text) shows while unresolved or refused.

/** Initials for the monogram fallback: first letters of up to two words. A
 * leading symbol is skipped (`@ramxcodes` is R, not @, YouTube handles start
 * with one); a word of symbols alone (an emoji) keeps its first glyph. */
export function monogramInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  const initials = words
    .slice(0, 2)
    .map((word) => {
      const glyphs = [...word]
      return (glyphs.find((glyph) => /[\p{L}\p{N}]/u.test(glyph)) ?? glyphs[0]!).toUpperCase()
    })
    .join('')
  return initials || '?'
}

// A route URL names the backend's port and this run's key, so it dies with
// the backend: after a restart (or once the cache prunes a file) the <img>
// fails. The first failure of a route image drops every resolved URL
// (`chat-image-cache.ts`) and the hooks resolve again against the running
// backend, at most once per interval so an engine that is away cannot loop.
const CHAT_IMAGE_RESET_MIN_INTERVAL_MS = 5_000
let chatImageEpoch = 0
let lastChatImageResetAt = Number.NEGATIVE_INFINITY
const chatImageEpochListeners = new Set<() => void>()

function subscribeChatImageEpoch(listener: () => void): () => void {
  chatImageEpochListeners.add(listener)
  return () => chatImageEpochListeners.delete(listener)
}

function currentChatImageEpoch(): number {
  return chatImageEpoch
}

/** An image from the backend's chat image route failed to load: resolve
 * every chat image again (throttled). Anything else is ignored. */
export function reportChatImageFailure(
  localUrl: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!chatImageRoute(localUrl)) return false
  if (now - lastChatImageResetAt < CHAT_IMAGE_RESET_MIN_INTERVAL_MS) return false
  lastChatImageResetAt = now
  void import('./chat-image-cache')
    .then(({ clearResolvedChatImages }) => clearResolvedChatImages())
    .catch(() => undefined)
    .then(() => {
      chatImageEpoch += 1
      for (const listener of chatImageEpochListeners) listener()
    })
  return true
}

// Load errors never bubble, but they pass every window's capture phase: one
// listener covers every chat image <img> in the document.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target
      if (typeof HTMLImageElement !== 'undefined' && target instanceof HTMLImageElement) {
        reportChatImageFailure(target.currentSrc || target.src)
      }
    },
    true
  )
}

/** When a null answer (a refusal, or a backend that was away) is asked again. */
export const CHAT_IMAGE_NULL_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

export function useCachedAvatar(
  remoteUrl: string | undefined | null,
  kind: CachedImageKind = 'avatar'
): string | null {
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  const epoch = useSyncExternalStore(
    subscribeChatImageEpoch,
    currentChatImageEpoch,
    currentChatImageEpoch
  )
  // A null answer leaves no <img> whose error could move the epoch, and a
  // socket-less window never hears the backend come back: ask again a few
  // times, further apart each time. A new URL or epoch starts over.
  const retryKey = `${kind}:${remoteUrl ?? ''}:${epoch}`
  const [retry, setRetry] = useState({ key: retryKey, attempt: 0 })
  const attempt = retry.key === retryKey ? retry.attempt : 0
  useEffect(() => {
    if (!remoteUrl) {
      setLocalUrl(null)
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    void import('./chat-image-cache')
      .then(({ forgetFailedChatImage, resolveAvatar }) => {
        if (attempt > 0) forgetFailedChatImage(remoteUrl, kind)
        return resolveAvatar(remoteUrl, kind)
      })
      .catch(() => null)
      .then((resolved) => {
        if (cancelled) return
        setLocalUrl(resolved)
        const delay = CHAT_IMAGE_NULL_RETRY_DELAYS_MS[attempt]
        if (resolved === null && delay !== undefined) {
          retryTimer = setTimeout(() => setRetry({ key: retryKey, attempt: attempt + 1 }), delay)
        }
      })
    return () => {
      cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [remoteUrl, kind, epoch, attempt, retryKey])
  return localUrl
}

export function AvatarCircle({
  name,
  avatarUrl,
  className
}: {
  name: string
  avatarUrl?: string | null
  className?: string
}): ReactElement {
  const localUrl = useCachedAvatar(avatarUrl)
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 select-none place-items-center overflow-hidden rounded-full border border-border bg-muted/40 text-[11px] font-semibold text-muted-foreground',
        className
      )}
    >
      {localUrl ? (
        <img alt="" className="size-full object-cover" src={localUrl} />
      ) : (
        monogramInitials(name)
      )}
    </span>
  )
}
