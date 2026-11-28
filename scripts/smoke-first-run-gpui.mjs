#!/usr/bin/env node
// smoke:first-run on the GPUI app (`VIDEORC_APP=gpui`; plan 260 smoke port,
// Batch A). Electron's harness (`smoke-first-run-app.mjs`) drives the renderer
// through CDP: it seeds browser storage, emulates colour scheme, contrast and
// reduced motion, and counts WebGL draws. The GPUI app has none of those, so
// each is replaced by what the app offers:
//
//   seed browser storage      the profile's UI settings through the backend
//                             (`ui.settings.set`), then a relaunch of the same
//                             isolated profile (the reload)
//   emulated media            `ui-appearance` (theme, Increase contrast,
//                             Reduce motion), which the app follows
//   DOM `[data-first-run-*]`  `first-run-state` (app test hook)
//   backdrop draw counter     the backdrop's presented-frames counter, in
//                             `first-run-state` (app test hook)
//   screencast frames         two window-only captures (`screencapture -l` of
//                             the Videorc window, never the screen)
//   clicks and keys           the UI driver, by accessible name
//
// The gates are the shared `first-run-smoke-gate.mjs`, fed the same shaped
// observation (`first-run-gpui-observation.mjs`). What has no GPUI meaning is
// reported as a SKIP with its reason, never dropped:
//   - CSS picture/poster filters: the tone the backdrop is drawn with
//     (inverse, shader Dim, brightness) stands in (see the observation file).
//   - Look's two-player cost (backdrop + moving look picture, GPU process CPU):
//     the GPUI Look step shows still thumbnails; one backdrop player runs.
//   - launch-quiet's injected owner reports: they call renderer modules.
//   - What's New over setup: GPUI shows no What's New dialog at launch.
//
// A GPUI window draws its backdrop only while it is on screen, so each run
// raises the main window (`raise-window`, never focus). Mac only. Isolated
// profiles, no permission button is pressed, no real account or service. The
// app-run lock is held only while an app runs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connectBackend, request } from './smoke-recording-session.mjs'
import { launchDevApp, repoRoot, gpuiAppBinaryPath } from './lib/app-launcher.mjs'
import { requireAppRunLock } from './lib/app-run-lock.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  evaluateFirstRunSmokeStep,
  FIRST_RUN_SMOKE_LIMITS,
  FIRST_RUN_SOURCE_START_PATTERNS,
  firstRunPerformanceCheckSettled,
  firstRunSourceStartLines
} from './lib/first-run-smoke-gate.mjs'
import { gpuiFirstRunObservation } from './lib/first-run-gpui-observation.mjs'

if (process.platform !== 'darwin') {
  throw new Error('The GPUI first-run smoke runs on macOS; Windows and Linux are owner-owed.')
}
const bins = {
  app: gpuiAppBinaryPath(),
  backend: process.env.VIDEORC_GPUI_BACKEND_BINARY ?? join(repoRoot, 'target/debug/videorc-backend')
}
for (const [name, path] of Object.entries(bins)) {
  if (!existsSync(path)) {
    throw new Error(`Build the GPUI ${name} first (cargo build -p videorc-app): ${path} is missing.`)
  }
}
const outputRoot = resolve(process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? tmpdir())
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, 'videorc-first-run-gpui-'))
const report = { app: 'gpui', limits: FIRST_RUN_SMOKE_LIMITS, output, steps: [], skips: [] }
const save = () => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const skip = (name, reason) => {
  report.skips.push({ name, reason })
  console.log(`SKIP ${name}: ${reason}`)
}

let app = null
let smoke = null
let backend = null
let profileName = ''
let lock = null
let appLines = []
let guard = null
// Electron's mount-to-moving time is the first one of a document (`??=`): a
// player restarted after reduced motion does not move it.
let firstMountToMovingMs = null
const themeShots = { dark: new Map(), light: new Map() }
const allSteps = ['permissions', 'goal', 'look', 'sound', 'destinations']

