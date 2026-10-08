import { describe, expect, it, vi } from 'vitest'

import type { CohostAvatarGeneratedEvent } from '@/lib/backend'

import { generateThroughClient } from './use-golem-avatar'

/** A client that accepts, then emits whatever the test queued, in order. */
function fakeClient(queued: CohostAvatarGeneratedEvent[], requestId = 'req-1') {
  const handlers = new Set<(event: CohostAvatarGeneratedEvent) => void>()
  const requestTyped = vi.fn(async (method: string, params: unknown) => {
    expect(method).toBe('cohost.avatar.generate')
    const { state } = params as { state: string }
    queueMicrotask(() => {
      for (const event of queued) for (const handler of handlers) handler(event)
    })
    return { requestId, state }
  })
  const on = vi.fn((_event: string, handler: (event: CohostAvatarGeneratedEvent) => void) => {
    handlers.add(handler)
    return () => handlers.delete(handler)
  })
  return { client: { requestTyped, on } as never, handlers }
}

const request = {
  personaId: 'p',
  state: 'laugh' as const,
  prompt: 'a golem',
  style: 'cartoon' as const
}

describe('generateThroughClient (plan 164 S-A6)', () => {
  it('accepts, then resolves on the event for its own request id', async () => {
    const { client, handlers } = fakeClient([
      { requestId: 'other', state: 'laugh', path: 'p/laugh.png', opaque: false },
      { requestId: 'req-1', state: 'laugh', path: 'p/laugh.png', opaque: true }
    ])
    await expect(generateThroughClient(client, request)).resolves.toEqual({
      path: 'p/laugh.png',
      opaque: true
    })
    // The subscription is released once the outcome landed.
    expect(handlers.size).toBe(0)
  })

  it("rejects with the event's own line when the web refused", async () => {
    const { client } = fakeClient([
      {
        requestId: 'req-1',
        state: 'laugh',
        opaque: false,
        error: { code: 'quota-exhausted', message: 'Daily avatar limit reached' }
      }
    ])
    await expect(generateThroughClient(client, request)).rejects.toThrow(
      'Daily avatar limit reached'
    )
  })

  it('gives up when no outcome arrives in time', async () => {
    const { client, handlers } = fakeClient([])
    await expect(generateThroughClient(client, request, 10)).rejects.toThrow(
      'The model took too long.'
    )
    expect(handlers.size).toBe(0)
  })
})
