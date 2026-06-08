import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse as HttpResponse
} from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { createNativePreviewHelperProcessDriver } from './native-preview-helper-process-driver'
import { loadNativePreviewRealSurfaceDriver } from './native-preview-real-surface-loader'
import {
  DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS,
  compositorStatusMetalTargetHandoff,
  nativeCametalLayerStatusMatchesHandoff,
  proofSurfaceCompositorMessage,
  realSurfaceInvalidActivationMessage,
  realSurfaceUnavailableMessage,
  type NativePreviewRealSurfaceDriver
} from '../shared/native-preview-host-driver'
import { normalizePreviewSurfaceBounds } from '../shared/native-preview-bounds'
import { accountSkippedPreviewFrame } from '../shared/native-preview-latest-wins'
import type {
  BackendConnection,
  BackendLogEvent,
  CameraShape,
  CompositorStatus,
  LayoutSettings,
  NativePreviewHostCommand,
  PreviewSurfaceCompositorUpdateParams,
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
let nativePreviewSurfaceCompositorUpdateInFlight: Promise<PreviewSurfaceStatus> | null = null
let nativePreviewSurfaceCompositorRequestSerial = 0
let nativePreviewSurfaceMutationInFlight: Promise<PreviewSurfaceStatus> | null = null
let nativePreviewSurfaceFramePollingSuppressed = false
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendConnection: BackendConnection | null = null
let smokePreviewMotionServer: HttpServer | null = null
let smokePreviewCompositorFrameId = 0
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
const smokeCommandServerEnabled =
  process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1' || process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1'
const NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD = 3
const requireNativePreviewRealSurfaceModule = createRequire(__filename)
const configuredNativePreviewHostModulePath = process.env.VIDEORC_NATIVE_PREVIEW_HOST_MODULE?.trim()
const nativePreviewRealSurfaceDriverLoad = loadNativePreviewRealSurfaceDriver({
  modulePath: configuredNativePreviewHostModulePath,
  loadModule: (modulePath) => requireNativePreviewRealSurfaceModule(modulePath)
})
const NATIVE_PREVIEW_HANDOFF_SAMPLE_LIMIT = 900
let nativePreviewRealSurfaceDriverUnavailableReason = nativePreviewRealSurfaceDriverLoad.unavailableReason
let nativePreviewRealSurfaceDriver: NativePreviewRealSurfaceDriver | null = nativePreviewRealSurfaceDriverLoad.driver
let nativePreviewHelperProcessDriverResolved = false
let nativePreviewLastRealSurfaceFallbackLogKey: string | undefined
let nativePreviewRealSurfaceInvalidActivationCount = 0
let nativePreviewMainQueueWaitSamplesMs: number[] = []
let nativePreviewMainPresentSamplesMs: number[] = []
let nativePreviewMainQueuedBehindCount = 0
let nativePreviewMainStatusFetchSamplesMs: number[] = []
let nativePreviewMainStatusAgeSamplesMs: number[] = []
let nativePreviewMainStatusFrameAgeSamplesMs: number[] = []
let nativePreviewMainStatusFetchFailures = 0
let nativePreviewMainStatusFetchSuccesses = 0

type NativePreviewRendererTimingFields = Pick<
  PreviewSurfaceCompositorUpdateParams,
  | 'nativePreviewRendererPollIntervalP95Ms'
  | 'nativePreviewRendererPollRoundTripP95Ms'
  | 'nativePreviewRendererPresentRoundTripP95Ms'
  | 'nativePreviewRendererPollInFlightSkips'
>

type NativePreviewMainStatusRefreshFields = Pick<
  PreviewSurfaceCompositorUpdateParams,
  | 'nativePreviewMainStatusFetchP95Ms'
  | 'nativePreviewMainStatusFetchFailures'
  | 'nativePreviewMainStatusFetchSuccesses'
  | 'nativePreviewMainPresentedStatusAgeMs'
  | 'nativePreviewMainPresentedStatusAgeP95Ms'
  | 'nativePreviewMainPresentedFrameAgeP95Ms'
>

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
    framePollingSuppressed: false,
    sourcePixelsPresent: false,
    pendingHostCommandCount: 0,
    updatedAt: new Date().toISOString(),
    message
  }
}

function backendPreviewFrameUrl(
  path: '/preview/camera/live.png' | '/preview/screen/live.png',
  maxWidth?: number
): string | undefined {
  if (!nativePreviewFramePollingEnabled || nativePreviewSurfaceFramePollingSuppressed || !backendConnection) {
    return undefined
  }
  const params = new URLSearchParams({ token: backendConnection.token })
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0) {
    params.set('maxWidth', String(Math.max(1, Math.round(maxWidth))))
  }
  return `http://${backendConnection.host}:${backendConnection.port}${path}?${params.toString()}`
}

function fileUrlFromPath(path: string): string {
  return pathToFileURL(path).toString()
}

function nativePreviewSurfaceHtmlPath(): string {
  return join(app.getPath('userData'), 'native-preview-surface.html')
}

function writeNativePreviewSurfaceHtmlShell(): string {
  const htmlPath = nativePreviewSurfaceHtmlPath()
  mkdirSync(dirname(htmlPath), { recursive: true })
  writeFileSync(htmlPath, nativePreviewSurfaceHtml(null), 'utf8')
  return htmlPath
}

async function loadNativePreviewSurfaceHtml(surfaceWindow: BrowserWindow): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const htmlPath = writeNativePreviewSurfaceHtmlShell()
    try {
      await surfaceWindow.loadFile(htmlPath)
      return
    } catch (error) {
      lastError = error
      if (surfaceWindow.isDestroyed() || attempt === 1) {
        throw error
      }
      await delay(75)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function nativePreviewSurfaceLoadCanRetry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Object has been destroyed') || message.includes('ERR_FAILED')
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

function previewDrawableWidth(): number | undefined {
  const bounds = nativePreviewSurfaceStatus.bounds
  const width = bounds?.width ?? nativePreviewSurfaceStatus.width
  const scaleFactor = bounds?.scaleFactor ?? 1
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return undefined
  }
  return width * Math.max(1, scaleFactor)
}