const command = (name, params = {}, timeoutMs = 40_000) =>
  requestSmokeCommand(smoke, name, params, { timeoutMs })
const rpc = (method, params = {}) => request(backend, 60_000, method, params)
const main = { window: 'main' }

// ---- the app's own state -------------------------------------------------

async function settings(keys) {
  const answer = await rpc('ui.settings.get', { keys })
  const values = answer?.values ?? answer?.entries ?? {}
  return Object.fromEntries(keys.map((key) => [key, values[key] ?? null]))
}

const parse = (raw) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}
async function windowTitle() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const tree = await command('ui-tree', { ...main, depth: 0 })
      return String((tree.tree ?? tree).label ?? '')
    } catch {
      await delay(500)
    }
  }
  return ''
}
const frState = () => command('first-run-state')

async function present(label, role = 'button') {
  try {
    await command('ui-find', { ...main, label, ...(role ? { role } : {}), timeoutMs: 800 }, 5000)
    return true
  } catch {
    return false
  }
}

/** One reading in the shape the shared gate reads (Electron's `state()`). */
async function state(extra = {}) {
  const fr = await frState()
  const stored = await settings(['videorc.firstRun', 'videorc.captureConfig'])
  const observation = gpuiFirstRunObservation(fr, {
    recordRaw: stored['videorc.firstRun'],
    configRaw: stored['videorc.captureConfig']
  })
  // The committed look: the scene's own live background (Electron reads the
  // background registry; the GPUI Look tile commits to the working scene).
  const scene = await rpc('scene.get')
  const live = scene?.background?.live?.id ?? null
  if (firstMountToMovingMs === null && observation.mountToMovingMs !== null) {
    firstMountToMovingMs = observation.mountToMovingMs
  }
  observation.mountToMovingMs = firstMountToMovingMs
  observation.registry = { live: { activeId: live }, activeSlotId: null }
  observation.registryRaw = JSON.stringify(observation.registry)
  observation.layoutOptions = (fr.layoutOptions ?? []).map((option) => ({
    preset: option.preset,
    disabled: option.disabled,
    reason: option.reason
  }))
  if (observation.cardStep === 'goal') {
    // The three choice rows, by name (`[data-first-run-goal]` in Electron).
    const rows = [
      ['record', 'Recordings'],
      ['stream', 'Livestreams'],
      ['both', 'Both']
    ]
    observation.goalOptions = []
    for (const [id, label] of rows) if (await present(label)) observation.goalOptions.push(id)
  }
  return { ...observation, ...extra }
}

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await state()
    if (predicate(last)) return last
    await delay(50)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}

async function check(step, observation) {
  const result = evaluateFirstRunSmokeStep(step, observation)
  report.steps.push({ profile: profileName, step, ...result, observation })
  save()
  console.log(
    `${result.pass ? 'PASS' : 'FAIL'} ${profileName}/${step}${result.skipped?.length ? '; skipped: ' + result.skipped.join('; skipped: ') : ''}`
  )
  if (!result.pass) throw new Error(`${step}: ${result.failures.join('; ')}`)
}

// ---- the window ----------------------------------------------------------

