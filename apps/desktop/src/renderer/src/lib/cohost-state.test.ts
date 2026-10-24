import { describe, expect, it } from 'vitest'

import type { CohostAutoChat } from './backend'
import {
  buddyLiveSettingsPatch,
  cohostEnableRelayPatch,
  DEFAULT_COHOST_AUTO_CHAT,
  mergeAutoChatRelayPatch
} from './cohost-state'

const on = { enabled: true }
const off = { enabled: false }
const autoChat: CohostAutoChat = {
  ...DEFAULT_COHOST_AUTO_CHAT,
  mode: 'suggest',
  greetings: { enabled: true, templates: [] }
}

describe('buddyLiveSettingsPatch (plan 174 S3.14a, D7)', () => {
  it('writes enabled and nothing else: listening is its own switch', () => {
    expect(buddyLiveSettingsPatch(true)).toEqual({ enabled: true })
    expect(buddyLiveSettingsPatch(false)).toEqual({ enabled: false })
  })
})

describe('cohostEnableRelayPatch (plan 174 S0.2, S3.14a)', () => {
  it('turns Buddy on, with listening only when the command that turns it on names it', () => {
    expect(cohostEnableRelayPatch(off, { enabled: true, listen: true }, null)).toEqual({
      enabled: true,
      listen: true
    })
    // The Buddy Live switch and the consent dialog's Allow: Buddy on, never
    // the microphone.
    expect(cohostEnableRelayPatch(off, { enabled: true }, null)).toEqual({ enabled: true })
    expect(cohostEnableRelayPatch(off, { enabled: true, listen: true }, autoChat)).toEqual({
      enabled: true,
      listen: true,
      autoChat
    })
  })

  it('drops a later listen while Buddy already runs unless the listening card grants it', () => {
    // No on-path grants the microphone by accident (the Phase 0 review).
    expect(cohostEnableRelayPatch(on, { enabled: true, listen: true }, null)).toEqual({})
    expect(cohostEnableRelayPatch(on, { enabled: true, listen: true }, autoChat)).toEqual({
      autoChat
    })
    // The listening card's own Turn on: listening alone.
    expect(
      cohostEnableRelayPatch(on, { enabled: true, listen: true, grantListen: true }, null)
    ).toEqual({ listen: true })
    // The grant without a value, or without Buddy on, writes nothing.
    expect(cohostEnableRelayPatch(on, { enabled: true, grantListen: true }, null)).toEqual({})
    expect(
      cohostEnableRelayPatch(on, { enabled: false, listen: true, grantListen: true }, null)
    ).toEqual({ enabled: false })
  })

  it('saves a posting-mode change alone: never enabled, never listening', () => {
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
    // Unknown counts as off: a first on with listening named still carries it.
    expect(cohostEnableRelayPatch(null, { enabled: true, listen: true }, null)).toEqual({
      enabled: true,
      listen: true
    })
  })
})

describe('the automatic chat defaults (plan 192)', () => {
  it("matches Rust's defaults: posting Off, Greetings with AI and both welcomes, Answers on", () => {
    expect(DEFAULT_COHOST_AUTO_CHAT).toStrictEqual({
      mode: 'off',
      greetings: {
        enabled: true,
        templates: [],
        ai: true,
        welcomes: { firstTime: { enabled: true }, returning: { enabled: true } }
      },
      answers: { enabled: true, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
  })

  it("keeps the AI switch, the welcomes and the lines when the Stream Manager's patch lands", () => {
    const stored: CohostAutoChat = {
      mode: 'suggest',
      greetings: {
        enabled: true,
        templates: [{ id: 't', kind: 'follow', text: 'Hi {name}', state: 'talk', enabled: true }],
        ai: false,
        welcomes: {
          firstTime: { enabled: true, text: 'Yo {name}!', state: 'laugh' },
          returning: { enabled: false }
        }
      },
      answers: { enabled: false, cooldownSeconds: 45 },
      banter: { enabled: true, cooldownSeconds: 300 }
    }
    expect(mergeAutoChatRelayPatch(stored, { mode: 'auto', greetings: false })).toStrictEqual({
      ...stored,
      mode: 'auto',
      greetings: { ...stored.greetings, enabled: false }
    })
    // Nothing stored yet: the patch lands on the defaults.
    expect(mergeAutoChatRelayPatch(null, { mode: 'suggest' })).toStrictEqual({
      ...DEFAULT_COHOST_AUTO_CHAT,
      mode: 'suggest'
    })
  })
})
