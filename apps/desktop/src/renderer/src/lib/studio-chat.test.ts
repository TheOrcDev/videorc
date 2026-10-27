import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, LiveChatProviderState } from '@/lib/backend'
import { studioChatOn, studioChatShows } from '@/lib/studio-chat'
import {
  STUDIO_CHAT_CONNECTED,
  STUDIO_CHAT_NO_CHAT,
  STUDIO_CHAT_NO_MESSAGES,
  studioChatBody,
  studioChatCountsAsArrival,
  studioChatMessages,
  studioChatNotice
} from '@/lib/studio-chat-view'
import { liveChatEmptyMessage } from '@/lib/live-chat-view'

// Plan 204: Chat in Studio. The gate is off until switched on (owner,
// 2026-10-27) and shows only while a livestream is on air (D2).

const LIVE = { state: 'streaming', streamUrl: 'rtmp://example.test/live' }

describe('studioChatOn', () => {
  it('is off until the switch is turned on', () => {
    expect(studioChatOn({})).toBe(false)
    expect(studioChatOn({ studioChat: false })).toBe(false)
    expect(studioChatOn({ studioChat: true })).toBe(true)
  })
})

describe('studioChatShows', () => {
  it('shows only while switched on and on air', () => {
    expect(studioChatShows({ settings: { studioChat: true }, recording: LIVE })).toBe(true)
    // Go Live records too: `recording` with a stream URL is on air.
    expect(
      studioChatShows({
        settings: { studioChat: true },
        recording: { state: 'recording', streamUrl: 'rtmp://example.test/live' }
      })
    ).toBe(true)
  })

  it('never shows while off, idle, recording only, Clips only or starting', () => {
    expect(studioChatShows({ settings: {}, recording: LIVE })).toBe(false)
    expect(studioChatShows({ settings: { studioChat: false }, recording: LIVE })).toBe(false)
    for (const recording of [
      { state: 'idle' },
      { state: 'recording' },
      { state: 'recording', streamUrl: null },
      { state: 'starting', streamUrl: 'rtmp://example.test/live' },
      { state: 'stopping', streamUrl: 'rtmp://example.test/live' }
    ]) {
      expect(studioChatShows({ settings: { studioChat: true }, recording }), recording.state).toBe(
        false
      )
    }
  })
})

const message = (
  id: string,
  eventType: LiveChatMessage['eventType'] = 'message',
  extra: Partial<LiveChatMessage> = {}
): LiveChatMessage => ({
  id,
  providerMessageId: id,
  platform: 'youtube',
  sessionId: 's1',
  authorName: 'Ada',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-10-27T12:00:00.000Z',
  receivedAt: '2026-10-27T12:00:00.000Z',
  messageText: 'Ship it!',
  fragments: [],
  eventType,
  isDeleted: false,
  ...extra
})

const provider = (patch: Partial<LiveChatProviderState> = {}): LiveChatProviderState => ({
  id: 'youtube:main',
  platform: 'youtube',
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: 'Connected.',
  ...patch
})

describe('studioChatMessages', () => {
  it('lists the Stream Manager unfiltered chat: messages, paid and notices, never activity', () => {
    const shown = studioChatMessages([
      message('m1'),
      message('p1', 'paid', { amountText: '$5.00' }),
      message('f1', 'follow', { details: { kind: 'follow' } }),
      message('s1', 'system')
    ])
    expect(shown.map((row) => row.id)).toEqual(['m1', 'p1', 's1'])
  })

  it('counts an arrival only for a message it lists', () => {
    expect(studioChatCountsAsArrival(message('m1'))).toBe(true)
    expect(studioChatCountsAsArrival(message('f1', 'follow'))).toBe(false)
  })
})

describe('studioChatBody', () => {
  it('is one line when nothing on this livestream has chat', () => {
    expect(studioChatBody([])).toEqual({ kind: 'no-chat', text: STUDIO_CHAT_NO_CHAT })
  })

  it('keeps the list area from the moment chat attaches', () => {
    expect(studioChatBody([provider()])).toEqual({
      kind: 'list',
      emptyText: STUDIO_CHAT_CONNECTED
    })
  })

  it('says no messages yet, not connected, while the notice says what is wrong', () => {
    expect(
      studioChatBody([provider({ state: 'failed', read: 'failed', message: 'Reconnect YouTube.' })])
    ).toEqual({ kind: 'list', emptyText: STUDIO_CHAT_NO_MESSAGES })
  })
})

describe('studioChatNotice', () => {
  it('is quiet while every chat is fine', () => {
    expect(studioChatNotice([provider()])).toBeNull()
    expect(studioChatNotice([])).toBeNull()
  })

  it('names the same destination the Stream Manager empty chat names', () => {
    const providers = [
      provider({ id: 'twitch:main', platform: 'twitch', read: 'unavailable', message: 'Twitch.' }),
      provider({ state: 'failed', read: 'failed', message: 'YouTube chat stopped.' })
    ]
    expect(studioChatNotice(providers)).toBe('YouTube chat stopped.')
    expect(liveChatEmptyMessage({ providers })).toBe('YouTube chat stopped.')
  })

  it('says nothing for a destination that needs the streamer but has no words', () => {
    expect(studioChatNotice([provider({ state: 'failed', read: 'failed', message: ' ' })])).toBe(
      null
    )
  })
})
