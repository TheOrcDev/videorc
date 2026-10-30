import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'

/**
 * What unlocks a locked feature: its one action. Your app resolves it (is
 * this a Premium gate? is anyone signed in?) and says how to run it.
 * - `sign-in` runs `onClick`: start your app's sign-in.
 * - `view-premium` opens `url`. With `onClick` it calls that instead (an
 *   Electron app hands the link to the system browser); without one the
 *   button is a link that opens in a new tab.
 */
type LockAlertAction =
  | { kind: 'sign-in'; label?: string; onClick: () => void }
  | {
      kind: 'view-premium'
      url: string
      label?: string
      onClick?: (url: string) => void
    }

type LockAlertProps = Omit<ComponentProps<typeof Alert>, 'variant' | 'icon' | 'children'>

/** The one wording for controls a running recording or livestream locks. */
const SESSION_LOCK_REASON =
  "Locked while you're recording or live. Changes apply the next time you record or go live."

/** The one wording for controls that wait for the app to reconnect. */
const OFFLINE_LOCK_REASON = 'Videorc is reconnecting. These controls come back in a moment.'

/**
 * The session lock that names what it locks: "Destinations and stream
 * details are locked while you're recording or live. …". Without `locks` it
 * is the plain SESSION_LOCK_REASON.
 */
function sessionLockReason(locks?: string): string {
  if (!locks) {
    return SESSION_LOCK_REASON
  }
  return `${locks} are locked while you're recording or live. Changes apply the next time you record or go live.`
}

/** The action's words: "Sign in" or "View Premium", unless it brings its own. */
function unlockActionLabel(action: LockAlertAction): string {
  if (action.label) {
    return action.label
  }
  return action.kind === 'sign-in' ? 'Sign in' : 'View Premium'
}

function LockAlertButton({ action }: { action: LockAlertAction }): ReactElement {
  const label = unlockActionLabel(action)
  if (action.kind === 'view-premium' && !action.onClick) {
    // A real link, styled as the button: Base UI's Button would give it
    // role="button" and hide that it navigates.
    return (
      <a
        className={buttonVariants({ size: 'xs', variant: 'outline' })}
        data-slot="button"
        href={action.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {label}
      </a>
    )
  }
  const handleClick = (): void => {
    if (action.kind === 'sign-in') {
      action.onClick()
    } else {
      action.onClick?.(action.url)
    }
  }
  return (
    <Button onClick={handleClick} size="xs" type="button" variant="outline">
      {label}
    </Button>
  )
}

/**
 * Why the controls under it are off: a lock, the reason as its one line, and
 * at most one action ("Sign in", "View Premium"). It leads the tab or section
 * it locks, and everything under it is disabled. A Premium feature stays on
 * screen behind this lock, never hidden: the locked page is what sells it.
 */
function LockAlert({
  reason,
  action = null,
  ...props
}: LockAlertProps & {
  /** One line: "Live captions are part of Videorc Premium." */
  reason: ReactNode
  action?: LockAlertAction | null
}): ReactElement {
  return (
    <Alert variant="locked" {...props}>
      <AlertTitle>{reason}</AlertTitle>
      {action ? (
        <AlertAction>
          <LockAlertButton action={action} />
        </AlertAction>
      ) : null}
    </Alert>
  )
}

/**
 * The one notice for controls a running recording or livestream locks.
 * `locks` names what it locks, as a plural subject ("Destinations and stream
 * details"), when the page holds more than one kind of control.
 */
function SessionLockAlert({
  locks,
  reason,
  ...props
}: LockAlertProps & {
  locks?: string
  /** Replaces the wording. */
  reason?: ReactNode
}): ReactElement {
  return <LockAlert reason={reason ?? sessionLockReason(locks)} {...props} />
}

/** The one notice for controls that wait for the app to reconnect. */
function OfflineAlert({
  reason = OFFLINE_LOCK_REASON,
  ...props
}: LockAlertProps & {
  /** Replaces the wording. */
  reason?: ReactNode
}): ReactElement {
  return <LockAlert reason={reason} {...props} />
}

export {
  LockAlert,
  OFFLINE_LOCK_REASON,
  OfflineAlert,
  SESSION_LOCK_REASON,
  SessionLockAlert,
  sessionLockReason,
  unlockActionLabel
}
export type { LockAlertAction, LockAlertProps }
