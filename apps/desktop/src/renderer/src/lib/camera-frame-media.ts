import { createAlphaGpu } from '../../../shared/cloud-alpha-gpu'
import { alphaDimensions, packedSize } from '../../../shared/cloud-alpha'
import {
  CAMERA_PACKED_ALPHA_ENABLED,
  ROOM_FRAME,
  cameraFrameBinds,
  type CameraFrameAuthority,
  type CameraFramePublicationFacts
} from '../../../shared/room-frame'

/**
 * Plan 249 S13a: the desktop monitor's camera-frame adapter. Draws a packed
 * camera-role video unpacked, at its logical size, with S10's GPU helper
 * only. It never reads an S10 layer manifest and never shows the packed
 * picture: a closed adapter leaves the caller's video hidden. Authority is
 * re-checked on every decoded frame against the publication's own facts.
 */
export type CameraFrameMedia = {
  readonly canvas: HTMLCanvasElement
  logicalSize(): { w: number; h: number } | null
  close(reason?: string): void
  readonly closed: boolean
  readonly stats: {
    drawn: number
    duplicateFrames: number
    wrongDimensions: number
    stopReason: string
  }
}

export function createCameraFrameMedia(options: {
  page: Document
  video: HTMLVideoElement
  publication: () => CameraFramePublicationFacts | null
  authority: () => CameraFrameAuthority | null
  experiment: boolean
  onClose?: (reason: string) => void
  gpu?: typeof createAlphaGpu
}): CameraFrameMedia {
  if (!CAMERA_PACKED_ALPHA_ENABLED && !options.experiment)
    throw new Error('Packed camera frames are disabled.')
  const w = ROOM_FRAME.width
  const h = ROOM_FRAME.height
  if (!alphaDimensions(w, h)) throw new Error('Camera frame size refused.')
  const expected = packedSize(w, h)
  const valid = (): boolean => {
    const facts = options.publication()
    return !!facts && cameraFrameBinds(options.authority(), facts)
  }
  if (!valid()) throw new Error('Camera frame publication is not authorized.')
  if (typeof options.video.requestVideoFrameCallback !== 'function')
    throw new Error('Camera frames require decoded-frame callbacks.')
  const canvas = options.page.createElement('canvas')
  canvas.dataset.cameraFrame = 'rgb-left-alpha-right:g8'
  const gpu = (options.gpu ?? createAlphaGpu)(canvas, w, h, 'unpack')
  const stats = { drawn: 0, duplicateFrames: 0, wrongDimensions: 0, stopReason: '' }
  let closed = false
  let callback = 0
  let lastMediaTime = -1
  const close = (reason = 'closed'): void => {
    if (closed) return
    closed = true
    stats.stopReason = reason
    options.video.cancelVideoFrameCallback?.(callback)
    gpu.close()
    canvas.remove()
    options.onClose?.(reason)
  }
  const frame: VideoFrameRequestCallback = (_now, meta) => {
    if (closed) return
    if (!valid()) {
      close('authority-changed')
      return
    }
    if (meta.mediaTime === lastMediaTime) stats.duplicateFrames++
    else if (
      options.video.videoWidth !== expected.width ||
      options.video.videoHeight !== expected.height
    )
      stats.wrongDimensions++
    else {
      lastMediaTime = meta.mediaTime
      if (!gpu.draw(options.video)) {
        close(gpu.stats.contextLost ? 'gpu-context-lost' : 'gpu-draw-refused')
        return
      }
      stats.drawn++
    }
    callback = options.video.requestVideoFrameCallback(frame)
  }
  callback = options.video.requestVideoFrameCallback(frame)
  return {
    canvas,
    logicalSize: () => (closed ? null : { w, h }),
    close,
    get closed() {
      return closed
    },
    stats
  }
}
