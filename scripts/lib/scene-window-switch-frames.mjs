// Pure helpers for the scene window-switch probe (plan 210 S0):
// per-frame colour classes of a decoded recording, per-switch verdicts
// (latency, frozen, black, wrong-layout frames), the clock anchor from the
// fixture's white flash, the backend log split, and percentiles.
//
// Frame input: raw rgb24 frames downscaled by ffmpeg (default 64x36). The
// centre region decides the window on program (the fixtures are solid red or
// blue with a darker letter), the bottom-right patch decides whether a camera
// inset sits over it, and a mean absolute difference against the previous
// frame decides whether the frame repeats.

export const DEFAULT_FRAME_WIDTH = 64
export const DEFAULT_FRAME_HEIGHT = 36

/** Fractions of the canvas sampled for each region. */
export const CENTRE_REGION = Object.freeze({ x0: 0.3, x1: 0.7, y0: 0.3, y1: 0.7 })
/** Where a bottom-right medium camera inset lands on a 16:9 canvas. */
export const INSET_REGION = Object.freeze({ x0: 0.82, x1: 0.95, y0: 0.72, y1: 0.9 })
/**
 * Top-left corner: a full-bleed window fills it; a freeform layout that
 * shrinks the window (the probe's layout variant) leaves the canvas there.
 */
export const BORDER_REGION = Object.freeze({ x0: 0.02, x1: 0.1, y0: 0.04, y1: 0.14 })
/**
 * Where the fixture's white block sweeps (bottom-left strip). A frame whose
 * strip equals the previous frame's is a repeat: the source stopped moving.
 */
export const MOTION_REGION = Object.freeze({ x0: 0, x1: 0.4, y0: 0.9, y1: 1 })

/** A fixture colour from one mean RGB triple. */
export function classifyRgb([r, g, b]) {
  if (r < 40 && g < 40 && b < 40) return 'black'
  if (r > 200 && g > 200 && b > 200) return 'white'
  if (r > 110 && g < 90 && b < 90 && r > b + 60) return 'red'
  if (b > 110 && r < 90 && g < 110 && b > r + 60) return 'blue'
  return 'other'
}

export function regionMean(frame, width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x0 * width))
  const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(region.x1 * width)))
  const y0 = Math.max(0, Math.floor(region.y0 * height))
  const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(region.y1 * height)))
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 3
      r += frame[offset]
      g += frame[offset + 1]
      b += frame[offset + 2]
      count += 1
    }
  }
  return count ? [r / count, g / count, b / count] : [0, 0, 0]
}

/** Mean absolute difference of two frames inside one region (whole frame by default). */
export function meanAbsoluteDifference(a, b, { width, height, region } = {}) {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY
  if (!region || !width || !height) {
    let sum = 0
    for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
    return sum / a.length
  }
  const x0 = Math.max(0, Math.floor(region.x0 * width))
  const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(region.x1 * width)))
  const y0 = Math.max(0, Math.floor(region.y0 * height))
  const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(region.y1 * height)))
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 3
      sum +=
        Math.abs(a[offset] - b[offset]) +
        Math.abs(a[offset + 1] - b[offset + 1]) +
        Math.abs(a[offset + 2] - b[offset + 2])
      count += 3
    }
  }
  return count ? sum / count : Number.POSITIVE_INFINITY
}

/**
 * Features of one decoded frame. `layoutMark` is true when the frame is not
 * the full-bleed window alone: a camera inset bottom-right, or a border
 * top-left (a shrunk window). The probe's layout variant switches between a
 * full-bleed scene and a marked one, so a frame of the new window under the
 * old layout is countable.
 * @returns {{centre:string, centreRgb:number[], inset:string, insetRgb:number[],
 *   border:string, layoutMark:boolean, diff:number, repeated:boolean}}
 */
export function frameFeatures(frame, previous, { width, height, repeatThreshold = 1 } = {}) {
  const centreRgb = regionMean(frame, width, height, CENTRE_REGION)
  const insetRgb = regionMean(frame, width, height, INSET_REGION)
  const borderRgb = regionMean(frame, width, height, BORDER_REGION)
  const centre = classifyRgb(centreRgb)
  const inset = classifyRgb(insetRgb)
  const border = classifyRgb(borderRgb)
  const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  // Only the fixture's motion strip decides a repeat: encoder noise elsewhere
  // and a camera inset's own motion must not count as the window moving.
  const diff = meanAbsoluteDifference(frame, previous, { width, height, region: MOTION_REGION })
  return {
    centre,
    centreRgb: centreRgb.map((value) => Math.round(value)),
    inset,
    insetRgb: insetRgb.map((value) => Math.round(value)),
    border,
    layoutMark:
      inset !== centre ||
      distance(centreRgb, insetRgb) > 90 ||
      border !== centre ||
      distance(centreRgb, borderRgb) > 90,
    diff: Number.isFinite(diff) ? Number(diff.toFixed(3)) : null,
    repeated: Number.isFinite(diff) && diff < repeatThreshold
  }
}

