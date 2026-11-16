import { describe, expect, it } from 'vitest'

import {
  SCREEN_IMAGE_BATCH_MAX,
  SCREEN_IMAGE_CAPABILITY_MAX_TTL_MS,
  screenImageCapabilityTtlMs
} from './screen-image-files'

describe('screenImageCapabilityTtlMs', () => {
  it('gives one image about the usual five minutes', () => {
    expect(screenImageCapabilityTtlMs(1)).toBe(5 * 60_000 + 20_000)
  })

  it('grows 20 s per image and never passes the backend maximum', () => {
    expect(screenImageCapabilityTtlMs(10)).toBe(5 * 60_000 + 10 * 20_000)
    expect(screenImageCapabilityTtlMs(SCREEN_IMAGE_BATCH_MAX)).toBe(
      SCREEN_IMAGE_CAPABILITY_MAX_TTL_MS
    )
    expect(screenImageCapabilityTtlMs(10_000)).toBe(SCREEN_IMAGE_CAPABILITY_MAX_TTL_MS)
  })

  it('leaves a full batch the 20 s optimizer budget for every image', () => {
    expect(SCREEN_IMAGE_BATCH_MAX * 20_000).toBeLessThan(
      screenImageCapabilityTtlMs(SCREEN_IMAGE_BATCH_MAX)
    )
  })
})
