// Plan 255: the SRT Camera's id, small enough for the eager bundle. The rest of
// the SRT view lives in `srt-input-view.ts`, which only lazy pages load.

export const SRT_CAMERA_ID = 'camera:srt-input'

export function isSrtCameraId(cameraId: string | null | undefined): boolean {
  return cameraId === SRT_CAMERA_ID
}
