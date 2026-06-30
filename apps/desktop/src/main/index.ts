import {
  app,
  BrowserWindow,
  contentTracing,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type NativeImage
} from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse as HttpResponse
} from 'node:http'
import { createRequire } from 'node:module'
import { homedir, release } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  OwnedProcessRegistry,
  acquireOwnedProcessStartupLock,
  globalOwnedProcessLedgerPath,
  ownedProcessLedgerPath,
  ownedProcessStartupLockPath
} from './backend-owned-processes'
import { stopBackendProcess } from './backend-process-shutdown'
import { createNativePreviewHelperProcessDriver } from './native-preview-helper-process-driver'
import { loadNativePreviewRealSurfaceDriver } from './native-preview-real-surface-loader'
import { safeConsole } from './safe-console'
import {
  assertPermissionShortcutSupported,
  buildRuntimeInfo,
  permissionUrlForPane
} from './runtime-info'
import { createMediaPermissionGrantWatcher } from './system-permission-watch'
import { PreviewSupervisorModel } from './preview-supervisor'
import { initAutoUpdater } from './updater'
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
import {
  BUNDLED_BACKGROUND_MANIFEST,
  backgroundAssetNameFromPath,
  isSupportedBackgroundFile,
  managedBackgroundFileName,
  type BackgroundImportResult
} from '../shared/background-import'
import type {
  BackendConnection,
  BackendLogEvent,
  CameraShape,
  CommentsWindowState,
  CompositorStatus,
  LayoutSettings,
  LiveChatSnapshot,
  NativePreviewHostCommand,
  NotesDocument,
  NotesFontScale,
  NotesWindowState,
  PreviewSurfaceCompositorUpdateParams,
  PreviewSurfaceBounds,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState,
  PreviewSurfaceSceneUpdateParams,
  PreviewSurfaceStatus,
  PreviewPermissionStatus,
  PreviewSupervisorState,
  SceneSource,
  SceneTransform,
  StreamScreen,
  SystemPermissionPane,
  RuntimeInfo
} from '../shared/backend'

let mainWindow: BrowserWindow | null = null
let nativePreviewSurfaceWindow: BrowserWindow | null = null
let notesWindow: BrowserWindow | null = null
let notesWindowLastFrame: Electron.Rectangle | null = null
let notesWindowAlwaysOnTop = false
let notesWindowClosing = false
let notesWindowContentProtected = false
let commentsWindow: BrowserWindow | null = null
let commentsWindowLastFrame: Electron.Rectangle | null = null
let commentsWindowAlwaysOnTop = false
let commentsWindowClosing = false
let latestCommentsSnapshot: LiveChatSnapshot | null = null
let nativePreviewSurfaceStatus: PreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
let nativePreviewSurfaceCompositorUpdateInFlight: Promise<PreviewSurfaceStatus> | null = null
let nativePreviewSurfaceCompositorRequestSerial = 0
let nativePreviewSurfaceMutationInFlight: Promise<PreviewSurfaceStatus> | null = null
let nativePreviewSurfaceFramePollingSuppressed = false
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendQuitComplete = false
let backendQuitInProgress = false
let backendRestartInProgress: Promise<void> | null = null
let backendOwnedProcessPids = new Set<number>()
let backendPermissionTargetPath: string | null = null
let ownedProcessRegistry: OwnedProcessRegistry | null = null
let ownedProcessRegistryLockDepth = 0
let backendConnection: BackendConnection | null = null
let smokePreviewMotionServer: HttpServer | null = null
let smokePreviewCompositorFrameId = 0
let nativePreviewSurfaceScene: PreviewSurfaceSceneState | null = null
let stdoutBuffer = ''
let appIsQuitting = false
let appIcon: NativeImage | null | undefined
const PREVIEW_BACKGROUND_STAGE_MARGIN = 0.1
const backendLogs: BackendLogEvent[] = []
const pendingOAuthCallbackUrls: string[] = []
const OAUTH_CALLBACK_PROTOCOL = 'videorc'
const OAUTH_APP_PROTOCOL_REDIRECT_URI = 'videorc://oauth/callback'
// v1 default: the native preview surface is always on; the env var is a developer
// kill switch only (VIDEORC_NATIVE_PREVIEW_SURFACE=0).
const nativePreviewSurfaceProofEnabled = process.env.VIDEORC_NATIVE_PREVIEW_SURFACE !== '0'
const nativePreviewFramePollingEnabled = process.env.VIDEORC_SMOKE_PREVIEW_MOTION !== '1'
// Notes is on by default after the final-artifact invisibility smoke landed.
// Keep a developer kill switch for emergency rollback.
const notesWindowFeatureEnabled = process.env.VIDEORC_NOTES_WINDOW !== '0'
const commentsWindowFeatureEnabled = process.env.VIDEORC_COMMENTS_WINDOW !== '0'
const notesWindowSmokeMarkerEnabled =
  notesWindowFeatureEnabled &&
  process.env.VIDEORC_NOTES_SMOKE_MARKER === '1' &&
  Boolean(process.env.VIDEORC_SMOKE_OUTPUT_DIR)

app.setName('Videorc')
// Dark glass is the default theme; the renderer re-syncs this on toggle.
nativeTheme.themeSource = 'dark'
// True vibrancy is the default glass; =0 opts out, and any other value picks
// the macOS material by name (e.g. hud, popover, menu, under-window).
type GlassVibrancyMaterial = NonNullable<Parameters<BrowserWindow['setVibrancy']>[0]>
const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const glassVibrancyEnabled = process.env.VIDEORC_GLASS_VIBRANCY !== '0'
const glassVibrancyRaw = process.env.VIDEORC_GLASS_VIBRANCY
const glassVibrancyMaterial: GlassVibrancyMaterial =
  glassVibrancyRaw && glassVibrancyRaw !== '0' && glassVibrancyRaw !== '1'
    ? (glassVibrancyRaw as GlassVibrancyMaterial)
    : 'under-window'

// Blurred-wallpaper underlay (the glassmorphism frost): the renderer blurs
// the actual wallpaper as its bottom layer since the OS material cannot do
// it here. Fetching uses System Events — the one-time Automation prompt, if
// denied, degrades cleanly to the plain translucent glass.
// macOS-only today: the underlay is fetched through System Events (osascript),
// so gating on isMac keeps the move/resize/focus listeners from shelling out on
// Windows. The Windows wallpaper underlay (a registry read, no prompt) is Phase 4.
const glassWallpaperEnabled =
  isMac && glassVibrancyEnabled && process.env.VIDEORC_GLASS_WALLPAPER !== '0'
let glassWallpaperDataUrl: string | null = null
let glassWallpaperSourcePath: string | null = null
let glassGeometryTimer: ReturnType<typeof setTimeout> | null = null

function glassGeometry(): { window: Electron.Rectangle; display: Electron.Rectangle } | null {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null
  }
  const bounds = mainWindow.getBounds()
  return { window: bounds, display: screen.getDisplayMatching(bounds).bounds }
}

function queueGlassGeometryBroadcast(): void {
  if (!glassWallpaperEnabled || glassGeometryTimer) {
    return
  }
  glassGeometryTimer = setTimeout(() => {
    glassGeometryTimer = null
    const geometry = glassGeometry()
    if (geometry && glassWallpaperDataUrl) {
      mainWindow?.webContents.send('glass:geometry', geometry)
    }
  }, 40)
}

function currentWallpaperPath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to get picture of current desktop'],
      { timeout: 3000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  })
}

async function refreshGlassWallpaper(): Promise<void> {
  if (!glassWallpaperEnabled) {
    return
  }
  const wallpaperPath = await currentWallpaperPath()
  if (!wallpaperPath || (wallpaperPath === glassWallpaperSourcePath && glassWallpaperDataUrl)) {
    return
  }
  try {
    let image = nativeImage.createFromPath(wallpaperPath)
    if (image.isEmpty()) {
      return
    }
    // The layer gets a 70px blur anyway; 1800px wide is plenty of detail and
    // keeps the data URL a few hundred KB instead of tens of MB.
    if (image.getSize().width > 1800) {
      image = image.resize({ width: 1800 })
    }
    glassWallpaperDataUrl = `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`
    glassWallpaperSourcePath = wallpaperPath
    const geometry = glassGeometry()
    if (geometry) {
      mainWindow?.webContents.send('glass:wallpaper', {
        imageDataUrl: glassWallpaperDataUrl,
        ...geometry
      })
    }
  } catch {
    /* unreadable wallpaper: stay on the plain translucent glass */
  }
}
// Lifecycle smokes can isolate the app-level backend ledger without touching
// the developer's real app data.
const appDataDirOverride = process.env.VIDEORC_APP_DATA_DIR?.trim()
if (appDataDirOverride) {
  app.setPath('appData', appDataDirOverride)
}
// Probes and perf harnesses may still isolate preferences with userData, but
// backend ownership is now app-global unless they explicitly disable reaping.
const userDataDirOverride = process.env.VIDEORC_USER_DATA_DIR?.trim()
if (userDataDirOverride) {
  app.setPath('userData', userDataDirOverride)
}
// Perf harnesses attach CDP profilers to the renderer through this switch
// (0 = pick a free port; Chromium prints "DevTools listening on ws://...").
const remoteDebugPortOverride = process.env.VIDEORC_REMOTE_DEBUG_PORT?.trim()
if (remoteDebugPortOverride) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPortOverride)
}
// Keep the detached preview window live while it sits behind the main window.
// A scene change is made in the main window, so the preview is occluded at that
// moment — and macOS/Chromium stops compositing a fully-occluded window, which
// froze the preview until it was clicked to the front. These switches keep
// occluded/background windows rendering so the preview updates in place. The
// per-window backgroundThrottling:false flags only cover timers/visibility; the
// occlusion-driven compositor suspension needs these process-level switches.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const smokeCommandServerEnabled =
  process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1' ||
  process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1'
const NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD = 3
const requireNativePreviewRealSurfaceModule = createRequire(__filename)
const configuredNativePreviewHostModulePath = process.env.VIDEORC_NATIVE_PREVIEW_HOST_MODULE?.trim()
const nativePreviewRealSurfaceDriverLoad = loadNativePreviewRealSurfaceDriver({
  modulePath: configuredNativePreviewHostModulePath,
  loadModule: (modulePath) => requireNativePreviewRealSurfaceModule(modulePath)
})
const NATIVE_PREVIEW_HANDOFF_SAMPLE_LIMIT = 900
let nativePreviewRealSurfaceDriverUnavailableReason =
  nativePreviewRealSurfaceDriverLoad.unavailableReason
let nativePreviewRealSurfaceDriver: NativePreviewRealSurfaceDriver | null =
  nativePreviewRealSurfaceDriverLoad.driver
let nativePreviewHelperProcessDriverResolved = false
let nativePreviewHelperDriverRetryAtMs = 0
const NATIVE_PREVIEW_HELPER_RETRY_COOLDOWN_MS = 5000
// While the native CAMetalLayer recently confirmed a present, it owns placement
// and the Electron proof window stays hidden (no stacked surfaces at one rect).
let nativePreviewNativePresentConfirmedAtMs = 0
const NATIVE_PREVIEW_NATIVE_AUTHORITY_MS = 1500

function nativeSurfaceOwnsPlacement(): boolean {
  return Date.now() - nativePreviewNativePresentConfirmedAtMs < NATIVE_PREVIEW_NATIVE_AUTHORITY_MS
}

function clearNativePreviewNativePlacementAuthority(): void {
  nativePreviewNativePresentConfirmedAtMs = 0
}
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

// The platform-specific window chrome (translucency, frame, title-bar style).
// macOS is the reference glass expression below; off macOS we ship a solid
// themed base with the native frame in chrome v1 — no OS material or window
// transparency is wired yet (the frameless Windows glass is Phase 4).
function platformWindowChromeOptions(): BrowserWindowConstructorOptions {
  if (!isMac) {
    // Solid themed base so the 75%-alpha glass tokens don't composite over
    // default white; the standard native frame is guaranteed movable and
    // carries native min/max/close without renderer drag regions.
    return { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1C1C1F' : '#F5F5F7' }
  }

  return {
    // Glass shell. The reference translucency comes from the OS material —
    // CSS alone cannot blur the desktop behind the window — so under-window
    // vibrancy is the default and VIDEORC_GLASS_VIBRANCY=0 opts out to the
    // solid fallback. The 2026-06-12 wedge bisects implicated the synthetic
    // CDP palette keypress (reproduced without vibrancy too) and an explicit
    // transparent backgroundColor on reload (left unset here) — not the
    // material itself. The opt-out paints a theme-matched opaque base so the
    // 75%-alpha glass tokens don't composite over default white.
    // A transparent backing is REQUIRED for vibrancy: without it Chromium
    // paints an opaque layer in front of the material and no alpha in the CSS
    // can show the desktop through (verified with a material matrix probe).
    // And alpha in backgroundColor is only honored when the window is created
    // `transparent` — '#00000000' alone is silently opaque (Electron docs).
    // The working glass stack on this Electron/macOS combo (bisected with
    // ui-glass-bisect-probe): transparent window + alpha tokens, NO vibrancy.
    // The NSVisualEffectView materials paint fully OPAQUE here (dark and
    // light alike) and wall off the desktop that the transparent contents
    // would otherwise show. VIDEORC_GLASS_VIBRANCY=<material> re-adds the
    // material for experiments on stacks where it transmits; =0 opts out to
    // the solid themed base.
    ...(glassVibrancyEnabled
      ? {
          transparent: true,
          backgroundColor: '#00000000',
          ...(glassVibrancyRaw && glassVibrancyRaw !== '1'
            ? { vibrancy: glassVibrancyMaterial }
            : {})
        }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1C1C1F' : '#F5F5F7' }),
    visualEffectState: 'active',
    // Probe knob: which window frame the glass uses. hiddenInset keeps the
    // framed NSWindow; transparency may require the frameless styles.
    ...(process.env.VIDEORC_GLASS_FRAME === 'frameless'
      ? { frame: false as const }
      : {
          titleBarStyle: (process.env.VIDEORC_GLASS_FRAME === 'hidden'
            ? 'hidden'
            : 'hiddenInset') as 'hidden' | 'hiddenInset',
          trafficLightPosition: { x: 14, y: 13 }
        })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 660,
    title: 'Videorc',
    ...platformWindowChromeOptions(),
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Page-navigation shortcuts must be caught here, not in the renderer:
  // Chromium reserves ⌘1–⌘9 (tab switching) and ⌘0 (zoom) and never delivers
  // them to the page's keydown, so a document listener silently misses them.
  // before-input-event runs ahead of that handling; we preventDefault and
  // forward the raw key to the renderer, which owns the key→tab mapping.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.shift) {
      return
    }
    if (!(input.meta || input.control)) {
      return
    }
    const isDigit = input.key >= '1' && input.key <= '9'
    if (isDigit || input.key === ',') {
      event.preventDefault()
      mainWindow?.webContents.send('shortcut:navigate', input.key)
    }
  })

  mainWindow.on('closed', () => {
    destroyNativePreviewSurface()
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.close()
    }
    if (notesWindow && !notesWindow.isDestroyed()) {
      notesWindow.close()
    }
    if (commentsWindow && !commentsWindow.isDestroyed()) {
      commentsWindow.close()
    }
    mainWindow = null
  })

  if (glassWallpaperEnabled) {
    mainWindow.on('move', queueGlassGeometryBroadcast)
    mainWindow.on('resize', queueGlassGeometryBroadcast)
    // Wallpaper changes have no event; refresh on focus (cheap no-op when the
    // path is unchanged) and once the renderer is ready to receive it.
    mainWindow.on('focus', () => void refreshGlassWallpaper())
    mainWindow.webContents.once('did-finish-load', () => void refreshGlassWallpaper())
  }

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

  mainWindow.webContents.once('did-finish-load', () => {
    restorePreviewWindowOnLaunch()
    restoreNotesWindowOnLaunch()
    restoreCommentsWindowOnLaunch()
  })
}

// --- Detached preview window (UI rewrite U1) ---------------------------------
// The live preview is its own draggable/resizable window. Main owns its lifecycle
// and is the bounds AUTHORITY: every move/resize/visibility change is pushed
// directly to the native helper and Electron proof surface. The renderer still owns
// backend surface-session creation and teardown.
let previewWindow: BrowserWindow | null = null
let previewWindowLastFrame: Electron.Rectangle | null = null
let previewWindowAlwaysOnTop = false
let previewWindowClosing = false
const previewSupervisor = new PreviewSupervisorModel()
// The visible drag bar at the top of the preview window; the native video covers
// the content BELOW it, and the aspect lock applies to that video region only.
const PREVIEW_WINDOW_BAR_HEIGHT = 28
// Output aspect ratio (from the renderer's video settings); the window is locked
// to it so the preview can never be squeezed or stretched.
let previewWindowAspect = { width: 16, height: 9 }

function previewWindowAspectRatio(): number {
  return previewWindowAspect.width / Math.max(1, previewWindowAspect.height)
}

// Lock user resizing to the output ratio (the bar is excluded via extraSize) and
// conform the current frame so the video region matches the ratio exactly.
function applyPreviewWindowAspect(window: BrowserWindow): void {
  const ratio = previewWindowAspectRatio()
  window.setAspectRatio(ratio, { width: 0, height: PREVIEW_WINDOW_BAR_HEIGHT })
  window.setMinimumSize(320, Math.round(320 / ratio) + PREVIEW_WINDOW_BAR_HEIGHT)
  conformPreviewWindowToAspect(window)
}

// setAspectRatio only constrains USER drag-resizes; macOS tiling, third-party
// window managers, and programmatic setBounds all bypass it and can squeeze the
// window. This backstop runs on every resize: keep the width and re-derive the
// video height, falling back to height-derived width when that would overflow
// the display's work area. Guarded because setContentSize re-emits 'resize'.
let conformingPreviewWindow = false

function conformPreviewWindowToAspect(window: BrowserWindow): void {
  if (conformingPreviewWindow || window.isFullScreen()) {
    return
  }
  const ratio = previewWindowAspectRatio()
  const [contentWidth, contentHeight] = window.getContentSize()
  let width = contentWidth
  let height = Math.round(width / ratio) + PREVIEW_WINDOW_BAR_HEIGHT
  const workAreaHeight = screen.getDisplayMatching(window.getBounds()).workArea.height
  if (height > workAreaHeight) {
    height = workAreaHeight
    width = Math.round((height - PREVIEW_WINDOW_BAR_HEIGHT) * ratio)
  }
  if (Math.abs(height - contentHeight) <= 1 && Math.abs(width - contentWidth) <= 1) {
    return
  }
  conformingPreviewWindow = true
  try {
    window.setContentSize(width, height)
  } finally {
    conformingPreviewWindow = false
  }
}

