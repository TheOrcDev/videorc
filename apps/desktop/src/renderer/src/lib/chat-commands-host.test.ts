import { describe, expect, it, vi } from 'vitest'

import type {
  ChatCommand,
  ChatCommandPostResult,
  ChatCommandRelayCommand,
  ChatCommandsState
} from '../../../shared/chat-commands'
import { startChatCommandsHost, type ChatCommandsHostDeps } from './chat-commands-host'
import { createChatCommandsStore, type ChatCommandsClient } from './chat-commands-store'

// Plan 226 S4: the main window keeps the Stream Manager's copy (the enabled
// commands and the failed replies), posts the streamer's `!go` and opens the
// section when the ⋯ menu asks.

function command(name: string, enabled = true): ChatCommand {
  return {
    id: `id-${name}`,
    name,
    description: `about ${name}`,
    reply: `the reply for ${name}`,
    enabled,
    createdAt: '2026-11-10T18:00:00Z',
    updatedAt: '2026-11-10T18:00:00Z'
  }
}

function fakeApi() {
  let onRequest: ((command: ChatCommandRelayCommand) => void) | null = null
  let onOpen: (() => void) | null = null
  const api = {
    pushCommentsChatCommands: vi.fn(async () => true),
    pushChatCommandFailures: vi.fn(async () => true),
    pushChatCommandResult: vi.fn(async () => true),
    onChatCommandRequest: vi.fn((callback: (command: ChatCommandRelayCommand) => void) => {
      onRequest = callback
      return () => {
        onRequest = null
      }
    }),
    onOpenChatCommands: vi.fn((callback: () => void) => {
      onOpen = callback
      return () => {
        onOpen = null
      }
    })
  }
  return {
    api,
    request: (command: ChatCommandRelayCommand) => onRequest?.(command),
    open: () => onOpen?.(),
    listening: () => onRequest !== null && onOpen !== null
  }
}

function fakeClient(post: (params: unknown) => Promise<ChatCommandPostResult>) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const requestTyped = vi.fn((method: string, params?: unknown) =>
    method === 'chatCommands.post'
      ? post(params)
      : Promise.resolve<ChatCommandsState>({ commands: [], listEnabled: true })
  )
  return {
    client: {
      requestTyped,
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      }
    } as unknown as ChatCommandsClient,
    requestTyped,
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

describe('chat commands host (plan 226 S4)', () => {
  it('pushes the enabled commands and the failed replies, each only when they change', async () => {
    const store = createChatCommandsStore()
    const { api } = fakeApi()
    startChatCommandsHost(store, { api, openSetup: vi.fn() })
    // Null until Studio has read the list.
    expect(api.pushCommentsChatCommands).toHaveBeenLastCalledWith(null)
    store.acceptState({ commands: [command('faq', false), command('go')], listEnabled: true })
    expect(api.pushCommentsChatCommands).toHaveBeenLastCalledWith({
      commands: [{ name: 'go', description: 'about go' }],
      listEnabled: true
    })
    // A change the Stream Manager can't see (a reply) pushes nothing new.
    const calls = api.pushCommentsChatCommands.mock.calls.length
    store.acceptState({
      commands: [command('faq', false), { ...command('go'), reply: 'New words.' }],
      listEnabled: true
    })
    expect(api.pushCommentsChatCommands.mock.calls.length).toBe(calls)
    const failure = {
      sessionId: 's1',
      destinationId: 'youtube-main',
      platform: 'youtube' as const,
      command: 'go',
      reason: 'reconnect YouTube to allow chat posts.'
    }
    store.acceptReplyFailed(failure)
    expect(api.pushChatCommandFailures).toHaveBeenLastCalledWith([failure])
  })

  it("posts the streamer's !go on Studio's connection and answers the counts", async () => {
    const store = createChatCommandsStore()
    const fake = fakeApi()
    startChatCommandsHost(store, { api: fake.api, openSetup: vi.fn() })
    const backend = fakeClient(async () => ({ sent: 2, failed: 1 }))
    store.connect(backend.client)
    fake.request({ requestId: 'r1', sessionId: 'live-1', name: 'go' })
    await vi.waitFor(() =>
      expect(fake.api.pushChatCommandResult).toHaveBeenCalledWith({
        requestId: 'r1',
        ok: true,
        value: { sent: 2, failed: 1 }
      })
    )
    expect(backend.requestTyped).toHaveBeenCalledWith('chatCommands.post', {
      sessionId: 'live-1',
      name: 'go'
    })
  })

  it("answers a post that could not run with the composer's words", async () => {
    const store = createChatCommandsStore()
    const fake = fakeApi()
    startChatCommandsHost(store, { api: fake.api, openSetup: vi.fn() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.request({ requestId: 'offline', sessionId: 'live-1', name: 'go' })
    await vi.waitFor(() =>
      expect(fake.api.pushChatCommandResult).toHaveBeenCalledWith({
        requestId: 'offline',
        ok: false,
        error: "Couldn't post the !go reply. Videorc is reconnecting. Try again in a moment."
      })
    )
    const backend = fakeClient(async () => {
      throw new Error('provider exploded: 500')
    })
    store.connect(backend.client)
    fake.request({ requestId: 'failed', sessionId: 'live-1', name: 'go' })
    await vi.waitFor(() =>
      expect(fake.api.pushChatCommandResult).toHaveBeenCalledWith({
        requestId: 'failed',
        ok: false,
        error:
          "Couldn't post the !go reply. Try again. If it keeps happening, export a support bundle from Health."
      })
    )
    warn.mockRestore()
  })

  it('opens Setup and asks the section to scroll into view, and stops listening when stopped', () => {
    const store = createChatCommandsStore()
    const fake = fakeApi()
    const openSetup = vi.fn()
    const deps: ChatCommandsHostDeps = { api: fake.api, openSetup }
    const stop = startChatCommandsHost(store, deps)
    fake.open()
    expect(openSetup).toHaveBeenCalledOnce()
    expect(store.getSnapshot().revealPending).toBe(true)
    stop()
    expect(fake.listening()).toBe(false)
  })
})
