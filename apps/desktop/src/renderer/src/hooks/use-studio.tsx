import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction
} from 'react'
import { toast } from 'sonner'

import { BackendClient } from '@/backendClient'
import { previewSurfaceBoundsChanged } from '../../../shared/native-preview-bounds'
import {
  applyStoredManualStreamKeyResult,
  bridgeStreamingToLegacy,
  areEnabledStreamTargetsStartReady,
  defaultSettings,
  legacyStreamKeyMigrationCandidates,
  loadCaptureConfig,
  loadJson,
  patchPreparedStreamTarget,
  patchStreamTargetForEdit,
  persistableCaptureConfig,
  preparedYouTubeActivationTargets,
  preparedYouTubeCompletionTargets,
  reconcileSourceSelection,
  rtmpDefaults,
  smokePreviewCompositorCaptureConfig,
  sourceSelectionChangeMessages,
  STORAGE_KEYS,
  videoProfileCompatibility,
  videoPresets,
  type CaptureConfig,
  type SettingsState,
  type SetupStep,
  type WsStatus
} from '@/lib/capture'
import {
  decideCancelGoLiveConfirmation,
  decideContinueGoLiveWithReadyDestinations,
  decideGoLivePreflight,
  decideGoLiveStart,
  decidePreparedGoLiveSetup,
  type GoLivePartialSetup,
  type GoLiveSetupFailure
} from '@/lib/go-live-flow'
import type {
  AiWorkflowResult,
  AudioMeterResult,
  BackendConnection,
  BackendHealth,
  BackendLogEvent,
  CompositorSceneUpdateParams,
  CompositorStatus,
  DiagnosticStats,
  Device,
  DeviceList,
  EntitlementsSnapshot,
  ExportPublishPackResult,
  FileAssessment,
  GateStatus,
  GoLivePreflight,
  HealthEvent,
  LayoutPreset,
  LayoutSettings,
  LiveLayoutApplyStatus,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  NativePreviewHostCommand,
  PreviewCameraStatus,
  PreviewScreenStatus,
  PreviewSurfaceBounds,
  PreviewSurfacePresentParams,
  PreviewSurfaceSceneUpdateParams,
  PreviewSurfaceStatus,
  PreviewWindowState,
  PreviewLiveStatus,
  PlatformAccount,
  PlatformAccountValidation,
  PreparedTwitchBroadcast,
  PreparedYouTubeBroadcast,
  OAuthCompleteParams,
  OAuthStartResult,
  OAuthProviderCredentialStatus,
  RecordingStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SessionLogEntry,
  SessionSummary,
  SourceSelection,
  StartSessionParams,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamScreen,
  StreamHealth,
  StoreManualStreamKeyResult,
  StreamingSettings,
  StreamTargetRuntime,
  StreamTargetSettings,
  StreamTargetsSnapshot,
  SupportBundleExportResult,
  SystemPermissionPane,
  TwitchCategory,
  VideoPreset,
  VideoSettings,
  XNativeLiveCapability,
  YouTubeBroadcastTransitionResult,
  YouTubeChannel,
  YouTubeStreamStatusResult
} from '@/lib/backend'
import { createEmptyLiveChatSnapshot } from '@/lib/backend'
import { entitlementDisabledReason } from '@/lib/entitlements'
import {
  applyLiveChatMessage,
  applyLiveChatProviderStatus,
  applyLiveChatSnapshot
} from '@/lib/live-chat-view'
import {
  buildNativePreviewCompositorUpdateParams,
  decideNativePreviewCompositorPresent,
  nativePreviewDroppedFramesWithSuppressed,
  pendingCompositorStatusSupersedes,
  type NativePreviewRendererTimingFields
} from '@/lib/native-preview-present-policy'
import { effectiveSceneBackground } from '@/lib/background-assets'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { buildStartSessionParams } from '@/lib/session-params'
import {
  findDevice,
  durationLabel,
  isActiveRecordingState,
  mergeStreamHealth,
  setupChecklist
} from '@/lib/format'

export type { GoLivePartialSetup, GoLiveSetupFailure } from '@/lib/go-live-flow'

const NATIVE_PREVIEW_SURFACE_PRESENT_REPORT_INTERVAL_MS = 250

// Steady-state telemetry (surface counters, diagnostics stats) commits to
// React state at most once a second. Every commit re-renders the entire
// StudioContext tree, and in dev each of those renders also feeds React's
// per-component performance instrumentation — at the backend's 4Hz event
// cadence that alone kept the renderer permanently busy. State-machine flips
// still commit immediately via the significant-change fast path.
const TELEMETRY_UI_COMMIT_INTERVAL_MS = 1000

// One target patch, with the derived streaming fields (enabled flag, mode,
// enabled ids) recomputed — shared by the settings editor and the Go Live
// blocker resolutions so a patched snapshot can also be validated immediately.
function streamingWithTargetPatch(
  streaming: StreamingSettings,
  targetId: string,
  patch: Partial<StreamTargetSettings>,
  now: string = new Date().toISOString()
): StreamingSettings {
  const targets = streaming.targets.map((target) =>
    target.id === targetId ? patchStreamTargetForEdit(target, patch, now) : target
  )
  const enabledTargetIds = targets.filter((target) => target.enabled).map((target) => target.id)
  return {
    ...streaming,
    targets,
    enabled: enabledTargetIds.length > 0,
    mode: enabledTargetIds.length > 1 ? 'multi' : 'single',
    enabledTargetIds
  }
}
const NATIVE_PREVIEW_COMPOSITOR_POLL_INTERVAL_MS = 1000 / 60
const NATIVE_PREVIEW_COMPOSITOR_TIMING_SAMPLE_LIMIT = 900

function recordNativePreviewTimingSample(samples: number[], value: number): void {
  if (!Number.isFinite(value)) {
    return
  }
  samples.push(Math.max(0, value))
  while (samples.length > NATIVE_PREVIEW_COMPOSITOR_TIMING_SAMPLE_LIMIT) {
    samples.shift()
  }
}

function nativePreviewTimingPercentile(
  values: number[],
  percentileRank: number
): number | undefined {
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

export type StudioContextValue = {
  // connection + backend state
  connection: BackendConnection | null
  wsStatus: WsStatus
  health: BackendHealth | null
  entitlements: EntitlementsSnapshot | null
  deviceList: DeviceList
  recording: RecordingStatus
  logs: BackendLogEvent[]
  healthEvents: HealthEvent[]
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
  diagnosticStats: DiagnosticStats
  sessions: SessionSummary[]
  screens: StreamScreen[]
  activeScreen: StreamScreen | null
  platformAccounts: PlatformAccount[]
  platformAccountValidations: PlatformAccountValidation[]
  oauthProviderCredentials: OAuthProviderCredentialStatus[]
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  twitchCategories: TwitchCategory[]
  twitchCategorySearchPending: boolean
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  /** Read-only live-chat snapshot for the studio comments panel, driven by liveChat.* events. */
  liveChatSnapshot: LiveChatSnapshot
  /** Clear the local chat view (calls liveChat.clearLocal; not platform messages). */
  clearLiveChat: () => Promise<void>
  streamMetadataDraft: StreamMetadataDraft | null
  streamMetadataValidation: StreamMetadataValidation | null
  goLivePreflight: GoLivePreflight | null
  goLiveConfirmationOpen: boolean
  goLiveConfirmationPending: boolean
  goLivePartialSetup: GoLivePartialSetup | null
  // preview + audio
  previewUrl: string | null
  previewLoading: boolean
  previewLiveStatus: PreviewLiveStatus
  previewCameraStatus: PreviewCameraStatus
  previewScreenStatus: PreviewScreenStatus
  previewSurfaceStatus: PreviewSurfaceStatus
  nativePreviewSurfaceEnabled: boolean
  previewWindow: PreviewWindowState
  openPreviewWindow: () => Promise<void>
  closePreviewWindow: () => Promise<void>
  setPreviewWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>
  scene: Scene | null
  sceneEditMode: boolean
  selectedSceneSourceId: string | null
  setSceneEditMode: Dispatch<SetStateAction<boolean>>
  setSelectedSceneSourceId: Dispatch<SetStateAction<string | null>>
  audioMeter: AudioMeterResult | null
  audioMeterLoading: boolean
  // ai + jobs
  aiConsent: boolean
  setAiConsent: Dispatch<SetStateAction<boolean>>
  aiRunningSessionId: string | null
  exportRunningSessionId: string | null
  startRequestPending: boolean
  stopRequestPending: boolean
  screenImportPending: boolean
  streamMetadataSavePending: boolean
  supportBundleExportPending: boolean
  // settings + capture config
  settings: SettingsState
  setSettings: Dispatch<SetStateAction<SettingsState>>
  captureConfig: CaptureConfig
  setCaptureConfig: Dispatch<SetStateAction<CaptureConfig>>
  patchLayout: (patch: Partial<LayoutSettings>) => void
  applyCameraPreset: (patch: Partial<LayoutSettings>) => void
  // The layout preset a live switch is currently starting sources for, if any
  // (drives the "Switching…" pending state; plan slice D2).
  layoutSwitchPending: LayoutPreset | null
  sourceDeviceSwitchPending: LiveSourceDeviceSwitchPending | null
  switchSourceDeviceLive: (
    sourceKind: LiveSourceDeviceSwitchPending,
    sources: SourceSelection
  ) => Promise<void>
  patchVideo: (patch: Partial<VideoSettings>) => void
  applyVideoPreset: (preset: VideoPreset) => void
  applyRtmpPreset: (preset: RtmpPreset) => void
  patchStreamingTarget: (targetId: string, patch: Partial<StreamTargetSettings>) => void
  resolveGoLiveBlocker: (targetId: string, resolution: 'disable' | 'manual-rtmp') => Promise<void>
  // Resolves true only when the key was actually stored (lets the UI clear
  // the typed draft without ever losing an unsaved key).
  saveManualStreamKey: (targetId: string, streamKey: string) => Promise<boolean>
  restorePreviousStreamKey: (targetId: string) => Promise<void>
  patchStreamMetadataDraft: (patch: Partial<StreamMetadataDraft>) => void
  patchStreamTargetMetadataDraft: (
    platform: StreamMetadataDraft['targetOverrides'][number]['platform'],
    patch: Partial<StreamMetadataDraft['targetOverrides'][number]>
  ) => void
  // notices
  lastError: string | null
  runtimeInfo: RuntimeInfo | null
  // actions
  refreshBackend: () => Promise<void>
  refreshPlatformAccounts: () => Promise<void>
  validatePlatformAccounts: () => Promise<PlatformAccountValidation[]>
  connectPlatformAccount: (platform: PlatformAccount['platform']) => Promise<void>
  disconnectPlatformAccount: (platform: PlatformAccount['platform']) => Promise<void>
  refreshYouTubeChannels: (accountId?: string) => Promise<void>
  selectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  searchTwitchCategories: (query: string) => Promise<void>
  refreshXNativeCapability: (accountId?: string) => Promise<void>
  refreshStreamMetadata: () => Promise<void>
  saveStreamMetadataDraft: () => Promise<void>
  cancelGoLiveConfirmation: () => void
  confirmGoLive: () => Promise<void>
  continueGoLiveWithReadyDestinations: () => Promise<void>
  refreshScreens: () => Promise<void>
  importScreenImage: () => Promise<void>
  renameScreen: (screenId: string, name: string) => Promise<void>
  deleteScreen: (screenId: string) => Promise<void>
  moveScreen: (screenId: string, direction: -1 | 1) => Promise<void>
  activateScreen: (screenId: string) => Promise<void>
  clearActiveScreen: () => Promise<void>
  refreshPreview: () => Promise<void>
  reloadSceneFromCaptureConfig: () => Promise<void>
  resetSceneSource: (sourceId?: string) => Promise<void>
  nudgeSceneSource: (
    sourceId: string,
    directionX: number,
    directionY: number,
    large?: boolean
  ) => Promise<void>
  commitCameraTransform: (sourceId: string, x: number, y: number) => Promise<void>
  setSceneSourceVisible: (sourceId: string, visible: boolean) => Promise<void>
  moveSceneSource: (sourceId: string, direction: -1 | 1) => Promise<void>
  openSystemPermission: (pane: SystemPermissionPane) => Promise<void>
  openPreviewPermissions: () => Promise<void>
  revealPermissionTarget: () => Promise<void>
  exportSupportBundle: () => Promise<void>
  registerPreviewSurfaceResize: () => void
  syncNativePreviewSurfaceBounds: (bounds: PreviewSurfaceBounds) => Promise<void>
  sampleAudioMeter: () => Promise<void>
  startSession: () => Promise<void>
  stopSession: () => Promise<void>
  remuxSession: (sessionId: string) => Promise<void>
  runAiWorkflow: (sessionId: string) => Promise<void>
  exportPublishPack: (sessionId: string) => Promise<void>
  assessRecording: (path: string) => Promise<FileAssessment>
  repairRecording: (path: string) => Promise<GateStatus>
  restoreRecording: (path: string) => Promise<boolean>
  // derived
  outputEnabled: boolean
  streamReady: boolean
  isSessionActive: boolean
  startBlockedReason: string | null
  canStart: boolean
  canStop: boolean
  visibleStartBlockedReason: string | null
  selectedCaptureDevice?: Device
  selectedCamera?: Device
  selectedMicrophone?: Device
  setupSteps: SetupStep[]
  elapsed: string
  meterLevel: number
  canSampleAudio: boolean
}

const StudioContext = createContext<StudioContextValue | null>(null)

const idleDiagnosticStats = (): DiagnosticStats => ({
  skippedFrames: 0,
  droppedFrames: 0,
  encoderBridgeQueueDepth: 0,
  encoderBridgeDroppedFrames: 0,
  encoderBridgeRepeatedFrames: 0,
  encoderBridgeRepeatedFrameBursts: 0,
  encoderBridgeMaxRepeatedFrameRun: 0,
  encoderBridgeSyntheticFrames: 0,
  encoderBridgeSourceAgeP95Ms: undefined,
  encoderBridgeRepeatedFrameAgeP95Ms: undefined,
  encoderBridgeRepeatedFrameAgeMaxMs: undefined,
  encoderBridgeMetalTargetFrames: 0,
  encoderBridgeRawVideoCopiedFrames: 0,
  encoderBridgeMetalTargetCopiedFrames: 0,
  encoderBridgeMetalTargetHandleFrames: 0,
  encoderBridgeZeroCopyFrames: 0,
  encoderBridgeVideoToolboxProbeFrames: 0,
  encoderBridgeVideoToolboxProbeBytes: 0,
  encoderBridgeVideoToolboxProbeErrors: 0,
  encoderBridgeVideoToolboxOutputFrames: 0,
  encoderBridgeVideoToolboxOutputBytes: 0,
  encoderBridgeVideoToolboxOutputEncodeMs: undefined,
  recordingOutputWidth: undefined,
  recordingOutputHeight: undefined,
  recordingOutputFps: undefined,
  recordingOutputBitrateKbps: undefined,
  streamOutputWidth: undefined,
  streamOutputHeight: undefined,
  streamOutputFps: undefined,
  streamOutputBitrateKbps: undefined,
  encoderBridgeActiveVideoToolboxOutputEncoders: 0,
  encoderBridgeRecordingVideoToolboxOutputFrames: 0,
  encoderBridgeRecordingVideoToolboxOutputBytes: 0,
  encoderBridgeStreamVideoToolboxOutputFrames: 0,
  encoderBridgeStreamVideoToolboxOutputBytes: 0,
  encoderBridgeSeparateOutputEncodersActive: false,
  encoderBridgeCompositorWaitP95Ms: undefined,
  encoderBridgeVideoToolboxSubmitP95Ms: undefined,
  encoderBridgeVideoToolboxFifoWriteP95Ms: undefined,
  encoderBridgeWriterLoopP95Ms: undefined,
  encoderBridgeWriterSleepP95Ms: undefined,
  encoderBridgeWriterActiveP95Ms: undefined,
  encoderBridgeDeadlineLagP95Ms: undefined,
  encoderBridgeDeadlineLagMaxMs: undefined,
  encoderBridgeLateDeadlineTicks: 0,
  compositorCpuFallbackFrames: 0,
  compositorSourceIosurfaceImportFrames: 0,
  compositorSourceCvpixelbufferImportFrames: 0,
  compositorSourceByteUploadFrames: 0,
  compositorSourceImportFailures: 0,
  compositorCameraSourceIosurfaceImportFrames: 0,
  compositorCameraSourceCvpixelbufferImportFrames: 0,
  compositorCameraSourceByteUploadFrames: 0,
  compositorCameraSourceImportFailures: 0,
  compositorScreenSourceIosurfaceImportFrames: 0,
  compositorScreenSourceCvpixelbufferImportFrames: 0,
  compositorScreenSourceByteUploadFrames: 0,
  compositorScreenSourceImportFailures: 0,
  previewImagePollCounts: { cameraPng: 0, screenPng: 0, liveJpeg: 0, liveMjpeg: 0 },
  recordingAtRisk: false,
  recordingRiskReasons: [],
  recordingProtected: false,
  recordingStartupBarrierState: undefined,
  recordingStartupBarrierWaitMs: undefined,
  recordingStartupBarrierTimeoutReason: undefined,
  firstSourceFrameMs: undefined,
  firstFullResolutionCompositorFrameMs: undefined,
  firstEncodedFrameMs: undefined,
  previewTransport: 'unavailable',
  previewSourceFps: {},
  previewSurfaceBacking: 'none',
  previewFramePollingSuppressed: false,
  previewSourcePixelsPresent: false,
  compositorPreviewSurfaceLockContentions: 0,
  compositorStatusLockContentions: 0,
  compositorCameraSourceTryLockMisses: 0,
  compositorScreenSourceTryLockMisses: 0,
  compositorCameraSourceBlockingRefreshes: 0,
  compositorScreenSourceBlockingRefreshes: 0,
  previewRepeatedFrames: 0,
  previewSurfaceResizeCount: 0,
  previewDroppedFrames: 0,
  previewCameraDroppedFrames: 0,
  previewCameraCapabilityFormats: [],
  previewCameraFrameBytes: 0,
  previewScreenDroppedFrames: 0,
  previewScreenFrameBytes: 0,
  previewScreenCaptureQueueDepth: 0,
  previewSourceFrameBufferCount: 0,
  previewSourceFrameBytes: 0,
  previewSourceFrameDroppedFrames: 0,
  micDroppedFrames: 0,
  deviceDisconnected: false,
  activeFfmpegProcesses: 0,
  activeFfprobeProcesses: 0,
  ffmpegCaptureActive: false,
  ffmpegFinalizingActive: false,
  ffmpegMaintenanceRunning: false,
  ffmpegMaintenanceCancelRequested: false,
  duplicateCaptureSources: [],
  sourceRegistry: { entries: [] },
  bottleneck: 'none',
  updatedAt: new Date().toISOString()
})

const idlePreviewSurfaceStatus = (): PreviewSurfaceStatus => ({
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
  message: 'Native preview surface is not running.'
})

const isPreviewSurfaceTransport = (transport: PreviewLiveStatus['transport']): boolean =>
  transport === 'native-surface' || transport === 'electron-proof-surface'

type LiveSourceDeviceSwitchPending = 'capture' | 'camera'

const idlePreviewCameraStatus = (): PreviewCameraStatus => ({
  state: 'device-missing',
  targetFps: 0,
  framesCaptured: 0,
  droppedFrames: 0,
  updatedAt: new Date().toISOString(),
  message: 'Native camera preview is not running.'
})

const idlePreviewScreenStatus = (): PreviewScreenStatus => ({
  state: 'source-missing',
  targetFps: 0,
  framesCaptured: 0,
  droppedFrames: 0,
  includeCursor: true,
  excludeCurrentProcessWindows: true,
  updatedAt: new Date().toISOString(),
  message: 'Native screen preview is not running.'
})

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext)
  if (!value) {
    throw new Error('useStudio must be used within a StudioProvider')
  }
  return value
}