// The preview window's GLOBAL window number (CGWindowID): valid across processes,
// so the native helper can order its surface directly above this window.
function previewWindowGlobalId(): number | undefined {
  const window = previewWindow
  if (!previewWindowIsOpenForSurface() || !window) {
    return undefined
  }
  const match = /^window:(\d+):/.exec(window.getMediaSourceId())
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(id) && id > 0 ? id : undefined
}

function previewWindowVideoBounds(window: BrowserWindow): Electron.Rectangle {
  const contentBounds = window.getContentBounds()
  return {
    x: contentBounds.x,
    y: contentBounds.y + PREVIEW_WINDOW_BAR_HEIGHT,
    width: contentBounds.width,
    height: Math.max(1, contentBounds.height - PREVIEW_WINDOW_BAR_HEIGHT)
  }
}

// Window frame, open/closed choice, and always-on-top survive relaunches (U3).
type PreviewWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  open?: boolean
}

function previewWindowPrefsPath(): string {
  return join(app.getPath('userData'), 'preview-window.json')
}

function loadPreviewWindowPrefs(): PreviewWindowPrefs {
  try {
    return JSON.parse(readFileSync(previewWindowPrefsPath(), 'utf8')) as PreviewWindowPrefs
  } catch {
    return {}
  }
}

function savePreviewWindowPrefs(patch: PreviewWindowPrefs): void {
  // Smoke and probe runs share the real userData dir; their window churn must
  // not overwrite the owner's remembered frame and open/closed choice.
  if (!previewWindowAutoRestoreEnabled) {
    return
  }
  try {
    writeFileSync(
      previewWindowPrefsPath(),
      JSON.stringify({ ...loadPreviewWindowPrefs(), ...patch })
    )
  } catch {
    // Preferences are a convenience; never let them break the preview itself.
  }
}

// A remembered frame can be off-screen (display unplugged, or the window was
// parked at an edge); restore it clamped into the nearest display's work area.
function clampFrameToWorkArea(frame: Electron.Rectangle): Electron.Rectangle {
  const workArea = screen.getDisplayMatching(frame).workArea
  const width = Math.min(frame.width, workArea.width)
  const height = Math.min(frame.height, workArea.height)
  return {
    width,
    height,
    x: Math.min(Math.max(frame.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(frame.y, workArea.y), workArea.y + workArea.height - height)
  }
}

// Smoke and probe runs drive the window explicitly; auto-restore would inject an
// unexpected window into their assertions.
const previewWindowAutoRestoreEnabled =
  process.env.VIDEORC_DISABLE_AUTO_PREVIEW !== '1' && !process.env.VIDEORC_SMOKE_OUTPUT_DIR

function restorePreviewWindowOnLaunch(): void {
  if (!previewWindowAutoRestoreEnabled) {
    return
  }
  const prefs = loadPreviewWindowPrefs()
  if (prefs.open !== false) {
    void openPreviewWindow()
  }
}

// --- Detached Notes window ----------------------------------------------------
type NotesWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  alwaysOnTopPreferenceVersion?: number
  open?: boolean
  text?: string
  fontScale?: NotesFontScale
}

function notesWindowPrefsPath(): string {
  return join(app.getPath('userData'), 'notes-window.json')
}

function loadNotesWindowPrefs(): NotesWindowPrefs {
  try {
    return JSON.parse(readFileSync(notesWindowPrefsPath(), 'utf8')) as NotesWindowPrefs
  } catch {
    return {}
  }
}

function saveNotesWindowPrefs(patch: NotesWindowPrefs): void {
  if (!notesWindowFeatureEnabled || process.env.VIDEORC_SMOKE_OUTPUT_DIR) {
    return
  }
  try {
    writeFileSync(notesWindowPrefsPath(), JSON.stringify({ ...loadNotesWindowPrefs(), ...patch }))
  } catch {
    // Local notes are a convenience; a failed preference write must not break capture.
  }
}

function defaultNotesDocument(prefs = loadNotesWindowPrefs()): NotesDocument {
  return {
    text: typeof prefs.text === 'string' ? prefs.text : '',
    fontScale: isNotesFontScale(prefs.fontScale) ? prefs.fontScale : 'md',
    updatedAt: new Date().toISOString()
  }
}

function notesWindowAlwaysOnTopPreference(prefs: NotesWindowPrefs): boolean {
  return prefs.alwaysOnTopPreferenceVersion === 2 && prefs.alwaysOnTop === true
}

function isNotesFontScale(value: unknown): value is NotesFontScale {
  return value === 'sm' || value === 'md' || value === 'lg'
}

function notesWindowIsOpen(): boolean {
  return Boolean(notesWindow && !notesWindow.isDestroyed() && !notesWindowClosing)
}

function notesWindowGlobalId(): number | undefined {
  const window = notesWindow
  if (!notesWindowIsOpen() || !window) {
    return undefined
  }
  const match = /^window:(\d+):/.exec(window.getMediaSourceId())
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(id) && id > 0 ? id : undefined
}

function applyNotesWindowAlwaysOnTop(window: BrowserWindow, alwaysOnTop: boolean): void {
  window.setAlwaysOnTop(alwaysOnTop, 'floating')
  if (isMac) {
    window.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: alwaysOnTop })
  }
  if (alwaysOnTop) {
    window.moveTop()
  }
}

function notesWindowState(message?: string): NotesWindowState {
  const window = notesWindow
  const open = notesWindowIsOpen()
  return {
    open,
    visible: open ? window!.isVisible() && !window!.isMinimized() : false,
    bounds: open ? window!.getBounds() : null,
    windowId: notesWindowGlobalId(),
    alwaysOnTop: notesWindowAlwaysOnTop,
    protected: notesWindowContentProtected,
    enabled: notesWindowFeatureEnabled,
    message:
      message ??
      (notesWindowFeatureEnabled
        ? undefined
        : 'Notes window is disabled by VIDEORC_NOTES_WINDOW=0.')
  }
}

function emitNotesWindowState(message?: string): void {
  if (appIsQuitting) {
    return
  }
  const state = notesWindowState(message)
  for (const window of [mainWindow, notesWindow]) {
    if (window && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send('notes-window:state', state)
      } catch (error) {
        if (!appIsQuitting) {
          safeConsole.warn('Notes window state emit failed:', error)
        }
      }
    }
  }
}

function emitNotesDocument(document: NotesDocument): void {
  if (appIsQuitting) {
    return
  }
  for (const window of [mainWindow, notesWindow]) {
    if (window && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send('notes-window:document', document)
      } catch (error) {
        if (!appIsQuitting) {
          safeConsole.warn('Notes document emit failed:', error)
        }
      }
    }
  }
}

function saveNotesDocument(patch: Partial<NotesDocument>): NotesDocument {
  const current = defaultNotesDocument()
  const next: NotesDocument = {
    text: typeof patch.text === 'string' ? patch.text : current.text,
    fontScale: isNotesFontScale(patch.fontScale) ? patch.fontScale : current.fontScale,
    updatedAt: new Date().toISOString()
  }
  saveNotesWindowPrefs({ text: next.text, fontScale: next.fontScale })
  emitNotesDocument(next)
  return next
}

function notesWindowHtml(document: NotesDocument): string {
  const initialDocumentJson = jsonForInlineScript(document)
  const initialAlwaysOnTopJson = jsonForInlineScript(notesWindowAlwaysOnTop)
  const smokeMarkerCss = notesWindowSmokeMarkerEnabled
    ? `
    body[data-smoke-marker="true"], body[data-smoke-marker="true"] textarea {
      background: #ff0000; color: #ffffff;
    }
    body[data-smoke-marker="true"] .drag-bar,
    body[data-smoke-marker="true"] .footer {
      background: #ff0000; color: #ffffff; border-color: #ff0000;
    }
    body[data-smoke-marker="true"] .title,
    body[data-smoke-marker="true"] .footer {
      color: #ffffff;
    }
    body[data-smoke-marker="true"] button {
      background: #ff0000; color: #ffffff; border-color: #ff0000;
    }
    body[data-smoke-marker="true"] textarea {
      font-size: 64px !important; line-height: 1.05; font-weight: 900;
      letter-spacing: 0; text-transform: uppercase;
    }`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; background: #101012; color: #f4f4f5;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden; user-select: none; -webkit-user-select: none; }
    body { display: flex; flex-direction: column; }
    .drag-bar { height: 34px; display: flex; align-items: center; gap: 10px;
      padding: 0 12px 0 78px; box-sizing: border-box; background: #18181b;
      border-bottom: 1px solid rgba(255,255,255,.08); -webkit-app-region: drag; }
    .title { color: #a1a1aa; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .spacer { flex: 1; }
    button { -webkit-app-region: no-drag; border: 1px solid rgba(255,255,255,.12);
      border-radius: 6px; background: rgba(255,255,255,.06); color: #e4e4e7;
      height: 22px; padding: 0 8px; font: inherit; font-size: 11px; cursor: default; }
    button[aria-pressed="true"] { background: #f4f4f5; color: #18181b; border-color: #f4f4f5; }
    .icon-button { width: 24px; padding: 0; display: inline-flex; align-items: center;
      justify-content: center; }
    .icon-button svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2;
      fill: none; stroke-linecap: round; stroke-linejoin: round; }
    textarea { flex: 1; resize: none; border: 0; outline: none; padding: 20px 22px;
      box-sizing: border-box; background: #101012; color: #f4f4f5; caret-color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45; -webkit-app-region: no-drag; }
    body[data-font-scale="sm"] textarea { font-size: 18px; }
    body[data-font-scale="md"] textarea { font-size: 24px; }
    body[data-font-scale="lg"] textarea { font-size: 32px; }
    textarea::placeholder { color: #71717a; }
    .footer { height: 28px; display: flex; align-items: center; gap: 12px; padding: 0 12px;
      border-top: 1px solid rgba(255,255,255,.08); color: #71717a; font-size: 11px; }
    ${smokeMarkerCss}
  </style></head><body data-smoke-marker="${notesWindowSmokeMarkerEnabled ? 'true' : 'false'}">
    <div class="drag-bar"><span class="title">Videorc Notes</span><span class="spacer"></span>
      <button type="button" class="icon-button" data-sticky aria-label="Keep notes in front of all apps" title="Keep notes in front of all apps" aria-pressed="false">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 17v5"></path>
          <path d="M5 17h14"></path>
          <path d="M17 9.5V5.7a2 2 0 0 0-.59-1.41l-.7-.7A2 2 0 0 0 14.3 3H9.7a2 2 0 0 0-1.41.59l-.7.7A2 2 0 0 0 7 5.7v3.8L5 12v2h14v-2z"></path>
        </svg>
      </button>
      <button type="button" data-scale="sm">Sm</button>
      <button type="button" data-scale="md">Md</button>
      <button type="button" data-scale="lg">Lg</button>
    </div>
    <textarea spellcheck="false" placeholder="Notes for this recording..."></textarea>
    <div class="footer"><span id="word-count">0 words</span><span id="save-state">Saved</span></div>
    <script>
      (() => {
        const initialDocument = ${initialDocumentJson};
        const initialAlwaysOnTop = ${initialAlwaysOnTopJson};
        const textarea = document.querySelector('textarea');
        const saveState = document.getElementById('save-state');
        const wordCount = document.getElementById('word-count');
        const buttons = Array.from(document.querySelectorAll('button[data-scale]'));
        const stickyButton = document.querySelector('button[data-sticky]');
        let fontScale = initialDocument.fontScale || 'md';
        let alwaysOnTop = Boolean(initialAlwaysOnTop);
        let saveTimer = null;

        textarea.value = initialDocument.text || '';
        document.body.dataset.fontScale = fontScale;

        function words(text) {
          const trimmed = text.trim();
          return trimmed ? trimmed.split(/\\s+/).length : 0;
        }

        function render() {
          wordCount.textContent = words(textarea.value) + ' words';
          for (const button of buttons) {
            button.setAttribute('aria-pressed', button.dataset.scale === fontScale ? 'true' : 'false');
          }
          if (stickyButton) {
            const title = alwaysOnTop ? 'Allow notes behind other apps' : 'Keep notes in front of all apps';
            stickyButton.setAttribute('aria-pressed', alwaysOnTop ? 'true' : 'false');
            stickyButton.setAttribute('aria-label', title);
            stickyButton.setAttribute('title', title);
          }
        }

        function applyNotesWindowState(state) {
          if (state && typeof state.alwaysOnTop === 'boolean') {
            alwaysOnTop = state.alwaysOnTop;
            render();
          }
        }

        function save() {
          window.clearTimeout(saveTimer);
          saveTimer = null;
          saveState.textContent = 'Saving';
          window.videorc?.saveNotesDocument?.({ text: textarea.value, fontScale })
            .then(() => { saveState.textContent = 'Saved'; })
            .catch(() => { saveState.textContent = 'Save failed'; });
        }

        function queueSave() {
          saveState.textContent = 'Unsaved';
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(save, 120);
        }

        textarea.addEventListener('input', () => {
          render();
          queueSave();
        });
        textarea.addEventListener('blur', save);
        textarea.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') textarea.blur();
        });
        stickyButton?.addEventListener('click', () => {
          if (!window.videorc?.setNotesWindowAlwaysOnTop) {
            saveState.textContent = 'Pin unavailable';
            return;
          }
          const next = !alwaysOnTop;
          alwaysOnTop = next;
          render();
          window.videorc.setNotesWindowAlwaysOnTop(next)
            .then(applyNotesWindowState)
            .catch(() => {
              alwaysOnTop = !next;
              render();
              saveState.textContent = 'Pin failed';
            });
          textarea.focus();
        });
        for (const button of buttons) {
          button.addEventListener('click', () => {
            fontScale = button.dataset.scale || 'md';
            document.body.dataset.fontScale = fontScale;
            render();
            queueSave();
            textarea.focus();
          });
        }
        const unsubscribeNotesWindowState = window.videorc?.onNotesWindowState?.(applyNotesWindowState);
        window.videorc?.getNotesWindowState?.().then(applyNotesWindowState).catch(() => {});
        window.addEventListener('beforeunload', () => {
          unsubscribeNotesWindowState?.();
          save();
        });
        window.__videorcNotesSnapshot = () => ({ text: textarea.value, fontScale });
        render();
        textarea.focus();
      })();
    </script>
  </body></html>`
}

async function openNotesWindow(): Promise<NotesWindowState> {
  if (!notesWindowFeatureEnabled) {
    return notesWindowState()
  }
  const existingWindow = notesWindow
  if (notesWindowIsOpen() && existingWindow) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.show()
    existingWindow.focus()
    emitNotesWindowState()
    return notesWindowState()
  }

  const prefs = loadNotesWindowPrefs()
  const rememberedFrame = notesWindowLastFrame ?? prefs.frame ?? null
  const frame = rememberedFrame ? clampFrameToWorkArea(rememberedFrame) : null
  const window = new BrowserWindow({
    width: frame?.width ?? 640,
    height: frame?.height ?? 420,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: 360,
    minHeight: 240,
    title: 'Videorc Notes',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#101012',
    show: false,
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  notesWindowClosing = false
  notesWindow = window
  notesWindowAlwaysOnTop = notesWindowAlwaysOnTopPreference(prefs)
  notesWindowContentProtected = false
  try {
    window.setContentProtection(true)
    notesWindowContentProtected = true
  } catch (error) {
    safeConsole.warn('Notes window content protection could not be enabled:', error)
  }
  if (notesWindowAlwaysOnTop) {
    applyNotesWindowAlwaysOnTop(window, true)
  }
  saveNotesWindowPrefs({ open: true })

  for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'focus'] as const) {
    window.on(event as 'move', () => {
      if (notesWindow === window) {
        emitNotesWindowState()
      }
    })
  }
  window.on('close', () => {
    if (notesWindow === window) {
      notesWindowClosing = true
      notesWindowLastFrame = window.getBounds()
      saveNotesWindowPrefs({ frame: notesWindowLastFrame, open: false })
      void window.webContents
        .executeJavaScript('window.__videorcNotesSnapshot?.() ?? null', true)
        .then((snapshot: Partial<NotesDocument> | null) => {
          if (snapshot) {
            saveNotesDocument(snapshot)
          }
        })
        .catch(() => {})
    }
  })
  window.on('closed', () => {
    if (notesWindow === window) {
      notesWindow = null
      notesWindowClosing = false
      notesWindowContentProtected = false
      emitNotesWindowState()
    }
  })

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(notesWindowHtml(defaultNotesDocument(prefs)))}`
  )
  window.show()
  window.focus()
  emitNotesWindowState()
  emitNotesDocument(defaultNotesDocument())
  return notesWindowState()
}

function closeNotesWindow(message?: string): NotesWindowState {
  if (notesWindow && !notesWindow.isDestroyed()) {
    notesWindowClosing = true
    notesWindow.close()
  }
  return notesWindowState(message)
}

function setNotesWindowAlwaysOnTop(alwaysOnTop: boolean): NotesWindowState {
  notesWindowAlwaysOnTop = alwaysOnTop
  if (notesWindow && !notesWindow.isDestroyed()) {
    applyNotesWindowAlwaysOnTop(notesWindow, alwaysOnTop)
  }
  saveNotesWindowPrefs({ alwaysOnTop, alwaysOnTopPreferenceVersion: 2 })
  emitNotesWindowState()
  return notesWindowState()
}

function restoreNotesWindowOnLaunch(): void {
  if (!notesWindowFeatureEnabled || !previewWindowAutoRestoreEnabled) {
    return
  }
  const prefs = loadNotesWindowPrefs()
  if (prefs.open === true) {
    void openNotesWindow()
  }
}

// --- Detached Comments window -------------------------------------------------
// A read-only live-chat reader in its own OS window (the comments plan's
// "detachable second-monitor chat window"), mirroring the Notes window. This
// slice (C1) is the shell + prefs; the React reader (C2) and live data relay
// (C3) arrive next. Plain window — no native surface, no content protection.
type CommentsWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  alwaysOnTopPreferenceVersion?: number
  open?: boolean
}

function commentsWindowPrefsPath(): string {
  return join(app.getPath('userData'), 'comments-window.json')
}

