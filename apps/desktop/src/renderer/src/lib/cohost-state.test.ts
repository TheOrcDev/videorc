import { describe, expect, it } from 'vitest'

import type { CohostAutoChat } from './backend'
import { cohostEnableRelayPatch, DEFAULT_COHOST_AUTO_CHAT } from './cohost-state'

const on = { enabled: true }
const off = { enabled: false }
const autoChat: CohostAutoChat = {
  ...DEFAULT_COHOST_AUTO_CHAT,
  mode: 'suggest',
  greetings: { enabled: true, templates: [] }
}

describe('cohostEnableRelayPatch (plan 174 S0.2)', () => {
  it('turns Buddy on, with listening only when the command names it', () => {
    expect(cohostEnableRelayPatch(off, { enabled: true, listen: true }, null)).toEqual({
      enabled: true,
      listen: true
    })
    // The consent dialog's Allow: consent and Buddy on, never the microphone.
    expect(cohostEnableRelayPatch(off, { enabled: true }, null)).toEqual({ enabled: true })
    expect(cohostEnableRelayPatch(off, { enabled: true, listen: true }, autoChat)).toEqual({
      enabled: true,
      listen: true,
      autoChat
    })
  })

  it('writes listening alone for the listening card while Buddy already runs', () => {
    expect(cohostEnableRelayPatch(on, { enabled: true, listen: true }, null)).toEqual({
      listen: true
    })
  })

  it('saves a behaviour switch alone: never enabled, never listening', () => {
    expect(cohostEnableRelayPatch(on, { enabled: true }, autoChat)).toEqual({ autoChat })
    expect(cohostEnableRelayPatch(off, { enabled: false }, autoChat)).toEqual({ autoChat })
    expect(cohostEnableRelayPatch(on, { enabled: true, listen: false }, autoChat)).toEqual({
      autoChat
    })
  })

  it('off leaves listening as it was, whatever the command says', () => {
    expect(cohostEnableRelayPatch(on, { enabled: false, listen: true }, null)).toEqual({
      enabled: false
    })
    expect(cohostEnableRelayPatch(on, { enabled: false }, autoChat)).toEqual({
      enabled: false,
      autoChat
    })
  })

  it('saves nothing for a command that changes nothing', () => {
    expect(cohostEnableRelayPatch(on, { enabled: true }, null)).toEqual({})
    expect(cohostEnableRelayPatch(off, { enabled: false }, null)).toEqual({})
  })

  it('writes enabled as commanded while the stored settings are unknown', () => {
    expect(cohostEnableRelayPatch(null, { enabled: true }, null)).toEqual({ enabled: true })
    expect(cohostEnableRelayPatch(null, { enabled: false }, null)).toEqual({ enabled: false })
  })
})
