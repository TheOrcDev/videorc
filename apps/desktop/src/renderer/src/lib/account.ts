import type { EntitlementTier, VideorcAccountSnapshot } from './backend'

// The Videorc PRODUCT account — not a YouTube/Twitch/X platform account. Real
// desktop web auth + token storage are out of scope for the first UI slice, so
// the app is signed-out-safe and never fabricates a username or shows "Guest".
export type VideorcAccount =
  | { status: 'signed-out' }
  | {
      status: 'signed-in'
      username: string
      displayName?: string | null
      email?: string | null
      /** Account avatar URL (web-uploaded or Google), when the user has one. */
      avatarUrl?: string | null
    }

export const SIGNED_OUT_ACCOUNT: VideorcAccount = { status: 'signed-out' }

export function isSignedIn(account: VideorcAccount): boolean {
  return account.status === 'signed-in'
}

// Map the backend account snapshot (account.get) to the renderer account model.
// Anything that isn't a fully-formed signed-in record — null, signed-out, or a
// signed-in snapshot missing its username — is treated as signed-out, so the UI
// never shows a half-populated account.
export function accountFromSnapshot(
  snapshot: VideorcAccountSnapshot | null | undefined
): VideorcAccount {
  if (!snapshot || snapshot.status !== 'signed-in' || !snapshot.username) {
    return SIGNED_OUT_ACCOUNT
  }
  return {
    status: 'signed-in',
    username: snapshot.username,
    displayName: snapshot.displayName ?? null,
    email: snapshot.email ?? null,
    avatarUrl: snapshot.avatarUrl ?? null
  }
}

// Footer trigger label. Signed-out shows the call to action ("Sign in"), never a
// fake name or "Guest"; signed-in prefers the display name and falls back to the
// username.
export function accountDisplayName(account: VideorcAccount): string {
  if (account.status === 'signed-out') {
    return 'Sign in'
  }
  const displayName = account.displayName?.trim()
  return displayName && displayName.length > 0 ? displayName : account.username
}

// Local entitlement tier shown as metadata. It reflects the device's plan, not
// sign-in state, so it is safe to show while signed out.
export function entitlementTierLabel(tier: EntitlementTier | null | undefined): string {
  switch (tier) {
    case 'premium':
      return 'Premium'
    case 'developer':
      return 'Developer'
    case 'basic':
    default:
      return 'Basic'
  }
}

export type AccountMenuItem =
  'account' | 'sign-in' | 'sign-out' | 'view-premium' | 'health' | 'settings'

// Product-account menu rows in order. No platform (YouTube/Twitch/X) accounts
// ever appear here — this is the single Videorc product account.
export function accountMenuItems(account: VideorcAccount): AccountMenuItem[] {
  const auth: AccountMenuItem[] =
    account.status === 'signed-in' ? ['account', 'sign-out'] : ['sign-in']
  return [...auth, 'view-premium', 'health', 'settings']
}

// Sign out is blocked while a session is live (decision: once real sign-out
// exists). Signed-out has nothing to disable.
export function isSignOutDisabled(account: VideorcAccount, live: boolean): boolean {
  return isSignedIn(account) && live
}
