/** Plan 249 S14 `--case sources`: pure rules, fixtures and analysis. Light: the
 * runner (cloud-parity-sources.mjs) is heavy and never imported by tests.
 *
 * What the case proves on local LiveKit with real program pages (H stream,
 * H recording, V stream):
 * - Source follow: a saved scene naming window A, then window B, then a Follow
 *   switch naming display C each put THAT source on the room share (the fake
 *   capturer paints a colour per granted capturer id) before the scene
 *   commits; the program's screen box shows the colour; a source the capturer
 *   refuses leaves the old colour and commits nothing.
 * - Hidden span: Hide, then a source switch: the screen box shows neutral
 *   frost (S2), never the new source's colour, until Show.
 * - Background: a picture background (a bundled poster as a picture) and a
 *   live background (Silk) with the camera key off and on; every lane reports
 *   what it drew; the stage margin ring shows the background, not the plain
 *   stage ground; the live ring moves between two frames, a picture's does not.
 * Cursor and protected-window exclusions need a real capture and are named
 * unavailable, never passed.
 */

/** The fake capturer's colour for each capturer id the scenes name. */
export const SOURCE_FIXTURE = {
  width: 1280,
  height: 720,
  sources: {
    'window:4101:0': [220, 40, 40],
    'window:4102:0': [40, 200, 60],
    'screen:4103:0': [40, 80, 220]
  },
  /** The native ids that map to them (ScreenCaptureKit form). */
  native: {
    'window:4101:0': { windowId: 'window:screencapturekit:4101' },
    'window:4102:0': { windowId: 'window:screencapturekit:4102' },
    'screen:4103:0': { screenId: 'screen:screencapturekit:4103' }
  },
  /** A window the capturer refuses (it has gone). */
  refused: 'window:4199:0',
  refusedNative: { windowId: 'window:screencapturekit:4199' }
}
/** S2's opaque neutral frost. */
export const FROST_RGB = [128, 128, 128]
/** The page's plain stage ground (no background): runner luma 24. */
export const STAGE_GROUND_RGB = [9, 9, 9]
export const SOURCES_TIMING = {
  /** A switch reaches every lane within this (local harness). */
  switchMs: 5000,
  /** Between the two frames a live ring must differ across. */
  motionGapMs: 600
}
/** Mean absolute channel difference over the ring that counts as motion. */
export const MOTION_MIN = 2
/** Steps the case must report; any missing one fails the analysis. */
export const SOURCES_STEPS = [
  'follow:window-a',
  'follow:window-b',
  'follow:refused-keeps-share',
  'follow:front-app-display',
  'hidden:switch-stays-frosted',
  'hidden:show-reveals-new-source',
  'background:picture:key-off',
  'background:picture:key-on',
  'background:live:key-off',
  'background:live:key-on',
  'background:clear'
]
/** Never passed by this case. */
export const SOURCES_UNAVAILABLE = [
  'cursor-hidden-by-native-setting',
  'protected-window-exclusion',
  'real-window-capture',
  'app-scene-window-swap',
  'windows-hide-gate',
  'managed-egress'
]

const near = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

/** Which fixture source (or frost/ground) a sampled pixel is, or null. */
export function classifySource(rgb, tolerance = 40) {
  for (const [id, colour] of Object.entries(SOURCE_FIXTURE.sources))
    if (near(rgb, colour, tolerance)) return id
  if (near(rgb, FROST_RGB, 14)) return 'frost'
  if (near(rgb, STAGE_GROUND_RGB, 6)) return 'ground'
  return null
}

/**
 * Points in the stage margin ring (the background's visible band around the
 * content stage): `margin` is the per-side canvas fraction (visibility / 200).
 */
export function ringPoints(canvas, margin, count = 24) {
  const inset = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) * margin * 0.5))
  const points = []
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count
    const x = Math.round(t * (canvas.width - 1))
    const y = Math.round(t * (canvas.height - 1))
    if (i % 2 === 0) points.push([x, inset], [x, canvas.height - 1 - inset])
    else points.push([inset, y], [canvas.width - 1 - inset, y])
  }
  return points
}

