import { useVirtualizer } from '@tanstack/react-virtual'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { ChatIcon, ClipIcon, MicrophoneIcon, PinIcon, WaveformIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ClipMomentSource, CleanCutRemoval } from '@/lib/backend'
import {
  formatCutLength,
  removalKindName,
  removalTone,
  type CleanCutParagraph,
  type CleanCutPin,
  type CleanCutTone,
  type CleanCutTranscriptItem,
  type CleanCutTranscriptToken,
  type CondensedBlock
} from '@/lib/clean-cut-review'
import { formatCutClock } from '@/lib/clean-cut-view'
import { cn } from '@/lib/utils'

/** A cut word: dimmed and struck through in its kind's tone. */
const STRUCK: Record<CleanCutTone, string> = {
  neutral: 'text-subtle line-through decoration-muted-foreground',
  warning: 'text-subtle line-through decoration-warning',
  destructive: 'text-subtle line-through decoration-destructive',
  info: 'text-subtle line-through decoration-info'
}

/** A suggestion that is kept: normal text, a dotted underline in its tone. */
const SUGGESTED: Record<CleanCutTone, string> = {
  neutral: 'underline decoration-dotted underline-offset-4 decoration-muted-foreground',
  warning: 'underline decoration-dotted underline-offset-4 decoration-warning',
  destructive: 'underline decoration-dotted underline-offset-4 decoration-destructive',
  info: 'underline decoration-dotted underline-offset-4 decoration-info'
}

/** The tone dot of a kind (the chips use the same). */
export const TONE_DOT: Record<CleanCutTone, string> = {
  neutral: 'tone-neutral',
  warning: 'tone-warning',
  destructive: 'tone-destructive',
  info: 'tone-info'
}

const PIN_ICONS: Record<ClipMomentSource, typeof PinIcon> = {
  voice: MicrophoneIcon,
  manual: ClipIcon,
  chat: ChatIcon
}

export interface CleanCutScrollRequest {
  row: number
  nonce: number
}

export interface CleanCutTranscriptProps {
  items: readonly CleanCutTranscriptItem[]
  /** The cut list with the draft applied, by removal id. */
  removals: ReadonlyMap<string, CleanCutRemoval>
  selectedId: string | null
  /** The word under the playhead, or -1. */
  activeWord: number
  scrollRequest: CleanCutScrollRequest | null
  onToggleRemoval: (id: string) => void
  onSeek: (ms: number) => void
  onToggleBlock: (block: CondensedBlock) => void
  className?: string
}

/**
 * The transcript editor (plan 119 S14): flowing text, cut words struck
 * through in their kind's tone, kept suggestions underlined, pauses and the
 * start and end as small inline markers. A click on a cut keeps or cuts it;
 * a click on a word seeks the player there. Rows are virtualized, so a
 * two-hour stream (30k words) scrolls like a short one.
 */
