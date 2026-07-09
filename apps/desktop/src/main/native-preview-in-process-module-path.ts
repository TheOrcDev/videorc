import { join } from 'node:path'

export type NativePreviewInProcessModuleResolution =
  | { path: string; source: 'explicit' | 'packaged' | 'development' }
  | { path: undefined; source: 'unavailable'; reason: string }

export interface NativePreviewInProcessModulePathOptions {
  explicitPath?: string
  isPackaged: boolean
  resourcesPath: string
  workspaceRoot: string
  exists: (path: string) => boolean
}

export function resolveNativePreviewInProcessModule(
  options: NativePreviewInProcessModulePathOptions
): NativePreviewInProcessModuleResolution {
  const explicitPath = options.explicitPath?.trim()
  if (explicitPath) {
    return { path: explicitPath, source: 'explicit' }
  }
  if (options.isPackaged) {
    const path = join(options.resourcesPath, 'videorc_native_preview.node')
    return options.exists(path)
      ? { path, source: 'packaged' }
      : {
          path: undefined,
          source: 'unavailable',
          reason: `In-process native preview addon was not found at ${path}`
        }
  }
  const developmentPath = join(
    options.workspaceRoot,
    'target',
    'debug',
    'videorc_native_preview.node'
  )
  if (options.exists(developmentPath)) {
    return { path: developmentPath, source: 'development' }
  }
  return {
    path: undefined,
    source: 'unavailable',
    reason: 'In-process native preview addon is not available in this development build'
  }
}
