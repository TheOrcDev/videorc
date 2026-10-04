import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CommentsCommandResolution,
  CommentsModerationCommand,
  CommentsWindowState,
  ModerationOperation
} from './backend'
import {
  commentsWindowShowsRemovalCards,
  removalToastId,
  startChatModerationRelay,
  type RemovalToastSurface
} from './chat-moderation-relay'

const OPERATION_ID = '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f'

function operation(patch: Partial<ModerationOperation> = {}): ModerationOperation {
  return {
    operationId: OPERATION_ID,
    sessionId: 'session-1',
    messageId: 'session-1:twitch:default:m-1',
    platform: 'twitch',
    authorName: 'coders_x',
    excerpt: 'this stream is trash',
    source: 'orcle-voice',
    phase: 'pending-confirm',
    confirmMode: 'confirm',
    requiresExplicitConfirm: true,
    confirmBy: '2026-10-04T12:00:28Z',
    createdAt: '2026-10-04T12:00:08Z',
    updatedAt: '2026-10-04T12:00:08Z',
    ...patch
  }
}

type Handler = (method: string, params: unknown) => Promise<unknown>

function harness({
  sessionId = 'session-1',
  listed = [] as ModerationOperation[] | (() => ModerationOperation[]),
  handler = (async () => {
    throw new Error('unexpected request')
  }) as Handler,
  window: windowState = { open: false, visible: false } as Pick<
    CommentsWindowState,
    'open' | 'visible'
  >
} = {}) {
  const calls: { method: string; params: unknown }[] = []
  const requestTyped = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params })
    if (method === 'liveChat.moderationOperations.list') {
      return typeof listed === 'function' ? listed() : listed
    }
    return handler(method, params)
  })
  const published: ModerationOperation[][] = []
  const pushed: CommentsCommandResolution<ModerationOperation>[] = []
  let onRequest: ((command: CommentsModerationCommand) => void) | null = null
  let onWindow: ((state: CommentsWindowState) => void) | null = null
  const surface = {
    show: vi.fn(),
    dismiss: vi.fn(),
    outcome: vi.fn(),
    error: vi.fn()
  } satisfies RemovalToastSurface
  let currentSession: string | null = sessionId
  const relay = startChatModerationRelay({
    client: { requestTyped } as never,
    sessionId: () => currentSession,
    publish: (operations) => published.push(operations),
    api: {
      onModerationRequest: (callback) => {
        onRequest = callback
        return () => {
          onRequest = null
        }
      },
      pushModerationResult: async (resolution) => {
        pushed.push(resolution)
        return true
      },
      getCommentsWindowState: async () => windowState as CommentsWindowState,
      onCommentsWindowState: (callback) => {
        onWindow = callback
        return () => {
          onWindow = null
        }
      }
    },
    surface,
    now: () => Date.parse('2026-10-04T12:00:10Z'),
    schedule: (run) => run()
  })
  return {
    relay,
    calls,
    published,
    pushed,
    surface,
    setSession: (next: string | null) => {
      currentSession = next
    },
    request: async (command: CommentsModerationCommand) => {
      onRequest?.(command)
      await vi.waitFor(() =>
        expect(pushed.some((entry) => entry.requestId === command.requestId)).toBe(true)
      )
      return pushed.find((entry) => entry.requestId === command.requestId)!
    },
    window: (state: Pick<CommentsWindowState, 'open' | 'visible'>) =>
      onWindow?.(state as CommentsWindowState),
    subscribed: () => onRequest !== null
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chat moderation relay: the ledger (plan 140, S6)', () => {
  it('seeds the session from the backend list and publishes it', async () => {
    const seeded = operation({ phase: 'removed' })
    const test = harness({ listed: [seeded] })
    await flush()
    expect(test.calls[0]).toEqual({
      method: 'liveChat.moderationOperations.list',
      params: { sessionId: 'session-1' }
    })
    expect(test.published.at(-1)).toEqual([seeded])
  })

  it('folds events in, newest state wins, and ignores another session', async () => {
    const test = harness()
    await flush()
    test.relay.feed(operation({ phase: 'executing', updatedAt: '2026-10-04T12:00:09Z' }))
    test.relay.feed(operation({ sessionId: 'session-2', operationId: 'other' }))
    test.relay.feed(operation({ phase: 'removed', updatedAt: '2026-10-04T12:00:10Z' }))
    test.relay.feed(operation({ phase: 'executing', updatedAt: '2026-10-04T12:00:11Z' }))
    expect(test.published.at(-1)?.map((entry) => entry.phase)).toEqual(['removed'])
  })

  it('starts over for a new session and publishes an empty list when it ends', async () => {
    const test = harness({ listed: [operation({ phase: 'removed' })] })
    await flush()
    test.setSession(null)
    test.relay.session(null)
    expect(test.published.at(-1)).toEqual([])
  })
})

