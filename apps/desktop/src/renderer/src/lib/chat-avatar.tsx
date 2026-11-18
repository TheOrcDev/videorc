import { useEffect, useState, type ReactElement } from 'react'

import { cn } from '@/lib/utils'
import type { CachedImageKind } from './chat-image-cache'

export type { CachedImageKind } from './chat-image-cache'

// Chat avatar display (Comments window upgrade S1). Avatars resolve through
// main's allowlisted cache (videorc-asset://avatar/...) — never a hot-linked
// CDN URL — and fall back to a monogram circle while unresolved or absent.

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

export function useCachedAvatar(
  remoteUrl: string | undefined | null,
  kind: CachedImageKind = 'avatar'
): string | null {
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!remoteUrl) {
      setLocalUrl(null)
      return
    }
    let cancelled = false
    void import('./chat-image-cache')
      .then(({ resolveAvatar }) => resolveAvatar(remoteUrl, kind))
      .catch(() => null)
      .then((resolved) => {
        if (!cancelled) {
          setLocalUrl(resolved)
        }
      })
    return () => {
      cancelled = true
    }
  }, [remoteUrl, kind])
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