export function StudioProvider({ children }: { children: ReactNode }): ReactElement {
  const [connection, setConnection] = useState<BackendConnection | null>(null)
  const [client, setClient] = useState<BackendClient | null>(null)
  const clientRef = useRef<BackendClient | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('waiting')
  const wsStatusRef = useRef<WsStatus>('waiting')
  clientRef.current = client
  wsStatusRef.current = wsStatus
  const [health, setHealth] = useState<BackendHealth | null>(null)
  const [entitlements, setEntitlements] = useState<EntitlementsSnapshot | null>(null)
  const [deviceList, setDeviceList] = useState<DeviceList>({ devices: [], warnings: [] })
  const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  const [logs, setLogs] = useState<BackendLogEvent[]>([])
  const [healthEvents, setHealthEvents] = useState<HealthEvent[]>([])
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null)
  const [streamTargets, setStreamTargets] = useState<StreamTargetRuntime[]>([])
  const [diagnosticStats, setDiagnosticStats] = useState<DiagnosticStats>(idleDiagnosticStats)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [screens, setScreens] = useState<StreamScreen[]>([])
  const [activeScreen, setActiveScreen] = useState<StreamScreen | null>(null)
  const [platformAccounts, setPlatformAccounts] = useState<PlatformAccount[]>([])
  const [platformAccountValidations, setPlatformAccountValidations] = useState<
    PlatformAccountValidation[]
  >([])
  const [oauthProviderCredentials, setOauthProviderCredentials] = useState<
    OAuthProviderCredentialStatus[]
  >([])
  const [youtubeChannels, setYoutubeChannels] = useState<YouTubeChannel[]>([])
  const [youtubeChannelsLoading, setYoutubeChannelsLoading] = useState(false)
  const [twitchCategories, setTwitchCategories] = useState<TwitchCategory[]>([])
  const [twitchCategorySearchPending, setTwitchCategorySearchPending] = useState(false)
  const [xNativeCapability, setXNativeCapability] = useState<XNativeLiveCapability | null>(null)
  const [xNativeCapabilityLoading, setXNativeCapabilityLoading] = useState(false)
  // Read-only, ephemeral chat store: never persisted; driven by liveChat.* websocket events.
  const [liveChatSnapshot, setLiveChatSnapshot] = useState<LiveChatSnapshot>(() =>
    createEmptyLiveChatSnapshot(new Date().toISOString())
  )
  const clearLiveChat = useCallback(async () => {
    if (!client) return
    await client.request('liveChat.clearLocal')
  }, [client])
  const [streamMetadataDraft, setStreamMetadataDraft] = useState<StreamMetadataDraft | null>(null)
  const [streamMetadataValidation, setStreamMetadataValidation] =
    useState<StreamMetadataValidation | null>(null)
  const [goLivePreflight, setGoLivePreflight] = useState<GoLivePreflight | null>(null)
  const [goLiveConfirmationOpen, setGoLiveConfirmationOpen] = useState(false)
  const [goLiveConfirmationPending, setGoLiveConfirmationPending] = useState(false)
  const [goLivePartialSetup, setGoLivePartialSetup] = useState<GoLivePartialSetup | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLiveStatus, setPreviewLiveStatus] = useState<PreviewLiveStatus>({
    state: 'unavailable',
    source: 'unavailable',
    transport: 'unavailable',
    message: 'Live preview is not running.'
  })
  const [previewSurfaceStatus, setPreviewSurfaceStatus] =
    useState<PreviewSurfaceStatus>(idlePreviewSurfaceStatus)
  const [previewCameraStatus, setPreviewCameraStatus] =
    useState<PreviewCameraStatus>(idlePreviewCameraStatus)
  const [previewScreenStatus, setPreviewScreenStatus] =
    useState<PreviewScreenStatus>(idlePreviewScreenStatus)
  const [scene, setScene] = useState<Scene | null>(null)
  const [sceneEditMode, setSceneEditMode] = useState(false)
  const [selectedSceneSourceId, setSelectedSceneSourceId] = useState<string | null>(null)
  const [audioMeter, setAudioMeter] = useState<AudioMeterResult | null>(null)
  const [audioMeterLoading, setAudioMeterLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [aiConsent, setAiConsent] = useState(false)
  const [aiRunningSessionId, setAiRunningSessionId] = useState<string | null>(null)
  const [exportRunningSessionId, setExportRunningSessionId] = useState<string | null>(null)
  const [startRequestPending, setStartRequestPending] = useState(false)
  const [stopRequestPending, setStopRequestPending] = useState(false)
  const [screenImportPending, setScreenImportPending] = useState(false)
  const [streamMetadataSavePending, setStreamMetadataSavePending] = useState(false)
  const [supportBundleExportPending, setSupportBundleExportPending] = useState(false)
  const [settings, setSettings] = useState<SettingsState>(() =>
    loadJson(STORAGE_KEYS.settings, defaultSettings)
  )
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)
  // Stable handle for callbacks that only need to READ the config (labels,
  // lookups) without re-creating themselves on every config change.
  const captureConfigRef = useRef(captureConfig)
  useEffect(() => {
    captureConfigRef.current = captureConfig
  }, [captureConfig])
  const legacyStreamKeyMigrationAttemptedRef = useRef<Set<string>>(new Set())
  const [lastError, setLastError] = useState<string | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const previewRequestPending = useRef(false)
  const previewRefreshQueued = useRef(false)
  const previewSurfaceStatusRef = useRef<PreviewSurfaceStatus>(idlePreviewSurfaceStatus())
  // True while the MAIN process pumps presents itself; the renderer's 60Hz
  // relay stays dormant then (it leaked IPC serialization buffers at scale).
  const mainPumpActiveRef = useRef(false)
  const [mainPumpActive, setMainPumpActive] = useState(false)
  const previewSurfaceStatusCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewSurfaceStatusLastCommitAtRef = useRef(0)
  const diagnosticStatsPendingRef = useRef<DiagnosticStats | null>(null)
  const diagnosticStatsCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const diagnosticStatsLastCommitAtRef = useRef(0)
  const nativePreviewRendererTimingFieldsCacheRef = useRef<{
    fields: NativePreviewRendererTimingFields
    computedAtMs: number
  } | null>(null)
  const previewCameraStatusRef = useRef<PreviewCameraStatus>(idlePreviewCameraStatus())
  const previewScreenStatusRef = useRef<PreviewScreenStatus>(idlePreviewScreenStatus())
  const recordingRef = useRef<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  // Late-bound mirror so applyRecordingStatus (declared earlier) can trigger the
  // consolidated frame-polling suppression defined with the preview window state.
  const syncFramePollingSuppressionRef = useRef<(() => void) | null>(null)
  const nativePreviewCameraKeyRef = useRef<string | null>(null)
  const nativePreviewScreenKeyRef = useRef<string | null>(null)
  const nativePreviewSurfaceSceneRevisionRef = useRef(0)
  const nativePreviewSurfaceBoundsPendingRef = useRef<PreviewSurfaceBounds | null>(null)
  const nativePreviewSurfaceBoundsSyncInFlightRef = useRef(false)
  const nativePreviewSurfaceCreatedRef = useRef(false)
  const nativePreviewSurfaceLastSyncedBoundsRef = useRef<PreviewSurfaceBounds | null>(null)
  const nativePreviewCompositorPendingRef = useRef<CompositorStatus | null>(null)
  const nativePreviewCompositorLatestStatusRef = useRef<CompositorStatus | null>(null)
  const nativePreviewCompositorPresentingRef = useRef(false)
  const nativePreviewCompositorSuppressedPresentsRef = useRef(0)
  const nativePreviewCompositorLastEventAtRef = useRef(0)
  const nativePreviewCompositorPollInFlightRef = useRef(false)
  const nativePreviewCompositorPumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nativePreviewCompositorPollIntervalSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorPollRoundTripSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorPresentRoundTripSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorLastPollStartedAtRef = useRef(0)
  const nativePreviewCompositorPollInFlightSkipsRef = useRef(0)
  const nativePreviewSurfacePresentReportPendingRef = useRef<PreviewSurfacePresentParams | null>(
    null
  )
  const nativePreviewSurfacePresentReportInFlightRef = useRef(false)
  const nativePreviewSurfacePresentReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const nativePreviewSurfacePresentReportLastSentAtRef = useRef(0)
  const sourceReconciliationMessages = useRef<string[]>([])
  const toastedFailedTargets = useRef<Set<string>>(new Set())
  const platformLifecycleRun = useRef(0)
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0)
  const nativePreviewSurfaceEnabled = Boolean(runtimeInfo?.nativePreviewSurfaceProofEnabled)

  // Surface a per-target stream drop from any tab (the Streaming tab has the full
  // banner + badges). Each failed destination toasts once per session; the set is
  // cleared whenever streaming returns to an empty snapshot (session start/idle).
  useEffect(() => {
    if (streamTargets.length === 0) {
      toastedFailedTargets.current = new Set()
      return
    }
    for (const target of streamTargets) {
      if (target.state === 'failed' && !toastedFailedTargets.current.has(target.targetId)) {
        toastedFailedTargets.current.add(target.targetId)
        toast.error(`Streaming to ${target.label} stopped`, {
          description: target.message ?? 'The other destinations keep streaming.'
        })
      }
    }
  }, [streamTargets])

  const { registry: backgroundRegistry } = useBackgroundAssets()
  // Overlay the active background from the shared registry onto the scene so both
  // the session and the native preview carry it; the registry is the source of
  // truth (A5). Resolves to no background when nothing usable is selected.
  const sceneWithBackground = useMemo<Scene | null>(
    () =>
      scene
        ? { ...scene, background: effectiveSceneBackground(backgroundRegistry) ?? undefined }
        : null,
    [scene, backgroundRegistry]
  )

  const sessionParams = useMemo<StartSessionParams>(
    () =>
      buildStartSessionParams({
        captureConfig,
        scene: sceneWithBackground,
        sceneEditMode,
        settings
      }),
    [captureConfig, sceneWithBackground, sceneEditMode, settings]
  )

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setLastError(message)
    toast.error(message)
  }, [])

  const appendLog = useCallback((log: BackendLogEvent) => {
    setLogs((current) => [...current.slice(-79), log])
  }, [])

  const applyPreviewLiveStatus = useCallback(
    (status: PreviewLiveStatus) => {
      if (nativePreviewSurfaceEnabled && !isPreviewSurfaceTransport(status.transport)) {
        setPreviewLoading(false)
        setPreviewUrl(null)
        return
      }
      setPreviewLiveStatus(status)
      setPreviewLoading(status.state === 'connecting' || status.state === 'reconnecting')
      setPreviewUrl(
        status.url
          ? `${status.url}${status.url.includes('?') ? '&' : '?'}cache=${Date.now()}`
          : null
      )
    },
    [nativePreviewSurfaceEnabled]
  )

  const applyPreviewSurfaceStatus = useCallback((status: PreviewSurfaceStatus) => {
    previewSurfaceStatusRef.current = status
    setPreviewSurfaceStatus(status)
  }, [])

  // Present results arrive per frame (~60/s); committing each one to React
  // state re-rendered every StudioContext consumer per frame and dominated the
  // renderer's CPU profile. The ref stays per-frame fresh for logic, the state
  // commit happens at telemetry cadence, and a flip of any field that drives
  // UI state machines (transport badges, suppression) commits immediately.
  const applyPreviewSurfaceStatusThrottled = useCallback(
    (status: PreviewSurfaceStatus) => {
      const previous = previewSurfaceStatusRef.current
      previewSurfaceStatusRef.current = status
      const significantChange =
        previous.state !== status.state ||
        previous.transport !== status.transport ||
        previous.backing !== status.backing ||
        previous.source !== status.source ||
        previous.framePollingSuppressed !== status.framePollingSuppressed ||
        previous.sourcePixelsPresent !== status.sourcePixelsPresent
      if (significantChange) {
        if (previewSurfaceStatusCommitTimerRef.current) {
          clearTimeout(previewSurfaceStatusCommitTimerRef.current)
          previewSurfaceStatusCommitTimerRef.current = null
        }
        previewSurfaceStatusLastCommitAtRef.current = Date.now()
        setPreviewSurfaceStatus(status)
        return
      }
      if (previewSurfaceStatusCommitTimerRef.current) {
        return
      }
      const elapsedMs = Date.now() - previewSurfaceStatusLastCommitAtRef.current
      const delayMs = Math.max(0, TELEMETRY_UI_COMMIT_INTERVAL_MS - elapsedMs)
      previewSurfaceStatusCommitTimerRef.current = setTimeout(() => {
        previewSurfaceStatusCommitTimerRef.current = null
        previewSurfaceStatusLastCommitAtRef.current = Date.now()
        setPreviewSurfaceStatus(previewSurfaceStatusRef.current)
      }, delayMs)
    },
    [setPreviewSurfaceStatus]
  )

  useEffect(
    () => () => {
      if (previewSurfaceStatusCommitTimerRef.current) {
        clearTimeout(previewSurfaceStatusCommitTimerRef.current)
        previewSurfaceStatusCommitTimerRef.current = null
      }
    },
    []
  )

  // diagnostics.stats streams at the backend's 4Hz cadence; the UI only needs
  // the latest snapshot once a second (latest wins, trailing commit).
  const commitDiagnosticStatsThrottled = useCallback((stats: DiagnosticStats) => {
    diagnosticStatsPendingRef.current = stats
    if (diagnosticStatsCommitTimerRef.current) {
      return
    }
    const elapsedMs = Date.now() - diagnosticStatsLastCommitAtRef.current
    const delayMs = Math.max(0, TELEMETRY_UI_COMMIT_INTERVAL_MS - elapsedMs)
    diagnosticStatsCommitTimerRef.current = setTimeout(() => {
      diagnosticStatsCommitTimerRef.current = null
      diagnosticStatsLastCommitAtRef.current = Date.now()
      if (diagnosticStatsPendingRef.current) {
        setDiagnosticStats(diagnosticStatsPendingRef.current)
      }
    }, delayMs)
  }, [])

  useEffect(
    () => () => {
      if (diagnosticStatsCommitTimerRef.current) {
        clearTimeout(diagnosticStatsCommitTimerRef.current)
        diagnosticStatsCommitTimerRef.current = null
      }
    },
    []
  )

  const applyRecordingStatus = useCallback((status: RecordingStatus) => {
    recordingRef.current = status
    setRecording(status)
    syncFramePollingSuppressionRef.current?.()
  }, [])

  const queueNativePreviewSurfacePresentReport = useCallback(
    (activeClient: BackendClient, params: PreviewSurfacePresentParams) => {
      nativePreviewSurfacePresentReportPendingRef.current = params

      const flushReport = () => {
        if (
          nativePreviewSurfacePresentReportInFlightRef.current ||
          !nativePreviewSurfacePresentReportPendingRef.current
        ) {
          return
        }

        const elapsedSinceLastSendMs =
          Date.now() - nativePreviewSurfacePresentReportLastSentAtRef.current
        const delayMs = NATIVE_PREVIEW_SURFACE_PRESENT_REPORT_INTERVAL_MS - elapsedSinceLastSendMs
        if (delayMs > 0) {
          if (!nativePreviewSurfacePresentReportTimerRef.current) {
            nativePreviewSurfacePresentReportTimerRef.current = setTimeout(() => {
              nativePreviewSurfacePresentReportTimerRef.current = null
              flushReport()
            }, delayMs)
          }
          return
        }

        const nextParams = nativePreviewSurfacePresentReportPendingRef.current
        nativePreviewSurfacePresentReportPendingRef.current = null
        nativePreviewSurfacePresentReportInFlightRef.current = true
        nativePreviewSurfacePresentReportLastSentAtRef.current = Date.now()
        void activeClient
          .request<PreviewSurfaceStatus>('preview.surface.present', nextParams)
          .catch((error: unknown) => {
            console.error('Native preview surface present report failed:', error)
          })
          .finally(() => {
            nativePreviewSurfacePresentReportInFlightRef.current = false
            flushReport()
          })
      }

      flushReport()
    },
    []
  )

  const resetNativePreviewCompositorTiming = useCallback(() => {
    nativePreviewCompositorPollIntervalSamplesRef.current = []
    nativePreviewCompositorPollRoundTripSamplesRef.current = []
    nativePreviewCompositorPresentRoundTripSamplesRef.current = []
    nativePreviewCompositorLastPollStartedAtRef.current = 0
    nativePreviewCompositorPollInFlightSkipsRef.current = 0
    nativePreviewRendererTimingFieldsCacheRef.current = null
  }, [])

  // These p95s feed the 250ms present reports; recomputing them (three array
  // sorts) for every 60Hz present burned measurable CPU for no extra signal.
  const nativePreviewRendererTimingStatusFields =
    useCallback((): NativePreviewRendererTimingFields => {
      const cached = nativePreviewRendererTimingFieldsCacheRef.current
      const nowMs = Date.now()
      if (
        cached &&
        nowMs - cached.computedAtMs < NATIVE_PREVIEW_SURFACE_PRESENT_REPORT_INTERVAL_MS
      ) {
        return cached.fields
      }
      const fields: NativePreviewRendererTimingFields = {
        nativePreviewRendererPollIntervalP95Ms: nativePreviewTimingPercentile(
          nativePreviewCompositorPollIntervalSamplesRef.current,
          0.95
        ),
        nativePreviewRendererPollRoundTripP95Ms: nativePreviewTimingPercentile(
          nativePreviewCompositorPollRoundTripSamplesRef.current,
          0.95
        ),
        nativePreviewRendererPresentRoundTripP95Ms: nativePreviewTimingPercentile(
          nativePreviewCompositorPresentRoundTripSamplesRef.current,
          0.95
        ),
        nativePreviewRendererPollInFlightSkips: nativePreviewCompositorPollInFlightSkipsRef.current
      }
      nativePreviewRendererTimingFieldsCacheRef.current = { fields, computedAtMs: nowMs }
      return fields
    }, [])

  const queueNativePreviewCompositorPresent = useCallback(
    (activeClient: BackendClient, status: CompositorStatus) => {
      const updateCompositor =
        typeof window === 'undefined'
          ? undefined
          : window.videorc?.updateNativePreviewSurfaceCompositor
      const presentDecision = decideNativePreviewCompositorPresent({
        nativePreviewSurfaceEnabled,
        updateCompositorAvailable: Boolean(updateCompositor),
        recordingState: recordingRef.current.state
      })
      if (presentDecision.kind === 'disabled' || !updateCompositor) {
        nativePreviewCompositorPendingRef.current = null
        return
      }
      if (presentDecision.kind === 'suppress-starting') {
        nativePreviewCompositorPendingRef.current = null
        nativePreviewCompositorSuppressedPresentsRef.current += 1
        return
      }

      nativePreviewCompositorPendingRef.current = status
      if (nativePreviewCompositorPresentingRef.current) {
        return
      }

      nativePreviewCompositorPresentingRef.current = true
      void (async () => {
        try {
          while (nativePreviewCompositorPendingRef.current) {
            const nextStatus = nativePreviewCompositorPendingRef.current
            nativePreviewCompositorPendingRef.current = null
            const updateParams = buildNativePreviewCompositorUpdateParams(
              nextStatus,
              recordingRef.current.state,
              nativePreviewRendererTimingStatusFields()
            )
            const presentStartedAt = performance.now()
            const surfaceStatus = await updateCompositor(updateParams)
            recordNativePreviewTimingSample(
              nativePreviewCompositorPresentRoundTripSamplesRef.current,
              performance.now() - presentStartedAt
            )
            const rendererTimingFields = nativePreviewRendererTimingStatusFields()
            const pendingStatus =
              nativePreviewCompositorPendingRef.current as CompositorStatus | null
            if (
              pendingCompositorStatusSupersedes(pendingStatus, nextStatus, {
                includeSameRunFrameAdvance: false
              })
            ) {
              nativePreviewCompositorSuppressedPresentsRef.current += 1
              continue
            }
            const droppedFrames = nativePreviewDroppedFramesWithSuppressed(
              surfaceStatus,
              nativePreviewCompositorSuppressedPresentsRef.current
            )
            const nextSurfaceStatus: PreviewSurfaceStatus = {
              ...surfaceStatus,
              ...rendererTimingFields,
              framesRendered: Math.max(surfaceStatus.framesRendered, nextStatus.framesRendered),
              droppedFrames
            }
            applyPreviewSurfaceStatusThrottled(nextSurfaceStatus)
            const presentParams: PreviewSurfacePresentParams = {
              transport: surfaceStatus.transport,
              backing: surfaceStatus.backing,
              presentedFrameId: surfaceStatus.presentedFrameId,
              compositorFrameLag: surfaceStatus.compositorFrameLag,
              droppedFrames,
              inputToPresentLatencyMs: surfaceStatus.inputToPresentLatencyMs,
              inputToPresentLatencyP50Ms: surfaceStatus.inputToPresentLatencyP50Ms,
              inputToPresentLatencyP95Ms: surfaceStatus.inputToPresentLatencyP95Ms,
              inputToPresentLatencyP99Ms: surfaceStatus.inputToPresentLatencyP99Ms,
              presentFps: surfaceStatus.presentFps,
              intervalP95Ms: surfaceStatus.intervalP95Ms,
              intervalP99Ms: surfaceStatus.intervalP99Ms,
              ...rendererTimingFields,
              nativePreviewMainQueueWaitP95Ms: surfaceStatus.nativePreviewMainQueueWaitP95Ms,
              nativePreviewMainPresentP95Ms: surfaceStatus.nativePreviewMainPresentP95Ms,
              nativePreviewMainQueuedBehindCount: surfaceStatus.nativePreviewMainQueuedBehindCount,
              nativePreviewHelperRoundTripP95Ms: surfaceStatus.nativePreviewHelperRoundTripP95Ms,
              nativePreviewMainStatusFetchP95Ms: surfaceStatus.nativePreviewMainStatusFetchP95Ms,
              nativePreviewMainStatusFetchFailures:
                surfaceStatus.nativePreviewMainStatusFetchFailures,
              nativePreviewMainStatusFetchSuccesses:
                surfaceStatus.nativePreviewMainStatusFetchSuccesses,
              nativePreviewMainPresentedStatusAgeMs:
                surfaceStatus.nativePreviewMainPresentedStatusAgeMs,
              nativePreviewMainPresentedStatusAgeP95Ms:
                surfaceStatus.nativePreviewMainPresentedStatusAgeP95Ms,
              nativePreviewMainPresentedFrameAgeP95Ms:
                surfaceStatus.nativePreviewMainPresentedFrameAgeP95Ms,
              framePollingSuppressed: surfaceStatus.framePollingSuppressed,
              sourcePixelsPresent: surfaceStatus.sourcePixelsPresent
            }
            queueNativePreviewSurfacePresentReport(activeClient, presentParams)
            if (
              pendingCompositorStatusSupersedes(pendingStatus, nextStatus, {
                includeSameRunFrameAdvance: true
              })
            ) {
              nativePreviewCompositorSuppressedPresentsRef.current += 1
              continue
            }
          }
        } catch (error: unknown) {
          console.error('Native preview compositor present failed:', error)
        } finally {
          nativePreviewCompositorPresentingRef.current = false
          if (nativePreviewCompositorPendingRef.current) {
            queueNativePreviewCompositorPresent(
              activeClient,
              nativePreviewCompositorPendingRef.current
            )
          }
        }
      })()
    },
    [
      applyPreviewSurfaceStatusThrottled,
      nativePreviewRendererTimingStatusFields,
      nativePreviewSurfaceEnabled,
      queueNativePreviewSurfacePresentReport
    ]
  )

  useEffect(() => {
    if (!window.videorc?.getNativePreviewMainPumpActive) {
      return
    }
    let cancelled = false
    void window.videorc.getNativePreviewMainPumpActive().then((active) => {
      if (!cancelled) {
        mainPumpActiveRef.current = active === true
        setMainPumpActive(active === true)
      }
    })
    const unsubscribe = window.videorc.onNativePreviewMainPumpActive?.((active) => {
      mainPumpActiveRef.current = active === true
      setMainPumpActive(active === true)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  // While main pumps presents, the renderer has no use for the per-frame
  // compositor.status firehose — receiving and decoding it leaked Blink
  // buffers at ~1.5MB/s. Mute it per connection; unmute the moment this
  // renderer has to take over as the fallback pump.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    void client
      .request('events.setExcluded', {
        events: mainPumpActive ? ['compositor.status'] : []
      })
      .catch(() => {
        // Older backends without connection controls keep the full stream.
      })
  }, [client, wsStatus, mainPumpActive])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled || !client || wsStatus !== 'connected') {
      return
    }
    // No timer at all while the main process pumps presents: even a dormant
    // 60Hz setTimeout chain churns measurable renderer memory, and the effect
    // re-runs to start the fallback pump the moment main's socket drops.
    if (mainPumpActive) {
      return
    }

    let cancelled = false
    const tick = () => {
      if (cancelled) {
        return
      }
      // Dormant while the main process pumps presents from its own backend
      // socket; this 60Hz relay only resumes as the fallback if that drops.
      const surfaceLive =
        !mainPumpActiveRef.current && previewSurfaceStatusRef.current.state === 'live'
      if (surfaceLive) {
        const latestStatus = nativePreviewCompositorLatestStatusRef.current
        const pollStartedAt = performance.now()
        const previousPollStartedAt = nativePreviewCompositorLastPollStartedAtRef.current
        if (previousPollStartedAt > 0) {
          recordNativePreviewTimingSample(
            nativePreviewCompositorPollIntervalSamplesRef.current,
            pollStartedAt - previousPollStartedAt
          )
        }
        nativePreviewCompositorLastPollStartedAtRef.current = pollStartedAt
        if (latestStatus) {
          queueNativePreviewCompositorPresent(client, latestStatus)
        }
      }
      nativePreviewCompositorPumpTimerRef.current = setTimeout(
        tick,
        NATIVE_PREVIEW_COMPOSITOR_POLL_INTERVAL_MS
      )
    }

    nativePreviewCompositorPumpTimerRef.current = setTimeout(
      tick,
      NATIVE_PREVIEW_COMPOSITOR_POLL_INTERVAL_MS
    )
    return () => {
      cancelled = true
      nativePreviewCompositorPollInFlightRef.current = false
      if (nativePreviewCompositorPumpTimerRef.current) {
        clearTimeout(nativePreviewCompositorPumpTimerRef.current)
        nativePreviewCompositorPumpTimerRef.current = null
      }
    }
  }, [
    client,
    mainPumpActive,
    nativePreviewSurfaceEnabled,
    queueNativePreviewCompositorPresent,
    wsStatus
  ])

  const applyPreviewCameraStatus = useCallback((status: PreviewCameraStatus) => {
    previewCameraStatusRef.current = status
    setPreviewCameraStatus(status)
  }, [])

  const applyPreviewScreenStatus = useCallback((status: PreviewScreenStatus) => {
    previewScreenStatusRef.current = status
    setPreviewScreenStatus(status)
  }, [])

  const applyScene = useCallback((nextScene: Scene) => {
    setScene(nextScene)
    setSelectedSceneSourceId((current) =>
      current && nextScene.sources.some((source) => source.id === current)
        ? current
        : (nextScene.sources.at(-1)?.id ?? null)
    )
  }, [])

  const refreshSessions = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const nextSessions = await activeClient.request<SessionSummary[]>('sessions.list')
    setSessions(nextSessions)
  }, [])

  const refreshScreensForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const [nextScreens, nextActiveScreen] = await Promise.all([
      activeClient.request<StreamScreen[]>('screens.list'),
      activeClient.request<StreamScreen | null>('screens.active')
    ])
    setScreens(nextScreens)
    setActiveScreen(nextActiveScreen)
  }, [])

  const refreshScreens = useCallback(async () => {
    try {
      await refreshScreensForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshScreensForClient, reportError])

  const refreshPlatformAccountsForClient = useCallback(
    async (activeClient: BackendClient | null) => {
      if (!activeClient) {
        setPlatformAccounts([])
        setOauthProviderCredentials([])
        return
      }

      const [accounts, credentials] = await Promise.all([
        activeClient.request<PlatformAccount[]>('platformAccounts.list'),
        activeClient.request<OAuthProviderCredentialStatus[]>(
          'platformAccounts.oauth.providerCredentials'
        )
      ])
      setPlatformAccounts(accounts)
      setOauthProviderCredentials(credentials)
    },
    []
  )

  const refreshPlatformAccounts = useCallback(async () => {
    try {
      await refreshPlatformAccountsForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshPlatformAccountsForClient, reportError])

  const validatePlatformAccountsForClient = useCallback(
    async (activeClient: BackendClient | null) => {
      if (!activeClient) {
        setPlatformAccountValidations([])
        return []
      }

      const validations = await activeClient.request<PlatformAccountValidation[]>(
        'platformAccounts.validate'
      )
      setPlatformAccountValidations(validations)
      return validations
    },
    []
  )

  const validatePlatformAccounts = useCallback(async () => {
    try {
      return await validatePlatformAccountsForClient(client)
    } catch (error) {
      reportError(error)
      return []
    }
  }, [client, reportError, validatePlatformAccountsForClient])

  const refreshYouTubeChannels = useCallback(
    async (accountId?: string) => {
      if (!client) {
        setYoutubeChannels([])
        return
      }

      try {
        setLastError(null)
        setYoutubeChannelsLoading(true)
        const result = await client.request<{ channels: YouTubeChannel[] }>(
          'platformAccounts.youtube.channels',
          {
            accountId
          }
        )
        setYoutubeChannels(result.channels)
      } catch (error) {
        setYoutubeChannels([])
        reportError(error)
      } finally {
        setYoutubeChannelsLoading(false)
      }
    },
    [client, reportError]
  )

  const selectYouTubeChannel = useCallback(
    async (channelId: string, accountId?: string) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const selected = await client.request<PlatformAccount>(
          'platformAccounts.youtube.selectChannel',
          {
            accountId,
            channelId
          }
        )
        await Promise.all([
          refreshPlatformAccountsForClient(client),
          validatePlatformAccountsForClient(client)
        ])
        setCaptureConfig((current) => {
          const targets = current.streaming.targets.map((target) => {
            if (target.platform !== 'youtube') {
              return target
            }
            const sameAccount = target.accountId === selected.accountId
            return {
              ...target,
              accountId: selected.accountId,
              accountLabel: selected.accountLabel,
              streamKeySecretRef: sameAccount ? target.streamKeySecretRef : undefined,
              streamKeyPresent: sameAccount ? target.streamKeyPresent : false,
              platformBroadcastId: sameAccount ? target.platformBroadcastId : undefined,
              platformStreamId: sameAccount ? target.platformStreamId : undefined,
              status: sameAccount ? target.status : undefined
            }
          })
          return bridgeStreamingToLegacy({
            ...current,
            streaming: { ...current.streaming, targets }
          })
        })
        await refreshYouTubeChannels(selected.accountId)
        toast.success(`YouTube channel set to ${selected.accountLabel}.`)
      } catch (error) {
        reportError(error)
      }
    },
    [
      client,
      refreshPlatformAccountsForClient,
      refreshYouTubeChannels,
      reportError,
      validatePlatformAccountsForClient,
      wsStatus
    ]
  )

  useEffect(() => {
    const account = platformAccounts.find((item) => item.platform === 'youtube')
    if (!account) {
      setYoutubeChannels([])
      return
    }
    void refreshYouTubeChannels(account.accountId)
  }, [platformAccounts, refreshYouTubeChannels])

  const searchTwitchCategories = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!client || trimmed.length < 2) {
        setTwitchCategories([])
        return
      }

      try {
        setLastError(null)
        setTwitchCategorySearchPending(true)
        const account = platformAccounts.find((item) => item.platform === 'twitch')
        const result = await client.request<{ categories: TwitchCategory[] }>(
          'streamTargets.twitch.searchCategories',
          {
            accountId: account?.accountId,
            query: trimmed,
            first: 10
          }
        )
        setTwitchCategories(result.categories)
      } catch (error) {
        setTwitchCategories([])
        reportError(error)
      } finally {
        setTwitchCategorySearchPending(false)
      }
    },
    [client, platformAccounts, reportError]
  )

  useEffect(() => {
    if (!platformAccounts.some((item) => item.platform === 'twitch')) {
      setTwitchCategories([])
    }
  }, [platformAccounts])

  const refreshXNativeCapability = useCallback(
    async (accountId?: string) => {
      if (!client) {
        setXNativeCapability(null)
        return
      }

      try {
        setLastError(null)
        setXNativeCapabilityLoading(true)
        const capability = await client.request<XNativeLiveCapability>(
          'streamTargets.x.capability',
          { accountId }
        )
        setXNativeCapability(capability)
      } catch (error) {
        setXNativeCapability(null)
        reportError(error)
      } finally {
        setXNativeCapabilityLoading(false)
      }
    },
    [client, reportError]
  )

  useEffect(() => {
    const account = platformAccounts.find((item) => item.platform === 'x')
    if (!account) {
      setXNativeCapability(null)
      return
    }
    void refreshXNativeCapability(account.accountId)
  }, [platformAccounts, refreshXNativeCapability])

  const refreshStreamMetadataForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      setStreamMetadataDraft(null)
      setStreamMetadataValidation(null)
      return
    }

    const draft = await activeClient.request<StreamMetadataDraft>('streamTargets.metadata.get')
    const validation = await activeClient.request<StreamMetadataValidation>(
      'streamTargets.metadata.validate',
      draft
    )
    setStreamMetadataDraft(draft)
    setStreamMetadataValidation(validation)
  }, [])

  const refreshStreamMetadata = useCallback(async () => {
    try {
      await refreshStreamMetadataForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshStreamMetadataForClient, reportError])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify(persistableCaptureConfig(captureConfig))
    )
  }, [captureConfig])

  useEffect(() => {
    if (!['recording', 'streaming', 'starting', 'stopping'].includes(recording.state)) {
      return
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recording.state])

  // X is the one destination where a connected RTMP feed is NOT live yet: the
  // user must start a Broadcast in Media Studio Producer attached to their
  // source. Remind them the moment the stream goes up, once per session.
  const xProducerReminderShownRef = useRef(false)
  useEffect(() => {
    if (recording.state !== 'streaming') {
      if (recording.state === 'idle' || recording.state === 'failed') {
        xProducerReminderShownRef.current = false
      }
      return
    }
    if (xProducerReminderShownRef.current) {
      return
    }
    const xManualTarget = captureConfigRef.current.streaming.targets.find(
      (target) => target.platform === 'x' && target.enabled && target.authMode === 'manual-rtmp'
    )
    if (!xManualTarget) {
      return
    }
    xProducerReminderShownRef.current = true
    toast.info('X feed is connected — now start the Broadcast on X.', {
      description:
        'X does not go live from the RTMP feed alone: open Media Studio → Producer → Broadcasts, ' +
        'create a broadcast from your source, and press Broadcast.',
      duration: 20000,
      action: {
        label: 'Open Media Studio',
        onClick: () => void window.videorc?.openOAuthUrl?.('https://studio.x.com')
      }
    })
  }, [recording.state])

  useEffect(() => {
    setAudioMeter(null)
  }, [captureConfig.sources.microphoneId])

  useEffect(() => {
    let disposed = false

    if (typeof window === 'undefined' || !window.videorc) {
      // The preload bridge is unavailable (e.g. rendered outside Electron).
      return
    }

    window.videorc.getBackendLogs().then((backendLogs) => {
      if (!disposed) {
        setLogs(backendLogs.slice(-80))
      }
    })
    window.videorc.getRuntimeInfo?.().then((nextRuntimeInfo) => {
      if (!disposed) {
        setRuntimeInfo(nextRuntimeInfo)
      }
    })
    window.videorc.getBackendConnection().then((nextConnection) => {
      if (!disposed && nextConnection) {
        setConnection(nextConnection)
      }
    })

    const offConnection = window.videorc.onBackendConnection(setConnection)
    const offLog = window.videorc.onBackendLog(appendLog)

    return () => {
      disposed = true
      offConnection()
      offLog()
    }
  }, [appendLog])

  useEffect(() => {
    setCaptureConfig((current) => {
      const nextSources = reconcileSourceSelection(current.sources, deviceList.devices)

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      sourceReconciliationMessages.current.push(
        ...sourceSelectionChangeMessages(current.sources, nextSources)
      )
      return { ...current, sources: nextSources }
    })
  }, [deviceList])

  useEffect(() => {
    const messages = sourceReconciliationMessages.current.splice(0)
    for (const message of new Set(messages)) {
      toast.warning(message)
    }
  }, [captureConfig.sources])

  useEffect(() => {
    if (!connection) {
      return
    }

    const nextClient = new BackendClient(connection)
    setClient(nextClient)
    setWsStatus('connecting')
    setLastError(null)

    const unsubscribers = [
      nextClient.on('backend.ready', () => setWsStatus('connected')),
      nextClient.on('devices.changed', (payload) => setDeviceList(payload as DeviceList)),
      nextClient.on('recording.status', (payload) => {
        const status = payload as RecordingStatus
        applyRecordingStatus(status)
        if (['idle', 'failed'].includes(status.state)) {
          setStreamTargets([])
          void refreshSessions(nextClient)
        }
      }),
      nextClient.on('health.event', (payload) => {
        const event = payload as HealthEvent
        setHealthEvents((current) => [event, ...current].slice(0, 40))
        setSessions((current) =>
          current.map((session) =>
            session.id === event.sessionId
              ? { ...session, healthEvents: [...session.healthEvents, event] }
              : session
          )
        )
      }),
      nextClient.on('session.log', (payload) => {
        const entry = payload as SessionLogEntry
        setSessions((current) =>
          current.map((session) =>
            session.id === entry.sessionId
              ? { ...session, sessionLogs: [...session.sessionLogs, entry] }
              : session
          )
        )
      }),
      nextClient.on('stream.health', (payload) => {
        setStreamHealth((current) => mergeStreamHealth(current, payload as StreamHealth))
      }),
      nextClient.on('stream.targets', (payload) => {
        setStreamTargets((payload as StreamTargetsSnapshot).targets)
      }),
      nextClient.on('diagnostics.stats', (payload) => {
        commitDiagnosticStatsThrottled(payload as DiagnosticStats)
      }),
      nextClient.on('preview.live.status', (payload) => {
        applyPreviewLiveStatus(payload as PreviewLiveStatus)
      }),
      nextClient.on('preview.surface.status', (payload) => {
        applyPreviewSurfaceStatusThrottled(payload as PreviewSurfaceStatus)
      }),
      nextClient.on('compositor.status', (payload) => {
        const status = payload as CompositorStatus
        nativePreviewCompositorLastEventAtRef.current = Date.now()
        nativePreviewCompositorLatestStatusRef.current = status
        if (mainPumpActiveRef.current || isActiveRecordingState(recordingRef.current.state)) {
          return
        }
        queueNativePreviewCompositorPresent(nextClient, status)
      }),
      nextClient.on('preview.camera.status', (payload) => {
        applyPreviewCameraStatus(payload as PreviewCameraStatus)
      }),
      nextClient.on('preview.screen.status', (payload) => {
        applyPreviewScreenStatus(payload as PreviewScreenStatus)
      }),
      nextClient.on('scene.changed', (payload) => {
        applyScene(payload as Scene)
      }),
      nextClient.on('screens.changed', (payload) => {
        setScreens(payload as StreamScreen[])
      }),
      nextClient.on('screens.active.changed', (payload) => {
        setActiveScreen(payload as StreamScreen | null)
      }),
      nextClient.on('platformAccounts.changed', (payload) => {
        setPlatformAccounts(payload as PlatformAccount[])
      }),
      nextClient.on('liveChat.snapshot', (payload) =>
        setLiveChatSnapshot(applyLiveChatSnapshot(payload as LiveChatSnapshot))
      ),
      nextClient.on('liveChat.message', (payload) =>
        setLiveChatSnapshot((current) => applyLiveChatMessage(current, payload as LiveChatMessage))
      ),
      nextClient.on('liveChat.providerStatus', (payload) =>
        setLiveChatSnapshot((current) =>
          applyLiveChatProviderStatus(current, payload as LiveChatProviderState)
        )
      ),
      nextClient.on('liveChat.cleared', (payload) =>
        setLiveChatSnapshot(applyLiveChatSnapshot(payload as LiveChatSnapshot))
      ),
      nextClient.on('streamTargets.metadata.changed', (payload) => {
        const draft = payload as StreamMetadataDraft
        setStreamMetadataDraft(draft)
        void nextClient
          .request<StreamMetadataValidation>('streamTargets.metadata.validate', draft)
          .then(setStreamMetadataValidation)
      }),
      nextClient.on('platformAccounts.oauth.callback', (payload) => {
        const result = payload as {
          status?: string
          message?: string
          accountConnected?: boolean
        }
        if (result.status === 'success' && result.accountConnected) {
          void refreshPlatformAccountsForClient(nextClient)
          void validatePlatformAccountsForClient(nextClient)
          toast.success('Account connected.')
        } else if (result.status === 'success') {
          toast.success('OAuth callback received.')
        } else {
          toast.error('OAuth callback failed.', {
            description: result.message ?? result.status ?? 'Connection could not be completed.'
          })
        }
      }),
      nextClient.on('ai.artifacts.changed', () => {
        void refreshSessions(nextClient)
      }),
      nextClient.on('log', (payload) => appendLog(payload as BackendLogEvent)),
      nextClient.on('error', (payload) => {
        const error = payload as { message?: string }
        const message = error.message ?? 'Backend error.'
        setLastError(message)
        toast.error(message)
      }),
      nextClient.on('connection.closed', () => setWsStatus('closed'))
    ]

    nextClient
      .connect()
      .then(async () => {
        setWsStatus('connected')
        const nextHealth = await nextClient.request<BackendHealth>('health.ping', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        setHealth(nextHealth)
        const nextEntitlements = await nextClient.request<EntitlementsSnapshot>('entitlements.get')
        setEntitlements(nextEntitlements)
        const nextDevices = await nextClient.request<DeviceList>('devices.list', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        setDeviceList(nextDevices)
        const nextRecording = await nextClient.request<RecordingStatus>('recording.status')
        applyRecordingStatus(nextRecording)
        const nextDiagnostics = await nextClient.request<DiagnosticStats>('diagnostics.stats')
        setDiagnosticStats(nextDiagnostics)
        const nextLiveChat = await nextClient.request<LiveChatSnapshot>('liveChat.status')
        setLiveChatSnapshot(applyLiveChatSnapshot(nextLiveChat))
        const nextPreview = await nextClient.request<PreviewLiveStatus>('preview.live.status')
        applyPreviewLiveStatus(nextPreview)
        const nextPreviewSurface =
          await nextClient.request<PreviewSurfaceStatus>('preview.surface.status')
        applyPreviewSurfaceStatus(nextPreviewSurface)
        const nextPreviewCamera =
          await nextClient.request<PreviewCameraStatus>('preview.camera.status')
        applyPreviewCameraStatus(nextPreviewCamera)
        const nextPreviewScreen =
          await nextClient.request<PreviewScreenStatus>('preview.screen.status')
        applyPreviewScreenStatus(nextPreviewScreen)
        const nextScene = await nextClient.request<Scene>('scene.get')
        if (nextScene.sources.length) {
          applyScene(nextScene)
        }
        await refreshScreensForClient(nextClient)
        await refreshPlatformAccountsForClient(nextClient)
        await validatePlatformAccountsForClient(nextClient)
        await refreshStreamMetadataForClient(nextClient)
        await refreshSessions(nextClient)
      })
      .catch((error: unknown) => {
        setWsStatus('failed')
        reportError(error)
      })

    return () => {
      nativePreviewCompositorPendingRef.current = null
      nativePreviewCompositorLatestStatusRef.current = null
      nativePreviewCompositorPresentingRef.current = false
      nativePreviewCompositorSuppressedPresentsRef.current = 0
      nativePreviewCompositorLastEventAtRef.current = 0
      nativePreviewCompositorPollInFlightRef.current = false
      resetNativePreviewCompositorTiming()
      if (nativePreviewCompositorPumpTimerRef.current) {
        clearTimeout(nativePreviewCompositorPumpTimerRef.current)
        nativePreviewCompositorPumpTimerRef.current = null
      }
      nativePreviewSurfaceCreatedRef.current = false
      nativePreviewSurfaceLastSyncedBoundsRef.current = null
      nativePreviewSurfacePresentReportPendingRef.current = null
      nativePreviewSurfacePresentReportInFlightRef.current = false
      nativePreviewSurfacePresentReportLastSentAtRef.current = 0
      if (nativePreviewSurfacePresentReportTimerRef.current) {
        clearTimeout(nativePreviewSurfacePresentReportTimerRef.current)
        nativePreviewSurfacePresentReportTimerRef.current = null
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
      nextClient.close()
      setClient(null)
      setEntitlements(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appendLog,
    applyPreviewLiveStatus,
    applyPreviewCameraStatus,
    applyPreviewScreenStatus,
    applyPreviewSurfaceStatus,
    applyPreviewSurfaceStatusThrottled,
    applyRecordingStatus,
    commitDiagnosticStatsThrottled,
    connection,
    nativePreviewSurfaceEnabled,
    queueNativePreviewCompositorPresent,
    resetNativePreviewCompositorTiming,
    refreshPlatformAccountsForClient,
    refreshScreensForClient,
    refreshStreamMetadataForClient,
    validatePlatformAccountsForClient,
    refreshSessions,
    reportError,
    settings.ffmpegPath
  ])

  const loadScene = useCallback(
    async (config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'>) => {
      if (!client || wsStatus !== 'connected') {
        return
      }

      const nextScene = await client.request<Scene>('scene.load_from_capture_config', config)
      applyScene(nextScene)
    },
    [applyScene, client, wsStatus]
  )

  const reloadSceneFromCaptureConfig = useCallback(async () => {
    const config = {
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      video: captureConfig.video
    }
    await loadScene(
      runtimeInfo?.previewSmokeMode ? smokePreviewCompositorCaptureConfig(config) : config
    )
  }, [
    captureConfig.layout,
    captureConfig.sources,
    captureConfig.video,
    loadScene,
    runtimeInfo?.previewSmokeMode
  ])

  const patchLayout = useCallback((patch: Partial<LayoutSettings>) => {
    setCaptureConfig((current) => ({ ...current, layout: { ...current.layout, ...patch } }))
  }, [])

  const syncCameraTransformToLayout = useCallback(
    (nextScene: Scene) => {
      const camera = nextScene.sources.find((source) => source.kind === 'camera')
      if (!camera) {
        return
      }

      patchLayout({
        cameraTransformMode: 'custom',
        cameraTransform: {
          x: camera.transform.x,
          y: camera.transform.y,
          width: camera.transform.width,
          height: camera.transform.height
        }
      })
    },
    [patchLayout]
  )

  const refreshBackend = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      const [
        nextHealth,
        nextEntitlements,
        nextDevices,
        nextSessions,
        nextDiagnostics,
        nextScreens,
        nextActiveScreen,
        nextPlatformAccounts,
        nextOauthProviderCredentials,
        nextPlatformAccountValidations,
        nextStreamMetadataDraft
      ] = await Promise.all([
        client.request<BackendHealth>('health.ping', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        }),
        client.request<EntitlementsSnapshot>('entitlements.get'),
        client.request<DeviceList>('devices.list', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        }),
        client.request<SessionSummary[]>('sessions.list'),
        client.request<DiagnosticStats>('diagnostics.stats'),
        client.request<StreamScreen[]>('screens.list'),
        client.request<StreamScreen | null>('screens.active'),
        client.request<PlatformAccount[]>('platformAccounts.list'),
        client.request<OAuthProviderCredentialStatus[]>(
          'platformAccounts.oauth.providerCredentials'
        ),
        client.request<PlatformAccountValidation[]>('platformAccounts.validate'),
        client.request<StreamMetadataDraft>('streamTargets.metadata.get')
      ])
      const nextStreamMetadataValidation = await client.request<StreamMetadataValidation>(
        'streamTargets.metadata.validate',
        nextStreamMetadataDraft
      )
      setHealth(nextHealth)
      setEntitlements(nextEntitlements)
      setDeviceList(nextDevices)
      setSessions(nextSessions)
      setDiagnosticStats(nextDiagnostics)
      setScreens(nextScreens)
      setActiveScreen(nextActiveScreen)
      setPlatformAccounts(nextPlatformAccounts)
      setOauthProviderCredentials(nextOauthProviderCredentials)
      setPlatformAccountValidations(nextPlatformAccountValidations)
      setStreamMetadataDraft(nextStreamMetadataDraft)
      setStreamMetadataValidation(nextStreamMetadataValidation)
      if (!sceneEditMode) {
        await reloadSceneFromCaptureConfig()
      }
    } catch (error) {
      reportError(error)
    }
  }, [client, reloadSceneFromCaptureConfig, reportError, sceneEditMode, settings.ffmpegPath])

  useEffect(() => {
    if (!client || wsStatus !== 'connected' || sceneEditMode) {
      return
    }

    const timer = window.setTimeout(() => {
      void reloadSceneFromCaptureConfig().catch(reportError)
    }, 250)

    return () => window.clearTimeout(timer)
  }, [client, reloadSceneFromCaptureConfig, reportError, sceneEditMode, wsStatus])

  const resetSceneSource = useCallback(
    async (sourceId = selectedSceneSourceId ?? undefined) => {
      if (!client || !sourceId) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.transform.reset', { sourceId })
        applyScene(nextScene)
        if (nextScene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          patchLayout({ cameraTransformMode: 'preset', cameraTransform: null })
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, patchLayout, reportError, selectedSceneSourceId]
  )

  const nudgeSceneSource = useCallback(
    async (sourceId: string, directionX: number, directionY: number, large = false) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.nudge', {
          sourceId,
          directionX,
          directionY,
          large
        })
        applyScene(nextScene)
        if (nextScene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          syncCameraTransformToLayout(nextScene)
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, syncCameraTransformToLayout]
  )

  const setSceneSourceVisible = useCallback(
    async (sourceId: string, visible: boolean) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.visibility.update', {
          sourceId,
          visible
        })
        applyScene(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError]
  )

  const moveSceneSource = useCallback(
    async (sourceId: string, direction: -1 | 1) => {
      if (!client || !scene) {
        return
      }

      const currentIndex = scene.sources.findIndex((source) => source.id === sourceId)
      const nextIndex = currentIndex + direction
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= scene.sources.length) {
        return
      }

      const sourceIds = scene.sources.map((source) => source.id)
      const [moved] = sourceIds.splice(currentIndex, 1)
      if (!moved) {
        return
      }
      sourceIds.splice(nextIndex, 0, moved)

      try {
        const nextScene = await client.request<Scene>('scene.sources.reorder', { sourceIds })
        applyScene(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, scene]
  )

  const commitCameraTransform = useCallback(
    async (sourceId: string, x: number, y: number) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.transform.update', {
          sourceId,
          transform: { x, y }
        })
        applyScene(nextScene)
        syncCameraTransformToLayout(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, syncCameraTransformToLayout]
  )

  const [layoutSwitchPending, setLayoutSwitchPending] = useState<LayoutPreset | null>(null)
  const [sourceDeviceSwitchPending, setSourceDeviceSwitchPending] =
    useState<LiveSourceDeviceSwitchPending | null>(null)

  const applyCameraPreset = useCallback(
    (patch: Partial<LayoutSettings>) => {
      const layout: LayoutSettings = {
        ...captureConfig.layout,
        ...patch,
        cameraTransformMode: 'preset',
        cameraTransform: null
      }

      // Live switching (plan slice D2): during a session the backend owns the swap —
      // it starts missing sources and commits swap-on-ready. The local config only
      // updates on success so a failed switch honestly stays on the old layout.
      const isActive = isActiveRecordingState(recordingRef.current.state)
      if (isActive) {
        if (!client || wsStatus !== 'connected') {
          toast.error('Backend socket is not connected — layout unchanged.')
          return
        }
        if (layoutSwitchPending) {
          return
        }
        setLayoutSwitchPending(layout.layoutPreset)
        client
          .request<LiveLayoutApplyStatus>('scene.layout.apply_live', {
            sources: captureConfig.sources,
            layout,
            video: captureConfig.video
          })
          .then((status) => {
            applyScene(status.scene)
            setCaptureConfig((current) => ({
              ...current,
              layout: {
                ...current.layout,
                ...patch,
                cameraTransformMode: 'preset',
                cameraTransform: null
              }
            }))
            if (status.mode === 'warm' && status.message) {
              toast.success(status.message)
            }
          })
          .catch((error: unknown) => {
            // The previous layout is still live; surface the exact backend reason.
            reportError(error)
          })
          .finally(() => setLayoutSwitchPending(null))
        return
      }

      setCaptureConfig((current) => ({
        ...current,
        layout: {
          ...current.layout,
          ...patch,
          cameraTransformMode: 'preset',
          cameraTransform: null
        }
      }))
      void loadScene({
        sources: captureConfig.sources,
        layout,
        video: captureConfig.video
      }).catch(reportError)
    },
    [
      applyScene,
      captureConfig.layout,
      captureConfig.sources,
      captureConfig.video,
      client,
      layoutSwitchPending,
      loadScene,
      reportError,
      wsStatus
    ]
  )

  const switchSourceDeviceLive = useCallback(
    async (sourceKind: LiveSourceDeviceSwitchPending, sources: SourceSelection) => {
      const isActive = isActiveRecordingState(recordingRef.current.state)
      if (!isActive) {
        setCaptureConfig((current) => ({ ...current, sources }))
        if (sceneEditMode) {
          await loadScene({
            sources,
            layout: captureConfig.layout,
            video: captureConfig.video
          }).catch(reportError)
        }
        return
      }

      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected — source unchanged.')
        return
      }
      if (sourceDeviceSwitchPending) {
        return
      }

      setSourceDeviceSwitchPending(sourceKind)
      try {
        const status = await client.request<LiveLayoutApplyStatus>('scene.source.device.switch', {
          sources,
          layout: captureConfig.layout,
          video: captureConfig.video
        })
        applyScene(status.scene)
        setCaptureConfig((current) => ({ ...current, sources }))
        if (status.message) {
          toast.success(status.message)
        }
      } catch (error) {
        reportError(error)
      } finally {
        setSourceDeviceSwitchPending(null)
      }
    },
    [
      applyScene,
      captureConfig.layout,
      captureConfig.video,
      client,
      loadScene,
      reportError,
      sceneEditMode,
      sourceDeviceSwitchPending,
      wsStatus
    ]
  )

  const ensureNativePreviewCamera = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return previewCameraStatusRef.current
    }

    if (runtimeInfo?.previewSmokeMode) {
      nativePreviewCameraKeyRef.current = null
      const status = await client.request<PreviewCameraStatus>('preview.camera.stop')
      applyPreviewCameraStatus(status)
      return status
    }

    const cameraId = captureConfig.sources.cameraId
    if (!cameraId) {
      nativePreviewCameraKeyRef.current = null
      const status = await client.request<PreviewCameraStatus>('preview.camera.stop')
      applyPreviewCameraStatus(status)
      return status
    }

    // The camera may only be hot when something composes it: the current preset, or
    // an active session (kept warm so live layout switches swap instantly). A merely
    // selected camera must not hold the device — and its indicator light — all day.
    const presetUsesCamera = captureConfig.layout.layoutPreset !== 'screen-only'
    const sessionActive = isActiveRecordingState(recordingRef.current.state)
    if (!presetUsesCamera && !sessionActive) {
      nativePreviewCameraKeyRef.current = null
      const status = await client.request<PreviewCameraStatus>('preview.camera.stop')
      applyPreviewCameraStatus(status)
      return status
    }

    const key = JSON.stringify({
      cameraId,
      width: captureConfig.video.width,
      height: captureConfig.video.height,
      fps: captureConfig.video.fps
    })
    const current = previewCameraStatusRef.current
    if (
      nativePreviewCameraKeyRef.current === key &&
      current.cameraId === cameraId &&
      (current.state === 'starting' || current.state === 'live')
    ) {
      return current
    }

    const status = await client.request<PreviewCameraStatus>('preview.camera.start', {
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      video: captureConfig.video
    })
    nativePreviewCameraKeyRef.current =
      status.state === 'failed' || status.state === 'device-missing' ? null : key
    applyPreviewCameraStatus(status)
    return status
  }, [
    applyPreviewCameraStatus,
    captureConfig.layout,
    captureConfig.sources,
    captureConfig.video,
    client,
    runtimeInfo?.previewSmokeMode,
    wsStatus
  ])

  const ensureNativePreviewScreen = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return previewScreenStatusRef.current
    }

    if (runtimeInfo?.previewSmokeMode) {
      nativePreviewScreenKeyRef.current = null
      const status = await client.request<PreviewScreenStatus>('preview.screen.stop')
      applyPreviewScreenStatus(status)
      return status
    }

    const sourceId = captureConfig.sources.windowId ?? captureConfig.sources.screenId
    const sourceKind = captureConfig.sources.windowId
      ? 'window'
      : captureConfig.sources.screenId
        ? 'screen'
        : null
    if (!sourceId || !sourceKind) {
      nativePreviewScreenKeyRef.current = null
      const status = await client.request<PreviewScreenStatus>('preview.screen.stop')
      applyPreviewScreenStatus(status)
      return status
    }

    const key = JSON.stringify({
      sourceId,
      sourceKind,
      width: captureConfig.video.width,
      height: captureConfig.video.height,
      fps: captureConfig.video.fps
    })
    const current = previewScreenStatusRef.current
    if (
      nativePreviewScreenKeyRef.current === key &&
      current.sourceId === sourceId &&
      current.sourceKind === sourceKind &&
      (current.state === 'starting' || current.state === 'live')
    ) {
      return current
    }

    const status = await client.request<PreviewScreenStatus>('preview.screen.start', {
      sources: captureConfig.sources,
      video: captureConfig.video
    })
    nativePreviewScreenKeyRef.current =
      status.state === 'failed' || status.state === 'source-missing' ? null : key
    applyPreviewScreenStatus(status)
    return status
  }, [
    applyPreviewScreenStatus,
    captureConfig.sources,
    captureConfig.video,
    client,
    runtimeInfo?.previewSmokeMode,
    wsStatus
  ])

  const refreshPreview = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    if (nativePreviewSurfaceEnabled) {
      const cameraStatus = await ensureNativePreviewCamera()
      const screenStatus = await ensureNativePreviewScreen()
      const activeSourceStatus = screenStatus.state === 'live' ? screenStatus : cameraStatus
      setPreviewLoading(false)
      setPreviewUrl(null)
      setPreviewLiveStatus({
        state: 'live',
        source: 'idle-preview',
        transport: 'electron-proof-surface',
        targetFps: activeSourceStatus.targetFps || previewSurfaceStatusRef.current.targetFps,
        width: (activeSourceStatus.width ?? previewSurfaceStatusRef.current.width) || undefined,
        height: (activeSourceStatus.height ?? previewSurfaceStatusRef.current.height) || undefined,
        message:
          screenStatus.state === 'live'
            ? 'Native screen preview source is live.'
            : cameraStatus.state === 'live'
              ? 'Native camera preview source is live.'
              : (screenStatus.message ??
                cameraStatus.message ??
                'Native preview surface proof mode is active.')
      })
      return
    }

    if (previewRequestPending.current) {
      previewRefreshQueued.current = true
      return
    }

    try {
      previewRequestPending.current = true
      setPreviewLoading(true)
      const status = await client.request<PreviewLiveStatus>('preview.live.start', {
        sources: captureConfig.sources,
        layout: captureConfig.layout,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        video: captureConfig.video
      })
      applyPreviewLiveStatus(status)
    } catch (error) {
      reportError(error)
      setPreviewLiveStatus({
        state: 'unavailable',
        source: 'unavailable',
        transport: 'unavailable',
        message: error instanceof Error ? error.message : 'Live preview failed.'
      })
      setPreviewUrl(null)
    } finally {
      previewRequestPending.current = false
      setPreviewLoading(false)
      if (previewRefreshQueued.current) {
        previewRefreshQueued.current = false
        setPreviewRefreshNonce((current) => current + 1)
      }
    }
  }, [
    applyPreviewLiveStatus,
    captureConfig.layout,
    captureConfig.sources,
    captureConfig.video,
    client,
    ensureNativePreviewCamera,
    ensureNativePreviewScreen,
    nativePreviewSurfaceEnabled,
    reportError,
    settings.ffmpegPath,
    wsStatus
  ])

  const syncNativePreviewSurfaceBounds = useCallback(
    async (bounds: PreviewSurfaceBounds) => {
      if (!nativePreviewSurfaceEnabled || !client || wsStatus !== 'connected') {
        return
      }
      if (
        !window.videorc?.createNativePreviewSurface ||
        !window.videorc?.updateNativePreviewSurfaceBounds
      ) {
        return
      }
      const surfaceAlreadyCreated =
        nativePreviewSurfaceCreatedRef.current || previewSurfaceStatusRef.current.state === 'live'
      if (
        surfaceAlreadyCreated &&
        !previewSurfaceBoundsChanged(nativePreviewSurfaceLastSyncedBoundsRef.current, bounds)
      ) {
        return
      }
      nativePreviewSurfaceBoundsPendingRef.current = bounds
      if (nativePreviewSurfaceBoundsSyncInFlightRef.current) {
        return
      }

      nativePreviewSurfaceBoundsSyncInFlightRef.current = true
      try {
        while (nativePreviewSurfaceBoundsPendingRef.current) {
          const nextBounds = nativePreviewSurfaceBoundsPendingRef.current
          nativePreviewSurfaceBoundsPendingRef.current = null
          const applyHostCommands = window.videorc?.applyNativePreviewHostCommands
          const current = previewSurfaceStatusRef.current
          const surfaceAlreadyCreated =
            nativePreviewSurfaceCreatedRef.current || current.state === 'live'
          if (
            surfaceAlreadyCreated &&
            !previewSurfaceBoundsChanged(
              nativePreviewSurfaceLastSyncedBoundsRef.current,
              nextBounds
            )
          ) {
            continue
          }
          const surfaceSource = captureConfig.sources.windowId
            ? 'window'
            : captureConfig.sources.screenId
              ? 'screen'
              : captureConfig.sources.cameraId
                ? 'camera'
                : 'synthetic'
          // Placement fast path: preview-window movement must not wait for two
          // backend round trips. Apply the update-bounds host command straight to
          // the native hosts, then inform the backend and drop its stale echo below.
          const directlyApplied = surfaceAlreadyCreated && applyHostCommands
          if (directlyApplied) {
            await applyHostCommands([{ kind: 'update-bounds', bounds: nextBounds }])
          }
          const backendStatus = surfaceAlreadyCreated
            ? await client.request<PreviewSurfaceStatus>('preview.surface.update_bounds', {
                bounds: nextBounds
              })
            : await client.request<PreviewSurfaceStatus>('preview.surface.create', {
                bounds: nextBounds,
                targetFps: 60,
                source: surfaceSource
              })
          if (!surfaceAlreadyCreated) {
            nativePreviewCompositorSuppressedPresentsRef.current = 0
            resetNativePreviewCompositorTiming()
          }
          nativePreviewSurfaceCreatedRef.current =
            backendStatus.state === 'live' || surfaceAlreadyCreated
          const queuedCommands = await client.request<NativePreviewHostCommand[]>(
            'preview.surface.take_native_host_commands'
          )
          // The backend queues an update-bounds echo for the change we already
          // applied; replaying it would snap the window back to a stale rect. Only
          // matching echoes are dropped — a genuinely different backend-initiated
          // bounds command still goes through.
          const hostCommands = directlyApplied
            ? queuedCommands.filter(
                (command) =>
                  command.kind !== 'update-bounds' ||
                  !command.bounds ||
                  previewSurfaceBoundsChanged(command.bounds, nextBounds)
              )
            : queuedCommands
          const hostStatus =
            hostCommands.length > 0 && applyHostCommands
              ? await applyHostCommands(hostCommands)
              : surfaceAlreadyCreated
                ? await window.videorc.updateNativePreviewSurfaceBounds(nextBounds)
                : await window.videorc.createNativePreviewSurface(nextBounds)
          nativePreviewSurfaceCreatedRef.current =
            nativePreviewSurfaceCreatedRef.current || hostStatus.state === 'live'
          const backendStatusAfterHostDrain =
            hostCommands.length > 0
              ? { ...backendStatus, pendingHostCommandCount: 0 }
              : backendStatus
          const surfaceStatus = mergePreviewSurfaceHostStatus(
            backendStatusAfterHostDrain,
            hostStatus
          )
          nativePreviewSurfaceLastSyncedBoundsRef.current = nextBounds
          applyPreviewSurfaceStatus(surfaceStatus)
          setPreviewLiveStatus({
            state: 'live',
            source: 'idle-preview',
            transport: surfaceStatus.transport,
            targetFps: surfaceStatus.targetFps,
            width: surfaceStatus.width,
            height: surfaceStatus.height,
            message:
              surfaceStatus.transport === 'native-surface'
                ? 'Native preview surface is active.'
                : 'Native preview surface proof mode is active.'
          })
          setPreviewUrl(null)
          setPreviewLoading(false)
        }
      } finally {
        nativePreviewSurfaceBoundsSyncInFlightRef.current = false
      }
    },
    [
      applyPreviewSurfaceStatus,
      captureConfig.sources.cameraId,
      captureConfig.sources.screenId,
      captureConfig.sources.windowId,
      client,
      nativePreviewSurfaceEnabled,
      resetNativePreviewCompositorTiming,
      wsStatus
    ]
  )

  // --- Detached preview window --------------------------------------------------
  // Main owns the window and is the placement authority; the renderer creates and
  // tears down the backend preview surface session from this state.
  const [previewWindow, setPreviewWindow] = useState<PreviewWindowState>({
    open: false,
    visible: false,
    contentBounds: null,
    scaleFactor: 1,
    screenHeight: 0,
    alwaysOnTop: false
  })
  const previewWindowRef = useRef(previewWindow)
  previewWindowRef.current = previewWindow
  const previewWindowSurfaceActiveRef = useRef(false)

  // Window-state EVENTS are an optimization; the periodic pull is the truth.
  // A lost IPC event (HMR reload, listener not yet registered at auto-restore)
  // previously left the backend session uncreated — open window, dark preview,
  // compositor never started. The reconciler heals that within one tick.
  useEffect(() => {
    let cancelled = false
    const reconcile = async (): Promise<void> => {
      const fresh = await window.videorc?.getPreviewWindowState?.()
      if (!fresh || cancelled) {
        return
      }
      setPreviewWindow((current) => {
        // Force a re-drive when the window is open but the surface session was
        // never created (a swallowed create attempt) even if state looks equal.
        if (fresh.open && !nativePreviewSurfaceCreatedRef.current) {
          return { ...fresh }
        }
        return JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
      })
    }
    void reconcile()
    const timer = window.setInterval(() => {
      void reconcile()
    }, 4000)
    const unsubscribe = window.videorc?.onPreviewWindowState?.((state) => setPreviewWindow(state))
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe?.()
    }
  }, [wsStatus])

  // Frame polling serves the Electron proof surface; it is pure overhead while a
  // session records (the compositor feeds the encoder directly) and while the
  // detached preview window is closed (nothing presents at all) — UI rewrite U2.
  const syncFramePollingSuppression = useCallback(() => {
    if (
      !nativePreviewSurfaceEnabled ||
      !window.videorc?.setNativePreviewSurfaceFramePollingSuppressed
    ) {
      return
    }
    const suppress =
      isActiveRecordingState(recordingRef.current.state) || !previewWindowRef.current.open
    void window.videorc
      .setNativePreviewSurfaceFramePollingSuppressed(suppress)
      .then(applyPreviewSurfaceStatus)
      .catch((error: unknown) => {
        console.error('Native preview frame-polling suppression failed:', error)
      })
  }, [applyPreviewSurfaceStatus, nativePreviewSurfaceEnabled])

  syncFramePollingSuppressionRef.current = syncFramePollingSuppression

  // Closing the preview window must cost nothing: tear the surface session down
  // (helper window, proof window, backend session) instead of merely hiding it.
  const teardownDetachedPreviewSurface = useCallback(async () => {
    nativePreviewSurfaceCreatedRef.current = false
    nativePreviewSurfaceLastSyncedBoundsRef.current = null
    try {
      if (window.videorc?.applyNativePreviewHostCommands) {
        await window.videorc.applyNativePreviewHostCommands([{ kind: 'destroy' }])
      }
      if (clientRef.current && wsStatusRef.current === 'connected') {
        await clientRef.current.request('preview.surface.destroy')
      }
    } catch (error) {
      console.error('Detached preview surface teardown failed:', error)
    }
  }, [])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled) {
      return
    }
    syncFramePollingSuppression()
    if (previewWindow.open && previewWindow.contentBounds) {
      const contentBounds = previewWindow.contentBounds
      const bounds: PreviewSurfaceBounds = {
        screenX: contentBounds.x,
        screenY: contentBounds.y,
        width: contentBounds.width,
        height: contentBounds.height,
        scaleFactor: previewWindow.scaleFactor,
        screenHeight: previewWindow.screenHeight > 0 ? previewWindow.screenHeight : undefined,
        clipX: contentBounds.x,
        clipY: contentBounds.y,
        clipWidth: contentBounds.width,
        clipHeight: contentBounds.height,
        visible: previewWindow.visible
      }
      previewWindowSurfaceActiveRef.current = true
      void syncNativePreviewSurfaceBounds(bounds)
      return
    }
    if (!previewWindow.open && previewWindowSurfaceActiveRef.current) {
      previewWindowSurfaceActiveRef.current = false
      void teardownDetachedPreviewSurface()
    }
  }, [
    nativePreviewSurfaceEnabled,
    previewWindow,
    syncFramePollingSuppression,
    syncNativePreviewSurfaceBounds,
    teardownDetachedPreviewSurface
  ])

  const openPreviewWindow = useCallback(async () => {
    await window.videorc?.openPreviewWindow?.()
  }, [])

  const closePreviewWindow = useCallback(async () => {
    await window.videorc?.closePreviewWindow?.()
  }, [])

  const setPreviewWindowAlwaysOnTop = useCallback(async (alwaysOnTop: boolean) => {
    await window.videorc?.setPreviewWindowAlwaysOnTop?.(alwaysOnTop)
  }, [])

  // The preview window is locked to the OUTPUT aspect ratio — the user can never
  // squeeze or stretch what they will record/stream.
  useEffect(() => {
    void window.videorc?.setPreviewWindowAspectRatio?.(
      captureConfig.video.width,
      captureConfig.video.height
    )
  }, [captureConfig.video.width, captureConfig.video.height])

  const syncNativePreviewSurfaceScene = useCallback(async () => {
    if (!nativePreviewSurfaceEnabled || !window.videorc?.updateNativePreviewSurfaceScene) {
      return
    }

    const revision = nativePreviewSurfaceSceneRevisionRef.current + 1
    nativePreviewSurfaceSceneRevisionRef.current = revision
    const params: PreviewSurfaceSceneUpdateParams = {
      revision,
      scene: sceneWithBackground,
      layout: captureConfig.layout,
      activeScreen: activeScreen ?? null
    }
    if (client && wsStatus === 'connected') {
      const compositorParams: CompositorSceneUpdateParams = params
      const compositorStatus = await client.request<CompositorStatus>(
        'compositor.scene.update',
        compositorParams
      )
      if (window.videorc.updateNativePreviewSurfaceCompositor) {
        const status = await window.videorc.updateNativePreviewSurfaceCompositor(compositorStatus)
        applyPreviewSurfaceStatus({
          ...status,
          framesRendered: Math.max(
            status.framesRendered,
            previewSurfaceStatusRef.current.framesRendered
          )
        })
        return
      }
    }
    const status = await window.videorc.updateNativePreviewSurfaceScene(params)
    applyPreviewSurfaceStatus({
      ...status,
      framesRendered: Math.max(
        status.framesRendered,
        previewSurfaceStatusRef.current.framesRendered
      )
    })
  }, [
    activeScreen,
    applyPreviewSurfaceStatus,
    captureConfig.layout,
    client,
    nativePreviewSurfaceEnabled,
    sceneWithBackground,
    wsStatus
  ])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled) {
      return
    }
    void syncNativePreviewSurfaceScene().catch((error: unknown) => {
      console.error('Native preview surface scene update failed:', error)
    })
  }, [nativePreviewSurfaceEnabled, syncNativePreviewSurfaceScene])

  const registerPreviewSurfaceResize = useCallback(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    void client
      .request<DiagnosticStats>('diagnostics.preview_surface.resize')
      .then(setDiagnosticStats)
      .catch(() => {
        // Resize diagnostics are best-effort and should never interrupt editing.
      })
  }, [client, wsStatus])

  const importScreenImage = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      toast.error('Backend socket is not connected.')
      return
    }
    if (!window.videorc?.pickScreenImage) {
      toast.error('Screen image picker is unavailable outside Electron.')
      return
    }

    try {
      setLastError(null)
      const path = await window.videorc.pickScreenImage()
      if (!path) {
        return
      }

      setScreenImportPending(true)
      const screen = await client.request<StreamScreen>('screens.importImage', {
        path,
        ffmpegPath: settings.ffmpegPath.trim() || undefined
      })
      setScreens((current) => {
        const withoutExisting = current.filter((item) => item.id !== screen.id)
        return [...withoutExisting, screen].sort((a, b) => a.sortOrder - b.sortOrder)
      })
      await refreshScreensForClient(client)
      toast.success(`Imported ${screen.name}.`)
    } catch (error) {
      reportError(error)
    } finally {
      setScreenImportPending(false)
    }
  }, [client, refreshScreensForClient, reportError, settings.ffmpegPath, wsStatus])

  const openSystemPermission = useCallback(
    async (pane: SystemPermissionPane) => {
      if (!window.videorc?.openSystemPermissions) {
        toast.error('Permission shortcut is unavailable outside Electron.')
        return
      }

      try {
        await window.videorc.openSystemPermissions(pane)
      } catch (error) {
        reportError(error)
      }
    },
    [reportError]
  )

  const openPreviewPermissions = useCallback(async () => {
    await openSystemPermission('screen-recording')
  }, [openSystemPermission])

  const revealPermissionTarget = useCallback(async () => {
    if (!window.videorc?.revealPermissionTarget) {
      toast.error('Permission target shortcut is unavailable outside Electron.')
      return
    }

    try {
      await window.videorc.revealPermissionTarget()
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const exportSupportBundle = useCallback(async () => {
    if (!client) {
      toast.error('Backend socket is not connected.')
      return
    }
    if (supportBundleExportPending) {
      return
    }

    try {
      setLastError(null)
      setSupportBundleExportPending(true)
      const result = await client.request<SupportBundleExportResult>(
        'diagnostics.supportBundle.export',
        {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        }
      )
      const reveal = window.videorc?.revealPath
      toast.success('Support bundle exported.', {
        description: result.path,
        action: reveal
          ? {
              label: 'Reveal',
              onClick: () => void reveal(result.path)
            }
          : undefined
      })
    } catch (error) {
      reportError(error)
    } finally {
      setSupportBundleExportPending(false)
    }
  }, [client, reportError, settings.ffmpegPath, supportBundleExportPending])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      setAudioMeterLoading(true)
      const result = await client.request<AudioMeterResult>('audio.meter.sample', {
        microphoneId: captureConfig.sources.microphoneId,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        microphoneGainDb: captureConfig.audio.microphoneGainDb,
        microphoneMuted: captureConfig.audio.microphoneMuted
      })
      setAudioMeter(result)
    } catch (error) {
      reportError(error)
    } finally {
      setAudioMeterLoading(false)
    }
  }, [
    captureConfig.audio.microphoneGainDb,
    captureConfig.audio.microphoneMuted,
    captureConfig.sources.microphoneId,
    client,
    reportError,
    settings.ffmpegPath
  ])

  const outputEnabled = captureConfig.recordEnabled || captureConfig.streamEnabled
  const profileCompatibility = videoProfileCompatibility(captureConfig)
  const streamReady =
    !captureConfig.streamEnabled || areEnabledStreamTargetsStartReady(captureConfig.streaming)
  const livestreamingEntitlementReason = entitlementDisabledReason(entitlements, 'livestreaming')
  const cloudAiEntitlementReason = entitlementDisabledReason(entitlements, 'cloud-ai')
  const isSessionActive =
    isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending

  useEffect(() => {
    if (aiConsent && cloudAiEntitlementReason) {
      setAiConsent(false)
    }
  }, [aiConsent, cloudAiEntitlementReason])

  const renameScreen = useCallback(
    async (screenId: string, name: string) => {
      if (!client || isSessionActive) {
        toast.error(
          isSessionActive
            ? 'Screen management is locked while live.'
            : 'Backend socket is not connected.'
        )
        return
      }

      try {
        setLastError(null)
        const screen = await client.request<StreamScreen>('screens.rename', { screenId, name })
        setScreens((current) => current.map((item) => (item.id === screen.id ? screen : item)))
        toast.success(`Renamed ${screen.name}.`)
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError]
  )

  const deleteScreen = useCallback(
    async (screenId: string) => {
      if (!client || isSessionActive) {
        toast.error(
          isSessionActive
            ? 'Screen management is locked while live.'
            : 'Backend socket is not connected.'
        )
        return
      }

      try {
        setLastError(null)
        const nextScreens = await client.request<StreamScreen[]>('screens.delete', { screenId })
        setScreens(nextScreens)
        toast.success('Deleted Screen.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError]
  )

  const moveScreen = useCallback(
    async (screenId: string, direction: -1 | 1) => {
      if (!client || isSessionActive) {
        toast.error(
          isSessionActive
            ? 'Screen management is locked while live.'
            : 'Backend socket is not connected.'
        )
        return
      }

      const currentIndex = screens.findIndex((screen) => screen.id === screenId)
      const nextIndex = currentIndex + direction
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= screens.length) {
        return
      }

      const screenIds = screens.map((screen) => screen.id)
      const [moved] = screenIds.splice(currentIndex, 1)
      if (!moved) {
        return
      }
      screenIds.splice(nextIndex, 0, moved)

      try {
        setLastError(null)
        const nextScreens = await client.request<StreamScreen[]>('screens.reorder', { screenIds })
        setScreens(nextScreens)
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError, screens]
  )

  const activateScreen = useCallback(
    async (screenId: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const screen = await client.request<StreamScreen>('screens.activate', { screenId })
        setActiveScreen(screen)
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError]
  )

  const clearActiveScreen = useCallback(async () => {
    if (!client) {
      toast.error('Backend socket is not connected.')
      return
    }

    try {
      setLastError(null)
      await client.request<StreamScreen | null>('screens.clear')
      setActiveScreen(null)
    } catch (error) {
      reportError(error)
    }
  }, [client, reportError])

  const disconnectPlatformAccount = useCallback(
    async (platform: PlatformAccount['platform']) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        await client.request<PlatformAccount | null>('platformAccounts.disconnect', { platform })
        await refreshPlatformAccountsForClient(client)
        setCaptureConfig((current) => {
          const targets = current.streaming.targets.map((target) =>
            target.platform === platform
              ? {
                  ...target,
                  accountId: undefined,
                  accountLabel: undefined,
                  streamKeySecretRef: undefined,
                  platformBroadcastId: undefined,
                  platformStreamId: undefined
                }
              : target
          )
          return bridgeStreamingToLegacy({
            ...current,
            streaming: { ...current.streaming, targets }
          })
        })
        toast.success('Disconnected account.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshPlatformAccountsForClient, reportError, wsStatus]
  )

  const connectPlatformAccount = useCallback(
    async (platform: PlatformAccount['platform']) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }
      if (!window.videorc?.openOAuthUrl) {
        toast.error('OAuth browser launch is unavailable outside Electron.')
        return
      }

      try {
        setLastError(null)
        const redirectUri = await window.videorc.getOAuthCallbackRedirectUri(platform)
        const params = redirectUri ? { platform, redirectUri } : { platform }
        const result = await client.request<OAuthStartResult>(
          'platformAccounts.oauth.startProvider',
          params
        )
        await window.videorc.openOAuthUrl(result.authUrl)
        // Exact-match providers reject unregistered callback URLs with a vague
        // page ("Something went wrong"); surface the exact URI to register so
        // the user can fix the portal without guessing.
        if (platform === 'x' && result.redirectUri.startsWith('http://127.0.0.1')) {
          toast.success('OAuth browser opened.', {
            description:
              `If X shows "Something went wrong", add ${result.redirectUri} ` +
              '(plus the 27995 and 37995 port variants) to the callback URLs of ' +
              'the X developer app — X requires an exact match, so use http and 127.0.0.1, not localhost.',
            duration: 15000
          })
        } else {
          toast.success('OAuth browser opened.')
        }
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError, wsStatus]
  )

  useEffect(() => {
    if (!window.videorc?.onOAuthCallbackUrl) {
      return
    }

    return window.videorc.onOAuthCallbackUrl((callbackUrl) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('OAuth callback received before the backend was connected.')
        return
      }

      let parsed: URL
      try {
        parsed = new URL(callbackUrl)
      } catch (error) {
        reportError(error)
        return
      }

      const state = parsed.searchParams.get('state')?.trim()
      if (!state) {
        toast.error('OAuth callback was missing state.')
        return
      }

      const params: OAuthCompleteParams = {
        state,
        code: parsed.searchParams.get('code') ?? undefined,
        error: parsed.searchParams.get('error') ?? undefined,
        errorDescription: parsed.searchParams.get('error_description') ?? undefined
      }

      void client.request('platformAccounts.oauth.complete', params).catch(reportError)
    })
  }, [client, reportError, wsStatus])

  const patchStreamMetadataDraft = useCallback((patch: Partial<StreamMetadataDraft>) => {
    setStreamMetadataDraft((current) => (current ? { ...current, ...patch } : current))
    setStreamMetadataValidation(null)
  }, [])

  const patchStreamTargetMetadataDraft = useCallback(
    (
      platform: StreamMetadataDraft['targetOverrides'][number]['platform'],
      patch: Partial<StreamMetadataDraft['targetOverrides'][number]>
    ) => {
      setStreamMetadataDraft((current) =>
        current
          ? {
              ...current,
              targetOverrides: current.targetOverrides.map((target) =>
                target.platform === platform ? { ...target, ...patch } : target
              )
            }
          : current
      )
      setStreamMetadataValidation(null)
    },
    []
  )

  const saveStreamMetadataDraft = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      toast.error('Backend socket is not connected.')
      return
    }
    if (!streamMetadataDraft) {
      toast.error('Metadata draft is not loaded yet.')
      return
    }

    try {
      setLastError(null)
      setStreamMetadataSavePending(true)
      const validation = await client.request<StreamMetadataValidation>(
        'streamTargets.metadata.validate',
        streamMetadataDraft
      )
      setStreamMetadataValidation(validation)
      const saved = await client.request<StreamMetadataDraft>(
        'streamTargets.metadata.update',
        streamMetadataDraft
      )
      setStreamMetadataDraft(saved)
      if (validation.valid) {
        toast.success('Saved stream metadata.')
      } else {
        toast.warning('Saved stream metadata with warnings.')
      }
    } catch (error) {
      reportError(error)
    } finally {
      setStreamMetadataSavePending(false)
    }
  }, [client, reportError, streamMetadataDraft, wsStatus])

  useEffect(() => {
    if (runtimeInfo?.disableAutoPreview) {
      return
    }
    if (
      !client ||
      wsStatus !== 'connected' ||
      isSessionActive ||
      !health?.ffmpeg.available ||
      !deviceList.devices.length
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 500)

    return () => window.clearTimeout(timer)
  }, [
    client,
    deviceList.devices.length,
    health?.ffmpeg.available,
    isSessionActive,
    previewRefreshNonce,
    refreshPreview,
    runtimeInfo?.disableAutoPreview,
    wsStatus
  ])

  const startBlockedReason = (() => {
    if (wsStatus !== 'connected') {
      return `Backend socket is ${wsStatus}.`
    }
    if (isSessionActive) {
      return 'A capture session is already active.'
    }
    if (!outputEnabled) {
      return 'Enable Record MKV, Stream RTMP, or both before starting.'
    }
    if (profileCompatibility.blockingReason) {
      return profileCompatibility.blockingReason
    }
    if (captureConfig.streamEnabled && livestreamingEntitlementReason) {
      return livestreamingEntitlementReason
    }
    if (captureConfig.streamEnabled && !streamReady) {
      return captureConfig.streaming.targets.some((target) => target.enabled)
        ? 'Finish manual livestream destination setup before streaming.'
        : 'Enable at least one livestream destination before streaming.'
    }
    if (!health) {
      return 'Checking FFmpeg before starting.'
    }
    if (!health.ffmpeg.available) {
      return health.ffmpeg.message ?? 'FFmpeg is not available.'
    }

    return null
  })()

  const activatePreparedYouTubeBroadcasts = useCallback(
    async (streamingForStart: StreamingSettings, runId: number) => {
      if (!client) {
        return
      }

      const youtubeTargets = preparedYouTubeActivationTargets(streamingForStart)

      for (const target of youtubeTargets) {
        const broadcastId = target.platformBroadcastId
        const streamId = target.platformStreamId
        if (!broadcastId || !streamId) {
          continue
        }
        if (platformLifecycleRun.current !== runId) {
          return
        }

        try {
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'connecting',
                  message: 'Waiting for YouTube ingest.'
                }
              })
            })
          )

          let lastStatus: YouTubeStreamStatusResult | null = null
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (platformLifecycleRun.current !== runId) {
              return
            }
            lastStatus = await client.request<YouTubeStreamStatusResult>(
              'streamTargets.youtube.streamStatus',
              {
                accountId: target.accountId,
                streamId
              }
            )
            const statusSnapshot = lastStatus
            setCaptureConfig((current) =>
              bridgeStreamingToLegacy({
                ...current,
                streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                  status: {
                    state: statusSnapshot.active ? 'connecting' : 'warning',
                    message: statusSnapshot.message
                  }
                })
              })
            )
            if (statusSnapshot.active) {
              break
            }
            await delay(2000)
          }

          if (!lastStatus?.active) {
            throw new Error(lastStatus?.message ?? 'YouTube ingest did not become active yet.')
          }
          if (platformLifecycleRun.current !== runId) {
            return
          }

          const transition = await client.request<YouTubeBroadcastTransitionResult>(
            'streamTargets.youtube.transition',
            {
              accountId: target.accountId,
              broadcastId,
              status: 'live'
            }
          )
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'live',
                  message: transition.lifecycleStatus
                    ? `YouTube broadcast is live (${transition.lifecycleStatus}).`
                    : 'YouTube broadcast is live.'
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `YouTube go-live needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not transition ${target.label} live on YouTube.`, {
            description: message
          })
        }
      }
    },
    [client]
  )

  const completePreparedPlatformBroadcasts = useCallback(
    async (streamingForCleanup: StreamingSettings = captureConfig.streaming) => {
      if (!client) {
        return
      }

      const youtubeTargets = preparedYouTubeCompletionTargets(streamingForCleanup)
      for (const target of youtubeTargets) {
        const broadcastId = target.platformBroadcastId
        if (!broadcastId) {
          continue
        }
        try {
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'connecting',
                  message: 'Completing YouTube broadcast.'
                }
              })
            })
          )
          const result = await client.request<YouTubeBroadcastTransitionResult>(
            'streamTargets.youtube.transition',
            {
              accountId: target.accountId,
              broadcastId,
              status: 'complete'
            }
          )
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'stopped',
                  message: result.lifecycleStatus
                    ? `YouTube broadcast ended (${result.lifecycleStatus}).`
                    : 'YouTube broadcast ended.'
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `YouTube cleanup needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not complete ${target.label} on YouTube.`, {
            description: message
          })
        }
      }
    },
    [captureConfig.streaming, client]
  )

  const runStartSession = useCallback(
    async (streamingOverride?: StreamingSettings) => {
      if (!client || startBlockedReason) {
        if (startBlockedReason && !isSessionActive) {
          reportError(new Error(startBlockedReason))
        }
        return
      }

      let streamingForStart: StreamingSettings | null = null
      try {
        setLastError(null)
        setStreamHealth(null)
        setStreamTargets([])
        setStartRequestPending(true)
        streamingForStart = streamingOverride ?? captureConfig.streaming
        const lifecycleRunId = platformLifecycleRun.current + 1
        platformLifecycleRun.current = lifecycleRunId
        const enabledOauthTargets = streamingForStart.targets.filter(
          (target) => target.enabled && target.authMode === 'oauth'
        )
        if (enabledOauthTargets.length) {
          const validations = await validatePlatformAccountsForClient(client)
          const unhealthy = enabledOauthTargets.find((target) => {
            const validation = validations.find((item) => item.platform === target.platform)
            return !validation || !['valid', 'refreshed'].includes(validation.state)
          })
          if (unhealthy) {
            throw new Error(`Reconnect ${unhealthy.label} before starting an OAuth livestream.`)
          }
        }
        const optimisticRecording = isActiveRecordingState(recordingRef.current.state)
          ? recordingRef.current
          : {
              state: 'starting' as const,
              message: streamingOverride ? 'Preparing livestream…' : 'Preparing recording…'
            }
        applyRecordingStatus(optimisticRecording)
        const nextSessionParams: StartSessionParams = streamingOverride
          ? {
              ...sessionParams,
              output: { ...sessionParams.output, streamEnabled: true },
              streaming: streamingOverride
            }
          : sessionParams
        const status = await client.request<RecordingStatus>('session.start', nextSessionParams)
        applyRecordingStatus(status)
        await refreshSessions(client)
        await activatePreparedYouTubeBroadcasts(streamingForStart, lifecycleRunId)
      } catch (error) {
        if (streamingOverride && streamingForStart) {
          await completePreparedPlatformBroadcasts(streamingForStart)
        }
        reportError(error)
        if (recordingRef.current.state === 'starting' && !recordingRef.current.sessionId) {
          applyRecordingStatus({ state: 'idle', message: 'Ready to start a capture session.' })
        }
      } finally {
        setStartRequestPending(false)
      }
    },
    [
      activatePreparedYouTubeBroadcasts,
      applyRecordingStatus,
      captureConfig.streaming,
      client,
      completePreparedPlatformBroadcasts,
      isSessionActive,
      refreshSessions,
      reportError,
      sessionParams,
      startBlockedReason,
      validatePlatformAccountsForClient
    ]
  )

  const prepareOauthTargetsForGoLive = useCallback(async (): Promise<GoLivePartialSetup> => {
    if (!client) {
      throw new Error('Backend socket is not connected.')
    }

    let nextStreaming = captureConfig.streaming
    const failures: GoLiveSetupFailure[] = []
    for (const target of captureConfig.streaming.targets.filter(
      (target) => target.enabled && target.authMode === 'oauth'
    )) {
      try {
        if (target.platform === 'youtube') {
          const prepared = await client.request<PreparedYouTubeBroadcast>(
            'streamTargets.youtube.prepare',
            {
              accountId: target.accountId,
              video: captureConfig.video
            }
          )
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            accountId: prepared.accountId,
            accountLabel: prepared.accountLabel,
            serverUrl: prepared.serverUrl,
            streamKeySecretRef: prepared.streamKeySecretRef,
            streamKeyPresent: true,
            platformBroadcastId: prepared.broadcastId,
            platformStreamId: prepared.streamId,
            status: {
              state: 'ready',
              message: 'YouTube broadcast prepared.'
            }
          })
        } else if (target.platform === 'twitch') {
          const prepared = await client.request<PreparedTwitchBroadcast>(
            'streamTargets.twitch.prepare',
            {
              accountId: target.accountId
            }
          )
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            accountId: prepared.accountId,
            accountLabel: prepared.accountLabel,
            serverUrl: prepared.serverUrl,
            streamKeySecretRef: prepared.streamKeySecretRef,
            streamKeyPresent: true,
            platformBroadcastId: undefined,
            platformStreamId: undefined,
            status: {
              state: 'ready',
              message: 'Twitch channel prepared.'
            }
          })
        } else if (target.platform === 'x') {
          await client.request('streamTargets.x.prepare', { accountId: target.accountId })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({
          targetId: target.id,
          platform: target.platform,
          label: target.label,
          message
        })
        nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
          enabled: false,
          status: {
            state: 'failed',
            message
          }
        })
      }
    }

    setCaptureConfig((current) => bridgeStreamingToLegacy({ ...current, streaming: nextStreaming }))
    await refreshPlatformAccountsForClient(client)
    return {
      streaming: nextStreaming,
      failures,
      readyLabels: nextStreaming.targets
        .filter((target) => target.enabled)
        .map((target) => target.label)
    }
  }, [captureConfig.streaming, captureConfig.video, client, refreshPlatformAccountsForClient])

  const openGoLiveConfirmation = useCallback(async () => {
    if (!client || startBlockedReason) {
      if (startBlockedReason && !isSessionActive) {
        reportError(new Error(startBlockedReason))
      }
      return
    }

    try {
      setLastError(null)
      setGoLivePartialSetup(null)
      setGoLiveConfirmationPending(true)
      if (streamMetadataDraft) {
        const saved = await client.request<StreamMetadataDraft>(
          'streamTargets.metadata.update',
          streamMetadataDraft
        )
        setStreamMetadataDraft(saved)
        const validation = await client.request<StreamMetadataValidation>(
          'streamTargets.metadata.validate',
          saved
        )
        setStreamMetadataValidation(validation)
      }
      const preflight = await client.request<GoLivePreflight>(
        'streamTargets.confirmation.validate',
        {
          streaming: captureConfig.streaming
        }
      )
      setGoLivePreflight(preflight)
      setGoLiveConfirmationOpen(true)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [
    captureConfig.streaming,
    client,
    isSessionActive,
    reportError,
    startBlockedReason,
    streamMetadataDraft
  ])

  const startSession = useCallback(async () => {
    if (decideGoLiveStart(captureConfig.streamEnabled) === 'open-confirmation') {
      await openGoLiveConfirmation()
      return
    }
    await runStartSession()
  }, [captureConfig.streamEnabled, openGoLiveConfirmation, runStartSession])

  const cancelGoLiveConfirmation = useCallback(() => {
    const decision = decideCancelGoLiveConfirmation({
      goLiveConfirmationPending,
      startRequestPending,
      partialSetup: goLivePartialSetup
    })
    if (decision.kind === 'ignore') {
      return
    }
    if (decision.cleanupStreaming) {
      void completePreparedPlatformBroadcasts(decision.cleanupStreaming)
    }
    setGoLivePartialSetup(null)
    setGoLiveConfirmationOpen(false)
  }, [
    completePreparedPlatformBroadcasts,
    goLiveConfirmationPending,
    goLivePartialSetup,
    startRequestPending
  ])

  const confirmGoLive = useCallback(async () => {
    if (!client || goLiveConfirmationPending || startRequestPending) {
      return
    }

    try {
      setLastError(null)
      setGoLiveConfirmationPending(true)
      if (streamMetadataDraft) {
        const saved = await client.request<StreamMetadataDraft>(
          'streamTargets.metadata.update',
          streamMetadataDraft
        )
        setStreamMetadataDraft(saved)
        const validation = await client.request<StreamMetadataValidation>(
          'streamTargets.metadata.validate',
          saved
        )
        setStreamMetadataValidation(validation)
      }
      const preflight = await client.request<GoLivePreflight>(
        'streamTargets.confirmation.validate',
        {
          streaming: captureConfig.streaming
        }
      )
      setGoLivePreflight(preflight)
      const preflightDecision = decideGoLivePreflight(preflight)
      if (preflightDecision.kind === 'blocked') {
        toast.error('Resolve Go Live issues before starting.')
        return
      }
      const setup = await prepareOauthTargetsForGoLive()
      const setupDecision = decidePreparedGoLiveSetup(setup)
      if (setupDecision.kind === 'no-ready-destinations') {
        throw new Error('No livestream destinations are ready after platform setup.')
      }
      if (setupDecision.kind === 'partial') {
        setGoLivePartialSetup(setupDecision.setup)
        toast.warning('Some destinations failed setup.', {
          description: 'Continue with the ready destinations or cancel this Go Live.'
        })
        return
      }
      setGoLiveConfirmationOpen(false)
      await runStartSession(setupDecision.streaming)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [
    captureConfig.streaming,
    client,
    goLiveConfirmationPending,
    prepareOauthTargetsForGoLive,
    reportError,
    runStartSession,
    startRequestPending,
    streamMetadataDraft
  ])

  const continueGoLiveWithReadyDestinations = useCallback(async () => {
    const decision = decideContinueGoLiveWithReadyDestinations({
      goLiveConfirmationPending,
      startRequestPending,
      partialSetup: goLivePartialSetup
    })
    if (decision.kind === 'ignore') {
      return
    }

    try {
      setLastError(null)
      setGoLiveConfirmationPending(true)
      setGoLivePartialSetup(null)
      setGoLiveConfirmationOpen(false)
      await runStartSession(decision.streaming)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [
    goLiveConfirmationPending,
    goLivePartialSetup,
    reportError,
    runStartSession,
    startRequestPending
  ])

  const stopSession = useCallback(async () => {
    if (!client || stopRequestPending) {
      return
    }

    try {
      setLastError(null)
      platformLifecycleRun.current += 1
      setStopRequestPending(true)
      const status = await client.request<RecordingStatus>('session.stop')
      applyRecordingStatus(status)
      await completePreparedPlatformBroadcasts()
    } catch (error) {
      reportError(error)
    } finally {
      setStopRequestPending(false)
    }
  }, [
    applyRecordingStatus,
    client,
    completePreparedPlatformBroadcasts,
    reportError,
    stopRequestPending
  ])

  const remuxSession = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        await client.request('session.remux_mp4', {
          sessionId,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
        toast.success('Remuxed recording to MP4.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshSessions, reportError, settings.ffmpegPath]
  )

  const runAiWorkflow = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }
      if (aiConsent && cloudAiEntitlementReason) {
        toast.error('Cloud AI requires Videorc Premium.', {
          description: cloudAiEntitlementReason
        })
        return
      }

      try {
        setLastError(null)
        setAiRunningSessionId(sessionId)
        await client.request<AiWorkflowResult>('ai.run_post_recording', {
          sessionId,
          consentToUploadAudio: aiConsent,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
        toast.success(
          aiConsent
            ? 'AI workflow finished.'
            : 'Extracted local audio. Enable consent for cloud AI.'
        )
      } catch (error) {
        reportError(error)
      } finally {
        setAiRunningSessionId(null)
      }
    },
    [aiConsent, client, cloudAiEntitlementReason, refreshSessions, reportError, settings.ffmpegPath]
  )

  const exportPublishPack = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setExportRunningSessionId(sessionId)
        const result = await client.request<ExportPublishPackResult>('ai.publish_pack.export', {
          sessionId
        })
        toast.success(`Publish pack exported to ${result.markdownPath}`)
      } catch (error) {
        reportError(error)
      } finally {
        setExportRunningSessionId(null)
      }
    },
    [client, reportError]
  )

  const assessRecording = useCallback(
    async (path: string): Promise<FileAssessment> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      return client.request<FileAssessment>('repair.assess_file', { path })
    },
    [client]
  )

  const repairRecording = useCallback(
    async (path: string): Promise<GateStatus> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      return client.request<GateStatus>('repair.repair_file', { path })
    },
    [client]
  )

  const restoreRecording = useCallback(
    async (path: string): Promise<boolean> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const result = await client.request<{ restored: boolean }>('repair.restore_file', { path })
      return result.restored
    },
    [client]
  )

  const patchVideo = useCallback((patch: Partial<VideoSettings>) => {
    setCaptureConfig((current) => ({
      ...current,
      video: { ...current.video, ...patch, preset: 'custom' }
    }))
  }, [])

  const applyVideoPreset = useCallback((preset: VideoPreset) => {
    setCaptureConfig((current) => ({ ...current, video: videoPresets[preset] }))
  }, [])

  const applyRtmpPreset = useCallback((preset: RtmpPreset) => {
    setCaptureConfig((current) => ({
      ...current,
      rtmpPreset: preset,
      rtmpServerUrl: rtmpDefaults[preset] || current.rtmpServerUrl,
      // Stream keys are platform-specific — never carry one across a platform switch.
      streamKey: ''
    }))
  }, [])

  const patchStreamingTarget = useCallback(
    (targetId: string, patch: Partial<StreamTargetSettings>) => {
      setCaptureConfig((current) =>
        bridgeStreamingToLegacy({
          ...current,
          streaming: streamingWithTargetPatch(current.streaming, targetId, patch)
        })
      )
    },
    []
  )

  // Resolves a Go Live blocker from inside the confirmation dialog: disable
  // the destination (go live without it) or flip it to Manual RTMP. The
  // preflight revalidates against the patched snapshot immediately so the
  // dialog reflects the resolution without reopening.
  const resolveGoLiveBlocker = useCallback(
    async (targetId: string, resolution: 'disable' | 'manual-rtmp') => {
      const patch: Partial<StreamTargetSettings> =
        resolution === 'disable' ? { enabled: false } : { authMode: 'manual-rtmp' }
      const nextStreaming = streamingWithTargetPatch(
        captureConfigRef.current.streaming,
        targetId,
        patch
      )
      patchStreamingTarget(targetId, patch)
      if (!client) {
        return
      }
      try {
        const preflight = await client.request<GoLivePreflight>(
          'streamTargets.confirmation.validate',
          { streaming: nextStreaming }
        )
        setGoLivePreflight(preflight)
      } catch (error) {
        reportError(error)
      }
    },
    [client, patchStreamingTarget, reportError]
  )

  const patchManualStreamKeyResult = useCallback(
    (targetId: string, result: StoreManualStreamKeyResult) => {
      setCaptureConfig((current) => applyStoredManualStreamKeyResult(current, targetId, result))
    },
    []
  )

  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    const candidates = legacyStreamKeyMigrationCandidates(captureConfig).filter(
      (candidate) => !legacyStreamKeyMigrationAttemptedRef.current.has(candidate.targetId)
    )
    if (candidates.length === 0) {
      return
    }

    void (async () => {
      for (const candidate of candidates) {
        legacyStreamKeyMigrationAttemptedRef.current.add(candidate.targetId)
        const label =
          captureConfigRef.current.streaming.targets.find((item) => item.id === candidate.targetId)
            ?.label ?? candidate.targetId
        try {
          const result = await client.request<StoreManualStreamKeyResult>(
            'streamTargets.manualKey.store',
            {
              targetId: candidate.targetId,
              streamKey: candidate.streamKey
            }
          )
          patchManualStreamKeyResult(candidate.targetId, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setLastError(`Could not migrate saved ${label} stream key: ${message}`)
          toast.warning(`Could not migrate ${label} stream key.`, {
            description:
              'The key will stay available for this session. Save it again from Streaming settings to remove the legacy local copy.'
          })
        }
      }
    })()
  }, [captureConfig, client, patchManualStreamKeyResult, wsStatus])

  const saveManualStreamKey = useCallback(
    async (targetId: string, streamKey: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return false
      }

      try {
        setLastError(null)
        const result = await client.request<StoreManualStreamKeyResult>(
          'streamTargets.manualKey.store',
          {
            targetId,
            streamKey
          }
        )
        patchManualStreamKeyResult(targetId, result)
        const label =
          captureConfigRef.current.streaming.targets.find((item) => item.id === targetId)?.label ??
          targetId
        if (result.streamKeyPresent) {
          toast.success(
            `${label} stream key saved${result.streamKeyHint ? ` (ends ${result.streamKeyHint})` : ''}.`
          )
        } else {
          toast.success(
            result.previousStreamKeyPresent
              ? `${label} stream key removed — the previous key is kept for restore.`
              : `${label} stream key removed.`
          )
        }
        return true
      } catch (error) {
        reportError(error)
        return false
      }
    },
    [client, patchManualStreamKeyResult, reportError]
  )

  // One-click recovery for an accidental paste-over or clear: swaps the saved
  // key with the archived previous one (so restore itself is undoable).
  const restorePreviousStreamKey = useCallback(
    async (targetId: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const result = await client.request<StoreManualStreamKeyResult>(
          'streamTargets.manualKey.restorePrevious',
          { targetId }
        )
        patchManualStreamKeyResult(targetId, result)
        const label =
          captureConfigRef.current.streaming.targets.find((item) => item.id === targetId)?.label ??
          targetId
        toast.success(
          `${label} stream key restored${result.streamKeyHint ? ` (ends ${result.streamKeyHint})` : ''}.`
        )
      } catch (error) {
        reportError(error)
      }
    },
    [client, patchManualStreamKeyResult, reportError]
  )

  // Keys saved before hints existed (or by older builds) have streamKeyPresent
  // without a hint; hydrate those from the backend so the UI can say WHICH key
  // is stored. Cosmetic — failures stay silent.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    const pending = captureConfig.streaming.targets.filter(
      (target) => target.streamKeyPresent && target.streamKeyHint === undefined
    )
    if (pending.length === 0) {
      return
    }
    let cancelled = false
    void (async () => {
      for (const target of pending) {
        try {
          const result = await client.request<StoreManualStreamKeyResult>(
            'streamTargets.manualKey.inspect',
            { targetId: target.id }
          )
          if (cancelled) {
            return
          }
          patchManualStreamKeyResult(target.id, result)
        } catch {
          return
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, wsStatus, captureConfig.streaming.targets, patchManualStreamKeyResult])

  const canStart = !startBlockedReason
  const canStop =
    wsStatus === 'connected' &&
    ['recording', 'streaming', 'starting', 'stopping'].includes(recording.state) &&
    !stopRequestPending
  const visibleStartBlockedReason =
    startBlockedReason &&
    !lastError &&
    !isActiveRecordingState(recording.state) &&
    !startRequestPending &&
    !stopRequestPending
      ? startBlockedReason
      : null
  const selectedCaptureDevice = findDevice(
    deviceList.devices,
    captureConfig.sources.screenId ?? captureConfig.sources.windowId
  )
  const selectedCamera = findDevice(deviceList.devices, captureConfig.sources.cameraId)
  const selectedMicrophone = findDevice(deviceList.devices, captureConfig.sources.microphoneId)
  const setupSteps = setupChecklist({
    audioMeter,
    captureConfig,
    health,
    selectedCaptureDevice,
    selectedCamera,
    selectedMicrophone,
    streamReady,
    wsStatus
  })
  const elapsed = recording.startedAt ? durationLabel(recording.startedAt, now) : '00:00'
  const meterLevel = Math.round((audioMeter?.level ?? 0) * 100)
  const canSampleAudio = Boolean(wsStatus === 'connected' && selectedMicrophone && !isSessionActive)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableTargetSafe(event.target)) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        if (canStop) {
          void stopSession()
          return
        }
        if (canStart) {
          void startSession()
        }
        return
      }

      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        void refreshPreview()
      }

      if (sceneEditMode && selectedSceneSourceId && !isSessionActive) {
        const large = event.shiftKey
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 0, -1, large)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 0, 1, large)
          return
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, -1, 0, large)
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 1, 0, large)
          return
        }
        if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          void resetSceneSource(selectedSceneSourceId)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    canStart,
    canStop,
    isSessionActive,
    nudgeSceneSource,
    refreshPreview,
    resetSceneSource,
    sceneEditMode,
    selectedSceneSourceId,
    startSession,
    stopSession
  ])

  const value = useMemo<StudioContextValue>(
    () => ({
      connection,
      wsStatus,
      health,
      entitlements,
      deviceList,
      recording,
      logs,
      healthEvents,
      streamHealth,
      streamTargets,
      diagnosticStats,
      sessions,
      screens,
      activeScreen,
      platformAccounts,
      platformAccountValidations,
      oauthProviderCredentials,
      youtubeChannels,
      youtubeChannelsLoading,
      twitchCategories,
      twitchCategorySearchPending,
      xNativeCapability,
      xNativeCapabilityLoading,
      liveChatSnapshot,
      clearLiveChat,
      streamMetadataDraft,
      streamMetadataValidation,
      goLivePreflight,
      goLiveConfirmationOpen,
      goLiveConfirmationPending,
      goLivePartialSetup,
      previewUrl,
      previewLoading,
      previewLiveStatus,
      previewCameraStatus,
      previewScreenStatus,
      previewSurfaceStatus,
      nativePreviewSurfaceEnabled,
      previewWindow,
      openPreviewWindow,
      closePreviewWindow,
      setPreviewWindowAlwaysOnTop,
      scene,
      sceneEditMode,
      selectedSceneSourceId,
      setSceneEditMode,
      setSelectedSceneSourceId,
      audioMeter,
      audioMeterLoading,
      aiConsent,
      setAiConsent,
      aiRunningSessionId,
      exportRunningSessionId,
      startRequestPending,
      stopRequestPending,
      screenImportPending,
      streamMetadataSavePending,
      supportBundleExportPending,
      settings,
      setSettings,
      captureConfig,
      setCaptureConfig,
      patchLayout,
      patchVideo,
      applyVideoPreset,
      applyRtmpPreset,
      patchStreamingTarget,
      resolveGoLiveBlocker,
      saveManualStreamKey,
      restorePreviousStreamKey,
      patchStreamMetadataDraft,
      patchStreamTargetMetadataDraft,
      lastError,
      runtimeInfo,
      refreshBackend,
      refreshPlatformAccounts,
      validatePlatformAccounts,
      connectPlatformAccount,
      disconnectPlatformAccount,
      refreshYouTubeChannels,
      selectYouTubeChannel,
      searchTwitchCategories,
      refreshXNativeCapability,
      refreshStreamMetadata,
      saveStreamMetadataDraft,
      cancelGoLiveConfirmation,
      confirmGoLive,
      continueGoLiveWithReadyDestinations,
      refreshScreens,
      importScreenImage,
      renameScreen,
      deleteScreen,
      moveScreen,
      activateScreen,
      clearActiveScreen,
      refreshPreview,
      reloadSceneFromCaptureConfig,
      resetSceneSource,
      nudgeSceneSource,
      commitCameraTransform,
      applyCameraPreset,
      layoutSwitchPending,
      sourceDeviceSwitchPending,
      switchSourceDeviceLive,
      setSceneSourceVisible,
      moveSceneSource,
      openSystemPermission,
      openPreviewPermissions,
      revealPermissionTarget,
      exportSupportBundle,
      registerPreviewSurfaceResize,
      syncNativePreviewSurfaceBounds,
      sampleAudioMeter,
      startSession,
      stopSession,
      remuxSession,
      runAiWorkflow,
      exportPublishPack,
      assessRecording,
      repairRecording,
      restoreRecording,
      outputEnabled,
      streamReady,
      isSessionActive,
      startBlockedReason,
      canStart,
      canStop,
      visibleStartBlockedReason,
      selectedCaptureDevice,
      selectedCamera,
      selectedMicrophone,
      setupSteps,
      elapsed,
      meterLevel,
      canSampleAudio
    }),
    [
      connection,
      wsStatus,
      health,
      entitlements,
      deviceList,
      recording,
      logs,
      healthEvents,
      streamHealth,
      streamTargets,
      diagnosticStats,
      sessions,
      screens,
      activeScreen,
      platformAccounts,
      platformAccountValidations,
      oauthProviderCredentials,
      youtubeChannels,
      youtubeChannelsLoading,
      twitchCategories,
      twitchCategorySearchPending,
      xNativeCapability,
      xNativeCapabilityLoading,
      liveChatSnapshot,
      clearLiveChat,
      streamMetadataDraft,
      streamMetadataValidation,
      goLivePreflight,
      goLiveConfirmationOpen,
      goLiveConfirmationPending,
      goLivePartialSetup,
      previewUrl,
      previewLoading,
      previewLiveStatus,
      previewCameraStatus,
      previewScreenStatus,
      previewSurfaceStatus,
      nativePreviewSurfaceEnabled,
      previewWindow,
      openPreviewWindow,
      closePreviewWindow,
      setPreviewWindowAlwaysOnTop,
      scene,
      sceneEditMode,
      selectedSceneSourceId,
      setSceneEditMode,
      setSelectedSceneSourceId,
      audioMeter,
      audioMeterLoading,
      aiConsent,
      setAiConsent,
      aiRunningSessionId,
      exportRunningSessionId,
      startRequestPending,
      stopRequestPending,
      screenImportPending,
      streamMetadataSavePending,
      supportBundleExportPending,
      settings,
      setSettings,
      captureConfig,
      setCaptureConfig,
      patchLayout,
      patchVideo,
      applyVideoPreset,
      applyRtmpPreset,
      patchStreamingTarget,
      resolveGoLiveBlocker,
      saveManualStreamKey,
      restorePreviousStreamKey,
      patchStreamMetadataDraft,
      patchStreamTargetMetadataDraft,
      lastError,
      runtimeInfo,
      refreshBackend,
      refreshPlatformAccounts,
      validatePlatformAccounts,
      connectPlatformAccount,
      disconnectPlatformAccount,
      refreshYouTubeChannels,
      selectYouTubeChannel,
      searchTwitchCategories,
      refreshXNativeCapability,
      refreshStreamMetadata,
      saveStreamMetadataDraft,
      cancelGoLiveConfirmation,
      confirmGoLive,
      continueGoLiveWithReadyDestinations,
      refreshScreens,
      importScreenImage,
      renameScreen,
      deleteScreen,
      moveScreen,
      activateScreen,
      clearActiveScreen,
      refreshPreview,
      reloadSceneFromCaptureConfig,
      resetSceneSource,
      nudgeSceneSource,
      commitCameraTransform,
      applyCameraPreset,
      layoutSwitchPending,
      sourceDeviceSwitchPending,
      switchSourceDeviceLive,
      setSceneSourceVisible,
      moveSceneSource,
      openSystemPermission,
      openPreviewPermissions,
      revealPermissionTarget,
      exportSupportBundle,
      registerPreviewSurfaceResize,
      syncNativePreviewSurfaceBounds,
      sampleAudioMeter,
      startSession,
      stopSession,
      remuxSession,
      runAiWorkflow,
      exportPublishPack,
      assessRecording,
      repairRecording,
      restoreRecording,
      outputEnabled,
      streamReady,
      isSessionActive,
      startBlockedReason,
      canStart,
      canStop,
      visibleStartBlockedReason,
      selectedCaptureDevice,
      selectedCamera,
      selectedMicrophone,
      setupSteps,
      elapsed,
      meterLevel,
      canSampleAudio
    ]
  )

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

