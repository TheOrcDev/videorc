import { CheckIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { MediaCard } from '@/components/media-card'
import { Badge } from '@/components/ui/badge'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { cn } from '@/lib/utils'

/**
 * One scene card (plan 174 S3.3, B-20) for every scene the streamer switches
 * to: a built-in scene, a saved scene and a vertical-stream scene. It is
 * `MediaCard`'s look: the layout thumbnail, then the name on up to two lines
 * (V-4: never "Screen …" at 1,280 px) after the app's icon for a scene made
 * for an app (plan 210 D6), then one quiet meta line (a shortcut, "Resolve
 * sources", why it can't go on). The scene in use has one marker on every
 * gallery: the card's selected look, a check, and `aria-pressed`. The check
 * sits on the picture's corner, never beside the name: there it took 20 px
 * of the name's line, and "Screen + camera" broke into three lines in an
 * 84 px vertical tile, cut to "Screen +" (#1083).
 *
 * Why a card can't be chosen: a reason the cards share is the gallery's one
 * line under the grid (`sceneGalleryReason`); a card's own reason
 * (`disabledReason`) shows on hover and focus. A `menu` (the saved scene's ⋯)
 * sits over the thumbnail's corner, beside the card's button, never in it.
 */
export function SceneCard({
  thumb,
  icon,
  label,
  selected = false,
  pressed = selected,
  disabled = false,
  disabledReason,
  meta,
  menu,
  size = 'md',
  onSelect,
  ...data
}: {
  /** The layout diagram (`LayoutThumb`). */
  thumb: ReactNode
  /** The app's icon before the name (a scene made for an app). */
  icon?: ReactNode
  /** The scene's name, kept while it applies (the pending mark goes in `meta`, issue #1275). */
  label: string
  /** The scene in use: the card's selected look and the check. */
  selected?: boolean
  /** `aria-pressed`, when the choice differs from what is shown in use (the vertical stream follows). */
  pressed?: boolean
  disabled?: boolean
  /** This card's own reason while disabled; a reason every card shares goes under the gallery. */
  disabledReason?: ReactNode
  /** One quiet line under the name. */
  meta?: ReactNode
  /** The card's ⋯ menu (a KebabMenu with `reveal="hover"`). */
  menu?: ReactNode
  /** `sm` for the denser vertical-stream gallery. */
  size?: 'md' | 'sm'
  onSelect: () => void
} & { [key: `data-${string}`]: string | undefined }): ReactElement {
  return (
    <MediaCard
      className={cn('group/kebab-host relative', disabled && 'opacity-50')}
      interactive={!selected && !disabled}
      selected={selected}
      {...data}
    >
      <DisabledReason className="flex min-w-0 flex-1" reason={disabled ? disabledReason : null}>
        <button
          aria-pressed={pressed}
          className={cn(
            'flex min-w-0 flex-1 flex-col rounded-row p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            size === 'sm' ? 'gap-1.5' : 'gap-2'
          )}
          data-slot="scene-card-button"
          disabled={disabled}
          type="button"
          onClick={onSelect}
        >
          {thumb}
          <span className="flex min-w-0 items-start gap-1.5">
            {icon ? <span className="mt-px flex shrink-0">{icon}</span> : null}
            <span
              className={cn(
                'line-clamp-2 min-w-0 flex-1 font-medium break-words',
                size === 'sm' ? 'text-xs' : 'text-sm'
              )}
              data-slot="scene-card-label"
            >
              {label}
            </span>
          </span>
          {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
        </button>
      </DisabledReason>
      {/* The check mirrors the menu on the other corner. It takes no click,
          so a click on it selects the card under it. */}
      {selected ? (
        <Badge
          aria-hidden
          className="pointer-events-none absolute top-1 left-1 px-1"
          data-testid="scene-card-check"
        >
          <CheckIcon weight="bold" />
        </Badge>
      ) : null}
      {menu ? <div className="absolute top-1 right-1">{menu}</div> : null}
    </MediaCard>
  )
}

/** The one reason line under a scene gallery (`sceneGalleryReason`); nothing when every scene works. */
export function SceneGalleryReason({
  reason,
  action
}: {
  reason: string | null
  /** The way to fix it ("Open Sources"). */
  action?: ReactNode
}): ReactElement | null {
  if (!reason) return null
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-slot="scene-gallery-reason"
    >
      <span className="min-w-0">{reason}</span>
      {action}
    </p>
  )
}
