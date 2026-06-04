import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse as HttpResponse } from 'node:http'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  BackendConnection,
  BackendLogEvent,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus,
  SystemPermissionPane
} from '../shared/backend'

let mainWindow: BrowserWindow | null = null
let nativePreviewSurfaceWindow: BrowserWindow | null = null
let nativePreviewSurfaceStatus: PreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendConnection: BackendConnection | null = null
let smokePreviewMotionServer: HttpServer | null = null
let stdoutBuffer = ''
let appIcon: NativeImage | null | undefined
const backendLogs: BackendLogEvent[] = []
const pendingOAuthCallbackUrls: string[] = []
const OAUTH_CALLBACK_PROTOCOL = 'videorc'
const OAUTH_APP_PROTOCOL_REDIRECT_URI = 'videorc://oauth/callback'
const oauthAppProtocolEnabled = process.env.VIDEORC_OAUTH_CALLBACK_MODE === 'app-protocol'
const nativePreviewSurfaceProofEnabled = process.env.VIDEORC_NATIVE_PREVIEW_SURFACE === '1'
const nativePreviewCameraOverlayEnabled = process.env.VIDEORC_NATIVE_PREVIEW_CAMERA_OVERLAY === '1'

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
    destroyNativePreviewSurface()
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

function idleNativePreviewSurfaceStatus(message = 'Native preview surface is not running.'): PreviewSurfaceStatus {
  return {
    state: 'unavailable',
    source: 'synthetic',
    transport: 'unavailable',
    targetFps: 60,
    width: 0,
    height: 0,
    framesRendered: 0,
    updatedAt: new Date().toISOString(),
    message
  }
}

function nativeCameraFrameUrl(): string | null {
  if (!nativePreviewCameraOverlayEnabled || !backendConnection) {
    return null
  }
  return `http://${backendConnection.host}:${backendConnection.port}/preview/camera/live.png?token=${encodeURIComponent(
    backendConnection.token
  )}`
}