/** A window-only capture of the Videorc main window (never the screen). */
async function capture(name) {
  const { windowId } = await command('main-window-id')
  const path = join(output, `${name}.png`)
  execFileSync('screencapture', ['-x', '-o', '-l', String(windowId), path])
  return path
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const raise = () => command('raise-window', { role: 'main', level: 'floating', focus: false })

// ---- the app -------------------------------------------------------------

async function stopApp() {
  backend?.close()
  backend = null
  if (app) await app.stop()
  app = null
  smoke = null
  lock?.release()
  lock = null
}

async function startApp(name, { raiseWindow = true } = {}) {
  await stopApp()
  profileName = name
  const profile = join(output, name)
  mkdirSync(profile, { recursive: true })
  lock = await requireAppRunLock({ lane: 'first-run-gpui' })
  appLines = []
  firstMountToMovingMs = null
  const startMs = Date.now()
  app = await launchDevApp({
    env: {
      VIDEORC_APP: 'gpui',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: profile,
      VIDEORC_SMOKE_OUTPUT_DIR: profile,
      VIDEORC_APP_DATA_DIR: join(profile, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(profile, 'user-data'),
      VIDEORC_DEV_BACKEND_PROFILE: 'debug',
      // Setup opens on its own: this smoke is the one that wants it.
      VIDEORC_SMOKE_SKIP_FIRST_RUN: '0',
      RUST_LOG: 'videorc_backend=info'
    },
    spawnSpec: {
      command: bins.app,
      args: ['--backend', bins.backend, '--workspace', repoRoot],
      cwd: repoRoot
    },
    timeoutMs: 180_000,
    requiredMarkers: ['preview-motion-ready', 'backend-ready'],
    onLine: (raw) => {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
      const emitted = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/.exec(line)
      appLines.push({ line, at: emitted ? Date.parse(emitted[0]) : Date.now() })
      appendFileSync(join(profile, 'app.log'), `${line}\n`)
    }
  })
  smoke = app.connections['preview-motion-ready']
  backend = await connectBackend(app.connections['backend-ready'], 60_000)
  await command('ui-appearance', { theme: 'dark', increaseContrast: null, reduceMotion: null })
  if (raiseWindow) await raise()
  report.launchedMs ??= {}
  report.launchedMs[name] = Date.now() - startMs
  return startMs
}

/** Waits until a profile's first-run setup is the thing on screen. */
async function waitForSetup() {
  return waitFor('setup open', (s) => s.setup === 'open', 30_000)
}

/**
 * Seeds UI settings, then relaunches the same profile: Electron's
 * `reloadWith` (seed the store, reload). `keys` hold JSON values or strings.
 */
async function relaunchWith(keys = {}, { dropKeys = [], theme = 'dark' } = {}) {
  const before = await frState()
  if (before.open && before.mode === 'first-run') await waitForPerformanceCheck('relaunch')
  const put = Object.fromEntries(
    Object.entries(keys).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value)
    ])
  )
  if (Object.keys(put).length || dropKeys.length) {
    await rpc('ui.settings.set', { put, delete: dropKeys })
  }
  const name = profileName
  const startMs = await startApp(name)
  if (theme === 'light') await command('ui-appearance', { theme: 'light' })
  return startMs
}

async function waitForPerformanceCheck(before) {
  const startedAt = Date.now()
  const deadline = startedAt + FIRST_RUN_SMOKE_LIMITS.performanceCheckSettleMs
  let last
  while (Date.now() < deadline) {
    const [performance, recording] = await Promise.all([
      rpc('performance.check.get'),
      rpc('recording.status')
    ])
    last = {
      running: performance.running,
      hasResult: performance.result !== undefined,
      recordingState: recording.state
    }
    // Electron's first-run setup starts the check as it opens (it never
    // skips one that is due), and GPUI does the same: if neither a verdict nor
    // a running check ever shows up, that is a named gap, not a pass.
    if (
      !performance.running &&
      performance.result === undefined &&
      performance.lastRunNotRecorded === undefined &&
      Date.now() - startedAt > 30_000 &&
      !appLines.some(({ line }) => /performance check started with setup/.test(line))
    ) {
      throw new Error(
        'GPUI first run has no performance check: setup never started one (Electron starts it as setup opens)'
      )
    }
    if (firstRunPerformanceCheckSettled({ check: performance, recording, completed: false })) {
      report.performanceCheckWaits ??= []
      report.performanceCheckWaits.push({ profile: profileName, before, ...last })
      return
    }
    await delay(250)
  }
  throw new Error(`performance check settle before ${before} timed out: ${JSON.stringify(last)}`)
}

