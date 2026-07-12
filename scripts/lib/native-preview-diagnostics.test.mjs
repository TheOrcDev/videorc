import assert from 'node:assert/strict'
import test from 'node:test'

import {
  minimumProofSourceFrameDelta,
  resolveNativePreviewLatencyBudgets,
  summarizeNativePreviewRecordingDiagnostics
} from './native-preview-diagnostics.mjs'

const baseOptions = {
  targetFps: 30,
  startedAt: 1_000,
  stopRequestedAt: 8_000,
  warmupMs: 2_000,
  expectedSurfaceTransport: 'electron-proof-surface',
  expectedSurfaceBacking: 'electron-browser-window'
}

test('native preview latency budgets distinguish native Metal from contained proof polling', () => {
  const configured = {
    configuredP95Ms: 50,
    configuredP99Ms: 100
  }

  assert.deepEqual(
    resolveNativePreviewLatencyBudgets({
      ...configured,
      expectNativeMetalPreview: true,
      exerciseProofFramePolling: true
    }),
    { p95Ms: 50, p99Ms: 100 }
  )
  assert.deepEqual(
    resolveNativePreviewLatencyBudgets({
      ...configured,
      expectNativeMetalPreview: false,
      exerciseProofFramePolling: false
    }),
    { p95Ms: 50, p99Ms: 100 }
  )
  assert.deepEqual(
    resolveNativePreviewLatencyBudgets({
      ...configured,
      expectNativeMetalPreview: false,
      exerciseProofFramePolling: true,
      proofPollingIntervalMs: 125
    }),
    { p95Ms: 250, p99Ms: 250 }
  )
  assert.deepEqual(
    resolveNativePreviewLatencyBudgets({
      ...configured,
      sourceCompleteScene: true
    }),
    { p95Ms: 100, p99Ms: 150 }
  )
  assert.deepEqual(
    resolveNativePreviewLatencyBudgets({
      configuredP95Ms: 125,
      configuredP99Ms: 200,
      expectNativeMetalPreview: false,
      exerciseProofFramePolling: true,
      proofPollingIntervalMs: 125
    }),
    { p95Ms: 250, p99Ms: 250 }
  )
})

test('proof-source advancement floor scales with the measurement and polling profile', () => {
  assert.equal(
    minimumProofSourceFrameDelta({ measurementMs: 4_000, pollingIntervalMs: 125 }),
    8
  )
  assert.equal(
    minimumProofSourceFrameDelta({ measurementMs: 500, pollingIntervalMs: 125 }),
    2
  )
  assert.equal(
    minimumProofSourceFrameDelta({ measurementMs: 4_000, pollingIntervalMs: 0 }),
    2
  )
})

test('native preview diagnostics exclude samples before the absolute measurement epoch', () => {
  const summary = summarizeNativePreviewRecordingDiagnostics(
    [
      {
        activeOutputMode: 'record',
        receivedAt: 2_500,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        previewInputToPresentLatencyP95Ms: 600,
        previewInputToPresentLatencyP99Ms: 700
      },
      {
        activeOutputMode: 'record',
        receivedAt: 4_500,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        previewInputToPresentLatencyP95Ms: 80,
        previewInputToPresentLatencyP99Ms: 120
      }
    ],
    {
      ...baseOptions,
      startedAt: 4_000,
      warmupMs: 0,
      stopRequestedAt: 6_000
    }
  )

  assert.equal(summary.maxPreviewInputToPresentLatencyP95Ms, 80)
  assert.equal(summary.maxPreviewInputToPresentLatencyP99Ms, 120)
  assert.equal(summary.measuredSamples, 1)
})

