import type { BackgroundImportResult } from './background-import'
export type { BackgroundImportResult } from './background-import'

export interface BackendConnection {
  host: string
  port: number
  token: string
  pid?: number
  parentPid?: number
}

export interface BackendHealth {
  status: string
  version: string
  platform: string
  ffmpeg: ToolStatus
  databasePath: string
  secretStoreBackend: string
}

export interface ToolStatus {
  path: string
  available: boolean
  version?: string
  message?: string
}

export interface SupportBundleRedactionSummary {
  secretValues: number
  databasePaths: number
  mediaPaths: number
  homePaths: number
  urlCredentials: number
  aiArtifactBodies: number
}

export interface SupportBundleExportResult {
  path: string
  includedSections: string[]
  redactionSummary: SupportBundleRedactionSummary
}

export interface SupportBundleExportParams {
  ffmpegPath?: string
  appVersion?: string
  rendererDiagnostics?: RendererDiagnosticsSnapshot
}

export type FeatureId =
  | 'local-recording'
  | 'livestreaming'
  | 'multistreaming'
  | 'cloud-ai'
  | 'noise-cleanup'
export type EntitlementState = 'enabled' | 'disabled' | 'developer-override'
export type EntitlementTier = 'basic' | 'premium' | 'developer'
export type EntitlementSource =
  | 'local-default'
  | 'env-override'
  | 'creem'
  | 'manual'
  | 'signed-cache'
  | 'future-license'

export interface EntitlementCapability {
  featureId: FeatureId
  state: EntitlementState
  reason?: string
}

export interface RecordingEntitlementLimits {
  maxWidth: number
  maxHeight: number
  maxFps: number
  maxBitrateKbps?: number
}

export interface StreamingEntitlementLimits {
  maxWidth: number
  maxHeight: number
  maxFps: number
  maxBitrateKbps: number
  maxDestinations: number
}

export interface EntitlementLimits {
  recording: RecordingEntitlementLimits
  streaming: StreamingEntitlementLimits
}

export interface EntitlementsSnapshot {
  schemaVersion: number
  tier: EntitlementTier
  source: EntitlementSource
  capabilities: EntitlementCapability[]
  limits: EntitlementLimits
  checkedAt?: string
  expiresAt?: string
}

export type NoiseCleanupJobStatus =
  | 'queued'
  | 'processing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type NoiseCleanupPreset = 'speech-v1'

/** Durable backend-owned cleanup state. The renderer never infers completion
 * from a local process or row lifetime. */
export interface NoiseCleanupJob {
  id: string
  sourceSessionId: string
  status: NoiseCleanupJobStatus
  progressPercent: number
  preset: NoiseCleanupPreset
  outputSessionId?: string
  outputPath?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export type VideorcAccountStatus = 'signed-out' | 'signed-in'

// The desktop's Videorc PRODUCT account (mirrors the Rust VideorcAccountSnapshot).
// Not a YouTube/Twitch/X platform account; signed-out until real web auth + token
// storage populate it.
export interface VideorcAccountSnapshot {
  status: VideorcAccountStatus
  username?: string
  displayName?: string
  email?: string
  /** Account avatar (web-uploaded or Google) — load via the avatar cache. */
  avatarUrl?: string
}

export type DeviceKind = 'screen' | 'window' | 'camera' | 'microphone' | 'system-audio'
export type DeviceStatus = 'available' | 'unavailable' | 'permission-required'

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  status: DeviceStatus
  detail?: string
  width?: number
  height?: number
}

export interface DeviceList {
  devices: Device[]
  warnings: string[]
}

export type RecordingState = 'idle' | 'starting' | 'recording' | 'streaming' | 'stopping' | 'failed'

export interface RecordingStatus {
  state: RecordingState
  sessionId?: string
  outputPath?: string
  streamUrl?: string
  startedAt?: string
  audioTracks?: AudioTrack[]
  pipeline?: RecordingPipelineStatus
  durationMs?: number
  message?: string
}

export type AutomaticSourceFallbackSourceKind = 'capture' | 'camera' | 'microphone'
export type AutomaticSourceFallbackReason =
  | 'unavailable-selected'
  | 'unavailable-cleared'
  | 'restored-by-name'

export interface AutomaticSourceFallbackEvent {
  kind: 'automatic-source-fallback'
  sourceKind: AutomaticSourceFallbackSourceKind
  reason: AutomaticSourceFallbackReason
  previousId?: string
  previousName?: string
  nextId?: string
  nextName?: string
  sessionState?: RecordingState
  occurredAt?: string
}

export interface RendererDiagnosticsSnapshot {
  automaticSourceFallbacks: AutomaticSourceFallbackEvent[]
  runtimeInfo?: RuntimeInfo
}

export type AudioTrackSource = 'microphone' | 'test-tone'

export type RecordingContainer = 'none' | 'mkv' | 'flv' | 'tee'
export type RecordingFinalizationState = 'none' | 'finalizing' | 'finalized' | 'failed'
export type RecordingPipelineStage =
  | 'capture'
  | 'render'
  | 'video-encoder'
  | 'audio-encoder'
  | 'muxer'
export type RecordingPipelineStageState =
  | 'pending'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'finished'
  | 'failed'
  | 'skipped'

export interface RecordingPipelineStatus {
  container: RecordingContainer
  finalization: RecordingFinalizationState
  stages: RecordingPipelineStageStatus[]
}

export interface RecordingPipelineStageStatus {
  stage: RecordingPipelineStage
  state: RecordingPipelineStageState
  detail?: string
}

export interface AudioTrack {
  id: string
  label: string
  source: AudioTrackSource
}

export interface BackendLogEvent {
  level: 'info' | 'warn' | 'error' | string
  message: string
  timestamp: string
}

// F-014 supervisor lifecycle: emitted by main when the backend process dies
// and the supervisor restarts it (or gives up).
// Settings output-directory validation (ST2).
export interface DirectoryFacts {
  exists: boolean
  writable: boolean
  freeBytes: number | null
}

export type ResourceCapabilityKind =
  | 'input-file'
  | 'output-directory'
  | 'open-path'
  | 'reveal-path'
  | 'trash-path'
  | 'background-asset'

export interface ResourceSelection {
  capabilityId: string
  kind: ResourceCapabilityKind
  displayName: string
  directoryHandleId?: string
}

export interface BackendLifecycleEvent {
  state: 'running' | 'restarting' | 'failed'
  code?: number | null
  signal?: string | null
  attempt?: number
  delayMs?: number
}

export interface ClientCommand<TParams = unknown> {
  id: string
  method: string
  params?: TParams
}

export interface ServerResponse<TPayload = unknown> {
  id: string
  ok: boolean
  payload?: TPayload
  error?: {
    code: string
    message: string
  }
}

export interface ServerEvent<TPayload = unknown> {
  event: string
  payload: TPayload
}

/** One socket fell behind the bounded event channel and must refresh authoritative state. */
export interface EventsLaggedPayload {
  skipped: number
  occurredAt: string
}

export interface StartRecordingParams {
  outputDirectory?: string
  ffmpegPath?: string
}

export interface SourceSelection {
  screenId?: string
  screenName?: string
  windowId?: string
  windowName?: string
  cameraId?: string
  cameraName?: string
  microphoneId?: string
  microphoneName?: string
  testPattern?: boolean
}

export type CameraCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type CameraSize = 'small' | 'medium' | 'large'
export type CameraShape = 'rectangle' | 'rounded' | 'circle'
export type CameraAspect = 'source' | 'square' | 'portrait'
export type CameraFit = 'fit' | 'fill'
export type LayoutPreset =
  | 'screen-camera'
  | 'screen-only'
  | 'camera-only'
  | 'side-by-side'
  | 'vertical-camera-top'
  | 'vertical-camera-bottom'
  | 'vertical-split'
  | 'vertical-screen-camera'
  | 'vertical-screen-only'
  | 'vertical-camera-only'

/**
 * The Studio scene vocabularies by orientation mode, in gallery order. The
 * wire contracts (backend-rpc / electron-ipc) accept exactly their union —
 * a preset missing here is silently dropped by the main process's event
 * validation (the present pump retires), so these lists are load-bearing.
 */
export const HORIZONTAL_LAYOUT_PRESETS = [
  'screen-camera',
  'screen-only',
  'camera-only',
  'side-by-side'
] as const satisfies readonly LayoutPreset[]

export const VERTICAL_LAYOUT_PRESETS = [
  'vertical-camera-top',
  'vertical-camera-bottom',
  'vertical-split',
  'vertical-screen-camera',
  'vertical-screen-only',
  'vertical-camera-only'
] as const satisfies readonly LayoutPreset[]

export const LAYOUT_PRESET_VALUES = [
  ...HORIZONTAL_LAYOUT_PRESETS,
  ...VERTICAL_LAYOUT_PRESETS
] as const satisfies readonly LayoutPreset[]
export type CameraTransformMode = 'preset' | 'custom'
export type SideBySideSplit = '50-50' | '60-40' | '70-30'
export type SideBySideCameraSide = 'left' | 'right'

