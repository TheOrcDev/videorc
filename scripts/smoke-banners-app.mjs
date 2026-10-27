// Plan 186 S8: banners end to end through the dev app. Imports two banners
// (an opaque wide strip and a half-transparent logo), then in one session per
// mode (recording, streaming to local receivers horizontal + vertical, both)
// shows the strip, moves it, shows the logo with "Appears in: Recording" off,
// puts a takeover under them, hides everything and stops. Every artifact is
// sampled with ffmpeg at the banners' own rects (read back from
// banners.list, per canvas orientation): the strip appears, moves and leaves;
// the logo follows the leg plan and is blended (not thresholded) over the
// takeover; banners stay above the takeover; the session never restarts; the
// compositor keeps rendering while banners prepare; the A/V analyzer passes.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import {
  isRetryableSmokeCommandError,
  requestSmokeCommand,
  requestSmokeCommandWithRetry
} from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-banners-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-banners-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
/** Each phase stays on the picture this long: several 0.25 s samples. */
const PHASE_MS = 1500

// Fixture colours (RGB). The strip is opaque magenta; the logo is cyan at
// 50 % alpha; the takeover is solid red. Cyan at half alpha over red reads
// grey: proof of a real blend, not an alpha threshold.
const STRIP = [255, 0, 255]
const TAKEOVER = [255, 0, 0]
/** A spot no banner covers: the takeover check reads it. */
const OPEN_AREA = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 }

mkdirSync(outputDirectory, { recursive: true })

let stopApp = async () => {}
const listeners = []

