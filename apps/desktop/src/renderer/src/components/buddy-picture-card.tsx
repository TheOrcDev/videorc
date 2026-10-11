import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { MediaCard } from '@/components/media-card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { BUDDY_LIBRARY_COPY } from '@/lib/buddy-onboarding-copy'
import { cn } from '@/lib/utils'

/**
 * One Buddy as a card (plan 174 S3.15b, G-17): its idle pose, its name and
 * what it is like, then the host's actions. One recipe on `MediaCard` for
 * My Buddies and the onboarding's gallery, with one selection signal: the
 * accent block, a neutral "Active" tag beside the name, and `aria-current`.
 * The personality is visible, never hover-only, and the picture is
 * decorative: the name beside it is what a reader hears. The "Alive" tag
 * sits in the text block, never over the art (V-1), and only when the host
 * says it tells cards apart.
 */
export function BuddyPictureCard({
  name,
  picture,
  subtitle,
  detail,
  active = false,
  alive = false,
  busy = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof MediaCard>, 'selected' | 'title' | 'children'> & {
  name: string
  /** The idle pose; null while it loads. */
  picture: string | null
  /** One short line: the tagline, or what was asked for. */
  subtitle?: string
  /** What it is like (the personality), when it adds to the subtitle. */
  detail?: string
  /** The Buddy in use. */
  active?: boolean
  /** It moves; shown only when the host says it tells this card apart. */
  alive?: boolean
  /** A library job acts on it now. */
  busy?: boolean
  /** The actions row: Use, or a menu. */
  children?: ReactNode
}): ReactElement {
  return (
    <MediaCard
      aria-current={active ? 'true' : undefined}
      className={cn('gap-1.5 p-1.5', busy && 'opacity-70', className)}
      data-active={active || undefined}
      data-busy={busy || undefined}
      selected={active}
      {...props}
    >
      <div className="relative aspect-square overflow-hidden rounded-chip bg-foreground/[0.04]">
        {picture ? (
          <img
            alt=""
            className="size-full object-contain p-1.5"
            decoding="async"
            draggable={false}
            src={picture}
          />
        ) : (
          <Skeleton className="size-full rounded-none" />
        )}
        {busy ? (
          <Spinner
            aria-hidden
            className="absolute top-1.5 right-1.5 size-3.5 text-muted-foreground"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {name}
          </span>
          {alive ? (
            <Badge data-testid="buddy-picture-card-alive" variant="outline">
              {BUDDY_LIBRARY_COPY.alive}
            </Badge>
          ) : null}
          {active ? (
            <Badge data-testid="buddy-picture-card-active" variant="outline">
              {BUDDY_LIBRARY_COPY.active}
            </Badge>
          ) : null}
        </div>
        {subtitle ? (
          <span className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
        {detail && detail !== subtitle ? (
          <span
            className="line-clamp-3 text-xs text-muted-foreground"
            data-testid="buddy-picture-card-detail"
          >
            {detail}
          </span>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-1">{children}</div> : null}
    </MediaCard>
  )
}
