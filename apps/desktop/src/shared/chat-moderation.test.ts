import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, ModerationOperation } from './backend'
import {
  COMMENTS_MODERATION_RELAY_TIMEOUT_MS,
  COMMENTS_MODERATION_TIMING_CONTRACT,
  HIDDEN_IN_VIDEORC_PROVIDER_TYPE,
  MAX_RELAYED_MODERATION_OPERATIONS,
  MODERATION_PHASES,
  REMOVED_BY_YOU_PROVIDER_TYPE,
  chatMessageRemovable,
  latestModerationOperationByMessage,
  localRemovalKind,
  mergeModerationOperations,
  moderationOperationOpen,
  moderationOperationTerminal,
  nextRelayedModerationOperations,
  reconcileModerationOperation,
  relayedModerationOperations
} from './chat-moderation'

function operation(
  patch: Partial<ModerationOperation> & Pick<ModerationOperation, 'operationId' | 'phase'>
): ModerationOperation {
  return {
    operationId: patch.operationId,
    sessionId: patch.sessionId ?? 'session-1',
    messageId: patch.messageId ?? 'session-1:twitch:default:m-1',
    platform: patch.platform ?? 'twitch',
    authorName: patch.authorName ?? 'coders_x',
    excerpt: patch.excerpt ?? 'this stream is trash',
    source: patch.source ?? 'orcle-voice',
    phase: patch.phase,
    confirmMode: patch.confirmMode ?? 'confirm',
    requiresExplicitConfirm: patch.requiresExplicitConfirm ?? true,
    createdAt: patch.createdAt ?? '2026-10-04T12:00:00Z',
    updatedAt: patch.updatedAt ?? '2026-10-04T12:00:00Z',
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
    ...(patch.outcome === undefined ? {} : { outcome: patch.outcome }),
    ...(patch.outcomeCode === undefined ? {} : { outcomeCode: patch.outcomeCode })
  }
}

describe('localRemovalKind', () => {
  it('tells "Removed by you" from "Hidden in Videorc" by the provider type', () => {
    expect(
      localRemovalKind({ isDeleted: true, rawProviderType: REMOVED_BY_YOU_PROVIDER_TYPE })
    ).toBe('removed')
    expect(
      localRemovalKind({ isDeleted: true, rawProviderType: HIDDEN_IN_VIDEORC_PROVIDER_TYPE })
    ).toBe('hidden')
    expect(REMOVED_BY_YOU_PROVIDER_TYPE).toBe('videorc.removed')
    expect(HIDDEN_IN_VIDEORC_PROVIDER_TYPE).toBe('videorc.hidden')
  })

  it('is null for live rows and for a provider deletion', () => {
    expect(localRemovalKind({ isDeleted: false, rawProviderType: 'videorc.removed' })).toBeNull()
    expect(
      localRemovalKind({ isDeleted: true, rawProviderType: 'channel.chat.message_delete' })
    ).toBeNull()
    expect(localRemovalKind({ isDeleted: true })).toBeNull()
  })
})

describe('moderation operation phases', () => {
  it('names the terminal phases and the open card', () => {
    for (const phase of [
      'cancelled',
      'expired',
      'removed',
      'hidden-locally',
      'failed',
      'delivery-unknown'
    ] as const) {
      expect(moderationOperationTerminal(operation({ operationId: 'op', phase }))).toBe(true)
      expect(moderationOperationOpen(operation({ operationId: 'op', phase }))).toBe(false)
    }
    expect(moderationOperationTerminal(operation({ operationId: 'op', phase: 'executing' }))).toBe(
      false
    )
    expect(
      moderationOperationTerminal(operation({ operationId: 'op', phase: 'pending-confirm' }))
    ).toBe(false)
    expect(
      moderationOperationOpen(operation({ operationId: 'op', phase: 'pending-confirm' }))
    ).toBe(true)
  })
})

describe('reconcileModerationOperation', () => {
  it('never rolls a terminal operation back to executing', () => {
    const removed = operation({ operationId: 'op', phase: 'removed', outcomeCode: 'removed' })
    const lateExecuting = operation({
      operationId: 'op',
      phase: 'executing',
      updatedAt: '2099-01-01T00:00:00Z'
    })
    expect(reconcileModerationOperation(removed, lateExecuting)).toBe(removed)
  })

  it('advances to the terminal phase whatever the timestamps say', () => {
    const executing = operation({
      operationId: 'op',
      phase: 'executing',
      updatedAt: '2026-10-04T12:00:05Z'
    })
    const hidden = operation({
      operationId: 'op',
      phase: 'hidden-locally',
      outcomeCode: 'missing-scope',
      outcome:
        'Hidden in Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Orcle remove messages.',
      updatedAt: '2026-10-04T12:00:04Z'
    })
    expect(reconcileModerationOperation(executing, hidden)).toBe(hidden)
  })

  it('lets the newer of two open rows win and replaces a different operation', () => {
    const pending = operation({
      operationId: 'op',
      phase: 'pending-confirm',
      updatedAt: '2026-10-04T12:00:00Z'
    })
    const executing = operation({
      operationId: 'op',
      phase: 'executing',
      updatedAt: '2026-10-04T12:00:03Z'
    })
    expect(reconcileModerationOperation(pending, executing)).toBe(executing)
    expect(reconcileModerationOperation(executing, pending)).toBe(executing)
    const other = operation({ operationId: 'other', phase: 'pending-confirm' })
    expect(reconcileModerationOperation(executing, other)).toBe(other)
    expect(reconcileModerationOperation(undefined, pending)).toBe(pending)
  })
})

