import type {
  AudioSettings,
  CaptionStyleId,
  AutomaticSourceFallbackEvent,
  AutomaticSourceFallbackSourceKind,
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
import {
  HORIZONTAL_LAYOUT_PRESETS,
  LAYOUT_PRESET_VALUES,
  VERTICAL_LAYOUT_PRESETS
} from '../../../shared/backend'

export type SettingsState = {
  /** Human-readable picker label only; never a filesystem path. */
  outputDirectory: string
  outputDirectoryHandle?: string
}

export type CaptionBurnTarget = 'off' | 'stream' | 'recording' | 'both'

export type CaptionsCaptureSettings = {
  /** Explicit, persisted consent. Audio is uploaded only during capture sessions. */
  enabled: boolean
  /** Which output legs the LIVE caption bar burns into (R1). */
  burnTarget: CaptionBurnTarget
  styleId: CaptionStyleId
  language: string
  styleRevision: number
  position: 'top' | 'bottom'
  textSize: 's' | 'm' | 'l'
}

export type CaptureConfig = {
  sources: SourceSelection
  layout: LayoutSettings
  audio: AudioSettings
  video: VideoSettings
  /**
   * Landscape canvas remembered while a vertical scene holds the output in
   * portrait — restored when the user switches back to a landscape scene
   * (verticalOrientationVideoPatch). Null outside vertical mode.
   */
  verticalRestoreVideo: VideoSettings | null
  /**
   * Last-used scene per Studio mode: the orientation toggle re-enters a mode
   * on the scene the user left it in. Kept fresh at the layout-transaction
   * commit point via layoutPresetMemoryPatch.
   */
  lastHorizontalPreset: LayoutPreset
  lastVerticalPreset: LayoutPreset
  recordEnabled: boolean
  streamEnabled: boolean
  rtmpPreset: RtmpPreset
  rtmpServerUrl: string
  streamKey: string
  streaming: StreamingSettings
  captions: CaptionsCaptureSettings
}

export type LegacyStreamKeyMigrationCandidate = {
  targetId: string
  streamKey: string
}

// The canonical per-mode scene lists live in shared/backend.ts next to the
// LayoutPreset type — the wire contracts validate against the same values, so
// renderer galleries and main-process event validation cannot drift apart.
export { HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS }

export type LayoutOrientation = 'horizontal' | 'vertical'

/**
 * Orientation class of a scene preset. Every preset belongs to exactly one
 * Studio mode — the mode is DERIVED from the active preset, never stored, so
 * mode and scene cannot drift apart. Mirrors the backend
 * `LayoutPreset::is_vertical`.
 */
export function layoutPresetOrientation(preset: LayoutPreset): LayoutOrientation {
  return (VERTICAL_LAYOUT_PRESETS as readonly string[]).includes(preset) ? 'vertical' : 'horizontal'
}

export function layoutPresetNeedsCamera(preset: LayoutPreset): boolean {
  return (
    preset === 'screen-camera' ||
    preset === 'camera-only' ||
    preset === 'side-by-side' ||
    preset === 'vertical-camera-top' ||
    preset === 'vertical-camera-bottom' ||
    preset === 'vertical-split' ||
    preset === 'vertical-screen-camera' ||
    preset === 'vertical-camera-only'
  )
}

export function layoutPresetNeedsScreen(preset: LayoutPreset): boolean {
  return (
    preset === 'screen-camera' ||
    preset === 'screen-only' ||
    preset === 'side-by-side' ||
    preset === 'vertical-camera-top' ||
    preset === 'vertical-camera-bottom' ||
    preset === 'vertical-split' ||
    preset === 'vertical-screen-camera' ||
    preset === 'vertical-screen-only'
  )
}

export function hasSelectedCameraSource(sources: SourceSelection): boolean {
  return Boolean(sources.cameraId)
}

export type VerticalOrientationVideoPatch = {
  video: VideoSettings
  verticalRestoreVideo: VideoSettings | null
}

/**
 * The Studio mode owns the canvas orientation: vertical mode records a
 * portrait canvas, horizontal a landscape one. Any video change that would
 * contradict the active scene's orientation transposes width/height — the
 * quality choice survives, the preset honestly becomes Custom. Every canvas
 * write flows through this (patchVideo, applyVideoPreset, config load), and
 * the backend refuses a mismatched session start as defense in depth.
 */
export function coerceVideoToOrientation(
  video: VideoSettings,
  orientation: LayoutOrientation
): VideoSettings {
  const transpose =
    orientation === 'vertical' ? video.width > video.height : video.height > video.width
  if (!transpose) {
    return video
  }
  return { ...video, preset: 'custom', width: video.height, height: video.width }
}

export type ResolutionOption = {
  label: string
  detail: string
  width: number
  height: number
}

// One-click canvas sizes offered by Quick Settings and the Output tab. Each
// Studio mode gets its own list — the vertical options are the transposed
// twins of the landscape ones, so orientation can never contradict the mode
// (the mode toggle is the one home for orientation).
const HORIZONTAL_RESOLUTION_OPTIONS: ResolutionOption[] = [
  { label: '4K', detail: '3840 × 2160', width: 3840, height: 2160 },
  { label: '2K', detail: '2560 × 1440', width: 2560, height: 1440 },
  { label: '1080p', detail: '1920 × 1080', width: 1920, height: 1080 },
  { label: '720p', detail: '1280 × 720', width: 1280, height: 720 }
]

const VERTICAL_RESOLUTION_OPTIONS: ResolutionOption[] = [
  { label: '4K', detail: '2160 × 3840', width: 2160, height: 3840 },
  { label: '2K', detail: '1440 × 2560', width: 1440, height: 2560 },
  { label: '1080p', detail: '1080 × 1920', width: 1080, height: 1920 },
  { label: '720p', detail: '720 × 1280', width: 720, height: 1280 }
]

export function resolutionOptionsForOrientation(
  orientation: LayoutOrientation
): ResolutionOption[] {
  return orientation === 'vertical' ? VERTICAL_RESOLUTION_OPTIONS : HORIZONTAL_RESOLUTION_OPTIONS
}

/**
 * Off-air orientation coupling for the Studio modes: entering a vertical
 * scene flips the canvas to the portrait profile and remembers the landscape
 * settings; leaving restores exactly what was there. Returns null when no
 * video change is needed — same orientation class (scene switches WITHIN a
 * mode never touch the canvas), a canvas the user already made portrait
 * (entering), or a canvas the user already made landscape while in vertical
 * mode (leaving — their explicit choice wins). Callers MUST NOT apply this
 * mid-session: the encoder canvas is fixed at session start (the backend
 * refuses cross-orientation switches as defense in depth).
 */
export function verticalOrientationVideoPatch(
  fromPreset: LayoutPreset,
  toPreset: LayoutPreset,
  video: VideoSettings,
  verticalRestoreVideo: VideoSettings | null
): VerticalOrientationVideoPatch | null {
  const fromVertical = layoutPresetOrientation(fromPreset) === 'vertical'
  const toVertical = layoutPresetOrientation(toPreset) === 'vertical'
  if (fromVertical === toVertical) {
    return null
  }
  if (toVertical) {
    if (video.height > video.width) {
      return null
    }
    return { video: videoPresets['vertical-1080x1920'], verticalRestoreVideo: video }
  }
  if (video.height <= video.width) {
    return { video, verticalRestoreVideo: null }
  }
  return {
    video: verticalRestoreVideo ?? defaultCaptureConfig.video,
    verticalRestoreVideo: null
  }
}

/** Config patch remembering `preset` as its mode's last-used scene. */
export function layoutPresetMemoryPatch(
  preset: LayoutPreset
): Partial<Pick<CaptureConfig, 'lastHorizontalPreset' | 'lastVerticalPreset'>> {
  return layoutPresetOrientation(preset) === 'vertical'
    ? { lastVerticalPreset: preset }
    : { lastHorizontalPreset: preset }
}

/**
 * The scene the Studio mode toggle applies when switching to `target`: the
 * mode's remembered scene, guarded back to its default if the remembered
 * value is somehow cross-class (the mode is derived from the preset, so a
 * wrong-class memory would strand the toggle in the mode it tried to leave).
 */
export function studioModeTogglePreset(
  target: LayoutOrientation,
  config: Pick<CaptureConfig, 'lastHorizontalPreset' | 'lastVerticalPreset'>
): LayoutPreset {
  const remembered = target === 'vertical' ? config.lastVerticalPreset : config.lastHorizontalPreset
  if (layoutPresetOrientation(remembered) !== target) {
    return target === 'vertical'
      ? defaultCaptureConfig.lastVerticalPreset
      : defaultCaptureConfig.lastHorizontalPreset
  }
  return remembered
}

export function hasSelectedScreenSource(sources: SourceSelection): boolean {
  return Boolean(
    isNativeScreenSourceId(sources.screenId) ||
    isAvFoundationScreenSourceId(sources.screenId) ||
    isNativeWindowSourceId(sources.windowId) ||
    sources.testPattern
  )
}

export type AudioSyncRecommendationReport = {
  pass?: boolean
  medianOffsetMs?: number | null
  currentMicrophoneSyncOffsetMs?: number | null
  recommendedMicrophoneSyncOffsetMs?: number | null
  targetMs?: number | null
  pairCount?: number | null
  failures?: string[]
  warnings?: string[]
}

export type AudioSyncCalibrationStatus = 'unavailable' | 'current' | 'optional' | 'recommended'

export type AudioSyncCalibrationState = {
  status: AudioSyncCalibrationStatus
  canApply: boolean
  measuredLagLabel: string
  detail: string
  recommendedOffsetMs: number | null
}

export type AudioSyncRecommendationParseResult =
  | { ok: true; recommendation: AudioSyncRecommendationReport }
  | { ok: false; error: string }

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
  theme: 'videorc.theme',
  backgroundAssets: 'videorc.backgroundAssets'
} as const

