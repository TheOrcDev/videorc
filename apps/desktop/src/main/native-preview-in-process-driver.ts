import type {
  NativePreviewHostCommand,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus
} from '../shared/backend'
import type {
  NativePreviewRealSurfaceDriver,
  NativePreviewRealSurfacePresentRequest
} from '../shared/native-preview-host-driver'
import { NativePreviewPresentMetrics } from './native-preview-present-metrics'
import { NativePreviewRunAuthority } from './native-preview-run-authority'

export interface NativePreviewInProcessPresentResult {
  presented: boolean
  reason?: string
}

export interface NativePreviewInProcessMetrics {
  iosurfaceCacheHits: number
  iosurfaceImports: number
  iosurfaceInvalidations: number
  iosurfaceImportFailures: number
  drawableWidth?: number
  drawableHeight?: number
  contentsScale?: number
}

export interface NativePreviewInProcessBinding {
  attach(
    nativeWindowHandle: Buffer,
    width: number,
    height: number,
    scaleFactor: number,
    visible: boolean
  ): void
  update(width: number, height: number, scaleFactor: number, visible: boolean): void
  present(
    iosurfaceId: number,
    width: number,
    height: number,
    frameId: number
  ): NativePreviewInProcessPresentResult
  destroy(): void
  attached(): boolean
  metrics(): NativePreviewInProcessMetrics
}

export interface NativePreviewInProcessDriverOptions {
  binding: NativePreviewInProcessBinding
  getNativeWindowHandle: () => Buffer | null
  nowMs?: () => number
  percentileCacheTtlMs?: number
}

type NativePreviewInProcessModule = {
  attachNativePreview: NativePreviewInProcessBinding['attach']
  updateNativePreview: NativePreviewInProcessBinding['update']
  presentNativePreview: NativePreviewInProcessBinding['present']
  destroyNativePreview: NativePreviewInProcessBinding['destroy']
  nativePreviewAttached: NativePreviewInProcessBinding['attached']
  nativePreviewMetrics: NativePreviewInProcessBinding['metrics']
}

type Attachment = {
  handle: Buffer
  width: number
  height: number
  scaleFactor: number
  visible: boolean
}