function loadCommentsWindowPrefs(): CommentsWindowPrefs {
  try {
    return JSON.parse(readFileSync(commentsWindowPrefsPath(), 'utf8')) as CommentsWindowPrefs
  } catch {
    return {}
  }
}

function saveCommentsWindowPrefs(patch: CommentsWindowPrefs): void {
  if (!commentsWindowFeatureEnabled || process.env.VIDEORC_SMOKE_OUTPUT_DIR) {
    return
  }
  try {
    writeFileSync(
      commentsWindowPrefsPath(),
      JSON.stringify({ ...loadCommentsWindowPrefs(), ...patch })
    )
  } catch {
    // A failed preference write must never break capture.
  }
}

function commentsWindowAlwaysOnTopPreference(prefs: CommentsWindowPrefs): boolean {
  return prefs.alwaysOnTopPreferenceVersion === 1 && prefs.alwaysOnTop === true
}

function commentsWindowIsOpen(): boolean {
  return Boolean(commentsWindow && !commentsWindow.isDestroyed() && !commentsWindowClosing)
}

function commentsWindowGlobalId(): number | undefined {
  const window = commentsWindow
  if (!commentsWindowIsOpen() || !window) {
    return undefined
  }
  const match = /^window:(\d+):/.exec(window.getMediaSourceId())
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(id) && id > 0 ? id : undefined
}

function commentsWindowState(message?: string): CommentsWindowState {
  const window = commentsWindow
  const open = commentsWindowIsOpen()
  return {
    open,
    visible: open ? window!.isVisible() && !window!.isMinimized() : false,
    bounds: open ? window!.getBounds() : null,
    windowId: commentsWindowGlobalId(),
    alwaysOnTop: commentsWindowAlwaysOnTop,
    enabled: commentsWindowFeatureEnabled,
    message:
      message ??
      (commentsWindowFeatureEnabled
        ? undefined
        : 'Comments window is disabled by VIDEORC_COMMENTS_WINDOW=0.')
  }
}

function emitCommentsWindowState(message?: string): void {
  if (appIsQuitting) {
    return
  }
  const state = commentsWindowState(message)
  for (const window of [mainWindow, commentsWindow]) {
    if (window && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send('comments-window:state', state)
      } catch (error) {
        if (!appIsQuitting) {
          safeConsole.warn('Comments window state emit failed:', error)
        }
      }
    }
  }
}

async function openCommentsWindow(): Promise<CommentsWindowState> {
  if (!commentsWindowFeatureEnabled) {
    return commentsWindowState()
  }
  const existingWindow = commentsWindow
  if (commentsWindowIsOpen() && existingWindow) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.show()
    existingWindow.focus()
    emitCommentsWindowState()
    return commentsWindowState()
  }

  const prefs = loadCommentsWindowPrefs()
  const rememberedFrame = commentsWindowLastFrame ?? prefs.frame ?? null
  const frame = rememberedFrame ? clampFrameToWorkArea(rememberedFrame) : null
  const window = new BrowserWindow({
    width: frame?.width ?? 420,
    height: frame?.height ?? 640,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: 320,
    minHeight: 360,
    title: 'Videorc Comments',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#101012',
    show: false,
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  commentsWindowClosing = false
  commentsWindow = window
  commentsWindowAlwaysOnTop = commentsWindowAlwaysOnTopPreference(prefs)
  if (commentsWindowAlwaysOnTop) {
    applyNotesWindowAlwaysOnTop(window, true)
  }
  saveCommentsWindowPrefs({ open: true })

  for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'focus'] as const) {
    window.on(event as 'move', () => {
      if (commentsWindow === window) {
        emitCommentsWindowState()
      }
    })
  }
  window.on('close', () => {
    if (commentsWindow === window) {
      commentsWindowClosing = true
      commentsWindowLastFrame = window.getBounds()
      saveCommentsWindowPrefs({ frame: commentsWindowLastFrame, open: false })
    }
  })
  window.on('closed', () => {
    if (commentsWindow === window) {
      commentsWindow = null
      commentsWindowClosing = false
      emitCommentsWindowState()
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    await window.loadURL(`${rendererUrl}/comments.html`)
  } else {
    await window.loadFile(join(__dirname, '../renderer/comments.html'))
  }
  window.show()
  window.focus()
  emitCommentsWindowState()
  return commentsWindowState()
}

function closeCommentsWindow(message?: string): CommentsWindowState {
  if (commentsWindow && !commentsWindow.isDestroyed()) {
    commentsWindowClosing = true
    commentsWindow.close()
  }
  return commentsWindowState(message)
}

async function toggleCommentsWindow(): Promise<CommentsWindowState> {
  if (commentsWindowIsOpen()) {
    return closeCommentsWindow()
  }
  return openCommentsWindow()
}

function setCommentsWindowAlwaysOnTop(alwaysOnTop: boolean): CommentsWindowState {
  commentsWindowAlwaysOnTop = alwaysOnTop
  if (commentsWindow && !commentsWindow.isDestroyed()) {
    applyNotesWindowAlwaysOnTop(commentsWindow, alwaysOnTop)
  }
  saveCommentsWindowPrefs({ alwaysOnTop, alwaysOnTopPreferenceVersion: 1 })
  emitCommentsWindowState()
  return commentsWindowState()
}

function restoreCommentsWindowOnLaunch(): void {
  if (!commentsWindowFeatureEnabled || !previewWindowAutoRestoreEnabled) {
    return
  }
  const prefs = loadCommentsWindowPrefs()
  if (prefs.open === true) {
    void openCommentsWindow()
  }
}

app.on('browser-window-focus', () => {
  void setNativePreviewSurfacesVisible(true)
})

function previewWindowIsOpenForSurface(): boolean {
  return Boolean(previewWindow && !previewWindow.isDestroyed() && !previewWindowClosing)
}

function previewWindowSurfaceGeneration(): number {
  return previewSupervisor.snapshot().generation
}

function previewWindowSurfaceGenerationIsCurrent(generation: number): boolean {
  return generation === previewWindowSurfaceGeneration()
}

function previewSurfacePresentationAllowed(generation = previewWindowSurfaceGeneration()): boolean {
  if (!previewWindowIsOpenForSurface() || !previewWindowSurfaceGenerationIsCurrent(generation)) {
    return false
  }
  const lifecycleState = previewSupervisor.snapshot().lifecycleState
  return (
    lifecycleState !== 'permission-required' &&
    lifecycleState !== 'closing' &&
    lifecycleState !== 'closed'
  )
}

type PreviewWindowState = {
  open: boolean
  visible: boolean
  contentBounds: Electron.Rectangle | null
  scaleFactor: number
  // Primary display height: the native helper needs it to flip top-left screen
  // coordinates into AppKit's bottom-left-origin global space.
  screenHeight: number
  alwaysOnTop: boolean
  supervisor: PreviewSupervisorState
}

function previewWindowState(): PreviewWindowState {
  const window = previewWindow
  const open = previewWindowIsOpenForSurface()
  // The VIDEO region: window content minus the drag bar. Everything downstream
  // (surface placement, probe asserts) follows this rect.
  const contentBounds = open ? previewWindowVideoBounds(window!) : null
  return {
    open,
    visible: open ? window!.isVisible() && !window!.isMinimized() : false,
    contentBounds,
    scaleFactor: contentBounds ? screen.getDisplayMatching(contentBounds).scaleFactor : 1,
    screenHeight: screen.getPrimaryDisplay().bounds.height,
    alwaysOnTop: previewWindowAlwaysOnTop,
    supervisor: previewSupervisor.snapshot()
  }
}

function previewWindowSurfaceBounds(visibleOverride?: boolean): PreviewSurfaceBounds | null {
  const state = previewWindowState()
  if (!state.open || !state.contentBounds) {
    return null
  }
  const contentBounds = state.contentBounds
  const visible = state.visible && (visibleOverride ?? true)
  return {
    screenX: contentBounds.x,
    screenY: contentBounds.y,
    width: contentBounds.width,
    height: contentBounds.height,
    scaleFactor: state.scaleFactor,
    screenHeight: state.screenHeight,
    visible
  }
}

function emitPreviewWindowState(): void {
  if (appIsQuitting) {
    return
  }
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send('preview-window:state', previewWindowState())
    } catch (error) {
      if (!appIsQuitting) {
        safeConsole.warn('Preview window state emit failed:', error)
      }
    }
  }
}

// Placement hot path: main applies the preview window's content rect to both
// surface hosts DIRECTLY — no renderer round trip. The renderer still owns the
// backend session lifecycle (create/destroy/suppression) off the same state
// events, but a delayed renderer must never leave the surface misplaced.
function pushPreviewWindowPlacement(): void {
  const bounds = previewWindowSurfaceBounds()
  if (!bounds) {
    return
  }
  const generation = previewWindowSurfaceGeneration()
  void runNativePreviewSurfaceMutation(() => {
    if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
      return nativePreviewSurfaceStatus
    }
    const surfaceExists = Boolean(
      nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()
    )
    return applyNativePreviewHostCommands(
      [{ kind: surfaceExists ? 'update-bounds' : 'create', bounds }],
      generation
    )
  }).catch((error) => {
    safeConsole.error('Preview window placement push failed:', error)
  })
}

function nativePreviewSurfaceWindowExists(): boolean {
  return Boolean(nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed())
}

function nativePreviewSurfaceNeedsPlacementReconcile(): boolean {
  if (!previewSurfacePresentationAllowed() || !previewWindowSurfaceBounds()) {
    return false
  }
  return (
    !nativePreviewSurfaceWindowExists() ||
    nativePreviewSurfaceStatus.state !== 'live' ||
    !nativePreviewSurfaceStatus.bounds
  )
}

async function reconcileNativePreviewSurfaceForPreviewWindow(
  options: { force?: boolean } = {}
): Promise<void> {
  const bounds = previewWindowSurfaceBounds()
  if (!bounds) {
    return
  }
  const generation = previewWindowSurfaceGeneration()
  if (!options.force && !nativePreviewSurfaceNeedsPlacementReconcile()) {
    return
  }
  await applyNativePreviewHostCommands(
    [{ kind: nativePreviewSurfaceWindowExists() ? 'update-bounds' : 'create', bounds }],
    generation
  )
}

const PREVIEW_WINDOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  /* The whole window is a drag surface: the native video floats above the area
     below the bar and ignores mouse events, so every grab lands here. The bar
     stays visible above the video as the obvious handle. Edge-resize is handled
     by the real window frame (hiddenInset) and is aspect-locked by main. */
  /* Glass tokens (videorc-design): the preview window frames video, so it
     stays dark in both themes — charcoal surface, white-8% hairline,
     tertiary-gray label. */
  html, body { margin: 0; height: 100%; background: #1c1c1f; color: #a1a1aa;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden;
    user-select: none; -webkit-user-select: none; -webkit-app-region: drag; }
  .drag-bar { position: fixed; top: 0; left: 0; right: 0; height: 28px;
    display: flex; align-items: center; gap: 10px; cursor: grab;
    padding: 0 12px 0 78px; /* traffic lights live in the left inset */
    background: rgba(24, 24, 27, 0.88); border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    box-sizing: border-box; }
  .drag-bar:active { cursor: grabbing; }
  .drag-bar .label { color: #71717a; font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; white-space: nowrap; }
  .drag-bar .grip { flex: 1; height: 8px; background-image:
    radial-gradient(circle, rgba(255, 255, 255, 0.18) 1px, transparent 1.2px);
    background-size: 6px 4px; background-position: center; }
  .hint { position: fixed; top: 28px; left: 0; right: 0; bottom: 0; display: flex;
    align-items: center; justify-content: center; flex-direction: column; gap: 6px; }
  .hint .title { color: #f4f4f5; font-size: 13px; }
</style></head><body>
  <div class="hint"><div class="title">Waiting for preview</div>
  <div>The native surface appears here as soon as the compositor presents.</div></div>
  <div class="drag-bar"><span class="label">Videorc Preview</span><span class="grip"></span></div>
</body></html>`

async function openPreviewWindow(): Promise<PreviewWindowState> {
  const existingWindow = previewWindow
  if (previewWindowIsOpenForSurface() && existingWindow) {
    previewSupervisor.setWindowVisible(true)
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.show()
    pushPreviewWindowPlacement()
    existingWindow.focus()
    emitPreviewWindowState()
    return previewWindowState()
  }

  previewSupervisor.openWindow()
  const prefs = loadPreviewWindowPrefs()
  const rememberedFrame = previewWindowLastFrame ?? prefs.frame ?? null
  const frame = rememberedFrame ? clampFrameToWorkArea(rememberedFrame) : null
  const window = new BrowserWindow({
    width: frame?.width ?? 960,
    height: frame?.height ?? 568,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: 320,
    minHeight: 208,
    title: 'Videorc Preview',
    // hiddenInset is macOS-only; off macOS the standard frame keeps the
    // preview window draggable without renderer drag regions (Phase 4 owns
    // the frameless Windows chrome).
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#09090b',
    show: true,
    ...appWindowIconOptions(),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  previewWindowClosing = false
  previewWindow = window
  previewSupervisor.windowOpened(window.isVisible() && !window.isMinimized())
  previewWindowAlwaysOnTop = prefs.alwaysOnTop === true
  if (previewWindowAlwaysOnTop) {
    window.setAlwaysOnTop(true, 'floating')
  }
  applyPreviewWindowAspect(window)
  savePreviewWindowPrefs({ open: true })

  // Re-conform first so any squeeze that escaped the user-resize aspect lock
  // (tiling, window managers, programmatic setBounds) is corrected before the
  // placement push below feeds bounds to the native surface.
  window.on('resize', () => {
    if (previewWindow === window) {
      conformPreviewWindowToAspect(window)
    }
  })
  // Every placement-affecting event re-feeds the bounds pipeline. macOS emits
  // 'move'/'resize' continuously during a drag, so the surface follows live.
  for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'focus'] as const) {
    window.on(event as 'move', () => {
      if (previewWindow === window) {
        previewSupervisor.setWindowVisible(window.isVisible() && !window.isMinimized())
        pushPreviewWindowPlacement()
        emitPreviewWindowState()
      }
    })
  }
  window.on('close', () => {
    if (previewWindow === window) {
      if (!previewWindowClosing) {
        previewSupervisor.closeWindow()
      }
      previewWindowClosing = true
      previewWindowLastFrame = window.getBounds()
      savePreviewWindowPrefs({ frame: previewWindowLastFrame, open: false })
    }
  })
  window.on('closed', () => {
    if (previewWindow === window) {
      previewWindow = null
      previewWindowClosing = false
      previewSupervisor.finishClose(previewWindowSurfaceGeneration())
      // Host teardown happens here, renderer-independent (the renderer's own
      // teardown adds the backend session destroy when its state event lands).
      void setNativePreviewSurfaceFramePollingSuppressed(true)
      void runNativePreviewSurfaceMutation(() =>
        applyNativePreviewHostCommands([{ kind: 'destroy' }])
      ).catch((error) => {
        safeConsole.error('Preview window close teardown failed:', error)
      })
      emitPreviewWindowState()
    }
  })

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PREVIEW_WINDOW_HTML)}`)
  } catch (error) {
    if (previewWindow !== window || window.isDestroyed() || previewWindowClosing) {
      return previewWindowState()
    }
    throw error
  }
  if (previewWindow !== window || window.isDestroyed() || previewWindowClosing) {
    return previewWindowState()
  }
  void setNativePreviewSurfaceFramePollingSuppressed(false)
  pushPreviewWindowPlacement()
  emitPreviewWindowState()
  return previewWindowState()
}

function closePreviewWindow(): PreviewWindowState {
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (!previewWindowClosing) {
      previewSupervisor.closeWindow()
    }
    previewWindowClosing = true
    previewWindow.close()
  }
  return previewWindowState()
}

function reportPreviewPermissionRequired(
  permissionStatus: Exclude<PreviewPermissionStatus, 'ok'>,
  message: string | undefined,
  generation = previewWindowSurfaceGeneration()
): PreviewWindowState {
  const state = previewSupervisor.permissionRequired({
    generation,
    permissionStatus,
    message
  })
  if (state.lifecycleState === 'permission-required' && state.generation === generation) {
    destroyNativePreviewSurfaceForBlockedPresentation(generation)
  }
  emitPreviewWindowState()
  return previewWindowState()
}

async function togglePreviewWindow(): Promise<PreviewWindowState> {
  if (previewWindowIsOpenForSurface()) {
    return closePreviewWindow()
  }
  return openPreviewWindow()
}

function setPreviewWindowAlwaysOnTop(alwaysOnTop: boolean): PreviewWindowState {
  previewWindowAlwaysOnTop = alwaysOnTop
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setAlwaysOnTop(alwaysOnTop, 'floating')
  }
  savePreviewWindowPrefs({ alwaysOnTop })
  // Keep the native surface in lockstep with the policy change immediately.
  void setNativePreviewSurfacesVisible(true)
  emitPreviewWindowState()
  return previewWindowState()
}