function previewLayerSnapshotWidth(transform: SceneTransform, sourceWidth?: number): number | undefined {
  const drawableWidth = previewDrawableWidth()
  if (!drawableWidth) {
    return undefined
  }
  const layerWidth = Math.max(0.01, Number(transform.width || 1))
  const requestedWidth = Math.ceil(drawableWidth * layerWidth)
  return typeof sourceWidth === 'number' && Number.isFinite(sourceWidth)
    ? Math.min(sourceWidth, requestedWidth)
    : requestedWidth
}

function previewLayerFrameUrl(source: SceneSource): string | undefined {
  const maxWidth = previewLayerSnapshotWidth(source.transform)
  if (source.kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/live.png', maxWidth)
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/live.png', maxWidth)
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
    frameUrl: nativePreviewSurfaceFramePollingSuppressed ? undefined : previewLayerFrameUrl(source),
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

function buildPreviewSurfaceSceneFromCompositorStatus(
  status: PreviewSurfaceCompositorUpdateParams
): PreviewSurfaceSceneState | null {
  if (typeof status.sceneRevision !== 'number' || !status.sceneLayout) {
    return null
  }
  const suppressFramePolling =
    nativePreviewSurfaceFramePollingSuppressed || status.suppressFramePolling === true
  const layers: PreviewSurfaceSceneLayer[] = (status.sceneSources ?? []).map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    transform: source.transform,
    visible: source.visible,
    frameUrl: suppressFramePolling ? undefined : compositorLayerFrameUrl(source),
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

function compositorLayerFrameUrl(source: CompositorStatus['sceneSources'][number]): string | undefined {
  const maxWidth = previewLayerSnapshotWidth(source.transform, source.width)
  if (source.kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/live.png', maxWidth)
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/live.png', maxWidth)
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
        let framePollingSuppressed = false;
        let compositorStatus = null;
        let pendingCompositorStatus = null;
        let pendingCompositorReceivedAt = 0;
        let compositorFrames = 0;
        let presentedCompositorFrame = 0;
        let skippedCompositorFrames = 0;
        let inputToPresentLatencyMs = null;
        const inputToPresentLatencies = [];
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

        function stopLayerPoller(id) {
          const existingPoller = pollers.get(id);
          if (existingPoller) {
            existingPoller.cancelled = true;
          }
          pollers.delete(id);
        }

        function stopAllPollers() {
          for (const id of Array.from(pollers.keys())) {
            stopLayerPoller(id);
          }
        }

        function setFramePollingSuppressed(suppressed) {
          framePollingSuppressed = suppressed === true;
          if (framePollingSuppressed) {
            stopAllPollers();
          }
        }

        function startFramePolling(id, kind, image, url) {
          if (framePollingSuppressed) {
            stopLayerPoller(id);
            image.dataset.live = '0';
            image.removeAttribute('src');
            return;
          }
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
            stopLayerPoller(id);
            image.removeAttribute('src');
            image.dataset.live = '1';
            markLive(layer.kind, id);
            return;
          }

          if (layer.imageUrl) {
            stopLayerPoller(id);
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

          stopLayerPoller(id);
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
        window.__videorcSetFramePollingSuppressed = setFramePollingSuppressed;

        function applyCompositorStatus(nextStatus) {
          pendingCompositorStatus = nextStatus;
          pendingCompositorReceivedAt = performance.now();
          const frame = Number(nextStatus?.framesRendered ?? 0);
          if (compositorFrames > 0 && frame > 0 && frame < compositorFrames) {
            compositorFrames = 0;
            presentedCompositorFrame = 0;
            skippedCompositorFrames = 0;
          }
          compositorFrames = Math.max(compositorFrames, frame);
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
            if (presentedCompositorFrame > 0 && frame > presentedCompositorFrame + 1) {
              skippedCompositorFrames += frame - presentedCompositorFrame - 1;
            }
            presentedCompositorFrame = Math.max(presentedCompositorFrame, frame);
            const frameAgeMs = Number(nextStatus.frameAgeMs ?? 0);
            inputToPresentLatencyMs = Math.max(0, Math.round(frameAgeMs + Math.max(0, now - receivedAt)));
            inputToPresentLatencies.push(inputToPresentLatencyMs);
            if (inputToPresentLatencies.length > 900) inputToPresentLatencies.shift();
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

        window.__videorcPresentNativePreviewNow = () => {
          presentLatestCompositorStatus(performance.now());
          return window.__videorcNativePreviewMetrics?.() ?? null;
        };

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
            const percentile = (values, p) => {
              const sorted = [...values].sort((a, b) => a - b);
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
              inputToPresentLatencyP50Ms: percentile(inputToPresentLatencies, 50),
              inputToPresentLatencyP95Ms: percentile(inputToPresentLatencies, 95),
              inputToPresentLatencyP99Ms: percentile(inputToPresentLatencies, 99),
              compositorSources: compositorStatus?.sources ?? [],
              layerCount: layers.size,
              liveLayerCount,
              sourceFrames: Object.fromEntries(sourceFrames),
              intervalP50Ms: percentile(intervals, 50),
              intervalP95Ms: percentile(intervals, 95),
              intervalP99Ms: percentile(intervals, 99),
              framePollingSuppressed,
              sourcePixelsPresent: liveLayerCount > 0,
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
  const normalized = normalizePreviewSurfaceBounds(bounds)
  return {
    x: Math.round(normalized.screenX),
    y: Math.round(normalized.screenY),
    width: Math.max(1, Math.round(normalized.width)),
    height: Math.max(1, Math.round(normalized.height))
  }
}

async function createNativePreviewSurfaceWindow(): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is not ready for native preview surface.')
    }

    const surfaceWindow = new BrowserWindow({
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
    nativePreviewSurfaceWindow = surfaceWindow
    surfaceWindow.setIgnoreMouseEvents(true, { forward: true })
    surfaceWindow.on('closed', () => {
      if (nativePreviewSurfaceWindow === surfaceWindow) {
        nativePreviewSurfaceWindow = null
        nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
      }
    })

    try {
      await loadNativePreviewSurfaceHtml(surfaceWindow)
      if (nativePreviewSurfaceFramePollingSuppressed) {
        await waitForNativePreviewSurfaceScript()
        await surfaceWindow.webContents.executeJavaScript(
          'window.__videorcSetFramePollingSuppressed?.(true)',
          true
        )
      }
      if (nativePreviewSurfaceScene) {
        await waitForNativePreviewSurfaceScript()
        await surfaceWindow.webContents.executeJavaScript(
          `window.__videorcSetPreviewScene?.(${jsonForInlineScript(nativePreviewSurfaceScene)})`,
          true
        )
      }
      return
    } catch (error) {
      lastError = error
      if (nativePreviewSurfaceWindow === surfaceWindow) {
        nativePreviewSurfaceWindow = null
      }
      if (!surfaceWindow.isDestroyed()) {
        surfaceWindow.destroy()
      }
      if (attempt === 0 && nativePreviewSurfaceLoadCanRetry(error)) {
        await delay(75)
        continue
      }
      throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function createNativePreviewSurface(bounds: PreviewSurfaceBounds): Promise<PreviewSurfaceStatus> {
  bounds = normalizePreviewSurfaceBounds(bounds)
  if (!nativePreviewSurfaceProofEnabled) {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus('Native preview surface proof mode is disabled.')
    return nativePreviewSurfaceStatus
  }
  resetNativePreviewMainHandoffMetrics()
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not ready for native preview surface.')
  }

  const rect = normalizedSurfaceBounds(bounds)
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    await createNativePreviewSurfaceWindow()
  }

  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    throw new Error('Native preview surface window closed before it could be positioned.')
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
    inputToPresentLatencyP50Ms: nativePreviewSurfaceStatus.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms: nativePreviewSurfaceStatus.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms: nativePreviewSurfaceStatus.inputToPresentLatencyP99Ms,
    presentFps: nativePreviewSurfaceStatus.presentFps,
    intervalP95Ms: nativePreviewSurfaceStatus.intervalP95Ms,
    intervalP99Ms: nativePreviewSurfaceStatus.intervalP99Ms,
    framePollingSuppressed: nativePreviewSurfaceFramePollingSuppressed,
    sourcePixelsPresent: nativePreviewSurfaceStatus.sourcePixelsPresent,
    pendingHostCommandCount: 0,
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
  bounds = normalizePreviewSurfaceBounds(bounds)
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

async function applyNativePreviewHostCommands(commands: NativePreviewHostCommand[]): Promise<PreviewSurfaceStatus> {
  await applyNativePreviewRealSurfaceHostCommands(commands)
  let status = nativePreviewSurfaceStatus
  for (const command of commands) {
    if (command.kind === 'destroy') {
      status = destroyNativePreviewSurface()
      continue
    }

    if (!command.bounds) {
      throw new Error(`Native preview host ${command.kind} command is missing bounds.`)
    }

    status =
      command.kind === 'create'
        ? await createNativePreviewSurface(command.bounds)
        : await updateNativePreviewSurfaceBounds(command.bounds)
  }
  return status
}

async function applyNativePreviewRealSurfaceHostCommands(
  commands: NativePreviewHostCommand[],
  options: { startIfNeeded?: boolean } = {}
): Promise<void> {
  const driver = options.startIfNeeded === false
    ? nativePreviewRealSurfaceDriver
    : ensureNativePreviewRealSurfaceDriver()
  if (!driver || commands.length === 0) {
    return
  }
  try {
    await driver.applyHostCommands(commands)
  } catch (error) {
    nativePreviewRealSurfaceDriver = null
    nativePreviewRealSurfaceDriverUnavailableReason =
      `Real CAMetalLayer IOSurface presenter module failed while applying host commands: ${errorMessage(error)}`
  }
}

async function runNativePreviewSurfaceMutation(
  operation: () => PreviewSurfaceStatus | Promise<PreviewSurfaceStatus>
): Promise<PreviewSurfaceStatus> {
  await waitForNativePreviewSurfaceMutation()

  const mutation = Promise.resolve().then(operation)
  nativePreviewSurfaceMutationInFlight = mutation
  try {
    return await mutation
  } finally {
    if (nativePreviewSurfaceMutationInFlight === mutation) {
      nativePreviewSurfaceMutationInFlight = null
    }
  }
}

async function waitForNativePreviewSurfaceMutation(): Promise<void> {
  while (nativePreviewSurfaceMutationInFlight) {
    try {
      await nativePreviewSurfaceMutationInFlight
    } catch {
      // The next queued mutation should still get a chance to reconcile the host.
    }
  }
}

async function updateNativePreviewSurfaceScene(params: PreviewSurfaceSceneUpdateParams): Promise<PreviewSurfaceStatus> {
  await waitForNativePreviewSurfaceMutation()
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

async function updateNativePreviewSurfaceCompositor(
  status: PreviewSurfaceCompositorUpdateParams
): Promise<PreviewSurfaceStatus> {
  await waitForNativePreviewSurfaceMutation()
  const requestSerial = ++nativePreviewSurfaceCompositorRequestSerial
  let queueWaitMs = 0
  if (nativePreviewSurfaceCompositorUpdateInFlight) {
    try {
      const waitStartedAtMs = Date.now()
      nativePreviewMainQueuedBehindCount += 1
      await nativePreviewSurfaceCompositorUpdateInFlight
      queueWaitMs += Math.max(0, Date.now() - waitStartedAtMs)
    } catch {
      // The next call will surface the real error if the proof window is still broken.
    }
    if (requestSerial < nativePreviewSurfaceCompositorRequestSerial) {
      nativePreviewSurfaceStatus = {
        ...nativePreviewSurfaceStatus,
        ...accountSkippedPreviewFrame(nativePreviewSurfaceStatus, status.framesRendered),
        updatedAt: new Date().toISOString(),
        message: `Native preview skipped stale compositor frame ${status.framesRendered}; presenting the newest queued frame.`
      }
      return nativePreviewSurfaceStatus
    }
  }

  const update = presentNativePreviewSurfaceCompositor(status, { queueWaitMs })
  nativePreviewSurfaceCompositorUpdateInFlight = update
  try {
    return await update
  } finally {
    if (nativePreviewSurfaceCompositorUpdateInFlight === update) {
      nativePreviewSurfaceCompositorUpdateInFlight = null
    }
  }
}

async function presentNativePreviewSurfaceCompositor(
  status: PreviewSurfaceCompositorUpdateParams,
  mainTiming: { queueWaitMs?: number } = {}
): Promise<PreviewSurfaceStatus> {
  if (status.suppressFramePolling === true && !nativePreviewSurfaceFramePollingSuppressed) {
    await setNativePreviewSurfaceFramePollingSuppressed(true)
  }
  const effectiveStatus = await refreshNativePreviewCompositorStatus(status)
  const compositorScene = buildPreviewSurfaceSceneFromCompositorStatus(effectiveStatus)
  if (compositorScene) {
    nativePreviewSurfaceScene = compositorScene
  }
  const realSurfaceAttempt = await tryPresentNativePreviewRealSurfaceCompositor(effectiveStatus, mainTiming)
  if (realSurfaceAttempt.kind === 'presented') {
    nativePreviewLastRealSurfaceFallbackLogKey = undefined
    return realSurfaceAttempt.status
  }
  const fallbackLogKey = realSurfaceAttempt.logKey ?? realSurfaceAttempt.reason
  if (realSurfaceAttempt.reason && fallbackLogKey !== nativePreviewLastRealSurfaceFallbackLogKey) {
    nativePreviewLastRealSurfaceFallbackLogKey = fallbackLogKey
    logBackend('warn', realSurfaceAttempt.reason)
  }
  let metrics: Record<string, unknown> | null = null
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    const sceneScript = compositorScene
      ? `window.__videorcSetPreviewScene?.(${jsonForInlineScript(compositorScene)});`
      : ''
    const statusJson = jsonForInlineScript(effectiveStatus)
    await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `${sceneScript}window.__videorcSetCompositorStatus?.(${statusJson})`,
      true
    )
    metrics = await readNativePreviewSurfaceMetricsAfterPaint()
  }
  const hasScreen = nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'screen' || source.kind === 'window')
  const hasCamera = nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'camera')
  const presentedFrameId = finiteMetric(metrics?.presentedCompositorFrame)
  const compositorFrameLag = finiteMetric(metrics?.compositorFrameLag) ?? (presentedFrameId === undefined ? undefined : 0)
  const droppedFrames = finiteMetric(metrics?.skippedCompositorFrames) ?? nativePreviewSurfaceStatus.droppedFrames ?? 0
  const inputToPresentLatencyMs = finiteMetric(metrics?.inputToPresentLatencyMs)
  const inputToPresentLatencyP50Ms = finiteMetric(metrics?.inputToPresentLatencyP50Ms)
  const inputToPresentLatencyP95Ms = finiteMetric(metrics?.inputToPresentLatencyP95Ms)
  const inputToPresentLatencyP99Ms = finiteMetric(metrics?.inputToPresentLatencyP99Ms)
  const presentFps = finiteMetric(metrics?.measuredFps)
  const intervalP95Ms = finiteMetric(metrics?.intervalP95Ms)
  const intervalP99Ms = finiteMetric(metrics?.intervalP99Ms)
  const liveLayerCount = finiteMetric(metrics?.liveLayerCount) ?? 0
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    ...nativePreviewRendererTimingStatusFields(effectiveStatus),
    ...nativePreviewMainStatusRefreshFields(effectiveStatus),
    source: hasScreen ? 'screen' : hasCamera ? 'camera' : nativePreviewSurfaceStatus.source,
    framesRendered: Math.max(nativePreviewSurfaceStatus.framesRendered, effectiveStatus.framesRendered, presentedFrameId ?? 0),
    presentedFrameId,
    compositorFrameLag,
    droppedFrames,
    inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms,
    presentFps,
    intervalP95Ms,
    intervalP99Ms,
    framePollingSuppressed: nativePreviewSurfaceFramePollingSuppressed || effectiveStatus.suppressFramePolling === true,
    sourcePixelsPresent: liveLayerCount > 0,
    updatedAt: new Date().toISOString(),
    message: proofSurfaceCompositorMessage(effectiveStatus, realSurfaceAttempt.reason)
  }
  return nativePreviewSurfaceStatus
}

type NativePreviewRealSurfacePresentAttempt =
  | { kind: 'presented'; status: PreviewSurfaceStatus }
  | { kind: 'skipped'; reason?: string; logKey?: string }

async function tryPresentNativePreviewRealSurfaceCompositor(
  status: PreviewSurfaceCompositorUpdateParams,
  mainTiming: { queueWaitMs?: number } = {}
): Promise<NativePreviewRealSurfacePresentAttempt> {
  const handoff = compositorStatusMetalTargetHandoff(status, {
    maxAgeMs: DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS
  })
  if (!handoff) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    const hasMetalTarget =
      typeof status.metalTargetIosurfaceId === 'number' && status.metalTargetIosurfaceId > 0
    return {
      kind: 'skipped',
      reason: hasMetalTarget
        ? `Native preview falling back to image polling: the compositor's Metal IOSurface target is older than the ${DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS}ms handoff budget (compose is too slow to stay live).`
        : `Native preview falling back to image polling: the compositor status carries no Metal IOSurface target (metalTargetIosurfaceId=${status.metalTargetIosurfaceId ?? 'absent'}), so there is nothing to present natively for this scene.`,
      logKey: `no-handoff:${hasMetalTarget ? 'stale' : 'absent'}`
    }
  }
  if (nativePreviewSurfaceStatus.state !== 'live') {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    return {
      kind: 'skipped',
      reason: `Native preview falling back to image polling: the preview surface is not live yet (state=${nativePreviewSurfaceStatus.state}).`,
      logKey: `not-live:${nativePreviewSurfaceStatus.state}`
    }
  }
  // Re-present even when the helper already confirmed this compositor frame. Real
  // sources can update at 30fps while the preview surface must still present at
  // display cadence so motion stays current instead of waiting for a new frame id.
  const driver = ensureNativePreviewRealSurfaceDriver()
  if (!driver) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    return {
      kind: 'skipped',
      reason: realSurfaceUnavailableMessage(handoff, nativePreviewRealSurfaceDriverUnavailableReason),
      logKey: `unavailable:${nativePreviewRealSurfaceDriverUnavailableReason ?? 'not-configured'}`
    }
  }

  let driverStatus: PreviewSurfaceStatus | null
  const presentStartedAtMs = Date.now()
  try {
    driverStatus = await driver.presentCompositorHandoff({
      handoff,
      bounds: nativePreviewSurfaceStatus.bounds,
      scene: nativePreviewSurfaceScene,
      suppressFramePolling: nativePreviewSurfaceFramePollingSuppressed || status.suppressFramePolling === true,
      frameAgeMs: status.frameAgeMs,
      compositorUpdatedAt: status.updatedAt
    })
  } catch (error) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    nativePreviewRealSurfaceDriver = null
    nativePreviewRealSurfaceDriverUnavailableReason =
      `Real CAMetalLayer IOSurface presenter failed while presenting compositor handoff: ${errorMessage(error)}`
    return {
      kind: 'skipped',
      reason: realSurfaceUnavailableMessage(handoff, nativePreviewRealSurfaceDriverUnavailableReason),
      logKey: `error:${nativePreviewRealSurfaceDriverUnavailableReason}`
    }
  }
  const mainTimingStatus = recordNativePreviewMainHandoffMetrics(
    mainTiming.queueWaitMs ?? 0,
    Math.max(0, Date.now() - presentStartedAtMs)
  )
  if (!driverStatus || !nativeCametalLayerStatusMatchesHandoff(driverStatus, handoff)) {
    nativePreviewRealSurfaceInvalidActivationCount += 1
    const shouldReportInvalidActivation =
      nativePreviewRealSurfaceInvalidActivationCount >= NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD
    return {
      kind: 'skipped',
      reason: shouldReportInvalidActivation ? realSurfaceInvalidActivationMessage(handoff, driverStatus) : undefined,
      logKey: `invalid-activation:${handoff.iosurfaceId}:${handoff.width}x${handoff.height}`
    }
  }

  nativePreviewRealSurfaceInvalidActivationCount = 0
  const previousDroppedFrames = nativePreviewSurfaceStatus.droppedFrames ?? 0
  nativePreviewSurfaceStatus = {
    ...driverStatus,
    ...nativePreviewRendererTimingStatusFields(status),
    ...nativePreviewMainStatusRefreshFields(status),
    ...mainTimingStatus,
    droppedFrames: Math.max(driverStatus.droppedFrames ?? 0, previousDroppedFrames),
    framePollingSuppressed: nativePreviewSurfaceFramePollingSuppressed || status.suppressFramePolling === true,
    updatedAt: new Date().toISOString()
  }
  return { kind: 'presented', status: nativePreviewSurfaceStatus }
}

async function setNativePreviewSurfaceFramePollingSuppressed(
  suppressed: boolean
): Promise<PreviewSurfaceStatus> {
  const wasSuppressed = nativePreviewSurfaceFramePollingSuppressed
  nativePreviewSurfaceFramePollingSuppressed = suppressed
  if (suppressed && !wasSuppressed) {
    resetNativePreviewMainHandoffMetrics()
    nativePreviewRealSurfaceDriver?.resetMetrics?.()
  }
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `window.__videorcSetFramePollingSuppressed?.(${suppressed ? 'true' : 'false'})`,
      true
    )
  }
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    framePollingSuppressed: suppressed,
    sourcePixelsPresent: suppressed ? false : nativePreviewSurfaceStatus.sourcePixelsPresent,
    updatedAt: new Date().toISOString(),
    message: suppressed
      ? 'Electron proof preview surface frame polling is suppressed while recording.'
      : 'Electron proof preview surface frame polling is enabled.'
  }
  return nativePreviewSurfaceStatus
}

