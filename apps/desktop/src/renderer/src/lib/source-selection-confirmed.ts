import type { Device, SessionSources, SourceSelection } from '@/lib/backend'

/** Merge backend fields only; names survive unplug/discovery refresh. */
export function confirmedSourceSelection(
  current: SourceSelection,
  snapshot: SessionSources,
  devices: Device[]
): SourceSelection {
  const selected = {
    ...snapshot.confirmed,
    screenId: snapshot.confirmed.screenId ?? undefined,
    windowId: snapshot.confirmed.windowId ?? undefined,
    cameraId: snapshot.confirmed.cameraId ?? undefined,
    microphoneId: snapshot.confirmed.microphoneId ?? undefined
  }
  const name = (id: string | undefined, oldId: string | undefined, oldName: string | undefined) =>
    id
      ? (devices.find((device) => device.id === id)?.name ?? (id === oldId ? oldName : undefined))
      : undefined
  return {
    ...current,
    screenId: selected.screenId,
    windowId: selected.windowId,
    cameraId: selected.cameraId,
    microphoneId: selected.microphoneId,
    screenName: name(selected.screenId, current.screenId, current.screenName),
    windowName: name(selected.windowId, current.windowId, current.windowName),
    cameraName: name(selected.cameraId, current.cameraId, current.cameraName),
    microphoneName: name(selected.microphoneId, current.microphoneId, current.microphoneName),
    testPattern: selected.testPattern
  }
}
