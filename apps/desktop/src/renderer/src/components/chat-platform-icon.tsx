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

const CHAT_PLATFORM_ICON: Record<StreamPlatform, AppIcon> = {
  youtube: YoutubeIcon,
  twitch: TwitchIcon,
  kick: KickIcon,
  x: XPlatformIcon,
  tiktok: TiktokIcon,
  instagram: InstagramIcon,
  custom: LivestreamIcon
}

const CHAT_PLATFORM_TINT: Record<StreamPlatform, string> = {
  youtube: 'text-platform-youtube',
  twitch: 'text-platform-twitch-ink',
  kick: 'text-platform-kick',
  x: 'text-foreground',
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
      className={cn('size-3.5 shrink-0', CHAT_PLATFORM_TINT[platform], className)}
      role={decorative ? undefined : 'img'}
      weight="fill"
    >
      {decorative ? null : <title>{CHAT_PLATFORM_LABELS[platform]}</title>}
    </Glyph>
  )
}
