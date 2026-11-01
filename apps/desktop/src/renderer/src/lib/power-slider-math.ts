export interface SliderRange {
  min: number
  max: number
  step: number
}

// PowerSlider's value math. Pure and framework-free, so the exact clamping,
// stepping and formatting the slider relies on is tested directly: the
// component never re-implements value logic, and every value clamps through
// the same helpers the tests use. No DOM and no React here.

function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return 0
  }
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Clamps into [min, max] and snaps to the step grid (anchored at min), fixing
 * the floating-point drift that 0.1-style steps produce. NaN falls back to min
 * so a bad numeric entry can never escape the range; ±Infinity clamps to its
 * bound.
 */
export function clampToRange(value: number, range: SliderRange): number {
  const { min, max, step } = range
  if (Number.isNaN(value)) {
    return min
  }
  const bounded = Math.min(max, Math.max(min, value))
  if (!Number.isFinite(step) || step <= 0) {
    return bounded
  }
  const snapped = min + Math.round((bounded - min) / step) * step
  return roundTo(Math.min(max, Math.max(min, snapped)), stepDecimals(step))
}

/**
 * One keyboard move. `large` (Shift+arrow) uses `largeStep`, 10× the step by
 * default. `direction` is the sign of the move.
 */
export function stepValue(
  value: number,
  range: SliderRange,
  direction: number,
  options: { large?: boolean; largeStep?: number } = {}
): number {
  const base = options.large ? (options.largeStep ?? range.step * 10) : range.step
  const sign = direction < 0 ? -1 : 1
  return clampToRange(value + base * sign, range)
}

/**
 * Parses a typed number. Blank or non-numeric input returns null (nothing to
 * commit); anything else clamps and snaps into the range.
 */
export function parseNumericInput(raw: string, range: SliderRange): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return clampToRange(parsed, range)
}

/**
 * The readout: fixed decimals (from the step unless overridden), an optional
 * unit suffix, and a leading "+" on a positive bipolar value so offsets read
 * signed.
 */
export function formatValue(
  value: number,
  options: {
    suffix?: string
    decimals?: number
    bipolar?: boolean
    step?: number
  } = {}
): string {
  const decimals = options.decimals ?? stepDecimals(options.step ?? 1)
  const rounded = roundTo(value, decimals)
  const sign = options.bipolar && rounded > 0 ? '+' : ''
  return `${sign}${rounded.toFixed(decimals)}${options.suffix ?? ''}`
}

/**
 * A value's place along the track, 0 to 100: where a mark or the bipolar
 * midpoint sits.
 */
export function valuePercent(value: number, range: SliderRange): number {
  const { min, max } = range
  if (max <= min) {
    return 0
  }
  const bounded = Math.min(max, Math.max(min, value))
  return roundTo(((bounded - min) / (max - min)) * 100, 3)
}
