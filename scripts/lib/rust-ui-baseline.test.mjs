import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

import { parseLooks } from './rust-ui-baseline-cli.mjs'
import { splitSignedInParts } from './rust-ui-baseline.mjs'
import {
  BASELINE_LOOKS,
  BASELINE_SCREEN_IDS,
  STREAM_MANAGER_SIZES,
  buildManifest,
  manifestEntry,
  manifestProblems,
  shotFileName,
  shotPath
} from './rust-ui-baseline-manifest.mjs'
import {
  baselineCaptureConfigPatch,
  baselineFixtureBytes,
  baselineLiveChatStart,
  baselineScenes,
  baselineUiSettings,
  baselineWorkingScene,
  encodePng,
  encodeToneWav
} from './rust-ui-baseline-profile.mjs'
import { windowRoleOfUrl } from './rust-ui-baseline-cdp.mjs'

const shot = {
  screen: 'studio',
  state: 'idle',
  theme: 'dark',
  contrast: 'normal',
  width: 1280,
  height: 800
}

test('a shot is named <screen>/<state>-<w>x<h>-<theme>[-contrast].png', () => {
  assert.equal(shotPath(shot), 'studio/idle-1280x800-dark.png')
  assert.equal(
    shotPath({ ...shot, theme: 'light', contrast: 'more' }),
    'studio/idle-1280x800-light-contrast.png'
  )
  assert.throws(() => shotFileName({ ...shot, state: '../x' }), /Not a state id/)
  assert.throws(() => shotFileName({ ...shot, theme: 'sepia' }), /Not a theme/)
  assert.throws(() => shotFileName({ ...shot, contrast: 'high' }), /Not a contrast/)
  assert.throws(() => shotPath({ ...shot, screen: 'Studio' }), /Not a screen id/)
})

test('the looks are dark, light and Increase Contrast over each', () => {
  assert.deepEqual(
    BASELINE_LOOKS.map((look) => `${look.theme}/${look.contrast}`),
    ['dark/normal', 'light/normal', 'dark/more', 'light/more']
  )
  assert.deepEqual(parseLooks('dark,light-contrast'), [BASELINE_LOOKS[0], BASELINE_LOOKS[3]])
  assert.throws(() => parseLooks('sepia'), /A look is/)
})

test("the screen ids are plan 220's, updated for plan 260, and the Stream Manager has four bands", () => {
  assert.equal(BASELINE_SCREEN_IDS.includes('studio-retro'), false)
  assert.equal(BASELINE_SCREEN_IDS.length, 37)
  assert.equal(new Set(BASELINE_SCREEN_IDS).size, 37)
  for (const id of [
    'sounds',
    'livestream-discord',
    'avatar-profile',
    'avatar-greetings',
    'buddy-overview',
    'buddy-community',
    'shell',
    'toasts',
    'palette',
    'first-run',
    'captions-reader',
    'buddy-pet-creator'
  ]) {
    assert.ok(BASELINE_SCREEN_IDS.includes(id), id)
  }
  assert.deepEqual(
    STREAM_MANAGER_SIZES.map((size) => `${size.width}x${size.height}`),
    ['420x640', '700x640', '900x640', '1100x700']
  )
})

