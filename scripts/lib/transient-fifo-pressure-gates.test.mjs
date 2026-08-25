import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  countTransientFifoPauseMarkers,
  evaluateTransientFifoPressure,
  missingRecordingMatrixResultFailures
} from './transient-fifo-pressure-gates.mjs'

describe('transient VideoToolbox FIFO pressure gate', () => {
  it('accepts one recovered pressure burst with no drops or encoder error', () => {
    assert.deepEqual(
      evaluateTransientFifoPressure({
        activeStatus: { state: 'recording' },
        stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
        qualityMetrics: { expectedFrames: 181, observedFrames: 174 },
        testPauseFiredCount: 1,
        cleanFfmpegExitCount: 1,
        diagnostics: {
          encoderBridgeOutputQueueCapacityPressureEvents: 7,
          encoderBridgeOutputQueueHighWaterFrames: 16,
          encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
          encoderBridgeOutputPressureRecoveryEvents: 1,
          encoderBridgeOutputPreEncodeSkippedFrames: 7,
          encoderBridgeOutputQueueDroppedFrames: 0,
          encoderBridgeEncodedAccessUnitDroppedFrames: 0,
          encoderBridgeDroppedFrames: 0,
          encoderBridgeEncodedOutputErrors: 0,
          encoderBridgeError: null
        }
      }),
      []
    )
  })

  it('rejects unbounded skips or an artifact gap not explained by those skips', () => {
    const failures = evaluateTransientFifoPressure({
      activeStatus: { state: 'recording' },
      stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
      qualityMetrics: { expectedFrames: 181, observedFrames: 174 },
      testPauseFiredCount: 1,
      cleanFfmpegExitCount: 1,
      diagnostics: {
        encoderBridgeOutputQueueCapacityPressureEvents: 7,
        encoderBridgeOutputQueueHighWaterFrames: 16,
        encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
        encoderBridgeOutputPressureRecoveryEvents: 1,
        encoderBridgeOutputPreEncodeSkippedFrames: 17,
        encoderBridgeOutputQueueDroppedFrames: 0,
        encoderBridgeEncodedAccessUnitDroppedFrames: 0,
        encoderBridgeDroppedFrames: 0,
        encoderBridgeEncodedOutputErrors: 0,
        encoderBridgeError: null
      }
    })

    assert.ok(failures.some((failure) => failure.includes('expected at most 16')))
    assert.ok(failures.some((failure) => failure.includes('artifact gap 7 did not match 17')))
  })

  it('counts only the explicit backend pause-fired marker', () => {
    assert.equal(
      countTransientFifoPauseMarkers(
        'WARN test_hook="videotoolbox-fifo-pause" VIDEORC_TEST_VT_FIFO_PAUSE_FIRED'
      ),
      1
    )
    assert.equal(countTransientFifoPauseMarkers('WARN encoder output over its age budget'), 0)
    assert.equal(
      countTransientFifoPauseMarkers(
        'VIDEORC_TEST_VT_FIFO_PAUSE_FIRED VIDEORC_TEST_VT_FIFO_PAUSE_FIRED'
      ),
      2
    )
  })

  it('rejects generic queue pressure when the explicit test hook did not fire exactly once', () => {
    for (const testPauseFiredCount of [0, 2]) {
      const failures = evaluateTransientFifoPressure({
        activeStatus: { state: 'recording' },
        stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
        testPauseFiredCount,
        cleanFfmpegExitCount: 1,
        diagnostics: {
          encoderBridgeOutputQueueCapacityPressureEvents: 7,
          encoderBridgeOutputQueueHighWaterFrames: 16,
          encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
          encoderBridgeOutputPressureRecoveryEvents: 1,
          encoderBridgeOutputQueueDroppedFrames: 0,
          encoderBridgeEncodedAccessUnitDroppedFrames: 0,
          encoderBridgeDroppedFrames: 0,
          encoderBridgeEncodedOutputErrors: 0,
          encoderBridgeError: null
        }
      })

      assert.ok(failures.some((failure) => failure.includes('pause hook fired')))
    }
  })

  it('rejects a pass that never created pressure or ended in a recovery container', () => {
    const failures = evaluateTransientFifoPressure({
      activeStatus: { state: 'recording' },
      stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mkv' },
      testPauseFiredCount: 1,
      cleanFfmpegExitCount: 1,
      diagnostics: {
        encoderBridgeOutputQueueCapacityPressureEvents: 0,
        encoderBridgeOutputQueueHighWaterFrames: 16,
        encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
        encoderBridgeOutputPressureRecoveryEvents: 1,
        encoderBridgeOutputQueueDroppedFrames: 0,
        encoderBridgeDroppedFrames: 0,
        encoderBridgeEncodedOutputErrors: 0
      }
    })

    assert.ok(failures.some((failure) => failure.includes('did not exercise FIFO pressure')))
    assert.ok(failures.some((failure) => failure.includes('finalized MP4')))
  })

  it('rejects pressure evidence outside the exact incident shape or without recovery', () => {
    const failures = evaluateTransientFifoPressure({
      activeStatus: { state: 'recording' },
      stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
      testPauseFiredCount: 1,
      cleanFfmpegExitCount: 1,
      diagnostics: {
        encoderBridgeOutputQueueCapacityPressureEvents: 1,
        encoderBridgeOutputQueueHighWaterFrames: 17,
        encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 527,
        encoderBridgeOutputPressureRecoveryEvents: 0,
        encoderBridgeOutputQueueDroppedFrames: 0,
        encoderBridgeEncodedAccessUnitDroppedFrames: 0,
        encoderBridgeDroppedFrames: 0,
        encoderBridgeEncodedOutputErrors: 0,
        encoderBridgeError: null
      }
    })

    assert.ok(failures.some((failure) => failure.includes('depth 17/16')))
    assert.ok(failures.some((failure) => failure.includes('oldest >=528/250ms')))
    assert.ok(failures.some((failure) => failure.includes('recovery transition')))
  })

  it('rejects missing or duplicate clean FFmpeg exit evidence', () => {
    for (const cleanFfmpegExitCount of [0, 2]) {
      const failures = evaluateTransientFifoPressure({
        activeStatus: { state: 'recording' },
        stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
        testPauseFiredCount: 1,
        cleanFfmpegExitCount,
        diagnostics: {
          encoderBridgeOutputQueueCapacityPressureEvents: 1,
          encoderBridgeOutputQueueHighWaterFrames: 16,
          encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
          encoderBridgeOutputPressureRecoveryEvents: 1,
          encoderBridgeOutputQueueDroppedFrames: 0,
          encoderBridgeEncodedAccessUnitDroppedFrames: 0,
          encoderBridgeDroppedFrames: 0,
          encoderBridgeEncodedOutputErrors: 0,
          encoderBridgeError: null
        }
      })

      assert.ok(failures.some((failure) => failure.includes('exit-code-0 health event')))
    }
  })

  it('rejects early termination, dropped access units, and encoder errors', () => {
    const failures = evaluateTransientFifoPressure({
      activeStatus: { state: 'failed', message: 'fifo timed out' },
      stoppedStatus: { state: 'failed', outputPath: '/tmp/recording.mp4' },
      testPauseFiredCount: 1,
      cleanFfmpegExitCount: 0,
      diagnostics: {
        encoderBridgeOutputQueueCapacityPressureEvents: 2,
        encoderBridgeOutputQueueHighWaterFrames: 16,
        encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
        encoderBridgeOutputPressureRecoveryEvents: 1,
        encoderBridgeOutputQueueDroppedFrames: 1,
        encoderBridgeEncodedAccessUnitDroppedFrames: 1,
        encoderBridgeDroppedFrames: 3,
        encoderBridgeEncodedOutputErrors: 1,
        encoderBridgeError: 'complete-frame delivery budget'
      }
    })

    assert.ok(failures.some((failure) => failure.includes('stopped before user stop')))
    assert.ok(failures.some((failure) => failure.includes('did not return to idle')))
    assert.ok(failures.some((failure) => failure.includes('output access unit')))
    assert.ok(failures.some((failure) => failure.includes('encoded H.264 access unit')))
    assert.ok(failures.some((failure) => failure.includes('bridge frames')))
    assert.ok(failures.some((failure) => failure.includes('encoded output errors')))
    assert.ok(failures.some((failure) => failure.includes('encoder bridge error')))
  })

  it('turns a skipped required pass into an explicit matrix failure result', () => {
    assert.deepEqual(
      missingRecordingMatrixResultFailures({
        expectedLabels: ['4K30', '4K30:hard', '4K30:transient-fifo-pressure'],
        results: [
          { combo: '4K30', failures: [] },
          { combo: '4K30:hard', failures: [] }
        ]
      }),
      [
        {
          combo: '4K30:transient-fifo-pressure',
          failures: [
            'required recording matrix pass 4K30:transient-fifo-pressure produced no result'
          ]
        }
      ]
    )
  })
})
