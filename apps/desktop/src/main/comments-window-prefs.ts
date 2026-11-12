/**
 * The Stream Manager's remembered choices that carry a version, read the
 * way the pin is (`commentsWindowAlwaysOnTopPreference` in main/index.ts):
 * a value counts only with the version it was written under, so a file from
 * before the choice existed, or a forged one, lands on the default.
 */

/** Hide from stream (plan 215 C1). Bump when the meaning of the value changes. */
export const COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION = 1

export interface CommentsWindowHiddenFromStreamPrefs {
  hiddenFromStream?: unknown
  hiddenFromStreamPreferenceVersion?: unknown
}

/** Off unless the file says on under the current version. */
export function commentsWindowHiddenFromStreamPreference(
  prefs: CommentsWindowHiddenFromStreamPrefs
): boolean {
  return (
    prefs.hiddenFromStreamPreferenceVersion ===
      COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION && prefs.hiddenFromStream === true
  )
}

/** The few file calls the prefs write needs, so its rules are testable. */
export interface PrefsFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
  renameSync(from: string, to: string): void
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/**
 * The saved prefs to merge a change into (plan 230). No file yet, or a file
 * that is already broken, starts empty. A file that exists but cannot be
 * read right now (locked by a scanner) gives null: writing then would
 * replace every pref with the one change, Hide from stream included.
 */
export function readPrefsForMerge(fs: PrefsFs, path: string): Record<string, unknown> | null {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? {} : null
  }
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Lands the whole file or nothing (plan 230): a write cut short by a crash
 * never leaves a half file. On Windows a scanner can hold the file for a
 * moment and block the rename; then it writes in place rather than lose the
 * change.
 */
export function writePrefsWhole(fs: PrefsFs, path: string, data: string): void {
  const next = `${path}.next`
  fs.writeFileSync(next, data)
  try {
    fs.renameSync(next, path)
  } catch (error) {
    if (!LOCKED.has(errorCode(error) ?? '')) throw error
    fs.writeFileSync(path, data)
  }
}
