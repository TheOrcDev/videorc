import { describe, expect, it } from 'vitest'

import type { CohostState, PlatformAccount } from './backend'
import { orcleLiveSettingsPatch } from './cohost-state'
import { COHOST_ACTS_ON_ASK_COPY } from './cohost-view'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  ORCLE_REMOVAL_FALLBACK,
  ORCLE_REMOVAL_LIMITS,
  ORCLE_REMOVE_MESSAGES_NO_ACCOUNT,
  ORCLE_VOICE_COMMANDS,
  ORCLE_VOICE_COMMANDS_DESCRIPTION,
  ORCLE_VOICE_COMMANDS_OFF,
  ORCLE_VOICE_PREMIUM,
  orcleVoicePhrasesLabel,
  removeMessagesRows,
  CLOUD_AI_KEEPS,
  CLOUD_AI_USES,
  ORCLE_CONSENT_OFF_REASON,
  ORCLE_LIVE_POWERS,
  ORCLE_LIVE_STATUS_LABELS,
  ORCLE_SIGNED_OUT_REASON,
  orcleLiveUnlock,
  orcleLiveView,
  type OrcleLiveViewInput
} from './orcle-tab-view'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}

function engine(overrides: Partial<CohostState> = {}): CohostState {
  return {
    sessionId: 'live-1',
    status: 'listening',
    reason: null,
    questions: [],
    flags: [],
    mood: null,
    lastTickAt: null,
    tickSeq: 1,
    partial: false,
    ...overrides
  }
}

function input(overrides: Partial<OrcleLiveViewInput> = {}): OrcleLiveViewInput {
  return {
    settings: { enabled: true },
    signedIn: true,
    gate: premium,
    consented: true,
    live: false,
    state: null,
    ...overrides
  }
}

