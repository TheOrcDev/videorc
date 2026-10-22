import type { StatusTone } from '@/components/status-badge'
import type {
  DiagnosticBottleneck,
  DiagnosticStats,
  HealthEvent,
  PreviewCameraStatus,
  PreviewLiveStatus,
  PreviewScreenStatus,
  PreviewSurfaceStatus,
  RecordingPipelineStage,
  RecordingPipelineStageState,
  StreamTargetRuntime,
  SystemPermissionPane
} from '@/lib/backend'
import { NO_VALUE, formatMetric, plural } from '@/lib/format'
import { previewSourceStateLabel, previewStateLabel } from '@/lib/state-labels'
import { statusWordFromValue } from '@/lib/status-word'
import { isNativePreviewCapability } from '../../../shared/native-preview-capability'

// Health's checks and verdict (plan 174 S3.18, I-4, I-25, V-7). Every check
// is a word in sentence case and a tone. Amber and red need the streamer;
// neutral is a state in passing (starting, measuring, idle) and never counts
// against the verdict. The page leads with one verdict built from them, shows
// only the checks that need attention, and keeps the rest behind "Show all
// checks". Pure, so the words are pinned by tests.

export type HealthCheckId =
  | 'recording'
  | 'slowdown'
  | 'encoder'
  | 'rendering'
  | 'sources'
  | 'camera'
  | 'screen'
  | 'preview'
  | 'preview-speed'
  | 'preview-path'
  | 'destinations'
  | 'memory'
  | 'file-repair'

/** One Health check: what it looks at, its state in words, and its tone. */
export interface HealthCheck {
  id: HealthCheckId
  label: string
  value: string
  tone: StatusTone
}

type CheckWords = Pick<HealthCheck, 'value' | 'tone'>

/** Amber or red: the check needs the streamer. Neutral never does. */
export function checkNeedsAttention(check: Pick<HealthCheck, 'tone'>): boolean {
  return check.tone === 'warn' || check.tone === 'error'
}

