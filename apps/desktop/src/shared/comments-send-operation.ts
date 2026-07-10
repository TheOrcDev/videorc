import type { CommentsSendOperation } from './backend'

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function commentsSendOperationTerminal(operation: CommentsSendOperation): boolean {
  return operation.phase !== 'sending'
}

export function commentsSendTransportFailureCanReplace(
  current: CommentsSendOperation | null,
  operationId: string
): boolean {
  return current?.id === operationId && !commentsSendOperationTerminal(current)
}

export function commentsRefreshRevisionIsCurrent(expected: number, current: number): boolean {
  return expected === current
}

/** Keep the newest operation for a Comments session without allowing delayed
 * events to roll a terminal receipt back to `sending`. The same operation id
 * may always advance from sending to a terminal phase, even when a provider
 * reuses an older timestamp in its completion event. */
export function reconcileCommentsSendOperation(
  current: CommentsSendOperation | undefined,
  candidate: CommentsSendOperation
): CommentsSendOperation {
  if (!current || current.sessionId !== candidate.sessionId) return candidate

  if (current.id === candidate.id) {
    if (!commentsSendOperationTerminal(current) && commentsSendOperationTerminal(candidate)) {
      return candidate
    }
    if (commentsSendOperationTerminal(current) && !commentsSendOperationTerminal(candidate)) {
      return current
    }
    const updatedDifference = timestamp(candidate.updatedAt) - timestamp(current.updatedAt)
    return updatedDifference < 0 ? current : candidate
  }

  const createdDifference = timestamp(candidate.createdAt) - timestamp(current.createdAt)
  if (createdDifference !== 0) return createdDifference > 0 ? candidate : current
  const updatedDifference = timestamp(candidate.updatedAt) - timestamp(current.updatedAt)
  return updatedDifference > 0 ? candidate : current
}