describe('Golem tab copy (plan 119 S2)', () => {
  it('names what Golem does, each with the tab that holds its settings (plan 150)', () => {
    expect(ORCLE_LIVE_POWERS.map((power) => [power.title, power.tab])).toEqual([
      ['Never miss a question', 'chat'],
      ['Chat stays safe', 'chat'],
      ['The room, handled', 'chat'],
      ['Talk to Golem', 'voice']
    ])
  })

  it('keeps every line plain: no em dash, sentence case, a full stop', () => {
    const lines = [
      ...ORCLE_LIVE_POWERS.map((power) => power.description),
      ...CLOUD_AI_USES,
      CLOUD_AI_KEEPS,
      ORCLE_SIGNED_OUT_REASON,
      ORCLE_CONSENT_OFF_REASON
    ]
    for (const line of [...lines, ...Object.values(ORCLE_LIVE_STATUS_LABELS)]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
    for (const line of lines) expect(line).toMatch(/\.$/)
  })

  it('names every cloud use and what is kept, the one list consent shows', () => {
    expect(CLOUD_AI_USES).toEqual([
      'Golem reads your live chat.',
      "Golem hears you while you're live: your microphone audio goes to Videorc's cloud speech-to-text and comes back as text.",
      "Clean cut uploads a recording's audio, never the video, in short chunks for a word-by-word transcript, and sends its sentences to Videorc's cloud AI to find retakes. Neither is kept on Videorc servers after the job finishes."
    ])
    expect(CLOUD_AI_KEEPS).toContain("Videorc servers don't keep your chat or your audio.")
    expect(CLOUD_AI_KEEPS).toContain('A short report of each stream is saved on this computer.')
  })
})

describe('orcleLiveSettingsPatch', () => {
  it('turns Golem on with listening in one patch, and off without touching listening', () => {
    expect(orcleLiveSettingsPatch(true)).toEqual({ enabled: true, listen: true })
    expect(orcleLiveSettingsPatch(false)).toEqual({ enabled: false })
  })
})

describe('orcleLiveUnlock', () => {
  it('asks a signed-out streamer to sign in before anything else', () => {
    expect(orcleLiveUnlock(false, basic)).toEqual({
      action: { kind: 'sign-in' },
      reason: ORCLE_SIGNED_OUT_REASON
    })
    expect(orcleLiveUnlock(false, premium)?.action).toEqual({ kind: 'sign-in' })
  })

  it('offers Premium to a signed-in Basic account, with the gate reason', () => {
    expect(orcleLiveUnlock(true, basic)).toEqual({
      action: { kind: 'view-premium', url: 'https://www.videorc.com/premium' },
      reason: 'Golem requires Videorc Premium.'
    })
  })

  it('names a lock without an upgrade link and offers no action', () => {
    expect(
      orcleLiveUnlock(true, { allowed: false, featureId: 'live-cohost', reason: 'Not enabled.' })
    ).toEqual({ action: null, reason: 'Not enabled.' })
  })

  it('unlocks nothing for Premium', () => {
    expect(orcleLiveUnlock(true, premium)).toBeNull()
  })
})

describe('orcleLiveView', () => {
  it('is off when the streamer turned it off, whatever else is true', () => {
    for (const overrides of [
      {},
      { consented: false },
      { live: true, state: engine() },
      { signedIn: false }
    ]) {
      const view = orcleLiveView(input({ settings: { enabled: false }, ...overrides }))
      expect(view.status).toMatchObject({ kind: 'off', label: 'Off', reason: null })
      expect(view.checked).toBe(false)
    }
  })

  it('joins the next stream once on, consented and unlocked', () => {
    const view = orcleLiveView(input())
    expect(view.status).toEqual({
      kind: 'on',
      label: 'On, joins your next stream',
      reason: null,
      detail: null
    })
    expect(view.checked).toBe(true)
    expect(view.switchDisabled).toBe(false)
    expect(view.unlock).toBeNull()
    expect(view.streamManager).toBe(false)
  })

  it('is live while on air and the engine reads chat, with the Stream Manager one click away', () => {
    for (const state of [
      null,
      engine(),
      engine({ status: 'off' }),
      engine({ tickInFlight: true })
    ]) {
      const view = orcleLiveView(input({ live: true, state }))
      expect(view.status).toMatchObject({ kind: 'live', label: 'Live now', reason: null })
      expect(view.streamManager).toBe(true)
    }
  })

  it('says why it cannot hear you while live, without raising an alarm', () => {
    const view = orcleLiveView(
      input({
        live: true,
        state: engine({ listening: { state: 'blocked', reasonCode: 'no-microphone' } })
      })
    )
    expect(view.status).toMatchObject({
      kind: 'live',
      reason: 'Not listening: no microphone selected'
    })
  })

  it('needs attention when the engine paused or failed, in the plain words the toast uses', () => {
    const paused = orcleLiveView(
      input({ live: true, state: engine({ status: 'paused', reason: 'quota-exhausted' }) })
    )
    expect(paused.status).toMatchObject({
      kind: 'attention',
      label: 'Needs attention',
      reason: 'Golem paused: daily AI quota is used up.'
    })

    const failed = orcleLiveView(
      input({
        live: true,
        state: engine({
          status: 'error',
          reason: 'gateway-error',
          detail: { code: 'ai-gateway-error', message: 'Every model failed.', status: 502 }
        })
      })
    )
    expect(failed.status).toEqual({
      kind: 'attention',
      label: 'Needs attention',
      reason: 'Golem stopped: Videorc AI returned an error.',
      detail: 'ai-gateway-error (HTTP 502): Every model failed.'
    })

    expect(
      orcleLiveView(input({ live: true, state: engine({ status: 'error', reason: null }) })).status
        .reason
    ).toBe('Golem hit an error.')
  })

  it('needs attention when cloud AI was revoked with Golem still on', () => {
    const view = orcleLiveView(input({ consented: false, live: true, state: engine() }))
    expect(view.status).toMatchObject({ kind: 'attention', reason: ORCLE_CONSENT_OFF_REASON })
    // The switch still shows the stored choice; turning it off stays possible.
    expect(view.checked).toBe(true)
    expect(view.switchDisabled).toBe(false)
  })

  it('locks a signed-out or Basic account out of turning it on, never out of turning it off', () => {
    const signedOut = orcleLiveView(input({ signedIn: false, settings: { enabled: false } }))
    expect(signedOut.switchDisabled).toBe(true)
    expect(signedOut.unlock?.action).toEqual({ kind: 'sign-in' })

    const basicOff = orcleLiveView(input({ gate: basic, settings: { enabled: false } }))
    expect(basicOff.switchDisabled).toBe(true)
    expect(basicOff.unlock?.action).toEqual({
      kind: 'view-premium',
      url: 'https://www.videorc.com/premium'
    })

    const basicOn = orcleLiveView(input({ gate: basic }))
    expect(basicOn.switchDisabled).toBe(false)
    expect(basicOn.status).toMatchObject({
      kind: 'attention',
      reason: 'Golem requires Videorc Premium.'
    })
  })

  it('waits for the backend before the switch can move', () => {
    const view = orcleLiveView(input({ settings: null }))
    expect(view.switchDisabled).toBe(true)
    expect(view.checked).toBe(false)
    expect(view.status.kind).toBe('off')
  })
})

describe('Voice commands (plan 140, S6 part A)', () => {
  it("says what you can say in the web guide's words", () => {
    expect(ORCLE_VOICE_COMMANDS.map((command) => command.title)).toEqual([
      'Highlight',
      'Clear',
      'Remove',
      'Answer'
    ])
    const phrases = ORCLE_VOICE_COMMANDS.flatMap((command) => command.phrases)
    for (const phrase of [
      'Golem, highlight the comment from coders X',
      'Golem, put this one up',
      'Golem, take it down',
      'Golem, remove it from the screen',
      'This one is toxic. Remove it from our chat.',
      'Golem, delete the comment from coders X',
      'Yes',
      'Never mind'
    ]) {
      expect(phrases).toContain(phrase)
    }
    expect(orcleVoicePhrasesLabel(['Yes', 'Do it', 'No'], 2)).toBe('“Yes”, “Do it”')
  })

  it('keeps the promises plain: posts only in your modes, 20 seconds, 10 a minute, free removal', () => {
    // Plan 164 D4 replaced "never acts on its own" with the per-mode promise.
    expect(COHOST_ACTS_ON_ASK_COPY).toBe(
      'The Golem posts only in the modes you turn on. Everything is off by default. It removes a comment only when you tell it to.'
    )
    expect(ORCLE_REMOVAL_LIMITS).toContain('20 seconds')
    expect(ORCLE_REMOVAL_LIMITS).toContain('At most 10 removals a minute.')
    expect(ORCLE_REMOVAL_FALLBACK).toBe(
      'If the platform cannot remove it, Golem hides it in Videorc and tells you viewers may still see it.'
    )
    expect(ORCLE_VOICE_PREMIUM).toContain('Premium')
    expect(ORCLE_VOICE_PREMIUM).toContain('free for everyone')
    for (const line of [
      ORCLE_VOICE_COMMANDS_DESCRIPTION,
      ORCLE_VOICE_COMMANDS_OFF,
      ORCLE_REMOVAL_LIMITS,
      ORCLE_REMOVAL_FALLBACK,
      ORCLE_VOICE_PREMIUM,
      ORCLE_REMOVE_MESSAGES_NO_ACCOUNT,
      ...ORCLE_VOICE_COMMANDS.flatMap((command) => [command.result, ...command.phrases])
    ]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
  })

  const account = (
    platform: PlatformAccount['platform'],
    scopes: string[],
    status: PlatformAccount['status'] = 'connected'
  ): Pick<PlatformAccount, 'platform' | 'scopes' | 'status' | 'accountLabel'> => ({
    platform,
    scopes,
    status,
    accountLabel: `${platform}-channel`
  })

  it('shows Remove messages per connected platform with its one fix', () => {
    const rows = removeMessagesRows(
      [
        account('x', []),
        account('kick', ['chat:write']),
        account('twitch', ['moderator:manage:chat_messages']),
        account('youtube', ['https://www.googleapis.com/auth/youtube.force-ssl']),
        account('tiktok', [])
      ],
      { xLiveAuthorized: false }
    )
    expect(rows.map((row) => [row.platform, row.ready, row.message, row.action?.label])).toEqual([
      ['youtube', true, 'Ready', undefined],
      ['twitch', true, 'Ready', undefined],
      ['kick', false, 'Reconnect Kick to let Golem remove messages.', 'Reconnect'],
      ['x', false, 'Authorize X Live to let Golem remove messages.', 'Authorize X Live']
    ])
    expect(rows[0].accountLabel).toBe('youtube-channel')
  })

  it('asks for a reconnect when the account lapsed, and is ready once X Live is authorized', () => {
    expect(
      removeMessagesRows([
        account('twitch', ['moderator:manage:chat_messages'], 'needs-reconnect')
      ])[0]
    ).toMatchObject({ ready: false, action: { kind: 'reconnect' } })
    expect(removeMessagesRows([account('x', [])], { xLiveAuthorized: true })[0]).toMatchObject({
      ready: true,
      message: 'Ready'
    })
    expect(removeMessagesRows([])).toEqual([])
  })
})
