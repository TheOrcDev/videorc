import { describe, expect, it } from 'vitest'

import {
  DEFAULT_METER_BALLISTICS,
  INITIAL_METER_BALLISTICS,
  MIC_CLIP_HOLD_MS,
  MIC_CLIP_THRESHOLD_DB,
  MIC_METER_FLOOR_DB,
  MIC_METER_GATE_DB,
  advanceClipHoldDeadline,
  advanceMeterBallistics,
  amplitudeToDb,
  approachMeterLevel,
  dbToMeterLevel,
  fallbackBandLevels,
  gateMeterLevel,
  gatedDbToMeterLevel,
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

  it('gates room tone to the floor and leaves the dBFS window above it untouched', () => {
    expect(gatedDbToMeterLevel(0)).toBe(1)
    expect(gatedDbToMeterLevel(-30)).toBeCloseTo(0.5, 5)
    expect(gatedDbToMeterLevel(MIC_METER_GATE_DB)).toBeCloseTo(dbToMeterLevel(-55), 5)
    // -70 dBFS room tone (the old mapping painted it as a 63 % bar) → floor.
    expect(gatedDbToMeterLevel(-70)).toBe(0)
    expect(gatedDbToMeterLevel(-56)).toBe(0)
    expect(gatedDbToMeterLevel(MIC_METER_FLOOR_DB)).toBe(0)
    expect(gatedDbToMeterLevel(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(gatedDbToMeterLevel(Number.NaN)).toBe(0)
    // The same gate on an already-mapped backend level (audio.rs db_to_level).
    expect(gateMeterLevel(dbToMeterLevel(-70))).toBe(0)
    expect(gateMeterLevel(dbToMeterLevel(-56))).toBe(0)
    expect(gateMeterLevel(dbToMeterLevel(-54))).toBeCloseTo(dbToMeterLevel(-54), 5)
    expect(gateMeterLevel(1.5)).toBe(1)
  })

  it('approaches a target asymmetrically across the 48 ms analyser ticks', () => {
    // Attack: one tick with the 15 ms tau is essentially there.
    const risen = approachMeterLevel(0, 1, 48)
    expect(risen).toBeGreaterThan(0.95)
    expect(risen).toBeLessThanOrEqual(1)

    // Decay: the 350 ms tau needs several ticks — the bar falls, it does not snap.
    const decay: number[] = [risen]
    for (let tick = 0; tick < 8; tick += 1) {
      decay.push(approachMeterLevel(decay[decay.length - 1], 0, 48))
    }
    expect(decay[1]).toBeGreaterThan(0.8)
    expect(decay[1]).toBeLessThan(decay[0])
    for (let index = 1; index < decay.length; index += 1) {
      expect(decay[index]).toBeLessThan(decay[index - 1])
    }
    // ~350 ms later (7 ticks) the bar is near e^-1 of where it started.
    expect(decay[7]).toBeGreaterThan(0.3)
    expect(decay[7]).toBeLessThan(0.45)
    // Same distance, opposite direction, same elapsed: the rise is far larger.
    expect(1 - approachMeterLevel(0, 1, 48)).toBeLessThan(approachMeterLevel(1, 0, 48) / 10)
    // Out-of-range targets clamp; a zero tau snaps.
    expect(approachMeterLevel(0, 2, 1000)).toBeLessThanOrEqual(1)
    expect(approachMeterLevel(0.5, 1, 16, { ...DEFAULT_METER_BALLISTICS, attackMs: 0 })).toBe(1)
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

  it('shares the analyser gate so a swap between paths never jumps in height', () => {
    // Backend micLiveLevel for -70 dBFS room tone = (−70+60)/60 → 0 already;
    // -57 dBFS = 0.05 would have painted a sliver the analyser no longer does.
    expect(fallbackBandLevels(dbToMeterLevel(-57), 5)).toEqual([0, 0, 0, 0, 0])
    expect(fallbackBandLevels(dbToMeterLevel(-40), 5)[2]).toBeCloseTo(gatedDbToMeterLevel(-40), 5)
  })
})
