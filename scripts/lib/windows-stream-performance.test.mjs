import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS,
  packagedAppPayloadManifestSha256
} from './performance-contract.mjs'
import {
  WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
  WINDOWS_D3D11_PERFORMANCE_SCENARIOS
} from './windows-performance-budget.mjs'
import {
  WINDOWS_STREAM_PERFORMANCE_THRESHOLDS,
  WINDOWS_STREAM_PERFORMANCE_TIMING,
  WINDOWS_STREAM_ENDURANCE_TIMING,
  WINDOWS_CAPTURE_PROTECTION_MARKERS,
  assertWindowsStreamSelectionEnvironmentIsRunnerOwned,
  buildWindowsStreamPerformanceMatrix,
  evaluateWindowsStreamResourceBudget,
  evaluateWindowsStreamAggregate,
  evaluateWindowsStreamDxgiDisplayBinding,
  evaluateWindowsReceiverProgressClock,
  evaluateWindowsCaptureProtectionEvidence,
  evaluateWindowsCaptureProtectionPlacement,
  evaluateWindowsCaptureProtectionPlacementTimeline,
  evaluateWindowsD3d11PreviewInputContinuity,
  evaluateWindowsStreamDiagnosticTimeline,
  evaluateWindowsStreamCollectorBoundaries,
  evaluateWindowsStreamProcessTelemetry,
  evaluateWindowsStreamRun,
  evaluateWindowsStreamTargetLifecycle,
  formatWindowsStreamPerformanceMatrix,
  loadWindowsStreamPerformanceBudget,
  measureWindowsCaptureProtectionMarkerPixels,
  parseWindowsDxgiOutputDeviceName,
  parseWindowsStreamPerformanceArgs,
  parseWindowsStreamDisplayBounds,
  redactWindowsStreamSecrets,
  resolveWindowsStreamElectronDisplay,
  resolveWindowsStreamPathEvidence,
  receiverBitrateEvidence,
  summarizeWindowsStreamBmpBudgetMetrics,
  summarizeWindowsStreamBudgetProcessTelemetry,
  summarizeWindowsStreamDiagnosticSamples,
  validateWindowsStreamPerformanceBudget,
  validateWindowsStreamRunEvidence,
  windowsStreamAvDriftFitOptions,
  windowsStreamCalibrationMetrics,
  windowsStreamSecretLeaks,
  windowsStreamSelectionEnvironmentOverlay,
  windowsStreamCaptureProtectionPlacement
} from './windows-stream-performance.mjs'
import { WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS } from './windows-d3d11-media.mjs'

describe('Windows stream performance matrix', () => {
  it('accepts the package-manager argument separator used by documented pnpm commands', () => {
    assert.deepEqual(
      parseWindowsStreamPerformanceArgs(['--', '--list']),
      parseWindowsStreamPerformanceArgs(['--list'])
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--list', '--']),
      /Unknown Windows stream performance argument/
    )
  })

  it('lists every release-blocking 1080p topology, cadence, and preview state three times', () => {
    const matrix = buildWindowsStreamPerformanceMatrix()

    assert.equal(matrix.length, 19)
    assert.deepEqual(
      matrix.map((scenario) => scenario.id),
      [
        '1080p30-stream-preview',
        '1080p30-stream-no-preview',
        '1080p30-record-stream-preview',
        '1080p30-record-stream-no-preview',
        '1080p30-screen-camera-stream-preview',
        '1080p30-screen-camera-stream-no-preview',
        '1080p30-screen-camera-record-stream-preview',
        '1080p30-screen-camera-record-stream-no-preview',
        '1080p60-stream-preview',
        '1080p60-stream-no-preview',
        '1080p60-record-stream-preview',
        '1080p60-record-stream-no-preview',
        '1080p60-screen-camera-stream-preview',
        '1080p60-screen-camera-stream-no-preview',
        '1080p60-screen-camera-record-stream-preview',
        '1080p60-screen-camera-record-stream-no-preview',
        'youtube-1080p30',
        'youtube-1080p60',
        '1080p60-av-endurance'
      ]
    )
    assert.ok(
      matrix.every(
        (scenario) =>
          scenario.width === 1920 &&
          scenario.height === 1080 &&
          ['screen-only', 'screen-camera'].includes(scenario.sourceComposition) &&
          (scenario.avEndurance === true
            ? scenario.repetitions === 1
            : scenario.repetitions === 3) &&
          scenario.warmupMs === WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs &&
          scenario.measurementMs ===
            (scenario.avEndurance === true
              ? WINDOWS_STREAM_ENDURANCE_TIMING.measurementMs
              : WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs)
      )
    )
  })

  it('formats the exact protected matrix and total without launching the app', () => {
    const matrix = buildWindowsStreamPerformanceMatrix()
    const expected = [
      'windows-stream-performance: protected matrix',
      'matrix timing: warm-up 60s, measured 180s, 3 repetitions; A/V endurance measured 600s once',
      ...matrix.map(
        (scenario, index) =>
          `${index + 1}. ${scenario.id} — ${scenario.width}x${scenario.height}@${scenario.fps} | ${scenario.sourceComposition} | ${scenario.topology} | preview=${scenario.previewOpen ? 'open' : 'closed'} | measured=${scenario.measurementMs / 1000}s | runs=${scenario.repetitions}`
      ),
      'total: 19 scenarios, 55 measured runs'
    ].join('\n')

    assert.equal(formatWindowsStreamPerformanceMatrix(), expected)

    const command = spawnSync(
      process.execPath,
      ['scripts/smoke-windows-stream-performance.mjs', '--list'],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }
    )
    assert.equal(command.status, 0, command.stderr)
    assert.equal(command.stdout.trim(), expected)
  })

  it('matches the active D3D11 budget contract context for context', () => {
    const projection = buildWindowsStreamPerformanceMatrix().map((scenario) => ({
      id: scenario.id,
      profile: scenario.fps === 60 ? '1080p60' : '1080p30',
      sourceComposition: scenario.sourceComposition,
      topology: scenario.topology,
      previewOpen: scenario.previewOpen,
      warmupMs: scenario.warmupMs,
      measurementMs: scenario.measurementMs,
      intervalMs: scenario.sampleIntervalMs,
      repetitions: scenario.repetitions
    }))
    assert.deepEqual(projection, WINDOWS_D3D11_PERFORMANCE_SCENARIOS)
  })
})