try {
  const stripPath = join(outputDirectory, 'banner-strip.png')
  const logoPath = join(outputDirectory, 'banner-logo.png')
  const takeoverPath = join(outputDirectory, 'takeover-red.png')
  createPng(stripPath, 'color=c=magenta:s=2400x400', 'format=rgba')
  createPng(logoPath, 'color=c=cyan:s=512x512', 'format=rgba,colorchannelmixer=aa=0.5')
  createPng(takeoverPath, 'color=c=red:s=640x360', 'format=rgb24')

  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '0',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      // The Banners dir sits beside the database, like Screens.
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  const connection = launch.connections['backend-ready']
  const smoke = launch.connections['preview-motion-ready']
  const ws = await connectBackend(connection, timeoutMs)
  const statuses = []
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message?.event === 'recording.status') statuses.push(message.payload)
    } catch {
      // Ignore unrelated smoke output.
    }
  })

  try {
    // A fresh profile shows the first-run placeholder, with no sidebar, until
    // the first-run decision arrives (plan 203). The command is idempotent.
    await requestSmokeCommandWithRetry(
      smoke,
      'enable-synthetic-source',
      { settleMs: 0 },
      {
        timeoutMs: 30_000,
        requestTimeoutMs: timeoutMs,
        isRetryable: (error) =>
          isRetryableSmokeCommandError(error) ||
          String(error?.message ?? error).includes('Could not find tab ')
      }
    )
    await requestSmokeCommand(smoke, 'preview-window-open', {}, { timeoutMs })
    const previewDeadline = Date.now() + timeoutMs
    while (true) {
      const status = await request(ws, 2000, 'compositor.status')
      if (status.framesRendered > 0 && Number.isFinite(status.frameAgeMs)) break
      assert(Date.now() < previewDeadline, 'Synthetic preview did not publish its first frame')
      await sleep(50)
    }

    // Import both banners once; refusals are proven in the backend tests.
    for (const old of await request(ws, timeoutMs, 'banners.list')) {
      await request(ws, timeoutMs, 'banners.delete', { id: old.id })
    }
    const strip = await importBanner(stripPath)
    const logo = await importBanner(logoPath)
    // Plan 205 D3: a banner you add shows while it fits the cap and session.
    assert.equal(strip.shown, true, 'an import shows the new banner')
    assert.equal(logo.shown, true, 'a second import shows too (under the cap)')
    assert.equal(strip.hasAlpha, false, 'the opaque strip has no alpha')
    assert.equal(logo.hasAlpha, true, 'the half-transparent logo keeps its alpha')
    assert.deepEqual([strip.width, strip.height], [2400, 400])
    assert.deepEqual([logo.width, logo.height], [512, 512])
    // Release test 146, plan 0005: main serves videorc-asset://banner from the
    // backend's own Banners folder. This smoke's profile keeps the backend's
    // data and Electron's userData apart (as Linux always does), so a resolver
    // that assumes userData answers 404 here.
    for (const banner of [strip, logo]) {
      const url = `videorc-asset://banner/${banner.imageFile}`
      const loaded = await requestSmokeCommand(
        smoke,
        'eval-js',
        {
          code: `const response = await fetch(${JSON.stringify(url)}); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }`
        },
        { timeoutMs }
      )
      assert.equal(loaded.result?.status, 200, `${url} must load in the renderer`)
      assert(loaded.result?.bytes > 0, `${url} must not be empty`)
    }
    const stripHome = strip.horizontal
    const stripMoved = { ...stripHome, x: 0.0225, y: 0.04 }

    const modes = process.env.VIDEORC_BANNERS_SMOKE_MODE
      ? [process.env.VIDEORC_BANNERS_SMOKE_MODE]
      : ['recording', 'streaming', 'both']
    for (const mode of modes) {
      assert(['recording', 'streaming', 'both'].includes(mode), 'unknown banners smoke mode')
      // Reset between modes: every banner hidden, strip home, logo switches.
      await request(ws, timeoutMs, 'banners.hide', {})
      await request(ws, timeoutMs, 'screens.clear')
      await request(ws, timeoutMs, 'banners.update', { id: strip.id, horizontal: stripHome })
      await request(ws, timeoutMs, 'banners.update', {
        id: logo.id,
        showOnStream: true,
        showInRecording: false
      })
      for (const old of await request(ws, timeoutMs, 'screens.list')) {
        await request(ws, timeoutMs, 'screens.delete', { screenId: old.id })
      }
      const recordingDirectory = await requestSmokeCommand(
        smoke,
        'authorize-smoke-resource',
        { path: outputDirectory, kind: 'output-directory' },
        { timeoutMs }
      )
      statuses.length = 0
      const targets =
        mode === 'recording'
          ? []
          : (process.platform === 'linux' ? [false] : [false, true]).map((vertical, i) => {
              const port = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13935) + i
              return {
                id: `banner-${i}`,
                platform: 'custom',
                label: `Banners ${i}`,
                enabled: true,
                serverUrl: `rtmp://127.0.0.1:${port}/live`,
                streamKey: 'banners',
                urlMode: 'server-and-key',
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                outputOrientation: vertical ? 'vertical' : 'horizontal',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                port,
                recvPath: join(outputDirectory, `${mode}-${i}.flv`)
              }
            })
      const receivers = []
      for (const target of targets) {
        const receiver = startReceiver(target)
        receivers.push(receiver)
        listeners.push(receiver)
        await waitForOwnedTcpListener({
          child: receiver.child,
          port: target.port,
          timeoutMs: 8000,
          diagnostics: () => receiver.log
        })
      }
      const params = sessionParams(recordingDirectory.capabilityId)
      params.output.recordEnabled = mode !== 'streaming'
      params.output.streamEnabled = mode !== 'recording'
      if (targets.length) {
        params.output.video = {
          preset: 'tutorial-1080p30',
          width: 1920,
          height: 1080,
          fps: 30,
          bitrateKbps: 6000
        }
        params.output.rtmp = {
          preset: 'custom',
          serverUrl: targets[0].serverUrl,
          streamKey: targets[0].streamKey
        }
        params.streaming = {
          enabled: true,
          mode: 'multi',
          targets: targets.map(({ port, recvPath, ...target }) => target),
          enabledTargetIds: targets.map((target) => target.id),
          defaultOutputPreset: 'tutorial-1080p30',
          defaultBitrateKbps: 6000
        }
        if (targets.some((target) => target.outputOrientation === 'vertical'))
          params.simulcast = {
            layout: {
              ...params.layout,
              layoutPreset: 'vertical-camera-bottom',
              verticalScreenFraming: 'fit'
            },
            video: { preset: 'custom', width: 360, height: 640, fps: 30, bitrateKbps: 2000 }
          }
      }
      const started = await request(ws, timeoutMs, 'session.start', params)
      const sessionId = started.sessionId
      assert(sessionId && ['recording', 'streaming'].includes(started.state), 'session must run')

      // Phase A: nothing. Phase B: the strip at home. Phase C: the strip
      // moved. Phase D: the logo too. Phase E: a takeover under both.
      // Phase F: everything hidden.
      await sleep(PHASE_MS) // Deliberate artifact coverage, not a readiness handshake.
      await withFrameContinuity(() => request(ws, timeoutMs, 'banners.show', { id: strip.id }))
      await sleep(PHASE_MS)
      await withFrameContinuity(() =>
        request(ws, timeoutMs, 'banners.update', { id: strip.id, horizontal: stripMoved })
      )
      await sleep(PHASE_MS)
      await withFrameContinuity(() => request(ws, timeoutMs, 'banners.show', { id: logo.id }))
      await sleep(PHASE_MS)
      const takeover = await importTakeover(takeoverPath)
      await request(ws, timeoutMs, 'screens.activate', { screenId: takeover.id })
      await sleep(PHASE_MS)
      await request(ws, timeoutMs, 'screens.clear')
      await request(ws, timeoutMs, 'banners.hide', {})
      await sleep(PHASE_MS)
      await assertSameRunningSession(ws, sessionId)
      const stopped = await request(ws, timeoutMs, 'session.stop')

      const artifacts = []
      if (mode !== 'streaming') {
        artifacts.push({
          path: await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 }),
          output: 'recording'
        })
      }
      for (const [index, receiver] of receivers.entries()) {
        await waitForExit(receiver, 15000)
        artifacts.push({
          path: receiver.path,
          output: targets[index].outputOrientation === 'vertical' ? 'vertical' : 'stream'
        })
      }
      const [stripNow, logoNow] = await Promise.all([bannerById(strip.id), bannerById(logo.id)])
      for (const artifact of artifacts) {
        verifyArtifact(artifact, mode, { strip: stripNow, stripHome, stripMoved, logo: logoNow })
        assertOneSession(statuses, sessionId)
        const quality = await analyzeRecording(artifact.path, {
          ffmpegPath,
          ffprobePath,
          intendedFps: 30,
          expectAudio: true,
          gates: { requireMotion: false }
        })
        assert(quality.verdict.pass, `${artifact.path}: ${quality.verdict.failures.join('; ')}`)
      }
      console.log(`Banners smoke PASS: ${mode}`)
    }

    async function importBanner(path) {
      const capability = await requestSmokeCommand(
        smoke,
        'authorize-smoke-resource',
        { path, kind: 'input-file' },
        { timeoutMs }
      )
      // One import at a time process-wide (the AssetImport lane), shared
      // with the first launch's starter-sound seeding. "Already being
      // imported" means try again, so wait for the lane.
      const busyUntil = Date.now() + 30_000
      while (true) {
        try {
          return await withFrameContinuity(() =>
            request(ws, timeoutMs, 'banners.importImage', {
              sourceCapability: capability.capabilityId
            })
          )
        } catch (error) {
          if (!/already being imported/.test(error?.message ?? '') || Date.now() > busyUntil) {
            throw error
          }
          await sleep(200)
        }
      }
    }
    async function bannerById(id) {
      const banner = (await request(ws, timeoutMs, 'banners.list')).find((b) => b.id === id)
      assert(banner, `banner ${id} disappeared`)
      return banner
    }
    async function importTakeover(path) {
      const oldIds = new Set((await request(ws, timeoutMs, 'screens.list')).map((s) => s.id))
      await requestSmokeCommand(smoke, 'import-takeover-image', { path }, { timeoutMs })
      const added = (await request(ws, timeoutMs, 'screens.list')).filter((s) => !oldIds.has(s.id))
      assert.equal(added.length, 1, 'the takeover import must publish exactly one takeover')
      return added[0]
    }
    // Sample DURING the work (a decode and Lanczos scale may run): the
    // compositor must keep publishing fresh frames the whole time.
    async function withFrameContinuity(work) {
      let finished = false
      const running = Promise.resolve()
        .then(work)
        .finally(() => {
          finished = true
        })
      const continuity = (async () => {
        const until = Date.now() + 600
        while (!finished || Date.now() < until) {
          const status = await request(ws, 2000, 'compositor.status')
          assert(
            Number.isFinite(status.frameAgeMs) && status.frameAgeMs <= 250,
            `Compositor frame became stale around a banner change: ${status.frameAgeMs}ms`
          )
          await sleep(50)
        }
      })()
      const [result, check] = await Promise.allSettled([running, continuity])
      if (result.status === 'rejected') throw result.reason
      if (check.status === 'rejected') throw check.reason
      return result.value
    }
  } finally {
    await request(ws, timeoutMs, 'session.stop').catch(() => {})
    ws.close()
  }
} finally {
  for (const receiver of listeners) await stopReceiver(receiver)
  await stopApp()
}

