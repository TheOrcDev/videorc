// Plan 205 S4 and S7: compare the Preview's actual frame with every local
// output, including the two rows where the Preview composes its own picture
// (Clips at idle, and a split record + stream). Case 10 relaunches the app
// cold with the Buddy already saved and Clips on: the ring then starts
// before the Preview's run exists and runs a compositor of its own, which
// must still show the program.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { launchDevApp } from './lib/app-launcher.mjs'
import { classifyBuddyPetTag, writeBuddyPetFixturePack } from './lib/buddy-pet-fixture.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { RELOAD_KEEPING_SEED_JS } from './lib/renderer-profile-seed.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

assert.equal(process.platform, 'darwin', 'Preview truth requires the macOS dev app')
delete process.env.ELECTRON_RUN_AS_NODE
const repoRoot = resolve(import.meta.dirname, '..')
const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-preview-truth-'))
const userDataDir = join(outputDirectory, 'profile')
mkdirSync(userDataDir)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = 120_000
const colours = [
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 0]
]
const pet = { x: 0.7, y: 0.5, w: 0.18, h: 0.32 }
// The central fifth of the pet box lies wholly inside the fixture's tag.
const rects = [
  { x: 0.05, y: 0.05, w: 0.4, h: 0.08 },
  { x: 0.05, y: 0.3, w: 0.12, h: 0.213333 },
  { x: 0.35, y: 0.3, w: 0.12, h: 0.213333 },
  pet
]
const rows = [
  // Unreachable here: a Custom stream is at most 1080p, and at 1080p60 or
  // below the VideoToolbox bridge always runs a separate stream leg. The
  // shared-leg row (D13 fallback) is pinned by the Rust program table.
  {
    case: '5 Record + stream shared leg',
    result: 'SKIP',
    reason: 'no shared leg on the macOS bridge with a Custom stream'
  }
]
// A, B, C and Buddy: A is stream only, B recording only, C hidden, Buddy
// stream only. The program is A, B and Buddy.
const PROGRAM = [true, true, false, true]
const RECORDING = [false, true, false, false]
const STREAM = [true, false, false, true]
const evidence = []
const logs = []
const receivers = []
let launch, ws
const rpc = (method, params = {}) => request(ws, timeoutMs, method, params)
const command = (name, params = {}) =>
  requestSmokeCommand(launch.connections['preview-motion-ready'], name, params, { timeoutMs })
const near = (rgb, target) => rgb.every((v, i) => Math.abs(v - target[i]) < 65)
// The pet's tag is any gaze or reaction frame, but a close one: a drawn tag
// samples within a few units of its colour, while the nearest-tag classifier
// once took the test pattern's ramp under an absent pet (132,138,80) for the
// look-43 tag at a gap of 50.
const petTag = (rgb) => {
  const frame = classifyBuddyPetTag(rgb)
  return frame && Math.hypot(...rgb.map((v, i) => v - frame.tag[i])) < 25 ? frame : null
}
const present = (rgb, i) => (i === 3 ? petTag(rgb) !== null : near(rgb, colours[i]))
function check(samples, expected, label) {
  evidence.push({ label, samples, expected })
  for (let i = 0; i < 4; i++)
    assert.equal(
      present(samples[i], i),
      expected[i],
      `${label}: ${['A', 'B', 'C', 'Buddy'][i]} expected ${expected[i]}, samples=${JSON.stringify(samples)}`
    )
}
async function oracle(expected, label, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  let frame
  do {
    frame = await rpc('preview.debug.sample', { rects })
    const samples = frame.samples.map(({ r, g, b }) => [r, g, b])
    if (samples.every((rgb, i) => present(rgb, i) === expected[i])) {
      check(samples, expected, `${label} frame=${frame.frameId}`)
      return
    }
    await sleep(15)
  } while (Date.now() < until)
  check(
    frame.samples.map(({ r, g, b }) => [r, g, b]),
    expected,
    `${label} frame=${frame.frameId}`
  )
}
async function runCase(name, work) {
  try {
    await work()
    rows.push({ case: name, result: 'PASS', reason: '' })
  } catch (error) {
    rows.push({ case: name, result: 'FAIL', reason: error.message })
    throw error
  }
}
async function layout(on = true) {
  const current = await rpc('overlays.layout.get')
  await rpc('overlays.layout.set', {
    ...current,
    buddy: { ...current.buddy, horizontal: pet, showOnStream: on, showInRecording: false }
  })
}
async function setReplay(armed) {
  const switched = await command('eval-js', {
    code: `return window.__videorcSmokeSetReplayBuffer?.(${armed}, 30) ?? null`
  })
  assert.equal(switched.result, true, 'the maintained renderer Clips hook must be available')
  const until = Date.now() + 30000
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
  // One import at a time process-wide (the AssetImport lane): its permit is
  // released just after the previous answer, so a back-to-back import can
  // meet "already being imported". The contract says try again; do so.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc('banners.importImage', { sourceCapability: cap.capabilityId })
    } catch (error) {
      if (attempt >= 20 || !/already being imported/.test(error?.message ?? '')) throw error
      await sleep(100)
    }
  }
}
async function artifact(path, expected, label) {
  // Sample several fully established frames, never just file size.
  for (const seconds of [1, 1.5, 2])
    check(sampleRects(path, seconds, rects), expected, `${label} ${seconds}s`)
}
/**
 * Whether the status says the Preview presents its program leg. The bit
 * travels with `framePipeline`, republished on the compositor's diagnostic
 * window (a couple of seconds), so wait for it rather than read once.
 */