// ---- controls (by accessible name) ---------------------------------------

/**
 * Setup is an overlay over the workspace, whose tree stays mounted beneath it
 * (the Studio has its own "Screen only", "Both", "Microphone gain"…): a name
 * the overlay shares with the page below is the LAST match in tree order,
 * which is the overlay's.
 */
async function lastMatch(label, role) {
  let tree = null
  for (let attempt = 0; attempt < 10 && !tree; attempt += 1) {
    try {
      tree = await command('ui-tree', main)
    } catch {
      await delay(500)
    }
  }
  let matches = 0
  const walk = (node) => {
    if (node.role === role && node.label === label) matches += 1
    for (const child of node.children ?? []) walk(child)
  }
  if (tree) walk(tree.tree ?? tree)
  return { ...main, label, role, index: Math.max(0, matches - 1) }
}

const press = async (label) => command('ui-click', await lastMatch(label, 'button'))

async function advance(step) {
  await press((await frState()).primary)
  return waitFor(
    step,
    (s) => s.cardStep === step && s.setup === 'open' && (s.record?.step === step || s.mode === 'replay')
  )
}

async function shotStep(theme) {
  // The step's cross-fade is short; capture the settled card.
  await delay(300)
  const s = await state()
  themeShots[theme].set(s.cardStep, await capture(`${theme}-${s.cardStep}`))
}

const appearance = (params) => command('ui-appearance', params)

/** A settled reading after a theme or media change. */
async function settled() {
  await delay(150)
  return state()
}

/** How long the tone takes to follow a theme change, on this process's clock. */
async function toneFlip(change, wantedTheme) {
  const start = performance.now()
  await change()
  let flipped = null
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const fr = await frState()
    if (fr.tone.theme === wantedTheme) {
      flipped = performance.now() - start
      break
    }
    await delay(10)
  }
  return { ...(await settled()), toneFlipMs: flipped }
}

// ---- the backdrop's motion -----------------------------------------------

async function motionSample(prefix = '') {
  const first = await capture(`${prefix}motion-first`)
  const a = await frState()
  const t0 = performance.now()
  await delay(2100)
  const b = await frState()
  const t1 = performance.now()
  const last = await capture(`${prefix}motion-last`)
  const drawCount =
    a.backdrop.presentedFrames === null || b.backdrop.presentedFrames === null
      ? null
      : b.backdrop.presentedFrames - a.backdrop.presentedFrames
  const durationMs = t1 - t0
  return {
    ...(await state()),
    durationMs,
    drawCount,
    drawFps: drawCount === null ? null : drawCount / (durationMs / 1000),
    // The rate and the count are the presented-frames counter's; two window
    // captures prove only that the pixels moved.
    frameCount: drawCount ?? 0,
    firstHash: digest(first),
    lastHash: digest(last),
    firstLastDiffer: digest(first) !== digest(last)
  }
}

// ---- the look and sound steps --------------------------------------------

async function committedLook() {
  const [scene, compositor] = await Promise.all([rpc('scene.get'), rpc('compositor.status')])
  return {
    committedLayout: compositor.sceneLayout?.layoutPreset,
    committedBackground: scene.background?.live?.id ?? null
  }
}

const BACKGROUND_IDS = {
  Silk: 'silk',
  'Side Rays': 'side-rays',
  'Liquid Chrome': 'liquid-chrome'
}

