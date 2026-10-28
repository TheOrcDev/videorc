import { describe, expect, it } from 'vitest'

import { cohostAutoChatRelayPatch } from './cohost-auto-chat-relay'

describe('cohostAutoChatRelayPatch (plan 164 S-D6, plan 211 D3)', () => {
  it('passes talk and the three switches, and nothing else', () => {
    expect(cohostAutoChatRelayPatch(undefined)).toBeUndefined()
    expect(cohostAutoChatRelayPatch({})).toStrictEqual({})
    for (const talk of ['off', 'bubble', 'suggest'] as const) {
      expect(cohostAutoChatRelayPatch({ talk })).toStrictEqual({ talk })
    }
    expect(
      cohostAutoChatRelayPatch({ talk: 'bubble', greetings: true, answers: false, banter: true })
    ).toStrictEqual({ talk: 'bubble', greetings: true, answers: false, banter: true })
    // Unknown keys are dropped, not refused (the switches are a partial).
    expect(cohostAutoChatRelayPatch({ greetings: true, extra: 1 })).toStrictEqual({
      greetings: true
    })
  })

  it('refuses auto, the legacy mode, an unknown value and a malformed block', () => {
    expect(cohostAutoChatRelayPatch({ talk: 'auto' })).toBe(false)
    expect(cohostAutoChatRelayPatch({ talk: 'loud' })).toBe(false)
    expect(cohostAutoChatRelayPatch({ talk: null })).toBe(false)
    expect(cohostAutoChatRelayPatch({ talk: 1 })).toBe(false)
    // The legacy projection never comes in through the relay, whatever it says.
    expect(cohostAutoChatRelayPatch({ mode: 'off' })).toBe(false)
    expect(cohostAutoChatRelayPatch({ mode: 'auto' })).toBe(false)
    expect(cohostAutoChatRelayPatch({ talk: 'bubble', mode: 'suggest' })).toBe(false)
    expect(cohostAutoChatRelayPatch({ greetings: 'yes' })).toBe(false)
    expect(cohostAutoChatRelayPatch(null)).toBe(false)
    expect(cohostAutoChatRelayPatch('bubble')).toBe(false)
    expect(cohostAutoChatRelayPatch([])).toBe(false)
  })
})
