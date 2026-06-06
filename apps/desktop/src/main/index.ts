import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse as HttpResponse } from 'node:http'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  BackendConnection,
  BackendLogEvent,
  CameraShape,
  CompositorStatus,
  LayoutSettings,
  PreviewSurfaceBounds,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState,
  PreviewSurfaceSceneUpdateParams,
  PreviewSurfaceStatus,
  Scene,
  SceneSource,
  SceneTransform,
  StreamScreen,
  SystemPermissionPane
} from '../shared/backend'

let mainWindow: BrowserWindow | null = null
let nativePreviewSurfaceWindow: BrowserWindow | null = null
let nativePreviewSurfaceStatus: PreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendConnection: BackendConnection | null = null
let smokePreviewMotionServer: HttpServer | null = null
let nativePreviewSurfaceScene: PreviewSurfaceSceneState | null = null
let stdoutBuffer = ''
let appIcon: NativeImage | null | undefined
const backendLogs: BackendLogEvent[] = []
const pendingOAuthCallbackUrls: string[] = []
const OAUTH_CALLBACK_PROTOCOL = 'videorc'
const OAUTH_APP_PROTOCOL_REDIRECT_URI = 'videorc://oauth/callback'
const oauthAppProtocolEnabled = process.env.VIDEORC_OAUTH_CALLBACK_MODE === 'app-protocol'
const nativePreviewSurfaceProofEnabled = process.env.VIDEORC_NATIVE_PREVIEW_SURFACE === '1'
const nativePreviewFramePollingEnabled = process.env.VIDEORC_SMOKE_PREVIEW_MOTION !== '1'

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
    backing: 'none',
    targetFps: 60,
    width: 0,
    height: 0,
    framesRendered: 0,
    droppedFrames: 0,
    updatedAt: new Date().toISOString(),
    message
  }
}

function backendPreviewFrameUrl(path: '/preview/camera/live.png' | '/preview/screen/live.png'): string | undefined {
  if (!nativePreviewFramePollingEnabled || !backendConnection) {
    return undefined
  }
  return `http://${backendConnection.host}:${backendConnection.port}${path}?token=${encodeURIComponent(
    backendConnection.token
  )}`
}

function fileUrlFromPath(path: string): string {
  return pathToFileURL(path).toString()
}

function fullFrameTransform(): SceneTransform {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
}

function previewLayerFit(source: SceneSource, layout: LayoutSettings): 'contain' | 'cover' {
  if (source.kind === 'camera') {
    return layout.cameraFit === 'fit' ? 'contain' : 'cover'
  }
  return layout.layoutPreset === 'side-by-side' ? 'cover' : 'contain'
}

function previewLayerShape(source: SceneSource, layout: LayoutSettings): CameraShape | undefined {
  if (source.kind !== 'camera') {
    return undefined
  }
  return layout.layoutPreset === 'screen-camera' && layout.cameraShape === 'circle' ? 'circle' : 'rectangle'
}

function previewLayerFrameUrl(source: SceneSource): string | undefined {
  if (source.kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/live.png')
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/live.png')
  }
  return undefined
}

function buildPreviewSurfaceScene(params: PreviewSurfaceSceneUpdateParams): PreviewSurfaceSceneState {
  const layers: PreviewSurfaceSceneLayer[] = (params.scene?.sources ?? []).map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    transform: source.transform,
    visible: source.visible,
    frameUrl: previewLayerFrameUrl(source),
    fit: previewLayerFit(source, params.layout),
    mirror: source.kind === 'camera' ? params.layout.cameraMirror : false,
    shape: previewLayerShape(source, params.layout)
  }))

  const activeScreen: StreamScreen | null | undefined = params.activeScreen
  if (activeScreen?.status === 'ready') {
    layers.push({
      id: `screen-image:${activeScreen.id}`,
      name: activeScreen.name,
      kind: 'screen-image',
      transform: fullFrameTransform(),
      visible: true,
      imageUrl: fileUrlFromPath(activeScreen.imagePath),
      fit: 'cover',
      mirror: false
    })
  }

  return {
    revision: params.revision,
    sceneId: params.scene?.id,
    layout: params.layout,
    sources: layers,
    activeScreenId: activeScreen?.id,
    updatedAt: new Date().toISOString()
  }
}

