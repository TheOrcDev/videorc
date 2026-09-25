import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CommentRow, commentMentions } from '@/components/comment-row'
import type { LiveChatMessage, LiveChatProviderState, StreamPlatform } from '@/lib/backend'
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
