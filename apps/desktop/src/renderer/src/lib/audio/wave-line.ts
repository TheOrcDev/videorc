import { createBarLevels } from '@/lib/audio/bar-levels'
import { clamp } from '@/lib/audio/decibels'
import type { VisualFrame } from '@/lib/audio/types'

const MS_PER_SECOND = 1000
const FRAME_MS = 16.67
const MAX_STEP_SECONDS = 0.05
const TWO_PI = Math.PI * 2
/** Below this the line counts as silent. */
const SIGNAL_THRESHOLD = 0.02
/** Share of the distance to the new shape still left after one frame. */
const EASE_PER_FRAME = 0.45
/** Loudness left after one frame of silence. */
const LOUDNESS_RELEASE = 0.92

/** Cycles across the width, drift in radians per second and weight of each band group, lows first. */
const WAVE_PARTIALS = [
  { cycles: 1.5, drift: 0.8, weight: 0.6 },
  { cycles: 2.5, drift: -1.3, weight: 0.4 },
  { cycles: 4, drift: 2.1, weight: 0.25 },
  { cycles: 6.5, drift: -3.2, weight: 0.16 }
] as const

/** Scope mode lifts quiet signals by at most this much. */
const SCOPE_MAX_GAIN = 4
/** Scope mode scales its running peak to this height. */
const SCOPE_TARGET = 0.9
/** Share of the scope's running peak left after one frame. */
const SCOPE_PEAK_RELEASE = 0.985

/** Widths per second the loading pulse travels. */
const LOADING_SPEED = 0.55
/** Where the loading pulse rests with reduced motion: the middle. */
const LOADING_REST_SECONDS = 0.7 / LOADING_SPEED

/** Most points a line can have. */
export const WAVE_LINE_MAX_POINTS = 513

/**
 * `wave` is a smooth wave shaped by the frequency bands. `scope` is the
 * signal itself, like an oscilloscope.
 */
export type WaveLineMode = 'wave' | 'scope'

export interface WaveLineOptions {
  mode: WaveLineMode
  /** Runs a pulse along the line instead of following the signal. */
  loading: boolean
  /** Visual gain. */
  sensitivity: number
  /** No drift or easing: the line jumps to each new shape. */
  reducedMotion: boolean
}

export interface WaveLine {
  /** Points in use, left to right. */
  count: number
  /** Height at each point, −1..1, up positive, eased toward the latest shape. */
  heights: Float32Array
  /** Highest point of the latest shape before easing, 0..1. It jumps on sudden rises. */
  peak: number
  /** How loud the line is, 0..1: its highest point, released slowly. */
  loudness: number
  /**
   * Advances to `nowMs` with the latest frame, over `count` points. Returns
   * true when there is a signal.
   */
  step: (nowMs: number, frame: VisualFrame | null, count: number) => boolean
}

/**
 * Where the signal first rises through zero in its first quarter, between
 * samples, so a steady tone stands still. 0 when it never does.
 */
export const triggerIndex = (samples: ArrayLike<number>): number => {
  const limit = Math.floor(samples.length / 4)
  for (let index = 1; index <= limit; index += 1) {
    const before = samples[index - 1] ?? 0
    const after = samples[index] ?? 0
    if (before < 0 && after >= 0) {
      return index - 1 + -before / (after - before)
    }
  }
  return 0
}

const peakOf = (values: ArrayLike<number>, count: number) => {
  let peak = 0
  for (let index = 0; index < count; index += 1) {
    peak = Math.max(peak, Math.abs(values[index] ?? 0))
  }
  return peak
}

/** Fits three quarters of the samples, from the trigger, into `count` heights. */
const fillScope = (samples: ArrayLike<number>, out: Float32Array, count: number, gain: number) => {
  const start = triggerIndex(samples)
  const span = Math.floor(samples.length * 0.75) - 1
  for (let point = 0; point < count; point += 1) {
    const position = start + (span * point) / (count - 1)
    const index = Math.floor(position)
    const before = samples[index] ?? 0
    const after = samples[Math.min(samples.length - 1, index + 1)] ?? before
    const value = before + (after - before) * (position - index)
    out[point] = clamp(value * gain, -1, 1)
  }
}

