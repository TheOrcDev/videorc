// Pure live-chat view logic (slice 7 of the In-App Livestream Comments plan). No React, no
// DOM, no backend client — just the snapshot/event reducers, chronological ordering, platform
// filtering, and autoscroll/unread decisions the Live Chat panel renders. Kept pure so it is
// unit-testable (and so the panel component stays a thin view).

import type {
  CommentsSendOperation,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  StreamPlatform
} from '@/lib/backend'

/** Platforms that can appear in the unified feed, in display order. */
export const LIVE_CHAT_PLATFORMS: StreamPlatform[] = ['youtube', 'twitch', 'x']

/** Max persisted messages projected into the renderer at once; SQLite remains authoritative. */
export const MAX_LIVE_CHAT_VIEW_MESSAGES = 500

/**
 * Websocket messages are coalesced for one frame before touching React state. The queue is
 * deliberately much smaller than the retained view: a sustained burst flushes in chunks instead
 * of growing an unbounded side buffer or scheduling one render per message.
 */
export const MAX_PENDING_LIVE_CHAT_MESSAGES = 128
export const MAX_LIVE_CHAT_RECOVERY_ATTEMPTS = 3

export interface PendingLiveChatMessages {
  messages: LiveChatMessage[]
  overflowed: boolean
}

export class BoundedLiveChatMessageBatch {
  readonly capacity: number
  private messages: LiveChatMessage[] = []
  private messageIds = new Set<string>()
  private overflowed = false

  constructor(capacity = MAX_PENDING_LIVE_CHAT_MESSAGES) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Live chat batch capacity must be a positive integer.')
    }
    this.capacity = capacity
  }

  get size(): number {
    return this.messages.length
  }

  enqueue(message: LiveChatMessage): boolean {
    if (this.messageIds.has(message.id)) {
      const existingIndex = this.messages.findIndex((queued) => queued.id === message.id)
      const existing = this.messages[existingIndex]
      if (existingIndex >= 0 && existing && message.isDeleted && !existing.isDeleted) {
        this.messages[existingIndex] = message
        return true
      }
      return false
    }
    if (this.messages.length >= this.capacity) {
      const evicted = this.messages.shift()
      if (evicted) {
        this.messageIds.delete(evicted.id)
        this.overflowed = true
      }
    }
    this.messages.push(message)
    this.messageIds.add(message.id)
    return true
  }

  drain(): LiveChatMessage[] {
    return this.drainWithStatus().messages
  }

  drainWithStatus(): PendingLiveChatMessages {
    const pending = { messages: this.messages, overflowed: this.overflowed }
    this.messages = []
    this.messageIds.clear()
    this.overflowed = false
    return pending
  }

  clear(): void {
    this.messages = []
    this.messageIds.clear()
    this.overflowed = false
  }
}

export interface LiveChatMessageBatcherOptions {
  capacity?: number
  onFlush: (messages: LiveChatMessage[]) => void
  schedule: (flush: () => void) => () => void
}

/**
 * Coalesces notifications around the bounded queue. Scheduling is injected so the hook can use a
 * frame-sized timer while node-only tests can deterministically prove notification counts.
 */
export class LiveChatMessageBatcher {
  private readonly batch: BoundedLiveChatMessageBatch
  private readonly onFlush: (messages: LiveChatMessage[]) => void
  private readonly schedule: (flush: () => void) => () => void
  private cancelScheduledFlush: (() => void) | null = null
  private disposed = false
  private suspended = false

  constructor({ capacity, onFlush, schedule }: LiveChatMessageBatcherOptions) {
    this.batch = new BoundedLiveChatMessageBatch(capacity)
    this.onFlush = onFlush
    this.schedule = schedule
  }

  enqueue(message: LiveChatMessage): void {
    if (this.disposed || !this.batch.enqueue(message)) {
      return
    }
    if (this.suspended) {
      return
    }
    if (this.batch.size >= this.batch.capacity) {
      this.flush()
      return
    }
    if (!this.cancelScheduledFlush) {
      this.cancelScheduledFlush = this.schedule(() => {
        this.cancelScheduledFlush = null
        this.flush()
      })
    }
  }

  flush(): void {
    if (this.disposed || this.suspended) {
      return
    }
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
    const messages = this.batch.drain()
    if (messages.length > 0) {
      this.onFlush(messages)
    }
  }

  clear(): void {
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
    this.batch.clear()
  }

  suspend(): void {
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
    this.suspended = true
  }

  drainPending(): PendingLiveChatMessages {
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
    return this.batch.drainWithStatus()
  }

  resume(): void {
    if (this.disposed) return
    this.suspended = false
    if (this.batch.size >= this.batch.capacity) {
      this.flush()
    } else if (this.batch.size > 0 && !this.cancelScheduledFlush) {
      this.cancelScheduledFlush = this.schedule(() => {
        this.cancelScheduledFlush = null
        this.flush()
      })
    }
  }

  dispose(): void {
    this.clear()
    this.disposed = true
  }
}

