// Long-uptime capture decay soak (2026-08-27 capture decay plan, D2).
//
// The field failure this hunts: after minutes-to-hours of app uptime — NO
// recordings required — the always-on capture → compositor pipeline settles
// into a stable degraded equilibrium (~6 fresh fps served at a healthy 30fps
// cadence). Preview and any later recording/livestream inherit it, restart
// clears it, and every liveness-only watchdog stays silent throughout. The
// owner's 33-minute idle decay produced zero log lines on 0.9.80.
//
// This soak launches the app once, starts NO sessions, and samples
// `diagnostics.stats` on an interval for a configurable duration. The
// backend's own capture-health monitor is the oracle: any sample with
// `capturePipelineDegradedStage` set fails the soak, and the whole rate
// series is written out as CSV so a passing run still yields the decay curve
// (time-to-onset, settled rates) when eyeballed.
//
// Synthetic scenes have no live camera/screen fetch sources, so the monitor's
// camera-delivery verdict only engages with real devices; the render-cadence
// verdict engages everywhere. Run the real-source variant on a box with TCC
// grants for the full tripwire.
//
// Usage: pnpm smoke:capture-decay-soak
//   VIDEORC_SOAK_MINUTES=60          soak length (default 60)
//   VIDEORC_SOAK_SAMPLE_SECONDS=10   sampling interval (default 10)
//   VIDEORC_SOAK_REAL_SOURCES=1      use the packaged app + real devices
//                                    (VIDEORC_PACKAGED_APP_EXECUTABLE to point
//                                    at a build; needs TCC grants; captures
//                                    your real screen — run intentionally)
//   VIDEORC_SMOKE_OUTPUT_DIR=...     report directory