export interface CameraTransform {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutSettings {
  layoutPreset: LayoutPreset
  cameraTransformMode: CameraTransformMode
  cameraTransform: CameraTransform | null
  cameraCorner: CameraCorner
  cameraSize: CameraSize
  cameraShape: CameraShape
  /** Corner radius for the 'rounded' shape, % of the box's shorter side. */
  cameraCornerRadiusPct: number
  /** Camera box aspect: source (per-shape default), square, or portrait 3:4. */
  cameraAspect: CameraAspect
  /** Green-screen chroma key for the camera layer (off by default). */
  cameraChromaKeyEnabled: boolean
  /** Key color as #RRGGBB; the UI offers green/blue presets. */
  cameraChromaKeyColor: string
  /** CbCr distance (as % of the calibrated range) that keys fully out. */
  cameraChromaKeySimilarityPct: number
  /** Ramp band above similarity over which alpha rises (%; 0 = hard edge). */
  cameraChromaKeySmoothnessPct: number
  /** Spill suppression strength (%): kills the green/blue fringe. */
  cameraChromaKeySpillPct: number
  cameraMargin: number
  cameraFit: CameraFit
  cameraMirror: boolean
  cameraZoom: number
  cameraOffsetX: number
  cameraOffsetY: number
  sideBySideSplit: SideBySideSplit
  sideBySideCameraSide: SideBySideCameraSide
}

export type SceneSourceKind = 'screen' | 'window' | 'camera' | 'test-pattern'
export type SceneOutputKind = 'preview' | 'recording' | 'stream'

// Response of `scene.layout.apply_live` (live layout switching, plan slice D1/D2).
export interface LiveLayoutApplyStatus {
  applied: boolean
  mode: 'idle' | 'hot' | 'warm'
  sceneRevision: number
  scene: Scene
  message?: string
}

// Response of preview-visible scene mutation commands. The backend is the
// authority for committed scene revisions; the renderer may update UI optimistically
// but preview/compositor/native-surface sync must use this revision/status.
export interface SceneCommitStatus {
  applied: boolean
  mode: 'idle' | 'hot' | 'warm'
  sceneRevision: number
  scene: Scene
  compositorStatus: CompositorStatus
  message?: string
}

// The resolved background a scene renders: asset defaults merged with the scene's
// per-field overrides, plus the managed file the compositor reads (Assets Tab
// plan, slice A5). The renderer computes this; A6 renders it. Absent = no digital
// background, which is always valid.
export interface EffectiveSceneBackground {
  assetId: string
  managedAssetPath: string
  fit: 'fill' | 'fit' | 'stretch'
  scale: number
  offsetX: number
  offsetY: number
  blurPx: number
  dimPercent: number
  saturationPercent: number
  vignettePercent: number
  // How much of the screen the background ring occupies (0–40): stage margin
  // per side = visibilityPercent / 200. 0 keeps the recording full-canvas;
  // 20 is the classic 80% stage. Backend serde-defaults absent values to 20.
  visibilityPercent: number
}

export interface Scene {
  id: string
  name: string
  sources: SceneSource[]
  outputs: SceneOutput[]
  background?: EffectiveSceneBackground
}

export interface SceneSource {
  id: string
  name: string
  kind: SceneSourceKind
  deviceId?: string
  transform: SceneTransform
  defaultTransform: SceneTransform
  visible: boolean
  locked: boolean
}

export interface SceneTransform {
  x: number
  y: number
  width: number
  height: number
  cropLeft: number
  cropTop: number
  cropRight: number
  cropBottom: number
}

export interface SceneTransformPatch {
  x?: number
  y?: number
  width?: number
  height?: number
  cropLeft?: number
  cropTop?: number
  cropRight?: number
  cropBottom?: number
}

export interface SceneOutput {
  id: string
  kind: SceneOutputKind
  width: number
  height: number
  fps: number
}

export interface SceneConfigParams {
  sources: SourceSelection
  layout: LayoutSettings
  video?: VideoSettings
  background?: EffectiveSceneBackground
  protectedOverlayWindowIds?: number[]
}

export interface SceneTransformUpdateParams {
  sourceId: string
  transform: SceneTransformPatch
}

export interface SceneSourceParams {
  sourceId: string
}

export interface SceneSourceVisibilityParams {
  sourceId: string
  visible: boolean
}

export interface SceneSourceOrderParams {
  sourceIds: string[]
}

export interface SceneSourceNudgeParams {
  sourceId: string
  directionX: number
  directionY: number
  large?: boolean
}

// --- LS1: active-session scene revision model ---
// Mirrors crates/videorc-backend/src/live_scene.rs. The model owns the revision +
// event contract only; a committed revision does not reach the live FFmpeg output
// until the live render consumer (LS2+) is wired.

export type ApplyMode = 'hot' | 'warm' | 'cold'

export type MutationKind =
  | 'layout.set_preset'
  | 'layout.patch'
  | 'source.transform.patch'
  | 'source.visibility.set'
  | 'source.order.set'
  | 'source.device.switch'
  | 'audio.mic.patch'
  | 'output.resolution.patch'
  | 'output.fps.patch'
  | 'output.bitrate.patch'

export type LiveEditStatus = 'started' | 'applied' | 'failed' | 'reverted'

export type SourceRuntimePhase =
  | 'idle'
  | 'starting'
  | 'live'
  | 'reconnecting'
  | 'failed'
  | 'permission-needed'

export type SessionMode = 'idle' | 'recording' | 'streaming' | 'recording-streaming'

export interface SceneMutation {
  id: string
  expectedRevision: number
  kind: MutationKind
  /** The renderer's optimistic guess. Advisory — the backend reclassifies. */
  applyMode?: ApplyMode
  payload?: unknown
  createdAt: string
}

export interface LiveEditEvent {
  id: string
  sessionId: string
  mutationId: string
  revisionBefore: number
  revisionAfter?: number
  applyMode: ApplyMode
  status: LiveEditStatus
  message?: string
  timestamp: string
}

export interface SourceRuntimeState {
  sourceId: string
  deviceId?: string
  state: SourceRuntimePhase
  message?: string
  lastFrameAt?: string
}

export interface ActiveSceneState {
  sessionId: string
  sceneId: string
  revision: number
  layout: LayoutSettings
  sources: SceneSource[]
  outputs: SceneOutputKind[]
  mode: SessionMode
  updatedAt: string
}

export type RtmpPreset = 'youtube' | 'twitch' | 'x' | 'custom'
export type VideoPreset =
  | 'tutorial-1080p30'
  | 'tutorial-1440p30'
  | 'record-4k30'
  | 'record-4k60-experimental'
  | 'stream-safe-1080p30'
  | 'stream-safe-1080p60'
  | 'stream-youtube-4k30'
  | 'stream-1080p60'
  | 'vertical-1080x1920'
  | 'custom'

export interface VideoSettings {
  preset: VideoPreset
  width: number
  height: number
  fps: number
  bitrateKbps: number
}

export interface RtmpSettings {
  preset: RtmpPreset
  serverUrl: string
  streamKey: string
}

// Multi-platform streaming (per-target) model. Replaces the single RtmpSettings
// streaming config over phases M1-M4; today it is migrated alongside the legacy
// fields and not yet consumed by session start.
export type StreamPlatform = 'youtube' | 'twitch' | 'x' | 'custom'
export type StreamUrlMode = 'server-and-key' | 'full-url'
export type StreamAuthMode = 'manual-rtmp' | 'oauth'
export type StreamPrivacy = 'public' | 'unlisted' | 'private'
export type PlatformAccountStatus = 'connected' | 'needs-reconnect' | 'disconnected'
export type PlatformAccountValidationState = 'valid' | 'refreshed' | 'needs-reconnect' | 'missing'
export type StreamTargetState =
  | 'not-configured'
  | 'ready'
  | 'connecting'
  | 'live'
  | 'warning'
  | 'failed'
  | 'stopped'

export interface StreamTargetStatus {
  state: StreamTargetState
  message?: string
  redactedUrl?: string
  lastError?: string
  droppedFrames?: number
  bitrateKbps?: number
}

export interface StreamTargetSettings {
  id: string
  platform: StreamPlatform
  label: string
  enabled: boolean
  serverUrl: string
  urlMode?: StreamUrlMode
  // Raw only while a manual key is being edited or loaded from legacy config.
  // Saved OAuth/manual keys use streamKeySecretRef plus streamKeyPresent.
  streamKey: string
  streamKeySecretRef?: string
  streamKeyPresent: boolean
  // Masked tail ("••••1234") of the saved key so the UI can say WHICH key is
  // stored; hydrated from the backend, never the secret itself.
  streamKeyHint?: string
  // A replaced or cleared key is archived per target; restorable in one click.
  previousStreamKeyPresent?: boolean
  previousStreamKeyHint?: string
  authMode: StreamAuthMode
  accountId?: string
  accountLabel?: string
  platformBroadcastId?: string
  platformStreamId?: string
  outputPreset?: VideoPreset
  outputBitrateKbps?: number
  status?: StreamTargetStatus
  createdAt: string
  updatedAt: string
}

export interface StreamingSettings {
  enabled: boolean
  mode: 'single' | 'multi'
  targets: StreamTargetSettings[]
  selectedTargetId?: string
  defaultOutputPreset: VideoPreset
  defaultBitrateKbps: number
  enabledTargetIds: string[]
}

export interface PlatformAccount {
  id: string
  platform: StreamPlatform
  accountId: string
  accountLabel: string
  accountHandle?: string
  avatarUrl?: string
  scopes: string[]
  accessTokenPresent: boolean
  refreshTokenPresent: boolean
  streamKeyPresent: boolean
  expiresAt?: string
  connectedAt: string
  updatedAt: string
  status: PlatformAccountStatus
}

export interface PlatformAccountPlatformParams {
  platform: StreamPlatform
}

export interface PlatformAccountValidation {
  platform: StreamPlatform
  state: PlatformAccountValidationState
  accountId?: string
  accountLabel?: string
  scopes: string[]
  expiresAt?: string
  message: string
}

export interface StreamMetadataDraft {
  title: string
  description: string
  defaultPrivacy: StreamPrivacy
  targetOverrides: StreamTargetMetadataDraft[]
  updatedAt: string
}

export interface StreamTargetMetadataDraft {
  platform: StreamPlatform
  customize: boolean
  title: string
  description: string
  privacy: StreamPrivacy
  youtubeMadeForKids?: boolean
  twitchCategoryId?: string
  twitchCategoryName?: string
  twitchLanguage?: string
  /**
   * X has no unlisted/private concept — the only reach lever is suppressing
   * the announcement post. Undefined means announce (the platform default).
   */
  xAnnounce?: boolean
  updatedAt: string
}

export interface StreamMetadataValidation {
  valid: boolean
  issues: StreamMetadataValidationIssue[]
}

export interface StreamMetadataValidationIssue {
  field: string
  message: string
  platform?: StreamPlatform
}

export interface StoreManualStreamKeyParams {
  targetId: string
  streamKey: string
}

export interface StoreManualStreamKeyResult {
  streamKeySecretRef?: string
  streamKeyPresent: boolean
  streamKeyHint?: string
  previousStreamKeyPresent: boolean
  previousStreamKeyHint?: string
}

export interface YouTubePrepareParams {
  accountId?: string
  video: VideoSettings
}

export interface PreparedYouTubeBroadcast {
  platform: 'youtube'
  accountId: string
  accountLabel: string
  broadcastId: string
  streamId: string
  serverUrl: string
  streamKeySecretRef: string
  streamKeyPresent: boolean
  redactedUrl: string
  title: string
  description: string
  privacy: StreamPrivacy
  madeForKids: boolean
  scheduledStartTime: string
}

export type YouTubeBroadcastTransitionStatus = 'complete' | 'live' | 'testing'

export interface YouTubeBroadcastTransitionParams {
  accountId?: string
  broadcastId: string
  status: YouTubeBroadcastTransitionStatus
}

export interface YouTubeBroadcastTransitionResult {
  platform: 'youtube'
  accountId: string
  broadcastId: string
  requestedStatus: YouTubeBroadcastTransitionStatus
  lifecycleStatus?: string
  message: string
}

export interface YouTubeStreamStatusParams {
  accountId?: string
  streamId: string
}

export interface YouTubeStreamStatusResult {
  platform: 'youtube'
  accountId: string
  streamId: string
  streamStatus?: string
  healthStatus?: string
  active: boolean
  message: string
}

export interface YouTubeChannelListParams {
  accountId?: string
}

export interface YouTubeChannelListResult {
  platform: 'youtube'
  accountId: string
  channels: YouTubeChannel[]
}

export interface YouTubeChannelSelectParams {
  accountId?: string
  channelId: string
}

export interface YouTubeChannel {
  channelId: string
  title: string
  handle?: string
  avatarUrl?: string
}

export interface TwitchPrepareParams {
  accountId?: string
}

export interface TwitchCategorySearchParams {
  accountId?: string
  query: string
  first?: number
}

export interface TwitchCategorySearchResult {
  categories: TwitchCategory[]
}

export interface TwitchCategory {
  id: string
  name: string
  boxArtUrl?: string
}

/** Result of `streamTargets.twitch.applyMetadata` — channel metadata pushed without touching the stream key. */
export interface TwitchAppliedMetadata {
  platform: 'twitch'
  accountId: string
  accountLabel: string
  title: string
  categoryId?: string
  categoryName?: string
  language?: string
}

export interface PreparedTwitchBroadcast {
  platform: 'twitch'
  accountId: string
  accountLabel: string
  serverUrl: string
  streamKeySecretRef: string
  streamKeyPresent: boolean
  redactedUrl: string
  title: string
  categoryId?: string
  categoryName?: string
  language?: string
}

export type XNativeLiveCapabilityState =
  | 'missing-credentials'
  | 'needs-authorization'
  | 'ready'
  | 'account-mismatch'
  | 'api-error'

/** Result of `streamTargets.x.startLiveAuthorization` — the 3-legged OAuth 1.0a browser flow. */
export interface XLiveAuthorizationStart {
  authUrl: string
  redirectUri: string
  expiresAt: string
}

export interface XNativeLiveCapabilityParams {
  accountId?: string
}

export interface XPrepareParams {
  accountId?: string
}

export interface XPublishParams {
  accountId?: string
  sourceId: string
  region: string
  isLowLatency: boolean
  /** Active capture session — X lifecycle events land in its session log. */
  sessionId?: string
}

export interface XEndParams {
  accountId?: string
  broadcastId: string
  sessionId?: string
}

export interface XLiveChatStartParams {
  sessionId: string
  broadcastId: string
  mediaKey: string
  targetId?: string
  statusBaseUrl?: string
  accessUrl?: string
}

export interface XNativeLiveCapability {
  platform: 'x'
  state: XNativeLiveCapabilityState
  nativeAvailable: boolean
  manualRtmpAvailable: boolean
  oauthConnected: boolean
  accountId?: string
  accountLabel?: string
  credentialSource?: string
  message: string
  evidence: string[]
  docsUrl: string
  apiOverviewUrl: string
}

export interface PreparedXStreamSource {
  platform: 'x'
  accountId: string
  accountLabel: string
  sourceId: string
  region: string
  serverUrl: string
  streamKeySecretRef: string
  streamKeyPresent: boolean
  redactedUrl: string
  isStreamActive: boolean
  recommendedConfiguration?: unknown
  compatibilityInfo?: unknown
  /** How prepare picked the source (env-override | reused-name-match | adopted-measured | created). */
  selection: string
  deletedRetiredSourceIds: string[]
}

export interface XPublishResult {
  platform: 'x'
  accountId: string
  sourceId: string
  broadcastId: string
  mediaKey: string
  mediaId?: string
  shareUrl: string
  state: string
  tweetId?: string
  tweetError?: string
  hlsUrl?: string
  playableBeforePublish?: boolean
  prePublishWaitMs?: number
  compatibilityInfo?: unknown
  message: string
}

/** `streamTargets.x.playback` event — the post-publish watchability probe. */
export interface XPlaybackEvent {
  sessionId?: string | null
  broadcastId: string
  shareUrl: string
  status: 'verified' | 'pending' | 'unavailable'
  msAfterPublish?: number
}

export interface XEndResult {
  platform: 'x'
  accountId: string
  broadcastId: string
  message: string
}

export interface GoLivePreflightParams {
  streaming: StreamingSettings
}

export interface GoLivePreflight {
  valid: boolean
  destinations: GoLiveDestinationPreflight[]
  issues: GoLivePreflightIssue[]
}

export interface GoLiveDestinationPreflight {
  targetId: string
  platform: StreamPlatform
  label: string
  authMode: StreamAuthMode
  ready: boolean
  title: string
  description: string
  accountId?: string
  accountLabel?: string
  message: string
  chatRead: CommentsReadState
  chatWrite: CommentsWriteState
  chatMessage: string
}

export type GoLivePreflightIssueSeverity = 'warning' | 'error'

export interface GoLivePreflightIssue {
  targetId?: string
  platform?: StreamPlatform
  severity: GoLivePreflightIssueSeverity
  message: string
}

export interface OAuthStartParams {
  platform: StreamPlatform
  authorizationUrl: string
  clientId: string
  scopes?: string[]
  redirectUri?: string
  extraParams?: Record<string, string>
}

export interface OAuthStartProviderParams {
  platform: StreamPlatform
  redirectUri?: string
}

export interface OAuthStartResult {
  platform: StreamPlatform
  state: string
  authUrl: string
  redirectUri: string
  expiresAt: string
}

export interface OAuthProviderCredentialStatus {
  platform: StreamPlatform
  ready: boolean
  clientIdPresent: boolean
  clientSecretPresent: boolean
  clientIdSource: 'bundled' | 'environment' | 'missing'
  pkce: boolean
  message: string
}

export interface OAuthCompleteParams {
  state: string
  code?: string
  error?: string
  errorDescription?: string
}

export type OAuthCallbackStatus = 'success' | 'failed' | 'expired' | 'unknown-state'

export interface OAuthCallbackResult {
  platform?: StreamPlatform
  state: string
  status: OAuthCallbackStatus
  codePresent: boolean
  error?: string
  message?: string
  tokenStored: boolean
  accountConnected: boolean
  retryable: boolean
  receivedAt: string
}

export interface StreamSessionTargetHistory {
  targetId: string
  platform: StreamPlatform
  label: string
  attempted: boolean
  skipped: boolean
  statusTimeline: StreamTargetStatus[]
  redactedUrl?: string
}

/**
 * Per-target runtime status during an active session, emitted (as a list) on the
 * `stream.targets` snapshot event (M5). Distinct from the persisted
 * StreamTargetSettings.status; the renderer keys these by targetId and clears them
 * when the session returns to idle.
 */
export interface StreamTargetRuntime {
  targetId: string
  platform: StreamPlatform
  label: string
  state: StreamTargetState
  message?: string
  redactedUrl?: string
}

export interface StreamTargetsSnapshot {
  sessionId: string
  targets: StreamTargetRuntime[]
}

export interface OutputSettings {
  recordEnabled: boolean
  streamEnabled: boolean
  outputDirectory?: string
  outputDirectoryCapability?: string
  ffmpegPath?: string
  video: VideoSettings
  rtmp: RtmpSettings
}

export interface StartSessionParams {
  sources: SourceSelection
  layout: LayoutSettings
  scene?: Scene
  output: OutputSettings
  audio?: AudioSettings
  streaming?: StreamingSettings
  captions?: CaptionsSessionParams
}

/** Burn-in intent for the session (shapes output legs; see burn-in plan A0/R1)
 *  plus the styling the post-recording captioned copy uses. */
export interface CaptionsSessionParams {
  enabled: boolean
  /** Explicit per-session skip or an output shape that cannot be pre-armed. */
  suppressedForSession: boolean
  burnTarget: 'off' | 'stream' | 'recording' | 'both'
  styleId: CaptionStyleId
  language: string
  styleRevision: number
  position?: 'top' | 'bottom'
  textSize?: 's' | 'm' | 'l'
}

export interface AudioSettings {
  microphoneGainDb: number
  microphoneMuted: boolean
  microphoneSyncOffsetMs: number
  microphoneSyncOffsetUserSet?: boolean
}

export interface AudioProcessingUpdateParams {
  sessionId: string
  microphoneGainDb: number
  microphoneMuted: boolean
}

export interface AudioProcessingUpdateResult extends AudioProcessingUpdateParams {
  applied: boolean
  reasonCode?:
    | 'no-active-session'
    | 'stale-session'
    | 'native-audio-unavailable'
    | 'live-audio-control-unavailable'
    | 'live-audio-control-state-unknown'
    | 'session-ended'
  /** Present when the backend can conclusively report settings remaining after rejection. */
  confirmedMicrophoneGainDb?: number
  /** Present when the backend can conclusively report settings remaining after rejection. */
  confirmedMicrophoneMuted?: boolean
}

export interface RemuxSessionParams {
  sessionId: string
  ffmpegPath?: string
}

export interface PreviewSnapshotParams {
  sources: SourceSelection
  layout: LayoutSettings
  ffmpegPath?: string
}

export interface PreviewSnapshot {
  id: string
  url: string
  createdAt: string
}

export type PreviewLiveState = 'connecting' | 'live' | 'reconnecting' | 'unavailable'
export type PreviewLiveSource = 'idle-preview' | 'recording-session' | 'unavailable'
export type PreviewTransport =
  | 'native-surface'
  | 'electron-proof-surface'
  | 'latest-jpeg-polling'
  | 'mjpeg-stream'
  | 'unavailable'

/** Which encoder a recording session requested. Hardware encoders may still fall back
 * internally, so this is the requested backend; the final-file codec/encoder tag is the
 * corroborating output-side signal. */
export type EncodeBackend =
  | 'software-x264'
  | 'hardware-videotoolbox'
  | 'hardware-media-foundation'
  | 'software-media-foundation'
export type CompositorBackend = 'metal' | 'cpu' | 'cpu-fallback'

/** Cumulative request counts for the HTTP image-polling preview transports. A native
 * preview never fetches these, so a session in which they climb is not actually native. */
export interface PreviewImagePollCounts {
  cameraPng: number
  screenPng: number
  liveJpeg: number
  liveMjpeg: number
}

export interface PreviewLiveStatus {
  state: PreviewLiveState
  source: PreviewLiveSource
  transport: PreviewTransport
  backing: PreviewSurfaceBacking
  targetFps?: number
  width?: number
  height?: number
  url?: string
  message?: string
}

export interface PreviewSurfaceBounds {
  screenX: number
  screenY: number
  width: number
  height: number
  scaleFactor: number
  screenHeight?: number
  // Optional clip rect in the same absolute screen coordinate space as
  // screenX/screenY. Absent means "treat the full rect as visible".
  clipX?: number
  clipY?: number
  clipWidth?: number
  clipHeight?: number
  // False when the preview window is not visible; the native host must hide the
  // surface entirely.
  visible?: boolean
  // Detached preview window stacking: the global window number of the Electron
  // preview window the native surface sits directly above (normal level), and
  // whether the pair floats above other apps (always-on-top).
  orderAboveWindowId?: number
  elevated?: boolean
}

export type NativePreviewHostCommandKind = 'create' | 'update-bounds' | 'destroy'

export interface NativePreviewHostCommand {
  kind: NativePreviewHostCommandKind
  bounds?: PreviewSurfaceBounds
}

export type PreviewSurfaceState = 'unavailable' | 'starting' | 'live' | 'stopped' | 'failed'
export type PreviewSurfaceSource = 'synthetic' | 'camera' | 'screen' | 'window'
export type PreviewSurfaceBacking = 'cametal-layer' | 'electron-browser-window' | 'none'
export type CompositorState = 'stopped' | 'starting' | 'live' | 'failed'
export type CompositorSourceKind = 'camera' | 'screen' | 'window'
export type CompositorSceneSourceKind = SceneSourceKind | 'screen-image' | 'background-image'
export type CompositorSceneSourceFit = 'contain' | 'cover'

export interface CompositorSourceStatus {
  kind: CompositorSourceKind
  state: string
  sourceId?: string
  sequence?: number
  width?: number
  height?: number
  sourceFps?: number
  frameAgeMs?: number
  message?: string
}

export interface CompositorSceneSourceStatus {
  id: string
  name: string
  kind: CompositorSceneSourceKind
  state: string
  deviceId?: string
  visible: boolean
  transform: SceneTransform
  fit: CompositorSceneSourceFit
  mirror: boolean
  shape?: CameraShape
  imagePath?: string
  fileRevision?: string
  width?: number
  height?: number
  message?: string
}

export interface CompositorSceneUpdateParams {
  revision: number
  scene: Scene | null
  layout: LayoutSettings
  activeScreen?: StreamScreen | null
}

export interface CompositorImageCacheStatus {
  budgetBytes: number
  entryBudget: number
  entries: number
  decodedBytes: number
  preconvertedBgraBytes: number
  residentBytes: number
  pinnedEntries: number
  pinnedBytes: number
  hits: number
  misses: number
  evictions: number
}

export interface CompositorFramePipelineStatus {
  consumer?: string
  gpuReadbacks: number
  bgraBytesCopied: number
  yuvFramesConverted: number
  immutableTextureUploads: number
  immutableTextureReuses: number
}

export interface CompositorStatus {
  state: CompositorState
  targetFps: number
  width: number
  height: number
  runId?: string
  sceneRevision?: number
  frameSceneRevision?: number
  sceneId?: string
  sceneLayout?: LayoutSettings
  /** Persisted takeover-image id; native capture identity is carried by sceneSources and sources. */
  activeScreenId?: string
  sceneSources: CompositorSceneSourceStatus[]
  sources: CompositorSourceStatus[]
  renderFps?: number
  framesRendered: number
  repeatedFrames: number
  droppedFrames: number
  frameAgeMs?: number
  frameTimeP95Ms?: number
  /** IOSurface id for the latest retained Metal compositor target; handoff only, not a native-preview claim. */
  metalTargetIosurfaceId?: number
  metalTargetWidth?: number
  metalTargetHeight?: number
  imageCache?: CompositorImageCacheStatus
  framePipeline?: CompositorFramePipelineStatus
  updatedAt: string
  message?: string
}

/** Capacity-one/latest-wins notification used by native preview presentation. */
export interface CompositorFrameReady {
  targetFps: number
  width: number
  height: number
  runId?: string
  sceneRevision?: number
  frameSceneRevision?: number
  framesRendered: number
  frameAgeMs?: number
  metalTargetIosurfaceId?: number
  metalTargetWidth?: number
  metalTargetHeight?: number
  updatedAt: string
}

export type PreviewSurfaceSceneLayerKind = SceneSourceKind | 'screen-image' | 'background'
export type PreviewSurfaceSceneLayerFit = 'contain' | 'cover' | 'fill'

export interface PreviewSurfaceSceneLayer {
  id: string
  name: string
  kind: PreviewSurfaceSceneLayerKind
  transform: SceneTransform
  visible: boolean
  frameUrl?: string
  imageUrl?: string
  fit: PreviewSurfaceSceneLayerFit
  mirror: boolean
  shape?: CameraShape
}

export interface PreviewSurfaceSceneState {
  revision: number
  sceneId?: string
  layout: LayoutSettings
  sources: PreviewSurfaceSceneLayer[]
  /** Persisted takeover-image id, not the selected native capture device id. */
  activeScreenId?: string
  /** Normalized per-side inset derived from background visibilityPercent. */
  backgroundStageMargin?: number
  updatedAt: string
}

export interface PreviewSurfaceSceneUpdateParams {
  revision: number
  scene: Scene | null
  layout: LayoutSettings
  activeScreen?: StreamScreen | null
}

export interface PreviewSurfaceCompositorUpdateParams extends CompositorStatus {
  suppressFramePolling?: boolean
  nativePreviewRendererPollIntervalP95Ms?: number
  nativePreviewRendererPollRoundTripP95Ms?: number
  nativePreviewRendererPresentRoundTripP95Ms?: number
  nativePreviewRendererPollInFlightSkips?: number
  nativePreviewMainStatusFetchP95Ms?: number
  nativePreviewMainStatusFetchFailures?: number
  nativePreviewMainStatusFetchSuccesses?: number
  nativePreviewMainPresentedStatusAgeMs?: number
  nativePreviewMainPresentedStatusAgeP95Ms?: number
  nativePreviewMainPresentedFrameAgeP95Ms?: number
  nativePreviewMainSceneMismatchCount?: number
  nativePreviewMainSceneMismatchAgeMs?: number
  nativePreviewMainLastSkippedSceneRevision?: number
  nativePreviewMainLastSkippedFrameSceneRevision?: number
}

export interface PreviewSurfaceStatus {
  /** IPC-only ownership acknowledgement for renderer compositor presents. */
  compositorUpdateAccepted?: boolean
  state: PreviewSurfaceState
  source: PreviewSurfaceSource
  transport: PreviewTransport
  backing: PreviewSurfaceBacking
  targetFps: number
  width: number
  height: number
  framesRendered: number
  presentedFrameId?: number
  compositorFrameLag?: number
  droppedFrames: number
  inputToPresentLatencyMs?: number
  inputToPresentLatencyP50Ms?: number
  inputToPresentLatencyP95Ms?: number
  inputToPresentLatencyP99Ms?: number
  presentFps?: number
  intervalP95Ms?: number
  intervalP99Ms?: number
  nativePreviewRendererPollIntervalP95Ms?: number
  nativePreviewRendererPollRoundTripP95Ms?: number
  nativePreviewRendererPresentRoundTripP95Ms?: number
  nativePreviewRendererPollInFlightSkips?: number
  nativePreviewMainQueueWaitP95Ms?: number
  nativePreviewMainPresentP95Ms?: number
  nativePreviewMainQueuedBehindCount?: number
  nativePreviewMainCoalescedFrameCount?: number
  nativePreviewMutationQueueCapacity?: number
  nativePreviewMutationQueueDepth?: number
  nativePreviewMutationQueueActiveCount?: number
  nativePreviewMutationQueuePendingCount?: number
  nativePreviewMutationQueueMaxDepth?: number
  nativePreviewMutationQueueRejectedCount?: number
  nativePreviewHelperRoundTripP95Ms?: number
  nativePreviewMainStatusFetchP95Ms?: number
  nativePreviewMainStatusFetchFailures?: number
  nativePreviewMainStatusFetchSuccesses?: number
  nativePreviewMainPresentedStatusAgeMs?: number
  nativePreviewMainPresentedStatusAgeP95Ms?: number
  nativePreviewMainPresentedFrameAgeP95Ms?: number
  nativePreviewMainSceneMismatchCount?: number
  nativePreviewMainSceneMismatchAgeMs?: number
  nativePreviewMainLastSkippedSceneRevision?: number
  nativePreviewMainLastSkippedFrameSceneRevision?: number
  nativePreviewHostKind?: 'in-process' | 'helper-process' | 'external-module' | 'proof-surface'
  nativePreviewHostAttached?: boolean
  nativePreviewPlacementEventsReceived?: number
  nativePreviewPlacementsCoalesced?: number
  nativePreviewPlacementsApplied?: number
  nativePreviewPlacementRoundTripP95Ms?: number
  nativePreviewPresentRoundTripP95Ms?: number
  nativePreviewIosurfaceCacheHits?: number
  nativePreviewIosurfaceImports?: number
  nativePreviewIosurfaceInvalidations?: number
  nativePreviewIosurfaceImportFailures?: number
  nativePreviewDrawableWidth?: number
  nativePreviewDrawableHeight?: number
  nativePreviewContentsScale?: number
  nativePreviewPresentedSceneRevision?: number
  nativePreviewCompositorRunId?: string
  framePollingSuppressed: boolean
  sourcePixelsPresent: boolean
  pendingHostCommandCount: number
  bounds?: PreviewSurfaceBounds
  startedAt?: string
  updatedAt: string
  message?: string
  // First-frame contract (native-preview-first-frame.ts): from preview open the
  // app either presents a native frame of the committed scene within budget,
  // self-heals, or declares fallback with the blocked link — never an
  // unexplained indefinite wait.
  firstFrameContract?: 'pending' | 'healing' | 'met' | 'fallback'
  firstFrameReason?: string
}

export interface PreviewSurfacePresentParams {
  transport?: PreviewTransport
  backing?: PreviewSurfaceBacking
  presentedFrameId?: number
  compositorFrameLag?: number
  droppedFrames: number
  inputToPresentLatencyMs?: number
  inputToPresentLatencyP50Ms?: number
  inputToPresentLatencyP95Ms?: number
  inputToPresentLatencyP99Ms?: number
  presentFps?: number
  intervalP95Ms?: number
  intervalP99Ms?: number
  nativePreviewRendererPollIntervalP95Ms?: number
  nativePreviewRendererPollRoundTripP95Ms?: number
  nativePreviewRendererPresentRoundTripP95Ms?: number
  nativePreviewRendererPollInFlightSkips?: number
  nativePreviewMainQueueWaitP95Ms?: number
  nativePreviewMainPresentP95Ms?: number
  nativePreviewMainQueuedBehindCount?: number
  nativePreviewMainCoalescedFrameCount?: number
  nativePreviewHelperRoundTripP95Ms?: number
  nativePreviewMainStatusFetchP95Ms?: number
  nativePreviewMainStatusFetchFailures?: number
  nativePreviewMainStatusFetchSuccesses?: number
  nativePreviewMainPresentedStatusAgeMs?: number
  nativePreviewMainPresentedStatusAgeP95Ms?: number
  nativePreviewMainPresentedFrameAgeP95Ms?: number
  nativePreviewMainSceneMismatchCount?: number
  nativePreviewMainSceneMismatchAgeMs?: number
  nativePreviewMainLastSkippedSceneRevision?: number
  nativePreviewMainLastSkippedFrameSceneRevision?: number
  message?: string
  framePollingSuppressed?: boolean
  sourcePixelsPresent?: boolean
}

export interface PreviewSurfaceCreateParams {
  bounds: PreviewSurfaceBounds
  targetFps?: number
  source?: PreviewSurfaceSource
}

export interface PreviewSurfaceBoundsParams {
  bounds: PreviewSurfaceBounds
}

export type PreviewCameraState =
  | 'starting'
  | 'live'
  | 'permission-needed'
  | 'device-missing'
  | 'failed'

export interface PreviewCameraStartParams {
  sources: SourceSelection
  layout: LayoutSettings
  video: VideoSettings
  ffmpegPath?: string
}

export interface PreviewCameraStatus {
  state: PreviewCameraState
  cameraId?: string
  deviceUniqueId?: string
  targetFps: number
  width?: number
  height?: number
  requestedWidth?: number
  requestedHeight?: number
  actualWidth?: number
  actualHeight?: number
  selectedFormatWidth?: number
  selectedFormatHeight?: number
  selectedFormatMinFps?: number
  selectedFormatMaxFps?: number
  sourceFps?: number
  frameAgeMs?: number
  framesCaptured: number
  droppedFrames: number
  sequence?: number
  updatedAt: string
  message?: string
}

export interface CameraCapabilityFormat {
  width: number
  height: number
  minFps: number
  maxFps: number
}

export type PreviewScreenState =
  | 'starting'
  | 'live'
  | 'permission-needed'
  | 'source-missing'
  | 'failed'
export type PreviewScreenSourceKind = 'screen' | 'window'

export interface PreviewScreenStartParams {
  sources: SourceSelection
  video: VideoSettings
  protectedOverlayWindowIds?: number[]
  ffmpegPath?: string
}

export interface PreviewScreenStatus {
  state: PreviewScreenState
  sourceId?: string
  sourceKind?: PreviewScreenSourceKind
  targetFps: number
  width?: number
  height?: number
  nativeWidth?: number
  nativeHeight?: number
  requestedWidth?: number
  requestedHeight?: number
  actualWidth?: number
  actualHeight?: number
  iosurfaceAvailable?: boolean
  sourceFps?: number
  frameAgeMs?: number
  framesCaptured: number
  droppedFrames: number
  sequence?: number
  includeCursor: boolean
  excludeCurrentProcessWindows: boolean
  updatedAt: string
  message?: string
}

export interface PreviewLiveParams {
  sources: SourceSelection
  layout: LayoutSettings
  ffmpegPath?: string
  video?: VideoSettings
}

export interface AudioMeterParams {
  microphoneId?: string
  ffmpegPath?: string
  microphoneGainDb?: number
  microphoneMuted?: boolean
}

export type AudioMeterStatus =
  | 'ready'
  | 'silent'
  | 'no-frames'
  | 'unavailable'
  | 'permission-required'

export interface AudioMeterResult {
  status: AudioMeterStatus
  level?: number
  peakDb?: number
  meanDb?: number
  message?: string
}

export interface AudioMeterSampleSnapshot {
  microphoneId?: string
  result: AudioMeterResult
  sampledAt: string
}

export interface AudioMeterProbeParams {
  ffmpegPath?: string
  microphoneGainDb?: number
  microphoneMuted?: boolean
}

export interface AudioMeterDeviceProbe {
  device: Device
  result: AudioMeterResult
}

export interface AudioMeterDeviceProbeResult {
  sampledAt: string
  probes: AudioMeterDeviceProbe[]
}

export interface StreamHealth {
  sessionId: string
  fps?: number
  droppedFrames?: number
  speed?: number
  createdAt: string
}

export type DiagnosticBottleneck =
  | 'none'
  | 'capture'
  | 'render'
  | 'encoder'
  | 'preview'
  | 'audio'
  | 'device'
  | 'unknown'

export type SourceRegistrySourceKind = 'camera' | 'screen' | 'window' | 'image' | 'synthetic'
export type SourceRegistryLifecycleStatus =
  | 'stopped'
  | 'starting'
  | 'live'
  | 'permission-needed'
  | 'source-missing'
  | 'failed'
export type SourceRegistryConsumerReason = 'preview' | 'recording' | 'streaming' | 'diagnostics'
export type SourceRegistryIdentityConfidence = 'exact' | 'name-rematch' | 'fallback' | 'unknown'

export interface SourceRegistryKey {
  kind: SourceRegistrySourceKind
  id: string
}

export interface SourceRegistryEntrySnapshot {
  key: SourceRegistryKey
  status: SourceRegistryLifecycleStatus
  consumers: SourceRegistryConsumerReason[]
  identityConfidence: SourceRegistryIdentityConfidence
}

export interface SourceRegistrySnapshot {
  entries: SourceRegistryEntrySnapshot[]
}

export interface WebSocketQueueDiagnosticStats {
  currentDepth: number
  maxDepth: number
  oldestAgeMs?: number
  coalescedCount: number
  evictedOrDroppedCount: number
}

export interface WebSocketTransportDiagnosticStats {
  reliableResponseQueue: WebSocketQueueDiagnosticStats
  incomingCommandQueue: WebSocketQueueDiagnosticStats
  coalescedTelemetryQueue: WebSocketQueueDiagnosticStats
  slowPressureDisconnectCount: number
}

export interface DiagnosticStats {
  sessionId?: string
  activeOutputMode?: string
  activeSceneRevision?: number
  targetFps?: number
  captureFps?: number
  renderFps?: number
  skippedFrames: number
  droppedFrames: number
  encoderSpeed?: number
  encoderBridgeQueueDepth: number
  /** Oldest frame waiting for VideoToolbox completion or FIFO output. */
  encoderBridgeOutputQueueOldestFrameAgeMs?: number
  /** Enqueue attempts that encountered a full bounded output queue. */
  encoderBridgeOutputQueueCapacityPressureEvents: number
  /** Frames intentionally discarded by output backpressure policy. */
  encoderBridgeOutputQueueDroppedFrames: number
  encoderBridgeInputFps?: number
  encoderBridgeDroppedFrames: number
  /** Compositor frames re-fed to the encoder on under-run (duplicate frames in the final file). */
  encoderBridgeRepeatedFrames: number
  /** Distinct bridge under-run bursts; helps separate phase misses from clustered stalls. */
  encoderBridgeRepeatedFrameBursts: number
  /** Longest consecutive duplicate re-feed run observed by the bridge. */
  encoderBridgeMaxRepeatedFrameRun: number
  /** Ticks where synthetic filler was fed because no real compositor frame was ready. */
  encoderBridgeSyntheticFrames: number
  /** Max age (ms) of a compositor frame when it was fed to the encoder. */
  encoderBridgeSourceAgeMs?: number
  /** P95 age (ms) of compositor frames when they were fed to the encoder. */
  encoderBridgeSourceAgeP95Ms?: number
  /** P95 age (ms) of compositor frames re-fed as duplicate bridge frames. */
  encoderBridgeRepeatedFrameAgeP95Ms?: number
  /** Max age (ms) of compositor frames re-fed as duplicate bridge frames. */
  encoderBridgeRepeatedFrameAgeMaxMs?: number
  /** FIFO ticks whose copied compositor frame also exposed an IOSurface-backed Metal target. */
  encoderBridgeMetalTargetFrames: number
  /** FIFO frames still written through raw-video FFmpeg stdin. */
  encoderBridgeRawVideoCopiedFrames: number
  /** Raw-video writes where the source frame had an IOSurface-backed Metal target. */
  encoderBridgeMetalTargetCopiedFrames: number
  /** Raw-video writes where the bridge received the retained CoreVideo handle. */
  encoderBridgeMetalTargetHandleFrames: number
  /** Frames submitted to the encoder without a CPU raw-video copy. */
  encoderBridgeZeroCopyFrames: number
  /** Opt-in production-thread VideoToolbox probe frames; not final zero-copy output. */
  encoderBridgeVideoToolboxProbeFrames: number
  encoderBridgeVideoToolboxProbeBytes: number
  encoderBridgeVideoToolboxProbeErrors: number
  /** Retained Metal target frames written through the production VideoToolbox H.264 output. */
  encoderBridgeVideoToolboxOutputFrames: number
  encoderBridgeVideoToolboxOutputBytes: number
  /** Max inline VideoToolbox encode latency observed by the bridge writer. */
  encoderBridgeVideoToolboxOutputEncodeMs?: number
  /** Local recording output profile used by split-output sessions. */
  recordingOutputWidth?: number
  recordingOutputHeight?: number
  recordingOutputFps?: number
  recordingOutputBitrateKbps?: number
  /** Livestream output profile used by split-output sessions. */
  streamOutputWidth?: number
  streamOutputHeight?: number
  streamOutputFps?: number
  streamOutputBitrateKbps?: number
  /** Number of distinct production VideoToolbox output encoders active for the session. */
  encoderBridgeActiveVideoToolboxOutputEncoders: number
  /** Frames/bytes produced by the local-recording VideoToolbox output encoder. */
  encoderBridgeRecordingVideoToolboxOutputFrames: number
  encoderBridgeRecordingVideoToolboxOutputBytes: number
  /** Frames/bytes produced by the livestream VideoToolbox output encoder. */
  encoderBridgeStreamVideoToolboxOutputFrames: number
  encoderBridgeStreamVideoToolboxOutputBytes: number
  /** True only when diagnostics prove separate record and stream output encoders. */
  encoderBridgeSeparateOutputEncodersActive: boolean
  /** P95 wait for the bridge writer to receive a compositor frame. */
  encoderBridgeCompositorWaitP95Ms?: number
  /** P95 time spent submitting retained targets into VideoToolbox. */
  encoderBridgeVideoToolboxSubmitP95Ms?: number
  /** P95 time the raw-video FIFO worker spent writing one frame into FFmpeg. */
  encoderBridgeRawVideoFifoWriteP95Ms?: number
  /** P95 time spent writing completed VideoToolbox H.264 access units into FFmpeg. */
  encoderBridgeVideoToolboxFifoWriteP95Ms?: number
  /** P95 time spent waiting to enqueue encoded VideoToolbox frames for the FIFO writer. */
  encoderBridgeVideoToolboxFifoEnqueueP95Ms?: number
  /** Max time spent waiting to enqueue encoded VideoToolbox frames for the FIFO writer. */
  encoderBridgeVideoToolboxFifoEnqueueMaxMs?: number
  /** P95 end-to-end bridge writer loop time, including intentional CFR sleep. */
  encoderBridgeWriterLoopP95Ms?: number
  /** P95 time spent sleeping until the bridge writer's scheduled CFR deadline. */
  encoderBridgeWriterSleepP95Ms?: number
  /** P95 active bridge writer work after scheduled-deadline sleep. */
  encoderBridgeWriterActiveP95Ms?: number
  /** P95 schedule lag for bridge writer ticks that missed their CFR deadline during the session. */
  encoderBridgeDeadlineLagP95Ms?: number
  /** Max bridge writer schedule lag observed during the active session. */
  encoderBridgeDeadlineLagMaxMs?: number
  /** Cumulative bridge writer ticks that started late against their CFR deadline. */
  encoderBridgeLateDeadlineTicks: number
  encoderBridgeScheduleSkippedMs: number
  /** Recording-leg bridge input FPS for split-output sessions. */
  encoderBridgeRecordingInputFps?: number
  /** Stream-leg bridge input FPS for split-output sessions. */
  encoderBridgeStreamInputFps?: number
  /** Recording-leg output queue state for split-output sessions. */
  encoderBridgeRecordingQueueDepth: number
  encoderBridgeRecordingQueueOldestFrameAgeMs?: number
  encoderBridgeRecordingQueueCapacityPressureEvents: number
  encoderBridgeRecordingQueueDroppedFrames: number
  /** Streaming-leg output queue state for split-output sessions. */
  encoderBridgeStreamQueueDepth: number
  encoderBridgeStreamQueueOldestFrameAgeMs?: number
  encoderBridgeStreamQueueCapacityPressureEvents: number
  encoderBridgeStreamQueueDroppedFrames: number
  /** Recording-leg bridge writer p95 for split-output sessions. */
  encoderBridgeRecordingWriterLoopP95Ms?: number
  /** Stream-leg bridge writer p95 for split-output sessions. */
  encoderBridgeStreamWriterLoopP95Ms?: number
  /** Recording-leg active writer work p95 for split-output sessions. */
  encoderBridgeRecordingWriterActiveP95Ms?: number
  /** Stream-leg active writer work p95 for split-output sessions. */
  encoderBridgeStreamWriterActiveP95Ms?: number
  /** Recording-leg FIFO enqueue wait p95 for split-output sessions. */
  encoderBridgeRecordingVideoToolboxFifoEnqueueP95Ms?: number
  /** Stream-leg FIFO enqueue wait p95 for split-output sessions. */
  encoderBridgeStreamVideoToolboxFifoEnqueueP95Ms?: number
  /** Recording-leg FIFO enqueue max wait for split-output sessions. */
  encoderBridgeRecordingVideoToolboxFifoEnqueueMaxMs?: number
  /** Stream-leg FIFO enqueue max wait for split-output sessions. */
  encoderBridgeStreamVideoToolboxFifoEnqueueMaxMs?: number
  encoderBridgeError?: string
  /** Which encoder the active session requested — proves hardware vs software encode. */
  encodeBackend?: EncodeBackend
  /** Which compositor backend produced the most recent diagnostic window. */
  compositorBackend?: CompositorBackend
  /** Why the compositor had to render on CPU fallback. */
  compositorFallbackReason?: string
  /** Cumulative frames rendered by CPU fallback during the active compositor run. */
  compositorCpuFallbackFrames: number
  websocketTransport: WebSocketTransportDiagnosticStats
  /** Cumulative HTTP image-poll request counts; the transport-honesty gate fails when these climb during a "native" preview session. */
  previewImagePollCounts: PreviewImagePollCounts
  /** True when an active recording is being compromised by a measured problem. Drives the "Recording at risk" badge. */
  recordingAtRisk: boolean
  /** Human-readable reasons backing recordingAtRisk. */
  recordingRiskReasons: string[]
  /** True when recording consumes the shared compositor output via the protected encoder-bridge path. */
  recordingProtected: boolean
  /** Startup barrier state before protected recording begins encoding. */
  recordingStartupBarrierState?: string
  recordingStartupBarrierWaitMs?: number
  recordingStartupBarrierTimeoutReason?: string
  firstSourceFrameMs?: number
  firstFullResolutionCompositorFrameMs?: number
  firstEncodedFrameMs?: number
  previewTargetFps?: number
  previewFrameAgeMs?: number
  previewTransport: PreviewTransport
  previewSourceFps: Record<string, number>
  previewSurfaceBacking: PreviewSurfaceBacking
  previewFramePollingSuppressed: boolean
  previewSourcePixelsPresent: boolean
  previewPresentFps?: number
  previewInputToPresentLatencyMs?: number
  previewInputToPresentLatencyP50Ms?: number
  previewInputToPresentLatencyP95Ms?: number
  previewInputToPresentLatencyP99Ms?: number
  previewCompositorFrameLag?: number
  previewRenderFrameTimeP50Ms?: number
  previewRenderFrameTimeP95Ms?: number
  previewRenderFrameTimeP99Ms?: number
  /** P95 time spent fetching latest live source frame handles for a compositor tick. */
  compositorSourceFetchP95Ms?: number
  /** P95 time spent snapshotting compositor scene/frame-store handles. */
  compositorSceneSnapshotP95Ms?: number
  /** P95 time spent fetching the latest camera frame handle. */
  compositorCameraFrameFetchP95Ms?: number
  /** P95 time spent fetching the latest screen/window frame handle. */
  compositorScreenFrameFetchP95Ms?: number
  /** P95 time spent preparing visible scene sources before Metal draw work. */
  compositorGpuPrepareP95Ms?: number
  /** P95 time spent allocating/updating live source Metal textures. */
  compositorGpuSourceTextureP95Ms?: number
  /** Cumulative live-source frames imported from IOSurface storage into Metal. */
  compositorSourceIosurfaceImportFrames: number
  /** Cumulative live-source frames imported from CVPixelBuffer storage into Metal. */
  compositorSourceCvpixelbufferImportFrames: number
  /** Cumulative live-source frames uploaded to Metal from CPU BGRA bytes. */
  compositorSourceByteUploadFrames: number
  /** Cumulative live-source zero-copy import attempts that fell back to byte upload. */
  compositorSourceImportFailures: number
  /** Cumulative camera frames imported from IOSurface storage into Metal. */
  compositorCameraSourceIosurfaceImportFrames: number
  /** Cumulative camera frames imported from CVPixelBuffer storage into Metal. */
  compositorCameraSourceCvpixelbufferImportFrames: number
  /** Cumulative camera frames uploaded to Metal from CPU BGRA bytes. */
  compositorCameraSourceByteUploadFrames: number
  /** Cumulative camera zero-copy import attempts that fell back to byte upload. */
  compositorCameraSourceImportFailures: number
  /** Cumulative screen/window frames imported from IOSurface storage into Metal. */
  compositorScreenSourceIosurfaceImportFrames: number
  /** Cumulative screen/window frames imported from CVPixelBuffer storage into Metal. */
  compositorScreenSourceCvpixelbufferImportFrames: number
  /** Cumulative screen/window frames uploaded to Metal from CPU BGRA bytes. */
  compositorScreenSourceByteUploadFrames: number
  /** Cumulative screen/window zero-copy import attempts that fell back to byte upload. */
  compositorScreenSourceImportFailures: number
  /** P95 time spent importing/uploading source textures in the latest diagnostics window. */
  compositorSourceImportP95Ms?: number
  /** P95 time spent waiting for the Metal command buffer to complete. */
  compositorGpuCommandWaitP95Ms?: number
  /** P95 total time spent in the Metal compose call. */
  compositorGpuTotalP95Ms?: number
  /** P95 time spent publishing the completed compositor frame to the shared store. */
  compositorFrameStorePublishP95Ms?: number
  /** P95 wall-clock interval between compositor ticks. */
  compositorTickGapP95Ms?: number
  /** Max wall-clock interval between compositor ticks in the latest diagnostics window. */
  compositorTickGapMaxMs?: number
  /** P95 time spent refreshing cached live source handles outside the render block. */
  compositorLiveSourceRefreshP95Ms?: number
  /** P95 time spent updating preview-surface progress outside the render block. */
  compositorPreviewSurfaceProgressP95Ms?: number
  /** P95 time spent updating compositor progress outside the render block. */
  compositorStatusProgressP95Ms?: number
  /** Compositor ticks that skipped preview-surface progress because the lock was busy. */
  compositorPreviewSurfaceLockContentions: number
  /** Compositor ticks that skipped compositor progress because the lock was busy. */
  compositorStatusLockContentions: number
  /** Compositor ticks where camera source try-lock was busy and the cached camera frame was reused. */
  compositorCameraSourceTryLockMisses: number
  /** Compositor ticks where screen/window source try-lock was busy and the cached screen/window frame was reused. */
  compositorScreenSourceTryLockMisses: number
  /** Bounded blocking camera refreshes after source-store contention or visibly stale cached camera frames. */
  compositorCameraSourceBlockingRefreshes: number
  /** Bounded blocking screen/window refreshes after source-store contention or visibly stale cached screen/window frames. */
  compositorScreenSourceBlockingRefreshes: number
  previewRepeatedFrames: number
  previewSurfaceResizeCount: number
  previewLatencyMs?: number
  previewDroppedFrames: number
  previewCameraFrameAgeMs?: number
  previewCameraSourceFps?: number
  previewCameraDroppedFrames: number
  /** Latest native camera state reported by the AVFoundation preview source. */
  previewCameraState?: PreviewCameraState
  /** Native AVFoundation unique ID for the selected camera. */
  previewCameraDeviceUniqueId?: string
  /** Latest native camera status message, including permission/device-missing reasons. */
  previewCameraStatusMessage?: string
  /** Camera capture width requested by layout/output policy. */
  previewCameraRequestedWidth?: number
  /** Camera capture height requested by layout/output policy. */
  previewCameraRequestedHeight?: number
  /** Latest actual camera frame width received from AVFoundation. */
  previewCameraActualWidth?: number
  /** Latest actual camera frame height received from AVFoundation. */
  previewCameraActualHeight?: number
  /** Selected native AVFoundation format width. */
  previewCameraSelectedFormatWidth?: number
  /** Selected native AVFoundation format height. */
  previewCameraSelectedFormatHeight?: number
  /** Selected native AVFoundation format minimum FPS. */
  previewCameraSelectedFormatMinFps?: number
  /** Selected native AVFoundation format maximum FPS. */
  previewCameraSelectedFormatMaxFps?: number
  /** Native AVFoundation camera whose capability matrix was sampled. */
  previewCameraCapabilityDeviceId?: string
  /** Structured AVFoundation camera format matrix: one entry per resolution/fps range. */
  previewCameraCapabilityFormats: CameraCapabilityFormat[]
  /** Human-readable reason the camera capability matrix could not be sampled. */
  previewCameraCapabilityError?: string
  /** P95 interval between AVFoundation camera sample callbacks. */
  previewCameraCaptureGapP95Ms?: number
  /** P99 interval between AVFoundation camera sample callbacks. */
  previewCameraCaptureGapP99Ms?: number
  /** Max interval between AVFoundation camera sample callbacks. */
  previewCameraCaptureGapMaxMs?: number
  /** P95 interval between AVFoundation camera sample presentation timestamps. */
  previewCameraSamplePtsGapP95Ms?: number
  /** P99 interval between AVFoundation camera sample presentation timestamps. */
  previewCameraSamplePtsGapP99Ms?: number
  /** Max interval between AVFoundation camera sample presentation timestamps. */
  previewCameraSamplePtsGapMaxMs?: number
  /** P95 time spent locking the AVFoundation camera CVPixelBuffer base address. */
  previewCameraPixelBufferLockP95Ms?: number
  /** P95 time spent copying BGRA rows out of the AVFoundation camera sample. */
  previewCameraRowCopyP95Ms?: number
  /** P95 wall time spent publishing the copied camera frame to the source frame store. */
  previewCameraPublishP95Ms?: number
  /** Bytes copied for the latest native camera capture frame. */
  previewCameraFrameBytes: number
  previewScreenFrameAgeMs?: number
  previewScreenSourceFps?: number
  previewScreenDroppedFrames: number
  /** Latest native ScreenCaptureKit status message, including permission/startup errors. */
  previewScreenMessage?: string
  /** Native ScreenCaptureKit source width selected for the live screen/window source. */
  previewScreenNativeWidth?: number
  /** Native ScreenCaptureKit source height selected for the live screen/window source. */
  previewScreenNativeHeight?: number
  /** Width requested from ScreenCaptureKit after production capture policy selection. */
  previewScreenRequestedWidth?: number
  /** Height requested from ScreenCaptureKit after production capture policy selection. */
  previewScreenRequestedHeight?: number
  /** Actual latest ScreenCaptureKit frame width received from CoreVideo. */
  previewScreenActualWidth?: number
  /** Actual latest ScreenCaptureKit frame height received from CoreVideo. */
  previewScreenActualHeight?: number
  /** Whether the latest ScreenCaptureKit frame retained a zero-copy source handle. */
  previewScreenIosurfaceAvailable?: boolean
  /** P95 interval between ScreenCaptureKit screen sample callbacks. */
  previewScreenCaptureGapP95Ms?: number
  /** Max interval between ScreenCaptureKit screen sample callbacks. */
  previewScreenCaptureGapMaxMs?: number
  /** P95 time spent locking the ScreenCaptureKit CVPixelBuffer base address. */
  previewScreenPixelBufferLockP95Ms?: number
  /** P95 time spent copying BGRA rows out of the ScreenCaptureKit sample. */
  previewScreenRowCopyP95Ms?: number
  /** P95 wall time spent publishing the copied screen frame to the source frame store. */
  previewScreenPublishP95Ms?: number
  /** Bytes copied for the latest native screen capture frame. */
  previewScreenFrameBytes: number
  /** ScreenCaptureKit queue depth requested for the live screen source. */
  previewScreenCaptureQueueDepth: number
  previewSourceFrameBufferCount: number
  previewSourceFrameBytes: number
  previewSourceFrameDroppedFrames: number
  micCapturedFrames?: number
  micDroppedFrames: number
  /** Fraction of expected audio sample-frames actually captured during the run (live); below ~0.95 signals a mic capture gap. */
  micCaptureCoverage?: number
  /** Live mic meter (0-1, dB-scaled) from the active session's own capture
   * frames; absent when no session is live. Drives the Studio mixer. */
  micLiveLevel?: number
  micLivePeakDb?: number
  deviceDisconnected: boolean
  backendRssBytes?: number
  activeFfmpegProcesses: number
  activeFfprobeProcesses: number
  ffmpegCaptureActive: boolean
  ffmpegFinalizingActive: boolean
  ffmpegMaintenanceRunning: boolean
  ffmpegMaintenanceCancelRequested: boolean
  ffmpegMaintenanceDeferredReason?: string
  duplicateCaptureSources: string[]
  sourceRegistry: SourceRegistrySnapshot
  bottleneck: DiagnosticBottleneck
  updatedAt: string
}

export type HealthLevel = 'info' | 'warn' | 'error'
export type SystemPermissionPane = 'privacy' | 'screen-recording' | 'camera' | 'microphone'

// Mirrors Electron systemPreferences.getMediaAccessStatus return values, plus
// 'unknown' for platforms/errors where it cannot be read.
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MediaAccessSnapshot {
  camera: MediaAccessStatus
  microphone: MediaAccessStatus
}

export interface HealthEvent {
  id: string
  sessionId?: string
  level: HealthLevel
  code: string
  message: string
  permissionPane?: SystemPermissionPane
  createdAt: string
}

export interface SessionLogEntry {
  id: string
  sessionId: string
  level: HealthLevel
  code: string
  message: string
  sourceId?: string
  permissionPane?: SystemPermissionPane
  createdAt: string
}

export interface RunAiWorkflowParams {
  sessionId: string
  consentToUploadAudio: boolean
  ffmpegPath?: string
}

export interface AiWorkflowResult {
  sessionId: string
  audioPath: string
  artifacts: AiArtifact[]
}

/** A clip-worthy time range, ranked locally from chat activity + captions. */
export interface ClipMoment {
  startMs: number
  endMs: number
  reason: string
  excerpt: string
}

export interface ClipSuggestResult {
  sessionId: string
  moments: ClipMoment[]
  chatMessageCount: number
}

export interface ClipExportResult {
  sessionId: string
  path: string
}

export interface ExportPublishPackResult {
  sessionId: string
  markdownPath: string
  /** Every file the export wrote (markdown + per-field paste-ready files). */
  files?: string[]
}

export interface AiCapabilities {
  /** Optional during rolling web deployments. Missing must fail closed when captions are enabled. */
  captions?: {
    available: boolean
    preferredTransport: CaptionTransport | null
    reasonCode:
      | 'ai-disabled'
      | 'ai-user-disabled'
      | 'captions-disabled'
      | 'captions-invalid-config'
      | 'captions-monthly-quota-exhausted'
      | 'captions-not-configured'
      | 'cloud-ai-premium-required'
      | 'ready-chunked-realtime-disabled'
      | 'ready-chunked-realtime-unconfigured'
      | 'ready-realtime'
    monthlySecondsLimit?: number | null
    remainingSeconds?: number | null
    realtime: {
      available: boolean
      configured: boolean
      disabled: boolean
      model: string
    }
    chunked: {
      available: boolean
      configured: boolean
      model: string
    }
  }
  entitlement: {
    checkedAt: string
    cloudAi: boolean
    expiresAt: string
    isPremium: boolean
    subscriptionStatus: string
    tier: string
  }
  features: {
    cloudAiEnabled: boolean
    gatewayConfigured: boolean
    modelTestingEnabled: boolean
    multipartAudioJobsEnabled: boolean
    objectBackedJobsEnabled: boolean
    transcriptJobsEnabled: boolean
    uploadTicketsEnabled: boolean
  }
  generatedAt: string
  limits: {
    dailyJobs: number
    maxAudioBytes: number | null
    maxAudioMegabytes: number | null
    maxOutputTokens: number | null
    maxTranscriptCharacters: number
    monthlyJobs: number
  }
  models: {
    allowedTextModelCount: number
    allowedTextModelsConfigured: boolean
    defaultTextModel: string | null
    fallbackTextModels: string[]
  }
  objectStorage: {
    deleteConfigured: boolean
    downloadConfigured: boolean
    provider: string | null
    providerError: string | null
    proofConfigured: boolean
    proofTtlMs: number | null
    uploadConfigured: boolean
  }
  readiness: {
    access: {
      cloudAiEntitled: boolean
      globallyDisabled: boolean
    }
    gateway: {
      configError: string | null
      configured: boolean
    }
    objectStorage: {
      deleteConfigError: string | null
      downloadConfigError: string | null
      proofConfigError: string | null
      providerError: string | null
      uploadConfigError: string | null
    }
    transcription: {
      configError: string | null
      configured: boolean
    }
    worker: {
      configError: string | null
      configured: boolean
      queuedJobDelayMs: number
      recentlyRanAt: string | null
      runningJobTimeoutMs: number
      status: 'unknown' | 'unconfigured' | string
    }
  }
  transcription: {
    configured: boolean
    configError: string | null
    maxAudioBytes: number | null
    maxAudioMegabytes: number | null
    requestTimeoutMs: number | null
  }
  workflow: {
    inputModes: Array<{
      enabled: boolean
      kind: 'multipart-audio' | 'stored-audio-object' | 'transcript' | string
    }>
    kind: string
    outputs: string[]
    // Per-kind generation contract (videorc-web PR #1); absent on older servers.
    supportsOutputsFilter?: boolean
    supportsTone?: boolean
    supportsTitleVariants?: boolean
    supportsChatContext?: boolean
    supportsSocialPosts?: boolean
    supportsHighlightTimestamps?: boolean
  }
}

export interface AiQuotaStatus {
  access: {
    allowed: boolean
    code: string | null
    message: string | null
    status: number | null
  }
  entitlement: {
    cancelAtPeriodEnd: boolean
    checkedAt: string
    cloudAi: boolean
    currentPeriodEnd: string | null
    expiresAt: string
    isPremium: boolean
    subscriptionStatus: string
    tier: string
  }
  generatedAt: string
  monthly: {
    limit: number
    remaining: number
    resetAt: string
    used: number
  }
  today: {
    limit: number
    remaining: number
    resetAt: string
    used: number
  }
}

export interface AiJobSnapshot {
  artifacts?: {
    creatorIntelligence: unknown
    publishPack: unknown
    transcript: { text: string } | null
    transcriptionMetadata: unknown
  }
  clientRequestId: string | null
  completedAt: string | null
  costEstimateCents: number | null
  createdAt: string
  errorCode: string | null
  errorMessage: string | null
  fallbackModels: string[]
  id: string
  inputTokens: number | null
  model: string | null
  outputJson: unknown
  outputTokens: number | null
  provider: string
  runAttempts: number
  sessionClientId: string
  startedAt: string | null
  status: string
  workflowKind: string
}

export type AiArtifactKind =
  | 'audio-extract'
  | 'transcript'
  | 'title-description'
  | 'summary'
  | 'chapters'
  | 'highlights'
  | 'social-posts'
  | 'smart-zoom'
  | 'noise-cleanup'
  | 'silence-removal'
  | 'health-assistant'
export type AiArtifactStatus = 'ready' | 'pending-consent' | 'failed'

export interface AiArtifact {
  id: string
  sessionId: string
  kind: AiArtifactKind
  status: AiArtifactStatus
  content: unknown
  filePath?: string | null
  createdAt: string
}

export interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt?: string
  status: string
  mode: string
  outputPath?: string
  mp4Path?: string
  streamPreset?: string
  container?: RecordingContainer
  durationMs?: number
  /** Size of the visible file — live while it exists, last-known when missing. */
  fileSizeBytes?: number
  /** "Screen + Camera" etc. (derived layout preset; stream preset when stream-only). */
  sceneLabel?: string
  qualityStatus?: GateStatus | null
  finalDiagnostics?: DiagnosticStats | null
  layout: LayoutSettings
  sources: SourceSelection
  healthEvents: HealthEvent[]
  sessionLogs: SessionLogEntry[]
  aiArtifacts: AiArtifact[]
  commentCount: number
  /** Present only for managed derivatives created from another Library session. */
  derivedFromSessionId?: string
  sourceTitle?: string
  processingKind?: 'noise-cleanup'
}

