import type {
  AudioSettings,
  CameraTransform,
  CameraTransformMode,
  Device,
  LayoutPreset,
  LayoutSettings,
  RtmpPreset,
  SideBySideSplit,
  SourceSelection,
  StreamingSettings,
  StreamPlatform,
  StoreManualStreamKeyResult,
  StreamTargetSettings,
  VideoPreset,
  VideoSettings
} from '../../../shared/backend'

export type SettingsState = {
  outputDirectory: string
  ffmpegPath: string
}

export type CaptureConfig = {
  sources: SourceSelection
  layout: LayoutSettings
  audio: AudioSettings
  video: VideoSettings
  recordEnabled: boolean
  streamEnabled: boolean
  rtmpPreset: RtmpPreset
  rtmpServerUrl: string
  streamKey: string
  streaming: StreamingSettings
}

export type LegacyStreamKeyMigrationCandidate = {
  targetId: string
  streamKey: string
}

export type WsStatus = 'waiting' | 'connecting' | 'connected' | 'failed' | 'closed'
export type SetupTone = 'good' | 'warn' | 'neutral'
export type SetupStep = {
  label: string
  detail: string
  tone: SetupTone
}

export const STORAGE_KEYS = {
  settings: 'videorc.settings',
  captureConfig: 'videorc.captureConfig',
  onboarding: 'videorc.onboardingComplete',
  theme: 'videorc.theme'
} as const

export const ONBOARDING_VERSION = 'creator-ux-v1'
export const MICROPHONE_SYNC_OFFSET_MIN_MS = -1000
export const MICROPHONE_SYNC_OFFSET_MAX_MS = 1000

export const defaultSettings: SettingsState = {
  outputDirectory: '',
  ffmpegPath: ''
}

export const rtmpDefaults: Record<RtmpPreset, string> = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  twitch: 'rtmp://live.twitch.tv/app',
  x: '',
  custom: ''
}

// Fixed destination order for the Streaming tab (YouTube, Twitch, X, Custom).
export const STREAM_PLATFORM_ORDER: readonly StreamPlatform[] = ['youtube', 'twitch', 'x', 'custom']

const STREAM_PLATFORM_LABELS: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  x: 'X / Twitter',
  custom: 'Custom RTMP'
}

function isStreamPlatform(value: unknown): value is StreamPlatform {
  return typeof value === 'string' && (STREAM_PLATFORM_ORDER as readonly string[]).includes(value)
}

function makeStreamTarget(platform: StreamPlatform, now: string): StreamTargetSettings {
  return {
    // One built-in target per platform in v1, so the platform name is a stable id.
    id: platform,
    platform,
    label: STREAM_PLATFORM_LABELS[platform],
    enabled: false,
    serverUrl: rtmpDefaults[platform],
    urlMode: 'server-and-key',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'manual-rtmp',
    status: { state: 'not-configured' },
    createdAt: now,
    updatedAt: now
  }
}

function defaultStreamTargets(now: string = new Date().toISOString()): StreamTargetSettings[] {
  return STREAM_PLATFORM_ORDER.map((platform) => makeStreamTarget(platform, now))
}

export function defaultStreamingSettings(): StreamingSettings {
  return {
    enabled: false,
    mode: 'single',
    targets: defaultStreamTargets(),
    defaultOutputPreset: 'tutorial-1080p30',
    defaultBitrateKbps: 6000,
    enabledTargetIds: []
  }
}

