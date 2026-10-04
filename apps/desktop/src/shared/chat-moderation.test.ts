import { describe, expect, it } from 'vitest'

import type { ModerationOperation } from './backend'
import {
  HIDDEN_IN_VIDEORC_PROVIDER_TYPE,
  REMOVED_BY_YOU_PROVIDER_TYPE,
  localRemovalKind,
  moderationOperationOpen,
  moderationOperationTerminal,
  reconcileModerationOperation
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
