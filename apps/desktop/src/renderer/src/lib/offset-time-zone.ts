// Its own module so the eager `local-time.ts` can format at a fixed offset
// without pulling the Schedule dialog's formatting (`schedule-time.ts`) into
// the first-paint bundle: Rollup ships a module whole, in the chunk of its
// first eager importer.

/** `Intl`'s `timeZone` for a fixed UTC offset in minutes: -420 is "-07:00". */
export function offsetTimeZone(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const hours = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')
  const rest = String(Math.abs(minutes) % 60).padStart(2, '0')
  return `${sign}${hours}:${rest}`
}
