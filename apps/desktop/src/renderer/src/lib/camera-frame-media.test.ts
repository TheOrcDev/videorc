import { describe, expect, it } from 'vitest'
import { createCameraFrameMedia } from './camera-frame-media'
import { CAMERA_FRAME_CONTRACT, type CameraFrameAuthority } from '../../../shared/room-frame'

const authority: CameraFrameAuthority = {
  contract: CAMERA_FRAME_CONTRACT,
  show: 'sh_talk',
  hostIdentity: 'host:sh_talk',
  publisherSid: 'PA_host',
  trackSid: 'TR_camera',
  epoch: 'e1',
  generation: 3,
  source: 'camera',
  canPublishSources: ['camera']
}
const facts = {
  identity: 'host:sh_talk',
  participantSid: 'PA_host',
  trackSid: 'TR_camera',
  source: 'camera'
}
function harness() {
  const calls: string[] = []
  const stats = { contextLost: false, closed: false }
  const gpu = ((canvas: { width: number; height: number }) => {
    canvas.width = 640
    canvas.height = 360
    return {
      draw: () => {
        calls.push('draw')
        return true
      },
      close: () => {
        stats.closed = true
      },
      stats
    }
  }) as never
  let callback: VideoFrameRequestCallback | null = null
  const raw = {
    videoWidth: 1288,
    videoHeight: 360,
    requestVideoFrameCallback: (fn: VideoFrameRequestCallback) => {
      callback = fn
      return 1
    },
    cancelVideoFrameCallback: () => {
      callback = null
    }
  }
  const page = {
    createElement: () => ({ dataset: {}, width: 0, height: 0, remove() {} })
  } as unknown as Document
  const fire = (mediaTime: number) => callback?.(0, { mediaTime } as VideoFrameCallbackMetadata)
  return { gpu, calls, stats, raw, video: raw as unknown as HTMLVideoElement, page, fire }
}

describe('desktop camera-frame adapter', () => {
  it('refuses unless the experiment is explicit and the publication binds', () => {
    const h = harness()
    const base = { page: h.page, video: h.video, gpu: h.gpu }
    expect(() =>
      createCameraFrameMedia({
        ...base,
        publication: () => facts,
        authority: () => authority,
        experiment: false
      })
    ).toThrow('disabled')
    expect(() =>
      createCameraFrameMedia({
        ...base,
        publication: () => ({ ...facts, trackSid: 'TR_other' }),
        authority: () => authority,
        experiment: true
      })
    ).toThrow('not authorized')
  })

  it('draws only packed frames, reports logical size, and closes on authority change', () => {
    const h = harness()
    let owner: CameraFrameAuthority | null = authority
    const media = createCameraFrameMedia({
      page: h.page,
      video: h.video,
      publication: () => facts,
      authority: () => owner,
      experiment: true,
      gpu: h.gpu
    })
    expect(media.logicalSize()).toEqual({ w: 640, h: 360 })
    h.fire(1)
    h.raw.videoWidth = 640
    h.fire(2)
    h.raw.videoWidth = 1288
    h.fire(2)
    h.fire(2)
    expect(h.calls).toHaveLength(2)
    expect(media.stats).toMatchObject({ drawn: 2, wrongDimensions: 1, duplicateFrames: 1 })
    owner = null
    h.fire(3)
    expect(media.closed).toBe(true)
    expect(media.stats.stopReason).toBe('authority-changed')
    expect(h.stats.closed).toBe(true)
    expect(media.logicalSize()).toBeNull()
  })
})
