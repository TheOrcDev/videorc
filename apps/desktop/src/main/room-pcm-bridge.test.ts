import { describe, expect, it } from 'vitest'
import { RoomPcmBridge } from './room-pcm-bridge'
import { roomPcmCommand } from '../shared/room-pcm'
import { RendererSecurityRegistry } from '../shared/renderer-security-policy'

describe('PCM main transport ownership', () => {
  it('does not resolve credentials or allocate a socket while disabled', async () => {
    let called = false
    const bridge = new RoomPcmBridge(
      async () => {
        called = true
        throw new Error('unexpected')
      },
      () => false
    )
    await expect(bridge.request(roomPcmCommand('open', 1))).rejects.toThrow('disabled')
    expect(called).toBe(false)
  })
  it('cancels opening before credentials arrive without allocating a socket', async () => {
    let resolve!: (c: { host: string; port: number; token: string }) => void
    let allocated = false
    const bridge = new RoomPcmBridge(
      () =>
        new Promise((r) => {
          resolve = r
        }),
      () => true,
      () => {
        allocated = true
        throw new Error('unexpected')
      }
    )
    const opening = bridge.request(roomPcmCommand('open', 1))
    bridge.close()
    resolve({ host: '127.0.0.1', port: 1, token: 'fixture' })
    await expect(opening).rejects.toThrow('closed')
    expect(allocated).toBe(false)
  })
  it('denies unregistered senders before application code', () => {
    const registry = new RendererSecurityRegistry()
    expect(
      registry.invokeAllowed('room-pcm:test', {
        senderId: 1,
        frameUrl: 'https://attacker.invalid',
        isMainFrame: true
      })
    ).toBe(false)
  })
})

it('enforces trusted main-frame origins and denies auxiliary roles', () => {
  const registry = new RendererSecurityRegistry()
  registry.register(1, 'main')
  registry.trustDocument(1, 'http://localhost:5173/index.html')
  const identity = { senderId: 1, frameUrl: 'http://localhost:5173/index.html', isMainFrame: true }
  expect(registry.invokeAllowed('room-pcm:test', identity)).toBe(true)
  expect(registry.invokeAllowed('room-pcm:test', { ...identity, isMainFrame: false })).toBe(false)
  expect(
    registry.invokeAllowed('room-pcm:test', {
      ...identity,
      frameUrl: 'http://localhost:5174/index.html'
    })
  ).toBe(false)
  registry.register(2, 'comments')
  registry.trustDocument(2, identity.frameUrl)
  expect(registry.invokeAllowed('room-pcm:test', { ...identity, senderId: 2 })).toBe(false)
  expect(registry.invokeAllowed('room-pcm:inspect', { ...identity, senderId: 2 })).toBe(false)
  expect(registry.invokeAllowed('room-pcm:inspect', { ...identity, isMainFrame: false })).toBe(
    false
  )
})

it('has one pull credit and rejects pending pulls when the owner closes', async () => {
  const sent: { id: string; method: string }[] = []
  const fake = {
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: { data: string }) => void),
    onerror: null,
    onclose: null as null | (() => void),
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      fake.readyState = 3
      fake.onclose?.()
    }
  }
  const bridge = new RoomPcmBridge(
    async () => ({ host: '127.0.0.1', port: 1, token: 'fixture' }),
    () => true,
    () => fake as unknown as WebSocket
  )
  const opening = bridge.request(roomPcmCommand('open', 1))
  await Promise.resolve()
  fake.onopen?.()
  await Promise.resolve()
  expect(sent[0].method).toBe('events.setIncluded')
  fake.onmessage?.({
    data: JSON.stringify({
      id: sent[1].id,
      ok: true,
      payload: { generation: 1, originUs: 1200, incarnation: 77 }
    })
  })
  await opening
  expect(RoomPcmBridge.resources().sockets).toBe(1)
  const pull = bridge.request(roomPcmCommand('pull', 1))
  await expect(bridge.request(roomPcmCommand('pull', 1))).rejects.toThrow('outstanding')
  const rejected = expect(pull).rejects.toThrow('closed')
  await bridge.request(roomPcmCommand('close', 1))
  await rejected
  expect(fake.onmessage).toBeNull()
  expect(RoomPcmBridge.resources()).toEqual({ sockets: 0, ipcRequests: 0, timers: 0 })
  await expect(bridge.request(roomPcmCommand('pull', 1))).rejects.toThrow('disabled')
})