import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-capture-soak-${Date.now()}`)
)
mkdirSync(outputDirectory, { recursive: true })
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-capture-soak-user-data-'))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const soakMinutes = Number(process.env.VIDEORC_SOAK_MINUTES ?? 60)
const sampleSeconds = Number(process.env.VIDEORC_SOAK_SAMPLE_SECONDS ?? 10)

const realSources = process.env.VIDEORC_SOAK_REAL_SOURCES === '1'
const packagedAppExecutable = realSources
  ? (process.env.VIDEORC_PACKAGED_APP_EXECUTABLE ??
    '/Applications/Videorc.app/Contents/MacOS/Videorc')
  : null
const packagedSmokeCapability = packagedAppExecutable
  ? randomBytes(32).toString('base64url')
  : undefined

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

let stopApp = null
let exitCode = 0
try {
  const launch = await launchDevApp({
    spawnSpec: packagedAppExecutable ? { command: packagedAppExecutable, args: [] } : undefined,
    packagedSmokeCommandCapability: packagedSmokeCapability,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      ...(packagedAppExecutable
        ? {
            VIDEORC_PACKAGED_SMOKE_TEST: '1',
            VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability,
            VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
          }
        : {}),
      VIDEORC_SYNTHETIC_HARD_CONTENT: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)

  const startedAt = Date.now()
  const deadline = startedAt + soakMinutes * 60_000
  const samples = []
  let previous = null
  let degradedSamples = 0

  console.log(
    `[capture-soak] soaking idle for ${soakMinutes}m, sampling every ${sampleSeconds}s ` +
      `(${realSources ? 'REAL sources' : 'synthetic scene'}); no sessions will be started`
  )

  while (Date.now() < deadline) {
    await sleep(sampleSeconds * 1000)
    const stats = await request(ws, timeoutMs, 'diagnostics.stats', undefined)
    const now = Date.now()
    const uptimeSec = Math.round((now - startedAt) / 1000)
    const windowSec = previous ? (now - previous.at) / 1000 : null
    const rate = (field) =>
      previous && windowSec > 0 && stats[field] >= previous.stats[field]
        ? (stats[field] - previous.stats[field]) / windowSec
        : null
    const sample = {
      uptimeSec,
      renderFps: stats.renderFps ?? null,
      targetFps: stats.targetFps ?? null,
      cameraFreshFps: rate('compositorCameraSourceFreshServes'),
      screenFreshFps: rate('compositorScreenSourceFreshServes'),
      cameraHeldFps: rate('compositorCameraSourceHeldServes'),
      screenHeldFps: rate('compositorScreenSourceHeldServes'),
      // H1-camera discriminators (2026-08-28): device-level delivery vs
      // pool starvation, and the retained-surface leak counters.
      cameraSourceFps: stats.previewCameraSourceFps ?? null,
      cameraCallbackFps: rate('previewCameraCaptureCallbackCount'),
      cameraOutOfBuffersPerSec:
        previous && windowSec > 0
          ? (stats.previewCameraDropReasons.outOfBuffers -
              previous.stats.previewCameraDropReasons.outOfBuffers) /
            windowSec
          : null,
      cameraPoolLive: stats.previewCameraSurfaceBacking.liveCount,
      cameraPoolPeak: stats.previewCameraSurfaceBacking.peakCount,
      previewFrameAgeMs: stats.previewFrameAgeMs ?? null,
      degradedStage: stats.capturePipelineDegradedStage ?? null
    }
    samples.push(sample)
    previous = { at: now, stats }
    if (sample.degradedStage) {
      degradedSamples += 1
      console.error(
        `[capture-soak] DEGRADED at uptime ${uptimeSec}s: stage=${sample.degradedStage} ` +
          `render=${sample.renderFps?.toFixed?.(1)}fps camera_fresh=${sample.cameraFreshFps?.toFixed?.(1) ?? 'n/a'}fps`
      )
    } else if (samples.length % 30 === 0) {
      console.log(
        `[capture-soak] healthy at uptime ${uptimeSec}s: render=${sample.renderFps?.toFixed?.(1)}fps ` +
          `camera_fresh=${sample.cameraFreshFps?.toFixed?.(1) ?? 'n/a'}fps screen_fresh=${sample.screenFreshFps?.toFixed?.(1) ?? 'n/a'}fps`
      )
    }
  }

  const csvHeader =
    'uptimeSec,renderFps,targetFps,cameraFreshFps,screenFreshFps,cameraHeldFps,screenHeldFps,' +
    'cameraSourceFps,cameraCallbackFps,cameraOutOfBuffersPerSec,cameraPoolLive,cameraPoolPeak,' +
    'previewFrameAgeMs,degradedStage'
  const csv = [csvHeader]
    .concat(
      samples.map((sample) =>
        [
          sample.uptimeSec,
          sample.renderFps ?? '',
          sample.targetFps ?? '',
          sample.cameraFreshFps?.toFixed?.(2) ?? '',
          sample.screenFreshFps?.toFixed?.(2) ?? '',
          sample.cameraHeldFps?.toFixed?.(2) ?? '',
          sample.screenHeldFps?.toFixed?.(2) ?? '',
          sample.cameraSourceFps?.toFixed?.(2) ?? '',
          sample.cameraCallbackFps?.toFixed?.(2) ?? '',
          sample.cameraOutOfBuffersPerSec?.toFixed?.(2) ?? '',
          sample.cameraPoolLive ?? '',
          sample.cameraPoolPeak ?? '',
          sample.previewFrameAgeMs ?? '',
          sample.degradedStage ?? ''
        ].join(',')
      )
    )
    .join('\n')
  const reportPath = join(outputDirectory, 'capture-decay-soak.csv')
  writeFileSync(reportPath, `${csv}\n`)
  writeFileSync(
    join(outputDirectory, 'capture-decay-soak.json'),
    JSON.stringify({ soakMinutes, sampleSeconds, realSources, degradedSamples, samples }, null, 2)
  )

  if (degradedSamples > 0) {
    console.error(
      `[capture-soak] FAIL: ${degradedSamples} degraded sample(s) over ${soakMinutes}m — curve at ${reportPath}`
    )
    exitCode = 1
  } else {
    console.log(
      `[capture-soak] PASS: ${samples.length} samples over ${soakMinutes}m, no degradation declared — curve at ${reportPath}`
    )
  }
  ws.close()
} catch (error) {
  console.error(`[capture-soak] harness failure: ${error?.stack ?? error}`)
  exitCode = 1
} finally {
  await stopApp?.()
}
process.exit(exitCode)
