export interface BackendConnection {
  host: string
  port: number
  token: string
}

export interface BackendHealth {
  status: string
  version: string
  platform: string
  ffmpeg: ToolStatus
  databasePath: string
}

export interface ToolStatus {
  path: string
  available: boolean
  version?: string
  message?: string
}

export type DeviceKind = 'screen' | 'window' | 'camera' | 'microphone' | 'system-audio'
export type DeviceStatus = 'available' | 'unavailable' | 'permission-required'

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  status: DeviceStatus
  detail?: string
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

export type AudioTrackSource = 'microphone' | 'test-tone'

export type RecordingContainer = 'none' | 'mkv' | 'flv' | 'tee'
export type RecordingFinalizationState = 'none' | 'finalizing' | 'finalized' | 'failed'
export type RecordingPipelineStage = 'capture' | 'render' | 'video-encoder' | 'audio-encoder' | 'muxer'
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
export type CameraShape = 'rectangle' | 'circle'
export type CameraFit = 'fit' | 'fill'
export type LayoutPreset = 'screen-camera' | 'screen-only' | 'camera-only' | 'side-by-side'
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

export interface Scene {
  id: string
  name: string
  sources: SceneSource[]
  outputs: SceneOutput[]
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
  | 'stream-1080p60'
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
  authMode: StreamAuthMode
  accountId?: string
  accountLabel?: string
  platformBroadcastId?: string
  platformStreamId?: string
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
  xVisibility?: StreamPrivacy
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

export type XNativeLiveCapabilityState = 'partner-api-required'

export interface XNativeLiveCapabilityParams {
  accountId?: string
}

export interface XPrepareParams {
  accountId?: string
}

export interface XNativeLiveCapability {
  platform: 'x'
  state: XNativeLiveCapabilityState
  nativeAvailable: boolean
  manualRtmpAvailable: boolean
  oauthConnected: boolean
  accountId?: string
  accountLabel?: string
  message: string
  evidence: string[]
  docsUrl: string
  apiOverviewUrl: string
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
}

export interface AudioSettings {
  microphoneGainDb: number
  microphoneMuted: boolean
  microphoneSyncOffsetMs: number
  microphoneSyncOffsetUserSet?: boolean
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

/** Which encoder a recording session requested. `-allow_sw 1` means videotoolbox may still
 * fall back to software, so this is the requested backend; the final-file codec/encoder tag
 * is the corroborating output-side signal. */
export type EncodeBackend = 'software-x264' | 'hardware-videotoolbox'
export type CompositorBackend = 'metal' | 'cpu-fallback'

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
export type CompositorSceneSourceKind = SceneSourceKind | 'screen-image'
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

export interface CompositorStatus {
  state: CompositorState
  targetFps: number
  width: number
  height: number
  runId?: string
  sceneRevision?: number
  sceneId?: string
  sceneLayout?: LayoutSettings
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
  updatedAt: string
  message?: string
}

export type PreviewSurfaceSceneLayerKind = SceneSourceKind | 'screen-image'
export type PreviewSurfaceSceneLayerFit = 'contain' | 'cover'

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
  activeScreenId?: string
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
}

export interface PreviewSurfaceStatus {
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
  nativePreviewHelperRoundTripP95Ms?: number
  nativePreviewMainStatusFetchP95Ms?: number
  nativePreviewMainStatusFetchFailures?: number
  nativePreviewMainStatusFetchSuccesses?: number
  nativePreviewMainPresentedStatusAgeMs?: number
  nativePreviewMainPresentedStatusAgeP95Ms?: number
  nativePreviewMainPresentedFrameAgeP95Ms?: number
  framePollingSuppressed: boolean
  sourcePixelsPresent: boolean
  pendingHostCommandCount: number
  bounds?: PreviewSurfaceBounds
  startedAt?: string
  updatedAt: string
  message?: string
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
  nativePreviewHelperRoundTripP95Ms?: number
  nativePreviewMainStatusFetchP95Ms?: number
  nativePreviewMainStatusFetchFailures?: number
  nativePreviewMainStatusFetchSuccesses?: number
  nativePreviewMainPresentedStatusAgeMs?: number
  nativePreviewMainPresentedStatusAgeP95Ms?: number
  nativePreviewMainPresentedFrameAgeP95Ms?: number
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

export type PreviewCameraState = 'starting' | 'live' | 'permission-needed' | 'device-missing' | 'failed'

export interface PreviewCameraStartParams {
  sources: SourceSelection
  layout: LayoutSettings
  video: VideoSettings
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

export type PreviewScreenState = 'starting' | 'live' | 'permission-needed' | 'source-missing' | 'failed'
export type PreviewScreenSourceKind = 'screen' | 'window'

export interface PreviewScreenStartParams {
  sources: SourceSelection
  video: VideoSettings
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

export type AudioMeterStatus = 'ready' | 'silent' | 'unavailable' | 'permission-required'

export interface AudioMeterResult {
  status: AudioMeterStatus
  level?: number
  peakDb?: number
  meanDb?: number
  message?: string
}

export interface StreamHealth {
  sessionId: string
  fps?: number
  droppedFrames?: number
  speed?: number
  createdAt: string
}

export type DiagnosticBottleneck = 'none' | 'capture' | 'render' | 'encoder' | 'preview' | 'audio' | 'device' | 'unknown'

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
  /** P95 wait for the bridge writer to receive a compositor frame. */
  encoderBridgeCompositorWaitP95Ms?: number
  /** P95 time spent submitting retained targets into VideoToolbox. */
  encoderBridgeVideoToolboxSubmitP95Ms?: number
  /** P95 time spent writing completed VideoToolbox H.264 access units into FFmpeg. */
  encoderBridgeVideoToolboxFifoWriteP95Ms?: number
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
  encoderBridgeError?: string
  /** Which encoder the active session requested — proves hardware vs software encode. */
  encodeBackend?: EncodeBackend
  /** Which compositor backend produced the most recent diagnostic window. */
  compositorBackend?: CompositorBackend
  /** Why the compositor had to render on CPU fallback. */
  compositorFallbackReason?: string
  /** Cumulative frames rendered by CPU fallback during the active compositor run. */
  compositorCpuFallbackFrames: number
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
  /** Bounded blocking camera refreshes after repeated misses or visibly stale cached camera frames. */
  compositorCameraSourceBlockingRefreshes: number
  /** Bounded blocking screen/window refreshes after repeated misses or visibly stale cached screen/window frames. */
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
  /** Whether the latest ScreenCaptureKit frame retained an IOSurface for zero-copy import. */
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

export interface ExportPublishPackResult {
  sessionId: string
  markdownPath: string
}

export type AiArtifactKind =
  | 'audio-extract'
  | 'transcript'
  | 'title-description'
  | 'summary'
  | 'chapters'
  | 'highlights'
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
  layout: LayoutSettings
  sources: SourceSelection
  healthEvents: HealthEvent[]
  sessionLogs: SessionLogEntry[]
  aiArtifacts: AiArtifact[]
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
  isPackaged: boolean
  permissionTargetName: string
  permissionTargetPath: string
  nativePreviewSurfaceProofEnabled: boolean
  previewSmokeMode?: boolean
  disableAutoPreview?: boolean
  nativePreviewSurfaceStageSuspended?: boolean
}

export interface VideorcApi {
  getBackendConnection: () => Promise<BackendConnection | null>
  getBackendLogs: () => Promise<BackendLogEvent[]>
  getRuntimeInfo: () => Promise<RuntimeInfo>
  pickScreenImage: () => Promise<string | null>
  openOAuthUrl: (authUrl: string) => Promise<void>
  getOAuthCallbackRedirectUri: () => Promise<string | null>
  getNativePreviewSurfaceMode: () => Promise<boolean>
  createNativePreviewSurface: (bounds: PreviewSurfaceBounds) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceBounds: (bounds: PreviewSurfaceBounds) => Promise<PreviewSurfaceStatus>
  applyNativePreviewHostCommands: (commands: NativePreviewHostCommand[]) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceScene: (scene: PreviewSurfaceSceneUpdateParams) => Promise<PreviewSurfaceStatus>
  updateNativePreviewSurfaceCompositor: (status: PreviewSurfaceCompositorUpdateParams) => Promise<PreviewSurfaceStatus>
  setNativePreviewSurfaceFramePollingSuppressed: (suppressed: boolean) => Promise<PreviewSurfaceStatus>
  destroyNativePreviewSurface: () => Promise<PreviewSurfaceStatus>
  getNativePreviewSurfaceStatus: () => Promise<PreviewSurfaceStatus>
  openSystemPermissions: (pane?: SystemPermissionPane) => Promise<void>
  revealPermissionTarget: () => Promise<void>
  onOAuthCallbackUrl: (callback: (callbackUrl: string) => void) => () => void
  onBackendConnection: (callback: (connection: BackendConnection) => void) => () => void
  onBackendLog: (callback: (log: BackendLogEvent) => void) => () => void
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
// "2026-06-06 - Videorc In-App Livestream Comments Plan". The renderer treats chat as
// read-only and ephemeral: never persisted to localStorage, never round-tripped to the
// backend; only the latest snapshot/events drive the panel.

/** Whether a connected account can read live chat for a platform (setup-time audit). */
export type ChatCapabilityState =
  | 'available'
  | 'needs-reconnect'
  | 'not-connected'
  | 'unsupported'

/** Per-platform live-chat readiness, surfaced before Go Live (the `liveChat.capability` result). */
export interface ChatCapability {
  platform: StreamPlatform
  state: ChatCapabilityState
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
  platform: StreamPlatform
  targetId?: string
  accountId?: string
  accountLabel?: string
  state: LiveChatProviderConnectionState
  message: string
  lastConnectedAt?: string
  lastMessageAt?: string
  lastError?: string
  capabilities: string[]
}

/** A rich-text fragment of a message (plain text, emote, mention, …). */
export interface LiveChatMessageFragment {
  type: string
  text: string
  imageUrl?: string
}

/** One normalized chat message. `id` (`{platform}:{providerMessageId}`) is the dedupe key. */
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

/** Full live-chat snapshot: provider rows + buffered messages + unread count. */
export interface LiveChatSnapshot {
  sessionId?: string
  providers: LiveChatProviderState[]
  messages: LiveChatMessage[]
  unreadCount: number
  updatedAt: string
}

/** An empty snapshot for the renderer store before any chat session starts. */
export function createEmptyLiveChatSnapshot(updatedAt: string): LiveChatSnapshot {
  return {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt,
  }
}
