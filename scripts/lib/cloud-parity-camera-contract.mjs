/** Plan 249 S13b `camera` case: processed camera contribution rules.
 * Pure: importing or calling these launches nothing. Thresholds are acceptance
 * BUDGETS, never measurements. Missing observations are unavailable, never zero.
 *
 * The fixture camera (`protocol-fixtures/room-camera.json`) substitutes the
 * device only; the frames are the native compositor's real processing with the
 * app's real layout (key on, a non-neutral look, native mirror ON), carried by
 * the S13a transport to the real program page. Markers read the DECODED packed
 * track at logical coordinates: colour on the left, alpha on the right.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const CAMERA = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/room-camera.json', import.meta.url), 'utf8')
)
export const GUTTER = 8

/** The look the case sets: visibly non-neutral, within the app's clamps. */
export const CASE_LOOK = Object.freeze({ brightness: 0.08, contrast: 1.15, saturation: 1.2 })
export const CASE_LAYOUT_PATCH = Object.freeze({
  cameraChromaKeyEnabled: true,
  cameraChromaKeyColor: '#00ff00',
  cameraLook: CASE_LOOK,
  // Native mirror ON: the published frame must still be unmirrored (S12 owns it).
  cameraMirror: true
})

export const CAMERA_BUDGETS = Object.freeze({
  keyedAlphaMax: 16,
  keptAlphaMin: 240,
  colourTolerance: 24,
  lookTolerance: 14,
  lookMinShift: 6,
  edgeRampMaxFraction: 0.06,
  spillGreenExcessMax: 10,
  pauseWithinMs: 5000,
  minimumStampedFrames: 30
})

export function cameraCaseConfig(env = {}) {
  const mode = env.VIDEORC_CAMERA_MODE ?? 'acquire-analyze'
  assert.ok(['acquire', 'analyze', 'acquire-analyze'].includes(mode), 'Invalid camera mode')
  const sources = (env.VIDEORC_CAMERA_SOURCES ?? '1280x720,640x480').split(',').map((value) => {
    const match = /^(\d{2,4})x(\d{2,4})$/.exec(value.trim())
    assert.ok(match, `Invalid fixture source size ${value}`)
    const [w, h] = [Number(match[1]), Number(match[2])]
    assert.ok(w % 2 === 0 && h % 2 === 0 && w <= 4096 && h <= 4096, `Invalid size ${value}`)
    return { width: w, height: h }
  })
  const seconds = Number(env.VIDEORC_CAMERA_SECONDS ?? 20)
  assert.ok(
    Number.isInteger(seconds) && seconds >= 5 && seconds <= 600,
    'VIDEORC_CAMERA_SECONDS 5..600'
  )
  return { mode, sources, durationMs: seconds * 1000, pollMs: 500, readinessMs: 30000 }
}

/** Mirror of the native `logical_size_for` (and `logicalSizeFor` in room-camera.ts). */
export function logicalSizeFor(width, height) {
  const scale = Math.min(640 / width, 640 / height, Math.sqrt((640 * 360) / (width * height)), 1)
  const even = (value) => Math.floor((value + 1e-6) / 2) * 2
  return { width: even(width * scale), height: even(height * scale) }
}

/** Mirror of the compositor's `camera_look_rgb_f64` (gamma-encoded RGB). */
export function lookRgb([r, g, b], look) {
  const v = [r, g, b].map((x) => x / 255)
  const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  return v.map((x) =>
    Math.round(
      Math.min(
        1,
        Math.max(
          0,
          y + look.brightness + (look.contrast - 1) * (y - 0.5) + look.saturation * (x - y)
        )
      ) * 255
    )
  )
}

/** Logical sample points (fractions of the frame) for every marker. */
export function markerPoints() {
  const z = CAMERA.zones
  const mid = (a, b) => (a + b) / 2
  const subjectY = mid(z.subject.y0, z.mirror.y0)
  return {
    ground: { fx: 0.9, fy: 0.5 },
    subject: { fx: 0.5, fy: subjectY },
    fringe: { fx: z.subject.x0 + z.fringe.width / 2, fy: subjectY },
    look: { fx: mid(z.look.x0, z.look.x1), fy: mid(z.look.y0, z.look.y1) },
    mirror: { fx: mid(z.mirror.x0, z.mirror.x1), fy: mid(z.mirror.y0, z.mirror.y1) },
    mirrored: { fx: 1 - mid(z.mirror.x0, z.mirror.x1), fy: mid(z.mirror.y0, z.mirror.y1) },
    // A horizontal profile across the subject's left edge for the keyed edge.
    edge: Array.from({ length: 25 }, (_, i) => ({
      fx: z.subject.x0 - 0.06 + i * 0.005,
      fy: subjectY
    }))
  }
}

const near = (a, b, tolerance) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance)

/**
 * Assess one decoded sample: `{ width, height, packedWidth, points: { name:
 * { rgb, alpha } }, edge: [{ fx, alpha }] }` for one source size.
 */
