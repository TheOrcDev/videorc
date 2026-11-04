import type { DiagnosticStats, StreamHealth, StreamTargetRuntime } from '@/lib/backend'

export type StreamHealthAttribution =
  | 'device'
  | 'audio'
  | 'capture'
  | 'render'
  | 'encoder'
  | 'fallback'
  | 'network'
  | 'preview'
  | 'healthy'
  | 'unknown'

/**
 * The problem in a few words, for the Livestream page's checklist and the
 * Studio's Stream fact (plan 174 S3.2): one wording on both surfaces.
 */
export function liveProblemLabel(attribution: StreamHealthAttribution): string {
  switch (attribution) {
    case 'device':
      return 'Capture device lost'
    case 'audio':
      return 'Audio dropping'
    case 'capture':
      return 'Capture running slow'
    case 'render':
      return 'Rendering slow'
    case 'encoder':
      return 'Encoder dropping frames'
    case 'fallback':
      return 'Encoder fallback'
    case 'network':
      return 'Delivery degraded'
    case 'preview':
      return 'Preview degraded'
    case 'healthy':
      return 'Healthy'
    default:
      return 'Checking…'
  }
}

const MIN_MEDIA_FPS_RATIO = 0.9
const MIN_ENCODER_SPEED = 0.98
const MIN_AUDIO_CAPTURE_COVERAGE = 0.95

/**
 * How long a drop keeps naming its stage after the last one (#981). The
 * diagnostics' drop counters are session totals, so the classifier reads
 * their growth, not their size: one frame dropped while a destination
 * reconnected must not read as "Encoder dropping frames" for the rest of the
 * stream. The Studio commits diagnostics about once a second, so ten seconds
 * is several samples: long enough to read, short enough to be current.
 */
export const RECENT_DROP_WINDOW_MS = 10_000

/** The stages whose drop counters the window watches. */
export type DropStage = 'audio' | 'capture' | 'encoder' | 'preview'

const DROP_STAGES: readonly DropStage[] = ['audio', 'capture', 'encoder', 'preview']

/** Whether each stage dropped something within the window. */
export type RecentStreamDrops = Readonly<Record<DropStage, boolean>>

export const NO_RECENT_DROPS: RecentStreamDrops = {
  audio: false,
  capture: false,
  encoder: false,
  preview: false
}

/**
 * What the window remembers between samples: the last value of every counter
 * and when each stage's counters last grew. Pure data, advanced per sample.
 */
export interface StreamDropActivity {
  sessionId: string | undefined
  /** The last seen value of each stage's counters, in `dropCounters` order. */
  totals: Readonly<Record<DropStage, readonly (number | undefined)[]>>
  /** When a stage's counters last grew, in ms since the epoch. */
  lastIncreaseAt: Readonly<Partial<Record<DropStage, number>>>
}

export function emptyStreamDropActivity(): StreamDropActivity {
  return {
    sessionId: undefined,
    totals: { audio: [], capture: [], encoder: [], preview: [] },
    lastIncreaseAt: {}
  }
}

/**
 * Folds one diagnostics sample into the window. A counter that grows marks
 * its stage as dropping now; one that first appears, or shrinks (a new run
 * reset it), only sets the new baseline. A new session starts over, so the
 * old session's totals never count against the new one.
 */
export function advanceStreamDropActivity(
  activity: StreamDropActivity,
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null,
  nowMs: number
): StreamDropActivity {
  const currentHealth = healthForDiagnosticSession(diagnosticStats, streamHealth)
  const sameSession = activity.sessionId === diagnosticStats.sessionId
  const totals = {} as Record<DropStage, readonly (number | undefined)[]>
  const lastIncreaseAt: Partial<Record<DropStage, number>> = sameSession
    ? { ...activity.lastIncreaseAt }
    : {}
  for (const stage of DROP_STAGES) {
    const counters = dropCounters(stage, diagnosticStats, currentHealth)
    const previous = sameSession ? activity.totals[stage] : []
    const grew = counters.some((count, index) => {
      const before = previous[index]
      return finite(before) && finite(count) && count > before
    })
    if (grew) {
      lastIncreaseAt[stage] = nowMs
    }
    totals[stage] = counters
  }
  return { sessionId: diagnosticStats.sessionId, totals, lastIncreaseAt }
}

/** Which stages dropped within the window as of `nowMs`. */
export function recentStreamDrops(activity: StreamDropActivity, nowMs: number): RecentStreamDrops {
  const recent = {} as Record<DropStage, boolean>
  for (const stage of DROP_STAGES) {
    const at = activity.lastIncreaseAt[stage]
    recent[stage] = at !== undefined && nowMs - at <= RECENT_DROP_WINDOW_MS
  }
  return recent
}

/** Every counter whose growth means the stage is dropping, per stage. */
function dropCounters(
  stage: DropStage,
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): readonly (number | undefined)[] {
  switch (stage) {
    case 'audio':
      return [diagnosticStats.micDroppedFrames]
    case 'capture':
      return [
        diagnosticStats.previewCameraDroppedFrames,
        diagnosticStats.previewScreenDroppedFrames
      ]
    case 'encoder':
      return [
        diagnosticStats.droppedFrames,
        streamHealth?.droppedFrames,
        diagnosticStats.encoderBridgeDroppedFrames,
        diagnosticStats.encoderBridgeOutputQueueDroppedFrames,
        diagnosticStats.encoderBridgeStreamQueueDroppedFrames,
        diagnosticStats.encoderBridgeEncodedOutputErrors,
        diagnosticStats.streamDuplicatedFrames,
        streamHealth?.duplicatedFrames
      ]
    case 'preview':
      return [diagnosticStats.previewDroppedFrames]
  }
}

