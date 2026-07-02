import type { RuntimeInfo, SystemPermissionPane } from '../shared/backend'

export const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

export interface RuntimeInfoInput {
  /** `app.getVersion()` — the running app version. */
  appVersion: string
  execPath: string
  captureExecPath?: string
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | 'VIDEORC_NATIVE_PREVIEW_SURFACE'
      | 'VIDEORC_SMOKE_PREVIEW_MOTION'
      | 'VIDEORC_DISABLE_AUTO_PREVIEW'
      | 'VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED'
      | 'VIDEORC_NOTES_WINDOW'
      | 'VIDEORC_NOTES_RECORDING_OVERLAY'
      | 'VIDEORC_COMMENTS_WINDOW'
      | 'VIDEORC_COMMENTS_RECORDING_OVERLAY'
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

function permissionTargetName(path: string, fallback: string): string {
  const name = path.split(/[/\\]/).filter(Boolean).at(-1)
  if (!name) {
    return fallback
  }
  return name.endsWith('.app') ? name.slice(0, -'.app'.length) : name
}

export function permissionUrlForPane(pane: SystemPermissionPane = 'privacy'): string {
  return MACOS_PERMISSION_URLS[pane] ?? MACOS_PERMISSION_URLS.privacy
}

export function assertPermissionShortcutSupported(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new Error('Permission shortcut is only available on macOS.')
  }
}

export function buildRuntimeInfo({
  appVersion,
  execPath,
  captureExecPath,
  env
}: RuntimeInfoInput): RuntimeInfo {
  const targetPath = permissionTargetPath(execPath)
  const isPackaged = !targetPath.endsWith('/Electron.app')
  const captureTargetPath = permissionTargetPath(captureExecPath ?? execPath)

  return {
    version: appVersion,
    isPackaged,
    permissionTargetName: isPackaged ? 'Videorc' : 'Electron',
    permissionTargetPath: targetPath,
    capturePermissionTargetName: permissionTargetName(captureTargetPath, 'Videorc capture helper'),
    capturePermissionTargetPath: captureTargetPath,
    nativePreviewSurfaceProofEnabled: env.VIDEORC_NATIVE_PREVIEW_SURFACE !== '0',
    notesWindowEnabled: env.VIDEORC_NOTES_WINDOW !== '0',
    notesWindowRecordingOverlayAllowed:
      env.VIDEORC_NOTES_WINDOW !== '0' && env.VIDEORC_NOTES_RECORDING_OVERLAY !== '0',
    commentsWindowEnabled: env.VIDEORC_COMMENTS_WINDOW !== '0',
    commentsWindowRecordingOverlayAllowed:
      env.VIDEORC_COMMENTS_WINDOW !== '0' && env.VIDEORC_COMMENTS_RECORDING_OVERLAY !== '0',
    previewSmokeMode: env.VIDEORC_SMOKE_PREVIEW_MOTION === '1',
    disableAutoPreview: env.VIDEORC_DISABLE_AUTO_PREVIEW === '1',
    nativePreviewSurfaceStageSuspended: env.VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED === '1'
  }
}
