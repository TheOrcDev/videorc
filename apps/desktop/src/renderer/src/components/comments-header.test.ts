import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StatsBar } from '@/components/stream-manager/stats-bar'
import {
  providerCapabilityLabel,
  providerCapabilityTitle,
  StreamManagerStatusBar
} from '@/components/stream-manager/stream-manager-status-bar'
import type { LiveChatProviderState } from '@/lib/backend'
import type { StatItemModel } from '@/lib/stream-manager-stats'
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

// The Stream Manager's chrome (plan 055, D6): the title row carries the title
// only; every control lives in the status bar, inline from 640 px and folded
// into ⋯ below it. probe:comments-window proves the real geometry.
describe('Stream Manager status bar', () => {
  // Plan 057, D3: quiet when fine. A platform that reads and sends is its
  // icon and dot; words appear only for what chat cannot do.
  it('names a provider only by what chat cannot do there', () => {
    expect(providerCapabilityLabel(provider())).toBe('')
    expect(providerCapabilityLabel(provider({ platform: 'x', write: 'read-only' }))).toBe(
      'read-only'
    )
    expect(providerCapabilityLabel(provider({ write: 'missing-scope' }))).toBe('reconnect to send')
    expect(providerCapabilityLabel(provider({ state: 'failed' }))).toBe('failed')
    expect(providerCapabilityLabel(provider({ state: 'reconnecting' }))).toBe('reconnecting')
    // The words still live in the hover text.
    expect(providerCapabilityTitle(provider(), null).split('\n')[0]).toBe(
      'Twitch chat: reads and sends'
    )
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
    expect(markup).toContain('aria-label="Clear view"')
    expect(markup).toContain('>Clear<')
    expect(markup).toContain('aria-label="Open Preview"')
    // Icons with their names on hover: no visible "Keep on top" words inline.
    expect(markup).not.toContain('>Keep on top</span>')
    // A healthy provider draws no words.
    expect(markup).not.toContain('read · send')
    expect(markup).toContain('aria-label="More Stream Manager actions"')
    expect(markup).toContain(NARROW_ONLY)
    expect(markup).toContain('[-webkit-app-region:no-drag]')
  })
})

describe('StatsBar (plan 057)', () => {
  const items: StatItemModel[] = [
    {
      id: 'session',
      label: 'Session',
      value: '12:04',
      tone: 'neutral',
      badge: 'live',
      details: [],
      description: 'On air for 12:04'
    },
    {
      id: 'viewers',
      label: 'Viewers',
      value: '1.2k',
      tone: 'neutral',
      spark: [1, 2],
      details: [{ label: 'Peak', value: '1.4k' }],
      description: '1.2k viewers, peak 1.4k'
    },
    {
      id: 'health',
      label: 'Stream health',
      value: 'X failed',
      tone: 'error',
      details: [],
      description: 'Stream health: X failed'
    },
    {
      id: 'followers',
      label: 'Followers',
      value: '61,942',
      unit: 'followers',
      delta: '+12',
      tone: 'neutral',
      details: [],
      description: '61,942 followers, +12 this stream'
    }
  ]

  it('draws one bar: the main three first, the rest after a hairline', () => {
    const markup = renderToStaticMarkup(createElement(StatsBar, { items }))
    expect(markup).toContain('data-slot="stats-bar"')
    expect(markup).not.toContain('stats-summary')
    expect(markup).toContain('>ON AIR<')
    const order = [...markup.matchAll(/data-stat="([a-z]+)"/g)].map((match) => match[1])
    expect(order).toEqual(['session', 'viewers', 'health', 'followers'])
    expect(markup.match(/data-group="main"/g)).toHaveLength(3)
    expect(markup).toContain('data-group="more"')
    // The viewer count is drawn once, at every width: never hidden while live.
    expect(markup.match(/>1\.2k</g)?.length).toBe(1)
    // Health speaks only when something is wrong, and in the error tone.
    expect(markup).toContain('X failed')
    expect(markup).toContain('data-tone="error"')
    expect(markup).toContain('aria-label="Stream health: X failed"')
    expect(markup).toContain('+12')
  })
})
