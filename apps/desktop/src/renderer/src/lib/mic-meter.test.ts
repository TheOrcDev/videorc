import { describe, expect, it } from 'vitest'

import {
  DEFAULT_METER_BALLISTICS,
  INITIAL_METER_BALLISTICS,
  MIC_CLIP_HOLD_MS,
  MIC_CLIP_THRESHOLD_DB,
  MIC_METER_FLOOR_DB,
  advanceClipHoldDeadline,
  advanceMeterBallistics,
  amplitudeToDb,
  dbToMeterLevel,
  fallbackBandLevels,
  matchMicrophoneDeviceId,
  samplesRmsAndPeak
} from './mic-meter'

describe('mic meter math', () => {
  it('computes rms and peak over a buffer', () => {
    const { rms, peak } = samplesRmsAndPeak(new Float32Array([0, 0.5, -0.5, 0]))
    expect(peak).toBe(0.5)
    expect(rms).toBeCloseTo(Math.sqrt(0.125), 5)
    expect(samplesRmsAndPeak(new Float32Array([]))).toEqual({ rms: 0, peak: 0 })
  })

  it('maps amplitude to dBFS with a hard floor', () => {
    expect(amplitudeToDb(1)).toBe(0)
    expect(amplitudeToDb(0.1)).toBeCloseTo(-20, 5)
    expect(amplitudeToDb(0)).toBe(MIC_METER_FLOOR_DB)
    expect(dbToMeterLevel(0)).toBe(1)
    expect(dbToMeterLevel(MIC_METER_FLOOR_DB)).toBe(0)
    expect(dbToMeterLevel(-30)).toBeCloseTo(0.5, 5)
  })

  it('rises fast on attack and falls slower on decay', () => {
    const attacked = advanceMeterBallistics(INITIAL_METER_BALLISTICS, 1, 16, 0)
    // One 16ms frame with a 15ms attack tau covers most of the distance.
    expect(attacked.level).toBeGreaterThan(0.6)

    const decayed = advanceMeterBallistics(attacked, 0, 16, 16)
    // The same frame length on the 350ms decay tau barely moves the bar.
    expect(decayed.level).toBeGreaterThan(attacked.level * 0.9)
    expect(decayed.level).toBeLessThan(attacked.level)
  })

  it('holds the peak marker before letting it decay toward the bar', () => {
    const spiked = advanceMeterBallistics(INITIAL_METER_BALLISTICS, 0.8, 16, 0)
    expect(spiked.peakLevel).toBe(0.8)
    expect(spiked.peakHeldUntilMs).toBe(DEFAULT_METER_BALLISTICS.peakHoldMs)

    // Still inside the hold window: the peak must not move.
    const held = advanceMeterBallistics(spiked, 0, 16, 100)
    expect(held.peakLevel).toBe(0.8)

    // After the hold window it decays toward the (lower) bar level.
    const released = advanceMeterBallistics(held, 0, 200, spiked.peakHeldUntilMs + 1)
    expect(released.peakLevel).toBeLessThan(0.8)
    expect(released.peakLevel).toBeGreaterThanOrEqual(released.level)
  })

  it('matches the backend device to a WebAudio input by label', () => {
    const inputs = [
      { deviceId: 'default', label: 'Default - Shure MV7+' },
      { deviceId: 'a', label: 'Shure MV7+' },
      { deviceId: 'b', label: 'MacBook Pro Microphone' }
    ]
    expect(matchMicrophoneDeviceId('Shure MV7+', inputs)).toBe('a')
    expect(matchMicrophoneDeviceId('MacBook Pro Microphone', inputs)).toBe('b')
    // Containment either way covers vendor suffix differences.
    expect(matchMicrophoneDeviceId('Pro Microphone', [inputs[2]])).toBe('b')
    expect(matchMicrophoneDeviceId('Elgato Wave:3', inputs)).toBeUndefined()
    expect(matchMicrophoneDeviceId(undefined, inputs)).toBeUndefined()
  })
})

describe('clip hold deadline', () => {
  it('arms and extends the deadline while peaks are at or above the threshold', () => {
    expect(advanceClipHoldDeadline(0, MIC_CLIP_THRESHOLD_DB, 1000)).toBe(1000 + MIC_CLIP_HOLD_MS)
    expect(advanceClipHoldDeadline(0, 0, 1000)).toBe(1000 + MIC_CLIP_HOLD_MS)
    expect(advanceClipHoldDeadline(2000, 0, 1500)).toBe(1500 + MIC_CLIP_HOLD_MS)
  })

  it('leaves the running deadline untouched for quiet or missing peaks', () => {
    expect(advanceClipHoldDeadline(2500, -12, 1000)).toBe(2500)
    expect(advanceClipHoldDeadline(2500, null, 1000)).toBe(2500)
  })
})

describe('fallback band levels', () => {
  it('renders a center-weighted hump whose center equals the level', () => {
    const bands = fallbackBandLevels(0.8, 5)
    expect(bands).toHaveLength(5)
    expect(bands[2]).toBeCloseTo(0.8, 5)
    expect(bands[0]).toBeCloseTo(0.8 * 0.4, 5)
    expect(bands[0]).toBeCloseTo(bands[4], 5)
    expect(bands[1]).toBeGreaterThan(bands[0])
  })

  it('clamps levels and handles degenerate band counts', () => {
    expect(fallbackBandLevels(2, 1)).toEqual([1])
    expect(fallbackBandLevels(-1, 3)).toEqual([0, 0, 0])
    expect(fallbackBandLevels(0.5, 0)).toEqual([])
  })
})
