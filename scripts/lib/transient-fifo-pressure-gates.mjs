import { extname } from 'node:path'

export const TRANSIENT_FIFO_PAUSE_FIRED_MARKER = 'VIDEORC_TEST_VT_FIFO_PAUSE_FIRED'

export function countTransientFifoPauseMarkers(line) {
  if (typeof line !== 'string' || line.length === 0) return 0
  return line.split(TRANSIENT_FIFO_PAUSE_FIRED_MARKER).length - 1
}

export function evaluateTransientFifoPressure({
  activeStatus,
  stoppedStatus,
  diagnostics,
  testPauseFiredCount
}) {
  const failures = []
  if (testPauseFiredCount !== 1) {
    failures.push(
      `transient FIFO test pause hook fired ${testPauseFiredCount ?? 'unknown'} time(s); ` +
        'expected exactly once'
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
  if ((diagnostics?.encoderBridgeOutputQueueDroppedFrames ?? 0) !== 0) {
    failures.push(
      `transient FIFO pressure dropped ${diagnostics.encoderBridgeOutputQueueDroppedFrames} ` +
        'output access unit(s)'
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