function isEditableTargetSafe(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'))
    : false
}

function mergePreviewSurfaceHostStatus(
  backendStatus: PreviewSurfaceStatus,
  hostStatus: PreviewSurfaceStatus
): PreviewSurfaceStatus {
  const hostLive = hostStatus.state === 'live'
  const hostTransport =
    hostStatus.transport !== 'unavailable' ? hostStatus.transport : backendStatus.transport
  const hostBacking = hostStatus.backing !== 'none' ? hostStatus.backing : backendStatus.backing

  if (!hostLive) {
    return {
      ...backendStatus,
      framesRendered: Math.max(backendStatus.framesRendered, hostStatus.framesRendered),
      message: backendStatus.message ?? hostStatus.message
    }
  }

  return {
    ...backendStatus,
    state: hostStatus.state,
    source: hostStatus.source,
    transport: hostTransport,
    backing: hostBacking,
    width: hostStatus.width > 0 ? hostStatus.width : backendStatus.width,
    height: hostStatus.height > 0 ? hostStatus.height : backendStatus.height,
    targetFps: hostStatus.targetFps > 0 ? hostStatus.targetFps : backendStatus.targetFps,
    framesRendered: Math.max(backendStatus.framesRendered, hostStatus.framesRendered),
    presentedFrameId: hostStatus.presentedFrameId ?? backendStatus.presentedFrameId,
    compositorFrameLag: hostStatus.compositorFrameLag ?? backendStatus.compositorFrameLag,
    droppedFrames: hostStatus.droppedFrames ?? backendStatus.droppedFrames,
    inputToPresentLatencyMs:
      hostStatus.inputToPresentLatencyMs ?? backendStatus.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms:
      hostStatus.inputToPresentLatencyP50Ms ?? backendStatus.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms:
      hostStatus.inputToPresentLatencyP95Ms ?? backendStatus.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms:
      hostStatus.inputToPresentLatencyP99Ms ?? backendStatus.inputToPresentLatencyP99Ms,
    presentFps: hostStatus.presentFps ?? backendStatus.presentFps,
    intervalP95Ms: hostStatus.intervalP95Ms ?? backendStatus.intervalP95Ms,
    intervalP99Ms: hostStatus.intervalP99Ms ?? backendStatus.intervalP99Ms,
    framePollingSuppressed:
      hostStatus.framePollingSuppressed || backendStatus.framePollingSuppressed,
    sourcePixelsPresent: hostStatus.sourcePixelsPresent || backendStatus.sourcePixelsPresent,
    pendingHostCommandCount: backendStatus.pendingHostCommandCount,
    bounds: hostStatus.bounds ?? backendStatus.bounds,
    startedAt: hostStatus.startedAt ?? backendStatus.startedAt,
    updatedAt: hostStatus.updatedAt,
    message: hostStatus.message ?? backendStatus.message
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
