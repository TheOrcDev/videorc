import { describe, expect, it, vi } from 'vitest'

import type {
  CommentsSendOperation,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  StreamPlatform
} from '@/lib/backend'
import { admitChatDelivery, type ChatDelivery } from '../../../shared/chat-delivery'
import {
  applyLiveChatCleared,
  applyLiveChatMessage,
  applyLiveChatMessages,
  applyLiveChatProviderStatus,
  BoundedLiveChatMessageBatch,
  chatNeedsConnectionAction,
  chatSetupToastWarnings,
  commentAuthorIsMember,
  commentRowTint,
  emptyLiveChatSnapshot,
  filterMessagesByPlatform,
  LIVE_CHAT_PLATFORMS,
  liveChatSendOperationQueryDecision,
  LiveChatRecoveryOverflowError,
  LiveChatMessageBatcher,
  liveChatEmptyMessage,
  MAX_LIVE_CHAT_VIEW_MESSAGES,
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
    ).toBe('No messages yet. Chat appears here once you go live.')
  })
})

it('reports a suspended overflow when resume flushes its retained tail after superseded recovery', () => {
  const notifications: string[] = []
  const batcher = new LiveChatMessageBatcher({
    capacity: 2,
    onOverflow: () => {
      notifications.push('overflow')
    },
    onFlush: (messages) => {
      notifications.push(messages.map((message) => message.id).join(','))
    },
    schedule: () => () => {}
  })
  batcher.suspend()
  batcher.enqueue(message('a', 'youtube', '2026-06-06T10:00:01Z'))
  batcher.enqueue(message('b', 'twitch', '2026-06-06T10:00:02Z'))
  batcher.enqueue(message('c', 'x', '2026-06-06T10:00:03Z'))
  batcher.resume()
  expect(notifications).toEqual(['overflow', 'b,c'])
  batcher.flush()
  expect(notifications).toHaveLength(2)
})

describe('member row tint (plan 154)', () => {
  const member = (overrides: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
    ...message('youtube:m1', 'youtube', '2026-07-10T12:00:00Z'),
    authorRoles: ['member'],
    ...overrides
  })
  const plain = { spotlight: false, onStream: false }

  it('reads membership from the normalized member role', () => {
    expect(commentAuthorIsMember({ authorRoles: ['member'] })).toBe(true)
    expect(commentAuthorIsMember({ authorRoles: ['owner', 'member'] })).toBe(true)
    expect(commentAuthorIsMember({ authorRoles: ['vip'] })).toBe(false)
    expect(commentAuthorIsMember({ authorRoles: [] })).toBe(false)
  })

  it('paints one tint per row: member, then the pull-up, then paid, and none on stream', () => {
    expect(commentRowTint(member(), plain)).toBe('member')
    expect(commentRowTint(member(), { spotlight: true, onStream: false })).toBe('spotlight')
    expect(
      commentRowTint(member({ eventType: 'paid', amountText: '$5' }), {
        spotlight: true,
        onStream: false
      })
    ).toBe('paid')
    expect(
      commentRowTint(member({ eventType: 'paid', amountText: '$5' }), {
        spotlight: true,
        onStream: true
      })
    ).toBeNull()
    expect(commentRowTint(message('m2', 'twitch', '2026-07-10T12:00:00Z'), plain)).toBeNull()
  })

  it("tints only a member's own rows", () => {
    expect(commentRowTint(member({ eventType: 'membership' }), plain)).toBe('member')
    expect(commentRowTint(member({ eventType: 'paid', amountText: undefined }), plain)).toBe(
      'member'
    )
    expect(commentRowTint(member({ eventType: 'system' }), plain)).toBeNull()
    expect(commentRowTint(member({ eventType: 'moderation' }), plain)).toBeNull()
    expect(commentRowTint(member({ isDeleted: true }), plain)).toBeNull()
  })
})

/**
 * The batch reducer exactly as it stood before plan 191: dedupe through an id map, then copy
 * and sort the whole buffer on every flush. Kept verbatim as the oracle the incremental
 * append must match for every input.
 */
