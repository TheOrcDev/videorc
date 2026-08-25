import { extname } from 'node:path'

export const TRANSIENT_FIFO_PAUSE_FIRED_MARKER = 'VIDEORC_TEST_VT_FIFO_PAUSE_FIRED'

const INCIDENT_QUEUE_CAPACITY_FRAMES = 16
const INCIDENT_QUEUE_MAX_AGE_MS = 250
const INCIDENT_OLDEST_FRAME_AGE_MS = 528
const INCIDENT_MAX_PRE_ENCODE_SKIPPED_FRAMES = INCIDENT_QUEUE_CAPACITY_FRAMES

export function countTransientFifoPauseMarkers(line) {
  if (typeof line !== 'string' || line.length === 0) return 0
  return line.split(TRANSIENT_FIFO_PAUSE_FIRED_MARKER).length - 1
}

export function evaluateTransientFifoPressure({
  activeStatus,
  stoppedStatus,
  diagnostics,
  qualityMetrics,
  testPauseFiredCount,
  cleanFfmpegExitCount
}) {
  const failures = []
  if (testPauseFiredCount !== 1) {
    failures.push(
      `transient FIFO test pause hook fired ${testPauseFiredCount ?? 'unknown'} time(s); ` +
        'expected exactly once'
    )
  }
  if (cleanFfmpegExitCount !== 1) {
    failures.push(
      `transient FIFO FFmpeg exit-code-0 health event appeared ` +
        `${cleanFfmpegExitCount ?? 'unknown'} time(s); expected exactly once`
    )
  }
  if (activeStatus?.state !== 'recording') {
    failures.push(
      `recording stopped before user stop during transient FIFO pressure ` +
        `(state=${activeStatus?.state ?? 'missing'}; ${activeStatus?.message ?? 'no message'})`
    )
  }
  if (stoppedStatus?.state !== 'idle') {
    failures.push(
      `transient FIFO pressure session did not return to idle after user stop ` +
        `(state=${stoppedStatus?.state ?? 'missing'})`
    )
  }
  if (extname(stoppedStatus?.outputPath ?? '').toLowerCase() !== '.mp4') {
    failures.push(
      `transient FIFO pressure session did not produce a finalized MP4 ` +
        `(path=${stoppedStatus?.outputPath ?? 'missing'})`
    )
  }
  if (!(diagnostics?.encoderBridgeOutputQueueCapacityPressureEvents > 0)) {
    failures.push('transient FIFO pressure pass did not exercise FIFO pressure')
  }
  if (diagnostics?.encoderBridgeOutputQueueHighWaterFrames !== INCIDENT_QUEUE_CAPACITY_FRAMES) {
    failures.push(
      `transient FIFO pressure did not reproduce exact depth ` +
        `${diagnostics?.encoderBridgeOutputQueueHighWaterFrames ?? 'missing'}/` +
        `${INCIDENT_QUEUE_CAPACITY_FRAMES}`
    )
  }
  if (
    !(
      diagnostics?.encoderBridgeOutputQueueOldestFrameAgeHighWaterMs >= INCIDENT_OLDEST_FRAME_AGE_MS
    )
  ) {
    failures.push(
      `transient FIFO pressure did not reproduce oldest >=${INCIDENT_OLDEST_FRAME_AGE_MS}/` +
        `${INCIDENT_QUEUE_MAX_AGE_MS}ms ` +
        `(high-water=${
          diagnostics?.encoderBridgeOutputQueueOldestFrameAgeHighWaterMs ?? 'missing'
        }ms)`
    )
  }
  if (!(diagnostics?.encoderBridgeOutputPressureRecoveryEvents > 0)) {
    failures.push('transient FIFO pressure produced no pressure recovery transition')
  }
  const preEncodeSkippedFrames = diagnostics?.encoderBridgeOutputPreEncodeSkippedFrames
  if (!(Number.isInteger(preEncodeSkippedFrames) && preEncodeSkippedFrames > 0)) {
    failures.push('transient FIFO pressure produced no bounded pre-encode frame skips')
  } else if (preEncodeSkippedFrames > INCIDENT_MAX_PRE_ENCODE_SKIPPED_FRAMES) {
    failures.push(
      `transient FIFO pressure skipped ${preEncodeSkippedFrames} pre-encode frames; ` +
        `expected at most ${INCIDENT_MAX_PRE_ENCODE_SKIPPED_FRAMES}`
    )
  }
  const expectedFrames = qualityMetrics?.expectedFrames
  const observedFrames = qualityMetrics?.observedFrames
  if (!(Number.isInteger(expectedFrames) && Number.isInteger(observedFrames))) {
    failures.push('transient FIFO pressure artifact frame-count evidence was missing')
  } else if (
    Number.isInteger(preEncodeSkippedFrames) &&
    Math.abs(expectedFrames - observedFrames - preEncodeSkippedFrames) > 1
  ) {
    failures.push(
      `transient FIFO pressure artifact gap ${expectedFrames - observedFrames} did not match ` +
        `${preEncodeSkippedFrames} pre-encode skips`
    )
  }
  if ((diagnostics?.encoderBridgeOutputQueueDroppedFrames ?? 0) !== 0) {
    failures.push(
      `transient FIFO pressure dropped ${diagnostics.encoderBridgeOutputQueueDroppedFrames} ` +
        'output access unit(s)'
    )
  }
  if ((diagnostics?.encoderBridgeEncodedAccessUnitDroppedFrames ?? 0) !== 0) {
    failures.push(
      `transient FIFO pressure dropped ` +
        `${diagnostics.encoderBridgeEncodedAccessUnitDroppedFrames} encoded H.264 access unit(s)`
    )
  }
  if ((diagnostics?.encoderBridgeDroppedFrames ?? 0) !== 0) {
    failures.push(
      `transient FIFO pressure dropped ${diagnostics.encoderBridgeDroppedFrames} bridge frames`
    )
  }
  if ((diagnostics?.encoderBridgeEncodedOutputErrors ?? 0) !== 0) {
    failures.push(
      `transient FIFO pressure reported ${diagnostics.encoderBridgeEncodedOutputErrors} ` +
        'encoded output errors'
    )
  }
  if (diagnostics?.encoderBridgeError) {
    failures.push(
      `transient FIFO pressure reported encoder bridge error: ${diagnostics.encoderBridgeError}`
    )
  }
  return failures
}

export function missingRecordingMatrixResultFailures({ expectedLabels, results }) {
  const observed = new Set(results.map((result) => result.combo))
  return expectedLabels
    .filter((label) => !observed.has(label))
    .map((label) => ({
      combo: label,
      failures: [`required recording matrix pass ${label} produced no result`]
    }))
}
