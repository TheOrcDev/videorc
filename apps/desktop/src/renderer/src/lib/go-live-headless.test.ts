import { describe, expect, it } from 'vitest'

import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  StreamMetadataDraft,
  StreamTargetSettings,
  StreamingSettings
} from './backend'
import { decideGoLiveCaptionsReadiness } from './captions-preflight'
import { goLiveConfirmGate } from './go-live-dialog-view'
import { streamingWithoutTargets } from './go-live-exclusions'
import {
  HEADLESS_GO_LIVE_COPY,
  decideHeadlessGoLive,
  decideHeadlessPartialSetup,
  headlessDraft,
  headlessExclusions
} from './go-live-headless'

// Plan 209 S10 (D13): `go_live` without the dialog decides on the dialog's
// own gate and refuses in the dialog's own words.

const NOW = '2026-10-27T12:00:00.000Z'

function target(
  id: string,
  platform: StreamTargetSettings['platform'],
  overrides: Partial<StreamTargetSettings> = {}
): StreamTargetSettings {
  return {
    id,
    platform,
    label: platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : 'Kick',
    enabled: true,
    serverUrl: 'rtmp://127.0.0.1/live',
    streamKey: '',
    streamKeyPresent: true,
    authMode: 'oauth',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function streaming(...targets: StreamTargetSettings[]): StreamingSettings {
  const enabled = targets.filter((entry) => entry.enabled).map((entry) => entry.id)
  return {
    enabled: enabled.length > 0,
    mode: enabled.length > 1 ? 'multi' : 'single',
    targets,
    enabledTargetIds: enabled
  } as unknown as StreamingSettings
}

function destination(
  targetId: string,
  overrides: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  const platform = targetId.startsWith('youtube')
    ? 'youtube'
    : targetId.startsWith('kick')
      ? 'kick'
      : 'twitch'
  return {
    targetId,
    platform,
    label: platform === 'youtube' ? 'YouTube' : platform === 'kick' ? 'Kick' : 'Twitch',
    authMode: 'oauth',
    ready: true,
    title: 'Building an MCP live',
    description: '',
    message: 'Ready for Go Live confirmation.',
    chatRead: 'ready',
    chatWrite: 'ready',
    chatMessage: '',
    ...overrides
  }
}

const draft: StreamMetadataDraft = {
  title: 'Building an MCP live',
  description: '',
  defaultPrivacy: 'private',
  targetOverrides: [],
  updatedAt: NOW
}

const ready = decideGoLiveCaptionsReadiness({
  persistedEnabled: false,
  suppressForSession: false,
  capabilities: null
})
// Captions on, and the deployment couldn't say they're ready: they block.
const captionsBlocked = decideGoLiveCaptionsReadiness({
  persistedEnabled: true,
  suppressForSession: false,
  capabilities: null
})
// The same, with "Go live without captions" pressed (`withoutCaptions`).
const captionsSkipped = decideGoLiveCaptionsReadiness({
  persistedEnabled: true,
  suppressForSession: true,
  capabilities: null
})
const allowed = { allowed: true } as const

const twoOn = streaming(target('youtube-1', 'youtube'), target('twitch-1', 'twitch'))

describe('go_live without the dialog (plan 209 S10, D13)', () => {
  it('confirms when the dialog would enable Go live', () => {
    const preflight: GoLivePreflight = {
      valid: true,
      destinations: [destination('youtube-1'), destination('twitch-1')],
      issues: []
    }
    const input = {
      preflight,
      draft,
      sentStreaming: twoOn,
      captionsReadiness: ready,
      entitlementGate: allowed,
      allowPartial: false
    }
    expect(decideHeadlessGoLive(input)).toEqual({ kind: 'confirm' })
    // The very gate the dialog disables its primary on.
    expect(goLiveConfirmGate(input).blocked).toBe(false)
  })

  it('refuses a partial setup with the blockers, and leaves them out with allowPartial', () => {
    const preflight: GoLivePreflight = {
      valid: false,
      destinations: [
        destination('youtube-1'),
        destination('twitch-1', {
          ready: false,
          message: 'Twitch needs a stream key. Add it in Livestream → Setup.'
        })
      ],
      issues: [
        {
          severity: 'error',
          targetId: 'twitch-1',
          platform: 'twitch',
          message: 'Twitch needs a stream key. Add it in Livestream → Setup.'
        }
      ]
    }
    const input = {
      preflight,
      draft,
      sentStreaming: twoOn,
      captionsReadiness: ready,
      entitlementGate: allowed,
      allowPartial: false
    }
    expect(goLiveConfirmGate(input).blocked).toBe(true)
    expect(decideHeadlessGoLive(input)).toEqual({
      kind: 'refuse',
      message: `Twitch: Twitch needs a stream key. Add it in Livestream → Setup. ${HEADLESS_GO_LIVE_COPY.allowPartialHint}`
    })
    // "Go live without Twitch", as the dialog's row offers.
    expect(decideHeadlessGoLive({ ...input, allowPartial: true })).toEqual({
      kind: 'exclude',
      targetIds: ['twitch-1']
    })
    // Once it is left out, the dialog's check on the rest goes live.
    const sent = streamingWithoutTargets(twoOn, ['twitch-1'])
    expect(
      decideHeadlessGoLive({
        ...input,
        sentStreaming: sent,
        preflight: { valid: true, destinations: [destination('youtube-1')], issues: [] }
      })
    ).toEqual({ kind: 'confirm' })
  })

  it('never goes partial when nothing is ready or the whole livestream is blocked', () => {
    const preflight: GoLivePreflight = {
      valid: false,
      destinations: [destination('twitch-1', { ready: false, message: 'Sign in to Twitch.' })],
      issues: [{ severity: 'error', message: 'This Go Live setup is part of Videorc Premium.' }]
    }
    const decision = decideHeadlessGoLive({
      preflight,
      draft,
      sentStreaming: streaming(target('twitch-1', 'twitch')),
      captionsReadiness: ready,
      entitlementGate: allowed,
      allowPartial: true
    })
    expect(decision).toEqual({
      kind: 'refuse',
      message: 'Twitch: Sign in to Twitch. This Go Live setup is part of Videorc Premium.'
    })
  })

  it('refuses captions that cannot start, and goes live without them with withoutCaptions', () => {
    const preflight: GoLivePreflight = {
      valid: true,
      destinations: [destination('youtube-1'), destination('twitch-1')],
      issues: []
    }
    const input = {
      preflight,
      draft,
      sentStreaming: twoOn,
      captionsReadiness: captionsBlocked,
      entitlementGate: allowed,
      allowPartial: true
    }
    expect(captionsBlocked.blocksStart).toBe(true)
    expect(decideHeadlessGoLive(input)).toEqual({
      kind: 'refuse',
      message: `Captions can't start: ${captionsBlocked.description} ${HEADLESS_GO_LIVE_COPY.withoutCaptionsHint}`
    })
    expect(decideHeadlessGoLive({ ...input, captionsReadiness: captionsSkipped })).toEqual({
      kind: 'confirm'
    })
  })

  it('refuses a sign-in blocker with the dialog sentence, even with allowPartial', () => {
    // A lone destination that needs the streamer: agents never connect accounts.
    const preflight: GoLivePreflight = {
      valid: false,
      destinations: [
        destination('youtube-1', {
          ready: false,
          accountLabel: undefined,
          message: 'Sign in to YouTube in Livestream → Setup, then go live.'
        })
      ],
      issues: [
        {
          severity: 'error',
          targetId: 'youtube-1',
          platform: 'youtube',
          message: 'Sign in to YouTube in Livestream → Setup, then go live.'
        }
      ]
    }
    for (const allowPartial of [false, true]) {
      expect(
        decideHeadlessGoLive({
          preflight,
          draft,
          sentStreaming: streaming(target('youtube-1', 'youtube')),
          captionsReadiness: ready,
          entitlementGate: allowed,
          allowPartial
        })
      ).toEqual({
        kind: 'refuse',
        message: 'YouTube: Sign in to YouTube in Livestream → Setup, then go live.'
      })
    }
  })

  it('refuses what the Title field would, and a Premium lock in its own words', () => {
    const preflight: GoLivePreflight = {
      valid: true,
      destinations: [destination('youtube-1')],
      issues: []
    }
    const base = {
      preflight,
      sentStreaming: streaming(target('youtube-1', 'youtube')),
      captionsReadiness: ready,
      entitlementGate: allowed,
      allowPartial: false
    }
    expect(decideHeadlessGoLive({ ...base, draft: { ...draft, title: '  ' } })).toEqual({
      kind: 'refuse',
      message: 'Add a title before you go live.'
    })
    expect(decideHeadlessGoLive({ ...base, draft: null })).toEqual({
      kind: 'refuse',
      message: HEADLESS_GO_LIVE_COPY.draftLoading
    })
    expect(
      decideHeadlessGoLive({
        ...base,
        draft,
        entitlementGate: {
          allowed: false,
          featureId: 'livestreaming',
          reason: 'Livestreaming is part of Videorc Premium.'
        }
      })
    ).toEqual({ kind: 'refuse', message: 'Livestreaming is part of Videorc Premium.' })
  })

  it('says so when no destination is on', () => {
    expect(
      decideHeadlessGoLive({
        preflight: { valid: false, destinations: [], issues: [] },
        draft,
        sentStreaming: streaming(),
        captionsReadiness: ready,
        entitlementGate: allowed,
        allowPartial: true
      })
    ).toEqual({ kind: 'refuse', message: HEADLESS_GO_LIVE_COPY.noDestination })
  })

  it('narrows to the named destinations, and never turns one on', () => {
    const saved = streaming(
      target('youtube-1', 'youtube'),
      target('twitch-1', 'twitch'),
      target('kick-1', 'kick', { enabled: false })
    )
    expect(headlessExclusions(saved, undefined)).toEqual({ ok: true, excludedTargetIds: [] })
    expect(headlessExclusions(saved, ['twitch-1'])).toEqual({
      ok: true,
      excludedTargetIds: ['youtube-1']
    })
    // A platform name works as well as an id.
    expect(headlessExclusions(saved, ['youtube'])).toEqual({
      ok: true,
      excludedTargetIds: ['twitch-1']
    })
    expect(headlessExclusions(saved, ['kick-1'])).toEqual({
      ok: false,
      message: 'Kick is off. Turn it on in Livestream → Setup first.'
    })
    expect(headlessExclusions(saved, ['facebook'])).toMatchObject({ ok: false })
  })

  it('goes out with the call title, and the saved draft otherwise', () => {
    expect(headlessDraft(draft, 'Episode 2')).toEqual({ ...draft, title: 'Episode 2' })
    expect(headlessDraft(draft, undefined)).toBe(draft)
    expect(headlessDraft(null, 'Episode 2')).toBeNull()
  })

  it('continues on the ready destinations after platform setup only with allowPartial', () => {
    const setup = {
      streaming: twoOn,
      failures: [
        {
          targetId: 'youtube-1',
          platform: 'youtube' as const,
          label: 'YouTube',
          message: "YouTube didn't create the broadcast."
        }
      ],
      readyLabels: ['Twitch']
    }
    expect(decideHeadlessPartialSetup(setup, true)).toEqual({ kind: 'continue' })
    expect(decideHeadlessPartialSetup(setup, false)).toEqual({
      kind: 'refuse',
      message: `Some destinations couldn't be set up. YouTube: YouTube. YouTube didn't create the broadcast. Ready: Twitch. ${HEADLESS_GO_LIVE_COPY.allowPartialHint}`
    })
  })
})
