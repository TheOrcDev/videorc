import type { PreviewSurfaceStatus } from '../../../shared/backend'
import {
  isCanonicalWindowsD3d11PreviewStatus,
  isNativePreviewCapability,
  isWindowsD3d11PreviewCapability
} from '../../../shared/native-preview-capability'

interface NativePreviewWindowLifecycleSnapshot {
  open: boolean
  supervisor: {
    generation: number
  }
}

type PreviewPresentationSnapshot = Pick<
  PreviewSurfaceStatus,
  | 'backing'
  | 'nativePreviewHostAttached'
  | 'nativePreviewHostKind'
  | 'sourcePixelsPresent'
  | 'state'
  | 'transport'
  | 'windowsD3d11Presenter'
>

export interface NativePreviewFramePollingSuppressionInput {
  recordingActive: boolean
  windowOpen: boolean
  platform?: string
  generation?: number
  status: PreviewPresentationSnapshot
}

export interface NativePreviewFramePollingRequestKeyInput {
  generation: number
  suppress: boolean
  recordingActive: boolean
}

export function nativePreviewFramePollingRequestKey(
  input: NativePreviewFramePollingRequestKeyInput
): string {
  return `${input.generation}:${input.suppress}:${input.recordingActive}`
}

export function nativePreviewFramePollingResponseCanCommit(input: {
  requestKey: string
  currentRequestKey: string | null
  requestGeneration: number
  currentGeneration: number
}): boolean {
  return (
    input.currentRequestKey === input.requestKey &&
    input.requestGeneration === input.currentGeneration
  )
}

export function nativePreviewMainStatusReadGenerationMatches(
  requestedGeneration: number,
  currentGeneration: number
): boolean {
  return requestedGeneration === currentGeneration
}

/**
 * Both native D3D11 and Electron proof presentation are owned by main. Raw
 * backend status may describe either transport, but cannot authorize a host.
 */
export function previewSurfaceStatusRequiresMainAuthority(
  status: Pick<
    PreviewSurfaceStatus,
    'transport' | 'backing' | 'nativePreviewHostKind' | 'windowsD3d11Presenter'
  >
): boolean {
  return (
    status.transport === 'd3d11-shared-texture' ||
    status.transport === 'electron-proof-surface' ||
    status.backing === 'directcomposition-swapchain' ||
    status.backing === 'electron-browser-window' ||
    status.nativePreviewHostKind === 'backend-d3d11-presenter' ||
    status.nativePreviewHostKind === 'proof-surface' ||
    status.windowsD3d11Presenter !== undefined
  )
}

/**
 * A raw backend event cannot grant native or proof presentation authority.
 * If main cannot answer, fail inactive until a generation-bound host status
 * is available.
 */
export function previewSurfaceStatusWithoutMainAuthority(
  status: PreviewSurfaceStatus
): PreviewSurfaceStatus {
  if (!previewSurfaceStatusRequiresMainAuthority(status)) {
    return { ...status, windowsD3d11Presenter: undefined }
  }
  const state =
    status.state === 'unavailable' || status.state === 'stopped' || status.state === 'failed'
      ? status.state
      : 'unavailable'
  return {
    ...status,
    state,
    transport: 'unavailable',
    backing: 'none',
    nativePreviewHostKind: undefined,
    nativePreviewHostAttached: false,
    framePollingSuppressed: true,
    sourcePixelsPresent: false,
    windowsD3d11Presenter: undefined,
    firstFrameContract: undefined,
    firstFrameReason: undefined,
    message:
      state === 'unavailable' && status.state === 'live'
        ? 'Preview is unavailable until Electron main validates the presentation host.'
        : status.message
  }
}

/**
 * Only a platform-canonical attached native presenter can make proof polling
 * redundant while the preview window remains open.
 */
export function nativePreviewFramePollingShouldSuppress(
  input: NativePreviewFramePollingSuppressionInput
): boolean {
  if (!input.windowOpen) {
    return true
  }

  const status = input.status
  const platform = input.platform ?? 'darwin'
  const windowsGeneration = input.generation ?? status.windowsD3d11Presenter?.previewGeneration
  const attachedNativePixels = isWindowsD3d11PreviewCapability(status, platform)
    ? windowsGeneration !== undefined &&
      isCanonicalWindowsD3d11PreviewStatus(status as PreviewSurfaceStatus, windowsGeneration)
    : status.state === 'live' &&
      isNativePreviewCapability(status, platform) &&
      status.sourcePixelsPresent === true &&
      status.nativePreviewHostAttached === true &&
      status.nativePreviewHostKind !== 'proof-surface'

  return input.recordingActive && attachedNativePixels
}

/**
 * A supervisor generation remains unchanged while its window is closed, so a
 * generation match alone cannot authorize an async surface sync to commit.
 */
export function nativePreviewSurfaceSyncCanCommit(
  windowState: NativePreviewWindowLifecycleSnapshot,
  generation?: number
): boolean {
  return (
    windowState.open &&
    (generation === undefined || windowState.supervisor.generation === generation)
  )
}

