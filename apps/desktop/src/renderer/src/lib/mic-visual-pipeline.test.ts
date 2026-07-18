import { describe, expect, it, vi } from 'vitest'

import {
  createMicVisualFrameBuffer,
  createMicVisualPipeline,
  resampleMicVisualLevels,
  resampleMicVisualLevelsInto,
  type MicVisualAudioContextLike,
  type MicVisualPipelineDependencies
} from './mic-visual-pipeline'

type TestStream = {
  getTracks: () => Array<{ stop: () => void }>
}

function pipelineHarness(): {
  dependencies: MicVisualPipelineDependencies<TestStream>
  getUserMedia: ReturnType<typeof vi.fn>
  contexts: Array<MicVisualAudioContextLike<TestStream> & { close: ReturnType<typeof vi.fn> }>
  frames: Array<(at: number) => void>
  microtasks: Array<() => void>
  cancelFrame: ReturnType<typeof vi.fn>
  stoppedTracks: ReturnType<typeof vi.fn>
} {
  const stoppedTracks = vi.fn()
  const stream: TestStream = { getTracks: () => [{ stop: stoppedTracks }] }
  const getUserMedia = vi.fn(async () => stream)
  const contexts: Array<
    MicVisualAudioContextLike<TestStream> & { close: ReturnType<typeof vi.fn> }
  > = []
  const frames: Array<(at: number) => void> = []
  const microtasks: Array<() => void> = []
  const cancelFrame = vi.fn()

  return {
    getUserMedia,
    contexts,
    frames,
    microtasks,
    cancelFrame,
    stoppedTracks,
    dependencies: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' }
        ],
        getUserMedia
      },
      createAudioContext: () => {
        const analyser = {
          fftSize: 2048,
          frequencyBinCount: 1024,
          smoothingTimeConstant: 0,
          getFloatFrequencyData: vi.fn((samples: Float32Array) => samples.fill(-60)),
          getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.25))
        }
        const context = {
          sampleRate: 48_000,
          createAnalyser: () => analyser,
          createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
          close: vi.fn(async () => undefined)
        }
        contexts.push(context)
        return context
      },
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame,
      queueMicrotask: (callback) => microtasks.push(callback)
    }
  }
}

function retainedPipeline(dependencies: MicVisualPipelineDependencies<TestStream>) {
  const pipeline = createMicVisualPipeline(dependencies)
  pipeline.retain()
  return pipeline
}

