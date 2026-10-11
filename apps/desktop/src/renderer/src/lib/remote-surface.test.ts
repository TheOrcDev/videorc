import { describe, expect, it, vi } from 'vitest'

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

  it('marks a clip only while a session runs and relays the refusal reason (plan 068 D6)', async () => {
    const idle = remoteIntentContext()
    await executeRemoteIntent({ intentId: 'clip-idle', intent: { kind: 'clipMark' } }, idle.context)
    expect(idle.context.markClip).not.toHaveBeenCalled()
    expect(idle.requests).toEqual([
      {
        method: 'remote.intent.ack',
        params: { intentId: 'clip-idle', ok: false, message: "You're not recording or live." }
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
    systemAudioShown
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
        false
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