async function chooseLook(backgroundName = 'Silk') {
  const performanceCheck = await waitForPerformanceCheck('look')
  // A fresh profile has no screen or camera, so Look's layouts are all
  // disabled and the working scene refuses a background (it needs a screen).
  // The test pattern is the screen the smokes use; it starts no capture.
  await command('enable-synthetic-source', { settleMs: 600 })
  const initial = await waitFor(
    'look options',
    (s) => s.cardStep === 'look' && s.layoutOptions.length >= 4 && s.layoutOptions.some((o) => !o.disabled),
    15_000
  )
  const available = initial.layoutOptions.filter((option) => !option.disabled)
  const picked =
    available.find((option) => ['camera-only', 'screen-only'].includes(option.preset)) ??
    available[0]
  if (picked) {
    const label = (await frState()).layoutOptions.find((o) => o.preset === picked.preset).label
    await press(label)
  }
  await press(backgroundName)
  const wantedBackground = BACKGROUND_IDS[backgroundName]
  const deadline = Date.now() + 10_000
  let committed
  do {
    committed = await committedLook()
    const configRaw = (await settings(['videorc.captureConfig']))['videorc.captureConfig']
    const configLayout = parse(configRaw)?.layout?.layoutPreset
    if (
      committed.committedBackground === wantedBackground &&
      (!picked || (committed.committedLayout === picked.preset && configLayout === picked.preset))
    ) {
      break
    }
    await delay(100)
  } while (Date.now() < deadline)
  const observation = {
    ...(await state()),
    ...committed,
    background: wantedBackground,
    layout: picked?.preset ?? (await state()).layout,
    layoutClicked: picked?.preset ?? null,
    // The Look picture shows the chosen thumbnail, still: the backdrop behind
    // the card is the one that moves (see the header).
    picture: 'moving',
    performanceCheck
  }
  if (picked) {
    observation.layout = (await frState()).look.layoutPreset
    observation.layoutClicked = observation.layout
  }
  await check('look', observation)
  return { layout: observation.layout, background: wantedBackground }
}

async function soundCheck() {
  const fr = await waitFor('sound rows', (s) => s.cardStep === 'sound')
  const mic = (await frState()).rows.find((row) => row.id === 'microphone')
  const blocked = mic?.state !== 'granted'
  const before = fr.config?.audio?.microphoneGainDb
  let gainKeyPressed = false
  if (!blocked) {
    // Electron focuses the slider and presses an arrow key. The GPUI slider
    // takes no accessibility focus, so a pointer click on it focuses it (the
    // click lands on its middle, the default) and the arrow key then moves it.
    await command('ui-click', await lastMatch('Microphone gain', 'slider'))
    await delay(200)
    const key = before >= 24 ? 'ArrowLeft' : 'ArrowRight'
    await command('ui-key', { ...main, key })
    await waitFor(
      'Gain persisted',
      (next) => next.config?.audio?.microphoneGainDb !== before,
      10_000
    )
    gainKeyPressed = true
  }
  await check('sound', {
    ...(await state()),
    microphoneGrant: mic?.state,
    soundBlocked: blocked,
    soundMicrophoneRow: await present('Microphone', 'combo-box'),
    soundSystemAudioRow: await present('System audio', 'switch'),
    soundMeter: await present('Microphone gain', 'slider'),
    gainBefore: before,
    gainKeyPressed
  })
}

async function destinations() {
  const rows = []
  for (const [platform, name] of [
    ['youtube', 'YouTube'],
    ['twitch', 'Twitch'],
    ['kick', 'Kick'],
    ['x', 'X']
  ]) {
    // Signed out: a Sign in… button, or the row's note that signing in "isn't
    // available in this build" (no OAuth credentials). Static text is not in
    // the accessibility tree; the row's platform mark is, so a row with its
    // mark and no button is the unavailable one (a connected one would show
    // an account, and a fresh profile has none).
    const hasRow = await present(name, 'image')
    const signIn = await present(`${name}: Sign in…`)
    rows.push({
      platform,
      state: hasRow ? 'not-connected' : 'missing',
      signIn,
      unavailable: hasRow && !signIn
    })
  }
  await check('destinations', {
    ...(await state()),
    destinationRows: rows,
    streamKeyAction: (await present('Open Destinations')) ? 'Open Destinations' : null
  })
}

// ---- no source starts while setup is open --------------------------------