export interface SessionStorageTotals {
  count: number
  totalBytes: number
}

/** Renderer-safe handle for a durable Library delete. Electron main resolves
 * the operation id over its admin backend channel immediately before Trash. */
export interface SessionDeletionOperation {
  operationId: string
  sessionId: string
  pathCount: number
  blockedPathCount: number
}

/** Backend result after Electron reports which Trash moves, if any, failed. */
export interface SessionDeletionCompletion {
  sessionId: string
  deleted: boolean
  pendingPaths: string[]
}

export interface SessionCommentsListParams {
  sessionId: string
  cursor?: string
  limit?: number
}

export const DEFAULT_SESSION_COMMENTS_PAGE_LIMIT = 200

export function normalizeSessionCommentsListParams(
  params: SessionCommentsListParams
): SessionCommentsListParams & { limit: number } {
  return {
    ...params,
    limit: params.limit ?? DEFAULT_SESSION_COMMENTS_PAGE_LIMIT
  }
}

export interface SessionCommentsPage {
  messages: LiveChatMessage[]
  nextCursor?: string
}

export type StreamScreenStatus = 'ready' | 'missing'

export interface StreamScreen {
  id: string
  name: string
  imagePath: string
  thumbnailPath?: string
  sortOrder: number
  status: StreamScreenStatus
  createdAt: string
  updatedAt: string
}

