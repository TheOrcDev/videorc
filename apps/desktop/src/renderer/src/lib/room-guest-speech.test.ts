// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachGuestSpeech } from './room-guest-speech'
import type { BackendClient } from '@/backendClient'

let contexts: FakeContext[], nodes: FakeWorklet[]
class FakeContext {
  constructor() {
    contexts.push(this)
  }
  audioWorklet = { addModule: vi.fn(async () => {}) }
  createGain = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
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
const tick = async (ms = 1) => {
  await vi.advanceTimersByTimeAsync(ms)
}
const guestTrack = (id: string) =>
  ({ id, readyState: 'live', stop: vi.fn() }) as unknown as MediaStreamTrack

function fixture(captionsOn = true) {
  let owned = true
  const captioning: boolean[] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const allowed =
      captionsOn && (method !== 'cloud.speech.guests.sync' || Number(params.guests) > 0)
    return { uploadAllowed: allowed, captioning: allowed, reason: 'guests-captions-only' }
  })
  const tap = attachGuestSpeech(
    { requestTyped: request } as unknown as BackendClient,
    'show-a',
    () => owned,
    (value) => captioning.push(value)
  )
  return {
    tap,
    request,
    captioning,
    methods: () => request.mock.calls.map(([method]) => method),
    lose: () => {
      owned = false
    }
  }
}

it('guest audio only ever uses the captions-only guest RPCs, never the host speech ones', async () => {
  const f = fixture()
  f.tap.setSources([guestTrack('a'), guestTrack('b')])
  await tick(300)
  await nodes[0].port.onmessage!({ data: { sampleRate: 48000, samples: [0.2] } })
  await f.tap.close()
  expect(f.methods().length).toBeGreaterThan(2)
  for (const method of f.methods())
    expect(['cloud.speech.guests.sync', 'cloud.speech.guests.audio']).toContain(method)
  expect(f.methods()).not.toContain('cloud.speech.sync')
  expect(f.methods()).not.toContain('cloud.speech.audio')
})

it('mixes every guest into one stream and one audio graph', async () => {
  const f = fixture()
  f.tap.setSources([guestTrack('a'), guestTrack('b'), guestTrack('c')])
  await tick(300)
  expect(contexts).toHaveLength(1)
  expect(nodes).toHaveLength(1)
  expect(contexts[0].createMediaStreamSource).toHaveBeenCalledTimes(3)
  const syncs = f.request.mock.calls.filter(([method]) => method === 'cloud.speech.guests.sync')
  expect(syncs.at(-1)![1]).toMatchObject({ showId: 'show-a', guests: 3 })
  expect(f.captioning).toEqual([true])
  await f.tap.close()
})

it('builds nothing and asks for no stream without guest audio', async () => {
  const f = fixture()
  await tick(600)
  expect(contexts).toHaveLength(0)
  const syncs = f.request.mock.calls.filter(([method]) => method === 'cloud.speech.guests.sync')
  expect(syncs.length).toBeGreaterThan(1)
  expect(syncs.every(([, params]) => params.guests === 0)).toBe(true)
  expect(f.captioning).toEqual([])
  await f.tap.close()
})

it('the last guest leaving or a lost room tells the backend zero guests at once', async () => {
  const f = fixture()
  f.tap.setSources([guestTrack('a')])
  await tick(300)
  expect(f.captioning).toEqual([true])
  f.tap.setSources([])
  await tick(300)
  const syncs = f.request.mock.calls.filter(([method]) => method === 'cloud.speech.guests.sync')
  expect(syncs.at(-1)![1]).toMatchObject({ guests: 0 })
  expect(f.captioning).toEqual([true, false])
  // No PCM leaves once the guests are gone.
  const sent = f.methods().filter((method) => method === 'cloud.speech.guests.audio').length
  await nodes[0].port.onmessage!({ data: { sampleRate: 48000, samples: [0.2] } })
  expect(f.methods().filter((method) => method === 'cloud.speech.guests.audio')).toHaveLength(sent)
  f.tap.setSources([guestTrack('a')])
  f.lose()
  await tick(300)
  expect(
    f.request.mock.calls.filter(([method]) => method === 'cloud.speech.guests.sync').at(-1)![1]
  ).toMatchObject({ guests: 0 })
  await f.tap.close()
  expect(contexts[0].close).toHaveBeenCalledOnce()
})

it('captions off never opens the mix, even with guests on stage', async () => {
  const f = fixture(false)
  f.tap.setSources([guestTrack('a')])
  await tick(600)
  expect(contexts).toHaveLength(0)
  expect(f.methods()).not.toContain('cloud.speech.guests.audio')
  await f.tap.close()
})
