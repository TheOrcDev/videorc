import type { DiagnosticStats, StreamHealth, StreamTargetRuntime } from '@/lib/backend'
import {
  finite,
  healthForDiagnosticSession,
  type RecentStreamDrops
} from '@/lib/stream-drop-activity'

export type StreamHealthAttribution =
  | 'device'
  | 'audio'
  | 'choppy'
  | 'uplink'
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
    case 'choppy':
      return 'Stream skipping frames'
    case 'uplink':
      return 'Connection too slow'
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
 * How long a destination's fifo overflow keeps the stream on "Connection too
 * slow" (plan 218). The backend warns about one leg at most once a minute,
 * so a minute covers the gap between two overflows of a leg that keeps
 * falling behind.
 */
export const RECENT_UPLINK_OVERFLOW_WINDOW_MS = 60_000

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
  recentDrops: RecentStreamDrops,
  nowMs: number = Date.now()
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

  // Plan 218: the backend's own verdicts on what the stream sends rank above
  // the inferred stages below. A static screen idles, so the single
  // bottleneck field reads "capture" while the stream skips frames for an
  // unrelated reason, and the streamer was pointed at their capture. Slow
  // capture repeats frames; it can never set either of these.
  if (diagnosticStats.streamDelivery?.degraded) {
    return 'choppy'
  }

  if (hasUplinkShortfall(diagnosticStats, streamTargets, nowMs)) {
    return 'uplink'
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

/**
 * The connection cannot carry the stream (plan 218): Videorc lowered the
 * stream's bitrate to fit it, the bitrate sits at its floor, or a
 * destination's fifo overflowed within the last minute.
 */
function hasUplinkShortfall(
  diagnosticStats: DiagnosticStats,
  streamTargets: readonly StreamTargetRuntime[],
  nowMs: number
): boolean {
  const delivery = diagnosticStats.streamDelivery
  if (delivery?.atFloor) {
    return true
  }
  const bitrateKbps = delivery?.bitrateKbps
  const chosenBitrateKbps = delivery?.chosenBitrateKbps
  if (finite(bitrateKbps) && finite(chosenBitrateKbps) && bitrateKbps < chosenBitrateKbps) {
    return true
  }
  return streamTargets.some((target) => {
    if (!target.uplinkOverflows || !target.uplinkOverflowAt) return false
    const at = Date.parse(target.uplinkOverflowAt)
    return Number.isFinite(at) && nowMs - at <= RECENT_UPLINK_OVERFLOW_WINDOW_MS
  })
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
