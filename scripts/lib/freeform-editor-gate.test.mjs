import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateFreeformArtifact,
  evaluateFreeformChrome,
  evaluateFreeformGesture,
  summarizeFreeformTiming
} from './freeform-editor-gate.mjs'

const before = { x: 100, y: 100, width: 120, height: 80 }
const after = { ...before, x: 125 }
function successful() {
  return {
    captured: true,
    commits: [{}],
    revisionAdvanced: true,
    finalRect: after,
    acceptedRect: after,
    frames: [
      { phase: 'dragging', rect: after, commandedRects: [after], pointerToPaintMs: 16 },
      { phase: 'pending', rect: after, afterRelease: true },
      { phase: 'idle', rect: after }
    ],
    longTasks: []
  }
}
describe('real Freeform trajectory gate', () => {
  it('accepts continuous movement and delayed authoritative handoff', () => {
    assert.equal(evaluateFreeformGesture(successful()).ok, true)
  })
  it('rejects the old-geometry release flicker even for one frame', () => {
    const value = successful()
    value.frames[1].rect = before
    assert.match(evaluateFreeformGesture(value).failures.join(), /old-position/)
  })
  it('rejects release flicker even when the buggy component claims idle', () => {
    const value = successful()
    value.frames[1] = { phase: 'idle', rect: before, afterRelease: true }
    assert.match(evaluateFreeformGesture(value).failures.join(), /old-position/)
  })
  it('rejects NaN and missing authoritative coordinates', () => {
    for (const rect of [{ ...after, x: NaN }, { x: 10 }]) {
      const value = { ...successful(), acceptedRect: rect }
      assert.equal(evaluateFreeformGesture(value).ok, false)
    }
  })
  it('rejects magnetic jumps beyond tiny pointer commands', () => {
    const value = successful()
    value.frames[0] = {
      phase: 'dragging',
      rect: { ...before, x: 107.2 },
      commandedRects: [before, { ...before, x: 100.096 }]
    }
    assert.match(evaluateFreeformGesture(value).failures.join(), /discontinuity/)
  })
  it('rejects a return to an old command halfway through a drag', () => {
    const value = successful()
    value.frames[0] = {
      phase: 'dragging',
      rect: before,
      commandedRects: [{ ...after, x: 126 }],
      previousRect: after,
      pendingAgeMs: 10
    }
    assert.match(evaluateFreeformGesture(value).failures.join(), /discontinuity/)
  })
  it('rejects frozen display even while fresh inputs continue arriving', () => {
    const value = successful()
    value.frames[0] = {
      phase: 'dragging',
      rect: before,
      commandedRects: [after],
      previousRect: before,
      pendingAgeMs: 34
    }
    assert.match(evaluateFreeformGesture(value).failures.join(), /unpainted/)
  })
  it('permits recent coalesced commands but rejects already painted history', () => {
    const value = successful()
    value.frames[0] = {
      phase: 'dragging',
      rect: after,
      commandedRects: [after],
      pendingAgeMs: 38,
      previousInputIndex: 0,
      matchedInputIndex: 2,
      pointerToPaintMs: 19
    }
    assert.equal(evaluateFreeformGesture(value).ok, true)
    value.frames[0].previousInputIndex = 3
    assert.match(evaluateFreeformGesture(value).failures.join(), /historical command/)
  })
  it('rejects resnapped backend geometry, extra RPCs and missing revision evidence', () => {
    const value = successful()
    value.acceptedRect = before
    value.commits.push({})
    value.revisionAdvanced = false
    assert.equal(evaluateFreeformGesture(value).failures.length, 3)
  })
  it('requires real capture, measured latency and frame evidence', () => {
    const value = successful()
    value.captured = false
    value.frames = []
    assert.equal(evaluateFreeformGesture(value).failures.length, 3)
  })
  it('enforces p95 and long-task budgets', () => {
    const value = successful()
    value.frames[0].pointerToPaintMs = 34
    value.longTasks = [{ duration: 51 }]
    assert.equal(evaluateFreeformGesture(value).failures.length, 2)
  })
  it('checks each rapid edit against its own release rectangle', () => {
    const second = { ...after, x: 133 }
    const value = {
      ...successful(),
      quickEdits: true,
      captureCount: 2,
      commits: [{}, {}],
      finalRect: second,
      acceptedRect: second
    }
    value.frames[1].releaseRect = after
    value.frames[2] = { phase: 'pending', afterRelease: true, rect: second, releaseRect: second }
    assert.equal(evaluateFreeformGesture(value).ok, true)
    value.frames[2].rect = before
    assert.match(evaluateFreeformGesture(value).failures.join(), /old-position/)
  })
  it('allows cancellation only without a commit', () => {
    const value = { ...successful(), cancelled: true, commits: [] }
    assert.equal(evaluateFreeformGesture(value).ok, true)
    value.commits = [{}]
    assert.equal(evaluateFreeformGesture(value).ok, false)
  })
})
describe('Freeform control geometry', () => {
  function chrome() {
    return {
      canvas: { x: 20, y: 50, width: 400, height: 225 },
      toolbar: { x: 0, y: 0, width: 440, height: 30 },
      footer: { x: 0, y: 300, width: 440, height: 30 },
      handles: [{ id: 'se', box: { x: 100, y: 100, width: 24, height: 24 }, hitMatches: true }]
    }
  }
  it('accepts separated chrome and reachable handles', () =>
    assert.equal(evaluateFreeformChrome(chrome()).ok, true))
  it('keeps a tiny source body independently draggable', () => {
    const value = chrome()
    value.tinySourceBody = { box: { x: 30, y: 60, width: 12, height: 12 }, hitMatches: false }
    assert.match(evaluateFreeformChrome(value).failures.join(), /tiny source body/)
  })
  it('requires a real centered circle rather than a capsule on nonsquare bounds', () => {
    const value = chrome()
    value.paintedCircle = {
      tag: 'circle',
      bounds: { x: 25, y: 0, width: 50, height: 50 },
      sourceBounds: { x: 0, y: 0, width: 100, height: 50 }
    }
    assert.equal(evaluateFreeformChrome(value).ok, true)
    value.paintedCircle = {
      ...value.paintedCircle,
      tag: 'rect',
      bounds: { x: 0, y: 0, width: 100, height: 50 }
    }
    assert.match(evaluateFreeformChrome(value).failures.join(), /not circular/)
  })
  it('rejects obstruction, incorrect hit targets and overlapping handles', () => {
    const value = chrome()
    value.toolbar.y = 40
    value.handles.push({
      id: 'e',
      box: { x: 105, y: 105, width: 24, height: 24 },
      hitMatches: false
    })
    assert.equal(evaluateFreeformChrome(value).failures.length, 3)
  })
})

