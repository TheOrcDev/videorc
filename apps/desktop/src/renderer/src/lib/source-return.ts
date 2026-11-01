import type { Device, RecordingStatus, SourceSelection } from './backend'
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
    const device =
      available.find((device) => device.id === id) ??
      available.find((device) => device.name === name)
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
  state: string
): boolean {
  return (
    cameraIsAvailable(cameraId, devices) &&
    !(key === previousKey && ['starting', 'live', 'failed', 'device-missing'].includes(state))
  )
}

export function sourceReturnAction(
  status: Pick<RecordingStatus, 'state' | 'replayOnly'>
): 'offer' | 'restore' {
  return sessionOwnsTransport(status) ? 'offer' : 'restore'
}
