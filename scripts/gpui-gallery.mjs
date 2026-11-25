#!/usr/bin/env node
// Plan 260: the by-eye screen gallery (owner order 2026-11-25).
//
//   pnpm gallery:gpui [-- --build DIR] [--baseline DIR] [--out DIR]
//                     [--screens=studio,settings-*] [--since DIR] [--all]
//                     [--pages-only] [--electron-only]
//
// Shoots every GPUI screen on main, dark and light, at a 1280x800 window,
// next to the S0.10 Electron baseline shot of the same screen
// (docs/gpui/baseline.md, the same size, shot on this Mac), and writes:
//
//   <out>/<sha>/gpui/<screen>-<look>-gpui.png   the window, as macOS draws it
//   <out>/<sha>/img/*.jpg                       both sides, sized for the page
//   <out>/<sha>/manifest.json                   each shot, its baseline pair,
//                                               and the parity rows it covers
//   <out>/<sha>/index.html + <deck>.html        the Live pages (a cover and
//                                               one question page per deck)
//
// `--since DIR` (a previous run's folder) keeps only screens whose GPUI shots
// changed; screens whose macOS rows are all ticked are left out unless
// `--all`. `--pages-only` rebuilds the pages from an existing manifest.
// `--electron-only` prepares the Electron half (`<out>/electron/`) with no
// app run; a later run copies its JPEGs.
//
// It builds nothing: the app and backend are the compile sentinel's
// (`~/cloud-test/gpui-builds/latest/`), hard-linked into a scratch
// `target/release/` so the app runs as a dev build would. Isolated profile
// only; it refuses while `on-air.json` exists, holds `~/videorc-app-run.lock`
// for the run, and stops only the app it started. Window shots use
// `screencapture -l` (the UI driver has no window capture yet, gap 3), so the
// terminal needs Screen Recording.

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { comparePictures, decodePng } from './lib/gpui-compare.mjs'
import {
  DECKS,
  LOOKS,
  SCREENS,
  WINDOW,
  baselinePath,
  coverHtml,
  deckHtml,
  digest,
  needsLook,
  pickScreens,
  rowsFor,
  shootingOrder,
  shotName
} from './lib/gpui-gallery.mjs'
import { parseParity } from './lib/gpui-parity.mjs'
import {
  BASELINE_SEED_TIME,
  baselineCaptureConfigPatch,
  baselineFixtureFiles,
  baselineScenes,
  baselineUiSettings,
  baselineWorkingScene,
  seedBaselineBackend
} from './lib/rust-ui-baseline-profile.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { createUiDriver } from './lib/ui-driver.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    build: { type: 'string', default: join(homedir(), 'cloud-test', 'gpui-builds', 'latest') },
    baseline: { type: 'string', default: join(homedir(), 'videorc-gpui-baseline', '2026-11-24') },
    out: {
      type: 'string',
      default: join(homedir(), '.local', 'share', 'ghostex', 'i', 'gpui-gallery')
    },
    screens: { type: 'string' },
    since: { type: 'string' },
    all: { type: 'boolean', default: false },
    'pages-only': { type: 'boolean', default: false },
    'electron-only': { type: 'boolean', default: false },
    sha: { type: 'string' }
  }
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(`gallery: ${line}`)
const ON_AIR = join(homedir(), 'Library', 'Application Support', 'Videorc', 'on-air.json')
const RUN_LOCK = join(homedir(), 'videorc-app-run.lock')
const SETTLE_MS = Number(process.env.VIDEORC_GALLERY_SETTLE_MS ?? 1500)
// A second capture this long after the first, in case the window was still
// drawing when the first was taken.
const WAKE_MS = Number(process.env.VIDEORC_GALLERY_WAKE_MS ?? 700)
// The test toast's life: gone before the next screen is shot.
const TOAST_MS = 2_500

