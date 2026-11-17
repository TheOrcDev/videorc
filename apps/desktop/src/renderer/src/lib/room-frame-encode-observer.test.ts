import { describe, expect, it, vi } from 'vitest'

import {
  ENCODE_OBSERVER_API,
  attachEncodeObserver,
  type EncodeObserverRuntime,
  type WorkerLike
} from './room-frame-encode-observer'
import {
  createEncodeRecorder,
  encodedPassThrough,
  installEncodeWorker,
  recordEncodedFrame,
  type EncodeWorkerReply,
  type EncodeWorkerScope
} from './room-frame-encode-worker'

// Plan 249 S13a harness: the encoded-output observer of the camera bridge.
// `RTCRtpScriptTransform`, the worker and the sender are fakes; the rules
// under test are this module's own (no fallback, fencing, bounds, cleanup).

class FakeWorker implements WorkerLike {
  posted: unknown[] = []
  terminated = 0
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  terminate(): void {
    this.terminated++
  }
}

function harness(overrides: Partial<EncodeObserverRuntime> = {}) {
  const worker = new FakeWorker()
  const transforms: { worker: unknown; options: unknown }[] = []
  class FakeScriptTransform {
    constructor(worker: unknown, options: unknown) {
      transforms.push({ worker, options })
    }
  }
  let clock = 100
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = []
  const runtime: EncodeObserverRuntime = {
    ScriptTransform: FakeScriptTransform as never,
    createWorker: vi.fn(() => worker),
    now: () => clock,
    timeOrigin: 1_000_000,
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return timer as never
    },
    cancel: (timer) => {
      ;(timer as unknown as { cancelled: boolean }).cancelled = true
    },
    ...overrides
  }
  const sender = { transform: null as unknown } as unknown as RTCRtpSender & { transform: unknown }
  const observed: Record<string, unknown>[] = []
  const observe = (value: unknown) => observed.push(value as Record<string, unknown>)
  const runDue = () => {
    const due = timers.filter((timer) => !timer.cancelled)
    timers.length = 0
    for (const timer of due) timer.callback()
  }
  return {
    worker,
    transforms,
    runtime,
    sender,
    observed,
    observe,
    runDue,
    setClock: (value: number) => {
      clock = value
    }
  }
}

const drained = (
  generation: number,
  records: { atEpochMs: number; rtpTimestamp: number }[],
  extra: Partial<Extract<EncodeWorkerReply, { type: 'drained' }>> = {}
): Extract<EncodeWorkerReply, { type: 'drained' }> => ({
  type: 'drained',
  generation,
  transformGeneration: generation,
  records: records.map((record) => ({
    ...recordEncodedFrame({ timestamp: record.rtpTimestamp, type: 'delta' }, record.atEpochMs)
  })),
  dropped: 0,
  recorded: records.length,
  workerEpochMs: 1_000_105,
  ...extra
})