export const videoPresets: Record<VideoPreset, VideoSettings> = {
  'tutorial-1080p30': {
    preset: 'tutorial-1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  },
  'tutorial-1440p30': {
    preset: 'tutorial-1440p30',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 8000
  },
  'record-4k30': {
    preset: 'record-4k30',
    width: 3840,
    height: 2160,
    fps: 30,
    bitrateKbps: 30000
  },
  'record-4k60-experimental': {
    preset: 'record-4k60-experimental',
    width: 3840,
    height: 2160,
    fps: 60,
    bitrateKbps: 50000
  },
  'stream-safe-1080p30': {
    preset: 'stream-safe-1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  },
  'stream-safe-1080p60': {
    preset: 'stream-safe-1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 6000
  },
  'stream-1080p60': {
    preset: 'stream-1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 9000
  },
  custom: {
    preset: 'custom',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  }
}

export interface VideoPresetOption {
  value: VideoPreset
  label: string
  tone?: 'default' | 'warning'
}

export const recordingVideoPresetOptions: VideoPresetOption[] = [
  { value: 'record-4k30', label: 'Record 4K30' },
  { value: 'record-4k60-experimental', label: 'Record 4K60 experimental', tone: 'warning' },
  { value: 'tutorial-1440p30', label: 'Tutorial 1440p30' },
  { value: 'tutorial-1080p30', label: 'Tutorial 1080p30' }
]

export const streamingVideoPresetOptions: VideoPresetOption[] = [
  { value: 'stream-safe-1080p30', label: 'Stream-safe 1080p30' },
  { value: 'stream-safe-1080p60', label: 'Stream-safe 1080p60' }
]

export const legacyVideoPresetOptions: VideoPresetOption[] = [
  { value: 'stream-1080p60', label: 'Legacy Stream 1080p60', tone: 'warning' }
]

export const customVideoPresetOption: VideoPresetOption = { value: 'custom', label: 'Custom' }

export interface VideoProfileCompatibility {
  blockingReason: string | null
  warning: string | null
}

export function videoProfileCompatibility(
  config: Pick<CaptureConfig, 'recordEnabled' | 'streamEnabled' | 'video'>
): VideoProfileCompatibility {
  const { recordEnabled, streamEnabled, video } = config

  if (streamEnabled && (video.width > 1920 || video.height > 1080)) {
    return {
      blockingReason:
        '4K livestreaming is not available in v1. Disable livestreaming for 4K local recording or choose a stream-safe 1080p profile.',
      warning: null
    }
  }

  if (streamEnabled && video.bitrateKbps > 6000) {
    return {
      blockingReason:
        'Livestream bitrate must be 6000 kbps or lower for the v1 platform-safe path.',
      warning: null
    }
  }

  if (is4kVideo(video) && !recordEnabled) {
    return {
      blockingReason: '4K profiles require local recording to be enabled.',
      warning: null
    }
  }

  if (is4kVideo(video) && video.fps > 30 && video.preset !== 'record-4k60-experimental') {
    return {
      blockingReason:
        '4K60 is experimental. Choose Record 4K60 experimental explicitly or use Record 4K30.',
      warning: null
    }
  }

  if (video.preset === 'record-4k60-experimental') {
    return {
      blockingReason: null,
      warning: '4K60 is experimental and is not part of v1 acceptance.'
    }
  }

  if (streamEnabled && !video.preset.startsWith('stream-safe-') && video.preset !== 'custom') {
    return {
      blockingReason: null,
      warning: 'Use a stream-safe 1080p profile for v1 livestream acceptance.'
    }
  }

  return { blockingReason: null, warning: null }
}

function is4kVideo(video: VideoSettings): boolean {
  return video.width >= 3840 || video.height >= 2160
}

export const defaultCaptureConfig: CaptureConfig = {
  sources: {},
  layout: {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  },
  audio: {
    microphoneGainDb: 0,
    microphoneMuted: false,
    // Pure manual trim: structural A/V alignment happens in the backend (the audio
    // writer trims to the encoder bridge's first-frame epoch), so the old calibrated
    // -750ms constant is gone — it could never fit every resolution at once.
    microphoneSyncOffsetMs: 0,
    microphoneSyncOffsetUserSet: false
  },
  video: videoPresets['tutorial-1440p30'],
  recordEnabled: true,
  streamEnabled: false,
  rtmpPreset: 'youtube',
  rtmpServerUrl: rtmpDefaults.youtube,
  streamKey: '',
  streaming: defaultStreamingSettings()
}

export function loadJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return fallback
  }

  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return fallback
  }
}

