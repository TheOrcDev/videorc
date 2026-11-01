import type { LockAlertAction } from '@/components/lock-alert'

import type { EntitlementUiGate } from './entitlement-ui'
import { isPremiumUpgradeMessage, VIDEORC_PREMIUM_URL } from './premium-upgrade'
import { beginVideorcSignIn, openVideorcWebLink } from './videorc-web-links'

/**
 * Why a set of controls is off, and the one thing that turns them back on
 * (plan 174 S1.5, D-13 and J2-9). Locked means disabled with one reason
 * (videorc-design): a lock is never hidden, it says why in one line and
 * offers at most one action. `components/lock-alert.tsx` (@videorc) draws
 * these; the one session and offline wording is `lib/lock-reason.ts`.
 */

/** What unlocks a locked feature: its one action. */
export type UnlockAction = { kind: 'sign-in' } | { kind: 'view-premium'; url: string }

/**
 * The LockAlert's action for an unlock: sign-in starts Videorc's sign-in,
 * and View Premium opens the page in the system browser.
 */
export function lockAlertAction(action: UnlockAction | null): LockAlertAction | null {
  if (!action) return null
  if (action.kind === 'sign-in') return { kind: 'sign-in', onClick: beginVideorcSignIn }
  return { kind: 'view-premium', url: action.url, onClick: openVideorcWebLink }
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
