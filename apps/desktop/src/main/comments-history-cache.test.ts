import { describe, expect, it } from 'vitest'

import type { CommentsViewSnapshot, LiveChatMessage } from '../shared/backend'
import {
  CommentsHistoryCache,
  CommentsViewSelection,
  prepareAndSelectCommentsView
} from './comments-history-cache'

function message(sessionId: string, id: string, text = id): LiveChatMessage {
  return {
    id,
    providerMessageId: id,
    platform: 'youtube',
    sessionId,
    authorName: 'Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-07-18T00:00:00.000Z',
    receivedAt: '2026-07-18T00:00:00.000Z',
    messageText: text,
    fragments: [{ type: 'text', text }],
    eventType: 'message',
    isDeleted: false
  }
}

function history(sessionId: string, messages = [message(sessionId, `${sessionId}-message`)]) {
  return {
    mode: {
      kind: 'history',
      sessionId,
      title: `Session ${sessionId}`,
      startedAt: '2026-07-18T00:00:00.000Z'
    },
    snapshot: {
      sessionId,
      providers: [],
      messages,
      unreadCount: messages.length,
      updatedAt: '2026-07-18T00:00:00.000Z'
    }
  } satisfies CommentsViewSnapshot
}

describe('CommentsHistoryCache', () => {
  it('evicts the least-recent non-current session and keeps the current history', () => {
    const cache = new CommentsHistoryCache({
      maxSessions: 2,
      maxMessages: 10,
      maxBytes: 100_000
    })
    cache.put(history('a'), 'a')
    cache.put(history('b'), 'a')
    cache.put(history('c'), 'a')

    expect(cache.peek('a')).toBeDefined()
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('c')).toBeDefined()
    expect(cache.stats()).toMatchObject({ sessions: 2, messages: 2 })
  })

  it('caps retained messages and serialized bytes', () => {
    const cache = new CommentsHistoryCache({
      maxSessions: 4,
      maxMessages: 3,
      maxBytes: 3_500
    })
    const messages = Array.from({ length: 6 }, (_, index) =>
      message('large', `message-${index}`, `payload-${index}-${'x'.repeat(700)}`)
    )

    const bounded = cache.put(history('large', messages), 'large')

    expect(bounded.snapshot.messages.length).toBeLessThanOrEqual(3)
    expect(bounded.snapshot.messages.at(-1)?.id).toBe('message-5')
    expect(cache.stats().bytes).toBeLessThanOrEqual(3_500)
  })

  it('evicts a deleted session completely', () => {
    const cache = new CommentsHistoryCache()
    cache.put(history('deleted'))

    expect(cache.delete('deleted')).toBe(true)
    expect(cache.peek('deleted')).toBeUndefined()
    expect(cache.stats()).toEqual({ sessions: 0, messages: 0, bytes: 0 })
  })

  it('reloads an evicted history on demand and coalesces concurrent misses', async () => {
    const cache = new CommentsHistoryCache({
      maxSessions: 1,
      maxMessages: 10,
      maxBytes: 100_000
    })
    cache.put(history('current'), 'current')
    let loads = 0
    const loadEvicted = async () => {
      loads += 1
      await Promise.resolve()
      return history('evicted')
    }

    const [first, second] = await Promise.all([
      cache.getOrLoad('evicted', loadEvicted),
      cache.getOrLoad('evicted', loadEvicted)
    ])

    expect(loads).toBe(1)
    expect(first).toBe(second)
    expect(cache.peek('current')).toBeUndefined()
    expect(cache.peek('evicted')).toBeDefined()

    cache.put(history('replacement'), 'replacement')
    await cache.getOrLoad('evicted', loadEvicted)

    expect(loads).toBe(2)
    expect(cache.peek('evicted')).toBeDefined()
  })

  it('invalidates an in-flight reload when the session is deleted', async () => {
    const cache = new CommentsHistoryCache()
    let resolveLoad: ((view: ReturnType<typeof history>) => void) | undefined
    const loading = cache.getOrLoad(
      'deleted',
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )

    cache.delete('deleted')
    resolveLoad?.(history('deleted'))

    await expect(loading).rejects.toThrow('invalidated')
    expect(cache.peek('deleted')).toBeUndefined()
    expect(cache.stats()).toEqual({ sessions: 0, messages: 0, bytes: 0 })
  })
})

