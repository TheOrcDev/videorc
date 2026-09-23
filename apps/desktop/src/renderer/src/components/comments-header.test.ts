import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ChatHeaderActions,
  ViewerCountChip,
  type ChatHeaderActionsProps
} from '@/components/comments-header'
import {
  CHAT_HEADER_COMPACT_ONLY,
  CHAT_HEADER_FULL_ONLY,
  CHAT_HEADER_TIGHT_SR_ONLY
} from '@/lib/chat-header-tiers'
import type { ViewerSample } from '@/lib/backend'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')

function sample(overrides: Partial<ViewerSample> = {}): ViewerSample {
  return {
    sessionId: 's',
    platforms: [
      { platform: 'youtube', count: 900 },
      { platform: 'twitch', count: 334 }
    ],
    total: 1234,
    at: '2026-09-23T11:59:50.000Z',
    ...overrides
  }
}

function renderActions(props: Partial<ChatHeaderActionsProps> = {}): string {
  return renderToStaticMarkup(createElement(ChatHeaderActions, props))
}

const noop = (): void => undefined

// The narrow Chat window (320px minimum) keeps every control reachable and the
// viewer count on screen: tiers are container-query classes, asserted here;
// probe:comments-window proves the real geometry.
describe('ViewerCountChip', () => {
  it('keeps the number and the full accessible label, never wrapping', () => {
    const markup = renderToStaticMarkup(
      createElement(ViewerCountChip, { sample: sample(), nowMs: NOW })
    )
    expect(markup).toContain('data-slot="viewer-count"')
    expect(markup).toContain('<span data-slot="viewer-count-number">1.2k</span>')
    expect(markup).toContain('whitespace-nowrap')
    expect(markup).toContain('shrink-0')
    // "watching" leaves the eye in the Tight tier but stays for screen readers.
    expect(markup).toContain(`<span class="${CHAT_HEADER_TIGHT_SR_ONLY}"> watching</span>`)
    expect(markup).toContain('title="youtube: 900 · twitch: 334"')
  })

  it('greys out a stale sample instead of hiding it', () => {
    const markup = renderToStaticMarkup(
      createElement(ViewerCountChip, {
        sample: sample({ at: '2026-09-23T11:50:00.000Z' }),
        nowMs: NOW
      })
    )
    expect(markup).toContain('text-subtle')
    expect(markup).toContain('1.2k')
  })
})

describe('ChatHeaderActions', () => {
  const live: Partial<ChatHeaderActionsProps> = {
    highlightAnchor: 'top-left',
    onHighlightAnchorChange: noop,
    onToggleAlwaysOnTop: noop,
    onClear: noop
  }

  it('renders the inline controls for Full and the ⋯ trigger for narrower tiers', () => {
    const markup = renderActions(live)
    expect(markup).toContain('data-slot="chat-header-inline-actions"')
    expect(markup).toContain(CHAT_HEADER_FULL_ONLY)
    expect(markup).toContain('aria-label="More chat actions"')
    expect(markup).toContain(CHAT_HEADER_COMPACT_ONLY)
    expect(markup).toContain('Clear view')
    expect(markup).toContain('aria-label="Highlight position"')
    expect(markup).toContain('aria-label="Keep this window on top"')
  })

  it('keeps Back to live outside the fold in history', () => {
    const markup = renderActions({
      highlightAnchor: 'top-left',
      onHighlightAnchorChange: noop,
      onToggleAlwaysOnTop: noop,
      onBackToLive: noop
    })
    const backToLive = markup.indexOf('Back to live')
    const inline = markup.indexOf('data-slot="chat-header-inline-actions"')
    expect(backToLive).toBeGreaterThan(-1)
    expect(backToLive).toBeLessThan(inline)
    expect(markup).not.toContain('Clear view')
  })

  it('renders no ⋯ trigger when there is nothing to fold', () => {
    const markup = renderActions({ onBackToLive: noop })
    expect(markup).toContain('Back to live')
    expect(markup).not.toContain('More chat actions')
    expect(markup).not.toContain('chat-header-inline-actions')
  })

  it('keeps the controls clickable inside the draggable header', () => {
    expect(renderActions(live)).toContain('[-webkit-app-region:no-drag]')
  })
})
