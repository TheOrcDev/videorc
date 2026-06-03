import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { BackendConnection, BackendLogEvent, SystemPermissionPane } from '../shared/backend'

let mainWindow: BrowserWindow | null = null
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendConnection: BackendConnection | null = null
let stdoutBuffer = ''
let appIcon: NativeImage | null | undefined
const backendLogs: BackendLogEvent[] = []
const pendingOAuthCallbackUrls: string[] = []
const OAUTH_CALLBACK_PROTOCOL = 'videorc'
const OAUTH_APP_PROTOCOL_REDIRECT_URI = 'videorc://oauth/callback'
const oauthAppProtocolEnabled = process.env.VIDEORC_OAUTH_CALLBACK_MODE === 'app-protocol'

const MACOS_PERMISSION_URLS: Record<SystemPermissionPane, string> = {
  privacy: 'x-apple.systempreferences:com.apple.preference.security',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 660,
    title: 'Videorc',
    backgroundColor: '#ffffff',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (backendConnection) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('backend:connection', backendConnection)
      flushOAuthCallbackUrls()
    })
  } else {
    mainWindow.webContents.once('did-finish-load', () => {
      flushOAuthCallbackUrls()
    })
  }
}

function resolveAppIcon(): NativeImage | null {
  if (appIcon !== undefined) {
    return appIcon
  }

  const iconPath = resolveAppIconPath()
  if (!iconPath) {
    appIcon = null
    return appIcon
  }

  const image = nativeImage.createFromPath(iconPath)
  appIcon = image.isEmpty() ? null : image
  return appIcon
}

function resolveAppIconPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.icns'), join(process.resourcesPath, 'videorc-logo.png')]
    : [
        resolve(workspaceRoot(), 'apps/desktop/build-resources/icon.icns'),
        resolve(workspaceRoot(), 'apps/desktop/src/renderer/src/assets/videorc-logo.png')
      ]

  return candidates.find((path) => existsSync(path)) ?? null
}

function setDockIcon(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const icon = resolveAppIcon()
  if (icon) {
    app.dock?.setIcon(icon)
  }
}

function registerOAuthCallbackProtocol(): void {
  if (process.defaultApp) {
    const appPath = process.argv[1]
    if (appPath) {
      app.setAsDefaultProtocolClient(OAUTH_CALLBACK_PROTOCOL, process.execPath, [appPath])
      return
    }
  }

  app.setAsDefaultProtocolClient(OAUTH_CALLBACK_PROTOCOL)
}

function oauthCallbackRedirectUri(): string | null {
  return oauthAppProtocolEnabled ? OAUTH_APP_PROTOCOL_REDIRECT_URI : null
}

function sendOAuthCallbackUrl(callbackUrl: string): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    pendingOAuthCallbackUrls.push(callbackUrl)
    return
  }

  mainWindow.webContents.send('oauth:callback-url', callbackUrl)
}

function flushOAuthCallbackUrls(): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed() || pendingOAuthCallbackUrls.length === 0) {
    return
  }

  const callbackUrls = pendingOAuthCallbackUrls.splice(0)
  for (const callbackUrl of callbackUrls) {
    mainWindow.webContents.send('oauth:callback-url', callbackUrl)
  }
}

function dispatchOAuthCallbackUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }

  if (
    parsed.protocol !== `${OAUTH_CALLBACK_PROTOCOL}:` ||
    parsed.hostname !== 'oauth' ||
    parsed.pathname !== '/callback'
  ) {
    return
  }

  sendOAuthCallbackUrl(parsed.toString())
}

function workspaceRoot(): string {
  if (app.isPackaged) {
    return dirname(process.resourcesPath)
  }

  return resolve(app.getAppPath(), '../..')
}

function resolveCargoBinary(): string {
  const rustupCargo = join(homedir(), '.cargo', 'bin', 'cargo')
  return existsSync(rustupCargo) ? rustupCargo : 'cargo'
}

