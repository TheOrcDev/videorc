// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatEmoteSettings } from './use-chat-emote-settings'
import { useDiscordAnnounce } from './use-discord-announce'
import { useUsageStatsSetting } from './use-usage-stats-setting'

// QA F10: these settings rows once opened their own backend client when they
// mounted and kept it, so after the engine restarted with Settings still open
// every save failed on the closed connection. They use the app's shared
// client, which the Studio provider replaces on reconnect.

const mocked = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioDiagnostics: () => ({ client: mocked.client })
}))

type Reply = Record<string, unknown>
interface FakeClient {
  closed: boolean
  stored: Reply
  calls: string[]
  readsFail: boolean
  handlers: Map<string, (payload: unknown) => void>
  request: (method: string, params?: Reply) => Promise<Reply>
  requestTyped: (method: string, params?: Reply) => Promise<Reply>
  on: (event: string, handler: (payload: unknown) => void) => () => void
}

function fakeClient(stored: Reply): FakeClient {
  const client: FakeClient = {
    closed: false,
    stored,
    calls: [],
    readsFail: false,
    handlers: new Map(),
    request: async (method, params) => {
      client.calls.push(method)
      if (client.closed) throw new Error('Backend connection is closed')
      if (method.endsWith('.set') || method.endsWith('.update')) {
        client.stored = { ...client.stored, ...params }
        return client.stored
      }
      if (client.readsFail) throw new Error('read failed')
      if (method === 'discord.links.preview') return { links: [] }
      return client.stored
    },
    requestTyped: (method, params) => client.request(method, params),
    on: (event, handler) => {
      client.handlers.set(event, handler)
      return () => client.handlers.delete(event)
    }
  }
  return client
}

let root: Root
let container: HTMLDivElement
let latest: Record<string, unknown>

function mount<T>(hook: () => T): void {
  function Probe(): null {
    latest = hook() as Record<string, unknown>
    return null
  }
  void act(() => root.render(createElement(Probe)))
}
const settle = (): Promise<void> => act(async () => undefined)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Mount `hook` on `first`, then swap the shared client for `second`, as a reconnect does. */
async function reconnect<T>(hook: () => T, first: FakeClient, second: FakeClient): Promise<void> {
  mocked.client = first
  function Probe(): null {
    latest = hook() as Record<string, unknown>
    return null
  }
  await act(async () => root.render(createElement(Probe)))
  await settle()
  first.closed = true
  mocked.client = second
  await act(async () => root.render(createElement(Probe)))
  await settle()
}

describe('Settings → General after the backend restarts (QA F10)', () => {
  it('saves the usage stats choice on the new connection', async () => {
    const old = fakeClient({ enabled: true, envDisabled: false })
    const next = fakeClient({ enabled: true, envDisabled: false })
    await reconnect(useUsageStatsSetting, old, next)
    expect(next.calls).toEqual(['usageStats.get'])
    await act(async () => (latest.setEnabled as (on: boolean) => void)(false))
    await settle()
    expect(next.stored).toMatchObject({ enabled: false })
    expect(old.calls.filter((call) => call === 'usageStats.set')).toHaveLength(0)
    expect(latest.error).toBeNull()
    expect((latest.state as { enabled: boolean }).enabled).toBe(false)
  })

  it('never shows a usage stats choice that did not save, even when it cannot read it back', async () => {
    const client = fakeClient({ enabled: true, envDisabled: false })
    mocked.client = client
    mount(useUsageStatsSetting)
    await settle()
    client.closed = true
    await act(async () => (latest.setEnabled as (on: boolean) => void)(false))
    await settle()
    expect(latest.error).toBe("Couldn't save the privacy settings. Try again.")
    expect((latest.state as { enabled: boolean }).enabled).toBe(true)
  })

  it('says Videorc is reconnecting instead of changing anything with no connection', async () => {
    mocked.client = null
    mount(useUsageStatsSetting)
    await settle()
    await act(async () => (latest.setEnabled as (on: boolean) => void)(false))
    expect(latest.error).toBe('Videorc is reconnecting. Try again in a moment.')
    expect(latest.state).toBeNull()
  })

  it('saves a chat emote setting on the new connection', async () => {
    const stored = { sevenTv: false, twitchGifs: 'animated' }
    const old = fakeClient(stored)
    const next = fakeClient(stored)
    await reconnect(useChatEmoteSettings, old, next)
    await act(async () => (latest.setSevenTv as (on: boolean) => void)(true))
    await settle()
    expect(next.stored).toMatchObject({ sevenTv: true })
    expect(old.calls.filter((call) => call === 'liveChat.emotes.set')).toHaveLength(0)
    expect(latest.error).toBeNull()
    expect((latest.settings as { sevenTv: boolean }).sevenTv).toBe(true)
    // Events come from the new connection only.
    expect(old.handlers.size).toBe(0)
    expect(next.handlers.has('liveChat.emotes')).toBe(true)
  })

  it('rolls a failed chat save back to what was there', async () => {
    const client = fakeClient({ sevenTv: false, twitchGifs: 'animated' })
    mocked.client = client
    mount(useChatEmoteSettings)
    await settle()
    client.closed = true
    await act(async () => (latest.setSevenTv as (on: boolean) => void)(true))
    await settle()
    expect(latest.error).toBe("Couldn't save the chat settings. Try again.")
    expect((latest.settings as { sevenTv: boolean }).sevenTv).toBe(false)
  })

  it('updates Discord on the new connection and reads its settings again', async () => {
    const snapshot = { excludedTargetIds: [], linkOverrides: {}, postAs: 'a', identities: [] }
    const old = fakeClient(snapshot)
    const next = fakeClient(snapshot)
    await reconnect(() => useDiscordAnnounce([]), old, next)
    expect(next.calls).toContain('discord.announce.get')
    await act(async () =>
      (latest.update as (patch: Reply) => Promise<string | null>)({ postAs: 'b' })
    )
    expect(next.stored).toMatchObject({ postAs: 'b' })
    expect(old.calls.filter((call) => call === 'discord.announce.update')).toHaveLength(0)
    expect(latest.error).toBeNull()
  })
})
