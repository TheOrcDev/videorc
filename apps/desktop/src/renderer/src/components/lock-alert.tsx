import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  OFFLINE_LOCK_REASON,
  sessionLockReason,
  unlockActionLabel,
  type UnlockAction
} from '@/lib/lock-view'
import { beginVideorcSignIn, openVideorcWebLink } from '@/lib/videorc-web-links'

type LockAlertProps = Omit<ComponentProps<typeof Alert>, 'variant' | 'icon' | 'children'>

function runUnlockAction(action: UnlockAction): void {
  if (action.kind === 'sign-in') beginVideorcSignIn()
  else openVideorcWebLink(action.url)
}

/**
 * Why the controls under it are off (plan 174 S1.5, D-13): a lock, the reason
 * as its one line, and at most one action ("Sign in", "View Premium"). It
 * leads the tab or section it locks, and everything under it is disabled.
 * A Premium feature stays on screen behind this lock, never hidden: the
 * locked page is what sells it (owner call 2026-10-10).
 */
export function LockAlert({
  reason,
  action = null,
  ...props
}: LockAlertProps & {
  reason: ReactNode
  action?: UnlockAction | null
}): ReactElement {
  return (
    <Alert variant="locked" {...props}>
      <AlertTitle>{reason}</AlertTitle>
      {action ? (
        <AlertAction>
          <Button size="xs" type="button" variant="outline" onClick={() => runUnlockAction(action)}>
            {unlockActionLabel(action)}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  )
}

/**
 * The one notice for controls a running recording or livestream locks (J2-9).
 * `locks` names what it locks, as a plural subject ("Destinations and stream
 * details"), when the page holds more than one kind of control.
 */
export function SessionLockAlert({
  locks,
  ...props
}: LockAlertProps & { locks?: string }): ReactElement {
  return <LockAlert reason={sessionLockReason(locks)} {...props} />
}

/** The one notice for controls that wait for the backend to reconnect. */
export function OfflineAlert(props: LockAlertProps): ReactElement {
  return <LockAlert reason={OFFLINE_LOCK_REASON} {...props} />
}