/** A stopped backend session must be created again, even if renderer state was stale. */
export function nativePreviewSurfaceSyncNeedsCreate(
  surfaceAlreadyCreated: boolean,
  backendState: string
): boolean {
  return surfaceAlreadyCreated && backendState !== 'live'
}

/**
 * Merge backend session telemetry with Electron-main host authority. Host
 * ownership fields are never ORed with raw backend D3D evidence: doing so lets
 * stale native pixels suppress the proof presenter after fallback.
 */
export function mergePreviewSurfaceHostStatus(
  backendStatus: PreviewSurfaceStatus,
  hostStatus: PreviewSurfaceStatus
): PreviewSurfaceStatus {
  const hostLive = hostStatus.state === 'live'
  const hostTerminal =
    hostStatus.state === 'unavailable' ||
    hostStatus.state === 'stopped' ||
    hostStatus.state === 'failed'
  const hostTransport =
    hostStatus.transport !== 'unavailable' ? hostStatus.transport : backendStatus.transport
  const hostBacking = hostStatus.backing !== 'none' ? hostStatus.backing : backendStatus.backing

  if (hostTerminal) {
    return {
      ...backendStatus,
      ...hostStatus,
      transport: 'unavailable',
      backing: 'none',
      framesRendered: Math.max(backendStatus.framesRendered, hostStatus.framesRendered),
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      framePollingSuppressed: true,
      sourcePixelsPresent: false,
      windowsD3d11Presenter: undefined,
      firstFrameContract: undefined,
      firstFrameReason: undefined,
      message: hostStatus.message ?? backendStatus.message
    }
  }

  if (!hostLive) {
    return {
      ...backendStatus,
      framesRendered: Math.max(backendStatus.framesRendered, hostStatus.framesRendered),
      message: backendStatus.message ?? hostStatus.message
    }
  }

  return {
    ...backendStatus,
    state: hostStatus.state,
    source: hostStatus.source,
    transport: hostTransport,
    backing: hostBacking,
    width: hostStatus.width > 0 ? hostStatus.width : backendStatus.width,
    height: hostStatus.height > 0 ? hostStatus.height : backendStatus.height,
    targetFps: hostStatus.targetFps > 0 ? hostStatus.targetFps : backendStatus.targetFps,
    framesRendered: Math.max(backendStatus.framesRendered, hostStatus.framesRendered),
    presentedFrameId: hostStatus.presentedFrameId ?? backendStatus.presentedFrameId,
    compositorFrameLag: hostStatus.compositorFrameLag ?? backendStatus.compositorFrameLag,
    droppedFrames: hostStatus.droppedFrames ?? backendStatus.droppedFrames,
    inputToPresentLatencyMs:
      hostStatus.inputToPresentLatencyMs ?? backendStatus.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms:
      hostStatus.inputToPresentLatencyP50Ms ?? backendStatus.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms:
      hostStatus.inputToPresentLatencyP95Ms ?? backendStatus.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms:
      hostStatus.inputToPresentLatencyP99Ms ?? backendStatus.inputToPresentLatencyP99Ms,
    presentFps: hostStatus.presentFps ?? backendStatus.presentFps,
    intervalP95Ms: hostStatus.intervalP95Ms ?? backendStatus.intervalP95Ms,
    intervalP99Ms: hostStatus.intervalP99Ms ?? backendStatus.intervalP99Ms,
    nativePreviewMutationQueueCapacity:
      hostStatus.nativePreviewMutationQueueCapacity ??
      backendStatus.nativePreviewMutationQueueCapacity,
    nativePreviewMutationQueueDepth:
      hostStatus.nativePreviewMutationQueueDepth ?? backendStatus.nativePreviewMutationQueueDepth,
    nativePreviewMutationQueueActiveCount:
      hostStatus.nativePreviewMutationQueueActiveCount ??
      backendStatus.nativePreviewMutationQueueActiveCount,
    nativePreviewMutationQueuePendingCount:
      hostStatus.nativePreviewMutationQueuePendingCount ??
      backendStatus.nativePreviewMutationQueuePendingCount,
    nativePreviewMutationQueueMaxDepth:
      hostStatus.nativePreviewMutationQueueMaxDepth ??
      backendStatus.nativePreviewMutationQueueMaxDepth,
    nativePreviewMutationQueueRejectedCount:
      hostStatus.nativePreviewMutationQueueRejectedCount ??
      backendStatus.nativePreviewMutationQueueRejectedCount,
    framePollingSuppressed: hostStatus.framePollingSuppressed,
    sourcePixelsPresent: hostStatus.sourcePixelsPresent,
    nativePreviewHostKind: hostStatus.nativePreviewHostKind,
    nativePreviewHostAttached: hostStatus.nativePreviewHostAttached,
    windowsD3d11Presenter: hostStatus.windowsD3d11Presenter,
    firstFrameContract: hostStatus.firstFrameContract,
    firstFrameReason: hostStatus.firstFrameReason,
    pendingHostCommandCount: backendStatus.pendingHostCommandCount,
    bounds: hostStatus.bounds ?? backendStatus.bounds,
    startedAt: hostStatus.startedAt ?? backendStatus.startedAt,
    updatedAt: hostStatus.updatedAt,
    message: hostStatus.message ?? backendStatus.message
  }
}