// Permissions onboarding: ANY stored value means "seen/dismissed" — the gate
// itself is permission state, not this flag. Older installs hold
// 'creator-ux-v1' from the retired 4-step tour and stay suppressed; the UI
// probe scripts seed that same value, which must keep working.
export const ONBOARDING_DISMISSED_VALUE = 'permissions-v1'
export const MICROPHONE_SYNC_OFFSET_MIN_MS = -1000
export const MICROPHONE_SYNC_OFFSET_MAX_MS = 1000

export const defaultSettings: SettingsState = {
  outputDirectory: '',
  outputDirectoryHandle: undefined
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

export function oauthUnavailableReason(platform: StreamPlatform): string | null {
  return platform === 'custom' ? 'Custom RTMP does not support OAuth.' : null
}

export function isPlatformOAuthAvailable(platform: StreamPlatform): boolean {
  return platform !== 'custom' && !oauthUnavailableReason(platform)
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
  'stream-youtube-4k30': {
    preset: 'stream-youtube-4k30',
    width: 3840,
    height: 2160,
    fps: 30,
    bitrateKbps: 30000
  },
  'stream-1080p60': {
    preset: 'stream-1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 9000
  },
  // True portrait canvas for short-form output (Shorts/Reels/TikTok): the
  // Vertical scene applies this preset off-air (vertical scene plan S2/S4).
  'vertical-1080x1920': {
    preset: 'vertical-1080x1920',
    width: 1080,
    height: 1920,
    fps: 30,
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
  { value: 'tutorial-1080p30', label: 'Tutorial 1080p30' },
  { value: 'vertical-1080x1920', label: 'Vertical 1080×1920 (9:16)' }
]

export const streamingVideoPresetOptions: VideoPresetOption[] = [
  { value: 'stream-safe-1080p30', label: 'Stream-safe 1080p30' },
  { value: 'stream-safe-1080p60', label: 'Stream-safe 1080p60' },
  { value: 'stream-youtube-4k30', label: 'YouTube 4K30' }
]

export const legacyVideoPresetOptions: VideoPresetOption[] = [
  { value: 'stream-1080p60', label: 'Legacy Stream 1080p60', tone: 'warning' }
]

export const customVideoPresetOption: VideoPresetOption = { value: 'custom', label: 'Custom' }

export interface VideoProfileCompatibility {
  blockingReason: string | null
  warning: string | null
}

export type StreamPlatformOutputCapability = {
  maxWidth: number
  maxHeight: number
  maxFps: number
  maxBitrateKbps: number
  true4k: boolean
}

export const streamPlatformOutputCapabilities: Record<
  StreamPlatform,
  StreamPlatformOutputCapability
> = {
  youtube: {
    maxWidth: 3840,
    maxHeight: 2160,
    maxFps: 30,
    maxBitrateKbps: 30000,
    true4k: true
  },
  twitch: {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 60,
    maxBitrateKbps: 6000,
    true4k: false
  },
  x: {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30,
    maxBitrateKbps: 6000,
    true4k: false
  },
  custom: {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30,
    maxBitrateKbps: 6000,
    true4k: false
  }
}

export function videoProfileCompatibility(
  config: Pick<CaptureConfig, 'recordEnabled' | 'streamEnabled' | 'video'> & {
    streaming?: StreamingSettings
  }
): VideoProfileCompatibility {
  // Video-profile / streaming guardrails removed per owner (2026-06-24): 4K
  // livestreaming (YouTube 4K30), higher-bitrate and non-YouTube stream outputs
  // ship now, so the app no longer pre-blocks these profiles. Platforms and the
  // backend reject genuinely-unsupported combinations at runtime.
  //
  // One WARNING (not a block) restored 2026-07-02 for the reproduced
  // split-output freeze incident (docs/live-video-freeze-incident-plan.md):
  // 4K local recording while livestreaming drops the recording to ~8fps while
  // audio continues. Warn until LVF2–LVF4 land; the session still starts.
  if (
    config.recordEnabled &&
    config.streamEnabled &&
    Math.min(config.video.width, config.video.height) >= 2160
  ) {
    return {
      blockingReason: null,
      warning:
        '4K local recording while livestreaming is known to drop recorded video to ~8fps ' +
        '(audio keeps running). Until the split-output fix ships, record at 1080p/2K while ' +
        'streaming, stream without local 4K recording, or record 4K without streaming.'
    }
  }
  return { blockingReason: null, warning: null }
}

export interface StreamTargetOutput {
  target: StreamTargetSettings | undefined
  video: VideoSettings
}

export function streamOutputVideoSettings(
  fallback: VideoSettings,
  streaming: StreamingSettings | undefined
): VideoSettings {
  if (!streaming?.enabled) {
    return fallback
  }

  const preset = videoPresets[streaming.defaultOutputPreset] ?? fallback
  return {
    ...preset,
    bitrateKbps: streaming.defaultBitrateKbps
  }
}

export function streamOutputVideoForTarget(
  fallback: VideoSettings,
  streaming: StreamingSettings | undefined,
  target: StreamTargetSettings | undefined
): VideoSettings {
  if (!streaming?.enabled || !target) {
    return streamOutputVideoSettings(fallback, streaming)
  }

  const outputPreset =
    target.outputPreset ??
    (streaming.defaultOutputPreset === 'stream-youtube-4k30' && target.platform !== 'youtube'
      ? 'stream-safe-1080p30'
      : streaming.defaultOutputPreset)
  const preset = videoPresets[outputPreset] ?? streamOutputVideoSettings(fallback, streaming)
  const bitrateKbps =
    target.outputBitrateKbps ??
    (outputPreset === streaming.defaultOutputPreset
      ? streaming.defaultBitrateKbps
      : preset.bitrateKbps)

  return {
    ...preset,
    bitrateKbps
  }
}

export function streamOutputVideosForTargets(
  fallback: VideoSettings,
  streaming: StreamingSettings | undefined
): StreamTargetOutput[] {
  const targets = streaming?.targets.filter((target) => target.enabled) ?? []
  return targets.map((target) => ({
    target,
    video: streamOutputVideoForTarget(fallback, streaming, target)
  }))
}

function sameVideoOutputProfile(left: VideoSettings, right: VideoSettings): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps &&
    left.bitrateKbps === right.bitrateKbps
  )
}

