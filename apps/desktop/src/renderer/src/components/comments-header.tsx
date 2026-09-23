import { FrameIcon, MoreIcon, PinIcon, PreviewIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { CommentHighlightAnchor, ViewerSample } from '@/lib/backend'
import { COMMENT_HIGHLIGHT_ANCHORS, normalizeCommentHighlightAnchor } from '@/lib/backend'
import {
  CHAT_HEADER_COMPACT_ONLY,
  CHAT_HEADER_FULL_ONLY,
  CHAT_HEADER_TIGHT_SR_ONLY
} from '@/lib/chat-header-tiers'
import { cn } from '@/lib/utils'
import { viewerChipCount, viewerChipDetail, viewerSampleStale } from '@/lib/viewer-count-view'

export const HIGHLIGHT_ANCHOR_LABELS: Record<CommentHighlightAnchor, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right'
}

const CLEAR_VIEW_HINT = 'Clear view keeps Library history.'

/**
 * Live concurrent viewers. The last live item to give up space: it never
 * shrinks or wraps; below the Tight breakpoint "watching" leaves the eye but
 * stays in the accessible text, and the per-platform split lives in the title.
 */
export function ViewerCountChip({
  sample,
  nowMs
}: {
  sample: ViewerSample
  nowMs: number
}): ReactElement {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums',
        viewerSampleStale(sample, nowMs) ? 'text-subtle' : 'text-foreground'
      )}
      data-slot="viewer-count"
      title={viewerChipDetail(sample)}
    >
      <PreviewIcon aria-hidden className="size-3.5 shrink-0" weight="duotone" />
      <span data-slot="viewer-count-number">{viewerChipCount(sample)}</span>
      <span className={CHAT_HEADER_TIGHT_SR_ONLY}> watching</span>
    </span>
  )
}

export interface ChatHeaderActionsProps {
  highlightAnchor?: CommentHighlightAnchor
  onHighlightAnchorChange?: (anchor: CommentHighlightAnchor) => void
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
  onClear?: () => void
  onBackToLive?: () => void
}

/**
 * The header's right-hand controls. `Back to live` is the primary action in
 * history and always stays inline; everything else is inline in the Full tier
 * and folds into one ⋯ menu below it. Both shapes are always in the DOM and
 * the container query picks one, so there is no resize state to drift.
 */
export function ChatHeaderActions({
  highlightAnchor,
  onHighlightAnchorChange,
  alwaysOnTop = false,
  onToggleAlwaysOnTop,
  onClear,
  onBackToLive
}: ChatHeaderActionsProps): ReactElement {
  const anchorControl =
    highlightAnchor && onHighlightAnchorChange
      ? { anchor: highlightAnchor, onChange: onHighlightAnchorChange }
      : null
  const hasFoldable = Boolean(anchorControl || onToggleAlwaysOnTop || onClear)

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
      data-slot="chat-header-actions"
    >
      {onBackToLive ? (
        <Button size="sm" type="button" variant="ghost" onClick={onBackToLive}>
          Back to live
        </Button>
      ) : null}
      {hasFoldable ? (
        <div
          className={cn('flex items-center gap-0.5', CHAT_HEADER_FULL_ONLY)}
          data-slot="chat-header-inline-actions"
        >
          {anchorControl ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Highlight position"
                  size="icon-sm"
                  title={`Highlight position: ${HIGHLIGHT_ANCHOR_LABELS[anchorControl.anchor]}`}
                  type="button"
                  variant="ghost"
                >
                  <FrameIcon data-icon="inline-start" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <HighlightAnchorOptions {...anchorControl} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {onToggleAlwaysOnTop ? (
            <Button
              aria-label="Keep this window on top"
              aria-pressed={alwaysOnTop}
              className={cn(alwaysOnTop && 'text-foreground')}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={onToggleAlwaysOnTop}
            >
              <PinIcon data-icon="inline-start" weight={alwaysOnTop ? 'fill' : 'regular'} />
            </Button>
          ) : null}
          {onClear ? (
            <Button
              size="sm"
              title={CLEAR_VIEW_HINT}
              type="button"
              variant="ghost"
              onClick={onClear}
            >
              Clear view
            </Button>
          ) : null}
        </div>
      ) : null}
      {hasFoldable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="More chat actions"
              className={CHAT_HEADER_COMPACT_ONLY}
              data-slot="chat-header-more"
              size="icon-sm"
              title="More chat actions"
              type="button"
              variant="ghost"
            >
              <MoreIcon data-icon="inline-start" weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {anchorControl ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FrameIcon />
                  Highlight position
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <HighlightAnchorOptions {...anchorControl} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {onToggleAlwaysOnTop ? (
              <DropdownMenuCheckboxItem
                checked={alwaysOnTop}
                onCheckedChange={() => onToggleAlwaysOnTop()}
              >
                Keep on top
              </DropdownMenuCheckboxItem>
            ) : null}
            {onClear ? (
              <>
                {anchorControl || onToggleAlwaysOnTop ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={onClear}>
                  <span className="flex flex-col">
                    <span>Clear view</span>
                    <span className="text-[11px] text-muted-foreground">
                      Keeps Library history.
                    </span>
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

/** One anchor picker, shared by the inline dropdown and the ⋯ submenu. */
function HighlightAnchorOptions({
  anchor,
  onChange
}: {
  anchor: CommentHighlightAnchor
  onChange: (anchor: CommentHighlightAnchor) => void
}): ReactElement {
  return (
    <>
      <DropdownMenuLabel>Show highlighted messages in</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={anchor}
        onValueChange={(value) => onChange(normalizeCommentHighlightAnchor(value))}
      >
        {COMMENT_HIGHLIGHT_ANCHORS.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            {HIGHLIGHT_ANCHOR_LABELS[option]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
