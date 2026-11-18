import { registerRoomPcmResources } from './room-pcm-test-state'
// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => ({ open: vi.fn(), pcm: vi.fn() }))
vi.mock('livekit-client', () => ({ createLocalAudioTrack: capture.open }))
vi.mock('./room-pcm-source', () => ({ createRoomPcmTestSource: capture.pcm }))
import {
  createRoomMicrophoneSource,
  microphoneRequiresReplacement,
  microphoneProcessingDetail,
  type RoomMicrophoneChoice
} from './room-microphone-source'
import { roomMicrophoneState } from './room-microphone-state'
const choice: RoomMicrophoneChoice = {
  mode: 'browser-aec',
  deviceId: 'chosen',
  name: 'Chosen',
  gainDb: 6,
  muted: false,
  noise: 'rnnoise',
  offsetMs: 0
}
let graphs: FakeContext[]
const node = () => ({
  connect: vi.fn(function (this: unknown, destination: unknown) {
    return destination
  }),
  disconnect: vi.fn()
})
const track = () => {
  const value = Object.assign(new EventTarget(), {
    kind: 'audio',
    readyState: 'live',
    stop: vi.fn()
  })
  value.stop.mockImplementation(() => {
    value.readyState = 'ended'
  })
  return value
}
class FakeContext {
  state = 'running'
  sampleRate = 48000
  gain = { ...node(), gain: { value: 1 } }
  output = {
    ...node(),
    stream: { getAudioTracks: () => [this.track], getTracks: () => [this.track] }
  }
  track = track()
  constructor() {
    graphs.push(this)
  }
  createMediaStreamSource = () => node()
  createGain = () => this.gain
  createAnalyser = () => ({
    ...node(),
    fftSize: 2048,
    getFloatTimeDomainData: (data: Float32Array) => data.fill(this.gain.gain.value === 0 ? 0 : 0.25)
  })
  createDynamicsCompressor = () => ({
    ...node(),
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 }
  })
  createMediaStreamDestination = () => this.output
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {
    this.state = 'closed'
  })
}
beforeEach(() => {
  graphs = []
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  )
  capture.open.mockReset()
  capture.pcm.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('opens only the selected browser device with explicit AEC, applies gain/mute and meters after publication', async () => {
  const raw = { mediaStreamTrack: track(), stop: vi.fn() }
  capture.open.mockResolvedValue(raw)
  const source = await createRoomMicrophoneSource(
    choice,
    'show',
    new AbortController().signal,
    async () => 'exact-id',
    vi.fn()
  )
  expect(capture.open).toHaveBeenCalledWith({
    deviceId: { exact: 'exact-id' },
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false
  })
  expect(graphs[0].gain.gain.value).toBeCloseTo(10 ** 0.3)
  await vi.advanceTimersByTimeAsync(50)
  expect(roomMicrophoneState.getSnapshot().peakDb).toBeNull()
  source.published()
  await vi.advanceTimersByTimeAsync(50)
  expect(roomMicrophoneState.getSnapshot().peakDb).toBeCloseTo(20 * Math.log10(0.25))
  source.update({ ...choice, muted: true })
  await vi.advanceTimersByTimeAsync(50)
  expect(roomMicrophoneState.getSnapshot().peakDb).toBe(-Infinity)
  await source.close()
  expect(raw.stop).toHaveBeenCalled()
  expect(graphs[0].state).toBe('closed')
  expect(vi.getTimerCount()).toBe(0)
})
it('refuses None/missing labels without opening an implicit default device', async () => {
  await expect(
    createRoomMicrophoneSource(
      { ...choice, deviceId: null },
      'show',
      new AbortController().signal,
      vi.fn(),
      vi.fn()
    )
  ).rejects.toThrow('Select')
  await expect(
    createRoomMicrophoneSource(
      choice,
      'show',
      new AbortController().signal,
      async () => undefined,
      vi.fn()
    )
  ).rejects.toThrow('unavailable')
  expect(capture.open).not.toHaveBeenCalled()
})
it('stops a late capture after cancellation and never allocates its graph', async () => {
  let resolve!: (value: unknown) => void
  capture.open.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const controller = new AbortController()
  const pending = createRoomMicrophoneSource(
    choice,
    'show',
    controller.signal,
    async () => 'exact',
    vi.fn()
  )
  await vi.waitFor(() => expect(capture.open).toHaveBeenCalledOnce())
  controller.abort()
  const raw = { mediaStreamTrack: track(), stop: vi.fn() }
  resolve(raw)
  await expect(pending).rejects.toThrow('cancelled')
  expect(raw.stop).toHaveBeenCalled()
  expect(graphs).toHaveLength(0)
})
it('device loss closes the owned graph and reports unavailable rather than a false zero', async () => {
  const raw = { mediaStreamTrack: track(), stop: vi.fn() }
  capture.open.mockResolvedValue(raw)
  const failure = vi.fn()
  const source = await createRoomMicrophoneSource(
    choice,
    'show',
    new AbortController().signal,
    async () => 'exact',
    failure
  )
  source.published()
  raw.mediaStreamTrack.dispatchEvent(new Event('ended'))
  expect(failure).toHaveBeenCalled()
  expect(roomMicrophoneState.getSnapshot().state).toBe('lost')
  expect(roomMicrophoneState.getSnapshot().peakDb).toBeNull()
  await source.close()
})
it('uses new owners only for device/mode/offset changes and labels RNNoise without substitution', () => {
  expect(microphoneRequiresReplacement(choice, { ...choice, gainDb: 0, noise: 'off' })).toBe(false)
  for (const patch of [
    { deviceId: 'next' },
    { mode: 'native-headphones' as const },
    { offsetMs: 100 }
  ])
    expect(microphoneRequiresReplacement(choice, { ...choice, ...patch })).toBe(true)
  expect(microphoneProcessingDetail(choice)).toContain('not replaced')
})
it('native mode serializes settings and pull IPC without opening a browser microphone', async () => {
  const commands: unknown[] = []
  const api = vi.fn(async (command) => {
    commands.push(command)
    return null
  })
  vi.stubGlobal('window', {
    videorc: {
      roomMicrophonePcm: api,
      getRoomNativeMicrophoneResources: async () => ({
        nativeSources: 0,
        sockets: 0,
        ipcRequests: 0,
        timers: 0
      })
    }
  })
  let transport!: (command: {
    action: 'open' | 'pull' | 'close'
    generation: number
    role: 'host-microphone-test'
    sampleRate: 48000
    channels: 1
    frames: 480
  }) => Promise<unknown>
  const wire = (action: 'open' | 'pull' | 'close') => ({
    action,
    generation: 7,
    role: 'host-microphone-test' as const,
    sampleRate: 48000 as const,
    channels: 1 as const,
    frames: 480 as const
  })
  capture.pcm.mockImplementation(async (call) => {
    transport = call
    await call(wire('open'))
    return {
      track: track(),
      close: async () => {
        await call(wire('close'))
      }
    }
  })
  const source = await createRoomMicrophoneSource(
    { ...choice, deviceId: 'microphone:coreaudio:7', mode: 'native-headphones' },
    'show',
    new AbortController().signal,
    vi.fn(),
    vi.fn()
  )
  expect(capture.open).not.toHaveBeenCalled()
  source.update({
    ...choice,
    deviceId: 'microphone:coreaudio:7',
    mode: 'native-headphones',
    gainDb: -6,
    noise: 'off'
  })
  await transport(wire('pull'))
  expect(commands).toEqual([
    expect.objectContaining({
      action: 'open',
      role: 'host-microphone',
      showId: 'show',
      settings: expect.objectContaining({ noise: 'rnnoise', gainDb: 6 })
    }),
    expect.objectContaining({
      action: 'update',
      settings: expect.objectContaining({ noise: 'off', gainDb: -6 })
    }),
    expect.objectContaining({ action: 'pull', generation: 7 })
  ])
  await source.close()
  expect(commands.at(-1)).toEqual(expect.objectContaining({ action: 'close', generation: 7 }))
})

it('refuses a new browser capture while a prior PCM owner has unconfirmed cleanup', async () => {
  const release = registerRoomPcmResources(9001, () => ({
    closeError: 'Missing native close acknowledgement'
  }))
  try {
    await expect(
      createRoomMicrophoneSource(
        choice,
        'show',
        new AbortController().signal,
        async () => 'exact',
        vi.fn()
      )
    ).rejects.toThrow('cleanup is unconfirmed')
    expect(capture.open).not.toHaveBeenCalled()
  } finally {
    release()
  }
})
it('does not acknowledge native cleanup while actual resource inspection still reports capture', async () => {
  capture.pcm.mockResolvedValue({ track: track(), close: vi.fn(async () => {}) })
  vi.stubGlobal('window', {
    videorc: {
      getRoomNativeMicrophoneResources: async () => ({
        nativeSources: 1,
        sockets: 0,
        ipcRequests: 0,
        timers: 0
      })
    }
  })
  const source = await createRoomMicrophoneSource(
    { ...choice, deviceId: 'microphone:coreaudio:7', mode: 'native-headphones' },
    'show',
    new AbortController().signal,
    vi.fn(),
    vi.fn()
  )
  await expect(source.close()).rejects.toThrow('cleanup has not completed')
  expect(capture.open).not.toHaveBeenCalled()
})

it('a replacement client waits for a cancelled late acquisition to dispose its own track', async () => {
  let resolve!: (value: unknown) => void
  const order: string[] = []
  const oldTrack = track(),
    newTrack = track()
  capture.open
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    .mockImplementationOnce(async () => {
      order.push('replacement-open')
      return { mediaStreamTrack: newTrack, stop: () => newTrack.stop() }
    })
  const aborted = new AbortController()
  const old = createRoomMicrophoneSource(
    choice,
    'old-show',
    aborted.signal,
    async () => 'old-exact',
    vi.fn()
  )
  const refused = expect(old).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(capture.open).toHaveBeenCalledOnce())
  aborted.abort()
  const next = createRoomMicrophoneSource(
    choice,
    'new-show',
    new AbortController().signal,
    async () => 'new-exact',
    vi.fn()
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(capture.open).toHaveBeenCalledTimes(1)
  resolve({
    mediaStreamTrack: oldTrack,
    stop: () => {
      oldTrack.stop()
      order.push('old-stopped')
    }
  })
  await refused
  const replacement = await next
  expect(order).toEqual(['old-stopped', 'replacement-open'])
  expect(oldTrack.readyState).toBe('ended')
  expect(newTrack.readyState).toBe('live')
  await replacement.close()
})