async function previewSnapshot() {
  const [camera, screen] = await Promise.all([
    rpc('preview.camera.status'),
    rpc('preview.screen.status')
  ])
  const summarize = (status) => ({
    state: status.state,
    id: status.cameraId ?? status.sourceId ?? null,
    framesCaptured: status.framesCaptured
  })
  return { camera: summarize(camera), screen: summarize(screen) }
}
const previewQuiet = (snapshot) =>
  Object.values(snapshot).every(
    (status) => !['starting', 'live'].includes(status.state) && status.framesCaptured === 0
  )
const samePreviewSources = (before, after) =>
  ['camera', 'screen'].every(
    (kind) =>
      !['starting', 'live'].includes(after[kind].state) ||
      (before[kind].id !== null &&
        before[kind].id === after[kind].id &&
        before[kind].state === after[kind].state)
  )

async function beginGuard(startMs, allowExistingSources = true) {
  const previewAtOpen = await previewSnapshot()
  guard = {
    startMs: startMs ?? Date.now(),
    previewAtOpen,
    allowExistingSources,
    previewIdleAtOpen: previewQuiet(previewAtOpen)
  }
}

async function finishGuard() {
  const endMs = Date.now()
  const lines = appLines
    .filter(({ at }) => at >= guard.startMs && at <= endMs)
    .map(({ line }) => line)
  await check('no-device-starts', {
    ...guard,
    endMs,
    closedObserved: true,
    backendReady: true,
    patterns: FIRST_RUN_SOURCE_START_PATTERNS,
    matches: firstRunSourceStartLines(lines)
  })
  guard = null
}

async function leave(label) {
  guard.previewBeforeLeave = await previewSnapshot()
  guard.previewIdleBeforeLeave = previewQuiet(guard.previewBeforeLeave)
  guard.previewIdentityUnchanged = samePreviewSources(guard.previewAtOpen, guard.previewBeforeLeave)
  await press(label)
  await waitFor('workspace after setup', (s) => s.setup === null)
  await finishGuard()
}

// ---- the flow ------------------------------------------------------------

async function replay() {
  await command('open-tab', { tab: 'settings', subTab: 'general' })
  const before = await state()
  await beginGuard()
  // The button sits below the window's fold on Settings → General: scroll the
  // page, a notch at a time, until the click can reach it.
  for (let notch = 0; ; notch += 1) {
    try {
      await command('ui-click', { ...main, id: 'replay-setup' })
      break
    } catch (error) {
      if (!/outside the window|scroll it into view/.test(String(error?.message)) || notch >= 12) {
        throw error
      }
      await command('ui-scroll', { ...main, dy: 300 })
      await delay(250)
    }
  }
  await check('replay-open', {
    ...(await waitFor('replay permissions', (s) => s.mode === 'replay' && s.rows.length === 4 && !s.loading, 30_000)),
    beforeRecordRaw: before.recordRaw
  })
  const visitedSteps = ['permissions']
  await capture('replay-permissions')
  await advance('goal')
  visitedSteps.push('goal')
  await press('Both')
  await waitFor('replay look', (s) => s.cardStep === 'look')
  visitedSteps.push('look')
  await advance('sound')
  visitedSteps.push('sound')
  await advance('destinations')
  visitedSteps.push('destinations')
  await shotStep('dark')
  await destinations()
  const pressedPrimary = (await frState()).primary
  await leave(pressedPrimary)
  await check('replay-return', {
    ...(await waitFor('return to Settings', (s) => s.setup === null)),
    beforeRecordRaw: before.recordRaw,
    beforeConfigRaw: before.configRaw,
    visitedSteps,
    pressedPrimary,
    settingsGeneral: true
  })
}

