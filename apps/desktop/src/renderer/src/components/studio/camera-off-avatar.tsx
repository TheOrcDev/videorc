import type { CSSProperties, ReactElement } from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { nameInitial } from '@/lib/talk-show-tile'
import { cn } from '@/lib/utils'

/**
 * The camera-off look (wire contract 5.5): a circle with the name's first
 * letter, centred in its tile, as the program page draws it for viewers.
 * The words stay for screen readers only: the look says it.
 */
export function CameraOffAvatar({
  name,
  className,
  circle,
  letter,
  label = 'Camera off'
}: {
  name: string
  className?: string
  /** The circle's size, as a CSS length; the component's default otherwise. */
  circle?: string
  /** The letter's font size, as a CSS length. */
  letter?: string
  /** What screen readers hear. */
  label?: string
}): ReactElement {
  const size: CSSProperties | undefined = circle ? { width: circle, height: circle } : undefined
  return (
    <span
      className={cn('absolute inset-0 flex items-center justify-center', className)}
      data-camera-off=""
      data-slot="camera-off-avatar"
    >
      <Avatar className={cn('after:hidden', circle ? 'size-auto' : undefined)} style={size}>
        <AvatarFallback
          aria-hidden
          // The video ground's own tones: a tile is dark in both themes.
          className="bg-video-ground-muted/35 text-video-ground-foreground font-medium leading-none"
          style={letter ? { fontSize: letter } : undefined}
        >
          {nameInitial(name)}
        </AvatarFallback>
      </Avatar>
      <span className="sr-only">{label}</span>
    </span>
  )
}
