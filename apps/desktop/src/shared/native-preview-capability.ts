import type {
  NativePreviewHostKind,
  PreviewSurfaceBacking,
  PreviewSurfaceStatus,
  PreviewTransport
} from './backend'

export type NativePreviewCapability = 'macos-metal' | 'windows-d3d11'

export interface NativePreviewCapabilityInput {
  transport: PreviewTransport
  backing: PreviewSurfaceBacking
  nativePreviewHostKind?: NativePreviewHostKind
}

/**
 * One platform-aware definition of a truthful native preview.
 *
 * A transport/backing pair is not portable: Metal is native only on macOS,
 * while Windows additionally requires the backend-owned D3D11 presenter.
 * Browser/JPEG proof transports never satisfy this predicate.
 */
export function nativePreviewCapability(
  input: NativePreviewCapabilityInput,
  platform: string
): NativePreviewCapability | null {
  if (
    platform === 'darwin' &&
    input.transport === 'native-surface' &&
    input.backing === 'cametal-layer'
  ) {
    return 'macos-metal'
  }
  if (
    platform === 'win32' &&
    input.transport === 'd3d11-shared-texture' &&
    input.backing === 'directcomposition-swapchain' &&
    input.nativePreviewHostKind === 'backend-d3d11-presenter'
  ) {
    return 'windows-d3d11'
  }
  return null
}

export function isNativePreviewCapability(
  input: NativePreviewCapabilityInput,
  platform: string
): boolean {
  return nativePreviewCapability(input, platform) !== null
}

export function isWindowsD3d11PreviewCapability(
  input: NativePreviewCapabilityInput,
  platform: string
): boolean {
  return nativePreviewCapability(input, platform) === 'windows-d3d11'
}

/**
 * Raw backend evidence required before Electron main may adopt the D3D11
 * presenter. This deliberately does not require main-owned host fields: the
 * backend cannot author those fields across the renderer-safe protocol.
 */
export function hasCanonicalWindowsD3d11PresenterEvidence(
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
    Number.isSafeInteger(presenter.mediaGeneration) &&
    presenter.mediaGeneration >= 0 &&
    presenter.generationMatches === true &&
    presenter.ownerProcessMatches === true &&
    presenter.sameAdapter === true &&
    presenter.sourceLive === true &&
    presenter.firstPresentSucceeded === true &&
    presenter.successfulPresents > 0 &&
    presenter.fallbackReason === undefined
  )
}

/** Main-authorized D3D11 presentation truth used by every ownership decision. */
export function isCanonicalWindowsD3d11PreviewStatus(
  status: PreviewSurfaceStatus,
  generation: number
): boolean {
  return (
    hasCanonicalWindowsD3d11PresenterEvidence(status, generation) &&
    status.nativePreviewHostKind === 'backend-d3d11-presenter' &&
    status.nativePreviewHostAttached === true &&
    status.sourcePixelsPresent === true
  )
}