async function readNativePreviewSurfaceMetricsAfterPaint(): Promise<Record<string, unknown> | null> {
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    return null
  }
  return nativePreviewSurfaceWindow.webContents.executeJavaScript(
    `window.__videorcPresentNativePreviewNow?.() ?? new Promise((resolve) => requestAnimationFrame(() => resolve(window.__videorcNativePreviewMetrics?.() ?? null)))`,
    true
  )
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function refreshNativePreviewCompositorStatus(
  status: PreviewSurfaceCompositorUpdateParams
): Promise<PreviewSurfaceCompositorUpdateParams> {
  if (!backendConnection) {
    return {
      ...status,
      ...nativePreviewMainStatusRefreshFields(status)
    }
  }

  const params = new URLSearchParams({ token: backendConnection.token })
  const fetchStartedAtMs = Date.now()
  try {
    const freshStatus = await requestBackendJson<CompositorStatus>(
      `http://${backendConnection.host}:${backendConnection.port}/compositor/status?${params.toString()}`
    )
    const refreshFields = recordNativePreviewMainStatusRefresh(freshStatus, fetchStartedAtMs, true)
    return {
      ...freshStatus,
      ...nativePreviewRendererTimingStatusFields(status),
      ...refreshFields,
      suppressFramePolling: status.suppressFramePolling
    }
  } catch {
    const refreshFields = recordNativePreviewMainStatusRefresh(status, fetchStartedAtMs, false)
    return {
      ...status,
      ...refreshFields
    }
  }
}

function requestBackendJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, { method: 'GET' }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0
        if (statusCode < 200 || statusCode >= 300) {
          rejectRequest(new Error(`Backend HTTP ${statusCode}`))
          return
        }
        try {
          resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
        } catch (error) {
          rejectRequest(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    request.setTimeout(1000, () => {
      request.destroy(new Error('Backend HTTP request timed out.'))
    })
    request.on('error', rejectRequest)
    request.end()
  })
}

function nativePreviewRendererTimingStatusFields(
  status: PreviewSurfaceCompositorUpdateParams
): NativePreviewRendererTimingFields {
  return {
    nativePreviewRendererPollIntervalP95Ms: finiteMetric(status.nativePreviewRendererPollIntervalP95Ms),
    nativePreviewRendererPollRoundTripP95Ms: finiteMetric(status.nativePreviewRendererPollRoundTripP95Ms),
    nativePreviewRendererPresentRoundTripP95Ms: finiteMetric(status.nativePreviewRendererPresentRoundTripP95Ms),
    nativePreviewRendererPollInFlightSkips: finiteMetric(status.nativePreviewRendererPollInFlightSkips)
  }
}

function recordNativePreviewMainHandoffMetrics(
  queueWaitMs: number,
  presentMs: number
): Partial<PreviewSurfaceStatus> {
  recordNativePreviewTimingSample(nativePreviewMainQueueWaitSamplesMs, queueWaitMs)
  recordNativePreviewTimingSample(nativePreviewMainPresentSamplesMs, presentMs)
  return {
    nativePreviewMainQueueWaitP95Ms: nativePreviewTimingPercentile(nativePreviewMainQueueWaitSamplesMs, 0.95),
    nativePreviewMainPresentP95Ms: nativePreviewTimingPercentile(nativePreviewMainPresentSamplesMs, 0.95),
    nativePreviewMainQueuedBehindCount
  }
}