/**
 * Splits one rgb24 buffer holding many frames into per-frame features.
 * @param {Buffer|Uint8Array} buffer
 */
export function featuresFromRawFrames(
  buffer,
  { width = DEFAULT_FRAME_WIDTH, height = DEFAULT_FRAME_HEIGHT, repeatThreshold } = {}
) {
  const frameBytes = width * height * 3
  const count = Math.floor(buffer.length / frameBytes)
  const features = []
  let previous = null
  for (let index = 0; index < count; index += 1) {
    const frame = buffer.subarray(index * frameBytes, (index + 1) * frameBytes)
    features.push({ index, ...frameFeatures(frame, previous, { width, height, repeatThreshold }) })
    previous = frame
  }
  return features
}

/**
 * Wall-clock offset of the recording: `wallMs = ptsMs + offsetMs`, from the
 * first white frame at or after the flash. `flashWallMs` is when the fixture
 * drew its first white frame (or when the signal was sent).
 * @returns {{offsetMs:number, frameIndex:number}|null}
 */
export function anchorFromFlash(features, ptsMs, flashWallMs, { afterPtsMs = -Infinity } = {}) {
  for (const feature of features) {
    const pts = ptsMs[feature.index]
    if (pts == null || pts < afterPtsMs) continue
    if (feature.centre === 'white') {
      return { offsetMs: flashWallMs - pts, frameIndex: feature.index }
    }
  }
  return null
}

/**
 * Verdict for one switch request against the decoded program frames.
 *
 * @param {object} input
 * @param {Array} input.features frame features (index order)
 * @param {number[]} input.ptsMs presentation time per frame index, ms
 * @param {number} input.offsetMs wall = pts + offset
 * @param {number} input.requestedAtMs wall time of the switch request
 * @param {number} [input.untilMs] wall time of the next request (window end)
 * @param {string} input.fromColor colour of the outgoing window
 * @param {string} input.toColor colour of the incoming window
 * @param {boolean} [input.fromLayoutMark] whether the outgoing layout is marked
 * @param {boolean} [input.toLayoutMark] whether the incoming layout is marked
 */
export function sceneSwitchVerdict({
  features,
  ptsMs,
  offsetMs,
  requestedAtMs,
  untilMs = Number.POSITIVE_INFINITY,
  fromColor,
  toColor,
  fromLayoutMark = null,
  toLayoutMark = null
}) {
  const layoutChecked = typeof fromLayoutMark === 'boolean' && typeof toLayoutMark === 'boolean'
  const verdict = {
    requestedAtMs,
    firstNewFrameIndex: null,
    firstNewFrameWallMs: null,
    latencyMs: null,
    framesBeforeCut: 0,
    oldWindowFrames: 0,
    frozenFrames: 0,
    blackFrames: 0,
    otherFrames: 0,
    wrongLayoutFrames: 0,
    afterCutBlackFrames: 0,
    afterCutOldWindowFrames: 0,
    afterCutFrames: 0,
    cutSeen: false
  }
  for (const feature of features) {
    const pts = ptsMs[feature.index]
    if (pts == null) continue
    const wall = pts + offsetMs
    if (wall < requestedAtMs) continue
    if (wall >= untilMs) break
    if (!verdict.cutSeen) {
      if (feature.centre === toColor) {
        verdict.cutSeen = true
        verdict.firstNewFrameIndex = feature.index
        verdict.firstNewFrameWallMs = Math.round(wall)
        verdict.latencyMs = Math.round(wall - requestedAtMs)
        if (layoutChecked && feature.layoutMark !== toLayoutMark) verdict.wrongLayoutFrames += 1
        verdict.afterCutFrames += 1
        continue
      }
      verdict.framesBeforeCut += 1
      if (feature.centre === fromColor) {
        verdict.oldWindowFrames += 1
        if (feature.repeated) verdict.frozenFrames += 1
        // The old window drawn under the incoming layout is a wrong-layout
        // frame too (a layout commit that ran ahead of the new source).
        if (layoutChecked && feature.layoutMark !== fromLayoutMark) verdict.wrongLayoutFrames += 1
      } else if (feature.centre === 'black') {
        verdict.blackFrames += 1
      } else {
        verdict.otherFrames += 1
      }
      continue
    }
    verdict.afterCutFrames += 1
    if (feature.centre === 'black') verdict.afterCutBlackFrames += 1
    else if (feature.centre === fromColor) verdict.afterCutOldWindowFrames += 1
    if (layoutChecked && feature.centre === toColor && feature.layoutMark !== toLayoutMark) {
      verdict.wrongLayoutFrames += 1
    }
  }
  return verdict
}

