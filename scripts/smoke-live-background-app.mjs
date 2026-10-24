// Plan 190 S9: live backgrounds end to end through the dev app (macOS).
//
// For each case (Silk at 1080p30, Plasma Wave at 4K30, Liquid Chrome at
// 1080p60) the smoke puts the live background on the preview, checks the
// compositor draws the shader, records a few seconds through the encoder
// bridge and samples the artifact with ffmpeg:
// - the background ring (the stage margin around the screen) moves;
// - it never freezes for more than half a second;
// - the stage (the synthetic screen) is not the background;
// - the poster is never uploaded per frame (immutable uploads stay flat);
// - the background's own p95 is within budget.
// Then the background comes off and the live programs and scratch drop to 0
// (zero cost when off). The guard may draw at half size on a busy host; a
// fall to the poster fails, so run it on a quiet host (it is load-sensitive). With VIDEORC_LIVE_BACKGROUND_FORCE_STILL=1 (debug
// builds) every case must draw the still poster instead: status `still` with
// reason `forced` and a static ring.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-live-background-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-live-background-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const forced = process.env.VIDEORC_LIVE_BACKGROUND_FORCE_STILL === '1'

/** Plan 190 "Performance budget": the background's own p95 on an M-series Mac. */
const BUDGET_MS = { 1080: 1.5, 2160: 3.0 }
const CASES = (
  process.env.VIDEORC_LIVE_BACKGROUND_SMOKE_CASES ??
  'silk:1080p30,plasma-wave:2160p30,liquid-chrome:1080p60'
)
  .split(',')
  .map((entry) => {
    const [id, profile] = entry.split(':')
    const match = /^(\d+)p(\d+)$/.exec(profile)
    assert(match, `bad case ${entry}`)
    const height = Number(match[1])
    return {
      id,
      look: { silk: 'satin', 'plasma-wave': 'plasma', 'liquid-chrome': 'polished' }[id] ?? null,
      width: Math.round((height * 16) / 9),
      height,
      fps: Number(match[2]),
      seconds: height > 1080 ? 4 : 6
    }
  })
/** The stage margin per side at Visibility 20 is 10 %; the ring is sampled inside it. */
const RING = { x: 0.01, y: 0.15, w: 0.07, h: 0.7 }
const STAGE = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }

const LAYOUT = {
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

mkdirSync(outputDirectory, { recursive: true })

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '0',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  try {
    await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 0 }, { timeoutMs })
    await requestSmokeCommand(smoke, 'preview-window-open', {}, { timeoutMs })
    await waitFor(async () => (await status()).framesRendered > 0, 'the first preview frame')

    // Zero cost when off: before any live background, nothing is built.
    const before = await status()
    assert.equal(before.framePipeline?.liveBackgroundPrograms ?? 0, 0, 'no live program while off')
    assert.equal(before.framePipeline?.liveBackgroundScratchBytes ?? 0, 0, 'no scratch while off')
    assert.equal(before.liveBackground, undefined, 'no live status while off')

    for (const testCase of CASES) {
      await runCase(testCase)
    }

    // Off again: the programs and scratch are released.
    await applyPreview(null, CASES[0])
    await waitFor(async () => {
      const current = await status()
      return (
        current.liveBackground === undefined &&
        (current.framePipeline?.liveBackgroundPrograms ?? 0) === 0 &&
        (current.framePipeline?.liveBackgroundScratchBytes ?? 0) === 0
      )
    }, 'the live background to release its programs and scratch')
    console.log('Live background smoke PASS')
  } finally {
    await request(ws, timeoutMs, 'session.stop').catch(() => {})
    ws.close()
  }

  async function runCase(testCase) {
    const background = liveBackground(testCase)
    await applyPreview(background, testCase)
    let appliedAt = Date.now()
    const expected = forced ? 'still' : 'shader'
    let seen
    let reapplied = 0
    await waitFor(
      async () => {
        seen = await status()
        if (seen.liveBackground?.rendering === expected) return true
        // Until the preview first shows the app's own committed scene, main's
        // first-frame watchdog re-commits that scene over this smoke's
        // (`resync-scene`), and the compositor loses the live background.
        // Put it back (the recording below passes its scene explicitly).
        if (!seen.liveBackground && Date.now() - appliedAt > 1500 && reapplied < 5) {
          reapplied += 1
          console.log(`${testCase.id}: the app displaced the preview scene; applying again`)
          await applyPreview(background, testCase)
          appliedAt = Date.now()
        }
        return false
      },
      () =>
        `${testCase.id} to render as ${expected}; last ${JSON.stringify({
          liveBackground: seen?.liveBackground,
          programs: seen?.framePipeline?.liveBackgroundPrograms,
          scratchBytes: seen?.framePipeline?.liveBackgroundScratchBytes,
          backend: seen?.backend,
          framesRendered: seen?.framesRendered,
          sceneRevision: seen?.sceneRevision,
          sceneSources: seen?.sceneSources?.map((source) => [source.kind, source.id, source.state])
        })}`
    )
    const live = (await status()).liveBackground
    assert.equal(live.id, testCase.id)
    if (forced) assert.equal(live.reason, 'forced', 'a forced still names its reason')

    const scene = await request(ws, timeoutMs, 'scene.get')
    const capability = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { path: outputDirectory, kind: 'output-directory' },
      { timeoutMs }
    )
    const started = await request(ws, timeoutMs, 'session.start', {
      ...sessionParams(capability.capabilityId, testCase),
      scene: {
        ...scene,
        background,
        outputs: scene.outputs.map((output) => ({
          ...output,
          width: testCase.width,
          height: testCase.height,
          fps: testCase.fps
        }))
      }
    })
    assert.equal(started.state, 'recording', `${testCase.id}: the session must record`)
    await sleep(1500) // Deliberate: past the start transient before sampling uploads.
    const early = await status()
    const samples = []
    const until = Date.now() + testCase.seconds * 1000
    while (Date.now() < until) {
      samples.push(await status())
      await sleep(500)
    }
    const late = await status()
    console.log(`${testCase.id}: at the end of the take ${JSON.stringify(late.liveBackground)}`)
    const stopped = await request(ws, timeoutMs, 'session.stop')
    const path = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120000 })

    // The guard may halve the internal size on a busy host (it still moves);
    // falling back to the poster mid-recording fails.
    const allowed = forced ? ['still'] : ['shader', 'half']
    for (const sample of samples) {
      assert(
        allowed.includes(sample.liveBackground?.rendering),
        `${testCase.id}: the live background left ${allowed.join('/')} mid-recording: ${JSON.stringify(sample.liveBackground)}`
      )
    }
    const halved = samples.filter((sample) => sample.liveBackground?.rendering === 'half').length
    if (halved > 0) {
      console.log(
        `${testCase.id}: the guard drew at half size for ${halved}/${samples.length} samples`
      )
    }
    assert.equal(
      late.framePipeline.immutableTextureUploads,
      early.framePipeline.immutableTextureUploads,
      `${testCase.id}: immutable texture uploads grew while the live background showed`
    )
    if (!forced) {
      assert(late.framePipeline.liveBackgroundPrograms > 0, 'the live programs are counted')
      const p95 = late.liveBackground?.p95Ms
      const budget = BUDGET_MS[testCase.height]
      console.log(
        `${testCase.id} ${testCase.width}x${testCase.height}@${testCase.fps}: p95 ${p95?.toFixed?.(2) ?? 'n/a'} ms (budget ${budget}), load ${loadavg()[0].toFixed(1)}`
      )
      if (process.env.VIDEORC_LIVE_BACKGROUND_SMOKE_SKIP_BUDGET !== '1') {
        assert(
          typeof p95 === 'number' && p95 <= budget,
          `${testCase.id}: the live background's p95 ${p95} ms exceeds ${budget} ms (load ${loadavg()[0].toFixed(1)})`
        )
      }
    }
    verifyArtifact(path, testCase)
    const quality = await analyzeRecording(path, {
      ffmpegPath,
      ffprobePath,
      intendedFps: testCase.fps,
      expectAudio: true,
      gates: { requireMotion: false }
    })
    assert(quality.verdict.pass, `${path}: ${quality.verdict.failures.join('; ')}`)
    console.log(`Live background case OK: ${testCase.id} ${testCase.height}p${testCase.fps}`)
  }

  function verifyArtifact(path, testCase) {
    assert(path && existsSync(path) && statSync(path).size > 0, `missing artifact ${path}`)
    const ring = grayTimeline(path, RING)
    const stage = grayTimeline(path, STAGE)
    const steps = ring.slice(1).map((frame, index) => meanAbsDiff(frame, ring[index]))
    const motion = steps.reduce((sum, value) => sum + value, 0) / steps.length
    console.log(`${testCase.id}: ring motion ${motion.toFixed(2)} per 0.5 s`)
    if (forced) {
      assert(motion < 0.75, `${path}: a forced still must not move (ring motion ${motion})`)
    } else {
      assert(motion > 1, `${path}: the live background ring does not move (motion ${motion})`)
      const freezes = freezeStarts(path, RING)
      assert.equal(freezes.length, 0, `${path}: the ring froze at ${freezes.join(', ')} s`)
    }
    // The stage shows the synthetic screen, never the background.
    const stageVsRing = meanAbsDiff(stage.at(-1), ring.at(-1))
    assert(stageVsRing > 8, `${path}: the stage looks like the background (${stageVsRing})`)
  }

  async function applyPreview(background, testCase) {
    await request(ws, timeoutMs, 'scene.layout.apply_preview', {
      sources: { testPattern: true },
      layout: LAYOUT,
      video: {
        preset: 'custom',
        width: testCase.width,
        height: testCase.height,
        fps: testCase.fps,
        bitrateKbps: 6000
      },
      ...(background ? { background } : {})
    })
  }

  async function status() {
    return request(ws, 4000, 'compositor.status')
  }

  async function waitFor(check, what) {
    const deadline = Date.now() + timeoutMs
    while (!(await check())) {
      if (Date.now() >= deadline) {
        assert.fail(`Timed out waiting for ${typeof what === 'function' ? what() : what}`)
      }
      await sleep(100)
    }
  }
} finally {
  await stopApp()
}

