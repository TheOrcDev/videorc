import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { RecordingStatus, VideorcAccountSnapshot } from '../../shared/backend'

import { BackendClient, BackendRequestError, backendRequestTimeoutMs } from './backendClient'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  static onConstruct: ((socket: FakeWebSocket) => void) | null = null

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  sendFailure: Error | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    FakeWebSocket.onConstruct?.(this)
  }

  send(value: string): void {
    if (this.sendFailure) {
      throw this.sendFailure
    }
    this.sent.push(value)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  respond(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

describe('BackendClient request lifetime', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.onConstruct = null
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads the protocol validator before constructing or opening the WebSocket', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const firstConnect = client.connect()
    const duplicateConnect = client.connect()

    expect(duplicateConnect).toBe(firstConnect)
    expect(FakeWebSocket.instances).toHaveLength(0)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await expect(firstConnect).resolves.toBeUndefined()
  })

  it('stays closed without constructing a socket when closed before contract loading finishes', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const connecting = client.connect()

    client.close()

    await expect(connecting).rejects.toThrow('Backend client is closed.')
    await expect(client.connect()).rejects.toThrow('Backend client is closed.')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('rejects an in-flight connection when closed while the socket is connecting', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const connecting = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.close()

    await expect(connecting).rejects.toThrow('Backend client is closed.')
    expect(client.connected).toBe(false)
  })

  it('ignores a stale open callback after the client has closed', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const statuses: RecordingStatus[] = []
    client.on('recording.status', (status) => statuses.push(status))
    const connecting = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!

    client.close()
    await expect(connecting).rejects.toThrow('Backend client is closed.')
    socket.open()
    socket.respond({ event: 'recording.status', payload: { state: 'recording', durationMs: 10 } })

    expect(client.connected).toBe(false)
    expect(statuses).toEqual([])
    await expect(client.connect()).rejects.toThrow('Backend client is closed.')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes a socket that becomes stale during construction', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    FakeWebSocket.onConstruct = () => client.close()

    const connecting = client.connect()

    await expect(connecting).rejects.toThrow('Backend client is closed.')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)
    expect(client.connected).toBe(false)
  })

  it('does not revive a failed connection attempt through a late open callback', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const connecting = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!

    socket.onerror?.()
    await expect(connecting).rejects.toThrow('Could not connect to the Rust backend.')
    socket.open()

    expect(client.connected).toBe(false)
  })

  it('rejects a connecting attempt when the socket closes itself', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const connecting = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    FakeWebSocket.instances[0]!.close()

    await expect(connecting).rejects.toThrow('Backend connection closed.')
    expect(client.connected).toBe(false)
  })

  it('deduplicates connect calls while the socket is connecting', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const firstConnect = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const duplicateConnect = client.connect()

    expect(duplicateConnect).toBe(firstConnect)
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.open()
    await expect(firstConnect).resolves.toBeUndefined()
  })

  it('deduplicates until the original connect promise has settled', async () => {
    const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
    const firstConnect = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    FakeWebSocket.instances[0]!.open()
    const duplicateConnect = client.connect()

    expect(duplicateConnect).toBe(firstConnect)
    await expect(firstConnect).resolves.toBeUndefined()
  })

  it('closes idempotently and emits one connection closure', async () => {
    const { client, socket } = await connectedClient()
    const closures: unknown[] = []
    client.on('connection.closed', (payload) => closures.push(payload))

    client.close()
    client.close()

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(client.connected).toBe(false)
    expect(closures).toEqual([null])
    await expect(client.connect()).rejects.toThrow('Backend client is closed.')
  })

  it('times out a missing response and removes the pending entry', async () => {
    vi.useFakeTimers()
    const { client } = await connectedClient()

    const request = client.request('health.ping', undefined, { timeoutMs: 25 })
    const rejection = expect(request).rejects.toThrow('timed out after 25ms')
    expect(client.pendingRequestCount).toBe(1)
    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(client.pendingRequestCount).toBe(0)
  })

  it('cancels through AbortSignal and ignores a late response', async () => {
    const { client, socket } = await connectedClient()
    const controller = new AbortController()
    const request = client.request('diagnostics.stats', undefined, { signal: controller.signal })
    const id = JSON.parse(socket.sent[0])['id'] as string

    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(client.pendingRequestCount).toBe(0)

    socket.respond({ id, ok: true, payload: { stale: true } })
    expect(client.pendingRequestCount).toBe(0)
  })

  it('cleans up when WebSocket.send throws synchronously', async () => {
    const { client, socket } = await connectedClient()
    socket.sendFailure = new Error('socket buffer rejected the write')

    await expect(client.request('scene.get')).rejects.toThrow(
      'Could not send backend request "scene.get"'
    )
    expect(client.pendingRequestCount).toBe(0)
  })

  it('rejects and clears every request owned by a closed socket', async () => {
    const { client, socket } = await connectedClient()
    expect(client.connected).toBe(true)
    const first = client.request('scene.get')
    const second = client.request('diagnostics.stats')
    const firstRejection = expect(first).rejects.toThrow('Backend connection closed.')
    const secondRejection = expect(second).rejects.toThrow('Backend connection closed.')

    socket.close()

    await Promise.all([firstRejection, secondRejection])
    expect(client.pendingRequestCount).toBe(0)
    expect(client.connected).toBe(false)
  })

  it('clears timeout and cancellation hooks after a response', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    const controller = new AbortController()
    const request = client.request('health.ping', undefined, {
      timeoutMs: 10,
      signal: controller.signal
    })
    const id = JSON.parse(socket.sent[0])['id'] as string

    const health = {
      status: 'ok',
      version: 'test',
      platform: 'win32',
      ffmpeg: { path: 'C:\\ffmpeg.exe', available: true },
      databasePath: 'C:\\videorc.db',
      secretStoreBackend: 'test'
    }
    socket.respond({ id, ok: true, payload: health })
    await expect(request).resolves.toEqual(health)
    await vi.advanceTimersByTimeAsync(20)
    controller.abort()
    expect(client.pendingRequestCount).toBe(0)
  })

  it('preserves stable backend error codes for terminal retry decisions', async () => {
    const { client, socket } = await connectedClient()
    const request = client.requestTyped('account.complete_sign_in', {
      code: 'opaque-code-that-is-long-enough',
      state: 'state-that-is-long-enough',
      verifier: 'v'.repeat(43),
      intentGeneration: 7
    })
    const id = JSON.parse(socket.sent[0])['id'] as string

    socket.respond({
      id,
      ok: false,
      error: {
        code: 'account-sign-in-superseded',
        message: 'Desktop account sign-in was superseded.'
      }
    })

    await expect(request).rejects.toEqual(
      new BackendRequestError(
        'account-sign-in-superseded',
        'Desktop account sign-in was superseded.'
      )
    )
  })

  it('gives media jobs a longer finite method-specific timeout', () => {
    expect(backendRequestTimeoutMs('preview.surface.present')).toBe(5_000)
    expect(backendRequestTimeoutMs('health.ping')).toBe(30_000)
    expect(backendRequestTimeoutMs('ai.run_post_recording')).toBe(30 * 60_000)
  })

  it('rejects malformed high-risk params before writing them to the socket', async () => {
    const { client, socket } = await connectedClient()

    await expect(
      client.request('account.complete_sign_in', {
        code: 'short',
        state: 'short',
        verifier: 'short'
      })
    ).rejects.toThrow('backend.account.complete_sign_in.params.code')
    expect(socket.sent).toEqual([])
  })

  it('rejects malformed high-risk responses instead of publishing unchecked payloads', async () => {
    const { client, socket } = await connectedClient()
    const request = client.request<unknown>('recording.status')
    const id = JSON.parse(socket.sent[0])['id'] as string

    socket.respond({ id, ok: true, payload: { state: 'recording', durationMs: -1 } })

    await expect(request).rejects.toThrow('backend.recording.status.result')
    expect(client.pendingRequestCount).toBe(0)
  })

  it('exposes a method-map typed request for migrated call sites', async () => {
    const { client, socket } = await connectedClient()
    const request = client.requestTyped('account.get', undefined)
    expectTypeOf(request).toEqualTypeOf<Promise<VideorcAccountSnapshot>>()
    const id = JSON.parse(socket.sent[0])['id'] as string
    socket.respond({ id, ok: true, payload: { status: 'signed-out' } })

    await expect(request).resolves.toEqual({ status: 'signed-out' })
  })

  it('rejects malformed websocket envelopes without throwing out of the event loop', async () => {
    const { client, socket } = await connectedClient()
    const errors: unknown[] = []
    client.on('error', (payload) => errors.push(payload))

    socket.onmessage?.({ data: 'null' })
    socket.onmessage?.({ data: JSON.stringify({ event: 42, payload: {} }) })

    expect(errors).toEqual([
      { message: 'Backend sent an invalid websocket message.' },
      { message: 'Backend sent an invalid websocket message.' }
    ])
  })

  it('validates typed backend events before invoking subscribers', async () => {
    const { client, socket } = await connectedClient()
    const statuses: RecordingStatus[] = []
    const errors: unknown[] = []
    client.on('recording.status', (status) => statuses.push(status))
    client.on('error', (payload) => errors.push(payload))

    socket.respond({ event: 'recording.status', payload: { state: 'recording', durationMs: -1 } })
    socket.respond({ event: 'recording.status', payload: { state: 'recording', durationMs: 10 } })

    expect(statuses).toEqual([{ state: 'recording', durationMs: 10 }])
    expect(errors).toEqual([{ message: 'Backend event "recording.status" failed validation.' }])
  })
})

async function connectedClient(): Promise<{
  client: BackendClient
  socket: FakeWebSocket
}> {
  const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
  const connected = client.connect()
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error('BackendClient did not create a WebSocket')
  }
  socket.open()
  await connected
  return { client, socket }
}
