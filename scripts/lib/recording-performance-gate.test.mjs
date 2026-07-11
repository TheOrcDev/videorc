import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  analyzeAvProbe,
  evaluateRecordingArtifact,
  evaluateRecordingPerformance,
  summarizeRecordingDiagnostics
} from './recording-performance-gate.mjs'

describe('analyzeAvProbe', () => {
  it('does not disguise a video-only artifact as zero A/V skew', () => {
    assert.throws(
      () =>
        analyzeAvProbe({
          streams: [{ codec_type: 'video', duration: '10.0' }],
          format: { duration: '10.0' }
        }),
      /missing a required audio stream/
    )
  })

  it('reports stream counts and duration skew when both streams exist', () => {
    assert.deepEqual(
      analyzeAvProbe({
        streams: [
          { codec_type: 'video', duration: '10.0' },
          { codec_type: 'audio', duration: '9.9' }
        ]
      }),
      {
        videoStreams: 1,
        audioStreams: 1,
        videoDurationSeconds: 10,
        audioDurationSeconds: 9.9,
        skewMs: 99.99999999999964
      }
    )
  })
})

describe('recording diagnostics gate', () => {
  it('summarizes and rejects preview drops, maintenance cancellation, process excess, and RSS', () => {
    const startedAt = 1000
    const stats = summarizeRecordingDiagnostics(
      [
        {
          receivedAt: 3000,
          activeOutputMode: 'record',
          captureFps: 30,
          renderFps: 30,
          encoderSpeed: 1,
          previewDroppedFrames: 2,
          ffmpegMaintenanceCancelRequested: true,
          backendRssBytes: 600 * 1024 * 1024,
          activeFfmpegProcesses: 3,
          activeFfprobeProcesses: 1
        }
      ],
      { targetFps: 30, scenarioStartedAt: startedAt, stopRequestedAt: 5000, warmupMs: 1000 }
    )
    const failures = evaluateRecordingPerformance({
      scenario: { label: '1080p30', fps: 30 },
      stats,
      polls: { attempts: 4, successes: 1 },
      thresholds: {
        minSteadySamples: 1,
        minSpeed: 0.98,
        minFpsRatio: 0.9,
        maxBackendRssMb: 512,
        maxActiveFfmpegProcesses: 2,
        maxActiveFfprobeProcesses: 0,
        minPreviewPollRatio: 0.75
      }
    })

    assert.deepEqual(failures, [
      '[1080p30] preview dropped frames: 2',
      '[1080p30] maintenance cancellation samples: 1',
      '[1080p30] backend RSS 600.0MiB exceeded 512MiB',
      '[1080p30] FFmpeg process count 3 exceeded 2',
      '[1080p30] FFprobe process count 1 exceeded 0',
      '[1080p30] preview polls succeeded 1/4; expected at least 3'
    ])
  })

  it('requires capture and render telemetry independently', () => {
    const failures = evaluateRecordingPerformance({
      scenario: { label: '1080p30', fps: 30 },
      stats: {
        steadySamples: 1,
        minSpeed: 1,
        minFps: 30,
        minCaptureFps: null,
        minRenderFps: 30,
        droppedFrames: 0,
        micDroppedFrames: 0,
        previewDroppedFrames: 0,
        maintenanceSamples: 0,
        maintenanceCancelSamples: 0,
        duplicateCaptureSamples: 0,
        maxBackendRssBytes: 10,
        maxActiveFfmpegProcesses: 1,
        maxActiveFfprobeProcesses: 0
      },
      polls: { attempts: 4, successes: 4 },
      thresholds: {
        minSteadySamples: 1,
        minSpeed: 0.98,
        minFpsRatio: 0.9,
        maxBackendRssMb: 512,
        maxActiveFfmpegProcesses: 2,
        maxActiveFfprobeProcesses: 0,
        minPreviewPollRatio: 0.75
      }
    })

    assert.deepEqual(failures, ['[1080p30] capture FPS telemetry was missing'])
  })
})

describe('final recording artifact gate', () => {
  it('requires a passing analyzer verdict plus decoded cadence and freeze evidence', () => {
    const scenario = { label: '1080p30' }
    assert.deepEqual(
      evaluateRecordingArtifact({
        scenario,
        report: {
          verdict: { pass: true, failures: [] },
          metrics: {
            hasVideo: true,
            hasAudio: true,
            observedFrames: 600,
            observedFps: 30,
            longestFreezeMs: 0,
            maxRepeatedFrameRun: 1
          }
        }
      }),
      []
    )

    assert.deepEqual(
      evaluateRecordingArtifact({
        scenario,
        report: {
          verdict: { pass: false, failures: ['frame count was short'] },
          metrics: { hasVideo: true, hasAudio: false, observedFrames: 0 }
        }
      }),
      [
        '[1080p30] final-artifact analyzer failed: frame count was short',
        '[1080p30] final artifact did not prove a required audio stream',
        '[1080p30] final artifact did not report decoded frame progress',
        '[1080p30] final artifact did not report decoded frame cadence',
        '[1080p30] final artifact did not report freeze analysis',
        '[1080p30] final artifact did not report repeated-frame analysis'
      ]
    )
  })
})