/**
 * Mirrors the backend's record+stream auxiliary compositor profile choice.
 * The auxiliary uses the distinct enabled-target output; when every enabled
 * target shares the recording profile, caption routing forces a same-profile
 * auxiliary and therefore falls back to the recording canvas.
 */
export function auxiliaryStreamOutputVideoSettings(
  recording: VideoSettings,
  streaming: StreamingSettings | undefined
): VideoSettings {
  const companion = streamOutputVideosForTargets(recording, streaming).find(
    ({ video }) => !sameVideoOutputProfile(video, recording)
  )
  return companion?.video ?? recording
}

export const defaultCaptureConfig: CaptureConfig = {
  sources: {},
  verticalRestoreVideo: null,
  lastHorizontalPreset: 'screen-camera',
  lastVerticalPreset: 'vertical-camera-top',
  layout: {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
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
  streaming: defaultStreamingSettings(),
  captions: defaultCaptionsCaptureSettings()
}

export function defaultCaptionsCaptureSettings(): CaptionsCaptureSettings {
  return {
    enabled: false,
    burnTarget: 'stream',
    styleId: 'classic',
    language: 'auto',
    styleRevision: 0,
    position: 'bottom',
    textSize: 'm'
  }
}

const CAPTION_BURN_TARGETS: CaptionBurnTarget[] = ['off', 'stream', 'recording', 'both']
const CAPTION_STYLE_IDS: CaptionStyleId[] = ['classic', 'glass', 'lower-third', 'high-contrast']

export function normalizeCaptionsCaptureSettings(
  loaded: (Partial<CaptionsCaptureSettings> & { burnInEnabled?: boolean }) | undefined
): CaptionsCaptureSettings {
  const defaults = defaultCaptionsCaptureSettings()
  // Pre-R1 configs carried a boolean; true meant the stream leg.
  const migrated: CaptionBurnTarget | undefined =
    loaded?.burnTarget === undefined && typeof loaded?.burnInEnabled === 'boolean'
      ? loaded.burnInEnabled
        ? 'stream'
        : 'off'
      : undefined
  return {
    // Missing consent is always false. Never infer permission from legacy burn-in.
    enabled: loaded?.enabled === true,
    burnTarget: CAPTION_BURN_TARGETS.includes(loaded?.burnTarget as CaptionBurnTarget)
      ? (loaded?.burnTarget as CaptionBurnTarget)
      : (migrated ?? (loaded ? 'off' : defaults.burnTarget)),
    // A real legacy captions object had the single Glass renderer. Preserve it;
    // brand-new profiles come from defaultCaptionsCaptureSettings (Classic).
    styleId: CAPTION_STYLE_IDS.includes(loaded?.styleId as CaptionStyleId)
      ? (loaded?.styleId as CaptionStyleId)
      : loaded
        ? 'glass'
        : defaults.styleId,
    language:
      typeof loaded?.language === 'string' && loaded.language.trim()
        ? loaded.language.trim()
        : defaults.language,
    styleRevision:
      typeof loaded?.styleRevision === 'number' &&
      Number.isSafeInteger(loaded.styleRevision) &&
      loaded.styleRevision >= 0
        ? loaded.styleRevision
        : defaults.styleRevision,
    position: loaded?.position === 'top' ? 'top' : defaults.position,
    textSize:
      loaded?.textSize === 's' || loaded?.textSize === 'l' ? loaded.textSize : defaults.textSize
  }
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
  const { testPattern: _loadedTestPattern, ...loadedSources } = loaded.sources ?? {}
  const layout = normalizeLayoutSettings(loaded.layout)

  return {
    ...defaultCaptureConfig,
    ...loaded,
    sources: { ...defaultCaptureConfig.sources, ...loadedSources, testPattern: false },
    layout,
    audio: normalizeAudioSettings(loaded.audio),
    // A persisted canvas that contradicts the persisted scene's orientation
    // (e.g. a landscape 2K under a vertical scene, saved by a pre-lock build)
    // normalizes to the mode's orientation on load.
    video: coerceVideoToOrientation(
      normalizeVideoSettings(loaded.video),
      layoutPresetOrientation(layout.layoutPreset)
    ),
    verticalRestoreVideo:
      loaded.verticalRestoreVideo != null
        ? coerceVideoToOrientation(
            normalizeVideoSettings(loaded.verticalRestoreVideo),
            'horizontal'
          )
        : null,
    lastHorizontalPreset: normalizeRememberedPreset(loaded.lastHorizontalPreset, 'horizontal'),
    lastVerticalPreset: normalizeRememberedPreset(loaded.lastVerticalPreset, 'vertical'),
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
    streaming: migrateStreamingSettings(loaded),
    captions: normalizeCaptionsCaptureSettings(loaded.captions)
  }
}

export function smokePreviewCompositorCaptureConfig(
  config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'>
): Pick<CaptureConfig, 'sources' | 'layout' | 'video'> {
  const includeCamera = layoutPresetNeedsCamera(config.layout.layoutPreset)
  return {
    ...config,
    sources: {
      cameraId: includeCamera ? 'camera:synthetic-preview-smoke' : undefined,
      cameraName: includeCamera ? 'Synthetic preview camera' : undefined,
      microphoneId: config.sources.microphoneId,
      microphoneName: config.sources.microphoneName,
      testPattern: true
    }
  }
}

export function previewDeviceRefreshSignature(devices: Device[]): string {
  return devices
    .map((device) =>
      [device.kind, device.id, device.name, device.status, device.detail ?? ''].join(':')
    )
    .sort()
    .join('|')
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

export function parseAudioSyncRecommendationJson(text: string): AudioSyncRecommendationParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Measurement JSON could not be parsed.' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Measurement JSON must be an object.' }
  }

  const candidate = parsed as Record<string, unknown>
  if (candidate.schemaVersion !== 1) {
    return { ok: false, error: 'Measurement JSON must use schemaVersion 1.' }
  }

  return {
    ok: true,
    recommendation: {
      pass: candidate.pass === true,
      medianOffsetMs: optionalNumber(candidate.medianOffsetMs),
      currentMicrophoneSyncOffsetMs: optionalNumber(candidate.currentMicrophoneSyncOffsetMs),
      recommendedMicrophoneSyncOffsetMs: optionalNumber(
        candidate.recommendedMicrophoneSyncOffsetMs
      ),
      targetMs: optionalNumber(candidate.targetMs),
      pairCount: optionalNumber(candidate.pairCount),
      failures: stringList(candidate.failures),
      warnings: stringList(candidate.warnings)
    }
  }
}