function resolvePackagedBackendBinary(): string {
  return join(process.resourcesPath, process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend')
}

function resolvePackagedFfmpegBinDir(): string | null {
  if (!app.isPackaged) {
    return null
  }

  const binDir = join(process.resourcesPath, 'ffmpeg', 'bin')
  const binary = join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return existsSync(binary) ? binDir : null
}

function startBackend(): void {
  if (backendProcess) {
    return
  }

  const root = workspaceRoot()
  const cargoBinDir = join(homedir(), '.cargo', 'bin')
  const ffmpegBinDir = resolvePackagedFfmpegBinDir()
  const command = app.isPackaged ? resolvePackagedBackendBinary() : resolveCargoBinary()
  const args = app.isPackaged ? [] : ['run', '--quiet', '-p', 'videorc-backend']
  const pathEntries = [ffmpegBinDir, cargoBinDir, process.env.PATH].filter(Boolean)

  logBackend('info', `Launching backend from ${root}`)
  if (ffmpegBinDir) {
    logBackend('info', `Using bundled FFmpeg from ${ffmpegBinDir}`)
  }
  backendProcess = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathEntries.join(delimiter),
      VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegBinDir ? join(ffmpegBinDir, 'ffmpeg') : '',
      RUST_LOG: process.env.RUST_LOG ?? 'videorc_backend=info'
    }
  })

  backendProcess.stdout.on('data', (chunk: Buffer) => handleBackendStdout(chunk.toString()))
  backendProcess.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) {
        logBackend(inferBackendLogLevel(line), line.trim())
      }
    }
  })
  backendProcess.on('error', (error) => {
    logBackend('error', `Backend process error: ${error.message}`)
  })
  backendProcess.on('close', (code, signal) => {
    logBackend('warn', `Backend exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`)
    backendProcess = null
    backendConnection = null
  })
}

function handleBackendStdout(text: string): void {
  stdoutBuffer += text
  const lines = stdoutBuffer.split(/\r?\n/)
  stdoutBuffer = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    if (trimmed.startsWith('READY ')) {
      try {
        backendConnection = JSON.parse(trimmed.slice('READY '.length)) as BackendConnection
        logBackend('info', `Backend ready on ${backendConnection.host}:${backendConnection.port}`)
        if (process.env.VIDEORC_SMOKE_PRINT_BACKEND_READY === '1') {
          console.log(`[smoke] backend-ready ${JSON.stringify(backendConnection)}`)
        }
        sendToWindows('backend:connection', backendConnection)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logBackend('error', `Could not parse backend READY line: ${message}`)
      }
      continue
    }

    logBackend('info', trimmed)
  }
}

function logBackend(level: BackendLogEvent['level'], message: string): void {
  const log: BackendLogEvent = {
    level,
    message,
    timestamp: new Date().toISOString()
  }
  backendLogs.push(log)
  if (backendLogs.length > 200) {
    backendLogs.shift()
  }

  sendToWindows('backend:log', log)

  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  logger(`[backend:${level}] ${message}`)
}

function sendToWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue
    }

    window.webContents.send(channel, ...args)
  }
}

function inferBackendLogLevel(line: string): BackendLogEvent['level'] {
  if (line.includes(' ERROR ')) {
    return 'error'
  }

  if (line.includes(' WARN ')) {
    return 'warn'
  }

  return 'info'
}

function stopBackend(): void {
  if (!backendProcess) {
    return
  }

  backendProcess.kill('SIGTERM')
  backendProcess = null
}

async function openSystemPermissions(pane: SystemPermissionPane = 'privacy'): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Permission shortcut is only available on macOS.')
  }

  await shell.openExternal(MACOS_PERMISSION_URLS[pane] ?? MACOS_PERMISSION_URLS.privacy)
}

async function pickScreenImage(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose Screen image',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp']
      }
    ]
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)

  if (result.canceled) {
    return null
  }

  return result.filePaths[0] ?? null
}

async function openOAuthUrl(authUrl: string): Promise<void> {
  const parsed = new URL(authUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OAuth URL must use http or https.')
  }

  await shell.openExternal(parsed.toString())
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const callbackUrl = argv.find((arg) => arg.startsWith(`${OAUTH_CALLBACK_PROTOCOL}://`))
    if (callbackUrl) {
      dispatchOAuthCallbackUrl(callbackUrl)
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  dispatchOAuthCallbackUrl(url)
})

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return
  }

  registerOAuthCallbackProtocol()
  ipcMain.handle('backend:get-connection', () => backendConnection)
  ipcMain.handle('backend:get-logs', () => backendLogs)
  ipcMain.handle('system:open-permissions', (_event, pane?: SystemPermissionPane) => openSystemPermissions(pane))
  ipcMain.handle('screens:pick-image', () => pickScreenImage())
  ipcMain.handle('oauth:open-url', (_event, authUrl: string) => openOAuthUrl(authUrl))
  ipcMain.handle('oauth:callback-redirect-uri', () => oauthCallbackRedirectUri())

  setDockIcon()
  startBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBackend()
})