function idleNativePreviewSurfaceStatus(
  message = 'Native preview surface is not running.'
): PreviewSurfaceStatus {
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
  if (
    !nativePreviewFramePollingEnabled ||
    nativePreviewSurfaceFramePollingSuppressed ||
    !backendConnection
  ) {
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

function insetTransformForBackground(transform: SceneTransform): SceneTransform {
  const stageScale = 1 - PREVIEW_BACKGROUND_STAGE_MARGIN * 2
  return {
    ...transform,
    x: PREVIEW_BACKGROUND_STAGE_MARGIN + transform.x * stageScale,
    y: PREVIEW_BACKGROUND_STAGE_MARGIN + transform.y * stageScale,
    width: transform.width * stageScale,
    height: transform.height * stageScale
  }
}

function transformForPreviewBackground(
  transform: SceneTransform,
  backgroundActive: boolean
): SceneTransform {
  return backgroundActive ? insetTransformForBackground(transform) : transform
}

function previewBackgroundLayer(
  scene: PreviewSurfaceSceneUpdateParams['scene']
): PreviewSurfaceSceneLayer | null {
  const background = scene?.background
  const managedAssetPath = background?.managedAssetPath?.trim()
  if (!background || !managedAssetPath) {
    return null
  }

  return {
    id: `background:${background.assetId}`,
    name: 'Scene background',
    kind: 'background',
    transform: fullFrameTransform(),
    visible: true,
    imageUrl: fileUrlFromPath(managedAssetPath),
    fit: background.fit === 'fit' ? 'contain' : background.fit === 'stretch' ? 'fill' : 'cover',
    mirror: false
  }
}

function existingPreviewBackgroundLayer(): PreviewSurfaceSceneLayer | null {
  return (
    nativePreviewSurfaceScene?.sources.find(
      (layer) => layer.kind === 'background' && Boolean(layer.imageUrl)
    ) ?? null
  )
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
  return layout.layoutPreset === 'screen-camera' && layout.cameraShape === 'circle'
    ? 'circle'
    : 'rectangle'
}

// A floor on the requested full-canvas width so preview frames stay sharp even
// before the surface reports bounds (drawable would otherwise be undefined → the
// backend uses its low PNG default) or when a non-Retina scaleFactor understates
// the device pixels. Per-layer requests still scale by the layer's fraction of
// the canvas and stay capped at the source's real width.
const PREVIEW_MIN_DRAWABLE_WIDTH = 1280
// Upper bound on a single requested frame width so a large window on a 4K/5K
// Retina panel can't ask for an enormous PNG every poll. 1920 is plenty sharp
// for a preview; the backend clamps further (camera 1920 / screen 2560) and the
// per-source `sourceWidth` cap keeps us from ever upscaling past the real frame.
const PREVIEW_MAX_DRAWABLE_WIDTH = 1920
function previewDrawableWidth(): number {
  const bounds = nativePreviewSurfaceStatus.bounds
  const width = bounds?.width ?? nativePreviewSurfaceStatus.width
  const scaleFactor = bounds?.scaleFactor ?? 1
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return PREVIEW_MIN_DRAWABLE_WIDTH
  }
  return Math.max(width * Math.max(1, scaleFactor), PREVIEW_MIN_DRAWABLE_WIDTH)
}

function previewLayerSnapshotWidth(transform: SceneTransform, sourceWidth?: number): number {
  const drawableWidth = previewDrawableWidth()
  const layerWidth = Math.max(0.01, Number(transform.width || 1))
  const requestedWidth = Math.min(PREVIEW_MAX_DRAWABLE_WIDTH, Math.ceil(drawableWidth * layerWidth))
  return typeof sourceWidth === 'number' && Number.isFinite(sourceWidth)
    ? Math.min(sourceWidth, requestedWidth)
    : requestedWidth
}

// Diagnostic (env-gated): pin why a preview frame renders low-res. Enable with
// VIDEORC_DEBUG_PREVIEW=1 and read [videorc-preview-sizing] lines: drawable=none
// means bounds never reached the surface (backend falls back to its 640/960
// default → blocky); a scale of 1 on a Retina panel halves the effective res; a
// small maxWidth on a full-frame source means the layer fraction collapsed it.
const previewSizingDebugLast = new Map<string, string>()
function logPreviewFrameSizing(kind: string, maxWidth: number | undefined): void {
  if (process.env.VIDEORC_DEBUG_PREVIEW !== '1') {
    return
  }
  const bounds = nativePreviewSurfaceStatus.bounds
  const line = `kind=${kind} maxWidth=${maxWidth ?? 'default'} drawable=${previewDrawableWidth() ?? 'none'} boundsW=${bounds?.width ?? 'none'} scale=${bounds?.scaleFactor ?? 'none'}`
  if (previewSizingDebugLast.get(kind) === line) {
    return
  }
  previewSizingDebugLast.set(kind, line)
  console.log(`[videorc-preview-sizing] ${line}`)
}

function previewLayerFrameUrl(source: SceneSource): string | undefined {
  const maxWidth = previewLayerSnapshotWidth(source.transform)
  logPreviewFrameSizing(source.kind, maxWidth)
  if (source.kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/live.png', maxWidth)
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/live.png', maxWidth)
  }
  return undefined
}

function buildPreviewSurfaceScene(
  params: PreviewSurfaceSceneUpdateParams
): PreviewSurfaceSceneState {
  const backgroundLayer = previewBackgroundLayer(params.scene)
  const backgroundActive = Boolean(backgroundLayer)
  const layers: PreviewSurfaceSceneLayer[] = [
    ...(backgroundLayer ? [backgroundLayer] : []),
    ...(params.scene?.sources ?? []).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      transform: transformForPreviewBackground(source.transform, backgroundActive),
      visible: source.visible,
      frameUrl: nativePreviewSurfaceFramePollingSuppressed
        ? undefined
        : previewLayerFrameUrl(source),
      fit: previewLayerFit(source, params.layout),
      mirror: source.kind === 'camera' ? params.layout.cameraMirror : false,
      shape: previewLayerShape(source, params.layout)
    }))
  ]

  const activeScreen: StreamScreen | null | undefined = params.activeScreen
  if (activeScreen?.status === 'ready') {
    layers.push({
      id: `screen-image:${activeScreen.id}`,
      name: activeScreen.name,
      kind: 'screen-image',
      transform: transformForPreviewBackground(fullFrameTransform(), backgroundActive),
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
  const backgroundLayer = existingPreviewBackgroundLayer()
  const backgroundActive = Boolean(backgroundLayer)
  const layers: PreviewSurfaceSceneLayer[] = [
    ...(backgroundLayer ? [backgroundLayer] : []),
    ...(status.sceneSources ?? []).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      transform: transformForPreviewBackground(source.transform, backgroundActive),
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
  ]

  return {
    revision: status.sceneRevision,
    sceneId: status.sceneId,
    layout: status.sceneLayout,
    sources: layers,
    activeScreenId: status.activeScreenId,
    updatedAt: status.updatedAt
  }
}

function compositorLayerFrameUrl(
  source: CompositorStatus['sceneSources'][number]
): string | undefined {
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
        /* Child of the detached preview window: never a drag region, never a click target. */
        -webkit-app-region: no-drag;
        pointer-events: none;
        user-select: none;
        background:
          radial-gradient(circle at var(--dot-x, 10%) 50%, rgba(255, 255, 255, 0.42), transparent 20%),
          linear-gradient(135deg, rgba(29, 78, 216, 0.62), rgba(5, 150, 105, 0.58)),
          repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.28) 0 18px, rgba(17, 24, 39, 0.14) 18px var(--stripe-size));
        background-position: var(--offset, 0px) 0, 0 0, var(--stripe-offset, 0px) 0;
      }

      body.surface-live {
        /* Transparent while live: the layer imgs carry the pixels. A solid dark
           background here used to read as a black box whenever the imgs were not
           actually painting (e.g. frame polling suppressed by a native claim). */
        background: transparent;
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
              window.setTimeout(poll, 40);
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
              // ~25fps idle poll ceiling: trims idle CPU now that preview frames
              // render at a higher resolution (preview-sizing fix), while staying
              // visually smooth. Frame polling is suppressed entirely while
              // recording (the compositor surface takes over).
              window.setTimeout(poll, 40);
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
          element.style.zIndex = layer.kind === 'background' ? '0' : '1';

          const crop = cropStyle(transform);
          image.style.left = crop.left;
          image.style.top = crop.top;
          image.style.width = crop.width;
          image.style.height = crop.height;
          image.style.objectFit =
            layer.fit === 'cover' ? 'cover' : layer.fit === 'fill' ? 'fill' : 'contain';
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

// Placement for the Electron proof surface window in detached-preview mode. The
// native helper receives the same normalized rect plus stacking fields.
function surfaceWindowPlacement(bounds: PreviewSurfaceBounds): {
  visible: boolean
  rect: Electron.Rectangle
} {
  const normalized = normalizePreviewSurfaceBounds(bounds)
  return {
    visible: (normalized.visible ?? true) && normalized.width >= 1 && normalized.height >= 1,
    rect: {
      x: Math.round(normalized.screenX),
      y: Math.round(normalized.screenY),
      width: Math.max(1, Math.round(normalized.width)),
      height: Math.max(1, Math.round(normalized.height))
    }
  }
}

async function createNativePreviewSurfaceWindow(generation: number): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is not ready for native preview surface.')
    }
    if (!previewWindowIsOpenForSurface() || !previewWindowSurfaceGenerationIsCurrent(generation)) {
      return
    }

    const surfaceWindow = new BrowserWindow({
      // The fallback surface is a child of the preview window: it stacks above
      // it and moves with it like one app.
      parent: previewWindow ?? mainWindow,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      // Placement is owned by the preview window; the proof surface is never
      // user-movable and never a click target.
      movable: false,
      show: false,
      backgroundColor: '#00000000',
      ...appWindowIconOptions(),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    nativePreviewSurfaceWindow = surfaceWindow
    surfaceWindow.setIgnoreMouseEvents(true)
    surfaceWindow.on('closed', () => {
      if (nativePreviewSurfaceWindow === surfaceWindow) {
        nativePreviewSurfaceWindow = null
        nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
      }
    })

    try {
      if (
        !previewWindowIsOpenForSurface() ||
        !previewWindowSurfaceGenerationIsCurrent(generation)
      ) {
        if (nativePreviewSurfaceWindow === surfaceWindow) {
          nativePreviewSurfaceWindow = null
        }
        if (!surfaceWindow.isDestroyed()) {
          surfaceWindow.destroy()
        }
        return
      }
      await loadNativePreviewSurfaceHtml(surfaceWindow)
      if (
        !previewWindowIsOpenForSurface() ||
        !previewWindowSurfaceGenerationIsCurrent(generation)
      ) {
        if (nativePreviewSurfaceWindow === surfaceWindow) {
          nativePreviewSurfaceWindow = null
        }
        if (!surfaceWindow.isDestroyed()) {
          surfaceWindow.destroy()
        }
        return
      }
      if (nativePreviewSurfaceFramePollingSuppressed) {
        await waitForNativePreviewSurfaceScript(surfaceWindow)
        if (!surfaceWindow.isDestroyed() && previewWindowSurfaceGenerationIsCurrent(generation)) {
          await surfaceWindow.webContents.executeJavaScript(
            'window.__videorcSetFramePollingSuppressed?.(true)',
            true
          )
        }
      }
      if (nativePreviewSurfaceScene) {
        await waitForNativePreviewSurfaceScript(surfaceWindow)
        if (!surfaceWindow.isDestroyed() && previewWindowSurfaceGenerationIsCurrent(generation)) {
          await surfaceWindow.webContents.executeJavaScript(
            `window.__videorcSetPreviewScene?.(${jsonForInlineScript(nativePreviewSurfaceScene)})`,
            true
          )
        }
      }
      if (
        !previewWindowIsOpenForSurface() ||
        !previewWindowSurfaceGenerationIsCurrent(generation)
      ) {
        if (nativePreviewSurfaceWindow === surfaceWindow) {
          nativePreviewSurfaceWindow = null
        }
        if (!surfaceWindow.isDestroyed()) {
          surfaceWindow.destroy()
        }
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
      if (
        !previewWindowIsOpenForSurface() ||
        !previewWindowSurfaceGenerationIsCurrent(generation)
      ) {
        return
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

async function createNativePreviewSurface(
  bounds: PreviewSurfaceBounds,
  generation = previewWindowSurfaceGeneration()
): Promise<PreviewSurfaceStatus> {
  bounds = normalizePreviewSurfaceBounds(bounds)
  // The direct IPC path must not create a surface while the preview window is closed.
  if (!previewWindowIsOpenForSurface() || !previewWindowSurfaceGenerationIsCurrent(generation)) {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus('Preview window is closed.')
    return nativePreviewSurfaceStatus
  }
  if (!previewSurfacePresentationAllowed(generation)) {
    return destroyNativePreviewSurfaceForBlockedPresentation(generation)
  }
  if (!nativePreviewSurfaceProofEnabled) {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus(
      'Native preview surface proof mode is disabled.'
    )
    return nativePreviewSurfaceStatus
  }
  resetNativePreviewMainHandoffMetrics()
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not ready for native preview surface.')
  }

  previewSupervisor.requestSurface()
  if (!previewSurfacePresentationAllowed(generation)) {
    return destroyNativePreviewSurfaceForBlockedPresentation(generation)
  }
  const placement = surfaceWindowPlacement(bounds)
  const rect = placement.rect
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    await createNativePreviewSurfaceWindow(generation)
  }

  if (!previewWindowIsOpenForSurface() || !previewWindowSurfaceGenerationIsCurrent(generation)) {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus('Preview window is closed.')
    return nativePreviewSurfaceStatus
  }
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    throw new Error('Native preview surface window closed before it could be positioned.')
  }
  nativePreviewSurfaceWindow.setBounds(rect)
  if (placement.visible && !nativeSurfaceOwnsPlacement()) {
    nativePreviewSurfaceWindow.showInactive()
  } else if (!placement.visible) {
    nativePreviewSurfaceWindow.hide()
  }
  nativePreviewSurfaceStatus = {
    state: 'live',
    source: nativePreviewSurfaceScene?.sources.some(
      (source) => source.kind === 'screen' || source.kind === 'window'
    )
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
  previewSupervisor.surfaceFallback(
    generation,
    nativePreviewSurfaceStatus.message ?? 'Electron proof preview surface.'
  )
  return nativePreviewSurfaceStatus
}

async function updateNativePreviewSurfaceBounds(
  bounds: PreviewSurfaceBounds,
  generation = previewWindowSurfaceGeneration()
): Promise<PreviewSurfaceStatus> {
  bounds = normalizePreviewSurfaceBounds(bounds)
  if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
    return nativePreviewSurfaceStatus
  }
  if (!previewSurfacePresentationAllowed(generation)) {
    return destroyNativePreviewSurfaceForBlockedPresentation(generation)
  }
  if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.isDestroyed()) {
    // Never resurrect a torn-down surface just to hide it: after the detached
    // preview window closes (U2 teardown), the app-focus policy still pushes
    // hidden bounds, and recreating the proof window for them would undo the
    // teardown's whole point.
    if (!surfaceWindowPlacement(bounds).visible) {
      return nativePreviewSurfaceStatus
    }
    return createNativePreviewSurface(bounds, generation)
  }

  const placement = surfaceWindowPlacement(bounds)
  const rect = placement.rect
  nativePreviewSurfaceWindow.setBounds(rect)
  if (placement.visible && !nativeSurfaceOwnsPlacement()) {
    if (!nativePreviewSurfaceWindow.isVisible()) {
      nativePreviewSurfaceWindow.showInactive()
    }
  } else if (!placement.visible) {
    nativePreviewSurfaceWindow.hide()
  }
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

async function showNativePreviewProofSurfaceIfVisible(): Promise<void> {
  clearNativePreviewNativePlacementAuthority()
  if (
    !previewWindowIsOpenForSurface() ||
    !nativePreviewSurfaceWindow ||
    nativePreviewSurfaceWindow.isDestroyed()
  ) {
    return
  }
  const bounds = nativePreviewSurfaceStatus.bounds
  if (!bounds) {
    return
  }
  const placement = surfaceWindowPlacement(bounds)
  nativePreviewSurfaceWindow.setBounds(placement.rect)
  if (placement.visible && !nativePreviewSurfaceWindow.isVisible()) {
    nativePreviewSurfaceWindow.showInactive()
  }
}

async function applyNativePreviewHostCommands(
  commands: NativePreviewHostCommand[],
  generation = previewWindowSurfaceGeneration()
): Promise<PreviewSurfaceStatus> {
  if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
    return nativePreviewSurfaceStatus
  }
  // No preview window, no surface — period. A renderer holding a stale window
  // state (IPC events race the close) must not resurrect the hosts main just
  // tore down; only destroys pass while the window is closed.
  if (!previewWindowIsOpenForSurface()) {
    commands = commands.filter((command) => command.kind === 'destroy')
    if (commands.length === 0) {
      return nativePreviewSurfaceStatus
    }
  }
  if (!previewSurfacePresentationAllowed(generation)) {
    return destroyNativePreviewSurfaceForBlockedPresentation(generation)
  }
  // Every bounds command carries the Electron preview window's global number so
  // the native surface stacks as one app with it (normal level; floating only
  // when always-on-top is on).
  const orderAboveWindowId = previewWindowGlobalId()
  if (orderAboveWindowId !== undefined) {
    commands = commands.map((command) =>
      command.bounds
        ? {
            ...command,
            bounds: { ...command.bounds, orderAboveWindowId, elevated: previewWindowAlwaysOnTop }
          }
        : command
    )
  }
  await applyNativePreviewRealSurfaceHostCommands(commands)
  if (!previewWindowIsOpenForSurface()) {
    return destroyNativePreviewSurface(generation)
  }
  let status = nativePreviewSurfaceStatus
  for (const command of commands) {
    if (command.kind === 'destroy') {
      status = destroyNativePreviewSurface(generation)
      continue
    }

    if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
      return status
    }

    if (!command.bounds) {
      throw new Error(`Native preview host ${command.kind} command is missing bounds.`)
    }

    status =
      command.kind === 'create'
        ? await createNativePreviewSurface(command.bounds, generation)
        : await updateNativePreviewSurfaceBounds(command.bounds, generation)
  }
  return status
}

// Push a visibility-only bounds update to both surface hosts using the current
// detached preview-window rect.
async function setNativePreviewSurfacesVisible(visible: boolean): Promise<void> {
  const bounds = previewWindowSurfaceBounds(visible)
  if (!bounds) {
    return
  }
  const generation = previewWindowSurfaceGeneration()
  try {
    await runNativePreviewSurfaceMutation(() =>
      applyNativePreviewHostCommands([{ kind: 'update-bounds', bounds }], generation)
    )
  } catch {
    // Visibility policy is best-effort; the next preview-window event re-syncs.
  }
}

// Disable the real driver after a failure WITHOUT orphaning its NSWindow: the helper
// child is killed (taking the floating window with it) and the driver may resolve
// again after a cooldown instead of staying dead for the rest of the session.
function disableNativePreviewRealSurfaceDriver(reason: string): void {
  const driver = nativePreviewRealSurfaceDriver
  nativePreviewRealSurfaceDriver = null
  nativePreviewRealSurfaceDriverUnavailableReason = reason
  nativePreviewHelperProcessDriverResolved = false
  nativePreviewHelperDriverRetryAtMs = Date.now() + NATIVE_PREVIEW_HELPER_RETRY_COOLDOWN_MS
  try {
    driver?.stop?.()
  } catch {
    // The helper is already unreachable; nothing left to tear down.
  }
}