function referenceApplyLiveChatMessages(
  snapshot: LiveChatSnapshot,
  incoming: LiveChatMessage[]
): LiveChatSnapshot {
  if (incoming.length === 0) return snapshot
  const byId = new Map(snapshot.messages.map((message) => [message.id, message]))
  let changed = false
  for (const message of incoming) {
    const existing = byId.get(message.id)
    if (!existing || (message.isDeleted && !existing.isDeleted)) {
      byId.set(message.id, message)
      changed = true
    }
  }
  if (!changed) return snapshot
  const messages = referenceBoundMessages(sortMessagesChronological([...byId.values()]))
  return {
    ...snapshot,
    messages,
    delivery: admitChatDelivery(snapshot, incoming),
    updatedAt: messages[messages.length - 1]?.receivedAt ?? snapshot.updatedAt
  }
}

function referenceBoundMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  return messages.length > MAX_LIVE_CHAT_VIEW_MESSAGES
    ? messages.slice(messages.length - MAX_LIVE_CHAT_VIEW_MESSAGES)
    : messages
}

/** mulberry32: a tiny seeded PRNG, so every generated scenario replays from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const SCENARIO_EPOCH = Date.UTC(2026, 5, 6, 10, 0, 0)
const scenarioTimes: string[] = []

/** An ISO `receivedAt` whole seconds after the epoch, so equal seconds tie exactly. */
function secondsAt(second: number): string {
  return (scenarioTimes[second] ??= new Date(SCENARIO_EPOCH + second * 1000).toISOString())
}

function tombstoneOf(original: LiveChatMessage, receivedAt = original.receivedAt): LiveChatMessage {
  return {
    ...original,
    receivedAt,
    messageText: 'Message deleted',
    eventType: 'deleted',
    isDeleted: true
  }
}

/** A fixed journal: without one, `admitChatDelivery` mints a random owner id on every call. */
function scenarioSnapshot(messages: LiveChatMessage[]): LiveChatSnapshot {
  const delivery: ChatDelivery = {
    ownerId: 'plan-191-owner',
    generation: 0,
    sequence: 0,
    lossRevision: 0,
    entries: []
  }
  return { ...emptyLiveChatSnapshot('snapshot-time'), sessionId: 's1', delivery, messages }
}

type BufferShape = 'chronological' | 'unsorted' | 'swapped' | 'duplicate-id' | 'over-bound'
type BurstMode = 'in-order' | 'in-order-ties' | 'mixed' | 'duplicates' | 'tombstones'
type BurstKind =
  | 'new'
  | 'late'
  | 'dup-buffer'
  | 'dup-batch'
  | 'delete-buffer'
  | 'delete-batch'
  | 'delete-new'
  | 'restore'

const BURST_KINDS: Record<'mixed' | 'duplicates' | 'tombstones', readonly BurstKind[]> = {
  mixed: [
    'new',
    'new',
    'late',
    'dup-buffer',
    'dup-batch',
    'delete-buffer',
    'delete-batch',
    'delete-new',
    'restore'
  ],
  duplicates: ['dup-buffer', 'dup-buffer', 'dup-batch', 'restore'],
  tombstones: ['delete-buffer', 'delete-buffer', 'delete-batch', 'delete-new', 'new']
}

interface GeneratedScenario {
  snapshot: LiveChatSnapshot
  incoming: LiveChatMessage[]
  shape: BufferShape
  mode: BurstMode
}

/**
 * One deterministic burst: a buffer of 0 to 2,000 rows (now and then malformed, the way the
 * single-message reducer or a snapshot can leave it) and a batch of 1 to 50 messages mixing
 * in-order arrivals, late arrivals, duplicates of buffer and batch ids, tombstones that keep
 * or move their row, and equal-second ties broken by id in either direction.
 */
