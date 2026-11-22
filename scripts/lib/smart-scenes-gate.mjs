// Pure gates for smoke:smart-scenes (plan 210 S11): what the recording, the
// stream sink, the Screen file and a Clips save must show, and the budgets
// each step is held to. Everything here is data in, verdict out, so
// `smart-scenes-gate.test.mjs` can hold it to its word without a Mac.
//
// Frame input is the same rgb24 downscale the window-switch probe decodes
// (`scene-window-switch-frames.mjs`), with one feature added per frame: how
// sharp it is. Hide screen (D8) publishes a frosted still: the picture is
// scaled down to 48 rows, blurred and scaled back up, so every edge becomes a
// ramp several pixels wide. The fixtures draw hard edges (a white block and a
// white counter on a flat colour), so the share of neighbouring pixel pairs
// that jump by more than `SHARP_EDGE_THRESHOLD` collapses while hidden and
// comes back after Show. A frosted still is also still: its motion strip
// repeats frame after frame.

import { featuresFromRawFrames } from './scene-window-switch-frames.mjs'

/** D5, D10, D8 and D11 budgets the smoke holds each step to. */
export const SMART_SCENES_BUDGET = Object.freeze({
  /** Historical D5 target; switch timing is report-only after the plan 231 A/B. */
  switchP95Ms: 150,
  /** D10: an app must stay in front this long before the stream follows it. */
  followSettleMs: 400,
  /**
   * What the smoke cannot see exactly: `lsappinfo` is polled every 20 ms and
   * the follower's own timer fires one tick after the settle. Added once to
   * the follow budget, and said so in the summary.
   */
  followObservationSlackMs: 100,
  /**
   * D11: a password manager in front hides within this, with no settle: the
   * follower hides on the front change itself, so the manager's window never
   * goes on air for the settle. What remains is the observer's poll, the
   * renderer's dispatch and the backend's hide.
   */
  passwordManagerHideMs: 600,
  /**
   * D11: the screen shows again once another app has held the front for the
   * settle (so a ⌘-Tab pass back to the manager never shows between), plus
   * the same dispatch and show.
   */
  passwordManagerShowMs: 400 + 600,
  /**
   * How long after a hide (or show) press each output may still carry the
   * previous picture: one capture frame, the compositor tick, the encoder
   * and (for the stream) the RTMP leg. Frames inside this edge are not judged.
   */
  hideEdgeMs: 700,
  /**
   * The clock anchor is the first white frame at or after the flash, so every
   * wall time read off a file is quantized to one frame (33 ms at 30 fps) and
   * drifts a few ms over a run. A live frame this close before the Show press
   * is the first frame after it, not a leak; the hidden span ends this early.
   */
  showSlackMs: 70,
  /** The first frosted frame must land within this after the press. */
  hideLatencyMaxMs: 1000,
  /** Likewise the first live frame after Show. */
  showLatencyMaxMs: 1000
})

/** Channel-sum jump between neighbouring pixels that counts as a hard edge. */
export const SHARP_EDGE_THRESHOLD = 200
/**
 * A live fixture frame has at least this share of hard-edge pairs. Measured
 * on this Mac (2026-10-29, 320x180 analysis of a 1920x1080 program): live
 * frames 0.00122 to 0.00149 on the recording, the stream and a clip; the
 * frost 0 on all three. The bounds sit at half the live floor and a third of
 * that, so an encoder or scaler change has to move the picture a long way
 * before either side is misread.
 */
export const SHARP_LIVE_MIN = 0.0006
/** A frosted frame has at most this share (the ramps are 4 px wide at 48 rows). */
export const SHARP_HIDDEN_MAX = 0.00015
/** Share of the hidden span that must be frosted (the rest names its frames). */
export const FROSTED_SHARE_MIN = 1

/**
 * Share of horizontally and vertically adjacent pixel pairs whose channel-sum
 * difference exceeds the threshold. Rows and columns both, so a horizontal
 * edge (the block's top) counts as much as a vertical one.
 */
export function sharpFraction(frame, width, height, threshold = SHARP_EDGE_THRESHOLD) {
  let sharp = 0
  let pairs = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      if (x + 1 < width) {
        const next = offset + 3
        const diff =
          Math.abs(frame[offset] - frame[next]) +
          Math.abs(frame[offset + 1] - frame[next + 1]) +
          Math.abs(frame[offset + 2] - frame[next + 2])
        if (diff > threshold) sharp += 1
        pairs += 1
      }
      if (y + 1 < height) {
        const below = offset + width * 3
        const diff =
          Math.abs(frame[offset] - frame[below]) +
          Math.abs(frame[offset + 1] - frame[below + 1]) +
          Math.abs(frame[offset + 2] - frame[below + 2])
        if (diff > threshold) sharp += 1
        pairs += 1
      }
    }
  }
  return pairs ? sharp / pairs : 0
}

