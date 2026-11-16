import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StudioActionContext } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { REMOTE_INTENT_EXECUTORS, executeRemoteIntent } from './remote'

// Plan 209 S5: the remote entry point in its new home. Each kind's own
// behaviour stays covered by lib/remote-surface.test.ts, through the
// re-export; this file covers the envelope, the table and the ack shape.

function studioContext(overrides: Partial<StudioActionContext> = {}) {
  const requests: Array<{ method: string; params: unknown }> = []
  const context: StudioActionContext = {
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the remote intent entry point', () => {
  it('has one executor for every kind on the wire (docs/remote-control.md)', () => {
    expect(Object.keys(REMOTE_INTENT_EXECUTORS).sort()).toEqual(
      [
        'screenHide',
        'screenShow',
        'screenHideToggle',
        'recordStart',
        'recordStop',
        'recordToggle',
        'streamStart',
        'streamStop',
        'micMute',
        'micUnmute',
        'micToggle',
        'systemAudioOn',
        'systemAudioOff',
        'systemAudioToggle',
        'buddyLiveOn',
        'buddyLiveOff',
        'buddyLiveToggle',
        'sceneApply',
        'takeoverShow',
        'takeoverHide',
        'bannerShow',
        'bannerHide',
        'bannerToggle',
        'soundPlay',
        'soundStop',
        'windowFront',
        'streamManagerScreenSwap',
        'streamManagerFrontOrClose',
        'commentHighlight',
        'commentHighlightClear',
        'clipMark'
      ].sort()
    )
  })

  it('acks a success as {intentId, ok} and a refusal with its sentence, nothing more', async () => {
    const { context, requests } = studioContext()
    await executeRemoteIntent({ intentId: 'ri-1', intent: { kind: 'recordStart' } }, context)
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'ri-1', ok: true } }
    ])
    expect(Object.keys(requests[0].params as object)).toEqual(['intentId', 'ok'])

    const live = studioContext({ sessionActive: true })
    await executeRemoteIntent({ intentId: 'ri-2', intent: { kind: 'recordStart' } }, live.context)
    expect(live.requests).toEqual([
      {
        method: 'remote.intent.ack',
        params: { intentId: 'ri-2', ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
      }
    ])
    expect(live.context.startRecording).not.toHaveBeenCalled()
  })

  it('hands the executor the Studio context and the intent fields', async () => {
    const { context, requests } = studioContext({
      knownLayoutPresets: ['screen-camera', 'screen-only']
    })
    await executeRemoteIntent(
      { intentId: 'ri-scene', intent: { kind: 'sceneApply', layoutPreset: 'screen-only' } },
      context
    )
    expect(context.applyLayoutPreset).toHaveBeenCalledWith('screen-only')
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'ri-scene', ok: true } }
    ])
  })

  it('ignores an envelope with no intent id or kind, without an ack', async () => {
    const { context, requests } = studioContext()
    await executeRemoteIntent(null, context)
    await executeRemoteIntent({ intent: { kind: 'recordStart' } }, context)
    await executeRemoteIntent({ intentId: 'ri-1', intent: {} }, context)
    await executeRemoteIntent({ intentId: 'ri-1', kind: 'recordStart' }, context)
    expect(requests).toEqual([])
    expect(context.startRecording).not.toHaveBeenCalled()
  })

  it('refuses a kind it does not know as unsupported, even a prototype name', async () => {
    const { context, requests } = studioContext()
    await executeRemoteIntent({ intentId: 'ri-1', intent: { kind: 'replaySave' } }, context)
    await executeRemoteIntent({ intentId: 'ri-2', intent: { kind: 'constructor' } }, context)
    expect(requests).toEqual([
      {
        method: 'remote.intent.ack',
        params: { intentId: 'ri-1', ok: false, message: REMOTE_INTENT_COPY.unsupported }
      },
      {
        method: 'remote.intent.ack',
        params: { intentId: 'ri-2', ok: false, message: REMOTE_INTENT_COPY.unsupported }
      }
    ])
  })

  it('turns an executor that throws into the plain failure, with the error on the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, requests } = studioContext({
      sessionActive: true,
      stopSession: vi.fn(async () => {
        throw new Error('backend hiccup')
      })
    })
    await executeRemoteIntent({ intentId: 'ri-stop', intent: { kind: 'recordStop' } }, context)
    expect(requests).toEqual([
      {
        method: 'remote.intent.ack',
        params: { intentId: 'ri-stop', ok: false, message: REMOTE_INTENT_COPY.failed }
      }
    ])
    expect(error).toHaveBeenCalledWith(
      '[remote-control] intent failed',
      'recordStop',
      expect.any(Error)
    )
  })

  it('survives a lost ack', async () => {
    const { context } = studioContext({
      client: {
        request: async () => {
          throw new Error('socket closed')
        }
      }
    })
    await expect(
      executeRemoteIntent({ intentId: 'ri-1', intent: { kind: 'micToggle' } }, context)
    ).resolves.toBeUndefined()
    expect(context.setMicrophoneMuted).toHaveBeenCalledWith('toggle')
  })
})