/** The ring shows a background: most samples are not the plain stage ground. */
export function ringShowsBackground(samples) {
  const ground = samples.filter((rgb) => near(rgb, STAGE_GROUND_RGB, 6)).length
  return samples.length > 0 && ground / samples.length < 0.25
}

/** Mean absolute channel difference between two sample sets. */
export function ringMotion(a, b) {
  if (a.length !== b.length || a.length === 0) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) for (let c = 0; c < 3; c++) sum += Math.abs(a[i][c] - b[i][c])
  return sum / (a.length * 3)
}

/** The saved scenes the case applies (SavedScene shape; the app normalizes the rest). */
export function sourcesScenes(layoutOf, savedScene) {
  const layout = layoutOf({ layoutPreset: 'screen-camera' })
  const keyed = layoutOf({ layoutPreset: 'screen-camera', cameraChromaKeyEnabled: true })
  const withSources = (id, native, extra = {}) => {
    const scene = savedScene(id, extra.layout ?? layout)
    scene.visual.sources = { cameraId: 'parity-camera', ...native }
    if (extra.background) scene.visual.background = extra.background
    return scene
  }
  const background = (live) => ({
    assetId: live ? 'live-silk-satin' : 'live-plasma-wave-ember',
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: 20,
    ...(live ? { live: { id: 'silk', look: 'satin', motion: 'normal' } } : {})
  })
  const a = SOURCE_FIXTURE.native['window:4101:0']
  return {
    windowA: withSources('parity-src-a', a),
    windowB: withSources('parity-src-b', SOURCE_FIXTURE.native['window:4102:0']),
    display: withSources('parity-src-c', SOURCE_FIXTURE.native['screen:4103:0']),
    refused: withSources('parity-src-gone', SOURCE_FIXTURE.refusedNative),
    pictureKeyOff: withSources('parity-bg-pic', a, { background: background(false) }),
    pictureKeyOn: withSources('parity-bg-pic-key', a, {
      background: background(false),
      layout: keyed
    }),
    liveKeyOff: withSources('parity-bg-live', a, { background: background(true) }),
    liveKeyOn: withSources('parity-bg-live-key', a, { background: background(true), layout: keyed })
  }
}

/**
 * The case's verdict from its report. `passed` needs every step; a lane that
 * drew a background as a still is a failure here (the local harness has a
 * WebGL2 page); managed, device and platform rows stay unavailable.
 */
export function analyzeSources(report) {
  const failures = []
  const steps = new Set(report?.steps ?? [])
  for (const step of SOURCES_STEPS) if (!steps.has(step)) failures.push(`missing step ${step}`)
  for (const lane of report?.backgrounds ?? []) {
    if (lane.expect === 'shader' && !['shader', 'half'].includes(lane.drawn?.rendering))
      failures.push(`${lane.step} ${lane.lane}: drew ${lane.drawn?.rendering ?? 'nothing'}`)
    if (lane.expect === 'picture' && lane.drawn?.rendering !== 'picture')
      failures.push(`${lane.step} ${lane.lane}: drew ${lane.drawn?.rendering ?? 'nothing'}`)
    if (!lane.ring) failures.push(`${lane.step} ${lane.lane}: ring shows the plain ground`)
    if (lane.expect === 'shader' && !(lane.motion >= MOTION_MIN))
      failures.push(`${lane.step} ${lane.lane}: no motion (${lane.motion})`)
    if (lane.expect === 'picture' && lane.motion >= MOTION_MIN)
      failures.push(`${lane.step} ${lane.lane}: a picture moved (${lane.motion})`)
  }
  for (const leak of report?.frostLeaks ?? []) failures.push(`hidden span leaked ${leak}`)
  return {
    status: failures.length ? 'failed' : 'passed',
    failures,
    unavailable: [...SOURCES_UNAVAILABLE],
    keyedCamera: 'opaque-partial (packed alpha disabled; S13 owns transparency)',
    productionQualified: false
  }
}
