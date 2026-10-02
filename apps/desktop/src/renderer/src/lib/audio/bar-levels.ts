import { resampleLevels } from '@/lib/audio/bands'
import { clamp } from '@/lib/audio/decibels'

const RELEASE_PER_FRAME = 0.86
const FRAME_MS = 16.67
const SIGNAL_THRESHOLD = 0.02
const MS_PER_SECOND = 1000
/** Bars this close to their target have nothing left to animate. */
const SETTLE_EPSILON = 0.002

/** What bars do with no signal. */
export type BarIdle = 'static' | 'pulse' | 'wave'

export interface BarLevelsOptions {
  barCount: number
  idle: BarIdle
  /** Runs a sweep, for connecting or thinking states. */
  loading: boolean
  /** Resting bar size, 0..1. */
  minLevel: number
  /** Symmetric around the middle bar, lows in the centre. */
  mirrored: boolean
  /** No release smoothing, idle animation or sweep. */
  reducedMotion: boolean
}

export interface BarLevels {
  /** The level each bar shows, 0..1, never below `minLevel`. */
  levels: Float32Array
  /**
   * Advances to `nowMs` with the latest input levels (resampled to the bar
   * count). Returns true when the input is above the signal floor.
   */
  step: (nowMs: number, input: ArrayLike<number> | null) => boolean
  /**
   * True after a step that left nothing to animate: every bar is at its
   * target, and no idle animation or loading sweep is running.
   */
  readonly settled: boolean
}

const idleLevel = (idle: BarIdle, index: number, seconds: number) => {
  if (idle === 'pulse') {
    return 0.1 * (0.5 + 0.5 * Math.sin(seconds * Math.PI * 1.6))
  }
  if (idle === 'wave') {
    return 0.16 * (0.5 + 0.5 * Math.sin(seconds * 4 - index * 0.55))
  }
  return 0
}

const sweepLevel = (index: number, count: number, seconds: number) => {
  const span = count + 6
  const position = ((seconds * count * 0.9) % span) - 3
  return 0.55 * Math.exp(-((index - position) ** 2) / 3)
}

const targetIndexFor = (index: number, count: number, half: number, mirrored: boolean) => {
  if (!mirrored) {
    return index
  }
  return Math.min(half - 1, Math.floor(Math.abs(index - (count - 1) / 2)))
}

const loudestOf = (values: Float32Array) => {
  let loudest = 0
  for (const value of values) {
    loudest = Math.max(loudest, value)
  }
  return loudest
}

/**
 * Bar levels shared by the bar visualizers: input resampled to the bar count,
 * instant attack with a smooth release, mirroring, idle animations and the
 * loading sweep.
 */
export const createBarLevels = ({
  barCount,
  idle,
  loading,
  minLevel,
  mirrored,
  reducedMotion
}: BarLevelsOptions): BarLevels => {
  const half = mirrored ? Math.ceil(barCount / 2) : barCount
  const targets = new Float32Array(half)
  const current = new Float32Array(barCount)
  const levels = new Float32Array(barCount).fill(minLevel)
  let lastMs = 0
  let settled = false

  const extraLevel = (index: number, seconds: number, quiet: boolean) => {
    if (loading && !reducedMotion) {
      return sweepLevel(index, barCount, seconds)
    }
    return quiet ? idleLevel(idle, index, seconds) : 0
  }

  const readInput = (input: ArrayLike<number> | null) => {
    if (input && input.length > 0) {
      resampleLevels(input, 0, input.length, targets)
    } else {
      targets.fill(0)
    }
  }

  const step = (nowMs: number, input: ArrayLike<number> | null) => {
    const elapsed = lastMs === 0 ? FRAME_MS : nowMs - lastMs
    lastMs = nowMs
    const release = reducedMotion ? 0 : RELEASE_PER_FRAME ** (elapsed / FRAME_MS)
    const seconds = nowMs / MS_PER_SECOND
    readInput(input)
    const active = loudestOf(targets) >= SIGNAL_THRESHOLD
    const quiet = !(reducedMotion || active)
    const animating = (loading && !reducedMotion) || (quiet && idle !== 'static')
    let converged = true

    for (let index = 0; index < barCount; index += 1) {
      const target = Math.max(
        targets[targetIndexFor(index, barCount, half, mirrored)] ?? 0,
        extraLevel(index, seconds, quiet)
      )
      const previous = current[index] ?? 0
      const next = target >= previous ? target : previous * release + target * (1 - release)
      current[index] = next
      levels[index] = clamp(Math.max(minLevel, next), 0, 1)
      if (Math.abs(next - target) > SETTLE_EPSILON) {
        converged = false
      }
    }
    settled = converged && !animating
    return active
  }

  return {
    levels,
    get settled() {
      return settled
    },
    step
  }
}