export function formatMeasuredAudioLag(offsetMs: number | null | undefined): string {
  const offset = typeof offsetMs === 'number' && Number.isFinite(offsetMs) ? offsetMs : null
  if (offset == null) {
    return 'No paired flash/click measurement'
  }

  const rounded = Math.round(offset)
  if (rounded === 0) {
    return 'Audio is aligned at 0 ms'
  }

  return rounded > 0
    ? `Audio lags video by ${rounded} ms`
    : `Audio leads video by ${Math.abs(rounded)} ms`
}

export function audioSyncCalibrationState(
  recommendation: AudioSyncRecommendationReport | null | undefined,
  currentAudio: AudioSettings = defaultCaptureConfig.audio
): AudioSyncCalibrationState {
  const measuredLagLabel = formatMeasuredAudioLag(recommendation?.medianOffsetMs)
  const pairCount = Number(recommendation?.pairCount ?? 0)
  const recommended = recommendation?.recommendedMicrophoneSyncOffsetMs
  const currentOffset = normalizeMicrophoneSyncOffsetMs(
    currentAudio.microphoneSyncOffsetMs,
    defaultCaptureConfig.audio.microphoneSyncOffsetMs
  )

  if (!Number.isFinite(recommended) || pairCount <= 0) {
    return {
      status: 'unavailable',
      canApply: false,
      measuredLagLabel,
      detail: 'Record a flash/click sample before applying calibration.',
      recommendedOffsetMs: null
    }
  }

  const recommendedOffsetMs = normalizeMicrophoneSyncOffsetMs(recommended, currentOffset)
  if (recommendedOffsetMs === currentOffset) {
    return {
      status: 'current',
      canApply: false,
      measuredLagLabel,
      detail: 'Current microphone sync offset already matches this recommendation.',
      recommendedOffsetMs
    }
  }

  const withinTarget =
    recommendation?.pass === true ||
    (Number.isFinite(recommendation?.targetMs) &&
      Number.isFinite(recommendation?.medianOffsetMs) &&
      Math.abs(Number(recommendation?.medianOffsetMs)) <= Number(recommendation?.targetMs))

  return {
    status: withinTarget ? 'optional' : 'recommended',
    canApply: true,
    measuredLagLabel,
    detail: withinTarget
      ? 'Measurement is within target; applying the recommendation is optional.'
      : 'Apply the measured recommendation, then record another flash/click sample.',
    recommendedOffsetMs
  }
}

