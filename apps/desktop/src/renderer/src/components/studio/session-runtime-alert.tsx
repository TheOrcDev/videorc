import { AlertIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { revealInFileManagerLabel } from '@/lib/platform'
import {
  activitySavesRecording,
  sessionRuntimeNoticeTitle,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import type { ReactElement } from 'react'

export function SessionRuntimeAlert({
  notice,
  onDismiss,
  onOpenLibrary,
  onRevealOutput
}: {
  notice: SessionRuntimeNotice
  onDismiss: () => void
  onOpenLibrary?: () => void
  onRevealOutput?: () => void
}): ReactElement {
  const recordingFailed = notice.kind === 'recording-failed'
  // Go Live's record+stream saved a file too: it keeps the file's actions.
  const savedFile = recordingFailed && activitySavesRecording(notice.activity)

  return (
    <Alert
      data-testid="session-runtime-notice"
      key={notice.at}
      variant={recordingFailed ? 'destructive' : 'warning'}
    >
      <AlertIcon weight="fill" />
      <AlertTitle>{sessionRuntimeNoticeTitle(notice)}</AlertTitle>
      <AlertDescription className="min-w-0">
        <p className="line-clamp-3" title={notice.message}>
          {notice.message}
        </p>
        <div className="flex flex-wrap gap-1 pt-2">
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
