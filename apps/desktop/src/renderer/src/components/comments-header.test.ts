import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StatsStrip } from '@/components/stream-manager/stats-strip'
import {
  providerCapabilityLabel,
  providerCapabilityTitle,
  StreamManagerStatusBar
} from '@/components/stream-manager/stream-manager-status-bar'
import type { LiveChatProviderState } from '@/lib/backend'
import type { StatTileModel } from '@/lib/stream-manager-stats'
import { ABOVE_NARROW, NARROW_ONLY } from '@/lib/stream-manager-layout'

const noop = (): void => undefined

function provider(overrides: Partial<LiveChatProviderState> = {}): LiveChatProviderState {
  return {
    id: 'twitch',
    platform: 'twitch',
    read: 'ready',
    write: 'ready',
    state: 'connected',
    message: 'Twitch live chat connected.',
    ...overrides
  }
}

// The Stream Manager's chrome (plan 053, D6): the title row carries the title
// only; every control lives in the status bar, inline from 640 px and folded
// into ⋯ below it. probe:comments-window proves the real geometry.
describe('Stream Manager status bar', () => {
  it('names each provider by what chat can do there', () => {
    expect(providerCapabilityLabel(provider())).toBe('read · send')
    expect(providerCapabilityLabel(provider({ platform: 'x', write: 'read-only' }))).toBe(
      'read-only'
    )
    expect(providerCapabilityLabel(provider({ write: 'missing-scope' }))).toBe(
      'read · reconnect to send'
    )
    expect(providerCapabilityLabel(provider({ state: 'failed' }))).toBe('failed')
  })

  it('offers the Twitch reconnect when follow alerts need the opt-in scopes', () => {
    const title = providerCapabilityTitle(provider(), {
      sessionId: 's',
      updatedAt: 'now',
      platforms: [
        { platform: 'twitch', metric: 'followers', capability: 'available', audienceScopes: false }
      ]
    })
    expect(title).toContain('Reconnect Twitch in Livestream → Setup')
  })

  it('keeps every control reachable: inline from 640 px, ⋯ below it', () => {
    const markup = renderToStaticMarkup(
      createElement(StreamManagerStatusBar, {
        providers: [provider()],
        audience: null,
        alwaysOnTop: true,
        highlightAnchor: 'bottom-left',
        onHighlightAnchorChange: noop,
        onToggleAlwaysOnTop: noop,
        onClear: noop,
        onOpenPreview: noop
      })
    )
    expect(markup).toContain('data-slot="stream-manager-actions"')
    expect(markup).toContain(ABOVE_NARROW)
    expect(markup).toContain('aria-label="Keep this window on top"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('title="Highlight position: Bottom left"')
    expect(markup).toContain('Clear view')
    expect(markup).toContain('Open Preview')
    expect(markup).toContain('aria-label="More Stream Manager actions"')
    expect(markup).toContain(NARROW_ONLY)
    expect(markup).toContain('[-webkit-app-region:no-drag]')
  })
})

describe('StatsStrip', () => {
  const tiles: StatTileModel[] = [
    { id: 'session', label: 'Session', value: '12:04', tone: 'neutral', badge: 'live' },
    {
      id: 'viewers',
      label: 'Viewers',
      value: '1.2k',
      detail: 'Peak 1.4k',
      tone: 'neutral',
      spark: [1, 2]
    },
    {
      id: 'followers',
      label: 'Followers',
      value: '61,942',
      detail: '+12 this stream',
      tone: 'neutral'
    }
  ]

  it('renders tiles for wide tiers and one summary line for narrow ones', () => {
    const markup = renderToStaticMarkup(createElement(StatsStrip, { tiles }))
    expect(markup).toContain('data-slot="stats-strip"')
    expect(markup).toContain('data-tile="viewers"')
    expect(markup).toContain('On air')
    expect(markup).toContain('data-slot="stats-summary"')
    expect(markup).toContain('data-summary="viewers"')
    // The viewer count is in the narrow summary too: never hidden while live.
    expect(markup.match(/1\.2k/g)?.length).toBe(2)
    expect(markup).toContain('watching')
  })
})
