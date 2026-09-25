import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateFreeformArtifact,
  evaluateFreeformChrome,
  evaluateFreeformGesture,
  evaluateIdleHold,
  evaluateLiveDraftGesture,
  evaluatePreviewCadence,
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

const draftRect = { x: 0.3, y: 0.3, width: 0.3, height: 0.3 }
const rounded = { x: 0.3125, y: 0.3, width: 0.3, height: 0.3 }
function liveGesture() {
  return {
    sourceId: 'source:test-pattern',
    samples: [
      { draft: { sourceId: 'source:test-pattern', transform: draftRect }, ghost: draftRect }
    ],
    final: {
      draft: { sourceId: 'source:test-pattern', transform: rounded },
      ghost: { ...rounded, x: 0.3127 }
    },
    wireDrafts: [
      { transform: draftRect, afterRelease: false, chrome: { guides: [{ axis: 'x', position: 0.5 }] } },
      { transform: rounded, afterRelease: true, chrome: { guides: [] } }
    ],
    wireClears: [],
    commits: [{ transform: rounded }],
    committedTransform: rounded,
    revisionAfter: 12,
    goneMs: 180,
    lastPresent: { sourceId: 'source:test-pattern', transform: rounded, releaseAtRevision: 12 }
  }
}
describe('live canvas draft gate', () => {
  it('accepts a tracked drag whose release draft is the commit', () => {
    assert.deepEqual(evaluateLiveDraftGesture(liveGesture()), { ok: true, failures: [] })
  })
  it('rejects a final draft that lags the ghost beyond tolerance', () => {
    const value = liveGesture()
    value.final.ghost = { ...rounded, x: 0.32 }
    assert.match(evaluateLiveDraftGesture(value).failures.join(), /misses the DOM ghost/)
  })
  it('rejects a draft for another source and a missing draft', () => {
    const other = liveGesture()
    other.samples[0].draft.sourceId = 'source:camera'
    assert.match(evaluateLiveDraftGesture(other).failures.join(), /names source:camera/)
    const missing = liveGesture()
    missing.final.draft = null
    assert.match(evaluateLiveDraftGesture(missing).failures.join(), /no draft on the backend/)
  })
  it('requires the release draft and the commit to be bit-identical', () => {
    const value = liveGesture()
    value.commits[0].transform = { ...rounded, x: 0.31250001 }
    assert.match(evaluateLiveDraftGesture(value).failures.join(), /bit-identical/)
  })
  it('rejects a clear after release, and a stamped revision that is not the installed one', () => {
    const cleared = liveGesture()
    cleared.wireClears = [{}]
    assert.match(evaluateLiveDraftGesture(cleared).failures.join(), /must not clear/)
    const stamped = liveGesture()
    stamped.lastPresent.releaseAtRevision = 11
    assert.match(evaluateLiveDraftGesture(stamped).failures.join(), /stamped for revision 11/)
  })
  it('rejects a draft that outlives the release budget', () => {
    const value = liveGesture()
    value.goneMs = Infinity
    assert.match(evaluateLiveDraftGesture(value).failures.join(), /indefinitely after release/)
  })
  it('a cancelled gesture clears once, quickly, and never sends a release draft', () => {
    const value = {
      ...liveGesture(),
      cancelled: true,
      wireDrafts: [{ transform: draftRect, afterRelease: false }],
      wireClears: [{}],
      commits: [],
      goneMs: 40
    }
    assert.equal(evaluateLiveDraftGesture(value).ok, true)
    assert.match(
      evaluateLiveDraftGesture({ ...value, wireClears: [] }).failures.join(),
      /expected one scene.editor.draft.clear/
    )
    assert.match(
      evaluateLiveDraftGesture({ ...value, goneMs: 900 }).failures.join(),
      /after cancel/
    )
  })

  const hold = { sourceId: 'source:test-pattern' }
  it('ignores the idle hold on the wire before, after and around the gesture', () => {
    const value = liveGesture()
    value.wireDrafts = [
      { sourceId: hold.sourceId, afterRelease: false, chrome: { guides: [] } },
      ...value.wireDrafts,
      { sourceId: hold.sourceId, afterRelease: true, chrome: { guides: [] } }
    ]
    value.settled = hold
    value.holdAfter = hold
    assert.deepEqual(evaluateLiveDraftGesture(value), { ok: true, failures: [] })
    // A cancelled gesture re-holds at once: the hold may be sent before the
    // pointer even lifts, and is what the backend settles on.
    const cancelled = {
      ...value,
      cancelled: true,
      wireDrafts: [
        { transform: draftRect, afterRelease: false },
        { sourceId: hold.sourceId, afterRelease: false, chrome: { guides: [] } }
      ],
      wireClears: [{}],
      commits: [],
      goneMs: 40,
      applied: [{ sourceId: hold.sourceId, transform: draftRect }],
      settled: hold
    }
    assert.deepEqual(evaluateLiveDraftGesture(cancelled), { ok: true, failures: [] })
    // Right after the release the backend may hold nothing yet.
    assert.equal(evaluateLiveDraftGesture({ ...value, settled: null }).ok, true)
  })
  it('never lets a hold stand in for the gesture drafts', () => {
    const onlyHolds = liveGesture()
    onlyHolds.wireDrafts = [{ sourceId: hold.sourceId, afterRelease: false }]
    assert.match(evaluateLiveDraftGesture(onlyHolds).failures.join(), /no scene.editor.draft.set with a rect/)
    const chromeFinal = liveGesture()
    chromeFinal.final.draft = hold
    assert.match(evaluateLiveDraftGesture(chromeFinal).failures.join(), /final draft is chrome-only/)
    const holdApplied = liveGesture()
    holdApplied.applied = [hold]
    assert.match(evaluateLiveDraftGesture(holdApplied).failures.join(), /reported as an applied/)
    const otherHold = liveGesture()
    otherHold.wireDrafts.push({ sourceId: 'source:camera', afterRelease: true })
    assert.match(evaluateLiveDraftGesture(otherHold).failures.join(), /hold names source:camera/)
  })
  it('after release every applied rect is the commit, and what settles is nothing or the hold', () => {
    const drifted = liveGesture()
    drifted.applied = [
      { sourceId: hold.sourceId, transform: rounded },
      { sourceId: hold.sourceId, transform: { ...rounded, x: 0.4 }, releaseAtRevision: 12 }
    ]
    assert.match(evaluateLiveDraftGesture(drifted).failures.join(), /differs from the committed transform/)
    const stamped = liveGesture()
    stamped.applied = [{ sourceId: hold.sourceId, transform: rounded, releaseAtRevision: 11 }]
    assert.match(evaluateLiveDraftGesture(stamped).failures.join(), /stamped for revision 11/)
    const settledRect = liveGesture()
    settledRect.settled = { sourceId: hold.sourceId, transform: rounded }
    assert.match(evaluateLiveDraftGesture(settledRect).failures.join(), /carries a transform/)
    const settledOther = liveGesture()
    settledOther.settled = { sourceId: 'source:camera' }
    assert.match(evaluateLiveDraftGesture(settledOther).failures.join(), /idle hold names source:camera/)
    const noHoldAfter = liveGesture()
    noHoldAfter.holdAfter = null
    assert.match(evaluateLiveDraftGesture(noHoldAfter).failures.join(), /after the gesture, no chrome-only hold/)
  })
})

