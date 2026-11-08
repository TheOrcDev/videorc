// Plan 190 S9: live backgrounds end to end through the dev app (macOS).
//
// For each case (Silk at 1080p30, Plasma Wave at 4K30, Liquid Chrome at
// 1080p60) the smoke puts the live background on the preview, checks the
// compositor draws the shader, records a few seconds through the encoder
// bridge and samples the artifact with ffmpeg. Plan 193 adds record-and-
// stream cases (`<id>:<record>+stream<stream>`): the stream goes to a local
// RTMP listener and the received stream is checked like the recording. On
// macOS the stream is its own compositor leg, which drew the poster before
// plan 193; its ring must move as much as the recording's. Plan 194 adds one
// recording per new background and record-and-stream cases for Ghost Fibers
// and Dither. Each artifact:
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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
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
  [
    'silk:1080p30',
    'plasma-wave:2160p30',
    'liquid-chrome:1080p60',
    // Plan 193: one profile for both (the same-profile stream leg), the
    // owner's 4K30 recording with a 1080p30 stream, and Line Waves' thin
    // lines drawn from a 4K frame into the 1080p stream.
    'silk:1080p30+stream1080p30',
    'liquid-chrome:2160p30+stream1080p30',
    'line-waves:2160p30+stream1080p30',
    // Plan 194: one recording each; Dither at 4K (it renders at full size),
    // and two splits: Ghost Fibers' instanced dots and Dither's per-pixel
    // cells drawn from a 4K frame into the 1080p stream.
    'beams:1080p30',
    'color-bends:1080p30',
    'dither:2160p30',
    'ferrofluid:1080p30',
    'ghost-fibers:1080p60',
    'ghost-fibers:2160p30+stream1080p30',
    'dither:2160p30+stream1080p30'
  ].join(',')
)
  .split(',')
  .map((entry) => {
    const [id, profiles] = entry.split(':')
    const match = /^(\d+)p(\d+)(?:\+stream(\d+)p(\d+))?$/.exec(profiles ?? '')
    assert(match, `bad case ${entry}`)
    const height = Number(match[1])
    const streamHeight = match[3] ? Number(match[3]) : null
    return {
      id,
      look:
        {
          silk: 'satin',
          'plasma-wave': 'plasma',
          'liquid-chrome': 'polished',
          'line-waves': 'silk',
          beams: 'studio',
          'color-bends': 'default',
          dither: 'classic',
          ferrofluid: 'studio',
          'ghost-fibers': 'violet'
        }[id] ?? null,
      width: widthFor(height),
      height,
      fps: Number(match[2]),
      stream: streamHeight
        ? { width: widthFor(streamHeight), height: streamHeight, fps: Number(match[4]) }
        : null,
      seconds: height > 1080 ? 4 : 6
    }
  })
/** The stage margin per side at Visibility 20 is 10 %; the ring is sampled inside it. */
const RING = { x: 0.01, y: 0.15, w: 0.07, h: 0.7 }
const STAGE = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
/**
 * Plan 193: a square of the ring, sampled finer (64 × 64, five a second), to
 * compare the recording with the stream at one scale. Line Waves' thin lines
 * average away in the 16 × 16 ring thumbnail; here they still show.
 */