export class LiveChatRecoveryOverflowError extends Error {
  readonly attempts: number

  constructor(attempts: number) {
    super(`Live chat recovery overflowed after ${attempts} attempts.`)
    this.name = 'LiveChatRecoveryOverflowError'
    this.attempts = attempts
  }
}

export async function runBoundedLiveChatRecovery<T>(
  attempt: (attemptNumber: number) => Promise<{ value: T; overflowed: boolean }>,
  maxAttempts = MAX_LIVE_CHAT_RECOVERY_ATTEMPTS
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Live chat recovery attempts must be a positive integer.')
  }
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const result = await attempt(attemptNumber)
    if (!result.overflowed) return result.value
  }
  throw new LiveChatRecoveryOverflowError(maxAttempts)
}

export type LiveChatSendOperationsQueryResult =
  | { ok: true; operations: CommentsSendOperation[] }
  | { ok: false }

export type LiveChatSendOperationQueryDecision =
  | { kind: 'preserve' }
  | { kind: 'replace'; operation?: CommentsSendOperation }

export function liveChatSendOperationQueryDecision({
  result,
  sessionId,
  revisionAtStart,
  currentRevision
}: {
  result: LiveChatSendOperationsQueryResult
  sessionId?: string
  revisionAtStart: number
  currentRevision: number
}): LiveChatSendOperationQueryDecision {
  if (!result.ok || revisionAtStart !== currentRevision) {
    return { kind: 'preserve' }
  }
  return {
    kind: 'replace',
    operation: sessionId
      ? result.operations.filter((operation) => operation.sessionId === sessionId).at(-1)
      : undefined
  }
}

export type LiveChatBootstrapEvent =
  | { kind: 'snapshot'; snapshot: LiveChatSnapshot }
  | { kind: 'message'; message: LiveChatMessage }
  | { kind: 'provider'; provider: LiveChatProviderState }

/** An empty snapshot for initial render / after a hard reset. */
export function emptyLiveChatSnapshot(updatedAt: string): LiveChatSnapshot {
  return { providers: [], messages: [], unreadCount: 0, updatedAt }
}

/** Chronological comparator: by `receivedAt`, then `id` as a tie-break (oldest first). */
function compareMessagesChronological(a: LiveChatMessage, b: LiveChatMessage): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** Stable chronological order: by `receivedAt`, then `id` as a tie-break (oldest first). */
export function sortMessagesChronological(messages: LiveChatMessage[]): LiveChatMessage[] {
  return [...messages].sort(compareMessagesChronological)
}

function boundMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  return messages.length > MAX_LIVE_CHAT_VIEW_MESSAGES
    ? messages.slice(messages.length - MAX_LIVE_CHAT_VIEW_MESSAGES)
    : messages
}

/** Replace the view with a full snapshot, keeping messages chronological + bounded. */
export function applyLiveChatSnapshot(snapshot: LiveChatSnapshot): LiveChatSnapshot {
  return {
    ...snapshot,
    messages: boundMessages(sortMessagesChronological(snapshot.messages))
  }
}

/** Merge one incremental message: tombstones replace originals; other duplicate ids are skipped. */
export function applyLiveChatMessage(
  snapshot: LiveChatSnapshot,
  message: LiveChatMessage
): LiveChatSnapshot {
  const existingIndex = snapshot.messages.findIndex((existing) => existing.id === message.id)
  if (existingIndex >= 0) {
    const existing = snapshot.messages[existingIndex]
    if (!message.isDeleted || existing.isDeleted) return snapshot
    const messages = snapshot.messages.slice()
    messages[existingIndex] = message
    return { ...snapshot, messages, updatedAt: message.receivedAt }
  }
  // The buffer is sorted by construction and messages almost always arrive in
  // order, so scan back from the tail for the insertion point instead of
  // re-sorting the whole buffer for every message (O(n log n) at chat rates).
  const messages = snapshot.messages.slice()
  let insertAt = messages.length
  while (insertAt > 0 && compareMessagesChronological(message, messages[insertAt - 1]) < 0) {
    insertAt -= 1
  }
  messages.splice(insertAt, 0, message)
  return { ...snapshot, messages: boundMessages(messages), updatedAt: message.receivedAt }
}

/** Update (or append) one provider's status row. */
export function applyLiveChatProviderStatus(
  snapshot: LiveChatSnapshot,
  provider: LiveChatProviderState
): LiveChatSnapshot {
  const exists = snapshot.providers.some((row) => row.id === provider.id)
  const providers = exists
    ? snapshot.providers.map((row) => (row.id === provider.id ? provider : row))
    : [...snapshot.providers, provider]
  return { ...snapshot, providers }
}