it('native close waits for the authenticated backend acknowledgement before releasing its socket', async () => {
  const sent: { id: string; method: string; params: { action: string } }[] = []
  const fake = {
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: { data: string }) => void),
    onerror: null,
    onclose: null as null | (() => void),
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      fake.readyState = 3
      fake.onclose?.()
    }
  }
  const bridge = new RoomPcmBridge(
    async () => ({ host: '127.0.0.1', port: 1, token: 'fixture' }),
    () => true,
    () => fake as unknown as WebSocket,
    'room.microphone.pcm'
  )
  const base = {
    generation: 10,
    role: 'host-microphone' as const,
    showId: 'show',
    sampleRate: 48000 as const,
    channels: 1 as const,
    frames: 480 as const
  }
  const opening = bridge.request({
    ...base,
    action: 'open',
    settings: { deviceId: 'exact', gainDb: 0, muted: false, noise: 'off', offsetMs: 0 }
  })
  await Promise.resolve()
  fake.onopen?.()
  await Promise.resolve()
  expect(sent[1].method).toBe('room.microphone.pcm')
  fake.onmessage?.({
    data: JSON.stringify({
      id: sent[1].id,
      ok: true,
      payload: { generation: 10, originUs: null, incarnation: null }
    })
  })
  await opening
  let closed = false
  const closing = bridge.request({ ...base, action: 'close' }).then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(sent.at(-1)?.params.action).toBe('close')
  expect(closed).toBe(false)
  expect(fake.readyState).toBe(1)
  fake.onmessage?.({ data: JSON.stringify({ id: sent.at(-1)?.id, ok: true, payload: null }) })
  await closing
  expect(fake.readyState).toBe(3)
  expect(RoomPcmBridge.resources()).toEqual({ sockets: 0, ipcRequests: 0, timers: 0 })
})

it('refuses an open reply whose clock origin is unsafe or lacks its incarnation', async () => {
  for (const payload of [
    null,
    { generation: 1, originUs: 5, incarnation: null },
    { generation: 2, originUs: null, incarnation: null }
  ]) {
    const sent: { id: string; method: string }[] = []
    const fake = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: { data: string }) => void),
      onerror: null,
      onclose: null as null | (() => void),
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
      close: () => {
        fake.readyState = 3
        fake.onclose?.()
      }
    }
    const bridge = new RoomPcmBridge(
      async () => ({ host: '127.0.0.1', port: 1, token: 'fixture' }),
      () => true,
      () => fake as unknown as WebSocket
    )
    const opening = bridge.request(roomPcmCommand('open', 1))
    await Promise.resolve()
    fake.onopen?.()
    await Promise.resolve()
    fake.onmessage?.({ data: JSON.stringify({ id: sent[1]!.id, ok: true, payload }) })
    await expect(opening).rejects.toThrow()
    bridge.close()
  }
})

it('Scopes system cleanup observations separately from a still-live microphone bridge', async () => {
  let resolve!: (value: { host: string; port: number; token: string }) => void
  const bridge = new RoomPcmBridge(
    () =>
      new Promise((r) => {
        resolve = r
      }),
    () => true,
    undefined,
    'room.system.pcm'
  )
  const opening = bridge.request({
    action: 'open',
    generation: 42,
    showId: 'show',
    role: 'host-system-audio',
    sampleRate: 48000,
    channels: 2,
    frames: 480
  })
  expect(RoomPcmBridge.resources('room.system.pcm').ipcRequests).toBe(1)
  expect(RoomPcmBridge.resources('room.microphone.pcm').ipcRequests).toBe(0)
  bridge.close()
  resolve({ host: '127.0.0.1', port: 1, token: 'fixture' })
  await expect(opening).rejects.toThrow('closed')
  expect(RoomPcmBridge.resources('room.system.pcm')).toEqual({
    sockets: 0,
    ipcRequests: 0,
    timers: 0
  })
})
