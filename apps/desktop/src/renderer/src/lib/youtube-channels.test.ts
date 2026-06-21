import { describe, expect, it } from 'vitest'

import { isYouTubeChannelAuthFailure, shouldAutoRefreshYouTubeChannels } from './youtube-channels'
import type { PlatformAccount, PlatformAccountValidation } from './backend'

describe('youtube channel refresh policy', () => {
  it('waits for a successful account validation before auto-refreshing channels', () => {
    const account = youtubeAccount({ status: 'connected' })

    expect(shouldAutoRefreshYouTubeChannels(account, [])).toBe(false)
    expect(
      shouldAutoRefreshYouTubeChannels(account, [
        youtubeValidation({ state: 'needs-reconnect', message: 'Invalid credentials.' })
      ])
    ).toBe(false)
    expect(
      shouldAutoRefreshYouTubeChannels(account, [
        youtubeValidation({ state: 'valid', message: 'Account access is valid.' })
      ])
    ).toBe(true)
  })

  it('does not auto-refresh channels for reconnecting accounts', () => {
    expect(
      shouldAutoRefreshYouTubeChannels(youtubeAccount({ status: 'needs-reconnect' }), [
        youtubeValidation({ state: 'valid', message: 'Account access is valid.' })
      ])
    ).toBe(false)
  })

  it('recognizes YouTube channel-list 401 failures as auth failures', () => {
    expect(
      isYouTubeChannelAuthFailure(
        new Error(
          'YouTube channel list request failed (401 Unauthorized): authError: Invalid Credentials'
        )
      )
    ).toBe(true)
    expect(isYouTubeChannelAuthFailure(new Error('YouTube stream status request failed'))).toBe(
      false
    )
  })
})

function youtubeAccount(patch: Partial<PlatformAccount> = {}): PlatformAccount {
  return {
    id: 'youtube',
    platform: 'youtube',
    accountId: 'UC123',
    accountLabel: 'Main Channel',
    scopes: ['youtube.readonly'],
    accessTokenPresent: true,
    refreshTokenPresent: true,
    streamKeyPresent: false,
    connectedAt: '2026-06-21T12:00:00Z',
    updatedAt: '2026-06-21T12:00:00Z',
    status: 'connected',
    ...patch
  }
}

function youtubeValidation(
  patch: Partial<PlatformAccountValidation> = {}
): PlatformAccountValidation {
  return {
    platform: 'youtube',
    state: 'valid',
    accountId: 'UC123',
    accountLabel: 'Main Channel',
    scopes: ['youtube.readonly'],
    message: 'Account access is valid.',
    ...patch
  }
}
