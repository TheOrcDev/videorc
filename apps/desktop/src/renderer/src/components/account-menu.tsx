import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'

import { type StatusDotTone } from '@/components/status-dot'
import { useVideorcAccount } from '@/hooks/use-account'
import { entitlementTierLabel, isSignOutDisabled } from '@/lib/account'
import type { EntitlementPlan, EntitlementTier } from '@/lib/backend'
import { toast } from '@/lib/toast'

import type { AccountMenuBodyProps, AccountMenuInitialFocus } from './account-menu-body'
import { ACCOUNT_MENU_TRIGGER_CLASS, AccountMenuTriggerContent } from './account-menu-trigger'

type AccountMenuBodyComponent = (props: AccountMenuBodyProps) => ReactElement

// PERF-03: the menu implementation (Base UI menu + the product dropdown) is
// a separate chunk, fetched when the user shows intent (hover, focus, press) or
// asks to open it. It is never a mounted `lazy()` child: that would fetch the
// chunk at startup and only hide the cost from the budget.
let loadedBody: AccountMenuBodyComponent | null = null
let bodyLoad: Promise<AccountMenuBodyComponent> | null = null

export function loadAccountMenuBody(): Promise<AccountMenuBodyComponent> {
  if (loadedBody) {
    return Promise.resolve(loadedBody)
  }
  bodyLoad ??= import('./account-menu-body').then(
    (module) => {
      loadedBody = module.AccountMenuBody
      return loadedBody
    },
    (error: unknown) => {
      // A failed fetch must not stay cached: the next intent retries it.
      bodyLoad = null
      throw error
    }
  )
  return bodyLoad
}

// The Videorc product-account control that replaces the bottom-left "connected"
// status dot. Signed-out shows "Sign in" and links out to the web. Backend
// status lives in the status bar's state button, Health's door (D9), and in
// the menu's Health row; the trigger carries no dot, so its name stays the
// words it shows (A-21). No platform accounts appear here, and no username is
// fabricated.
//
// Until the first open this renders only a button that looks and announces
// like the menu trigger. The first open swaps in the lazy menu already open.
export function AccountMenu({
  plan = null,
  tier,
  statusTone,
  statusLabel,
  statusPulse,
  live,
  needsSignIn = false,
  onOpenHealth,
  onOpenSettings
}: {
  /** `max` labels the account Max (plan 185 T4). */
  plan?: EntitlementPlan | null
  tier: EntitlementTier | null
  statusTone: StatusDotTone
  statusLabel: string
  statusPulse: boolean
  live: boolean
  /** Chat or Buddy waits on the Videorc sign-in (plan 215 A5, D7): a dot on
   * the trigger, because "Sign in" alone was easy to miss while live. */
  needsSignIn?: boolean
  onOpenHealth: () => void
  onOpenSettings: () => void
}): ReactElement {
  const { account, signIn, openAccount, signOut } = useVideorcAccount()
  const [Body, setBody] = useState<AccountMenuBodyComponent | null>(() => loadedBody)
  const [openRequested, setOpenRequested] = useState(false)
  // A mouse over the button swaps the real trigger in (closed) as soon as the
  // chunk is warm, so the press that follows is the Base UI trigger's own and
  // opens exactly as it did when the menu was eager.
  const [hovered, setHovered] = useState(false)
  // Never swap the node under a mouse press that is already in flight: the
  // release would land on the new button and the click would reach neither.
  const [pressing, setPressing] = useState(false)
  const mounted = useRef(true)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const initialFocus = useRef<AccountMenuInitialFocus>(null)
  const staticHadFocus = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Warm the chunk on intent. A failure here is silent: the open request
  // below retries and reports it.
  const warm = useCallback((): void => {
    void loadAccountMenuBody().then(
      (body) => {
        if (mounted.current) {
          setBody(() => body)
        }
      },
      () => undefined
    )
  }, [])

  const requestOpen = useCallback((focus: AccountMenuInitialFocus): void => {
    initialFocus.current = focus
    setOpenRequested(true)
    loadAccountMenuBody().then(
      (body) => {
        if (mounted.current) {
          setBody(() => body)
        }
      },
      (error: unknown) => {
        console.error('Videorc account menu failed to load', error)
        if (mounted.current) {
          setOpenRequested(false)
          toast.error("Couldn't open the account menu", { description: 'Try again.' })
        }
      }
    )
  }, [])

  // React 19 runs a ref's cleanup as the node leaves, while it still holds
  // focus: that is when to learn whether the swap takes the user's place.
  const trackFocusOnDetach = useCallback((node: HTMLButtonElement | null): (() => void) | void => {
    if (node) {
      return () => {
        staticHadFocus.current = document.activeElement === node
      }
    }
  }, [])

  const swapped = Body !== null && (openRequested || (hovered && !pressing))
  // Swapping the button for the real trigger replaces the DOM node: a keyboard
  // user whose focus sat on it keeps their place. An open menu takes focus
  // itself, so only a swap that leaves the menu closed restores it.
  useLayoutEffect(() => {
    if (swapped && staticHadFocus.current && !openRequested) {
      triggerRef.current?.focus()
    }
    staticHadFocus.current = false
  }, [swapped, openRequested])

  if (Body && swapped) {
    return (
      <Body
        account={account}
        tierLabel={entitlementTierLabel(tier, plan)}
        needsSignIn={needsSignIn}
        statusTone={statusTone}
        statusLabel={statusLabel}
        statusPulse={statusPulse}
        signOutLocked={isSignOutDisabled(account, live)}
        initiallyOpen={openRequested}
        initialFocus={initialFocus.current}
        triggerRef={triggerRef}
        onSignIn={signIn}
        onOpenAccount={openAccount}
        onSignOut={signOut}
        onOpenHealth={onOpenHealth}
        onOpenSettings={onOpenSettings}
      />
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // The menu trigger also opens on the arrow keys.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      requestOpen(event.key === 'ArrowUp' ? 'last' : 'first')
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    warm()
    if (event.pointerType !== 'mouse') {
      return
    }
    setPressing(true)
    const release = (): void => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      // After the click that follows the release has been dispatched.
      setTimeout(() => setPressing(false), 0)
    }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
  }

  const onPointerEnter = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    warm()
    if (event.pointerType === 'mouse') {
      setHovered(true)
    }
  }

  return (
    // Named by what it shows, "Sign in" or the account's name (plan 174
    // S0.5, A-21): an aria-label hid the words a voice user would say, and
    // the trigger already announces its menu.
    <button
      type="button"
      data-slot="dropdown-menu-trigger"
      className={ACCOUNT_MENU_TRIGGER_CLASS}
      aria-haspopup="menu"
      aria-expanded={false}
      aria-busy={openRequested || undefined}
      ref={trackFocusOnDetach}
      onPointerEnter={onPointerEnter}
      onFocus={warm}
      onPointerDown={onPointerDown}
      onClick={(event) => requestOpen(event.detail === 0 ? 'first' : null)}
      onKeyDown={onKeyDown}
    >
      <AccountMenuTriggerContent account={account} needsSignIn={needsSignIn} />
    </button>
  )
}