describe('Windows stream measurement aggregation', () => {
  it('binds receiver media time to wall time and rejects delayed progress batches', () => {
    const passing = evaluateWindowsReceiverProgressClock([
      { observedAtMs: 1_000, outTimeUs: 200_000, frame: 6, totalSize: 1_000 },
      { observedAtMs: 1_250, outTimeUs: 450_000, frame: 14, totalSize: 2_000 },
      { observedAtMs: 1_500, outTimeUs: 700_000, frame: 21, totalSize: 3_000 }
    ])
    assert.equal(passing.verdict, 'PASS')
    assert.equal(passing.startedAtMs, 800)
    assert.equal(passing.uncertaintyMs, 0)

    const delayedBatch = evaluateWindowsReceiverProgressClock([
      { observedAtMs: 3_000, outTimeUs: 200_000, frame: 6, totalSize: 1_000 },
      { observedAtMs: 3_001, outTimeUs: 450_000, frame: 14, totalSize: 2_000 },
      { observedAtMs: 3_002, outTimeUs: 700_000, frame: 21, totalSize: 3_000 }
    ])
    assert.equal(delayedBatch.verdict, 'BLOCKED')
    assert.match(delayedBatch.blockers.join('\n'), /uncertainty/)

    const inheritedTimestamp = evaluateWindowsReceiverProgressClock([
      { observedAtMs: 61_000, outTimeUs: 60_200_000, frame: 6, totalSize: 1_000 },
      { observedAtMs: 61_250, outTimeUs: 60_450_000, frame: 14, totalSize: 2_000 },
      { observedAtMs: 61_500, outTimeUs: 60_700_000, frame: 21, totalSize: 3_000 }
    ])
    assert.equal(inheritedTimestamp.verdict, 'BLOCKED')
    assert.match(inheritedTimestamp.blockers.join('\n'), /begin near zero/)
  })

  it('binds every long-running collector to the same epoch boundaries', () => {
    const evidence = {
      collectorsStartedAtMs: 10_000,
      expectedMeasurementEndedAtMs: 20_000,
      intervalMs: 1_000,
      collectors: {
        process: { startedAtMs: 10_050, endedAtMs: 20_020 },
        diagnostics: { startedAtMs: 10_010, endedAtMs: 20_100 },
        gpu: { startedAtMs: 9_950, endedAtMs: 19_900 },
        captureProtection: { startedAtMs: 10_000, endedAtMs: 20_000 }
      }
    }
    assert.equal(evaluateWindowsStreamCollectorBoundaries(evidence).verdict, 'PASS')

    const delayed = structuredClone(evidence)
    delayed.collectors.gpu.startedAtMs = 11_001
    const delayedResult = evaluateWindowsStreamCollectorBoundaries(delayed)
    assert.equal(delayedResult.verdict, 'BLOCKED')
    assert.match(delayedResult.blockers.join('\n'), /gpu: start differed/)

    const missing = structuredClone(evidence)
    delete missing.collectors.diagnostics.endedAtMs
    assert.equal(evaluateWindowsStreamCollectorBoundaries(missing).verdict, 'BLOCKED')
  })

  it('derives five-second receiver bitrate windows and total bitrate from packet bytes', () => {
    const packets = Array.from({ length: 10 }, (_, second) => ({
      pts_time: String(second),
      size: '625000'
    }))
    assert.deepEqual(receiverBitrateEvidence(packets, { durationSeconds: 10 }), {
      measuredBitrateKbps: 5_000,
      rollingBitrateKbps: [5_000, 5_000],
      windowSeconds: 5,
      packetCount: 10,
      totalBytes: 6_250_000
    })
  })

  it('summarizes measured diagnostics as counter deltas and a fifth-percentile speed', () => {
    const summary = summarizeWindowsStreamDiagnosticSamples([
      {
        encoderSpeed: 1,
        encoderBridgeEncodedOutputFrames: 200,
        encoderBridgeEncodedOutputBytes: 2_000,
        encoderBridgeStreamEncodedOutputFrames: 100,
        encoderBridgeStreamEncodedOutputBytes: 1_000,
        encoderBridgeRawVideoCopiedFrames: 0,
        encoderBridgeDroppedFrames: 5,
        encoderBridgeStreamQueueDroppedFrames: 1,
        encoderBridgeEncodedOutputBackend: 'media-foundation',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encodeBackend: 'hardware-media-foundation'
      },
      {
        encoderSpeed: 0.98,
        encoderBridgeEncodedOutputFrames: 1_000,
        encoderBridgeEncodedOutputBytes: 10_000,
        encoderBridgeStreamEncodedOutputFrames: 500,
        encoderBridgeStreamEncodedOutputBytes: 5_000,
        encoderBridgeRawVideoCopiedFrames: 0,
        encoderBridgeDroppedFrames: 6,
        encoderBridgeStreamQueueDroppedFrames: 1,
        encoderBridgeEncodedOutputBackend: 'media-foundation',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encodeBackend: 'hardware-media-foundation'
      },
      {
        encoderSpeed: 1.2,
        encoderBridgeEncodedOutputFrames: 2_000,
        encoderBridgeEncodedOutputBytes: 20_000,
        encoderBridgeStreamEncodedOutputFrames: 1_000,
        encoderBridgeStreamEncodedOutputBytes: 10_000,
        encoderBridgeRawVideoCopiedFrames: 0,
        encoderBridgeDroppedFrames: 6,
        encoderBridgeStreamQueueDroppedFrames: 2,
        encoderBridgeEncodedOutputBackend: 'media-foundation',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encodeBackend: 'hardware-media-foundation'
      }
    ])

    assert.deepEqual(summary, {
      requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveEncodeBackend: 'hardware-media-foundation',
      encodedOutputBackend: 'media-foundation',
      separateOutputEncoders: false,
      encodedFrames: 1_000,
      encodedBytes: 10_000,
      rawVideoCopiedFrames: 0,
      submittedFrames: 901,
      coalescedFrames: 1,
      droppedFrames: 1,
      encoderSpeedP05: 0.98,
      fallbackReason: null,
      fallbackAcknowledged: false,
      fallbackChanged: false
    })
  })

  it('uses stream-role counters for split output and raw delivery for natural fallback', () => {
    const split = summarizeWindowsStreamDiagnosticSamples([
      {
        encoderBridgeSeparateOutputEncodersActive: true,
        encoderBridgeEncodedOutputFrames: 200,
        encoderBridgeStreamEncodedOutputFrames: 100,
        encoderBridgeStreamEncodedOutputBytes: 1_000,
        encoderBridgeRawVideoCopiedFrames: 0,
        encoderBridgeStreamRawVideoCopiedFrames: 0,
        encoderBridgeDroppedFrames: 5,
        encoderBridgeStreamDroppedFrames: 5,
        encoderBridgeStreamEncoderSpeed: 1,
        encoderBridgeStreamQueueDroppedFrames: 1,
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encodeBackend: 'hardware-media-foundation'
      },
      {
        encoderBridgeSeparateOutputEncodersActive: true,
        encoderBridgeEncodedOutputFrames: 2_000,
        encoderBridgeStreamEncodedOutputFrames: 500,
        encoderBridgeStreamEncodedOutputBytes: 5_000,
        encoderBridgeRawVideoCopiedFrames: 0,
        encoderBridgeStreamRawVideoCopiedFrames: 0,
        encoderBridgeDroppedFrames: 6,
        encoderBridgeStreamDroppedFrames: 6,
        encoderBridgeStreamEncoderSpeed: 0.99,
        encoderBridgeStreamQueueDroppedFrames: 2,
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encodeBackend: 'hardware-media-foundation'
      }
    ])
    assert.equal(split.encodedFrames, 500)
    assert.equal(split.submittedFrames, 401)

    const fallback = summarizeWindowsStreamDiagnosticSamples([
      {
        encoderBridgeStreamEncodedOutputFrames: 0,
        encoderBridgeStreamEncodedOutputBytes: 0,
        encoderBridgeRawVideoCopiedFrames: 100,
        encoderBridgeDroppedFrames: 5,
        encoderBridgeStreamQueueDroppedFrames: 1,
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
        encodeBackend: 'software-open-h264',
        encoderBridgeEncodedOutputFallbackReason: 'hardware topology unavailable'
      },
      {
        encoderBridgeStreamEncodedOutputFrames: 0,
        encoderBridgeStreamEncodedOutputBytes: 0,
        encoderBridgeRawVideoCopiedFrames: 1_000,
        encoderBridgeDroppedFrames: 6,
        encoderBridgeStreamQueueDroppedFrames: 2,
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
        encodeBackend: 'software-open-h264',
        encoderBridgeEncodedOutputFallbackReason: 'hardware topology unavailable'
      }
    ])
    assert.equal(fallback.rawVideoCopiedFrames, 1_000)
    assert.equal(fallback.submittedFrames, 901)
  })

  it('summarizes D3D11 zero-copy counters as measurement-window deltas', () => {
    const summary = summarizeWindowsStreamDiagnosticSamples([
      {
        windowsD3d11Media: {
          state: 'live',
          requested: true,
          required: true,
          adapterLuid: '0000000000000042',
          captureAdapterLuid: '0000000000000042',
          compositorAdapterLuid: '0000000000000042',
          primaryEncoderAdapterLuid: '0000000000000042',
          auxiliaryEncoderAdapterLuid: null,
          generation: 7,
          captureBackend: 'desktop-duplication',
          captureReadbackFrames: 0,
          textureImportFrames: 10,
          encoderGpuSamples: 10,
          encoderSystemMemorySamples: 0,
          previewPresents: 5,
          previewBmpRequests: 0,
          previewBmpBytes: 0,
          messagePumpLagP95Ms: 8,
          messagePumpLagMaxMs: 12,
          mediaCommandLagP95Ms: 6,
          mediaCommandLagMaxMs: 10,
          maximumConsecutiveMessageBatch: 4,
          maximumConsecutiveMediaBatch: 3,
          synchronizationTimeouts: 0
        }
      },
      {
        windowsD3d11Media: {
          state: 'live',
          requested: true,
          required: true,
          adapterLuid: '0000000000000042',
          captureAdapterLuid: '0000000000000042',
          compositorAdapterLuid: '0000000000000042',
          primaryEncoderAdapterLuid: '0000000000000042',
          auxiliaryEncoderAdapterLuid: null,
          generation: 7,
          captureBackend: 'desktop-duplication',
          captureReadbackFrames: 0,
          textureImportFrames: 110,
          encoderGpuSamples: 105,
          encoderSystemMemorySamples: 0,
          previewPresents: 65,
          previewBmpRequests: 0,
          previewBmpBytes: 0,
          messagePumpLagP95Ms: 9,
          messagePumpLagMaxMs: 14,
          mediaCommandLagP95Ms: 7,
          mediaCommandLagMaxMs: 11,
          maximumConsecutiveMessageBatch: 5,
          maximumConsecutiveMediaBatch: 4,
          synchronizationTimeouts: 0
        }
      }
    ])

    assert.equal(summary.d3d11.state, 'live')
    assert.equal(summary.d3d11.textureImportFrames, 100)
    assert.equal(summary.d3d11.encoderGpuSamples, 95)
    assert.equal(summary.d3d11.previewPresents, 60)
    assert.equal(summary.d3d11.captureReadbackFrames, 0)
    assert.equal(summary.d3d11.captureAdapterLuid, '0000000000000042')
    assert.equal(summary.d3d11.compositorAdapterLuid, '0000000000000042')
    assert.equal(summary.d3d11.primaryEncoderAdapterLuid, '0000000000000042')
    assert.equal(summary.d3d11.auxiliaryEncoderAdapterLuid, null)
    assert.equal(summary.d3d11.adapterChanged, false)
    assert.equal(summary.d3d11.stateChanged, false)
    assert.equal(summary.d3d11.mediaCommandLagMaxMs, 11)
    assert.equal(summary.d3d11.maximumConsecutiveMessageBatch, 5)
    assert.equal(summary.d3d11.synchronizationTimeouts, 0)
  })

  it('models Desktop Duplication cursor-on and cursor-excluded WGC as distinct contracts', () => {
    const metrics = (d3d11) =>
      windowsStreamCalibrationMetrics({
        processTelemetry: {},
        gpuEvidence: {},
        bmp: {},
        pipeline: { d3d11 },
        mediaVerdict: 'PASS',
        lifecycleVerdict: 'PASS',
        previewProofSurfaceVerdict: 'PASS',
        inputContinuity: true
      }).d3d11

    assert.equal(
      metrics({
        captureBackend: 'desktop-duplication',
        cursorRequested: true,
        cursorMode: 'separate',
        cursorPixelsSource: 'duplication-pointer-shape',
        cursorExclusionGuaranteed: false,
        cursorCompositedFrames: 20
      }).cursorCorrect,
      true
    )
    assert.equal(
      metrics({
        captureBackend: 'windows-graphics-capture-monitor',
        cursorRequested: false,
        cursorMode: 'excluded-wgc',
        cursorPixelsSource: 'excluded-by-windows-graphics-capture',
        cursorExclusionGuaranteed: true,
        cursorCompositedFrames: 0
      }).cursorCorrect,
      true
    )
    assert.equal(
      metrics({
        captureBackend: 'desktop-duplication',
        cursorRequested: true,
        cursorMode: 'separate',
        cursorPixelsSource: 'duplication-pointer-shape',
        cursorExclusionGuaranteed: true,
        cursorCompositedFrames: 20
      }).cursorCorrect,
      false
    )
    assert.equal(
      metrics({
        captureBackend: 'windows-graphics-capture-monitor',
        cursorRequested: true,
        cursorMode: 'excluded-wgc',
        cursorPixelsSource: 'excluded-by-windows-graphics-capture',
        cursorExclusionGuaranteed: true,
        cursorCompositedFrames: 0
      }).cursorCorrect,
      false
    )
  })

  it('marks requested output and encode-backend changes as unstable', () => {
    const summary = summarizeWindowsStreamDiagnosticSamples([
      {
        encoderBridgeRequestedVideoOutput: 'raw-yuv420p',
        encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
        encodeBackend: 'software-open-h264'
      },
      {
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'raw-yuv420p',
        encodeBackend: 'software-x264'
      }
    ])
    assert.equal(summary.fallbackChanged, true)

    const encodedBackendTransition = summarizeWindowsStreamDiagnosticSamples([
      {
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEncodedOutputBackend: 'media-foundation',
        encodeBackend: 'hardware-media-foundation'
      },
      {
        encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
        encoderBridgeEncodedOutputBackend: 'ffmpeg',
        encodeBackend: 'hardware-media-foundation'
      }
    ])
    assert.equal(encodedBackendTransition.fallbackChanged, true)
  })

  it('requires a full stable diagnostic schedule with monotonic stream counters', () => {
    const timeline = diagnosticTimelineFixture()
    assert.deepEqual(
      evaluateWindowsStreamDiagnosticTimeline(timeline, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }),
      {
        verdict: 'PASS',
        blockers: [],
        sessionId: 'session-1',
        separateOutputEncoders: false,
        sampling: timeline.sampling
      }
    )

    const sparse = structuredClone(timeline)
    sparse.samples.pop()
    assert.equal(
      evaluateWindowsStreamDiagnosticTimeline(sparse, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }).verdict,
      'BLOCKED'
    )

    const reset = structuredClone(timeline)
    reset.terminal.encoderBridgeStreamEncodedOutputFrames = 1
    assert.match(
      evaluateWindowsStreamDiagnosticTimeline(reset, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }).blockers.join('\n'),
      /counter encoderBridgeStreamEncodedOutputFrames decreased/
    )

    const encodedBackendTransition = structuredClone(timeline)
    encodedBackendTransition.terminal.encoderBridgeEncodedOutputBackend = 'ffmpeg'
    assert.match(
      evaluateWindowsStreamDiagnosticTimeline(encodedBackendTransition, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }).blockers.join('\n'),
      /encoderBridgeEncodedOutputBackend changed during measurement/
    )
  })

  it('requires stream-role diagnostics for split record-plus-stream output', () => {
    const timeline = diagnosticTimelineFixture()
    for (const sample of [...timeline.samples, timeline.terminal]) {
      sample.encoderBridgeSeparateOutputEncodersActive = true
      sample.encoderBridgeStreamDroppedFrames = sample.encoderBridgeDroppedFrames
      sample.encoderBridgeStreamEncoderSpeed = sample.encoderSpeed
    }
    assert.equal(
      evaluateWindowsStreamDiagnosticTimeline(timeline, {
        measurementMs: 3_000,
        intervalMs: 1_000,
        recordEnabled: true
      }).verdict,
      'PASS'
    )

    const topologyTransition = structuredClone(timeline)
    topologyTransition.samples[1].encoderBridgeSeparateOutputEncodersActive = false
    const topologyResult = evaluateWindowsStreamDiagnosticTimeline(topologyTransition, {
      measurementMs: 3_000,
      intervalMs: 1_000,
      recordEnabled: true
    })
    assert.equal(topologyResult.verdict, 'BLOCKED')
    assert.match(topologyResult.blockers.join('\n'), /topology changed during measurement/)
    assert.match(
      topologyResult.blockers.join('\n'),
      /did not prove separate output encoders throughout/
    )

    const missingStreamRole = structuredClone(timeline)
    delete missingStreamRole.samples[1].encoderBridgeStreamEncoderSpeed
    assert.match(
      evaluateWindowsStreamDiagnosticTimeline(missingStreamRole, {
        measurementMs: 3_000,
        intervalMs: 1_000,
        recordEnabled: true
      }).blockers.join('\n'),
      /encoderBridgeStreamEncoderSpeed/
    )
  })

  it('requires cadence and continuous app-role coverage for Windows process telemetry', () => {
    const telemetry = processTelemetryFixture()
    assert.equal(
      evaluateWindowsStreamProcessTelemetry(telemetry, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }).verdict,
      'PASS'
    )

    const missingGpu = structuredClone(telemetry)
    delete missingGpu.memory.summary.roles['electron-gpu']
    delete missingGpu.cpu.summary.byRole['electron-gpu']
    const blocked = evaluateWindowsStreamProcessTelemetry(missingGpu, {
      measurementMs: 3_000,
      intervalMs: 1_000
    })
    assert.equal(blocked.verdict, 'BLOCKED')
    assert.match(blocked.blockers.join('\n'), /electron-gpu/)

    const sparse = structuredClone(telemetry)
    sparse.sampling.collectedSamples = 2
    assert.equal(
      evaluateWindowsStreamProcessTelemetry(sparse, {
        measurementMs: 3_000,
        intervalMs: 1_000
      }).verdict,
      'BLOCKED'
    )
  })

  it('binds one live target to the complete receiver measurement interval', () => {
    const lifecycle = {
      snapshots: [
        targetSnapshot(900, 'connecting'),
        targetSnapshot(1_000, 'live'),
        targetSnapshot(1_500, 'live'),
        targetSnapshot(2_500, 'live'),
        targetSnapshot(3_500, 'live'),
        targetSnapshot(4_500, 'live')
      ],
      targetId: 'local-test',
      expectedSessionId: 'session-1',
      measurementStartedAtMs: 2_000,
      measurementEndedAtMs: 5_000,
      expectedMeasurementEndedAtMs: 5_000,
      intervalMs: 1_000,
      receiverAlive: true,
      pollingEvidence: { verdict: 'PASS', blockers: [] }
    }
    assert.equal(evaluateWindowsStreamTargetLifecycle(lifecycle).verdict, 'PASS')

    const failed = structuredClone(lifecycle)
    failed.snapshots.push(targetSnapshot(4_000, 'failed'))
    const result = evaluateWindowsStreamTargetLifecycle(failed)
    assert.equal(result.verdict, 'FAIL')
    assert.match(result.failures.join('\n'), /entered failed/)

    const late = structuredClone(lifecycle)
    late.measurementEndedAtMs = 6_001
    assert.equal(evaluateWindowsStreamTargetLifecycle(late).verdict, 'BLOCKED')

    const staleStart = structuredClone(lifecycle)
    staleStart.snapshots = [
      targetSnapshot(999, 'live'),
      targetSnapshot(2_500, 'live'),
      targetSnapshot(3_500, 'live'),
      targetSnapshot(4_500, 'live')
    ]
    const staleStartResult = evaluateWindowsStreamTargetLifecycle(staleStart)
    assert.equal(staleStartResult.verdict, 'BLOCKED')
    assert.match(staleStartResult.blockers.join('\n'), /start observation was older/)

    const noMeasuredObservation = structuredClone(lifecycle)
    noMeasuredObservation.snapshots = [targetSnapshot(1_000, 'live'), targetSnapshot(5_001, 'live')]
    const noMeasuredResult = evaluateWindowsStreamTargetLifecycle(noMeasuredObservation)
    assert.equal(noMeasuredResult.verdict, 'BLOCKED')
    assert.match(noMeasuredResult.blockers.join('\n'), /no observations during measurement/)

    const staleEnd = structuredClone(lifecycle)
    staleEnd.snapshots = [
      targetSnapshot(1_000, 'live'),
      targetSnapshot(1_500, 'live'),
      targetSnapshot(2_500, 'live'),
      targetSnapshot(3_500, 'live'),
      targetSnapshot(3_999, 'live')
    ]
    const staleEndResult = evaluateWindowsStreamTargetLifecycle(staleEnd)
    assert.equal(staleEndResult.verdict, 'BLOCKED')
    assert.match(staleEndResult.blockers.join('\n'), /end observation was older/)

    const wrongSession = structuredClone(lifecycle)
    wrongSession.snapshots[2].snapshot.sessionId = 'session-2'
    const wrongSessionResult = evaluateWindowsStreamTargetLifecycle(wrongSession)
    assert.equal(wrongSessionResult.verdict, 'BLOCKED')
    assert.match(wrongSessionResult.blockers.join('\n'), /one session identity/)

    const cachedEventOnly = structuredClone(lifecycle)
    cachedEventOnly.snapshots = cachedEventOnly.snapshots.map((event) => ({
      ...event,
      source: 'event'
    }))
    const cachedEventOnlyResult = evaluateWindowsStreamTargetLifecycle(cachedEventOnly)
    assert.equal(cachedEventOnlyResult.verdict, 'BLOCKED')
    assert.match(cachedEventOnlyResult.blockers.join('\n'), /not confirmed live/)
  })

  it('requires endurance drift pairs to span nearly the full measured window', () => {
    assert.deepEqual(
      windowsStreamAvDriftFitOptions({
        measurementMs: WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs
      }),
      { minPairs: 5, minSpanSec: 30 }
    )
    assert.deepEqual(
      windowsStreamAvDriftFitOptions({
        avEndurance: true,
        measurementMs: WINDOWS_STREAM_ENDURANCE_TIMING.measurementMs
      }),
      { minPairs: 5, minSpanSec: 540 }
    )
  })

  it('adapts measured process and proof-surface samples to the canonical budget schema', () => {
    const telemetry = {
      memory: { summary: { maxTotalRssKb: 123 } },
      cpu: {
        samples: [
          { byRole: { backend: 20, 'electron-main': 10 } },
          { byRole: { backend: 60, 'electron-main': 20 } }
        ],
        summary: { byRole: { backend: { p95Percent: 60 } } }
      }
    }
    const adapted = summarizeWindowsStreamBudgetProcessTelemetry(telemetry)
    assert.equal(adapted.cpu.summary.totalP95Percent, 80)
    assert.equal(telemetry.cpu.summary.totalP95Percent, undefined)

    const samples = [
      {
        previewImagePollCounts: { screenBmp: 100, liveJpeg: 3 },
        previewSurfaceStatus: { framesRendered: 500, intervalP95Ms: 90 }
      },
      {
        previewImagePollCounts: { screenBmp: 120, liveJpeg: 3 },
        previewSurfaceStatus: { framesRendered: 680, intervalP95Ms: 110 }
      }
    ]
    assert.deepEqual(summarizeWindowsStreamBmpBudgetMetrics(samples, true), {
      requestCount: 20,
      bytes: null,
      intervalP95Ms: 110,
      advancedFrames: 180
    })
    assert.deepEqual(
      summarizeWindowsStreamBmpBudgetMetrics(
        samples.map((sample) => ({
          ...sample,
          previewImagePollCounts: { screenBmp: 100, liveJpeg: 3 }
        })),
        false
      ),
      {
        requestCount: 0,
        bytes: 0,
        intervalP95Ms: 110,
        advancedFrames: 180
      }
    )
  })
})

