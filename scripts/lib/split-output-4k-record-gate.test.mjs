// Run: node --test scripts/lib/split-output-4k-record-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateSplitOutput4kRecordEvidence } from './split-output-4k-record-gate.mjs'

describe('evaluateSplitOutput4kRecordEvidence', () => {
  it('passes when 4K recording and 1080p stream evidence are both proved', () => {
    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest: goodManifest(),
      receivedStreamProbe: goodReceivedStreamProbe(),
      streamAvSyncVerdict: { pass: true, failures: [], warnings: [] }
    })

    assert.equal(verdict.pass, true, verdict.failures.join('; '))
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.summary.activeVideoToolboxOutputEncoders, 2)
  })

  it('fails when the local recording artifact is not 4K', () => {
    const manifest = goodManifest()
    manifest.diagnostics.finalFile.width = 1920

    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest,
      receivedStreamProbe: goodReceivedStreamProbe()
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('; '), /local recording artifact width 1920/)
  })

  it('fails when the stream artifact is still 4K', () => {
    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest: goodManifest(),
      receivedStreamProbe: {
        video: { width: 3840, height: 2160, avgFps: 30, nominalFps: 30 }
      }
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('; '), /RTMP-received stream artifact width 3840/)
  })

  it('fails when split-output encoder diagnostics are missing', () => {
    const manifest = goodManifest()
    manifest.diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders = 1
    manifest.diagnostics.encoderBridgeSeparateOutputEncodersActive = false
    manifest.diagnostics.encoderBridgeStreamVideoToolboxOutputFrames = 0

    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest,
      receivedStreamProbe: goodReceivedStreamProbe()
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('; '), /active VideoToolbox output encoder count 1/)
    assert.match(verdict.failures.join('; '), /separate output encoders/)
    assert.match(verdict.failures.join('; '), /stream VideoToolbox output frames/)
  })

  it('fails when the stream A/V sync verdict fails', () => {
    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest: goodManifest(),
      receivedStreamProbe: goodReceivedStreamProbe(),
      streamAvSyncVerdict: {
        pass: false,
        failures: ['RTMP-received FLV A/V offset +95ms exceeds plan gate 60ms'],
        warnings: []
      }
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('; '), /stream A\/V sync gate failed/)
  })

  it('fails when either encoded output queue exceeds its latency contract', () => {
    const manifest = goodManifest()
    manifest.diagnostics.encoderBridgeRecordingQueueDepth = 17
    manifest.diagnostics.encoderBridgeRecordingQueueOldestFrameAgeMs = 251
    manifest.diagnostics.encoderBridgeStreamQueueDepth = 9
    manifest.diagnostics.encoderBridgeStreamQueueOldestFrameAgeMs = 151

    const verdict = evaluateSplitOutput4kRecordEvidence({
      manifest,
      receivedStreamProbe: goodReceivedStreamProbe()
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('; '), /recording queue depth 17 exceeded 16/)
    assert.match(verdict.failures.join('; '), /stream queue oldest-frame age 151ms exceeded 150ms/)
  })
})

function goodManifest() {
  return {
    request: {
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000,
      streamEnabled: true,
      streamingSettingsEnabled: true,
      streamOutputPreset: 'stream-safe-1080p30'
    },
    result: {
      blockedBeforeEncoding: false,
      acceptancePass: true,
      acceptanceFailures: [],
      finalFilePass: true,
      startupPass: true,
      mediaQualityMode: 'record-stream-split-output'
    },
    diagnostics: {
      finalFile: {
        width: 3840,
        height: 2160,
        observedFps: 30,
        maxRepeatedFrameRun: 1,
        longestFreezeMs: 0
      },
      recordingOutput: { width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 },
      streamOutput: { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
      encoderBridgeActiveVideoToolboxOutputEncoders: 2,
      encoderBridgeSeparateOutputEncodersActive: true,
      encoderBridgeRecordingVideoToolboxOutputFrames: 120,
      encoderBridgeRecordingVideoToolboxOutputBytes: 20_000_000,
      encoderBridgeStreamVideoToolboxOutputFrames: 120,
      encoderBridgeStreamVideoToolboxOutputBytes: 4_000_000,
      encoderBridgeRawVideoCopiedFrames: 0,
      encoderBridgeMetalTargetCopiedFrames: 0,
      encoderBridgeZeroCopyFrames: 120,
      encoderBridgeRecordingQueueDepth: 2,
      encoderBridgeRecordingQueueOldestFrameAgeMs: 35,
      encoderBridgeRecordingQueueCapacityPressureEvents: 0,
      encoderBridgeRecordingQueueDroppedFrames: 0,
      encoderBridgeStreamQueueDepth: 2,
      encoderBridgeStreamQueueOldestFrameAgeMs: 35,
      encoderBridgeStreamQueueCapacityPressureEvents: 0,
      encoderBridgeStreamQueueDroppedFrames: 0
    }
  }
}

function goodReceivedStreamProbe() {
  return {
    video: {
      width: 1920,
      height: 1080,
      avgFps: 30,
      nominalFps: 30
    }
  }
}
