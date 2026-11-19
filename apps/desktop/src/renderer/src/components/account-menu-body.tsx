import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'

import {
  AccountIcon,
  HealthIcon,
  SettingsIcon,
  SignInIcon,
  SignOutIcon,
  SparkleIcon
} from '@/components/icons'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { accountDisplayName, isSignedIn, type VideorcAccount } from '@/lib/account'
import { AvatarCircle } from '@/lib/chat-avatar'
import { VIDEORC_WEB_LINKS, openVideorcWebLink } from '@/lib/videorc-web-links'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { ACCOUNT_MENU_TRIGGER_CLASS, AccountMenuTriggerContent } from './account-menu-trigger'

/** Which row a keyboard open lands on, as Base UI's own trigger would. */
export type AccountMenuInitialFocus = 'first' | 'last' | null

export type AccountMenuBodyProps = {
  account: VideorcAccount
  tierLabel: string
  needsSignIn: boolean
  statusTone: StatusDotTone
  statusLabel: string
  statusPulse: boolean
  signOutLocked: boolean
  /** True when the click that asked for the menu already happened. */
  initiallyOpen: boolean
  /** A keyboard open puts focus on a row; a pointer open leaves it on the popup. */
  initialFocus: AccountMenuInitialFocus
  /** The real trigger, so the eager parent can hand it focus after the swap. */
  triggerRef: RefObject<HTMLButtonElement | null>
  onSignIn: () => void
  onOpenAccount: () => void
  onSignOut: () => void
  onOpenHealth: () => void
  onOpenSettings: () => void
}

// The account menu's implementation: the Base UI menu, its trigger and its
// rows. This module is a lazy chunk (PERF-03): `account-menu.tsx` fetches it on
// the first hover, focus or click and nothing about the closed menu pulls the
// menu package into startup.
export function AccountMenuBody({
  account,
  tierLabel,
  needsSignIn,
  statusTone,
  statusLabel,
  statusPulse,
  signOutLocked,
  initiallyOpen,
  initialFocus,
  triggerRef,
  onSignIn,
  onOpenAccount,
  onSignOut,
  onOpenHealth,
  onOpenSettings
}: AccountMenuBodyProps): ReactElement {
  const signedIn = isSignedIn(account)
  const displayName = accountDisplayName(account)
  const [open, setOpen] = useState(initiallyOpen)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Base UI focuses a row when its own trigger is opened from the keyboard.
  // The first open arrives as state, not as that interaction, so the popup
  // would take focus alone: put focus on the row the key asked for. Focus
  // that is already inside the popup is left where it is by Base UI.
  useEffect(() => {
    if (!initiallyOpen || initialFocus === null) {
      return
    }
    let frame = 0
    let tries = 0
    const focusRow = (): void => {
      const rows = contentRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      )
      if (rows && rows.length > 0) {
        rows[initialFocus === 'first' ? 0 : rows.length - 1]?.focus()
        return
      }
      tries += 1
      if (tries < 30) {
        frame = requestAnimationFrame(focusRow)
      }
    }
    frame = requestAnimationFrame(focusRow)
    return () => cancelAnimationFrame(frame)
  }, [initiallyOpen, initialFocus])

  // FX5: workspace navigation arrives via main-process IPC (⌘1–9) or the
  // custom navigate event — neither is a DOM interaction the menu can see, so
  // the uncontrolled menu floated over the next tab. Close on any navigation
  // signal, and on Escape regardless of where focus sits.
  useEffect(() => {
    if (!open) {
      return
    }
    const close = (): void => setOpen(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, close)
    const offShortcut = window.videorc?.onShortcutNavigate?.(close)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, close)
      offShortcut?.()
    }
  }, [open])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* Named by what it shows, "Sign in" or the account's name (plan 174
          S0.5, A-21): an aria-label hid the words a voice user would say, and
          the trigger already announces its menu. */}
      <DropdownMenuTrigger
        render={<button ref={triggerRef} type="button" className={ACCOUNT_MENU_TRIGGER_CLASS} />}
      >
        <AccountMenuTriggerContent account={account} needsSignIn={needsSignIn} />
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={contentRef} align="start" side="top" className="w-56">
        <DropdownMenuLabel className="flex items-center justify-between gap-2 py-1.5">
          <span className="flex min-w-0 items-center gap-2">
            {account.status === 'signed-in' ? (
              <AvatarCircle avatarUrl={account.avatarUrl} name={displayName} />
            ) : null}
            <span className="truncate text-sm font-medium text-foreground">
              {signedIn ? displayName : 'Not signed in'}
            </span>
          </span>
          <Badge variant="outline">{tierLabel}</Badge>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {signedIn ? (
          <DropdownMenuItem onClick={onOpenAccount}>
            <AccountIcon />
            Account
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={onSignIn}>
            <SignInIcon />
            Sign in
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => openVideorcWebLink(VIDEORC_WEB_LINKS.premium)}>
          <SparkleIcon />
          View Premium
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={onOpenHealth}>
          <HealthIcon />
          Health
          <span className="ml-auto">
            <StatusDot tone={statusTone} label={statusLabel} pulse={statusPulse} />
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenSettings}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>

        {signedIn ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signOutLocked} variant="destructive" onClick={onSignOut}>
              <SignOutIcon />
              Sign out
            </DropdownMenuItem>
            {/* Locked means disabled, with one reason (A-21): a menu skips a
                disabled item, so the reason is text under it, not a tooltip. */}
            {signOutLocked ? (
              <DropdownMenuLabel>
                Sign out is locked while you're recording or live.
              </DropdownMenuLabel>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
