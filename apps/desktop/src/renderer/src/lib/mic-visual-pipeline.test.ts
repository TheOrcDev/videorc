import { describe, expect, it, vi } from 'vitest'

import { dbToMeterLevel } from './mic-meter'
import {
  advanceBandLevelsInto,
  createMicVisualFrameBuffer,
  createMicVisualPipeline,
  resampleMicVisualLevels,
  resampleMicVisualLevelsInto,
  spectrumBandTargetsInto,
  type MicVisualAnalyserLike,
  type MicVisualAudioContextLike,
  type MicVisualPipelineDependencies
} from './mic-visual-pipeline'

type TestStream = {
  getTracks: () => Array<{ stop: () => void }>
}

const SAMPLE_RATE = 48_000
const FFT_SIZE = 2048
const BIN_COUNT = FFT_SIZE / 2
const BIN_HZ = SAMPLE_RATE / FFT_SIZE
const BAND_COUNT = 32

/** Synthetic analyser content: a time-domain block plus a matching bin spectrum. */
type AnalyserSignal = {
  time: (index: number) => number
  frequencyDb: (bin: number) => number
}

/** A pure sine at `hz` with peak amplitude `amplitude`, concentrated in one bin. */
function sineSignal(amplitude: number, hz: number): AnalyserSignal {
  const bin = Math.round(hz / BIN_HZ)
  return {
    time: (index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
    // Any finite magnitude works: only the distribution is read from the FFT.
    frequencyDb: (candidate) => (candidate === bin ? -13.6 : Number.NEGATIVE_INFINITY)
  }
}

const SILENCE: AnalyserSignal = { time: () => 0, frequencyDb: () => Number.NEGATIVE_INFINITY }

/** Index of the visual band that owns `hz` (same log spacing as the pipeline). */
function bandFor(hz: number): number {
  const ratio = Math.min(8000, SAMPLE_RATE / 2) / 80
  return Math.min(BAND_COUNT - 1, Math.floor((Math.log(hz / 80) / Math.log(ratio)) * BAND_COUNT))
}

function fillFromSignal(signal: AnalyserSignal): {
  frequency: Float32Array
  time: Float32Array
  rms: number
} {
  const frequency = new Float32Array(BIN_COUNT)
  const time = new Float32Array(FFT_SIZE)
  let sumSquares = 0
  for (let bin = 0; bin < BIN_COUNT; bin += 1) frequency[bin] = signal.frequencyDb(bin)
  for (let index = 0; index < FFT_SIZE; index += 1) {
    time[index] = signal.time(index)
    sumSquares += time[index] * time[index]
  }
  return { frequency, time, rms: Math.sqrt(sumSquares / FFT_SIZE) }
}

function bandTargets(signal: AnalyserSignal): number[] {
  const { frequency, rms } = fillFromSignal(signal)
  const targets: number[] = []
  spectrumBandTargetsInto(
    frequency,
    rms,
    SAMPLE_RATE,
    FFT_SIZE,
    targets,
    new Float32Array(BIN_COUNT)
  )
  return targets
}

function pipelineHarness(): {
  dependencies: MicVisualPipelineDependencies<TestStream>
  getUserMedia: ReturnType<typeof vi.fn>
  contexts: Array<MicVisualAudioContextLike<TestStream> & { close: ReturnType<typeof vi.fn> }>
  analysers: MicVisualAnalyserLike[]
  frames: Array<(at: number) => void>
  microtasks: Array<() => void>
  cancelFrame: ReturnType<typeof vi.fn>
  stoppedTracks: ReturnType<typeof vi.fn>
  setSignal: (signal: AnalyserSignal) => void
} {
  const stoppedTracks = vi.fn()
  // Default content: a -12 dBFS DC block over a flat spectrum — every band
  // carries energy, which the lifecycle tests lean on (bands > 0).
  let signal: AnalyserSignal = { time: () => 0.25, frequencyDb: () => -60 }
  const analysers: MicVisualAnalyserLike[] = []
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
    analysers,
    frames,
    microtasks,
    cancelFrame,
    stoppedTracks,
    setSignal: (next) => {
      signal = next
    },
    dependencies: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' }
        ],
        getUserMedia
      },
      createAudioContext: () => {
        const analyser = {
          fftSize: FFT_SIZE,
          frequencyBinCount: BIN_COUNT,
          smoothingTimeConstant: 0,
          getFloatFrequencyData: vi.fn((samples: Float32Array) => {
            for (let bin = 0; bin < samples.length; bin += 1) {
              samples[bin] = signal.frequencyDb(bin)
            }
          }),
          getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
            for (let index = 0; index < samples.length; index += 1) {
              samples[index] = signal.time(index)
            }
          })
        }
        analysers.push(analyser)
        const context = {
          sampleRate: SAMPLE_RATE,
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

describe('spectrumBandTargetsInto', () => {
  it('reads a full-scale sine as ~0 dBFS in its band and floor everywhere else', () => {
    const targets = bandTargets(sineSignal(1, 1000))
    expect(targets).toHaveLength(BAND_COUNT)
    const band = bandFor(1000)
    expect(targets[band]).toBeCloseTo(1, 2)
    targets.forEach((level, index) => {
      if (index !== band) expect(level).toBe(0)
    })
  })

  it('maps a sine at N dBFS to the shared -60..0 dBFS window', () => {
    // Peak amplitude -30 dBFS → bar at half height (linear-in-dB), exactly
    // like the waveform history and the backend micLiveLevel scale.
    const minus30 = bandTargets(sineSignal(10 ** (-30 / 20), 1000))
    expect(minus30[bandFor(1000)]).toBeCloseTo(dbToMeterLevel(-30), 2)
    const minus12 = bandTargets(sineSignal(10 ** (-12 / 20), 2500))
    expect(minus12[bandFor(2500)]).toBeCloseTo(dbToMeterLevel(-12), 2)
  })

  it('gates -60 dBFS and -70 dBFS room tone to the floor', () => {
    expect(bandTargets(sineSignal(10 ** (-60 / 20), 1000)).every((level) => level === 0)).toBe(true)
    expect(bandTargets(sineSignal(10 ** (-70 / 20), 1000)).every((level) => level === 0)).toBe(true)
    // Broadband noise at -70 dBFS (the old mapping's 63 % bars) is floor too.
    const { frequency } = fillFromSignal({ time: () => 0, frequencyDb: () => -80 })
    const targets: number[] = []
    spectrumBandTargetsInto(
      frequency,
      10 ** (-70 / 20),
      SAMPLE_RATE,
      FFT_SIZE,
      targets,
      new Float32Array(BIN_COUNT)
    )
    expect(targets.every((level) => level === 0)).toBe(true)
    expect(bandTargets(SILENCE).every((level) => level === 0)).toBe(true)
  })

  it('splits the broadband level across bands by their share of the spectrum', () => {
    // Two equal tones in two bands: each band carries half the power (-3 dB).
    const low = Math.round(300 / BIN_HZ)
    const high = Math.round(3000 / BIN_HZ)
    const amplitude = 10 ** (-20 / 20)
    const signal: AnalyserSignal = {
      time: (index) =>
        amplitude * Math.sin((2 * Math.PI * 300 * index) / SAMPLE_RATE) +
        amplitude * Math.sin((2 * Math.PI * 3000 * index) / SAMPLE_RATE),
      frequencyDb: (bin) => (bin === low || bin === high ? -20 : Number.NEGATIVE_INFINITY)
    }
    const targets = bandTargets(signal)
    expect(targets[bandFor(300)]).toBeCloseTo(dbToMeterLevel(-20), 1)
    expect(targets[bandFor(3000)]).toBeCloseTo(dbToMeterLevel(-20), 1)
    expect(targets[bandFor(300)]).toBeCloseTo(targets[bandFor(3000)], 1)
  })
})

describe('advanceBandLevelsInto', () => {
  it('rises within one 48 ms tick and falls over ~350 ms per band', () => {
    const bands: number[] = []
    advanceBandLevelsInto(bands, [1, 0.5, 0], 48)
    expect(bands[0]).toBeGreaterThan(0.95)
    expect(bands[1]).toBeGreaterThan(0.47)
    expect(bands[2]).toBe(0)

    advanceBandLevelsInto(bands, [0, 0, 0], 48)
    expect(bands[0]).toBeGreaterThan(0.8)
    expect(bands[1]).toBeGreaterThan(0.4)
    for (let tick = 0; tick < 20; tick += 1) advanceBandLevelsInto(bands, [0, 0, 0], 48)
    expect(bands[0]).toBeLessThan(0.1)
    expect(bands[0]).toBeGreaterThan(0)
  })
})

describe('createMicVisualPipeline level feel', () => {
  it('paints silence at floor, speech on the next tick, and lets it fall slowly', async () => {
    const harness = pipelineHarness()
    harness.setSignal(SILENCE)
    const pipeline = retainedPipeline(harness.dependencies)
    pipeline.configure({
      deviceName: 'Studio microphone',
      enabled: true,
      permissionStatus: 'granted'
    })
    await vi.waitFor(() => expect(harness.frames).toHaveLength(1))
    expect(harness.analysers[0].smoothingTimeConstant).toBe(0.3)

    let at = 0
    const tick = (): void => {
      at += 48
      harness.frames.at(-1)?.(at)
    }
    tick()
    expect(pipeline.getFrameSnapshot().bands.every((level) => level === 0)).toBe(true)
    expect(pipeline.getFrameSnapshot().peakDb).toBe(-60)

    // A -12 dBFS tone arrives: its band is up on the very next tick.
    harness.setSignal(sineSignal(10 ** (-12 / 20), 1000))
    tick()
    const band = bandFor(1000)
    const spoken = pipeline.getFrameSnapshot()
    expect(spoken.bands[band]).toBeGreaterThan(dbToMeterLevel(-12) * 0.95)
    expect(spoken.bands[band]).toBeLessThanOrEqual(dbToMeterLevel(-12))
    expect(spoken.peakDb).toBeCloseTo(-12, 0)
    expect(spoken.bands.filter((level) => level > 0)).toHaveLength(1)

    // Back to silence: the bar decays instead of snapping — still most of the
    // way up after one tick, near floor only after ~1 s.
    harness.setSignal(SILENCE)
    tick()
    const falling = pipeline.getFrameSnapshot().bands[band]
    expect(falling).toBeLessThan(spoken.bands[band])
    expect(falling).toBeGreaterThan(spoken.bands[band] * 0.8)
    for (let count = 0; count < 20; count += 1) tick()
    expect(pipeline.getFrameSnapshot().bands[band]).toBeLessThan(0.05)
    expect(pipeline.getFrameSnapshot().peakDb).toBe(-60)
  })
})

describe('resampleMicVisualLevels', () => {
  it('adapts the shared spectrum to each visual without another analyser', () => {
    expect(resampleMicVisualLevels([0, 1, 0, 1], 2)).toEqual([0.5, 0.5])
    expect(resampleMicVisualLevels([0, 1], 5)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(resampleMicVisualLevels([], 3)).toEqual([0, 0, 0])
  })
})