async function waitForProgramLeg(expected, label, deadlineMs = 8000) {
  const until = Date.now() + deadlineMs
  let status
  do {
    status = await rpc('compositor.status')
    if ((status.framePipeline?.previewProgramLeg === true) === expected) break
    await sleep(200)
  } while (Date.now() < until)
  evidence.push({ label: `${label} framePipeline`, framePipeline: status.framePipeline })
  assert.equal(
    status.framePipeline?.previewProgramLeg === true,
    expected,
    `${label}: the Preview must${expected ? '' : ' not'} present its program leg (framePipeline=${JSON.stringify(status.framePipeline)})`
  )
}
/** The program leg is on: the status says so and the backend log said why. */
async function expectProgramLeg(label, logMark) {
  await waitForProgramLeg(true, label)
  const on = logs.slice(logMark).find((line) => /Preview program leg on/.test(line))
  assert(on, `${label}: the backend log must say the program leg turned on`)
}
/** The backend's "overlay leg plan" line for the session started after `logMark`. */
function overlayLegPlanLine(logMark) {
  const fromStdout = logs.slice(logMark).find((line) => /overlay leg plan/.test(line))
  if (fromStdout) return fromStdout
  const backendLog = join(userDataDir, 'logs', 'backend.log')
  if (!existsSync(backendLog)) return null
  const lines = readFileSync(backendLog, 'utf8').split('\n')
  return lines.reverse().find((line) => /overlay leg plan/.test(line)) ?? null
}
/**
 * One session with per-output expectations: `preview` is what the oracle
 * must see while it runs, `recording` what the file carries, `onAir` what
 * the local RTMP listener received. `splitLeg` demands a separate stream
 * leg (the backend's `overlay leg plan ... aux=true`) and the program leg.
 */