describe('Windows stream performance hardware budgets', () => {
  it('loads exactly one reviewed profile matching scenario, host, build, and timing', async () => {
    const loaded = await loadWindowsStreamPerformanceBudget({
      path: 'C:/acceptance/windows-stream-budget.json',
      context: budgetContext(),
      read: async () => JSON.stringify(budgetDocument()),
      verifyArtifact: trustExpectedArtifactDigest
    })
    assert.equal(loaded.profile.id, 'lab-a-1080p30-stream-preview')
    assert.equal(loaded.document.candidateSha256, 'b'.repeat(64))

    await assert.rejects(
      loadWindowsStreamPerformanceBudget({
        path: 'C:/acceptance/windows-stream-budget.json',
        context: { ...budgetContext(), hardwareClass: 'other-device' },
        read: async () => JSON.stringify(budgetDocument()),
        verifyArtifact: trustExpectedArtifactDigest
      }),
      /did not contain a profile/
    )
  })

  it('rejects unreviewed, duplicate, or incomplete three-run calibration evidence', () => {
    const document = budgetDocument()
    document.status = 'draft'
    document.profiles[0].evidence.reportPaths = ['one.json', 'one.json']
    assert.deepEqual(validateWindowsStreamPerformanceBudget(document), [
      'status must be active',
      'profile 1 evidence must retain three report paths'
    ])
  })

  it('rejects legacy or OS-unbound budgets for the protected stream gate', async () => {
    const legacy = budgetDocument()
    delete legacy.comparison
    delete legacy.candidateSha256
    delete legacy.reviewedBy
    delete legacy.reviewedAt
    delete legacy.profiles[0].candidateSha256
    delete legacy.profiles[0].scope.operatingSystem.release
    assert.match(
      validateWindowsStreamPerformanceBudget(legacy).join('\n'),
      /comparison-bound budget evidence was missing/
    )

    const wrongRelease = budgetDocument()
    wrongRelease.profiles[0].scope.operatingSystem.release = '10.0.other'
    await assert.rejects(
      loadWindowsStreamPerformanceBudget({
        path: 'C:/acceptance/windows-stream-budget.json',
        profileId: 'lab-a-1080p30-stream-preview',
        context: budgetContext(),
        read: async () => JSON.stringify(wrongRelease),
        verifyArtifact: trustExpectedArtifactDigest
      }),
      /operatingSystem.release/
    )
  })

  it('keeps CPU/RSS resource thresholds inclusive and fails beyond them', () => {
    const profile = budgetDocument().profiles[0]
    assert.deepEqual(evaluateWindowsStreamResourceBudget(profile, budgetMetrics()), [])

    const metrics = budgetMetrics()
    metrics.processTree.memory.summary.maxTotalRssKb += 1
    metrics.processTree.cpu.summary.byRole.backend.p95Percent += 0.001
    assert.deepEqual(evaluateWindowsStreamResourceBudget(profile, metrics), [
      'total process-tree RSS 2097153 exceeded 2097152',
      'backend p95 CPU 90.001 exceeded 90'
    ])
  })
})

