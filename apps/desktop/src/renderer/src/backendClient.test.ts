import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendClient, backendRequestTimeoutMs } from './backendClient'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  sendFailure: Error | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    if (this.sendFailure) {
      throw this.sendFailure
    }
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }

  respond(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

describe('BackendClient request lifetime', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
    const first = client.request('scene.get')
    const second = client.request('diagnostics.stats')
    const firstRejection = expect(first).rejects.toThrow('Backend connection closed.')
    const secondRejection = expect(second).rejects.toThrow('Backend connection closed.')

    socket.close()

    await Promise.all([firstRejection, secondRejection])
    expect(client.pendingRequestCount).toBe(0)
  })

  it('clears timeout and cancellation hooks after a response', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    const controller = new AbortController()
    const request = client.request<{ pong: boolean }>('health.ping', undefined, {
      timeoutMs: 10,
      signal: controller.signal
    })
    const id = JSON.parse(socket.sent[0])['id'] as string

    socket.respond({ id, ok: true, payload: { pong: true } })
    await expect(request).resolves.toEqual({ pong: true })
    await vi.advanceTimersByTimeAsync(20)
    controller.abort()
    expect(client.pendingRequestCount).toBe(0)
  })

  it('gives media jobs a longer finite method-specific timeout', () => {
    expect(backendRequestTimeoutMs('preview.surface.present')).toBe(5_000)
    expect(backendRequestTimeoutMs('health.ping')).toBe(30_000)
    expect(backendRequestTimeoutMs('ai.run_post_recording')).toBe(30 * 60_000)
  })
})

async function connectedClient(): Promise<{
  client: BackendClient
  socket: FakeWebSocket
}> {
  const client = new BackendClient({ host: '127.0.0.1', port: 9988, token: 'token' })
  const connected = client.connect()
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error('BackendClient did not create a WebSocket')
  }
  socket.open()
  await connected
  return { client, socket }
}
