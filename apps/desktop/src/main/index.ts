import {
  app,
  BrowserWindow,
  contentTracing,
  desktopCapturer,
  dialog,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type NativeImage
} from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { constants as fsConstants, promises as fsPromises } from 'node:fs'
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
import {
  acquireBackendInterruptionLease,
  type BackendInterruptionLease
} from './backend-interruption'
import { runBackendInterruptingAction } from './interruption-actions'
import { AccountSignInTransactions } from './account-sign-in-transactions'
import { ProviderOAuthCallbacks } from './provider-oauth-callbacks'
import {
  createSafeStoragePersistenceCodec,
  type SecurePersistenceCodec
} from './secure-persistence-codec'
import { createNativePreviewHelperProcessDriver } from './native-preview-helper-process-driver'
import { runNativePreviewDriverReset } from './native-preview-driver-reset'
import {
  nativePreviewClosedWindowUnsuppressStatus,
  nativePreviewDriverFailureFallbackStatus,
  nativePreviewFramePollingSuppressionStatus,
  nativePreviewHelperFallbackAllowed,
  nativePreviewPlacementOwnedByNativeSurface,
  nativePreviewPresentFailureDisposition,
  nativePreviewProofPollingSuppressed,
  nativePreviewSurfaceHasAttachedNativePixels,
  nativePreviewValidatedHandoffStatus
} from './native-preview-host-policy'
import { loadNativePreviewInProcessDriver } from './native-preview-in-process-loader'
import { resolveNativePreviewInProcessModule } from './native-preview-in-process-module-path'
import { NativePreviewLatestPump } from './native-preview-latest-pump'
import { NativePreviewMotionReconciler } from './native-preview-motion-reconciler'
import { drainNativePreviewHostCommands as drainNativePreviewHostCommandsWith } from './native-preview-host-command-drain'
import {
  NativePreviewMutationQueue,
  NativePreviewPlacementQueue,
  NativePreviewPumpOwnership,
  handoffNativePreviewPumpOwnership,
  type NativePreviewPumpOwnershipTicket,
  runPreparedNativePreviewMutation
} from './native-preview-operation-queue'
import { NativePreviewRunAuthority } from './native-preview-run-authority'
import { loadNativePreviewRealSurfaceDriver } from './native-preview-real-surface-loader'
import { compositorSceneConflictsWithCommitted } from '../shared/native-preview-scene-authority'
import { applyCommentsSnapshotDelta } from '../shared/comments-snapshot-delta'
import { compositorStatusFromFrameReady } from '../shared/compositor-frame-ready'
import {
  parseMainBackendWireMessage,
  parseMainCompositorFrameReadyEvent,
  parseMainCompositorStatusEvent,
  parseMainRecordingStatus,
  parseMainRecordingStatusEvent
} from './backend-event-message'
import { safeConsole } from './safe-console'
import { parseBackendBootstrap, publicBackendConnectionJson } from './backend-bootstrap'
import { trashPaths } from './trash-paths'
import {
  MainResourceCapabilityRegistry,
  type ResourceCapabilityKind,
  type ResourceSelection
} from './resource-capabilities'
import { PersistentDirectoryAuthority } from './persistent-directory-authority'
import { SmokeAppQuitGuard } from './smoke-app-quit-guard'
import {
  PACKAGED_SMOKE_COMMAND_NAMES,
  SMOKE_BACKEND_RPC_METHOD_NAMES,
  createSmokeCommandCapability,
  handleSmokeCommandRequest,
  smokeCommandServerAllowed,
  smokePreviewFrameUrl,
  validateSmokeBackendRpcRequest,
  validateSmokeResourceAuthorization
} from './smoke-command-security'
import { runTimedBoundsStorm } from './smoke-window-bounds-storm'
import {
  assertPermissionShortcutSupported,
  buildRuntimeInfo,
  permissionUrlForPane
} from './runtime-info'
import { requestMediaAccessWithRestart, type MediaAccessResult } from './media-access'
import {
  clearGpuFallbackState,
  decideGpuFallback,
  gpuFallbackStatePath,
  isGpuCrashReason,
  readGpuFallbackState,
  shouldPersistGpuFallback,
  writeGpuFallbackState
} from './gpu-fallback'
import { createMediaPermissionGrantWatcher } from './system-permission-watch'
import {
  flushPermissionRestart,
  idleDeferredPermissionRestartState,
  requestPermissionRestart,
  type DeferredPermissionRestartState
} from './deferred-permission-restart'
import { isPathInsideAnyRoot } from './managed-asset-paths'
import {
  managedImageDecodeScript,
  normalizeManagedImageDecodeResult
} from './managed-asset-renderer-probe'
import { PreviewSupervisorModel, previewWindowTargetAction } from './preview-supervisor'
import {
  composeDockedScreenRect,
  decideDockVisibility,
  parseDockSlotReport,
  parsePreviewWindowMode,
  type DockHiddenReason,
  type DockSlotReport,
  type PreviewWindowMode
} from './preview-dock'
import { backendIsolationEnv } from './backend-isolation'
import {
  AVATAR_CACHE_MAX_FILES,
  AVATAR_MAX_BYTES,
  avatarCacheFileName,
  avatarHostAllowed
} from './avatar-cache'
import { DARK_WINDOW_PALETTE, windowPalette } from './window-palette'
import {
  assessProofSourceFrame,
  assessFirstFrame,
  assessPresenting,
  emptyFirstFrameLedger,
  emptyPresentingWatch,
  nativePreviewFirstFrameWatchdogEnabled,
  type FirstFrameLedger,
  type FirstFrameSnapshot,
  type PresentingAssessment,
  type PresentingWatchState
} from './native-preview-first-frame'
import { NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT } from './native-preview-proof-poller-runtime'
import { NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT } from './native-preview-proof-measurement-runtime'
import {
  nativePreviewProofFrameUrl,
  nativePreviewProofPollingProfile,
  nativePreviewProofPollingProfileKey
} from '../shared/native-preview-proof-polling'
import {
  DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS,
  mainPumpFrameDeliveryStalled,
  mainPumpStatusCompatibilityMayPresent
} from './native-preview-main-pump-health'
import { discoverObs, readObsSetup, readObsStreamKey } from './obs-import'
import { initAutoUpdater, registerUpdaterIpc } from './updater'
import { secureIpcHandle, sendElectronEvent } from './secure-ipc'
import {
  MAX_NOTES_TEXT_LENGTH,
  type ElectronEventChannel,
  type ElectronIpcEventMap
} from '../shared/electron-ipc-contract'
import {
  installRendererSessionPermissions,
  installWebContentsSecurity,
  registerRendererWindow,
  rendererWindowWebPreferences,
  trustRendererDocument
} from './web-contents-security'
import {
  inlineRendererDocumentCsp,
  nativePreviewSurfaceDocumentCsp,
  trustedRendererDevServerUrl
} from '../shared/renderer-security-policy'
import {
  CommentsCommandBroker,
  commentsViewModeSenderAllowed,
  liveCommentsCommandAllowed,
  parseCommentsViewMode
} from './comments-command-broker'
import { reconcileCommentsSendOperation } from '../shared/comments-send-operation'
import {
  captureStateAfterStatusPayload,
  captureStateAfterTransportLoss,
  captureStateBlocksInterruption,
  type MainCaptureState
} from '../shared/capture-state'
import {
  previewProofBackgroundStageMargin,
  previewProofLayerFit,
  previewProofLayerShape
} from '../shared/native-preview-proof-geometry'
import {
  DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS,
  compositorStatusMetalTargetHandoff,
  nativeCametalLayerStatusMatchesHandoff,
  proofSurfaceCompositorMessage,
  realSurfaceInvalidActivationMessage,
  realSurfaceUnavailableMessage,
  staleNativePreviewHandoffShouldDeclareFallback,
  type NativePreviewRealSurfaceDriver
} from '../shared/native-preview-host-driver'
import {
  normalizePreviewSurfaceBounds,
  previewSurfaceBoundsChanged,
  previewSurfaceDrawableBoundsChanged,
  previewSurfaceNativeDrawableMatchesBounds
} from '../shared/native-preview-bounds'
import {
  accountCoalescedPreviewFrame,
  accountSkippedPreviewFrame
} from '../shared/native-preview-latest-wins'
import {
  BUNDLED_BACKGROUND_MANIFEST,
  backgroundAssetNameFromPath,
  isSupportedBackgroundFile,
  managedBackgroundFileName,
  type BackgroundImportResult
} from '../shared/background-import'
import type {
  AccountCallbackEnvelope,
  BackendConnection,
  BackendLogEvent,
  CaptionWindowSnapshot,
  CaptionsUpdate,
  CaptionsWindowState,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsClearCommand,
  CommentsCommandResolution,
  CommentsSendCommand,
  CommentsSendOperation,
  CommentsSnapshotDelta,
  CommentsViewMode,
  CommentsViewSnapshot,
  CommentsWindowState,
  CompositorSceneSourceStatus,
  CompositorStatus,
  LayoutSettings,
  LiveChatSnapshot,
  NativePreviewHostCommand,
  NotesDocument,
  NotesFontScale,
  NotesWindowState,
  OAuthCallbackEnvelope,
  ObsSetup,
  PreviewSurfaceCompositorUpdateParams,
  PreviewSurfaceBounds,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneLayerKind,
  PreviewSurfaceSceneState,
  PreviewSurfaceSceneUpdateParams,
  PreviewSurfaceStatus,
  MediaAccessSnapshot,
  MediaAccessStatus,
  PreviewPermissionStatus,
  PreviewSupervisorState,
  SceneSource,
  SceneTransform,
  StreamScreen,
  SystemPermissionPane,
  RuntimeInfo,
  VideorcAccountSnapshot,
  ViewerSample
} from '../shared/backend'

let mainWindow: BrowserWindow | null = null
let nativePreviewSurfaceWindow: BrowserWindow | null = null
let notesWindow: BrowserWindow | null = null
let notesWindowLastFrame: Electron.Rectangle | null = null
let notesWindowAlwaysOnTop = false
let notesWindowClosing = false
let notesWindowContentProtected = false
let notesWindowCloseFlushReady = false
let notesWindowCloseFlushTimer: ReturnType<typeof setTimeout> | null = null
let latestViewerSample: ViewerSample | null = null
let commentsWindow: BrowserWindow | null = null
let commentsWindowLastFrame: Electron.Rectangle | null = null
let commentsWindowAlwaysOnTop = false
let commentsWindowClosing = false
let commentsWindowContentProtected = false
let latestCommentHighlightState: CommentHighlightState = { generation: 0, phase: 'idle' }
let latestLiveCommentsSnapshot: LiveChatSnapshot | null = null
const commentsHistorySnapshots = new Map<string, LiveChatSnapshot>()
let commentsViewMode: CommentsViewMode = { kind: 'live' }
let latestLiveCommentsSendOperation: CommentsSendOperation | undefined
const commentsHistorySendOperations = new Map<string, CommentsSendOperation>()
const commentsCommandBroker = new CommentsCommandBroker()
type CommentsSmokeCommandFixture =
  | {
      kind: 'highlight'
      outcome: 'live' | 'failed'
      delayMs: number
      reason: string
    }
  | {
      kind: 'send'
      outcome: 'sent' | 'partial' | 'failed'
      delayMs: number
      reason: string
    }
let commentsSmokeCommandFixture: CommentsSmokeCommandFixture | null = null
let commentsSmokeCommandTrace: Record<string, unknown> | null = null
let commentsSmokeSnapshotOverride = false
let captionsWindow: BrowserWindow | null = null
let captionsWindowLastFrame: Electron.Rectangle | null = null
let captionsWindowAlwaysOnTop = false
let captionsWindowClosing = false
let latestCaptionLines: CaptionsUpdate[] = []
let latestCaptionSnapshot: CaptionWindowSnapshot = {
  lines: [],
  status: { state: 'idle' },
  styleId: 'classic',
  position: 'bottom',
  textSize: 'm'
}
let nativePreviewSurfaceCompositorUpdateInFlight: Promise<PreviewSurfaceStatus> | null = null
let nativePreviewSurfaceCompositorRequestSerial = 0
const nativePreviewSurfaceMutationQueue = new NativePreviewMutationQueue()
const nativePreviewPumpOwnership = new NativePreviewPumpOwnership()
const nativePreviewPlacementQueue = new NativePreviewPlacementQueue(
  async ({ bounds, generation }) => {
    if (!nativePreviewPresentationAllowedForGeneration(generation)) {
      return
    }
    if (
      nativePreviewRealSurfaceDriverKind === 'in-process' &&
      nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus) &&
      !previewSurfaceDrawableBoundsChanged(nativePreviewSurfaceStatus.bounds ?? null, bounds) &&
      previewSurfaceNativeDrawableMatchesBounds(nativePreviewSurfaceStatus, bounds)
    ) {
      // The CAMetalLayer is a child of this BrowserWindow's NSView: x/y and
      // z-order already moved atomically in AppKit. Keep diagnostics current
      // without moving the hidden proof window or entering the present queue.
      nativePreviewSurfaceStatus = {
        ...nativePreviewSurfaceStatus,
        bounds,
        updatedAt: new Date().toISOString()
      }
      return
    }
    await runNativePreviewSurfaceMutation(() => {
      if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
        return nativePreviewSurfaceStatus
      }
      return applyNativePreviewHostCommands(
        [{ kind: nativePreviewSurfaceWindowExists() ? 'update-bounds' : 'create', bounds }],
        generation
      )
    })
  },
  (error) => safeConsole.error('Preview window placement push failed:', error)
)
let nativePreviewSurfaceStatus: PreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
let nativePreviewSurfaceFramePollingSuppressed = false
let nativePreviewProofPollingRecordingActive = false
let nativePreviewAppliedProofPollingProfile: string | null = null
let nativePreviewProofPollingProfileSerial = 0
let nativePreviewNativeOwnsProofPollingSuppression = false
let nativePreviewNativeFailureFallbackActive = false
let nativePreviewAppliedProofPollingSuppression: boolean | null = null
let nativePreviewProofAnimationSuspended: boolean | null = null
let nativePreviewFramePollingSuppressionSerial = 0
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendQuitComplete = false
let backendQuitInProgress = false
let backendRestartInProgress: Promise<void> | null = null
let backendOwnedProcessPids = new Set<number>()
let backendPermissionTargetPath: string | null = null
let ownedProcessRegistry: OwnedProcessRegistry | null = null
let ownedProcessRegistryLockDepth = 0
let backendConnection: BackendConnection | null = null
let backendAdminConnection: BackendConnection | null = null
let backendAuthorityReady: Promise<void> = Promise.resolve()
const mainResourceCapabilities = new MainResourceCapabilityRegistry()
let mainCaptureState: MainCaptureState = 'unknown'
let deferredPermissionRestartState: DeferredPermissionRestartState =
  idleDeferredPermissionRestartState
let smokePreviewMotionServer: HttpServer | null = null
let smokePreviewCompositorFrameId = 0
let nativePreviewSurfaceScene: PreviewSurfaceSceneState | null = null
let nativePreviewCommittedCompositorScene: PreviewSurfaceSceneState | null = null
let nativePreviewCommittedCompositorRunId: string | undefined
const nativePreviewCompositorRunAuthority = new NativePreviewRunAuthority()
let nativePreviewPendingSceneRevision: number | null = null
let nativePreviewSurfaceSceneRevisionGuardUntilMs = 0
let stdoutBuffer = ''
let appIsQuitting = false
let appIcon: NativeImage | null | undefined
const backendLogs: BackendLogEvent[] = []
const earlyProtocolCallbackUrls: string[] = []
let accountSignInTransactions: AccountSignInTransactions | null = null
let providerOAuthCallbacks: ProviderOAuthCallbacks | null = null
let oauthPersistenceCodec: SecurePersistenceCodec | null = null
let persistentDirectoryAuthority: PersistentDirectoryAuthority | null = null
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
const captionsWindowFeatureEnabled = process.env.VIDEORC_CAPTIONS_WINDOW !== '0'
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

installWebContentsSecurity(app)
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
      if (mainWindow) {
        sendElectronEvent(mainWindow.webContents, 'glass:geometry', geometry)
      }
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
      if (mainWindow) {
        sendElectronEvent(mainWindow.webContents, 'glass:wallpaper', {
          imageDataUrl: glassWallpaperDataUrl,
          ...geometry
        })
      }
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
if (process.env.VIDEORC_SMOKE_DISABLE_ELECTRON_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu')
}
// GPU fallback (Windows Insider incident: broken Chromium GPU process boots
// only with GPU flags and composites transparent windows as BLANK). Must run
// before app.ready: VIDEORC_DISABLE_GPU=1 is the explicit user hatch, a
// persisted gpu-fallback.json (written after repeated GPU crashes, below)
// self-heals the next launch, and VIDEORC_FORCE_GPU=1 overrides + clears it.
const gpuFallbackFile = gpuFallbackStatePath(app.getPath('userData'))
const gpuFallbackDecision = decideGpuFallback({
  env: process.env,
  persisted: readGpuFallbackState(gpuFallbackFile)
})
if (gpuFallbackDecision.clearPersisted) {
  clearGpuFallbackState(gpuFallbackFile)
}
if (gpuFallbackDecision.disable) {
  app.disableHardwareAcceleration()
}
let gpuProcessCrashCount = 0
let gpuFallbackPersistedThisLaunch = false
app.on('child-process-gone', (_event, details) => {
  // Every abnormal child exit is worth a support-bundle line; GPU crashes
  // additionally drive the persisted software-rendering fallback.
  if (details.type !== 'GPU' || !isGpuCrashReason(details.reason)) {
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      logBackend(
        'warn',
        `Chromium ${details.type} process gone (${details.reason}, exit ${details.exitCode ?? 'n/a'}).`
      )
    }
    return
  }
  gpuProcessCrashCount += 1
  logBackend(
    'warn',
    `GPU process crashed (${details.reason}, ${gpuProcessCrashCount} this launch). Repeated crashes switch Videorc to software rendering on the next launch.`
  )
  if (!gpuFallbackDecision.disable && !gpuFallbackPersistedThisLaunch) {
    if (shouldPersistGpuFallback(gpuProcessCrashCount)) {
      gpuFallbackPersistedThisLaunch = true
      writeGpuFallbackState(gpuFallbackFile, {
        disableHardwareAcceleration: true,
        reason: 'gpu-process-crashes',
        crashCount: gpuProcessCrashCount,
        updatedAt: new Date().toISOString()
      })
      logBackend(
        'warn',
        'GPU process is unreliable on this machine — Videorc will use software rendering from the next launch (set VIDEORC_FORCE_GPU=1 to undo).'
      )
    }
  }
})
// Keep the detached preview window live while it sits behind the main window.
// A scene change is made in the main window, so the preview is occluded at that
// moment — and macOS/Chromium stops compositing a fully-occluded window, which
// froze the preview until it was clicked to the front. These switches keep
// occluded/background windows rendering so the preview updates in place. The
// per-window backgroundThrottling:false flags only cover timers/visibility; the
// occlusion-driven compositor suspension needs these process-level switches.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const packagedSmokeHarnessCapability =
  app.isPackaged && process.env.VIDEORC_PACKAGED_SMOKE_TEST === '1'
    ? process.env.VIDEORC_SMOKE_COMMAND_CAPABILITY
    : undefined
const smokeCommandServerEnabled = smokeCommandServerAllowed(
  process.env.VIDEORC_SMOKE_PREVIEW_MOTION === '1' ||
    process.env.VIDEORC_SMOKE_COMMAND_SERVER === '1',
  app.isPackaged,
  packagedSmokeHarnessCapability
)
const smokeCommandCapability = smokeCommandServerEnabled
  ? (packagedSmokeHarnessCapability ?? createSmokeCommandCapability())
  : ''
const smokeAppQuitGuard = new SmokeAppQuitGuard(process.env.VIDEORC_PREVIEW_LIFECYCLE_PROBE === '1')
const NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD = 3
const requireNativePreviewRealSurfaceModule = createRequire(__filename)
const configuredNativePreviewHostModulePath = process.env.VIDEORC_NATIVE_PREVIEW_HOST_MODULE?.trim()
const nativePreviewInProcessModuleResolution = resolveNativePreviewInProcessModule({
  explicitPath: process.env.VIDEORC_NATIVE_PREVIEW_IN_PROCESS_MODULE,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  workspaceRoot: workspaceRoot(),
  exists: existsSync
})
type NativePreviewRealSurfaceDriverKind = 'in-process' | 'external-module' | 'helper-process'
const nativePreviewRealSurfaceDriverLoad = loadNativePreviewPrimaryDriver()
const NATIVE_PREVIEW_HANDOFF_SAMPLE_LIMIT = 900
const NATIVE_PREVIEW_MAIN_SCENE_MISMATCH_MESSAGE_MS = 250
let nativePreviewRealSurfaceDriverUnavailableReason =
  nativePreviewRealSurfaceDriverLoad.unavailableReason
let nativePreviewRealSurfaceDriver: NativePreviewRealSurfaceDriver | null =
  nativePreviewRealSurfaceDriverLoad.driver
let nativePreviewRealSurfaceDriverKind: NativePreviewRealSurfaceDriverKind | null =
  nativePreviewRealSurfaceDriverLoad.kind ?? null
let nativePreviewPrimaryDriverRetryAtMs = 0
let nativePreviewHelperProcessDriverResolved = false
let nativePreviewHelperDriverRetryAtMs = 0
const NATIVE_PREVIEW_HELPER_RETRY_COOLDOWN_MS = 5000
const nativePreviewHelperFallbackEnabled = nativePreviewHelperFallbackAllowed({
  fallbackFlag: process.env.VIDEORC_NATIVE_PREVIEW_HELPER_FALLBACK,
  explicitHelperPath: process.env.VIDEORC_NATIVE_PREVIEW_HOST_HELPER
})
// While the native CAMetalLayer recently confirmed a present, it owns placement
// and the Electron proof window stays hidden (no stacked surfaces at one rect).
let nativePreviewNativePresentConfirmedAtMs = 0
const NATIVE_PREVIEW_NATIVE_AUTHORITY_MS = 1500

function nativeSurfaceOwnsPlacement(
  status: PreviewSurfaceStatus = nativePreviewSurfaceStatus
): boolean {
  return nativePreviewPlacementOwnedByNativeSurface({
    status,
    driverKind: nativePreviewRealSurfaceDriverKind,
    recentPresent:
      Date.now() - nativePreviewNativePresentConfirmedAtMs < NATIVE_PREVIEW_NATIVE_AUTHORITY_MS
  })
}

function clearNativePreviewNativePlacementAuthority(): void {
  nativePreviewNativePresentConfirmedAtMs = 0
}

// --- First-frame contract watchdog (native-preview-first-frame.ts, plan P2) ---
// From preview-window open, the app owes a native frame of the committed scene
// within budget — or a self-heal, or a declared fallback with the blocked link.
// The watchdog fetches compositor status itself (pump-independent, so it also
// heals a dead pump), assesses the chain each tick, runs the healing ladder,
// and keeps the preview window's waiting hint truthful.
const FIRST_FRAME_TICK_MS = 750
const PREVIEW_WAIT_DETAIL_DEFAULT =
  'The native surface appears here as soon as the compositor presents.'
let firstFrameWatchdogTimer: NodeJS.Timeout | null = null
let firstFrameWatchdogStartedAtMs = 0
let firstFrameLedger: FirstFrameLedger = emptyFirstFrameLedger()
let firstFrameLastFramesRendered: number | null = null
let firstFrameLastPresentedFrameId: number | null = null
// `undefined` means no hint state has been published since the watchdog was
// initialized. `null` is a real state: the wait hint is hidden. Keeping those
// states distinct makes the first hide update observable without a magic
// string sentinel (and keeps this source file valid text).
let firstFrameLastHint: string | null | undefined
let firstFrameTickInFlight = false
// After the first frame lands the watchdog does NOT stop: it flips into the
// presenting watch (plan 021 F1) and keeps assessing the same chain so a
// mid-session stall self-heals instead of leaving the placeholder forever.
let firstFrameWatchdogMode: 'first-frame' | 'presenting-watch' = 'first-frame'
let presentingWatch: PresentingWatchState = emptyPresentingWatch()
let presentingWatchLastKind: PresentingAssessment['kind'] = 'presenting'

function startFirstFrameWatchdog(): void {
  stopFirstFrameWatchdog()
  firstFrameWatchdogStartedAtMs = Date.now()
  firstFrameLedger = emptyFirstFrameLedger()
  firstFrameLastFramesRendered = null
  firstFrameLastPresentedFrameId = null
  firstFrameLastHint = undefined
  firstFrameWatchdogMode = 'first-frame'
  presentingWatch = emptyPresentingWatch()
  presentingWatchLastKind = 'presenting'
  setFirstFrameStatus('pending', 'Preview surface is starting.')
  firstFrameWatchdogTimer = setInterval(() => {
    void runFirstFrameWatchdogTick()
  }, FIRST_FRAME_TICK_MS)
}

function stopFirstFrameWatchdog(): void {
  if (firstFrameWatchdogTimer) {
    clearInterval(firstFrameWatchdogTimer)
    firstFrameWatchdogTimer = null
  }
  firstFrameTickInFlight = false
}

function setFirstFrameStatus(
  contract: 'pending' | 'healing' | 'met' | 'fallback',
  reason?: string
): void {
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    firstFrameContract: contract,
    ...(reason ? { firstFrameReason: reason } : {})
  }
}

// S4 (plan 024): `null` means the contract is met/recovered — HIDE the .hint
// container, don't just repaint its text. The .hint block lives permanently in
// the preview-window DOM and is only ever OCCLUDED by the separate order-above
// helper NSWindow; a click that raises the preview window above the helper for
// one IPC hop would otherwise flash the "Waiting for preview" words. Hiding the
// container means a z-order flash uncovers only the solid base, never the text.
function updatePreviewWindowWaitDetail(text: string | null): void {
  if (text === firstFrameLastHint) {
    return
  }
  firstFrameLastHint = text
  const window = previewWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  const detail = text ?? PREVIEW_WAIT_DETAIL_DEFAULT
  const hidden = text === null
  void window.webContents
    .executeJavaScript(
      `(() => {
        const hint = document.querySelector('.hint');
        if (hint) { hint.style.display = ${hidden ? "'none'" : "'flex'"}; }
        const el = document.getElementById('videorc-wait-detail');
        if (el) { el.textContent = ${JSON.stringify(detail)} }
      })()`
    )
    .catch(() => {
      // The hint is best-effort; presentation health is tracked in the status.
    })
}

async function fetchFirstFrameCompositorStatus(): Promise<CompositorStatus | null> {
  if (!backendConnection) {
    return null
  }
  const params = new URLSearchParams({ token: backendConnection.token })
  try {
    return await requestBackendJson<CompositorStatus>(
      `http://${backendConnection.host}:${backendConnection.port}/compositor/status?${params.toString()}`
    )
  } catch {
    return null
  }
}

async function runFirstFrameWatchdogTick(): Promise<void> {
  if (firstFrameTickInFlight) {
    return
  }
  firstFrameTickInFlight = true
  try {
    const window = previewWindow
    if (!window || window.isDestroyed() || appIsQuitting) {
      stopFirstFrameWatchdog()
      return
    }

    const watchdogGeneration = firstFrameWatchdogStartedAtMs
    const compositor = await fetchFirstFrameCompositorStatus()
    // The window may have closed — or the watchdog restarted for a new
    // surface — while the status fetch was in flight. Assessing (and above
    // all HEALING) after teardown respawns the helper post-destroy, which the
    // lifecycle probe's rapid toggle cycles catch.
    if (
      firstFrameWatchdogTimer == null ||
      watchdogGeneration !== firstFrameWatchdogStartedAtMs ||
      previewWindow !== window ||
      window.isDestroyed()
    ) {
      return
    }
    const framesRendered = compositor?.framesRendered ?? null
    const framesAdvancing =
      framesRendered != null &&
      firstFrameLastFramesRendered != null &&
      framesRendered > firstFrameLastFramesRendered
    if (framesRendered != null) {
      firstFrameLastFramesRendered = framesRendered
    }
    const presentedFrameId = nativePreviewSurfaceStatus.presentedFrameId ?? null
    const presentationAdvancing =
      presentedFrameId != null &&
      firstFrameLastPresentedFrameId != null &&
      presentedFrameId > firstFrameLastPresentedFrameId
    if (presentedFrameId != null) {
      firstFrameLastPresentedFrameId = presentedFrameId
    }
    const mainPumpSocket = backendEventSocket
    const mainPumpConnection = backendAdminConnection
    if (
      mainPumpSocket &&
      mainPumpConnection &&
      mainPumpFrameDeliveryStalled({
        active: nativePreviewMainPumpActive,
        surfaceLive: nativePreviewSurfaceStatus.state === 'live',
        compositorFramesAdvancing: framesAdvancing,
        activatedAtMs: nativePreviewMainPumpActivatedAtMs,
        lastPresentDrivingEventAtMs: nativePreviewMainLastPresentDrivingEventAtMs,
        nowMs: Date.now()
      })
    ) {
      retireBackendEventSocket(
        mainPumpSocket,
        mainPumpConnection,
        `presentation event heartbeat stalled for ${Math.max(0, Date.now() - Math.max(nativePreviewMainPumpActivatedAtMs, nativePreviewMainLastPresentDrivingEventAtMs))}ms while compositor frames advanced`
      )
    }

    const snapshot: FirstFrameSnapshot = {
      elapsedMs: Date.now() - firstFrameWatchdogStartedAtMs,
      surfaceLive: nativePreviewSurfaceStatus.state === 'live',
      nativePresenting: nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus),
      framesAdvancing,
      presentationAdvancing,
      rendererSceneRevision: nativePreviewSurfaceScene?.revision ?? null,
      compositorSceneRevision: compositor?.sceneRevision ?? null,
      compositorFrameSceneRevision: compositor?.frameSceneRevision ?? null,
      metalTargetPresent: Boolean(compositor?.metalTargetIosurfaceId)
    }

    if (firstFrameWatchdogMode === 'presenting-watch') {
      // Compositor status unreachable = backend restarting or app teardown in
      // progress. Healing cannot help there, and a reset/present fired into
      // teardown respawns the helper after destroy — pause the watch instead.
      if (!compositor) {
        return
      }
      runPresentingWatchTick(snapshot)
      return
    }

    const { assessment, ledger } = assessFirstFrame(snapshot, firstFrameLedger)
    firstFrameLedger = ledger

    switch (assessment.kind) {
      case 'met':
        setFirstFrameStatus('met')
        updatePreviewWindowWaitDetail(null)
        // Contract met ≠ done: keep ticking as the presenting watch so a
        // mid-session stall (dead pump, suspended helper, lost surface)
        // self-heals instead of showing the placeholder until relaunch.
        firstFrameWatchdogMode = 'presenting-watch'
        presentingWatch = emptyPresentingWatch()
        presentingWatchLastKind = 'presenting'
        return
      case 'pending':
        setFirstFrameStatus('pending', assessment.reason)
        updatePreviewWindowWaitDetail(assessment.reason)
        return
      case 'heal':
        setFirstFrameStatus('healing', assessment.reason)
        updatePreviewWindowWaitDetail(assessment.reason)
        logBackend('info', `[first-frame] healing: ${assessment.action} — ${assessment.reason}`)
        runFirstFrameHealingAction(assessment.action, compositor)
        return
      case 'fallback':
        setFirstFrameStatus('fallback', assessment.reason)
        updatePreviewWindowWaitDetail(`Preview could not start natively: ${assessment.reason}`)
        logBackend('warn', `[first-frame] contract failed: ${assessment.reason}`)
        stopFirstFrameWatchdog()
        return
    }
  } finally {
    firstFrameTickInFlight = false
  }
}

