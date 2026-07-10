import { Broadcast, TwitchLogo, XLogo, YoutubeLogo, type Icon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import type { StreamPlatform } from '@/lib/backend'
import { cn } from '@/lib/utils'

// Per-comment platform identity for chat feeds (Comments window upgrade S1):
// the platform's own glyph in its brand tint — source icons are the one place
// saturated color is allowed (videorc-design). Tints match the streaming tab's
// destination tiles so the platforms read consistently across the app.

export const CHAT_PLATFORM_LABELS: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  x: 'X',
  custom: 'Custom'
}

const CHAT_PLATFORM_ICON: Record<StreamPlatform, Icon> = {
  youtube: YoutubeLogo,
  twitch: TwitchLogo,
  x: XLogo,
  custom: Broadcast
}

const CHAT_PLATFORM_TINT: Record<StreamPlatform, string> = {
  youtube: 'text-[#ff0033]',
  twitch: 'text-[#a970ff]',
  x: 'text-foreground',
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