describe('CommentsViewSelection', () => {
  it('keeps the latest cross-session intent when an older history load resolves last', async () => {
    const selection = new CommentsViewSelection({ kind: 'live' })
    let resolveFirst: (() => void) | undefined
    let resolveSecond: (() => void) | undefined

    const first = selection.select(
      history('first').mode,
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
    )
    const second = selection.select(
      history('second').mode,
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve
        })
    )

    resolveSecond?.()
    await expect(second).resolves.toBe(true)
    expect(selection.current()).toEqual(history('second').mode)

    resolveFirst?.()
    await expect(first).resolves.toBe(false)
    expect(selection.current()).toEqual(history('second').mode)
  })

  it('does not let a stale load evict the newest committed selection at capacity', async () => {
    const cache = new CommentsHistoryCache({
      maxSessions: 1,
      maxMessages: 10,
      maxBytes: 100_000
    })
    const selection = new CommentsViewSelection(history('a').mode)
    cache.put(history('a'), 'a')
    const resolvers = new Map<string, (view: ReturnType<typeof history>) => void>()
    const load = (mode: ReturnType<typeof history>['mode']) =>
      new Promise<ReturnType<typeof history>>((resolve) => {
        resolvers.set(mode.sessionId, resolve)
      })

    const selectingB = prepareAndSelectCommentsView(selection, cache, history('b').mode, load)
    const selectingC = prepareAndSelectCommentsView(selection, cache, history('c').mode, load)

    resolvers.get('c')?.(history('c'))
    await expect(selectingC).resolves.toBe(true)
    expect(selection.current()).toEqual(history('c').mode)
    expect(cache.peek('c')).toBeDefined()

    resolvers.get('b')?.(history('b'))
    await expect(selectingB).resolves.toBe(false)
    expect(selection.current()).toEqual(history('c').mode)
    expect(cache.peek('c')).toBeDefined()
    expect(cache.peek('b')).toBeUndefined()
  })
})

describe('durable History accounting', () => {
  const totals = (
    sessionId: string,
    revision: number
  ): Extract<import('../shared/backend').SessionChatTotals, { status: 'available' }> => ({
    status: 'available',
    sessionId,
    revision,
    messageCount: revision,
    chatters: revision,
    platforms: ['twitch'],
    supporters: revision,
    follows: 0,
    bits: 0,
    tips: [],
    raids: 0
  })
  const withTotals = (sessionId: string, revision: number) => ({
    ...history(sessionId),
    history: { viewers: [], audience: null, chatTotals: totals(sessionId, revision) }
  })

  it('refreshes cached History while a newer event wins over delayed hydration', async () => {
    const cache = new CommentsHistoryCache()
    cache.put(withTotals('a', 1))
    const selection = new CommentsViewSelection({ kind: 'live' })
    let resolve!: (view: ReturnType<typeof withTotals>) => void
    let loads = 0
    const choosing = prepareAndSelectCommentsView(
      selection,
      cache,
      history('a').mode,
      async () => {
        loads += 1
        return withTotals('a', 1)
      },
      async () =>
        new Promise<ReturnType<typeof withTotals>>((done) => {
          resolve = done
        })
    )
    expect(cache.updateTotals(totals('a', 8))).toBe(true)
    resolve(withTotals('a', 4))
    await expect(choosing).resolves.toBe(true)
    expect(loads).toBe(0)
    expect(cache.peek('a')?.history?.chatTotals).toEqual(totals('a', 8))
    await prepareAndSelectCommentsView(
      selection,
      cache,
      history('a').mode,
      async () => withTotals('a', 1),
      async () => withTotals('a', 9)
    )
    expect(cache.peek('a')?.history?.chatTotals).toEqual(totals('a', 9))
    cache.updateTotals(totals('a', 2))
    expect(cache.peek('a')?.history?.chatTotals).toEqual(totals('a', 9))
  })

  it('rejects failed and stale cached refresh selections without replacing current history', async () => {
    const cache = new CommentsHistoryCache()
    cache.put(withTotals('a', 1))
    cache.put(withTotals('b', 2))
    const selection = new CommentsViewSelection(history('b').mode)
    let resolve!: (view: ReturnType<typeof withTotals>) => void
    const first = prepareAndSelectCommentsView(
      selection,
      cache,
      history('a').mode,
      async () => withTotals('a', 1),
      async () =>
        new Promise<ReturnType<typeof withTotals>>((done) => {
          resolve = done
        })
    )
    await prepareAndSelectCommentsView(
      selection,
      cache,
      history('b').mode,
      async () => withTotals('b', 2),
      async () => withTotals('b', 3)
    )
    resolve(withTotals('a', 9))
    await expect(first).resolves.toBe(false)
    expect(selection.current()).toEqual(history('b').mode)
    expect(cache.peek('a')?.history?.chatTotals).toEqual(totals('a', 1))
    await expect(
      prepareAndSelectCommentsView(
        selection,
        cache,
        history('a').mode,
        async () => withTotals('a', 1),
        async () => {
          throw new Error('Unavailable')
        }
      )
    ).rejects.toThrow('Unavailable')
    expect(selection.current()).toEqual(history('b').mode)
    expect(cache.updateTotals(totals('uncached', 1))).toBe(false)
    expect(cache.stats().sessions).toBe(2)
  })

  it('rejects totals with a foreign owner or invalid accounting facts before caching', () => {
    const cache = new CommentsHistoryCache()
    const view = withTotals('a', 1)
    expect(() =>
      cache.put({ ...view, history: { ...view.history, chatTotals: totals('b', 1) } })
    ).toThrow('match')
    expect(() =>
      cache.put({
        ...view,
        history: { ...view.history, chatTotals: { ...totals('a', 1), revision: Infinity } }
      })
    ).toThrow()
    expect(cache.stats().sessions).toBe(0)
  })
})
