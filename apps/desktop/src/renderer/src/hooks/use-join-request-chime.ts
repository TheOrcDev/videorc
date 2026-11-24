import { useEffect } from 'react'

import type { BackendClient } from '@/backendClient'
import { createJoinRequestChime, playJoinChime } from '@/lib/join-request-chime'

/** Plan 260 S1.3: the backend rings the chime itself on every platform
 * (`join_chime.rs`, through its CoreAudio, PipeWire or WASAPI monitor), so
 * the window never does. The hook stays for a caller that passes `true`. */
export function rendererPlaysJoinChime(): boolean {
  return false
}

/**
 * Rings `lib/join-request-chime` for each new "wants to join" while the room
 * is open, where the backend does not ring it. The backend sends
 * `cloud.room.requests` once per request (it keeps the ids it has seen), so a
 * renderer reload doesn't ring old ones again.
 */
export function useJoinRequestChime(
  client: BackendClient | null,
  roomOpen: boolean,
  rendererPlays: boolean = rendererPlaysJoinChime()
): void {
  useEffect(() => {
    if (!client || !roomOpen || !rendererPlays) return
    const chime = createJoinRequestChime({ now: () => performance.now(), play: playJoinChime })
    return client.on('cloud.room.requests', () => {
      chime.ring()
    })
  }, [client, roomOpen, rendererPlays])
}
