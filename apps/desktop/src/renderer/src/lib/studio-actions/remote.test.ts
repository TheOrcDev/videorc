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
        'sceneApply',
        'takeoverShow',
        'takeoverHide',
        'bannerShow',
        'bannerHide',
        'bannerToggle',
        'soundPlay',
        'soundStop',
        'windowFront',
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
