import assert from 'node:assert/strict'
import test from 'node:test'

import {
  belowSheen,
  centredRect,
  evaluateFloatBleed,
  evaluateFloatPatch,
  FLOAT_GLASS_THRESHOLDS,
  growRect
} from './float-glass-checks.mjs'
import { parseHexColor } from './image-stats.mjs'

const DARK_TEXT = { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') }
const grey = (value) => ({ r: value, g: value, b: value })
const allBackdrops = (colour) =>
  Object.fromEntries(['red', 'blue', 'white', 'black', 'text'].map((variant) => [variant, colour]))
// Plan 091 D6 dark tiers: dialog #1C1C1D, popup #232324, tooltip #0D0D0F.
const POPUP = { r: 0x23, g: 0x23, b: 0x24 }

test('a flat float that reads its own token over every backdrop passes', () => {
  const result = evaluateFloatPatch({
    surfaceMeans: allBackdrops({ r: 0x23, g: 0x23, b: 0x25 }),
    text: DARK_TEXT,
    expected: POPUP
  })
  assert.equal(result.pass, true, JSON.stringify(result))
  assert.ok(result.metrics.tone <= 1.01)
  assert.equal(result.metrics.toneBy.white, 1)
  assert.ok(result.metrics.surfaceLightness > 0.2 && result.metrics.surfaceLightness < 0.3)
})

test('a float one tier off its token fails on tone, whatever the glass behind', () => {
  // The dialog tier painted where the popup tier was asked for: #1C1C1D vs #232324.
  const result = evaluateFloatPatch({
    surfaceMeans: allBackdrops({ r: 0x1c, g: 0x1c, b: 0x1d }),
    text: DARK_TEXT,
    expected: POPUP
  })
  assert.equal(result.checks.tone, false)
  assert.ok(result.metrics.tone > FLOAT_GLASS_THRESHOLDS.maxToneDistance)
  assert.equal(result.checks.opaque, true)
})

test('an obscured or translucent surface capture fails closed', () => {
  // The five-window run where a backdrop stacked over the Stream Manager:
  // the surface read L 0.406 over red but 0.274 over white.
  const result = evaluateFloatPatch({
    surfaceMeans: { ...allBackdrops(POPUP), red: grey(0x4f) },
    text: DARK_TEXT,
    expected: POPUP
  })
  assert.equal(result.checks.opaque, false)
  assert.equal(result.pass, false)
  assert.ok(result.metrics.surfaceSpread > FLOAT_GLASS_THRESHOLDS.maxSurfaceSpread)
})

test('a surface too light for its text fails on contrast, not tone', () => {
  const result = evaluateFloatPatch({
    surfaceMeans: allBackdrops(grey(0x68)),
    text: DARK_TEXT,
    expected: grey(0x68)
  })
  assert.equal(result.checks.tone, true)
  assert.equal(result.checks.secondaryContrast, false)
})

test('patch scoring needs a measured backdrop, a contrast backdrop and the computed colour', () => {
  assert.throws(
    () => evaluateFloatPatch({ surfaceMeans: {}, text: DARK_TEXT, expected: POPUP }),
    /No backdrop variant/
  )
  assert.throws(
    () => evaluateFloatPatch({ surfaceMeans: { red: POPUP }, text: DARK_TEXT, expected: POPUP }),
    /white or black/
  )
  assert.throws(
    () => evaluateFloatPatch({ surfaceMeans: allBackdrops(POPUP), text: DARK_TEXT }),
    /computed colour/
  )
})

test('the bleed check needs text under the surface and none through it', () => {
  assert.equal(evaluateFloatBleed({ sharpnessUnder: 777, sharpnessThrough: 0.1 }).pass, true)
  // A 97% coat over the dark sidebar measured 1.34: the tab labels still read.
  const leak = evaluateFloatBleed({ sharpnessUnder: 777, sharpnessThrough: 1.34 })
  assert.equal(leak.checks.noBleed, false)
  const empty = evaluateFloatBleed({ sharpnessUnder: 2, sharpnessThrough: 0.1 })
  assert.equal(empty.checks.textPresent, false)
})

test('rect helpers grow within the window and centre inside a rect', () => {
  assert.deepEqual(
    growRect({ x: 10, y: 8, width: 100, height: 18 }, 30, { width: 120, height: 900 }),
    {
      x: 0,
      y: 0,
      width: 120,
      height: 56
    }
  )
  assert.deepEqual(centredRect({ x: 0, y: 0, width: 400, height: 100 }, 160, 18), {
    x: 120,
    y: 41,
    width: 160,
    height: 18
  })
})

test('the bleed sample starts below the top band of the surface', () => {
  const surface = { x: 0, y: 0, width: 200, height: 100 }
  assert.deepEqual(belowSheen({ x: 30, y: 30, width: 140, height: 40 }, surface), {
    x: 30,
    y: 37,
    width: 140,
    height: 33
  })
  assert.throws(() => belowSheen({ x: 30, y: 10, width: 140, height: 20 }, surface), /sheen/)
})
