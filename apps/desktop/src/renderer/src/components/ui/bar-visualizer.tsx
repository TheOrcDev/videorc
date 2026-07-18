import { forwardRef, memo, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from ElevenLabs UI (ui.elevenlabs.io, registry item `bar-visualizer`)
 * and adapted for Videorc:
 * - bars render in `currentColor` so the parent's text token drives the tone
 *   (chrome when live, muted when idle, warning when silent) — no hardcoded
 *   palette, per the videorc-design "color is information" rule;
 * - the container ships unstyled (no bg/radius/padding) — content sits
 *   directly on the glass panel;
 * - `useBarAnimator` no longer runs a rAF loop for single-frame sequences
 *   (the `speaking`/undefined states used by the mixer), keeping idle CPU at
 *   baseline; multi-frame state animations still animate.
 * Audio analysis is intentionally absent: StudioMicVisualProvider owns the
 * sole analyser and callers pass normalized levels.
 */

export type AgentState = 'connecting' | 'initializing' | 'listening' | 'speaking' | 'thinking'

function generateConnectingSequenceBar(columns: number): number[][] {
  const seq: number[][] = []
  for (let x = 0; x < columns; x++) {
    seq.push([x, columns - 1 - x])
  }
  return seq
}

function generateListeningSequenceBar(columns: number): number[][] {
  const center = Math.floor(columns / 2)
  return [[center], [-1]]
}

/** Highlighted bar indices for the current state; animates only multi-frame sequences. */
export function useBarAnimator(
  state: AgentState | undefined,
  columns: number,
  interval: number
): number[] {
  const indexRef = useRef(0)
  const [currentFrame, setCurrentFrame] = useState<number[]>([])

  const sequence = useMemo(() => {
    if (state === 'thinking' || state === 'listening') {
      return generateListeningSequenceBar(columns)
    }
    if (state === 'connecting' || state === 'initializing') {
      return generateConnectingSequenceBar(columns)
    }
    if (state === undefined || state === 'speaking') {
      return [new Array(columns).fill(0).map((_, idx) => idx)]
    }
    return [[]]
  }, [state, columns])

  useEffect(() => {
    indexRef.current = 0
    setCurrentFrame(sequence[0] ?? [])
    // Single-frame sequences (speaking/idle) need no animation loop — keeping
    // a rAF alive for them would burn idle CPU for a static highlight.
    if (sequence.length <= 1) {
      return
    }

    let frameId = 0
    let startTime = performance.now()

    const animate = (time: number): void => {
      if (time - startTime >= interval) {
        indexRef.current = (indexRef.current + 1) % sequence.length
        setCurrentFrame(sequence[indexRef.current] ?? [])
        startTime = time
      }
      frameId = requestAnimationFrame(animate)
    }

    frameId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frameId)
  }, [interval, sequence])

  return currentFrame
}

export interface BarVisualizerProps extends HTMLAttributes<HTMLDivElement> {
  /** Voice/meter state driving highlight animation; `speaking` lights every bar. */
  state?: AgentState
  /** Number of bars to display. */
  barCount?: number
  /** Explicit normalized levels from a central analyser or honest fallback. */
  levels?: number[]
  /** Min/max bar height as a percentage of the container. */
  minHeight?: number
  maxHeight?: number
  /** Align bars from center instead of bottom. */
  centerAlign?: boolean
}

/** Paint levels without routing analyser frames through React reconciliation. */
export function paintBarVisualizer(
  element: HTMLDivElement | null,
  levels: readonly number[],
  options: { minHeight?: number; maxHeight?: number } = {}
): void {
  if (!element) return
  const minHeight = options.minHeight ?? 20
  const maxHeight = options.maxHeight ?? 100
  for (let index = 0; index < element.children.length; index += 1) {
    const bar = element.children.item(index)
    if (!(bar instanceof HTMLElement)) continue
    const level = levels[index] ?? 0
    bar.style.height = `${Math.min(maxHeight, Math.max(minHeight, level * 100 + 5))}%`
  }
}

const BarVisualizerComponent = forwardRef<HTMLDivElement, BarVisualizerProps>(
  (
    {
      state,
      barCount = 15,
      levels,
      minHeight = 20,
      maxHeight = 100,
      centerAlign = false,
      className,
      ...props
    },
    ref
  ) => {
    const volumeBands = useMemo(
      () => levels ?? new Array<number>(barCount).fill(0),
      [barCount, levels]
    )

    const highlightedIndices = useBarAnimator(
      state,
      barCount,
      state === 'connecting'
        ? 2000 / barCount
        : state === 'thinking'
          ? 150
          : state === 'listening'
            ? 500
            : 1000
    )

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex h-16 w-full justify-center gap-1 overflow-hidden',
          centerAlign ? 'items-center' : 'items-end',
          className
        )}
        data-state={state}
        {...props}
      >
        {volumeBands.map((volume, index) => (
          <Bar
            key={index}
            heightPct={Math.min(maxHeight, Math.max(minHeight, volume * 100 + 5))}
            isHighlighted={highlightedIndices?.includes(index) ?? false}
          />
        ))}
      </div>
    )
  }
)

// Bars paint in currentColor: the parent's text token is the single tone knob.
// Height changes are NOT CSS-transitioned: band updates arrive faster than any
// transition would finish, so a height transition perpetually restarts and
// burns style/layout work — the analyser's own 0.8 smoothing already smooths
// the motion. Only the highlight opacity transitions.
const Bar = memo<{ heightPct: number; isHighlighted: boolean }>(({ heightPct, isHighlighted }) => (
  <div
    className={cn(
      'min-w-1 max-w-2 flex-1 rounded-full bg-current transition-opacity duration-150',
      isHighlighted ? 'opacity-90' : 'opacity-30'
    )}
    data-highlighted={isHighlighted}
    style={{ height: `${heightPct}%` }}
  />
))

Bar.displayName = 'Bar'
BarVisualizerComponent.displayName = 'BarVisualizerComponent'

const BarVisualizer = memo(BarVisualizerComponent)
BarVisualizer.displayName = 'BarVisualizer'

export { BarVisualizer }
