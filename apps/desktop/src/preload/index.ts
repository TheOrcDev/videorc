import { contextBridge, ipcRenderer, shell } from 'electron'

import type {
  BackendConnection,
  BackendLogEvent,
  PreviewWindowState,
  RuntimeInfo,
  SystemPermissionPane,
  VideorcApi
} from '../shared/backend'

const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

async function openSystemPermissions(pane: SystemPermissionPane = 'privacy'): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Permission shortcut is only available on macOS.')
  }

  await shell.openExternal(MACOS_PERMISSION_URLS[pane] ?? MACOS_PERMISSION_URLS.privacy)
}

function permissionTargetPath(): string {
  const appMarker = '.app/Contents/MacOS/'
  const markerIndex = process.execPath.indexOf(appMarker)
  if (markerIndex === -1) {
    return process.execPath
  }

  return process.execPath.slice(0, markerIndex + '.app'.length)
}

function runtimeInfo(): RuntimeInfo {
  const targetPath = permissionTargetPath()
  const isPackaged = !targetPath.endsWith('/Electron.app')

  return {
    isPackaged,
    permissionTargetName: isPackaged ? 'Videorc' : 'Electron',
    permissionTargetPath: targetPath,
    nativePreviewSurfaceProofEnabled: process.env.VIDEORC_NATIVE_PREVIEW_SURFACE !== '0',
    previewSmokeMode: process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1',
    disableAutoPreview: process.env.VIDEORC_DISABLE_AUTO_PREVIEW === '1',
    nativePreviewSurfaceStageSuspended: process.env.VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED === '1'
  }
}

async function revealPermissionTarget(): Promise<void> {
  shell.showItemInFolder(permissionTargetPath())
}

const api: VideorcApi = {
  getBackendConnection: () => ipcRenderer.invoke('backend:get-connection'),
  getBackendLogs: () => ipcRenderer.invoke('backend:get-logs'),
  getRuntimeInfo: () => Promise.resolve(runtimeInfo()),
  pickScreenImage: () => ipcRenderer.invoke('screens:pick-image'),
  openOAuthUrl: (authUrl) => ipcRenderer.invoke('oauth:open-url', authUrl),
  getOAuthCallbackRedirectUri: (platform) =>
    ipcRenderer.invoke('oauth:callback-redirect-uri', platform),
  getNativePreviewSurfaceMode: () => ipcRenderer.invoke('preview-surface:mode'),
  getNativePreviewMainPumpActive: () => ipcRenderer.invoke('preview-surface:pump-mode'),
  onNativePreviewMainPumpActive: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, active: boolean): void => callback(active)
    ipcRenderer.on('preview-surface:pump-mode', listener)
    return () => ipcRenderer.removeListener('preview-surface:pump-mode', listener)
  },
  openPreviewWindow: () => ipcRenderer.invoke('preview-window:open'),
  closePreviewWindow: () => ipcRenderer.invoke('preview-window:close'),
  getPreviewWindowState: () => ipcRenderer.invoke('preview-window:get-state'),
  setPreviewWindowAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('preview-window:set-always-on-top', alwaysOnTop),
  setPreviewWindowAspectRatio: (width, height) =>
    ipcRenderer.invoke('preview-window:set-aspect-ratio', width, height),
  onPreviewWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PreviewWindowState): void =>
      callback(state)
    ipcRenderer.on('preview-window:state', listener)
    return () => ipcRenderer.removeListener('preview-window:state', listener)
  },
  createNativePreviewSurface: (bounds) => ipcRenderer.invoke('preview-surface:create', bounds),
  updateNativePreviewSurfaceBounds: (bounds) =>
    ipcRenderer.invoke('preview-surface:update-bounds', bounds),
  applyNativePreviewHostCommands: (commands) =>
    ipcRenderer.invoke('preview-surface:apply-host-commands', commands),
  updateNativePreviewSurfaceScene: (scene) =>
    ipcRenderer.invoke('preview-surface:update-scene', scene),
  updateNativePreviewSurfaceCompositor: (status) =>
    ipcRenderer.invoke('preview-surface:update-compositor', status),
  setNativePreviewSurfaceFramePollingSuppressed: (suppressed) =>
    ipcRenderer.invoke('preview-surface:set-frame-polling-suppressed', suppressed),
  destroyNativePreviewSurface: () => ipcRenderer.invoke('preview-surface:destroy'),
  getNativePreviewSurfaceStatus: () => ipcRenderer.invoke('preview-surface:status'),
  openSystemPermissions,
  revealPermissionTarget,
  onOAuthCallbackUrl: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, callbackUrl: string): void => {
      callback(callbackUrl)
    }
    ipcRenderer.on('oauth:callback-url', listener)
    return () => ipcRenderer.removeListener('oauth:callback-url', listener)
  },
  onBackendConnection: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, connection: BackendConnection): void => {
      callback(connection)
    }
    ipcRenderer.on('backend:connection', listener)
    return () => ipcRenderer.removeListener('backend:connection', listener)
  },
  onBackendLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, log: BackendLogEvent): void => {
      callback(log)
    }
    ipcRenderer.on('backend:log', listener)
    return () => ipcRenderer.removeListener('backend:log', listener)
  }
}

contextBridge.exposeInMainWorld('videorc', api)
