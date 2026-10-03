import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evaluateVisibilityArtifacts,
  parseVisibilityFrames
} from './scene-presets-visibility-artifact.mjs'

const frames = (luma) => luma.map((maxLuma, index) => ({ index, time: index / 30, maxLuma }))
const evidence = (hiddenFrames = frames([16, 16, 16])) => ({
  visibleFrames: frames([16, 200, 100]),
  hiddenFrames,
  visibleCount: 3,
  hiddenCount: 3
})

test('visibility parser keeps every frame and missing luma explicit', () => {
  assert.deepEqual(
    parseVisibilityFrames(
      'frame:0 pts:0 pts_time:0\nlavfi.signalstats.YMAX=16\nframe:1 pts:512 pts_time:0.033333\nlavfi.signalstats.YMAX=200\nframe:2 pts:1024 pts_time:0.066667\n'
    ),
    [
      { index: 0, time: 0, maxLuma: 16 },
      { index: 1, time: 0.033333, maxLuma: 200 },
      { index: 2, time: 0.066667, maxLuma: null }
    ]
  )
})

test('visible camera control plus every hidden background frame passes', () => {
  assert.equal(evaluateVisibilityArtifacts(evidence()).pass, true)
})

test('a single startup or rebuild flash rejects the finished artifact', () => {
  for (const at of [0, 1, 2]) {
    const hidden = frames([16, 16, 16])
    hidden[at].maxLuma = 200
    assert.deepEqual(evaluateVisibilityArtifacts(evidence(hidden)).failures, [
      'hidden camera: foreground pixels in a decoded frame'
    ])
  }
})

test('missing camera pixels cannot establish a passing hidden-camera gate', () => {
  assert.match(
    evaluateVisibilityArtifacts({ ...evidence(), visibleFrames: frames([16, 16, 16]) }).failures[0],
    /acceptance blocked/
  )
})

for (const [description, hiddenFrames, hiddenCount] of [
  ['missing frame', frames([16, 16]), 3],
  ['duplicate frame', [frames([16])[0], frames([16])[0], frames([16])[0]], 3],
  ['missing luma', [{ ...frames([16])[0], maxLuma: null }], 1],
  ['unknown frame count', frames([16]), null],
  ['empty artifact', [], 0]
]) {
  test(`visibility evidence rejects ${description}`, () => {
    assert.equal(
      evaluateVisibilityArtifacts({ ...evidence(hiddenFrames), hiddenCount }).pass,
      false
    )
  })
}
