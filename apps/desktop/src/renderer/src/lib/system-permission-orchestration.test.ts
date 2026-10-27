import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackendClient } from '@/backendClient'
import type { DeviceList, MediaAccessSnapshot } from '@/lib/backend'
import type { WsStatus } from '@/lib/capture'

import {
  isReplacementPermissionClient,
  runSystemPermissionAction
} from './system-permission-orchestration'

function client(port: number, pid: number): BackendClient {
  return new BackendClient({ host: '127.0.0.1', port, pid, token: `token-${pid}` })
}

describe('isReplacementPermissionClient', () => {
  it('rejects both the renderer client from before the prompt and an unpublished stale backend', () => {
    const beforePrompt = client(9988, 101)
    const staleBackend = { port: 9989, pid: 202 }
    const proof = { previousClient: beforePrompt, staleBackend }

    expect(isReplacementPermissionClient(beforePrompt, proof)).toBe(false)
    expect(isReplacementPermissionClient(client(9989, 202), proof)).toBe(false)
    expect(isReplacementPermissionClient(client(9990, 303), proof)).toBe(true)
  })
})

describe('runSystemPermissionAction for the screen (plan 203 S2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const emptyDevices: DeviceList = { devices: [], warnings: [] }

  function run(
    snapshot: MediaAccessSnapshot,
    videorc: Record<string, unknown>,
    clientAfter: BackendClient | null = null,
    wsStatus: WsStatus = 'connected'
  ) {
    vi.stubGlobal('window', { videorc })
    const openSystemPermissionSettings = vi.fn(async () => undefined)
    const setDeviceList = vi.fn()
    const reportError = vi.fn()
    const previousClient = client(9988, 101)
    let current: BackendClient | null = previousClient
    let refreshes = 0
    const promise = runSystemPermissionAction({
      pane: 'screen-recording',
      platform: 'darwin',
      refreshMediaAccess: async () => {
        // The first read decides the action; the second follows the request,
        // by which time a fresh grant has replaced the backend.
        refreshes += 1
        if (refreshes > 1) current = clientAfter ?? current
        return snapshot
      },
      getDeviceList: () => emptyDevices,
      getAudioMeter: () => null,
      openSystemPermissionSettings,
      getClient: () => current,
      getWsStatus: () => wsStatus,
      clearMicrophoneEvidence: vi.fn(),
      deferMicrophoneProof: vi.fn(),
      setDeviceList,
      reportError
    })
    return { promise, openSystemPermissionSettings, setDeviceList, reportError }
  }

  it('asks in place for a never-asked screen instead of opening System Settings', async () => {
    const requestScreenAccess = vi.fn(async () => ({
      status: 'not-determined',
      granted: false,
      restarted: false
    }))
    const { promise, openSystemPermissionSettings, setDeviceList } = run(
      { camera: 'granted', microphone: 'granted', screen: 'not-determined' },
      { requestScreenAccess, requestMediaAccess: vi.fn() }
    )
    await promise
    expect(requestScreenAccess).toHaveBeenCalledOnce()
    expect(openSystemPermissionSettings).not.toHaveBeenCalled()
    expect(setDeviceList).not.toHaveBeenCalled()
  })

  it('opens System Settings for a denied screen (macOS never re-prompts)', async () => {
    const requestScreenAccess = vi.fn()
    const { promise, openSystemPermissionSettings } = run(
      { camera: 'granted', microphone: 'granted', screen: 'denied' },
      { requestScreenAccess }
    )
    await promise
    expect(requestScreenAccess).not.toHaveBeenCalled()
    expect(openSystemPermissionSettings).toHaveBeenCalledWith('screen-recording')
  })

  it("reads the replacement backend's devices after a grant that restarted capture", async () => {
    const replacement = client(9990, 303)
    const request = vi.spyOn(replacement, 'request').mockResolvedValue({
      devices: [],
      warnings: ['fresh']
    })
    const requestScreenAccess = vi.fn(async () => ({
      status: 'granted',
      granted: true,
      restarted: true,
      staleBackend: { port: 9988, pid: 101 }
    }))
    const { promise, setDeviceList } = run(
      { camera: 'granted', microphone: 'granted', screen: 'not-determined' },
      { requestScreenAccess },
      replacement
    )
    await promise
    expect(request).toHaveBeenCalledWith('devices.list')
    expect(setDeviceList).toHaveBeenCalledWith({ devices: [], warnings: ['fresh'] })
  })
})
