// Pure math the visual microphone pipeline owns: the band calibration's dBFS
// mapping and noise gate, the per-band attack and decay, and backend-device →
// WebAudio device matching by label. No WebAudio, no DOM: unit-testable.
// Level meters, readouts, clip lights and their ballistics are audiocn's
// (lib/audio, plan 092); this file keeps only what the analyser's bands need.

import { DEFAULT_MIN_DB } from './audio/decibels'

/** The bottom of every meter range: audiocn's default, -60 dBFS. */
export const MIC_METER_FLOOR_DB = DEFAULT_MIN_DB
/**
 * Noise gate for the analyser's band visuals: room tone sits around
 * -70..-55 dBFS on an ungated input and must paint as silence, not as a third
 * of a bar. Below this the bar is at floor; at/above it the dBFS → level
 * mapping is untouched.
 */
export const MIC_METER_GATE_DB = -55

export function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 0) {
    return MIC_METER_FLOOR_DB
  }
  return Math.max(MIC_METER_FLOOR_DB, 20 * Math.log10(amplitude))
}

/** Linear-in-dB meter position over the floor..0 dBFS window, clamped to 0..1. */
export function dbToMeterLevel(db: number, floorDb: number = MIC_METER_FLOOR_DB): number {
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb))
}

/** dBFS → meter level with the shared noise gate: below the gate reads as floor. */
export function gatedDbToMeterLevel(
  db: number,
  gateDb: number = MIC_METER_GATE_DB,
  floorDb: number = MIC_METER_FLOOR_DB
): number {
  if (!Number.isFinite(db) || db < gateDb) {
    return 0
  }
  return dbToMeterLevel(db, floorDb)
}

export type MeterBallisticsOptions = {
  attackMs: number
  decayMs: number
}

export const DEFAULT_METER_BALLISTICS: MeterBallisticsOptions = {
  // Fast rise so a spoken syllable registers on the next frame; slower fall so
  // the bar reads as motion instead of flicker (broadcast PPM-ish feel). The
  // same times as audiocn's `peak` ballistics.
  attackMs: 15,
  decayMs: 350
}

function approach(current: number, target: number, elapsedMs: number, tauMs: number): number {
  if (tauMs <= 0) {
    return target
  }
  return current + (target - current) * (1 - Math.exp(-elapsedMs / tauMs))
}

/**
 * Band ballistics (no peak state, no allocation): fast attack toward a louder
 * target, slow decay toward a quieter one. The analyser pipeline runs this per
 * band on its 48 ms clock.
 */
export function approachMeterLevel(
  current: number,
  targetLevel: number,
  elapsedMs: number,
  options: MeterBallisticsOptions = DEFAULT_METER_BALLISTICS
): number {
  const target = Math.min(1, Math.max(0, targetLevel))
  const rising = target > current
  return approach(current, target, elapsedMs, rising ? options.attackMs : options.decayMs)
}

function normalizeDeviceName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Match the backend's selected microphone (CoreAudio/dshow name) to a WebAudio
 * input by label: exact normalized match first, then containment either way.
 * Returns undefined when nothing matches: callers fall back to the default
 * input rather than metering a device the user did not select.
 */
export function matchMicrophoneDeviceId(
  backendName: string | undefined,
  inputs: { deviceId: string; label: string }[]
): string | undefined {
  if (!backendName) {
    return undefined
  }
  const wanted = normalizeDeviceName(backendName)
  if (!wanted) {
    return undefined
  }
  const exact = inputs.find((input) => normalizeDeviceName(input.label) === wanted)
  if (exact) {
    return exact.deviceId
  }
  return inputs.find((input) => {
    const label = normalizeDeviceName(input.label)
    return label.length > 0 && (label.includes(wanted) || wanted.includes(label))
  })?.deviceId
}
