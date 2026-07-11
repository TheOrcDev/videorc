import type {
  CommentsSnapshotDelta,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot
} from './backend'

export const MAX_COMMENTS_SNAPSHOT_MESSAGES = 500

function emptySnapshot(delta: CommentsSnapshotDelta): LiveChatSnapshot {
  const updatedAt = delta.kind === 'message' ? delta.message.receivedAt : delta.updatedAt
  return {
    sessionId: delta.sessionId,
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt
  }
}

function messageOrder(left: LiveChatMessage, right: LiveChatMessage): number {
  if (left.receivedAt !== right.receivedAt) {
    return left.receivedAt < right.receivedAt ? -1 : 1
  }
  return left.id.localeCompare(right.id)
}

export function applyCommentsSnapshotDelta(
  current: LiveChatSnapshot | null,
  delta: CommentsSnapshotDelta
): LiveChatSnapshot {
  const snapshot = current ?? emptySnapshot(delta)
  const deltaSessionId = delta.kind === 'message' ? delta.message.sessionId : delta.sessionId
  if (snapshot.sessionId && deltaSessionId && snapshot.sessionId !== deltaSessionId) {
    return snapshot
  }

  if (delta.kind === 'clear') {
    return {
      ...snapshot,
      sessionId: snapshot.sessionId ?? delta.sessionId,
      messages: [],
      unreadCount: 0,
      updatedAt: delta.updatedAt
    }
  }

  if (delta.kind === 'provider') {
    const sameProvider = (provider: LiveChatProviderState): boolean =>
      provider.id === delta.provider.id
    const providers = snapshot.providers.some(sameProvider)
      ? snapshot.providers.map((provider) => (sameProvider(provider) ? delta.provider : provider))
      : [...snapshot.providers, delta.provider]
    return {
      ...snapshot,
      sessionId: snapshot.sessionId ?? delta.sessionId,
      providers,
      updatedAt: delta.updatedAt
    }
  }

  const existingIndex = snapshot.messages.findIndex((message) => message.id === delta.message.id)
  if (existingIndex >= 0) {
    const existing = snapshot.messages[existingIndex]
    if (!delta.message.isDeleted || existing.isDeleted) return snapshot
    const messages = snapshot.messages.slice()
    messages[existingIndex] = delta.message
    return {
      ...snapshot,
      messages,
      updatedAt: delta.message.receivedAt
    }
  }
  const messages = [...snapshot.messages, delta.message].sort(messageOrder)
  return {
    ...snapshot,
    sessionId: snapshot.sessionId ?? delta.message.sessionId,
    messages:
      messages.length > MAX_COMMENTS_SNAPSHOT_MESSAGES
        ? messages.slice(messages.length - MAX_COMMENTS_SNAPSHOT_MESSAGES)
        : messages,
    updatedAt: delta.message.receivedAt
  }
}