test('native preview diagnostics summarize only steady active recording samples when available', () => {
  const summary = summarizeNativePreviewRecordingDiagnostics(
    [
      {
        activeOutputMode: 'record',
        receivedAt: 1_500,
        captureFps: 5,
        renderFps: 6,
        encoderSpeed: 0.2,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        previewPresentFps: 8,
        previewInputToPresentLatencyP95Ms: 180,
        previewInputToPresentLatencyP99Ms: 240,
        previewCompositorFrameLag: 9,
        encoderBridgeMetalTargetFrames: 7,
        compositorCpuFallbackFrames: 2
      },
      {
        activeOutputMode: 'record',
        receivedAt: 3_500,
        captureFps: 30.2,
        renderFps: 60,
        encoderSpeed: 1.02,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        previewPresentFps: 60,
        previewInputToPresentLatencyMs: 20,
        previewInputToPresentLatencyP95Ms: 35,
        previewInputToPresentLatencyP99Ms: 48,
        previewRenderFrameTimeP95Ms: 9.6,
        encoderBridgeRepeatedFrames: 9,
        encoderBridgeRepeatedFrameBursts: 4,
        encoderBridgeMaxRepeatedFrameRun: 3,
        encoderBridgeSourceAgeMs: 27,
        encoderBridgeSourceAgeP95Ms: 19.5,
        encoderBridgeRepeatedFrameAgeP95Ms: 24.5,
        encoderBridgeRepeatedFrameAgeMaxMs: 31,
        encoderBridgeMetalTargetFrames: 61,
        encoderBridgeRawVideoCopiedFrames: 90,
        encoderBridgeMetalTargetCopiedFrames: 61,
        encoderBridgeMetalTargetHandleFrames: 61,
        encoderBridgeZeroCopyFrames: 0,
        encoderBridgeVideoToolboxProbeFrames: 42,
        encoderBridgeVideoToolboxProbeBytes: 12345,
        encoderBridgeVideoToolboxProbeErrors: 1,
        encoderBridgeVideoToolboxOutputFrames: 40,
        encoderBridgeVideoToolboxOutputBytes: 67890,
        encoderBridgeVideoToolboxOutputEncodeMs: 43,
        encoderBridgeCompositorWaitP95Ms: 2.4,
        encoderBridgeVideoToolboxSubmitP95Ms: 1.2,
        encoderBridgeVideoToolboxFifoWriteP95Ms: 0.8,
        encoderBridgeVideoToolboxFifoEnqueueP95Ms: 3.4,
        encoderBridgeVideoToolboxFifoEnqueueMaxMs: 8.9,
        encoderBridgeWriterLoopP95Ms: 34.5,
        encoderBridgeWriterSleepP95Ms: 24.0,
        encoderBridgeWriterActiveP95Ms: 10.5,
        encoderBridgeDeadlineLagP95Ms: 5.6,
        encoderBridgeDeadlineLagMaxMs: 12.3,
        encoderBridgeLateDeadlineTicks: 2,
        compositorCpuFallbackFrames: 0,
        compositorFallbackReason: '',
        compositorSourceIosurfaceImportFrames: 12,
        compositorSourceCvpixelbufferImportFrames: 5,
        compositorSourceByteUploadFrames: 0,
        compositorSourceImportFailures: 0,
        compositorScreenSourceIosurfaceImportFrames: 12,
        compositorScreenSourceCvpixelbufferImportFrames: 0,
        compositorScreenSourceByteUploadFrames: 0,
        compositorScreenSourceImportFailures: 0,
        compositorCameraSourceIosurfaceImportFrames: 0,
        compositorCameraSourceCvpixelbufferImportFrames: 5,
        compositorCameraSourceByteUploadFrames: 0,
        compositorCameraSourceImportFailures: 0,
        activeFfmpegProcesses: 1
      },
      {
        activeOutputMode: 'record',
        receivedAt: 8_500,
        captureFps: 1,
        renderFps: 1,
        encoderSpeed: 0.1
      }
    ],
    {
      ...baseOptions,
      previewSurfaceSamples: [
        {
          receivedAt: 3_600,
          transport: 'electron-proof-surface',
          backing: 'electron-browser-window',
          presentFps: 120,
          inputToPresentLatencyP95Ms: 32,
          inputToPresentLatencyP99Ms: 45,
          compositorFrameLag: 1,
          intervalP95Ms: 8.9,
          droppedFrames: 0,
          nativePreviewRendererPollIntervalP95Ms: 19,
          nativePreviewRendererPollRoundTripP95Ms: 6,
          nativePreviewRendererPresentRoundTripP95Ms: 14,
          nativePreviewRendererPollInFlightSkips: 3,
          nativePreviewMainQueueWaitP95Ms: 11,
          nativePreviewMainPresentP95Ms: 13,
          nativePreviewMainQueuedBehindCount: 2,
          nativePreviewHelperRoundTripP95Ms: 5,
          nativePreviewMainStatusFetchP95Ms: 4,
          nativePreviewMainStatusFetchFailures: 1,
          nativePreviewMainStatusFetchSuccesses: 21,
          nativePreviewMainPresentedStatusAgeMs: 17,
          nativePreviewMainPresentedStatusAgeP95Ms: 23,
          nativePreviewMainPresentedFrameAgeP95Ms: 19
        }
      ]
    }
  )

  assert.equal(summary.minSpeed, 1.02)
  assert.equal(summary.minFps, 30.2)
  assert.equal(summary.minPreviewPresentFps, 60)
  assert.equal(summary.maxPreviewInputToPresentLatencyP95Ms, 35)
  assert.equal(summary.maxPreviewInputToPresentLatencyP99Ms, 48)
  assert.equal(summary.maxPreviewCompositorFrameLag, 1)
  assert.equal(summary.maxNativePreviewRendererPollIntervalP95Ms, 19)
  assert.equal(summary.maxNativePreviewRendererPollRoundTripP95Ms, 6)
  assert.equal(summary.maxNativePreviewRendererPresentRoundTripP95Ms, 14)
  assert.equal(summary.maxNativePreviewRendererPollInFlightSkips, 3)
  assert.equal(summary.maxNativePreviewMainQueueWaitP95Ms, 11)
  assert.equal(summary.maxNativePreviewMainPresentP95Ms, 13)
  assert.equal(summary.maxNativePreviewMainQueuedBehindCount, 2)
  assert.equal(summary.maxNativePreviewHelperRoundTripP95Ms, 5)
  assert.equal(summary.maxNativePreviewMainStatusFetchP95Ms, 4)
  assert.equal(summary.maxNativePreviewMainStatusFetchFailures, 1)
  assert.equal(summary.maxNativePreviewMainStatusFetchSuccesses, 21)
  assert.equal(summary.maxNativePreviewMainPresentedStatusAgeMs, 17)
  assert.equal(summary.maxNativePreviewMainPresentedStatusAgeP95Ms, 23)
  assert.equal(summary.maxNativePreviewMainPresentedFrameAgeP95Ms, 19)
  assert.equal(summary.nativePreviewSamples, 2)
  assert.equal(summary.maxEncoderBridgeRepeatedFrames, 9)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameBursts, 4)
  assert.equal(summary.maxEncoderBridgeMaxRepeatedFrameRun, 3)
  assert.equal(summary.maxEncoderBridgeSourceAgeMs, 27)
  assert.equal(summary.maxEncoderBridgeSourceAgeP95Ms, 19.5)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameAgeP95Ms, 24.5)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameAgeMaxMs, 31)
  assert.equal(summary.maxEncoderBridgeMetalTargetFrames, 61)
  assert.equal(summary.maxEncoderBridgeRawVideoCopiedFrames, 90)
  assert.equal(summary.maxEncoderBridgeMetalTargetCopiedFrames, 61)
  assert.equal(summary.maxEncoderBridgeMetalTargetHandleFrames, 61)
  assert.equal(summary.maxEncoderBridgeZeroCopyFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeFrames, 42)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeBytes, 12345)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeErrors, 1)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputFrames, 40)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputBytes, 67890)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputEncodeMs, 43)
  assert.equal(summary.maxEncoderBridgeCompositorWaitP95Ms, 2.4)
  assert.equal(summary.maxEncoderBridgeVideoToolboxSubmitP95Ms, 1.2)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoWriteP95Ms, 0.8)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoEnqueueP95Ms, 3.4)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoEnqueueMaxMs, 8.9)
  assert.equal(summary.maxEncoderBridgeWriterLoopP95Ms, 34.5)
  assert.equal(summary.maxEncoderBridgeWriterSleepP95Ms, 24.0)
  assert.equal(summary.maxEncoderBridgeWriterActiveP95Ms, 10.5)
  assert.equal(summary.maxEncoderBridgeDeadlineLagP95Ms, 5.6)
  assert.equal(summary.maxEncoderBridgeDeadlineLagMaxMs, 12.3)
  assert.equal(summary.maxEncoderBridgeLateDeadlineTicks, 2)
  assert.equal(summary.maxCompositorCpuFallbackFrames, 0)
  assert.equal(summary.maxCompositorSourceIosurfaceImportFrames, 12)
  assert.equal(summary.maxCompositorSourceCvpixelbufferImportFrames, 5)
  assert.equal(summary.maxCompositorSourceByteUploadFrames, 0)
  assert.equal(summary.maxCompositorSourceImportFailures, 0)
  assert.equal(summary.maxCompositorScreenSourceIosurfaceImportFrames, 12)
  assert.equal(summary.maxCompositorScreenSourceCvpixelbufferImportFrames, 0)
  assert.equal(summary.maxCompositorScreenSourceByteUploadFrames, 0)
  assert.equal(summary.maxCompositorScreenSourceImportFailures, 0)
  assert.equal(summary.maxCompositorCameraSourceIosurfaceImportFrames, 0)
  assert.equal(summary.maxCompositorCameraSourceCvpixelbufferImportFrames, 5)
  assert.equal(summary.maxCompositorCameraSourceByteUploadFrames, 0)
  assert.equal(summary.maxCompositorCameraSourceImportFailures, 0)
  assert.equal(summary.lastCompositorFallbackReason, null)
  assert.equal(summary.steadySamples, 1)
  assert.equal(summary.measuredSamples, 1)
  assert.equal(summary.steadySurfaceSamples, 1)
  assert.equal(summary.measuredSurfaceSamples, 1)
  assert.equal(summary.maxActiveFfmpegProcesses, 1)
})

