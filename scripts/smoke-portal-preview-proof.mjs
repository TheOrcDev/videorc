// Linux Phase D smoke: granted portal capture + ScreenOnly must feed the
// Electron CPU/BMP proof surface with live portal pixels.
//
// After PR #435, portal IDs are compositor-feedable and ScreenOnly applies,
// but the proof window can still paint synthetic stripes if the CPU compositor
// never starts and never attaches PipeWire BGRA to the screen layer.
//
//   pnpm smoke:portal-preview-proof
//   VIDEORC_PORTAL_EXPECT=any pnpm smoke:portal-preview-proof
//
// Success: compositorState=live, surfaceSource is not synthetic,
// sourcePixelsPresent=true, transport stays electron-proof-surface.
// Safe GPU: OpenH264 only; no VAAPI / renderD129 probe.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { isLinuxSmokeEvidenceLine } from './lib/linux-smoke-evidence.mjs'
import {
  PORTAL_MONITOR_SOURCE_ID,
  assessPortalDeviceList,
  assessPortalPreviewProof,
  assessPortalScreenStatus
} from './lib/linux-portal-capture-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const consentWaitMs = Number(process.env.VIDEORC_PORTAL_WAIT_MS ?? 60000)
const proofWaitMs = Number(process.env.VIDEORC_PORTAL_PROOF_WAIT_MS ?? 20000)
const expect = process.env.VIDEORC_PORTAL_EXPECT === 'any' ? 'any' : 'granted'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-portal-proof-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg/linux-x64/bin/ffmpeg')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function fail(message) {
  console.error(`Linux portal preview proof smoke FAILED: ${message}`)
  process.exit(1)
}

