import { describe, expect, it } from 'vitest'

import type { CommentsSendOperation } from './backend'
import {
  commentsRefreshRevisionIsCurrent,
  commentsSendOperationTerminal,
  commentsSendTransportFailureCanReplace,
  reconcileCommentsSendOperation
} from './comments-send-operation'

function operation(
  patch: Partial<CommentsSendOperation> & Pick<CommentsSendOperation, 'id' | 'phase'>
): CommentsSendOperation {
  return {
    id: patch.id,
    sessionId: patch.sessionId ?? 'session-1',
    text: patch.text ?? patch.id,
    phase: patch.phase,
    destinations: patch.destinations ?? [],
    createdAt: patch.createdAt ?? '2026-07-10T00:00:00Z',
    updatedAt: patch.updatedAt ?? '2026-07-10T00:00:00Z'
  }
}

describe('reconcileCommentsSendOperation', () => {
  it('advances the same operation from sending to terminal despite an older timestamp', () => {
    const sending = operation({
      id: 'operation-1',
      phase: 'sending',
      updatedAt: '2026-07-10T00:00:02Z'
    })
    const sent = operation({
      id: 'operation-1',
      phase: 'sent',
      updatedAt: '2026-07-10T00:00:01Z'
    })
    expect(reconcileCommentsSendOperation(sending, sent)).toBe(sent)
  })

  it('never rolls a terminal operation back to sending', () => {
    const sent = operation({ id: 'operation-1', phase: 'sent' })
    const lateSending = operation({
      id: 'operation-1',
      phase: 'sending',
      updatedAt: '2099-01-01T00:00:00Z'
    })
    expect(reconcileCommentsSendOperation(sent, lateSending)).toBe(sent)
  })

  it('rejects an older different operation from the same session', () => {
    const current = operation({
      id: 'operation-2',
      phase: 'partial',
      createdAt: '2026-07-10T00:00:02Z'
    })
    const stale = operation({
      id: 'operation-1',
      phase: 'sent',
      createdAt: '2026-07-10T00:00:01Z',
      updatedAt: '2099-01-01T00:00:00Z'
    })
    expect(reconcileCommentsSendOperation(current, stale)).toBe(current)
  })

  it('accepts the newer different operation from the same session', () => {
    const current = operation({
      id: 'operation-1',
      phase: 'sent',
      createdAt: '2026-07-10T00:00:01Z'
    })
    const candidate = operation({
      id: 'operation-2',
      phase: 'sending',
      createdAt: '2026-07-10T00:00:02Z'
    })
    expect(reconcileCommentsSendOperation(current, candidate)).toBe(candidate)
  })

  it('accepts an operation from a different session', () => {
    const current = operation({ id: 'operation-1', phase: 'sent' })
    const candidate = operation({
      id: 'operation-2',
      sessionId: 'session-2',
      phase: 'sending',
      createdAt: '2020-01-01T00:00:00Z'
    })
    expect(reconcileCommentsSendOperation(current, candidate)).toBe(candidate)
  })
})

describe('detached Comments send reconciliation', () => {
  it('never lets a late transport timeout erase a recovered terminal operation', () => {
    const sending = operation({ id: 'operation-1', phase: 'sending' })
    const sent = operation({ id: 'operation-1', phase: 'sent' })

    expect(commentsSendTransportFailureCanReplace(sending, 'operation-1')).toBe(true)
    expect(commentsSendTransportFailureCanReplace(sent, 'operation-1')).toBe(false)
    expect(commentsSendOperationTerminal(sent)).toBe(true)
  })

  it('rejects a refresh commit after any newer live-chat revision', () => {
    expect(commentsRefreshRevisionIsCurrent(4, 4)).toBe(true)
    expect(commentsRefreshRevisionIsCurrent(4, 5)).toBe(false)
  })
})
