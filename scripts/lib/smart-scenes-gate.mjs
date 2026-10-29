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
  /** D5: click to the new window's first program frame, p95, for a running app. */
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

/**
 * The probe's per-frame features plus `sharp` (the hard-edge share) for one
 * rgb24 buffer of many frames.
 */
export function frostFeaturesFromRawFrames(buffer, { width, height, repeatThreshold } = {}) {
  const features = featuresFromRawFrames(buffer, { width, height, repeatThreshold })
  const frameBytes = width * height * 3
  for (const feature of features) {
    const frame = buffer.subarray(feature.index * frameBytes, (feature.index + 1) * frameBytes)
    feature.sharp = Number(sharpFraction(frame, width, height).toFixed(5))
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
      if (wall < showAtMs + budget.hideEdgeMs) continue
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
 * D5 against the probe's variant stats (`pixels.latencyMs`, black and
 * wrong-layout totals, cuts seen).
 */
export function switchGate(stats, budget = SMART_SCENES_BUDGET) {
  const failures = []
  if (!stats) return { ok: false, failures: ['no switch statistics'] }
  const pixels = stats.pixels
  if (!pixels) failures.push('no pixel evidence (the recording could not be aligned)')
  else {
    if (pixels.latencyMs?.p95 == null) failures.push('no switch latency measured')
    else if (pixels.latencyMs.p95 > budget.switchP95Ms)
      failures.push(`p95 ${pixels.latencyMs.p95} ms > ${budget.switchP95Ms} ms`)
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
      failures.push(`scene "${scene.name}" pins audio; New scene… keeps none`)
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
