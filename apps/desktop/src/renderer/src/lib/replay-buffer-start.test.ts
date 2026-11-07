import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import { defaultCaptureConfig, defaultSettings } from './capture'
import { startBufferOnlySession } from './replay-buffer'

vi.mock('@/lib/toast', () => ({ toast: {} }))

afterEach(() => vi.unstubAllGlobals())

function fixture(isCurrent = () => true) {
  const status = { state: 'recording', replayOnly: true }
  const requestTyped = vi.fn().mockResolvedValue(status)
  return {
    requestTyped,
    status,
    input: {
      client: { requestTyped } as unknown as BackendClient,
      captureConfig: {
        ...defaultCaptureConfig,
        sources: { testPattern: true },
        layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' as const }
      },
      scene: null,
      sceneEditMode: false,
      settings: { ...defaultSettings, outputDirectoryHandle: 'owned-directory' },
      isCurrent
    }
  }
}

describe('automatic Clips start dispatch', () => {
  it('does not authorize or start a superseded selection', async () => {
    const authorize = vi.fn()
    vi.stubGlobal('window', { videorc: { authorizeOutputDirectory: authorize } })
    const run = fixture(() => false)
    expect(await startBufferOnlySession(run.input)).toBeNull()
    expect(authorize).not.toHaveBeenCalled()
    expect(run.requestTyped).not.toHaveBeenCalled()
  })

  it('cancels an old scene when its directory authorization resolves after a new intent', async () => {
    let resolveAuthorization!: (value: { capabilityId: string }) => void
    const authorize = vi.fn(
      () =>
        new Promise<{ capabilityId: string }>((resolve) => {
          resolveAuthorization = resolve
        })
    )
    vi.stubGlobal('window', { videorc: { authorizeOutputDirectory: authorize } })
    let currentIntent = 1
    const run = fixture(() => currentIntent === 1)
    const oldStart = startBufferOnlySession(run.input)
    expect(authorize).toHaveBeenCalledWith('owned-directory')
    currentIntent = 2
    resolveAuthorization({ capabilityId: 'stale-capability' })
    expect(await oldStart).toBeNull()
    expect(run.requestTyped).not.toHaveBeenCalled()

    // Reconciliation can make a fresh request; cancellation is not a failed
    // session or an implicit retry with the old source/layout snapshot.
    authorize.mockResolvedValue({ capabilityId: 'fresh-capability' })
    run.input.isCurrent = () => currentIntent === 2
    expect(await startBufferOnlySession(run.input)).toEqual(run.status)
    expect(run.requestTyped).toHaveBeenCalledOnce()
    expect(run.requestTyped).toHaveBeenCalledWith(
      'session.start',
      expect.objectContaining({
        layout: expect.objectContaining({ layoutPreset: 'screen-only' }),
        output: expect.objectContaining({
          recordEnabled: false,
          streamEnabled: false,
          outputDirectoryCapability: 'fresh-capability'
        }),
        replay: expect.objectContaining({ seconds: 60 })
      })
    )
  })

  it('preserves genuine authorization failures without dispatching a session', async () => {
    const error = new Error('folder permission revoked')
    vi.stubGlobal('window', {
      videorc: { authorizeOutputDirectory: vi.fn().mockRejectedValue(error) }
    })
    const run = fixture()
    await expect(startBufferOnlySession(run.input)).rejects.toBe(error)
    expect(run.requestTyped).not.toHaveBeenCalled()
  })

  it('keeps the stable buffer-only request free of stream and caption outputs', async () => {
    vi.stubGlobal('window', {
      videorc: { authorizeOutputDirectory: vi.fn().mockResolvedValue(null) }
    })
    const run = fixture()
    await startBufferOnlySession(run.input)
    const params = run.requestTyped.mock.calls[0][1]
    expect(params.output.recordEnabled).toBe(false)
    expect(params.output.streamEnabled).toBe(false)
    expect(params.streaming).toBeUndefined()
    expect(params.captions).toBeUndefined()
    expect(params.simulcast).toBeUndefined()
    expect(params.output.outputDirectoryCapability).toBeUndefined()
  })
})