describe('createMicVisualPipeline', () => {
  it('shares one stream, AudioContext, and frame clock for repeated consumers of one device', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)
    const source = {
      selectionKey: 'backend-mic-1',
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted' as const
    }

    pipeline.configure(source)
    pipeline.configure(source)
    pipeline.configure(source)

    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1)
    expect(harness.frames).toHaveLength(1)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
  })

  it('keeps the same resources across a StrictMode cleanup and immediate setup', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)
    const source = {
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted' as const
    }

    pipeline.configure(source)
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    pipeline.configure({ ...source, enabled: false })
    pipeline.configure(source)
    harness.microtasks.splice(0).forEach((callback) => callback())

    expect(harness.getUserMedia).toHaveBeenCalledTimes(1)
    expect(harness.contexts[0].close).not.toHaveBeenCalled()
    expect(harness.stoppedTracks).not.toHaveBeenCalled()
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
  })

  it('releases the old device before switching the shared pipeline to a new one', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)

    pipeline.configure({
      selectionKey: 'backend-mic-1',
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    harness.frames[0](48)
    expect(pipeline.getFrameSnapshot().bands).toHaveLength(32)

    pipeline.configure({
      selectionKey: 'backend-mic-2',
      // Two native devices can expose the same browser label; the backend id
      // remains the selected-device truth for lifecycle switching.
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2))

    expect(harness.getUserMedia).toHaveBeenCalledTimes(2)
    expect(harness.contexts[0].close).toHaveBeenCalledTimes(1)
    expect(harness.stoppedTracks).toHaveBeenCalledTimes(1)
    expect(harness.cancelFrame).toHaveBeenCalledTimes(1)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
  })

  it('keeps the current visual resources live until a deferred replacement is ready', async () => {
    const harness = pipelineHarness()
    const firstTrackStop = vi.fn()
    const secondTrackStop = vi.fn()
    const firstStream: TestStream = { getTracks: () => [{ stop: firstTrackStop }] }
    const secondStream: TestStream = { getTracks: () => [{ stop: secondTrackStop }] }
    let resolveReplacement: ((stream: TestStream) => void) | undefined
    const getUserMedia = vi
      .fn<() => Promise<TestStream>>()
      .mockResolvedValueOnce(firstStream)
      .mockImplementationOnce(
        () =>
          new Promise<TestStream>((resolve) => {
            resolveReplacement = resolve
          })
      )
    if (harness.dependencies.mediaDevices) {
      harness.dependencies.mediaDevices.getUserMedia = getUserMedia
    }
    const pipeline = retainedPipeline(harness.dependencies)

    pipeline.configure({
      selectionKey: 'backend-mic-1',
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    const activeClock = harness.frames.at(-1)
    expect(activeClock).toBeTypeOf('function')
    activeClock?.(48)
    expect(pipeline.getFrameSnapshot().bands).toHaveLength(32)

    pipeline.configure({
      selectionKey: 'backend-mic-2',
      deviceName: 'USB microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(resolveReplacement).toBeTypeOf('function'))

    expect(harness.contexts[0].close).not.toHaveBeenCalled()
    expect(firstTrackStop).not.toHaveBeenCalled()
    expect(harness.cancelFrame).not.toHaveBeenCalled()
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
    expect(pipeline.getFrameSnapshot().bands).toHaveLength(32)

    resolveReplacement?.(secondStream)
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2))

    expect(harness.contexts[0].close).toHaveBeenCalledTimes(1)
    expect(firstTrackStop).toHaveBeenCalledTimes(1)
    expect(secondTrackStop).not.toHaveBeenCalled()
    expect(harness.cancelFrame).toHaveBeenCalledTimes(1)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
    expect(pipeline.getFrameSnapshot().bands).toHaveLength(32)
  })

  it('stops a superseded late replacement without publishing or analysing it', async () => {
    const harness = pipelineHarness()
    const firstTrackStop = vi.fn()
    const supersededTrackStop = vi.fn()
    const finalTrackStop = vi.fn()
    let resolveSuperseded: ((stream: TestStream) => void) | undefined
    const getUserMedia = vi
      .fn<() => Promise<TestStream>>()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: firstTrackStop }] })
      .mockImplementationOnce(
        () =>
          new Promise<TestStream>((resolve) => {
            resolveSuperseded = resolve
          })
      )
      .mockResolvedValueOnce({ getTracks: () => [{ stop: finalTrackStop }] })
    if (harness.dependencies.mediaDevices) {
      harness.dependencies.mediaDevices.getUserMedia = getUserMedia
    }
    const pipeline = retainedPipeline(harness.dependencies)

    pipeline.configure({
      selectionKey: 'backend-mic-1',
      deviceName: 'Mic 1',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    pipeline.configure({
      selectionKey: 'backend-mic-2',
      deviceName: 'Mic 2',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(resolveSuperseded).toBeTypeOf('function'))
    pipeline.configure({
      selectionKey: 'backend-mic-3',
      deviceName: 'Mic 3',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2))

    resolveSuperseded?.({ getTracks: () => [{ stop: supersededTrackStop }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(supersededTrackStop).toHaveBeenCalledTimes(1)
    expect(harness.contexts).toHaveLength(2)
    expect(firstTrackStop).toHaveBeenCalledTimes(1)
    expect(finalTrackStop).not.toHaveBeenCalled()
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
  })

  it('publishes spectrum, rolling level history, and peak dB from its single clock', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)
    const onFrame = vi.fn()
    pipeline.subscribeFrame(onFrame)

    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1))
    harness.frames[0](48)

    const snapshot = pipeline.getFrameSnapshot()
    expect(snapshot.bands).toHaveLength(32)
    expect(snapshot.bands.every((level) => level > 0 && level <= 1)).toBe(true)
    // One frame is sampled before the session is published, then the shared
    // clock appends its first scheduled sample.
    expect(snapshot.history).toHaveLength(2)
    expect(snapshot.history[0]).toBeGreaterThan(0)
    expect(snapshot.peakDb).toBeCloseTo(-12.04, 1)
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(harness.frames).toHaveLength(2)
  })

  it('reuses caller-owned frame and resample buffers while snapshots stay stable', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)
    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1))

    const frameBuffer = createMicVisualFrameBuffer()
    const bands = frameBuffer.bands
    const resampled = new Array<number>(5).fill(0)
    let historyRing: Float32Array | undefined
    for (let index = 1; index <= 80; index += 1) {
      harness.frames.at(-1)?.(index * 48)
      expect(pipeline.readFrame(frameBuffer)).toBe(frameBuffer)
      expect(frameBuffer.bands).toBe(bands)
      historyRing ??= frameBuffer.historyRing
      expect(frameBuffer.historyRing).toBe(historyRing)
      expect(resampleMicVisualLevelsInto(frameBuffer.bands, resampled)).toBe(resampled)
    }

    expect(historyRing).toBeInstanceOf(Float32Array)
    expect(frameBuffer.historyLength).toBe(60)
    const stableSnapshot = pipeline.getFrameSnapshot()
    const stableHistory = Array.from(stableSnapshot.history)
    harness.frames.at(-1)?.(81 * 48)
    expect(stableSnapshot.history).toEqual(stableHistory)
  })

  it('releases every visual resource when the workspace becomes hidden', async () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)

    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1))
    harness.frames[0](48)

    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: false,
      permissionStatus: 'granted'
    })
    harness.microtasks.splice(0).forEach((callback) => callback())

    expect(harness.contexts[0].close).toHaveBeenCalledTimes(1)
    expect(harness.stoppedTracks).toHaveBeenCalledTimes(1)
    expect(harness.cancelFrame).toHaveBeenCalledTimes(1)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'idle', active: false })
    expect(pipeline.getFrameSnapshot()).toEqual({ bands: [], history: [], peakDb: null })
  })

  it('never turns a visual meter into an implicit microphone permission request', () => {
    const harness = pipelineHarness()
    const pipeline = retainedPipeline(harness.dependencies)

    for (const permissionStatus of [
      'not-determined',
      'denied',
      'restricted',
      'unknown',
      undefined
    ] as const) {
      pipeline.configure({
        deviceName: 'Studio microphone',
        enabled: true,
        permissionStatus
      })
    }
    harness.microtasks.splice(0).forEach((callback) => callback())

    expect(harness.getUserMedia).not.toHaveBeenCalled()
    expect(harness.contexts).toHaveLength(0)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'idle', active: false })
  })

  it('stops a stream that resolves after visibility cleanup instead of reviving it', async () => {
    const harness = pipelineHarness()
    const lateTrackStop = vi.fn()
    let resolveStream: ((stream: TestStream) => void) | undefined
    if (harness.dependencies.mediaDevices) {
      harness.dependencies.mediaDevices.getUserMedia = () =>
        new Promise<TestStream>((resolve) => {
          resolveStream = resolve
        })
    }
    const pipeline = retainedPipeline(harness.dependencies)

    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(resolveStream).toBeTypeOf('function'))
    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: false,
      permissionStatus: 'granted'
    })
    harness.microtasks.splice(0).forEach((callback) => callback())
    resolveStream?.({ getTracks: () => [{ stop: lateTrackStop }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(lateTrackStop).toHaveBeenCalledTimes(1)
    expect(harness.contexts).toHaveLength(0)
    expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'idle', active: false })
  })
})

describe('resampleMicVisualLevels', () => {
  it('adapts the shared spectrum to each visual without another analyser', () => {
    expect(resampleMicVisualLevels([0, 1, 0, 1], 2)).toEqual([0.5, 0.5])
    expect(resampleMicVisualLevels([0, 1], 5)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(resampleMicVisualLevels([], 3)).toEqual([0, 0, 0])
  })
})
