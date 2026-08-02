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

const MIN_MEDIA_FPS_RATIO = 0.9
const MIN_ENCODER_SPEED = 0.98
const MIN_AUDIO_CAPTURE_COVERAGE = 0.95
const MIN_DELIVERED_BITRATE_RATIO = 0.9

/**
 * Attributes a live-output problem to the earliest known failing stage.
 *
 * This presentation classifier intentionally reads the backend's existing
 * diagnostics instead of inventing a second diagnostics state machine. Raw
 * metrics are checked as well so simultaneous failures still follow the
 * product precedence even when the backend's single bottleneck field can name
 * only one stage.
 */
export function classifyStreamHealthAttribution(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null,
  streamTargets: readonly StreamTargetRuntime[]
): StreamHealthAttribution {
  const currentHealth = healthForDiagnosticSession(diagnosticStats, streamHealth)
  const targetFps = positiveFinite(diagnosticStats.targetFps ?? diagnosticStats.streamOutputFps)

  if (diagnosticStats.deviceDisconnected || diagnosticStats.bottleneck === 'device') {
    return 'device'
  }

  if (
    diagnosticStats.bottleneck === 'audio' ||
    diagnosticStats.micDroppedFrames > 0 ||
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

  if (hasEncoderProblem(diagnosticStats, currentHealth)) {
    return 'encoder'
  }

  if (hasAcknowledgedEncoderFallback(diagnosticStats)) {
    return 'fallback'
  }

  const mediaStagesHealthy = hasHealthyMediaEvidence(diagnosticStats, currentHealth)
  if (
    mediaStagesHealthy &&
    (hasTargetNetworkProblem(streamTargets) ||
      hasLowDeliveredBitrate(diagnosticStats, currentHealth))
  ) {
    return 'network'
  }

  if (diagnosticStats.bottleneck === 'preview' || diagnosticStats.previewDroppedFrames > 0) {
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
  streamHealth: StreamHealth | null
): boolean {
  return (
    diagnosticStats.bottleneck === 'encoder' ||
    (finite(diagnosticStats.encoderSpeed) && diagnosticStats.encoderSpeed < MIN_ENCODER_SPEED) ||
    diagnosticStats.droppedFrames > 0 ||
    (streamHealth?.droppedFrames ?? 0) > 0 ||
    diagnosticStats.encoderBridgeDroppedFrames > 0 ||
    diagnosticStats.encoderBridgeOutputQueueDroppedFrames > 0 ||
    diagnosticStats.encoderBridgeStreamQueueDroppedFrames > 0 ||
    (diagnosticStats.encoderBridgeEncodedOutputErrors ?? 0) > 0 ||
    Boolean(diagnosticStats.encoderBridgeError?.trim()) ||
    (diagnosticStats.streamDuplicatedFrames ?? 0) > 0 ||
    (streamHealth?.duplicatedFrames ?? 0) > 0
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
      /\breconnect(?:ed|ing)?\b/i.test(target.message ?? '')
  )
}

function hasLowDeliveredBitrate(
  diagnosticStats: DiagnosticStats,
  streamHealth: StreamHealth | null
): boolean {
  const configuredBitrate = positiveFinite(diagnosticStats.streamOutputBitrateKbps)
  const measuredBitrate = nonNegativeFinite(
    streamHealth?.bitrateKbps ?? diagnosticStats.streamMeasuredBitrateKbps
  )
  return (
    configuredBitrate !== undefined &&
    measuredBitrate !== undefined &&
    measuredBitrate < configuredBitrate * MIN_DELIVERED_BITRATE_RATIO
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

function nonNegativeFinite(value: number | undefined): number | undefined {
  return finite(value) && value >= 0 ? value : undefined
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
