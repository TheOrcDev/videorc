import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CommentRow } from '@/components/comment-row'
import { PlatformGlyph } from '@/components/platform-glyph'
import type { LiveChatAuthorVerified, LiveChatMessage } from '@/lib/backend'
import { X_LOCKUP_URL, X_VERIFIED_LABEL, X_VERIFIED_URL } from '@/lib/x-mark'

// Plan 167: X's partner icon kit. The X mark is X's own path in one solid
// colour, the destination tile is X's lockup, and a verified author gets X's
// own check, only for the `verified_type` X sent.

function xMessage(authorVerified?: LiveChatAuthorVerified): LiveChatMessage {
  return {
    id: 'x:1',
    providerMessageId: '1',
    platform: 'x',
    sessionId: 's',
    authorId: 'a',
    authorName: 'Dom',
    authorBadges: [],
    authorRoles: [],
    ...(authorVerified ? { authorVerified } : {}),
    publishedAt: '2026-10-08T10:00:00Z',
    receivedAt: '2026-10-08T10:00:00Z',
    messageText: 'hello',
    fragments: [],
    eventType: 'message',
    isDeleted: false
  }
}

function row(message: LiveChatMessage): string {
  return renderToStaticMarkup(
    createElement(CommentRow, {
      highlight: { phase: 'idle' },
      message,
      onHighlight: () => undefined
    })
  )
}

/** Attribute values come back HTML-escaped from the server renderer. */
function escaped(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll("'", '&#x27;').replaceAll('"', '&quot;')
}

describe('X mark surfaces', () => {
  it('chat icons are the kit mark in pure black or white, never a tint', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatPlatformIcon, { platform: 'x', className: 'text-muted-foreground' })
    )
    expect(markup).toContain('data-platform="x"')
    expect(markup).toContain('class="fill-black dark:fill-white"')
    expect(markup).not.toContain('text-foreground')
    expect(markup).toContain('aria-label="X"')
  })

  it('destination tiles are X’s lockup for each theme, in the shared 30 px slot', () => {
    const markup = renderToStaticMarkup(createElement(PlatformGlyph, { platform: 'x' }))
    expect(markup).toContain('w-7.5')
    expect(markup).toContain(`src="${escaped(X_LOCKUP_URL.light)}"`)
    expect(markup).toContain(`src="${escaped(X_LOCKUP_URL.dark)}"`)
    expect(markup).toMatch(/class="size-6 dark:hidden"/)
    expect(markup).toMatch(/class="hidden size-6 dark:block"/)
    expect(markup).not.toContain('bg-foreground/10')
    expect(markup).toContain('aria-label="X"')
  })

  it('a verified X author gets X’s own check right after the name', () => {
    for (const verified of ['blue', 'business', 'government'] as const) {
      const markup = row(xMessage(verified))
      const check = /<img[^>]*data-slot="comment-verified"[^>]*>/.exec(markup)?.[0] ?? ''
      expect(check, verified).toContain(`src="${escaped(X_VERIFIED_URL[verified])}"`)
      expect(check).toContain(`alt="${X_VERIFIED_LABEL[verified]}"`)
      expect(check).toContain(`title="${X_VERIFIED_LABEL[verified]}"`)
      expect(check).toContain('size-4')
      expect(markup.indexOf('data-slot="comment-verified"')).toBeGreaterThan(
        markup.indexOf('>Dom<')
      )
    }
  })

  it('an unverified author shows no check', () => {
    expect(row(xMessage())).not.toContain('comment-verified')
  })
})
