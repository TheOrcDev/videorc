import type { YouTubeThumbnailResult } from '@/lib/backend'

/**
 * A failed Broadcast info thumbnail upload (plan 083), or null. The event is
 * untyped on the wire, so anything that is not a well-formed failure is
 * ignored; an uploaded thumbnail is silent.
 */
export function youtubeThumbnailFailure(payload: unknown): YouTubeThumbnailResult | null {
  if (typeof payload !== 'object' || payload === null) return null
  const result = payload as Partial<YouTubeThumbnailResult>
  if (
    result.state !== 'error' ||
    typeof result.broadcastId !== 'string' ||
    !result.broadcastId ||
    typeof result.accountId !== 'string'
  ) {
    return null
  }
  return {
    platform: 'youtube',
    accountId: result.accountId,
    broadcastId: result.broadcastId,
    targetId: typeof result.targetId === 'string' ? result.targetId : undefined,
    state: 'error',
    code: typeof result.code === 'string' ? result.code : undefined,
    message:
      typeof result.message === 'string' && result.message
        ? result.message
        : "The thumbnail wasn't set. The stream isn't affected.",
    retryable: result.retryable === true
  }
}
