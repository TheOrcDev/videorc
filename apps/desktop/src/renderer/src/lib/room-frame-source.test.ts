import { describe, expect, it, vi } from 'vitest'
import { createRoomFrameTestSource, type RoomFrameApi } from './room-frame-source'
import { roomFrameTestResources } from './room-frame-test-state'
import {
  ROOM_FRAME,
  ROOM_FRAME_PAYLOAD_BYTES,
  framePtsUs,
  type RoomFrameCommand,
  type RoomFrameReply
} from '../../../shared/room-frame'

function frameReply(command: RoomFrameCommand, sequence: number, surfaceEpoch = 1): RoomFrameReply {
  return {
    header: {
      serial: command.serial,
      packed: true,
      width: ROOM_FRAME.packedWidth,
      height: ROOM_FRAME.height,
      surfaceEpoch,
      leaseSlot: 0,
      generation: command.generation,
      sequence,
      ptsUs: framePtsUs(sequence),
      observedAtUs: framePtsUs(sequence) + 100,
      originUs: 5_000,
      incarnation: 11,
      droppedFrames: 0,
      leaseStalls: 0
    },
    pixels: new Uint8Array(ROOM_FRAME_PAYLOAD_BYTES)
  }
}

class FakeGenerator {
  readyState: 'live' | 'ended' = 'live'
  contentHint = ''
  written: { timestamp: number; closed: boolean }[] = []
  failNext = 0
  writable = {
    getWriter: () => ({
      write: async (frame: { timestamp: number; closed: boolean }) => {
        if (this.failNext > 0) {
          this.failNext--
          throw new Error('encoder lost')
        }
        this.written.push(frame)
      },
      close: async () => {}
    })
  }
  stop(): void {
    this.readyState = 'ended'
  }
}
class FakeVideoFrame {
  closed = false
  timestamp: number
  constructor(_data: BufferSource, init: { timestamp: number }) {
    this.timestamp = init.timestamp
  }
  close(): void {
    this.closed = true
  }
}

function harness(script: (command: RoomFrameCommand, pulls: number) => RoomFrameReply) {
  const commands: RoomFrameCommand[] = []
  const made: FakeGenerator[] = []
  let pulls = 0
  const queue: (() => void)[] = []
  const api: RoomFrameApi = async (command) => {
    commands.push(command)
    if (command.action === 'open')
      return { generation: command.generation, surfaceEpoch: 1, originUs: 5_000, incarnation: 11 }
    if (command.action === 'close') return null
    if (command.action === 'reset')
      return { generation: command.generation, surfaceEpoch: 2, revokedLeases: 1 }
    return script(command, pulls++)
  }
  const runtime = {
    Generator: class extends FakeGenerator {
      constructor() {
        super()
        made.push(this)
      }
    } as never,
    VideoFrame: FakeVideoFrame as never,
    now: () => 0,
    schedule: (callback: () => void) => {
      queue.push(callback)
      return queue.length as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => {
      queue.length = 0
    }
  }
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const next = queue.shift()
      next?.()
      await vi.waitFor(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return { commands, api, runtime, step, generator: () => made.at(-1)! }
}

describe('room frame test source', () => {
  it('refuses a runtime without a timestamp-preserving generator', async () => {
    await expect(
      createRoomFrameTestSource(
        async () => null,
        new AbortController().signal,
        undefined,
        undefined,
        {
          Generator: undefined,
          VideoFrame: undefined
        }
      )
    ).rejects.toThrow('unsupported')
  })

  it('encodes native pts, releases each lease on the next pull and closes every resource', async () => {
    const h = harness((command, pulls) =>
      pulls === 1
        ? { frame: null, reason: 'not-due', staleReleases: 0, leaseStalls: 0 }
        : frameReply(command, pulls)
    )
    const observed: Record<string, unknown>[] = []
    const source = await createRoomFrameTestSource(
      h.api,
      new AbortController().signal,
      (value) => observed.push(value as Record<string, unknown>),
      undefined,
      h.runtime
    )
    await h.step(3)
    expect(h.generator().written.map((frame) => frame.timestamp)).toEqual([
      framePtsUs(0),
      framePtsUs(2)
    ])
    expect(h.generator().written.every((frame) => frame.closed)).toBe(true)
    const pulls = h.commands.filter((command) => command.action === 'pull')
    expect(pulls[0]!.release).toBeUndefined()
    expect(pulls[1]!.release).toEqual({ sequence: 0, surfaceEpoch: 1 })
    expect(pulls[2]!.release).toBeUndefined()
    const native = observed.find((value) => value.phase === 'native-frame')!
    expect(native.nativeCaptureUs).toBe(5_000)
    expect(native.incarnation).toBe(11)
    await source.close()
    expect(h.commands.at(-1)!.action).toBe('close')
    expect(h.generator().readyState).toBe('ended')
    expect(
      roomFrameTestResources().owners.find((owner) => owner.generation === source.generation)
    ).toBeUndefined()
  })

  it('resets the native surface after an encode failure and stops after repeated failures', async () => {
    const h = harness((command, pulls) => frameReply(command, pulls, pulls === 0 ? 1 : 2))
    const failures: string[] = []
    const source = await createRoomFrameTestSource(
      h.api,
      new AbortController().signal,
      undefined,
      (reason) => failures.push(reason),
      h.runtime
    )
    h.generator().failNext = 1
    await h.step(1)
    expect(h.commands.map((c) => c.action)).toEqual(['open', 'pull', 'reset'])
    await h.step(1)
    expect(h.generator().written).toHaveLength(1)
    h.generator().failNext = 99
    await h.step(6)
    expect(failures[0]).toContain('repeatedly')
    await source.close()
    expect(h.generator().readyState).toBe('ended')
  })

  it('never encodes a frame from an older surface epoch', async () => {
    const h = harness((command) => frameReply(command, 1, 1))
    const source = await createRoomFrameTestSource(
      h.api,
      new AbortController().signal,
      undefined,
      undefined,
      h.runtime
    )
    await source.resetSurface()
    await h.step(2)
    expect(h.generator().written).toHaveLength(0)
    await source.close()
  })

  it('cancellation retires the generation and a replacement opens a new one', async () => {
    const h = harness((command, pulls) => frameReply(command, pulls))
    const controller = new AbortController()
    const first = await createRoomFrameTestSource(
      h.api,
      controller.signal,
      undefined,
      undefined,
      h.runtime
    )
    controller.abort()
    await vi.waitFor(() => expect(h.commands.at(-1)!.action).toBe('close'))
    const second = await createRoomFrameTestSource(
      h.api,
      new AbortController().signal,
      undefined,
      undefined,
      h.runtime
    )
    expect(second.generation).toBeGreaterThan(first.generation)
    await second.close()
  })
})
