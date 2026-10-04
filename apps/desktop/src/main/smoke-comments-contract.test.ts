import { once } from 'node:events'
import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import type { CommentsSendOperation, LiveChatSnapshot } from '../shared/backend'
import {
  PACKAGED_SMOKE_COMMAND_NAMES,
  createSmokeCommandCapability,
  handleSmokeCommandRequest,
  validateSmokeCommandPayload
} from './smoke-command-security'

const snapshot = (count = 0): LiveChatSnapshot => ({
  sessionId: 'comments-contract',
  providers: [],
  messages: Array.from({ length: count }, (_, index) => ({
    id: `comments-contract:twitch:${index}`,
    providerMessageId: String(index),
    sessionId: 'comments-contract',
    platform: 'twitch',
    authorName: 'Fixture Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-04T00:00:00.000Z',
    receivedAt: '2026-10-04T00:00:00.000Z',
    messageText: 'Equal-height fixture',
    fragments: [],
    eventType: 'message',
    isDeleted: false
  })),
  unreadCount: 0,
  updatedAt: '2026-10-04T00:00:00.000Z',
  delivery: { ownerId: 'fixture-publisher', generation: 0, sequence: 0, entries: [] }
})

const operation = (): CommentsSendOperation => ({
  id: 'fixture-send',
  sessionId: 'comments-contract',
  text: 'Fixture reply',
  phase: 'sent',
  destinations: [{ destinationId: 'fixture-twitch', platform: 'twitch', phase: 'sent' }],
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:01.000Z'
})

const adoption = () => ({
  delta: {
    kind: 'adopt',
    deliveryBoundary: { ownerId: 'fixture-publisher', generation: 0 },
    updatedAt: '2026-10-04T00:00:00.000Z'
  }
})

async function bounded<T>(pending: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded deadline`)), 2_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type Route = (command: string, params: Record<string, unknown>) => Promise<unknown>

async function httpFixture(
  check: (fixture: {
    post: (command: string, params?: unknown, authorized?: boolean) => Promise<Response>
    command: (command: string, params?: Record<string, unknown>) => Promise<unknown>
    calls: Array<{ command: string; params: Record<string, unknown> }>
  }) => Promise<void>,
  options: { allowedCommands?: ReadonlySet<string>; route?: Route } = {}
): Promise<void> {
  const capability = createSmokeCommandCapability()
  const calls: Array<{ command: string; params: Record<string, unknown> }> = []
  const server = createServer((request, response) => {
    void handleSmokeCommandRequest(request, response, {
      capability,
      allowedCommands: options.allowedCommands,
      runCommand: async (command, params) => {
        calls.push({ command, params })
        return options.route ? options.route(command, params) : { accepted: true }
      }
    })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  try {
    await bounded(listening, 'HTTP fixture readiness')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address')
    const post = (command: string, params: unknown = {}, authorized = true) =>
      fetch(`http://127.0.0.1:${address.port}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { Authorization: `Bearer ${capability}` } : {})
        },
        body: JSON.stringify({ command, params }),
        signal: AbortSignal.timeout(2_000)
      })
    await check({
      post,
      calls,
      command: async (command, params = {}) => {
        const response = await post(command, params)
        if (!response.ok) {
          await response.arrayBuffer()
          throw new Error(`${command} rejected with HTTP ${response.status}`)
        }
        return (await response.json()).result
      }
    })
  } finally {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await bounded(closed, 'Owned HTTP fixture cleanup')
  }
}

const observeOnce = async (
  read: () => Promise<unknown>,
  predicate: (value: unknown) => boolean,
  deadline: number
) => {
  expect(deadline).toBe(8_000)
  const last = await read()
  return { ok: predicate(last), last }
}

const requireObservation = (ok: boolean, label: string) => {
  if (!ok) throw new Error(`Missing fixture observation: ${label}`)
}

