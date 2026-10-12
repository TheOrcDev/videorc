import type { ReactElement } from 'react'

import { formatTimecode } from '../../../shared/timecode'
import { StatusDot } from '@/components/status-dot'
import { useStudioReplay } from '@/hooks/use-studio'

/**
 * The status bar's clip chip (plan 181, the owner's redesign): "Clip · 0:30"
 * with a neutral dot while the ring holds frames (what a Clip press saves
 * right now), "Clips starting…" while it fills. With the ring on by default
 * this is the one place that shows it is on. It never reads "Recording" or
 * "On air": those are the session's words, and a buffer-only session has
 * neither. A leaf on its own context, so the ring's once-a-second tick
 * re-renders this chip and nothing else.
 */
export function StatusBarReplayState(): ReactElement | null {
  const ring = useStudioReplay().state
  if (ring.state !== 'on' && ring.state !== 'starting') return null
  const label =
    ring.state === 'on'
      ? `Clip · ${formatTimecode(ring.bufferedSeconds * 1000)}`
      : 'Clips starting…'
  return (
    <span data-testid="status-bar-replay">
      <StatusDot label={label} tone="neutral" />
    </span>
  )
}
