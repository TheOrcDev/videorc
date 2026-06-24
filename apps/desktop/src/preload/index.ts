import { contextBridge, ipcRenderer } from 'electron'

import type {
  BackendConnection,
  BackendLogEvent,
  CommentsWindowState,
  GlassWallpaperState,
  LiveChatSnapshot,
  NotesDocument,
  NotesWindowState,
  PreviewWindowState,
  VideorcApi
} from '../shared/backend'

const api: VideorcApi = {
  getBackendConnection: () => ipcRenderer.invoke('backend:get-connection'),
  getBackendLogs: () => ipcRenderer.invoke('backend:get-logs'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:get-runtime-info'),
  pickScreenImage: () => ipcRenderer.invoke('screens:pick-image'),
  importBackgroundImage: () => ipcRenderer.invoke('backgrounds:import-image'),
  getBundledBackgroundAssets: () => ipcRenderer.invoke('backgrounds:bundled-assets'),
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
  togglePreviewWindow: () => ipcRenderer.invoke('preview-window:toggle'),
  getPreviewWindowState: () => ipcRenderer.invoke('preview-window:get-state'),
  reportPreviewPermissionRequired: (permissionStatus, message, generation) =>
    ipcRenderer.invoke('preview-window:permission-required', permissionStatus, message, generation),
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
  openNotesWindow: () => ipcRenderer.invoke('notes-window:open'),
  closeNotesWindow: () => ipcRenderer.invoke('notes-window:close'),
  getNotesWindowState: () => ipcRenderer.invoke('notes-window:get-state'),
  setNotesWindowAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('notes-window:set-always-on-top', alwaysOnTop),
  getNotesDocument: () => ipcRenderer.invoke('notes-window:get-document'),
  saveNotesDocument: (patch) => ipcRenderer.invoke('notes-window:save-document', patch),
  onNotesWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: NotesWindowState): void =>
      callback(state)
    ipcRenderer.on('notes-window:state', listener)
    return () => ipcRenderer.removeListener('notes-window:state', listener)
  },
  onNotesDocument: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, document: NotesDocument): void =>
      callback(document)
    ipcRenderer.on('notes-window:document', listener)
    return () => ipcRenderer.removeListener('notes-window:document', listener)
  },
  openCommentsWindow: () => ipcRenderer.invoke('comments-window:open'),
  closeCommentsWindow: () => ipcRenderer.invoke('comments-window:close'),
  toggleCommentsWindow: () => ipcRenderer.invoke('comments-window:toggle'),
  getCommentsWindowState: () => ipcRenderer.invoke('comments-window:get-state'),
  setCommentsWindowAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('comments-window:set-always-on-top', alwaysOnTop),
  onCommentsWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CommentsWindowState): void =>
      callback(state)
    ipcRenderer.on('comments-window:state', listener)
    return () => ipcRenderer.removeListener('comments-window:state', listener)
  },
  pushCommentsSnapshot: (snapshot) => ipcRenderer.invoke('comments-window:push-snapshot', snapshot),
  getCommentsSnapshot: () => ipcRenderer.invoke('comments-window:get-snapshot'),
  onCommentsSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: LiveChatSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('comments-window:snapshot', listener)
    return () => ipcRenderer.removeListener('comments-window:snapshot', listener)
  },
  clearComments: () => ipcRenderer.invoke('comments-window:clear'),
  onCommentsClearRequest: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('comments-window:clear-request', listener)
    return () => ipcRenderer.removeListener('comments-window:clear-request', listener)
  },
  createNativePreviewSurface: (bounds, generation) =>
    ipcRenderer.invoke('preview-surface:create', bounds, generation),
  updateNativePreviewSurfaceBounds: (bounds, generation) =>
    ipcRenderer.invoke('preview-surface:update-bounds', bounds, generation),
  applyNativePreviewHostCommands: (commands, generation) =>
    ipcRenderer.invoke('preview-surface:apply-host-commands', commands, generation),
  updateNativePreviewSurfaceScene: (scene) =>
    ipcRenderer.invoke('preview-surface:update-scene', scene),
  updateNativePreviewSurfaceCompositor: (status) =>
    ipcRenderer.invoke('preview-surface:update-compositor', status),
  setNativePreviewSurfaceFramePollingSuppressed: (suppressed) =>
    ipcRenderer.invoke('preview-surface:set-frame-polling-suppressed', suppressed),
  destroyNativePreviewSurface: (generation) =>
    ipcRenderer.invoke('preview-surface:destroy', generation),
  getNativePreviewSurfaceStatus: () => ipcRenderer.invoke('preview-surface:status'),
  openSystemPermissions: (pane) => ipcRenderer.invoke('system:open-permissions', pane),
  revealPermissionTarget: () => ipcRenderer.invoke('system:reveal-permission-target'),
  revealPath: (path) => ipcRenderer.invoke('system:reveal-path', path),
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
