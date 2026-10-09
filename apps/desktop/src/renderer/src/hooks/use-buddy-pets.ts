import { useCallback, useEffect, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { BuddyPetSummary } from '@/lib/backend'

/** The persona's pet packs as the Golem tab sees them (plan 168 S-D2). */
export interface BuddyPets {
  /** Null until the first list arrives (offline, or still asking). */
  packs: BuddyPetSummary[] | null
  /** Why the list could not be read, in the backend's words. */
  error: string | null
  refresh: () => Promise<void>
  /** `cohost.pet.remove`, then a fresh list. Throws the backend's reason. */
  remove: (packId: string) => Promise<void>
}

const NOT_CONNECTED = 'Videorc is still connecting. Try again in a moment.'

/**
 * `cohost.pet.list` and `cohost.pet.remove` for the Golem tab. Like the
 * avatar generator (`use-buddy-avatar.ts`), the tab opens its own backend
 * client while mounted, so the pack list adds nothing to the shell.
 */
export function useBuddyPets(): BuddyPets {
  const { connection, wsStatus } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  const [packs, setPacks] = useState<BuddyPetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) return
    try {
      setPacks(await client.requestTyped('cohost.pet.list'))
      setError(null)
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'Could not list the Golem packs.')
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = useCallback(
    async (packId: string): Promise<void> => {
      if (!client) throw new Error(NOT_CONNECTED)
      await client.requestTyped('cohost.pet.remove', { packId })
      await refresh()
    },
    [client, refresh]
  )

  return { packs, error, refresh, remove }
}
