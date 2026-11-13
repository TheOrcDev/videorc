import { useCallback, useEffect, useMemo, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { CommunitySummary } from '@/lib/backend'
import type { CommunityCall } from '../../../shared/community-relay'

export interface CommunityClientState {
  /** One typed `cohost.community.*` call; rejects while offline. */
  call: CommunityCall
  /** The header's numbers, kept fresh by `cohost.community.changed`. */
  summary: CommunitySummary | null
  /** Bumped by every `cohost.community.changed`: lists ask again. */
  revision: number
  /** Connected to Videorc's engine. */
  ready: boolean
  offline: boolean
  /** Ask the lists to read again after this tab changed something. */
  bump: () => void
}

/**
 * Buddy → Community's backend (plan 225 D12). Like the stream report, the
 * tab opens its own client while it is mounted, so nothing of it rides in
 * the main window's startup bundle or its provider. It follows the studio's
 * connection, and `cohost.community.changed` refreshes the summary and asks
 * the lists to read again.
 */
export function useCommunityClient(): CommunityClientState {
  const { connection, wsStatus } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  const [summary, setSummary] = useState<CommunitySummary | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    const offChanged = next.on('cohost.community.changed', (payload) => {
      if (disposed) return
      setSummary(payload)
      setRevision((value) => value + 1)
    })
    next.connect().then(
      () => {
        if (disposed) return
        setClient(next)
        next.requestTyped('cohost.community.summary').then(
          (value) => {
            if (!disposed) setSummary(value)
          },
          () => undefined
        )
      },
      () => undefined
    )
    return () => {
      disposed = true
      offChanged()
      next.close()
      setClient(null)
    }
  }, [online])

  const call = useCallback<CommunityCall>(
    (method, params) => {
      if (!client) return Promise.reject(new Error('Videorc is reconnecting.'))
      return client.requestTyped(method, params as never) as never
    },
    [client]
  )
  const bump = useCallback(() => setRevision((value) => value + 1), [])
  return useMemo(
    () => ({ call, summary, revision, ready: client !== null, offline: online === null, bump }),
    [bump, call, client, online, revision, summary]
  )
}
