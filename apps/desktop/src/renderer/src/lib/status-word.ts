// Plan 174 S1.3 (A-6): a status chip or dot says a word in sentence case
// ("Needs permission"), never a machine value ("permission-needed"). The
// primitives used to `capitalize` whatever they were given, which turned raw
// enums into Title Case chips ("Device-Missing", "Checked On First Use")
// instead of exposing the leak. Callers now map every state to a word, and
// this guard catches the ones that slip through.

/** A lower-case, hyphenated machine value: `connected`, `device-missing`. */
const RAW_STATUS_VALUE = /^[a-z-]+$/

export function isRawStatusValue(text: string): boolean {
  return RAW_STATUS_VALUE.test(text)
}

/**
 * The last resort for a state no map names yet: `device-missing` reads
 * "Device missing". A map that names the state always wins.
 */
export function statusWordFromValue(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced
}

/**
 * Reports a raw value that reached a status primitive. Under test it
 * throws, so a leak fails CI; the dev app logs it and keeps running; a
 * production build says nothing.
 */
export function assertStatusWord(text: string | undefined, component: string): void {
  if (!text || !isRawStatusValue(text)) return
  const message = `${component} got the raw status value "${text}". Map it to a status word first (lib/state-labels.ts).`
  if (import.meta.env.MODE === 'test') throw new Error(message)
  if (import.meta.env.DEV) console.error(message)
}
