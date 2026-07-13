import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const settleMs = Number(process.env.VIDEORC_LAYOUT_SOURCE_LOOP_SETTLE_MS ?? 1000)

const LAYOUTS = [
  {
    preset: 'screen-only',
    expectedKinds: ['test-pattern']
  },
  {
    preset: 'camera-only',
    expectedKinds: ['camera']
  },
  {
    preset: 'side-by-side',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'screen-camera',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'vertical-camera-top',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'vertical-camera-bottom',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'vertical-split',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'vertical-screen-camera',
    expectedKinds: ['camera', 'test-pattern']
  },
  {
    preset: 'vertical-screen-only',
    expectedKinds: ['test-pattern']
  },
  {
    preset: 'vertical-camera-only',
    expectedKinds: ['camera']
  }
]

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1'
  }
})

let ws
try {
  const backend = launched.connections['backend-ready']
  const smoke = launched.connections['preview-motion-ready']
  ws = await connectBackend(backend, timeoutMs)

  await smokeCommand(smoke, 'preview-window-open')
  // Isolated smoke profiles persist no camera; camera presets need one selected.
  await smokeCommand(smoke, 'select-camera-device', { settleMs })
  // Enable the synthetic replacement last. A late device-list reconciliation
  // must not auto-select a physical display over this explicit diagnostic source.
  await smokeCommand(smoke, 'enable-synthetic-source', { settleMs })
  await smokeCommand(smoke, 'open-layout-tab')
  await sleep(settleMs)

  for (const layout of LAYOUTS) {
    const selected = await smokeCommand(smoke, 'select-layout-preset', {
      preset: layout.preset,
      settleMs
    })
    const surface = await smokeCommand(smoke, 'preview-surface-scene-state')
    const scene = await request(ws, timeoutMs, 'scene.get')
    assertLayoutLoop(layout, selected, surface, scene)
    console.log(
      `Layout source loop [${layout.preset}] OK - scene ${sourceKinds(scene).join(' + ') || 'empty'}, surface revision ${surface.sceneRevision}.`
    )
  }

  console.log(
    'Layout source loop smoke OK - layout buttons, backend scene, and detached preview surface stayed in sync.'
  )
} finally {
  try {
    ws?.close()
  } catch {
    // Best-effort cleanup.
  }
  await launched.stop()
}

function assertLayoutLoop(layout, selected, surface, scene) {
  if (selected?.preset !== layout.preset || selected?.pressed !== true) {
    throw new Error(
      `Layout ${layout.preset} did not become active in the UI: ${JSON.stringify(selected)}`
    )
  }

  if (surface.layoutPreset !== layout.preset) {
    throw new Error(
      `Detached preview surface stayed on ${surface.layoutPreset}, expected ${layout.preset}: ${JSON.stringify(surface)}`
    )
  }

  const actualKinds = sourceKinds(scene)
  if (JSON.stringify(actualKinds) !== JSON.stringify(layout.expectedKinds)) {
    throw new Error(
      `Backend scene for ${layout.preset} used ${actualKinds.join(' + ') || 'no sources'}, expected ${layout.expectedKinds.join(' + ')}.`
    )
  }

  const visibleSurfaceSources = [...(surface.visibleSourceIds ?? [])].sort()
  const expectedSurfaceSources = scene.sources
    .filter((source) => source.visible !== false)
    .map((source) => source.id)
    .sort()
  if (JSON.stringify(visibleSurfaceSources) !== JSON.stringify(expectedSurfaceSources)) {
    throw new Error(
      `Detached preview surface sources ${visibleSurfaceSources.join(', ')} did not match backend scene sources ${expectedSurfaceSources.join(', ')}.`
    )
  }
}

function sourceKinds(scene) {
  return scene.sources.map((source) => source.kind).sort()
}

function smokeCommand(smoke, command, params = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  const attempt = async () => {
    while (Date.now() < deadline) {
      try {
        return await sendSmokeCommand(smoke, command, params)
      } catch (error) {
        lastError = error
        await sleep(200)
      }
    }
    throw lastError ?? new Error(`Timed out waiting for smoke command ${command}.`)
  }
  return attempt()
}

function sendSmokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${smoke.capability}`
        }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (payload.error) {
              reject(new Error(payload.error))
            } else {
              resolve(payload.result ?? payload)
            }
          } catch {
            reject(new Error(`${command} returned invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