test('native preview diagnostics include record+stream samples', () => {
  const summary = summarizeNativePreviewRecordingDiagnostics(
    [
      {
        activeOutputMode: 'record+stream',
        receivedAt: 3_500,
        captureFps: 29.8,
        renderFps: 30.1,
        encoderSpeed: 1.0,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        encoderBridgeVideoToolboxOutputFrames: 72
      },
      {
        activeOutputMode: 'stream',
        receivedAt: 3_600,
        captureFps: 1,
        renderFps: 1,
        encoderBridgeVideoToolboxOutputFrames: 1_000
      }
    ],
    baseOptions
  )

  assert.equal(summary.minFps, 29.8)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputFrames, 72)
  assert.equal(summary.measuredSamples, 1)
})

test('native preview diagnostics fall back to active samples when warmup hides them all', () => {
  const summary = summarizeNativePreviewRecordingDiagnostics(
    [
      {
        activeOutputMode: 'record',
        receivedAt: 1_500,
        captureFps: 29,
        encoderSpeed: 0.99,
        previewPresentFps: 58,
        previewInputToPresentLatencyP95Ms: 44,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        encoderBridgeMetalTargetFrames: 12,
        encoderBridgeRawVideoCopiedFrames: 18,
        encoderBridgeMetalTargetCopiedFrames: 12,
        encoderBridgeMetalTargetHandleFrames: 12,
        encoderBridgeZeroCopyFrames: 0,
        compositorCpuFallbackFrames: 4,
        compositorFallbackReason: 'camera frame unavailable'
      },
      {
        activeOutputMode: 'idle',
        receivedAt: 1_700,
        captureFps: 1,
        encoderSpeed: 0.1,
        previewPresentFps: 1
      }
    ],
    baseOptions
  )

  assert.equal(summary.minSpeed, 0.99)
  assert.equal(summary.minFps, 29)
  assert.equal(summary.minPreviewPresentFps, 58)
  assert.equal(summary.maxPreviewInputToPresentLatencyP95Ms, 44)
  assert.equal(summary.nativePreviewSamples, 1)
  assert.equal(summary.maxEncoderBridgeRepeatedFrames, 0)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameBursts, 0)
  assert.equal(summary.maxEncoderBridgeMaxRepeatedFrameRun, 0)
  assert.equal(summary.maxEncoderBridgeSourceAgeMs, 0)
  assert.equal(summary.maxEncoderBridgeSourceAgeP95Ms, null)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameAgeP95Ms, null)
  assert.equal(summary.maxEncoderBridgeRepeatedFrameAgeMaxMs, 0)
  assert.equal(summary.maxEncoderBridgeMetalTargetFrames, 12)
  assert.equal(summary.maxEncoderBridgeRawVideoCopiedFrames, 18)
  assert.equal(summary.maxEncoderBridgeMetalTargetCopiedFrames, 12)
  assert.equal(summary.maxEncoderBridgeMetalTargetHandleFrames, 12)
  assert.equal(summary.maxEncoderBridgeZeroCopyFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeBytes, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeErrors, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputBytes, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputEncodeMs, 0)
  assert.equal(summary.maxEncoderBridgeCompositorWaitP95Ms, null)
  assert.equal(summary.maxEncoderBridgeVideoToolboxSubmitP95Ms, null)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoWriteP95Ms, null)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoEnqueueP95Ms, null)
  assert.equal(summary.maxEncoderBridgeVideoToolboxFifoEnqueueMaxMs, null)
  assert.equal(summary.maxEncoderBridgeWriterLoopP95Ms, null)
  assert.equal(summary.maxEncoderBridgeWriterSleepP95Ms, null)
  assert.equal(summary.maxEncoderBridgeWriterActiveP95Ms, null)
  assert.equal(summary.maxEncoderBridgeDeadlineLagP95Ms, null)
  assert.equal(summary.maxEncoderBridgeDeadlineLagMaxMs, null)
  assert.equal(summary.maxEncoderBridgeLateDeadlineTicks, 0)
  assert.equal(summary.maxCompositorCpuFallbackFrames, 4)
  assert.equal(summary.lastCompositorFallbackReason, 'camera frame unavailable')
  assert.equal(summary.steadySamples, 0)
  assert.equal(summary.measuredSamples, 1)
})

