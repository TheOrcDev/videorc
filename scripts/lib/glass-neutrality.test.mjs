import assert from 'node:assert/strict'
import test from 'node:test'

import {
  backdropReferenceRect,
  nativeClearCheck,
  NEUTRALITY_BACKDROPS,
  neutralityOf
} from './glass-neutrality.mjs'

const workArea = { x: 0, y: 37, width: 1512, height: 945 }
const clearView = {
  state: 'active',
  material: 21,
  blendingMode: 0,
  className: 'VideorcClearGlassView',
  clear: true,
  blurRadius: 60,
  chameleonVisible: false,
  saturatePresent: false,
  rootBackground: '(0.051,0.051,0.059,1.000)'
}

test('the reference patch sits right of the window when the work area has room', () => {
  const rect = backdropReferenceRect({ x: 40, y: 67, width: 1180, height: 780 }, workArea)
  assert.deepEqual(rect, { x: 1300, y: 187, width: 40, height: 40 })
})

test('the reference patch drops below a window that fills the width', () => {
  const rect = backdropReferenceRect({ x: 40, y: 67, width: 1432, height: 700 }, workArea)
  assert.deepEqual(rect, { x: 160, y: 847, width: 40, height: 40 })
})

test('no reference patch when the window leaves no bare backdrop', () => {
  assert.equal(backdropReferenceRect({ x: 0, y: 37, width: 1512, height: 945 }, workArea), null)
})

test('neutrality is the worst RGB distance across the four backdrops', () => {
  const references = {
    white: { r: 255, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
    red: { r: 234, g: 51, b: 35 },
    blue: { r: 0, g: 0, b: 245 }
  }
  const clear = neutralityOf(
    {
      white: { r: 252, g: 252, b: 253 },
      black: { r: 3, g: 3, b: 4 },
      red: { r: 230, g: 54, b: 38 },
      blue: { r: 2, g: 1, b: 241 }
    },
    references
  )
  assert.ok(clear.max < 8, JSON.stringify(clear))
  assert.deepEqual(Object.keys(clear.byBackdrop), [...NEUTRALITY_BACKDROPS])
  // AppKit's dark material over white measures about #4A4B49 (the 2026-09-23 calibration).
  const material = neutralityOf(
    {
      white: { r: 0x4a, g: 0x4b, b: 0x49 },
      black: { r: 20, g: 20, b: 20 },
      red: { r: 90, g: 40, b: 36 },
      blue: { r: 30, g: 30, b: 90 }
    },
    references
  )
  assert.ok(material.max > 300, JSON.stringify(material))
  assert.equal(material.max, material.byBackdrop.white)
})

test('neutrality fails loudly on a missing backdrop', () => {
  assert.throws(() => neutralityOf({ white: { r: 1, g: 1, b: 1 } }, {}), /no white sample/)
})

test('nativeClear passes only a stripped behind-window view at the Ghostex radius', () => {
  assert.deepEqual(nativeClearCheck([clearView]).failures, [])
  assert.equal(nativeClearCheck([clearView]).pass, true)
  assert.equal(nativeClearCheck([clearView]).blurRadius, 60)
  assert.deepEqual(nativeClearCheck([{ ...clearView, blurRadius: 30 }]).failures, ['radius'])
  assert.deepEqual(nativeClearCheck([{ ...clearView, clear: false }]).failures, ['class'])
  assert.deepEqual(nativeClearCheck([{ ...clearView, chameleonVisible: true }]).failures, [
    'chameleon'
  ])
  assert.deepEqual(nativeClearCheck([{ ...clearView, saturatePresent: true }]).failures, [
    'saturate'
  ])
  assert.deepEqual(nativeClearCheck([clearView], { blurRadius: 20 }).failures, ['radius'])
})

test('nativeClear ignores within-window views and fails without any', () => {
  const within = { ...clearView, blendingMode: 1, clear: false, blurRadius: null }
  assert.equal(nativeClearCheck([clearView, within]).pass, true)
  assert.deepEqual(nativeClearCheck([]).failures, ['no-effect-views'])
  assert.deepEqual(nativeClearCheck(null).failures, ['no-effect-views'])
})

test('an addon built before plan 091 reads as the plain material', () => {
  const old = { state: 'active', material: 21, blendingMode: 0 }
  const result = nativeClearCheck([old])
  assert.equal(result.pass, false)
  assert.deepEqual(result.failures, ['class', 'radius', 'saturate'])
})