function buildPreviewSurfaceSceneFromCompositorStatus(status: CompositorStatus): PreviewSurfaceSceneState | null {
  if (typeof status.sceneRevision !== 'number' || !status.sceneLayout) {
    return null
  }
  const layers: PreviewSurfaceSceneLayer[] = (status.sceneSources ?? []).map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    transform: source.transform,
    visible: source.visible,
    frameUrl: compositorLayerFrameUrl(source.kind),
    imageUrl:
      source.kind === 'screen-image' && source.state !== 'source-missing' && source.imagePath
        ? fileUrlFromPath(source.imagePath)
        : undefined,
    fit: source.fit,
    mirror: source.mirror,
    shape: source.shape
  }))

  return {
    revision: status.sceneRevision,
    sceneId: status.sceneId,
    layout: status.sceneLayout,
    sources: layers,
    activeScreenId: status.activeScreenId,
    updatedAt: status.updatedAt
  }
}

function compositorLayerFrameUrl(kind: PreviewSurfaceSceneLayer['kind']): string | undefined {
  if (kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/live.png')
  }
  if (kind === 'screen' || kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/live.png')
  }
  return undefined
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function nativePreviewSurfaceHtml(initialScene: PreviewSurfaceSceneState | null): string {
  const initialSceneJson = jsonForInlineScript(initialScene)
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

      body.surface-live {
        background: #05070a;
      }

      #scene-root {
        position: fixed;
        inset: 0;
        overflow: hidden;
      }

      .scene-layer {
        position: absolute;
        overflow: hidden;
        background: transparent;
        contain: layout paint;
      }

      .scene-layer[data-kind="test-pattern"] {
        background:
          linear-gradient(90deg, #ef4444 0 16.6%, #f59e0b 16.6% 33.3%, #10b981 33.3% 50%, #06b6d4 50% 66.6%, #3b82f6 66.6% 83.3%, #a855f7 83.3%),
          repeating-linear-gradient(0deg, rgba(255,255,255,.18) 0 2px, transparent 2px 28px);
      }

      .scene-layer > img {
        position: absolute;
        display: block;
        opacity: 0;
        transition: opacity 60ms linear;
        object-position: center;
      }

      .scene-layer > img[data-live="1"] {
        opacity: 1;
      }

      #readout {
        position: fixed;
        right: 12px;
        bottom: 10px;
        font: 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: rgba(255, 255, 255, 0.82);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <div id="scene-root"></div>
    <div id="readout">native scene surface</div>
    <script>
      (() => {
        const root = document.getElementById('scene-root');
        const readout = document.getElementById('readout');
        const frameTimes = [];
        const layers = new Map();
        const pollers = new Map();
        const sourceFrames = new Map();
        let compositorStatus = null;
        let pendingCompositorStatus = null;
        let pendingCompositorReceivedAt = 0;
        let compositorFrames = 0;
        let presentedCompositorFrame = 0;
        let skippedCompositorFrames = 0;
        let inputToPresentLatencyMs = null;
        let scene = ${initialSceneJson};
        let frames = 0;
        let liveLayerCount = 0;
        let startedAt = performance.now();

        function percent(value) {
          const next = Number.isFinite(value) ? value : 0;
          return String(next * 100) + '%';
        }

        function cacheBust(url) {
          return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        }

        function cropStyle(transform) {
          const cropLeft = Math.max(0, Number(transform?.cropLeft ?? 0));
          const cropRight = Math.max(0, Number(transform?.cropRight ?? 0));
          const cropTop = Math.max(0, Number(transform?.cropTop ?? 0));
          const cropBottom = Math.max(0, Number(transform?.cropBottom ?? 0));
          const keptX = Math.max(0.001, 1 - cropLeft - cropRight);
          const keptY = Math.max(0.001, 1 - cropTop - cropBottom);
          return {
            left: String((-cropLeft / keptX) * 100) + '%',
            top: String((-cropTop / keptY) * 100) + '%',
            width: String((1 / keptX) * 100) + '%',
            height: String((1 / keptY) * 100) + '%'
          };
        }

        function markLive(kind, sourceId) {
          sourceFrames.set(sourceId, (sourceFrames.get(sourceId) ?? 0) + 1);
          liveLayerCount = [...layers.values()].filter(({ image }) => image?.dataset.live === '1').length;
          if (liveLayerCount > 0) {
            document.body.classList.add('surface-live');
          }
          readout.textContent = kind === 'screen-image' ? 'native scene + screen image' : 'native scene source';
        }

        function stopMissingPollers(activeIds) {
          for (const [id, poller] of pollers) {
            if (!activeIds.has(id)) {
              poller.cancelled = true;
              pollers.delete(id);
            }
          }
        }

        function startFramePolling(id, kind, image, url) {
          const existing = pollers.get(id);
          if (existing?.url === url && existing?.image === image) {
            return;
          }
          if (existing) {
            existing.cancelled = true;
          }
          const poller = { url, image, cancelled: false, pending: false };
          pollers.set(id, poller);

          const poll = () => {
            if (poller.cancelled) {
              return;
            }
            if (poller.pending) {
              window.setTimeout(poll, 33);
              return;
            }
            poller.pending = true;
            const next = new Image();
            next.decoding = 'async';
            next.onload = () => {
              if (!poller.cancelled) {
                image.src = next.src;
                image.dataset.live = '1';
                markLive(kind, id);
              }
              poller.pending = false;
              window.setTimeout(poll, 33);
            };
            next.onerror = () => {
              poller.pending = false;
              window.setTimeout(poll, 250);
            };
            next.src = cacheBust(url);
          };

          poll();
        }

        function upsertLayer(layer) {
          const id = String(layer.id);
          let entry = layers.get(id);
          if (!entry) {
            const element = document.createElement('div');
            const image = document.createElement('img');
            image.alt = '';
            element.className = 'scene-layer';
            element.dataset.layerId = id;
            element.appendChild(image);
            root.appendChild(element);
            entry = { element, image };
            layers.set(id, entry);
          }

          const { element, image } = entry;
          const transform = layer.transform ?? {};
          element.dataset.kind = layer.kind ?? 'unknown';
          element.dataset.visible = layer.visible === false ? '0' : '1';
          element.style.display = layer.visible === false ? 'none' : 'block';
          element.style.left = percent(transform.x);
          element.style.top = percent(transform.y);
          element.style.width = percent(transform.width || 0);
          element.style.height = percent(transform.height || 0);
          element.style.borderRadius = layer.shape === 'circle' ? '9999px' : '0';

          const crop = cropStyle(transform);
          image.style.left = crop.left;
          image.style.top = crop.top;
          image.style.width = crop.width;
          image.style.height = crop.height;
          image.style.objectFit = layer.fit === 'cover' ? 'cover' : 'contain';
          image.style.transform = layer.mirror ? 'scaleX(-1)' : 'none';

          if (layer.kind === 'test-pattern') {
            image.removeAttribute('src');
            image.dataset.live = '1';
            markLive(layer.kind, id);
            return;
          }

          if (layer.imageUrl) {
            const existingPoller = pollers.get(id);
            if (existingPoller) {
              existingPoller.cancelled = true;
            }
            pollers.delete(id);
            if (image.src !== layer.imageUrl) {
              image.dataset.live = '0';
              image.onload = () => {
                image.dataset.live = '1';
                markLive(layer.kind, id);
              };
              image.onerror = () => {
                image.dataset.live = '0';
              };
              image.src = layer.imageUrl;
            }
            return;
          }

          if (layer.frameUrl) {
            startFramePolling(id, layer.kind, image, layer.frameUrl);
            return;
          }

          image.dataset.live = '0';
          image.removeAttribute('src');
        }

        function applyScene(nextScene) {
          scene = nextScene;
          window.__videorcNativePreviewSceneRevision = scene?.revision ?? null;
          document.body.dataset.sceneRevision = String(scene?.revision ?? '');
          const nextLayers = Array.isArray(scene?.sources) ? scene.sources.filter((layer) => layer.visible !== false) : [];
          const activeIds = new Set(nextLayers.map((layer) => String(layer.id)));
          stopMissingPollers(activeIds);
          for (const [id, entry] of layers) {
            if (!activeIds.has(id)) {
              entry.element.remove();
              layers.delete(id);
            }
          }
          nextLayers.forEach(upsertLayer);
          liveLayerCount = [...layers.values()].filter(({ image }) => image?.dataset.live === '1').length;
          if (liveLayerCount === 0) {
            document.body.classList.remove('surface-live');
            readout.textContent = nextLayers.length ? 'native scene waiting for source' : 'native synthetic surface';
          }
        }

        window.__videorcSetPreviewScene = applyScene;

        function applyCompositorStatus(nextStatus) {
          pendingCompositorStatus = nextStatus;
          pendingCompositorReceivedAt = performance.now();
          compositorFrames = Math.max(compositorFrames, Number(nextStatus?.framesRendered ?? 0));
        }

        function presentLatestCompositorStatus(now) {
          if (!pendingCompositorStatus) {
            return;
          }
          const nextStatus = pendingCompositorStatus;
          const receivedAt = pendingCompositorReceivedAt;
          pendingCompositorStatus = null;
          compositorStatus = nextStatus;
          if (nextStatus?.state === 'live') {
            document.body.classList.add('surface-live');
            const frame = Number(nextStatus.framesRendered ?? 0);
            if (frame > presentedCompositorFrame + 1) {
              skippedCompositorFrames += frame - presentedCompositorFrame - 1;
            }
            presentedCompositorFrame = Math.max(presentedCompositorFrame, frame);
            const frameAgeMs = Number(nextStatus.frameAgeMs ?? 0);
            inputToPresentLatencyMs = Math.max(0, Math.round(frameAgeMs + Math.max(0, now - receivedAt)));
            const width = Math.max(1, Number(nextStatus.width ?? window.innerWidth));
            const x = (frame * 7) % (width + 140);
            document.body.style.setProperty('--dot-x', String((x / Math.max(1, width)) * 100) + '%');
            document.body.style.setProperty('--offset', String((frame * 3) % 240) + 'px');
            document.body.style.setProperty('--stripe-offset', String((frame * 5) % 120) + 'px');
            const liveSources = Array.isArray(nextStatus.sources)
              ? nextStatus.sources.filter((source) => source.state === 'live').map((source) => source.kind)
              : [];
            readout.textContent = liveSources.length
              ? 'native compositor: ' + liveSources.join(' + ')
              : 'native compositor surface';
          }
        }

        window.__videorcSetCompositorStatus = applyCompositorStatus;

        function tick(now) {
          frames += 1;
          frameTimes.push(now);
          if (frameTimes.length > 900) frameTimes.shift();
          presentLatestCompositorStatus(now);
          if (!compositorStatus) {
            const x = (now * 0.045) % Math.max(1, window.innerWidth + 140);
            document.body.style.setProperty('--dot-x', String((x / Math.max(1, window.innerWidth)) * 100) + '%');
            document.body.style.setProperty('--offset', String((now * 0.08) % 240) + 'px');
            document.body.style.setProperty('--stripe-offset', String((now * 0.18) % 120) + 'px');
          }
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
              sceneRevision: scene?.revision ?? null,
              compositorSceneRevision: compositorStatus?.sceneRevision ?? null,
              sceneMatchesCompositor: compositorStatus?.sceneRevision == null
                ? null
                : scene?.revision === compositorStatus.sceneRevision,
              compositorState: compositorStatus?.state ?? null,
              compositorFrames,
              presentedCompositorFrame,
              compositorFrameLag: Math.max(0, compositorFrames - presentedCompositorFrame),
              skippedCompositorFrames,
              inputToPresentLatencyMs,
              compositorSources: compositorStatus?.sources ?? [],
              layerCount: layers.size,
              liveLayerCount,
              sourceFrames: Object.fromEntries(sourceFrames),
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

        applyScene(scene);
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
      `data:text/html;charset=utf-8,${encodeURIComponent(nativePreviewSurfaceHtml(nativePreviewSurfaceScene))}`
    )
  }

  nativePreviewSurfaceWindow.setBounds(rect)
  nativePreviewSurfaceWindow.showInactive()
  nativePreviewSurfaceStatus = {
    state: 'live',
    source: nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'screen' || source.kind === 'window')
      ? 'screen'
      : nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'camera')
        ? 'camera'
        : 'synthetic',
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    targetFps: 60,
    width: rect.width,
    height: rect.height,
    framesRendered: nativePreviewSurfaceStatus.framesRendered,
    presentedFrameId: nativePreviewSurfaceStatus.presentedFrameId,
    compositorFrameLag: nativePreviewSurfaceStatus.compositorFrameLag,
    droppedFrames: nativePreviewSurfaceStatus.droppedFrames ?? 0,
    inputToPresentLatencyMs: nativePreviewSurfaceStatus.inputToPresentLatencyMs,
    presentFps: nativePreviewSurfaceStatus.presentFps,
    intervalP95Ms: nativePreviewSurfaceStatus.intervalP95Ms,
    bounds,
    startedAt: nativePreviewSurfaceStatus.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: nativePreviewSurfaceScene
      ? 'Electron proof scene preview surface.'
      : 'Synthetic Electron proof preview surface.'
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
    source: nativePreviewSurfaceStatus.source,
    transport: 'electron-proof-surface',
    backing: 'electron-browser-window',
    width: rect.width,
    height: rect.height,
    droppedFrames: nativePreviewSurfaceStatus.droppedFrames ?? 0,
    bounds,
    updatedAt: new Date().toISOString()
  }
  return nativePreviewSurfaceStatus
}

