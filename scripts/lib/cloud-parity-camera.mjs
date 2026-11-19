/** Plan 249 S13b `camera` case: runnable acquisition and analysis.
 *
 * Importing this module launches nothing; only `acquireCameraCase` does. It
 * needs an existing debug backend built from this slice, installed desktop and
 * web dependencies, local LiveKit, FFmpeg/ffprobe and Chrome. No paid egress,
 * no provider and no physical device: `VIDEORC_ROOM_PROCESSED_CAMERA_FIXTURE`
 * substitutes the device only (processing, transport and consumers are real).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  CASE_LAYOUT_PATCH,
  CASE_LOOK,
  assessCameraCase,
  cameraCaseConfig,
  markerPoints
} from './cloud-parity-camera-contract.mjs'
import { cameraPublication } from './cloud-parity-camera-bridge-contract.mjs'
import { requireLoopback, redactParityFailure } from './cloud-parity-contract.mjs'

const DESCRIPTOR =
  /^videorc:camera-frame:v1;frameLayout=(opaque|rgb-left-alpha-right:g8);generation=([1-9][0-9]{0,15})$/

/** In-page (program): read the decoded processed camera at logical points. */
export function sampleProcessedCamera(spec) {
  const video = [...document.querySelectorAll('video')].find((v) => {
    const w = (v.videoWidth - spec.gutter) / 2
    return Number.isInteger(w) && w >= 64 && v.videoHeight >= 64 && w * v.videoHeight <= 640 * 360
  })
  if (!video) return null
  const packedWidth = video.videoWidth
  const width = (packedWidth - spec.gutter) / 2
  const height = video.videoHeight
  const canvas = new OffscreenCanvas(packedWidth, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(video, 0, 0)
  const at = ({ fx, fy }) => {
    const x = Math.min(width - 1, Math.floor(fx * width))
    const y = Math.min(height - 1, Math.floor(fy * height))
    const colour = ctx.getImageData(x, y, 1, 1).data
    const alpha = ctx.getImageData(x + width + spec.gutter, y, 1, 1).data
    return { rgb: [colour[0], colour[1], colour[2]], alpha: alpha[0] }
  }
  const points = Object.fromEntries(
    Object.entries(spec.points)
      .filter(([name]) => name !== 'edge')
      .map(([name, point]) => [name, at(point)])
  )
  const edge = spec.points.edge.map((point) => ({ fx: point.fx, alpha: at(point).alpha }))
  // The fixture's sequence stamp: 32 cells across the bottom rows.
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  const cells = Array.from({ length: 32 }, (_, i) => luma(at({ fx: (i + 0.5) / 32, fy: 0.97 }).rgb))
  let sequence = null
  if (!cells.some((v) => v > 96 && v < 160)) {
    let n = 0,
      check = 0
    for (let i = 0; i < 32; i++)
      if (cells[i] >= 160) {
        if (i < 24) n |= 1 << i
        else check |= 1 << (i - 24)
      }
    sequence = (((n >>> 16) ^ (n >>> 8) ^ n) & 255) === check ? n : null
  }
  return { width, height, packedWidth, points, edge, sequence }
}

export async function acquireCameraCase({ desktopRoot, webRoot, config = cameraCaseConfig() }) {
  assert.ok(webRoot, 'VIDEORC_PARITY_WEB_ROOT must name the local web fixture checkout')
  const { managedHarness, OUTPUT, waitFor } = await import('./cloud-managed-smoke.mjs')
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages } = await import('./cloud-parity-browser.mjs')
  const { chromium } = await import('playwright-core')
  const evidence = {
    schemaVersion: 1,
    kind: 'local-livekit-processed-camera',
    acquisition: 'running',
    productionQualified: false,
    platform: process.platform,
    config,
    layoutPatch: CASE_LAYOUT_PATCH,
    revisions: {
      desktop: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: desktopRoot,
        encoding: 'utf8'
      }).trim(),
      web: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: webRoot, encoding: 'utf8' }).trim()
    },
    runs: [],
    lifecycle: null,
    failures: [],
    unavailable: [
      {
        measurement: 'realDeviceUnplugSwitch',
        owner: 'Device acceptance on macOS and Windows',
        reason: 'The fixture substitutes the device; physical unplug/switch needs real cameras.'
      },
      {
        measurement: 'windowsLowLightDevice',
        owner: 'Windows device acceptance',
        reason: 'Low-light compensation is a device setting; it needs an actual Windows camera.'
      },
      {
        measurement: 'zeroCopyCaptureCameras',
        owner: 'Native capture path',
        reason:
          'A capture without CPU bytes (zero-copy) gives the processed role nothing to process; it reports unavailable, never a guessed frame.'
      },
      {
        measurement: 'captureTimestamp',
        owner: 'Native camera frame store',
        reason: 'Frames carry native observation time (an upper bound), not capture time.'
      },
      {
        measurement: 'recordingMatrixAndPreviewProbes',
        owner: 'R and P gates',
        reason: 'smoke:recording-matrix and preview probes are separate, deferred gates.'
      },
      {
        measurement: 'managedRecorderBudgets',
        owner: 'Separately authorized managed run',
        reason: 'Local harness only.'
      }
    ]
  }
  // Outside the checkout and outside /tmp (a reboot wipes it mid-run).
  const outputRoot =
    process.env.VIDEORC_CAMERA_OUTPUT ?? join(homedir(), 'videorc-parity-evidence', 'camera')
  mkdirSync(outputRoot, { recursive: true })
  const reportFile = join(outputRoot, `camera-${Date.now()}.json`)
  const save = () => writeFileSync(reportFile, JSON.stringify(evidence, null, 2) + '\n')
  const spec = { gutter: 8, points: markerPoints() }
  let failure
  for (const [index, source] of config.sources.entries()) {
    const run = { source, samples: [], stamped: 0, ownership: null }
    evidence.runs.push(run)
    const h = await managedHarness('talk', index + 1, { maximumLogEntries: 4096 })
    let pages, browser, context
    try {
      h.env.VIDEORC_ROOM_PROCESSED_CAMERA = '1'
      h.env.VIDEORC_ROOM_PROCESSED_CAMERA_FIXTURE = `${source.width}x${source.height}`
      await h.destinations(0)
      await h.launch()
      // The look is a per-camera setting (`settings.cameraLooks`), never a
      // layout field: the Studio replaces `layout.cameraLook` with the selected
      // camera's stored look, so the layout patch alone never reached the
      // camera ("look patch unchanged"). Store it as a user's saved look for
      // the fixture camera, then reload the Studio so it reads its settings.
      await h.eval(
        `const settings = JSON.parse(localStorage.getItem('videorc.settings') ?? '{}');
         settings.cameraLooks = { ...settings.cameraLooks, 'parity-camera': ${JSON.stringify(CASE_LOOK)} };
         localStorage.setItem('videorc.settings', JSON.stringify(settings));
         window.__parityBeforeReload = true;
         setTimeout(() => location.reload(), 0);
         return true`
      )
      await waitFor(
        () =>
          h
            .eval(
              'return !window.__parityBeforeReload && !!window.__videorcSmokeScenePresets?.roomFixtureDevices'
            )
            .catch(() => false),
        'The Studio reloads with the stored camera look',
        config.readinessMs
      )
      await prepareParityRoom(h, false)
      await h.eval(
        `const s = window.__videorcSmokeScenePresets; const c = s.streamingState().captureConfig; s.configure({ layout: { ...c.layout, ...${JSON.stringify(CASE_LAYOUT_PATCH)} } }); return true`
      )
      const opened = await h.rpc('cloud.room.open', {
        outputs: [OUTPUT],
        title: 'Processed camera acceptance',
        platforms: []
      })
      h.showId = opened.show.id
      await h.status((s) => s.room?.client === 'connected', 'Host joined', config.readinessMs)
      const hostCamera = async () => {
        const participant = await h.web.roomRpc('GetParticipant', {
          room: h.showId,
          identity: `host:${h.showId}`
        })
        const tracks = (participant?.tracks ?? []).filter(
          (t) => t.source === 'CAMERA' || t.source === 1 || t.source === 'camera'
        )
        return {
          published: cameraPublication(participant),
          raw: tracks.some((t) => !DESCRIPTOR.test(t.name ?? ''))
        }
      }
      await waitFor(
        async () => (await hostCamera()).published,
        'Processed camera publication',
        config.readinessMs
      )
      const resources = await h.eval(
        'return await window.videorc.getRoomProcessedCameraResources()'
      )
      const camera = await hostCamera()
      run.ownership = {
        keptForRoom: resources.keptForRoom,
        lentToBrowserRoom: resources.lentToBrowserRoom,
        layoutSource: resources.layoutSource,
        keyOn: resources.keyOn,
        nativeMirror: resources.nativeMirror,
        look: resources.look,
        browserCamera: camera.raw
      }
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
      await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [`host:${h.showId}`] })
      const search = new URLSearchParams({
        show: h.showId,
        k: 'talk',
        pt: 'vcp1.dGVzdA.dGVzdA',
        layout: 'h',
        url: h.livekit.url,
        token: h.web.tokenFor(h.showId, 'EG_parity_camera', 'recorder'),
        // Loopback-only experiment gate; a deployed page never takes authority.
        cameraFrameExperiment: '1'
      })
      await program.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
      await waitFor(
        () => program.evaluate(sampleProcessedCamera, spec),
        'Program decodes the processed camera',
        config.readinessMs
      )
      const sequences = new Set()
      const until = Date.now() + config.durationMs
      while (Date.now() < until) {
        const sample = await program.evaluate(sampleProcessedCamera, spec)
        if (sample) {
          if (run.samples.length < 64) run.samples.push(sample)
          if (sample.sequence !== null) sequences.add(sample.sequence)
        }
        await sleep(config.pollMs)
      }
      run.stamped = sequences.size
      if (index === 0) evidence.lifecycle = await exerciseLifecycle(h, hostCamera, config)
      save()
    } catch (error) {
      run.reason = redactParityFailure(error)
      evidence.failures.push(`${source.width}x${source.height}: ${run.reason}`)
      failure ??= error
    } finally {
      await Promise.allSettled([context?.close(), browser?.close(), pages?.close()])
      await h.rpc('cloud.room.close').catch(() => {})
      await h.close().catch(() => {})
      save()
    }
  }
  evidence.acquisition = failure ? 'failed' : 'completed'
  save()
  return { evidenceFile: reportFile }
}

