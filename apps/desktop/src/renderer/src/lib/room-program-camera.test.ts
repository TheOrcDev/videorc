// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ROOM_PROGRAM_CAMERA_FRAME_BYTES,
  type RoomProgramCameraSendOutcome
} from '../../../shared/room-program-camera'
import {
  RoomProgramCameraProducer,
  RoomProgramCameraStore,
  nextRoomProgramGeneration,
  type RoomProgramCameraApi
} from './room-program-camera'

// Plan 249 S23 (D10): the per-room opt-in and its producer.

function fakeApi() {
  const calls: string[] = []
  const api: RoomProgramCameraApi = {
    openRoomProgramCamera: vi.fn(async (generation: number) => {
      calls.push(`open ${generation}`)
      return null
    }),
    closeRoomProgramCamera: vi.fn(async (generation: number) => {
      calls.push(`close ${generation}`)
      return null
    }),
    sendRoomProgramCameraFrame: vi.fn(async () => 'sent' as const)
  }
  return { api, calls }
}

/** A connected container with a box (happy-dom lays nothing out). */
function shownContainer(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  element.getBoundingClientRect = () => new DOMRect(0, 0, 320, 180)
  return element
}

function fakeContext(): CanvasRenderingContext2D {
  const data = new Uint8ClampedArray(ROOM_PROGRAM_CAMERA_FRAME_BYTES)
  return {
    save: () => {},
    restore: () => {},
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data, width: 1280, height: 720 })
  } as unknown as CanvasRenderingContext2D
}

afterEach(() => {
  vi.useRealTimers()
})

describe('room program opt-in', () => {
  it('generations only grow, even across a reload', () => {
    expect(nextRoomProgramGeneration(0, 1_000_000)).toBe(1000)
    expect(nextRoomProgramGeneration(1000, 1_000_000)).toBe(1001)
    expect(nextRoomProgramGeneration(5, 9_000)).toBe(9)
  })

  it('is off until the host turns it on, and ends with its room', async () => {
    const { api, calls } = fakeApi()
    let now = 50_000
    const store = new RoomProgramCameraStore(
      () => api,
      () => now
    )
    expect(store.snapshot()).toMatchObject({ on: false, generation: null })
    await store.setOn(true, 'host:a')
    expect(store.snapshot()).toMatchObject({ on: true, generation: 50, hostIdentity: 'host:a' })
    // The same room again: nothing new.
    await store.setOn(true, 'host:a')
    // Still the same room: retire keeps it.
    await store.retire('host:a')
    expect(store.snapshot().on).toBe(true)
    // The room ended.
    now += 10
    await store.retire(null)
    expect(store.snapshot()).toMatchObject({ on: false, generation: null })
    expect(calls).toEqual(['open 50', 'close 50'])
  })

  it('a broken upload reopens once under a new generation, then waits', async () => {
    const { api, calls } = fakeApi()
    let now = 100_000
    const store = new RoomProgramCameraStore(
      () => api,
      () => now
    )
    await store.setOn(true, 'host:a')
    await store.reopen(100)
    expect(store.snapshot()).toMatchObject({ on: true, generation: 101 })
    // A stale generation's report changes nothing.
    await store.reopen(100)
    expect(store.snapshot().generation).toBe(101)
    // A second break within a second: no loop, a plain reason.
    now += 200
    await store.reopen(101)
    expect(store.snapshot()).toMatchObject({ on: true, generation: null })
    expect(store.snapshot().error).toMatch(/lost the room program/)
    expect(calls).toEqual(['open 100', 'open 101'])
  })

  it('a refused open leaves it off with the reason', async () => {
    const { api } = fakeApi()
    api.openRoomProgramCamera = async () => {
      throw new Error('Room program camera is disabled.')
    }
    const store = new RoomProgramCameraStore(() => api)
    await expect(store.setOn(true, 'host:a')).rejects.toThrow('disabled')
    expect(store.snapshot()).toMatchObject({
      on: false,
      error: 'Room program camera is disabled.'
    })
  })
})

describe('room program producer', () => {
  it('sends exact frames with growing sequences, one in flight at a time', async () => {
    const sent: { generation: number; sequence: number; bytes: number }[] = []
    let release: ((outcome: RoomProgramCameraSendOutcome) => void) | null = null
    const container = shownContainer()
    const context = fakeContext()
    const producer = new RoomProgramCameraProducer(7, {
      container: () => container,
      context: () => context,
      send: (frame) => {
        sent.push({
          generation: frame.generation,
          sequence: frame.sequence,
          bytes: frame.pixels.byteLength
        })
        return new Promise((resolve) => {
          release = resolve
        })
      },
      onClosed: () => {}
    })
    producer.tick()
    producer.tick()
    expect(sent).toEqual([{ generation: 7, sequence: 1, bytes: ROOM_PROGRAM_CAMERA_FRAME_BYTES }])
    expect(producer.stats.framesSkipped).toBe(1)
    release!('sent')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    producer.tick()
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2])
    expect(producer.stats.framesSent).toBe(1)
  })

  it('sends nothing while the Program preview is not mounted or not displayed', () => {
    const send = vi.fn(async () => 'sent' as const)
    const hidden = document.createElement('div')
    document.body.append(hidden)
    let container: HTMLElement | null = null
    const producer = new RoomProgramCameraProducer(1, {
      container: () => container,
      context: () => fakeContext(),
      send,
      onClosed: () => {}
    })
    producer.tick()
    // Mounted but without a box (display: none): still nothing.
    container = hidden
    producer.tick()
    expect(send).not.toHaveBeenCalled()
    expect(producer.stats.framesSkipped).toBe(2)
  })

  it('reports a closed upload once and stops', async () => {
    const closed: number[] = []
    const container = shownContainer()
    const producer = new RoomProgramCameraProducer(3, {
      container: () => container,
      context: () => fakeContext(),
      send: async () => 'closed',
      onClosed: (generation) => closed.push(generation)
    })
    producer.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    producer.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toEqual([3])
  })
})