describe('chat moderation relay: the Stream Manager commands', () => {
  it('sends Remove from chat as manual, whatever asked, and replies with the operation', async () => {
    const removed = operation({
      source: 'manual',
      phase: 'removed',
      outcome: 'Removed from Twitch.'
    })
    const test = harness({ handler: async () => removed })
    await flush()
    const reply = await test.request({
      requestId: 'r-1',
      sessionId: 'session-1',
      action: 'remove',
      operationId: OPERATION_ID,
      messageId: 'session-1:twitch:default:m-1'
    })
    expect(test.calls.find((call) => call.method === 'liveChat.moderation.request')).toEqual({
      method: 'liveChat.moderation.request',
      params: {
        operationId: OPERATION_ID,
        messageId: 'session-1:twitch:default:m-1',
        source: 'manual'
      }
    })
    expect(reply).toEqual({ requestId: 'r-1', ok: true, value: removed })
    expect(test.published.at(-1)).toEqual([removed])
  })

  it('answers a card with confirm or cancel', async () => {
    const cancelled = operation({ phase: 'cancelled' })
    const test = harness({ handler: async () => cancelled })
    await flush()
    await test.request({
      requestId: 'r-2',
      sessionId: 'session-1',
      action: 'cancel',
      operationId: OPERATION_ID
    })
    expect(test.calls.map((call) => call.method)).toContain('liveChat.moderation.cancel')
  })

  it('refuses a command for a session that is no longer live', async () => {
    const test = harness()
    await flush()
    const reply = await test.request({
      requestId: 'r-3',
      sessionId: 'session-old',
      action: 'remove',
      operationId: OPERATION_ID,
      messageId: 'm'
    })
    expect(reply).toMatchObject({
      ok: false,
      error: 'That chat view is no longer the active livestream.'
    })
    expect(test.calls.map((call) => call.method)).not.toContain('liveChat.moderation.request')
  })

  it('says why a removal was refused, and trusts the ledger after a lost reply', async () => {
    const refused = harness({
      handler: async () => {
        throw new Error('At most 10 messages can be removed per minute.')
      }
    })
    await flush()
    expect(
      await refused.request({
        requestId: 'r-4',
        sessionId: 'session-1',
        action: 'remove',
        operationId: OPERATION_ID,
        messageId: 'm'
      })
    ).toMatchObject({ ok: false, error: 'At most 10 messages can be removed per minute.' })

    // The request landed, but its reply was lost: the ledger has it.
    const landed = operation({ source: 'manual', phase: 'executing' })
    let ledger: ModerationOperation[] = []
    const lost = harness({
      listed: () => ledger,
      handler: async () => {
        ledger = [landed]
        throw new Error('Backend request "liveChat.moderation.request" timed out.')
      }
    })
    await flush()
    expect(
      await lost.request({
        requestId: 'r-5',
        sessionId: 'session-1',
        action: 'remove',
        operationId: OPERATION_ID,
        messageId: 'm'
      })
    ).toEqual({ requestId: 'r-5', ok: true, value: landed })
  })

  it('keeps a refused answer an error while the card is still open', async () => {
    const test = harness({
      listed: () => [operation()],
      handler: async () => {
        throw new Error('Backend WebSocket is not connected.')
      }
    })
    await flush()
    expect(
      await test.request({
        requestId: 'r-6',
        sessionId: 'session-1',
        action: 'confirm',
        operationId: OPERATION_ID
      })
    ).toMatchObject({ ok: false, error: 'Backend WebSocket is not connected.' })
  })

  it('stops listening when disposed', async () => {
    const test = harness()
    await flush()
    expect(test.subscribed()).toBe(true)
    test.relay.dispose()
    expect(test.subscribed()).toBe(false)
  })
})

