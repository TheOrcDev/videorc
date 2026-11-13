// Plan 232 S6: an HTML overlay end to end through the dev app. Imports the
// animated badge fixture as a folder (its page, stylesheet and script), then
// in one session per mode (recording, streaming to local receivers horizontal
// + vertical, both at once, which is the aux leg) puts a red takeover under
// it, shows it, lets it run, hides it and stops. Every artifact is sampled
// with ffmpeg at the overlay's four known blocks:
//   a  opaque magenta: the overlay is on the picture;
//   b  half-alpha cyan: blended with the takeover (grey), never full cyan;
//   c  nothing: the takeover shows through (red), so alpha survived and no
//      network request got an answer (the page would paint it green);
//   d  yellow and blue in turn: the page is alive, and its stylesheet and
//      script loaded from the overlay's own folder.
// It is absent before Show and after Hide, the session never restarts, the
// page never renders above 30 fps, a local listener the page tries to reach
// hears nothing, and the A/V analyzer passes. A last session (full-frame)
// records and streams 1080p with the overlay across the whole canvas, the
// largest frame an overlay sends (1920 x 1080), under the same checks: its
// numbers are the measured worst case. Nothing goes live anywhere.
//
// It runs on macOS, Windows and Linux (plan 232 S11). Linux streams the
// horizontal leg only, as smoke:banners does: the platform has no vertical
// simulcast leg (`htmlOverlaySmokeStreamOrientations`).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
import { htmlOverlaySmokeStreamOrientations } from './lib/html-overlay-smoke-plan.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const streamOrientations = htmlOverlaySmokeStreamOrientations(process.platform)
console.log(
  `HTML overlay smoke on ${process.platform}: streams ${streamOrientations.join(' + ')} (plan 232 S11).`
)

const repoRoot = resolve(import.meta.dirname, '..')
const fixtureDirectory = join(repoRoot, 'scripts', 'fixtures', 'html-overlay', 'animated-badge')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-html-overlay-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-html-overlay-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
/** Before Show and after Hide: several 0.25 s samples. */
const PHASE_MS = 1500
/** The overlay on the picture: more than two turns of its two-second blink. */
const SHOWN_MS = 5000
/** The port the fixture's page tries to reach (`badge.js`). It must hear nothing. */
const NETWORK_PROBE_PORT = 13977

// Fixture colours (RGB). The takeover under the overlay is solid red, so the
// hole reads red and half-alpha cyan over it reads grey.
const MAGENTA = [255, 0, 255]
const TAKEOVER = [255, 0, 0]
const YELLOW = [255, 255, 0]
const BLUE = [0, 0, 255]
const NETWORK_REACHED = [0, 255, 0]

// Where the smoke puts the overlay. Each rect has the page's own 16:9 shape
// on its canvas, so the picture fills it: half the horizontal canvas, and
// 80 % of the vertical one's width. On the vertical stream the takeover is
// fitted into a band across the middle (0.342 to 0.658 of the height), with
// letterbox above and below: the overlay's four blocks (the top half of its
// rect) sit inside that band, so the picture under them is the takeover.
const HORIZONTAL_PLACE = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
const VERTICAL_PLACE = { x: 0.1, y: 0.37, w: 0.8, h: 0.253125 }
/** The whole canvas: on 1080p the overlay's frame is the cap, 1920 x 1080. */
const FULL_FRAME_PLACE = { x: 0, y: 0, w: 1, h: 1 }
const MODES = ['recording', 'streaming', 'both', 'full-frame']

mkdirSync(outputDirectory, { recursive: true })

let stopApp = async () => {}
const listeners = []
const networkProbe = { connections: 0, server: null }
const cost = { modes: {} }

