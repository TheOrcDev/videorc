import type { MediaAccessStatus } from './backend'
import type { MicVisualFrameBuffer } from './mic-visual-frame'
import { amplitudeToDb, dbToMeterLevel } from './mic-meter'
import {
  createMicStreamController,
  microphoneStreamAcquisitionEnabled,
  type MicMediaDevicesLike,
  type MicMediaStreamLike,
  type MicStreamController
} from './mic-stream'

export type MicVisualStatus = 'idle' | 'acquiring' | 'active' | 'unavailable'

export type MicVisualLifecycleSnapshot = Readonly<{
  status: MicVisualStatus
  active: boolean
}>

export type MicVisualFrameSnapshot = Readonly<{
  bands: readonly number[]
  history: readonly number[]
  peakDb: number | null
}>

/** Caller-owned mutable read buffer. Reuse it for every analyser notification. */
export type { MicVisualFrameBuffer } from './mic-visual-frame'
export {
  createMicVisualFrameBuffer,
  resampleMicVisualLevels,
  resampleMicVisualLevelsInto
} from './mic-visual-frame'

export type MicVisualAnalyserLike = {
  fftSize: number
  readonly frequencyBinCount: number
  smoothingTimeConstant: number
  getFloatFrequencyData: (samples: Float32Array) => void
  getFloatTimeDomainData: (samples: Float32Array) => void
}

export type MicVisualSourceLike = {
  connect: (destination: MicVisualAnalyserLike) => void
  disconnect: () => void
}

export type MicVisualAudioContextLike<S extends MicMediaStreamLike> = {
  readonly sampleRate: number
  createAnalyser: () => MicVisualAnalyserLike
  createMediaStreamSource: (stream: S) => MicVisualSourceLike
  close: () => Promise<void>
}

export type MicVisualPipelineDependencies<S extends MicMediaStreamLike> = {
  mediaDevices: MicMediaDevicesLike<S> | undefined
  createAudioContext: () => MicVisualAudioContextLike<S>
  requestFrame: (callback: (at: number) => void) => number
  cancelFrame: (id: number) => void
  queueMicrotask: (callback: () => void) => void
}

export type MicVisualSource = Readonly<{
  /** Stable backend device identity; acquisition still matches Chromium by label. */
  selectionKey?: string
  deviceName: string | undefined
  permissionStatus: MediaAccessStatus | undefined
  enabled: boolean
}>

export type MicVisualPipeline = {
  configure: (source: MicVisualSource) => void
  /** Retain visual demand; the returned release is StrictMode-safe and idempotent. */
  retain: () => () => void
  getLifecycleSnapshot: () => MicVisualLifecycleSnapshot
  /** Immutable point-in-time copy for diagnostics/tests; high-rate painters use readFrame. */
  getFrameSnapshot: () => MicVisualFrameSnapshot
  /** Copy the current frame into a reusable caller-owned buffer. */
  readFrame: (target: MicVisualFrameBuffer) => MicVisualFrameBuffer
  getPeakDb: () => number | null
  subscribeLifecycle: (listener: () => void) => () => void
  subscribeFrame: (listener: () => void) => () => void
  dispose: () => void
}

const IDLE_LIFECYCLE: MicVisualLifecycleSnapshot = Object.freeze({
  status: 'idle',
  active: false
})
const EMPTY_FRAME: MicVisualFrameSnapshot = Object.freeze({
  bands: Object.freeze([]),
  history: Object.freeze([]),
  peakDb: null
})
const VISUAL_BAND_COUNT = 32
const VISUAL_HISTORY_SIZE = 60
const VISUAL_UPDATE_INTERVAL_MS = 48
const VISUAL_LOW_HZ = 80
const VISUAL_HIGH_HZ = 8000
const EMPTY_HISTORY_RING = new Float32Array(0)

function normalizeSpectrumDb(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  const normalized = (Math.max(-100, Math.min(-10, value)) + 100) / 90
  return Math.sqrt(normalized)
}

