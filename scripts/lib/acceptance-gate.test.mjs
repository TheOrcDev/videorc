// Unit tests for the real-source acceptance gate.
// Run: node --test scripts/lib/acceptance-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateAcceptance, recordingPreviewAcceptanceGates } from './acceptance-gate.mjs'

describe('recordingPreviewAcceptanceGates', () => {
  it('judges preview cadence against the shared recording compositor rate', () => {
    const thirty = recordingPreviewAcceptanceGates(30)
    const sixty = recordingPreviewAcceptanceGates(60)

    assert.equal(thirty.minPreviewPresentFps, 27)
    assert.equal(thirty.maxPreviewIntervalP95Ms, 50)
    assert.equal(sixty.minPreviewPresentFps, 54)
    assert.equal(sixty.maxPreviewIntervalP95Ms, 25)
  })
})

const cleanInput = () => ({
  analyzerVerdict: { pass: true, failures: [] },
  diagnostics: {
    encoderBridgeRepeatedFrames: 0,
    encoderBridgeSyntheticFrames: 0,
    encoderBridgeRecordingQueueDroppedFrames: 0,
    encoderBridgeRecordingQueueDepth: 2,
    encoderBridgeRecordingQueueOldestFrameAgeMs: 35,
    encoderBridgeRecordingQueueCapacityPressureEvents: 0,
    encoderBridgeStreamQueueDepth: 0,
    encoderBridgeStreamQueueOldestFrameAgeMs: null,
    encoderBridgeStreamQueueCapacityPressureEvents: 0,
    encoderBridgeStreamQueueDroppedFrames: 0,
    encoderBridgeMetalTargetFrames: 120,
    encoderBridgeRawVideoCopiedFrames: 0,
    encoderBridgeMetalTargetCopiedFrames: 0,
    encoderBridgeMetalTargetHandleFrames: 120,
    encoderBridgeZeroCopyFrames: 120,
    minEncoderSpeed: 1.0,
    micDroppedFrames: 0,
    minMicCaptureCoverage: 1.0,
    imagePollDuringSession: { total: 0 },
    previewSurfaceBacking: 'cametal-layer',
    previewPendingHostCommandCount: 0,
    minPreviewPresentFps: 60,
    previewIntervalP95Ms: 16.7,
    previewInputToPresentLatencyP95Ms: 18,
    previewInputToPresentLatencyP99Ms: 24,
    previewCompositorFrameLag: 0
  },
  claimsNative: true,
  expectAudio: true
})

const dimensions = (width, height) => ({
  latest: { width, height },
  max: { width, height },
  observed: [`${width}x${height}`],
  sampleCount: 3
})

const clean4kInput = () => {
  const input = cleanInput()
  input.requireGpuCompositor = true
  input.requireObsNativePreview = true
  input.require4kMediaEvidence = true
  input.requestedOutput = { width: 3840, height: 2160, fps: 30 }
  input.startupVerdict = { pass: true, failures: [] }
  input.diagnostics.compositorBackend = 'metal'
  input.diagnostics.compositorCpuFallbackFrames = 0
  input.diagnostics.compositorScreenSourceIosurfaceImportFrames = 120
  input.diagnostics.compositorScreenSourceCvpixelbufferImportFrames = 0
  input.diagnostics.compositorScreenSourceByteUploadFrames = 0
  input.diagnostics.compositorScreenSourceImportFailures = 0
  input.diagnostics.previewCameraActualWidth = 1920
  input.diagnostics.previewCameraActualHeight = 1080
  input.diagnostics.compositorCameraSourceIosurfaceImportFrames = 0
  input.diagnostics.compositorCameraSourceCvpixelbufferImportFrames = 120
  input.diagnostics.compositorCameraSourceByteUploadFrames = 0
  input.diagnostics.compositorCameraSourceImportFailures = 0
  input.diagnostics.encoderBridgeVideoToolboxOutputFrames = 120
  input.diagnostics.mediaDimensions = {
    requestedOutput: input.requestedOutput,
    screenSource: dimensions(3840, 2160),
    compositorScreenSource: dimensions(3840, 2160),
    compositorTarget: dimensions(3840, 2160),
    compositorMetalTarget: dimensions(3840, 2160)
  }
  return input
}