export function createNativePreviewInProcessDriver(
  options: NativePreviewInProcessDriverOptions
): NativePreviewRealSurfaceDriver {
  let attachment: Attachment | null = null
  let lastBounds: PreviewSurfaceBounds | undefined
  let placementEventsReceived = 0
  let placementsApplied = 0
  let placementsCoalesced = 0
  let droppedFrames = 0
  let lastPresentedRunId: string | undefined
  let lastPresentedFrameId = 0
  let lastPresentedStatus: PreviewSurfaceStatus | null = null
  const runAuthority = new NativePreviewRunAuthority()
  const placementRoundTripSamplesMs: number[] = []
  const presentRoundTripSamplesMs: number[] = []
  const presentMetrics = new NativePreviewPresentMetrics(
    options.nowMs,
    options.percentileCacheTtlMs
  )
  const telemetryNowMs = options.nowMs ?? (() => Date.now())
  const telemetryIntervalMs = Math.max(0, options.percentileCacheTtlMs ?? 250)
  let telemetryComputedAtMs: number | undefined
  let cachedPlacementRoundTripP95Ms: number | undefined
  let cachedPresentRoundTripP95Ms: number | undefined
  let cachedBindingMetrics: NativePreviewInProcessMetrics = emptyNativeMetrics()

  const applyBounds = (bounds: PreviewSurfaceBounds): void => {
    placementEventsReceived += 1
    const handle = options.getNativeWindowHandle()
    if (!handle) {
      throw new Error('Native preview window handle is unavailable.')
    }
    const next: Attachment = {
      handle,
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      scaleFactor: Math.max(1, bounds.scaleFactor),
      visible: bounds.visible !== false
    }
    lastBounds = bounds
    if (!attachment || !attachment.handle.equals(next.handle)) {
      const startedAt = performance.now()
      if (attachment) {
        options.binding.destroy()
      }
      options.binding.attach(next.handle, next.width, next.height, next.scaleFactor, next.visible)
      recordSample(placementRoundTripSamplesMs, performance.now() - startedAt)
      placementsApplied += 1
      attachment = next
      lastPresentedRunId = undefined
      lastPresentedFrameId = 0
      lastPresentedStatus = null
      runAuthority.clear()
      telemetryComputedAtMs = undefined
      cachedBindingMetrics = emptyNativeMetrics()
      return
    }
    if (surfaceAttachmentChanged(attachment, next)) {
      const startedAt = performance.now()
      options.binding.update(next.width, next.height, next.scaleFactor, next.visible)
      recordSample(placementRoundTripSamplesMs, performance.now() - startedAt)
      placementsApplied += 1
      attachment = next
      return
    }
    placementsCoalesced += 1
  }

  return {
    async applyHostCommands(
      commands: NativePreviewHostCommand[]
    ): Promise<PreviewSurfaceStatus | null> {
      for (const command of commands) {
        if (command.kind === 'destroy') {
          options.binding.destroy()
          attachment = null
          lastBounds = undefined
          lastPresentedRunId = undefined
          lastPresentedFrameId = 0
          lastPresentedStatus = null
          runAuthority.clear()
          telemetryComputedAtMs = undefined
          cachedBindingMetrics = emptyNativeMetrics()
          continue
        }
        if (!command.bounds) {
          throw new Error(`Native preview ${command.kind} command is missing bounds.`)
        }
        applyBounds(command.bounds)
      }
      return null
    },
    async presentCompositorHandoff(
      request: NativePreviewRealSurfacePresentRequest
    ): Promise<PreviewSurfaceStatus | null> {
      if (request.bounds) {
        const requestedAttachment = attachment
          ? {
              handle: attachment.handle,
              width: Math.max(1, Math.round(request.bounds.width)),
              height: Math.max(1, Math.round(request.bounds.height)),
              scaleFactor: Math.max(1, request.bounds.scaleFactor),
              visible: request.bounds.visible !== false
            }
          : null
        if (
          !attachment ||
          !requestedAttachment ||
          surfaceAttachmentChanged(attachment, requestedAttachment)
        ) {
          applyBounds(request.bounds)
        } else {
          // Position and stacking move atomically with the BrowserWindow because
          // the CAMetalLayer is its child. Still adopt the newest diagnostic
          // bounds so this present cannot overwrite main's fast-move state.
          lastBounds = request.bounds
        }
      }
      if (!attachment) {
        return null
      }
      if (!attachment.visible) {
        return lastPresentedStatus
          ? {
              ...lastPresentedStatus,
              width: attachment.width,
              height: attachment.height,
              framePollingSuppressed: request.suppressFramePolling,
              bounds: lastBounds
            }
          : null
      }
      const runDecision = runAuthority.decision(request.handoff.runId)
      if (
        !runDecision.accepted ||
        (request.handoff.runId &&
          lastPresentedRunId === request.handoff.runId &&
          request.handoff.frameId < lastPresentedFrameId)
      ) {
        return lastPresentedStatus
          ? {
              ...lastPresentedStatus,
              width: attachment.width,
              height: attachment.height,
              framePollingSuppressed: request.suppressFramePolling,
              bounds: lastBounds
            }
          : null
      }
      const presentStartedAt = performance.now()
      const result = options.binding.present(
        request.handoff.iosurfaceId,
        request.handoff.width,
        request.handoff.height,
        request.handoff.frameId
      )
      recordSample(presentRoundTripSamplesMs, performance.now() - presentStartedAt)
      if (!result.presented) {
        droppedFrames += 1
        return null
      }
      // Attachment is a presentation invariant, not telemetry. Keep checking
      // it on every frame even though the heavier native metrics and percentile
      // sorts are cached below.
      if (!options.binding.attached()) {
        droppedFrames += 1
        throw new Error('Native preview layer is no longer attached after presentation.')
      }
      const cadence = presentMetrics.record({
        frameAgeMs: request.frameAgeMs,
        compositorUpdatedAt: request.compositorUpdatedAt
      })
      const telemetryTimestampMs = telemetryNowMs()
      if (
        telemetryComputedAtMs === undefined ||
        telemetryTimestampMs < telemetryComputedAtMs ||
        telemetryTimestampMs - telemetryComputedAtMs >= telemetryIntervalMs
      ) {
        cachedBindingMetrics = options.binding.metrics()
        cachedPlacementRoundTripP95Ms = percentile95(placementRoundTripSamplesMs)
        cachedPresentRoundTripP95Ms = percentile95(presentRoundTripSamplesMs)
        telemetryComputedAtMs = telemetryTimestampMs
      }
      const source = request.scene?.sources.some(
        (item) => item.kind === 'screen' || item.kind === 'window'
      )
        ? 'screen'
        : request.scene?.sources.some((item) => item.kind === 'camera')
          ? 'camera'
          : 'synthetic'
      const status: PreviewSurfaceStatus = {
        state: 'live',
        source,
        transport: 'native-surface',
        backing: 'cametal-layer',
        targetFps: 60,
        width: attachment.width,
        height: attachment.height,
        framesRendered: request.handoff.frameId,
        presentedFrameId: request.handoff.frameId,
        compositorFrameLag: 0,
        droppedFrames,
        presentFps: cadence.presentFps,
        intervalP95Ms: cadence.intervalP95Ms,
        intervalP99Ms: cadence.intervalP99Ms,
        inputToPresentLatencyMs: cadence.inputToPresentLatencyMs,
        inputToPresentLatencyP50Ms: cadence.inputToPresentLatencyP50Ms,
        inputToPresentLatencyP95Ms: cadence.inputToPresentLatencyP95Ms,
        inputToPresentLatencyP99Ms: cadence.inputToPresentLatencyP99Ms,
        framePollingSuppressed: request.suppressFramePolling,
        sourcePixelsPresent: true,
        pendingHostCommandCount: 0,
        nativePreviewHostKind: 'in-process',
        nativePreviewHostAttached: true,
        nativePreviewPlacementEventsReceived: placementEventsReceived,
        nativePreviewPlacementsApplied: placementsApplied,
        nativePreviewPlacementsCoalesced: placementsCoalesced,
        nativePreviewPlacementRoundTripP95Ms: cachedPlacementRoundTripP95Ms,
        nativePreviewPresentRoundTripP95Ms: cachedPresentRoundTripP95Ms,
        nativePreviewIosurfaceCacheHits: cachedBindingMetrics.iosurfaceCacheHits,
        nativePreviewIosurfaceImports: cachedBindingMetrics.iosurfaceImports,
        nativePreviewIosurfaceInvalidations: cachedBindingMetrics.iosurfaceInvalidations,
        nativePreviewIosurfaceImportFailures: cachedBindingMetrics.iosurfaceImportFailures,
        nativePreviewDrawableWidth: cachedBindingMetrics.drawableWidth,
        nativePreviewDrawableHeight: cachedBindingMetrics.drawableHeight,
        nativePreviewContentsScale: cachedBindingMetrics.contentsScale,
        nativePreviewPresentedSceneRevision: request.scene?.revision,
        nativePreviewCompositorRunId: request.handoff.runId,
        bounds: lastBounds,
        updatedAt: new Date().toISOString(),
        message: 'In-process CAMetalLayer preview is presenting compositor output.'
      }
      lastPresentedRunId = request.handoff.runId
      lastPresentedFrameId = request.handoff.frameId
      lastPresentedStatus = status
      runAuthority.commit(request.handoff.runId)
      return status
    },
    resetMetrics(): void {
      presentMetrics.reset()
      presentRoundTripSamplesMs.splice(0)
      droppedFrames = 0
      telemetryComputedAtMs = undefined
      cachedPresentRoundTripP95Ms = undefined
      cachedBindingMetrics = emptyNativeMetrics()
    },
    stop(): void {
      options.binding.destroy()
      attachment = null
      lastBounds = undefined
      lastPresentedRunId = undefined
      lastPresentedFrameId = 0
      lastPresentedStatus = null
      runAuthority.clear()
      telemetryComputedAtMs = undefined
      cachedBindingMetrics = emptyNativeMetrics()
    }
  }
}

