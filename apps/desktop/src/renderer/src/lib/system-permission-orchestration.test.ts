const permissionToasts = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: permissionToasts }))

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

describe('permission action state and Reopen', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function options(overrides: Partial<Parameters<typeof runSystemPermissionAction>[0]> = {}) {
    return {
      pane: 'screen-recording' as const,
      platform: 'darwin' as const,
      refreshMediaAccess: async (): Promise<MediaAccessSnapshot> => ({
        screen: 'granted',
        camera: 'granted',
        microphone: 'granted'
      }),
      getDeviceList: (): DeviceList => ({
        devices: [
          {
            id: 'screen:screencapturekit',
            name: 'Display',
            kind: 'screen',
            status: 'permission-required'
          }
        ],
        warnings: []
      }),
      getAudioMeter: () => null,
      openSystemPermissionSettings: vi.fn(async () => undefined),
      getClient: () => null,
      getWsStatus: () => 'connected' as const,
      clearMicrophoneEvidence: vi.fn(),
      deferMicrophoneProof: vi.fn(),
      setDeviceList: vi.fn(),
      reportError: vi.fn(),
      setPendingPane: vi.fn(),
      ...overrides
    }
  }

  it.each([
    ['capture-active', 'Finish your recording or livestream first.'],
    ['backend-busy', 'Videorc is busy. Try again in a moment.'],
    [undefined, 'Videorc is busy. Try again in a moment.']
  ])('warns when Reopen is refused: %s', async (reason, description) => {
    const relaunchForPermission = vi.fn(async () => ({ relaunched: false, reason }))
    vi.stubGlobal('window', { videorc: { relaunchForPermission } })
    const input = options()
    await runSystemPermissionAction(input)
    expect(relaunchForPermission).toHaveBeenCalledOnce()
    expect(input.openSystemPermissionSettings).not.toHaveBeenCalled()
    expect(permissionToasts.warning).toHaveBeenCalledWith("Couldn't reopen Videorc", {
      id: 'permission-relaunch-refused',
      description
    })
    expect(permissionToasts.error).not.toHaveBeenCalled()
  })

  it('reopens directly after replacement evidence confirms the need', async () => {
    const relaunchForPermission = vi.fn(async () => ({ relaunched: true }))
    vi.stubGlobal('window', { videorc: { relaunchForPermission } })
    await runSystemPermissionAction(options({ accessContext: { screenGrantStale: false } }))
    expect(relaunchForPermission).toHaveBeenCalledOnce()
    expect(permissionToasts.warning).not.toHaveBeenCalled()
  })

  it('does nothing while the backend evidence is stale', async () => {
    const relaunchForPermission = vi.fn()
    vi.stubGlobal('window', { videorc: { relaunchForPermission } })
    const input = options({ accessContext: { screenGrantStale: true } })
    await runSystemPermissionAction(input)
    expect(relaunchForPermission).not.toHaveBeenCalled()
    expect(input.setPendingPane).not.toHaveBeenCalled()
  })

  it('marks the screen Settings round trip pending without repeating the native request', async () => {
    const requestScreenAccess = vi.fn()
    vi.stubGlobal('window', { videorc: { requestScreenAccess } })
    const input = options({
      refreshMediaAccess: async () => ({
        screen: 'not-determined',
        camera: 'granted',
        microphone: 'granted'
      }),
      accessContext: { pendingPane: 'screen-recording' }
    })
    await runSystemPermissionAction(input)
    expect(input.setPendingPane).toHaveBeenCalledWith('screen-recording')
    expect(input.openSystemPermissionSettings).toHaveBeenCalledWith('screen-recording')
    expect(requestScreenAccess).not.toHaveBeenCalled()
  })
})

describe('permission action refresh boundary', () => {
  it('reads the current context after the OS read notices a new grant', async () => {
    const relaunchForPermission = vi.fn()
    vi.stubGlobal('window', { videorc: { relaunchForPermission } })
    let stale = false
    await runSystemPermissionAction({
      pane: 'screen-recording',
      platform: 'darwin',
      accessContext: { screenGrantStale: false },
      getAccessContext: () => ({ screenGrantStale: stale }),
      refreshMediaAccess: async () => {
        stale = true
        return { screen: 'granted', camera: 'granted', microphone: 'granted' }
      },
      getDeviceList: () => ({
        devices: [
          {
            id: 'screen:screencapturekit',
            name: 'Display',
            kind: 'screen',
            status: 'permission-required'
          }
        ],
        warnings: []
      }),
      getAudioMeter: () => null,
      openSystemPermissionSettings: vi.fn(),
      getClient: () => null,
      getWsStatus: () => 'connected',
      clearMicrophoneEvidence: vi.fn(),
      deferMicrophoneProof: vi.fn(),
      setDeviceList: vi.fn(),
      reportError: vi.fn()
    })
    expect(relaunchForPermission).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