async function updateNativePreviewSurfaceScene(params: PreviewSurfaceSceneUpdateParams): Promise<PreviewSurfaceStatus> {
  nativePreviewSurfaceScene = buildPreviewSurfaceScene(params)
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    const sceneJson = jsonForInlineScript(nativePreviewSurfaceScene)
    await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `window.__videorcSetPreviewScene?.(${sceneJson})`,
      true
    )
  }

  const hasScreen = nativePreviewSurfaceScene.sources.some((source) => source.kind === 'screen' || source.kind === 'window')
  const hasCamera = nativePreviewSurfaceScene.sources.some((source) => source.kind === 'camera')
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    source: hasScreen ? 'screen' : hasCamera ? 'camera' : 'synthetic',
    updatedAt: new Date().toISOString(),
    message: 'Native preview surface scene updated.'
  }
  return nativePreviewSurfaceStatus
}

async function updateNativePreviewSurfaceCompositor(status: CompositorStatus): Promise<PreviewSurfaceStatus> {
  const compositorScene = buildPreviewSurfaceSceneFromCompositorStatus(status)
  if (compositorScene) {
    nativePreviewSurfaceScene = compositorScene
  }
  let metrics: Record<string, unknown> | null = null
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    const sceneScript = compositorScene
      ? `window.__videorcSetPreviewScene?.(${jsonForInlineScript(compositorScene)});`
      : ''
    const statusJson = jsonForInlineScript(status)
    await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `${sceneScript}window.__videorcSetCompositorStatus?.(${statusJson})`,
      true
    )
    metrics = await readNativePreviewSurfaceMetricsAfterPaint()
  }
  const hasScreen = nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'screen' || source.kind === 'window')
  const hasCamera = nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'camera')
  const presentedFrameId = finiteMetric(metrics?.presentedCompositorFrame)
  const compositorFrameLag = finiteMetric(metrics?.compositorFrameLag)
  const droppedFrames = finiteMetric(metrics?.skippedCompositorFrames) ?? nativePreviewSurfaceStatus.droppedFrames ?? 0
  const inputToPresentLatencyMs = finiteMetric(metrics?.inputToPresentLatencyMs)
  const presentFps = finiteMetric(metrics?.measuredFps)
  const intervalP95Ms = finiteMetric(metrics?.intervalP95Ms)
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    source: hasScreen ? 'screen' : hasCamera ? 'camera' : nativePreviewSurfaceStatus.source,
    framesRendered: Math.max(nativePreviewSurfaceStatus.framesRendered, status.framesRendered, presentedFrameId ?? 0),
    presentedFrameId,
    compositorFrameLag,
    droppedFrames,
    inputToPresentLatencyMs,
    presentFps,
    intervalP95Ms,
    updatedAt: new Date().toISOString(),
    message: status.state === 'live' ? 'Electron proof preview surface is displaying compositor output.' : status.message
  }
  return nativePreviewSurfaceStatus
}

