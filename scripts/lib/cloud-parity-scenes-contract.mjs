/** Plan 249 S12 `scenes` acceptance: the case matrix and pure checks.
 * Imported by the real-page runner and by lightweight tests; starts nothing. */
import assert from 'node:assert/strict'

export const SCENE_PRESETS = {
  h: ['screen-camera', 'screen-only', 'camera-only', 'side-by-side'],
  v: [
    'vertical-camera-top',
    'vertical-camera-bottom',
    'vertical-split',
    'vertical-screen-camera',
    'vertical-screen-only',
    'vertical-camera-only'
  ]
}
/** The two real guest pages the harness runs; 3–6 guests are unit vectors. */
export const SCENE_GUEST_COUNTS = [0, 1, 2]
export const SCENE_CANVAS = { h: { width: 1920, height: 1080 }, v: { width: 1080, height: 1920 } }
/** Screen fixture: a dark field with four pure corner markers (picture edges). */
export const SCREEN_FIXTURE = {
  width: 1280,
  height: 720,
  marker: 120,
  ground: [30, 30, 30],
  corners: { tl: [255, 0, 0], tr: [0, 255, 0], br: [0, 0, 255], bl: [255, 255, 255] }
}
/** Real controls exercised while a scene is on the program; each must be reported. */
export const SCENE_CONTROL_CASES = [
  'control:freeform-drag',
  'control:rapid-drags',
  'control:hide-camera',
  'control:show-camera',
  'control:guest-roles-over',
  'control:edits-then-clear'
]
/** Native glide: 320 ms ease-in-out-cubic; local budget for apply p95 is 500 ms. */
export const SCENE_TIMING = { motionMs: 320, applyBudgetMs: 500, settleToleranceMs: 120 }

/** Every shipped preset at every real guest count, both freeform scenes,
 * a saved scene with explicit guest roles, hidden camera and transitions. */
export function sceneCaseMatrix() {
  const cases = []
  for (const orientation of ['h', 'v'])
    for (const preset of SCENE_PRESETS[orientation])
      for (const guests of SCENE_GUEST_COUNTS)
        cases.push({
          id: `preset:${preset}:${guests}`,
          kind: 'preset',
          preset,
          orientation,
          guests,
          transition: 'cut'
        })
  for (const orientation of ['h', 'v'])
    for (const guests of [0, 2])
      cases.push({
        id: `freeform:${orientation}:${guests}`,
        kind: 'saved',
        scene: freeformScene(orientation),
        orientation,
        guests,
        transition: 'cut'
      })
  cases.push({
    id: 'saved:guest-roles:2',
    kind: 'saved',
    scene: guestRolesScene(),
    orientation: 'h',
    guests: 2,
    transition: 'cut'
  })
  cases.push({
    id: 'saved:camera-hidden:1',
    kind: 'saved',
    scene: hiddenCameraScene(),
    orientation: 'h',
    guests: 1,
    transition: 'cut'
  })
  for (const transition of ['motion', 'cut'])
    cases.push({
      id: `transition:${transition}`,
      kind: 'transition',
      from: 'screen-camera',
      preset: 'side-by-side',
      orientation: 'h',
      guests: 1,
      transition
    })
  return cases
}

function savedScene(id, layout, extra = {}) {
  const now = '2026-11-16T00:00:00.000Z'
  return {
    id,
    name: `Parity ${id}`,
    createdAt: now,
    updatedAt: now,
    visual: {
      layout,
      sources: { cameraId: 'parity-camera', screenId: 'parity-screen' },
      background: null
    },
    ...extra
  }
}
/** The layout fields a saved scene stores; the app normalizes the rest. */
function layoutOf(patch) {
  return {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 18,
    cameraAspect: 'source',
    cameraChromaKeyEnabled: false,
    cameraChromaKeyColor: '#00ff00',
    cameraChromaKeySimilarityPct: 30,
    cameraChromaKeySmoothnessPct: 10,
    cameraChromaKeySpillPct: 50,
    cameraMargin: 24,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '60-40',
    sideBySideCameraSide: 'right',
    verticalScreenFraming: 'fill',
    horizontalScreenFraming: 'fit',
    arrangementMode: 'preset',
    sourceTransformOverrides: {},
    ...patch
  }
}
/** Freeform: a cropped screen box and a mirrored, zoomed circle camera partly off the canvas. */
export function freeformScene(orientation) {
  return savedScene(
    `parity-freeform-${orientation}`,
    layoutOf({
      layoutPreset: orientation === 'h' ? 'screen-camera' : 'vertical-screen-camera',
      arrangementMode: 'freeform',
      cameraShape: 'circle',
      cameraMirror: true,
      cameraZoom: 150,
      cameraOffsetX: 40,
      sourceTransformOverrides: {
        'source:base': {
          x: 0.05,
          y: 0.08,
          width: 0.6,
          height: 0.6,
          cropLeft: 0.1,
          cropRight: 0.05
        },
        'source:camera': { x: 0.82, y: 0.7, width: 0.3, height: 0.3 }
      }
    })
  )
}
/** Explicit guest roles: guest 0 in a slot over the scene, others in the region. */
export function guestRolesScene() {
  return savedScene('parity-guest-roles', layoutOf({ cameraShape: 'rounded' }), {
    cloud: {
      version: 1,
      guests: {
        host: { x: 0, y: 0, w: 0.7, h: 0.7 },
        region: { x: 0.7, y: 0, w: 0.3, h: 1 },
        slots: [{ x: 0.05, y: 0.75, w: 0.2, h: 0.2 }]
      }
    }
  })
}
export function hiddenCameraScene() {
  return savedScene(
    'parity-camera-hidden',
    layoutOf({ sourceVisibility: { camera: false, capture: true } })
  )
}

