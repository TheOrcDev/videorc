// Linux L4 smoke (Plan 0006): launch the dev app on the box, prove the portal
// screen/window entries are listed, start the portal monitor source through
// the backend, and assert the preview.screen state is a NAMED portal outcome
// (granted: live with frames; or cancelled / missing with the reason).
//
// First run on a box is interactive: the compositor's picker appears and a
// tester clicks Share. The backend persists the portal restore token beside
// the database, so later runs (same VIDEORC_APP_DATA_DIR) are silent.
//
//   VIDEORC_PORTAL_EXPECT=granted|any   default granted; 'any' accepts a
//                                        truthful refusal (unattended runs).
//   VIDEORC_PORTAL_WAIT_MS               how long to wait for consent (default 60000).
//   VIDEORC_SMOKE_TIMEOUT_MS             dev-app launch timeout.
//
// Safe GPU: the encoder is forced to OpenH264; no VAAPI probe runs.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { isLinuxSmokeEvidenceLine } from './lib/linux-smoke-evidence.mjs'
import {
  PORTAL_MONITOR_SOURCE_ID,
  assessPortalDeviceList,
  assessPortalScreenStatus
} from './lib/linux-portal-capture-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const consentWaitMs = Number(process.env.VIDEORC_PORTAL_WAIT_MS ?? 60000)
const expect = process.env.VIDEORC_PORTAL_EXPECT === 'any' ? 'any' : 'granted'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-portal-smoke-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function fail(message) {
  console.error(`Linux portal capture smoke FAILED: ${message}`)
  process.exit(1)
}

if (process.platform !== 'linux') fail('this smoke only runs on Linux')

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_LINUX_H264_ENCODER: 'openh264'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1' || isLinuxSmokeEvidenceLine(line)) {
        console.log(line)
      } else if (/portal screen capture|portal PipeWire|portal restore token/.test(line)) {
        console.log(line)
      }
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)

  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const deviceAssessment = assessPortalDeviceList(devices.devices ?? [])
  console.log(
    `[portal] devices: ${JSON.stringify(
      (devices.devices ?? [])
        .filter((device) => device.id.includes(':portal:'))
        .map((device) => ({ id: device.id, status: device.status }))
    )}`
  )
  if (!deviceAssessment.ok) fail(deviceAssessment.failures.join('; '))

  console.log(
    `[portal] starting ${PORTAL_MONITOR_SOURCE_ID}; if the compositor's picker appears, choose a screen and Share (waiting up to ${consentWaitMs}ms)`
  )
  const startedAt = Date.now()
  let status = await request(
    ws,
    Math.max(timeoutMs, consentWaitMs + 10000),
    'preview.screen.start',
    {
      sources: {
        screenId: PORTAL_MONITOR_SOURCE_ID,
        windowId: null,
        cameraId: null,
        microphoneId: null,
        testPattern: false
      },
      video: { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 },
      ffmpegPath
    }
  )
  console.log(`[portal] preview.screen.start -> ${status.state}: ${status.message ?? ''}`)
  // Let a granted stream accumulate frames before judging it.
  const settleDeadline = Date.now() + 8000
  while (
    status.state === 'live' &&
    (status.framesCaptured ?? 0) < 30 &&
    Date.now() < settleDeadline
  ) {
    await sleep(500)
    status = await request(ws, timeoutMs, 'preview.screen.status')
  }
  const consentMs = Date.now() - startedAt
  const assessment = assessPortalScreenStatus(status, { expect })
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contract: 'linux-l4-portal-screen-capture',
    source: PORTAL_MONITOR_SOURCE_ID,
    expect,
    outcome: assessment.outcome,
    consentMs,
    status: {
      state: status.state,
      message: status.message ?? null,
      width: status.width ?? null,
      height: status.height ?? null,
      framesCaptured: status.framesCaptured ?? 0,
      sourceFps: status.sourceFps ?? null
    },
    failures: assessment.failures
  }
  writeFileSync(
    join(outputDirectory, 'linux-portal-capture.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(
    `[portal] ${JSON.stringify(evidence.status)} (outcome ${assessment.outcome}, ${consentMs}ms)`
  )
  if (status.state === 'live') {
    const stopped = await request(ws, timeoutMs, 'preview.screen.stop')
    console.log(`[portal] preview.screen.stop -> ${stopped.state ?? JSON.stringify(stopped)}`)
  }
  if (!assessment.ok) fail(assessment.failures.join('; '))
  console.log(
    `Linux portal capture smoke PASS (${assessment.outcome}); evidence in ${outputDirectory}`
  )
} catch (error) {
  fail(error?.stack ?? String(error))
} finally {
  await stopApp()
}
