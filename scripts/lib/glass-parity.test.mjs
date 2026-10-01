import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blendOver,
  compositeCover,
  expectedGlassColor,
  oklchToSrgb,
  parityOf,
  parseCssColor
} from './glass-parity.mjs'

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)

test('oklch converts to sRGB like the design tokens expect', () => {
  // The light base oklch(0.985 0.001 286) is the porcelain #FAFAFB.
  const light = oklchToSrgb(0.985, 0.001, 286)
  near(light.r, 0xfa, 0.6, 'light r')
  near(light.g, 0xfa, 0.6, 'light g')
  near(light.b, 0xfb, 0.6, 'light b')
  // The dark base oklch(0.13 0.003 286) renders #070708 (the palette's
  // #0D0D0F is its rounding).
  const dark = oklchToSrgb(0.13, 0.003, 286)
  near(dark.r, 7.1, 0.3, 'dark r')
  near(dark.b, 8.3, 0.3, 'dark b')
  const white = oklchToSrgb(1, 0, 0)
  near(white.r, 255, 1e-9, 'white r')
  near(white.g, 255, 1e-9, 'white g')
  near(white.b, 255, 1e-9, 'white b')
  assert.deepEqual(oklchToSrgb(0, 0, 0), { r: 0, g: 0, b: 0 })
})

test("parses Chromium's computed colours: oklch with alpha, rgb(a), color(srgb), transparent", () => {
  const coat = parseCssColor('oklch(0.13 0.003 286 / 0.83)')
  near(coat.a, 0.83, 1e-9, 'alpha')
  near(coat.r, 7.1, 0.3, 'r')
  assert.deepEqual(parseCssColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 })
  assert.deepEqual(parseCssColor('rgb(13, 13, 15)'), { r: 13, g: 13, b: 15, a: 1 })
  assert.deepEqual(parseCssColor('rgb(13 13 15 / 50%)'), { r: 13, g: 13, b: 15, a: 0.5 })
  assert.deepEqual(parseCssColor('color(srgb 1 0 0 / 0.5)'), { r: 255, g: 0, b: 0, a: 0.5 })
  assert.deepEqual(parseCssColor('transparent'), { r: 0, g: 0, b: 0, a: 0 })
  assert.throws(() => parseCssColor('hsl(0 0% 0%)'), /Unsupported CSS colour/)
})

test('coats composite over the reference in sRGB, and the stack reports its cover', () => {
  const white = { r: 255, g: 255, b: 255 }
  const base = { r: 13, g: 13, b: 15 }
  const body = { ...base, a: 0.83 }
  const sidebar = { ...base, a: 1 - 0.12 / 0.17 }
  // The plan's gap table: dark work over white is #363638, dark sidebar #2A2A2C.
  const work = expectedGlassColor(white, [body, { ...base, a: 0 }])
  near(work.r, 0x36, 0.6, 'work r')
  near(work.b, 0x38, 0.6, 'work b')
  const aside = expectedGlassColor(white, [body, sidebar])
  near(aside.r, 0x2a, 0.6, 'sidebar r')
  near(aside.b, 0x2c, 0.6, 'sidebar b')
  near(compositeCover([body, sidebar]), 0.88, 1e-9, 'sidebar cover')
  near(compositeCover([body, { ...base, a: 0 }]), 0.83, 1e-9, 'work cover')
  assert.deepEqual(blendOver(white, { r: 0, g: 0, b: 0, a: 0 }), white)
})

test('parity is the worst distance over the backdrops, with lightness for the table', () => {
  const base = { r: 7.1, g: 7.1, b: 8.3 }
  const coats = [{ ...base, a: 0.83 }]
  const references = { white: { r: 255, g: 255, b: 255 }, black: { r: 0, g: 0, b: 0 } }
  const exact = {
    white: expectedGlassColor(references.white, coats),
    black: expectedGlassColor(references.black, coats)
  }
  const result = parityOf({ sampleMeans: exact, referenceMeans: references, coats })
  near(result.max, 0, 1e-9, 'exact prediction')
  near(result.cover, 0.83, 1e-9, 'cover')
  near(result.lightness.white.measured, result.lightness.white.expected, 1e-9, 'L')
  const off = parityOf({
    sampleMeans: {
      white: { r: exact.white.r + 6, g: exact.white.g, b: exact.white.b },
      black: exact.black
    },
    referenceMeans: references,
    coats
  })
  near(off.max, 6, 1e-9, 'six steps off over white')
  assert.equal(off.byBackdrop.black, 0)
  assert.throws(
    () => parityOf({ sampleMeans: {}, referenceMeans: references, coats }),
    /no white sample/
  )
})