/** The roster the program draws: host on stage plus the first `guests` real guests. */
export function sceneRoster({ host, guestIds, guests, screen }) {
  assert.ok(guests <= guestIds.length, 'Not enough real guest pages for this case')
  return { host, guests: guestIds.slice(0, guests), screen, hostOnStage: true }
}

/** Observed DOM tiles against the shared plan: same roles, identities and boxes. */
export function compareSceneTiles(expected, observed, tolerancePx = 1) {
  const problems = []
  const byRole = new Map(observed.map((tile) => [tile.role, tile]))
  for (const tile of expected) {
    const seen = byRole.get(tile.role)
    if (!seen) {
      problems.push(`${tile.role}: missing`)
      continue
    }
    if (seen.identity !== tile.identity) problems.push(`${tile.role}: identity ${seen.identity}`)
    for (const key of ['x', 'y', 'w', 'h'])
      if (Math.abs(seen.rect[key] - tile.rect[key]) > tolerancePx)
        problems.push(`${tile.role}: ${key} ${seen.rect[key]} != ${tile.rect[key]}`)
    byRole.delete(tile.role)
  }
  for (const role of byRole.keys()) problems.push(`${role}: unexpected`)
  return problems
}

/** Guests on stage must all be drawn: a scene never removes one (D7). */
export function guestsKept(onStageGuests, observed) {
  const drawn = new Set(
    observed.filter((tile) => tile.role.startsWith('guest:')).map((tile) => tile.identity)
  )
  return onStageGuests.filter((identity) => !drawn.has(identity))
}

/** Canvas points just inside each visible picture corner of a screen tile. */
export function screenCornerPoints(clipOnCanvas, inset = 12) {
  const { x, y, w, h } = clipOnCanvas
  return {
    tl: [x + inset, y + inset],
    tr: [x + w - 1 - inset, y + inset],
    br: [x + w - 1 - inset, y + h - 1 - inset],
    bl: [x + inset, y + h - 1 - inset]
  }
}
/** Which fixture corner a sampled colour is, or null (within tolerance). */
export function cornerOf(rgb, tolerance = 40) {
  for (const [name, color] of Object.entries(SCREEN_FIXTURE.corners))
    if (color.every((value, i) => Math.abs(value - rgb[i]) <= tolerance)) return name
  return null
}
/** A mirror swaps left and right; a crop removes the cropped corners' markers. */
export function expectedCorner(corner, mirror) {
  if (!mirror) return corner
  return { tl: 'tr', tr: 'tl', br: 'bl', bl: 'br' }[corner]
}

/**
 * A glide sampled on the page clock: starts at `from`, ends at `to` within
 * the settle tolerance of 320 ms, passes strictly between them, and never
 * overshoots (ease-in-out-cubic has no overshoot).
 */
export function judgeGlide(samples, from, to, timing = SCENE_TIMING) {
  assert.ok(samples.length >= 4, 'Too few glide samples')
  const start = samples[0].t
  const settled = samples.find((s) =>
    ['x', 'y', 'w', 'h'].every((k) => Math.abs(s.rect[k] - to[k]) <= 1)
  )
  const problems = []
  if (!settled) problems.push('never settled')
  else if (Math.abs(settled.t - start - timing.motionMs) > timing.settleToleranceMs)
    problems.push(`settled after ${Math.round(settled.t - start)} ms`)
  const between = samples.some((s) =>
    ['x', 'w'].some(
      (k) => Math.min(from[k], to[k]) + 2 < s.rect[k] && s.rect[k] < Math.max(from[k], to[k]) - 2
    )
  )
  if (!between) problems.push('no intermediate frame')
  for (const s of samples)
    for (const k of ['x', 'y', 'w', 'h'])
      if (s.rect[k] < Math.min(from[k], to[k]) - 2 || s.rect[k] > Math.max(from[k], to[k]) + 2)
        problems.push(`overshoot ${k} at ${Math.round(s.t - start)} ms`)
  return problems
}

/** p95 of apply latencies (click to rendered revision), ms. */
export function p95(values) {
  assert.ok(values.length > 0)
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}
