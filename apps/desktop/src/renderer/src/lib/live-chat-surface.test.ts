import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, LiveChatSnapshot } from '@/lib/backend'

import {
  hasLiveChatTranscript,
  liveChatRailAvailable,
  shouldAutoOpenLiveChatRail
} from './live-chat-surface'

function message(id: string): LiveChatMessage {
  return {
    id,
    providerMessageId: id,
    platform: 'youtube',
    sessionId: 'session-1',
    authorName: 'Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-06-06T10:00:00Z',
    receivedAt: '2026-06-06T10:00:01Z',
    messageText: 'hello',
    fragments: [{ type: 'text', text: 'hello' }],
    eventType: 'message',
    isDeleted: false
  }
}

function snapshot(messages: LiveChatMessage[] = []): LiveChatSnapshot {
  return {
    providers: [],
    messages,
    unreadCount: messages.length,
    updatedAt: '2026-06-06T10:00:02Z'
  }
}

describe('live-chat-surface', () => {
  it('keeps the rail unavailable off-air when there is no retained transcript', () => {
    expect(liveChatRailAvailable('idle', snapshot())).toBe(false)
  })

  it('keeps retained livestream comments reachable after the stream ends', () => {
    const stoppedWithTranscript = snapshot([message('youtube:1')])

    expect(hasLiveChatTranscript(stoppedWithTranscript)).toBe(true)
    expect(liveChatRailAvailable('idle', stoppedWithTranscript)).toBe(true)
  })

  it('auto-opens while streaming once provider rows attach', () => {
    expect(
      shouldAutoOpenLiveChatRail({
        alreadyAutoOpened: false,
        providersAttached: true,
        recordingState: 'streaming',
        snapshot: snapshot()
      })
    ).toBe(true)
  })

  it('auto-opens a retained transcript after reconnecting to a stopped session', () => {
    expect(
      shouldAutoOpenLiveChatRail({
        alreadyAutoOpened: false,
        providersAttached: false,
        recordingState: 'idle',
        snapshot: snapshot([message('youtube:1')])
      })
    ).toBe(true)
  })

  it('does not auto-open again after the user has already seen or closed it', () => {
    expect(
      shouldAutoOpenLiveChatRail({
        alreadyAutoOpened: true,
        providersAttached: true,
        recordingState: 'streaming',
        snapshot: snapshot([message('youtube:1')])
      })
    ).toBe(false)
  })
})
