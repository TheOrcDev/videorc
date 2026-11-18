import { afterEach, expect, it, vi } from 'vitest'
import { roomAudioRouting } from './room-audio-routing'
import { soundboard } from './soundboard-store'
import { createRoomAuxSink } from './room-aux-sink'
const f = vi.hoisted(() => ({ open: vi.fn(), update: vi.fn(), dispose: vi.fn() }))
vi.mock('./room-system-audio-source', () => ({ createRoomSystemAudioSource: f.open }))
vi.mock('./sound-monitor', () => ({
  createSoundMonitor: () => ({ update: f.update, dispose: f.dispose })
}))
const tracks: { stop: ReturnType<typeof vi.fn> }[] = []
const inputs = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
class Context {
  state = 'running'
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
  createMediaStreamDestination = () => {
    const track = { stop: vi.fn() }
    tracks.push(track)
    return {
      channelCount: 0,
      channelCountMode: '',
      stream: { getAudioTracks: () => [track], getTracks: () => [track] }
    }
  }
  createMediaStreamSource = inputs
  close = vi.fn(async () => {
    this.state = 'closed'
  })
}
afterEach(() => {
  roomAudioRouting.reset()
  vi.unstubAllGlobals()
  f.open.mockReset()
  f.update.mockReset()
  inputs.mockClear()
  tracks.length = 0
})
function setup() {
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('MediaStream', class {})
  vi.stubGlobal('window', { videorc: { roomSystemAudioPcm: vi.fn() } })
}
it('Requires explicit system consent and keeps disabled sounds out of the auxiliary sink', async () => {
  setup()
  const sink = createRoomAuxSink(soundboard.getSnapshot(), 'show')
  sink.update(soundboard.getSnapshot())
  expect(f.open).not.toHaveBeenCalled()
  expect(f.update.mock.calls[0][0].voices).toEqual([])
  await sink.close()
  expect(tracks[0].stop).toHaveBeenCalledOnce()
})
it('Stops a late source without connecting it after the room closes', async () => {
  setup()
  let resolve!: (source: { track: MediaStreamTrack; close: () => Promise<void> }) => void
  f.open.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const sink = createRoomAuxSink(soundboard.getSnapshot(), 'show')
  roomAudioRouting.system({ enabled: true })
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce())
  const closing = sink.close(),
    close = vi.fn(async () => {})
  expect(f.open.mock.calls[0][2].aborted).toBe(true)
  resolve({ track: {} as MediaStreamTrack, close })
  await closing
  expect(close).toHaveBeenCalledOnce()
  expect(inputs).not.toHaveBeenCalled()
})
it('Waits for a retired pending source before opening its replacement', async () => {
  setup()
  let resolve!: (source: { track: MediaStreamTrack; close: () => Promise<void> }) => void
  f.open.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const successorClose = vi.fn(async () => {})
  f.open.mockResolvedValueOnce({ track: {}, close: successorClose })
  const sink = createRoomAuxSink(soundboard.getSnapshot(), 'show')
  roomAudioRouting.system({ enabled: true })
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce())
  roomAudioRouting.system({ enabled: false })
  roomAudioRouting.system({ enabled: true })
  expect(f.open).toHaveBeenCalledOnce()
  const close = vi.fn(async () => {})
  resolve({ track: {} as MediaStreamTrack, close })
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2))
  expect(close).toHaveBeenCalledOnce()
  await sink.close()
  expect(successorClose).toHaveBeenCalledOnce()
})