export interface ImportScreenImageParams {
  path: string
  ffmpegPath?: string
}

export interface ScreenIdParams {
  screenId: string
}

export interface RenameScreenParams {
  screenId: string
  name: string
}

export interface ReorderScreensParams {
  screenIds: string[]
}

export interface RuntimeInfo {
  /** The running app version (`app.getVersion()`), shown in Settings → About. */
  version: string
  platform: string
  arch: string
  osRelease: string
  gpuDevices: RuntimeGpuDevice[]
  /** True when Videorc is running with hardware acceleration disabled — via
   * VIDEORC_DISABLE_GPU=1 or the persisted GPU-crash fallback. Surfaced so
   * support bundles name the active graphics mode. */
  hardwareAccelerationDisabled: boolean
  isPackaged: boolean
  permissionTargetName: string
  permissionTargetPath: string
  capturePermissionTargetName: string
  capturePermissionTargetPath: string
  nativePreviewSurfaceProofEnabled: boolean
  notesWindowEnabled?: boolean
  notesWindowRecordingOverlayAllowed?: boolean
  commentsWindowEnabled?: boolean
  commentsWindowRecordingOverlayAllowed?: boolean
  previewSmokeMode?: boolean
  /** Enables the fixed, packaged Windows live-microphone acceptance bridge. */
  windowsLiveAudioSmokeMode?: boolean
  disableAutoPreview?: boolean
  disableAutoSourcePreview?: boolean
  nativePreviewSurfaceStageSuspended?: boolean
}