function recordNativePreviewMainStatusRefresh(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus,
  fetchStartedAtMs: number,
  succeeded: boolean
): NativePreviewMainStatusRefreshFields {
  recordNativePreviewTimingSample(nativePreviewMainStatusFetchSamplesMs, Math.max(0, Date.now() - fetchStartedAtMs))
  if (succeeded) {
    nativePreviewMainStatusFetchSuccesses += 1
  } else {
    nativePreviewMainStatusFetchFailures += 1
  }

  const statusAgeMs = nativePreviewCompositorStatusAgeMs(status)
  if (typeof statusAgeMs === 'number') {
    recordNativePreviewTimingSample(nativePreviewMainStatusAgeSamplesMs, statusAgeMs)
  }
  const frameAgeMs = finiteMetric(status.frameAgeMs)
  if (typeof frameAgeMs === 'number') {
    recordNativePreviewTimingSample(nativePreviewMainStatusFrameAgeSamplesMs, frameAgeMs)
  }

  return nativePreviewMainStatusRefreshFields(status)
}

function nativePreviewMainStatusRefreshFields(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus
): NativePreviewMainStatusRefreshFields {
  return {
    nativePreviewMainStatusFetchP95Ms: nativePreviewTimingPercentile(nativePreviewMainStatusFetchSamplesMs, 0.95),
    nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs: nativePreviewCompositorStatusAgeMs(status),
    nativePreviewMainPresentedStatusAgeP95Ms: nativePreviewTimingPercentile(nativePreviewMainStatusAgeSamplesMs, 0.95),
    nativePreviewMainPresentedFrameAgeP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainStatusFrameAgeSamplesMs,
      0.95
    )
  }
}

