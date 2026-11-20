import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  FROST_RGB,
  MOTION_MIN,
  SOURCES_STEPS,
  SOURCE_FIXTURE,
  STAGE_GROUND_RGB,
  analyzeSources,
  classifySource,
  ringMotion,
  ringPoints,
  ringShowsBackground,
  sourcesScenes
} from './cloud-parity-sources-contract.mjs'
import { layoutOf, savedScene } from './cloud-parity-scenes-contract.mjs'

test('classifies the fixture sources, frost and the plain ground', () => {
  for (const [id, rgb] of Object.entries(SOURCE_FIXTURE.sources))
    assert.equal(classifySource(rgb), id)
  assert.equal(classifySource(FROST_RGB), 'frost')
  assert.equal(classifySource(STAGE_GROUND_RGB), 'ground')
  assert.equal(classifySource([250, 250, 0]), null)
})

test("a receiver's hidden still reads as frost at its centre, at every landscape size", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../protocol-fixtures/hidden-screen-still.json', import.meta.url),
      'utf8'
    )
  )
  for (const { width, height, samples } of fixture.stills) {
    if (width < height || height < 100) continue
    const centre = samples.find(
      ([x, y]) => x === Math.floor(width / 2) && y === Math.floor(height / 2)
    )
    assert.ok(centre, `${width}x${height} has a centre sample`)
    assert.equal(classifySource(centre.slice(2)), 'frost', `${width}x${height}`)
  }
})

test('ring points stay inside the margin band', () => {
  const canvas = { width: 1920, height: 1080 }
  const points = ringPoints(canvas, 0.1)
  assert.ok(points.length >= 24)
  for (const [x, y] of points) {
    const inBand = x <= 192 || x >= 1920 - 192 || y <= 108 || y >= 1080 - 108
    assert.ok(inBand, `${x},${y}`)
  }
})

test('ring judgements: ground is no background; motion needs a difference', () => {
  const ground = Array.from({ length: 10 }, () => STAGE_GROUND_RGB)
  const lit = Array.from({ length: 10 }, (_, i) => [40 + i, 20, 90])
  assert.equal(ringShowsBackground(ground), false)
  assert.equal(ringShowsBackground(lit), true)
  assert.equal(ringMotion(lit, lit), 0)
  assert.ok(
    ringMotion(
      lit,
      lit.map(([r, g, b]) => [r + 6, g, b])
    ) >= MOTION_MIN
  )
})

test('the scenes name mappable native sources and the backgrounds', () => {
  const scenes = sourcesScenes(layoutOf, savedScene)
  assert.equal(scenes.windowA.visual.sources.windowId, 'window:screencapturekit:4101')
  assert.equal(scenes.display.visual.sources.screenId, 'screen:screencapturekit:4103')
  assert.equal(scenes.liveKeyOn.visual.background.live.id, 'silk')
  assert.equal(scenes.liveKeyOn.visual.layout.cameraChromaKeyEnabled, true)
  assert.equal(scenes.pictureKeyOff.visual.background.live, undefined)
})

test('analysis passes only with every step and honest background lanes', () => {
  const full = {
    steps: [...SOURCES_STEPS],
    backgrounds: [
      {
        step: 'background:live:key-off',
        lane: 'h',
        expect: 'shader',
        drawn: { rendering: 'shader' },
        ring: true,
        motion: 9
      },
      {
        step: 'background:picture:key-off',
        lane: 'h',
        expect: 'picture',
        drawn: { rendering: 'picture' },
        ring: true,
        motion: 0
      }
    ],
    frostLeaks: []
  }
  const passed = analyzeSources(full)
  assert.equal(passed.status, 'passed')
  assert.equal(passed.productionQualified, false)
  assert.ok(passed.unavailable.includes('protected-window-exclusion'))
  const still = analyzeSources({
    ...full,
    backgrounds: [{ ...full.backgrounds[0], drawn: { rendering: 'still', reason: 'no-webgl2' } }]
  })
  assert.equal(still.status, 'failed')
  assert.equal(analyzeSources({ ...full, steps: SOURCES_STEPS.slice(1) }).status, 'failed')
  assert.equal(analyzeSources({ ...full, frostLeaks: ['window:4102:0'] }).status, 'failed')
})