function liveBackground({ id, look }) {
  return {
    assetId: `live-${id}-${look}`,
    managedAssetPath: `videorc-asset://background/live-${id}-${look}.webp`,
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: 20,
    live: { id, look, motion: 'calm' }
  }
}

function sessionParams(outputDirectoryCapability, testCase) {
  return {
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
    layout: LAYOUT,
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability,
      video: {
        preset: 'custom',
        width: testCase.width,
        height: testCase.height,
        fps: testCase.fps,
        bitrateKbps: testCase.height > 1080 ? 20000 : 8000
      },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

/** A 16×16 grey thumbnail of a rect every 0.5 s. */
function grayTimeline(path, rect) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `fps=2,crop=iw*${rect.w}:ih*${rect.h}:iw*${rect.x}:ih*${rect.y},scale=16:16,format=gray`,
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 }
  )
  assert(result.status === 0, `${path}: ffmpeg failed: ${result.stderr?.toString() ?? ''}`)
  const frames = []
  for (let offset = 0; offset + 256 <= result.stdout.length; offset += 256) {
    frames.push(result.stdout.subarray(offset, offset + 256))
  }
  assert(frames.length >= 4, `${path}: too few frames sampled (${frames.length})`)
  // Skip the first second (start transient).
  return frames.slice(2)
}

function meanAbsDiff(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / a.length
}

/** freezedetect over the ring: any freeze longer than half a second. */
function freezeStarts(path, rect) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-i',
      path,
      '-vf',
      `crop=iw*${rect.w}:ih*${rect.h}:iw*${rect.x}:ih*${rect.y},freezedetect=n=0.002:d=0.5`,
      '-map',
      '0:v',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  return [...result.stderr.matchAll(/freeze_start: ([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((start) => start > 1)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