describe('evaluateAcceptance', () => {
  it('passes a clean real-source run', () => {
    const v = evaluateAcceptance(cleanInput())
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
  })

  it('fails when the final-file analyzer fails, surfacing its reasons', () => {
    const input = cleanInput()
    input.analyzerVerdict = {
      pass: false,
      failures: ['freeze segment 250ms exceeds 100ms (1 segment(s))']
    }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /final-file: freeze segment 250ms/)
  })

  it('fails when the startup-resolution analyzer fails, surfacing its reasons', () => {
    const input = cleanInput()
    input.startupVerdict = {
      pass: false,
      failures: ['metadata width 640 does not match expected 1920']
    }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /startup: metadata width 640/)
  })

  it('fails the strict OBS preview gate when no real native Metal surface is reported', () => {
    const input = cleanInput()
    input.claimsNative = false
    input.requireObsNativePreview = true
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /real native Metal surface/)
  })

  it('fails the strict OBS preview gate when the surface is still the Electron proof window', () => {
    const input = cleanInput()
    input.requireObsNativePreview = true
    input.diagnostics.previewSurfaceBacking = 'electron-browser-window'
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /expected CAMetalLayer preview backing/)
  })

  it('fails the strict OBS preview gate when native host commands are still pending', () => {
    const input = cleanInput()
    input.requireObsNativePreview = true
    input.diagnostics.previewPendingHostCommandCount = 2
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /2 native preview host command/)
  })

  it('fails closed when required native-preview telemetry is missing', () => {
    const input = clean4kInput()
    delete input.diagnostics.minPreviewPresentFps
    delete input.diagnostics.previewIntervalP95Ms
    delete input.diagnostics.previewInputToPresentLatencyP95Ms
    delete input.diagnostics.previewInputToPresentLatencyP99Ms
    delete input.diagnostics.previewCompositorFrameLag
    delete input.diagnostics.previewPendingHostCommandCount
    delete input.diagnostics.imagePollDuringSession

    const verdict = evaluateAcceptance(input)

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join(' '), /preview present FPS telemetry was missing/)
    assert.match(verdict.failures.join(' '), /pending-host-command telemetry was missing/)
    assert.match(verdict.failures.join(' '), /image-poll telemetry was missing/)
  })

  it('fails the strict OBS compositor gate when the live compositor falls back to CPU', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'cpu-fallback'
    input.diagnostics.compositorFallbackReason = 'VIDEORC_METAL_COMPOSITOR disabled'
    input.diagnostics.compositorCpuFallbackFrames = 12
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /expected Metal backend/)
    assert.match(v.failures.join(' '), /12 CPU fallback frame/)
  })

  it('fails the strict OBS compositor gate when no Metal target reaches the bridge', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeMetalTargetFrames = 0
    input.diagnostics.encoderBridgeMetalTargetHandleFrames = 0
    input.diagnostics.encoderBridgeZeroCopyFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /IOSurface-backed Metal target frames/)
  })

  it('fails the strict OBS compositor gate when Metal target handles do not reach the bridge', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeMetalTargetFrames = 120
    input.diagnostics.encoderBridgeMetalTargetHandleFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /retained Metal target handles/)
  })

  it('fails the strict OBS compositor gate when some Metal targets lack retained handles', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeMetalTargetFrames = 120
    input.diagnostics.encoderBridgeMetalTargetHandleFrames = 119
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /1 IOSurface-backed Metal target frame/)
  })

  it('fails the strict OBS compositor gate when Metal target frames are still copied', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeMetalTargetFrames = 120
    input.diagnostics.encoderBridgeRawVideoCopiedFrames = 120
    input.diagnostics.encoderBridgeMetalTargetCopiedFrames = 120
    input.diagnostics.encoderBridgeMetalTargetHandleFrames = 120
    input.diagnostics.encoderBridgeZeroCopyFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /still copied through the raw-video FFmpeg bridge/)
    assert.match(v.failures.join(' '), /expected zero-copy/)
  })

  it('fails the strict OBS compositor gate when any raw-YUV frames are copied', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeRawVideoCopiedFrames = 1
    input.diagnostics.encoderBridgeMetalTargetCopiedFrames = 0
    input.diagnostics.encoderBridgeMetalTargetHandleFrames = 120
    input.diagnostics.encoderBridgeZeroCopyFrames = 120
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /developer\/debug raw-video FFmpeg bridge/)
  })

  it('fails on duplicate frames re-fed to the encoder when final-file proof is unavailable', () => {
    const input = cleanInput()
    input.analyzerVerdict = null
    input.diagnostics.encoderBridgeRepeatedFrames = 12
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /12 duplicate frame\(s\) re-fed/)
  })

  it('fails on synthetic filler frames', () => {
    const input = cleanInput()
    input.diagnostics.encoderBridgeSyntheticFrames = 3
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /3 synthetic filler frame/)
  })

  it('fails when recording output backpressure discards a frame', () => {
    const input = cleanInput()
    input.diagnostics.encoderBridgeRecordingQueueDroppedFrames = 2
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /2 frame\(s\) discarded by recording output backpressure/)
  })

  it('fails when recording or split-stream queues exceed the latency contract', () => {
    const input = clean4kInput()
    input.diagnostics.encoderBridgeSeparateOutputEncodersActive = true
    input.diagnostics.encoderBridgeRecordingQueueDepth = 17
    input.diagnostics.encoderBridgeRecordingQueueOldestFrameAgeMs = 251
    input.diagnostics.encoderBridgeRecordingQueueCapacityPressureEvents = 1
    input.diagnostics.encoderBridgeStreamQueueDepth = 9
    input.diagnostics.encoderBridgeStreamQueueOldestFrameAgeMs = 151

    const verdict = evaluateAcceptance(input)

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join(' '), /recording: queue depth 17 exceeded 16/)
    assert.match(verdict.failures.join(' '), /recording: queue hit capacity 1 time/)
    assert.match(verdict.failures.join(' '), /stream: queue oldest-frame age 151ms exceeded 150ms/)
  })

  it('fails when the encoder falls behind real-time and final-file proof is unavailable', () => {
    const input = cleanInput()
    input.analyzerVerdict = null
    input.diagnostics.minEncoderSpeed = 0.8
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /speed 0.80x below 0.98x/)
  })

  it('lets passing final-file proof arbitrate bridge-repeat and progress-speed telemetry', () => {
    const input = cleanInput()
    input.diagnostics.encoderBridgeRepeatedFrames = 12
    input.diagnostics.minEncoderSpeed = 0.71
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
  })

  it('fails on mic drops and low capture coverage only when audio is expected', () => {
    const dropped = cleanInput()
    dropped.diagnostics.micDroppedFrames = 5
    assert.equal(evaluateAcceptance(dropped).pass, false)

    const lowCoverage = cleanInput()
    lowCoverage.diagnostics.minMicCaptureCoverage = 0.5
    assert.equal(evaluateAcceptance(lowCoverage).pass, false)

    // Same problems but no audio expected → not gated.
    const noAudio = cleanInput()
    noAudio.expectAudio = false
    noAudio.diagnostics.micDroppedFrames = 5
    noAudio.diagnostics.minMicCaptureCoverage = 0.5
    assert.equal(evaluateAcceptance(noAudio).pass, true)
  })

  it('fails a "native" preview that fetched image-poll routes (transport honesty)', () => {
    const input = cleanInput()
    input.diagnostics.imagePollDuringSession = { total: 240 }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /240 image-poll request\(s\) during a "native"/)

    // Image polling is fine when the preview does NOT claim to be native (it IS a fallback).
    const fallback = cleanInput()
    fallback.claimsNative = false
    fallback.diagnostics.imagePollDuringSession = { total: 240 }
    assert.equal(evaluateAcceptance(fallback).pass, true)
  })

  it('fails a native preview whose cadence, host-present latency, or frame lag is too high', () => {
    const lowFps = cleanInput()
    lowFps.diagnostics.minPreviewPresentFps = 24
    let v = evaluateAcceptance(lowFps)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /present FPS 24.0 below 55/)

    const jittery = cleanInput()
    jittery.diagnostics.previewIntervalP95Ms = 80
    v = evaluateAcceptance(jittery)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /p95 present interval 80.0ms/)

    const p95 = cleanInput()
    p95.diagnostics.previewInputToPresentLatencyP95Ms = 72
    v = evaluateAcceptance(p95)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /p95 latency 72ms/)

    const p99 = cleanInput()
    p99.diagnostics.previewInputToPresentLatencyP99Ms = 140
    v = evaluateAcceptance(p99)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /p99 latency 140ms/)

    const slow = cleanInput()
    delete slow.diagnostics.previewInputToPresentLatencyP95Ms
    delete slow.diagnostics.previewInputToPresentLatencyP99Ms
    slow.diagnostics.previewInputToPresentLatencyMs = 180
    v = evaluateAcceptance(slow)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /source-to-present latency 180ms/)

    const staticSourceMax = cleanInput()
    staticSourceMax.diagnostics.previewInputToPresentLatencyMs = 11_178
    staticSourceMax.diagnostics.previewInputToPresentLatencyP95Ms = 1
    staticSourceMax.diagnostics.previewInputToPresentLatencyP99Ms = 1
    v = evaluateAcceptance(staticSourceMax)
    assert.equal(v.pass, true)

    const lagging = cleanInput()
    lagging.diagnostics.previewCompositorFrameLag = 5
    v = evaluateAcceptance(lagging)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /5 compositor frame/)

    const fallback = cleanInput()
    fallback.claimsNative = false
    fallback.diagnostics.minPreviewPresentFps = 24
    fallback.diagnostics.previewIntervalP95Ms = 80
    fallback.diagnostics.previewInputToPresentLatencyMs = 180
    fallback.diagnostics.previewCompositorFrameLag = 5
    assert.equal(evaluateAcceptance(fallback).pass, true)
  })

  it('passes a clean 4K media evidence fixture', () => {
    const v = evaluateAcceptance(clean4kInput())

    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
  })

  it('fails the 4K fixture when the compositor falls back to CPU', () => {
    const input = clean4kInput()
    input.diagnostics.compositorBackend = 'cpu-fallback'
    input.diagnostics.compositorCpuFallbackFrames = 1
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /expected Metal backend/)
    assert.match(v.failures.join(' '), /1 CPU fallback frame/)
  })

  it('fails the 4K fixture when raw copied frames are still present', () => {
    const input = clean4kInput()
    input.diagnostics.encoderBridgeRawVideoCopiedFrames = 12
    input.diagnostics.encoderBridgeMetalTargetCopiedFrames = 12
    input.diagnostics.encoderBridgeZeroCopyFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /developer\/debug raw-video FFmpeg bridge/)
    assert.match(v.failures.join(' '), /still copied through the raw-video FFmpeg bridge/)
    assert.match(v.failures.join(' '), /expected zero-copy/)
  })

  it('fails the 4K fixture when the screen source uses byte upload', () => {
    const input = clean4kInput()
    input.diagnostics.compositorScreenSourceByteUploadFrames = 8
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /screen source used 8 byte-upload frame/)
  })

  it('fails the 4K fixture when screen source zero-copy import is missing', () => {
    const input = clean4kInput()
    input.diagnostics.compositorScreenSourceIosurfaceImportFrames = 0
    input.diagnostics.compositorScreenSourceCvpixelbufferImportFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /expected screen source zero-copy import frames/)
  })

  it('fails the 4K fixture when the camera source uses byte upload', () => {
    const input = clean4kInput()
    input.diagnostics.compositorCameraSourceByteUploadFrames = 6
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /camera source used 6 byte-upload frame/)
  })

  it('fails the 4K fixture when active camera zero-copy import is missing', () => {
    const input = clean4kInput()
    input.diagnostics.compositorCameraSourceCvpixelbufferImportFrames = 0
    input.diagnostics.compositorCameraSourceIosurfaceImportFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /expected camera source zero-copy import frames/)
  })

  it('fails the 4K fixture when the screen source is downscaled', () => {
    const input = clean4kInput()
    input.diagnostics.mediaDimensions.screenSource = dimensions(1920, 1080)
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /screen source capture: 1920x1080 below requested 3840x2160/)
  })

  it('prefers explicit screen actual dimensions over legacy source dimensions', () => {
    const input = clean4kInput()
    input.diagnostics.mediaDimensions.screenSource = dimensions(3840, 2160)
    input.diagnostics.mediaDimensions.screenSourceActual = dimensions(1920, 1080)
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /screen source capture: 1920x1080 below requested 3840x2160/)
  })

  it('fails the 4K fixture when first-frame dimensions fail startup analysis', () => {
    const input = clean4kInput()
    input.startupVerdict = {
      pass: false,
      failures: ['first startup frame 1920x1080 does not match expected 3840x2160']
    }
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /startup: first startup frame 1920x1080/)
  })

  it('accumulates every failure at once', () => {
    const input = cleanInput()
    input.analyzerVerdict = {
      pass: false,
      failures: ['repeated-frame burst of 7 consecutive identical frames']
    }
    input.diagnostics.encoderBridgeRepeatedFrames = 4
    input.diagnostics.minEncoderSpeed = 0.5
    input.diagnostics.micDroppedFrames = 2
    input.diagnostics.imagePollDuringSession = { total: 100 }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.ok(v.failures.length >= 5, `expected ≥5 failures, got ${v.failures.length}`)
  })
})