/** p50, p95 and max of a list of numbers (nulls dropped). */
export function percentiles(values) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  if (sorted.length === 0) return { n: 0, p50: null, p95: null, max: null }
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]
  }
}

const ISO_TIMESTAMP = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/

/**
 * Parses one dev-app output line relayed from the backend's stderr into
 * `{atMs, text}` when it carries a tracing timestamp, else null.
 */
export function parseBackendLogLine(line) {
  const match = ISO_TIMESTAMP.exec(line)
  if (!match) return null
  const atMs = Date.parse(match[1])
  if (!Number.isFinite(atMs)) return null
  return { atMs, text: line }
}

/**
 * Splits one switch's gap from the backend log lines captured between the
 * request and the first new frame:
 *
 * - `preflightMs`: request → the backend begins the new capture generation
 *   (`[capture-generation] source=window generation=N reason=...`);
 * - `stopMs`: the old stream's stop join (`stop_join_ms=N`);
 * - `shareableMs`: stop joined → shareable content loaded and the request
 *   sized (`[videorc-capture-sizing]`);
 * - `startToFirstFrameMs`: sized → first captured frame of the new source;
 * - `commitMs`: first captured frame → first program frame.
 */
export function splitSwitchGap({
  requestedAtMs,
  logLines,
  firstCapturedFrameAtMs = null,
  firstProgramFrameAtMs = null
}) {
  const inWindow = logLines.filter(
    (entry) =>
      entry.atMs >= requestedAtMs - 5 &&
      (firstProgramFrameAtMs == null || entry.atMs <= firstProgramFrameAtMs + 5)
  )
  const begin = inWindow.find(
    (entry) =>
      entry.text.includes('[capture-generation]') &&
      entry.text.includes('source=window') &&
      !entry.text.includes('stop_join_ms=')
  )
  const stopJoin = inWindow.find((entry) => /stop_join_ms=(\d+)/.test(entry.text))
  const sizing = inWindow.find((entry) => entry.text.includes('[videorc-capture-sizing]'))
  const stopJoinMs = stopJoin ? Number(/stop_join_ms=(\d+)/.exec(stopJoin.text)[1]) : null
  const diff = (later, earlier) =>
    later != null && earlier != null ? Math.max(0, Math.round(later - earlier)) : null
  return {
    preflightMs: diff(begin?.atMs, requestedAtMs),
    stopMs: stopJoinMs,
    shareableMs: diff(sizing?.atMs, stopJoin?.atMs),
    startToFirstFrameMs: diff(firstCapturedFrameAtMs, sizing?.atMs),
    commitMs: diff(firstProgramFrameAtMs, firstCapturedFrameAtMs),
    totalMs: diff(firstProgramFrameAtMs, requestedAtMs),
    marks: {
      beginAtMs: begin?.atMs ?? null,
      stopJoinedAtMs: stopJoin?.atMs ?? null,
      sizedAtMs: sizing?.atMs ?? null,
      firstCapturedFrameAtMs,
      firstProgramFrameAtMs
    }
  }
}

/** Which split stage holds the largest share, for the human line. */
export function largestShare(splits) {
  const keys = ['preflightMs', 'stopMs', 'shareableMs', 'startToFirstFrameMs', 'commitMs']
  const sums = Object.fromEntries(keys.map((key) => [key, 0]))
  const counts = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const split of splits) {
    for (const key of keys) {
      if (typeof split?.[key] === 'number') {
        sums[key] += split[key]
        counts[key] += 1
      }
    }
  }
  const medians = Object.fromEntries(
    keys.map((key) => [key, percentiles(splits.map((split) => split?.[key] ?? null)).p50])
  )
  const total = keys.reduce((sum, key) => sum + (medians[key] ?? 0), 0)
  let largest = null
  for (const key of keys) {
    if (medians[key] != null && (largest == null || medians[key] > medians[largest])) largest = key
  }
  return {
    largest,
    medians,
    shares: Object.fromEntries(
      keys.map((key) => [key, total > 0 && medians[key] != null ? medians[key] / total : null])
    )
  }
}