export interface RuntimeGpuDevice {
  vendorId?: string | number
  deviceId?: string | number
  active?: boolean
  vendor?: string
  description?: string
}

// Floating: the user drags/resizes the preview window freely (default).
// Docked ("stick"): the window is a child of the main window, glued over the
// Studio preview slot so it moves together with the app.
export type PreviewWindowMode = 'floating' | 'docked'

// Why a docked preview surface is currently hidden; the Studio slot turns each
// reason into stated copy — a docked preview never silently vanishes.
export type DockHiddenReason =
  | 'no-slot-report'
  | 'slot-unmounted'
  | 'scrolled-away'
  | 'overlay-open'
  | 'main-window-hidden'
  | 'main-window-fullscreen'

// Renderer → main slot measurement for docked mode. WINDOW-RELATIVE CSS pixels
// only: the renderer must never compute screen coordinates (main owns the
// window-position math synchronously; see preview-dock.ts).
export interface DockSlotReport {
  epoch: number
  x: number
  y: number
  width: number
  height: number
  visibleFraction: number
  mounted: boolean
}

export type CommentsSendOperationPhase =
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'delivery-unknown'

export type DestinationDeliveryPhase =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'read-only'
  | 'unavailable'
  | 'timed-out-unknown'

export interface DestinationDelivery {
  destinationId: string
  platform: StreamPlatform
  phase: DestinationDeliveryPhase
  providerMessageId?: string
  reason?: string
}

