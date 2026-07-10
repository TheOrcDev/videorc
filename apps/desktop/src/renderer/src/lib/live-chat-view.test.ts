import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, LiveChatProviderState, StreamPlatform } from '@/lib/backend'
import {
  applyLiveChatCleared,
  applyLiveChatMessage,
  applyLiveChatMessages,
  applyLiveChatProviderStatus,
  emptyLiveChatSnapshot,
  filterMessagesByPlatform,
  liveChatEmptyMessage,
  nextUnreadCount,
  reconcileLiveChatRecovery,
  reconcileLiveChatSnapshot,
  shouldAutoscroll,
  sortMessagesChronological,
  visibleMessages
} from './live-chat-view'

function message(id: string, platform: StreamPlatform, receivedAt: string): LiveChatMessage {
  return {
    id,
    providerMessageId: id,
    platform,
    sessionId: 's1',
    authorName: 'Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: receivedAt,
    receivedAt,
    messageText: 'hi',
    fragments: [],
    eventType: 'message',
    isDeleted: false
  }
}

function provider(
  platform: StreamPlatform,
  message: string,
  id: string = platform
): LiveChatProviderState {
  return {
    id,
    platform,
    state: 'connected',
    read: 'ready',
    write: platform === 'x' ? 'read-only' : 'ready',
    message
  }
}