// ---------------------------------------------------------------------------
// The content clock (plan 210 D8)
// ---------------------------------------------------------------------------
//
// The fixture draws, on every frame, the wall time it drew it: 17 black and
// white cells along the top right (scripts/fixtures/fixture-window.swift).
// So any copy of a frame, in any output, says when its picture was on the
// screen, and the hide step judges privacy by content instead of by aligning
// each file's timeline to the wall clock. That alignment hangs on one flash
// and on every leg's timeline staying wall-true; on this Mac it was off by
// 140 to 400 ms (a recording's frame-count timeline catches up after drops,
// and the flash itself takes a capture's latency to reach the file), which
// is more than any edge it was asked to judge (S3 thread, 2026-11-22).

/** Strip geometry (fractions, origin top left), as the fixture draws it. */
export const CONTENT_CLOCK = Object.freeze({
  x0: 0.45,
  x1: 0.97,
  y0: 0.03,
  y1: 0.1,
  /** Guard white, guard black, data bits, even parity. */
  cells: 17,
  dataBits: 14,
  /** One count is this many milliseconds of epoch time. */
  stepMs: 8
})

/** The clock wraps after this long (2^14 × 8 ms, about 131 s). */
export const CONTENT_CLOCK_PERIOD_MS = 2 ** CONTENT_CLOCK.dataBits * CONTENT_CLOCK.stepMs

/** The guards must differ by at least this much luma, or nothing is read. */
const CONTENT_CLOCK_MIN_CONTRAST = 100
/** A data cell this close to the guards' midpoint (share of contrast) is unreadable. */
const CONTENT_CLOCK_AMBIGUOUS_SHARE = 0.2

function cellLuma(frame, width, x0, x1, y0, y1) {
  const xa = Math.max(0, Math.floor(x0))
  const xb = Math.max(xa + 1, Math.ceil(x1))
  const ya = Math.max(0, Math.floor(y0))
  const yb = Math.max(ya + 1, Math.ceil(y1))
  let sum = 0
  let count = 0
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      const offset = (y * width + x) * 3
      if (offset + 2 >= frame.length) continue
      sum += 0.299 * frame[offset] + 0.587 * frame[offset + 1] + 0.114 * frame[offset + 2]
      count += 1
    }
  }
  return count ? sum / count : 0
}

/**
 * The fixture's draw time for one rgb24 frame, in milliseconds modulo
 * `CONTENT_CLOCK_PERIOD_MS`, or null when the frame carries no readable clock
 * (the frost, a flash, another window, a damaged strip). Each cell is read
 * from its middle half, so a blurred edge between cells never decides a bit,
 * and the parity bit rejects a strip read wrong.
 */
export function decodeContentClock(frame, width, height, clock = CONTENT_CLOCK) {
  const stripX0 = clock.x0 * width
  const cellWidth = ((clock.x1 - clock.x0) * width) / clock.cells
  const stripY0 = clock.y0 * height
  const stripHeight = (clock.y1 - clock.y0) * height
  const lumas = []
  for (let cell = 0; cell < clock.cells; cell += 1) {
    lumas.push(
      cellLuma(
        frame,
        width,
        stripX0 + (cell + 0.25) * cellWidth,
        stripX0 + (cell + 0.75) * cellWidth,
        stripY0 + 0.25 * stripHeight,
        stripY0 + 0.75 * stripHeight
      )
    )
  }
  const [white, black] = lumas
  const contrast = white - black
  if (!(contrast >= CONTENT_CLOCK_MIN_CONTRAST)) return null
  const middle = (white + black) / 2
  const bits = []
  for (const luma of lumas.slice(2)) {
    if (Math.abs(luma - middle) < contrast * CONTENT_CLOCK_AMBIGUOUS_SHARE) return null
    bits.push(luma > middle)
  }
  const data = bits.slice(0, clock.dataBits)
  const parity = bits[clock.dataBits]
  const ones = data.filter(Boolean).length
  if (ones % 2 === 1 !== parity) return null
  const value = data.reduce((acc, bit) => acc * 2 + (bit ? 1 : 0), 0)
  return value * clock.stepMs
}

/** The epoch milliseconds a decoded (wrapped) clock value nearest `referenceMs` stands for. */
export function unwrapContentClockMs(moduloMs, referenceMs, periodMs = CONTENT_CLOCK_PERIOD_MS) {
  const base = referenceMs - (((referenceMs % periodMs) + periodMs) % periodMs)
  let best = null
  for (const k of [-1, 0, 1]) {
    const candidate = base + k * periodMs + moduloMs
    if (best == null || Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs))
      best = candidate
  }
  return best
}

