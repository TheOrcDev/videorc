import { describe, expect, it } from 'vitest'

import type { CohostState, PlatformAccount } from './backend'
import { buddyLiveSettingsPatch } from './cohost-state'
import { COHOST_ACTS_ON_ASK_COPY } from './cohost-view'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  BUDDY_REMOVAL_FALLBACK,
  BUDDY_REMOVAL_LIMITS,
  BUDDY_REMOVE_MESSAGES_NO_ACCOUNT,
  BUDDY_VOICE_COMMANDS,
  BUDDY_VOICE_COMMANDS_DESCRIPTION,
  BUDDY_VOICE_COMMANDS_OFF,
  BUDDY_VOICE_PREMIUM,
  buddyVoicePhrasesLabel,
  buddyWakeWordsLine,
  removeMessagesRows,
  CLOUD_AI_CLEAN_CUT_USE,
  CLOUD_AI_KEEPS,
  CLOUD_AI_USES,
  BUDDY_CHAT_FREE_NOTE,
  BUDDY_CONSENT_OFF_REASON,
  BUDDY_LIVE_POWERS,
  BUDDY_LIVE_PREMIUM_REASON,
  BUDDY_LIVE_STATUS_LABELS,
  BUDDY_SIGNED_OUT_REASON,
  buddyLiveUnlock,
  buddyLiveView,
  cloudAiUsesLedBy,
  type BuddyLiveViewInput
} from './buddy-tab-view'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Buddy requires Videorc Premium.',
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