/** One persisted, idempotent send-to-all operation. */
export interface CommentsSendOperation {
  id: string
  sessionId: string
  text: string
  phase: CommentsSendOperationPhase
  destinations: DestinationDelivery[]
  createdAt: string
  updatedAt: string
}

export interface CommentsSendCommand {
  requestId: string
  operationId: string
  sessionId: string
  text: string
}

export interface CommentsClearCommand {
  requestId: string
  sessionId: string
}

export interface CommentHighlightCommand {
  requestId: string
  sessionId: string
  messageId: string
}

export type CommentHighlightPhase = 'idle' | 'live' | 'failed'

export interface CommentHighlightState {
  sessionId?: string
  messageId?: string
  generation: number
  phase: CommentHighlightPhase
  expiresAt?: string
  reason?: string
}

export interface SetCommentHighlightParams {
  sessionId: string
  messageId: string
  pngBase64: string
  position: 'top' | 'bottom'
}

export interface CommentsCommandResolution<T> {
  requestId: string
  ok: boolean
  value?: T
  error?: string
}

export type CommentsViewMode =
  | { kind: 'live' }
  | { kind: 'history'; sessionId: string; title: string; startedAt: string }

export interface CommentsViewSnapshot {
  mode: CommentsViewMode
  snapshot: LiveChatSnapshot
  latestSendOperation?: CommentsSendOperation
}