export function assessSample(sample, source, budgets = CAMERA_BUDGETS) {
  const failures = []
  const expected = logicalSizeFor(source.width, source.height)
  if (sample.width !== expected.width || sample.height !== expected.height)
    failures.push(
      `resolution ${sample.width}x${sample.height}, expected ${expected.width}x${expected.height}`
    )
  if (sample.packedWidth !== expected.width * 2 + GUTTER)
    failures.push(`packed width ${sample.packedWidth}`)
  const p = sample.points
  if (!(p.ground?.alpha <= budgets.keyedAlphaMax))
    failures.push(`key ground alpha ${p.ground?.alpha}`)
  if (!(p.subject?.alpha >= budgets.keptAlphaMin))
    failures.push(`subject alpha ${p.subject?.alpha}`)
  const subject = lookRgb(CAMERA.zones.subject.rgb, CASE_LOOK)
  if (!p.subject?.rgb || !near(p.subject.rgb, subject, budgets.colourTolerance))
    failures.push(`subject colour ${p.subject?.rgb} vs ${subject} (look applied once)`)
  const grey = lookRgb(CAMERA.zones.look.rgb, CASE_LOOK)
  if (!p.look?.rgb || !near(p.look.rgb, grey, budgets.lookTolerance))
    failures.push(`look patch ${p.look?.rgb} vs ${grey}`)
  if (p.look?.rgb && near(p.look.rgb, CAMERA.zones.look.rgb, budgets.lookMinShift))
    failures.push('look patch unchanged: the look was not applied')
  // Spill: the fringe is kept and its green excess is removed (source: +50).
  const fringe = p.fringe
  if (!(fringe?.alpha >= 200)) failures.push(`fringe alpha ${fringe?.alpha}`)
  else if (fringe.rgb[1] - Math.max(fringe.rgb[0], fringe.rgb[2]) > budgets.spillGreenExcessMax)
    failures.push(`fringe still green ${fringe.rgb} (despill)`)
  // Mirror never baked: the red marker is where the SOURCE has it.
  const red = (rgb) => !!rgb && rgb[0] >= 160 && rgb[1] <= 90 && rgb[2] <= 90
  if (!red(p.mirror?.rgb)) failures.push(`mirror marker missing at source side ${p.mirror?.rgb}`)
  if (red(p.mirrored?.rgb))
    failures.push('marker on the mirrored side: mirror was baked into the frame')
  // Keyed edge: a monotone-enough ramp from keyed to kept within the budget width.
  const edge = sample.edge ?? []
  const first = edge.findIndex((e) => e.alpha > budgets.keyedAlphaMax)
  const full = edge.findIndex((e) => e.alpha >= budgets.keptAlphaMin)
  if (first < 0 || full < 0) failures.push('keyed edge not observed')
  else {
    const ramp = edge[full].fx - edge[Math.max(0, first - 1)].fx
    if (ramp > budgets.edgeRampMaxFraction) failures.push(`keyed edge ramp ${ramp.toFixed(3)} wide`)
    if (edge.slice(full).some((e) => e.alpha < budgets.keptAlphaMin - 40))
      failures.push('alpha falls back inside the subject')
  }
  return failures
}

/** Lifecycle evidence: switch/unplug/off must pause, never publish a raw camera. */
export function assessLifecycle(events, budgets = CAMERA_BUDGETS) {
  const failures = []
  for (const name of ['off', 'switch', 'unplug']) {
    const e = events?.[name]
    if (!e) {
      failures.push(`${name}: not observed`)
      continue
    }
    if (!(e.pausedWithinMs <= budgets.pauseWithinMs))
      failures.push(`${name}: no pause within budget`)
    if (e.rawCameraPublished) failures.push(`${name}: a raw/browser camera was published`)
    if (name !== 'off' && !e.reopenedGeneration)
      failures.push(`${name}: no new generation on reopen`)
  }
  return failures
}

export function assessCameraCase(evidence, budgets = CAMERA_BUDGETS) {
  const gates = {}
  for (const run of evidence.runs ?? []) {
    const key = `${run.source.width}x${run.source.height}`
    const samples = run.samples ?? []
    const failures = samples.flatMap((s) => assessSample(s, run.source, budgets))
    gates[`markers.${key}`] = samples.length
      ? {
          status: failures.length ? 'failed' : 'passed',
          samples: samples.length,
          failures: failures.slice(0, 20)
        }
      : { status: 'unavailable', reason: run.reason ?? 'No decoded processed-camera sample' }
    gates[`stamps.${key}`] =
      (run.stamped ?? 0) >= budgets.minimumStampedFrames
        ? { status: 'passed', stamped: run.stamped }
        : { status: run.stamped ? 'failed' : 'unavailable', stamped: run.stamped ?? 0 }
    gates[`ownership.${key}`] = run.ownership
      ? {
          status:
            run.ownership.keptForRoom &&
            !run.ownership.lentToBrowserRoom &&
            !run.ownership.browserCamera
              ? 'passed'
              : 'failed',
          ...run.ownership
        }
      : { status: 'unavailable' }
  }
  const lifecycle = evidence.lifecycle
  gates.lifecycle = lifecycle
    ? (() => {
        const failures = assessLifecycle(lifecycle, budgets)
        return { status: failures.length ? 'failed' : 'passed', failures }
      })()
    : { status: 'unavailable' }
  for (const item of evidence.unavailable ?? [])
    gates[item.measurement] = { status: 'unavailable', ...item }
  const statuses = Object.values(gates).map((g) => g.status)
  return {
    status: statuses.length && statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
    productionQualified: false,
    budgets,
    gates
  }
}
