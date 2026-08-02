import type { PreviewSurfaceStatus } from '../shared/backend'
import {
  isNativePreviewCapability,
  isWindowsD3d11PreviewCapability,
  nativePreviewCapability
} from '../shared/native-preview-capability'

export interface NativePreviewHelperFallbackPolicyOptions {
  fallbackFlag?: string
  explicitHelperPath?: string
}

export interface NativePreviewPlacementOwnershipInput {
  status: PreviewSurfaceStatus
  driverKind: 'in-process' | 'external-module' | 'helper-process' | null
  recentPresent: boolean
  platform?: NodeJS.Platform
}

export type NativePreviewPresentFailureDisposition =
  | 'presented'
  | 'benign-skip'
  | 'retain-native'
  | 'disable-native'

export type NativePreviewSupervisorDisposition = 'pending' | 'live' | 'fallback'

export interface WindowsD3d11PresenterReconcileInput {
  platform: NodeJS.Platform
  previewWindowOpen: boolean
  generation: number
  trustedGeneration: number | null
}

function backendD3d11PresenterIsCanonical(
  status: PreviewSurfaceStatus,
  generation: number
): boolean {
  const presenter = status.windowsD3d11Presenter
  return Boolean(
    status.state === 'live' &&
    status.transport === 'd3d11-shared-texture' &&
    status.backing === 'directcomposition-swapchain' &&
    presenter?.layered === true &&
    presenter.transparent === true &&
    presenter.noActivate === true &&
    presenter.excludedFromCapture === true &&
    presenter.windowActive === false &&
    presenter.windowFocused === false &&
    presenter.previewGeneration === generation &&
    presenter.generationMatches === true &&
    presenter.ownerProcessMatches === true &&
    presenter.sameAdapter === true &&
    presenter.sourceLive === true &&
    presenter.firstPresentSucceeded === true &&
    presenter.successfulPresents > 0 &&
    presenter.fallbackReason === undefined
  )
}

/**
 * Reconcile renderer-safe backend evidence into Electron-main preview state.
 *
 * The trusted generation is armed only after main has sent a freshly-read HWND
 * for that lifecycle generation. A queued status from an older preview can
 * therefore never revive the D3D11 claim after close/reopen.
 */
export function reconcileWindowsD3d11PresenterStatus(
  current: PreviewSurfaceStatus,
  backend: PreviewSurfaceStatus | null,
  input: WindowsD3d11PresenterReconcileInput
): PreviewSurfaceStatus {
  const generationIsTrusted =
    input.platform === 'win32' &&
    input.previewWindowOpen &&
    input.trustedGeneration === input.generation
  if (!generationIsTrusted || !backend) {
    if (
      current.nativePreviewHostKind !== 'backend-d3d11-presenter' &&
      current.windowsD3d11Presenter === undefined
    ) {
      return current
    }
    return {
      ...current,
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      framePollingSuppressed: false,
      sourcePixelsPresent: false,
      windowsD3d11Presenter: undefined,
      firstFrameContract: undefined,
      firstFrameReason: undefined,
      updatedAt: new Date().toISOString(),
      message: 'Backend D3D11 presenter authority ended; Electron proof fallback is active.'
    }
  }

  const presenter = backend.windowsD3d11Presenter
  // Event delivery is independent from the HWND/bounds request that arms a
  // generation. A queued status from the retired presenter must be ignored,
  // not interpreted as evidence that the current presenter fell back.
  if (
    presenter?.previewGeneration !== undefined &&
    presenter.previewGeneration !== input.generation
  ) {
    return current
  }
  const currentPresenter = current.windowsD3d11Presenter
  if (
    presenter &&
    currentPresenter &&
    currentPresenter.previewGeneration === presenter.previewGeneration &&
    (presenter.successfulPresents < currentPresenter.successfulPresents ||
      (currentPresenter.fallbackReason !== undefined &&
        presenter.fallbackReason === undefined &&
        presenter.successfulPresents <= currentPresenter.successfulPresents))
  ) {
    return current
  }
  if (backendD3d11PresenterIsCanonical(backend, input.generation) && presenter) {
    const presentedFrameId = Math.max(
      backend.presentedFrameId ?? 0,
      presenter.lastPresentedSequence ?? 0,
      presenter.successfulPresents
    )
    return {
      ...current,
      state: 'live',
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter',
      nativePreviewHostAttached: true,
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      windowsD3d11Presenter: presenter,
      presentedFrameId,
      framesRendered: Math.max(current.framesRendered, presentedFrameId),
      firstFrameContract: 'met',
      firstFrameReason: 'Backend D3D11 presenter completed its first live-source present.',
      updatedAt: backend.updatedAt,
      message: backend.message ?? 'Backend D3D11 DirectComposition preview is presenting.'
    }
  }

  return {
    ...current,
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    nativePreviewHostKind: 'proof-surface',
    nativePreviewHostAttached: false,
    framePollingSuppressed: false,
    sourcePixelsPresent:
      current.nativePreviewHostKind === 'proof-surface' && current.sourcePixelsPresent,
    windowsD3d11Presenter: presenter,
    firstFrameContract: 'fallback',
    firstFrameReason:
      presenter?.fallbackReason ?? 'Backend D3D11 presenter is waiting for a live-source present.',
    updatedAt: backend.updatedAt,
    message:
      backend.message ??
      `Backend D3D11 presenter is unavailable: ${
        presenter?.fallbackReason ?? 'waiting for first live-source present'
      }.`
  }
}

/**
 * Classify the active preview host for the user-facing lifecycle supervisor.
 *
 * macOS promises a CAMetalLayer, so its Electron proof surface is a truthful
 * fallback. Windows intentionally uses the Electron surface as its supported
 * presenter; it is live only after the first-frame contract proves source
 * pixels are present, and remains pending before that proof arrives.
 */
export function nativePreviewSupervisorDisposition(
  status: Pick<
    PreviewSurfaceStatus,
    'transport' | 'backing' | 'nativePreviewHostKind' | 'firstFrameContract'
  >,
  platform: NodeJS.Platform
): NativePreviewSupervisorDisposition {
  const capability = nativePreviewCapability(status, platform)
  if (capability === 'macos-metal') {
    return 'live'
  }
  if (capability === 'windows-d3d11' && status.firstFrameContract === 'met') {
    return 'live'
  }
  if (capability === 'windows-d3d11' && status.firstFrameContract !== 'fallback') {
    return 'pending'
  }
  return 'fallback'
}

export function nativePreviewSupervisorFallbackReason(
  status: Pick<
    PreviewSurfaceStatus,
    'transport' | 'backing' | 'nativePreviewHostKind' | 'firstFrameContract' | 'firstFrameReason'
  >,
  platform: NodeJS.Platform,
  fallbackReason: string
): string {
  if (
    isWindowsD3d11PreviewCapability(status, platform) &&
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
  const platform = input.platform ?? process.platform
  const attachedNativeSurface = nativePreviewSurfaceHasAttachedNativePixels(input.status, platform)
  return (
    attachedNativeSurface &&
    (isWindowsD3d11PreviewCapability(input.status, platform) ||
      input.driverKind === 'in-process' ||
      input.recentPresent)
  )
}

export function nativePreviewSurfaceHasAttachedNativePixels(
  status: PreviewSurfaceStatus,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    status.state === 'live' &&
    isNativePreviewCapability(status, platform) &&
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
  suppressed: boolean,
  platform: NodeJS.Platform = process.platform
): PreviewSurfaceStatus {
  const attachedNativeSurface = nativePreviewSurfaceHasAttachedNativePixels(status, platform)

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