function buildSha(buildDir) {
  if (values.sha) return values.sha
  const real = existsSync(buildDir) ? realpathSync(buildDir) : buildDir
  if (/^[0-9a-f]{7,40}$/.test(basename(real))) return basename(real).slice(0, 9)
  for (const name of ['sha', 'SHA', 'commit']) {
    const file = join(real, name)
    if (existsSync(file)) return readFileSync(file, 'utf8').trim().slice(0, 9)
  }
  throw new Error(`Can't tell which commit ${buildDir} was built from; pass --sha.`)
}

function binaryIn(dir, names) {
  const found = names.map((name) => join(dir, name)).find((path) => existsSync(path))
  if (!found) throw new Error(`None of ${names.join(', ')} is in ${dir}.`)
  return found
}

/** The sentinel's binaries in a scratch `target/release/`, so the app reads as a dev build. */
function stageBinaries(buildDir) {
  const app = binaryIn(buildDir, ['Videorc', 'videorc', 'videorc-app'])
  const backend = binaryIn(buildDir, ['videorc-backend'])
  const scratch = mkdtempSync(join(tmpdir(), 'videorc-gallery-bin-'))
  const release = join(scratch, 'target', 'release')
  mkdirSync(release, { recursive: true })
  const place = (from, name) => {
    const to = join(release, name)
    try {
      linkSync(from, to)
    } catch {
      copyFileSync(from, to)
    }
    return to
  }
  return { scratch, app: place(app, 'Videorc'), backend: place(backend, 'videorc-backend') }
}

function takeRunLock() {
  if (existsSync(ON_AIR)) {
    throw new Error(`${ON_AIR} exists: Videorc is on air. The gallery waits for another time.`)
  }
  try {
    mkdirSync(RUN_LOCK)
  } catch {
    throw new Error(`${RUN_LOCK} is held by another app run; try again when it is gone.`)
  }
  writeFileSync(join(RUN_LOCK, 'owner'), `gpui-gallery pid ${process.pid}\n`)
  return () => rmSync(RUN_LOCK, { recursive: true, force: true })
}

