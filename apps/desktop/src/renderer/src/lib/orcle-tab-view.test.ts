import { describe, expect, it } from 'vitest'

import type { CohostState } from './backend'
import { orcleLiveSettingsPatch } from './cohost-state'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  CLOUD_AI_KEEPS,
  CLOUD_AI_USES,
  ORCLE_CONSENT_OFF_REASON,
  ORCLE_LIVE_POWERS,
  ORCLE_LIVE_STATUS_LABELS,
  ORCLE_SIGNED_OUT_REASON,
  ORCLE_TAB_DESCRIPTION,
  orcleLiveUnlock,
  orcleLiveView,
  type OrcleLiveViewInput
} from './orcle-tab-view'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Orcle requires Videorc Premium.',
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

describe('Orcle tab copy (plan 119 S2)', () => {
  it('introduces the page and names the three powers', () => {
    expect(ORCLE_TAB_DESCRIPTION).toBe('Live with you. Edits after.')
    expect(ORCLE_LIVE_POWERS.map((power) => power.title)).toEqual([
      'Never miss a question',
      'Chat stays safe',
      'The room, handled'
    ])
  })

  it('keeps every line plain: no em dash, sentence case, a full stop', () => {
    const lines = [
      ORCLE_TAB_DESCRIPTION,
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
      'Orcle reads your live chat.',
      "Orcle hears you while you're live: your microphone audio goes to Videorc's cloud speech-to-text and comes back as text.",
      "Clean cut uploads a recording's audio, never the video, in short chunks for a word-by-word transcript, and sends its sentences to Videorc's cloud AI to find retakes. Neither is kept on Videorc servers after the job finishes."
    ])
    expect(CLOUD_AI_KEEPS).toContain("Videorc servers don't keep your chat or your audio.")
    expect(CLOUD_AI_KEEPS).toContain('A short report of each stream is saved on this computer.')
  })
})

describe('orcleLiveSettingsPatch', () => {
  it('turns Orcle on with listening in one patch, and off without touching listening', () => {
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
      reason: 'Orcle requires Videorc Premium.'
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
      reason: 'Orcle paused: daily AI quota is used up.'
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
      reason: 'Orcle stopped: Videorc AI returned an error.',
      detail: 'ai-gateway-error (HTTP 502): Every model failed.'
    })

    expect(
      orcleLiveView(input({ live: true, state: engine({ status: 'error', reason: null }) })).status
        .reason
    ).toBe('Orcle hit an error.')
  })

  it('needs attention when cloud AI was revoked with Orcle still on', () => {
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
      reason: 'Orcle requires Videorc Premium.'
    })
  })

  it('waits for the backend before the switch can move', () => {
    const view = orcleLiveView(input({ settings: null }))
    expect(view.switchDisabled).toBe(true)
    expect(view.checked).toBe(false)
    expect(view.status.kind).toBe('off')
  })
})
