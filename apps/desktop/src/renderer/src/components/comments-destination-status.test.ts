import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CommentsDestinationStatus,
  commentsDestinationNotes,
  providerBadgeTitle
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
  // Plan 057, D3: the "To:" picker names where a message goes, so the notes
  // line speaks only for the destinations that will not get it.
  it('says nothing when every destination can send', () => {
    expect(
      commentsDestinationNotes({
        providers: [provider('youtube'), provider('twitch')],
        sendTargets: ['youtube', 'twitch']
      })
    ).toBe('')
  })

  it('names only the destinations a shared send skips', () => {
    expect(
      commentsDestinationNotes({
        providers,
        sendTargets: ['youtube', 'twitch']
      })
    ).toBe('X receive-only')
  })

  it('distinguishes a missing write scope from a receive-only provider', () => {
    expect(
      commentsDestinationNotes({
        providers: [
          provider('twitch', { write: 'missing-scope' }),
          provider('x', { write: 'read-only' })
        ],
        sendTargets: []
      })
    ).toBe('No writable destinations · Twitch reconnect to send · X receive-only')
  })

  it('names the bound account so a wrong-channel manual stream is visible', () => {
    expect(providerBadgeTitle(provider('twitch', { message: '', accountLabel: 'OrcDev' }))).toBe(
      'Reading chat as OrcDev.'
    )
    expect(
      providerBadgeTitle(
        provider('twitch', { message: 'twitch connected', accountLabel: 'OrcDev' })
      )
    ).toBe('twitch connected · Reading chat as OrcDev.')
    expect(providerBadgeTitle(provider('twitch', { message: 'twitch connected' }))).toBe(
      'twitch connected'
    )
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

    expect(providerMarkup).toContain('aria-label="Chat destination status"')
    expect(providerMarkup).toContain('YouTube')
    expect(providerMarkup).toContain('Connected')
    expect(providerMarkup).toContain('Receive-only')
    expect(composerMarkup).toContain('X receive-only')
    expect(composerMarkup).not.toContain('Sends to')
    // A failed send speaks once, with its reason.
    expect(composerMarkup).toContain('Twitch: Token expired')
    expect(composerMarkup).not.toContain('Twitch failed')

    const quiet = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, {
        providers: [provider('youtube'), provider('twitch')],
        mode: 'composer',
        sendTargets: ['youtube', 'twitch']
      })
    )
    expect(quiet).toBe('')
  })
})

describe('co-host status chip', () => {
  const cohost = {
    sessionId: 'session-1',
    status: 'listening' as const,
    reason: null,
    questions: [],
    flags: [],
    mood: null,
    lastTickAt: null,
    tickSeq: 3,
    partial: false
  }

  it('sits in the destination strip and only goes live-green while listening', () => {
    const listening = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, { cohostState: cohost, providers })
    )
    expect(listening).toContain('data-slot="cohost-status-chip"')
    expect(listening).toContain('Orcle: listening')
    expect(listening).toContain('data-variant="success"')

    const paused = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, {
        cohostState: { ...cohost, status: 'paused' as const, reason: 'quota-exhausted' as const },
        providers: []
      })
    )
    expect(paused).toContain('Orcle: paused · quota')
    expect(paused).not.toContain('data-variant="success"')
  })

  it('stays out of the strip entirely when there is no co-host state', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, { providers, cohostState: null })
    )
    expect(markup).not.toContain('data-slot="cohost-status-chip"')
  })

  it('still renders the chip for a session with no chat providers at all', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, { cohostState: cohost, providers: [] })
    )
    expect(markup).toContain('data-slot="cohost-status-chip"')
  })
})