export function nativePreviewInProcessBindingFromModule(
  moduleValue: unknown
): NativePreviewInProcessBinding | null {
  const candidate = nativePreviewInProcessModule(moduleValue)
  if (!candidate) {
    return null
  }
  return {
    attach: (...args) => candidate.attachNativePreview(...args),
    update: (...args) => candidate.updateNativePreview(...args),
    present: (...args) => candidate.presentNativePreview(...args),
    destroy: () => candidate.destroyNativePreview(),
    attached: () => candidate.nativePreviewAttached(),
    metrics: () => candidate.nativePreviewMetrics()
  }
}

function nativePreviewInProcessModule(value: unknown): NativePreviewInProcessModule | null {
  const candidate = isObject(value) && isObject(value.default) ? value.default : value
  if (!isObject(candidate)) {
    return null
  }
  return typeof candidate.attachNativePreview === 'function' &&
    typeof candidate.updateNativePreview === 'function' &&
    typeof candidate.presentNativePreview === 'function' &&
    typeof candidate.destroyNativePreview === 'function' &&
    typeof candidate.nativePreviewAttached === 'function' &&
    typeof candidate.nativePreviewMetrics === 'function'
    ? (candidate as NativePreviewInProcessModule)
    : null
}

function recordSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    return
  }
  samples.push(value)
  if (samples.length > 900) {
    samples.splice(0, samples.length - 900)
  }
}

function percentile95(samples: number[]): number | undefined {
  if (samples.length === 0) {
    return undefined
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

function emptyNativeMetrics(): NativePreviewInProcessMetrics {
  return {
    iosurfaceCacheHits: 0,
    iosurfaceImports: 0,
    iosurfaceInvalidations: 0,
    iosurfaceImportFailures: 0
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function surfaceAttachmentChanged(current: Attachment, next: Attachment): boolean {
  return (
    current.width !== next.width ||
    current.height !== next.height ||
    current.scaleFactor !== next.scaleFactor ||
    current.visible !== next.visible
  )
}
