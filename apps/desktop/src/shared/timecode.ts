// Plan 174 S1.4 (E-20): one clock format for every clock, timestamp and
// table cell, in every window: "2:05", "1:02:05". Shared, because the marker
// and clip-mark copy in `shared/` speaks it too; the renderer reaches it
// through `lib/format-time.ts`.

export interface TimecodeOptions {
  /**
   * Show hours even under an hour ("0:02:05"), so a position lines up with
   * a duration of an hour or more (the player).
   */
  withHours?: boolean
}

/**
 * Milliseconds as m:ss, or h:mm:ss from one hour. Negative, NaN and
 * infinite times read as zero; partial seconds are dropped, never rounded up.
 */
export function formatTimecode(ms: number, { withHours = false }: TimecodeOptions = {}): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 || withHours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