describe('maintained Comments probe HTTP contract', () => {
  it('routes the actual arrival helper adoption, full hydration, rollover and reopen commands', async () => {
    const { probeCommentsArrivals } = await import(
      new URL('../../../../scripts/lib/comments-arrival-probe.mjs', import.meta.url).href
    )
    const id = (index: number) => `comments-contract:twitch:rollover-${index}`
    const observations = [
      { lastMessageId: id(1999), chatAtBottom: true },
      ...[2000, 2001, 2002].map((index) => ({ lastMessageId: id(index), chatAtBottom: true })),
      { pausedChat: '3 new ↓' },
      { pausedChat: null, lastMessageId: id(2005), chatAtBottom: true },
      { pausedChat: null, lastMessageId: id(2005), chatAtBottom: true }
    ]
    await httpFixture(
      async ({ command, calls }) => {
        await probeCommentsArrivals({
          command,
          waitFor: observeOnce,
          assert: requireObservation,
          sessionId: 'comments-contract'
        })
        expect(calls.filter((call) => call.command === 'comments-window-push-delta')).toHaveLength(
          7
        )
        const hydrations = calls.filter((call) => call.command === 'comments-window-push-snapshot')
        expect(hydrations).toHaveLength(2)
        expect((hydrations[0].params.snapshot as LiveChatSnapshot).messages).toHaveLength(2000)
      },
      {
        route: async (command, params) =>
          command === 'comments-window-reader-state' && !params.chatAction
            ? observations.shift()
            : { accepted: true }
      }
    )
  })

  it('routes the actual totals helper through live, reopen and complete History selection', async () => {
    const { probeCommentsTotals } = await import(
      new URL('../../../../scripts/lib/comments-totals-probe.mjs', import.meta.url).href
    )
    let history = false
    await httpFixture(
      async ({ command, calls }) => {
        await probeCommentsTotals({
          command,
          waitFor: observeOnce,
          assert: requireObservation,
          sessionId: 'comments-contract',
          layoutAt: async (width: number) => {
            await command('comments-window-set-bounds', { width, height: 640 })
            return command('comments-window-layout-metrics')
          }
        })
        expect(
          calls.filter((call) => call.command === 'comments-window-push-snapshot')
        ).toHaveLength(2)
        expect(history).toBe(true)
      },
      {
        route: async (command, params) => {
          if (
            command === 'comments-window-push-snapshot' &&
            (params.mode as { kind?: string })?.kind === 'history'
          )
            history = true
          return command === 'comments-window-layout-metrics'
            ? {
                stats: [
                  { id: 'supporters', text: '1' },
                  { id: 'tips', text: '$20' },
                  { id: 'chat', text: history ? '6,003' : '0' }
                ]
              }
            : { accepted: true }
        }
      }
    )
  })

  it('independently accepts valid 2,000-message hydration below the unchanged body limit', async () => {
    await httpFixture(async ({ post, calls }) => {
      const params = { snapshot: snapshot(2000) }
      expect(Buffer.byteLength(JSON.stringify(params))).toBeLessThan(1024 * 1024)
      const response = await post('comments-window-push-snapshot', params)
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      expect(calls).toHaveLength(1)
    })
  })

  it('preserves complete History mode and a valid same-session send receipt', async () => {
    await httpFixture(async ({ post, calls }) => {
      const mode = {
        kind: 'history',
        sessionId: 'comments-contract',
        title: 'Fixture History',
        startedAt: '2026-10-04T00:00:00.000Z'
      }
      const response = await post('comments-window-push-snapshot', {
        snapshot: snapshot(),
        mode,
        latestSendOperation: operation()
      })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      expect(calls[0].params.mode).toEqual(mode)
      expect(calls[0].params.latestSendOperation).toEqual(operation())
    })
  })

  it('preserves idle and History hydration without a snapshot session ID', async () => {
    await httpFixture(async ({ post, calls }) => {
      const idle = snapshot()
      delete idle.sessionId
      for (const params of [
        { snapshot: idle },
        {
          snapshot: idle,
          mode: {
            kind: 'history',
            sessionId: 'comments-contract',
            title: 'Fixture History',
            startedAt: '2026-10-04T00:00:00.000Z'
          },
          latestSendOperation: operation()
        }
      ]) {
        const response = await post('comments-window-push-snapshot', params)
        expect(response.status).toBe(200)
        await response.arrayBuffer()
      }
      expect(calls).toHaveLength(2)
    })
  })

  it('preserves every valid send and destination outcome in existing receipt unions', async () => {
    await httpFixture(async ({ post, calls }) => {
      const phases = ['sending', 'sent', 'partial', 'failed', 'delivery-unknown']
      for (const phase of phases) {
        const latestSendOperation = {
          ...operation(),
          phase,
          destinations: [
            'pending',
            'sent',
            'failed',
            'read-only',
            'unavailable',
            'timed-out-unknown'
          ].map((phase, index) => ({
            destinationId: `fixture-${index}`,
            platform: 'twitch',
            phase,
            providerMessageId: 'fixture',
            reason: 'Fixture outcome'
          }))
        }
        const response = await post('comments-window-push-snapshot', {
          snapshot: snapshot(),
          latestSendOperation
        })
        expect(response.status).toBe(200)
        await response.arrayBuffer()
      }
      expect(calls).toHaveLength(phases.length)
    })
  })

  it.each(['comments-window-push-delta', 'comments-window-push-snapshot'])(
    'refuses unauthenticated %s before routing',
    async (command) => {
      await httpFixture(async ({ post, calls }) => {
        const response = await post(
          command,
          command.endsWith('delta') ? adoption() : { snapshot: snapshot(2000) },
          false
        )
        expect(response.status).toBe(401)
        await response.arrayBuffer()
        expect(calls).toHaveLength(0)
      })
    }
  )

  it.each(['comments-window-push-delta', 'comments-window-push-snapshot'])(
    'keeps %s outside the packaged command subset',
    async (command) => {
      await httpFixture(
        async ({ post, calls }) => {
          const response = await post(
            command,
            command.endsWith('delta') ? adoption() : { snapshot: snapshot() }
          )
          expect(response.status).toBe(403)
          await response.arrayBuffer()
          expect(calls).toHaveLength(0)
        },
        { allowedCommands: PACKAGED_SMOKE_COMMAND_NAMES }
      )
    }
  )

  const malformedSnapshots: Array<[string, () => Record<string, unknown>]> = [
    ['over 2,000 messages', () => ({ snapshot: snapshot(2001) })],
    ['unknown envelope field', () => ({ snapshot: snapshot(), unexpected: true })],
    ['null snapshot', () => ({ snapshot: null })],
    ['invalid provider array', () => ({ snapshot: { ...snapshot(), providers: null } })],
    ['invalid message array', () => ({ snapshot: { ...snapshot(), messages: {} } })],
    ['invalid unread count', () => ({ snapshot: { ...snapshot(), unreadCount: -1 } })],
    ['invalid update timestamp type', () => ({ snapshot: { ...snapshot(), updatedAt: 7 } })],
    [
      'invalid delivery owner',
      () => ({ snapshot: { ...snapshot(), delivery: { ...snapshot().delivery, ownerId: '' } } })
    ],
    [
      'incomplete History selection',
      () => ({ snapshot: snapshot(), mode: { kind: 'history', sessionId: 'comments-contract' } })
    ],
    [
      'different History session',
      () => ({
        snapshot: snapshot(),
        mode: {
          kind: 'history',
          sessionId: 'another-session',
          title: 'Fixture',
          startedAt: '2026-10-04T00:00:00.000Z'
        }
      })
    ],
    ['unknown mode', () => ({ snapshot: snapshot(), mode: { kind: 'untrusted' } })],
    [
      'invalid send phase',
      () => ({ snapshot: snapshot(), latestSendOperation: { ...operation(), phase: 'untrusted' } })
    ],
    [
      'different send session',
      () => ({
        snapshot: snapshot(),
        latestSendOperation: { ...operation(), sessionId: 'another-session' }
      })
    ],
    [
      'invalid send destination phase',
      () => ({
        snapshot: snapshot(),
        latestSendOperation: {
          ...operation(),
          destinations: [{ destinationId: 'fixture', platform: 'twitch', phase: 'untrusted' }]
        }
      })
    ],
    [
      'unsafe field name',
      () =>
        JSON.parse(
          '{"snapshot":{"providers":[],"messages":[],"unreadCount":0,"updatedAt":"now"},"constructor":{}}'
        )
    ],
    [
      'excessive depth',
      () => ({
        snapshot: {
          ...snapshot(),
          extra: Array.from({ length: 10 }).reduce<unknown>((nested) => ({ nested }), null)
        }
      })
    ]
  ]
  it.each(malformedSnapshots)('rejects %s before the snapshot handler', async (_label, params) => {
    await httpFixture(async ({ post, calls }) => {
      const response = await post('comments-window-push-snapshot', params())
      expect(response.status).toBe(400)
      await response.arrayBuffer()
      expect(calls).toHaveLength(0)
    })
  })

  it.each([
    ['unknown envelope field', () => ({ ...adoption(), unexpected: true })],
    [
      'invalid adoption owner',
      () => ({ delta: { ...adoption().delta, deliveryBoundary: { ownerId: '', generation: 0 } } })
    ],
    [
      'invalid adoption generation',
      () => ({
        delta: { ...adoption().delta, deliveryBoundary: { ownerId: 'fixture', generation: -1 } }
      })
    ],
    ['unknown delta kind', () => ({ delta: { kind: 'untrusted' } })]
  ] as const)('rejects %s before the delta handler', async (_label, params) => {
    await httpFixture(async ({ post, calls }) => {
      const response = await post('comments-window-push-delta', params())
      expect(response.status).toBe(400)
      await response.arrayBuffer()
      expect(calls).toHaveLength(0)
    })
  })

  it('keeps the generic parameter budget and depth unchanged', async () => {
    await httpFixture(async ({ post, calls }) => {
      const response = await post('open-tab', { items: Array(2001).fill(0) })
      expect(response.status).toBe(400)
      await response.arrayBuffer()
      expect(calls).toHaveLength(0)
    })
    expect(
      validateSmokeCommandPayload({
        command: 'comments-window-push-snapshot',
        params: Object.create({ snapshot: snapshot() })
      })
    ).toBeNull()
  })

  it('retains the 1 MiB HTTP body ceiling before any route executes', async () => {
    await httpFixture(async ({ post, calls }) => {
      const response = await post('comments-window-push-snapshot', {
        snapshot: snapshot(),
        extra: 'x'.repeat(1024 * 1024)
      })
      expect(response.status).toBe(413)
      await response.arrayBuffer()
      expect(calls).toHaveLength(0)
    })
  })
})