export function loadCaptureConfig(): CaptureConfig {
  const loaded = loadJson(
    STORAGE_KEYS.captureConfig,
    defaultCaptureConfig
  ) as Partial<CaptureConfig>

  return {
    ...defaultCaptureConfig,
    ...loaded,
    sources: { ...defaultCaptureConfig.sources, ...(loaded.sources ?? {}) },
    layout: normalizeLayoutSettings(loaded.layout),
    audio: normalizeAudioSettings(loaded.audio),
    video: normalizeVideoSettings(loaded.video),
    recordEnabled:
      typeof loaded.recordEnabled === 'boolean'
        ? loaded.recordEnabled
        : defaultCaptureConfig.recordEnabled,
    streamEnabled:
      typeof loaded.streamEnabled === 'boolean'
        ? loaded.streamEnabled
        : defaultCaptureConfig.streamEnabled,
    rtmpPreset: loaded.rtmpPreset ?? defaultCaptureConfig.rtmpPreset,
    rtmpServerUrl: loaded.rtmpServerUrl ?? defaultCaptureConfig.rtmpServerUrl,
    streamKey: loaded.streamKey ?? defaultCaptureConfig.streamKey,
    streaming: migrateStreamingSettings(loaded)
  }
}

export function smokePreviewCompositorCaptureConfig(
  config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'>
): Pick<CaptureConfig, 'sources' | 'layout' | 'video'> {
  return {
    ...config,
    sources: {
      microphoneId: config.sources.microphoneId,
      microphoneName: config.sources.microphoneName,
      testPattern: true
    }
  }
}

export function normalizeAudioSettings(audio: unknown): AudioSettings {
  const candidate = audio && typeof audio === 'object' ? (audio as Partial<AudioSettings>) : {}
  const offsetUserSet = candidate.microphoneSyncOffsetUserSet === true
  // Until the user explicitly sets a sync offset, follow the default (0: alignment is
  // structural in the backend; this control is a manual trim only).
  const microphoneSyncOffsetMs = offsetUserSet
    ? normalizeMicrophoneSyncOffsetMs(
        candidate.microphoneSyncOffsetMs,
        defaultCaptureConfig.audio.microphoneSyncOffsetMs
      )
    : defaultCaptureConfig.audio.microphoneSyncOffsetMs

  return {
    microphoneGainDb: clampNumber(
      candidate.microphoneGainDb,
      defaultCaptureConfig.audio.microphoneGainDb,
      -24,
      24
    ),
    microphoneMuted:
      typeof candidate.microphoneMuted === 'boolean'
        ? candidate.microphoneMuted
        : defaultCaptureConfig.audio.microphoneMuted,
    microphoneSyncOffsetMs,
    microphoneSyncOffsetUserSet: offsetUserSet
  }
}

export function normalizeMicrophoneSyncOffsetMs(value: unknown, fallback = 0): number {
  return clampNumber(value, fallback, MICROPHONE_SYNC_OFFSET_MIN_MS, MICROPHONE_SYNC_OFFSET_MAX_MS)
}

export function parseMicrophoneSyncOffsetInput(value: string, fallback: number): number | null {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === '+') {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return normalizeMicrophoneSyncOffsetMs(parsed, fallback)
}

const LAYOUT_PRESET_VALUES: readonly LayoutPreset[] = [
  'screen-camera',
  'screen-only',
  'camera-only',
  'side-by-side'
]

function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === 'string' && (LAYOUT_PRESET_VALUES as readonly string[]).includes(value)
}

const SIDE_BY_SIDE_SPLITS: readonly SideBySideSplit[] = ['50-50', '60-40', '70-30']

