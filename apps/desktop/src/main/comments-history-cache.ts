import type { CommentsViewMode, CommentsViewSnapshot } from '../shared/backend'

type HistoryMode = Extract<CommentsViewMode, { kind: 'history' }>
export type HistoryCommentsView = CommentsViewSnapshot & { mode: HistoryMode }

export interface CommentsHistoryCacheLimits {
  maxSessions: number
  maxMessages: number
  maxBytes: number
}

interface CachedHistory {
  view: HistoryCommentsView
  messageCount: number
  bytes: number
}

const DEFAULT_LIMITS: CommentsHistoryCacheLimits = {
  maxSessions: 8,
  maxMessages: 2_000,
  maxBytes: 8 * 1024 * 1024
}

/** Owns the current Comments mode and rejects stale async selection completions. */
export class CommentsViewSelection {
  private generation = 0

  constructor(private mode: CommentsViewMode) {}

  current(): CommentsViewMode {
    return this.mode
  }

  set(mode: CommentsViewMode): void {
    this.generation += 1
    this.mode = mode
  }

  async select(
    mode: CommentsViewMode,
    prepare: () => Promise<unknown>,
    commit: () => void = () => undefined
  ): Promise<boolean> {
    const generation = ++this.generation
    await prepare()
    if (generation !== this.generation) {
      return false
    }
    commit()
    this.mode = mode
    return true
  }
}

/**
 * Prepare a history miss without mutating the LRU, then cache it atomically
 * with the winning selection. A stale load can therefore never evict the view
 * that a newer selection already committed.
 */
export async function prepareAndSelectCommentsView(
  selection: CommentsViewSelection,
  cache: CommentsHistoryCache,
  mode: CommentsViewMode,
  loadHistory: (mode: HistoryMode) => Promise<HistoryCommentsView>
): Promise<boolean> {
  let preparedHistory: HistoryCommentsView | undefined
  return selection.select(
    mode,
    async () => {
      if (mode.kind === 'history') {
        preparedHistory =
          cache.get(mode.sessionId) ?? (await cache.load(mode.sessionId, () => loadHistory(mode)))
      }
    },
    () => {
      if (mode.kind === 'history' && preparedHistory) {
        cache.put({ ...preparedHistory, mode }, mode.sessionId)
      }
    }
  )
}

/** Process-lifetime LRU for persisted comments views; SQLite remains authoritative. */
export class CommentsHistoryCache {
  private readonly entries = new Map<string, CachedHistory>()
  private readonly pendingLoads = new Map<string, Promise<HistoryCommentsView>>()
  private readonly pendingCacheLoads = new Map<string, Promise<HistoryCommentsView>>()
  private readonly limits: CommentsHistoryCacheLimits

  constructor(limits: Partial<CommentsHistoryCacheLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Comments history cache ${name} must be a positive integer.`)
      }
    }
  }

  get(sessionId: string): HistoryCommentsView | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) {
      return undefined
    }
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry.view
  }

  peek(sessionId: string): HistoryCommentsView | undefined {
    return this.entries.get(sessionId)?.view
  }

  getOrLoad(
    sessionId: string,
    load: () => Promise<HistoryCommentsView>
  ): Promise<HistoryCommentsView> {
    const cached = this.get(sessionId)
    if (cached) {
      return Promise.resolve(cached)
    }
    const pending = this.pendingCacheLoads.get(sessionId)
    if (pending) {
      return pending
    }
    const loading = this.load(sessionId, load)
      .then((view) => {
        if (this.pendingCacheLoads.get(sessionId) !== loading) {
          throw new Error('Comments history load was invalidated before completion.')
        }
        return this.put(view, sessionId)
      })
      .finally(() => {
        if (this.pendingCacheLoads.get(sessionId) === loading) {
          this.pendingCacheLoads.delete(sessionId)
        }
      })
    this.pendingCacheLoads.set(sessionId, loading)
    return loading
  }

  load(sessionId: string, load: () => Promise<HistoryCommentsView>): Promise<HistoryCommentsView> {
    const cached = this.get(sessionId)
    if (cached) {
      return Promise.resolve(cached)
    }
    const pending = this.pendingLoads.get(sessionId)
    if (pending) {
      return pending
    }
    const loading = load()
      .then((view) => {
        if (this.pendingLoads.get(sessionId) !== loading) {
          throw new Error('Comments history load was invalidated before completion.')
        }
        if (view.mode.sessionId !== sessionId) {
          throw new Error('Loaded comments history did not match the requested session.')
        }
        return view
      })
      .finally(() => {
        if (this.pendingLoads.get(sessionId) === loading) {
          this.pendingLoads.delete(sessionId)
        }
      })
    this.pendingLoads.set(sessionId, loading)
    return loading
  }

  put(view: HistoryCommentsView, protectedSessionId?: string): HistoryCommentsView {
    if (view.snapshot.sessionId !== view.mode.sessionId) {
      throw new Error('Comments history snapshot must match its view-mode session.')
    }
    const boundedView = this.boundView(view)
    const entry = cachedHistory(boundedView)
    this.entries.delete(view.mode.sessionId)
    this.entries.set(view.mode.sessionId, entry)
    this.evict(protectedSessionId)
    return boundedView
  }

  delete(sessionId: string): boolean {
    this.pendingLoads.delete(sessionId)
    this.pendingCacheLoads.delete(sessionId)
    return this.entries.delete(sessionId)
  }

  stats(): { sessions: number; messages: number; bytes: number } {
    let messages = 0
    let bytes = 0
    for (const entry of this.entries.values()) {
      messages += entry.messageCount
      bytes += entry.bytes
    }
    return { sessions: this.entries.size, messages, bytes }
  }

  private boundView(view: HistoryCommentsView): HistoryCommentsView {
    let messages = view.snapshot.messages.slice(-this.limits.maxMessages)
    let bounded = withMessages(view, messages)
    let bytes = serializedBytes(bounded)
    while (bytes > this.limits.maxBytes && messages.length > 0) {
      const removeCount = Math.max(1, Math.ceil(messages.length / 4))
      messages = messages.slice(removeCount)
      bounded = withMessages(view, messages)
      bytes = serializedBytes(bounded)
    }
    if (bytes > this.limits.maxBytes) {
      throw new Error('Comments history metadata exceeds the cache byte capacity.')
    }
    return bounded
  }

  private evict(protectedSessionId?: string): void {
    while (this.overCapacity()) {
      const candidate = [...this.entries.keys()].find(
        (sessionId) => sessionId !== protectedSessionId
      )
      if (!candidate) {
        break
      }
      this.entries.delete(candidate)
    }
  }

  private overCapacity(): boolean {
    const stats = this.stats()
    return (
      stats.sessions > this.limits.maxSessions ||
      stats.messages > this.limits.maxMessages ||
      stats.bytes > this.limits.maxBytes
    )
  }
}

function withMessages(
  view: HistoryCommentsView,
  messages: HistoryCommentsView['snapshot']['messages']
) {
  return {
    ...view,
    snapshot: {
      ...view.snapshot,
      messages,
      unreadCount: Math.min(view.snapshot.unreadCount, messages.length)
    }
  }
}

function cachedHistory(view: HistoryCommentsView): CachedHistory {
  return {
    view,
    messageCount: view.snapshot.messages.length,
    bytes: serializedBytes(view)
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
