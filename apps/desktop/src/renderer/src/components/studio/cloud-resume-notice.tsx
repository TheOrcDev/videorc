import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { useStudioCloud } from '@/hooks/use-studio'
import type { CloudResumeNotice as CloudResumeNoticeCopy } from '@/lib/cloud-show-view'
import {
  END_LIVESTREAM_LABEL,
  END_LIVESTREAM_TITLE,
  KEEP_STREAMING_LABEL
} from '@/lib/session-stop'

/**
 * Plan 184 C5: a show is still live on Videorc Cloud and this computer isn't
 * feeding it (a crash, a relaunch, an update). Resume is Go Live, which the
 * backend binds to that show; End livestream ends it on every platform,
 * after the same question every in-app stop asks.
 *
 * Plan 243 C5: the same notice says when the show waits for a device after a
 * hand-off (with where a phone continues) or is live from another device,
 * and its first action reads Continue here: the same resume, which takes
 * the show back to this computer.
 *
 * `rejoining`: the Studio is already going back into the room by itself
 * (a backend restart). Resume waits for it; End livestream never does.
 */
export function CloudResumeNotice({
  blockedReason,
  notice,
  pending,
  rejoining = false,
  onResume
}: {
  /** Why Go Live can't run right now; Resume says it on hover. */
  blockedReason: string | null
  notice: CloudResumeNoticeCopy
  pending: boolean
  rejoining?: boolean
  onResume: () => void
}): ReactElement {
  const { endCloudShow } = useStudioCloud()
  const [confirming, setConfirming] = useState(false)
  const [ending, setEnding] = useState(false)
  const continues = notice.action === 'continue'
  return (
    <div className="border-b border-border p-gutter">
      <Alert data-testid="cloud-resume-notice" variant={notice.tone}>
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription className="min-w-0">
          {notice.detail ? <p>{notice.detail}</p> : null}
          {notice.pointer ? (
            <p className="select-text" data-testid="cloud-continue-pointer">
              {notice.pointer}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1 pt-2">
            <DisabledReason reason={pending ? null : blockedReason}>
              <Button
                data-testid="cloud-resume"
                disabled={pending || rejoining || Boolean(blockedReason)}
                size="xs"
                type="button"
                onClick={onResume}
              >
                {rejoining
                  ? 'Reconnecting…'
                  : continues
                    ? pending
                      ? 'Continuing…'
                      : 'Continue here'
                    : pending
                      ? 'Resuming…'
                      : 'Resume'}
              </Button>
            </DisabledReason>
            <Button
              data-testid="cloud-end"
              disabled={pending}
              size="xs"
              type="button"
              variant="outline"
              onClick={() => setConfirming(true)}
            >
              {END_LIVESTREAM_LABEL}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
      <ConfirmDialog
        cancelDisabled={ending}
        cancelLabel={KEEP_STREAMING_LABEL}
        confirmDisabled={ending}
        confirmLabel={ending ? 'Ending…' : END_LIVESTREAM_LABEL}
        description="The stream ends on every platform it's live on."
        open={confirming}
        testId="cloud-end-livestream"
        title={END_LIVESTREAM_TITLE}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setEnding(true)
          void endCloudShow().finally(() => {
            setEnding(false)
            setConfirming(false)
          })
        }}
      />
    </div>
  )
}