function isSideBySideSplit(value: unknown): value is SideBySideSplit {
  return typeof value === 'string' && (SIDE_BY_SIDE_SPLITS as readonly string[]).includes(value)
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function normalizeCameraTransform(value: unknown): CameraTransform | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<CameraTransform>
  const x = Number(candidate.x)
  const y = Number(candidate.y)
  const width = Number(candidate.width)
  const height = Number(candidate.height)
  if (
    ![x, y, width, height].every((entry) => Number.isFinite(entry)) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }

  return { x: clampUnit(x), y: clampUnit(y), width: clampUnit(width), height: clampUnit(height) }
}

export function normalizeLayoutSettings(layout: unknown): LayoutSettings {
  const candidate = layout && typeof layout === 'object' ? (layout as Partial<LayoutSettings>) : {}
  const cameraTransform = normalizeCameraTransform(candidate.cameraTransform)
  const cameraTransformMode: CameraTransformMode =
    candidate.cameraTransformMode === 'custom' && cameraTransform ? 'custom' : 'preset'

  return {
    ...defaultCaptureConfig.layout,
    ...candidate,
    layoutPreset: isLayoutPreset(candidate.layoutPreset)
      ? candidate.layoutPreset
      : defaultCaptureConfig.layout.layoutPreset,
    cameraTransformMode,
    cameraTransform: cameraTransformMode === 'custom' ? cameraTransform : null,
    cameraMargin: clampNumber(
      candidate.cameraMargin,
      defaultCaptureConfig.layout.cameraMargin,
      8,
      96
    ),
    cameraZoom: clampNumber(candidate.cameraZoom, defaultCaptureConfig.layout.cameraZoom, 100, 200),
    cameraOffsetX: clampNumber(
      candidate.cameraOffsetX,
      defaultCaptureConfig.layout.cameraOffsetX,
      -100,
      100
    ),
    cameraOffsetY: clampNumber(
      candidate.cameraOffsetY,
      defaultCaptureConfig.layout.cameraOffsetY,
      -100,
      100
    ),
    cameraMirror:
      typeof candidate.cameraMirror === 'boolean'
        ? candidate.cameraMirror
        : defaultCaptureConfig.layout.cameraMirror,
    cameraFit:
      candidate.cameraFit === 'fit' || candidate.cameraFit === 'fill'
        ? candidate.cameraFit
        : defaultCaptureConfig.layout.cameraFit,
    sideBySideSplit: isSideBySideSplit(candidate.sideBySideSplit)
      ? candidate.sideBySideSplit
      : defaultCaptureConfig.layout.sideBySideSplit,
    sideBySideCameraSide:
      candidate.sideBySideCameraSide === 'left' || candidate.sideBySideCameraSide === 'right'
        ? candidate.sideBySideCameraSide
        : defaultCaptureConfig.layout.sideBySideCameraSide
  }
}

export function normalizeVideoSettings(video: unknown): VideoSettings {
  const candidate = video && typeof video === 'object' ? (video as Partial<VideoSettings>) : {}
  const preset =
    typeof candidate.preset === 'string' && candidate.preset in videoPresets
      ? (candidate.preset as VideoPreset)
      : defaultCaptureConfig.video.preset
  const fallback = videoPresets[preset]

  return {
    preset,
    width: clampNumber(candidate.width, fallback.width, 640, 3840),
    height: clampNumber(candidate.height, fallback.height, 360, 2160),
    fps: clampNumber(candidate.fps, fallback.fps, 24, 60),
    bitrateKbps: clampNumber(candidate.bitrateKbps, fallback.bitrateKbps, 1000, 50000)
  }
}

