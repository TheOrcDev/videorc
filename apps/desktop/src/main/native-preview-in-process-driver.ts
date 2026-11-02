import type {
  NativePreviewHostCommand,
  NativePreviewHostWindow,
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
  iosurfaceImportLiveCount: number
  iosurfaceImportPeakCount: number
  iosurfaceImportCeiling: number
  drawableWidth?: number
  drawableHeight?: number
  contentsScale?: number
}

/**
 * The layer's frame inside its host window's view (plan 213 D2): a top-left
 * origin in the host's content coordinates, in points, plus the drawable's
 * scale, visibility and corner radius. Mirrors the addon's
 * NativePreviewLayerFrame; the addon converts it to the host layer's own
 * space, flipped or not.
 */
export interface NativePreviewLayerFrame {
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
  visible: boolean
  cornerRadius: number
}

export interface NativePreviewInProcessBinding {
  attach(nativeWindowHandle: Buffer, frame: NativePreviewLayerFrame): void
  update(frame: NativePreviewLayerFrame): void
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
  /** Which app window the handle belongs to (plan 213 D3); the status names
   * it. Absent = the Preview window, the only host before plan 213. */
  getNativeHostWindow?: () => NativePreviewHostWindow | null
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
  hostWindow: NativePreviewHostWindow
  frame: NativePreviewLayerFrame
  // The host content's height the frame was placed against. An AppKit layer
  // measures its origin from the host's bottom edge, so a taller host must
  // have the frame set again even when the slot stayed put; the addon
  // re-reads the real height, this only decides when to call it.
  hostHeight: number
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
      hostWindow: options.getNativeHostWindow?.() ?? 'preview',
      ...layerPlacementFromBounds(bounds)
    }
    lastBounds = bounds
    if (!attachment || !attachment.handle.equals(next.handle)) {
      const startedAt = performance.now()
      if (attachment) {
        options.binding.destroy()
      }
      options.binding.attach(next.handle, next.frame)
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
      options.binding.update(next.frame)
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
        const requestedAttachment: Attachment | null = attachment
          ? { ...attachment, ...layerPlacementFromBounds(request.bounds) }
          : null
        if (
          !attachment ||
          !requestedAttachment ||
          surfaceAttachmentChanged(attachment, requestedAttachment)
        ) {
          applyBounds(request.bounds)
        } else {
          // Position and stacking move atomically with the host window because
          // the CAMetalLayer is its child. Still adopt the newest diagnostic
          // bounds so this present cannot overwrite main's fast-move state.
          lastBounds = request.bounds
        }
      }
      if (!attachment) {
        return null
      }
      if (!attachment.frame.visible) {
        return lastPresentedStatus
          ? {
              ...lastPresentedStatus,
              width: attachment.frame.width,
              height: attachment.frame.height,
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
              width: attachment.frame.width,
              height: attachment.frame.height,
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
      const presentCompletedAt = performance.now()
      recordSample(presentRoundTripSamplesMs, presentCompletedAt - presentStartedAt)
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
        width: attachment.frame.width,
        height: attachment.frame.height,
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
        nativePreviewHostWindow: attachment.hostWindow,
        nativePreviewPlacementEventsReceived: placementEventsReceived,
        nativePreviewPlacementsApplied: placementsApplied,
        nativePreviewPlacementsCoalesced: placementsCoalesced,
        nativePreviewPlacementRoundTripP95Ms: cachedPlacementRoundTripP95Ms,
        nativePreviewPresentRoundTripP95Ms: cachedPresentRoundTripP95Ms,
        nativePreviewIosurfaceCacheHits: cachedBindingMetrics.iosurfaceCacheHits,
        nativePreviewIosurfaceImports: cachedBindingMetrics.iosurfaceImports,
        nativePreviewIosurfaceInvalidations: cachedBindingMetrics.iosurfaceInvalidations,
        nativePreviewIosurfaceImportFailures: cachedBindingMetrics.iosurfaceImportFailures,
        nativePreviewIosurfaceImportLiveCount: cachedBindingMetrics.iosurfaceImportLiveCount,
        nativePreviewIosurfaceImportPeakCount: cachedBindingMetrics.iosurfaceImportPeakCount,
        nativePreviewIosurfaceImportCeiling: cachedBindingMetrics.iosurfaceImportCeiling,
        nativePreviewDrawableWidth: cachedBindingMetrics.drawableWidth,
        nativePreviewDrawableHeight: cachedBindingMetrics.drawableHeight,
        nativePreviewContentsScale: cachedBindingMetrics.contentsScale,
        nativePreviewPresentedSceneRevision: request.scene?.revision,
        nativePreviewCompositorRunId: request.handoff.runId,
        nativePreviewPresentationEvidence: {
          frameId: request.handoff.frameId,
          runId:
            request.handoff.runId && request.handoff.runId.length <= 128
              ? request.handoff.runId
              : undefined,
          sceneRevision: safeRevision(request.frameSceneRevision),
          frameAgeMs:
            typeof request.frameAgeMs === 'number' &&
            Number.isFinite(request.frameAgeMs) &&
            request.frameAgeMs >= 0
              ? request.frameAgeMs
              : undefined,
          compositorUpdatedAt:
            request.compositorUpdatedAt &&
            request.compositorUpdatedAt.length <= 64 &&
            Number.isFinite(Date.parse(request.compositorUpdatedAt))
              ? request.compositorUpdatedAt
              : undefined,
          presentedAtMs: cadence.recordedAtMs,
          presentStartedMonotonicMs: presentStartedAt,
          presentCompletedMonotonicMs: presentCompletedAt,
          inputToPresentLatencyMs: cadence.inputToPresentLatencyMs
        },
        bounds: lastBounds,
        updatedAt: new Date().toISOString(),
        message: `In-process CAMetalLayer preview is presenting compositor output in the ${
          attachment.hostWindow === 'main' ? 'main window' : 'Preview window'
        }.`
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

function safeRevision(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function nativePreviewInProcessBindingFromModule(
  moduleValue: unknown
): NativePreviewInProcessBinding | null {
  const candidate = nativePreviewInProcessModule(moduleValue)
  if (!candidate) {
    return null
  }
  return {
    attach: (handle, frame) => candidate.attachNativePreview(handle, frame),
    update: (frame) => candidate.updateNativePreview(frame),
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
    iosurfaceImportFailures: 0,
    iosurfaceImportLiveCount: 0,
    iosurfaceImportPeakCount: 0,
    iosurfaceImportCeiling: 0
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// What the layer needs from the bounds: its frame inside the host (never the
// screen rect, which moves with the window) and the host height it was
// placed against.
function layerPlacementFromBounds(bounds: PreviewSurfaceBounds): {
  frame: NativePreviewLayerFrame
  hostHeight: number
} {
  return {
    frame: {
      x: Math.round(finiteOr(bounds.hostX, 0)),
      y: Math.round(finiteOr(bounds.hostY, 0)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      scaleFactor: Math.max(1, bounds.scaleFactor),
      visible: bounds.visible !== false,
      cornerRadius: Math.max(0, finiteOr(bounds.cornerRadius, 0))
    },
    hostHeight: Math.max(0, Math.round(finiteOr(bounds.hostHeight, 0)))
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function surfaceAttachmentChanged(current: Attachment, next: Attachment): boolean {
  const a = current.frame
  const b = next.frame
  return (
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.scaleFactor !== b.scaleFactor ||
    a.visible !== b.visible ||
    a.cornerRadius !== b.cornerRadius ||
    current.hostHeight !== next.hostHeight
  )
}