/**
 * Attributes a live-output problem to the earliest known failing stage.
 *
 * This presentation classifier intentionally reads the backend's existing
 * diagnostics instead of inventing a second diagnostics state machine. Raw
 * metrics are checked as well so simultaneous failures still follow the
 * product precedence even when the backend's single bottleneck field can name
 * only one stage. Drop counters are read through `recentDrops` (#981): a
 * stage is dropping when its counters grew within the window, never because
 * a session total is above zero.
 */
export function classifyStreamHealthAttribution(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null,
  streamTargets: readonly StreamTargetRuntime[],
  recentDrops: RecentStreamDrops
): StreamHealthAttribution {
  const currentHealth = healthForDiagnosticSession(diagnosticStats, streamHealth)
  const targetFps = positiveFinite(diagnosticStats.targetFps ?? diagnosticStats.streamOutputFps)

  if (diagnosticStats.deviceDisconnected || diagnosticStats.bottleneck === 'device') {
    return 'device'
  }

  if (
    diagnosticStats.bottleneck === 'audio' ||
    recentDrops.audio ||
    (finite(diagnosticStats.micCaptureCoverage) &&
      diagnosticStats.micCaptureCoverage < MIN_AUDIO_CAPTURE_COVERAGE)
  ) {
    return 'audio'
  }

  if (
    diagnosticStats.bottleneck === 'capture' ||
    belowTargetFps(diagnosticStats.captureFps, targetFps)
  ) {
    return 'capture'
  }

  if (
    diagnosticStats.bottleneck === 'render' ||
    belowTargetFps(diagnosticStats.renderFps, targetFps)
  ) {
    return 'render'
  }

  if (hasEncoderProblem(diagnosticStats, recentDrops)) {
    return 'encoder'
  }

  if (hasAcknowledgedEncoderFallback(diagnosticStats)) {
    return 'fallback'
  }

  // Delivery trouble is what the destinations report (#981). The measured
  // bitrate is what the encoder produced, and a static screen encodes far
  // below the configured rate on purpose, so it is never read as delivery.
  const mediaStagesHealthy = hasHealthyMediaEvidence(diagnosticStats, currentHealth)
  if (mediaStagesHealthy && hasTargetNetworkProblem(streamTargets)) {
    return 'network'
  }

  if (diagnosticStats.bottleneck === 'preview' || recentDrops.preview) {
    return 'preview'
  }

  return mediaStagesHealthy ? 'healthy' : 'unknown'
}

function healthForDiagnosticSession(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): StreamHealth | null {
  if (
    streamHealth &&
    diagnosticStats.sessionId &&
    diagnosticStats.sessionId !== streamHealth.sessionId
  ) {
    return null
  }
  return streamHealth
}

function hasEncoderProblem(
  diagnosticStats: DiagnosticStats,
  recentDrops: RecentStreamDrops
): boolean {
  return (
    diagnosticStats.bottleneck === 'encoder' ||
    (finite(diagnosticStats.encoderSpeed) && diagnosticStats.encoderSpeed < MIN_ENCODER_SPEED) ||
    recentDrops.encoder ||
    Boolean(diagnosticStats.encoderBridgeError?.trim())
  )
}

function hasAcknowledgedEncoderFallback(diagnosticStats: DiagnosticStats): boolean {
  const requested = diagnosticStats.encoderBridgeRequestedVideoOutput?.trim()
  const effective = diagnosticStats.encoderBridgeEffectiveVideoOutput?.trim()
  const reason = diagnosticStats.encoderBridgeEncodedOutputFallbackReason?.trim()
  return Boolean(requested && effective && requested !== effective && reason)
}

function hasTargetNetworkProblem(streamTargets: readonly StreamTargetRuntime[]): boolean {
  return streamTargets.some(
    (target) =>
      target.state === 'failed' ||
      target.state === 'warning' ||
      target.state === 'reconnecting' ||
      /\breconnect(?:ed|ing)?\b/i.test(target.message ?? '')
  )
}

function hasHealthyMediaEvidence(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): boolean {
  if (diagnosticStats.bottleneck !== 'none' && diagnosticStats.bottleneck !== 'preview') {
    return false
  }

  return [
    diagnosticStats.captureFps,
    diagnosticStats.renderFps,
    diagnosticStats.encoderSpeed,
    diagnosticStats.encoderBridgeInputFps,
    diagnosticStats.encoderBridgeStreamInputFps,
    diagnosticStats.streamMeasuredBitrateKbps,
    streamHealth?.fps,
    streamHealth?.speed,
    streamHealth?.bitrateKbps,
    streamHealth?.droppedFrames,
    streamHealth?.totalBytes,
    streamHealth?.duplicatedFrames
  ].some(finite)
}

function belowTargetFps(actualFps: number | undefined, targetFps: number | undefined): boolean {
  return finite(actualFps) && targetFps !== undefined && actualFps < targetFps * MIN_MEDIA_FPS_RATIO
}

function positiveFinite(value: number | undefined): number | undefined {
  return finite(value) && value > 0 ? value : undefined
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
