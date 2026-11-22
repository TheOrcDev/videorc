import { useEffect, useMemo, useState } from 'react'

import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { LinuxDesktopCheck, RuntimeInfo } from '@/lib/backend'
import { linuxDesktopCheckSettled, type LinuxDesktopInput } from '@/lib/linux-desktop-check'

/**
 * A settled answer per backend connection, shared by Health and Destinations,
 * so a row never flips between visits. An inconclusive one (the bus or the
 * portal did not answer in time) is asked again on the next visit.
 */
const settledAnswers = new WeakMap<object, LinuxDesktopCheck>()

/**
 * Linux only (plan 257 S18): the keyring from RuntimeInfo plus the backend's
 * `diagnostics.linuxDesktop` answer, asked once per backend connection while
 * Health or Destinations is open. The fixes it points to need a restart or a
 * new login, so it never polls. Elsewhere it stays empty and asks nothing.
 */
export function useLinuxDesktopCheck(runtimeInfo: RuntimeInfo | null): LinuxDesktopInput {
  const { client } = useStudioDiagnostics()
  const linux = runtimeInfo?.platform === 'linux'
  const [desktop, setDesktop] = useState<LinuxDesktopCheck | null>(null)

  useEffect(() => {
    if (!linux || !client) return undefined
    const settled = settledAnswers.get(client)
    if (settled) {
      setDesktop(settled)
      return undefined
    }
    let disposed = false
    client
      .requestTyped('diagnostics.linuxDesktop')
      .then((answer) => {
        if (linuxDesktopCheckSettled(answer)) settledAnswers.set(client, answer)
        if (!disposed) setDesktop(answer)
      })
      .catch((error: unknown) => {
        // Health keeps the keyring row from RuntimeInfo; the rest waits for a
        // reconnect. Never a toast: nothing here is the streamer's action.
        console.warn('[linux-desktop] check failed', error)
      })
    return () => {
      disposed = true
    }
  }, [client, linux])

  const keyring = runtimeInfo?.linuxKeyring ?? null
  // One object per change, so Health's memoized checks don't rerun every render.
  return useMemo(() => (linux ? { keyring, desktop } : {}), [linux, keyring, desktop])
}
