import { describe, expect, it } from 'vitest'

import type { YouTubeThumbnailResult } from '@/lib/backend'

import { youtubeThumbnailFailure } from './youtube-thumbnail-toast'

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
    expect(parsed?.message).toBe("The thumbnail wasn't set. The stream isn't affected.")
    expect(parsed?.retryable).toBe(false)
  })
})