async function readNativePreviewSurfaceMetricsAfterPaint(): Promise<Record<string, unknown> | null> {
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    return null
  }
  return nativePreviewSurfaceWindow.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => resolve(window.__videorcNativePreviewMetrics?.() ?? null)))`,
    true
  )
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function waitForNativePreviewSurfaceScript(timeoutMs = 5000): Promise<void> {
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    return
  }
  const deadline = Date.now() + timeoutMs
  let lastState: unknown = null
  while (Date.now() < deadline) {
    try {
      lastState = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
        'typeof window.__videorcSetPreviewScene',
        true
      )
      if (lastState === 'function') {
        return
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error)
    }
    await delay(50)
  }
  throw new Error(`Native preview surface script was not ready. Last state: ${String(lastState)}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
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

  if (command === 'exercise-native-preview-scene') {
    if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.webContents.isDestroyed()) {
      throw new Error('Native preview surface is not ready for scene exercise.')
    }
    await updateNativePreviewSurfaceCompositor(smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(1, 0.1)))
    const startedAt = performance.now()
    await updateNativePreviewSurfaceCompositor(smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(2, 0.62)))
    const result = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `(() => {
        const layer = document.querySelector('[data-layer-id="source:camera"]');
        const metrics = window.__videorcNativePreviewMetrics?.() ?? {};
        return {
          cameraLeft: layer?.style.left ?? null,
          cameraTop: layer?.style.top ?? null,
          cameraWidth: layer?.style.width ?? null,
          cameraHeight: layer?.style.height ?? null,
          sceneRevision: window.__videorcNativePreviewSceneRevision ?? null,
          compositorSceneRevision: metrics.compositorSceneRevision ?? null,
          sceneMatchesCompositor: metrics.sceneMatchesCompositor ?? null,
          layerCount: document.querySelectorAll('.scene-layer').length
        };
      })()`,
      true
    )
    return {
      ...result,
      updateLatencyMs: performance.now() - startedAt
    }
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
      presentedFrameId: finiteMetric(metrics.presentedCompositorFrame),
      compositorFrameLag: finiteMetric(metrics.compositorFrameLag),
      droppedFrames: finiteMetric(metrics.skippedCompositorFrames) ?? nativePreviewSurfaceStatus.droppedFrames ?? 0,
      inputToPresentLatencyMs: finiteMetric(metrics.inputToPresentLatencyMs),
      presentFps: finiteMetric(metrics.measuredFps),
      intervalP95Ms: finiteMetric(metrics.intervalP95Ms),
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

