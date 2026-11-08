// Plan 212 S1: a performance check never shows up in the Studio Preview.
//
// The dev app runs with production frame polling (no VIDEORC_SMOKE_PREVIEW_MOTION)
// on an isolated profile, with a program that is a known, non-synthetic
// picture: the real screen (ScreenCaptureKit) under four solid-colour banners
// at known places, shown on stream and in recordings alike. The backend
// refuses every landscape scene without a screen or camera
// (`preset_selection_blocker`), and the only grant-free base is the test
// pattern itself, so a non-synthetic program needs the Screen Recording
// grant; without it the whole smoke SKIPs and names the grant. The check starts the
// way the app starts it (the renderer's requestPerformanceCheck, through the
// DEV-only smoke hook), so the Clips stop and re-arm and the renderer's scene
// reads are in play. VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT makes
// at least two rungs run, so there is a rung hand-over.
//
// While it runs, the smoke reads the frame main is handed for the Preview
// through the backend's lease-free dev oracle (`preview.debug.sample`, which
// reads `presented_frame_store` and takes no Preview lease), from 2 s before
// the check until 3 s after `performance.check.completed`, and names every
// way the check became visible or left a mark:
//
//   synthetic-frame-presented   a presented frame carries the synthetic
//                               frame-number strip (scripts/lib/synthetic-frame-strip.mjs)
//   preview-not-program         a presented frame is not the user's picture
//   test-pattern-scene-source   compositor.status lists a test-pattern source
//   scene-changed               scene.get differs before and after (revisions ignored)
//   renderer-visual-changed     the renderer's working visual or saved scenes changed
//   preview-not-back            the program is not back 1 s after completion
//   watchdog-healed             main's [first-frame] / [preview-watch] healed during the check
//   recording-missing           (Record pass) no recording was written
//   recording-first-frame-synthetic (Record pass) the file's first frame is synthetic
//
// Passes: Clips on; Clips off; Clips on with Record pressed during rung 2.
// Every pass is evaluated so one run names every failure.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { acquireHostSmokeLock, waitForHostMemory } from './lib/host-lock.mjs'
import { reloadKeepingSeedJs } from './lib/renderer-profile-seed.mjs'
import { scenePresetStateReadCode } from './lib/scene-presets-smoke-state.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  decodeSyntheticStrip,
  meanRectsRgb24,
  syntheticStripRects
} from './lib/synthetic-frame-strip.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

assert.equal(process.platform, 'darwin', 'The Preview check smoke requires the macOS dev app')
delete process.env.ELECTRON_RUN_AS_NODE
const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-preview-check-invisible-'))
const userDataDir = join(outputDirectory, 'profile')
mkdirSync(userDataDir)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = 120_000
const verbose = process.env.VIDEORC_SMOKE_VERBOSE === '1'
// Every rung taller than this fails, so the ladder steps down at least once
// under any display ceiling (1080p60 is the first rung that passes).
const forceFailAboveHeight = process.env.VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT ?? '1080'
const LEAD_MS = 2000
const TAIL_MS = 3000
const BACK_WITHIN_MS = 1000
const video = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }
const layout = {
  layoutPreset: 'screen-only',
  cameraTransformMode: 'preset',
  cameraTransform: null,
  cameraCorner: 'bottom-right',
  cameraSize: 'medium',
  cameraShape: 'rectangle',
  cameraMargin: 32,
  cameraFit: 'fill',
  cameraMirror: false,
  cameraZoom: 100,
  cameraOffsetX: 0,
  cameraOffsetY: 0,
  sideBySideSplit: '70-30',
  sideBySideCameraSide: 'right'
}
// The program: four solid banners over the screen, shown on stream and in
// recordings, so the picture is the same at idle, with Clips, and recording.
const programRects = [
  { x: 0.05, y: 0.08, w: 0.4, h: 0.08 },
  { x: 0.05, y: 0.3, w: 0.12, h: 0.213333 },
  { x: 0.35, y: 0.3, w: 0.12, h: 0.213333 },
  { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }
]
const programColours = [
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 0],
  [32, 32, 32]
]
const programLabels = ['magenta', 'cyan', 'yellow', 'dark']
const programFixtures = ['magenta', 'cyan', 'yellow', '0x202020']
let screenId = null
let programSize = null
const stripRects = syntheticStripRects()
const oracleRects = [...stripRects, ...programRects]
const near = (rgb, target) => rgb.every((v, i) => Math.abs(v - target[i]) < 65)
const programMismatch = (samples) =>
  samples
    .map((rgb, i) => (near(rgb, programColours[i]) ? null : `${programLabels[i]}=${fmt(rgb)}`))
    .filter(Boolean)
