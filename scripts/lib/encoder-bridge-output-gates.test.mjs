import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertEncoderBridgeVideoOutputHealthy,
  normalizeEncoderBridgeVideoOutput
} from './encoder-bridge-output-gates.mjs'

const healthyStats = () => ({
  maxEncoderBridgeRawVideoCopiedFrames: 0,
  maxEncoderBridgeMetalTargetCopiedFrames: 0,
  maxEncoderBridgeMetalTargetHandleFrames: 120,
  maxEncoderBridgeZeroCopyFrames: 120,
  maxEncoderBridgeVideoToolboxOutputFrames: 120,
  maxEncoderBridgeVideoToolboxOutputBytes: 58_000,
  maxEncoderBridgeVideoToolboxProbeErrors: 0
})

describe('normalizeEncoderBridgeVideoOutput', () => {
  it('normalizes the supported VideoToolbox aliases', () => {
    assert.equal(normalizeEncoderBridgeVideoOutput('videotoolbox-h264'), 'videotoolbox-h264')
    assert.equal(normalizeEncoderBridgeVideoOutput('h264'), 'videotoolbox-h264')
    assert.equal(normalizeEncoderBridgeVideoOutput('annex-b'), 'videotoolbox-h264')
    assert.equal(normalizeEncoderBridgeVideoOutput('annexb'), 'videotoolbox-h264')
  })

  it('defaults unknown values to the raw-YUV path', () => {
    assert.equal(normalizeEncoderBridgeVideoOutput(undefined), 'raw-yuv420p')
    assert.equal(normalizeEncoderBridgeVideoOutput('raw-yuv420p'), 'raw-yuv420p')
    assert.equal(normalizeEncoderBridgeVideoOutput('bogus'), 'raw-yuv420p')
  })
})

describe('assertEncoderBridgeVideoOutputHealthy', () => {
  it('does not apply VideoToolbox output gates to raw-YUV mode', () => {
    assert.doesNotThrow(() =>
      assertEncoderBridgeVideoOutputHealthy({
        scenarioLabel: 'raw',
        stats: {},
        videoOutput: 'raw-yuv420p'
      })
    )
  })

  it('passes a healthy VideoToolbox H.264 output run', () => {
    assert.doesNotThrow(() =>
      assertEncoderBridgeVideoOutputHealthy({
        scenarioLabel: 'vt',
        stats: healthyStats(),
        videoOutput: 'videotoolbox-h264'
      })
    )
  })

  it('fails when H.264 output regresses to raw frame copies', () => {
    const stats = healthyStats()
    stats.maxEncoderBridgeRawVideoCopiedFrames = 1

    assert.throws(
      () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'vt',
          stats,
          videoOutput: 'videotoolbox-h264'
        }),
      /copied 1 raw-YUV frame/
    )
  })

  it('fails when H.264 output regresses to copied Metal-target frames', () => {
    const stats = healthyStats()
    stats.maxEncoderBridgeMetalTargetCopiedFrames = 1

    assert.throws(
      () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'vt',
          stats,
          videoOutput: 'videotoolbox-h264'
        }),
      /copied 1 Metal-target frame/
    )
  })

  it('fails when retained target handles do not reach VideoToolbox output', () => {
    const stats = healthyStats()
    stats.maxEncoderBridgeMetalTargetHandleFrames = 0

    assert.throws(
      () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'vt',
          stats,
          videoOutput: 'videotoolbox-h264'
        }),
      /never received retained Metal target handles/
    )
  })

  it('fails when zero-copy submissions do not cover output frames', () => {
    const stats = healthyStats()
    stats.maxEncoderBridgeZeroCopyFrames = 12
    stats.maxEncoderBridgeVideoToolboxOutputFrames = 13

    assert.throws(
      () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'vt',
          stats,
          videoOutput: 'videotoolbox-h264'
        }),
      /13 Annex B frame\(s\) but only 12 zero-copy/
    )
  })

  it('fails when no H.264 bytes are produced', () => {
    const stats = healthyStats()
    stats.maxEncoderBridgeVideoToolboxOutputBytes = 0

    assert.throws(
      () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'vt',
          stats,
          videoOutput: 'videotoolbox-h264'
        }),
      /produced no encoded bytes/
    )
  })
})
