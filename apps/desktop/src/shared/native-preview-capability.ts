import type { NativePreviewHostKind, PreviewSurfaceBacking, PreviewTransport } from './backend'

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
