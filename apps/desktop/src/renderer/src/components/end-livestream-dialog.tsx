import type { ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  END_LIVESTREAM_LABEL,
  END_LIVESTREAM_TITLE,
  KEEP_STREAMING_LABEL,
  endLivestreamBody,
  type SessionStopConfirmation
} from '@/lib/session-stop'

export type { SessionStopConfirmation }

/**
 * "End livestream?" (plan 174 S0.1, D2): the one question every in-app stop
 * path asks while live. Hosted by the shell so it works from every page.
 * "Keep streaming" has focus on open and Escape keeps streaming; only the
 * destructive button ends the livestream.
 */
export function EndLivestreamDialog({
  confirmation,
  onCancel,
  onConfirm
}: {
  confirmation: SessionStopConfirmation | null
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  return (
    <ConfirmDialog
      cancelLabel={KEEP_STREAMING_LABEL}
      confirmLabel={END_LIVESTREAM_LABEL}
      description={confirmation ? endLivestreamBody(confirmation) : null}
      open={confirmation !== null}
      testId="end-livestream"
      title={END_LIVESTREAM_TITLE}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
