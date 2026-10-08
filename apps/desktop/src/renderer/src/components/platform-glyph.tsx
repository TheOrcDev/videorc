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

const PLATFORM_ICON: Record<Exclude<StreamPlatform, 'youtube'>, AppIcon> = {
  twitch: TwitchIcon,
  kick: KickIcon,
  x: XPlatformIcon,
  tiktok: TiktokIcon,
  instagram: InstagramIcon,
  custom: LivestreamIcon
}

// The vivid rounded-square platform tile: per the design skill, source and
// platform icons are the ONLY large saturated colour in the chrome. YouTube
// has no tile: it shows YouTube's own icon (plan 165).
const PLATFORM_GLYPH_TINT: Record<Exclude<StreamPlatform, 'youtube'>, string> = {
  twitch: 'bg-platform-twitch/15 text-platform-twitch-ink',
  // A solid brand-green tile with the glyph in dark ink (the K shows through
  // in green): a 15% green wash would vanish in light mode.
  kick: 'bg-platform-kick text-platform-kick-ink',
  x: 'bg-foreground/10 text-foreground',
  tiktok: 'bg-foreground/10 text-foreground',
  instagram: 'bg-platform-instagram/15 text-platform-instagram',
  custom: 'bg-foreground/10 text-muted-foreground'
}

/**
 * A platform's glyph, the same in Setup and Upcoming. Every platform sits in
 * the same 30 x 24 slot so row titles line up: YouTube's official icon at its
 * 20 px minimum height (Google's ToS report, III.F.2a), untinted, on the row's
 * own surface; every other platform on its 24 px tinted tile, sized to match.
 */
export function PlatformGlyph({
  platform,
  className
}: {
  platform: StreamPlatform
  className?: string
}): ReactElement {
  if (platform === 'youtube') {
    return (
      <span
        className={cn('flex h-6 w-7.5 shrink-0 items-center justify-center', className)}
        data-platform-glyph="youtube"
      >
        <YoutubeIcon aria-label="YouTube" role="img" />
      </span>
    )
  }
  const AppIcon = PLATFORM_ICON[platform]
  return (
    <span
      className={cn('flex h-6 w-7.5 shrink-0 items-center justify-center', className)}
      data-platform-glyph={platform}
    >
      <span
        className={cn(
          'flex size-6 items-center justify-center rounded-[6px]',
          PLATFORM_GLYPH_TINT[platform]
        )}
      >
        <AppIcon className="size-4" weight="fill" />
      </span>
    </span>
  )
}