function normalizeStreamTarget(
  base: StreamTargetSettings,
  saved: Partial<StreamTargetSettings>
): StreamTargetSettings {
  const streamKey = typeof saved.streamKey === 'string' ? saved.streamKey : ''
  const streamKeySecretRef =
    typeof saved.streamKeySecretRef === 'string' ? saved.streamKeySecretRef : undefined
  const serverUrl =
    typeof saved.serverUrl === 'string' && saved.serverUrl.trim() ? saved.serverUrl : base.serverUrl
  return {
    // id, platform, status keep the built-in identity from base.
    ...base,
    label: typeof saved.label === 'string' && saved.label ? saved.label : base.label,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : false,
    serverUrl,
    urlMode: saved.urlMode === 'full-url' ? 'full-url' : 'server-and-key',
    streamKey,
    streamKeySecretRef,
    streamKeyPresent: streamKey.length > 0 || Boolean(streamKeySecretRef),
    authMode: saved.authMode === 'oauth' ? 'oauth' : 'manual-rtmp',
    accountId: typeof saved.accountId === 'string' ? saved.accountId : undefined,
    accountLabel: typeof saved.accountLabel === 'string' ? saved.accountLabel : undefined,
    platformBroadcastId:
      typeof saved.platformBroadcastId === 'string' ? saved.platformBroadcastId : undefined,
    platformStreamId:
      typeof saved.platformStreamId === 'string' ? saved.platformStreamId : undefined,
    createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : base.createdAt,
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : base.updatedAt
  }
}

export function normalizeStreamingSettings(value: unknown): StreamingSettings {
  const candidate = (value && typeof value === 'object' ? value : {}) as Partial<StreamingSettings>
  const now = new Date().toISOString()
  const persisted = Array.isArray(candidate.targets) ? candidate.targets : []
  const targets = STREAM_PLATFORM_ORDER.map((platform) => {
    const base = makeStreamTarget(platform, now)
    const saved = persisted.find(
      (target) =>
        target &&
        typeof target === 'object' &&
        (target.id === platform || target.platform === platform)
    )
    return saved ? normalizeStreamTarget(base, saved) : base
  })
  const enabledTargetIds = targets.filter((target) => target.enabled).map((target) => target.id)
  const defaultOutputPreset: VideoPreset =
    typeof candidate.defaultOutputPreset === 'string' &&
    candidate.defaultOutputPreset in videoPresets
      ? (candidate.defaultOutputPreset as VideoPreset)
      : 'tutorial-1080p30'

  return {
    enabled:
      typeof candidate.enabled === 'boolean' ? candidate.enabled : enabledTargetIds.length > 0,
    mode: enabledTargetIds.length > 1 ? 'multi' : 'single',
    targets,
    selectedTargetId:
      typeof candidate.selectedTargetId === 'string' ? candidate.selectedTargetId : undefined,
    defaultOutputPreset,
    defaultBitrateKbps: clampNumber(candidate.defaultBitrateKbps, 6000, 1000, 50000),
    enabledTargetIds
  }
}

export function migrateStreamingSettings(loaded: Partial<CaptureConfig>): StreamingSettings {
  // Already on the per-target model: normalize and return.
  if (loaded.streaming && typeof loaded.streaming === 'object') {
    return normalizeStreamingSettings(loaded.streaming)
  }

  // Legacy single-RTMP config: move the server/key into the matching platform
  // target only, so the other platforms keep their own (empty) credentials and
  // a YouTube key can never overwrite a Twitch/X key.
  const now = new Date().toISOString()
  const targets = defaultStreamTargets(now)
  const legacyPlatform: StreamPlatform = isStreamPlatform(loaded.rtmpPreset)
    ? loaded.rtmpPreset
    : 'youtube'
  const legacyKey = typeof loaded.streamKey === 'string' ? loaded.streamKey : ''
  const legacyServer = typeof loaded.rtmpServerUrl === 'string' ? loaded.rtmpServerUrl.trim() : ''
  const enabled = typeof loaded.streamEnabled === 'boolean' ? loaded.streamEnabled : false
  const match = targets.find((target) => target.platform === legacyPlatform)
  if (match) {
    if (legacyServer) {
      match.serverUrl = legacyServer
    }
    match.streamKey = legacyKey
    match.streamKeyPresent = legacyKey.length > 0
    match.enabled = enabled
    match.updatedAt = now
  }

  return {
    enabled,
    mode: 'single',
    targets,
    defaultOutputPreset: 'tutorial-1080p30',
    defaultBitrateKbps: 6000,
    enabledTargetIds: match && match.enabled ? [match.id] : []
  }
}

