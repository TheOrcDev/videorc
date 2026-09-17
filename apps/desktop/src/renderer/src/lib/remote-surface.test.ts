import { describe, expect, it, vi } from 'vitest'

import { executeRemoteIntent, type RemoteIntentContext } from './remote-surface'

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
    streamEnabled: true,
    startSession: vi.fn(async () => true),
    stopSession: vi.fn(async () => true),
    setMicrophoneMuted: vi.fn(async () => true),
    knownLayoutPresets: ['screen-camera'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn(() => true),
    activateTakeover: vi.fn(async () => true),
    clearTakeover: vi.fn(async () => true),
    openWindow: vi.fn(async () => true),
    ...overrides
  }
  return { context, requests }
}

describe('executeRemoteIntent', () => {
  it('starts through the Studio handler and acknowledges success', async () => {
    const { context, requests } = remoteIntentContext()

    await executeRemoteIntent({ intentId: 'intent-1', intent: { kind: 'recordStart' } }, context)

    expect(context.startSession).toHaveBeenCalledOnce()
    expect(requests).toEqual([
      { method: 'remote.intent.ack', params: { intentId: 'intent-1', ok: true } }
    ])
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
      params: { intentId: 'intent-2', ok: false, message: 'Unknown layout preset "unknown".' }
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
        message: 'The layout change was not committed.'
      }
    })
  })

  it('rejects a start that returns without an authoritative session commit', async () => {
    const { context, requests } = remoteIntentContext({
      startSession: vi.fn(async () => false)
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
        message: 'The capture session did not start. Check Studio for details.'
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
        message: 'The active session did not stop. Check Studio for details.'
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
        message: 'The takeover was not activated.'
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
        message: 'The takeover was not cleared.'
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
        message: 'The microphone change was not applied.'
      }
    })
  })

  it('forwards microphone toggles and action failures', async () => {
    const { context, requests } = remoteIntentContext({
      startSession: vi.fn(async () => {
        throw new Error('start rejected')
      })
    })

    await executeRemoteIntent({ intentId: 'intent-3', intent: { kind: 'micToggle' } }, context)
    await executeRemoteIntent({ intentId: 'intent-4', intent: { kind: 'recordStart' } }, context)

    expect(context.setMicrophoneMuted).toHaveBeenCalledWith('toggle')
    expect(requests.at(-1)).toEqual({
      method: 'remote.intent.ack',
      params: { intentId: 'intent-4', ok: false, message: 'start rejected' }
    })
  })
})
