import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compareScreen, entriesOf, expandHome, readManifest, screensOf } from './gpui-baseline.mjs'
import { decodePng, encodePng } from './gpui-compare.mjs'

const solid = (width, height, [r, g, b]) => {
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = 255
  }
  return encodePng({ width, height, rgba })
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gpui-baseline-test-'))
  const baseline = join(root, 'baseline')
  const shots = join(root, 'shots')
  mkdirSync(join(baseline, 'studio'), { recursive: true })
  mkdirSync(join(shots, 'studio'), { recursive: true })
  const dark = solid(8, 6, [10, 10, 10])
  const light = solid(8, 6, [240, 240, 240])
  writeFileSync(join(baseline, 'studio', 'idle-1280x800-dark.png'), dark)
  writeFileSync(join(baseline, 'studio', 'idle-1280x800-light.png'), light)
  writeFileSync(join(baseline, 'studio', 'idle-1280x800-dark-contrast.png'), dark)
  const entry = (theme, contrast, bytes) => ({
    screen: 'studio',
    state: 'idle',
    theme,
    contrast,
    width: 1280,
    height: 800,
    path: `studio/idle-1280x800-${theme}${contrast === 'more' ? '-contrast' : ''}.png`,
    bytes: bytes.length,
    sha256: sha(bytes)
  })
  const manifest = {
    folder: baseline,
    appCommit: 'abc',
    date: '2026-11-24',
    entries: [
      entry('dark', 'normal', dark),
      entry('light', 'normal', light),
      entry('dark', 'more', dark),
      { ...entry('light', 'normal', light), screen: 'scene', path: 'scene/x.png' }
    ]
  }
  const manifestFile = join(root, 'manifest.json')
  writeFileSync(manifestFile, JSON.stringify(manifest))
  return { root, baseline, shots, manifestFile, dark, light }
}

test('the manifest lists its screens and each screen its stems', () => {
  const { manifestFile } = fixture()
  const manifest = readManifest(manifestFile)
  assert.deepEqual(screensOf(manifest), [
    { screen: 'studio', entries: 3 },
    { screen: 'scene', entries: 1 }
  ])
  assert.deepEqual(
    entriesOf(manifest, 'studio').map((entry) => entry.stem),
    ['idle-1280x800-dark', 'idle-1280x800-light', 'idle-1280x800-dark-contrast']
  )
  assert.throws(
    () => entriesOf(manifest, 'nope'),
    /No baseline screen "nope". Known: studio, scene/
  )
  assert.ok(!expandHome('~/x').startsWith('~'))
})

test('compare pairs each shot it finds and names every entry it could not pair', () => {
  const { root, shots, manifestFile, dark } = fixture()
  // One identical shot under <shots>/<screen>/, one different one at the top level, one missing.
  writeFileSync(join(shots, 'studio', 'idle-1280x800-dark.png'), dark)
  writeFileSync(join(shots, 'idle-1280x800-light.png'), solid(4, 3, [0, 0, 0]))
  const out = join(root, 'out')
  const report = compareScreen({
    manifest: readManifest(manifestFile),
    screen: 'studio',
    shotsDir: shots,
    outDir: out,
    slice: 's2.2a'
  })
  assert.equal(report.slice, 's2.2a')
  assert.deepEqual(
    report.paired.map((row) => [row.stem, row.differingShare, row.sizeMatch]),
    [
      ['idle-1280x800-dark', 0, true],
      ['idle-1280x800-light', 1, false]
    ]
  )
  assert.deepEqual(report.unpaired, [
    { stem: 'idle-1280x800-dark-contrast', reason: 'no GPUI shot' }
  ])
  for (const suffix of ['electron', 'gpui', 'pair']) {
    assert.ok(existsSync(join(out, 'studio', `idle-1280x800-dark.${suffix}.png`)), suffix)
  }
  // The pair is baseline, shot and difference side by side (8 + 16 + 8 + 16 + 8 wide).
  const pair = decodePng(readFileSync(join(out, 'studio', 'idle-1280x800-dark.pair.png')))
  assert.equal(pair.width, 56)
  assert.deepEqual(
    JSON.parse(readFileSync(join(out, 'studio', 'report.json'), 'utf8')).unpaired,
    report.unpaired
  )
})

test('a baseline that is missing or changed since the manifest is named, not compared', () => {
  const { root, baseline, shots, manifestFile, dark } = fixture()
  writeFileSync(join(baseline, 'studio', 'idle-1280x800-light.png'), dark)
  writeFileSync(join(shots, 'idle-1280x800-light.png'), dark)
  const manifest = readManifest(manifestFile)
  manifest.entries[2].path = 'studio/gone.png'
  const report = compareScreen({
    manifest,
    screen: 'studio',
    shotsDir: shots,
    outDir: join(root, 'out')
  })
  const reasons = Object.fromEntries(report.unpaired.map((row) => [row.stem, row.reason]))
  assert.match(reasons['idle-1280x800-light'], /baseline changed since the manifest/)
  assert.match(reasons['idle-1280x800-dark-contrast'], /baseline missing/)
  assert.equal(report.slice, 'adhoc')
})