function nativePreviewSurfaceHtml(cameraFrameUrl: string | null): string {
  if (!cameraFrameUrl) {
    return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      body {
        --stripe-size: 52px;
        background:
          radial-gradient(circle at var(--dot-x, 10%) 50%, rgba(255, 255, 255, 0.42), transparent 20%),
          linear-gradient(135deg, rgba(29, 78, 216, 0.62), rgba(5, 150, 105, 0.58)),
          repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.28) 0 18px, rgba(17, 24, 39, 0.14) 18px var(--stripe-size));
        background-position: var(--offset, 0px) 0, 0 0, var(--stripe-offset, 0px) 0;
      }

      #readout {
        position: fixed;
        right: 12px;
        bottom: 10px;
        font: 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: rgba(255, 255, 255, 0.82);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
      }
    </style>
  </head>
  <body>
    <div id="readout">native synthetic surface</div>
    <script>
      (() => {
        const frameTimes = [];
        let frames = 0;
        let startedAt = performance.now();
        function tick(now) {
          frames += 1;
          frameTimes.push(now);
          if (frameTimes.length > 900) frameTimes.shift();
          const x = (now * 0.045) % Math.max(1, window.innerWidth + 140);
          document.body.style.setProperty('--dot-x', String((x / Math.max(1, window.innerWidth)) * 100) + '%');
          document.body.style.setProperty('--offset', String((now * 0.08) % 240) + 'px');
          document.body.style.setProperty('--stripe-offset', String((now * 0.18) % 120) + 'px');
          window.__videorcNativePreviewMetrics = () => {
            const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
            const sorted = [...intervals].sort((a, b) => a - b);
            const percentile = (p) => {
              if (!sorted.length) return null;
              const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
              return sorted[index];
            };
            const elapsed = Math.max(1, performance.now() - startedAt);
            return {
              frames,
              measuredFps: frames / elapsed * 1000,
              intervalP50Ms: percentile(50),
              intervalP95Ms: percentile(95),
              intervalP99Ms: percentile(99),
              blankFrames: 0,
              width: window.innerWidth,
              height: window.innerHeight
            };
          };
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      })();
    </script>
  </body>
</html>
  `
  }
  const cameraFrameUrlJson = JSON.stringify(cameraFrameUrl)
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      body {
        --stripe-size: 52px;
        background:
          radial-gradient(circle at var(--dot-x, 10%) 50%, rgba(255, 255, 255, 0.42), transparent 20%),
          linear-gradient(135deg, rgba(29, 78, 216, 0.62), rgba(5, 150, 105, 0.58)),
          repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.28) 0 18px, rgba(17, 24, 39, 0.14) 18px var(--stripe-size));
        background-position: var(--offset, 0px) 0, 0 0, var(--stripe-offset, 0px) 0;
      }

      body.camera-live {
        background: #05070a;
      }

      #camera {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0;
        transition: opacity 90ms linear;
      }

      body.camera-live #camera {
        opacity: 1;
      }

      #readout {
        position: fixed;
        right: 12px;
        bottom: 10px;
        font: 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: rgba(255, 255, 255, 0.82);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
      }
    </style>
  </head>
  <body>
    <img id="camera" alt="" />
    <div id="readout">native preview surface</div>
    <script>
      (() => {
        const cameraFrameUrl = ${cameraFrameUrlJson};
        const camera = document.getElementById('camera');
        const readout = document.getElementById('readout');
        const frameTimes = [];
        let frames = 0;
        let cameraFrames = 0;
        let startedAt = performance.now();
        let cameraPollPending = false;
        function pollCameraFrame() {
          if (!cameraFrameUrl || cameraPollPending) return;
          cameraPollPending = true;
          const image = new Image();
          image.decoding = 'async';
          image.onload = () => {
            camera.src = image.src;
            cameraFrames += 1;
            document.body.classList.add('camera-live');
            readout.textContent = 'native camera source';
            cameraPollPending = false;
            setTimeout(pollCameraFrame, 33);
          };
          image.onerror = () => {
            document.body.classList.remove('camera-live');
            readout.textContent = 'native synthetic fallback';
            cameraPollPending = false;
            setTimeout(pollCameraFrame, 250);
          };
          image.src = cameraFrameUrl + '&t=' + Date.now();
        }
        function tick(now) {
          frames += 1;
          frameTimes.push(now);
          if (frameTimes.length > 900) frameTimes.shift();
          const x = (now * 0.045) % Math.max(1, window.innerWidth + 140);
          document.body.style.setProperty('--dot-x', String((x / Math.max(1, window.innerWidth)) * 100) + '%');
          document.body.style.setProperty('--offset', String((now * 0.08) % 240) + 'px');
          document.body.style.setProperty('--stripe-offset', String((now * 0.18) % 120) + 'px');
          window.__videorcNativePreviewMetrics = () => {
            const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
            const sorted = [...intervals].sort((a, b) => a - b);
            const percentile = (p) => {
              if (!sorted.length) return null;
              const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
              return sorted[index];
            };
            const elapsed = Math.max(1, performance.now() - startedAt);
            return {
              frames,
              measuredFps: frames / elapsed * 1000,
              cameraFrames,
              intervalP50Ms: percentile(50),
              intervalP95Ms: percentile(95),
              intervalP99Ms: percentile(99),
              blankFrames: 0,
              width: window.innerWidth,
              height: window.innerHeight
            };
          };
          requestAnimationFrame(tick);
        }
        pollCameraFrame();
        requestAnimationFrame(tick);
      })();
    </script>
  </body>
</html>
  `
}