/**
 * The probe's per-frame features plus `sharp` (the hard-edge share) and
 * `contentMs` (the fixture's content clock, wrapped, or null) for one rgb24
 * buffer of many frames.
 */
export function frostFeaturesFromRawFrames(buffer, { width, height, repeatThreshold } = {}) {
  const features = featuresFromRawFrames(buffer, { width, height, repeatThreshold })
  const frameBytes = width * height * 3
  for (const feature of features) {
    const frame = buffer.subarray(feature.index * frameBytes, (feature.index + 1) * frameBytes)
    feature.sharp = Number(sharpFraction(frame, width, height).toFixed(5))
    feature.contentMs = decodeContentClock(frame, width, height)
  }
  return features
}

/**
 * Judges one output over a hide/show pair, in wall time.
 *
 * - Before the hide press (`liveBeforeMs` back) the frames are live.
 * - Inside the hidden span, after `hideEdgeMs`, every frame is frosted (sharp
 *   at most `SHARP_HIDDEN_MAX`) and still (the motion strip repeats).
 * - After Show plus `hideEdgeMs`, the frames are live again (sharp at least
 *   `SHARP_LIVE_MIN`) and moving.
 * - The fixture's own white flashes (the alignment marks) are not judged as
 *   live or not: a flash has no edges by design, and a file cut soon after the
 *   end flash (a clip) would otherwise fall under the live share on them
 *   alone (issue #1329).
 * - The first frosted frame lands within `hideLatencyMaxMs` of the press, and
 *   the first live frame within `showLatencyMaxMs` of Show.
 *
 * @param {object} input
 * @param {Array<{index:number,sharp:number,repeated:boolean,centre:string}>} input.features
 * @param {number[]} input.ptsMs
 * @param {number} input.offsetMs wall = pts + offset
 * @param {number} input.hideAtMs wall time of the hide press
 * @param {number} input.showAtMs wall time of the show press
 * @param {number} [input.untilMs] wall time where the live-after window ends
 * @param {number} [input.liveBeforeMs] how far before the hide to sample live frames
 */
export function hideSpanVerdict({
  features,
  ptsMs,
  offsetMs,
  hideAtMs,
  showAtMs,
  untilMs = Number.POSITIVE_INFINITY,
  liveBeforeMs = 1500,
  budget = SMART_SCENES_BUDGET,
  sharpLiveMin = SHARP_LIVE_MIN,
  sharpHiddenMax = SHARP_HIDDEN_MAX
}) {
  const verdict = {
    hideAtMs,
    showAtMs,
    liveBefore: { frames: 0, sharpFrames: 0, movingFrames: 0, sharpP50: null },
    hidden: { frames: 0, frostedFrames: 0, stillFrames: 0, leaks: [], sharpMax: null },
    liveAfter: { frames: 0, sharpFrames: 0, movingFrames: 0, sharpP50: null },
    hideLatencyMs: null,
    showLatencyMs: null,
    ok: false,
    failures: []
  }
  const before = []
  const after = []
  let hiddenSharp = []
  for (const feature of features) {
    const pts = ptsMs[feature.index]
    if (pts == null) continue
    const wall = pts + offsetMs
    if (wall >= hideAtMs - liveBeforeMs && wall < hideAtMs) {
      if (feature.centre === 'white') continue
      verdict.liveBefore.frames += 1
      before.push(feature.sharp)
      if (feature.sharp >= sharpLiveMin) verdict.liveBefore.sharpFrames += 1
      if (!feature.repeated) verdict.liveBefore.movingFrames += 1
      continue
    }
    if (wall >= hideAtMs && wall < showAtMs) {
      if (verdict.hideLatencyMs == null && feature.sharp <= sharpHiddenMax) {
        verdict.hideLatencyMs = Math.round(wall - hideAtMs)
      }
      if (wall < hideAtMs + budget.hideEdgeMs || wall >= showAtMs - budget.showSlackMs) continue
      verdict.hidden.frames += 1
      hiddenSharp.push(feature.sharp)
      const frosted = feature.sharp <= sharpHiddenMax
      if (frosted) verdict.hidden.frostedFrames += 1
      else
        verdict.hidden.leaks.push({
          index: feature.index,
          wallMs: Math.round(wall),
          sharp: feature.sharp
        })
      if (feature.repeated) verdict.hidden.stillFrames += 1
      continue
    }
    if (wall >= showAtMs && wall < untilMs) {
      if (verdict.showLatencyMs == null && feature.sharp >= sharpLiveMin) {
        verdict.showLatencyMs = Math.round(wall - showAtMs)
      }
      if (wall < showAtMs + budget.hideEdgeMs || feature.centre === 'white') continue
      verdict.liveAfter.frames += 1
      after.push(feature.sharp)
      if (feature.sharp >= sharpLiveMin) verdict.liveAfter.sharpFrames += 1
      if (!feature.repeated) verdict.liveAfter.movingFrames += 1
    }
  }
  verdict.liveBefore.sharpP50 = median(before)
  verdict.liveAfter.sharpP50 = median(after)
  verdict.hidden.sharpMax = hiddenSharp.length ? Math.max(...hiddenSharp) : null

  const failures = verdict.failures
  if (verdict.liveBefore.frames === 0) failures.push('no frames before the hide')
  else if (verdict.liveBefore.sharpFrames < verdict.liveBefore.frames * 0.8)
    failures.push(
      `only ${verdict.liveBefore.sharpFrames}/${verdict.liveBefore.frames} frames before the hide are live-sharp (p50 ${verdict.liveBefore.sharpP50})`
    )
  if (verdict.hidden.frames === 0) failures.push('no frames inside the hidden span')
  else {
    if (verdict.hidden.frostedFrames < verdict.hidden.frames * FROSTED_SHARE_MIN)
      failures.push(
        `${verdict.hidden.leaks.length} live frame(s) inside the hidden span (sharp max ${verdict.hidden.sharpMax}, allowed ${sharpHiddenMax})`
      )
    if (verdict.hidden.stillFrames < verdict.hidden.frames - 1)
      failures.push(
        `the hidden picture moved: ${verdict.hidden.frames - verdict.hidden.stillFrames} changing frame(s) of ${verdict.hidden.frames}`
      )
  }
  if (verdict.liveAfter.frames === 0) failures.push('no frames after Show')
  else {
    if (verdict.liveAfter.sharpFrames < verdict.liveAfter.frames * 0.8)
      failures.push(
        `only ${verdict.liveAfter.sharpFrames}/${verdict.liveAfter.frames} frames after Show are live-sharp (p50 ${verdict.liveAfter.sharpP50})`
      )
    if (verdict.liveAfter.movingFrames === 0) failures.push('the picture after Show never moved')
  }
  if (verdict.hideLatencyMs == null) failures.push('no frosted frame after the hide press')
  else if (verdict.hideLatencyMs > budget.hideLatencyMaxMs)
    failures.push(
      `first frosted frame ${verdict.hideLatencyMs} ms after the press (> ${budget.hideLatencyMaxMs})`
    )
  if (verdict.showLatencyMs == null) failures.push('no live frame after Show')
  else if (verdict.showLatencyMs > budget.showLatencyMaxMs)
    failures.push(
      `first live frame ${verdict.showLatencyMs} ms after Show (> ${budget.showLatencyMaxMs})`
    )
  verdict.ok = failures.length === 0
  return verdict
}

