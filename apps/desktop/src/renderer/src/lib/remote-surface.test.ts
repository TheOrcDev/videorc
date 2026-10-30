import { describe, expect, it, vi } from 'vitest'

import { createSoundboardStore } from './soundboard-store'
import {
  executeRemoteIntent,
  remoteLayoutLabels,
  RemoteSurfacePublisher,
  type RemoteIntentContext,
  type RemoteSurfaceValues
} from './remote-surface'

function remoteIntentContext(overrides: Partial<RemoteIntentContext> = {}) {
  const requests: Array<{ method: string; params: unknown }> = []
  const context: RemoteIntentContext = {
    client: {
      request: async (method, params) => {
        requests.push({ method, params })
        return undefined as never
      }
    },
    sessionActive: false,
    recordBlockedReason: null,
    liveStreamBlockedReason: null,
    startRecording: vi.fn(async () => true),
    startLivestream: vi.fn(async () => false),
    stopSession: vi.fn(async () => true),
    setMicrophoneMuted: vi.fn(async () => true),
    systemAudio: ['available', false],
    setSystemAudioEnabled: vi.fn(),
    knownLayoutPresets: ['screen-camera'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn(() => true),
    activateTakeover: vi.fn(async () => true),
    clearTakeover: vi.fn(async () => true),
    openWindow: vi.fn(async () => true),
    showCommentHighlight: vi.fn(async () => ({ ok: true })),
    clearCommentHighlight: vi.fn(async () => ({ ok: true })),
    markClip: vi.fn(async () => ({ ok: true })),
    replayOn: false,
    banners: [],
    ...overrides
  }
  return { context, requests }
}

describe('executeRemoteIntent', () => {
  it('turns system audio on, off or over from the state the remotes are shown (plan 069 S6)', async () => {
    const off = remoteIntentContext({ systemAudio: ['available', false] })
    await executeRemoteIntent(
      { intentId: 'sa-1', intent: { kind: 'systemAudioToggle' } },
      off.context
    )
    await executeRemoteIntent({ intentId: 'sa-2', intent: { kind: 'systemAudioOff' } }, off.context)
    const live = remoteIntentContext({ sessionActive: true, systemAudio: ['available', true] })
    await executeRemoteIntent(
      { intentId: 'sa-3', intent: { kind: 'systemAudioToggle' } },
      live.context
    )
    await executeRemoteIntent({ intentId: 'sa-4', intent: { kind: 'systemAudioOn' } }, live.context)

    expect(vi.mocked(off.context.setSystemAudioEnabled).mock.calls).toEqual([[true], [false]])
    expect(vi.mocked(live.context.setSystemAudioEnabled).mock.calls).toEqual([[false], [true]])
    for (const { requests } of [off, live]) {
      expect(requests.map(({ params }) => (params as { ok: boolean }).ok)).toEqual([true, true])
    }
    expect(off.context.setMicrophoneMuted).not.toHaveBeenCalled()
  })

  it('refuses every system-audio intent while the device cannot run', async () => {
    for (const status of ['permission-required', 'unavailable', undefined] as const) {
      const { context, requests } = remoteIntentContext({ systemAudio: [status, true] })
      for (const kind of ['systemAudioOn', 'systemAudioOff', 'systemAudioToggle']) {
        await executeRemoteIntent({ intentId: `sa-${kind}`, intent: { kind } }, context)
      }
      expect(context.setSystemAudioEnabled).not.toHaveBeenCalled()
      expect(requests.map(({ params }) => params)).toEqual(
        ['systemAudioOn', 'systemAudioOff', 'systemAudioToggle'].map((kind) => ({
          intentId: `sa-${kind}`,
          ok: false,
          message: "System audio isn't available."
        }))
      )
    }
  })

  it('lets a clip through on the ring alone, and names no replaySave intent (plan 181 R4)', async () => {
    // The ring holding frames is enough: no recording, the mark saves a clip.
    const on = remoteIntentContext({ replayOn: true })
    await executeRemoteIntent({ intentId: 'clip-ring', intent: { kind: 'clipMark' } }, on.context)
    expect(on.context.markClip).toHaveBeenCalledOnce()
    expect(on.requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'clip-ring', ok: true } }
    ])
    // The separate save intent is gone from the wire: unsupported, not a clip.
    const off = remoteIntentContext()
    await executeRemoteIntent({ intentId: 'rs-off', intent: { kind: 'replaySave' } }, off.context)
    expect(off.context.markClip).not.toHaveBeenCalled()
    expect(off.requests[0]?.params).toMatchObject({ intentId: 'rs-off', ok: false })
  })

  it('passes the clip length through, and refuses one nobody offers (plan 199)', async () => {
    // No length is today's 30-second clip: nothing extra is passed.
    const plain = remoteIntentContext({ replayOn: true })
    await executeRemoteIntent({ intentId: 'clip-30', intent: { kind: 'clipMark' } }, plain.context)
    expect(plain.context.markClip).toHaveBeenCalledWith(undefined)

    const long = remoteIntentContext({ replayOn: true })
    await executeRemoteIntent(
      { intentId: 'clip-60', intent: { kind: 'clipMark', seconds: 60 } },
      long.context
    )
    expect(long.context.markClip).toHaveBeenCalledWith(60)
    expect(long.requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'clip-60', ok: true } }
    ])

    const short = remoteIntentContext({ replayOn: true })
    await executeRemoteIntent(
      { intentId: 'clip-30n', intent: { kind: 'clipMark', seconds: 30 } },
      short.context
    )
    expect(short.context.markClip).toHaveBeenCalledWith(30)

    const nulled = remoteIntentContext({ replayOn: true })
    await executeRemoteIntent(
      { intentId: 'clip-null', intent: { kind: 'clipMark', seconds: null } },
      nulled.context
    )
    expect(nulled.context.markClip).toHaveBeenCalledWith(undefined)

    for (const seconds of [45, '60', 0, 120]) {
      const odd = remoteIntentContext({ replayOn: true })
      await executeRemoteIntent(
        { intentId: 'clip-odd', intent: { kind: 'clipMark', seconds } },
        odd.context
      )
      expect(odd.context.markClip).not.toHaveBeenCalled()
      expect(odd.requests).toEqual([
        {
          method: 'remote.intent.ack',
          params: { intentId: 'clip-odd', ok: false, message: 'A clip is 30 seconds or 1 minute.' }
        }
      ])
    }
  })

  it('marks a clip only while a session runs and relays the refusal reason (plan 068 D6)', async () => {
    const idle = remoteIntentContext()
    await executeRemoteIntent({ intentId: 'clip-idle', intent: { kind: 'clipMark' } }, idle.context)
    expect(idle.context.markClip).not.toHaveBeenCalled()
    expect(idle.requests).toEqual([
      {
        method: 'remote.intent.ack',
        params: {
          intentId: 'clip-idle',
          ok: false,
          message: "Clips are off, and you're not recording or live."
        }
      }
    ])

    const live = remoteIntentContext({ sessionActive: true })
    await executeRemoteIntent({ intentId: 'clip-live', intent: { kind: 'clipMark' } }, live.context)
    expect(live.context.markClip).toHaveBeenCalledOnce()
    expect(live.requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'clip-live', ok: true } }
    ])

    const unsaved = remoteIntentContext({
      sessionActive: true,
      markClip: vi.fn(async () => ({
        ok: false,
        message: "Recording is off, so this clip can't be saved."
      }))
    })
    await executeRemoteIntent(
      { intentId: 'clip-unsaved', intent: { kind: 'clipMark' } },
      unsaved.context
    )
    expect(unsaved.requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'clip-unsaved',
        ok: false,
        message: "Recording is off, so this clip can't be saved."
      }
    })
  })

  it('starts through the Studio handler and acknowledges success', async () => {
    const { context, requests } = remoteIntentContext()

    await executeRemoteIntent({ intentId: 'intent-1', intent: { kind: 'recordStart' } }, context)

    expect(context.startRecording).toHaveBeenCalledOnce()
    expect(context.startLivestream).not.toHaveBeenCalled()
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'intent-1', ok: true } }
    ])
  })

  // Plan 174 S3.1 (B-3): recordStart records and streamStart goes live,
  // whatever mode the Studio saved last. The start itself refuses (so the
  // Studio shows why); its reason rides on the failed ack for the deck key.
  it('calls the explicit intents and relays why a start is blocked', async () => {
    const live = remoteIntentContext()
    await executeRemoteIntent(
      { intentId: 'go-live', intent: { kind: 'streamStart' } },
      live.context
    )
    expect(live.context.startLivestream).toHaveBeenCalledOnce()
    expect(live.context.startRecording).not.toHaveBeenCalled()
    // Opening the Go Live dialog is not a started stream.
    expect(live.requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'go-live',
        ok: false,
        message: "The livestream didn't start. Finish going live on your computer."
      }
    })

    const blocked = remoteIntentContext({
      recordBlockedReason: 'Pick a screen or a camera first.',
      liveStreamBlockedReason: 'Set up a destination to go live.',
      startRecording: vi.fn(async () => false),
      startLivestream: vi.fn(async () => false)
    })
    for (const kind of ['recordStart', 'recordToggle', 'streamStart']) {
      await executeRemoteIntent({ intentId: `blocked-${kind}`, intent: { kind } }, blocked.context)
    }
    // One door: the Studio's own starts refuse, and show why there too.
    expect(blocked.context.startRecording).toHaveBeenCalledTimes(2)
    expect(blocked.context.startLivestream).toHaveBeenCalledOnce()
    expect(blocked.requests.map(({ params }) => params)).toEqual([
      { intentId: 'blocked-recordStart', ok: false, message: 'Pick a screen or a camera first.' },
      { intentId: 'blocked-recordToggle', ok: false, message: 'Pick a screen or a camera first.' },
      { intentId: 'blocked-streamStart', ok: false, message: 'Set up a destination to go live.' }
    ])

    // While a session runs the blocked reasons are moot: recordToggle stops it.
    const active = remoteIntentContext({
      sessionActive: true,
      recordBlockedReason: 'A capture session is already active.'
    })
    await executeRemoteIntent(
      { intentId: 'toggle-stop', intent: { kind: 'recordToggle' } },
      active.context
    )
    expect(active.context.stopSession).toHaveBeenCalledOnce()
    expect(active.requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: { intentId: 'toggle-stop', ok: true }
    })
  })

  it('rejects invalid scene presets without applying them', async () => {
    const { context, requests } = remoteIntentContext()

    await executeRemoteIntent(
      { intentId: 'intent-2', intent: { kind: 'sceneApply', layoutPreset: 'unknown' } },
      context
    )

    expect(context.applyLayoutPreset).not.toHaveBeenCalled()
    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: { intentId: 'intent-2', ok: false, message: "That scene isn't available anymore." }
    })
  })

  it('acknowledges a scene only after its backend commit resolves', async () => {
    let resolveCommit: ((committed: boolean) => void) | undefined
    const commit = new Promise<boolean>((resolve) => {
      resolveCommit = resolve
    })
    const { context, requests } = remoteIntentContext({
      applyLayoutPreset: vi.fn(() => commit)
    })

    const execution = executeRemoteIntent(
      { intentId: 'intent-scene', intent: { kind: 'sceneApply', layoutPreset: 'screen-camera' } },
      context
    )
    await Promise.resolve()
    expect(requests).toEqual([])

    resolveCommit?.(true)
    await execution
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'intent-scene', ok: true } }
    ])
  })

  it('reports a scene commit failure instead of acknowledging admission', async () => {
    const { context, requests } = remoteIntentContext({
      applyLayoutPreset: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      {
        intentId: 'intent-scene-failed',
        intent: { kind: 'sceneApply', layoutPreset: 'screen-camera' }
      },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-scene-failed',
        ok: false,
        message: "Couldn't switch the scene."
      }
    })
  })

  it('rejects a start that returns without an authoritative session commit', async () => {
    const { context, requests } = remoteIntentContext({
      startRecording: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      { intentId: 'intent-start-not-committed', intent: { kind: 'recordStart' } },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-start-not-committed',
        ok: false,
        message: "Recording didn't start. Check Studio on your computer."
      }
    })
  })

  it('rejects a stop that returns without an authoritative session commit', async () => {
    const { context, requests } = remoteIntentContext({
      sessionActive: true,
      stopSession: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      { intentId: 'intent-stop-not-committed', intent: { kind: 'recordStop' } },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-stop-not-committed',
        ok: false,
        message: "Couldn't stop. Check Studio on your computer."
      }
    })
  })

  it('acks false when takeover activation completes without an authoritative commit', async () => {
    const { context, requests } = remoteIntentContext({
      activateTakeover: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      { intentId: 'intent-takeover-failed', intent: { kind: 'takeoverShow', assetId: 'screen-1' } },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-takeover-failed',
        ok: false,
        message: "Couldn't show the takeover."
      }
    })
  })

  it('acks false when takeover clear cannot be authoritatively reconciled', async () => {
    const { context, requests } = remoteIntentContext({
      clearTakeover: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      { intentId: 'intent-takeover-clear-failed', intent: { kind: 'takeoverHide' } },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-takeover-clear-failed',
        ok: false,
        message: "Couldn't hide the takeover."
      }
    })
  })

  it('acknowledges a microphone change only after authoritative settlement', async () => {
    let resolveSettlement: ((applied: boolean) => void) | undefined
    const settlement = new Promise<boolean>((resolve) => {
      resolveSettlement = resolve
    })
    const { context, requests } = remoteIntentContext({
      setMicrophoneMuted: vi.fn(() => settlement)
    })

    const execution = executeRemoteIntent(
      { intentId: 'intent-mic', intent: { kind: 'micToggle' } },
      context
    )
    await Promise.resolve()
    expect(context.setMicrophoneMuted).toHaveBeenCalledWith('toggle')
    expect(requests).toEqual([])

    resolveSettlement?.(true)
    await execution
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'intent-mic', ok: true } }
    ])
  })

  it('acks false when the microphone change cannot be authoritatively matched', async () => {
    const { context, requests } = remoteIntentContext({
      setMicrophoneMuted: vi.fn(async () => false)
    })

    await executeRemoteIntent(
      { intentId: 'intent-mic-rejected', intent: { kind: 'micMute' } },
      context
    )

    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: {
        intentId: 'intent-mic-rejected',
        ok: false,
        message: "Couldn't change the microphone."
      }
    })
  })

  it('forwards microphone toggles and action failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { context, requests } = remoteIntentContext({
      startRecording: vi.fn(async () => {
        throw new Error('start rejected')
      })
    })

    await executeRemoteIntent({ intentId: 'intent-3', intent: { kind: 'micToggle' } }, context)
    await executeRemoteIntent({ intentId: 'intent-4', intent: { kind: 'recordStart' } }, context)

    expect(context.setMicrophoneMuted).toHaveBeenCalledWith('toggle')
    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      // The raw error goes to the console; the phone reads plain words.
      params: {
        intentId: 'intent-4',
        ok: false,
        message: 'Something went wrong. Check Studio on your computer.'
      }
    })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('shows a comment by id and relays the refusal reason verbatim', async () => {
    const { context, requests } = remoteIntentContext({
      showCommentHighlight: vi.fn(async (messageId: string) =>
        messageId === 'youtube:1'
          ? { ok: true }
          : { ok: false, message: 'That comment is no longer available.' }
      )
    })

    await executeRemoteIntent(
      { intentId: 'intent-h1', intent: { kind: 'commentHighlight', messageId: 'youtube:1' } },
      context
    )
    await executeRemoteIntent(
      { intentId: 'intent-h2', intent: { kind: 'commentHighlight', messageId: 'youtube:gone' } },
      context
    )
    await executeRemoteIntent(
      { intentId: 'intent-h3', intent: { kind: 'commentHighlight' } },
      context
    )

    expect(context.showCommentHighlight).toHaveBeenCalledTimes(2)
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'intent-h1', ok: true } },
      {
        method: 'remote.intent.ack',
        params: {
          intentId: 'intent-h2',
          ok: false,
          message: 'That comment is no longer available.'
        }
      },
      {
        method: 'remote.intent.ack',
        params: { intentId: 'intent-h3', ok: false, message: 'Choose a message to put on stream.' }
      }
    ])
  })

  it('clears the on-stream comment', async () => {
    const { context, requests } = remoteIntentContext()

    await executeRemoteIntent(
      { intentId: 'intent-h4', intent: { kind: 'commentHighlightClear' } },
      context
    )

    expect(context.clearCommentHighlight).toHaveBeenCalledOnce()
    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: { intentId: 'intent-h4', ok: true }
    })
  })
})

