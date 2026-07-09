import type { NativePreviewRealSurfaceDriver } from '../shared/native-preview-host-driver'
import {
  createNativePreviewInProcessDriver,
  nativePreviewInProcessBindingFromModule
} from './native-preview-in-process-driver'

export interface NativePreviewInProcessDriverLoadOptions {
  modulePath: string
  loadModule: (modulePath: string) => unknown
  getNativeWindowHandle: () => Buffer | null
}

export type NativePreviewInProcessDriverLoadResult =
  | { driver: NativePreviewRealSurfaceDriver; unavailableReason?: undefined }
  | { driver: null; unavailableReason: string }

export function loadNativePreviewInProcessDriver(
  options: NativePreviewInProcessDriverLoadOptions
): NativePreviewInProcessDriverLoadResult {
  let loadedModule: unknown
  try {
    loadedModule = options.loadModule(options.modulePath)
  } catch (error) {
    return {
      driver: null,
      unavailableReason: `In-process CAMetalLayer addon failed to load from ${options.modulePath}: ${errorMessage(error)}`
    }
  }

  const binding = nativePreviewInProcessBindingFromModule(loadedModule)
  if (!binding) {
    return {
      driver: null,
      unavailableReason: `In-process CAMetalLayer addon at ${options.modulePath} did not export the required attachment, presentation, and metrics functions`
    }
  }

  return {
    driver: createNativePreviewInProcessDriver({
      binding,
      getNativeWindowHandle: options.getNativeWindowHandle
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