function normalizedSurfaceBounds(bounds: PreviewSurfaceBounds): Electron.Rectangle {
  return {
    x: Math.round(bounds.screenX),
    y: Math.round(bounds.screenY),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

async function createNativePreviewSurface(bounds: PreviewSurfaceBounds): Promise<PreviewSurfaceStatus> {
  if (!nativePreviewSurfaceProofEnabled) {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus('Native preview surface proof mode is disabled.')
    return nativePreviewSurfaceStatus
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not ready for native preview surface.')
  }

  const rect = normalizedSurfaceBounds(bounds)
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    nativePreviewSurfaceWindow = new BrowserWindow({
      parent: mainWindow,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    nativePreviewSurfaceWindow.setIgnoreMouseEvents(true, { forward: true })
    nativePreviewSurfaceWindow.on('closed', () => {
      nativePreviewSurfaceWindow = null
      nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
    })
    await nativePreviewSurfaceWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(nativePreviewSurfaceHtml(nativeCameraFrameUrl()))}`
    )
  }

  nativePreviewSurfaceWindow.setBounds(rect)
  nativePreviewSurfaceWindow.showInactive()
  nativePreviewSurfaceStatus = {
    state: 'live',
    source: nativePreviewCameraOverlayEnabled && backendConnection ? 'camera' : 'synthetic',
    transport: 'native-surface',
    targetFps: 60,
    width: rect.width,
    height: rect.height,
    framesRendered: nativePreviewSurfaceStatus.framesRendered,
    bounds,
    startedAt: nativePreviewSurfaceStatus.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: nativePreviewCameraOverlayEnabled && backendConnection
      ? 'Native camera preview surface hosted by Electron.'
      : 'Synthetic native preview surface hosted by Electron.'
  }
  return nativePreviewSurfaceStatus
}

async function updateNativePreviewSurfaceBounds(bounds: PreviewSurfaceBounds): Promise<PreviewSurfaceStatus> {
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    return createNativePreviewSurface(bounds)
  }

  const rect = normalizedSurfaceBounds(bounds)
  nativePreviewSurfaceWindow.setBounds(rect)
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    state: 'live',
    source:
      nativePreviewCameraOverlayEnabled && backendConnection
        ? 'camera'
        : nativePreviewSurfaceStatus.source,
    transport: 'native-surface',
    width: rect.width,
    height: rect.height,
    bounds,
    updatedAt: new Date().toISOString()
  }
  return nativePreviewSurfaceStatus
}

function destroyNativePreviewSurface(): PreviewSurfaceStatus {
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    nativePreviewSurfaceWindow.close()
  }
  nativePreviewSurfaceWindow = null
  nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
  return nativePreviewSurfaceStatus
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

function startSmokePreviewMotionServer(): void {
  if (process.env.VIDEORC_SMOKE_PREVIEW_MOTION !== '1' || smokePreviewMotionServer) {
    return
  }

  smokePreviewMotionServer = createServer((request, response) => {
    void handleSmokePreviewMotionRequest(request, response)
  })
  smokePreviewMotionServer.listen(0, '127.0.0.1', () => {
    const address = smokePreviewMotionServer?.address()
    if (address && typeof address !== 'string') {
      console.log(`[smoke] preview-motion-ready ${JSON.stringify({ host: address.address, port: address.port })}`)
    }
  })
}

async function handleSmokePreviewMotionRequest(request: IncomingMessage, response: HttpResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    writeSmokeJson(response, 200, { ok: true })
    return
  }

  if (request.method !== 'POST' || request.url !== '/command') {
    writeSmokeJson(response, 404, { ok: false, error: 'Unknown smoke endpoint.' })
    return
  }

  try {
    const body = await readSmokeBody(request)
    const command = typeof body.command === 'string' ? body.command : ''
    const params =
      body.params && typeof body.params === 'object'
        ? (body.params as Record<string, unknown>)
        : {}
    const result = await runSmokePreviewMotionCommand(command, params)
    writeSmokeJson(response, 200, { ok: true, result })
  } catch (error) {
    writeSmokeJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function runSmokePreviewMotionCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    throw new Error('Main window is not ready for preview motion smoke.')
  }

  if (command === 'resize-window') {
    const width = typeof params.width === 'number' ? params.width : 1180
    const height = typeof params.height === 'number' ? params.height : 780
    mainWindow.setSize(width, height)
    return mainWindow.getBounds()
  }

  if (command === 'measure-native-preview-surface') {
    if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.webContents.isDestroyed()) {
      throw new Error('Native preview surface is not ready for measurement.')
    }
    const durationMs = typeof params.durationMs === 'number' ? params.durationMs : 2500
    await new Promise((resolveMeasure) => setTimeout(resolveMeasure, durationMs))
    const metrics = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      'window.__videorcNativePreviewMetrics?.() ?? null',
      true
    )
    if (!metrics) {
      throw new Error('Native preview surface did not expose metrics.')
    }
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      framesRendered: Number(metrics.frames ?? nativePreviewSurfaceStatus.framesRendered),
      updatedAt: new Date().toISOString()
    }
    return {
      ...metrics,
      status: nativePreviewSurfaceStatus
    }
  }

  const script = smokeRendererScript(command, params)
  return mainWindow.webContents.executeJavaScript(script, true)
}

function smokeRendererScript(command: string, params: Record<string, unknown>): string {
  const paramsJson = JSON.stringify(params)
  return `
    (async () => {
      const params = ${paramsJson};
      const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const percentile = (values, p) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[index];
      };
      const waitFor = async (selector, timeoutMs = 8000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          const element = document.querySelector(selector);
          if (element) return element;
          await sleep(50);
        }
        throw new Error('Timed out waiting for ' + selector);
      };

      if (${JSON.stringify(command)} === 'open-layout-tab') {
        const tab = await waitFor('[data-videorc-tab-trigger="layout"]');
        tab.click();
        await waitFor('[data-videorc-preview-stage]');
        return { activeTab: 'layout' };
      }

      if (${JSON.stringify(command)} === 'measure-preview-motion') {
        const durationMs = Number(params.durationMs ?? 5000);
        const image = await waitFor('[data-videorc-preview-image]');
        const loads = [];
        const longTasks = [];
        let blankFrames = 0;
        let observer = null;
        if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTasks.push(entry.duration);
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        }
        const onLoad = () => {
          loads.push(performance.now());
          if (!image.naturalWidth || !image.naturalHeight) {
            blankFrames += 1;
          }
        };
        image.addEventListener('load', onLoad);
        if (image.complete) onLoad();
        await sleep(durationMs);
        image.removeEventListener('load', onLoad);
        observer?.disconnect();
        const intervals = loads.slice(1).map((time, index) => time - loads[index]);
        const averageIntervalMs = intervals.length
          ? intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
          : null;
        const measuredFps = averageIntervalMs ? 1000 / averageIntervalMs : 0;
        const expectedIntervalMs = Number(params.expectedIntervalMs ?? 16.67);
        const jitters = intervals.map((interval) => Math.abs(interval - expectedIntervalMs));
        return {
          imageLoadCount: loads.length,
          blankFrames,
          measuredFps,
          averageIntervalMs,
          intervalP50Ms: percentile(intervals, 50),
          intervalP95Ms: percentile(intervals, 95),
          intervalP99Ms: percentile(intervals, 99),
          intervalJitterP95Ms: percentile(jitters, 95),
          longTaskCount: longTasks.length,
          rendererLongTaskP95Ms: percentile(longTasks, 95),
          maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        };
      }

      throw new Error('Unknown preview motion smoke command: ' + ${JSON.stringify(command)});
    })()
  `
}

function readSmokeBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveRead, rejectRead) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        rejectRead(new Error('Smoke request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolveRead(body ? JSON.parse(body) : {})
      } catch (error) {
        rejectRead(error)
      }
    })
    request.on('error', rejectRead)
  })
}

function writeSmokeJson(response: HttpResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(payload))
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
  destroyNativePreviewSurface()
  smokePreviewMotionServer?.close()
  smokePreviewMotionServer = null
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
  ipcMain.handle('preview-surface:mode', () => nativePreviewSurfaceProofEnabled)
  ipcMain.handle('preview-surface:create', (_event, bounds: PreviewSurfaceBounds) => createNativePreviewSurface(bounds))
  ipcMain.handle('preview-surface:update-bounds', (_event, bounds: PreviewSurfaceBounds) =>
    updateNativePreviewSurfaceBounds(bounds)
  )
  ipcMain.handle('preview-surface:destroy', () => destroyNativePreviewSurface())
  ipcMain.handle('preview-surface:status', () => nativePreviewSurfaceStatus)

  setDockIcon()
  startBackend()
  createWindow()
  startSmokePreviewMotionServer()

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
