import { contextBridge, ipcRenderer, shell } from 'electron'

import type {
  BackendConnection,
  BackendLogEvent,
  RuntimeInfo,
  SystemPermissionPane,
  VideorcApi
} from '../shared/backend'

const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
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
    permissionTargetPath: targetPath
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
  getOAuthCallbackRedirectUri: () => ipcRenderer.invoke('oauth:callback-redirect-uri'),
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
