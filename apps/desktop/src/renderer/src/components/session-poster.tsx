import { VideoFileIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { StatusDot } from '@/components/status-dot'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import type { SessionSummary } from '@/lib/backend'
import { isLiveSession, sessionPosterUrl } from '@/lib/library-view'
import { isFinalizingSession } from '@/lib/session-finalization'
import { sessionStatusPulses, sessionStatusTone } from '@/lib/state-labels'
import { cn } from '@/lib/utils'

/** Poster with one lazy backfill attempt: older sessions have no poster yet;
 * a 404 triggers a single sessions.poster round-trip (idle-aware backend).
 * Running sessions never request the poster — extraction waits for capture
 * idle, so the request is guaranteed to 404. The Library's rows and Clean
 * cut's recording list draw the same one; `className` sets its size. */
export function SessionPoster({
  session,
  className
}: {
  session: Pick<SessionSummary, 'id' | 'durationMs' | 'status' | 'finalizationState'>
  className?: string
}): ReactElement {
  const { connection, ensureSessionPoster } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Posters are extracted after finalization; while the MP4 is still exporting
  // the request would 404, so treat a finalizing row like a running one.
  const running = session.status === 'running' || isFinalizingSession(session)
  const url = running ? null : sessionPosterUrl(connection, session)
  const source = url && attempt > 0 ? `${url}&attempt=${attempt}` : url
  return (
    <span
      className={cn(
        'grid h-10 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded-row border bg-muted/30',
        className
      )}
      data-slot="session-poster"
    >
      {isLiveSession(session, recording) ? (
        <StatusDot pulse={sessionStatusPulses(recording)} tone={sessionStatusTone(recording)} />
      ) : source && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          src={source}
          onError={() => {
            if (attempt === 0) {
              void ensureSessionPoster(session.id).then((available) => {
                if (available) {
                  setAttempt(1)
                } else {
                  setFailed(true)
                }
              })
            } else {
              setFailed(true)
            }
          }}
        />
      ) : (
        <VideoFileIcon className="size-4 text-muted-foreground" weight="duotone" />
      )}
    </span>
  )
}
