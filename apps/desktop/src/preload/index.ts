import { contextBridge, ipcRenderer } from 'electron'

import type { VideorcApi } from '../shared/backend'
import {
  validateElectronEventPayload,
  validateElectronInvokeArgs,
  validateElectronInvokeResult,
  type ElectronEventChannel,
  type ElectronIpcEventMap,
  type ElectronInvokeArgs,
  type ElectronInvokeChannel,
  type ElectronInvokeResult
} from '../shared/electron-ipc-contract'
import { rendererRoleFromArguments } from '../shared/renderer-security-policy'
import { apiForRendererRole } from './api-policy'

async function invoke<TChannel extends ElectronInvokeChannel>(
  channel: TChannel,
  ...args: ElectronInvokeArgs<TChannel>
): Promise<ElectronInvokeResult<TChannel>> {
  const validatedArgs = validateElectronInvokeArgs(channel, args)
  const result = await ipcRenderer.invoke(channel, ...validatedArgs)
  return validateElectronInvokeResult(channel, result) as ElectronInvokeResult<TChannel>
}

function subscribe<TChannel extends ElectronEventChannel>(
  channel: TChannel,
  callback: (payload: ElectronIpcEventMap[TChannel]) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    callback(validateElectronEventPayload(channel, payload) as ElectronIpcEventMap[TChannel])
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: VideorcApi = {
  getBackendConnection: () => invoke('backend:get-connection'),
  getBackendLogs: () => invoke('backend:get-logs'),
  getRuntimeInfo: () => invoke('app:get-runtime-info'),
  retryHardwareAcceleration: () => invoke('app:retry-hardware-acceleration'),
  pickScreenImage: () => invoke('screens:pick-image'),
  importBackgroundImage: () => invoke('backgrounds:import-image'),
  backgroundAssetExists: (assetId) => invoke('backgrounds:asset-exists', assetId),
  cacheChatAvatar: (url) => invoke('avatars:cache', url),
  sendCommentHighlight: (command) => invoke('comments-window:highlight', command),
  onCommentHighlightRequest: (callback) => subscribe('comments-window:highlight-request', callback),
  pushCommentHighlightResult: (resolution) =>
    invoke('comments-window:highlight-result-push', resolution),
  pushCommentHighlightState: (state) => invoke('comments-window:highlight-state-push', state),
  getCommentHighlightState: () => invoke('comments-window:highlight-state-get'),
  sendChatFromCommentsWindow: (command) => invoke('comments-window:send', command),
  onChatSendRequest: (callback) => subscribe('comments-window:send-request', callback),
  pushChatSendResult: (resolution) => invoke('comments-window:send-result-push', resolution),
  clearComments: (command) => invoke('comments-window:clear', command),
  onCommentsClearRequest: (callback) => subscribe('comments-window:clear-request', callback),
  pushCommentsClearResult: (resolution) => invoke('comments-window:clear-result-push', resolution),
  onCommentHighlightState: (callback) => subscribe('comments-window:highlight-state', callback),
  getBundledBackgroundAssets: () => invoke('backgrounds:bundled-assets'),
  beginAccountSignIn: (authorizeUrl) => invoke('account:begin-sign-in', authorizeUrl),
  signOutAccount: () => invoke('account:sign-out'),
  getPendingAccountCallbacks: () => invoke('account:callbacks-list'),
  acknowledgeAccountCallback: (callbackId) => invoke('account:callback-ack', callbackId),
  onAccountCallback: (callback) => subscribe('account:callback', callback),
  getPendingOAuthCallbacks: () => invoke('oauth:callbacks-list'),
  acknowledgeOAuthCallback: (callbackId) => invoke('oauth:callback-ack', callbackId),
  openOAuthUrl: (authUrl) => invoke('oauth:open-url', authUrl),
  getOAuthCallbackRedirectUri: (platform) => invoke('oauth:callback-redirect-uri', platform),
  getNativePreviewSurfaceMode: () => invoke('preview-surface:mode'),
  setNativeTheme: (theme) => invoke('app:set-native-theme', theme),
  getNativePreviewMainPumpActive: () => invoke('preview-surface:pump-mode'),
  onNativePreviewMainPumpActive: (callback) => subscribe('preview-surface:pump-mode', callback),
  openPreviewWindow: () => invoke('preview-window:open'),
  closePreviewWindow: () => invoke('preview-window:close'),
  togglePreviewWindow: () => invoke('preview-window:toggle'),
  getPreviewWindowState: () => invoke('preview-window:get-state'),
  reportPreviewPermissionRequired: (permissionStatus, message, generation) =>
    invoke('preview-window:permission-required', permissionStatus, message, generation),
  setPreviewWindowAlwaysOnTop: (alwaysOnTop) =>
    invoke('preview-window:set-always-on-top', alwaysOnTop),
  setPreviewWindowMode: (mode) => invoke('preview-window:set-mode', mode),
  reportPreviewDockSlot: (report) => invoke('preview-window:report-dock-slot', report),
  setPreviewDockOverlayOpen: (open) => invoke('preview-window:set-dock-overlay', open),
  setPreviewWindowAspectRatio: (width, height) =>
    invoke('preview-window:set-aspect-ratio', width, height),
  onPreviewWindowState: (callback) => subscribe('preview-window:state', callback),
  openNotesWindow: () => invoke('notes-window:open'),
  setGlobalShortcuts: (shortcuts) => invoke('global-shortcuts:set', shortcuts),
  onGlobalShortcut: (callback) => subscribe('global-shortcuts:triggered', callback),
  closeNotesWindow: () => invoke('notes-window:close'),
  getNotesWindowState: () => invoke('notes-window:get-state'),
  setNotesWindowAlwaysOnTop: (alwaysOnTop) => invoke('notes-window:set-always-on-top', alwaysOnTop),
  getNotesDocument: () => invoke('notes-window:get-document'),
  saveNotesDocument: (patch) => invoke('notes-window:save-document', patch),
  onNotesFlushRequest: (callback) => subscribe('notes-window:flush-request', callback),
  onNotesWindowState: (callback) => subscribe('notes-window:state', callback),
  onNotesDocument: (callback) => subscribe('notes-window:document', callback),
  openCommentsWindow: () => invoke('comments-window:open'),
  closeCommentsWindow: () => invoke('comments-window:close'),
  toggleCommentsWindow: () => invoke('comments-window:toggle'),
  getCommentsWindowState: () => invoke('comments-window:get-state'),
  setCommentsWindowAlwaysOnTop: (alwaysOnTop) =>
    invoke('comments-window:set-always-on-top', alwaysOnTop),
  onCommentsWindowState: (callback) => subscribe('comments-window:state', callback),
  pushCommentsSnapshot: (view) => invoke('comments-window:push-snapshot', view),
  pushCommentsDelta: (delta) => invoke('comments-window:push-delta', delta),
  getCommentsSnapshot: () => invoke('comments-window:get-snapshot'),
  setCommentsViewMode: (mode) => invoke('comments-window:set-view-mode', mode),
  onCommentsSnapshot: (callback) => subscribe('comments-window:snapshot', callback),
  onCommentsDelta: (callback) => subscribe('comments-window:delta', callback),
  openCaptionsWindow: () => invoke('captions-window:open'),
  closeCaptionsWindow: () => invoke('captions-window:close'),
  toggleCaptionsWindow: () => invoke('captions-window:toggle'),
  getCaptionsWindowState: () => invoke('captions-window:get-state'),
  setCaptionsWindowAlwaysOnTop: (alwaysOnTop) =>
    invoke('captions-window:set-always-on-top', alwaysOnTop),
  onCaptionsWindowState: (callback) => subscribe('captions-window:state', callback),
  pushCaptionSnapshot: (snapshot) => invoke('captions-window:push-snapshot', snapshot),
  getCaptionSnapshot: () => invoke('captions-window:get-snapshot'),
  onCaptionSnapshot: (callback) => subscribe('captions-window:snapshot', callback),
  pushCaptionLines: (lines) => invoke('captions-window:push-lines', lines),
  getCaptionLines: () => invoke('captions-window:get-lines'),
  onCaptionLines: (callback) => subscribe('captions-window:lines', callback),
  createNativePreviewSurface: (bounds, generation) =>
    invoke('preview-surface:create', bounds, generation),
  updateNativePreviewSurfaceBounds: (bounds, generation) =>
    invoke('preview-surface:update-bounds', bounds, generation),
  applyNativePreviewHostCommands: (commands, generation) =>
    invoke('preview-surface:apply-host-commands', commands, generation),
  drainNativePreviewHostCommands: (generation) =>
    invoke('preview-surface:drain-host-commands', generation),
  updateNativePreviewSurfaceScene: (scene) => invoke('preview-surface:update-scene', scene),
  updateNativePreviewSurfaceCompositor: (status) =>
    invoke('preview-surface:update-compositor', status),
  setNativePreviewSurfaceFramePollingSuppressed: (suppressed, recordingActive) =>
    invoke('preview-surface:set-frame-polling-suppressed', suppressed, recordingActive),
  destroyNativePreviewSurface: (generation) => invoke('preview-surface:destroy', generation),
  getNativePreviewSurfaceStatus: () => invoke('preview-surface:status'),
  openSystemPermissions: (pane) => invoke('system:open-permissions', pane),
  getMediaAccessStatus: () => invoke('system:media-access-status'),
  requestMediaAccess: (pane) => invoke('system:request-media-access', pane),
  revealPermissionTarget: () => invoke('system:reveal-permission-target'),
  revealSelectedResource: (capabilityId) => invoke('resource:reveal-selection', capabilityId),
  authorizeOutputDirectory: (directoryHandleId) =>
    invoke('resource:authorize-output-directory', directoryHandleId),
  revealSession: (sessionId) => invoke('resource:reveal-session', sessionId),
  revealBackgroundAsset: (assetId) => invoke('resource:reveal-background', assetId),
  obsDiscover: () => invoke('obs:discover'),
  obsRead: (collection, profile) => invoke('obs:read', collection, profile),
  obsReadStreamKey: (profile) => invoke('obs:read-stream-key', profile),
  pushViewerSample: (sample) => invoke('comments-window:viewers-push', sample),
  getViewerSample: () => invoke('comments-window:viewers-get'),
  onViewerSample: (callback) => subscribe('comments-window:viewers', callback),
  openSession: (sessionId) => invoke('resource:open-session', sessionId),
  trashSessionDeletion: (operationId) => invoke('resource:trash-session-deletion', operationId),
  pickFile: () => invoke('system:pick-file'),
  pickDirectory: () => invoke('system:pick-directory'),
  checkDirectory: (capabilityId) => invoke('system:check-directory', capabilityId),
  onOAuthCallbackUrl: (callback) => subscribe('oauth:callback-url', callback),
  onShortcutNavigate: (callback) => subscribe('shortcut:navigate', callback),
  onBackendConnection: (callback) => subscribe('backend:connection', callback),
  onBackendLifecycle: (callback) => subscribe('backend:lifecycle', callback),
  onBackendLog: (callback) => subscribe('backend:log', callback),
  getGlassWallpaper: () => invoke('glass:wallpaper:get'),
  onGlassWallpaper: (callback) => subscribe('glass:wallpaper', callback),
  onGlassGeometry: (callback) => subscribe('glass:geometry', callback),
  checkForUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  installUpdate: () => invoke('updates:install'),
  getUpdateStatus: () => invoke('updates:get-status'),
  onUpdateStatus: (callback) => subscribe('app:update-status', callback),
  onPreviewSceneResyncRequest: (callback) => subscribe('preview-surface:resync-scene', callback)
}

contextBridge.exposeInMainWorld(
  'videorc',
  apiForRendererRole(api, rendererRoleFromArguments(process.argv))
)