export function isStreamTargetReady(target: StreamTargetSettings): boolean {
  if (target.urlMode === 'full-url') {
    return (
      target.serverUrl.trim().length > 0 ||
      Boolean(target.streamKeySecretRef) ||
      target.streamKeyPresent
    )
  }
  if (!target.serverUrl.trim()) {
    return false
  }
  return (
    target.streamKey.trim().length > 0 ||
    Boolean(target.streamKeySecretRef) ||
    target.streamKeyPresent
  )
}

export function isStreamTargetStartReady(target: StreamTargetSettings): boolean {
  return target.authMode === 'oauth' || isStreamTargetReady(target)
}

export function areEnabledStreamTargetsStartReady(streaming: StreamingSettings): boolean {
  const enabled = streaming.targets.filter((target) => target.enabled)
  return enabled.length > 0 && enabled.every(isStreamTargetStartReady)
}

// Until the backend consumes the per-target model (M3), keep the legacy single
// RTMP fields in sync with the primary enabled target so the existing go-live
// path still streams to one platform.
export function bridgeStreamingToLegacy(config: CaptureConfig): CaptureConfig {
  const { streaming } = config
  const primary = streaming.enabled
    ? (streaming.targets.find((target) => target.enabled && isStreamTargetReady(target)) ??
      streaming.targets.find((target) => target.enabled))
    : undefined

  if (primary) {
    return {
      ...config,
      streamEnabled: true,
      rtmpPreset: primary.platform,
      rtmpServerUrl: primary.serverUrl,
      streamKey: primary.streamKey
    }
  }

  return { ...config, streamEnabled: false }
}

export function legacyStreamKeyMigrationCandidates(
  config: CaptureConfig
): LegacyStreamKeyMigrationCandidate[] {
  const candidates = new Map<string, LegacyStreamKeyMigrationCandidate>()
  for (const target of config.streaming.targets) {
    if (target.authMode !== 'manual-rtmp' || target.streamKeySecretRef) {
      continue
    }
    const streamKey = target.streamKey.trim()
    if (streamKey) {
      candidates.set(target.id, { targetId: target.id, streamKey })
    }
  }

  const legacyKey = config.streamKey.trim()
  if (!legacyKey) {
    return [...candidates.values()]
  }
  const primary =
    config.streaming.targets.find((target) => target.platform === config.rtmpPreset) ??
    config.streaming.targets.find((target) => target.enabled)
  if (
    primary &&
    primary.authMode === 'manual-rtmp' &&
    !primary.streamKeySecretRef &&
    !candidates.has(primary.id)
  ) {
    candidates.set(primary.id, { targetId: primary.id, streamKey: legacyKey })
  }

  return [...candidates.values()]
}

export function applyStoredManualStreamKeyResult(
  config: CaptureConfig,
  targetId: string,
  result: StoreManualStreamKeyResult
): CaptureConfig {
  const target = config.streaming.targets.find((item) => item.id === targetId)
  const streaming = patchPreparedStreamTarget(config.streaming, targetId, {
    serverUrl: target?.urlMode === 'full-url' ? '' : target?.serverUrl,
    streamKey: '',
    streamKeySecretRef: result.streamKeySecretRef,
    streamKeyPresent: result.streamKeyPresent,
    streamKeyHint: result.streamKeyHint,
    previousStreamKeyPresent: result.previousStreamKeyPresent,
    previousStreamKeyHint: result.previousStreamKeyHint
  })
  return bridgeStreamingToLegacy({ ...config, streaming })
}

