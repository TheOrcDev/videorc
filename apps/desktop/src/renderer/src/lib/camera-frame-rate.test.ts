import { describe, expect, it } from 'vitest'

import {
  IDLE_CAMERA_FRAME_RATE_WATCH,
  cameraExpectedFps,
  cameraLowFrameRateLine,
  nextCameraFrameRateWatch,
  sameCameraLowFrameRate,
  type CameraFrameRateWatch
} from '@/lib/camera-frame-rate'

// Issue #1066: the C920 delivered ~15 of 30 fps while Sources said Receiving.

const live = {
  state: 'live' as const,
  cameraId: 'c920',
  targetFps: 30,
  selectedFormatMaxFps: 30
}

/** Feeds one sample every 250 ms (the backend's cadence) from `startMs`. */
function feed(
  watch: CameraFrameRateWatch,
  rates: readonly number[],
  startMs = 0,
  status: Partial<typeof live> = {}
): { watch: CameraFrameRateWatch; endMs: number } {
  let nowMs = startMs
  let next = watch
  for (const sourceFps of rates) {
    next = nextCameraFrameRateWatch(next, { ...live, ...status, sourceFps }, nowMs)
    nowMs += 250
  }
  return { watch: next, endMs: nowMs }
}

const repeat = (fps: number, seconds: number): number[] =>
  Array.from({ length: Math.round(seconds * 4) }, () => fps)

describe('cameraExpectedFps', () => {
  it('is the requested rate capped by the format, like the facts line', () => {
    expect(cameraExpectedFps({ targetFps: 30, selectedFormatMaxFps: 60 })).toBe(30)
    expect(cameraExpectedFps({ targetFps: 60, selectedFormatMaxFps: 29.97 })).toBe(29.97)
    expect(cameraExpectedFps({ targetFps: 30 })).toBe(30)
    expect(cameraExpectedFps({ targetFps: 0 })).toBeUndefined()
  })
})

describe('nextCameraFrameRateWatch', () => {
  it('says nothing for a camera at its rate', () => {
    expect(feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(29.6, 20)).watch.low).toBeNull()
  })

  it('says so only after the rate stays under 0.8× for 5 s', () => {
    const early = feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(14.68, 5))
    expect(early.watch.low).toBeNull()
    const held = feed(early.watch, [15], early.endMs)
    expect(held.watch.low).toEqual({ fps: expect.closeTo(14.69, 1), expectedFps: 30 })
  })

  it('starts the 5 s over when one sample reaches the line', () => {
    const almost = feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(15, 4.5))
    const blip = feed(almost.watch, [24], almost.endMs)
    const after = feed(blip.watch, repeat(15, 4.5), blip.endMs)
    expect(after.watch.low).toBeNull()
    expect(feed(after.watch, repeat(15, 1), after.endMs).watch.low).not.toBeNull()
  })

  it('holds through a rate between the lines and clears after 3 s back over 0.9×', () => {
    const slow = feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(15, 6))
    expect(slow.watch.low).not.toBeNull()
    // 25 fps is over the low line but under the recovered one: no flicker.
    const between = feed(slow.watch, repeat(25, 10), slow.endMs)
    expect(between.watch.low).not.toBeNull()
    const recovering = feed(between.watch, repeat(29, 2.75), between.endMs)
    expect(recovering.watch.low).not.toBeNull()
    // A dip back under 0.9× starts the recovery over.
    const dip = feed(recovering.watch, [26, ...repeat(29, 2.75)], recovering.endMs)
    expect(dip.watch.low).not.toBeNull()
    expect(feed(dip.watch, [29, 29], dip.endMs).watch.low).toBeNull()
  })

  it('starts over for another camera, another rate, or a camera that is not live', () => {
    const slow = feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(15, 6))
    expect(slow.watch.low).not.toBeNull()
    expect(feed(slow.watch, [15], slow.endMs, { cameraId: 'brio' }).watch.low).toBeNull()
    expect(
      feed(slow.watch, [15], slow.endMs, { targetFps: 60, selectedFormatMaxFps: 60 }).watch.low
    ).toBeNull()
    expect(
      nextCameraFrameRateWatch(slow.watch, { ...live, state: 'starting', sourceFps: 15 }, 0)
    ).toBe(IDLE_CAMERA_FRAME_RATE_WATCH)
    // A camera that sends nothing has its own chip.
    expect(
      nextCameraFrameRateWatch(slow.watch, { ...live, noVideo: true, sourceFps: 15 }, 0).low
    ).toBeNull()
    expect(nextCameraFrameRateWatch(slow.watch, live, 0).low).toBeNull()
  })

  it('measures against what the format can do, not the request', () => {
    // A 25 fps-only format asked for 30: the format shortfall's news, not slow.
    const capped = feed(IDLE_CAMERA_FRAME_RATE_WATCH, repeat(25, 10), 0, {
      selectedFormatMaxFps: 25
    })
    expect(capped.watch.low).toBeNull()
  })
})

describe('sameCameraLowFrameRate', () => {
  it('compares what the row shows', () => {
    expect(sameCameraLowFrameRate(null, null)).toBe(true)
    expect(sameCameraLowFrameRate(null, { fps: 15, expectedFps: 30 })).toBe(false)
    expect(
      sameCameraLowFrameRate({ fps: 14.6, expectedFps: 30 }, { fps: 15.2, expectedFps: 30 })
    ).toBe(true)
    expect(
      sameCameraLowFrameRate({ fps: 14.4, expectedFps: 30 }, { fps: 15.2, expectedFps: 30 })
    ).toBe(false)
  })
})

describe('cameraLowFrameRateLine', () => {
  it('names the camera, the rate and the one thing that usually helps', () => {
    expect(cameraLowFrameRateLine('C920 HD Pro Webcam', { fps: 14.68, expectedFps: 30 })).toBe(
      'C920 HD Pro Webcam is sending 15 of 30 fps. More light usually helps.'
    )
    expect(cameraLowFrameRateLine(undefined, { fps: 12.2, expectedFps: 29.97 })).toBe(
      'Your camera is sending 12 of 30 fps. More light usually helps.'
    )
  })

  it('names the switch when low-light compensation is what lowers the rate', () => {
    expect(
      cameraLowFrameRateLine(
        'HP HD Camera',
        { fps: 11.4, expectedFps: 30 },
        { lowLightCompensation: true }
      )
    ).toBe('HP HD Camera is sending 11 of 30 fps. Turn off Low-light compensation to keep 30 fps.')
    expect(
      cameraLowFrameRateLine(
        'HP HD Camera',
        { fps: 11.4, expectedFps: 30 },
        { lowLightCompensation: false }
      )
    ).toBe('HP HD Camera is sending 11 of 30 fps. More light usually helps.')
  })
})