/**
 * How Hide screen's two edges are judged by content (plan 210 D8, macOS).
 */
export const HIDE_CONTENT_BUDGET = Object.freeze({
  /**
   * A picture drawn this close before the Show press may first reach the
   * glass after it (the window server composites it on a later refresh: two
   * at 60 Hz), so ScreenCaptureKit takes it after the Show and it is the
   * screen shown again, not the hidden one. The hide edge needs no slack:
   * a picture drawn after the gate closed is taken after it and held.
   */
  showDisplaySlackMs: 34,
  /** Share of live frames that must carry a readable clock, or the judge is blind. */
  minReadableShare: 0.8,
  /** A clock read this far behind the newest one before it is out of order. */
  backwardsToleranceMs: 40,
  /** The frost may be this much shorter than the press span in a file's own timeline. */
  frostShortfallMs: 500,
  /** How far before the hide (and after the show) the live share is sampled. */
  liveWindowMs: 1500,
  /** After the frost ends, frames this close are not judged as live or not. */
  showEdgeMs: 700
})

/**
 * Plan 210 D8 by content: no picture the screen showed while it was hidden
 * may reach the file, at either edge or in between. A frame's picture was
 * drawn at its content clock; one drawn at or after the gate closed
 * (`hideGateAtMs`, the backend's `since`) and before the Show press, less the
 * display slack, is a leak, wherever it sits in the file's timeline.
 *
 * Also: enough live frames carry a readable clock (else the judge is blind),
 * and the clock never runs backwards (a picture from before the hide shown
 * again after newer ones is a cache leaking, or a misread).
 *
 * @param {object} input
 * @param {Array<{index:number,sharp:number,centre:string,contentMs:number|null}>} input.features
 * @param {number[]} input.ptsMs
 * @param {number} input.hideGateAtMs wall time the gate closed
 * @param {number} input.showAtMs wall time of the show press
 */