it('applies a saved scene and acknowledges its typed refusal', async () => {
  const applySavedSceneResult = vi.fn(async () => ({
    ok: false as const,
    reason: 'app-not-running' as const,
    message: 'Open Figma to use this scene.'
  }))
  const { context, requests } = studioContext({ applySavedSceneResult })
  await executeRemoteIntent(
    { intentId: 'saved', intent: { kind: 'sceneApply', sceneId: 'figma' } },
    context
  )
  expect(applySavedSceneResult).toHaveBeenCalledWith('figma')
  expect(requests.at(-1)?.params).toEqual({
    intentId: 'saved',
    ok: false,
    message: 'Open Figma to use this scene.'
  })
  applySavedSceneResult.mockResolvedValueOnce({ ok: true } as never)
  await executeRemoteIntent(
    { intentId: 'yes', intent: { kind: 'sceneApply', sceneId: 'figma' } },
    context
  )
  expect(requests.at(-1)?.params).toEqual({ intentId: 'yes', ok: true })
})

it('acks the legacy layout refusal using its display name (D14)', async () => {
  const { context, requests } = studioContext({
    knownLayoutPresets: ['side-by-side'],
    applyLayoutPreset: vi.fn(async () => ({ ok: false, message: 'No scene uses Side by side' }))
  })
  await executeRemoteIntent(
    { intentId: 'legacy', intent: { kind: 'sceneApply', layoutPreset: 'side-by-side' } },
    context
  )
  expect(requests.at(-1)?.params).toEqual({
    intentId: 'legacy',
    ok: false,
    message: 'No scene uses Side by side'
  })
})

it('a remote screenId uses the Screen picker and propagates its refusal (D2)', async () => {
  const switchSource = vi.fn(async () => ({ ok: false, message: 'Wait for the screen.' }))
  const { context, requests } = studioContext({
    sourcePicker: {
      sources: { cameraId: 'camera', windowId: 'old' },
      capture: [{ id: 'display', name: 'Display 2', kind: 'screen', status: 'available' }],
      cameras: [],
      microphones: []
    },
    switchSource
  })
  await executeRemoteIntent(
    { intentId: 'screen', intent: { kind: 'sceneApply', screenId: 'display' } },
    context
  )
  expect(switchSource).toHaveBeenCalledWith(
    'capture',
    expect.objectContaining({ screenId: 'display', windowId: undefined, cameraId: 'camera' })
  )
  expect(requests.at(-1)?.params).toEqual({
    intentId: 'screen',
    ok: false,
    message: 'Wait for the screen.'
  })
  context.sourcePicker = {
    ...context.sourcePicker!,
    capture: [{ id: 'window:2', name: 'Figma', kind: 'window', status: 'available' }]
  }
  await executeRemoteIntent(
    { intentId: 'window', intent: { kind: 'sceneApply', screenId: 'window:2' } },
    context
  )
  expect(switchSource).toHaveBeenLastCalledWith(
    'capture',
    expect.objectContaining({ windowId: 'window:2', screenId: undefined, cameraId: 'camera' })
  )
})

// Review #3: a scene and a screen together are one switch to that scene,
// carrying the screen. The Screen pick never runs after it, so it can't edit
// whichever scene was on stream while the switch was landing.
it('a remote sceneId with a screenId switches to that scene with that screen (D2)', async () => {
  const applySavedSceneResult = vi.fn(async () => ({ ok: true as const }))
  const applyLayoutPreset = vi.fn(async () => true)
  const switchSource = vi.fn(async () => ({ ok: true }))
  const { context, requests } = studioContext({
    knownLayoutPresets: ['screen-only'],
    applySavedSceneResult,
    applyLayoutPreset,
    sourcePicker: {
      sources: { cameraId: 'camera', screenId: 'display:1' },
      capture: [
        { id: 'display:2', name: 'Display 2', kind: 'screen', status: 'available' },
        { id: 'window:2', name: 'Figma', kind: 'window', status: 'available' }
      ],
      cameras: [],
      microphones: []
    },
    switchSource
  })
  await executeRemoteIntent(
    { intentId: 'both', intent: { kind: 'sceneApply', sceneId: 'b', screenId: 'display:2' } },
    context
  )
  expect(applySavedSceneResult).toHaveBeenCalledExactlyOnceWith('b', {
    shows: { kind: 'display', screenId: 'display:2', screenName: 'Display 2' }
  })
  expect(requests.at(-1)?.params).toEqual({ intentId: 'both', ok: true })
  await executeRemoteIntent(
    {
      intentId: 'legacy',
      intent: { kind: 'sceneApply', layoutPreset: 'screen-only', screenId: 'window:2' }
    },
    context
  )
  expect(applyLayoutPreset).toHaveBeenCalledExactlyOnceWith('screen-only', {
    shows: { kind: 'window', windowId: 'window:2', windowName: 'Figma' }
  })
  expect(switchSource).not.toHaveBeenCalled()
  // A screen that isn't there switches nothing.
  await executeRemoteIntent(
    { intentId: 'gone', intent: { kind: 'sceneApply', sceneId: 'b', screenId: 'display:9' } },
    context
  )
  expect(applySavedSceneResult).toHaveBeenCalledTimes(1)
  expect(requests.at(-1)?.params).toMatchObject({ intentId: 'gone', ok: false })
})