describe('Windows stream performance modes and evidence verdicts', () => {
  it('rejects ambient path selection and clears every selection key before runner-owned flags', () => {
    const inherited = Object.fromEntries(
      WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.map((name) => [name, 'ambient-selection'])
    )
    assert.throws(
      () => assertWindowsStreamSelectionEnvironmentIsRunnerOwned(inherited),
      new RegExp(`stream runner owns it: ${WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.join(', ')}`)
    )
    const automatic = windowsStreamSelectionEnvironmentOverlay()
    assert.deepEqual(
      automatic,
      Object.fromEntries(WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.map((name) => [name, undefined]))
    )
    const forced = windowsStreamSelectionEnvironmentOverlay({
      VIDEORC_WINDOWS_D3D11_MEDIA: '1',
      VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1'
    })
    assert.deepEqual(forced, {
      ...automatic,
      VIDEORC_WINDOWS_D3D11_MEDIA: '1',
      VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1'
    })
  })
  it('defaults to the complete protected gate and keeps calibration/single-scenario non-release', () => {
    const gate = parseWindowsStreamPerformanceArgs([])
    assert.equal(gate.mode, 'gate')
    assert.equal(gate.scenarios.length, 19)
    assert.equal(gate.repetitions, null)
    assert.equal(resolveWindowsStreamPathEvidence(gate), 'default')

    const calibration = parseWindowsStreamPerformanceArgs([
      '--calibrate',
      '--scenario',
      '1080p30-stream-preview'
    ])
    assert.equal(calibration.mode, 'calibrate')
    assert.equal(calibration.scenarios.length, 1)
    assert.equal(calibration.repetitions, 1)

    const diagnostic = parseWindowsStreamPerformanceArgs(['--scenario', '1080p30-stream-preview'])
    assert.equal(diagnostic.mode, 'diagnostic')
    assert.equal(diagnostic.repetitions, 1)

    const youtube = parseWindowsStreamPerformanceArgs([
      '--calibrate',
      '--scenario',
      'youtube-1080p60'
    ])
    assert.equal(youtube.scenarios[0].bitrateKbps, 12_000)
    assert.equal(youtube.scenarios[0].videoPreset, 'stream-youtube-1080p60')

    const fallback = parseWindowsStreamPerformanceArgs([
      '--calibrate',
      '--scenario',
      '1080p30-stream-preview',
      '--expect-fallback',
      'software-open-h264'
    ])
    assert.equal(fallback.bridge, 'mf')
    assert.equal(fallback.expectFallback, 'software-open-h264')

    const forcedD3d11 = parseWindowsStreamPerformanceArgs([
      '--calibrate',
      '--profiles',
      '1080p30,1080p60',
      '--bridge',
      'mf',
      '--require-bridge',
      '--d3d11',
      '--require-d3d11',
      '--path-evidence',
      'forced'
    ])
    assert.equal(forcedD3d11.scenarios.length, 19)
    assert.deepEqual(forcedD3d11.profiles, ['1080p30', '1080p60'])
    assert.equal(forcedD3d11.requireD3d11, true)
    assert.equal(forcedD3d11.pathEvidence, 'forced')
    assert.equal(resolveWindowsStreamPathEvidence(forcedD3d11), 'forced')

    const naturalD3d11Fallback = parseWindowsStreamPerformanceArgs([
      '--gate',
      '--profiles',
      '1080p30',
      '--expect-fallback',
      'natural',
      '--path-evidence',
      'natural'
    ])
    assert.equal(naturalD3d11Fallback.expectFallback, 'natural')
    assert.equal(naturalD3d11Fallback.d3d11, false)
    assert.equal(resolveWindowsStreamPathEvidence(naturalD3d11Fallback), 'natural')
    assert.deepEqual(
      naturalD3d11Fallback.scenarios.map((scenario) => scenario.id),
      [
        '1080p30-stream-preview',
        '1080p30-stream-no-preview',
        '1080p30-record-stream-preview',
        '1080p30-record-stream-no-preview'
      ]
    )

    const prepare = parseWindowsStreamPerformanceArgs(['--prepare-premium-profile'])
    assert.equal(prepare.mode, 'prepare-premium-profile')
    assert.equal(prepare.scenarios.length, 0)

    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--gate', '--calibrate']),
      /mutually exclusive/
    )
    const fullCalibration = parseWindowsStreamPerformanceArgs([
      '--calibrate',
      '--bridge',
      'mf',
      '--require-bridge'
    ])
    assert.equal(fullCalibration.mode, 'calibrate')
    assert.equal(fullCalibration.scenarios.length, 19)
    assert.equal(fullCalibration.repetitions, null)
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--runs', '1']),
      /fixed repetition count/
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--gate', '--bridge', 'raw']),
      /cannot use --bridge raw/
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--video-only']),
      /requires audible A\/V evidence/
    )
    assert.throws(
      () =>
        parseWindowsStreamPerformanceArgs([
          '--scenario',
          '1080p30-stream-preview',
          '--expect-fallback',
          'unknown'
        ]),
      /must be software-open-h264/
    )
    assert.throws(() => parseWindowsStreamPerformanceArgs(['--require-d3d11']), /requires --d3d11/)
    assert.throws(
      () =>
        parseWindowsStreamPerformanceArgs([
          '--d3d11',
          '--require-d3d11',
          '--path-evidence',
          'default'
        ]),
      /automatic capability selection/
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--profiles', '1080p30,1080p30']),
      /Duplicate Windows stream profile/
    )
    assert.throws(
      () =>
        parseWindowsStreamPerformanceArgs([
          '--prepare-premium-profile',
          '--scenario',
          'youtube-1080p60'
        ]),
      /cannot be combined/
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--scenario', 'missing']),
      /Unknown Windows stream performance scenario/
    )
  })

  it('parses only one literal absolute natural-fallback derivation root', () => {
    const parsed = parseWindowsStreamPerformanceArgs([
      '--derive-natural-fallback-policy',
      '--fallback-calibrations',
      '/evidence/fallback/windows-stream-performance/' + '3'.repeat(64),
      '--budget',
      'docs/acceptance/windows-d3d11-performance-budget.json'
    ])
    assert.equal(parsed.mode, 'derive-natural-fallback-policy')
    assert.equal(parsed.deriveNaturalFallbackPolicy, true)
    assert.equal(parsed.scenarios.length, 0)

    for (const root of [
      'evidence/candidate',
      '/evidence/*/candidate',
      '/evidence/one,/evidence/two',
      '~/evidence/candidate',
      '<evidence>/candidate'
    ]) {
      assert.throws(
        () =>
          parseWindowsStreamPerformanceArgs([
            '--derive-natural-fallback-policy',
            '--fallback-calibrations',
            root,
            '--budget',
            'budget.json'
          ]),
        /absolute|aliases|exactly one/
      )
    }
    assert.throws(
      () =>
        parseWindowsStreamPerformanceArgs([
          '--derive-natural-fallback-policy',
          '--fallback-calibrations',
          '/evidence/' + '3'.repeat(64),
          '--budget',
          'budget.json',
          '--gate'
        ]),
      /cannot be combined/
    )
    assert.throws(
      () => parseWindowsStreamPerformanceArgs(['--fallback-calibrations', '/evidence/root']),
      /require --derive-natural-fallback-policy/
    )
  })

  it('accepts complete evidence and rejects malformed schema fields', () => {
    assert.deepEqual(validateWindowsStreamRunEvidence(passingEvidence()), [])

    const invalid = passingEvidence()
    invalid.schemaVersion = 2
    invalid.candidate.sha256 = 'not-a-digest'
    invalid.artifacts.supportBundle = ''
    assert.deepEqual(validateWindowsStreamRunEvidence(invalid), [
      'schemaVersion must be 1',
      'candidate.sha256 must be a lowercase SHA-256 digest',
      'artifacts.supportBundle was missing'
    ])

    const wrongIdentityKind = passingEvidence()
    wrongIdentityKind.candidate.packagePayload.components[0].identityKind = 'codesign-cdhash'
    assert.deepEqual(validateWindowsStreamRunEvidence(wrongIdentityKind), [
      'candidate.packagePayload.components did not bind every packaged executable'
    ])

    const wrongIdentity = passingEvidence()
    wrongIdentity.candidate.packagePayload.components[0].identity = 'f'.repeat(64)
    assert.deepEqual(validateWindowsStreamRunEvidence(wrongIdentity), [
      'candidate.packagePayload.components did not bind every packaged executable'
    ])

    const wrongManifest = passingEvidence()
    wrongManifest.candidate.packagePayload.sha256 = 'f'.repeat(64)
    assert.deepEqual(validateWindowsStreamRunEvidence(wrongManifest), [
      'candidate.packagePayload.sha256 did not match the canonical payload manifest'
    ])
  })

  it('classifies missing audible stimulus, support bundle, or active gate budget as BLOCKED', () => {
    const noAudio = passingEvidence()
    noAudio.stimulus.audio.started = false
    noAudio.avSync.measured = false
    noAudio.avSync.driftBinding = false
    assert.deepEqual(evaluateWindowsStreamRun(noAudio), {
      verdict: 'BLOCKED',
      failures: [],
      blockers: [
        'audible A/V alignment stimulus did not start',
        'A/V alignment evidence was not measured'
      ]
    })

    const noBundle = passingEvidence()
    noBundle.artifacts.supportBundle = null
    assert.equal(evaluateWindowsStreamRun(noBundle).verdict, 'BLOCKED')
    assert.match(evaluateWindowsStreamRun(noBundle).blockers.join('\n'), /support bundle/)

    const noBudget = passingEvidence()
    noBudget.budget.active = false
    noBudget.budget.applicable = false
    assert.equal(evaluateWindowsStreamRun(noBudget).verdict, 'BLOCKED')
    assert.match(evaluateWindowsStreamRun(noBudget).blockers.join('\n'), /active applicable/)

    const bypassedBudget = passingEvidence()
    bypassedBudget.budget.required = false
    assert.equal(evaluateWindowsStreamRun(bypassedBudget).verdict, 'BLOCKED')
    assert.match(evaluateWindowsStreamRun(bypassedBudget).blockers.join('\n'), /active applicable/)

    const noGpu = passingEvidence()
    noGpu.artifacts.gpuSamples = null
    noGpu.process.gpuVerdict = 'BLOCKED'
    assert.equal(evaluateWindowsStreamRun(noGpu).verdict, 'BLOCKED')
    assert.match(evaluateWindowsStreamRun(noGpu).blockers.join('\n'), /GPU/)

    const noPixelProof = passingEvidence()
    noPixelProof.artifacts.captureProtection = null
    noPixelProof.captureProtection = null
    assert.equal(evaluateWindowsStreamRun(noPixelProof).verdict, 'BLOCKED')
    assert.match(
      evaluateWindowsStreamRun(noPixelProof).blockers.join('\n'),
      /capture-protection pixel evidence/
    )
  })

  it('enforces projected A/V drift only on the ten-minute endurance scenario', () => {
    const regular = passingEvidence()
    regular.avSync.driftBinding = false
    regular.avSync.projectedDriftMsPer30Min = null
    assert.equal(evaluateWindowsStreamRun(regular).verdict, 'PASS')

    const endurance = passingEvidence('1080p60-av-endurance')
    endurance.avSync.driftBinding = false
    endurance.avSync.projectedDriftMsPer30Min = null
    const unbound = evaluateWindowsStreamRun(endurance)
    assert.equal(unbound.verdict, 'BLOCKED')
    assert.match(unbound.blockers.join('\n'), /A\/V drift could not be bound/)

    const drifting = passingEvidence('1080p60-av-endurance')
    drifting.avSync.projectedDriftMsPer30Min =
      WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumProjectedDriftMsPer30Min + 1
    const overCeiling = evaluateWindowsStreamRun(drifting)
    assert.equal(overCeiling.verdict, 'FAIL')
    assert.match(overCeiling.failures.join('\n'), /projected A\/V drift/)
  })

  it('redacts standalone stream keys and complete RTMP URLs in nested failure evidence', () => {
    const streamKey = 'generated-key-that-must-not-leak'
    const listenerUrl = `rtmp://127.0.0.1:1935/live/${streamKey}`
    const redacted = redactWindowsStreamSecrets(
      {
        message: `receiver rejected ${listenerUrl}; key=${streamKey}`,
        nested: {
          stderr: `Failed to open rtmps://stream.example.test/app/${streamKey}`
        }
      },
      [streamKey]
    )

    const serialized = JSON.stringify(redacted)
    assert.doesNotMatch(serialized, /generated-key-that-must-not-leak/)
    assert.doesNotMatch(serialized, /rtmps?:\/\//)
    assert.match(serialized, /redacted-stream-secret/)
    assert.match(serialized, /redacted-rtmp-url/)
    assert.deepEqual(windowsStreamSecretLeaks(redacted, [streamKey]), [])
    assert.deepEqual(windowsStreamSecretLeaks({ opaqueMessage: streamKey }, [streamKey]), [
      streamKey
    ])
  })

  it('keeps all threshold boundaries inclusive and fails immediately beyond each one', () => {
    const boundary = passingEvidence()
    assert.equal(evaluateWindowsStreamRun(boundary).verdict, 'PASS')

    const cases = [
      ['duration', (value) => (value.media.durationSeconds = 183.601), /duration/],
      ['frame count', (value) => (value.media.frameCount = 5_509), /frame count/],
      ['fps', (value) => (value.media.fps = 30.011), /fps/],
      ['frame gap', (value) => (value.media.maxFrameGapMs = 100.001), /frame gap/],
      ['freeze', (value) => (value.media.longestCorroboratedFreezeMs = 100.001), /freeze/],
      ['repeat run', (value) => (value.media.maxRepeatedFrameRun = 3), /repeated-frame/],
      ['duplicate PTS count', (value) => (value.media.duplicatePtsCount = 3), /duplicate PTS/],
      ['duplicate PTS run', (value) => (value.media.maxDuplicatePtsRun = 3), /duplicate PTS/],
      ['GOP', (value) => (value.media.maxKeyframeIntervalSeconds = 2.001), /keyframe/],
      [
        'queue loss',
        (value) => {
          value.pipeline.submittedFrames = 999
          value.pipeline.coalescedFrames = 1
        },
        /coalesced plus dropped/
      ],
      ['encoder speed', (value) => (value.pipeline.encoderSpeedP05 = 0.979), /encoder speed/],
      [
        'rolling bitrate low',
        (value) =>
          (value.network.rollingBitrateKbps = [
            value.network.targetBitrateKbps *
              WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.minimumRollingBitrateRatio -
              1
          ]),
        /rolling receiver bitrate/
      ],
      [
        'rolling bitrate high',
        (value) =>
          (value.network.rollingBitrateKbps = [
            value.network.targetBitrateKbps *
              WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumRollingBitrateRatio +
              1
          ]),
        /rolling receiver bitrate/
      ],
      [
        'total bitrate',
        (value) =>
          (value.network.measuredBitrateKbps =
            value.network.targetBitrateKbps *
              (1 - WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.totalBitrateToleranceRatio) -
            1),
        /total bitrate/
      ],
      ['A/V median', (value) => (value.avSync.medianAbsoluteOffsetMs = 60.001), /median/],
      ['A/V max', (value) => (value.avSync.maxAbsoluteOffsetMs = 150.001), /maximum/]
    ]

    for (const [label, mutate, expected] of cases) {
      const evidence = passingEvidence()
      mutate(evidence)
      const verdict = evaluateWindowsStreamRun(evidence)
      assert.equal(verdict.verdict, 'FAIL', label)
      assert.match(verdict.failures.join('\n'), expected, label)
    }
  })

  it('enforces Media Foundation counters, color tags, fallback stability, and process lifetime', () => {
    const cases = [
      [(value) => (value.media.colorPrimaries = 'bt470bg'), /BT.709/],
      [(value) => (value.pipeline.rawVideoCopiedFrames = 1), /rawVideoCopiedFrames/],
      [(value) => (value.pipeline.encodedFrames = 0), /encoded frames/],
      [(value) => (value.pipeline.encodedBytes = 0), /encoded bytes/],
      [(value) => (value.pipeline.fallbackChanged = true), /changed mid-run/],
      [
        (value) => {
          value.pipeline.fallbackReason = 'hardware transform rejected input'
          value.pipeline.fallbackAcknowledged = false
        },
        /unacknowledged fallback/
      ],
      [(value) => (value.network.reconnects = 1), /reconnect/],
      [(value) => (value.process.teardownClean = false), /process teardown/]
    ]
    for (const [mutate, expected] of cases) {
      const evidence = passingEvidence()
      mutate(evidence)
      const verdict = evaluateWindowsStreamRun(evidence)
      assert.equal(verdict.verdict, 'FAIL')
      assert.match(verdict.failures.join('\n'), expected)
    }
  })

  it('binds camera uploads to the protected source-composition scenario', () => {
    const screenOnly = passingD3d11Evidence('1080p30-stream-preview')
    assert.equal(evaluateWindowsStreamRun(screenOnly).verdict, 'PASS')
    screenOnly.pipeline.d3d11.cameraUploadFrames = 1
    assert.match(
      evaluateWindowsStreamRun(screenOnly).failures.join('\n'),
      /D3D11 camera upload frames/
    )

    const screenCamera = passingD3d11Evidence('1080p30-screen-camera-stream-preview')
    assert.equal(evaluateWindowsStreamRun(screenCamera).verdict, 'PASS')
    screenCamera.pipeline.d3d11.cameraUploadFrames = 0
    assert.match(
      evaluateWindowsStreamRun(screenCamera).failures.join('\n'),
      /D3D11 camera upload frames/
    )
  })

  it('validates automatic live D3D11 and every role adapter when required=false', () => {
    const automatic = passingD3d11Evidence('1080p30-stream-preview')
    automatic.pipeline.requireD3d11 = false
    automatic.pipeline.expectedD3d11Path = 'default'
    automatic.pipeline.d3d11.required = false
    assert.equal(evaluateWindowsStreamRun(automatic).verdict, 'PASS')

    automatic.pipeline.d3d11.captureAdapterLuid = '0000000000000043'
    const mismatch = evaluateWindowsStreamRun(automatic)
    assert.equal(mismatch.verdict, 'FAIL')
    assert.match(mismatch.failures.join('\n'), /captureAdapterLuid.*media authority/)
  })

  it('fails closed on media-thread starvation or synchronization timeouts', () => {
    const evidence = passingD3d11Evidence('1080p30-stream-preview')
    evidence.pipeline.d3d11.mediaCommandLagMaxMs = 101
    evidence.pipeline.d3d11.maximumConsecutiveMediaBatch = 33
    evidence.pipeline.d3d11.synchronizationTimeouts = 1

    const result = evaluateWindowsStreamRun(evidence)
    assert.equal(result.verdict, 'FAIL')
    assert.match(result.failures.join('\n'), /media command maximum/)
    assert.match(result.failures.join('\n'), /maximumConsecutiveMediaBatch/)
    assert.match(result.failures.join('\n'), /synchronization timeouts/)
  })

  it('requires the auxiliary adapter identity only for split record-plus-stream output', () => {
    const split = passingD3d11Evidence('1080p30-record-stream-preview')
    assert.equal(evaluateWindowsStreamRun(split).verdict, 'PASS')
    split.pipeline.d3d11.auxiliaryEncoderAdapterLuid = null
    assert.match(
      evaluateWindowsStreamRun(split).failures.join('\n'),
      /auxiliaryEncoderAdapterLuid.*split output/
    )

    const streamOnly = passingD3d11Evidence('1080p30-stream-preview')
    streamOnly.pipeline.d3d11.auxiliaryEncoderAdapterLuid = null
    assert.equal(evaluateWindowsStreamRun(streamOnly).verdict, 'PASS')
  })

  it('requires real OS input evidence only when the D3D11 preview is open', () => {
    const open = passingD3d11Evidence('1080p30-stream-preview')
    assert.equal(evaluateWindowsStreamRun(open).verdict, 'PASS')
    open.pipeline.d3d11.inputContinuityEvidence.physicalInput = false
    assert.match(evaluateWindowsStreamRun(open).failures.join('\n'), /physical-input execution/)

    const closed = passingD3d11Evidence('1080p30-stream-no-preview')
    assert.equal(evaluateWindowsStreamRun(closed).verdict, 'PASS')
    closed.pipeline.d3d11.inputContinuityEvidence.applicable = true
    assert.match(
      evaluateWindowsStreamRun(closed).failures.join('\n'),
      /closed-preview input applicability/
    )
  })

  it('derives preview input PASS only from click, type, drag, focus, and advancing presenter proof', () => {
    const before = {
      initialBounds: { x: 100, y: 100, width: 960, height: 540 },
      presenter: { lastPresentedSequence: 50 }
    }
    const after = {
      state: {
        clicks: 1,
        focusEvents: 1,
        inputEvents: 9,
        value: 'VIDEORC42',
        activeElementId: 'videorc-windows-preview-input-target'
      },
      bounds: { x: 148, y: 136, width: 960, height: 540 },
      previewFocused: true,
      webContentsFocused: true,
      presenter: {
        windowActive: false,
        windowFocused: false,
        firstPresentSucceeded: true,
        sourceLive: true,
        lastPresentedSequence: 60
      }
    }
    assert.equal(
      evaluateWindowsD3d11PreviewInputContinuity({
        applicable: true,
        before,
        after
      }).verdict,
      'PASS'
    )

    after.presenter.windowFocused = true
    after.presenter.lastPresentedSequence = 50
    after.state.value = 'not-the-probe-value'
    const failed = evaluateWindowsD3d11PreviewInputContinuity({
      applicable: true,
      before,
      after
    })
    assert.equal(failed.verdict, 'FAIL')
    assert.match(failed.blockers.join('\n'), /keyboard sequence/)
    assert.match(failed.blockers.join('\n'), /activated or took focus/)
    assert.match(failed.blockers.join('\n'), /did not remain live and advance/)
    assert.deepEqual(evaluateWindowsD3d11PreviewInputContinuity({ applicable: false }), {
      verdict: 'NOT_REQUIRED',
      applicable: false,
      physicalInput: false,
      blockers: []
    })
  })

  it('refuses a gate PASS when requested or effective bridge is raw', () => {
    const requestedRaw = passingEvidence()
    requestedRaw.pipeline.requestedBridgeOutput = 'raw-yuv420p'
    assert.match(evaluateWindowsStreamRun(requestedRaw).failures.join('\n'), /requested bridge/)

    const effectiveRaw = passingEvidence()
    effectiveRaw.pipeline.effectiveBridgeOutput = 'raw-yuv420p'
    effectiveRaw.pipeline.effectiveEncodeBackend = 'software-open-h264'
    assert.match(evaluateWindowsStreamRun(effectiveRaw).failures.join('\n'), /effective bridge/)
  })

  it('requires the named natural OpenH264 fallback path and a stable reason', () => {
    const evidence = passingEvidence()
    evidence.mode = 'calibrate'
    evidence.pipeline = {
      ...evidence.pipeline,
      expectedFallback: 'software-open-h264',
      effectiveBridgeOutput: 'raw-yuv420p',
      effectiveEncodeBackend: 'software-open-h264',
      fallbackReason: 'Media Foundation production topology probe rejected the adapter',
      fallbackAcknowledged: true,
      encodedFrames: 0,
      encodedBytes: 0
    }
    assert.equal(evaluateWindowsStreamRun(evidence).verdict, 'PASS')

    evidence.pipeline.effectiveEncodeBackend = 'software-x264'
    assert.match(evaluateWindowsStreamRun(evidence).failures.join('\n'), /fallback encode backend/)
  })

  it('only emits release PASS for the complete three-repetition gate matrix', () => {
    const fullRuns = buildWindowsStreamPerformanceMatrix().flatMap((scenario) =>
      Array.from({ length: scenario.repetitions }, (_, index) => ({
        scenarioId: scenario.id,
        repetition: index + 1,
        verdict: 'PASS'
      }))
    )
    assert.deepEqual(evaluateWindowsStreamAggregate({ mode: 'gate', runs: fullRuns }), {
      verdict: 'PASS',
      failures: [],
      blockers: []
    })
    assert.equal(
      evaluateWindowsStreamAggregate({ mode: 'calibrate', runs: [fullRuns[0]] }).verdict,
      'CALIBRATION'
    )
    assert.equal(
      evaluateWindowsStreamAggregate({ mode: 'calibrate', runs: fullRuns }).verdict,
      'CALIBRATION'
    )
    assert.equal(
      evaluateWindowsStreamAggregate({ mode: 'gate', runs: [fullRuns[0]] }).verdict,
      'BLOCKED'
    )
    assert.equal(
      evaluateWindowsStreamAggregate({ mode: 'gate', runs: fullRuns.slice(0, -1) }).verdict,
      'BLOCKED'
    )
    assert.match(
      evaluateWindowsStreamAggregate({ mode: 'gate', runs: [fullRuns[0]] }).blockers.join('\n'),
      /complete fixed matrix/
    )
  })
})

