import { describe, expect, it } from 'vitest'

import { formatDeliveredFps, formatLoweredBitrate } from './stream-delivery-format'

// Plan 218: the stream's own frame rate and the bitrate Videorc holds it at.
describe('stream delivery figures', () => {
  const delivery = {
    targetFps: 30,
    deliveredFps: 20.9,
    dropPercent: 30,
    windowSeconds: 30,
    degraded: true,
    atFloor: false,
    uplinkOverflows: 0
  }

  it('reads the delivered frame rate against the target', () => {
    expect(formatDeliveredFps(delivery)).toBe('21 of 30 fps')
    expect(formatDeliveredFps(undefined)).toBe('')
    expect(formatDeliveredFps({ ...delivery, windowSeconds: 0 })).toBe('')
  })

  it('shows the bitrate target only while it is lowered', () => {
    expect(
      formatLoweredBitrate({ ...delivery, bitrateKbps: 4_800, chosenBitrateKbps: 6_000 })
    ).toBe('4.8 of 6 Mbps')
    expect(
      formatLoweredBitrate({ ...delivery, bitrateKbps: 6_000, chosenBitrateKbps: 6_000 })
    ).toBe('')
    expect(formatLoweredBitrate(delivery)).toBe('')
  })
})
