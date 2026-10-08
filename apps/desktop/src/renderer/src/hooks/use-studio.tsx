import { markChatDeliveryIncomplete } from '../../../shared/chat-delivery'
import type { CommentsViewSnapshot } from '../../../shared/backend'
import { closeVisualMicrophoneStreams } from '@/lib/mic-visual-ownership'
import { LazyLiveSourceSelectionController } from '@/lib/live-source-selection-loader'
import { confirmedSourceSelection } from '@/lib/source-selection-confirmed'
import type { LiveSourceSelectionState } from '@/lib/live-source-selection'
import { globalShortcutLayout, nextEligibleLayout } from '../../../shared/global-shortcuts'
import { clipMarkedToast } from '../../../shared/clip-marks'
import { sessionIsLive } from '../../../shared/capture-state'
import { BUILTIN_LAYOUTS } from '@/lib/layout-framing-memory'
import { useScenePresets } from '@/hooks/use-scene-presets'
import {
  hydrateWorkingScene,
  WORKING_SCENE_KEY,
  normalizeSceneVisual,
  visualSources,
  snapshotBackground,
  resolveSavedBackground,
  sameSceneVisual,
  sceneSourceProblems,
  sourceVisibilityFromScene,
  type SceneVisual,
  type SavedScene
} from '@/lib/scene-presets'
import { recalledLayoutFraming, rememberLayoutFraming } from '@/lib/layout-framing-memory'
import {
  commitSceneTransform,
  transformLayoutIntent,
  transformSourceIdentity,
  type TransformCommitResult
} from '@/lib/scene-transform-commit'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction
} from 'react'
import { notifyOnce } from '@/lib/notify-once'
import { streamTargetNotices } from '@/lib/stream-target-notices'
import { toast } from '@/lib/toast'

import { BackendClient, BackendRequestError } from '@/backendClient'
import {
  YOUTUBE_QUOTA_PAUSED_CODE,
  isSettledYouTubeCompletionError,
  isYouTubeQuotaPausedError,
  youtubeQuotaPausedUntil
} from '@/lib/youtube-quota'
import type {
  GlobalShortcutAction,
  GlobalShortcutContext,
  GlobalShortcutsRegistrar
} from '@/lib/global-shortcuts'
import type {
  RemoteIntentContext,
  RemoteSurfacePublisher,
  RemoteSurfaceValues
} from '@/lib/remote-surface'
import { previewSurfaceBoundsChanged } from '../../../shared/native-preview-bounds'
import {
  commentsRefreshRevisionIsCurrent,
  reconcileCommentsSendOperation
} from '../../../shared/comments-send-operation'
import {
  COMMENTS_HIGHLIGHT_TIMING_CONTRACT,
  COMMENTS_SEND_TIMING_CONTRACT
} from '../../../shared/comments-command-timing'
import { nativePreviewStatusProvesSceneRevision } from '../../../shared/native-preview-scene-authority'
import { compositorStatusFromFrameReady } from '../../../shared/compositor-frame-ready'
import { rendererCompositorUpdateWasAccepted } from '../../../shared/native-preview-present-ownership'
import type {
  WindowsLiveAudioSmokeRequest,
  WindowsLiveAudioSmokeState,
  WindowsLiveAudioSmokeTelemetry
} from '../../../shared/windows-live-audio-smoke'
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
  isPreviewFeedableScreenSourceId,
  isPreviewFeedableWindowSourceId,
  patchPreparedStreamTarget,
  patchStreamTargetForEdit,
  streamOutputVideoForTarget,
  persistableCaptureConfig,
  previewDeviceRefreshSignature,
  oauthUnavailableReason,
  preparedXActivationTargets,
  preparedXCompletionTargets,
  preparedYouTubeActivationTargets,
  preparedYouTubeCompletionTargets,
  providerStreamOutputPlanOptions,
  readyStreamTargetLabels,
  reconcileSourceSelection,
  reconcileSourceSelectionForLayoutTransaction,
  resolveProviderStreamOutputPlan,
  rtmpDefaults,
  simulcastArmed,
  simulcastLegLiveRequest,
  smokePreviewCompositorCaptureConfig,
  sourceSelectionChangeEvents,
  layoutPresetMemoryPatch,
  layoutPresetOrientation,
  mergeSourceKind,
  STORAGE_KEYS,
  streamOutputVideosForTargets,
  streamOutputVideoSettings,
  verticalOrientationVideoPatch,
  videoProfileCompatibility,
  videoPresets,
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  type CaptureConfig,
  type SimulcastLegPatch,
  type SettingsState,
  type WsStatus
} from '@/lib/capture'
import {
  burnTargetFromOverlaySwitches,
  seedCaptionsSwitchesFromBurnTarget
} from '@/lib/captions-output'
import {
  DEFAULT_OVERLAY_LAYOUT,
  overlayLayoutsEqual,
  overlayOrientationForCanvas,
  overlaySnapRect
} from '@/lib/overlay-layout'
import { golemOverlayKey, golemOverlayTargetPlan } from '@/lib/golem-overlay-targets'
import type { GolemImage } from '@/lib/golem-overlay'
import {
  autoApplyPreset,
  isShippedDefaultOutput,
  isUntrustedPerformanceCheckResult,
  performanceCheckCeiling,
  performanceCheckTooHeavyToast,
  shouldRunPerformanceCheck
} from '@/lib/performance-check'
import type * as GoLiveOutput from '@/lib/go-live-output'
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
import { isRetryableBackgroundSurfaceSyncError } from '@/lib/surface-sync-retry'
import { accountCallbackRetryDelayMs } from '@/lib/account-callback-retry'
import { buildStartSessionParams } from '@/lib/session-params'
import {
  applyFinalizationEvent,
  finalizationEventNeedsRefresh,
  finalizingBadgeLabel,
  FinalizationSnapshotJournal
} from '@/lib/session-finalization'
import {
  clickEpochMs,
  createRecordLatencyTracker,
  formatRecordLatencyLog,
  type RecordLatencyKind,
  type RecordLatencyOrigin,
  type RecordLatencySample
} from '@/lib/record-latency'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import {
  INITIAL_ACCOUNT_READY_REFRESH_STATE,
  reduceAccountReadyRefresh,
  type AccountReadyRefreshState
} from '@/lib/account-ready-refresh'
import {
  LatestRequestByKey,
  SingleFlightByKey,
  SingleFlightGeneration
} from '@/lib/single-flight-generation'
import { AccountSnapshotCommitCoordinator } from '@/lib/account-snapshot-policy'
import {
  loadScreenTakeoverMuteOwnership,
  persistScreenTakeoverMuteOwnership,
  screenTakeoverMicrophoneTransition
} from '@/lib/screen-takeover-microphone'
import {
  latestLayoutTransactionCommit,
  idlePreviewLayoutProofRequired,
  layoutTransactionBackendSnapshotIsStable,
  layoutTransactionFailureDisposition,
  layoutTransactionFailureReconciliation,
  layoutTransactionProofDisposition,
  layoutTransactionUnprovenSeverity,
  NativePreviewPresentationProofError,
  shouldReloadSceneFromCaptureConfig
} from '@/lib/layout-transaction-policy'
import {
  mergePreviewSurfaceHostStatus,
  nativePreviewFramePollingRequestKey,
  nativePreviewFramePollingResponseCanCommit,
  nativePreviewFramePollingShouldSuppress,
  nativePreviewMainStatusReadGenerationMatches,
  previewSurfaceStatusWithoutMainAuthority,
  previewSurfaceStatusRequiresMainAuthority,
  nativePreviewSurfaceSyncCanCommit,
  nativePreviewSurfaceSyncNeedsCreate
} from '@/lib/native-preview-surface-lifecycle'
import type {
  AccountCallbackEnvelope,
  AiCapabilities,
  AudioLevelsEvent,
  CohostActionCommand,
  CohostAuthorParams,
  CohostEnableCommand,
  CohostFlagParams,
  CohostPromiseParams,
  CohostQuestion,
  CohostSayParams,
  CohostUtteranceParams,
  CohostQuestionParams,
  CohostRecapParams,
  CohostSettings,
  CohostSettingsPatch,
  CohostState,
  CohostWindowState,
  GolemOverlaySnapshot,
  CommentHighlightAnchor,
  CommentHighlightCanvases,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsClearCommand,
  CommentsSendCommand,
  CommentsSendOperation,
  SessionStorageTotals,
  AiQuotaStatus,
  AutomaticSourceFallbackEvent,
  AudioMeterResult,
  AudioProcessingUpdateResult,
  BackendConnection,
  BackendHealth,
  BackendLifecycleEvent,
  BackendLogEvent,
  ChatEmotesSettings,
  CommentsWindowState,
  CompositorFrameReady,
  CompositorStatus,
  DiagnosticStats,
  ClipMarkCommand,
  ClipMarkedEvent,
  Device,
  DeviceList,
  EntitlementsSnapshot,
  NoiseCleanupJob,
  MediaAccessSnapshot,
  FileAssessment,
  EventsLaggedPayload,
  GateStatus,
  GoLivePreflight,
  HealthEvent,
  CameraTransform,
  LayoutPreset,
  LayoutSettings,
  LiveLayoutApplyStatus,
  LiveChatMessage,
  LiveChatProviderState,
  ModerationOperation,
  CaptionsStatus,
  CaptionsUpdate,
  CaptionsWindowState,
  CaptionStyleId,
  CaptureRecoveryStatus,
  LiveChatSnapshot,
  PlatformConnectOptions,
  NotesWindowState,
  PreviewCameraStatus,
  PreviewScreenStatus,
  PreviewSurfaceBounds,
  PreviewSurfacePresentParams,
  PreviewSurfaceStatus,
  PreviewSupervisorState,
  PreviewWindowMode,
  PreviewWindowState,
  EncoderPreferenceState,
  PerformanceCheckProgress,
  PerformanceCheckState,
  WindowsH264EncoderPreference,
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
  RecordingFinalizationEvent,
  RecordingStatus,
  RemoteControlStatus,
  RemoteLanPairing,
  RemoteLanStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SceneCommitStatus,
  SceneConfigParams,
  SceneEditorDraftAck,
  SceneEditorDraftParams,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionDetails,
  SessionHealthEventsPage,
  SessionListPage,
  SessionLogEntry,
  SessionSummary,
  SourceSelection,
  StartSessionParams,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamScreen,
  StreamHealth,
  StreamOutputTopologyProbeParams,
  StreamOutputTopologyProbeResult,
  StoreManualStreamKeyResult,
  StreamingSettings,
  StreamTargetRuntime,
  StreamTargetState,
  StreamTargetSettings,
  StreamTargetStatus,
  StreamTargetsSnapshot,
  SupportBundleExportParams,
  SupportBundleExportResult,
  SystemPermissionPane,
  TwitchCategory,
  KickAppliedMetadata,
  KickCategory,
  PreparedKickBroadcast,
  VideoPreset,
  VideoSettings,
  VideorcAccountRefreshResult,
  VideorcAccountSnapshot,
  WarmMicrophoneStatus,
  XNativeLiveCapability,
  XEndResult,
  XLiveAuthorizationStart,
  XLiveChatStartParams,
  XPlaybackEvent,
  XPublishResult,
  YouTubeBroadcastTransitionResult,
  YouTubeChannel,
  YouTubeQuotaStatus,
  YouTubeStreamStatusResult,
  OverlayLayout,
  OverlayRect,
  SetCommentHighlightParams,
  ViewerSample
} from '@/lib/backend'
import {
  createEmptyLiveChatSnapshot,
  DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  normalizeCommentHighlightAnchor,
  offCohostState
} from '@/lib/backend'
import { backendAudioLevels } from '@/lib/backend-audio-levels'
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
import {
  goLiveEntitlementGate,
  liveCohostGate,
  videoProfileEntitlementGate,
  type EntitlementUiGate
} from '@/lib/entitlement-ui'
import { commentCanHighlight, CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import {
  enqueueAutoShow,
  seedAutoShowQueue,
  takeNextAutoShow,
  type AutoShowQueue
} from '@/lib/activity-auto-highlight'
import {
  applyCohostState,
  cohostErrorToast,
  cohostHighlightMessageId,
  cohostStoppedToast,
  mergeAutoChatRelayPatch,
  orcleLiveSettingsPatch
} from '@/lib/cohost-state'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { upsertNoiseCleanupJob } from '@/lib/noise-cleanup-jobs'
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
import {
  buildNativePreviewCompositorUpdateParams,
  compositorStatusCanDriveProofScene,
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
import { isPremiumUpgradeMessage, premiumRequiredIssueMessage } from '@/lib/premium-upgrade'
import {
  reconcileSessionStartResponse,
  reduceSessionStartFailure,
  SESSION_START_FAILED_TOAST_ID,
  SESSION_START_FAILED_TOAST_TITLE,
  sessionStartFailureMessage,
  sessionStartFailureToastOptions,
  type SessionStartFailure
} from '@/lib/session-start-failure'
import type { SessionRuntimeActivity, SessionRuntimeNotice } from '@/lib/session-runtime-notice'
import { assertYouTubeTransitionConfirmed } from '@/lib/youtube-transition'
import { effectiveSceneBackground, removeSlotAsset } from '@/lib/background-assets'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { findDevice, isActiveRecordingState, mergeStreamHealth } from '@/lib/format'
import {
  confirmedSystemAudioMix,
  systemAudioIssueFromHealthEvent,
  type SystemAudioIssue
} from '@/lib/system-audio-session'
import {
  activeAudioProcessingUpdateParams,
  systemAudioProcessingDelta,
  type LiveSystemAudioValues,
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
    rect?: OverlayRect
  }>
  styleId: CaptionStyleId
  styleRevision: number
  textSize: 's' | 'm' | 'l'
  position: 'top' | 'bottom'
}

type PlatformLifecycleOwner = {
  sessionId: string
  streaming: StreamingSettings
}

type PlatformBroadcastCleanupResult = {
  streaming: StreamingSettings
  complete: boolean
}

type PlatformLifecycleSettlement = {
  sessionId: string
  promise: Promise<PlatformBroadcastCleanupResult>
}

const NATIVE_PREVIEW_SURFACE_PRESENT_REPORT_INTERVAL_MS = 250
const PREPARED_PLATFORM_LIFECYCLE_OWNER_PREFIX = 'prepared-platform:'
const PLATFORM_CLEANUP_X_END_TIMEOUT_MS = 4000
const WORKSPACE_NAVIGATE_EVENT = 'videorc:navigate-workspace'
const AI_CONSENT_STORAGE_KEY = 'videorc.aiConsent'
const RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID = 'recording-stopped-unexpectedly'
const MICROPHONE_INPUT_LOST_TOAST_ID = 'microphone-input-lost'

function isPreparedPlatformLifecycleOwner(sessionId: string): boolean {
  return sessionId.startsWith(PREPARED_PLATFORM_LIFECYCLE_OWNER_PREFIX)
}

function loadSessionRuntimeRecovery() {
  return import('@/lib/session-runtime-recovery')
}

function loadCommandFailurePolicy() {
  return import('@/lib/command-failure-policy')
}

function loadCaptionOverlay() {
  return import('@/lib/caption-overlay')
}

// The Golem rasterizer carries the default pack: lazy, never in the eager shell.
function loadGolemOverlay() {
  return import('@/lib/golem-overlay')
}

// Steady-state telemetry (surface counters, diagnostics stats) commits to
// React state at most once a second. Every commit re-renders the entire
// StudioContext tree, and in dev each of those renders also feeds React's
// per-component performance instrumentation — at the backend's 4Hz event
// cadence that alone kept the renderer permanently busy. State-machine flips
// still commit immediately via the significant-change fast path.
const TELEMETRY_UI_COMMIT_INTERVAL_MS = 1000
const SIGNED_IN_ENTITLEMENT_REFRESH_INTERVAL_MS = 5 * 60_000
// Main and the renderer hear the idle status on separate sockets. A short settle
// keeps the post-capture replay from racing Main into a second deferral.
const ACCOUNT_REFRESH_IDLE_REPLAY_DELAY_MS = 1_000
const LIVE_CHAT_RECOVERY_RETRY_DELAY_MS = 250
/// Scene-motion duration: content motion on-air sits just above the UI's
/// 100-150ms tier; >=500ms reads as a broadcast wipe.
const SCENE_TRANSITION_MS = 320

const SESSION_LIST_PAGE_LIMIT = 50
// Long enough for first paint, preview warm-up and the bootstrap burst.
const PERFORMANCE_CHECK_AUTO_RUN_DELAY_MS = 8_000

function outputChosenByUser(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.outputChosenByUser) !== null
  } catch {
    return true
  }
}

function markOutputChosenByUser(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.outputChosenByUser, '1')
  } catch {
    // Storage unavailable: the check then only ever suggests.
  }
}
export const SESSION_DETAIL_BUFFER_LIMIT = 120
const SESSION_DETAIL_CACHE_LIMIT = 8
const EMPTY_KICK_CATEGORIES: KickCategory[] = []

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

export function resolvedStreamingProfileEntitlementGate(
  captureConfig: Pick<CaptureConfig, 'video' | 'streaming' | 'streamEnabled' | 'layout'>,
  entitlements: EntitlementsSnapshot | null
): ReturnType<typeof videoProfileEntitlementGate> {
  const providerPlan = resolveProviderStreamOutputPlan(
    captureConfig.video,
    captureConfig.streaming,
    {
      // Recording has its own entitlement gate. Resolve the profile actually
      // destined for providers here so a retained YouTube default cannot
      // accidentally gate a provider-safe Twitch/X output.
      recordEnabled: false,
      simulcastArmed: simulcastArmed(captureConfig)
    }
  )
  return videoProfileEntitlementGate({
    entitlements,
    kind: 'streaming',
    video: providerPlan.streamVideo
  })
}

export type StreamOutputTopologyPreflight =
  | { state: 'not-requested' }
  | { state: 'pending'; requestKey: string }
  | {
      state: 'ready'
      requestKey: string
      result: StreamOutputTopologyProbeResult
    }
  | { state: 'failed'; requestKey: string; message: string }

export function buildStreamOutputTopologyProbeParams(
  captureConfig: CaptureConfig,
  streaming: StreamingSettings = captureConfig.streaming,
  suppressCaptionsForSession = false
): StreamOutputTopologyProbeParams {
  const recordingProfile = { ...captureConfig.video }
  // Probe the highest topology the configured outputs would need. This is
  // deliberately optimistic: the backend's production capability selector is
  // the authority that proves or rejects the separate encoded role. Building
  // this request from the unproved shared plan would make a high-rate YouTube
  // record+stream session preflight one topology and start another.
  const providerPlanOptions = providerStreamOutputPlanOptions({ ...captureConfig, streaming }, true)
  const providerPlan = resolveProviderStreamOutputPlan(
    recordingProfile,
    streaming,
    providerPlanOptions
  )
  const streamProfile = providerPlan.streamVideo
  const streamProfiles = providerPlan.targets.map(({ video }) => video)
  const captionOutputReadiness = captionSessionOutputReadiness({
    burnTarget: captureConfig.captions.burnTarget,
    recordEnabled: captureConfig.recordEnabled,
    streamEnabled: true,
    recordingVideo: recordingProfile,
    streamVideos: streamProfiles
  })
  const burnsStream =
    captureConfig.captions.burnTarget === 'stream' || captureConfig.captions.burnTarget === 'both'
  const forceSameProfileSplit =
    captureConfig.recordEnabled &&
    !suppressCaptionsForSession &&
    burnsStream &&
    (captureConfig.captions.enabled || captionOutputReadiness.ready)
  const split =
    captureConfig.recordEnabled &&
    (forceSameProfileSplit || !sameTopologyVideoProfile(recordingProfile, streamProfile))

  return {
    streamProfile: { ...streamProfile },
    ...(captureConfig.recordEnabled ? { recordingProfile } : {}),
    outputRoles: split ? ['recording', 'stream'] : ['shared']
  }
}

export function streamOutputTopologyProbeRequestKey(
  params: StreamOutputTopologyProbeParams
): string {
  return JSON.stringify({
    streamProfile: params.streamProfile,
    recordingProfile: params.recordingProfile,
    outputRoles: params.outputRoles
  })
}

/** The host proved it cannot run a separate encoded stream role. */
export function streamOutputTopologySplitRejected(
  result: Pick<StreamOutputTopologyProbeResult, 'outputRoles' | 'effectiveBridgeOutput'>
): boolean {
  return result.outputRoles.includes('stream') && result.effectiveBridgeOutput === 'raw-yuv420p'
}

// The technical reason (probe stage, HRESULT) stays in Livestream → Technical
// details; a toast only says what the user can do.
export const STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON =
  "This computer can't encode the recording and the livestream separately. Use the same quality for every destination, set captions to burn into both or neither, or turn off recording, then go live."

// The shared-encode re-plan and the Go Live output settling (plan 090) live
// in a chunk loaded with the first rejected split or the first Go Live, so the
// startup bundle does not carry them. A split is only ever marked rejected
// after this chunk loaded, so the topology memo reads it synchronously.
let goLiveOutputChunk: typeof GoLiveOutput | null = null

async function loadGoLiveOutput(): Promise<typeof GoLiveOutput> {
  goLiveOutputChunk ??= await import('@/lib/go-live-output')
  return goLiveOutputChunk
}

export function streamOutputTopologyBlockReason(
  preflight: StreamOutputTopologyPreflight,
  requestKey: string
): string | null {
  if (preflight.state === 'ready' && preflight.requestKey === requestKey) {
    return streamOutputTopologySplitRejected(preflight.result)
      ? STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON
      : null
  }
  if (preflight.state === 'failed' && preflight.requestKey === requestKey) {
    return `Livestream output check failed: ${preflight.message}`
  }
  return 'Checking the exact livestream output path before Go Live.'
}

export function streamOutputTopologyResultMatchesRequest(
  result: StreamOutputTopologyProbeResult,
  params: StreamOutputTopologyProbeParams
): boolean {
  return (
    sameExactVideoSettings(result.streamProfile, params.streamProfile) &&
    sameOptionalVideoSettings(result.recordingProfile, params.recordingProfile) &&
    result.outputRoles.length === params.outputRoles.length &&
    result.outputRoles.every((role, index) => role === params.outputRoles[index])
  )
}

function sameOptionalVideoSettings(
  left: VideoSettings | undefined,
  right: VideoSettings | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameExactVideoSettings(left, right)
}

function sameExactVideoSettings(left: VideoSettings, right: VideoSettings): boolean {
  return left.preset === right.preset && sameTopologyVideoProfile(left, right)
}

export function sameTopologyVideoProfile(left: VideoSettings, right: VideoSettings): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps &&
    left.bitrateKbps === right.bitrateKbps
  )
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
  initialStatus: CompositorStatus,
  options: { linuxCpuProof?: boolean } = {}
): Promise<CompositorStatus> {
  if (compositorStatusCanDriveProofScene(initialStatus, revision, options)) {
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
    if (compositorStatusCanDriveProofScene(latestStatus, revision, options)) {
      return latestStatus
    }
  }

  return initialStatus
}

async function waitForNativePreviewSurfaceSceneRevision(
  sceneRevision: number,
  platform: string
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
    if (nativePreviewStatusProvesSceneRevision(lastStatus, sceneRevision, platform)) {
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
  origin?: 'builtin' | 'saved'
  sources?: SourceSelection
  savedSceneId?: string | null
}

type LayoutTransactionSceneEvidence = {
  layout: LayoutSettings
  sources: Array<{
    kind: Scene['sources'][number]['kind']
    deviceId: string | null
    visible?: boolean
  }>
  video: Pick<VideoSettings, 'width' | 'height' | 'fps'> | null
  background: Scene['background'] | null
}

function selectedBaseSourceEvidence(
  sources: SourceSelection
): LayoutTransactionSceneEvidence['sources'][number] {
  if (sources.windowId) return { kind: 'window', deviceId: sources.windowId }
  if (sources.screenId) return { kind: 'screen', deviceId: sources.screenId }
  if (sources.testPattern) return { kind: 'test-pattern', deviceId: null }
  return { kind: 'screen', deviceId: null }
}

function requestedLayoutTransactionSources(
  layout: LayoutSettings,
  sources: SourceSelection
): LayoutTransactionSceneEvidence['sources'] {
  const base = selectedBaseSourceEvidence(sources)
  const camera = sources.cameraId ? { kind: 'camera' as const, deviceId: sources.cameraId } : null
  if (layout.layoutPreset === 'camera-only' || layout.layoutPreset === 'vertical-camera-only') {
    return camera ? [camera] : [base]
  }
  if (layout.layoutPreset === 'screen-only' || layout.layoutPreset === 'vertical-screen-only') {
    return [base]
  }
  if (
    layout.layoutPreset === 'vertical-screen-camera' &&
    !sources.windowId &&
    !sources.screenId &&
    !sources.testPattern &&
    camera
  ) {
    return [camera]
  }
  return camera ? [base, camera] : [base]
}

function requestedLayoutTransactionScene(
  params: Pick<SceneConfigParams, 'sources' | 'layout' | 'video' | 'background'>
): LayoutTransactionSceneEvidence {
  return {
    layout: params.layout,
    sources: requestedLayoutTransactionSources(params.layout, params.sources).map((source) => ({
      ...source,
      visible:
        source.kind === 'camera'
          ? params.layout.sourceVisibility?.camera !== false
          : params.layout.sourceVisibility?.capture !== false
    })),
    video: params.video
      ? { width: params.video.width, height: params.video.height, fps: params.video.fps }
      : null,
    background: params.background ?? null
  }
}

function backendLayoutTransactionScene(
  snapshot: LayoutTransactionSnapshot
): LayoutTransactionSceneEvidence {
  const output = snapshot.scene.outputs.find((candidate) => candidate.kind === 'recording')
  return {
    layout: snapshot.layout,
    sources: snapshot.scene.sources.map((source) => ({
      kind: source.kind,
      deviceId: source.deviceId ?? null,
      visible: source.visible
    })),
    video: output ? { width: output.width, height: output.height, fps: output.fps } : null,
    background: snapshot.scene.background ?? null
  }
}

async function waitForPreviewLayoutProof(
  activeClient: BackendClient,
  status: LayoutTransactionStatus,
  platform?: string
): Promise<CompositorStatus> {
  const linuxCpuProof = platform === 'linux'
  const initialStatus = status.compositorStatus
  if (compositorStatusCanDriveProofScene(initialStatus, status.sceneRevision, { linuxCpuProof })) {
    return initialStatus
  }
  const renderedStatus = await waitForRenderedCompositorSceneRevision(
    activeClient,
    status.sceneRevision,
    initialStatus,
    { linuxCpuProof }
  )
  if (compositorStatusCanDriveProofScene(renderedStatus, status.sceneRevision, { linuxCpuProof })) {
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
  streamOutputTopologyPreflight: StreamOutputTopologyPreflight
  refreshStreamOutputTopology: () => Promise<void>
  /** The profile a record+stream session will share when no separate stream encoder exists. */
  streamSharedEncodeFallbackVideo: VideoSettings | null
  captureRecoveryStatus: CaptureRecoveryStatus
  captureRecoveryRetryPending: boolean
  retryCaptureRecovery: () => Promise<void>
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
  kickCategories: KickCategory[]
  kickCategorySearchPending: boolean
  xNativeCapability: XNativeLiveCapability | null
  /** Plan 094: the shared YouTube API quota breaker; `pausedUntil` while paused. */
  youtubeQuota: YouTubeQuotaStatus
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
  /** Live Chat Co-host (Premium): persisted settings + approve/dismiss actions.
   * `cohostState` itself lives on the chat context with the chat snapshot. */
  cohostSettings: CohostSettings | null
  /** Overlay layout (plan 164): where the highlight card, captions and the
   * Golem sit per orientation and which outputs carry them. Backend-owned. */
  overlayLayout: OverlayLayout
  setOverlayLayout: (layout: OverlayLayout) => Promise<void>
  /** The Golem on stream (plan 164 Phase C): which state shows and the bubble
   * that is up (`cohost.golem.state`); null until the backend reported. */
  golemOverlay: GolemOverlaySnapshot | null
  cohostGate: EntitlementUiGate
  cohostActionPending: boolean
  patchCohostSettings: (patch: CohostSettingsPatch) => Promise<void>
  /**
   * Golem Live's one switch (plan 119). On without cloud-AI consent only
   * raises `orcleConsentRequested` (the Golem tab's consent dialog) and writes
   * nothing; on with consent writes `{enabled: true, listen: true}` in one
   * `cohost.settings.set`; off writes `{enabled: false}`.
   */
  setOrcleLive: (on: boolean) => Promise<void>
  /** The consent dialog Golem Live asked for is waiting for an answer. */
  orcleConsentRequested: boolean
  /** Accept: grant cloud-AI consent, then the one Golem Live patch. Decline:
   * close the dialog and change nothing. */
  answerOrcleConsent: (accepted: boolean) => Promise<void>
  markCohostQuestionAnswered: (questionId: string, sessionId?: string) => void
  dismissCohostQuestion: (questionId: string, sessionId?: string) => void
  /** Put a voice-resolved question back (`cohost.question.restore`, plan 060 D9). */
  restoreCohostQuestion: (questionId: string, sessionId?: string) => void
  dismissCohostFlag: (messageId: string, sessionId?: string) => void
  showCohostQuestionOnStream: (question: CohostQuestion) => void
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
  startRequestPending: boolean
  stopRequestPending: boolean
  screenImportPending: boolean
  streamMetadataSavePending: boolean
  supportBundleExportPending: boolean
  // remote control (Stream Deck et al) — status is pushed by the backend
  // (remote.control.status events), so consumers never poll.
  remoteControl: {
    status: RemoteControlStatus | null
    enable: () => Promise<RemoteControlStatus | null>
    disable: () => Promise<RemoteControlStatus | null>
    regenerate: () => Promise<RemoteControlStatus | null>
    /** Phone remote (LAN): status is pushed (remote.lan.status), never polled. */
    phone: {
      status: RemoteLanStatus | null
      enable: () => Promise<RemoteLanStatus | null>
      disable: () => Promise<RemoteLanStatus | null>
      beginPairing: (address?: string) => Promise<RemoteLanPairing | null>
      cancelPairing: () => Promise<RemoteLanStatus | null>
      revokeDevice: (id: string) => Promise<RemoteLanStatus | null>
      renameDevice: (id: string, name: string) => Promise<RemoteLanStatus | null>
    }
  }
  // settings + capture config
  settings: SettingsState
  setSettings: Dispatch<SetStateAction<SettingsState>>
  captureConfig: CaptureConfig
  setCaptureConfig: Dispatch<SetStateAction<CaptureConfig>>
  patchLayout: (patch: Partial<LayoutSettings>) => void
  applyLayoutPatch: (patch: Partial<LayoutSettings>) => void
  applyCameraPreset: (patch: Partial<LayoutSettings>) => void
  savedScenes: SavedScene[]
  activeSavedSceneId: string | null
  savedScenePendingId: string | null
  savedSceneModified: boolean
  sceneLibraryError: string | null
  canSaveScene: boolean
  setSceneGesturePending: (pending: boolean) => void
  saveScene: (name: string, updateId?: string) => boolean
  renameSavedScene: (id: string, name: string) => boolean
  deleteSavedScene: (id: string) => boolean
  applySavedScene: (id: string, repaired?: SceneVisual) => Promise<boolean>
  applyBackgroundSlot: (slotId: string | null) => void
  applyWorkingBackgroundStyle: (patch: Partial<Scene['background']>) => void
  /**
   * Change the vertical simulcast leg (scene, screen framing, follow). Saved
   * for the next session and, in a running dual-orientation session, applied
   * to the leg live — the horizontal program is never touched.
   */
  applySimulcastLeg: (patch: SimulcastLegPatch) => void
  // The layout preset a live switch is currently starting sources for, if any
  // (drives the "Switching…" pending state; plan slice D2).
  layoutSwitchPending: LayoutPreset | null
  sourceDeviceSwitchPending: LiveSourceDeviceSwitchPending | null
  sourceSelectionState: LiveSourceSelectionState
  sourceSwitchReason: (kind: LiveSourceDeviceSwitchPending) => string | null
  allowCaptureNone: boolean
  retrySourceStatus: () => Promise<void>
  switchSourceDeviceLive: (
    sourceKind: LiveSourceDeviceSwitchPending,
    sources: SourceSelection
  ) => Promise<void>
  patchVideo: (patch: Partial<VideoSettings>) => void
  applyVideoPreset: (preset: VideoPreset, options?: { kind?: 'recording' | 'streaming' }) => void
  /** What this computer measured; undefined until the backend answered. */
  performanceCheck: PerformanceCheckState | undefined
  /** Windows raw-path encoder choice; null until the backend answers. */
  encoderPreference: EncoderPreferenceState | null
  setEncoderPreference: (preference: WindowsH264EncoderPreference) => Promise<void>
  performanceCheckProgress: PerformanceCheckProgress | null
  runPerformanceCheck: () => Promise<void>
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
  /** `fresh` is for an explicit user Refresh: it never joins older in-flight work. */
  refreshBackend: (options?: { fresh?: boolean }) => Promise<void>
  loadMoreSessions: () => Promise<void>
  loadSessionDetails: (sessionId: string) => Promise<void>
  refreshEntitlements: () => Promise<void>
  refreshPlatformAccounts: () => Promise<void>
  validatePlatformAccounts: () => Promise<PlatformAccountValidation[]>
  connectPlatformAccount: (
    platform: PlatformAccount['platform'],
    options?: PlatformConnectOptions
  ) => Promise<void>
  disconnectPlatformAccount: (platform: PlatformAccount['platform']) => Promise<void>
  refreshYouTubeChannels: (accountId?: string) => Promise<void>
  selectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  searchTwitchCategories: (query: string) => Promise<void>
  searchKickCategories: (query: string) => Promise<void>
  refreshXNativeCapability: (accountId?: string) => Promise<void>
  authorizeXLive: () => Promise<void>
  refreshStreamMetadata: () => Promise<void>
  saveStreamMetadataDraft: () => Promise<void>
  cancelGoLiveConfirmation: () => void
  confirmGoLive: () => Promise<void>
  continueGoLiveWithReadyDestinations: () => Promise<void>
  /** Why the last Record / Go Live was refused; null once the user starts
   * again or dismisses it. Rendered next to the Record control (B0). */
  sessionStartFailure: SessionStartFailure | null
  dismissSessionStartFailure: () => void
  /** A mid-session failure or degraded recording condition. It stays beside
   * the transport controls until dismissed or the next session starts. */
  sessionRuntimeNotice: SessionRuntimeNotice | null
  dismissSessionRuntimeNotice: () => void
  /** Re-run the exact start that failed (same streaming override). */
  retrySessionStart: () => void
  refreshScreens: () => Promise<void>
  importScreenImage: () => Promise<void>
  renameScreen: (screenId: string, name: string) => Promise<void>
  deleteScreen: (screenId: string) => Promise<void>
  reorderScreen: (screenId: string, targetIndex: number) => Promise<void>
  activateScreen: (screenId: string) => Promise<boolean>
  clearActiveScreen: () => Promise<boolean>
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
  ) => Promise<TransformCommitResult>
  /** Live drag drafts for the Scene canvas (plan 058); refused while a session runs. */
  setSceneEditorDraft: (params: SceneEditorDraftParams) => Promise<SceneEditorDraftAck>
  clearSceneEditorDraft: () => Promise<SceneEditorDraftAck>
  commitCameraTransform: (sourceId: string, x: number, y: number) => Promise<void>
  setSceneSourceVisible: (sourceId: string, visible: boolean) => Promise<void>
  moveSceneSource: (sourceId: string, direction: -1 | 1) => Promise<void>
  handleSystemPermission: (pane: SystemPermissionPane) => Promise<void>
  openSystemPermissionSettings: (pane: SystemPermissionPane) => Promise<void>
  revealPermissionTarget: () => Promise<void>
  scheduleHardwareAccelerationRetry: () => Promise<void>
  exportSupportBundle: () => Promise<void>
  registerPreviewSurfaceResize: () => void
  syncNativePreviewSurfaceBounds: (
    bounds: PreviewSurfaceBounds,
    generation?: number
  ) => Promise<void>
  sampleAudioMeter: () => Promise<boolean>
  /**
   * Instant record (P5): keep the selected CoreAudio microphone open while
   * Studio is visible so `session.start` takes it warm. Never load-bearing.
   */
  armWarmMicrophone: () => Promise<WarmMicrophoneStatus | null>
  disarmWarmMicrophone: () => Promise<WarmMicrophoneStatus | null>
  warmMicrophone: WarmMicrophoneStatus | null
  startSession: () => Promise<boolean>
  stopSession: () => Promise<boolean>
  /** Arms the record start/stop latency clock at the moment of a user click. */
  noteRecordClick: (kind: RecordLatencyKind, origin?: RecordLatencyOrigin) => void
  remuxSession: (sessionId: string) => Promise<void>
  ensureSessionPoster: (sessionId: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSessions: (targets: SessionSummary[]) => Promise<void>
  duplicateSession: (sessionId: string) => Promise<void>
  importRecording: () => Promise<void>
  startNoiseCleanup: (sessionId: string) => Promise<NoiseCleanupJob>
  cancelNoiseCleanup: (jobId: string) => Promise<NoiseCleanupJob>
  sessionStorageTotals: SessionStorageTotals | null
  /** Mark the current moment for a clip (plan 068 D6). The `clip.marked`
   * event, not the reply, carries the toast so every source reads the same. */
  markClip: () => Promise<ClipMarkedEvent | null>
  assessRecording: (path: string) => Promise<FileAssessment>
  repairRecording: (path: string) => Promise<GateStatus>
  restoreRecording: (path: string) => Promise<boolean>
  // derived
  outputEnabled: boolean
  streamReady: boolean
  isSessionActive: boolean
  /** Whether the active session mixes system audio, from `recording.status`
   * `mixSources` (plan 069); null until the backend reports it. */
  systemAudioConfirmed: boolean | null
  /** The newest system-audio health issue for the active session. */
  systemAudioIssue: SystemAudioIssue | null
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
  | 'captureRecoveryRetryPending'
  | 'captureRecoveryStatus'
  | 'diagnosticStats'
  | 'healthEvents'
  | 'liveChatSnapshot'
  | 'logs'
  | 'previewCameraStatus'
  | 'previewLiveStatus'
  | 'previewScreenStatus'
  | 'streamHealth'
  | 'retryCaptureRecovery'
  | 'previewSurfaceStatus'
  | 'audioMeter'
  | 'audioMeterLoading'
  | 'meterLevel'
  | 'recording'
>

export type StudioRecordingStateContextValue = {
  /** `streamUrl` tells a record+stream session (Go Live) from a recording:
   * the backend reports both as `recording` (plan 095 S5). */
  recording: Pick<RecordingStatus, 'state' | 'sessionId' | 'streamUrl'>
}

export type StudioRecordingContextValue = Pick<StudioContextValue, 'recording'>

export type StudioPreviewContextValue = Pick<
  StudioContextValue,
  'previewLiveStatus' | 'previewCameraStatus' | 'previewScreenStatus'
>

type RecordLatencyState = {
  start: RecordLatencySample | null
  stop: RecordLatencySample | null
}

interface StudioDiagnosticsContextValue {
  captureRecoveryStatus: CaptureRecoveryStatus
  captureRecoveryRetryPending: boolean
  diagnosticStats: DiagnosticStats
  /** Latest renderer-measured Record/Stop click latency samples. */
  recordLatency: RecordLatencyState
  healthEvents: HealthEvent[]
  logs: BackendLogEvent[]
  streamHealth: StreamHealth | null
  previewSurfaceStatus: PreviewSurfaceStatus
  retryCaptureRecovery: () => Promise<void>
}

interface StudioChatContextValue {
  liveChatSnapshot: LiveChatSnapshot
  /** Latest `cohost.state`; null until the engine reports for the first time. */
  cohostState: CohostState | null
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

const idleCaptureRecoveryStatus = (): CaptureRecoveryStatus => ({
  revision: 0,
  phase: 'idle',
  retryable: false,
  attempts: 0
})

const idleDiagnosticStats = (): DiagnosticStats => ({
  skippedFrames: 0,
  droppedFrames: 0,
  encoderBridgeQueueDepth: 0,
  encoderBridgeOutputQueueHighWaterFrames: 0,
  encoderBridgeOutputQueueOldestFrameAgeMs: undefined,
  encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: undefined,
  encoderBridgeOutputLastProgressAgeMs: undefined,
  encoderBridgeOutputQueueCapacityPressureEvents: 0,
  encoderBridgeOutputPressureRecoveryEvents: 0,
  encoderBridgeOutputQueueDroppedFrames: 0,
  encoderBridgeOutputPreEncodeSkippedFrames: 0,
  encoderBridgeVideoToolboxPendingEncodeFrames: 0,
  encoderBridgeVideoToolboxPendingFifoFrames: 0,
  encoderBridgeEncodedAccessUnitDroppedFrames: 0,
  encoderBridgeDroppedFrames: 0,
  encoderBridgeRecordingDroppedFrames: 0,
  encoderBridgeStreamDroppedFrames: 0,
  encoderBridgeRecordingEncoderSpeed: undefined,
  encoderBridgeStreamEncoderSpeed: undefined,
  encoderBridgeRepeatedFrames: 0,
  encoderBridgeRepeatedFrameBursts: 0,
  encoderBridgeMaxRepeatedFrameRun: 0,
  encoderBridgeSyntheticFrames: 0,
  encoderBridgeSourceAgeP95Ms: undefined,
  encoderBridgeRepeatedFrameAgeP95Ms: undefined,
  encoderBridgeRepeatedFrameAgeMaxMs: undefined,
  encoderBridgeMetalTargetFrames: 0,
  encoderBridgeRawVideoCopiedFrames: 0,
  encoderBridgeRecordingRawVideoCopiedFrames: 0,
  encoderBridgeStreamRawVideoCopiedFrames: 0,
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
  compositorCpuFrames: 0,
  compositorCpuFallbackFrames: 0,
  compositorTicks: 0,
  compositorTickSkipped: 0,
  encoderBridgeFreshFrames: 0,
  encoderBridgeMfSubmittedFrames: 0,
  encoderBridgeMfInputCreditTimeouts: 0,
  encoderBridgeMfInputCreditWaitP95Ms: undefined,
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
    commandLanes: {},
    slowPressureDisconnectCount: 0
  },
  compositorSourceIosurfaceImportFrames: 0,
  compositorSourceCvpixelbufferImportFrames: 0,
  compositorSourceByteUploadFrames: 0,
  compositorSourceCaptureTextureReuses: 0,
  compositorCameraSourceCaptureTextureReuses: 0,
  compositorScreenSourceCaptureTextureReuses: 0,
  compositorSourceTextureCacheFlushes: 0,
  compositorSourceImportFailures: 0,
  compositorCameraSourceIosurfaceImportFrames: 0,
  compositorCameraSourceCvpixelbufferImportFrames: 0,
  compositorCameraSourceByteUploadFrames: 0,
  compositorCameraSourceImportFailures: 0,
  compositorScreenSourceIosurfaceImportFrames: 0,
  compositorScreenSourceCvpixelbufferImportFrames: 0,
  compositorScreenSourceByteUploadFrames: 0,
  compositorScreenSourceImportFailures: 0,
  previewImagePollCounts: {
    cameraPng: 0,
    screenPng: 0,
    productionPng: 0,
    cameraBmp: 0,
    screenBmp: 0,
    liveJpeg: 0,
    liveMjpeg: 0
  },
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
  compositorCameraSourceFreshServes: 0,
  compositorCameraSourceHeldServes: 0,
  compositorCameraSourceServedAgeMaxMs: 0,
  compositorScreenSourceFreshServes: 0,
  compositorScreenSourceHeldServes: 0,
  compositorScreenSourceServedAgeMaxMs: 0,
  previewRepeatedFrames: 0,
  previewSurfaceResizeCount: 0,
  previewDroppedFrames: 0,
  previewCameraDroppedFrames: 0,
  previewCameraCaptureCallbackCount: 0,
  previewCameraDidDropCallbackCount: 0,
  previewCameraFrameStorePublications: 0,
  previewCameraDropReasons: {
    frameWasLate: 0,
    outOfBuffers: 0,
    discontinuity: 0,
    unknown: 0
  },
  previewCameraSurfaceBacking: {
    liveCount: 0,
    peakCount: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0
  },
  previewCameraCapabilityFormats: [],
  previewCameraFrameBytes: 0,
  previewScreenDroppedFrames: 0,
  previewScreenCaptureCallbackCount: 0,
  previewScreenFrameStorePublications: 0,
  previewScreenFrameStatuses: {
    complete: 0,
    idle: 0,
    blank: 0,
    suspended: 0,
    started: 0,
    stopped: 0,
    unknown: 0
  },
  previewScreenSurfaceBacking: {
    liveCount: 0,
    peakCount: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0
  },
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

type LiveSourceDeviceSwitchPending = 'capture' | 'camera' | 'microphone'

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
    (sourceKind === 'screen' && !isPreviewFeedableScreenSourceId(sourceId)) ||
    (sourceKind === 'window' && !isPreviewFeedableWindowSourceId(sourceId))
  ) {
    return {
      ...base,
      state: 'source-missing',
      message: 'Preview requires a display, app window, or desktop-portal source.'
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
  highlightAnchor: DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  autoShowActivity: false,
  protected: false,
  enabled: false,
  message: 'Chat window is disabled by VIDEORC_COMMENTS_WINDOW=0.'
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
  // Only Notes is capture-protected: it is a private teleprompter. Comments
  // and Captions are part of the show and stay visible in recordings (owner
  // call, 2026-08-19), so they are neither excluded from capture nor hidden
  // from the source picker.
  const latestNotesWindow = await window.videorc?.getNotesWindowState?.().catch(() => null)
  return protectedOverlayWindowIdsFromOverlayWindows(latestNotesWindow ?? idleNotesWindowState())
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
  // Remote control (issue #143): the backend pushes remote.control.status on
  // every change (enable/disable/regenerate/deck connect), so nothing polls.
  const [remoteControlStatus, setRemoteControlStatus] = useState<RemoteControlStatus | null>(null)
  const [remoteLanStatus, setRemoteLanStatus] = useState<RemoteLanStatus | null>(null)
  // Keep the remote-control bridges out of the eager Studio bundle. They are
  // loaded only when their lifecycle starts, while refs preserve their
  // imperative change-detection, debounce, and retry behavior.
  const remoteSurfacePublisherRef = useRef<RemoteSurfacePublisher | null>(null)
  const remoteSurfaceValuesRef = useRef<RemoteSurfaceValues | null>(null)
  const remoteIntentTailRef = useRef<Promise<void>>(Promise.resolve())
  const globalShortcutsRegistrarRef = useRef<GlobalShortcutsRegistrar | null>(null)
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
  const entitlementsRevisionRef = useRef(0)
  const commitEntitlementsSnapshot = useCallback((snapshot: EntitlementsSnapshot) => {
    entitlementsRevisionRef.current += 1
    setEntitlements(snapshot)
  }, [])
  const [noiseCleanupJobs, setNoiseCleanupJobs] = useState<NoiseCleanupJob[]>([])
  const announcedNoiseCleanupCompletionsRef = useRef(new Set<string>())
  const entitlementRefreshInFlightRef = useRef<{
    client: BackendClient
    revisionAtStart: number
    promise: Promise<EntitlementsSnapshot>
  } | null>(null)
  const [account, setAccount] = useState<VideorcAccountSnapshot | null>(null)
  const accountSnapshotCoordinatorRef = useRef(new AccountSnapshotCommitCoordinator())
  const accountRefreshInFlightRef = useRef<{
    client: BackendClient
    promise: Promise<VideorcAccountRefreshResult>
  } | null>(null)
  // Main deferred an account refresh because capture was active. The session
  // going idle owes exactly one replay, so "deferred until idle" stays true.
  const accountRefreshDeferredRef = useRef(false)
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
  // Plan 069: the newest system-audio health issue, kept apart from the
  // bounded event list so a long session cannot scroll it away.
  const [systemAudioIssueEvent, setSystemAudioIssueEvent] = useState<{
    sessionId: string
    issue: SystemAudioIssue
  } | null>(null)
  const [systemAudioRetry, retrySystemAudio] = useState(0)
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null)
  const [streamTargets, setStreamTargets] = useState<StreamTargetRuntime[]>([])
  const [diagnosticStats, setDiagnosticStats] = useState<DiagnosticStats>(idleDiagnosticStats)
  const [captureRecoveryStatus, setCaptureRecoveryStatus] =
    useState<CaptureRecoveryStatus>(idleCaptureRecoveryStatus)
  const [captureRecoveryRetryPending, setCaptureRecoveryRetryPending] = useState(false)
  const captureRecoveryConnectionGenerationRef = useRef(0)
  const captureRecoveryServerRevisionRef = useRef(-1)
  const captureRecoveryRetryInFlightRef = useRef<{
    token: symbol
    client: BackendClient
    connectionGeneration: number
  } | null>(null)
  const commitCaptureRecoveryStatus = useCallback(
    (status: CaptureRecoveryStatus, connectionGeneration: number): boolean => {
      if (
        captureRecoveryConnectionGenerationRef.current !== connectionGeneration ||
        status.revision <= captureRecoveryServerRevisionRef.current
      ) {
        return false
      }
      captureRecoveryServerRevisionRef.current = status.revision
      setCaptureRecoveryStatus(status)
      return true
    },
    []
  )
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const sessionsRef = useRef<SessionSummary[]>([])
  sessionsRef.current = sessions
  const remuxSessionRef = useRef<((sessionId: string) => Promise<void>) | null>(null)
  const [sessionsNextCursor, setSessionsNextCursor] = useState<string | null>(null)
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false)
  const announcedFinalizationsRef = useRef(new Set<string>())
  const finalizationJournalRef = useRef(new FinalizationSnapshotJournal())
  const activeFinalizationNoticesRef = useRef(new Set<string>())
  useEffect(() => {
    // Restore progress after relaunch; settle a notice whose terminal event
    // was missed while disconnected using the authoritative database row.
    for (const session of sessions) {
      const id = `finalization-${session.id}`
      if (session.finalizationState === 'finalizing') {
        activeFinalizationNoticesRef.current.add(session.id)
        toast.loading(finalizingBadgeLabel(session), {
          id,
          duration: Infinity,
          description:
            'Your recording is safe. Long recordings can take several minutes to save as MP4.'
        })
      } else if (activeFinalizationNoticesRef.current.delete(session.id)) {
        if (
          session.finalizationState === 'finalized' &&
          !announcedFinalizationsRef.current.has(session.id)
        ) {
          announcedFinalizationsRef.current.add(session.id)
          toast.success('MP4 ready', {
            id,
            duration: 15000,
            action: {
              label: 'Show in folder',
              onClick: () => {
                void window.videorc?.revealSession(session.id)
              }
            }
          })
        } else if (session.finalizationState === 'failed') {
          toast.error('MP4 export failed', {
            duration: Infinity,
            id,
            description: session.finalizationError ?? 'The original MKV recording was kept.',
            action: {
              label: 'Retry export',
              onClick: () => {
                void remuxSessionRef.current?.(session.id)
              }
            }
          })
        }
      }
    }
  }, [sessions])
  const sessionListGenerationRef = useRef(0)
  const sessionListRefreshRequestRef = useRef(new LatestRequestByKey<'first-page'>())
  const sessionListMoreSingleFlightRef = useRef(new SingleFlightByKey<'next-page', BackendClient>())
  const [sessionDetails, setSessionDetails] = useState<Record<string, SessionDetails>>({})
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState<Set<string>>(() => new Set())
  const [sessionDetailError, setSessionDetailError] = useState<{
    sessionId: string
    message: string
  } | null>(null)
  const sessionDetailRecencyRef = useRef<string[]>([])
  const sessionDetailRequestRef = useRef(new LatestRequestByKey<string>())
  const sessionDetailSingleFlightRef = useRef(new SingleFlightByKey<string, BackendClient>())
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
  const [kickCategoryResults, setKickCategoryResults] = useState<KickCategory[]>([])
  const [kickCategorySearchPending, setKickCategorySearchPending] = useState(false)
  const [xNativeCapability, setXNativeCapability] = useState<XNativeLiveCapability | null>(null)
  const [xNativeCapabilityLoading, setXNativeCapabilityLoading] = useState(false)
  // Plan 094: one shared paused state for every YouTube Data API caller. The
  // backend owns it; the event clears it ({} = not paused) on its own.
  const [youtubeQuota, setYoutubeQuota] = useState<YouTubeQuotaStatus>({})
  const youtubeQuotaRef = useRef<YouTubeQuotaStatus>({})
  youtubeQuotaRef.current = youtubeQuota
  const refreshEntitlementsForClient = useCallback(
    async (activeClient: BackendClient): Promise<EntitlementsSnapshot> => {
      let refresh = entitlementRefreshInFlightRef.current
      if (!refresh || refresh.client !== activeClient) {
        refresh = {
          client: activeClient,
          revisionAtStart: entitlementsRevisionRef.current,
          promise: activeClient.requestTyped('entitlements.refresh', undefined)
        }
        entitlementRefreshInFlightRef.current = refresh
      }
      try {
        const snapshot = await refresh.promise
        // A newer pushed snapshot wins over this query's cached response. In
        // particular, sign-out Basic must not be overwritten by stale Premium.
        if (
          clientRef.current === activeClient &&
          entitlementsRevisionRef.current === refresh.revisionAtStart
        ) {
          commitEntitlementsSnapshot(snapshot)
        }
        return snapshot
      } finally {
        if (entitlementRefreshInFlightRef.current === refresh) {
          entitlementRefreshInFlightRef.current = null
        }
      }
    },
    [commitEntitlementsSnapshot]
  )
  // Read-only live chat store: persisted by the backend when available, live-updated by
  // liveChat.* websocket events, and mirrored to the detached Comments window cache.
  const [liveChatSnapshot, setLiveChatSnapshot] = useState<LiveChatSnapshot>(() =>
    applyLiveChatSnapshot(createEmptyLiveChatSnapshot(new Date().toISOString()))
  )
  const liveChatSnapshotRef = useRef(liveChatSnapshot)
  const liveChatStateRevisionRef = useRef(0)
  const liveChatReplacementRevisionRef = useRef(0)
  liveChatSnapshotRef.current = liveChatSnapshot
  const updateLiveChatSnapshot = useCallback((next: SetStateAction<LiveChatSnapshot>): void => {
    liveChatStateRevisionRef.current += 1
    const resolved = typeof next === 'function' ? next(liveChatSnapshotRef.current) : next
    liveChatSnapshotRef.current = resolved
    setLiveChatSnapshot(resolved)
  }, [])
  const replaceLiveChatSnapshotState = useCallback(
    (next: LiveChatSnapshot): void => {
      liveChatReplacementRevisionRef.current += 1
      updateLiveChatSnapshot(next)
    },
    [updateLiveChatSnapshot]
  )
  const publishedChatBoundaryRef = useRef<string | null>(null)
  const publishLiveCommentsSnapshot = useCallback(
    (view: CommentsViewSnapshot): Promise<void> | undefined => {
      if (view.mode.kind === 'live') {
        const delivery = view.snapshot.delivery
        const current = liveChatSnapshotRef.current.delivery
        // Never authorize an obsolete async bootstrap/recovery publisher.
        if (
          !delivery ||
          delivery.ownerId !== current?.ownerId ||
          delivery.generation !== current.generation
        )
          return
        const key = `${delivery.ownerId}:${delivery.generation}`
        if (publishedChatBoundaryRef.current !== key) {
          publishedChatBoundaryRef.current = key
          void window.videorc?.pushCommentsDelta?.({
            kind: 'adopt',
            deliveryBoundary: { ownerId: delivery.ownerId, generation: delivery.generation },
            updatedAt: view.snapshot.updatedAt
          })
        }
      }
      return window.videorc?.pushCommentsSnapshot?.(view)
    },
    []
  )
  const clearLiveChatForTerminalSession = useCallback(
    (sessionId?: string): void => {
      if (!sessionId || liveChatSnapshotRef.current.sessionId !== sessionId) {
        return
      }
      const cleared = applyLiveChatSnapshot(
        createEmptyLiveChatSnapshot(new Date().toISOString()),
        liveChatSnapshotRef.current,
        true
      )
      latestLiveChatSendOperationRef.current = undefined
      liveChatSendOperationRevisionRef.current += 1
      replaceLiveChatSnapshotState(cleared)
      void window.videorc?.pushCommentsDelta?.({
        kind: 'clear',
        sessionId,
        updatedAt: cleared.updatedAt,
        deliveryBoundary: {
          ownerId: cleared.delivery!.ownerId,
          generation: cleared.delivery!.generation
        }
      })
      void publishLiveCommentsSnapshot({
        mode: { kind: 'live' },
        snapshot: cleared
      })
    },
    [publishLiveCommentsSnapshot, replaceLiveChatSnapshotState]
  )
  const latestLiveChatSendOperationRef = useRef<CommentsSendOperation | undefined>(undefined)
  const liveChatSendOperationRevisionRef = useRef(0)
  // Chat removals (plan 140, S6): the lazy relay while a backend is connected.
  // It follows the live chat session.
  const chatModerationRef = useRef<
    import('@/lib/chat-moderation-relay').ChatModerationRelay | null
  >(null)
  useEffect(() => {
    chatModerationRef.current?.session(liveChatSnapshot.sessionId)
  }, [liveChatSnapshot.sessionId])
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
        void publishLiveCommentsSnapshot({
          mode: { kind: 'live' },
          snapshot,
          latestSendOperation: next?.sessionId === snapshot.sessionId ? next : undefined
        })
      }
    },
    [publishLiveCommentsSnapshot]
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
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(() => {
    const config = loadCaptureConfig()
    const working = hydrateWorkingScene(loadJson(WORKING_SCENE_KEY, null))
    return working
      ? {
          ...config,
          sources: { ...config.sources, ...working.visual.sources },
          layout: working.visual.layout,
          video: coerceVideoToOrientation(
            config.video,
            layoutPresetOrientation(working.visual.layout.layoutPreset)
          )
        }
      : config
  })
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
      toast.warning(`${CHAT_PLATFORM_LABELS[warning.platform]} chat is not connected`, {
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
        throw new Error('Backend is not connected. Try again in a moment.')
      }
      setCaptionLines([])
      let status: CaptionsStatus
      try {
        status = await runCaptionsCommand(() =>
          client.request<CaptionsStatus>('captions.start', {
            language: language === 'auto' ? undefined : language
          })
        )
      } catch (error) {
        const failurePolicy = await loadCommandFailurePolicy()
        if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') {
          throw error
        }
        const authoritative = await client
          .request<CaptionsStatus>('captions.status.get', undefined, { timeoutMs: 2_000 })
          .catch(() => null)
        if (!authoritative) throw error
        commitCaptionsStatus(authoritative)
        if (failurePolicy.captionsStartFailureCanReconcile(error, authoritative)) {
          return
        }
        throw error
      }
      commitCaptionsStatus(status)
      if (!captionsStatusIsActive(status) && status.state !== 'ready') {
        throw new Error(status.message ?? `Live captions did not start (status: ${status.state}).`)
      }
    },
    [client, commitCaptionsStatus, runCaptionsCommand]
  )
  const stopCaptions = useCallback(async () => {
    if (!client) return
    let status: CaptionsStatus
    try {
      status = await runCaptionsCommand(() => client.request<CaptionsStatus>('captions.stop'))
    } catch (error) {
      const failurePolicy = await loadCommandFailurePolicy()
      if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') {
        throw error
      }
      const authoritative = await client
        .request<CaptionsStatus>('captions.status.get', undefined, { timeoutMs: 2_000 })
        .catch(() => null)
      if (!authoritative) throw error
      commitCaptionsStatus(authoritative)
      if (failurePolicy.captionsStopFailureCanReconcile(error, authoritative)) {
        return
      }
      throw error
    }
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
  // Overlay layout (plan 164): backend-owned, loaded on connect and pushed
  // to every window on change. A ref feeds the highlight and caption pushes
  // so a placement applies to the very next raster without re-creating the
  // relay listeners.
  const [overlayLayout, setOverlayLayoutState] = useState<OverlayLayout>(DEFAULT_OVERLAY_LAYOUT)
  const overlayLayoutRef = useRef<OverlayLayout>(DEFAULT_OVERLAY_LAYOUT)
  overlayLayoutRef.current = overlayLayout
  const commitOverlayLayout = useCallback((next: OverlayLayout) => {
    setOverlayLayoutState((current) => (overlayLayoutsEqual(current, next) ? current : next))
  }, [])
  // The layout itself: loaded on connect, pushed on change (`overlays.layout`).
  useEffect(() => {
    if (!client || wsStatus !== 'connected') return
    let cancelled = false
    void client
      .requestTyped('overlays.layout.get')
      .then((layout) => {
        if (!cancelled) commitOverlayLayout(layout)
      })
      // An older backend has no such method (or answers off-contract); the
      // shipped defaults stand.
      .catch(() => undefined)
    const off = client.on('overlays.layout', commitOverlayLayout)
    return () => {
      cancelled = true
      off()
    }
  }, [client, commitOverlayLayout, wsStatus])
  const setOverlayLayout = useCallback(
    async (layout: OverlayLayout): Promise<void> => {
      if (!client) throw new Error('Backend socket is not connected.')
      const saved = await client.requestTyped('overlays.layout.set', layout)
      commitOverlayLayout(saved)
    },
    [client, commitOverlayLayout]
  )
  // Captions keep `burnTarget` on the wire, derived from the captions item's
  // two switches (plan 164, D14). The first layout after the update is
  // seeded once from a saved target that was on, so nobody loses it.
  const captionsSwitchesKey = `${overlayLayout.captions.showOnStream}:${overlayLayout.captions.showInRecording}`
  const captionsSeedRef = useRef<string | null>(null)
  const captionsBurnTargetRef = useRef(captureConfig.captions.burnTarget)
  captionsBurnTargetRef.current = captureConfig.captions.burnTarget
  useEffect(() => {
    if (!client || wsStatus !== 'connected') return
    const savedTarget = captionsBurnTargetRef.current
    const seeded =
      captionsSeedRef.current === null
        ? seedCaptionsSwitchesFromBurnTarget(overlayLayout.captions, savedTarget)
        : null
    captionsSeedRef.current = captionsSwitchesKey
    if (seeded) {
      void setOverlayLayout({ ...overlayLayoutRef.current, captions: seeded }).catch(() => {})
      return
    }
    const derived = burnTargetFromOverlaySwitches(overlayLayout.captions)
    if (derived === savedTarget) return
    setCaptureConfig((current) =>
      current.captions.burnTarget === derived
        ? current
        : { ...current, captions: { ...current.captions, burnTarget: derived } }
    )
    // The layout's switches are the one home; the key keeps this effect on
    // switch changes (and a saved target arriving) only, never on a rect drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, wsStatus, captionsSwitchesKey, captureConfig.captions.burnTarget, setOverlayLayout])
  // The streamer's corner pick lives in main (it must survive the Chat window
  // being closed). A ref, not state, feeds the highlight RPC so a pick applies
  // to the very next highlight without re-creating the relay listeners.
  const commentHighlightAnchorRef = useRef<CommentHighlightAnchor>(DEFAULT_COMMENT_HIGHLIGHT_ANCHOR)
  const moveLiveCommentHighlightRef = useRef<((anchor: CommentHighlightAnchor) => void) | null>(
    null
  )
  // The Stream Manager corner menu is a SNAP (plan 164, D11): it writes the
  // highlight rect on both orientations; the layout change then re-sends a
  // live card. A ref, so the relay listeners below never re-subscribe.
  const snapHighlightToAnchorRef = useRef<(anchor: CommentHighlightAnchor) => void>(() => {})
  snapHighlightToAnchorRef.current = (anchor) => {
    const current = overlayLayoutRef.current
    void setOverlayLayout({
      ...current,
      highlight: {
        ...current.highlight,
        horizontal: overlaySnapRect('highlight', 'horizontal', anchor),
        vertical: overlaySnapRect('highlight', 'vertical', anchor)
      }
    }).catch(() => {})
  }
  useEffect(() => {
    let cancelled = false
    const noteHighlightAnchor = (state: CommentsWindowState, move: boolean): void => {
      const anchor = normalizeCommentHighlightAnchor(state.highlightAnchor)
      if (anchor === commentHighlightAnchorRef.current) return
      commentHighlightAnchorRef.current = anchor
      // A pick writes the layout; the placement effect moves a live card.
      if (move) snapHighlightToAnchorRef.current(anchor)
    }
    const reconcile = async (): Promise<void> => {
      const fresh = await window.videorc?.getCommentsWindowState?.()
      if (!fresh || cancelled) {
        return
      }
      noteHighlightAnchor(fresh, false)
      setCommentsWindow((current) =>
        JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
      )
    }
    void reconcile()
    const offState = window.videorc?.onCommentsWindowState?.((state) => {
      noteHighlightAnchor(state, true)
      setCommentsWindow(state)
    })
    const offClear = window.videorc?.onCommentsClearRequest?.((command: CommentsClearCommand) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        if (liveChatSnapshotRef.current.sessionId !== command.sessionId) {
          throw new Error('That chat view is no longer the active livestream.')
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
            error: error instanceof Error ? error.message : 'Could not clear the chat view.'
          })
        })
    })
    const offMarkerCreated = client?.on('session.marker.created', (marker) => {
      if (marker.source !== 'voice') return
      setLastVoiceMarker(marker)
      void import('../lib/marker-toast').then((module) => module.showMarkerToast(client, marker))
    })
    const offMarkerChanged = client?.on('session.marker.changed', (changed) => {
      setLastVoiceMarker((previous) =>
        previous?.id === changed.markerId && changed.revision >= previous.revision
          ? changed.deleted
            ? null
            : (changed.marker ?? previous)
          : previous
      )
    })
    const offMarkerRefused = client?.on('session.marker.voice.refused', ({ message }) =>
      toast.error(message)
    )
    const offMarker = window.videorc?.onMarkerRequest?.((command) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        switch (command.action) {
          case 'create':
            return client.requestTyped('session.marker.create', command.params)
          case 'get':
            return client.requestTyped('session.marker.get', command.params)
          case 'delete':
            return client.requestTyped('session.marker.delete', command.params)
        }
      })()
        .then((value) =>
          window.videorc?.pushMarkerResult?.({ requestId: command.requestId, ok: true, value })
        )
        .catch((error) =>
          window.videorc?.pushMarkerResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Could not save marker.'
          })
        )
    })
    // Mark clip from the Stream Manager (plan 068 D6): the same relay shape
    // as clear, resolved with where the mark landed.
    const offClipMark = window.videorc?.onClipMarkRequest?.((command: ClipMarkCommand) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        if (!isActiveRecordingState(recordingRef.current.state)) {
          throw new Error('No session is running, so there is nothing to mark.')
        }
        return client.request<ClipMarkedEvent>('clip.mark')
      })()
        .then(async (event) => {
          await window.videorc?.pushClipMarkResult?.({
            requestId: command.requestId,
            ok: true,
            value: event
          })
        })
        .catch(async (error) => {
          await window.videorc?.pushClipMarkResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Could not mark the clip.'
          })
        })
    })
    return () => {
      cancelled = true
      offState?.()
      offClear?.()
      offClipMark?.()
      offMarker?.()
      offMarkerCreated?.()
      offMarkerRefused?.()
      offMarkerChanged?.()
    }
  }, [client])
  const [lastVoiceMarker, setLastVoiceMarker] = useState<
    import('@/lib/backend').SessionMarker | null
  >(null)
  const [markerVoice, setMarkerVoice] = useState<{
    sessionId: string
    listening: import('@/lib/backend').CohostListening
  } | null>(null)
  useEffect(() => client?.on('session.marker.voice.status', setMarkerVoice), [client])
  useEffect(() => {
    const available = Boolean(
      client &&
      recording.sessionId &&
      (recording.state === 'recording' || recording.state === 'streaming')
    )
    void window.videorc?.pushMarkerContext?.({
      sessionId: recording.sessionId,
      available,
      reason: available ? undefined : 'Start a recording or livestream to make a marker.',
      lastMarker: lastVoiceMarker ?? undefined,
      voice:
        markerVoice && markerVoice.sessionId === recording.sessionId
          ? markerVoice.listening
          : undefined
    })
    return () => {
      void window.videorc?.pushMarkerContext?.(null)
    }
  }, [client, recording.sessionId, recording.state, markerVoice, lastVoiceMarker])
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
      intent: number,
      // `alwaysSet` re-sends the message that is already live instead of reading
      // the repeat as "un-pin": a corner move re-places the card, and a phone
      // remote 'show' restarts its lifetime.
      options?: { alwaysSet?: boolean }
    ): Promise<CommentHighlightState | null> => {
      if (!client) throw new Error('Backend socket is not connected.')
      const sessionId = expectedSessionId ?? liveChatSnapshot.sessionId
      if (!sessionId || message.sessionId !== sessionId) {
        throw new Error('That message does not belong to the active livestream.')
      }
      setCommentHighlightApplyingId(message.id)
      try {
        if (
          !options?.alwaysSet &&
          commentHighlightState.phase === 'live' &&
          commentHighlightState.messageId === message.id
        ) {
          let cleared: CommentHighlightState
          try {
            cleared = await client.request<CommentHighlightState>('comments.highlight.clear')
          } catch (error) {
            const failurePolicy = await loadCommandFailurePolicy()
            if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') throw error
            const authoritative = await client
              .request<CommentHighlightState>('comments.highlight.status', undefined, {
                timeoutMs: COMMENTS_HIGHLIGHT_TIMING_CONTRACT.reconciliationMs
              })
              .catch(() => null)
            if (!failurePolicy.commentHighlightClearFailureCanReconcile(error, authoritative)) {
              throw error
            }
            cleared = authoritative!
          }
          return commentHighlightIntentRef.current === intent ? cleared : null
        }
        const streamVideo = streamOutputVideoSettings(
          captureConfig.video,
          captureConfig.streamEnabled ? captureConfig.streaming : undefined
        )
        const [avatarUrl, canvases] = await Promise.all([
          message.authorAvatarUrl
            ? window.videorc?.cacheChatAvatar?.(message.authorAvatarUrl).catch(() => null)
            : null,
          client.request<CommentHighlightCanvases>('comments.highlight.canvases').catch(() => null)
        ])
        if (commentHighlightIntentRef.current !== intent) return null
        const { renderCommentHighlightCards } = await loadCaptionOverlay()
        if (commentHighlightIntentRef.current !== intent) return null
        // The streamer's placement (plan 164): the card wraps to the rect's
        // width on each canvas and the backend blits it inside that rect.
        const highlightLayout = overlayLayoutRef.current.highlight
        const rect =
          highlightLayout[overlayOrientationForCanvas(streamVideo.width, streamVideo.height)]
        const verticalRect = highlightLayout.vertical
        const cards = await renderCommentHighlightCards(
          message,
          avatarUrl ?? null,
          { ...streamVideo, rect },
          canvases?.vertical ? { ...canvases.vertical, rect: verticalRect } : undefined
        )
        if (!cards) throw new Error('Could not render this message for the stream.')
        if (commentHighlightIntentRef.current !== intent) return null
        let state: CommentHighlightState
        try {
          state = await client.request<CommentHighlightState>('comments.highlight.set', {
            sessionId,
            messageId: message.id,
            anchor: commentHighlightAnchorRef.current,
            rect,
            ...(cards.verticalPngBase64 ? { verticalRect } : {}),
            ...cards
          } satisfies SetCommentHighlightParams)
        } catch (error) {
          const failurePolicy = await loadCommandFailurePolicy()
          if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') throw error
          const authoritative = await client
            .request<CommentHighlightState>('comments.highlight.status', undefined, {
              timeoutMs: COMMENTS_HIGHLIGHT_TIMING_CONTRACT.reconciliationMs
            })
            .catch(() => null)
          if (
            !failurePolicy.commentHighlightSetFailureCanReconcile(
              error,
              sessionId,
              message.id,
              authoritative
            )
          ) {
            throw error
          }
          state = authoritative!
        }
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

  // Placement changed while a card is live (plan 164): the same re-send.
  const highlightPlacementKey = JSON.stringify([
    overlayLayout.highlight.horizontal,
    overlayLayout.highlight.vertical
  ])
  const highlightPlacementSeenRef = useRef(highlightPlacementKey)
  useEffect(() => {
    if (highlightPlacementSeenRef.current === highlightPlacementKey) return
    highlightPlacementSeenRef.current = highlightPlacementKey
    moveLiveCommentHighlightRef.current?.(commentHighlightAnchorRef.current)
  }, [highlightPlacementKey])

  // Corner changed while a card is live: re-send the same message so it moves.
  // The backend TTL restarts, which suits an adjustment the streamer is watching.
  moveLiveCommentHighlightRef.current = () => {
    if (commentHighlightState.phase !== 'live') return
    const message = liveChatSnapshotRef.current.messages.find(
      (candidate) =>
        candidate.id === commentHighlightState.messageId &&
        candidate.sessionId === commentHighlightState.sessionId
    )
    if (!message) return
    const intent = ++commentHighlightIntentRef.current
    void applyCommentHighlight(message, commentHighlightState.sessionId, intent, {
      alwaysSet: true
    })
      .then((state) => {
        if (state && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(state)
        }
      })
      .catch(async () => {
        // The card stays where the backend says it is; never guess.
        const authoritative = await client
          ?.request<CommentHighlightState>('comments.highlight.status')
          .catch(() => null)
        if (authoritative && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(authoritative)
        }
      })
  }

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
          : Promise.reject(new Error('The selected live message is no longer available.'))
      )
        .then(async (state) => {
          if (!state) {
            throw new Error('A newer highlight replaced this request.')
          }
          if (commentHighlightIntentRef.current === intent) {
            publishCommentHighlightState(state)
          }
          await window.videorc?.pushCommentHighlightResult?.({
            requestId: command.requestId,
            ok: true,
            value: state
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
          text: command.text,
          // Co-host reply: the engine marks the question answered on a
          // terminal sent/partial phase, so the pane clears itself.
          ...(command.inReplyToQuestionId
            ? { inReplyToQuestionId: command.inReplyToQuestionId }
            : {}),
          ...(Array.isArray(command.destinationIds)
            ? { destinationIds: command.destinationIds }
            : {})
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
          const failurePolicy = await loadCommandFailurePolicy()
          if (failurePolicy.failureCode(error) === 'request-outcome-unknown') {
            const reconciled = await client
              ?.request<CommentsSendOperation[]>(
                'liveChat.sendOperations.list',
                { sessionId: command.sessionId },
                { timeoutMs: COMMENTS_SEND_TIMING_CONTRACT.reconciliationMs }
              )
              .then((operations) =>
                operations.find((operation) => operation.id === command.operationId)
              )
              .catch(() => undefined)
            if (failurePolicy.commentsSendFailureCanReconcile(error, command, reconciled)) {
              await window.videorc?.pushChatSendResult?.({
                requestId: command.requestId,
                ok: true,
                value: reconciled
              })
              return
            }
          }
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
    await publishLiveCommentsSnapshot({
      mode: { kind: 'live' },
      snapshot: currentSnapshot,
      latestSendOperation
    })
  }, [
    applyLiveChatSendOperationsQuery,
    client,
    publishLiveCommentsSnapshot,
    replaceLiveChatSnapshotState
  ])
  const openCommentsWindow = useCallback(async () => {
    await refreshLiveChatSnapshotForComments().catch(() => {})
    await window.videorc?.setCommentsViewMode?.({ kind: 'live' })
    await window.videorc?.openCommentsWindow?.()
    await refreshLiveChatSnapshotForComments().catch(() => {})
  }, [refreshLiveChatSnapshotForComments])
  const openCommentsWindowRef = useRef(openCommentsWindow)
  openCommentsWindowRef.current = openCommentsWindow
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
        await publishLiveCommentsSnapshot({
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
    [client, publishLiveCommentsSnapshot]
  )
  const [streamMetadataDraft, setStreamMetadataDraft] = useState<StreamMetadataDraft | null>(null)
  const [streamMetadataValidation, setStreamMetadataValidation] =
    useState<StreamMetadataValidation | null>(null)
  const [streamOutputTopologyPreflight, setStreamOutputTopologyPreflight] =
    useState<StreamOutputTopologyPreflight>({ state: 'not-requested' })
  const streamOutputTopologyPreflightRef = useRef<StreamOutputTopologyPreflight>({
    state: 'not-requested'
  })
  const streamOutputTopologyProbeGenerationRef = useRef(0)
  const streamOutputTopologyProbeInFlightRef = useRef<{
    client: BackendClient
    requestKey: string
    controller: AbortController
    promise: Promise<StreamOutputTopologyProbeResult>
  } | null>(null)
  const commitStreamOutputTopologyPreflight = useCallback((next: StreamOutputTopologyPreflight) => {
    streamOutputTopologyPreflightRef.current = next
    setStreamOutputTopologyPreflight(next)
  }, [])
  // Declared up here because the Go Live output plan reads it (plan 090 D2);
  // the check itself is driven further down.
  const [performanceCheck, setPerformanceCheck] = useState<PerformanceCheckState>()
  // Split requests this backend has rejected. The ref is the synchronous
  // authority for an in-progress Go Live; the state re-plans the idle check.
  const [rejectedStreamOutputSplitKeys, setRejectedStreamOutputSplitKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const rejectedStreamOutputSplitKeysRef = useRef<ReadonlySet<string>>(
    rejectedStreamOutputSplitKeys
  )
  const streamOutputTopologySessionResultsRef = useRef(
    new Map<string, StreamOutputTopologyProbeResult>()
  )
  const commitRejectedStreamOutputSplitKeys = useCallback((next: ReadonlySet<string>) => {
    rejectedStreamOutputSplitKeysRef.current = next
    setRejectedStreamOutputSplitKeys(next)
  }, [])
  const [goLivePreflight, setGoLivePreflight] = useState<GoLivePreflight | null>(null)
  const [goLiveConfirmationOpen, setGoLiveConfirmationOpen] = useState(false)
  const [goLiveConfirmationPending, setGoLiveConfirmationPending] = useState(false)
  const [goLivePartialSetup, setGoLivePartialSetup] = useState<GoLivePartialSetup | null>(null)
  const [suppressCaptionsForSession, setSuppressCaptionsForSession] = useState(false)
  const captionOutputReadiness = useMemo(() => {
    const streamVideos = streamOutputVideosForTargets(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined,
      providerStreamOutputPlanOptions(captureConfig)
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
  const transformSceneRef = useRef<Scene | null>(null)
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
  // Cloud-AI consent is a durable preference, not a per-launch answer: a
  // consent that silently reset to off on every launch left cloud AI doing
  // nothing with no visible reason (2026-07-11 report).
  const [aiConsent, setAiConsentState] = useState(
    () => localStorage.getItem(AI_CONSENT_STORAGE_KEY) === '1'
  )
  const setAiConsent = useCallback((consent: boolean) => {
    setAiConsentState(consent)
    localStorage.setItem(AI_CONSENT_STORAGE_KEY, consent ? '1' : '0')
  }, [])
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
  const lastRecordingStateRef = useRef<RecordingStatus['state'] | null>(null)
  const lastSessionActivityRef = useRef<SessionRuntimeActivity>('recording')
  // The idle status tick that ends a session does not reliably carry the
  // finished session's id; remember the last one seen so the saved-toast
  // actions can target the right recording.
  const lastRecordingSessionIdRef = useRef<string | null>(null)
  // Quality-gate toast dedupe: the gate can re-emit an updated not-100 verdict for
  // the same session (fast assessment, then post-repair); one toast is enough.
  const qualityToastSessionsRef = useRef<Set<string>>(new Set())
  const recordingFailureSessionRef = useRef<string | null>(null)
  const microphoneInputLostSessionRef = useRef<string | null>(null)
  const sessionRuntimeEpochRef = useRef(0)
  const captureConfigRef = useRef(captureConfig)
  const [liveAudioProcessingApplied, setLiveAudioProcessingApplied] = useState<
    (LiveAudioProcessingValues & { sessionId: string }) | null
  >(null)
  const liveAudioProcessingAppliedRef = useRef<
    (LiveAudioProcessingValues & { sessionId: string }) | null
  >(null)
  const liveMicrophoneSettlementWaitersRef = useRef<
    Set<{
      sessionId: string
      microphoneMuted: boolean
      resolve: (applied: boolean) => void
    }>
  >(new Set())
  const commitLiveAudioProcessingApplied = useCallback(
    (next: LiveAudioProcessingValues & { sessionId: string }): void => {
      liveAudioProcessingAppliedRef.current = next
      setLiveAudioProcessingApplied((current) =>
        current?.sessionId === next.sessionId &&
        current.microphoneGainDb === next.microphoneGainDb &&
        current.microphoneMuted === next.microphoneMuted
          ? current
          : next
      )
    },
    []
  )
  const settleLiveMicrophoneWaiters = useCallback(
    (sessionId: string, microphoneMuted: boolean, terminal: boolean): void => {
      for (const waiter of liveMicrophoneSettlementWaitersRef.current) {
        if (waiter.sessionId !== sessionId) continue
        if (waiter.microphoneMuted === microphoneMuted) {
          liveMicrophoneSettlementWaitersRef.current.delete(waiter)
          waiter.resolve(true)
        } else if (terminal) {
          liveMicrophoneSettlementWaitersRef.current.delete(waiter)
          waiter.resolve(false)
        }
      }
    },
    []
  )
  const failLiveMicrophoneWaiters = useCallback((sessionId?: string): void => {
    for (const waiter of liveMicrophoneSettlementWaitersRef.current) {
      if (sessionId && waiter.sessionId !== sessionId) continue
      liveMicrophoneSettlementWaitersRef.current.delete(waiter)
      waiter.resolve(false)
    }
  }, [])
  const liveAudioProcessingSyncRef = useRef<{
    token: object
    sessionId: string
    lastApplied: LiveAudioProcessingValues
    /** System audio as last sent to this session (start request or update);
     * null until known, and again after an update the session did not apply,
     * so it is sent again. Confirmation comes from `recording.status`. */
    systemAudioSent: LiveSystemAudioValues | null
    authoritative: boolean
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
  const layoutShortcutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (layoutShortcutTimerRef.current) clearTimeout(layoutShortcutTimerRef.current)
    },
    []
  )
  const latestRequestedLayoutRef = useRef<LayoutPreset | null>(null)
  const layoutIntentIdRef = useRef(Date.now())
  const layoutIntentAwaitingProofRef = useRef<number | null>(null)
  const latestLayoutTransactionCommitRef = useRef<LayoutTransactionSnapshot | null>(null)
  const skipNextConfigSceneReloadRef = useRef(false)
  useEffect(() => {
    captureConfigRef.current = captureConfig
  }, [captureConfig])
  // Backend screen state is authoritative across commands, events, bootstrap,
  // and reconnects. Persist the ownership bit separately so a renderer reload
  // can still restore only the microphone mute introduced by the takeover.
  const takeoverMuteOwnershipRef = useRef(loadScreenTakeoverMuteOwnership())
  const commitActiveScreen = useCallback((screen: StreamScreen | null): void => {
    const transition = screenTakeoverMicrophoneTransition({
      active: screen !== null,
      microphoneMuted: captureConfigRef.current.audio.microphoneMuted,
      ownership: takeoverMuteOwnershipRef.current
    })
    takeoverMuteOwnershipRef.current = transition.ownership
    setActiveScreen(screen)
    const muteChanges =
      captureConfigRef.current.audio.microphoneMuted !== transition.microphoneMuted
    if (muteChanges) {
      captureConfigRef.current = {
        ...captureConfigRef.current,
        audio: {
          ...captureConfigRef.current.audio,
          microphoneMuted: transition.microphoneMuted
        }
      }
    }
    // Persist the mute in the same step as its ownership record; left to the
    // captureConfig effect, a quit between the two writes strands a muted
    // microphone with no takeover to release it. The record is what lets a
    // later launch release the mute, so a stored takeover mute never goes
    // without it: taking a mute writes the record first, releasing one writes
    // the restored config first.
    if (transition.ownership) {
      persistScreenTakeoverMuteOwnership(transition.ownership)
    }
    if (muteChanges) {
      try {
        localStorage.setItem(
          STORAGE_KEYS.captureConfig,
          JSON.stringify(persistableCaptureConfig(captureConfigRef.current))
        )
      } catch {
        // Storage is best effort; the effect below writes the same value.
      }
    }
    if (!transition.ownership) {
      persistScreenTakeoverMuteOwnership(null)
    }
    if (muteChanges) {
      setCaptureConfig((current) => ({
        ...current,
        audio: { ...current.audio, microphoneMuted: transition.microphoneMuted }
      }))
    }
  }, [])
  useEffect(
    () => () => {
      liveAudioProcessingSyncRef.current?.queue.stop()
      failLiveMicrophoneWaiters()
    },
    [failLiveMicrophoneWaiters]
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
      __videorcSmokeSelectFirstScreen?: (
        sourceId?: string
      ) => { id: string; kind: 'screen' | 'window' } | null
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
    // An explicit source ID pins a display, e.g. one held static by a fixture.
    smokeWindow.__videorcSmokeSelectFirstScreen = (sourceId) => {
      const source = deviceList.devices.find(
        (device) =>
          (device.kind === 'screen' || device.kind === 'window') &&
          device.status === 'available' &&
          device.id.includes('screencapturekit') &&
          (!sourceId || device.id === sourceId)
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
  const nativePreviewMainStatusReadSerialRef = useRef(0)
  const diagnosticStatsPendingRef = useRef<DiagnosticStats | null>(null)
  const diagnosticStatsCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const diagnosticStatsLastCommitAtRef = useRef(0)
  const nativePreviewRendererTimingFieldsCacheRef = useRef<{
    fields: NativePreviewRendererTimingFields
    computedAtMs: number
  } | null>(null)
  const previewCameraStatusRef = useRef<PreviewCameraStatus>(idlePreviewCameraStatus())
  const previewScreenStatusRef = useRef<PreviewScreenStatus>(idlePreviewScreenStatus())
  const sourceStatusUnknownRef = useRef(true)
  const [sourceStatusKnown, setSourceStatusKnown] = useState(false)
  const recordingRef = useRef<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  const sessionStartLifecycleActiveRef = useRef(false)
  const sessionStartLifecycleSessionIdRef = useRef<string | null>(null)
  const sessionStartLifecycleInvalidatedSessionIdsRef = useRef<Set<string>>(new Set())
  const sessionStartInFlightRef = useRef<{
    captureConfig: CaptureConfig
    sceneWithBackground: Scene | null
    sceneEditMode: boolean
    settings: SettingsState
    streamingOverride?: StreamingSettings
    suppressCaptionsForSession: boolean
    promise: Promise<boolean>
  } | null>(null)
  const confirmGoLiveInFlightPromiseRef = useRef<Promise<void> | null>(null)
  const stopSessionInFlightPromiseRef = useRef<Promise<boolean> | null>(null)
  const sessionStartAuthoritativeStatusesRef = useRef<Map<string, RecordingStatus>>(new Map())
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
  const streamTargetStatesRef = useRef<Map<string, StreamTargetState>>(new Map())
  const platformLifecycleRun = useRef(0)
  const platformLifecycleOwnerRef = useRef<PlatformLifecycleOwner | null>(null)
  const preparedPlatformLifecycleOwnersRef = useRef<PlatformLifecycleOwner[]>([])
  const preparedPlatformLifecycleOwnerSequenceRef = useRef(0)
  const platformLifecycleMutationRef = useRef<{
    sessionId: string
    promise: Promise<StreamingSettings>
  } | null>(null)
  const platformLifecycleSettlementRef = useRef<PlatformLifecycleSettlement | null>(null)
  const claimPlatformLifecycleOwner = useCallback((sessionId?: string) => {
    if (!sessionId || platformLifecycleOwnerRef.current?.sessionId !== sessionId) {
      return null
    }
    const owner = platformLifecycleOwnerRef.current
    platformLifecycleOwnerRef.current = null
    return owner
  }, [])
  const settleClaimedPlatformLifecycleOwnerRef = useRef<
    | ((
        owner: PlatformLifecycleOwner,
        task?: (owner: PlatformLifecycleOwner) => Promise<PlatformBroadcastCleanupResult>
      ) => Promise<PlatformBroadcastCleanupResult>)
    | null
  >(null)
  const youtubeCompletionInFlightByBroadcastRef = useRef<
    Map<string, { client: BackendClient; promise: Promise<YouTubeBroadcastTransitionResult> }>
  >(new Map())
  const youtubeCompletedBroadcastResultsRef = useRef<Map<string, YouTubeBroadcastTransitionResult>>(
    new Map()
  )
  const xEndInFlightByBroadcastRef = useRef<
    Map<string, { client: BackendClient; promise: Promise<XEndResult> }>
  >(new Map())
  const xEndedBroadcastResultsRef = useRef<Map<string, XEndResult>>(new Map())
  // One-shot playback toasts per broadcast+status (probe events may repeat).
  const xPlaybackToastsRef = useRef(new Set<string>())
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0)
  const nativePreviewSurfaceEnabled = Boolean(runtimeInfo?.nativePreviewSurfaceProofEnabled)

  // Surface a per-target stream drop from any tab (the Streaming tab has the full
  // banner + badges). Each destination toasts on the transitions that are news:
  // stopped, reconnecting, not received by its platform, back (plan 161). The
  // previous states are cleared whenever streaming returns to an empty snapshot.
  useEffect(() => {
    if (streamTargets.length === 0) {
      streamTargetStatesRef.current = new Map()
      return
    }
    for (const notice of streamTargetNotices(streamTargetStatesRef.current, streamTargets)) {
      notifyOnce(notice.key, notice.kind, notice.title, { description: notice.description })
    }
    streamTargetStatesRef.current = new Map(
      streamTargets.map((target) => [target.targetId, target.state])
    )
  }, [streamTargets])

  const { registry: backgroundRegistry, setRegistry: setBackgroundRegistry } = useBackgroundAssets()
  const sceneLibrary = useScenePresets()
  const { save: saveSceneEntry, remove: removeSceneEntry } = sceneLibrary
  const [activeSavedSceneId, setActiveSavedSceneId] = useState<string | null>(
    () => hydrateWorkingScene(loadJson(WORKING_SCENE_KEY, null))?.sceneId ?? null
  )
  const activeSavedSceneIdRef = useRef(activeSavedSceneId)
  const workingOriginRef = useRef<'builtin' | 'saved'>(
    hydrateWorkingScene(loadJson(WORKING_SCENE_KEY, null))?.origin ??
      (activeSavedSceneId ? 'saved' : 'builtin')
  )
  const [visualTransactionPending, setVisualTransactionPending] = useState(false)
  const [sceneGesturePending, setSceneGesturePending] = useState(false)
  const [sceneTransformPending, setSceneTransformPending] = useState(false)
  const [sceneVisibilityPending, setSceneVisibilityPending] = useState(false)
  const sceneVisibilityRequestIdRef = useRef(0)
  const [savedScenePendingId, setSavedScenePendingId] = useState<string | null>(null)
  const [workingBackground, setWorkingBackground] = useState(() => {
    const working = hydrateWorkingScene(loadJson(WORKING_SCENE_KEY, null))
    return working
      ? resolveSavedBackground(working.visual.background)
      : effectiveSceneBackground(backgroundRegistry)
  })
  const workingBackgroundRef = useRef(workingBackground)
  const confirmedVisualRef = useRef<SceneVisual>(
    normalizeSceneVisual({
      layout: captureConfig.layout,
      sources: visualSources(captureConfig.sources),
      background: snapshotBackground(workingBackground)
    })
  )
  const backgroundRegistryRef = useRef(backgroundRegistry)
  backgroundRegistryRef.current = backgroundRegistry
  const activeSceneBackground = workingBackground ?? undefined
  const desiredLibraryBackground = useMemo(
    () => effectiveSceneBackground(backgroundRegistry),
    [backgroundRegistry]
  )
  const libraryBackgroundFingerprintRef = useRef(
    JSON.stringify(snapshotBackground(desiredLibraryBackground))
  )
  const sceneWithBackground = useMemo<Scene | null>(
    () => (scene ? { ...scene, background: activeSceneBackground } : null),
    [scene, activeSceneBackground]
  )
  const persistWorkingVisual = useCallback(
    (
      layout: LayoutSettings,
      sources: SourceSelection,
      background: Scene['background'] | null,
      savedSceneId: string | null
    ) => {
      const visual = normalizeSceneVisual({
        layout,
        sources: visualSources(sources),
        background: snapshotBackground(background)
      })
      confirmedVisualRef.current = visual
      try {
        localStorage.setItem(
          WORKING_SCENE_KEY,
          JSON.stringify({
            version: 1,
            origin: workingOriginRef.current,
            sceneId: savedSceneId,
            visual
          })
        )
      } catch {
        toast.error('The working scene could not be saved for the next launch.', {
          id: 'working-scene-storage'
        })
      }
    },
    []
  )

  const [layoutSwitchPending, setLayoutSwitchPending] = useState<LayoutPreset | null>(null)
  const [sourceSelectionState, setSourceSelectionState] = useState<LiveSourceSelectionState>({
    snapshot: null,
    pending: null,
    checking: false,
    error: null
  })
  const [sourceSelectionController] = useState(
    () =>
      new LazyLiveSourceSelectionController({
        get: async (sessionId) => {
          if (!clientRef.current) throw new Error('Backend socket is not connected.')
          return clientRef.current.requestTyped('session.sources.get', { sessionId })
        },
        switch: async (request) => {
          if (request.kind === 'microphone') closeVisualMicrophoneStreams()
          if (!clientRef.current) throw new Error('Backend socket is not connected.')
          return clientRef.current.requestTyped('session.source.switch', request)
        },
        changed: setSourceSelectionState,
        failed: (requestId, message) => toast.error(message, { id: `source-switch-${requestId}` }),
        requestId: () => crypto.randomUUID(),
        confirmed: (snapshot) => {
          const current = captureConfigRef.current
          const sources = confirmedSourceSelection(
            current.sources,
            snapshot,
            deviceListRef.current.devices
          )
          if (JSON.stringify(sources) === JSON.stringify(current.sources)) return
          captureConfigRef.current = { ...current, sources }
          setCaptureConfig((latest) => ({
            ...latest,
            sources: confirmedSourceSelection(
              latest.sources,
              snapshot,
              deviceListRef.current.devices
            )
          }))
          if (
            JSON.stringify(visualSources(sources)) !==
            JSON.stringify(visualSources(current.sources))
          ) {
            persistWorkingVisual(
              current.layout,
              sources,
              resolveSavedBackground(confirmedVisualRef.current.background),
              activeSavedSceneIdRef.current
            )
          }
        }
      })
  )
  useEffect(() => () => sourceSelectionController.dispose(), [sourceSelectionController])
  const allowCaptureNone =
    !['recording', 'streaming'].includes(recording.state) ||
    sourceSelectionState.snapshot?.capabilities.some(
      (capability) => capability.kind === 'capture' && capability.allowsNone === true
    ) === true
  const sourceDeviceSwitchPending = sourceSelectionState.pending
  const sourceSwitchReason = useCallback(
    (kind: LiveSourceDeviceSwitchPending): string | null => {
      // Only a live socket can be mid-bootstrap. With no backend there is no
      // session to fence, and the next recording.status reconciles the pick.
      if (sourceStatusUnknownRef.current && (wsStatus === 'connecting' || wsStatus === 'connected'))
        return 'Checking the current session…'
      // An idle microphone is not part of the scene, so a scene change cannot race it.
      if (
        layoutSwitchPending &&
        (kind !== 'microphone' || isActiveRecordingState(recordingRef.current.state))
      )
        return 'The scene is changing.'
      if (sessionStartInFlightRef.current || sessionStartLifecycleActiveRef.current)
        return 'The session is starting.'
      return sourceSelectionController.reason(kind)
    },
    [sourceSelectionController, layoutSwitchPending, wsStatus]
  )
  const retrySourceStatus = useCallback(
    () => sourceSelectionController.retryStatus(),
    [sourceSelectionController]
  )

  const reportError = useCallback((error: unknown) => {
    const message = ipcErrorMessage(error)
    // Always keep the diagnostic record, even for suppressed transients.
    setLastError(message)
    if (isPremiumUpgradeMessage(message)) {
      void loadSessionRuntimeRecovery().then((runtime) => runtime.showPremiumUpgrade(message))
      return
    }
    const status = wsStatusRef.current
    void loadSessionRuntimeRecovery().then((runtime) => runtime.showBackendError(message, status))
  }, [])

  const retryCaptureRecovery = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current
    const connectionGeneration = captureRecoveryConnectionGenerationRef.current
    const inFlight = captureRecoveryRetryInFlightRef.current
    if (
      !activeClient ||
      (inFlight?.client === activeClient && inFlight.connectionGeneration === connectionGeneration)
    ) {
      return
    }
    const token = Symbol('capture-recovery-retry')
    captureRecoveryRetryInFlightRef.current = {
      token,
      client: activeClient,
      connectionGeneration
    }
    setCaptureRecoveryRetryPending(true)
    try {
      const status = await activeClient.requestTyped('capture.recovery.retry', undefined)
      if (
        clientRef.current === activeClient &&
        captureRecoveryConnectionGenerationRef.current === connectionGeneration
      ) {
        commitCaptureRecoveryStatus(status, connectionGeneration)
      }
    } catch (error) {
      if (
        clientRef.current === activeClient &&
        captureRecoveryConnectionGenerationRef.current === connectionGeneration
      ) {
        reportError(error)
      }
    } finally {
      if (captureRecoveryRetryInFlightRef.current?.token === token) {
        captureRecoveryRetryInFlightRef.current = null
        setCaptureRecoveryRetryPending(false)
      }
    }
  }, [commitCaptureRecoveryStatus, reportError])

  // --- Session-start failures are unmissable (B0) ----------------------------
  // A refused Record / Go Live used to be one default 4s toast while the user
  // was watching the stream. Now: one keyed persistent toast with Retry, plus a
  // failure state the Session panel renders beside the Record control until the
  // user starts again or dismisses it. The retry closure is held in a ref so the
  // toast action (created once) always re-runs the LATEST failed start.
  const [sessionStartFailure, setSessionStartFailure] = useState<SessionStartFailure | null>(null)
  const [sessionRuntimeNotice, setSessionRuntimeNotice] = useState<SessionRuntimeNotice | null>(
    null
  )
  const sessionRuntimeNoticeRef = useRef<SessionRuntimeNotice | null>(null)
  const replaceSessionRuntimeNotice = useCallback((notice: SessionRuntimeNotice | null) => {
    sessionRuntimeNoticeRef.current = notice
    setSessionRuntimeNotice(notice)
  }, [])
  const sessionStartRetryRef = useRef<(() => void) | null>(null)
  const dismissSessionStartFailure = useCallback(() => {
    sessionStartRetryRef.current = null
    setSessionStartFailure((current) => reduceSessionStartFailure(current, { type: 'dismissed' }))
    toast.dismiss(SESSION_START_FAILED_TOAST_ID)
  }, [])
  const dismissSessionRuntimeNotice = useCallback(() => {
    sessionRuntimeEpochRef.current += 1
    replaceSessionRuntimeNotice(null)
    toast.dismiss(RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID)
    toast.dismiss(MICROPHONE_INPUT_LOST_TOAST_ID)
  }, [replaceSessionRuntimeNotice])
  const clearSessionRuntimeState = useCallback(() => {
    recordingFailureSessionRef.current = null
    microphoneInputLostSessionRef.current = null
    dismissSessionRuntimeNotice()
  }, [dismissSessionRuntimeNotice])
  const retrySessionStart = useCallback(() => {
    const retry = sessionStartRetryRef.current
    if (!retry) {
      return
    }
    retry()
  }, [])
  const noteSessionStartAttempt = useCallback(() => {
    setSessionStartFailure((current) =>
      reduceSessionStartFailure(current, { type: 'start-attempted' })
    )
    clearSessionRuntimeState()
    toast.dismiss(SESSION_START_FAILED_TOAST_ID)
  }, [clearSessionRuntimeState])
  const reportSessionStartFailure = useCallback(
    (error: unknown, retry: () => void) => {
      const message = sessionStartFailureMessage(error)
      setLastError(message)
      sessionStartRetryRef.current = retry
      setSessionStartFailure((current) =>
        reduceSessionStartFailure(current, { type: 'failed', message, at: Date.now() })
      )
      if (isPremiumUpgradeMessage(message)) {
        // Premium gate: the upgrade link is the only useful action, and the
        // Session-panel line still carries the reason persistently.
        void loadSessionRuntimeRecovery().then((runtime) => runtime.showPremiumUpgrade(message))
        return
      }
      toast.error(
        SESSION_START_FAILED_TOAST_TITLE,
        sessionStartFailureToastOptions(message, retrySessionStart, () => {
          // The user closed the toast: the Session-panel line goes with it.
          sessionStartRetryRef.current = null
          setSessionStartFailure((current) =>
            reduceSessionStartFailure(current, { type: 'dismissed' })
          )
        })
      )
    },
    [retrySessionStart]
  )

  const publishRecordingFailure = useCallback(
    async (status: RecordingStatus, activityOverride?: SessionRuntimeActivity): Promise<void> => {
      const activity = activityOverride ?? lastSessionActivityRef.current
      const continuationEpoch = sessionRuntimeEpochRef.current
      const expectedSessionId = status.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
      const runtime = await loadSessionRuntimeRecovery()
      if (
        !runtime.sessionRuntimeContinuationIsCurrent(
          continuationEpoch,
          sessionRuntimeEpochRef.current,
          expectedSessionId,
          recordingRef.current.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
        )
      ) {
        return
      }
      const presentation = runtime.recordingFailurePresentation({
        status,
        activity,
        ...(lastRecordingSessionIdRef.current
          ? { fallbackSessionId: lastRecordingSessionIdRef.current }
          : {}),
        currentDedupeKey: recordingFailureSessionRef.current
      })
      if (!presentation) return
      recordingFailureSessionRef.current = presentation.dedupeKey
      replaceSessionRuntimeNotice(presentation.notice)
      runtime.showRecordingFailure(presentation)
    },
    [replaceSessionRuntimeNotice]
  )

  const publishMicrophoneInputLost = useCallback(
    async (event: HealthEvent): Promise<void> => {
      const continuationEpoch = sessionRuntimeEpochRef.current
      const expectedSessionId = event.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
      const runtime = await loadSessionRuntimeRecovery()
      if (
        !runtime.sessionRuntimeContinuationIsCurrent(
          continuationEpoch,
          sessionRuntimeEpochRef.current,
          expectedSessionId,
          recordingRef.current.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
        )
      ) {
        return
      }
      const presentation = runtime.microphoneLossPresentation({
        event,
        recording: recordingRef.current,
        ...(lastRecordingSessionIdRef.current
          ? { lastSessionId: lastRecordingSessionIdRef.current }
          : {}),
        lastActivity: lastSessionActivityRef.current,
        currentNotice: sessionRuntimeNoticeRef.current,
        currentDedupeKey: microphoneInputLostSessionRef.current
      })
      if (!presentation) return
      microphoneInputLostSessionRef.current = presentation.dedupeKey
      lastSessionActivityRef.current = presentation.activity
      // A terminal capture failure is the authoritative, higher-priority
      // outcome for this session. A correlated microphone event may arrive
      // later from durable health history, but it must not replace or cover
      // the failure with a lower-priority persistent warning.
      if (sessionRuntimeNoticeRef.current?.kind === 'recording-failed') return
      replaceSessionRuntimeNotice(presentation.notice)
      runtime.showMicrophoneLoss(presentation)
    },
    [replaceSessionRuntimeNotice]
  )

  // --- Live Chat Co-host (Premium cloud AI) --------------------------------
  // The BACKEND owns the engine: the tick scheduler, the open-question set,
  // flags and every failure reason. The renderer renders `cohost.state`, fires
  // approve/dismiss RPCs, and supplies the two facts only it holds — the
  // renderer-local cloud-AI consent and the entitlement snapshot. It NEVER
  // talks to the web.
  const [cohostState, setCohostState] = useState<CohostState | null>(null)
  const [cohostSettings, setCohostSettings] = useState<CohostSettings | null>(null)
  const [golemOverlay, setGolemOverlay] = useState<GolemOverlaySnapshot | null>(null)
  const cohostSettingsRef = useRef(cohostSettings)
  cohostSettingsRef.current = cohostSettings
  const [cohostActionPending, setCohostActionPending] = useState(false)
  const cohostStateRef = useRef<CohostState | null>(null)
  const streamTitleRef = useRef<string | null>(null)
  streamTitleRef.current =
    captureConfig.streaming.targets.find((target) => target.enabled && target.scheduledEventId)
      ?.scheduledEventTitle ??
    (streamMetadataDraft?.title?.trim() || null)

  const commitCohostState = useCallback((next: CohostState): void => {
    const previous = cohostStateRef.current
    const merged = applyCohostState(previous, next)
    if (merged === previous) return
    cohostStateRef.current = merged
    setCohostState(merged)
    // Toast discipline: the pane and the destination chip already show every
    // co-host state. Only a NEW failure (reason + server error code) is news;
    // backoff retries of the same failure stay silent.
    const errorToast = cohostErrorToast(previous, merged)
    if (errorToast) {
      toast.error(errorToast.message, { id: 'cohost-error' })
    }
    // Plan 140 S1: the backend ends a running session when Premium lapses
    // mid-stream (or the account signs out). The chip only turns "off", so
    // one plain, untinted line says why; a streamer's own Stop stays silent.
    const stoppedToast = cohostStoppedToast(previous, merged)
    if (stoppedToast) {
      toast(stoppedToast, { id: 'cohost-stopped' })
    }
  }, [])

  const cohostGate = useMemo(() => liveCohostGate(entitlements), [entitlements])
  const cohostEnabled = cohostSettings?.enabled === true
  const cohostListen = cohostSettings?.listen === true
  const cohostLiveSessionId = liveChatSnapshot.sessionId ?? null

  // Persisted co-host preferences live in the backend profile, not in local
  // settings — the engine reads the same row when it builds a tick.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') return
    let cancelled = false
    void Promise.all([
      client.request<CohostSettings>('cohost.settings.get').catch(() => null),
      client.request<CohostState>('cohost.status').catch(() => null),
      // An older backend has no Golem overlay (plan 164); the avatar stays off.
      client.requestTyped('cohost.golem.status').catch(() => null)
    ]).then(([nextSettings, nextState, nextGolem]) => {
      if (cancelled) return
      if (nextSettings) setCohostSettings(nextSettings)
      if (nextState) commitCohostState(nextState)
      if (nextGolem) setGolemOverlay(nextGolem)
    })
    return () => {
      cancelled = true
    }
  }, [client, commitCohostState, wsStatus])

  useEffect(() => {
    if (
      !client ||
      wsStatus !== 'connected' ||
      !recording.sessionId ||
      !['recording', 'streaming'].includes(recording.state)
    )
      return
    let cancelled = false
    const sessionId = recording.sessionId
    void client
      .requestTyped('session.marker.voice.configure', {
        sessionId,
        consent: aiConsent
      })
      .then((listening) => {
        if (!cancelled) setMarkerVoice({ sessionId, listening })
      })
      .catch((error) => {
        if (!cancelled)
          setMarkerVoice({
            sessionId,
            listening: {
              state: 'blocked',
              reasonCode: 'configuration_failed',
              message: error instanceof Error ? error.message : 'Could not enable voice markers.'
            }
          })
      })
    return () => {
      cancelled = true
    }
  }, [
    client,
    wsStatus,
    recording.sessionId,
    recording.state,
    aiConsent,
    cohostEnabled,
    cohostListen,
    cohostGate.allowed,
    cohostState?.status
  ])
  // The Golem on stream (plan 164 S-C2). The backend owns the state and the
  // bubble; this renderer rasterizes the avatar (plus bubble) once per output
  // canvas and pushes each PNG into the `golem_overlay` slot, like the caption
  // bar. A push happens on every change of persona, images, state, bubble,
  // placement or canvas, whether or not a session runs: the slot is
  // app-global and the avatar must be on the first frame (D19). Latest wins:
  // a stale raster never lands after a newer state.
  const golemPersona = cohostSettings?.persona ?? null
  const golemTargetsKey = useMemo(
    () =>
      JSON.stringify(
        golemOverlayTargetPlan({
          streamEnabled: captureConfig.streamEnabled,
          recordingVideo: captureConfig.video,
          streamVideo: auxiliaryStreamOutputVideoSettings(
            captureConfig.video,
            captureConfig.streamEnabled ? captureConfig.streaming : undefined
          ),
          verticalLeg: simulcastLegLiveRequest(captureConfig)?.video,
          layout: overlayLayout.golem
        })
      ),
    [captureConfig, overlayLayout.golem]
  )
  const golemPushEpochRef = useRef(0)
  const golemPushedKeyRef = useRef<string | null>(null)
  const golemImageCacheRef = useRef(new Map<string, Promise<GolemImage>>())
  useEffect(() => {
    if (wsStatus !== 'connected') golemPushedKeyRef.current = null
  }, [wsStatus])
  useEffect(() => {
    if (!client || wsStatus !== 'connected' || !golemPersona) return
    const targets = JSON.parse(golemTargetsKey) as ReturnType<typeof golemOverlayTargetPlan>
    if (targets.length === 0) return
    const state = golemOverlay?.state ?? 'idle'
    const bubble = golemOverlay?.bubble?.text ?? null
    const imagesKey = JSON.stringify(golemPersona.images)
    const key = golemOverlayKey({
      personaId: golemPersona.id,
      imagesKey,
      state,
      bubble,
      style: golemPersona.bubbleStyle,
      targets
    })
    if (key === golemPushedKeyRef.current) return
    const epoch = ++golemPushEpochRef.current
    const cache = golemImageCacheRef.current
    void (async () => {
      const golem = await loadGolemOverlay()
      const cacheKey = `${golemPersona.id}:${imagesKey}:${state}`
      let image = cache.get(cacheKey)
      if (!image) {
        image = golem.loadGolemStateImage(golemPersona, state)
        cache.set(cacheKey, image)
        image.catch(() => cache.delete(cacheKey))
      }
      const decoded = await image
      for (const target of targets) {
        if (epoch !== golemPushEpochRef.current) return
        const pngBase64 = await golem.renderGolemOverlayPng({
          image: decoded,
          bubble,
          style: golemPersona.bubbleStyle,
          canvas: { width: target.canvasWidth, height: target.canvasHeight },
          rect: target.rect
        })
        if (!pngBase64 || epoch !== golemPushEpochRef.current) return
        await client.requestTyped('golem.overlay.set', {
          target: target.target,
          pngBase64,
          rect: target.rect
        })
      }
      if (epoch === golemPushEpochRef.current) golemPushedKeyRef.current = key
    })().catch((error: unknown) => {
      console.warn(`Golem overlay: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [client, wsStatus, golemPersona, golemOverlay, golemTargetsKey])

  // Start with the live-chat session, and re-assert on a consent flip.
  // The backend applies changed consent in place and returns its confirmed
  // state; unchanged consent is idempotent. It stops itself when chat ends.
  useEffect(() => {
    if (!client || wsStatus !== 'connected') return
    if (!cohostLiveSessionId || !cohostEnabled || !cohostGate.allowed) return
    let cancelled = false
    void client
      .request<CohostState>('cohost.start', {
        sessionId: cohostLiveSessionId,
        consentToProcessChat: aiConsent,
        streamTitle: streamTitleRef.current
      })
      .then((state) => {
        if (!cancelled) commitCohostState(state)
      })
      .catch(() => {
        // A failed start is not silent: the engine reports the reason through
        // `cohost.state`, which the pane and the chip already render.
      })
    return () => {
      cancelled = true
    }
  }, [
    aiConsent,
    client,
    cohostEnabled,
    cohostGate.allowed,
    cohostLiveSessionId,
    commitCohostState,
    wsStatus
  ])

  const patchCohostSettings = useCallback(
    async (patch: CohostSettingsPatch): Promise<void> => {
      if (!client) throw new Error('Backend socket is not connected.')
      const next = await client.request<CohostSettings>('cohost.settings.set', patch)
      setCohostSettings(next)
    },
    [client]
  )

  // Golem Live's one switch (plan 119 S2). Consent comes first: on without it
  // only asks (the Golem tab's consent dialog), and nothing is written until
  // the streamer accepts. On is one save: chat and listening together.
  const [orcleConsentRequested, setOrcleConsentRequested] = useState(false)
  const setOrcleLive = useCallback(
    async (on: boolean): Promise<void> => {
      if (on && !aiConsent) {
        setOrcleConsentRequested(true)
        return
      }
      await patchCohostSettings(orcleLiveSettingsPatch(on))
    },
    [aiConsent, patchCohostSettings]
  )
  const answerOrcleConsent = useCallback(
    async (accepted: boolean): Promise<void> => {
      setOrcleConsentRequested(false)
      if (!accepted) return
      setAiConsent(true)
      await patchCohostSettings(orcleLiveSettingsPatch(true))
    },
    [patchCohostSettings, setAiConsent]
  )

  // Plan 119 S15: with "Make a clean cut of every recording" on, a finished
  // recording starts its clean cut once. The decision, the ledger and the
  // call live in lib/clean-cut-auto.ts, loaded only when a session finalizes.
  const autoRunCleanCutRef = useRef<((event: RecordingFinalizationEvent) => void) | null>(null)
  autoRunCleanCutRef.current = (event) => {
    const activeClient = clientRef.current
    if (!activeClient) return
    void import('@/lib/clean-cut-auto')
      .then((auto) =>
        auto.autoRunCleanCut(event, {
          request: activeClient.request.bind(activeClient),
          sessions: sessionsRef.current,
          consent: aiConsent,
          entitlements,
          capabilities: aiCapabilities
        })
      )
      .catch(() => undefined)
  }

  const runCohostAction = useCallback(
    async (
      method:
        | 'cohost.question.answered'
        | 'cohost.question.dismiss'
        | 'cohost.question.restore'
        | 'cohost.flag.dismiss'
        | 'cohost.promise.done'
        | 'cohost.promise.dismiss'
        | 'cohost.recap.dismiss'
        | 'cohost.recap.draft'
        | 'cohost.author.greeted'
        | 'cohost.utterance.approve'
        | 'cohost.utterance.dismiss'
        | 'cohost.utterance.say',
      params:
        | CohostQuestionParams
        | CohostFlagParams
        | CohostPromiseParams
        | CohostRecapParams
        | CohostAuthorParams
        | CohostUtteranceParams
        | CohostSayParams
    ): Promise<CohostState> => {
      if (!client) throw new Error('Backend socket is not connected.')
      setCohostActionPending(true)
      try {
        const state = await client.request<CohostState>(method, params)
        commitCohostState(state)
        return state
      } finally {
        setCohostActionPending(false)
      }
    },
    [client, commitCohostState]
  )

  const markCohostQuestionAnswered = useCallback(
    (questionId: string, sessionId?: string): void => {
      const target = sessionId ?? cohostStateRef.current?.sessionId
      if (!target) return
      void runCohostAction('cohost.question.answered', { sessionId: target, questionId }).catch(
        (error: unknown) => reportError(error)
      )
    },
    [reportError, runCohostAction]
  )

  const dismissCohostQuestion = useCallback(
    (questionId: string, sessionId?: string): void => {
      const target = sessionId ?? cohostStateRef.current?.sessionId
      if (!target) return
      void runCohostAction('cohost.question.dismiss', { sessionId: target, questionId }).catch(
        (error: unknown) => reportError(error)
      )
    },
    [reportError, runCohostAction]
  )

  const restoreCohostQuestion = useCallback(
    (questionId: string, sessionId?: string): void => {
      const target = sessionId ?? cohostStateRef.current?.sessionId
      if (!target) return
      void runCohostAction('cohost.question.restore', { sessionId: target, questionId }).catch(
        (error: unknown) => reportError(error)
      )
    },
    [reportError, runCohostAction]
  )

  const dismissCohostFlag = useCallback(
    (messageId: string, sessionId?: string): void => {
      const target = sessionId ?? cohostStateRef.current?.sessionId
      if (!target) return
      void runCohostAction('cohost.flag.dismiss', { sessionId: target, messageId }).catch(
        (error: unknown) => reportError(error)
      )
    },
    [reportError, runCohostAction]
  )

  // "Show on stream" is a FREE reuse of the existing comment highlight: the
  // group's first source message is the one the overlay renders.
  const showCohostQuestionOnStream = useCallback(
    (question: CohostQuestion): void => {
      const messageId = cohostHighlightMessageId(question)
      if (!messageId) return
      const message = liveChatSnapshotRef.current.messages.find(
        (candidate) => candidate.id === messageId
      )
      if (!message || !commentCanHighlight(message)) return
      toggleCommentHighlight(message)
    },
    [toggleCommentHighlight]
  )

  // Golem's automatic card (plan 060 S1): the ENGINE decides (cadence, roles,
  // safety gate, one command per decision with an engine-wide generation) and
  // the renderer only executes it. Always-set semantics: an automatic path
  // must never read a repeat as "un-pin" (the H key keeps its toggle). No
  // renderer history: a command the message list cannot serve is simply not
  // executed, and the engine never asks for the same message twice. Failures
  // stay quiet; the backend's status is the truth either way.
  const cohostAutoHighlightGeneration = cohostState?.autoHighlight?.generation ?? 0
  const cohostAutoHighlightMessageId = cohostState?.autoHighlight?.messageId ?? null
  const executeCohostAutoHighlightRef = useRef<(messageId: string) => void>(() => {})
  executeCohostAutoHighlightRef.current = (messageId) => {
    // A card the streamer is setting by hand (H pressed, PNG still
    // rendering) always wins: the engine only sees the backend phase, which
    // is still idle while the manual apply is in flight. The engine reclaims
    // an unserved command after its apply timeout.
    if (commentHighlightApplyingId !== null) return
    const message = liveChatSnapshotRef.current.messages.find(
      (candidate) => candidate.id === messageId
    )
    if (!message || !commentCanHighlight(message)) return
    const intent = ++commentHighlightIntentRef.current
    void applyCommentHighlight(message, undefined, intent, { alwaysSet: true })
      .then((state) => {
        if (state && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(state)
        }
      })
      .catch(async () => {
        const authoritative = await client
          ?.request<CommentHighlightState>('comments.highlight.status')
          .catch(() => null)
        if (authoritative && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(authoritative)
        }
      })
  }
  useEffect(() => {
    if (cohostAutoHighlightGeneration === 0 || !cohostAutoHighlightMessageId) return
    executeCohostAutoHighlightRef.current(cohostAutoHighlightMessageId)
  }, [cohostAutoHighlightGeneration, cohostAutoHighlightMessageId])

  // Plan 156: the Activity auto-show engine. Manual and Golem cards always
  // win — auto only fires into an idle slot with no apply in flight, never
  // un-pins (always-set semantics), and a backlog or History view never
  // replays: the queue reseeds on session change and on switch-on, so only
  // what arrives from "now" is shown. Draining needs no timer — when the
  // backend expires a card it pushes comments.highlight.status, the phase
  // flips to idle, and this effect pops the next pending celebration.
  // Failures stay quiet; the backend's status is the truth either way.
  const autoShowActivityEnabled =
    commentsWindow.autoShowActivity && Boolean(liveChatSnapshot.sessionId)
  const activityAutoShowQueueRef = useRef<AutoShowQueue | null>(null)
  const activityAutoShowSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!autoShowActivityEnabled) {
      // Off (or no live session): forget the queue so the next enable starts
      // from "now" instead of replaying what arrived while it was off.
      activityAutoShowQueueRef.current = null
      activityAutoShowSessionRef.current = null
      return
    }
    const sessionId = liveChatSnapshot.sessionId ?? null
    const seeded = activityAutoShowQueueRef.current
    if (!seeded || activityAutoShowSessionRef.current !== sessionId) {
      activityAutoShowQueueRef.current = seedAutoShowQueue(liveChatSnapshot.messages)
      activityAutoShowSessionRef.current = sessionId
      return
    }
    const queue = enqueueAutoShow(seeded, liveChatSnapshot.messages)
    activityAutoShowQueueRef.current = queue
    if (commentHighlightState.phase !== 'idle' || commentHighlightApplyingId !== null) return
    const next = takeNextAutoShow(queue, liveChatSnapshot.messages, Date.now())
    activityAutoShowQueueRef.current = next.queue
    const message = next.message
    if (!message) return
    const intent = ++commentHighlightIntentRef.current
    void applyCommentHighlight(message, undefined, intent, { alwaysSet: true })
      .then((state) => {
        if (state && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(state)
        }
      })
      .catch(async () => {
        // The card stays where the backend says it is; never guess.
        const authoritative = await client
          ?.request<CommentHighlightState>('comments.highlight.status')
          .catch(() => null)
        if (authoritative && commentHighlightIntentRef.current === intent) {
          publishCommentHighlightState(authoritative)
        }
      })
  }, [
    applyCommentHighlight,
    autoShowActivityEnabled,
    client,
    commentHighlightApplyingId,
    commentHighlightState.phase,
    liveChatSnapshot,
    publishCommentHighlightState
  ])

  // One relayed value for the detached Comments window: the window never
  // re-derives Premium or consent, it renders what the main renderer resolved.
  // Presence is unconditional: before the engine reports (or when it is off)
  // the relay carries the off shape, never null.
  const golemShowOnStream = overlayLayout.golem.showOnStream
  const cohostAutoChat = cohostSettings?.autoChat
  const cohostWindowState = useMemo<CohostWindowState>(
    () => ({
      state: cohostState ?? offCohostState(),
      entitled: cohostGate.allowed,
      entitlementReason: cohostGate.allowed ? null : cohostGate.reason,
      upgradeUrl: (cohostGate.allowed ? undefined : cohostGate.upgradeUrl) ?? null,
      consented: aiConsent,
      enabled: cohostEnabled,
      listen: cohostListen,
      // The Golem on stream (plan 164 S-C4): the pane's header operates it.
      ...(golemPersona
        ? {
            golem: {
              persona: {
                id: golemPersona.id,
                name: golemPersona.name,
                images: golemPersona.images,
                bubbleStyle: golemPersona.bubbleStyle,
                source: golemPersona.source,
                // Plan 168 S-D3: the header's living preview wears the same pack.
                avatar: golemPersona.avatar,
                motion: golemPersona.motion
              },
              state: golemOverlay?.state ?? 'idle',
              bubble: golemOverlay?.bubble?.text ?? null,
              showOnStream: golemShowOnStream
            }
          }
        : {}),
      ...(cohostAutoChat ? { autoChat: cohostAutoChat } : {})
    }),
    [
      aiConsent,
      cohostAutoChat,
      cohostEnabled,
      cohostGate,
      cohostListen,
      cohostState,
      golemOverlay,
      golemPersona,
      golemShowOnStream
    ]
  )

  const cohostWindowStateRef = useRef(cohostWindowState)
  useEffect(() => {
    cohostWindowStateRef.current = cohostWindowState
    void window.videorc?.pushCohostWindowState?.(cohostWindowState)
  }, [cohostWindowState])

  // Golem Live's one switch from the Comments window (plan 119): its presence
  // popover, nudge, consent CTA and one-time listening card. On is the same
  // single `{enabled: true, listen: true}` save as the Golem tab (the window
  // sends `listen: true` too), off only `{enabled: false}`. The settings and
  // cloud-AI consent are main-renderer owned, so the window asks and gets the
  // resolved window state back; its consent CTA grants consent in the click.
  useEffect(() => {
    const off = window.videorc?.onCohostEnableRequest?.((command: CohostEnableCommand) => {
      void (async () => {
        if (command.grantConsent === true) setAiConsent(true)
        if (!client) throw new Error('Backend socket is not connected.')
        // Plan 164 S-D6: the Stream Manager's mode control and behaviour
        // switches ride the same save, merged into the stored block so the
        // templates and cooldowns stay.
        const autoChat = command.autoChat
          ? mergeAutoChatRelayPatch(cohostSettingsRef.current?.autoChat ?? null, command.autoChat)
          : null
        const next = await client.request<CohostSettings>('cohost.settings.set', {
          ...orcleLiveSettingsPatch(command.enabled),
          ...(autoChat ? { autoChat } : {})
        })
        setCohostSettings(next)
        return {
          ...cohostWindowStateRef.current,
          consented: command.grantConsent === true || cohostWindowStateRef.current.consented,
          enabled: next.enabled,
          listen: next.listen === true,
          autoChat: next.autoChat
        } satisfies CohostWindowState
      })()
        .then(async (state) => {
          await window.videorc?.pushCohostEnableResult?.({
            requestId: command.requestId,
            ok: true,
            value: state
          })
        })
        .catch(async (error) => {
          await window.videorc?.pushCohostEnableResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Could not change the Golem setting.'
          })
        })
    })
    return off
  }, [client, setAiConsent])

  useEffect(() => {
    const off = window.videorc?.onCohostActionRequest?.((command: CohostActionCommand) => {
      void (async () => {
        if (!client) throw new Error('Backend socket is not connected.')
        // The Golem's own actions (plan 164 S-C4): the Say box and the output
        // switch. The Say box is one utterance (D7): it posts per the chat
        // mode when the window named its live session, and bubbles at once
        // when the Golem is on some output. The backend owns the bubble.
        if (command.kind === 'golem-say') {
          return runCohostAction('cohost.utterance.say', {
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            text: command.text,
            state: command.state
          })
        }
        // Plan 168 S-D3: a reaction chip; the backend plays it on air.
        if (command.kind === 'golem-react') {
          await client.requestTyped('cohost.pet.react', { reaction: command.reaction })
          return cohostStateRef.current ?? offCohostState()
        }
        if (command.kind === 'golem-show-on-stream') {
          const current = overlayLayoutRef.current
          if (current.golem.showOnStream !== command.showOnStream) {
            await setOverlayLayout({
              ...current,
              golem: { ...current.golem, showOnStream: command.showOnStream }
            })
          }
          return cohostStateRef.current ?? offCohostState()
        }
        if (command.kind === 'dismiss-flag') {
          return runCohostAction('cohost.flag.dismiss', {
            sessionId: command.sessionId,
            messageId: command.targetId
          })
        }
        // Plan 068 D8: promises and recaps, relayed like questions.
        if (command.kind === 'promise-done' || command.kind === 'promise-dismiss') {
          return runCohostAction(
            command.kind === 'promise-done' ? 'cohost.promise.done' : 'cohost.promise.dismiss',
            { sessionId: command.sessionId, promiseId: command.targetId }
          )
        }
        if (command.kind === 'recap-dismiss' || command.kind === 'recap-draft') {
          return runCohostAction(
            command.kind === 'recap-draft' ? 'cohost.recap.draft' : 'cohost.recap.dismiss',
            { sessionId: command.sessionId }
          )
        }
        // Plan 068 D9: the Greeted button on a "Say hi" row.
        if (command.kind === 'author-greeted') {
          return runCohostAction('cohost.author.greeted', {
            sessionId: command.sessionId,
            authorKey: command.targetId
          })
        }
        // Plan 164 S-D2 / D7: the Golem's proposed cards and the Say box.
        if (command.kind === 'approve-utterance' || command.kind === 'dismiss-utterance') {
          return runCohostAction(
            command.kind === 'approve-utterance'
              ? 'cohost.utterance.approve'
              : 'cohost.utterance.dismiss',
            { sessionId: command.sessionId, utteranceId: command.targetId }
          )
        }
        if (command.kind === 'say-utterance') {
          return runCohostAction('cohost.utterance.say', {
            sessionId: command.sessionId,
            text: command.text ?? '',
            ...(command.state ? { state: command.state } : {})
          })
        }
        const method =
          command.kind === 'answered'
            ? 'cohost.question.answered'
            : command.kind === 'restore'
              ? 'cohost.question.restore'
              : 'cohost.question.dismiss'
        return runCohostAction(method, {
          sessionId: command.sessionId,
          questionId: command.targetId
        })
      })()
        .then(async (state) => {
          await window.videorc?.pushCohostActionResult?.({
            requestId: command.requestId,
            ok: true,
            value: state
          })
        })
        .catch(async (error) => {
          await window.videorc?.pushCohostActionResult?.({
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Golem action failed.'
          })
        })
    })
    return off
  }, [client, runCohostAction, setOverlayLayout])

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

  const refreshAccountSnapshotForClient = useCallback(
    async (
      activeClient: BackendClient
    ): Promise<{
      snapshot: VideorcAccountSnapshot
      isCurrent: () => boolean
    } | null> => {
      const coordinator = accountSnapshotCoordinatorRef.current
      const token = coordinator.beginRefresh()
      if (!token) return null

      let inFlight = accountRefreshInFlightRef.current
      if (!inFlight || inFlight.client !== activeClient) {
        const refreshAccount = window.videorc?.refreshAccount
        inFlight = {
          client: activeClient,
          promise: refreshAccount
            ? refreshAccount()
            : activeClient
                .requestTyped('account.get')
                .then((snapshot) => ({ outcome: 'refreshed' as const, snapshot }))
        }
        accountRefreshInFlightRef.current = inFlight
      }

      let result: VideorcAccountRefreshResult
      try {
        result = await inFlight.promise
      } finally {
        if (accountRefreshInFlightRef.current === inFlight) {
          accountRefreshInFlightRef.current = null
        }
      }
      // Deferral is Main's designed answer during capture, not a failure: keep
      // the current snapshot and replay once the session is idle.
      if (result.outcome === 'deferred') {
        accountRefreshDeferredRef.current = true
        return null
      }
      accountRefreshDeferredRef.current = false
      const snapshot = result.snapshot
      if (
        !snapshot ||
        !coordinator.canCommit(token) ||
        clientRef.current !== activeClient ||
        wsStatusRef.current !== 'connected'
      ) {
        return null
      }
      setAccount(snapshot)
      return {
        snapshot,
        isCurrent: () =>
          coordinator.isCurrent(token) &&
          clientRef.current === activeClient &&
          wsStatusRef.current === 'connected'
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

  // Record start/stop latency (instant-record plan): a click arms the clock,
  // the authoritative status that completes the transition closes the sample.
  const recordLatencyTrackerRef = useRef(createRecordLatencyTracker())
  const recordClickAtRef = useRef<{ start: number | null; stop: number | null }>({
    start: null,
    stop: null
  })
  const [recordLatency, setRecordLatency] = useState<RecordLatencyState>({
    start: null,
    stop: null
  })
  const noteRecordClick = useCallback(
    (kind: RecordLatencyKind, origin: RecordLatencyOrigin = 'click') => {
      const now = performance.now()
      recordLatencyTrackerRef.current.markClick(kind, now, origin)
      if (origin === 'click') {
        recordClickAtRef.current[kind] = now
      }
    },
    []
  )
  const takeRecordClickEpochMs = useCallback((kind: RecordLatencyKind): number => {
    const perfNow = performance.now()
    const clickAt = recordClickAtRef.current[kind] ?? perfNow
    recordClickAtRef.current[kind] = null
    return clickEpochMs(clickAt, perfNow, Date.now())
  }, [])

  const applyRecordingStatus = useCallback(
    (status: RecordingStatus) => {
      if (status.state === 'recording' || status.state === 'streaming') {
        lastSessionActivityRef.current = status.state === 'streaming' ? 'live-stream' : 'recording'
      }
      recordingRef.current = status
      if (!['recording', 'streaming'].includes(status.state)) {
        toast.dismiss('recording-degraded')
      }
      sourceStatusUnknownRef.current = false
      setSourceStatusKnown(true)
      sourceSelectionController.setSession(status.sessionId, status.state)
      void sourceSelectionController.refresh()
      setRecording(status)
      syncFramePollingSuppressionRef.current?.()
      const latencySample = recordLatencyTrackerRef.current.observe(status, performance.now())
      if (latencySample) {
        setRecordLatency((current) => ({ ...current, [latencySample.kind]: latencySample }))
        appendLog({
          level: 'info',
          message: formatRecordLatencyLog(latencySample),
          timestamp: new Date().toISOString()
        })
        if (typeof performance.mark === 'function') {
          performance.mark(`videorc:record-${status.state}`)
        }
      }
    },
    [appendLog, sourceSelectionController]
  )

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
                platform: runtimeInfo?.platform ?? 'darwin',
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
      queueNativePreviewSurfacePresentReport,
      runtimeInfo?.platform
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
    transformSceneRef.current = nextScene
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
      const finalizationCheckpoint = finalizationJournalRef.current.checkpoint()
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
        setSessions(
          finalizationJournalRef.current.reconcile(nextPage.items, finalizationCheckpoint)
        )
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
      const finalizationCheckpoint = finalizationJournalRef.current.checkpoint()
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
          return [
            ...current,
            ...finalizationJournalRef.current
              .reconcile(page.items, finalizationCheckpoint)
              .filter((session) => !seen.has(session.id))
          ]
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
          sessionDetailLiveEntriesRef.current.delete(sessionId)
          const [healthPage, logsPage] = await Promise.all([
            activeClient.requestTyped('sessions.healthEvents.list', {
              sessionId,
              limit: SESSION_DETAIL_BUFFER_LIMIT
            }),
            activeClient.requestTyped('sessions.logs.list', {
              sessionId,
              limit: SESSION_DETAIL_BUFFER_LIMIT
            })
          ])
          if (
            clientRef.current !== activeClient ||
            !requestCoordinator.isCurrent(sessionId, requestToken)
          ) {
            return
          }
          const liveEntries = sessionDetailLiveEntriesRef.current.get(sessionId)
          sessionDetailLiveEntriesRef.current.delete(sessionId)
          const loadedDetails: SessionDetails = {
            healthEvents: capSessionDetailBuffer(healthPage.events),
            sessionLogs: capSessionDetailBuffer(logsPage.entries)
          }
          const recency = [
            ...sessionDetailRecencyRef.current.filter((candidate) => candidate !== sessionId),
            sessionId
          ]
          const evicted = recency.slice(0, Math.max(0, recency.length - SESSION_DETAIL_CACHE_LIMIT))
          sessionDetailRecencyRef.current = recency.slice(-SESSION_DETAIL_CACHE_LIMIT)
          for (const evictedId of evicted) {
            requestCoordinator.invalidate(evictedId)
            sessionDetailSingleFlightRef.current.invalidate(evictedId)
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
                  )
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

  const refreshScreensForClient = useCallback(
    async (activeClient: BackendClient | null) => {
      if (!activeClient) {
        return
      }

      const [nextScreens, nextActiveScreen] = await Promise.all([
        activeClient.request<StreamScreen[]>('screens.list'),
        activeClient.request<StreamScreen | null>('screens.active')
      ])
      setScreens(nextScreens)
      commitActiveScreen(nextActiveScreen)
    },
    [commitActiveScreen]
  )

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
        // No toast: the streaming tab's destination card already states the
        // unavailable reason inline, and this fires on routine refreshes —
        // repeating it as a toast was pure nag (owner request 2026-08-14).
        setYoutubeChannels([])
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
      if (oauthUnavailableReason('youtube')) {
        // Silent: the channel picker is not rendered while OAuth is
        // unavailable, so this is unreachable through the UI; if reached
        // programmatically the inline destination status already explains it.
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

  const kickAccountConnected = platformAccounts.some((item) => item.platform === 'kick')
  // Derived, not an effect: results from a disconnected account never show.
  const kickCategories = kickAccountConnected ? kickCategoryResults : EMPTY_KICK_CATEGORIES

  const searchKickCategories = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!client || trimmed.length < 2) {
        setKickCategoryResults([])
        return
      }

      try {
        setLastError(null)
        setKickCategorySearchPending(true)
        const account = platformAccounts.find((item) => item.platform === 'kick')
        const result = await client.request<{ categories: KickCategory[] }>(
          'streamTargets.kick.searchCategories',
          {
            accountId: account?.accountId,
            query: trimmed,
            limit: 10
          }
        )
        setKickCategoryResults(result.categories)
      } catch (error) {
        setKickCategoryResults([])
        reportError(error)
      } finally {
        setKickCategorySearchPending(false)
      }
    },
    [client, platformAccounts, reportError]
  )

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
  // source. Remind them the moment the stream goes up, once per session. Go
  // Live records too, and the backend calls that `recording` (plan 095 S5).
  const xProducerReminderShownRef = useRef(false)
  const recordingLive = sessionIsLive(recording)
  useEffect(() => {
    if (!recordingLive) {
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
    toast.info('X feed is connected. Now start the Broadcast on X.', {
      description:
        'X does not go live from the RTMP feed alone: open Media Studio → Producer → Broadcasts, ' +
        'create a broadcast from your source, and press Broadcast.',
      duration: 20000,
      action: {
        label: 'Open Media Studio',
        onClick: () => void window.videorc?.openOAuthUrl?.('https://studio.x.com')
      }
    })
  }, [recording.state, recordingLive])

  useEffect(() => {
    audioMeterSampleGenerationRef.current += 1
    setAudioMeterLoading(false)
    setAudioMeter(null)
  }, [captureConfig.sources.microphoneId])

  useEffect(() => {
    let disposed = false
    let latestLifecycleEvent: BackendLifecycleEvent | null = null

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
      latestLifecycleEvent = event
      // Crash evidence (runtimeInfo.backendCrashes) is written by main at the
      // moment of the exit; re-read it so Diagnostics and the next bundle
      // export carry the record without a relaunch.
      if (event.state === 'restarting' || event.state === 'failed') {
        window.videorc?.getRuntimeInfo?.().then((nextRuntimeInfo) => {
          if (!disposed) {
            setRuntimeInfo(nextRuntimeInfo)
          }
        })
      }
      if (event.state === 'running') {
        toast.dismiss('backend-lifecycle')
      } else {
        void loadSessionRuntimeRecovery().then((runtime) => {
          if (!disposed && latestLifecycleEvent === event) runtime.showBackendLifecycle(event)
        })
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
        void loadSessionRuntimeRecovery().then((runtime) =>
          runtime.showSourceFallbackActiveSession(sessionState)
        )
      }
    },
    []
  )

  useEffect(() => {
    if (
      sourceStatusUnknownRef.current ||
      isActiveRecordingState(recordingRef.current.state) ||
      sessionStartInFlightRef.current ||
      sessionStartLifecycleActiveRef.current
    )
      return
    setCaptureConfig((current) => {
      const nextSources = reconcileSourceSelection(current.sources, deviceList.devices)

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      recordAutomaticSourceFallbacks(current.sources, nextSources)
      return { ...current, sources: nextSources }
    })
    // recording.state re-runs this when a session ends: a device that vanished
    // mid-session was skipped above and must fall back once the session is idle.
  }, [deviceList, sourceStatusKnown, recording.state, recordAutomaticSourceFallbacks])

  useEffect(() => {
    if (!connection) {
      return
    }

    let disposed = false
    const generation = bootstrapGenerationRef.current + 1
    bootstrapGenerationRef.current = generation
    captureRecoveryConnectionGenerationRef.current = generation
    captureRecoveryServerRevisionRef.current = -1
    captureRecoveryRetryInFlightRef.current = null
    setCaptureRecoveryRetryPending(false)
    setCaptureRecoveryStatus(idleCaptureRecoveryStatus())
    sessionRuntimeEpochRef.current += 1
    const priorSessionState = lastRecordingStateRef.current ?? recordingRef.current.state
    const priorSessionId = lastRecordingSessionIdRef.current ?? recordingRef.current.sessionId
    const priorSessionWasActive = ['starting', 'recording', 'streaming', 'stopping'].includes(
      priorSessionState
    )
    const focusRefreshCoordinator = focusRefreshCoordinatorRef.current
    const accountSnapshotCoordinator = accountSnapshotCoordinatorRef.current
    entitlementsRevisionRef.current += 1
    accountSnapshotCoordinator.invalidate()
    accountRefreshInFlightRef.current = null
    finalizationJournalRef.current = new FinalizationSnapshotJournal()
    const sessionListRefreshRequests = sessionListRefreshRequestRef.current
    const sessionListMoreSingleFlight = sessionListMoreSingleFlightRef.current
    const sessionDetailRequests = sessionDetailRequestRef.current
    const sessionDetailSingleFlight = sessionDetailSingleFlightRef.current
    const sessionDetailLiveEntries = sessionDetailLiveEntriesRef.current
    focusRefreshCoordinator.invalidate()
    sessionListRefreshRequests.clear()
    sessionListMoreSingleFlight.clear()
    sessionListGenerationRef.current += 1
    setSessionsLoadingMore(false)
    sessionDetailRequests.clear()
    sessionDetailSingleFlight.clear()
    sessionDetailLiveEntries.clear()
    sessionDetailRecencyRef.current = []
    setSessionDetails({})
    setSessionDetailsLoading(new Set())
    setSessionDetailError(null)
    const bootstrapAbort = new AbortController()
    const generationIsCurrent = (): boolean =>
      !disposed && bootstrapGenerationRef.current === generation
    const liveChatBootstrapInitialSnapshot = liveChatSnapshotRef.current
    const initialDelivery = liveChatBootstrapInitialSnapshot.delivery!
    // Ordered control boundary, before any raw events or bootstrap publication.
    publishedChatBoundaryRef.current = `${initialDelivery.ownerId}:${initialDelivery.generation}`
    void window.videorc?.pushCommentsDelta?.({
      kind: 'adopt',
      deliveryBoundary: {
        ownerId: initialDelivery.ownerId,
        generation: initialDelivery.generation
      },
      updatedAt: liveChatBootstrapInitialSnapshot.updatedAt
    })
    const nextClient = new BackendClient(connection)
    const platformBootstrapClient = new BackendClient(connection)
    const bootstrapRequest = <TPayload,>(method: string, params?: unknown): Promise<TPayload> =>
      nextClient.request<TPayload>(method, params, { signal: bootstrapAbort.signal })
    const bootstrapGuard = new StudioBootstrapGuard()
    let liveChatBootstrapComplete = false
    let liveChatBootstrapOverflowed = false
    const liveChatBootstrapEvents: LiveChatBootstrapEvent[] = []
    const markLiveChatOverflow = (): void => {
      if (generationIsCurrent()) updateLiveChatSnapshot(markChatDeliveryIncomplete)
    }
    const liveChatMessageBatcher = new LiveChatMessageBatcher({
      onOverflow: markLiveChatOverflow,
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
    // Stream Manager dashboard (plan 055, S7): a lazy chunk folds these
    // events into one relayed state; the few that arrive first wait for it.
    type DashboardFeed = Awaited<
      ReturnType<typeof import('@/lib/live-dashboard-relay').startLiveDashboardRelay>
    >
    let dashboard: DashboardFeed | null = null
    const dashboardBacklog: Parameters<DashboardFeed['feed']>[] = []
    const feedDashboard: DashboardFeed['feed'] = (event, payload) => {
      if (dashboard) dashboard.feed(event, payload)
      else if (dashboardBacklog.length < 256) dashboardBacklog.push([event, payload])
    }
    void import('@/lib/live-dashboard-relay')
      .then(({ startLiveDashboardRelay }) =>
        startLiveDashboardRelay({ client: nextClient, isCurrent: generationIsCurrent })
      )
      .then((started) => {
        if (!generationIsCurrent()) return started.dispose()
        dashboard = started
        for (const [event, payload] of dashboardBacklog.splice(0)) started.feed(event, payload)
      })
      .catch(() => undefined)
    // Chat removals (plan 140, S6): a lazy chunk keeps the live session's
    // removal ledger, relays the Stream Manager's Remove from chat and card
    // answers, and mirrors an open Golem card as a toast while the Stream
    // Manager is closed. Events that arrive first wait for it.
    let moderation: typeof chatModerationRef.current = null
    let stopCohostCommandRelay: (() => void) | null = null
    const moderationBacklog: ModerationOperation[] = []
    void import('@/lib/chat-moderation-relay')
      .then(({ startChatModerationRelay, startCohostCommandRelay }) => {
        if (!generationIsCurrent()) return
        // Plan 140, S6 part B: the Stream Manager's answers to Golem's cards.
        stopCohostCommandRelay = startCohostCommandRelay({
          client: nextClient,
          sessionId: () => liveChatSnapshotRef.current.sessionId,
          commit: commitCohostState
        })
        moderation = startChatModerationRelay({
          client: nextClient,
          sessionId: () => liveChatSnapshotRef.current.sessionId,
          publish: (moderationOperations) => {
            const snapshot = liveChatSnapshotRef.current
            if (!snapshot.sessionId) return
            void publishLiveCommentsSnapshot({
              mode: { kind: 'live' },
              snapshot,
              moderationOperations
            })
          }
        })
        chatModerationRef.current = moderation
        for (const operation of moderationBacklog.splice(0)) moderation.feed(operation)
      })
      .catch(() => undefined)
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
        const { renderCaptionCueFramePng } = await loadCaptionOverlay()
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
            if (pending.overflowed) markLiveChatOverflow()
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
          void publishLiveCommentsSnapshot({
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
    sourceStatusUnknownRef.current = true
    setSourceStatusKnown(false)
    setWsStatus('connecting')
    setLastError(null)

    let remoteSurfaceConnected = false
    let remoteSurfacePublisher: RemoteSurfacePublisher | null = null
    void import('@/lib/remote-surface')
      .then(({ RemoteSurfacePublisher }) => {
        if (disposed) return
        remoteSurfacePublisher = new RemoteSurfacePublisher()
        remoteSurfacePublisherRef.current = remoteSurfacePublisher
        remoteSurfacePublisher.attach(nextClient)
        const values = remoteSurfaceValuesRef.current
        if (values) remoteSurfacePublisher.syncValues(values)
        if (remoteSurfaceConnected) remoteSurfacePublisher.markConnected()
      })
      .catch((error: unknown) => {
        if (!disposed) reportError(error)
      })
    const unsubscribers = [
      nextClient.on('session.sources.changed', () => {
        // Read the complete current authority; event delivery can race RPC completion.
        void sourceSelectionController.refresh()
      }),
      nextClient.on('backend.ready', () => {
        setWsStatus('connected')
        // The backend's remote surface slate is blank on (re)connect.
        remoteSurfaceConnected = true
        remoteSurfacePublisher?.markConnected()
        // Seed the pushed remote-control status; every later change arrives
        // as a remote.control.status event.
        void nextClient
          .request<RemoteControlStatus>('remote.control.status')
          .then(setRemoteControlStatus)
          .catch(reportError)
        void nextClient
          .request<RemoteLanStatus>('remote.lan.status')
          .then(setRemoteLanStatus)
          .catch(reportError)
      }),
      // Remote-control intents (Stream Deck et al) arrive as events relayed
      // by the backend. Preserve arrival order across asynchronous handlers:
      // each executor samples authoritative session truth only when its turn
      // begins, and a failed predecessor cannot poison the tail.
      nextClient.on('remote.intent', (payload) => {
        const result = remoteIntentTailRef.current
          .catch(() => undefined)
          .then(() => (disposed ? undefined : handleRemoteIntent(payload)))
        remoteIntentTailRef.current = result.then(
          () => undefined,
          () => undefined
        )
      }),
      nextClient.on('remote.control.status', (payload) => {
        setRemoteControlStatus(payload as RemoteControlStatus)
      }),
      nextClient.on('remote.lan.status', (payload) => {
        setRemoteLanStatus(payload as RemoteLanStatus)
      }),
      nextClient.on('remote.lan.paired', (payload) => {
        // A new device on the control surface is never silent: an unexpected
        // pairing must be visible to the person at the desk.
        const deviceName = (payload as { deviceName?: string } | null)?.deviceName ?? 'A phone'
        toast.success(`${deviceName} paired with Videorc`)
      }),
      // OS-global shortcut triggers ride the same lifecycle as the backend
      // subscriptions: they can only act when a backend exists anyway.
      window.videorc?.onGlobalShortcut?.((action) => handleGlobalShortcut(action)) ?? (() => {}),
      nextClient.on('devices.changed', (payload) => {
        bootstrapGuard.mark('devices')
        setDeviceList(payload as DeviceList)
      }),
      nextClient.on('entitlements.updated', (payload) => {
        commitEntitlementsSnapshot(payload)
      }),
      nextClient.on('recording.finalization', (payload) => {
        // Background MP4 export (instant-record P2): patch the Library row in
        // place; refetch only when a finalized row is not loaded yet.
        const event = payload
        bootstrapGuard.mark('sessions')
        finalizationJournalRef.current.record(event)
        setSessions((current) => applyFinalizationEvent(current, event))
        if (event.state === 'finalizing') {
          activeFinalizationNoticesRef.current.add(event.sessionId)
          announcedFinalizationsRef.current.delete(event.sessionId)
          toast.loading(
            finalizingBadgeLabel({
              status: 'completed',
              finalizationProgressPercent: event.progressPercent
            }),
            {
              id: `finalization-${event.sessionId}`,
              duration: Infinity,
              description:
                'Your recording is safe. Long recordings can take several minutes to save as MP4.'
            }
          )
        }
        if (finalizationEventNeedsRefresh(sessionsRef.current, event)) {
          void refreshSessions(nextClient)
        }
        if (
          event.state === 'finalized' &&
          !announcedFinalizationsRef.current.has(event.sessionId)
        ) {
          announcedFinalizationsRef.current.add(event.sessionId)
          toast.success('MP4 ready', {
            id: `finalization-${event.sessionId}`,
            duration: 15000,
            action: {
              label: 'Show in folder',
              onClick: () => {
                void window.videorc?.revealSession(event.sessionId)
              }
            }
          })
          autoRunCleanCutRef.current?.(event)
        }
        if (event.state === 'failed') {
          toast.error('MP4 export failed', {
            duration: Infinity,
            id: `finalization-${event.sessionId}`,
            description: event.error ?? 'The original MKV recording was kept.',
            action: {
              label: 'Retry export',
              onClick: () => void remuxSessionRef.current?.(event.sessionId)
            }
          })
        }
      }),
      // A clean cut that finished out of view (plan 119 S15): its copy joins
      // the Library, and the ready toast says so once per cut-list revision.
      nextClient.on('cleanCut.status', (job) => {
        if (job.state !== 'completed') return
        void refreshSessions(nextClient)
        void import('@/lib/clean-cut-notify')
          .then((notify) => notify.announceCleanCutReady(job))
          .catch(() => undefined)
      }),
      nextClient.on('noiseCleanup.status', (payload) => {
        const job = payload
        setNoiseCleanupJobs((current) => upsertNoiseCleanupJob(current, job))
        if (job.status === 'completed') {
          void refreshSessions(nextClient)
          const outputSessionId = job.outputSessionId
          if (outputSessionId && !announcedNoiseCleanupCompletionsRef.current.has(job.id)) {
            announcedNoiseCleanupCompletionsRef.current.add(job.id)
            void loadSessionRuntimeRecovery().then((runtime) =>
              runtime.showNoiseCleanupCompleted(job.id, outputSessionId)
            )
          }
        }
      }),
      nextClient.on('recording.status', (payload) => {
        bootstrapGuard.mark('recording')
        bootstrapGuard.mark('sessions')
        const incomingStatus = payload as RecordingStatus
        const previousState = recordingRef.current.state ?? lastRecordingStateRef.current
        const previouslyLive = sessionIsLive(recordingRef.current)
        const previousSessionId =
          recordingRef.current.sessionId ?? lastRecordingSessionIdRef.current
        const exactTerminalSessionId =
          incomingStatus.sessionId ??
          ((incomingStatus.state === 'idle' || incomingStatus.state === 'failed') &&
          ['recording', 'streaming', 'stopping'].includes(previousState ?? '') &&
          previousSessionId &&
          platformLifecycleOwnerRef.current?.sessionId === previousSessionId
            ? previousSessionId
            : undefined)
        // Some backend terminal pushes omit the session ID. Once the renderer
        // owns an exact active-session provider snapshot, correlate that push
        // before startup reconciliation as well as autonomous settlement.
        const status =
          exactTerminalSessionId && !incomingStatus.sessionId
            ? { ...incomingStatus, sessionId: exactTerminalSessionId }
            : incomingStatus
        if (
          sessionStartLifecycleActiveRef.current &&
          status.sessionId &&
          (status.state === 'stopping' || status.state === 'idle' || status.state === 'failed')
        ) {
          sessionStartAuthoritativeStatusesRef.current.set(status.sessionId, status)
          if (
            sessionStartLifecycleSessionIdRef.current === status.sessionId &&
            !sessionStartLifecycleInvalidatedSessionIdsRef.current.has(status.sessionId)
          ) {
            sessionStartLifecycleInvalidatedSessionIdsRef.current.add(status.sessionId)
            platformLifecycleRun.current += 1
          }
        }
        if (
          !sessionStartLifecycleActiveRef.current &&
          exactTerminalSessionId &&
          (status.state === 'idle' || status.state === 'failed')
        ) {
          const settleOwner = settleClaimedPlatformLifecycleOwnerRef.current
          const owner = settleOwner ? claimPlatformLifecycleOwner(exactTerminalSessionId) : null
          if (owner && settleOwner) {
            platformLifecycleRun.current += 1
            void settleOwner(owner).catch(reportError)
          }
          liveChatMessageBatcher.clear()
          clearLiveChatForTerminalSession(exactTerminalSessionId)
        }
        lastRecordingStateRef.current = status.state
        if (status.sessionId) {
          lastRecordingSessionIdRef.current = status.sessionId
        }
        applyRecordingStatus(status)
        feedDashboard('recording.status', status)
        if (['idle', 'failed'].includes(status.state)) {
          setStreamTargets([])
          void refreshSessions(nextClient)
          // Session over: the viewer chip must clear, not freeze (rider V2).
          void window.videorc?.pushViewerSample?.(null)
          feedDashboard('stream.viewers', null)
        }
        // Capture started: pull the fresh 'running' row so the Library shows
        // the live session immediately (status ticks repeat the state, so
        // only refresh on the transition).
        if (
          ['recording', 'streaming'].includes(status.state) &&
          (!['recording', 'streaming'].includes(previousState ?? '') ||
            (status.sessionId && status.sessionId !== previousSessionId))
        ) {
          clearSessionRuntimeState()
          void refreshSessions(nextClient)
        }
        // "Open Stream Manager when I go live" (plan 055, decision 6). Go Live
        // is record+stream, which the backend reports as `recording` with a
        // stream URL (plan 095 S5).
        if (
          sessionIsLive(status) &&
          !previouslyLive &&
          settingsRef.current.openStreamManagerOnLive
        ) {
          void openCommentsWindowRef.current().catch(() => undefined)
        }
        // A terminal session moves a persistent degradation notice to past
        // tense. A saved recording also gets its two natural next steps: watch
        // it, or find it in the Library. Stream-only sessions have no local
        // artifact, so they must not claim that a recording was saved.
        if (
          status.state === 'idle' &&
          ['recording', 'streaming', 'stopping'].includes(previousState ?? '')
        ) {
          const finishedActivity = lastSessionActivityRef.current
          const finishedSessionId =
            status.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
          const continuationEpoch = sessionRuntimeEpochRef.current
          void loadSessionRuntimeRecovery().then((runtime) => {
            if (
              recordingRef.current.state !== 'idle' ||
              !runtime.sessionRuntimeContinuationIsCurrent(
                continuationEpoch,
                sessionRuntimeEpochRef.current,
                finishedSessionId,
                recordingRef.current.sessionId ?? lastRecordingSessionIdRef.current ?? undefined
              )
            ) {
              return
            }
            runtime.showSessionFinished({
              status,
              ...(lastRecordingSessionIdRef.current
                ? { lastSessionId: lastRecordingSessionIdRef.current }
                : {}),
              activity: finishedActivity,
              currentNotice: sessionRuntimeNoticeRef.current,
              replaceNotice: replaceSessionRuntimeNotice
            })
          })
        }
        // Treat the backend's terminal state as authoritative even when it
        // races the initial snapshot. Dedupe in publishRecordingFailure keeps
        // repeated status events to one persistent notice.
        if (status.state === 'failed') {
          void publishRecordingFailure(status)
        }
      }),
      // Viewer rider V2: relay the latest concurrent-viewer sample to the
      // Comments window (main-process cache + push, same shape as highlight).
      nextClient.on('stream.viewers', (payload) => {
        void window.videorc?.pushViewerSample?.(payload as ViewerSample)
        feedDashboard('stream.viewers', payload)
      }),
      // Twitch GIFs in chat (plan 155, D6): the Stream Manager window has no
      // backend socket, so this renderer relays the setting through main.
      nextClient.on('liveChat.emotes', (payload) => {
        const settings = payload as ChatEmotesSettings
        if (settings.twitchGifs) void window.videorc?.pushChatGifMode?.(settings.twitchGifs)
      }),
      nextClient.on('stream.audience', (payload) => feedDashboard('stream.audience', payload)),
      nextClient.on('health.event', (payload) => {
        bootstrapGuard.mark('sessions')
        const event = payload as HealthEvent
        setHealthEvents((current) => [event, ...current].slice(0, 40))
        const systemAudioIssue = systemAudioIssueFromHealthEvent(event)
        const systemAudioIssueSessionId = event.sessionId ?? recordingRef.current.sessionId
        if (systemAudioIssue && systemAudioIssueSessionId) {
          setSystemAudioIssueEvent({
            sessionId: systemAudioIssueSessionId,
            issue: systemAudioIssue
          })
        }
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
        if (event.code.startsWith('recording-quality-')) {
          void refreshSessions(nextClient)
        }
        // isSessionAudioLossCode lives in the lazy recovery chunk; this stays
        // byte-cheap for the eager renderer budget.
        if (/^(microphone-(input|timeline)|system-audio)-lost$/.test(event.code)) {
          void publishMicrophoneInputLost(event)
        } else {
          // Plan 076: a timeline loss that recovered clears its notice.
          if (
            /-recovered$/.test(event.code) &&
            sessionRuntimeNoticeRef.current?.kind === 'microphone-input-lost'
          ) {
            microphoneInputLostSessionRef.current = null
            dismissSessionRuntimeNotice()
          }
          const qualityDedupeKey = event.sessionId ?? event.message
          const continuationEpoch = sessionRuntimeEpochRef.current
          void loadSessionRuntimeRecovery().then((runtime) => {
            if (
              continuationEpoch !== sessionRuntimeEpochRef.current ||
              (event.sessionId &&
                event.sessionId !==
                  (recordingRef.current.sessionId ?? lastRecordingSessionIdRef.current))
            ) {
              return
            }
            // A last-session ID is useful for terminal quality notices, but
            // never proves a delayed active-only warning still belongs on screen.
            if (
              event.code === 'recording-degraded' &&
              (!['recording', 'streaming'].includes(recordingRef.current.state) ||
                event.sessionId !== recordingRef.current.sessionId)
            )
              return
            const shownKey = runtime.showSessionHealthEvent(
              event,
              qualityToastSessionsRef.current.has(qualityDedupeKey)
            )
            if (shownKey) qualityToastSessionsRef.current.add(shownKey)
          })
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
        feedDashboard('stream.health', payload)
      }),
      nextClient.on('stream.targets', (payload) => {
        setStreamTargets((payload as StreamTargetsSnapshot).targets)
        feedDashboard('stream.targets', payload)
      }),
      nextClient.on('diagnostics.stats', (payload) => {
        bootstrapGuard.mark('diagnostics')
        commitDiagnosticStatsThrottled(payload as DiagnosticStats)
      }),
      // Plan 092 Phase C: about 20 a second during a session. Kept out of React
      // state; the mixer's level sources read the store directly.
      nextClient.on('audio.levels', (payload) => {
        backendAudioLevels.publish(payload as AudioLevelsEvent)
      }),
      nextClient.on('capture.recovery.status', (payload) => {
        commitCaptureRecoveryStatus(payload as CaptureRecoveryStatus, generation)
      }),
      nextClient.on('preview.live.status', (payload) => {
        bootstrapGuard.mark('previewLive')
        applyPreviewLiveStatus(payload as PreviewLiveStatus)
      }),
      nextClient.on('preview.surface.status', (payload) => {
        bootstrapGuard.mark('previewSurface')
        const backendStatus = payload as PreviewSurfaceStatus
        const readSerial = ++nativePreviewMainStatusReadSerialRef.current
        const previewGeneration = previewWindowRef.current.supervisor.generation
        const mainStatusReadCanCommit = (): boolean =>
          !disposed &&
          readSerial === nativePreviewMainStatusReadSerialRef.current &&
          nativePreviewMainStatusReadGenerationMatches(
            previewGeneration,
            previewWindowRef.current.supervisor.generation
          )
        if (
          previewSurfaceStatusRequiresMainAuthority(backendStatus) &&
          window.videorc?.getNativePreviewSurfaceStatus
        ) {
          void window.videorc
            .getNativePreviewSurfaceStatus()
            .then((mainStatus) => {
              if (mainStatusReadCanCommit()) {
                applyPreviewSurfaceStatusThrottled(mainStatus)
              }
            })
            .catch(() => {
              if (mainStatusReadCanCommit()) {
                applyPreviewSurfaceStatusThrottled(
                  previewSurfaceStatusWithoutMainAuthority(backendStatus)
                )
              }
            })
          return
        }
        applyPreviewSurfaceStatusThrottled(backendStatus)
      }),
      nextClient.on('compositor.status', (payload) => {
        bootstrapGuard.mark('compositor')
        const status = payload as CompositorStatus
        // Backend-authored commits (live source switches) arrive only as this
        // event; advance committed truth so a later resync never re-presents
        // an older revision. Layout transactions record their own proven commit.
        const sceneRevision = status.sceneRevision ?? -1
        if (
          layoutIntentAwaitingProofRef.current === null &&
          status.sceneId &&
          sceneRevision > (nativePreviewCommittedSceneRef.current?.sceneRevision ?? -1)
        ) {
          nativePreviewCommittedSceneRef.current = {
            sceneId: status.sceneId,
            sceneRevision,
            compositorStatus: status
          }
        }
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
        commitActiveScreen(payload as StreamScreen | null)
      }),
      nextClient.on('platformAccounts.changed', (payload) => {
        // The authorization link toast is persistent; retire it as soon
        // as the connection resolves.
        toast.dismiss('oauth-authorization-link')
        bootstrapGuard.mark('platformAccounts')
        setPlatformAccounts(payload as PlatformAccount[])
      }),
      nextClient.on('liveChat.snapshot', (payload) => {
        bootstrapGuard.mark('liveChat')
        liveChatMessageBatcher.flush()
        const snapshot = applyLiveChatSnapshot(
          payload as LiveChatSnapshot,
          liveChatSnapshotRef.current
        )
        bufferLiveChatBootstrapEvent({ kind: 'snapshot', snapshot })
        liveChatMessageBatcher.clear()
        replaceLiveChatSnapshotState(snapshot)
        const latestSendOperation = latestLiveChatSendOperationRef.current
        void publishLiveCommentsSnapshot({
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
      nextClient.on('liveChat.totals', (payload) => feedDashboard('liveChat.totals', payload)),
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
        const snapshot = applyLiveChatSnapshot(
          payload as LiveChatSnapshot,
          liveChatSnapshotRef.current,
          true
        )
        bufferLiveChatBootstrapEvent({ kind: 'snapshot', snapshot })
        liveChatMessageBatcher.clear()
        replaceLiveChatSnapshotState(snapshot)
        void window.videorc?.pushCommentsDelta?.({
          kind: 'clear',
          sessionId: snapshot.sessionId,
          updatedAt: snapshot.updatedAt,
          deliveryBoundary: {
            ownerId: snapshot.delivery!.ownerId,
            generation: snapshot.delivery!.generation
          }
        })
        const latestSendOperation = latestLiveChatSendOperationRef.current
        void publishLiveCommentsSnapshot({
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
      nextClient.on('liveChat.moderationOperation', (operation) => {
        if (moderation) moderation.feed(operation)
        else if (moderationBacklog.length < 64) moderationBacklog.push(operation)
      }),
      nextClient.on('cohost.state', (payload) => {
        commitCohostState(payload as CohostState)
      }),
      nextClient.on('cohost.golem.state', (payload) => {
        setGolemOverlay(payload as GolemOverlaySnapshot)
      }),
      // Clip that (plan 068 D6): one toast per mark, whether it came from a
      // spoken phrase, a shortcut, a deck key, or the Stream Manager.
      nextClient.on('clip.marked', (payload) => {
        // A recording that never went live has no stream report to point at.
        const copy = clipMarkedToast(payload as ClipMarkedEvent, {
          streaming: sessionIsLive(recordingRef.current)
        })
        ;(copy.kind === 'success' ? toast.success : toast.warning)(copy.title, {
          id: 'clip-marked',
          description: copy.description
        })
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
        feedDashboard('events.lagged', payload)
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
      // Plan 083: a failed Broadcast info thumbnail warns with Retry.
      nextClient.on('streamTargets.youtube.thumbnail', (payload) => {
        void loadSessionRuntimeRecovery().then((runtime) => {
          const failure = runtime.youtubeThumbnailFailure(payload)
          if (failure && generationIsCurrent())
            runtime.showYouTubeThumbnailFailure(nextClient, failure)
        })
      }),
      nextClient.on('youtube.quota', (payload) => {
        const status = payload as YouTubeQuotaStatus
        const previous = youtubeQuotaRef.current
        youtubeQuotaRef.current = status
        setYoutubeQuota(status)
        // Plan 094 (S6): one quiet notice per budget step, on the way up only.
        void loadSessionRuntimeRecovery().then((runtime) => {
          if (generationIsCurrent()) runtime.showYouTubeBudgetStep(previous, status)
        })
      }),
      nextClient.on('platformAccounts.oauth.callback', (result) => {
        void loadSessionRuntimeRecovery().then((runtime) => {
          if (generationIsCurrent()) runtime.showOAuthCallbackResult(result)
        })
        if (result.status === 'success' && result.accountConnected) {
          void refreshPlatformAccountsForClient(nextClient)
          void validatePlatformAccountsForClient(nextClient)
        } else if (result.status === 'success' && result.platform === 'x' && result.tokenStored) {
          // Authorize X Live (OAuth 1.0a) landed a token in the secret store;
          // re-check the capability so Ready appears without a manual refresh.
          void nextClient
            .request<XNativeLiveCapability>('streamTargets.x.capability', {})
            .then(setXNativeCapability)
            .catch(() => undefined)
        }
      }),
      nextClient.on('streamTargets.x.playback', (payload) => {
        const event = payload as XPlaybackEvent
        // One toast per broadcast+status; the probe may re-emit while polling.
        const toastKey = `${event.broadcastId}:${event.status}`
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
                    'X is still provisioning playback. Viewers may see a loading spinner. Keep streaming; this can take a few minutes.',
                  redactedUrl: event.shareUrl
                }
              : {
                  state: 'warning' as const,
                  message:
                    'X never produced playback for this broadcast. Viewers saw a loading spinner. Your local recording is unaffected.',
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
        if (!xPlaybackToastsRef.current.has(toastKey)) {
          void loadSessionRuntimeRecovery().then((runtime) => {
            if (!generationIsCurrent() || xPlaybackToastsRef.current.has(toastKey)) return
            xPlaybackToastsRef.current.add(toastKey)
            runtime.showXPlaybackEvent(event)
          })
        }
      }),
      nextClient.on('log', (payload) => appendLog(payload as BackendLogEvent)),
      nextClient.on('error', (payload) => {
        const error = payload as { message?: string }
        const message = error.message ?? 'Backend error.'
        setLastError(message)
        // A backend `error` event can repeat every reconnect: one toast per text.
        notifyOnce(`backend-error:${message}`, 'error', message)
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
        // Seed the Stream Manager's GIF mode relay outside the bootstrap
        // batch: nothing on startup waits for it, and a failure costs only
        // the default (Animated) until the next liveChat.emotes event.
        void nextClient
          .request<ChatEmotesSettings>('liveChat.emotes.get')
          .then((settings) => {
            if (generationIsCurrent() && settings.twitchGifs)
              void window.videorc?.pushChatGifMode?.(settings.twitchGifs)
          })
          .catch(() => undefined)
        const bootstrapSnapshot = bootstrapGuard.snapshot()
        const entitlementsRevisionAtBootstrapStart = entitlementsRevisionRef.current
        const accountBootstrapToken = accountSnapshotCoordinator.beginRefresh()
        const commentHighlightRevisionAtBootstrapStart = commentHighlightRevision
        const captionsStatusRevisionAtBootstrapStart = captionsStatusRevisionRef.current
        // The takeover commit also releases the microphone mute a takeover
        // owns, so it must not wait on the rest of the batch: one unrelated
        // failed request used to skip it and strand a muted microphone with
        // no takeover selected. A failed read stays unknown and commits
        // nothing; it still fails the batch below so the error surfaces.
        // Session authority must settle even if device discovery or another
        // bootstrap query fails. Idle fallback remains blocked until this read.
        // A failed read retries: otherwise every picker stays on "Checking the
        // current session…" until some later recording.status event.
        const readRecordingStatus = (attempt: number): Promise<RecordingStatus> => {
          const snapshot = bootstrapGuard.snapshot()
          const read = bootstrapRequest<RecordingStatus>('recording.status')
          read.then(
            (status) => {
              if (generationIsCurrent() && bootstrapGuard.isCurrent(snapshot, 'recording')) {
                applyRecordingStatus(status)
                feedDashboard('recording.status', status)
              }
            },
            () =>
              attempt < 4 &&
              setTimeout(
                () => generationIsCurrent() && readRecordingStatus(attempt + 1),
                1000 * attempt
              )
          )
          return read
        }
        const recordingStatusBootstrap = readRecordingStatus(1)
        const activeScreenBootstrap = bootstrapRequest<StreamScreen | null>('screens.active')
        void activeScreenBootstrap.then(
          (nextActiveScreen) => {
            if (
              generationIsCurrent() &&
              bootstrapGuard.isCurrent(bootstrapSnapshot, 'activeScreen')
            ) {
              commitActiveScreen(nextActiveScreen)
            }
          },
          () => undefined
        )
        const [
          nextHealth,
          nextEntitlements,
          nextAccount,
          nextDevices,
          nextRecording,
          nextDiagnostics,
          nextCaptureRecoveryStatus,
          nextCaptionsStatus,
          nextLiveChat,
          nextCommentHighlight,
          nextPreview,
          nextPreviewSurface,
          nextPreviewCamera,
          nextPreviewScreen,
          nextScene,
          nextScreens,
          ,
          nextStreamMetadataDraft,
          nextSessions,
          nextSessionStorage,
          nextNoiseCleanupJobs
        ] = await Promise.all([
          bootstrapRequest<BackendHealth>('health.ping'),
          bootstrapRequest<EntitlementsSnapshot>('entitlements.refresh'),
          bootstrapRequest<VideorcAccountSnapshot>('account.get'),
          bootstrapRequest<DeviceList>('devices.list'),
          recordingStatusBootstrap,
          bootstrapRequest<DiagnosticStats>('diagnostics.stats'),
          bootstrapRequest<CaptureRecoveryStatus>('capture.recovery.status'),
          bootstrapRequest<CaptionsStatus>('captions.status.get'),
          bootstrapRequest<LiveChatSnapshot>('liveChat.status'),
          bootstrapRequest<CommentHighlightState>('comments.highlight.status'),
          bootstrapRequest<PreviewLiveStatus>('preview.live.status'),
          bootstrapRequest<PreviewSurfaceStatus>('preview.surface.status'),
          bootstrapRequest<PreviewCameraStatus>('preview.camera.status'),
          bootstrapRequest<PreviewScreenStatus>('preview.screen.status'),
          bootstrapRequest<Scene>('scene.get'),
          bootstrapRequest<StreamScreen[]>('screens.list'),
          activeScreenBootstrap,
          bootstrapRequest<StreamMetadataDraft>('streamTargets.metadata.get'),
          bootstrapRequest<SessionListPage>('sessions.list', { limit: SESSION_LIST_PAGE_LIMIT }),
          bootstrapRequest<SessionStorageTotals>('sessions.storage'),
          bootstrapRequest<NoiseCleanupJob[]>('noiseCleanup.list')
        ])
        if (!generationIsCurrent()) {
          return
        }

        let runtimeRecovery:
          | {
              kind: 'recording-failed'
              status: RecordingStatus
              activity: SessionRuntimeActivity
            }
          | { kind: 'microphone-input-lost'; event: HealthEvent }
          | null = null
        if (
          priorSessionWasActive ||
          ['recording', 'streaming', 'failed'].includes(nextRecording.state)
        ) {
          const recovery = await loadSessionRuntimeRecovery()
          runtimeRecovery = await recovery.recoverSessionRuntime({
            recording: nextRecording,
            sessions: nextSessions.items,
            ...(priorSessionId ? { priorSessionId } : {}),
            priorSessionState,
            loadHealthEvents: (sessionId) =>
              bootstrapRequest<SessionHealthEventsPage>('sessions.healthEvents.list', {
                sessionId,
                limit: SESSION_DETAIL_BUFFER_LIMIT
              }).then((page) => page.events)
          })
          if (!generationIsCurrent()) {
            return
          }
        }

        let resolvedPreviewSurface = nextPreviewSurface
        if (
          previewSurfaceStatusRequiresMainAuthority(nextPreviewSurface) &&
          window.videorc?.getNativePreviewSurfaceStatus
        ) {
          const previewGeneration = previewWindowRef.current.supervisor.generation
          resolvedPreviewSurface = await window.videorc
            .getNativePreviewSurfaceStatus()
            .catch(() => previewSurfaceStatusWithoutMainAuthority(nextPreviewSurface))
          if (
            !generationIsCurrent() ||
            !nativePreviewMainStatusReadGenerationMatches(
              previewGeneration,
              previewWindowRef.current.supervisor.generation
            )
          ) {
            return
          }
        }

        // Commit the local, UI-critical snapshot before optional provider
        // validation. A slow or failing provider network call must not hold
        // devices, recording, or preview in the loading state.
        setHealth(nextHealth)
        // Plan 094: a window that opens mid-pause still shows the paused state.
        void nextClient
          .request<YouTubeQuotaStatus>('youtube.quota.status')
          .then((status) => {
            if (generationIsCurrent()) setYoutubeQuota(status)
          })
          .catch(() => undefined)
        if (entitlementsRevisionRef.current === entitlementsRevisionAtBootstrapStart) {
          commitEntitlementsSnapshot(nextEntitlements)
        }
        if (accountBootstrapToken && accountSnapshotCoordinator.canCommit(accountBootstrapToken)) {
          setAccount(nextAccount)
          setAiReadinessLoading(nextAccount.status === 'signed-in')
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'devices')) {
          setDeviceList(nextDevices)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'recording')) {
          if (
            ['recording', 'streaming', 'stopping'].includes(nextRecording.state) &&
            nextRecording.sessionId !== priorSessionId
          ) {
            clearSessionRuntimeState()
          }
          applyRecordingStatus(nextRecording)
          if (nextRecording.sessionId) {
            lastRecordingSessionIdRef.current = nextRecording.sessionId
          }
          if (runtimeRecovery?.kind === 'recording-failed') {
            await publishRecordingFailure(runtimeRecovery.status, runtimeRecovery.activity)
          } else if (runtimeRecovery?.kind === 'microphone-input-lost') {
            await publishMicrophoneInputLost(runtimeRecovery.event)
          }
          lastRecordingStateRef.current = nextRecording.state
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'diagnostics')) {
          setDiagnosticStats(nextDiagnostics)
        }
        commitCaptureRecoveryStatus(nextCaptureRecoveryStatus, generation)
        if (captionsStatusRevisionRef.current === captionsStatusRevisionAtBootstrapStart) {
          commitCaptionsStatus(nextCaptionsStatus)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewLive')) {
          applyPreviewLiveStatus(nextPreview)
        }
        if (bootstrapGuard.isCurrent(bootstrapSnapshot, 'previewSurface')) {
          applyPreviewSurfaceStatus(resolvedPreviewSurface)
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
        let initialLiveChatSnapshot = replayLiveChatBootstrapEvents(
          liveChatBootstrapBase,
          liveChatBootstrapEvents,
          liveChatBootstrapInitialSnapshot
        )
        if (liveChatBootstrapOverflowed)
          initialLiveChatSnapshot = markChatDeliveryIncomplete(initialLiveChatSnapshot)
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
        void publishLiveCommentsSnapshot({
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

        if (accountBootstrapToken && accountSnapshotCoordinator.canCommit(accountBootstrapToken)) {
          setAiCapabilities(nextAiReadiness.capabilities)
          setAiQuota(nextAiReadiness.quota)
          setAiReadinessError(nextAiReadiness.error)
          setAiReadinessLoading(false)
        }
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
      sessionRuntimeEpochRef.current += 1
      focusRefreshCoordinator.invalidate()
      entitlementsRevisionRef.current += 1
      accountSnapshotCoordinator.invalidate()
      accountRefreshInFlightRef.current = null
      sessionListRefreshRequests.clear()
      sessionListMoreSingleFlight.clear()
      sessionListGenerationRef.current += 1
      setSessionsLoadingMore(false)
      sessionDetailRequests.clear()
      sessionDetailSingleFlight.clear()
      sessionDetailLiveEntries.clear()
      cancelCaptionCueRender()
      bootstrapAbort.abort()
      liveChatMessageBatcher.dispose()
      dashboard?.dispose()
      dashboardBacklog.length = 0
      moderation?.dispose()
      stopCohostCommandRelay?.()
      if (chatModerationRef.current === moderation) chatModerationRef.current = null
      moderationBacklog.length = 0
      if (liveChatRecoveryRetryTimer !== null) {
        window.clearTimeout(liveChatRecoveryRetryTimer)
        liveChatRecoveryRetryTimer = null
      }
      platformBootstrapClient.close()
      nativePreviewCompositorPendingRef.current = null
      nativePreviewMainStatusReadSerialRef.current += 1
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
      remoteSurfacePublisher?.detach()
      if (remoteSurfacePublisherRef.current === remoteSurfacePublisher) {
        remoteSurfacePublisherRef.current = null
      }
      setRemoteControlStatus(null)
      nextClient.close()
      setClient(null)
      if (captureRecoveryConnectionGenerationRef.current === generation) {
        captureRecoveryConnectionGenerationRef.current = 0
        captureRecoveryServerRevisionRef.current = -1
        captureRecoveryRetryInFlightRef.current = null
        setCaptureRecoveryStatus(idleCaptureRecoveryStatus())
        setCaptureRecoveryRetryPending(false)
      }
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
    claimPlatformLifecycleOwner,
    clearLiveChatForTerminalSession,
    publishLiveCommentsSnapshot,
    commitActiveScreen,
    commitCohostState,
    commitCaptureRecoveryStatus,
    commitDiagnosticStatsThrottled,
    clearSessionRuntimeState,
    connection,
    nativePreviewSurfaceEnabled,
    publishMicrophoneInputLost,
    publishRecordingFailure,
    queueNativePreviewCompositorPresent,
    resetNativePreviewCompositorTiming,
    publishCommentHighlightState,
    refreshPlatformAccountsForClient,
    replaceSessionRuntimeNotice,
    replaceLiveChatSnapshotState,
    updateLiveChatSnapshot,
    validatePlatformAccountsForClient,
    refreshSessions,
    reportError
  ])

  const loadScene = useCallback(
    async (
      config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'>,
      requestedSources = config.sources
    ) => {
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
      persistWorkingVisual(
        config.layout,
        requestedSources,
        status.scene.background ?? null,
        activeSavedSceneIdRef.current
      )
    },
    [activeSceneBackground, applyCommittedScene, client, wsStatus, persistWorkingVisual]
  )

  const reloadSceneFromCaptureConfig = useCallback(async () => {
    const config = {
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      video: captureConfig.video
    }
    await loadScene(
      runtimeInfo?.previewSmokeMode ? smokePreviewCompositorCaptureConfig(config) : config,
      config.sources
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

  // Persist committed transforms back into the layout so a scene rebuilt from
  // capture config (or the next launch) re-derives them. Freeform writes the
  // whole per-source override map; preset mode keeps the legacy camera-only
  // custom transform (position + free-resize size).
  const syncSourceTransformsToLayout = useCallback(
    (nextScene: Scene, changedSourceId?: string) => {
      if (captureConfigRef.current.layout.arrangementMode === 'freeform') {
        const sourceTransformOverrides: Record<string, CameraTransform> = {}
        for (const source of nextScene.sources) {
          sourceTransformOverrides[source.id] = {
            x: source.transform.x,
            y: source.transform.y,
            width: source.transform.width,
            height: source.transform.height
          }
        }
        const layout = { ...captureConfigRef.current.layout, sourceTransformOverrides }
        patchLayout({ sourceTransformOverrides })
        persistWorkingVisual(
          layout,
          captureConfigRef.current.sources,
          workingBackgroundRef.current,
          activeSavedSceneIdRef.current
        )
        return
      }

      const camera = nextScene.sources.find((source) => source.kind === 'camera')
      if (!camera || (changedSourceId !== undefined && camera.id !== changedSourceId)) {
        return
      }

      const transformPatch = {
        cameraTransformMode: 'custom' as const,
        cameraTransform: {
          x: camera.transform.x,
          y: camera.transform.y,
          width: camera.transform.width,
          height: camera.transform.height
        }
      }
      patchLayout(transformPatch)
      persistWorkingVisual(
        { ...captureConfigRef.current.layout, ...transformPatch },
        captureConfigRef.current.sources,
        workingBackgroundRef.current,
        activeSavedSceneIdRef.current
      )
    },
    [patchLayout, persistWorkingVisual]
  )

  const refreshBackend = useCallback(
    (options?: { fresh?: boolean }): Promise<void> =>
      focusRefreshCoordinatorRef.current[options?.fresh ? 'runFresh' : 'run'](
        async (generationIsCurrent) => {
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
          const finalizationCheckpoint = finalizationJournalRef.current.checkpoint()
          const sessionListRequestToken = sessionListRefreshRequests.begin('first-page')
          sessionListGenerationRef.current += 1
          sessionListMoreSingleFlightRef.current.invalidate('next-page')
          setSessionsLoadingMore(false)
          let accountFailure: { error: unknown } | null = null
          try {
            setLastError(null)
            const [
              nextHealth,
              ,
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
            // Fetch identity after the maintenance batch and through the same
            // Main-owned refresh path as the provider-focus listener. An early
            // account.get snapshot must not land after a newer provider refresh.
            // Identity is best-effort: a failure keeps the current snapshot and
            // must never discard the devices, sessions and accounts fetched
            // above (a live Sources Refresh did nothing but toast, plan 073).
            try {
              const accountCommit = await refreshAccountSnapshotForClient(activeClient)
              if (accountCommit) {
                await refreshAiReadinessForClient(activeClient, accountCommit.snapshot, () =>
                  Boolean(refreshIsCurrent() && accountCommit.isCurrent())
                )
              }
            } catch (error) {
              accountFailure = { error }
            }
            if (!refreshIsCurrent()) {
              return
            }
            const nextStreamMetadataValidation =
              await activeClient.request<StreamMetadataValidation>(
                'streamTargets.metadata.validate',
                nextStreamMetadataDraft
              )
            if (!refreshIsCurrent()) {
              return
            }
            setHealth(nextHealth)
            setDeviceList(nextDevices)
            if (sessionListRefreshRequests.isCurrent('first-page', sessionListRequestToken)) {
              sessionListGenerationRef.current += 1
              setSessions(
                finalizationJournalRef.current.reconcile(nextSessions.items, finalizationCheckpoint)
              )
              setSessionsNextCursor(nextSessions.nextCursor ?? null)
              setSessionStorageTotals(nextSessionStorage)
            }
            setDiagnosticStats(nextDiagnostics)
            setScreens(nextScreens)
            commitActiveScreen(nextActiveScreen)
            setPlatformAccounts(nextPlatformAccounts)
            setOauthProviderCredentials(nextOauthProviderCredentials)
            setPlatformAccountValidations(nextPlatformAccountValidations)
            setStreamMetadataDraft(nextStreamMetadataDraft)
            setStreamMetadataValidation(nextStreamMetadataValidation)
            setNoiseCleanupJobs((current) =>
              nextNoiseCleanupJobs.reduce((jobs, job) => upsertNoiseCleanupJob(jobs, job), current)
            )
            if (accountFailure) {
              reportError(accountFailure.error)
            }
          } catch (error) {
            if (refreshIsCurrent()) {
              reportError(error)
            }
          } finally {
            sessionListRefreshRequests.finish('first-page', sessionListRequestToken)
          }
        }
      ),
    [
      commitActiveScreen,
      refreshAccountSnapshotForClient,
      refreshAiReadinessForClient,
      refreshEntitlementsForClient,
      refreshMediaAccess,
      reportError
    ]
  )

  const refreshEntitlements = useCallback(async (): Promise<void> => {
    if (!client || wsStatusRef.current !== 'connected') {
      return
    }
    await refreshEntitlementsForClient(client)
  }, [client, refreshEntitlementsForClient])

  // Purchases and token expiry must not remain stale. App ready (first connect)
  // covers a cold launch, focus covers return from the Premium browser, and
  // the bounded signed-in timer covers an app left open.
  const accountReadyRefreshRef = useRef<AccountReadyRefreshState>(
    INITIAL_ACCOUNT_READY_REFRESH_STATE
  )
  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      accountReadyRefreshRef.current = reduceAccountReadyRefresh(accountReadyRefreshRef.current, {
        type: 'disconnected'
      }).state
      return
    }
    // The identity snapshot was otherwise frozen at the last interactive
    // sign-in — account.refresh existed backend-side but was never wired,
    // so a web-side avatar/name change never reached the app (owner
    // report, 2026-08-19). Failures keep the current snapshot.
    const refreshAccountSnapshot = (): void => {
      void refreshAccountSnapshotForClient(client)
        .then(async (commit) => {
          if (!commit) return
          await refreshAiReadinessForClient(client, commit.snapshot, commit.isCurrent)
        })
        .catch(() => {
          // Keep the last committed identity on provider/network failure.
        })
    }
    const refreshOnFocus = (): void => {
      void refreshEntitlementsForClient(client).catch(() => {
        // Preserve the current fail-closed snapshot on transport failure.
      })
      if (account?.status === 'signed-in') {
        refreshAccountSnapshot()
      }
    }
    // Cold launch: account.get returns the persisted snapshot, which for a
    // Google-linked account may predate the avatar the web now serves. One
    // refresh per connection, so the snapshot it sets does not re-trigger it.
    const onReady = reduceAccountReadyRefresh(accountReadyRefreshRef.current, {
      type: 'connected',
      client,
      signedIn: account?.status === 'signed-in'
    })
    accountReadyRefreshRef.current = onReady.state
    if (onReady.refresh) {
      refreshAccountSnapshot()
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
  }, [
    account,
    client,
    refreshAccountSnapshotForClient,
    refreshAiReadinessForClient,
    refreshEntitlementsForClient,
    wsStatus
  ])

  // Main defers account maintenance while capture is active. When the session
  // goes idle, replay exactly one deferred refresh so a purchase or avatar
  // change made mid-stream lands now instead of at the next focus or timer.
  const captureActive = isActiveRecordingState(recording.state)
  const accountSignedIn = account?.status === 'signed-in'
  useEffect(() => {
    if (captureActive || !accountSignedIn || !client || wsStatus !== 'connected') return
    if (!accountRefreshDeferredRef.current) return
    const timer = window.setTimeout(() => {
      if (!accountRefreshDeferredRef.current) return
      accountRefreshDeferredRef.current = false
      void refreshAccountSnapshotForClient(client)
        .then(async (commit) => {
          if (!commit) return
          await refreshAiReadinessForClient(client, commit.snapshot, commit.isCurrent)
        })
        .catch(() => {
          // Keep the last committed identity on provider/network failure.
        })
    }, ACCOUNT_REFRESH_IDLE_REPLAY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [
    accountSignedIn,
    captureActive,
    client,
    refreshAccountSnapshotForClient,
    refreshAiReadinessForClient,
    wsStatus
  ])

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
        if (captureConfigRef.current.layout.arrangementMode === 'freeform') {
          // Freeform: the reset value becomes the source's override.
          syncSourceTransformsToLayout(status.scene)
        } else if (
          status.scene.sources.find((source) => source.id === sourceId)?.kind === 'camera'
        ) {
          patchLayout({ cameraTransformMode: 'preset', cameraTransform: null })
        }
      } catch (error) {
        reportError(error)
      }
    },
    [
      applyCommittedScene,
      client,
      patchLayout,
      reportError,
      selectedSceneSourceId,
      syncSourceTransformsToLayout
    ]
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
        syncSourceTransformsToLayout(status.scene, sourceId)
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, syncSourceTransformsToLayout]
  )

  // Precision edits return the authoritative status so a stage draft can stay
  // visible until React has applied this exact commit. BackendClient rejects
  // disconnects/timeouts; failures must never masquerade as acknowledgement.
  const setSceneSourceTransform = useCallback(
    async (
      sourceId: string,
      patch: { x?: number; y?: number; width?: number; height?: number }
    ): Promise<TransformCommitResult> => {
      const requestedScene = transformSceneRef.current
      const requestedLayoutIntentId = layoutIntentIdRef.current
      const identity = transformSourceIdentity(requestedScene)
      const layoutIntent = transformLayoutIntent({ ...captureConfigRef.current.layout })
      const captureIdentity = JSON.stringify({
        sources: captureConfigRef.current.sources,
        video: captureConfigRef.current.video
      })
      setSceneTransformPending(true)
      try {
        return await commitSceneTransform({
          sourceId,
          patch,
          request:
            client && requestedScene?.sources.some((source) => source.id === sourceId)
              ? (params) =>
                  client.request<SceneCommitStatus>('scene.source.transform.update', params)
              : null,
          isCurrent: (status) =>
            clientRef.current === client &&
            layoutIntentIdRef.current === requestedLayoutIntentId &&
            transformSourceIdentity(transformSceneRef.current) === identity &&
            status.scene.id === requestedScene?.id &&
            transformLayoutIntent({ ...captureConfigRef.current.layout }) === layoutIntent &&
            JSON.stringify({
              sources: captureConfigRef.current.sources,
              video: captureConfigRef.current.video
            }) === captureIdentity &&
            (nativePreviewCommittedSceneRef.current?.sceneRevision ?? 0) <= status.sceneRevision,
          apply: applyCommittedScene,
          persist: syncSourceTransformsToLayout,
          reportError
        })
      } finally {
        setSceneTransformPending(false)
      }
    },
    [applyCommittedScene, client, reportError, syncSourceTransformsToLayout]
  )

  // Drafts are preview-tick state owned by the stage's channel: no scene
  // bookkeeping here, and a disconnect rejects so the channel can log it.
  const setSceneEditorDraft = useCallback(
    (params: SceneEditorDraftParams): Promise<SceneEditorDraftAck> =>
      client
        ? client.request<SceneEditorDraftAck>('scene.editor.draft.set', params)
        : Promise.reject(new Error('Backend socket is not connected.')),
    [client]
  )
  const clearSceneEditorDraft = useCallback(
    (): Promise<SceneEditorDraftAck> =>
      client
        ? client.request<SceneEditorDraftAck>('scene.editor.draft.clear')
        : Promise.reject(new Error('Backend socket is not connected.')),
    [client]
  )

  const setSceneSourceVisible = useCallback(
    async (sourceId: string, visible: boolean) => {
      const requestedScene = transformSceneRef.current
      if (!client || !requestedScene?.sources.some((source) => source.id === sourceId)) return
      const requestId = ++sceneVisibilityRequestIdRef.current
      const intentId = layoutIntentIdRef.current
      // The request's own scene.changed echo may arrive before its ACK. Only
      // that source's visibility is allowed to differ; other scene edits retire it.
      const visibilityIdentity = (candidate: Scene | null): string =>
        JSON.stringify(
          candidate && {
            ...candidate,
            sources: candidate.sources.map((source) =>
              source.id === sourceId ? { ...source, visible: undefined } : source
            )
          }
        )
      const identity = visibilityIdentity(requestedScene)
      const layoutIntent = transformLayoutIntent({ ...captureConfigRef.current.layout })
      setSceneVisibilityPending(true)
      try {
        const status = await client.request<SceneCommitStatus>('scene.source.visibility.update', {
          sourceId,
          visible
        })
        if (
          clientRef.current !== client ||
          sceneVisibilityRequestIdRef.current !== requestId ||
          layoutIntentIdRef.current !== intentId ||
          visibilityIdentity(transformSceneRef.current) !== identity ||
          transformLayoutIntent({ ...captureConfigRef.current.layout }) !== layoutIntent ||
          (nativePreviewCommittedSceneRef.current?.sceneRevision ?? 0) > status.sceneRevision
        )
          return
        if (
          !status.applied ||
          visibilityIdentity(status.scene) !== identity ||
          status.scene.sources.find((source) => source.id === sourceId)?.visible !== visible
        ) {
          throw new Error('Source visibility was not acknowledged.')
        }
        applyCommittedScene(status)
        const current = captureConfigRef.current
        const sourceVisibility = sourceVisibilityFromScene(
          status.scene,
          current.layout.sourceVisibility
        )
        const layout = { ...current.layout, sourceVisibility }
        captureConfigRef.current = { ...current, layout }
        patchLayout({ sourceVisibility })
        persistWorkingVisual(
          layout,
          current.sources,
          workingBackgroundRef.current,
          activeSavedSceneIdRef.current
        )
      } catch (error) {
        if (
          clientRef.current === client &&
          sceneVisibilityRequestIdRef.current === requestId &&
          layoutIntentIdRef.current === intentId
        )
          reportError(error)
      } finally {
        if (sceneVisibilityRequestIdRef.current === requestId) setSceneVisibilityPending(false)
      }
    },
    [applyCommittedScene, client, patchLayout, persistWorkingVisual, reportError]
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
        syncSourceTransformsToLayout(status.scene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyCommittedScene, client, reportError, syncSourceTransformsToLayout]
  )

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

      const previewWindowState = await window.videorc?.getPreviewWindowState?.()
      // While the preview is hidden (dialog overlay, minimized, fullscreen,
      // scrolled away) the host benign-skips presents. With no detached preview
      // open, the idle compositor also intentionally has no presentation
      // consumer. In either case, do not wait for a proof that cannot arrive.
      const surfaceCanPresent =
        previewWindowState?.open === true &&
        previewWindowState.visible &&
        previewWindowState.dockHiddenReason == null
      const compositorStatus = sessionActive
        ? await waitForLiveLayoutProof(client, status)
        : idlePreviewLayoutProofRequired({ surfaceCanPresent })
          ? await waitForPreviewLayoutProof(client, status, runtimeInfo?.platform)
          : status.compositorStatus
      if (layoutIntentIdRef.current !== intentId || status.intentId !== intentId) {
        return false
      }
      if (nativePreviewSurfaceEnabled && surfaceCanPresent) {
        const proofOwner = nativePreviewSceneProofPresentationOwner({
          mainPumpActive: mainPumpActiveRef.current,
          statusReaderAvailable: Boolean(window.videorc?.getNativePreviewSurfaceStatus),
          rendererUpdaterAvailable: Boolean(window.videorc?.updateNativePreviewSurfaceCompositor)
        })
        const surfaceStatus =
          proofOwner === 'main-pump'
            ? await waitForNativePreviewSurfaceSceneRevision(
                status.sceneRevision,
                runtimeInfo?.platform ?? 'darwin'
              )
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
          !nativePreviewStatusProvesSceneRevision(
            surfaceStatus,
            status.sceneRevision,
            runtimeInfo?.platform ?? 'darwin'
          )
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
    [applyPreviewSurfaceStatus, client, nativePreviewSurfaceEnabled, runtimeInfo?.platform]
  )

  const applyLayoutTransactionState = useCallback(
    (snapshot: LayoutTransactionSnapshot) => {
      applyScene(snapshot.scene)
      latestRequestedLayoutRef.current = snapshot.layout.layoutPreset
      const background = snapshot.scene.background ?? null
      workingBackgroundRef.current = background
      setWorkingBackground(background)
      const registry = backgroundRegistryRef.current
      const activeSlotId = background
        ? (registry.slots.find(
            (slot) =>
              slot.assetId === background.assetId &&
              slot.status === 'ready' &&
              JSON.stringify(
                snapshotBackground(effectiveSceneBackground({ ...registry, activeSlotId: slot.id }))
              ) === JSON.stringify(snapshotBackground(background))
          )?.id ?? null)
        : null
      if (registry.activeSlotId !== activeSlotId) {
        const nextRegistry = { ...registry, activeSlotId }
        libraryBackgroundFingerprintRef.current = JSON.stringify(
          snapshotBackground(effectiveSceneBackground(nextRegistry))
        )
        setBackgroundRegistry(nextRegistry)
      }
      workingOriginRef.current = snapshot.origin ?? 'builtin'
      const savedId = snapshot.savedSceneId ?? null
      activeSavedSceneIdRef.current = savedId
      setActiveSavedSceneId(savedId)
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
          sources: snapshot.sources ?? current.sources,
          ...layoutPresetMemoryPatch(snapshot.layout.layoutPreset),
          layout: snapshot.layout,
          layoutFramingMemory:
            snapshot.origin === 'saved'
              ? current.layoutFramingMemory
              : rememberLayoutFraming(current.layoutFramingMemory, snapshot.layout)
        }
        captureConfigRef.current = next
        persistWorkingVisual(next.layout, next.sources, background, savedId)
        return next
      })
    },
    [applyScene, persistWorkingVisual, setBackgroundRegistry]
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

    const sources = { ...captureConfigRef.current.sources }
    for (const source of sceneAfter.sources) {
      if (source.kind === 'camera') {
        sources.cameraName =
          sources.cameraId === source.deviceId ? (sources.cameraName ?? source.name) : source.name
        sources.cameraId = source.deviceId
      }
      if (source.kind === 'screen') {
        sources.screenName =
          sources.screenId === source.deviceId ? (sources.screenName ?? source.name) : source.name
        sources.screenId = source.deviceId
        sources.windowId = undefined
        sources.windowName = undefined
        sources.testPattern = false
      }
      if (source.kind === 'window') {
        sources.windowName =
          sources.windowId === source.deviceId ? (sources.windowName ?? source.name) : source.name
        sources.windowId = source.deviceId
        sources.screenId = undefined
        sources.screenName = undefined
        sources.testPattern = false
      }
      if (source.kind === 'test-pattern') {
        sources.screenId = undefined
        sources.windowId = undefined
        sources.testPattern = true
      }
    }
    const visual = normalizeSceneVisual({
      layout: compositorStatus.sceneLayout,
      sources: visualSources(sources),
      background: snapshotBackground(sceneAfter.background)
    })
    const matchesWorking = sameSceneVisual(visual, confirmedVisualRef.current)
    return {
      sources,
      savedSceneId: matchesWorking ? activeSavedSceneIdRef.current : null,
      origin: matchesWorking ? workingOriginRef.current : ('saved' as const),
      sceneRevision: compositorStatus.sceneRevision,
      scene: sceneAfter,
      layout: compositorStatus.sceneLayout,
      compositorStatus
    } satisfies LayoutTransactionSnapshot
  }, [client])

  /**
   * Send the vertical simulcast leg of a RUNNING dual-orientation session,
   * re-derived from `config` (program layout + the leg's own settings) and
   * built exactly like the session-start leg. It is an explicit leg request:
   * the backend commits it to the leg only (no layout intent, the horizontal
   * program is untouched) and refuses it, never redirects it, when no leg is
   * running. Synchronous on purpose: requests go out in call order, so the
   * latest derivation is the one the leg ends on. Returns the request key so
   * a caller can skip sending an identical derivation twice.
   */
  const sendSimulcastLeg = useCallback(
    (config: CaptureConfig, skipIfSameAs: string | null = null): string | null => {
      if (
        !client ||
        wsStatus !== 'connected' ||
        !isActiveRecordingState(recordingRef.current.state)
      ) {
        return null
      }
      const request = simulcastLegLiveRequest(config)
      if (!request) {
        return null
      }
      const key = JSON.stringify(request)
      if (key === skipIfSameAs) {
        return key
      }
      client
        .requestTyped('scene.layout.apply_live', {
          ...request,
          // Echoed back, never registered: the leg must not supersede a
          // horizontal intent that is still in flight.
          intentId: Math.max(1, layoutIntentIdRef.current)
        })
        .catch((error: unknown) => {
          // A request that raced Stop is refused by design; only a failure
          // while the session is still running is news.
          if (isActiveRecordingState(recordingRef.current.state)) {
            reportError(error)
          }
        })
      return key
    },
    [client, reportError, wsStatus]
  )

  const applySimulcastLeg = useCallback(
    (patch: SimulcastLegPatch): void => {
      // Written to the ref synchronously (and again in the updater) so a
      // program commit landing before React re-renders re-derives the leg
      // from THESE settings, not the ones they replace.
      const next = { ...captureConfigRef.current, ...patch }
      captureConfigRef.current = next
      setCaptureConfig((current) => {
        const updated = { ...current, ...patch }
        captureConfigRef.current = updated
        return updated
      })
      sendSimulcastLeg(next)
    },
    [sendSimulcastLeg]
  )

  const requestLayoutTransaction = useCallback(
    (
      layout: LayoutSettings,
      options?: {
        pendingIndicator?: boolean
        videoOverride?: VideoSettings
        captureConfigPatch?: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'>
        sourcesOverride?: SourceSelection
        backgroundOverride?: Scene['background'] | null
        strictSources?: boolean
        savedSceneId?: string | null
        origin?: 'builtin' | 'saved'
      }
    ): Promise<boolean> => {
      const sessionActive = isActiveRecordingState(recordingRef.current.state)
      if (
        sessionActive &&
        layoutPresetOrientation(layout.layoutPreset) !==
          layoutPresetOrientation(captureConfigRef.current.layout.layoutPreset)
      ) {
        toast.error('Stop the recording or stream before switching orientation.', {
          id: 'scene-orientation-lock'
        })
        return Promise.resolve(false)
      }
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected. Layout unchanged.')
        return Promise.resolve(false)
      }

      if (layoutShortcutTimerRef.current) clearTimeout(layoutShortcutTimerRef.current)
      latestRequestedLayoutRef.current = layout.layoutPreset
      const intentId = Math.max(layoutIntentIdRef.current + 1, Date.now())
      layoutIntentIdRef.current = intentId
      layoutIntentAwaitingProofRef.current = intentId
      setVisualTransactionPending(true)
      setSavedScenePendingId(options?.savedSceneId ?? null)
      // Background-only commits keep the same preset; flashing the layout
      // controls into "Switching…" for them reads as an unrelated change.
      if (options?.pendingIndicator !== false) {
        setLayoutSwitchPending(layout.layoutPreset)
      }

      let commitReceiptSettled = false
      let resolveCommitReceipt: (committed: boolean) => void = () => undefined
      const commitReceipt = new Promise<boolean>((resolve) => {
        resolveCommitReceipt = resolve
      })
      const settleCommitReceipt = (committed: boolean): void => {
        if (commitReceiptSettled) return
        commitReceiptSettled = true
        resolveCommitReceipt(committed)
      }

      void (async () => {
        let requestedSceneEvidence: LayoutTransactionSceneEvidence | null = null
        let sceneRevisionBeforeRequest: number | undefined
        let sceneRequestDispatched = false
        try {
          const protectedOverlayWindowIds = await currentProtectedOverlayWindowIds()
          const requestedConfig = captureConfigRef.current
          const requestedSources =
            options?.sourcesOverride ??
            reconcileSourceSelectionForLayoutTransaction(
              requestedConfig.sources,
              deviceListRef.current.devices
            )
          const requestedBackground =
            options && 'backgroundOverride' in options
              ? (options.backgroundOverride ?? undefined)
              : (workingBackgroundRef.current ?? undefined)
          if (options?.strictSources) {
            const freshDevices = await client.request<DeviceList>('devices.list')
            const issues = sceneSourceProblems(
              {
                layout,
                sources: visualSources(requestedSources),
                background: snapshotBackground(requestedBackground)
              },
              freshDevices.devices
            )
            if (issues.length) throw new Error(issues.join(' '))
            if (
              requestedBackground &&
              !(await window.videorc?.backgroundAssetExists?.(requestedBackground.assetId))
            )
              throw new Error(
                'Saved background unavailable. Resolve it or apply without background.'
              )
          }
          if (
            !options?.strictSources &&
            JSON.stringify(requestedSources) !== JSON.stringify(requestedConfig.sources)
          ) {
            recordAutomaticSourceFallbacks(requestedConfig.sources, requestedSources)
            setCaptureConfig((current) =>
              JSON.stringify(current.sources) === JSON.stringify(requestedConfig.sources)
                ? { ...current, sources: requestedSources }
                : current
            )
          }
          const method = sessionActive ? 'scene.layout.apply_live' : 'scene.layout.apply_preview'
          const requestedTransaction = {
            intentId,
            sources: requestedSources,
            layout,
            // Orientation and canvas commit to React only after backend proof.
            // Until then the ref intentionally remains on the previous program
            // state, so the transaction carries its target canvas explicitly.
            video: options?.videoOverride ?? requestedConfig.video,
            background: requestedBackground,
            protectedOverlayWindowIds,
            // Scene motion (opt-in): the committed layout glides into place
            // (320ms ease) in preview, stream, and recording alike. Absent =
            // instant cut.
            ...(settingsRef.current.animateSceneChanges === true
              ? { transitionMs: SCENE_TRANSITION_MS }
              : {})
          }
          requestedSceneEvidence = requestedLayoutTransactionScene(requestedTransaction)
          const baselineCompositorStatus = await client
            .requestTyped('compositor.status')
            .catch(() => null)
          sceneRevisionBeforeRequest =
            typeof baselineCompositorStatus?.sceneRevision === 'number'
              ? baselineCompositorStatus.sceneRevision
              : undefined
          sceneRequestDispatched = true
          const status: LayoutTransactionStatus = await client.requestTyped(
            method,
            requestedTransaction
          )
          const committedSnapshot: LayoutTransactionSnapshot = {
            sceneRevision: status.sceneRevision,
            scene: status.scene,
            layout: status.compositorStatus.sceneLayout ?? layout,
            compositorStatus: status.compositorStatus,
            captureConfigPatch: options?.captureConfigPatch,
            sources: requestedSources,
            savedSceneId:
              options && 'savedSceneId' in options
                ? options.savedSceneId
                : activeSavedSceneIdRef.current,
            origin: options?.origin ?? workingOriginRef.current
          }
          // This is the remote-control acknowledgement edge: the backend has
          // returned an authoritative commit. Presentation proof and React
          // reconciliation continue below, but a bounded deck ack must not
          // consume their additional preview/readback budget.
          settleCommitReceipt(true)
          // Dual-orientation: the vertical leg is DERIVED from the program
          // layout (its twin scene when following, the shared camera
          // settings) plus the leg's own settings, so every committed program
          // change re-derives it. Always from the committed layout, never by
          // comparing against a pre-commit snapshot that a faster click may
          // already have made stale. Idempotent on the backend.
          const programAfterCommit = {
            ...captureConfigRef.current,
            sources: requestedSources,
            layout: committedSnapshot.layout
          }
          const legSentAtCommit = sessionActive ? sendSimulcastLeg(programAfterCommit) : null
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
          if (sessionActive) {
            // A leg edit made while this commit waited for proof was derived
            // from the pre-commit program; re-derive once, if anything moved.
            sendSimulcastLeg(
              {
                ...captureConfigRef.current,
                sources: requestedSources,
                layout: committedSnapshot.layout
              },
              legSentAtCommit
            )
          }
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
              notifyOnce(
                'layout-preview-proof-lag',
                'warning',
                'Preview verification lagged behind the layout change',
                {
                  description:
                    'The layout was applied and the output is unaffected. If the preview looks stale, close and reopen it.'
                }
              )
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
          if (!sceneRequestDispatched) {
            if (layoutIntentIdRef.current === intentId) reportError(error)
            settleCommitReceipt(false)
            return
          }
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
            const failurePolicy = await loadCommandFailurePolicy()
            const failureDisposition = layoutTransactionFailureDisposition({
              failureCode: failurePolicy.failureCode(error),
              sceneRevisionBeforeRequest,
              requestedScene: requestedSceneEvidence,
              backendTruth: backendTruth
                ? {
                    sceneRevision: backendTruth.sceneRevision,
                    scene: backendLayoutTransactionScene(backendTruth)
                  }
                : null
            })
            const backendTruthForReconciliation =
              failureDisposition === 'requested-scene-applied' && backendTruth
                ? {
                    ...backendTruth,
                    captureConfigPatch: options?.captureConfigPatch,
                    sources: options?.sourcesOverride ?? captureConfigRef.current.sources,
                    savedSceneId:
                      options && 'savedSceneId' in options
                        ? options.savedSceneId
                        : activeSavedSceneIdRef.current,
                    origin: options?.origin ?? workingOriginRef.current
                  }
                : backendTruth
            const reconciliation = layoutTransactionFailureReconciliation({
              latestIntentId: layoutIntentIdRef.current,
              failedIntentId: intentId,
              backendTruth: backendTruthForReconciliation,
              latestCommit: latestLayoutTransactionCommitRef.current
            })
            if (reconciliation) {
              rememberLayoutTransactionSnapshot(reconciliation.snapshot)
              applyLayoutTransactionState(reconciliation.snapshot)
              settleCommitReceipt(failureDisposition === 'requested-scene-applied')
              if (failureDisposition !== 'requested-scene-applied') {
                reportError(error)
              }
              return
            } else if (layoutIntentIdRef.current === intentId) {
              reportError(error)
            }
          }
          settleCommitReceipt(false)
        } finally {
          settleCommitReceipt(false)
          if (layoutIntentAwaitingProofRef.current === intentId) {
            layoutIntentAwaitingProofRef.current = null
          }
          if (layoutIntentIdRef.current === intentId) {
            setLayoutSwitchPending(null)
            setSavedScenePendingId(null)
            setVisualTransactionPending(false)
          }
        }
      })().catch((error) => {
        settleCommitReceipt(false)
        reportError(error)
      })
      return commitReceipt
    },
    [
      applyLayoutTransactionState,
      client,
      readLayoutTransactionBackendTruth,
      recordAutomaticSourceFallbacks,
      rememberLayoutCommit,
      rememberLayoutTransactionSnapshot,
      reportError,
      sendSimulcastLeg,
      wsStatus
    ]
  )

  // Library edits request a new working background. Only the committed target
  // drives preview/session parameters; applying a saved snapshot never edits the library.
  useEffect(() => {
    const fingerprint = JSON.stringify(snapshotBackground(desiredLibraryBackground))
    if (fingerprint === libraryBackgroundFingerprintRef.current) return
    libraryBackgroundFingerprintRef.current = fingerprint
    void requestLayoutTransaction(captureConfigRef.current.layout, {
      pendingIndicator: false,
      backgroundOverride: desiredLibraryBackground
    })
  }, [desiredLibraryBackground, requestLayoutTransaction])

  const applyLayoutPatch = useCallback(
    (patch: Partial<LayoutSettings>) => {
      void requestLayoutTransaction({
        ...captureConfigRef.current.layout,
        ...patch
      })
    },
    [requestLayoutTransaction]
  )

  const requestCameraPresetTransaction = useCallback(
    (patch: Partial<LayoutSettings>) => {
      const current = captureConfigRef.current
      const nextPreset = patch.layoutPreset ?? current.layout.layoutPreset
      if (patch.layoutPreset !== undefined) {
        const issues = sceneSourceProblems(
          {
            layout: { ...current.layout, layoutPreset: nextPreset, arrangementMode: 'preset' },
            sources: visualSources(current.sources),
            background: null
          },
          deviceListRef.current.devices
        )
        if (issues.length) {
          toast.error(issues.join(' '), { id: 'layout-source-unavailable' })
          return Promise.resolve(false)
        }
      }

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

      // Choosing a preset scene EXITS freeform (unless the patch says
      // otherwise): the preset's fixed arrangement is what the user asked
      // for, and stale overrides must not leak into a later freeform entry.
      const arrangementPatch =
        patch.layoutPreset !== undefined && patch.arrangementMode === undefined
          ? { arrangementMode: 'preset' as const, sourceTransformOverrides: {} }
          : {}

      return requestLayoutTransaction(
        {
          ...current.layout,
          ...(patch.layoutPreset !== undefined && workingOriginRef.current === 'saved'
            ? current.layoutFramingMemory.layouts[nextPreset]
            : recalledLayoutFraming(
                current.layoutFramingMemory,
                current.layout.layoutPreset,
                nextPreset
              )),
          ...arrangementPatch,
          ...patch,
          cameraTransformMode: 'preset',
          cameraTransform: null
        },
        {
          videoOverride,
          captureConfigPatch,
          ...(patch.layoutPreset !== undefined
            ? { savedSceneId: null, origin: 'builtin' as const }
            : {})
        }
      )
    },
    [requestLayoutTransaction]
  )

  const applyBackgroundSlot = useCallback(
    (slotId: string | null): void => {
      const registry = backgroundRegistryRef.current
      const background = slotId
        ? effectiveSceneBackground({ ...registry, activeSlotId: slotId })
        : null
      void requestLayoutTransaction(captureConfigRef.current.layout, {
        pendingIndicator: false,
        backgroundOverride: background
      })
    },
    [requestLayoutTransaction]
  )

  const applyWorkingBackgroundStyle = useCallback(
    (patch: Partial<Scene['background']>): void => {
      const current = workingBackgroundRef.current
      if (!current) return
      const background = resolveSavedBackground({ ...snapshotBackground(current)!, ...patch })
      void requestLayoutTransaction(captureConfigRef.current.layout, {
        pendingIndicator: false,
        backgroundOverride: background
      })
    },
    [requestLayoutTransaction]
  )

  const workingVisual: SceneVisual = useMemo(
    () =>
      normalizeSceneVisual({
        layout: captureConfig.layout,
        sources: visualSources(captureConfig.sources),
        background: snapshotBackground(workingBackground)
      }),
    [captureConfig.layout, captureConfig.sources, workingBackground]
  )
  const savedSceneModified = Boolean(
    activeSavedSceneId &&
    sceneLibrary.scenes.some(
      (entry) => entry.id === activeSavedSceneId && !sameSceneVisual(entry.visual, workingVisual)
    )
  )
  const canSaveScene =
    !sceneLibrary.readOnly &&
    !visualTransactionPending &&
    layoutSwitchPending === null &&
    savedScenePendingId === null &&
    sourceDeviceSwitchPending === null &&
    !sceneGesturePending &&
    !sceneTransformPending &&
    !sceneVisibilityPending &&
    wsStatus === 'connected' &&
    scene !== null &&
    sameSceneVisual(workingVisual, confirmedVisualRef.current)
  const saveScene = useCallback(
    (name: string, updateId?: string): boolean => {
      if (!canSaveScene || layoutIntentAwaitingProofRef.current !== null) return false
      const id = saveSceneEntry(name, workingVisual, updateId)
      if (!id) return false
      activeSavedSceneIdRef.current = id
      workingOriginRef.current = 'saved'
      setActiveSavedSceneId(id)
      persistWorkingVisual(
        captureConfigRef.current.layout,
        captureConfigRef.current.sources,
        workingBackgroundRef.current,
        id
      )
      return true
    },
    [canSaveScene, saveSceneEntry, workingVisual, persistWorkingVisual]
  )
  const deleteSavedScene = useCallback(
    (id: string): boolean => {
      if (!removeSceneEntry(id)) return false
      if (activeSavedSceneIdRef.current === id) {
        activeSavedSceneIdRef.current = null
        setActiveSavedSceneId(null)
        persistWorkingVisual(
          captureConfigRef.current.layout,
          captureConfigRef.current.sources,
          workingBackgroundRef.current,
          null
        )
      }
      return true
    },
    [removeSceneEntry, persistWorkingVisual]
  )
  const applySavedScene = useCallback(
    async (id: string, repaired?: SceneVisual): Promise<boolean> => {
      const saved = sceneLibrary.scenes.find((entry) => entry.id === id)
      if (!saved) return false
      const visual = normalizeSceneVisual(repaired ?? saved.visual)
      const current = captureConfigRef.current
      const coupling = !isActiveRecordingState(recordingRef.current.state)
        ? verticalOrientationVideoPatch(
            current.layout.layoutPreset,
            visual.layout.layoutPreset,
            current.video,
            current.verticalRestoreVideo
          )
        : null
      return requestLayoutTransaction(visual.layout, {
        sourcesOverride: { ...current.sources, ...visual.sources },
        backgroundOverride: resolveSavedBackground(visual.background),
        savedSceneId: id,
        origin: 'saved',
        strictSources: true,
        ...(coupling
          ? {
              videoOverride: coupling.video,
              captureConfigPatch: {
                video: coupling.video,
                verticalRestoreVideo: coupling.verticalRestoreVideo
              }
            }
          : {})
      })
    },
    [sceneLibrary.scenes, requestLayoutTransaction]
  )

  const applyCameraPreset = useCallback(
    (patch: Partial<LayoutSettings>) => {
      void requestCameraPresetTransaction(patch)
    },
    [requestCameraPresetTransaction]
  )

  const switchSourceDeviceLive = useCallback(
    async (sourceKind: LiveSourceDeviceSwitchPending, sources: SourceSelection) => {
      const blocked = sourceSwitchReason(sourceKind)
      if (blocked) {
        toast.error(blocked)
        return
      }
      if (!isActiveRecordingState(recordingRef.current.state)) {
        // Pickers build `sources` from a render-time snapshot; merge only the
        // picked kind so a concurrent confirmation or reconcile is not undone.
        setCaptureConfig((current) => ({
          ...current,
          sources: mergeSourceKind(current.sources, sources, sourceKind)
        }))
        if (sceneEditMode && sourceKind !== 'microphone') {
          await loadScene({
            sources: mergeSourceKind(captureConfigRef.current.sources, sources, sourceKind),
            layout: captureConfigRef.current.layout,
            video: captureConfigRef.current.video
          }).catch(reportError)
        }
        return
      }
      const deviceId =
        sourceKind === 'camera'
          ? sources.cameraId
          : sourceKind === 'microphone'
            ? sources.microphoneId
            : (sources.screenId ?? sources.windowId)
      if (sourceKind === 'camera') {
        // Plan 080 S4: the backend confirms only the device; the Off intent
        // is renderer state, so it must be recorded here to outlive the
        // session's end (reconcile would otherwise fill in the first camera).
        setCaptureConfig((current) =>
          current.sources.cameraOff === sources.cameraOff
            ? current
            : { ...current, sources: { ...current.sources, cameraOff: sources.cameraOff } }
        )
      }
      try {
        await sourceSelectionController.select(
          sourceKind,
          deviceId ?? null,
          currentProtectedOverlayWindowIds(),
          sourceKind === 'camera'
            ? sources.cameraName
            : sourceKind === 'microphone'
              ? sources.microphoneName
              : (sources.screenName ?? sources.windowName)
        )
      } catch (error) {
        reportError(error)
      }
    },
    [sourceSelectionController, sourceSwitchReason, loadScene, reportError, sceneEditMode]
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
          let backendStatus: PreviewSurfaceStatus
          try {
            backendStatus = surfaceAlreadyCreated
              ? await client.request<PreviewSurfaceStatus>('preview.surface.update_bounds', {
                  bounds: nextBounds
                })
              : await client.request<PreviewSurfaceStatus>('preview.surface.create', {
                  bounds: nextBounds,
                  targetFps: 60,
                  source: surfaceSource
                })
          } catch (error) {
            // Background bounds sync is latest-wins maintenance. A busy
            // surface, a full lane, or an outcome-unknown timeout is
            // retryable: restore the pending bounds so the periodic window
            // reconciler re-drives them, and stay silent — the 2026-08-27
            // live incident surfaced exactly these as alarming error toasts
            // mid-stream while the backend healed itself. Anything else is a
            // real failure and still propagates to reportError.
            if (isRetryableBackgroundSurfaceSyncError(error)) {
              if (
                generationIsCurrent(nextGeneration) &&
                nativePreviewSurfaceBoundsPendingRef.current === null
              ) {
                nativePreviewSurfaceBoundsPendingRef.current = nextBounds
                nativePreviewSurfaceBoundsPendingGenerationRef.current = nextGeneration
              }
              // Stay inside the single-flight loop: a window event may never
              // arrive to re-drive a stale-bounds retry, so pace and go again.
              // Generation checks end the loop naturally when the surface is
              // torn down or replaced.
              await new Promise((resolveRetry) => setTimeout(resolveRetry, 1500))
              continue
            }
            throw error
          }
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
    dockSlot: null,
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

  // Frame polling serves only the Electron proof surface. It is redundant
  // during a recording when the platform's canonical native presenter owns
  // pixels. A closed window always suppresses polling — UI rewrite U2.
  const syncFramePollingSuppression = useCallback(() => {
    if (
      !nativePreviewSurfaceEnabled ||
      !window.videorc?.setNativePreviewSurfaceFramePollingSuppressed
    ) {
      return
    }
    const recordingActive = isActiveRecordingState(recordingRef.current.state)
    const generation = previewWindowRef.current.supervisor.generation
    const suppress = nativePreviewFramePollingShouldSuppress({
      recordingActive,
      windowOpen: previewWindowRef.current.open,
      platform: runtimeInfo?.platform ?? 'darwin',
      generation,
      status: previewSurfaceStatusRef.current
    })
    const requestKey = nativePreviewFramePollingRequestKey({
      generation,
      suppress,
      recordingActive
    })
    if (nativePreviewFramePollingRequestKeyRef.current === requestKey) {
      return
    }
    nativePreviewFramePollingRequestKeyRef.current = requestKey
    void window.videorc
      .setNativePreviewSurfaceFramePollingSuppressed(suppress, generation, recordingActive)
      .then((status) => {
        if (
          nativePreviewFramePollingResponseCanCommit({
            requestKey,
            currentRequestKey: nativePreviewFramePollingRequestKeyRef.current,
            requestGeneration: generation,
            currentGeneration: previewWindowRef.current.supervisor.generation
          })
        ) {
          applyPreviewSurfaceStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (nativePreviewFramePollingRequestKeyRef.current === requestKey) {
          nativePreviewFramePollingRequestKeyRef.current = null
        }
        console.error('Native preview frame-polling suppression failed:', error)
      })
  }, [applyPreviewSurfaceStatus, nativePreviewSurfaceEnabled, runtimeInfo?.platform])

  syncFramePollingSuppressionRef.current = syncFramePollingSuppression

  // Closing the preview window must cost nothing: tear the surface session down
  // (helper window, proof window, backend session) instead of merely hiding it.
  const teardownDetachedPreviewSurface = useCallback(
    async (generation?: number) => {
      const generationIsCurrent = (): boolean =>
        generation === undefined || previewWindowRef.current.supervisor.generation === generation
      nativePreviewSurfaceCreatedRef.current = false
      nativePreviewSurfaceLastSyncedBoundsRef.current = null
      nativePreviewSurfaceBoundsPendingRef.current = null
      nativePreviewSurfaceBoundsPendingGenerationRef.current = undefined
      try {
        const hostStatus = window.videorc?.applyNativePreviewHostCommands
          ? await window.videorc.applyNativePreviewHostCommands([{ kind: 'destroy' }], generation)
          : null
        const backendStatus =
          generationIsCurrent() && clientRef.current && wsStatusRef.current === 'connected'
            ? await clientRef.current.request<PreviewSurfaceStatus>('preview.surface.destroy')
            : null
        if (!generationIsCurrent()) {
          return
        }
        const status =
          backendStatus && hostStatus
            ? mergePreviewSurfaceHostStatus(backendStatus, hostStatus)
            : (backendStatus ?? hostStatus)
        if (status) {
          applyPreviewSurfaceStatus(status)
        }
      } catch (error) {
        console.error('Detached preview surface teardown failed:', error)
      }
    },
    [applyPreviewSurfaceStatus]
  )

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
      notifyOnce('notes-closed-for-recording', 'warning', 'Notes closed for this recording', {
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
      notifyOnce('chat-closed-for-recording', 'warning', 'Chat closed for this recording', {
        description:
          'Chat window protection is unavailable and recording overlay capture is disabled by VIDEORC_COMMENTS_RECORDING_OVERLAY=0.'
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
      compositorStatus,
      { linuxCpuProof: runtimeInfo?.platform === 'linux' }
    )
    if (
      !compositorStatusCanDriveProofScene(renderedStatus, revision, {
        linuxCpuProof: runtimeInfo?.platform === 'linux'
      })
    ) {
      return
    }
    const proofOwner = nativePreviewSceneProofPresentationOwner({
      mainPumpActive: mainPumpActiveRef.current,
      statusReaderAvailable: Boolean(window.videorc?.getNativePreviewSurfaceStatus),
      rendererUpdaterAvailable: Boolean(window.videorc?.updateNativePreviewSurfaceCompositor)
    })
    if (proofOwner === 'main-pump') {
      const status = await waitForNativePreviewSurfaceSceneRevision(
        revision,
        runtimeInfo?.platform ?? 'darwin'
      )
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
  }, [
    applyPreviewSurfaceStatus,
    client,
    nativePreviewSurfaceEnabled,
    runtimeInfo?.platform,
    wsStatus
  ])

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
      // Re-read runtime info at export time: backend crash records are
      // appended by main while the app runs, and the startup snapshot would
      // otherwise ship a bundle that predates the crash it is meant to explain.
      const freshRuntimeInfo =
        (await window.videorc?.getRuntimeInfo?.().catch(() => null)) ?? runtimeInfo
      const params: SupportBundleExportParams = {
        // S2 (plan 024): the backend only knows its crate version (stuck at
        // 0.9.0); forward the real Electron app version so the bundle
        // identifies the shipped build. Absent → backend degrades to crate.
        appVersion: freshRuntimeInfo?.version,
        rendererDiagnostics: {
          automaticSourceFallbacks: automaticSourceFallbacks.current,
          nativePreviewSurfaceStatus: previewSurfaceStatus,
          runtimeInfo: freshRuntimeInfo ?? undefined
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
  }, [client, previewSurfaceStatus, reportError, runtimeInfo, supportBundleExportPending])

  const scheduleHardwareAccelerationRetry = useCallback(async () => {
    if (!window.videorc?.retryHardwareAcceleration) {
      toast.error('Graphics recovery is unavailable outside Electron.')
      return
    }

    try {
      const nextRuntimeInfo = await window.videorc.retryHardwareAcceleration()
      setRuntimeInfo(nextRuntimeInfo)
      toast.success('Hardware acceleration retry scheduled.', {
        description: 'Quit and reopen Videorc when you are ready. This launch stays unchanged.'
      })
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      // F-011: this used to be a silent no-op — the button appeared dead.
      toast.error('Microphone check', {
        description: 'Backend is not connected. Try again in a moment.'
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

  const [warmMicrophone, setWarmMicrophone] = useState<WarmMicrophoneStatus | null>(null)
  const armWarmMicrophone = useCallback(async () => {
    const activeClient = clientRef.current
    if (!activeClient) return null
    const config = captureConfigRef.current
    try {
      const status = await activeClient.request<WarmMicrophoneStatus>('audio.mic.arm', {
        microphoneId: config.sources.microphoneId,
        microphoneGainDb: config.audio.microphoneGainDb,
        microphoneMuted: config.audio.microphoneMuted
      })
      if (clientRef.current === activeClient) setWarmMicrophone(status)
      return status
    } catch {
      // A cold open at Record is the fallback; never surface this.
      return null
    }
  }, [])
  const disarmWarmMicrophone = useCallback(async () => {
    const activeClient = clientRef.current
    if (!activeClient) return null
    try {
      const status = await activeClient.request<WarmMicrophoneStatus>('audio.mic.disarm', {})
      if (clientRef.current === activeClient) setWarmMicrophone(status)
      return status
    } catch {
      return null
    }
  }, [])

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
    ? resolvedStreamingProfileEntitlementGate(captureConfig, entitlements)
    : { allowed: true as const }
  const isSessionActive =
    isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending
  const mixingSessionActive =
    ['recording', 'streaming'].includes(recording.state) && Boolean(recording.sessionId)
  const systemAudioConfirmed = mixingSessionActive
    ? confirmedSystemAudioMix(recording.audioTracks)
    : null
  const systemAudioIssue =
    mixingSessionActive &&
    systemAudioIssueEvent &&
    systemAudioIssueEvent.sessionId === recording.sessionId
      ? systemAudioIssueEvent.issue
      : null
  // Plan 069 S6: what the shortcut and the remotes act on — the device status
  // and the state the switch shows (the confirmed mix, else the request).
  const systemAudioStatus = deviceList.devices.find(
    (device) => device.kind === 'system-audio'
  )?.status
  // With an issue the switch stays as the user set it, so a toggle turns it
  // Off (PR #477 review).
  const systemAudioShown =
    (systemAudioIssue ? null : systemAudioConfirmed) ?? captureConfig.audio.systemAudioEnabled
  // A shortcut or remote request is sent even when it repeats the last one:
  // the retry after a failed start or a lost update.
  const setSystemAudioEnabled = (systemAudioEnabled: boolean): void => {
    if (liveAudioProcessingSyncRef.current)
      liveAudioProcessingSyncRef.current.systemAudioSent = null
    retrySystemAudio((count) => count + 1)
    setCaptureConfig((current) => ({
      ...current,
      audio: { ...current.audio, systemAudioEnabled }
    }))
  }
  // Plan 076: Resume after the echo guard paused System audio, from its
  // toast or a mixer row (lazy chunks), re-sends On like a shortcut does.
  const resumeSystemAudio = useEffectEvent(() => setSystemAudioEnabled(true))
  useEffect(() => {
    const resume = (): void => resumeSystemAudio()
    window.addEventListener('videorc:resume-system-audio', resume)
    return () => window.removeEventListener('videorc:resume-system-audio', resume)
  }, [])

  const currentStreamOutputTopology =
    useMemo((): GoLiveOutput.StreamOutputTopologyRequest | null => {
      if (!captureConfig.streamEnabled) {
        return null
      }
      if (rejectedStreamOutputSplitKeys.size > 0 && goLiveOutputChunk) {
        return goLiveOutputChunk.resolveStreamOutputTopologyRequest(
          captureConfig,
          captureConfig.streaming,
          suppressCaptionsForSession,
          rejectedStreamOutputSplitKeys
        )
      }
      return {
        params: buildStreamOutputTopologyProbeParams(
          captureConfig,
          captureConfig.streaming,
          suppressCaptionsForSession
        ),
        sharedFallbackVideo: null
      }
    }, [captureConfig, rejectedStreamOutputSplitKeys, suppressCaptionsForSession])
  const currentStreamOutputTopologyRequest = currentStreamOutputTopology?.params ?? null
  const streamSharedEncodeFallbackVideo = currentStreamOutputTopology?.sharedFallbackVideo ?? null
  const currentStreamOutputTopologyRequestKey = currentStreamOutputTopologyRequest
    ? streamOutputTopologyProbeRequestKey(currentStreamOutputTopologyRequest)
    : null

  const probeStreamOutputTopology = useCallback(
    (
      params: StreamOutputTopologyProbeParams,
      options: { force?: boolean } = {}
    ): Promise<StreamOutputTopologyProbeResult> => {
      if (!client || wsStatus !== 'connected') {
        return Promise.reject(new Error('Backend socket is not connected.'))
      }

      const requestKey = streamOutputTopologyProbeRequestKey(params)
      const current = streamOutputTopologyPreflightRef.current
      if (!options.force && current.state === 'ready' && current.requestKey === requestKey) {
        return Promise.resolve(current.result)
      }
      const currentFlight = streamOutputTopologyProbeInFlightRef.current
      if (
        !options.force &&
        currentFlight?.client === client &&
        currentFlight.requestKey === requestKey
      ) {
        return currentFlight.promise
      }

      streamOutputTopologyProbeGenerationRef.current += 1
      const generation = streamOutputTopologyProbeGenerationRef.current
      currentFlight?.controller.abort()
      const controller = new AbortController()
      commitStreamOutputTopologyPreflight({ state: 'pending', requestKey })

      const promise = client
        .requestTyped('stream.output.topology.probe', params, {
          signal: controller.signal
        })
        .then(async (result) => {
          if (!streamOutputTopologyResultMatchesRequest(result, params)) {
            throw new Error(
              'Backend returned a livestream output verdict for a different output configuration.'
            )
          }
          const splitRejected = streamOutputTopologySplitRejected(result)
          if (splitRejected) {
            // The re-plan reads the Go Live chunk; load it before the
            // rejection reaches the topology memo.
            await loadGoLiveOutput()
          }
          if (
            clientRef.current === client &&
            splitRejected &&
            !rejectedStreamOutputSplitKeysRef.current.has(requestKey)
          ) {
            // Committed with the verdict below (one render), so a rejected
            // split re-plans as a shared encode without flashing a blocker.
            commitRejectedStreamOutputSplitKeys(
              new Set(rejectedStreamOutputSplitKeysRef.current).add(requestKey)
            )
          }
          if (
            streamOutputTopologyProbeGenerationRef.current === generation &&
            clientRef.current === client
          ) {
            commitStreamOutputTopologyPreflight({ state: 'ready', requestKey, result })
          }
          return result
        })
        .catch((error: unknown) => {
          if (
            streamOutputTopologyProbeGenerationRef.current === generation &&
            clientRef.current === client &&
            !(error instanceof Error && error.name === 'AbortError')
          ) {
            commitStreamOutputTopologyPreflight({
              state: 'failed',
              requestKey,
              message:
                error instanceof Error
                  ? error.message
                  : 'The livestream output path could not be verified.'
            })
          }
          throw error
        })
        .finally(() => {
          if (streamOutputTopologyProbeGenerationRef.current === generation) {
            streamOutputTopologyProbeInFlightRef.current = null
          }
        })
      streamOutputTopologyProbeInFlightRef.current = {
        client,
        requestKey,
        controller,
        promise
      }
      return promise
    },
    [client, commitRejectedStreamOutputSplitKeys, commitStreamOutputTopologyPreflight, wsStatus]
  )

  // Go Live waits for the output check instead of refusing while it runs,
  // takes the shared-encode fallback when the host rejects the split, and
  // steps a software-encoded stream down to what this computer measurably
  // holds. The logic lives in a chunk loaded on the first Go Live, so the
  // startup bundle does not carry it.
  const settleStreamOutputTopology = useCallback(
    async (streaming: StreamingSettings): Promise<GoLiveOutput.GoLiveSessionOutput> => {
      const { settleGoLiveSessionOutput } = await loadGoLiveOutput()
      return settleGoLiveSessionOutput({
        captureConfig,
        streaming,
        suppressCaptionsForSession,
        performanceCheck,
        rejectedSplitKeys: () => rejectedStreamOutputSplitKeysRef.current,
        noteRejectedSplit: (requestKey) => {
          if (!rejectedStreamOutputSplitKeysRef.current.has(requestKey)) {
            commitRejectedStreamOutputSplitKeys(
              new Set(rejectedStreamOutputSplitKeysRef.current).add(requestKey)
            )
          }
        },
        isSavedRequest: (requestKey) => {
          const slot = streamOutputTopologyPreflightRef.current
          return (
            requestKey === currentStreamOutputTopologyRequestKey ||
            (slot.state !== 'not-requested' && slot.requestKey === requestKey) ||
            streamOutputTopologyProbeInFlightRef.current?.requestKey === requestKey
          )
        },
        probeSaved: probeStreamOutputTopology,
        sessionResults: streamOutputTopologySessionResultsRef.current,
        request: (params) => {
          if (!client || wsStatus !== 'connected') {
            return Promise.reject(new Error('Backend socket is not connected.'))
          }
          return client.requestTyped('stream.output.topology.probe', params)
        }
      })
    },
    [
      captureConfig,
      client,
      commitRejectedStreamOutputSplitKeys,
      currentStreamOutputTopologyRequestKey,
      performanceCheck,
      probeStreamOutputTopology,
      suppressCaptionsForSession,
      wsStatus
    ]
  )

  useEffect(() => {
    if (
      !currentStreamOutputTopologyRequest ||
      !client ||
      wsStatus !== 'connected' ||
      !health?.ffmpeg.available
    ) {
      streamOutputTopologyProbeGenerationRef.current += 1
      streamOutputTopologyProbeInFlightRef.current?.controller.abort()
      streamOutputTopologyProbeInFlightRef.current = null
      // A reconnect may be a different backend build: ask again.
      streamOutputTopologySessionResultsRef.current.clear()
      if (streamOutputTopologyPreflightRef.current.state !== 'not-requested') {
        commitStreamOutputTopologyPreflight({ state: 'not-requested' })
      }
      return
    }
    if (isSessionActive) {
      return
    }
    void probeStreamOutputTopology(currentStreamOutputTopologyRequest).catch(() => {})
  }, [
    client,
    commitStreamOutputTopologyPreflight,
    currentStreamOutputTopologyRequest,
    health?.ffmpeg.available,
    isSessionActive,
    probeStreamOutputTopology,
    wsStatus
  ])

  useEffect(
    () => () => {
      streamOutputTopologyProbeGenerationRef.current += 1
      streamOutputTopologyProbeInFlightRef.current?.controller.abort()
      streamOutputTopologyProbeInFlightRef.current = null
    },
    []
  )

  const refreshStreamOutputTopology = useCallback(async () => {
    if (!currentStreamOutputTopologyRequest) {
      throw new Error('Enable livestreaming before checking the output path.')
    }
    // Retry re-asks for the separate role from scratch; a rejection is not
    // remembered past an explicit re-check.
    commitRejectedStreamOutputSplitKeys(new Set())
    streamOutputTopologySessionResultsRef.current.clear()
    await probeStreamOutputTopology(
      buildStreamOutputTopologyProbeParams(
        captureConfig,
        captureConfig.streaming,
        suppressCaptionsForSession
      ),
      { force: true }
    )
  }, [
    captureConfig,
    commitRejectedStreamOutputSplitKeys,
    currentStreamOutputTopologyRequest,
    probeStreamOutputTopology,
    suppressCaptionsForSession
  ])

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
      failLiveMicrophoneWaiters()
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
      if (sync) {
        failLiveMicrophoneWaiters(sync.sessionId)
      }
      sync?.queue.stop()
      const startSnapshot = liveAudioProcessingStartSnapshotRef.current
      const syncDecision = liveAudioProcessingSessionSyncDecision(params, startSnapshot)
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
            failLiveMicrophoneWaiters(requested.sessionId)
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
            latest.authoritative = true
            commitLiveAudioProcessingApplied({
              sessionId: requested.sessionId,
              ...latest.lastApplied
            })
            settleLiveMicrophoneWaiters(
              requested.sessionId,
              latest.lastApplied.microphoneMuted,
              !queue.hasOutstandingWork
            )
            return true
          }
          // Not applied: send the system audio fields again (PR #477 review).
          latest.systemAudioSent = null
          if (validResult?.reasonCode === 'session-ended') {
            failLiveMicrophoneWaiters(requested.sessionId)
            return false
          }

          const rejection = rejectedLiveAudioProcessingUpdate({
            recording: recordingRef.current,
            current: captureConfigRef.current.audio,
            requested,
            result: validResult,
            lastApplied: latest.lastApplied
          })
          if (!rejection) {
            settleLiveMicrophoneWaiters(
              requested.sessionId,
              latest.lastApplied.microphoneMuted,
              !queue.hasOutstandingWork
            )
            return true
          }

          latest.disabled = rejection.disableForSession
          const rollbackAuthoritative =
            latest.authoritative ||
            (typeof validResult?.confirmedMicrophoneGainDb === 'number' &&
              typeof validResult.confirmedMicrophoneMuted === 'boolean')
          latest.lastApplied = rejection.rollback
          latest.authoritative = rollbackAuthoritative
          if (rollbackAuthoritative) {
            commitLiveAudioProcessingApplied({
              sessionId: requested.sessionId,
              ...rejection.rollback
            })
          }
          if (
            !rollbackAuthoritative ||
            !validResult ||
            validResult.reasonCode === 'live-audio-control-state-unknown'
          ) {
            failLiveMicrophoneWaiters(requested.sessionId)
          } else {
            settleLiveMicrophoneWaiters(
              requested.sessionId,
              rejection.rollback.microphoneMuted,
              rejection.disableForSession || !queue.hasOutstandingWork
            )
          }
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
        systemAudioSent:
          startSnapshot?.sessionId === params.sessionId
            ? (startSnapshot.systemAudio ?? null)
            : null,
        authoritative: startSnapshot?.sessionId === params.sessionId,
        disabled: false,
        queue
      }
      sync = nextSync
      liveAudioProcessingSyncRef.current = nextSync
      if (startSnapshot?.sessionId === params.sessionId) {
        commitLiveAudioProcessingApplied({
          sessionId: params.sessionId,
          ...syncDecision.lastApplied
        })
        settleLiveMicrophoneWaiters(
          params.sessionId,
          syncDecision.lastApplied.microphoneMuted,
          false
        )
      }
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

    // System audio rides the same latest-wins queue, carrying only the fields
    // this session does not already hold (plan 069): a mic edit never re-sends
    // the switch, and a switch flip never needs a mic change.
    // The deps below hold the same values; the ref only avoids a dep on the
    // whole audio object.
    const systemAudio = captureConfigRef.current.audio
    const systemAudioDelta = systemAudioProcessingDelta(systemAudio, sync.systemAudioSent)
    const systemAudioChanged = Object.keys(systemAudioDelta).length > 0
    const desiredMatchesLastApplied =
      params.microphoneGainDb === sync.lastApplied.microphoneGainDb &&
      params.microphoneMuted === sync.lastApplied.microphoneMuted
    if (
      !enqueueDesiredForNewSync &&
      !sync.queue.hasOutstandingWork &&
      desiredMatchesLastApplied &&
      !systemAudioChanged
    ) {
      return
    }

    // A new switch state supersedes the last issue (PR #477 review).
    if (systemAudioDelta.systemAudioEnabled !== undefined) setSystemAudioIssueEvent(null)
    sync.systemAudioSent = systemAudio
    sync.queue.enqueue({ ...params, ...systemAudioDelta })
  }, [
    client,
    recording.sessionId,
    recording.state,
    captureConfig.audio.microphoneGainDb,
    captureConfig.audio.microphoneMuted,
    captureConfig.audio.systemAudioEnabled,
    captureConfig.audio.systemAudioGainDb,
    captureConfig.audio.systemAudioEchoGuard,
    systemAudioRetry,
    commitLiveAudioProcessingApplied,
    failLiveMicrophoneWaiters,
    reportError,
    runtimeInfo?.windowsLiveAudioSmokeMode,
    startRequestPending,
    stopRequestPending,
    settleLiveMicrophoneWaiters,
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

  // Consent is the USER'S durable intent: no code path may revoke it. An
  // earlier effect here silently flipped the toggle off whenever cloud AI
  // readiness was not ready, so every cloud feature quietly did nothing with
  // no visible reason (2026-07-16 owner incident: the server had never been
  // configured, and the app never said so). Readiness gates what runs and the
  // switch's enabled state, never the stored consent.

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
    const { renderCaptionOverlayPng } = await loadCaptionOverlay()
    for (const output of work.outputs) {
      const pngBase64 = await renderCaptionOverlayPng({
        text: work.text,
        canvasWidth: output.canvasWidth,
        canvasHeight: output.canvasHeight,
        textSize: work.textSize,
        styleId: work.styleId,
        maxBarWidthPx: output.rect ? Math.floor(output.rect.w * output.canvasWidth) : undefined
      })
      if (!pngBase64 || work.epoch !== captionOverlayEpochRef.current) return
      await work.client.request('captions.overlay.set', {
        pngBase64,
        position: work.position,
        ...(output.rect ? { rect: output.rect } : {}),
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
      streamVideo,
      verticalLeg: simulcastLegLiveRequest(captureConfig)?.video,
      captionsLayout: overlayLayout.captions
    })
    const candidateKey = latest
      ? outputs
          .map(
            (output) =>
              captionOverlayKey(latest, {
                styleId: captureConfig.captions.styleId,
                styleRevision: captureConfig.captions.styleRevision,
                position: captureConfig.captions.position,
                textSize: captureConfig.captions.textSize,
                canvasWidth: output.canvasWidth,
                canvasHeight: output.canvasHeight,
                outputLeg: output.target
              }) + (output.rect ? `@${JSON.stringify(output.rect)}` : '')
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
        canvasHeight: output.canvasHeight,
        ...(output.rect ? { rect: output.rect } : {})
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
    captureConfig.streaming,
    overlayLayout.captions
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
    async (screenId: string): Promise<boolean> => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return false
      }

      try {
        setLastError(null)
        const screen = await client.request<StreamScreen>('screens.activate', { screenId })
        commitActiveScreen(screen)
        return true
      } catch (error) {
        const failurePolicy = await loadCommandFailurePolicy()
        if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') {
          reportError(error)
          return false
        }
        const authoritative = await client
          .request<StreamScreen | null>('screens.active', undefined, { timeoutMs: 2_000 })
          .catch(() => undefined)
        if (authoritative !== undefined) {
          commitActiveScreen(authoritative)
        }
        if (failurePolicy.screenActivateFailureCanReconcile(error, screenId, authoritative)) {
          return true
        }
        reportError(error)
        return false
      }
    },
    [client, commitActiveScreen, reportError]
  )

  const clearActiveScreen = useCallback(async (): Promise<boolean> => {
    if (!client) {
      toast.error('Backend socket is not connected.')
      return false
    }

    try {
      setLastError(null)
      await client.request<StreamScreen | null>('screens.clear')
      commitActiveScreen(null)
      return true
    } catch (error) {
      const failurePolicy = await loadCommandFailurePolicy()
      if (failurePolicy.failureCode(error) !== 'request-outcome-unknown') {
        reportError(error)
        return false
      }
      const authoritative = await client
        .request<StreamScreen | null>('screens.active', undefined, { timeoutMs: 2_000 })
        .catch(() => undefined)
      if (authoritative !== undefined) {
        commitActiveScreen(authoritative)
      }
      if (failurePolicy.screenClearFailureCanReconcile(error, authoritative)) {
        return true
      }
      reportError(error)
      return false
    }
  }, [client, commitActiveScreen, reportError])

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
    async (platform: PlatformAccount['platform'], options?: PlatformConnectOptions) => {
      if (oauthUnavailableReason(platform)) {
        // Silent: the destination card renders the unavailable reason inline
        // right next to the control that triggers this, so the toast only
        // duplicated visible copy (owner request 2026-08-14).
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
        // A pass-through: callers send `platformConnectOptions(platform)` or,
        // from a permission row, `permissionReconnectOptions(platform)`
        // (shared/platform-scopes, kept out of this eager bundle), and the
        // backend keeps any optional scope the account already holds.
        // Plan 140, S5.
        const optionalScopes = options?.optionalScopes?.length
          ? { optionalScopes: [...options.optionalScopes] }
          : {}
        const params = redirectUri
          ? { platform, redirectUri, ...optionalScopes }
          : { platform, ...optionalScopes }
        const result = await client.request<OAuthStartResult>(
          'platformAccounts.oauth.startProvider',
          params
        )
        await window.videorc.openOAuthUrl(result.authUrl)
        // Auto-open uses the DEFAULT browser, which is often NOT the browser
        // the user is signed into the platform with. Keep the link copyable so
        // it can be pasted into the right one. Stays until dismissed: device
        // authorizations (Twitch) can take a while, and a 4-second toast is
        // gone long before the user has switched browsers and signed in.
        // Callback-URL registration hints live in docs/distribution.md — they
        // are developer-portal instructions, not something an end user can act
        // on, so the toast stays quiet.
        toast.success('Approve the connection in your browser', {
          id: 'oauth-authorization-link',
          description: 'Signed in on a different browser? Copy the link and open it there instead.',
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: 'Copy link',
            onClick: () => {
              void navigator.clipboard
                .writeText(result.authUrl)
                .then(() => toast.success('Authorization link copied.'))
                .catch(() => toast.error('Could not copy the link.'))
            }
          }
        })
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
    const coordinator = accountSnapshotCoordinatorRef.current
    const mutation = coordinator.beginMutation()
    accountRefreshInFlightRef.current = null
    try {
      const nextAccount = await signOut()
      if (!coordinator.canCommit(mutation)) return
      setAccount(nextAccount)
      coordinator.finishMutation(mutation)
      if (client && wsStatus === 'connected') {
        await Promise.all([
          refreshAiReadinessForClient(client, nextAccount, () =>
            Boolean(coordinator.isCurrent(mutation) && clientRef.current === client)
          ),
          refreshEntitlementsForClient(client)
        ])
      }
    } catch (error) {
      reportError(error)
    } finally {
      coordinator.finishMutation(mutation)
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
      const coordinator = accountSnapshotCoordinatorRef.current
      const mutation = coordinator.beginMutation()
      accountRefreshInFlightRef.current = null
      try {
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
        if (!coordinator.canCommit(mutation)) return 'complete'
        setAccount(nextAccount)
        coordinator.finishMutation(mutation)
        try {
          await Promise.all([
            refreshAiReadinessForClient(client, nextAccount, () =>
              Boolean(coordinator.isCurrent(mutation) && clientRef.current === client)
            ),
            refreshEntitlementsForClient(client)
          ])
        } catch (error) {
          reportError(error)
        }
        return 'complete'
      } finally {
        coordinator.finishMutation(mutation)
      }
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
      notifyOnce(
        'account-callback-retry',
        'error',
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
        notifyOnce(
          'account-callback-retry',
          'error',
          'Account sign-in is temporarily unavailable. Videorc will retry.'
        )
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
      // Plan 094 (S3): the same id as the callback results, so this updates
      // the one connect toast instead of adding a final one.
      void loadSessionRuntimeRecovery().then((runtime) => runtime.showOAuthCallbackExhausted())
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
        notifyOnce(
          'oauth-callback-retry',
          'error',
          'OAuth completion is temporarily unavailable. Videorc will retry.'
        )
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
    // Only a finished verdict blocks here. A check that is still running or
    // failed is settled when Go Live is pressed: the start waits for it.
    if (
      captureConfig.streamEnabled &&
      currentStreamOutputTopologyRequestKey &&
      streamOutputTopologyPreflight.state === 'ready'
    ) {
      const topologyReason = streamOutputTopologyBlockReason(
        streamOutputTopologyPreflight,
        currentStreamOutputTopologyRequestKey
      )
      if (topologyReason) {
        return topologyReason
      }
    }

    return null
  })()

  const activatePreparedYouTubeBroadcasts = useCallback(
    async (streamingForStart: StreamingSettings, runId: number, sessionId?: string) => {
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
          for (let attempt = 0; !target.scheduledEventId && attempt < 8; attempt += 1) {
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
            if (platformLifecycleRun.current !== runId) {
              return
            }
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

          if (!target.scheduledEventId && !lastStatus?.active) {
            throw new Error(lastStatus?.message ?? 'YouTube ingest did not become active yet.')
          }
          if (platformLifecycleRun.current !== runId) {
            return
          }

          const transitionRequest = (
            target.scheduledEventId
              ? import('@/lib/scheduled-streams').then(({ scheduledTargetOperation }) =>
                  scheduledTargetOperation<YouTubeBroadcastTransitionResult>(
                    client,
                    'activate',
                    target.scheduledEventId!,
                    { attemptId: target.scheduledAttemptId, sessionId }
                  )
                )
              : client.request<YouTubeBroadcastTransitionResult>(
                  'streamTargets.youtube.transition',
                  {
                    accountId: target.accountId,
                    broadcastId,
                    status: 'live'
                  }
                )
          ).then((result) => {
            assertYouTubeTransitionConfirmed(result, 'live')
            return result
          })
          const mutationEntry = sessionId
            ? {
                sessionId,
                promise: transitionRequest.then(
                  () => streamingForStart,
                  () => streamingForStart
                )
              }
            : null
          if (mutationEntry) {
            platformLifecycleMutationRef.current = mutationEntry
          }
          try {
            await transitionRequest
          } finally {
            if (platformLifecycleMutationRef.current === mutationEntry) {
              platformLifecycleMutationRef.current = null
            }
          }
          if (platformLifecycleRun.current !== runId) {
            return
          }
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
          if (platformLifecycleRun.current !== runId) {
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          // Plan 094: on quota the broadcast still goes live by itself
          // (enableAutoStart) once ingest arrives; say so instead of "review".
          const quotaPaused = isYouTubeQuotaPausedError(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: quotaPaused ? message : `YouTube go-live needs review: ${message}`
                }
              })
            })
          )
          ;(await loadSessionRuntimeRecovery()).showYouTubeBroadcastToast('start', target, message)
        }
      }
    },
    [client]
  )

  const activatePreparedXBroadcasts = useCallback(
    async (
      streamingForStart: StreamingSettings,
      runId: number,
      sessionId?: string
    ): Promise<StreamingSettings> => {
      if (!client) {
        return streamingForStart
      }

      const xTargets = preparedXActivationTargets(streamingForStart)
      let nextStreaming = streamingForStart

      for (const target of xTargets) {
        const sourceId = target.platformStreamId
        const region = target.platformBroadcastId
        if (!sourceId || !region) {
          continue
        }
        if (platformLifecycleRun.current !== runId) {
          return nextStreaming
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
          // from the stream metadata draft — never hardcoded here. A saved
          // broadcast goes live through its own schedule instead of a fresh
          // create+publish pair.
          const publishRequest = target.scheduledEventId
            ? import('@/lib/scheduled-streams').then(({ scheduledTargetOperation }) =>
                scheduledTargetOperation<XPublishResult>(
                  client,
                  'activate',
                  target.scheduledEventId!,
                  { attemptId: target.scheduledAttemptId, sessionId }
                )
              )
            : client.request<XPublishResult>('streamTargets.x.publish', {
                accountId: target.accountId,
                sourceId,
                region,
                isLowLatency: true,
                sessionId
              })
          const publishedStreamingPromise = publishRequest.then((result) =>
            patchPreparedStreamTarget(nextStreaming, target.id, {
              accountId: result.accountId,
              platformBroadcastId: result.broadcastId,
              platformStreamId: result.mediaKey,
              status: {
                state: 'live',
                message: result.tweetError
                  ? `X broadcast is live, but the announcement post failed: ${result.tweetError}`
                  : `X broadcast is live: ${result.shareUrl}`,
                redactedUrl: result.shareUrl,
                ...(result.tweetError ? { lastError: result.tweetError } : {})
              }
            })
          )
          const mutationEntry = sessionId
            ? {
                sessionId,
                promise: publishedStreamingPromise.then(
                  (streaming) => streaming,
                  () => nextStreaming
                )
              }
            : null
          if (mutationEntry) {
            platformLifecycleMutationRef.current = mutationEntry
          }
          let result: XPublishResult
          try {
            result = await publishRequest
            nextStreaming = await publishedStreamingPromise
          } finally {
            if (platformLifecycleMutationRef.current === mutationEntry) {
              platformLifecycleMutationRef.current = null
            }
          }

          const publishedBroadcastEndKey = JSON.stringify([result.accountId, result.broadcastId])
          xEndInFlightByBroadcastRef.current.delete(publishedBroadcastEndKey)
          xEndedBroadcastResultsRef.current.delete(publishedBroadcastEndKey)
          const publishedStatus: StreamTargetStatus = {
            state: 'live',
            message: result.tweetError
              ? `X broadcast is live, but the announcement post failed: ${result.tweetError}`
              : `X broadcast is live: ${result.shareUrl}`,
            redactedUrl: result.shareUrl,
            ...(result.tweetError ? { lastError: result.tweetError } : {})
          }
          if (sessionId && platformLifecycleOwnerRef.current?.sessionId === sessionId) {
            platformLifecycleOwnerRef.current = {
              sessionId,
              streaming: nextStreaming
            }
          }

          if (platformLifecycleRun.current !== runId) {
            return nextStreaming
          }

          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                accountId: result.accountId,
                platformBroadcastId: result.broadcastId,
                platformStreamId: result.mediaKey,
                status: publishedStatus
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
              toast.warning(`X chat needs review for ${target.label}.`, {
                description: chatMessage
              })
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'warning',
              message: `X go-live needs review: ${message}`
            }
          })
          if (platformLifecycleRun.current !== runId) {
            return nextStreaming
          }
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
      return nextStreaming
    },
    [client]
  )

  const endXBroadcastOnce = useCallback(
    (
      target: StreamTargetSettings,
      broadcastId: string,
      sessionId?: string
    ): Promise<XEndResult> => {
      if (!client) {
        return Promise.reject(new Error('Backend socket is not connected.'))
      }
      const endKey = JSON.stringify([target.accountId ?? '', broadcastId])
      const completed = xEndedBroadcastResultsRef.current.get(endKey)
      if (completed) {
        return Promise.resolve(completed)
      }
      const pending = xEndInFlightByBroadcastRef.current.get(endKey)
      if (pending?.client === client) {
        return pending.promise
      }

      const promise = client.request<XEndResult>('streamTargets.x.end', {
        accountId: target.accountId,
        broadcastId,
        sessionId
      })
      const entry = { client, promise }
      xEndInFlightByBroadcastRef.current.set(endKey, entry)
      void promise.then(
        (result) => {
          if (xEndInFlightByBroadcastRef.current.get(endKey) !== entry) {
            return
          }
          xEndInFlightByBroadcastRef.current.delete(endKey)
          xEndedBroadcastResultsRef.current.set(endKey, result)
          if (xEndedBroadcastResultsRef.current.size > 128) {
            const oldestKey = xEndedBroadcastResultsRef.current.keys().next().value
            if (oldestKey) {
              xEndedBroadcastResultsRef.current.delete(oldestKey)
            }
          }
        },
        () => {
          if (xEndInFlightByBroadcastRef.current.get(endKey) === entry) {
            xEndInFlightByBroadcastRef.current.delete(endKey)
          }
        }
      )
      return promise
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
          const endRequest = endXBroadcastOnce(target, broadcastId, sessionId)
          // Never hold capture settlement hostage to a slow END. Keep the
          // underlying single-flight request registered, but bound every
          // caller's wait and retain the exact owner for a later retry.
          const result = timeoutMs
            ? await new Promise<XEndResult>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('x-end-timeout')), timeoutMs)
                void endRequest.then(
                  (value) => {
                    clearTimeout(timeout)
                    resolve(value)
                  },
                  (error) => {
                    clearTimeout(timeout)
                    reject(error)
                  }
                )
              })
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
            // Leave the target cleanup-eligible. The exact owner is retained
            // and a later settlement can rejoin the same request for a bounded
            // interval without issuing a duplicate END.
            continue
          }
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'warning',
              message: `X cleanup needs review: ${message}`,
              ...(target.status?.redactedUrl ? { redactedUrl: target.status.redactedUrl } : {})
            }
          })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `X cleanup needs review: ${message}`,
                  ...(target.status?.redactedUrl ? { redactedUrl: target.status.redactedUrl } : {})
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
    [client, endXBroadcastOnce]
  )

  const completeYouTubeBroadcastOnce = useCallback(
    (
      target: StreamTargetSettings,
      broadcastId: string
    ): Promise<YouTubeBroadcastTransitionResult> => {
      if (!client) {
        return Promise.reject(new Error('Backend socket is not connected.'))
      }
      const completionKey = JSON.stringify([target.accountId ?? '', broadcastId])
      const completed = youtubeCompletedBroadcastResultsRef.current.get(completionKey)
      if (completed) {
        return Promise.resolve(completed)
      }
      const pending = youtubeCompletionInFlightByBroadcastRef.current.get(completionKey)
      if (pending?.client === client) {
        return pending.promise
      }

      const promise = client
        .request<YouTubeBroadcastTransitionResult>('streamTargets.youtube.transition', {
          accountId: target.accountId,
          broadcastId,
          status: 'complete'
        })
        .then((result) => {
          assertYouTubeTransitionConfirmed(result, 'complete')
          return result
        })
      const entry = { client, promise }
      youtubeCompletionInFlightByBroadcastRef.current.set(completionKey, entry)
      void promise.then(
        (result) => {
          if (youtubeCompletionInFlightByBroadcastRef.current.get(completionKey) !== entry) {
            return
          }
          youtubeCompletionInFlightByBroadcastRef.current.delete(completionKey)
          youtubeCompletedBroadcastResultsRef.current.set(completionKey, result)
          if (youtubeCompletedBroadcastResultsRef.current.size > 128) {
            const oldestKey = youtubeCompletedBroadcastResultsRef.current.keys().next().value
            if (oldestKey) {
              youtubeCompletedBroadcastResultsRef.current.delete(oldestKey)
            }
          }
        },
        () => {
          if (youtubeCompletionInFlightByBroadcastRef.current.get(completionKey) === entry) {
            youtubeCompletionInFlightByBroadcastRef.current.delete(completionKey)
          }
        }
      )
      return promise
    },
    [client]
  )

  const completePreparedPlatformBroadcasts = useCallback(
    async (
      streamingForCleanup: StreamingSettings,
      sessionId?: string,
      options?: { skipXCleanup?: boolean; xTimeoutMs?: number }
    ): Promise<PlatformBroadcastCleanupResult> => {
      if (!client) {
        return { streaming: streamingForCleanup, complete: false }
      }

      let nextStreaming = streamingForCleanup
      let complete = true
      const youtubeTargets = preparedYouTubeCompletionTargets(streamingForCleanup)
      for (const target of youtubeTargets) {
        const broadcastId = target.platformBroadcastId
        if (!broadcastId) {
          continue
        }
        try {
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'connecting',
              message: 'Completing YouTube broadcast.'
            }
          })
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
          const scheduledResult = target.scheduledEventId
            ? await (
                await import('@/lib/scheduled-streams')
              ).scheduledTargetOperation<YouTubeBroadcastTransitionResult>(
                client,
                'releasePreparation',
                target.scheduledEventId,
                {
                  attemptId: target.scheduledAttemptId,
                  sessionId:
                    sessionId && !isPreparedPlatformLifecycleOwner(sessionId)
                      ? sessionId
                      : undefined
                }
              )
            : await completeYouTubeBroadcastOnce(target, broadcastId)
          const completionMessage =
            target.scheduledEventId && scheduledResult.lifecycleStatus === 'ready'
              ? 'Upcoming event preserved.'
              : 'YouTube broadcast ended.'
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'stopped',
              message: completionMessage
            }
          })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'stopped',
                  message: completionMessage
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Plan 094 (bug 1): a `complete` refused on quota, or for a broadcast
          // that no longer exists, is settled. YouTube ends the broadcast on
          // its own (enableAutoStop); retaining it would block every later
          // Record and Go Live until the reset. Network and 5xx keep the
          // retain-and-retry path.
          const settled = isSettledYouTubeCompletionError(error)
          if (!settled) {
            complete = false
          }
          const status = settled
            ? { state: 'stopped' as const, message }
            : { state: 'warning' as const, message: `YouTube cleanup needs review: ${message}` }
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, { status })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, { status })
            })
          )
          ;(await loadSessionRuntimeRecovery()).showYouTubeBroadcastToast('end', target, message)
        }
      }

      if (!options?.skipXCleanup) {
        nextStreaming = await endPreparedXBroadcasts(
          nextStreaming,
          sessionId,
          options?.xTimeoutMs ?? PLATFORM_CLEANUP_X_END_TIMEOUT_MS
        )
      }
      if (preparedXCompletionTargets(nextStreaming).length > 0) {
        complete = false
      }
      // Saved X broadcasts release their preparation exactly once. The
      // scheduler module does it, so it loads only after such a session.
      if (
        nextStreaming.targets.some((target) => target.platform === 'x' && target.scheduledEventId)
      ) {
        const scheduled = await import('@/lib/scheduled-streams')
        const released = await scheduled.releaseScheduledXPreparations(
          client,
          nextStreaming,
          sessionId && !isPreparedPlatformLifecycleOwner(sessionId) ? sessionId : undefined
        )
        const settled = released.streaming
        nextStreaming = settled
        if (!released.complete) complete = false
        setCaptureConfig((current) =>
          bridgeStreamingToLegacy({
            ...current,
            streaming: scheduled.settleScheduledXTargets(current.streaming, settled)
          })
        )
      }
      return { streaming: nextStreaming, complete }
    },
    [client, completeYouTubeBroadcastOnce, endPreparedXBroadcasts]
  )
  const retainPlatformLifecycleOwner = useCallback((owner: PlatformLifecycleOwner) => {
    if (isPreparedPlatformLifecycleOwner(owner.sessionId)) {
      const retained = preparedPlatformLifecycleOwnersRef.current
      const existingIndex = retained.findIndex(
        (candidate) => candidate.sessionId === owner.sessionId
      )
      if (existingIndex >= 0) {
        retained[existingIndex] = owner
      } else {
        retained.push(owner)
      }
      return
    }
    if (
      !platformLifecycleOwnerRef.current ||
      platformLifecycleOwnerRef.current.sessionId === owner.sessionId
    ) {
      platformLifecycleOwnerRef.current = owner
    }
  }, [])
  const createPreparedPlatformLifecycleOwner = useCallback(
    (streaming: StreamingSettings): PlatformLifecycleOwner => {
      preparedPlatformLifecycleOwnerSequenceRef.current += 1
      return {
        sessionId: `${PREPARED_PLATFORM_LIFECYCLE_OWNER_PREFIX}${preparedPlatformLifecycleOwnerSequenceRef.current}`,
        streaming
      }
    },
    []
  )
  const settleClaimedPlatformLifecycleOwner = useCallback(
    (
      owner: PlatformLifecycleOwner,
      task?: (owner: PlatformLifecycleOwner) => Promise<PlatformBroadcastCleanupResult>
    ): Promise<PlatformBroadcastCleanupResult> => {
      const pending = platformLifecycleSettlementRef.current
      if (pending?.sessionId === owner.sessionId) {
        return pending.promise
      }
      if (pending) {
        return Promise.reject(new Error('Another livestream provider lifecycle is still settling.'))
      }

      let resolvedOwner = owner
      const settlement = {} as PlatformLifecycleSettlement
      const promise = (async (): Promise<PlatformBroadcastCleanupResult> => {
        try {
          const mutation = platformLifecycleMutationRef.current
          if (mutation?.sessionId === owner.sessionId) {
            resolvedOwner = {
              sessionId: owner.sessionId,
              streaming: await mutation.promise
            }
          }
          const result = task
            ? await task(resolvedOwner)
            : await completePreparedPlatformBroadcasts(
                resolvedOwner.streaming,
                isPreparedPlatformLifecycleOwner(resolvedOwner.sessionId)
                  ? undefined
                  : resolvedOwner.sessionId
              )
          if (!result.complete) {
            retainPlatformLifecycleOwner({
              sessionId: owner.sessionId,
              streaming: result.streaming
            })
          }
          return result
        } catch (error) {
          retainPlatformLifecycleOwner(resolvedOwner)
          throw error
        } finally {
          if (platformLifecycleSettlementRef.current === settlement) {
            platformLifecycleSettlementRef.current = null
          }
        }
      })()
      settlement.sessionId = owner.sessionId
      settlement.promise = promise
      platformLifecycleSettlementRef.current = settlement
      return promise
    },
    [completePreparedPlatformBroadcasts, retainPlatformLifecycleOwner]
  )
  settleClaimedPlatformLifecycleOwnerRef.current = settleClaimedPlatformLifecycleOwner

  const settleRetainedPreparedPlatformLifecycles = useCallback(async (): Promise<boolean> => {
    const pending = platformLifecycleSettlementRef.current
    if (pending) {
      try {
        await pending.promise
      } catch (error) {
        reportError(error)
      }
    }

    while (preparedPlatformLifecycleOwnersRef.current.length > 0) {
      const retainedOwner = preparedPlatformLifecycleOwnersRef.current.shift()
      if (!retainedOwner) {
        break
      }
      try {
        const result = await settleClaimedPlatformLifecycleOwner(retainedOwner)
        if (!result.complete) {
          reportError(
            new Error('Finish cleaning up the prepared livestream providers before starting again.')
          )
          return false
        }
      } catch (error) {
        reportError(error)
        return false
      }
    }
    return true
  }, [reportError, settleClaimedPlatformLifecycleOwner])

  const settlePreparedPlatformLifecycle = useCallback(
    async (streaming: StreamingSettings): Promise<PlatformBroadcastCleanupResult> => {
      const owner = createPreparedPlatformLifecycleOwner(streaming)
      if (!(await settleRetainedPreparedPlatformLifecycles())) {
        retainPlatformLifecycleOwner(owner)
        return { streaming, complete: false }
      }
      try {
        return await settleClaimedPlatformLifecycleOwner(owner)
      } catch (error) {
        reportError(error)
        return { streaming, complete: false }
      }
    },
    [
      createPreparedPlatformLifecycleOwner,
      reportError,
      retainPlatformLifecycleOwner,
      settleClaimedPlatformLifecycleOwner,
      settleRetainedPreparedPlatformLifecycles
    ]
  )

  const settlePreviousPlatformLifecycle = useCallback(async (): Promise<boolean> => {
    if (!(await settleRetainedPreparedPlatformLifecycles())) {
      return false
    }
    const previousOwner = platformLifecycleOwnerRef.current
    if (!previousOwner) {
      return true
    }
    const claimedOwner = claimPlatformLifecycleOwner(previousOwner.sessionId)
    if (!claimedOwner) {
      return false
    }
    try {
      const result = await settleClaimedPlatformLifecycleOwner(claimedOwner)
      if (result.complete) {
        return true
      }
      reportError(
        new Error('Finish cleaning up the previous livestream providers before starting again.')
      )
      return false
    } catch (error) {
      reportError(error)
      return false
    }
  }, [
    claimPlatformLifecycleOwner,
    reportError,
    settleClaimedPlatformLifecycleOwner,
    settleRetainedPreparedPlatformLifecycles
  ])

  const preparedGoLiveOutputRef = useRef<GoLiveOutput.GoLiveSessionOutput | null>(null)
  const runStartSessionRef = useRef<
    | ((
        streamingOverride?: StreamingSettings,
        preparedOutput?: GoLiveOutput.GoLiveSessionOutput | null
      ) => Promise<boolean>)
    | null
  >(null)
  const runStartSession = useCallback(
    (
      streamingOverride?: StreamingSettings,
      preparedOutput?: GoLiveOutput.GoLiveSessionOutput | null
    ) => {
      recordLatencyTrackerRef.current.markClick('start', performance.now(), 'session-call')
      const requestSnapshot = {
        captureConfig,
        sceneWithBackground,
        sceneEditMode,
        settings,
        streamingOverride,
        suppressCaptionsForSession
      }
      const pendingStart = sessionStartInFlightRef.current
      if (pendingStart) {
        const sameRequest =
          pendingStart.captureConfig === requestSnapshot.captureConfig &&
          pendingStart.sceneWithBackground === requestSnapshot.sceneWithBackground &&
          pendingStart.sceneEditMode === requestSnapshot.sceneEditMode &&
          pendingStart.settings === requestSnapshot.settings &&
          pendingStart.streamingOverride === requestSnapshot.streamingOverride &&
          pendingStart.suppressCaptionsForSession === requestSnapshot.suppressCaptionsForSession
        if (sameRequest) {
          return pendingStart.promise
        }
        if (streamingOverride) {
          return pendingStart.promise
            .catch(() => false)
            .then(() => settlePreparedPlatformLifecycle(streamingOverride))
            .then(() => false)
        }
        return Promise.resolve(false)
      }

      const startPromise = (async (): Promise<boolean> => {
        if (!client) {
          return false
        }
        if (!isSessionActive && !(await settlePreviousPlatformLifecycle())) {
          return false
        }
        if (startBlockedReason) {
          if (startBlockedReason && !isSessionActive) {
            reportError(new Error(startBlockedReason))
          }
          return false
        }

        let streamingForStart: StreamingSettings | null = null
        let platformSessionId: string | undefined
        try {
          setLastError(null)
          noteSessionStartAttempt()
          streamingForStart = streamingOverride ?? null
          let sessionCaptureConfig = captureConfig
          if (streamingForStart) {
            const output = preparedOutput
              ? { ...preparedOutput, streaming: streamingForStart }
              : await settleStreamOutputTopology(streamingForStart)
            if (output.reason) {
              throw new Error(output.reason)
            }
            streamingForStart = output.streaming
            sessionCaptureConfig = {
              ...captureConfig,
              video: output.video,
              streaming: output.streaming
            }
            const notice = (await loadGoLiveOutput()).goLiveSessionOutputNotice(output)
            if (notice) {
              toast.info(notice.title, {
                id: 'stream-output-adjusted',
                description: notice.description
              })
            }
          }
          setStreamHealth(null)
          setStreamTargets([])
          setStartRequestPending(true)
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
              if (oauthUnavailableReason(target.platform)) {
                // Feature-flagged-off OAuth (YouTube pending Google review) is a
                // known product state: the go-live setup skips the target with an
                // inline status, so it must not block or toast here either.
                continue
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
            throw new Error(
              'The selected output folder is unavailable. Choose it again in Settings → Recording.'
            )
          }
          const sessionParams = buildStartSessionParams({
            captureConfig: sessionCaptureConfig,
            scene: sceneWithBackground,
            sceneEditMode,
            settings,
            suppressCaptionsForSession
          })
          const authorizedOutput = {
            ...sessionParams.output,
            ...(outputDirectory ? { outputDirectoryCapability: outputDirectory.capabilityId } : {})
          }
          const nextSessionParams: StartSessionParams = streamingForStart
            ? {
                ...sessionParams,
                output: { ...authorizedOutput, streamEnabled: true },
                streaming: streamingForStart
              }
            : {
                ...sessionParams,
                output: { ...authorizedOutput, streamEnabled: false },
                streaming: undefined
              }
          const startAudioSnapshot = nextSessionParams.audio
            ? {
                microphoneGainDb: nextSessionParams.audio.microphoneGainDb,
                microphoneMuted: nextSessionParams.audio.microphoneMuted,
                systemAudio: {
                  systemAudioEnabled: nextSessionParams.audio.systemAudioEnabled,
                  systemAudioGainDb: nextSessionParams.audio.systemAudioGainDb,
                  systemAudioEchoGuard: nextSessionParams.audio.systemAudioEchoGuard
                }
              }
            : null
          liveAudioProcessingStartSnapshotRef.current = null
          liveAudioProcessingStartRequestInFlightRef.current = true
          sessionStartAuthoritativeStatusesRef.current.clear()
          sessionStartLifecycleInvalidatedSessionIdsRef.current.clear()
          sessionStartLifecycleSessionIdRef.current = null
          sessionStartLifecycleActiveRef.current = true
          let status: RecordingStatus
          try {
            status = await client.requestTyped('session.start', {
              ...nextSessionParams,
              requestedAtMs: takeRecordClickEpochMs('start')
            })
          } finally {
            liveAudioProcessingStartRequestInFlightRef.current = false
          }
          platformSessionId = status.sessionId
          sessionStartLifecycleSessionIdRef.current = status.sessionId ?? null
          const reconcileLatestStartStatus = () =>
            reconcileSessionStartResponse(
              status,
              status.sessionId
                ? sessionStartAuthoritativeStatusesRef.current.get(status.sessionId)
                : undefined
            )
          const invalidateTerminalPlatformLifecycle = (terminalStatus: RecordingStatus) => {
            const sessionId = terminalStatus.sessionId
            if (
              sessionId &&
              !sessionStartLifecycleInvalidatedSessionIdsRef.current.has(sessionId)
            ) {
              sessionStartLifecycleInvalidatedSessionIdsRef.current.add(sessionId)
              platformLifecycleRun.current += 1
            }
          }
          const settleTerminalStart = async (
            resolution: ReturnType<typeof reconcileSessionStartResponse>
          ): Promise<boolean> => {
            if (resolution.sessionActive) {
              return false
            }
            status = resolution.status
            invalidateTerminalPlatformLifecycle(status)
            liveAudioProcessingStartSnapshotRef.current = null
            applyRecordingStatus(status)
            clearLiveChatForTerminalSession(status.sessionId)
            const pendingSettlement =
              status.sessionId &&
              platformLifecycleSettlementRef.current?.sessionId === status.sessionId
                ? platformLifecycleSettlementRef.current
                : null
            if (pendingSettlement) {
              const pendingResult = await pendingSettlement.promise
              if (pendingResult.complete) {
                return true
              }
            }
            const claimedOwner = status.sessionId
              ? claimPlatformLifecycleOwner(status.sessionId)
              : null
            const ownerForCleanup =
              claimedOwner ??
              (status.sessionId && streamingForStart
                ? { sessionId: status.sessionId, streaming: streamingForStart }
                : null)
            if (ownerForCleanup) {
              await settleClaimedPlatformLifecycleOwner(ownerForCleanup)
            } else if (streamingForStart) {
              await settlePreparedPlatformLifecycle(streamingForStart)
            }
            return true
          }
          let startResolution = reconcileLatestStartStatus()
          status = startResolution.status
          liveAudioProcessingStartSnapshotRef.current =
            startResolution.sessionActive && status.sessionId && startAudioSnapshot
              ? { sessionId: status.sessionId, ...startAudioSnapshot }
              : null
          applyRecordingStatus(status)
          if (startResolution.sessionActive && streamingForStart && status.sessionId) {
            platformLifecycleOwnerRef.current = {
              sessionId: status.sessionId,
              streaming: streamingForStart
            }
          }
          if (await settleTerminalStart(startResolution)) {
            return false
          }
          if (streamingForStart) {
            // Go-live keeps the awaited refresh: a terminal status landing during
            // it must be observed before any broadcast is activated below.
            await refreshSessions(client)
          } else {
            // Record-only: the recording.status transition handler refreshes the
            // Library too; do not hold startRequestPending (the disabled Record
            // button) on a second sessions.list round trip.
            void refreshSessions(client)
          }
          startResolution = reconcileLatestStartStatus()
          if (await settleTerminalStart(startResolution)) {
            return false
          }
          if (streamingForStart) {
            startResolution = reconcileLatestStartStatus()
            if (await settleTerminalStart(startResolution)) {
              return false
            }
            await activatePreparedYouTubeBroadcasts(
              streamingForStart,
              lifecycleRunId,
              status.sessionId ?? recordingRef.current.sessionId
            )
            startResolution = reconcileLatestStartStatus()
            if (await settleTerminalStart(startResolution)) {
              return false
            }
            streamingForStart = await activatePreparedXBroadcasts(
              streamingForStart,
              lifecycleRunId,
              status.sessionId ?? recordingRef.current.sessionId
            )
            if (
              status.sessionId &&
              platformLifecycleRun.current === lifecycleRunId &&
              platformLifecycleOwnerRef.current?.sessionId === status.sessionId
            ) {
              platformLifecycleOwnerRef.current = {
                sessionId: status.sessionId,
                streaming: streamingForStart
              }
            }
            startResolution = reconcileLatestStartStatus()
            if (await settleTerminalStart(startResolution)) {
              return false
            }
          }
          return true
        } catch (error) {
          if (streamingOverride && streamingForStart) {
            const pendingSettlement =
              platformSessionId &&
              platformLifecycleSettlementRef.current?.sessionId === platformSessionId
                ? platformLifecycleSettlementRef.current
                : null
            if (pendingSettlement) {
              await pendingSettlement.promise
            } else if (platformSessionId) {
              const owned = claimPlatformLifecycleOwner(platformSessionId) ?? {
                sessionId: platformSessionId,
                streaming: streamingForStart
              }
              await settleClaimedPlatformLifecycleOwner(owned)
            } else {
              await settlePreparedPlatformLifecycle(streamingForStart)
            }
          }
          // Every start rejection — the compositor startup barrier, topology
          // probe, platform activation, the RPC itself — is unmissable: keyed
          // persistent toast + Session-panel line, Retry re-runs this exact start.
          reportSessionStartFailure(error, () => {
            void runStartSessionRef.current?.(streamingOverride, preparedOutput)
          })
          if (recordingRef.current.state === 'starting' && !recordingRef.current.sessionId) {
            applyRecordingStatus({ state: 'idle', message: 'Ready to start a capture session.' })
          }
          return false
        } finally {
          sessionStartLifecycleActiveRef.current = false
          sessionStartLifecycleSessionIdRef.current = null
          sessionStartLifecycleInvalidatedSessionIdsRef.current.clear()
          sessionStartAuthoritativeStatusesRef.current.clear()
          setStartRequestPending(false)
        }
      })()
      sessionStartInFlightRef.current = { ...requestSnapshot, promise: startPromise }
      const clearStartPromise = () => {
        if (sessionStartInFlightRef.current?.promise === startPromise) {
          sessionStartInFlightRef.current = null
        }
      }
      void startPromise.then(clearStartPromise, clearStartPromise)
      return startPromise
    },
    [
      takeRecordClickEpochMs,
      activatePreparedYouTubeBroadcasts,
      activatePreparedXBroadcasts,
      applyRecordingStatus,
      captureConfig,
      claimPlatformLifecycleOwner,
      clearLiveChatForTerminalSession,
      client,
      isSessionActive,
      noteSessionStartAttempt,
      refreshSessions,
      reportError,
      reportSessionStartFailure,
      sceneEditMode,
      sceneWithBackground,
      settings,
      settleClaimedPlatformLifecycleOwner,
      settlePreparedPlatformLifecycle,
      settlePreviousPlatformLifecycle,
      settleStreamOutputTopology,
      startBlockedReason,
      suppressCaptionsForSession,
      validatePlatformAccountsForClient
    ]
  )
  runStartSessionRef.current = runStartSession

  const prepareOauthTargetsForGoLive = useCallback(
    async (
      confirmedPreflight?: GoLivePreflight,
      // What this session will really send (plan 090): a broadcast prepared
      // at the saved profile would advertise a size the stream never reaches.
      sessionOutput?: Pick<GoLiveOutput.GoLiveSessionOutput, 'video' | 'streaming'>
    ): Promise<GoLivePartialSetup> => {
      if (!client) {
        throw new Error('Backend socket is not connected.')
      }
      if (!(await settlePreviousPlatformLifecycle())) {
        throw new Error('The previous livestream providers still need cleanup before Go Live.')
      }

      const outputVideo = sessionOutput?.video ?? captureConfig.video
      const outputStreaming = sessionOutput?.streaming ?? captureConfig.streaming
      const outputTarget = (target: StreamTargetSettings): StreamTargetSettings =>
        outputStreaming.targets.find((candidate) => candidate.id === target.id) ?? target
      let nextStreaming = captureConfig.streaming
      const failures: GoLiveSetupFailure[] = []
      for (const target of captureConfig.streaming.targets.filter(
        (target) => target.enabled && target.authMode === 'oauth'
      )) {
        try {
          if (target.platform === 'youtube') {
            const unavailable = oauthUnavailableReason(target.platform)
            if (unavailable) {
              if (target.scheduledEventId) throw new Error(unavailable)
              // Known product state (feature-flagged off while Google review is
              // pending), not a setup failure: keep it off the go-live failure
              // toast and mark the destination inline instead.
              nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
                status: { state: 'warning', message: unavailable }
              })
              continue
            }
            // Plan 094 (G5): prepare would fail on the insert while YouTube's
            // quota is out. Refuse before spending anything and offer the
            // stream-key path; every other destination and recording proceed.
            const pausedUntil = youtubeQuotaPausedUntil(youtubeQuotaRef.current)
            if (pausedUntil) {
              throw new BackendRequestError(
                YOUTUBE_QUOTA_PAUSED_CODE,
                (await loadSessionRuntimeRecovery()).youtubeGoLivePausedMessage(pausedUntil)
              )
            }
            const scheduledAttemptId = target.scheduledEventId ? crypto.randomUUID() : undefined
            const prepared = target.scheduledEventId
              ? await (
                  await import('@/lib/scheduled-streams')
                ).scheduledTargetOperation<PreparedYouTubeBroadcast>(
                  client,
                  'prepareForGoLive',
                  target.scheduledEventId,
                  {
                    accountId: target.accountId,
                    confirmationFingerprint: confirmedPreflight?.destinations.find(
                      (destination) => destination.targetId === target.id
                    )?.scheduled?.fingerprint,
                    attemptId: scheduledAttemptId,
                    targetId: target.id,
                    video: coerceVideoToOrientation(
                      streamOutputVideoForTarget(
                        outputVideo,
                        outputStreaming,
                        outputTarget(target)
                      ),
                      target.outputOrientation ?? 'horizontal'
                    )
                  }
                )
              : await client.request<PreparedYouTubeBroadcast>('streamTargets.youtube.prepare', {
                  accountId: target.accountId,
                  // Per-destination key slot: two YouTube destinations on one
                  // channel each keep the key of their OWN broadcast.
                  targetId: target.id,
                  // The vertical-bound broadcast advertises the PORTRAIT profile —
                  // the same transposition the simulcast leg composes at.
                  video: coerceVideoToOrientation(
                    streamOutputVideoForTarget(outputVideo, outputStreaming, outputTarget(target)),
                    target.outputOrientation ?? 'horizontal'
                  )
                })
            const completionKey = JSON.stringify([prepared.accountId, prepared.broadcastId])
            youtubeCompletionInFlightByBroadcastRef.current.delete(completionKey)
            youtubeCompletedBroadcastResultsRef.current.delete(completionKey)
            nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
              scheduledAttemptId,
              ...(target.scheduledEventId
                ? {
                    scheduledEventTitle: prepared.title,
                    scheduledPrivacy: prepared.privacy,
                    scheduledStartUtc: prepared.scheduledStartTime
                  }
                : {}),
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
          } else if (target.platform === 'kick') {
            const prepared = await client.request<PreparedKickBroadcast>(
              'streamTargets.kick.prepare',
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
                message: 'Kick channel prepared.'
              }
            })
          } else if (target.platform === 'x') {
            const scheduledAttemptId = target.scheduledEventId ? crypto.randomUUID() : undefined
            // A saved X broadcast already owns its ingest source: prepare reads
            // that source's key instead of creating a fresh session source.
            const prepared = target.scheduledEventId
              ? await (
                  await import('@/lib/scheduled-streams')
                ).scheduledTargetOperation<PreparedXStreamSource>(
                  client,
                  'prepareForGoLive',
                  target.scheduledEventId,
                  {
                    accountId: target.accountId,
                    confirmationFingerprint: confirmedPreflight?.destinations.find(
                      (destination) => destination.targetId === target.id
                    )?.scheduled?.fingerprint,
                    attemptId: scheduledAttemptId,
                    targetId: target.id,
                    video: coerceVideoToOrientation(
                      streamOutputVideoForTarget(
                        outputVideo,
                        outputStreaming,
                        outputTarget(target)
                      ),
                      target.outputOrientation ?? 'horizontal'
                    )
                  }
                )
              : await client.request<PreparedXStreamSource>('streamTargets.x.prepare', {
                  accountId: target.accountId
                })
            nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
              scheduledAttemptId,
              accountId: prepared.accountId,
              accountLabel: prepared.accountLabel,
              serverUrl: prepared.serverUrl,
              streamKeySecretRef: prepared.streamKeySecretRef,
              streamKeyPresent: true,
              platformBroadcastId: prepared.region,
              platformStreamId: prepared.sourceId,
              status: {
                state: 'ready',
                message: target.scheduledEventId
                  ? 'Saved X broadcast prepared.'
                  : prepared.isStreamActive
                    ? 'X source prepared; ingest is already active.'
                    : 'X source prepared.'
              }
            })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const quotaPaused = isYouTubeQuotaPausedError(error)
          failures.push({
            targetId: target.id,
            platform: target.platform,
            label: target.label,
            message,
            ...(quotaPaused ? { fallback: 'manual-rtmp' as const } : {})
          })
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            enabled: false,
            status: {
              // A paused API is not this destination failing: warning, not failed.
              state: quotaPaused ? 'warning' : 'failed',
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

      // Manual-key Kick targets: same rule as Twitch. The public API sets the
      // title and category whatever the ingest path; best-effort.
      const kickAccount = platformAccounts.find((item) => item.platform === 'kick')
      for (const target of captureConfig.streaming.targets.filter(
        (target) => target.enabled && target.authMode !== 'oauth' && target.platform === 'kick'
      )) {
        if (!kickAccount) {
          continue
        }
        try {
          const applied = await client.request<KickAppliedMetadata>(
            'streamTargets.kick.applyMetadata',
            { accountId: kickAccount.accountId }
          )
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            status: {
              state: 'ready',
              message: `Kick channel metadata updated ("${applied.title}").`
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

      setCaptureConfig((current) =>
        bridgeStreamingToLegacy({ ...current, streaming: nextStreaming })
      )
      await refreshPlatformAccountsForClient(client)
      // Keep saved preferences intact while carrying the exact profiles used
      // for provider preparation through to the media start.
      const preparedStreaming = {
        ...outputStreaming,
        targets: nextStreaming.targets.map((target) => ({
          ...target,
          outputPreset: outputTarget(target).outputPreset,
          outputBitrateKbps: outputTarget(target).outputBitrateKbps,
          outputOrientation: outputTarget(target).outputOrientation
        }))
      }
      return {
        streaming: preparedStreaming,
        failures,
        readyLabels: readyStreamTargetLabels(preparedStreaming)
      }
    },
    [
      captureConfig.streaming,
      captureConfig.video,
      client,
      platformAccounts,
      refreshPlatformAccountsForClient,
      settlePreviousPlatformLifecycle
    ]
  )

  const openGoLiveConfirmation = useCallback(async () => {
    if (!client) {
      return
    }
    if (!isSessionActive && !(await settlePreviousPlatformLifecycle())) {
      return
    }
    if (startBlockedReason) {
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
      // Settle the output check before anything is prepared on a platform.
      const topology = await settleStreamOutputTopology(captureConfig.streaming)
      if (topology.reason) {
        throw new Error(topology.reason)
      }
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
          scheduledEventIds: Object.fromEntries(
            captureConfig.streaming.targets
              .filter((t) => t.enabled && t.scheduledEventId)
              .map((t) => [t.id, t.scheduledEventId])
          ),
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
    settlePreviousPlatformLifecycle,
    settleStreamOutputTopology,
    startBlockedReason,
    streamMetadataDraft
  ])

  const startSession = useCallback(async () => {
    if (decideGoLiveStart(captureConfig.streamEnabled) === 'open-confirmation') {
      await openGoLiveConfirmation()
      return false
    }
    return runStartSession()
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
      void settlePreparedPlatformLifecycle(decision.cleanupStreaming)
    }
    setGoLivePartialSetup(null)
    setGoLiveConfirmationOpen(false)
    setSuppressCaptionsForSession(false)
  }, [
    goLiveConfirmationPending,
    goLivePartialSetup,
    settlePreparedPlatformLifecycle,
    startRequestPending
  ])

  const confirmGoLiveRef = useRef<(() => Promise<void>) | null>(null)
  const confirmGoLive = useCallback(() => {
    const pendingConfirmation = confirmGoLiveInFlightPromiseRef.current
    if (pendingConfirmation) {
      return pendingConfirmation
    }
    if (!client || goLiveConfirmationPending || startRequestPending) {
      return Promise.resolve()
    }
    if (goLiveCaptionsReadiness.blocksStart) {
      toast.warning('Live captions are not ready.', {
        description: goLiveCaptionsReadiness.description
      })
      return Promise.resolve()
    }

    const confirmationPromise = (async (): Promise<void> => {
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
            scheduledEventIds: Object.fromEntries(
              captureConfig.streaming.targets
                .filter((t) => t.enabled && t.scheduledEventId)
                .map((t) => [t.id, t.scheduledEventId])
            ),
            streaming: captureConfig.streaming
          }
        )
        const changedScheduledEvent = preflight.destinations.some(
          (destination) =>
            destination.scheduled &&
            goLivePreflight?.destinations.find(
              (previous) => previous.targetId === destination.targetId
            )?.scheduled?.fingerprint !== destination.scheduled.fingerprint
        )
        if (changedScheduledEvent) {
          setGoLivePreflight(preflight)
          toast.warning(
            'The scheduled event changed. Review its updated visibility and details, then confirm again.'
          )
          return
        }
        setGoLivePreflight(preflight)
        const preflightDecision = decideGoLivePreflight(preflight)
        if (preflightDecision.kind === 'blocked') {
          const premiumIssue = premiumRequiredIssueMessage(preflight)
          if (premiumIssue) {
            void loadSessionRuntimeRecovery().then((runtime) =>
              runtime.showPremiumUpgrade('Premium required for this Go Live setup.', premiumIssue)
            )
          } else {
            toast.error('Resolve Go Live issues before starting.')
          }
          return
        }
        // Settled before anything is created on a platform, so a refused
        // start leaves no broadcast behind and a prepared one advertises the
        // profile this session will send.
        const sessionOutput = await settleStreamOutputTopology(captureConfig.streaming)
        if (sessionOutput.reason) {
          throw new Error(sessionOutput.reason)
        }
        preparedGoLiveOutputRef.current = sessionOutput
        const setup = await prepareOauthTargetsForGoLive(preflight, sessionOutput)
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
        await runStartSession(setupDecision.streaming, sessionOutput)
      } catch (error) {
        // A Go Live that dies BEFORE the start RPC (metadata, preflight, platform
        // setup) is just as silent as a refused start: same persistent surface.
        // The dialog stays open, so Retry re-runs the confirmation.
        reportSessionStartFailure(error, () => {
          void confirmGoLiveRef.current?.()
        })
      } finally {
        setGoLiveConfirmationPending(false)
      }
    })()
    confirmGoLiveInFlightPromiseRef.current = confirmationPromise
    const clearConfirmationPromise = () => {
      if (confirmGoLiveInFlightPromiseRef.current === confirmationPromise) {
        confirmGoLiveInFlightPromiseRef.current = null
      }
    }
    void confirmationPromise.then(clearConfirmationPromise, clearConfirmationPromise)
    return confirmationPromise
  }, [
    captureConfig.streaming,
    client,
    goLiveConfirmationPending,
    goLivePreflight,
    goLiveCaptionsReadiness,
    prepareOauthTargetsForGoLive,
    reportSessionStartFailure,
    runStartSession,
    settleStreamOutputTopology,
    startRequestPending,
    streamMetadataDraft
  ])
  confirmGoLiveRef.current = confirmGoLive

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
      await runStartSession(decision.streaming, preparedGoLiveOutputRef.current)
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

  const stopSession = useCallback(() => {
    const pendingStop = stopSessionInFlightPromiseRef.current
    if (pendingStop) {
      return pendingStop
    }
    if (!client || stopRequestPending) {
      return Promise.resolve(false)
    }

    let claimedOwner: PlatformLifecycleOwner | null = null
    const stopPromise = (async (): Promise<boolean> => {
      try {
        setLastError(null)
        platformLifecycleRun.current += 1
        setStopRequestPending(true)
        recordLatencyTrackerRef.current.markClick('stop', performance.now(), 'session-call')
        const stopRequestedAtMs = takeRecordClickEpochMs('stop')
        liveAudioProcessingSyncRef.current?.queue.stop()
        const pendingStart = sessionStartInFlightRef.current
        const currentSessionId = recordingRef.current.sessionId
        const currentOwner = currentSessionId
          ? platformLifecycleOwnerRef.current?.sessionId === currentSessionId
          : false
        if (pendingStart && !currentOwner) {
          // Before session.start replies there is no exact backend session ID
          // to claim. Join that bounded start flow; it installs ownership from
          // the response even though this Stop invalidated provider activation.
          await pendingStart.promise.catch(() => false)
        }
        claimedOwner = claimPlatformLifecycleOwner(recordingRef.current.sessionId)
        if (claimedOwner) {
          await settleClaimedPlatformLifecycleOwner(claimedOwner, async (resolvedOwner) => {
            // Docs order for a real Go Live: wait for a provider mutation,
            // END X while the feed is still up, THEN stop the encoder.
            const cleaned = await endPreparedXBroadcasts(
              resolvedOwner.streaming,
              resolvedOwner.sessionId,
              4000
            )
            const status = await client.requestTyped('session.stop', {
              requestedAtMs: stopRequestedAtMs
            })
            if (
              sessionStartLifecycleActiveRef.current &&
              status.sessionId &&
              (status.state === 'stopping' || status.state === 'idle' || status.state === 'failed')
            ) {
              sessionStartAuthoritativeStatusesRef.current.set(status.sessionId, status)
            }
            applyRecordingStatus(status)
            clearLiveChatForTerminalSession(status.sessionId ?? resolvedOwner.sessionId)
            return completePreparedPlatformBroadcasts(cleaned, resolvedOwner.sessionId, {
              skipXCleanup: true
            })
          })
          return true
        }

        const sessionId = recordingRef.current.sessionId
        const pendingSettlement =
          sessionId && platformLifecycleSettlementRef.current?.sessionId === sessionId
            ? platformLifecycleSettlementRef.current
            : null
        if (pendingSettlement) {
          await pendingSettlement.promise
          if (!isActiveRecordingState(recordingRef.current.state)) {
            clearLiveChatForTerminalSession(sessionId)
            return true
          }
        }
        if (!isActiveRecordingState(recordingRef.current.state)) {
          clearLiveChatForTerminalSession(sessionId)
          return true
        }
        const status = await client.requestTyped('session.stop', {
          requestedAtMs: stopRequestedAtMs
        })
        if (
          sessionStartLifecycleActiveRef.current &&
          status.sessionId &&
          (status.state === 'stopping' || status.state === 'idle' || status.state === 'failed')
        ) {
          sessionStartAuthoritativeStatusesRef.current.set(status.sessionId, status)
        }
        applyRecordingStatus(status)
        clearLiveChatForTerminalSession(status.sessionId ?? sessionId)
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        setStopRequestPending(false)
      }
    })()
    stopSessionInFlightPromiseRef.current = stopPromise
    const clearStopPromise = () => {
      if (stopSessionInFlightPromiseRef.current === stopPromise) {
        stopSessionInFlightPromiseRef.current = null
      }
    }
    void stopPromise.then(clearStopPromise, clearStopPromise)
    return stopPromise
  }, [
    takeRecordClickEpochMs,
    applyRecordingStatus,
    claimPlatformLifecycleOwner,
    clearLiveChatForTerminalSession,
    client,
    completePreparedPlatformBroadcasts,
    endPreparedXBroadcasts,
    reportError,
    settleClaimedPlatformLifecycleOwner,
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
      // Smoke-only code: loaded on first use so it never ships in the eager bundle.
      const smoke = await import('@/lib/windows-live-audio-smoke-harness')
      const snapshot = (): WindowsLiveAudioSmokeState =>
        smoke.windowsLiveAudioSmokeState({
          recording: recordingRef.current,
          lastError: lastErrorRef.current,
          captureConfig: captureConfigRef.current,
          telemetry: windowsLiveAudioSmokeTelemetryRef.current
        })
      switch (request.action) {
        case 'configure': {
          const next = smoke.configureWindowsLiveAudioSmokeCapture(
            captureConfigRef.current,
            deviceList.devices,
            request
          )
          // This action starts a new, controlled acceptance scenario after the
          // harness has independently proved the physical preview sources.
          // Do not carry an earlier renderer warning into its baseline; the
          // subsequent start action performs the authoritative readiness gate.
          lastErrorRef.current = null
          setLastError(null)
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
          for (const update of smoke.WINDOWS_LIVE_AUDIO_SMOKE_BURST) {
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
      throw new Error(
        'The selected output folder is unavailable. Choose it again in Settings → Recording.'
      )
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
        toast.success('Exported MP4.', { id: `finalization-${sessionId}` })
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshNoiseCleanupJobs, refreshSessions, reportError]
  )
  remuxSessionRef.current = remuxSession

  const markClip = useCallback(async (): Promise<ClipMarkedEvent | null> => {
    if (!client) {
      toast.error('Mark clip', { description: 'Backend is not connected. Try again in a moment.' })
      return null
    }
    if (!isActiveRecordingState(recordingRef.current.state)) {
      toast.info('Nothing to mark yet.', {
        id: 'clip-marked',
        description: 'Start recording or go live, then mark the moments you want clipped.'
      })
      return null
    }
    try {
      return await client.request<ClipMarkedEvent>('clip.mark')
    } catch (error) {
      reportError(error)
      return null
    }
  }, [client, reportError])

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
    markOutputChosenByUser()
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
        void loadSessionRuntimeRecovery().then((runtime) =>
          runtime.showPremiumUpgrade('Premium required for this media profile.', gate.reason)
        )
        return
      }

      markOutputChosenByUser()
      setCaptureConfig((current) => ({
        ...current,
        video: coerceVideoToOrientation(video, layoutPresetOrientation(current.layout.layoutPreset))
      }))
    },
    [entitlements]
  )

  // Performance check. The backend owns the measurement; this only decides
  // when to ask for one and whether its verdict may move the output.
  const [encoderPreference, setEncoderPreferenceState] = useState<EncoderPreferenceState | null>(
    null
  )
  const [performanceCheckProgress, setPerformanceCheckProgress] =
    useState<PerformanceCheckProgress | null>(null)
  const performanceCheckAutoRunRef = useRef(false)

  const commitPerformanceCheck = useCallback((next: PerformanceCheckState) => {
    setPerformanceCheck(next)
    if (!next.running) {
      setPerformanceCheckProgress(null)
    }
    // An install that never picked an output follows the measurement; anyone
    // who chose one only ever gets the suggestion in Recording → Output.
    if (
      next.running ||
      next.stale ||
      !next.result ||
      outputChosenByUser() ||
      isUntrustedPerformanceCheckResult(next.result)
    ) {
      return
    }
    const preset = autoApplyPreset(next.result)
    if (!preset) {
      return
    }
    setCaptureConfig((current) => {
      if (!isShippedDefaultOutput(current.video)) {
        return current
      }
      const video = coerceVideoToOrientation(
        videoPresets[preset],
        layoutPresetOrientation(current.layout.layoutPreset)
      )
      return current.video.width === video.width &&
        current.video.height === video.height &&
        current.video.fps === video.fps
        ? current
        : { ...current, video }
    })
  }, [])

  const runPerformanceCheck = useCallback(async () => {
    if (!client) {
      return
    }
    const display = {
      width: window.screen.width * window.devicePixelRatio,
      height: window.screen.height * window.devicePixelRatio
    }
    setPerformanceCheck(
      await client.requestTyped(
        'performance.check.run',
        performanceCheckCeiling(captureConfigRef.current.video, display)
      )
    )
  }, [client])

  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }
    const unsubscribers = [
      client.on('performance.check.progress', setPerformanceCheckProgress),
      client.on('performance.check.completed', (next) => {
        commitPerformanceCheck(next)
        // News the interface does not already show: a chosen output this
        // computer measurably cannot hold. Said once per finished check.
        const chosen = captureConfigRef.current.video
        const tooHeavy = next.result && performanceCheckTooHeavyToast(chosen, next.result)
        if (tooHeavy) {
          toast.warning(tooHeavy.title, { description: tooHeavy.description })
        }
      })
    ]
    void client
      .requestTyped('performance.check.get')
      .then(commitPerformanceCheck)
      // An older backend has no such method; the Output panel just stays quiet.
      .catch(() => undefined)
    void client
      .requestTyped('encoder.preference.get')
      .then(setEncoderPreferenceState)
      .catch(() => undefined)
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [client, commitPerformanceCheck, wsStatus])

  // Plan 090 C5: which encoder the Windows fallback path may use. A change
  // invalidates both things measured under the old choice: the output check
  // and this computer's performance result.
  const setEncoderPreference = useCallback(
    async (preference: WindowsH264EncoderPreference) => {
      if (!client) {
        return
      }
      setEncoderPreferenceState(await client.requestTyped('encoder.preference.set', { preference }))
      if (captureConfigRef.current.streamEnabled) {
        void refreshStreamOutputTopology().catch(() => undefined)
      }
      void client
        .requestTyped('performance.check.get')
        .then(commitPerformanceCheck)
        .catch(() => undefined)
    },
    [client, commitPerformanceCheck, refreshStreamOutputTopology]
  )

  // Measure once per machine, after the app has settled. Packaged builds only:
  // dev sessions and smokes start captures immediately and use the button.
  useEffect(() => {
    if (
      performanceCheckAutoRunRef.current ||
      !runtimeInfo?.isPackaged ||
      recording.state !== 'idle' ||
      !shouldRunPerformanceCheck(performanceCheck)
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      performanceCheckAutoRunRef.current = true
      void runPerformanceCheck().catch(() => undefined)
    }, PERFORMANCE_CHECK_AUTO_RUN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [performanceCheck, recording.state, runPerformanceCheck, runtimeInfo?.isPackaged])

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
          {
            streaming: nextStreaming,
            scheduledEventIds: Object.fromEntries(
              nextStreaming.targets
                .filter((t) => t.enabled && t.scheduledEventId)
                .map((t) => [t.id, t.scheduledEventId])
            )
          }
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
              ? `${label} stream key removed. The previous key is kept for restore.`
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
    () => deviceListWithoutProtectedOverlayWindows(deviceList, notesWindow),
    [deviceList, notesWindow]
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
      if (
        event.repeat ||
        event.defaultPrevented ||
        isEditableTargetSafe(event.target) ||
        document.querySelector(
          '[data-videorc-stage-phase="dragging"], [data-videorc-stage-phase="pending"]'
        )
      ) {
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

  const requestRemoteMicrophoneMute = useCallback(
    (mode: 'mute' | 'unmute' | 'toggle'): Promise<boolean> => {
      const recordingStatus = recordingRef.current
      const sessionActive = isActiveRecordingState(recordingStatus.state)
      const currentAudio = captureConfigRef.current.audio
      const commitRequestedMute = (microphoneMuted: boolean): void => {
        captureConfigRef.current = {
          ...captureConfigRef.current,
          audio: { ...captureConfigRef.current.audio, microphoneMuted }
        }
        setCaptureConfig((current) =>
          current.audio.microphoneMuted === microphoneMuted
            ? current
            : {
                ...current,
                audio: { ...current.audio, microphoneMuted }
              }
        )
      }

      if (!sessionActive) {
        const microphoneMuted = mode === 'toggle' ? !currentAudio.microphoneMuted : mode === 'mute'
        commitRequestedMute(microphoneMuted)
        return Promise.resolve(true)
      }

      const sessionId = recordingStatus.sessionId
      if (!sessionId) {
        return Promise.resolve(false)
      }
      const sync = liveAudioProcessingSyncRef.current
      const applied =
        sync?.sessionId === sessionId && sync.authoritative
          ? sync.lastApplied
          : liveAudioProcessingAppliedRef.current?.sessionId === sessionId
            ? liveAudioProcessingAppliedRef.current
            : liveAudioProcessingStartSnapshotRef.current?.sessionId === sessionId
              ? liveAudioProcessingStartSnapshotRef.current
              : null
      if (!applied) {
        return Promise.resolve(false)
      }
      const microphoneMuted = mode === 'toggle' ? !applied.microphoneMuted : mode === 'mute'
      if (
        sync?.sessionId === sessionId &&
        sync.disabled &&
        microphoneMuted !== applied.microphoneMuted
      ) {
        return Promise.resolve(false)
      }

      commitRequestedMute(microphoneMuted)
      if (
        microphoneMuted === applied.microphoneMuted &&
        !(sync?.sessionId === sessionId && sync.queue.hasOutstandingWork)
      ) {
        return Promise.resolve(true)
      }

      const settlement = new Promise<boolean>((resolve) => {
        liveMicrophoneSettlementWaitersRef.current.add({
          sessionId,
          microphoneMuted,
          resolve
        })
      })
      if (sync?.sessionId === sessionId) {
        sync.queue.enqueue({
          sessionId,
          microphoneGainDb: captureConfigRef.current.audio.microphoneGainDb,
          microphoneMuted
        })
      }
      return settlement
    },
    []
  )

  // ── Remote control (issue #143) ──────────────────────────────────────
  // Intents execute through the SAME handlers as the on-screen buttons —
  // no second session-start path, no validation bypass. Every intent is
  // acked so deck keys can show failure reasons. An effect event: stable
  // identity for the one-time client subscription, latest closure inside.
  const handleRemoteIntent = useEffectEvent(async (payload: unknown) => {
    if (!client) return
    const knownLayoutPresets = [...HORIZONTAL_LAYOUT_PRESETS, ...VERTICAL_LAYOUT_PRESETS]
    const context: RemoteIntentContext = {
      client,
      sessionActive: isActiveRecordingState(recordingRef.current.state),
      streamEnabled: captureConfigRef.current.streamEnabled,
      startSession,
      stopSession,
      setMicrophoneMuted: requestRemoteMicrophoneMute,
      systemAudio: [systemAudioStatus, systemAudioShown],
      setSystemAudioEnabled,
      knownLayoutPresets,
      applyLayoutPreset: (layoutPreset) => requestCameraPresetTransaction({ layoutPreset }),
      hasTakeover: (assetId) => screens.some((screen) => screen.id === assetId),
      activateTakeover: activateScreen,
      clearTakeover: clearActiveScreen,
      openWindow: async (name) => {
        if (name === 'notes') await openNotesWindow()
        else if (name === 'comments') await openCommentsWindow()
        else if (name === 'preview') await openPreviewWindow()
        else return false
        return true
      },
      showCommentHighlight: async (messageId) => {
        const message = liveChatSnapshot.messages.find((candidate) => candidate.id === messageId)
        if (!message || message.isDeleted) {
          return { ok: false, message: 'That comment is no longer available.' }
        }
        const highlightIntent = ++commentHighlightIntentRef.current
        setCommentHighlightFailure(null)
        try {
          const state = await applyCommentHighlight(message, undefined, highlightIntent, {
            alwaysSet: true
          })
          if (!state) return { ok: false, message: 'A newer comment replaced this one.' }
          publishCommentHighlightState(state)
          return state.phase === 'live'
            ? { ok: true }
            : { ok: false, message: state.reason ?? 'The comment did not reach the stream.' }
        } catch (error) {
          // The backend's eligibility reason ("not live", ...) verbatim.
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Highlight failed.'
          }
        }
      },
      clearCommentHighlight: async () => {
        ++commentHighlightIntentRef.current
        try {
          const state = await client.request<CommentHighlightState>('comments.highlight.clear')
          publishCommentHighlightState(state)
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Could not clear the comment.'
          }
        }
      },
      markClip: async () => {
        try {
          const event = await client.request<ClipMarkedEvent>('clip.mark')
          return event.saved ? { ok: true } : { ok: false, message: clipMarkedToast(event).title }
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Could not mark the clip.'
          }
        }
      }
    }
    const intentKind = (payload as { kind?: unknown } | null)?.kind
    if (intentKind === 'recordStart' || intentKind === 'streamStart') {
      noteRecordClick('start')
    } else if (intentKind === 'recordStop' || intentKind === 'streamStop') {
      noteRecordClick('stop')
    } else if (intentKind === 'recordToggle') {
      noteRecordClick(context.sessionActive ? 'stop' : 'start')
    }
    try {
      const { executeRemoteIntent } = await import('@/lib/remote-surface')
      await executeRemoteIntent(payload, context)
    } catch (error) {
      reportError(error)
    }
  })

  // The state projection deck keys render (types in lib/remote-surface.ts).
  // Minimal by design and the ONLY payload remote sockets receive — never
  // widen it with tokens/paths/URLs.
  const activeSessionAppliedAudio =
    liveAudioProcessingApplied?.sessionId === recording.sessionId
      ? liveAudioProcessingApplied
      : null
  const activeSessionStartAudio = liveAudioProcessingStartSnapshotRef.current
  const activeSessionStartMicrophoneMuted =
    activeSessionStartAudio && activeSessionStartAudio.sessionId === recording.sessionId
      ? activeSessionStartAudio.microphoneMuted
      : null
  const remoteSurfaceMicrophoneMuted = isActiveRecordingState(recording.state)
    ? activeSessionAppliedAudio
      ? activeSessionAppliedAudio.microphoneMuted
      : (activeSessionStartMicrophoneMuted ??
        remoteSurfaceValuesRef.current?.[4] ??
        captureConfig.audio.microphoneMuted)
    : captureConfig.audio.microphoneMuted
  const remoteSurfaceValues: RemoteSurfaceValues = [
    recording.state,
    isSessionActive,
    captureConfig.recordEnabled,
    captureConfig.streamEnabled,
    remoteSurfaceMicrophoneMuted,
    captureConfig.layout.layoutPreset,
    activeScreen?.id ?? null,
    notesWindow.open,
    commentsWindow.open,
    previewWindow.open,
    [...HORIZONTAL_LAYOUT_PRESETS, ...VERTICAL_LAYOUT_PRESETS],
    screens.map((screen) => ({ id: screen.id, name: screen.name })),
    systemAudioStatus,
    systemAudioShown
  ]
  // Latest-value hand-off (same render-body pattern as the ref mirrors
  // above): the publisher dedupes, debounces past the commit, republishes on
  // reconnect, and retries failures on its own timeline — no effect.
  remoteSurfaceValuesRef.current = remoteSurfaceValues
  remoteSurfacePublisherRef.current?.syncValues(remoteSurfaceValues)

  const remoteControlRequest = useCallback(
    async (method: string): Promise<RemoteControlStatus | null> => {
      if (!client) {
        return null
      }
      try {
        const status = await client.request<RemoteControlStatus>(method)
        // The backend also pushes remote.control.status; folding the response
        // in just makes the Settings switch update without waiting on it.
        setRemoteControlStatus(status)
        return status
      } catch (error) {
        reportError(error)
        return null
      }
    },
    [client, reportError]
  )
  const remoteLanRequest = useCallback(
    async (method: string, params?: unknown): Promise<RemoteLanStatus | null> => {
      if (!client) return null
      try {
        const status = await client.request<RemoteLanStatus>(method, params)
        setRemoteLanStatus(status)
        return status
      } catch (error) {
        reportError(error)
        return null
      }
    },
    [client, reportError]
  )
  const beginRemoteLanPairing = useCallback(
    async (address?: string): Promise<RemoteLanPairing | null> => {
      if (!client) return null
      try {
        return await client.request<RemoteLanPairing>(
          'remote.lan.pairing.begin',
          address ? { address } : {}
        )
      } catch (error) {
        reportError(error)
        return null
      }
    },
    [client, reportError]
  )
  const remoteControl = useMemo(
    () => ({
      status: remoteControlStatus,
      enable: () => remoteControlRequest('remote.control.enable'),
      disable: () => remoteControlRequest('remote.control.disable'),
      regenerate: () => remoteControlRequest('remote.control.regenerate'),
      phone: {
        status: remoteLanStatus,
        enable: () => remoteLanRequest('remote.lan.enable'),
        disable: () => remoteLanRequest('remote.lan.disable'),
        beginPairing: beginRemoteLanPairing,
        cancelPairing: () => remoteLanRequest('remote.lan.pairing.cancel'),
        revokeDevice: (id: string) => remoteLanRequest('remote.lan.devices.revoke', { id }),
        renameDevice: (id: string, name: string) =>
          remoteLanRequest('remote.lan.devices.rename', { id, name })
      }
    }),
    [
      beginRemoteLanPairing,
      remoteControlRequest,
      remoteControlStatus,
      remoteLanRequest,
      remoteLanStatus
    ]
  )

  // OS-global shortcuts (RC0): registration follows Settings via the
  // render-synced registrar (dedupes by value — only real changes cross the
  // IPC boundary); triggers run the same handlers as the buttons and the
  // remote intents, subscribed once in the client-setup effect.
  useEffect(() => {
    let disposed = false
    let registrar: GlobalShortcutsRegistrar | null = null
    void import('@/lib/global-shortcuts')
      .then(({ GlobalShortcutsRegistrar }) => {
        if (disposed) return
        registrar = new GlobalShortcutsRegistrar()
        globalShortcutsRegistrarRef.current = registrar
        registrar.sync(settingsRef.current.globalShortcuts ?? {})
      })
      .catch((error: unknown) => {
        if (!disposed) reportError(error)
      })
    return () => {
      disposed = true
      registrar?.dispose()
      if (globalShortcutsRegistrarRef.current === registrar) {
        globalShortcutsRegistrarRef.current = null
      }
    }
  }, [reportError])
  globalShortcutsRegistrarRef.current?.sync(settings.globalShortcuts ?? {})
  const handleGlobalShortcut = useEffectEvent((action: GlobalShortcutAction) => {
    const context: GlobalShortcutContext = {
      switchLayout: (layoutAction) => {
        const current = captureConfigRef.current
        const direct = globalShortcutLayout(layoutAction)
        const from = latestRequestedLayoutRef.current ?? current.layout.layoutPreset
        const orientation = layoutPresetOrientation(from)
        const eligible = BUILTIN_LAYOUTS.filter(
          ({ id }) =>
            layoutPresetOrientation(id) === orientation &&
            sceneSourceProblems(
              {
                layout: { ...current.layout, layoutPreset: id, arrangementMode: 'preset' },
                sources: visualSources(current.sources),
                background: null
              },
              deviceListRef.current.devices
            ).length === 0
        )
        const step = layoutAction === 'layout-previous' ? -1 : 1
        const target =
          direct ??
          nextEligibleLayout(
            from,
            step,
            eligible.map(({ id }) => id)
          )
        if (!target) {
          toast.info('No other available layout.', { id: 'layout-shortcut-empty' })
          return
        }
        if (
          layoutIntentAwaitingProofRef.current !== null &&
          latestRequestedLayoutRef.current === target
        )
          return
        latestRequestedLayoutRef.current = target
        if (layoutShortcutTimerRef.current) clearTimeout(layoutShortcutTimerRef.current)
        // Coalesce repeat bursts while retaining their latest requested index.
        layoutShortcutTimerRef.current = setTimeout(() => {
          layoutShortcutTimerRef.current = null
          void requestCameraPresetTransaction({ layoutPreset: target }).then((accepted) => {
            if (!accepted && latestRequestedLayoutRef.current === target)
              latestRequestedLayoutRef.current = captureConfigRef.current.layout.layoutPreset
          })
        }, 70)
      },
      sessionActive: isActiveRecordingState(recordingRef.current.state),
      streamEnabled: captureConfigRef.current.streamEnabled,
      startSession,
      stopSession,
      toggleMicrophoneMute: () => {
        setCaptureConfig((current) => ({
          ...current,
          audio: {
            ...current.audio,
            microphoneMuted: !current.audio.microphoneMuted
          }
        }))
      },
      markClip: () => {
        void markClip()
      },
      systemAudio: [systemAudioStatus, systemAudioShown],
      setSystemAudioEnabled
    }
    if (action.startsWith('layout')) return context.switchLayout?.(action)
    void import('@/lib/global-shortcuts')
      .then(({ executeGlobalShortcut }) => executeGlobalShortcut(action, context))
      .catch(reportError)
  })

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
    () => ({
      captureRecoveryStatus,
      captureRecoveryRetryPending,
      diagnosticStats,
      healthEvents,
      logs,
      previewSurfaceStatus,
      recordLatency,
      retryCaptureRecovery,
      streamHealth
    }),
    [
      captureRecoveryRetryPending,
      captureRecoveryStatus,
      diagnosticStats,
      healthEvents,
      logs,
      previewSurfaceStatus,
      recordLatency,
      retryCaptureRecovery,
      streamHealth
    ]
  )
  const chatValue = useMemo<StudioChatContextValue>(
    () => ({ cohostState, liveChatSnapshot }),
    [cohostState, liveChatSnapshot]
  )
  const audioValue = useMemo<StudioAudioContextValue>(
    () => ({ audioMeter, audioMeterLoading, meterLevel }),
    [audioMeter, audioMeterLoading, meterLevel]
  )
  const recordingStateValue = useMemo<StudioRecordingStateContextValue>(
    () => ({
      recording: {
        state: recording.state,
        sessionId: recording.sessionId,
        streamUrl: recording.streamUrl
      }
    }),
    [recording.sessionId, recording.state, recording.streamUrl]
  )
  const recordingValue = useMemo<StudioRecordingContextValue>(() => ({ recording }), [recording])
  const previewValue = useMemo<StudioPreviewContextValue>(
    () => ({ previewLiveStatus, previewCameraStatus, previewScreenStatus }),
    [previewCameraStatus, previewLiveStatus, previewScreenStatus]
  )

  // Development smoke harness: delegates to the same public actions as the UI.
  // No parallel apply implementation or production exposure.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const smokeWindow = window as Window & { __videorcSmokeScenePresets?: unknown }
    smokeWindow.__videorcSmokeScenePresets = {
      state: () => ({
        canSave: value.canSaveScene,
        scenes: value.savedScenes,
        activeId: value.activeSavedSceneId,
        pendingId: value.savedScenePendingId,
        pendingLayout: value.layoutSwitchPending,
        modified: value.savedSceneModified,
        visual: workingVisual,
        diagnostics: {
          wsStatus,
          layoutIntentId: layoutIntentIdRef.current,
          layoutIntentAwaitingProof: layoutIntentAwaitingProofRef.current,
          confirmedSceneRevision: nativePreviewCommittedSceneRef.current?.sceneRevision ?? null,
          backendSceneRevision:
            nativePreviewCompositorLatestStatusRef.current?.sceneRevision ?? null,
          selectedDeviceAvailability: {
            camera:
              deviceList.devices.find((device) => device.id === captureConfig.sources.cameraId)
                ?.status ?? null,
            screen:
              deviceList.devices.find((device) => device.id === captureConfig.sources.screenId)
                ?.status ?? null,
            window:
              deviceList.devices.find((device) => device.id === captureConfig.sources.windowId)
                ?.status ?? null
          },
          hasScene: scene !== null,
          visualTransactionPending,
          sourceDeviceSwitchPending,
          sourceSelectionState,
          sourceSwitchReasons: {
            capture: sourceSwitchReason('capture'),
            camera: sourceSwitchReason('camera'),
            microphone: sourceSwitchReason('microphone')
          },
          allowCaptureNone,
          sceneGesturePending,
          sceneTransformPending,
          confirmedVisual: confirmedVisualRef.current
        },
        recording: recording.state,
        backgroundSlots: backgroundRegistry.slots.map(({ id, assetId }) => ({ id, assetId }))
      }),
      save: value.saveScene,
      apply: value.applySavedScene,
      remove: value.deleteSavedScene,
      retrySourceStatus,
      background: value.applyBackgroundSlot,
      backgroundStyle: value.applyWorkingBackgroundStyle,
      removeBackground: (id: string) =>
        setBackgroundRegistry((current) => removeSlotAsset(current, id)),
      layout: value.applyCameraPreset,
      configure: (patch: Partial<CaptureConfig>) =>
        value.setCaptureConfig((current) => ({ ...current, ...patch })),
      start: value.startSession,
      stop: value.stopSession,
      confirmGoLive: value.confirmGoLive,
      cancelGoLive: value.cancelGoLiveConfirmation,
      setSettings: value.setSettings,
      patchTarget: value.patchStreamingTarget,
      streamingState: () => ({
        canStart: value.canStart,
        startBlockedReason: value.startBlockedReason,
        lastError: value.lastError,
        confirmationOpen: value.goLiveConfirmationOpen,
        pending: value.goLiveConfirmationPending,
        captureConfig: value.captureConfig,
        recording: recording,
        preflight: value.goLivePreflight
      })
    }
    return () => {
      delete smokeWindow.__videorcSmokeScenePresets
    }
  })

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
      streamOutputTopologyPreflight,
      refreshStreamOutputTopology,
      streamSharedEncodeFallbackVideo,
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
      kickCategories,
      kickCategorySearchPending,
      xNativeCapability,
      xNativeCapabilityLoading,
      youtubeQuota,
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
      cohostSettings,
      overlayLayout,
      setOverlayLayout,
      golemOverlay,
      cohostGate,
      cohostActionPending,
      patchCohostSettings,
      setOrcleLive,
      orcleConsentRequested,
      answerOrcleConsent,
      markCohostQuestionAnswered,
      dismissCohostQuestion,
      restoreCohostQuestion,
      dismissCohostFlag,
      showCohostQuestionOnStream,
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
      startRequestPending,
      stopRequestPending,
      screenImportPending,
      streamMetadataSavePending,
      supportBundleExportPending,
      remoteControl,
      settings,
      setSettings,
      captureConfig,
      setCaptureConfig,
      patchLayout,
      applyLayoutPatch,
      patchVideo,
      applyVideoPreset,
      performanceCheck,
      encoderPreference,
      setEncoderPreference,
      performanceCheckProgress,
      runPerformanceCheck,
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
      searchKickCategories,
      refreshXNativeCapability,
      authorizeXLive,
      refreshStreamMetadata,
      saveStreamMetadataDraft,
      cancelGoLiveConfirmation,
      confirmGoLive,
      continueGoLiveWithReadyDestinations,
      sessionStartFailure,
      dismissSessionStartFailure,
      sessionRuntimeNotice,
      dismissSessionRuntimeNotice,
      retrySessionStart,
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
      setSceneEditorDraft,
      clearSceneEditorDraft,
      commitCameraTransform,
      applyCameraPreset,
      savedScenes: sceneLibrary.scenes,
      activeSavedSceneId,
      savedScenePendingId,
      savedSceneModified,
      sceneLibraryError: sceneLibrary.error,
      canSaveScene,
      setSceneGesturePending,
      saveScene,
      renameSavedScene: sceneLibrary.rename,
      deleteSavedScene,
      applySavedScene,
      applyBackgroundSlot,
      applyWorkingBackgroundStyle,
      applySimulcastLeg,
      layoutSwitchPending,
      sourceDeviceSwitchPending,
      sourceSelectionState,
      sourceSwitchReason,
      allowCaptureNone,
      retrySourceStatus,
      switchSourceDeviceLive,
      setSceneSourceVisible,
      moveSceneSource,
      handleSystemPermission,
      openSystemPermissionSettings,
      revealPermissionTarget,
      scheduleHardwareAccelerationRetry,
      exportSupportBundle,
      registerPreviewSurfaceResize,
      syncNativePreviewSurfaceBounds,
      sampleAudioMeter,
      armWarmMicrophone,
      disarmWarmMicrophone,
      warmMicrophone,
      noteRecordClick,
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
      markClip,
      assessRecording,
      repairRecording,
      restoreRecording,
      outputEnabled,
      streamReady,
      isSessionActive,
      systemAudioConfirmed,
      systemAudioIssue,
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
      streamOutputTopologyPreflight,
      refreshStreamOutputTopology,
      streamSharedEncodeFallbackVideo,
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
      kickCategories,
      kickCategorySearchPending,
      xNativeCapability,
      xNativeCapabilityLoading,
      youtubeQuota,
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
      cohostSettings,
      overlayLayout,
      setOverlayLayout,
      golemOverlay,
      cohostGate,
      cohostActionPending,
      patchCohostSettings,
      setOrcleLive,
      orcleConsentRequested,
      answerOrcleConsent,
      markCohostQuestionAnswered,
      dismissCohostQuestion,
      restoreCohostQuestion,
      dismissCohostFlag,
      showCohostQuestionOnStream,
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
      startRequestPending,
      stopRequestPending,
      screenImportPending,
      streamMetadataSavePending,
      supportBundleExportPending,
      remoteControl,
      settings,
      setSettings,
      captureConfig,
      setCaptureConfig,
      patchLayout,
      applyLayoutPatch,
      patchVideo,
      applyVideoPreset,
      performanceCheck,
      encoderPreference,
      setEncoderPreference,
      performanceCheckProgress,
      runPerformanceCheck,
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
      searchKickCategories,
      refreshXNativeCapability,
      authorizeXLive,
      refreshStreamMetadata,
      saveStreamMetadataDraft,
      cancelGoLiveConfirmation,
      confirmGoLive,
      continueGoLiveWithReadyDestinations,
      sessionStartFailure,
      dismissSessionStartFailure,
      sessionRuntimeNotice,
      dismissSessionRuntimeNotice,
      retrySessionStart,
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
      setSceneEditorDraft,
      clearSceneEditorDraft,
      commitCameraTransform,
      applyCameraPreset,
      sceneLibrary.scenes,
      sceneLibrary.error,
      sceneLibrary.rename,
      activeSavedSceneId,
      savedScenePendingId,
      savedSceneModified,
      canSaveScene,
      saveScene,
      deleteSavedScene,
      applySavedScene,
      applyBackgroundSlot,
      applyWorkingBackgroundStyle,
      applySimulcastLeg,
      layoutSwitchPending,
      sourceDeviceSwitchPending,
      sourceSelectionState,
      sourceSwitchReason,
      allowCaptureNone,
      retrySourceStatus,
      switchSourceDeviceLive,
      setSceneSourceVisible,
      moveSceneSource,
      handleSystemPermission,
      openSystemPermissionSettings,
      revealPermissionTarget,
      scheduleHardwareAccelerationRetry,
      exportSupportBundle,
      registerPreviewSurfaceResize,
      syncNativePreviewSurfaceBounds,
      sampleAudioMeter,
      armWarmMicrophone,
      disarmWarmMicrophone,
      warmMicrophone,
      noteRecordClick,
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
      markClip,
      assessRecording,
      repairRecording,
      restoreRecording,
      outputEnabled,
      streamReady,
      isSessionActive,
      systemAudioConfirmed,
      systemAudioIssue,
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

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
