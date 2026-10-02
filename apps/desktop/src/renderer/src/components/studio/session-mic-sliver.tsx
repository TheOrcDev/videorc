import type { ReactElement } from 'react'

import { BarVisualizer } from '@/components/ui/bar-visualizer'
import { useStudioMicVisualSource } from '@/hooks/use-studio-mic-sources'
import type { FrameSource, VisualFrame } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const SLIVER_BAR_COUNT = 5
const SILENT_BARS: readonly number[] = Object.freeze(new Array<number>(SLIVER_BAR_COUNT).fill(0))

/**
 * In-session mic confidence sliver (Studio audio rework S5, on audiocn's bar
 * visualizer since plan 092): a passive 5-bar mini visualizer beside the
 * session status badge, rendered by the status cluster wherever it lives
 * (Preview panel header or the docked frame's control row). Visible only
 * while a session runs with a mic selected; its width is reserved for the
 * whole session so mute toggles never shift layout (muted shows flat dim
 * bars). No click target: the mixer owns the controls. The workspace provider
 * owns visibility cleanup and analysis; bars that stop moving cost no frames.
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

  return muted ? <SessionMicSliverBars muted /> : <ActiveSessionMicSliver />
}

function ActiveSessionMicSliver(): ReactElement {
  const source = useStudioMicVisualSource()
  return <SessionMicSliverBars muted={false} source={source} />
}

function SessionMicSliverBars({
  muted,
  source
}: {
  muted: boolean
  source?: FrameSource<VisualFrame>
}): ReactElement {
  return (
    <span
      className="flex w-9 shrink-0 items-center"
      data-videorc-session-mic-sliver
      title={muted ? 'Microphone muted' : 'Live microphone signal'}
    >
      <BarVisualizer
        align="center"
        barCount={SLIVER_BAR_COUNT}
        className={cn(
          'h-4 w-full [--bar-gap:0.125rem]',
          muted ? 'text-muted-foreground/50' : 'text-foreground/70'
        )}
        idle="static"
        levels={source ? undefined : SILENT_BARS}
        minLevel={0.12}
        source={source}
      />
    </span>
  )
}