// Steady-state tick after the first frame landed. Quiet while healthy or
// merely observing a transient; heals through the same ladder on a confirmed
// stall; declares a truthful stall (and keeps watching for revival) when the
// ladder exhausts. The [preview-watch] log lines name the blocked link — they
// are the field diagnosis for remote reports.
function runPresentingWatchTick(snapshot: FirstFrameSnapshot): void {
  const { assessment, watch } = assessPresenting(snapshot, presentingWatch, FIRST_FRAME_TICK_MS)
  presentingWatch = watch
  const kindChanged = assessment.kind !== presentingWatchLastKind
  presentingWatchLastKind = assessment.kind

  switch (assessment.kind) {
    case 'presenting':
      if (kindChanged) {
        setFirstFrameStatus('met')
        updatePreviewWindowWaitDetail(null)
        logBackend('info', '[preview-watch] presenting recovered')
      }
      return
    case 'observing':
      // Broken under the tick threshold, or between spaced ladder actions —
      // stay quiet so transient hiccups never flap the status.
      return
    case 'heal':
      setFirstFrameStatus('healing', assessment.reason)
      updatePreviewWindowWaitDetail(assessment.reason)
      logBackend('info', `[preview-watch] healing: ${assessment.action} — ${assessment.reason}`)
      runFirstFrameHealingAction(assessment.action, null)
      return
    case 'stalled':
      if (kindChanged) {
        setFirstFrameStatus('fallback', assessment.reason)
        updatePreviewWindowWaitDetail(`Preview stalled: ${assessment.reason}`)
        logBackend('warn', `[preview-watch] stalled after healing exhausted: ${assessment.reason}`)
      }
      return
  }
}

function runFirstFrameHealingAction(
  action: 'present-kick' | 'resync-scene' | 'reset-native-path',
  compositor: CompositorStatus | null
): void {
  switch (action) {
    case 'present-kick': {
      // Push the freshest compositor status through the normal present path —
      // heals a stalled pump or a stale reused status.
      void (async () => {
        const status = compositor ?? (await fetchFirstFrameCompositorStatus())
        // The preview may have closed while the status fetch was in flight —
        // presenting after teardown respawns the helper post-destroy.
        if (status && previewWindow && !previewWindow.isDestroyed()) {
          await updateNativePreviewSurfaceCompositor({ ...status })
        }
      })().catch((error) => {
        logBackend('warn', `[first-frame] present-kick failed: ${errorMessage(error)}`)
      })
      return
    }
    case 'resync-scene': {
      // Ask the renderer to re-commit its scene through the backend-owned
      // allocator; a committed revision displaces a stale/foreign compositor
      // scene (2026-07-01 incident class).
      const window = mainWindow
      if (window && !window.webContents.isDestroyed()) {
        sendElectronEvent(window.webContents, 'preview-surface:resync-scene', undefined)
      }
      return
    }
    case 'reset-native-path': {
      // Retire the current presenter before resolving a replacement. Merely
      // clearing retry timestamps leaves a wedged in-process addon installed,
      // so ensureNativePreviewRealSurfaceDriver would return the same instance.
      void resetNativePreviewRealSurfaceDriver(
        'Native preview presenting watchdog requested a clean presenter.'
      ).catch((error) => {
        logBackend('warn', `[first-frame] native path reset failed: ${errorMessage(error)}`)
      })
      return
    }
  }
}
let nativePreviewLastRealSurfaceFallbackLogKey: string | undefined
let nativePreviewRealSurfaceInvalidActivationCount = 0
let nativePreviewStaleHandoffStartedAtMs: number | null = null
let nativePreviewStaleHandoffAttemptCount = 0
let nativePreviewMainQueueWaitSamplesMs: number[] = []
let nativePreviewMainPresentSamplesMs: number[] = []
let nativePreviewMainQueuedBehindCount = 0
let nativePreviewMainIngressCoalescedFrameCount = 0
let nativePreviewMainStatusFetchSamplesMs: number[] = []
let nativePreviewMainStatusAgeSamplesMs: number[] = []
let nativePreviewMainStatusFrameAgeSamplesMs: number[] = []
let nativePreviewMainStatusFetchFailures = 0
let nativePreviewMainStatusFetchSuccesses = 0
let nativePreviewMainSceneMismatchCount = 0
let nativePreviewMainSceneMismatchStartedAtMs: number | null = null
let nativePreviewMainLastSkippedSceneRevision: number | undefined
let nativePreviewMainLastSkippedFrameSceneRevision: number | undefined

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

type NativePreviewMainSceneMismatchFields = Pick<
  PreviewSurfaceStatus,
  | 'nativePreviewMainSceneMismatchCount'
  | 'nativePreviewMainSceneMismatchAgeMs'
  | 'nativePreviewMainLastSkippedSceneRevision'
  | 'nativePreviewMainLastSkippedFrameSceneRevision'
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
    return { backgroundColor: windowPalette(nativeTheme.shouldUseDarkColors).base }
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
      : { backgroundColor: windowPalette(nativeTheme.shouldUseDarkColors).base }),
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
    // Hold the (transparent) window until the renderer has painted its first
    // frame — showing it at create time put an empty pane on screen that then
    // visibly filled in piece by piece.
    show: false,
    ...platformWindowChromeOptions(),
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...rendererWindowWebPreferences('main'),
      backgroundThrottling: false
    }
  })
  registerRendererWindow(mainWindow, 'main')

  let mainWindowShown = false
  const showMainWindow = (): void => {
    if (mainWindowShown || !mainWindow || mainWindow.isDestroyed()) {
      return
    }
    mainWindowShown = true
    mainWindow.show()
  }
  mainWindow.once('ready-to-show', showMainWindow)
  // ready-to-show is not fully reliable on transparent windows: never strand
  // the user with an invisible app.
  setTimeout(showMainWindow, 3000)

  const rendererUrl = trustedRendererDevServerUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  if (rendererUrl) {
    trustRendererDocument(mainWindow, rendererUrl)
    mainWindow.loadURL(rendererUrl)
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html')
    trustRendererDocument(mainWindow, pathToFileURL(rendererPath).toString())
    mainWindow.loadFile(rendererPath)
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
      if (mainWindow) {
        sendElectronEvent(mainWindow.webContents, 'shortcut:navigate', input.key)
      }
    }
  })

  mainWindow.on('closed', () => {
    commentsCommandBroker.rejectAll()
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
    if (captionsWindow && !captionsWindow.isDestroyed()) {
      captionsWindow.close()
    }
    mainWindow = null
  })

  // Docked-preview followers: every placement-relevant main-window event
  // recomputes the docked frame FROM MAIN-PROCESS STATE (cached slot rect +
  // getContentBounds). No renderer round trip — that lag is what sank the
  // 2026-06-09 glued preview. The child-window parenting moves the frame
  // atomically during drags; these events keep the native surface in step.
  mainWindow.on('move', () => {
    if (currentPreviewWindowMode() !== 'docked') {
      return
    }
    if (nativeInProcessPreviewOwnsWindowMovement()) {
      queuePreviewWindowMotionReconcile()
      return
    }
    queueDockedPreviewPlacement()
  })
  mainWindow.on('moved', () => {
    if (currentPreviewWindowMode() === 'docked' && nativeInProcessPreviewOwnsWindowMovement()) {
      flushPreviewWindowMotionReconcile()
    }
  })
  for (const event of ['resize', 'show', 'hide', 'minimize', 'restore'] as const) {
    mainWindow.on(event as 'move', () => {
      if (currentPreviewWindowMode() === 'docked') {
        queueDockedPreviewPlacement()
      }
    })
  }
  for (const event of ['enter-full-screen', 'leave-full-screen'] as const) {
    mainWindow.on(event as 'enter-full-screen', () => {
      if (currentPreviewWindowMode() === 'docked') {
        queueDockedPreviewPlacement()
      }
    })
  }

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
      void backendAuthorityReady.then(() => {
        if (mainWindow && backendConnection) {
          sendElectronEvent(mainWindow.webContents, 'backend:connection', backendConnection)
        }
        flushOAuthCallbackUrls()
      })
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
    restoreCaptionsWindowOnLaunch()
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
// --- Docked ("stick") mode: the preview window is a child of the main window,
// glued over the Studio slot. Main composes placement from its OWN move/resize
// events + the renderer's window-relative slot report; the renderer is never in
// the movement path (see preview-dock.ts for why).
let previewWindowMode: PreviewWindowMode = 'floating'
let previewWindowModeLoaded = false
// The floating frame remembered across a dock, so undocking restores it and a
// close-while-docked never persists the slot rect as the floating frame.
let previewWindowFloatingFrame: Electron.Rectangle | null = null
let previewDockSlot: DockSlotReport | null = null
// Bumped on every dock engage; slot reports answering an older epoch are stale
// (measured before the redock) and are dropped.
let previewDockEpoch = 0
// True while a blocking in-app overlay (dialog/popover) is open: overlays paint
// in the main window's web contents and would be hidden UNDER the docked native
// surface, so the surface yields while they are up.
let previewDockOverlayOpen = false
let previewDockPlacementQueued = false
const previewWindowMotionReconciler = new NativePreviewMotionReconciler(() => {
  const window = previewWindow
  if (!window || window.isDestroyed() || previewWindow !== window) {
    return
  }
  previewSupervisor.setWindowVisible(window.isVisible() && !window.isMinimized())
  pushPreviewWindowPlacement()
  emitPreviewWindowState()
})

function nativeInProcessPreviewOwnsWindowMovement(): boolean {
  return (
    nativePreviewRealSurfaceDriverKind === 'in-process' &&
    nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus)
  )
}

function queuePreviewWindowMotionReconcile(): void {
  previewWindowMotionReconciler.request()
}

function flushPreviewWindowMotionReconcile(): void {
  previewWindowMotionReconciler.flush()
}
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
  // Docked windows track the Studio slot rect exactly; the RENDERER keeps the
  // slot aspect-correct (CSS aspect-ratio), so a main-side lock would only
  // fight the slot-follow setBounds.
  if (previewWindowMode === 'docked') {
    window.setAspectRatio(0)
    window.setMinimumSize(1, 1)
    return
  }
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
  if (conformingPreviewWindow || window.isFullScreen() || previewWindowMode === 'docked') {
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
  // Docked mode has no drag bar (the window cannot be dragged); the video fills
  // the whole slot-sized content rect.
  const barHeight = previewWindowMode === 'docked' ? 0 : PREVIEW_WINDOW_BAR_HEIGHT
  return {
    x: contentBounds.x,
    y: contentBounds.y + barHeight,
    width: contentBounds.width,
    height: Math.max(1, contentBounds.height - barHeight)
  }
}

// Window frame, open/closed choice, always-on-top, and floating/docked mode
// survive relaunches (U3). `frame` is always the FLOATING frame — docked
// placement derives from the Studio slot and is never persisted.
type PreviewWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  open?: boolean
  mode?: PreviewWindowMode
}

// Mode is module state so the placement helpers can consult it synchronously,
// hydrated from prefs once (lazily, so early callers agree with openPreviewWindow).
function currentPreviewWindowMode(): PreviewWindowMode {
  if (!previewWindowModeLoaded) {
    previewWindowMode = parsePreviewWindowMode(loadPreviewWindowPrefs().mode)
    previewWindowModeLoaded = true
  }
  return previewWindowMode
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
    // skipTransformProcessType is load-bearing: without it, Electron flips the
    // app's activation policy (UIElement ↔ Foreground) to make the window join
    // all Spaces — and that transform HIDES every other window of the app. The
    // owner report (2026-07-07): opening Notes (with the persisted
    // always-on-top pref) sent the whole app behind until Notes closed. The
    // collection behavior alone is enough for floating over fullscreen.
    window.setVisibleOnAllWorkspaces(alwaysOnTop, {
      visibleOnFullScreen: alwaysOnTop,
      skipTransformProcessType: true
    })
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
        sendElectronEvent(window.webContents, 'notes-window:state', state)
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
        sendElectronEvent(window.webContents, 'notes-window:document', document)
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
  const scriptNonce = randomBytes(24).toString('base64url')
  const contentSecurityPolicy = inlineRendererDocumentCsp(scriptNonce)
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
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
    <style>
    html, body { margin: 0; height: 100%; background: ${DARK_WINDOW_PALETTE.base}; color: ${DARK_WINDOW_PALETTE.textPrimary};
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden; user-select: none; -webkit-user-select: none; }
    body { display: flex; flex-direction: column; }
    .drag-bar { height: 34px; display: flex; align-items: center; gap: 10px;
      padding: 0 12px 0 78px; box-sizing: border-box; background: ${DARK_WINDOW_PALETTE.panel};
      border-bottom: 1px solid ${DARK_WINDOW_PALETTE.hairline}; -webkit-app-region: drag; }
    .title { color: ${DARK_WINDOW_PALETTE.textSecondary}; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .spacer { flex: 1; }
    button { -webkit-app-region: no-drag; border: 1px solid ${DARK_WINDOW_PALETTE.controlBorder};
      border-radius: 6px; background: ${DARK_WINDOW_PALETTE.controlBg}; color: ${DARK_WINDOW_PALETTE.textPrimary};
      height: 22px; padding: 0 8px; font: inherit; font-size: 11px; cursor: default; }
    button[aria-pressed="true"] { background: ${DARK_WINDOW_PALETTE.chromeFill}; color: ${DARK_WINDOW_PALETTE.chromeFillText}; border-color: ${DARK_WINDOW_PALETTE.chromeFill}; }
    .icon-button { width: 24px; padding: 0; display: inline-flex; align-items: center;
      justify-content: center; }
    .icon-button svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2;
      fill: none; stroke-linecap: round; stroke-linejoin: round; }
    textarea { flex: 1; resize: none; border: 0; outline: none; padding: 20px 22px;
      box-sizing: border-box; background: ${DARK_WINDOW_PALETTE.base}; color: ${DARK_WINDOW_PALETTE.textPrimary}; caret-color: ${DARK_WINDOW_PALETTE.textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45; -webkit-app-region: no-drag;
      /* Keep the arrow cursor: the window is capture-protected but the OS
         composites the pointer separately, so an I-beam over "empty" space
         would betray the hidden notes to viewers. */
      cursor: default; }
    body[data-font-scale="sm"] textarea { font-size: 18px; }
    body[data-font-scale="md"] textarea { font-size: 24px; }
    body[data-font-scale="lg"] textarea { font-size: 32px; }
    textarea::placeholder { color: ${DARK_WINDOW_PALETTE.textTertiary}; }
    .footer { height: 28px; display: flex; align-items: center; gap: 12px; padding: 0 12px;
      border-top: 1px solid ${DARK_WINDOW_PALETTE.hairline}; color: ${DARK_WINDOW_PALETTE.textTertiary}; font-size: 11px; }
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
    <textarea maxlength="${MAX_NOTES_TEXT_LENGTH}" spellcheck="false" placeholder="Notes for this recording..."></textarea>
    <div class="footer"><span id="word-count">0 words</span><span id="save-state">Saved</span></div>
    <script nonce="${scriptNonce}">
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

        async function save() {
          window.clearTimeout(saveTimer);
          saveTimer = null;
          saveState.textContent = 'Saving';
          try {
            await window.videorc?.saveNotesDocument?.({ text: textarea.value, fontScale });
            saveState.textContent = 'Saved';
          } catch {
            saveState.textContent = 'Save failed';
          }
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
        const unsubscribeNotesFlushRequest = window.videorc?.onNotesFlushRequest?.(() => {
          void save();
        });
        window.videorc?.getNotesWindowState?.().then(applyNotesWindowState).catch(() => {});
        window.addEventListener('beforeunload', () => {
          unsubscribeNotesWindowState?.();
          unsubscribeNotesFlushRequest?.();
        });
        render();
        textarea.focus();
      })();
    </script>
  </body></html>`
}

// FX6: app shortcuts died while an aux window (Notes/Comments) held key focus
// — the forwarding above only listens on the main window. Aux windows forward
// the exact same chords: ⌘1–9/⌘, focus main and navigate; ⌘⇧N/⌘⇧J/⌘⇧C toggle
// the aux windows. Nothing else is intercepted (typing in Notes stays untouched).
function attachAuxWindowShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.meta || input.control)) {
      return
    }
    if (input.shift) {
      const key = input.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        if (notesWindowIsOpen()) {
          closeNotesWindow()
        } else {
          void openNotesWindow()
        }
      } else if (key === 'j') {
        event.preventDefault()
        if (commentsWindowIsOpen()) {
          closeCommentsWindow()
        } else {
          void openCommentsWindow()
        }
      } else if (key === 'c') {
        event.preventDefault()
        if (captionsWindowIsOpen()) {
          closeCaptionsWindow()
        } else {
          void openCaptionsWindow()
        }
      }
      return
    }
    const isDigit = input.key >= '1' && input.key <= '9'
    if (isDigit || input.key === ',') {
      event.preventDefault()
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
        sendElectronEvent(mainWindow.webContents, 'shortcut:navigate', input.key)
      }
    }
  })
}

async function openNotesWindow(): Promise<NotesWindowState> {
  if (!notesWindowFeatureEnabled) {
    return notesWindowState()
  }
  const existingWindow = notesWindow
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (notesWindowClosing) {
      return notesWindowState('Notes is finishing its last save before closing.')
    }
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
    // Center the traffic lights in the 34px drag bar so they align with the title.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 11 } }
      : {}),
    backgroundColor: DARK_WINDOW_PALETTE.base,
    show: false,
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...rendererWindowWebPreferences('notes'),
      backgroundThrottling: false
    }
  })
  registerRendererWindow(window, 'notes')
  notesWindowClosing = false
  notesWindowCloseFlushReady = false
  notesWindow = window
  attachAuxWindowShortcuts(window)
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
  window.on('close', (event) => {
    if (notesWindow === window) {
      if (!notesWindowCloseFlushReady) {
        event.preventDefault()
        requestNotesWindowCloseFlush(window)
        return
      }
      notesWindowClosing = true
      notesWindowLastFrame = window.getBounds()
      saveNotesWindowPrefs({ frame: notesWindowLastFrame, open: false })
    }
  })
  window.on('closed', () => {
    if (notesWindow === window) {
      notesWindow = null
      notesWindowClosing = false
      notesWindowCloseFlushReady = false
      if (notesWindowCloseFlushTimer) {
        clearTimeout(notesWindowCloseFlushTimer)
        notesWindowCloseFlushTimer = null
      }
      notesWindowContentProtected = false
      emitNotesWindowState()
    }
  })

  const notesDocumentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    notesWindowHtml(defaultNotesDocument(prefs))
  )}`
  trustRendererDocument(window, notesDocumentUrl)
  await window.loadURL(notesDocumentUrl)
  window.show()
  window.focus()
  emitNotesWindowState()
  emitNotesDocument(defaultNotesDocument())
  return notesWindowState()
}

function finishNotesWindowClose(window: BrowserWindow): void {
  if (notesWindow !== window || window.isDestroyed()) {
    return
  }
  if (notesWindowCloseFlushTimer) {
    clearTimeout(notesWindowCloseFlushTimer)
    notesWindowCloseFlushTimer = null
  }
  notesWindowCloseFlushReady = true
  setImmediate(() => {
    if (notesWindow === window && !window.isDestroyed()) {
      window.close()
    }
  })
}

function requestNotesWindowCloseFlush(window: BrowserWindow): void {
  if (notesWindow !== window || window.isDestroyed() || notesWindowClosing) {
    return
  }
  notesWindowClosing = true
  try {
    sendElectronEvent(window.webContents, 'notes-window:flush-request', undefined)
  } catch {
    finishNotesWindowClose(window)
    return
  }
  notesWindowCloseFlushTimer = setTimeout(() => {
    safeConsole.warn('Notes close flush timed out; closing with the last acknowledged save.')
    finishNotesWindowClose(window)
  }, 1_500)
}

function closeNotesWindow(message?: string): NotesWindowState {
  if (notesWindow && !notesWindow.isDestroyed()) {
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
// "detachable second-monitor chat window"), mirroring the Notes window. Plain
// BrowserWindow — no native surface, but content-protected so it can be kept
// open during recording/livestreaming without appearing in captured output.
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
    protected: open ? commentsWindowContentProtected : false,
    enabled: commentsWindowFeatureEnabled,
    message:
      message ??
      (commentsWindowFeatureEnabled
        ? undefined
        : 'Comments window is disabled by VIDEORC_COMMENTS_WINDOW=0.')
  }
}

function currentCommentsView(): CommentsViewSnapshot | null {
  if (commentsViewMode.kind === 'live') {
    return {
      mode: commentsViewMode,
      snapshot: latestLiveCommentsSnapshot ?? {
        providers: [],
        messages: [],
        unreadCount: 0,
        updatedAt: new Date().toISOString()
      },
      latestSendOperation: latestLiveCommentsSendOperation
    }
  }
  const snapshot = commentsHistorySnapshots.get(commentsViewMode.sessionId) ?? null
  return snapshot
    ? {
        mode: commentsViewMode,
        snapshot,
        latestSendOperation: commentsHistorySendOperations.get(commentsViewMode.sessionId)
      }
    : null
}

function assertLiveCommentsCommandSession(sessionId: unknown): asserts sessionId is string {
  if (
    !liveCommentsCommandAllowed({
      mode: commentsViewMode,
      liveSessionId: latestLiveCommentsSnapshot?.sessionId,
      commandSessionId: typeof sessionId === 'string' ? sessionId : undefined
    })
  ) {
    throw new Error('Comments commands are available only for the selected live session.')
  }
}

function commentsCommandRequestId(value: unknown): string {
  if (!value || typeof value !== 'object' || !('requestId' in value)) {
    throw new Error('Comments command requires a request id.')
  }
  const requestId = value.requestId
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Comments command requires a request id.')
  }
  return requestId
}

function cacheCommentsView(view: CommentsViewSnapshot): void {
  if (view.mode.kind === 'live') {
    const sessionChanged = latestLiveCommentsSnapshot?.sessionId !== view.snapshot.sessionId
    latestLiveCommentsSnapshot = view.snapshot
    if (sessionChanged || view.latestSendOperation !== undefined) {
      latestLiveCommentsSendOperation = view.latestSendOperation
        ? reconcileCommentsSendOperation(latestLiveCommentsSendOperation, view.latestSendOperation)
        : undefined
    }
  } else {
    commentsHistorySnapshots.set(view.mode.sessionId, view.snapshot)
    if (view.latestSendOperation) {
      commentsHistorySendOperations.set(
        view.mode.sessionId,
        reconcileCommentsSendOperation(
          commentsHistorySendOperations.get(view.mode.sessionId),
          view.latestSendOperation
        )
      )
    } else {
      commentsHistorySendOperations.delete(view.mode.sessionId)
    }
  }
}

function cacheCommentsSendResult(operation: CommentsSendOperation): 'live' | 'history' {
  if (latestLiveCommentsSnapshot?.sessionId === operation.sessionId) {
    latestLiveCommentsSendOperation = reconcileCommentsSendOperation(
      latestLiveCommentsSendOperation,
      operation
    )
    return 'live'
  }
  commentsHistorySendOperations.set(
    operation.sessionId,
    reconcileCommentsSendOperation(
      commentsHistorySendOperations.get(operation.sessionId),
      operation
    )
  )
  return 'history'
}

function emitCommentsView(): void {
  const view = currentCommentsView()
  if (view && commentsWindow && !commentsWindow.webContents.isDestroyed()) {
    sendElectronEvent(commentsWindow.webContents, 'comments-window:snapshot', view)
  }
}

function emitCommentHighlightState(state: CommentHighlightState): void {
  latestCommentHighlightState = state
  if (commentsWindow && !commentsWindow.webContents.isDestroyed()) {
    sendElectronEvent(commentsWindow.webContents, 'comments-window:highlight-state', state)
  }
}

function smokeCommentsSendOperation(
  command: CommentsSendCommand,
  fixture: Extract<CommentsSmokeCommandFixture, { kind: 'send' }>
): CommentsSendOperation {
  const now = new Date().toISOString()
  const twitchFailed = fixture.outcome !== 'sent'
  return {
    id: command.operationId,
    sessionId: command.sessionId,
    text: command.text,
    phase: fixture.outcome,
    destinations: [
      {
        destinationId: 'comments-probe-youtube',
        platform: 'youtube',
        phase: fixture.outcome === 'failed' ? 'failed' : 'sent',
        ...(fixture.outcome === 'failed' ? { reason: fixture.reason } : {})
      },
      {
        destinationId: 'comments-probe-twitch',
        platform: 'twitch',
        phase: twitchFailed ? 'failed' : 'sent',
        ...(twitchFailed ? { reason: fixture.reason } : {})
      },
      {
        destinationId: 'comments-probe-x',
        platform: 'x',
        phase: 'read-only',
        reason: 'X comments are receive-only.'
      }
    ],
    createdAt: now,
    updatedAt: now
  }
}

/** Smoke-only deterministic renderer response. The stale resolution attempt is
 * intentional: the probe proves that only the matching request id completes. */
function dispatchSmokeCommentHighlight(command: CommentHighlightCommand): boolean {
  const fixture = commentsSmokeCommandFixture
  if (!fixture || fixture.kind !== 'highlight') return false
  const staleResolutionAccepted = commentsCommandBroker.resolve({
    requestId: `${command.requestId}:stale`,
    ok: true,
    value: latestCommentHighlightState
  })
  commentsSmokeCommandTrace = {
    kind: fixture.kind,
    outcome: fixture.outcome,
    requestId: command.requestId,
    staleResolutionAccepted,
    terminal: 'pending'
  }
  setTimeout(() => {
    const state: CommentHighlightState = {
      sessionId: command.sessionId,
      messageId: command.messageId,
      generation: latestCommentHighlightState.generation + 1,
      phase: fixture.outcome,
      ...(fixture.outcome === 'failed' ? { reason: fixture.reason } : {})
    }
    emitCommentHighlightState(state)
    const resolutionAccepted = commentsCommandBroker.resolve(
      fixture.outcome === 'live'
        ? { requestId: command.requestId, ok: true, value: state }
        : { requestId: command.requestId, ok: false, error: fixture.reason }
    )
    commentsSmokeCommandTrace = {
      kind: fixture.kind,
      outcome: fixture.outcome,
      requestId: command.requestId,
      resolutionRequestId: command.requestId,
      staleResolutionAccepted,
      resolutionAccepted,
      terminal: fixture.outcome === 'live' ? 'resolved' : 'rejected'
    }
  }, fixture.delayMs)
  return true
}

function dispatchSmokeCommentsSend(command: CommentsSendCommand): boolean {
  const fixture = commentsSmokeCommandFixture
  if (!fixture || fixture.kind !== 'send') return false
  const operation = smokeCommentsSendOperation(command, fixture)
  const staleResolutionAccepted = commentsCommandBroker.resolve({
    requestId: `${command.requestId}:stale`,
    ok: true,
    value: operation
  })
  commentsSmokeCommandTrace = {
    kind: fixture.kind,
    outcome: fixture.outcome,
    requestId: command.requestId,
    operationId: command.operationId,
    staleResolutionAccepted,
    terminal: 'pending'
  }
  setTimeout(() => {
    const resolutionAccepted = commentsCommandBroker.resolve({
      requestId: command.requestId,
      ok: true,
      value: operation
    })
    if (resolutionAccepted) {
      cacheCommentsSendResult(operation)
      emitCommentsView()
    }
    commentsSmokeCommandTrace = {
      kind: fixture.kind,
      outcome: fixture.outcome,
      requestId: command.requestId,
      resolutionRequestId: command.requestId,
      operationId: command.operationId,
      resultOperationId: operation.id,
      staleResolutionAccepted,
      resolutionAccepted,
      terminal: 'resolved'
    }
  }, fixture.delayMs)
  return true
}

function commentsCaptureHeaderSignal(image: NativeImage): number {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  // "Comments" occupies this stable logical-pixel region. A stale partial
  // texture can still contain bright comment-row text near the top, so scoring
  // the whole header produces false positives; score the title itself.
  const xStart = Math.max(0, Math.floor((68 / 420) * size.width))
  const xEnd = Math.min(size.width, Math.ceil((154 / 420) * size.width))
  const yStart = Math.max(0, Math.floor((8 / 640) * size.height))
  const yEnd = Math.min(size.height, Math.ceil((29 / 640) * size.height))
  let signal = 0
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const index = (y * size.width + x) * 4
      if (Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]) >= 72) {
        signal += 1
      }
    }
  }
  return signal
}

function emitCommentsWindowState(message?: string): void {
  if (appIsQuitting) {
    return
  }
  const state = commentsWindowState(message)
  for (const window of [mainWindow, commentsWindow]) {
    if (
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      (window !== commentsWindow || !commentsWindowClosing)
    ) {
      try {
        sendElectronEvent(window.webContents, 'comments-window:state', state)
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
    // Center the traffic lights in the 40px header so they align with the title.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    backgroundColor: DARK_WINDOW_PALETTE.base,
    show: false,
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...rendererWindowWebPreferences('comments'),
      backgroundThrottling: false
    }
  })
  registerRendererWindow(window, 'comments')
  commentsWindowClosing = false
  commentsWindow = window
  attachAuxWindowShortcuts(window)
  commentsWindowContentProtected = false
  try {
    window.setContentProtection(true)
    commentsWindowContentProtected = true
  } catch (error) {
    safeConsole.warn('Comments window content protection could not be enabled:', error)
  }
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
      commentsWindowContentProtected = false
      emitCommentsWindowState()
    }
  })

  const rendererUrl = trustedRendererDevServerUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  if (rendererUrl) {
    const commentsUrl = new URL('comments.html', rendererUrl).toString()
    trustRendererDocument(window, commentsUrl)
    await window.loadURL(commentsUrl)
  } else {
    const commentsPath = join(__dirname, '../renderer/comments.html')
    trustRendererDocument(window, pathToFileURL(commentsPath).toString())
    await window.loadFile(commentsPath)
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

// --- Detached captions window (live captions P4) -----------------------------
// Clone of the Comments window shell: a big-text caption display for a second
// monitor (also capturable into the scene as a poor-man's burn-in). Data is
// relayed via main: the main renderer pushes its caption-line buffer, main
// caches it for first paint and forwards live updates.
type CaptionsWindowPrefs = {
  frame?: Electron.Rectangle
  alwaysOnTop?: boolean
  alwaysOnTopPreferenceVersion?: number
  open?: boolean
}

function captionsWindowPrefsPath(): string {
  return join(app.getPath('userData'), 'captions-window.json')
}

function loadCaptionsWindowPrefs(): CaptionsWindowPrefs {
  try {
    return JSON.parse(readFileSync(captionsWindowPrefsPath(), 'utf8')) as CaptionsWindowPrefs
  } catch {
    return {}
  }
}

function saveCaptionsWindowPrefs(patch: CaptionsWindowPrefs): void {
  if (!captionsWindowFeatureEnabled || process.env.VIDEORC_SMOKE_OUTPUT_DIR) {
    return
  }
  try {
    writeFileSync(
      captionsWindowPrefsPath(),
      JSON.stringify({ ...loadCaptionsWindowPrefs(), ...patch })
    )
  } catch {
    // A failed preference write must never break capture.
  }
}

function captionsWindowAlwaysOnTopPreference(prefs: CaptionsWindowPrefs): boolean {
  return prefs.alwaysOnTopPreferenceVersion === 1 && prefs.alwaysOnTop === true
}

function captionsWindowIsOpen(): boolean {
  return Boolean(captionsWindow && !captionsWindow.isDestroyed() && !captionsWindowClosing)
}

function captionsWindowGlobalId(): number | undefined {
  const window = captionsWindow
  if (!captionsWindowIsOpen() || !window) {
    return undefined
  }
  const match = /^window:(\d+):/.exec(window.getMediaSourceId())
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(id) && id > 0 ? id : undefined
}

function captionsWindowState(message?: string): CaptionsWindowState {
  const window = captionsWindow
  const open = captionsWindowIsOpen()
  return {
    open,
    visible: open ? window!.isVisible() && !window!.isMinimized() : false,
    bounds: open ? window!.getBounds() : null,
    windowId: captionsWindowGlobalId(),
    alwaysOnTop: captionsWindowAlwaysOnTop,
    enabled: captionsWindowFeatureEnabled,
    message:
      message ??
      (captionsWindowFeatureEnabled
        ? undefined
        : 'Captions window is disabled by VIDEORC_CAPTIONS_WINDOW=0.')
  }
}

function emitCaptionsWindowState(message?: string): void {
  if (appIsQuitting) {
    return
  }
  const state = captionsWindowState(message)
  for (const window of [mainWindow, captionsWindow]) {
    if (window && !window.webContents.isDestroyed()) {
      try {
        sendElectronEvent(window.webContents, 'captions-window:state', state)
      } catch (error) {
        if (!appIsQuitting) {
          safeConsole.warn('Captions window state emit failed:', error)
        }
      }
    }
  }
}

async function openCaptionsWindow(): Promise<CaptionsWindowState> {
  if (!captionsWindowFeatureEnabled) {
    return captionsWindowState()
  }
  const existingWindow = captionsWindow
  if (captionsWindowIsOpen() && existingWindow) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.show()
    existingWindow.focus()
    emitCaptionsWindowState()
    return captionsWindowState()
  }

  const prefs = loadCaptionsWindowPrefs()
  const rememberedFrame = captionsWindowLastFrame ?? prefs.frame ?? null
  const frame = rememberedFrame ? clampFrameToWorkArea(rememberedFrame) : null
  const window = new BrowserWindow({
    width: frame?.width ?? 640,
    height: frame?.height ?? 320,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: 360,
    minHeight: 200,
    title: 'Videorc Captions',
    // Center the traffic lights in the 40px header so they align with the title.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    backgroundColor: DARK_WINDOW_PALETTE.base,
    show: false,
    ...appWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...rendererWindowWebPreferences('captions'),
      backgroundThrottling: false
    }
  })
  registerRendererWindow(window, 'captions')
  captionsWindowClosing = false
  captionsWindow = window
  captionsWindowAlwaysOnTop = captionsWindowAlwaysOnTopPreference(prefs)
  if (captionsWindowAlwaysOnTop) {
    applyNotesWindowAlwaysOnTop(window, true)
  }
  saveCaptionsWindowPrefs({ open: true })

  for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore', 'focus'] as const) {
    window.on(event as 'move', () => {
      if (captionsWindow === window) {
        emitCaptionsWindowState()
      }
    })
  }
  window.on('close', () => {
    if (captionsWindow === window) {
      captionsWindowClosing = true
      captionsWindowLastFrame = window.getBounds()
      saveCaptionsWindowPrefs({ frame: captionsWindowLastFrame, open: false })
    }
  })
  window.on('closed', () => {
    if (captionsWindow === window) {
      captionsWindow = null
      captionsWindowClosing = false
      emitCaptionsWindowState()
    }
  })

  const rendererUrl = trustedRendererDevServerUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  if (rendererUrl) {
    const captionsUrl = new URL('captions.html', rendererUrl).toString()
    trustRendererDocument(window, captionsUrl)
    await window.loadURL(captionsUrl)
  } else {
    const captionsPath = join(__dirname, '../renderer/captions.html')
    trustRendererDocument(window, pathToFileURL(captionsPath).toString())
    await window.loadFile(captionsPath)
  }
  window.show()
  window.focus()
  emitCaptionsWindowState()
  return captionsWindowState()
}