// Detached preview window: main is the lifecycle and bounds authority; renderer
// surface requests must carry this generation so stale effects cannot mutate the
// active preview.
export interface PreviewWindowState {
  open: boolean
  visible: boolean
  // The VIDEO region of the preview window: content minus the top drag bar.
  contentBounds: { x: number; y: number; width: number; height: number } | null
  scaleFactor: number
  screenHeight: number
  alwaysOnTop: boolean
  mode: PreviewWindowMode
  // Dock epoch the renderer must echo in DockSlotReport; reports for an older
  // epoch were measured before the latest dock engage and are dropped by main.
  dockEpoch: number
  dockHiddenReason: DockHiddenReason | null
  supervisor: PreviewSupervisorState
}

export type PreviewLifecycleState =
  | 'closed'
  | 'opening-window'
  | 'open-no-surface'
  | 'starting-surface'
  | 'surface-live'
  | 'surface-fallback'
  | 'permission-required'
  | 'closing'
  | 'failed'

export type PreviewPermissionStatus =
  | 'ok'
  | 'screen-recording-required'
  | 'camera-required'
  | 'unknown'

export type PreviewLifecycleTransport = PreviewTransport | 'none' | 'unknown'
export type PreviewLifecycleBacking = PreviewSurfaceBacking | 'unknown'

export interface PreviewSupervisorState {
  lifecycleState: PreviewLifecycleState
  generation: number
  windowOpen: boolean
  windowVisible: boolean
  surfaceRequested: boolean
  surfaceActive: boolean
  transport: PreviewLifecycleTransport
  backing: PreviewLifecycleBacking
  permissionStatus: PreviewPermissionStatus
  fallbackReason?: string
  lastError?: string
  updatedAt: string
}

export type NotesFontScale = 'sm' | 'md' | 'lg'

export interface NotesWindowState {
  open: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  windowId?: number
  alwaysOnTop: boolean
  protected: boolean
  enabled: boolean
  message?: string
}

export interface NotesDocument {
  text: string
  fontScale: NotesFontScale
  updatedAt: string
}

export interface CommentsWindowState {
  open: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  windowId?: number
  alwaysOnTop: boolean
  protected: boolean
  enabled: boolean
  message?: string
}

// Blurred-wallpaper glass underlay: real window-backdrop blur is unavailable
// (Electron's vibrancy material renders opaque on current macOS), so the
// renderer blurs the actual wallpaper as its own bottom layer instead, with
// main feeding the image and the window/display geometry that keeps it
// aligned to where the window really sits.
export interface GlassRect {
  x: number
  y: number
  width: number
  height: number
}

export interface GlassWallpaperState {
  imageDataUrl: string
  window: GlassRect
  display: GlassRect
}

/**
 * App self-update lifecycle (electron-updater), surfaced in Settings →
 * About & updates. `phase` drives the UI; the renderer subscribes via
 * `onUpdateStatus` and seeds from `getUpdateStatus`. `unsupported` is reported
 * when the app is not packaged (dev runs are not updatable).
 */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; percent: number; version?: string }
  | { phase: 'downloaded'; version: string }
  | { phase: 'not-available'; currentVersion: string }
  | { phase: 'error'; message: string }
  | { phase: 'unsupported' }

export type AccountCallbackEnvelope = {
  id: string
  url: string
  state: string
  intentGeneration: number
  receivedAtMs: number
  expiresAtMs: number
}

export type OAuthCallbackEnvelope = {
  id: string
  url: string
  state: string
  receivedAtMs: number
}

export interface VideorcApi {
  getBackendConnection: () => Promise<BackendConnection | null>
  getBackendLogs: () => Promise<BackendLogEvent[]>
  getRuntimeInfo: () => Promise<RuntimeInfo>
  pickScreenImage: () => Promise<ResourceSelection | null>
  pickFile: () => Promise<ResourceSelection | null>
  pickDirectory: () => Promise<ResourceSelection | null>
  checkDirectory: (directoryHandleId: string) => Promise<DirectoryFacts>
  authorizeOutputDirectory: (directoryHandleId: string) => Promise<ResourceSelection>
  // Picks a PNG/JPG/WebP and copies it into app-support storage, returning the
  // managed asset (Assets Tab plan, slice A4).
  importBackgroundImage: () => Promise<BackgroundImportResult | null>
  backgroundAssetExists: (assetId: string) => Promise<boolean>
  /** Fetch-and-cache a chat avatar from an allowlisted platform CDN; returns a
   * local videorc-asset:// URL or null (disallowed host / fetch failure). */
  cacheChatAvatar: (url: string) => Promise<string | null>
  /** Correlated Comments-window command relay; the main renderer owns the backend socket. */
  sendCommentHighlight: (command: CommentHighlightCommand) => Promise<CommentHighlightState>
  onCommentHighlightRequest: (callback: (command: CommentHighlightCommand) => void) => () => void
  pushCommentHighlightResult: (
    resolution: CommentsCommandResolution<CommentHighlightState>
  ) => Promise<boolean>
  pushCommentHighlightState: (state: CommentHighlightState) => Promise<void>
  getCommentHighlightState: () => Promise<CommentHighlightState>
  onCommentHighlightState: (callback: (state: CommentHighlightState) => void) => () => void
  sendChatFromCommentsWindow: (command: CommentsSendCommand) => Promise<CommentsSendOperation>
  onChatSendRequest: (callback: (command: CommentsSendCommand) => void) => () => void
  pushChatSendResult: (
    resolution: CommentsCommandResolution<CommentsSendOperation>
  ) => Promise<boolean>
  clearComments: (command: CommentsClearCommand) => Promise<LiveChatSnapshot>
  onCommentsClearRequest: (callback: (command: CommentsClearCommand) => void) => () => void
  pushCommentsClearResult: (
    resolution: CommentsCommandResolution<LiveChatSnapshot>
  ) => Promise<boolean>
  getBundledBackgroundAssets: () => Promise<BackgroundImportResult[]>
  beginAccountSignIn: (authorizeUrl: string) => Promise<void>
  signOutAccount: () => Promise<VideorcAccountSnapshot>
  getPendingAccountCallbacks: () => Promise<AccountCallbackEnvelope[]>
  acknowledgeAccountCallback: (callbackId: string) => Promise<boolean>
  onAccountCallback: (callback: (envelope: AccountCallbackEnvelope) => void) => () => void
  getPendingOAuthCallbacks: () => Promise<OAuthCallbackEnvelope[]>
  acknowledgeOAuthCallback: (callbackId: string) => Promise<boolean>
  openOAuthUrl: (authUrl: string) => Promise<void>
  getOAuthCallbackRedirectUri: (platform?: string) => Promise<string | null>
  getNativePreviewSurfaceMode: () => Promise<boolean>
  openPreviewWindow: () => Promise<PreviewWindowState>
  closePreviewWindow: () => Promise<PreviewWindowState>
  togglePreviewWindow: () => Promise<PreviewWindowState>
  getPreviewWindowState: () => Promise<PreviewWindowState>
  reportPreviewPermissionRequired: (
    permissionStatus: Exclude<PreviewPermissionStatus, 'ok'>,
    message?: string,
    generation?: number
  ) => Promise<PreviewWindowState>
  setPreviewWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<PreviewWindowState>
  setPreviewWindowMode: (mode: PreviewWindowMode) => Promise<PreviewWindowState>
  reportPreviewDockSlot: (report: DockSlotReport) => Promise<PreviewWindowState>
  setPreviewDockOverlayOpen: (open: boolean) => Promise<PreviewWindowState>
  setPreviewWindowAspectRatio: (width: number, height: number) => Promise<PreviewWindowState>
  onPreviewWindowState: (callback: (state: PreviewWindowState) => void) => () => void
  openNotesWindow: () => Promise<NotesWindowState>
  closeNotesWindow: () => Promise<NotesWindowState>
  getNotesWindowState: () => Promise<NotesWindowState>
  setNotesWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<NotesWindowState>
  getNotesDocument: () => Promise<NotesDocument>
  saveNotesDocument: (patch: Partial<NotesDocument>) => Promise<NotesDocument>
  onNotesFlushRequest: (callback: () => void) => () => void
  onNotesWindowState: (callback: (state: NotesWindowState) => void) => () => void
  onNotesDocument: (callback: (document: NotesDocument) => void) => () => void
  openCommentsWindow: () => Promise<CommentsWindowState>
  closeCommentsWindow: () => Promise<CommentsWindowState>
  toggleCommentsWindow: () => Promise<CommentsWindowState>
  getCommentsWindowState: () => Promise<CommentsWindowState>
  setCommentsWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<CommentsWindowState>
  onCommentsWindowState: (callback: (state: CommentsWindowState) => void) => () => void
  pushCommentsSnapshot: (view: CommentsViewSnapshot) => Promise<void>
  pushCommentsDelta: (delta: CommentsSnapshotDelta) => Promise<void>
  getCommentsSnapshot: () => Promise<CommentsViewSnapshot | null>
  setCommentsViewMode: (mode: CommentsViewMode) => Promise<CommentsViewSnapshot | null>
  onCommentsSnapshot: (callback: (view: CommentsViewSnapshot) => void) => () => void
  onCommentsDelta: (callback: (delta: CommentsSnapshotDelta) => void) => () => void
  openCaptionsWindow: () => Promise<CaptionsWindowState>
  closeCaptionsWindow: () => Promise<CaptionsWindowState>
  toggleCaptionsWindow: () => Promise<CaptionsWindowState>
  getCaptionsWindowState: () => Promise<CaptionsWindowState>
  setCaptionsWindowAlwaysOnTop: (alwaysOnTop: boolean) => Promise<CaptionsWindowState>
  onCaptionsWindowState: (callback: (state: CaptionsWindowState) => void) => () => void
  pushCaptionSnapshot: (snapshot: CaptionWindowSnapshot) => Promise<void>
  getCaptionSnapshot: () => Promise<CaptionWindowSnapshot | null>
  onCaptionSnapshot: (callback: (snapshot: CaptionWindowSnapshot) => void) => () => void
  pushCaptionLines: (lines: CaptionsUpdate[]) => Promise<void>
  getCaptionLines: () => Promise<CaptionsUpdate[] | null>
  onCaptionLines: (callback: (lines: CaptionsUpdate[]) => void) => () => void
  createNativePreviewSurface: (
    bounds: PreviewSurfaceBounds,
    generation?: number
  ) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceBounds: (
    bounds: PreviewSurfaceBounds,
    generation?: number
  ) => Promise<PreviewSurfaceStatus>
  applyNativePreviewHostCommands: (
    commands: NativePreviewHostCommand[],
    generation?: number
  ) => Promise<PreviewSurfaceStatus>
  drainNativePreviewHostCommands: (generation?: number) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceScene: (
    scene: PreviewSurfaceSceneUpdateParams
  ) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceCompositor: (
    status: PreviewSurfaceCompositorUpdateParams
  ) => Promise<PreviewSurfaceStatus>
  // Keeps the macOS vibrancy material in step with the in-app theme.
  setNativeTheme: (theme: 'dark' | 'light') => Promise<void>
  // True while the MAIN process pumps presents from its own backend socket;
  // the renderer pump stays dormant then and resumes only as a fallback.
  getNativePreviewMainPumpActive: () => Promise<boolean>
  onNativePreviewMainPumpActive: (callback: (active: boolean) => void) => () => void
  setNativePreviewSurfaceFramePollingSuppressed: (
    suppressed: boolean,
    recordingActive?: boolean
  ) => Promise<PreviewSurfaceStatus>
  destroyNativePreviewSurface: (generation?: number) => Promise<PreviewSurfaceStatus>
  getNativePreviewSurfaceStatus: () => Promise<PreviewSurfaceStatus>
  openSystemPermissions: (pane?: SystemPermissionPane) => Promise<void>
  /** The OS's real camera/microphone access state (Electron
   * getMediaAccessStatus — supported on macOS AND Windows). Lets the UI show a
   * truthful chip on Windows, where the audio meter has no capture backend and
   * would otherwise leave the mic stuck on "checked on first use". */
  getMediaAccessStatus: () => Promise<MediaAccessSnapshot>
  /** Fire the native macOS grant prompt in place (no System Settings jump).
   * `restarted` is true only when a fresh grant restarted the capture backend
   * — callers probing a device right after must wait for reconnect first. */
  requestMediaAccess: (
    pane: 'camera' | 'microphone'
  ) => Promise<{ granted: boolean; restarted: boolean }>
  revealPermissionTarget: () => Promise<void>
  revealSelectedResource: (capabilityId: string) => Promise<void>
  revealSession: (sessionId: string) => Promise<void>
  revealBackgroundAsset: (assetId: string) => Promise<void>
  obsDiscover?: () => Promise<ObsDiscovery>
  obsRead?: (collection: string, profile: string) => Promise<ObsSetup | null>
  obsReadStreamKey?: (profile: string) => Promise<string | null>
  pushViewerSample?: (sample: ViewerSample | null) => Promise<void>
  getViewerSample?: () => Promise<ViewerSample | null>
  onViewerSample?: (callback: (sample: ViewerSample | null) => void) => () => void
  openSession: (sessionId: string) => Promise<string>
  trashSessionDeletion: (operationId: string) => Promise<{ deleted: boolean; failedCount: number }>
  onOAuthCallbackUrl: (callback: (envelope: OAuthCallbackEnvelope) => void) => () => void
  /**
   * Page-navigation shortcuts (⌘1–⌘9, ⌘,) routed from the main process. They
   * must come through main: Chromium reserves ⌘+digit (tab switching) and
   * swallows them before the renderer's keydown fires, so a document listener
   * never sees them. Main catches them via `before-input-event` and forwards
   * the raw key here ("1".."9" or ",").
   */
  onShortcutNavigate: (callback: (key: string) => void) => () => void
  onBackendConnection: (callback: (connection: BackendConnection) => void) => () => void
  onBackendLifecycle: (callback: (event: BackendLifecycleEvent) => void) => () => void
  onBackendLog: (callback: (log: BackendLogEvent) => void) => () => void
  getGlassWallpaper: () => Promise<GlassWallpaperState | null>
  onGlassWallpaper: (callback: (state: GlassWallpaperState) => void) => () => void
  onGlassGeometry: (
    callback: (geometry: Pick<GlassWallpaperState, 'window' | 'display'>) => void
  ) => () => void
  // App self-update (electron-updater) — Settings → About & updates. Packaged
  // builds also check automatically on every launch (silent background flow,
  // opt out via VIDEORC_DISABLE_AUTO_UPDATE=1); the manual button shares the
  // same status. `installUpdate` quits and relaunches, so its promise may
  // never resolve. The install must be blocked by the caller while a capture is
  // live — never interrupt a recording.
  checkForUpdates: () => Promise<UpdateStatus>
  downloadUpdate: () => Promise<UpdateStatus>
  installUpdate: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  // First-frame healing ladder (main → renderer): re-commit the current scene
  // through the backend-owned allocator to displace a stale/foreign compositor
  // scene (see native-preview-first-frame.ts).
  onPreviewSceneResyncRequest: (callback: () => void) => () => void
}