/** "12.5 MiB", "300 KiB", or the placeholder. */
export function formatBytes(value?: number): string {
  if (typeof value !== 'number') {
    return NO_VALUE
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KiB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

/** The part of the pipeline the backend measured as the slowest. */
export function slowdownCheck(bottleneck: DiagnosticBottleneck): CheckWords {
  switch (bottleneck) {
    case 'audio':
      return { value: 'Microphone', tone: 'warn' }
    case 'capture':
      return { value: 'Capture', tone: 'warn' }
    case 'render':
      return { value: 'Rendering', tone: 'warn' }
    case 'encoder':
      return { value: 'Encoder', tone: 'warn' }
    case 'preview':
      return { value: 'Preview', tone: 'warn' }
    case 'device':
      return { value: 'Device', tone: 'error' }
    case 'unknown':
      return { value: 'Measuring…', tone: 'neutral' }
    default:
      return { value: 'None found', tone: 'good' }
  }
}

/** What to do about a slowdown, in one or two sentences; null when nothing is slow. */
export function slowdownAdvice(bottleneck: DiagnosticBottleneck): string | null {
  switch (bottleneck) {
    case 'encoder':
      return 'Videorc is encoding slower than real time. Lower the bitrate or the resolution if your video looks laggy.'
    case 'capture':
    case 'render':
      return "Capture isn't keeping up with the frame rate. Lower the resolution or close heavy apps if your video looks laggy."
    case 'audio':
      return 'The microphone dropped audio. Check it in Sources, or close heavy apps.'
    case 'preview':
      return "The preview dropped frames. Your recording isn't affected."
    case 'device':
      return 'A capture device stopped responding. Check its cable, then choose it again in Sources.'
    default:
      return null
  }
}

/** The advice when the recording is at risk and no slowdown explains it. */
export const RECORDING_AT_RISK_ADVICE =
  'Your recording may stutter or have gaps. Technical details below say why.'

export function recordingCheck(stats: DiagnosticStats): CheckWords {
  if (stats.recordingAtRisk) {
    return { value: 'At risk', tone: 'error' }
  }
  if (stats.recordingProtected) {
    return { value: 'Protected', tone: 'good' }
  }
  if (stats.activeOutputMode) {
    return { value: 'Active', tone: 'good' }
  }
  return { value: 'Idle', tone: 'neutral' }
}

export function encoderCheck(
  stats: DiagnosticStats,
  streamHealth: { speed?: number; droppedFrames?: number } | null
): CheckWords {
  const speed = stats.encoderSpeed ?? streamHealth?.speed
  const drops = stats.droppedFrames || streamHealth?.droppedFrames || 0
  if (drops > 0) {
    return { value: plural(drops, 'dropped frame'), tone: 'warn' }
  }
  if (typeof speed === 'number') {
    return { value: `${speed.toFixed(2)}×`, tone: speed < 0.98 ? 'warn' : 'good' }
  }
  return { value: 'Idle', tone: 'neutral' }
}

export function renderingCheck(stats: DiagnosticStats): CheckWords {
  const targetFps = stats.targetFps ?? stats.previewTargetFps
  if (targetFps) {
    const frameBudgetMs = 1000 / Math.max(1, targetFps)
    if (
      typeof stats.compositorTickGapP95Ms === 'number' &&
      stats.compositorTickGapP95Ms > frameBudgetMs * 1.5
    ) {
      return { value: 'Uneven frames', tone: 'warn' }
    }
    if (
      typeof stats.compositorTickGapMaxMs === 'number' &&
      stats.compositorTickGapMaxMs > frameBudgetMs * 3
    ) {
      return { value: 'Frame spikes', tone: 'warn' }
    }
  }
  if (stats.renderFps && stats.targetFps && stats.renderFps < stats.targetFps * 0.9) {
    return { value: 'Below frame rate', tone: 'warn' }
  }
  if (stats.previewRenderFrameTimeP95Ms && stats.previewTargetFps) {
    const frameBudgetMs = 1000 / Math.max(1, stats.previewTargetFps)
    if (stats.previewRenderFrameTimeP95Ms > frameBudgetMs * 1.5) {
      return { value: 'Slow frames', tone: 'warn' }
    }
  }
  return stats.renderFps
    ? { value: formatMetric(stats.renderFps, 'fps'), tone: 'good' }
    : { value: 'Idle', tone: 'neutral' }
}

export function sourcesCheck(
  stats: DiagnosticStats,
  camera: Pick<PreviewCameraStatus, 'droppedFrames'>,
  screen: Pick<PreviewScreenStatus, 'droppedFrames'>
): CheckWords {
  if (stats.deviceDisconnected) {
    return { value: 'Device disconnected', tone: 'error' }
  }
  if (stats.duplicateCaptureSources.length) {
    return { value: 'Captured twice', tone: 'warn' }
  }
  if (
    stats.previewCameraDroppedFrames > 0 ||
    stats.previewScreenDroppedFrames > 0 ||
    camera.droppedFrames > 0 ||
    screen.droppedFrames > 0
  ) {
    return { value: 'Dropping frames', tone: 'warn' }
  }
  if (stats.captureFps && stats.targetFps && stats.captureFps < stats.targetFps * 0.9) {
    return { value: 'Capture slow', tone: 'warn' }
  }
  return { value: 'Healthy', tone: 'good' }
}

/** The camera's or the screen's preview source. "Not running" is idle (plan 173), never a fault. */
export function previewSourceCheck(
  state: PreviewCameraStatus['state'] | PreviewScreenStatus['state']
): CheckWords {
  const value = previewSourceStateLabel(state)
  if (state === 'live') {
    return { value, tone: 'good' }
  }
  if (state === 'permission-needed' || state === 'failed') {
    return { value, tone: 'error' }
  }
  return { value, tone: 'neutral' }
}

export function previewCheck(
  live: Pick<PreviewLiveStatus, 'state'>,
  camera: Pick<PreviewCameraStatus, 'state'>,
  screen: Pick<PreviewScreenStatus, 'state'>
): CheckWords {
  const value = previewStateLabel(live.state)
  if (camera.state === 'permission-needed' || screen.state === 'permission-needed') {
    return { value: 'Needs permission', tone: 'error' }
  }
  if (live.state === 'live') {
    return { value, tone: 'good' }
  }
  // Connecting and reconnecting are in passing; only a preview that can't run needs a look.
  return { value, tone: live.state === 'unavailable' ? 'warn' : 'neutral' }
}

export type PreviewSpeedInput = {
  diagnosticStats: DiagnosticStats
  expectsCamera: boolean
  expectsScreen: boolean
  nativePreviewSurfaceEnabled: boolean
  platform: string
  previewCameraStatus: PreviewCameraStatus
  previewLiveStatus: PreviewLiveStatus
  previewScreenStatus: PreviewScreenStatus
  previewSurfaceStatus: PreviewSurfaceStatus
}

/** Why the preview isn't smooth, if it isn't. */
export function previewSpeedCheck({
  diagnosticStats,
  expectsCamera,
  expectsScreen,
  nativePreviewSurfaceEnabled,
  platform,
  previewCameraStatus,
  previewLiveStatus,
  previewScreenStatus,
  previewSurfaceStatus
}: PreviewSpeedInput): CheckWords {
  const syntheticNativeSurface =
    nativePreviewSurfaceEnabled && previewSurfaceStatus.source === 'synthetic'
  const shouldCheckCamera = expectsCamera && !syntheticNativeSurface
  const shouldCheckScreen = expectsScreen && !syntheticNativeSurface
  if (
    (shouldCheckCamera && previewCameraStatus.state === 'permission-needed') ||
    (shouldCheckScreen && previewScreenStatus.state === 'permission-needed')
  ) {
    return { value: 'Needs permission', tone: 'error' }
  }
  if (shouldCheckCamera && previewCameraStatus.state === 'failed') {
    return { value: 'Camera failed', tone: 'error' }
  }
  if (shouldCheckScreen && previewScreenStatus.state === 'failed') {
    return { value: 'Screen failed', tone: 'error' }
  }
  const unavailable = diagnosticStats.previewTransport === 'unavailable'
  if (!nativePreviewSurfaceEnabled) {
    return { value: 'Fallback', tone: unavailable ? 'neutral' : 'warn' }
  }
  if (diagnosticStats.previewTransport === 'electron-proof-surface') {
    return { value: 'Fallback', tone: 'warn' }
  }
  if (
    !isNativePreviewCapability(
      {
        transport: diagnosticStats.previewTransport,
        backing: diagnosticStats.previewSurfaceBacking,
        nativePreviewHostKind: previewSurfaceStatus.nativePreviewHostKind
      },
      platform
    )
  ) {
    return { value: 'Fallback', tone: unavailable ? 'neutral' : 'warn' }
  }

  const targetFps = diagnosticStats.previewTargetFps ?? previewSurfaceStatus.targetFps
  const minimumSourceFps = targetFps * 0.9
  if (
    shouldCheckCamera &&
    previewCameraStatus.state === 'live' &&
    typeof previewCameraStatus.sourceFps === 'number' &&
    previewCameraStatus.sourceFps < minimumSourceFps
  ) {
    return { value: 'Camera slow', tone: 'warn' }
  }
  if (
    shouldCheckScreen &&
    previewScreenStatus.state === 'live' &&
    typeof previewScreenStatus.sourceFps === 'number' &&
    previewScreenStatus.sourceFps < minimumSourceFps
  ) {
    return { value: 'Screen slow', tone: 'warn' }
  }
  if (
    typeof diagnosticStats.previewRenderFrameTimeP95Ms === 'number' &&
    diagnosticStats.previewRenderFrameTimeP95Ms > (1000 / Math.max(1, targetFps)) * 1.5
  ) {
    return { value: 'Slow rendering', tone: 'warn' }
  }
  if (
    typeof diagnosticStats.previewPresentFps === 'number' &&
    diagnosticStats.previewPresentFps < minimumSourceFps
  ) {
    return { value: 'Slow display', tone: 'warn' }
  }
  if (
    diagnosticStats.previewDroppedFrames > 0 ||
    diagnosticStats.previewRepeatedFrames > targetFps ||
    (typeof diagnosticStats.previewCompositorFrameLag === 'number' &&
      diagnosticStats.previewCompositorFrameLag > 2) ||
    (typeof diagnosticStats.previewInputToPresentLatencyP95Ms === 'number' &&
      diagnosticStats.previewInputToPresentLatencyP95Ms > 50) ||
    (typeof diagnosticStats.previewInputToPresentLatencyMs === 'number' &&
      diagnosticStats.previewInputToPresentLatencyMs > 150)
  ) {
    return { value: 'App busy', tone: 'warn' }
  }
  if (previewLiveStatus.state !== 'live') {
    return { value: 'Measuring…', tone: 'neutral' }
  }
  return { value: 'Smooth', tone: 'good' }
}

/**
 * How the preview reaches the screen. Only the platform's own Metal or D3D11
 * presenter is "Native"; the browser window the Windows build presents
 * through stays a named fallback, never native (AGENTS.md, native preview).
 */
export function previewPathCheck(
  transport?: string,
  backing?: string,
  hostKind?: PreviewSurfaceStatus['nativePreviewHostKind'],
  platform = 'darwin'
): CheckWords {
  if (
    transport &&
    backing &&
    isNativePreviewCapability(
      {
        transport: transport as DiagnosticStats['previewTransport'],
        backing: backing as DiagnosticStats['previewSurfaceBacking'],
        nativePreviewHostKind: hostKind
      },
      platform
    )
  ) {
    return { value: 'Native', tone: 'good' }
  }
  switch (transport) {
    case 'native-surface':
    case 'd3d11-shared-texture':
      return { value: 'Native, unconfirmed', tone: 'warn' }
    case 'electron-proof-surface':
      return { value: 'Fallback window', tone: 'warn' }
    case 'latest-jpeg-polling':
      return { value: 'Fallback (JPEG)', tone: 'warn' }
    case 'mjpeg-stream':
      return { value: 'Fallback (MJPEG)', tone: 'warn' }
    default:
      return { value: 'Off', tone: 'neutral' }
  }
}

export function destinationsCheck(targets: readonly StreamTargetRuntime[]): CheckWords {
  if (!targets.length) {
    return { value: 'Idle', tone: 'neutral' }
  }
  const count = (state: StreamTargetRuntime['state']): number =>
    targets.filter((target) => target.state === state).length
  const failed = count('failed')
  if (failed) {
    return { value: `${failed} failed`, tone: 'warn' }
  }
  const reconnecting = count('reconnecting')
  if (reconnecting) {
    return { value: `${reconnecting} reconnecting`, tone: 'warn' }
  }
  const notReceiving = count('warning')
  if (notReceiving) {
    return { value: `${notReceiving} not receiving`, tone: 'warn' }
  }
  const onAir = count('live')
  if (onAir) {
    return { value: `${onAir} of ${targets.length} on air`, tone: 'good' }
  }
  const connecting = count('connecting')
  if (connecting) {
    return { value: `${connecting} connecting`, tone: 'neutral' }
  }
  return { value: 'Ready', tone: 'neutral' }
}

export function memoryCheck(bytes?: number): CheckWords {
  if (typeof bytes !== 'number') {
    return { value: NO_VALUE, tone: 'neutral' }
  }
  const mib = bytes / (1024 * 1024)
  return { value: formatBytes(bytes), tone: mib >= 2048 ? 'error' : mib >= 1024 ? 'warn' : 'good' }
}

/** The one Repair check: background work that fixes recordings. Running is in passing, never amber. */
export function fileRepairCheck(
  stats: Pick<
    DiagnosticStats,
    | 'ffmpegMaintenanceCancelRequested'
    | 'ffmpegMaintenanceRunning'
    | 'ffmpegMaintenanceDeferredReason'
  >
): CheckWords {
  if (stats.ffmpegMaintenanceCancelRequested) {
    return { value: 'Canceling…', tone: 'neutral' }
  }
  if (stats.ffmpegMaintenanceRunning) {
    return { value: 'Running', tone: 'neutral' }
  }
  if (stats.ffmpegMaintenanceDeferredReason) {
    return { value: 'Waiting', tone: 'neutral' }
  }
  return { value: 'Idle', tone: 'good' }
}

export type HealthChecksInput = PreviewSpeedInput & {
  streamHealth: { speed?: number; droppedFrames?: number } | null
  streamTargets: readonly StreamTargetRuntime[]
}

/** Every check, in the order "Show all checks" lists them. */
export function healthChecks(input: HealthChecksInput): HealthCheck[] {
  const {
    diagnosticStats: stats,
    previewCameraStatus,
    previewScreenStatus,
    previewLiveStatus,
    previewSurfaceStatus,
    platform
  } = input
  const check = (id: HealthCheckId, label: string, words: CheckWords): HealthCheck => ({
    id,
    label,
    ...words
  })
  return [
    check('recording', 'Recording', recordingCheck(stats)),
    check('slowdown', 'Slowdown', slowdownCheck(stats.bottleneck)),
    check('encoder', 'Encoder', encoderCheck(stats, input.streamHealth)),
    check('rendering', 'Rendering', renderingCheck(stats)),
    check('sources', 'Sources', sourcesCheck(stats, previewCameraStatus, previewScreenStatus)),
    check('camera', 'Camera', previewSourceCheck(previewCameraStatus.state)),
    check('screen', 'Screen', previewSourceCheck(previewScreenStatus.state)),
    check(
      'preview',
      'Preview',
      previewCheck(previewLiveStatus, previewCameraStatus, previewScreenStatus)
    ),
    check('preview-speed', 'Preview speed', previewSpeedCheck(input)),
    check(
      'preview-path',
      'Preview path',
      previewPathCheck(
        stats.previewTransport,
        stats.previewSurfaceBacking,
        previewSurfaceStatus.nativePreviewHostKind,
        platform
      )
    ),
    check('destinations', 'Destinations', destinationsCheck(input.streamTargets)),
    check('memory', 'Memory', memoryCheck(stats.backendRssBytes)),
    check('file-repair', 'File repair', fileRepairCheck(stats))
  ]
}

export interface HealthVerdict {
  variant: 'success' | 'warning' | 'destructive'
  /** "Everything looks healthy", or "2 things need attention: Encoder, Camera permission". */
  title: string
  /** What to do, in whole sentences; null when there is nothing to add. */
  description: string | null
}

/**
 * The one answer Health leads with. `warnings` names the actionable warnings
 * below it ("Camera permission"); they count like the checks. Red when a
 * check is red, amber otherwise.
 */
export function healthVerdict({
  checks,
  warnings = [],
  advice = null
}: {
  checks: readonly HealthCheck[]
  warnings?: readonly string[]
  advice?: string | null
}): HealthVerdict {
  const attention = checks.filter(checkNeedsAttention)
  const names = [...warnings, ...attention.map((check) => check.label)]
  if (!names.length) {
    return { variant: 'success', title: 'Everything looks healthy', description: null }
  }
  const verb = names.length === 1 ? 'needs' : 'need'
  return {
    variant: attention.some((check) => check.tone === 'error') ? 'destructive' : 'warning',
    title: `${plural(names.length, 'thing')} ${verb} attention: ${names.join(', ')}`,
    description: advice
  }
}

/** One permission the streamer can fix from Health, from every event that asked for it. */
export interface PermissionWarning {
  pane: SystemPermissionPane
  /** Every event behind it, so Dismiss hides them all; a later event shows it again. */
  eventIds: string[]
  /** When it was last reported. */
  createdAt: string
}

/**
 * The actionable warnings: one per permission, never one per event (a
 * camera that fails ten times asks once). Only events with a fix left to do
 * (`hasAction`) that the streamer has not dismissed.
 */
export function permissionWarnings(
  events: readonly Pick<HealthEvent, 'id' | 'permissionPane' | 'createdAt'>[],
  hasAction: (pane: SystemPermissionPane) => boolean,
  dismissed: ReadonlySet<string>
): PermissionWarning[] {
  const byPane = new Map<SystemPermissionPane, PermissionWarning>()
  for (const event of events) {
    const pane = event.permissionPane
    if (!pane || dismissed.has(event.id) || !hasAction(pane)) continue
    const current = byPane.get(pane)
    if (!current) {
      byPane.set(pane, { pane, eventIds: [event.id], createdAt: event.createdAt })
      continue
    }
    current.eventIds.push(event.id)
    if (event.createdAt > current.createdAt) current.createdAt = event.createdAt
  }
  return [...byPane.values()]
}

const PIPELINE_STAGE_LABELS: Record<RecordingPipelineStage, string> = {
  capture: 'Capture',
  render: 'Rendering',
  'video-encoder': 'Video encoder',
  'audio-encoder': 'Audio encoder',
  muxer: 'File writer'
}

/** A recording pipeline stage's name in words. */
export function pipelineStageLabel(stage: RecordingPipelineStage): string {
  return PIPELINE_STAGE_LABELS[stage] ?? sentenceCase(stage)
}

const PIPELINE_STATE_WORDS: Record<RecordingPipelineStageState, CheckWords> = {
  pending: { value: 'Waiting', tone: 'neutral' },
  starting: { value: 'Starting…', tone: 'neutral' },
  running: { value: 'Running', tone: 'good' },
  finalizing: { value: 'Finishing…', tone: 'neutral' },
  finished: { value: 'Finished', tone: 'good' },
  failed: { value: 'Failed', tone: 'error' },
  skipped: { value: 'Skipped', tone: 'neutral' }
}

/** A stage's state as a word and a tone: transitional states are neutral, not amber. */
export function pipelineStateWords(state: RecordingPipelineStageState): CheckWords {
  return PIPELINE_STATE_WORDS[state] ?? { value: sentenceCase(state), tone: 'neutral' }
}

/** A log line's level as a word: "Info", "Warning", "Error". */
export function logLevelLabel(level: string): string {
  switch (level) {
    case 'info':
      return 'Info'
    case 'warn':
      return 'Warning'
    case 'error':
      return 'Error'
    default:
      return sentenceCase(level)
  }
}

/** "Showing the last 120 of 342 lines.", or null when nothing was cut. */
export function logTruncationNote(shown: number, total: number): string | null {
  return total > shown
    ? `Showing the last ${shown.toLocaleString()} of ${plural(total, 'line')}.`
    : null
}

function sentenceCase(value: string): string {
  return statusWordFromValue(value) || NO_VALUE
}