function closeCaptionsWindow(message?: string): CaptionsWindowState {
  if (captionsWindow && !captionsWindow.isDestroyed()) {
    captionsWindowClosing = true
    captionsWindow.close()
  }
  return captionsWindowState(message)
}

async function toggleCaptionsWindow(): Promise<CaptionsWindowState> {
  if (captionsWindowIsOpen()) {
    return closeCaptionsWindow()
  }
  return openCaptionsWindow()
}

function setCaptionsWindowAlwaysOnTop(alwaysOnTop: boolean): CaptionsWindowState {
  captionsWindowAlwaysOnTop = alwaysOnTop
  if (captionsWindow && !captionsWindow.isDestroyed()) {
    applyNotesWindowAlwaysOnTop(captionsWindow, alwaysOnTop)
  }
  saveCaptionsWindowPrefs({ alwaysOnTop, alwaysOnTopPreferenceVersion: 1 })
  emitCaptionsWindowState()
  return captionsWindowState()
}

function restoreCaptionsWindowOnLaunch(): void {
  if (!captionsWindowFeatureEnabled || !previewWindowAutoRestoreEnabled) {
    return
  }
  const prefs = loadCaptionsWindowPrefs()
  if (prefs.open === true) {
    void openCaptionsWindow()
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
  mode: PreviewWindowMode
  // Echoed by the renderer's slot reports so stale measurements are rejectable.
  dockEpoch: number
  // Why the docked surface is hidden right now (null = showing); the slot UI
  // turns this into stated copy — a docked preview never just vanishes.
  dockHiddenReason: DockHiddenReason | null
  supervisor: PreviewSupervisorState
}

function previewWindowState(): PreviewWindowState {
  const window = previewWindow
  const open = previewWindowIsOpenForSurface()
  // The VIDEO region: window content minus the drag bar. Everything downstream
  // (surface placement, probe asserts) follows this rect.
  const contentBounds = open ? previewWindowVideoBounds(window!) : null
  const mode = currentPreviewWindowMode()
  return {
    open,
    visible: open ? window!.isVisible() && !window!.isMinimized() : false,
    contentBounds,
    scaleFactor: contentBounds ? screen.getDisplayMatching(contentBounds).scaleFactor : 1,
    screenHeight: screen.getPrimaryDisplay().bounds.height,
    alwaysOnTop: previewWindowAlwaysOnTop,
    mode,
    dockEpoch: previewDockEpoch,
    dockHiddenReason: open && mode === 'docked' ? dockVisibilityDecision().hiddenReason : null,
    supervisor: previewSupervisor.snapshot()
  }
}

function dockVisibilityDecision(): ReturnType<typeof decideDockVisibility> {
  return decideDockVisibility({
    slot: previewDockSlot,
    currentEpoch: previewDockEpoch,
    mainWindowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    mainWindowMinimized: Boolean(
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()
    ),
    mainWindowFullScreen: Boolean(
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()
    ),
    overlayOpen: previewDockOverlayOpen
  })
}

// The docked placement hot path: recompute the docked window frame from the
// cached window-relative slot rect + the main window's current content bounds.
// Runs on main-window move/resize (main-process events, no renderer round trip)
// and whenever the slot report or visibility inputs change. Coalesced to one
// application per event-loop turn so macOS live-drag event storms stay cheap.
function queueDockedPreviewPlacement(): void {
  if (previewDockPlacementQueued) {
    return
  }
  previewDockPlacementQueued = true
  queueMicrotask(() => {
    previewDockPlacementQueued = false
    applyDockedPreviewPlacement()
  })
}

function applyDockedPreviewPlacement(): void {
  const window = previewWindow
  if (
    currentPreviewWindowMode() !== 'docked' ||
    !previewWindowIsOpenForSurface() ||
    !window ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return
  }
  const decision = dockVisibilityDecision()
  if (!decision.visible) {
    if (window.isVisible()) {
      window.hide()
    }
    // Push visible:false EXPLICITLY — never rely on the child window's 'hide'
    // event: macOS child-window events are unreliable, and when the event was
    // missed the Electron window hid while the NATIVE helper surface stayed
    // painted over the next tab (0.9.4 field bug — docked preview leaking
    // onto other tabs). The push is idempotent; a duplicate from the event
    // handler is harmless.
    pushPreviewWindowPlacement()
    emitPreviewWindowState()
    return
  }
  const slot = previewDockSlot!
  const rect = composeDockedScreenRect(slot, mainWindow.getContentBounds())
  const current = window.getBounds()
  if (
    rect.x !== current.x ||
    rect.y !== current.y ||
    rect.width !== current.width ||
    rect.height !== current.height
  ) {
    window.setBounds(rect)
  }
  if (!window.isVisible()) {
    // Never steal focus from the main window the user is actively using.
    window.showInactive()
  }
  // setBounds/show fire the window's own move/resize/show handlers, which own
  // the placement push; this direct push covers the no-op-change path where the
  // visibility inputs (overlay closed, slot re-mounted) changed instead.
  pushPreviewWindowPlacement()
  emitPreviewWindowState()
}

function previewWindowSurfaceBounds(visibleOverride?: boolean): PreviewSurfaceBounds | null {
  const state = previewWindowState()
  if (!state.open || !state.contentBounds) {
    return null
  }
  const contentBounds = state.contentBounds
  const visible = state.visible && (visibleOverride ?? true)
  const orderAboveWindowId = previewWindowGlobalId()
  return {
    screenX: contentBounds.x,
    screenY: contentBounds.y,
    width: contentBounds.width,
    height: contentBounds.height,
    scaleFactor: state.scaleFactor,
    screenHeight: state.screenHeight,
    visible,
    ...(orderAboveWindowId === undefined
      ? {}
      : {
          orderAboveWindowId,
          elevated: previewWindowAlwaysOnTop && state.mode !== 'docked'
        })
  }
}

function emitPreviewWindowState(): void {
  if (appIsQuitting) {
    return
  }
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    try {
      sendElectronEvent(mainWindow.webContents, 'preview-window:state', previewWindowState())
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
// S3 (plan 025): a display hot-plug, arrangement change, or scale change must
// re-home the native preview surface. The preview-window `move` handler only
// fires when the WINDOW moves — a monitor being added/removed/rescaled under a
// stationary window emits no move, so the surface (positioned in absolute
// screen coordinates + the target display's scale) would otherwise be left on
// stale geometry. Re-push placement on every display-metrics event; the push
// re-reads the live contentBounds + matched-display scale.
function registerDisplayChangeReconcile(): void {
  const reconcile = (): void => {
    if (!previewWindow || previewWindow.isDestroyed()) {
      return
    }
    if (currentPreviewWindowMode() === 'docked') {
      queueDockedPreviewPlacement()
    } else {
      pushPreviewWindowPlacement()
    }
    emitPreviewWindowState()
  }
  screen.on('display-metrics-changed', reconcile)
  screen.on('display-added', reconcile)
  screen.on('display-removed', reconcile)
}

function pushPreviewWindowPlacement(): void {
  const bounds = previewWindowSurfaceBounds()
  if (!bounds) {
    return
  }
  const generation = previewWindowSurfaceGeneration()
  nativePreviewPlacementQueue.enqueue({ bounds, generation })
}

function nativePreviewSurfaceWindowExists(): boolean {
  return Boolean(nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed())
}

function nativePreviewSurfaceNeedsPlacementReconcile(): boolean {
  const bounds = previewWindowSurfaceBounds()
  if (!previewSurfacePresentationAllowed() || !bounds) {
    return false
  }
  return (
    !nativePreviewSurfaceWindowExists() ||
    nativePreviewSurfaceStatus.state !== 'live' ||
    !nativePreviewSurfaceStatus.bounds ||
    previewSurfaceBoundsChanged(nativePreviewSurfaceStatus.bounds, bounds)
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
  html, body { margin: 0; height: 100%; background: ${DARK_WINDOW_PALETTE.base}; color: ${DARK_WINDOW_PALETTE.textSecondary};
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden;
    user-select: none; -webkit-user-select: none; -webkit-app-region: drag; }
  .drag-bar { position: fixed; top: 0; left: 0; right: 0; height: 28px;
    display: flex; align-items: center; gap: 10px; cursor: grab;
    padding: 0 12px 0 78px; /* traffic lights live in the left inset */
    background: ${DARK_WINDOW_PALETTE.panel}; border-bottom: 1px solid ${DARK_WINDOW_PALETTE.hairline};
    box-sizing: border-box; }
  .drag-bar:active { cursor: grabbing; }
  .drag-bar .label { color: ${DARK_WINDOW_PALETTE.textTertiary}; font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; white-space: nowrap; }
  .drag-bar .grip { flex: 1; height: 8px; background-image:
    radial-gradient(circle, rgba(255, 255, 255, 0.18) 1px, transparent 1.2px);
    background-size: 6px 4px; background-position: center; }
  .hint { position: fixed; top: 28px; left: 0; right: 0; bottom: 0; display: flex;
    align-items: center; justify-content: center; flex-direction: column; gap: 6px; }
  .hint .title { color: ${DARK_WINDOW_PALETTE.textPrimary}; font-size: 13px; }
  /* Docked ("stick") variant: the window is immovable inside the Studio slot,
     so the drag bar disappears and the hint fills the whole content rect. */
  body.docked { -webkit-app-region: no-drag; }
  body.docked .drag-bar { display: none; }
  body.docked .hint { top: 0; }
</style></head><body>
  <div class="hint"><div class="title">Waiting for preview</div>
  <div id="videorc-wait-detail">The native surface appears here as soon as the compositor presents.</div></div>
  <div class="drag-bar"><span class="label">Videorc Preview</span><span class="grip"></span></div>
</body></html>`

async function openPreviewWindow(): Promise<PreviewWindowState> {
  const existingWindow = previewWindow
  if (previewWindowIsOpenForSurface() && existingWindow) {
    // A docked window's visibility belongs to the dock predicate (it may be
    // deliberately hidden behind a dialog or a scrolled-away slot); force-show
    // + focus would tear it out of the slot's state.
    if (currentPreviewWindowMode() === 'docked') {
      queueDockedPreviewPlacement()
      emitPreviewWindowState()
      return previewWindowState()
    }
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
  const mode = currentPreviewWindowMode()
  const docked = mode === 'docked'
  const rememberedFrame = previewWindowLastFrame ?? prefs.frame ?? null
  const frame = rememberedFrame ? clampFrameToWorkArea(rememberedFrame) : null
  const window = new BrowserWindow({
    width: frame?.width ?? 960,
    height: frame?.height ?? 568,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: docked ? 1 : 320,
    minHeight: docked ? 1 : 208,
    title: 'Videorc Preview',
    // hiddenInset is macOS-only; off macOS the standard frame keeps the
    // preview window draggable without renderer drag regions (Phase 4 owns
    // the frameless Windows chrome). Traffic lights center in the 28px bar.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 8 } }
      : {}),
    backgroundColor: DARK_WINDOW_PALETTE.base,
    // A docked window stays hidden until the renderer answers the dock epoch
    // with a slot rect; showing it at the remembered FLOATING frame first would
    // flash a mis-placed preview.
    show: !docked,
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
  previewWindowFloatingFrame = frame
  previewSupervisor.windowOpened(window.isVisible() && !window.isMinimized())
  previewWindowAlwaysOnTop = prefs.alwaysOnTop === true
  if (previewWindowAlwaysOnTop && !docked) {
    window.setAlwaysOnTop(true, 'floating')
  }
  if (docked) {
    applyDockedPreviewChrome(window)
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
  // The in-process CAMetalLayer moves atomically with this BrowserWindow. Keep
  // size/diagnostic bounds current at display cadence without turning a native
  // drag into an IPC/state-broadcast storm on Electron's presentation thread.
  for (const event of ['move', 'resize'] as const) {
    window.on(event as 'move', () => {
      if (previewWindow === window) {
        queuePreviewWindowMotionReconcile()
      }
    })
  }
  for (const event of ['moved', 'resized'] as const) {
    window.on(event as 'moved', () => {
      if (previewWindow === window) {
        flushPreviewWindowMotionReconcile()
      }
    })
  }
  for (const event of ['show', 'hide', 'minimize', 'restore', 'focus'] as const) {
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
      // While docked the window sits at the Studio slot rect; persisting THAT
      // would teleport the next floating open into the slot. The floating
      // frame remembered at dock time is the one that survives.
      previewWindowLastFrame =
        currentPreviewWindowMode() === 'docked'
          ? (previewWindowFloatingFrame ?? previewWindowLastFrame)
          : window.getBounds()
      savePreviewWindowPrefs({
        ...(previewWindowLastFrame ? { frame: previewWindowLastFrame } : {}),
        open: false
      })
    }
  })
  window.on('closed', () => {
    if (previewWindow === window) {
      previewWindowMotionReconciler.cancel()
      stopFirstFrameWatchdog()
      previewWindow = null
      previewWindowClosing = false
      previewSupervisor.finishClose(previewWindowSurfaceGeneration())
      // Host teardown happens here, renderer-independent (the renderer's own
      // teardown adds the backend session destroy when its state event lands).
      nativePreviewPlacementQueue.cancelPending()
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
  if (docked) {
    setDockedPreviewChromeClass(window, true)
    engageDockedPreviewPlacement(window)
  }
  void setNativePreviewSurfaceFramePollingSuppressed(false)
  pushPreviewWindowPlacement()
  emitPreviewWindowState()
  // The first-frame watchdog proves and heals the macOS CAMetalLayer chain.
  // Windows uses the Electron proof surface; running the Metal watchdog there
  // guarantees false resets because an IOSurface can never appear.
  if (nativePreviewFirstFrameWatchdogEnabled(process.platform)) {
    startFirstFrameWatchdog()
  } else {
    stopFirstFrameWatchdog()
    firstFrameLastHint = undefined
    setFirstFrameStatus('pending', 'Waiting for the Windows preview surface to deliver pixels.')
    updatePreviewWindowWaitDetail('Waiting for the Windows preview surface to deliver pixels.')
  }
  return previewWindowState()
}

// Window-manager chrome for docked mode: immovable, non-resizable, no traffic
// lights, parented to the main window so AppKit moves it atomically with the
// app and keeps it stacked above it.
function applyDockedPreviewChrome(window: BrowserWindow): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    window.setParentWindow(mainWindow)
  }
  window.setMovable(false)
  window.setResizable(false)
  if (isMac) {
    window.setWindowButtonVisibility(false)
  }
  window.setAlwaysOnTop(false)
}

function removeDockedPreviewChrome(window: BrowserWindow): void {
  window.setParentWindow(null)
  window.setMovable(true)
  window.setResizable(true)
  if (isMac) {
    window.setWindowButtonVisibility(true)
  }
  if (previewWindowAlwaysOnTop) {
    window.setAlwaysOnTop(true, 'floating')
  }
}

// The window HTML is a static data URL with no scripting of its own; the docked
// variant (no drag bar) is toggled by a body class from main.
function setDockedPreviewChromeClass(window: BrowserWindow, docked: boolean): void {
  window.webContents
    .executeJavaScript(`document.body.classList.toggle('docked', ${docked ? 'true' : 'false'})`)
    .catch(() => {
      // Cosmetic only: a failed toggle leaves the drag bar visible, never
      // breaks placement.
    })
}

// A dock engage invalidates every earlier slot measurement: bump the epoch the
// renderer must echo and drop the cached slot until a fresh report lands. The
// docked window stays hidden until then (decideDockVisibility: no-slot-report).
function engageDockedPreviewPlacement(window: BrowserWindow): void {
  previewDockEpoch += 1
  previewDockSlot = null
  if (window.isVisible() && currentPreviewWindowMode() === 'docked') {
    window.hide()
  }
  queueDockedPreviewPlacement()
}

async function setPreviewWindowMode(rawMode: unknown): Promise<PreviewWindowState> {
  const mode = parsePreviewWindowMode(rawMode)
  if (mode === currentPreviewWindowMode()) {
    return previewWindowState()
  }
  previewWindowMode = mode
  previewWindowModeLoaded = true
  savePreviewWindowPrefs({ mode })
  const window = previewWindowIsOpenForSurface() ? previewWindow : null
  if (window) {
    if (mode === 'docked') {
      // Remember where floating lived so undock (and close-while-docked) can
      // restore it.
      previewWindowFloatingFrame = window.getBounds()
      savePreviewWindowPrefs({ frame: previewWindowFloatingFrame })
      applyDockedPreviewChrome(window)
      applyPreviewWindowAspect(window)
      setDockedPreviewChromeClass(window, true)
      engageDockedPreviewPlacement(window)
    } else {
      removeDockedPreviewChrome(window)
      setDockedPreviewChromeClass(window, false)
      const frame = previewWindowFloatingFrame ?? previewWindowLastFrame
      if (frame) {
        window.setBounds(clampFrameToWorkArea(frame))
      }
      applyPreviewWindowAspect(window)
      if (!window.isVisible()) {
        window.show()
      }
      pushPreviewWindowPlacement()
    }
  }
  emitPreviewWindowState()
  return previewWindowState()
}

function reportPreviewDockSlot(raw: unknown): PreviewWindowState {
  const report = parseDockSlotReport(raw)
  // Stale-epoch reports (measured before the latest dock engage) are dropped —
  // the exact race that made the 2026-06-09 glue attempt resurface bounds.
  if (report && report.epoch === previewDockEpoch) {
    previewDockSlot = report
    queueDockedPreviewPlacement()
  }
  return previewWindowState()
}

function setPreviewDockOverlayOpen(open: boolean): PreviewWindowState {
  if (previewDockOverlayOpen !== open) {
    previewDockOverlayOpen = open
    queueDockedPreviewPlacement()
  }
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

async function togglePreviewWindow(expectedOpen?: boolean): Promise<PreviewWindowState> {
  const action = previewWindowTargetAction(previewWindowIsOpenForSurface(), expectedOpen)
  if (action === 'close') {
    return closePreviewWindow()
  }
  if (action === 'open') {
    return openPreviewWindow()
  }
  return previewWindowState()
}

function setPreviewWindowAlwaysOnTop(alwaysOnTop: boolean): PreviewWindowState {
  previewWindowAlwaysOnTop = alwaysOnTop
  // While docked the window must stay at normal level (it is part of the app);
  // the preference is stored and re-applied on undock.
  if (previewWindow && !previewWindow.isDestroyed() && currentPreviewWindowMode() !== 'docked') {
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
    nativePreviewHostAttached: false,
    pendingHostCommandCount: pendingNativePreviewHostCommandCount(),
    updatedAt: new Date().toISOString(),
    message
  }
}

function pendingNativePreviewHostCommandCount(): number {
  return nativePreviewSurfaceMutationQueue.pendingCount + nativePreviewPlacementQueue.pendingCount
}

function nativePreviewPlacementStatusFields(): Pick<
  PreviewSurfaceStatus,
  | 'nativePreviewPlacementEventsReceived'
  | 'nativePreviewPlacementsCoalesced'
  | 'nativePreviewPlacementsApplied'
  | 'nativePreviewPlacementRoundTripP95Ms'
  | 'nativePreviewMutationQueueCapacity'
  | 'nativePreviewMutationQueueDepth'
  | 'nativePreviewMutationQueueActiveCount'
  | 'nativePreviewMutationQueuePendingCount'
  | 'nativePreviewMutationQueueMaxDepth'
  | 'nativePreviewMutationQueueRejectedCount'
  | 'pendingHostCommandCount'
> {
  const metrics = nativePreviewPlacementQueue.metrics()
  const mutationMetrics = nativePreviewSurfaceMutationQueue.metrics()
  return {
    nativePreviewPlacementEventsReceived: metrics.received,
    nativePreviewPlacementsCoalesced: metrics.coalesced,
    nativePreviewPlacementsApplied: metrics.applied,
    nativePreviewPlacementRoundTripP95Ms: metrics.roundTripP95Ms,
    nativePreviewMutationQueueCapacity: mutationMetrics.capacity,
    nativePreviewMutationQueueDepth: mutationMetrics.currentDepth,
    nativePreviewMutationQueueActiveCount: mutationMetrics.activeCount,
    nativePreviewMutationQueuePendingCount: mutationMetrics.pendingCount,
    nativePreviewMutationQueueMaxDepth: mutationMetrics.maxDepth,
    nativePreviewMutationQueueRejectedCount: mutationMetrics.rejected,
    pendingHostCommandCount: pendingNativePreviewHostCommandCount()
  }
}

function accountUnpresentedNativePreviewFrame(
  status: PreviewSurfaceStatus,
  frameId: number
): ReturnType<typeof accountSkippedPreviewFrame> & {
  nativePreviewMainCoalescedFrameCount?: number
} {
  return status.nativePreviewHostKind === 'in-process'
    ? accountCoalescedPreviewFrame(status, frameId)
    : accountSkippedPreviewFrame(status, frameId)
}

function backendPreviewFrameUrl(
  path: '/preview/camera/latest.bmp' | '/preview/screen/latest.bmp',
  maxWidth?: number
): string | undefined {
  if (
    !nativePreviewFramePollingEnabled ||
    nativePreviewSurfaceFramePollingSuppressed ||
    !backendConnection
  ) {
    return undefined
  }
  const baseUrl =
    process.env.VIDEORC_SMOKE_PREVIEW_FRAME_POLLING === '1'
      ? smokePreviewFrameUrl()
      : `http://${backendConnection.host}:${backendConnection.port}${path}?${new URLSearchParams({ token: backendConnection.token }).toString()}`
  return nativePreviewProofFrameUrl(baseUrl, maxWidth)
}

function fileUrlFromPath(path: string): string {
  if (path.startsWith(`${MANAGED_ASSET_SCHEME}://`)) {
    return path
  }
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

function insetTransformForBackground(
  transform: SceneTransform,
  stageMargin: number
): SceneTransform {
  const stageScale = 1 - stageMargin * 2
  return {
    ...transform,
    x: stageMargin + transform.x * stageScale,
    y: stageMargin + transform.y * stageScale,
    width: transform.width * stageScale,
    height: transform.height * stageScale
  }
}

function transformForPreviewBackground(
  transform: SceneTransform,
  sourceKind: PreviewSurfaceSceneLayerKind,
  stageMargin: number
): SceneTransform {
  return stageMargin > 0 && previewLayerUsesBackgroundStage(sourceKind)
    ? insetTransformForBackground(transform, stageMargin)
    : transform
}

function previewLayerUsesBackgroundStage(sourceKind: PreviewSurfaceSceneLayerKind): boolean {
  return ['screen', 'window', 'screen-image', 'test-pattern'].includes(sourceKind)
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

// A floor on the requested full-canvas width so preview frames stay sharp even
// before the surface reports bounds (drawable would otherwise be undefined → the
// backend uses its low frame-width default) or when a non-Retina scaleFactor understates
// the device pixels. Per-layer requests still scale by the layer's fraction of
// the canvas and stay capped at the source's real width.
const PREVIEW_MIN_DRAWABLE_WIDTH = 1280
// Upper bound on a single requested frame width so a large window on a 4K/5K
// Retina panel can't ask for an enormous raw frame every poll. 1920 is plenty sharp
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
    return backendPreviewFrameUrl('/preview/camera/latest.bmp', maxWidth)
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/latest.bmp', maxWidth)
  }
  return undefined
}

function buildPreviewSurfaceScene(
  params: PreviewSurfaceSceneUpdateParams
): PreviewSurfaceSceneState {
  const backgroundLayer = previewBackgroundLayer(params.scene)
  const backgroundStageMargin = backgroundLayer
    ? previewProofBackgroundStageMargin(params.scene?.background)
    : 0
  const layers: PreviewSurfaceSceneLayer[] = [
    ...(backgroundLayer ? [backgroundLayer] : []),
    ...(params.scene?.sources ?? []).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      transform: transformForPreviewBackground(
        source.transform,
        source.kind,
        backgroundStageMargin
      ),
      visible: source.visible,
      frameUrl: nativePreviewSurfaceFramePollingSuppressed
        ? undefined
        : previewLayerFrameUrl(source),
      fit: previewProofLayerFit(source, params.layout),
      mirror: source.kind === 'camera' ? params.layout.cameraMirror : false,
      shape: previewProofLayerShape(source, params.layout)
    }))
  ]

  const activeScreen: StreamScreen | null | undefined = params.activeScreen
  if (activeScreen?.status === 'ready') {
    layers.push({
      id: `screen-image:${activeScreen.id}`,
      name: activeScreen.name,
      kind: 'screen-image',
      transform: transformForPreviewBackground(
        fullFrameTransform(),
        'screen-image',
        backgroundStageMargin
      ),
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
    backgroundStageMargin,
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
  const backgroundStageMargin = backgroundLayer
    ? (nativePreviewSurfaceScene?.backgroundStageMargin ??
      nativePreviewCommittedCompositorScene?.backgroundStageMargin ??
      0)
    : 0
  const layers: PreviewSurfaceSceneLayer[] = [
    ...(backgroundLayer ? [backgroundLayer] : []),
    ...(status.sceneSources ?? []).filter(compositorSceneSourceIsPreviewLayer).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      transform: transformForPreviewBackground(
        source.transform,
        source.kind,
        backgroundStageMargin
      ),
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
    backgroundStageMargin,
    updatedAt: status.updatedAt
  }
}

function compositorSceneSourceIsPreviewLayer(
  source: CompositorSceneSourceStatus
): source is CompositorSceneSourceStatus & { kind: PreviewSurfaceSceneLayerKind } {
  return source.kind !== 'background-image'
}

function sceneRevisionIsSafeInteger(revision: unknown): revision is number {
  return typeof revision === 'number' && Number.isSafeInteger(revision)
}

function protectNativePreviewSceneRevision(revision: number): void {
  nativePreviewPendingSceneRevision = revision
  nativePreviewSurfaceSceneRevisionGuardUntilMs = Date.now() + 2000
}

function markNativePreviewSceneRevisionPresented(
  status: PreviewSurfaceCompositorUpdateParams
): void {
  if (
    nativePreviewPendingSceneRevision === null ||
    !sceneRevisionIsSafeInteger(status.sceneRevision) ||
    status.sceneRevision < nativePreviewPendingSceneRevision
  ) {
    return
  }
  if (
    sceneRevisionIsSafeInteger(status.frameSceneRevision) &&
    status.frameSceneRevision < nativePreviewPendingSceneRevision
  ) {
    return
  }

  nativePreviewPendingSceneRevision = null
  nativePreviewSurfaceSceneRevisionGuardUntilMs = Date.now() + 500
}

function shouldRejectOlderPreviewSceneRevision(revision: unknown, sceneId?: string): boolean {
  const currentScene = nativePreviewSurfaceScene
  const currentRevision = currentScene?.revision
  return (
    sceneRevisionIsSafeInteger(currentRevision) &&
    sceneRevisionIsSafeInteger(revision) &&
    revision < currentRevision &&
    ((Boolean(currentScene?.sceneId) && currentScene?.sceneId === sceneId) ||
      Date.now() < nativePreviewSurfaceSceneRevisionGuardUntilMs)
  )
}

function previewSurfaceSceneIsOlderThanCurrent(scene: PreviewSurfaceSceneState): boolean {
  return shouldRejectOlderPreviewSceneRevision(scene.revision, scene.sceneId)
}

function compositorSceneRevisionBehindCurrent(
  status: PreviewSurfaceCompositorUpdateParams
): boolean {
  return shouldRejectOlderPreviewSceneRevision(status.sceneRevision, status.sceneId)
}

function compositorLayerFrameUrl(
  source: CompositorStatus['sceneSources'][number]
): string | undefined {
  const maxWidth = previewLayerSnapshotWidth(source.transform, source.width)
  if (source.kind === 'camera') {
    return backendPreviewFrameUrl('/preview/camera/latest.bmp', maxWidth)
  }
  if (source.kind === 'screen' || source.kind === 'window') {
    return backendPreviewFrameUrl('/preview/screen/latest.bmp', maxWidth)
  }
  return undefined
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function nativePreviewSurfaceHtml(initialScene: PreviewSurfaceSceneState | null): string {
  const scriptNonce = randomBytes(24).toString('base64url')
  const contentSecurityPolicy = nativePreviewSurfaceDocumentCsp(scriptNonce)
  const initialSceneJson = jsonForInlineScript(initialScene)
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
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
    <script nonce="${scriptNonce}">
      (() => {
        const root = document.getElementById('scene-root');
        const readout = document.getElementById('readout');
        const layers = new Map();
        const pollers = new Map();
        const sourceFrames = new Map();
        let framePollingSuppressed = false;
        let framePollingIntervalMs = 40;
        let framePollingMaxWidth = 1920;
        let proofSurfaceSuspended = false;
        let animationFrameId = null;
        let compositorStatus = null;
        let pendingCompositorStatus = null;
        let pendingCompositorReceivedAt = 0;
        let compositorFrames = 0;
        let presentedCompositorFrame = 0;
        let skippedCompositorFrames = 0;
        let scene = ${initialSceneJson};
        let frames = 0;
        let blankFrames = 0;
        let liveLayerCount = 0;
        let proofMeasurementEpoch = createNativePreviewProofMeasurementEpoch(
          performance.now(),
          blankFrames,
          skippedCompositorFrames
        );

        function percent(value) {
          const next = Number.isFinite(value) ? value : 0;
          return String(next * 100) + '%';
        }

        function profiledFrameUrl(url) {
          try {
            const parsed = new URL(url);
            const requested = Number(parsed.searchParams.get('maxWidth'));
            const maxWidth = Number.isFinite(requested) && requested > 0
              ? Math.min(requested, framePollingMaxWidth)
              : framePollingMaxWidth;
            parsed.searchParams.set('maxWidth', String(Math.max(1, Math.round(maxWidth))));
            return parsed.toString();
          } catch {
            return url;
          }
        }

        function frameRequestUrl(url, poller) {
          const profiled = profiledFrameUrl(url);
          try {
            const parsed = new URL(profiled);
            if (
              typeof poller.generation === 'string' &&
              poller.generation.length > 0 &&
              Number.isSafeInteger(poller.sequence) &&
              poller.sequence >= 0
            ) {
              parsed.searchParams.set('afterGeneration', poller.generation);
              parsed.searchParams.set('afterSequence', String(poller.sequence));
            }
            return parsed.toString();
          } catch {
            return profiled;
          }
        }

        function responseFrameCursor(response) {
          const generation = response.headers.get('x-videorc-frame-generation');
          const rawSequence = response.headers.get('x-videorc-frame-sequence');
          const sequence = rawSequence === null ? Number.NaN : Number(rawSequence);
          return typeof generation === 'string' && generation.length > 0 && Number.isSafeInteger(sequence) && sequence >= 0
            ? { generation, sequence }
            : null;
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

        function layerBorderRadius(layer) {
          if (layer.shape === 'circle') {
            return '9999px';
          }
          if (layer.shape !== 'rounded') {
            return '0';
          }
          const transform = layer.transform ?? {};
          const width = root.clientWidth * Math.max(0, Number(transform.width ?? 0));
          const height = root.clientHeight * Math.max(0, Number(transform.height ?? 0));
          const radiusPct = Math.min(
            50,
            Math.max(0, Number(scene?.layout?.cameraCornerRadiusPct ?? 0))
          );
          return String(Math.min(width, height) * radiusPct / 100) + 'px';
        }

        function refreshLayerMasks() {
          for (const entry of layers.values()) {
            if (entry.layer) {
              entry.element.style.borderRadius = layerBorderRadius(entry.layer);
            }
          }
        }

        ${NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT}
        ${NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT}

        function markLive(kind, sourceId) {
          sourceFrames.set(sourceId, (sourceFrames.get(sourceId) ?? 0) + 1);
          const poller = pollers.get(sourceId);
          if (poller) {
            markProofPollerFrameAdvance(poller, performance.now());
          }
          liveLayerCount = [...layers.values()].filter(({ image }) => image?.dataset.live === '1').length;
          if (liveLayerCount > 0) {
            document.body.classList.add('surface-live');
          }
          readout.textContent = kind === 'screen-image' ? 'native scene + screen image' : 'native scene source';
        }

        function stopMissingPollers(activeIds) {
          for (const id of Array.from(pollers.keys())) {
            if (!activeIds.has(id)) {
              stopLayerPoller(id);
            }
          }
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

        function setFramePollingProfile(profile) {
          const intervalMs = Number(profile?.intervalMs);
          const maxWidth = Number(profile?.maxWidth);
          if (Number.isFinite(intervalMs) && intervalMs >= 20) {
            framePollingIntervalMs = Math.round(intervalMs);
          }
          if (Number.isFinite(maxWidth) && maxWidth >= 1) {
            framePollingMaxWidth = Math.round(maxWidth);
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
          const preservedFrame = existing
            ? stopLayerPoller(id, { preserveFrame: true })
            : null;
          const poller = {
            url,
            image,
            cancelled: false,
            pending: false,
            startedAt: preservedFrame?.startedAt ?? performance.now(),
            lastFrameAdvanceAt: preservedFrame?.lastFrameAdvanceAt ?? null,
            lastTransportSuccessAt: preservedFrame?.lastTransportSuccessAt ?? null,
            generation: null,
            sequence: null,
            objectUrl: preservedFrame?.objectUrl ?? null,
            abortController: null
          };
          pollers.set(id, poller);

          const poll = async () => {
            if (poller.cancelled) {
              return;
            }
            if (poller.pending) {
              window.setTimeout(poll, framePollingIntervalMs);
              return;
            }
            poller.pending = true;
            let retryDelayMs = framePollingIntervalMs;
            const abortController = new AbortController();
            poller.abortController = abortController;
            try {
              const response = await fetch(frameRequestUrl(url, poller), {
                cache: 'no-store',
                signal: abortController.signal
              });
              if (poller.cancelled) {
                return;
              }
              const cursor = responseFrameCursor(response);
              if (response.status === 204) {
                markProofPollerTransportSuccess(poller, performance.now());
                if (cursor) {
                  poller.generation = cursor.generation;
                  poller.sequence = cursor.sequence;
                }
                // Transport is healthy, but the source frame did not advance.
                // Keep the last decoded image while the liveness clock ages.
                return;
              }
              if (!response.ok) {
                throw new Error('Preview frame request failed with status ' + response.status);
              }
              markProofPollerTransportSuccess(poller, performance.now());
              const blob = await response.blob();
              if (poller.cancelled) {
                return;
              }
              const objectUrl = URL.createObjectURL(blob);
              const next = new Image();
              next.decoding = 'async';
              try {
                await new Promise((resolve, reject) => {
                  next.onload = resolve;
                  next.onerror = reject;
                  next.src = objectUrl;
                });
              } catch (error) {
                URL.revokeObjectURL(objectUrl);
                throw error;
              }
              if (poller.cancelled) {
                URL.revokeObjectURL(objectUrl);
                return;
              }
              if (proofImageIsBlank(next)) {
                blankFrames += 1;
                URL.revokeObjectURL(objectUrl);
                throw new Error('Preview frame decoded without any visible pixels.');
              }
              presentProofPollerFrame(poller, objectUrl);
              if (cursor) {
                poller.generation = cursor.generation;
                poller.sequence = cursor.sequence;
              }
              markLive(kind, id);
            } catch (error) {
              if (!poller.cancelled && error?.name !== 'AbortError') {
                retryDelayMs = Math.max(250, framePollingIntervalMs);
              }
            } finally {
              if (poller.abortController === abortController) {
                poller.abortController = null;
              }
              poller.pending = false;
              if (!poller.cancelled) {
                window.setTimeout(poll, retryDelayMs);
              }
            }
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

          entry.layer = layer;
          const { element, image } = entry;
          const transform = layer.transform ?? {};
          element.dataset.kind = layer.kind ?? 'unknown';
          element.dataset.visible = layer.visible === false ? '0' : '1';
          element.style.display = layer.visible === false ? 'none' : 'block';
          element.style.left = percent(transform.x);
          element.style.top = percent(transform.y);
          element.style.width = percent(transform.width || 0);
          element.style.height = percent(transform.height || 0);
          element.style.borderRadius = layerBorderRadius(layer);
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
        window.__videorcSetFramePollingProfile = setFramePollingProfile;
        window.addEventListener('resize', refreshLayerMasks);

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
            const inputToPresentLatencyMs = Math.max(
              0,
              Math.round(frameAgeMs + Math.max(0, now - receivedAt))
            );
            recordNativePreviewProofMeasurementLatency(
              proofMeasurementEpoch,
              inputToPresentLatencyMs
            );
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

        function scheduleTick() {
          if (!proofSurfaceSuspended && animationFrameId === null) {
            animationFrameId = requestAnimationFrame(tick);
          }
        }

        function setProofSurfaceSuspended(suspended) {
          const next = suspended === true;
          if (proofSurfaceSuspended === next) {
            return;
          }
          proofSurfaceSuspended = next;
          if (proofSurfaceSuspended) {
            if (animationFrameId !== null) {
              cancelAnimationFrame(animationFrameId);
              animationFrameId = null;
            }
            stopAllPollers();
            return;
          }
          frames = 0;
          proofMeasurementEpoch = createNativePreviewProofMeasurementEpoch(
            performance.now(),
            blankFrames,
            skippedCompositorFrames
          );
          applyScene(scene);
          scheduleTick();
        }

        window.__videorcSetProofSurfaceSuspended = setProofSurfaceSuspended;
        window.__videorcResetNativePreviewMeasurement = () => {
          proofMeasurementEpoch = createNativePreviewProofMeasurementEpoch(
            performance.now(),
            blankFrames,
            skippedCompositorFrames
          );
        };

        function tick(now) {
          animationFrameId = null;
          if (proofSurfaceSuspended) {
            return;
          }
          frames += 1;
          recordNativePreviewProofMeasurementFrame(proofMeasurementEpoch, now);
          presentLatestCompositorStatus(now);
          if (!compositorStatus) {
            const x = (now * 0.045) % Math.max(1, window.innerWidth + 140);
            document.body.style.setProperty('--dot-x', String((x / Math.max(1, window.innerWidth)) * 100) + '%');
            document.body.style.setProperty('--offset', String((now * 0.08) % 240) + 'px');
            document.body.style.setProperty('--stripe-offset', String((now * 0.18) % 120) + 'px');
          }
          window.__videorcNativePreviewMetrics = () => {
            const measuredAt = performance.now();
            const measurement = nativePreviewProofMeasurementSnapshot(
              proofMeasurementEpoch,
              measuredAt,
              blankFrames,
              skippedCompositorFrames
            );
            const sourceFrameAges = [...pollers.values()].map((poller) =>
              proofPollerFrameAgeMs(poller, measuredAt)
            );
            const sourceTransportAges = [...pollers.values()].map((poller) =>
              proofPollerTransportAgeMs(poller, measuredAt)
            );
            const sourceFrameAgeMs = sourceFrameAges.length > 0
              ? Math.max(...sourceFrameAges)
              : null;
            const sourceTransportAgeMs = sourceTransportAges.length > 0
              ? Math.max(...sourceTransportAges)
              : null;
            const sourceFreshnessBudgetMs = Math.max(1500, framePollingIntervalMs * 8);
            const freshSourceLayerCount = [...pollers.values()].filter((poller) =>
              proofPollerFrameIsFresh(poller, measuredAt, sourceFreshnessBudgetMs)
            ).length;
            const healthySourceTransportCount = [...pollers.values()].filter((poller) =>
              proofPollerTransportIsFresh(poller, measuredAt, sourceFreshnessBudgetMs)
            ).length;
            return {
              frames,
              measuredFps: measurement.measuredFps,
              sceneRevision: scene?.revision ?? null,
              compositorSceneRevision: compositorStatus?.sceneRevision ?? null,
              sceneMatchesCompositor: compositorStatus?.sceneRevision == null
                ? null
                : scene?.revision === compositorStatus.sceneRevision,
              compositorState: compositorStatus?.state ?? null,
              compositorFrames,
              presentedCompositorFrame,
              compositorFrameLag: Math.max(0, compositorFrames - presentedCompositorFrame),
              skippedCompositorFrames: measurement.skippedCompositorFrames,
              inputToPresentLatencyMs: measurement.inputToPresentLatencyMs,
              inputToPresentLatencyP50Ms: measurement.inputToPresentLatencyP50Ms,
              inputToPresentLatencyP95Ms: measurement.inputToPresentLatencyP95Ms,
              inputToPresentLatencyP99Ms: measurement.inputToPresentLatencyP99Ms,
              compositorSources: compositorStatus?.sources ?? [],
              layerCount: layers.size,
              sourcePollerCount: pollers.size,
              liveLayerCount,
              freshSourceLayerCount,
              sourceFrames: Object.fromEntries(sourceFrames),
              sourceFrameAgeMs,
              sourceTransportAgeMs,
              healthySourceTransportCount,
              intervalP50Ms: measurement.intervalP50Ms,
              intervalP95Ms: measurement.intervalP95Ms,
              intervalP99Ms: measurement.intervalP99Ms,
              framePollingSuppressed,
              framePollingIntervalMs,
              framePollingMaxWidth,
              proofSurfaceSuspended,
              sourcePixelsPresent: liveLayerCount > 0,
              blankFrames: measurement.blankFrames,
              width: window.innerWidth,
              height: window.innerHeight
            };
          };
          scheduleTick();
        }

        applyScene(scene);
        scheduleTick();
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
      // Transparency requires the GPU compositor on Windows — with a broken
      // GPU process (Windows Insider builds) a transparent window composites
      // NOTHING and the preview reads as a blank canvas even though the <img>
      // polling underneath is fully software-safe. Off macOS the surface is
      // opaque over a solid dark base; macOS keeps transparency (its real
      // preview path is the CAMetalLayer helper anyway).
      transparent: isMac,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      // Placement is owned by the preview window; the proof surface is never
      // user-movable and never a click target.
      movable: false,
      show: false,
      backgroundColor: isMac ? '#00000000' : '#101014',
      ...appWindowIconOptions(),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true
      }
    })
    nativePreviewSurfaceWindow = surfaceWindow
    surfaceWindow.setIgnoreMouseEvents(true)
    surfaceWindow.on('closed', () => {
      if (nativePreviewSurfaceWindow === surfaceWindow) {
        nativePreviewSurfaceWindow = null
        nativePreviewAppliedProofPollingSuppression = null
        nativePreviewAppliedProofPollingProfile = null
        nativePreviewProofAnimationSuspended = null
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
      await syncNativePreviewProofPollingProfile()
      const proofPollingSuppressed = nativePreviewProofPollingIsSuppressed()
      if (proofPollingSuppressed) {
        await waitForNativePreviewSurfaceScript(surfaceWindow)
        if (!surfaceWindow.isDestroyed() && previewWindowSurfaceGenerationIsCurrent(generation)) {
          await surfaceWindow.webContents.executeJavaScript(
            'window.__videorcSetFramePollingSuppressed?.(true)',
            true
          )
        }
      }
      nativePreviewAppliedProofPollingSuppression = proofPollingSuppressed
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
  const preserveNativeSurface =
    nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus) &&
    nativeSurfaceOwnsPlacement()
  await setNativePreviewProofAnimationSuspended(preserveNativeSurface || !placement.visible)
  const fallbackMessage = nativePreviewSurfaceScene
    ? 'Electron proof scene preview surface.'
    : 'Synthetic Electron proof preview surface.'
  nativePreviewSurfaceStatus = {
    ...(preserveNativeSurface ? nativePreviewSurfaceStatus : {}),
    state: 'live',
    source: nativePreviewSurfaceScene?.sources.some(
      (source) => source.kind === 'screen' || source.kind === 'window'
    )
      ? 'screen'
      : nativePreviewSurfaceScene?.sources.some((source) => source.kind === 'camera')
        ? 'camera'
        : 'synthetic',
    transport: preserveNativeSurface
      ? nativePreviewSurfaceStatus.transport
      : 'electron-proof-surface',
    backing: preserveNativeSurface ? nativePreviewSurfaceStatus.backing : 'electron-browser-window',
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
    framePollingSuppressed: nativePreviewProofPollingIsSuppressed(),
    sourcePixelsPresent: nativePreviewSurfaceStatus.sourcePixelsPresent,
    firstFrameContract: nativePreviewSurfaceStatus.firstFrameContract,
    firstFrameReason: nativePreviewSurfaceStatus.firstFrameReason,
    nativePreviewHostKind: preserveNativeSurface
      ? nativePreviewSurfaceStatus.nativePreviewHostKind
      : 'proof-surface',
    nativePreviewHostAttached: preserveNativeSurface
      ? nativePreviewSurfaceStatus.nativePreviewHostAttached
      : false,
    ...nativePreviewPlacementStatusFields(),
    bounds,
    startedAt: nativePreviewSurfaceStatus.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: preserveNativeSurface ? nativePreviewSurfaceStatus.message : fallbackMessage
  }
  if (preserveNativeSurface) {
    previewSupervisor.surfaceLive({
      generation,
      transport: nativePreviewSurfaceStatus.transport,
      backing: nativePreviewSurfaceStatus.backing
    })
  } else {
    previewSupervisor.surfaceFallback(
      generation,
      nativePreviewSurfaceStatus.message ?? 'Electron proof preview surface.'
    )
  }
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
  const preserveNativeSurface =
    nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus) &&
    nativeSurfaceOwnsPlacement()
  await setNativePreviewProofAnimationSuspended(preserveNativeSurface || !placement.visible)
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    state: 'live',
    source: nativePreviewSurfaceStatus.source,
    transport: preserveNativeSurface
      ? nativePreviewSurfaceStatus.transport
      : 'electron-proof-surface',
    backing: preserveNativeSurface ? nativePreviewSurfaceStatus.backing : 'electron-browser-window',
    width: rect.width,
    height: rect.height,
    droppedFrames: nativePreviewSurfaceStatus.droppedFrames ?? 0,
    nativePreviewHostKind: preserveNativeSurface
      ? nativePreviewSurfaceStatus.nativePreviewHostKind
      : 'proof-surface',
    nativePreviewHostAttached: preserveNativeSurface
      ? nativePreviewSurfaceStatus.nativePreviewHostAttached
      : false,
    ...nativePreviewPlacementStatusFields(),
    bounds,
    updatedAt: new Date().toISOString()
  }
  return nativePreviewSurfaceStatus
}

async function showNativePreviewProofSurfaceIfVisible(): Promise<void> {
  nativePreviewNativeOwnsProofPollingSuppression = false
  await syncNativePreviewProofPollingSuppression()
  await setNativePreviewProofAnimationSuspended(false)
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
    // Docked previews are part of the app: never elevated above other apps,
    // whatever the (floating-mode) always-on-top preference says.
    const elevated = previewWindowAlwaysOnTop && currentPreviewWindowMode() !== 'docked'
    commands = commands.map((command) =>
      command.bounds
        ? {
            ...command,
            bounds: { ...command.bounds, orderAboveWindowId, elevated }
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

async function drainBackendNativePreviewHostCommands(
  generation = previewWindowSurfaceGeneration()
): Promise<PreviewSurfaceStatus> {
  if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
    return nativePreviewSurfaceStatus
  }
  return drainNativePreviewHostCommandsWith({
    generation,
    takeCommands: () =>
      requestBackendAdmin<NativePreviewHostCommand[]>('preview.surface.take_native_host_commands'),
    applyCommands: (commands, requestedGeneration) =>
      runNativePreviewSurfaceMutation(() =>
        applyNativePreviewHostCommands(commands, requestedGeneration)
      ),
    currentStatus: () => nativePreviewSurfaceStatus
  })
}

// Push a visibility-only bounds update to both surface hosts using the current
// detached preview-window rect.
async function setNativePreviewSurfacesVisible(visible: boolean): Promise<void> {
  const bounds = previewWindowSurfaceBounds(visible)
  if (!bounds) {
    return
  }
  const generation = previewWindowSurfaceGeneration()
  nativePreviewPlacementQueue.enqueue({ bounds, generation })
  await nativePreviewPlacementQueue.waitForIdle()
}

// Disable the native driver without leaving a layer/window behind. The primary
// in-process addon may resolve again after a cooldown; the separate helper is
// considered only when its explicit diagnostic fallback flag is enabled.
async function disableNativePreviewRealSurfaceDriver(reason: string): Promise<void> {
  const driver = nativePreviewRealSurfaceDriver
  nativePreviewRealSurfaceDriver = null
  nativePreviewRealSurfaceDriverKind = null
  nativePreviewRealSurfaceInvalidActivationCount = 0
  nativePreviewRealSurfaceDriverUnavailableReason = reason
  nativePreviewHelperProcessDriverResolved = false
  const retryAtMs = Date.now() + NATIVE_PREVIEW_HELPER_RETRY_COOLDOWN_MS
  nativePreviewPrimaryDriverRetryAtMs = retryAtMs
  nativePreviewHelperDriverRetryAtMs = retryAtMs
  nativePreviewNativeOwnsProofPollingSuppression = false
  nativePreviewNativeFailureFallbackActive = previewWindowIsOpenForSurface()
  clearNativePreviewNativePlacementAuthority()
  try {
    driver?.stop?.()
  } catch {
    // The helper is already unreachable; nothing left to tear down.
  }
  if (nativePreviewNativeFailureFallbackActive) {
    nativePreviewSurfaceStatus = nativePreviewDriverFailureFallbackStatus(
      nativePreviewSurfaceStatus,
      {
        reason,
        framePollingSuppressed: nativePreviewProofPollingIsSuppressed()
      }
    )
    await showNativePreviewProofSurfaceIfVisible()
  } else {
    nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus(reason)
  }
}

async function resetNativePreviewRealSurfaceDriver(reason: string): Promise<void> {
  await nativePreviewSurfaceMutationQueue.run(async () => {
    await runNativePreviewDriverReset({
      retire: () => disableNativePreviewRealSurfaceDriver(reason),
      allowImmediateRetry: () => {
        nativePreviewHelperDriverRetryAtMs = 0
        nativePreviewPrimaryDriverRetryAtMs = 0
        nativePreviewRealSurfaceInvalidActivationCount = 0
      },
      reconcile: () => reconcileNativePreviewSurfaceForPreviewWindow({ force: true })
    })
  })
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
    const status = await driver.applyHostCommands(commands)
    if (status && nativePreviewSurfaceStatusIsRealSurface(status)) {
      nativePreviewNativePresentConfirmedAtMs = Date.now()
    }
  } catch (error) {
    await disableNativePreviewRealSurfaceDriver(
      `Real CAMetalLayer IOSurface presenter module failed while applying host commands: ${errorMessage(error)}`
    )
  }
}

async function runNativePreviewSurfaceMutation(
  operation: () => PreviewSurfaceStatus | Promise<PreviewSurfaceStatus>
): Promise<PreviewSurfaceStatus> {
  return nativePreviewSurfaceMutationQueue.run(operation)
}

async function updateNativePreviewSurfaceScene(
  params: PreviewSurfaceSceneUpdateParams
): Promise<PreviewSurfaceStatus> {
  const generation = previewWindowSurfaceGeneration()
  return runNativePreviewSurfaceMutation(() => applyNativePreviewSurfaceScene(params, generation))
}

async function applyNativePreviewSurfaceScene(
  params: PreviewSurfaceSceneUpdateParams,
  generation: number
): Promise<PreviewSurfaceStatus> {
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
  }
  if (sceneRevisionIsSafeInteger(params.revision)) {
    protectNativePreviewSceneRevision(params.revision)
  }
  nativePreviewSurfaceScene = buildPreviewSurfaceScene(params)
  await reconcileNativePreviewSurfaceForPreviewWindow()
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
  }
  const surfaceWindow = nativePreviewSurfaceWindow
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript()
    if (!nativePreviewPresentationAllowedForGeneration(generation)) {
      return nativePreviewSurfaceStatus
    }
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
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
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
  status: PreviewSurfaceCompositorUpdateParams,
  options: { ownershipTicket?: NativePreviewPumpOwnershipTicket } = {}
): Promise<PreviewSurfaceStatus> {
  const generation = previewWindowSurfaceGeneration()
  const ownershipAllowed = (): boolean =>
    !options.ownershipTicket || nativePreviewPumpOwnership.accepts(options.ownershipTicket)
  if (!ownershipAllowed()) {
    return rejectedNativePreviewCompositorUpdateStatus()
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
      return runNativePreviewSurfaceMutation(() => {
        if (!nativePreviewPresentationAllowedForGeneration(generation) || !ownershipAllowed()) {
          return ownershipAllowed()
            ? nativePreviewSurfaceStatus
            : rejectedNativePreviewCompositorUpdateStatus()
        }
        nativePreviewSurfaceStatus = {
          ...nativePreviewSurfaceStatus,
          ...accountUnpresentedNativePreviewFrame(
            nativePreviewSurfaceStatus,
            status.framesRendered
          ),
          updatedAt: new Date().toISOString(),
          message: `Native preview skipped stale compositor frame ${status.framesRendered}; presenting the newest queued frame.`
        }
        return nativePreviewSurfaceStatus
      })
    }
  }

  const update = runPreparedNativePreviewMutation(nativePreviewSurfaceMutationQueue, {
    canApply: () => nativePreviewPresentationAllowedForGeneration(generation) && ownershipAllowed(),
    prepare: () => prepareNativePreviewSurfaceCompositor(status),
    apply: (effectiveStatus) =>
      presentNativePreviewSurfaceCompositor(effectiveStatus, { queueWaitMs }, generation),
    rejected: () =>
      ownershipAllowed()
        ? nativePreviewSurfaceStatus
        : rejectedNativePreviewCompositorUpdateStatus()
  })
  nativePreviewSurfaceCompositorUpdateInFlight = update
  try {
    return await update
  } finally {
    if (nativePreviewSurfaceCompositorUpdateInFlight === update) {
      nativePreviewSurfaceCompositorUpdateInFlight = null
    }
  }
}

function rejectedNativePreviewCompositorUpdateStatus(): PreviewSurfaceStatus {
  return { ...nativePreviewSurfaceStatus, compositorUpdateAccepted: false }
}

function nativePreviewPresentationAllowedForGeneration(generation: number): boolean {
  return (
    previewWindowSurfaceGenerationIsCurrent(generation) &&
    previewSurfacePresentationAllowed(generation)
  )
}

async function prepareNativePreviewSurfaceCompositor(
  status: PreviewSurfaceCompositorUpdateParams
): Promise<PreviewSurfaceCompositorUpdateParams> {
  if (status.suppressFramePolling === true && !nativePreviewSurfaceFramePollingSuppressed) {
    await setNativePreviewSurfaceFramePollingSuppressed(true)
  }
  return refreshNativePreviewCompositorStatus(status)
}

async function presentNativePreviewSurfaceCompositor(
  effectiveStatus: PreviewSurfaceCompositorUpdateParams,
  mainTiming: { queueWaitMs?: number } = {},
  generation = previewWindowSurfaceGeneration()
): Promise<PreviewSurfaceStatus> {
  clearNativePreviewMainSceneMismatch()
  const compositorRunDecision = nativePreviewCompositorRunAuthority.decision(effectiveStatus.runId)
  if (!compositorRunDecision.accepted) {
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      ...accountUnpresentedNativePreviewFrame(
        nativePreviewSurfaceStatus,
        effectiveStatus.framesRendered
      ),
      ...nativePreviewRendererTimingStatusFields(effectiveStatus),
      ...nativePreviewMainStatusRefreshFields(effectiveStatus),
      updatedAt: new Date().toISOString(),
      message: `Preview rejected retired compositor run ${effectiveStatus.runId}.`
    }
    return nativePreviewSurfaceStatus
  }
  const compositorScene = buildPreviewSurfaceSceneFromCompositorStatus(effectiveStatus)
  const compositorRunChanged = Boolean(compositorScene && compositorRunDecision.changed)
  const compositorSceneConflicts = Boolean(
    compositorScene &&
    nativePreviewCommittedCompositorScene &&
    compositorSceneConflictsWithCommitted(nativePreviewCommittedCompositorScene, compositorScene, {
      committedRunId: nativePreviewCommittedCompositorRunId,
      candidateRunId: effectiveStatus.runId
    })
  )
  const compositorSceneIsCurrent = compositorScene
    ? (compositorRunChanged || !previewSurfaceSceneIsOlderThanCurrent(compositorScene)) &&
      !compositorSceneConflicts
    : false
  if (compositorScene && compositorSceneIsCurrent) {
    nativePreviewSurfaceScene = compositorScene
    nativePreviewCommittedCompositorScene = compositorScene
    nativePreviewCommittedCompositorRunId = effectiveStatus.runId
    nativePreviewCompositorRunAuthority.commit(effectiveStatus.runId)
  }
  await reconcileNativePreviewSurfaceForPreviewWindow()
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
  }
  if (compositorSceneConflicts) {
    if (nativePreviewMainSceneMismatchCount === 0) {
      nativePreviewMainSceneMismatchStartedAtMs = Date.now()
    }
    nativePreviewMainSceneMismatchCount += 1
    nativePreviewMainLastSkippedSceneRevision = effectiveStatus.sceneRevision
    nativePreviewMainLastSkippedFrameSceneRevision = effectiveStatus.frameSceneRevision
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      ...accountUnpresentedNativePreviewFrame(
        nativePreviewSurfaceStatus,
        effectiveStatus.framesRendered
      ),
      ...nativePreviewRendererTimingStatusFields(effectiveStatus),
      ...nativePreviewMainStatusRefreshFields(effectiveStatus),
      ...nativePreviewMainSceneMismatchFields(),
      updatedAt: new Date().toISOString(),
      message: `Preview rejected conflicting scene content claiming committed revision ${effectiveStatus.sceneRevision}.`
    }
    return nativePreviewSurfaceStatus
  }
  if (!compositorRunChanged && compositorSceneRevisionBehindCurrent(effectiveStatus)) {
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      ...accountUnpresentedNativePreviewFrame(
        nativePreviewSurfaceStatus,
        effectiveStatus.framesRendered
      ),
      ...nativePreviewRendererTimingStatusFields(effectiveStatus),
      ...nativePreviewMainStatusRefreshFields(effectiveStatus),
      ...nativePreviewMainSceneMismatchFields(),
      updatedAt: new Date().toISOString(),
      message: `Preview waiting for compositor to render scene revision ${nativePreviewSurfaceScene?.revision ?? 'unknown'}.`
    }
    return nativePreviewSurfaceStatus
  }
  markNativePreviewSceneRevisionPresented(effectiveStatus)
  const realSurfaceAttempt = await tryPresentNativePreviewRealSurfaceCompositor(
    effectiveStatus,
    mainTiming,
    generation
  )
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
  }
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
  if (nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus)) {
    nativePreviewSurfaceStatus = {
      ...nativePreviewSurfaceStatus,
      ...accountUnpresentedNativePreviewFrame(
        nativePreviewSurfaceStatus,
        effectiveStatus.framesRendered
      ),
      ...nativePreviewRendererTimingStatusFields(effectiveStatus),
      ...nativePreviewMainStatusRefreshFields(effectiveStatus),
      ...nativePreviewMainSceneMismatchFields(),
      framePollingSuppressed: nativePreviewProofPollingIsSuppressed(),
      updatedAt: new Date().toISOString(),
      message:
        realSurfaceAttempt.reason ??
        'Native preview skipped a compositor frame without downgrading the active CAMetalLayer surface.'
    }
    previewSupervisor.surfaceLive({
      generation: previewWindowSurfaceGeneration(),
      transport: nativePreviewSurfaceStatus.transport,
      backing: nativePreviewSurfaceStatus.backing
    })
    return nativePreviewSurfaceStatus
  }
  if (effectiveStatus.suppressFramePolling !== true) {
    await showNativePreviewProofSurfaceIfVisible()
  }
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
  }
  let metrics: Record<string, unknown> | null = null
  const surfaceWindow = nativePreviewSurfaceWindow
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    await waitForNativePreviewSurfaceScript(surfaceWindow)
    if (!nativePreviewPresentationAllowedForGeneration(generation)) {
      return nativePreviewSurfaceStatus
    }
    const sceneScript =
      compositorScene && compositorSceneIsCurrent
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
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return nativePreviewSurfaceStatus
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
  const freshSourceLayerCount = finiteMetric(metrics?.freshSourceLayerCount) ?? 0
  const sourcePollerCount = finiteMetric(metrics?.sourcePollerCount) ?? 0
  const sourceFrameAgeMs = finiteMetric(metrics?.sourceFrameAgeMs)
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    ...nativePreviewRendererTimingStatusFields(effectiveStatus),
    ...nativePreviewMainStatusRefreshFields(effectiveStatus),
    ...nativePreviewMainSceneMismatchFields(),
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
    framePollingSuppressed: nativePreviewProofPollingIsSuppressed(),
    sourcePixelsPresent: freshSourceLayerCount > 0,
    nativePreviewHostKind: 'proof-surface',
    nativePreviewHostAttached: false,
    updatedAt: new Date().toISOString(),
    message: proofSurfaceCompositorMessage(
      effectiveStatus,
      realSurfaceAttempt.reason,
      process.platform
    )
  }
  const proofSourceAssessment = assessProofSourceFrame({
    platform: process.platform,
    framePollingSuppressed: nativePreviewProofPollingIsSuppressed(),
    sourcePollerCount,
    freshSourceLayerCount,
    sourceFrameAgeMs
  })
  if (proofSourceAssessment === 'met') {
    if (nativePreviewSurfaceStatus.firstFrameContract !== 'met') {
      setFirstFrameStatus('met', 'Windows preview pixels are live.')
      updatePreviewWindowWaitDetail(null)
      logBackend('info', '[proof-preview] source frame delivery is live')
    }
  } else if (proofSourceAssessment === 'stalled') {
    if (nativePreviewSurfaceStatus.firstFrameContract !== 'fallback') {
      const reason = `Windows preview source frames have not advanced for ${Math.round(sourceFrameAgeMs ?? 0)}ms; keeping the last good frame while polling retries.`
      setFirstFrameStatus('fallback', reason)
      updatePreviewWindowWaitDetail(reason)
      logBackend('warn', `[proof-preview] ${reason}`)
    }
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

function compositorStatusHasRenderedFrameRevision(
  status: PreviewSurfaceCompositorUpdateParams
): boolean {
  return (
    typeof status.frameSceneRevision === 'number' && Number.isSafeInteger(status.frameSceneRevision)
  )
}

function compositorStatusIsSmokeSceneExercise(
  status: PreviewSurfaceCompositorUpdateParams
): boolean {
  return status.message === 'Smoke compositor scene update.'
}

function recordNativePreviewMainSceneMismatch(
  status: PreviewSurfaceCompositorUpdateParams
): PreviewSurfaceStatus {
  const nowMs = Date.now()
  if (nativePreviewMainSceneMismatchCount === 0) {
    nativePreviewMainSceneMismatchStartedAtMs = nowMs
  }
  nativePreviewMainSceneMismatchCount += 1
  nativePreviewMainLastSkippedSceneRevision = status.sceneRevision
  nativePreviewMainLastSkippedFrameSceneRevision = status.frameSceneRevision
  const fields = nativePreviewMainSceneMismatchFields()
  recordNativePreviewStatusAgeSamples(status)
  const shouldSurfaceMessage =
    (fields.nativePreviewMainSceneMismatchAgeMs ?? 0) >=
    NATIVE_PREVIEW_MAIN_SCENE_MISMATCH_MESSAGE_MS
  nativePreviewSurfaceStatus = {
    ...nativePreviewSurfaceStatus,
    ...accountUnpresentedNativePreviewFrame(nativePreviewSurfaceStatus, status.framesRendered),
    ...nativePreviewMainStatusRefreshFields(status),
    ...fields,
    updatedAt: new Date().toISOString(),
    message: shouldSurfaceMessage
      ? `Preview waiting for compositor to render scene revision ${status.sceneRevision}.`
      : nativePreviewSurfaceStatus.message
  }
  return nativePreviewSurfaceStatus
}

function clearNativePreviewMainSceneMismatch(): void {
  nativePreviewMainSceneMismatchCount = 0
  nativePreviewMainSceneMismatchStartedAtMs = null
  nativePreviewMainLastSkippedSceneRevision = undefined
  nativePreviewMainLastSkippedFrameSceneRevision = undefined
}

function nativePreviewMainSceneMismatchFields(): NativePreviewMainSceneMismatchFields {
  return {
    nativePreviewMainSceneMismatchCount: nativePreviewMainSceneMismatchCount || undefined,
    nativePreviewMainSceneMismatchAgeMs:
      nativePreviewMainSceneMismatchStartedAtMs === null
        ? undefined
        : Math.max(0, Date.now() - nativePreviewMainSceneMismatchStartedAtMs),
    nativePreviewMainLastSkippedSceneRevision: nativePreviewMainLastSkippedSceneRevision,
    nativePreviewMainLastSkippedFrameSceneRevision: nativePreviewMainLastSkippedFrameSceneRevision
  }
}

async function tryPresentNativePreviewRealSurfaceCompositor(
  status: PreviewSurfaceCompositorUpdateParams,
  mainTiming: { queueWaitMs?: number } = {},
  generation = previewWindowSurfaceGeneration()
): Promise<NativePreviewRealSurfacePresentAttempt> {
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return { kind: 'skipped', logKey: 'lifecycle:blocked' }
  }
  // The Metal IOSurface handoff only exists on macOS. Off macOS, image
  // polling is the intended preview transport, not a fallback — so skip the
  // native attempt quietly instead of emitting an alarming "no Metal
  // IOSurface target / falling back" reason on every frame (a Windows
  // tester-reported false alarm).
  if (process.platform !== 'darwin') {
    return { kind: 'skipped', logKey: 'no-handoff:not-macos' }
  }
  const handoff = compositorStatusMetalTargetHandoff(status, {
    maxAgeMs: DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS
  })
  if (!handoff) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    const hasMetalTarget =
      typeof status.metalTargetIosurfaceId === 'number' && status.metalTargetIosurfaceId > 0
    const sceneRevisionMismatch = compositorFrameSceneRevisionMismatch(status)
    if (sceneRevisionMismatch) {
      resetNativePreviewStaleHandoffDiagnostic()
      recordNativePreviewMainSceneMismatch(status)
      return {
        kind: 'skipped',
        logKey: 'no-handoff:scene-revision'
      }
    }
    if (
      !hasMetalTarget &&
      !sceneRevisionMismatch &&
      (!compositorStatusHasRenderedFrameRevision(status) ||
        compositorStatusIsSmokeSceneExercise(status))
    ) {
      resetNativePreviewStaleHandoffDiagnostic()
      return {
        kind: 'skipped',
        logKey: 'no-handoff:not-rendered'
      }
    }
    if (hasMetalTarget) {
      const nowMs = Date.now()
      nativePreviewStaleHandoffStartedAtMs ??= nowMs
      nativePreviewStaleHandoffAttemptCount += 1
      const declareFallback = staleNativePreviewHandoffShouldDeclareFallback({
        attemptCount: nativePreviewStaleHandoffAttemptCount,
        elapsedMs: nowMs - nativePreviewStaleHandoffStartedAtMs
      })
      return {
        kind: 'skipped',
        reason: declareFallback
          ? `Native preview falling back to image polling: the compositor's Metal IOSurface target stayed older than the ${DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS}ms handoff budget for ${nowMs - nativePreviewStaleHandoffStartedAtMs}ms.`
          : undefined,
        logKey: declareFallback ? 'no-handoff:stale' : 'no-handoff:stale-transient'
      }
    }
    resetNativePreviewStaleHandoffDiagnostic()
    return {
      kind: 'skipped',
      reason: `Native preview falling back to image polling: the compositor status carries no Metal IOSurface target (metalTargetIosurfaceId=${status.metalTargetIosurfaceId ?? 'absent'}), so there is nothing to present natively for this scene.`,
      logKey: 'no-handoff:absent'
    }
  }
  resetNativePreviewStaleHandoffDiagnostic()
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
      frameAgeMs: status.frameAgeMs ?? undefined,
      compositorUpdatedAt: status.updatedAt
    })
  } catch (error) {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    await disableNativePreviewRealSurfaceDriver(
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
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    return { kind: 'skipped', logKey: 'lifecycle:blocked' }
  }
  if (driverStatus) {
    const hostKind = nativePreviewRealSurfaceDriverKind ?? driverStatus.nativePreviewHostKind
    const hostAttached =
      hostKind === 'in-process'
        ? driverStatus.nativePreviewHostAttached === true
        : (driverStatus.nativePreviewHostAttached ?? true)
    driverStatus = {
      ...driverStatus,
      nativePreviewHostKind: hostKind ?? 'external-module',
      nativePreviewHostAttached: hostAttached
    }
  }
  const mainTimingStatus = recordNativePreviewMainHandoffMetrics(
    mainTiming.queueWaitMs ?? 0,
    Math.max(0, Date.now() - presentStartedAtMs)
  )
  const presentValidated = Boolean(
    driverStatus &&
    driverStatus.nativePreviewHostAttached === true &&
    nativeCametalLayerStatusMatchesHandoff(driverStatus, handoff)
  )
  const failureDisposition = nativePreviewPresentFailureDisposition({
    driverKind: nativePreviewRealSurfaceDriverKind,
    surfaceVisible: nativePreviewSurfaceStatus.bounds?.visible !== false,
    presentValidated,
    consecutiveFailures: nativePreviewRealSurfaceInvalidActivationCount,
    failureThreshold: NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD
  })
  if (failureDisposition === 'benign-skip') {
    nativePreviewRealSurfaceInvalidActivationCount = 0
    return { kind: 'skipped', logKey: 'hidden:in-process' }
  }
  if (
    !driverStatus ||
    driverStatus.nativePreviewHostAttached !== true ||
    !nativeCametalLayerStatusMatchesHandoff(driverStatus, handoff)
  ) {
    nativePreviewRealSurfaceInvalidActivationCount += 1
    const invalidActivationReason = realSurfaceInvalidActivationMessage(handoff, driverStatus)
    if (failureDisposition === 'disable-native') {
      const failureReason =
        `In-process CAMetalLayer presenter failed ${nativePreviewRealSurfaceInvalidActivationCount} consecutive visible presents. ` +
        invalidActivationReason
      await disableNativePreviewRealSurfaceDriver(failureReason)
      return {
        kind: 'skipped',
        reason: failureReason,
        logKey: `disabled-invalid-activation:${handoff.iosurfaceId}:${handoff.width}x${handoff.height}`
      }
    }
    const shouldReportInvalidActivation =
      nativePreviewRealSurfaceInvalidActivationCount >=
      NATIVE_PREVIEW_INVALID_ACTIVATION_WARN_THRESHOLD
    return {
      kind: 'skipped',
      reason: shouldReportInvalidActivation ? invalidActivationReason : undefined,
      logKey: `invalid-activation:${handoff.iosurfaceId}:${handoff.width}x${handoff.height}`
    }
  }

  nativePreviewRealSurfaceInvalidActivationCount = 0
  driverStatus = nativePreviewValidatedHandoffStatus(driverStatus, {
    sceneRevision: sceneRevisionIsSafeInteger(status.frameSceneRevision)
      ? status.frameSceneRevision
      : sceneRevisionIsSafeInteger(status.sceneRevision)
        ? status.sceneRevision
        : undefined,
    runId: handoff.runId
  })
  const previousDroppedFrames = nativePreviewSurfaceStatus.droppedFrames ?? 0
  const previousCoalescedFrames =
    nativePreviewSurfaceStatus.nativePreviewMainCoalescedFrameCount ?? 0
  const ingressCoalescedFrames = nativePreviewMainIngressCoalescedFrameCount
  nativePreviewMainIngressCoalescedFrameCount = 0
  const placementStatus = nativePreviewPlacementStatusFields()
  nativePreviewNativeFailureFallbackActive = false
  nativePreviewNativeOwnsProofPollingSuppression = true
  await syncNativePreviewProofPollingSuppression()
  if (!nativePreviewPresentationAllowedForGeneration(generation)) {
    nativePreviewNativeOwnsProofPollingSuppression = false
    return { kind: 'skipped', logKey: 'lifecycle:blocked' }
  }
  nativePreviewSurfaceStatus = {
    ...driverStatus,
    ...placementStatus,
    ...nativePreviewRendererTimingStatusFields(status),
    ...nativePreviewMainStatusRefreshFields(status),
    ...nativePreviewMainSceneMismatchFields(),
    ...mainTimingStatus,
    pendingHostCommandCount:
      driverStatus.pendingHostCommandCount + placementStatus.pendingHostCommandCount,
    droppedFrames:
      nativePreviewRealSurfaceDriverKind === 'in-process'
        ? (driverStatus.droppedFrames ?? 0)
        : Math.max(driverStatus.droppedFrames ?? 0, previousDroppedFrames),
    nativePreviewMainCoalescedFrameCount: previousCoalescedFrames + ingressCoalescedFrames,
    framePollingSuppressed: nativePreviewProofPollingIsSuppressed(),
    updatedAt: new Date().toISOString()
  }
  // Single placement authority: while the native CAMetalLayer is confirmed
  // presenting, the Electron proof window must not stack beneath it (two surfaces at
  // one rect made every visual bug ambiguous). It may re-show on bounds updates once
  // the native path stops claiming presents (see surface create/update).
  nativePreviewNativePresentConfirmedAtMs = Date.now()
  await setNativePreviewProofAnimationSuspended(true)
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
  suppressed: boolean,
  recordingActive?: boolean
): Promise<PreviewSurfaceStatus> {
  if (typeof recordingActive === 'boolean') {
    nativePreviewProofPollingRecordingActive = recordingActive
  }
  const wasSuppressed = nativePreviewSurfaceFramePollingSuppressed
  nativePreviewSurfaceFramePollingSuppressed = suppressed
  if (suppressed && !wasSuppressed) {
    resetNativePreviewMainHandoffMetrics()
    nativePreviewRealSurfaceDriver?.resetMetrics?.()
  }
  await syncNativePreviewProofPollingProfile()
  const effectiveSuppression = await syncNativePreviewProofPollingSuppression()
  nativePreviewSurfaceStatus = nativePreviewFramePollingSuppressionStatus(
    nativePreviewSurfaceStatus,
    effectiveSuppression
  )
  return nativePreviewSurfaceStatus
}

