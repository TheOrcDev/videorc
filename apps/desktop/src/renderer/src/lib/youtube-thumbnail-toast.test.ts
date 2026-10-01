import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { YouTubeThumbnailResult } from '@/lib/backend'

const toast = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { showYouTubeThumbnailFailure, youtubeThumbnailFailure } from './youtube-thumbnail-toast'

const failure: YouTubeThumbnailResult = {
  platform: 'youtube',
  accountId: 'acct',
  broadcastId: 'b1',
  targetId: 'youtube',
  state: 'error',
  code: 'forbidden',
  message: 'YouTube refused the thumbnail.',
  retryable: true
}

describe('youtubeThumbnailFailure', () => {
  it('returns only well-formed failures', () => {
    expect(youtubeThumbnailFailure(failure)).toEqual(failure)
    expect(youtubeThumbnailFailure({ ...failure, state: 'uploaded' })).toBeNull()
    expect(youtubeThumbnailFailure({ ...failure, broadcastId: '' })).toBeNull()
    expect(youtubeThumbnailFailure(null)).toBeNull()
    expect(youtubeThumbnailFailure('error')).toBeNull()
  })

  it('falls back to the generic copy and never treats a missing flag as retryable', () => {
    const parsed = youtubeThumbnailFailure({
      state: 'error',
      accountId: 'acct',
      broadcastId: 'b1'
    })
    expect(parsed?.message).toBe('The thumbnail was not set. The stream is not affected.')
    expect(parsed?.retryable).toBe(false)
  })
})

describe('showYouTubeThumbnailFailure', () => {
  beforeEach(() => {
    toast.warning.mockReset()
    toast.success.mockReset()
  })

  it('warns once per broadcast and retries with the same broadcast', async () => {
    const request = vi.fn(async () => ({ ...failure, state: 'uploaded' }))
    const client = { request } as unknown as BackendClient

    showYouTubeThumbnailFailure(client, failure)
    expect(toast.warning).toHaveBeenCalledWith(
      'Thumbnail not set on YouTube',
      expect.objectContaining({
        id: 'youtube-thumbnail-b1',
        description: 'YouTube refused the thumbnail.'
      })
    )
    const options = toast.warning.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(request).toHaveBeenCalledWith('streamTargets.youtube.thumbnail.retry', {
      accountId: 'acct',
      broadcastId: 'b1',
      targetId: 'youtube'
    })
    expect(toast.success).toHaveBeenCalledWith('Thumbnail set on YouTube', {
      id: 'youtube-thumbnail-b1'
    })
  })

  it('offers no Retry at the daily limit', () => {
    showYouTubeThumbnailFailure({ request: vi.fn() } as unknown as BackendClient, {
      ...failure,
      code: 'uploadRateLimitExceeded',
      retryable: false
    })
    expect(toast.warning.mock.calls[0][1]).toMatchObject({ action: undefined })
  })
})
