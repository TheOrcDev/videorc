import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CommentsDestinationStatus,
  commentsDestinationSummary
} from '@/components/comments-destination-status'
import type { LiveChatProviderState, StreamPlatform } from '@/lib/backend'

function provider(
  platform: StreamPlatform,
  overrides: Partial<LiveChatProviderState> = {}
): LiveChatProviderState {
  return {
    id: `${platform}-target`,
    platform,
    targetId: `${platform}-target`,
    state: 'connected',
    read: 'ready',
    write: 'ready',
    message: `${platform} connected`,
    ...overrides
  }
}

const providers = [provider('youtube'), provider('twitch'), provider('x', { write: 'read-only' })]

describe('comments destination status', () => {
  it('states exactly which destinations receive a shared send', () => {
    expect(
      commentsDestinationSummary({
        providers,
        sendTargets: ['youtube', 'twitch']
      })
    ).toBe('Sends to YouTube + Twitch · X receive-only')
  })

  it('surfaces per-destination failures without hiding receive-only destinations', () => {
    expect(
      commentsDestinationSummary({
        providers,
        sendTargets: ['youtube', 'twitch'],
        failures: [{ destinationId: 'twitch-target', platform: 'twitch', reason: 'Token expired' }]
      })
    ).toBe('Sends to YouTube + Twitch · Twitch failed · X receive-only')
  })

  it('distinguishes a missing write scope from a receive-only provider', () => {
    expect(
      commentsDestinationSummary({
        providers: [
          provider('twitch', { write: 'missing-scope' }),
          provider('x', { write: 'read-only' })
        ],
        sendTargets: []
      })
    ).toBe('No writable destinations · Twitch reconnect to send · X receive-only')
  })

  it('renders provider and failure status with the shared badge contract', () => {
    const providerMarkup = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, { providers })
    )
    const composerMarkup = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, {
        providers,
        mode: 'composer',
        sendTargets: ['youtube', 'twitch'],
        failures: [{ destinationId: 'twitch-target', platform: 'twitch', reason: 'Token expired' }]
      })
    )

    expect(providerMarkup).toContain('aria-label="Comments destination status"')
    expect(providerMarkup).toContain('YouTube')
    expect(providerMarkup).toContain('Connected')
    expect(providerMarkup).toContain('Receive-only')
    expect(composerMarkup).toContain('Sends to YouTube + Twitch · Twitch failed · X receive-only')
    expect(composerMarkup).toContain('Twitch: Token expired')
  })
})
