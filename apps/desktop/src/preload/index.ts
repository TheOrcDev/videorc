import { contextBridge, ipcRenderer } from 'electron'

import type {
  BackendConnection,
  BackendLogEvent,
  GlassWallpaperState,
  PreviewWindowState,
  VideorcApi
} from '../shared/backend'

const api: VideorcApi = {
  getBackendConnection: () => ipcRenderer.invoke('backend:get-connection'),
  getBackendLogs: () => ipcRenderer.invoke('backend:get-logs'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:get-runtime-info'),
  pickScreenImage: () => ipcRenderer.invoke('screens:pick-image'),
  openOAuthUrl: (authUrl) => ipcRenderer.invoke('oauth:open-url', authUrl),
  getOAuthCallbackRedirectUri: (platform) =>
    ipcRenderer.invoke('oauth:callback-redirect-uri', platform),
  getNativePreviewSurfaceMode: () => ipcRenderer.invoke('preview-surface:mode'),
  setNativeTheme: (theme) => ipcRenderer.invoke('app:set-native-theme', theme),
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
  openSystemPermissions: (pane) => ipcRenderer.invoke('system:open-permissions', pane),
  revealPermissionTarget: () => ipcRenderer.invoke('system:reveal-permission-target'),
  onOAuthCallbackUrl: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, callbackUrl: string): void => {
      callback(callbackUrl)
    }
    ipcRenderer.on('oauth:callback-url', listener)
    return () => ipcRenderer.removeListener('oauth:callback-url', listener)
  },
  onShortcutNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, key: string): void => {
      callback(key)
    }
    ipcRenderer.on('shortcut:navigate', listener)
    return () => ipcRenderer.removeListener('shortcut:navigate', listener)
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
  },
  getGlassWallpaper: () => ipcRenderer.invoke('glass:wallpaper:get'),
  onGlassWallpaper: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: GlassWallpaperState): void => {
      callback(state)
    }
    ipcRenderer.on('glass:wallpaper', listener)
    return () => ipcRenderer.removeListener('glass:wallpaper', listener)
  },
  onGlassGeometry: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      geometry: Pick<GlassWallpaperState, 'window' | 'display'>
    ): void => {
      callback(geometry)
    }
    ipcRenderer.on('glass:geometry', listener)
    return () => ipcRenderer.removeListener('glass:geometry', listener)
  }
}

contextBridge.exposeInMainWorld('videorc', api)
