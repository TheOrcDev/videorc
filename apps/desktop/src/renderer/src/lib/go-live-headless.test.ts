import { describe, expect, it, vi } from 'vitest'

import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  StreamMetadataDraft,
  StreamTargetSettings,
  StreamingSettings
} from './backend'
import { defaultCaptureConfig } from './capture'
import { decideGoLiveCaptionsReadiness } from './captions-preflight'
import { DEFAULT_BASIC_ENTITLEMENTS } from './entitlements'
import { goLiveConfirmGate } from './go-live-dialog-view'
import { streamingWithoutTargets } from './go-live-exclusions'
import { LIVESTREAM_STILL_SETTLING } from './go-live-flow'
import {
  HEADLESS_GO_LIVE_COPY,
  decideHeadlessGoLive,
  decideHeadlessPartialSetup,
  goLiveWithoutDialog,
  headlessDraft,
  headlessExclusions,
  type GoLiveConfirmOutcome,
  type HeadlessGoLiveStudio
} from './go-live-headless'
import { START_BLOCKED_COPY } from './start-blocked-copy'

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

// The orchestration the Studio hands its handlers to (moved out of the eager
// Studio bundle): what it refuses before the dialog's preflight runs, and how
// the preflight and confirm it drives own the transport.
describe('goLiveWithoutDialog (plan 209 S10, D13)', () => {
  function studio(overrides: Partial<HeadlessGoLiveStudio> = {}): HeadlessGoLiveStudio {
    const preflight: GoLivePreflight = {
      valid: true,
      destinations: [destination('youtube-1'), destination('twitch-1')],
      issues: []
    }
    return {
      connected: true,
      wsStatus: 'connected',
      recording: { state: 'idle', message: 'Ready.' },
      dialogOpen: false,
      goLiveConfirmationPending: false,
      startRequestPending: false,
      openGoLiveConfirmationInFlightRef: { current: null },
      confirmGoLiveInFlightPromiseRef: { current: null },
      sessionStartInFlightRef: { current: null },
      config: { ...defaultCaptureConfig, streaming: twoOn },
      streamMetadataDraft: draft,
      captionsPlatformUnavailable: null,
      goLiveCaptionOutputReadiness: undefined,
      entitlements: DEFAULT_BASIC_ENTITLEMENTS,
      setGoLiveConfirmationPending: vi.fn(),
      setSuppressCaptionsForSession: vi.fn(),
      runGoLivePreflight: vi.fn(async () => ({
        kind: 'ready' as const,
        preflight,
        draft,
        capabilities: null
      })),
      revalidateGoLive: vi.fn(async () => preflight),
      runGoLiveConfirmation: vi.fn(
        async (): Promise<GoLiveConfirmOutcome> => ({
          kind: 'started',
          started: true,
          streaming: twoOn
        })
      ),
      settlePreparedPlatformLifecycle: vi.fn(async () => undefined),
      startOnReadyDestinations: vi.fn(async () => true),
      ...overrides
    }
  }

  it('refuses before the preflight when the Studio cannot go live now', async () => {
    const cases: [Partial<HeadlessGoLiveStudio>, string][] = [
      [{ connected: false, wsStatus: 'connecting' }, "Starting Videorc's capture engine…"],
      [
        { recording: { state: 'recording', message: 'Recording.' } },
        START_BLOCKED_COPY.sessionRunning
      ],
      [{ dialogOpen: true }, HEADLESS_GO_LIVE_COPY.dialogOpen],
      [{ goLiveConfirmationPending: true }, HEADLESS_GO_LIVE_COPY.inFlight],
      [
        { openGoLiveConfirmationInFlightRef: { current: Promise.resolve() } },
        HEADLESS_GO_LIVE_COPY.inFlight
      ],
      [{ sessionStartInFlightRef: { current: {} } }, HEADLESS_GO_LIVE_COPY.inFlight]
    ]
    for (const [overrides, message] of cases) {
      const fake = studio(overrides)
      expect(await goLiveWithoutDialog({}, fake)).toEqual({ ok: false, message })
      expect(fake.runGoLivePreflight).not.toHaveBeenCalled()
    }
  })

  it("owns the transport for the dialog's preflight and releases it", async () => {
    let release: () => void = () => undefined
    const fake = studio({
      runGoLivePreflight: vi.fn(
        () =>
          new Promise<{ kind: 'refused'; reason: string }>((resolve) => {
            release = () => resolve({ kind: 'refused', reason: 'Turn on a destination.' })
          })
      )
    })
    const outcome = goLiveWithoutDialog({ title: 'From the agent' }, fake)
    await vi.waitFor(() => expect(fake.runGoLivePreflight).toHaveBeenCalled())
    // Record, ⌘K and the remotes wait while it checks (B-7).
    expect(fake.setGoLiveConfirmationPending).toHaveBeenLastCalledWith(true)
    expect(fake.openGoLiveConfirmationInFlightRef.current).not.toBeNull()
    // The call's title rides the draft the preflight saves.
    expect(vi.mocked(fake.runGoLivePreflight).mock.calls[0]?.[2]).toEqual({
      ...draft,
      title: 'From the agent'
    })
    release()
    expect(await outcome).toEqual({ ok: false, message: 'Turn on a destination.' })
    expect(fake.setGoLiveConfirmationPending).toHaveBeenLastCalledWith(false)
    expect(fake.openGoLiveConfirmationInFlightRef.current).toBeNull()
    expect(fake.runGoLiveConfirmation).not.toHaveBeenCalled()
  })

  it('says the last livestream is still settling', async () => {
    const fake = studio({ runGoLivePreflight: vi.fn(async () => ({ kind: 'settling' as const })) })
    expect(await goLiveWithoutDialog({}, fake)).toEqual({
      ok: false,
      message: LIVESTREAM_STILL_SETTLING
    })
  })

  it("confirms through the dialog's own confirm and reports where it went live", async () => {
    const fake = studio()
    expect(await goLiveWithoutDialog({ withoutCaptions: true }, fake)).toEqual({
      ok: true,
      destinations: [
        { id: 'youtube-1', platform: 'youtube', label: 'YouTube' },
        { id: 'twitch-1', platform: 'twitch', label: 'Twitch' }
      ],
      recording: defaultCaptureConfig.recordEnabled
    })
    expect(fake.setSuppressCaptionsForSession).toHaveBeenCalledWith(true)
    expect(fake.runGoLiveConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ excludedTargetIds: [], draft, suppressCaptions: true })
    )
  })

  // Review fix 1: Stop agents while it checks or sets up never goes live.
  it('stops before it confirms or starts once the call is cancelled', async () => {
    let cancelled = false
    const before = studio({
      runGoLivePreflight: vi.fn(async () => {
        cancelled = true
        return {
          kind: 'ready' as const,
          preflight: {
            valid: true,
            destinations: [destination('youtube-1'), destination('twitch-1')],
            issues: []
          },
          draft,
          capabilities: null
        }
      })
    })
    expect(await goLiveWithoutDialog({ cancelled: () => cancelled }, before)).toEqual({
      ok: false,
      message: HEADLESS_GO_LIVE_COPY.cancelled
    })
    expect(before.runGoLiveConfirmation).not.toHaveBeenCalled()

    // Cancelled during platform setup: the confirm stops before the start
    // and what was prepared is cleaned up.
    let stop = false
    const during = studio({
      runGoLiveConfirmation: vi.fn(async (confirmation): Promise<GoLiveConfirmOutcome> => {
        stop = true // Stop agents, pressed during platform setup
        return confirmation.cancelled?.()
          ? { kind: 'cancelled', streaming: twoOn }
          : { kind: 'started', started: true, streaming: twoOn }
      })
    })
    expect(await goLiveWithoutDialog({ cancelled: () => stop }, during)).toEqual({
      ok: false,
      message: HEADLESS_GO_LIVE_COPY.cancelled
    })
    expect(during.settlePreparedPlatformLifecycle).toHaveBeenCalledWith(twoOn)

    // A partial setup the call would continue: cancelled, cleaned up instead.
    const setup = {
      streaming: twoOn,
      failures: [
        { targetId: 'twitch-1', platform: 'twitch' as const, label: 'Twitch', message: 'Offline.' }
      ],
      readyLabels: ['YouTube']
    }
    let late = false
    const partial = studio({
      runGoLiveConfirmation: vi.fn(async (): Promise<GoLiveConfirmOutcome> => {
        late = true
        return { kind: 'partial', setup }
      })
    })
    expect(
      await goLiveWithoutDialog({ allowPartial: true, cancelled: () => late }, partial)
    ).toEqual({ ok: false, message: HEADLESS_GO_LIVE_COPY.cancelled })
    expect(partial.startOnReadyDestinations).not.toHaveBeenCalled()
    expect(partial.settlePreparedPlatformLifecycle).toHaveBeenCalledWith(twoOn)
  })

  it('refuses a partial setup without allowPartial and cleans up what was prepared', async () => {
    const setup = {
      streaming: twoOn,
      failures: [
        { targetId: 'twitch-1', platform: 'twitch' as const, label: 'Twitch', message: 'Offline.' }
      ],
      readyLabels: ['YouTube']
    }
    const fake = studio({
      runGoLiveConfirmation: vi.fn(
        async (): Promise<GoLiveConfirmOutcome> => ({
          kind: 'partial',
          setup
        })
      )
    })
    const outcome = await goLiveWithoutDialog({}, fake)
    expect(outcome.ok).toBe(false)
    expect(fake.settlePreparedPlatformLifecycle).toHaveBeenCalledWith(twoOn)
    expect(fake.startOnReadyDestinations).not.toHaveBeenCalled()

    const partial = studio({
      runGoLiveConfirmation: vi.fn(
        async (): Promise<GoLiveConfirmOutcome> => ({
          kind: 'partial',
          setup
        })
      )
    })
    expect((await goLiveWithoutDialog({ allowPartial: true }, partial)).ok).toBe(true)
    expect(partial.startOnReadyDestinations).toHaveBeenCalledWith({
      setup,
      suppressCaptions: false
    })
  })
})
