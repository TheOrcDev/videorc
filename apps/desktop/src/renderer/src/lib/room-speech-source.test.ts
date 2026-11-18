// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { attachHostSpeech } from './room-speech-source'
import type { BackendClient } from '@/backendClient'
let contexts: FakeContext[], nodes: FakeWorklet[]
class FakeContext {
  constructor() {
    contexts.push(this)
  }
  audioWorklet = { addModule: vi.fn(async () => {}) }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
}
class FakeWorklet {
  constructor() {
    nodes.push(this)
  }
  port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: null as null | ((event: unknown) => Promise<void>)
  }
  disconnect = vi.fn()
}
beforeEach(() => {
  contexts = []
  nodes = []
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const tick = async () => {
  await vi.advanceTimersByTimeAsync(1)
}
function fixture(consent = false) {
  const track = { readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack
  let owned = true
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => ({
    uploadAllowed: consent && params.muted !== true && params.published !== false,
    sourceId: params.sourceId,
    reason: 'host-only',
    productionQualified: false
  }))
  const tap = attachHostSpeech(
    { requestTyped: request } as unknown as BackendClient,
    track,
    'show-a',
    false,
    () => owned
  )
  return {
    tap,
    track,
    request,
    consent: (value: boolean) => {
      consent = value
    },
    lose: () => {
      owned = false
    }
  }
}
it('creates no audio graph and sends no PCM while consent is off', async () => {
  const f = fixture()
  await tick()
  expect(contexts).toHaveLength(0)
  expect(f.request.mock.calls.every(([m]) => m === 'cloud.speech.sync')).toBe(true)
  await f.tap.close()
  expect(f.track.stop).not.toHaveBeenCalled()
})
it('reads the processed publication only and immediately stops PCM on mute/owner loss', async () => {
  const f = fixture(true)
  await tick()
  expect(contexts).toHaveLength(1)
  const frame = { data: { sampleRate: 48000, samples: [0.2] } }
  await nodes[0].port.onmessage!(frame)
  expect(f.request.mock.calls.filter(([m]) => m === 'cloud.speech.audio')).toHaveLength(1)
  await f.tap.setMuted(true)
  await nodes[0].port.onmessage!(frame)
  expect(f.request.mock.calls.filter(([m]) => m === 'cloud.speech.audio')).toHaveLength(1)
  await f.tap.setMuted(false)
  f.lose()
  await nodes[0].port.onmessage!(frame)
  expect(f.request.mock.calls.filter(([m]) => m === 'cloud.speech.audio')).toHaveLength(1)
  await f.tap.close()
  expect(contexts[0].close).toHaveBeenCalledOnce()
  expect(f.track.stop).not.toHaveBeenCalled()
})
it('a consent withdrawal during asynchronous worklet loading never connects a source', async () => {
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  const original = FakeContext.prototype.constructor
  const add = vi.fn(() => pending)
  vi.stubGlobal(
    'AudioContext',
    class extends FakeContext {
      override audioWorklet = { addModule: add }
    }
  )
  const f = fixture(true)
  await tick()
  f.lose()
  release()
  await tick()
  await f.tap.close()
  expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled()
  expect(original).toBeDefined()
})