function smokePreviewSceneParams(revision: number, cameraX: number): PreviewSurfaceSceneUpdateParams {
  const cameraTransform: SceneTransform = {
    x: cameraX,
    y: 0.18,
    width: 0.24,
    height: 0.24,
    cropLeft: 0.08,
    cropTop: 0.04,
    cropRight: 0.08,
    cropBottom: 0.04
  }
  const layout: LayoutSettings = {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'custom',
    cameraTransform: {
      x: cameraTransform.x,
      y: cameraTransform.y,
      width: cameraTransform.width,
      height: cameraTransform.height
    },
    cameraCorner: 'top-right',
    cameraSize: 'medium',
    cameraShape: 'circle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: true,
    cameraZoom: 125,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '60-40',
    sideBySideCameraSide: 'right'
  }
  const baseTransform = fullFrameTransform()
  return {
    revision,
    layout,
    activeScreen: null,
    scene: {
      id: 'scene:smoke-preview',
      name: 'Smoke Preview Scene',
      outputs: [],
      sources: [
        {
          id: 'source:test-pattern',
          name: 'Test pattern',
          kind: 'test-pattern',
          transform: baseTransform,
          defaultTransform: baseTransform,
          visible: true,
          locked: false
        },
        {
          id: 'source:camera',
          name: 'Camera',
          kind: 'camera',
          transform: cameraTransform,
          defaultTransform: cameraTransform,
          visible: true,
          locked: false
        }
      ]
    }
  }
}

