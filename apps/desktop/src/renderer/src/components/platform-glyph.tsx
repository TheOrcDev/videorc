import {
  type AppIcon,
  InstagramIcon,
  KickIcon,
  LivestreamIcon,
  TiktokIcon,
  TwitchIcon,
  YoutubeIcon
} from '@/components/icons'
import type { ReactElement } from 'react'

import type { StreamPlatform } from '@/lib/backend'
import { cn } from '@/lib/utils'
import { X_LOCKUP_URL } from '@/lib/x-mark'

type TiledPlatform = Exclude<StreamPlatform, 'youtube' | 'x'>

const PLATFORM_ICON: Record<TiledPlatform, AppIcon> = {
  twitch: TwitchIcon,
  kick: KickIcon,
  tiktok: TiktokIcon,
  instagram: InstagramIcon,
  custom: LivestreamIcon
}

// The vivid rounded-square platform tile: per the design skill, source and
// platform icons are the ONLY large saturated colour in the chrome. YouTube
// has no tile: it shows YouTube's own icon (plan 165). X's tile is X's own
// app-icon lockup (plan 167).
const PLATFORM_GLYPH_TINT: Record<TiledPlatform, string> = {
  twitch: 'bg-platform-twitch/15 text-platform-twitch-ink',
  // A solid brand-green tile with the glyph in dark ink (the K shows through
  // in green): a 15% green wash would vanish in light mode.
  kick: 'bg-platform-kick text-platform-kick-ink',
  tiktok: 'bg-foreground/10 text-foreground',
  instagram: 'bg-platform-instagram/15 text-platform-instagram',
  custom: 'bg-foreground/10 text-muted-foreground'
}

/**
 * A platform's glyph, the same in Setup and Upcoming. Every platform sits in
 * the same 30 x 24 slot so row titles line up: YouTube's official icon at its
 * 20 px minimum height (Google's ToS report, III.F.2a), untinted, on the row's
 * own surface; X as X's rounded-square lockup from its partner kit (plan
 * 167), white on black in dark mode and black on white in light; every other
 * platform on its 24 px tinted tile, sized to match.
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
  if (platform === 'x') {
    return (
      <span
        className={cn('flex h-6 w-7.5 shrink-0 items-center justify-center', className)}
        data-platform-glyph="x"
        role="img"
        aria-label="X"
      >
        <img alt="" className="size-6 dark:hidden" draggable={false} src={X_LOCKUP_URL.light} />
        <img
          alt=""
          className="hidden size-6 dark:block"
          draggable={false}
          src={X_LOCKUP_URL.dark}
        />
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
