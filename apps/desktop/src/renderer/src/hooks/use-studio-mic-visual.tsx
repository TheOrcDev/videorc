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
import { createMicVisualFrameBuffer, type MicVisualFrameBuffer } from '@/lib/mic-visual-frame'
import type {
  MicVisualLifecycleSnapshot,
  MicVisualPipeline,
  MicVisualSource
} from '@/lib/mic-visual-pipeline'

const StudioMicVisualContext = createContext<MicVisualPipeline | undefined>(undefined)
const PEAK_LABEL_INTERVAL_MS = 250
const IDLE_LIFECYCLE: MicVisualLifecycleSnapshot = Object.freeze({
  status: 'idle',
  active: false
})
const EMPTY_FRAME = Object.freeze({
  bands: Object.freeze([]),
  history: Object.freeze([]),
  peakDb: null
})
const EMPTY_HISTORY_RING = new Float32Array(0)
const IDLE_PIPELINE: MicVisualPipeline = Object.freeze({
  configure: () => undefined,
  retain: () => () => undefined,
  getLifecycleSnapshot: () => IDLE_LIFECYCLE,
  getFrameSnapshot: () => EMPTY_FRAME,
  readFrame: (target) => {
    target.bands.length = 0
    target.historyRing = EMPTY_HISTORY_RING
    target.historyStart = 0
    target.historyLength = 0
    target.peakDb = null
    return target
  },
  getPeakDb: () => null,
  subscribeLifecycle: () => () => undefined,
  subscribeFrame: () => () => undefined,
  dispose: () => undefined
})

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
  const [pipeline, setPipeline] = useState<MicVisualPipeline | null>(null)
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

  useEffect(() => {
    if (pipeline || !source.enabled) {
      return
    }
    let cancelled = false
    void import('@/lib/browser-mic-visual-pipeline')
      .then(({ createBrowserMicVisualPipeline }) => createBrowserMicVisualPipeline())
      .then((loadedPipeline) => {
        if (cancelled) {
          loadedPipeline.dispose()
          return
        }
        setPipeline(loadedPipeline)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [pipeline, source.enabled])

  return (
    <MicVisualPipelineProvider pipeline={pipeline ?? IDLE_PIPELINE} source={source}>
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
