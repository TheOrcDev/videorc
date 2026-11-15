import { CheckIcon } from '@/components/icons'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { MediaCard } from '@/components/media-card'
import { Badge } from '@/components/ui/badge'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * One scene card (plan 174 S3.3, B-20) for every scene the streamer switches
 * to. It is `MediaCard`'s look, and every card has the same three parts at
 * the same heights, so cards and their chips line up across the grid (plan
 * 231 S6):
 *
 * 1. the thumbnail at the card's width (`LayoutThumb`, in a 16:9 well; a 4:3
 *    one in the 9:16 studio, where the layout stands upright);
 * 2. the name row: the icon of what it shows, the name on one line (cut with
 *    "…" when it is too long, never inside a word, and the whole name on
 *    hover), then the check of the scene on stream or, on hover and focus,
 *    its ⋯ in the same place;
 * 3. the meta row: one quiet line (what it shows, why it can't go on,
 *    "Applying…") and the key chips at its end.
 *
 * The scene in use reads at a glance in both themes: the card's selected
 * plate, a ring around its picture, the check and `aria-pressed`.
 *
 * `size="sm"` is first-run setup's denser look (#1083): the name wraps to two
 * lines under the picture, and the check sits on the picture's corner, so a
 * tile 84 px wide keeps "Screen + camera" whole.
 *
 * Why a card can't be chosen: a reason the cards share is the gallery's one
 * line under the grid (`SceneGalleryReason`); a card's own reason
 * (`disabledReason`) shows on hover and focus, and in its meta row. A `menu`
 * (the ⋯) sits over the card beside its button, never in it.
 */
