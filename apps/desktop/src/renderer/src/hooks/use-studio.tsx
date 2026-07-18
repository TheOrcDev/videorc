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

import { BackendClient, BackendRequestError } from '@/backendClient'
import { previewSurfaceBoundsChanged } from '../../../shared/native-preview-bounds'
import {
  commentsRefreshRevisionIsCurrent,
  reconcileCommentsSendOperation
} from '../../../shared/comments-send-operation'
import { nativePreviewStatusProvesSceneRevision } from '../../../shared/native-preview-scene-authority'
import { compositorStatusFromFrameReady } from '../../../shared/compositor-frame-ready'
import { rendererCompositorUpdateWasAccepted } from '../../../shared/native-preview-present-ownership'
import type {
  WindowsLiveAudioSmokeRequest,
  WindowsLiveAudioSmokeState,
  WindowsLiveAudioSmokeTelemetry
} from '../../../shared/windows-live-audio-smoke'
import { cloudAiReadiness } from '@/lib/ai-readiness'
import {
  applyStoredManualStreamKeyResult,
  auxiliaryStreamOutputVideoSettings,
  bridgeStreamingToLegacy,
  buildCameraSources,
  areEnabledStreamTargetsStartReady,
  coerceVideoToOrientation,
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
  reconcileSourceSelectionForLayoutTransaction,
  rtmpDefaults,
  smokePreviewCompositorCaptureConfig,
  sourceSelectionChangeEvents,
  layoutPresetMemoryPatch,
  layoutPresetOrientation,
  STORAGE_KEYS,
  streamOutputVideosForTargets,
  streamOutputVideoSettings,
  verticalOrientationVideoPatch,
  videoProfileCompatibility,
  videoPresets,
  type CaptureConfig,
  type SettingsState,
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
import { providerOAuthRetryDelayMs } from '@/lib/provider-oauth-retry'
import { accountCallbackRetryDelayMs } from '@/lib/account-callback-retry'
import {
  LatestRequestByKey,
  SingleFlightByKey,
  SingleFlightGeneration
} from '@/lib/single-flight-generation'
import {
  latestLayoutTransactionCommit,
  layoutTransactionBackendSnapshotIsStable,
  layoutTransactionFailureReconciliation,
  layoutTransactionProofDisposition,
  layoutTransactionUnprovenSeverity,
  liveBackgroundCommitDecision,
  NativePreviewPresentationProofError,
  shouldReloadSceneFromCaptureConfig
} from '@/lib/layout-transaction-policy'
import {
  nativePreviewFramePollingShouldSuppress,
  nativePreviewSurfaceSyncCanCommit,
  nativePreviewSurfaceSyncNeedsCreate
} from '@/lib/native-preview-surface-lifecycle'
import type {
  AccountCallbackEnvelope,
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
  AudioProcessingUpdateResult,
  BackendConnection,
  BackendHealth,
  BackendLogEvent,
  CommentsWindowState,
  CompositorFrameReady,
  CompositorStatus,
  DiagnosticStats,
  ClipExportResult,
  ClipSuggestResult,
  Device,
  DeviceList,
  EntitlementsSnapshot,
  NoiseCleanupJob,
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
  CaptionStyleId,
  LiveChatSnapshot,
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
  OAuthCallbackEnvelope,
  OAuthStartResult,
  OAuthProviderCredentialStatus,
  RecordingStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SceneCommitStatus,
  SceneConfigParams,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionDetails,
  SessionListPage,
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
  captionDwellMs,
  captionLineAboveFloor,
  captionLineIdentity,
  captionOverlayKey,
  captionOverlayTargetPlan,
  captionSessionFloor,
  CaptionCueRenderGuard,
  captionsStatusIsActive,
  decideCaptionsRuntimeIntent,
  decideOverlayPush,
  LatestWinsScheduler,
  shouldCancelCaptionCueRender,
  type CaptionSessionFloor
} from '@/lib/captions-ui'
import {
  captionRuntimeStartBlocked,
  captionSessionOutputReadiness,
  decideGoLiveCaptionsReadiness,
  type GoLiveCaptionsReadiness
} from '@/lib/captions-preflight'
import { goLiveEntitlementGate, videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { upsertNoiseCleanupJob } from '@/lib/noise-cleanup-view'
import {
  applyLiveChatMessages,
  applyLiveChatProviderStatus,
  applyLiveChatSnapshot,
  chatSetupToastWarnings,
  liveChatSendOperationQueryDecision,
  MAX_LIVE_CHAT_VIEW_MESSAGES,
  LiveChatRecoveryOverflowError,
  LiveChatMessageBatcher,
  reconcileLiveChatRecovery,
  replayLiveChatBootstrapEvents,
  runBoundedLiveChatRecovery,
  type LiveChatSendOperationsQueryResult,
  type LiveChatBootstrapEvent
} from '@/lib/live-chat-view'
import { CHAT_PLATFORM_LABELS } from '@/components/chat-platform-icon'
import {
  buildNativePreviewCompositorUpdateParams,
  compositorStatusHasRenderedSceneRevision,
  decideNativePreviewCompositorPresent,
  nativePreviewDroppedFramesWithSuppressed,
  rendererFallbackCompositorStatusIsFresh,
  rendererFallbackSeedCompositorStatus,
  rendererFallbackOwnsPresentation,
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
import { findDevice, isActiveRecordingState, mergeStreamHealth } from '@/lib/format'
import {
  activeAudioProcessingUpdateParams,
  LatestWinsLiveAudioProcessingQueue,
  liveAudioProcessingSessionSyncDecision,
  rejectedLiveAudioProcessingUpdate,
  type LiveAudioProcessingSessionStartSnapshot,
  type LiveAudioProcessingValues
} from '@/lib/live-audio-processing'
import {
  loadValidatedPlatformAccountsOnIsolatedClient,
  StudioBootstrapGuard
} from '@/lib/studio-bootstrap'
import {
  deviceListWithoutProtectedOverlayWindows,
  protectedOverlayWindowIdsFromOverlayWindows
} from '@/lib/protected-overlay-windows'
import {
  configureWindowsLiveAudioSmokeCapture,
  WINDOWS_LIVE_AUDIO_SMOKE_BURST,
  windowsLiveAudioSmokeState
} from '@/lib/windows-live-audio-smoke-harness'

export type { GoLivePartialSetup, GoLiveSetupFailure } from '@/lib/go-live-flow'

type CaptionOverlayWork = {
  client: BackendClient
  epoch: number
  key: string
  text: string
  outputs: Array<{
    target: 'primary' | 'auxiliary'
    canvasWidth: number
    canvasHeight: number
  }>
  styleId: CaptionStyleId
  styleRevision: number
  textSize: 's' | 'm' | 'l'
  position: 'top' | 'bottom'
}

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
const AI_CONSENT_STORAGE_KEY = 'videorc.aiConsent'

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
const SIGNED_IN_ENTITLEMENT_REFRESH_INTERVAL_MS = 5 * 60_000
const LIVE_CHAT_RECOVERY_RETRY_DELAY_MS = 250
const SESSION_LIST_PAGE_LIMIT = 50
export const SESSION_DETAIL_BUFFER_LIMIT = 120
const SESSION_DETAIL_CACHE_LIMIT = 8

export function capSessionDetailBuffer<T>(entries: T[]): T[] {
  return entries.slice(-SESSION_DETAIL_BUFFER_LIMIT)
}

function mergeSessionDetailEntries<TEntry extends { id: string; createdAt: string }>(
  ...collections: TEntry[][]
): TEntry[] {
  const byId = new Map<string, TEntry>()
  for (const collection of collections) {
    for (const entry of collection) byId.set(entry.id, entry)
  }
  return capSessionDetailBuffer(
    [...byId.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )
  )
}

function appendBoundedSessionDetailEntry<TEntry>(entries: TEntry[], entry: TEntry): void {
  entries.push(entry)
  const overflow = entries.length - SESSION_DETAIL_BUFFER_LIMIT
  if (overflow > 0) entries.splice(0, overflow)
}

async function requestLiveChatSendOperations(
  request: () => Promise<CommentsSendOperation[]>
): Promise<LiveChatSendOperationsQueryResult> {
  try {
    return { ok: true, operations: await request() }
  } catch {
    return { ok: false }
  }
}

function successfulEmptyLiveChatSendOperationsQuery(): LiveChatSendOperationsQueryResult {
  return { ok: true, operations: [] }
}

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
// Fallback-pump dedupe (issue #157): an unchanged compositor status carries no
// new pixels, so resubmitting it at 60Hz only burns main-process present work.
// A bounded refresh still goes through so main's staleness/liveness gates keep
// seeing a heartbeat while the compositor is genuinely idle.
const NATIVE_PREVIEW_FALLBACK_LIVENESS_REFRESH_MS = 1000
const NATIVE_PREVIEW_COMPOSITOR_TIMING_SAMPLE_LIMIT = 900
const NATIVE_PREVIEW_SCENE_FRAME_WAIT_TIMEOUT_MS = 750
const NATIVE_PREVIEW_SCENE_FRAME_WAIT_INTERVAL_MS = 33
// The native surface presents latest-wins on a busy GPU while streaming; its
// presented-revision readback routinely needs more than the 750 ms compositor
// frame window. Budget it separately, below the 5 s live output proof.
const NATIVE_PREVIEW_SCENE_PROOF_WAIT_TIMEOUT_MS = 3000
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
      latestStatus = await activeClient.requestTyped('compositor.status')
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

  const deadline = Date.now() + NATIVE_PREVIEW_SCENE_PROOF_WAIT_TIMEOUT_MS
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
        activeClient.requestTyped('compositor.status'),
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
  captureConfigPatch?: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'>
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
  noiseCleanupJobs: NoiseCleanupJob[]
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
  sessionsNextCursor: string | null
  sessionsLoadingMore: boolean
  sessionDetails: Readonly<Record<string, SessionDetails>>
  sessionDetailsLoading: ReadonlySet<string>
  sessionDetailError: { sessionId: string; message: string } | null
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
  captionsCommandPending: boolean
  startCaptions: (language?: string) => Promise<void>
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
  goLiveCaptionsReadiness: GoLiveCaptionsReadiness
  continueGoLiveWithoutCaptions: () => void
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
  /** Persists across launches (durable preference, not a per-launch answer). */
  setAiConsent: (consent: boolean) => void
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
  loadMoreSessions: () => Promise<void>
  loadSessionDetails: (sessionId: string) => Promise<void>
  refreshEntitlements: () => Promise<void>
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
  reorderScreen: (screenId: string, targetIndex: number) => Promise<void>
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
  handleSystemPermission: (pane: SystemPermissionPane) => Promise<void>
  openSystemPermissionSettings: (pane: SystemPermissionPane) => Promise<void>
  revealPermissionTarget: () => Promise<void>
  exportSupportBundle: () => Promise<void>
  registerPreviewSurfaceResize: () => void
  syncNativePreviewSurfaceBounds: (
    bounds: PreviewSurfaceBounds,
    generation?: number
  ) => Promise<void>
  sampleAudioMeter: () => Promise<boolean>
  startSession: () => Promise<void>
  stopSession: () => Promise<void>
  remuxSession: (sessionId: string) => Promise<void>
  ensureSessionPoster: (sessionId: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSessions: (targets: SessionSummary[]) => Promise<void>
  duplicateSession: (sessionId: string) => Promise<void>
  importRecording: () => Promise<void>
  startNoiseCleanup: (sessionId: string) => Promise<NoiseCleanupJob>
  cancelNoiseCleanup: (jobId: string) => Promise<NoiseCleanupJob>
  sessionStorageTotals: SessionStorageTotals | null
  runAiWorkflow: (
    sessionId: string,
    options?: { outputs?: string[]; tone?: string }
  ) => Promise<void>
  exportPublishPack: (sessionId: string) => Promise<void>
  /** Rank clip-worthy moments locally (chat spikes + captions). */
  suggestClips: (sessionId: string) => Promise<ClipSuggestResult | null>
  /** Trim a clip out of the recording locally (ffmpeg, next to the file). */
  exportClip: (sessionId: string, startMs: number, endMs: number) => Promise<void>
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
  meterLevel: number
  canSampleAudio: boolean
}

export type StudioCoreContextValue = Omit<
  StudioContextValue,
  | 'diagnosticStats'
  | 'healthEvents'
  | 'liveChatSnapshot'
  | 'logs'
  | 'previewCameraStatus'
  | 'previewLiveStatus'
  | 'previewScreenStatus'
  | 'streamHealth'
  | 'previewSurfaceStatus'
  | 'audioMeter'
  | 'audioMeterLoading'
  | 'meterLevel'
  | 'recording'
>

export type StudioRecordingStateContextValue = {
  recording: Pick<RecordingStatus, 'state' | 'sessionId'>
}

export type StudioRecordingContextValue = Pick<StudioContextValue, 'recording'>

export type StudioPreviewContextValue = Pick<
  StudioContextValue,
  'previewLiveStatus' | 'previewCameraStatus' | 'previewScreenStatus'
>

interface StudioDiagnosticsContextValue {
  diagnosticStats: DiagnosticStats
  healthEvents: HealthEvent[]
  logs: BackendLogEvent[]
  streamHealth: StreamHealth | null
  previewSurfaceStatus: PreviewSurfaceStatus
}

interface StudioChatContextValue {
  liveChatSnapshot: LiveChatSnapshot
}

interface StudioAudioContextValue {
  audioMeter: AudioMeterResult | null
  audioMeterLoading: boolean
  meterLevel: number
}

const StudioContext = createContext<StudioCoreContextValue | null>(null)
const StudioRecordingStateContext = createContext<StudioRecordingStateContextValue | null>(null)
const StudioRecordingContext = createContext<StudioRecordingContextValue | null>(null)
const StudioPreviewContext = createContext<StudioPreviewContextValue | null>(null)
const StudioDiagnosticsContext = createContext<StudioDiagnosticsContextValue | null>(null)
const StudioChatContext = createContext<StudioChatContextValue | null>(null)
const StudioAudioContext = createContext<StudioAudioContextValue | null>(null)

interface StudioShellContextValue {
  wsStatus: WsStatus
  backendConnected: boolean
  recordingState: RecordingStatus['state']
  runtimeInfo: RuntimeInfo | null
  entitlementTier: EntitlementsSnapshot['tier'] | null
  previewWindowOpen: boolean
  togglePreviewWindow: () => Promise<void>
  notesWindowOpen: boolean
  openNotesWindow: () => Promise<void>
  closeNotesWindow: () => Promise<void>
  commentsWindowOpen: boolean
  openCommentsWindow: () => Promise<void>
  closeCommentsWindow: () => Promise<void>
  toggleCommentsWindow: () => Promise<void>
  toggleCaptionsWindow: () => Promise<void>
}

const StudioShellContext = createContext<StudioShellContextValue | null>(null)

const idleDiagnosticStats = (): DiagnosticStats => ({
  skippedFrames: 0,
  droppedFrames: 0,
  encoderBridgeQueueDepth: 0,
  encoderBridgeOutputQueueOldestFrameAgeMs: undefined,
  encoderBridgeOutputQueueCapacityPressureEvents: 0,
  encoderBridgeOutputQueueDroppedFrames: 0,
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
  encoderBridgeRecordingQueueDepth: 0,
  encoderBridgeRecordingQueueOldestFrameAgeMs: undefined,
  encoderBridgeRecordingQueueCapacityPressureEvents: 0,
  encoderBridgeRecordingQueueDroppedFrames: 0,
  encoderBridgeStreamQueueDepth: 0,
  encoderBridgeStreamQueueOldestFrameAgeMs: undefined,
  encoderBridgeStreamQueueCapacityPressureEvents: 0,
  encoderBridgeStreamQueueDroppedFrames: 0,
  encoderBridgeRecordingWriterLoopP95Ms: undefined,
  encoderBridgeStreamWriterLoopP95Ms: undefined,
  encoderBridgeRecordingWriterActiveP95Ms: undefined,
  encoderBridgeStreamWriterActiveP95Ms: undefined,
  encoderBridgeRecordingVideoToolboxFifoEnqueueP95Ms: undefined,
  encoderBridgeStreamVideoToolboxFifoEnqueueP95Ms: undefined,
  encoderBridgeRecordingVideoToolboxFifoEnqueueMaxMs: undefined,
  encoderBridgeStreamVideoToolboxFifoEnqueueMaxMs: undefined,
  compositorCpuFallbackFrames: 0,
  websocketTransport: {
    reliableResponseQueue: {
      currentDepth: 0,
      maxDepth: 0,
      oldestAgeMs: undefined,
      coalescedCount: 0,
      evictedOrDroppedCount: 0
    },
    incomingCommandQueue: {
      currentDepth: 0,
      maxDepth: 0,
      oldestAgeMs: undefined,
      coalescedCount: 0,
      evictedOrDroppedCount: 0
    },
    coalescedTelemetryQueue: {
      currentDepth: 0,
      maxDepth: 0,
      oldestAgeMs: undefined,
      coalescedCount: 0,
      evictedOrDroppedCount: 0
    },
    slowPressureDisconnectCount: 0
  },
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

export function useStudioCore(): StudioCoreContextValue {
  const value = useContext(StudioContext)
  if (!value) {
    throw new Error('useStudioCore must be used within a StudioProvider')
  }
  return value
}

export function useStudioDiagnostics(): StudioDiagnosticsContextValue {
  const value = useContext(StudioDiagnosticsContext)
  if (!value) {
    throw new Error('useStudioDiagnostics must be used within a StudioProvider')
  }
  return value
}

export function useStudioRecordingState(): StudioRecordingStateContextValue {
  const value = useContext(StudioRecordingStateContext)
  if (!value) {
    throw new Error('useStudioRecordingState must be used within a StudioProvider')
  }
  return value
}

export function useStudioPreview(): StudioPreviewContextValue {
  const value = useContext(StudioPreviewContext)
  if (!value) {
    throw new Error('useStudioPreview must be used within a StudioProvider')
  }
  return value
}

export function useStudioRecording(): StudioRecordingContextValue {
  const value = useContext(StudioRecordingContext)
  if (!value) {
    throw new Error('useStudioRecording must be used within a StudioProvider')
  }
  return value
}

export function useStudioChat(): StudioChatContextValue {
  const value = useContext(StudioChatContext)
  if (!value) {
    throw new Error('useStudioChat must be used within a StudioProvider')
  }
  return value
}

export function useStudioAudio(): StudioAudioContextValue {
  const value = useContext(StudioAudioContext)
  if (!value) {
    throw new Error('useStudioAudio must be used within a StudioProvider')
  }
  return value
}

/** Compatibility hook for consumers that genuinely span every state domain. */
export function useStudio(): StudioContextValue {
  const core = useStudioCore()
  const recording = useStudioRecording()
  const preview = useStudioPreview()
  const diagnostics = useStudioDiagnostics()
  const chat = useStudioChat()
  const audio = useStudioAudio()
  return useMemo(
    () => ({ ...core, ...recording, ...preview, ...diagnostics, ...chat, ...audio }),
    [audio, chat, core, diagnostics, preview, recording]
  )
}

export function useStudioShell(): StudioShellContextValue {
  const value = useContext(StudioShellContext)
  if (!value) {
    throw new Error('useStudioShell must be used within a StudioProvider')
  }
  return value
}

type StudioContextProvidersProps = {
  core: StudioCoreContextValue
  recordingState: StudioRecordingStateContextValue
  recording: StudioRecordingContextValue
  preview: StudioPreviewContextValue
  diagnostics: StudioDiagnosticsContextValue
  chat: StudioChatContextValue
  audio: StudioAudioContextValue
  children?: ReactNode
}

/**
 * Keep volatile Studio domains behind their own providers. Besides making the
 * ownership explicit, this boundary is independently render-testable: a
 * recording elapsed-time or preview telemetry update must not publish a new
 * core context value to unrelated consumers.
 */
export function StudioContextProviders({
  core,
  recordingState,
  recording,
  preview,
  diagnostics,
  chat,
  audio,
  children
}: StudioContextProvidersProps): ReactElement {
  return (
    <StudioContext.Provider value={core}>
      <StudioRecordingStateContext.Provider value={recordingState}>
        <StudioRecordingContext.Provider value={recording}>
          <StudioPreviewContext.Provider value={preview}>
            <StudioDiagnosticsContext.Provider value={diagnostics}>
              <StudioChatContext.Provider value={chat}>
                <StudioAudioContext.Provider value={audio}>{children}</StudioAudioContext.Provider>
              </StudioChatContext.Provider>
            </StudioDiagnosticsContext.Provider>
          </StudioPreviewContext.Provider>
        </StudioRecordingContext.Provider>
      </StudioRecordingStateContext.Provider>
    </StudioContext.Provider>
  )
}

export function StudioProvider({ children }: { children: ReactNode }): ReactElement {
  const [connection, setConnection] = useState<BackendConnection | null>(null)
  const [client, setClient] = useState<BackendClient | null>(null)
  const clientRef = useRef<BackendClient | null>(null)
  const accountCallbacksInFlightRef = useRef<Set<string>>(new Set())
  const accountCallbacksCompletedRef = useRef<Set<string>>(new Set())
  const providerOAuthCallbacksInFlightRef = useRef<Set<string>>(new Set())
  const providerOAuthCallbacksCompletedRef = useRef<Set<string>>(new Set())
  const bootstrapGenerationRef = useRef(0)
  const focusRefreshCoordinatorRef = useRef(new SingleFlightGeneration())
  const [wsStatus, setWsStatus] = useState<WsStatus>('waiting')
  const wsStatusRef = useRef<WsStatus>('waiting')
  clientRef.current = client
  wsStatusRef.current = wsStatus
  const [health, setHealth] = useState<BackendHealth | null>(null)
  const [entitlements, setEntitlements] = useState<EntitlementsSnapshot | null>(null)
  const [noiseCleanupJobs, setNoiseCleanupJobs] = useState<NoiseCleanupJob[]>([])
  const announcedNoiseCleanupCompletionsRef = useRef(new Set<string>())
  const entitlementRefreshInFlightRef = useRef<Promise<EntitlementsSnapshot> | null>(null)
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
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null)
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false)
  const sessionListGenerationRef = useRef(0)
  const sessionListRefreshRequestRef = useRef(new LatestRequestByKey<'first-page'>())
  const sessionListMoreSingleFlightRef = useRef(new SingleFlightByKey<'next-page', BackendClient>())
  const [sessionDetails, setSessionDetails] = useState<Record<string, SessionDetails>>({})
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState<Set<string>>(() => new Set())
  const [sessionDetailError, setSessionDetailError] = useState<{
    sessionId: string
    message: string
  } | null>(null)
  const sessionDetailsRef = useRef(sessionDetails)
  sessionDetailsRef.current = sessionDetails
  const sessionDetailRecencyRef = useRef<string[]>([])
  const sessionDetailRequestRef = useRef(new LatestRequestByKey<string>())
  const sessionDetailSingleFlightRef = useRef(new SingleFlightByKey<string, BackendClient>())
  const sessionDetailAiDirtyRef = useRef(new Set<string>())
  const sessionDetailLiveEntriesRef = useRef(
    new Map<string, { healthEvents: HealthEvent[]; sessionLogs: SessionLogEntry[] }>()
  )
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
  const refreshEntitlementsForClient = useCallback(
    async (activeClient: BackendClient): Promise<EntitlementsSnapshot> => {
      if (entitlementRefreshInFlightRef.current) {
        return entitlementRefreshInFlightRef.current
      }
      const refresh = activeClient
        .requestTyped('entitlements.refresh', undefined)
        .then((snapshot) => {
          // The backend returns the current fail-closed snapshot even when its
          // server revalidation fails. Never merge it with stale local state.
          if (clientRef.current === activeClient) {
            setEntitlements(snapshot)
          }
          return snapshot
        })
      entitlementRefreshInFlightRef.current = refresh
      try {
        return await refresh
      } finally {
        if (entitlementRefreshInFlightRef.current === refresh) {
          entitlementRefreshInFlightRef.current = null
        }
      }
    },
    []
  )
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
  const latestLiveChatSendOperationRef = useRef<CommentsSendOperation | undefined>(undefined)
  const liveChatSendOperationRevisionRef = useRef(0)
  const replaceLiveChatSendOperation = useCallback(
    (
      operation: CommentsSendOperation | undefined,
      options: { publishSnapshot?: boolean } = {}
    ): void => {
      const current = latestLiveChatSendOperationRef.current
      const next = operation
        ? current?.sessionId === operation.sessionId
          ? reconcileCommentsSendOperation(current, operation)
          : operation
        : undefined
      latestLiveChatSendOperationRef.current = next
      liveChatSendOperationRevisionRef.current += 1
      if (options.publishSnapshot) {
        const snapshot = liveChatSnapshotRef.current
        void window.videorc?.pushCommentsSnapshot?.({
          mode: { kind: 'live' },
          snapshot,
          latestSendOperation: next?.sessionId === snapshot.sessionId ? next : undefined
        })
      }
    },
    []
  )
  const applyLiveChatSendOperation = useCallback(
    (operation: CommentsSendOperation): void => {
      replaceLiveChatSendOperation(operation, { publishSnapshot: true })
    },
    [replaceLiveChatSendOperation]
  )
  const applyLiveChatSendOperationsQuery = useCallback(
    (
      result: LiveChatSendOperationsQueryResult,
      sessionId: string | undefined,
      revisionAtStart: number
    ): CommentsSendOperation | undefined => {
      const decision = liveChatSendOperationQueryDecision({
        result,
        sessionId,
        revisionAtStart,
        currentRevision: liveChatSendOperationRevisionRef.current
      })
      if (decision.kind === 'replace') {
        replaceLiveChatSendOperation(decision.operation)
      }
      const current = latestLiveChatSendOperationRef.current
      return current?.sessionId === sessionId ? current : undefined
    },
    [replaceLiveChatSendOperation]
  )
  const clearLiveChat = useCallback(async () => {
    if (!client) return
    await client.request('liveChat.clearLocal')
  }, [client])
  // A silently empty Comments feed must never be the only signal that chat
  // setup failed at go-live (2026-07-10: Twitch chat needed a reconnect and
  // the failure lived only in a backend warn log). Toast each broken
  // destination once per session, with a jump to the Livestream tab.
  const chatSetupWarnedRef = useRef<{ sessionId?: string; warned: Set<string> }>({
    warned: new Set()
  })
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)
  useEffect(() => {
    const sessionId = liveChatSnapshot.sessionId
    if (!sessionId) {
      return
    }
    // Chat setup warnings are a GO-LIVE concern. The backend no longer
    // attaches chat providers to record-only sessions, and this gate keeps a
    // future backend regression from nagging every recording about comments
    // (owner report 2026-07-13: "Twitch comments are not connected" toast on
    // every record with a disconnected Twitch target configured).
    if (!captureConfig.streamEnabled) {
      return
    }
    if (chatSetupWarnedRef.current.sessionId !== sessionId) {
      chatSetupWarnedRef.current = { sessionId, warned: new Set() }
    }
    for (const warning of chatSetupToastWarnings(liveChatSnapshot.providers)) {
      if (chatSetupWarnedRef.current.warned.has(warning.id)) {
        continue
      }
      chatSetupWarnedRef.current.warned.add(warning.id)
      toast.warning(`${CHAT_PLATFORM_LABELS[warning.platform]} comments are not connected`, {
        description: warning.message,
        action: {
          label: 'Open Livestream',
          onClick: () =>
            window.dispatchEvent(
              new CustomEvent(WORKSPACE_NAVIGATE_EVENT, { detail: { tab: 'streaming' } })
            )
        }
      })
    }
  }, [liveChatSnapshot, captureConfig.streamEnabled])
  // Live captions: status + transcript driven by captions.* events; the mic
  // audio itself never reaches the renderer (the Rust backend uploads chunks).
  const [captionsStatus, setCaptionsStatus] = useState<CaptionsStatus>({ state: 'idle' })
  const captionsStatusRevisionRef = useRef(0)
  const commitCaptionsStatus = useCallback((status: CaptionsStatus): void => {
    captionsStatusRevisionRef.current += 1
    setCaptionsStatus(status)
  }, [])
  const [captionLines, setCaptionLines] = useState<CaptionsUpdate[]>([])
  const captionLinesRef = useRef(captionLines)
  captionLinesRef.current = captionLines
  // Captions belong to the video they were spoken in: recorded at each
  // capture-session start (see the rising-edge effect below), this floor
  // rejects late transcripts of previous-video audio — the chunked uploader's
  // responses can land seconds after the next recording began, and the
  // capture-epoch filter only guards the .srt/burn chunks, not these events.
  const captionSessionFloorRef = useRef<CaptionSessionFloor | null>(null)
  const [captionsCommandPending, setCaptionsCommandPending] = useState(false)
  const captionsCommandTailRef = useRef<Promise<void>>(Promise.resolve())
  const captionsCommandCountRef = useRef(0)
  const runCaptionsCommand = useCallback(
    (command: () => Promise<CaptionsStatus>): Promise<CaptionsStatus> => {
      captionsCommandCountRef.current += 1
      setCaptionsCommandPending(true)
      const result = captionsCommandTailRef.current.catch(() => undefined).then(command)
      captionsCommandTailRef.current = result.then(
        () => undefined,
        () => undefined
      )
      const finish = (): void => {
        captionsCommandCountRef.current = Math.max(0, captionsCommandCountRef.current - 1)
        if (captionsCommandCountRef.current === 0) setCaptionsCommandPending(false)
      }
      void result.then(finish, finish)
      return result
    },
    []
  )
  const startCaptions = useCallback(
    async (language = 'auto') => {
      // F-022: both failure shapes must THROW so the toggle's error handler can
      // toast — a missing client and a non-live status used to revert the switch
      // silently.
      if (!client) {
        throw new Error('Backend is not connected — try again in a moment.')
      }
      setCaptionLines([])
      const status = await runCaptionsCommand(() =>
        client.request<CaptionsStatus>('captions.start', {
          language: language === 'auto' ? undefined : language
        })
      )
      commitCaptionsStatus(status)
      if (!captionsStatusIsActive(status) && status.state !== 'ready') {
        throw new Error(status.message ?? `Live captions did not start (status: ${status.state}).`)
      }
    },
    [client, commitCaptionsStatus, runCaptionsCommand]
  )
  const stopCaptions = useCallback(async () => {
    if (!client) return
    const status = await runCaptionsCommand(() => client.request<CaptionsStatus>('captions.stop'))
    commitCaptionsStatus(status)
  }, [client, commitCaptionsStatus, runCaptionsCommand])
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
    void window.videorc?.pushCaptionSnapshot?.({
      lines: captionLines,
      status: captionsStatus,
      styleId: captureConfig.captions.styleId,
      position: captureConfig.captions.position,
      textSize: captureConfig.captions.textSize
    })
  }, [captionLines, captionsStatus, captureConfig.captions])
  const openCaptionsWindow = useCallback(async () => {
    await window.videorc
      ?.pushCaptionSnapshot?.({
        lines: captionLines,
        status: captionsStatus,
        styleId: captureConfig.captions.styleId,
        position: captureConfig.captions.position,
        textSize: captureConfig.captions.textSize
      })
      .catch(() => {})
    await window.videorc?.openCaptionsWindow?.()
  }, [captionLines, captionsStatus, captureConfig.captions])
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
    const sendOperationRevisionAtStart = liveChatSendOperationRevisionRef.current
    const operationsResult = next.sessionId
      ? await requestLiveChatSendOperations(() =>
          client.request<CommentsSendOperation[]>('liveChat.sendOperations.list', {
            sessionId: next.sessionId
          })
        )
      : successfulEmptyLiveChatSendOperationsQuery()
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
    const latestSendOperation = applyLiveChatSendOperationsQuery(
      operationsResult,
      next.sessionId,
      sendOperationRevisionAtStart
    )
    await window.videorc?.pushCommentsSnapshot?.({
      mode: { kind: 'live' },
      snapshot: currentSnapshot,
      latestSendOperation
    })
  }, [applyLiveChatSendOperationsQuery, client, replaceLiveChatSnapshotState])
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
        let messages: LiveChatMessage[] = []
        let cursor: string | undefined
        do {
          const page: SessionCommentsPage = await client.requestTyped('sessions.comments.list', {
            sessionId,
            cursor,
            limit: Math.min(200, MAX_LIVE_CHAT_VIEW_MESSAGES - messages.length)
          })
          messages = [...page.messages, ...messages].slice(-MAX_LIVE_CHAT_VIEW_MESSAGES)
          cursor = page.nextCursor
        } while (cursor && messages.length < MAX_LIVE_CHAT_VIEW_MESSAGES)
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
  const [suppressCaptionsForSession, setSuppressCaptionsForSession] = useState(false)
  const captionOutputReadiness = useMemo(() => {
    const streamVideos = streamOutputVideosForTargets(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined
    ).map(({ video }) => video)
    return captionSessionOutputReadiness({
      burnTarget: captureConfig.captions.burnTarget,
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: captureConfig.streamEnabled,
      recordingVideo: captureConfig.video,
      streamVideos
    })
  }, [captureConfig])
  const goLiveCaptionsReadiness = useMemo(
    () =>
      decideGoLiveCaptionsReadiness({
        persistedEnabled: captureConfig.captions.enabled,
        suppressForSession: suppressCaptionsForSession,
        capabilities: aiCapabilities,
        outputReadiness: captionOutputReadiness
      }),
    [
      aiCapabilities,
      captionOutputReadiness,
      captureConfig.captions.enabled,
      suppressCaptionsForSession
    ]
  )
  const continueGoLiveWithoutCaptions = useCallback(() => setSuppressCaptionsForSession(true), [])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLiveStatus, setPreviewLiveStatus] = useState<PreviewLiveStatus>({
    state: 'unavailable',
    source: 'unavailable',
    transport: 'unavailable',
    backing: 'none',
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
  const audioMeterRef = useRef<AudioMeterResult | null>(null)
  const audioMeterSampleGenerationRef = useRef(0)
  // A fresh mic grant can defer its backend restart until capture becomes idle.
  // Remember the pre-grant client so proof can run only on the replacement.
  const [pendingMicrophonePermissionProof, setPendingMicrophonePermissionProof] = useState<
    | (import('@/lib/system-permission-orchestration').MicrophonePermissionProof & {
        retry: number
      })
    | null
  >(null)
  audioMeterRef.current = audioMeter
  const [audioMeterLoading, setAudioMeterLoading] = useState(false)
  // The OS's exact camera/mic access state (Electron getMediaAccessStatus).
  // This distinguishes never-asked from denied on macOS and is the only
  // truthful privacy-toggle signal on Windows.
  const [mediaAccess, setMediaAccess] = useState<MediaAccessSnapshot | null>(null)
  const refreshMediaAccess = useCallback(async (): Promise<MediaAccessSnapshot | null> => {
    const bridge = window.videorc?.getMediaAccessStatus
    if (!bridge) {
      return null
    }
    try {
      const snapshot = await bridge()
      setMediaAccess(snapshot)
      return snapshot
    } catch {
      // Non-fatal: callers retain the last exact snapshot and the rows fall
      // back to backend device/meter evidence when none has ever loaded.
      return null
    }
  }, [])
  // Cloud-AI consent is a durable preference, not a per-launch answer: it
  // silently resetting to off every launch was the top reason publish runs
  // "did nothing but extract audio" (2026-07-11 report).
  const [aiConsent, setAiConsentState] = useState(
    () => localStorage.getItem(AI_CONSENT_STORAGE_KEY) === '1'
  )
  const setAiConsent = useCallback((consent: boolean) => {
    setAiConsentState(consent)
    localStorage.setItem(AI_CONSENT_STORAGE_KEY, consent ? '1' : '0')
  }, [])
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
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Stable handle for callbacks that only need to READ the config (labels,
  // lookups) without re-creating themselves on every config change.
  const lastRecordingStateRef = useRef<string | null>(null)
  // Quality-gate toast dedupe: the gate can re-emit an updated not-100 verdict for
  // the same session (fast assessment, then post-repair); one toast is enough.
  const qualityToastSessionsRef = useRef<Set<string>>(new Set())
  const captureConfigRef = useRef(captureConfig)
  const liveAudioProcessingSyncRef = useRef<{
    token: object
    sessionId: string
    lastApplied: LiveAudioProcessingValues
    disabled: boolean
    queue: LatestWinsLiveAudioProcessingQueue
  } | null>(null)
  const liveAudioProcessingStartSnapshotRef =
    useRef<LiveAudioProcessingSessionStartSnapshot | null>(null)
  const liveAudioProcessingStartRequestInFlightRef = useRef(false)
  const windowsLiveAudioSmokeTelemetryRef = useRef<WindowsLiveAudioSmokeTelemetry>({
    requestedCount: 0,
    settledCount: 0,
    lastSettled: null
  })
  const layoutIntentIdRef = useRef(Date.now())
  const layoutIntentAwaitingProofRef = useRef<number | null>(null)
  const latestLayoutTransactionCommitRef = useRef<LayoutTransactionSnapshot | null>(null)
  const skipNextConfigSceneReloadRef = useRef(false)
  useEffect(() => {
    captureConfigRef.current = captureConfig
  }, [captureConfig])
  useEffect(
    () => () => {
      liveAudioProcessingSyncRef.current?.queue.stop()
    },
    []
  )
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
  const lastErrorRef = useRef(lastError)
  lastErrorRef.current = lastError
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const previewRequestPending = useRef(false)
  const previewRefreshQueued = useRef(false)
  const previewSurfaceStatusRef = useRef<PreviewSurfaceStatus>(idlePreviewSurfaceStatus())
  // True while the MAIN process pumps presents itself; the renderer's 60Hz
  // relay stays dormant then (it leaked IPC serialization buffers at scale).
  const mainPumpActiveRef = useRef(false)
  const nativePreviewRendererPumpOwnershipGenerationRef = useRef(0)
  const nativePreviewRendererFallbackActivatedAtRef = useRef(0)
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
  const nativePreviewFramePollingRequestKeyRef = useRef<string | null>(null)
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
  const nativePreviewFrameReadyLastEventAtRef = useRef(0)
  const nativePreviewCompositorPresentingRef = useRef(false)
  const nativePreviewCompositorSuppressedPresentsRef = useRef(0)
  const nativePreviewCompositorLastEventAtRef = useRef(0)
  const nativePreviewCompositorPollInFlightRef = useRef(false)
  const nativePreviewCompositorPumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nativePreviewFallbackLastPresentRef = useRef<{ key: string; at: number } | null>(null)
  const nativePreviewCompositorPollIntervalSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorPollRoundTripSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorPresentRoundTripSamplesRef = useRef<number[]>([])
  const nativePreviewCompositorLastPollStartedAtRef = useRef(0)
  const nativePreviewCompositorPollInFlightSkipsRef = useRef(0)
  const nativePreviewSurfacePresentReportPendingRef = useRef<PreviewSurfacePresentParams | null>(
    null
  )
  const nativePreviewSurfacePresentReportInFlightRef = useRef(false)
  const nativePreviewSurfacePresentReportAbortRef = useRef<AbortController | null>(null)
  const nativePreviewSurfacePresentReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const nativePreviewSurfacePresentReportLastSentAtRef = useRef(0)
  const automaticSourceFallbacks = useRef<AutomaticSourceFallbackEvent[]>([])
  const toastedFailedTargets = useRef<Set<string>>(new Set())
  const platformLifecycleRun = useRef(0)
  const platformLifecycleStreamingRef = useRef<StreamingSettings | null>(null)
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
        settings,
        suppressCaptionsForSession
      }),
    [captureConfig, sceneWithBackground, sceneEditMode, settings, suppressCaptionsForSession]
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
    async (
      activeClient: BackendClient | null,
      accountSnapshot: VideorcAccountSnapshot | null,
      isCurrent: () => boolean = () => true
    ) => {
      if (!isCurrent()) {
        return
      }
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
        if (!isCurrent()) {
          return
        }
        setAiCapabilities(nextCapabilities)
        setAiQuota(nextQuota)
        setAiReadinessError(null)
      } catch (error) {
        if (!isCurrent()) {
          return
        }
        setAiCapabilities(null)
        setAiQuota(null)
        setAiReadinessError(error instanceof Error ? error.message : String(error))
      } finally {
        if (isCurrent()) {
          setAiReadinessLoading(false)
        }
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

  // Smoke-only state hydration for harnesses that start a capture through a
  // second backend client. It uses the same authoritative status query and
  // reducer as normal bootstrap, without reloading the renderer mid-session.
  useEffect(() => {
    const smokeWindow = window as Window & {
      __videorcSmokeHydrateRecordingStatus?: () => Promise<RecordingStatus>
    }
    if (!runtimeInfo?.previewSmokeMode || !client) {
      delete smokeWindow.__videorcSmokeHydrateRecordingStatus
      return
    }
    smokeWindow.__videorcSmokeHydrateRecordingStatus = async () => {
      const status = await client.requestTyped('recording.status')
      applyRecordingStatus(status)
      return status
    }
    return () => {
      delete smokeWindow.__videorcSmokeHydrateRecordingStatus
    }
  }, [applyRecordingStatus, client, runtimeInfo?.previewSmokeMode])

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
        const reportAbort = new AbortController()
        nativePreviewSurfacePresentReportAbortRef.current = reportAbort
        void activeClient
          .request<PreviewSurfaceStatus>('preview.surface.present', nextParams, {
            signal: reportAbort.signal
          })
          .catch((error: unknown) => {
            if (!(error instanceof Error && error.name === 'AbortError')) {
              console.error('Native preview surface present report failed:', error)
            }
          })
          .finally(() => {
            if (nativePreviewSurfacePresentReportAbortRef.current === reportAbort) {
              nativePreviewSurfacePresentReportAbortRef.current = null
            }
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
      if (mainPumpActiveRef.current) {
        nativePreviewCompositorPendingRef.current = null
        return
      }
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
      const ownershipGeneration = nativePreviewRendererPumpOwnershipGenerationRef.current
      void (async () => {
        try {
          while (nativePreviewCompositorPendingRef.current) {
            if (
              mainPumpActiveRef.current ||
              ownershipGeneration !== nativePreviewRendererPumpOwnershipGenerationRef.current
            ) {
              break
            }
            const nextStatus = nativePreviewCompositorPendingRef.current
            nativePreviewCompositorPendingRef.current = null
            const updateParams = buildNativePreviewCompositorUpdateParams(
              nextStatus,
              nativePreviewRendererTimingStatusFields(),
              {
                recordingActive: isActiveRecordingState(recordingRef.current.state),
                windowOpen: previewWindowRef.current.open,
                status: previewSurfaceStatusRef.current
              }
            )
            const presentStartedAt = performance.now()
            const surfaceStatus = await updateCompositor(updateParams)
            if (!rendererCompositorUpdateWasAccepted(surfaceStatus)) {
              nativePreviewCompositorSuppressedPresentsRef.current += 1
              return
            }
            if (
              mainPumpActiveRef.current ||
              ownershipGeneration !== nativePreviewRendererPumpOwnershipGenerationRef.current
            ) {
              nativePreviewCompositorSuppressedPresentsRef.current += 1
              return
            }
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
          if (nativePreviewCompositorPendingRef.current && !mainPumpActiveRef.current) {
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
    const applyMainPumpActive = (active: boolean): void => {
      const nextActive = active === true
      const wasActive = mainPumpActiveRef.current
      if (wasActive !== nextActive) {
        nativePreviewRendererPumpOwnershipGenerationRef.current += 1
        nativePreviewRendererFallbackActivatedAtRef.current =
          wasActive && !nextActive ? Date.now() : 0
        nativePreviewCompositorLatestStatusRef.current = rendererFallbackSeedCompositorStatus({
          wasMainPumpActive: wasActive,
          nextMainPumpActive: nextActive,
          latestStatus: nativePreviewCompositorLatestStatusRef.current
        })
      }
      mainPumpActiveRef.current = nextActive
      if (nextActive) {
        nativePreviewCompositorPendingRef.current = null
        nativePreviewSurfacePresentReportPendingRef.current = null
        nativePreviewSurfacePresentReportAbortRef.current?.abort()
        nativePreviewSurfacePresentReportAbortRef.current = null
        if (nativePreviewSurfacePresentReportTimerRef.current) {
          clearTimeout(nativePreviewSurfacePresentReportTimerRef.current)
          nativePreviewSurfacePresentReportTimerRef.current = null
        }
      }
      setMainPumpActive(nextActive)
    }
    void window.videorc.getNativePreviewMainPumpActive().then((active) => {
      if (!cancelled) {
        applyMainPumpActive(active === true)
      }
    })
    const unsubscribe = window.videorc.onNativePreviewMainPumpActive?.((active) => {
      applyMainPumpActive(active === true)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  // While main pumps presents, the renderer has no use for the per-frame
  // compact frame-ready firehose — receiving even the small latest-wins lane
  // is unnecessary while main owns presentation. Mute it per connection;
  // unmute the moment this renderer must take over as the fallback pump.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    void client
      .request('events.setExcluded', {
        events: mainPumpActive ? ['preview.frameReady'] : []
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
          // A new frame, run, or scene presents immediately (its key differs);
          // an unchanged status is only re-presented as a bounded liveness
          // refresh instead of 60 times per second.
          const presentKey = `${latestStatus.runId ?? ''}:${latestStatus.framesRendered}:${latestStatus.sceneRevision ?? ''}`
          const lastPresent = nativePreviewFallbackLastPresentRef.current
          if (
            !lastPresent ||
            lastPresent.key !== presentKey ||
            pollStartedAt - lastPresent.at >= NATIVE_PREVIEW_FALLBACK_LIVENESS_REFRESH_MS
          ) {
            nativePreviewFallbackLastPresentRef.current = { key: presentKey, at: pollStartedAt }
            queueNativePreviewCompositorPresent(client, latestStatus)
          }
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
      nativePreviewFallbackLastPresentRef.current = null
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

  const pendingDeletionResumeRef = useRef<Promise<void> | null>(null)
  const resumePendingSessionDeletions = useCallback(
    async (activeClient: BackendClient): Promise<void> => {
      if (pendingDeletionResumeRef.current) {
        return pendingDeletionResumeRef.current
      }
      const pending = (async () => {
        const operations: SessionDeletionOperation[] =
          await activeClient.requestTyped('sessions.delete.pending')
        for (const operation of operations) {
          try {
            await window.videorc?.trashSessionDeletion?.(operation.operationId)
          } catch {
            // The backend tombstone remains pending; the next Library refresh
            // retries the opaque operation id through Electron main.
          }
        }
      })()
      pendingDeletionResumeRef.current = pending
      try {
        await pending
      } finally {
        if (pendingDeletionResumeRef.current === pending) {
          pendingDeletionResumeRef.current = null
        }
      }
    },
    []
  )

  const refreshSessions = useCallback(
    async (activeClient: BackendClient | null) => {
      if (!activeClient) {
        return
      }

      const refreshRequests = sessionListRefreshRequestRef.current
      const requestToken = refreshRequests.begin('first-page')
      sessionListGenerationRef.current += 1
      sessionListMoreSingleFlightRef.current.invalidate('next-page')
      setSessionsLoadingMore(false)
      try {
        await resumePendingSessionDeletions(activeClient)
        const [nextPage, nextTotals] = await Promise.all([
          activeClient.requestTyped('sessions.list', { limit: SESSION_LIST_PAGE_LIMIT }),
          activeClient.request<SessionStorageTotals>('sessions.storage')
        ])
        if (
          clientRef.current !== activeClient ||
          !refreshRequests.isCurrent('first-page', requestToken)
        ) {
          return
        }
        // A next-page request can start while this refresh is in flight using
        // the old cursor. Advancing again at commit prevents it from appending
        // that stale page after the new first page becomes authoritative.
        sessionListGenerationRef.current += 1
        setSessions(nextPage.items)
        setSessionsNextCursor(nextPage.nextCursor ?? null)
        setSessionStorageTotals(nextTotals)
      } finally {
        refreshRequests.finish('first-page', requestToken)
      }
    },
    [resumePendingSessionDeletions]
  )

  const loadMoreSessions = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current
    const cursor = sessionsNextCursor
    if (!activeClient || !cursor) {
      return
    }

    await sessionListMoreSingleFlightRef.current.run('next-page', activeClient, async () => {
      const generation = sessionListGenerationRef.current
      setSessionsLoadingMore(true)
      try {
        const page = await activeClient.requestTyped('sessions.list', {
          cursor,
          limit: SESSION_LIST_PAGE_LIMIT
        })
        if (clientRef.current !== activeClient || sessionListGenerationRef.current !== generation) {
          return
        }
        setSessions((current) => {
          const seen = new Set(current.map((session) => session.id))
          return [...current, ...page.items.filter((session) => !seen.has(session.id))]
        })
        setSessionsNextCursor(page.nextCursor ?? null)
      } finally {
        if (clientRef.current === activeClient && sessionListGenerationRef.current === generation) {
          setSessionsLoadingMore(false)
        }
      }
    })
  }, [sessionsNextCursor])

  const loadSessionDetailsForClient = useCallback(
    (activeClient: BackendClient, sessionId: string): Promise<void> =>
      sessionDetailSingleFlightRef.current.run(sessionId, activeClient, async () => {
        const requestCoordinator = sessionDetailRequestRef.current
        const requestToken = requestCoordinator.begin(sessionId)
        setSessionDetailsLoading((current) => new Set(current).add(sessionId))
        setSessionDetailError((current) => (current?.sessionId === sessionId ? null : current))
        try {
          sessionDetailAiDirtyRef.current.delete(sessionId)
          sessionDetailLiveEntriesRef.current.delete(sessionId)
          const loadAndCommitBatch = async (): Promise<boolean> => {
            const [healthPage, logsPage, artifactsPage] = await Promise.all([
              activeClient.requestTyped('sessions.healthEvents.list', {
                sessionId,
                limit: SESSION_DETAIL_BUFFER_LIMIT
              }),
              activeClient.requestTyped('sessions.logs.list', {
                sessionId,
                limit: SESSION_DETAIL_BUFFER_LIMIT
              }),
              activeClient.requestTyped('sessions.aiArtifacts.list', {
                sessionId,
                limit: SESSION_DETAIL_BUFFER_LIMIT
              })
            ])
            if (
              clientRef.current !== activeClient ||
              !requestCoordinator.isCurrent(sessionId, requestToken)
            ) {
              return false
            }
            const liveEntries = sessionDetailLiveEntriesRef.current.get(sessionId)
            sessionDetailLiveEntriesRef.current.delete(sessionId)
            const loadedDetails: SessionDetails = {
              healthEvents: capSessionDetailBuffer(healthPage.events),
              sessionLogs: capSessionDetailBuffer(logsPage.entries),
              aiArtifacts: capSessionDetailBuffer(artifactsPage.artifacts)
            }
            const recency = [
              ...sessionDetailRecencyRef.current.filter((candidate) => candidate !== sessionId),
              sessionId
            ]
            const evicted = recency.slice(
              0,
              Math.max(0, recency.length - SESSION_DETAIL_CACHE_LIMIT)
            )
            sessionDetailRecencyRef.current = recency.slice(-SESSION_DETAIL_CACHE_LIMIT)
            for (const evictedId of evicted) {
              requestCoordinator.invalidate(evictedId)
              sessionDetailSingleFlightRef.current.invalidate(evictedId)
              sessionDetailAiDirtyRef.current.delete(evictedId)
              sessionDetailLiveEntriesRef.current.delete(evictedId)
            }
            setSessionDetails((current) => {
              const currentDetails = current[sessionId]
              const details: SessionDetails = liveEntries
                ? {
                    healthEvents: mergeSessionDetailEntries(
                      loadedDetails.healthEvents,
                      currentDetails?.healthEvents ?? [],
                      liveEntries.healthEvents
                    ),
                    sessionLogs: mergeSessionDetailEntries(
                      loadedDetails.sessionLogs,
                      currentDetails?.sessionLogs ?? [],
                      liveEntries.sessionLogs
                    ),
                    aiArtifacts: loadedDetails.aiArtifacts
                  }
                : loadedDetails
              const next = { ...current, [sessionId]: details }
              for (const evictedId of evicted) {
                delete next[evictedId]
              }
              return next
            })
            if (evicted.length > 0) {
              const evictedIds = new Set(evicted)
              setSessionDetailsLoading((current) => {
                const next = new Set(current)
                for (const evictedId of evictedIds) {
                  next.delete(evictedId)
                }
                return next
              })
              setSessionDetailError((current) =>
                current && evictedIds.has(current.sessionId) ? null : current
              )
            }
            return true
          }

          const firstBatchCommitted = await loadAndCommitBatch()
          // Changes are coalesced into one bounded trailing pass. Continuous
          // event traffic must never keep a detail request alive indefinitely.
          if (firstBatchCommitted && sessionDetailAiDirtyRef.current.delete(sessionId)) {
            await loadAndCommitBatch()
          }
        } catch (error) {
          if (
            clientRef.current === activeClient &&
            requestCoordinator.isCurrent(sessionId, requestToken)
          ) {
            const message = error instanceof Error ? error.message : String(error)
            setSessionDetailError({ sessionId, message })
            reportError(error)
          }
        } finally {
          if (requestCoordinator.finish(sessionId, requestToken)) {
            // These buffers belong to the latest request token for this
            // session. A stale request can settle after eviction/replacement;
            // it must not erase events buffered by its successor.
            sessionDetailAiDirtyRef.current.delete(sessionId)
            sessionDetailLiveEntriesRef.current.delete(sessionId)
            setSessionDetailsLoading((current) => {
              const next = new Set(current)
              next.delete(sessionId)
              return next
            })
          }
        }
      }),
    [reportError]
  )

  const loadSessionDetails = useCallback(
    async (sessionId: string): Promise<void> => {
      const activeClient = clientRef.current
      if (!activeClient || wsStatusRef.current !== 'connected') {
        return
      }
      await loadSessionDetailsForClient(activeClient, sessionId)
    },
    [loadSessionDetailsForClient]
  )

  const refreshNoiseCleanupJobs = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }
    const nextJobs = await activeClient.requestTyped('noiseCleanup.list', undefined)
    // Source mutations can invalidate completed derivatives without emitting a
    // cleanup status event. This list replaces local state authoritatively.
    setNoiseCleanupJobs(nextJobs)
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
    audioMeterSampleGenerationRef.current += 1
    setAudioMeterLoading(false)
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
      } else if (event.state === 'lost') {
        toast.error('Backend shutdown could not be confirmed', {
          id: 'backend-lifecycle',
          description: 'A replacement was not started. Quit and reopen Videorc to recover safely.',
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

  const recordAutomaticSourceFallbacks = useCallback(
    (previous: SourceSelection, next: SourceSelection) => {
      const fallbackEvents = sourceSelectionChangeEvents(previous, next)
      if (fallbackEvents.length === 0) {
        return
      }
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
    },
    []
  )

  useEffect(() => {
    setCaptureConfig((current) => {
      const nextSources = reconcileSourceSelection(current.sources, deviceList.devices)

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      recordAutomaticSourceFallbacks(current.sources, nextSources)
      return { ...current, sources: nextSources }
    })
  }, [deviceList, recordAutomaticSourceFallbacks])

  useEffect(() => {
    if (!connection) {
      return
    }

    let disposed = false
    const generation = bootstrapGenerationRef.current + 1
    bootstrapGenerationRef.current = generation
    const focusRefreshCoordinator = focusRefreshCoordinatorRef.current
    const sessionListRefreshRequests = sessionListRefreshRequestRef.current
    const sessionListMoreSingleFlight = sessionListMoreSingleFlightRef.current
    const sessionDetailRequests = sessionDetailRequestRef.current
    const sessionDetailSingleFlight = sessionDetailSingleFlightRef.current
    const sessionDetailAiDirty = sessionDetailAiDirtyRef.current
    const sessionDetailLiveEntries = sessionDetailLiveEntriesRef.current
    focusRefreshCoordinator.invalidate()
    sessionListRefreshRequests.clear()
    sessionListMoreSingleFlight.clear()
    sessionListGenerationRef.current += 1
    setSessionsLoadingMore(false)
    sessionDetailRequests.clear()
    sessionDetailSingleFlight.clear()
    sessionDetailAiDirty.clear()
    sessionDetailLiveEntries.clear()
    sessionDetailRecencyRef.current = []
    setSessionDetails({})
    setSessionDetailsLoading(new Set())
    setSessionDetailError(null)
    const bootstrapAbort = new AbortController()
    const generationIsCurrent = (): boolean =>
      !disposed && bootstrapGenerationRef.current === generation
    const nextClient = new BackendClient(connection)
    const platformBootstrapClient = new BackendClient(connection)
    const bootstrapRequest = <TPayload,>(method: string, params?: unknown): Promise<TPayload> =>
      nextClient.request<TPayload>(method, params, { signal: bootstrapAbort.signal })
    const bootstrapGuard = new StudioBootstrapGuard()
    let liveChatBootstrapComplete = false
    let liveChatBootstrapOverflowed = false
    const liveChatBootstrapEvents: LiveChatBootstrapEvent[] = []
    const liveChatMessageBatcher = new LiveChatMessageBatcher({
      onFlush: (messages) => {
        if (generationIsCurrent()) {
          updateLiveChatSnapshot((current) => applyLiveChatMessages(current, messages))
        }
      },
      schedule: (flush) => {
        const timer = window.setTimeout(flush, 16)
        return () => window.clearTimeout(timer)
      }
    })
    const bufferLiveChatBootstrapEvent = (event: LiveChatBootstrapEvent): void => {
      if (liveChatBootstrapComplete) {
        return
      }
      if (liveChatBootstrapEvents.length >= 2048) {
        liveChatBootstrapEvents.shift()
        liveChatBootstrapOverflowed = true
      }
      liveChatBootstrapEvents.push(event)
    }
    let liveChatRecovery: Promise<void> | null = null
    let liveChatRecoveryRetryTimer: number | null = null
    let commentHighlightRevision = 0
    type CaptionCueRenderRequest = {
      requestId: string
      canvasWidth: number
      canvasHeight: number
      position: 'top' | 'bottom'
      textSize: 's' | 'm' | 'l'
      styleId?: import('@/lib/backend').CaptionStyleId
      styleRevision?: number
      blankSeq: number
      cues: { seq: number; text: string }[]
    }
    const captionCueRenderGuard = new CaptionCueRenderGuard()
    let captionCueRenderGeneration = captionCueRenderGuard.begin()
    const captionCueRenderQueue: CaptionCueRenderRequest[] = []
    let captionCueRenderWorkerActive = false
    let captionCueRenderAbort: AbortController | null = null
    const cancelCaptionCueRender = (): void => {
      captionCueRenderGuard.cancel()
      captionCueRenderGeneration = captionCueRenderGuard.begin()
      captionCueRenderQueue.splice(0)
      captionCueRenderAbort?.abort()
      captionCueRenderAbort = null
    }
    const drainCaptionCueRenderQueue = async (): Promise<void> => {
      if (captionCueRenderWorkerActive) return
      captionCueRenderWorkerActive = true
      try {
        while (captionCueRenderQueue.length > 0) {
          const request = captionCueRenderQueue.shift()
          if (!request) continue
          const cueRenderGeneration = captionCueRenderGeneration
          const cueRenderAbort = new AbortController()
          captionCueRenderAbort = cueRenderAbort
          const jobs = [{ seq: request.blankSeq, text: '' }, ...request.cues]
          for (const cue of jobs) {
            if (
              !generationIsCurrent() ||
              cueRenderAbort.signal.aborted ||
              !captionCueRenderGuard.isCurrent(cueRenderGeneration)
            ) {
              break
            }
            const pngBase64 = await renderCaptionCueFramePng({
              text: cue.text,
              canvasWidth: request.canvasWidth,
              canvasHeight: request.canvasHeight,
              position: request.position,
              textSize: request.textSize,
              styleId: request.styleId ?? 'glass'
            })
            if (
              !pngBase64 ||
              !generationIsCurrent() ||
              cueRenderAbort.signal.aborted ||
              !captionCueRenderGuard.isCurrent(cueRenderGeneration)
            ) {
              continue
            }
            try {
              await nextClient.request(
                'captions.cues.submit',
                {
                  requestId: request.requestId,
                  seq: cue.seq,
                  pngBase64
                },
                { signal: cueRenderAbort.signal }
              )
            } catch {
              // Skip this cue; the backend watchdog handles incompleteness.
            }
          }
          if (captionCueRenderAbort === cueRenderAbort) {
            captionCueRenderAbort = null
          }
        }
      } finally {
        captionCueRenderWorkerActive = false
      }
    }
    type LiveChatRecoveryResult =
      | { kind: 'disposed' | 'superseded' }
      | {
          kind: 'candidate'
          snapshot: LiveChatSnapshot
          queued: LiveChatMessage[]
          stateRevisionAtStart: number
          highlight: CommentHighlightState | null
          highlightRevisionAtStart: number
          operationsResult: LiveChatSendOperationsQueryResult
          sendOperationRevisionAtStart: number
        }
    const scheduleLiveChatRecoveryRetry = (): void => {
      if (disposed || liveChatRecoveryRetryTimer !== null) return
      liveChatRecoveryRetryTimer = window.setTimeout(() => {
        liveChatRecoveryRetryTimer = null
        void recoverLiveChatSnapshot().catch((error: unknown) => {
          if (!disposed) reportError(error)
        })
      }, LIVE_CHAT_RECOVERY_RETRY_DELAY_MS)
    }
    function recoverLiveChatSnapshot(): Promise<void> {
      if (disposed) return Promise.resolve()
      if (liveChatRecovery) return liveChatRecovery
      if (liveChatRecoveryRetryTimer !== null) {
        window.clearTimeout(liveChatRecoveryRetryTimer)
        liveChatRecoveryRetryTimer = null
      }
      liveChatMessageBatcher.suspend()
      liveChatRecovery = (async () => {
        try {
          const recovery = await runBoundedLiveChatRecovery<LiveChatRecoveryResult>(async () => {
            const stateRevisionAtStart = liveChatStateRevisionRef.current
            const replacementRevisionAtStart = liveChatReplacementRevisionRef.current
            const highlightRevisionAtStart = commentHighlightRevision
            const sendOperationRevisionAtStart = liveChatSendOperationRevisionRef.current
            const [snapshot, highlight] = await Promise.all([
              nextClient.request<LiveChatSnapshot>('liveChat.status'),
              nextClient
                .request<CommentHighlightState>('comments.highlight.status')
                .catch(() => null)
            ])
            const operationsResult = snapshot.sessionId
              ? await requestLiveChatSendOperations(() =>
                  nextClient.request<CommentsSendOperation[]>('liveChat.sendOperations.list', {
                    sessionId: snapshot.sessionId
                  })
                )
              : successfulEmptyLiveChatSendOperationsQuery()
            if (disposed) {
              return { value: { kind: 'disposed' }, overflowed: false }
            }
            if (
              !commentsRefreshRevisionIsCurrent(
                replacementRevisionAtStart,
                liveChatReplacementRevisionRef.current
              )
            ) {
              return { value: { kind: 'superseded' }, overflowed: false }
            }
            const pending = liveChatMessageBatcher.drainPending()
            return {
              value: {
                kind: 'candidate',
                snapshot,
                queued: pending.messages,
                stateRevisionAtStart,
                highlight,
                highlightRevisionAtStart,
                operationsResult,
                sendOperationRevisionAtStart
              },
              overflowed: pending.overflowed
            }
          })
          if (recovery.kind !== 'candidate' || disposed) return

          const recoveredSnapshot = reconcileLiveChatRecovery(
            recovery.snapshot,
            liveChatSnapshotRef.current,
            recovery.queued,
            !commentsRefreshRevisionIsCurrent(
              recovery.stateRevisionAtStart,
              liveChatStateRevisionRef.current
            )
          )
          replaceLiveChatSnapshotState(recoveredSnapshot)
          const latestSendOperation = applyLiveChatSendOperationsQuery(
            recovery.operationsResult,
            recoveredSnapshot.sessionId,
            recovery.sendOperationRevisionAtStart
          )
          void window.videorc?.pushCommentsSnapshot?.({
            mode: { kind: 'live' },
            snapshot: recoveredSnapshot,
            latestSendOperation
          })
          if (
            recovery.highlight &&
            commentHighlightRevision === recovery.highlightRevisionAtStart
          ) {
            publishCommentHighlightState(recovery.highlight)
            setCommentHighlightApplyingId(null)
          }
        } catch (error) {
          if (error instanceof LiveChatRecoveryOverflowError) {
            scheduleLiveChatRecoveryRetry()
          }
          throw error
        } finally {
          liveChatRecovery = null
          liveChatMessageBatcher.resume()
        }
      })()
      return liveChatRecovery
    }
    setClient(nextClient)
    setWsStatus('connecting')
    setLastError(null)

    const unsubscribers = [
      nextClient.on('backend.ready', () => setWsStatus('connected')),
      nextClient.on('devices.changed', (payload) => {
        bootstrapGuard.mark('devices')
        setDeviceList(payload as DeviceList)
      }),
      nextClient.on('entitlements.updated', (payload) => {
        setEntitlements(payload)
      }),
      nextClient.on('noiseCleanup.status', (payload) => {
        const job = payload
        setNoiseCleanupJobs((current) => upsertNoiseCleanupJob(current, job))
        if (job.status === 'completed') {
          void refreshSessions(nextClient)
          const outputSessionId = job.outputSessionId
          if (outputSessionId && !announcedNoiseCleanupCompletionsRef.current.has(job.id)) {
            announcedNoiseCleanupCompletionsRef.current.add(job.id)
            toast.success('Noise cleanup complete', {
              id: `noise-cleanup-completed-${job.id}`,
              description: 'A separate cleaned copy is ready. The original was not changed.',
              duration: 15_000,
              action: {
                label: 'Play',
                onClick: () => {
                  const openSession = window.videorc?.openSession
                  if (!openSession) return
                  void openSession(outputSessionId).then((problem) => {
                    if (problem) toast.error(problem)
                  })
                }
              },
              cancel: {
                label: 'Show in Finder',
                onClick: () => void window.videorc?.revealSession?.(outputSessionId)
              }
            })
          }
        }
      }),
      nextClient.on('recording.status', (payload) => {
        bootstrapGuard.mark('recording')
        bootstrapGuard.mark('sessions')
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
        bootstrapGuard.mark('sessions')
        const event = payload as HealthEvent
        setHealthEvents((current) => [event, ...current].slice(0, 40))
        if (event.sessionId) {
          if (sessionDetailRequestRef.current.isActive(event.sessionId)) {
            const liveEntries = sessionDetailLiveEntriesRef.current.get(event.sessionId) ?? {
              healthEvents: [],
              sessionLogs: []
            }
            appendBoundedSessionDetailEntry(liveEntries.healthEvents, event)
            sessionDetailLiveEntriesRef.current.set(event.sessionId, liveEntries)
          }
          setSessions((current) =>
            current.map((session) =>
              session.id === event.sessionId
                ? { ...session, healthEventCount: session.healthEventCount + 1 }
                : session
            )
          )
          setSessionDetails((current) => {
            const details = current[event.sessionId!]
            return details
              ? {
                  ...current,
                  [event.sessionId!]: {
                    ...details,
                    healthEvents: capSessionDetailBuffer([...details.healthEvents, event])
                  }
                }
              : current
          })
        }
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
                onClick: () => openLibraryFromQualityToast(event.sessionId ?? undefined)
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
        bootstrapGuard.mark('sessions')
        const entry = payload as SessionLogEntry
        if (sessionDetailRequestRef.current.isActive(entry.sessionId)) {
          const liveEntries = sessionDetailLiveEntriesRef.current.get(entry.sessionId) ?? {
            healthEvents: [],
            sessionLogs: []
          }
          appendBoundedSessionDetailEntry(liveEntries.sessionLogs, entry)
          sessionDetailLiveEntriesRef.current.set(entry.sessionId, liveEntries)
        }
        setSessions((current) =>
          current.map((session) =>
            session.id === entry.sessionId
              ? { ...session, sessionLogCount: session.sessionLogCount + 1 }
              : session
          )
        )
        setSessionDetails((current) => {
          const details = current[entry.sessionId]
          return details
            ? {
                ...current,
                [entry.sessionId]: {
                  ...details,
                  sessionLogs: capSessionDetailBuffer([...details.sessionLogs, entry])
                }
              }
            : current
        })
      }),
      nextClient.on('stream.health', (payload) => {
        setStreamHealth((current) => mergeStreamHealth(current, payload as StreamHealth))
      }),
      nextClient.on('stream.targets', (payload) => {
        setStreamTargets((payload as StreamTargetsSnapshot).targets)
      }),
      nextClient.on('diagnostics.stats', (payload) => {
        bootstrapGuard.mark('diagnostics')
        commitDiagnosticStatsThrottled(payload as DiagnosticStats)
      }),
      nextClient.on('preview.live.status', (payload) => {
        bootstrapGuard.mark('previewLive')
        applyPreviewLiveStatus(payload as PreviewLiveStatus)
      }),
      nextClient.on('preview.surface.status', (payload) => {
        bootstrapGuard.mark('previewSurface')
        applyPreviewSurfaceStatusThrottled(payload as PreviewSurfaceStatus)
      }),
      nextClient.on('compositor.status', (payload) => {
        bootstrapGuard.mark('compositor')
        const status = payload as CompositorStatus
        const receivedAtMs = Date.now()
        const fallbackOwnsPresentation = rendererFallbackOwnsPresentation({
          mainPumpActive: mainPumpActiveRef.current,
          recordingState: recordingRef.current.state
        })
        if (
          fallbackOwnsPresentation &&
          !rendererFallbackCompositorStatusIsFresh({
            fallbackActivatedAtMs: nativePreviewRendererFallbackActivatedAtRef.current,
            statusUpdatedAt: status.updatedAt
          })
        ) {
          return
        }
        nativePreviewCompositorLastEventAtRef.current = receivedAtMs
        nativePreviewCompositorLatestStatusRef.current = status
        if (
          !fallbackOwnsPresentation ||
          receivedAtMs - nativePreviewFrameReadyLastEventAtRef.current <= 1000
        ) {
          return
        }
        queueNativePreviewCompositorPresent(nextClient, status)
      }),
      nextClient.on('preview.frameReady', (payload) => {
        bootstrapGuard.mark('compositor')
        const frame = payload as CompositorFrameReady
        const fallbackOwnsPresentation = rendererFallbackOwnsPresentation({
          mainPumpActive: mainPumpActiveRef.current,
          recordingState: recordingRef.current.state
        })
        if (
          fallbackOwnsPresentation &&
          !rendererFallbackCompositorStatusIsFresh({
            fallbackActivatedAtMs: nativePreviewRendererFallbackActivatedAtRef.current,
            statusUpdatedAt: frame.updatedAt
          })
        ) {
          return
        }
        const receivedAtMs = Date.now()
        nativePreviewFrameReadyLastEventAtRef.current = receivedAtMs
        const status = compositorStatusFromFrameReady(
          frame,
          nativePreviewCompositorLatestStatusRef.current
        )
        nativePreviewCompositorLastEventAtRef.current = receivedAtMs
        nativePreviewCompositorLatestStatusRef.current = status
        if (!fallbackOwnsPresentation) {
          return
        }
        queueNativePreviewCompositorPresent(nextClient, status)
      }),
      nextClient.on('preview.camera.status', (payload) => {
        bootstrapGuard.mark('previewCamera')
        applyPreviewCameraStatus(payload as PreviewCameraStatus)
      }),
      nextClient.on('preview.screen.status', (payload) => {
        bootstrapGuard.mark('previewScreen')
        applyPreviewScreenStatus(payload as PreviewScreenStatus)
      }),
      nextClient.on('scene.changed', (payload) => {
        if (layoutIntentAwaitingProofRef.current !== null) {
          return
        }
        bootstrapGuard.mark('scene')
        applyScene(payload as Scene)
      }),
      nextClient.on('screens.changed', (payload) => {
        bootstrapGuard.mark('screenList')
        setScreens(payload as StreamScreen[])
      }),
      nextClient.on('screens.active.changed', (payload) => {
        bootstrapGuard.mark('activeScreen')
        setActiveScreen(payload as StreamScreen | null)
      }),
      nextClient.on('platformAccounts.changed', (payload) => {
        bootstrapGuard.mark('platformAccounts')
        setPlatformAccounts(payload as PlatformAccount[])
      }),
      nextClient.on('liveChat.snapshot', (payload) => {
        bootstrapGuard.mark('liveChat')
        const snapshot = applyLiveChatSnapshot(payload as LiveChatSnapshot)
        bufferLiveChatBootstrapEvent({ kind: 'snapshot', snapshot })
        liveChatMessageBatcher.clear()
        replaceLiveChatSnapshotState(snapshot)
        const latestSendOperation = latestLiveChatSendOperationRef.current
        void window.videorc?.pushCommentsSnapshot?.({
          mode: { kind: 'live' },
          snapshot,
          latestSendOperation:
            latestSendOperation?.sessionId === snapshot.sessionId ? latestSendOperation : undefined
        })
      }),
      nextClient.on('liveChat.message', (payload) => {
        bootstrapGuard.mark('liveChat')
        const message = payload as LiveChatMessage
        bufferLiveChatBootstrapEvent({ kind: 'message', message })
        liveChatMessageBatcher.enqueue(message)
        void window.videorc?.pushCommentsDelta?.({
          kind: 'message',
          message,
          sessionId: message.sessionId
        })
      }),
      nextClient.on('liveChat.providerStatus', (payload) => {
        bootstrapGuard.mark('liveChat')
        const provider = payload as LiveChatProviderState
        bufferLiveChatBootstrapEvent({ kind: 'provider', provider })
        liveChatMessageBatcher.flush()
        updateLiveChatSnapshot((current) => applyLiveChatProviderStatus(current, provider))
        void window.videorc?.pushCommentsDelta?.({
          kind: 'provider',
          provider,
          sessionId: liveChatSnapshotRef.current.sessionId,
          updatedAt: new Date().toISOString()
        })
      }),
      nextClient.on('liveChat.cleared', (payload) => {
        bootstrapGuard.mark('liveChat')
        const snapshot = applyLiveChatSnapshot(payload as LiveChatSnapshot)
        bufferLiveChatBootstrapEvent({ kind: 'snapshot', snapshot })
        liveChatMessageBatcher.clear()
        replaceLiveChatSnapshotState(snapshot)
        const latestSendOperation = latestLiveChatSendOperationRef.current
        void window.videorc?.pushCommentsSnapshot?.({
          mode: { kind: 'live' },
          snapshot,
          latestSendOperation:
            latestSendOperation?.sessionId === snapshot.sessionId ? latestSendOperation : undefined
        })
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
        publishCommentHighlightState(status)
        setCommentHighlightApplyingId(null)
      }),
      nextClient.on('events.lagged', (payload) => {
        const lagged = payload as EventsLaggedPayload
        if (lagged.skipped < 1) return
        void recoverLiveChatSnapshot().catch((error: unknown) => {
          if (!disposed) reportError(error)
        })
      }),
      nextClient.on('captions.status', (payload) =>
        commitCaptionsStatus(payload as CaptionsStatus)
      ),
      nextClient.on('captions.cleared', (payload) => {
        if (shouldCancelCaptionCueRender((payload as { reason?: string }).reason)) {
          cancelCaptionCueRender()
        }
        captionSessionFloorRef.current = null
        setCaptionLines([])
      }),
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
        captionCueRenderQueue.push(payload as CaptionCueRenderRequest)
        void drainCaptionCueRenderQueue()
      }),
      nextClient.on('streamTargets.metadata.changed', (payload) => {
        bootstrapGuard.mark('streamMetadata')
        const draft = payload as StreamMetadataDraft
        setStreamMetadataDraft(draft)
        void nextClient
          .request<StreamMetadataValidation>('streamTargets.metadata.validate', draft)
          .then(setStreamMetadataValidation)
      }),
      nextClient.on('platformAccounts.oauth.callback', (result) => {
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
      nextClient.on('ai.artifacts.changed', (payload) => {
        bootstrapGuard.mark('sessions')
        void refreshSessions(nextClient)
        const sessionId =
          typeof payload === 'object' && payload !== null && 'sessionId' in payload
            ? String(payload.sessionId)
            : null
        const detailRequestActive = sessionId
          ? sessionDetailRequestRef.current.isActive(sessionId)
          : false
        if (sessionId && detailRequestActive) {
          sessionDetailAiDirtyRef.current.add(sessionId)
        }
        if (sessionId && (detailRequestActive || sessionDetailsRef.current[sessionId])) {
          void loadSessionDetailsForClient(nextClient, sessionId)
        }
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
        if (!generationIsCurrent()) {
          return
        }
        setWsStatus('connected')
        const bootstrapSnapshot = bootstrapGuard.snapshot()
        const commentHighlightRevisionAtBootstrapStart = commentHighlightRevision
        const captionsStatusRevisionAtBootstrapStart = captionsStatusRevisionRef.current
        const [
          nextHealth,
          nextEntitlements,
          nextAccount,
          nextDevices,
          nextRecording,
          nextDiagnostics,
          nextCaptionsStatus,
          nextLiveChat,
          nextCommentHighlight,
          nextPreview,
          nextPreviewSurface,
          nextPreviewCamera,
          nextPreviewScreen,
          nextScene,
          nextScreens,
          nextActiveScreen,
          nextStreamMetadataDraft,
          nextSessions,
          nextSessionStorage,
          nextNoiseCleanupJobs
        ] = await Promise.all([
          bootstrapRequest<BackendHealth>('health.ping'),
          bootstrapRequest<EntitlementsSnapshot>('entitlements.refresh'),
          bootstrapRequest<VideorcAccountSnapshot>('account.get'),
          bootstrapRequest<DeviceList>('devices.list'),
          bootstrapRequest<RecordingStatus>('recording.status'),
          bootstrapRequest<DiagnosticStats>('diagnostics.stats'),
          bootstrapRequest<CaptionsStatus>('captions.status.get'),
          bootstrapRequest<LiveChatSnapshot>('liveChat.status'),
          bootstrapRequest<CommentHighlightState>('comments.highlight.status'),
          bootstrapRequest<PreviewLiveStatus>('preview.live.status'),
          bootstrapRequest<PreviewSurfaceStatus>('preview.surface.status'),
          bootstrapRequest<PreviewCameraStatus>('preview.camera.status'),
          bootstrapRequest<PreviewScreenStatus>('preview.screen.status'),
          bootstrapRequest<Scene>('scene.get'),
          bootstrapRequest<StreamScreen[]>('screens.list'),
          bootstrapRequest<StreamScreen | null>('screens.active'),
          bootstrapRequest<StreamMetadataDraft>('streamTargets.metadata.get'),
          bootstrapRequest<SessionListPage>('sessions.list', { limit: SESSION_LIST_PAGE_LIMIT }),
          bootstrapRequest<SessionStorageTotals>('sessions.storage'),
          bootstrapRequest<NoiseCleanupJob[]>('noiseCleanup.list')
        ])
        if (!generationIsCurrent()) {
          return
        }

        // Commit the local, UI-critical snapshot before optional provider
        // validation. A slow or failing provider network call must not hold
        // devices, recording, or preview in the loading state.
        setHealth(nextHealth)
        setEntitlements(nextEntitlements)
        setAccount(nextAccount)
        setAiReadinessLoading(nextAccount.status === 'signed-in')
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'devices')) {
          setDeviceList(nextDevices)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'recording')) {
          applyRecordingStatus(nextRecording)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'diagnostics')) {
          setDiagnosticStats(nextDiagnostics)
        }
        if (captionsStatusRevisionRef.current === captionsStatusRevisionAtBootstrapStart) {
          commitCaptionsStatus(nextCaptionsStatus)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewLive')) {
          applyPreviewLiveStatus(nextPreview)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewSurface')) {
          applyPreviewSurfaceStatus(nextPreviewSurface)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewCamera')) {
          applyPreviewCameraStatus(nextPreviewCamera)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewScreen')) {
          applyPreviewScreenStatus(nextPreviewScreen)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'screenList')) {
          setScreens(nextScreens)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'activeScreen')) {
          setActiveScreen(nextActiveScreen)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'streamMetadata')) {
          setStreamMetadataDraft(nextStreamMetadataDraft)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'sessions')) {
          sessionListGenerationRef.current += 1
          sessionListMoreSingleFlight.invalidate('next-page')
          setSessionsLoadingMore(false)
          setSessions(nextSessions.items)
          setSessionsNextCursor(nextSessions.nextCursor ?? null)
          setSessionStorageTotals(nextSessionStorage)
        } else {
          void refreshSessions(nextClient)
        }
        setNoiseCleanupJobs((current) =>
          nextNoiseCleanupJobs.reduce((jobs, job) => upsertNoiseCleanupJob(jobs, job), current)
        )
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'scene') && nextScene.sources.length) {
          applyScene(nextScene)
        }
        if (commentHighlightRevision === commentHighlightRevisionAtBootstrapStart) {
          publishCommentHighlightState(nextCommentHighlight)
          setCommentHighlightApplyingId(null)
        }

        const liveChatBootstrapBase = liveChatBootstrapOverflowed
          ? await bootstrapRequest<LiveChatSnapshot>('liveChat.status').catch(() => nextLiveChat)
          : nextLiveChat
        if (!generationIsCurrent()) {
          return
        }
        const initialLiveChatSnapshot = replayLiveChatBootstrapEvents(
          liveChatBootstrapBase,
          liveChatBootstrapEvents
        )
        liveChatMessageBatcher.clear()
        liveChatBootstrapComplete = true
        replaceLiveChatSnapshotState(initialLiveChatSnapshot)
        const sendOperationRevisionAtStart = liveChatSendOperationRevisionRef.current
        const initialSendOperationsResult = initialLiveChatSnapshot.sessionId
          ? await requestLiveChatSendOperations(() =>
              bootstrapRequest<CommentsSendOperation[]>('liveChat.sendOperations.list', {
                sessionId: initialLiveChatSnapshot.sessionId
              })
            )
          : successfulEmptyLiveChatSendOperationsQuery()
        if (!generationIsCurrent()) return
        const initialSendOperation = applyLiveChatSendOperationsQuery(
          initialSendOperationsResult,
          initialLiveChatSnapshot.sessionId,
          sendOperationRevisionAtStart
        )
        void window.videorc?.pushCommentsSnapshot?.({
          mode: { kind: 'live' },
          snapshot: initialLiveChatSnapshot,
          latestSendOperation: initialSendOperation
        })

        const [
          nextAiReadiness,
          nextPlatformAccountBootstrap,
          nextStreamMetadataValidation,
          nextCompositorStatus
        ] = await Promise.all([
          nextAccount.status === 'signed-in'
            ? Promise.all([
                bootstrapRequest<AiCapabilities>('ai.capabilities.get'),
                bootstrapRequest<AiQuotaStatus>('ai.quota.get')
              ])
                .then(([capabilities, quota]) => ({ capabilities, quota, error: null }))
                .catch((error: unknown) => ({
                  capabilities: null,
                  quota: null,
                  error: error instanceof Error ? error.message : String(error)
                }))
            : Promise.resolve({ capabilities: null, quota: null, error: null }),
          loadValidatedPlatformAccountsOnIsolatedClient<
            PlatformAccount,
            PlatformAccountValidation,
            OAuthProviderCredentialStatus
          >(platformBootstrapClient, bootstrapAbort.signal).catch((error: unknown) => {
            console.warn('Optional platform-account bootstrap failed:', error)
            return null
          }),
          bootstrapRequest<StreamMetadataValidation>(
            'streamTargets.metadata.validate',
            nextStreamMetadataDraft
          ).catch((error: unknown) => {
            console.warn('Optional stream-metadata validation failed:', error)
            return null
          }),
          nextScene.sources.length
            ? bootstrapRequest<CompositorStatus>('compositor.status').catch((error: unknown) => {
                console.warn('Optional compositor bootstrap failed:', error)
                return null
              })
            : Promise.resolve(null)
        ])
        if (!generationIsCurrent()) {
          return
        }

        setAiCapabilities(nextAiReadiness.capabilities)
        setAiQuota(nextAiReadiness.quota)
        setAiReadinessError(nextAiReadiness.error)
        setAiReadinessLoading(false)
        if (
          nextPlatformAccountBootstrap &&
          bootstrapGuard.isCurrent(bootstrapSnapshot, 'platformAccounts')
        ) {
          setPlatformAccounts(nextPlatformAccountBootstrap.accounts)
        }
        if (nextPlatformAccountBootstrap) {
          setOauthProviderCredentials(nextPlatformAccountBootstrap.credentials)
          setPlatformAccountValidations(nextPlatformAccountBootstrap.validations)
        }
        if (
          nextStreamMetadataValidation &&
          bootstrapGuard.isCurrent(bootstrapSnapshot, 'streamMetadata')
        ) {
          setStreamMetadataValidation(nextStreamMetadataValidation)
        }
        if (
          bootstrapGuard.isCurrent(bootstrapSnapshot, 'compositor') &&
          nextCompositorStatus &&
          typeof nextCompositorStatus.sceneRevision === 'number'
        ) {
          nativePreviewCommittedSceneRef.current = {
            sceneId: nextScene.id,
            sceneRevision: nextCompositorStatus.sceneRevision,
            compositorStatus: nextCompositorStatus
          }
        }
      })
      .catch((error: unknown) => {
        if (!generationIsCurrent()) {
          return
        }
        // A bootstrap data request can fail while the established WebSocket
        // remains healthy. Keep transport truth separate from snapshot health
        // so captions and other live controls do not freeze behind a false
        // "Backend offline" state.
        setWsStatus(nextClient.connected ? 'connected' : 'failed')
        reportError(error)
      })

    return () => {
      disposed = true
      focusRefreshCoordinator.invalidate()
      sessionListRefreshRequests.clear()
      sessionListMoreSingleFlight.clear()
      sessionListGenerationRef.current += 1
      setSessionsLoadingMore(false)
      sessionDetailRequests.clear()
      sessionDetailSingleFlight.clear()
      sessionDetailAiDirty.clear()
      sessionDetailLiveEntries.clear()
      cancelCaptionCueRender()
      bootstrapAbort.abort()
      liveChatMessageBatcher.dispose()
      if (liveChatRecoveryRetryTimer !== null) {
        window.clearTimeout(liveChatRecoveryRetryTimer)
        liveChatRecoveryRetryTimer = null
      }
      platformBootstrapClient.close()
      nativePreviewCompositorPendingRef.current = null
      nativePreviewCompositorLatestStatusRef.current = null
      nativePreviewFrameReadyLastEventAtRef.current = 0
      nativePreviewRendererFallbackActivatedAtRef.current = 0
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
      nativePreviewSurfacePresentReportAbortRef.current?.abort()
      nativePreviewSurfacePresentReportAbortRef.current = null
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
      setNoiseCleanupJobs([])
      entitlementRefreshInFlightRef.current = null
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
    applyLiveChatSendOperationsQuery,
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
    publishCommentHighlightState,
    refreshPlatformAccountsForClient,
    replaceLiveChatSnapshotState,
    updateLiveChatSnapshot,
    validatePlatformAccountsForClient,
    refreshSessions,
    reportError
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

  const refreshBackend = useCallback(
    (): Promise<void> =>
      focusRefreshCoordinatorRef.current.run(async (generationIsCurrent) => {
        await refreshMediaAccess()
        const activeClient = clientRef.current
        // Multiple focus listeners intentionally share this one coordinator.
        // During backend replacement, the connection generation invalidates
        // this work before any response can commit into the new client state.
        if (!activeClient || wsStatusRef.current !== 'connected' || !generationIsCurrent()) {
          return
        }

        const refreshIsCurrent = (): boolean =>
          generationIsCurrent() && clientRef.current === activeClient
        const sessionListRefreshRequests = sessionListRefreshRequestRef.current
        const sessionListRequestToken = sessionListRefreshRequests.begin('first-page')
        sessionListGenerationRef.current += 1
        sessionListMoreSingleFlightRef.current.invalidate('next-page')
        setSessionsLoadingMore(false)
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
            nextStreamMetadataDraft,
            nextNoiseCleanupJobs
          ] = await Promise.all([
            activeClient.request<BackendHealth>('health.ping'),
            refreshEntitlementsForClient(activeClient),
            activeClient.request<VideorcAccountSnapshot>('account.get'),
            activeClient.request<DeviceList>('devices.list'),
            activeClient.requestTyped('sessions.list', { limit: SESSION_LIST_PAGE_LIMIT }),
            activeClient.request<SessionStorageTotals>('sessions.storage'),
            activeClient.request<DiagnosticStats>('diagnostics.stats'),
            activeClient.request<StreamScreen[]>('screens.list'),
            activeClient.request<StreamScreen | null>('screens.active'),
            activeClient.request<PlatformAccount[]>('platformAccounts.list'),
            activeClient.request<OAuthProviderCredentialStatus[]>(
              'platformAccounts.oauth.providerCredentials'
            ),
            activeClient.request<PlatformAccountValidation[]>('platformAccounts.validate'),
            activeClient.request<StreamMetadataDraft>('streamTargets.metadata.get'),
            activeClient.requestTyped('noiseCleanup.list', undefined)
          ])
          if (!refreshIsCurrent()) {
            return
          }
          setAccount(nextAccount)
          await refreshAiReadinessForClient(activeClient, nextAccount, refreshIsCurrent)
          if (!refreshIsCurrent()) {
            return
          }
          const nextStreamMetadataValidation = await activeClient.request<StreamMetadataValidation>(
            'streamTargets.metadata.validate',
            nextStreamMetadataDraft
          )
          if (!refreshIsCurrent()) {
            return
          }
          setHealth(nextHealth)
          setEntitlements(nextEntitlements)
          setDeviceList(nextDevices)
          if (sessionListRefreshRequests.isCurrent('first-page', sessionListRequestToken)) {
            sessionListGenerationRef.current += 1
            setSessions(nextSessions.items)
            setSessionsNextCursor(nextSessions.nextCursor ?? null)
            setSessionStorageTotals(nextSessionStorage)
          }
          setDiagnosticStats(nextDiagnostics)
          setScreens(nextScreens)
          setActiveScreen(nextActiveScreen)
          setPlatformAccounts(nextPlatformAccounts)
          setOauthProviderCredentials(nextOauthProviderCredentials)
          setPlatformAccountValidations(nextPlatformAccountValidations)
          setStreamMetadataDraft(nextStreamMetadataDraft)
          setStreamMetadataValidation(nextStreamMetadataValidation)
          setNoiseCleanupJobs((current) =>
            nextNoiseCleanupJobs.reduce((jobs, job) => upsertNoiseCleanupJob(jobs, job), current)
          )
        } catch (error) {
          if (refreshIsCurrent()) {
            reportError(error)
          }
        } finally {
          sessionListRefreshRequests.finish('first-page', sessionListRequestToken)
        }
      }),
    [refreshAiReadinessForClient, refreshEntitlementsForClient, refreshMediaAccess, reportError]
  )

  const refreshEntitlements = useCallback(async (): Promise<void> => {
    if (!client || wsStatusRef.current !== 'connected') {
      return
    }
    await refreshEntitlementsForClient(client)
  }, [client, refreshEntitlementsForClient])

  // Purchases and token expiry must not remain stale. Focus covers return from
  // the Premium browser; the bounded signed-in timer covers an app left open.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    const refreshOnFocus = (): void => {
      void refreshEntitlementsForClient(client).catch(() => {
        // Preserve the current fail-closed snapshot on transport failure.
      })
    }
    window.addEventListener('focus', refreshOnFocus)
    const timer =
      account?.status === 'signed-in'
        ? window.setInterval(refreshOnFocus, SIGNED_IN_ENTITLEMENT_REFRESH_INTERVAL_MS)
        : null
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      if (timer !== null) {
        window.clearInterval(timer)
      }
    }
  }, [account?.status, client, refreshEntitlementsForClient, wsStatus])

  // Real OS camera/mic access status (Electron getMediaAccessStatus, over IPC —
  // independent of the backend socket). Refresh on mount and whenever the window
  // regains focus, since grants flip in the OS Settings while we're backgrounded.
  useEffect(() => {
    const refresh = (): void => {
      void refreshMediaAccess()
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
    }
  }, [refreshMediaAccess])

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
      // While the preview is hidden (dialog overlay, minimized, fullscreen,
      // scrolled away) the host benign-skips presents, so a presented-revision
      // proof can never arrive. The compositor proof above already covered the
      // commit; do not demand a proof the surface is not allowed to produce.
      const surfaceCanPresent =
        previewWindowState?.open === true &&
        previewWindowState.visible &&
        previewWindowState.dockHiddenReason == null
      if (nativePreviewSurfaceEnabled && surfaceCanPresent) {
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
          throw new NativePreviewPresentationProofError(
            `Native preview could not verify committed scene revision ${status.sceneRevision}.`
          )
        }
        applyPreviewSurfaceStatus(surfaceStatus)
        if (
          surfaceStatus.nativePreviewHostKind !== 'proof-surface' &&
          !nativePreviewStatusProvesSceneRevision(surfaceStatus, status.sceneRevision)
        ) {
          throw new NativePreviewPresentationProofError(
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
        // Orientation and canvas are one committed program state. Derive the
        // patch for backend-truth recovery when the response carrying the
        // original patch was lost; ordinary successful transactions carry it.
        const recoveredOrientationPatch = verticalOrientationVideoPatch(
          current.layout.layoutPreset,
          snapshot.layout.layoutPreset,
          current.video,
          current.verticalRestoreVideo
        )
        const captureConfigPatch =
          snapshot.captureConfigPatch ??
          (recoveredOrientationPatch
            ? {
                video: recoveredOrientationPatch.video,
                verticalRestoreVideo: recoveredOrientationPatch.verticalRestoreVideo
              }
            : undefined)
        // The committed preset becomes its mode's remembered scene — the
        // orientation toggle re-enters each mode where the user left it.
        const next = {
          ...current,
          ...captureConfigPatch,
          ...layoutPresetMemoryPatch(snapshot.layout.layoutPreset),
          layout: snapshot.layout
        }
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
    const sceneBefore = await client.requestTyped('scene.get')
    const compositorStatus = await client.requestTyped('compositor.status')
    const sceneAfter = await client.requestTyped('scene.get')
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
    (
      layout: LayoutSettings,
      options?: {
        pendingIndicator?: boolean
        videoOverride?: VideoSettings
        captureConfigPatch?: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'>
      }
    ) => {
      const sessionActive = isActiveRecordingState(recordingRef.current.state)
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected — layout unchanged.')
        return
      }

      const intentId = Math.max(layoutIntentIdRef.current + 1, Date.now())
      layoutIntentIdRef.current = intentId
      layoutIntentAwaitingProofRef.current = intentId
      // Background-only commits keep the same preset; flashing the layout
      // controls into "Switching…" for them reads as an unrelated change.
      if (options?.pendingIndicator !== false) {
        setLayoutSwitchPending(layout.layoutPreset)
      }

      void (async () => {
        try {
          const protectedOverlayWindowIds = await currentProtectedOverlayWindowIds()
          const requestedConfig = captureConfigRef.current
          const requestedSources = reconcileSourceSelectionForLayoutTransaction(
            requestedConfig.sources,
            deviceListRef.current.devices
          )
          if (JSON.stringify(requestedSources) !== JSON.stringify(requestedConfig.sources)) {
            recordAutomaticSourceFallbacks(requestedConfig.sources, requestedSources)
            setCaptureConfig((current) =>
              JSON.stringify(current.sources) === JSON.stringify(requestedConfig.sources)
                ? { ...current, sources: requestedSources }
                : current
            )
          }
          const method = sessionActive ? 'scene.layout.apply_live' : 'scene.layout.apply_preview'
          const status: LayoutTransactionStatus = await client.requestTyped(method, {
            intentId,
            sources: requestedSources,
            layout,
            // Orientation and canvas commit to React only after backend proof.
            // Until then the ref intentionally remains on the previous program
            // state, so the transaction carries its target canvas explicitly.
            video: options?.videoOverride ?? requestedConfig.video,
            background: activeSceneBackground,
            protectedOverlayWindowIds
          })
          const committedSnapshot: LayoutTransactionSnapshot = {
            sceneRevision: status.sceneRevision,
            scene: status.scene,
            layout: status.compositorStatus.sceneLayout ?? layout,
            compositorStatus: status.compositorStatus,
            captureConfigPatch: options?.captureConfigPatch
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
            if (layoutTransactionUnprovenSeverity(proofError) === 'presentation-warning') {
              // The commit and the recording/streaming output proof already
              // passed; only the preview window's presented-revision readback
              // missed. Keep it diagnostic — a destructive error here reads as
              // a session failure while everything the viewer sees is correct.
              console.warn(
                `Layout committed at revision ${status.sceneRevision}; native preview presentation proof was not observed. ${detail}`
              )
              toast.warning('Preview verification lagged behind the layout change', {
                description:
                  'The layout was applied and the output is unaffected. If the preview looks stale, close and reopen it.'
              })
              return
            }
            reportError(
              new Error(
                `Layout committed at revision ${status.sceneRevision}, but preview proof was not observed. The controls were reconciled to the backend commit. ${detail}`
              )
            )
            return
          }
          // A successful layout commit is the EXPECTED outcome — the stage
          // already shows it (owner call, 2026-07-16: no green popups for
          // routine scene changes). Only lag/failure states surface above.
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
      recordAutomaticSourceFallbacks,
      rememberLayoutCommit,
      rememberLayoutTransactionSnapshot,
      reportError,
      wsStatus
    ]
  )

  // Instant background apply while live (2026-07-10 report: clicking an asset
  // only changed the local registry — the stream kept the old background until
  // the next layout-preset change re-committed the scene). Idle stays with the
  // debounced scene reload effect; an active session commits through the same
  // layout-transaction machinery (scene revision, latest-wins, proof).
  // Fingerprint by VALUE: the registry memo yields a new object on unrelated
  // edits (rename, import into an inactive slot) which must not commit.
  const liveBackgroundFingerprintRef = useRef<string | null>(null)
  const activeSceneBackgroundFingerprint = useMemo(
    () => JSON.stringify(activeSceneBackground ?? null),
    [activeSceneBackground]
  )
  useEffect(() => {
    const decision = liveBackgroundCommitDecision({
      sessionActive: isActiveRecordingState(recording.state),
      armedFingerprint: liveBackgroundFingerprintRef.current,
      fingerprint: activeSceneBackgroundFingerprint
    })
    liveBackgroundFingerprintRef.current = decision.next
    if (decision.commit) {
      requestLayoutTransaction(captureConfigRef.current.layout, { pendingIndicator: false })
    }
  }, [activeSceneBackgroundFingerprint, recording.state, requestLayoutTransaction])

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
      const current = captureConfigRef.current
      const nextPreset = patch.layoutPreset ?? current.layout.layoutPreset

      // Vertical scene ⇄ canvas orientation coupling, OFF-AIR ONLY: entering
      // vertical flips the canvas to 1080×1920 and remembers the landscape
      // profile; leaving restores it. Mid-session the canvas is fixed (the
      // vertical card is disabled and the backend refuses the switch).
      let videoOverride: VideoSettings | undefined
      let captureConfigPatch: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'> | undefined
      if (!isActiveRecordingState(recordingRef.current.state)) {
        const coupling = verticalOrientationVideoPatch(
          current.layout.layoutPreset,
          nextPreset,
          current.video,
          current.verticalRestoreVideo
        )
        if (coupling) {
          videoOverride = coupling.video
          captureConfigPatch = {
            video: coupling.video,
            verticalRestoreVideo: coupling.verticalRestoreVideo
          }
        }
      }

      requestLayoutTransaction(
        {
          ...current.layout,
          ...patch,
          cameraTransformMode: 'preset',
          cameraTransform: null
        },
        videoOverride ? { videoOverride, captureConfigPatch } : undefined
      )
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
        // Success is visible in the preview itself — no confirmation popup
        // for a routine source switch (errors still report below).
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

    if (runtimeInfo?.disableAutoPreview || runtimeInfo?.disableAutoSourcePreview) {
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
    runtimeInfo?.disableAutoSourcePreview,
    runtimeInfo?.previewSmokeMode,
    wsStatus
  ])

  const ensureNativePreviewScreen = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return previewScreenStatusRef.current
    }

    if (runtimeInfo?.disableAutoPreview || runtimeInfo?.disableAutoSourcePreview) {
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
      protectedOverlayWindowIds
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
    runtimeInfo?.disableAutoSourcePreview,
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
          backing: 'none',
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
        backing: 'electron-browser-window',
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
        video: captureConfig.video
      })
      applyPreviewLiveStatus(status)
    } catch (error) {
      reportError(error)
      setPreviewLiveStatus({
        state: 'unavailable',
        source: 'unavailable',
        transport: 'unavailable',
        backing: 'none',
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
          // Backend host commands carry privileged native-window lifecycle work.
          // Electron main drains them with the admin credential, drops delayed
          // placement echoes, and applies create/destroy for this generation.
          // The renderer-scoped socket must never request this admin method.
          const hostStatus = window.videorc.drainNativePreviewHostCommands
            ? await window.videorc.drainNativePreviewHostCommands(nextGeneration)
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
          const backendStatusAfterHostDrain = { ...backendStatus, pendingHostCommandCount: 0 }
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
            backing: surfaceStatus.backing,
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

  // Frame polling serves the Electron proof surface. It is redundant during a
  // recording only when an attached native layer owns presentation; Windows
  // relies on proof polling for its visible preview. A closed window always
  // suppresses polling — UI rewrite U2.
  const syncFramePollingSuppression = useCallback(() => {
    if (
      !nativePreviewSurfaceEnabled ||
      !window.videorc?.setNativePreviewSurfaceFramePollingSuppressed
    ) {
      return
    }
    const recordingActive = isActiveRecordingState(recordingRef.current.state)
    const suppress = nativePreviewFramePollingShouldSuppress({
      recordingActive,
      windowOpen: previewWindowRef.current.open,
      status: previewSurfaceStatusRef.current
    })
    const requestKey = `${suppress}:${recordingActive}`
    if (nativePreviewFramePollingRequestKeyRef.current === requestKey) {
      return
    }
    nativePreviewFramePollingRequestKeyRef.current = requestKey
    void window.videorc
      .setNativePreviewSurfaceFramePollingSuppressed(suppress, recordingActive)
      .then((status) => {
        if (nativePreviewFramePollingRequestKeyRef.current === requestKey) {
          applyPreviewSurfaceStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (nativePreviewFramePollingRequestKeyRef.current === requestKey) {
          nativePreviewFramePollingRequestKeyRef.current = null
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
      void syncNativePreviewSurfaceBounds(bounds, previewWindow.supervisor.generation).catch(
        reportError
      )
      return
    }
    if (!previewWindow.open && previewWindowSurfaceActiveRef.current) {
      previewWindowSurfaceActiveRef.current = false
      void teardownDetachedPreviewSurface(previewWindow.supervisor.generation)
    }
  }, [
    nativePreviewSurfaceEnabled,
    previewWindow,
    reportError,
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
    const compositorStatus = committedStatus ?? (await client.requestTyped('compositor.status'))
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
      const selection = await window.videorc.pickScreenImage()
      if (!selection) {
        return
      }

      setScreenImportPending(true)
      const screen = await client.request<StreamScreen>('screens.importImage', {
        sourceCapability: selection.capabilityId
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
  }, [client, refreshScreensForClient, reportError, wsStatus])

  const openSystemPermissionSettings = useCallback(
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
      toast.success('Support bundle exported.', {
        description: basename(result.path)
      })
    } catch (error) {
      reportError(error)
    } finally {
      setSupportBundleExportPending(false)
    }
  }, [client, reportError, runtimeInfo, supportBundleExportPending])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      // F-011: this used to be a silent no-op — the button appeared dead.
      toast.error('Microphone check', {
        description: 'Backend is not connected — try again in a moment.'
      })
      return false
    }

    const sampleGeneration = audioMeterSampleGenerationRef.current + 1
    audioMeterSampleGenerationRef.current = sampleGeneration
    try {
      setLastError(null)
      setAudioMeterLoading(true)
      const result = await client.request<AudioMeterResult>('audio.meter.sample', {
        microphoneId: captureConfig.sources.microphoneId,
        microphoneGainDb: captureConfig.audio.microphoneGainDb,
        microphoneMuted: captureConfig.audio.microphoneMuted
      })
      if (
        audioMeterSampleGenerationRef.current === sampleGeneration &&
        clientRef.current === client
      ) {
        setAudioMeter(result)
        return true
      }
      return false
    } catch (error) {
      if (
        audioMeterSampleGenerationRef.current === sampleGeneration &&
        clientRef.current === client
      ) {
        reportError(error)
      }
      return false
    } finally {
      if (audioMeterSampleGenerationRef.current === sampleGeneration) {
        setAudioMeterLoading(false)
      }
    }
  }, [
    captureConfig.audio.microphoneGainDb,
    captureConfig.audio.microphoneMuted,
    captureConfig.sources.microphoneId,
    client,
    reportError
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

  // Every mic surface edits the same captureConfig. Mirror that one source of
  // truth into the active backend-owned native audio session, scoped by the
  // session id so a delayed update cannot mute/unmute the next capture.
  useEffect(() => {
    const params = activeAudioProcessingUpdateParams(
      { state: recording.state, sessionId: recording.sessionId },
      {
        microphoneGainDb: captureConfig.audio.microphoneGainDb,
        microphoneMuted: captureConfig.audio.microphoneMuted
      }
    )
    if (!params || !client || wsStatus !== 'connected' || stopRequestPending) {
      liveAudioProcessingSyncRef.current?.queue.stop()
      liveAudioProcessingSyncRef.current = null
      return
    }
    if (
      (liveAudioProcessingStartRequestInFlightRef.current || startRequestPending) &&
      liveAudioProcessingStartSnapshotRef.current?.sessionId !== params.sessionId
    ) {
      return
    }

    let sync = liveAudioProcessingSyncRef.current
    let enqueueDesiredForNewSync = false
    if (!sync || sync.sessionId !== params.sessionId) {
      sync?.queue.stop()
      const syncDecision = liveAudioProcessingSessionSyncDecision(
        params,
        liveAudioProcessingStartSnapshotRef.current
      )
      if (liveAudioProcessingStartSnapshotRef.current?.sessionId === params.sessionId) {
        liveAudioProcessingStartSnapshotRef.current = null
      }
      const token = {}
      const queue = new LatestWinsLiveAudioProcessingQueue(
        params.sessionId,
        (requested) => {
          if (runtimeInfo?.windowsLiveAudioSmokeMode) {
            windowsLiveAudioSmokeTelemetryRef.current.requestedCount += 1
          }
          return client.request<AudioProcessingUpdateResult>('audio.processing.update', requested)
        },
        ({ requested, result, error }) => {
          if (runtimeInfo?.windowsLiveAudioSmokeMode) {
            const settings = result?.applied
              ? {
                  microphoneGainDb: result.microphoneGainDb,
                  microphoneMuted: result.microphoneMuted
                }
              : typeof result?.confirmedMicrophoneGainDb === 'number' &&
                  typeof result.confirmedMicrophoneMuted === 'boolean'
                ? {
                    microphoneGainDb: result.confirmedMicrophoneGainDb,
                    microphoneMuted: result.confirmedMicrophoneMuted
                  }
                : undefined
            windowsLiveAudioSmokeTelemetryRef.current.settledCount += 1
            windowsLiveAudioSmokeTelemetryRef.current.lastSettled = {
              requested: { ...requested },
              applied: result?.applied === true,
              ...(result?.reasonCode ? { reasonCode: result.reasonCode } : {}),
              ...(settings ? { settings } : {}),
              ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
            }
          }
          const latest = liveAudioProcessingSyncRef.current
          if (
            latest?.token !== token ||
            recordingRef.current.sessionId !== requested.sessionId ||
            !['recording', 'streaming'].includes(recordingRef.current.state)
          ) {
            return false
          }

          const validResult = result?.sessionId === requested.sessionId ? result : undefined
          const protocolError =
            result && !validResult
              ? new Error('Backend returned live microphone state for a different session.')
              : undefined
          if (validResult?.applied) {
            latest.lastApplied = {
              microphoneGainDb: validResult.microphoneGainDb,
              microphoneMuted: validResult.microphoneMuted
            }
            return true
          }
          if (validResult?.reasonCode === 'session-ended') {
            return false
          }

          const rejection = rejectedLiveAudioProcessingUpdate({
            recording: recordingRef.current,
            current: captureConfigRef.current.audio,
            requested,
            result: validResult,
            lastApplied: latest.lastApplied
          })
          if (!rejection) return true

          latest.disabled = rejection.disableForSession
          setCaptureConfig((current) => {
            const currentRejection = rejectedLiveAudioProcessingUpdate({
              recording: recordingRef.current,
              current: current.audio,
              requested,
              result: validResult,
              lastApplied: latest.lastApplied
            })
            if (!currentRejection) return current
            return {
              ...current,
              audio: { ...current.audio, ...currentRejection.rollback }
            }
          })

          const requestError = protocolError ?? error
          const detail =
            requestError instanceof Error
              ? ` ${requestError.message}`
              : requestError
                ? ` ${String(requestError)}`
                : ''
          reportError(new Error(`${rejection.message}${detail}`))
          return !rejection.disableForSession
        }
      )
      const nextSync = {
        token,
        sessionId: params.sessionId,
        lastApplied: syncDecision.lastApplied,
        disabled: false,
        queue
      }
      sync = nextSync
      liveAudioProcessingSyncRef.current = nextSync
      enqueueDesiredForNewSync = syncDecision.enqueueDesired
    }

    // Once this session proves it has no native post-controls path, keep every
    // mic surface pinned to the last settings the backend actually accepted.
    // A new capture session creates a fresh sync state and retries normally.
    if (sync.disabled) {
      if (
        params.microphoneGainDb !== sync.lastApplied.microphoneGainDb ||
        params.microphoneMuted !== sync.lastApplied.microphoneMuted
      ) {
        const rollback = sync.lastApplied
        setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, ...rollback }
        }))
      }
      return
    }

    const desiredMatchesLastApplied =
      params.microphoneGainDb === sync.lastApplied.microphoneGainDb &&
      params.microphoneMuted === sync.lastApplied.microphoneMuted
    if (!enqueueDesiredForNewSync && !sync.queue.hasOutstandingWork && desiredMatchesLastApplied) {
      return
    }

    sync.queue.enqueue(params)
  }, [
    client,
    recording.sessionId,
    recording.state,
    captureConfig.audio.microphoneGainDb,
    captureConfig.audio.microphoneMuted,
    reportError,
    runtimeInfo?.windowsLiveAudioSmokeMode,
    startRequestPending,
    stopRequestPending,
    wsStatus
  ])

  // Persisted consent is intent; the backend snapshot remains runtime truth.
  // One attempt per capture/toggle/client edge prevents blocked/error states
  // from spinning, while explicit retry edges deliberately try once again.
  const captionsStartAttemptedRef = useRef(false)
  const captionsStopAttemptedRef = useRef(false)
  const captionsAttemptClientRef = useRef<BackendClient | null>(null)
  const captionsAttemptScopeRef = useRef('')
  const captionsCaptureActive = ['recording', 'streaming'].includes(recording.state)
  const captionsAttemptScope = [
    captureConfig.captions.enabled ? 'enabled' : 'disabled',
    suppressCaptionsForSession ? 'suppressed' : 'normal',
    captionsCaptureActive ? `capture:${recording.sessionId ?? 'unknown'}` : 'idle',
    captureConfig.captions.language,
    wsStatus
  ].join(':')
  useEffect(() => {
    if (
      captionsAttemptClientRef.current !== client ||
      captionsAttemptScopeRef.current !== captionsAttemptScope
    ) {
      captionsAttemptClientRef.current = client
      captionsAttemptScopeRef.current = captionsAttemptScope
      captionsStartAttemptedRef.current = false
      captionsStopAttemptedRef.current = false
    }
    if (!client || wsStatus !== 'connected' || captionsCommandPending) return
    const action = decideCaptionsRuntimeIntent({
      persistedEnabled: captureConfig.captions.enabled,
      suppressForSession: suppressCaptionsForSession,
      captureActive: captionsCaptureActive,
      status: captionsStatus,
      startAttempted: captionsStartAttemptedRef.current,
      stopAttempted: captionsStopAttemptedRef.current
    })
    if (action === 'start') {
      if (
        captionRuntimeStartBlocked({
          captureActive: captionsCaptureActive,
          outputReadiness: captionOutputReadiness
        })
      ) {
        setSuppressCaptionsForSession(true)
        toast.error('Live captions cannot start in this session', {
          id: 'captions-output-unsupported',
          description:
            captionOutputReadiness.description ??
            'The active output configuration cannot carry caption pixels.'
        })
        return
      }
      captionsStartAttemptedRef.current = true
      captionsStopAttemptedRef.current = false
      void startCaptions(captureConfig.captions.language).catch((error: unknown) => {
        toast.error('Live captions could not start', {
          description:
            error instanceof Error ? error.message : 'The caption service is unavailable.'
        })
      })
    } else if (action === 'stop') {
      captionsStartAttemptedRef.current = false
      captionsStopAttemptedRef.current = true
      void stopCaptions().catch(() => {})
    }
  }, [
    captionsAttemptScope,
    captionsCaptureActive,
    captionsCommandPending,
    captionOutputReadiness,
    captionsStatus,
    captureConfig.captions.enabled,
    captureConfig.captions.language,
    client,
    startCaptions,
    stopCaptions,
    suppressCaptionsForSession,
    wsStatus
  ])

  // A Go Live override survives confirmation and startup, then clears as soon
  // as that attempted session returns to idle. Persisted consent never changes.
  const suppressedCaptionSessionWasActiveRef = useRef(false)
  useEffect(() => {
    if (suppressCaptionsForSession && isSessionActive) {
      suppressedCaptionSessionWasActiveRef.current = true
      return
    }
    if (!isSessionActive && suppressedCaptionSessionWasActiveRef.current) {
      suppressedCaptionSessionWasActiveRef.current = false
      setSuppressCaptionsForSession(false)
    }
  }, [isSessionActive, suppressCaptionsForSession])

  // Consent is the USER'S durable intent — no code path may revoke it. An
  // earlier effect here silently flipped the toggle off whenever cloud AI
  // readiness was not ready, which also made runAiWorkflow's readiness error
  // toast unreachable (it checks consent first): every run silently downgraded
  // to local-only and "nothing worked" with no visible reason (2026-07-16
  // owner incident — the server had never been configured, and the app never
  // said so). Readiness gates the RUN and the switch's enabled state, never
  // the stored consent.

  // Burn-in driver: a serial latest-wins scheduler replaces the old boolean
  // busy gate, which could permanently drop a final/style update that arrived
  // during rasterization. One render may run and only the newest waits behind it.
  const captionOverlayPushedKey = useRef<string | null>(null)
  const captionOverlayEpochRef = useRef(0)
  const captionOverlayWorkActiveRef = useRef(false)
  const captionOverlayExpiredLineRef = useRef<string | null>(null)
  const captionOverlayWorkerRef = useRef<(work: CaptionOverlayWork) => Promise<void>>(
    async () => {}
  )
  const captionOverlaySchedulerRef = useRef<LatestWinsScheduler<CaptionOverlayWork> | null>(null)
  if (!captionOverlaySchedulerRef.current) {
    captionOverlaySchedulerRef.current = new LatestWinsScheduler((work) =>
      captionOverlayWorkerRef.current(work)
    )
  }
  captionOverlayWorkerRef.current = async (work) => {
    let pushed = false
    for (const output of work.outputs) {
      const pngBase64 = await renderCaptionOverlayPng({
        text: work.text,
        canvasWidth: output.canvasWidth,
        textSize: work.textSize,
        styleId: work.styleId
      })
      if (!pngBase64 || work.epoch !== captionOverlayEpochRef.current) return
      await work.client.request('captions.overlay.set', {
        pngBase64,
        position: work.position,
        target: output.target,
        styleRevision: work.styleRevision
      })
      pushed = true
    }
    if (pushed && work.epoch === captionOverlayEpochRef.current) {
      captionOverlayPushedKey.current = work.key
    }
  }

  // The backend owns final-copy cue rendering after capture stops, so every
  // live appearance revision is mirrored there as well as into overlay pixels.
  useEffect(() => {
    if (
      !client ||
      !isActiveRecordingState(recording.state) ||
      !captureConfig.captions.enabled ||
      suppressCaptionsForSession
    ) {
      return
    }
    void client
      .request('captions.style.set', {
        position: captureConfig.captions.position,
        textSize: captureConfig.captions.textSize,
        styleId: captureConfig.captions.styleId,
        styleRevision: captureConfig.captions.styleRevision
      })
      .catch(() => {})
  }, [
    client,
    recording.state,
    captureConfig.captions.enabled,
    captureConfig.captions.position,
    captureConfig.captions.styleId,
    captureConfig.captions.styleRevision,
    captureConfig.captions.textSize,
    suppressCaptionsForSession
  ])

  useEffect(() => {
    captionOverlayEpochRef.current += 1
    captionOverlaySchedulerRef.current?.clearPending()
    captionOverlayPushedKey.current = null
    captionOverlayWorkActiveRef.current = false
  }, [client])

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
      captionOverlayEpochRef.current += 1
      captionOverlaySchedulerRef.current?.clearPending()
      captionOverlayPushedKey.current = null
      captionOverlayWorkActiveRef.current = false
      captionOverlayExpiredLineRef.current = null
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
    const latest = captionLines.at(-1)
    const streamVideo = auxiliaryStreamOutputVideoSettings(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined
    )
    const outputs = captionOverlayTargetPlan({
      burnTarget: captureConfig.captions.burnTarget,
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: captureConfig.streamEnabled,
      recordingVideo: captureConfig.video,
      streamVideo
    })
    const candidateKey = latest
      ? outputs
          .map((output) =>
            captionOverlayKey(latest, {
              styleId: captureConfig.captions.styleId,
              styleRevision: captureConfig.captions.styleRevision,
              position: captureConfig.captions.position,
              textSize: captureConfig.captions.textSize,
              canvasWidth: output.canvasWidth,
              canvasHeight: output.canvasHeight,
              outputLeg: output.target
            })
          )
          .join('|')
      : undefined
    const burnIn = outputs.length > 0
    const captionsRunning = captionsStatusIsActive(captionsStatus)
    const decision = decideOverlayPush({
      burnIn,
      captionsRunning,
      sessionActive: isSessionActive,
      latest,
      floor: captionSessionFloorRef.current,
      pushedKey: captionOverlayPushedKey.current,
      candidateKey,
      expiredLineId: captionOverlayExpiredLineRef.current
    })
    if (
      decision.action === 'clear' ||
      ((!burnIn || !captionsRunning || !isSessionActive) && captionOverlayWorkActiveRef.current)
    ) {
      captionOverlayEpochRef.current += 1
      captionOverlaySchedulerRef.current?.clearPending()
      captionOverlayPushedKey.current = null
      captionOverlayWorkActiveRef.current = false
      void client
        .request('captions.overlay.clear', {
          styleRevision: captureConfig.captions.styleRevision
        })
        .catch(() => {})
      return
    }
    if (decision.action !== 'push' || !latest || !decision.key) {
      return
    }
    captionOverlayWorkActiveRef.current = true
    captionOverlaySchedulerRef.current?.enqueue({
      client,
      epoch: captionOverlayEpochRef.current,
      key: decision.key,
      text: latest.text,
      outputs: outputs.map((output) => ({
        target: output.target,
        canvasWidth: output.canvasWidth,
        canvasHeight: output.canvasHeight
      })),
      styleId: captureConfig.captions.styleId,
      styleRevision: captureConfig.captions.styleRevision,
      textSize: captureConfig.captions.textSize,
      position: captureConfig.captions.position
    })
  }, [
    client,
    captionLines,
    captionsStatus,
    isSessionActive,
    captureConfig.captions,
    captureConfig.recordEnabled,
    captureConfig.video,
    captureConfig.streamEnabled,
    captureConfig.streaming
  ])

  // Silence expiry belongs to the current line, not to a render attempt. Every
  // partial refresh restarts the clock; finals dwell by readable text length.
  const latestCaption = captionLines.at(-1)
  useEffect(() => {
    if (
      !client ||
      !latestCaption ||
      !isSessionActive ||
      captureConfig.captions.burnTarget === 'off'
    ) {
      return
    }
    const identity = captionLineIdentity(latestCaption)
    captionOverlayExpiredLineRef.current = null
    const dwellMs = latestCaption.kind === 'partial' ? 6000 : captionDwellMs(latestCaption.text)
    const timer = window.setTimeout(() => {
      const current = captionLinesRef.current.at(-1)
      if (!current || captionLineIdentity(current) !== identity) return
      captionOverlayExpiredLineRef.current = identity
      captionOverlayEpochRef.current += 1
      captionOverlaySchedulerRef.current?.clearPending()
      captionOverlayPushedKey.current = null
      captionOverlayWorkActiveRef.current = false
      void client
        .request('captions.overlay.clear', {
          styleRevision: captureConfig.captions.styleRevision
        })
        .catch(() => {})
    }, dwellMs)
    return () => window.clearTimeout(timer)
  }, [client, captureConfig.captions, isSessionActive, latestCaption])

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

  const reorderScreen = useCallback(
    async (screenId: string, targetIndex: number) => {
      if (!client || isSessionActive) {
        toast.error(
          isSessionActive
            ? 'Screen management is locked while live.'
            : 'Backend socket is not connected.'
        )
        return
      }

      const currentIndex = screens.findIndex((screen) => screen.id === screenId)
      const nextIndex = Math.max(0, Math.min(screens.length - 1, targetIndex))
      if (currentIndex === -1 || nextIndex === currentIndex) {
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
    const signOut = window.videorc?.signOutAccount
    if (!signOut) {
      return
    }
    try {
      const nextAccount = await signOut()
      setAccount(nextAccount)
      if (client && wsStatus === 'connected') {
        await Promise.all([
          refreshAiReadinessForClient(client, nextAccount),
          refreshEntitlementsForClient(client)
        ])
      }
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshAiReadinessForClient, refreshEntitlementsForClient, reportError, wsStatus])

  const completeAccountSignIn = useCallback(
    async (envelope: AccountCallbackEnvelope): Promise<'complete' | 'retry'> => {
      const api = window.videorc
      if (!client || wsStatus !== 'connected' || !api?.acknowledgeAccountCallback) {
        return 'retry'
      }

      const callbackUrl = new URL(envelope.url)
      const code = callbackUrl.searchParams.get('code')?.trim()
      const state = callbackUrl.searchParams.get('state')?.trim()
      const verifier = callbackUrl.searchParams.get('verifier')?.trim()
      if (
        callbackUrl.protocol !== 'videorc:' ||
        callbackUrl.hostname !== 'account' ||
        callbackUrl.pathname !== '/callback' ||
        !code ||
        !state ||
        !verifier ||
        state !== envelope.state
      ) {
        throw new Error('Desktop account callback did not match its sign-in transaction.')
      }
      let nextAccount: VideorcAccountSnapshot
      try {
        nextAccount = await client.requestTyped('account.complete_sign_in', {
          code,
          state,
          verifier,
          intentGeneration: envelope.intentGeneration
        })
      } catch (error) {
        if (error instanceof BackendRequestError && error.code === 'account-sign-in-superseded') {
          // A newer sign-in or explicit sign-out is authoritative. Retire the
          // durable stale envelope; retrying it could never be correct.
          await api.acknowledgeAccountCallback(envelope.id)
          accountCallbacksCompletedRef.current.add(envelope.id)
          return 'complete'
        }
        throw error
      }
      // Backend persistence is the commit edge. Only ACK the durable envelope
      // after that commit; UI/readiness refresh is intentionally outside it.
      await api.acknowledgeAccountCallback(envelope.id)
      accountCallbacksCompletedRef.current.add(envelope.id)
      setAccount(nextAccount)
      try {
        await Promise.all([
          refreshAiReadinessForClient(client, nextAccount),
          refreshEntitlementsForClient(client)
        ])
      } catch (error) {
        reportError(error)
      }
      return 'complete'
    },
    [client, refreshAiReadinessForClient, refreshEntitlementsForClient, reportError, wsStatus]
  )

  useEffect(() => {
    if (
      !window.videorc?.getPendingAccountCallbacks ||
      !window.videorc.acknowledgeAccountCallback ||
      !window.videorc.onAccountCallback ||
      !client ||
      wsStatus !== 'connected'
    ) {
      return
    }

    let disposed = false
    const retryAttempts = new Map<string, number>()
    const retryTimers = new Set<number>()
    const ownedCallbackIds = new Set<string>()
    const exhaustedCallbackIds = new Set<string>()
    const inFlightCallbacks = accountCallbacksInFlightRef.current
    const exhaustRetries = (envelope: AccountCallbackEnvelope): void => {
      retryAttempts.delete(envelope.id)
      ownedCallbackIds.delete(envelope.id)
      inFlightCallbacks.delete(envelope.id)
      exhaustedCallbackIds.add(envelope.id)
      toast.error(
        'Account sign-in is still unavailable. Videorc kept the callback without acknowledging it.'
      )
    }
    const scheduleRetry = (envelope: AccountCallbackEnvelope): void => {
      if (disposed) return
      const attempt = retryAttempts.get(envelope.id) ?? 0
      const retryDelayMs = accountCallbackRetryDelayMs(
        envelope.receivedAtMs,
        envelope.expiresAtMs,
        attempt,
        Date.now()
      )
      if (retryDelayMs === null) {
        exhaustRetries(envelope)
        return
      }
      retryAttempts.set(envelope.id, attempt + 1)
      if (attempt === 0) {
        toast.error('Account sign-in is temporarily unavailable. Videorc will retry.')
      }
      const timer = window.setTimeout(() => {
        retryTimers.delete(timer)
        inFlightCallbacks.delete(envelope.id)
        processEnvelope(envelope)
      }, retryDelayMs)
      retryTimers.add(timer)
    }
    const processEnvelope = (envelope: AccountCallbackEnvelope): void => {
      if (
        disposed ||
        exhaustedCallbackIds.has(envelope.id) ||
        accountCallbacksCompletedRef.current.has(envelope.id) ||
        inFlightCallbacks.has(envelope.id)
      ) {
        return
      }
      ownedCallbackIds.add(envelope.id)
      inFlightCallbacks.add(envelope.id)
      void completeAccountSignIn(envelope)
        .then((disposition) => {
          if (disposition === 'retry' && !disposed) {
            scheduleRetry(envelope)
            return
          }
          retryAttempts.delete(envelope.id)
          ownedCallbackIds.delete(envelope.id)
          inFlightCallbacks.delete(envelope.id)
        })
        .catch(() => scheduleRetry(envelope))
    }
    void window.videorc
      .getPendingAccountCallbacks()
      .then((envelopes) => envelopes.forEach(processEnvelope))
      .catch(reportError)
    const unsubscribe = window.videorc.onAccountCallback(processEnvelope)
    return () => {
      disposed = true
      retryTimers.forEach((timer) => window.clearTimeout(timer))
      ownedCallbackIds.forEach((id) => inFlightCallbacks.delete(id))
      unsubscribe()
    }
  }, [client, completeAccountSignIn, reportError, wsStatus])

  const completeProviderOAuthCallback = useCallback(
    async (envelope: OAuthCallbackEnvelope): Promise<'complete' | 'retry'> => {
      const api = window.videorc
      if (!client || wsStatus !== 'connected' || !api?.acknowledgeOAuthCallback) {
        return 'retry'
      }

      const parsed = new URL(envelope.url)
      if (
        parsed.protocol !== 'videorc:' ||
        parsed.hostname !== 'oauth' ||
        parsed.pathname !== '/callback' ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.hash
      ) {
        throw new Error('Provider OAuth callback had an invalid redirect URI.')
      }

      const state = parsed.searchParams.get('state')?.trim()
      if (!state || state !== envelope.state) {
        throw new Error('Provider OAuth callback state did not match its durable envelope.')
      }

      const params: OAuthCompleteParams = {
        state,
        code: parsed.searchParams.get('code') ?? undefined,
        error: parsed.searchParams.get('error') ?? undefined,
        errorDescription: parsed.searchParams.get('error_description') ?? undefined
      }

      // The backend consumes the pending OAuth state and persists any token.
      // Only then may the main-process queue discard its single-use callback.
      const result = await client.requestTyped('platformAccounts.oauth.complete', params)
      if (result.retryable) {
        return 'retry'
      }
      await api.acknowledgeOAuthCallback(envelope.id)
      providerOAuthCallbacksCompletedRef.current.add(envelope.id)
      return 'complete'
    },
    [client, wsStatus]
  )

  useEffect(() => {
    if (
      !window.videorc?.getPendingOAuthCallbacks ||
      !window.videorc.acknowledgeOAuthCallback ||
      !window.videorc.onOAuthCallbackUrl ||
      !client ||
      wsStatus !== 'connected'
    ) {
      return
    }

    let disposed = false
    const retryAttempts = new Map<string, number>()
    const retryTimers = new Set<number>()
    const ownedCallbackIds = new Set<string>()
    const exhaustedCallbackIds = new Set<string>()
    const inFlightCallbacks = providerOAuthCallbacksInFlightRef.current
    const exhaustRetries = (envelope: OAuthCallbackEnvelope): void => {
      retryAttempts.delete(envelope.id)
      ownedCallbackIds.delete(envelope.id)
      inFlightCallbacks.delete(envelope.id)
      exhaustedCallbackIds.add(envelope.id)
      toast.error(
        'OAuth completion is still unavailable. Videorc kept the callback without acknowledging it.'
      )
    }
    const scheduleRetry = (envelope: OAuthCallbackEnvelope): void => {
      if (disposed) return
      const attempt = retryAttempts.get(envelope.id) ?? 0
      const retryDelayMs = providerOAuthRetryDelayMs(envelope.receivedAtMs, attempt, Date.now())
      if (retryDelayMs === null) {
        exhaustRetries(envelope)
        return
      }
      retryAttempts.set(envelope.id, attempt + 1)
      if (attempt === 0) {
        toast.error('OAuth completion is temporarily unavailable. Videorc will retry.')
      }
      const timer = window.setTimeout(() => {
        retryTimers.delete(timer)
        inFlightCallbacks.delete(envelope.id)
        processEnvelope(envelope)
      }, retryDelayMs)
      retryTimers.add(timer)
    }
    const processEnvelope = (envelope: OAuthCallbackEnvelope): void => {
      if (
        disposed ||
        exhaustedCallbackIds.has(envelope.id) ||
        providerOAuthCallbacksCompletedRef.current.has(envelope.id) ||
        inFlightCallbacks.has(envelope.id)
      ) {
        return
      }
      ownedCallbackIds.add(envelope.id)
      inFlightCallbacks.add(envelope.id)
      void completeProviderOAuthCallback(envelope)
        .then((disposition) => {
          if (disposition === 'retry' && !disposed) {
            scheduleRetry(envelope)
            return
          }
          retryAttempts.delete(envelope.id)
          ownedCallbackIds.delete(envelope.id)
          inFlightCallbacks.delete(envelope.id)
        })
        .catch(() => {
          scheduleRetry(envelope)
        })
    }
    void window.videorc
      .getPendingOAuthCallbacks()
      .then((envelopes) => envelopes.forEach(processEnvelope))
      .catch(reportError)
    const unsubscribe = window.videorc.onOAuthCallbackUrl(processEnvelope)
    return () => {
      disposed = true
      retryTimers.forEach((timer) => window.clearTimeout(timer))
      ownedCallbackIds.forEach((id) => inFlightCallbacks.delete(id))
      unsubscribe()
    }
  }, [client, completeProviderOAuthCallback, reportError, wsStatus])

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
        streamingForStart = streamingOverride ?? null
        platformLifecycleStreamingRef.current = streamingForStart
        const lifecycleRunId = platformLifecycleRun.current + 1
        platformLifecycleRun.current = lifecycleRunId
        const enabledOauthTargets =
          streamingForStart?.targets.filter(
            (target) => target.enabled && target.authMode === 'oauth'
          ) ?? []
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
        const outputDirectory = settings.outputDirectoryHandle
          ? await window.videorc?.authorizeOutputDirectory?.(settings.outputDirectoryHandle)
          : null
        if (settings.outputDirectoryHandle && !outputDirectory) {
          throw new Error('The selected output folder is unavailable. Choose it again in Settings.')
        }
        const authorizedOutput = {
          ...sessionParams.output,
          ...(outputDirectory ? { outputDirectoryCapability: outputDirectory.capabilityId } : {})
        }
        const nextSessionParams: StartSessionParams = streamingOverride
          ? {
              ...sessionParams,
              output: { ...authorizedOutput, streamEnabled: true },
              streaming: streamingOverride
            }
          : {
              ...sessionParams,
              output: { ...authorizedOutput, streamEnabled: false },
              streaming: undefined
            }
        const startAudioSnapshot = nextSessionParams.audio
          ? {
              microphoneGainDb: nextSessionParams.audio.microphoneGainDb,
              microphoneMuted: nextSessionParams.audio.microphoneMuted
            }
          : null
        liveAudioProcessingStartSnapshotRef.current = null
        liveAudioProcessingStartRequestInFlightRef.current = true
        let status: RecordingStatus
        try {
          status = await client.requestTyped('session.start', nextSessionParams)
        } finally {
          liveAudioProcessingStartRequestInFlightRef.current = false
        }
        liveAudioProcessingStartSnapshotRef.current =
          status.sessionId && startAudioSnapshot
            ? { sessionId: status.sessionId, ...startAudioSnapshot }
            : null
        applyRecordingStatus(status)
        await refreshSessions(client)
        if (streamingForStart) {
          await activatePreparedYouTubeBroadcasts(streamingForStart, lifecycleRunId)
          await activatePreparedXBroadcasts(
            streamingForStart,
            lifecycleRunId,
            status.sessionId ?? recordingRef.current.sessionId
          )
        }
      } catch (error) {
        if (streamingOverride && streamingForStart) {
          await completePreparedPlatformBroadcasts(streamingForStart)
        }
        platformLifecycleStreamingRef.current = null
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
      client,
      completePreparedPlatformBroadcasts,
      isSessionActive,
      refreshSessions,
      reportError,
      sessionParams,
      settings.outputDirectoryHandle,
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
      setSuppressCaptionsForSession(false)
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
      const [preflight] = await Promise.all([
        client.request<GoLivePreflight>('streamTargets.confirmation.validate', {
          streaming: captureConfig.streaming
        }),
        captureConfig.captions.enabled
          ? client
              .request<AiCapabilities>('ai.capabilities.get')
              .then((capabilities) => {
                setAiCapabilities(capabilities)
                setAiReadinessError(null)
              })
              .catch((error: unknown) => {
                setAiCapabilities(null)
                setAiReadinessError(error instanceof Error ? error.message : String(error))
              })
          : Promise.resolve()
      ])
      setGoLivePreflight(preflight)
      setGoLiveConfirmationOpen(true)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [
    captureConfig.captions.enabled,
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
    setSuppressCaptionsForSession(false)
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
    if (goLiveCaptionsReadiness.blocksStart) {
      toast.warning('Live captions are not ready.', {
        description: goLiveCaptionsReadiness.description
      })
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
    goLiveCaptionsReadiness,
    prepareOauthTargetsForGoLive,
    reportError,
    runStartSession,
    startRequestPending,
    streamMetadataDraft
  ])

  const continueGoLiveWithReadyDestinations = useCallback(async () => {
    if (goLiveCaptionsReadiness.blocksStart) {
      toast.warning('Live captions are not ready.', {
        description: goLiveCaptionsReadiness.description
      })
      return
    }
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
    goLiveCaptionsReadiness,
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
      liveAudioProcessingSyncRef.current?.queue.stop()
      const sessionHasStreamOutput =
        platformLifecycleStreamingRef.current !== null || Boolean(recordingRef.current.streamUrl)
      // Docs order for a real Go Live: END X while the feed is still up, THEN
      // stop the encoder. A local recording must never inspect or mutate stale
      // platform lifecycle state merely because saved destinations are enabled.
      const cleaned = sessionHasStreamOutput
        ? await endPreparedXBroadcasts(
            captureConfig.streaming,
            recordingRef.current.sessionId,
            4000
          )
        : null
      const status = await client.requestTyped('session.stop')
      applyRecordingStatus(status)
      if (cleaned) {
        await completePreparedPlatformBroadcasts(cleaned)
      }
      platformLifecycleStreamingRef.current = null
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

  useEffect(() => {
    type WindowsLiveAudioSmokeWindow = Window & {
      __videorcWindowsLiveAudioHarness?: (
        request: WindowsLiveAudioSmokeRequest
      ) => Promise<WindowsLiveAudioSmokeState>
    }
    const smokeWindow = window as WindowsLiveAudioSmokeWindow
    if (!runtimeInfo?.windowsLiveAudioSmokeMode) {
      delete smokeWindow.__videorcWindowsLiveAudioHarness
      return
    }

    const snapshot = (): WindowsLiveAudioSmokeState =>
      windowsLiveAudioSmokeState({
        recording: recordingRef.current,
        lastError: lastErrorRef.current,
        captureConfig: captureConfigRef.current,
        telemetry: windowsLiveAudioSmokeTelemetryRef.current
      })
    const applyAudio = (microphoneGainDb: number, microphoneMuted: boolean): void => {
      const next = {
        ...captureConfigRef.current,
        audio: {
          ...captureConfigRef.current.audio,
          microphoneGainDb,
          microphoneMuted
        }
      }
      captureConfigRef.current = next
      setCaptureConfig(next)
    }
    const harness = async (
      request: WindowsLiveAudioSmokeRequest
    ): Promise<WindowsLiveAudioSmokeState> => {
      switch (request.action) {
        case 'configure': {
          const next = configureWindowsLiveAudioSmokeCapture(
            captureConfigRef.current,
            deviceList.devices,
            request
          )
          windowsLiveAudioSmokeTelemetryRef.current = {
            requestedCount: 0,
            settledCount: 0,
            lastSettled: null
          }
          captureConfigRef.current = next
          setCaptureConfig(next)
          await new Promise<void>((resolveFrame) =>
            window.requestAnimationFrame(() => resolveFrame())
          )
          return snapshot()
        }
        case 'start':
          await startSession()
          return snapshot()
        case 'set-audio':
          applyAudio(request.microphoneGainDb, request.microphoneMuted)
          return snapshot()
        case 'rapid-burst':
          for (const update of WINDOWS_LIVE_AUDIO_SMOKE_BURST) {
            applyAudio(update.microphoneGainDb, update.microphoneMuted)
            await new Promise<void>((resolveDelay) => window.setTimeout(resolveDelay, 20))
          }
          return snapshot()
        case 'stop':
          await stopSession()
          return snapshot()
        case 'state':
          return snapshot()
      }
    }
    smokeWindow.__videorcWindowsLiveAudioHarness = harness
    return () => {
      if (smokeWindow.__videorcWindowsLiveAudioHarness === harness) {
        delete smokeWindow.__videorcWindowsLiveAudioHarness
      }
    }
  }, [deviceList.devices, runtimeInfo?.windowsLiveAudioSmokeMode, startSession, stopSession])

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

  // Delete is a durable two-phase operation. The backend first hides each row
  // and atomically renames identity-matched media to operation-owned quarantine
  // paths. Electron moves only those quarantine paths to the system Trash, and
  // an acknowledgement removes the row after every move succeeds. Replacements
  // at the original path can therefore never cross the backend-check/Electron-
  // use boundary and be trashed by mistake.
  const deleteSessions = useCallback(
    async (targets: SessionSummary[]): Promise<void> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const operations: SessionDeletionOperation[] = await client.requestTyped('sessions.delete', {
        sessionIds: targets.map((session) => session.id)
      })
      let failedCount = 0
      for (const operation of operations) {
        const result = await window.videorc?.trashSessionDeletion?.(operation.operationId)
        failedCount += result?.failedCount ?? operation.pathCount + operation.blockedPathCount
      }
      await Promise.all([refreshSessions(client), refreshNoiseCleanupJobs(client)])
      if (failedCount > 0) {
        throw new Error(
          `${failedCount} file(s) could not be moved to Trash; their sessions were kept.`
        )
      }
    },
    [client, refreshNoiseCleanupJobs, refreshSessions]
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
    const source = await window.videorc?.pickFile?.()
    if (!source) {
      return
    }
    const outputDirectory = settings.outputDirectoryHandle
      ? await window.videorc?.authorizeOutputDirectory?.(settings.outputDirectoryHandle)
      : null
    if (settings.outputDirectoryHandle && !outputDirectory) {
      throw new Error('The selected output folder is unavailable. Choose it again in Settings.')
    }
    // Blank means the platform default — the backend resolves and creates it,
    // exactly like recording does (Settings: "Blank uses the default").
    await client.request('sessions.import', {
      sourceCapability: source.capabilityId,
      outputDirectoryCapability: outputDirectory?.capabilityId
    })
    await refreshSessions(client)
  }, [client, refreshSessions, settings.outputDirectoryHandle])

  const startNoiseCleanup = useCallback(
    async (sessionId: string): Promise<NoiseCleanupJob> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const job = await client.requestTyped('noiseCleanup.start', { sessionId })
      setNoiseCleanupJobs((current) => upsertNoiseCleanupJob(current, job))
      return job
    },
    [client]
  )

  const cancelNoiseCleanup = useCallback(
    async (jobId: string): Promise<NoiseCleanupJob> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const job = await client.requestTyped('noiseCleanup.cancel', { jobId })
      setNoiseCleanupJobs((current) => upsertNoiseCleanupJob(current, job))
      return job
    },
    [client]
  )

  const ensureSessionPoster = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!client) {
        return false
      }
      try {
        const result = await client.request<{ available: boolean }>('sessions.poster', {
          sessionId
        })
        return result.available
      } catch {
        return false
      }
    },
    [client]
  )

  const remuxSession = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        await client.request('session.remux_mp4', {
          sessionId
        })
        await Promise.all([refreshSessions(client), refreshNoiseCleanupJobs(client)])
        toast.success('Remuxed recording to MP4.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshNoiseCleanupJobs, refreshSessions, reportError]
  )

  const runAiWorkflow = useCallback(
    async (sessionId: string, options?: { outputs?: string[]; tone?: string }) => {
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
          outputs: options?.outputs,
          tone: options?.tone
        })
        await refreshSessions(client)
        // FX3: the local-only run needs an explicit, named result — "nothing
        // visibly happened" was the by-eye finding. Name the produced file.
        if (aiConsent) {
          toast.success('Publish pack generated.')
        } else if (
          result.artifacts.some(
            (artifact) => artifact.kind === 'transcript' && artifact.status === 'ready'
          )
        ) {
          toast.success('Transcript ready from live captions.', {
            description:
              'Enable cloud consent to generate the title, description, and the rest of the pack — the transcript uploads as text only.'
          })
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
      reportError
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
        const fileCount = result.files?.length ?? 1
        toast.success(
          `Publish pack exported (${fileCount} ${fileCount === 1 ? 'file' : 'files'}).`,
          {
            description: result.markdownPath
          }
        )
      } catch (error) {
        reportError(error)
      } finally {
        setExportRunningSessionId(null)
      }
    },
    [client, reportError]
  )

  const suggestClips = useCallback(
    async (sessionId: string): Promise<ClipSuggestResult | null> => {
      if (!client) {
        toast.error('Clips', { description: 'Backend is not connected — try again in a moment.' })
        return null
      }
      try {
        return await client.request<ClipSuggestResult>('ai.clips.suggest', { sessionId })
      } catch (error) {
        reportError(error)
        return null
      }
    },
    [client, reportError]
  )

  const exportClip = useCallback(
    async (sessionId: string, startMs: number, endMs: number): Promise<void> => {
      if (!client) {
        toast.error('Clips', { description: 'Backend is not connected — try again in a moment.' })
        return
      }
      try {
        const result = await client.request<ClipExportResult>('ai.clip.export', {
          sessionId,
          startMs,
          endMs
        })
        toast.success('Clip exported next to the recording.', {
          description: basename(result.path),
          action: {
            label: 'Reveal',
            onClick: () => {
              void window.videorc?.revealSession?.(sessionId)
            }
          }
        })
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError]
  )

  const assessRecording = useCallback(
    async (sessionId: string): Promise<FileAssessment> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      return client.requestTyped('repair.assess_file', { sessionId })
    },
    [client]
  )

  const repairRecording = useCallback(
    async (sessionId: string): Promise<GateStatus> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const result = await client.requestTyped('repair.repair_file', { sessionId })
      await Promise.all([refreshSessions(client), refreshNoiseCleanupJobs(client)])
      return result
    },
    [client, refreshNoiseCleanupJobs, refreshSessions]
  )

  const restoreRecording = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!client) {
        throw new Error('Backend is not connected.')
      }
      const result = await client.requestTyped('repair.restore_file', { sessionId })
      if (result.restored) {
        await Promise.all([refreshSessions(client), refreshNoiseCleanupJobs(client)])
      }
      return result.restored
    },
    [client, refreshNoiseCleanupJobs, refreshSessions]
  )

  const patchVideo = useCallback((patch: Partial<VideoSettings>) => {
    setCaptureConfig((current) => ({
      ...current,
      // The Studio mode owns the canvas orientation — a patch that would
      // contradict the active scene's orientation transposes width/height.
      video: coerceVideoToOrientation(
        { ...current.video, ...patch, preset: 'custom' },
        layoutPresetOrientation(current.layout.layoutPreset)
      )
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

      setCaptureConfig((current) => ({
        ...current,
        video: coerceVideoToOrientation(video, layoutPresetOrientation(current.layout.layoutPreset))
      }))
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
  const meterLevel = Math.round((audioMeter?.level ?? 0) * 100)
  const canSampleAudio = Boolean(wsStatus === 'connected' && selectedMicrophone && !isSessionActive)
  const canSampleAudioRef = useRef(canSampleAudio)
  const sampleAudioMeterRef = useRef(sampleAudioMeter)
  canSampleAudioRef.current = canSampleAudio
  sampleAudioMeterRef.current = sampleAudioMeter

  useEffect(() => {
    const pendingProof = pendingMicrophonePermissionProof
    if (!pendingProof || !client || wsStatus !== 'connected') {
      return
    }

    let cancelled = false
    let retryTimer: number | undefined
    const scheduleRetry = (): boolean => {
      if (cancelled || clientRef.current !== client || pendingProof.retry >= 2) return false
      retryTimer = window.setTimeout(() => {
        setPendingMicrophonePermissionProof((current) =>
          current === pendingProof && current ? { ...current, retry: current.retry + 1 } : current
        )
      }, 250)
      return true
    }
    void (async () => {
      try {
        const { runMicrophonePermissionProof } =
          await import('@/lib/system-permission-orchestration')
        const completed = await runMicrophonePermissionProof({
          client,
          proof: pendingProof,
          isCurrent: () =>
            !cancelled && clientRef.current === client && wsStatusRef.current === 'connected',
          setDeviceList,
          canSampleAudio: () => canSampleAudioRef.current,
          sampleAudioMeter: () => sampleAudioMeterRef.current()
        })
        if (completed && !cancelled) {
          setPendingMicrophonePermissionProof((current) =>
            current === pendingProof ? null : current
          )
        } else {
          scheduleRetry()
        }
      } catch (error) {
        if (!scheduleRetry() && !cancelled && clientRef.current === client) {
          reportError(error)
        }
      }
    })()

    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [canSampleAudio, client, pendingMicrophonePermissionProof, reportError, wsStatus])

  const handleSystemPermission = useCallback(
    async (pane: SystemPermissionPane): Promise<void> => {
      try {
        const { runSystemPermissionAction } = await import('@/lib/system-permission-orchestration')
        await runSystemPermissionAction({
          pane,
          platform: runtimeInfo?.platform,
          refreshMediaAccess,
          getDeviceList: () => deviceListRef.current,
          getAudioMeter: () => audioMeterRef.current,
          openSystemPermissionSettings,
          getClient: () => clientRef.current,
          getWsStatus: () => wsStatusRef.current,
          clearMicrophoneEvidence: () => {
            audioMeterSampleGenerationRef.current += 1
            audioMeterRef.current = null
            setAudioMeterLoading(false)
            setAudioMeter(null)
            setPendingMicrophonePermissionProof(null)
          },
          deferMicrophoneProof: (proof) =>
            setPendingMicrophonePermissionProof({ ...proof, retry: 0 }),
          setDeviceList,
          reportError
        })
      } catch (error) {
        reportError(error)
      }
    },
    [openSystemPermissionSettings, refreshMediaAccess, reportError, runtimeInfo?.platform]
  )

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

  const shellValue = useMemo<StudioShellContextValue>(
    () => ({
      wsStatus,
      backendConnected: Boolean(connection && wsStatus === 'connected'),
      recordingState: recording.state,
      runtimeInfo,
      entitlementTier: entitlements?.tier ?? null,
      previewWindowOpen: previewWindow.open,
      togglePreviewWindow,
      notesWindowOpen: notesWindow.open,
      openNotesWindow,
      closeNotesWindow,
      commentsWindowOpen: commentsWindow.open,
      openCommentsWindow,
      closeCommentsWindow,
      toggleCommentsWindow,
      toggleCaptionsWindow
    }),
    [
      closeCommentsWindow,
      closeNotesWindow,
      commentsWindow.open,
      connection,
      entitlements?.tier,
      notesWindow.open,
      openCommentsWindow,
      openNotesWindow,
      previewWindow.open,
      recording.state,
      runtimeInfo,
      toggleCommentsWindow,
      toggleCaptionsWindow,
      togglePreviewWindow,
      wsStatus
    ]
  )

  const diagnosticsValue = useMemo<StudioDiagnosticsContextValue>(
    () => ({ diagnosticStats, healthEvents, logs, previewSurfaceStatus, streamHealth }),
    [diagnosticStats, healthEvents, logs, previewSurfaceStatus, streamHealth]
  )
  const chatValue = useMemo<StudioChatContextValue>(
    () => ({ liveChatSnapshot }),
    [liveChatSnapshot]
  )
  const audioValue = useMemo<StudioAudioContextValue>(
    () => ({ audioMeter, audioMeterLoading, meterLevel }),
    [audioMeter, audioMeterLoading, meterLevel]
  )
  const recordingStateValue = useMemo<StudioRecordingStateContextValue>(
    () => ({ recording: { state: recording.state, sessionId: recording.sessionId } }),
    [recording.sessionId, recording.state]
  )
  const recordingValue = useMemo<StudioRecordingContextValue>(() => ({ recording }), [recording])
  const previewValue = useMemo<StudioPreviewContextValue>(
    () => ({ previewLiveStatus, previewCameraStatus, previewScreenStatus }),
    [previewCameraStatus, previewLiveStatus, previewScreenStatus]
  )

  const value = useMemo<StudioCoreContextValue>(
    () => ({
      connection,
      wsStatus,
      health,
      entitlements,
      noiseCleanupJobs,
      account,
      aiCapabilities,
      aiQuota,
      aiReadinessError,
      aiReadinessLoading,
      signOutAccount,
      deviceList: visibleDeviceList,
      streamTargets,
      sessions,
      sessionsNextCursor,
      sessionsLoadingMore,
      sessionDetails,
      sessionDetailsLoading,
      sessionDetailError,
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
      clearLiveChat,
      captionsStatus,
      captionLines,
      captionsCommandPending,
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
      goLiveCaptionsReadiness,
      continueGoLiveWithoutCaptions,
      previewUrl,
      previewLoading,
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
      loadMoreSessions,
      loadSessionDetails,
      refreshEntitlements,
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
      reorderScreen,
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
      handleSystemPermission,
      openSystemPermissionSettings,
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
      startNoiseCleanup,
      cancelNoiseCleanup,
      sessionStorageTotals,
      runAiWorkflow,
      exportPublishPack,
      suggestClips,
      exportClip,
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
      canSampleAudio
    }),
    [
      connection,
      wsStatus,
      health,
      entitlements,
      noiseCleanupJobs,
      account,
      aiCapabilities,
      aiQuota,
      aiReadinessError,
      aiReadinessLoading,
      signOutAccount,
      visibleDeviceList,
      streamTargets,
      sessions,
      sessionsNextCursor,
      sessionsLoadingMore,
      sessionDetails,
      sessionDetailsLoading,
      sessionDetailError,
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
      clearLiveChat,
      captionsStatus,
      captionLines,
      captionsCommandPending,
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
      goLiveCaptionsReadiness,
      continueGoLiveWithoutCaptions,
      previewUrl,
      previewLoading,
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
      loadMoreSessions,
      loadSessionDetails,
      refreshEntitlements,
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
      reorderScreen,
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
      handleSystemPermission,
      openSystemPermissionSettings,
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
      startNoiseCleanup,
      cancelNoiseCleanup,
      sessionStorageTotals,
      runAiWorkflow,
      exportPublishPack,
      suggestClips,
      exportClip,
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
      canSampleAudio
    ]
  )

  return (
    <StudioShellContext.Provider value={shellValue}>
      <StudioContextProviders
        audio={audioValue}
        chat={chatValue}
        core={value}
        diagnostics={diagnosticsValue}
        preview={previewValue}
        recording={recordingValue}
        recordingState={recordingStateValue}
      >
        {children}
      </StudioContextProviders>
    </StudioShellContext.Provider>
  )
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
    nativePreviewMutationQueueCapacity:
      hostStatus.nativePreviewMutationQueueCapacity ??
      backendStatus.nativePreviewMutationQueueCapacity,
    nativePreviewMutationQueueDepth:
      hostStatus.nativePreviewMutationQueueDepth ?? backendStatus.nativePreviewMutationQueueDepth,
    nativePreviewMutationQueueActiveCount:
      hostStatus.nativePreviewMutationQueueActiveCount ??
      backendStatus.nativePreviewMutationQueueActiveCount,
    nativePreviewMutationQueuePendingCount:
      hostStatus.nativePreviewMutationQueuePendingCount ??
      backendStatus.nativePreviewMutationQueuePendingCount,
    nativePreviewMutationQueueMaxDepth:
      hostStatus.nativePreviewMutationQueueMaxDepth ??
      backendStatus.nativePreviewMutationQueueMaxDepth,
    nativePreviewMutationQueueRejectedCount:
      hostStatus.nativePreviewMutationQueueRejectedCount ??
      backendStatus.nativePreviewMutationQueueRejectedCount,
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
