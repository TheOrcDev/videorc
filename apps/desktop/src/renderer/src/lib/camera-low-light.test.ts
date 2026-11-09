import { describe, expect, it } from 'vitest'

import { cameraLowLightReadRetryDelayMs } from './camera-low-light'

describe('cameraLowLightReadRetryDelayMs (issue #1066)', () => {
  it('backs off over three retries, then stops', () => {
    expect(cameraLowLightReadRetryDelayMs(1)).toBe(2_000)
    expect(cameraLowLightReadRetryDelayMs(2)).toBe(4_000)
    expect(cameraLowLightReadRetryDelayMs(3)).toBe(8_000)
    expect(cameraLowLightReadRetryDelayMs(4)).toBeNull()
  })

  it('never retries for a nonsense count', () => {
    expect(cameraLowLightReadRetryDelayMs(0)).toBeNull()
    expect(cameraLowLightReadRetryDelayMs(-1)).toBeNull()
    expect(cameraLowLightReadRetryDelayMs(1.5)).toBeNull()
  })
})
