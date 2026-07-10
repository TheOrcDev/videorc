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
  commentsRefreshRevisionIsCurrent,
  reconcileCommentsSendOperation
} from '../../../shared/comments-send-operation'
import { nativePreviewStatusProvesSceneRevision } from '../../../shared/native-preview-scene-authority'
import { cloudAiReadiness } from '@/lib/ai-readiness'
import {
  applyStoredManualStreamKeyResult,
  bridgeStreamingToLegacy,
  buildCameraSources,
  areEnabledStreamTargetsStartReady,
  defaultSettings,
  isPlatformOAuthAvailable,
  legacyStreamKeyMigrationCandidates,
  loadCaptureConfig,
  loadJson,
  isNativeScreenSourceId,
  isNativeWindowSourceId,
  patchPreparedStreamTarget,
  patchStreamTargetForEdit,
  persistableCaptureConfig,
  previewDeviceRefreshSignature,
  oauthUnavailableReason,
  preparedXActivationTargets,
  preparedXCompletionTargets,
  preparedYouTubeActivationTargets,
  preparedYouTubeCompletionTargets,
  readyStreamTargetLabels,
  reconcileSourceSelection,
  rtmpDefaults,
  smokePreviewCompositorCaptureConfig,
  sourceSelectionChangeEvents,
  STORAGE_KEYS,
  streamOutputVideoSettings,
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
import {
  isYouTubeChannelAuthFailure,
  shouldAutoRefreshYouTubeChannels
} from '@/lib/youtube-channels'
import {
  latestLayoutTransactionCommit,
  layoutTransactionBackendSnapshotIsStable,
  layoutTransactionFailureReconciliation,
  layoutTransactionProofDisposition,
  shouldReloadSceneFromCaptureConfig
} from '@/lib/layout-transaction-policy'
import {
  nativePreviewSurfaceSyncCanCommit,
  nativePreviewSurfaceSyncNeedsCreate
} from '@/lib/native-preview-surface-lifecycle'
import type {
  AiCapabilities,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsClearCommand,
  CommentsSendCommand,
  CommentsSendOperation,
  SessionStorageTotals,
  AiQuotaStatus,
  AiWorkflowResult,
  AutomaticSourceFallbackEvent,
  AudioMeterResult,
  BackendConnection,
  BackendHealth,
  BackendLogEvent,
  CommentsWindowState,
  CompositorStatus,
  DiagnosticStats,
  Device,
  DeviceList,
  EntitlementsSnapshot,
  MediaAccessSnapshot,
  ExportPublishPackResult,
  FileAssessment,
  EventsLaggedPayload,
  GateStatus,
  GoLivePreflight,
  HealthEvent,
  LayoutPreset,
  LayoutSettings,
  LiveLayoutApplyStatus,
  LiveChatMessage,
  LiveChatProviderState,
  CaptionsStatus,
  CaptionsUpdate,
  CaptionsWindowState,
  LiveChatSnapshot,
  NativePreviewHostCommand,
  NotesWindowState,
  PreviewCameraStatus,
  PreviewScreenStatus,
  PreviewSurfaceBounds,
  PreviewSurfacePresentParams,
  PreviewSurfaceStatus,
  PreviewSupervisorState,
  PreviewWindowMode,
  PreviewWindowState,
  PreviewLiveStatus,
  PlatformAccount,
  PlatformAccountValidation,
  PreparedXStreamSource,
  PreparedTwitchBroadcast,
  TwitchAppliedMetadata,
  PreparedYouTubeBroadcast,
  OAuthCompleteParams,
  OAuthStartResult,
  OAuthProviderCredentialStatus,
  RecordingStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SceneCommitStatus,
  SceneConfigParams,
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
  SupportBundleExportParams,
  SupportBundleExportResult,
  SystemPermissionPane,
  TwitchCategory,
  VideoPreset,
  VideoSettings,
  VideorcAccountSnapshot,
  XNativeLiveCapability,
  XEndResult,
  XLiveAuthorizationStart,
  XLiveChatStartParams,
  XPlaybackEvent,
  XPublishResult,
  YouTubeBroadcastTransitionResult,
  YouTubeChannel,
  YouTubeStreamStatusResult,
  ViewerSample
} from '@/lib/backend'
import { createEmptyLiveChatSnapshot } from '@/lib/backend'
import { renderCaptionCueFramePng, renderCaptionOverlayPng } from '@/lib/caption-overlay'
import { renderCommentHighlightPng } from '@/lib/caption-overlay'
import {
  appendCaptionLine,
  captionLineAboveFloor,
  captionSessionFloor,
  decideOverlayPush,
  type CaptionSessionFloor
} from '@/lib/captions-ui'
import { goLiveEntitlementGate, videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import {
  applyLiveChatMessages,
  applyLiveChatProviderStatus,
  applyLiveChatSnapshot,
  reconcileLiveChatRecovery
} from '@/lib/live-chat-view'
import {
  buildNativePreviewCompositorUpdateParams,
  compositorStatusHasRenderedSceneRevision,
  decideNativePreviewCompositorPresent,
  nativePreviewDroppedFramesWithSuppressed,
  nativePreviewSceneProofPresentationOwner,
  pendingCompositorStatusSupersedes,
  type NativePreviewRendererTimingFields
} from '@/lib/native-preview-present-policy'
import { isTransientBackendError, shouldToastBackendError } from '@/lib/backend-transport'
import {
  isPremiumUpgradeMessage,
  premiumRequiredIssueMessage,
  VIDEORC_PREMIUM_URL
} from '@/lib/premium-upgrade'
import { assertYouTubeTransitionConfirmed } from '@/lib/youtube-transition'
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
import {
  deviceListWithoutProtectedOverlayWindows,
  protectedOverlayWindowIdsFromOverlayWindows
} from '@/lib/protected-overlay-windows'

export type { GoLivePartialSetup, GoLiveSetupFailure } from '@/lib/go-live-flow'

function openPremiumUpgradePage(): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(VIDEORC_PREMIUM_URL)
    return
  }

  window.open(VIDEORC_PREMIUM_URL, '_blank', 'noopener,noreferrer')
}

function premiumUpgradeToastOptions(description?: string) {
  return {
    description,
    duration: 15000,
    action: {
      label: 'View Premium',
      onClick: openPremiumUpgradePage
    }
  }
}

function sourceFallbackActiveSessionMessage(state: RecordingStatus['state']): string {
  if (state === 'streaming') {
    return 'Source changed while streaming. Check the output before continuing.'
  }
  return 'Source changed while recording. Check the output before continuing.'
}

const NATIVE_PREVIEW_SURFACE_PRESENT_REPORT_INTERVAL_MS = 250
const WORKSPACE_NAVIGATE_EVENT = 'videorc:navigate-workspace'

function isRecordingQualityEvent(code: string): boolean {
  return code.startsWith('recording-quality-')
}

function openLibraryFromQualityToast(sessionId?: string): void {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_NAVIGATE_EVENT, {
      detail: { tab: 'library', sessionId: sessionId ?? null }
    })
  )
}

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
const NATIVE_PREVIEW_SCENE_FRAME_WAIT_TIMEOUT_MS = 750
const NATIVE_PREVIEW_SCENE_FRAME_WAIT_INTERVAL_MS = 33
const LIVE_LAYOUT_PROOF_WAIT_TIMEOUT_MS = 5000
const LIVE_LAYOUT_PROOF_WAIT_INTERVAL_MS = 100

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function waitForRenderedCompositorSceneRevision(
  activeClient: BackendClient,
  revision: number,
  initialStatus: CompositorStatus
): Promise<CompositorStatus> {
  if (compositorStatusHasRenderedSceneRevision(initialStatus, revision)) {
    return initialStatus
  }

  const deadline = Date.now() + NATIVE_PREVIEW_SCENE_FRAME_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(NATIVE_PREVIEW_SCENE_FRAME_WAIT_INTERVAL_MS)
    let latestStatus: CompositorStatus
    try {
      latestStatus = await activeClient.request<CompositorStatus>('compositor.status')
    } catch {
      return initialStatus
    }
    if (compositorStatusHasRenderedSceneRevision(latestStatus, revision)) {
      return latestStatus
    }
  }

  return initialStatus
}

async function waitForNativePreviewSurfaceSceneRevision(
  sceneRevision: number
): Promise<PreviewSurfaceStatus | null> {
  const readStatus = window.videorc?.getNativePreviewSurfaceStatus
  if (!readStatus) {
    return null
  }

  const deadline = Date.now() + NATIVE_PREVIEW_SCENE_FRAME_WAIT_TIMEOUT_MS
  let lastStatus: PreviewSurfaceStatus | null = null
  while (Date.now() < deadline) {
    try {
      lastStatus = await readStatus()
    } catch {
      return lastStatus
    }
    if (nativePreviewStatusProvesSceneRevision(lastStatus, sceneRevision)) {
      return lastStatus
    }
    await sleep(NATIVE_PREVIEW_SCENE_FRAME_WAIT_INTERVAL_MS)
  }
  return lastStatus
}

async function waitForLiveLayoutProof(
  activeClient: BackendClient,
  status: LiveLayoutApplyStatus
): Promise<CompositorStatus> {
  const deadline = Date.now() + LIVE_LAYOUT_PROOF_WAIT_TIMEOUT_MS
  let lastCompositorStatus: CompositorStatus | null = null
  let lastDiagnostics: DiagnosticStats | null = null
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const [compositorStatus, diagnostics] = await Promise.all([
        activeClient.request<CompositorStatus>('compositor.status'),
        activeClient.request<DiagnosticStats>('diagnostics.stats')
      ])
      lastCompositorStatus = compositorStatus
      lastDiagnostics = diagnostics
      if (
        compositorStatusHasRenderedSceneRevision(compositorStatus, status.sceneRevision) &&
        typeof diagnostics.activeSceneRevision === 'number' &&
        diagnostics.activeSceneRevision >= status.sceneRevision
      ) {
        return compositorStatus
      }
    } catch (error) {
      lastError = error
    }
    await sleep(LIVE_LAYOUT_PROOF_WAIT_INTERVAL_MS)
  }

  const renderedRevision =
    lastCompositorStatus?.frameSceneRevision == null
      ? 'none'
      : lastCompositorStatus.frameSceneRevision.toString()
  const activeRevision =
    lastDiagnostics?.activeSceneRevision == null
      ? 'none'
      : lastDiagnostics.activeSceneRevision.toString()
  const errorDetail =
    lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : ''
  throw new Error(
    `Live layout switch did not reach the active recording/streaming output within ${Math.round(
      LIVE_LAYOUT_PROOF_WAIT_TIMEOUT_MS / 1000
    )}s (target revision ${status.sceneRevision}, rendered revision ${renderedRevision}, active revision ${activeRevision}).${errorDetail}`
  )
}

type LayoutTransactionStatus = LiveLayoutApplyStatus & {
  intentId: number
  compositorStatus: CompositorStatus
  presentationProven: boolean
}

type LayoutTransactionSnapshot = {
  sceneRevision: number
  scene: Scene
  layout: LayoutSettings
  compositorStatus: CompositorStatus
}

async function waitForPreviewLayoutProof(
  activeClient: BackendClient,
  status: LayoutTransactionStatus
): Promise<CompositorStatus> {
  const initialStatus = status.compositorStatus
  if (compositorStatusHasRenderedSceneRevision(initialStatus, status.sceneRevision)) {
    return initialStatus
  }
  const renderedStatus = await waitForRenderedCompositorSceneRevision(
    activeClient,
    status.sceneRevision,
    initialStatus
  )
  if (compositorStatusHasRenderedSceneRevision(renderedStatus, status.sceneRevision)) {
    return renderedStatus
  }
  throw new Error(
    `Preview layout switch did not present committed revision ${status.sceneRevision} within the proof window.`
  )
}

