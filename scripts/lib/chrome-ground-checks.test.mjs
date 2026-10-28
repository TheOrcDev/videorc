import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  backgroundExtremes,
  evaluateGround,
  isClearGlassRun,
  pixelStability
} from './chrome-ground-checks.mjs'

const image = () => ({ width: 3, height: 3, data: new Uint8Array(36).fill(255) })
const rect = { x: 0, y: 0, width: 3, height: 3 }
const black = { r: 10, g: 10, b: 10 }
function fixture() {
  return {
    theme: 'dark',
    role: 'main',
    pageDark: true,
    glassState: { applied: { mode: { kind: 'ground' } }, effectViews: [] },
    ground: {
      ground: 'chrome',
      mounted: true,
      visible: true,
      firstRun: false,
      images: ['dark', 'light'].map((theme) => ({
        theme,
        visible: theme === 'dark',
        loaded: true,
        width: 1280,
        height: 720,
        src: `/chrome-ground-${theme}.webp`
      })),
      tiers: {
        foreground: 'oklch(0.97 0 0)',
        'muted-foreground': 'oklch(0.71 0 0)',
        subtle: 'oklch(0.6 0 0)'
      }
    },
    samples: [{ extremes: [black, black] }],
    stability: { pass: true, changedPixels: 0, maxDelta: 0 }
  }
}

test('opacity detects a single changed channel even when means would cancel', () => {
  const a = image()
  const b = image()
  assert.equal(pixelStability([a, b], rect).pass, true)
  b.data[0]--
  assert.deepEqual(pixelStability([a, b], rect), { pass: false, changedPixels: 1, maxDelta: 1 })
  assert.throws(() => pixelStability([a], rect), /two backdrop/)
})

test('background extremes keep a single bright crest instead of averaging it', () => {
  const a = image()
  a.data[0] = a.data[1] = a.data[2] = 0
  assert.deepEqual(backgroundExtremes(a, rect), [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 }
  ])
})

test('ground checks fail closed on mode, vibrancy, desktop leak, asset and all text tiers', () => {
  assert.equal(evaluateGround(fixture()).pass, true)
  for (const mutate of [
    (f) => {
      f.glassState.applied.mode.kind = 'material'
    },
    (f) => {
      f.glassState.effectViews = [{}]
    },
    (f) => {
      f.stability.pass = false
    },
    (f) => {
      f.ground.mounted = false
    },
    (f) => {
      f.ground.images[0].width = 0
    },
    (f) => {
      f.ground.images[0].visible = false
    },
    (f) => {
      f.ground.images[0].src = '/wrong.webp'
    },
    (f) => {
      f.pageDark = false
    },
    (f) => {
      f.ground.firstRun = true
    },
    ...['foreground', 'muted-foreground', 'subtle'].map((tier) => (f) => {
      f.ground.tiers[tier] = 'rgb(10, 10, 10)'
    })
  ]) {
    const f = fixture()
    mutate(f)
    assert.equal(evaluateGround(f).pass, false)
  }
  const f = fixture()
  f.samples[0].extremes.push({ r: 255, g: 255, b: 255 })
  assert.equal(evaluateGround(f).checks.foregroundContrast, false)
})

test('reduced transparency permits the hidden ground while retaining the other contracts', () => {
  const f = fixture()
  f.ground.visible = false
  f.ground.reducedTransparency = true
  assert.equal(evaluateGround(f).pass, true)
  f.ground.reducedTransparency = false
  assert.equal(evaluateGround(f).pass, false)
})

test('Preview must be solid dark in both themes and needs no renderer ground', () => {
  for (const theme of ['dark', 'light']) {
    const f = fixture()
    f.role = 'preview'
    f.theme = theme
    f.ground = null
    f.glassState.applied.mode = { kind: 'solid', reason: 'dark-always' }
    assert.equal(evaluateGround(f).pass, true)
    f.samples[0].extremes = [{ r: 255, g: 255, b: 255 }]
    assert.equal(evaluateGround(f).checks.pinnedDark, false)
  }
})

test('only the explicit clear A/B selects transmission gates, including app-env overrides', () => {
  for (const value of [undefined, '0', 'ground', 'under-window']) {
    assert.equal(isClearGlassRun({ VIDEORC_GLASS: value }), false)
  }
  assert.equal(isClearGlassRun({ VIDEORC_GLASS: 'clear' }), true)
  assert.equal(isClearGlassRun({ VIDEORC_GLASS: 'clear' }, { VIDEORC_GLASS: '0' }), false)
  assert.equal(isClearGlassRun({}, { VIDEORC_GLASS: 'clear' }), true)
})
