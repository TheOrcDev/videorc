import type { PreviewSurfaceStatus } from '../shared/backend'

export interface NativePreviewHelperFallbackPolicyOptions {
  fallbackFlag?: string
  explicitHelperPath?: string
}

export interface NativePreviewPlacementOwnershipInput {
  status: PreviewSurfaceStatus
  driverKind: 'in-process' | 'external-module' | 'helper-process' | null
  recentPresent: boolean
}

export type NativePreviewPresentFailureDisposition =
  | 'presented'
  | 'benign-skip'
  | 'retain-native'
  | 'disable-native'

export type NativePreviewSupervisorDisposition = 'pending' | 'live' | 'fallback'

/**
 * Classify the active preview host for the user-facing lifecycle supervisor.
 *
 * macOS promises a CAMetalLayer, so its Electron proof surface is a truthful
 * fallback. Windows intentionally uses the Electron surface as its supported
 * presenter; it is live only after the first-frame contract proves source
 * pixels are present, and remains pending before that proof arrives.
 */
export function nativePreviewSupervisorDisposition(
  status: Pick<PreviewSurfaceStatus, 'transport' | 'firstFrameContract'>,
  platform: NodeJS.Platform
): NativePreviewSupervisorDisposition {
  if (status.transport === 'native-surface') {
    return 'live'
  }
  if (
    status.transport === 'electron-proof-surface' &&
    platform === 'win32' &&
    status.firstFrameContract === 'met'
  ) {
    return 'live'
  }
  if (
    status.transport === 'electron-proof-surface' &&
    platform === 'win32' &&
    status.firstFrameContract !== 'fallback'
  ) {
    return 'pending'
  }
  return 'fallback'
}

export function nativePreviewSupervisorFallbackReason(
  status: Pick<PreviewSurfaceStatus, 'transport' | 'firstFrameContract' | 'firstFrameReason'>,
  platform: NodeJS.Platform,
  fallbackReason: string
): string {
  if (
    platform === 'win32' &&
    status.transport === 'electron-proof-surface' &&
    status.firstFrameContract === 'fallback' &&
    status.firstFrameReason?.trim()
  ) {
    return status.firstFrameReason
  }
  return fallbackReason
}

export function nativePreviewPresentFailureDisposition(input: {
  driverKind: 'in-process' | 'external-module' | 'helper-process' | null
  surfaceVisible: boolean
  presentValidated: boolean
  consecutiveFailures: number
  failureThreshold: number
}): NativePreviewPresentFailureDisposition {
  if (input.driverKind === 'in-process' && !input.surfaceVisible) {
    return 'benign-skip'
  }
  if (input.presentValidated) {
    return 'presented'
  }
  if (
    input.driverKind === 'in-process' &&
    input.consecutiveFailures + 1 >= Math.max(1, input.failureThreshold)
  ) {
    return 'disable-native'
  }
  return 'retain-native'
}

export function nativePreviewValidatedHandoffStatus(
  status: PreviewSurfaceStatus,
  input: { sceneRevision?: number; runId?: string }
): PreviewSurfaceStatus {
  return {
    ...status,
    nativePreviewPresentedSceneRevision: input.sceneRevision,
    nativePreviewCompositorRunId: input.runId
  }
}

export function nativePreviewPlacementOwnedByNativeSurface(
  input: NativePreviewPlacementOwnershipInput
): boolean {
  const attachedNativeSurface = nativePreviewSurfaceHasAttachedNativePixels(input.status)
  return attachedNativeSurface && (input.driverKind === 'in-process' || input.recentPresent)
}

export function nativePreviewSurfaceHasAttachedNativePixels(status: PreviewSurfaceStatus): boolean {
  return (
    status.state === 'live' &&
    status.transport === 'native-surface' &&
    status.backing === 'cametal-layer' &&
    status.sourcePixelsPresent === true &&
    status.nativePreviewHostAttached === true &&
    status.nativePreviewHostKind !== 'proof-surface'
  )
}

export function nativePreviewDriverFailureFallbackStatus(
  status: PreviewSurfaceStatus,
  input: { reason: string; framePollingSuppressed: boolean }
): PreviewSurfaceStatus {
  return {
    ...status,
    state: 'live',
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    framePollingSuppressed: input.framePollingSuppressed,
    sourcePixelsPresent: false,
    nativePreviewHostKind: 'proof-surface',
    nativePreviewHostAttached: false,
    updatedAt: new Date().toISOString(),
    message: input.reason
  }
}

export function nativePreviewHelperFallbackAllowed(
  options: NativePreviewHelperFallbackPolicyOptions
): boolean {
  return options.fallbackFlag?.trim() === '1' || Boolean(options.explicitHelperPath?.trim())
}

export function nativePreviewProofPollingSuppressed(input: {
  lifecycleSuppressed: boolean
  nativeSurfaceOwnsPresentation: boolean
  nativeFailureFallbackActive?: boolean
}): boolean {
  return (
    input.nativeSurfaceOwnsPresentation ||
    (input.lifecycleSuppressed && input.nativeFailureFallbackActive !== true)
  )
}

export function nativePreviewFramePollingSuppressionStatus(
  status: PreviewSurfaceStatus,
  suppressed: boolean
): PreviewSurfaceStatus {
  const attachedNativeSurface = nativePreviewSurfaceHasAttachedNativePixels(status)

  return {
    ...status,
    framePollingSuppressed: suppressed,
    sourcePixelsPresent: suppressed && !attachedNativeSurface ? false : status.sourcePixelsPresent,
    updatedAt: new Date().toISOString(),
    message: attachedNativeSurface
      ? status.message
      : suppressed
        ? 'Electron proof preview surface frame polling is suppressed while recording.'
        : 'Electron proof preview surface frame polling is enabled.'
  }
}

/**
 * A renderer may deliver its pre-close "unsuppress" request after the preview
 * window has already been destroyed. Return a complete, still-suppressed status
 * for that stale request; callers may resume through the normal suppression
 * path once a replacement window exists.
 */
export function nativePreviewClosedWindowUnsuppressStatus(
  status: PreviewSurfaceStatus
): PreviewSurfaceStatus {
  return nativePreviewFramePollingSuppressionStatus(status, true)
}