async function applyNativePreviewRealSurfaceHostCommands(
  commands: NativePreviewHostCommand[],
  options: { startIfNeeded?: boolean } = {}
): Promise<void> {
  const driver =
    options.startIfNeeded === false
      ? nativePreviewRealSurfaceDriver
      : ensureNativePreviewRealSurfaceDriver()
  if (!driver || commands.length === 0) {
    return
  }
  try {
    await driver.applyHostCommands(commands)
  } catch (error) {
    disableNativePreviewRealSurfaceDriver(
      `Real CAMetalLayer IOSurface presenter module failed while applying host commands: ${errorMessage(error)}`
    )
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

async function updateNativePreviewSurfaceScene(
  params: PreviewSurfaceSceneUpdateParams
): Promise<PreviewSurfaceStatus> {
  await waitForNativePreviewSurfaceMutation()
  nativePreviewSurfaceScene = buildPreviewSurfaceScene(params)
  await reconcileNativePreviewSurfaceForPreviewWindow({ force: true })
  const surfaceWindow = nativePreviewSurfaceWindow
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    const sceneJson = jsonForInlineScript(nativePreviewSurfaceScene)
    if (nativePreviewSurfaceWindow === surfaceWindow && !surfaceWindow.isDestroyed()) {
      await surfaceWindow.webContents.executeJavaScript(
        `window.__videorcSetPreviewScene?.(${sceneJson})`,
        true
      )
    }
  }
  if (!nativePreviewSurfaceFramePollingSuppressed) {
    await showNativePreviewProofSurfaceIfVisible()
  }

  const hasScreen = nativePreviewSurfaceScene.sources.some(
    (source) => source.kind === 'screen' || source.kind === 'window'
  )
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
  if (!previewSurfacePresentationAllowed()) {
    return destroyNativePreviewSurfaceForBlockedPresentation()
  }
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
  await reconcileNativePreviewSurfaceForPreviewWindow()
  const realSurfaceAttempt = await tryPresentNativePreviewRealSurfaceCompositor(
    effectiveStatus,
    mainTiming
  )
  if (realSurfaceAttempt.kind === 'presented') {
    nativePreviewLastRealSurfaceFallbackLogKey = undefined
    previewSupervisor.surfaceLive({
      generation: previewWindowSurfaceGeneration(),
      transport: realSurfaceAttempt.status.transport,
      backing: realSurfaceAttempt.status.backing
    })
    return realSurfaceAttempt.status
  }
  const fallbackLogKey = realSurfaceAttempt.logKey ?? realSurfaceAttempt.reason
  if (realSurfaceAttempt.reason && fallbackLogKey !== nativePreviewLastRealSurfaceFallbackLogKey) {
    nativePreviewLastRealSurfaceFallbackLogKey = fallbackLogKey
    logBackend('warn', realSurfaceAttempt.reason)
  }
  if (effectiveStatus.suppressFramePolling !== true) {
    await showNativePreviewProofSurfaceIfVisible()
  }
  let metrics: Record<string, unknown> | null = null
  const surfaceWindow = nativePreviewSurfaceWindow
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript(surfaceWindow)
    const sceneScript = compositorScene
      ? `window.__videorcSetPreviewScene?.(${jsonForInlineScript(compositorScene)});`
      : ''
    const statusJson = jsonForInlineScript(effectiveStatus)
    if (nativePreviewSurfaceWindow === surfaceWindow && !surfaceWindow.isDestroyed()) {
      await surfaceWindow.webContents.executeJavaScript(
        `${sceneScript}window.__videorcSetCompositorStatus?.(${statusJson})`,
        true
      )
      metrics = await readNativePreviewSurfaceMetricsAfterPaint()
    }
  }
  const hasScreen = nativePreviewSurfaceScene?.sources.some(
    (source) => source.kind === 'screen' || source.kind === 'window'
  )
  const hasCamera = nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'camera')
  const presentedFrameId = finiteMetric(metrics?.presentedCompositorFrame)
  const compositorFrameLag =
    finiteMetric(metrics?.compositorFrameLag) ?? (presentedFrameId === undefined ? undefined : 0)
  const droppedFrames =
    finiteMetric(metrics?.skippedCompositorFrames) ?? nativePreviewSurfaceStatus.droppedFrames ?? 0
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
    framesRendered: Math.max(
      nativePreviewSurfaceStatus.framesRendered,
      effectiveStatus.framesRendered,
      presentedFrameId ?? 0
    ),
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
    framePollingSuppressed:
      nativePreviewSurfaceFramePollingSuppressed || effectiveStatus.suppressFramePolling === true,
    sourcePixelsPresent: liveLayerCount > 0,
    updatedAt: new Date().toISOString(),
    message: proofSurfaceCompositorMessage(effectiveStatus, realSurfaceAttempt.reason)
  }
  previewSupervisor.surfaceFallback(
    previewWindowSurfaceGeneration(),
    nativePreviewSurfaceStatus.message ??
      realSurfaceAttempt.reason ??
      'Electron proof preview surface.'
  )
  return nativePreviewSurfaceStatus
}

type NativePreviewRealSurfacePresentAttempt =
  | { kind: 'presented'; status: PreviewSurfaceStatus }
  | { kind: 'skipped'; reason?: string; logKey?: string }

function compositorFrameSceneRevisionMismatch(
  status: PreviewSurfaceCompositorUpdateParams
): boolean {
  return (
    typeof status.sceneRevision === 'number' &&
    Number.isSafeInteger(status.sceneRevision) &&
    typeof status.frameSceneRevision === 'number' &&
    Number.isSafeInteger(status.frameSceneRevision) &&
    status.sceneRevision !== status.frameSceneRevision
  )
}

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
    const sceneRevisionMismatch = compositorFrameSceneRevisionMismatch(status)
    return {
      kind: 'skipped',
      reason: sceneRevisionMismatch
        ? `Native preview falling back to image polling: the compositor Metal IOSurface was rendered from scene revision ${status.frameSceneRevision}, but the active scene is ${status.sceneRevision}.`
        : hasMetalTarget
          ? `Native preview falling back to image polling: the compositor's Metal IOSurface target is older than the ${DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS}ms handoff budget (compose is too slow to stay live).`
          : `Native preview falling back to image polling: the compositor status carries no Metal IOSurface target (metalTargetIosurfaceId=${status.metalTargetIosurfaceId ?? 'absent'}), so there is nothing to present natively for this scene.`,
      logKey: `no-handoff:${sceneRevisionMismatch ? 'scene-revision' : hasMetalTarget ? 'stale' : 'absent'}`
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
      reason: realSurfaceUnavailableMessage(
        handoff,
        nativePreviewRealSurfaceDriverUnavailableReason
      ),
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
      suppressFramePolling:
        nativePreviewSurfaceFramePollingSuppressed || status.suppressFramePolling === true,
      frameAgeMs: status.frameAgeMs,
      compositorUpdatedAt: status.updatedAt
    })
  } catch (error) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    disableNativePreviewRealSurfaceDriver(
      `Real CAMetalLayer IOSurface presenter failed while presenting compositor handoff: ${errorMessage(error)}`
    )
    return {
      kind: 'skipped',
      reason: realSurfaceUnavailableMessage(
        handoff,
        nativePreviewRealSurfaceDriverUnavailableReason ?? 'unknown'
      ),
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
      nativePreviewRealSurfaceInvalidActivationCount >=
      NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD
    return {
      kind: 'skipped',
      reason: shouldReportInvalidActivation
        ? realSurfaceInvalidActivationMessage(handoff, driverStatus)
        : undefined,
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
    framePollingSuppressed:
      nativePreviewSurfaceFramePollingSuppressed || status.suppressFramePolling === true,
    updatedAt: new Date().toISOString()
  }
  // Single placement authority: while the native CAMetalLayer is confirmed
  // presenting, the Electron proof window must not stack beneath it (two surfaces at
  // one rect made every visual bug ambiguous). It may re-show on bounds updates once
  // the native path stops claiming presents (see surface create/update).
  nativePreviewNativePresentConfirmedAtMs = Date.now()
  if (
    nativePreviewSurfaceWindow &&
    !nativePreviewSurfaceWindow.isDestroyed() &&
    nativePreviewSurfaceWindow.isVisible()
  ) {
    nativePreviewSurfaceWindow.hide()
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
  const surfaceWindow = nativePreviewSurfaceWindow
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript(surfaceWindow)
    if (!surfaceWindow.isDestroyed() && nativePreviewSurfaceWindow === surfaceWindow) {
      await surfaceWindow.webContents.executeJavaScript(
        `window.__videorcSetFramePollingSuppressed?.(${suppressed ? 'true' : 'false'})`,
        true
      )
    }
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

async function readNativePreviewSurfaceMetricsAfterPaint(): Promise<Record<
  string,
  unknown
> | null> {
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

// The renderer hands main the backend's own per-frame compositor.status with
// every present, so it is usually milliseconds old. Re-fetching it over HTTP
// for EVERY present cost ~60 req/s of main+backend CPU for no freshness gain:
// the backend has no newer frame than the one it just emitted, and frame
// freshness is enforced at present time by the handoff age gate (250ms).
// Reuse the delivered status unless delivery itself lagged badly — the one
// case where a fetch can actually surface a newer frame.
const NATIVE_PREVIEW_STATUS_REUSE_MAX_AGE_MS = 100

async function refreshNativePreviewCompositorStatus(
  status: PreviewSurfaceCompositorUpdateParams
): Promise<PreviewSurfaceCompositorUpdateParams> {
  if (!backendConnection) {
    return {
      ...status,
      ...nativePreviewMainStatusRefreshFields(status)
    }
  }

  const deliveredAgeMs = nativePreviewCompositorStatusAgeMs(status)
  if (
    !compositorFrameSceneRevisionMismatch(status) &&
    typeof deliveredAgeMs === 'number' &&
    deliveredAgeMs <= NATIVE_PREVIEW_STATUS_REUSE_MAX_AGE_MS
  ) {
    recordNativePreviewStatusAgeSamples(status)
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
    nativePreviewRendererPollIntervalP95Ms: finiteMetric(
      status.nativePreviewRendererPollIntervalP95Ms
    ),
    nativePreviewRendererPollRoundTripP95Ms: finiteMetric(
      status.nativePreviewRendererPollRoundTripP95Ms
    ),
    nativePreviewRendererPresentRoundTripP95Ms: finiteMetric(
      status.nativePreviewRendererPresentRoundTripP95Ms
    ),
    nativePreviewRendererPollInFlightSkips: finiteMetric(
      status.nativePreviewRendererPollInFlightSkips
    )
  }
}

function recordNativePreviewMainHandoffMetrics(
  queueWaitMs: number,
  presentMs: number
): Partial<PreviewSurfaceStatus> {
  recordNativePreviewTimingSample(nativePreviewMainQueueWaitSamplesMs, queueWaitMs)
  recordNativePreviewTimingSample(nativePreviewMainPresentSamplesMs, presentMs)
  return {
    nativePreviewMainQueueWaitP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainQueueWaitSamplesMs,
      0.95
    ),
    nativePreviewMainPresentP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainPresentSamplesMs,
      0.95
    ),
    nativePreviewMainQueuedBehindCount
  }
}

function recordNativePreviewMainStatusRefresh(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus,
  fetchStartedAtMs: number,
  succeeded: boolean
): NativePreviewMainStatusRefreshFields {
  recordNativePreviewTimingSample(
    nativePreviewMainStatusFetchSamplesMs,
    Math.max(0, Date.now() - fetchStartedAtMs)
  )
  if (succeeded) {
    nativePreviewMainStatusFetchSuccesses += 1
  } else {
    nativePreviewMainStatusFetchFailures += 1
  }

  recordNativePreviewStatusAgeSamples(status)
  return nativePreviewMainStatusRefreshFields(status)
}

// Presented status/frame age feed the freshness gates; they must be recorded
// for reused statuses too, or a quiet fetch path would blind those gates.
function recordNativePreviewStatusAgeSamples(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus
): void {
  const statusAgeMs = nativePreviewCompositorStatusAgeMs(status)
  if (typeof statusAgeMs === 'number') {
    recordNativePreviewTimingSample(nativePreviewMainStatusAgeSamplesMs, statusAgeMs)
  }
  const frameAgeMs = finiteMetric(status.frameAgeMs)
  if (typeof frameAgeMs === 'number') {
    recordNativePreviewTimingSample(nativePreviewMainStatusFrameAgeSamplesMs, frameAgeMs)
  }
}

function nativePreviewMainStatusRefreshFields(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus
): NativePreviewMainStatusRefreshFields {
  return {
    nativePreviewMainStatusFetchP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainStatusFetchSamplesMs,
      0.95
    ),
    nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs: nativePreviewCompositorStatusAgeMs(status),
    nativePreviewMainPresentedStatusAgeP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainStatusAgeSamplesMs,
      0.95
    ),
    nativePreviewMainPresentedFrameAgeP95Ms: nativePreviewTimingPercentile(
      nativePreviewMainStatusFrameAgeSamplesMs,
      0.95
    )
  }
}

function nativePreviewCompositorStatusAgeMs(
  status: PreviewSurfaceCompositorUpdateParams | CompositorStatus
): number | undefined {
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

// Percentiles are consumed at the 250ms report cadence, but their inputs mutate
// per present; recomputing (copy + sort of up-to-900 samples, several ranks)
// for every present added up to hundreds of sorts per second. Cache per
// (samples array, rank) for the report interval; arrays are replaced wholesale
// on reset, so WeakMap entries fall away with them.
const NATIVE_PREVIEW_PERCENTILE_CACHE_TTL_MS = 250
const nativePreviewPercentileCache = new WeakMap<
  number[],
  Map<number, { value: number | undefined; computedAtMs: number }>
>()

function nativePreviewTimingPercentile(
  values: number[],
  percentileRank: number
): number | undefined {
  const nowMs = Date.now()
  let perRank = nativePreviewPercentileCache.get(values)
  const cached = perRank?.get(percentileRank)
  if (cached && nowMs - cached.computedAtMs < NATIVE_PREVIEW_PERCENTILE_CACHE_TTL_MS) {
    return cached.value
  }
  const value = computeTimingPercentile(values, percentileRank)
  if (!perRank) {
    perRank = new Map()
    nativePreviewPercentileCache.set(values, perRank)
  }
  perRank.set(percentileRank, { value, computedAtMs: nowMs })
  return value
}

function computeTimingPercentile(values: number[], percentileRank: number): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileRank) - 1)
  )
  return sorted[index]
}

async function waitForNativePreviewSurfaceScript(
  surfaceWindow: BrowserWindow | null = nativePreviewSurfaceWindow,
  timeoutMs = 5000
): Promise<void> {
  if (!surfaceWindow || surfaceWindow.isDestroyed()) {
    return
  }
  const deadline = Date.now() + timeoutMs
  let lastState: unknown = null
  while (Date.now() < deadline) {
    try {
      if (surfaceWindow.isDestroyed()) {
        return
      }
      lastState = await surfaceWindow.webContents.executeJavaScript(
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

function destroyNativePreviewSurface(
  generation = previewWindowSurfaceGeneration()
): PreviewSurfaceStatus {
  if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
    return nativePreviewSurfaceStatus
  }
  resetNativePreviewMainHandoffMetrics()
  nativePreviewSurfaceCompositorRequestSerial += 1
  clearNativePreviewNativePlacementAuthority()
  void applyNativePreviewRealSurfaceHostCommands([{ kind: 'destroy' }], { startIfNeeded: false })
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    nativePreviewSurfaceWindow.close()
  }
  nativePreviewSurfaceWindow = null
  nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
  return nativePreviewSurfaceStatus
}

function destroyNativePreviewSurfaceForBlockedPresentation(
  generation = previewWindowSurfaceGeneration()
): PreviewSurfaceStatus {
  nativePreviewSurfaceFramePollingSuppressed = true
  const status = destroyNativePreviewSurface(generation)
  nativePreviewSurfaceStatus = {
    ...status,
    framePollingSuppressed: true,
    sourcePixelsPresent: false,
    message: 'Native preview presentation is blocked by the current preview lifecycle state.'
  }
  return nativePreviewSurfaceStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function previewSurfaceGenerationFromIpc(generation: unknown): number {
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : previewWindowSurfaceGeneration()
}

function previewPermissionStatusFromIpc(
  permissionStatus: unknown
): Exclude<PreviewPermissionStatus, 'ok'> {
  return permissionStatus === 'screen-recording-required' ||
    permissionStatus === 'camera-required' ||
    permissionStatus === 'unknown'
    ? permissionStatus
    : 'unknown'
}

function ensureNativePreviewRealSurfaceDriver(): NativePreviewRealSurfaceDriver | null {
  if (nativePreviewRealSurfaceDriver) {
    return nativePreviewRealSurfaceDriver
  }
  if (configuredNativePreviewHostModulePath) {
    return null
  }
  if (nativePreviewHelperProcessDriverResolved || Date.now() < nativePreviewHelperDriverRetryAtMs) {
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
    ...devCargoEnvOverrides(),
    PATH: pathEntries.join(delimiter)
  }

  if (explicitHelperPath) {
    return {
      driver: createNativePreviewHelperProcessDriver({
        command: explicitHelperPath,
        cwd: root,
        env,
        onProcessStarted: recordOwnedProcess,
        onProcessExited: removeOwnedProcess,
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
        onProcessStarted: recordOwnedProcess,
        onProcessExited: removeOwnedProcess,
        onLog: logBackend
      })
    }
  }

  return {
    driver: createNativePreviewHelperProcessDriver({
      command: resolveCargoBinary(),
      args: [
        'run',
        '--quiet',
        '-p',
        'videorc-backend',
        '--bin',
        'native_preview_host_helper',
        '--'
      ],
      cwd: root,
      env,
      onProcessStarted: recordOwnedProcess,
      onProcessExited: removeOwnedProcess,
      onLog: logBackend
    })
  }
}

function resolveAppIcon(): NativeImage | null {
  if (appIcon !== undefined) {
    return appIcon
  }

  for (const iconPath of resolveAppIconPaths()) {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) {
      appIcon = image
      return appIcon
    }
  }
  appIcon = null
  return appIcon
}

function appWindowIconOptions(): { icon: NativeImage } | Record<string, never> {
  const icon = resolveAppIcon()
  return icon ? { icon } : {}
}

function resolveAppIconPaths(): string[] {
  const root = workspaceRoot()
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'videorc-logo.png'),
        join(process.resourcesPath, 'icon.icns'),
        join(process.resourcesPath, 'icon.png')
      ]
    : [
        resolve(root, 'apps/desktop/src/renderer/src/assets/videorc-logo.png'),
        resolve(root, 'apps/desktop/build-resources/icon.icns')
      ]

  return candidates.filter((path) => existsSync(path))
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

// Videorc targets Windows 11 only (build 22000+): it unlocks Mica/acrylic,
// mature Windows.Graphics.Capture, and per-monitor wallpaper for the glass
// underlay. The installer can't enforce an OS floor, so we check at startup.
// Returns true if the app should stop launching.
function enforceWindowsVersionFloor(): boolean {
  if (!isWindows) {
    return false
  }
  const build = Number.parseInt(release().split('.')[2] ?? '', 10)
  if (Number.isFinite(build) && build >= 22000) {
    return false
  }
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Windows 11 required',
    message: 'Videorc requires Windows 11 or newer.',
    detail: `This machine reports Windows build ${release()}. Videorc needs build 22000 (Windows 11) or later.`,
    buttons: ['Quit']
  })
  return true
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

