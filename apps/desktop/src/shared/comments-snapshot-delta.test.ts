import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, LiveChatProviderState, LiveChatSnapshot } from './backend'
import {
  MAX_COMMENTS_SNAPSHOT_MESSAGES,
  applyCommentsSnapshotDelta
} from './comments-snapshot-delta'

function message(
  id: string,
  sessionId = 'live-session',
  overrides: Partial<LiveChatMessage> = {}
): LiveChatMessage {
  return {
    id,
    providerMessageId: id,
    platform: 'twitch',
    sessionId,
    authorName: 'Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: `2026-07-10T00:00:${id.padStart(2, '0')}Z`,
    receivedAt: `2026-07-10T00:00:${id.padStart(2, '0')}Z`,
    messageText: id,
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

function snapshot(sessionId = 'live-session'): LiveChatSnapshot {
  return {
    sessionId,
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt: '2026-07-10T00:00:00Z'
  }
}

describe('comments snapshot deltas', () => {
  it('adds, orders, deduplicates, and bounds message deltas', () => {
    let current = snapshot()
    for (let index = MAX_COMMENTS_SNAPSHOT_MESSAGES; index >= 0; index -= 1) {
      current = applyCommentsSnapshotDelta(current, {
        kind: 'message',
        message: message(String(index).padStart(3, '0'))
      })
    }
    const duplicate = applyCommentsSnapshotDelta(current, {
      kind: 'message',
      message: current.messages.at(-1)!
    })

    expect(current.messages).toHaveLength(MAX_COMMENTS_SNAPSHOT_MESSAGES)
    expect(current.messages[0].id).toBe('001')
    expect(current.messages.at(-1)?.id).toBe('500')
    expect(duplicate).toBe(current)
  })

  it('updates one provider without replacing the rest', () => {
    const youtube: LiveChatProviderState = {
      id: 'youtube-main',
      platform: 'youtube',
      targetId: 'youtube-main',
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: 'Ready'
    }
    const twitch: LiveChatProviderState = {
      id: 'twitch-main',
      platform: 'twitch',
      targetId: 'twitch-main',
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: 'Ready'
    }
    const current = { ...snapshot(), providers: [youtube, twitch] }
    const next = applyCommentsSnapshotDelta(current, {
      kind: 'provider',
      provider: { ...twitch, state: 'reconnecting', message: 'Reconnecting' },
      sessionId: current.sessionId,
      updatedAt: '2026-07-10T00:00:10Z'
    })

    expect(next.providers).toEqual([
      youtube,
      { ...twitch, state: 'reconnecting', message: 'Reconnecting' }
    ])
  })

  it('keeps destinations on the same platform separate by provider id', () => {
    const first: LiveChatProviderState = {
      id: 'youtube-primary',
      platform: 'youtube',
      targetId: 'youtube-primary',
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: 'Ready'
    }
    const second = { ...first, id: 'youtube-secondary', targetId: 'youtube-secondary' }
    const current = { ...snapshot(), providers: [first] }
    const next = applyCommentsSnapshotDelta(current, {
      kind: 'provider',
      provider: second,
      sessionId: current.sessionId,
      updatedAt: '2026-07-10T00:00:10Z'
    })

    expect(next.providers).toEqual([first, second])
  })

  it('replaces an existing message with its deletion tombstone', () => {
    const original = message('001')
    const tombstone = message('001', 'live-session', {
      eventType: 'deleted',
      isDeleted: true,
      messageText: '',
      receivedAt: '2026-07-10T00:01:00Z'
    })
    const current = { ...snapshot(), messages: [original] }
    const next = applyCommentsSnapshotDelta(current, { kind: 'message', message: tombstone })

    expect(next.messages).toEqual([tombstone])
  })

  it('does not let live deltas overwrite a historical transcript', () => {
    const historical = { ...snapshot('saved-session'), messages: [message('001', 'saved-session')] }
    const next = applyCommentsSnapshotDelta(historical, {
      kind: 'message',
      message: message('002', 'live-session')
    })

    expect(next).toBe(historical)
  })

  it('clears messages while preserving provider state', () => {
    const current = { ...snapshot(), messages: [message('001')], unreadCount: 1 }
    const next = applyCommentsSnapshotDelta(current, {
      kind: 'clear',
      sessionId: current.sessionId,
      updatedAt: '2026-07-10T00:01:00Z'
    })

    expect(next.messages).toEqual([])
    expect(next.unreadCount).toBe(0)
  })
})
