import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CommentRow } from '@/components/comment-row'
import { CommentsDestinationStatus } from '@/components/comments-destination-status'
import { PlatformGlyph } from '@/components/platform-glyph'
import { ActivityPane } from '@/components/stream-manager/activity-pane'
import type { LiveChatMessage, LiveChatProviderState } from '@/lib/backend'
import type { ActivityItem } from '@/lib/stream-activity'

// Plan 165 (Google's YouTube API ToS report, III.F.2a): every surface that
// shows YouTube shows YouTube's own icon, at least 20 px tall, untinted, never
// laid over a photo; a surface with no room for it says "YouTube" in words.

/** Every YouTube mark in the markup, with its rendered height. */
function youtubeMarks(markup: string): { height: number; tag: string }[] {
  return [...markup.matchAll(/<svg[^>]*data-platform="youtube"[^>]*>/g)].map(([tag]) => ({
    tag,
    height: Number(/height:(\d+(?:\.\d+)?)px/.exec(tag)?.[1] ?? 0)
  }))
}

const provider = (platform: 'youtube' | 'twitch'): LiveChatProviderState => ({
  id: `${platform}-target`,
  platform,
  targetId: `${platform}-target`,
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: ''
})

describe('YouTube mark surfaces', () => {
  it('destination rows show the official icon at 20 px on no tinted tile', () => {
    const markup = renderToStaticMarkup(createElement(PlatformGlyph, { platform: 'youtube' }))
    const marks = youtubeMarks(markup)
    expect(marks).toHaveLength(1)
    expect(marks[0].height).toBeGreaterThanOrEqual(20)
    expect(markup).not.toContain('bg-platform-youtube')
    expect(markup).not.toContain('text-platform-youtube')
    // Other platforms keep their tile, in the same 30 px slot so titles align.
    const twitch = renderToStaticMarkup(createElement(PlatformGlyph, { platform: 'twitch' }))
    expect(twitch).toContain('bg-platform-twitch/15')
    expect(twitch).toContain('size-6')
    expect(twitch).toContain('w-7.5')
    expect(markup).toContain('w-7.5')
  })

  it('chat icons cannot be shrunk or tinted for YouTube', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatPlatformIcon, { platform: 'youtube', className: 'size-3' })
    )
    const [mark] = youtubeMarks(markup)
    expect(mark.height).toBe(20)
    expect(markup).not.toContain('text-platform-youtube')
    expect(markup).toContain('aria-label="YouTube"')
  })

  it('a YouTube chat row leads its name with the 20 px icon', () => {
    const message: LiveChatMessage = {
      id: 'youtube:1',
      providerMessageId: '1',
      platform: 'youtube',
      sessionId: 's',
      authorId: 'a',
      authorName: 'AIDragonMusic',
      authorBadges: [],
      authorRoles: [],
      publishedAt: '2026-10-08T10:00:00Z',
      receivedAt: '2026-10-08T10:00:00Z',
      messageText: 'hello',
      fragments: [],
      eventType: 'message',
      isDeleted: false
    }
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        highlight: { phase: 'idle' },
        message,
        onHighlight: () => undefined
      })
    )
    const marks = youtubeMarks(markup)
    expect(marks).toHaveLength(1)
    expect(marks[0].height).toBeGreaterThanOrEqual(20)
    expect(markup.indexOf('data-platform="youtube"')).toBeLessThan(
      markup.indexOf('>AIDragonMusic<')
    )
  })

  it('activity rows put the YouTube icon on the name line, never over the avatar', () => {
    const items: ActivityItem[] = [
      {
        id: 'yt',
        kind: 'super-chat',
        filter: 'tips',
        platform: 'youtube',
        name: 'Maria',
        line: 'Super Chat $5.00',
        short: '$5.00',
        at: '2026-10-08T10:00:00Z',
        authorAvatarUrl: 'https://yt3.ggpht.com/maria.png'
      },
      {
        id: 'tw',
        kind: 'follow',
        filter: 'follows',
        platform: 'twitch',
        name: 'Sam',
        line: 'Followed',
        short: 'Follow',
        at: '2026-10-08T10:00:01Z'
      }
    ]
    const markup = renderToStaticMarkup(
      createElement(ActivityPane, {
        items,
        providers: [provider('youtube'), provider('twitch')],
        nowMs: Date.parse('2026-10-08T10:01:00Z')
      })
    )
    const row = (id: string): string => {
      const start = markup.indexOf(`data-activity-id="${id}"`)
      return markup.slice(start, markup.indexOf('</li>', start))
    }
    const youtube = row('yt')
    const marks = youtubeMarks(youtube)
    expect(marks).toHaveLength(1)
    expect(marks[0].height).toBeGreaterThanOrEqual(20)
    expect(marks[0].tag).not.toContain('absolute')
    expect(youtube).not.toContain('size-3 ')
    // Every platform's mark is on the name line at 20 px; none is shrunk
    // onto the avatar.
    expect(markup).not.toContain('absolute -right-1 -bottom-1')
    expect(row('tw')).toContain('size-5')
    // The platform filter toggle uses the full-size mark too.
    const filters = markup.slice(0, markup.indexOf('data-activity-id'))
    for (const mark of youtubeMarks(filters)) expect(mark.height).toBeGreaterThanOrEqual(20)
  })

  it('status chips name YouTube in words where a Badge would shrink the mark', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentsDestinationStatus, { providers: [provider('youtube')] })
    )
    expect(youtubeMarks(markup)).toHaveLength(0)
    expect(markup).toContain('YouTube')
  })
})