function chatRow(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: 'session-1:twitch:default:m-1',
    providerMessageId: 'm-1',
    platform: 'twitch',
    sessionId: 'session-1',
    authorName: 'coders_x',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-04T12:00:00Z',
    receivedAt: '2026-10-04T12:00:00Z',
    messageText: 'this stream is trash',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

describe('chatMessageRemovable (plan 140, S6)', () => {
  it('offers chat and paid messages from viewers', () => {
    expect(chatMessageRemovable(chatRow())).toBe(true)
    expect(chatMessageRemovable(chatRow({ eventType: 'paid', amountText: '$5' }))).toBe(true)
    expect(chatMessageRemovable(chatRow({ authorRoles: ['moderator', 'subscriber'] }))).toBe(true)
  })

  it('never offers a tombstone, a notification row or the streamer', () => {
    expect(chatMessageRemovable(chatRow({ isDeleted: true }))).toBe(false)
    expect(chatMessageRemovable(chatRow({ eventType: 'deleted' }))).toBe(false)
    for (const eventType of ['membership', 'system', 'moderation', 'follow'] as const) {
      expect(chatMessageRemovable(chatRow({ eventType }))).toBe(false)
    }
    expect(
      chatMessageRemovable(chatRow({ rawProviderType: 'channel.chat.notification.resub' }))
    ).toBe(false)
    expect(chatMessageRemovable(chatRow({ authorRoles: ['owner'] }))).toBe(false)
    expect(chatMessageRemovable(chatRow({ authorRoles: [' Broadcaster '] }))).toBe(false)
  })
})

describe('the Stream Manager relay (plan 140, S6)', () => {
  it('names every phase and the relay timing', () => {
    expect([...MODERATION_PHASES].sort()).toEqual(
      [
        'cancelled',
        'delivery-unknown',
        'executing',
        'expired',
        'failed',
        'hidden-locally',
        'pending-confirm',
        'removed'
      ].sort()
    )
    // Two 8 s provider attempts fit the backend request; main waits longer.
    expect(COMMENTS_MODERATION_TIMING_CONTRACT.backendRequestMs).toBeGreaterThanOrEqual(16_000)
    expect(COMMENTS_MODERATION_RELAY_TIMEOUT_MS).toBe(32_000)
  })

  it('keeps one session, every open removal first, at most 100', () => {
    const finished = Array.from({ length: 120 }, (_, index) =>
      operation({
        operationId: `done-${String(index).padStart(3, '0')}`,
        messageId: `m-${index}`,
        phase: 'removed',
        createdAt: new Date(Date.UTC(2026, 9, 4, 12, 0, index)).toISOString()
      })
    )
    const open = operation({
      operationId: 'open',
      phase: 'pending-confirm',
      createdAt: '2026-10-04T11:00:00Z'
    })
    const other = operation({ operationId: 'other', sessionId: 'session-2', phase: 'executing' })
    const relayed = relayedModerationOperations([...finished, open, other], 'session-1')
    expect(relayed).toHaveLength(MAX_RELAYED_MODERATION_OPERATIONS)
    expect(relayed[0].operationId).toBe('open')
    expect(relayed[1].operationId).toBe('done-119')
    expect(relayed.some((entry) => entry.sessionId === 'session-2')).toBe(false)
    expect(relayedModerationOperations([open], null)).toEqual([])
  })

  it('merges by id and picks each message its newest removal', () => {
    const failed = operation({
      operationId: 'first',
      phase: 'failed',
      createdAt: '2026-10-04T12:00:00Z'
    })
    const retry = operation({
      operationId: 'retry',
      phase: 'executing',
      createdAt: '2026-10-04T12:00:05Z'
    })
    const merged = mergeModerationOperations(
      [failed],
      [retry, { ...retry, phase: 'removed', updatedAt: '2026-10-04T12:00:06Z' }]
    )
    expect(merged.map((entry) => [entry.operationId, entry.phase])).toEqual([
      ['first', 'failed'],
      ['retry', 'removed']
    ])
    expect(latestModerationOperationByMessage(merged).get(failed.messageId)?.operationId).toBe(
      'retry'
    )
  })

  it("updates main's cache from a push, keeps it otherwise, and drops it for a new session", () => {
    const open = operation({ operationId: 'open', phase: 'executing' })
    const cached = [open]
    expect(nextRelayedModerationOperations(cached, undefined, 'session-1', false)).toBe(cached)
    expect(nextRelayedModerationOperations(cached, undefined, 'session-2', true)).toBeUndefined()
    expect(nextRelayedModerationOperations(undefined, [open], 'session-1', true)).toEqual([open])
    expect(nextRelayedModerationOperations(cached, [open], 'session-2', true)).toEqual([])
  })
})