describe('idle selection hold gate', () => {
  it('accepts a chrome-only draft naming the selection', () => {
    assert.deepEqual(evaluateIdleHold({ sourceId: 'source:camera', draft: { sourceId: 'source:camera' } }), {
      ok: true,
      failures: []
    })
    assert.equal(
      evaluateIdleHold({
        sourceId: 'source:camera',
        draft: { sourceId: 'source:camera', releaseAtRevision: 3 }
      }).ok,
      true
    )
  })
  it('rejects nothing, another source, and a draft with a rect', () => {
    assert.match(evaluateIdleHold({ sourceId: 'source:camera', draft: null }).failures.join(), /no chrome-only hold/)
    assert.equal(evaluateIdleHold({ sourceId: 'source:camera', draft: null, allowNone: true }).ok, true)
    assert.match(
      evaluateIdleHold({ sourceId: 'source:camera', draft: { sourceId: 'source:screen' } }).failures.join(),
      /names source:screen/
    )
    assert.match(
      evaluateIdleHold({
        sourceId: 'source:camera',
        draft: { sourceId: 'source:camera', transform: draftRect }
      }).failures.join(),
      /carries a transform/
    )
  })
})

describe('preview cadence gate', () => {
  // A counter that advances once per tick, read every 10 ms with a 1 ms round
  // trip; a stall holds it for `stallFrames` ticks from `stallAt` and it stays
  // behind afterwards.
  const steady = (count, fps = 30, stallAt = -1, stallFrames = 0) => {
    const frameMs = 1000 / fps
    return Array.from({ length: count }, (_, index) => {
      const at = index * 10
      const tick = Math.floor(at / frameMs)
      const stalledTicks =
        stallAt < 0 || at < stallAt
          ? 0
          : Math.min(stallFrames, tick - Math.floor(stallAt / frameMs))
      return { at, requestedAt: at - 1, framesRendered: 100 + tick - stalledTicks }
    })
  }
  it('accepts a steady 30 fps counter read every 10 ms', () => {
    const result = evaluatePreviewCadence({ samples: steady(200), fps: 30 })
    assert.equal(result.ok, true, result.failures.join())
    assert.ok(result.provenStallMs < 1000 / 30)
    assert.ok(result.boundStallMs <= 1000 / 30 + 21)
    assert.ok(Math.abs(result.meanFps - 30) < 1)
    assert.equal(result.medianIntervalMs, 10)
    assert.equal(result.slowRtts, 0)
  })
  it('accepts a stall of one frame beyond the normal cadence', () => {
    const result = evaluatePreviewCadence({ samples: steady(200, 30, 600, 1), fps: 30 })
    assert.equal(result.ok, true, result.failures.join())
  })
  it('rejects a stall proven longer than the budget and reports both bounds', () => {
    const result = evaluatePreviewCadence({ samples: steady(200, 30, 600, 5), fps: 30 })
    assert.equal(result.ok, false)
    assert.match(result.failures.join(), /stalled at least/)
    assert.ok(result.provenStallFrames > 2 && result.provenStallFrames <= 6)
    assert.ok(result.boundStallMs >= result.provenStallMs)
    assert.equal(result.worstStallAt, 600)
  })
  it('does not prove a stall from one slow round trip, but counts it', () => {
    const samples = steady(100)
    // The reading at 500 ms took 80 ms: it observed the counter somewhere in
    // (420, 500], so the counter advancing normally around it is no stall.
    samples[50].requestedAt = samples[50].at - 80
    const result = evaluatePreviewCadence({ samples, fps: 30 })
    assert.equal(result.ok, true, result.failures.join())
    assert.equal(result.slowRtts, 1)
    assert.equal(result.maxRttMs, 80)
    assert.ok(result.boundStallMs >= result.provenStallMs)
  })
  it('does not fail steady under-rate, but reports it as window drift', () => {
    // 54 fps against a 60 fps target: every frame lands, some a little late.
    const samples = Array.from({ length: 200 }, (_, index) => ({
      at: index * 10,
      requestedAt: index * 10 - 1,
      framesRendered: 100 + Math.floor((index * 10 * 54) / 1000)
    }))
    const result = evaluatePreviewCadence({ samples, fps: 60 })
    assert.equal(result.ok, true, result.failures.join())
    assert.ok(result.worstWindowMissingFrames >= 5)
    assert.ok(result.minWindowFps < 56 && result.minWindowFps > 50)
  })
  it('counts a stall that is still running at the end of sampling', () => {
    const samples = steady(100, 30)
    for (let index = 70; index < 100; index++) samples[index].framesRendered = samples[69].framesRendered
    const result = evaluatePreviewCadence({ samples, fps: 30 })
    assert.equal(result.ok, false)
    assert.ok(result.provenStallMs >= 280)
  })
  it('rejects a counter that never advances, goes backwards, missing fps, and too few samples', () => {
    const frozen = Array.from({ length: 50 }, (_, index) => ({ at: index * 10, framesRendered: 7 }))
    assert.match(evaluatePreviewCadence({ samples: frozen, fps: 30 }).failures.join(), /never advanced/)
    const backwards = steady(50)
    backwards[20].framesRendered = 0
    assert.match(evaluatePreviewCadence({ samples: backwards, fps: 30 }).failures.join(), /backwards/)
    assert.equal(evaluatePreviewCadence({ samples: frozen, fps: 0 }).ok, false)
    assert.equal(evaluatePreviewCadence({ samples: frozen.slice(0, 2), fps: 30 }).ok, false)
  })
})