export function hiddenContentVerdict({
  features,
  ptsMs,
  hideGateAtMs,
  showAtMs,
  budget = HIDE_CONTENT_BUDGET,
  sharpLiveMin = SHARP_LIVE_MIN,
  clock = CONTENT_CLOCK
}) {
  const verdict = {
    hideGateAtMs,
    showAtMs,
    readable: 0,
    liveFrames: 0,
    liveReadable: 0,
    leaks: [],
    backwards: [],
    /** The newest picture drawn before the gate closed, and how long before. */
    lastBeforeHideMs: null,
    /** The first picture after the hidden span, drawn this long after the Show press. */
    firstAfterShowMs: null,
    ok: false,
    failures: []
  }
  const leakFromMs = hideGateAtMs
  const leakUntilMs = showAtMs - budget.showDisplaySlackMs
  let newest = null
  for (const feature of features) {
    const live = feature.sharp >= sharpLiveMin && feature.centre !== 'white'
    if (live) verdict.liveFrames += 1
    if (feature.contentMs == null) continue
    verdict.readable += 1
    if (live) verdict.liveReadable += 1
    const drawnAtMs = unwrapContentClockMs(feature.contentMs, hideGateAtMs)
    const pts = ptsMs[feature.index]
    // The clock counts in steps: the picture was drawn in [drawnAt, drawnAt + step).
    if (drawnAtMs >= leakFromMs && drawnAtMs + clock.stepMs <= leakUntilMs) {
      verdict.leaks.push({
        index: feature.index,
        ptsMs: pts == null ? null : Math.round(pts),
        drawnAfterHideMs: Math.round(drawnAtMs - hideGateAtMs),
        drawnBeforeShowMs: Math.round(showAtMs - drawnAtMs)
      })
    }
    if (drawnAtMs < hideGateAtMs) {
      const before = hideGateAtMs - drawnAtMs
      if (verdict.lastBeforeHideMs == null || before < verdict.lastBeforeHideMs)
        verdict.lastBeforeHideMs = Math.round(before)
    } else if (drawnAtMs + clock.stepMs > leakUntilMs) {
      const after = drawnAtMs - showAtMs
      if (verdict.firstAfterShowMs == null || after < verdict.firstAfterShowMs)
        verdict.firstAfterShowMs = Math.round(after)
    }
    if (newest != null && drawnAtMs < newest - budget.backwardsToleranceMs)
      verdict.backwards.push({
        index: feature.index,
        behindMs: Math.round(newest - drawnAtMs)
      })
    newest = newest == null ? drawnAtMs : Math.max(newest, drawnAtMs)
  }
  const failures = verdict.failures
  if (verdict.liveFrames === 0) failures.push('no live frames to read the content clock from')
  else if (verdict.liveReadable < verdict.liveFrames * budget.minReadableShare)
    failures.push(
      `the content clock is readable on only ${verdict.liveReadable}/${verdict.liveFrames} live frames (the judge would be blind)`
    )
  if (verdict.leaks.length > 0) {
    const first = verdict.leaks[0]
    const last = verdict.leaks.at(-1)
    failures.push(
      `${verdict.leaks.length} frame(s) show the screen while it was hidden (drawn ${first.drawnAfterHideMs} ms after the hide … ${last.drawnBeforeShowMs} ms before the show; first at pts ${first.ptsMs} ms)`
    )
  }
  if (verdict.backwards.length > 0)
    failures.push(
      `the content clock ran backwards ${verdict.backwards.length} time(s) (up to ${Math.max(...verdict.backwards.map((entry) => entry.behindMs))} ms): an old picture came back`
    )
  verdict.ok = failures.length === 0
  return verdict
}

/**
 * The frost itself, judged in the file's own timeline instead of the wall
 * clock (a recording's timeline is not wall-true under load): one unbroken
 * run of frosted, still frames around the press span, no live frame inside
 * it, live frames before it and after it, and roughly as long as the span.
 * Its edges are also placed on the wall clock through the flash anchor, for
 * the coarse latency bounds only.
 *
 * @param {object} input
 * @param {Array<{index:number,sharp:number,repeated:boolean,centre:string}>} input.features
 * @param {number[]} input.ptsMs
 * @param {number} input.offsetMs wall = pts + offset (the flash anchor)
 * @param {number} input.hideAtMs wall time of the hide press
 * @param {number} input.showAtMs wall time of the show press
 * @param {number} [input.untilMs] wall time where the live-after window ends
 */