async function syncNativePreviewProofPollingProfile(): Promise<void> {
  const profile = nativePreviewProofPollingProfile(nativePreviewProofPollingRecordingActive)
  const surfaceWindow = nativePreviewSurfaceWindow
  if (!surfaceWindow || surfaceWindow.isDestroyed()) {
    nativePreviewAppliedProofPollingProfile = null
    return
  }
  const profileKey = nativePreviewProofPollingProfileKey(surfaceWindow.id, profile)
  if (nativePreviewAppliedProofPollingProfile === profileKey) {
    return
  }
  const requestSerial = ++nativePreviewProofPollingProfileSerial
  await waitForNativePreviewSurfaceScript(surfaceWindow)
  if (
    requestSerial !== nativePreviewProofPollingProfileSerial ||
    profileKey !==
      nativePreviewProofPollingProfileKey(
        surfaceWindow.id,
        nativePreviewProofPollingProfile(nativePreviewProofPollingRecordingActive)
      ) ||
    surfaceWindow.isDestroyed() ||
    nativePreviewSurfaceWindow !== surfaceWindow
  ) {
    nativePreviewAppliedProofPollingProfile = null
    return
  }
  await surfaceWindow.webContents.executeJavaScript(
    `window.__videorcSetFramePollingProfile?.(${jsonForInlineScript(profile)})`,
    true
  )
  if (
    requestSerial === nativePreviewProofPollingProfileSerial &&
    profileKey ===
      nativePreviewProofPollingProfileKey(
        surfaceWindow.id,
        nativePreviewProofPollingProfile(nativePreviewProofPollingRecordingActive)
      ) &&
    !surfaceWindow.isDestroyed() &&
    nativePreviewSurfaceWindow === surfaceWindow
  ) {
    nativePreviewAppliedProofPollingProfile = profileKey
  }
}

