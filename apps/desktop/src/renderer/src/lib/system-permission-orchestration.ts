import { toast } from 'sonner'

import type { BackendClient } from '@/backendClient'
import type { WsStatus } from '@/lib/capture'
import type {
  AudioMeterResult,
  BackendRestartBoundary,
  DeviceList,
  MediaAccessSnapshot,
  RuntimeInfo,
  SystemPermissionPane
} from '@/lib/backend'
import { systemAccessAction, systemAccessRows } from '@/lib/system-access'

type SystemPermissionOrchestration = {
  pane: SystemPermissionPane
  platform: RuntimeInfo['platform'] | undefined
  refreshMediaAccess: () => Promise<MediaAccessSnapshot | null>
  getDeviceList: () => DeviceList
  getAudioMeter: () => AudioMeterResult | null
  openSystemPermissionSettings: (pane: SystemPermissionPane) => Promise<void>
  getClient: () => BackendClient | null
  getWsStatus: () => WsStatus
  clearMicrophoneEvidence: () => void
  deferMicrophoneProof: (proof: MicrophonePermissionProof) => void
  setDeviceList: (deviceList: DeviceList) => void
  reportError: (error: unknown) => void
}

export type MicrophonePermissionProof = {
  previousClient: BackendClient | null
  staleBackend?: BackendRestartBoundary
}

function matchesStaleBackend(client: BackendClient, boundary: BackendRestartBoundary): boolean {
  const { connection } = client
  return (
    connection.port === boundary.port &&
    (boundary.pid === undefined || connection.pid === boundary.pid)
  )
}

export function isReplacementPermissionClient(
  client: BackendClient | null,
  proof: MicrophonePermissionProof
): client is BackendClient {
  if (!client || client === proof.previousClient) return false
  return !proof.staleBackend || !matchesStaleBackend(client, proof.staleBackend)
}

export async function waitForPermissionCondition(
  condition: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export async function runMicrophonePermissionProof({
  client,
  proof,
  isCurrent,
  setDeviceList,
  canSampleAudio,
  sampleAudioMeter
}: {
  client: BackendClient
  proof: MicrophonePermissionProof
  isCurrent: () => boolean
  setDeviceList: (deviceList: DeviceList) => void
  canSampleAudio: () => boolean
  sampleAudioMeter: () => Promise<boolean>
}): Promise<boolean> {
  if (!isReplacementPermissionClient(client, proof)) return false

  let nextDevices: DeviceList | undefined
  for (let attempt = 0; attempt < 2 && isCurrent(); attempt += 1) {
    try {
      nextDevices = await client.request<DeviceList>('devices.list')
      break
    } catch (error) {
      if (!isCurrent()) return false
      if (attempt === 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!nextDevices || !isCurrent()) return false
  setDeviceList(nextDevices)
  await waitForPermissionCondition(() => isCurrent() && canSampleAudio())
  if (!isCurrent() || !canSampleAudio()) return false
  return (await sampleAudioMeter()) && isCurrent()
}

export async function runSystemPermissionAction({
  pane,
  platform,
  refreshMediaAccess,
  getDeviceList,
  getAudioMeter,
  openSystemPermissionSettings,
  getClient,
  getWsStatus,
  clearMicrophoneEvidence,
  deferMicrophoneProof,
  setDeviceList,
  reportError
}: SystemPermissionOrchestration): Promise<void> {
  const snapshot = await refreshMediaAccess()
  if ((pane === 'camera' || pane === 'microphone') && !snapshot) {
    const label = pane === 'camera' ? 'Camera' : 'Microphone'
    toast.error(`Could not check ${label} permission.`, {
      description: 'Try again before changing access.'
    })
    return
  }
  const row = systemAccessRows({
    deviceList: getDeviceList(),
    audioMeter: getAudioMeter(),
    platform,
    mediaAccess: snapshot
  }).find((candidate) => candidate.id === pane)
  const mediaAccessStatus =
    pane === 'camera' || pane === 'microphone' ? snapshot?.[pane] : undefined
  const action = systemAccessAction({
    pane,
    state: row?.state,
    platform,
    mediaAccessStatus
  })

  if (!action) {
    return
  }
  if (action === 'open-settings') {
    if (pane === 'microphone') {
      clearMicrophoneEvidence()
    }
    await openSystemPermissionSettings(pane)
    return
  }

  const requestMediaAccess = window.videorc?.requestMediaAccess
  if (!requestMediaAccess || (pane !== 'camera' && pane !== 'microphone')) {
    toast.error('Permission request is unavailable outside Electron.')
    return
  }

  try {
    const previousClient = getClient()
    const result = await requestMediaAccess(pane)
    await refreshMediaAccess()
    if (!result.granted) {
      return
    }

    if (pane === 'microphone') {
      clearMicrophoneEvidence()
      deferMicrophoneProof({
        previousClient,
        ...(result.staleBackend ? { staleBackend: result.staleBackend } : {})
      })
      return
    }

    if (!result.restarted) {
      // The current backend was initialized before the new grant. Its
      // device/meter evidence is stale, so wait for the deferred restart.
      return
    }

    await waitForPermissionCondition(
      () =>
        getWsStatus() === 'connected' &&
        isReplacementPermissionClient(getClient(), {
          previousClient,
          ...(result.staleBackend ? { staleBackend: result.staleBackend } : {})
        })
    )
    const activeClient = getClient()
    if (
      getWsStatus() !== 'connected' ||
      !isReplacementPermissionClient(activeClient, {
        previousClient,
        ...(result.staleBackend ? { staleBackend: result.staleBackend } : {})
      })
    ) {
      return
    }

    const nextDevices = await activeClient.request<DeviceList>('devices.list')
    if (getClient() === activeClient) {
      setDeviceList(nextDevices)
    }
  } catch (error) {
    reportError(error)
  }
}