async function session({ label, record, stream, video, preview, recording, onAir, splitLeg }) {
  await layout()
  const cap = await command('authorize-smoke-resource', {
    path: outputDirectory,
    kind: 'output-directory'
  })
  const params = sessionParams(cap.capabilityId)
  params.output.recordEnabled = record
  params.output.streamEnabled = stream
  if (video) params.output.video = { ...params.output.video, ...video }
  let receiver
  if (stream) {
    const target = {
      serverUrl: 'rtmp://127.0.0.1:13939/live',
      streamKey: 'preview-truth',
      recvPath: join(outputDirectory, `stream-${label.replace(/\W+/g, '-')}.flv`)
    }
    receiver = startReceiver(target)
    receivers.push(receiver)
    await waitForOwnedTcpListener({
      child: receiver.child,
      port: 13939,
      timeoutMs: 8000,
      diagnostics: () => receiver.log
    })
    params.output.rtmp = {
      preset: 'custom',
      serverUrl: target.serverUrl,
      streamKey: target.streamKey
    }
  }
  const logMark = logs.length
  const started = await rpc('session.start', params)
  await oracle(preview, `${label} running Preview`)
  if (splitLeg) {
    const plan = overlayLegPlanLine(logMark)
    evidence.push({ label: `${label} overlay leg plan`, line: plan })
    assert(
      plan && /\baux=true\b/.test(plan),
      `${label}: expected a split stream leg (overlay leg plan ... aux=true), got ${plan ?? 'no overlay leg plan line'}`
    )
    await expectProgramLeg(label, logMark)
  }
  await sleep(3500) // Deliberate artifact coverage, not readiness.
  const stopped = await rpc('session.stop')
  if (record)
    await artifact(
      await resolveFinalRecordingPath({ started, stopped, timeoutMs }),
      recording,
      `${label} recording`
    )
  if (receiver) {
    await waitForExit(receiver, 15000)
    await artifact(receiver.path, onAir, `${label} local RTMP`)
  }
}
/** Launch the dev app on this smoke's profile (again, for a cold relaunch). */
async function launchApp() {
  launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      logs.push(stripVTControlCharacters(line))
      console.log(line)
    }
  })
  ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
}
/** The ring's start path since `logMark`: armed in place, or a run of its own. */
function ringStartPath(logMark) {
  const line = logs
    .slice(logMark)
    .find((entry) => /Armed the live preview compositor in place|no-live-run/.test(entry))
  if (!line) return null
  return /no-live-run/.test(line) ? 'own-run' : 'armed-in-place'
}
try {
  await launchApp()
  // Seed the renderer's own capture configuration too: its Clips reconciler
  // owns buffer-only starts/stops and must agree with the backend scene.
  await command('eval-js', {
    video: sessionParams(null).output.video,
    code: `
      const key = 'videorc.captureConfig';
      const current = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...current,
        video: params.video, layout: { ...current.layout, layoutPreset: 'screen-only' },
        recordEnabled: true, streamEnabled: false,
        replayBuffer: { enabled: false, explicit: true }
      }));
      window.__previewTruthBeforeReload = true;
      ${RELOAD_KEEPING_SEED_JS}
      return true;
    `
  })
  const reloadDeadline = Date.now() + 30000
  while (true) {
    const ready = await command('eval-js', {
      code: 'return !window.__previewTruthBeforeReload && typeof window.__videorcSmokeSetReplayBuffer === "function"'
    }).catch(() => null)
    if (ready?.result === true) break
    assert(Date.now() < reloadDeadline, 'renderer did not reload its camera-free profile')
    await sleep(100)
  }
  await setReplay(false)
  await rpc('session.stop')
  await command('enable-synthetic-source', { settleMs: 0 })
  await command('preview-window-open')
  // Main can synchronize its initial scene late. Reapply a camera-free
  // screen-only scene until the compositor reports the same scene twice.
  const previewParams = sessionParams(null)
  let steady = 0
  for (let i = 0; i < 30 && steady < 2; i++) {
    const status = await rpc('compositor.status')
    if (
      status.framesRendered > 5 &&
      status.frameAgeMs < 250 &&
      status.sceneLayout?.layoutPreset === 'screen-only'
    )
      steady++
    else {
      steady = 0
      await rpc('scene.layout.apply_preview', {
        sources: { testPattern: true },
        layout: previewParams.layout,
        video: previewParams.output.video
      })
    }
    await sleep(250)
  }
  assert.equal(steady, 2, 'camera-free screen-only Preview scene must hold')
  for (const old of await rpc('banners.list')) await rpc('banners.delete', { id: old.id })
  const banners = []
  for (const [i, colour] of ['magenta', 'cyan', 'yellow'].entries()) {
    const path = join(outputDirectory, `${colour}.png`)
    createPng(path, `color=c=${colour}:s=${i === 0 ? '1000x112' : '512x512'}`, 'format=rgba')
    const banner = await importBanner(path)
    assert.equal(banner.shown, true)
    banners.push(banner)
    if (i === 2) await rpc('banners.hide', { id: banner.id })
    await rpc('banners.update', {
      id: banner.id,
      horizontal: rects[i],
      showOnStream: i !== 1,
      showInRecording: i === 1
    })
  }
  const settings = await rpc('cohost.settings.get')
  const packId = randomUUID()
  writeBuddyPetFixturePack(join(userDataDir, 'buddy-assets', settings.persona.id, 'pets', packId))
  await command('backend-debug-rpc', {
    method: 'cohost.pet.import',
    params: { folderToken: `${settings.persona.id}/pets/${packId}` }
  })
  await rpc('cohost.settings.set', {
    persona: {
      ...settings.persona,
      avatar: { kind: 'alive', packId },
      motion: { intensity: 0, sleepAfterSeconds: 180, breathing: false }
    }
  })
  await layout()
  await runCase('1 Clips off, idle', () => oracle(PROGRAM, 'idle'))
  await runCase('2 Clips on: Preview shows the program, the clip the recording', async () => {
    const logMark = logs.length
    await setReplay(true)
    // Plan 205 Phase 2: the ring is a recording (D2), so the Preview composes
    // its own picture with A, B and Buddy while the ring keeps B only.
    await oracle(PROGRAM, 'Clips idle Preview')
    await expectProgramLeg('Clips idle', logMark)
    const until = Date.now() + 45000
    while ((await rpc('replay.status')).bufferedSeconds < 30) {
      assert(Date.now() < until, 'ring never filled 30 seconds')
      await sleep(250)
    }
    await oracle(PROGRAM, 'Clips idle Preview after 30 s')
    const saved = new Promise((resolveSave, reject) => {
      const timer = setTimeout(() => reject(new Error('clip save timed out')), timeoutMs)
      const handler = (event) => {
        const m = JSON.parse(event.data)
        if (m.event === 'replay.saved' || m.event === 'replay.saveFailed') {
          clearTimeout(timer)
          ws.removeEventListener('message', handler)
          if (m.event === 'replay.saved') resolveSave(m.payload)
          else reject(new Error(JSON.stringify(m.payload)))
        }
      }
      ws.addEventListener('message', handler)
    })
    await rpc('replay.save', { seconds: 30 })
    const clip = await saved
    assert(
      clip.complete && clip.coveredSeconds >= 29.5,
      `Expected a full 30-second clip: ${JSON.stringify(clip)}`
    )
    await artifact(clip.path, RECORDING, 'saved clip')
    await setReplay(false)
    // Off again: the Preview is the primary leg once more, still the program.
    await oracle(PROGRAM, 'idle after Clips')
    await waitForProgramLeg(false, 'idle after Clips')
  })
  await runCase('3 Record only', () =>
    session({
      label: 'record only',
      record: true,
      stream: false,
      preview: RECORDING,
      recording: RECORDING
    })
  )
  await runCase('4 Stream only (local RTMP)', () =>
    session({
      label: 'stream only',
      record: false,
      stream: true,
      preview: STREAM,
      onAir: STREAM
    })
  )
  await runCase('9 Record + stream split leg (1080p30)', () =>
    session({
      label: 'split 1080p30',
      record: true,
      stream: true,
      video: { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
      preview: PROGRAM,
      recording: RECORDING,
      onAir: STREAM,
      splitLeg: true
    })
  )
  await runCase('6 Buddy off and selected', async () => {
    await layout(false)
    const selected = { x: pet.x, y: pet.y, width: pet.w, height: pet.h }
    await rpc('scene.editor.draft.set', {
      sourceId: 'overlay:buddy',
      chrome: { selected, handles: true, guides: [], scale: 1 }
    })
    await oracle([true, true, false, false], 'off selected Buddy')
    await rpc('scene.editor.draft.clear')
  })
  await runCase('7 Show and hide while idle', async () => {
    await rpc('banners.show', { id: banners[2].id })
    await oracle([true, true, true, false], 'Show C within 300ms', 300)
    await rpc('banners.hide', { id: banners[0].id })
    await oracle([false, true, true, false], 'Hide A within 300ms', 300)
  })
  await runCase('8 Import shows at idle', async () => {
    await oracle([false, true, true, false], 'before fourth import')
    const path = join(outputDirectory, 'green.png')
    createPng(path, 'color=c=lime:s=512x512', 'format=rgba')
    const added = await importBanner(path)
    assert.equal(added.shown, true)
    const until = Date.now() + 300
    let sample
    do {
      sample = await rpc('preview.debug.sample', { rects: [added.horizontal] })
      const { r, g, b } = sample.samples[0]
      if (near([r, g, b], [0, 255, 0])) {
        evidence.push({ label: 'fourth import within 300ms', frame: sample })
        await oracle([false, true, true, false], 'after fourth import')
        return
      }
      await sleep(10)
    } while (Date.now() < until)
    assert.fail(`Imported green banner absent within 300ms: ${JSON.stringify(sample)}`)
  })
  await runCase('10 Cold launch: Buddy saved, Clips on', async () => {
    // The owner's report: Buddy on (stream only) and saved, the app opened
    // cold, and the Preview without the pet until the first Record. At
    // launch the renderer arms the ring before the Preview's run exists, so
    // the buffer-only session runs a compositor of its own instead of
    // arming the idle run in place. That run must show the program too: B
    // (recording only), C (stream only) and the Buddy; A stays hidden.
    const program = [false, true, true, true]
    await layout()
    await setReplay(true)
    await oracle(program, 'Clips on before the relaunch')
    await launch.stop()
    ws = null
    const logMark = logs.length
    await launchApp()
    const until = Date.now() + 30000
    let ring
    do {
      ring = await rpc('replay.status')
      if (ring.state === 'on' && ring.replayOnly) break
      assert(Date.now() < until, `Clips did not come back on at launch: ${JSON.stringify(ring)}`)
      await sleep(200)
    } while (true)
    await command('preview-window-open')
    // Nothing touches the layout: the Preview shows the program from launch.
    await oracle(program, 'cold launch, Clips on, untouched layout', 8000)
    const path = ringStartPath(logMark)
    evidence.push({ label: 'cold launch ring start path', path })
    assert(path, 'the backend log must say how the ring started')
    console.log(
      `Cold launch: the ring ${path === 'own-run' ? 'ran a compositor of its own' : 'armed the Preview in place'}`
    )
    await expectProgramLeg('cold launch', logMark)
    // Record only: the pet and C leave (the recording has neither); after
    // Stop the ring re-arms and the program is back.
    const cap = await command('authorize-smoke-resource', {
      path: outputDirectory,
      kind: 'output-directory'
    })
    await rpc('session.start', sessionParams(cap.capabilityId))
    await oracle(RECORDING, 'cold launch, record only')
    await rpc('session.stop')
    await oracle(program, 'cold launch, after Stop', 15000)
  })
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  rows.sort((a, b) => a.case.localeCompare(b.case, undefined, { numeric: true }))
  console.table(rows)
  writeFileSync(
    join(outputDirectory, 'evidence.json'),
    JSON.stringify({ rows, evidence, logs }, null, 2)
  )
  console.log(`Preview truth evidence: ${outputDirectory}`)
  if (ws) {
    await rpc('session.stop').catch(() => {})
    ws.close()
  }
  for (const receiver of receivers) await stopReceiver(receiver)
  await launch?.stop()
}

function createPng(outputPath, source, filter) {
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
      filter,
      outputPath
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`Could not create ${outputPath}: ${result.stderr || result.stdout}`)
  }
}