test('a manifest entry carries the file size and its SHA-256', () => {
  const folder = mkdtempSync(join(tmpdir(), 'baseline-test-'))
  try {
    mkdirSync(join(folder, 'studio'))
    writeFileSync(join(folder, 'studio', 'idle-1280x800-dark.png'), 'abc')
    const entry = manifestEntry(folder, shot, 'deadbeef')
    assert.equal(entry.bytes, 3)
    assert.equal(entry.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(entry.appCommit, 'deadbeef')
    assert.equal(entry.path, 'studio/idle-1280x800-dark.png')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a manifest lists every screen: shot, or missing with its reason', () => {
  const folder = mkdtempSync(join(tmpdir(), 'baseline-test-'))
  try {
    mkdirSync(join(folder, 'studio'))
    const entries = BASELINE_LOOKS.map((look) => {
      const one = { ...shot, ...look }
      writeFileSync(join(folder, shotPath(one)), `${one.theme}${one.contrast}`)
      return manifestEntry(folder, one, 'c0ffee')
    })
    const manifest = buildManifest({
      entries,
      missing: [
        { screen: 'studio', state: 'idle', reason: 'a stale line a shot replaces' },
        { screen: 'library-player', state: 'default', reason: 'no in-app player' }
      ],
      appCommit: 'c0ffee',
      date: '2026-11-09',
      host: 'test'
    })
    assert.equal(manifest.entries.length, 4)
    const player = manifest.missing.find((item) => item.screen === 'library-player')
    assert.equal(player.reason, 'no in-app player')
    assert.equal(
      manifest.missing.some((item) => item.screen === 'studio'),
      false
    )
    // Every other screen is a "not attempted" line, never silently absent.
    for (const screen of BASELINE_SCREEN_IDS.filter((id) => id !== 'studio')) {
      assert.ok(
        manifest.missing.some((item) => item.screen === screen),
        screen
      )
    }
    assert.deepEqual(manifestProblems(manifest, folder), [])

    writeFileSync(join(folder, 'studio', 'idle-1280x800-dark.png'), 'changed')
    assert.match(manifestProblems(manifest, folder).join('\n'), /SHA-256 differs|bytes/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a screen shot in fewer looks than the others is a problem', () => {
  const folder = mkdtempSync(join(tmpdir(), 'baseline-test-'))
  try {
    mkdirSync(join(folder, 'studio'))
    writeFileSync(join(folder, 'studio', 'idle-1280x800-dark.png'), 'x')
    const manifest = buildManifest({
      entries: [manifestEntry(folder, shot, 'c0ffee')],
      missing: [],
      appCommit: 'c0ffee',
      date: '2026-11-09',
      host: 'test'
    })
    assert.match(manifestProblems(manifest, folder).join('\n'), /studio: no entry in light\/normal/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a window is told apart by its page', () => {
  assert.equal(windowRoleOfUrl('http://localhost:5173/'), 'main')
  assert.equal(windowRoleOfUrl('http://localhost:5173/comments.html'), 'stream-manager')
  assert.equal(windowRoleOfUrl('http://localhost:5173/captions.html'), 'captions')
  assert.equal(windowRoleOfUrl('http://localhost:5173/notes.html'), 'notes')
  assert.equal(windowRoleOfUrl('devtools://devtools/bundled/x.html'), 'other')
})

test('the fixtures are the same bytes on every call', () => {
  const first = baselineFixtureBytes()
  const second = baselineFixtureBytes()
  assert.deepEqual(Object.keys(first), [
    'banner-lower-third.png',
    'banner-logo.png',
    'takeover-be-right-back.png',
    'takeover-starting-soon.png',
    'background-baseline.png',
    'sound-ding.wav',
    'sound-low.wav'
  ])
  for (const name of Object.keys(first)) assert.ok(first[name].equals(second[name]), name)
})

test('the PNG encoder writes a real image and the WAV encoder a real tone', () => {
  const png = encodePng(3, 2, (x, y) => [x * 80, y * 100, 7, 255])
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 3)
  assert.equal(png.readUInt32BE(20), 2)
  const idat = png.indexOf('IDAT')
  const length = png.readUInt32BE(idat - 4)
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length))
  assert.equal(rows.length, (3 * 4 + 1) * 2)
  assert.deepEqual([...rows.subarray(1, 5)], [0, 0, 7, 255])
  assert.deepEqual([...rows.subarray(14, 18)], [0, 100, 7, 255])
  assert.throws(() => encodePng(0, 1, () => [0, 0, 0]), /Not a PNG size/)

  const wav = encodeToneWav({ hz: 1000, seconds: 0.25, sampleRate: 8000 })
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(40), 2000 * 2)
  assert.equal(wav.length, 44 + 2000 * 2)
})

test('the profile settings hold the test pattern with no device, and three saved scenes', () => {
  const patch = baselineCaptureConfigPatch({ sinkPort: 14_000 })
  assert.equal(patch.sources.testPattern, true)
  assert.equal(patch.sources.cameraOff, true)
  assert.equal(patch.sources.microphoneOff, true)
  assert.equal(patch.baselineSink.serverUrl, 'rtmp://127.0.0.1:14000/live')
  assert.deepEqual(patch.replayBuffer, { enabled: false, explicit: true })

  const visual = {
    layout: { layoutPreset: 'screen-camera', cameraZoom: 100 },
    sources: { cameraId: 'camera:real', testPattern: true },
    background: null
  }
  const library = baselineScenes(visual)
  assert.deepEqual(
    library.scenes.map((scene) => [scene.name, scene.visual.layout.layoutPreset]),
    [
      ['Talking head', 'screen-camera'],
      ['Demo', 'screen-only'],
      ['Side by side', 'side-by-side']
    ]
  )
  assert.ok(library.scenes.every((scene) => scene.createdAt === '2026-11-01T12:00:00.000Z'))
  const working = baselineWorkingScene(visual)
  assert.equal(working.sceneId, 'baseline-scene-demo')
  assert.equal(working.visual.layout.layoutPreset, 'screen-only')
  assert.equal(working.visual.sources.cameraOff, true)

  const settings = baselineUiSettings({ whatsNewVersion: '0.20.1' })
  assert.equal(settings['videorc.whatsNewLastSeenVersion'], '0.20.1')
  for (const value of Object.values(settings)) assert.equal(typeof value, 'string')
})

test('the fake chat rows are few and quick on three platforms', () => {
  const start = baselineLiveChatStart('s')
  assert.deepEqual(start.platforms, ['youtube', 'twitch', 'x'])
  assert.equal(start.fakes.length, 3)
  for (const fake of start.fakes) {
    assert.equal(fake.count, 8)
    assert.ok(fake.intervalMs <= 100)
  }
})

test('the signed-in Buddy part gets its own launch; the rest are shot signed out', () => {
  assert.deepEqual(splitSignedInParts(['idle', 'windows', 'first-run', 'buddy']), [
    ['idle', 'windows', 'first-run'],
    ['buddy']
  ])
  assert.deepEqual(splitSignedInParts(['buddy']), [['buddy']])
  assert.deepEqual(splitSignedInParts(['idle', 'windows']), [['idle', 'windows']])
})
