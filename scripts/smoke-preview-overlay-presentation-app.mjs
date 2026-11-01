// The native Preview keeps presenting while overlays change (the 0.15.1
// regression: turning Buddy on while live froze the macOS Preview and its
// fallback showed no camera). Unlike every other app smoke this one leaves
// frame polling ON, as a production build has it, and reads what main
// presents (`presentedFrameId`), never only the backend's frame store.
//
// Phases: idle with Buddy off, then on (no program leg); Clips on with a
// stream-only Buddy (the program leg), Buddy off, Buddy on again; a banner
// imported (it shows), hidden, shown. Each phase must keep presenting and
// must never report "conflicting scene content".
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { launchDevApp } from './lib/app-launcher.mjs'
import { writeBuddyPetFixturePack } from './lib/buddy-pet-fixture.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { reloadKeepingSeedJs } from './lib/renderer-profile-seed.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

assert.equal(process.platform, 'darwin', 'The native Preview smoke requires the macOS dev app')
delete process.env.ELECTRON_RUN_AS_NODE
const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-preview-overlay-presentation-'))
const userDataDir = join(outputDirectory, 'profile')
mkdirSync(userDataDir)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = 120_000
const SAMPLE_MS = 250
// A phase passes when the Preview presented at least this share of the
// frames the compositor rendered, and never stood still longer than this.
const MIN_PRESENTED_SHARE = 0.8
const MAX_STILL_MS = 1000
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
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
const logs = []
const phases = []
let launch, ws
const rpc = (method, params = {}) => request(ws, timeoutMs, method, params)
const command = (name, params = {}) =>
  requestSmokeCommand(launch.connections['preview-motion-ready'], name, params, { timeoutMs })
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function setBuddy(on) {
  const current = await rpc('overlays.layout.get')
  await rpc('overlays.layout.set', {
    ...current,
    buddy: {
      ...current.buddy,
      horizontal: { x: 0.7, y: 0.5, w: 0.18, h: 0.32 },
      showOnStream: on,
      showInRecording: false
    }
  })
}

async function setClips(armed) {
  const switched = await command('eval-js', {
    code: `return window.__videorcSmokeSetReplayBuffer?.(${armed}, 30) ?? null`
  })
  assert.equal(switched.result, true, 'the maintained renderer Clips hook must be available')
  const until = Date.now() + 30_000
  let ring
  do {
    ring = await rpc('replay.status')
    if (ring.state === (armed ? 'on' : 'off') && (!armed || ring.replayOnly)) return
    await sleep(100)
  } while (Date.now() < until)
  assert.fail(`Clips did not settle: ${JSON.stringify(ring)}`)
}

async function importBanner(path) {
  const capability = await command('authorize-smoke-resource', { path, kind: 'input-file' })
  // The AssetImport lane is shared with the first launch's starter sounds.
  const until = Date.now() + 30_000
  while (true) {
    try {
      return await rpc('banners.importImage', { sourceCapability: capability.capabilityId })
    } catch (error) {
      if (!/already being imported/.test(error?.message ?? '') || Date.now() > until) throw error
      await sleep(200)
    }
  }
}

/** Sample what main presents for `ms`, then assert the Preview kept up. */
async function phase(label, ms, { programLeg }) {
  const logMark = logs.length
  const samples = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    const surface = await command('native-preview-surface-status')
    const compositor = await rpc('compositor.status')
    samples.push({
      at: Date.now(),
      presented: surface.presentedFrameId ?? null,
      transport: surface.transport,
      message: surface.message,
      frames: compositor.framesRendered,
      programLeg: compositor.framePipeline?.previewProgramLeg === true
    })
    await sleep(SAMPLE_MS)
  }
  const presented = samples.map((sample) => sample.presented).filter((id) => id != null)
  const presentedAdvance = presented.length ? presented.at(-1) - presented[0] : 0
  const framesAdvance = samples.at(-1).frames - samples[0].frames
  let stillSince = samples[0].at
  let longestStillMs = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].presented !== samples[i - 1].presented) stillSince = samples[i].at
    longestStillMs = Math.max(longestStillMs, samples[i].at - stillSince)
  }
  const conflicts = samples.filter((sample) =>
    /conflicting scene content/.test(sample.message ?? '')
  )
  const result = {
    label,
    presentedAdvance,
    framesAdvance,
    longestStillMs,
    conflicts: conflicts.length,
    transports: [...new Set(samples.map((sample) => sample.transport))],
    // The bit is republished on the compositor's diagnostic window (about
    // 2 s), so the phase's last sample is the settled one.
    programLeg: samples.at(-1).programLeg,
    watchdog: logs
      .slice(logMark)
      .filter((line) => /\[preview-watch\] (healing|stalled)/.test(line))
      .map((line) => line.replace(/^.*\[preview-watch\]/, '[preview-watch]'))
  }
  phases.push(result)
  console.log(`[preview-overlay-presentation] ${JSON.stringify(result)}`)
  assert.equal(result.conflicts, 0, `${label}: main rejected frames as conflicting scene content`)
  assert(
    presentedAdvance >= framesAdvance * MIN_PRESENTED_SHARE && framesAdvance > 0,
    `${label}: the Preview presented ${presentedAdvance} of ${framesAdvance} compositor frames`
  )
  assert(
    longestStillMs <= MAX_STILL_MS,
    `${label}: the Preview stood still for ${longestStillMs} ms`
  )
  assert.deepEqual(
    result.transports,
    ['native-surface'],
    `${label}: the Preview left the native surface`
  )
  assert.deepEqual(result.watchdog, [], `${label}: the presentation watchdog had to heal`)
  assert.equal(result.programLeg, programLeg, `${label}: program leg expected ${programLeg}`)
}