/** Off, fixture switch and fixture unplug: each must pause (no camera frame
 * publication, no raw camera) and, except off, reopen with a new generation. */
async function exerciseLifecycle(h, hostCamera, config) {
  const authority = () => h.eval('return window.__videorcSmokeScenePresets.roomFrameAuthority()')
  const paused = async (started) => {
    const deadline = started + 10_000
    while (Date.now() < deadline) {
      const [bound, camera] = [await authority(), await hostCamera()]
      if (!bound && !camera.published) return { at: Date.now() - started, raw: camera.raw }
      if (camera.raw) return { at: null, raw: true }
      await sleep(100)
    }
    return { at: null, raw: (await hostCamera()).raw }
  }
  const reopen = async (before) => {
    await h.eval('return await window.__videorcSmokeScenePresets.roomCameraOff(false)')
    const deadline = Date.now() + config.readinessMs
    while (Date.now() < deadline) {
      const now = await authority()
      if (now && now.authority.generation > before) return true
      await sleep(200)
    }
    return false
  }
  const result = {}
  for (const name of ['off', 'switch', 'unplug']) {
    const before = (await authority())?.authority.generation ?? 0
    const started = Date.now()
    if (name === 'off')
      await h.eval('return await window.__videorcSmokeScenePresets.roomCameraOff(true)')
    else
      await h.eval(
        `return await window.videorc.roomProcessedCameraFixture(${JSON.stringify(
          name === 'switch' ? 'fixture-switch' : 'fixture-unplug'
        )})`
      )
    const pause = await paused(started)
    // Unplug: plug a (new) fixture device back before reopening.
    if (name === 'unplug')
      await h
        .eval("return await window.videorc.roomProcessedCameraFixture('fixture-switch')")
        .catch(() => null)
    result[name] = {
      pausedWithinMs: pause.at,
      rawCameraPublished: pause.raw,
      reopenedGeneration: await reopen(before)
    }
  }
  return result
}

export async function analyzeCameraCase(file) {
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(evidence.kind, 'local-livekit-processed-camera', 'Not processed-camera evidence')
  if (evidence.acquisition !== 'completed')
    return { status: 'failed', productionQualified: false, reason: 'Acquisition incomplete' }
  return assessCameraCase(evidence)
}