/** One frame, the mean colour of the middle fifth of each rect. */
function sampleRects(path, seconds, rects) {
  return rects.map((rect) => {
    const cx = rect.x + rect.w * 0.4
    const cy = rect.y + rect.h * 0.4
    const result = spawnSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        seconds.toFixed(2),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        `crop=iw*${(rect.w * 0.2).toFixed(6)}:ih*${(rect.h * 0.2).toFixed(6)}:iw*${cx.toFixed(6)}:ih*${cy.toFixed(6)},scale=1:1,format=rgb24`,
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      { encoding: null }
    )
    if (result.status !== 0 || result.stdout.length < 3) {
      throw new Error(`Could not sample ${path} at ${seconds}s: ${result.stderr?.toString() ?? ''}`)
    }
    return [result.stdout[0], result.stdout[1], result.stdout[2]]
  })
}

function sessionParams(outputDirectoryCapability) {
  return {
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
    layout: {
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
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function startReceiver(target) {
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `${target.serverUrl}/${target.streamKey}`,
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const receiver = { child, path: target.recvPath, log: '', exited: null }
  receiver.exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', (error) => resolveExit({ error }))
  })
  child.stderr.on('data', (text) => {
    receiver.log = (receiver.log + text).slice(-8000)
  })
  return receiver
}
async function waitForExit(receiver, ms) {
  let timer
  try {
    const result = await Promise.race([
      receiver.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Receiver did not finish: ${receiver.log}`)), ms)
      })
    ])
    if (result.error) throw result.error
  } finally {
    clearTimeout(timer)
  }
}
async function stopReceiver(receiver) {
  if (receiver.child.exitCode !== null || receiver.child.signalCode !== null) return
  receiver.child.kill('SIGTERM')
  try {
    await waitForExit(receiver, 2000)
  } catch {
    receiver.child.kill('SIGKILL')
    await waitForExit(receiver, 2000)
  }
}