describe('encode observer attach (renderer)', () => {
  it('is unavailable without RTCRtpScriptTransform: no worker, sender untouched', () => {
    const h = harness({ ScriptTransform: null })
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    expect(observer.status).toBe('unavailable')
    expect(observer.reason).toMatch(/^RTCRtpScriptTransform is not defined/)
    expect(observer.reason).toContain('createEncodedStreams is not used')
    expect(h.runtime.createWorker).not.toHaveBeenCalled()
    expect(h.sender.transform).toBeNull()
    expect(h.observed).toEqual([
      expect.objectContaining({ phase: 'encode-observer', status: 'unavailable', generation: 7 })
    ])
  })

  it('is unavailable without a sender and never throws', async () => {
    const h = harness()
    const observer = attachEncodeObserver(undefined, 7, h.observe, h.runtime)
    expect(observer.status).toBe('unavailable')
    expect(observer.reason).toContain('LocalTrack.sender')
    expect(h.runtime.createWorker).not.toHaveBeenCalled()
    await expect(observer.detach()).resolves.toBeUndefined()
  })

  it('a refused transform terminates the worker and reports the API', () => {
    const h = harness({
      ScriptTransform: class {
        constructor() {
          throw new Error('not allowed')
        }
      } as never
    })
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    expect(observer.status).toBe('unavailable')
    expect(observer.reason).toContain('not allowed')
    expect(h.worker.terminated).toBe(1)
  })

  it('attaches the transform, drains with a measured bracket and detaches once', async () => {
    const h = harness()
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    expect(observer.status).toBe('observing')
    expect(h.transforms).toEqual([{ worker: h.worker, options: { generation: 7 } }])
    expect(h.sender.transform).toBeTruthy()
    h.setClock(100)
    h.runDue()
    expect(h.worker.posted).toEqual([{ type: 'drain', generation: 7 }])
    h.setClock(110)
    h.worker.onmessage!({
      data: drained(7, [{ atEpochMs: 1_000_090, rtpTimestamp: 3000 }])
    })
    const encoded = h.observed.find((value) => value.phase === 'encoded')!
    expect(encoded).toMatchObject({
      generation: 7,
      observed: 'renderer-encoded-transform',
      dropped: 0,
      productionQualified: false,
      records: [expect.objectContaining({ atMs: 90, rtpTimestamp: 3000, type: 'delta' })],
      bracket: {
        sentAtMs: 100,
        workerAtMs: 105,
        receivedAtMs: 110,
        timeOriginBracketMs: { lowMs: -5, highMs: 5 },
        originsAgree: true
      }
    })

    const worker = h.worker
    const done = observer.detach()
    expect(observer.detach()).toBe(done)
    // The transform leaves the sender synchronously, before the worker stops.
    expect(h.sender.transform).toBeNull()
    expect(worker.posted).toHaveLength(2)
    worker.onmessage!({ data: drained(7, []) })
    await done
    expect(worker.terminated).toBe(1)
    expect(worker.onmessage).toBeNull()
    expect(h.observed.at(-1)).toMatchObject({
      phase: 'encode-observer',
      status: 'detached',
      drains: 2,
      records: 1
    })
    await observer.detach()
    expect(worker.terminated).toBe(1)
  })

  it('a final drain that never answers still terminates after its bound', async () => {
    const h = harness()
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    const done = observer.detach()
    h.runDue()
    await done
    expect(h.worker.terminated).toBe(1)
  })

  it('ignores messages from another generation and records from a foreign transform', () => {
    const h = harness()
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    const handler = h.worker.onmessage!
    h.runDue()
    handler({ data: drained(6, [{ atEpochMs: 1_000_050, rtpTimestamp: 1 }]) })
    expect(h.observed.some((value) => value.phase === 'encoded')).toBe(false)
    handler({
      data: drained(7, [{ atEpochMs: 1_000_050, rtpTimestamp: 1 }], {
        transformGeneration: 6,
        dropped: 1
      })
    })
    expect(h.observed.find((value) => value.phase === 'encoded')).toMatchObject({
      records: [],
      dropped: 1
    })
    void observer.detach()
  })

  it('ignores a late message after detach', async () => {
    const h = harness()
    const observer = attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    const handler = h.worker.onmessage!
    const done = observer.detach()
    handler({ data: drained(7, []) })
    await done
    const before = h.observed.length
    handler({ data: drained(7, [{ atEpochMs: 1_000_050, rtpTimestamp: 1 }]) })
    handler({ data: { type: 'transform-error', generation: 7, reason: 'late' } })
    expect(h.observed).toHaveLength(before)
  })

  it('reports the API name and a transform error without throwing', () => {
    const h = harness()
    attachEncodeObserver(h.sender, 7, h.observe, h.runtime)
    h.worker.onmessage!({ data: { type: 'transform-started', generation: 7 } })
    h.worker.onmessage!({ data: { type: 'transform-error', generation: 7, reason: 'boom' } })
    expect(h.observed).toContainEqual(
      expect.objectContaining({ api: ENCODE_OBSERVER_API, status: 'observing' })
    )
    expect(h.observed).toContainEqual(
      expect.objectContaining({
        status: 'unavailable',
        reason: 'Encoded transform pipe failed: boom'
      })
    )
  })
})

