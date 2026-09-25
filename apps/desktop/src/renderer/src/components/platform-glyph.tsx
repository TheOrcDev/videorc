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

import type { StreamPlatform } from '@/lib/backend'
import { cn } from '@/lib/utils'

const PLATFORM_ICON: Record<StreamPlatform, AppIcon> = {
  youtube: YoutubeIcon,
  twitch: TwitchIcon,
  kick: KickIcon,
  x: XPlatformIcon,
  tiktok: TiktokIcon,
  instagram: InstagramIcon,
  custom: LivestreamIcon
}

// The vivid rounded-square platform tile: per the design skill, source and
// platform icons are the ONLY large saturated colour in the chrome.
const PLATFORM_GLYPH_TINT: Record<StreamPlatform, string> = {
  youtube: 'bg-platform-youtube/15 text-platform-youtube',
  twitch: 'bg-platform-twitch/15 text-platform-twitch-ink',
  // A solid brand-green tile with the glyph in dark ink (the K shows through
  // in green): a 15% green wash would vanish in light mode.
  kick: 'bg-platform-kick text-platform-kick-ink',
  x: 'bg-foreground/10 text-foreground',
  tiktok: 'bg-foreground/10 text-foreground',
  instagram: 'bg-platform-instagram/15 text-platform-instagram',
  custom: 'bg-foreground/10 text-muted-foreground'
}

/** A platform's glyph on its tinted tile, the same in Setup and Upcoming. */
export function PlatformGlyph({
  platform,
  className
}: {
  platform: StreamPlatform
  className?: string
}): ReactElement {
  const AppIcon = PLATFORM_ICON[platform]
  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-[5px]',
        PLATFORM_GLYPH_TINT[platform],
        className
      )}
    >
      <AppIcon className="size-3.5" weight="fill" />
    </span>
  )
}
