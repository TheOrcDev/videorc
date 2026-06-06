// Unit tests for the real-source acceptance gate.
// Run: node --test scripts/lib/acceptance-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateAcceptance } from './acceptance-gate.mjs'

const cleanInput = () => ({
  analyzerVerdict: { pass: true, failures: [] },
  diagnostics: {
    encoderBridgeRepeatedFrames: 0,
    encoderBridgeSyntheticFrames: 0,
    encoderBridgeMetalTargetFrames: 120,
    encoderBridgeRawVideoCopiedFrames: 0,
    encoderBridgeMetalTargetCopiedFrames: 0,
    encoderBridgeZeroCopyFrames: 120,
    minEncoderSpeed: 1.0,
    micDroppedFrames: 0,
    minMicCaptureCoverage: 1.0,
    imagePollDuringSession: { total: 0 },
    previewSurfaceBacking: 'cametal-layer',
  },
  claimsNative: true,
  expectAudio: true,
})

describe('evaluateAcceptance', () => {
  it('passes a clean real-source run', () => {
    const v = evaluateAcceptance(cleanInput())
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
  })

  it('fails when the final-file analyzer fails, surfacing its reasons', () => {
    const input = cleanInput()
    input.analyzerVerdict = { pass: false, failures: ['freeze segment 250ms exceeds 100ms (1 segment(s))'] }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /final-file: freeze segment 250ms/)
  })

  it('fails when the startup-resolution analyzer fails, surfacing its reasons', () => {
    const input = cleanInput()
    input.startupVerdict = { pass: false, failures: ['metadata width 640 does not match expected 1920'] }
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
    input.diagnostics.encoderBridgeZeroCopyFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /IOSurface-backed Metal target frames/)
  })

  it('fails the strict OBS compositor gate when Metal target frames are still copied', () => {
    const input = cleanInput()
    input.requireGpuCompositor = true
    input.diagnostics.compositorBackend = 'metal'
    input.diagnostics.compositorCpuFallbackFrames = 0
    input.diagnostics.encoderBridgeMetalTargetFrames = 120
    input.diagnostics.encoderBridgeRawVideoCopiedFrames = 120
    input.diagnostics.encoderBridgeMetalTargetCopiedFrames = 120
    input.diagnostics.encoderBridgeZeroCopyFrames = 0
    const v = evaluateAcceptance(input)

    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /still copied through the raw-video FFmpeg bridge/)
    assert.match(v.failures.join(' '), /expected zero-copy/)
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

  it('fails a native preview whose host-present latency or frame lag is too high', () => {
    const p95 = cleanInput()
    p95.diagnostics.previewInputToPresentLatencyP95Ms = 72
    let v = evaluateAcceptance(p95)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /p95 latency 72ms/)

    const p99 = cleanInput()
    p99.diagnostics.previewInputToPresentLatencyP99Ms = 140
    v = evaluateAcceptance(p99)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /p99 latency 140ms/)

    const slow = cleanInput()
    slow.diagnostics.previewInputToPresentLatencyMs = 180
    v = evaluateAcceptance(slow)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /source-to-present latency 180ms/)

    const lagging = cleanInput()
    lagging.diagnostics.previewCompositorFrameLag = 5
    v = evaluateAcceptance(lagging)
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /5 compositor frame/)

    const fallback = cleanInput()
    fallback.claimsNative = false
    fallback.diagnostics.previewInputToPresentLatencyMs = 180
    fallback.diagnostics.previewCompositorFrameLag = 5
    assert.equal(evaluateAcceptance(fallback).pass, true)
  })

  it('accumulates every failure at once', () => {
    const input = cleanInput()
    input.analyzerVerdict = { pass: false, failures: ['repeated-frame burst of 7 consecutive identical frames'] }
    input.diagnostics.encoderBridgeRepeatedFrames = 4
    input.diagnostics.minEncoderSpeed = 0.5
    input.diagnostics.micDroppedFrames = 2
    input.diagnostics.imagePollDuringSession = { total: 100 }
    const v = evaluateAcceptance(input)
    assert.equal(v.pass, false)
    assert.ok(v.failures.length >= 5, `expected ≥5 failures, got ${v.failures.length}`)
  })
})