export function SceneCard({
  thumb,
  icon,
  label,
  selected = false,
  disabled = false,
  disabledReason,
  meta,
  keys,
  menu,
  size = 'md',
  keyShortcuts,
  onSelect,
  onKeyDown,
  ...data
}: {
  /** The layout diagram (`LayoutThumb`), with the scene's picture in its screen. */
  thumb: ReactNode
  /** The icon before the name: the app's own, or a glyph for what it shows. */
  icon?: ReactNode
  /** The scene's name, kept while it applies (the pending mark goes in `meta`, issue #1275). */
  label: string
  /** The scene in use: the selected plate, the ring, the check and `aria-pressed`. */
  selected?: boolean
  disabled?: boolean
  /** This card's own reason while disabled; a reason every card shares goes under the gallery. */
  disabledReason?: ReactNode
  /** The meta row's words: what it shows, why it can't go on, or the pending mark. */
  meta?: ReactNode
  /** The meta row's key chips, at its end (`SceneShortcutKeys`). */
  keys?: ReactNode
  /** The card's ⋯ menu (a KebabMenu with `reveal="hover"`). */
  menu?: ReactNode
  /** `sm` for first-run setup's denser gallery. */
  size?: 'md' | 'sm'
  /** The keys the card's button answers besides a click (`aria-keyshortcuts`: ⌥← ⌥→ to move it). */
  keyShortcuts?: string
  onSelect: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
} & { [key: `data-${string}`]: string | undefined }): ReactElement {
  const labelRef = useRef<HTMLSpanElement>(null)
  const metaRef = useRef<HTMLSpanElement>(null)
  // The whole name and meta words on hover and focus, only when a line cut
  // them. Measured after each render and whenever the card's width changes,
  // so the tooltip is ready before the pointer arrives.
  const [cut, setCut] = useState<{ meta: string | null } | null>(null)
  const measure = useCallback((): void => {
    const isCut = (element: HTMLElement | null): boolean =>
      element !== null && element.scrollWidth > element.clientWidth
    const metaCut = isCut(metaRef.current)
    const next =
      isCut(labelRef.current) || metaCut
        ? { meta: metaCut ? (metaRef.current?.textContent ?? null) : null }
        : null
    setCut((current) => (current?.meta === next?.meta && !current === !next ? current : next))
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    const label = labelRef.current
    if (!label || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(label)
    return () => observer.disconnect()
  }, [measure])
  const compact = size === 'sm'
  // The picture well. Selected, a ring in the text's own tone stands off it
  // by 2 px: as plain in light as in dark, never a colour.
  const well = (
    <span
      className={cn(
        'block min-w-0 rounded-chip',
        selected && 'outline-2 outline-offset-2 outline-foreground',
        disabled && 'opacity-50'
      )}
      data-slot="scene-card-thumb"
    >
      {thumb}
    </span>
  )
  const button = (
    <button
      aria-keyshortcuts={keyShortcuts}
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 flex-1 flex-col rounded-row p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
        compact && 'gap-1.5'
      )}
      data-slot="scene-card-button"
      disabled={disabled}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {well}
      {compact ? (
        // The icon flows with the words, so a name too long for the line
        // beside it wraps whole, never inside a word.
        <span
          className={cn('line-clamp-2 min-w-0 text-xs font-medium break-words')}
          data-slot="scene-card-label"
        >
          {icon ? <span className="mr-1 inline-flex align-text-bottom">{icon}</span> : null}
          {label}
        </span>
      ) : (
        <>
          <span className="mt-2 flex h-5 min-w-0 items-center gap-1" data-slot="scene-card-name">
            {icon ? (
              <span className={cn('flex shrink-0', disabled && 'opacity-50')}>{icon}</span>
            ) : null}
            <span
              ref={labelRef}
              className={cn(
                'min-w-0 flex-1 truncate text-sm font-medium',
                disabled && 'opacity-50'
              )}
              data-slot="scene-card-label"
            >
              {label}
            </span>
            {/* The check's place is the ⋯'s: on hover and focus the menu takes it. */}
            <span className="flex size-4 shrink-0 items-center justify-center">
              {selected ? (
                <CheckIcon
                  aria-hidden
                  className={cn(
                    'size-4',
                    menu &&
                      'group-focus-within/kebab-host:opacity-0 group-hover/kebab-host:opacity-0'
                  )}
                  data-testid="scene-card-check"
                  weight="bold"
                />
              ) : null}
            </span>
          </span>
          {/* Essential words: never dimmed with a disabled card. */}
          <span
            className="mt-1 flex h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground"
            data-slot="scene-card-meta"
          >
            <span ref={metaRef} className="min-w-0 flex-1 truncate">
              {meta}
            </span>
            {keys ? <span className="flex shrink-0 items-center">{keys}</span> : null}
          </span>
        </>
      )}
    </button>
  )
  return (
    <MediaCard
      className="group/kebab-host relative"
      interactive={!selected && !disabled}
      selected={selected}
      {...data}
    >
      {disabled && disabledReason ? (
        <DisabledReason className="flex min-w-0 flex-1" reason={disabledReason}>
          {button}
        </DisabledReason>
      ) : compact ? (
        button
      ) : (
        <Tooltip disabled={cut === null}>
          <TooltipTrigger render={button} />
          <TooltipContent className="flex-col items-start gap-0">
            <span>{label}</span>
            {cut?.meta ? <span className="text-muted-foreground">{cut.meta}</span> : null}
          </TooltipContent>
        </Tooltip>
      )}
      {compact && selected ? (
        // It takes no click, so a click on it selects the card under it.
        <Badge
          aria-hidden
          className="pointer-events-none absolute top-1 left-1 px-1"
          data-testid="scene-card-check"
        >
          <CheckIcon weight="bold" />
        </Badge>
      ) : null}
      {menu ? (
        // Over the name row's last place (p-2, a 20 px meta row and its 4 px
        // gap under it), centred on that row and on the check's 16 px.
        <div className={cn('absolute', compact ? 'top-1 right-1.5' : 'right-1 bottom-7.5')}>
          {menu}
        </div>
      ) : null}
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