function oauthCallbackRedirectUri(platform?: string): string | null {
  // null = the backend's loopback callback on its fixed OAuth port — the
  // default for EVERY provider. Google rejects custom schemes outright, and
  // X's consent page hangs on an infinite spinner when re-authorization
  // auto-approves and tries to launch videorc:// without a user gesture
  // (browsers block gestureless custom-protocol navigation). The app-protocol
  // path survives only as an explicit escape hatch for X portal registrations
  // that still lack the loopback callback URLs.
  if (platform === 'x' && process.env.VIDEORC_OAUTH_X_CALLBACK === 'app-protocol') {
    return OAUTH_APP_PROTOCOL_REDIRECT_URI
  }
  return null
}

function sendOAuthCallbackUrl(callbackUrl: string): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    pendingOAuthCallbackUrls.push(callbackUrl)
    return
  }

  mainWindow.webContents.send('oauth:callback-url', callbackUrl)
}

function flushOAuthCallbackUrls(): void {
  if (
    !mainWindow ||
    mainWindow.webContents.isDestroyed() ||
    pendingOAuthCallbackUrls.length === 0
  ) {
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

  // Both the platform OAuth callback (videorc://oauth/callback) and the product
  // account callback (videorc://account/callback) ride this one channel; the
  // renderer routes by hostname.
  if (
    parsed.protocol !== `${OAUTH_CALLBACK_PROTOCOL}:` ||
    !(
      (parsed.hostname === 'oauth' || parsed.hostname === 'account') &&
      parsed.pathname === '/callback'
    )
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

function processRegistry(): OwnedProcessRegistry {
  if (!ownedProcessRegistry) {
    ownedProcessRegistry = new OwnedProcessRegistry({
      ledgerPath: [
        globalOwnedProcessLedgerPath(app.getPath('appData'), app.getName()),
        ownedProcessLedgerPath(app.getPath('userData'), workspaceRoot())
      ]
    })
  }
  return ownedProcessRegistry
}

function withProcessRegistryLock<T>(operation: () => T): T {
  if (ownedProcessRegistryLockDepth > 0) {
    return operation()
  }

  const release = acquireOwnedProcessStartupLock({
    lockPath: ownedProcessStartupLockPath(app.getPath('appData'), app.getName())
  })
  ownedProcessRegistryLockDepth += 1
  try {
    return operation()
  } finally {
    ownedProcessRegistryLockDepth -= 1
    release()
  }
}

function recordOwnedProcess(pid: number, label: string): void {
  try {
    withProcessRegistryLock(() => processRegistry().record(pid, label))
  } catch (error) {
    logBackend('warn', `Could not record ${label} process ${pid}: ${errorMessage(error)}`)
  }
}

function removeOwnedProcess(pid: number): void {
  try {
    withProcessRegistryLock(() => processRegistry().remove(pid))
  } catch (error) {
    logBackend('warn', `Could not clear owned process ${pid}: ${errorMessage(error)}`)
  }
}

function validOwnedProcessPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

function validProcessPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

function shouldDisableBackendReap(): boolean {
  if (process.env.VIDEORC_DISABLE_BACKEND_REAP === '1') {
    return true
  }
  if (process.env.VIDEORC_DISABLE_BACKEND_REAP === '0') {
    return false
  }
  if (process.env.VIDEORC_APP_DATA_DIR?.trim()) {
    return false
  }
  return (
    Boolean(process.env.VIDEORC_SMOKE_OUTPUT_DIR) ||
    process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1'
  )
}

function recordBackendOwnedProcess(pid: unknown, label: string): void {
  if (!validOwnedProcessPid(pid)) {
    return
  }
  backendOwnedProcessPids.add(pid)
  recordOwnedProcess(pid, label)
}

function removeBackendOwnedProcesses(): void {
  for (const pid of backendOwnedProcessPids) {
    removeOwnedProcess(pid)
  }
  backendOwnedProcessPids.clear()
}

function recordBackendRuntimeProcess(connection: BackendConnection): void {
  if (!validOwnedProcessPid(connection.pid)) {
    return
  }
  recordBackendOwnedProcess(connection.pid, 'videorc-backend')
  const parent = validProcessPid(connection.parentPid) ? ` parentPid=${connection.parentPid}` : ''
  logBackend('info', `Backend runtime pid=${connection.pid}${parent}`)
}

function resolveCargoBinary(): string {
  const rustupCargo = join(homedir(), '.cargo', 'bin', 'cargo')
  return existsSync(rustupCargo) ? rustupCargo : 'cargo'
}

function devCargoEnvOverrides(): Record<string, string> {
  if (app.isPackaged) {
    return {}
  }

  return {
    CARGO_INCREMENTAL: '0'
  }
}

function resolvePackagedBackendBinary(): string {
  return join(
    process.resourcesPath,
    process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
  )
}

function resolveDevBackendBinary(root = workspaceRoot()): string {
  return join(
    root,
    'target',
    'debug',
    process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
  )
}

function resolveBackendPermissionTargetPath(): string {
  if (backendPermissionTargetPath) {
    return backendPermissionTargetPath
  }
  return app.isPackaged ? resolvePackagedBackendBinary() : resolveDevBackendBinary()
}

function resolvePackagedFfmpegBinDir(): string | null {
  if (!app.isPackaged) {
    return null
  }

  const binDir = join(process.resourcesPath, 'ffmpeg', 'bin')
  const binary = join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return existsSync(binary) ? binDir : null
}

// Single-backend policy: reap only children a previous Videorc launch recorded.
// Never scan command lines; substring process matching can kill cargo builds,
// editors, or unrelated processes.
function reapStaleBackendProcesses(): void {
  let stale: ReturnType<OwnedProcessRegistry['reapStale']>
  try {
    stale = withProcessRegistryLock(() =>
      processRegistry().reapStale({
        disabled: shouldDisableBackendReap()
      })
    )
  } catch (error) {
    logBackend('warn', `Could not reap stale owned backend processes: ${errorMessage(error)}`)
    return
  }
  if (stale.length > 0) {
    logBackend(
      'warn',
      `Reaping ${stale.length} stale owned backend process(es): ${stale.map((record) => `${record.label}:${record.pid}`).join(', ')}`
    )
  }
}

function startBackend(): void {
  if (backendProcess) {
    return
  }

  try {
    withProcessRegistryLock(() => startBackendWithRegistryLock())
  } catch (error) {
    logBackend('error', `Could not launch backend with exclusive ownership: ${errorMessage(error)}`)
  }
}

function startBackendWithRegistryLock(): void {
  if (backendProcess) {
    return
  }
  backendOwnedProcessPids = new Set()

  reapStaleBackendProcesses()

  const root = workspaceRoot()
  const cargoBinDir = join(homedir(), '.cargo', 'bin')
  const ffmpegBinDir = resolvePackagedFfmpegBinDir()
  const command = app.isPackaged ? resolvePackagedBackendBinary() : resolveCargoBinary()
  const args = app.isPackaged
    ? []
    : ['run', '--quiet', '-p', 'videorc-backend', '--bin', 'videorc-backend']
  backendPermissionTargetPath = app.isPackaged ? command : resolveDevBackendBinary(root)
  const pathEntries = [ffmpegBinDir, cargoBinDir, process.env.PATH].filter(Boolean)

  logBackend('info', `Launching backend from ${root}`)
  if (ffmpegBinDir) {
    logBackend('info', `Using bundled FFmpeg from ${ffmpegBinDir}`)
  }
  backendProcess = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...devCargoEnvOverrides(),
      PATH: pathEntries.join(delimiter),
      VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegBinDir ? join(ffmpegBinDir, 'ffmpeg') : '',
      // The backend's watchdog also exits when THIS process dies — the ppid
      // check alone misses the dev chain (electron -> cargo -> backend), where
      // killing Electron leaves cargo alive as the backend's parent.
      VIDEORC_SUPERVISOR_PID: String(process.pid),
      RUST_LOG: process.env.RUST_LOG ?? 'videorc_backend=info'
    }
  })
  const backendPid = backendProcess.pid
  recordBackendOwnedProcess(
    backendPid,
    app.isPackaged ? 'videorc-backend' : 'cargo-run-videorc-backend'
  )

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
    removeBackendOwnedProcesses()
    logBackend('warn', `Backend exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`)
    backendProcess = null
    backendConnection = null
    disconnectBackendEventSocket()
  })
}

// ---------------------------------------------------------------------------
// Main-process present pump. The renderer used to relay every 60Hz
// compositor.status over ipcRenderer.invoke into main's present queue; each
// round-trip stranded ~27KB of serialization buffers that V8 never felt
// (PartitionAlloc buffer partition grew ~2MB/s, multi-GB renderer RSS).
// Main now subscribes to the backend WebSocket itself and feeds its own
// queue, so the renderer is out of the per-frame path entirely. The renderer
// keeps its pump as an automatic fallback whenever this socket is down.
// ---------------------------------------------------------------------------
let backendEventSocket: WebSocket | null = null
let nativePreviewMainPumpActive = false
let backendEventSocketRetryTimer: ReturnType<typeof setTimeout> | null = null
let mainPresentReportLastSentAtMs = 0

function setNativePreviewMainPumpActive(active: boolean): void {
  if (nativePreviewMainPumpActive === active) {
    return
  }
  nativePreviewMainPumpActive = active
  sendToWindows('preview-surface:pump-mode', active)
}