function nativePreviewProofPollingIsSuppressed(): boolean {
  return nativePreviewProofPollingSuppressed({
    lifecycleSuppressed: nativePreviewSurfaceFramePollingSuppressed,
    nativeSurfaceOwnsPresentation: nativePreviewNativeOwnsProofPollingSuppression,
    nativeFailureFallbackActive: nativePreviewNativeFailureFallbackActive
  })
}

async function setNativePreviewProofAnimationSuspended(suspended: boolean): Promise<void> {
  if (nativePreviewProofAnimationSuspended === suspended) {
    return
  }
  const surfaceWindow = nativePreviewSurfaceWindow
  if (!surfaceWindow || surfaceWindow.isDestroyed()) {
    nativePreviewProofAnimationSuspended = null
    return
  }
  await waitForNativePreviewSurfaceScript(surfaceWindow)
  if (surfaceWindow.isDestroyed() || nativePreviewSurfaceWindow !== surfaceWindow) {
    nativePreviewProofAnimationSuspended = null
    return
  }
  await surfaceWindow.webContents.executeJavaScript(
    `window.__videorcSetProofSurfaceSuspended?.(${suspended ? 'true' : 'false'})`,
    true
  )
  if (!surfaceWindow.isDestroyed() && nativePreviewSurfaceWindow === surfaceWindow) {
    nativePreviewProofAnimationSuspended = suspended
  }
}

async function syncNativePreviewProofPollingSuppression(): Promise<boolean> {
  const desired = nativePreviewProofPollingIsSuppressed()
  if (nativePreviewAppliedProofPollingSuppression === desired) {
    return desired
  }
  const requestSerial = ++nativePreviewFramePollingSuppressionSerial
  const surfaceWindow = nativePreviewSurfaceWindow
  if (!surfaceWindow || surfaceWindow.isDestroyed()) {
    nativePreviewAppliedProofPollingSuppression = null
    return desired
  }
  await waitForNativePreviewSurfaceScript(surfaceWindow)
  if (
    requestSerial !== nativePreviewFramePollingSuppressionSerial ||
    desired !== nativePreviewProofPollingIsSuppressed() ||
    surfaceWindow.isDestroyed() ||
    nativePreviewSurfaceWindow !== surfaceWindow
  ) {
    return nativePreviewProofPollingIsSuppressed()
  }
  await surfaceWindow.webContents.executeJavaScript(
    `window.__videorcSetFramePollingSuppressed?.(${desired ? 'true' : 'false'})`,
    true
  )
  if (
    requestSerial === nativePreviewFramePollingSuppressionSerial &&
    desired === nativePreviewProofPollingIsSuppressed() &&
    !surfaceWindow.isDestroyed() &&
    nativePreviewSurfaceWindow === surfaceWindow
  ) {
    nativePreviewAppliedProofPollingSuppression = desired
  }
  return nativePreviewProofPollingIsSuppressed()
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

function proofSourceFrameTotal(metrics: unknown): number {
  if (!metrics || typeof metrics !== 'object') {
    return 0
  }
  const sourceFrames = (metrics as { sourceFrames?: unknown }).sourceFrames
  if (!sourceFrames || typeof sourceFrames !== 'object') {
    return 0
  }
  return Object.values(sourceFrames).reduce<number>(
    (total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
    0
  )
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
  nativePreviewMainIngressCoalescedFrameCount = 0
  nativePreviewMainStatusFetchSamplesMs = []
  nativePreviewMainStatusAgeSamplesMs = []
  nativePreviewMainStatusFrameAgeSamplesMs = []
  nativePreviewMainStatusFetchFailures = 0
  nativePreviewMainStatusFetchSuccesses = 0
  clearNativePreviewMainSceneMismatch()
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

function sendWindowCenterClick(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false
  }
  const bounds = window.getContentBounds()
  const x = Math.max(1, Math.floor(bounds.width / 2))
  const y = Math.max(1, Math.floor(bounds.height / 2))
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  return true
}

function destroyNativePreviewSurface(
  generation = previewWindowSurfaceGeneration()
): PreviewSurfaceStatus {
  if (!previewWindowSurfaceGenerationIsCurrent(generation)) {
    return nativePreviewSurfaceStatus
  }
  nativePreviewPlacementQueue.cancelPending()
  resetNativePreviewStaleHandoffDiagnostic()
  resetNativePreviewMainHandoffMetrics()
  nativePreviewSurfaceCompositorRequestSerial += 1
  nativePreviewFramePollingSuppressionSerial += 1
  nativePreviewNativeOwnsProofPollingSuppression = false
  nativePreviewNativeFailureFallbackActive = false
  nativePreviewAppliedProofPollingSuppression = null
  nativePreviewAppliedProofPollingProfile = null
  nativePreviewProofPollingProfileSerial += 1
  nativePreviewProofAnimationSuspended = null
  clearNativePreviewNativePlacementAuthority()
  void applyNativePreviewRealSurfaceHostCommands([{ kind: 'destroy' }], { startIfNeeded: false })
  if (nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()) {
    nativePreviewSurfaceWindow.close()
  }
  nativePreviewSurfaceWindow = null
  nativePreviewSurfaceStatus = idleNativePreviewSurfaceStatus()
  return nativePreviewSurfaceStatus
}

function resetNativePreviewStaleHandoffDiagnostic(): void {
  nativePreviewStaleHandoffStartedAtMs = null
  nativePreviewStaleHandoffAttemptCount = 0
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

type NativePreviewPrimaryDriverLoad =
  | {
      driver: NativePreviewRealSurfaceDriver
      kind: Exclude<NativePreviewRealSurfaceDriverKind, 'helper-process'>
      unavailableReason?: undefined
    }
  | { driver: null; kind?: undefined; unavailableReason: string }

function loadNativePreviewPrimaryDriver(): NativePreviewPrimaryDriverLoad {
  if (configuredNativePreviewHostModulePath) {
    const loaded = loadNativePreviewRealSurfaceDriver({
      modulePath: configuredNativePreviewHostModulePath,
      loadModule: (modulePath) => requireNativePreviewRealSurfaceModule(modulePath)
    })
    return loaded.driver
      ? { driver: loaded.driver, kind: 'external-module' }
      : {
          driver: null,
          unavailableReason:
            loaded.unavailableReason ?? 'External native preview driver failed to load'
        }
  }

  if (process.platform !== 'darwin') {
    return {
      driver: null,
      unavailableReason: 'In-process CAMetalLayer preview is only available on macOS'
    }
  }

  if (nativePreviewInProcessModuleResolution.source === 'unavailable') {
    return {
      driver: null,
      unavailableReason: nativePreviewInProcessModuleResolution.reason
    }
  }

  const loaded = loadNativePreviewInProcessDriver({
    modulePath: nativePreviewInProcessModuleResolution.path,
    loadModule: (modulePath) => requireNativePreviewRealSurfaceModule(modulePath),
    getNativeWindowHandle: nativePreviewWindowHandle
  })
  return loaded.driver
    ? { driver: loaded.driver, kind: 'in-process' }
    : { driver: null, unavailableReason: loaded.unavailableReason }
}

function nativePreviewWindowHandle(): Buffer | null {
  const window = previewWindow
  return window && !window.isDestroyed() ? window.getNativeWindowHandle() : null
}

function ensureNativePreviewRealSurfaceDriver(): NativePreviewRealSurfaceDriver | null {
  if (nativePreviewRealSurfaceDriver) {
    return nativePreviewRealSurfaceDriver
  }
  const nowMs = Date.now()
  if (nowMs < nativePreviewPrimaryDriverRetryAtMs) {
    return null
  }

  const primary = loadNativePreviewPrimaryDriver()
  if (primary.driver) {
    nativePreviewRealSurfaceDriver = primary.driver
    nativePreviewRealSurfaceDriverKind = primary.kind
    nativePreviewRealSurfaceDriverUnavailableReason = undefined
    nativePreviewHelperProcessDriverResolved = false
    return primary.driver
  }
  nativePreviewRealSurfaceDriverUnavailableReason = primary.unavailableReason
  nativePreviewPrimaryDriverRetryAtMs = nowMs + NATIVE_PREVIEW_HELPER_RETRY_COOLDOWN_MS

  if (
    !nativePreviewHelperFallbackEnabled ||
    nativePreviewHelperProcessDriverResolved ||
    nowMs < nativePreviewHelperDriverRetryAtMs
  ) {
    return null
  }

  nativePreviewHelperProcessDriverResolved = true
  const helperDriver = createNativePreviewHelperProcessDriverConfig()
  if (!helperDriver.driver) {
    nativePreviewRealSurfaceDriverUnavailableReason = helperDriver.unavailableReason
    return null
  }

  nativePreviewRealSurfaceDriver = helperDriver.driver
  nativePreviewRealSurfaceDriverKind = 'helper-process'
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
  // Dev/lab escape hatch: Windows 10 boxes stay useful for development even
  // though Windows 11 is the supported floor. Anything Windows-11-specific
  // (Mica/acrylic, Windows.Graphics.Capture maturity) is unverified below
  // build 22000 — expect degraded chrome, not a supported configuration.
  if (process.env.VIDEORC_ALLOW_UNSUPPORTED_WINDOWS === '1') {
    logBackend('warn', `Windows version floor bypassed (build ${release()}); unsupported setup.`)
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

function accountSignInCoordinator(): AccountSignInTransactions {
  if (!accountSignInTransactions) {
    accountSignInTransactions = new AccountSignInTransactions(
      join(app.getPath('userData'), 'account-sign-in-transactions.json'),
      {
        codec: protectedOAuthPersistenceCodec(),
        allowLoopbackAuthorizeOrigin: !app.isPackaged
      }
    )
  }
  return accountSignInTransactions
}

function protectedOAuthPersistenceCodec(): SecurePersistenceCodec {
  if (!oauthPersistenceCodec) {
    oauthPersistenceCodec = createSafeStoragePersistenceCodec(safeStorage)
  }
  return oauthPersistenceCodec
}

function outputDirectoryAuthority(): PersistentDirectoryAuthority {
  if (!persistentDirectoryAuthority) {
    persistentDirectoryAuthority = new PersistentDirectoryAuthority(
      join(app.getPath('userData'), 'output-directory-authority.json'),
      protectedOAuthPersistenceCodec(),
      (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
          }
          throw error
        }
      }
    )
  }
  return persistentDirectoryAuthority
}

function providerOAuthCallbackCoordinator(): ProviderOAuthCallbacks {
  if (!providerOAuthCallbacks) {
    providerOAuthCallbacks = new ProviderOAuthCallbacks(
      join(app.getPath('userData'), 'provider-oauth-callbacks.json'),
      { codec: protectedOAuthPersistenceCodec() }
    )
  }
  return providerOAuthCallbacks
}

function sendAccountCallback(envelope: AccountCallbackEnvelope): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    return
  }
  sendElectronEvent(mainWindow.webContents, 'account:callback', envelope)
}

function sendOAuthCallback(envelope: OAuthCallbackEnvelope): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return
  sendElectronEvent(mainWindow.webContents, 'oauth:callback-url', envelope)
}

function flushOAuthCallbackUrls(): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    return
  }

  try {
    for (const envelope of providerOAuthCallbackCoordinator().pending()) {
      sendOAuthCallback(envelope)
    }
  } catch {
    logBackend('warn', 'Provider callback recovery data is unavailable; continuing without it.')
  }
  try {
    for (const envelope of accountSignInCoordinator().pending()) {
      sendAccountCallback(envelope)
    }
  } catch {
    logBackend('warn', 'Account callback recovery data is unavailable; continuing without it.')
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
    !(
      (parsed.hostname === 'oauth' || parsed.hostname === 'account') &&
      parsed.pathname === '/callback'
    )
  ) {
    return
  }

  if (parsed.hostname === 'account') {
    try {
      sendAccountCallback(accountSignInCoordinator().accept(parsed.toString()))
    } catch (error) {
      // Never log the callback URL: it carries a short-lived authorization code.
      logBackend('warn', `Rejected desktop account callback: ${errorMessage(error)}`)
    }
    return
  }
  try {
    sendOAuthCallback(providerOAuthCallbackCoordinator().accept(parsed.toString()))
  } catch (error) {
    // Never log the callback URL: it carries a short-lived provider code.
    logBackend('warn', `Rejected provider OAuth callback: ${errorMessage(error)}`)
  }
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
  // Dev mode on Windows: use the pinned vendor FFmpeg from
  // `pnpm ffmpeg:fetch:windows` when present, so development does not depend
  // on a system-wide ffmpeg install. macOS dev keeps resolving via PATH.
  const binDir = app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg', 'bin')
    : process.platform === 'win32'
      ? join(workspaceRoot(), 'vendor', 'ffmpeg', 'windows-x64', 'bin')
      : null
  if (!binDir) {
    return null
  }
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

// F-014 supervisor: a dead backend used to leave the app a zombie that still
// reported Ready with a clickable Record button. Restart with backoff; after
// too many crashes inside the window, stop and say so — never lie.
const BACKEND_RESTART_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]
const BACKEND_RESTART_WINDOW_MS = 5 * 60_000
const BACKEND_STABLE_UPTIME_MS = 60_000
let backendCrashTimestamps: number[] = []
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null
let backendLastStartAt = 0

function scheduleBackendRestart(code: number | null, signal: NodeJS.Signals | null): void {
  if (appIsQuitting || backendQuitInProgress || backendQuitComplete) {
    return
  }
  const now = Date.now()
  // A long stable run forgives earlier crashes (sleep/wake storms must not
  // permanently exhaust the budget).
  if (backendLastStartAt > 0 && now - backendLastStartAt >= BACKEND_STABLE_UPTIME_MS) {
    backendCrashTimestamps = []
  }
  backendCrashTimestamps = backendCrashTimestamps.filter(
    (at) => now - at < BACKEND_RESTART_WINDOW_MS
  )
  backendCrashTimestamps.push(now)
  const attempt = backendCrashTimestamps.length
  if (attempt > BACKEND_RESTART_BACKOFF_MS.length) {
    logBackend(
      'error',
      'Backend crashed repeatedly; automatic restarts stopped. Restart Videorc to recover.'
    )
    sendToWindows('backend:lifecycle', { state: 'failed', code, signal, attempt })
    return
  }
  const delayMs = BACKEND_RESTART_BACKOFF_MS[attempt - 1]
  logBackend(
    'warn',
    `Restarting backend in ${delayMs}ms (attempt ${attempt}/${BACKEND_RESTART_BACKOFF_MS.length}).`
  )
  sendToWindows('backend:lifecycle', { state: 'restarting', code, signal, attempt, delayMs })
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null
    startBackend()
  }, delayMs)
}

