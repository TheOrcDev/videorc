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