describe('chat moderation relay: the main-window toast', () => {
  it('mirrors an open card only while the Stream Manager cannot show it', async () => {
    expect(commentsWindowShowsRemovalCards({ open: true, visible: true })).toBe(true)
    expect(commentsWindowShowsRemovalCards({ open: true, visible: false })).toBe(false)
    expect(commentsWindowShowsRemovalCards(null)).toBe(false)

    const test = harness()
    await flush()
    test.relay.feed(operation())
    const id = removalToastId(OPERATION_ID)
    expect(test.surface.show).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ title: "Remove coders_x's message?" }),
      expect.any(Function)
    )
    // The Stream Manager comes up: its card takes over.
    test.window({ open: true, visible: true })
    expect(test.surface.dismiss).toHaveBeenCalledWith(id)
    test.relay.dispose()
  })

  it('never toasts while the Stream Manager is on screen', async () => {
    const test = harness({ window: { open: true, visible: true } })
    await flush()
    test.relay.feed(operation())
    expect(test.surface.show).not.toHaveBeenCalled()
    test.relay.dispose()
  })

  it('answers from the toast, then says how it ended and leaves', async () => {
    const executing = operation({ phase: 'executing', updatedAt: '2026-10-04T12:00:09Z' })
    const test = harness({ handler: async () => executing })
    await flush()
    test.relay.feed(operation())
    const answer = test.surface.show.mock.calls[0][2] as (value: 'confirm' | 'cancel') => void
    answer('confirm')
    // Before the backend moves it, the card is still open: the answered
    // toast is neither shown again nor forgotten.
    test.surface.show.mockClear()
    test.relay.feed(operation({ updatedAt: '2026-10-04T12:00:09Z' }))
    expect(test.surface.show).not.toHaveBeenCalled()
    expect(test.surface.dismiss).not.toHaveBeenCalled()
    await flush()
    expect(test.calls.map((call) => call.method)).toContain('liveChat.moderation.confirm')
    test.relay.feed(
      operation({
        phase: 'hidden-locally',
        outcome: 'Hidden in Videorc. Viewers on Twitch still see it.',
        updatedAt: '2026-10-04T12:00:12Z'
      })
    )
    expect(test.surface.dismiss).toHaveBeenCalledWith(removalToastId(OPERATION_ID))
    expect(test.surface.outcome).toHaveBeenCalledWith(removalToastId(OPERATION_ID, 'outcome'), {
      kind: 'warning',
      text: 'Hidden in Videorc. Viewers on Twitch still see it.'
    })
    test.relay.dispose()
  })

  it('says nothing more when the streamer cancelled', async () => {
    const test = harness()
    await flush()
    test.relay.feed(operation())
    test.relay.feed(
      operation({
        phase: 'cancelled',
        outcome: 'Cancelled. Nothing was removed.',
        updatedAt: '2026-10-04T12:00:12Z'
      })
    )
    expect(test.surface.dismiss).toHaveBeenCalledWith(removalToastId(OPERATION_ID))
    expect(test.surface.outcome).not.toHaveBeenCalled()
    test.relay.dispose()
  })
})
