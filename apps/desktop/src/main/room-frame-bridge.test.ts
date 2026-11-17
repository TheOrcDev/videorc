import { describe, expect, it, vi } from 'vitest'
import { RoomFrameBridge } from './room-frame-bridge'
import {
  ROOM_FRAME,
  ROOM_FRAME_MESSAGE_BYTES,
  framePtsUs,
  roomFrameCommand
} from '../shared/room-frame'
import { RendererSecurityRegistry } from '../shared/renderer-security-policy'

function encodeFrame(
  fields: Partial<{
    serial: number
    generation: number
    sequence: number
    surfaceEpoch: number
    originUs: bigint
    incarnation: bigint
    observedAtUs: number
  }> = {}
): ArrayBuffer {
  const buffer = new ArrayBuffer(ROOM_FRAME_MESSAGE_BYTES)
  const view = new DataView(buffer)
  const sequence = fields.sequence ?? 3
  view.setUint32(0, ROOM_FRAME.magic, true)
  view.setUint16(4, 1, true)
  view.setUint16(6, 1, true)
  view.setUint32(8, fields.serial ?? 2, true)
  view.setUint32(12, ROOM_FRAME.packedWidth, true)
  view.setUint32(16, ROOM_FRAME.height, true)
  view.setUint32(20, fields.surfaceEpoch ?? 1, true)
  view.setUint32(24, 0, true)
  view.setBigUint64(32, BigInt(fields.generation ?? 7), true)
  view.setBigUint64(40, BigInt(sequence), true)
  view.setBigUint64(48, BigInt(framePtsUs(sequence)), true)
  view.setBigUint64(56, BigInt(fields.observedAtUs ?? framePtsUs(sequence) + 500), true)
  view.setBigUint64(64, fields.originUs ?? 1_000n, true)
  view.setBigUint64(72, fields.incarnation ?? 99n, true)
  new Uint8Array(buffer, ROOM_FRAME.headerBytes).fill(9)
  return buffer
}