describe('final artifact placement', () => {
  const rects = [
    { x: 0.1, y: 0.1, width: 0.3, height: 0.4 },
    { x: 0.6, y: 0.5, width: 0.2, height: 0.3 }
  ]
  function fixture(boxes = rects) {
    const width = 100,
      height = 100,
      pixels = new Uint8Array(width * height * 3)
    for (const box of boxes)
      for (let y = Math.round(box.y * height); y < Math.round((box.y + box.height) * height); y++)
        for (let x = Math.round(box.x * width); x < Math.round((box.x + box.width) * width); x++)
          pixels.fill(180, (y * width + x) * 3, (y * width + x) * 3 + 3)
    return { pixels, width, height, rects }
  }
  it('accepts both committed source rectangles decoded from the frame', () =>
    assert.equal(evaluateFreeformArtifact(fixture()).ok, true))
  it('rejects a recording that restored the full-canvas preset', () =>
    assert.equal(
      evaluateFreeformArtifact(fixture([{ x: 0, y: 0, width: 1, height: 1 }])).ok,
      false
    ))
  it('rejects missing or displaced source pixels', () => {
    assert.equal(evaluateFreeformArtifact(fixture([rects[0]])).ok, false)
    assert.equal(evaluateFreeformArtifact(fixture([rects[0], { ...rects[1], x: 0.66 }])).ok, false)
  })
})

it('summarizes the population of samples rather than averaging gesture percentiles', () => {
  const timing = summarizeFreeformTiming([
    {
      orientation: 'landscape',
      frames: Array.from({ length: 20 }, () => ({ pointerToPaintMs: 10 })),
      gate: { p95: 10 }
    },
    { orientation: 'portrait', frames: [{ pointerToPaintMs: 40 }, {}], gate: { p95: 40 } }
  ])
  assert.equal(timing.aggregate.samples, 21)
  assert.equal(timing.aggregate.p95, 10)
  assert.equal(timing.aggregate.maximumGestureP95, 40)
  assert.equal(timing.byOrientation.portrait.p95, 40)
  assert.equal(timing.byOrientation.landscape.samples, 20)
})

it('requires capture observations to follow the matching delivered trusted down', () => {
  const gesture = successful()
  gesture.pointerDowns = [{ at: 20, pointerId: 2, trusted: true }]
  gesture.captureChecks = [{ at: 21, pointerId: 2, captured: true }]
  assert.equal(evaluateFreeformGesture(gesture).ok, true)
  gesture.captureChecks[0].at = 19
  assert.equal(evaluateFreeformGesture(gesture).ok, false)
  gesture.captureChecks[0].at = 21
  gesture.captureChecks[0].pointerId = 1
  assert.equal(evaluateFreeformGesture(gesture).ok, false)
  gesture.captureChecks[0].pointerId = 2
  gesture.pointerDowns[0].trusted = false
  assert.equal(evaluateFreeformGesture(gesture).ok, false)
})