export function frostRunVerdict({
  features,
  ptsMs,
  offsetMs,
  hideAtMs,
  showAtMs,
  untilMs = Number.POSITIVE_INFINITY,
  budget = HIDE_CONTENT_BUDGET,
  latencyBudget = SMART_SCENES_BUDGET,
  sharpLiveMin = SHARP_LIVE_MIN,
  sharpHiddenMax = SHARP_HIDDEN_MAX
}) {
  const verdict = {
    hideAtMs,
    showAtMs,
    frost: null,
    liveBefore: { frames: 0, sharpFrames: 0, movingFrames: 0, sharpP50: null },
    hidden: { frames: 0, frostedFrames: 0, stillFrames: 0, leaks: [], sharpMax: null },
    liveAfter: { frames: 0, sharpFrames: 0, movingFrames: 0, sharpP50: null },
    hideLatencyMs: null,
    showLatencyMs: null,
    ok: false,
    failures: []
  }
  const failures = verdict.failures
  const span = showAtMs - hideAtMs
  const wall = (feature) => {
    const pts = ptsMs[feature.index]
    return pts == null ? null : pts + offsetMs
  }
  const frosted = (feature) => feature.sharp <= sharpHiddenMax && feature.centre !== 'white'
  // The anchor can be off by a few hundred ms, so the frost is looked for
  // well around the presses; the run itself is what is judged.
  const searchFrom = hideAtMs - budget.liveWindowMs
  const searchTo = showAtMs + budget.liveWindowMs
  let first = null
  let last = null
  for (let position = 0; position < features.length; position += 1) {
    const at = wall(features[position])
    if (at == null || at < searchFrom || at > searchTo) continue
    if (!frosted(features[position])) continue
    if (first == null) first = position
    last = position
  }
  if (first == null) {
    failures.push('no frosted frame around the hide and show presses')
    return verdict
  }
  const run = features.slice(first, last + 1)
  const frameMs =
    ptsMs.length > 1 ? (ptsMs.at(-1) - ptsMs[0]) / Math.max(1, ptsMs.length - 1) : 33.3
  const runFromPts = ptsMs[features[first].index]
  const runToPts = ptsMs[features[last].index] + frameMs
  verdict.frost = {
    firstIndex: features[first].index,
    lastIndex: features[last].index,
    durationMs: Math.round(runToPts - runFromPts)
  }
  const sharps = []
  for (const feature of run) {
    verdict.hidden.frames += 1
    sharps.push(feature.sharp)
    if (frosted(feature)) verdict.hidden.frostedFrames += 1
    else
      verdict.hidden.leaks.push({
        index: feature.index,
        ptsMs: Math.round(ptsMs[feature.index]),
        sharp: feature.sharp
      })
    if (feature.repeated) verdict.hidden.stillFrames += 1
  }
  verdict.hidden.sharpMax = sharps.length ? Math.max(...sharps) : null
  if (verdict.hidden.leaks.length > 0)
    failures.push(
      `${verdict.hidden.leaks.length} live frame(s) inside the frost (sharp max ${verdict.hidden.sharpMax}, allowed ${sharpHiddenMax})`
    )
  if (verdict.hidden.stillFrames < verdict.hidden.frames - 1)
    failures.push(
      `the hidden picture moved: ${verdict.hidden.frames - verdict.hidden.stillFrames} changing frame(s) of ${verdict.hidden.frames}`
    )
  if (verdict.frost.durationMs < span - budget.frostShortfallMs)
    failures.push(
      `the frost lasts ${verdict.frost.durationMs} ms in the file, the screen was hidden for ${span} ms`
    )

  const before = []
  const after = []
  const untilPts = untilMs - offsetMs
  for (const feature of features) {
    const pts = ptsMs[feature.index]
    if (pts == null || feature.centre === 'white') continue
    if (pts >= runFromPts - budget.liveWindowMs && pts < runFromPts) {
      verdict.liveBefore.frames += 1
      before.push(feature.sharp)
      if (feature.sharp >= sharpLiveMin) verdict.liveBefore.sharpFrames += 1
      if (!feature.repeated) verdict.liveBefore.movingFrames += 1
    } else if (pts >= runToPts + budget.showEdgeMs && pts < untilPts) {
      verdict.liveAfter.frames += 1
      after.push(feature.sharp)
      if (feature.sharp >= sharpLiveMin) verdict.liveAfter.sharpFrames += 1
      if (!feature.repeated) verdict.liveAfter.movingFrames += 1
    }
  }
  verdict.liveBefore.sharpP50 = median(before)
  verdict.liveAfter.sharpP50 = median(after)
  if (verdict.liveBefore.frames === 0) failures.push('no frames before the frost')
  else if (verdict.liveBefore.sharpFrames < verdict.liveBefore.frames * 0.8)
    failures.push(
      `only ${verdict.liveBefore.sharpFrames}/${verdict.liveBefore.frames} frames before the frost are live-sharp (p50 ${verdict.liveBefore.sharpP50})`
    )
  if (verdict.liveAfter.frames === 0) failures.push('no frames after the frost')
  else {
    if (verdict.liveAfter.sharpFrames < verdict.liveAfter.frames * 0.8)
      failures.push(
        `only ${verdict.liveAfter.sharpFrames}/${verdict.liveAfter.frames} frames after the frost are live-sharp (p50 ${verdict.liveAfter.sharpP50})`
      )
    if (verdict.liveAfter.movingFrames === 0) failures.push('the picture after Show never moved')
  }
  verdict.hideLatencyMs = Math.round(runFromPts + offsetMs - hideAtMs)
  verdict.showLatencyMs = Math.round(runToPts + offsetMs - showAtMs)
  if (verdict.hideLatencyMs > latencyBudget.hideLatencyMaxMs)
    failures.push(
      `first frosted frame ${verdict.hideLatencyMs} ms after the press (> ${latencyBudget.hideLatencyMaxMs})`
    )
  if (verdict.showLatencyMs > latencyBudget.showLatencyMaxMs)
    failures.push(
      `first live frame ${verdict.showLatencyMs} ms after Show (> ${latencyBudget.showLatencyMaxMs})`
    )
  verdict.ok = failures.length === 0
  return verdict
}

