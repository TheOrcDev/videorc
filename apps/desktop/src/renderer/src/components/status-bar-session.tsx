import type { ReactElement } from 'react'

import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import {
  sessionAlsoRecords,
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
 *
 * It is the session's one word since the Studio's Ready badge went (plan 235
 * D1): on air it adds "· Rec" when the livestream is also recorded, the fact
 * the badge's Rec chip carried. `data-videorc-session-status` holds the state
 * words alone (no Rec, no clock): the backend-resilience and captions smokes
 * read it.
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
  // Go Live is record+stream, which the backend reports as `recording`
  // (plan 095 S5): on air, say the file is being written too.
  const alsoRecords = wsStatus === 'connected' && sessionAlsoRecords(recording)
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
          <span className="flex min-w-0" data-videorc-session-status="">
            <StatusDot label={label} pulse={pulse} tone={sessionStatusTone(recording, wsStatus)} />
          </span>
          {alsoRecords ? (
            <span className="shrink-0 text-xs" data-testid="session-also-recording">
              · Rec
            </span>
          ) : null}
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
