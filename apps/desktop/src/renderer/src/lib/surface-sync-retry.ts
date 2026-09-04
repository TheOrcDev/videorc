import { BackendRequestError } from '../backendClient'

/**
 * Background preview-surface bounds sync is latest-wins maintenance: the
 * newest bounds always supersede, and the periodic window reconciler
 * re-drives them within a tick. These backend outcomes mean "not now", not
 * "broken" — they are absorbed silently instead of surfacing an error toast
 * to a user who did nothing (the 2026-08-27 live-stream incident showed a
 * raw 30s outcome-unknown timeout and a lane-full rejection as alarming
 * errors while the stream itself was healthy).
 */
const RETRYABLE_BACKGROUND_SYNC_CODES: ReadonlySet<string> = new Set([
  // Bounded lifecycle acquisition: another surface lifecycle operation
  // (create/destroy/heal) holds the lock; retry lands after it.
  'surface-busy',
  // The ordered command lane rejected the enqueue outright.
  'command-lane-full',
  // The command sat queued past its dispatch deadline and was not applied.
  'command-expired-before-dispatch',
  // The client-side timeout fired after send; the outcome is unknown, and
  // for latest-wins bounds a re-send is always safe.
  'request-outcome-unknown'
])

export const isRetryableBackgroundSurfaceSyncError = (error: unknown): boolean =>
  error instanceof BackendRequestError && RETRYABLE_BACKGROUND_SYNC_CODES.has(error.code)