const fmt = (rgb) => `[${rgb.map((v) => Math.round(v)).join(',')}]`
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const logs = []
const events = []
const failures = []
const passRows = []
const evidence = {}
let launch, ws, smoke
let skipped = false
const rpc = (method, params = {}) => request(ws, timeoutMs, method, params)
const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })
const evaluate = async (code, params = {}) => {
  const response = await command('eval-js', { ...params, code })
  return response?.result ?? response
}
const rendererState = () => evaluate(scenePresetStateReadCode)
const log = (line) => console.log(`[preview-check-invisible] ${line}`)
function fail(pass, name, detail) {
  failures.push({ pass, name, detail })
  console.log(`FAIL ${name} [${pass}]: ${detail}`)
}

/** Deep copy without any key that names a revision (they may advance). */
function withoutRevisions(value) {
  if (Array.isArray(value)) return value.map(withoutRevisions)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/revision/i.test(key))
        .map(([key, nested]) => [key, withoutRevisions(nested)])
    )
  }
  return value
}
const same = (a, b) => JSON.stringify(withoutRevisions(a)) === JSON.stringify(withoutRevisions(b))

function diffSummary(before, after) {
  const a = withoutRevisions(before)
  const b = withoutRevisions(after)
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  const changed = [...keys].filter((key) => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]))
  if (!changed.length) return ''
  const details = changed
    .map((key) => `${key}: ${JSON.stringify(a?.[key])} -> ${JSON.stringify(b?.[key])}`)
    .join('; ')
  return `changed keys [${changed.join(', ')}]: ${details.slice(0, 700)}`
}

async function setReplay(armed) {
  const switched = await evaluate(
    `return window.__videorcSmokeSetReplayBuffer?.(${armed}, 30) ?? null`
  )
  assert.equal(switched, true, 'the maintained renderer Clips hook must be available')
  const until = Date.now() + 30_000
  let ring
  do {
    ring = await rpc('replay.status')
    if (ring.state === (armed ? 'on' : 'off') && (!armed || ring.replayOnly)) return ring
    await sleep(100)
  } while (Date.now() < until)
  assert.fail(`Clips switch did not settle: ${JSON.stringify(ring)}`)
}

async function importBanner(path) {
  const cap = await command('authorize-smoke-resource', { path, kind: 'input-file' })
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc('banners.importImage', { sourceCapability: cap.capabilityId })
    } catch (error) {
      if (attempt >= 20 || !/already being imported/.test(error?.message ?? '')) throw error
      await sleep(100)
    }
  }
}

function createPng(outputPath, source) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      'format=rgba',
      outputPath
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`Could not create ${outputPath}: ${result.stderr}`)
}

/** One oracle read: the strip verdict and the program mismatch list. */
async function sampleOnce() {
  const at = Date.now()
  try {
    const frame = await rpc('preview.debug.sample', { rects: oracleRects })
    const cells = frame.samples.slice(0, stripRects.length)
    const program = frame.samples.slice(stripRects.length).map(({ r, g, b }) => [r, g, b])
    return {
      at,
      frameId: frame.frameId,
      size: `${frame.width}x${frame.height}`,
      strip: decodeSyntheticStrip(cells),
      mismatch: programMismatch(program),
      program
    }
  } catch (error) {
    return { at, error: error.message }
  }
}

/** Wait until the oracle shows the program, or return the last read. */
async function waitForProgram(deadlineMs) {
  const until = Date.now() + deadlineMs
  let last
  do {
    last = await sampleOnce()
    if (!last.error && last.mismatch.length === 0) return last
    await sleep(50)
  } while (Date.now() < until)
  return last
}

