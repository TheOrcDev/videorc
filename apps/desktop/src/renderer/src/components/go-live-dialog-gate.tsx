import { lazy, Suspense, useRef, type ReactElement } from 'react'

import { useStudioCore } from '@/hooks/use-studio'

const GoLiveDialogHost = lazy(async () => ({
  default: (await import('@/components/go-live-dialog-host')).GoLiveDialogHost
}))

/**
 * The Go Live confirmation, hosted by the shell outside the page switch so it
 * opens over whatever page is showing (plan 174 S0.6, B-5 and A-3). It used to
 * live in Studio: a start from another page, ⌘K, a hotkey or the phone showed
 * nothing until Studio opened, and then with a stale preflight.
 *
 * The dialog's chunk loads when Go Live is first asked for, while the
 * preflight runs, and stays mounted after that, so the dialog closes with its
 * animation and reopens at once.
 */
export function GoLiveDialogGate(): ReactElement | null {
  const { goLiveConfirmationOpen, goLiveConfirmationPending } = useStudioCore()
  const mountedRef = useRef(false)
  if (goLiveConfirmationOpen || goLiveConfirmationPending) {
    mountedRef.current = true
  }
  return mountedRef.current ? (
    <Suspense fallback={null}>
      <GoLiveDialogHost />
    </Suspense>
  ) : null
}
