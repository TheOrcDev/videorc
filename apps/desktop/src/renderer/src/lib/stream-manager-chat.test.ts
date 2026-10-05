import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CommentRow, commentMentions } from '@/components/comment-row'
import type {
  LiveChatMessage,
  LiveChatProviderState,
  StreamPlatform,
  TwitchGifMode
} from '@/lib/backend'
import { ChatGifModeProvider } from '@/lib/chat-gifs'
import { chatDraftMaxChars } from '@/lib/chat-send'

import {
  chatPaneMessages,
  followChatOnResize,
  pickedSendProviders,
  spotlightScrollAllowed,
  SPOTLIGHT_SCROLL_QUIET_MS,
  type ChatPaneFilter
} from './stream-manager-chat'

function message(
  id: string,
  platform: StreamPlatform,
  text: string,
  overrides: Partial<LiveChatMessage> = {}
): LiveChatMessage {
  return {
    id,
    providerMessageId: id,
    platform,
    sessionId: 's',
    authorName: `${platform}-viewer`,
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-09-24T10:00:00Z',
    receivedAt: '2026-09-24T10:00:00Z',
    messageText: text,
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

const all: ChatPaneFilter = { platform: 'all', questions: false, mentions: false, search: '' }
const messages = [
  message('1', 'twitch', 'hello @OrcDev, love the setup'),
  message('2', 'youtube', 'which mic is that?'),
  message('3', 'x', 'first time here'),
  message('4', 'twitch', 'Cool_User followed', { eventType: 'follow', details: { kind: 'follow' } })
]
const context = { questionMessageIds: new Set(['2']), mentionNames: ['OrcDev'] }

describe('Stream Manager chat pane', () => {
  it('never lists follows, and filters by platform, question, mention and search', () => {
    const ids = (filter: ChatPaneFilter): string[] =>
      chatPaneMessages(messages, filter, context).map((row) => row.id)
    expect(ids(all)).toEqual(['1', '2', '3'])
    expect(ids({ ...all, platform: 'twitch' })).toEqual(['1'])
    expect(ids({ ...all, questions: true })).toEqual(['2'])
    expect(ids({ ...all, mentions: true })).toEqual(['1'])
    expect(ids({ ...all, search: 'MIC' })).toEqual(['2'])
    expect(ids({ ...all, search: 'x-viewer' })).toEqual(['3'])
  })

  it('matches mentions of the streamer by @handle only', () => {
    expect(commentMentions(messages[0], ['OrcDev'])).toBe(true)
    expect(commentMentions(message('5', 'twitch', 'orcdev is great'), ['OrcDev'])).toBe(false)
    expect(commentMentions(messages[0], [])).toBe(false)
  })

  it('caps a draft at the strictest destination it reaches', () => {
    const providers: LiveChatProviderState[] = (['youtube', 'twitch', 'x'] as const).map(
      (platform) => ({
        id: platform,
        platform,
        read: 'ready',
        write: 'ready',
        state: 'connected',
        message: ''
      })
    )
    const platformsOf = (picked: ReadonlySet<string> | null): StreamPlatform[] =>
      pickedSendProviders(providers, picked).map((provider) => provider.platform)
    expect(chatDraftMaxChars(platformsOf(null))).toBe(140)
    expect(chatDraftMaxChars(platformsOf(new Set(['youtube', 'twitch'])))).toBe(200)
    expect(platformsOf(new Set(['twitch']))).toEqual(['twitch'])
    // A pick that is no longer writable never widens to everything.
    const readOnlyX = providers.map((provider) =>
      provider.platform === 'x' ? { ...provider, write: 'read-only' as const } : provider
    )
    expect(pickedSendProviders(readOnlyX, new Set(['x']))).toEqual([])
  })

  it('marks a first chat, shows the replied-to message and a mention', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        density: 'comfortable',
        mentionNames: ['OrcDev'],
        message: message('6', 'twitch', '@OrcDev can anyone ask about the mic?', {
          firstMessage: true,
          authorRoles: ['vip'],
          reply: {
            parentMessageId: '2',
            parentAuthorName: 'ph4se_on3',
            parentText: 'which mic is that?'
          }
        })
      })
    )
    expect(markup).toContain('data-slot="comment-first-message"')
    expect(markup).toContain('First chat')
    // Plan 057, D3: the arrow says reply; the chip says mention in four
    // characters, with the words on hover.
    expect(markup).toContain('↳ @ph4se_on3: which mic is that?')
    expect(markup).not.toContain('Replying to')
    expect(markup).toContain('data-slot="comment-mention"')
    expect(markup).toContain('@you')
    expect(markup).toContain('title="Mentions you"')
    expect(markup).toContain('data-slot="comment-role"')
    expect(markup).toContain('VIP')
  })

  it('renders emotes from fragments', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message('7', 'twitch', 'hi Kappa', {
          fragments: [
            { type: 'text', text: 'hi ' },
            {
              type: 'emote',
              text: 'Kappa',
              imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
            }
          ]
        })
      })
    )
    // The cache resolves asynchronously: the emote's text stands in until then.
    expect(markup).toContain('hi ')
    expect(markup).toContain('Kappa')
  })

  it('renders Kick emotes from fragments, never the raw token', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message('9', 'kick', 'hi emojiAstonished', {
          fragments: [
            { type: 'text', text: 'hi ' },
            {
              type: 'emote',
              text: 'emojiAstonished',
              imageUrl: 'https://files.kick.com/emotes/1579033/fullsize'
            }
          ]
        })
      })
    )
    // The cache resolves asynchronously: the emote's name stands in until then.
    expect(markup).toContain('hi ')
    expect(markup).toContain('emojiAstonished')
    expect(markup).not.toContain('[emote:')
  })

  it('renders 7TV emotes from fragments, stacking a zero-width one on the emote before it', () => {
    const cdn = (id: string): string => `https://cdn.7tv.app/emote/${id}/2x.webp`
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message('10', 'youtube', 'hi catJAM RainTime', {
          fragments: [
            { type: 'text', text: 'hi ' },
            { type: 'emote', text: 'catJAM', imageUrl: cdn('01F6MZGCNG000255K4X1K0NEX9') },
            { type: 'text', text: ' ' },
            {
              type: 'emote',
              text: 'RainTime',
              imageUrl: cdn('01FCY771D800007PQ2DF3GDTN6'),
              zeroWidth: true
            }
          ]
        })
      })
    )
    expect(markup).toContain('hi ')
    // One stack named for both; the base's name stands in until it is
    // cached, and the pending overlay draws nothing on top of it.
    expect(markup).toContain('data-slot="comment-emote-stack"')
    expect(markup).toContain('title="catJAM RainTime"')
    expect(markup).toContain('>catJAM</span>')
    expect(markup).not.toContain('>RainTime<')
  })

  it('draws a Twitch GIF as its own fixed-height block with the title until cached (plan 154)', () => {
    const gif = {
      type: 'gif',
      text: '[Y A Y Yes GIF]',
      imageUrl: 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif'
    }
    const render = (density: 'compact' | 'comfortable', mode?: TwitchGifMode): string => {
      const row = createElement(CommentRow, {
        density,
        message: message('11', 'twitch', '[Y A Y Yes GIF]', { fragments: [gif] })
      })
      return renderToStaticMarkup(
        mode ? createElement(ChatGifModeProvider, { mode, children: row }) : row
      )
    }
    const compact = render('compact')
    // Not an emote: its own block, at the compact height, named by its title.
    expect(compact).toContain('data-slot="comment-gif"')
    expect(compact).toContain('data-gif-mode="animated"')
    expect(compact).toContain('h-16')
    expect(compact).toContain('data-slot="comment-gif-title"')
    expect(compact).toContain('>GIF</span>')
    expect(compact).toContain('Y A Y Yes')
    expect(compact).not.toContain('[Y A Y Yes GIF]')
    expect(compact).not.toContain('data-slot="comment-emote"')
    // The CDN URL never reaches the DOM: the image comes from main's cache.
    expect(compact).not.toContain('giphy.com')
    expect(render('comfortable')).toContain('h-24')
    // Off keeps the title block and never asks main for the image.
    const off = render('compact', 'off')
    expect(off).toContain('data-gif-mode="off"')
    expect(off).toContain('data-slot="comment-gif-title"')
    expect(render('compact', 'still')).toContain('data-gif-mode="still"')
  })

  it('keeps the words around a GIF, and a refused GIF as its title text (plan 154)', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message('12', 'twitch', 'gg [Y A Y Yes GIF] wow', {
          fragments: [
            { type: 'text', text: 'gg ' },
            {
              type: 'gif',
              text: '[Y A Y Yes GIF]',
              imageUrl: 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif'
            },
            { type: 'text', text: ' wow' }
          ]
        })
      })
    )
    expect(markup).toContain('gg ')
    expect(markup).toContain(' wow')
    expect(markup).toContain('data-slot="comment-gif"')
    // The backend dropped the URL of a GIF off the asset allowlist: the row
    // shows what was sent, as text, with no block.
    const refused = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message('13', 'twitch', '[Nope GIF]', {
          fragments: [{ type: 'gif', text: '[Nope GIF]' }]
        })
      })
    )
    expect(refused).toContain('[Nope GIF]')
    expect(refused).not.toContain('data-slot="comment-gif"')
  })

  it('shows the time on every row in History, and on hover while live', () => {
    const row = (timestamps: 'always' | 'hover'): string =>
      renderToStaticMarkup(
        createElement(CommentRow, {
          density: 'comfortable',
          message: message('8', 'twitch', 'hello'),
          timestamps
        })
      )
    expect(row('always')).toContain('<time class="ml-auto shrink-0')
    expect(row('always')).not.toContain('opacity-0')
    expect(row('hover')).toContain('opacity-0')
    expect(row('hover')).toContain('group-hover/comment:opacity-100')
  })
})

