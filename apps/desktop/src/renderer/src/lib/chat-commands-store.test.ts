import { describe, expect, it, vi } from 'vitest'

import type {
  ChatCommand,
  ChatCommandReplyFailed,
  ChatCommandsState
} from '../../../shared/chat-commands'
import {
  CHAT_COMMAND_FAILURES_MAX,
  createChatCommandsStore,
  nextChatCommandFailures,
  type ChatCommandsClient
} from './chat-commands-store'

// Plan 226 S3: the list Studio reads on each connection, kept current by
// `chatCommands.changed`, and the replies that couldn't go out, one per chat
// and reason in the newest live chat session.

function command(name: string, enabled = true): ChatCommand {
  return {
    id: `id-${name}`,
    name,
    description: `about ${name}`,
    reply: `reply for ${name}`,
    enabled,
    createdAt: '2026-11-10T18:00:00Z',
    updatedAt: '2026-11-10T18:00:00Z'
  }
}

function fakeClient(list: () => Promise<ChatCommandsState>) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const requestTyped = vi.fn((method: string) =>
    method === 'chatCommands.list' ? list() : Promise.reject(new Error(method))
  )
  const client = {
    requestTyped,
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    }
  }
  return {
    client: client as unknown as ChatCommandsClient,
    requestTyped,
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    listeners: (event: string) => handlers.get(event)?.size ?? 0
  }
}

const failure = (overrides: Partial<ChatCommandReplyFailed> = {}): ChatCommandReplyFailed => ({
  sessionId: 's1',
  destinationId: 'youtube-main',
  platform: 'youtube',
  command: 'go',
  reason: 'reconnect YouTube to allow chat posts.',
  ...overrides
})

describe('chat commands store (plan 226 S3)', () => {
  it('reads the list on a connection and follows chatCommands.changed', async () => {
    const store = createChatCommandsStore()
    const state = { commands: [command('go')], listEnabled: true }
    const backend = fakeClient(async () => state)
    expect(store.getSnapshot()).toMatchObject({ state: null, online: false })
    store.connect(backend.client)
    expect(store.getSnapshot().online).toBe(true)
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe(state))
    const next = { commands: [command('faq'), command('go')], listEnabled: false }
    backend.emit('chatCommands.changed', next)
    expect(store.getSnapshot().state).toBe(next)
  })

  it('never lets a list answer older than a change win', async () => {
    const store = createChatCommandsStore()
    let answer: (state: ChatCommandsState) => void = () => undefined
    const backend = fakeClient(() => new Promise((resolve) => (answer = resolve)))
    store.connect(backend.client)
    const changed = { commands: [command('go')], listEnabled: true }
    backend.emit('chatCommands.changed', changed)
    answer({ commands: [], listEnabled: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().state).toBe(changed)
  })

  it('goes offline when the connection closes, keeps the list, and reads again on the next', async () => {
    const store = createChatCommandsStore()
    const state = { commands: [command('go')], listEnabled: true }
    const first = fakeClient(async () => state)
    store.connect(first.client)
    await vi.waitFor(() => expect(store.getSnapshot().state).toBe(state))
    first.emit('connection.closed', null)
    expect(store.getSnapshot()).toMatchObject({ online: false, state })
    expect(store.client()).toBeNull()
    expect(first.listeners('chatCommands.changed')).toBe(0)
    const second = fakeClient(async () => ({ commands: [], listEnabled: false }))
    store.connect(second.client)
    await vi.waitFor(() => expect(store.getSnapshot().state?.listEnabled).toBe(false))
    expect(store.client()).toBe(second.client)
  })

  it('says when the list could not be read, and reads it again on reload', async () => {
    const store = createChatCommandsStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fail = true
    const backend = fakeClient(async () => {
      if (fail) throw new Error('unknown method')
      return { commands: [], listEnabled: true }
    })
    store.connect(backend.client)
    await vi.waitFor(() => expect(store.getSnapshot().loadFailed).toBe(true))
    fail = false
    store.reload()
    expect(store.getSnapshot().loadFailed).toBe(false)
    await vi.waitFor(() => expect(store.getSnapshot().state).not.toBeNull())
    expect(backend.requestTyped).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps one reply failure per chat and reason, and starts over in a new session', async () => {
    const store = createChatCommandsStore()
    const backend = fakeClient(async () => ({ commands: [], listEnabled: true }))
    store.connect(backend.client)
    backend.emit('chatCommands.replyFailed', failure())
    backend.emit('chatCommands.replyFailed', failure({ command: 'faq' }))
    backend.emit(
      'chatCommands.replyFailed',
      failure({ destinationId: 'twitch', platform: 'twitch' })
    )
    expect(store.getSnapshot().failures.map((entry) => entry.destinationId)).toEqual([
      'youtube-main',
      'twitch'
    ])
    backend.emit('chatCommands.replyFailed', failure({ sessionId: 's2' }))
    expect(store.getSnapshot().failures).toEqual([failure({ sessionId: 's2' })])
  })

  it('bounds the failures a session keeps', () => {
    let failures: readonly ChatCommandReplyFailed[] = []
    for (let index = 0; index < CHAT_COMMAND_FAILURES_MAX + 5; index += 1) {
      failures = nextChatCommandFailures(failures, failure({ reason: `reason ${index}` }))
    }
    expect(failures).toHaveLength(CHAT_COMMAND_FAILURES_MAX)
    expect(failures.at(-1)?.reason).toBe(`reason ${CHAT_COMMAND_FAILURES_MAX + 4}`)
  })

  it('holds a reveal until the section has scrolled to it', () => {
    const store = createChatCommandsStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.requestReveal()
    expect(store.getSnapshot().revealPending).toBe(true)
    store.revealHandled()
    store.revealHandled()
    expect(store.getSnapshot().revealPending).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