// --- Recording repair (lag cleanup & repair plan) ---

export type QualityVerdict = 'clean' | 'repairable' | 'needs-review'

/**
 * A detected quality issue. The UI renders `FileAssessment.reasons` for humans; this is
 * the structured tag for callers that need to branch on the specific problem.
 */
export interface QualityIssue {
  kind: string
}

/** Read-only quality assessment of one recording (no files are modified). */
export interface FileAssessment {
  path: string
  verdict: QualityVerdict
  issues: QualityIssue[]
  reasons: string[]
  repairable: boolean
  hasBackup: boolean
}

/** The verdict after running the repair gate on one recording. */
export type GateStatus =
  | { status: 'ready'; path: string }
  | { status: 'repaired'; path: string; interpolated: boolean }
  | { status: 'not-hundred-percent'; path: string; reasons: string[] }
  | { status: 'failed'; path: string; reason: string }

/** Live per-file progress emitted on the `repair.status` event during a repair. */
export interface RepairStatusEvent {
  path: string
  status: 'checking' | 'repairing' | 'deferred' | 'ready' | 'repaired' | 'not-100' | 'failed'
  reason?: string
}

export interface RepairFileParams {
  path: string
  ffmpegPath?: string
  expectAudio?: boolean
  intendedFps?: number
}

export interface RepairRestoreParams {
  path: string
}

// --- In-app live chat (read-only unified comments feed) ---
// Wire mirror of crates/videorc-backend/src/live_chat.rs. Plan:
// "2026-06-06 - Videorc In-App Livestream Comments Plan". The backend owns
// destination capability, persisted messages/send operations, and live snapshots.

/** Whether a connected account can read live chat for a platform (setup-time audit). */
export type ChatCapabilityState = 'available' | 'needs-reconnect' | 'not-connected' | 'unsupported'

/** Per-platform live-chat readiness, surfaced before Go Live (the `liveChat.capability` result). */
export interface ChatCapability {
  platform: StreamPlatform
  state: ChatCapabilityState
  read: CommentsReadState
  write: CommentsWriteState
  /** True only when chat can actually be read right now. */
  chatReadAvailable: boolean
  requiredScope?: string
  accountId?: string
  accountLabel?: string
  message: string
}

/** Runtime connection state of one platform's chat connector. */
export type LiveChatProviderConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'waiting'
  | 'failed'
  | 'unsupported'
  | 'ended'

export type CommentsReadState =
  | 'connecting'
  | 'ready'
  | 'waiting-for-broadcast-context'
  | 'ended'
  | 'failed'
  | 'unavailable'

export type CommentsWriteState = 'ready' | 'missing-scope' | 'read-only' | 'failed' | 'unavailable'

/** What kind of chat row a message is — drives styling for monetized/system events. */
export type LiveChatEventType =
  | 'message'
  | 'paid'
  | 'membership'
  | 'system'
  | 'deleted'
  | 'moderation'

/** Live connector state for one platform within a session. */
export interface LiveChatProviderState {
  id: string
  platform: StreamPlatform
  targetId?: string
  accountId?: string
  accountLabel?: string
  read: CommentsReadState
  write: CommentsWriteState
  state: LiveChatProviderConnectionState
  message: string
  lastConnectedAt?: string
  lastMessageAt?: string
  lastError?: string
}

/** A rich-text fragment of a message (plain text, emote, mention, …). */
export interface LiveChatMessageFragment {
  type: string
  text: string
  imageUrl?: string
}

/** One normalized, SQLite-persisted chat message. `id` is the app-level dedupe key. */
export interface LiveChatMessage {
  id: string
  providerMessageId: string
  platform: StreamPlatform
  targetId?: string
  sessionId: string
  authorId?: string
  authorName: string
  authorAvatarUrl?: string
  authorBadges: string[]
  authorRoles: string[]
  publishedAt: string
  receivedAt: string
  messageText: string
  fragments: LiveChatMessageFragment[]
  eventType: LiveChatEventType
  amountText?: string
  isDeleted: boolean
  rawProviderType?: string
}

/** Authoritative live-chat snapshot: provider rows + persisted/buffered messages + unread count. */
export interface LiveChatSnapshot {
  sessionId?: string
  providers: LiveChatProviderState[]
  messages: LiveChatMessage[]
  unreadCount: number
  updatedAt: string
}

/** Incremental main-renderer -> Comments-window transport after the initial snapshot seed. */
export type CommentsSnapshotDelta =
  | { kind: 'message'; message: LiveChatMessage; sessionId?: string }
  | { kind: 'provider'; provider: LiveChatProviderState; sessionId?: string; updatedAt: string }
  | { kind: 'clear'; sessionId?: string; updatedAt: string }

/** An empty snapshot for the renderer store before any chat session starts. */
export function createEmptyLiveChatSnapshot(updatedAt: string): LiveChatSnapshot {
  return {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt
  }
}

// Live captions (captions.* RPCs + events; premium cloud-AI feature).
// `live` remains accepted during the rolling upgrade from the Alpha backend;
// new coordinators publish the more truthful ready/listening state machine.
export type CaptionsState =
  | 'idle'
  | 'ready'
  | 'starting'
  | 'listening'
  | 'reconnecting'
  | 'degraded'
  | 'blocked'
  | 'error'
  | 'live'

export type CaptionStyleId = 'classic' | 'glass' | 'lower-third' | 'high-contrast'
export type CaptionTransport = 'realtime' | 'chunked'
export type CaptionAudioSource = 'microphone'

export interface CaptionsStatus {
  state: CaptionsState
  desiredEnabled?: boolean
  transport?: CaptionTransport
  audioSource?: CaptionAudioSource
  audioFramesSeen?: number
  droppedAudioFrames?: number
  droppedAudioSeconds?: number
  providerReady?: boolean
  reasonCode?: string
  message?: string
  remainingSeconds?: number
  sessionClientId?: string
}

export interface CaptionsUpdate {
  sessionClientId: string
  seq: number
  /** 'partial' = streaming hypothesis that REPLACES the same seq; 'final' = settled. */
  kind?: 'partial' | 'final'
  text: string
  chunkSeconds: number
  remainingSeconds?: number
}

/** Detached captions window shell state (clone of the Comments window shape). */
export interface CaptionsWindowState {
  open: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  windowId?: number
  alwaysOnTop: boolean
  enabled: boolean
  message?: string
}

/** Complete detached-reader view so it follows style, status, and cue finality. */
export interface CaptionWindowSnapshot {
  lines: CaptionsUpdate[]
  status: CaptionsStatus
  styleId: CaptionStyleId
  position: 'top' | 'bottom'
  textSize: 's' | 'm' | 'l'
}

// --- OBS setup import (plan: vault 2026-07-07 OBS Import) ----------------

/** One OBS input source, reduced to the kinds Videorc can reason about. */
export interface ObsSource {
  name: string
  /** Videorc-facing classification of the OBS source id. */
  kind:
    | 'display'
    | 'window'
    | 'application'
    | 'camera'
    | 'microphone'
    | 'image'
    | 'browser'
    | 'text'
    | 'media'
    | 'other'
  /** The raw OBS source id (e.g. "screen_capture") for the report. */
  obsKind: string
  /** Camera/mic device name when OBS recorded one. */
  deviceName?: string
  /** Window/application hint for window captures. */
  applicationHint?: string
  /** Image file path for image sources. */
  filePath?: string
  /** Main-imported managed copy; renderer receives this instead of filePath. */
  managedBackground?: BackgroundImportResult
  /** Mixer state OBS stored on the source (mics). volume is a 0..1 multiplier. */
  volume?: number
  muted?: boolean
  /** Camera capture preset dimensions when OBS recorded one. */
  presetWidth?: number
  presetHeight?: number
}

export interface ObsSceneItem {
  sourceName: string
  visible: boolean
  /** Position in canvas pixels. */
  x: number
  y: number
  scaleX: number
  scaleY: number
  boundsType: number
  boundsX: number
  boundsY: number
  cropLeft: number
  cropTop: number
  cropRight: number
  cropBottom: number
}

export interface ObsScene {
  name: string
  current: boolean
  items: ObsSceneItem[]
}

export interface ObsStreamService {
  type: 'rtmp_common' | 'rtmp_custom'
  /** rtmp_common service label ("YouTube - RTMPS", "Twitch"). */
  service?: string
  server?: string
  /** The key itself NEVER crosses to the renderer in discovery — only on apply. */
  hasKey: boolean
}

export interface ObsSetup {
  collectionName: string
  canvasWidth: number
  canvasHeight: number
  outputWidth: number
  outputHeight: number
  fps: number
  recordingPath?: string
  recordingDirectory?: ResourceSelection
  sources: ObsSource[]
  scenes: ObsScene[]
  globalMicDeviceName?: string
  hasDesktopAudio: boolean
  service?: ObsStreamService
}

export interface ViewerPlatformCount {
  platform: StreamPlatform
  count: number
}

/** Live concurrent-viewer sample (viewer rider V1) — viewers, not subs. */
export interface ViewerSample {
  sessionId: string
  platforms: ViewerPlatformCount[]
  total: number
  at: string
}

export interface ObsDiscovery {
  available: boolean
  collections: string[]
  profiles: string[]
  currentCollection?: string
  currentProfile?: string
}
