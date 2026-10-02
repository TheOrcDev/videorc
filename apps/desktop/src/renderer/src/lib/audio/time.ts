const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const MINUS_SIGN = '−'

export interface FormatTimeOptions {
  /** Prefix with "−", for time remaining. */
  remaining?: boolean
  /** Always show hours. */
  hours?: boolean
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Formats seconds as `m:ss`, or `h:mm:ss` from one hour. */
export const formatTime = (seconds: number, options: FormatTimeOptions = {}): string => {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(total / SECONDS_PER_HOUR)
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const secs = total % SECONDS_PER_MINUTE
  const prefix = options.remaining ? MINUS_SIGN : ''

  if (hours > 0 || options.hours) {
    return `${prefix}${hours}:${pad(minutes)}:${pad(secs)}`
  }
  return `${prefix}${minutes}:${pad(secs)}`
}
