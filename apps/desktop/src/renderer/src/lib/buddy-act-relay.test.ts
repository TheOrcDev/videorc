import { describe, expect, it, vi } from 'vitest'

import type { CommentsCommandResolution } from './backend'
import { askBuddy, startBuddyActRelay } from './buddy-act-relay'
import {
  BUDDY_NO_ANSWER,
  BUDDY_PREMIUM_REQUIRED,
  type BuddyActRelayCommand,
  type CohostActAnswer
} from '../../../shared/buddy-act'

// Plan 209 S20: the Studio's half of `/buddy <words>`.

function fakeClient(reply: (params: { actId: string }) => CohostActAnswer) {
  const listeners = new Set<(payload: CohostActAnswer) => void>()
  const calls: { method: string; params: unknown }[] = []
  const client = {
    requestTyped: vi.fn(async (method: string, params: { actId: string }) => {
      calls.push({ method, params })
      return reply(params)
    }),
    on: vi.fn((event: string, handler: (payload: CohostActAnswer) => void) => {
      expect(event).toBe('cohost.act.result')
      listeners.add(handler)
      return () => listeners.delete(handler)
    })
  }
  return {
    client: client as never,
    calls,
    listeners,
    emit: (answer: CohostActAnswer) => {
      for (const listener of listeners) listener(answer)
    }
  }
}

describe('askBuddy', () => {
  it("gives a free user the voice commands' Premium sentence without a backend call", async () => {
    const fake = fakeClient(() => {
      throw new Error('never called')
    })
    await expect(
      askBuddy(fake.client, 'switch to BRB', { consent: true, entitled: false, actId: 'a1' })
    ).resolves.toEqual({ actId: 'a1', status: 'unavailable', message: BUDDY_PREMIUM_REQUIRED })
    expect(BUDDY_PREMIUM_REQUIRED).toBe('Buddy requires Videorc Premium.')
    expect(fake.calls).toEqual([])
  })

  it('asks with the consent and waits for its own result', async () => {
    const fake = fakeClient(({ actId }) => {
      // The result for another request, then ours, arrive after the reply.
      queueMicrotask(() => {
        fake.emit({ actId: 'someone-else', status: 'done', message: 'Not mine.' })
        fake.emit({ actId, status: 'done', message: 'Switched to BRB. Pressed Drum roll.' })
      })
      return { actId, status: 'working', message: 'Asking Buddy…' }
    })
    const answer = await askBuddy(fake.client, 'switch to BRB and play the drum roll', {
      consent: true,
      entitled: true,
      actId: 'a2'
    })
    expect(answer).toEqual({
      actId: 'a2',
      status: 'done',
      message: 'Switched to BRB. Pressed Drum roll.'
    })
    expect(fake.calls).toEqual([
      {
        method: 'cohost.act',
        params: {
          actId: 'a2',
          sentence: 'switch to BRB and play the drum roll',
          consentToProcessChat: true
        }
      }
    ])
    expect(fake.listeners.size).toBe(0)
  })

  it("returns a gate's answer at once", async () => {
    const fake = fakeClient(({ actId }) => ({
      actId,
      status: 'unavailable',
      message: "Buddy can't take requests right now."
    }))
    await expect(
      askBuddy(fake.client, 'go live', { consent: false, entitled: true, actId: 'a3' })
    ).resolves.toMatchObject({ status: 'unavailable' })
    expect((fake.calls[0].params as { consentToProcessChat: boolean }).consentToProcessChat).toBe(
      false
    )
  })

  it('says Buddy did not answer when no result arrives', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeClient(({ actId }) => ({ actId, status: 'working', message: '…' }))
      const pending = askBuddy(fake.client, 'hm', {
        consent: true,
        entitled: true,
        actId: 'a4',
        timeoutMs: 1_000
      })
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(pending).resolves.toEqual({
        actId: 'a4',
        status: 'not-found',
        message: BUDDY_NO_ANSWER
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('startBuddyActRelay', () => {
  it("answers the Stream Manager with Buddy's final words", async () => {
    const fake = fakeClient(({ actId }) => ({
      actId,
      status: 'refused',
      message: "Buddy can't use notify."
    }))
    const pushed: CommentsCommandResolution<CohostActAnswer>[] = []
    let onRequest: ((command: BuddyActRelayCommand) => void) | null = null
    const stop = startBuddyActRelay({
      client: fake.client,
      consent: () => true,
      entitled: () => true,
      api: {
        onBuddyActRequest: (callback) => {
          onRequest = callback
          return () => {
            onRequest = null
          }
        },
        pushBuddyActResult: async (resolution) => {
          pushed.push(resolution)
          return true
        }
      }
    })
    onRequest!({ requestId: 'r1', sentence: 'tell everyone hi' })
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    expect(pushed[0]).toMatchObject({
      requestId: 'r1',
      ok: true,
      value: { status: 'refused', message: "Buddy can't use notify." }
    })
    stop()
    expect(onRequest).toBeNull()
  })
})
