/** Plan 249 S23 `virtual-camera` case: runnable acquisition and analysis.
 *
 * Importing this module launches nothing; only `acquireVirtualCameraCase` does.
 * It needs: a debug backend built from this slice, installed desktop and web
 * dependencies, local LiveKit, Chrome, FFmpeg, and a host where Videorc Camera
 * is registered and readable by another process (macOS: an installed and
 * approved Camera Extension, which needs a signed app; Windows: the one-time
 * setup; Linux: v4l2loopback). No paid egress, no provider.
 *
 * The camera is read from outside the app with the platform's FFmpeg (the
 * reader plan of `smoke:virtual-camera`); only per-frame summaries are kept,
 * never media. The opt-in is the Program preview's real button.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { requireLoopback, redactParityFailure } from './cloud-parity-contract.mjs'
import {
  VIRTUAL_CAMERA_CASE,
  assessVirtualCameraCase,
  frameSummary,
  virtualCameraCaseConfig
} from './cloud-parity-virtual-camera-contract.mjs'
import {
  ANALYSIS_HEIGHT,
  ANALYSIS_WIDTH,
  cameraReaderPlan,
  readerOutputArgs
} from './virtual-camera-smoke.mjs'

const BUTTON = '[data-testid="show-stage-program-camera"] button'
const MONITOR = '[data-testid="show-stage-program"]'

/** In-page: whether any `<video>` plays a track labelled Videorc Camera, and the room camera's label. */
const FEEDBACK_PROBE = `
  const playing = [...document.querySelectorAll('video')]
    .flatMap((video) => (video.srcObject ? video.srcObject.getVideoTracks() : []))
    .map((track) => track.label)
  const devices = await navigator.mediaDevices.enumerateDevices()
  const smoke = window.__videorcSmokeScenePresets
  const config = smoke.streamingState().captureConfig
  const roomCamera =
    smoke.roomFixtureDevices().find((d) => d.kind === 'camera' && d.id === config.sources?.cameraId)
      ?.name ?? config.sources?.cameraName ?? null
  return {
    videorcTracksPlaying: playing.filter((label) => label.trim().startsWith('Videorc Camera')).length,
    roomCameraLabel: roomCamera,
    roomCameraIsVideorc: Boolean(roomCamera && roomCamera.trim().startsWith('Videorc Camera')),
    videorcListed: devices.some((d) => d.kind === 'videoinput' && d.label.trim().startsWith('Videorc Camera'))
  }
`

/** One external reader of Videorc Camera: per-frame summaries on the wall clock. */
function startReader(ffmpeg) {
  const plan = cameraReaderPlan(process.platform)
  const child = spawn(ffmpeg, ['-hide_banner', ...plan.inputArgs, ...readerOutputArgs()], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const frameBytes = ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 3
  const frames = []
  let pending = Buffer.alloc(0)
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes)
      pending = pending.subarray(frameBytes)
      frames.push({ atMs: Date.now(), ...frameSummary(frame, ANALYSIS_WIDTH, ANALYSIS_HEIGHT) })
    }
  })
  child.stderr.on('data', (chunk) => {
    // Keep only the tail: showinfo writes a line per frame.
    stderr = (stderr + chunk.toString('utf8')).slice(-8192)
  })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  return {
    frames,
    device: plan.device,
    stderr: () => stderr,
    async stop() {
      child.kill('SIGINT')
      await Promise.race([exited, sleep(5000).then(() => child.kill('SIGKILL'))])
    }
  }
}

