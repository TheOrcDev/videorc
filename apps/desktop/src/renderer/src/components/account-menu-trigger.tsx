import type { ReactElement } from 'react'

import { AccountIcon } from '@/components/icons'
import { StatusDot } from '@/components/status-dot'
import { AvatarCircle } from '@/lib/chat-avatar'
import { accountDisplayName, type VideorcAccount } from '@/lib/account'

// The account menu's trigger, shared by the eager button that waits for the
// first open and the Base UI trigger inside the lazy menu (PERF-03): both draw
// the same pixels, so the swap on first open is invisible.
export const ACCOUNT_MENU_TRIGGER_CLASS =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-row px-1.5 text-sm transition-colors hover:bg-sidebar-accent/60'

export function AccountMenuTriggerContent({
  account,
  needsSignIn
}: {
  account: VideorcAccount
  /** Chat or Buddy waits on the Videorc sign-in (plan 215 A5, D7). */
  needsSignIn: boolean
}): ReactElement {
  const displayName = accountDisplayName(account)
  return (
    <>
      {/* The web account's avatar (uploaded on videorc.com or the Google
          photo) through main's allowlisted cache; a signed-in account
          without one gets initials — a face beats a generic glyph. 20 px,
          so the initials keep the 11 px floor (A-21). */}
      {account.status === 'signed-in' ? (
        <AvatarCircle avatarUrl={account.avatarUrl} className="size-5" name={displayName} />
      ) : (
        <AccountIcon className="size-4 shrink-0 text-muted-foreground" weight="regular" />
      )}
      <span className="truncate text-xs font-medium">{displayName}</span>
      {/* Plan 215 A5 (D7): a dot while chat or Buddy waits on the sign-in.
          Bare, so the trigger's name stays the words it shows; the Go Live
          check, the toast and the chat row carry the sentence. */}
      {needsSignIn ? (
        <span data-slot="account-needs-sign-in">
          <StatusDot tone="warn" />
        </span>
      ) : null}
    </>
  )
}
