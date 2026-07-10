import { contextBridge, ipcRenderer } from 'electron'

import type {
  BackendConnection,
  BackendLifecycleEvent,
  BackendLogEvent,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsClearCommand,
  CommentsSendCommand,
  CommentsViewSnapshot,
  CaptionsUpdate,
  CaptionsWindowState,
  CommentsWindowState,
  GlassWallpaperState,
  NotesDocument,
  NotesWindowState,
  PreviewWindowState,
  UpdateStatus,
  VideorcApi,
  ViewerSample
} from '../shared/backend'

const api: VideorcApi = {
  getBackendConnection: () => ipcRenderer.invoke('backend:get-connection'),
  getBackendLogs: () => ipcRenderer.invoke('backend:get-logs'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:get-runtime-info'),
  pickScreenImage: () => ipcRenderer.invoke('screens:pick-image'),
  importBackgroundImage: () => ipcRenderer.invoke('backgrounds:import-image'),
  importBackgroundImagePath: (sourcePath) =>
    ipcRenderer.invoke('backgrounds:import-image-path', sourcePath),
  backgroundAssetExists: (assetPath) => ipcRenderer.invoke('backgrounds:asset-exists', assetPath),
  cacheChatAvatar: (url) => ipcRenderer.invoke('avatars:cache', url),
  sendCommentHighlight: (command) => ipcRenderer.invoke('comments-window:highlight', command),
  onCommentHighlightRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: CommentHighlightCommand): void =>
      callback(command)
    ipcRenderer.on('comments-window:highlight-request', listener)
    return () => ipcRenderer.removeListener('comments-window:highlight-request', listener)
  },
  pushCommentHighlightResult: (resolution) =>
    ipcRenderer.invoke('comments-window:highlight-result-push', resolution),
  pushCommentHighlightState: (state) =>
    ipcRenderer.invoke('comments-window:highlight-state-push', state),
  getCommentHighlightState: () => ipcRenderer.invoke('comments-window:highlight-state-get'),
  sendChatFromCommentsWindow: (command) => ipcRenderer.invoke('comments-window:send', command),
  onChatSendRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: CommentsSendCommand): void =>
      callback(command)
    ipcRenderer.on('comments-window:send-request', listener)
    return () => ipcRenderer.removeListener('comments-window:send-request', listener)
  },
  pushChatSendResult: (resolution) =>
    ipcRenderer.invoke('comments-window:send-result-push', resolution),
  clearComments: (command) => ipcRenderer.invoke('comments-window:clear', command),
  onCommentsClearRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: CommentsClearCommand): void =>
      callback(command)
    ipcRenderer.on('comments-window:clear-request', listener)
    return () => ipcRenderer.removeListener('comments-window:clear-request', listener)
  },
  pushCommentsClearResult: (resolution) =>
    ipcRenderer.invoke('comments-window:clear-result-push', resolution),
  onCommentHighlightState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CommentHighlightState): void =>
      callback(state)
    ipcRenderer.on('comments-window:highlight-state', listener)
    return () => ipcRenderer.removeListener('comments-window:highlight-state', listener)
  },
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
  setPreviewWindowMode: (mode) => ipcRenderer.invoke('preview-window:set-mode', mode),
  reportPreviewDockSlot: (report) => ipcRenderer.invoke('preview-window:report-dock-slot', report),
  setPreviewDockOverlayOpen: (open) => ipcRenderer.invoke('preview-window:set-dock-overlay', open),
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
  pushCommentsSnapshot: (view) => ipcRenderer.invoke('comments-window:push-snapshot', view),
  getCommentsSnapshot: () => ipcRenderer.invoke('comments-window:get-snapshot'),
  setCommentsViewMode: (mode) => ipcRenderer.invoke('comments-window:set-view-mode', mode),
  onCommentsSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: CommentsViewSnapshot): void =>
      callback(view)
    ipcRenderer.on('comments-window:snapshot', listener)
    return () => ipcRenderer.removeListener('comments-window:snapshot', listener)
  },
  openCaptionsWindow: () => ipcRenderer.invoke('captions-window:open'),
  closeCaptionsWindow: () => ipcRenderer.invoke('captions-window:close'),
  toggleCaptionsWindow: () => ipcRenderer.invoke('captions-window:toggle'),
  getCaptionsWindowState: () => ipcRenderer.invoke('captions-window:get-state'),
  setCaptionsWindowAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('captions-window:set-always-on-top', alwaysOnTop),
  onCaptionsWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CaptionsWindowState): void =>
      callback(state)
    ipcRenderer.on('captions-window:state', listener)
    return () => ipcRenderer.removeListener('captions-window:state', listener)
  },
  pushCaptionLines: (lines) => ipcRenderer.invoke('captions-window:push-lines', lines),
  getCaptionLines: () => ipcRenderer.invoke('captions-window:get-lines'),
  onCaptionLines: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, lines: CaptionsUpdate[]): void =>
      callback(lines)
    ipcRenderer.on('captions-window:lines', listener)
    return () => ipcRenderer.removeListener('captions-window:lines', listener)
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
  getMediaAccessStatus: () => ipcRenderer.invoke('system:media-access-status'),
  requestMediaAccess: (pane) => ipcRenderer.invoke('system:request-media-access', pane),
  revealPermissionTarget: () => ipcRenderer.invoke('system:reveal-permission-target'),
  revealPath: (path) => ipcRenderer.invoke('system:reveal-path', path),
  obsDiscover: () => ipcRenderer.invoke('obs:discover'),
  obsRead: (collection, profile) => ipcRenderer.invoke('obs:read', collection, profile),
  obsReadStreamKey: (profile) => ipcRenderer.invoke('obs:read-stream-key', profile),
  pushViewerSample: (sample) => ipcRenderer.invoke('comments-window:viewers-push', sample),
  getViewerSample: () => ipcRenderer.invoke('comments-window:viewers-get'),
  onViewerSample: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sample: ViewerSample | null): void =>
      callback(sample)
    ipcRenderer.on('comments-window:viewers', listener)
    return () => ipcRenderer.removeListener('comments-window:viewers', listener)
  },
  openPath: (path) => ipcRenderer.invoke('system:open-path', path),
  trashPaths: (paths) => ipcRenderer.invoke('system:trash-paths', paths),
  pickFile: () => ipcRenderer.invoke('system:pick-file'),
  pickDirectory: () => ipcRenderer.invoke('system:pick-directory'),
  checkDirectory: (path) => ipcRenderer.invoke('system:check-directory', path),
  createDirectory: (path) => ipcRenderer.invoke('system:create-directory', path),
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
  onBackendLifecycle: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: BackendLifecycleEvent): void => {
      callback(event)
    }
    ipcRenderer.on('backend:lifecycle', listener)
    return () => ipcRenderer.removeListener('backend:lifecycle', listener)
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
  },
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      callback(status)
    ipcRenderer.on('app:update-status', listener)
    return () => ipcRenderer.removeListener('app:update-status', listener)
  },
  onPreviewSceneResyncRequest: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('preview-surface:resync-scene', listener)
    return () => ipcRenderer.removeListener('preview-surface:resync-scene', listener)
  }
}

contextBridge.exposeInMainWorld('videorc', api)
