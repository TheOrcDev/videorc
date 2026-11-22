import { useEffect, useMemo, useState } from 'react'

import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { LinuxDesktopCheck, RuntimeInfo } from '@/lib/backend'
import type { LinuxDesktopInput } from '@/lib/linux-desktop-check'

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
    let disposed = false
    client
      .requestTyped('diagnostics.linuxDesktop')
      .then((answer) => {
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