describe('followChatOnResize (plan 057, P4)', () => {
  function setup(pinned: boolean) {
    const content = { id: 'content' } as unknown as Element
    const viewport = { scrollTop: 100, scrollHeight: 900, firstElementChild: content }
    const observed: Element[] = []
    let fire = (): void => undefined
    let disconnected = false
    const cleanup = followChatOnResize(
      viewport,
      () => pinned,
      (callback) => {
        fire = callback
        return {
          observe: (target) => observed.push(target),
          disconnect: () => {
            disconnected = true
          }
        }
      }
    )
    return {
      viewport,
      content,
      observed,
      fire: () => fire(),
      cleanup,
      isDisconnected: () => disconnected
    }
  }

  it('keeps a pinned chat on its newest row when the viewport or its rows resize', () => {
    const chat = setup(true)
    expect(chat.observed).toEqual([chat.viewport, chat.content])
    chat.fire()
    expect(chat.viewport.scrollTop).toBe(900)
  })

  it('leaves a streamer who scrolled back where they are', () => {
    const chat = setup(false)
    chat.fire()
    expect(chat.viewport.scrollTop).toBe(100)
    chat.cleanup()
    expect(chat.isDisconnected()).toBe(true)
  })
})

describe('spotlightScrollAllowed', () => {
  const now = 1_000_000
  it('always pulls up while the list follows the latest', () => {
    expect(
      spotlightScrollAllowed({ pinned: true, lastUserScrollAtMs: now - 100, nowMs: now })
    ).toBe(true)
  })

  it('never fights a streamer who scrolled up in the last five seconds', () => {
    expect(
      spotlightScrollAllowed({ pinned: false, lastUserScrollAtMs: now - 4_999, nowMs: now })
    ).toBe(false)
    expect(
      spotlightScrollAllowed({
        pinned: false,
        lastUserScrollAtMs: now - SPOTLIGHT_SCROLL_QUIET_MS,
        nowMs: now
      })
    ).toBe(true)
    expect(spotlightScrollAllowed({ pinned: false, lastUserScrollAtMs: null, nowMs: now })).toBe(
      true
    )
  })
})