/** Replay ordered events received while the initial full snapshot was in flight. */
export function replayLiveChatBootstrapEvents(
  snapshot: LiveChatSnapshot,
  events: readonly LiveChatBootstrapEvent[]
): LiveChatSnapshot {
  return events.reduce((current, event) => {
    switch (event.kind) {
      case 'snapshot':
        return applyLiveChatSnapshot(event.snapshot)
      case 'message':
        return applyLiveChatMessage(current, event.message)
      case 'provider':
        return applyLiveChatProviderStatus(current, event.provider)
    }
  }, applyLiveChatSnapshot(snapshot))
}

/** Clear the local message view (keep providers + session); the `liveChat.cleared` reducer. */
export function applyLiveChatCleared(snapshot: LiveChatSnapshot): LiveChatSnapshot {
  return { ...snapshot, messages: [], unreadCount: 0 }
}

/** Filter messages to the enabled platforms. An empty enabled set means "show all". */
export function filterMessagesByPlatform(
  messages: LiveChatMessage[],
  enabled: ReadonlySet<StreamPlatform>
): LiveChatMessage[] {
  if (enabled.size === 0) return messages
  return messages.filter((message) => enabled.has(message.platform))
}

/**
 * Next unread count for the panel. While the feed is paused (user scrolled up), new messages
 * increment unread; when not paused they are seen immediately so unread stays 0.
 */
export function nextUnreadCount(current: number, paused: boolean, newMessages: number): number {
  if (!paused) return 0
  return current + Math.max(0, newMessages)
}

/** Whether the feed should stick to the newest message: only when not paused by the user. */
export function shouldAutoscroll(paused: boolean): boolean {
  return !paused
}

/** Max rows rendered in the feed at once (windowed/virtualized tail). */
export const MAX_RENDERED_LIVE_CHAT_MESSAGES = 200

function providerStatePriority(provider: LiveChatProviderState): number {
  if (provider.state === 'failed' || provider.read === 'failed') return 0
  if (provider.write === 'missing-scope') return 1
  if (provider.read === 'unavailable') return 2
  if (provider.state === 'unsupported') return 3
  return 4
}

function providerNeedsAction(provider: LiveChatProviderState): boolean {
  return providerStatePriority(provider) < 4
}

export type ChatSetupWarning = {
  id: string
  platform: StreamPlatform
  message: string
}

/**
 * Destinations whose comments are broken or need a reconnect — never the
 * documented receive-only/unavailable states. These warrant a go-live toast:
 * a silently empty Comments feed must never be the first (or only) signal
 * that chat setup failed (2026-07-10 live-session report).
 */
export function chatSetupToastWarnings(providers: LiveChatProviderState[]): ChatSetupWarning[] {
  return providers
    .filter((provider) => providerStatePriority(provider) <= 1)
    .map((provider) => ({
      id: provider.id,
      platform: provider.platform,
      message: provider.message || 'Live comments are unavailable for this destination.'
    }))
}

/** True when some destination's comments could be fixed by (re)connecting an account. */
export function chatNeedsConnectionAction(providers: LiveChatProviderState[]): boolean {
  return providers.some((provider) => providerStatePriority(provider) <= 2)
}

export function liveChatEmptyMessage(
  snapshot: Pick<LiveChatSnapshot, 'providers'>,
  noProviderMessage = 'Connect YouTube, Twitch, or X to read live comments.'
): string {
  if (snapshot.providers.length === 0) {
    return noProviderMessage
  }
  const provider = snapshot.providers
    .filter(providerNeedsAction)
    .sort((left, right) => providerStatePriority(left) - providerStatePriority(right))[0]
  return provider?.message ?? 'No comments yet. Comments appear here once you go live.'
}

/**
 * Apply a batch of incoming messages in a single pass (event batching): dedupe against the
 * buffer and within the batch, sort + bound once. One state update for many messages.
 */
export function applyLiveChatMessages(
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
  const messages = boundMessages(sortMessagesChronological([...byId.values()]))
  return {
    ...snapshot,
    messages,
    updatedAt: messages[messages.length - 1]?.receivedAt ?? snapshot.updatedAt
  }
}

/** Replace missed incremental belief after reconnect/lag, then merge events queued during RPC. */
export function reconcileLiveChatSnapshot(
  authoritative: LiveChatSnapshot,
  queued: LiveChatMessage[]
): LiveChatSnapshot {
  return applyLiveChatMessages(applyLiveChatSnapshot(authoritative), queued)
}

/** Recover messages missed during event lag without rolling back a newer
 * provider-status event that arrived while the authoritative RPC was in flight. */
export function reconcileLiveChatRecovery(
  authoritative: LiveChatSnapshot,
  current: LiveChatSnapshot,
  queued: LiveChatMessage[],
  preserveCurrentProviders: boolean
): LiveChatSnapshot {
  const recovered = reconcileLiveChatSnapshot(authoritative, queued)
  return preserveCurrentProviders ? { ...recovered, providers: current.providers } : recovered
}

/** The most-recent `max` messages — the rendered window for a virtualized list. */
export function visibleMessages(messages: LiveChatMessage[], max: number): LiveChatMessage[] {
  return messages.length > max ? messages.slice(messages.length - max) : messages
}