export function persistableCaptureConfig(config: CaptureConfig): CaptureConfig {
  const targets = config.streaming.targets.map((target) => {
    if (!target.streamKeySecretRef && target.authMode !== 'oauth') {
      return target
    }
    return {
      ...target,
      serverUrl: target.urlMode === 'full-url' ? '' : target.serverUrl,
      streamKey: '',
      streamKeyPresent: Boolean(target.streamKeySecretRef)
    }
  })
  const streaming = { ...config.streaming, targets }
  const primary = streaming.targets.find((target) => target.platform === config.rtmpPreset)
  return {
    ...config,
    streaming,
    rtmpServerUrl:
      primary?.urlMode === 'full-url' && primary.streamKeySecretRef ? '' : config.rtmpServerUrl,
    streamKey: primary?.authMode === 'oauth' || primary?.streamKeySecretRef ? '' : config.streamKey
  }
}

export function patchStreamTargetForEdit(
  target: StreamTargetSettings,
  patch: Partial<StreamTargetSettings>,
  now: string = new Date().toISOString()
): StreamTargetSettings {
  const next: StreamTargetSettings = { ...target, ...patch, updatedAt: now }
  if (typeof patch.streamKey === 'string') {
    next.streamKeyPresent = patch.streamKey.trim().length > 0
  }
  if (patch.authMode && patch.authMode !== target.authMode) {
    next.streamKey = ''
    next.streamKeySecretRef = undefined
    next.streamKeyPresent = false
    next.platformBroadcastId = undefined
    next.platformStreamId = undefined
    next.status = { state: 'not-configured' }
    if (patch.authMode === 'oauth') {
      next.accountId = target.accountId
      next.accountLabel = target.accountLabel
    } else {
      next.accountId = undefined
      next.accountLabel = undefined
    }
  }
  if (patch.urlMode && patch.urlMode !== target.urlMode) {
    next.serverUrl =
      patch.urlMode === 'full-url'
        ? ''
        : target.platform === 'custom'
          ? rtmpDefaults.custom
          : target.serverUrl
    next.streamKey = ''
    next.streamKeySecretRef = undefined
    next.streamKeyPresent = false
    next.status = { state: 'not-configured' }
  }
  return next
}

export function patchPreparedStreamTarget(
  streaming: StreamingSettings,
  targetId: string,
  patch: Partial<StreamTargetSettings>,
  now: string = new Date().toISOString()
): StreamingSettings {
  return {
    ...streaming,
    targets: streaming.targets.map((target) =>
      target.id === targetId ? { ...target, ...patch, updatedAt: now } : target
    )
  }
}

export function preparedYouTubeActivationTargets(
  streaming: StreamingSettings
): StreamTargetSettings[] {
  return streaming.targets.filter(
    (target) =>
      target.enabled &&
      target.authMode === 'oauth' &&
      target.platform === 'youtube' &&
      Boolean(target.platformBroadcastId) &&
      Boolean(target.platformStreamId)
  )
}

export function preparedYouTubeCompletionTargets(
  streaming: StreamingSettings
): StreamTargetSettings[] {
  return streaming.targets.filter(
    (target) =>
      target.enabled &&
      target.authMode === 'oauth' &&
      target.platform === 'youtube' &&
      Boolean(target.platformBroadcastId)
  )
}

function findRememberedSource(
  sourceId: string | undefined,
  sourceName: string | undefined,
  devices: Device[]
): Device | undefined {
  if (sourceId) {
    const exact = devices.find((device) => device.id === sourceId)
    if (exact) {
      return exact
    }
  }

  const normalizedName = sourceName?.trim()
  if (!normalizedName) {
    return undefined
  }

  return devices.find((device) => device.name.trim() === normalizedName)
}

function sourceIdentityFor(device: Device | undefined): { id?: string; name?: string } {
  return { id: device?.id, name: device?.name }
}

