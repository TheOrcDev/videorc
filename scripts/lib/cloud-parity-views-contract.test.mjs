import test from 'node:test'
import assert from 'node:assert/strict'
import { readParityJson } from './cloud-parity-contract.mjs'
import {
  assertAppliedStage,
  assertInside,
  assertSameLayers,
  containRect,
  assertTileGeometry,
  assertViewReturns,
  canonicalStage,
  colorBox,
  fitBox,
  roomShownFromBeacon,
  stageKey
} from './cloud-parity-views-contract.mjs'

const vectors = readParityJson('views')

test('views contract holds the shared fit and stage-key vectors', () => {
  for (const one of vectors.fit) assert.deepEqual(fitBox(one.source, one.tile, one.fit), one.box)
  for (const one of vectors.stages) {
    assert.equal(canonicalStage(one.stage), one.canonical, one.name)
    assert.equal(stageKey(one.stage), one.key, one.name)
  }
})

test('fixture shown relay keeps the key with its time and nothing from an older page', () => {
  const at = '2026-11-16T12:00:00.000Z'
  assert.deepEqual(
    roomShownFromBeacon({ away: [], layout: 'solo', onStage: ['host:s'], stage: 'aaaaaaaa' }, at),
    { layout: 'solo', onStage: ['host:s'], at, stageKey: 'aaaaaaaa' }
  )
  assert.deepEqual(roomShownFromBeacon({ away: [], onStage: ['host:s'] }, at), {
    onStage: ['host:s']
  })
})

test('applied stage needs the matching key, drawn layout and the preview saying so', () => {
  const sent = { layout: 'side-by-side', onStage: ['host:s', 'g_a'] }
  const shown = { layout: 'side-by-side', onStage: sent.onStage, stageKey: stageKey(sent) }
  assert.doesNotThrow(() => assertAppliedStage('ok', { sent, shown, monitorState: 'applied' }))
  assert.throws(() =>
    assertAppliedStage('old', {
      sent,
      shown: { ...shown, stageKey: '00000000' },
      monitorState: 'applied'
    })
  )
  assert.throws(() => assertAppliedStage('label', { sent, shown, monitorState: 'unconfirmed' }))
  assert.throws(() =>
    assertAppliedStage('older page', { sent, shown: { onStage: [] }, monitorState: 'applied' })
  )
})

test('geometry finds a marker box and rejects a misplaced or stretched one', () => {
  const width = 16,
    height = 9
  const frame = new Uint8Array(width * height * 3)
  for (let y = 2; y < 6; y += 1)
    for (let x = 4; x < 12; x += 1) frame.set([200, 10, 10], (y * width + x) * 3)
  const box = colorBox(frame, width, height, [200, 10, 10], 5)
  assert.deepEqual(
    { x: box.x, y: box.y, w: box.w, h: box.h },
    { x: 4 / 16, y: 2 / 9, w: 8 / 16, h: 4 / 9 }
  )
  assert.doesNotThrow(() => assertTileGeometry('ok', box, { x: 0.25, y: 0.22, w: 0.5, h: 0.44 }))
  assert.throws(() => assertTileGeometry('moved', box, { x: 0.4, y: 0.22, w: 0.5, h: 0.44 }))
  assert.throws(() => assertTileGeometry('missing', null, { x: 0, y: 0, w: 1, h: 1 }))
  assert.equal(colorBox(frame, width, height, [0, 200, 0], 5), null)
})

test('returns are mix-minus with one soundboard copy', () => {
  const capture = (name, tones) => ({ name, tones })
  const ok = [
    capture('program', { host: -20, guest1: -20, guest2: -20, soundboard: -20 }),
    capture('guest1', { host: -20, guest1: -80, guest2: -20, soundboard: -20 }),
    capture('guest2', { host: -20, guest1: -20, guest2: -80, soundboard: -20 })
  ]
  assert.doesNotThrow(() => assertViewReturns(ok, { soundDb: -20 }))
  const echo = ok.map((c) =>
    c.name === 'guest1' ? capture('guest1', { ...c.tones, guest1: -20 }) : c
  )
  assert.throws(() => assertViewReturns(echo))
  const doubled = ok.map((c) => capture(c.name, { ...c.tones, soundboard: -14 }))
  assert.throws(() => assertViewReturns(doubled, { soundDb: -20 }))
  assert.throws(() => assertViewReturns(ok.slice(1)))
})

test('a contained 4:3 screen is pillarboxed inside its 16:9 tile, never stretched', () => {
  const tile = { x: 0, y: 0, w: 0.5, h: 0.5 }
  const box = containRect(tile, { w: 640, h: 480 })
  assert.ok(Math.abs(box.h - 0.5) < 1e-9)
  assert.ok(Math.abs(box.w - (0.5 * 1080 * 4) / 3 / 1920) < 1e-9)
  assert.ok(Math.abs(box.x - (0.5 - box.w) / 2) < 1e-9)
  assert.equal(containRect(tile, { w: 0, h: 480 }), null)
  assert.doesNotThrow(() =>
    assertInside('in', { x: 0.7, y: 0.6, w: 0.1, h: 0.2 }, tile_(0.65, 0.55))
  )
  assert.throws(() => assertInside('out', { x: 0.1, y: 0.6, w: 0.1, h: 0.2 }, tile_(0.65, 0.55)))
  assert.throws(() => assertInside('missing', null, tile_(0, 0)))
})

test('guest layers must match the program and be decoded', () => {
  const layer = {
    kind: 'avatar',
    left: '65%',
    top: '55%',
    width: '30%',
    height: '40%',
    natural: 64
  }
  assert.doesNotThrow(() => assertSameLayers('ok', [layer], [layer]))
  assert.throws(() => assertSameLayers('none', [], [layer]))
  assert.throws(() => assertSameLayers('moved', [{ ...layer, left: '10%' }], [layer]))
  assert.throws(() => assertSameLayers('blank', [{ ...layer, natural: 0 }], [layer]))
})

function tile_(x, y) {
  return { x, y, w: 0.3, h: 0.4 }
}