function generateScenario(seed: number): GeneratedScenario {
  const random = seededRandom(seed)
  const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const max = MAX_LIVE_CHAT_VIEW_MESSAGES
  let serial = 0
  let clock = 0
  const fresh = (receivedAt: string, id?: string): LiveChatMessage => {
    serial += 1
    // A random prefix decouples id order from arrival order, so equal-second ties
    // exercise the id tie-break in both directions.
    return message(
      id ?? `${Math.floor(random() * 36 ** 4).toString(36)}-${serial}`,
      pick(LIVE_CHAT_PLATFORMS),
      receivedAt
    )
  }

  const [minSize, maxSize] = pick([
    [0, 0],
    [1, 10],
    [11, 500],
    [max - 50, max - 1],
    [max, max],
    [max, max],
    [0, max]
  ] as const)
  let buffer: LiveChatMessage[] = []
  for (let size = between(minSize, maxSize); buffer.length < size; ) {
    clock += pick([0, 1, 1, 2])
    const row = fresh(secondsAt(clock))
    buffer.push(random() < 0.05 ? tombstoneOf(row) : row)
  }
  buffer = sortMessagesChronological(buffer)

  const shape =
    random() < 0.8
      ? 'chronological'
      : pick<BufferShape>(['unsorted', 'swapped', 'duplicate-id', 'over-bound'])
  if (shape === 'unsorted' && buffer.length > 0) {
    // The single-message reducer swaps a tombstone in at its original's index even when it
    // carries a later receivedAt, which leaves the buffer out of order.
    const index = between(0, buffer.length - 1)
    buffer[index] = tombstoneOf(buffer[index], secondsAt(clock + between(1, 5)))
  } else if (shape === 'swapped' && buffer.length > 1) {
    const left = between(0, buffer.length - 1)
    const right = between(0, buffer.length - 1)
    const swapped = buffer[left]
    buffer[left] = buffer[right]
    buffer[right] = swapped
  } else if (shape === 'duplicate-id' && buffer.length > 0) {
    // A snapshot can carry one id twice; the id map keeps the later copy. With another
    // receivedAt the buffer still reads as strictly chronological.
    const original = pick(buffer)
    const receivedAt = random() < 0.25 ? original.receivedAt : secondsAt(between(0, clock + 2))
    const copy = random() < 0.5 ? tombstoneOf(original, receivedAt) : { ...original, receivedAt }
    buffer = sortMessagesChronological([...buffer, copy])
  } else if (shape === 'over-bound') {
    // An unbounded input: whatever the reducer returns is still bounded.
    for (const size = max + between(1, 50); buffer.length < size; ) {
      clock += pick([0, 1, 2])
      buffer.push(fresh(secondsAt(clock)))
    }
    buffer = sortMessagesChronological(buffer)
  }

  const mode = pick<BurstMode>([
    'in-order',
    'in-order',
    'in-order-ties',
    'mixed',
    'mixed',
    'duplicates',
    'tombstones'
  ])
  const incoming: LiveChatMessage[] = []
  const deletedRows = buffer.filter((row) => row.isDeleted)
  const sameOrCopy = (row: LiveChatMessage): LiveChatMessage => (random() < 0.5 ? row : { ...row })
  const keptOrMoved = (row: LiveChatMessage): string =>
    random() < 0.7 ? row.receivedAt : secondsAt(between(0, clock + 2))
  const burstMessage = (kind: BurstKind): LiveChatMessage => {
    switch (kind) {
      case 'new':
        clock += pick([0, 1, 1, 2])
        return fresh(secondsAt(clock))
      case 'late':
        return fresh(secondsAt(between(0, Math.max(0, clock - 1))))
      case 'dup-buffer': {
        if (buffer.length === 0) return burstMessage('new')
        const original = pick(buffer)
        // Usually the same row again; sometimes re-delivered with a later receivedAt.
        return random() < 0.8
          ? sameOrCopy(original)
          : { ...original, receivedAt: secondsAt(clock + 1) }
      }
      case 'dup-batch':
        return incoming.length === 0 ? burstMessage('new') : sameOrCopy(pick(incoming))
      case 'delete-buffer': {
        if (buffer.length === 0) return burstMessage('new')
        const original = pick(buffer)
        return tombstoneOf(original, keptOrMoved(original))
      }
      case 'delete-batch': {
        if (incoming.length === 0) return burstMessage('new')
        const original = pick(incoming)
        return tombstoneOf(original, keptOrMoved(original))
      }
      case 'delete-new':
        // A tombstone for a row this view never saw.
        clock += pick([0, 1])
        return tombstoneOf(fresh(secondsAt(random() < 0.5 ? clock : between(0, clock))))
      case 'restore': {
        const deleted = random() < 0.5 ? deletedRows : incoming.filter((row) => row.isDeleted)
        if (deleted.length === 0) return burstMessage('dup-buffer')
        // A non-deleted copy never undoes a tombstone.
        return { ...pick(deleted), isDeleted: false, eventType: 'message', messageText: 'hi' }
      }
    }
  }
  for (const size = between(1, 50); incoming.length < size; ) {
    if (mode === 'in-order' || mode === 'in-order-ties') {
      const tail = incoming.at(-1) ?? buffer.at(-1)
      if (mode === 'in-order' && tail && random() < 0.2) {
        // An equal-second tie whose id still sorts after the tail.
        incoming.push(fresh(tail.receivedAt, `${tail.id}~${serial}`))
      } else {
        clock += mode === 'in-order' ? pick([1, 2]) : pick([0, 0, 1])
        incoming.push(fresh(secondsAt(clock)))
      }
    } else {
      incoming.push(burstMessage(pick(BURST_KINDS[mode])))
    }
  }

  // Neither reducer may write to its inputs.
  Object.freeze(buffer)
  Object.freeze(incoming)
  return { snapshot: scenarioSnapshot(buffer), incoming, shape, mode }
}