describe('RemoteSurfacePublisher', () => {
  const values = (
    systemAudioStatus: RemoteSurfaceValues[12],
    systemAudioShown: boolean
  ): RemoteSurfaceValues => [
    'idle',
    false,
    true,
    false,
    false,
    'screen-camera',
    null,
    false,
    false,
    false,
    ['screen-camera'],
    [],
    systemAudioStatus,
    systemAudioShown,
    []
  ]

  it('projects system audio as two booleans, masked while the device cannot run', async () => {
    vi.useFakeTimers()
    try {
      const published: unknown[] = []
      const publisher = new RemoteSurfacePublisher()
      publisher.attach({
        request: async (_method, params) => {
          published.push(params)
          return undefined as never
        }
      })
      publisher.markConnected()
      for (const [status, shown] of [
        ['available', true],
        ['permission-required', true],
        ['available', false],
        [undefined, false]
      ] as const) {
        publisher.syncValues(values(status, shown))
        await vi.runAllTimersAsync()
      }
      const states = published.map(
        (snapshot) => (snapshot as { state: Record<string, unknown> }).state
      )
      expect(
        states.map(({ systemAudioOn, systemAudioAvailable }) => [
          systemAudioOn,
          systemAudioAvailable
        ])
      ).toEqual([
        [true, true],
        [false, false],
        [false, true],
        [false, false]
      ])
      // The phone learns an on/off and an available flag: never the status
      // string, the device id or its name.
      expect(JSON.stringify(published)).not.toMatch(/permission-required|system-audio:/)
      publisher.detach()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('remoteLayoutLabels (plan 174 I-14)', () => {
  it('names each preset as the desktop does, never a title-cased id', () => {
    expect(remoteLayoutLabels(['screen-camera', 'side-by-side'])).toEqual({
      'screen-camera': 'Screen + camera',
      'side-by-side': 'Side by side'
    })
    // The phone lists both orientations together, so the vertical twins say so.
    expect(
      remoteLayoutLabels(['screen-camera', 'vertical-screen-camera', 'vertical-split'])
    ).toEqual({
      'screen-camera': 'Screen + camera',
      'vertical-screen-camera': 'Vertical screen + camera',
      'vertical-split': 'Split'
    })
  })

  it('rides along in describe and carries only fixed preset names', async () => {
    vi.useFakeTimers()
    try {
      const published: unknown[] = []
      const publisher = new RemoteSurfacePublisher()
      publisher.attach({
        request: async (_method, params) => {
          published.push(params)
          return undefined as never
        }
      })
      publisher.markConnected()
      publisher.syncValues([
        'idle',
        false,
        true,
        false,
        false,
        'screen-camera',
        null,
        false,
        false,
        false,
        ['screen-camera', 'camera-only'],
        [{ id: 'brb', name: 'Be right back' }],
        undefined,
        false,
        []
      ])
      await vi.runAllTimersAsync()
      const [{ describe: described }] = published as Array<{
        describe: { layoutLabels: Record<string, string> }
      }>
      expect(described.layoutLabels).toEqual({
        'screen-camera': 'Screen + camera',
        'camera-only': 'Camera only'
      })
      publisher.detach()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('banner intents (plan 186 S7)', () => {
  const banners = [
    { id: 'sponsor', name: 'Sponsor', shown: true },
    { id: 'follow', name: 'Follow me', shown: false }
  ]
  const acks = (requests: Array<{ method: string; params: unknown }>) =>
    requests.filter(({ method }) => method === 'remote.intent.ack').map(({ params }) => params)
  const calls = (requests: Array<{ method: string; params: unknown }>) =>
    requests
      .filter(({ method }) => method.startsWith('banners.'))
      .map(({ method, params }) => [method, params])

  it('shows, hides and toggles by id through the explicit backend calls', async () => {
    const { context, requests } = remoteIntentContext({ banners })
    for (const [intentId, intent] of [
      ['b-1', { kind: 'bannerShow', bannerId: 'follow' }],
      ['b-2', { kind: 'bannerHide', bannerId: 'sponsor' }],
      // A toggle picks its verb from the state the remotes are shown.
      ['b-3', { kind: 'bannerToggle', bannerId: 'sponsor' }],
      ['b-4', { kind: 'bannerToggle', bannerId: 'follow' }],
      // Without an id, hide hides them all.
      ['b-5', { kind: 'bannerHide' }]
    ] as const) {
      await executeRemoteIntent({ intentId, intent }, context)
    }
    expect(calls(requests)).toEqual([
      ['banners.show', { id: 'follow' }],
      ['banners.hide', { id: 'sponsor' }],
      ['banners.hide', { id: 'sponsor' }],
      ['banners.show', { id: 'follow' }],
      ['banners.hide', {}]
    ])
    expect(acks(requests)).toEqual(
      ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'].map((intentId) => ({ intentId, ok: true }))
    )
  })

  it('refuses a banner the list no longer has without calling the backend', async () => {
    const { context, requests } = remoteIntentContext({ banners })
    for (const [intentId, intent] of [
      ['gone-1', { kind: 'bannerShow', bannerId: 'deleted' }],
      ['gone-2', { kind: 'bannerToggle', bannerId: 'deleted' }],
      ['gone-3', { kind: 'bannerHide', bannerId: 'deleted' }],
      ['gone-4', { kind: 'bannerShow' }]
    ] as const) {
      await executeRemoteIntent({ intentId, intent }, context)
    }
    expect(calls(requests)).toEqual([])
    expect(acks(requests)).toEqual(
      ['gone-1', 'gone-2', 'gone-3', 'gone-4'].map((intentId) => ({
        intentId,
        ok: false,
        message: "That banner isn't available anymore."
      }))
    )
  })

  it("relays the backend's refusal verbatim and says plainly when anything else fails", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent: Array<{ method: string; params: unknown }> = []
    const failing = (error: Error): RemoteIntentContext['client'] => ({
      request: async (method, params) => {
        sent.push({ method, params })
        if (method.startsWith('banners.')) throw error
        return undefined as never
      }
    })
    const refused = remoteIntentContext({
      banners,
      client: failing(new Error('Four banners are showing. Hide one first.'))
    })
    await executeRemoteIntent(
      { intentId: 'full', intent: { kind: 'bannerShow', bannerId: 'follow' } },
      refused.context
    )
    const broken = remoteIntentContext({ banners, client: failing(new Error('socket closed')) })
    await executeRemoteIntent(
      { intentId: 'show-broken', intent: { kind: 'bannerShow', bannerId: 'follow' } },
      broken.context
    )
    await executeRemoteIntent(
      { intentId: 'hide-broken', intent: { kind: 'bannerToggle', bannerId: 'sponsor' } },
      broken.context
    )
    await executeRemoteIntent(
      { intentId: 'all-broken', intent: { kind: 'bannerHide' } },
      broken.context
    )
    expect(acks(sent)).toEqual([
      { intentId: 'full', ok: false, message: 'Four banners are showing. Hide one first.' },
      { intentId: 'show-broken', ok: false, message: "Couldn't show the banner." },
      { intentId: 'hide-broken', ok: false, message: "Couldn't hide the banner." },
      { intentId: 'all-broken', ok: false, message: "Couldn't hide the banners." }
    ])
    vi.mocked(console.warn).mockRestore()
  })

  it('describes banners as id, name and shown only, never a file or a place', async () => {
    vi.useFakeTimers()
    try {
      const published: unknown[] = []
      const publisher = new RemoteSurfacePublisher()
      publisher.attach({
        request: async (_method, params) => {
          published.push(params)
          return undefined as never
        }
      })
      publisher.markConnected()
      // Studio hands over its whole banner list; describe keeps three fields.
      const full = {
        id: 'sponsor',
        name: 'Sponsor',
        shown: true,
        imageFile: 'sponsor.png',
        thumbnailFile: 'sponsor.thumb.png',
        horizontal: { x: 0, y: 0, w: 1, h: 1 }
      }
      publisher.syncValues([
        'idle',
        false,
        true,
        false,
        false,
        'screen-camera',
        null,
        false,
        false,
        false,
        ['screen-camera'],
        [],
        undefined,
        false,
        [full]
      ])
      await vi.runAllTimersAsync()
      const [{ describe: described }] = published as Array<{
        describe: { banners: unknown }
      }>
      expect(described.banners).toEqual([{ id: 'sponsor', name: 'Sponsor', shown: true }])
      expect(JSON.stringify(published)).not.toMatch(/\.png|horizontal/)
      publisher.detach()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sounds on the remotes (plan 189 S10)', () => {
  const sounds = [{ id: 'airhorn' }, { id: 'applause' }]
  const calls = (requests: Array<{ method: string; params: unknown }>) =>
    requests
      .filter(({ method }) => method !== 'remote.intent.ack')
      .map(({ method, params }) => [method, params])
  const acks = (requests: Array<{ method: string; params: unknown }>) =>
    requests.filter(({ method }) => method === 'remote.intent.ack').map(({ params }) => params)

  it('presses a sound by id, stops one, and stops them all without an id', async () => {
    const { context, requests } = remoteIntentContext({ sounds })
    for (const [intentId, intent] of [
      ['s-1', { kind: 'soundPlay', soundId: 'airhorn' }],
      ['s-2', { kind: 'soundStop', soundId: 'applause' }],
      ['s-3', { kind: 'soundStop' }]
    ] as const) {
      await executeRemoteIntent({ intentId, intent }, context)
    }
    expect(calls(requests)).toEqual([
      ['sounds.press', { id: 'airhorn' }],
      ['sounds.stop', { id: 'applause' }],
      ['sounds.stop', {}]
    ])
    expect(acks(requests)).toEqual(
      ['s-1', 's-2', 's-3'].map((intentId) => ({ intentId, ok: true }))
    )
  })

  it('refuses a sound the board no longer has, or a play with no sound, without the backend', async () => {
    const { context, requests } = remoteIntentContext({ sounds })
    for (const [intentId, intent] of [
      ['gone-1', { kind: 'soundPlay', soundId: 'deleted' }],
      ['gone-2', { kind: 'soundStop', soundId: 'deleted' }],
      ['gone-3', { kind: 'soundPlay' }]
    ] as const) {
      await executeRemoteIntent({ intentId, intent }, context)
    }
    expect(calls(requests)).toEqual([])
    expect(acks(requests)).toEqual(
      ['gone-1', 'gone-2', 'gone-3'].map((intentId) => ({
        intentId,
        ok: false,
        message: "That sound isn't available anymore."
      }))
    )
  })

  it("sends a refusal's own sentence back, and the plain words for anything else", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = remoteIntentContext({
      sounds,
      client: {
        request: async (method, params) => {
          if (method === 'sounds.press') throw new Error('This file is silent.')
          if (method === 'sounds.stop') throw new Error('bus gone')
          refused.requests.push({ method, params })
          return undefined as never
        }
      }
    })
    await executeRemoteIntent(
      { intentId: 'r-1', intent: { kind: 'soundPlay', soundId: 'airhorn' } },
      refused.context
    )
    await executeRemoteIntent({ intentId: 'r-2', intent: { kind: 'soundStop' } }, refused.context)
    expect(acks(refused.requests)).toEqual([
      { intentId: 'r-1', ok: false, message: 'This file is silent.' },
      { intentId: 'r-2', ok: false, message: "Couldn't stop the sounds." }
    ])
    vi.mocked(console.warn).mockRestore()
  })

  it('describes the board as id, name and playing only, and follows it as it changes', async () => {
    vi.useFakeTimers()
    try {
      const published: unknown[] = []
      const store = createSoundboardStore()
      const publisher = new RemoteSurfacePublisher(store)
      publisher.attach({
        request: async (_method, params) => {
          published.push(params)
          return undefined as never
        }
      })
      publisher.markConnected()
      publisher.syncValues([
        'idle',
        false,
        true,
        false,
        false,
        'screen-camera',
        null,
        false,
        false,
        false,
        ['screen-camera'],
        [],
        undefined,
        false,
        []
      ])
      await vi.runAllTimersAsync()
      const described = () =>
        (published.at(-1) as { describe: { sounds: unknown } }).describe.sounds
      expect(described()).toEqual([])
      store.acceptBoard({
        sounds: [
          {
            id: 'airhorn',
            name: 'Airhorn',
            file: 'airhorn.wav',
            durationMs: 1610,
            loudnessLufs: -15,
            levelDb: -3,
            volumeDb: 0,
            mode: 'oneShot',
            hotkey: '1',
            starter: 'airhorn',
            sortOrder: 0,
            createdAt: '2026-10-23T09:00:00Z',
            updatedAt: '2026-10-23T09:00:00Z'
          }
        ],
        volumeDb: 0,
        monitor: true,
        startersSeeded: true
      })
      store.acceptPlayback({
        voices: [
          {
            voiceId: 'v-1',
            soundId: 'airhorn',
            startedAtMs: 1,
            durationMs: 1610,
            loop: false,
            onAir: true
          }
        ]
      })
      await vi.runAllTimersAsync()
      expect(described()).toEqual([{ id: 'airhorn', name: 'Airhorn', playing: true }])
      // Names only: no file, path or voice ever reaches a remote.
      expect(JSON.stringify(published)).not.toMatch(/\.wav|v-1|levelDb/)
      publisher.detach()
      store.acceptPlayback({ voices: [] })
      await vi.runAllTimersAsync()
      expect(described()).toEqual([{ id: 'airhorn', name: 'Airhorn', playing: true }])
    } finally {
      vi.useRealTimers()
    }
  })
})

it('projects saved scenes with only ids and names', async () => {
  vi.useFakeTimers()
  try {
    const requests: unknown[] = []
    const publisher = new RemoteSurfacePublisher()
    publisher.attach({
      request: async (_method, params) => {
        requests.push(params)
        return undefined as never
      }
    })
    publisher.markConnected()
    const scene = { id: 'figma', name: 'Figma', visual: { privatePath: '/private' } }
    publisher.syncValues([
      'idle',
      false,
      true,
      false,
      false,
      'screen-only',
      null,
      false,
      false,
      false,
      [],
      [],
      undefined,
      false,
      [],
      [scene],
      'figma'
    ])
    await vi.runAllTimersAsync()
    expect(requests.at(-1)).toMatchObject({
      state: { savedScenes: [{ id: 'figma', name: 'Figma' }], activeSavedSceneId: 'figma' }
    })
    expect(JSON.stringify(requests)).not.toContain('privatePath')
    publisher.detach()
  } finally {
    vi.useRealTimers()
  }
})