test('native preview diagnostics can use surface status samples for host-present lag', () => {
  const summary = summarizeNativePreviewRecordingDiagnostics(
    [
      {
        activeOutputMode: 'record',
        receivedAt: 4_000,
        captureFps: 30,
        renderFps: 30,
        encoderSpeed: 1.0,
        previewTransport: 'electron-proof-surface',
        previewSurfaceBacking: 'electron-browser-window',
        previewPresentFps: 30,
        previewInputToPresentLatencyP95Ms: 20,
        encoderBridgeMetalTargetFrames: 24,
        encoderBridgeRawVideoCopiedFrames: 24,
        encoderBridgeMetalTargetCopiedFrames: 24,
        encoderBridgeMetalTargetHandleFrames: 24,
        encoderBridgeZeroCopyFrames: 0,
        compositorCpuFallbackFrames: 8,
        compositorFallbackReason: 'screen frame unavailable'
      }
    ],
    {
      ...baseOptions,
      previewSurfaceSamples: [
        {
          receivedAt: 4_050,
          transport: 'electron-proof-surface',
          backing: 'electron-browser-window',
          presentFps: 118,
          inputToPresentLatencyP95Ms: 18,
          inputToPresentLatencyP99Ms: 24,
          compositorFrameLag: 0
        }
      ]
    }
  )

  assert.equal(summary.maxPreviewCompositorFrameLag, 0)
  assert.equal(summary.maxPreviewInputToPresentLatencyP99Ms, 24)
  assert.equal(summary.nativePreviewSamples, 2)
  assert.equal(summary.maxEncoderBridgeMetalTargetFrames, 24)
  assert.equal(summary.maxEncoderBridgeRawVideoCopiedFrames, 24)
  assert.equal(summary.maxEncoderBridgeMetalTargetCopiedFrames, 24)
  assert.equal(summary.maxEncoderBridgeMetalTargetHandleFrames, 24)
  assert.equal(summary.maxEncoderBridgeZeroCopyFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeBytes, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxProbeErrors, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputFrames, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputBytes, 0)
  assert.equal(summary.maxEncoderBridgeVideoToolboxOutputEncodeMs, 0)
  assert.equal(summary.maxCompositorCpuFallbackFrames, 8)
  assert.equal(summary.lastCompositorFallbackReason, 'screen frame unavailable')
})
