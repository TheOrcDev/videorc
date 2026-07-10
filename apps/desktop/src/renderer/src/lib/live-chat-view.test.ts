import { describe, expect, it } from 'vitest'

import type {
  CommentsSendOperation,
  LiveChatMessage,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import {
  applyLiveChatCleared,
  applyLiveChatMessage,
  applyLiveChatMessages,
  applyLiveChatProviderStatus,
  BoundedLiveChatMessageBatch,
  chatNeedsConnectionAction,
  chatSetupToastWarnings,
  emptyLiveChatSnapshot,
  filterMessagesByPlatform,
  liveChatSendOperationQueryDecision,
  LiveChatRecoveryOverflowError,
  LiveChatMessageBatcher,
  liveChatEmptyMessage,
  nextUnreadCount,
  reconcileLiveChatRecovery,
  reconcileLiveChatSnapshot,
  replayLiveChatBootstrapEvents,
  runBoundedLiveChatRecovery,
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

function sendOperation(id: string): CommentsSendOperation {
  return {
    id,
    sessionId: 's1',
    text: 'hello',
    phase: 'sent',
    destinations: [],
    createdAt: '2026-06-06T10:00:00Z',
    updatedAt: '2026-06-06T10:00:01Z'
  }
}

describe('chat setup warnings', () => {
  it('warns for failed and missing-scope destinations with their message', () => {
    const failed: LiveChatProviderState = {
      ...provider(
        'twitch',
        'Twitch live chat unavailable: Reconnect Twitch to enable live comments.'
      ),
      state: 'failed',
      read: 'failed',
      write: 'failed'
    }
    const missingScope: LiveChatProviderState = {
      ...provider('twitch', 'Reconnect Twitch to send.', 'twitch-2'),
      write: 'missing-scope'
    }

    expect(chatSetupToastWarnings([failed, missingScope]).map((warning) => warning.id)).toEqual([
      'twitch',
      'twitch-2'
    ])
    expect(chatSetupToastWarnings([failed])[0].message).toContain('Reconnect Twitch')
  })

  it('never warns for healthy or documented receive-only destinations', () => {
    const healthy = provider('twitch', '')
    const xReceiveOnly = provider('x', 'X live chat is receive-only.')
    const xUnavailable: LiveChatProviderState = {
      ...provider('x', 'Manual RTMP has no native X broadcast context.', 'x-manual'),
      read: 'unavailable',
      write: 'read-only'
    }

    expect(chatSetupToastWarnings([healthy, xReceiveOnly, xUnavailable])).toEqual([])
    // The unavailable state still deserves the Comments empty-state CTA.
    expect(chatNeedsConnectionAction([xUnavailable])).toBe(true)
    expect(chatNeedsConnectionAction([healthy, xReceiveOnly])).toBe(false)
  })
})

describe('live-chat-view', () => {
  it('replays in-flight deltas without dropping rows from the initial snapshot', () => {
    const initial = {
      ...emptyLiveChatSnapshot('2026-06-06T10:00:00Z'),
      providers: [provider('youtube', 'ready')],
      messages: [message('youtube:old', 'youtube', '2026-06-06T10:00:01Z')]
    }
    const merged = replayLiveChatBootstrapEvents(initial, [
      {
        kind: 'message',
        message: message('twitch:new', 'twitch', '2026-06-06T10:00:02Z')
      },
      { kind: 'provider', provider: provider('twitch', 'connected') }
    ])

    expect(merged.messages.map(({ id }) => id)).toEqual(['youtube:old', 'twitch:new'])
    expect(merged.providers.map(({ platform }) => platform)).toEqual(['youtube', 'twitch'])
  })

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

  it('coalesces a message burst into one state notification', () => {
    const scheduled: Array<() => void> = []
    const notifications: LiveChatMessage[][] = []
    const batcher = new LiveChatMessageBatcher({
      onFlush: (messages) => notifications.push(messages),
      schedule: (flush) => {
        scheduled.push(flush)
        return () => undefined
      }
    })

    batcher.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))
    batcher.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))
    batcher.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))

    expect(scheduled).toHaveLength(1)
    expect(notifications).toHaveLength(0)
    scheduled[0]()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].map(({ id }) => id)).toEqual(['a', 'b'])
  })

  it('replaces an original with a same-batch deletion tombstone', () => {
    const notifications: LiveChatMessage[][] = []
    const batcher = new LiveChatMessageBatcher({
      onFlush: (messages) => notifications.push(messages),
      schedule: () => () => undefined
    })
    const original = message('a', 'youtube', '2026-06-06T10:00:01Z')
    const tombstone = {
      ...original,
      eventType: 'deleted' as const,
      isDeleted: true,
      messageText: 'Message deleted',
      receivedAt: '2026-06-06T10:00:02Z'
    }

    batcher.enqueue(original)
    batcher.enqueue(tombstone)
    batcher.flush()

    expect(notifications).toEqual([[tombstone]])
  })

  it('flushes a full batch and never lets the pending queue grow past capacity', () => {
    const notifications: LiveChatMessage[][] = []
    let cancelled = 0
    const batcher = new LiveChatMessageBatcher({
      capacity: 2,
      onFlush: (messages) => notifications.push(messages),
      schedule: () => () => {
        cancelled += 1
      }
    })

    batcher.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))
    batcher.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))
    batcher.enqueue(message('c', 'youtube', '2026-06-06T10:00:03Z'))

    expect(notifications).toHaveLength(1)
    expect(notifications[0].map(({ id }) => id)).toEqual(['a', 'b'])
    expect(cancelled).toBe(1)
    batcher.flush()
    expect(notifications[1].map(({ id }) => id)).toEqual(['c'])
  })

  it('bounds the underlying queue and resets dedupe state after drain', () => {
    const batch = new BoundedLiveChatMessageBatch(2)
    batch.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))
    batch.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))
    batch.enqueue(message('c', 'youtube', '2026-06-06T10:00:03Z'))

    expect(batch.drain().map(({ id }) => id)).toEqual(['b', 'c'])
    expect(batch.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))).toBe(true)
  })

  it('keeps a lag-recovery tail bounded while notification flushes are suspended', () => {
    const notifications: LiveChatMessage[][] = []
    const batcher = new LiveChatMessageBatcher({
      capacity: 2,
      onFlush: (messages) => notifications.push(messages),
      schedule: () => () => undefined
    })

    batcher.suspend()
    batcher.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))
    batcher.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))
    batcher.enqueue(message('c', 'x', '2026-06-06T10:00:03Z'))

    expect(notifications).toHaveLength(0)
    expect(batcher.drainPending()).toEqual({
      messages: [
        message('b', 'twitch', '2026-06-06T10:00:02Z'),
        message('c', 'x', '2026-06-06T10:00:03Z')
      ],
      overflowed: true
    })
    batcher.resume()
  })

  it('retries authoritative recovery until one bounded tail does not overflow', async () => {
    const attempts: number[] = []
    const result = await runBoundedLiveChatRecovery(async (attempt) => {
      attempts.push(attempt)
      return { value: `snapshot-${attempt}`, overflowed: attempt < 3 }
    })

    expect(result).toBe('snapshot-3')
    expect(attempts).toEqual([1, 2, 3])
  })

  it('fails explicitly after the bounded recovery attempt budget', async () => {
    const recovery = runBoundedLiveChatRecovery(
      async () => ({ value: 'incomplete', overflowed: true }),
      2
    )
    await expect(recovery).rejects.toBeInstanceOf(LiveChatRecoveryOverflowError)
    await expect(recovery).rejects.toMatchObject({ attempts: 2 })
  })

  it('preserves send-operation state on query failure or a newer event', () => {
    expect(
      liveChatSendOperationQueryDecision({
        result: { ok: false },
        sessionId: 's1',
        revisionAtStart: 4,
        currentRevision: 4
      })
    ).toEqual({ kind: 'preserve' })
    expect(
      liveChatSendOperationQueryDecision({
        result: { ok: true, operations: [sendOperation('stale')] },
        sessionId: 's1',
        revisionAtStart: 4,
        currentRevision: 5
      })
    ).toEqual({ kind: 'preserve' })
  })

  it('clears send-operation state only after a successful current empty query', () => {
    expect(
      liveChatSendOperationQueryDecision({
        result: { ok: true, operations: [] },
        sessionId: 's1',
        revisionAtStart: 4,
        currentRevision: 4
      })
    ).toEqual({ kind: 'replace', operation: undefined })
    expect(
      liveChatSendOperationQueryDecision({
        result: { ok: true, operations: [sendOperation('latest')] },
        sessionId: 's1',
        revisionAtStart: 4,
        currentRevision: 4
      })
    ).toEqual({ kind: 'replace', operation: sendOperation('latest') })
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
