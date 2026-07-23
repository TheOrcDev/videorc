import { release } from 'node:os'

import type { RuntimeGpuDevice, RuntimeInfo, SystemPermissionPane } from '../shared/backend'

export const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

// Windows has no per-app screen-capture permission, so 'screen-recording' has
// no dedicated pane and falls back to the Privacy hub like 'privacy'.
export const WINDOWS_PERMISSION_URLS: Partial<Record<SystemPermissionPane, string>> = {
  privacy: 'ms-settings:privacy',
  camera: 'ms-settings:privacy-webcam',
  microphone: 'ms-settings:privacy-microphone'
}

export interface RuntimeInfoInput {
  /** `app.getVersion()` — the running app version. */
  appVersion: string
  execPath: string
  captureExecPath?: string
  platform?: NodeJS.Platform
  arch?: string
  osRelease?: string
  gpuInfo?: unknown
  hardwareAccelerationDisabled?: boolean
  gpuFallback?: RuntimeInfo['gpuFallback']
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | 'VIDEORC_NATIVE_PREVIEW_SURFACE'
      | 'VIDEORC_SMOKE_PREVIEW_MOTION'
      | 'VIDEORC_DISABLE_AUTO_PREVIEW'
      | 'VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW'
      | 'VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED'
      | 'VIDEORC_NOTES_WINDOW'
      | 'VIDEORC_NOTES_RECORDING_OVERLAY'
      | 'VIDEORC_COMMENTS_WINDOW'
      | 'VIDEORC_COMMENTS_RECORDING_OVERLAY'
      | 'VIDEORC_WINDOWS_LIVE_AUDIO_SMOKE'
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

export function permissionUrlForPane(
  pane: SystemPermissionPane = 'privacy',
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return WINDOWS_PERMISSION_URLS[pane] ?? WINDOWS_PERMISSION_URLS.privacy ?? 'ms-settings:privacy'
  }
  return MACOS_PERMISSION_URLS[pane] ?? MACOS_PERMISSION_URLS.privacy
}

export function assertPermissionShortcutSupported(platform: NodeJS.Platform): void {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error('Permission shortcuts are only available on macOS and Windows.')
  }
}

export function buildRuntimeInfo({
  appVersion,
  execPath,
  captureExecPath,
  platform = process.platform,
  arch = process.arch,
  osRelease = release(),
  gpuInfo,
  hardwareAccelerationDisabled = false,
  gpuFallback = {
    source: 'none',
    reason: null,
    crashCount: 0,
    updatedAt: null,
    retryScheduled: false,
    retryAttempts: 0
  },
  env
}: RuntimeInfoInput): RuntimeInfo {
  const targetPath = permissionTargetPath(execPath)
  const isPackaged = !targetPath.endsWith('/Electron.app')
  const captureTargetPath = permissionTargetPath(captureExecPath ?? execPath)

  return {
    version: appVersion,
    platform,
    arch,
    osRelease,
    gpuDevices: normalizeRuntimeGpuDevices(gpuInfo),
    hardwareAccelerationDisabled,
    gpuFallback,
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
    windowsLiveAudioSmokeMode: env.VIDEORC_WINDOWS_LIVE_AUDIO_SMOKE === '1',
    disableAutoPreview: env.VIDEORC_DISABLE_AUTO_PREVIEW === '1',
    disableAutoSourcePreview: env.VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW === '1',
    nativePreviewSurfaceStageSuspended: env.VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED === '1'
  }
}

export function normalizeRuntimeGpuDevices(gpuInfo: unknown): RuntimeGpuDevice[] {
  if (!isRecord(gpuInfo)) {
    return []
  }

  const devices = Array.isArray(gpuInfo.gpuDevice) ? gpuInfo.gpuDevice : []
  return devices
    .map((device) => normalizeRuntimeGpuDevice(device))
    .filter((device): device is RuntimeGpuDevice => device !== null)
}

function normalizeRuntimeGpuDevice(device: unknown): RuntimeGpuDevice | null {
  if (!isRecord(device)) {
    return null
  }

  const normalized: RuntimeGpuDevice = {}
  const vendorId = stringOrNumber(device.vendorId)
  const deviceId = stringOrNumber(device.deviceId)
  const active = typeof device.active === 'boolean' ? device.active : undefined
  const vendor = stringValue(device.vendorString ?? device.vendor)
  const description = stringValue(device.deviceString ?? device.description)

  if (vendorId !== undefined) {
    normalized.vendorId = vendorId
  }
  if (deviceId !== undefined) {
    normalized.deviceId = deviceId
  }
  if (active !== undefined) {
    normalized.active = active
  }
  if (vendor !== undefined) {
    normalized.vendor = vendor
  }
  if (description !== undefined) {
    normalized.description = description
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return stringValue(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