/**
 * The pixel checks for one artifact. `output` is `recording`, `stream`
 * (horizontal receiver) or `vertical` (the vertical stream receiver).
 */
function verifyArtifact({ path, output }, mode, banners) {
  assert(path && existsSync(path), `Banners smoke output was not created: ${path ?? 'missing'}`)
  assert(statSync(path).size > 0, `Banners smoke output is empty: ${path}`)
  const vertical = output === 'vertical'
  const stripHomeRect = vertical ? banners.strip.vertical : banners.stripHome
  // The vertical rect is never moved by the smoke: the strip stays there.
  const stripMovedRect = vertical ? banners.strip.vertical : banners.stripMoved
  const logoRect = vertical ? banners.logo.vertical : banners.logo.horizontal
  const samples = sampleTimeline(path, [stripHomeRect, stripMovedRect, logoRect, OPEN_AREA])
  const describe = () =>
    samples
      .map(
        ({ seconds, rgb }) =>
          `${seconds.toFixed(2)}s=[${rgb.map((value) => `(${value.join(',')})`).join(' ')}]`
      )
      .join('\n')
  const at = (sample, index) => sample.rgb[index]
  // Phase B: the strip at home (both orientations).
  const shown = samples.find((sample) => near(at(sample, 0), STRIP))
  assert(shown, `${path}: the strip never showed at its place\n${describe()}`)
  assert(
    !near(at(samples[0], 0), STRIP),
    `${path}: the strip showed before it was shown\n${describe()}`
  )
  if (!vertical) {
    // Phase C: moved to the top left; its home is free again.
    const moved = samples.find(
      (sample) =>
        sample.seconds > shown.seconds && near(at(sample, 1), STRIP) && !near(at(sample, 0), STRIP)
    )
    assert(moved, `${path}: the strip never moved to its new place\n${describe()}`)
  }
  // Phase E: the takeover is on (open area red) and the strip stays above it.
  const overTakeover = samples.find(
    (sample) => near(at(sample, 3), TAKEOVER) && near(at(sample, 1), STRIP)
  )
  assert(overTakeover, `${path}: the strip did not stay above the takeover\n${describe()}`)
  // The logo: "Appears in: Recording" is off. A recording-only session never
  // carries it; with a stream it shows (the primary leg carries it when the
  // recording shares the stream's pixels, the vertical leg always). It is
  // read during the takeover phase, where what lies under it is known to be
  // dark in green and blue (the red takeover, or the vertical stream's
  // letterbox): half-alpha cyan lifts green and blue to about half, never to
  // full cyan (a thresholded blit would read full cyan or nothing).
  const takeoverPhase = samples.filter((sample) => near(at(sample, 3), TAKEOVER))
  assert(takeoverPhase.length > 0, `${path}: the takeover never showed\n${describe()}`)
  const blended = takeoverPhase.some((sample) => isHalfCyanOverDark(at(sample, 2)))
  if (mode === 'recording') {
    assert(
      !takeoverPhase.some(
        (sample) => isHalfCyanOverDark(at(sample, 2)) || isFullCyan(at(sample, 2))
      ),
      `${path}: the logo reached a recording with "Appears in: Recording" off\n${describe()}`
    )
  } else {
    assert(
      !takeoverPhase.some((sample) => isFullCyan(at(sample, 2))),
      `${path}: the half-transparent logo was drawn opaque\n${describe()}`
    )
    assert(blended, `${path}: the half-transparent logo was not blended\n${describe()}`)
  }
  // Phase F: everything hidden at the end.
  const last = samples.at(-1)
  assert(
    !near(at(last, 1), STRIP) && !near(at(last, 0), STRIP),
    `${path}: a banner was still showing after Hide\n${describe()}`
  )
  console.log(`Banners artifact OK (${output}): ${path}`)
}

