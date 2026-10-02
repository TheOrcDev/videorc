import { describe, expect, it } from 'vitest'

import { DEFAULT_MIN_DB } from './audio/decibels'
import {
  DEFAULT_METER_BALLISTICS,
  MIC_METER_FLOOR_DB,
  MIC_METER_GATE_DB,
  amplitudeToDb,
  approachMeterLevel,
  dbToMeterLevel,
  gatedDbToMeterLevel,
  matchMicrophoneDeviceId
} from './mic-meter'

describe('mic meter math', () => {
  it('floors at the same -60 dBFS as audiocn meters', () => {
    expect(MIC_METER_FLOOR_DB).toBe(DEFAULT_MIN_DB)
    expect(MIC_METER_FLOOR_DB).toBe(-60)
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
  })

  it('approaches a target asymmetrically across the 48 ms analyser ticks', () => {
    // Attack: one tick with the 15 ms tau is essentially there.
    const risen = approachMeterLevel(0, 1, 48)
    expect(risen).toBeGreaterThan(0.95)
    expect(risen).toBeLessThanOrEqual(1)

    // Decay: the 350 ms tau needs several ticks; the bar falls, it does not snap.
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