export type StudioContextValue = {
  // connection + backend state
  connection: BackendConnection | null
  wsStatus: WsStatus
  health: BackendHealth | null
  entitlements: EntitlementsSnapshot | null
  account: VideorcAccountSnapshot | null
  aiCapabilities: AiCapabilities | null
  aiQuota: AiQuotaStatus | null
  aiReadinessError: string | null
  aiReadinessLoading: boolean
  signOutAccount: () => Promise<void>
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
  /** Live captions (premium cloud AI): status + transcript lines from captions.* events. */
  captionsStatus: CaptionsStatus
  captionLines: CaptionsUpdate[]
  startCaptions: () => Promise<void>
  stopCaptions: () => Promise<void>
  captionsWindow: CaptionsWindowState
  openCaptionsWindow: () => Promise<void>
  closeCaptionsWindow: () => Promise<void>
  toggleCaptionsWindow: () => Promise<void>
  commentsWindow: CommentsWindowState
  openCommentsWindow: () => Promise<void>
  closeCommentsWindow: () => Promise<void>
  toggleCommentsWindow: () => Promise<void>
  setCommentsWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>
  openSessionCommentsWindow: (sessionId: string, title: string, startedAt: string) => Promise<void>
  highlightedCommentId: string | null
  commentHighlightState: CommentHighlightState
  commentHighlightApplyingId: string | null
  commentHighlightFailure: { messageId: string; reason: string } | null
  toggleCommentHighlight: (message: LiveChatMessage) => void
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
  setPreviewWindowMode: (mode: PreviewWindowMode) => Promise<void>
  togglePreviewWindow: () => Promise<void>
  setPreviewWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>
  notesWindow: NotesWindowState
  openNotesWindow: () => Promise<void>
  closeNotesWindow: () => Promise<void>
  setNotesWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>
  scene: Scene | null
  sceneEditMode: boolean
  selectedSceneSourceId: string | null
  setSceneEditMode: Dispatch<SetStateAction<boolean>>
  setSelectedSceneSourceId: Dispatch<SetStateAction<string | null>>
  audioMeter: AudioMeterResult | null
  audioMeterLoading: boolean
  /** Real OS camera/mic access status (null before the first read). */
  mediaAccess: MediaAccessSnapshot | null
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
  applyLayoutPatch: (patch: Partial<LayoutSettings>) => void
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
  applyVideoPreset: (preset: VideoPreset, options?: { kind?: 'recording' | 'streaming' }) => void
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
  authorizeXLive: () => Promise<void>
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
  setSceneSourceTransform: (
    sourceId: string,
    patch: { x?: number; y?: number; width?: number; height?: number }
  ) => Promise<void>
  commitCameraTransform: (sourceId: string, x: number, y: number) => Promise<void>
  setSceneSourceVisible: (sourceId: string, visible: boolean) => Promise<void>
  moveSceneSource: (sourceId: string, direction: -1 | 1) => Promise<void>
  openSystemPermission: (pane: SystemPermissionPane) => Promise<void>
  openPreviewPermissions: () => Promise<void>
  revealPermissionTarget: () => Promise<void>
  exportSupportBundle: () => Promise<void>
  registerPreviewSurfaceResize: () => void
  syncNativePreviewSurfaceBounds: (
    bounds: PreviewSurfaceBounds,
    generation?: number
  ) => Promise<void>
  sampleAudioMeter: () => Promise<void>
  startSession: () => Promise<void>
  stopSession: () => Promise<void>
  remuxSession: (sessionId: string) => Promise<void>
  ensureSessionPoster: (sessionId: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSessions: (targets: SessionSummary[]) => Promise<void>
  duplicateSession: (sessionId: string) => Promise<void>
  importRecording: () => Promise<void>
  sessionStorageTotals: SessionStorageTotals | null
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
  encoderBridgeVideoToolboxFifoEnqueueP95Ms: undefined,
  encoderBridgeVideoToolboxFifoEnqueueMaxMs: undefined,
  encoderBridgeWriterLoopP95Ms: undefined,
  encoderBridgeWriterSleepP95Ms: undefined,
  encoderBridgeWriterActiveP95Ms: undefined,
  encoderBridgeDeadlineLagP95Ms: undefined,
  encoderBridgeDeadlineLagMaxMs: undefined,
  encoderBridgeLateDeadlineTicks: 0,
  encoderBridgeScheduleSkippedMs: 0,
  encoderBridgeRecordingInputFps: undefined,
  encoderBridgeStreamInputFps: undefined,
  encoderBridgeRecordingWriterLoopP95Ms: undefined,
  encoderBridgeStreamWriterLoopP95Ms: undefined,
  encoderBridgeRecordingWriterActiveP95Ms: undefined,
  encoderBridgeStreamWriterActiveP95Ms: undefined,
  encoderBridgeRecordingVideoToolboxFifoEnqueueP95Ms: undefined,
  encoderBridgeStreamVideoToolboxFifoEnqueueP95Ms: undefined,
  encoderBridgeRecordingVideoToolboxFifoEnqueueMaxMs: undefined,
  encoderBridgeStreamVideoToolboxFifoEnqueueMaxMs: undefined,
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

function selectedPreviewScreenDevice(
  sources: SourceSelection,
  devices: Device[]
): Device | undefined {
  const sourceId = sources.windowId ?? sources.screenId
  return sourceId ? devices.find((device) => device.id === sourceId) : undefined
}

function selectedPreviewScreenBlockedStatus(
  sources: SourceSelection,
  devices: Device[]
): PreviewScreenStatus | null {
  if (devices.length === 0) {
    return null
  }
  const sourceId = sources.windowId ?? sources.screenId
  if (!sourceId) {
    return null
  }

  const selectedDevice = selectedPreviewScreenDevice(sources, devices)
  const screenPermissionRequired = devices.some(
    (device) =>
      (device.kind === 'screen' || device.kind === 'window') &&
      device.status === 'permission-required'
  )
  const sourceKind = sources.windowId ? 'window' : 'screen'
  const base = {
    sourceId,
    sourceKind,
    targetFps: 0,
    framesCaptured: 0,
    droppedFrames: 0,
    includeCursor: true,
    excludeCurrentProcessWindows: false,
    updatedAt: new Date().toISOString()
  } satisfies Omit<PreviewScreenStatus, 'state' | 'message'>

  if (
    (sourceKind === 'screen' && !isNativeScreenSourceId(sourceId)) ||
    (sourceKind === 'window' && !isNativeWindowSourceId(sourceId))
  ) {
    return {
      ...base,
      state: 'source-missing',
      message: 'Native preview requires a Display or app window source.'
    }
  }

  if (
    selectedDevice?.status === 'permission-required' ||
    (!selectedDevice && screenPermissionRequired)
  ) {
    return {
      ...base,
      state: 'permission-needed',
      message: 'Screen Recording permission is required before this source can preview.'
    }
  }

  if (selectedDevice && selectedDevice.status !== 'available') {
    return {
      ...base,
      state: 'source-missing',
      message: selectedDevice.detail ?? 'Selected screen source is not available.'
    }
  }

  if (!selectedDevice) {
    return {
      ...base,
      state: 'source-missing',
      message: 'Selected screen source is no longer available.'
    }
  }

  return null
}

const idleNotesWindowState = (): NotesWindowState => ({
  open: false,
  visible: false,
  bounds: null,
  alwaysOnTop: false,
  protected: false,
  enabled: false,
  message: 'Notes window is disabled by VIDEORC_NOTES_WINDOW=0.'
})

const idleCommentsWindowState = (): CommentsWindowState => ({
  open: false,
  visible: false,
  bounds: null,
  alwaysOnTop: false,
  protected: false,
  enabled: false,
  message: 'Comments window is disabled by VIDEORC_COMMENTS_WINDOW=0.'
})

const idleCaptionsWindowState = (): CaptionsWindowState => ({
  open: false,
  visible: false,
  bounds: null,
  alwaysOnTop: false,
  enabled: false,
  message: 'Captions window is disabled by VIDEORC_CAPTIONS_WINDOW=0.'
})

const idlePreviewSupervisorState = (): PreviewSupervisorState => ({
  lifecycleState: 'closed',
  generation: 0,
  windowOpen: false,
  windowVisible: false,
  surfaceRequested: false,
  surfaceActive: false,
  transport: 'none',
  backing: 'none',
  permissionStatus: 'ok',
  updatedAt: new Date(0).toISOString()
})

async function currentProtectedOverlayWindowIds(): Promise<number[]> {
  const latestNotesWindow = await window.videorc?.getNotesWindowState?.().catch(() => null)
  const latestCommentsWindow = await window.videorc?.getCommentsWindowState?.().catch(() => null)
  const latestCaptionsWindow = await window.videorc?.getCaptionsWindowState?.().catch(() => null)
  return protectedOverlayWindowIdsFromOverlayWindows(
    latestNotesWindow ?? idleNotesWindowState(),
    latestCommentsWindow ?? idleCommentsWindowState(),
    latestCaptionsWindow ?? idleCaptionsWindowState()
  )
}

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
  const [account, setAccount] = useState<VideorcAccountSnapshot | null>(null)
  const [aiCapabilities, setAiCapabilities] = useState<AiCapabilities | null>(null)
  const [aiQuota, setAiQuota] = useState<AiQuotaStatus | null>(null)
  const [aiReadinessError, setAiReadinessError] = useState<string | null>(null)
  const [aiReadinessLoading, setAiReadinessLoading] = useState(false)
  const [deviceList, setDeviceList] = useState<DeviceList>({ devices: [], warnings: [] })
  const previewDevicesSignature = useMemo(
    () => previewDeviceRefreshSignature(deviceList.devices),
    [deviceList.devices]
  )
  const deviceListRef = useRef(deviceList)
  useEffect(() => {
    deviceListRef.current = deviceList
  }, [deviceList])
  const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  const [logs, setLogs] = useState<BackendLogEvent[]>([])
  const [healthEvents, setHealthEvents] = useState<HealthEvent[]>([])
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null)
  const [streamTargets, setStreamTargets] = useState<StreamTargetRuntime[]>([])
  const [diagnosticStats, setDiagnosticStats] = useState<DiagnosticStats>(idleDiagnosticStats)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionStorageTotals, setSessionStorageTotals] = useState<SessionStorageTotals | null>(
    null
  )
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
  // Read-only live chat store: persisted by the backend when available, live-updated by
  // liveChat.* websocket events, and mirrored to the detached Comments window cache.
  const [liveChatSnapshot, setLiveChatSnapshot] = useState<LiveChatSnapshot>(() =>
    createEmptyLiveChatSnapshot(new Date().toISOString())
  )
  const liveChatSnapshotRef = useRef(liveChatSnapshot)
  const liveChatStateRevisionRef = useRef(0)
  const liveChatReplacementRevisionRef = useRef(0)
  liveChatSnapshotRef.current = liveChatSnapshot
  const updateLiveChatSnapshot = useCallback((next: SetStateAction<LiveChatSnapshot>): void => {
    liveChatStateRevisionRef.current += 1
    setLiveChatSnapshot((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      liveChatSnapshotRef.current = resolved
      return resolved
    })
  }, [])
  const replaceLiveChatSnapshotState = useCallback(
    (next: LiveChatSnapshot): void => {
      liveChatReplacementRevisionRef.current += 1
      updateLiveChatSnapshot(next)
    },
    [updateLiveChatSnapshot]
  )
  const [latestLiveChatSendOperation, setLatestLiveChatSendOperation] = useState<
    CommentsSendOperation | undefined
  >()
  const applyLiveChatSendOperation = useCallback((operation: CommentsSendOperation): void => {
    setLatestLiveChatSendOperation((current) =>
      current?.sessionId === operation.sessionId
        ? reconcileCommentsSendOperation(current, operation)
        : operation
    )
  }, [])
  const clearLiveChat = useCallback(async () => {
    if (!client) return
    await client.request('liveChat.clearLocal')
  }, [client])
  // Live captions: status + transcript driven by captions.* events; the mic
  // audio itself never reaches the renderer (the Rust backend uploads chunks).
  const [captionsStatus, setCaptionsStatus] = useState<CaptionsStatus>({ state: 'idle' })
  const [captionLines, setCaptionLines] = useState<CaptionsUpdate[]>([])
  const captionLinesRef = useRef(captionLines)
  captionLinesRef.current = captionLines
  // Captions belong to the video they were spoken in: recorded at each
  // capture-session start (see the rising-edge effect below), this floor
  // rejects late transcripts of previous-video audio — the chunked uploader's
  // responses can land seconds after the next recording began, and the
  // capture-epoch filter only guards the .srt/burn chunks, not these events.
  const captionSessionFloorRef = useRef<CaptionSessionFloor | null>(null)
  const startCaptions = useCallback(async () => {
    // F-022: both failure shapes must THROW so the toggle's error handler can
    // toast — a missing client and a non-live status used to revert the switch
    // silently.
    if (!client) {
      throw new Error('Backend is not connected — try again in a moment.')
    }
    setCaptionLines([])
    const status = await client.request<CaptionsStatus>('captions.start')
    setCaptionsStatus(status)
    if (status.state !== 'live' && status.state !== 'degraded') {
      throw new Error(status.message ?? `Live captions did not start (status: ${status.state}).`)
    }
  }, [client])
  const stopCaptions = useCallback(async () => {
    if (!client) return
    const status = await client.request<CaptionsStatus>('captions.stop')
    setCaptionsStatus(status)
  }, [client])
  // Detached captions window: same relay-via-main pattern as Comments — the
  // caption-line buffer is pushed to main, which caches + forwards it.
  const [captionsWindow, setCaptionsWindow] = useState<CaptionsWindowState>(idleCaptionsWindowState)
  useEffect(() => {
    let cancelled = false
    const reconcile = async (): Promise<void> => {
      const fresh = await window.videorc?.getCaptionsWindowState?.()
      if (!fresh || cancelled) {
        return
      }
      setCaptionsWindow((current) =>
        JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
      )
    }
    void reconcile()
    const offState = window.videorc?.onCaptionsWindowState?.((state) => setCaptionsWindow(state))
    return () => {
      cancelled = true
      offState?.()
    }
  }, [])
  useEffect(() => {
    void window.videorc?.pushCaptionLines?.(captionLines)
  }, [captionLines])
  const openCaptionsWindow = useCallback(async () => {
    await window.videorc?.pushCaptionLines?.(captionLines).catch(() => {})
    await window.videorc?.openCaptionsWindow?.()
  }, [captionLines])
  const closeCaptionsWindow = useCallback(async () => {
    await window.videorc?.closeCaptionsWindow?.()
  }, [])
  const toggleCaptionsWindow = useCallback(async () => {
    if (captionsWindow.open) {
      await closeCaptionsWindow()
      return
    }
    await openCaptionsWindow()
  }, [captionsWindow.open, closeCaptionsWindow, openCaptionsWindow])
  const [commentsWindow, setCommentsWindow] = useState<CommentsWindowState>(idleCommentsWindowState)
  useEffect(() => {
    let cancelled = false
    const reconcile = async (): Promise<void> => {
      const fresh = await window.videorc?.getCommentsWindowState?.()
      if (!fresh || cancelled) {
        return
      }
      setCommentsWindow((current) =>
        JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
      )
    }
    void reconcile()
    const offState = window.videorc?.onCommentsWindowState?.((state) => setCommentsWindow(state))
    const offClear = window.videorc?.onCommentsClearRequest?.((command: CommentsClearCommand) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        if (liveChatSnapshotRef.current.sessionId !== command.sessionId) {
          throw new Error('That Comments view is no longer the active livestream.')
        }
        return client.request<LiveChatSnapshot>('liveChat.clearLocal')
      })()
        .then(async (snapshot) => {
          await window.videorc?.pushCommentsClearResult?.({
            requestId: command.requestId,
            ok: true,
            value: snapshot
          })
        })
        .catch(async (error) => {
          await window.videorc?.pushCommentsClearResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Could not clear Comments.'
          })
        })
    })
    return () => {
      cancelled = true
      offState?.()
      offClear?.()
    }
  }, [client])
  useEffect(() => {
    void window.videorc?.pushCommentsSnapshot?.({
      mode: { kind: 'live' },
      snapshot: liveChatSnapshot,
      latestSendOperation:
        latestLiveChatSendOperation?.sessionId === liveChatSnapshot.sessionId
          ? latestLiveChatSendOperation
          : undefined
    })
  }, [latestLiveChatSendOperation, liveChatSnapshot])
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)

  // Backend-authoritative comment highlight. The renderer owns only the
  // temporary rasterization phase; `On stream` comes from the backend state.
  const [commentHighlightState, setCommentHighlightState] = useState<CommentHighlightState>({
    generation: 0,
    phase: 'idle'
  })
  const commentHighlightIntentRef = useRef(0)
  const [commentHighlightApplyingId, setCommentHighlightApplyingId] = useState<string | null>(null)
  const [commentHighlightFailure, setCommentHighlightFailure] = useState<{
    messageId: string
    reason: string
  } | null>(null)
  useEffect(() => {
    if (!commentHighlightFailure) return
    const timer = window.setTimeout(() => setCommentHighlightFailure(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [commentHighlightFailure])
  const highlightedCommentId =
    commentHighlightState.phase === 'live' ? (commentHighlightState.messageId ?? null) : null

  const applyCommentHighlight = useCallback(
    async (
      message: LiveChatMessage,
      expectedSessionId: string | undefined,
      intent: number
    ): Promise<CommentHighlightState | null> => {
      if (!client) throw new Error('Backend socket is not connected.')
      const sessionId = expectedSessionId ?? liveChatSnapshot.sessionId
      if (!sessionId || message.sessionId !== sessionId) {
        throw new Error('That comment does not belong to the active livestream.')
      }
      setCommentHighlightApplyingId(message.id)
      try {
        if (
          commentHighlightState.phase === 'live' &&
          commentHighlightState.messageId === message.id
        ) {
          const cleared = await client.request<CommentHighlightState>('comments.highlight.clear')
          return commentHighlightIntentRef.current === intent ? cleared : null
        }
        const streamVideo = streamOutputVideoSettings(
          captureConfig.video,
          captureConfig.streamEnabled ? captureConfig.streaming : undefined
        )
        const avatarUrl = message.authorAvatarUrl
          ? await window.videorc?.cacheChatAvatar?.(message.authorAvatarUrl).catch(() => null)
          : null
        if (commentHighlightIntentRef.current !== intent) return null
        const pngBase64 = await renderCommentHighlightPng({
          authorName: message.authorName,
          text: message.messageText,
          avatarUrl: avatarUrl ?? null,
          canvasWidth: streamVideo.width,
          platform: message.platform
        })
        if (!pngBase64) throw new Error('Could not render this comment for the stream.')
        if (commentHighlightIntentRef.current !== intent) return null
        const state = await client.request<CommentHighlightState>('comments.highlight.set', {
          sessionId,
          messageId: message.id,
          pngBase64,
          position: 'top'
        })
        return commentHighlightIntentRef.current === intent ? state : null
      } finally {
        if (commentHighlightIntentRef.current === intent) {
          setCommentHighlightApplyingId(null)
        }
      }
    },
    [captureConfig, client, commentHighlightState, liveChatSnapshot.sessionId]
  )

  const publishCommentHighlightState = useCallback((state: CommentHighlightState): void => {
    setCommentHighlightState(state)
    void window.videorc?.pushCommentHighlightState?.(state)
  }, [])

  const toggleCommentHighlight = useCallback(
    (message: LiveChatMessage): void => {
      const intent = ++commentHighlightIntentRef.current
      setCommentHighlightFailure(null)
      void applyCommentHighlight(message, undefined, intent)
        .then((state) => {
          if (!state || commentHighlightIntentRef.current !== intent) return
          setCommentHighlightFailure(null)
          publishCommentHighlightState(state)
        })
        .catch(async (error) => {
          if (commentHighlightIntentRef.current !== intent) return
          setCommentHighlightFailure({
            messageId: message.id,
            reason: error instanceof Error ? error.message : 'Highlight failed.'
          })
          const authoritative = await client
            ?.request<CommentHighlightState>('comments.highlight.status')
            .catch(() => null)
          if (authoritative) publishCommentHighlightState(authoritative)
        })
    },
    [applyCommentHighlight, client, publishCommentHighlightState]
  )

  useEffect(() => {
    const off = window.videorc?.onCommentHighlightRequest?.((command: CommentHighlightCommand) => {
      const intent = ++commentHighlightIntentRef.current
      setCommentHighlightFailure(null)
      const message = liveChatSnapshot.messages.find(
        (candidate) =>
          candidate.id === command.messageId && candidate.sessionId === command.sessionId
      )
      void (
        message
          ? applyCommentHighlight(message, command.sessionId, intent)
          : Promise.reject(new Error('The selected live comment is no longer available.'))
      )
        .then(async (state) => {
          const resolvedState =
            state ??
            (await client
              ?.request<CommentHighlightState>('comments.highlight.status')
              .catch(() => null))
          if (!resolvedState) {
            throw new Error('A newer comment highlight replaced this request.')
          }
          if (state && commentHighlightIntentRef.current === intent) {
            publishCommentHighlightState(state)
          }
          await window.videorc?.pushCommentHighlightResult?.({
            requestId: command.requestId,
            ok: true,
            value: resolvedState
          })
        })
        .catch(async (error) => {
          if (commentHighlightIntentRef.current === intent) {
            setCommentHighlightFailure({
              messageId: command.messageId,
              reason: error instanceof Error ? error.message : 'Highlight failed.'
            })
          }
          const authoritative = await client
            ?.request<CommentHighlightState>('comments.highlight.status')
            .catch(() => null)
          if (authoritative && commentHighlightIntentRef.current === intent) {
            publishCommentHighlightState(authoritative)
          }
          await window.videorc?.pushCommentHighlightResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Highlight failed.'
          })
        })
    })
    return off
  }, [applyCommentHighlight, client, liveChatSnapshot.messages, publishCommentHighlightState])

  useEffect(() => {
    const off = window.videorc?.onChatSendRequest?.((command: CommentsSendCommand) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        return client.request<CommentsSendOperation>('liveChat.send', {
          operationId: command.operationId,
          sessionId: command.sessionId,
          text: command.text
        })
      })()
        .then(async (operation) => {
          await window.videorc?.pushChatSendResult?.({
            requestId: command.requestId,
            ok: true,
            value: operation
          })
        })
        .catch(async (error) => {
          await window.videorc?.pushChatSendResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Send failed.'
          })
        })
    })
    return off
  }, [client])

  const refreshLiveChatSnapshotForComments = useCallback(async (): Promise<void> => {
    if (!client) {
      return
    }
    const stateRevisionAtStart = liveChatStateRevisionRef.current
    const replacementRevisionAtStart = liveChatReplacementRevisionRef.current
    const snapshot = await client.request<LiveChatSnapshot>('liveChat.status')
    if (
      !commentsRefreshRevisionIsCurrent(
        replacementRevisionAtStart,
        liveChatReplacementRevisionRef.current
      )
    ) {
      return
    }
    const currentSnapshotAtCommit = liveChatSnapshotRef.current
    const stateChangedDuringStatus = !commentsRefreshRevisionIsCurrent(
      stateRevisionAtStart,
      liveChatStateRevisionRef.current
    )
    const next = reconcileLiveChatRecovery(
      snapshot,
      currentSnapshotAtCommit,
      stateChangedDuringStatus ? currentSnapshotAtCommit.messages : [],
      stateChangedDuringStatus
    )
    replaceLiveChatSnapshotState(next)
    const installedReplacementRevision = liveChatReplacementRevisionRef.current
    const operations = next.sessionId
      ? await client
          .request<CommentsSendOperation[]>('liveChat.sendOperations.list', {
            sessionId: next.sessionId
          })
          .catch(() => [])
      : []
    if (
      !commentsRefreshRevisionIsCurrent(
        installedReplacementRevision,
        liveChatReplacementRevisionRef.current
      )
    ) {
      return
    }
    const currentSnapshot = liveChatSnapshotRef.current
    if (currentSnapshot.sessionId !== next.sessionId) return
    const latestSendOperation = operations.at(-1)
    if (latestSendOperation) {
      applyLiveChatSendOperation(latestSendOperation)
    } else {
      setLatestLiveChatSendOperation(undefined)
    }
    await window.videorc?.pushCommentsSnapshot?.({
      mode: { kind: 'live' },
      snapshot: currentSnapshot,
      latestSendOperation
    })
  }, [applyLiveChatSendOperation, client, replaceLiveChatSnapshotState])
  const openCommentsWindow = useCallback(async () => {
    await refreshLiveChatSnapshotForComments().catch(() => {})
    await window.videorc?.setCommentsViewMode?.({ kind: 'live' })
    await window.videorc?.openCommentsWindow?.()
    await refreshLiveChatSnapshotForComments().catch(() => {})
  }, [refreshLiveChatSnapshotForComments])
  const closeCommentsWindow = useCallback(async () => {
    await window.videorc?.closeCommentsWindow?.()
  }, [])
  const toggleCommentsWindow = useCallback(async () => {
    await refreshLiveChatSnapshotForComments().catch(() => {})
    await window.videorc?.setCommentsViewMode?.({ kind: 'live' })
    await window.videorc?.toggleCommentsWindow?.()
    await refreshLiveChatSnapshotForComments().catch(() => {})
  }, [refreshLiveChatSnapshotForComments])
  const setCommentsWindowAlwaysOnTop = useCallback(async (alwaysOnTop: boolean) => {
    await window.videorc?.setCommentsWindowAlwaysOnTop?.(alwaysOnTop)
  }, [])
  const openSessionCommentsWindow = useCallback(
    async (sessionId: string, title: string, startedAt: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return
      }
      try {
        const messages = await client.request<LiveChatMessage[]>('sessions.comments.list', {
          sessionId
        })
        const snapshot = applyLiveChatSnapshot({
          sessionId,
          providers: [],
          messages,
          unreadCount: messages.length,
          updatedAt: new Date().toISOString()
        })
        const operations = await client
          .request<CommentsSendOperation[]>('liveChat.sendOperations.list', { sessionId })
          .catch(() => [])
        await window.videorc?.pushCommentsSnapshot?.({
          mode: { kind: 'history', sessionId, title, startedAt },
          snapshot,
          latestSendOperation: operations.at(-1)
        })
        await window.videorc?.setCommentsViewMode?.({
          kind: 'history',
          sessionId,
          title,
          startedAt
        })
        await window.videorc?.openCommentsWindow?.()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not open saved comments.'
        toast.error(message)
      }
    },
    [client]
  )
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
  // The OS's real camera/mic access state (Electron getMediaAccessStatus).
  // On Windows this is what makes the permission chips truthful — the audio
  // meter has no capture backend there, so it can't report mic permission.
  const [mediaAccess, setMediaAccess] = useState<MediaAccessSnapshot | null>(null)
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
  // Stable handle for callbacks that only need to READ the config (labels,
  // lookups) without re-creating themselves on every config change.
  const lastRecordingStateRef = useRef<string | null>(null)
  // Quality-gate toast dedupe: the gate can re-emit an updated not-100 verdict for
  // the same session (fast assessment, then post-repair); one toast is enough.
  const qualityToastSessionsRef = useRef<Set<string>>(new Set())
  const captureConfigRef = useRef(captureConfig)
  const layoutIntentIdRef = useRef(Date.now())
  const layoutIntentAwaitingProofRef = useRef<number | null>(null)
  const latestLayoutTransactionCommitRef = useRef<LayoutTransactionSnapshot | null>(null)
  const skipNextConfigSceneReloadRef = useRef(false)
  useEffect(() => {
    captureConfigRef.current = captureConfig
  }, [captureConfig])
  useEffect(() => {
    latestLayoutTransactionCommitRef.current = null
  }, [client])
  // Smoke-only: isolated smoke profiles persist no camera selection, so
  // camera-dependent layout presets would always be disabled under gates.
  // DEV-gated like the synthetic-source toggle; driven by the
  // select-camera-device smoke command.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }
    const smokeWindow = window as Window & {
      __videorcSmokeSelectFirstCamera?: () => string | null
      __videorcSmokeSelectFirstScreen?: () => { id: string; kind: 'screen' | 'window' } | null
    }
    smokeWindow.__videorcSmokeSelectFirstCamera = (): string | null => {
      const camera = deviceList.devices.find(
        (device) => device.kind === 'camera' && device.status === 'available'
      )
      if (!camera) {
        return null
      }
      setCaptureConfig((current) => ({
        ...current,
        sources: buildCameraSources(current.sources, [camera], camera.id)
      }))
      return camera.id
    }
    smokeWindow.__videorcSmokeSelectFirstScreen = () => {
      const source = deviceList.devices.find(
        (device) =>
          (device.kind === 'screen' || device.kind === 'window') &&
          device.status === 'available' &&
          device.id.includes('screencapturekit')
      )
      if (!source || (source.kind !== 'screen' && source.kind !== 'window')) {
        return null
      }
      setCaptureConfig((current) => ({
        ...current,
        sources: {
          ...current.sources,
          screenId: source.kind === 'screen' ? source.id : undefined,
          screenName: source.kind === 'screen' ? source.name : undefined,
          windowId: source.kind === 'window' ? source.id : undefined,
          windowName: source.kind === 'window' ? source.name : undefined,
          testPattern: false
        }
      }))
      return { id: source.id, kind: source.kind }
    }
    return () => {
      delete smokeWindow.__videorcSmokeSelectFirstCamera
      delete smokeWindow.__videorcSmokeSelectFirstScreen
    }
  }, [deviceList])
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
  const nativePreviewFramePollingSuppressionRequestedRef = useRef<boolean | null>(null)
  const nativePreviewCameraKeyRef = useRef<string | null>(null)
  const nativePreviewScreenKeyRef = useRef<string | null>(null)
  const nativePreviewCommittedSceneRef = useRef<{
    sceneId: string
    sceneRevision: number
    compositorStatus: CompositorStatus
  } | null>(null)
  const nativePreviewSurfaceBoundsPendingRef = useRef<PreviewSurfaceBounds | null>(null)
  const nativePreviewSurfaceBoundsPendingGenerationRef = useRef<number | undefined>(undefined)
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
  const automaticSourceFallbacks = useRef<AutomaticSourceFallbackEvent[]>([])
  const toastedFailedTargets = useRef<Set<string>>(new Set())
  const platformLifecycleRun = useRef(0)
  // One-shot playback toasts per broadcast+status (probe events may repeat).
  const xPlaybackToastsRef = useRef(new Set<string>())
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
  const activeSceneBackground = useMemo(
    () => effectiveSceneBackground(backgroundRegistry) ?? undefined,
    [backgroundRegistry]
  )
  // Overlay the active background from the shared registry onto the scene so both
  // the session and the native preview carry it; the registry is the source of
  // truth (A5). Resolves to no background when nothing usable is selected.
  const sceneWithBackground = useMemo<Scene | null>(
    () => (scene ? { ...scene, background: activeSceneBackground } : null),
    [scene, activeSceneBackground]
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
    // Always keep the diagnostic record, even for suppressed transients.
    setLastError(message)
    if (isPremiumUpgradeMessage(message)) {
      toast.error(message, premiumUpgradeToastOptions())
      return
    }
    // S1 (plan 024): a permission grant restarts the backend; the requests that
    // fan out into the ~1s reconnect window reject with the transient transport
    // strings. The Session badge already narrates "Connecting…"/"Backend
    // offline", so suppress those toasts entirely while not connected instead of
    // stacking a wall of red. A transport blip WHILE connected still surfaces —
    // once, via a keyed id so it can never stack.
    if (!shouldToastBackendError(message, wsStatusRef.current)) {
      return
    }
    if (isTransientBackendError(message)) {
      toast.error(message, { id: 'backend-transport' })
      return
    }
    toast.error(message)
  }, [])

  const refreshAiReadinessForClient = useCallback(
    async (activeClient: BackendClient | null, accountSnapshot: VideorcAccountSnapshot | null) => {
      if (!activeClient || accountSnapshot?.status !== 'signed-in') {
        setAiCapabilities(null)
        setAiQuota(null)
        setAiReadinessError(null)
        setAiReadinessLoading(false)
        return
      }

      setAiReadinessLoading(true)
      try {
        const [nextCapabilities, nextQuota] = await Promise.all([
          activeClient.request<AiCapabilities>('ai.capabilities.get'),
          activeClient.request<AiQuotaStatus>('ai.quota.get')
        ])
        setAiCapabilities(nextCapabilities)
        setAiQuota(nextQuota)
        setAiReadinessError(null)
      } catch (error) {
        setAiCapabilities(null)
        setAiQuota(null)
        setAiReadinessError(error instanceof Error ? error.message : String(error))
      } finally {
        setAiReadinessLoading(false)
      }
    },
    []
  )

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

  const applyCommittedScene = useCallback(
    (status: SceneCommitStatus) => {
      nativePreviewCommittedSceneRef.current = {
        sceneId: status.scene.id,
        sceneRevision: status.sceneRevision,
        compositorStatus: status.compositorStatus
      }
      applyScene(status.scene)
    },
    [applyScene]
  )

  const refreshSessions = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const [nextSessions, nextTotals] = await Promise.all([
      activeClient.request<SessionSummary[]>('sessions.list', { limit: 200 }),
      activeClient.request<SessionStorageTotals>('sessions.storage')
    ])
    setSessions(nextSessions)
    setSessionStorageTotals(nextTotals)
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
    async (accountId?: string, options: { background?: boolean } = {}) => {
      const unavailable = oauthUnavailableReason('youtube')
      if (unavailable) {
        setYoutubeChannels([])
        if (!options.background) {
          toast.warning(unavailable)
        }
        return
      }
      if (!client) {
        setYoutubeChannels([])
        return
      }

      try {
        if (!options.background) {
          setLastError(null)
        }
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
        if (options.background && isYouTubeChannelAuthFailure(error)) {
          return
        }
        reportError(error)
      } finally {
        setYoutubeChannelsLoading(false)
      }
    },
    [client, reportError]
  )

  const selectYouTubeChannel = useCallback(
    async (channelId: string, accountId?: string) => {
      const unavailable = oauthUnavailableReason('youtube')
      if (unavailable) {
        toast.warning(unavailable)
        return
      }
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
    if (
      !isPlatformOAuthAvailable('youtube') ||
      !account ||
      !shouldAutoRefreshYouTubeChannels(account, platformAccountValidations)
    ) {
      setYoutubeChannels([])
      return
    }
    void refreshYouTubeChannels(account.accountId, { background: true })
  }, [platformAccountValidations, platformAccounts, refreshYouTubeChannels])

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

  const authorizeXLive = useCallback(async () => {
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
      const result = await client.request<XLiveAuthorizationStart>(
        'streamTargets.x.startLiveAuthorization',
        {}
      )
      await window.videorc.openOAuthUrl(result.authUrl)
      toast.success('Approve Videorc on x.com to enable X Live.')
    } catch (error) {
      reportError(error)
    }
  }, [client, reportError, wsStatus])

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
    // F-014: surface backend crashes instead of zombie-ing with a Ready badge.
    const offLifecycle = window.videorc.onBackendLifecycle?.((event) => {
      if (event.state === 'restarting') {
        toast.warning('Backend crashed', {
          id: 'backend-lifecycle',
          description: `Restarting automatically (attempt ${event.attempt ?? 1})…`
        })
      } else if (event.state === 'failed') {
        toast.error('Backend crashed repeatedly', {
          id: 'backend-lifecycle',
          description: 'Automatic restarts stopped. Restart Videorc to recover.',
          duration: Infinity
        })
      } else if (event.state === 'running') {
        toast.dismiss('backend-lifecycle')
      }
    })

    return () => {
      disposed = true
      offConnection()
      offLog()
      offLifecycle?.()
    }
  }, [appendLog])

  useEffect(() => {
    setCaptureConfig((current) => {
      const nextSources = reconcileSourceSelection(current.sources, deviceList.devices)

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      const fallbackEvents = sourceSelectionChangeEvents(current.sources, nextSources)
      if (fallbackEvents.length > 0) {
        const occurredAt = new Date().toISOString()
        const sessionState = recordingRef.current.state
        const enrichedEvents = fallbackEvents.map((event) => ({
          ...event,
          occurredAt,
          sessionState
        }))
        automaticSourceFallbacks.current = [
          ...automaticSourceFallbacks.current,
          ...enrichedEvents
        ].slice(-50)

        if (isActiveRecordingState(sessionState)) {
          toast.warning(sourceFallbackActiveSessionMessage(sessionState), {
            duration: 10_000,
            id: 'source-reconciliation:active-session'
          })
        }
      }
      return { ...current, sources: nextSources }
    })
  }, [deviceList])

  useEffect(() => {
    if (!connection) {
      return
    }

    const nextClient = new BackendClient(connection)
    let disposed = false
    let queuedLiveChatMessages: LiveChatMessage[] = []
    let liveChatFlushTimer: number | null = null
    let liveChatRecovery: Promise<void> | null = null
    let commentHighlightRevision = 0

    const flushLiveChatMessages = (): void => {
      liveChatFlushTimer = null
      if (disposed || liveChatRecovery || queuedLiveChatMessages.length === 0) {
        return
      }
      const messages = queuedLiveChatMessages
      queuedLiveChatMessages = []
      updateLiveChatSnapshot((current) => applyLiveChatMessages(current, messages))
    }
    const scheduleLiveChatFlush = (): void => {
      if (disposed || liveChatFlushTimer !== null || queuedLiveChatMessages.length === 0) {
        return
      }
      // WebSocket messages arrive as separate browser tasks, so a microtask
      // flush still produces one React update per comment. One short frame
      // window coalesces bursts while keeping live interaction responsive.
      liveChatFlushTimer = window.setTimeout(flushLiveChatMessages, 16)
    }
    const queueLiveChatMessage = (message: LiveChatMessage): void => {
      queuedLiveChatMessages.push(message)
      scheduleLiveChatFlush()
    }
    const replaceLiveChatSnapshot = (snapshot: LiveChatSnapshot): void => {
      queuedLiveChatMessages = []
      replaceLiveChatSnapshotState(applyLiveChatSnapshot(snapshot))
    }
    const recoverLiveChatSnapshot = (): Promise<void> => {
      if (disposed) {
        return Promise.resolve()
      }
      if (liveChatRecovery) {
        return liveChatRecovery
      }
      liveChatRecovery = (async () => {
        const stateRevisionAtStart = liveChatStateRevisionRef.current
        const replacementRevisionAtStart = liveChatReplacementRevisionRef.current
        const highlightRevisionAtStart = commentHighlightRevision
        try {
          const [snapshot, highlight] = await Promise.all([
            nextClient.request<LiveChatSnapshot>('liveChat.status'),
            nextClient.request<CommentHighlightState>('comments.highlight.status').catch(() => null)
          ])
          const operations = snapshot.sessionId
            ? await nextClient
                .request<CommentsSendOperation[]>('liveChat.sendOperations.list', {
                  sessionId: snapshot.sessionId
                })
                .catch(() => [])
            : []
          if (disposed) {
            return
          }
          // A full snapshot/clear that lands after the RPC started is newer and
          // must win wholesale. Provider-only updates can coexist with recovery:
          // retain their rows while restoring authoritative missed messages.
          if (
            commentsRefreshRevisionIsCurrent(
              replacementRevisionAtStart,
              liveChatReplacementRevisionRef.current
            )
          ) {
            const messagesAfterSnapshot = queuedLiveChatMessages
            queuedLiveChatMessages = []
            replaceLiveChatSnapshotState(
              reconcileLiveChatRecovery(
                snapshot,
                liveChatSnapshotRef.current,
                messagesAfterSnapshot,
                !commentsRefreshRevisionIsCurrent(
                  stateRevisionAtStart,
                  liveChatStateRevisionRef.current
                )
              )
            )
            const latestSendOperation = operations.at(-1)
            if (latestSendOperation) {
              applyLiveChatSendOperation(latestSendOperation)
            } else {
              setLatestLiveChatSendOperation(undefined)
            }
          }
          if (highlight && commentHighlightRevision === highlightRevisionAtStart) {
            setCommentHighlightState(highlight)
            setCommentHighlightApplyingId(null)
            void window.videorc?.pushCommentHighlightState?.(highlight)
          }
        } finally {
          liveChatRecovery = null
          scheduleLiveChatFlush()
        }
      })()
      return liveChatRecovery
    }
    setClient(nextClient)
    setWsStatus('connecting')
    setLastError(null)

    const unsubscribers = [
      nextClient.on('backend.ready', () => setWsStatus('connected')),
      nextClient.on('devices.changed', (payload) => setDeviceList(payload as DeviceList)),
      nextClient.on('recording.status', (payload) => {
        const status = payload as RecordingStatus
        const previousState = lastRecordingStateRef.current
        lastRecordingStateRef.current = status.state
        applyRecordingStatus(status)
        if (['idle', 'failed'].includes(status.state)) {
          setStreamTargets([])
          void refreshSessions(nextClient)
          // Session over: the viewer chip must clear, not freeze (rider V2).
          void window.videorc?.pushViewerSample?.(null)
        }
        // Capture started: pull the fresh 'running' row so the Library shows
        // the live session immediately (status ticks repeat the state, so
        // only refresh on the transition).
        if (
          ['recording', 'streaming'].includes(status.state) &&
          !['recording', 'streaming'].includes(previousState ?? '')
        ) {
          void refreshSessions(nextClient)
        }
        // D6: the moment a recording lands is the moment to publish it.
        if (
          status.state === 'idle' &&
          ['recording', 'streaming', 'stopping'].includes(previousState ?? '')
        ) {
          toast.success('Recording saved', {
            description: 'Turn it into a publishable upload?',
            action: {
              label: 'Make it publishable',
              onClick: () => window.dispatchEvent(new CustomEvent('videorc:open-publish'))
            },
            duration: 12000
          })
        }
      }),
      // Viewer rider V2: relay the latest concurrent-viewer sample to the
      // Comments window (main-process cache + push, same shape as highlight).
      nextClient.on('stream.viewers', (payload) => {
        void window.videorc?.pushViewerSample?.(payload as ViewerSample)
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
        if (isRecordingQualityEvent(event.code)) {
          void refreshSessions(nextClient)
        }
        // Quality-gate toast policy: only interrupt for verdicts the user would
        // notice and can act on — the backend marks those warn-level (e.g. a
        // missing stream). Analyzer residuals and internal check/repair failures
        // arrive info-level and live in the Library row + Diagnostics instead.
        if (event.code === 'recording-quality-not-100' && event.level === 'warn') {
          const dedupeKey = event.sessionId ?? event.message
          if (!qualityToastSessionsRef.current.has(dedupeKey)) {
            qualityToastSessionsRef.current.add(dedupeKey)
            toast.warning('Recording is not 100%', {
              description: event.message,
              duration: 15000,
              action: {
                label: 'Open Library',
                onClick: () => openLibraryFromQualityToast(event.sessionId)
              }
            })
          }
        } else if (event.code === 'mic-silent') {
          // Plan 021 F3: the user must hear about a silent mic from the app,
          // not from playing the file back. Warn = mid-session (stopping and
          // fixing still saves the take); error = finalize verdict.
          if (event.level === 'error') {
            toast.error('Recording has no sound', {
              description: event.message,
              duration: 15000
            })
          } else {
            toast.warning('Microphone is silent', {
              description: event.message,
              duration: 15000
            })
          }
        }
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
        if (layoutIntentAwaitingProofRef.current !== null) {
          return
        }
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
      nextClient.on('liveChat.snapshot', (payload) => {
        replaceLiveChatSnapshot(payload as LiveChatSnapshot)
      }),
      nextClient.on('liveChat.message', (payload) =>
        queueLiveChatMessage(payload as LiveChatMessage)
      ),
      nextClient.on('liveChat.providerStatus', (payload) => {
        updateLiveChatSnapshot((current) =>
          applyLiveChatProviderStatus(current, payload as LiveChatProviderState)
        )
      }),
      nextClient.on('liveChat.cleared', (payload) => {
        replaceLiveChatSnapshot(payload as LiveChatSnapshot)
      }),
      nextClient.on('liveChat.sendOperation', (payload) => {
        const operation = payload as CommentsSendOperation
        if (operation.sessionId === liveChatSnapshotRef.current.sessionId) {
          applyLiveChatSendOperation(operation)
        }
      }),
      nextClient.on('comments.highlight.status', (payload) => {
        commentHighlightRevision += 1
        const status = payload as CommentHighlightState
        setCommentHighlightState(status)
        setCommentHighlightApplyingId(null)
        void window.videorc?.pushCommentHighlightState?.(status)
      }),
      nextClient.on('events.lagged', (payload) => {
        const lagged = payload as EventsLaggedPayload
        if (lagged.skipped < 1) {
          return
        }
        void recoverLiveChatSnapshot().catch((error: unknown) => {
          if (!disposed) {
            reportError(error)
          }
        })
      }),
      nextClient.on('captions.status', (payload) => setCaptionsStatus(payload as CaptionsStatus)),
      nextClient.on('captions.update', (payload) =>
        setCaptionLines((current) =>
          captionLineAboveFloor(payload as CaptionsUpdate, captionSessionFloorRef.current)
            ? appendCaptionLine(current, payload as CaptionsUpdate)
            : current
        )
      ),
      // Burned-copy cue frames (R2): the backend asks for one full-frame PNG
      // per cue at finalize; render + submit sequentially, best-effort (the
      // backend watchdog degrades to SRT-only if we never finish).
      nextClient.on('captions.cues.render-request', (payload) => {
        const request = payload as {
          requestId: string
          canvasWidth: number
          canvasHeight: number
          position: 'top' | 'bottom'
          textSize: 's' | 'm' | 'l'
          blankSeq: number
          cues: { seq: number; text: string }[]
        }
        void (async () => {
          const jobs = [{ seq: request.blankSeq, text: '' }, ...request.cues]
          for (const cue of jobs) {
            try {
              const pngBase64 = await renderCaptionCueFramePng({
                text: cue.text,
                canvasWidth: request.canvasWidth,
                canvasHeight: request.canvasHeight,
                position: request.position,
                textSize: request.textSize
              })
              if (!pngBase64) {
                continue
              }
              await nextClient.request('captions.cues.submit', {
                requestId: request.requestId,
                seq: cue.seq,
                pngBase64
              })
            } catch {
              // Skip this cue; the backend watchdog handles incompleteness.
            }
          }
        })()
      }),
      nextClient.on('streamTargets.metadata.changed', (payload) => {
        const draft = payload as StreamMetadataDraft
        setStreamMetadataDraft(draft)
        void nextClient
          .request<StreamMetadataValidation>('streamTargets.metadata.validate', draft)
          .then(setStreamMetadataValidation)
      }),
      nextClient.on('platformAccounts.oauth.callback', (payload) => {
        const result = payload as {
          platform?: string
          status?: string
          message?: string
          accountConnected?: boolean
          tokenStored?: boolean
        }
        if (result.status === 'success' && result.accountConnected) {
          void refreshPlatformAccountsForClient(nextClient)
          void validatePlatformAccountsForClient(nextClient)
          toast.success('Account connected.')
        } else if (result.status === 'success' && result.platform === 'x' && result.tokenStored) {
          // Authorize X Live (OAuth 1.0a) landed a token in the secret store;
          // re-check the capability so Ready appears without a manual refresh.
          toast.success(result.message ?? 'X live authorization complete.')
          void nextClient
            .request<XNativeLiveCapability>('streamTargets.x.capability', {})
            .then(setXNativeCapability)
            .catch(() => undefined)
        } else if (result.status === 'success') {
          toast.success('OAuth callback received.')
        } else {
          toast.error('OAuth callback failed.', {
            description: result.message ?? result.status ?? 'Connection could not be completed.'
          })
        }
      }),
      nextClient.on('streamTargets.x.playback', (payload) => {
        const event = payload as XPlaybackEvent
        // One toast per broadcast+status; the probe may re-emit while polling.
        const toastKey = `${event.broadcastId}:${event.status}`
        const alreadyToasted = xPlaybackToastsRef.current.has(toastKey)
        xPlaybackToastsRef.current.add(toastKey)
        const patch =
          event.status === 'verified'
            ? {
                state: 'live' as const,
                message: `Viewers can watch your X broadcast: ${event.shareUrl}`,
                redactedUrl: event.shareUrl
              }
            : event.status === 'pending'
              ? {
                  state: 'warning' as const,
                  message:
                    'X is still provisioning playback — viewers may see a loading spinner. Keep streaming; this can take a few minutes.',
                  redactedUrl: event.shareUrl
                }
              : {
                  state: 'warning' as const,
                  message:
                    'X never produced playback for this broadcast — viewers saw a loading spinner. Your local recording is unaffected.',
                  redactedUrl: event.shareUrl
                }
        setCaptureConfig((current) => {
          const target = current.streaming.targets.find(
            (candidate) =>
              candidate.platform === 'x' && candidate.enabled && candidate.authMode === 'oauth'
          )
          if (!target) {
            return current
          }
          return bridgeStreamingToLegacy({
            ...current,
            streaming: patchPreparedStreamTarget(current.streaming, target.id, { status: patch })
          })
        })
        if (!alreadyToasted) {
          if (event.status === 'verified') {
            toast.success('Viewers can watch your X broadcast.', {
              description: event.shareUrl
            })
          } else if (event.status === 'pending') {
            toast.warning('X is still provisioning playback.', {
              description:
                'Viewers may see a loading spinner for a few minutes. Keep streaming — Videorc keeps checking.'
            })
          } else {
            toast.error('X never produced playback for this broadcast.', {
              description:
                'Viewers saw a loading spinner. Your local recording is unaffected; the next Go Live uses a replacement source if this repeats.'
            })
          }
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
        const nextAccount = await nextClient.request<VideorcAccountSnapshot>('account.get')
        setAccount(nextAccount)
        await refreshAiReadinessForClient(nextClient, nextAccount)
        const nextDevices = await nextClient.request<DeviceList>('devices.list', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        setDeviceList(nextDevices)
        const nextRecording = await nextClient.request<RecordingStatus>('recording.status')
        applyRecordingStatus(nextRecording)
        const nextDiagnostics = await nextClient.request<DiagnosticStats>('diagnostics.stats')
        setDiagnosticStats(nextDiagnostics)
        // A new WebSocket may follow a backend restart or an app-side reconnect. Always
        // replace incremental chat belief from the persisted coordinator snapshot.
        await recoverLiveChatSnapshot()
        const nextCommentHighlight = await nextClient.request<CommentHighlightState>(
          'comments.highlight.status'
        )
        setCommentHighlightState(nextCommentHighlight)
        await window.videorc?.pushCommentHighlightState?.(nextCommentHighlight)
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
          const nextCompositorStatus =
            await nextClient.request<CompositorStatus>('compositor.status')
          if (typeof nextCompositorStatus.sceneRevision === 'number') {
            nativePreviewCommittedSceneRef.current = {
              sceneId: nextScene.id,
              sceneRevision: nextCompositorStatus.sceneRevision,
              compositorStatus: nextCompositorStatus
            }
          }
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
      disposed = true
      queuedLiveChatMessages = []
      if (liveChatFlushTimer !== null) {
        window.clearTimeout(liveChatFlushTimer)
        liveChatFlushTimer = null
      }
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
      nativePreviewSurfaceBoundsPendingGenerationRef.current = undefined
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
      setAccount(null)
      setAiCapabilities(null)
      setAiQuota(null)
      setAiReadinessError(null)
      setAiReadinessLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appendLog,
    applyLiveChatSendOperation,
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
    replaceLiveChatSnapshotState,
    updateLiveChatSnapshot,
    refreshAiReadinessForClient,
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

      const params: SceneConfigParams = {
        ...config,
        background: activeSceneBackground
      }
      const status = await client.request<SceneCommitStatus>(
        'scene.load_from_capture_config',
        params
      )
      applyCommittedScene(status)
    },
    [activeSceneBackground, applyCommittedScene, client, wsStatus]
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
    // S1 (plan 024): the two window `focus` listeners fire refreshBackend on
    // TCC-prompt focus-return, and at grant/restart time `client` is still the
    // OLD object (setClient(null) is deferred to effect cleanup), so a bare
    // `if (!client)` guard let ~13 requests fan out into a closed socket. Gate
    // on the live connection status too, so the restart window fans out nothing
    // doomed. The focus listeners themselves stay (plan-021 re-kick recovery).
    if (!client || wsStatusRef.current !== 'connected') {
      return
    }

    try {
      setLastError(null)
      const [
        nextHealth,
        nextEntitlements,
        nextAccount,
        nextDevices,
        nextSessions,
        nextSessionStorage,
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
        client.request<VideorcAccountSnapshot>('account.get'),
        client.request<DeviceList>('devices.list', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        }),
        client.request<SessionSummary[]>('sessions.list', { limit: 200 }),
        client.request<SessionStorageTotals>('sessions.storage'),
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
      setAccount(nextAccount)
      await refreshAiReadinessForClient(client, nextAccount)
      const nextStreamMetadataValidation = await client.request<StreamMetadataValidation>(
        'streamTargets.metadata.validate',
        nextStreamMetadataDraft
      )
      setHealth(nextHealth)
      setEntitlements(nextEntitlements)
      setDeviceList(nextDevices)
      setSessions(nextSessions)
      setSessionStorageTotals(nextSessionStorage)
      setDiagnosticStats(nextDiagnostics)
      setScreens(nextScreens)
      setActiveScreen(nextActiveScreen)
      setPlatformAccounts(nextPlatformAccounts)
      setOauthProviderCredentials(nextOauthProviderCredentials)
      setPlatformAccountValidations(nextPlatformAccountValidations)
      setStreamMetadataDraft(nextStreamMetadataDraft)
      setStreamMetadataValidation(nextStreamMetadataValidation)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshAiReadinessForClient, reportError, settings.ffmpegPath])

  // Real OS camera/mic access status (Electron getMediaAccessStatus, over IPC —
  // independent of the backend socket). Refresh on mount and whenever the window
  // regains focus, since grants flip in the OS Settings while we're backgrounded
  // — the same trigger the Settings/onboarding chips already use.
  useEffect(() => {
    const bridge = window.videorc?.getMediaAccessStatus
    if (!bridge) {
      return
    }
    let cancelled = false
    const refresh = (): void => {
      void bridge()
        .then((snapshot) => {
          if (!cancelled) {
            setMediaAccess(snapshot)
          }
        })
        .catch(() => {
          // Non-fatal: the chips fall back to the meter/enumeration derivation.
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [])

  useEffect(() => {
    if (
      !client ||
      !shouldReloadSceneFromCaptureConfig({
        connected: wsStatus === 'connected',
        sceneEditMode,
        recordingState: recording.state,
        startRequestPending,
        stopRequestPending
      })
    ) {
      return
    }
    if (skipNextConfigSceneReloadRef.current) {
      skipNextConfigSceneReloadRef.current = false
      return
    }

    const timer = window.setTimeout(() => {
      if (
        !shouldReloadSceneFromCaptureConfig({
          connected: wsStatusRef.current === 'connected',
          sceneEditMode,
          recordingState: recordingRef.current.state,
          startRequestPending,
          stopRequestPending
        })
      ) {
        return
      }
      void reloadSceneFromCaptureConfig().catch((error) => {
        if (
          shouldReloadSceneFromCaptureConfig({
            connected: wsStatusRef.current === 'connected',
            sceneEditMode,
            recordingState: recordingRef.current.state,
            startRequestPending,
            stopRequestPending
          })
        ) {
          reportError(error)
        }
      })
    }, 250)

    return () => window.clearTimeout(timer)
  }, [
    client,
    recording.state,
    reloadSceneFromCaptureConfig,
    reportError,
    sceneEditMode,
    startRequestPending,
    stopRequestPending,
    wsStatus
  ])

  const resetSceneSource = useCallback(
    async (sourceId = selectedSceneSourceId ?? undefined) => {
      if (!client || !sourceId) {
        return
      }

      try {
        const status = await client.request<SceneCommitStatus>('scene.source.transform.reset', {
          sourceId
        })
        applyCommittedScene(status)
        if (status.scene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          patchLayout({ cameraTransformMode: 'preset', cameraTransform: null })
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, patchLayout, reportError, selectedSceneSourceId]
  )

  const nudgeSceneSource = useCallback(
    async (sourceId: string, directionX: number, directionY: number, large = false) => {
      if (!client) {
        return
      }

      try {
        const status = await client.request<SceneCommitStatus>('scene.source.nudge', {
          sourceId,
          directionX,
          directionY,
          large
        })
        applyCommittedScene(status)
        if (status.scene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          syncCameraTransformToLayout(status.scene)
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, syncCameraTransformToLayout]
  )

  // SC3: absolute transform write for stage drags (nudge is directional).
  const setSceneSourceTransform = useCallback(
    async (
      sourceId: string,
      patch: { x?: number; y?: number; width?: number; height?: number }
    ) => {
      if (!client) {
        return
      }

      try {
        const status = await client.request<SceneCommitStatus>('scene.source.transform.update', {
          sourceId,
          transform: patch
        })
        applyCommittedScene(status)
        if (status.scene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          syncCameraTransformToLayout(status.scene)
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, syncCameraTransformToLayout]
  )

  const setSceneSourceVisible = useCallback(
    async (sourceId: string, visible: boolean) => {
      if (!client) {
        return
      }

      try {
        const status = await client.request<SceneCommitStatus>('scene.source.visibility.update', {
          sourceId,
          visible
        })
        applyCommittedScene(status)
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError]
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
        const status = await client.request<SceneCommitStatus>('scene.sources.reorder', {
          sourceIds
        })
        applyCommittedScene(status)
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, scene]
  )

  const commitCameraTransform = useCallback(
    async (sourceId: string, x: number, y: number) => {
      if (!client) {
        return
      }

      try {
        const status = await client.request<SceneCommitStatus>('scene.source.transform.update', {
          sourceId,
          transform: { x, y }
        })
        applyCommittedScene(status)
        syncCameraTransformToLayout(status.scene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, syncCameraTransformToLayout]
  )

  const [layoutSwitchPending, setLayoutSwitchPending] = useState<LayoutPreset | null>(null)
  const [sourceDeviceSwitchPending, setSourceDeviceSwitchPending] =
    useState<LiveSourceDeviceSwitchPending | null>(null)

  const rememberLayoutTransactionSnapshot = useCallback((snapshot: LayoutTransactionSnapshot) => {
    latestLayoutTransactionCommitRef.current = latestLayoutTransactionCommit(
      latestLayoutTransactionCommitRef.current,
      snapshot
    )
  }, [])

  const rememberLayoutCommit = useCallback(
    async (
      status: LayoutTransactionStatus,
      sessionActive: boolean,
      intentId: number
    ): Promise<boolean> => {
      if (!client) {
        return false
      }

      const compositorStatus = sessionActive
        ? await waitForLiveLayoutProof(client, status)
        : await waitForPreviewLayoutProof(client, status)
      if (layoutIntentIdRef.current !== intentId || status.intentId !== intentId) {
        return false
      }
      const previewWindowState = await window.videorc?.getPreviewWindowState?.()
      if (nativePreviewSurfaceEnabled && previewWindowState?.open) {
        const proofOwner = nativePreviewSceneProofPresentationOwner({
          mainPumpActive: mainPumpActiveRef.current,
          statusReaderAvailable: Boolean(window.videorc?.getNativePreviewSurfaceStatus),
          rendererUpdaterAvailable: Boolean(window.videorc?.updateNativePreviewSurfaceCompositor)
        })
        const surfaceStatus =
          proofOwner === 'main-pump'
            ? await waitForNativePreviewSurfaceSceneRevision(status.sceneRevision)
            : proofOwner === 'renderer-fallback' &&
                window.videorc?.updateNativePreviewSurfaceCompositor
              ? await window.videorc.updateNativePreviewSurfaceCompositor(compositorStatus)
              : null
        if (!surfaceStatus) {
          throw new Error(
            `Native preview could not verify committed scene revision ${status.sceneRevision}.`
          )
        }
        applyPreviewSurfaceStatus(surfaceStatus)
        if (
          surfaceStatus.nativePreviewHostKind !== 'proof-surface' &&
          !nativePreviewStatusProvesSceneRevision(surfaceStatus, status.sceneRevision)
        ) {
          throw new Error(
            `Native preview did not present committed scene revision ${status.sceneRevision}.`
          )
        }
      }
      if (layoutIntentIdRef.current !== intentId || status.intentId !== intentId) {
        return false
      }
      if (typeof compositorStatus.sceneRevision === 'number') {
        nativePreviewCommittedSceneRef.current = {
          sceneId: status.scene.id,
          sceneRevision: compositorStatus.sceneRevision,
          compositorStatus
        }
      }
      return true
    },
    [applyPreviewSurfaceStatus, client, nativePreviewSurfaceEnabled]
  )

  const rememberLiveLayoutCommit = useCallback(
    async (status: LiveLayoutApplyStatus) => {
      if (!client) {
        return
      }
      const compositorStatus = await waitForLiveLayoutProof(client, status)
      if (typeof compositorStatus.sceneRevision === 'number') {
        nativePreviewCommittedSceneRef.current = {
          sceneId: status.scene.id,
          sceneRevision: compositorStatus.sceneRevision,
          compositorStatus
        }
      }
    },
    [client]
  )

  const applyLayoutTransactionState = useCallback(
    (snapshot: LayoutTransactionSnapshot) => {
      applyScene(snapshot.scene)
      skipNextConfigSceneReloadRef.current = true
      setCaptureConfig((current) => {
        const next = { ...current, layout: snapshot.layout }
        captureConfigRef.current = next
        return next
      })
    },
    [applyScene]
  )

  const readLayoutTransactionBackendTruth = useCallback(async () => {
    if (!client) {
      return null
    }

    // The first `scene.get` is an ordering barrier for accepted overlapping layout
    // commands. The second proves the same scene contents surrounded the compositor
    // status read, since layout commits reuse the same scene id.
    const sceneBefore = await client.request<Scene>('scene.get')
    const compositorStatus = await client.request<CompositorStatus>('compositor.status')
    const sceneAfter = await client.request<Scene>('scene.get')
    if (
      typeof compositorStatus.sceneRevision !== 'number' ||
      !compositorStatus.sceneLayout ||
      !layoutTransactionBackendSnapshotIsStable({
        sceneBefore,
        compositorSceneId: compositorStatus.sceneId,
        sceneAfter
      })
    ) {
      return null
    }

    return {
      sceneRevision: compositorStatus.sceneRevision,
      scene: sceneAfter,
      layout: compositorStatus.sceneLayout,
      compositorStatus
    } satisfies LayoutTransactionSnapshot
  }, [client])

  const requestLayoutTransaction = useCallback(
    (layout: LayoutSettings) => {
      const sessionActive = isActiveRecordingState(recordingRef.current.state)
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected — layout unchanged.')
        return
      }

      const intentId = Math.max(layoutIntentIdRef.current + 1, Date.now())
      layoutIntentIdRef.current = intentId
      layoutIntentAwaitingProofRef.current = intentId
      setLayoutSwitchPending(layout.layoutPreset)

      void (async () => {
        try {
          const requestedConfig = captureConfigRef.current
          const protectedOverlayWindowIds = await currentProtectedOverlayWindowIds()
          const method = sessionActive ? 'scene.layout.apply_live' : 'scene.layout.apply_preview'
          const status = await client.request<LayoutTransactionStatus>(method, {
            intentId,
            sources: requestedConfig.sources,
            layout,
            video: requestedConfig.video,
            background: activeSceneBackground,
            protectedOverlayWindowIds
          })
          const committedSnapshot: LayoutTransactionSnapshot = {
            sceneRevision: status.sceneRevision,
            scene: status.scene,
            layout: status.compositorStatus.sceneLayout ?? layout,
            compositorStatus: status.compositorStatus
          }
          // Intent freshness and backend commit freshness are separate. A may be
          // superseded by B after A commits; remember A before waiting for proof
          // so a failed B can reconcile the renderer to committed backend truth.
          rememberLayoutTransactionSnapshot(committedSnapshot)
          let proofSucceeded = false
          let proofError: unknown = null
          try {
            proofSucceeded = await rememberLayoutCommit(status, sessionActive, intentId)
          } catch (error) {
            proofError = error
          }
          const disposition = layoutTransactionProofDisposition({
            latestIntentId: layoutIntentIdRef.current,
            committedIntentId: status.intentId,
            proofSucceeded
          })
          if (disposition === 'ignore-stale') {
            return
          }

          // The backend commit is authoritative even if a bounded compositor or
          // native-surface proof misses. Keep React/config in the same committed
          // state, then surface the presentation fault; leaving the old selection
          // visible would create a third, false scene truth.
          applyLayoutTransactionState(committedSnapshot)
          if (disposition === 'apply-unproven') {
            const detail =
              proofError instanceof Error ? proofError.message : 'Presentation proof timed out.'
            reportError(
              new Error(
                `Layout committed at revision ${status.sceneRevision}, but preview proof was not observed. The controls were reconciled to the backend commit. ${detail}`
              )
            )
            return
          }
          if (status.mode === 'warm' && status.message) {
            toast.success(status.message)
          }
        } catch (error) {
          // Superseded requests are expected and must not overwrite the newer
          // selection or flash an error. The latest request still reports exact
          // readiness/presentation failures.
          if (layoutIntentIdRef.current === intentId) {
            let backendTruth: LayoutTransactionSnapshot | null = null
            try {
              backendTruth = await readLayoutTransactionBackendTruth()
            } catch {
              // The last observed commit remains the safe fallback. Connection
              // recovery performs its own authoritative scene.get reconciliation.
            }
            const reconciliation = layoutTransactionFailureReconciliation({
              latestIntentId: layoutIntentIdRef.current,
              failedIntentId: intentId,
              backendTruth,
              latestCommit: latestLayoutTransactionCommitRef.current
            })
            if (reconciliation) {
              rememberLayoutTransactionSnapshot(reconciliation.snapshot)
              applyLayoutTransactionState(reconciliation.snapshot)
              reportError(error)
            } else if (layoutIntentIdRef.current === intentId) {
              reportError(error)
            }
          }
        } finally {
          if (layoutIntentAwaitingProofRef.current === intentId) {
            layoutIntentAwaitingProofRef.current = null
          }
          if (layoutIntentIdRef.current === intentId) {
            setLayoutSwitchPending(null)
          }
        }
      })()
    },
    [
      activeSceneBackground,
      applyLayoutTransactionState,
      client,
      readLayoutTransactionBackendTruth,
      rememberLayoutCommit,
      rememberLayoutTransactionSnapshot,
      reportError,
      wsStatus
    ]
  )

  const applyLayoutPatch = useCallback(
    (patch: Partial<LayoutSettings>) => {
      requestLayoutTransaction({
        ...captureConfigRef.current.layout,
        ...patch
      })
    },
    [requestLayoutTransaction]
  )

  const applyCameraPreset = useCallback(
    (patch: Partial<LayoutSettings>) => {
      requestLayoutTransaction({
        ...captureConfigRef.current.layout,
        ...patch,
        cameraTransformMode: 'preset',
        cameraTransform: null
      })
    },
    [requestLayoutTransaction]
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
        const protectedOverlayWindowIds = await currentProtectedOverlayWindowIds()
        const status = await client.request<LiveLayoutApplyStatus>('scene.source.device.switch', {
          sources,
          layout: captureConfig.layout,
          video: captureConfig.video,
          background: activeSceneBackground,
          protectedOverlayWindowIds
        })
        await rememberLiveLayoutCommit(status)
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
      activeSceneBackground,
      captureConfig.layout,
      captureConfig.video,
      client,
      loadScene,
      rememberLiveLayoutCommit,
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

    if (runtimeInfo?.disableAutoPreview) {
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

    // Layout transactions own source retirement. In particular, screen-only keeps
    // the camera alive for a cancelable one-second grace so a rapid side-by-side
    // intent cannot race a renderer-authored stop/cold-start cycle.
    const presetUsesCamera = captureConfig.layout.layoutPreset !== 'screen-only'
    if (!presetUsesCamera) {
      return previewCameraStatusRef.current
    }

    const key = JSON.stringify({
      cameraId,
      width: captureConfig.video.width,
      height: captureConfig.video.height,
      fps: captureConfig.video.fps,
      ffmpegPath: settings.ffmpegPath.trim()
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
      video: captureConfig.video,
      ffmpegPath: settings.ffmpegPath.trim() || undefined
    })
    nativePreviewCameraKeyRef.current =
      status.state === 'failed' || status.state === 'device-missing' ? null : key
    applyPreviewCameraStatus(status)
    if (status.state === 'permission-needed') {
      const permissionReport = window.videorc?.reportPreviewPermissionRequired?.(
        'camera-required',
        status.message,
        previewWindowRef.current.supervisor.generation
      )
      void permissionReport?.catch((error: unknown) => {
        console.error('Preview camera permission status report failed:', error)
      })
    }
    return status
  }, [
    applyPreviewCameraStatus,
    captureConfig.layout,
    captureConfig.sources,
    captureConfig.video,
    client,
    runtimeInfo?.disableAutoPreview,
    runtimeInfo?.previewSmokeMode,
    settings.ffmpegPath,
    wsStatus
  ])

  const ensureNativePreviewScreen = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return previewScreenStatusRef.current
    }

    if (runtimeInfo?.disableAutoPreview) {
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

    // The backend stops an unneeded screen source only after the camera-only scene
    // has committed, keeping the previous good pixels available through warm-up.
    if (captureConfig.layout.layoutPreset === 'camera-only') {
      return previewScreenStatusRef.current
    }

    const blockedStatus = selectedPreviewScreenBlockedStatus(
      captureConfig.sources,
      deviceListRef.current.devices
    )
    if (blockedStatus) {
      nativePreviewScreenKeyRef.current = null
      await client.request<PreviewScreenStatus>('preview.screen.stop')
      applyPreviewScreenStatus(blockedStatus)
      if (blockedStatus.state === 'permission-needed') {
        const permissionReport = window.videorc?.reportPreviewPermissionRequired?.(
          'screen-recording-required',
          blockedStatus.message,
          previewWindowRef.current.supervisor.generation
        )
        void permissionReport?.catch((error: unknown) => {
          console.error('Preview screen permission status report failed:', error)
        })
      }
      return blockedStatus
    }

    const protectedOverlayWindowIds = await currentProtectedOverlayWindowIds()
    const key = JSON.stringify({
      sourceId,
      sourceKind,
      width: captureConfig.video.width,
      height: captureConfig.video.height,
      fps: captureConfig.video.fps,
      ffmpegPath: settings.ffmpegPath.trim(),
      protectedOverlayWindowIds
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
      video: captureConfig.video,
      protectedOverlayWindowIds,
      ffmpegPath: settings.ffmpegPath.trim() || undefined
    })
    nativePreviewScreenKeyRef.current =
      status.state === 'failed' || status.state === 'source-missing' ? null : key
    applyPreviewScreenStatus(status)
    if (status.state === 'permission-needed') {
      const permissionReport = window.videorc?.reportPreviewPermissionRequired?.(
        'screen-recording-required',
        status.message,
        previewWindowRef.current.supervisor.generation
      )
      void permissionReport?.catch((error: unknown) => {
        console.error('Preview screen permission status report failed:', error)
      })
    }
    return status
  }, [
    applyPreviewScreenStatus,
    captureConfig.sources,
    captureConfig.layout.layoutPreset,
    captureConfig.video,
    client,
    runtimeInfo?.disableAutoPreview,
    runtimeInfo?.previewSmokeMode,
    settings.ffmpegPath,
    wsStatus
  ])

  const refreshPreview = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    if (nativePreviewSurfaceEnabled) {
      const cameraStatus = await ensureNativePreviewCamera()
      const screenStatus = await ensureNativePreviewScreen()
      const permissionStatus =
        screenStatus.state === 'permission-needed'
          ? screenStatus
          : cameraStatus.state === 'permission-needed'
            ? cameraStatus
            : null
      if (permissionStatus) {
        setPreviewLoading(false)
        setPreviewUrl(null)
        setPreviewLiveStatus({
          state: 'unavailable',
          source: 'unavailable',
          transport: 'unavailable',
          message: permissionStatus.message ?? 'Permission is required before preview can run.'
        })
        return
      }
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
    async (bounds: PreviewSurfaceBounds, generation?: number) => {
      const generationIsCurrent = (candidate: number | undefined): boolean =>
        nativePreviewSurfaceSyncCanCommit(previewWindowRef.current, candidate)
      if (!nativePreviewSurfaceEnabled || !client || wsStatus !== 'connected') {
        return
      }
      if (!window.videorc?.createNativePreviewSurface) {
        return
      }
      // The explicit session ref is the lifecycle authority. A cached live
      // renderer status may outlive close teardown; treating that stale status
      // as an existing backend session turns reopen into update_bounds instead
      // of create and leaves the compositor stopped.
      const surfaceAlreadyCreated = nativePreviewSurfaceCreatedRef.current
      if (
        surfaceAlreadyCreated &&
        !previewSurfaceBoundsChanged(nativePreviewSurfaceLastSyncedBoundsRef.current, bounds)
      ) {
        return
      }
      nativePreviewSurfaceBoundsPendingRef.current = bounds
      nativePreviewSurfaceBoundsPendingGenerationRef.current = generation
      if (nativePreviewSurfaceBoundsSyncInFlightRef.current) {
        return
      }

      nativePreviewSurfaceBoundsSyncInFlightRef.current = true
      try {
        while (nativePreviewSurfaceBoundsPendingRef.current) {
          const nextBounds: PreviewSurfaceBounds = nativePreviewSurfaceBoundsPendingRef.current
          const nextGeneration = nativePreviewSurfaceBoundsPendingGenerationRef.current
          nativePreviewSurfaceBoundsPendingRef.current = null
          nativePreviewSurfaceBoundsPendingGenerationRef.current = undefined
          if (!generationIsCurrent(nextGeneration)) {
            continue
          }
          const applyHostCommands = window.videorc?.applyNativePreviewHostCommands
          const current = previewSurfaceStatusRef.current
          const surfaceAlreadyCreated = nativePreviewSurfaceCreatedRef.current
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
          // Main is the sole live placement writer. Renderer reports the latest
          // bounds to backend telemetry/lifecycle state, but never sends movement to
          // the native host directly or replays the backend's delayed bounds echo.
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
          const queuedCommands = await client.request<NativePreviewHostCommand[]>(
            'preview.surface.take_native_host_commands'
          )
          const hostCommands = queuedCommands.filter((command) => command.kind !== 'update-bounds')
          const hostStatus =
            hostCommands.length > 0 && applyHostCommands
              ? await applyHostCommands(hostCommands, nextGeneration)
              : !surfaceAlreadyCreated
                ? await window.videorc.createNativePreviewSurface(nextBounds, nextGeneration)
                : window.videorc.getNativePreviewSurfaceStatus
                  ? await window.videorc.getNativePreviewSurfaceStatus()
                  : current
          if (!generationIsCurrent(nextGeneration)) {
            continue
          }
          if (nativePreviewSurfaceSyncNeedsCreate(surfaceAlreadyCreated, backendStatus.state)) {
            // A close teardown can finish while an older bounds request is in
            // flight. If that stale request observed the old renderer ref, the
            // backend truth wins and this same latest bounds becomes a create.
            nativePreviewSurfaceCreatedRef.current = false
            nativePreviewSurfaceLastSyncedBoundsRef.current = null
            nativePreviewSurfaceBoundsPendingRef.current = nextBounds
            nativePreviewSurfaceBoundsPendingGenerationRef.current = nextGeneration
            continue
          }
          nativePreviewSurfaceCreatedRef.current = backendStatus.state === 'live'
          const backendStatusAfterHostDrain =
            queuedCommands.length > 0
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
    alwaysOnTop: false,
    mode: 'floating',
    dockEpoch: 0,
    dockHiddenReason: null,
    supervisor: idlePreviewSupervisorState()
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
    if (nativePreviewFramePollingSuppressionRequestedRef.current === suppress) {
      return
    }
    nativePreviewFramePollingSuppressionRequestedRef.current = suppress
    void window.videorc
      .setNativePreviewSurfaceFramePollingSuppressed(suppress)
      .then((status) => {
        if (nativePreviewFramePollingSuppressionRequestedRef.current === suppress) {
          applyPreviewSurfaceStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (nativePreviewFramePollingSuppressionRequestedRef.current === suppress) {
          nativePreviewFramePollingSuppressionRequestedRef.current = null
        }
        console.error('Native preview frame-polling suppression failed:', error)
      })
  }, [applyPreviewSurfaceStatus, nativePreviewSurfaceEnabled])

  syncFramePollingSuppressionRef.current = syncFramePollingSuppression

  // Closing the preview window must cost nothing: tear the surface session down
  // (helper window, proof window, backend session) instead of merely hiding it.
  const teardownDetachedPreviewSurface = useCallback(async (generation?: number) => {
    const generationIsCurrent = (): boolean =>
      generation === undefined || previewWindowRef.current.supervisor.generation === generation
    nativePreviewSurfaceCreatedRef.current = false
    nativePreviewSurfaceLastSyncedBoundsRef.current = null
    nativePreviewSurfaceBoundsPendingRef.current = null
    nativePreviewSurfaceBoundsPendingGenerationRef.current = undefined
    try {
      if (window.videorc?.applyNativePreviewHostCommands) {
        await window.videorc.applyNativePreviewHostCommands([{ kind: 'destroy' }], generation)
      }
      if (generationIsCurrent() && clientRef.current && wsStatusRef.current === 'connected') {
        await clientRef.current.request('preview.surface.destroy')
      }
    } catch (error) {
      console.error('Detached preview surface teardown failed:', error)
    }
  }, [])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled || runtimeInfo?.disableAutoPreview) {
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
      void syncNativePreviewSurfaceBounds(bounds, previewWindow.supervisor.generation)
      return
    }
    if (!previewWindow.open && previewWindowSurfaceActiveRef.current) {
      previewWindowSurfaceActiveRef.current = false
      void teardownDetachedPreviewSurface(previewWindow.supervisor.generation)
    }
  }, [
    nativePreviewSurfaceEnabled,
    previewWindow,
    runtimeInfo?.disableAutoPreview,
    syncFramePollingSuppression,
    syncNativePreviewSurfaceBounds,
    teardownDetachedPreviewSurface
  ])

  const openPreviewWindow = useCallback(async () => {
    const next = await window.videorc?.openPreviewWindow?.()
    if (next) {
      setPreviewWindow(next)
    }
  }, [])

  const closePreviewWindow = useCallback(async () => {
    const next = await window.videorc?.closePreviewWindow?.()
    if (next) {
      setPreviewWindow(next)
    }
  }, [])

  const togglePreviewWindow = useCallback(async () => {
    const next = await window.videorc?.togglePreviewWindow?.()
    if (next) {
      setPreviewWindow(next)
    }
  }, [])

  const setPreviewWindowAlwaysOnTop = useCallback(async (alwaysOnTop: boolean) => {
    const next = await window.videorc?.setPreviewWindowAlwaysOnTop?.(alwaysOnTop)
    if (next) {
      setPreviewWindow(next)
    }
  }, [])

  const setPreviewWindowMode = useCallback(async (mode: PreviewWindowMode) => {
    const next = await window.videorc?.setPreviewWindowMode?.(mode)
    if (next) {
      setPreviewWindow(next)
    }
  }, [])

  // --- Detached Notes window ---------------------------------------------------
  // Internal only until the recording artifact smoke proves capture invisibility.
  const [notesWindow, setNotesWindow] = useState<NotesWindowState>(idleNotesWindowState)

  useEffect(() => {
    let cancelled = false
    const reconcile = async (): Promise<void> => {
      const fresh = await window.videorc?.getNotesWindowState?.()
      if (!fresh || cancelled) {
        return
      }
      setNotesWindow((current) =>
        JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
      )
    }
    void reconcile()
    const unsubscribe = window.videorc?.onNotesWindowState?.((state) => setNotesWindow(state))
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [runtimeInfo?.notesWindowEnabled])

  const openNotesWindow = useCallback(async () => {
    await window.videorc?.openNotesWindow?.()
  }, [])

  const closeNotesWindow = useCallback(async () => {
    await window.videorc?.closeNotesWindow?.()
  }, [])

  const setNotesWindowAlwaysOnTop = useCallback(async (alwaysOnTop: boolean) => {
    await window.videorc?.setNotesWindowAlwaysOnTop?.(alwaysOnTop)
  }, [])

  const notesProtectedOverlayKey = useMemo(
    () =>
      notesWindow.open && typeof notesWindow.windowId === 'number'
        ? String(notesWindow.windowId)
        : '',
    [notesWindow.open, notesWindow.windowId]
  )

  useEffect(() => {
    if (
      !notesWindow.open ||
      !isActiveRecordingState(recording.state) ||
      runtimeInfo?.notesWindowRecordingOverlayAllowed
    ) {
      return
    }
    void window.videorc?.closeNotesWindow?.().then(() => {
      toast.warning('Notes closed for this recording', {
        description: 'Notes recording overlay is disabled by VIDEORC_NOTES_RECORDING_OVERLAY=0.'
      })
    })
  }, [notesWindow.open, recording.state, runtimeInfo?.notesWindowRecordingOverlayAllowed])

  useEffect(() => {
    if (
      !commentsWindow.open ||
      commentsWindow.protected ||
      !isActiveRecordingState(recording.state) ||
      runtimeInfo?.commentsWindowRecordingOverlayAllowed
    ) {
      return
    }
    void window.videorc?.closeCommentsWindow?.().then(() => {
      toast.warning('Comments closed for this recording', {
        description:
          'Comments window protection is unavailable and recording overlay capture is disabled by VIDEORC_COMMENTS_RECORDING_OVERLAY=0.'
      })
    })
  }, [
    commentsWindow.open,
    commentsWindow.protected,
    recording.state,
    runtimeInfo?.commentsWindowRecordingOverlayAllowed
  ])

  useEffect(() => {
    const current = previewScreenStatusRef.current
    if (current.state !== 'starting' && current.state !== 'live') {
      return
    }
    nativePreviewScreenKeyRef.current = null
    void ensureNativePreviewScreen()
  }, [ensureNativePreviewScreen, notesProtectedOverlayKey])

  // The preview window is locked to the OUTPUT aspect ratio — the user can never
  // squeeze or stretch what they will record/stream.
  useEffect(() => {
    void window.videorc?.setPreviewWindowAspectRatio?.(
      captureConfig.video.width,
      captureConfig.video.height
    )
  }, [captureConfig.video.width, captureConfig.video.height])

  const syncNativePreviewSurfaceCompositor = useCallback(async () => {
    if (!nativePreviewSurfaceEnabled || !client || wsStatus !== 'connected') {
      return
    }

    // Scene contents and source readiness now come only from the backend commit.
    // This hook may re-present committed compositor truth, but it must never author
    // another native-surface scene with the same revision and different contents.
    const committed = nativePreviewCommittedSceneRef.current
    const committedStatus = committed?.compositorStatus ?? null
    const compositorStatus =
      committedStatus ?? (await client.request<CompositorStatus>('compositor.status'))
    const revision = compositorStatus.sceneRevision
    if (typeof revision !== 'number') {
      return
    }
    const renderedStatus = await waitForRenderedCompositorSceneRevision(
      client,
      revision,
      compositorStatus
    )
    if (!compositorStatusHasRenderedSceneRevision(renderedStatus, revision)) {
      return
    }
    const proofOwner = nativePreviewSceneProofPresentationOwner({
      mainPumpActive: mainPumpActiveRef.current,
      statusReaderAvailable: Boolean(window.videorc?.getNativePreviewSurfaceStatus),
      rendererUpdaterAvailable: Boolean(window.videorc?.updateNativePreviewSurfaceCompositor)
    })
    if (proofOwner === 'main-pump') {
      const status = await waitForNativePreviewSurfaceSceneRevision(revision)
      if (status) {
        applyPreviewSurfaceStatus(status)
      }
      return
    }
    if (proofOwner === 'renderer-fallback' && window.videorc.updateNativePreviewSurfaceCompositor) {
      const status = await window.videorc.updateNativePreviewSurfaceCompositor(renderedStatus)
      applyPreviewSurfaceStatus({
        ...status,
        framesRendered: Math.max(
          status.framesRendered,
          previewSurfaceStatusRef.current.framesRendered
        )
      })
      return
    }
  }, [applyPreviewSurfaceStatus, client, nativePreviewSurfaceEnabled, wsStatus])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled) {
      return
    }
    void syncNativePreviewSurfaceCompositor().catch((error: unknown) => {
      console.error('Native preview compositor sync failed:', error)
    })
  }, [nativePreviewSurfaceEnabled, syncNativePreviewSurfaceCompositor])

  // First-frame healing ladder: main asks for a scene re-commit when the
  // compositor holds a stale/foreign scene (backend-owned revisions displace it).
  useEffect(() => {
    if (!nativePreviewSurfaceEnabled) {
      return
    }
    const unsubscribe = window.videorc?.onPreviewSceneResyncRequest?.(() => {
      void syncNativePreviewSurfaceCompositor().catch((error: unknown) => {
        console.error('Native preview compositor resync failed:', error)
      })
    })
    return () => unsubscribe?.()
  }, [nativePreviewSurfaceEnabled, syncNativePreviewSurfaceCompositor])

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
      const params: SupportBundleExportParams = {
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        // S2 (plan 024): the backend only knows its crate version (stuck at
        // 0.9.0); forward the real Electron app version so the bundle
        // identifies the shipped build. Absent → backend degrades to crate.
        appVersion: runtimeInfo?.version,
        rendererDiagnostics: {
          automaticSourceFallbacks: automaticSourceFallbacks.current,
          runtimeInfo: runtimeInfo ?? undefined
        }
      }
      const result = await client.request<SupportBundleExportResult>(
        'diagnostics.supportBundle.export',
        params
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
  }, [client, reportError, runtimeInfo, settings.ffmpegPath, supportBundleExportPending])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      // F-011: this used to be a silent no-op — the button appeared dead.
      toast.error('Microphone check', {
        description: 'Backend is not connected — try again in a moment.'
      })
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
  const goLiveEntitlement = captureConfig.streamEnabled
    ? goLiveEntitlementGate({ entitlements, streaming: captureConfig.streaming })
    : { allowed: true as const }
  const recordingProfileEntitlement = captureConfig.recordEnabled
    ? videoProfileEntitlementGate({
        entitlements,
        kind: 'recording',
        video: captureConfig.video
      })
    : { allowed: true as const }
  const streamingProfileEntitlement = captureConfig.streamEnabled
    ? videoProfileEntitlementGate({
        entitlements,
        kind: 'streaming',
        video: streamOutputVideoSettings(captureConfig.video, captureConfig.streaming)
      })
    : { allowed: true as const }
  const currentCloudAiReadiness = cloudAiReadiness({
    account,
    capabilities: aiCapabilities,
    error: aiReadinessError,
    loading: aiReadinessLoading,
    quota: aiQuota
  })
  const isSessionActive =
    isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending

  useEffect(() => {
    if (aiConsent && !currentCloudAiReadiness.ready) {
      setAiConsent(false)
    }
  }, [aiConsent, currentCloudAiReadiness.ready])

  // Burn-in driver: rasterize the newest caption line at the stream output
  // width and push it to the backend overlay (stream leg only, A0). Cleared
  // whenever burn-in/captions/session stop so the next session never starts
  // with a stale bar.
  const captionOverlayBusy = useRef(false)
  const captionOverlayPushedKey = useRef<string | null>(null)

  // Capture-session rising edge: the caption strip/window and the burn bar
  // start EMPTY for every new video. The floor is recorded before the buffer
  // clears so a previous-video line — still in the buffer, or arriving late
  // from an in-flight chunk upload — can never be shown or re-pushed into the
  // new session (the 2026-07-04 carry-over bug: the driver re-pushed
  // captionLines.at(-1) from the previous video at each session start).
  const captionSessionWasActiveRef = useRef(false)
  useEffect(() => {
    if (isSessionActive && !captionSessionWasActiveRef.current) {
      const lines = captionLinesRef.current
      captionSessionFloorRef.current = captionSessionFloor(lines) ?? captionSessionFloorRef.current
      captionOverlayPushedKey.current = null
      if (lines.length > 0) {
        setCaptionLines([])
      }
    }
    captionSessionWasActiveRef.current = isSessionActive
  }, [isSessionActive])

  useEffect(() => {
    if (!client) {
      return
    }
    const decision = decideOverlayPush({
      burnIn: captureConfig.captions.burnTarget !== 'off',
      captionsRunning: captionsStatus.state === 'live' || captionsStatus.state === 'degraded',
      sessionActive: isSessionActive,
      latest: captionLines.at(-1),
      floor: captionSessionFloorRef.current,
      pushedKey: captionOverlayPushedKey.current,
      busy: captionOverlayBusy.current
    })
    if (decision.action === 'clear') {
      captionOverlayPushedKey.current = null
      void client.request('captions.overlay.clear').catch(() => {})
      return
    }
    if (decision.action !== 'push') {
      return
    }
    const latest = captionLines.at(-1)!
    captionOverlayBusy.current = true
    const streamVideo = streamOutputVideoSettings(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined
    )
    void renderCaptionOverlayPng({
      text: latest.text,
      canvasWidth: streamVideo.width,
      textSize: captureConfig.captions.textSize
    })
      .then((pngBase64) => {
        if (!pngBase64) {
          return
        }
        return client
          .request('captions.overlay.set', {
            pngBase64,
            position: captureConfig.captions.position
          })
          .then(() => {
            captionOverlayPushedKey.current = decision.key
          })
      })
      .catch(() => {
        // Overlay pushes are best-effort; the next caption line retries.
      })
      .finally(() => {
        captionOverlayBusy.current = false
      })
  }, [
    client,
    captionLines,
    captionsStatus.state,
    isSessionActive,
    captureConfig.captions,
    captureConfig.video,
    captureConfig.streamEnabled,
    captureConfig.streaming
  ])

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
      const unavailable = oauthUnavailableReason(platform)
      if (unavailable) {
        toast.warning(unavailable)
        return
      }
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
        // Callback-URL registration hints live in docs/distribution.md — they
        // are developer-portal instructions, not something an end user can act
        // on, so the toast stays quiet.
        toast.success('OAuth browser opened.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError, wsStatus]
  )

  const signOutAccount = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    try {
      const nextAccount = await client.request<VideorcAccountSnapshot>('account.sign_out')
      setAccount(nextAccount)
      await refreshAiReadinessForClient(client, nextAccount)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshAiReadinessForClient, reportError, wsStatus])

  const completeAccountSignIn = useCallback(
    async (token: string) => {
      if (!client || wsStatus !== 'connected') {
        return
      }
      try {
        const nextAccount = await client.request<VideorcAccountSnapshot>(
          'account.complete_sign_in',
          {
            token
          }
        )
        setAccount(nextAccount)
        await refreshAiReadinessForClient(client, nextAccount)
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshAiReadinessForClient, reportError, wsStatus]
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

      // The product-account deep-link rides the same callback channel as OAuth.
      if (parsed.hostname === 'account') {
        const token = parsed.searchParams.get('token')?.trim()
        if (token) {
          void completeAccountSignIn(token)
        }
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
  }, [client, completeAccountSignIn, reportError, wsStatus])

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
      !previewDevicesSignature
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 500)

    return () => window.clearTimeout(timer)
  }, [
    client,
    health?.ffmpeg.available,
    isSessionActive,
    previewDevicesSignature,
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
    if (!recordingProfileEntitlement.allowed) {
      return recordingProfileEntitlement.reason
    }
    if (!streamingProfileEntitlement.allowed) {
      return streamingProfileEntitlement.reason
    }
    if (profileCompatibility.blockingReason) {
      return profileCompatibility.blockingReason
    }
    if (captureConfig.streamEnabled && livestreamingEntitlementReason) {
      return livestreamingEntitlementReason
    }
    if (captureConfig.streamEnabled && !goLiveEntitlement.allowed) {
      return goLiveEntitlement.reason
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
          assertYouTubeTransitionConfirmed(transition, 'live')
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'live',
                  message: 'YouTube broadcast is live.'
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

  const activatePreparedXBroadcasts = useCallback(
    async (streamingForStart: StreamingSettings, runId: number, sessionId?: string) => {
      if (!client) {
        return
      }

      const xTargets = preparedXActivationTargets(streamingForStart)

      for (const target of xTargets) {
        const sourceId = target.platformStreamId
        const region = target.platformBroadcastId
        if (!sourceId || !region) {
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
                  message: 'Waiting for X ingest.'
                }
              })
            })
          )

          // Metadata (title, announce-on-timeline) is derived backend-side
          // from the stream metadata draft — never hardcoded here.
          const result = await client.request<XPublishResult>('streamTargets.x.publish', {
            accountId: target.accountId,
            sourceId,
            region,
            isLowLatency: true,
            sessionId
          })

          if (platformLifecycleRun.current !== runId) {
            return
          }

          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                accountId: result.accountId,
                platformBroadcastId: result.broadcastId,
                platformStreamId: result.mediaKey,
                status: {
                  state: result.tweetError ? 'warning' : 'live',
                  message: result.tweetError
                    ? `X broadcast is live, but the announcement post failed: ${result.tweetError}`
                    : `X broadcast is live: ${result.shareUrl}`,
                  redactedUrl: result.shareUrl
                }
              })
            })
          )

          if (sessionId) {
            try {
              const params: XLiveChatStartParams = {
                sessionId,
                broadcastId: result.broadcastId,
                mediaKey: result.mediaKey,
                targetId: target.id
              }
              await client.request<LiveChatSnapshot>('liveChat.x.start', params)
            } catch (chatError) {
              const chatMessage = chatError instanceof Error ? chatError.message : String(chatError)
              toast.warning(`X comments need review for ${target.label}.`, {
                description: chatMessage
              })
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `X go-live needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not publish ${target.label} on X.`, {
            description: message
          })
        }
      }
    },
    [client]
  )

  // X's documented broadcast lifecycle is END first, THEN stop the encoder
  // ("After ending, stop your encoder"). Videorc used to do the opposite —
  // SIGKILL the RTMP leg mid-RUNNING, then send a posthumous END — which is
  // the prime suspect for sources going playback-dead on reuse (plan 031).
  // Returns the streaming settings with ended targets patched so a later
  // cleanup pass does not END the same broadcast twice.
  const endPreparedXBroadcasts = useCallback(
    async (
      streamingForCleanup: StreamingSettings,
      sessionId?: string,
      timeoutMs?: number
    ): Promise<StreamingSettings> => {
      if (!client) {
        return streamingForCleanup
      }
      let nextStreaming = streamingForCleanup
      const xTargets = preparedXCompletionTargets(streamingForCleanup)
      for (const target of xTargets) {
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
                  message: 'Ending X broadcast.'
                }
              })
            })
          )
          const endRequest = client.request<XEndResult>('streamTargets.x.end', {
            accountId: target.accountId,
            broadcastId,
            sessionId
          })
          // Never hold the encoder stop hostage to a slow END: on timeout the
          // target stays 'live' so the post-stop cleanup pass retries it.
          const result = timeoutMs
            ? await Promise.race([
                endRequest,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('x-end-timeout')), timeoutMs)
                )
              ])
            : await endRequest
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'stopped',
              message: result.message
            }
          })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'stopped',
                  message: result.message
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message === 'x-end-timeout') {
            // Leave the target 'live'; the post-stop pass retries the END.
            continue
          }
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'warning',
              message: `X cleanup needs review: ${message}`
            }
          })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `X cleanup needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not end ${target.label} on X.`, {
            description: message
          })
        }
      }
      return nextStreaming
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
          assertYouTubeTransitionConfirmed(result, 'complete')
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'stopped',
                  message: 'YouTube broadcast ended.'
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

      await endPreparedXBroadcasts(streamingForCleanup)
    },
    [captureConfig.streaming, client, endPreparedXBroadcasts]
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
          let unhealthy: StreamTargetSettings | null = null
          let unhealthyMessage: string | null = null
          for (const target of enabledOauthTargets) {
            const unavailable = oauthUnavailableReason(target.platform)
            if (unavailable) {
              unhealthy = target
              unhealthyMessage = unavailable
              break
            }
            if (target.platform === 'x') {
              const capability = await client.request<XNativeLiveCapability>(
                'streamTargets.x.capability',
                {
                  accountId: target.accountId
                }
              )
              if (!capability.nativeAvailable) {
                unhealthy = target
                unhealthyMessage = capability.message
                break
              }
              continue
            }
            const validation = validations.find((item) => item.platform === target.platform)
            if (!validation || !['valid', 'refreshed'].includes(validation.state)) {
              unhealthy = target
              unhealthyMessage = `Reconnect ${target.label} before starting an OAuth livestream.`
              break
            }
          }
          if (unhealthy) {
            throw new Error(
              unhealthyMessage ??
                `Reconnect ${unhealthy.label} before starting an OAuth livestream.`
            )
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
        await activatePreparedXBroadcasts(
          streamingForStart,
          lifecycleRunId,
          status.sessionId ?? recordingRef.current.sessionId
        )
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
      activatePreparedXBroadcasts,
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
          const unavailable = oauthUnavailableReason(target.platform)
          if (unavailable) {
            throw new Error(unavailable)
          }
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
          const prepared = await client.request<PreparedXStreamSource>('streamTargets.x.prepare', {
            accountId: target.accountId
          })
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            accountId: prepared.accountId,
            accountLabel: prepared.accountLabel,
            serverUrl: prepared.serverUrl,
            streamKeySecretRef: prepared.streamKeySecretRef,
            streamKeyPresent: true,
            platformBroadcastId: prepared.region,
            platformStreamId: prepared.sourceId,
            status: {
              state: 'ready',
              message: prepared.isStreamActive
                ? 'X source prepared; ingest is already active.'
                : 'X source prepared.'
            }
          })
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

    // Manual-RTMP Twitch targets: the transport is a user-provided stream
    // key, but Helix channel updates work regardless of ingest path — push
    // title/category/language through the connected account. Best-effort:
    // a metadata failure must not block going live over the key.
    const twitchAccount = platformAccounts.find((item) => item.platform === 'twitch')
    for (const target of captureConfig.streaming.targets.filter(
      (target) => target.enabled && target.authMode !== 'oauth' && target.platform === 'twitch'
    )) {
      if (!twitchAccount) {
        nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
          status: {
            state: 'ready',
            message: 'Streaming over stream key. Connect Twitch to push title and category.'
          }
        })
        continue
      }
      try {
        const applied = await client.request<TwitchAppliedMetadata>(
          'streamTargets.twitch.applyMetadata',
          { accountId: twitchAccount.accountId }
        )
        nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
          status: {
            state: 'ready',
            message: `Twitch channel metadata updated ("${applied.title}").`
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
          status: {
            state: 'ready',
            message: `Streaming over stream key; channel metadata update failed: ${message}`
          }
        })
      }
    }

    setCaptureConfig((current) => bridgeStreamingToLegacy({ ...current, streaming: nextStreaming }))
    await refreshPlatformAccountsForClient(client)
    return {
      streaming: nextStreaming,
      failures,
      readyLabels: readyStreamTargetLabels(nextStreaming)
    }
  }, [
    captureConfig.streaming,
    captureConfig.video,
    client,
    platformAccounts,
    refreshPlatformAccountsForClient
  ])

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
        const premiumIssue = premiumRequiredIssueMessage(preflight)
        if (premiumIssue) {
          toast.error(
            'Premium required for this Go Live setup.',
            premiumUpgradeToastOptions(premiumIssue)
          )
        } else {
          toast.error('Resolve Go Live issues before starting.')
        }
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
      // Docs order: END the X broadcast while the feed is still up, THEN stop
      // the encoder. Bounded so a slow END can never hold the stop hostage.
      const cleaned = await endPreparedXBroadcasts(
        captureConfig.streaming,
        recordingRef.current.sessionId,
        4000
      )
      const status = await client.request<RecordingStatus>('session.stop')
      applyRecordingStatus(status)
      await completePreparedPlatformBroadcasts(cleaned)
    } catch (error) {
      reportError(error)
    } finally {
      setStopRequestPending(false)
    }
  }, [
    applyRecordingStatus,
    captureConfig.streaming,
    client,
    completePreparedPlatformBroadcasts,
    endPreparedXBroadcasts,
    reportError,
    stopRequestPending
  ])

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      await client.request('sessions.rename', { sessionId, title })
      await refreshSessions(client)
    },
    [client, refreshSessions]
  )

  // Delete = files to the system Trash FIRST (Trash is the undo), then the
  // rows. If any file refuses to move, its session row stays too — the list
  // never lies about what is on disk.
  const deleteSessions = useCallback(
    async (targets: SessionSummary[]): Promise<void> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const paths = targets.flatMap((session) =>
        [session.outputPath, session.mp4Path].filter((path): path is string => Boolean(path))
      )
      const trash = await window.videorc?.trashPaths?.(paths)
      const failedPaths = new Set(trash?.failures ?? [])
      const deletable = targets.filter(
        (session) =>
          !(session.outputPath && failedPaths.has(session.outputPath)) &&
          !(session.mp4Path && failedPaths.has(session.mp4Path))
      )
      if (deletable.length > 0) {
        await client.request('sessions.delete', {
          sessionIds: deletable.map((session) => session.id)
        })
      }
      await refreshSessions(client)
      if (failedPaths.size > 0) {
        throw new Error(
          `${failedPaths.size} file(s) could not be moved to Trash; their sessions were kept.`
        )
      }
    },
    [client, refreshSessions]
  )

  const duplicateSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      await client.request('sessions.duplicate', { sessionId })
      await refreshSessions(client)
    },
    [client, refreshSessions]
  )

  const importRecording = useCallback(async (): Promise<void> => {
    if (!client) {
      throw new Error('Backend is not connected.')
    }
    const sourcePath = await window.videorc?.pickFile?.()
    if (!sourcePath) {
      return
    }
    // Blank means the platform default — the backend resolves and creates it,
    // exactly like recording does (Settings: "Blank uses the default").
    await client.request('sessions.import', {
      sourcePath,
      outputDirectory: settings.outputDirectory?.trim() ?? '',
      ffmpegPath: settings.ffmpegPath.trim() || undefined
    })
    await refreshSessions(client)
  }, [client, refreshSessions, settings.ffmpegPath, settings.outputDirectory])

  const ensureSessionPoster = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!client) {
        return false
      }
      try {
        const result = await client.request<{ available: boolean }>('sessions.poster', {
          sessionId,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        return result.available
      } catch {
        return false
      }
    },
    [client, settings.ffmpegPath]
  )

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
        // F-023: this used to be a silent no-op — the button appeared dead.
        toast.error('AI workflow', {
          description: 'Backend is not connected — try again in a moment.'
        })
        return
      }
      if (aiConsent && !currentCloudAiReadiness.ready) {
        toast.error(currentCloudAiReadiness.title, {
          description: currentCloudAiReadiness.description
        })
        return
      }

      try {
        setLastError(null)
        setAiRunningSessionId(sessionId)
        const result = await client.request<AiWorkflowResult>('ai.run_post_recording', {
          sessionId,
          consentToUploadAudio: aiConsent,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
        // FX3: the local-only run needs an explicit, named result — "nothing
        // visibly happened" was the by-eye finding. Name the produced file.
        if (aiConsent) {
          toast.success('AI workflow finished.')
        } else {
          toast.success('Local audio extracted.', {
            description: result.audioPath
              ? `Saved ${basename(result.audioPath)} next to the recording. Enable cloud consent to transcribe.`
              : 'Enable cloud consent to transcribe.'
          })
        }
      } catch (error) {
        reportError(error)
      } finally {
        setAiRunningSessionId(null)
      }
    },
    [
      aiConsent,
      client,
      currentCloudAiReadiness.description,
      currentCloudAiReadiness.ready,
      currentCloudAiReadiness.title,
      refreshSessions,
      reportError,
      settings.ffmpegPath
    ]
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

  const applyVideoPreset = useCallback(
    (preset: VideoPreset, options: { kind?: 'recording' | 'streaming' } = {}) => {
      const video = videoPresets[preset]
      const gate = videoProfileEntitlementGate({
        entitlements,
        kind: options.kind ?? 'recording',
        video
      })
      if (!gate.allowed) {
        toast.error(
          'Premium required for this media profile.',
          premiumUpgradeToastOptions(gate.reason)
        )
        return
      }

      setCaptureConfig((current) => ({ ...current, video }))
    },
    [entitlements]
  )

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
  const visibleDeviceList = useMemo(
    () =>
      deviceListWithoutProtectedOverlayWindows(
        deviceList,
        notesWindow,
        commentsWindow,
        captionsWindow
      ),
    [deviceList, notesWindow, commentsWindow, captionsWindow]
  )
  const selectedCaptureDevice = findDevice(
    visibleDeviceList.devices,
    captureConfig.sources.screenId ?? captureConfig.sources.windowId
  )
  const selectedCamera = findDevice(visibleDeviceList.devices, captureConfig.sources.cameraId)
  const selectedMicrophone = findDevice(
    visibleDeviceList.devices,
    captureConfig.sources.microphoneId
  )
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
      account,
      aiCapabilities,
      aiQuota,
      aiReadinessError,
      aiReadinessLoading,
      signOutAccount,
      deviceList: visibleDeviceList,
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
      captionsStatus,
      captionLines,
      startCaptions,
      stopCaptions,
      captionsWindow,
      openCaptionsWindow,
      closeCaptionsWindow,
      toggleCaptionsWindow,
      commentsWindow,
      openCommentsWindow,
      closeCommentsWindow,
      toggleCommentsWindow,
      setCommentsWindowAlwaysOnTop,
      openSessionCommentsWindow,
      highlightedCommentId,
      commentHighlightState,
      commentHighlightApplyingId,
      commentHighlightFailure,
      toggleCommentHighlight,
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
      togglePreviewWindow,
      setPreviewWindowAlwaysOnTop,
      setPreviewWindowMode,
      notesWindow,
      openNotesWindow,
      closeNotesWindow,
      setNotesWindowAlwaysOnTop,
      scene,
      sceneEditMode,
      selectedSceneSourceId,
      setSceneEditMode,
      setSelectedSceneSourceId,
      audioMeter,
      audioMeterLoading,
      mediaAccess,
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
      applyLayoutPatch,
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
      authorizeXLive,
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
      setSceneSourceTransform,
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
      ensureSessionPoster,
      renameSession,
      deleteSessions,
      duplicateSession,
      importRecording,
      sessionStorageTotals,
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
      account,
      aiCapabilities,
      aiQuota,
      aiReadinessError,
      aiReadinessLoading,
      signOutAccount,
      visibleDeviceList,
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
      captionsStatus,
      captionLines,
      startCaptions,
      stopCaptions,
      captionsWindow,
      openCaptionsWindow,
      closeCaptionsWindow,
      toggleCaptionsWindow,
      commentsWindow,
      openCommentsWindow,
      closeCommentsWindow,
      toggleCommentsWindow,
      setCommentsWindowAlwaysOnTop,
      openSessionCommentsWindow,
      highlightedCommentId,
      commentHighlightState,
      commentHighlightApplyingId,
      commentHighlightFailure,
      toggleCommentHighlight,
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
      togglePreviewWindow,
      setPreviewWindowAlwaysOnTop,
      setPreviewWindowMode,
      notesWindow,
      openNotesWindow,
      closeNotesWindow,
      setNotesWindowAlwaysOnTop,
      scene,
      sceneEditMode,
      selectedSceneSourceId,
      setSceneEditMode,
      setSelectedSceneSourceId,
      audioMeter,
      audioMeterLoading,
      mediaAccess,
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
      applyLayoutPatch,
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
      authorizeXLive,
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
      setSceneSourceTransform,
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
      ensureSessionPoster,
      renameSession,
      deleteSessions,
      duplicateSession,
      importRecording,
      sessionStorageTotals,
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

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
