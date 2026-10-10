import { useRef, type ReactElement } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
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
  // Radix closes the dialog on both buttons; only a close that was not the
  // confirm counts as keeping the stream.
  const confirmedRef = useRef(false)
  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (open) return
        const confirmed = confirmedRef.current
        confirmedRef.current = false
        if (!confirmed) onCancel()
      }}
    >
      <AlertDialogContent data-testid="end-livestream-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{END_LIVESTREAM_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation ? endLivestreamBody(confirmation) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="end-livestream-keep">
            {KEEP_STREAMING_LABEL}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="end-livestream-confirm"
            variant="destructive"
            onClick={() => {
              confirmedRef.current = true
              onConfirm()
            }}
          >
            {END_LIVESTREAM_LABEL}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