function disconnectBackendEventSocket(): void {
  if (backendEventSocketRetryTimer) {
    clearTimeout(backendEventSocketRetryTimer)
    backendEventSocketRetryTimer = null
  }
  const socket = backendEventSocket
  backendEventSocket = null
  setNativePreviewMainPumpActive(false)
  if (socket) {
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
}

function connectBackendEventSocket(connection: BackendConnection): void {
  // Escape hatch: fall back to the renderer-driven present pump.
  if (process.env.VIDEORC_MAIN_PRESENT_PUMP === '0') {
    return
  }
  disconnectBackendEventSocket()
  const socket = new WebSocket(
    `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
  )
  backendEventSocket = socket
  socket.onopen = () => {
    if (backendEventSocket === socket) {
      logBackend('info', 'Main present pump connected to backend events.')
      setNativePreviewMainPumpActive(true)
    }
  }
  socket.onmessage = (event) => {
    if (backendEventSocket !== socket || typeof event.data !== 'string') {
      return
    }
    let parsed: { event?: string; payload?: unknown; id?: string }
    try {
      parsed = JSON.parse(event.data) as { event?: string; payload?: unknown; id?: string }
    } catch {
      return
    }
    // Responses to the fire-and-forget present reports also arrive here; only
    // the compositor frame events drive the pump.
    // Event-driven on purpose: new frames exist exactly when events arrive,
    // and re-presenting the same frame between clusters changes no pixels
    // (measured: it only aged statuses into fetch territory). Presented frame
    // age p95 is the content-freshness gate, and it IMPROVED vs the renderer
    // pump (57ms vs 77ms).
    if (parsed.event === 'compositor.status' && parsed.payload) {
      handleMainPumpCompositorStatus(parsed.payload as CompositorStatus)
    }
  }
  socket.onclose = () => {
    if (backendEventSocket !== socket) {
      return
    }
    backendEventSocket = null
    setNativePreviewMainPumpActive(false)
    // Transient close with the backend still up: retry; the renderer pump
    // covers presents in the meantime.
    if (backendConnection === connection) {
      backendEventSocketRetryTimer = setTimeout(() => {
        backendEventSocketRetryTimer = null
        if (backendConnection === connection) {
          connectBackendEventSocket(connection)
        }
      }, 2000)
    }
  }
  socket.onerror = () => {
    // onclose follows and owns the retry.
  }
}

function handleMainPumpCompositorStatus(status: CompositorStatus): void {
  // Same gate the renderer pump used: presents only while a surface session
  // is live (the preview window owns that lifecycle).
  if (!previewWindowIsOpenForSurface() || nativePreviewSurfaceStatus.state !== 'live') {
    return
  }
  if (compositorFrameSceneRevisionMismatch(status)) {
    return
  }
  const params: PreviewSurfaceCompositorUpdateParams = nativePreviewSurfaceFramePollingSuppressed
    ? { ...status, suppressFramePolling: true }
    : { ...status }
  void updateNativePreviewSurfaceCompositor(params)
    .then((surfaceStatus) => queueMainPresentReport(surfaceStatus))
    .catch((error) => {
      logBackend('warn', `Main present pump failed: ${errorMessageText(error)}`)
    })
}

// The 250ms-cadence present report keeps the backend's preview diagnostics
// (present fps, latency gates) fed now that the renderer no longer reports.
function queueMainPresentReport(status: PreviewSurfaceStatus): void {
  const socket = backendEventSocket
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return
  }
  const nowMs = Date.now()
  if (nowMs - mainPresentReportLastSentAtMs < 250) {
    return
  }
  mainPresentReportLastSentAtMs = nowMs
  const params = {
    transport: status.transport,
    backing: status.backing,
    presentedFrameId: status.presentedFrameId,
    compositorFrameLag: status.compositorFrameLag,
    droppedFrames: status.droppedFrames,
    inputToPresentLatencyMs: status.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms: status.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms: status.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms: status.inputToPresentLatencyP99Ms,
    presentFps: status.presentFps,
    intervalP95Ms: status.intervalP95Ms,
    intervalP99Ms: status.intervalP99Ms,
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
    sourcePixelsPresent: status.sourcePixelsPresent
  }
  try {
    socket.send(
      JSON.stringify({
        id: `main-present-report-${nowMs}`,
        method: 'preview.surface.present',
        params
      })
    )
  } catch {
    // Reports are best-effort diagnostics; the next present retries.
  }
}

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
        recordBackendRuntimeProcess(backendConnection)
        if (process.env.VIDEORC_SMOKE_PRINT_BACKEND_READY === '1') {
          safeConsole.log(`[smoke] backend-ready ${JSON.stringify(backendConnection)}`)
        }
        sendToWindows('backend:connection', backendConnection)
        connectBackendEventSocket(backendConnection)
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

  const logger =
    level === 'error' ? safeConsole.error : level === 'warn' ? safeConsole.warn : safeConsole.log
  logger(`[backend:${level}] ${message}`)
}

async function primeScreenCapturePermission(): Promise<void> {
  if (!isMac) {
    return
  }

  try {
    const info = runtimeInfo()
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (status === 'granted') {
      return
    }

    if (status === 'not-determined') {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
      const nextStatus = systemPreferences.getMediaAccessStatus('screen')
      logBackend(
        nextStatus === 'granted' ? 'info' : 'warn',
        `Screen Recording permission request resolved as ${nextStatus} for ${info.permissionTargetName}; capture runs in ${info.capturePermissionTargetName}.`
      )
      return
    }

    logBackend(
      'warn',
      `Screen Recording permission is ${status} for ${info.permissionTargetName}; capture runs in ${info.capturePermissionTargetName}. Open Screen Recording settings, grant access, then quit and relaunch Videorc.`
    )
  } catch (error) {
    logBackend('warn', `Could not request Screen Recording permission: ${errorMessage(error)}`)
  }
}

// Diagnostic tallies for probes: how chatty is main->renderer IPC really?
const sendToWindowsCounts = new Map<string, number>()

function sendToWindows(channel: string, ...args: unknown[]): void {
  sendToWindowsCounts.set(channel, (sendToWindowsCounts.get(channel) ?? 0) + 1)
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
      safeConsole.log(
        `[smoke] preview-motion-ready ${JSON.stringify({ host: address.address, port: address.port })}`
      )
    }
  })
}

async function handleSmokePreviewMotionRequest(
  request: IncomingMessage,
  response: HttpResponse
): Promise<void> {
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
      body.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>) : {}
    const result = await runSmokePreviewMotionCommand(command, params)
    writeSmokeJson(response, 200, { ok: true, result })
  } catch (error) {
    writeSmokeJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function runSmokePreviewMotionCommand(
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    throw new Error('Main window is not ready for preview motion smoke.')
  }

  if (command === 'resize-window') {
    const width = typeof params.width === 'number' ? params.width : 1180
    const height = typeof params.height === 'number' ? params.height : 780
    mainWindow.setSize(width, height)
    return mainWindow.getBounds()
  }

  if (command === 'move-window') {
    const x = typeof params.x === 'number' ? params.x : mainWindow.getBounds().x
    const y = typeof params.y === 'number' ? params.y : mainWindow.getBounds().y
    mainWindow.setPosition(x, y)
    return mainWindow.getBounds()
  }

  if (command === 'minimize-window') {
    mainWindow.minimize()
    return { minimized: mainWindow.isMinimized(), bounds: mainWindow.getBounds() }
  }

  if (command === 'restore-window') {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
    return { minimized: mainWindow.isMinimized(), bounds: mainWindow.getBounds() }
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

  if (command === 'exercise-native-preview-scene-background') {
    if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.webContents.isDestroyed()) {
      throw new Error('Native preview surface is not ready for background scene exercise.')
    }
    const params = smokePreviewSceneParams(11, 0.24, { background: true })
    await updateNativePreviewSurfaceScene(params)
    const finalStatus = smokeCompositorStatusFromSceneParams(params)
    const status = await updateNativePreviewSurfaceCompositor(finalStatus)
    const result = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      `window.__videorcSetCompositorStatus?.(${jsonForInlineScript(finalStatus)});window.__videorcPresentNativePreviewNow?.();(() => {
        const background = document.querySelector('[data-layer-id="background:builtin-bg-01"]');
        const screen = document.querySelector('[data-layer-id="source:test-pattern"]');
        const image = background?.querySelector('img');
        return {
          backgroundLayer: Boolean(background),
          backgroundLeft: background?.style.left ?? null,
          backgroundTop: background?.style.top ?? null,
          backgroundWidth: background?.style.width ?? null,
          backgroundHeight: background?.style.height ?? null,
          backgroundZIndex: background?.style.zIndex ?? null,
          backgroundObjectFit: image?.style.objectFit ?? null,
          screenLeft: screen?.style.left ?? null,
          screenTop: screen?.style.top ?? null,
          screenWidth: screen?.style.width ?? null,
          screenHeight: screen?.style.height ?? null,
          screenZIndex: screen?.style.zIndex ?? null,
          layerCount: document.querySelectorAll('.scene-layer').length
        };
      })()`,
      true
    )
    return {
      ...result,
      status
    }
  }

  if (command === 'exercise-native-preview-scene-after-surface-loss') {
    if (!previewWindowIsOpenForSurface()) {
      throw new Error('Preview window is not open for scene reattach exercise.')
    }
    destroyNativePreviewSurface()
    await delay(50)
    const fallbackStatus = smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(3, 0.74))
    const backendStatus = backendConnection
      ? await requestBackendJson<CompositorStatus>(
          `http://${backendConnection.host}:${backendConnection.port}/compositor/status?${new URLSearchParams({ token: backendConnection.token }).toString()}`
        ).catch(() => null)
      : null
    const finalStatus: PreviewSurfaceCompositorUpdateParams =
      backendStatus?.state === 'live' ? backendStatus : fallbackStatus
    const finalScene = buildPreviewSurfaceSceneFromCompositorStatus(finalStatus)
    const startedAt = performance.now()
    const status = await updateNativePreviewSurfaceCompositor(finalStatus)
    const surfaceWindow = nativePreviewSurfaceWindow
    let metrics: Record<string, unknown> | null = null
    if (surfaceWindow && !surfaceWindow.isDestroyed()) {
      await waitForNativePreviewSurfaceScript()
      const sceneScript = finalScene
        ? `window.__videorcSetPreviewScene?.(${jsonForInlineScript(finalScene)});`
        : ''
      const statusScript = `window.__videorcSetCompositorStatus?.(${jsonForInlineScript(finalStatus)});`
      metrics = await surfaceWindow.webContents.executeJavaScript(
        `${sceneScript}${statusScript}window.__videorcPresentNativePreviewNow?.();window.__videorcNativePreviewMetrics?.() ?? null`,
        true
      )
    }
    return {
      previewWindowOpen: previewWindowIsOpenForSurface(),
      surfaceExists: Boolean(surfaceWindow && !surfaceWindow.isDestroyed()),
      surfaceVisible: Boolean(
        surfaceWindow && !surfaceWindow.isDestroyed() && surfaceWindow.isVisible()
      ),
      nativeOwnsPlacement: nativeSurfaceOwnsPlacement(),
      status,
      targetSceneRevision:
        typeof finalStatus.sceneRevision === 'number' ? finalStatus.sceneRevision : null,
      sceneRevision: nativePreviewSurfaceScene?.revision ?? null,
      compositorSceneRevision:
        typeof metrics?.compositorSceneRevision === 'number'
          ? metrics.compositorSceneRevision
          : null,
      sceneMatchesCompositor: metrics?.sceneMatchesCompositor ?? null,
      layerCount: typeof metrics?.layerCount === 'number' ? metrics.layerCount : null,
      updateLatencyMs: performance.now() - startedAt
    }
  }

  if (command === 'measure-native-preview-surface') {
    if (!nativePreviewSurfaceWindow || nativePreviewSurfaceWindow.webContents.isDestroyed()) {
      throw new Error('Native preview surface is not ready for measurement.')
    }
    const durationMs = typeof params.durationMs === 'number' ? params.durationMs : 2500
    resetNativePreviewMainHandoffMetrics()
    nativePreviewRealSurfaceDriver?.resetMetrics?.()
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
      compositorFrameLag:
        finiteMetric(metrics.compositorFrameLag) ??
        (presentedFrameId === undefined ? undefined : 0),
      droppedFrames:
        finiteMetric(metrics.skippedCompositorFrames) ??
        nativePreviewSurfaceStatus.droppedFrames ??
        0,
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
    const generation = previewSurfaceGenerationFromIpc(params.generation)
    return runNativePreviewSurfaceMutation(() =>
      applyNativePreviewHostCommands(params.commands as NativePreviewHostCommand[], generation)
    )
  }

  if (command === 'proof-window-state') {
    const window = nativePreviewSurfaceWindow
    return {
      exists: Boolean(window && !window.isDestroyed()),
      visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
      bounds: window && !window.isDestroyed() ? window.getBounds() : null,
      nativeOwnsPlacement: nativeSurfaceOwnsPlacement(),
      nativePresentConfirmedAtMs: nativePreviewNativePresentConfirmedAtMs,
      realDriverActive: Boolean(nativePreviewRealSurfaceDriver),
      realDriverUnavailableReason: nativePreviewRealSurfaceDriverUnavailableReason ?? null
    }
  }

  if (command === 'preview-window-open') {
    return openPreviewWindow()
  }

  if (command === 'preview-window-close') {
    return closePreviewWindow()
  }

  if (command === 'preview-window-os-close') {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.close()
    }
    return previewWindowState()
  }

  if (command === 'preview-window-toggle') {
    return togglePreviewWindow()
  }

  if (command === 'preview-window-report-permission-required') {
    return reportPreviewPermissionRequired(
      previewPermissionStatusFromIpc(params.permissionStatus),
      typeof params.message === 'string' ? params.message : undefined,
      previewSurfaceGenerationFromIpc(params.generation)
    )
  }

  if (command === 'preview-window-set-bounds') {
    if (!previewWindow || previewWindow.isDestroyed()) {
      throw new Error('Preview window is not open.')
    }
    const current = previewWindow.getBounds()
    previewWindow.setBounds({
      x: typeof params.x === 'number' ? params.x : current.x,
      y: typeof params.y === 'number' ? params.y : current.y,
      width: typeof params.width === 'number' ? params.width : current.width,
      height: typeof params.height === 'number' ? params.height : current.height
    })
    // macOS does not reliably emit 'move' for programmatic position-only
    // setBounds, so push placement and state explicitly.
    pushPreviewWindowPlacement()
    emitPreviewWindowState()
    return previewWindowState()
  }

  if (command === 'preview-window-state') {
    const surface = nativePreviewSurfaceWindow
    return {
      ...previewWindowState(),
      surface: {
        exists: Boolean(surface && !surface.isDestroyed()),
        visible: Boolean(surface && !surface.isDestroyed() && surface.isVisible()),
        bounds: surface && !surface.isDestroyed() ? surface.getBounds() : null
      },
      nativeOwnsPlacement: nativeSurfaceOwnsPlacement(),
      framePollingSuppressedFlag: nativePreviewSurfaceFramePollingSuppressed,
      surfaceStatus: {
        state: nativePreviewSurfaceStatus.state,
        transport: nativePreviewSurfaceStatus.transport,
        framePollingSuppressed: nativePreviewSurfaceStatus.framePollingSuppressed
      }
    }
  }

  if (command === 'notes-window-open') {
    return openNotesWindow()
  }

  if (command === 'notes-window-close') {
    return closeNotesWindow()
  }

  if (command === 'notes-window-set-bounds') {
    const window = notesWindow
    if (!notesWindowIsOpen() || !window) {
      return notesWindowState('Notes window is not open.')
    }
    const current = window.getBounds()
    window.setBounds({
      x: typeof params.x === 'number' ? params.x : current.x,
      y: typeof params.y === 'number' ? params.y : current.y,
      width: typeof params.width === 'number' ? params.width : current.width,
      height: typeof params.height === 'number' ? params.height : current.height
    })
    window.show()
    emitNotesWindowState()
    return notesWindowState()
  }

  if (command === 'notes-window-state') {
    return notesWindowState()
  }

  if (command === 'comments-window-open') {
    return openCommentsWindow()
  }

  if (command === 'comments-window-close') {
    return closeCommentsWindow()
  }

  if (command === 'comments-window-toggle') {
    return toggleCommentsWindow()
  }

  if (command === 'comments-window-set-bounds') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      return commentsWindowState('Comments window is not open.')
    }
    const current = window.getBounds()
    window.setBounds({
      x: typeof params.x === 'number' ? params.x : current.x,
      y: typeof params.y === 'number' ? params.y : current.y,
      width: typeof params.width === 'number' ? params.width : current.width,
      height: typeof params.height === 'number' ? params.height : current.height
    })
    window.show()
    emitCommentsWindowState()
    return commentsWindowState()
  }

  if (command === 'comments-window-state') {
    return commentsWindowState()
  }

  if (command === 'notes-window-save-document') {
    return saveNotesDocument({
      text: typeof params.text === 'string' ? params.text : undefined,
      fontScale: isNotesFontScale(params.fontScale) ? params.fontScale : undefined
    })
  }

  if (command === 'native-preview-surface-status') {
    return nativePreviewSurfaceStatus
  }

  if (command === 'preview-surface-scene-state') {
    return {
      sceneRevision: nativePreviewSurfaceScene?.revision ?? null,
      layoutPreset: nativePreviewSurfaceScene?.layout.layoutPreset ?? null,
      sourceIds: nativePreviewSurfaceScene?.sources.map((source) => source.id) ?? [],
      visibleSourceIds:
        nativePreviewSurfaceScene?.sources
          .filter((source) => source.visible)
          .map((source) => source.id) ?? [],
      proofWindowVisible: Boolean(
        nativePreviewSurfaceWindow &&
        !nativePreviewSurfaceWindow.isDestroyed() &&
        nativePreviewSurfaceWindow.isVisible()
      ),
      surfaceStatus: nativePreviewSurfaceStatus
    }
  }

  if (command === 'capture-page') {
    const image = await mainWindow.webContents.capturePage()
    const name = typeof params.name === 'string' ? params.name.replace(/[^a-z0-9-]/gi, '') : 'page'
    const directory = process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? app.getPath('temp')
    const file = join(directory, `videorc-ui-${name}.png`)
    writeFileSync(file, image.toPNG())
    return { file }
  }

  if (command === 'ipc-send-counts') {
    return Object.fromEntries(sendToWindowsCounts)
  }

  // The CGWindowID of the main window, for probes that need a REAL composited
  // screenshot (capturePage excludes the OS vibrancy layer; `screencapture -l`
  // includes it).
  if (command === 'main-window-id') {
    const match = /^window:(\d+):/.exec(mainWindow.getMediaSourceId())
    return { windowId: match ? Number(match[1]) : null, bounds: mainWindow.getBounds() }
  }

  // Glass tuning: swap the macOS vibrancy material live so a probe can shoot
  // a composited material × token-alpha matrix without relaunching per cell.
  if (command === 'set-vibrancy') {
    const material = typeof params.material === 'string' ? params.material : null
    mainWindow.setVibrancy((material as Parameters<BrowserWindow['setVibrancy']>[0]) ?? null)
    return { material }
  }

  // Glass bisect: sample the renderer's OWN output alpha. capturePage sees the
  // web contents before macOS compositing — alpha < 255 here means the page is
  // transparent and any on-screen opacity comes from the window/material side;
  // alpha = 255 means Chromium never engaged transparency at all.
  if (command === 'capture-page-alpha') {
    const image = await mainWindow.webContents.capturePage()
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const sample = (x: number, y: number): Record<string, number> => {
      const index = (y * size.width + x) * 4
      return { b: bitmap[index], g: bitmap[index + 1], r: bitmap[index + 2], a: bitmap[index + 3] }
    }
    return {
      size,
      topLeft: sample(8, 8),
      center: sample(Math.floor(size.width / 2), Math.floor(size.height / 2)),
      bottomRight: sample(size.width - 8, size.height - 8)
    }
  }

  // Glass tuning: a deliberately loud backdrop window behind the main window
  // so composited captures can SHOW how much desktop the glass passes —
  // dark-on-dark shots cannot distinguish translucent from solid.
  if (command === 'open-backdrop-window') {
    const area = screen.getPrimaryDisplay().workArea
    const backdrop = new BrowserWindow({
      ...area,
      frame: false,
      webPreferences: { sandbox: true }
    })
    await backdrop.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="margin:0;height:100vh;background:linear-gradient(90deg,#ffffff 0 30%,#ff8a00 30% 50%,#2f6bff 50% 70%,#ffffff 70%);font:700 80px -apple-system;color:#000;overflow:hidden">BACKDROP BACKDROP BACKDROP BACKDROP</body>'
        )
    )
    mainWindow.moveTop()
    mainWindow.focus()
    return { opened: true }
  }

  // Wedge research: candidate levers for recovering frame production after a
  // reload wedges the transparent-backed window. The probe tries each and
  // shoots the result; the winning lever gets wired into the reload path.
  if (command === 'heal-main-window') {
    const lever = typeof params.lever === 'string' ? params.lever : 'invalidate'
    if (lever === 'invalidate') {
      mainWindow.webContents.invalidate()
    } else if (lever === 'background-jiggle') {
      mainWindow.setBackgroundColor('#01000000')
      mainWindow.setBackgroundColor('#00000000')
    } else if (lever === 'hide-show') {
      mainWindow.hide()
      mainWindow.show()
    } else if (lever === 'hide') {
      mainWindow.hide()
    } else if (lever === 'show') {
      mainWindow.show()
    } else if (lever === 'resize-jiggle') {
      const bounds = mainWindow.getBounds()
      mainWindow.setBounds({ ...bounds, width: bounds.width + 1 })
      mainWindow.setBounds(bounds)
    } else if (lever === 'nudge') {
      // Probe utility: a real window move, for geometry-tracking checks.
      const bounds = mainWindow.getBounds()
      mainWindow.setBounds({ ...bounds, x: bounds.x + 120, y: bounds.y + 60 })
    } else if (lever === 'revibrancy') {
      mainWindow.setVibrancy(null)
      mainWindow.setVibrancy(glassVibrancyMaterial)
    }
    return { lever }
  }

  // Leak bisection: replace the main window's content with about:blank (the
  // preload still loads). Growth that survives this is platform-level, not
  // app code. Probe-only; the window needs a reload to recover the app.
  if (command === 'blank-main-window') {
    await mainWindow.loadURL('about:blank')
    return { blanked: true }
  }

  // Allocator-level memory attribution (PartitionAlloc/V8/mojo/cc per process)
  // via Chromium memory-infra dumps — the only window into renderer memory
  // that lives OUTSIDE the V8 heap. Probes diff two dumps to find leaks.
  if (command === 'memory-infra-dump') {
    const seconds = typeof params.seconds === 'number' ? Math.min(20, params.seconds) : 6
    await contentTracing.startRecording({
      included_categories: ['disabled-by-default-memory-infra'],
      excluded_categories: ['*'],
      // memory_dump_config rides through as part of the trace config object.
      ...({
        memory_dump_config: {
          triggers: [{ mode: 'detailed', periodic_interval_ms: 2000 }]
        }
      } as object)
    })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, seconds * 1000))
    const directory = process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? app.getPath('temp')
    const file = join(directory, `videorc-memory-infra-${Date.now()}.json`)
    await contentTracing.stopRecording(file)
    // Map renderer pids to the windows they host so probes can name WHICH
    // renderer's allocators grow.
    const windows: Record<string, number> = {}
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      windows['main-window'] = mainWindow.webContents.getOSProcessId()
    }
    if (previewWindow && !previewWindow.isDestroyed()) {
      windows['preview-window'] = previewWindow.webContents.getOSProcessId()
    }
    if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
      windows['proof-surface'] = nativePreviewSurfaceWindow.webContents.getOSProcessId()
    }
    return { file, windows }
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
    compositorState: status.state,
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

function smokePreviewSceneParams(
  revision: number,
  cameraX: number,
  options: { background?: boolean } = {}
): PreviewSurfaceSceneUpdateParams {
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
  const backgroundAsset = bundledBackgroundAssets()[0]
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
      ],
      background:
        options.background && backgroundAsset
          ? {
              assetId: backgroundAsset.id,
              managedAssetPath: backgroundAsset.assetPath,
              fit: 'fill',
              scale: 100,
              offsetX: 0,
              offsetY: 0,
              blurPx: 0,
              dimPercent: 0,
              saturationPercent: 100,
              vignettePercent: 0
            }
          : undefined
    }
  }
}