describe('encode observer worker logic', () => {
  it('records only what the frame reports and copies primitive metadata', () => {
    const record = recordEncodedFrame(
      {
        timestamp: 90_000,
        type: 'key',
        data: { byteLength: 1234 },
        getMetadata: () => ({
          rtpTimestamp: 91_000,
          frameId: 5,
          dependencies: [4],
          width: 1288,
          contributingSources: []
        })
      },
      42
    )
    expect(record).toEqual({
      rtpTimestamp: 91_000,
      rtpTimestampSource: 'metadata.rtpTimestamp',
      timestamp: 90_000,
      type: 'key',
      byteLength: 1234,
      frameId: 5,
      metadata: { rtpTimestamp: 91_000, frameId: 5, width: 1288 },
      metadataKeys: ['rtpTimestamp', 'frameId', 'dependencies', 'width', 'contributingSources'],
      metadataError: null,
      atEpochMs: 42
    })
    const bare = recordEncodedFrame(
      {
        timestamp: 7,
        getMetadata: () => {
          throw new Error('gone')
        }
      },
      1
    )
    expect(bare).toMatchObject({
      rtpTimestamp: 7,
      rtpTimestampSource: 'frame.timestamp',
      metadataError: 'gone'
    })
  })

  it('bounds the ring and counts dropped records cumulatively', () => {
    let t = 0
    const recorder = createEncodeRecorder(3, () => ++t)
    for (let i = 0; i < 5; i++) recorder.record({ timestamp: i })
    expect(recorder.size).toBe(3)
    const first = recorder.drain()
    expect(first.records.map((record) => record.timestamp)).toEqual([2, 3, 4])
    expect(first).toMatchObject({ dropped: 2, recorded: 5 })
    recorder.record({ timestamp: 5 })
    expect(recorder.drain()).toMatchObject({ dropped: 2, recorded: 6 })
    expect(recorder.drain().records).toEqual([])
  })

  it('passes the SAME frame through unchanged even if recording throws', () => {
    const frame = { timestamp: 1, type: 'delta', data: { byteLength: 3 } }
    const snapshot = structuredClone(frame)
    const enqueued: unknown[] = []
    const errors: string[] = []
    const ok = encodedPassThrough(createEncodeRecorder(4, () => 1))
    ok.transform(frame, { enqueue: (value) => enqueued.push(value) })
    const broken = encodedPassThrough(
      {
        record: () => {
          throw new Error('full')
        }
      },
      (reason) => errors.push(reason)
    )
    broken.transform(frame, { enqueue: (value) => enqueued.push(value) })
    expect(enqueued).toEqual([frame, frame])
    expect(enqueued[0]).toBe(frame)
    expect(enqueued[1]).toBe(frame)
    expect(frame).toEqual(snapshot)
    expect(errors).toEqual(['full'])
  })

  it('pipes rtctransform frames through and answers drains with its generation', async () => {
    const posted: EncodeWorkerReply[] = []
    const scope: EncodeWorkerScope = {
      postMessage: (message) => posted.push(message),
      onmessage: null,
      onrtctransform: null
    }
    installEncodeWorker(
      scope,
      createEncodeRecorder(8, () => 5),
      () => 9
    )
    const frames = [{ timestamp: 3000, type: 'key' }, { timestamp: 6000 }]
    const out: unknown[] = []
    const readable = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame)
        controller.close()
      }
    })
    const writable = new WritableStream({ write: (frame) => void out.push(frame) })
    scope.onrtctransform!({ transformer: { readable, writable, options: { generation: 7 } } })
    await vi.waitFor(() => expect(out).toHaveLength(2))
    expect(out[0]).toBe(frames[0])
    expect(out[1]).toBe(frames[1])
    scope.onmessage!({ data: { type: 'drain', generation: 7 } })
    scope.onmessage!({ data: { type: 'bogus' } })
    expect(posted[0]).toEqual({ type: 'transform-started', generation: 7 })
    expect(posted[1]).toMatchObject({
      type: 'drained',
      generation: 7,
      transformGeneration: 7,
      dropped: 0,
      recorded: 2,
      workerEpochMs: 9
    })
    expect(posted).toHaveLength(2)
  })
})