function nativePreviewCompositorStatusAgeMs(status: PreviewSurfaceCompositorUpdateParams | CompositorStatus): number | undefined {
  const updatedAtMs = Date.parse(status.updatedAt)
  if (!Number.isFinite(updatedAtMs)) {
    return undefined
  }
  return Math.max(0, Date.now() - updatedAtMs)
}

function resetNativePreviewMainHandoffMetrics(): void {
  nativePreviewMainQueueWaitSamplesMs = []
  nativePreviewMainPresentSamplesMs = []
  nativePreviewMainQueuedBehindCount = 0
  nativePreviewMainStatusFetchSamplesMs = []
  nativePreviewMainStatusAgeSamplesMs = []
  nativePreviewMainStatusFrameAgeSamplesMs = []
  nativePreviewMainStatusFetchFailures = 0
  nativePreviewMainStatusFetchSuccesses = 0
}

function recordNativePreviewTimingSample(samples: number[], value: number): void {
  if (!Number.isFinite(value)) {
    return
  }
  samples.push(Math.max(0, value))
  while (samples.length > NATIVE_PREVIEW_HANDOFF_SAMPLE_LIMIT) {
    samples.shift()
  }
}

function nativePreviewTimingPercentile(values: number[], percentileRank: number): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileRank) - 1))
  return sorted[index]
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
  resetNativePreviewMainHandoffMetrics()
  nativePreviewSurfaceCompositorRequestSerial += 1
  void applyNativePreviewRealSurfaceHostCommands([{ kind: 'destroy' }], { startIfNeeded: false })
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    nativePreviewSurfaceWindow.close()
  }
  nativePreviewSurfaceWindow = null
  nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
  return nativePreviewSurfaceStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ensureNativePreviewRealSurfaceDriver(): NativePreviewRealSurfaceDriver | null {
  if (nativePreviewRealSurfaceDriver) {
    return nativePreviewRealSurfaceDriver
  }
  if (configuredNativePreviewHostModulePath || nativePreviewHelperProcessDriverResolved) {
    return null
  }

  nativePreviewHelperProcessDriverResolved = true
  const helperDriver = createNativePreviewHelperProcessDriverConfig()
  if (!helperDriver.driver) {
    nativePreviewRealSurfaceDriverUnavailableReason = helperDriver.unavailableReason
    return null
  }

  nativePreviewRealSurfaceDriver = helperDriver.driver
  nativePreviewRealSurfaceDriverUnavailableReason = undefined
  return nativePreviewRealSurfaceDriver
}

