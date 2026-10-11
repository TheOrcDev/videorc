import { describe, expect, it } from 'vitest'

import type { YouTubeBroadcastTransitionResult } from './backend'
import { assertYouTubeTransitionConfirmed } from './youtube-transition'

describe('YouTube transition confirmation', () => {
  it('accepts a matching YouTube lifecycle status', () => {
    expect(() => assertYouTubeTransitionConfirmed(transitionResult('live'), 'live')).not.toThrow()
  })

  it('rejects a non-live lifecycle before the UI can show on air', () => {
    expect(() => assertYouTubeTransitionConfirmed(transitionResult('testing'), 'live')).toThrow(
      /didn't confirm live.*testing/
    )
  })

  it('rejects a missing lifecycle before the UI can show on air', () => {
    expect(() => assertYouTubeTransitionConfirmed(transitionResult(undefined), 'live')).toThrow(
      /current broadcast status is unknown/
    )
  })
})

function transitionResult(lifecycleStatus: string | undefined): YouTubeBroadcastTransitionResult {
  return {
    platform: 'youtube',
    accountId: 'UC123',
    broadcastId: 'broadcast-123',
    requestedStatus: 'live',
    lifecycleStatus,
    message: 'transition result'
  }
}
