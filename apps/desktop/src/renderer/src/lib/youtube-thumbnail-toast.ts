import { toast } from '@/lib/toast'

import type { BackendClient } from '@/backendClient'
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
        : 'The thumbnail was not set. The stream is not affected.',
    retryable: result.retryable === true
  }
}

/**
 * One warning per broadcast (the toast id dedupes repeats), with Retry while
 * a retry can help. A retry uses the draft's current thumbnail.
 */
export function showYouTubeThumbnailFailure(
  client: BackendClient,
  failure: YouTubeThumbnailResult
): void {
  const id = `youtube-thumbnail-${failure.broadcastId}`
  toast.warning('Thumbnail not set on YouTube', {
    id,
    description: failure.message,
    action: failure.retryable
      ? {
          label: 'Retry',
          onClick: () => {
            void client
              .request<YouTubeThumbnailResult>('streamTargets.youtube.thumbnail.retry', {
                accountId: failure.accountId,
                broadcastId: failure.broadcastId,
                targetId: failure.targetId
              })
              .then((result) => {
                const again = youtubeThumbnailFailure(result)
                if (again) showYouTubeThumbnailFailure(client, again)
                else toast.success('Thumbnail set on YouTube', { id })
              })
              .catch((error: unknown) => {
                toast.warning('Thumbnail not set on YouTube', {
                  id,
                  description: error instanceof Error ? error.message : String(error)
                })
              })
          }
        }
      : undefined
  })
}