describe('Windows natural fallback policy derivation', () => {
  it('atomically attaches immutable twelve-run evidence without self-activation', async () => {
    const fixture = await naturalFallbackDerivationFixture()
    try {
      const command = runNaturalFallbackDerivation(fixture)
      assert.equal(command.status, 0, command.stderr)
      const updatedBytes = await readFile(fixture.budgetPath)
      const updated = JSON.parse(updatedBytes)
      assert.equal(updated.status, 'draft')
      assert.equal(updated.activation.allowed, false)
      assert.equal(updated.naturalFallbackPolicy.evidence.reportPaths.length, 12)
      assert.deepEqual(updated.naturalFallbackPolicy.scope.topologies, [
        'stream-only',
        'record-plus-stream'
      ])
      assert.deepEqual(updated.naturalFallbackPolicy.scope.previewModes, ['open', 'closed'])

      const duplicate = runNaturalFallbackDerivation(fixture)
      assert.equal(duplicate.status, 1)
      assert.match(duplicate.stderr, /already attached/)
      assert.deepEqual(await readFile(fixture.budgetPath), updatedBytes)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects candidate-root, hardware, and retained-report digest mismatches', async () => {
    for (const mutation of ['candidate-root', 'hardware', 'report-digest']) {
      const fixture = await naturalFallbackDerivationFixture()
      try {
        if (mutation === 'candidate-root') {
          const wrongRoot = join(fixture.directory, 'wrong-candidate-root')
          await rename(fixture.root, wrongRoot)
          fixture.root = wrongRoot
        } else {
          const aggregate = JSON.parse(await readFile(fixture.aggregatePath, 'utf8'))
          if (mutation === 'hardware') {
            aggregate.hardwareClass = 'nvidia-turing-floor'
          } else {
            aggregate.runs[0].reportSha256 = 'f'.repeat(64)
          }
          await writeFile(fixture.aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
        }
        const before = await readFile(fixture.budgetPath)
        const command = runNaturalFallbackDerivation(fixture)
        assert.equal(command.status, 1, `${mutation}: ${command.stderr}`)
        assert.deepEqual(await readFile(fixture.budgetPath), before)
      } finally {
        await rm(fixture.directory, { recursive: true, force: true })
      }
    }
  })
})

describe('Windows capture-protection pixel evidence', () => {
  const placementReadiness = { verdict: 'PASS', blockers: [] }

  it('passes only when the marker is absent and the underlying stimulus is present', () => {
    const roles = {
      main: {
        expectedFrames: 4,
        markerMetrics: { sampledFrames: 4, maxMarkerPixelRatio: 0.001 },
        stimulusVisibility: temporalVisibility(4)
      },
      comments: {
        expectedFrames: 4,
        markerMetrics: { sampledFrames: 4, maxMarkerPixelRatio: 0 },
        stimulusVisibility: temporalVisibility(4)
      }
    }
    assert.equal(
      evaluateWindowsCaptureProtectionEvidence({
        roles,
        placementReadiness,
        requiredRoles: Object.keys(roles)
      }).verdict,
      'PASS'
    )
    assert.equal(
      evaluateWindowsCaptureProtectionEvidence({
        placementReadiness,
        requiredRoles: Object.keys(roles),
        roles: {
          ...roles,
          main: {
            ...roles.main,
            markerMetrics: { sampledFrames: 4, maxMarkerPixelRatio: 0.0021 }
          }
        }
      }).verdict,
      'FAIL'
    )
    assert.equal(
      evaluateWindowsCaptureProtectionEvidence({
        placementReadiness,
        requiredRoles: Object.keys(roles),
        roles: {
          ...roles,
          comments: {
            ...roles.comments,
            stimulusVisibility: { visible: false, reason: 'black exclusion rectangle' }
          }
        }
      }).verdict,
      'BLOCKED'
    )
    assert.match(
      evaluateWindowsCaptureProtectionEvidence({
        roles,
        placementReadiness,
        requiredRoles: ['main', 'comments', 'notes']
      }).blockers.join('\n'),
      /missing required window roles: notes/
    )
  })

  it('detects material role-marker pixels at the established near-zero threshold', () => {
    const rgb = Buffer.alloc(10 * 10 * 3)
    const marker = WINDOWS_CAPTURE_PROTECTION_MARKERS.main
    const channels = [0x8b, 0x1e, 0x3f]
    for (let index = 0; index < 3; index += 1) rgb[index] = channels[index]
    const metrics = measureWindowsCaptureProtectionMarkerPixels(rgb, {
      marker,
      width: 10,
      height: 10
    })
    assert.equal(metrics.sampledFrames, 1)
    assert.equal(metrics.maxMarkerPixelRatio, 0.01)
    assert.equal(
      evaluateWindowsCaptureProtectionEvidence({
        placementReadiness,
        requiredRoles: ['main'],
        roles: {
          main: {
            expectedFrames: 1,
            markerMetrics: metrics,
            stimulusVisibility: temporalVisibility(1)
          }
        }
      }).verdict,
      'FAIL'
    )
  })

  it('blocks when protected-window placement continuity was not proved', () => {
    const roles = {
      main: {
        expectedFrames: 4,
        markerMetrics: { sampledFrames: 4, maxMarkerPixelRatio: 0 },
        stimulusVisibility: temporalVisibility(4)
      }
    }
    const missing = evaluateWindowsCaptureProtectionEvidence({
      roles,
      requiredRoles: ['main']
    })
    assert.equal(missing.verdict, 'BLOCKED')
    assert.match(missing.blockers.join('\n'), /placement continuity was not proved/)

    const interrupted = evaluateWindowsCaptureProtectionEvidence({
      roles,
      placementReadiness: {
        verdict: 'BLOCKED',
        blockers: ['comments: window was not visible']
      },
      requiredRoles: ['main']
    })
    assert.equal(interrupted.verdict, 'BLOCKED')
    assert.match(interrupted.blockers.join('\n'), /comments: window was not visible/)
  })

  it('blocks marker scans that do not cover every decoded frame', () => {
    const result = evaluateWindowsCaptureProtectionEvidence({
      placementReadiness,
      requiredRoles: ['main'],
      roles: {
        main: {
          expectedFrames: 120,
          markerMetrics: { sampledFrames: 119, maxMarkerPixelRatio: 0 },
          stimulusVisibility: temporalVisibility(120)
        }
      }
    })
    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /pixel coverage 119\/120/)
  })

  it('maps a negative-origin physical display into the fixed 1080p evidence crop', () => {
    const bounds = parseWindowsStreamDisplayBounds('-2560,120,2560,1440')
    const electronDisplay = { id: 42, bounds, scaleFactor: 1 }
    assert.deepEqual(bounds, { x: -2560, y: 120, width: 2560, height: 1440 })
    assert.deepEqual(windowsStreamCaptureProtectionPlacement(bounds, { electronDisplay }), {
      displayBinding: { id: '42', bounds, scaleFactor: 1 },
      motion: { x: -2560, y: 120, width: 2560, height: 1440 },
      av: { x: -2539, y: 1053, width: 1173, height: 480 },
      windows: {
        main: { x: -2539, y: 141, width: 1280, height: 880 },
        comments: { x: -627, y: 152, width: 560, height: 480 },
        notes: { x: -627, y: 643, width: 560, height: 400 },
        captions: { x: -1320, y: 1093, width: 560, height: 400 },
        preview: { x: -627, y: 1093, width: 560, height: 400 }
      },
      crops: {
        main: { x: 40, y: 40, width: 300, height: 220 },
        comments: { x: 1490, y: 64, width: 300, height: 220 },
        notes: { x: 1490, y: 432, width: 300, height: 220 },
        captions: { x: 970, y: 770, width: 300, height: 220 },
        preview: { x: 1490, y: 770, width: 300, height: 220 },
        'proof-surface': { x: 1490, y: 770, width: 300, height: 220 }
      },
      cropBounds: {
        main: { x: -2507, y: 173, width: 400, height: 293 },
        comments: { x: -573, y: 205, width: 400, height: 293 },
        notes: { x: -573, y: 696, width: 400, height: 293 },
        captions: { x: -1267, y: 1147, width: 400, height: 293 },
        preview: { x: -573, y: 1147, width: 400, height: 293 },
        'proof-surface': { x: -573, y: 1147, width: 400, height: 293 }
      }
    })
    assert.throws(
      () => parseWindowsStreamDisplayBounds('0,0,not-a-width,1080'),
      /must be x,y,width,height/
    )
    assert.deepEqual(resolveWindowsStreamElectronDisplay(bounds, [electronDisplay]), {
      id: '42',
      bounds,
      scaleFactor: 1
    })
    assert.throws(
      () =>
        resolveWindowsStreamElectronDisplay(bounds, [
          { id: 42, bounds: { x: -2048, y: 96, width: 2048, height: 1152 }, scaleFactor: 1.25 }
        ]),
      /100% scaling/
    )
    const letterboxedBounds = { x: 0, y: 0, width: 1920, height: 1200 }
    assert.throws(
      () =>
        windowsStreamCaptureProtectionPlacement(letterboxedBounds, {
          electronDisplay: { id: 7, bounds: letterboxedBounds, scaleFactor: 1 }
        }),
      /acceptance aspect ratio/
    )
  })

  it('parses only canonical DXGI output device names from selected-screen detail', () => {
    assert.equal(
      parseWindowsDxgiOutputDeviceName(String.raw`Windows DXGI output \\.\DISPLAY1 on NVIDIA RTX.`),
      String.raw`\\.\DISPLAY1`
    )
    assert.equal(
      parseWindowsDxgiOutputDeviceName(String.raw`Windows DXGI output \\.\DISPLAY12.`),
      String.raw`\\.\DISPLAY12`
    )
    assert.throws(
      () => parseWindowsDxgiOutputDeviceName('Windows DXGI output DISPLAY1.'),
      /canonical Windows DXGI output device name/
    )
    assert.throws(
      () => parseWindowsDxgiOutputDeviceName(String.raw`Windows DXGI output \\.\DISPLAY1 on .`),
      /canonical Windows DXGI output device name/
    )
    assert.throws(
      () => parseWindowsDxgiOutputDeviceName(undefined),
      /canonical Windows DXGI output device name/
    )
  })

  it('binds the selected DXGI output to one authoritative display and both exact bounds', () => {
    const bounds = { x: -1920, y: 120, width: 1920, height: 1080 }
    const result = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen: {
        detail: String.raw`Windows DXGI output \\.\DISPLAY2 on AMD Radeon.`
      },
      displayTopology: [
        {
          deviceName: String.raw`\\.\DISPLAY1`,
          desktopBounds: { x: 0, y: 0, width: 2560, height: 1440 }
        },
        { deviceName: String.raw`\\.\DISPLAY2`, desktopBounds: bounds }
      ],
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })

    assert.deepEqual(result, {
      verdict: 'PASS',
      blockers: [],
      deviceName: String.raw`\\.\DISPLAY2`,
      matchCount: 1,
      matchedDisplay: {
        deviceName: String.raw`\\.\DISPLAY2`,
        desktopBounds: bounds
      },
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })
  })

  it('rejects missing, ambiguous, and non-exact DXGI display identities', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    const selectedScreen = {
      detail: String.raw`Windows DXGI output \\.\DISPLAY1 on NVIDIA RTX.`
    }
    const missing = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen,
      displayTopology: [{ deviceName: String.raw`\\.\DISPLAY2`, desktopBounds: bounds }],
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })
    assert.equal(missing.verdict, 'BLOCKED')
    assert.match(missing.blockers.join('\n'), /matched 0 authoritative Windows displays/)

    const ambiguous = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen,
      displayTopology: [
        { deviceName: String.raw`\\.\DISPLAY1`, desktopBounds: bounds },
        { deviceName: String.raw`\\.\DISPLAY1`, desktopBounds: bounds }
      ],
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })
    assert.equal(ambiguous.verdict, 'BLOCKED')
    assert.match(ambiguous.blockers.join('\n'), /matched 2 authoritative Windows displays/)

    const caseMismatch = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen,
      displayTopology: [{ deviceName: String.raw`\\.\display1`, desktopBounds: bounds }],
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })
    assert.equal(caseMismatch.verdict, 'BLOCKED')
    assert.match(caseMismatch.blockers.join('\n'), /matched 0 authoritative Windows displays/)

    const malformedTopology = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen,
      displayTopology: [
        { deviceName: String.raw`\\.\DISPLAY1`, desktopBounds: bounds },
        { desktopBounds: bounds }
      ],
      expectedPhysicalBounds: bounds,
      expectedElectronBounds: bounds
    })
    assert.equal(malformedTopology.verdict, 'BLOCKED')
    assert.match(malformedTopology.blockers.join('\n'), /display 1 had no device name/)
  })

  it('rejects a same-size wrong monitor by comparing the desktop origin', () => {
    const firstMonitor = { x: 0, y: 0, width: 1920, height: 1080 }
    const secondMonitor = { x: 1920, y: 0, width: 1920, height: 1080 }
    const result = evaluateWindowsStreamDxgiDisplayBinding({
      selectedScreen: {
        detail: String.raw`Windows DXGI output \\.\DISPLAY2 on NVIDIA RTX.`
      },
      displayTopology: [
        { deviceName: String.raw`\\.\DISPLAY1`, desktopBounds: firstMonitor },
        { deviceName: String.raw`\\.\DISPLAY2`, desktopBounds: secondMonitor }
      ],
      expectedPhysicalBounds: firstMonitor,
      expectedElectronBounds: firstMonitor
    })

    assert.equal(result.verdict, 'BLOCKED')
    assert.equal(result.deviceName, String.raw`\\.\DISPLAY2`)
    assert.equal(result.matchCount, 1)
    assert.match(
      result.blockers.join('\n'),
      /did not match the expected physical desktop bounds exactly/
    )
    assert.match(
      result.blockers.join('\n'),
      /did not match the expected Electron display bounds exactly/
    )
  })

  it('blocks absent, unacknowledged, or misplaced protected windows before pixel sampling', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    const placement = windowsStreamCaptureProtectionPlacement(bounds, {
      electronDisplay: { id: 1, bounds, scaleFactor: 1 }
    })
    const ready = Object.fromEntries(
      ['main', 'comments', 'notes', 'captions', 'preview'].map((role) => [
        role,
        {
          open: true,
          visible: true,
          bounds: placement.windows[role],
          captureProtectionMarkerInstalled: true
        }
      ])
    )
    ready['proof-surface'] = {
      exists: true,
      visible: true,
      bounds: placement.cropBounds['proof-surface'],
      captureProtectionMarkerInstalled: true
    }
    assert.equal(
      evaluateWindowsCaptureProtectionPlacement({
        placement,
        states: ready
      }).verdict,
      'PASS'
    )

    const absent = structuredClone(ready)
    absent.notes.open = false
    absent.notes.visible = false
    assert.equal(
      evaluateWindowsCaptureProtectionPlacement({ placement, states: absent }).verdict,
      'BLOCKED'
    )

    const markerPending = structuredClone(ready)
    markerPending.comments.captureProtectionMarkerInstalled = false
    assert.match(
      evaluateWindowsCaptureProtectionPlacement({
        placement,
        states: markerPending
      }).blockers.join('\n'),
      /marker was not acknowledged/
    )

    const misplaced = structuredClone(ready)
    misplaced['proof-surface'].bounds.x = 0
    assert.match(
      evaluateWindowsCaptureProtectionPlacement({
        placement,
        states: misplaced
      }).blockers.join('\n'),
      /did not cover its evidence crop/
    )
  })

  it('requires complete protected-window placement coverage before, during, and after streaming', () => {
    const pass = { verdict: 'PASS', blockers: [] }
    const timeline = {
      expectedSamples: 2,
      intervalMs: 10_000,
      measurementMs: 20_000,
      maximumSampleLatenessMs: 2_000,
      measurementStartedAtMs: 100_000,
      measurementEndedAtMs: 120_000,
      samples: [
        { scheduledAtMs: 100_000, sampledAtMs: 100_100, evaluation: pass },
        { scheduledAtMs: 110_000, sampledAtMs: 110_100, evaluation: pass }
      ]
    }
    assert.equal(
      evaluateWindowsCaptureProtectionPlacementTimeline({
        initial: pass,
        timeline,
        final: pass
      }).verdict,
      'PASS'
    )

    const interrupted = structuredClone(timeline)
    interrupted.samples[1].evaluation = {
      verdict: 'BLOCKED',
      blockers: ['preview: window was not visible']
    }
    const interruptedResult = evaluateWindowsCaptureProtectionPlacementTimeline({
      initial: pass,
      timeline: interrupted,
      final: pass
    })
    assert.equal(interruptedResult.verdict, 'BLOCKED')
    assert.match(interruptedResult.blockers.join('\n'), /measurement sample 2.*preview/)

    const incomplete = evaluateWindowsCaptureProtectionPlacementTimeline({
      initial: pass,
      timeline: {
        ...timeline,
        samples: [timeline.samples[0]]
      },
      final: { verdict: 'BLOCKED', blockers: ['comments: window was closed'] }
    })
    assert.equal(incomplete.verdict, 'BLOCKED')
    assert.match(incomplete.blockers.join('\n'), /coverage 1\/2 was incomplete/)
    assert.match(incomplete.blockers.join('\n'), /final: comments: window was closed/)

    const clustered = structuredClone(timeline)
    clustered.samples[0].sampledAtMs = 109_500
    clustered.samples[1].sampledAtMs = 110_100
    const clusteredResult = evaluateWindowsCaptureProtectionPlacementTimeline({
      initial: pass,
      timeline: clustered,
      final: pass
    })
    assert.equal(clusteredResult.verdict, 'BLOCKED')
    assert.match(clusteredResult.blockers.join('\n'), /lateness exceeded|clustered/)

    const shortSpan = structuredClone(timeline)
    shortSpan.measurementEndedAtMs = 119_000
    assert.match(
      evaluateWindowsCaptureProtectionPlacementTimeline({
        initial: pass,
        timeline: shortSpan,
        final: pass
      }).blockers.join('\n'),
      /span 19000ms did not cover 20000ms/
    )
  })
})