function input(overrides: Partial<BuddyLiveViewInput> = {}): BuddyLiveViewInput {
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

describe('Buddy tab copy (plan 119 S2)', () => {
  it('names what Buddy does, each with the tab that holds its settings (plan 150)', () => {
    expect(BUDDY_LIVE_POWERS.map((power) => [power.title, power.tab])).toEqual([
      ['Never miss a question', 'chat'],
      ['Chat stays safe', 'chat'],
      ['The room, handled', 'chat'],
      ['Talk to Buddy', 'voice']
    ])
  })

  it('keeps every line plain: no em dash, sentence case, a full stop', () => {
    const lines = [
      ...BUDDY_LIVE_POWERS.map((power) => power.description),
      ...CLOUD_AI_USES,
      CLOUD_AI_KEEPS,
      BUDDY_SIGNED_OUT_REASON,
      BUDDY_CONSENT_OFF_REASON,
      BUDDY_LIVE_PREMIUM_REASON,
      BUDDY_CHAT_FREE_NOTE
    ]
    for (const line of [...lines, ...Object.values(BUDDY_LIVE_STATUS_LABELS)]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
    for (const line of lines) expect(line).toMatch(/\.$/)
  })

  it('names every cloud use and what is kept, the one list consent shows', () => {
    expect(CLOUD_AI_USES).toEqual([
      "Buddy reads your live chat with Videorc's cloud AI.",
      "Buddy hears you while you're live: your microphone audio goes to Videorc's cloud speech-to-text and comes back as text.",
      // Plan 170 D17: created Buddies live in the account; the inspiration picture is not kept.
      "Creating a Buddy: your description and any picture you add go to Videorc's cloud AI, and the picture is used once and not kept. The Buddies you create (their pictures, name, personality and About you) are kept in your Videorc account so you can use them on any computer, until you delete them or your account.",
      // Plan 172 D10 (plan 174 G-6): a library Buddy's moves join the account.
      "Creating an Alive Buddy: your reference picture and its description go to Videorc's cloud AI. Its moves are kept on this computer and, for a Buddy you made that's in your library, in your Videorc account too, so it moves on any computer, until you remove them or delete the Buddy or your account.",
      "Buddy replies in chat as you: with Answers or Banter on, its replies are drafted by Videorc's cloud AI and posted on your own account, only in the modes you turn on.",
      "Clean cut uploads a recording's audio, never the video, in short chunks for a word-by-word transcript, and sends its sentences to Videorc's cloud AI to find retakes. Neither is kept on Videorc servers after the job finishes."
    ])
    expect(CLOUD_AI_KEEPS).toContain("Videorc servers don't keep your chat or your audio.")
    expect(CLOUD_AI_KEEPS).toContain('A short report of each stream is saved on this computer.')
  })

  it("leads a feature's consent with its own line, and still names every other use", () => {
    const uses = cloudAiUsesLedBy(CLOUD_AI_CLEAN_CUT_USE)
    expect(uses.lead).toBe(CLOUD_AI_CLEAN_CUT_USE)
    expect(uses.others).not.toContain(CLOUD_AI_CLEAN_CUT_USE)
    expect([uses.lead, ...uses.others].sort()).toEqual([...CLOUD_AI_USES].sort())
  })

  it('never says Buddy acts on its own while Auto posts (plan 174 F-19)', () => {
    for (const power of BUDDY_LIVE_POWERS) expect(power.description).not.toMatch(/on its own/)
    expect(BUDDY_LIVE_POWERS.find((power) => power.title === 'Chat stays safe')?.description).toBe(
      'Spam, scams and abuse are flagged against your own rules. Buddy removes a comment only when you tell it to.'
    )
  })

  it('points cloud AI off at the Cloud AI section, never a retired tab (plan 174 F-5)', () => {
    expect(BUDDY_CONSENT_OFF_REASON).toContain('under Cloud AI')
    expect(BUDDY_CONSENT_OFF_REASON).not.toMatch(/Customize/)
  })
})

describe('buddyLiveSettingsPatch', () => {
  it('turns Buddy on and off without touching listening (plan 174 S3.14a, D7)', () => {
    expect(buddyLiveSettingsPatch(true)).toEqual({ enabled: true })
    expect(buddyLiveSettingsPatch(false)).toEqual({ enabled: false })
  })
})

describe('buddyLiveUnlock', () => {
  it('asks a signed-out streamer to sign in before anything else', () => {
    expect(buddyLiveUnlock(false, basic)).toEqual({
      action: { kind: 'sign-in' },
      reason: BUDDY_SIGNED_OUT_REASON
    })
    expect(buddyLiveUnlock(false, premium)?.action).toEqual({ kind: 'sign-in' })
  })

  it('offers Premium to a signed-in Basic account, in the one Premium sentence', () => {
    expect(buddyLiveUnlock(true, basic)).toEqual({
      action: { kind: 'view-premium', url: 'https://www.videorc.com/premium' },
      reason: 'Buddy Live is part of Videorc Premium.'
    })
  })

  it('names a lock without an upgrade link and offers no action', () => {
    expect(
      buddyLiveUnlock(true, { allowed: false, featureId: 'live-cohost', reason: 'Not enabled.' })
    ).toEqual({ action: null, reason: 'Not enabled.' })
  })

  it('unlocks nothing for Premium', () => {
    expect(buddyLiveUnlock(true, premium)).toBeNull()
  })
})

describe('buddyLiveView', () => {
  it('is off when the streamer turned it off, whatever else is true', () => {
    for (const overrides of [
      {},
      { consented: false },
      { live: true, state: engine() },
      { signedIn: false }
    ]) {
      const view = buddyLiveView(input({ settings: { enabled: false }, ...overrides }))
      expect(view.status).toMatchObject({ kind: 'off', label: 'Off' })
      expect(view.checked).toBe(false)
    }
    // Off beside its lock, so the reason sits next to the one unlock action.
    expect(buddyLiveView(input({ settings: { enabled: false } })).status.reason).toBeNull()
    expect(
      buddyLiveView(input({ settings: { enabled: false }, signedIn: false })).status.reason
    ).toBe(BUDDY_SIGNED_OUT_REASON)
  })

  it('joins the next stream once on, consented and unlocked', () => {
    const view = buddyLiveView(input())
    expect(view.status).toEqual({
      kind: 'on',
      label: 'On',
      reason: 'Joins your next stream',
      detail: null
    })
    expect(view.checked).toBe(true)
    expect(view.switchDisabled).toBe(false)
    expect(view.unlock).toBeNull()
    expect(view.streamManager).toBe(false)
  })

  it('is live while on air in the one status vocabulary (plan 174 F-20)', () => {
    const cases: Array<[CohostState | null, string]> = [
      [null, 'Starting…'],
      [engine({ status: 'off' }), 'Starting…'],
      [engine(), 'Reading chat'],
      [engine({ tickInFlight: true }), 'Thinking…']
    ]
    for (const [state, label] of cases) {
      const view = buddyLiveView(input({ live: true, state }))
      expect(view.status).toMatchObject({ kind: 'live', label, reason: null })
      expect(view.streamManager).toBe(true)
    }
  })

  it('says why it cannot hear you while live, without raising an alarm', () => {
    const view = buddyLiveView(
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

  it('needs attention when the engine paused or failed, in the words every surface says', () => {
    const paused = buddyLiveView(
      input({ live: true, state: engine({ status: 'paused', reason: 'quota-exhausted' }) })
    )
    expect(paused.status).toMatchObject({
      kind: 'attention',
      label: 'Paused: daily AI allowance used up',
      reason: null
    })

    const failed = buddyLiveView(
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
      label: 'Stopped: Videorc AI error',
      reason: null,
      detail: 'ai-gateway-error (HTTP 502): Every model failed.'
    })

    expect(
      buddyLiveView(input({ live: true, state: engine({ status: 'error', reason: null }) })).status
        .label
    ).toBe('Stopped')
  })

  it('needs attention when cloud AI was revoked with Buddy still on', () => {
    const view = buddyLiveView(input({ consented: false, live: true, state: engine() }))
    expect(view.status).toMatchObject({ kind: 'attention', reason: BUDDY_CONSENT_OFF_REASON })
    // The switch still shows the stored choice; turning it off stays possible.
    expect(view.checked).toBe(true)
    expect(view.switchDisabled).toBe(false)
  })

  it('locks a signed-out or Basic account out of turning it on, never out of turning it off', () => {
    const signedOut = buddyLiveView(input({ signedIn: false, settings: { enabled: false } }))
    expect(signedOut.switchDisabled).toBe(true)
    expect(signedOut.unlock?.action).toEqual({ kind: 'sign-in' })

    const basicOff = buddyLiveView(input({ gate: basic, settings: { enabled: false } }))
    expect(basicOff.switchDisabled).toBe(true)
    expect(basicOff.unlock?.action).toEqual({
      kind: 'view-premium',
      url: 'https://www.videorc.com/premium'
    })

    const basicOn = buddyLiveView(input({ gate: basic }))
    expect(basicOn.switchDisabled).toBe(false)
    expect(basicOn.status).toMatchObject({
      kind: 'attention',
      reason: BUDDY_LIVE_PREMIUM_REASON
    })
  })

  it('waits for the backend before the switch can move', () => {
    const view = buddyLiveView(input({ settings: null }))
    expect(view.switchDisabled).toBe(true)
    expect(view.checked).toBe(false)
    expect(view.status.kind).toBe('off')
  })
})

describe('Voice commands (plan 140, S6 part A)', () => {
  it("says what you can say in the web guide's words", () => {
    expect(BUDDY_VOICE_COMMANDS.map((command) => command.title)).toEqual([
      'Highlight',
      'Clear',
      'Remove',
      'Answer',
      'Banners',
      'Marker'
    ])
    const phrases = BUDDY_VOICE_COMMANDS.flatMap((command) => command.phrases)
    for (const phrase of [
      'Buddy, highlight the comment from coders X',
      'Buddy, put this one up',
      'Buddy, take it down',
      'Buddy, remove it from the screen',
      'This one is toxic. Remove it from our chat.',
      'Buddy, delete the comment from coders X',
      'Yes',
      'Never mind',
      // Plan 186 S11: banner commands, as cohost_command.rs parses them.
      'Buddy, show the sponsor banner',
      'Buddy, hide the banners',
      // Plan 174 F-16: the marker command, as marker_voice.rs parses it.
      'Buddy, make a marker here for the Q&A'
    ]) {
      expect(phrases).toContain(phrase)
    }
    expect(buddyVoicePhrasesLabel(['Yes', 'Do it', 'No'], 2)).toBe('“Yes”, “Do it”')
    expect(buddyVoicePhrasesLabel(['Yes', 'Do it'])).toBe('“Yes”, “Do it”')
  })

  it("says that Buddy's own name starts a command too (plan 174 F-16)", () => {
    expect(buddyWakeWordsLine('Grum')).toBe("Start with “Buddy” or your Buddy's own name, “Grum”.")
    // The backend wakes on a word of three letters or more; "Buddy" is itself.
    for (const name of [null, '', 'Buddy', 'buddy', 'Io']) {
      expect(buddyWakeWordsLine(name)).toBe('Start with “Buddy”.')
    }
  })

  it('keeps the promises plain: posts only in your modes, 20 seconds, 10 a minute, free removal', () => {
    // Plan 164 D4 replaced "never acts on its own" with the per-mode promise.
    expect(COHOST_ACTS_ON_ASK_COPY).toBe(
      'Buddy posts only in the modes you turn on. Everything is off by default. It removes a comment only when you tell it to.'
    )
    expect(BUDDY_REMOVAL_LIMITS).toContain('20 seconds')
    expect(BUDDY_REMOVAL_LIMITS).toContain('At most 10 removals a minute.')
    expect(BUDDY_REMOVAL_FALLBACK).toBe(
      "If the platform can't remove it, Buddy hides it in Videorc and tells you viewers may still see it."
    )
    expect(BUDDY_VOICE_PREMIUM).toContain('Voice commands are part of Videorc Premium.')
    expect(BUDDY_VOICE_PREMIUM).toContain('free for everyone')
    for (const line of [
      BUDDY_VOICE_COMMANDS_DESCRIPTION,
      BUDDY_VOICE_COMMANDS_OFF,
      BUDDY_REMOVAL_LIMITS,
      BUDDY_REMOVAL_FALLBACK,
      BUDDY_VOICE_PREMIUM,
      BUDDY_REMOVE_MESSAGES_NO_ACCOUNT,
      ...BUDDY_VOICE_COMMANDS.flatMap((command) => [command.result, ...command.phrases])
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
    expect(
      rows.map((row) => [row.platform, row.ready, row.status, row.message, row.action?.label])
    ).toEqual([
      ['youtube', true, 'Ready', 'Ready', undefined],
      ['twitch', true, 'Ready', 'Ready', undefined],
      ['kick', false, 'Needs access', 'Reconnect Kick to let Buddy remove messages.', 'Reconnect'],
      [
        'x',
        false,
        'Needs access',
        'Authorize X Live to let Buddy remove messages.',
        'Authorize X Live'
      ]
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
