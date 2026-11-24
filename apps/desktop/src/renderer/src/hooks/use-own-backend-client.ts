import { useEffect, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'

/**
 * A backend client of its own while `enabled` and the Studio is connected;
 * null otherwise, and until it has connected. A page that asks the backend
 * for something of its own (the Buddy tab's look panel, the Captions page's
 * preview drawing) opens one while it is mounted, so the shell carries
 * nothing for it.
 */
export function useOwnBackendClient(enabled = true): BackendClient | null {
  const { connection, wsStatus } = useStudioCore()
  const online = enabled && wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    next.connect().then(
      () => {
        if (!disposed) setClient(next)
      },
      () => undefined
    )
    return () => {
      disposed = true
      next.close()
      setClient(null)
    }
  }, [online])
  return client
}