class FakeSocket {
  static last: FakeSocket | undefined
  readyState = 0
  binaryType = 'blob'
  sent: { id: string; method: string; params?: { action?: string } }[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  reply(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const connection = async () => ({ host: '127.0.0.1', port: 1, token: 'fixture' })
const open = (bridge: RoomFrameBridge) => {
  const opened = bridge.request(roomFrameCommand('open', 7, 1))
  return opened
}
async function opened(): Promise<RoomFrameBridge> {
  const bridge = new RoomFrameBridge(
    connection,
    () => true,
    () => new FakeSocket() as unknown as WebSocket
  )
  FakeSocket.last = undefined
  const pending = open(bridge)
  await vi.waitFor(() => expect(FakeSocket.last?.sent.length).toBe(2))
  FakeSocket.last!.reply(
    JSON.stringify({
      id: 'frame-1',
      ok: true,
      payload: { generation: 7, surfaceEpoch: 1, originUs: 1000, incarnation: 99 }
    })
  )
  await expect(pending).resolves.toMatchObject({ generation: 7, originUs: 1000 })
  return bridge
}

describe('frame main transport ownership', () => {
  it('does not resolve credentials or allocate a socket while disabled', async () => {
    let called = false
    const bridge = new RoomFrameBridge(
      async () => {
        called = true
        throw new Error('unexpected')
      },
      () => false
    )
    await expect(bridge.request(roomFrameCommand('open', 1, 1))).rejects.toThrow('disabled')
    expect(called).toBe(false)
  })

  it('validates a binary frame against generation and serial and copies exact pixels', async () => {
    const bridge = await opened()
    expect(FakeSocket.last!.binaryType).toBe('arraybuffer')
    expect(FakeSocket.last!.sent[0]).toMatchObject({ method: 'events.setIncluded' })
    const pull = bridge.request(roomFrameCommand('pull', 7, 2))
    FakeSocket.last!.reply(encodeFrame())
    const frame = await pull
    expect(frame && 'header' in frame && frame.header.sequence).toBe(3)
    if (!frame || !('pixels' in frame)) throw new Error('expected frame')
    expect(frame.pixels.byteLength).toBe(ROOM_FRAME_MESSAGE_BYTES - ROOM_FRAME.headerBytes)
    expect(frame.pixels.buffer.byteLength).toBe(frame.pixels.byteLength)
    expect(RoomFrameBridge.resources().ipcRequests).toBe(0)
    const closing = bridge.request(roomFrameCommand('close', 7, 3))
    FakeSocket.last!.reply(JSON.stringify({ id: 'frame-3', ok: true, payload: null }))
    await expect(closing).resolves.toBeNull()
    expect(RoomFrameBridge.resources()).toEqual({ sockets: 0, ipcRequests: 0, timers: 0 })
  })

  it('closes on a stale serial, an unsolicited frame or a bad origin sum', async () => {
    for (const bad of [
      encodeFrame({ serial: 9 }),
      encodeFrame({ generation: 8 }),
      encodeFrame({ originUs: BigInt(Number.MAX_SAFE_INTEGER) }),
      encodeFrame({ incarnation: 0n }),
      new ArrayBuffer(16)
    ]) {
      const bridge = await opened()
      const pull = bridge.request(roomFrameCommand('pull', 7, 2))
      FakeSocket.last!.reply(bad)
      await expect(pull).rejects.toThrow('closed')
      expect(RoomFrameBridge.resources().sockets).toBe(0)
    }
    const bridge = await opened()
    FakeSocket.last!.reply(encodeFrame())
    await expect(bridge.request(roomFrameCommand('pull', 7, 2))).rejects.toThrow()
  })

  it('accepts absent origin only as null and a lease-stalled idle reply', async () => {
    const bridge = await opened()
    const pull = bridge.request(roomFrameCommand('pull', 7, 2))
    FakeSocket.last!.reply(encodeFrame({ originUs: 0xffff_ffff_ffff_ffffn, incarnation: 0n }))
    const frame = await pull
    expect(frame && 'header' in frame && frame.header.originUs).toBeNull()
    const idle = bridge.request(roomFrameCommand('pull', 7, 3, { sequence: 3, surfaceEpoch: 1 }))
    expect(FakeSocket.last!.sent.at(-1)?.params).toMatchObject({ release: { sequence: 3 } })
    FakeSocket.last!.reply(
      JSON.stringify({
        id: 'frame-3',
        ok: true,
        payload: { frame: null, reason: 'lease-stalled', staleReleases: 0, leaseStalls: 1 }
      })
    )
    await expect(idle).resolves.toMatchObject({ reason: 'lease-stalled' })
    bridge.close()
  })

  it('times out a silent backend and releases every owned resource', async () => {
    const bridge = await opened()
    vi.useFakeTimers()
    try {
      const pull = bridge.request(roomFrameCommand('pull', 7, 2))
      const rejected = expect(pull).rejects.toThrow('closed')
      await vi.advanceTimersByTimeAsync(ROOM_FRAME.requestTimeoutMs)
      await rejected
      expect(RoomFrameBridge.resources()).toEqual({ sockets: 0, ipcRequests: 0, timers: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('is main-frame only', () => {
    const registry = new RendererSecurityRegistry()
    registry.register(1, 'main')
    registry.register(2, 'comments')
    registry.trustDocument(1, 'http://localhost:5173/index.html')
    registry.trustDocument(2, 'http://localhost:5173/comments.html')
    const main = { senderId: 1, frameUrl: 'http://localhost:5173/index.html', isMainFrame: true }
    expect(registry.invokeAllowed('room-frame:test', main)).toBe(true)
    expect(registry.invokeAllowed('room-frame:test', { ...main, isMainFrame: false })).toBe(false)
    expect(
      registry.invokeAllowed('room-frame:test', {
        senderId: 2,
        frameUrl: 'http://localhost:5173/comments.html',
        isMainFrame: true
      })
    ).toBe(false)
  })
})

describe('processed camera transport (S13b)', () => {
  const size = { width: 554, height: 414, fps: 30 }
  function processedFrame(serial: number): ArrayBuffer {
    const bytes = ROOM_FRAME.headerBytes + (size.width * 2 + 8) * size.height * 4
    const buffer = new ArrayBuffer(bytes)
    const view = new DataView(buffer)
    view.setUint32(0, ROOM_FRAME.magic, true)
    view.setUint16(4, 1, true)
    view.setUint16(6, 3, true)
    view.setUint32(8, serial, true)
    view.setUint32(12, size.width * 2 + 8, true)
    view.setUint32(16, size.height, true)
    view.setUint32(20, 1, true)
    view.setBigUint64(32, 7n, true)
    view.setBigUint64(40, 1n, true)
    view.setBigUint64(48, 1_000n, true)
    view.setBigUint64(56, 2_000n, true)
    view.setBigUint64(64, 0xffff_ffff_ffff_ffffn, true)
    return buffer
  }
  async function openedProcessed(): Promise<RoomFrameBridge> {
    const bridge = new RoomFrameBridge(
      connection,
      () => true,
      () => new FakeSocket() as unknown as WebSocket,
      'room.camera.processed'
    )
    FakeSocket.last = undefined
    const pending = bridge.request(roomFrameCommand('open', 7, 1, undefined, size))
    await vi.waitFor(() => expect(FakeSocket.last?.sent.length).toBe(2))
    expect(FakeSocket.last!.sent[1]).toMatchObject({ method: 'room.camera.processed' })
    FakeSocket.last!.reply(
      JSON.stringify({
        id: 'frame-1',
        ok: true,
        payload: { generation: 7, surfaceEpoch: 1, originUs: null, incarnation: null }
      })
    )
    await pending
    return bridge
  }

  it('accepts a frame only at the generation size with observation-time pts', async () => {
    const bridge = await openedProcessed()
    const pull = bridge.request(roomFrameCommand('pull', 7, 2, undefined, size))
    FakeSocket.last!.reply(processedFrame(2))
    const frame = await pull
    expect(frame && 'header' in frame && frame.header.ptsObserved).toBe(true)
    // A synthetic-size frame on the processed bridge is a protocol violation.
    const wrong = bridge.request(roomFrameCommand('pull', 7, 3, undefined, size))
    FakeSocket.last!.reply(encodeFrame({ serial: 3 }))
    await expect(wrong).rejects.toThrow('closed')
  })

  it('never mixes roles, sizes or fixture events with the synthetic bridge', async () => {
    const synthetic = new RoomFrameBridge(
      connection,
      () => true,
      () => new FakeSocket() as never
    )
    await expect(
      synthetic.request(roomFrameCommand('open', 1, 1, undefined, size))
    ).rejects.toThrow('role')
    await expect(synthetic.fixture('fixture-switch')).rejects.toThrow('No processed camera')
    const bridge = await openedProcessed()
    await expect(
      bridge.request(roomFrameCommand('pull', 7, 2, undefined, { ...size, width: 640 }))
    ).rejects.toThrow('size changed')
    const event = bridge.fixture('fixture-switch')
    expect(FakeSocket.last!.sent.at(-1)).toMatchObject({
      method: 'room.camera.processed',
      params: { action: 'fixture-switch' }
    })
    FakeSocket.last!.reply(
      JSON.stringify({
        id: FakeSocket.last!.sent.at(-1)!.id,
        ok: true,
        payload: { cameraGeneration: 2 }
      })
    )
    await expect(event).resolves.toEqual({ cameraGeneration: 2 })
    bridge.close()
  })
})