function layout(layoutPreset) {
  return {
    layoutPreset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
}

const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 }
const sources = {
  screenId: PORTAL_MONITOR_SOURCE_ID,
  windowId: null,
  cameraId: null,
  microphoneId: null,
  testPattern: false
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
  const smoke = launch.connections['preview-motion-ready']

  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const deviceAssessment = assessPortalDeviceList(devices.devices ?? [])
  console.log(
    `[portal-proof] devices: ${JSON.stringify(
      (devices.devices ?? [])
        .filter((device) => device.id.includes(':portal:'))
        .map((device) => ({ id: device.id, status: device.status }))
    )}`
  )
  if (!deviceAssessment.ok) fail(deviceAssessment.failures.join('; '))

  console.log(
    `[portal-proof] starting ${PORTAL_MONITOR_SOURCE_ID}; if the compositor's picker appears, choose a screen and Share (waiting up to ${consentWaitMs}ms)`
  )
  const startedAt = Date.now()
  let status = await request(
    ws,
    Math.max(timeoutMs, consentWaitMs + 10000),
    'preview.screen.start',
    { sources, video, ffmpegPath }
  )
  console.log(`[portal-proof] preview.screen.start -> ${status.state}: ${status.message ?? ''}`)
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
  const screenAssessment = assessPortalScreenStatus(status, { expect })
  if (!screenAssessment.ok) {
    writeEvidence({
      outcome: screenAssessment.outcome,
      consentMs,
      screen: status,
      compositor: null,
      surface: null,
      failures: screenAssessment.failures
    })
    fail(screenAssessment.failures.join('; '))
  }
  if (screenAssessment.outcome !== 'granted') {
    writeEvidence({
      outcome: screenAssessment.outcome,
      consentMs,
      screen: status,
      compositor: null,
      surface: null,
      failures: []
    })
    console.log(
      `Linux portal preview proof smoke PASS (portal ${screenAssessment.outcome}; proof skipped); evidence in ${outputDirectory}`
    )
  } else {

  try {
    await requestSmokeCommand(smoke, 'preview-window-open')
  } catch (error) {
    console.log(`[portal-proof] preview-window-open: ${error?.message ?? error}`)
  }

  const applied = await request(ws, timeoutMs, 'scene.layout.apply_preview', {
    sources,
    layout: layout('screen-only'),
    video,
    background: null,
    protectedOverlayWindowIds: []
  })
  console.log(
    `[portal-proof] scene.layout.apply_preview -> applied=${applied.applied} mode=${applied.mode} revision=${applied.sceneRevision} compositor=${applied.compositorStatus?.state}`
  )
  if (!applied.applied) {
    fail(`ScreenOnly preview layout did not apply: ${JSON.stringify(applied)}`)
  }

  const proofDeadline = Date.now() + proofWaitMs
  let compositor = applied.compositorStatus ?? null
  let surface = null
  let assessment = assessPortalPreviewProof({ compositor, surface })
  while (Date.now() < proofDeadline) {
    compositor = await request(ws, timeoutMs, 'compositor.status')
    try {
      surface = await request(ws, timeoutMs, 'preview.surface.status')
    } catch {
      surface = surface ?? null
    }
    if (smoke) {
      try {
        const native = await requestSmokeCommand(smoke, 'native-preview-surface-status')
        surface = {
          ...(surface ?? {}),
          ...(native ?? {}),
          source: native?.source ?? native?.surfaceSource ?? surface?.source,
          sourcePixelsPresent:
            native?.sourcePixelsPresent ?? surface?.sourcePixelsPresent,
          transport: native?.transport ?? surface?.transport,
          backing: native?.backing ?? surface?.backing,
          nativePreviewHostKind: native?.nativePreviewHostKind ?? surface?.nativePreviewHostKind
        }
      } catch {
        // Backend preview.surface.status is enough if the smoke command is down.
      }
    }
    assessment = assessPortalPreviewProof({ compositor, surface })
    if (assessment.ok) break
    await sleep(400)
  }

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contract: 'linux-l5-portal-preview-proof',
    source: PORTAL_MONITOR_SOURCE_ID,
    expect,
    outcome: assessment.ok ? 'granted-proof' : 'failed',
    consentMs,
    layoutPreset: applied.scene?.layout?.layoutPreset ?? applied.mode,
    sceneRevision: applied.sceneRevision ?? null,
    compositor: {
      state: compositor?.state ?? null,
      runId: compositor?.runId ?? null,
      framesRendered: compositor?.framesRendered ?? 0,
      sceneRevision: compositor?.sceneRevision ?? null,
      frameSceneRevision: compositor?.frameSceneRevision ?? null,
      sceneSources: compositor?.sceneSources ?? []
    },
    surface: {
      source: surface?.source ?? surface?.surfaceSource ?? null,
      sourcePixelsPresent: surface?.sourcePixelsPresent ?? false,
      transport: surface?.transport ?? null,
      backing: surface?.backing ?? null,
      nativePreviewHostKind: surface?.nativePreviewHostKind ?? null,
      framesRendered: surface?.framesRendered ?? 0
    },
    screen: {
      state: status.state,
      message: status.message ?? null,
      width: status.width ?? null,
      height: status.height ?? null,
      framesCaptured: status.framesCaptured ?? 0
    },
    failures: assessment.failures
  }
  writeFileSync(
    join(outputDirectory, 'linux-portal-preview-proof.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(
    `[portal-proof] compositor=${JSON.stringify(evidence.compositor)} surface=${JSON.stringify(evidence.surface)}`
  )

  const stopped = await request(ws, timeoutMs, 'preview.screen.stop')
  console.log(`[portal-proof] preview.screen.stop -> ${stopped.state ?? JSON.stringify(stopped)}`)
  if (!assessment.ok) fail(assessment.failures.join('; '))
  console.log(
    `Linux portal preview proof smoke PASS (sourcePixelsPresent=true, surfaceSource=${evidence.surface.source}, compositorState=${evidence.compositor.state}); evidence in ${outputDirectory}`
  )
  }
} catch (error) {
  fail(error?.stack ?? String(error))
} finally {
  await stopApp()
}

function writeEvidence(partial) {
  writeFileSync(
    join(outputDirectory, 'linux-portal-preview-proof.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        contract: 'linux-l5-portal-preview-proof',
        source: PORTAL_MONITOR_SOURCE_ID,
        expect,
        ...partial
      },
      null,
      2
    )
  )
}
