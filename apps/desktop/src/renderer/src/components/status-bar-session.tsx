import type { ReactElement } from 'react'

import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import {
  sessionClockLabel,
  sessionStatusLabel,
  sessionStatusPulses,
  sessionStatusTone,
  type SessionStatusView
} from '@/lib/studio-session-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The status bar's state (plan 174 S1.3, A-4, D9): the session's own words
 * ("Ready", "Recording", "On air", "Videorc is reconnecting…"), never the
 * socket's enum, with the elapsed time while recording or on air. It is the
 * door to Health, which stays out of the sidebar. The clock ticks here, so
 * only this leaf re-renders each second, never the shell.
 */
export function StatusBarSessionState({
  recording,
  wsStatus
}: {
  recording: SessionStatusView & { startedAt?: string | null }
  wsStatus: string
}): ReactElement {
  const label = sessionStatusLabel(recording, wsStatus)
  const pulse = sessionStatusPulses(recording, wsStatus)
  const elapsedMs = useSessionElapsedMs(pulse ? (recording.startedAt ?? undefined) : undefined)
  return (
    // A polite live region announces a state change; the clock is hidden from
    // it, or every tick would be read out.
    <div className="flex min-w-0" role="status">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="-ml-1.5 flex h-5 min-w-0 items-center gap-1.5 rounded-chip px-1.5 transition-colors duration-100 hover:bg-accent hover:text-foreground"
              data-slot="status-bar-state"
              type="button"
              onClick={() => openWorkspaceTab('diagnostics')}
            />
          }
        >
          <StatusDot label={label} pulse={pulse} tone={sessionStatusTone(recording, wsStatus)} />
          {pulse && elapsedMs !== undefined ? (
            <span aria-hidden className="text-xs tabular-nums">
              {sessionClockLabel(elapsedMs)}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="top">Open Health</TooltipContent>
      </Tooltip>
    </div>
  )
}