function smokeCompositorStatusFromSceneParams(params: PreviewSurfaceSceneUpdateParams): CompositorStatus {
  return {
    state: 'live',
    targetFps: 60,
    width: 1280,
    height: 720,
    sceneRevision: params.revision,
    sceneId: params.scene?.id,
    sceneLayout: params.layout,
    activeScreenId: params.activeScreen?.id,
    sceneSources: [
      ...(params.scene?.sources ?? []).map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        state: 'referenced',
        deviceId: source.deviceId,
        visible: source.visible,
        transform: source.transform,
        fit: previewLayerFit(source, params.layout),
        mirror: source.kind === 'camera' ? params.layout.cameraMirror : false,
        shape: previewLayerShape(source, params.layout)
      })),
      ...(params.activeScreen
        ? [
            {
              id: `screen-image:${params.activeScreen.id}`,
              name: params.activeScreen.name,
              kind: 'screen-image' as const,
              state: params.activeScreen.status === 'ready' ? 'live' : 'source-missing',
              visible: true,
              transform: fullFrameTransform(),
              fit: 'cover' as const,
              mirror: false,
              imagePath: params.activeScreen.imagePath,
              fileRevision: params.activeScreen.status === 'ready' ? 'smoke-revision' : undefined,
              width: params.activeScreen.status === 'ready' ? 1280 : undefined,
              height: params.activeScreen.status === 'ready' ? 720 : undefined
            }
          ]
        : [])
    ],
    sources: [],
    renderFps: 60,
    framesRendered: Date.now(),
    repeatedFrames: 0,
    droppedFrames: 0,
    frameAgeMs: 0,
    frameTimeP95Ms: 16,
    updatedAt: new Date().toISOString(),
    message: 'Smoke compositor scene update.'
  }
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

      if (${JSON.stringify(command)} === 'inspect-native-preview-bootstrap') {
        const stage = await waitFor('[data-videorc-preview-stage]');
        const surface = await waitFor('[data-videorc-preview-surface]');
        const nativePlaceholder = params.requireNativePlaceholder
          ? await waitFor('[data-videorc-native-preview-surface]')
          : document.querySelector('[data-videorc-native-preview-surface]');
        const rect = surface.getBoundingClientRect();
        const previewImages = Array.from(stage.querySelectorAll('[data-videorc-preview-image]'));
        const previewImageSrcs = previewImages
          .map((image) => image.getAttribute('src') ?? '')
          .filter(Boolean);
        return {
          hasStage: Boolean(stage),
          hasSurface: Boolean(surface),
          hasNativePlaceholder: Boolean(nativePlaceholder),
          previewImageCount: previewImages.length,
          previewImageSrcs,
          hasJpegPollingPreviewImage: previewImageSrcs.some((src) => src.includes('/preview/live.jpg') || src.includes('/preview/live.mjpeg')),
          surfaceWidth: rect.width,
          surfaceHeight: rect.height,
          hasVideorcBridge: Boolean(window.videorc),
          hasCreateNativePreviewSurface: Boolean(window.videorc?.createNativePreviewSurface),
          hasUpdateNativePreviewSurfaceBounds: Boolean(window.videorc?.updateNativePreviewSurfaceBounds),
          hasUpdateNativePreviewSurfaceScene: Boolean(window.videorc?.updateNativePreviewSurfaceScene)
        };
      }

      if (${JSON.stringify(command)} === 'inspect-preview-stage-badges') {
        const stage = await waitFor('[data-videorc-preview-stage]');
        const badges = Array.from(stage.querySelectorAll('[data-slot="badge"]'))
          .map((badge) => badge.textContent?.trim())
          .filter(Boolean);
        return { badges };
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
  ipcMain.handle('preview-surface:update-scene', (_event, scene: PreviewSurfaceSceneUpdateParams) =>
    updateNativePreviewSurfaceScene(scene)
  )
  ipcMain.handle('preview-surface:update-compositor', (_event, status: CompositorStatus) =>
    updateNativePreviewSurfaceCompositor(status)
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
