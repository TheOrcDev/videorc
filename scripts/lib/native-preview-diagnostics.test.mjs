import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeNativePreviewRecordingDiagnostics } from './native-preview-diagnostics.mjs'

const baseOptions = {
  targetFps: 30,
  startedAt: 1_000,
  stopRequestedAt: 8_000,
  warmupMs: 2_000,
  expectedSurfaceTransport: 'electron-proof-surface',
  expectedSurfaceBacking: 'electron-browser-window'
}

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
        encoderBridgeMetalTargetFrames: 61,
        compositorCpuFallbackFrames: 0,
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
          droppedFrames: 0
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
  assert.equal(summary.nativePreviewSamples, 2)
  assert.equal(summary.maxEncoderBridgeMetalTargetFrames, 61)
  assert.equal(summary.maxCompositorCpuFallbackFrames, 0)
  assert.equal(summary.steadySamples, 1)
  assert.equal(summary.measuredSamples, 1)
  assert.equal(summary.steadySurfaceSamples, 1)
  assert.equal(summary.measuredSurfaceSamples, 1)
  assert.equal(summary.maxActiveFfmpegProcesses, 1)
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
        compositorCpuFallbackFrames: 4
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
  assert.equal(summary.maxEncoderBridgeMetalTargetFrames, 12)
  assert.equal(summary.maxCompositorCpuFallbackFrames, 4)
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
        compositorCpuFallbackFrames: 8
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
  assert.equal(summary.maxCompositorCpuFallbackFrames, 8)
})
