import type {
  CameraSelectionDiagnostics,
  Device,
  PreviewCameraStatus,
  RecordingStatus,
  SourceSelection
} from './backend'
import { findRememberedSource } from './capture'
import { sessionOwnsTransport } from '../../../shared/capture-state'

export function returningSourceChoices(sources: SourceSelection, devices: Device[]) {
  const choices: { kind: 'camera' | 'capture'; device: Device }[] = []
  for (const kind of ['camera', 'capture'] as const) {
    const id =
      kind === 'camera'
        ? sources.wantedCameraId
        : (sources.wantedWindowId ?? sources.wantedScreenId)
    const name =
      kind === 'camera'
        ? sources.wantedCameraName
        : (sources.wantedWindowName ?? sources.wantedScreenName)
    if (!id && !name) continue
    const deviceKind =
      kind === 'camera'
        ? 'camera'
        : sources.wantedWindowId || sources.wantedWindowName
          ? 'window'
          : 'screen'
    const available = devices.filter(
      (device) => device.kind === deviceKind && device.status === 'available'
    )
    // Plan 213 F1: a display comes back by its UUID first, whatever its id.
    const device = findRememberedSource(
      id,
      name,
      available,
      deviceKind === 'screen' ? sources.wantedScreenUuid : undefined
    )
    if (device) choices.push({ kind, device })
  }
  return choices
}

export function cameraIsAvailable(cameraId: string | undefined, devices: Device[]): boolean {
  return Boolean(
    cameraId &&
    devices.some(
      (device) =>
        device.id === cameraId && device.kind === 'camera' && device.status === 'available'
    )
  )
}

export function cameraPreviewStartAllowed(
  cameraId: string,
  devices: Device[],
  key: string,
  previousKey: string | null,
  state: string,
  currentCameraId?: string
): boolean {
  return (
    !(state === 'disconnected' && currentCameraId === cameraId) &&
    cameraIsAvailable(cameraId, devices) &&
    !(key === previousKey && ['starting', 'live', 'failed', 'device-missing'].includes(state))
  )
}

/**
 * A `preview.camera.start` reply and the `preview.camera.status` events travel
 * separately, so the reply can land after a newer event. On Windows the start
 * replies with `starting` as soon as it is admitted (issue #1068), and the
 * `live` event can overtake it. Keep whichever status the backend wrote last;
 * a reply that loses that race would pin the camera at `starting`, because
 * `cameraPreviewStartAllowed` never restarts the same key while it starts.
 */
export function freshestPreviewCameraStatus(
  current: PreviewCameraStatus,
  reply: PreviewCameraStatus
): PreviewCameraStatus {
  return Date.parse(current.updatedAt) > Date.parse(reply.updatedAt) ? current : reply
}

export function sourceReturnAction(
  status: Pick<RecordingStatus, 'state' | 'replayOnly'>,
  blocked = false
): 'offer' | 'restore' | 'wait' {
  return sessionOwnsTransport(status) ? 'offer' : blocked ? 'wait' : 'restore'
}

export function cameraSelectionDiagnostics(
  sources: SourceSelection,
  status: PreviewCameraStatus
): CameraSelectionDiagnostics {
  return {
    wantedCameraId: sources.wantedCameraId ?? sources.cameraId,
    wantedCameraName: sources.wantedCameraName ?? sources.cameraName,
    usedCameraId: status.cameraId,
    deviceUniqueId: status.deviceUniqueId,
    state: status.state
  }
}