function cancelBackendRestart(): void {
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer)
    backendRestartTimer = null
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
  backendLastStartAt = Date.now()
  backendProcess = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...devCargoEnvOverrides(),
      // Full isolation or none: when app/user data dirs are overridden (smokes,
      // probes), the backend's sqlite + secrets must move with them instead of
      // silently using the real ~/Library/Application Support/Videorc profile.
      ...backendIsolationEnv(process.env),
      PATH: pathEntries.join(delimiter),
      VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegBinDir
        ? join(ffmpegBinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
        : '',
      VIDEORC_MANAGED_BACKGROUND_ROOTS: managedBackgroundRoots().join(delimiter),
      // Debug smoke/test RPCs are a second, explicit capability boundary in
      // addition to the admin backend credential. Release builds compile the
      // handlers out regardless of this value.
      VIDEORC_ENABLE_SMOKE_RPC: smokeCommandServerEnabled && !app.isPackaged ? '1' : '0',
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
    backendAdminConnection = null
    backendAuthorityReady = Promise.resolve()
    mainResourceCapabilities.clear()
    disconnectBackendEventSocket()
    scheduleBackendRestart(code, signal)
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
let nativePreviewMainLatestCompositorStatus: CompositorStatus | null = null
let nativePreviewMainLastFrameReadyAtMs = 0
let nativePreviewMainLastPresentDrivingEventAtMs = 0
let nativePreviewMainSmokeDropPresentEvents = false
let nativePreviewMainPumpActivatedAtMs = 0
let nativePreviewMainPumpActivationCount = 0
let nativePreviewMainPumpRendererFallbackCount = 0
let nativePreviewMainPumpDisconnectCount = 0
let nativePreviewMainPumpLastDisconnectReason: string | null = null
const nativePreviewMainStatusPump = new NativePreviewLatestPump<CompositorStatus>({
  apply: handleMainPumpCompositorStatus,
  onSuperseded: () => {
    nativePreviewMainIngressCoalescedFrameCount += 1
  },
  onError: (error) => {
    logBackend('warn', `Main present pump failed: ${errorMessageText(error)}`)
  }
})

async function setNativePreviewMainPumpActive(active: boolean): Promise<void> {
  if (!active) {
    clearNativePreviewMainPumpWork()
  }
  const inFlight = nativePreviewSurfaceCompositorUpdateInFlight
  const changed = await handoffNativePreviewPumpOwnership(
    nativePreviewPumpOwnership,
    active,
    async () => {
      if (inFlight) {
        await inFlight.catch(() => undefined)
      }
    }
  )
  if (!changed) {
    return
  }
  if (active) {
    nativePreviewMainPumpActivatedAtMs = Date.now()
    nativePreviewMainPumpActivationCount += 1
  }
  if (nativePreviewMainPumpActive === active) {
    return
  }
  nativePreviewMainPumpActive = active
  if (!active) {
    nativePreviewMainPumpActivatedAtMs = 0
    nativePreviewMainPumpRendererFallbackCount += 1
  }
  if (!active) {
    clearNativePreviewMainPumpWork()
  }
  sendToWindows('preview-surface:pump-mode', active)
}

function clearNativePreviewMainPumpWork(): void {
  nativePreviewMainLatestCompositorStatus = null
  nativePreviewMainLastFrameReadyAtMs = 0
  nativePreviewMainLastPresentDrivingEventAtMs = 0
  nativePreviewMainStatusPump.cancelPending()
}

function disconnectBackendEventSocket(): void {
  if (backendEventSocketRetryTimer) {
    clearTimeout(backendEventSocketRetryTimer)
    backendEventSocketRetryTimer = null
  }
  const socket = backendEventSocket
  backendEventSocket = null
  mainCaptureState = captureStateAfterTransportLoss()
  clearNativePreviewMainPumpWork()
  void setNativePreviewMainPumpActive(false)
  if (socket) {
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
}

function scheduleBackendEventSocketRetry(connection: BackendConnection): void {
  if (backendAdminConnection !== connection || backendEventSocketRetryTimer) {
    return
  }
  backendEventSocketRetryTimer = setTimeout(() => {
    backendEventSocketRetryTimer = null
    if (backendAdminConnection === connection) {
      connectBackendEventSocket(connection)
    }
  }, 2000)
}

function retireBackendEventSocket(
  socket: WebSocket,
  connection: BackendConnection,
  reason: string
): void {
  if (backendEventSocket !== socket) {
    return
  }
  backendEventSocket = null
  mainCaptureState = captureStateAfterTransportLoss()
  nativePreviewMainPumpDisconnectCount += 1
  nativePreviewMainPumpLastDisconnectReason = reason
  clearNativePreviewMainPumpWork()
  void setNativePreviewMainPumpActive(false)
  logBackend('warn', `Main present pump retired: ${reason}`)
  try {
    socket.close()
  } catch {
    // Already closed.
  }
  scheduleBackendEventSocketRetry(connection)
}

function connectBackendEventSocket(connection: BackendConnection): void {
  // Capture activity is security-sensitive main-process state even when the
  // native preview pump is disabled. The escape hatch disables only preview
  // presentation; this event connection still owns update/permission safety.
  const mainPresentPumpEnabled = process.env.VIDEORC_MAIN_PRESENT_PUMP !== '0'
  disconnectBackendEventSocket()
  const socket = new WebSocket(
    `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
  )
  const eventFilterRequestId = `main-event-filter-${Date.now()}`
  const recordingStatusRequestId = `main-recording-status-${Date.now()}`
  backendEventSocket = socket
  socket.onopen = () => {
    if (backendEventSocket === socket) {
      logBackend('info', 'Main process connected to backend events.')
      const includedEvents = ['recording.status']
      if (mainPresentPumpEnabled) {
        includedEvents.push('preview.frameReady', 'compositor.status')
      }
      socket.send(
        JSON.stringify({
          id: eventFilterRequestId,
          method: 'events.setIncluded',
          params: { events: includedEvents }
        })
      )
    }
  }
  socket.onmessage = (event) => {
    if (backendEventSocket !== socket) {
      return
    }
    if (typeof event.data !== 'string') {
      retireBackendEventSocket(socket, connection, 'backend sent a non-text event message')
      return
    }
    try {
      const parsed = parseMainBackendWireMessage(event.data)
      if ('id' in parsed) {
        if (parsed.id === eventFilterRequestId) {
          if (parsed.ok === true) {
            socket.send(
              JSON.stringify({ id: recordingStatusRequestId, method: 'recording.status' })
            )
            if (mainPresentPumpEnabled) {
              nativePreviewMainStatusPump.cancelPending()
              void setNativePreviewMainPumpActive(true)
            }
          } else {
            throw new Error('Main backend event filter was rejected.')
          }
          return
        }
        if (parsed.id === recordingStatusRequestId) {
          if (parsed.ok !== true) {
            throw new Error('Initial recording status request was rejected.')
          }
          updateMainCaptureState(parseMainRecordingStatus(parsed.payload))
        }
        // Responses to fire-and-forget present reports are deliberately ignored.
        return
      }

      if (parsed.event === 'recording.status') {
        updateMainCaptureState(parseMainRecordingStatusEvent(parsed.payload))
        return
      }
      if (
        nativePreviewMainSmokeDropPresentEvents &&
        (parsed.event === 'preview.frameReady' || parsed.event === 'compositor.status')
      ) {
        return
      }
      // The compact frame lane drives presentation; full status stays on its
      // slow diagnostics cadence and is retained only as expansion context.
      if (parsed.event === 'preview.frameReady') {
        const receivedAtMs = Date.now()
        nativePreviewMainLastFrameReadyAtMs = receivedAtMs
        nativePreviewMainLastPresentDrivingEventAtMs = receivedAtMs
        const status = compositorStatusFromFrameReady(
          parseMainCompositorFrameReadyEvent(parsed.payload),
          nativePreviewMainLatestCompositorStatus
        )
        nativePreviewMainLatestCompositorStatus = status
        nativePreviewMainStatusPump.enqueue(status)
        return
      }
      if (parsed.event === 'compositor.status') {
        const status = parseMainCompositorStatusEvent(parsed.payload)
        nativePreviewMainLatestCompositorStatus = status
        // Compatibility for a backend without the compact event. A fresh
        // connection gets one grace window so queued diagnostics cannot beat
        // the first compact frame and offer an expired IOSurface.
        if (
          mainPumpStatusCompatibilityMayPresent({
            activatedAtMs: nativePreviewMainPumpActivatedAtMs,
            lastFrameReadyAtMs: nativePreviewMainLastFrameReadyAtMs,
            nowMs: Date.now()
          })
        ) {
          nativePreviewMainLastPresentDrivingEventAtMs = Date.now()
          nativePreviewMainStatusPump.enqueue(status)
        }
      }
    } catch (error) {
      retireBackendEventSocket(
        socket,
        connection,
        `invalid backend event message: ${errorMessageText(error)}`
      )
    }
  }
  socket.onclose = (event) => {
    const detail = event.reason ? `: ${event.reason}` : ''
    retireBackendEventSocket(socket, connection, `socket closed (${event.code})${detail}`)
  }
  socket.onerror = () => {
    // onclose follows and owns the retry.
  }
}

const MAIN_BACKEND_ADMIN_METHODS = new Set([
  ...SMOKE_BACKEND_RPC_METHOD_NAMES,
  'health.ping',
  'account.auth.begin_intent',
  'account.sign_out',
  'resource.capability.issue',
  'resource.capability.revoke',
  'resource.capability.register_background',
  'resource.admin.resolve_session_path',
  'resource.admin.resolve_screen_path',
  'resource.admin.resolve_background_path',
  'preview.surface.take_native_host_commands',
  'sessions.delete.resolve',
  'sessions.delete.complete'
])

async function requestBackendAdmin<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000
): Promise<T> {
  if (!MAIN_BACKEND_ADMIN_METHODS.has(method)) {
    throw new Error(`Backend admin method is not allowlisted: ${method}`)
  }
  const waitStartedAt = Date.now()
  const connection = await waitForBackendAdminConnection(timeoutMs)
  const requestTimeoutMs = Math.max(1, timeoutMs - (Date.now() - waitStartedAt))
  const requestId = `main-admin-${randomUUID()}`
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const socket = new WebSocket(
      `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    )
    let settled = false
    const timer = setTimeout(() => {
      finish(() => rejectRequest(new Error(`Backend admin request ${method} timed out.`)))
    }, requestTimeoutMs)
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      callback()
    }
    socket.onopen = () => {
      if (backendAdminConnection !== connection) {
        finish(() => rejectRequest(new Error('Backend restarted before admin request dispatch.')))
        return
      }
      socket.send(JSON.stringify({ id: requestId, method, params }))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return
      }
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { id?: unknown }).id !== requestId
      ) {
        return
      }
      const response = message as {
        ok?: unknown
        payload?: unknown
        error?: { message?: unknown }
      }
      if (response.ok === true) {
        finish(() => resolveRequest(response.payload as T))
      } else {
        const detail =
          typeof response.error?.message === 'string'
            ? response.error.message
            : `Backend admin request ${method} failed.`
        finish(() => rejectRequest(new Error(detail)))
      }
    }
    socket.onerror = () => {
      finish(() => rejectRequest(new Error(`Backend admin request ${method} could not connect.`)))
    }
    socket.onclose = () => {
      finish(() => rejectRequest(new Error(`Backend admin request ${method} closed early.`)))
    }
  })
}

async function waitForBackendAdminConnection(timeoutMs: number): Promise<BackendConnection> {
  const deadline = Date.now() + Math.max(1, timeoutMs)
  while (backendProcess && !appIsQuitting && Date.now() < deadline) {
    const connection = backendAdminConnection
    if (connection) {
      return connection
    }
    await delay(25)
  }
  throw new Error('Backend admin connection is unavailable.')
}

async function issueResourceCapability(
  path: string,
  kind: ResourceCapabilityKind,
  options: { ttlMs?: number; useCount?: number } = {}
): Promise<ResourceSelection> {
  const result = await requestBackendAdmin<{
    capabilityId: string
    kind: ResourceCapabilityKind
    expiresInMs: number
    useCount: number
  }>('resource.capability.issue', {
    path,
    kind,
    ttlMs: options.ttlMs ?? 5 * 60_000,
    useCount: options.useCount ?? 1
  })
  if (result.kind !== kind) {
    throw new Error('Backend resource capability kind did not match the picker request.')
  }
  return mainResourceCapabilities.remember(
    result.capabilityId,
    result.kind,
    path,
    result.expiresInMs
  )
}

async function handleMainPumpCompositorStatus(status: CompositorStatus): Promise<void> {
  const ownershipTicket = nativePreviewPumpOwnership.ticket('main')
  // Same gate the renderer pump used: presents only while a surface session
  // is live (the preview window owns that lifecycle).
  if (
    !nativePreviewPumpOwnership.accepts(ownershipTicket) ||
    !previewWindowIsOpenForSurface() ||
    nativePreviewSurfaceStatus.state !== 'live'
  ) {
    return
  }
  if (compositorFrameSceneRevisionMismatch(status)) {
    const generation = previewWindowSurfaceGeneration()
    const surfaceStatus = await runNativePreviewSurfaceMutation(() =>
      nativePreviewPumpOwnership.accepts(ownershipTicket) &&
      nativePreviewPresentationAllowedForGeneration(generation)
        ? recordNativePreviewMainSceneMismatch(status)
        : nativePreviewSurfaceStatus
    )
    if (nativePreviewPumpOwnership.accepts(ownershipTicket)) {
      queueMainPresentReport(surfaceStatus)
    }
    return
  }
  const params: PreviewSurfaceCompositorUpdateParams = nativePreviewSurfaceFramePollingSuppressed
    ? { ...status, suppressFramePolling: true }
    : { ...status }
  const surfaceStatus = await updateNativePreviewSurfaceCompositor(params, { ownershipTicket })
  if (nativePreviewPumpOwnership.accepts(ownershipTicket)) {
    queueMainPresentReport(surfaceStatus)
  }
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
    nativePreviewMainCoalescedFrameCount: status.nativePreviewMainCoalescedFrameCount,
    nativePreviewHelperRoundTripP95Ms: status.nativePreviewHelperRoundTripP95Ms,
    nativePreviewMainStatusFetchP95Ms: status.nativePreviewMainStatusFetchP95Ms,
    nativePreviewMainStatusFetchFailures: status.nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses: status.nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs: status.nativePreviewMainPresentedStatusAgeMs,
    nativePreviewMainPresentedStatusAgeP95Ms: status.nativePreviewMainPresentedStatusAgeP95Ms,
    nativePreviewMainPresentedFrameAgeP95Ms: status.nativePreviewMainPresentedFrameAgeP95Ms,
    nativePreviewMainSceneMismatchCount: status.nativePreviewMainSceneMismatchCount,
    nativePreviewMainSceneMismatchAgeMs: status.nativePreviewMainSceneMismatchAgeMs,
    nativePreviewMainLastSkippedSceneRevision: status.nativePreviewMainLastSkippedSceneRevision,
    nativePreviewMainLastSkippedFrameSceneRevision:
      status.nativePreviewMainLastSkippedFrameSceneRevision,
    message: status.message,
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
        const bootstrap = parseBackendBootstrap(JSON.parse(trimmed.slice('READY '.length)))
        backendConnection = bootstrap.renderer
        backendAdminConnection = bootstrap.admin
        logBackend('info', `Backend ready on ${backendConnection.host}:${backendConnection.port}`)
        recordBackendRuntimeProcess(backendConnection)
        if (process.env.VIDEORC_SMOKE_PRINT_BACKEND_READY === '1') {
          // The admin credential is private bootstrap authority. Even debug
          // smoke output receives only the renderer-scoped connection.
          safeConsole.log(`[smoke] backend-ready ${publicBackendConnectionJson(backendConnection)}`)
        }
        connectBackendEventSocket(backendAdminConnection)
        const rendererConnection = backendConnection
        const adminConnection = backendAdminConnection
        backendAuthorityReady = rehydrateManagedBackgroundAssets().catch(() => {
          logBackend(
            'warn',
            'Managed background authority could not be fully restored; affected assets remain unavailable.'
          )
        })
        void backendAuthorityReady.then(() => {
          if (
            backendConnection === rendererConnection &&
            backendAdminConnection === adminConnection
          ) {
            sendToWindows('backend:connection', rendererConnection)
            sendToWindows('backend:lifecycle', { state: 'running' })
          }
        })
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
    const info = await runtimeInfo()
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

function sendToWindows<TChannel extends ElectronEventChannel>(
  channel: TChannel,
  payload: ElectronIpcEventMap[TChannel]
): void {
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
      sendElectronEvent(window.webContents, channel, payload)
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
        `[smoke] preview-motion-ready ${JSON.stringify({
          host: address.address,
          port: address.port,
          appPid: process.pid,
          ...(app.isPackaged ? {} : { capability: smokeCommandCapability })
        })}`
      )
    }
  })
}

async function handleSmokePreviewMotionRequest(
  request: IncomingMessage,
  response: HttpResponse
): Promise<void> {
  await handleSmokeCommandRequest(request, response, {
    capability: smokeCommandCapability,
    allowedCommands: app.isPackaged ? PACKAGED_SMOKE_COMMAND_NAMES : undefined,
    runCommand: runSmokePreviewMotionCommand
  })
}

