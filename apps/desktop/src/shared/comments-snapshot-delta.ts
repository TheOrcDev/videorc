import {
  admitChatDelivery,
  adoptChatDelivery,
  hydrateChatDelivery,
  resetChatDelivery
} from './chat-delivery'
import type {
  CommentsSnapshotDelta,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot
} from './backend'

/** The Stream Manager keeps 2,000 rows; its list is virtualized (plan 055, S10). */
export const MAX_COMMENTS_SNAPSHOT_MESSAGES = 2000

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

  if (delta.kind === 'adopt')
    return { ...snapshot, delivery: adoptChatDelivery(snapshot, delta.deliveryBoundary) }

  if (delta.kind === 'clear') {
    return {
      ...snapshot,
      sessionId: snapshot.sessionId ?? delta.sessionId,
      messages: [],
      unreadCount: 0,
      delivery: resetChatDelivery(snapshot, delta.deliveryBoundary),
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
      delivery: admitChatDelivery(snapshot, [delta.message]),
      updatedAt: delta.message.receivedAt
    }
  }
  // Chat arrives in order almost always: append without re-sorting 2,000
  // rows, and sort only when a row lands out of order.
  const last = snapshot.messages.at(-1)
  const messages =
    !last || messageOrder(last, delta.message) <= 0
      ? [...snapshot.messages, delta.message]
      : [...snapshot.messages, delta.message].sort(messageOrder)
  return {
    ...snapshot,
    sessionId: snapshot.sessionId ?? delta.message.sessionId,
    messages:
      messages.length > MAX_COMMENTS_SNAPSHOT_MESSAGES
        ? messages.slice(messages.length - MAX_COMMENTS_SNAPSHOT_MESSAGES)
        : messages,
    delivery: admitChatDelivery(snapshot, [delta.message]),
    updatedAt: delta.message.receivedAt
  }
}

/** Provider snapshots are hydration into main's raw-delta owner. */
export function hydrateCommentsSnapshot(
  current: LiveChatSnapshot | null,
  incoming: LiveChatSnapshot
): LiveChatSnapshot {
  const hydrated = hydrateChatDelivery(incoming, current, { foreignSource: true })
  if (hydrated === current) return current!
  const messages = hydrated.messages
    .slice()
    .sort(messageOrder)
    .slice(-MAX_COMMENTS_SNAPSHOT_MESSAGES)
  return { ...hydrated, messages }
}
/** Broker snapshots are the detached store's authority; stale copies cannot
 * erase deltas already admitted from that same broker owner. */
export function reconcileBrokerCommentsSnapshot(
  current: LiveChatSnapshot,
  incoming: LiveChatSnapshot
): LiveChatSnapshot {
  const hydrated = hydrateChatDelivery(incoming, current, { trustOwner: true })
  if (hydrated === current) return current
  return {
    ...hydrated,
    messages: hydrated.messages.slice().sort(messageOrder).slice(-MAX_COMMENTS_SNAPSHOT_MESSAGES)
  }
}