function targetSnapshot(receivedAtMs, state) {
  return {
    receivedAtMs,
    source: 'rpc',
    snapshot: {
      sessionId: 'session-1',
      targets: [{ targetId: 'local-test', state }]
    }
  }
}

function temporalVisibility(expectedFrames) {
  return {
    visible: true,
    reason: 'signature present',
    expectedFrames,
    completeFrames: expectedFrames,
    visibleFrameRatio: 1
  }
}

function diagnosticTimelineFixture() {
  const diagnosticSample = (index) => ({
    sessionId: 'session-1',
    encoderSpeed: 1,
    encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
    encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
    encoderBridgeEncodedOutputBackend: 'media-foundation',
    encodeBackend: 'hardware-media-foundation',
    encoderBridgeSeparateOutputEncodersActive: false,
    encoderBridgeDroppedFrames: index,
    encoderBridgeRawVideoCopiedFrames: 0,
    encoderBridgeStreamQueueDroppedFrames: index,
    encoderBridgeStreamEncodedOutputFrames: index * 30,
    encoderBridgeStreamEncodedOutputBytes: index * 30_000
  })
  return {
    timing: { measurementMs: 3_000, intervalMs: 1_000 },
    sampling: {
      expectedSamples: 3,
      collectedSamples: 3,
      skippedDeadlineCount: 0,
      observations: [0, 1, 2].map((sampleIndex) => ({
        sampleIndex,
        scheduledAtMs: sampleIndex * 1_000,
        observedAtMs: sampleIndex * 1_000
      })),
      maxSampleGapMs: 1_000,
      measurementElapsedMs: 3_000
    },
    samples: [0, 1, 2].map(diagnosticSample),
    terminal: diagnosticSample(3),
    terminalTiming: {
      measurementEndedAtMs: 3_000,
      observedAtMs: 3_100
    }
  }
}

