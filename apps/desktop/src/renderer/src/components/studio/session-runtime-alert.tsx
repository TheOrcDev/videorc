import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { revealInFileManagerLabel } from '@/lib/platform'
import { OPEN_AUDIO_LABEL } from '@/lib/section-doors'
import {
  activitySavesRecording,
  sessionRuntimeNoticeOpensAudio,
  sessionRuntimeNoticeTitle,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import type { ReactElement } from 'react'

export function SessionRuntimeAlert({
  notice,
  onDismiss,
  onOpenAudio,
  onOpenLibrary,
  onRevealOutput
}: {
  notice: SessionRuntimeNotice
  onDismiss: () => void
  /** Studio's Microphone row: the door for a lost or silent microphone. */
  onOpenAudio?: () => void
  onOpenLibrary?: () => void
  onRevealOutput?: () => void
}): ReactElement {
  const recordingFailed = notice.kind === 'recording-failed'
  // Go Live's record+stream saved a file too: it keeps the file's actions.
  const savedFile = recordingFailed && activitySavesRecording(notice.activity)
  const opensAudio = Boolean(onOpenAudio) && sessionRuntimeNoticeOpensAudio(notice)

  return (
    // Assertive in both tones: it reports a problem with the recording or
    // stream that is running right now, so a screen reader hears it at once.
    <Alert
      data-testid="session-runtime-notice"
      key={notice.at}
      role="alert"
      variant={recordingFailed ? 'destructive' : 'warning'}
    >
      <AlertTitle>{sessionRuntimeNoticeTitle(notice)}</AlertTitle>
      <AlertDescription className="min-w-0">
        <p className="line-clamp-3" title={notice.message}>
          {notice.message}
        </p>
        <div className="flex flex-wrap gap-1 pt-2">
          {/* The watchdog card's door, which this notice hides while it is
              up: the microphone row, its meter and its picker. */}
          {opensAudio ? (
            <Button
              data-testid="session-runtime-open-audio"
              size="xs"
              type="button"
              variant="default"
              onClick={onOpenAudio}
            >
              {OPEN_AUDIO_LABEL}
            </Button>
          ) : null}
          {savedFile && onOpenLibrary ? (
            <Button size="xs" type="button" variant="ghost" onClick={onOpenLibrary}>
              Open Library
            </Button>
          ) : null}
          {savedFile && notice.outputPath && onRevealOutput ? (
            <Button size="xs" type="button" variant="ghost" onClick={onRevealOutput}>
              {revealInFileManagerLabel()}
            </Button>
          ) : null}
          <Button size="xs" type="button" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