try {
  launch = await launchDevApp({
    env: {
      // The command server without VIDEORC_SMOKE_PREVIEW_MOTION: frame
      // polling stays on, exactly as in a production build.
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      logs.push(stripVTControlCharacters(line))
      if (process.env.VIDEORC_SMOKE_VERBOSE === '1') console.log(line)
    }
  })
  ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  // A camera-free profile: the dev app has no camera grant.
  await command('eval-js', {
    video,
    code: `
      const key = 'videorc.captureConfig';
      const current = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...current,
        video: params.video, layout: { ...current.layout, layoutPreset: 'screen-only' },
        recordEnabled: true, streamEnabled: false,
        replayBuffer: { enabled: false, explicit: true }
      }));
      window.__overlayPresentationBeforeReload = true;
      ${reloadKeepingSeedJs()}
      return true;
    `
  })
  const reloadDeadline = Date.now() + 30_000
  while (true) {
    const ready = await command('eval-js', {
      code: 'return !window.__overlayPresentationBeforeReload && typeof window.__videorcSmokeSetReplayBuffer === "function"'
    }).catch(() => null)
    if (ready?.result === true) break
    assert(Date.now() < reloadDeadline, 'renderer did not reload its camera-free profile')
    await sleep(100)
  }
  await setClips(false)
  await rpc('session.stop')
  // A fresh profile shows the first-run placeholder until its decision lands.
  const sourceDeadline = Date.now() + 30_000
  while (true) {
    try {
      await command('enable-synthetic-source', { settleMs: 0 })
      break
    } catch (error) {
      if (!/Could not find tab|not ready/.test(error.message) || Date.now() > sourceDeadline)
        throw error
      await sleep(250)
    }
  }
  await command('preview-window-open')
  let steady = 0
  for (let i = 0; i < 40 && steady < 2; i++) {
    const status = await rpc('compositor.status')
    if (
      status.framesRendered > 5 &&
      status.frameAgeMs < 250 &&
      status.sceneLayout?.layoutPreset === 'screen-only'
    )
      steady++
    else {
      steady = 0
      await rpc('scene.layout.apply_preview', { sources: { testPattern: true }, layout, video })
    }
    await sleep(250)
  }
  assert.equal(steady, 2, 'camera-free screen-only Preview scene must hold')
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
  await setBuddy(false)
  await sleep(2000)

  await phase('idle, Buddy off', 6000, { programLeg: false })
  await setBuddy(true)
  await phase('idle, Buddy turned on', 8000, { programLeg: false })
  await setClips(true)
  await phase('Clips on, stream-only Buddy (program leg)', 10_000, { programLeg: true })
  await setBuddy(false)
  await phase('Clips on, Buddy turned off', 8000, { programLeg: false })
  await setBuddy(true)
  await phase('Clips on, Buddy turned on again', 8000, { programLeg: true })
  const bannerPath = join(outputDirectory, 'banner.png')
  const png = spawnSync(ffmpegPath, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=magenta:s=600x100',
    '-frames:v',
    '1',
    bannerPath
  ])
  assert.equal(png.status, 0, `could not create the banner fixture: ${png.stderr}`)
  const banner = await importBanner(bannerPath)
  assert.equal(banner.shown, true, 'an added banner shows (plan 205 D3)')
  await phase('banner added', 6000, { programLeg: true })
  await rpc('banners.hide', { id: banner.id })
  await phase('banner hidden', 6000, { programLeg: true })
  await rpc('banners.show', { id: banner.id })
  await phase('banner shown again', 6000, { programLeg: true })
  console.log('preview-overlay-presentation: PASS')
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  writeFileSync(join(outputDirectory, 'evidence.json'), JSON.stringify({ phases, logs }, null, 2))
  console.log(`Preview overlay presentation evidence: ${outputDirectory}`)
  if (ws) {
    await rpc('session.stop').catch(() => {})
    ws.close()
  }
  await launch?.stop()
}