function near(rgb, target, tolerance = 70) {
  return rgb.every((value, index) => Math.abs(value - target[index]) <= tolerance)
}
function isHalfCyanOverDark(rgb) {
  // Straight-alpha source-over of (0,255,255) at a=0.5 on a background with
  // no green or blue (red, black) puts green and blue near 128; encoding
  // moves them a little.
  const [, green, blue] = rgb
  return green >= 80 && green <= 190 && blue >= 80 && blue <= 190 && Math.abs(green - blue) < 50
}
function isFullCyan(rgb) {
  return rgb[0] < 90 && rgb[1] > 210 && rgb[2] > 210
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

function sampleTimeline(path, rects) {
  const probe = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    { encoding: 'utf8' }
  )
  const duration = Number(probe.stdout.trim())
  assert(probe.status === 0 && duration > 0, `${path}: artifact duration must be readable`)
  const samples = []
  for (let seconds = 0.5; seconds < duration - 0.15; seconds += 0.25) {
    try {
      samples.push({ seconds, rgb: sampleRects(path, seconds, rects) })
    } catch {
      break
    }
  }
  assert(samples.length > 8, `${path}: too few samples (${samples.length})`)
  return samples
}

function assertOneSession(statuses, sessionId) {
  // The Clips ring (a buffer-only session) stops when Record starts and
  // re-arms after Stop; only the recording or stream session counts.
  const ids = new Set(
    statuses
      .filter((status) => status.replayOnly !== true)
      .map((status) => status.sessionId)
      .filter(Boolean)
  )
  assert(
    ids.size === 1 && ids.has(sessionId),
    `A banner change appears to have restarted the session: ${[...ids].join(', ')}`
  )
}

async function assertSameRunningSession(ws, sessionId) {
  const status = await request(ws, timeoutMs, 'recording.status')
  assert(
    status.sessionId === sessionId && ['recording', 'streaming'].includes(status.state),
    `Expected the same running session ${sessionId}, got ${status.sessionId}/${status.state}`
  )
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
