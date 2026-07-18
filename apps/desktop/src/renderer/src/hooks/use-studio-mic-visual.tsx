import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode
} from 'react'

import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useStudioCore } from '@/hooks/use-studio'
import {
  createMicVisualFrameBuffer,
  createMicVisualPipeline,
  type MicVisualFrameBuffer,
  type MicVisualLifecycleSnapshot,
  type MicVisualPipeline,
  type MicVisualSource
} from '@/lib/mic-visual-pipeline'

const StudioMicVisualContext = createContext<MicVisualPipeline | null>(null)
const PEAK_LABEL_INTERVAL_MS = 250

function createBrowserMicVisualPipeline(): MicVisualPipeline {
  return createMicVisualPipeline<MediaStream>({
    mediaDevices:
      typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices ?? undefined),
    createAudioContext: () => {
      const context = new AudioContext()
      return {
        sampleRate: context.sampleRate,
        createAnalyser: () => {
          const analyser = context.createAnalyser()
          return {
            get fftSize() {
              return analyser.fftSize
            },
            set fftSize(value: number) {
              analyser.fftSize = value
            },
            get frequencyBinCount() {
              return analyser.frequencyBinCount
            },
            get smoothingTimeConstant() {
              return analyser.smoothingTimeConstant
            },
            set smoothingTimeConstant(value: number) {
              analyser.smoothingTimeConstant = value
            },
            getFloatFrequencyData: (samples) =>
              analyser.getFloatFrequencyData(samples as Float32Array<ArrayBuffer>),
            getFloatTimeDomainData: (samples) =>
              analyser.getFloatTimeDomainData(samples as Float32Array<ArrayBuffer>)
          }
        },
        createMediaStreamSource: (stream) => {
          const source = context.createMediaStreamSource(stream)
          return {
            connect: (analyser) => source.connect(analyser as AnalyserNode),
            disconnect: () => source.disconnect()
          }
        },
        close: () => context.close()
      }
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    queueMicrotask: (callback) => globalThis.queueMicrotask(callback)
  })
}

/**
 * Workspace-scoped owner for renderer microphone visuals. The backend remains
 * the recording/health authority; this provider opens one visual-only browser
 * stream only while Studio/Sources is visible and OS access is already granted.
 */
export function StudioMicVisualProvider({
  enabled,
  children
}: {
  enabled: boolean
  children: ReactNode
}): ReactElement {
  const { captureConfig, selectedMicrophone, mediaAccess } = useStudioCore()
  const documentVisible = useDocumentVisible()
  const [pipeline] = useState(createBrowserMicVisualPipeline)
  const selectionKey = selectedMicrophone?.id
  const deviceName = selectedMicrophone?.name
  const permissionStatus = mediaAccess?.microphone
  const source = {
    selectionKey,
    deviceName,
    permissionStatus,
    enabled:
      enabled && documentVisible && Boolean(selectionKey) && !captureConfig.audio.microphoneMuted
  }

  return (
    <MicVisualPipelineProvider pipeline={pipeline} source={source}>
      {children}
    </MicVisualPipelineProvider>
  )
}

/** Public provider boundary used by the workspace and lifecycle integration tests. */
export function MicVisualPipelineProvider({
  pipeline,
  source,
  children
}: {
  pipeline: MicVisualPipeline
  source: MicVisualSource
  children?: ReactNode
}): ReactElement {
  const { deviceName, enabled, permissionStatus, selectionKey } = source

  useEffect(() => {
    const configuredSource = { deviceName, enabled, permissionStatus, selectionKey }
    pipeline.configure(configuredSource)
    // configure(false) releases in a microtask: a StrictMode cleanup followed
    // immediately by the same setup cancels that release and keeps one open.
    return () => pipeline.configure({ ...configuredSource, enabled: false })
  }, [deviceName, enabled, permissionStatus, pipeline, selectionKey])

  return (
    <StudioMicVisualContext.Provider value={pipeline}>{children}</StudioMicVisualContext.Provider>
  )
}

function useStudioMicVisualPipeline(): MicVisualPipeline {
  const pipeline = useContext(StudioMicVisualContext)
  if (!pipeline) {
    throw new Error('Studio microphone visuals must be used within StudioMicVisualProvider')
  }
  return pipeline
}

/** Lifecycle changes only; does not rerender at analyser frame rate. */
export function useStudioMicVisualLifecycle(): MicVisualLifecycleSnapshot {
  const pipeline = useStudioMicVisualPipeline()
  return useSyncExternalStore(
    pipeline.subscribeLifecycle,
    pipeline.getLifecycleSnapshot,
    pipeline.getLifecycleSnapshot
  )
}

/**
 * Delivers analyser frames imperatively. Updating the painter never changes
 * React state, so any number of bars/canvases can share the clock without a
 * component render per frame.
 */
export function useStudioMicVisualPainter(paint: (frame: MicVisualFrameBuffer) => void): void {
  const pipeline = useStudioMicVisualPipeline()
  const paintRef = useRef(paint)
  const frameBufferRef = useRef<MicVisualFrameBuffer | null>(null)
  if (!frameBufferRef.current) {
    frameBufferRef.current = createMicVisualFrameBuffer()
  }
  paintRef.current = paint

  useEffect(() => {
    const releaseDemand = pipeline.retain()
    const frameBuffer = frameBufferRef.current
    if (!frameBuffer) return releaseDemand
    const paintCurrentFrame = (): void => paintRef.current(pipeline.readFrame(frameBuffer))
    paintCurrentFrame()
    const unsubscribe = pipeline.subscribeFrame(paintCurrentFrame)
    return () => {
      unsubscribe()
      releaseDemand()
    }
  }, [pipeline])
}

/** Peak label/clip state is React-owned, but commits at most four times a second. */
export function useStudioMicVisualPeakDb(): number | null {
  const pipeline = useStudioMicVisualPipeline()
  const [peakDb, setPeakDb] = useState<number | null>(null)

  useEffect(() => {
    const releaseDemand = pipeline.retain()
    let timer: ReturnType<typeof setTimeout> | null = null
    let pendingPeakDb: number | null = null
    let lastCommitAt = Number.NEGATIVE_INFINITY

    const commit = (): void => {
      timer = null
      lastCommitAt = performance.now()
      const next = pendingPeakDb
      pendingPeakDb = null
      setPeakDb((current) => (Object.is(current, next) ? current : next))
    }

    const collect = (): void => {
      const next = pipeline.getPeakDb()
      if (next === null) {
        pendingPeakDb = null
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        lastCommitAt = Number.NEGATIVE_INFINITY
        setPeakDb((current) => (current === null ? current : null))
        return
      }

      pendingPeakDb = pendingPeakDb === null ? next : Math.max(pendingPeakDb, next)
      const remaining = PEAK_LABEL_INTERVAL_MS - (performance.now() - lastCommitAt)
      if (remaining <= 0) {
        commit()
      } else if (!timer) {
        timer = setTimeout(commit, remaining)
      }
    }

    collect()
    const unsubscribe = pipeline.subscribeFrame(collect)
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
      releaseDemand()
    }
  }, [pipeline])

  return peakDb
}