export function reconcileSourceSelection(
  sources: SourceSelection,
  devices: Device[]
): SourceSelection {
  if (devices.length === 0) {
    // No device snapshot yet: the renderer mounts with an empty deviceList
    // placeholder and reconciles before the backend's first devices.list
    // answer. A real snapshot is never empty (the system-audio placeholder is
    // always listed), so reconciling here would clear remembered selections
    // and toast "unavailable" for devices that are present.
    return { ...sources }
  }

  const nextSources = { ...sources }
  const captureDevices = devices.filter(
    (device) => ['screen', 'window'].includes(device.kind) && device.status === 'available'
  )
  const cameras = devices.filter(
    (device) => device.kind === 'camera' && device.status === 'available'
  )
  const microphones = devices.filter(
    (device) => device.kind === 'microphone' && device.status === 'available'
  )

  const selectedCapture = nextSources.windowId
    ? (findRememberedSource(nextSources.windowId, nextSources.windowName, captureDevices) ??
      captureDevices[0])
    : (findRememberedSource(nextSources.screenId, nextSources.screenName, captureDevices) ??
      captureDevices[0])
  nextSources.screenId = selectedCapture?.kind === 'screen' ? selectedCapture.id : undefined
  nextSources.screenName = selectedCapture?.kind === 'screen' ? selectedCapture.name : undefined
  nextSources.windowId = selectedCapture?.kind === 'window' ? selectedCapture.id : undefined
  nextSources.windowName = selectedCapture?.kind === 'window' ? selectedCapture.name : undefined

  const selectedCamera =
    findRememberedSource(nextSources.cameraId, nextSources.cameraName, cameras) ?? cameras[0]
  const selectedMicrophone =
    findRememberedSource(nextSources.microphoneId, nextSources.microphoneName, microphones) ??
    microphones[0]

  const cameraIdentity = sourceIdentityFor(selectedCamera)
  nextSources.cameraId = cameraIdentity.id
  nextSources.cameraName = cameraIdentity.name
  const microphoneIdentity = sourceIdentityFor(selectedMicrophone)
  nextSources.microphoneId = microphoneIdentity.id
  nextSources.microphoneName = microphoneIdentity.name

  return nextSources
}

export function sourceSelectionChangeMessages(
  previous: SourceSelection,
  next: SourceSelection
): string[] {
  const messages = [
    sourceChangeMessage(
      'Capture source',
      previous.windowId ?? previous.screenId,
      previous.windowName ?? previous.screenName,
      next.windowId ?? next.screenId,
      next.windowName ?? next.screenName
    ),
    sourceChangeMessage(
      'Camera',
      previous.cameraId,
      previous.cameraName,
      next.cameraId,
      next.cameraName
    ),
    sourceChangeMessage(
      'Microphone',
      previous.microphoneId,
      previous.microphoneName,
      next.microphoneId,
      next.microphoneName
    )
  ]
  return messages.filter((message): message is string => Boolean(message))
}

function sourceChangeMessage(
  label: string,
  previousId: string | undefined,
  previousName: string | undefined,
  nextId: string | undefined,
  nextName: string | undefined
): string | undefined {
  if (!previousId && !previousName) {
    return undefined
  }
  if (previousId === nextId && previousName === nextName) {
    return undefined
  }

  const previousLabel = previousName ?? previousId ?? 'saved source'
  if (!nextId && !nextName) {
    return `${label} "${previousLabel}" is unavailable, so it was cleared.`
  }

  const nextLabel = nextName ?? nextId ?? 'another available source'
  if (previousName && previousName === nextName && previousId !== nextId) {
    return `${label} "${nextLabel}" was restored by name because its system ID changed.`
  }
  return `${label} "${previousLabel}" is unavailable, so Videorc selected "${nextLabel}".`
}

export function startButtonLabel(recordEnabled: boolean, streamEnabled: boolean): string {
  if (recordEnabled && streamEnabled) {
    return 'Start Livestream + Record'
  }
  if (streamEnabled) {
    return 'Start Livestream'
  }
  if (recordEnabled) {
    return 'Start Recording'
  }
  return 'Start Session'
}

export function startButtonPendingLabel(streamEnabled: boolean): string {
  return streamEnabled ? 'Starting Livestream...' : 'Starting Recording...'
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.round(parsed)))
}
