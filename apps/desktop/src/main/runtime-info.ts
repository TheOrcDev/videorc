import type { RuntimeInfo, SystemPermissionPane } from '../shared/backend'

export const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

export interface RuntimeInfoInput {
  execPath: string
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | 'VIDEORC_NATIVE_PREVIEW_SURFACE'
      | 'VIDEORC_SMOKE_PREVIEW_MOTION'
      | 'VIDEORC_DISABLE_AUTO_PREVIEW'
      | 'VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED'
    >
  >
}

export function permissionTargetPath(execPath: string): string {
  const appMarker = '.app/Contents/MacOS/'
  const markerIndex = execPath.indexOf(appMarker)
  if (markerIndex === -1) {
    return execPath
  }

  return execPath.slice(0, markerIndex + '.app'.length)
}

export function permissionUrlForPane(pane: SystemPermissionPane = 'privacy'): string {
  return MACOS_PERMISSION_URLS[pane] ?? MACOS_PERMISSION_URLS.privacy
}

export function assertPermissionShortcutSupported(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new Error('Permission shortcut is only available on macOS.')
  }
}

export function buildRuntimeInfo({ execPath, env }: RuntimeInfoInput): RuntimeInfo {
  const targetPath = permissionTargetPath(execPath)
  const isPackaged = !targetPath.endsWith('/Electron.app')

  return {
    isPackaged,
    permissionTargetName: isPackaged ? 'Videorc' : 'Electron',
    permissionTargetPath: targetPath,
    nativePreviewSurfaceProofEnabled: env.VIDEORC_NATIVE_PREVIEW_SURFACE !== '0',
    previewSmokeMode: env.VIDEORC_SMOKE_PREVIEW_MOTION === '1',
    disableAutoPreview: env.VIDEORC_DISABLE_AUTO_PREVIEW === '1',
    nativePreviewSurfaceStageSuspended: env.VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED === '1'
  }
}