function smokeCompositorStatusFromSceneParams(
  params: PreviewSurfaceSceneUpdateParams
): CompositorStatus {
  smokePreviewCompositorFrameId += 1
  return {
    state: 'live',
    targetFps: 60,
    width: 1280,
    height: 720,
    sceneRevision: params.revision,
    frameSceneRevision: params.revision,
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
        return openTab('layout', '[data-videorc-preview-card]');
      }

      if (${JSON.stringify(command)} === 'open-tab') {
        const tabId = String(params.tab ?? 'studio');
        const waitSelector = typeof params.waitFor === 'string' ? params.waitFor : null;
        return openTab(tabId, waitSelector);
      }

      if (${JSON.stringify(command)} === 'enable-synthetic-source') {
        await openTab('sources', '[data-videorc-synthetic-source-toggle]');
        const toggle = await waitFor('[data-videorc-synthetic-source-toggle]');
        if (toggle.disabled) {
          throw new Error('Synthetic source toggle is disabled.');
        }
        if (toggle.getAttribute('aria-checked') !== 'true') {
          toggle.click();
        }
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (toggle.getAttribute('aria-checked') === 'true') {
            await sleep(Number(params.settleMs ?? 600));
            return { enabled: true };
          }
          await sleep(50);
        }
        throw new Error('Timed out enabling synthetic source.');
      }

      if (${JSON.stringify(command)} === 'select-layout-preset') {
        const preset = String(params.preset ?? 'screen-only');
        await openTab('layout', '[data-videorc-layout-preset]');
        const deadline = Date.now() + 5000;
        let button = null;
        while (Date.now() < deadline) {
          button = Array.from(document.querySelectorAll('[data-videorc-layout-preset]'))
            .find((candidate) => candidate.getAttribute('data-videorc-layout-preset') === preset);
          if (button) break;
          await sleep(50);
        }
        if (!button) {
          throw new Error('Could not find layout preset ' + preset);
        }
        if (button.disabled) {
          throw new Error('Layout preset ' + preset + ' is disabled.');
        }
        button.click();
        while (Date.now() < deadline) {
          if (button.getAttribute('aria-pressed') === 'true') {
            await sleep(Number(params.settleMs ?? 600));
            return {
              preset,
              pressed: true,
              disabled: Boolean(button.disabled),
              label: button.textContent?.trim() ?? ''
            };
          }
          await sleep(50);
        }
        throw new Error('Timed out waiting for layout preset ' + preset + ' to become active.');
      }

      if (${JSON.stringify(command)} === 'scroll-studio') {
        const deltaY = Number(params.deltaY ?? 200);
        const scroller = document.querySelector('main');
        if (!scroller) {
          throw new Error('Studio scroll container not found.');
        }
        scroller.scrollBy(0, deltaY);
        await sleep(450);
        const surface = document.querySelector('[data-videorc-preview-surface]');
        const surfaceRect = surface ? surface.getBoundingClientRect() : null;
        const scrollerRect = scroller.getBoundingClientRect();
        return {
          scrollTop: scroller.scrollTop,
          surfaceRect: surfaceRect
            ? { left: surfaceRect.left, top: surfaceRect.top, width: surfaceRect.width, height: surfaceRect.height }
            : null,
          scrollerRect: {
            left: scrollerRect.left,
            top: scrollerRect.top,
            width: scrollerRect.width,
            height: scrollerRect.height
          }
        };
      }

      if (${JSON.stringify(command)} === 'dispatch-preview-shortcut') {
        const before = window.videorc?.getPreviewWindowState
          ? await window.videorc.getPreviewWindowState().catch(() => null)
          : null;
        const expectedOpen =
          typeof params.expectedOpen === 'boolean'
            ? params.expectedOpen
            : before
              ? !before.open
              : true;
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            bubbles: true,
            cancelable: true
          })
        );
        const deadline = performance.now() + Number(params.timeoutMs ?? 8000);
        let state = before;
        while (performance.now() < deadline) {
          state = window.videorc?.getPreviewWindowState
            ? await window.videorc.getPreviewWindowState().catch(() => null)
            : null;
          if (state?.open === expectedOpen) {
            return state;
          }
          await sleep(100);
        }
        return state;
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
        const card = document.querySelector('[data-videorc-preview-card]');
        const openButton = document.querySelector('[data-videorc-open-preview-window]');
        const previewWindowState = window.videorc?.getPreviewWindowState
          ? await window.videorc.getPreviewWindowState().catch(() => null)
          : null;
        const surfaceStatus = window.videorc?.getNativePreviewSurfaceStatus
          ? await window.videorc.getNativePreviewSurfaceStatus().catch(() => null)
          : null;
        const contentBounds = previewWindowState?.contentBounds ?? null;
        const cardRect = card ? card.getBoundingClientRect() : null;
        return {
          runtimeInfo: runtimeInfo ?? null,
          hasStage: Boolean(card),
          hasSurface: Boolean(card),
          hasNativePlaceholder: Boolean(previewWindowState?.open && surfaceStatus?.transport && surfaceStatus.transport !== 'unavailable'),
          previewWindowOpen: Boolean(previewWindowState?.open),
          previewWindowVisible: Boolean(previewWindowState?.visible),
          surfaceTransport: surfaceStatus?.transport ?? null,
          surfaceBacking: surfaceStatus?.backing ?? null,
          smokeSuspended: Boolean(window.__videorcSmokeNativePreviewSuspended),
          hasOpenButton: Boolean(openButton),
          surfaceRect: contentBounds
            ? { left: contentBounds.x, top: contentBounds.y, width: contentBounds.width, height: contentBounds.height }
            : cardRect
              ? { left: cardRect.left, top: cardRect.top, width: cardRect.width, height: cardRect.height }
              : null
        };
      }

      if (${JSON.stringify(command)} === 'inspect-native-preview-bootstrap') {
        const card = await waitFor('[data-videorc-preview-card]');
        const previewWindowState = window.videorc?.getPreviewWindowState
          ? await window.videorc.getPreviewWindowState().catch(() => null)
          : null;
        const surfaceStatus = window.videorc?.getNativePreviewSurfaceStatus
          ? await window.videorc.getNativePreviewSurfaceStatus().catch(() => null)
          : null;
        const contentBounds = previewWindowState?.contentBounds ?? null;
        const cardRect = card.getBoundingClientRect();
        const previewImages = Array.from(card.querySelectorAll('[data-videorc-preview-image]'));
        const previewImageSrcs = previewImages
          .map((image) => image.getAttribute('src') ?? '')
          .filter(Boolean);
        const surfaceWidth = Number(surfaceStatus?.width ?? 0) > 0
          ? Number(surfaceStatus.width)
          : Number(contentBounds?.width ?? 0) > 0
            ? Number(contentBounds.width)
            : cardRect.width;
        const surfaceHeight = Number(surfaceStatus?.height ?? 0) > 0
          ? Number(surfaceStatus.height)
          : Number(contentBounds?.height ?? 0) > 0
            ? Number(contentBounds.height)
            : cardRect.height;
        return {
          hasStage: Boolean(card),
          hasSurface: Boolean(card),
          hasNativePlaceholder: Boolean(previewWindowState?.open && surfaceStatus?.transport && surfaceStatus.transport !== 'unavailable'),
          previewWindowOpen: Boolean(previewWindowState?.open),
          previewWindowVisible: Boolean(previewWindowState?.visible),
          surfaceTransport: surfaceStatus?.transport ?? null,
          surfaceBacking: surfaceStatus?.backing ?? null,
          previewImageCount: previewImages.length,
          previewImageSrcs,
          hasJpegPollingPreviewImage: previewImageSrcs.some((src) => src.includes('/preview/live.jpg') || src.includes('/preview/live.mjpeg')),
          surfaceWidth,
          surfaceHeight,
          hasVideorcBridge: Boolean(window.videorc),
          hasCreateNativePreviewSurface: Boolean(window.videorc?.createNativePreviewSurface),
          hasUpdateNativePreviewSurfaceBounds: Boolean(window.videorc?.updateNativePreviewSurfaceBounds),
          hasUpdateNativePreviewSurfaceScene: Boolean(window.videorc?.updateNativePreviewSurfaceScene)
        };
      }

      if (${JSON.stringify(command)} === 'inspect-preview-stage-badges') {
        const card = await waitFor('[data-videorc-preview-card]');
        const surfaceStatus = window.videorc?.getNativePreviewSurfaceStatus
          ? await window.videorc.getNativePreviewSurfaceStatus().catch(() => null)
          : null;
        const badges = Array.from(card.querySelectorAll('[data-slot="badge"]'))
          .map((badge) => badge.textContent?.trim())
          .filter(Boolean);
        const text = card.textContent ?? '';
        if (surfaceStatus?.transport === 'native-surface' && surfaceStatus?.backing === 'cametal-layer') {
          badges.push('Native preview');
        } else if (surfaceStatus?.transport === 'electron-proof-surface') {
          badges.push('Electron proof');
        } else if (text.includes('Native preview')) {
          badges.push('Native preview');
        } else if (text.includes('Electron proof')) {
          badges.push('Electron proof');
        }
        return { badges, text };
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

async function stopBackend(): Promise<void> {
  destroyNativePreviewSurface()
  smokePreviewMotionServer?.close()
  smokePreviewMotionServer = null
  const child = backendProcess
  if (!child) {
    return
  }

  const result = await stopBackendProcess(child)
  if (result === 'timed-out') {
    logBackend('warn', 'Backend shutdown timed out; continuing app quit after SIGKILL.')
  }
  if (backendProcess === child) {
    removeBackendOwnedProcesses()
    backendProcess = null
    backendConnection = null
    disconnectBackendEventSocket()
  }
}

async function openSystemPermissions(pane: SystemPermissionPane = 'privacy'): Promise<void> {
  assertPermissionShortcutSupported(process.platform)

  const mediaAccessGranted = await requestMediaAccessIfNeeded(pane)
  await shell.openExternal(permissionUrlForPane(pane))
  if (mediaAccessGranted) {
    mediaPermissionGrantWatcher.stop()
    await restartBackend(`Restarting capture backend after ${pane} permission became available.`)
  } else {
    mediaPermissionGrantWatcher.watch(
      pane,
      `Restarting capture backend after ${pane} permission became available.`
    )
  }
}

async function requestMediaAccessIfNeeded(pane: SystemPermissionPane): Promise<boolean> {
  if (pane !== 'camera' && pane !== 'microphone') {
    return false
  }

  try {
    const status = systemPreferences.getMediaAccessStatus(pane)
    if (status === 'granted') {
      return true
    }
    if (status !== 'not-determined') {
      return false
    }
    return systemPreferences.askForMediaAccess(pane)
  } catch (error) {
    logBackend('warn', `Could not request ${pane} permission: ${errorMessage(error)}`)
    return false
  }
}

async function restartBackend(reason: string): Promise<void> {
  if (backendRestartInProgress) {
    return backendRestartInProgress
  }

  backendRestartInProgress = (async () => {
    logBackend('info', reason)
    await stopBackend()
    if (!appIsQuitting) {
      startBackend()
    }
  })().finally(() => {
    backendRestartInProgress = null
  })

  return backendRestartInProgress
}

const mediaPermissionGrantWatcher = createMediaPermissionGrantWatcher({
  getStatus: (permission) => systemPreferences.getMediaAccessStatus(permission),
  log: (level, message) => logBackend(level, message),
  restartBackend
})

function runtimeInfo(): RuntimeInfo {
  return buildRuntimeInfo({
    execPath: process.execPath,
    captureExecPath: resolveBackendPermissionTargetPath(),
    env: process.env
  })
}

async function revealPermissionTarget(): Promise<void> {
  shell.showItemInFolder(resolveBackendPermissionTargetPath())
}

async function revealPath(targetPath: string): Promise<void> {
  const trimmed = typeof targetPath === 'string' ? targetPath.trim() : ''
  if (!trimmed) {
    throw new Error('Reveal path is empty.')
  }

  shell.showItemInFolder(resolve(trimmed))
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
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) {
    return null
  }

  return result.filePaths[0] ?? null
}

// Generic native open-file dialog returning the chosen path (e.g. "Locate
// FFmpeg…" in Settings). No filters — the FFmpeg binary has no extension.
async function pickFilePath(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Locate FFmpeg',
    properties: ['openFile']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) {
    return null
  }

  return result.filePaths[0] ?? null
}

async function importBackgroundImage(): Promise<BackgroundImportResult | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import background image',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp']
      }
    ]
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) {
    return null
  }
  const sourcePath = result.filePaths[0]
  if (!sourcePath || !isSupportedBackgroundFile(sourcePath)) {
    return null
  }

  // Copy into app-support storage and reference the managed copy, never the
  // user's original path (Assets Tab plan locked decision).
  const id = randomUUID()
  const directory = join(app.getPath('userData'), 'background-assets')
  mkdirSync(directory, { recursive: true })
  const assetPath = join(directory, managedBackgroundFileName(id, sourcePath))
  copyFileSync(sourcePath, assetPath)

  return {
    id,
    name: backgroundAssetNameFromPath(sourcePath),
    assetPath,
    thumbnailPath: assetPath,
    fileName: basename(sourcePath)
  }
}

function bundledBackgroundDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'background-assets', 'bundled')
    : resolve(workspaceRoot(), 'apps/desktop/src/renderer/src/assets/backgrounds')
}

function bundledBackgroundAssets(): BackgroundImportResult[] {
  const directory = bundledBackgroundDirectory()
  return BUNDLED_BACKGROUND_MANIFEST.map((asset) => {
    const assetPath = join(directory, asset.fileName)
    return {
      id: asset.id,
      name: asset.name,
      assetPath,
      thumbnailPath: assetPath,
      fileName: asset.fileName
    }
  }).filter((asset) => existsSync(asset.assetPath))
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

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return
  }

  if (enforceWindowsVersionFloor()) {
    app.quit()
    return
  }

  registerOAuthCallbackProtocol()
  initAutoUpdater()
  ipcMain.handle('backend:get-connection', () => backendConnection)
  ipcMain.handle('backend:get-logs', () => backendLogs)
  ipcMain.handle('app:get-runtime-info', () => runtimeInfo())
  ipcMain.handle('system:open-permissions', (_event, pane?: SystemPermissionPane) =>
    openSystemPermissions(pane)
  )
  ipcMain.handle('system:reveal-permission-target', () => revealPermissionTarget())
  ipcMain.handle('system:reveal-path', (_event, targetPath: string) => revealPath(targetPath))
  ipcMain.handle('screens:pick-image', () => pickScreenImage())
  ipcMain.handle('system:pick-file', () => pickFilePath())
  ipcMain.handle('backgrounds:import-image', () => importBackgroundImage())
  ipcMain.handle('backgrounds:bundled-assets', () => bundledBackgroundAssets())
  ipcMain.handle('oauth:open-url', (_event, authUrl: string) => openOAuthUrl(authUrl))
  ipcMain.handle('oauth:callback-redirect-uri', (_event, platform?: string) =>
    oauthCallbackRedirectUri(platform)
  )
  ipcMain.handle('preview-surface:mode', () => nativePreviewSurfaceProofEnabled)
  ipcMain.handle('preview-surface:pump-mode', () => nativePreviewMainPumpActive)
  // Vibrancy tints by OS appearance; the renderer's theme toggle drives it so
  // the blur material always matches the in-app theme (videorc-design).
  ipcMain.handle('app:set-native-theme', (_event, theme: string) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'
    // The solid base must follow the theme wherever a solid base is painted:
    // always off macOS, and on macOS when vibrancy is opted out.
    if (!isMac || !glassVibrancyEnabled) {
      mainWindow?.setBackgroundColor(theme === 'light' ? '#F5F5F7' : '#1C1C1F')
    }
  })
  ipcMain.handle('glass:wallpaper:get', () => {
    const geometry = glassGeometry()
    if (!glassWallpaperDataUrl || !geometry) {
      return null
    }
    return { imageDataUrl: glassWallpaperDataUrl, ...geometry }
  })
  ipcMain.handle('preview-window:open', () => openPreviewWindow())
  ipcMain.handle('preview-window:close', () => closePreviewWindow())
  ipcMain.handle('preview-window:toggle', () => togglePreviewWindow())
  ipcMain.handle('preview-window:get-state', () => previewWindowState())
  ipcMain.handle(
    'preview-window:permission-required',
    (_event, permissionStatus: unknown, message: unknown, generation: unknown) =>
      reportPreviewPermissionRequired(
        previewPermissionStatusFromIpc(permissionStatus),
        typeof message === 'string' ? message : undefined,
        previewSurfaceGenerationFromIpc(generation)
      )
  )
  ipcMain.handle('preview-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setPreviewWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  ipcMain.handle('preview-window:set-aspect-ratio', (_event, width: number, height: number) => {
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const changed = previewWindowAspect.width !== width || previewWindowAspect.height !== height
      previewWindowAspect = { width, height }
      if (changed && previewWindow && !previewWindow.isDestroyed()) {
        applyPreviewWindowAspect(previewWindow)
        pushPreviewWindowPlacement()
        emitPreviewWindowState()
      }
    }
    return previewWindowState()
  })
  ipcMain.handle('notes-window:open', () => openNotesWindow())
  ipcMain.handle('notes-window:close', () => closeNotesWindow())
  ipcMain.handle('notes-window:get-state', () => notesWindowState())
  ipcMain.handle('notes-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setNotesWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  ipcMain.handle('notes-window:get-document', () => defaultNotesDocument())
  ipcMain.handle('notes-window:save-document', (_event, patch: Partial<NotesDocument>) =>
    saveNotesDocument(patch ?? {})
  )
  ipcMain.handle('comments-window:open', () => openCommentsWindow())
  ipcMain.handle('comments-window:close', () => closeCommentsWindow())
  ipcMain.handle('comments-window:toggle', () => toggleCommentsWindow())
  ipcMain.handle('comments-window:get-state', () => commentsWindowState())
  ipcMain.handle('comments-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setCommentsWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  // Relay (C3): the main renderer owns the single WS client and pushes each
  // live-chat snapshot through here to the window; the window's Clear routes
  // back to the main renderer. Last snapshot is cached for the window's first paint.
  ipcMain.handle('comments-window:push-snapshot', (_event, snapshot: LiveChatSnapshot) => {
    latestCommentsSnapshot = snapshot
    if (commentsWindow && !commentsWindow.webContents.isDestroyed()) {
      commentsWindow.webContents.send('comments-window:snapshot', snapshot)
    }
  })
  ipcMain.handle('comments-window:get-snapshot', () => latestCommentsSnapshot)
  ipcMain.handle('comments-window:clear', () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('comments-window:clear-request')
    }
  })
  ipcMain.handle('preview-surface:create', (_event, bounds: PreviewSurfaceBounds, generation) => {
    const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
    return runNativePreviewSurfaceMutation(() =>
      createNativePreviewSurface(bounds, requestedGeneration)
    )
  })
  ipcMain.handle(
    'preview-surface:update-bounds',
    (_event, bounds: PreviewSurfaceBounds, generation) => {
      const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
      return runNativePreviewSurfaceMutation(() =>
        updateNativePreviewSurfaceBounds(bounds, requestedGeneration)
      )
    }
  )
  ipcMain.handle(
    'preview-surface:apply-host-commands',
    (_event, commands: NativePreviewHostCommand[], generation) => {
      const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
      return runNativePreviewSurfaceMutation(() =>
        applyNativePreviewHostCommands(commands, requestedGeneration)
      )
    }
  )
  ipcMain.handle('preview-surface:update-scene', (_event, scene: PreviewSurfaceSceneUpdateParams) =>
    updateNativePreviewSurfaceScene(scene)
  )
  ipcMain.handle(
    'preview-surface:update-compositor',
    (_event, status: PreviewSurfaceCompositorUpdateParams) =>
      updateNativePreviewSurfaceCompositor(status)
  )
  ipcMain.handle('preview-surface:set-frame-polling-suppressed', (_event, suppressed: boolean) =>
    setNativePreviewSurfaceFramePollingSuppressed(suppressed)
  )
  ipcMain.handle('preview-surface:destroy', (_event, generation) =>
    runNativePreviewSurfaceMutation(() =>
      destroyNativePreviewSurface(previewSurfaceGenerationFromIpc(generation))
    )
  )
  ipcMain.handle('preview-surface:status', () => nativePreviewSurfaceStatus)

  createWindow()
  setDockIcon()
  await primeScreenCapturePermission()
  startBackend()
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

app.on('before-quit', (event) => {
  appIsQuitting = true
  if (backendQuitComplete || backendQuitInProgress) {
    return
  }

  event.preventDefault()
  backendQuitInProgress = true
  void stopBackend().finally(() => {
    backendQuitComplete = true
    backendQuitInProgress = false
    app.quit()
  })
})
