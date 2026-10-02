import type { YouTubeQuotaStatus } from '@/lib/backend'
import { BackendRequestError } from '@/backendClient'

// Plan 094: one shared paused state for YouTube's Data API. The backend owns
// the breaker (`youtube.quota` event, `youtube.quota.status` RPC, and the chat
// provider's `retryAt`). This module is the EAGER half: codes and predicates
// the Studio provider needs on every start/stop. Every piece of copy (resume
// times, paused messages, toasts, budget notices) lives in
// `@/lib/youtube-quota-copy`, loaded lazily where it is shown, so the strings
// stay out of the initial renderer bundle (the eager asset budget is tight).

/** Backend error codes a failed YouTube call can carry (plan 094, S2). */
export const YOUTUBE_QUOTA_PAUSED_CODE = 'youtube-quota-paused'
export const YOUTUBE_BROADCAST_NOT_FOUND_CODE = 'youtube-broadcast-not-found'

/** The breaker's end as `pausedUntil`, or null when YouTube calls may run. */
export function youtubeQuotaPausedUntil(
  status: YouTubeQuotaStatus | null | undefined
): Date | null {
  const raw = status?.pausedUntil
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * A failed `complete` the next start must never wait on: YouTube ends the
 * broadcast on its own (`enableAutoStop`) when the quota is out, and a
 * broadcast that no longer exists has nothing to end. Network and 5xx
 * failures keep the retain-and-retry path.
 */
export function isSettledYouTubeCompletionError(error: unknown): boolean {
  return (
    error instanceof BackendRequestError &&
    (error.code === YOUTUBE_QUOTA_PAUSED_CODE || error.code === YOUTUBE_BROADCAST_NOT_FOUND_CODE)
  )
}

export function isYouTubeQuotaPausedError(error: unknown): boolean {
  return error instanceof BackendRequestError && error.code === YOUTUBE_QUOTA_PAUSED_CODE
}