function processTelemetryFixture() {
  const roles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  return {
    timing: {
      requestedMeasurementMs: 3_000,
      measuredDurationMs: 3_000,
      intervalMs: 1_000
    },
    sampling: {
      expectedSamples: 3,
      collectedSamples: 3,
      skippedDeadlineCount: 0,
      observations: [0, 1, 2].map((sampleIndex) => ({
        sampleIndex,
        scheduledAtMs: sampleIndex * 1_000,
        observedAtMs: sampleIndex * 1_000
      })),
      maxSampleGapMs: 1_000,
      measurementElapsedMs: 3_000
    },
    memory: {
      samples: [{}, {}, {}],
      summary: {
        samples: 3,
        roles: Object.fromEntries(roles.map((role) => [role, { minMeasuredCount: 1 }]))
      }
    },
    cpu: {
      samples: [{}, {}, {}],
      summary: {
        samples: 3,
        byRole: Object.fromEntries(
          roles.map((role) => [
            role,
            { samples: 3, averagePercent: 1, p95Percent: 2, maxPercent: 3 }
          ])
        )
      }
    }
  }
}

function windowsPackagePayload() {
  const components = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath, index) => {
    const sha256 = String(index + 1)
      .repeat(64)
      .slice(0, 64)
    return {
      relativePath,
      sha256,
      identityKind: 'sha256',
      identity: sha256
    }
  })
  const sha256 = packagedAppPayloadManifestSha256(components, {
    payloadSpecs: WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath) => ({
      relativePath,
      requiresCodeSignature: false
    }))
  })
  assert.ok(sha256)
  return { sha256, components }
}

function passingEvidence(scenarioId = '1080p30-stream-preview') {
  const scenario = buildWindowsStreamPerformanceMatrix().find(
    (candidate) => candidate.id === scenarioId
  )
  assert.ok(scenario)
  const expectedDurationSeconds = scenario.measurementMs / 1000
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-stream-performance-run',
    mode: 'gate',
    scenarioId: scenario.id,
    repetition: 1,
    candidate: {
      sourceCommit: '1'.repeat(40),
      installerSha256: '2'.repeat(64),
      executablePath: 'C:/Program Files/Videorc/Videorc.exe',
      sha256: 'a'.repeat(64),
      packagePayload: windowsPackagePayload()
    },
    timing: {
      warmupMs: scenario.warmupMs,
      measurementMs: scenario.measurementMs,
      sampleIntervalMs: scenario.sampleIntervalMs
    },
    stimulus: {
      motion: {
        started: true,
        browserPath: 'C:/Program Files/Edge/msedge.exe',
        processLivenessVerdict: 'PASS',
        processLivenessBlockers: []
      },
      audio: {
        required: true,
        started: true,
        browserPath: 'C:/Program Files/Edge/msedge.exe',
        processLivenessVerdict: 'PASS',
        processLivenessBlockers: []
      }
    },
    artifacts: {
      receiverMedia: 'receiver.flv',
      ffprobeJson: 'receiver.ffprobe.json',
      framemd5: 'receiver.framemd5',
      analyzerJson: 'receiver.quality.json',
      supportBundle: 'support-bundle.json',
      processSamples: 'process-samples.json',
      gpuSamples: 'gpu-samples.json',
      captureProtection: 'capture-protection.json',
      settings: 'settings.json',
      verdict: 'verdict.json'
    },
    media: {
      width: scenario.width,
      height: scenario.height,
      fps: scenario.fps,
      durationSeconds:
        expectedDurationSeconds *
        (1 + WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.durationToleranceRatio),
      frameCount:
        expectedDurationSeconds *
        scenario.fps *
        (1 + WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.frameCountToleranceRatio),
      maxFrameGapMs: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumFrameGapMs,
      longestCorroboratedFreezeMs: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumFreezeMs,
      maxRepeatedFrameRun: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumRepeatedFrameRun,
      duplicatePtsCount: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumDuplicatePtsCount,
      maxDuplicatePtsRun: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumDuplicatePtsRun,
      maxKeyframeIntervalSeconds:
        WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumKeyframeIntervalSeconds,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv'
    },
    pipeline: {
      requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveEncodeBackend: 'hardware-media-foundation',
      encodedOutputBackend: 'media-foundation',
      separateOutputEncoders: scenario.recordEnabled,
      encodedFrames: 1,
      encodedBytes: 1,
      rawVideoCopiedFrames: 0,
      submittedFrames: 1_000,
      coalescedFrames: 1,
      droppedFrames: 0,
      encoderSpeedP05: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.minimumEncoderSpeedP05,
      fallbackReason: null,
      fallbackAcknowledged: false,
      fallbackChanged: false,
      diagnosticTimelineVerdict: 'PASS',
      diagnosticTimelineBlockers: []
    },
    network: {
      targetBitrateKbps: scenario.bitrateKbps,
      measuredBitrateKbps:
        scenario.bitrateKbps *
        (1 - WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.totalBitrateToleranceRatio),
      rollingBitrateKbps: [
        scenario.bitrateKbps * WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.minimumRollingBitrateRatio,
        scenario.bitrateKbps * WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumRollingBitrateRatio
      ],
      reconnects: 0,
      lifecycle: {
        verdict: 'PASS',
        failures: [],
        blockers: []
      },
      measurementClock: {
        startSkewMs: scenario.sampleIntervalMs,
        endSkewMs: scenario.sampleIntervalMs,
        collectorBoundaries: { verdict: 'PASS', blockers: [] }
      },
      unexpectedExit: false
    },
    avSync: {
      required: true,
      measured: true,
      medianAbsoluteOffsetMs: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumAvMedianAbsoluteOffsetMs,
      maxAbsoluteOffsetMs: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumAvSampleOffsetMs,
      projectedDriftMsPer30Min:
        WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumProjectedDriftMsPer30Min,
      driftBinding: true
    },
    process: {
      telemetryCollected: true,
      telemetryVerdict: 'PASS',
      telemetryBlockers: [],
      gpuVerdict: 'PASS',
      teardownClean: true,
      leakDetected: false
    },
    captureProtection: {
      verdict: 'PASS',
      markerAbsent: true,
      underlyingStimulusPresent: true,
      failures: [],
      blockers: []
    },
    budget: {
      required: true,
      active: true,
      applicable: true,
      failures: []
    }
  }
}

function passingD3d11Evidence(scenarioId = '1080p30-stream-preview') {
  const evidence = passingEvidence(scenarioId)
  const scenario = buildWindowsStreamPerformanceMatrix().find(
    (candidate) => candidate.id === scenarioId
  )
  assert.ok(scenario)
  evidence.pipeline.requireD3d11 = true
  evidence.pipeline.expectedD3d11Path = 'forced'
  const adapterLuid = '0000000000000042'
  evidence.pipeline.d3d11 = {
    state: 'live',
    requested: true,
    required: true,
    adapterLuid,
    captureAdapterLuid: adapterLuid,
    compositorAdapterLuid: adapterLuid,
    primaryEncoderAdapterLuid: adapterLuid,
    auxiliaryEncoderAdapterLuid: scenario.recordEnabled ? adapterLuid : null,
    captureReadbackFrames: 0,
    compositorCpuFallbackFrames: 0,
    encoderSystemMemorySamples: 0,
    rawVideoCopiedFrames: 0,
    previewBmpRequests: 0,
    previewBmpBytes: 0,
    textureImportFrames: 1_000,
    cameraUploadFrames: scenario.sourceComposition === 'screen-camera' ? 1_000 : 0,
    encoderGpuSamples: 1_000,
    cursorCorrect: true,
    inputContinuity: scenario.previewOpen,
    inputContinuityEvidence: scenario.previewOpen
      ? {
          verdict: 'PASS',
          applicable: true,
          physicalInput: true,
          blockers: []
        }
      : {
          verdict: 'NOT_REQUIRED',
          applicable: false,
          physicalInput: false,
          blockers: []
        },
    messageDispatchP95Ms: 50,
    messageDispatchMaxMs: 100,
    mediaCommandLagP95Ms: 50,
    mediaCommandLagMaxMs: 100,
    maximumConsecutiveMessageBatch: 32,
    maximumConsecutiveMediaBatch: 32,
    synchronizationTimeouts: 0,
    texturePoolPressureEvents: 0,
    adapterMismatches: 0,
    deviceResets: 0,
    previewPresents: scenario.previewOpen ? 1_000 : 0,
    fallbackReason: null,
    stateChanged: false,
    adapterChanged: false,
    fallbackChanged: false
  }
  return evidence
}

