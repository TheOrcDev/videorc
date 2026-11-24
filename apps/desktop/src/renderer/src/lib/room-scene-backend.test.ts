import { describe, expect, it } from 'vitest'
import type { BackendClient } from '@/backendClient'
import type { RoomPresentationStatus } from '@/lib/backend'
import { commitSceneToBackend } from './room-scene-backend'

function status(revision: number, state: RoomPresentationStatus['state']): RoomPresentationStatus {
  return { enabled: true, state, reason: null, revision, observed: {} }
}

/** A client whose commit answers `generation` after emitting `early` entries. */
function fakeClient(
  generation: number,
  early: RoomPresentationStatus[],
  standing: RoomPresentationStatus | null = null
): BackendClient {
  let listener: ((event: unknown) => void) | null = null
  return {
    on: (_event: string, handler: (event: unknown) => void) => {
      listener = handler
      return () => {
        listener = null
      }
    },
    requestTyped: async () => {
      for (const scene of early) listener?.({ showId: 'show_1', scene })
      return { held: true, generation, status: standing }
    }
  } as unknown as BackendClient
}

describe('plan 260 S1.8b scene commit to the backend', () => {
  it('settles on an early result of its own generation', async () => {
    const client = fakeClient(4, [status(3, 'applied'), status(4, 'preview')])
    const commit = await commitSceneToBackend(client, 'show_1', null, [], 50)
    expect(commit?.state).toBe('preview')
  })

  it('never settles on another generation', async () => {
    const client = fakeClient(5, [status(4, 'applied')])
    const commit = await commitSceneToBackend(client, 'show_1', null, [], 20)
    expect(commit?.state).toBe('waiting')
  })

  it('answers an unchanged commit with its standing result', async () => {
    const client = fakeClient(6, [], status(6, 'applied'))
    const commit = await commitSceneToBackend(client, 'show_1', null, [], 20)
    expect(commit?.state).toBe('applied')
  })
})