function spectrumBandsInto(
  samples: Float32Array,
  sampleRate: number,
  fftSize: number,
  bands: number[]
): void {
  const binHz = sampleRate / fftSize
  const highHz = Math.min(VISUAL_HIGH_HZ, sampleRate / 2)
  const ratio = highHz / VISUAL_LOW_HZ
  bands.length = VISUAL_BAND_COUNT

  for (let band = 0; band < VISUAL_BAND_COUNT; band += 1) {
    const startHz = VISUAL_LOW_HZ * ratio ** (band / VISUAL_BAND_COUNT)
    const endHz = VISUAL_LOW_HZ * ratio ** ((band + 1) / VISUAL_BAND_COUNT)
    const start = Math.max(1, Math.floor(startHz / binHz))
    const end = Math.max(start + 1, Math.min(samples.length, Math.ceil(endHz / binHz)))
    let total = 0
    for (let index = start; index < end; index += 1) {
      total += normalizeSpectrumDb(samples[index])
    }
    bands[band] = total / Math.max(1, end - start)
  }
}

/**
 * Owns the renderer's visual-only microphone resources. Calling configure
 * repeatedly for the same selected device is idempotent, so any number of UI
 * consumers share one MediaStream, one AudioContext, and one animation clock.
 */
export function createMicVisualPipeline<S extends MicMediaStreamLike>(
  dependencies: MicVisualPipelineDependencies<S>
): MicVisualPipeline {
  type SessionFrame = {
    bands: number[]
    historyRing: Float32Array
    historyStart: number
    historyLength: number
    peakDb: number | null
    hasData: boolean
  }
  type ActiveSession = {
    key: string
    controller: MicStreamController<S>
    audioContext: MicVisualAudioContextLike<S>
    mediaSource: MicVisualSourceLike
    animationFrame: number
    stopped: boolean
    frame: SessionFrame
  }
  type PendingSession = {
    key: string
    generation: number
    controller: MicStreamController<S>
  }
  type PreparedSession = {
    session: ActiveSession
  }

  let lifecycle = IDLE_LIFECYCLE
  let desiredKey: string | null = null
  let generation = 0
  let releaseGeneration = 0
  let disposed = false
  let configuredSource: MicVisualSource | null = null
  let demandCount = 0
  let activeSession: ActiveSession | null = null
  let pendingSession: PendingSession | null = null
  const lifecycleListeners = new Set<() => void>()
  const frameListeners = new Set<() => void>()

  const publishLifecycle = (next: MicVisualLifecycleSnapshot): void => {
    if (lifecycle.status === next.status && lifecycle.active === next.active) {
      return
    }
    lifecycle = next
    lifecycleListeners.forEach((listener) => listener())
  }

  const publishFrame = (): void => {
    frameListeners.forEach((listener) => listener())
  }

  const stopActiveSession = (session: ActiveSession | null): void => {
    if (!session || session.stopped) {
      return
    }
    session.stopped = true
    if (session.animationFrame) {
      dependencies.cancelFrame(session.animationFrame)
      session.animationFrame = 0
    }
    session.mediaSource.disconnect()
    void session.audioContext.close().catch(() => undefined)
    session.controller.close()
  }

  const stopPendingSession = (session: PendingSession | null): void => {
    session?.controller.close()
  }

  const prepareActiveSession = (
    key: string,
    controller: MicStreamController<S>,
    stream: S
  ): PreparedSession => {
    let context: MicVisualAudioContextLike<S> | null = null
    let mediaSource: MicVisualSourceLike | null = null
    let scheduledFrame = 0
    try {
      const preparedContext = dependencies.createAudioContext()
      context = preparedContext
      const analyser = preparedContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8
      mediaSource = preparedContext.createMediaStreamSource(stream)
      mediaSource.connect(analyser)
      const frequencySamples = new Float32Array(analyser.frequencyBinCount)
      const timeSamples = new Float32Array(analyser.fftSize)
      let lastUpdateAt = Number.NEGATIVE_INFINITY
      const sessionFrame: SessionFrame = {
        bands: new Array<number>(VISUAL_BAND_COUNT).fill(0),
        historyRing: new Float32Array(VISUAL_HISTORY_SIZE),
        historyStart: 0,
        historyLength: 0,
        peakDb: null,
        hasData: false
      }
      const sampleFrame = (): void => {
        analyser.getFloatFrequencyData(frequencySamples)
        analyser.getFloatTimeDomainData(timeSamples)
        let sumSquares = 0
        let peak = 0
        for (let index = 0; index < timeSamples.length; index += 1) {
          const sample = timeSamples[index]
          sumSquares += sample * sample
          peak = Math.max(peak, Math.abs(sample))
        }
        const rms = timeSamples.length > 0 ? Math.sqrt(sumSquares / timeSamples.length) : 0
        const historyIndex =
          (sessionFrame.historyStart + sessionFrame.historyLength) % VISUAL_HISTORY_SIZE
        sessionFrame.historyRing[historyIndex] = dbToMeterLevel(amplitudeToDb(rms))
        if (sessionFrame.historyLength < VISUAL_HISTORY_SIZE) {
          sessionFrame.historyLength += 1
        } else {
          sessionFrame.historyStart = (sessionFrame.historyStart + 1) % VISUAL_HISTORY_SIZE
        }
        spectrumBandsInto(
          frequencySamples,
          preparedContext.sampleRate,
          analyser.fftSize,
          sessionFrame.bands
        )
        sessionFrame.peakDb = amplitudeToDb(peak)
        sessionFrame.hasData = true
      }
      const session: ActiveSession = {
        key,
        controller,
        audioContext: preparedContext,
        mediaSource,
        animationFrame: 0,
        stopped: false,
        frame: sessionFrame
      }
      const tick = (at: number): void => {
        session.animationFrame = 0
        if (disposed || activeSession !== session || session.stopped) {
          return
        }
        if (at - lastUpdateAt >= VISUAL_UPDATE_INTERVAL_MS) {
          lastUpdateAt = at
          sampleFrame()
          publishFrame()
        }
        if (!disposed && activeSession === session && !session.stopped) {
          session.animationFrame = dependencies.requestFrame(tick)
        }
      }
      scheduledFrame = dependencies.requestFrame(tick)
      session.animationFrame = scheduledFrame
      sampleFrame()
      return { session }
    } catch {
      if (scheduledFrame) {
        dependencies.cancelFrame(scheduledFrame)
      }
      mediaSource?.disconnect()
      if (context) {
        void context.close().catch(() => undefined)
      }
      controller.close()
      throw new Error('visual microphone analyser unavailable')
    }
  }

  const retireSelectedDevice = (status: MicVisualStatus): void => {
    const previous = activeSession
    activeSession = null
    stopActiveSession(previous)
    publishFrame()
    publishLifecycle(Object.freeze({ status, active: false }))
  }

  const acquire = (source: MicVisualSource, key: string): void => {
    generation += 1
    const acquisitionGeneration = generation
    const controller = createMicStreamController(dependencies.mediaDevices)
    const pending: PendingSession = {
      key,
      generation: acquisitionGeneration,
      controller
    }
    pendingSession = pending
    if (!activeSession) {
      publishLifecycle(Object.freeze({ status: 'acquiring', active: false }))
    }

    void controller.open(source.deviceName).then((stream) => {
      if (
        disposed ||
        pendingSession !== pending ||
        generation !== acquisitionGeneration ||
        desiredKey !== key
      ) {
        return
      }
      pendingSession = null
      if (!stream) {
        retireSelectedDevice('unavailable')
        return
      }

      let prepared: PreparedSession
      try {
        prepared = prepareActiveSession(key, controller, stream)
      } catch {
        retireSelectedDevice('unavailable')
        return
      }

      // The replacement is fully connected and has a scheduled clock before
      // it becomes authoritative. Only then retire the previous device, so a
      // slow switch never creates a dead visual interval.
      const previous = activeSession
      activeSession = prepared.session
      publishFrame()
      publishLifecycle(Object.freeze({ status: 'active', active: true }))
      stopActiveSession(previous)
    })
  }

  const disableSoon = (): void => {
    const pendingRelease = ++releaseGeneration
    dependencies.queueMicrotask(() => {
      if (disposed || releaseGeneration !== pendingRelease) {
        return
      }
      generation += 1
      desiredKey = null
      const pending = pendingSession
      pendingSession = null
      stopPendingSession(pending)
      const active = activeSession
      activeSession = null
      stopActiveSession(active)
      publishFrame()
      publishLifecycle(IDLE_LIFECYCLE)
    })
  }

  const applyConfiguration = (): void => {
    const source = configuredSource
    if (
      demandCount === 0 ||
      !source ||
      !microphoneStreamAcquisitionEnabled(source.enabled, source.permissionStatus)
    ) {
      disableSoon()
      return
    }

    const nextKey = source.selectionKey ?? source.deviceName ?? ''
    if (desiredKey === nextKey) {
      // Cancels a StrictMode cleanup scheduled between identical effect
      // setups without reopening the device.
      releaseGeneration += 1
      return
    }

    releaseGeneration += 1
    desiredKey = nextKey
    const superseded = pendingSession
    pendingSession = null
    stopPendingSession(superseded)
    acquire(source, nextKey)
  }

  const copyCurrentFrame = (target: MicVisualFrameBuffer): MicVisualFrameBuffer => {
    const source = activeSession?.frame
    if (!source?.hasData) {
      target.bands.length = 0
      target.historyRing = EMPTY_HISTORY_RING
      target.historyStart = 0
      target.historyLength = 0
      target.peakDb = null
      return target
    }

    target.bands.length = source.bands.length
    for (let index = 0; index < source.bands.length; index += 1) {
      target.bands[index] = source.bands[index]
    }
    target.historyRing = source.historyRing
    target.historyStart = source.historyStart
    target.historyLength = source.historyLength
    target.peakDb = source.peakDb
    return target
  }

  const snapshotCurrentFrame = (): MicVisualFrameSnapshot => {
    const source = activeSession?.frame
    if (!source?.hasData) {
      return EMPTY_FRAME
    }
    const history = new Array<number>(source.historyLength)
    for (let index = 0; index < source.historyLength; index += 1) {
      history[index] = source.historyRing[(source.historyStart + index) % VISUAL_HISTORY_SIZE]
    }
    return Object.freeze({
      bands: Object.freeze(Array.from(source.bands)),
      history: Object.freeze(history),
      peakDb: source.peakDb
    })
  }

  return {
    configure(source) {
      if (disposed) {
        return
      }
      configuredSource = source
      applyConfiguration()
    },
    retain() {
      if (disposed) {
        return () => undefined
      }
      demandCount += 1
      if (demandCount === 1) {
        applyConfiguration()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        // React StrictMode performs cleanup and setup back-to-back. Deferring
        // the decrement lets the replacement retain arrive before demand can
        // hit zero, so the sole stream/context/clock never churns.
        dependencies.queueMicrotask(() => {
          if (disposed) return
          demandCount = Math.max(0, demandCount - 1)
          if (demandCount === 0) {
            applyConfiguration()
          }
        })
      }
    },
    getLifecycleSnapshot: () => lifecycle,
    getFrameSnapshot: snapshotCurrentFrame,
    readFrame: copyCurrentFrame,
    getPeakDb: () => activeSession?.frame.peakDb ?? null,
    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    subscribeFrame(listener) {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      configuredSource = null
      demandCount = 0
      generation += 1
      releaseGeneration += 1
      desiredKey = null
      const pending = pendingSession
      pendingSession = null
      stopPendingSession(pending)
      const active = activeSession
      activeSession = null
      stopActiveSession(active)
      lifecycle = IDLE_LIFECYCLE
      lifecycleListeners.clear()
      frameListeners.clear()
    }
  }
}
