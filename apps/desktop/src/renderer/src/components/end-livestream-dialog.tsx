import type { ReactElement } from 'react'

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
import { useStudioCloud } from '@/hooks/use-studio'
import { handOffLabel, handOffQuestionBody, offersHandOff } from '@/lib/cloud-handoff-view'
import {
  KEEP_STREAMING_LABEL,
  endLivestreamBody,
  endLivestreamConfirmLabel,
  endLivestreamTitle,
  type SessionStopConfirmation
} from '@/lib/session-stop'

export type { SessionStopConfirmation }

/**
 * "End livestream?" (plan 174 S0.1, D2): the one question every in-app stop
 * path asks while live. Hosted by the shell so it works from every page.
 * "Keep streaming" has focus on open and Escape keeps streaming; only the
 * destructive button ends the livestream. When the app is leaving (⌘Q, ⌘W;
 * plan 174 S3.1) the title and the button say so: "End livestream and quit?".
 *
 * Plan 243 C5: on a managed cloud show this computer is on air for, a third
 * answer keeps the show live for another device ("Continue on another
 * device", or "Quit and keep it live" when the app is leaving). No close
 * button: the answers are the only way out.
 */
export function EndLivestreamDialog({
  confirmation,
  onCancel,
  onConfirm,
  onHandOff
}: {
  confirmation: SessionStopConfirmation | null
  onCancel: () => void
  onConfirm: () => void
  onHandOff?: () => void
}): ReactElement {
  const { cloudStatus } = useStudioCloud()
  const origin = confirmation?.origin ?? 'button'
  const handOff = Boolean(confirmation && onHandOff && offersHandOff(cloudStatus))
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
      open={confirmation !== null}
    >
      {/* Three answers need the wider sheet to stay on one row. */}
      <AlertDialogContent data-testid="end-livestream-dialog" size={handOff ? 'lg' : 'md'}>
        <AlertDialogHeader>
          <AlertDialogTitle>{endLivestreamTitle(origin)}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation
              ? handOff
                ? handOffQuestionBody(confirmation)
                : endLivestreamBody(confirmation)
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="end-livestream-cancel">
            {KEEP_STREAMING_LABEL}
          </AlertDialogCancel>
          {/* The actions don't close the dialog: the owner drops the question. */}
          {handOff ? (
            <AlertDialogAction
              data-testid="end-livestream-hand-off"
              variant="secondary"
              onClick={() => onHandOff?.()}
            >
              {handOffLabel(origin)}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction
            data-testid="end-livestream-confirm"
            variant="destructive"
            onClick={() => onConfirm()}
          >
            {endLivestreamConfirmLabel(origin)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