// CGWindowListCopyWindowInfo through JXA: the on-screen windows a pid owns.
const WINDOWS_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) !== pid) continue;
    // Normal (0) or floating (3, raise-window): not menus or shadows.
    const layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));
    if (layer !== 0 && layer !== 3) continue;
    const b = w.objectForKey('kCGWindowBounds');
    out.push({ id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')), width: ObjC.unwrap(b.objectForKey('Width')), height: ObjC.unwrap(b.objectForKey('Height')) });
  }
  return JSON.stringify(out);
}`

function mainWindowId(pid, scriptFile) {
  const windows = JSON.parse(
    execFileSync('osascript', ['-l', 'JavaScript', scriptFile, String(pid)], { encoding: 'utf8' })
  )
  const main = windows.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!main) throw new Error(`The app (pid ${pid}) has no window on screen.`)
  return main.id
}

function toJpeg(png, jpg) {
  execFileSync(
    'sips',
    ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '-Z', '1280', png, '--out', jpg],
    {
      stdio: 'ignore'
    }
  )
}

async function launch({ bins, stateDir }) {
  return launchDevApp({
    env: {
      VIDEORC_APP: 'gpui',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_USER_DATA_DIR: join(stateDir, 'profile'),
      // The Electron baselines are signed out on Basic, so Premium gates are
      // locked. The sentinel's backend is a debug build, which resolves no
      // account to the Developer tier and opens every gate; this downgrade-
      // only override (`entitlements.rs` `basic_override_enabled`) keeps the
      // GPUI shots on Basic so locked states compare.
      VIDEORC_PREMIUM_FEATURES: 'basic'
    },
    spawnSpec: {
      command: bins.app,
      args: ['--backend', bins.backend, '--workspace', repoRoot],
      cwd: repoRoot
    },
    timeoutMs: 180_000,
    requiredMarkers: ['preview-motion-ready', 'backend-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_GALLERY_VERBOSE === '1') console.log(line)
    }
  })
}

/** The baseline's profile on the GPUI app: the same backend seed and UI settings. */
async function seedProfile({ app, stateDir }) {
  const smoke = app.connections['preview-motion-ready']
  const ws = await connectBackend(app.connections['backend-ready'], 60_000)
  const rpc = (method, params = {}) => request(ws, 60_000, method, params)
  const command = (name, params = {}) =>
    requestSmokeCommand(smoke, name, params, { timeoutMs: 60_000 })
  try {
    const recordingsDir = join(stateDir, 'recordings')
    mkdirSync(recordingsDir, { recursive: true })
    const fixtures = baselineFixtureFiles(join(stateDir, 'fixtures'))
    const backend = await seedBaselineBackend({
      rpc,
      smoke: command,
      fixtures,
      recordingsDir,
      log: (line) => log(`seed: ${line}`)
    })
    const current = await rpc('ui.settings.get', { keys: ['videorc.captureConfig'] })
    const stored =
      current?.values?.['videorc.captureConfig'] ?? current?.entries?.['videorc.captureConfig']
    const config = typeof stored === 'string' ? JSON.parse(stored) : (stored ?? {})
    const patch = baselineCaptureConfigPatch()
    const merged = { ...config, ...patch, sources: { ...(config.sources ?? {}), ...patch.sources } }
    delete merged.baselineSink
    const streaming = merged.streaming ?? { enabled: false, mode: 'single', targets: [] }
    streaming.enabled = true
    streaming.targets = (streaming.targets ?? []).map((target) =>
      target.id in backend.keys
        ? {
            ...target,
            enabled: true,
            streamKey: '',
            streamKeyPresent: true,
            streamKeySecretRef: backend.keys[target.id],
            updatedAt: BASELINE_SEED_TIME
          }
        : target
    )
    merged.streaming = streaming
    merged.layout = { ...merged.layout, layoutPreset: 'screen-only' }
    merged.lastHorizontalPreset = 'screen-only'
    const visual = { layout: merged.layout, sources: merged.sources, background: null }
    const put = {
      ...baselineUiSettings({ whatsNewVersion: '9999.0.0' }),
      'videorc.captureConfig': JSON.stringify(merged),
      'videorc.scene-presets.v1': JSON.stringify(baselineScenes(visual)),
      'videorc.working-scene.v1': JSON.stringify(baselineWorkingScene(visual)),
      'videorc.firstRun': JSON.stringify({
        version: 2,
        status: 'done',
        step: 'permissions',
        goal: 'stream',
        updatedAt: BASELINE_SEED_TIME
      })
    }
    await rpc('ui.settings.set', { put, delete: ['videorc.scenes.v2'] })
    return backend.failed.map(({ name, reason }) => ({ id: `seed:${name}`, reason }))
  } finally {
    ws.close()
  }
}

/**
 * The Electron half of a shot: the S0.10 baseline PNG as a page-sized JPEG in
 * `imgDir`, made once in `<out>/electron/img/` and copied from there.
 */
function electronShot(screen, look, baselineDir, imgDir) {
  const relative = baselinePath(screen, look)
  if (!relative) return null
  const source = join(baselineDir, relative)
  if (!existsSync(source)) return { baseline: relative, missing: true }
  const file = `${shotName(screen.id, look, 'electron')}.jpg`
  const cacheDir = join(resolve(values.out), 'electron', 'img')
  mkdirSync(cacheDir, { recursive: true })
  const cached = join(cacheDir, file)
  if (!existsSync(cached)) toJpeg(source, cached)
  if (resolve(imgDir) !== cacheDir) copyFileSync(cached, join(imgDir, file))
  return { baseline: relative, image: `img/${file}` }
}

/** `--electron-only`: the Electron half of every screen, with no app run. */
function electronOnly({ screens, baselineDir, parsed }) {
  const runDir = join(resolve(values.out), 'electron')
  const imgDir = join(runDir, 'img')
  mkdirSync(imgDir, { recursive: true })
  const entries = shootingOrder(screens).map((screen) => ({
    id: screen.id,
    title: screen.title,
    deck: screen.deck,
    baseline: screen.baseline,
    parity: rowsFor(parsed, screen),
    shots: LOOKS.map((look) => {
      const electron = electronShot(screen, look, baselineDir, imgDir)
      return {
        look,
        ...(electron ? { electron } : {}),
        gpui: { error: "Waiting for the compile sentinel's build" }
      }
    })
  }))
  return {
    runDir,
    manifest: {
      sha: 'electron',
      date: new Date().toISOString().slice(0, 10),
      window: WINDOW,
      baseline: baselineDir,
      screens: entries
    }
  }
}

/**
 * Merges `patch` into the JSON object the settings store keeps under `key`;
 * answers a function that puts the old value back.
 */
async function patchSetting(rpc, { key, patch }) {
  const current = await rpc('ui.settings.get', { keys: [key] })
  const stored = current?.entries?.[key]
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : (stored ?? {})
  await rpc('ui.settings.set', { put: { [key]: JSON.stringify({ ...parsed, ...patch }) } })
  return () =>
    stored === undefined
      ? rpc('ui.settings.set', { delete: [key] })
      : rpc('ui.settings.set', { put: { [key]: stored } })
}

async function shoot({ bins, stateDir, screens, runDir, sha, baselineDir, parsed }) {
  const jxa = join(stateDir, 'windows.js')
  writeFileSync(jxa, WINDOWS_JXA)
  const gpuiDir = join(runDir, 'gpui')
  const imgDir = join(runDir, 'img')
  mkdirSync(gpuiDir, { recursive: true })
  mkdirSync(imgDir, { recursive: true })
  let app, smoke, ui, ws, raisedWindowId
  const command = (name, params = {}, timeoutMs = 20_000) =>
    requestSmokeCommand(smoke, name, params, { timeoutMs })
  const rpc = (method, params = {}) => request(ws, 60_000, method, params)
  // A fresh app on the same profile: the start, and after a screen that
  // leaves something open the app can't close yet (`restart`).
  const start = async () => {
    app = await launch({ bins, stateDir })
    smoke = app.connections['preview-motion-ready']
    ui = createUiDriver(smoke, { app: 'gpui' })
    ws = await connectBackend(app.connections['backend-ready'], 60_000)
    await command('resize-window', WINDOW)
    // GPUI stops drawing a window macOS reports as covered, so a shot behind
    // other windows showed the screen before it (010616c0d's first runs).
    // Floating, without taking focus: it stays drawn and the owner keeps
    // typing where they were.
    const raised = await command('raise-window', {
      role: 'main',
      level: 'floating',
      focus: false
    })
    raisedWindowId = Number.isInteger(raised?.windowId) ? raised.windowId : null
    await sleep(800)
  }
  const stop = async () => {
    ws?.close()
    await app?.stop()
  }
  const entries = []
  try {
    await start()
    const library = await command('studio-scenes-state').catch((error) => ({
      error: error.message
    }))
    log(
      library?.scenes
        ? `the profile holds ${library.scenes.length} saved scenes (the baseline has 3)`
        : `the saved scenes are unknown: ${library?.error ?? JSON.stringify(library)}`
    )
    for (const screen of shootingOrder(screens)) {
      const entry = {
        id: screen.id,
        title: screen.title,
        deck: screen.deck,
        baseline: screen.baseline,
        parity: rowsFor(parsed, screen),
        shots: []
      }
      // A look the app keeps in a setting (Retro LCD): on for this screen,
      // then back as it was. The app applies store changes live.
      const restore = screen.settings ? await patchSetting(rpc, screen.settings) : null
      if (restore) await sleep(SETTLE_MS)
      for (const look of LOOKS) {
        const shot = { look }
        const name = shotName(screen.id, look, 'gpui')
        try {
          await command('ui-appearance', {
            theme: look,
            reduceMotion: screen.reduceMotion ? true : null
          })
          if (screen.toast) {
            await command('open-tab', { tab: 'studio' })
            await command('ui-toast', {
              kind: screen.toast,
              title: `A ${screen.toast} toast`,
              description: 'What happened, in one sentence.',
              id: 'gallery-toast',
              durationMs: TOAST_MS
            })
            await sleep(900)
          } else {
            const opened = await command('open-tab', screen.open)
            // A build before open-tab's extras ignores subTab and dialog and
            // would show the wrong screen; it answers without `subTab`.
            if ((screen.open.subTab || screen.open.dialog) && !('subTab' in (opened ?? {}))) {
              throw new Error(
                "this build's open-tab has no subTab or dialog yet (they land with the gallery's PR)"
              )
            }
            await sleep(screen.open.dialog ? SETTLE_MS + 800 : SETTLE_MS)
          }
          const png = join(gpuiDir, `${name}.png`)
          const windowId = String(raisedWindowId ?? mainWindowId(app.process.pid, jxa))
          execFileSync('screencapture', ['-x', '-o', '-l', windowId, png])
          await sleep(WAKE_MS)
          execFileSync('screencapture', ['-x', '-o', '-l', windowId, png])
          const bytes = readFileSync(png)
          const jpg = join(imgDir, `${name}.jpg`)
          toJpeg(png, jpg)
          shot.gpui = { png: `gpui/${name}.png`, image: `img/${name}.jpg`, digest: digest(bytes) }
          if (screen.close) await closeScreen(ui, screen.close)
        } catch (error) {
          shot.gpui = { error: String(error?.message ?? error).slice(0, 300) }
          log(`${name}: ${shot.gpui.error}`)
        }
        const electron = electronShot(screen, look, baselineDir, imgDir)
        if (electron) shot.electron = electron
        entry.shots.push(shot)
      }
      if (restore) await restore().catch((error) => log(`${screen.id}: ${error.message}`))
      if (screen.toast) await sleep(TOAST_MS + 500)
      if (screen.restart) {
        await stop()
        await start()
      }
      entries.push(entry)
      log(`${screen.id}: ${entry.shots.filter((s) => s.gpui?.image).length}/${LOOKS.length} shot`)
    }
  } finally {
    await stop()
  }
  return { sha, date: new Date().toISOString().slice(0, 10), window: WINDOW, screens: entries }
}

/** Closes what a screen opened: a key, or a button to click (Escape if it
 * can't be found). */
async function closeScreen(ui, close) {
  if (typeof close === 'string') {
    await ui.press(close).catch(() => {})
    return
  }
  await ui.click(close.click, { timeoutMs: 3_000 }).catch(() => ui.press('Escape').catch(() => {}))
  await sleep(400)
}

/** How much of each GPUI shot moved since `previous` (a run folder). */
function markChanges(manifest, runDir, previousDir) {
  for (const entry of manifest.screens) {
    for (const shot of entry.shots) {
      const old = join(previousDir, 'gpui', `${shotName(entry.id, shot.look, 'gpui')}.png`)
      if (!shot.gpui?.png || !existsSync(old)) continue
      try {
        const before = decodePng(readFileSync(old))
        const now = decodePng(readFileSync(join(runDir, shot.gpui.png)))
        shot.changedShare = comparePictures(before, now).report.differingShare
      } catch {
        shot.changedShare = 1
      }
    }
  }
}

function writePages(manifest, runDir, previous) {
  const shown = manifest.screens.filter((entry) => values.all || needsLook(entry, previous))
  const skipped = manifest.screens
    .filter((entry) => !shown.includes(entry))
    .map((entry) => ({
      id: entry.id,
      reason:
        entry.parity.open === 0 ? 'every macOS row is ticked' : 'unchanged since the last gallery'
    }))
  const decks = DECKS.map((deck) => ({
    deck,
    file: `${deck.id}.html`,
    entries: shown.filter((entry) => entry.deck === deck.id)
  })).filter((deck) => deck.entries.length > 0)
  for (const { deck, file, entries } of decks) {
    writeFileSync(
      join(runDir, file),
      deckHtml({ deck, entries, date: manifest.date, sha: manifest.sha })
    )
  }
  writeFileSync(
    join(runDir, 'index.html'),
    coverHtml({ decks, date: manifest.date, sha: manifest.sha, skipped })
  )
  return { decks, skipped }
}

async function main() {
  const parsed = parseParity(readFileSync(join(repoRoot, 'docs', 'gpui', 'parity.md'), 'utf8'))
  if (values['electron-only']) {
    const { runDir, manifest } = electronOnly({
      screens: pickScreens(values.screens),
      baselineDir: resolve(values.baseline),
      parsed
    })
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writePages(manifest, runDir, null)
    const pairs = manifest.screens.flatMap((entry) => entry.shots.map((shot) => ({ entry, shot })))
    const ready = pairs.filter(({ shot }) => shot.electron?.image).length
    log(`Electron half: ${ready}/${pairs.length} shots ready in ${join(runDir, 'img')}`)
    for (const { entry, shot } of pairs.filter(({ shot }) => !shot.electron?.image)) {
      log(
        `no Electron shot: ${entry.id}/${shot.look}` +
          (shot.electron?.missing
            ? ` (${shot.electron.baseline} is missing)`
            : ' (the baseline has no such screen)')
      )
    }
    return
  }
  const buildDir = resolve(values.build)
  const sha = buildSha(buildDir)
  const runDir = join(resolve(values.out), sha)
  mkdirSync(runDir, { recursive: true })
  const previous = values.since
    ? JSON.parse(readFileSync(join(values.since, 'manifest.json'), 'utf8'))
    : null

  let manifest
  if (values['pages-only']) {
    manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'))
  } else {
    const screens = pickScreens(values.screens)
    const release = takeRunLock()
    const bins = stageBinaries(buildDir)
    const stateDir = mkdtempSync(join(tmpdir(), 'videorc-gallery-'))
    try {
      log(`build ${sha}: seeding an isolated profile in ${stateDir}`)
      const seeding = await launch({ bins, stateDir })
      let notSeeded = []
      try {
        notSeeded = await seedProfile({ app: seeding, stateDir })
      } finally {
        await seeding.stop()
      }
      log(`shooting ${screens.length} screens, ${LOOKS.join(' and ')}`)
      manifest = await shoot({
        bins,
        stateDir,
        screens,
        runDir,
        sha,
        baselineDir: resolve(values.baseline),
        parsed
      })
      manifest.notSeeded = notSeeded
      manifest.baseline = resolve(values.baseline)
    } finally {
      release()
      rmSync(bins.scratch, { recursive: true, force: true })
    }
    if (values.since) markChanges(manifest, runDir, resolve(values.since))
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const { decks, skipped } = writePages(manifest, runDir, previous)
  const shots = manifest.screens.reduce(
    (sum, entry) => sum + entry.shots.filter((shot) => shot.gpui?.image).length,
    0
  )
  const failed = manifest.screens.flatMap((entry) =>
    entry.shots
      .filter((shot) => shot.gpui?.error)
      .map((shot) => `${entry.id}/${shot.look}: ${shot.gpui.error}`)
  )
  log(
    `${manifest.screens.length} screens, ${shots} GPUI shots, ${decks.length} pages, ${skipped.length} left out`
  )
  for (const line of failed) log(`not captured: ${line}`)
  for (const item of manifest.notSeeded ?? []) log(`not seeded: ${item.id}: ${item.reason}`)
  log(`page: ${join(runDir, 'index.html')}`)
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
