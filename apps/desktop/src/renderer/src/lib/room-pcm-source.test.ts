import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoomPcmTestSource } from './room-pcm-source'
import { roomPcmTestResources } from './room-pcm-test-state'
import type { RoomPcmCommand, RoomPcmFrame } from '../../../shared/room-pcm'

const fakeTrack = {
  readyState: 'live',
  stop: vi.fn(() => {
    fakeTrack.readyState = 'ended'
  })
}
const track = fakeTrack as unknown as MediaStreamTrack
let context: FakeContext
let node: FakeNode
class FakeContext {
  state = 'running'
  sampleRate = 48000
  audioWorklet = { addModule: vi.fn(async () => {}) }
  destination = {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] },
    disconnect: vi.fn()
  }
  createMediaStreamDestination = () => this.destination
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  constructor() {
    // oxlint-disable-next-line typescript/no-this-alias -- Retain this fake resource to assert ownership cleanup.
    context = this
  }
}
class FakeNode {
  port = {
    onmessage: null as null | ((event: { data: unknown }) => Promise<void>),
    postMessage: vi.fn(),
    close: vi.fn()
  }
  connect = vi.fn()
  disconnect = vi.fn()
  onprocessorerror: null | (() => void) = null
  constructor() {
    // oxlint-disable-next-line typescript/no-this-alias -- Retain this fake resource to assert ownership cleanup.
    node = this
  }
}
beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeNode)
  fakeTrack.readyState = 'live'
  vi.mocked(track.stop).mockClear()
})
afterEach(() => vi.unstubAllGlobals())

it('does not allocate audio when native open is refused', async () => {
  const api = vi.fn(async (command: RoomPcmCommand) => {
    if (command.action === 'open') throw new Error('disabled')
    return null
  })
  const Context = vi.fn()
  vi.stubGlobal('AudioContext', Context)
  await expect(createRoomPcmTestSource(api, new AbortController().signal)).rejects.toThrow(
    'disabled'
  )
  expect(Context).not.toHaveBeenCalled()
})
it('closes a native open cancelled before its acknowledgement', async () => {
  let release!: (frame: RoomPcmFrame | null) => void
  const api = vi.fn((command: RoomPcmCommand) =>
    command.action === 'open'
      ? new Promise<RoomPcmFrame | null>((r) => {
          release = r
        })
      : Promise.resolve(null)
  )
  const controller = new AbortController()
  const opening = createRoomPcmTestSource(api, controller.signal)
  controller.abort()
  release(null)
  await expect(opening).rejects.toThrow('cancelled')
  expect(api.mock.calls.filter(([command]) => command.action === 'close')).toHaveLength(1)
})
it('connects only to the stream destination and closes every owned resource once', async () => {
  const api = vi.fn(async () => null)
  const controller = new AbortController()
  const source = await createRoomPcmTestSource(api, controller.signal)
  expect(node.connect).toHaveBeenCalledExactlyOnceWith(context.destination)
  controller.abort()
  await source.close()
  expect(track.stop).toHaveBeenCalledOnce()
  expect(node.disconnect).toHaveBeenCalledOnce()
  expect(node.port.close).toHaveBeenCalledOnce()
  expect(context.close).toHaveBeenCalledOnce()
  expect(
    roomPcmTestResources().owners.every(
      (owner) =>
        owner.contexts === 0 && owner.worklets === 0 && owner.tracks === 0 && owner.timers === 0
    )
  ).toBe(true)
})
it('allows only one native pull and fails closed on invalid native metadata', async () => {
  let release!: (frame: RoomPcmFrame | null) => void
  const api = vi.fn((command: RoomPcmCommand) =>
    command.action === 'pull'
      ? new Promise<RoomPcmFrame | null>((r) => {
          release = r
        })
      : Promise.resolve(null)
  )
  const failed = vi.fn()
  const source = await createRoomPcmTestSource(api, new AbortController().signal, undefined, failed)
  const generation = api.mock.calls[0][0].generation
  const first = node.port.onmessage?.({ data: { pull: true, generation } })
  await node.port.onmessage?.({ data: { pull: true, generation } })
  expect(api.mock.calls.filter(([command]) => command.action === 'pull')).toHaveLength(1)
  release({ generation: generation - 1 } as RoomPcmFrame)
  await first
  await source.close()
  expect(failed).toHaveBeenCalledOnce()
  expect(track.stop).toHaveBeenCalledOnce()
})

it('projects the common native clock on every native-frame observation', async () => {
  let generation = 0
  const api = vi.fn(async (command: RoomPcmCommand) => {
    generation = command.generation
    if (command.action !== 'pull') return null
    return {
      generation,
      sequence: 3,
      firstSample: 1440,
      firstSampleUs: 30_000,
      observedAtUs: 41_000,
      originUs: 2_000_000,
      incarnation: 77,
      sampleRate: 48000,
      channels: 1,
      frames: 480,
      droppedFrames: 0,
      samples: Array(480).fill(0)
    } as RoomPcmFrame
  })
  const observed: Record<string, unknown>[] = []
  const source = await createRoomPcmTestSource(
    api,
    new AbortController().signal,
    (value) => observed.push(value as Record<string, unknown>),
    undefined,
    'processed'
  )
  await node.port.onmessage?.({ data: { pull: true, generation } })
  expect(observed.find((value) => value.phase === 'native-frame')).toMatchObject({
    originUs: 2_000_000,
    incarnation: 77,
    nativeCaptureUs: 2_030_000,
    timeline: 'processed'
  })
  await source.close()
})