async function runSmokePreviewMotionCommand(
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (command === 'app-quit') {
    setImmediate(() => app.quit())
    return { quitting: true }
  }

  if (command === 'preview-lifecycle-allow-app-quit') {
    smokeAppQuitGuard.allowQuit()
    return { allowed: true }
  }

  if (command === 'preview-lifecycle-attempt-app-quit') {
    const prevented = smokeAppQuitGuard.shouldPreventQuit()
    app.quit()
    return { prevented }
  }

  if (command === 'authorize-smoke-resource') {
    if (app.isPackaged || !smokeCommandServerEnabled) {
      throw new Error('Smoke resource authorization is unavailable in this app mode.')
    }
    const authorization = validateSmokeResourceAuthorization(
      params,
      process.env.VIDEORC_SMOKE_STATE_DIR
    )
    return issueResourceCapability(authorization.path, authorization.kind)
  }

  if (command === 'import-smoke-background') {
    if (app.isPackaged || !smokeCommandServerEnabled || Object.keys(params).length !== 1) {
      throw new Error('Smoke background import is unavailable or invalid in this app mode.')
    }
    const authorization = validateSmokeResourceAuthorization(
      { kind: 'input-file', path: params.path },
      process.env.VIDEORC_SMOKE_STATE_DIR
    )
    const imported = await importBackgroundImageFromPath(authorization.path)
    if (!imported) {
      throw new Error('Smoke background import requires a supported image file.')
    }
    return imported
  }

  if (command === 'backend-debug-rpc') {
    // The loopback bearer is only the first boundary. The backend also needs
    // its private admin credential, a debug build, and the explicit runtime
    // switch set by startBackend; packaged builds never reach this bridge.
    if (app.isPackaged || !smokeCommandServerEnabled) {
      throw new Error('Backend debug RPC bridge is unavailable in this app mode.')
    }
    const request = validateSmokeBackendRpcRequest(params)
    if (!request) {
      throw new Error('Invalid or unallowlisted backend debug RPC request.')
    }
    return requestBackendAdmin(request.method, request.params, request.timeoutMs)
  }

  if (command === 'inspect-backend-state-isolation') {
    if (app.isPackaged || !smokeCommandServerEnabled || Object.keys(params).length !== 0) {
      throw new Error('Backend state isolation inspection is unavailable in this app mode.')
    }
    const smokeStateDirectory =
      process.env.VIDEORC_SMOKE_STATE_DIR ?? process.env.VIDEORC_SMOKE_OUTPUT_DIR
    const configuredDatabasePath = process.env.VIDEORC_DATABASE_PATH
    const configuredSecretsPath = process.env.VIDEORC_SECRETS_PATH
    const configuredRecordingsPath = process.env.VIDEORC_RECORDINGS_DIR
    if (
      !smokeStateDirectory ||
      !configuredDatabasePath ||
      !configuredSecretsPath ||
      !configuredRecordingsPath
    ) {
      return {
        isolated: false,
        databaseInsideSmokeState: false,
        secretsInsideSmokeState: false,
        recordingsInsideSmokeState: false,
        backendUsesConfiguredDatabase: false
      }
    }
    const expectedDatabasePath = resolve(configuredDatabasePath)
    const expectedStateDirectory = resolve(smokeStateDirectory)
    const databaseInsideSmokeState = isPathInsideAnyRoot(expectedDatabasePath, [
      expectedStateDirectory
    ])
    const secretsInsideSmokeState = isPathInsideAnyRoot(resolve(configuredSecretsPath), [
      expectedStateDirectory
    ])
    const recordingsInsideSmokeState = isPathInsideAnyRoot(resolve(configuredRecordingsPath), [
      expectedStateDirectory
    ])
    const health = await requestBackendAdmin<{ databasePath?: unknown }>('health.ping')
    const backendUsesConfiguredDatabase =
      typeof health.databasePath === 'string' &&
      resolve(health.databasePath) === expectedDatabasePath
    return {
      isolated:
        databaseInsideSmokeState &&
        secretsInsideSmokeState &&
        recordingsInsideSmokeState &&
        backendUsesConfiguredDatabase,
      databaseInsideSmokeState,
      secretsInsideSmokeState,
      recordingsInsideSmokeState,
      backendUsesConfiguredDatabase
    }
  }

  if (command === 'inspect-packaged-bundled-background') {
    if (!app.isPackaged || !packagedSmokeHarnessCapability || Object.keys(params).length !== 0) {
      throw new Error('Packaged bundled-background inspection is unavailable in this app mode.')
    }
    const [asset] = bundledBackgroundAssetsInternal()
    if (!asset) {
      throw new Error('The packaged app contains no bundled background assets.')
    }
    await requestBackendAdmin('resource.capability.register_background', {
      assetId: asset.id,
      path: asset.assetPath
    })
    const assetUrl = managedBackgroundAssetUrl(asset.fileName)
    const decoded = await decodeManagedBackgroundAssetInMainRenderer(assetUrl)
    return {
      id: asset.id,
      name: asset.name,
      fileName: asset.fileName,
      managedAssetPath: asset.assetPath,
      assetUrl,
      decodedWidth: decoded.naturalWidth,
      decodedHeight: decoded.naturalHeight
    }
  }

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
    const warmupMs =
      typeof params.warmupMs === 'number' && Number.isFinite(params.warmupMs)
        ? Math.max(0, params.warmupMs)
        : 0
    if (warmupMs > 0) {
      await new Promise((resolveWarmup) => setTimeout(resolveWarmup, warmupMs))
    }
    resetNativePreviewMainHandoffMetrics()
    nativePreviewRealSurfaceDriver?.resetMetrics?.()
    const measuringProofSurface = !nativePreviewSurfaceStatusIsRealSurface(
      nativePreviewSurfaceStatus
    )
    const initialProofMetrics = measuringProofSurface
      ? await nativePreviewSurfaceWindow.webContents.executeJavaScript(
          'window.__videorcResetNativePreviewMeasurement?.(); window.__videorcNativePreviewMetrics?.() ?? null',
          true
        )
      : null
    const measurementStartedAtMs = Date.now()
    await new Promise((resolveMeasure) => setTimeout(resolveMeasure, durationMs))
    if (nativePreviewSurfaceStatusIsRealSurface(nativePreviewSurfaceStatus)) {
      return {
        ...nativePreviewSurfaceStatusMetrics(nativePreviewSurfaceStatus),
        measurementStartedAtMs
      }
    }
    const metrics = await nativePreviewSurfaceWindow.webContents.executeJavaScript(
      'window.__videorcNativePreviewMetrics?.() ?? null',
      true
    )
    if (!metrics) {
      throw new Error('Native preview surface did not expose metrics.')
    }
    const presentedFrameId = finiteMetric(metrics.presentedCompositorFrame)
    const freshSourceLayerCount = finiteMetric(metrics.freshSourceLayerCount) ?? 0
    const sourceFrameDelta = Math.max(
      0,
      proofSourceFrameTotal(metrics) - proofSourceFrameTotal(initialProofMetrics)
    )
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
      sourcePixelsPresent: freshSourceLayerCount > 0,
      updatedAt: new Date().toISOString()
    }
    return {
      ...metrics,
      sourceFrameDelta,
      measurementStartedAtMs,
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
      animationSuspended: nativePreviewProofAnimationSuspended === true,
      bounds: window && !window.isDestroyed() ? window.getBounds() : null,
      nativeOwnsPlacement: nativeSurfaceOwnsPlacement(),
      nativePresentConfirmedAtMs: nativePreviewNativePresentConfirmedAtMs,
      realDriverActive: Boolean(nativePreviewRealSurfaceDriver),
      realDriverUnavailableReason: nativePreviewRealSurfaceDriverUnavailableReason ?? null
    }
  }

  if (command === 'exercise-native-preview-proof-fallback') {
    if (!previewWindowIsOpenForSurface()) {
      throw new Error('Preview window must be open before exercising proof fallback.')
    }
    await disableNativePreviewRealSurfaceDriver('Smoke requested explicit proof fallback.')
    const window = nativePreviewSurfaceWindow
    return {
      exists: Boolean(window && !window.isDestroyed()),
      visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
      animationSuspended: nativePreviewProofAnimationSuspended === true,
      bounds: nativePreviewSurfaceStatus.bounds,
      placement: nativePreviewSurfaceStatus.bounds
        ? surfaceWindowPlacement(nativePreviewSurfaceStatus.bounds)
        : null,
      status: nativePreviewSurfaceStatus
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
    return togglePreviewWindow(
      typeof params.expectedOpen === 'boolean' ? params.expectedOpen : undefined
    )
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

  if (command === 'preview-window-set-mode') {
    return setPreviewWindowMode(params.mode)
  }

  // Probe-injected slot report: exercises the exact IPC path the renderer's
  // reporter uses, so the docked placement composition is assertable headless.
  if (command === 'preview-window-report-dock-slot') {
    return reportPreviewDockSlot(params)
  }

  if (command === 'preview-window-set-dock-overlay') {
    return setPreviewDockOverlayOpen(params.open === true)
  }

  if (command === 'main-window-set-bounds') {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is not open.')
    }
    const current = mainWindow.getBounds()
    mainWindow.setBounds({
      x: typeof params.x === 'number' ? params.x : current.x,
      y: typeof params.y === 'number' ? params.y : current.y,
      width: typeof params.width === 'number' ? params.width : current.width,
      height: typeof params.height === 'number' ? params.height : current.height
    })
    // Position-only programmatic setBounds does not reliably emit 'move' on
    // macOS; kick the docked follower directly like preview-window-set-bounds.
    if (currentPreviewWindowMode() === 'docked') {
      queueDockedPreviewPlacement()
    }
    return { bounds: mainWindow.getBounds(), contentBounds: mainWindow.getContentBounds() }
  }

  if (command === 'window-bounds-storm') {
    const target = params.target === 'main' ? 'main' : 'preview'
    const updates = Array.isArray(params.updates)
      ? params.updates
          .slice(0, 1000)
          .filter((value): value is Record<string, unknown> =>
            Boolean(value && typeof value === 'object')
          )
      : []
    if (updates.length === 0) {
      throw new Error('Window bounds storm requires at least one bounds update.')
    }
    const cadenceMs =
      typeof params.cadenceMs === 'number' && Number.isFinite(params.cadenceMs)
        ? Math.max(0, params.cadenceMs)
        : 16
    return runTimedBoundsStorm({
      updates,
      cadenceMs,
      wait: delay,
      apply: (update) => {
        const window = target === 'main' ? mainWindow : previewWindow
        if (!window || window.isDestroyed()) {
          throw new Error(`${target === 'main' ? 'Main' : 'Preview'} window is not open.`)
        }
        const current = window.getBounds()
        const next = {
          x: typeof update.x === 'number' ? update.x : current.x,
          y: typeof update.y === 'number' ? update.y : current.y,
          width: typeof update.width === 'number' ? update.width : current.width,
          height: typeof update.height === 'number' ? update.height : current.height
        }
        window.setBounds(next)
        if (target === 'preview') {
          queuePreviewWindowMotionReconcile()
        } else if (currentPreviewWindowMode() === 'docked') {
          if (
            nativeInProcessPreviewOwnsWindowMovement() &&
            current.width === next.width &&
            current.height === next.height
          ) {
            queuePreviewWindowMotionReconcile()
          } else {
            queueDockedPreviewPlacement()
          }
        }
      }
    })
  }

  if (command === 'main-window-focus') {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is not open.')
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    return { focused: mainWindow.isFocused() }
  }

  if (command === 'main-window-state') {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { open: false, bounds: null, contentBounds: null }
    }
    return {
      open: true,
      bounds: mainWindow.getBounds(),
      contentBounds: mainWindow.getContentBounds()
    }
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
        framePollingSuppressed: nativePreviewSurfaceStatus.framePollingSuppressed,
        nativePreviewHostKind: nativePreviewSurfaceStatus.nativePreviewHostKind,
        nativePreviewDrawableWidth: nativePreviewSurfaceStatus.nativePreviewDrawableWidth,
        nativePreviewDrawableHeight: nativePreviewSurfaceStatus.nativePreviewDrawableHeight,
        nativePreviewContentsScale: nativePreviewSurfaceStatus.nativePreviewContentsScale
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

  if (command === 'comments-window-push-snapshot') {
    commentsSmokeSnapshotOverride = true
    const snapshot = params.snapshot as LiveChatSnapshot
    const requestedMode = params.mode as CommentsViewMode | undefined
    const mode = requestedMode ?? { kind: 'live' as const }
    cacheCommentsView({
      mode,
      snapshot,
      latestSendOperation: params.latestSendOperation as CommentsSendOperation | undefined
    })
    commentsViewMode = mode
    emitCommentsView()
    return currentCommentsView()
  }

  if (command === 'comments-window-set-view-mode') {
    const mode = params.mode as CommentsViewMode
    if (!mode || (mode.kind !== 'live' && mode.kind !== 'history')) {
      throw new Error('Comments view mode must be live or history.')
    }
    commentsViewMode = mode
    emitCommentsView()
    return currentCommentsView()
  }

  if (command === 'comments-window-set-command-fixture') {
    const kind = params.kind
    const outcome = params.outcome
    const delayMs =
      typeof params.delayMs === 'number' && Number.isFinite(params.delayMs)
        ? Math.min(5_000, Math.max(0, Math.round(params.delayMs)))
        : 100
    const reason =
      typeof params.reason === 'string' && params.reason.trim()
        ? params.reason.trim()
        : 'Probe command failed as requested.'
    if (
      (kind === 'highlight' && (outcome === 'live' || outcome === 'failed')) ||
      (kind === 'send' && (outcome === 'sent' || outcome === 'partial' || outcome === 'failed'))
    ) {
      commentsSmokeCommandFixture = {
        kind,
        outcome,
        delayMs,
        reason
      } as CommentsSmokeCommandFixture
      commentsSmokeCommandTrace = null
      return commentsSmokeCommandFixture
    }
    throw new Error('Invalid Comments smoke command fixture.')
  }

  if (command === 'comments-window-command-trace') {
    return {
      pendingCount: commentsCommandBroker.pendingCount,
      trace: commentsSmokeCommandTrace
    }
  }

  if (command === 'comments-window-route-send-result') {
    const operation = params.operation as CommentsSendOperation
    if (!operation || typeof operation.sessionId !== 'string') {
      throw new Error('Comments send result requires a session id.')
    }
    const routedTo = cacheCommentsSendResult(operation)
    emitCommentsView()
    return {
      routedTo,
      currentView: currentCommentsView(),
      liveOperation: latestLiveCommentsSendOperation,
      historyOperation: commentsHistorySendOperations.get(operation.sessionId)
    }
  }

  if (command === 'comments-window-authority-probe') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      throw new Error('Comments window is not open.')
    }
    const before = {
      highlight: latestCommentHighlightState,
      view: currentCommentsView(),
      viewers: latestViewerSample
    }
    const invokeResults = await window.webContents.executeJavaScript(
      `(async () => {
        const attempts = [
          ['pushCommentHighlightState', [{
            sessionId: 'forged-comments-session',
            messageId: 'forged-comments-message',
            generation: 999,
            phase: 'live'
          }]],
          ['pushCommentsSnapshot', [{
            mode: { kind: 'live' },
            snapshot: {
              sessionId: 'forged-comments-session',
              providers: [],
              messages: [],
              unreadCount: 0,
              updatedAt: '2099-01-01T00:00:00Z'
            }
          }]],
          ['pushViewerSample', [{
            sessionClientId: 'forged-comments-session',
            total: 999999,
            sampledAt: '2099-01-01T00:00:00Z',
            destinations: []
          }]]
        ];
        return Promise.all(attempts.map(async ([method, args]) => {
          const candidate = window.videorc?.[method];
          if (typeof candidate !== 'function') return { method, exposed: false };
          try {
            await candidate(...args);
            return { method, exposed: true, resolved: true };
          } catch (error) {
            return { method, exposed: true, resolved: false, error: String(error?.message ?? error) };
          }
        }));
      })()`,
      true
    )
    await delay(50)
    const after = {
      highlight: latestCommentHighlightState,
      view: currentCommentsView(),
      viewers: latestViewerSample
    }
    return {
      invokeResults,
      before,
      after,
      unchanged: JSON.stringify(before) === JSON.stringify(after)
    }
  }

  if (command === 'comments-window-click-message') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      return { clicked: false, reason: 'Comments window is not open.' }
    }
    const messageId = typeof params.messageId === 'string' ? params.messageId : ''
    return window.webContents.executeJavaScript(
      `(() => {
        const messageId = ${jsonForInlineScript(messageId)};
        const row = Array.from(document.querySelectorAll('[data-message-id]'))
          .find((candidate) => candidate.getAttribute('data-message-id') === messageId);
        const button = row?.querySelector('button');
        if (!button) return { clicked: false, messageId, phase: row?.getAttribute('data-highlight-phase') ?? null };
        button.click();
        return { clicked: true, messageId, phase: row.getAttribute('data-highlight-phase') };
      })()`,
      true
    )
  }

  if (command === 'comments-window-submit-message') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      return { submitted: false, reason: 'Comments window is not open.' }
    }
    const text = typeof params.text === 'string' ? params.text : ''
    return window.webContents.executeJavaScript(
      `(async () => {
        const input = document.querySelector('input[aria-label="Send a comment to all writable destinations"]');
        if (!input) return { submitted: false, reason: 'Composer is not available.' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${jsonForInlineScript(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const button = document.querySelector('button[aria-label="Send comment to all writable destinations"]');
        if (!button || button.disabled) {
          return { submitted: false, reason: 'Send action is disabled.', value: input.value };
        }
        button.click();
        return { submitted: true, value: input.value };
      })()`,
      true
    )
  }

  if (command === 'comments-window-reader-state') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      return { open: false, text: '', messageCount: 0 }
    }
    const rendered = await window.webContents.executeJavaScript(
      `(() => {
        const rows = Array.from(document.querySelectorAll('[data-message-id]'));
        const composer = document.querySelector('input[aria-label="Send a comment to all writable destinations"]');
        return {
          open: true,
          text: document.body.innerText,
          messageCount: rows.length,
          composerCount: composer ? 1 : 0,
          composerDisabled: composer?.disabled ?? null,
          highlightActionCount: document.querySelectorAll('button[aria-label^="Show "][aria-label$=" on the stream"]').length,
          destinationStatus: document.querySelector('[data-slot="comments-destination-status"]')?.textContent ?? '',
          deliveryStatus: document.querySelector('[aria-label="Latest comment delivery"]')?.textContent ?? '',
          highlightPhases: Object.fromEntries(rows.map((row) => [
            row.getAttribute('data-message-id'),
            row.getAttribute('data-highlight-phase')
          ])),
          highlightReasons: Object.fromEntries(rows.map((row) => [
            row.getAttribute('data-message-id'),
            row.querySelector('[data-slot="badge"][title]')?.getAttribute('title') ?? null
          ]))
        };
      })()`,
      true
    )
    return rendered
  }

  if (command === 'comments-window-capture-page') {
    const window = commentsWindow
    if (!commentsWindowIsOpen() || !window) {
      throw new Error('Comments window is not open.')
    }
    const current = window.getBounds()
    if (current.width !== 420 || current.height !== 640) {
      window.setBounds({ x: current.x, y: current.y, width: 420, height: 640 })
    }
    window.show()
    let captured: NativeImage | null = null
    let headerSignal = -1
    let captureAttempts = 0
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      window.webContents.invalidate()
      await delay(120)
      const candidate = await window.webContents.capturePage()
      const candidateSignal = commentsCaptureHeaderSignal(candidate)
      captureAttempts = attempt
      if (candidateSignal > headerSignal) {
        captured = candidate
        headerSignal = candidateSignal
      }
    }
    if (!captured) {
      throw new Error('Comments window capture did not produce an image.')
    }
    const sourceSize = captured.getSize()
    const image =
      sourceSize.width === 420 && sourceSize.height === 640
        ? captured
        : captured.resize({ width: 420, height: 640, quality: 'best' })
    const name =
      typeof params.name === 'string' ? params.name.replace(/[^a-z0-9-]/gi, '') : 'comments'
    const directory = process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? app.getPath('temp')
    const file = join(directory, `videorc-comments-${name}.png`)
    writeFileSync(file, nativeImage.createFromBuffer(image.toJPEG(100)).toPNG())
    return {
      file,
      size: image.getSize(),
      sourceSize,
      bounds: window.getBounds(),
      captureAttempts,
      headerSignal
    }
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

  if (command === 'main-present-pump-diagnostics') {
    return {
      active: nativePreviewMainPumpActive,
      socketReadyState: backendEventSocket?.readyState ?? null,
      activationCount: nativePreviewMainPumpActivationCount,
      rendererFallbackCount: nativePreviewMainPumpRendererFallbackCount,
      disconnectCount: nativePreviewMainPumpDisconnectCount,
      lastDisconnectReason: nativePreviewMainPumpLastDisconnectReason,
      activatedAgeMs:
        nativePreviewMainPumpActivatedAtMs > 0
          ? Date.now() - nativePreviewMainPumpActivatedAtMs
          : null,
      lastFrameReadyAgeMs:
        nativePreviewMainLastFrameReadyAtMs > 0
          ? Date.now() - nativePreviewMainLastFrameReadyAtMs
          : null,
      lastPresentDrivingEventAgeMs:
        nativePreviewMainLastPresentDrivingEventAtMs > 0
          ? Date.now() - nativePreviewMainLastPresentDrivingEventAtMs
          : null
    }
  }

  if (command === 'exercise-main-present-pump-reconnect') {
    if (!previewWindowIsOpenForSurface() || nativePreviewSurfaceStatus.state !== 'live') {
      throw new Error('Native preview surface must be live before exercising pump reconnect.')
    }
    const socket = backendEventSocket
    const connection = backendConnection
    if (!socket || !connection || !nativePreviewMainPumpActive) {
      throw new Error('Main present pump must be connected before exercising reconnect.')
    }
    const before = {
      frameId:
        nativePreviewSurfaceStatus.presentedFrameId ?? nativePreviewSurfaceStatus.framesRendered,
      activationCount: nativePreviewMainPumpActivationCount,
      rendererFallbackCount: nativePreviewMainPumpRendererFallbackCount,
      disconnectCount: nativePreviewMainPumpDisconnectCount
    }
    nativePreviewMainSmokeDropPresentEvents = true
    nativePreviewMainLastPresentDrivingEventAtMs =
      Date.now() - DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS
    const watchdogDeadline = Date.now() + FIRST_FRAME_TICK_MS * 5
    try {
      while (
        Date.now() < watchdogDeadline &&
        nativePreviewMainPumpDisconnectCount <= before.disconnectCount
      ) {
        await delay(50)
      }
    } finally {
      nativePreviewMainSmokeDropPresentEvents = false
    }
    const watchdogDetected =
      nativePreviewMainPumpDisconnectCount > before.disconnectCount &&
      /presentation event heartbeat stalled/.test(nativePreviewMainPumpLastDisconnectReason ?? '')
    if (!watchdogDetected) {
      throw new Error(
        `Main present pump watchdog did not retire the simulated half-open event lane: ${nativePreviewMainPumpLastDisconnectReason ?? 'no disconnect'}`
      )
    }

    // Observe the renderer-owned interval before main's two-second retry. A
    // single retiring in-flight present is insufficient proof: require at least
    // ten advancing native frames while ownership is published as renderer.
    await delay(1200)
    const fallbackFrameId =
      nativePreviewSurfaceStatus.presentedFrameId ?? nativePreviewSurfaceStatus.framesRendered
    const fallback = {
      frameId: fallbackFrameId,
      frameDelta: fallbackFrameId - before.frameId,
      observed:
        nativePreviewMainPumpRendererFallbackCount > before.rendererFallbackCount &&
        !nativePreviewMainPumpActive
    }

    const reconnectDeadline = Date.now() + 5000
    while (
      Date.now() < reconnectDeadline &&
      (!nativePreviewMainPumpActive ||
        nativePreviewMainPumpActivationCount <= before.activationCount ||
        (nativePreviewSurfaceStatus.presentedFrameId ??
          nativePreviewSurfaceStatus.framesRendered) <= fallbackFrameId)
    ) {
      await delay(50)
    }
    const finalFrameId =
      nativePreviewSurfaceStatus.presentedFrameId ?? nativePreviewSurfaceStatus.framesRendered
    return {
      before,
      watchdogDetected,
      fallback,
      reconnected:
        nativePreviewMainPumpActive &&
        nativePreviewMainPumpActivationCount > before.activationCount,
      finalFrameId,
      finalFrameDelta: finalFrameId - before.frameId,
      activationCount: nativePreviewMainPumpActivationCount,
      rendererFallbackCount: nativePreviewMainPumpRendererFallbackCount,
      disconnectCount: nativePreviewMainPumpDisconnectCount,
      lastDisconnectReason: nativePreviewMainPumpLastDisconnectReason
    }
  }

  if (command === 'exercise-main-present-scene-mismatch') {
    if (!previewWindowIsOpenForSurface() || nativePreviewSurfaceStatus.state !== 'live') {
      throw new Error('Native preview surface must be live before exercising main pump mismatch.')
    }
    const sceneRevision =
      typeof params.sceneRevision === 'number' && Number.isSafeInteger(params.sceneRevision)
        ? params.sceneRevision
        : 101
    const frameSceneRevision =
      typeof params.frameSceneRevision === 'number' &&
      Number.isSafeInteger(params.frameSceneRevision)
        ? params.frameSceneRevision
        : sceneRevision - 1
    const firstStatus = {
      ...smokeCompositorStatusFromSceneParams(smokePreviewSceneParams(sceneRevision, 0.4)),
      sceneRevision,
      frameSceneRevision,
      updatedAt: new Date().toISOString()
    }
    await handleMainPumpCompositorStatus(firstStatus)
    nativePreviewMainSceneMismatchStartedAtMs =
      Date.now() - NATIVE_PREVIEW_MAIN_SCENE_MISMATCH_MESSAGE_MS - 40
    const secondStatus = {
      ...firstStatus,
      framesRendered: firstStatus.framesRendered + 1,
      updatedAt: new Date().toISOString()
    }
    await handleMainPumpCompositorStatus(secondStatus)
    return nativePreviewSurfaceStatus
  }

  if (command === 'exercise-preview-click-focus') {
    if (!previewWindowIsOpenForSurface() || !previewWindow || previewWindow.isDestroyed()) {
      throw new Error('Preview window must be open before exercising click/focus.')
    }
    if (nativePreviewSurfaceStatus.state !== 'live') {
      throw new Error('Native preview surface must be live before exercising click/focus.')
    }

    const steps: Array<Record<string, unknown>> = []
    let lastFrames = nativePreviewSurfaceStatus.framesRendered
    let revision = 9000
    const forcePresent = async (label: string): Promise<void> => {
      revision += 1
      const beforeFrames = lastFrames
      const liveCompositorStatus =
        params.preserveScene === true ? await fetchFirstFrameCompositorStatus() : null
      const compositorStatus =
        liveCompositorStatus ??
        smokeCompositorStatusFromSceneParams(
          smokePreviewSceneParams(revision, 0.18 + (revision % 5) * 0.12)
        )
      const status = await updateNativePreviewSurfaceCompositor({
        ...compositorStatus,
        framesRendered: Math.max(compositorStatus.framesRendered, beforeFrames + 1)
      })
      const step = {
        label,
        beforeFrames,
        afterFrames: status.framesRendered,
        state: status.state,
        transport: status.transport,
        backing: status.backing,
        previewWindowOpen: previewWindowIsOpenForSurface(),
        surfaceExists: Boolean(
          nativePreviewSurfaceWindow && !nativePreviewSurfaceWindow.isDestroyed()
        ),
        surfaceVisible: Boolean(
          nativePreviewSurfaceWindow &&
          !nativePreviewSurfaceWindow.isDestroyed() &&
          nativePreviewSurfaceWindow.isVisible()
        )
      }
      steps.push(step)
      if (!previewWindowIsOpenForSurface()) {
        throw new Error(`Preview window closed during ${label}: ${JSON.stringify(step)}`)
      }
      if (status.state !== 'live') {
        throw new Error(`Preview surface stopped during ${label}: ${JSON.stringify(step)}`)
      }
      if (status.framesRendered <= beforeFrames) {
        throw new Error(`Preview frames did not advance during ${label}: ${JSON.stringify(step)}`)
      }
      lastFrames = status.framesRendered
    }

    await forcePresent('baseline')
    mainWindow.focus()
    await delay(80)
    await forcePresent('main-window-focus')

    previewWindow.focus()
    await delay(80)
    await forcePresent('preview-window-focus')

    const previewClicked = sendWindowCenterClick(previewWindow)
    await delay(80)
    await forcePresent('preview-window-click')

    const surfaceClicked = sendWindowCenterClick(nativePreviewSurfaceWindow)
    await delay(80)
    await forcePresent('surface-window-click')

    const originalAlwaysOnTop = previewWindowAlwaysOnTop
    setPreviewWindowAlwaysOnTop(!originalAlwaysOnTop)
    await delay(80)
    await forcePresent('always-on-top-toggle')
    setPreviewWindowAlwaysOnTop(originalAlwaysOnTop)

    const currentBounds = previewWindow.getBounds()
    previewWindow.setBounds({
      ...currentBounds,
      x: currentBounds.x + 6,
      y: currentBounds.y + 4
    })
    pushPreviewWindowPlacement()
    await delay(120)
    await forcePresent('preview-window-move')
    previewWindow.setBounds(currentBounds)
    pushPreviewWindowPlacement()

    return {
      previewWindowOpen: previewWindowIsOpenForSurface(),
      previewClicked,
      surfaceClicked,
      nativeOwnsPlacement: nativeSurfaceOwnsPlacement(),
      steps,
      status: nativePreviewSurfaceStatus,
      window: previewWindowState()
    }
  }

  if (command === 'preview-surface-scene-state') {
    const sourceShapes = Object.fromEntries(
      nativePreviewSurfaceScene?.sources.map((source) => [source.id, source.shape ?? null]) ?? []
    )
    return {
      sceneRevision: nativePreviewSurfaceScene?.revision ?? null,
      layoutPreset: nativePreviewSurfaceScene?.layout.layoutPreset ?? null,
      cameraShape:
        nativePreviewSurfaceScene?.sources.find((source) => source.kind === 'camera')?.shape ??
        null,
      sourceShapes,
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
  return nativePreviewSurfaceHasAttachedNativePixels(status)
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
    nativePreviewMainCoalescedFrameCount: status.nativePreviewMainCoalescedFrameCount,
    nativePreviewHelperRoundTripP95Ms: status.nativePreviewHelperRoundTripP95Ms,
    nativePreviewMainStatusFetchP95Ms: status.nativePreviewMainStatusFetchP95Ms,
    nativePreviewMainStatusFetchFailures: status.nativePreviewMainStatusFetchFailures,
    nativePreviewMainStatusFetchSuccesses: status.nativePreviewMainStatusFetchSuccesses,
    nativePreviewMainPresentedStatusAgeMs: status.nativePreviewMainPresentedStatusAgeMs,
    nativePreviewMainPresentedStatusAgeP95Ms: status.nativePreviewMainPresentedStatusAgeP95Ms,
    nativePreviewMainPresentedFrameAgeP95Ms: status.nativePreviewMainPresentedFrameAgeP95Ms,
    nativePreviewMainSceneMismatchCount: status.nativePreviewMainSceneMismatchCount,
    nativePreviewMainSceneMismatchAgeMs: status.nativePreviewMainSceneMismatchAgeMs,
    nativePreviewMainLastSkippedSceneRevision: status.nativePreviewMainLastSkippedSceneRevision,
    nativePreviewMainLastSkippedFrameSceneRevision:
      status.nativePreviewMainLastSkippedFrameSceneRevision,
    nativePreviewHostKind: status.nativePreviewHostKind,
    nativePreviewHostAttached: status.nativePreviewHostAttached,
    nativePreviewPlacementEventsReceived: status.nativePreviewPlacementEventsReceived,
    nativePreviewPlacementsCoalesced: status.nativePreviewPlacementsCoalesced,
    nativePreviewPlacementsApplied: status.nativePreviewPlacementsApplied,
    nativePreviewPlacementRoundTripP95Ms: status.nativePreviewPlacementRoundTripP95Ms,
    nativePreviewPresentRoundTripP95Ms: status.nativePreviewPresentRoundTripP95Ms,
    nativePreviewIosurfaceCacheHits: status.nativePreviewIosurfaceCacheHits,
    nativePreviewIosurfaceImports: status.nativePreviewIosurfaceImports,
    nativePreviewIosurfaceInvalidations: status.nativePreviewIosurfaceInvalidations,
    nativePreviewIosurfaceImportFailures: status.nativePreviewIosurfaceImportFailures,
    nativePreviewPresentedSceneRevision: status.nativePreviewPresentedSceneRevision,
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
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
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
  const backgroundAsset = bundledBackgroundAssetsInternal()[0]
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
              vignettePercent: 0,
              visibilityPercent: 20
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
        fit: previewProofLayerFit(source, params.layout),
        mirror: source.kind === 'camera' ? params.layout.cameraMirror : false,
        shape: previewProofLayerShape(source, params.layout)
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
        return openTab('layout', '[data-videorc-layout-preset]');
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

      if (${JSON.stringify(command)} === 'eval-js') {
        // QA-harness escape hatch: run arbitrary renderer JS with the helper
        // kit in scope. Only reachable through the smoke command server, which
        // never runs in packaged builds.
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('params', 'waitFor', 'openTab', 'sleep', String(params.code ?? 'return null'));
        return { result: await fn(params, waitFor, openTab, sleep) };
      }

      if (${JSON.stringify(command)} === 'select-camera-device') {
        const deadline = Date.now() + Number(params.timeoutMs ?? 10000);
        while (Date.now() < deadline) {
          const cameraId = window.__videorcSmokeSelectFirstCamera?.() ?? null;
          if (cameraId) {
            await sleep(Number(params.settleMs ?? 600));
            return { cameraId };
          }
          await sleep(200);
        }
        throw new Error('No camera device available to select.');
      }

      if (${JSON.stringify(command)} === 'select-screen-device') {
        const deadline = Date.now() + Number(params.timeoutMs ?? 15000);
        while (Date.now() < deadline) {
          const source = window.__videorcSmokeSelectFirstScreen?.() ?? null;
          if (source) {
            await sleep(Number(params.settleMs ?? 1000));
            return source;
          }
          await sleep(200);
        }
        throw new Error('No available ScreenCaptureKit screen/window source to select.');
      }

      if (${JSON.stringify(command)} === 'select-layout-preset') {
        const preset = String(params.preset ?? 'screen-only');
        await openTab('layout', '[data-videorc-layout-preset]');
        const deadline = Date.now() + 5000;
        let button = null;
        while (Date.now() < deadline) {
          button = Array.from(document.querySelectorAll('[data-videorc-layout-preset]'))
            .find((candidate) => candidate.getAttribute('data-videorc-layout-preset') === preset);
          if (button && !button.disabled) break;
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

      if (${JSON.stringify(command)} === 'select-camera-shape') {
        const shape = String(params.shape ?? 'circle');
        await openTab('layout', '[data-videorc-camera-shape]');
        const cameraSource = document.querySelector('[data-videorc-stage-source="source:camera"]');
        if (cameraSource) {
          cameraSource.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await sleep(100);
        }
        const deadline = Date.now() + 5000;
        let button = null;
        while (Date.now() < deadline) {
          button = document.querySelector('[data-videorc-camera-shape="' + shape + '"]');
          if (button) break;
          await sleep(50);
        }
        if (!button) {
          throw new Error('Could not find camera shape ' + shape + '.');
        }
        if (button.getAttribute('data-state') !== 'on') {
          button.click();
        }
        while (Date.now() < deadline) {
          if (button.getAttribute('data-state') === 'on') {
            await sleep(Number(params.settleMs ?? 600));
            return {
              shape,
              pressed: true,
              editModeActivated: Boolean(cameraSource),
              label: button.textContent?.trim() ?? ''
            };
          }
          await sleep(50);
        }
        throw new Error('Timed out waiting for camera shape ' + shape + ' to become active.');
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
        if (before?.open === expectedOpen) {
          return before;
        }
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
    backendAdminConnection = null
    backendAuthorityReady = Promise.resolve()
    mainResourceCapabilities.clear()
    disconnectBackendEventSocket()
  }
}

async function openSystemPermissions(pane: SystemPermissionPane = 'privacy'): Promise<void> {
  assertPermissionShortcutSupported(process.platform)

  const reason = `Restarting capture backend after ${pane} permission became available.`
  // Opening Settings is side-effect-free. The watcher captures the current
  // status first and requests a restart only after a real grant transition.
  mediaPermissionGrantWatcher.watch(pane, reason)
  try {
    await shell.openExternal(permissionUrlForPane(pane))
  } catch (error) {
    mediaPermissionGrantWatcher.stop()
    throw error
  }
}

// Permissions onboarding: fire the native macOS grant prompt without also
// jumping to System Settings (openSystemPermissions does both). Restart logic
// lives in media-access.ts (FX1: an already-granted pane must NOT restart the
// backend — that restart raced the renderer's follow-up meter sample).
async function requestMediaAccessNative(pane: 'camera' | 'microphone'): Promise<MediaAccessResult> {
  assertPermissionShortcutSupported(process.platform)

  return requestMediaAccessWithRestart(
    {
      getStatus: (target) => systemPreferences.getMediaAccessStatus(target),
      // askForMediaAccess is a macOS-only API. Windows grants live in the
      // per-device privacy toggles (ms-settings), so the "prompt" degrades to
      // a status re-read there.
      askForAccess:
        process.platform === 'darwin'
          ? (target) => systemPreferences.askForMediaAccess(target)
          : async (target) => systemPreferences.getMediaAccessStatus(target) === 'granted',
      restartBackend: requestPermissionBackendRestart,
      stopGrantWatcher: () => mediaPermissionGrantWatcher.stop(),
      log: (level, message) => logBackend(level, message)
    },
    pane
  )
}

// The OS's real camera/mic access state. getMediaAccessStatus is supported on
// macOS AND Windows (only askForMediaAccess is mac-only), so this is the honest
// signal the renderer chips read on Windows — where the audio meter has no
// capture backend and the camera enumerates regardless of the privacy toggle.
function readMediaAccessStatus(pane: 'camera' | 'microphone'): MediaAccessStatus {
  try {
    return systemPreferences.getMediaAccessStatus(pane) as MediaAccessStatus
  } catch (error) {
    logBackend('warn', `Could not read ${pane} access status: ${errorMessage(error)}`)
    return 'unknown'
  }
}

function mediaAccessSnapshot(): MediaAccessSnapshot {
  return {
    camera: readMediaAccessStatus('camera'),
    microphone: readMediaAccessStatus('microphone')
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

async function acquireCurrentBackendInterruption(
  reason: string,
  action: 'permission-restart' | 'update-install' = 'permission-restart'
): Promise<BackendInterruptionLease | null> {
  const connection = backendAdminConnection
  if (!connection) {
    return null
  }

  const lease = await acquireBackendInterruptionLease(connection, { action, reason })
  // A backend crash/restart between admission and this continuation would make
  // the old lease irrelevant to the new process. Fail closed instead of using
  // authority granted by a backend that no longer owns capture.
  if (backendAdminConnection !== connection) {
    await lease?.release().catch(() => undefined)
    return null
  }
  return lease
}

function retainDeferredPermissionRestart(reason: string): void {
  const deferred = requestPermissionRestart(deferredPermissionRestartState, 'unknown', reason)
  deferredPermissionRestartState = deferred.state
}

async function runPermissionBackendRestart(reason: string): Promise<boolean> {
  try {
    const restarted = await runBackendInterruptingAction(
      () => acquireCurrentBackendInterruption(reason),
      () => restartBackend(reason)
    )
    if (!restarted) {
      retainDeferredPermissionRestart(reason)
      logBackend(
        'info',
        'Permission restart deferred because capture became active, started, or could not be confirmed idle.'
      )
    }
    return restarted
  } catch (error) {
    retainDeferredPermissionRestart(reason)
    throw error
  }
}

function updateMainCaptureState(payload: unknown): void {
  const nextState = captureStateAfterStatusPayload(payload)
  mainCaptureState = nextState
  const decision = flushPermissionRestart(deferredPermissionRestartState, nextState)
  deferredPermissionRestartState = decision.state
  if (decision.runReason) {
    void runPermissionBackendRestart(decision.runReason).catch((error) => {
      logBackend('warn', `Could not run the deferred permission restart: ${errorMessage(error)}`)
    })
  }
}

async function requestPermissionBackendRestart(reason: string): Promise<boolean> {
  const decision = requestPermissionRestart(
    deferredPermissionRestartState,
    mainCaptureState,
    reason
  )
  deferredPermissionRestartState = decision.state
  if (!decision.runReason) {
    logBackend('info', 'Permission restart deferred until the active capture is idle.')
    return false
  }
  return runPermissionBackendRestart(decision.runReason)
}

const mediaPermissionGrantWatcher = createMediaPermissionGrantWatcher({
  getStatus: (permission) => systemPreferences.getMediaAccessStatus(permission),
  log: (level, message) => logBackend(level, message),
  restartBackend: async (reason) => {
    await requestPermissionBackendRestart(reason)
  }
})

async function runtimeInfo(): Promise<RuntimeInfo> {
  const gpuInfo = await app.getGPUInfo('basic').catch(() => null)
  return buildRuntimeInfo({
    appVersion: app.getVersion(),
    execPath: process.execPath,
    captureExecPath: resolveBackendPermissionTargetPath(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    gpuInfo,
    hardwareAccelerationDisabled: gpuFallbackDecision.disable,
    env: process.env
  })
}

async function revealPermissionTarget(): Promise<void> {
  shell.showItemInFolder(resolveBackendPermissionTargetPath())
}

async function revealSelectedResource(
  directoryHandleId: unknown,
  kind: ResourceCapabilityKind = 'output-directory'
): Promise<void> {
  if (kind !== 'output-directory') {
    throw new Error('Only output-directory handles can be revealed by this operation.')
  }
  const path = outputDirectoryAuthority().resolve(directoryHandleId)
  shell.showItemInFolder(path)
}

async function resolveManagedSessionPath(sessionId: unknown): Promise<string> {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error('Managed session id is invalid.')
  }
  const result = await requestBackendAdmin<{ path: string }>(
    'resource.admin.resolve_session_path',
    {
      sessionId
    }
  )
  if (!result || typeof result.path !== 'string' || result.path.length === 0) {
    throw new Error('Managed session path is unavailable.')
  }
  return result.path
}

async function revealManagedSession(sessionId: unknown): Promise<void> {
  shell.showItemInFolder(await resolveManagedSessionPath(sessionId))
}

async function openManagedSession(sessionId: unknown): Promise<string> {
  return shell.openPath(await resolveManagedSessionPath(sessionId))
}

async function revealManagedBackground(assetId: unknown): Promise<void> {
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
    throw new Error('Managed background asset id is invalid.')
  }
  const result = await requestBackendAdmin<{ path: string }>(
    'resource.admin.resolve_background_path',
    { assetId }
  )
  shell.showItemInFolder(result.path)
}

async function trashSessionDeletion(operationId: unknown): Promise<{
  deleted: boolean
  failedCount: number
}> {
  if (
    typeof operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)
  ) {
    throw new Error('Library deletion operation id is invalid.')
  }
  const operation = await requestBackendAdmin<{
    operationId: string
    sessionId: string
    paths: string[]
    blockedPaths?: string[]
  }>('sessions.delete.resolve', { operationId })
  if (operation.operationId !== operationId || !Array.isArray(operation.paths)) {
    throw new Error('Library deletion operation response is invalid.')
  }
  const trash = await trashPaths(operation.paths, {
    stat: (target) => fsPromises.stat(target),
    trashItem: (target) => shell.trashItem(target)
  })
  const failedPaths = [...(operation.blockedPaths ?? []), ...trash.failures]
  const completion = await requestBackendAdmin<{ deleted: boolean }>('sessions.delete.complete', {
    operationId,
    failedPaths
  })
  return { deleted: completion.deleted, failedCount: failedPaths.length }
}

async function pickScreenImage(): Promise<ResourceSelection | null> {
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

  const path = result.filePaths[0]
  return path ? issueResourceCapability(path, 'input-file') : null
}

// Native directory picker + directory facts for the Settings output-directory
// row (ST2): Browse, exists/writable validation, create-on-demand, free space.
async function pickDirectoryPath(): Promise<ResourceSelection | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose output directory',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) {
    return null
  }

  const path = result.filePaths[0]
  if (!path) {
    return null
  }
  const handle = outputDirectoryAuthority().remember(path)
  const selection = await issueResourceCapability(path, 'output-directory')
  return { ...selection, ...handle }
}

interface DirectoryFacts {
  exists: boolean
  writable: boolean
  freeBytes: number | null
}

async function checkDirectoryFactsForCapability(
  directoryHandleId: unknown
): Promise<DirectoryFacts> {
  let path: string
  try {
    path = outputDirectoryAuthority().resolve(directoryHandleId)
  } catch {
    return { exists: false, writable: false, freeBytes: null }
  }
  if (!path) {
    return { exists: false, writable: false, freeBytes: null }
  }
  const facts: DirectoryFacts = { exists: false, writable: false, freeBytes: null }
  try {
    const stats = await fsPromises.stat(path)
    facts.exists = stats.isDirectory()
  } catch {
    facts.exists = false
  }
  if (facts.exists) {
    try {
      await fsPromises.access(path, fsConstants.W_OK)
      facts.writable = true
    } catch {
      facts.writable = false
    }
    try {
      const stat = await fsPromises.statfs(path)
      facts.freeBytes = Number(stat.bavail) * Number(stat.bsize)
    } catch {
      facts.freeBytes = null
    }
  }
  return facts
}

async function authorizeOutputDirectory(directoryHandleId: unknown): Promise<ResourceSelection> {
  const path = outputDirectoryAuthority().resolve(directoryHandleId)
  const handle = {
    directoryHandleId: String(directoryHandleId),
    displayName: basename(path) || path
  }
  const selection = await issueResourceCapability(path, 'output-directory')
  return { ...selection, ...handle }
}

// Generic native open-file dialog returning the chosen path (e.g. "Locate
// FFmpeg…" in Settings). No filters — the FFmpeg binary has no extension.
async function pickFilePath(): Promise<ResourceSelection | null> {
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

  const path = result.filePaths[0]
  return path ? issueResourceCapability(path, 'input-file') : null
}

// --- Managed asset serving (videorc-asset://) ---------------------------------
// The renderer cannot load raw file:// paths for imported assets: subresource
// file loads are blocked from the dev server's http origin, which made every
// fresh background import flash onError and get branded "Missing" while the
// file sat safely in app storage. This scoped protocol serves ONLY the two
// managed background directories, addressed by bare basename — no arbitrary
// filesystem reach.
const MANAGED_ASSET_SCHEME = 'videorc-asset'
const SMOKE_PREVIEW_FRAME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111827"/><rect x="4" y="4" width="24" height="24" fill="#ef4444"/><rect x="36" y="4" width="24" height="24" fill="#22c55e"/><rect x="4" y="36" width="24" height="24" fill="#3b82f6"/><rect x="36" y="36" width="24" height="24" fill="#f59e0b"/></svg>'

function managedBackgroundRoots(): string[] {
  return [join(app.getPath('userData'), 'background-assets'), bundledBackgroundDirectory()]
}

function resolveRegularFileInsideRoot(root: string, fileName: string): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    return null
  }
  try {
    const candidate = join(root, fileName)
    if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) {
      return null
    }
    const canonicalRoot = realpathSync(root)
    const canonicalFile = realpathSync(candidate)
    return isPathInsideAnyRoot(canonicalFile, [canonicalRoot]) ? canonicalFile : null
  } catch {
    return null
  }
}

function resolveManagedBackgroundFile(fileName: string): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    return null
  }
  for (const root of managedBackgroundRoots()) {
    const candidate = resolveRegularFileInsideRoot(root, fileName)
    if (candidate) {
      return candidate
    }
  }
  return null
}

// --- Chat avatar cache (Comments window upgrade S1) ----------------------------
// Renderers never hot-link platform CDNs: main fetches each avatar once from
// an allowlisted host (avatar-cache.ts policy), stores it here, and serves it
// back through the same scoped protocol under the `avatar` host.
function avatarCacheDirectory(): string {
  return join(app.getPath('userData'), 'avatar-cache')
}

const avatarFetchesInFlight = new Map<string, Promise<string | null>>()