function createNativePreviewHelperProcessDriverConfig():
  | { driver: NativePreviewRealSurfaceDriver; unavailableReason?: undefined }
  | { driver: null; unavailableReason: string } {
  if (process.platform !== 'darwin') {
    return {
      driver: null,
      unavailableReason: 'Real CAMetalLayer IOSurface helper is only available on macOS'
    }
  }

  const explicitHelperPath = process.env.VIDEORC_NATIVE_PREVIEW_HOST_HELPER?.trim()
  const root = workspaceRoot()
  const cargoBinDir = join(homedir(), '.cargo', 'bin')
  const ffmpegBinDir = resolvePackagedFfmpegBinDir()
  const pathEntries = [ffmpegBinDir, cargoBinDir, process.env.PATH].filter(Boolean)
  const env = {
    ...process.env,
    PATH: pathEntries.join(delimiter)
  }

  if (explicitHelperPath) {
    return {
      driver: createNativePreviewHelperProcessDriver({
        command: explicitHelperPath,
        cwd: root,
        env,
        onLog: logBackend
      })
    }
  }

  if (app.isPackaged) {
    const helperPath = join(process.resourcesPath, 'native_preview_host_helper')
    if (!existsSync(helperPath)) {
      return {
        driver: null,
        unavailableReason: `Real CAMetalLayer IOSurface helper was not found at ${helperPath}`
      }
    }
    return {
      driver: createNativePreviewHelperProcessDriver({
        command: helperPath,
        cwd: dirname(helperPath),
        env,
        onLog: logBackend
      })
    }
  }

  return {
    driver: createNativePreviewHelperProcessDriver({
      command: resolveCargoBinary(),
      args: ['run', '--quiet', '-p', 'videorc-backend', '--bin', 'native_preview_host_helper', '--'],
      cwd: root,
      env,
      onLog: logBackend
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
  const args = app.isPackaged ? [] : ['run', '--quiet', '-p', 'videorc-backend', '--bin', 'videorc-backend']
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
    if (window === nativePreviewSurfaceWindow) {
      continue
    }
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue
    }

    try {
      if (window.webContents.mainFrame.isDestroyed()) {
        continue
      }
      window.webContents.send(channel, ...args)
    } catch {
      // The renderer can be disposed between the destroyed check and send during app shutdown.
    }
  }
}

function startSmokePreviewMotionServer(): void {
  if (!smokeCommandServerEnabled || smokePreviewMotionServer) {
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
    const firstStatus = smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(1, 0.1))
    const finalStatus = smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(2, 0.62))
    const finalScene = buildPreviewSurfaceSceneFromCompositorStatus(finalStatus)
    await updateNativePreviewSurfaceCompositor(firstStatus)
    const startedAt = performance.now()
    const sceneScript = finalScene
      ? `window.__videorcSetPreviewScene?.(${jsonForInlineScript(finalScene)});`
      : ''
    const statusScript = `window.__videorcSetCompositorStatus?.(${jsonForInlineScript(finalStatus)});`
    const result = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `${sceneScript}${statusScript}window.__videorcPresentNativePreviewNow?.();(() => {
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
    if (nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus)) {
      return nativePreviewSurfaceStatusMetrics(nativePreviewSurfaceStatus)
    }
    const metrics = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      'window.__videorcNativePreviewMetrics?.() ?? null',
      true
    )
    if (!metrics) {
      throw new Error('Native preview surface did not expose metrics.')
    }
    const presentedFrameId = finiteMetric(metrics.presentedCompositorFrame)
    const liveLayerCount = finiteMetric(metrics.liveLayerCount) ?? 0
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      framesRendered: Number(metrics.frames ?? nativePreviewSurfaceStatus.framesRendered),
      presentedFrameId,
      compositorFrameLag: finiteMetric(metrics.compositorFrameLag) ?? (presentedFrameId === undefined ? undefined : 0),
      droppedFrames: finiteMetric(metrics.skippedCompositorFrames) ?? nativePreviewSurfaceStatus.droppedFrames ?? 0,
      inputToPresentLatencyMs: finiteMetric(metrics.inputToPresentLatencyMs),
      inputToPresentLatencyP50Ms: finiteMetric(metrics.inputToPresentLatencyP50Ms),
      inputToPresentLatencyP95Ms: finiteMetric(metrics.inputToPresentLatencyP95Ms),
      inputToPresentLatencyP99Ms: finiteMetric(metrics.inputToPresentLatencyP99Ms),
      presentFps: finiteMetric(metrics.measuredFps),
      intervalP95Ms: finiteMetric(metrics.intervalP95Ms),
      intervalP99Ms: finiteMetric(metrics.intervalP99Ms),
      framePollingSuppressed: Boolean(metrics.framePollingSuppressed),
      sourcePixelsPresent: liveLayerCount > 0,
      updatedAt: new Date().toISOString()
    }
    return {
      ...metrics,
      status: nativePreviewSurfaceStatus
    }
  }

  if (command === 'destroy-native-preview-surface') {
    return destroyNativePreviewSurface()
  }

  if (command === 'apply-native-preview-host-commands') {
    if (!Array.isArray(params.commands)) {
      throw new Error('Native preview host command smoke requires a commands array.')
    }
    return runNativePreviewSurfaceMutation(() =>
      applyNativePreviewHostCommands(params.commands as NativePreviewHostCommand[])
    )
  }

  if (command === 'native-preview-surface-status') {
    return nativePreviewSurfaceStatus
  }

  const script = smokeRendererScript(command, params)
  return mainWindow.webContents.executeJavaScript(script, true)
}

function nativePreviewSurfaceStatusIsRealSurface(status: PreviewSurfaceStatus): boolean {
  return (
    status.state === 'live' &&
    status.transport === 'native-surface' &&
    status.backing === 'cametal-layer' &&
    status.sourcePixelsPresent === true
  )
}

function nativePreviewSurfaceStatusMetrics(status: PreviewSurfaceStatus): Record<string, unknown> {
  return {
    frames: status.framesRendered,
    measuredFps: status.presentFps,
    intervalP95Ms: status.intervalP95Ms,
    intervalP99Ms: status.intervalP99Ms,
    compositorFrames: status.framesRendered,
    presentedCompositorFrame: status.presentedFrameId,
    compositorFrameLag: status.compositorFrameLag,
    skippedCompositorFrames: status.droppedFrames,
    inputToPresentLatencyMs: status.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms: status.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms: status.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms: status.inputToPresentLatencyP99Ms,
    nativePreviewRendererPollIntervalP95Ms: status.nativePreviewRendererPollIntervalP95Ms,
    nativePreviewRendererPollRoundTripP95Ms: status.nativePreviewRendererPollRoundTripP95Ms,
    nativePreviewRendererPresentRoundTripP95Ms: status.nativePreviewRendererPresentRoundTripP95Ms,
    nativePreviewRendererPollInFlightSkips: status.nativePreviewRendererPollInFlightSkips,
    nativePreviewMainQueueWaitP95Ms: status.nativePreviewMainQueueWaitP95Ms,
    nativePreviewMainPresentP95Ms: status.nativePreviewMainPresentP95Ms,
    nativePreviewMainQueuedBehindCount: status.nativePreviewMainQueuedBehindCount,
    nativePreviewHelperRoundTripP95Ms: status.nativePreviewHelperRoundTripP95Ms,
    nativePreviewMainStatusFetchP95Ms: status.nativePreviewMainStatusFetchP95Ms,
    nativePreviewMainStatusFetchFailures: status.nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses: status.nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs: status.nativePreviewMainPresentedStatusAgeMs,
    nativePreviewMainPresentedStatusAgeP95Ms: status.nativePreviewMainPresentedStatusAgeP95Ms,
    nativePreviewMainPresentedFrameAgeP95Ms: status.nativePreviewMainPresentedFrameAgeP95Ms,
    framePollingSuppressed: status.framePollingSuppressed,
    sourcePixelsPresent: status.sourcePixelsPresent,
    blankFrames: 0,
    width: status.width,
    height: status.height,
    measurementSource: 'native-surface-status',
    status
  }
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
  smokePreviewCompositorFrameId += 1
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
    framesRendered: smokePreviewCompositorFrameId,
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
      const waitForActiveTab = async (tabId, timeoutMs = 8000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (document.querySelector('[data-videorc-active-tab="' + tabId + '"]')) {
            return document.querySelector('[data-videorc-active-tab="' + tabId + '"]');
          }
          const activeTab = Array.from(document.querySelectorAll('[data-videorc-tab-trigger]'))
            .find((candidate) =>
              candidate.getAttribute('data-videorc-tab-trigger') === tabId &&
              candidate.getAttribute('aria-current') === 'page'
            );
          if (activeTab) return activeTab;
          await sleep(50);
        }
        throw new Error('Timed out waiting for active tab ' + tabId);
      };
      const openTab = async (tabId, waitSelector = null) => {
        const tab =
          Array.from(document.querySelectorAll('[data-videorc-tab-trigger]'))
            .find((candidate) => candidate.getAttribute('data-videorc-tab-trigger') === tabId) ??
          document.querySelector('[data-videorc-open-tab="' + tabId + '"]');
        if (!tab) {
          throw new Error('Could not find tab ' + tabId);
        }
        tab.click();
        await waitForActiveTab(tabId);
        if (waitSelector) {
          await waitFor(waitSelector);
        } else {
          await sleep(250);
        }
        return { activeTab: tabId };
      };

      if (${JSON.stringify(command)} === 'open-layout-tab') {
        return openTab('layout', '[data-videorc-preview-stage]');
      }

      if (${JSON.stringify(command)} === 'open-tab') {
        const tabId = String(params.tab ?? 'studio');
        const waitSelector = typeof params.waitFor === 'string' ? params.waitFor : null;
        return openTab(tabId, waitSelector);
      }

      if (${JSON.stringify(command)} === 'suspend-native-preview-surface') {
        window.__videorcSmokeNativePreviewSuspended = true;
        const status = await window.videorc?.destroyNativePreviewSurface?.();
        return { suspended: true, status: status ?? null };
      }

      if (${JSON.stringify(command)} === 'resume-native-preview-surface') {
        window.__videorcSmokeNativePreviewSuspended = false;
        return { suspended: false };
      }

      if (${JSON.stringify(command)} === 'inspect-native-preview-runtime') {
        const runtimeInfo = await window.videorc?.getRuntimeInfo?.();
        const stage = document.querySelector('[data-videorc-preview-stage]');
        const surface = document.querySelector('[data-videorc-preview-surface]');
        const nativePlaceholder = document.querySelector('[data-videorc-native-preview-surface]');
        return {
          runtimeInfo: runtimeInfo ?? null,
          hasStage: Boolean(stage),
          hasSurface: Boolean(surface),
          hasNativePlaceholder: Boolean(nativePlaceholder),
          smokeSuspended: Boolean(window.__videorcSmokeNativePreviewSuspended),
          surfaceRect: surface
            ? (() => {
                const rect = surface.getBoundingClientRect();
                return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
              })()
            : null
        };
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
  ipcMain.handle('preview-surface:create', (_event, bounds: PreviewSurfaceBounds) =>
    runNativePreviewSurfaceMutation(() => createNativePreviewSurface(bounds))
  )
  ipcMain.handle('preview-surface:update-bounds', (_event, bounds: PreviewSurfaceBounds) =>
    runNativePreviewSurfaceMutation(() => updateNativePreviewSurfaceBounds(bounds))
  )
  ipcMain.handle('preview-surface:apply-host-commands', (_event, commands: NativePreviewHostCommand[]) =>
    runNativePreviewSurfaceMutation(() => applyNativePreviewHostCommands(commands))
  )
  ipcMain.handle('preview-surface:update-scene', (_event, scene: PreviewSurfaceSceneUpdateParams) =>
    updateNativePreviewSurfaceScene(scene)
  )
  ipcMain.handle('preview-surface:update-compositor', (_event, status: PreviewSurfaceCompositorUpdateParams) =>
    updateNativePreviewSurfaceCompositor(status)
  )
  ipcMain.handle('preview-surface:set-frame-polling-suppressed', (_event, suppressed: boolean) =>
    setNativePreviewSurfaceFramePollingSuppressed(suppressed)
  )
  ipcMain.handle('preview-surface:destroy', () =>
    runNativePreviewSurfaceMutation(() => destroyNativePreviewSurface())
  )
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
