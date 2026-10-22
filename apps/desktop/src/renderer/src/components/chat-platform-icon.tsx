import {
  type AppIcon,
  InstagramIcon,
  KickIcon,
  LivestreamIcon,
  TiktokIcon,
  TwitchIcon,
  XPlatformIcon,
  YoutubeIcon
} from '@/components/icons'
import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
export { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'

import type { StreamPlatform } from '@/lib/backend'
import { cn } from '@/lib/utils'

// Per-comment platform identity for chat feeds (Comments window upgrade S1):
// the platform's own glyph in its brand tint — source icons are the one place
// saturated color is allowed (videorc-design). Tints match the streaming tab's
// destination tiles so the platforms read consistently across the app.
//
// YouTube is the exception (plan 165, Google's ToS report III.F.2a): it is
// YouTube's own icon file at its 20 px minimum height, never tinted and never
// shrunk by a caller's class. A surface with no room for 20 px (a Badge chip)
// omits the mark and keeps the word "YouTube" instead.

const CHAT_PLATFORM_ICON: Record<StreamPlatform, AppIcon> = {
  youtube: YoutubeIcon,
  twitch: TwitchIcon,
  kick: KickIcon,
  x: XPlatformIcon,
  tiktok: TiktokIcon,
  instagram: InstagramIcon,
  custom: LivestreamIcon
}

const CHAT_PLATFORM_TINT: Record<Exclude<StreamPlatform, 'youtube'>, string> = {
  twitch: 'text-platform-twitch-ink',
  kick: 'text-platform-kick',
  // X's mark sets its own fill: pure black or white by theme (plan 167).
  x: '',
  tiktok: 'text-foreground',
  instagram: 'text-platform-instagram',
  custom: 'text-muted-foreground'
}

export function ChatPlatformIcon({
  platform,
  className,
  decorative = false
}: {
  platform: StreamPlatform
  className?: string
  decorative?: boolean
}): ReactElement {
  const Glyph = CHAT_PLATFORM_ICON[platform]
  return (
    <Glyph
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : CHAT_PLATFORM_LABELS[platform]}
      className={cn(
        // One height for every platform (plan 165): YouTube's official icon
        // may not go below 20 px, so the others match it.
        'size-5 shrink-0',
        // YouTube: keep clear space of at least the triangle's width
        // (brand.youtube, about 7.4 px at 20 px) before the text that follows
        // it, on top of the 4–8 px gap its rows use.
        platform === 'youtube' ? 'mr-1' : CHAT_PLATFORM_TINT[platform],
        className
      )}
      role={decorative ? undefined : 'img'}
      weight="fill"
    >
      {decorative ? null : <title>{CHAT_PLATFORM_LABELS[platform]}</title>}
    </Glyph>
  )
}