/** Runs `run` while counting Array.prototype.sort calls: the full merge sorts, the append must not. */
function countSorts<T>(run: () => T): { result: T; sorts: number } {
  const sort = vi.spyOn(Array.prototype, 'sort')
  try {
    const result = run()
    return { result, sorts: sort.mock.calls.length }
  } finally {
    sort.mockRestore()
  }
}

function chronologicalRows(count: number): LiveChatMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(`row-${String(index).padStart(4, '0')}`, 'youtube', secondsAt(index))
  )
}

describe('applyLiveChatMessages appends a burst instead of re-sorting (plan 191)', () => {
  it('returns exactly what the full merge-and-sort returned, for every generated burst', () => {
    const seen = new Map<string, number>()
    const tally = (key: string): void => {
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (let seed = 1; seed <= 400; seed += 1) {
      const { snapshot, incoming, shape, mode } = generateScenario(seed)
      const context = `seed ${seed}: ${shape} buffer of ${snapshot.messages.length}, ${mode} burst of ${incoming.length}`
      tally(shape)
      tally(mode)
      const expected = referenceApplyLiveChatMessages(snapshot, incoming)
      const actual = applyLiveChatMessages(snapshot, incoming)
      if (expected === snapshot) {
        tally('unchanged')
        expect(actual, context).toBe(snapshot)
        continue
      }
      expect(actual, context).not.toBe(snapshot)
      // The very same row objects in the same order: stricter than deep equality, and far
      // cheaper on 2,000 rows. A mismatch prints the two id orders.
      const sameRows =
        actual.messages.length === expected.messages.length &&
        actual.messages.every((row, index) => row === expected.messages[index])
      if (!sameRows) {
        expect(
          actual.messages.map(({ id }) => id),
          context
        ).toEqual(expected.messages.map(({ id }) => id))
      }
      expect(sameRows, context).toBe(true)
      expect({ ...actual, messages: [] }, context).toStrictEqual({ ...expected, messages: [] })
    }
    // The generator really reaches every buffer shape, burst mode and the no-op return.
    for (const key of [
      'chronological',
      'unsorted',
      'swapped',
      'duplicate-id',
      'over-bound',
      'in-order',
      'in-order-ties',
      'mixed',
      'duplicates',
      'tombstones',
      'unchanged'
    ]) {
      expect(seen.get(key) ?? 0, key).toBeGreaterThan(2)
    }
  }, 120_000)

  it('appends an in-order burst onto a full buffer without re-sorting it', () => {
    const snapshot = scenarioSnapshot(chronologicalRows(MAX_LIVE_CHAT_VIEW_MESSAGES))
    const burst = Array.from({ length: 5 }, (_, index) =>
      message(`burst-${index}`, 'twitch', secondsAt(MAX_LIVE_CHAT_VIEW_MESSAGES + index))
    )

    const { result, sorts } = countSorts(() => applyLiveChatMessages(snapshot, burst))

    expect(sorts).toBe(0)
    expect(result).toEqual(referenceApplyLiveChatMessages(snapshot, burst))
    expect(result.messages).toHaveLength(MAX_LIVE_CHAT_VIEW_MESSAGES)
    expect(result.messages[0]?.id).toBe('row-0005')
    expect(result.messages.slice(-5)).toEqual(burst)
    expect(result.updatedAt).toBe(burst[4]?.receivedAt)
  })

  it('swaps a same-second tombstone in place and skips duplicates, without re-sorting', () => {
    const rows = chronologicalRows(10)
    const snapshot = scenarioSnapshot(rows)
    const tombstone = tombstoneOf(rows[3])
    // Ties the tail's second but sorts after it by id ('t' > 'r').
    const tie = message('tie-after-tail', 'kick', rows[9].receivedAt)
    const next = message('next', 'x', secondsAt(10))
    const batch = [tombstone, rows[5], tie, { ...tie }, next, tombstoneOf(rows[3])]

    const { result, sorts } = countSorts(() => applyLiveChatMessages(snapshot, batch))

    expect(sorts).toBe(0)
    expect(result).toEqual(referenceApplyLiveChatMessages(snapshot, batch))
    expect(result.messages.map(({ id }) => id)).toEqual([
      ...rows.map(({ id }) => id),
      'tie-after-tail',
      'next'
    ])
    expect(result.messages[3]).toBe(tombstone)
  })

  it('returns the same snapshot for an empty or all-duplicate burst', () => {
    const rows = chronologicalRows(10)
    const snapshot = scenarioSnapshot(rows)

    expect(applyLiveChatMessages(snapshot, [])).toBe(snapshot)
    const { result, sorts } = countSorts(() =>
      applyLiveChatMessages(snapshot, [rows[0], { ...rows[9] }, rows[4]])
    )
    expect(result).toBe(snapshot)
    expect(sorts).toBe(0)
  })

  const rows = chronologicalRows(10)
  it.each([
    {
      name: 'a message lands before the tail',
      buffer: rows,
      batch: [message('early', 'twitch', secondsAt(4)), message('later', 'x', secondsAt(11))]
    },
    {
      name: 'an equal-second message sorts before the tail by id',
      buffer: rows,
      batch: [message('a-first', 'kick', rows[9].receivedAt)]
    },
    {
      name: 'the burst is out of order among itself',
      buffer: rows,
      batch: [message('later', 'x', secondsAt(12)), message('sooner', 'x', secondsAt(11))]
    },
    {
      name: 'a tombstone moves its row',
      buffer: rows,
      batch: [tombstoneOf(rows[2], secondsAt(20))]
    },
    {
      // What the single-message reducer leaves behind for a tombstone with a later receivedAt.
      name: 'the buffer is out of order',
      buffer: applyLiveChatMessage(scenarioSnapshot(rows), tombstoneOf(rows[2], secondsAt(20)))
        .messages,
      batch: [message('next', 'x', secondsAt(30))]
    },
    {
      name: 'the buffer holds one id twice',
      buffer: sortMessagesChronological([...rows, { ...rows[1], receivedAt: secondsAt(15) }]),
      batch: [message('next', 'x', secondsAt(30))]
    }
  ])('falls back to the full merge-and-sort when $name', ({ buffer, batch }) => {
    const snapshot = scenarioSnapshot(buffer)

    const { result, sorts } = countSorts(() => applyLiveChatMessages(snapshot, batch))

    expect(sorts).toBeGreaterThan(0)
    expect(result).toEqual(referenceApplyLiveChatMessages(snapshot, batch))
  })
})
