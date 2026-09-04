import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CommentsCommandBroker,
  commentsViewModeSenderAllowed,
  liveCommentsCommandAllowed,
  parseCommentsViewMode
} from './comments-command-broker'
import {
  COMMENTS_COMMAND_RELAY_TIMEOUT_MS,
  COMMENTS_HIGHLIGHT_RELAY_TIMEOUT_MS,
  COMMENTS_HIGHLIGHT_TIMING_CONTRACT,
  COMMENTS_SEND_TIMING_CONTRACT
} from '../shared/comments-command-timing'

afterEach(() => vi.useRealTimers())

describe('CommentsCommandBroker', () => {
  it('resolves only the matching request', async () => {
    const broker = new CommentsCommandBroker()
    const pending = broker.request<string>('request-1', () => true)
    expect(broker.resolve({ requestId: 'stale', ok: true, value: 'wrong' })).toBe(false)
    expect(broker.resolve({ requestId: 'request-1', ok: true, value: 'done' })).toBe(true)
    await expect(pending).resolves.toBe('done')
    expect(broker.pendingCount).toBe(0)
  })

  it('rejects duplicate ids without replacing the first request', async () => {
    const broker = new CommentsCommandBroker()
    const first = broker.request('request-1', () => true)
    await expect(broker.request('request-1', () => true)).rejects.toThrow(/Duplicate/)
    broker.resolve({ requestId: 'request-1', ok: true, value: 'first' })
    await expect(first).resolves.toBe('first')
  })

  it('returns unavailable when dispatch cannot reach Studio', async () => {
    const broker = new CommentsCommandBroker()
    await expect(broker.request('request-1', () => false)).rejects.toThrow(/unavailable/)
    expect(broker.pendingCount).toBe(0)
  })

  it('rejects and cleans up when command dispatch throws', async () => {
    const broker = new CommentsCommandBroker(100)

    await expect(
      broker.request('request-throw', () => {
        throw new Error('renderer destroyed')
      })
    ).rejects.toThrow('renderer destroyed')
    expect(broker.pendingCount).toBe(0)
  })

  it('times out to a terminal error', async () => {
    vi.useFakeTimers()
    const broker = new CommentsCommandBroker(50)
    const pending = broker.request('request-1', () => true)
    const rejection = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(51)
    await rejection
    expect(broker.pendingCount).toBe(0)
  })

  it('does not time out while Studio reconciles an outcome-unknown send', async () => {
    vi.useFakeTimers()
    const broker = new CommentsCommandBroker()
    const pending = broker.request('send-request-1', () => true)
    const result = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )

    // Studio can consume 12s awaiting the durable backend send, another 2s
    // reconciling an unknown outcome, and several seconds of renderer/IPC
    // scheduling margin before Main may truthfully declare it unresponsive.
    expect(COMMENTS_COMMAND_RELAY_TIMEOUT_MS).toBe(
      COMMENTS_SEND_TIMING_CONTRACT.backendRequestMs +
        COMMENTS_SEND_TIMING_CONTRACT.reconciliationMs +
        COMMENTS_SEND_TIMING_CONTRACT.rendererIpcMarginMs
    )
    await vi.advanceTimersByTimeAsync(COMMENTS_COMMAND_RELAY_TIMEOUT_MS - 1)
    expect(broker.pendingCount).toBe(1)

    expect(broker.resolve({ requestId: 'send-request-1', ok: true, value: 'sent' })).toBe(true)
    await expect(result).resolves.toEqual({ ok: true, value: 'sent' })
    expect(broker.pendingCount).toBe(0)
  })

  it('gives highlight preprocessing and backend commit their complete outer envelope', async () => {
    vi.useFakeTimers()
    const broker = new CommentsCommandBroker()
    const pending = broker.request(
      'highlight-request-1',
      () => true,
      COMMENTS_HIGHLIGHT_RELAY_TIMEOUT_MS
    )

    expect(COMMENTS_HIGHLIGHT_RELAY_TIMEOUT_MS).toBe(
      COMMENTS_HIGHLIGHT_TIMING_CONTRACT.avatarFetchMs +
        COMMENTS_HIGHLIGHT_TIMING_CONTRACT.backendQueueMaxAgeMs +
        COMMENTS_HIGHLIGHT_TIMING_CONTRACT.backendExecutionMaxMs +
        COMMENTS_HIGHLIGHT_TIMING_CONTRACT.reconciliationMs +
        COMMENTS_HIGHLIGHT_TIMING_CONTRACT.rendererIpcMarginMs
    )
    expect(COMMENTS_HIGHLIGHT_RELAY_TIMEOUT_MS).toBeGreaterThan(COMMENTS_COMMAND_RELAY_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(COMMENTS_COMMAND_RELAY_TIMEOUT_MS + 1)
    expect(broker.pendingCount).toBe(1)

    expect(
      broker.resolve({ requestId: 'highlight-request-1', ok: true, value: 'highlighted' })
    ).toBe(true)
    await expect(pending).resolves.toBe('highlighted')
  })

  it('propagates a correlated renderer/backend failure to the caller', async () => {
    const broker = new CommentsCommandBroker()
    const pending = broker.request('clear-request-1', () => true)
    expect(
      broker.resolve({
        requestId: 'clear-request-1',
        ok: false,
        error: 'Backend socket is not connected.'
      })
    ).toBe(true)
    await expect(pending).rejects.toThrow('Backend socket is not connected.')
    expect(broker.pendingCount).toBe(0)
  })

  it('rejects every in-flight command when Studio closes', async () => {
    const broker = new CommentsCommandBroker()
    const first = broker.request('request-1', () => true)
    const second = broker.request('request-2', () => true)
    broker.rejectAll()
    await expect(first).rejects.toThrow(/closed/)
    await expect(second).rejects.toThrow(/closed/)
  })
})

