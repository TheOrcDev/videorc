import { describe, expect, it, vi } from 'vitest'

import type { CommentsCommandResolution } from '@/lib/backend'
import { startCommunityRelay } from '@/lib/community-relay'
import type { CommunityRelayCommand } from '../../../shared/community-relay'

function harness(request: (method: string, params: unknown) => Promise<unknown>) {
  let listener: ((command: CommunityRelayCommand) => void) | null = null
  const pushed: CommentsCommandResolution<unknown>[] = []
  const stop = startCommunityRelay({
    client: { request: request as never },
    api: {
      onCommunityRequest: (callback) => {
        listener = callback
        return () => {
          listener = null
        }
      },
      pushCommunityResult: async (resolution) => {
        pushed.push(resolution)
        return true
      }
    }
  })
  return {
    ask: (command: CommunityRelayCommand) => listener?.(command),
    pushed,
    stop,
    listening: () => listener !== null
  }
}

describe('the Studio half of the person card relay (plan 225 C2)', () => {
  it('makes the allowlisted call and answers with its result', async () => {
    const request = vi.fn(async () => ({ accepted: true }))
    const relay = harness(request)
    relay.ask({ requestId: 'r1', method: 'cohost.community.wave', params: { personId: 'p1' } })
    await vi.waitFor(() => expect(relay.pushed).toHaveLength(1))
    expect(request).toHaveBeenCalledWith('cohost.community.wave', { personId: 'p1' })
    expect(relay.pushed[0]).toEqual({ requestId: 'r1', ok: true, value: { accepted: true } })
  })

  it("answers a refusal with the backend's sentence, and refuses any other method", async () => {
    const request = vi.fn(async () => {
      throw new Error('X viewers link themselves with !link.')
    })
    const relay = harness(request)
    relay.ask({
      requestId: 'r2',
      method: 'cohost.community.link',
      params: { personId: 'a', otherPersonId: 'b' }
    })
    relay.ask({ requestId: 'r3', method: 'liveChat.send' as never, params: {} })
    await vi.waitFor(() => expect(relay.pushed).toHaveLength(2))
    expect(relay.pushed).toContainEqual({
      requestId: 'r2',
      ok: false,
      error: 'X viewers link themselves with !link.'
    })
    expect(relay.pushed).toContainEqual({
      requestId: 'r3',
      ok: false,
      error: 'That is not a community call.'
    })
    expect(request).toHaveBeenCalledTimes(1)
    relay.stop()
    expect(relay.listening()).toBe(false)
  })
})