async function setupProfiles() {
  // Profile 1: Recordings, dark.
  const startMs = await startApp('recordings')
  await check('fresh', await waitForSetup())
  await beginGuard(startMs, false)
  await check(
    'moving',
    await waitFor('moving backdrop', (s) => ['moving', 'still'].includes(s.backdrop), 5000)
  )
  await shotStep('dark')
  await check('motion', await motionSample())
  await appearance({ reduceMotion: true })
  await check('reduced-motion', await waitFor('reduced motion still', (s) => s.backdrop === 'still'))
  await capture('reduced-motion')
  await appearance({ reduceMotion: null })
  await check(
    'moving',
    await waitFor(
      'motion restored',
      (s) => ['moving', 'still'].includes(s.backdrop) && s.reason !== 'reduced-motion'
    )
  )

  // Plan 208 S5: light turns the chrome around; more contrast deepens Dim.
  await check('tone', await settled())
  await appearance({ increaseContrast: true })
  await check('tone', await settled())
  await capture('dark-more-contrast')
  await appearance({ increaseContrast: null })
  await check('tone', await toneFlip(() => appearance({ theme: 'light' }), 'light'))
  await capture('light-moving')
  await check('motion', await motionSample('light-'))
  await appearance({ theme: 'light', increaseContrast: true })
  await check('tone', await settled())
  await capture('light-more-contrast')
  await appearance({ theme: 'light', increaseContrast: null, reduceMotion: true })
  await check(
    'reduced-motion',
    await waitFor('light reduced motion still', (s) => s.backdrop === 'still')
  )
  await check('tone', await settled())
  await capture('light-still')
  await appearance({ theme: 'light', reduceMotion: null })
  await check(
    'moving',
    await waitFor(
      'light motion restored',
      (s) => ['moving', 'still'].includes(s.backdrop) && s.reason !== 'reduced-motion'
    )
  )
  await check('tone', await toneFlip(() => appearance({ theme: 'dark' }), 'dark'))

  await check('goal', await advance('goal'))
  await shotStep('dark')
  await press('Recordings')
  // The record is written a moment after the step changes (the app saves it
  // off the UI thread): the gate reads it once it has landed.
  await check(
    'record-look',
    await waitFor(
      'Recordings look',
      (s) => s.cardStep === 'look' && s.record?.step === 'look' && s.record?.goal === 'record'
    )
  )
  const chosen = await chooseLook('Silk')
  await shotStep('dark')
  skip('look-motion', 'the GPUI Look step shows still thumbnails: one backdrop player runs')
  await advance('sound')
  await soundCheck()
  await shotStep('dark')
  const beforeResume = await state()
  // Resume: relaunch the profile mid-setup (Electron reloads the renderer).
  await relaunchWith()
  await check('resume', {
    ...(await waitFor('sound resume', (s) => s.cardStep === 'sound' && s.configRaw)),
    expectedStep: 'sound',
    beforeConfig: beforeResume.config,
    beforeBackground: beforeResume.registry.live.activeId
  })
  await waitFor('resumed backdrop frame', (s) => s.backdrop === 'moving')
  const pressedPrimary = (await frState()).primary
  await beginGuard()
  await leave(pressedPrimary)
  await check('finish', { ...(await state()), pressedPrimary })
  const watchStart = Date.now()
  await delay(FIRST_RUN_SMOKE_LIMITS.clipsWatchMs + 100)
  await check('workspace-look', {
    ...(await state()),
    ...(await committedLook()),
    chosenLayout: chosen.layout,
    chosenBackground: chosen.background,
    watchMs: Date.now() - watchStart,
    refusedStarts: appLines
      .filter(({ line }) => line.includes('Session start refused'))
      .map(({ line }) => line)
  })
  await capture('studio-chosen-look')
  const finishedRecord = (await state()).recordRaw
  await relaunchWith()
  await check('reload', { ...(await state()), beforeRecordRaw: finishedRecord })
  await replay()
  await check('theme-walk', {
    ...(await state()),
    expectedTheme: 'dark',
    visitedSteps: allSteps,
    screenshots: allSteps.map((step) => themeShots.dark.get(step))
  })

  // An old What's New marker alone migrates an existing install.
  await relaunchWith({ 'videorc.whatsNewLastSeenVersion': '999.0.0' }, { dropKeys: ['videorc.firstRun'] })
  await check('existing-install', await waitFor('existing install', (s) => s.recordRaw !== null))
  const resumeRecord = {
    version: 1,
    status: 'in-progress',
    step: 'permissions',
    updatedAt: new Date().toISOString()
  }
  // Electron's seed replaces the whole store: the old What's New marker goes
  // with the migration it caused, so a resumed record is not an existing install.
  await relaunchWith(
    { 'videorc.firstRun': resumeRecord },
    { dropKeys: ['videorc.whatsNewLastSeenVersion'] }
  )
  await beginGuard()
  await check('resume', await waitFor('legacy resumed rows', (s) => s.setup === 'open' && s.rows.length === 4 && !s.loading, 30_000))
  await waitFor('legacy resumed motion', (s) => s.backdrop === 'moving')
  await leave('Skip setup')
  await check('finish', { ...(await state()), pressedPrimary: 'Skip setup' })
  skip('whats-new', "GPUI shows no What's New dialog over setup at launch")

  // Profile 2: Livestreams, light.
  await startApp('livestreams')
  await command('ui-appearance', { theme: 'light' })
  await waitForSetup()
  await check(
    'moving',
    await waitFor('light moving backdrop', (s) => ['moving', 'still'].includes(s.backdrop), 5000)
  )
  const lightOpen = await settled()
  await check('tone', { ...lightOpen, tonesSeen: [lightOpen.tone] })
  await capture('light-fresh')
  await shotStep('light')
  await check('goal', await advance('goal'))
  await shotStep('light')
  await press('Livestreams')
  await waitFor('Livestreams look', (s) => s.cardStep === 'look' && s.position === '3/5')
  await chooseLook('Side Rays')
  await shotStep('light')
  await advance('sound')
  await soundCheck()
  await shotStep('light')
  await advance('destinations')
  await shotStep('light')
  await destinations()
  await check('theme-walk', {
    ...(await state()),
    expectedTheme: 'light',
    visitedSteps: allSteps,
    screenshots: allSteps.map((step) => themeShots.light.get(step))
  })
  await beginGuard()
  await leave('Open Destinations')
  await check('livestream', {
    ...(await waitFor('Destinations Setup', (s) => s.setup === null)),
    // The GPUI Destinations page has no Setup sub-tab (Setup is the page's own
    // view): the page is the one the window's title names.
    livestreamSetup: /^Destinations/.test(await windowTitle())
  })
  await capture('livestream-setup')

  // Profile 3: skipping from Look keeps the choices.
  await startApp('skip-look')
  await waitForSetup()
  await advance('goal')
  await press('Both')
  await waitFor('skip profile look', (s) => s.cardStep === 'look')
  await chooseLook('Silk')
  const beforeSkip = await state()
  await beginGuard()
  await leave('Skip setup')
  await check('skip-look', {
    ...(await state()),
    beforeConfigRaw: beforeSkip.configRaw,
    beforeRegistryRaw: beforeSkip.registryRaw
  })

  skip('launch-quiet', 'the owner-launch reports are injected into renderer modules (no GPUI hook)')
}

try {
  console.log(`First-run smoke (GPUI) output: ${output}`)
  await setupProfiles()
  report.pass = true
  console.log('PASS first-run smoke (GPUI)')
} catch (error) {
  report.pass = false
  report.error = error.stack ?? String(error)
  try {
    if (smoke) await capture('failure')
  } catch {
    /* The app may have exited. */
  }
  console.error(`FAIL first-run smoke (GPUI): ${error.message}`)
  process.exitCode = 1
} finally {
  await stopApp()
  save()
  console.log(`Report: ${join(output, 'report.json')}`)
}