async function cacheChatAvatar(rawUrl: unknown): Promise<string | null> {
  if (typeof rawUrl !== 'string' || !avatarHostAllowed(rawUrl)) {
    return null
  }
  const fileName = avatarCacheFileName(rawUrl)
  const localUrl = `${MANAGED_ASSET_SCHEME}://avatar/${fileName}`
  const filePath = join(avatarCacheDirectory(), fileName)
  if (existsSync(filePath)) {
    return localUrl
  }
  const inFlight = avatarFetchesInFlight.get(fileName)
  if (inFlight) {
    return inFlight
  }
  const fetchPromise = (async () => {
    try {
      const response = await net.fetch(rawUrl)
      if (!response.ok) {
        return null
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
        return null
      }
      mkdirSync(avatarCacheDirectory(), { recursive: true })
      writeFileSync(filePath, bytes)
      pruneAvatarCache()
      return localUrl
    } catch {
      return null
    } finally {
      avatarFetchesInFlight.delete(fileName)
    }
  })()
  avatarFetchesInFlight.set(fileName, fetchPromise)
  return fetchPromise
}

// Oldest-by-mtime files past the cap are pruned; best-effort.
function pruneAvatarCache(): void {
  try {
    const directory = avatarCacheDirectory()
    const entries = readdirSync(directory)
      .map((name) => {
        const filePath = join(directory, name)
        return { filePath, mtimeMs: statSync(filePath).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const stale of entries.slice(AVATAR_CACHE_MAX_FILES)) {
      rmSync(stale.filePath, { force: true })
    }
  } catch {
    // Cache pruning is a convenience; never let it break chat.
  }
}

function resolveManagedAvatarFile(fileName: string): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    return null
  }
  return resolveRegularFileInsideRoot(avatarCacheDirectory(), fileName)
}

// Stream-takeover screen images live in the backend-managed Screens dir; the
// renderer addresses them by bare basename through the same scoped protocol
// (raw file:// subresource loads are blocked and branded every upload
// "Missing" — the background bug all over again).
function resolveManagedScreenFile(fileName: string): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    return null
  }
  return resolveRegularFileInsideRoot(join(app.getPath('userData'), 'Screens'), fileName)
}

function registerManagedAssetProtocol(): void {
  protocol.handle(MANAGED_ASSET_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (smokeCommandServerEnabled && url.host === 'smoke-preview' && fileName === 'frame.svg') {
        return new Response(SMOKE_PREVIEW_FRAME_SVG, {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store'
          }
        })
      }
      const resolved =
        url.host === 'background'
          ? resolveManagedBackgroundFile(fileName)
          : url.host === 'avatar'
            ? resolveManagedAvatarFile(fileName)
            : url.host === 'screen'
              ? resolveManagedScreenFile(fileName)
              : null
      if (!resolved) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(resolved).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

// Existence oracle for the honest "Missing" badge: an image LOAD failure is
// not proof the file is gone (decode errors, transient reads) — only a real
// filesystem miss inside the managed roots may brand a slot missing-file.
async function backgroundAssetFileExists(assetId: unknown): Promise<boolean> {
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
    return false
  }
  try {
    if (!(await ensureManagedBackgroundRegistered(assetId))) {
      return false
    }
    const result = await requestBackendAdmin<{ path: string }>(
      'resource.admin.resolve_background_path',
      { assetId }
    )
    return typeof result.path === 'string' && existsSync(result.path)
  } catch {
    return false
  }
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
  return sourcePath ? importBackgroundImageFromPath(sourcePath) : null
}

// Shared by the picker flow above and the OBS import (O3), which arrives with
// a path from OBS's scene collection instead of a dialog.
async function importBackgroundImageFromPath(
  sourcePath: string
): Promise<BackgroundImportResult | null> {
  if (!isSupportedBackgroundFile(sourcePath) || !existsSync(sourcePath)) {
    return null
  }

  // Copy into app-support storage and reference the managed copy, never the
  // user's original path (Assets Tab plan locked decision).
  const id = randomUUID()
  const directory = join(app.getPath('userData'), 'background-assets')
  mkdirSync(directory, { recursive: true })
  const assetPath = join(directory, managedBackgroundFileName(id, sourcePath))
  copyFileSync(sourcePath, assetPath)

  await requestBackendAdmin('resource.capability.register_background', {
    assetId: id,
    path: assetPath
  })
  return {
    id,
    name: backgroundAssetNameFromPath(sourcePath),
    assetPath: managedBackgroundAssetUrl(basename(assetPath)),
    thumbnailPath: managedBackgroundAssetUrl(basename(assetPath)),
    fileName: basename(sourcePath)
  }
}

async function readObsSetupForRenderer(
  collection: string,
  profile: string
): Promise<ObsSetup | null> {
  const setup = readObsSetup(collection, profile)
  if (!setup) {
    return null
  }

  const recordingPath = setup.recordingPath
  delete setup.recordingPath
  if (recordingPath) {
    try {
      const handle = outputDirectoryAuthority().remember(recordingPath)
      setup.recordingDirectory = {
        ...(await issueResourceCapability(recordingPath, 'output-directory')),
        ...handle
      }
    } catch {
      // OBS can retain a stale folder. Report mapping without granting it.
    }
  }

  await Promise.all(
    setup.sources.map(async (source) => {
      const sourcePath = source.filePath
      delete source.filePath
      if (source.kind !== 'image' || !sourcePath) {
        return
      }
      source.managedBackground = (await importBackgroundImageFromPath(sourcePath)) ?? undefined
    })
  )
  return setup
}

function bundledBackgroundDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'background-assets', 'bundled')
    : resolve(workspaceRoot(), 'apps/desktop/src/renderer/src/assets/backgrounds')
}

function managedBackgroundAssetUrl(fileName: string): string {
  return `${MANAGED_ASSET_SCHEME}://background/${encodeURIComponent(fileName)}`
}

async function decodeManagedBackgroundAssetInMainRenderer(
  assetUrl: string
): Promise<ReturnType<typeof normalizeManagedImageDecodeResult>> {
  const deadline = Date.now() + 12_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    const window = mainWindow
    if (
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !window.webContents.isLoadingMainFrame()
    ) {
      try {
        const decoded = await window.webContents.executeJavaScript(
          managedImageDecodeScript(assetUrl),
          true
        )
        return normalizeManagedImageDecodeResult(decoded, assetUrl)
      } catch (error) {
        lastError = error
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Packaged managed background did not decode in the main renderer.', {
    cause: lastError
  })
}

function bundledBackgroundAssetsInternal(): BackgroundImportResult[] {
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

async function bundledBackgroundAssets(): Promise<BackgroundImportResult[]> {
  const assets = bundledBackgroundAssetsInternal()
  await Promise.all(
    assets.map((asset) =>
      requestBackendAdmin('resource.capability.register_background', {
        assetId: asset.id,
        path: asset.assetPath
      })
    )
  )
  return assets.map((asset) => ({
    ...asset,
    assetPath: managedBackgroundAssetUrl(asset.fileName),
    thumbnailPath: managedBackgroundAssetUrl(asset.fileName)
  }))
}

function importedBackgroundPathForAssetId(assetId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
    return null
  }
  const root = join(app.getPath('userData'), 'background-assets')
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const dot = entry.lastIndexOf('.')
    if (dot <= 0 || entry.slice(0, dot) !== assetId || !isSupportedBackgroundFile(entry)) {
      continue
    }
    const resolved = resolveRegularFileInsideRoot(root, entry)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function ensureManagedBackgroundRegistered(assetId: string): Promise<boolean> {
  const bundled = bundledBackgroundAssetsInternal().find((asset) => asset.id === assetId)
  const path = bundled?.assetPath ?? importedBackgroundPathForAssetId(assetId)
  if (!path) {
    return false
  }
  await requestBackendAdmin('resource.capability.register_background', { assetId, path })
  return true
}

async function rehydrateManagedBackgroundAssets(): Promise<void> {
  const ids = new Set(bundledBackgroundAssetsInternal().map((asset) => asset.id))
  const root = join(app.getPath('userData'), 'background-assets')
  try {
    for (const entry of readdirSync(root)) {
      const dot = entry.lastIndexOf('.')
      const id = dot > 0 ? entry.slice(0, dot) : ''
      if (/^[A-Za-z0-9_-]{1,128}$/.test(id) && isSupportedBackgroundFile(entry)) {
        ids.add(id)
      }
    }
  } catch {
    // A fresh profile has no imported background directory yet.
  }
  await Promise.all([...ids].map((id) => ensureManagedBackgroundRegistered(id)))
}

async function openOAuthUrl(authUrl: string): Promise<void> {
  const parsed = new URL(authUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OAuth URL must use http or https.')
  }

  await shell.openExternal(parsed.toString())
}

// Privileged registration must happen before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MANAGED_ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  // Correct but previously SILENT: `pnpm dev` shares the "Videorc" profile with
  // the packaged app, so a running /Applications/Videorc.app holds this lock
  // and dev exited without a word (reported 2026-07-06). Say why we quit.
  console.error(
    'Videorc is already running (another instance holds the single-instance lock), ' +
      'so this instance is exiting and the running app was focused instead. ' +
      'For `pnpm dev`, quit the installed Videorc app first — or isolate this run ' +
      'with VIDEORC_USER_DATA_DIR=<dir> to use a separate profile.'
  )
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const callbackUrl = argv.find((arg) => arg.startsWith(`${OAUTH_CALLBACK_PROTOCOL}://`))
    if (callbackUrl) {
      if (app.isReady()) {
        dispatchOAuthCallbackUrl(callbackUrl)
      } else {
        earlyProtocolCallbackUrls.push(callbackUrl)
      }
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
  if (app.isReady()) {
    dispatchOAuthCallbackUrl(url)
  } else {
    earlyProtocolCallbackUrls.push(url)
  }
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return
  }

  if (enforceWindowsVersionFloor()) {
    app.quit()
    return
  }

  installRendererSessionPermissions(session.defaultSession)

  // Warm the glass-wallpaper cache while Electron/renderer boot: the underlay
  // then finds it on first mount instead of swapping the whole background in
  // a beat after the window shows. Fire-and-forget — osascript can stall on
  // an Automation prompt and must never delay the window.
  void refreshGlassWallpaper()

  registerOAuthCallbackProtocol()
  const initialCallbackUrl = process.argv.find((argument) =>
    argument.startsWith(`${OAUTH_CALLBACK_PROTOCOL}://`)
  )
  if (initialCallbackUrl) {
    earlyProtocolCallbackUrls.push(initialCallbackUrl)
  }
  for (const callbackUrl of new Set(earlyProtocolCallbackUrls.splice(0))) {
    dispatchOAuthCallbackUrl(callbackUrl)
  }
  registerManagedAssetProtocol()
  initAutoUpdater()
  registerUpdaterIpc(
    () => mainWindow,
    () => captureStateBlocksInterruption(mainCaptureState, backendConnection !== null),
    acquireCurrentBackendInterruption
  )
  registerDisplayChangeReconcile()
  secureIpcHandle('backend:get-connection', async () => {
    await backendAuthorityReady
    return backendConnection
  })
  secureIpcHandle('backend:get-logs', () => backendLogs)
  secureIpcHandle('account:begin-sign-in', async (_event, authorizeUrl: string) => {
    if (typeof authorizeUrl !== 'string') {
      throw new Error('Desktop account authorization URL is required.')
    }
    const intent = await requestBackendAdmin<{ intentGeneration: number }>(
      'account.auth.begin_intent',
      {},
      45_000
    )
    await openOAuthUrl(accountSignInCoordinator().begin(authorizeUrl, intent.intentGeneration))
  })
  secureIpcHandle('account:sign-out', async () => {
    const account = await requestBackendAdmin<VideorcAccountSnapshot>(
      'account.sign_out',
      {},
      45_000
    )
    try {
      accountSignInCoordinator().retireAll()
    } catch (error) {
      // Backend generation is the durable authority, so retained envelopes are
      // already stale even when local callback-store cleanup cannot commit.
      logBackend('warn', `Could not retire signed-out account callbacks: ${errorMessage(error)}`)
    }
    return account
  })
  secureIpcHandle('account:callbacks-list', () => accountSignInCoordinator().pending())
  secureIpcHandle('account:callback-ack', (_event, callbackId: string) =>
    typeof callbackId === 'string' ? accountSignInCoordinator().acknowledge(callbackId) : false
  )
  secureIpcHandle('oauth:callbacks-list', () => providerOAuthCallbackCoordinator().pending())
  secureIpcHandle('oauth:callback-ack', (_event, callbackId: string) =>
    typeof callbackId === 'string'
      ? providerOAuthCallbackCoordinator().acknowledge(callbackId)
      : false
  )
  secureIpcHandle('app:get-runtime-info', () => runtimeInfo())
  secureIpcHandle('system:open-permissions', (_event, pane?: SystemPermissionPane) =>
    openSystemPermissions(pane)
  )
  secureIpcHandle('system:request-media-access', (_event, pane: 'camera' | 'microphone') =>
    requestMediaAccessNative(pane)
  )
  secureIpcHandle('system:media-access-status', () => mediaAccessSnapshot())
  secureIpcHandle('system:reveal-permission-target', () => revealPermissionTarget())
  secureIpcHandle('resource:reveal-selection', (_event, capabilityId: unknown) =>
    revealSelectedResource(capabilityId)
  )
  secureIpcHandle('resource:authorize-output-directory', (_event, directoryHandleId: unknown) =>
    authorizeOutputDirectory(directoryHandleId)
  )
  secureIpcHandle('resource:reveal-session', (_event, sessionId: unknown) =>
    revealManagedSession(sessionId)
  )
  secureIpcHandle('resource:open-session', (_event, sessionId: unknown) =>
    openManagedSession(sessionId)
  )
  secureIpcHandle('resource:reveal-background', (_event, assetId: unknown) =>
    revealManagedBackground(assetId)
  )
  // OBS setup import (O1): read-only discovery over OBS Studio's config files.
  // The stream key never rides these payloads — obs:read strips it; the apply
  // flow requests it exactly once via obs:read-stream-key.
  secureIpcHandle('obs:discover', () => discoverObs())
  secureIpcHandle('obs:read', (_event, collection: string, profile: string) =>
    typeof collection === 'string' && typeof profile === 'string'
      ? readObsSetupForRenderer(collection, profile)
      : null
  )
  secureIpcHandle('obs:read-stream-key', (_event, profile: string) =>
    typeof profile === 'string' ? readObsStreamKey(profile) : null
  )
  // Library Delete: recordings move to the system Trash — Trash IS the undo;
  // nothing in the app hard-deletes a user's file (Library rewrite L3).
  secureIpcHandle('resource:trash-session-deletion', (_event, operationId: unknown) =>
    trashSessionDeletion(operationId)
  )
  secureIpcHandle('screens:pick-image', () => pickScreenImage())
  secureIpcHandle('system:pick-file', () => pickFilePath())
  secureIpcHandle('system:pick-directory', () => pickDirectoryPath())
  secureIpcHandle('system:check-directory', (_event, capabilityId: unknown) =>
    checkDirectoryFactsForCapability(capabilityId)
  )
  secureIpcHandle('backgrounds:import-image', () => importBackgroundImage())
  secureIpcHandle('backgrounds:bundled-assets', () => bundledBackgroundAssets())
  secureIpcHandle('backgrounds:asset-exists', (_event, assetId: unknown) =>
    backgroundAssetFileExists(assetId)
  )
  secureIpcHandle('avatars:cache', (_event, url: unknown) => cacheChatAvatar(url))
  secureIpcHandle('oauth:open-url', (_event, authUrl: string) => openOAuthUrl(authUrl))
  secureIpcHandle('oauth:callback-redirect-uri', (_event, platform?: string) =>
    oauthCallbackRedirectUri(platform)
  )
  secureIpcHandle('preview-surface:mode', () => nativePreviewSurfaceProofEnabled)
  secureIpcHandle('preview-surface:pump-mode', () => nativePreviewMainPumpActive)
  // Vibrancy tints by OS appearance; the renderer's theme toggle drives it so
  // the blur material always matches the in-app theme (videorc-design).
  secureIpcHandle('app:set-native-theme', (_event, theme: string) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'
    // The solid base must follow the theme wherever a solid base is painted:
    // always off macOS, and on macOS when vibrancy is opted out.
    if (!isMac || !glassVibrancyEnabled) {
      mainWindow?.setBackgroundColor(theme === 'light' ? '#F5F5F7' : '#1C1C1F')
    }
  })
  secureIpcHandle('glass:wallpaper:get', () => {
    const geometry = glassGeometry()
    if (!glassWallpaperDataUrl || !geometry) {
      return null
    }
    return { imageDataUrl: glassWallpaperDataUrl, ...geometry }
  })
  secureIpcHandle('preview-window:open', () => openPreviewWindow())
  secureIpcHandle('preview-window:close', () => closePreviewWindow())
  secureIpcHandle('preview-window:toggle', () => togglePreviewWindow())
  secureIpcHandle('preview-window:get-state', () => previewWindowState())
  secureIpcHandle(
    'preview-window:permission-required',
    (_event, permissionStatus: unknown, message: unknown, generation: unknown) =>
      reportPreviewPermissionRequired(
        previewPermissionStatusFromIpc(permissionStatus),
        typeof message === 'string' ? message : undefined,
        previewSurfaceGenerationFromIpc(generation)
      )
  )
  secureIpcHandle('preview-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setPreviewWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  secureIpcHandle('preview-window:set-mode', (_event, mode: unknown) => setPreviewWindowMode(mode))
  secureIpcHandle('preview-window:report-dock-slot', (_event, report: unknown) =>
    reportPreviewDockSlot(report)
  )
  secureIpcHandle('preview-window:set-dock-overlay', (_event, open: unknown) =>
    setPreviewDockOverlayOpen(open === true)
  )
  secureIpcHandle('preview-window:set-aspect-ratio', (_event, width: number, height: number) => {
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
  secureIpcHandle('notes-window:open', () => openNotesWindow())
  secureIpcHandle('notes-window:close', () => closeNotesWindow())
  secureIpcHandle('notes-window:get-state', () => notesWindowState())
  secureIpcHandle('notes-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setNotesWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  secureIpcHandle('notes-window:get-document', () => defaultNotesDocument())
  secureIpcHandle('notes-window:save-document', (event, patch: Partial<NotesDocument>) => {
    const document = saveNotesDocument(patch ?? {})
    if (notesWindow && event.sender.id === notesWindow.webContents.id && notesWindowClosing) {
      finishNotesWindowClose(notesWindow)
    }
    return document
  })
  secureIpcHandle('comments-window:open', () => openCommentsWindow())
  secureIpcHandle('comments-window:close', () => closeCommentsWindow())
  secureIpcHandle('comments-window:toggle', () => toggleCommentsWindow())
  secureIpcHandle('comments-window:get-state', () => commentsWindowState())
  secureIpcHandle('comments-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setCommentsWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  // Relay (C3): the main renderer owns the single WS client and pushes each
  // live-chat snapshot through here to the window; the window's Clear routes
  // back to the main renderer. Last snapshot is cached for the window's first paint.
  secureIpcHandle('comments-window:push-snapshot', (event, view: CommentsViewSnapshot) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return undefined
    }
    if (commentsSmokeSnapshotOverride) {
      return currentCommentsView()
    }
    cacheCommentsView(view)
    if (commentsViewMode.kind === view.mode.kind) {
      if (
        view.mode.kind === 'live' ||
        (commentsViewMode.kind === 'history' && commentsViewMode.sessionId === view.mode.sessionId)
      ) {
        emitCommentsView()
      }
    }
    return view
  })
  secureIpcHandle('comments-window:get-snapshot', () => currentCommentsView())
  secureIpcHandle('comments-window:set-view-mode', (event, value: unknown) => {
    const mode = parseCommentsViewMode(value)
    if (!mode) {
      throw new Error('Comments view mode must be live or a complete history selection.')
    }
    if (
      !commentsViewModeSenderAllowed({
        senderId: event.sender.id,
        mainRendererId: mainWindow?.webContents.id,
        commentsRendererId: commentsWindow?.webContents.id,
        mode
      })
    ) {
      throw new Error('This window cannot change the Comments view mode.')
    }
    if (
      mode.kind === 'history' &&
      commentsHistorySnapshots.get(mode.sessionId)?.sessionId !== mode.sessionId
    ) {
      throw new Error('The requested Comments history snapshot is unavailable.')
    }
    commentsViewMode = mode
    emitCommentsView()
    return currentCommentsView()
  })
  secureIpcHandle('comments-window:push-delta', (event, delta: CommentsSnapshotDelta) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return currentCommentsView()
    }
    if (commentsSmokeSnapshotOverride) {
      return currentCommentsView()
    }

    const current = latestLiveCommentsSnapshot
    const deltaSessionId = delta.kind === 'message' ? delta.message.sessionId : delta.sessionId
    if (current?.sessionId && deltaSessionId && current.sessionId !== deltaSessionId) {
      return currentCommentsView()
    }

    const next = applyCommentsSnapshotDelta(current, delta)
    if (next === current) {
      return currentCommentsView()
    }
    latestLiveCommentsSnapshot = next
    if (
      commentsViewMode.kind === 'live' &&
      commentsWindow &&
      !commentsWindow.webContents.isDestroyed()
    ) {
      sendElectronEvent(commentsWindow.webContents, 'comments-window:delta', delta)
    }
    return currentCommentsView()
  })
  // Click-to-highlight relay (Comments upgrade S3): the window clicks, the
  // MAIN renderer owns the lifecycle + rasterization (it has the backend
  // client), and the resulting on-stream state relays back to the window.
  secureIpcHandle('comments-window:highlight', (event, value: unknown): Promise<unknown> => {
    if (!commentsWindow || event.sender.id !== commentsWindow.webContents.id) {
      return Promise.reject(new Error('Only the Comments window can request a highlight.'))
    }
    const requestId = commentsCommandRequestId(value)
    if (!('sessionId' in (value as object)) || !('messageId' in (value as object))) {
      return Promise.reject(new Error('Comments highlight requires a session and message id.'))
    }
    const command = value as CommentHighlightCommand
    if (typeof command.messageId !== 'string' || !command.messageId.trim()) {
      return Promise.reject(new Error('Comments highlight requires a message id.'))
    }
    assertLiveCommentsCommandSession(command.sessionId)
    return commentsCommandBroker.request(requestId, () => {
      if (dispatchSmokeCommentHighlight(command)) return true
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return false
      sendElectronEvent(mainWindow.webContents, 'comments-window:highlight-request', command)
      return true
    })
  })
  secureIpcHandle(
    'comments-window:highlight-result-push',
    (event, resolution: CommentsCommandResolution<unknown>) => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false
      return commentsCommandBroker.resolve(resolution)
    }
  )
  secureIpcHandle('comments-window:highlight-state-push', (event, state: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return undefined
    }
    const next: CommentHighlightState =
      typeof state === 'object' && state !== null && 'phase' in state && 'generation' in state
        ? (state as CommentHighlightState)
        : { generation: latestCommentHighlightState.generation + 1, phase: 'idle' }
    emitCommentHighlightState(next)
  })
  secureIpcHandle('comments-window:highlight-state-get', () => latestCommentHighlightState)
  // Viewer-count relay (viewer rider V2): the main renderer owns the backend
  // WS and pushes the latest stream.viewers sample; the Comments window seeds
  // from the cache and follows pushes. Null clears the chip (session over).
  secureIpcHandle('comments-window:viewers-push', (event, sample: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return undefined
    }
    latestViewerSample = sample && typeof sample === 'object' ? (sample as ViewerSample) : null
    if (commentsWindow && !commentsWindow.webContents.isDestroyed()) {
      sendElectronEvent(commentsWindow.webContents, 'comments-window:viewers', latestViewerSample)
    }
  })
  secureIpcHandle('comments-window:viewers-get', () => latestViewerSample)
  // Send relay (Comments upgrade S5): the window types, the MAIN renderer owns
  // the backend call, and the per-platform results relay back to the window.
  secureIpcHandle(
    'comments-window:send',
    (event, value: unknown): Promise<CommentsSendOperation> => {
      if (!commentsWindow || event.sender.id !== commentsWindow.webContents.id) {
        return Promise.reject(new Error('Only the Comments window can send Comments commands.'))
      }
      const requestId = commentsCommandRequestId(value)
      if (
        !('sessionId' in (value as object)) ||
        !('operationId' in (value as object)) ||
        !('text' in (value as object))
      ) {
        return Promise.reject(new Error('Comments send requires an operation, session, and text.'))
      }
      const command = value as CommentsSendCommand
      if (
        typeof command.operationId !== 'string' ||
        !command.operationId.trim() ||
        typeof command.text !== 'string'
      ) {
        return Promise.reject(new Error('Comments send requires an operation id and text.'))
      }
      assertLiveCommentsCommandSession(command.sessionId)
      return commentsCommandBroker.request(requestId, () => {
        if (dispatchSmokeCommentsSend(command)) return true
        if (!mainWindow || mainWindow.webContents.isDestroyed()) return false
        sendElectronEvent(mainWindow.webContents, 'comments-window:send-request', command)
        return true
      })
    }
  )
  secureIpcHandle(
    'comments-window:send-result-push',
    (event, resolution: CommentsCommandResolution<CommentsSendOperation>) => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false
      const accepted = commentsCommandBroker.resolve(resolution)
      if (accepted && resolution.ok && resolution.value) {
        cacheCommentsSendResult(resolution.value)
      }
      return accepted
    }
  )
  secureIpcHandle('comments-window:clear', (event, value: unknown): Promise<LiveChatSnapshot> => {
    if (!commentsWindow || event.sender.id !== commentsWindow.webContents.id) {
      return Promise.reject(new Error('Only the Comments window can clear Comments.'))
    }
    const requestId = commentsCommandRequestId(value)
    if (!('sessionId' in (value as object))) {
      return Promise.reject(new Error('Comments clear requires a live session id.'))
    }
    const command = value as CommentsClearCommand
    assertLiveCommentsCommandSession(command.sessionId)
    return commentsCommandBroker.request(requestId, () => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return false
      sendElectronEvent(mainWindow.webContents, 'comments-window:clear-request', command)
      return true
    })
  })
  secureIpcHandle(
    'comments-window:clear-result-push',
    (event, resolution: CommentsCommandResolution<LiveChatSnapshot>) => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false
      const accepted = commentsCommandBroker.resolve(resolution)
      if (accepted && resolution.ok && resolution.value) {
        cacheCommentsView({ mode: { kind: 'live' }, snapshot: resolution.value })
        emitCommentsView()
      }
      return accepted
    }
  )
  secureIpcHandle('captions-window:open', () => openCaptionsWindow())
  secureIpcHandle('captions-window:close', () => closeCaptionsWindow())
  secureIpcHandle('captions-window:toggle', () => toggleCaptionsWindow())
  secureIpcHandle('captions-window:get-state', () => captionsWindowState())
  secureIpcHandle('captions-window:set-always-on-top', (_event, alwaysOnTop: boolean) =>
    setCaptionsWindowAlwaysOnTop(Boolean(alwaysOnTop))
  )
  // Same relay shape as comments: the main renderer owns the backend WS and
  // pushes its caption-line buffer; main caches it for the window's first paint.
  secureIpcHandle('captions-window:push-snapshot', (_event, snapshot: CaptionWindowSnapshot) => {
    latestCaptionSnapshot = snapshot
    latestCaptionLines = Array.isArray(snapshot.lines) ? snapshot.lines : []
    if (captionsWindow && !captionsWindow.webContents.isDestroyed()) {
      sendElectronEvent(
        captionsWindow.webContents,
        'captions-window:snapshot',
        latestCaptionSnapshot
      )
    }
  })
  secureIpcHandle('captions-window:get-snapshot', () => latestCaptionSnapshot)
  secureIpcHandle('captions-window:push-lines', (_event, lines: CaptionsUpdate[]) => {
    latestCaptionLines = Array.isArray(lines) ? lines : []
    latestCaptionSnapshot = { ...latestCaptionSnapshot, lines: latestCaptionLines }
    if (captionsWindow && !captionsWindow.webContents.isDestroyed()) {
      sendElectronEvent(captionsWindow.webContents, 'captions-window:lines', latestCaptionLines)
      sendElectronEvent(
        captionsWindow.webContents,
        'captions-window:snapshot',
        latestCaptionSnapshot
      )
    }
  })
  secureIpcHandle('captions-window:get-lines', () => latestCaptionLines)
  secureIpcHandle('preview-surface:create', (_event, bounds: PreviewSurfaceBounds, generation) => {
    const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
    return runNativePreviewSurfaceMutation(() =>
      createNativePreviewSurface(bounds, requestedGeneration)
    )
  })
  secureIpcHandle(
    'preview-surface:update-bounds',
    (_event, bounds: PreviewSurfaceBounds, generation) => {
      const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
      return runNativePreviewSurfaceMutation(() =>
        updateNativePreviewSurfaceBounds(bounds, requestedGeneration)
      )
    }
  )
  secureIpcHandle(
    'preview-surface:apply-host-commands',
    (_event, commands: NativePreviewHostCommand[], generation) => {
      const requestedGeneration = previewSurfaceGenerationFromIpc(generation)
      return runNativePreviewSurfaceMutation(() =>
        applyNativePreviewHostCommands(commands, requestedGeneration)
      )
    }
  )
  secureIpcHandle('preview-surface:drain-host-commands', (_event, generation) =>
    drainBackendNativePreviewHostCommands(previewSurfaceGenerationFromIpc(generation))
  )
  secureIpcHandle(
    'preview-surface:update-scene',
    (_event, scene: PreviewSurfaceSceneUpdateParams) => updateNativePreviewSurfaceScene(scene)
  )
  secureIpcHandle(
    'preview-surface:update-compositor',
    (_event, status: PreviewSurfaceCompositorUpdateParams) => {
      const ownershipTicket = nativePreviewPumpOwnership.ticket('renderer')
      return nativePreviewPumpOwnership.accepts(ownershipTicket)
        ? updateNativePreviewSurfaceCompositor(status, { ownershipTicket }).then((result) =>
            result.compositorUpdateAccepted === false
              ? result
              : { ...result, compositorUpdateAccepted: true }
          )
        : rejectedNativePreviewCompositorUpdateStatus()
    }
  )
  secureIpcHandle(
    'preview-surface:set-frame-polling-suppressed',
    (_event, suppressed: boolean, recordingActive?: boolean) => {
      if (typeof recordingActive === 'boolean') {
        nativePreviewProofPollingRecordingActive = recordingActive
      }
      // With the preview window closed, polling stays suppressed no matter what
      // the renderer's (possibly stale, post-close) state events request — an
      // un-suppress race here left polling running against a destroyed surface.
      // Keep the recording state above so a preview opened mid-recording starts
      // with the contained Windows proof-polling profile.
      if (!suppressed && (!previewWindow || previewWindow.isDestroyed())) {
        nativePreviewSurfaceFramePollingSuppressed = true
        nativePreviewSurfaceStatus = nativePreviewClosedWindowUnsuppressStatus(
          nativePreviewSurfaceStatus
        )
        return {
          ...nativePreviewSurfaceStatus,
          ...nativePreviewPlacementStatusFields()
        }
      }
      return setNativePreviewSurfaceFramePollingSuppressed(suppressed, recordingActive)
    }
  )
  secureIpcHandle('preview-surface:destroy', (_event, generation) => {
    nativePreviewPlacementQueue.cancelPending()
    return runNativePreviewSurfaceMutation(() =>
      destroyNativePreviewSurface(previewSurfaceGenerationFromIpc(generation))
    )
  })
  secureIpcHandle('preview-surface:status', () => ({
    ...nativePreviewSurfaceStatus,
    ...nativePreviewPlacementStatusFields()
  }))

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

// Smoke/performance harnesses stop the isolated process group with SIGTERM.
// Route that through Electron's normal before-quit path so the backend child
// and its owned-process ledger are cleared before the launcher escalates.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logBackend('info', `Received ${signal}; requesting graceful app shutdown.`)
    app.quit()
  })
}

app.on('before-quit', (event) => {
  if (smokeAppQuitGuard.shouldPreventQuit()) {
    event.preventDefault()
    safeConsole.warn('Ignored app quit while the preview lifecycle probe owns the app.')
    return
  }
  appIsQuitting = true
  accountSignInTransactions?.dispose()
  providerOAuthCallbacks?.dispose()
  cancelBackendRestart()
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
