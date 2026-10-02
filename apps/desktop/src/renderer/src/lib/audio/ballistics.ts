import { dbToGain, gainToDb } from '@/lib/audio/decibels'

/** How a meter moves between readings. All times are in milliseconds. */
export interface BallisticsOptions {
  /** Time constant for rising levels. 0 jumps instantly. */
  attackMs: number
  /** Time constant for falling levels. 0 drops instantly. */
  releaseMs: number
  /** How long the peak-hold marker stays before it starts to fall. 0 disables it. */
  peakHoldMs: number
  /** Time constant for the peak-hold marker's fall. */
  peakReleaseMs: number
}

export const BALLISTICS = {
  instant: { attackMs: 0, peakHoldMs: 0, peakReleaseMs: 0, releaseMs: 0 },
  peak: { attackMs: 15, peakHoldMs: 1200, peakReleaseMs: 600, releaseMs: 350 },
  vu: { attackMs: 300, peakHoldMs: 0, peakReleaseMs: 300, releaseMs: 300 }
} as const satisfies Record<string, BallisticsOptions>

export type BallisticsPreset = keyof typeof BALLISTICS

export type BallisticsInput = BallisticsPreset | Partial<BallisticsOptions>

export const resolveBallistics = (input: BallisticsInput = 'peak'): BallisticsOptions => {
  if (typeof input === 'string') {
    return BALLISTICS[input]
  }
  return { ...BALLISTICS.peak, ...input }
}

export interface BallisticsState {
  /** The smoothed level in dBFS. */
  db: number
  /** The peak-hold level in dBFS. */
  holdDb: number
}

export interface Ballistics {
  step: (inputDb: number, nowMs: number) => BallisticsState
  reset: () => void
}

const smoothingFactor = (elapsedMs: number, timeConstantMs: number): number => {
  if (timeConstantMs <= 0) {
    return 1
  }
  return 1 - Math.exp(-elapsedMs / timeConstantMs)
}

/**
 * Creates a meter ballistics integrator. Smoothing runs on linear amplitude,
 * so a falling level drops at a steady rate in dB, like a hardware meter.
 */
export const createBallistics = (input?: BallisticsInput): Ballistics => {
  const options = resolveBallistics(input)
  let amplitude = 0
  let holdAmplitude = 0
  let holdUntilMs = 0
  let lastMs: number | null = null

  const reset = () => {
    amplitude = 0
    holdAmplitude = 0
    holdUntilMs = 0
    lastMs = null
  }

  const step = (inputDb: number, nowMs: number): BallisticsState => {
    const target = dbToGain(inputDb)

    if (lastMs === null) {
      amplitude = target
    } else {
      const elapsedMs = Math.max(0, nowMs - lastMs)
      const timeConstant = target > amplitude ? options.attackMs : options.releaseMs
      amplitude += (target - amplitude) * smoothingFactor(elapsedMs, timeConstant)
    }

    if (options.peakHoldMs <= 0) {
      holdAmplitude = amplitude
    } else if (amplitude >= holdAmplitude) {
      holdAmplitude = amplitude
      holdUntilMs = nowMs + options.peakHoldMs
    } else if (nowMs > holdUntilMs && lastMs !== null) {
      const elapsedMs = Math.max(0, nowMs - Math.max(lastMs, holdUntilMs))
      holdAmplitude -=
        (holdAmplitude - amplitude) * smoothingFactor(elapsedMs, options.peakReleaseMs)
    }

    lastMs = nowMs
    return { db: gainToDb(amplitude), holdDb: gainToDb(holdAmplitude) }
  }

  return { reset, step }
}