export async function acquireVirtualCameraCase({
  desktopRoot,
  webRoot,
  config = virtualCameraCaseConfig()
}) {
  assert.ok(webRoot, 'VIDEORC_PARITY_WEB_ROOT must name the local web fixture checkout')
  const { managedHarness, OUTPUT, waitFor } = await import('./cloud-managed-smoke.mjs')
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages } = await import('./cloud-parity-browser.mjs')
  const { chromium } = await import('playwright-core')
  const evidence = {
    schemaVersion: 1,
    kind: 'local-livekit-room-program-camera',
    acquisition: 'running',
    productionQualified: false,
    platform: process.platform,
    config,
    revisions: {
      desktop: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: desktopRoot,
        encoding: 'utf8'
      }).trim(),
      web: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: webRoot, encoding: 'utf8' }).trim()
    },
    phases: [],
    frames: [],
    feedback: null,
    failures: [],
    unavailable: [
      {
        measurement: 'signedPackagedApps',
        owner: 'Release qualification (smoke:virtual-camera on packaged apps)',
        reason:
          'This case drives a development app; the gate also needs smoke:virtual-camera against signed packaged apps on macOS and Windows.'
      },
      {
        measurement: 'graphicsMarkers',
        owner: 'views/graphics cases',
        reason:
          'The camera is judged as a moving, lit, correctly labelled picture; marker-exact graphics placement is ruled by the views and graphics cases for the same Program preview.'
      },
      {
        measurement: 'backendRestartReconnect',
        owner: 'Lifecycle acceptance',
        reason:
          'Reconnect is measured as off then on (a new generation); a backend restart mid-upload is covered by unit tests only.'
      },
      {
        measurement: 'managedRoom',
        owner: 'Separately authorized managed run',
        reason: 'Local LiveKit only.'
      }
    ]
  }
  const outputRoot =
    process.env.VIDEORC_VIRTUAL_CAMERA_OUTPUT ??
    join(homedir(), 'videorc-parity-evidence', 'virtual-camera')
  mkdirSync(outputRoot, { recursive: true })
  const reportFile = join(outputRoot, `virtual-camera-${Date.now()}.json`)
  const save = () => writeFileSync(reportFile, JSON.stringify(evidence, null, 2) + '\n')
  const h = await managedHarness('talk', 1, { maximumLogEntries: 4096 })
  let pages, browser, context, reader
  try {
    h.env[VIRTUAL_CAMERA_CASE.env] = '1'
    await h.destinations(0)
    await h.launch()
    await prepareParityRoom(h, false)
    const camera = await h.rpc('virtualCamera.set', { on: true })
    evidence.cameraOnStatus = camera
    await waitFor(
      async () => ['ready', 'streaming'].includes((await h.rpc('virtualCamera.status')).state),
      'Videorc Camera ready (registered on this host)',
      config.readinessMs
    )
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Room program camera acceptance',
      platforms: []
    })
    h.showId = opened.show.id
    await h.status((s) => s.room?.client === 'connected', 'Host joined', config.readinessMs)
    await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [`host:${h.showId}`] })
    // The program page reports drawing the stage, so the Program preview shows it.
    requireLoopback(h.livekit.url)
    pages = await startParityPages(webRoot, new Map())
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true
    })
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    await context.route('**/*', (route) => {
      try {
        requireLoopback(route.request().url())
        return route.continue()
      } catch {
        return route.abort('blockedbyclient')
      }
    })
    const program = await context.newPage()
    const search = new URLSearchParams({
      show: h.showId,
      k: 'talk',
      pt: 'vcp1.dGVzdA.dGVzdA',
      layout: 'h',
      url: h.livekit.url,
      token: h.web.tokenFor(h.showId, 'EG_parity_virtual_camera', 'recorder')
    })
    await program.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
    await waitFor(
      () => h.eval(`return Boolean(document.querySelector(${JSON.stringify(BUTTON)}))`),
      'The Program preview offers Videorc Camera',
      config.readinessMs
    )

    const inspect = () => h.eval('return await window.videorc.getRoomProgramCameraResources()')
    const status = () => h.rpc('virtualCamera.status')
    // The opt-in is an item in the Program preview's ⋯ menu (0.31.1).
    const click = () =>
      h.eval(`
        document.querySelector(${JSON.stringify(BUTTON)}).click();
        const deadline = Date.now() + 5000;
        for (;;) {
          const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
            /Videorc Camera/.test(el.textContent)
          );
          if (item) {
            item.click();
            return true;
          }
          if (Date.now() > deadline) throw new Error('The Program menu has no Videorc Camera item');
          await sleep(50);
        }`)
    const setMonitorShown = (shown) =>
      h.eval(
        `document.querySelector(${JSON.stringify(MONITOR)}).style.display = ${JSON.stringify(shown ? '' : 'none')}; return true`
      )
    const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
    reader = startReader(ffmpeg)
    evidence.device = reader.device
    // Phase: live. The opt-in is the real button.
    await click()
    await waitFor(
      async () => (await status()).source === VIRTUAL_CAMERA_CASE.source,
      'Videorc Camera shows the room program',
      config.readinessMs
    )
    const phase = async (name, durationMs) => {
      const fromMs = Date.now()
      await sleep(durationMs)
      evidence.phases.push({
        name,
        fromMs,
        toMs: Date.now(),
        status: await status(),
        inspect: await inspect().catch((error) => ({ error: redactParityFailure(error) }))
      })
      save()
    }
    await phase('live', config.liveMs)
    evidence.feedback = await h.eval(FEEDBACK_PROBE)
    // Phase: paused. The Program preview not displayed: nothing is sent.
    await setMonitorShown(false)
    await phase('paused', config.phaseMs)
    await setMonitorShown(true)
    await phase('resumed', config.phaseMs)
    // Phase: off, then on again under a new generation.
    await click()
    await phase('off', config.phaseMs)
    await click()
    await phase('reconnected', config.phaseMs)
    evidence.producer = await h
      .eval('return window.__videorcRoomProgramCameraStats?.() ?? null')
      .catch(() => null)
    evidence.acquisition = 'completed'
  } catch (error) {
    evidence.acquisition = 'failed'
    evidence.failures.push(redactParityFailure(error))
  } finally {
    if (reader) {
      await reader.stop()
      evidence.frames = reader.frames
      evidence.readerTail = reader.stderr().split('\n').slice(-12)
    }
    await Promise.allSettled([context?.close(), browser?.close(), pages?.close()])
    await h.rpc('virtualCamera.set', { on: false }).catch(() => {})
    await h.rpc('cloud.room.close').catch(() => {})
    await h.close().catch(() => {})
    save()
  }
  return { evidenceFile: reportFile }
}

export async function analyzeVirtualCameraCase(file) {
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(evidence.kind, 'local-livekit-room-program-camera', 'Not room program evidence')
  if (evidence.acquisition !== 'completed')
    return {
      status: 'failed',
      productionQualified: false,
      reason: 'Acquisition incomplete',
      failures: evidence.failures
    }
  return assessVirtualCameraCase(evidence)
}