/**
 * D5 against the probe's variant stats (`pixels.latencyMs`, black and
 * wrong-layout totals, cuts seen). Timing is measured, not an absolute gate:
 * main also exceeds 150 ms on this host (plan-231-run/AB/notes.md).
 */
export function switchGate(stats) {
  const failures = []
  if (!stats) return { ok: false, failures: ['no switch statistics'] }
  const pixels = stats.pixels
  if (!pixels) failures.push('no pixel evidence (the recording could not be aligned)')
  else {
    if (pixels.latencyMs?.p95 == null) failures.push('no switch latency measured')
    const black = (pixels.blackFramesTotal ?? 0) + (pixels.afterCutBlackFramesTotal ?? 0)
    if (black > 0) failures.push(`${black} black frame(s)`)
    if ((pixels.wrongLayoutFramesTotal ?? 0) > 0)
      failures.push(`${pixels.wrongLayoutFramesTotal} wrong-layout frame(s)`)
    if (pixels.cutsSeen < stats.switches)
      failures.push(`only ${pixels.cutsSeen}/${stats.switches} cuts seen in the recording`)
  }
  if (stats.failed > 0) failures.push(`${stats.failed} switch(es) refused or never settled`)
  return { ok: failures.length === 0, failures }
}

/** The follow budget: settle, then a switch, plus what the smoke cannot observe. */
export function followBudgetMs(budget = SMART_SCENES_BUDGET) {
  return budget.followSettleMs + budget.switchP95Ms + budget.followObservationSlackMs
}

/**
 * D10 rows: `{ label, expect: 'switch' | 'stay', switched, latencyMs }` where
 * `latencyMs` runs from the moment the OS showed the app in front to the new
 * window's first program frame.
 */
export function followGate(rows, budget = SMART_SCENES_BUDGET) {
  const failures = []
  const limit = followBudgetMs(budget)
  if (!rows?.length) return { ok: false, failures: ['no follow rows'], budgetMs: limit }
  for (const row of rows) {
    if (row.expect === 'switch') {
      if (!row.switched) failures.push(`${row.label}: the stream did not follow`)
      else if (row.latencyMs == null) failures.push(`${row.label}: followed, but no pixel latency`)
      else if (row.latencyMs > limit)
        failures.push(`${row.label}: followed after ${row.latencyMs} ms (> ${limit} ms)`)
    } else if (row.switched) {
      failures.push(`${row.label}: the stream switched although it should have stayed`)
    }
  }
  return { ok: failures.length === 0, failures, budgetMs: limit }
}

/**
 * D11: `{ onFront: {hidden, reason, latencyMs}, onLeave: {hidden},
 * manual: {afterFront: {hidden, reason}, afterLeave: {hidden}, afterShow: {hidden}} }`.
 */
export function passwordManagerGate(result, budget = SMART_SCENES_BUDGET) {
  const failures = []
  if (!result) return { ok: false, failures: ['no password-manager evidence'] }
  if (!result.onFront?.hidden)
    failures.push('the screen did not hide when the listed app came to the front')
  else {
    if (result.onFront.reason !== 'password-manager')
      failures.push(`hidden for "${result.onFront.reason}", not the password-manager list`)
    if (result.onFront.latencyMs == null || result.onFront.latencyMs > budget.passwordManagerHideMs)
      failures.push(
        `hid after ${result.onFront.latencyMs ?? 'n/a'} ms (> ${budget.passwordManagerHideMs} ms)`
      )
  }
  if (result.onLeave?.hidden !== false)
    failures.push('the screen did not come back when the app left the front')
  if (result.manual) {
    if (!result.manual.afterFront?.hidden || result.manual.afterFront.reason !== 'you')
      failures.push('a manual hide did not survive the listed app coming to the front')
    if (!result.manual.afterLeave?.hidden)
      failures.push('a manual hide was auto-shown when the app left the front')
    if (result.manual.afterShow?.hidden !== false)
      failures.push('Show screen did not show after the manual hide')
  } else failures.push('the manual-hide half was not run')
  return { ok: failures.length === 0, failures }
}