/** A short wave packet that travels left to right. */
const loadingPulse = (position: number, seconds: number) => {
  const center = ((seconds * LOADING_SPEED) % 1.4) - 0.2
  const envelope = Math.exp(-((position - center) ** 2) / 0.012)
  return 0.6 * envelope * Math.sin(TWO_PI * (position * 7 - seconds * 2.5))
}

/**
 * The shape of a single line across the width, shared by the line
 * visualizers: a drifting wave shaped by the frequency bands, a triggered
 * oscilloscope trace, or a loading pulse, eased from frame to frame.
 */
export const createWaveLine = ({
  loading,
  mode,
  reducedMotion,
  sensitivity
}: WaveLineOptions): WaveLine => {
  const targets = new Float32Array(WAVE_LINE_MAX_POINTS)
  const bands = createBarLevels({
    barCount: WAVE_PARTIALS.length,
    idle: 'static',
    loading: false,
    minLevel: 0,
    mirrored: false,
    reducedMotion
  })
  const phases = new Float32Array(WAVE_PARTIALS.length)
  const state = {
    count: 2,
    heights: new Float32Array(WAVE_LINE_MAX_POINTS),
    loudness: 0,
    peak: 0
  }
  let lastMs = 0
  let scopePeak = 0

  const fillWave = (frame: VisualFrame | null, nowMs: number) => {
    bands.step(nowMs, frame?.bands ?? null)
    for (let point = 0; point < state.count; point += 1) {
      const position = point / (state.count - 1)
      let height = 0
      for (const [index, partial] of WAVE_PARTIALS.entries()) {
        height +=
          partial.weight *
          (bands.levels[index] ?? 0) *
          Math.sin(TWO_PI * partial.cycles * position + (phases[index] ?? 0))
      }
      targets[point] = clamp(height * sensitivity, -1, 1)
    }
  }

  const fillTargets = (nowMs: number, frame: VisualFrame | null) => {
    const { count } = state
    if (loading) {
      const seconds = reducedMotion ? LOADING_REST_SECONDS : nowMs / MS_PER_SECOND
      for (let point = 0; point < count; point += 1) {
        targets[point] = loadingPulse(point / (count - 1), seconds)
      }
      return
    }
    const samples = frame?.timeDomain
    if (mode === 'scope' && samples && samples.length > 1) {
      scopePeak = Math.max(peakOf(samples, samples.length), scopePeak * SCOPE_PEAK_RELEASE)
      const gain = sensitivity * Math.min(SCOPE_MAX_GAIN, SCOPE_TARGET / (scopePeak || 1))
      fillScope(samples, targets, count, gain)
      return
    }
    fillWave(frame, nowMs)
  }

  const ease = (elapsedMs: number) => {
    const share = reducedMotion ? 1 : 1 - EASE_PER_FRAME ** (elapsedMs / FRAME_MS)
    for (let point = 0; point < state.count; point += 1) {
      const height = state.heights[point] ?? 0
      state.heights[point] = height + ((targets[point] ?? 0) - height) * share
    }
    const release = LOUDNESS_RELEASE ** (elapsedMs / FRAME_MS)
    state.loudness = Math.max(peakOf(state.heights, state.count), state.loudness * release)
  }

  const step = (nowMs: number, frame: VisualFrame | null, count: number) => {
    const elapsedMs = lastMs === 0 ? FRAME_MS : nowMs - lastMs
    lastMs = nowMs
    state.count = clamp(Math.round(count), 2, WAVE_LINE_MAX_POINTS)
    if (!reducedMotion) {
      const seconds = clamp(elapsedMs / MS_PER_SECOND, 0, MAX_STEP_SECONDS)
      for (const [index, partial] of WAVE_PARTIALS.entries()) {
        phases[index] = ((phases[index] ?? 0) + partial.drift * seconds) % TWO_PI
      }
    }
    fillTargets(nowMs, frame)
    state.peak = peakOf(targets, state.count)
    ease(elapsedMs)
    return !loading && state.peak >= SIGNAL_THRESHOLD
  }

  return Object.assign(state, { step })
}
