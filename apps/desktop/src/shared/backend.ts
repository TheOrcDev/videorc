import type { ChatDelivery, ChatDeliveryBoundary } from './chat-delivery'
import type { LiveDashboardState } from './live-dashboard'
import type { GlobalShortcutAction } from './global-shortcuts'
import type { BackgroundImportResult } from './background-import'
import type { TwitchGifMode } from './chat-gif'
export type { BackgroundImportResult } from './background-import'
export type { TwitchGifMode } from './chat-gif'

export interface BackendConnection {
  host: string
  port: number
  token: string
  pid?: number
  parentPid?: number
}

/** Non-secret identity for a backend whose capture state predates a permission grant. */
export interface BackendRestartBoundary {
  port: number
  pid?: number
}

export interface MediaAccessResult {
  granted: boolean
  restarted: boolean
  /** Backend whose capture state predates this grant. */
  staleBackend?: BackendRestartBoundary
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
  | 'live-cohost'
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
  /** Total enabled destinations across both orientation legs (one shared cap). */
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

// --- Clean cut (plan 119 S12a/S12b) -----------------------------------------
// Mirrors the Rust `CleanCut*` types in `protocol.rs`. The closed schemas in
// `backend-rpc-contract.ts` validate every one of these shapes.

export type CleanCutMode = 'clean' | 'condensed'

/** `queued → transcribing → analyzing → ready` here; `ready → rendering →
 * validating → completed` once rendering (S13) lands. `failed` and `cancelled`
 * are final; starting again on the same recording resumes the transcript. */
export type CleanCutJobState =
  | 'queued'
  | 'transcribing'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CleanCutRemovalKind =
  | 'head'
  | 'tail'
  | 'silence'
  | 'gap'
  | 'filler'
  | 'retake'
  | 'false_start'
  | 'condensed'
  | 'manual'

export interface CleanCutKindStat {
  kind: CleanCutRemovalKind
  count: number
  ms: number
}

/** The part of the cut list that rides on every job snapshot. */
export interface CleanCutEdlSummary {
  durationMs: number
  keptMs: number
  removalCount: number
  byKind: CleanCutKindStat[]
}

/** Durable backend-owned Clean cut state; also the `cleanCut.status` event. */
export interface CleanCutJob {
  id: string
  sourceSessionId: string
  mode: CleanCutMode
  state: CleanCutJobState
  /** Free-form: `extract-audio`, `probe`, `upload`, `stitch`, `analyze`, `cut-list`. */
  step?: string
  /** 0..1 across the whole job. */
  progress: number
  edlRevision: number
  edlSummary?: CleanCutEdlSummary
  /** `<Artifacts>/<sessionId>/clean-cut/transcript.words.json` once stitched. */
  transcriptPath?: string
  outputSessionId?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

/** The source frame grid as `num/den` frames per second. */
export interface CleanCutFrameRate {
  num: number
  den: number
}

export interface CleanCutSourceIdentity {
  path: string
  sizeBytes: number
  modifiedUnixMs?: number
}

export interface CleanCutRemoval {
  id: string
  startMs: number
  endMs: number
  /** Exact frame indices on the source grid; `endFrame` is exclusive. */
  startFrame: number
  endFrame: number
  kind: CleanCutRemovalKind
  reason: string
  confidence?: number
  enabled: boolean
}

export interface CleanCutEdlStats {
  byKind: CleanCutKindStat[]
  keptMs: number
}

/** The cut list, version 1. */
export interface CleanCutEdl {
  version: 1
  sourceIdentity: CleanCutSourceIdentity
  frameRate: CleanCutFrameRate
  durationMs: number
  removals: CleanCutRemoval[]
  stats: CleanCutEdlStats
}

/** One kept range of a Condensed selection, in recording time (S13/S19). */
export interface CleanCutCondensedKeep {
  startMs: number
  endMs: number
  title: string
}

export interface CleanCutJobDetail {
  job: CleanCutJob
  edl?: CleanCutEdl
  /** Condensed jobs only, once the analysis answered; omitted when empty. */
  condensedKeeps?: CleanCutCondensedKeep[]
}

/** `cleanCut.get`: the newest job per mode for one source session. */
export interface CleanCutGetResult {
  sessionId: string
  jobs: CleanCutJobDetail[]
}

export interface CleanCutStartParams {
  sessionId: string
  mode: CleanCutMode
  /** The Cloud AI consent the renderer holds; `false` is refused. */
  consentToUploadAudio: boolean
  /** Condensed only: 120..3600 seconds, default 900. */
  targetDurationSeconds?: number
}

export interface CleanCutRemovalToggle {
  id: string
  enabled: boolean
}

export interface CleanCutManualRange {
  startMs: number
  endMs: number
}

/** `cleanCut.updateEdl`: optimistic on `revision`; toggles flip `enabled`,
 * `addManual` adds frame-snapped manual removals, `removeManual` deletes
 * manual removals by id. */
export interface CleanCutUpdateEdlParams {
  jobId: string
  revision: number
  removals?: CleanCutRemovalToggle[]
  addManual?: CleanCutManualRange[]
  removeManual?: string[]
}

/** `cleanCut.render` and `cleanCut.transcript` params (S13). */
export interface CleanCutJobParams {
  jobId: string
}

/** One word of `cleanCut.transcript`; `filler` is present only when true. */
export interface CleanCutTranscriptWord {
  text: string
  startMs: number
  endMs: number
  filler?: true
}

/** One sentence of `cleanCut.transcript`: the analysis job's segment ids. */
export interface CleanCutTranscriptSegment {
  id: string
  startMs: number
  endMs: number
}

/** `cleanCut.transcript`: the stitched words and sentence segments of a job. */
export interface CleanCutTranscript {
  jobId: string
  language: string | null
  words: CleanCutTranscriptWord[]
  segments: CleanCutTranscriptSegment[]
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

/** Main defers product-account maintenance while capture is active. Deferral is
 * an expected answer, not a failure: the caller keeps its current snapshot. */
export type VideorcAccountRefreshResult =
  | { outcome: 'refreshed'; snapshot: VideorcAccountSnapshot }
  | { outcome: 'deferred' }

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
  nativePreviewSurfaceStatus?: PreviewSurfaceStatus
  runtimeInfo?: RuntimeInfo
}

export type AudioTrackSource = 'microphone' | 'test-tone' | 'system-audio'

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
  /** Sources currently summed into this one mixed track (plan 069). Absent
   * for a track that carries only its `source`. */
  mixSources?: AudioTrackSource[]
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
  state: 'running' | 'restarting' | 'failed' | 'lost'
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
  /**
   * The user chose no camera (plan 080 S4). Without it an empty camera slot
   * reads as "never chosen", and device reconcile fills in the first camera.
   * Renderer intent only: the backend ignores it. Meaningless once a
   * `cameraId` is set, and reconcile drops it then.
   */
  cameraOff?: boolean
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
export type VerticalScreenFraming = 'fill' | 'fit'
export type ArrangementMode = 'preset' | 'freeform'
export type SideBySideCameraSide = 'left' | 'right'

export interface CameraTransform {
  x: number
  y: number
  width: number
  height: number
}

export interface SourceVisibility {
  camera: boolean
  capture: boolean
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
  /**
   * How the SCREEN is framed in vertical-mode scenes. 'fill' is the
   * short-form law (bands filled, centre-cropped); 'fit' shows the WHOLE
   * screen: stacked scenes size the screen band to the screen and the camera
   * covers the rest. Horizontal scenes ignore it.
   */
  verticalScreenFraming: VerticalScreenFraming
  /**
   * 'preset' (default) composes the fixed layoutPreset arrangement.
   * 'freeform' composes the screen + camera base and applies
   * sourceTransformOverrides: the "arrange it yourself" mode. layoutPreset
   * stays meaningful in freeform (orientation, the scene to return to).
   */
  arrangementMode: ArrangementMode
  /**
   * Per-source transforms for freeform, keyed by the stable scene source id
   * ('source:base', 'source:camera'). Empty means the base arrangement.
   */
  sourceTransformOverrides: Record<string, CameraTransform>
  /** Independent visual roles; legacy layouts show both. */
  sourceVisibility?: SourceVisibility
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
  /** Scene-motion duration (ms) for this commit; absent/0 = instant switch. */
  transitionMs?: number
}

export interface SceneTransformUpdateParams {
  sourceId: string
  transform: SceneTransformPatch
  /** Omitted retains legacy snapping; precision editors commit their displayed geometry. */
  snap?: 'none' | 'legacy'
}

/** Resize handle ids of the Scene editor's selection frame (mirrors `StageHandleId`). */
export type EditorHandleId = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** A snap guide across the whole canvas; `position` is a canvas fraction (0..1). */
export interface EditorGuide {
  axis: 'x' | 'y'
  position: number
}

/**
 * Selection chrome the compositor draws over the preview during a Scene
 * editor drag (plan 058): frame, handles and snap guides in normalized canvas
 * coordinates. `slotCssWidth` = the on-screen width of the canvas slot in CSS
 * pixels; the compositor sizes the chrome from it and the frame it actually
 * draws into, so line thickness stays constant on screen at every run size.
 * `scale` (output pixels per CSS pixel as the renderer estimated it) is the
 * fallback when `slotCssWidth` is absent.
 */
export interface EditorChrome {
  selected: CameraTransform
  handles: boolean
  activeHandle?: EditorHandleId
  guides: EditorGuide[]
  scale: number
  slotCssWidth?: number
}

/**
 * One frame of a live drag: the ghost rect plus the chrome to draw. Never
 * committed. Without `transform` the draft is chrome-only: the idle
 * selection's frame and handles over the committed picture.
 */
export interface SceneEditorDraftParams {
  sourceId: string
  transform?: CameraTransform
  chrome: EditorChrome
}

/** The draft the compositor is currently applying (`CompositorStatus.editorDraft`). */
export interface SceneEditorDraftStatus {
  sourceId: string
  /** Absent for a chrome-only draft (the idle selection). */
  transform?: CameraTransform
  /** Scene revision whose install ends the draft; absent until the commit stamps it. */
  releaseAtRevision?: number
}

/** Result of `scene.editor.draft.set` / `scene.editor.draft.clear`. */
export interface SceneEditorDraftAck {
  /** Whether a draft is live after the call. */
  active: boolean
  editorDraft?: SceneEditorDraftStatus
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

export type RtmpPreset = 'youtube' | 'twitch' | 'kick' | 'x' | 'custom'
export type VideoPreset =
  | 'tutorial-540p30'
  | 'tutorial-720p30'
  | 'tutorial-1080p30'
  | 'tutorial-1440p30'
  | 'record-4k30'
  | 'record-4k60-experimental'
  | 'stream-safe-1080p30'
  | 'stream-safe-1080p60'
  | 'stream-youtube-1080p30'
  | 'stream-youtube-1080p60'
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

// Multi-platform streaming (per-target) model. Session start consumes it
// (recording.rs reads params.streaming for the per-target fan-out); the legacy
// single-RTMP fields remain only as the no-settings fallback.
export type StreamPlatform = 'youtube' | 'twitch' | 'kick' | 'x' | 'tiktok' | 'instagram' | 'custom'
/**
 * Which composed leg a destination consumes in a dual-orientation session.
 * Explicit per-target property — never inferred from resolution equality.
 * Absent means horizontal (legacy migration).
 */
export type StreamOutputOrientation = 'horizontal' | 'vertical'
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
  // Plan 161: a live leg lost its connection and is being retried.
  | 'reconnecting'
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
  scheduledEventId?: string
  scheduledAttemptId?: string
  scheduledEventTitle?: string
  scheduledStartUtc?: string
  scheduledPrivacy?: StreamPrivacy
  platformBroadcastId?: string
  platformStreamId?: string
  outputPreset?: VideoPreset
  outputBitrateKbps?: number
  /** Dual-orientation leg binding; absent = horizontal (legacy migration). */
  outputOrientation?: StreamOutputOrientation
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
  /**
   * Managed thumbnail asset id (plan 083), from `importScheduledThumbnail`.
   * Uploaded to each YouTube broadcast an instant Go Live prepares.
   */
  thumbnailAssetId?: string
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
  /** Kick category (plan 063). A platform setting: applies without a custom title. */
  kickCategoryId?: number
  kickCategoryName?: string
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
  /**
   * The destination being prepared. Scopes the stored stream key per
   * destination so the horizontal and vertical YouTube broadcasts of one
   * channel never share (and overwrite) a single key slot.
   */
  targetId?: string
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

/**
 * Plan 083: the outcome of setting the Broadcast info thumbnail on an instant
 * YouTube broadcast, emitted as `streamTargets.youtube.thumbnail` and returned
 * by `streamTargets.youtube.thumbnail.retry`.
 */
export interface YouTubeThumbnailResult {
  platform: 'youtube'
  accountId: string
  broadcastId: string
  targetId?: string
  state: 'uploaded' | 'error'
  code?: string
  message?: string
  retryable: boolean
}

export interface YouTubeThumbnailRetryParams {
  accountId?: string
  broadcastId: string
  targetId?: string
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

export interface KickPrepareParams {
  accountId?: string
}

export interface KickCategorySearchParams {
  accountId?: string
  query: string
  limit?: number
}

export interface KickCategory {
  id: number
  name: string
  thumbnail?: string
}

export interface KickCategorySearchResult {
  categories: KickCategory[]
}

/** Result of `streamTargets.kick.applyMetadata` — title/category pushed without touching the stream key. */
export interface KickAppliedMetadata {
  platform: 'kick'
  accountId: string
  accountLabel: string
  title: string
  categoryId?: number
  categoryName?: string
}

export interface PreparedKickBroadcast {
  platform: 'kick'
  accountId: string
  accountLabel: string
  serverUrl: string
  streamKeySecretRef: string
  streamKeyPresent: boolean
  redactedUrl: string
  broadcasterUserId: string
  slug?: string
  title: string
  categoryId?: number
  categoryName?: string
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
  /** Unused since X chat moved to the X Activity API relay; still accepted. */
  mediaKey?: string
  targetId?: string
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
  scheduled?: {
    eventId: string
    fingerprint: string
    title: string
    privacy: string
    startUtc: string
  }
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
  /** Scopes on top of the base set; the backend accepts only offered ones (plan 055, S6). */
  optionalScopes?: string[]
}

/** Options for connecting (or reconnecting) a platform account. */
export interface PlatformConnectOptions {
  optionalScopes?: readonly string[]
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
  /** Plan 094: a bounded reason the renderer words itself (`youtube-quota`). */
  reason?: string
  /** When the blocked action can be tried again (RFC 3339), with `reason`. */
  retryAt?: string
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
  /** Keep the capture MKV (lossless audio) next to the exported MP4. */
  keepOriginalMkv?: boolean
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
  /**
   * Dual-orientation simulcast: a second composed leg with its own vertical
   * scene from the same captured sources. Present only when a vertical-bound
   * destination is armed; vertical targets consume this leg.
   */
  simulcast?: SimulcastParams
  /** Renderer click timestamp (epoch ms) for start-latency attribution. Telemetry only. */
  requestedAtMs?: number
}

/** The vertical leg of a dual-orientation session: a vertical scene preset on
 *  a portrait canvas, validated per leg at session start. */
export interface SimulcastParams {
  layout: LayoutSettings
  scene?: Scene
  video: VideoSettings
}

/** Optional `session.stop` params; older renderers send none. */
export interface SessionStopParams {
  /** Renderer Stop click timestamp (epoch ms) for stop-latency attribution. */
  requestedAtMs?: number
}

/** One phase boundary of a start/stop latency timeline (ms since backend admission). */
export interface RecordingTimelineMark {
  phase: string
  atMs: number
}

/** Typed start/stop latency timeline published in `diagnostics.stats`. */
export interface RecordingTimelineSnapshot {
  /** `start` | `stop`. */
  kind: string
  sessionId?: string
  /** True for the first start in this backend process (start timelines only). */
  cold?: boolean
  requestedAtEpochMs?: number
  /** Renderer click → backend admission when the renderer supplied a plausible timestamp. */
  clickToOriginMs?: number
  totalMs: number
  outcome: string
  marks: RecordingTimelineMark[]
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
  /** System audio On/Off (plan 069). Off, the default, means not captured. */
  systemAudioEnabled: boolean
  /** System audio level in dB, within SYSTEM_AUDIO_GAIN_DB_MIN..MAX. */
  systemAudioGainDb: number
  /** Pause System audio when it carries your own stream back as an echo
   * (plan 076). On unless turned off; the backend defaults a missing key On. */
  systemAudioEchoGuard?: boolean
}

/** System audio level range and default (plan 069 decision 7); mirrors
 * `SYSTEM_AUDIO_GAIN_DB_*` in the Rust protocol. */
export const SYSTEM_AUDIO_GAIN_DB_MIN = -24
export const SYSTEM_AUDIO_GAIN_DB_MAX = 12
export const SYSTEM_AUDIO_GAIN_DB_DEFAULT = -6

export interface AudioProcessingUpdateParams {
  sessionId: string
  microphoneGainDb: number
  microphoneMuted: boolean
  /** Live System audio On/Off. Omitted means unchanged. */
  systemAudioEnabled?: boolean
  /** Live System audio level in dB. Omitted means unchanged. */
  systemAudioGainDb?: number
  /** Live echo guard On/Off (plan 076). Omitted means unchanged. */
  systemAudioEchoGuard?: boolean
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
  | 'd3d11-shared-texture'
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
  | 'hardware-vaapi'
  | 'hardware-media-foundation'
  | 'software-media-foundation'
  // libopenh264 software fallback on Windows and Linux. On Linux it is the
  // required LGPL fallback when no DRM render node passes the VAAPI probe.
  | 'software-open-h264'
  // Intel Quick Sync through FFmpeg's h264_qsv on the Windows raw path,
  // chosen only after the Media Foundation bridge was rejected (plan 090 C).
  | 'hardware-qsv'

/**
 * Which FFmpeg H.264 encoder the Windows raw path may use once the Media
 * Foundation bridge is unavailable. `auto` keeps the OpenH264 fallback;
 * Quick Sync is opt-in until it has run real sessions (plan 090 C).
 */
export type WindowsH264EncoderPreference = 'auto' | 'quick-sync' | 'software'

export interface EncoderPreferenceState {
  preference: WindowsH264EncoderPreference
  /** Windows with an Intel graphics adapter: the only place the setting shows. */
  quickSyncAvailable: boolean
  /** A tester environment override decided `preference`; the setting is ignored. */
  envOverride: boolean
}

export interface EncoderPreferenceSetParams {
  preference: WindowsH264EncoderPreference
}

/** One `/dev/dri/renderD*` node as the Linux VAAPI policy saw it (Plan 052). */
export type LinuxRenderNodeState = 'probed-ok' | 'rejected' | 'quarantined' | 'skipped'

export type LinuxVaapiArgProfile = 'standard' | 'compat'

export interface LinuxRenderNodeDiagnostic {
  node: string
  driver?: string
  state: LinuxRenderNodeState
  detail?: string
}

export type StreamOutputTopologyRole = 'shared' | 'recording' | 'stream'

export type StreamOutputBridge =
  | 'raw-yuv420p'
  | 'videotoolbox-h264-annex-b'
  | 'videotoolbox-h264-mpegts'
  | 'windows-media-foundation-h264-mpegts'

export type StreamOutputTopologyProbeState = 'not-required' | 'passed' | 'rejected' | 'unsupported'

/**
 * Secret-free off-air probe input. Never add RTMP URLs, stream keys, OAuth
 * credentials, or a full StartSessionParams to this contract.
 */
export interface StreamOutputTopologyProbeParams {
  ffmpegPath?: string
  streamProfile: VideoSettings
  recordingProfile?: VideoSettings
  outputRoles: StreamOutputTopologyRole[]
}

/** Exact output topology selected by the same production probe used at start. */
export interface StreamOutputTopologyProbeResult {
  capabilityKey: string
  streamProfile: VideoSettings
  recordingProfile?: VideoSettings
  outputRoles: StreamOutputTopologyRole[]
  requestedBridgeOutput: StreamOutputBridge
  effectiveBridgeOutput: StreamOutputBridge
  effectiveEncodeBackend: EncodeBackend
  probeState: StreamOutputTopologyProbeState
  fallbackReason?: string
}

export type CompositorBackend = 'metal' | 'd3d11' | 'cpu' | 'cpu-fallback'

/**
 * Performance check: the backend records short synthetic sessions through the
 * real pipeline and walks down from this ceiling until one holds.
 */
export interface PerformanceCheckRunParams {
  ceilingWidth: number
  ceilingHeight: number
  ceilingFps: number
}

export type PerformanceCheckRungVerdict = 'passed' | 'failed' | 'skipped'

export interface PerformanceCheckRung {
  video: VideoSettings
  verdict: PerformanceCheckRungVerdict
  encodeBackend?: EncodeBackend
  compositorBackend?: CompositorBackend
  encoderSpeed?: number
  deliveredFps?: number
  drainAfterStopMs?: number
  reasons: string[]
}

export interface PerformanceCheckResult {
  capabilityKey: string
  checkedAt: string
  appVersion: string
  durationMs: number
  recommended: VideoSettings
  /** Nothing passed: the recommendation is the floor, unverified. */
  belowFloor: boolean
  rungs: PerformanceCheckRung[]
}

export interface PerformanceCheckState {
  running: boolean
  result?: PerformanceCheckResult
  /** Measured on a different GPU, driver or app version. */
  stale: boolean
}

export interface PerformanceCheckProgress {
  rungIndex: number
  rungCount: number
  video: VideoSettings
}

export type WindowsD3d11MediaState =
  | 'unavailable'
  | 'probing'
  | 'live'
  | 'draining'
  | 'fallback'
  | 'failed'

export type WindowsD3d11CaptureBackend =
  | 'preview-bgra-upload'
  | 'desktop-duplication'
  | 'windows-graphics-capture-monitor'
  | 'legacy-ffmpeg'

export type WindowsD3d11CursorMode = 'embedded' | 'separate' | 'excluded-wgc' | 'disabled-fallback'

/** Scalar-only diagnostics. No COM pointer, texture/shared handle, or HWND is wire-safe. */
export interface WindowsD3d11MediaDiagnostics {
  state: WindowsD3d11MediaState
  requested: boolean
  required: boolean
  adapterLuid?: string
  captureAdapterLuid?: string
  compositorAdapterLuid?: string
  primaryEncoderAdapterLuid?: string
  auxiliaryEncoderAdapterLuid?: string
  generation?: number
  captureBackend?: WindowsD3d11CaptureBackend
  cursorMode?: WindowsD3d11CursorMode
  cursorRequested: boolean
  cursorPixelsSource?: string
  cursorExclusionGuaranteed: boolean
  captureReadbackFrames: number
  /** Frames where Windows masked protected pixels while capture continued. */
  protectedContentMaskedFrames: number
  textureImportFrames: number
  cameraUploadFrames: number
  cursorShapeUploads: number
  cursorCompositedFrames: number
  compositorCpuFallbackFrames: number
  previewPresents: number
  previewDrops: number
  previewBmpRequests: number
  previewBmpBytes: number
  messagePumpLagP95Ms?: number
  messagePumpLagMaxMs?: number
  mediaCommandLagP95Ms?: number
  mediaCommandLagMaxMs?: number
  maximumConsecutiveMessageBatch: number
  maximumConsecutiveMediaBatch: number
  encoderGpuSamples: number
  encoderSystemMemorySamples: number
  rawVideoCopiedFrames: number
  texturePoolCapacity: number
  texturePoolInUse: number
  texturePoolPressureEvents: number
  adapterMismatches: number
  deviceResets: number
  synchronizationTimeouts: number
  staleGenerationCallbacks: number
  renderTickOverruns: number
  renderTickLagMaxMs?: number
  renderComposeStageMaxMs?: number
  fallbackReason?: string
}

/** Cumulative request counts for the HTTP image-polling preview transports. A native
 * preview never fetches these, so a session in which they climb is not actually native. */
export interface PreviewImagePollCounts {
  cameraPng: number
  screenPng: number
  productionPng: number
  cameraBmp: number
  screenBmp: number
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
  /** Corner radius in points; docked previews pass the panel radius so the
   * native surface clips to the rounded slot. Absent/0 = square. */
  cornerRadius?: number
}

/** Canonical lowercase, fixed-width pointer value. It is never renderer-facing. */
export type OpaqueNativeWindowHandle = `0x${string}`

/**
 * Main-owned request shape for backend/native-host commands. Renderer bounds
 * never include the Windows HWND; main injects it immediately before dispatch.
 */
export interface MainOwnedPreviewSurfaceBounds extends PreviewSurfaceBounds {
  orderAboveWindowHandle?: OpaqueNativeWindowHandle
}

export interface MainOwnedPreviewSurfaceBoundsParams {
  bounds: MainOwnedPreviewSurfaceBounds
  generation: number
}

export type NativePreviewHostCommandKind = 'create' | 'update-bounds' | 'destroy'

export interface NativePreviewHostCommand {
  kind: NativePreviewHostCommandKind
  bounds?: PreviewSurfaceBounds
}

export type PreviewSurfaceState = 'unavailable' | 'starting' | 'live' | 'stopped' | 'failed'
export type PreviewSurfaceSource = 'synthetic' | 'camera' | 'screen' | 'window'
export type PreviewSurfaceBacking =
  | 'cametal-layer'
  | 'directcomposition-swapchain'
  | 'electron-browser-window'
  | 'none'
export type NativePreviewHostKind =
  | 'in-process'
  | 'helper-process'
  | 'external-module'
  | 'proof-surface'
  | 'backend-d3d11-presenter'
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
  /**
   * The Scene editor draft this run is applying (plan 058). Absent or null
   * while no drag is live; never present during a session.
   */
  editorDraft?: SceneEditorDraftStatus | null
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

/** Electron-only evidence from one successful native present; never a later status refresh. */
export interface NativePreviewPresentationEvidence {
  frameId: number
  runId?: string
  sceneRevision?: number
  frameAgeMs?: number
  compositorUpdatedAt?: string
  presentedAtMs: number
  presentStartedMonotonicMs: number
  presentCompletedMonotonicMs: number
  inputToPresentLatencyMs?: number
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
  /** Windows proof-surface transport metrics (issue #157): observed frame
   * request rate, payload bandwidth, decode cadence, and decoded per-layer
   * source dimensions. Absent on native CAMetalLayer transports. */
  proofTransportRequestsPerSecond?: number
  proofTransportBytesPerSecond?: number
  proofTransportDecodedFramesPerSecond?: number
  proofSourceDimensions?: Record<string, { width: number; height: number }>
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
  nativePreviewHostKind?: NativePreviewHostKind
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
  /** Cached IOSurface imports currently retained by the native presenter. */
  nativePreviewIosurfaceImportLiveCount?: number
  /** Highest cached-IOSurface retention observed for this presenter lifetime. */
  nativePreviewIosurfaceImportPeakCount?: number
  /** Hard cache-entry ceiling enforced by the active presenter implementation. */
  nativePreviewIosurfaceImportCeiling?: number
  nativePreviewDrawableWidth?: number
  nativePreviewDrawableHeight?: number
  nativePreviewContentsScale?: number
  nativePreviewPresentedSceneRevision?: number
  nativePreviewCompositorRunId?: string
  nativePreviewPresentationEvidence?: NativePreviewPresentationEvidence
  framePollingSuppressed: boolean
  sourcePixelsPresent: boolean
  pendingHostCommandCount: number
  bounds?: PreviewSurfaceBounds
  /** Sanitized readback from the backend-owned Windows DirectComposition
   * presenter. This intentionally contains no HWND or process ID. */
  windowsD3d11Presenter?: WindowsD3d11PresenterDiagnostics
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

export interface WindowsD3d11PresenterBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsD3d11PresenterDiagnostics {
  layered: boolean
  transparent: boolean
  noActivate: boolean
  excludedFromCapture: boolean
  windowActive: boolean
  windowFocused: boolean
  previewGeneration?: number
  mediaGeneration: number
  generationMatches: boolean
  ownerProcessMatches: boolean
  sameAdapter: boolean
  sourceLive: boolean
  firstPresentSucceeded: boolean
  successfulPresents: number
  lastPresentedSequence?: number
  latestWinsDrops: number
  hiddenDrops: number
  busyDrops: number
  staleFrameDrops: number
  actualBounds?: WindowsD3d11PresenterBounds
  fallbackReason?: string
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
  nativePreviewIosurfaceImportLiveCount?: number
  nativePreviewIosurfaceImportPeakCount?: number
  nativePreviewIosurfaceImportCeiling?: number
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
  d3d11TextureAvailable?: boolean
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

/** `audio.mic.arm` params (instant record: keep the mic open while Studio is visible). */
export type WarmMicrophoneArmParams = {
  microphoneId?: string
  microphoneGainDb?: number
  microphoneMuted?: boolean
}

export type WarmMicrophoneStatus = {
  armed: boolean
  deviceId?: number
  deviceName?: string
  /** `not-coreaudio` | `session-active` | `disabled-for-smoke` | `open-failed` | `disarmed`. */
  reason?: string
  capturedFrames: number
  armedForMs?: number
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

/** Plan 092 Phase C: digital silence on the `audio.levels` wire (JSON has no -Infinity). */
export const AUDIO_LEVEL_FLOOR_DB = -120

/** Plan 092 Phase C: one level reading over the last window, dBFS, within -120..+48. */
export interface AudioLevelReading {
  peakDb: number
  rmsDb: number
}

/**
 * Plan 092 Phase C: `audio.levels`, about 20 a second while a session's audio
 * bus runs, or while the warm microphone stands by between sessions
 * (microphone only, no `sessionId`). Readings carry the configured gain: what
 * the recording and the stream get. A source with no samples in the window is
 * omitted.
 */
export interface AudioLevelsEvent {
  /** The session whose bus measured the levels; absent for the standby microphone. */
  sessionId?: string
  microphone?: AudioLevelReading
  systemAudio?: AudioLevelReading
  /** The mix written to the recording and the stream. */
  master?: AudioLevelReading
  /** Samples the mix clipped since the previous event. */
  masterClippedSamples: number
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
  bitrateKbps?: number
  totalBytes?: number
  duplicatedFrames?: number
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

export interface WebSocketCommandLaneDiagnosticStats {
  queue: WebSocketQueueDiagnosticStats
  expiredBeforeDispatchCount: number
  rejectedBeforeDispatchCount: number
}

export interface WebSocketTransportDiagnosticStats {
  reliableResponseQueue: WebSocketQueueDiagnosticStats
  incomingCommandQueue: WebSocketQueueDiagnosticStats
  coalescedTelemetryQueue: WebSocketQueueDiagnosticStats
  commandLanes: Record<string, WebSocketCommandLaneDiagnosticStats>
  slowPressureDisconnectCount: number
}

export interface PreviewCameraDropReasonStats {
  frameWasLate: number
  outOfBuffers: number
  discontinuity: number
  unknown: number
}

export interface PreviewScreenFrameStatusStats {
  complete: number
  idle: number
  blank: number
  suspended: number
  started: number
  stopped: number
  unknown: number
}

export interface PreviewSourceSurfaceBackingStats {
  liveCount: number
  peakCount: number
  estimatedBytes: number
  peakEstimatedBytes: number
  oldestAgeMs?: number
}

export type CaptureRecoveryPhase =
  | 'idle'
  | 'degraded'
  | 'restarting'
  | 'verifying'
  | 'recovered'
  | 'failed'

export type CaptureRecoveryStage = 'camera-delivery' | 'screen-delivery' | 'compositor-render'
export type CaptureRecoverySource = 'camera' | 'screen'
export type CaptureRecoveryTrigger = 'automatic' | 'manual'

/** Authoritative backend-owned state for one capture-recovery incident. */
export interface CaptureRecoveryStatus {
  /** Process-local monotonic ordering key. Resets when the backend process reconnects. */
  revision: number
  phase: CaptureRecoveryPhase
  retryable: boolean
  attempts: number
  stage?: CaptureRecoveryStage
  source?: CaptureRecoverySource
  trigger?: CaptureRecoveryTrigger
  sourceGeneration?: number
  detectedAt?: string
  updatedAt?: string
  message?: string
  lastError?: string
  lastDurationMs?: number
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
  /** Peak combined pending encoder + FIFO depth retained after recovery. */
  encoderBridgeOutputQueueHighWaterFrames?: number
  /** Oldest frame waiting for VideoToolbox completion or FIFO output. */
  encoderBridgeOutputQueueOldestFrameAgeMs?: number | null
  /** Peak oldest-frame age retained after recovery. */
  encoderBridgeOutputQueueOldestFrameAgeHighWaterMs?: number | null
  /** Milliseconds since the latest encoder completion or complete FIFO AU write. */
  encoderBridgeOutputLastProgressAgeMs?: number | null
  /** Enqueue attempts that encountered a full bounded output queue. */
  encoderBridgeOutputQueueCapacityPressureEvents: number
  /** Pressured intervals that returned to the healthy output budget. */
  encoderBridgeOutputPressureRecoveryEvents?: number
  /** Frames intentionally discarded by output backpressure policy. */
  encoderBridgeOutputQueueDroppedFrames: number
  /** Recording compositor ticks skipped before encode while queued AUs drain. */
  encoderBridgeOutputPreEncodeSkippedFrames?: number
  /** Current per-stage VideoToolbox output depths. */
  encoderBridgeVideoToolboxPendingEncodeFrames?: number
  encoderBridgeVideoToolboxPendingFifoFrames?: number
  /** Encoded H.264 AUs rejected after encode; healthy/recovered sessions require zero. */
  encoderBridgeEncodedAccessUnitDroppedFrames?: number
  encoderBridgeInputFps?: number
  encoderBridgeDroppedFrames: number
  /** FFmpeg progress-reported drops attributable to the recording bridge. */
  encoderBridgeRecordingDroppedFrames: number
  /** FFmpeg progress-reported drops attributable to the stream bridge. */
  encoderBridgeStreamDroppedFrames: number
  /** FFmpeg progress-reported encoder speed for the recording bridge. */
  encoderBridgeRecordingEncoderSpeed?: number
  /** FFmpeg progress-reported encoder speed for the stream bridge. */
  encoderBridgeStreamEncoderSpeed?: number
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
  /** Raw-video FFmpeg writes attributable to the recording bridge. */
  encoderBridgeRecordingRawVideoCopiedFrames: number
  /** Raw-video FFmpeg writes attributable to the stream bridge. */
  encoderBridgeStreamRawVideoCopiedFrames: number
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
  /** Generic encoded-output diagnostics populated by VideoToolbox and Media Foundation. */
  encoderBridgeEncodedOutputBackend?: string
  encoderBridgeRequestedVideoOutput?: string
  encoderBridgeEffectiveVideoOutput?: string
  encoderBridgeEncodedOutputEncoderIdentity?: string
  encoderBridgeEncodedOutputInputSubtype?: string
  encoderBridgeEncodedOutputFallbackReason?: string
  encoderBridgeEncodedOutputFrames?: number
  encoderBridgeEncodedOutputBytes?: number
  encoderBridgeEncodedOutputErrors?: number
  encoderBridgeEncodedSubmitP95Ms?: number
  encoderBridgeEncodedFifoWriteP95Ms?: number
  encoderBridgeActiveEncodedOutputEncoders?: number
  encoderBridgeRecordingEncodedOutputFrames?: number
  encoderBridgeRecordingEncodedOutputBytes?: number
  encoderBridgeStreamEncodedOutputFrames?: number
  encoderBridgeStreamEncodedOutputBytes?: number
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
  /** Latest measured FFmpeg output bitrate for the active stream. */
  streamMeasuredBitrateKbps?: number
  /** Lowest non-zero measured output bitrate observed in this stream session. */
  streamMeasuredBitrateMinKbps?: number
  /** Highest non-zero measured output bitrate observed in this stream session. */
  streamMeasuredBitrateMaxKbps?: number
  /** Cumulative bytes emitted by FFmpeg for this stream process generation. */
  streamOutputTotalBytes?: number
  /** Cumulative frames FFmpeg reports duplicating for this stream process generation. */
  streamDuplicatedFrames?: number
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
  /** Linux only: every render node the VAAPI policy saw and what it did with it. */
  linuxRenderNodes?: LinuxRenderNodeDiagnostic[]
  /** Linux VAAPI only: which argument profile the session encodes with. */
  linuxVaapiArgProfile?: LinuxVaapiArgProfile
  /** Which compositor backend produced the most recent diagnostic window. */
  compositorBackend?: CompositorBackend
  /** Why the compositor had to render on CPU fallback. */
  compositorFallbackReason?: string
  /**
   * Cumulative frames rendered by the CPU compositor as the platform's expected path (no GPU
   * compositor exists off macOS). Never a fault.
   */
  compositorCpuFrames: number
  /**
   * Cumulative frames rendered by CPU FALLBACK during the active compositor run: a GPU compositor
   * was expected and not reached. Nonzero is a fault.
   */
  compositorCpuFallbackFrames: number
  /** Cumulative render ticks of the active record/stream compositor run (frame accounting). */
  compositorTicks: number
  /** Cumulative frame intervals the record/stream compositor loop missed entirely. */
  compositorTickSkipped: number
  /** Recording-leg bridge writer ticks that fed a fresh compositor frame. */
  encoderBridgeFreshFrames: number
  /** Frames the recording-leg bridge submitted to the Media Foundation encoder (Windows only). */
  encoderBridgeMfSubmittedFrames: number
  /** Writer-thread Media Foundation input-credit waits that hit the two-frame cap and skipped a frame. */
  encoderBridgeMfInputCreditTimeouts: number
  /** P95 wall time the writer thread spent waiting for a Media Foundation input credit (Windows only). */
  encoderBridgeMfInputCreditWaitP95Ms?: number | null
  /** Scalar-only state for the Windows D3D11 media authority. */
  windowsD3d11Media?: WindowsD3d11MediaDiagnostics
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
  /** Phase timeline of the most recent session start (instant-record plan). */
  recordingStartTimeline?: RecordingTimelineSnapshot
  /** Phase timeline of the most recent stop, including finalization. */
  recordingStopTimeline?: RecordingTimelineSnapshot
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
  /** Cumulative held capture frames that reused an already imported Metal texture. */
  compositorSourceCaptureTextureReuses: number
  /** Camera subset of held capture texture reuses. */
  compositorCameraSourceCaptureTextureReuses: number
  /** Screen/window subset of held capture texture reuses. */
  compositorScreenSourceCaptureTextureReuses: number
  /** Completed-command boundaries that flushed the CoreVideo Metal texture cache. */
  compositorSourceTextureCacheFlushes: number
  /** Cached capture-source CVMetalTexture/IOSurface imports retained process-wide. */
  compositorMetalCachedCaptureSourceImportsLiveCount?: number | null
  /** Peak cached capture-source imports retained process-wide. */
  compositorMetalCachedCaptureSourceImportsPeakCount?: number | null
  /** Peak bounded capture-source cache capacity observed process-wide. */
  compositorMetalCachedCaptureSourceImportsCeiling?: number | null
  /** IOSurface-backed Metal target-ring slots currently retained process-wide. */
  compositorMetalTargetRingSlotsLiveCount?: number | null
  /** Peak IOSurface-backed Metal target-ring slots retained process-wide. */
  compositorMetalTargetRingSlotsPeakCount?: number | null
  /** Peak target-ring capacity; each compositor contributes the actual hard maximum of five. */
  compositorMetalTargetRingSlotsCeiling?: number | null
  /** Encoder guards currently retaining compositor target frames. */
  encoderBridgeMetalTargetRefsInFlightLiveCount?: number | null
  /** Peak encoder guards retaining compositor target frames. */
  encoderBridgeMetalTargetRefsInFlightPeakCount?: number | null
  /** Peak bounded in-flight capacity derived from the target-ring authorities. */
  encoderBridgeMetalTargetRefsInFlightCeiling?: number | null
  /** Native-presenter cached IOSurface imports currently retained. */
  nativePreviewIosurfaceImportLiveCount?: number | null
  /** Peak native-presenter cached IOSurface imports retained. */
  nativePreviewIosurfaceImportPeakCount?: number | null
  /** Hard cached-IOSurface import bound reported by the active presenter. */
  nativePreviewIosurfaceImportCeiling?: number | null
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
  /** Compositor ticks that served a camera frame the capture pipeline replaced since the previous tick. */
  compositorCameraSourceFreshServes: number
  /** Compositor ticks that re-served the identical camera frame handle (producer delivered nothing new). */
  compositorCameraSourceHeldServes: number
  /** Oldest capture age (ms) of any camera frame the compositor served. */
  compositorCameraSourceServedAgeMaxMs: number
  /** Compositor ticks that served a fresh screen/window frame. */
  compositorScreenSourceFreshServes: number
  /** Compositor ticks that re-served the identical screen/window frame handle. */
  compositorScreenSourceHeldServes: number
  /** Oldest capture age (ms) of any screen/window frame the compositor served. */
  compositorScreenSourceServedAgeMaxMs: number
  /**
   * The pipeline stage the backend's capture-health monitor currently
   * declares degraded ('camera-delivery' / 'screen-delivery' /
   * 'compositor-render'); absent while
   * healthy. Nullable for defense in depth against the serde-null trap.
   */
  capturePipelineDegradedStage?: string | null
  /** Recovery fields are omitted while idle; null remains tolerated at the renderer boundary. */
  captureRecoveryPhase?: CaptureRecoveryPhase | null
  captureRecoverySource?: CaptureRecoverySource | null
  captureRecoveryAttempts?: number | null
  captureRecoveryLastError?: string | null
  captureRecoveryLastDurationMs?: number | null
  previewRepeatedFrames: number
  previewSurfaceResizeCount: number
  previewLatencyMs?: number
  previewDroppedFrames: number
  previewCameraFrameAgeMs?: number
  previewCameraSourceFps?: number
  previewCameraDroppedFrames: number
  /** AVFoundation didOutput callbacks observed before local validation/publication. */
  previewCameraCaptureCallbackCount: number
  /** AVFoundation didDrop callbacks, excluding locally rejected didOutput samples. */
  previewCameraDidDropCallbackCount: number
  /** Camera frames successfully published to the source FrameStore. */
  previewCameraFrameStorePublications: number
  /** Age of the latest AVFoundation didOutput callback, whether or not it published. */
  previewCameraCaptureCallbackAgeMs?: number
  /** Latest camera FrameStore sequence visible to consumers. */
  previewCameraLatestSequence?: number
  /** FourCC delivered by the latest valid AVFoundation sample. */
  previewCameraCapturePixelFormat?: string
  previewCameraDropReasons: PreviewCameraDropReasonStats
  previewCameraSurfaceBacking: PreviewSourceSurfaceBackingStats
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
  /** ScreenCaptureKit callbacks observed before status/image validation. */
  previewScreenCaptureCallbackCount: number
  /** Screen frames successfully published to the source FrameStore. */
  previewScreenFrameStorePublications: number
  /** Age of the latest ScreenCaptureKit callback, including non-complete statuses. */
  previewScreenCaptureCallbackAgeMs?: number
  /** Latest screen FrameStore sequence visible to consumers. */
  previewScreenLatestSequence?: number
  previewScreenFrameStatuses: PreviewScreenFrameStatusStats
  previewScreenSurfaceBacking: PreviewSourceSurfaceBackingStats
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
  /** Whether the latest Windows Graphics Capture frame retained its D3D11 source texture. */
  previewScreenD3d11TextureAvailable?: boolean
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
  /** CPU buffers currently owned by the camera/screen stores and spare pools. */
  previewSourceFrameBufferCount: number
  /** CPU bytes currently owned by the camera/screen stores and spare pools. */
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
  /** System audio live meter (0-1, dB-scaled); absent while no system source
   * is attached (plan 069). */
  systemAudioLiveLevel?: number | null
  systemAudioLivePeakDb?: number | null
  systemAudioCapturedFrames?: number | null
  /** True while a system audio source is attached to the session audio bus. */
  systemAudioActive?: boolean | null
  /** Samples the mix limiter pulled under its ceiling this session. */
  audioMixClippedSamples?: number | null
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
// 'unknown' for errors where it cannot be read and 'not-applicable' for Linux,
// where Electron has no such API and no OS-level camera/mic grant exists (the
// permission chips hide themselves for it instead of showing an unknown state).
export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'
  | 'not-applicable'

export interface MediaAccessSnapshot {
  camera: MediaAccessStatus
  microphone: MediaAccessStatus
}

export interface HealthEvent {
  id: string
  sessionId?: string | null
  level: HealthLevel
  code: string
  message: string
  permissionPane?: SystemPermissionPane | null
  createdAt: string
}

export interface SessionLogEntry {
  id: string
  sessionId: string
  level: HealthLevel
  code: string
  message: string
  sourceId?: string | null
  permissionPane?: SystemPermissionPane | null
  createdAt: string
}

/** Where a moment came from (plan 068 D6). */
export type ClipMomentSource = 'voice' | 'manual' | 'chat'

/** A clip-worthy time range: a mark the streamer placed, or a chat spike,
 * snapped to captions. */
export interface ClipMoment {
  startMs: number
  endMs: number
  reason: string
  excerpt: string
  /** Omitted by an older backend, so a missing source reads as chat. */
  source?: ClipMomentSource
}

/** Who placed a clip mark: a spoken "clip that" or the Mark clip control. */
import type { MarkerContext, MarkerRelayCommand, MarkerRelayResult } from './session-markers'
export type * from './session-markers'

export type ClipMarkSource = 'voice' | 'manual'

/** One persisted clip mark at a recording-file time (plan 068 D6). */
export interface ClipMark {
  id: string
  sessionId: string
  atSeconds: number
  source: ClipMarkSource
  /** The spoken phrase for a voice mark. Omitted, never null. */
  phrase?: string
  createdAt: string
}

/** `clip.marked` event and the `clip.mark` reply. `saved: false` carries a
 * reason code (`recording-off`): the moment was heard but nothing was kept. */
export interface ClipMarkedEvent {
  sessionId: string
  atSeconds: number
  source: ClipMarkSource
  saved: boolean
  reason?: string
}

/** Stream Manager → main renderer: mark a clip now (plan 068 D6). */
export interface ClipMarkCommand {
  requestId: string
}

/** Show who followed (plan 071, S2): reconnect a platform with its follow
 * permission. Only Twitch needs one today. */
export interface FollowNamesCommand {
  requestId: string
  platform: 'twitch'
}

/** The platforms the Stream Manager can reconnect for a missing permission
 * (plan 140, S5). The list lives in `shared/platform-scopes.ts`. */
export type ScopeReconnectPlatform = Extract<StreamPlatform, 'twitch' | 'kick'>

/** Stream Manager → main: reconnect Twitch or Kick asking for every optional
 * permission, so Golem can remove messages (plan 140, S5). Main picks the
 * scopes; the window only names the platform. */
export interface ScopeReconnectCommand {
  requestId: string
  platform: ScopeReconnectPlatform
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
  /** Clean cut (plan 119, docs/clean-cut-contract.md part B). Older servers
   * omit it, which means Clean cut is not available. `reasonCode` is open. */
  cleanCut?: {
    supported: boolean
    available: boolean
    reasonCode: string | null
    maxChunkSeconds?: number
    maxChunkBytes?: number
    monthlySecondsLimit: number | null
    remainingSeconds: number | null
    modes?: string[]
    workflowKind?: string
  }
  /** The Golem routes (plan 164): the tick contract the web speaks and
   * whether avatar generation is on, with today's remaining count. Older
   * servers omit the block: Generate stays off. */
  cohost?: {
    tick?: number
    avatar?: {
      enabled: boolean
      remainingToday: number
      dailyLimit: number
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
    /** Clean cut kill switch off and its provider configured; older servers omit it. */
    cleanCutEnabled?: boolean
    cloudAiEnabled: boolean
    /** The Golem command parser route is on (plan 140 S8); older servers omit it. */
    cohostCommandEnabled?: boolean
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

export interface SessionListItem {
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
  healthEventCount: number
  sessionLogCount: number
  aiArtifactCount: number
  readyAiArtifactKinds?: AiArtifactKind[]
  commentCount: number
  /** Present only for managed derivatives created from another Library session. */
  derivedFromSessionId?: string
  sourceTitle?: string
  processingKind?: 'noise-cleanup'
  /** Present only on a derived row Clean cut rendered (plan 119 S13): the
   * source session and the mode. `processingKind` stays absent for these rows. */
  cleanCutOfSessionId?: string
  cleanCutMode?: CleanCutMode
  /** Background MP4 finalization (instant-record P2); absent for legacy rows. */
  finalizationState?: RecordingFinalizationState
  /** Live export progress from the backend registry (only while finalizing). */
  finalizationProgressPercent?: number
  finalizationError?: string
}

/** Progress of a background recording finalization job (`recording.finalization`). */
export interface RecordingFinalizationEvent {
  sessionId: string
  state: RecordingFinalizationState
  progressPercent?: number
  mp4Path?: string
  outputPath?: string
  durationMs?: number
  fileSizeBytes?: number
  error?: string
  updatedAt: string
}

/** Backwards-compatible name for renderer consumers while the Library model
 * remains a summary. It intentionally has no history arrays. */
export type SessionSummary = SessionListItem

export interface SessionListParams {
  cursor?: string
  limit?: number
}

export interface SessionListPage {
  items: SessionListItem[]
  nextCursor?: string
}

export interface SessionDetailListParams {
  sessionId: string
  cursor?: string
  limit?: number
}

export interface SessionHealthEventsPage {
  events: HealthEvent[]
  nextCursor?: string
}

export interface SessionLogsPage {
  entries: SessionLogEntry[]
  nextCursor?: string
}

export interface SessionAiArtifactsPage {
  artifacts: AiArtifact[]
  nextCursor?: string
}

export interface SessionDetails {
  healthEvents: HealthEvent[]
  sessionLogs: SessionLogEntry[]
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
  /** Launch-time graphics policy plus persisted recovery evidence. */
  gpuFallback: {
    source: 'env' | 'persisted' | 'retry' | 'none'
    reason: string | null
    crashCount: number
    updatedAt: string | null
    retryScheduled: boolean
    retryAttempts: number
  }
  /**
   * The main window's material and why (plan 082), so a support bundle shows
   * whether Mica was dropped. `paintCheck` is the Windows Mica check's
   * verdict on whether the page drew anything; `skipped` off Mica.
   */
  windowGlass?: {
    kind: 'material' | 'mica' | 'solid'
    reason: string | null
    paintCheck: 'pending' | 'painted' | 'blank' | 'unknown' | 'skipped'
    /**
     * Plan 091: how the macOS material is drawn on the main window (`clear`
     * is the stripped, neutral blur), null without a material, and the style
     * `VIDEORC_GLASS_STYLE` asked for.
     */
    style: 'clear' | 'material' | null
    styleRequested: 'clear' | 'material'
  }
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
  /** Persisted backend crash evidence (most recent first, last 5). Survives
   * supervisor restarts and app relaunches so a support bundle exported after
   * "Backend crashed, restarting" still names the exit and its last stderr. */
  backendCrashes?: BackendCrashRecord[]
}

/** One backend process exit worth keeping: every non-intentional exit plus
 * intentional shutdowns that still reported a non-zero code. Written by the
 * main-process supervisor to `userData/backend-crashes.json`. */
export interface BackendCrashRecord {
  /** ISO timestamp of the exit observation. */
  at: string
  /** Supervisor generation (1-based per app launch) of the process that died. */
  generation: number
  code: number | null
  signal: string | null
  /** Restart attempt number the supervisor assigned, or null when no restart
   * was scheduled (app quitting, intentional stop with a non-zero code). */
  attempt: number | null
  uptimeMs: number
  intentional: boolean
  /** Last stderr lines of that process (each line truncated). */
  stderrTail: string[]
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

// Which DOM slot a docked preview glues to: the Studio preview card or the
// Scene tab's canvas (plan 058). Only one tab mounts at a time, so the two
// reporters never fight; the field lets main state which slot owns the surface
// and lets the Scene stage know when it is the live canvas.
export type DockSlot = 'studio' | 'scene'

export const DOCK_SLOTS = ['studio', 'scene'] as const satisfies readonly DockSlot[]

// Renderer → main slot measurement for docked mode. WINDOW-RELATIVE CSS pixels
// only: the renderer must never compute screen coordinates (main owns the
// window-position math synchronously; see preview-dock.ts).
export interface DockSlotReport {
  epoch: number
  slot: DockSlot
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

// --- Chat moderation (plan 140 S4) ---
// Wire mirror of crates/videorc-backend/src/live_chat_moderation.rs. Every
// removal is a durable, audited operation; the backend owns the timers. The
// event `liveChat.moderationOperation` carries a ModerationOperation on every
// change. Manual removal is free; `orcle-voice` needs Premium.

export type ModerationSource = 'manual' | 'orcle-voice'
export type RemoveConfirmMode = 'confirm' | 'countdown'
export type ModerationPhase =
  | 'pending-confirm'
  | 'cancelled'
  | 'expired'
  | 'executing'
  | 'removed'
  | 'hidden-locally'
  | 'failed'
  | 'delivery-unknown'
export type ModerationOutcomeCode =
  | 'removed'
  | 'missing-scope'
  | 'unsupported'
  | 'quota-paused'
  | 'too-old'
  | 'provider-error'
  | 'not-found'

/** One audited removal, as `liveChat.moderation.*` return it and the event carries it. */
export interface ModerationOperation {
  operationId: string
  sessionId: string
  messageId: string
  platform: StreamPlatform
  targetId?: string
  authorName: string
  /** At most 140 characters of the message, for the card and the audit row. */
  excerpt: string
  source: ModerationSource
  /** Audit only ("toxic", "spam"), at most 40 characters. */
  reason?: string
  phase: ModerationPhase
  confirmMode: RemoveConfirmMode
  /** True whenever the operation runs only on an explicit confirm (always on YouTube). */
  requiresExplicitConfirm: boolean
  /** Confirm mode: when the open card expires (20 s), RFC 3339. */
  confirmBy?: string
  /** Countdown mode: when the removal runs unless cancelled (5 s), RFC 3339. */
  executeAt?: string
  /** A plain sentence for the chip, the card and the operation list. */
  outcome?: string
  outcomeCode?: ModerationOutcomeCode
  createdAt: string
  updatedAt: string
}

/** `liveChat.moderation.request` params. `confirmMode` defaults to `confirm`. */
export interface ModerationRequestParams {
  /** UUID v4 minted by the caller: the idempotency key. */
  operationId: string
  /** The app message id (`LiveChatMessage.id`). */
  messageId: string
  source: ModerationSource
  reason?: string
  confirmMode?: RemoveConfirmMode
}

/** `liveChat.moderation.confirm` and `liveChat.moderation.cancel` params. */
export interface ModerationOperationParams {
  operationId: string
}

/**
 * Stream Manager → main → Studio renderer (plan 140, S6): "Remove from chat"
 * on one message, or an answer to an open removal card. The window never
 * picks the source: Studio sends every `remove` as `manual`, which runs at
 * once (the menu click is the express consent). Voice removals come from the
 * backend's own Golem engine, never through this relay.
 */
export type CommentsModerationCommand =
  | {
      requestId: string
      sessionId: string
      action: 'remove'
      /** UUID v4 minted by the window: the idempotency key. */
      operationId: string
      messageId: string
    }
  | {
      requestId: string
      sessionId: string
      action: 'confirm' | 'cancel'
      operationId: string
    }

export interface CommentsSendCommand {
  requestId: string
  operationId: string
  sessionId: string
  text: string
  /** Co-host reply: the open question this send answers (cleared on sent/partial). */
  inReplyToQuestionId?: string
  /** Only these providers (the Stream Manager's "Send to" picker); absent sends to all. */
  destinationIds?: string[]
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

/** Corner of the stream canvas the highlighted message is composited into.
 * Mirrors Rust `CommentHighlightAnchor` (kebab-case). */
export const COMMENT_HIGHLIGHT_ANCHORS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
] as const

export type CommentHighlightAnchor = (typeof COMMENT_HIGHLIGHT_ANCHORS)[number]

// Owner call 2026-09-20: bottom left keeps the card off faces and off the
// usual top-right camera bubble; captions on the same edge step above it.
export const DEFAULT_COMMENT_HIGHLIGHT_ANCHOR: CommentHighlightAnchor = 'bottom-left'

/** Unknown or missing values (old prefs file, forged IPC) land on the default. */
export function normalizeCommentHighlightAnchor(value: unknown): CommentHighlightAnchor {
  return (COMMENT_HIGHLIGHT_ANCHORS as readonly unknown[]).includes(value)
    ? (value as CommentHighlightAnchor)
    : DEFAULT_COMMENT_HIGHLIGHT_ANCHOR
}

export interface SetCommentHighlightParams {
  sessionId: string
  messageId: string
  pngBase64: string
  anchor: CommentHighlightAnchor
  /** The placed highlight rect for the horizontal canvas (plan 164); omitted
   *  keeps the `anchor` corner. */
  rect?: OverlayRect
  /** The same card rasterized for the vertical simulcast leg; sent only when
   *  `comments.highlight.canvases` reports a vertical canvas. */
  verticalPngBase64?: string
  /** The placed highlight rect for the vertical leg (plan 164). */
  verticalRect?: OverlayRect
}

/** `comments.highlight.canvases`: extra canvases the running session burns
 *  the card on. Mirrors Rust `CommentHighlightCanvases`. */
export interface CommentHighlightCanvases {
  vertical?: { width: number; height: number }
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
  /**
   * Live mode only (plan 140, S6): the live session's chat removals, every
   * open one then the newest finished ones, at most 100. Studio publishes it;
   * the Stream Manager renders the row status and Golem's removal cards.
   */
  moderationOperations?: ModerationOperation[]
  /** History mode only: the finished session's saved stats (plan 055, S9). */
  history?: CommentsHistoryStats
}

export interface CommentsHistoryStats {
  viewers: ViewerSample[]
  audience: AudienceSnapshot | null
  chatTotals?: SessionChatTotals | null
}

/** Whole-session accounting from SQLite, independent of retained chat rows.
 * Legacy rows lack complete gift/correction ownership and are never backfilled
 * by guessing. The unavailable variant deliberately has no numeric totals. */
export type SessionChatTotals =
  | {
      status: 'available'
      sessionId: string
      revision: number
      messageCount: number
      chatters: number
      platforms: StreamPlatform[]
      follows: number
      supporters: number
      bits: number
      tips: { currency: string; amountMicros: number }[]
      raids: number
    }
  | { status: 'legacy-unavailable'; sessionId: string }

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
  // The slot of the last ACCEPTED report (current epoch), null when none has
  // landed yet or the preview is not docked; the Scene stage becomes the live
  // canvas only while this reads 'scene'.
  dockSlot: DockSlot | null
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
  nativePreviewHostKind?: NativePreviewHostKind
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
  captureProtectionMarkerInstalled?: boolean
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
  /** Where highlighted messages land on the stream. Owned by main so a
   * highlight fired with the window closed (shortcut, deck, co-host) still
   * honours the streamer's pick. */
  highlightAnchor: CommentHighlightAnchor
  /** Auto-show Activity celebrations on stream (plan 156). Owned by main for
   * the same reason as the anchor: the engine runs in the Studio renderer
   * and must keep working with the window closed. Default OFF. */
  autoShowActivity: boolean
  protected: boolean
  captureProtectionMarkerInstalled?: boolean
  enabled: boolean
  message?: string
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
  // `windows-feed-unpublished`: a Windows build found no update published for
  // it (no public Alpha feed, and no signed-in pilot access). Rechecked.
  | { phase: 'unsupported'; reason?: 'windows-feed-unpublished' }

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

export interface RemoteControlStatus {
  enabled: boolean
  token: string | null
  port: number
  connectedClients: number
  discoveryPath: string | null
}

/** Phone remote (LAN, protocol 2 — docs/remote-control.md). Carries no key
 * material: device keys never leave the backend. */
export interface RemoteLanDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt?: string
  connected: boolean
}

export interface RemoteLanStatus {
  enabled: boolean
  /** Bound port; absent while off or when the bind failed. */
  port?: number
  /** Private IPv4 addresses a phone could reach this computer on. */
  addresses: string[]
  devices: RemoteLanDevice[]
  bindError?: string
  pairingExpiresAt?: string
}

/** The one place the single-use pairing secret exists outside the backend:
 * rendered as a QR code, never logged or persisted. */
export interface RemoteLanPairing {
  url: string
  address: string
  addresses: string[]
  expiresAt: string
}

export interface GlobalShortcutsConfig {
  layoutNext?: string
  layoutPrevious?: string
  layouts?: Partial<Record<LayoutPreset, string>>
  recordToggle?: string
  streamToggle?: string
  micToggle?: string
  /** Turn system audio on/off (plan 069 S6). Unbound by default. */
  systemAudioToggle?: string
  /** Mark a clip at the current moment (plan 068 D6). Unbound by default. */
  clipMark?: string
}

export interface GlobalShortcutsResult {
  registered: Record<string, boolean>
  /** Main held the config because the shortcut recorder is armed; it
   * registers on disarm and this result says nothing about conflicts. */
  deferred?: true
}

/** A key event main captured for the Settings shortcut recorder (plan 062).
 * `code` is the physical key; the recorder maps it, never `key`. */
export interface ShortcutRecorderKeyEvent {
  type: 'keyDown' | 'keyUp'
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export interface ShortcutRecorderArmResult {
  armed: boolean
}

/** Why main refused to mint a session media grant (plan 119, S11). */
export type SessionMediaGrantRefusal =
  /** No such session, no managed file, or the file is gone (or reached through a symlink). */
  | 'not-found'
  /** The session's managed file is not an `.mp4`. */
  | 'not-mp4'
  /** The MP4 exists but has no index yet: the recording is still being finalized. */
  | 'not-ready'

export type SessionMediaGrantResult =
  | { url: string; expiresAt: number }
  | { error: SessionMediaGrantRefusal }

export interface VideorcApi {
  setGlobalShortcuts?: (shortcuts: GlobalShortcutsConfig) => Promise<GlobalShortcutsResult>
  onGlobalShortcut?: (callback: (action: GlobalShortcutAction) => void) => () => void
  /** While armed, main suspends Videorc's global shortcuts and forwards every
   * main-window key to `onShortcutRecorderKey` instead of the page. */
  setShortcutRecorderArmed?: (armed: boolean) => Promise<ShortcutRecorderArmResult>
  onShortcutRecorderKey?: (callback: (input: ShortcutRecorderKeyEvent) => void) => () => void
  /** Main disarmed on its own (window blur, reload, idle timeout). */
  onShortcutRecorderDisarmed?: (callback: () => void) => () => void
  getBackendConnection: () => Promise<BackendConnection | null>
  getBackendLogs: () => Promise<BackendLogEvent[]>
  getRuntimeInfo: () => Promise<RuntimeInfo>
  retryHardwareAcceleration: () => Promise<RuntimeInfo>
  pickScreenImage: () => Promise<ResourceSelection | null>
  pickFile: () => Promise<ResourceSelection | null>
  pickDirectory: () => Promise<ResourceSelection | null>
  checkDirectory: (directoryHandleId: string) => Promise<DirectoryFacts>
  authorizeOutputDirectory: (directoryHandleId: string) => Promise<ResourceSelection>
  // Picks a PNG/JPG/WebP and copies it into app-support storage, returning the
  // managed asset (Assets Tab plan, slice A4).
  importBackgroundImage: () => Promise<BackgroundImportResult | null>
  importScheduledThumbnail: () => Promise<ScheduledThumbnail | null>
  /** Picks a PNG/WebP (JPEG for idle) and copies it into the persona's
   * managed folder (plan 164 S-A3); null when the picker was cancelled. */
  importGolemImage: (
    personaId: string,
    state: CohostAvatarState
  ) => Promise<GolemImageImportResult | null>
  /** "Start over": deletes the persona's managed folder. */
  removeGolemPersona: (personaId: string) => Promise<void>
  /** The bytes of one stored persona image (`<personaId>/<state>.<ext>`) for
   * the Golem overlay raster to decode (plan 164 S-C2); null when there is
   * no such file. The renderer cannot fetch the managed scheme itself. */
  readGolemImage: (relativePath: string) => Promise<Uint8Array | null>
  backgroundAssetExists: (assetId: string) => Promise<boolean>
  /** Fetch-and-cache a chat avatar from an allowlisted platform CDN; returns a
   * local videorc-asset:// URL or null (disallowed host / fetch failure). */
  cacheChatAvatar: (url: string) => Promise<string | null>
  /** A Twitch GIF Keyboard asset through main's cache (plan 155): the
   * managed local URL, or null when the gate, the size cap, the deadline or
   * the image sniff refused it. */
  cacheChatGif: (url: string) => Promise<string | null>
  /** The main renderer relays Settings → "GIFs in Twitch chat" (plan 155);
   * the Stream Manager window seeds from main's cache and follows pushes. */
  pushChatGifMode: (mode: TwitchGifMode) => Promise<void>
  getChatGifMode: () => Promise<TwitchGifMode>
  onChatGifMode: (callback: (mode: TwitchGifMode) => void) => () => void
  /** The bytes of one cached image (`videorc-asset://avatar/...`) for the
   * highlight card to decode with `createImageBitmap` (plan 095, S3): null
   * when the URL names no managed cache file or it is over the 2 MB cap. */
  readChatAvatar: (localUrl: string) => Promise<Uint8Array | null>
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
  /** Mark clip from the Stream Manager (plan 068 D6): the MAIN renderer owns
   * the backend socket and makes the `clip.mark` RPC; the reply says where the
   * mark landed and whether it was saved. */
  getMarkerContext: () => Promise<MarkerContext | null>
  pushMarkerContext: (context: MarkerContext | null) => Promise<boolean>
  onMarkerContext: (callback: (context: MarkerContext | null) => void) => () => void
  markerFromCommentsWindow: (command: MarkerRelayCommand) => Promise<MarkerRelayResult>
  onMarkerRequest: (callback: (command: MarkerRelayCommand) => void) => () => void
  pushMarkerResult: (resolution: CommentsCommandResolution<MarkerRelayResult>) => Promise<boolean>
  markClipFromCommentsWindow: (command: ClipMarkCommand) => Promise<ClipMarkedEvent>
  onClipMarkRequest: (callback: (command: ClipMarkCommand) => void) => () => void
  pushClipMarkResult: (resolution: CommentsCommandResolution<ClipMarkedEvent>) => Promise<boolean>
  /** Show who followed from the Stream Manager (plan 071, S2): Electron main
   * starts the Twitch reconnect with the follow permission over its admin
   * socket and opens the browser, so the main window's eager bundle carries
   * none of it. Resolves once the browser opened. */
  showFollowNamesFromCommentsWindow: (command: FollowNamesCommand) => Promise<boolean>
  /** "Reconnect Twitch to let Golem remove messages" from the Stream Manager
   * (plan 140, S5): like Show who followed, main starts the reconnect with
   * every optional permission and opens the browser. Resolves once it opened. */
  reconnectScopesFromCommentsWindow: (command: ScopeReconnectCommand) => Promise<boolean>
  /** Chat removal relay (plan 140, S6): the Stream Manager's "Remove from
   * chat" and its removal-card answers. The MAIN renderer owns the backend
   * socket and makes the `liveChat.moderation.*` call; the reply is the
   * operation as the backend left it. */
  moderateFromCommentsWindow: (command: CommentsModerationCommand) => Promise<ModerationOperation>
  onModerationRequest: (callback: (command: CommentsModerationCommand) => void) => () => void
  pushModerationResult: (
    resolution: CommentsCommandResolution<ModerationOperation>
  ) => Promise<boolean>
  /** Co-host relay: the main renderer pushes state, the window seeds + follows
   * it, and window actions come back through the same correlated broker. */
  pushCohostWindowState: (state: CohostWindowState) => Promise<void>
  /** Never null: main seeds the relay cache with `offCohostWindowState()`. */
  getCohostWindowState: () => Promise<CohostWindowState>
  onCohostWindowState: (callback: (state: CohostWindowState) => void) => () => void
  sendCohostAction: (command: CohostActionCommand) => Promise<CohostState>
  /** Answers to Golem's voice command cards (plan 140, S6 part B), relayed
   * like the other Golem actions: the MAIN renderer makes the call. */
  sendCohostCommand: (command: CohostCommandRelayCommand) => Promise<CohostState>
  onCohostCommandRequest: (callback: (command: CohostCommandRelayCommand) => void) => () => void
  pushCohostCommandResult: (resolution: CommentsCommandResolution<CohostState>) => Promise<boolean>
  onCohostActionRequest: (callback: (command: CohostActionCommand) => void) => () => void
  pushCohostActionResult: (resolution: CommentsCommandResolution<CohostState>) => Promise<boolean>
  /** Turning co-host on (and granting cloud-AI consent) from the Comments
   * window: the MAIN renderer owns both settings, so the window asks. The
   * result is the relayed window state, so the switch never lies. */
  sendCohostEnable: (command: CohostEnableCommand) => Promise<CohostWindowState>
  onCohostEnableRequest: (callback: (command: CohostEnableCommand) => void) => () => void
  pushCohostEnableResult: (
    resolution: CommentsCommandResolution<CohostWindowState>
  ) => Promise<boolean>
  getBundledBackgroundAssets: () => Promise<BackgroundImportResult[]>
  beginAccountSignIn: (authorizeUrl: string) => Promise<void>
  /** Best-effort product-account identity refresh owned by Electron Main's
   * independent admin socket. Never shares the renderer's live-control lane.
   * Resolves `deferred` while a recording or stream is active. */
  refreshAccount: () => Promise<VideorcAccountRefreshResult>
  signOutAccount: () => Promise<VideorcAccountSnapshot>
  getPendingAccountCallbacks: () => Promise<AccountCallbackEnvelope[]>
  acknowledgeAccountCallback: (callbackId: string) => Promise<boolean>
  onAccountCallback: (callback: (envelope: AccountCallbackEnvelope) => void) => () => void
  getPendingOAuthCallbacks: () => Promise<OAuthCallbackEnvelope[]>
  acknowledgeOAuthCallback: (callbackId: string) => Promise<boolean>
  openOAuthUrl: (authUrl: string) => Promise<void>
  /** Open a link from chat in the browser (plan 151): true when it opened,
   * false when main refused it (not http(s), credentials, too long). */
  openChatLink: (url: string) => Promise<boolean>
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
  setCommentsWindowHighlightAnchor: (anchor: CommentHighlightAnchor) => Promise<CommentsWindowState>
  setCommentsWindowAutoShowActivity: (on: boolean) => Promise<CommentsWindowState>
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
    generation: number,
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
  requestMediaAccess: (pane: 'camera' | 'microphone') => Promise<MediaAccessResult>
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
  /** Stream Manager dashboard relay (plan 055, S7): main renderer -> main -> window. */
  pushDashboard?: (state: LiveDashboardState | null) => Promise<void>
  getDashboard?: () => Promise<LiveDashboardState | null>
  onDashboard?: (callback: (state: LiveDashboardState | null) => void) => () => void
  openSession: (sessionId: string) => Promise<string>
  /**
   * In-app playback (plan 119, S11): mints a short-lived grant for one
   * finalized recording MP4, served Range-aware at
   * `videorc-asset://session-media/<grantId>`. Main-window only. Calling again
   * for the same session renews the grant and keeps its URL while the file is
   * unchanged; the grant also dies with the window.
   */
  grantSessionMedia: (sessionId: string) => Promise<SessionMediaGrantResult>
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
  /** Whether the command modifier is physically down; see main's before-input-event. */
  onShortcutModifier: (callback: (held: boolean) => void) => () => void
  /** Whether the main window is on screen (minimise/hide aware, unlike the Page Visibility API here). */
  onWindowVisible: (callback: (visible: boolean) => void) => () => void
  onBackendConnection: (callback: (connection: BackendConnection) => void) => () => void
  onBackendLifecycle: (callback: (event: BackendLifecycleEvent) => void) => () => void
  onBackendLog: (callback: (log: BackendLogEvent) => void) => () => void
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
  /** "Remove messages" readiness (plan 140); absent without an account. */
  moderate?: CommentsModerateState
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

/**
 * Whether Videorc can remove a viewer's message on a destination (plan 140):
 * `missing-scope` means reconnect (or authorize X Live), `paused` means the
 * YouTube quota breaker is set.
 */
export type CommentsModerateState = 'ready' | 'missing-scope' | 'unsupported' | 'paused'

/** What kind of chat row a message is — drives styling for monetized/system events. */
export type LiveChatEventType =
  | 'message'
  | 'paid'
  | 'membership'
  | 'system'
  | 'deleted'
  | 'moderation'
  | 'follow'
  /** Activity-only Twitch rows (plan 162): never listed in chat. */
  | 'power-up'
  | 'redemption'

/** Event types listed in Activity and never in the chat list: follows, Twitch
 * Power-ups and channel point redemptions (plan 162). */
export function isActivityOnlyEvent(eventType: LiveChatEventType): boolean {
  return eventType === 'follow' || eventType === 'power-up' || eventType === 'redemption'
}

/** Which Twitch Power-up a viewer paid bits for (plan 162). */
export type LiveChatPowerUpKind = 'celebration' | 'gigantify-an-emote' | 'message-effect' | 'custom'

/** Which channel point reward a viewer redeemed (plan 162). */
export type LiveChatRedemptionKind =
  | 'custom'
  | 'highlighted-message'
  | 'sub-only-message'
  | 'random-emote-unlock'
  | 'chosen-emote-unlock'
  | 'modified-emote-unlock'
  /** An automatic reward Twitch added after this build. */
  | 'other'

export type LiveChatMembershipKind = 'new' | 'upgrade' | 'milestone' | 'gift' | 'gift-received'

/** Twitch subscription notice kinds, kebab-cased from EventSub's `notice_type`. */
export type LiveChatSubscriptionKind =
  | 'sub'
  | 'resub'
  | 'sub-gift'
  | 'community-sub-gift'
  | 'gift-paid-upgrade'
  | 'prime-paid-upgrade'
  | 'pay-it-forward'

/**
 * Structured event facts (wire mirror of live_chat.rs `LiveChatEventDetails`,
 * plan 055). Absent on plain chat. Amounts are micros of `currency`; a Twitch
 * `tier` is `1000`/`2000`/`3000`.
 */
export type LiveChatEventDetails =
  | {
      kind: 'super-chat'
      amountMicros: number
      currency: string
      amountDisplay: string
      tier?: number
    }
  | {
      kind: 'super-sticker'
      amountMicros: number
      currency: string
      amountDisplay: string
      altText?: string
    }
  | {
      kind: 'membership'
      membership: LiveChatMembershipKind
      levelName?: string
      months?: number
      giftCount?: number
    }
  | {
      kind: 'subscription'
      subscription: LiveChatSubscriptionKind
      tier?: string
      isPrime: boolean
      months?: number
      streakMonths?: number
      giftCount?: number
      recipientName?: string
      /** Ties Twitch's single gifts to their community gift. */
      communityGiftId?: string
    }
  | { kind: 'cheer'; bits: number }
  /** Kick KICKs (plan 066): `amount` in KICKs, `giftName` the gift ("Rage Quit"). */
  | { kind: 'kicks'; amount: number; giftName?: string }
  | { kind: 'raid'; viewerCount: number }
  | { kind: 'announcement'; color?: string }
  /** `handle`: the @-mentionable login when the platform sent one (plan 071). */
  | { kind: 'follow'; handle?: string }
  /** A Twitch watch streak (plan 151): `streakCount` streams in a row.
   * `channelPointsAwarded` is what the viewer earned; kept, never shown. */
  | { kind: 'watch-streak'; streakCount: number; channelPointsAwarded?: number }
  /** A Twitch Power-up paid with bits (plan 162); `emoteName` when
   * gigantified, `title` a Custom Power-up's own name (plan 163). */
  | {
      kind: 'power-up'
      bits: number
      powerUp: LiveChatPowerUpKind
      emoteName?: string
      title?: string
    }
  /** A Twitch channel point redemption (plan 162). `title` is a custom
   * reward's; automatic rewards have none. `pointsName` is the channel's own
   * name for its points ("Orc Gold", plan 163), absent for Twitch's default. */
  | {
      kind: 'redemption'
      reward: LiveChatRedemptionKind
      channelPoints: number
      title?: string
      emoteName?: string
      pointsName?: string
    }

/** The message a chat message replies to, when the platform threads replies. */
export interface LiveChatReply {
  parentMessageId: string
  parentAuthorName: string
  parentText: string
}

/** Live connector state for one platform within a session. */
export interface LiveChatProviderState {
  id: string
  platform: StreamPlatform
  targetId?: string
  accountId?: string
  accountLabel?: string
  read: CommentsReadState
  write: CommentsWriteState
  /** "Remove messages" readiness (plan 140), next to `write`; absent without an account. */
  moderate?: CommentsModerateState
  state: LiveChatProviderConnectionState
  message: string
  lastConnectedAt?: string
  lastMessageAt?: string
  lastError?: string
  /**
   * While `state` is `waiting` for a known reason with a known end (the
   * YouTube quota pause, plan 094): when the connector resumes, RFC 3339.
   * Shown in local time; absent otherwise.
   */
  retryAt?: string
}

/** A rich-text fragment of a message (plain text, emote, mention, …). */
export interface LiveChatMessageFragment {
  type: string
  text: string
  imageUrl?: string
  /** A 7TV zero-width emote (plan 089): drawn on top of the emote before it. */
  zeroWidth?: boolean
}

/** Where 7TV emotes stand (plan 089): the line under the Settings switch. */
export type SevenTvState = 'off' | 'idle' | 'loading' | 'linked' | 'notLinked' | 'error'

export interface SevenTvStatus {
  state: SevenTvState
  setName?: string
  emoteCount?: number
  globalCount?: number
  platforms?: StreamPlatform[]
  error?: string
}

/** `liveChat.emotes.get` / `.set`, and the `liveChat.emotes` event. */
export interface ChatEmotesSettings {
  sevenTv: boolean
  sevenTvStatus: SevenTvStatus
  /** Settings → General → "GIFs in Twitch chat" (plan 155, D6). */
  twitchGifs: TwitchGifMode
}

export interface ChatEmotesSettingsPatch {
  sevenTv?: boolean
  twitchGifs?: TwitchGifMode
}

/**
 * The organization badge a platform shows next to an affiliated author's name:
 * X's affiliation, a Verified Organization's logo (plan 086).
 */
export interface LiveChatAuthorAffiliation {
  /** Always `https://`; main's avatar cache serves it to the renderer. */
  badgeUrl: string
  /** The organization's name, e.g. "Neon". */
  description?: string
  url?: string
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
  authorAffiliation?: LiveChatAuthorAffiliation
  authorRoles: string[]
  publishedAt: string
  receivedAt: string
  messageText: string
  fragments: LiveChatMessageFragment[]
  eventType: LiveChatEventType
  amountText?: string
  isDeleted: boolean
  rawProviderType?: string
  details?: LiveChatEventDetails
  reply?: LiveChatReply
  /** The author's first message in the channel (Twitch intro, or unseen in earlier sessions). */
  firstMessage?: boolean
}

/** Authoritative live-chat snapshot: provider rows + persisted/buffered messages + unread count. */
export interface LiveChatSnapshot {
  /** Renderer/broker delivery evidence; absent on backend/history hydration. */
  delivery?: ChatDelivery
  sessionId?: string
  providers: LiveChatProviderState[]
  messages: LiveChatMessage[]
  unreadCount: number
  updatedAt: string
}

/** Incremental main-renderer -> Comments-window transport after the initial snapshot seed. */
export type CommentsSnapshotDelta =
  | { kind: 'adopt'; deliveryBoundary: ChatDeliveryBoundary; sessionId?: string; updatedAt: string }
  | { kind: 'message'; message: LiveChatMessage; sessionId?: string }
  | { kind: 'provider'; provider: LiveChatProviderState; sessionId?: string; updatedAt: string }
  | {
      kind: 'clear'
      sessionId?: string
      updatedAt: string
      deliveryBoundary?: ChatDeliveryBoundary
    }

/** An empty snapshot for the renderer store before any chat session starts. */
export function createEmptyLiveChatSnapshot(updatedAt: string): LiveChatSnapshot {
  return {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt
  }
}

/** `liveChat.send` params (wire mirror of live_chat.rs `CommentsSendParams`). */
export interface CommentsSendParams {
  operationId: string
  sessionId: string
  text: string
  /** Co-host reply: on a terminal `sent`/`partial` phase the engine marks this question answered. */
  inReplyToQuestionId?: string
  /** Only these providers; absent sends to every provider. */
  destinationIds?: string[]
}

// --- Live Chat Co-host (Premium cloud AI) ---
// Wire mirror of crates/videorc-backend/src/cohost.rs. Plan:
// "2026-08-22 - Videorc Live Chat Co-host Plan". The backend owns the tick
// scheduler, the open-question set, flags, mood, and readiness; the renderer
// only renders `cohost.state` and calls `cohost.*` RPCs. Reply sends reuse
// `liveChat.send` with `inReplyToQuestionId`.

export type CohostTone = 'friendly' | 'short' | 'professional'
export type CohostStatus = 'off' | 'listening' | 'paused' | 'error'
export type CohostReason =
  | 'premium-required'
  | 'consent-required'
  | 'session-expired'
  | 'signed-out'
  | 'quota-exhausted'
  | 'server-unconfigured'
  | 'network'
  | 'gateway-error'
export type CohostPriority = 'high' | 'normal' | 'low'
export type CohostMood = 'hype' | 'calm' | 'tense' | 'mixed'
/**
 * Tick wire v2 vocabulary. It WILL grow: a kind this build does not know
 * arrives as `unknown` (the backend's serde catch-all) and renders generically.
 */
export type CohostFlagKind =
  | 'toxicity'
  | 'spam'
  | 'self-promo'
  | 'personal-info'
  | 'hate'
  | 'harassment'
  | 'threat'
  | 'sexual'
  | 'scam'
  | 'self-harm'
  | 'spoiler'
  | 'impersonation'
  | 'rule'
  | 'unknown'
export type CohostFlagSeverity = 'high' | 'medium' | 'low'
export type CohostFlagTarget = 'streamer' | 'viewer' | 'group'
/** A SUGGESTED moderation action. The desktop only labels it. */
export type CohostFlagAction = 'hide' | 'timeout' | 'ban'
export type CohostHighlightType = 'question' | 'joke' | 'praise' | 'insight' | 'milestone' | 'other'
export type CohostAlertKind = 'audio' | 'video' | 'stream-health' | 'game' | 'other'

/** Persisted per-profile co-host settings (`cohost.settings.get/set`). */
export interface CohostSettings {
  enabled: boolean
  tone: CohostTone
  /** Streamer notes the model answers from; at most 4000 characters. */
  notes: string
  /**
   * Golem's picks go on stream by themselves: the server's suggested
   * comments and high-priority questions, under the engine's cadence rules
   * (default off).
   */
  autoHighlight: boolean
  /**
   * The comment the streamer is talking about goes on stream by itself
   * (default off; needs `listen` or live captions, wired in plan 060 S3).
   */
  voiceHighlight: boolean
  /** Plain-language chat rules the co-host flags against; ≤ 10 × 120 chars. */
  rules: string[]
  /**
   * Golem hears the microphone for the whole live stream, as text, even with
   * live captions off (plan 068; default off).
   */
  listen: boolean
  /**
   * Plan 140: "Commands need 'Golem' first". On, the structured phrases
   * ("remove it from our chat") stop working without the wake word
   * (default off).
   */
  wakeWordRequired: boolean
  /**
   * Plan 140: how a voice removal is confirmed. `confirm` (the default) waits
   * for a yes; `countdown` runs after 5 s unless cancelled, except on YouTube,
   * which always waits for a yes.
   */
  removeConfirm: RemoveConfirmMode
  /** The user's creature (plan 164 S-A2). The backend always sends it. */
  persona: CohostPersona
  /** Automatic chat (plan 164 S-A2). Everything off by default. */
  autoChat: CohostAutoChat
}

/** The avatar's state images (plan 164 D16). `idle` is required on stream;
 * the others fall back to it. */
export type CohostAvatarState = 'idle' | 'talk' | 'laugh' | 'think'
export const COHOST_AVATAR_STATES: readonly CohostAvatarState[] = ['idle', 'talk', 'laugh', 'think']
/** How the comic bubble is drawn (plan 164 D17). */
export type CohostBubbleStyle = 'speech' | 'thought' | 'shout'
/** Where the persona's images came from; `default` is the bundled pack. */
export type CohostPersonaSource = 'default' | 'uploaded' | 'generated'

/**
 * The user's creature (plan 164): name, personality and looks. `images` are
 * relative paths under the managed golem-assets root (`<personaId>/<state>.<ext>`),
 * absent (never null) for a state with no image.
 */
export interface CohostPersona {
  /** Names the asset folder; regenerated by "Start over". `default` on a fresh install. */
  id: string
  /** 1 to 24 characters. */
  name: string
  /** At most 1200 characters. */
  personality: string
  bubbleStyle: CohostBubbleStyle
  images: Partial<Record<CohostAvatarState, string>>
  source: CohostPersonaSource
}

/** The chat posting mode (plan 164 D4). */
export type CohostAutoChatMode = 'off' | 'suggest' | 'auto'
/** The activity kinds a greeting template answers (plan 164). */
export type CohostActivityTemplateKind =
  | 'follow'
  | 'sub'
  | 'resub'
  | 'sub-gift'
  | 'community-sub-gift'
  | 'membership'
  | 'cheer'
  | 'kicks'
  | 'super-chat'
  | 'super-sticker'
  | 'raid'
  | 'watch-streak'
  | 'power-up'
  | 'redemption'
export const COHOST_ACTIVITY_TEMPLATE_KINDS: readonly CohostActivityTemplateKind[] = [
  'follow',
  'sub',
  'resub',
  'sub-gift',
  'community-sub-gift',
  'membership',
  'cheer',
  'kicks',
  'super-chat',
  'super-sticker',
  'raid',
  'watch-streak',
  'power-up',
  'redemption'
]
export type CohostGreetingPlatform = 'twitch' | 'youtube' | 'kick' | 'x'
/** The avatar state an utterance shows (plan 164 D18); never `idle`. */
export type CohostUtteranceState = 'talk' | 'laugh' | 'think'

export interface CohostGreetingTemplate {
  id: string
  kind: CohostActivityTemplateKind
  /** Omitted means any platform. */
  platform?: CohostGreetingPlatform
  /** 1 to 200 characters, fields in braces (`{name}`). */
  text: string
  state: CohostUtteranceState
  enabled: boolean
}

export interface CohostCooldownBehaviour {
  enabled: boolean
  /** 1 to 3600. */
  cooldownSeconds: number
}

/** Automatic chat (plan 164 D5): one mode, three behaviours. */
export interface CohostAutoChat {
  mode: CohostAutoChatMode
  greetings: { enabled: boolean; templates: CohostGreetingTemplate[] }
  /** Default cooldown 20 s. */
  answers: CohostCooldownBehaviour
  /** Default cooldown 240 s. */
  banter: CohostCooldownBehaviour
}

/** The generation style presets the web route takes (plan 164 S-A4). */
export type CohostAvatarStyle = 'cartoon' | 'pixel' | 'painted' | 'sticker'

/** `cohost.avatar.generate` (plan 164 S-A6): accepted at once; the outcome
 * is the `cohost.avatar.generated` event. */
export interface CohostAvatarGenerateParams {
  state: CohostAvatarState
  /** 1 to 600 characters. */
  prompt: string
  style: CohostAvatarStyle
}

export interface CohostAvatarGenerateAccepted {
  requestId: string
  state: CohostAvatarState
}

/** `cohost.avatar.generated`: `path` (the relative asset path the persona
 * stores) on success, `error` (the web's code and the tile's line) otherwise.
 * Each is absent, never null. */
export interface CohostAvatarGeneratedEvent {
  requestId: string
  state: CohostAvatarState
  path?: string
  /** The model returned no alpha; the tile says so. */
  opaque: boolean
  error?: { code: string; message: string }
}

/** `cohost.settings.set`: absent fields are unchanged. */
export interface CohostSettingsPatch {
  enabled?: boolean
  tone?: CohostTone
  notes?: string
  autoHighlight?: boolean
  voiceHighlight?: boolean
  /** Replaces the whole list; the backend trims, drops empties and caps it. */
  rules?: string[]
  listen?: boolean
  wakeWordRequired?: boolean
  removeConfirm?: RemoveConfirmMode
  /** Replaces the whole persona; the backend validates and trims it. */
  persona?: CohostPersona
  /** Replaces the whole block; the backend validates it. */
  autoChat?: CohostAutoChat
}

// --- Overlay layout (plan 164) ---------------------------------------------
// Where the highlight card, the caption bar and the Golem sit on each output
// orientation and which outputs carry them. Backend-owned (`app_settings`
// key `overlayLayout`), served by `overlays.layout.get/set`. Placement lives
// on the Live Scene canvas and nowhere else; the Stream Manager corner menu
// is a snap that writes the same rect.

/** A normalized rect in canvas units: x/w over the width, y/h over the height. */
export interface OverlayRect {
  x: number
  y: number
  w: number
  h: number
}

export interface OverlayItemLayout {
  horizontal: OverlayRect
  vertical: OverlayRect
  showOnStream: boolean
  showInRecording: boolean
}

export const OVERLAY_ITEMS = ['highlight', 'captions', 'golem'] as const
export type OverlayItem = (typeof OVERLAY_ITEMS)[number]

export type OverlayLayout = Record<OverlayItem, OverlayItemLayout>

export type OverlayOrientation = 'horizontal' | 'vertical'

/** Snap presets: the four corners plus the centred bottom bar captions use. */
export type OverlaySnap =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'bottom-center'

/** Smallest side a placed rect may have (canvas units); mirrors Rust. */
export const OVERLAY_RECT_MIN_SIZE = 0.02

export interface MigrateHighlightAnchorParams {
  anchor: CommentHighlightAnchor
}
// --- end overlay layout (plan 164) ------------------------------------------

// --- Golem overlay (plan 164) ---------------------------------------------
// The Golem on stream (Phase C): the backend owns which avatar state shows
// and the bubble that is up; the renderer rasterizes the avatar per output
// canvas and pushes the PNG through `golem.overlay.set`.

/** One output canvas of the session: the recording (or the only stream) and
 * the split / vertical stream leg. */
export type OverlayTarget = 'primary' | 'auxiliary'

/** The bubble that is up: its text and when it ends (RFC 3339). */
export interface GolemBubble {
  text: string
  until: string
}

/** `cohost.golem.state` (event) and `cohost.golem.status` (RPC): which
 * persona's images to draw, the state to draw and the bubble, or null. */
export interface GolemOverlaySnapshot {
  personaId: string
  state: CohostAvatarState
  bubble: GolemBubble | null
}

/** `cohost.golem.say`: a manual utterance from the Stream Manager's Say box
 * (D7). The backend trims the text and clips it to 200 characters. */
export interface CohostGolemSayParams {
  text: string
  state: CohostUtteranceState
}

/** `golem.overlay.set`: the renderer's raster of the avatar (and bubble) for
 * one output canvas, blitted inside `rect` (the Golem's placed rect for that
 * canvas orientation). Mirrors `captions.overlay.set`. */
export interface SetGolemOverlayParams {
  target: OverlayTarget
  pngBase64: string
  rect: OverlayRect
}

export interface OverlayTargetInfo {
  active: boolean
  width: number
  height: number
  revision: number
  styleRevision: number
}

/** What a per-target overlay slot holds after a set. */
export interface OverlayTargetsInfo {
  active: boolean
  primary: OverlayTargetInfo
  auxiliary: OverlayTargetInfo
}
// --- end Golem overlay (plan 164) -----------------------------------------

/** Whether Golem hears the streamer right now (plan 068). */
export type CohostListeningState = 'off' | 'starting' | 'on' | 'blocked'

export interface CohostListening {
  state: CohostListeningState
  /** Present while `blocked`: `no-microphone`, `no-capture`, `signed-out`, `consent-required`, `listen-monthly-quota-exhausted`, `listen-disabled`, … */
  reasonCode?: string
  message?: string
  /** Listen allowance left this month, when the server reported it. */
  remainingSeconds?: number
}

/** One open viewer question grouped across platforms and askers. */
export interface CohostQuestion {
  id: string
  text: string
  messageIds: string[]
  askers: string[]
  platforms: StreamPlatform[]
  priority: CohostPriority
  /** Draft reply (≤ 200 chars); editable before send. The server pins it to
   * English until a language setting exists — never to locale or geography. */
  suggestedReply: string
  fromNotes: boolean
  firstSeenAt: string
  updatedAt: string
  /** Tick v3 (plan 068): about what the streamer is talking about right now.
   * Omitted by the backend while false. */
  onTopic?: boolean
}

export type CohostPromiseTriggerKind = 'none' | 'viewers' | 'minutes'

/** When a promise reminder fires: at `value` viewers, after `value` minutes,
 * or (`none`) 20 minutes after Golem first heard it. */
export interface CohostPromiseTrigger {
  kind: CohostPromiseTriggerKind | (string & Record<never, never>)
  value?: number
}

/** A promise the streamer made out loud (plan 068 D8); private until they act. */
export interface CohostPromise {
  id: string
  text: string
  trigger: CohostPromiseTrigger
  firstSeenAt: string
}

/** The engine's latest met trigger, keyed on the promise: toast once per id. */
export interface CohostPromiseReminder {
  promiseId: string
  text: string
  at: string
}

/** A recap for viewers who asked what they missed, or one the streamer
 * drafted; never posted by Golem. Gone after `expiresAt`. */
export interface CohostRecap {
  text: string
  at: string
  expiresAt: string
}

/** A first-time chatter nobody greeted yet (plan 068 D9). */
export interface CohostSayHi {
  /** The engine's author key; `cohost.author.greeted` takes it back. */
  authorKey: string
  name: string
  platform: StreamPlatform
  firstSeenAt: string
}

/** A private dead-air suggestion (plan 068 D9): toast each `key` once. */
export interface CohostDeadAirNudge {
  key: string
  text: string
  at: string
}

export interface CohostFlag {
  messageId: string
  kind: CohostFlagKind
  severity: CohostFlagSeverity
  reason: string
  at: string
  /** Wire v2 extras: absent keys when the server did not send them, never null. */
  /** 0..1; the Sensitivity control filters on it. Absent = always shown. */
  confidence?: number
  /** Who the message is aimed at; absent = nobody in particular. */
  target?: CohostFlagTarget
  action?: CohostFlagAction
  alsoKinds?: CohostFlagKind[]
  /** For `rule` flags: the text of the streamer rule the message broke. */
  rule?: string
}

/** A comment the co-host suggests showing on stream. Never shown by itself. */
export interface CohostHighlight {
  messageId: string
  score: number
  type: CohostHighlightType
}

/** Viewers saying something is broken, aggregated per kind by the backend. */
export interface CohostAlert {
  kind: CohostAlertKind
  /** Distinct authors who reported it in the last two minutes. */
  viewers: number
  lastSeenAt: string
  /** At least two distinct authors reported it within 60 s of each other. */
  active: boolean
}

export interface CohostMoodScores {
  hype: number
  tension: number
  confusion: number
}

/**
 * Known sources of an automatic card; the wire may carry a newer one.
 * `command`: the streamer asked by voice (plan 140).
 */
export type CohostAutoHighlightSource = 'pick' | 'question' | 'voice' | 'command'

/**
 * The engine's automatic "put this on stream" command (plan 060 S1). The
 * BACKEND decides (cadence, roles, safety); the renderer acts on a new
 * `generation` exactly once, renders the card and sets it with always-set
 * semantics. It keeps no history.
 */
export interface CohostAutoHighlight {
  generation: number
  messageId: string
  /** Tolerant on the wire: an unknown source is still executed. */
  source: CohostAutoHighlightSource | (string & Record<never, never>)
  /** The same message is re-set while still live (voice only, once). */
  refresh: boolean
}

/**
 * The comment the streamer is talking about right now (plan 060 S3): the
 * engine's best spotlight match, refreshed while it persists, gone after 15 s.
 * Surfaces pin and mark it (pull-up) with no setting; with `voiceHighlight`
 * the engine also puts it on stream through `autoHighlight` (source `voice`).
 */
export interface CohostSpotlight {
  messageId: string
  /** The open question this message asked, when it is one. */
  questionId?: string
  /** The server's `about` probability, 0..1. */
  score: number
  /** ISO-8601: when this message became the spotlight. */
  at: string
  expiresAt: string
}

/** Why the engine resolved a question by itself; the wire may carry a newer one. */
export type CohostResolveReason = 'voice'

/**
 * A question the engine resolved on its own, kept for a minute so the streamer
 * can put it back with `cohost.question.restore` ("Answered on air").
 */
export interface CohostRecentlyResolved {
  question: CohostQuestion
  reason: CohostResolveReason | (string & Record<never, never>)
  resolvedAt: string
}

/**
 * What the last failed tick actually said. `code` is the server's error
 * envelope code verbatim (`ai-gateway-error`, `quota-exhausted`, ...) or a
 * desktop-assigned `network` / `timeout` / `malformed-response`; `status` is
 * the HTTP status when a response arrived. Cleared as soon as the engine is
 * listening again.
 */
export interface CohostErrorDetail {
  code: string
  message: string
  status: number | null
}

// --- Golem voice commands (plan 140 S3; contract part B) ---

/**
 * What a voice command asked for. `confirm` and `cancel` answer the open card,
 * so they update that command instead of standing on their own.
 */
export type CohostCommandKind = 'highlight' | 'clear' | 'remove' | 'confirm' | 'cancel' | 'unknown'

/**
 * Where the latest voice command stands:
 * - `done`: highlighted, cleared, removed or hidden;
 * - `not-found`: no comment matched, or (kind `unknown`) Golem didn't catch it;
 * - `ambiguous`: a chooser is open, `candidates` lists the comments;
 * - `confirm`: a card waits for a yes: a voice removal (`operationId`) or a
 *   highlight of a comment Golem flagged. A removal card without `operationId`
 *   is still opening; one without `expiresAt` was confirmed and is running;
 * - `refused`: chat moderation refused, or the removal failed;
 * - `unavailable`: paused by Videorc, or Premium is required;
 * - `cancelled`, `expired`: nothing happened.
 */
export type CohostCommandStatus =
  | 'done'
  | 'not-found'
  | 'ambiguous'
  | 'confirm'
  | 'refused'
  | 'unavailable'
  | 'cancelled'
  | 'expired'

/** The comment a command points at, as its card shows it. */
export interface CohostCommandTarget {
  messageId: string
  authorName: string
  platform: StreamPlatform
  /** At most 140 characters of the message. */
  excerpt: string
}

/**
 * The latest voice command and what became of it. The command strip, the
 * removal card and the chooser render from it; answers go back through
 * `cohost.command.choose|confirm|cancel` with its `id`.
 */
export interface CohostCommand {
  /** `cmd-<uuid>`. */
  id: string
  /** The words that made the command, as Golem heard them. */
  heard: string
  kind: CohostCommandKind
  status: CohostCommandStatus
  /** One plain sentence for the strip and the card. */
  message: string
  target?: CohostCommandTarget
  /** The chooser's comments, at most three; absent while empty. */
  candidates?: CohostCommandTarget[]
  /** The chat moderation operation behind a removal (`liveChat.moderationOperation`). */
  operationId?: string
  /** The audit reason heard with a removal ("toxic", "spam"). */
  reason?: string
  /** When the command reached its current status (RFC 3339). */
  at: string
  /** When the open card or chooser expires; absent when nothing waits. */
  expiresAt?: string
}

export type CohostSwitchState = 'on' | 'paused'

/**
 * The remote kill switches (contract part D): "Voice commands are paused by
 * Videorc." and "Removing messages is paused by Videorc." Absent while both
 * are on.
 */
export interface CohostCommandAvailability {
  voiceCommands: CohostSwitchState
  remove: CohostSwitchState
}

/** `cohost.command.choose` (plan 140 S3): pick from the chooser, `index` 0 to 2. */
export interface CohostCommandChooseParams {
  commandId: string
  index: number
}

/** `cohost.command.confirm` / `cohost.command.cancel` (plan 140 S3). */
export interface CohostCommandParams {
  commandId: string
}

/** The `cohost.state` event payload and every `cohost.*` RPC result. */
export interface CohostState {
  sessionId: string | null
  status: CohostStatus
  reason: CohostReason | null
  /**
   * Present only while `reason` describes a failed tick. Optional on the wire
   * so a backend from before the field still validates; absent means null.
   */
  detail?: CohostErrorDetail | null
  questions: CohostQuestion[]
  flags: CohostFlag[]
  mood: CohostMood | null
  lastTickAt: string | null
  tickSeq: number
  /** True when the last tick dropped messages under the 60-message delta cap. */
  partial: boolean
  /**
   * Presence fields (co-host presence W1). All optional on the wire so a
   * backend from before them still validates; absent means the default
   * (false / 0 / null).
   */
  /** A tick HTTP request is outstanding right now ("thinking"). */
  tickInFlight?: boolean
  /** Delta messages collected but not yet sent in a tick ("reading N new"). */
  pendingMessages?: number
  /**
   * ISO-8601 instant of the scheduler's earliest next pass; present only while
   * `pendingMessages > 0` (burst rule bounded by the 8 s min gap, trickle rule
   * at anchor + 20 s, pushed back by a backoff/quota window).
   */
  nextTickAt?: string | null
  /** Session total of chat messages the engine noted for ticks. */
  messagesSeen?: number
  /** Distinct question ids surfaced this session — lifetime, not open count. */
  questionsTotal?: number
  /**
   * Tick wire v2. Omitted by the backend while empty (never null); absent
   * means none.
   */
  /** Latest tick's suggested comments, best first, at most 5. */
  highlights?: CohostHighlight[]
  alerts?: CohostAlert[]
  moodScores?: CohostMoodScores
  /**
   * The engine's latest automatic on-stream command; absent until it made one
   * this session (never null).
   */
  autoHighlight?: CohostAutoHighlight
  /**
   * The comment the streamer is talking about (plan 060 S3); absent while
   * there is none or once it expired (never null).
   */
  spotlight?: CohostSpotlight
  /**
   * Questions the engine resolved by itself in the last minute, oldest first,
   * at most three; absent while empty (never null).
   */
  recentlyResolved?: CohostRecentlyResolved[]
  /**
   * Whether Golem hears the streamer (plan 068); absent without a session or
   * from a backend before the field (never null).
   */
  listening?: CohostListening
  /**
   * Tick v3 (plan 068 D7/D8). All absent (never null) until the engine has
   * them: what the streamer is talking about, the open promises (oldest
   * first, at most 20), the latest met promise trigger, and the recap.
   */
  topic?: string
  promises?: CohostPromise[]
  promiseReminder?: CohostPromiseReminder
  recap?: CohostRecap
  /**
   * Plan 068 D9, both absent (never null) while empty: first-time chatters
   * not greeted yet (oldest first, at most five, gone after 15 minutes) and
   * the latest dead-air nudge while it is fresh.
   */
  sayHi?: CohostSayHi[]
  deadAirNudge?: CohostDeadAirNudge
  /** Plan 140 S3: the latest voice command; absent until one was heard this session. */
  command?: CohostCommand
  /** Plan 140 S3: the voice-command kill switches; absent while both are on. */
  commandAvailability?: CohostCommandAvailability
}

/**
 * Plan 119 S1: what became of a question Golem caught. The latest outcome
 * wins; a restore puts it back to `open`; `shown` means still open, but its
 * comment was on stream.
 */
export type CohostReportQuestionOutcome =
  | 'open'
  | 'answered-on-air'
  | 'replied'
  | 'marked-answered'
  | 'dismissed'
  | 'shown'

/** One question in the report's log. Optional lists are omitted while empty, never null. */
export interface CohostReportQuestion {
  id: string
  text: string
  /** At most five names. */
  askers?: string[]
  platforms?: StreamPlatform[]
  priority: CohostPriority
  firstSeenAt: string
  outcome: CohostReportQuestionOutcome
}

export interface CohostReportQuestions {
  /** Distinct question ids Golem surfaced. */
  total: number
  markedAnswered: number
  dismissed: number
  replied: number
  answeredOnAir: number
  restored: number
  shownOnStream: number
  /** First seen first, at most 200. Omitted while empty. */
  items?: CohostReportQuestion[]
}

export interface CohostReportFlagKindCount {
  kind: CohostFlagKind
  count: number
}

export interface CohostReportFlagSeverityCount {
  severity: CohostFlagSeverity
  count: number
}

export interface CohostReportFlags {
  /** Each flagged message counted once. */
  raised: number
  dismissed: number
  byKind?: CohostReportFlagKindCount[]
  bySeverity?: CohostReportFlagSeverityCount[]
}

export interface CohostReportOpenPromise {
  text: string
  firstSeenAt: string
}

export interface CohostReportPromises {
  /** New promises heard this session. */
  heard: number
  /** Marked done, or the transcript showed they were kept. */
  kept: number
  dismissed: number
  reminded: number
  /** Still open at the end, oldest first, at most 20. Omitted while empty. */
  open?: CohostReportOpenPromise[]
}

/** Greeting totals over every chatter of the session. */
export interface CohostReportGreetings {
  /** Viewers whose first message in the channel landed this session. */
  firstTimers: number
  firstTimersGreeted: number
  byVoice: number
  byChat: number
  /** Their comment went on stream. */
  onStream: number
  /** The streamer pressed Greeted. */
  manual: number
}

/** One alert kind viewers raised: the most distinct viewers who said it at
 * once, and whether two of them ever agreed within 60 s. */
export interface CohostReportAlert {
  kind: CohostAlertKind
  peakViewers: number
  active: boolean
  firstSeenAt: string
}

/** Recaps are never posted by Golem, so posting leaves no count. */
export interface CohostReportRecap {
  offered: number
  drafted: number
  dismissed: number
}

/**
 * Plan 140 S3: what the streamer's voice commands did, counts only. A removal
 * counts once, by its outcome; a card a newer command replaced is not counted
 * as cancelled.
 */
export interface CohostReportCommands {
  highlighted: number
  /** Cards taken down by voice. */
  cleared: number
  /** The platform removed the message. */
  removed: number
  /** The platform could not; Videorc hid it locally. */
  hiddenLocally: number
  cancelled: number
  /** Nobody answered the card in time. */
  expired: number
  /** A removal that failed or ended unknown, or a refused request. */
  failed: number
  /** No comment matched, or Golem didn't catch what was said. */
  notFound: number
}

/**
 * What Golem caught in one stream (plan 119 decision 6): counts by outcome,
 * the questions and what became of them, the promises still open. Saved on
 * this computer when the session ends and deleted with the recording.
 * `cohost.report.get` returns it; `cohost.report.saved` announces it. Every
 * optional field is omitted while empty, never null.
 */
export interface CohostSessionReport {
  version: 1
  sessionId: string
  startedAt: string
  endedAt: string
  /** Golem sessions folded into this report: off and on mid-stream adds one. */
  segments: number
  streamTitle?: string
  messagesSeen: number
  /** Distinct comments that went on stream, automatically or by hand. */
  shownOnStream: number
  questions: CohostReportQuestions
  flags: CohostReportFlags
  promises: CohostReportPromises
  greetings: CohostReportGreetings
  alerts?: CohostReportAlert[]
  recap: CohostReportRecap
  /** Plan 140 S3: voice commands; absent when none was counted (and in older reports). */
  commands?: CohostReportCommands
}

export interface CohostReportChatPlatformCount {
  platform: StreamPlatform
  messages: number
}

/** Every chat row the session kept, by platform (busiest first). */
export interface CohostReportChat {
  messages: number
  byPlatform: CohostReportChatPlatformCount[]
}

/**
 * `cohost.report.get` / `cohost.report.latest`: the saved report (null when
 * Golem left none), the session's moments (clip marks and chat peaks, computed
 * on read and never stored) and its chat totals.
 */
export interface CohostReportPayload {
  sessionId: string
  report: CohostSessionReport | null
  moments: ClipMoment[]
  chat: CohostReportChat
}

/** `cohost.report.get`. */
export interface CohostReportGetParams {
  sessionId: string
}

/** `cohost.report.saved`: a report for this session was written. */
export interface CohostReportSavedEvent {
  sessionId: string
}

/**
 * Off-shaped `cohost.state`: what the backend reports when no engine session
 * exists. Presence is unconditional — surfaces render this instead of hiding
 * (null never reaches the Comments window relay any more).
 */
export function offCohostState(): CohostState {
  return {
    sessionId: null,
    status: 'off',
    reason: null,
    detail: null,
    questions: [],
    flags: [],
    mood: null,
    lastTickAt: null,
    tickSeq: 0,
    partial: false,
    tickInFlight: false,
    pendingMessages: 0,
    nextTickAt: null,
    messagesSeen: 0,
    questionsTotal: 0
  }
}

/**
 * `cohost.start`. Cloud-AI consent is renderer-owned, so the renderer passes
 * it on every start; without it the engine pauses with `consent-required` and
 * never sends chat to the server.
 */
export interface CohostStartParams {
  sessionId: string
  consentToProcessChat?: boolean
  streamTitle?: string | null
}

/** `cohost.question.answered` / `cohost.question.dismiss` / `cohost.question.restore`. */
export interface CohostQuestionParams {
  sessionId: string
  questionId: string
}

/** `cohost.flag.dismiss`. */
export interface CohostFlagParams {
  sessionId: string
  messageId: string
}

/** `cohost.promise.done` / `cohost.promise.dismiss` (plan 068 D8). */
export interface CohostPromiseParams {
  sessionId: string
  promiseId: string
}

/** `cohost.recap.dismiss` / `cohost.recap.draft` (plan 068 D8). */
export interface CohostRecapParams {
  sessionId: string
}

/** `cohost.author.greeted` (plan 068 D9). */
export interface CohostAuthorParams {
  sessionId: string
  authorKey: string
}

/**
 * What the detached Comments window needs to render the Co-host segment. The
 * MAIN renderer owns the backend socket, the entitlement snapshot and the
 * renderer-local cloud-AI consent, so it resolves all three and relays one
 * value; the window never re-derives gating.
 */
export interface CohostWindowState {
  /** Always concrete: `offCohostState()` until the engine reports, never null. */
  state: CohostState
  /** Premium gate result. Fail-closed: false until the main renderer says otherwise. */
  entitled: boolean
  entitlementReason: string | null
  upgradeUrl: string | null
  /** Renderer-local cloud-AI consent (`videorc.aiConsent`). */
  consented: boolean
  /** Persisted `cohost.settings.enabled`. */
  enabled: boolean
  /**
   * Persisted `cohost.settings.listen` (plan 068). Absent from a relay seeded
   * without it (smokes); the window then never offers the listening card.
   */
  listen?: boolean
  /** The Golem on stream (plan 164 Phase C): what the pane's header shows
   * and operates. Absent from a relay seeded without it (older Studio,
   * smokes); the window then shows no header. */
  golem?: CohostWindowGolem
}

/** The Golem as the Stream Manager operates it (plan 164 S-C4). The window
 * resolves the state image itself (its own file or the bundled pack). */
export interface CohostWindowGolem {
  persona: Pick<CohostPersona, 'id' | 'name' | 'images' | 'bubbleStyle' | 'source'>
  state: CohostAvatarState
  /** The bubble's text while one is up. */
  bubble: string | null
  /** `overlayLayout.golem.showOnStream`. */
  showOnStream: boolean
}

/**
 * Fail-closed seed for the Comments window relay: co-host presence must be
 * knowable from the first frame, so the window mounts on this instead of null.
 */
export function offCohostWindowState(): CohostWindowState {
  return {
    state: offCohostState(),
    entitled: false,
    entitlementReason: null,
    upgradeUrl: null,
    consented: false,
    enabled: false,
    listen: false
  }
}

export type CohostActionKind =
  | 'answered'
  | 'dismiss-question'
  | 'dismiss-flag'
  | 'restore'
  | 'promise-done'
  | 'promise-dismiss'
  | 'recap-dismiss'
  | 'recap-draft'
  | 'author-greeted'

/** Every action kind the relay accepts; main validates against it. */
export const COHOST_ACTION_KINDS: readonly CohostActionKind[] = [
  'answered',
  'dismiss-question',
  'dismiss-flag',
  'restore',
  'promise-done',
  'promise-dismiss',
  'recap-dismiss',
  'recap-draft',
  'author-greeted'
]

/** The Golem's own actions from the Stream Manager (plan 164 S-C4): a manual
 * utterance for the bubble (D7) and the Show on stream switch. Not chat
 * commands, so they need no live session: the bubble goes to the overlay and
 * the switch to the overlay layout. Studio makes the matching call. */
export type CohostGolemActionCommand =
  | {
      requestId: string
      kind: 'golem-say'
      /** 1 to 200 characters. */
      text: string
      state: CohostUtteranceState
    }
  | { requestId: string; kind: 'golem-show-on-stream'; showOnStream: boolean }

export const COHOST_GOLEM_ACTION_KINDS = ['golem-say', 'golem-show-on-stream'] as const

/** Correlated co-host action from the Comments window, brokered through main
 * to the main renderer (which makes the actual `cohost.*` RPC). */
/**
 * Stream Manager → main → Studio (plan 140, S6 part B): an answer to Golem's
 * open voice command, by its id. `choose` picks from the chooser (0 to 2),
 * `confirm` and `cancel` answer the card. Studio makes the matching
 * `cohost.command.*` call; the reply is the state after the answer.
 */
export type CohostCommandRelayCommand =
  | {
      requestId: string
      sessionId: string
      action: 'choose'
      commandId: string
      index: number
    }
  | {
      requestId: string
      sessionId: string
      action: 'confirm' | 'cancel'
      commandId: string
    }

export interface CohostSessionActionCommand {
  requestId: string
  sessionId: string
  kind: CohostActionKind
  /** Question id for question actions; the flagged message id for flags; the
   * promise id for promise actions; the session id again for recap actions
   * (they have no target of their own); the author key for `author-greeted`. */
  targetId: string
}

export type CohostActionCommand = CohostSessionActionCommand | CohostGolemActionCommand

/**
 * Correlated "turn the co-host on/off" from the Comments window (presence W2).
 * Session-independent by design: the header popover is reachable while idle,
 * which is exactly when a streamer discovers the feature.
 */
export interface CohostEnableCommand {
  requestId: string
  enabled: boolean
  /** Grant renderer-local cloud-AI consent in the same click. */
  grantConsent?: boolean
  /** Also set `cohost.settings.listen` in the same save (plan 068 D3). */
  listen?: boolean
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
  captureProtectionMarkerInstalled?: boolean
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

/**
 * Live concurrent-viewer sample (viewer rider V1) — viewers, not subs. `total`
 * sums every platform with a fresh count across all samplers (plan 055, B1).
 */
export interface ViewerSample {
  sessionId: string
  platforms: ViewerPlatformCount[]
  total: number
  at: string
}

/** What a platform's audience number counts: YouTube has subscribers, not followers. */
export type AudienceMetric = 'followers' | 'subscribers'

/**
 * Whether a platform's audience can be shown (plan 055, S3): `pending` until
 * the first read, `hidden` when the channel hides it, `needs-reconnect` when
 * the platform refused the token, `unavailable` when this build or account
 * cannot read it (`message` says why).
 */
export type AudienceCapability =
  | 'pending'
  | 'available'
  | 'hidden'
  | 'needs-reconnect'
  | 'unavailable'
  /** No total exists; `delta` counts follow events this stream (Kick). */
  | 'delta-only'

export interface PlatformAudience {
  platform: StreamPlatform
  metric: AudienceMetric
  capability: AudienceCapability
  total?: number
  /** The session's first reading; `delta` is `total - baseline`. */
  baseline?: number
  delta?: number
  at?: string
  message?: string
  /** Twitch only, with the opt-in `channel:read:subscriptions` scope. */
  subscribers?: number
  subscriberPoints?: number
  /** Twitch only: false when follow alerts and the sub count need a reconnect. */
  audienceScopes?: boolean
  /** Twitch only: false when Power-ups and channel point redemptions need a
   * reconnect (plan 162). */
  bitsPointsScopes?: boolean
  /** Followers gained this stream, one per read that set a new high, oldest first. */
  followerGains?: FollowerGain[]
  /** Since when a follow event subscription names each new follower (plan
   * 071): gains read in [since, until) are already named rows. */
  namedFollowsSince?: string | null
  /** When that subscription stopped; gains read from then on are unnamed again. */
  namedFollowsUntil?: string | null
}

/** New followers seen by one audience read; the platform never said who. */
export interface FollowerGain {
  at: string
  count: number
}

/**
 * `youtube.quota` event (plan 094): the shared YouTube Data API quota breaker.
 * `pausedUntil` is present (RFC 3339) while every YouTube call is paused and
 * absent, never null, once they may resume. One state for the Livestream page,
 * the Stream Manager and the Comments destination status.
 */
export interface YouTubeQuotaStatus {
  pausedUntil?: string
  /** The per-install daily budget (plan 094, S6); always sent by current backends. */
  budget?: YouTubeQuotaBudget
}

/**
 * How much of this install's daily YouTube budget is spent, highest step last.
 * `shed-extras` (80%): no subscribers or thumbnails, viewers every 2 minutes;
 * `shed-viewers` (95%): no viewers; `essentials-only` (100%): Go Live, Stop
 * and chat read only. Never blocks a running stream.
 */
export type YouTubeQuotaBudgetStep = 'normal' | 'shed-extras' | 'shed-viewers' | 'essentials-only'

export interface YouTubeQuotaBudget {
  /** Estimated units spent this Pacific day. */
  units: number
  /** The budget in effect; 0 means the budget is off. */
  limit: number
  step: YouTubeQuotaBudgetStep
}

/** `stream.audience` event and `stream.audience.snapshot` result (wire mirror of audience.rs). */
export interface AudienceSnapshot {
  sessionId: string
  platforms: PlatformAudience[]
  updatedAt: string
}

/** `sessions.viewers.list` (plan 055, S1): a session's saved samples, oldest first. */
export interface SessionViewersListParams {
  sessionId: string
}

export interface SessionViewersPage {
  samples: ViewerSample[]
}

export interface ObsDiscovery {
  available: boolean
  collections: string[]
  profiles: string[]
  currentCollection?: string
  currentProfile?: string
}

export type ScheduledStreamProvider = 'youtube' | 'x'
export interface ScheduledEventMetadata {
  title: string
  description: string
  privacy: 'private' | 'unlisted' | 'public'
  madeForKids: boolean
  localStart: string
  timeZone: string
  offsetChoice: 'earlier' | 'later' | null
  thumbnailAssetId: string | null
  /** X only: planned end as a local wall time in `timeZone`. */
  plannedEndLocal?: string | null
  /** X only: keep the replay available after the broadcast ends. */
  availableForReplay?: boolean | null
}
export interface ScheduledStreamEvent {
  id: string
  schemaVersion: number
  revision: number
  provider: ScheduledStreamProvider
  accountId: string
  accountLabel: string
  requested: ScheduledEventMetadata
  startUtc: string
  providerEventId: string | null
  watchUrl: string | null
  lifecycle:
    | 'draft'
    | 'scheduled'
    | 'preparing'
    | 'live'
    | 'completed'
    | 'canceled'
    | 'missing'
    | 'unknown'
  operationState: 'idle' | 'pending' | 'needs-retry' | 'needs-reconciliation'
  thumbnailState: 'none' | 'pending' | 'uploaded' | 'error'
  error: { code: string; message: string } | null
  lastSyncedAt: string | null
  preparation: {
    attemptId: string
    targetId: string
    phase: string
    sessionId: string | null
  } | null
  createUncertain: boolean
}
export interface ScheduledStreamOperation {
  id: string
  eventId: string
  action: string
  state: 'pending' | 'complete' | 'needs-retry' | 'needs-reconciliation'
  stage: string
  error: { code: string; message: string } | null
  result: unknown
}
export interface ScheduledStreamProviderCapability {
  provider: ScheduledStreamProvider
  available: boolean
  reason: string | null
  accounts: PlatformAccount[]
  fields: string[]
  audienceEditable: false
}
export interface ScheduledStreamCapabilities {
  /** One entry per provider; `available`/`accounts` below mirror YouTube for older callers. */
  providers: ScheduledStreamProviderCapability[]
  available: boolean
  reason: string | null
  accounts: PlatformAccount[]
  audienceEditable: false
}
/** What `importGolemImage` hands back (plan 164 S-A3): the relative path the
 * persona stores and the managed URL the tile shows. */
export interface GolemImageImportResult {
  personaId: string
  state: CohostAvatarState
  /** `<personaId>/<state>.<ext>`, the value `persona.images[state]` stores. */
  path: string
  /** `videorc-asset://golem/<personaId>/<state>.<ext>`. */
  url: string
  width: number
  height: number
}

export interface ScheduledThumbnail {
  id: string
  previewUrl: string
  width: number
  height: number
}

export interface ScheduledStreamMutation {
  confirmationFingerprint?: string
  operationId: string
  eventId: string
  expectedRevision: number
  metadata?: ScheduledEventMetadata
  /** Provider of a brand-new draft; YouTube when absent. */
  provider?: ScheduledStreamProvider
  accountId?: string
  candidateId?: string
  candidateKind?: 'broadcast' | 'ingest'
  attemptId?: string
  targetId?: string
  video?: VideoSettings
  sessionId?: string
}

export interface ScheduledStreamCandidate {
  candidateKind: 'broadcast' | 'ingest'
  id: string
  snippet: { title: string; scheduledStartTime: string | null }
  profile: { resolution: string | null; frameRate: string | null }
}

/** Session selection revisions are independent of compositor scene revisions. */
export type SessionSourceKind = 'capture' | 'camera' | 'microphone'
export interface SourceSwitchParams {
  sessionId: string
  requestId: string
  expectedSourceRevision: number
  kind: SessionSourceKind
  deviceId: string | null
  protectedOverlayWindowIds?: number[]
}
export interface SourceSwitchOperation {
  requestId: string
  kind: SessionSourceKind
  deviceId: string | null
  stage: 'admitted' | 'preparing' | 'restoring' | 'committing' | 'applied' | 'failed' | 'cancelled'
  reason: string | null
  previousSource: 'preserved' | 'restored' | 'unavailable'
  outputObserved: boolean
  outputSuperseded?: boolean
}
export interface SessionSources {
  audio: {
    sampleCursor: number
    generation: number
    deviceId: string | null
    deviceName: string
    lastCommit: {
      sessionId: string
      requestId: string
      generation: number
      cutoverSample: number
      deviceId: string | null
      outputObserved: boolean
    } | null
    selectedInput: boolean
    counters: {
      capturedFrames: number
      generatedFrames: number
      discardedFrames: number
      droppedFrames: number
    }
  } | null
  sessionId: string
  sourceRevision: number
  outputProcessId: number | null
  confirmed: {
    screenId?: string | null
    windowId?: string | null
    cameraId?: string | null
    microphoneId?: string | null
    testPattern?: boolean
  }
  health: Array<{
    kind: SessionSourceKind
    deviceId: string | null
    health: 'none' | 'starting' | 'ready' | 'unavailable' | 'unknown'
  }>
  pending: SourceSwitchOperation | null
  lastOperation: SourceSwitchOperation | null
  capabilities: Array<{
    kind: SessionSourceKind
    supported: boolean
    allowsNone?: boolean
    reason: string | null
  }>
}