try {
  // The folder is imported from inside the smoke's own state directory.
  const overlayDirectory = join(outputDirectory, 'animated-badge')
  cpSync(fixtureDirectory, overlayDirectory, { recursive: true })
  const takeoverPath = join(outputDirectory, 'takeover-red.png')
  createPng(takeoverPath, 'color=c=red:s=640x360', 'format=rgb24')
  await startNetworkProbe()

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
      // The Banners dir (and the overlay's folder in it) sits beside the database.
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

    for (const old of await request(ws, timeoutMs, 'banners.list')) {
      await request(ws, timeoutMs, 'banners.delete', { id: old.id })
    }

    // Import the folder. The import shows the overlay (plan 205 D3), so the
    // idle Preview is the first place it runs.
    const overlay = await importOverlay(overlayDirectory)
    assert.equal(overlay.kind, 'html', 'the import is an HTML overlay')
    assert.deepEqual(
      [overlay.width, overlay.height],
      [640, 360],
      'the page size comes from the videorc-overlay-size meta tag'
    )
    assert.equal(overlay.shown, true, 'an import shows the new overlay')
    assert.equal(overlay.name, 'animated-badge')
    await waitForOverlayLive(overlay.id, 'in the idle Preview')

    // D7: the page renders at the compositor's rate, never above 30 fps.
    const idleRate = await measureFrameRate(2000)
    assert(
      idleRate.fps > 5 && idleRate.fps <= 31,
      `the idle overlay must render between 5 and 30 fps, got ${idleRate.fps.toFixed(1)}`
    )
    cost.idle = idleRate

    // D10: its own picture becomes the stored image and thumbnail.
    const pictureDeadline = Date.now() + 15_000
    while (true) {
      const loaded = await requestSmokeCommand(
        smoke,
        'eval-js',
        {
          code: `const response = await fetch(${JSON.stringify(`videorc-asset://banner/${overlay.thumbnailFile}`)}); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }`
        },
        { timeoutMs }
      )
      if (loaded.result?.status === 200 && loaded.result?.bytes > 0) break
      assert(
        Date.now() < pictureDeadline,
        `the overlay's picture was never saved as its thumbnail (${JSON.stringify(loaded.result)})`
      )
      await sleep(500)
    }

    let sawBlockedRequests = 0
    // One mode, or several separated by commas (a mode may repeat, which
    // gives interleaved cost samples: `both,full-frame,both,full-frame`).
    const modes = process.env.VIDEORC_HTML_OVERLAY_SMOKE_MODE
      ? process.env.VIDEORC_HTML_OVERLAY_SMOKE_MODE.split(',').map((mode) => mode.trim())
      : MODES
    for (const [run, mode] of modes.entries()) {
      assert(MODES.includes(mode), `unknown HTML overlay smoke mode: ${mode}`)
      const horizontalPlace = mode === 'full-frame' ? FULL_FRAME_PLACE : HORIZONTAL_PLACE
      // Reset between modes: hidden, in this mode's place, no takeover.
      await request(ws, timeoutMs, 'banners.hide', {})
      await request(ws, timeoutMs, 'banners.update', {
        id: overlay.id,
        horizontal: horizontalPlace,
        vertical: VERTICAL_PLACE
      })
      await request(ws, timeoutMs, 'screens.clear')
      for (const old of await request(ws, timeoutMs, 'screens.list')) {
        await request(ws, timeoutMs, 'screens.delete', { screenId: old.id })
      }
      await waitForNoTargets()
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
          : streamOrientations.map((orientation, i) => {
              const vertical = orientation === 'vertical'
              const port = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13945) + i
              return {
                id: `html-overlay-${i}`,
                platform: 'custom',
                label: `HTML overlay ${i}`,
                enabled: true,
                serverUrl: `rtmp://127.0.0.1:${port}/live`,
                streamKey: 'overlay',
                urlMode: 'server-and-key',
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                outputOrientation: vertical ? 'vertical' : 'horizontal',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                port,
                recvPath: join(outputDirectory, `${mode}-${run}-${i}.flv`)
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
        if (targets.some((target) => target.outputOrientation === 'vertical')) {
          params.simulcast = {
            layout: {
              ...params.layout,
              layoutPreset: 'vertical-camera-bottom',
              verticalScreenFraming: 'fit'
            },
            video: { preset: 'custom', width: 360, height: 640, fps: 30, bitrateKbps: 2000 }
          }
        }
      }
      const started = await request(ws, timeoutMs, 'session.start', params)
      const sessionId = started.sessionId
      assert(sessionId && ['recording', 'streaming'].includes(started.state), 'session must run')

      // Phase A: the takeover, no overlay. Phase B: the overlay over it.
      // Phase C: hidden again.
      const takeover = await importTakeover(takeoverPath)
      await request(ws, timeoutMs, 'screens.activate', { screenId: takeover.id })
      await sleep(PHASE_MS) // Deliberate artifact coverage, not a readiness handshake.
      const before = await request(ws, 2000, 'compositor.status')
      await withFrameContinuity(() => request(ws, timeoutMs, 'banners.show', { id: overlay.id }))
      const live = await waitForOverlayLive(overlay.id, `in the ${mode} session`)
      const sessionRate = await measureFrameRate(SHOWN_MS)
      assert(
        sessionRate.fps > 5 && sessionRate.fps <= 31,
        `${mode}: the overlay must render between 5 and 30 fps, got ${sessionRate.fps.toFixed(1)}`
      )
      const during = await request(ws, 2000, 'compositor.status')
      const overlayStatus = await overlayStatusOf(overlay.id)
      sawBlockedRequests = Math.max(sawBlockedRequests, overlayStatus?.blockedRequests ?? 0)
      await withFrameContinuity(() => request(ws, timeoutMs, 'banners.hide', { id: overlay.id }))
      await sleep(PHASE_MS)
      await request(ws, timeoutMs, 'screens.clear')
      await assertSameRunningSession(ws, sessionId)
      const stopped = await request(ws, timeoutMs, 'session.stop')
      cost.modes[modes.indexOf(mode) === run ? mode : `${mode} (run ${run + 1})`] = {
        frame: [live.frameWidth, live.frameHeight],
        overlayFps: round(sessionRate.fps),
        megabytesPerSecond: round(sessionRate.megabytesPerSecond),
        convertMsPerFrame: round(sessionRate.convertMsPerFrame, 3),
        compositorFrameTimeP95MsBefore: before.frameTimeP95Ms ?? null,
        compositorFrameTimeP95MsWithOverlay: during.frameTimeP95Ms ?? null,
        compositorRenderFpsWithOverlay: during.renderFps ?? null,
        compositorDroppedFramesWhileShown: during.droppedFrames - before.droppedFrames
      }

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
      for (const artifact of artifacts) {
        await verifyArtifact(artifact, mode, horizontalPlace)
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
      console.log(`HTML overlay smoke PASS: ${mode}`)
    }

    // D5: the page asked for the network (a fetch, an image, a WebSocket to
    // the listener below) and was told no.
    assert.equal(
      networkProbe.connections,
      0,
      `the overlay reached the network: ${networkProbe.connections} connection(s) to the probe`
    )
    assert(
      sawBlockedRequests >= 1,
      "the overlay's blocked network requests were never reported in its status"
    )

    // D4: a page gone is a page that stops; Delete removes its folder.
    await request(ws, timeoutMs, 'banners.hide', {})
    await request(ws, timeoutMs, 'banners.delete', { id: overlay.id })
    await waitForNoTargets()

    const backend = await request(ws, timeoutMs, 'htmlOverlays.stats')
    const host = await requestSmokeCommand(smoke, 'html-overlay-stats', {}, { timeoutMs })
    cost.backend = backend
    cost.main = host.stats
    cost.blockedRequests = sawBlockedRequests
    if (host.stats?.framesSent > 0) {
      cost.mainCopyMsPerFrame = round(host.stats.copyMs / host.stats.framesSent, 3)
      cost.mainWriteMsPerFrame = round(host.stats.writeMs / host.stats.framesSent, 3)
    }
    writeFileSync(join(outputDirectory, 'html-overlay-cost.json'), JSON.stringify(cost, null, 2))
    console.log(`HTML overlay measured cost: ${JSON.stringify(cost)}`)

    async function importOverlay(path) {
      const capability = await requestSmokeCommand(
        smoke,
        'authorize-smoke-resource',
        { path, kind: 'input-directory' },
        { timeoutMs }
      )
      // One import at a time process-wide (the AssetImport lane), shared with
      // the first launch's starter-sound seeding.
      const busyUntil = Date.now() + 30_000
      while (true) {
        try {
          return await withFrameContinuity(() =>
            request(ws, timeoutMs, 'banners.importHtml', {
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
    async function overlayStatusOf(id) {
      const { overlays } = await request(ws, timeoutMs, 'htmlOverlays.status.get')
      return overlays.find((status) => status.id === id) ?? null
    }
    /** The page loaded and its frames reach the compositor. */
    async function waitForOverlayLive(id, where) {
      const deadline = Date.now() + 20_000
      let last = null
      while (Date.now() < deadline) {
        last = await overlayStatusOf(id)
        if (last?.state === 'live') return last
        assert(
          last?.state !== 'failed' && last?.state !== 'unavailable',
          `the overlay could not run ${where}: ${last?.detail}`
        )
        await sleep(100)
      }
      throw new Error(`the overlay never went live ${where}: ${JSON.stringify(last)}`)
    }
    /** Hidden: main renders nothing (its window is gone). */
    async function waitForNoTargets() {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const { targets } = await request(ws, timeoutMs, 'htmlOverlays.targets.get')
        if (targets.length === 0) return
        await sleep(100)
      }
      throw new Error('a hidden overlay was still being rendered')
    }
    /** Frames the backend stored over `ms`, and what converting them cost. */
    async function measureFrameRate(ms) {
      const from = await request(ws, timeoutMs, 'htmlOverlays.stats')
      const startedAt = Date.now()
      await sleep(ms)
      const to = await request(ws, timeoutMs, 'htmlOverlays.stats')
      const seconds = (Date.now() - startedAt) / 1000
      const frames = to.framesReceived - from.framesReceived
      return {
        frames,
        fps: frames / seconds,
        megabytesPerSecond: (to.bytesReceived - from.bytesReceived) / seconds / 1e6,
        convertMsPerFrame: frames > 0 ? (to.convertMicros - from.convertMicros) / frames / 1000 : 0
      }
    }
    async function importTakeover(path) {
      const oldIds = new Set((await request(ws, timeoutMs, 'screens.list')).map((s) => s.id))
      await requestSmokeCommand(smoke, 'import-takeover-image', { path }, { timeoutMs })
      const added = (await request(ws, timeoutMs, 'screens.list')).filter((s) => !oldIds.has(s.id))
      assert.equal(added.length, 1, 'the takeover import must publish exactly one takeover')
      return added[0]
    }
    // Sample DURING the work: the compositor must keep publishing fresh
    // frames while a page loads and its first frames arrive.
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
            `Compositor frame became stale around an overlay change: ${status.frameAgeMs}ms`
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
  await new Promise((resolveClose) =>
    networkProbe.server ? networkProbe.server.close(() => resolveClose()) : resolveClose()
  )
}

/** The four blocks of the fixture's top half inside the overlay's rect. */
function blockRects(rect) {
  return [0, 1, 2, 3].map((index) => ({
    x: rect.x + (rect.w * index) / 4,
    y: rect.y,
    w: rect.w / 4,
    h: rect.h / 2
  }))
}

/**
 * The pixel checks for one artifact. `output` is `recording`, `stream`
 * (horizontal receiver) or `vertical` (the vertical stream receiver).
 */
async function verifyArtifact({ path, output }, mode, horizontalPlace) {
  assert(
    path && existsSync(path),
    `HTML overlay smoke output was not created: ${path ?? 'missing'}`
  )
  assert(statSync(path).size > 0, `HTML overlay smoke output is empty: ${path}`)
  const rects = blockRects(output === 'vertical' ? VERTICAL_PLACE : horizontalPlace)
  const samples = await sampleTimeline(path, rects)
  const describe = () =>
    samples
      .map(
        ({ seconds, rgb }) =>
          `${seconds.toFixed(2)}s=[${rgb.map((value) => `(${value.join(',')})`).join(' ')}]`
      )
      .join('\n')
  const [A, B, C, D] = [0, 1, 2, 3]
  const where = `${path} (${mode}, ${output})`

  // Absent before Show.
  assert(
    !near(samples[0].rgb[A], MAGENTA),
    `${where}: the overlay showed before it was shown\n${describe()}`
  )
  const shown = samples.filter((sample) => near(sample.rgb[A], MAGENTA))
  assert(
    shown.length >= 8,
    `${where}: the overlay showed in ${shown.length} samples, expected at least 8\n${describe()}`
  )
  // The first and last showing samples may sit in the 200 ms fade.
  const settled = shown.slice(1, -1)
  for (const sample of settled) {
    const at = `${where} at ${sample.seconds.toFixed(2)}s`
    // c: nothing drawn, so the takeover shows through. Alpha survived.
    assert(
      !near(sample.rgb[C], NETWORK_REACHED),
      `${at}: the overlay reached the network (its hole turned green)\n${describe()}`
    )
    assert(
      near(sample.rgb[C], TAKEOVER),
      `${at}: the overlay's transparent hole does not show the picture under it\n${describe()}`
    )
    // b: blended, never thresholded to full cyan or to nothing.
    assert(
      !isFullCyan(sample.rgb[B]),
      `${at}: the half-transparent block was drawn opaque\n${describe()}`
    )
    assert(
      isHalfCyanOverRed(sample.rgb[B]),
      `${at}: the half-transparent block was not blended with the picture\n${describe()}`
    )
  }
  // d: the page is alive, with its stylesheet and script from its own folder.
  assert(
    settled.some((sample) => near(sample.rgb[D], YELLOW)),
    `${where}: the blinking block never read yellow (the page did not run)\n${describe()}`
  )
  assert(
    settled.some((sample) => near(sample.rgb[D], BLUE)),
    `${where}: the blinking block never read blue (the overlay is a frozen frame)\n${describe()}`
  )
  // Gone after Hide.
  assert(
    !near(samples.at(-1).rgb[A], MAGENTA),
    `${where}: the overlay was still showing after Hide\n${describe()}`
  )
  // A frame of the overlay for the PR: what a viewer saw.
  const middle = settled[Math.floor(settled.length / 2)]
  const grab = join(outputDirectory, `frame-${mode}-${output}.png`)
  const grabbed = await runCapture(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    middle.seconds.toFixed(2),
    '-i',
    path,
    '-frames:v',
    '1',
    grab
  ])
  assert.equal(grabbed.status, 0, `Could not save a frame of ${path}: ${grabbed.stderr}`)
  console.log(`HTML overlay artifact OK (${mode}, ${output}): ${path} (frame: ${grab})`)
}

function near(rgb, target, tolerance = 70) {
  return rgb.every((value, index) => Math.abs(value - target[index]) <= tolerance)
}
function isHalfCyanOverRed(rgb) {
  // Straight-alpha source-over of (0,255,255) at a = 0.5 on (255,0,0) is
  // (128,128,128); encoding moves it a little.
  return rgb.every((value) => value >= 80 && value <= 190) && Math.abs(rgb[1] - rgb[2]) < 50
}
function isFullCyan(rgb) {
  return rgb[0] < 90 && rgb[1] > 210 && rgb[2] > 210
}
function round(value, digits = 1) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/** Any connection at all is the overlay reaching out. */
function startNetworkProbe() {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer((socket) => {
      networkProbe.connections += 1
      socket.destroy()
    })
    server.once('error', rejectListen)
    server.listen(NETWORK_PROBE_PORT, '127.0.0.1', () => {
      networkProbe.server = server
      resolveListen()
    })
  })
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

/** One child process, read to the end without blocking the event loop. */
function runCapture(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) =>
      resolvePromise({ status: null, stdout: Buffer.alloc(0), stderr: String(error) })
    )
    child.on('close', (status) =>
      resolvePromise({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString()
      })
    )
  })
}

/** One frame, the mean colour of the middle fifth of each rect. */
async function sampleRects(path, seconds, rects) {
  const colours = []
  for (const rect of rects) {
    const cx = rect.x + rect.w * 0.4
    const cy = rect.y + rect.h * 0.4
    const result = await runCapture(ffmpegPath, [
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
    ])
    if (result.status !== 0 || result.stdout.length < 3) {
      throw new Error(`Could not sample ${path} at ${seconds}s: ${result.stderr}`)
    }
    colours.push([result.stdout[0], result.stdout[1], result.stdout[2]])
  }
  return colours
}

async function sampleTimeline(path, rects) {
  const probe = await runCapture(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    path
  ])
  const duration = Number(probe.stdout.toString().trim())
  assert(probe.status === 0 && duration > 0, `${path}: artifact duration must be readable`)
  const samples = []
  for (let seconds = 0.5; seconds < duration - 0.15; seconds += 0.25) {
    try {
      samples.push({ seconds, rgb: await sampleRects(path, seconds, rects) })
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
    `An overlay change appears to have restarted the session: ${[...ids].join(', ')}`
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
