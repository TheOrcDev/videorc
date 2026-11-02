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
    // Plan 0002 (release test 146): a confirmed capture ends an earlier None;
    // a confirmed empty slot keeps it, like the camera below.
    captureOff: selected.screenId || selected.windowId ? undefined : current.captureOff,
    cameraName: name(selected.cameraId, current.cameraId, current.cameraName),
    // A confirmed camera ends an earlier Off; a confirmed empty slot keeps it.
    cameraOff: selected.cameraId ? undefined : current.cameraOff,
    // Plan 213 E1: the pick behind a stand-in, confirmed, is no longer a wish.
    ...(selected.screenId && selected.screenId === current.wantedScreenId
      ? { wantedScreenId: undefined, wantedScreenName: undefined }
      : {}),
    ...(selected.windowId && selected.windowId === current.wantedWindowId
      ? { wantedWindowId: undefined, wantedWindowName: undefined }
      : {}),
    ...(selected.cameraId && selected.cameraId === current.wantedCameraId
      ? { wantedCameraId: undefined, wantedCameraName: undefined }
      : {}),
    microphoneName: name(selected.microphoneId, current.microphoneId, current.microphoneName),
    microphoneOff: selected.microphoneId ? undefined : current.microphoneOff,
    testPattern: selected.testPattern
  }
}
