import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommentRow, commentLinkText, commentRowMenu } from '@/components/comment-row'
import type { LiveChatMessage } from '@/lib/backend'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }))

function message(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: 'twitch:m1',
    providerMessageId: 'm1',
    platform: 'twitch',
    sessionId: 's1',
    authorId: 'a1',
    authorName: 'linker',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-05T10:00:00.000Z',
    receivedAt: '2026-10-05T10:00:01.000Z',
    messageText: 'grab it at https://videorc.com/download today',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

function html(row: LiveChatMessage): string {
  return renderToStaticMarkup(
    createElement(CommentRow, { message: row, onHighlight: () => undefined })
  )
}

function menuLabels(row: LiveChatMessage): string[] {
  return commentRowMenu({
    message: row,
    highlightable: true,
    highlightPhase: 'idle',
    onHighlight: () => undefined,
    onReply: () => undefined
  }).map((item) => item.label)
}

describe('CommentRow: links (plan 151)', () => {
  it('marks a link in a viewer message, keeping the text around it', () => {
    const markup = html(message())
    expect(markup).toMatch(
      /grab it at <span[^>]*data-slot="comment-link"[^>]*>https:\/\/videorc.com\/download<\/span> today/
    )
    expect(markup).toContain('title="https://videorc.com/download"')
    // Underlined, never a coloured link (design skill, rule 4).
    expect(markup).toContain('underline')
    expect(markup).not.toContain('<a ')
  })

  it('finds links between emotes', () => {
    const markup = html(
      message({
        messageText: 'Kappa videorc.com',
        fragments: [
          { type: 'emote', text: 'Kappa', imageUrl: 'https://static-cdn.jtvnw.net/e/1' },
          { type: 'text', text: ' videorc.com' }
        ]
      })
    )
    expect(markup).toMatch(/data-slot="comment-link"[^>]*>videorc.com</)
  })

  it("never links Twitch's sentences, moderation or removed messages", () => {
    for (const row of [
      message({ eventType: 'system', messageText: 'Visit videorc.com for the raid' }),
      message({ eventType: 'moderation', messageText: 'removed https://videorc.com' }),
      message({ isDeleted: true }),
      message({ eventType: 'deleted', messageText: 'https://videorc.com' })
    ]) {
      expect(html(row)).not.toContain('comment-link')
      expect(commentLinkText(row)).toBeUndefined()
    }
  })

  it("links the viewer's words on a notice, not Twitch's sentence", () => {
    const streak = message({
      eventType: 'system',
      rawProviderType: 'channel.chat.notification:watch_streak',
      messageText: 'linker watched 20 consecutive streams and sparked a watch streak! videorc.com',
      fragments: [{ type: 'text', text: 'clip: https://clips.twitch.tv/abc' }],
      details: { kind: 'watch-streak', streakCount: 20 }
    })
    const markup = html(streak)
    expect(markup.match(/data-slot="comment-link"/g)).toHaveLength(1)
    expect(markup).toContain('>https://clips.twitch.tv/abc</span>')
    expect(commentLinkText(streak)).toBe('clip: https://clips.twitch.tv/abc')
  })

  it('offers each link in the ⋯ menu, after Reply and before Copy', () => {
    expect(menuLabels(message())).toEqual([
      'Show on stream',
      'Reply',
      'Open link',
      'Copy link',
      'Copy'
    ])
    expect(menuLabels(message({ messageText: 'no links' }))).toEqual([
      'Show on stream',
      'Reply',
      'Copy'
    ])
    expect(
      menuLabels(message({ messageText: 'https://videorc.com and www.twitch.tv/orcdev' }))
    ).toEqual([
      'Show on stream',
      'Reply',
      'Open videorc.com',
      'Copy videorc.com link',
      'Open twitch.tv',
      'Copy twitch.tv link',
      'Copy'
    ])
    const four = menuLabels(message({ messageText: 'a.com b.com c.com d.com' }))
    expect(four.filter((label) => label.startsWith('Open '))).toEqual([
      'Open a.com',
      'Open b.com',
      'Open c.com'
    ])
  })
})

describe('Open link and Copy link (plan 151, D10)', () => {
  const openChatLink = vi.fn()
  const writeText = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('window', { videorc: { openChatLink } })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    openChatLink.mockReset()
    writeText.mockReset()
    toastError.mockReset()
  })

  function item(label: string, text = 'see www.twitch.tv/orcdev') {
    const found = commentRowMenu({
      message: message({ messageText: text }),
      highlightable: false,
      highlightPhase: 'idle',
      onReply: () => undefined
    }).find((entry) => entry.label === label)
    if (!found) throw new Error(`no ${label}`)
    return found
  }

  it('opens the link through main, over https', async () => {
    openChatLink.mockResolvedValue(true)
    item('Open link').onSelect()
    await vi.waitFor(() =>
      expect(openChatLink).toHaveBeenCalledWith('https://www.twitch.tv/orcdev')
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says so when main refuses or fails', async () => {
    openChatLink.mockResolvedValue(false)
    item('Open link').onSelect()
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't open that link."))
    toastError.mockReset()
    openChatLink.mockRejectedValue(new Error('denied'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    item('Open link').onSelect()
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })

  it('copies the full link', () => {
    item('Copy link').onSelect()
    expect(writeText).toHaveBeenCalledWith('https://www.twitch.tv/orcdev')
  })
})
