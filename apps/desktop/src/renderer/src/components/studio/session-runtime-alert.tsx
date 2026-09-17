import { AlertIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { sessionRuntimeNoticeTitle, type SessionRuntimeNotice } from '@/lib/session-runtime-notice'
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
          {recordingFailed && notice.activity === 'recording' && onOpenLibrary ? (
            <Button size="xs" type="button" variant="ghost" onClick={onOpenLibrary}>
              Open Library
            </Button>
          ) : null}
          {recordingFailed &&
          notice.activity === 'recording' &&
          notice.outputPath &&
          onRevealOutput ? (
            <Button size="xs" type="button" variant="ghost" onClick={onRevealOutput}>
              Show in Finder
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