/** The user's idle scene, committed through the backend's own idle path. */
async function applyProgramScene() {
  await rpc('scene.layout.apply_preview', { sources: { screenId }, layout, video })
}

const recordingStatusEvents = []
function onEvent(message) {
  if (typeof message.event !== 'string') return
  const record = { event: message.event, payload: message.payload, receivedAt: Date.now() }
  events.push(record)
  if (message.event === 'recording.status') {
    recordingStatusEvents.push({ ...message.payload, receivedAt: record.receivedAt })
  }
}
function waitForEvent(name, predicate = () => true, deadlineMs = timeoutMs) {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`timed out waiting for ${name}`))
    }, deadlineMs)
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.event === name && predicate(message.payload)) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolveEvent({ payload: message.payload, at: Date.now() })
      }
    }
    ws.addEventListener('message', handler)
  })
}

/** First frame of a recording, judged like a presented frame. */
function firstRecordedFrame(path) {
  const width = 640
  const height = 360
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height},format=rgb24`,
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 }
  )
  if (result.status !== 0 || result.stdout.length < width * height * 3) {
    throw new Error(
      `Could not decode the first frame of ${path}: ${result.stderr?.toString() ?? ''}`
    )
  }
  const cells = meanRectsRgb24(result.stdout, width, height, stripRects)
  const program = meanRectsRgb24(result.stdout, width, height, programRects)
  return { strip: decodeSyntheticStrip(cells), mismatch: programMismatch(program), program }
}

/**
 * One pass: Clips as asked, the check started the way the app starts it,
 * the Preview read on every tick from 2 s before until 3 s after completion.
 */
async function runPass({ name, clips, record = false }) {
  log(`pass "${name}": Clips ${clips ? 'on' : 'off'}${record ? ', Record during rung 2' : ''}`)
  const notes = []
  await setReplay(clips)
  const baseline = await waitForProgram(10_000)
  if (baseline.error || baseline.mismatch.length) {
    fail(
      name,
      'setup',
      `the Preview did not show the program before the check: ${baseline.error ?? baseline.mismatch.join(' ')}`
    )
    passRows.push({ pass: name, result: 'FAIL', failures: 'setup' })
    return
  }
  const sceneBefore = await rpc('scene.get')
  const rendererBefore = await rendererState()
  const samples = []
  const statuses = []
  let sampling = true
  const sampler = (async () => {
    let tick = 0
    while (sampling) {
      samples.push(await sampleOnce())
      if (tick++ % 4 === 0) {
        try {
          const status = await rpc('compositor.status')
          statuses.push({
            at: Date.now(),
            kinds: (status.sceneSources ?? []).map((source) => source.kind),
            sceneRevision: status.sceneRevision ?? null,
            framesRendered: status.framesRendered
          })
        } catch (error) {
          statuses.push({ at: Date.now(), error: error.message })
        }
      }
      await sleep(20)
    }
  })()
  await sleep(LEAD_MS)
  const logMark = logs.length
  const progress = []
  const progressListener = (event) => {
    const message = JSON.parse(event.data)
    if (message.event === 'performance.check.progress') {
      progress.push({ ...message.payload, at: Date.now() })
    }
  }
  ws.addEventListener('message', progressListener)
  const completed = waitForEvent('performance.check.completed', () => true, 100_000)
  completed.catch(() => {})
  const startedAt = Date.now()
  let recordingOutcome = null
  const recordTask = record
    ? (async () => {
        // Rung 2 begins: press Record through the app's own start path.
        const until = Date.now() + 60_000
        while (!progress.some((p) => p.rungIndex >= 1) && Date.now() < until) await sleep(25)
        if (!progress.some((p) => p.rungIndex >= 1)) return { error: 'rung 2 never started' }
        const pressedAt = Date.now()
        // Listen before the press: the renderer's start resolves after the
        // session already runs, so the event would otherwise be missed.
        const livePromise = waitForEvent(
          'recording.status',
          (payload) => payload.state === 'recording' && !payload.replayOnly,
          30_000
        )
        livePromise.catch(() => {})
        const started = await evaluate(
          'await window.__videorcSmokeScenePresets.start(); return window.__videorcSmokeScenePresets.state().recording'
        ).catch((error) => ({ error: error.message }))
        let live
        let stopRequestedAt
        try {
          live = await livePromise
          await sleep(3000)
        } catch (error) {
          return { pressedAt, started, error: error.message }
        } finally {
          // Always let go of the session, or the next pass cannot switch Clips.
          stopRequestedAt = Date.now()
          await evaluate('await window.__videorcSmokeScenePresets.stop(); return true').catch(
            () => null
          )
          await waitForEvent(
            'recording.status',
            (payload) => payload.state === 'idle',
            60_000
          ).catch(() => null)
        }
        const path = await resolveFinalRecordingPath({
          started: { sessionId: live.payload.sessionId, outputPath: live.payload.outputPath },
          stopped: { sessionId: live.payload.sessionId },
          recordingStatusEvents,
          stopRequestedAt,
          timeoutMs: 60_000
        })
        return { pressedAt, startedAt: live.at, sessionId: live.payload.sessionId, path }
      })()
    : null
  try {
    await evaluate('await window.__videorcSmokeScenePresets.checkComputer(); return true')
  } catch (error) {
    fail(name, 'setup', `requestPerformanceCheck failed: ${error.message}`)
  }
  let done
  try {
    done = await completed
  } catch (error) {
    fail(name, 'check-never-completed', error.message)
  }
  if (recordTask) recordingOutcome = await recordTask
  const completedAt = done?.at ?? Date.now()
  await sleep(TAIL_MS)
  sampling = false
  await sampler
  ws.removeEventListener('message', progressListener)
  const checkLogs = logs.slice(logMark)
  const windowStart = startedAt - LEAD_MS
  const windowEnd = completedAt + TAIL_MS
  const inWindow = samples.filter((s) => s.at >= windowStart && s.at <= windowEnd)
  const read = inWindow.filter((s) => !s.error)
  const unread = inWindow.filter((s) => s.error)
  const rungs = progress.map((p) => `${p.video?.width}x${p.video?.height}@${p.video?.fps}`)
  notes.push(
    `rungs: ${rungs.join(' -> ') || 'none'}; ${read.length} frames read, ${unread.length} reads without a frame, check ${((completedAt - startedAt) / 1000).toFixed(1)} s`
  )
  if (progress.length < 2) {
    notes.push(
      `only ${progress.length} rung(s) ran; VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT=${forceFailAboveHeight}`
    )
  }

  const synthetic = read.filter((s) => s.strip.synthetic)
  if (synthetic.length) {
    const first = synthetic[0]
    fail(
      name,
      'synthetic-frame-presented',
      `${synthetic.length} of ${read.length} presented frames carry the synthetic strip; first sequence ${first.strip.sequence} at +${((first.at - startedAt) / 1000).toFixed(2)} s (frame ${first.frameId}, ${first.size}), last at +${((synthetic.at(-1).at - startedAt) / 1000).toFixed(2)} s`
    )
  }
  // Not the program: a sampled banner is missing or the wrong colour. The
  // frame's size is only a note: the Preview presents the ring's run at the
  // output size with Clips on, and its own size at idle.
  const notProgram = read.filter((s) => s.mismatch.length)
  if (notProgram.length) {
    const first = notProgram[0]
    fail(
      name,
      'preview-not-program',
      `${notProgram.length} of ${read.length} presented frames are not the program; first at +${((first.at - startedAt) / 1000).toFixed(2)} s (${first.mismatch.join(' ')}), last at +${((notProgram.at(-1).at - startedAt) / 1000).toFixed(2)} s (${notProgram.at(-1).mismatch.join(' ')})`
    )
  }
  const sizes = new Map()
  for (const s of read) sizes.set(s.size, (sizes.get(s.size) ?? 0) + 1)
  notes.push(
    `presented frame sizes: ${[...sizes].map(([size, n]) => `${size} x${n}`).join(', ')} (program at baseline ${programSize})`
  )
  const testPattern = statuses.filter(
    (s) => s.at >= startedAt && s.at <= completedAt + TAIL_MS && s.kinds?.includes('test-pattern')
  )
  if (testPattern.length) {
    fail(
      name,
      'test-pattern-scene-source',
      `compositor.status listed a test-pattern source in ${testPattern.length} of ${statuses.filter((s) => s.at >= startedAt && s.at <= completedAt + TAIL_MS).length} polls; first at +${((testPattern[0].at - startedAt) / 1000).toFixed(2)} s, kinds ${JSON.stringify(testPattern[0].kinds)}`
    )
  }
  const sceneAfter = await rpc('scene.get')
  if (!same(sceneBefore, sceneAfter)) {
    fail(
      name,
      'scene-changed',
      `scene.get differs after the check: ${diffSummary(sceneBefore, sceneAfter)}`
    )
  }
  const rendererAfter = await rendererState()
  if (
    !same(rendererBefore.visual, rendererAfter.visual) ||
    !same(rendererBefore.scenes, rendererAfter.scenes)
  ) {
    fail(
      name,
      'renderer-visual-changed',
      `working visual: ${diffSummary(rendererBefore.visual, rendererAfter.visual) || 'same'}; saved scenes: ${diffSummary({ scenes: rendererBefore.scenes }, { scenes: rendererAfter.scenes }) || 'same'}`
    )
  }
  if (
    rendererAfter.visual?.sources?.testPattern === true &&
    rendererBefore.visual?.sources?.testPattern !== true
  ) {
    notes.push('the renderer adopted sources.testPattern = true')
  }
  // Back on the program within 1 s of completion: every later read is the
  // program (banners, no strip) and the scene no longer carries a
  // test-pattern source.
  const afterBack = inWindow.filter((s) => s.at >= completedAt + BACK_WITHIN_MS)
  const notBack = afterBack.filter((s) => s.error || s.mismatch.length || s.strip?.synthetic)
  const patternAfter = statuses.filter(
    (s) => s.at >= completedAt + BACK_WITHIN_MS && s.kinds?.includes('test-pattern')
  )
  if (done && (afterBack.length === 0 || notBack.length || patternAfter.length)) {
    const first = notBack[0]
    const detail = []
    if (afterBack.length === 0) detail.push('no Preview read after completion + 1 s')
    if (notBack.length)
      detail.push(
        `${notBack.length} of ${afterBack.length} reads after completion + 1 s are not the program; first ${first.error ?? [...first.mismatch, first.strip?.synthetic ? `synthetic strip ${first.strip.sequence}` : null].filter(Boolean).join(' ')} at +${((first.at - completedAt) / 1000).toFixed(2)} s after completion, last at +${((notBack.at(-1).at - completedAt) / 1000).toFixed(2)} s`
      )
    if (patternAfter.length)
      detail.push(
        `the scene still carried a test-pattern source in ${patternAfter.length} status poll(s) after completion + 1 s (last at +${((patternAfter.at(-1).at - completedAt) / 1000).toFixed(2)} s)`
      )
    fail(name, 'preview-not-back', detail.join('; '))
  }
  const healed = checkLogs.filter((line) => /\[(first-frame|preview-watch)\] healing/.test(line))
  if (healed.length) {
    fail(
      name,
      'watchdog-healed',
      `${healed.length} healing line(s) while the check ran; first: ${healed[0].replace(/^.*?\[backend:\w+\]\s*/, '').slice(0, 200)}`
    )
  }
  if (record) {
    if (!recordingOutcome?.path || !existsSync(recordingOutcome.path)) {
      fail(
        name,
        'recording-missing',
        `no recording was written: ${JSON.stringify(recordingOutcome)}`
      )
    } else {
      try {
        const first = firstRecordedFrame(recordingOutcome.path)
        evidence[`${name} recording first frame`] = { path: recordingOutcome.path, ...first }
        if (first.strip.synthetic) {
          fail(
            name,
            'recording-first-frame-synthetic',
            `${recordingOutcome.path}: first frame carries the synthetic strip (sequence ${first.strip.sequence})`
          )
        } else if (first.mismatch.length) {
          notes.push(`recording first frame is not the program either: ${first.mismatch.join(' ')}`)
        }
        notes.push(
          `recording ${recordingOutcome.path}, Record pressed +${((recordingOutcome.pressedAt - startedAt) / 1000).toFixed(2)} s`
        )
      } catch (error) {
        fail(
          name,
          'recording-first-frame-synthetic',
          `could not judge the first frame: ${error.message}`
        )
      }
    }
  }
  evidence[name] = {
    startedAt,
    completedAt,
    progress,
    notes,
    samples: inWindow.map((s) => ({
      at: s.at - startedAt,
      frameId: s.frameId,
      size: s.size,
      error: s.error,
      synthetic: s.strip?.synthetic,
      sequence: s.strip?.sequence,
      mismatch: s.mismatch,
      program: s.program?.map(fmt)
    })),
    statuses: statuses.map((s) => ({ ...s, at: s.at - startedAt })),
    checkLogs,
    recordingOutcome
  }
  for (const note of notes) log(`${name}: ${note}`)
  const named = failures.filter((f) => f.pass === name).map((f) => f.name)
  passRows.push({
    pass: name,
    result: named.length ? 'FAIL' : 'PASS',
    failures: [...new Set(named)].join(', ')
  })
  // Put the program back for the next pass, whatever the check left behind.
  await setReplay(false)
  await applyProgramScene()
  const restored = await waitForProgram(10_000)
  if (restored.error || restored.mismatch.length) {
    log(
      `${name}: the program did not come back after the pass (${restored.error ?? restored.mismatch.join(' ')}); reapplying`
    )
    await applyProgramScene()
    await waitForProgram(10_000)
  }
}

try {
  await acquireHostSmokeLock({ log })
  await waitForHostMemory({ log })
  launch = await launchDevApp({
    env: {
      // The command server without VIDEORC_SMOKE_PREVIEW_MOTION: frame
      // polling and main's first-frame watchdog run as in a production build,
      // and the renderer keeps the user's own sources.
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
      VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT: forceFailAboveHeight
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      logs.push(`${new Date().toISOString()} ${stripVTControlCharacters(line)}`)
      if (verbose) console.log(line)
    }
  })
  smoke = launch.connections['preview-motion-ready']
  ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  ws.addEventListener('message', (event) => {
    try {
      onEvent(JSON.parse(event.data))
    } catch {
      // not JSON
    }
  })
  const oracleProbe = await rpc('preview.debug.sample', { rects: [programRects[3]] }).catch(
    (error) => ({ error: error.message })
  )
  if (/preview-debug-disabled|refused in packaged/.test(oracleProbe.error ?? '')) {
    throw new Error(
      'preview.debug.sample is disabled: the oracle needs the debug backend (cargo build -p videorc-backend, no --release)'
    )
  }
  // The program needs the real screen (see the header): SKIP by name without it.
  const devices = await rpc('devices.list', { ffmpegPath })
  const grantMissing = (devices.devices ?? []).find(
    (device) =>
      (device.kind === 'screen' || device.kind === 'window') &&
      device.status === 'permission-required' &&
      String(device.id).includes('screencapturekit')
  )
  const screen = (devices.devices ?? []).find(
    (device) =>
      device.kind === 'screen' &&
      device.status === 'available' &&
      String(device.id).includes('screencapturekit')
  )
  if (grantMissing || !screen) {
    const reason = grantMissing
      ? `the dev app has no Screen Recording grant on this host (${grantMissing.detail ?? grantMissing.id})`
      : 'no available ScreenCaptureKit screen on this host'
    console.log(`SKIP preview-check-invisible: ${reason}`)
    passRows.push({ pass: 'all', result: 'SKIP', failures: reason })
    skipped = true
  } else {
    screenId = screen.id
    await runAll()
  }
} catch (error) {
  console.error(error.stack)
  failures.push({ pass: 'harness', name: 'harness', detail: error.message })
} finally {
  console.table(passRows)
  if (failures.length) {
    console.log('Named failures:')
    for (const failure of failures)
      console.log(`  ${failure.name} [${failure.pass}]: ${failure.detail}`)
  }
  writeFileSync(
    join(outputDirectory, 'evidence.json'),
    JSON.stringify(
      {
        passRows,
        failures,
        evidence,
        events: events.filter((e) => /performance|recording\.status/.test(e.event)),
        logs
      },
      null,
      2
    )
  )
  console.log(`Preview check evidence: ${outputDirectory}`)
  if (ws) {
    await rpc('session.stop').catch(() => {})
    ws.close()
  }
  await launch?.stop()
  console.log(
    failures.length
      ? `preview-check-invisible: FAIL (${failures.length} named failure(s))`
      : skipped
        ? 'preview-check-invisible: SKIP'
        : 'preview-check-invisible: PASS'
  )
  process.exitCode = failures.length ? 1 : 0
}

async function runAll() {
  // A camera-free profile: the dev app has no camera grant.
  await evaluate(
    `
      const key = 'videorc.captureConfig';
      const current = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...current,
        video: params.video, layout: { ...current.layout, ...params.layout },
        sources: { ...(current.sources ?? {}), cameraId: undefined, cameraName: undefined, cameraOff: true, testPattern: false },
        recordEnabled: true, streamEnabled: false,
        replayBuffer: { enabled: false, explicit: true }
      }));
      window.__previewCheckBeforeReload = true;
      ${reloadKeepingSeedJs()}
      return true;
    `,
    { video, layout }
  )
  const reloadDeadline = Date.now() + 30_000
  while (true) {
    const ready = await evaluate(
      'return !window.__previewCheckBeforeReload && typeof window.__videorcSmokeSetReplayBuffer === "function" && typeof window.__videorcSmokeScenePresets?.checkComputer === "function"'
    ).catch(() => null)
    if (ready === true) break
    assert(
      Date.now() < reloadDeadline,
      'renderer did not reload its camera-free profile with the check hook'
    )
    await sleep(100)
  }
  await setReplay(false)
  await rpc('session.stop')
  // The user picks the screen the way the Sources page does. A fresh profile
  // shows the first-run placeholder until its decision lands.
  const sourceDeadline = Date.now() + 30_000
  while (true) {
    try {
      const picked = await command('select-screen-device', { sourceId: screenId, settleMs: 500 })
      log(`screen picked: ${JSON.stringify(picked)}`)
      break
    } catch (error) {
      if (!/Could not find tab|not ready/.test(error.message) || Date.now() > sourceDeadline)
        throw error
      await sleep(250)
    }
  }
  await command('preview-window-open')
  // The user's idle scene: the screen, no camera, no test pattern. Reapply
  // until the compositor reports the same scene twice (main can synchronize
  // its initial scene late).
  let steady = 0
  let status
  for (let i = 0; i < 40 && steady < 2; i++) {
    status = await rpc('compositor.status')
    const kinds = (status.sceneSources ?? []).map((source) => source.kind)
    if (
      status.framesRendered > 5 &&
      status.frameAgeMs < 250 &&
      status.sceneLayout?.layoutPreset === 'screen-only' &&
      kinds.includes('screen') &&
      !kinds.includes('test-pattern')
    )
      steady++
    else {
      steady = 0
      await applyProgramScene()
    }
    await sleep(250)
  }
  assert.equal(
    steady,
    2,
    `the screen-only, pattern-free idle Preview scene must hold (status ${JSON.stringify({ framesRendered: status?.framesRendered, frameAgeMs: status?.frameAgeMs, layout: status?.sceneLayout?.layoutPreset, kinds: (status?.sceneSources ?? []).map((s) => s.kind) })})`
  )
  for (const old of await rpc('banners.list')) await rpc('banners.delete', { id: old.id })
  for (const [i, colour] of programFixtures.entries()) {
    const path = join(outputDirectory, `banner-${i}.png`)
    createPng(path, `color=c=${colour}:s=${i === 0 ? '1000x112' : '512x512'}`)
    const banner = await importBanner(path)
    await rpc('banners.update', {
      id: banner.id,
      horizontal: programRects[i],
      showOnStream: true,
      showInRecording: true
    })
  }
  const baseline = await waitForProgram(10_000)
  evidence.baseline = baseline
  assert(
    !baseline.error && baseline.mismatch.length === 0,
    `the Preview must show the program before any check: ${baseline.error ?? baseline.mismatch.join(' ')} (frame ${baseline.frameId}, ${baseline.size})`
  )
  programSize = baseline.size
  log(`program on the Preview: ${baseline.program.map(fmt).join(' ')} (${baseline.size})`)

  await runPass({ name: 'clips-on', clips: true })
  await runPass({ name: 'clips-off', clips: false })
  await runPass({ name: 'clips-on-record-rung-2', clips: true, record: true })
}
