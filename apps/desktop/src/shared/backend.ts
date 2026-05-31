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
  windowId?: string
  cameraId?: string
  microphoneId?: string
  testPattern?: boolean
}

export type CameraCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type CameraSize = 'small' | 'medium' | 'large'
export type CameraShape = 'rectangle' | 'circle'
export type CameraFit = 'fit' | 'fill'

export interface LayoutSettings {
  cameraCorner: CameraCorner
  cameraSize: CameraSize
  cameraShape: CameraShape
  cameraMargin: number
  cameraFit: CameraFit
  cameraMirror: boolean
  cameraZoom: number
  cameraOffsetX: number
  cameraOffsetY: number
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

export interface SceneSourceOrderParams {
  sourceIds: string[]
}

export interface SceneSourceNudgeParams {
  sourceId: string
  directionX: number
  directionY: number
  large?: boolean
}

export type RtmpPreset = 'youtube' | 'twitch' | 'x' | 'custom'
export type VideoPreset = 'tutorial-1080p30' | 'tutorial-1440p30' | 'stream-1080p60' | 'custom'

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
  output: OutputSettings
  audio?: AudioSettings
}

export interface AudioSettings {
  microphoneGainDb: number
  microphoneMuted: boolean
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

export interface PreviewLiveStatus {
  state: PreviewLiveState
  source: PreviewLiveSource
  url?: string
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

export type HealthLevel = 'info' | 'warn' | 'error'

export interface HealthEvent {
  id: string
  sessionId?: string
  level: HealthLevel
  code: string
  message: string
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
  aiArtifacts: AiArtifact[]
}

export type SystemPermissionPane = 'privacy' | 'screen-recording' | 'camera' | 'microphone'

export interface RuntimeInfo {
  isPackaged: boolean
  permissionTargetName: string
  permissionTargetPath: string
}

export interface VideorcApi {
  getBackendConnection: () => Promise<BackendConnection | null>
  getBackendLogs: () => Promise<BackendLogEvent[]>
  getRuntimeInfo: () => Promise<RuntimeInfo>
  openSystemPermissions: (pane?: SystemPermissionPane) => Promise<void>
  revealPermissionTarget: () => Promise<void>
  onBackendConnection: (callback: (connection: BackendConnection) => void) => () => void
  onBackendLog: (callback: (log: BackendLogEvent) => void) => () => void
}
