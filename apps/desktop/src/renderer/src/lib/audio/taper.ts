import { clamp, DEFAULT_MIN_DB } from '@/lib/audio/decibels'
import type { Taper } from '@/lib/audio/types'

const DEFAULT_FADER_MAX_DB = 6
const DEFAULT_UNITY_POSITION = 0.75
const AUDIO_CURVE_EXPONENT = 2

/** Equal distance per unit across the range. */
export const linearTaper = (min: number, max: number): Taper => ({
  toPosition: (value) => {
    if (!(value > min)) {
      return 0
    }
    return clamp((value - min) / (max - min), 0, 1)
  },
  toValue: (position) => min + clamp(position, 0, 1) * (max - min)
})

export interface AudioTaperOptions {
  minDb?: number
  maxDb?: number
  /** Where 0 dB sits on the travel, 0..1. Default 0.75. */
  unityPosition?: number
}

/**
 * A console-style fader law: more travel around 0 dB, a fast fall to the
 * bottom of the range, and linear headroom above 0 dB.
 */
export const audioTaper = ({
  minDb = DEFAULT_MIN_DB,
  maxDb = DEFAULT_FADER_MAX_DB,
  unityPosition = DEFAULT_UNITY_POSITION
}: AudioTaperOptions = {}): Taper => {
  const anchorDb = Math.min(0, maxDb)
  const unity = maxDb > 0 ? clamp(unityPosition, 0, 1) : 1

  const toPosition = (db: number): number => {
    if (!(db > minDb)) {
      return 0
    }
    if (db >= maxDb) {
      return 1
    }
    if (db >= anchorDb) {
      return unity + ((db - anchorDb) / (maxDb - anchorDb)) * (1 - unity)
    }
    const ratio = (db - anchorDb) / (minDb - anchorDb)
    const travel = 1 - ratio ** (1 / AUDIO_CURVE_EXPONENT)
    return travel * unity
  }

  const toValue = (position: number): number => {
    const clamped = clamp(position, 0, 1)
    if (clamped >= unity) {
      if (unity >= 1) {
        return anchorDb
      }
      return anchorDb + ((clamped - unity) / (1 - unity)) * (maxDb - anchorDb)
    }
    const travel = unity > 0 ? clamped / unity : 0
    return anchorDb + (minDb - anchorDb) * (1 - travel) ** AUDIO_CURVE_EXPONENT
  }

  return { toPosition, toValue }
}

/** Logarithmic law for frequency and time parameters. `min` must be above 0. */
export const logTaper = (min: number, max: number): Taper => {
  const span = Math.log(max / min)
  return {
    toPosition: (value) => {
      if (!(value > min)) {
        return 0
      }
      return clamp(Math.log(value / min) / span, 0, 1)
    },
    toValue: (position) => min * Math.exp(clamp(position, 0, 1) * span)
  }
}

export type TaperInput = 'linear' | 'audio' | 'log' | Taper

/** Resolves a taper name or object for a range. */
export const resolveTaper = (taper: TaperInput, min: number, max: number): Taper => {
  if (typeof taper !== 'string') {
    return taper
  }
  if (taper === 'audio') {
    return audioTaper({ maxDb: max, minDb: min })
  }
  if (taper === 'log') {
    return logTaper(min, max)
  }
  return linearTaper(min, max)
}