export function applyAudioSyncRecommendation(
  audio: AudioSettings,
  recommendation: AudioSyncRecommendationReport
): AudioSettings {
  const state = audioSyncCalibrationState(recommendation, audio)
  if (!state.canApply || state.recommendedOffsetMs == null) {
    return audio
  }

  return {
    ...audio,
    microphoneSyncOffsetMs: state.recommendedOffsetMs,
    microphoneSyncOffsetUserSet: true
  }
}

export function resetAudioSyncCalibration(audio: AudioSettings): AudioSettings {
  return {
    ...audio,
    microphoneSyncOffsetMs: defaultCaptureConfig.audio.microphoneSyncOffsetMs,
    microphoneSyncOffsetUserSet: false
  }
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === 'string' && (LAYOUT_PRESET_VALUES as readonly string[]).includes(value)
}

/**
 * Pre-split wire names for presets that were renamed. 'vertical' never
 * shipped in a release, but dev-era persisted configs carry it — mirror the
 * backend's serde alias instead of silently resetting those to the default.
 */
const LEGACY_LAYOUT_PRESET_ALIASES: Record<string, LayoutPreset> = {
  vertical: 'vertical-camera-top'
}

/** A persisted per-mode scene memory must belong to its mode's class. */
function normalizeRememberedPreset(value: unknown, orientation: LayoutOrientation): LayoutPreset {
  if (isLayoutPreset(value) && layoutPresetOrientation(value) === orientation) {
    return value
  }
  return orientation === 'vertical'
    ? defaultCaptureConfig.lastVerticalPreset
    : defaultCaptureConfig.lastHorizontalPreset
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
      : (typeof candidate.layoutPreset === 'string' &&
          LEGACY_LAYOUT_PRESET_ALIASES[candidate.layoutPreset]) ||
        defaultCaptureConfig.layout.layoutPreset,
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
    cameraShape:
      candidate.cameraShape === 'rectangle' ||
      candidate.cameraShape === 'rounded' ||
      candidate.cameraShape === 'circle'
        ? candidate.cameraShape
        : defaultCaptureConfig.layout.cameraShape,
    cameraCornerRadiusPct: clampNumber(
      candidate.cameraCornerRadiusPct,
      defaultCaptureConfig.layout.cameraCornerRadiusPct,
      0,
      50
    ),
    cameraAspect:
      candidate.cameraAspect === 'source' ||
      candidate.cameraAspect === 'square' ||
      candidate.cameraAspect === 'portrait'
        ? candidate.cameraAspect
        : defaultCaptureConfig.layout.cameraAspect,
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
  const savedAuthMode = saved.authMode === 'oauth' ? 'oauth' : 'manual-rtmp'
  const authMode =
    savedAuthMode === 'oauth' && isPlatformOAuthAvailable(base.platform) ? 'oauth' : 'manual-rtmp'
  const oauthUnavailable = savedAuthMode === 'oauth' && authMode !== 'oauth'
  return {
    // id, platform, status keep the built-in identity from base.
    ...base,
    label: typeof saved.label === 'string' && saved.label ? saved.label : base.label,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : false,
    serverUrl,
    urlMode: saved.urlMode === 'full-url' ? 'full-url' : 'server-and-key',
    streamKey: oauthUnavailable ? '' : streamKey,
    streamKeySecretRef: oauthUnavailable ? undefined : streamKeySecretRef,
    streamKeyPresent: !oauthUnavailable && (streamKey.length > 0 || Boolean(streamKeySecretRef)),
    authMode,
    accountId:
      authMode === 'oauth' && typeof saved.accountId === 'string' ? saved.accountId : undefined,
    accountLabel:
      authMode === 'oauth' && typeof saved.accountLabel === 'string'
        ? saved.accountLabel
        : undefined,
    platformBroadcastId:
      authMode === 'oauth' && typeof saved.platformBroadcastId === 'string'
        ? saved.platformBroadcastId
        : undefined,
    platformStreamId:
      authMode === 'oauth' && typeof saved.platformStreamId === 'string'
        ? saved.platformStreamId
        : undefined,
    outputPreset:
      typeof saved.outputPreset === 'string' && saved.outputPreset in videoPresets
        ? saved.outputPreset
        : undefined,
    outputBitrateKbps:
      typeof saved.outputBitrateKbps === 'number'
        ? clampNumber(saved.outputBitrateKbps, 6000, 1000, 50000)
        : undefined,
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
  if (target.authMode === 'oauth') {
    return isPlatformOAuthAvailable(target.platform)
  }
  return isStreamTargetReady(target)
}

export function readyStreamTargetLabels(streaming: StreamingSettings): string[] {
  return streaming.targets
    .filter((target) => target.enabled && isStreamTargetStartReady(target))
    .map((target) => target.label)
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
    ? (streaming.targets.find((target) => target.enabled && isStreamTargetStartReady(target)) ??
      streaming.targets.find((target) => target.enabled && !isUnavailableOAuthTarget(target)))
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
  const { testPattern: _testPattern, ...sources } = config.sources
  const targets = config.streaming.targets.map((item) => {
    const target = removeUnavailableOAuthState(item)
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
    sources,
    streaming,
    rtmpServerUrl:
      primary?.urlMode === 'full-url' && primary.streamKeySecretRef ? '' : config.rtmpServerUrl,
    streamKey:
      primary?.authMode === 'oauth' || primary?.streamKeySecretRef
        ? ''
        : (primary?.streamKey ?? config.streamKey)
  }
}

function removeUnavailableOAuthState(target: StreamTargetSettings): StreamTargetSettings {
  if (!isUnavailableOAuthTarget(target)) {
    return target
  }
  return {
    ...target,
    authMode: 'manual-rtmp',
    streamKey: '',
    streamKeySecretRef: undefined,
    streamKeyPresent: false,
    accountId: undefined,
    accountLabel: undefined,
    platformBroadcastId: undefined,
    platformStreamId: undefined,
    status: { state: 'not-configured' }
  }
}

function isUnavailableOAuthTarget(target: StreamTargetSettings): boolean {
  return target.authMode === 'oauth' && !isPlatformOAuthAvailable(target.platform)
}

export function patchStreamTargetForEdit(
  target: StreamTargetSettings,
  patch: Partial<StreamTargetSettings>,
  now: string = new Date().toISOString()
): StreamTargetSettings {
  const { authMode: requestedAuthMode, ...restPatch } = patch
  const next: StreamTargetSettings = {
    ...target,
    ...restPatch,
    ...(requestedAuthMode &&
    (requestedAuthMode !== 'oauth' || isPlatformOAuthAvailable(target.platform))
      ? { authMode: requestedAuthMode }
      : {}),
    updatedAt: now
  }
  if (typeof patch.streamKey === 'string') {
    next.streamKeyPresent = patch.streamKey.trim().length > 0
  }
  if (requestedAuthMode && next.authMode !== target.authMode) {
    next.streamKey = ''
    next.streamKeySecretRef = undefined
    next.streamKeyPresent = false
    next.platformBroadcastId = undefined
    next.platformStreamId = undefined
    next.status = { state: 'not-configured' }
    if (next.authMode === 'oauth') {
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
  return removeUnavailableOAuthState(next)
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
      isPlatformOAuthAvailable(target.platform) &&
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
      isPlatformOAuthAvailable(target.platform) &&
      target.status?.state === 'live' &&
      Boolean(target.platformBroadcastId)
  )
}

export function preparedXActivationTargets(streaming: StreamingSettings): StreamTargetSettings[] {
  return streaming.targets.filter(
    (target) =>
      target.enabled &&
      target.authMode === 'oauth' &&
      target.platform === 'x' &&
      Boolean(target.platformStreamId) &&
      Boolean(target.platformBroadcastId) &&
      target.status?.state === 'ready'
  )
}

export function preparedXCompletionTargets(streaming: StreamingSettings): StreamTargetSettings[] {
  return streaming.targets.filter(
    (target) =>
      target.enabled &&
      target.authMode === 'oauth' &&
      target.platform === 'x' &&
      target.status?.state === 'live' &&
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

export function isNativeScreenSourceId(sourceId: string | undefined): boolean {
  return (
    sourceId?.startsWith('screen:screencapturekit:') === true ||
    sourceId?.startsWith('screen:dxgi:') === true ||
    sourceId === 'screen:gdigrab:desktop'
  )
}

export function isNativeWindowSourceId(sourceId: string | undefined): boolean {
  return sourceId?.startsWith('window:screencapturekit:') === true
}

function isAvFoundationScreenSourceId(sourceId: string | undefined): boolean {
  return sourceId?.startsWith('screen:avfoundation:') === true
}

export function isAvFoundationMicrophoneId(sourceId: string | undefined): boolean {
  return sourceId?.startsWith('microphone:avfoundation:') === true
}

// Older builds published every avfoundation microphone as a selectable
// "Fallback - X" duplicate of its CoreAudio device; the prefix survives in
// persisted selections and must map back to the native device name.
const FALLBACK_MICROPHONE_NAME_PREFIX = 'Fallback - '

function nativeMicrophoneNameFor(name: string | undefined): string | undefined {
  return name?.startsWith(FALLBACK_MICROPHONE_NAME_PREFIX)
    ? name.slice(FALLBACK_MICROPHONE_NAME_PREFIX.length)
    : name
}

// Mirrors the backend picker rule (and guards against older backends that
// still list them): avfoundation microphones are the internal silent-mic
// retry path and are only selectable when no native input row exists at all.
export function microphonePickerDevices(devices: Device[]): Device[] {
  const microphones = devices.filter((device) => device.kind === 'microphone')
  const nativeMicrophones = microphones.filter((device) => !isAvFoundationMicrophoneId(device.id))
  return nativeMicrophones.length > 0 ? nativeMicrophones : microphones
}

const SCREEN_CAPTUREKIT_STATUS_IDS = new Set([
  'screen:screencapturekit-permission',
  'screen:screencapturekit-unavailable',
  'screen:screencapturekit-timeout',
  'screen:screencapturekit-missing'
])

const WINDOW_CAPTUREKIT_STATUS_IDS = new Set([
  'window:screencapturekit-permission',
  'window:screencapturekit-unavailable',
  'window:screencapturekit-timeout',
  'window:screencapturekit-missing'
])

export function isNativeCaptureDevice(device: Device): boolean {
  return (
    (device.kind === 'screen' && isNativeScreenSourceId(device.id)) ||
    (device.kind === 'window' && isNativeWindowSourceId(device.id))
  )
}

export function isSelectableCaptureDevice(device: Device): boolean {
  return (
    device.status === 'available' &&
    (isNativeCaptureDevice(device) || isAvFoundationScreenCaptureDevice(device))
  )
}

export function isScreenCaptureKitCaptureDevice(device: Device): boolean {
  return (
    (device.kind === 'screen' &&
      (isNativeScreenSourceId(device.id) || SCREEN_CAPTUREKIT_STATUS_IDS.has(device.id))) ||
    (device.kind === 'window' &&
      (isNativeWindowSourceId(device.id) || WINDOW_CAPTUREKIT_STATUS_IDS.has(device.id)))
  )
}

export function isCapturePickerDevice(device: Device): boolean {
  return isScreenCaptureKitCaptureDevice(device) || isAvFoundationScreenCaptureDevice(device)
}

// The macOS login window belongs to a different GUI session: building a
// ScreenCaptureKit filter for it aborts the backend outright (SkyLight assert,
// F-013). It is the only "window" enumerable while Screen Recording permission
// is missing, so it must never be offered, defaulted, or resolved from a
// remembered selection.
export function isSystemSessionWindowDevice(device: Device): boolean {
  return device.kind === 'window' && device.name === 'loginwindow'
}

export function capturePickerDevices(devices: Device[]): Device[] {
  const screenCaptureKitDevices = devices
    .filter(isScreenCaptureKitCaptureDevice)
    .filter((device) => !isSystemSessionWindowDevice(device))
  const nativeCaptureDevices = screenCaptureKitDevices.filter(
    (device) => device.status === 'available' && isNativeCaptureDevice(device)
  )
  if (nativeCaptureDevices.length > 0) {
    return screenCaptureKitDevices
  }

  const legacyScreenCaptureDevices = devices.filter(isAvFoundationScreenCaptureDevice)
  if (screenCaptureKitDevices.length > 0) {
    return [...screenCaptureKitDevices, ...legacyScreenCaptureDevices]
  }

  return legacyScreenCaptureDevices
}

/**
 * Pure builders for the next SourceSelection when the user picks a screen/window,
 * camera, or microphone. Shared by the Sources tab and the Studio Quick Settings
 * so both surfaces write the identical captureConfig.sources shape (one state).
 */
export function buildCaptureSources(
  current: SourceSelection,
  captureDevices: Device[],
  captureId: string | undefined
): SourceSelection {
  const selected = captureDevices.find((device) => device.id === captureId)
  return {
    ...current,
    screenId: selected?.kind === 'screen' ? captureId : undefined,
    screenName: selected?.kind === 'screen' ? selected.name : undefined,
    windowId: selected?.kind === 'window' ? captureId : undefined,
    windowName: selected?.kind === 'window' ? selected.name : undefined,
    testPattern: false
  }
}

export function buildCameraSources(
  current: SourceSelection,
  cameras: Device[],
  cameraId: string | undefined
): SourceSelection {
  const selected = cameras.find((device) => device.id === cameraId)
  return { ...current, cameraId, cameraName: selected?.name }
}

export function buildMicrophoneSources(
  current: SourceSelection,
  microphones: Device[],
  microphoneId: string | undefined
): SourceSelection {
  const selected = microphones.find((device) => device.id === microphoneId)
  return { ...current, microphoneId, microphoneName: selected?.name }
}

function isAvFoundationScreenCaptureDevice(device: Device): boolean {
  return device.kind === 'screen' && isAvFoundationScreenSourceId(device.id)
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
  // Foreign-session windows (loginwindow) crash the backend when captured —
  // exclude them before ANY resolution, including remembered selections that
  // older builds may have persisted (F-013).
  const screenCaptureKitDevices = devices
    .filter(isScreenCaptureKitCaptureDevice)
    .filter((device) => !isSystemSessionWindowDevice(device))
  const captureDevices = devices.filter(
    (device) => ['screen', 'window'].includes(device.kind) && device.status === 'available'
  )
  const nativeCaptureDevices = screenCaptureKitDevices.filter(
    (device) => device.status === 'available' && isNativeCaptureDevice(device)
  )
  const legacyScreenCaptureDevices =
    nativeCaptureDevices.length === 0
      ? captureDevices.filter(isAvFoundationScreenCaptureDevice)
      : []
  const selectableCaptureDevices =
    nativeCaptureDevices.length > 0 ? nativeCaptureDevices : legacyScreenCaptureDevices
  const cameras = devices.filter(
    (device) => device.kind === 'camera' && device.status === 'available'
  )
  const microphones = microphonePickerDevices(devices).filter(
    (device) => device.status === 'available'
  )

  // Auto-defaulting must never grab a window: with Screen Recording denied the
  // only enumerable "window" is the macOS login window, and building a capture
  // filter for it aborts the backend (SkyLight assert inside
  // SCContentFilter initWithDesktopIndependentWindow: — F-013). Windows are
  // only ever explicit, remembered user choices; the fallback is a display or
  // nothing, and the permission banners guide the user from there.
  const defaultCaptureDevice = selectableCaptureDevices.find((device) => device.kind === 'screen')
  // The dev diagnostic pattern deliberately replaces screen/window capture.
  // Device discovery keeps refreshing while the app is open; letting a later
  // snapshot auto-select a display makes the synthetic gate (and the visible
  // source picker) silently change underneath the operator.
  if (nextSources.testPattern) {
    nextSources.screenId = undefined
    nextSources.screenName = undefined
    nextSources.windowId = undefined
    nextSources.windowName = undefined
  } else {
    const selectedCapture = nextSources.windowId
      ? (findRememberedSource(
          nextSources.windowId,
          nextSources.windowName,
          selectableCaptureDevices
        ) ?? defaultCaptureDevice)
      : (findRememberedSource(
          nextSources.screenId,
          nextSources.screenName,
          selectableCaptureDevices
        ) ?? defaultCaptureDevice)
    nextSources.screenId = selectedCapture?.kind === 'screen' ? selectedCapture.id : undefined
    nextSources.screenName = selectedCapture?.kind === 'screen' ? selectedCapture.name : undefined
    nextSources.windowId = selectedCapture?.kind === 'window' ? selectedCapture.id : undefined
    nextSources.windowName = selectedCapture?.kind === 'window' ? selectedCapture.name : undefined
  }

  const selectedCamera =
    findRememberedSource(nextSources.cameraId, nextSources.cameraName, cameras) ?? cameras[0]
  // Migrate selections persisted onto the retired "Fallback - X" avfoundation
  // rows: drop the synthetic id when native rows exist and match the native
  // device by its unprefixed name instead of re-pinning the broken fallback.
  const nativeMicrophoneAvailable = microphones.some(
    (device) => !isAvFoundationMicrophoneId(device.id)
  )
  const rememberedMicrophoneId =
    nativeMicrophoneAvailable && isAvFoundationMicrophoneId(nextSources.microphoneId)
      ? undefined
      : nextSources.microphoneId
  const selectedMicrophone =
    findRememberedSource(
      rememberedMicrophoneId,
      nativeMicrophoneNameFor(nextSources.microphoneName),
      microphones
    ) ?? microphones[0]

  const cameraIdentity = sourceIdentityFor(selectedCamera)
  nextSources.cameraId = cameraIdentity.id
  nextSources.cameraName = cameraIdentity.name
  const microphoneIdentity = sourceIdentityFor(selectedMicrophone)
  nextSources.microphoneId = microphoneIdentity.id
  nextSources.microphoneName = microphoneIdentity.name

  return nextSources
}

/**
 * Layout commands revalidate at dispatch time because the device snapshot and
 * React config update on separate ticks. Without this final pass, a persisted
 * pre-DXGI Windows id can reach the backend after discovery already supplied a
 * valid replacement, triggering the native-compositor source blocker.
 */
export function reconcileSourceSelectionForLayoutTransaction(
  sources: SourceSelection,
  devices: Device[]
): SourceSelection {
  return reconcileSourceSelection(sources, devices)
}

export function sourceSelectionChangeEvents(
  previous: SourceSelection,
  next: SourceSelection
): AutomaticSourceFallbackEvent[] {
  const events = [
    sourceChangeEvent(
      'capture',
      previous.windowId ?? previous.screenId,
      previous.windowName ?? previous.screenName,
      next.windowId ?? next.screenId,
      next.windowName ?? next.screenName
    ),
    sourceChangeEvent(
      'camera',
      previous.cameraId,
      previous.cameraName,
      next.cameraId,
      next.cameraName
    ),
    sourceChangeEvent(
      'microphone',
      previous.microphoneId,
      previous.microphoneName,
      next.microphoneId,
      next.microphoneName
    )
  ]
  return events.filter((event): event is AutomaticSourceFallbackEvent => Boolean(event))
}

function sourceChangeEvent(
  sourceKind: AutomaticSourceFallbackSourceKind,
  previousId: string | undefined,
  previousName: string | undefined,
  nextId: string | undefined,
  nextName: string | undefined
): AutomaticSourceFallbackEvent | undefined {
  if (!previousId && !previousName) {
    return undefined
  }
  if (previousId === nextId && previousName === nextName) {
    return undefined
  }

  const event = {
    kind: 'automatic-source-fallback' as const,
    sourceKind,
    previousId,
    previousName,
    nextId,
    nextName
  }
  if (!nextId && !nextName) {
    return { ...event, reason: 'unavailable-cleared' }
  }

  if (previousName && previousName === nextName && previousId !== nextId) {
    return { ...event, reason: 'restored-by-name' }
  }
  return { ...event, reason: 'unavailable-selected' }
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
