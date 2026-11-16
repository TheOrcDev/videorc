import { describe, expect, it } from 'vitest'

import { validateBackendEventPayload } from './backend-rpc-contract'

/** Plan 249 S5: the renderer accepts exactly the backend's public projection (`buddy_animator::public_event`). */
describe('cohost.pet.animator', () => {
  it('accepts state and events in the shapes the backend sends', () => {
    for (const payload of [
      {
        avatarState: 'talk',
        event: { kind: 'utterance', mood: 'talk', chars: 30, bubbleSeconds: 2.5 }
      },
      { avatarState: 'idle', event: { kind: 'utterance-end' } },
      { avatarState: 'think' },
      { event: { kind: 'reaction', chain: ['kiss', 'wave', 'proud'], activity: true } },
      { event: { kind: 'reaction', chain: [], activity: false } },
      { event: { kind: 'highlight', ttlSeconds: 10 } },
      { event: { kind: 'chat' } },
      {
        event: {
          kind: 'settings',
          settings: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true }
        }
      }
    ]) {
      expect(validateBackendEventPayload('cohost.pet.animator', payload)).toStrictEqual(payload)
    }
  })

  it('refuses text, unknown fields, nulls and unbounded values', () => {
    for (const payload of [
      {},
      { avatarState: null },
      { event: { kind: 'utterance', mood: 'talk', chars: 3, bubbleSeconds: 1, text: 'hello' } },
      { event: { kind: 'reaction', chain: ['Not An Id'], activity: true } },
      {
        event: { kind: 'reaction', chain: Array.from({ length: 9 }, () => 'wave'), activity: true }
      },
      { event: { kind: 'highlight', ttlSeconds: 1e9 } },
      { event: { kind: 'say', text: 'x' } },
      { avatarState: 'idle', prompt: 'secret' }
    ]) {
      expect(() => validateBackendEventPayload('cohost.pet.animator', payload)).toThrow()
    }
  })
})