async function naturalFallbackDerivationFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'videorc-natural-fallback-'))
  const packagePayload = windowsPackagePayload()
  const streamCandidate = {
    sourceCommit: '1'.repeat(40),
    installerSha256: '2'.repeat(64),
    executablePath: 'C:/Program Files/Videorc/Videorc.exe',
    sha256: '3'.repeat(64),
    packagePayload
  }
  const root = join(directory, streamCandidate.sha256)
  await mkdir(root, { recursive: true })
  const aggregateRuns = []
  for (const scenarioId of [
    '1080p30-stream-preview',
    '1080p30-stream-no-preview',
    '1080p30-record-stream-preview',
    '1080p30-record-stream-no-preview'
  ]) {
    const scenario = buildWindowsStreamPerformanceMatrix().find((entry) => entry.id === scenarioId)
    assert.ok(scenario)
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const runDirectory = join(root, scenarioId, `run-${String(repetition).padStart(2, '0')}`)
      await mkdir(runDirectory, { recursive: true })
      const reportPath = join(runDirectory, 'verdict.json')
      const evidence = passingEvidence(scenarioId)
      evidence.mode = 'calibrate'
      evidence.repetition = repetition
      evidence.candidate = structuredClone(streamCandidate)
      evidence.context = {
        scenario: scenario.id,
        hardwareClass: 'unsupported-natural-fallback',
        profileClass: 'release',
        buildMode: 'packaged',
        profile: '1080p30',
        mediaPath: 'legacy-fallback',
        selectionMode: 'natural',
        sourceComposition: 'screen-only',
        topology: scenario.topology,
        previewOpen: scenario.previewOpen
      }
      evidence.pipeline.expectedFallback = 'natural'
      evidence.pipeline.expectedD3d11Path = 'natural'
      evidence.pipeline.d3d11 = {
        state: 'fallback',
        requested: false,
        required: false,
        captureBackend: 'legacy-ffmpeg',
        fallbackReason: 'd3d11-fence-interface-unavailable'
      }
      evidence.calibration = naturalFallbackRunMetrics()
      evidence.budget = {
        required: false,
        active: false,
        applicable: false,
        failures: []
      }
      const result = evaluateWindowsStreamRun(evidence)
      assert.equal(result.verdict, 'PASS', [...result.failures, ...result.blockers].join('\n'))
      await writeFile(reportPath, `${JSON.stringify({ evidence, result }, null, 2)}\n`)
      const reportSha256 = sha256(await readFile(reportPath))
      aggregateRuns.push({
        scenarioId,
        repetition,
        verdict: 'PASS',
        failures: [],
        blockers: [],
        evidencePath: reportPath,
        reportPath,
        reportSha256,
        candidate: streamCandidate,
        context: evidence.context,
        topology: scenario.topology,
        previewOpen: scenario.previewOpen,
        profile: '1080p30',
        calibration: evidence.calibration
      })
    }
  }
  const aggregatePath = join(root, 'aggregate.json')
  const aggregate = {
    schemaVersion: 1,
    kind: 'videorc.windows-stream-performance-aggregate',
    status: 'calibration',
    mode: 'calibrate',
    startedAt: '2026-07-30T10:00:00.000Z',
    finishedAt: '2026-07-30T11:00:00.000Z',
    timing: WINDOWS_STREAM_PERFORMANCE_TIMING,
    scenarios: [
      '1080p30-stream-preview',
      '1080p30-stream-no-preview',
      '1080p30-record-stream-preview',
      '1080p30-record-stream-no-preview'
    ],
    repetitions: {
      '1080p30-stream-preview': 3,
      '1080p30-stream-no-preview': 3,
      '1080p30-record-stream-preview': 3,
      '1080p30-record-stream-no-preview': 3
    },
    candidate: streamCandidate,
    hardwareClass: 'unsupported-natural-fallback',
    profileClass: 'release',
    operatingSystem: {
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26100'
    },
    pathEvidence: 'natural',
    runs: aggregateRuns,
    failures: [],
    blockers: [],
    error: null
  }
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
  const budgetPath = join(directory, 'windows-d3d11-performance-budget.json')
  await writeFile(
    budgetPath,
    `${JSON.stringify(draftD3d11Budget(streamCandidate, directory), null, 2)}\n`
  )
  return { directory, root, aggregatePath, budgetPath }
}

function runNaturalFallbackDerivation(fixture) {
  return spawnSync(
    process.execPath,
    [
      'scripts/smoke-windows-stream-performance.mjs',
      '--derive-natural-fallback-policy',
      '--fallback-calibrations',
      fixture.root,
      '--budget',
      fixture.budgetPath
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8'
    }
  )
}

function naturalFallbackRunMetrics() {
  const roles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  return {
    process: {
      cpuP95Percent: 65,
      rssMaxMiB: 900,
      rssSlopeMiBPerMinute: 4,
      roles: Object.fromEntries(
        roles.map((role, index) => [
          role,
          {
            rssMaxMiB: 100 + index,
            rssSlopeMiBPerMinute: 1.5,
            cpuAveragePercent: 12 + index,
            cpuP95Percent: 18 + index
          }
        ])
      )
    },
    gpu: {
      engineBusyP95Percent: 55,
      dedicatedMaxMiB: 400,
      sharedMaxMiB: 200
    },
    bmp: {
      requestCount: 20,
      bytes: 100_000,
      intervalP95Ms: 125,
      advancedFrames: 200
    },
    encoderSpeedP05: 0.99,
    mediaVerdict: 'PASS',
    lifecycleVerdict: 'PASS',
    previewProofSurfaceVerdict: 'PASS',
    d3d11: {
      captureReadbackFrames: null,
      compositorCpuFallbackFrames: null,
      rawVideoCopiedFrames: null,
      encoderSystemMemorySamples: null,
      cursorCorrect: false,
      inputContinuity: true,
      messageDispatchP95Ms: null,
      messageDispatchMaxMs: null,
      mediaCommandLagP95Ms: null,
      mediaCommandLagMaxMs: null,
      maximumConsecutiveMessageBatch: null,
      maximumConsecutiveMediaBatch: null,
      synchronizationTimeouts: 0
    }
  }
}

function draftD3d11Budget(streamCandidate, directory) {
  const candidate = {
    sourceCommit: streamCandidate.sourceCommit,
    installerSha256: streamCandidate.installerSha256,
    executableSha256: streamCandidate.sha256,
    packagePayloadSha256: streamCandidate.packagePayload.sha256
  }
  const hardwareClasses = ['nvidia-turing-floor', 'intel-xe-integrated']
  const profiles = hardwareClasses.flatMap((hardwareClass, classIndex) =>
    WINDOWS_D3D11_PERFORMANCE_SCENARIOS.map((scenario, scenarioIndex) => {
      const ordinal = classIndex * WINDOWS_D3D11_PERFORMANCE_SCENARIOS.length + scenarioIndex
      const evidenceRoot = join(directory, hardwareClass, scenario.id)
      return {
        id: `${hardwareClass}-${scenario.id}`,
        scope: {
          scenario: scenario.id,
          profile: scenario.profile,
          hardwareClass,
          profileClass: 'release',
          buildMode: 'packaged',
          operatingSystem: {
            platform: 'win32',
            arch: 'x64',
            release: '10.0.26100'
          },
          timing: {
            warmupMs: scenario.warmupMs,
            measurementMs: scenario.measurementMs,
            intervalMs: scenario.intervalMs
          },
          mediaPath: 'd3d11-native',
          sourceComposition: scenario.sourceComposition,
          topology: scenario.topology,
          previewOpen: scenario.previewOpen,
          ...(scenario.previewOpen
            ? {
                preview: {
                  transport: 'd3d11-shared-texture',
                  backing: 'directcomposition-swapchain',
                  hostKind: 'backend-d3d11-presenter'
                }
              }
            : {})
        },
        candidate,
        evidence: {
          calibrationPath: join(evidenceRoot, 'aggregate.json'),
          calibrationSha256: digest(`calibration-${ordinal}`),
          reportPaths: Array.from({ length: scenario.repetitions }, (_, index) =>
            join(evidenceRoot, `run-${index + 1}.json`)
          ),
          reportSha256: Array.from({ length: scenario.repetitions }, (_, index) =>
            digest(`report-${ordinal}-${index}`)
          ),
          comparisonPath: join(directory, hardwareClass, 'obs', 'aggregate.json'),
          comparisonSha256: digest(`comparison-${classIndex}`)
        },
        invariants: {
          mediaPath: 'd3d11-native',
          captureReadbackFrames: 0,
          compositorCpuFallbackFrames: 0,
          rawVideoCopiedFrames: 0,
          encoderSystemMemorySamples: 0,
          previewBmpRequests: 0,
          previewBmpBytes: 0,
          cursorCorrect: true,
          inputContinuity: true,
          maximumMessageDispatchP95Ms: 50,
          maximumMessageDispatchMs: 100,
          maximumMediaCommandLagP95Ms: 50,
          maximumMediaCommandLagMs: 100,
          maximumConsecutiveMessageBatch: 32,
          maximumConsecutiveMediaBatch: 32,
          synchronizationTimeouts: 0
        },
        thresholds: d3d11TestThresholds()
      }
    })
  )
  return {
    schemaVersion: 1,
    kind: WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
    status: 'draft',
    generatedBy: 'smoke-windows-obs-side-by-side --derive-d3d11-budget',
    candidate,
    qualifiedProfiles: {
      'nvidia-turing-floor': ['1080p30', '1080p60'],
      'intel-xe-integrated': ['1080p30', '1080p60']
    },
    unqualifiedLivestreamProfiles: ['1440p30', '1440p60', '4k30', '4k60'],
    comparisonEvidence: hardwareClasses.map((hardwareClass, index) => ({
      hardwareClass,
      aggregatePath: join(directory, hardwareClass, 'obs', 'aggregate.json'),
      aggregateSha256: digest(`comparison-${index}`),
      manifestSha256: digest(`manifest-${index}`),
      obsSha256: digest(`obs-${index}`),
      obsVersion: '31.1.2',
      bootId: `boot-${index + 1}`,
      fingerprint: digest(`fingerprint-${index}`)
    })),
    profiles,
    naturalFallbackPolicy: null,
    activation: {
      allowed: false,
      reason: 'Draft requires natural fallback evidence and independent human review.'
    }
  }
}

function d3d11TestThresholds() {
  const role = {
    maximumRssMiB: 512,
    maximumRssSlopeMiBPerMinute: 2,
    maximumAverageCpuPercent: 80,
    maximumP95CpuPercent: 90
  }
  return {
    maximumTotalCpuP95Percent: 90,
    maximumTotalRssMiB: 2048,
    maximumTotalRssSlopeMiBPerMinute: 5,
    gpu: {
      maximumEngineP95Percent: 80,
      maximumDedicatedMiB: 600,
      maximumSharedMiB: 200
    },
    bmp: { mode: 'disabled', maximumRequests: 0, maximumBytes: 0 },
    roles: Object.fromEntries(
      ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map((name) => [
        name,
        role
      ])
    )
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function trustExpectedArtifactDigest({ expectedSha256 }) {
  return expectedSha256
}

function budgetContext() {
  return {
    scenario: '1080p30-stream-preview',
    hardwareClass: 'win11-x64-lab-a',
    profileClass: 'release',
    buildMode: 'packaged',
    candidatePayloadSha256: 'd'.repeat(64),
    operatingSystem: { platform: 'win32', arch: 'x64', release: '10.0.26100' },
    timing: {
      warmupMs: WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs,
      measurementMs: WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs,
      intervalMs: WINDOWS_STREAM_PERFORMANCE_TIMING.sampleIntervalMs
    }
  }
}

function budgetDocument() {
  const roleThresholds = {
    maximumRssMiB: 512,
    maximumRssSlopeMiBPerMinute: 16,
    maximumAverageCpuPercent: 80,
    maximumP95CpuPercent: 90
  }
  const candidateSha256 = 'b'.repeat(64)
  const candidatePayloadSha256 = 'd'.repeat(64)
  const comparisonPaths = Array.from({ length: 6 }, (_, index) => `comparison/${index + 1}.json`)
  const comparisonSha256 = Array.from({ length: 6 }, (_, index) =>
    String(index + 1)
      .repeat(64)
      .slice(0, 64)
  )
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-performance-budget-set',
    status: 'active',
    candidateSha256,
    candidatePayloadSha256,
    reviewedBy: 'release-owner',
    reviewedAt: '2026-07-29T12:00:00.000Z',
    comparison: {
      aggregatePath: 'comparison/aggregate.json',
      aggregateSha256: 'a'.repeat(64),
      reportPaths: comparisonPaths,
      reportSha256: comparisonSha256
    },
    profiles: [
      {
        id: 'lab-a-1080p30-stream-preview',
        scope: { ...budgetContext(), previewOpen: true },
        candidateSha256,
        candidatePayloadSha256,
        evidence: {
          runCount: 3,
          reportPaths: ['one.json', 'two.json', 'three.json'],
          reportSha256: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
          calibrationSha256: 'f'.repeat(64),
          calibrationPath: 'calibration/aggregate.json',
          comparisonPaths,
          comparisonSha256
        },
        thresholds: {
          maximumTotalCpuP95Percent: 400,
          maximumTotalRssMiB: 2048,
          maximumTotalRssSlopeMiBPerMinute: 64,
          gpu: {
            maximumEngineP95Percent: 95,
            maximumDedicatedMiB: 2048,
            maximumSharedMiB: 2048
          },
          bmp: {
            mode: 'required',
            maximumIntervalP95Ms: 175,
            minimumAdvancedFrames: 1
          },
          roles: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, roleThresholds]
            )
          )
        }
      }
    ]
  }
}

function budgetMetrics() {
  const roleMemory = {
    maxRssKb: 512 * 1024,
    slopeRssKbPerMinute: 16 * 1024
  }
  const roleCpu = { averagePercent: 80, p95Percent: 90 }
  return {
    processTree: {
      memory: {
        summary: {
          maxTotalRssKb: 2048 * 1024,
          totalRss: { slopePerMinute: 64 * 1024 },
          roles: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, roleMemory]
            )
          )
        }
      },
      cpu: {
        summary: {
          totalP95Percent: 400,
          byRole: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, { ...roleCpu }]
            )
          )
        }
      }
    },
    bmp: { intervalP95Ms: 175, advancedFrames: 1 },
    gpu: {
      summary: {
        engineBusyP95Percent: 95,
        dedicatedMaxMiB: 2048,
        sharedMaxMiB: 2048
      }
    },
    teardownClean: true
  }
}
