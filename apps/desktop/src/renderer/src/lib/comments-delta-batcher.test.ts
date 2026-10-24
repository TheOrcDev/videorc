import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CommentsSnapshotDelta,
  CommentsViewSnapshot,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot
} from '@/lib/backend'
import type { ChatDelivery } from '../../../shared/chat-delivery'
import {
  MAX_COMMENTS_SNAPSHOT_MESSAGES,
  applyCommentsSnapshotDelta,
  reconcileBrokerCommentsSnapshot
} from '../../../shared/comments-snapshot-delta'
import {
  COMMENTS_DELTA_FLUSH_FALLBACK_MS,
  CommentsDeltaBatcher,
  scheduleCommentsDeltaFlush
} from './comments-delta-batcher'

const SESSION = 'live-session'
const BASE_MS = Date.parse('2026-10-24T10:00:00Z')

function message(index: number, overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  const at = new Date(BASE_MS + index * 1000).toISOString()
  return {
    id: `${SESSION}:twitch:m-${String(index).padStart(4, '0')}`,
    providerMessageId: String(index),
    platform: 'twitch',
    sessionId: SESSION,
    authorName: 'Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: at,
    receivedAt: at,
    messageText: `message ${index}`,
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

function tombstone(row: LiveChatMessage): LiveChatMessage {
  return { ...row, eventType: 'deleted', isDeleted: true, messageText: 'Message deleted' }
}

/**
 * A full live buffer whose journal admitted every row, as main relays it.
 * The oldest row was admitted last, so its journal entry outlives its row
 * when the next message trims it (the reconcile's re-add path).
 */
function fullSnapshot(): LiveChatSnapshot {
  const messages = Array.from({ length: MAX_COMMENTS_SNAPSHOT_MESSAGES }, (_, index) =>
    message(index)
  )
  const admitted = [...messages.slice(1), messages[0]]
  const delivery: ChatDelivery = {
    ownerId: 'broker-owner',
    generation: 0,
    sequence: messages.length,
    lossRevision: 0,
    entries: admitted.map((row, index) => ({
      sequence: index + 1,
      message: {
        id: row.id,
        platform: row.platform,
        eventType: row.eventType,
        authorName: row.authorName,
        messageText: row.messageText,
        isDeleted: false,
        activity: false
      }
    }))
  }
  return {
    sessionId: SESSION,
    providers: [],
    messages,
    unreadCount: 0,
    updatedAt: messages.at(-1)!.receivedAt,
    delivery
  }
}

const twitch: LiveChatProviderState = {
  id: 'twitch-main',
  platform: 'twitch',
  targetId: 'twitch-main',
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: 'Ready'
}

const live = (snapshot: LiveChatSnapshot): CommentsViewSnapshot => ({
  mode: { kind: 'live' },
  snapshot
})

/** What the window did before plan 191: each delta applied, then applyView's reconcile. */
function oneByOneThroughApplyView(
  view: CommentsViewSnapshot,
  deltas: readonly CommentsSnapshotDelta[]
): CommentsViewSnapshot {
  let current = view
  for (const delta of deltas) {
    if (current.mode.kind !== 'live') continue
    const snapshot = applyCommentsSnapshotDelta(current.snapshot, delta)
    if (snapshot === current.snapshot) continue
    current = { ...current, snapshot: reconcileBrokerCommentsSnapshot(current.snapshot, snapshot) }
  }
  return current
}

/** A batcher over one view, with a manual frame, committing the way applyView does. */
function harness(initial: CommentsViewSnapshot) {
  let view = initial
  const commits: CommentsViewSnapshot[] = []
  const frames: Array<() => void> = []
  let cancelled = 0
  const batcher = new CommentsDeltaBatcher({
    view: () => view,
    commit: (next) => {
      commits.push(next)
      view = {
        ...next,
        snapshot: reconcileBrokerCommentsSnapshot(view.snapshot, next.snapshot)
      }
    },
    schedule: (flush) => {
      frames.push(flush)
      return () => {
        cancelled += 1
      }
    }
  })
  return {
    batcher,
    commits,
    frames,
    cancelled: () => cancelled,
    view: () => view,
    setView: (next: CommentsViewSnapshot) => {
      view = next
    }
  }
}

describe('Stream Manager chat deltas, once per frame (plan 191)', () => {
  it('applies a burst in one commit that equals applying each delta on its own', () => {
    const initial = live(fullSnapshot())
    const deltas: CommentsSnapshotDelta[] = [
      { kind: 'message', message: message(2000) },
      { kind: 'message', message: message(2001) },
      // A duplicate changes nothing.
      { kind: 'message', message: message(2001) },
      { kind: 'message', message: tombstone(message(1500)) },
      // A late row lands between two older ones.
      {
        kind: 'message',
        message: message(2002, { receivedAt: new Date(BASE_MS + 1998_500).toISOString() })
      },
      { kind: 'provider', provider: twitch, sessionId: SESSION, updatedAt: '2026-10-24T11:00:00Z' },
      {
        kind: 'adopt',
        deliveryBoundary: { ownerId: 'studio-owner', generation: 0 },
        updatedAt: '2026-10-24T11:00:00Z'
      },
      { kind: 'message', message: message(2003) },
      // A tombstone for a row already trimmed from the buffer.
      { kind: 'message', message: tombstone(message(0)) },
      // Another session's row never applies.
      { kind: 'message', message: message(2004, { sessionId: 'other-session' }) }
    ]
    const { batcher, commits, frames, view } = harness(initial)

    for (const delta of deltas) batcher.push(delta)

    expect(frames).toHaveLength(1)
    expect(commits).toHaveLength(0)
    frames[0]()
    expect(commits).toHaveLength(1)
    // The batcher folds the same reducer main uses, in arrival order...
    expect(commits[0].snapshot).toEqual(deltas.reduce(applyCommentsSnapshotDelta, initial.snapshot))
    // ...and after applyView's one reconcile the window holds exactly what
    // it held when every delta rendered on its own.
    const before = oneByOneThroughApplyView(initial, deltas)
    expect(view()).toEqual(before)
    expect(view().snapshot.messages).toHaveLength(MAX_COMMENTS_SNAPSHOT_MESSAGES)
    expect(view().snapshot.messages.at(-1)?.id).toBe(message(2003).id)
    expect(view().snapshot.delivery?.sequence).toBe(MAX_COMMENTS_SNAPSHOT_MESSAGES + 4)
    // 2,000-row reconciles, replayed per delta: slow on a loaded machine.
  }, 15_000)

  it('keeps a clear inside the burst, exactly as one delta at a time', () => {
    const initial = live(fullSnapshot())
    const deltas: CommentsSnapshotDelta[] = [
      { kind: 'message', message: message(2000) },
      {
        kind: 'clear',
        sessionId: SESSION,
        updatedAt: '2026-10-24T11:00:00Z',
        deliveryBoundary: { ownerId: 'studio-owner', generation: 1 }
      },
      { kind: 'message', message: message(2001) },
      { kind: 'message', message: message(2002) }
    ]
    const { batcher, frames, view } = harness(initial)

    for (const delta of deltas) batcher.push(delta)
    frames[0]()

    expect(view()).toEqual(oneByOneThroughApplyView(initial, deltas))
    expect(view().snapshot.messages.map(({ id }) => id)).toEqual([
      message(2001).id,
      message(2002).id
    ])
    expect(view().snapshot.delivery).toMatchObject({ generation: 1, sequence: 2, cleared: true })
  }, 15_000)

  it('a full snapshot drops every delta queued before it', () => {
    const { batcher, commits, frames, cancelled, setView } = harness(live(fullSnapshot()))

    batcher.push({ kind: 'message', message: message(2000) })
    batcher.push({ kind: 'message', message: message(2001) })
    // onCommentsSnapshot: main's snapshot already holds those deltas.
    batcher.supersede()
    const replaced = live({ ...fullSnapshot(), messages: [message(5)] })
    setView(replaced)

    expect(cancelled()).toBe(1)
    // A frame that fires anyway finds nothing to apply.
    frames[0]()
    expect(commits).toHaveLength(0)

    // Deltas after the snapshot apply onto it, on their own frame.
    batcher.push({ kind: 'message', message: message(2002) })
    expect(frames).toHaveLength(2)
    frames[1]()
    expect(commits).toHaveLength(1)
    expect(commits[0].snapshot.messages.map(({ id }) => id)).toEqual([
      message(5).id,
      message(2002).id
    ])
  })

  it('drops queued live deltas when the view turned to history before the frame', () => {
    const { batcher, commits, frames, setView, view } = harness(live(fullSnapshot()))
    const history: CommentsViewSnapshot = {
      mode: {
        kind: 'history',
        sessionId: 'finished-session',
        title: 'Friday launch replay',
        startedAt: '2026-10-23T18:00:00Z'
      },
      snapshot: { ...fullSnapshot(), sessionId: 'finished-session' }
    }

    batcher.push({ kind: 'message', message: message(2000) })
    setView(history)
    frames[0]()

    expect(commits).toHaveLength(0)
    expect(view()).toBe(history)
  })

  it('commits nothing when no queued delta changed the view', () => {
    const initial = live(fullSnapshot())
    const { batcher, commits, frames, view } = harness(initial)

    batcher.push({ kind: 'message', message: message(1999) })
    batcher.push({ kind: 'message', message: message(2000, { sessionId: 'other-session' }) })
    frames[0]()

    expect(commits).toHaveLength(0)
    expect(view()).toBe(initial)
  })

  it('schedules one flush per frame and a new one after it runs', () => {
    const { batcher, commits, frames } = harness(live(fullSnapshot()))

    batcher.push({ kind: 'message', message: message(2000) })
    batcher.push({ kind: 'message', message: message(2001) })
    expect(frames).toHaveLength(1)
    frames[0]()
    batcher.push({ kind: 'message', message: message(2002) })
    expect(frames).toHaveLength(2)
    frames[1]()

    expect(commits).toHaveLength(2)
    expect(commits[1].snapshot.messages.at(-1)?.id).toBe(message(2002).id)
  })

  it('flushes queued deltas on demand, before a seed snapshot applies', () => {
    const { batcher, commits, frames, cancelled } = harness(live(fullSnapshot()))

    batcher.push({ kind: 'message', message: message(2000) })
    batcher.flush()

    expect(cancelled()).toBe(1)
    expect(commits).toHaveLength(1)
    frames[0]()
    expect(commits).toHaveLength(1)
  })

  it('applies nothing after dispose', () => {
    const { batcher, commits, frames, cancelled } = harness(live(fullSnapshot()))

    batcher.push({ kind: 'message', message: message(2000) })
    batcher.dispose()
    expect(cancelled()).toBe(1)
    frames[0]()
    batcher.push({ kind: 'message', message: message(2001) })
    batcher.flush()

    expect(frames).toHaveLength(1)
    expect(commits).toHaveLength(0)
  })
})

describe('scheduleCommentsDeltaFlush', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubFrames() {
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      next += 1
      callbacks.set(next, callback)
      return next
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    return {
      pending: () => callbacks.size,
      fire: () => {
        const due = [...callbacks.values()]
        callbacks.clear()
        for (const callback of due) callback(0)
      }
    }
  }

  it('runs at the next frame, once, and drops the fallback timer', () => {
    vi.useFakeTimers()
    const frames = stubFrames()
    const flush = vi.fn()

    scheduleCommentsDeltaFlush(flush)
    frames.fire()
    vi.advanceTimersByTime(COMMENTS_DELTA_FLUSH_FALLBACK_MS)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back to 16 ms when no frame comes, and drops the frame', () => {
    vi.useFakeTimers()
    const frames = stubFrames()
    const flush = vi.fn()

    scheduleCommentsDeltaFlush(flush)
    vi.advanceTimersByTime(COMMENTS_DELTA_FLUSH_FALLBACK_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(frames.pending()).toBe(0)
  })

  it('uses the 16 ms timer where frames do not exist', () => {
    vi.useFakeTimers()
    const flush = vi.fn()

    scheduleCommentsDeltaFlush(flush)
    vi.advanceTimersByTime(COMMENTS_DELTA_FLUSH_FALLBACK_MS)

    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('cancels both the frame and the timer', () => {
    vi.useFakeTimers()
    const frames = stubFrames()
    const flush = vi.fn()

    const cancel = scheduleCommentsDeltaFlush(flush)
    cancel()
    frames.fire()
    vi.advanceTimersByTime(COMMENTS_DELTA_FLUSH_FALLBACK_MS)

    expect(flush).not.toHaveBeenCalled()
    expect(frames.pending()).toBe(0)
  })
})
