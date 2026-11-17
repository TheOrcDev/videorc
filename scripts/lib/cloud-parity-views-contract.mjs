/** Plan 249 S6 `views` acceptance: pure checks, unit tested without media.
 * The stage key and fit rules repeat the shared modules
 * (`apps/desktop/src/shared/cloud-presentation-views.ts`, web
 * `lib/cloud/program/presentation-views.ts`); the unit test holds all three
 * to `protocol-fixtures/cloud-parity-views.json`. */
import assert from 'node:assert/strict'
import { MEDIA } from './cloud-parity-media.mjs'

export function canonicalStage(stage) {
  const onStage = []
  for (const identity of stage.onStage) if (!onStage.includes(identity)) onStage.push(identity)
  const named = (identity) => (identity && onStage.includes(identity) ? identity : '')
  const shape = stage.hostShape === 'circle' ? 'circle' : 'rounded'
  return [
    'v1',
    stage.layout,
    shape,
    onStage.join(','),
    named(stage.spotlight),
    named(stage.screen)
  ].join('|')
}

export function stageKey(stage) {
  const text = canonicalStage(stage)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function fitBox(source, tile, fit) {
  if (source.w <= 0 || source.h <= 0 || tile.w <= 0 || tile.h <= 0) return null
  if (fit === 'contain') {
    const scale = Math.min(tile.w / source.w, tile.h / source.h)
    const w = source.w * scale
    const h = source.h * scale
    return { h, w, x: (tile.w - w) / 2, y: (tile.h - h) / 2 }
  }
  if (source.w * tile.h > tile.w * source.h) {
    const w = (source.h * tile.w) / tile.h
    return { h: source.h, w, x: (source.w - w) / 2, y: 0 }
  }
  const h = (source.w * tile.h) / tile.w
  return { h, w: source.w, x: 0, y: (source.h - h) / 2 }
}

/**
 * Where a contained source lands on the output, as fractions of the canvas:
 * the tile's own rect, letterboxed or pillarboxed by the shared fit rule.
 */
export function containRect(tile, source, canvas = { w: 1920, h: 1080 }) {
  const box = fitBox(source, { w: tile.w * canvas.w, h: tile.h * canvas.h }, 'contain')
  if (!box) return null
  return {
    x: tile.x + box.x / canvas.w,
    y: tile.y + box.y / canvas.h,
    w: box.w / canvas.w,
    h: box.h / canvas.h
  }
}

/** A drawn sprite sits inside its layer rect (the sprite need not fill it). */
export function assertInside(label, measured, rect, tolerance = 0.03) {
  assert.ok(measured, `${label}: pixels not found`)
  assert.ok(
    measured.x >= rect.x - tolerance &&
      measured.y >= rect.y - tolerance &&
      measured.x + measured.w <= rect.x + rect.w + tolerance &&
      measured.y + measured.h <= rect.y + rect.h + tolerance,
    `${label}: drawn outside its rect`
  )
}

/**
 * The guest's public layers match the program's: the same kinds at the same
 * normalized rects (inline percentages from the shared avatar view).
 */
export function assertSameLayers(label, guest, program) {
  const key = (layers) =>
    layers
      .map((l) => `${l.kind}@${l.left},${l.top},${l.width},${l.height}`)
      .sort()
      .join('|')
  assert.ok(guest.length > 0, `${label}: the guest draws no layer`)
  assert.equal(key(guest), key(program), `${label}: guest layers differ from the program`)
  for (const layer of guest) assert.ok(layer.natural > 0, `${label}: ${layer.kind} not decoded`)
}

/**
 * Fixture transport only: what the web's `buildRoomState` makes of a fresh
 * page beacon's `shown` (the real mapping is unit tested in the web repo).
 * The key travels with its time; an older page sends neither.
 */
export function roomShownFromBeacon(shown, at) {
  return {
    ...(shown.layout ? { layout: shown.layout } : {}),
    onStage: [...shown.onStage],
    ...(shown.screen ? { screen: shown.screen } : {}),
    ...(typeof shown.stage === 'string' ? { at, stageKey: shown.stage } : {})
  }
}

/** The bounding box (fractions of the frame) of pixels near `color`. */
export function colorBox(rgb24, width, height, color, tolerance = MEDIA.analysis.colorTolerance) {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    count = 0
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      if ([0, 1, 2].every((c) => Math.abs(rgb24[i + c] - color[c]) <= tolerance)) {
        count += 1
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  if (count === 0) return null
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX + 1 - minX) / width,
    h: (maxY + 1 - minY) / height,
    fill: count / ((maxX + 1 - minX) * (maxY + 1 - minY))
  }
}

/**
 * A marker drawn where the shared geometry says, within `tolerance` of the
 * frame on every edge, and filling its box (not a stretched sliver).
 */
export function assertTileGeometry(label, measured, expected, tolerance = 0.03) {
  assert.ok(measured, `${label}: marker not found`)
  for (const edge of ['x', 'y', 'w', 'h'])
    assert.ok(
      Math.abs(measured[edge] - expected[edge]) <= tolerance,
      `${label}: ${edge} ${measured[edge].toFixed(3)} vs ${expected[edge].toFixed(3)}`
    )
  assert.ok(measured.fill > 0.8, `${label}: marker fills ${measured.fill.toFixed(2)} of its box`)
}

/** The page applied the stage this desktop sent, and the preview says so. */
export function assertAppliedStage(label, { sent, shown, monitorState }) {
  assert.ok(shown?.stageKey, `${label}: the page reported no stage key`)
  assert.equal(shown.stageKey, stageKey(sent), `${label}: the page applied another stage`)
  assert.equal(
    shown.layout,
    sent.layout === 'screen-people' && !sent.screen ? 'side-by-side' : sent.layout,
    `${label}: drawn layout`
  )
  assert.equal(monitorState, 'applied', `${label}: the Program preview must say applied`)
}

/**
 * Mix-minus on every return: each guest hears the host and the other
 * guest, never itself; the program hears everyone once. A soundboard level,
 * when given, must arrive once (a doubled copy is about +6 dB).
 */
export function assertViewReturns(captures, { soundDb = null } = {}) {
  const names = captures.map((capture) => capture.name).sort()
  assert.deepEqual(names, ['guest1', 'guest2', 'program'], 'Program and both guests are required')
  for (const capture of captures) {
    const tones = capture.settledTones ?? capture.tones
    const heard = (voice) => tones[voice] > MEDIA.analysis.audibleDbfs
    if (capture.name === 'program')
      assert.ok(['host', 'guest1', 'guest2'].every(heard), 'program: every voice once')
    else {
      const other = capture.name === 'guest1' ? 'guest2' : 'guest1'
      assert.ok(heard('host') && heard(other), `${capture.name}: host and ${other} audible`)
      assert.ok(
        tones[capture.name] < MEDIA.analysis.absentDbfs,
        `${capture.name}: own tone returned (${tones[capture.name]} dBFS)`
      )
    }
    if (soundDb !== null)
      assert.ok(
        Math.abs(tones.soundboard - soundDb) < 2.8,
        `${capture.name}: one soundboard copy expected ${soundDb}, measured ${tones.soundboard}`
      )
  }
}
