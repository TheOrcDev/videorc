import { GearSix, Pulse, SignIn, SignOut, Sparkle, UserCircle } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useVideorcAccount } from '@/hooks/use-account'
import {
  accountDisplayName,
  entitlementTierLabel,
  isSignOutDisabled,
  isSignedIn
} from '@/lib/account'
import type { EntitlementTier } from '@/lib/backend'
import { VIDEORC_WEB_LINKS, openVideorcWebLink } from '@/lib/videorc-web-links'

// The Videorc product-account control that replaces the bottom-left "connected"
// status dot. Signed-out shows "Sign in" and links out to the web; backend
// status stays as secondary metadata (a small dot on the trigger + the Health
// row). No platform accounts appear here, and no username is fabricated.
export function AccountMenu({
  tier,
  statusTone,
  statusLabel,
  live,
  onOpenHealth,
  onOpenSettings
}: {
  tier: EntitlementTier | null
  statusTone: StatusDotTone
  statusLabel: string
  live: boolean
  onOpenHealth: () => void
  onOpenSettings: () => void
}): ReactElement {
  const { account, signIn, openAccount, signOut } = useVideorcAccount()
  const signedIn = isSignedIn(account)
  const displayName = accountDisplayName(account)
  const tierLabel = entitlementTierLabel(tier)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Videorc account"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-sidebar-accent/60"
        >
          <UserCircle
            className="size-4 shrink-0 text-muted-foreground"
            weight={signedIn ? 'fill' : 'regular'}
          />
          <span className="truncate text-xs font-medium">{displayName}</span>
          {/* Secondary backend status: a small dot only — the label lives in the
              menu so changing connection states never resize/jitter the footer. */}
          <StatusDot tone={statusTone} pulse={live} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel className="flex items-center justify-between gap-2 py-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {signedIn ? displayName : 'Not signed in'}
          </span>
          <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tierLabel}
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {signedIn ? (
          <>
            <DropdownMenuItem onSelect={openAccount}>
              <UserCircle />
              Account
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isSignOutDisabled(account, live)}
              variant="destructive"
              onSelect={signOut}
            >
              <SignOut />
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={signIn}>
            <SignIn />
            Sign in
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => openVideorcWebLink(VIDEORC_WEB_LINKS.premium)}>
          <Sparkle />
          View Premium
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={onOpenHealth}>
          <Pulse />
          Health
          <span className="ml-auto">
            <StatusDot tone={statusTone} label={statusLabel} pulse={live} />
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenSettings}>
          <GearSix />
          Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