const RING_SQUARE = { x: 0.015, y: 0.4, w: 0.06, h: 0.1067 }
const RTMP_BASE_PORT = Number(process.env.VIDEORC_LIVE_BACKGROUND_RTMP_PORT ?? 19841)
const RTMP_BIND_MS = 1500

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
    // Clips is on by default (plan 181): at launch the renderer arms a
    // buffer-only session with the app's own scene, and a Record hands over
    // from it. That scene holds whatever camera the Mac has, which the dev
    // app can't read, so the start is refused. This smoke records its own
    // scene: turn the switch off first, as the record-latency smoke does.
    // The renderer mounts after main's markers; on a slow machine well after.
    await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
    const clipsOff = await requestSmokeCommand(
      smoke,
      'eval-js',
      { code: 'return window.__videorcSmokeSetReplayBuffer?.(false) ?? null' },
      { timeoutMs }
    )
    assert.equal(clipsOff?.result, true, 'the renderer has no clip buffer smoke hook')
    await waitFor(
      async () => (await request(ws, timeoutMs, 'replay.status'))?.state === 'off',
      'the clip buffer to turn off'
    )
    await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 0 }, { timeoutMs })
    await requestSmokeCommand(smoke, 'preview-window-open', {}, { timeoutMs })
    await waitFor(async () => (await status()).framesRendered > 0, 'the first preview frame')

    // Zero cost when off: before any live background, nothing is built.
    const before = await status()
    assert.equal(before.framePipeline?.liveBackgroundPrograms ?? 0, 0, 'no live program while off')
    assert.equal(before.framePipeline?.liveBackgroundScratchBytes ?? 0, 0, 'no scratch while off')
    assert.equal(before.liveBackground, undefined, 'no live status while off')

    for (const [index, testCase] of CASES.entries()) {
      await runCase(testCase, index)
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

  async function runCase(testCase, index) {
    const label = caseLabel(testCase)
    const background = liveBackground(testCase)
    await applyPreview(background, testCase)
    let appliedAt = Date.now()
    const expected = forced ? 'still' : 'shader'
    let seen
    let reapplied = 0
    await waitFor(
      async () => {
        seen = await status()
        // The previous case's background can still be reporting for a moment
        // (plan 194's cases run back to back): wait for this one's id too.
        if (
          seen.liveBackground?.rendering === expected &&
          seen.liveBackground?.id === testCase.id
        ) {
          return true
        }
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
    // Plan 193: a stream case sends its stream to a local RTMP listener.
    const target = testCase.stream ? rtmpTarget(testCase, index) : null
    const listener = target ? spawnRtmpListener(target) : null
    let started
    let stopped
    let late
    const samples = []
    try {
      if (listener) {
        await sleep(RTMP_BIND_MS) // Deliberate: ffmpeg must be listening before the session dials.
        assert.equal(
          listener.process.exitCode,
          null,
          `${label}: the local RTMP listener exited: ${listener.stderr.join('').trim()}`
        )
      }
      started = await request(ws, timeoutMs, 'session.start', {
        ...sessionParams(capability.capabilityId, testCase, target),
        scene: {
          ...scene,
          background,
          outputs: scene.outputs.map((output) => ({
            ...output,
            ...(output.kind === 'stream' && testCase.stream
              ? testCase.stream
              : { width: testCase.width, height: testCase.height, fps: testCase.fps })
          }))
        }
      })
      assert(
        started.state === 'recording' || (target && started.state === 'streaming'),
        `${label}: the session must record, got ${started.state}`
      )
      await sleep(1500) // Deliberate: past the start transient before sampling uploads.
      const until = Date.now() + testCase.seconds * 1000
      while (Date.now() < until) {
        samples.push(await status())
        await sleep(500)
      }
      late = await status()
      console.log(`${label}: at the end of the take ${JSON.stringify(late.liveBackground)}`)
      stopped = await request(ws, timeoutMs, 'session.stop')
    } finally {
      await stopRtmpListener(listener)
    }
    const path = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120000 })

    // The guard may halve the internal size on a busy host (it still moves);
    // falling back to the poster mid-recording fails. A record-and-stream
    // session starts a new compositor run, whose status carries no live
    // background until its first 2 s diagnostic window: skip only those
    // leading samples (the artifacts below judge the pixels from 1 s on).
    const allowed = forced ? ['still'] : ['shader', 'half']
    const firstReported = samples.findIndex((sample) => sample.liveBackground !== undefined)
    assert(firstReported >= 0, `${label}: no status sample reported the live background`)
    // Samples are 0.5 s apart from 1.5 s in; the first window ends by 2 s, so
    // more than 3 s without status is a real gap, not the window.
    assert(
      firstReported <= 6,
      `${label}: the live background was missing from status for ${firstReported} samples`
    )
    if (firstReported > 0) {
      console.log(
        `${label}: ${firstReported}/${samples.length} samples came before the new run's first status`
      )
    }
    for (const sample of samples.slice(firstReported)) {
      assert(
        allowed.includes(sample.liveBackground?.rendering),
        `${label}: the live background left ${allowed.join('/')} mid-recording: ${JSON.stringify(sample.liveBackground)}`
      )
    }
    const halved = samples.filter((sample) => sample.liveBackground?.rendering === 'half').length
    if (halved > 0) {
      console.log(`${label}: the guard drew at half size for ${halved}/${samples.length} samples`)
    }
    // The uploads baseline is the first status the session's run published.
    const early = samples[firstReported]
    assert.equal(
      late.framePipeline.immutableTextureUploads,
      early.framePipeline.immutableTextureUploads,
      `${label}: immutable texture uploads grew while the live background showed`
    )
    if (!forced) {
      assert(late.framePipeline.liveBackgroundPrograms > 0, 'the live programs are counted')
      const p95 = late.liveBackground?.p95Ms
      const budget = BUDGET_MS[testCase.height]
      console.log(
        `${label}: p95 ${p95?.toFixed?.(2) ?? 'n/a'} ms (budget ${budget}), load ${loadavg()[0].toFixed(1)}`
      )
      if (process.env.VIDEORC_LIVE_BACKGROUND_SMOKE_SKIP_BUDGET !== '1') {
        assert(
          typeof p95 === 'number' && p95 <= budget,
          `${label}: the live background's p95 ${p95} ms exceeds ${budget} ms (load ${loadavg()[0].toFixed(1)})`
        )
      }
    }
    verifyArtifact(path, testCase, `${label} recording`)
    const quality = await analyzeRecording(path, {
      ffmpegPath,
      ffprobePath,
      intendedFps: testCase.fps,
      expectAudio: true,
      gates: { requireMotion: false }
    })
    assert(quality.verdict.pass, `${path}: ${quality.verdict.failures.join('; ')}`)
    if (target) verifyStream(path, target.receivedPath, testCase, label)
    console.log(`Live background case OK: ${label}`)
  }

  /**
   * Plan 193: the received stream moves like the recording. Before plan 193 the
   * stream leg drew the poster, so its ring was still while the recording's
   * moved; the cross-check fails a stream that shows a still on either leg.
   */
  function verifyStream(recordingPath, streamPath, testCase, label) {
    verifyArtifact(streamPath, testCase, `${label} stream`)
    const size = probeVideoSize(streamPath)
    assert.deepEqual(
      size,
      { width: testCase.stream.width, height: testCase.stream.height },
      `${label}: the received stream is ${JSON.stringify(size)}`
    )
    const recordingMotion = squareMotion(recordingPath)
    const streamMotion = squareMotion(streamPath)
    console.log(
      `${label}: ring square motion recording ${recordingMotion.toFixed(2)}, stream ${streamMotion.toFixed(2)} per 0.2 s`
    )
    if (forced) {
      assert(
        streamMotion < 0.75,
        `${streamPath}: a forced still must not move on the stream (${streamMotion})`
      )
      return
    }
    const ratio = streamMotion / Math.max(recordingMotion, 0.01)
    assert(
      ratio >= 0.5 && ratio <= 2,
      `${label}: the stream's ring moves ${streamMotion.toFixed(2)} against the recording's ${recordingMotion.toFixed(2)} (ratio ${ratio.toFixed(2)}, want 0.5–2)`
    )
  }

  function verifyArtifact(path, testCase, label) {
    assert(path && existsSync(path) && statSync(path).size > 0, `missing artifact ${path}`)
    const ring = grayTimeline(path, RING)
    const stage = grayTimeline(path, STAGE)
    const steps = ring.slice(1).map((frame, index) => meanAbsDiff(frame, ring[index]))
    const motion = steps.reduce((sum, value) => sum + value, 0) / steps.length
    console.log(`${label}: ring motion ${motion.toFixed(2)} per 0.5 s`)
    if (forced) {
      assert(motion < 0.75, `${path}: a forced still must not move (ring motion ${motion})`)
    } else {
      // Line Waves' thin lines average away in the 16 × 16 thumbnail (about
      // 1 per 0.5 s); the finer square still sees them (about 3.7 per 0.2 s).
      const fine = motion > 1 ? null : squareMotion(path)
      // Plan 194: Beams drifts slowly over a dark ring at Calm (about 0.2 per
      // 0.5 s), but across the take the ring still changes (about 3 in 5 s).
      const drift = motion > 1 || fine > 1 ? null : ringDrift(path)
      console.log(
        `${label}: ring square ${fine?.toFixed(2)}, drift across the take ${drift?.toFixed(2)}`
      )
      assert(
        motion > 1 || fine > 1 || drift > 1.5,
        `${path}: the live background ring does not move (motion ${motion}, square ${fine}, drift ${drift})`
      )
      // A slow background (Beams, Color Bends: every frame changes, by 0.03
      // to 0.2) stays under freezedetect's noise floor for half a second; a
      // stall still shows over two.
      const freezes = freezeStarts(path, RING, motion < 2 ? 2 : 0.5)
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

function sessionParams(outputDirectoryCapability, testCase, target) {
  const params = {
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
    layout: LAYOUT,
    output: {
      recordEnabled: true,
      streamEnabled: Boolean(target),
      outputDirectoryCapability,
      video: {
        preset: 'custom',
        width: testCase.width,
        height: testCase.height,
        fps: testCase.fps,
        bitrateKbps: testCase.height > 1080 ? 20000 : 8000
      },
      rtmp: target
        ? { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
        : { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
  if (!target) return params
  // Plan 193: one custom RTMP destination at a stream-safe preset, the shape
  // the comment-highlight stream smoke uses.
  const timestamp = '2026-01-01T00:00:00.000Z'
  const preset = `stream-safe-${testCase.stream.height}p${testCase.stream.fps}`
  return {
    ...params,
    streaming: {
      enabled: true,
      mode: 'single',
      targets: [
        {
          id: target.id,
          platform: 'custom',
          label: target.label,
          enabled: true,
          serverUrl: target.serverUrl,
          urlMode: 'server-and-key',
          streamKey: target.streamKey,
          streamKeyPresent: true,
          authMode: 'manual-rtmp',
          outputPreset: preset,
          outputBitrateKbps: 6000,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ],
      selectedTargetId: target.id,
      defaultOutputPreset: preset,
      defaultBitrateKbps: 6000,
      enabledTargetIds: [target.id]
    },
    captions: { burnTarget: 'off', position: 'bottom', textSize: 'm' }
  }
}

function widthFor(height) {
  return Math.round((height * 16) / 9)
}

function caseLabel({ id, height, fps, stream }) {
  return `${id} ${height}p${fps}${stream ? ` + stream ${stream.height}p${stream.fps}` : ''}`
}

function rtmpTarget(testCase, index) {
  const port = RTMP_BASE_PORT + index
  const streamKey = `live-background-${index}`
  return {
    id: `live-background-${index}`,
    label: `Local ${caseLabel(testCase)}`,
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    streamKey,
    listenUrl: `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    receivedPath: join(outputDirectory, `stream-received-${index}-${testCase.id}.flv`)
  }
}

function spawnRtmpListener(target) {
  const stderr = []
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
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.receivedPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => stderr.push(text))
  return { process: child, stderr }
}

async function stopRtmpListener(listener) {
  const child = listener?.process
  if (!child?.pid || child.exitCode !== null) return
  // The listener ends by itself when the session closes its RTMP connection.
  await waitForExit(child, 3000)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 1000)
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForExit(child, 1000)
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeout)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

function probeVideoSize(path) {
  const probe = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      path
    ],
    { encoding: 'utf8' }
  )
  const match = /^(\d+)x(\d+)/.exec(String(probe.stdout).trim())
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/** Plan 193: mean frame-to-frame change of the ring square, 64 × 64 at 5 per second. */
function squareMotion(path) {
  const frames = grayTimeline(path, RING_SQUARE, { size: 64, fps: 5 })
  const steps = frames.slice(1).map((frame, index) => meanAbsDiff(frame, frames[index]))
  return steps.reduce((sum, value) => sum + value, 0) / steps.length
}

/** Plan 194: how far the ring moves from the take's first sample to its last (64 × 64). */
function ringDrift(path) {
  const frames = grayTimeline(path, RING, { size: 64, fps: 2 })
  return meanAbsDiff(frames[0], frames.at(-1))
}

/** A grey thumbnail of a rect (16×16, every 0.5 s unless told otherwise). */
function grayTimeline(path, rect, { size = 16, fps = 2 } = {}) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `fps=${fps},crop=iw*${rect.w}:ih*${rect.h}:iw*${rect.x}:ih*${rect.y},scale=${size}:${size},format=gray`,
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 }
  )
  assert(result.status === 0, `${path}: ffmpeg failed: ${result.stderr?.toString() ?? ''}`)
  const frameBytes = size * size
  const frames = []
  for (let offset = 0; offset + frameBytes <= result.stdout.length; offset += frameBytes) {
    frames.push(result.stdout.subarray(offset, offset + frameBytes))
  }
  assert(frames.length >= fps + 2, `${path}: too few frames sampled (${frames.length})`)
  // Skip the first second (start transient).
  return frames.slice(fps)
}

function meanAbsDiff(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / a.length
}

/** freezedetect over the ring: any freeze longer than `seconds` (half a second). */
function freezeStarts(path, rect, seconds = 0.5) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-i',
      path,
      '-vf',
      `crop=iw*${rect.w}:ih*${rect.h}:iw*${rect.x}:ih*${rect.y},freezedetect=n=0.002:d=${seconds}`,
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
