import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MAX_PREVIEW_LAG_FRAMES,
  evaluatePreviewRecordingParity,
  summarizePreviewRecordingParity
} from './preview-recording-parity.mjs'

test('a fresh preview on the active scene is in parity', () => {
  const result = evaluatePreviewRecordingParity({
    previewCompositorFrameLag: 1,
    activeSceneRevision: 7
  })
  assert.equal(result.measured, true)
  assert.equal(result.inParity, true)
  assert.equal(result.lagFrames, 1)
})

test('a preview past the lag budget is not in parity', () => {
  const result = evaluatePreviewRecordingParity(
    { previewCompositorFrameLag: 10, activeSceneRevision: 7 },
    { maxLagFrames: DEFAULT_MAX_PREVIEW_LAG_FRAMES }
  )
  assert.equal(result.inParity, false)
  assert.match(result.reasons.join(' '), /behind/)
})

test('a preview/recording scene-revision mismatch fails parity', () => {
  const result = evaluatePreviewRecordingParity({
    previewCompositorFrameLag: 0,
    previewSceneRevision: 4,
    recordingSceneRevision: 5
  })
  assert.equal(result.inParity, false)
  assert.equal(result.revisionMismatch, true)
  assert.match(result.reasons.join(' '), /scene revision/)
})

test('an unmeasured sample is reported as not measured', () => {
  const result = evaluatePreviewRecordingParity({})
  assert.equal(result.measured, false)
  assert.equal(result.inParity, false)
})

test('a one-off lag spike does not break window parity', () => {
  const samples = [
    { previewCompositorFrameLag: 1, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 9, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 2, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 1, activeSceneRevision: 7 }
  ]
  const summary = summarizePreviewRecordingParity(samples)
  assert.equal(summary.inParity, true)
  assert.equal(summary.maxLagFrames, 9)
  assert.ok(summary.behindRatio <= 0.5)
})

test('a consistently lagging preview fails window parity', () => {
  const samples = [
    { previewCompositorFrameLag: 8, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 9, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 7, activeSceneRevision: 7 },
    { previewCompositorFrameLag: 1, activeSceneRevision: 7 }
  ]
  const summary = summarizePreviewRecordingParity(samples)
  assert.equal(summary.inParity, false)
  assert.match(summary.reasons.join(' '), /lag budget/)
})

test('any scene-revision mismatch fails window parity', () => {
  const samples = [
    { previewCompositorFrameLag: 1, previewSceneRevision: 7, recordingSceneRevision: 7 },
    { previewCompositorFrameLag: 1, previewSceneRevision: 6, recordingSceneRevision: 7 }
  ]
  const summary = summarizePreviewRecordingParity(samples)
  assert.equal(summary.inParity, false)
  assert.equal(summary.revisionMismatches, 1)
})

test('an empty window is reported as not measured', () => {
  const summary = summarizePreviewRecordingParity([])
  assert.equal(summary.measured, false)
  assert.equal(summary.inParity, false)
})
