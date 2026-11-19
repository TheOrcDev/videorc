import { useEffect } from 'react'

import type { BackendClient } from '@/backendClient'
import { createJoinRequestChime, playJoinChime } from '@/lib/join-request-chime'

/**
 * Rings `lib/join-request-chime` for each new "wants to join" while the room
 * is open. The backend sends `cloud.room.requests` once per request (it keeps
 * the ids it has seen), so a renderer reload doesn't ring old ones again.
 */
export function useJoinRequestChime(client: BackendClient | null, roomOpen: boolean): void {
  useEffect(() => {
    if (!client || !roomOpen) return
    const chime = createJoinRequestChime({ now: () => performance.now(), play: playJoinChime })
    return client.on('cloud.room.requests', () => {
      chime.ring()
    })
  }, [client, roomOpen])
}