export function CleanCutTranscript({
  items,
  removals,
  selectedId,
  activeWord,
  scrollRequest,
  onToggleRemoval,
  onSeek,
  onToggleBlock,
  className
}: CleanCutTranscriptProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    setViewport(
      rootRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
    )
  }, [])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport,
    estimateSize: (index) => (items[index]?.type === 'block' ? 40 : 96),
    overscan: 6,
    getItemKey: (index) => items[index]?.key ?? index
  })

  useEffect(() => {
    if (!scrollRequest) return
    virtualizer.scrollToIndex(scrollRequest.row, { align: 'auto' })
    // The nonce re-runs the same row on purpose.
  }, [scrollRequest, virtualizer])

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    // A drag that selected text is a selection, not a click.
    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const removal = target.closest<HTMLElement>('[data-removal-id]')
    if (removal?.dataset.removalId) {
      onToggleRemoval(removal.dataset.removalId)
      return
    }
    const seek = target.closest<HTMLElement>('[data-seek-ms]')
    if (seek?.dataset.seekMs) onSeek(Number(seek.dataset.seekMs))
  }

  return (
    // Radix lays the viewport's content out as a table, which lets one long
    // unbreakable row widen every row; a block keeps rows to the pane width.
    <ScrollArea
      ref={rootRef}
      className={cn('min-h-0 [&_[data-slot=scroll-area-viewport]>div]:block!', className)}
      data-clean-cut="transcript"
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
        onClick={handleClick}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]
          if (!item) return null
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              data-index={row.index}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {item.type === 'block' ? (
                <BlockRow block={item.block} onToggle={onToggleBlock} />
              ) : (
                <ParagraphRow
                  activeWord={paragraphHasWord(item, activeWord) ? activeWord : -1}
                  paragraph={item}
                  removals={removals}
                  selectedId={
                    selectedId && item.removalIds.includes(selectedId) ? selectedId : null
                  }
                  stateKey={paragraphStateKey(item, removals)}
                />
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function paragraphHasWord(paragraph: CleanCutParagraph, wordIndex: number): boolean {
  if (wordIndex < 0) return false
  const first = paragraph.tokens.find((token) => token.type === 'word')
  const last = [...paragraph.tokens].reverse().find((token) => token.type === 'word')
  return Boolean(
    first &&
    last &&
    first.type === 'word' &&
    last.type === 'word' &&
    wordIndex >= first.index &&
    wordIndex <= last.index
  )
}

/** Which of the paragraph's cuts are on: the row re-renders only when one flips. */
function paragraphStateKey(
  paragraph: CleanCutParagraph,
  removals: ReadonlyMap<string, CleanCutRemoval>
): string {
  let key = ''
  for (const id of paragraph.removalIds) {
    const removal = removals.get(id)
    key += removal ? (removal.enabled ? '1' : '0') : '-'
  }
  return key
}

interface RunState {
  /** The removal a click toggles. */
  id: string
  removal: CleanCutRemoval | null
  cut: boolean
  tone: CleanCutTone
}

/** The innermost removal decides the click; any cut covering the word strikes it. */
function runState(
  ids: readonly string[],
  removals: ReadonlyMap<string, CleanCutRemoval>
): RunState | null {
  const known = ids
    .map((id) => removals.get(id))
    .filter((removal): removal is CleanCutRemoval => Boolean(removal))
  const primary = known[0]
  if (!primary) return null
  const cutBy = known.find((removal) => removal.enabled)
  return {
    id: primary.id,
    removal: primary,
    cut: Boolean(cutBy),
    tone: removalTone((cutBy ?? primary).kind)
  }
}

function removalTitle(removal: CleanCutRemoval | null, cut: boolean): string {
  if (!removal) return ''
  const reason = removal.reason.trim()
  const what = reason
    ? `${removalKindName(removal.kind)}: ${reason}`
    : removalKindName(removal.kind)
  return `${what}. ${cut ? 'Click to keep it.' : 'Click to cut it.'}`
}

const ParagraphRow = memo(
  function ParagraphRow({
    paragraph,
    removals,
    selectedId,
    activeWord
  }: {
    paragraph: CleanCutParagraph
    removals: ReadonlyMap<string, CleanCutRemoval>
    selectedId: string | null
    activeWord: number
    stateKey: string
  }): ReactElement {
    return (
      <p
        className="px-gutter py-1 text-sm leading-6 text-foreground select-text"
        data-slot="clean-cut-paragraph"
      >
        {renderTokens(paragraph.tokens, removals, selectedId, activeWord)}
      </p>
    )
  },
  (previous, next) =>
    previous.paragraph === next.paragraph &&
    previous.stateKey === next.stateKey &&
    previous.selectedId === next.selectedId &&
    previous.activeWord === next.activeWord
)

function renderTokens(
  tokens: readonly CleanCutTranscriptToken[],
  removals: ReadonlyMap<string, CleanCutRemoval>,
  selectedId: string | null,
  activeWord: number
): ReactNode[] {
  const out: ReactNode[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token.type === 'pin') {
      out.push(<PinMarker key={`pin-${token.pin.key}`} pin={token.pin} />, ' ')
      index += 1
      continue
    }
    if (token.type === 'marker') {
      const removal = removals.get(token.removalId) ?? null
      if (removal) {
        out.push(
          <CutMarker
            key={`marker-${token.removalId}`}
            removal={removal}
            selected={selectedId === token.removalId}
          />,
          ' '
        )
      }
      index += 1
      continue
    }
    const state = runState(token.removalIds, removals)
    if (!state) {
      out.push(
        <span
          key={`w-${token.index}`}
          className={cn(
            'rounded-[3px] hover:bg-accent',
            token.index === activeWord && 'bg-accent-pressed'
          )}
          data-seek-ms={token.startMs}
        >
          {token.text}
        </span>,
        ' '
      )
      index += 1
      continue
    }
    // A run of words that share their innermost removal: one click target,
    // one continuous strike.
    const words: Array<Extract<CleanCutTranscriptToken, { type: 'word' }>> = []
    let next = index
    while (next < tokens.length) {
      const candidate = tokens[next]
      if (candidate.type !== 'word' || candidate.removalIds[0] !== token.removalIds[0]) break
      words.push(candidate)
      next += 1
    }
    const selected = selectedId === state.id
    out.push(
      <span
        key={`run-${state.id}-${token.index}`}
        aria-pressed={state.cut}
        className={cn(
          'rounded-[3px] decoration-2 hover:bg-accent',
          state.cut ? STRUCK[state.tone] : SUGGESTED[state.tone],
          selected && 'bg-accent ring-1 ring-ring/50'
        )}
        data-cut={state.cut ? 'on' : 'off'}
        data-removal-id={state.id}
        data-selected={selected || undefined}
        role="button"
        title={removalTitle(state.removal, state.cut)}
      >
        {words.map((word, position) => (
          <span key={word.index} className={cn(word.index === activeWord && 'bg-accent-pressed')}>
            {position > 0 ? ' ' : null}
            {word.text}
          </span>
        ))}
      </span>,
      ' '
    )
    index = next
  }
  return out
}

function markerLabel(removal: CleanCutRemoval): string {
  const length = formatCutLength(removal.endMs - removal.startMs)
  if (removal.kind === 'head') return `Start ${length}`
  if (removal.kind === 'tail') return `End ${length}`
  return length
}

/** A cut with no words: a silence, a pause with sound, the start or the end. */
function CutMarker({
  removal,
  selected
}: {
  removal: CleanCutRemoval
  selected: boolean
}): ReactElement {
  const tone = removalTone(removal.kind)
  return (
    <Badge
      aria-pressed={removal.enabled}
      className={cn(
        'mx-px align-[1px] tabular-nums hover:bg-accent',
        removal.enabled ? 'decoration-muted-foreground' : 'opacity-70',
        selected && 'ring-1 ring-ring/50'
      )}
      data-cut={removal.enabled ? 'on' : 'off'}
      data-kind={removal.kind}
      data-removal-id={removal.id}
      data-selected={selected || undefined}
      role="button"
      title={removalTitle(removal, removal.enabled)}
      variant={removal.enabled ? 'outline' : 'ghost'}
    >
      {removal.kind === 'gap' ? <WaveformIcon aria-hidden /> : null}
      <span
        className={cn(
          removal.enabled ? 'line-through' : cn('underline decoration-dotted', SUGGESTED[tone])
        )}
      >
        {markerLabel(removal)}
      </span>
    </Badge>
  )
}

/** A moment from the stream report: a pin that seeks there. */
function PinMarker({ pin }: { pin: CleanCutPin }): ReactElement {
  const Glyph = PIN_ICONS[pin.kind] ?? PinIcon
  return (
    <Badge
      className="mx-px align-[1px] hover:bg-accent"
      data-pin={pin.kind}
      data-seek-ms={pin.startMs}
      role="button"
      title={pin.excerpt ? `${pin.label}: ${pin.excerpt}` : pin.label}
      variant="outline"
    >
      <Glyph aria-hidden data-icon="inline-start" />
      {pin.label}
      <span className="font-normal text-subtle tabular-nums">{formatCutClock(pin.startMs)}</span>
    </Badge>
  )
}

const BLOCK_ACTIONS = {
  kept: { on: 'Drop', off: 'Keep' },
  'left-out': { on: 'Leave out', off: 'Bring back' }
} as const

/** A Condensed part: its title, when and how long, and one toggle. */
function BlockRow({
  block,
  onToggle
}: {
  block: CondensedBlock
  onToggle: (block: CondensedBlock) => void
}): ReactElement {
  const title =
    block.kind === 'left-out' ? (block.removed ? 'Left out' : 'Brought back') : block.title
  const action = block.removed ? BLOCK_ACTIONS[block.kind].off : BLOCK_ACTIONS[block.kind].on
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 border-y border-border bg-foreground/[0.03] px-gutter py-1.5',
        block.removed && 'text-muted-foreground'
      )}
      data-block={block.kind}
      data-removed={block.removed || undefined}
      data-slot="clean-cut-block"
    >
      <span
        className={cn(
          'max-w-[45%] shrink-0 truncate text-[13px] font-semibold',
          block.removed ? 'text-muted-foreground' : 'text-foreground'
        )}
        title={title}
      >
        {title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatCutClock(block.startMs)}–{formatCutClock(block.endMs)} ·{' '}
        {formatCutClock(block.endMs - block.startMs)}
      </span>
      {block.removed && block.excerpt ? (
        <span className="min-w-0 truncate text-xs text-subtle" title={block.excerpt}>
          {block.excerpt}
        </span>
      ) : null}
      {block.kind === 'kept' && block.removed ? <Badge variant="outline">Dropped</Badge> : null}
      <Button
        className="ml-auto"
        size="xs"
        type="button"
        variant="outline"
        onClick={() => onToggle(block)}
      >
        {action}
      </Button>
    </div>
  )
}