describe('live-chat-view', () => {
  it('sorts messages chronologically by receivedAt', () => {
    const sorted = sortMessagesChronological([
      message('twitch:b', 'twitch', '2026-06-06T10:00:02Z'),
      message('youtube:a', 'youtube', '2026-06-06T10:00:01Z'),
      message('twitch:c', 'twitch', '2026-06-06T10:00:03Z')
    ])
    expect(sorted.map((m) => m.id)).toEqual(['youtube:a', 'twitch:b', 'twitch:c'])
  })

  it('merges an out-of-order message into chronological position', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    snapshot = applyLiveChatMessage(snapshot, message('a', 'youtube', '2026-06-06T10:00:03Z'))
    snapshot = applyLiveChatMessage(snapshot, message('b', 'twitch', '2026-06-06T10:00:01Z'))
    expect(snapshot.messages.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('dedupes incremental messages by id', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    const duplicate = message('dup', 'youtube', '2026-06-06T10:00:01Z')
    snapshot = applyLiveChatMessage(snapshot, duplicate)
    snapshot = applyLiveChatMessage(snapshot, duplicate)
    expect(snapshot.messages).toHaveLength(1)
  })

  it('replaces an original with a same-id deletion tombstone', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    const original = message('message-1', 'youtube', '2026-06-06T10:00:01Z')
    const tombstone = {
      ...original,
      messageText: 'Message deleted',
      eventType: 'deleted' as const,
      isDeleted: true
    }
    snapshot = applyLiveChatMessage(snapshot, original)
    snapshot = applyLiveChatMessage(snapshot, tombstone)

    expect(snapshot.messages).toEqual([tombstone])
  })

  it('keeps a delete-before-original tombstone and isolates other destination ids', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    const original = message('message-1', 'youtube', '2026-06-06T10:00:01Z')
    const tombstone = { ...original, eventType: 'deleted' as const, isDeleted: true }
    snapshot = applyLiveChatMessages(snapshot, [tombstone, original])
    snapshot = applyLiveChatMessage(
      snapshot,
      message('other-target:message-1', 'youtube', '2026-06-06T10:00:02Z')
    )

    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages.find((row) => row.id === 'message-1')?.isDeleted).toBe(true)
  })

  it('filters by platform, treating an empty set as show-all', () => {
    const messages = [
      message('y', 'youtube', '2026-06-06T10:00:01Z'),
      message('t', 'twitch', '2026-06-06T10:00:02Z')
    ]
    expect(filterMessagesByPlatform(messages, new Set()).map((m) => m.id)).toEqual(['y', 't'])
    expect(
      filterMessagesByPlatform(messages, new Set<StreamPlatform>(['twitch'])).map((m) => m.id)
    ).toEqual(['t'])
  })

  it('updates an existing provider row and appends new ones', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    snapshot = applyLiveChatProviderStatus(snapshot, provider('youtube', 'connecting'))
    snapshot = applyLiveChatProviderStatus(snapshot, provider('twitch', 'connected'))
    snapshot = applyLiveChatProviderStatus(snapshot, provider('youtube', 'connected'))
    expect(snapshot.providers).toHaveLength(2)
    expect(snapshot.providers.find((p) => p.platform === 'youtube')?.message).toBe('connected')
  })

  it('updates provider status by destination id without overwriting same-platform targets', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    snapshot = applyLiveChatProviderStatus(
      snapshot,
      provider('youtube', 'primary connected', 'youtube-primary')
    )
    snapshot = applyLiveChatProviderStatus(
      snapshot,
      provider('youtube', 'backup connecting', 'youtube-backup')
    )
    snapshot = applyLiveChatProviderStatus(
      snapshot,
      provider('youtube', 'backup connected', 'youtube-backup')
    )

    expect(snapshot.providers).toHaveLength(2)
    expect(snapshot.providers.find((row) => row.id === 'youtube-primary')?.message).toBe(
      'primary connected'
    )
    expect(snapshot.providers.find((row) => row.id === 'youtube-backup')?.message).toBe(
      'backup connected'
    )
  })

  it('clears the message view but keeps providers', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    snapshot = applyLiveChatProviderStatus(snapshot, provider('youtube', 'connected'))
    snapshot = applyLiveChatMessage(snapshot, message('a', 'youtube', '2026-06-06T10:00:01Z'))
    snapshot = applyLiveChatCleared(snapshot)
    expect(snapshot.messages).toHaveLength(0)
    expect(snapshot.unreadCount).toBe(0)
    expect(snapshot.providers).toHaveLength(1)
  })

  it('counts unread only while paused, and autoscrolls only when not paused', () => {
    expect(nextUnreadCount(0, false, 3)).toBe(0)
    expect(nextUnreadCount(2, true, 3)).toBe(5)
    expect(shouldAutoscroll(false)).toBe(true)
    expect(shouldAutoscroll(true)).toBe(false)
  })

  it('applies a batch of messages in one pass, deduped and ordered', () => {
    let snapshot = emptyLiveChatSnapshot('now')
    snapshot = applyLiveChatMessage(snapshot, message('a', 'youtube', '2026-06-06T10:00:02Z'))
    snapshot = applyLiveChatMessages(snapshot, [
      message('b', 'twitch', '2026-06-06T10:00:01Z'),
      message('a', 'youtube', '2026-06-06T10:00:02Z'),
      message('c', 'twitch', '2026-06-06T10:00:03Z')
    ])
    expect(snapshot.messages.map((m) => m.id)).toEqual(['b', 'a', 'c'])
    expect(snapshot.updatedAt).toBe('2026-06-06T10:00:03Z')
  })

  it('replaces stale incremental belief after lag and merges the queued tail', () => {
    const authoritative = {
      ...emptyLiveChatSnapshot('snapshot-time'),
      sessionId: 's1',
      messages: [
        message('a', 'youtube', '2026-06-06T10:00:01Z'),
        message('c', 'x', '2026-06-06T10:00:03Z')
      ]
    }
    const snapshot = reconcileLiveChatSnapshot(authoritative, [
      message('c', 'x', '2026-06-06T10:00:03Z'),
      message('b', 'twitch', '2026-06-06T10:00:02Z')
    ])

    expect(snapshot.messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(snapshot.updatedAt).toBe('2026-06-06T10:00:03Z')
  })

  it('restores a lagged message without rolling back provider status received during the RPC', () => {
    const stale = {
      ...emptyLiveChatSnapshot('stale-time'),
      sessionId: 's1',
      providers: [provider('youtube', 'scope refreshed')],
      messages: [message('a', 'youtube', '2026-06-06T10:00:01Z')]
    }
    const authoritative = {
      ...emptyLiveChatSnapshot('snapshot-time'),
      sessionId: 's1',
      providers: [provider('youtube', 'connecting')],
      messages: [
        message('a', 'youtube', '2026-06-06T10:00:01Z'),
        message('missed', 'twitch', '2026-06-06T10:00:02Z')
      ]
    }

    const recovered = reconcileLiveChatRecovery(
      authoritative,
      stale,
      [message('tail', 'x', '2026-06-06T10:00:03Z')],
      true
    )

    expect(recovered.messages.map((row) => row.id)).toEqual(['a', 'missed', 'tail'])
    expect(recovered.providers[0]?.message).toBe('scope refreshed')
  })

  it('windows the rendered tail to the most recent messages', () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      message(`m${index}`, 'youtube', `2026-06-06T10:00:0${index}Z`)
    )
    expect(visibleMessages(messages, 2).map((m) => m.id)).toEqual(['m3', 'm4'])
    expect(visibleMessages(messages, 10)).toHaveLength(5)
  })

  it('uses actionable provider messages for the empty state', () => {
    expect(liveChatEmptyMessage({ providers: [] })).toBe(
      'Connect YouTube, Twitch, or X to read live comments.'
    )
    expect(
      liveChatEmptyMessage({
        providers: [
          {
            id: 'twitch',
            platform: 'twitch',
            state: 'disabled',
            read: 'unavailable',
            write: 'unavailable',
            message: 'Connect Twitch to read live comments.'
          }
        ]
      })
    ).toBe('Connect Twitch to read live comments.')
    expect(
      liveChatEmptyMessage({
        providers: [
          {
            id: 'twitch',
            platform: 'twitch',
            state: 'disabled',
            read: 'ready',
            write: 'missing-scope',
            message: 'Reconnect Twitch to enable live comments.'
          }
        ]
      })
    ).toBe('Reconnect Twitch to enable live comments.')
    expect(
      liveChatEmptyMessage({
        providers: [
          {
            id: 'twitch',
            platform: 'twitch',
            state: 'connected',
            read: 'ready',
            write: 'ready',
            message: 'Twitch live chat connected.'
          }
        ]
      })
    ).toBe('No comments yet. Comments appear here once you go live.')
  })
})