describe('Comments IPC authority', () => {
  it('accepts only valid runtime view modes', () => {
    expect(parseCommentsViewMode({ kind: 'live' })).toEqual({ kind: 'live' })
    expect(
      parseCommentsViewMode({
        kind: 'history',
        sessionId: 'session-1',
        title: 'Launch',
        startedAt: '2026-07-10T12:00:00Z'
      })
    ).toEqual({
      kind: 'history',
      sessionId: 'session-1',
      title: 'Launch',
      startedAt: '2026-07-10T12:00:00Z'
    })
    expect(parseCommentsViewMode(null)).toBeNull()
    expect(parseCommentsViewMode({ kind: 'history', sessionId: '' })).toBeNull()
  })

  it('lets Studio choose either mode but lets Comments only return to live', () => {
    const live = { kind: 'live' } as const
    const history = {
      kind: 'history',
      sessionId: 'session-1',
      title: 'Launch',
      startedAt: '2026-07-10T12:00:00Z'
    } as const
    expect(
      commentsViewModeSenderAllowed({
        senderId: 1,
        mainRendererId: 1,
        commentsRendererId: 2,
        mode: history
      })
    ).toBe(true)
    expect(
      commentsViewModeSenderAllowed({
        senderId: 2,
        mainRendererId: 1,
        commentsRendererId: 2,
        mode: live
      })
    ).toBe(true)
    expect(
      commentsViewModeSenderAllowed({
        senderId: 2,
        mainRendererId: 1,
        commentsRendererId: 2,
        mode: history
      })
    ).toBe(false)
    expect(
      commentsViewModeSenderAllowed({
        senderId: 3,
        mainRendererId: 1,
        commentsRendererId: 2,
        mode: live
      })
    ).toBe(false)
  })

  it('allows mutable commands only for the selected live session', () => {
    expect(
      liveCommentsCommandAllowed({
        mode: { kind: 'live' },
        liveSessionId: 'session-1',
        commandSessionId: 'session-1'
      })
    ).toBe(true)
    expect(
      liveCommentsCommandAllowed({
        mode: {
          kind: 'history',
          sessionId: 'session-1',
          title: 'Launch',
          startedAt: '2026-07-10T12:00:00Z'
        },
        liveSessionId: 'session-1',
        commandSessionId: 'session-1'
      })
    ).toBe(false)
    expect(
      liveCommentsCommandAllowed({
        mode: { kind: 'live' },
        liveSessionId: 'session-2',
        commandSessionId: 'session-1'
      })
    ).toBe(false)
  })
})