/** Step 3: `{ refusedWhileGone, appliedAfterRelaunch, windowIdBefore, windowIdAfter }`. */
export function relaunchGate(result) {
  const failures = []
  if (!result) return { ok: false, failures: ['no relaunch evidence'] }
  if (!result.refusedWhileGone)
    failures.push('applying the scene while its app was quit was not refused')
  if (!result.appliedAfterRelaunch)
    failures.push('the scene did not switch after its app relaunched')
  if (result.windowIdBefore && result.windowIdBefore === result.windowIdAfter)
    failures.push('the relaunched app kept the same window id, so the relaunch proved nothing')
  if (result.appliedAfterRelaunch && result.windowIdAfter !== result.expectedWindowId)
    failures.push(
      `the scene shows ${result.windowIdAfter}, not the relaunched window ${result.expectedWindowId}`
    )
  return { ok: failures.length === 0, failures }
}

/**
 * Step 7 (plan 219): a captured window minimized for a while on the canvas
 * is held, never restarted, and comes back on the same generation; a start
 * on an out-of-sight window is refused with copy the streamer can act on,
 * and goes live once the window is back.
 */
export function outOfSightGate(result) {
  const failures = []
  if (!result) return { ok: false, failures: ['no out-of-sight evidence'] }
  if (!result.noticed) failures.push('no out-of-sight notice while the window was minimized')
  if (result.recoveryPhases?.length)
    failures.push(
      `capture recovery ran (${result.recoveryPhases.join(', ')}) for a window that was only minimized`
    )
  if (result.sourceMissingSeen)
    failures.push('the window went source-missing while it was only minimized')
  if (result.screenStates?.some((state) => state !== 'live'))
    failures.push(
      `the screen preview left live (${result.screenStates.join(', ')}) during the hold`
    )
  if (!(result.framesWhileHidden >= result.framesBefore))
    failures.push('the frame counter reset during the hold, so the generation was replaced')
  if (!(result.framesAfter > result.framesWhileHidden))
    failures.push('frames did not resume after the window was restored')
  if (!result.back) failures.push('no window-back notice after the restore')
  if (result.refusal) {
    if (result.refusal.state !== 'source-missing')
      failures.push(
        `a start on the minimized window answered ${result.refusal.state}, not source-missing`
      )
    if (!result.refusal.copyOk)
      failures.push(`the refusal copy was ${JSON.stringify(result.refusal.message)}`)
    if (!result.refusal.liveAfterRestore)
      failures.push('the same start did not go live once the window was restored')
  } else {
    failures.push('no refusal evidence for a start on the minimized window')
  }
  return { ok: failures.length === 0, failures }
}

/** The plan 219 S2 refusal, without an id, an enum or an engine name. */
export function outOfSightRefusalCopyOk(message) {
  if (typeof message !== 'string') return false
  return (
    / is minimized, hidden or on another desktop\. Bring it back, then try again\.$/.test(
      message
    ) && !/screencapturekit|SourceMissing|ScreenCaptureKit/.test(message)
  )
}

/** Step 1: two scenes made for the fixtures, each with `app` and no `audio`. */
export function newScenesGate(scenes, fixtures) {
  const failures = []
  for (const fixture of fixtures) {
    const scene = (scenes ?? []).find(
      (entry) => entry.visual?.sources?.app?.bundleId === fixture.bundleId
    )
    if (!scene) {
      failures.push(`no scene made for ${fixture.name} (${fixture.bundleId})`)
      continue
    }
    if (scene.name !== fixture.name)
      failures.push(`scene for ${fixture.name} is named "${scene.name}"`)
    if (scene.audio !== undefined)
      failures.push(`scene "${scene.name}" pins audio; Add scene… keeps none`)
    if (scene.visual.sources.app.follows !== true)
      failures.push(`scene "${scene.name}" does not follow`)
    if (scene.visual.sources.screenId) failures.push(`scene "${scene.name}" still names a display`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * The whole run: every step's verdict in one list, in step order, so the
 * summary's last lines name what failed.
 */
export function smartScenesVerdict(steps) {
  const failures = []
  for (const [name, step] of Object.entries(steps ?? {})) {
    if (!step) {
      failures.push(`${name}: not run`)
      continue
    }
    if (step.skipped) continue
    for (const failure of step.failures ?? []) failures.push(`${name}: ${failure}`)
    if (step.outputs) {
      for (const [output, verdict] of Object.entries(step.outputs)) {
        if (!verdict) {
          failures.push(`${name}: ${output} missing`)
          continue
        }
        for (const failure of verdict.failures ?? []) failures.push(`${name}/${output}: ${failure}`)
      }
    }
  }
  return { ok: failures.length === 0, failures }
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.floor((sorted.length - 1) / 2)]
}
