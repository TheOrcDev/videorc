import { useRef, type ReactElement, type RefObject } from 'react'

import { BarVisualizer, paintBarVisualizer } from '@/components/ui/bar-visualizer'
import { useStudioMicVisualPainter } from '@/hooks/use-studio-mic-visual'
import { resampleMicVisualLevelsInto } from '@/lib/mic-visual-frame'
import { fallbackBandLevels } from '@/lib/mic-meter'
import { cn } from '@/lib/utils'

const SLIVER_BAR_COUNT = 5

/**
 * In-session mic confidence sliver (Studio audio rework S5): a passive 5-bar
 * mini visualizer beside the session status badge — one home, rendered by the
 * status cluster wherever it lives (Preview panel header or the docked
 * frame's control row). Visible only while a session runs with a mic
 * selected; its width is reserved for the whole session so mute toggles never
 * shift layout (muted shows flat dim bars). No click target — the mixer owns
 * the controls. The workspace provider owns visibility cleanup and analysis.
 */
export function SessionMicSliver({
  sessionActive,
  deviceName,
  muted
}: {
  sessionActive: boolean
  deviceName: string | undefined
  muted: boolean
}): ReactElement | null {
  if (!sessionActive || !deviceName) {
    return null
  }

  return muted ? (
    <SessionMicSliverBars levels={fallbackBandLevels(0, SLIVER_BAR_COUNT)} muted />
  ) : (
    <ActiveSessionMicSliver />
  )
}

function ActiveSessionMicSliver(): ReactElement {
  const visualizerRef = useRef<HTMLDivElement>(null)
  useSessionMicFramePainter(visualizerRef)

  return (
    <SessionMicSliverBars
      levels={fallbackBandLevels(0, SLIVER_BAR_COUNT)}
      muted={false}
      visualizerRef={visualizerRef}
    />
  )
}

/** Shared by the real session sliver and the provider integration regression. */
export function useSessionMicFramePainter(visualizerRef: RefObject<HTMLDivElement | null>): void {
  const levelsRef = useRef<number[] | null>(null)
  if (!levelsRef.current) levelsRef.current = new Array<number>(SLIVER_BAR_COUNT).fill(0)
  useStudioMicVisualPainter((frame) => {
    const levels = levelsRef.current
    if (!levels) return
    resampleMicVisualLevelsInto(frame.bands, levels)
    paintBarVisualizer(visualizerRef.current, levels, { minHeight: 12 })
  })
}

function SessionMicSliverBars({
  levels,
  muted,
  visualizerRef
}: {
  levels: number[]
  muted: boolean
  visualizerRef?: RefObject<HTMLDivElement | null>
}): ReactElement {
  return (
    <span
      className="flex w-9 shrink-0 items-center"
      data-videorc-session-mic-sliver
      title={muted ? 'Microphone muted' : 'Live microphone signal'}
    >
      <BarVisualizer
        ref={visualizerRef}
        centerAlign
        barCount={SLIVER_BAR_COUNT}
        className={cn(
          'h-4 w-full gap-0.5',
          muted ? 'text-muted-foreground/50' : 'text-foreground/70'
        )}
        levels={levels}
        minHeight={12}
        state="speaking"
      />
    </span>
  )
}
