export const DEFAULT_MIN_DB = -60
/** Default top of a meter's range, in dBFS. */
export const DEFAULT_MAX_DB = 0
/** Digital silence. */
export const SILENCE_DB = Number.NEGATIVE_INFINITY

const AMPLITUDE_DB_FACTOR = 20
const MINUS_SIGN = '−'
const INFINITY_SIGN = '∞'

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Decibels to linear gain. `-Infinity` gives 0. */
export const dbToGain = (db: number): number => {
  if (db === SILENCE_DB) {
    return 0
  }
  return 10 ** (db / AMPLITUDE_DB_FACTOR)
}

/** Linear gain to decibels. 0 (or less) gives `-Infinity`. */
export const gainToDb = (gain: number): number => {
  if (gain <= 0) {
    return SILENCE_DB
  }
  return AMPLITUDE_DB_FACTOR * Math.log10(gain)
}

/** dBFS to a 0..1 level, linear in dB over `minDb..maxDb`, clamped. */
export const dbToLevel = (
  db: number,
  minDb: number = DEFAULT_MIN_DB,
  maxDb: number = DEFAULT_MAX_DB
): number => {
  if (!(db > minDb)) {
    return 0
  }
  return clamp((db - minDb) / (maxDb - minDb), 0, 1)
}

/** A 0..1 level back to dBFS over `minDb..maxDb`. The inverse of `dbToLevel`. */
export const levelToDb = (
  level: number,
  minDb: number = DEFAULT_MIN_DB,
  maxDb: number = DEFAULT_MAX_DB
): number => minDb + clamp(level, 0, 1) * (maxDb - minDb)

/**
 * Clamps a dB value to a range. With `allowSilence`, `-Infinity` passes
 * through instead of becoming `minDb`.
 */
export const clampDb = (
  db: number,
  minDb: number,
  maxDb: number,
  options: { allowSilence?: boolean } = {}
): number => {
  if (db === SILENCE_DB && options.allowSilence) {
    return SILENCE_DB
  }
  if (Number.isNaN(db)) {
    return minDb
  }
  return clamp(db, minDb, maxDb)
}

export interface FormatDbOptions {
  /** Digits after the decimal point. Default 1. */
  decimals?: number
  /** Append " dB". Default true. */
  unit?: boolean
  /**
   * `auto` shows "+" for positive values and "−" for negative ones,
   * `negative` only shows "−", `never` shows no sign. Default `auto`.
   */
  sign?: 'auto' | 'negative' | 'never'
  /** At or below this value, show "−∞". Default `-Infinity`. */
  floorDb?: number
}

/** Formats decibels for display: "−12.3 dB", "+3.0 dB", "−∞ dB". */
export const formatDb = (db: number, options: FormatDbOptions = {}): string => {
  const { decimals = 1, unit = true, sign = 'auto', floorDb = SILENCE_DB } = options
  const suffix = unit ? ' dB' : ''

  // No reading yet. Two hyphens rather than a dash: hosts such as Videorc ban
  // the em dash from user-facing copy.
  if (Number.isNaN(db)) {
    return `--${suffix}`
  }
  if (db === SILENCE_DB || db <= floorDb) {
    const prefix = sign === 'never' ? '' : MINUS_SIGN
    return `${prefix}${INFINITY_SIGN}${suffix}`
  }

  const rounded = Number(db.toFixed(decimals))
  const magnitude = Math.abs(rounded).toFixed(decimals)

  if (rounded === 0 || sign === 'never') {
    return `${magnitude}${suffix}`
  }
  if (rounded < 0) {
    return `${MINUS_SIGN}${magnitude}${suffix}`
  }
  const plus = sign === 'auto' ? '+' : ''
  return `${plus}${magnitude}${suffix}`
}

/** Sample peak of a block of samples, in dBFS. */
export const peakDb = (samples: Iterable<number>): number => {
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) {
      peak = magnitude
    }
  }
  return gainToDb(peak)
}

/** RMS level of a block of samples, in dBFS. */
export const rmsDb = (samples: Iterable<number>): number => {
  let sumOfSquares = 0
  let count = 0
  for (const sample of samples) {
    sumOfSquares += sample * sample
    count += 1
  }
  if (count === 0) {
    return SILENCE_DB
  }
  return gainToDb(Math.sqrt(sumOfSquares / count))
}
