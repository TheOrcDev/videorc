import type { EntitlementUiGate } from './entitlement-ui'
import { isPremiumUpgradeMessage, VIDEORC_PREMIUM_URL } from './premium-upgrade'

/**
 * Why a set of controls is off, and the one thing that turns them back on
 * (plan 174 S1.5, D-13 and J2-9). Locked means disabled with one reason
 * (videorc-design): a lock is never hidden, it says why in one line and
 * offers at most one action. `components/lock-alert.tsx` draws these.
 */

/** What unlocks a locked feature: its one action. */
export type UnlockAction = { kind: 'sign-in' } | { kind: 'view-premium'; url: string }

/** The one wording for controls a running recording or livestream locks. */
export const SESSION_LOCK_REASON =
  "Locked while you're recording or live. Changes apply the next time you record or go live."

/**
 * The session lock that names what it locks (plan 174 S3.5a, D-15): "Destinations
 * and stream details are locked while you're recording or live. …". Without
 * `locks` it is the plain SESSION_LOCK_REASON.
 */
export function sessionLockReason(locks?: string): string {
  if (!locks) return SESSION_LOCK_REASON
  return `${locks} are locked while you're recording or live. Changes apply the next time you record or go live.`
}

/** The one wording for controls that wait for the backend to come back. */
export const OFFLINE_LOCK_REASON = 'Videorc is reconnecting. These controls come back in a moment.'

export function unlockActionLabel(action: UnlockAction): string {
  return action.kind === 'sign-in' ? 'Sign in' : 'View Premium'
}

/**
 * A gate's action: "View Premium" only when the gate is a Premium gate (it
 * carries the upgrade link). A pipeline limit or a disabled feature locks
 * with its reason alone, never a Premium prompt.
 */
export function unlockActionForGate(gate: EntitlementUiGate): UnlockAction | null {
  if (gate.allowed || !gate.upgradeUrl) return null
  return { kind: 'view-premium', url: gate.upgradeUrl }
}

/**
 * A bare reason's action, by the same rule `lockedGate` uses: a reason that
 * names Premium unlocks with "View Premium", anything else locks alone.
 */
export function unlockActionForReason(reason: string | null | undefined): UnlockAction | null {
  return isPremiumUpgradeMessage(reason) ? { kind: 'view-premium', url: VIDEORC_PREMIUM_URL } : null
}
