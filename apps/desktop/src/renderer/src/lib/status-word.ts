declare const process: { env: { NODE_ENV?: string } } | undefined

// The status vocabulary StatusBadge and StatusDot share: five tones, and the
// rule that a status chip or dot says a word in sentence case ("Needs
// permission"), never a machine value ("permission-needed"). The primitives
// used to `capitalize` whatever they were given, which turned raw enums into
// Title Case chips ("Device-Missing") instead of exposing the leak. Callers
// map every state to a word, and `assertStatusWord` catches the ones that slip
// through.

// `process` is declared above so the lib needs no Node types; bundlers still
// replace the `process.env.NODE_ENV` expression below with a literal.

/**
 * What a status means, never how it looks: `good` works, `warn` is degraded,
 * `error` failed, `live` is recording or on air, `neutral` is idle.
 */
export type StatusTone = 'good' | 'warn' | 'error' | 'live' | 'neutral'

/** The `tone-*` utility that sets `--chip-tone` for each tone. */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  error: 'tone-destructive',
  good: 'tone-success',
  live: 'tone-live',
  neutral: 'tone-neutral',
  warn: 'tone-warning'
}

/** A lower-case, hyphenated machine value: `connected`, `device-missing`. */
const RAW_STATUS_VALUE = /^[a-z-]+$/u
const VALUE_SEPARATORS = /[-_]+/gu

export function isRawStatusValue(text: string): boolean {
  return RAW_STATUS_VALUE.test(text)
}

/**
 * The last resort for a state no map names yet: `device-missing` reads
 * "Device missing". A map that names the state always wins.
 */
export function statusWordFromValue(value: string): string {
  const spaced = value.replaceAll(VALUE_SEPARATORS, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced
}

/**
 * The build's mode. Bundlers replace `process.env.NODE_ENV` with a literal;
 * where nothing does and there is no `process` (a plain browser), it reads as
 * production.
 */
function buildMode(): string | undefined {
  try {
    return process?.env.NODE_ENV
  } catch {
    return undefined
  }
}

/**
 * Reports a raw value that reached a status primitive. Under test it throws,
 * so a leak fails CI; a development build logs it and keeps running; a
 * production build says nothing.
 */
export function assertStatusWord(text: string | undefined, component: string): void {
  if (!(text && isRawStatusValue(text))) {
    return
  }
  const message = `${component} got the raw status value "${text}". Map it to a status word first.`
  const mode = buildMode()
  if (mode === 'test') {
    throw new Error(message)
  }
  if (mode === 'development') {
    // oxlint-disable-next-line no-console -- A developer warning, never shown in production.
    console.error(message)
  }
}
