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
  },
  // Close the loop in the reverse direction too: portrait -> landscape must
  // restore the remembered horizontal canvas and preview bounds.
  {
    preset: 'screen-camera',
    expectedKinds: ['camera', 'test-pattern']
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
    const [surface, previewWindow, captureState] = await Promise.all([
      smokeCommand(smoke, 'preview-surface-scene-state'),
      smokeCommand(smoke, 'preview-window-state'),
      smokeCommand(smoke, 'eval-js', {
        code: `
          const stored = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}');
          return {
            layoutPreset: stored.layout?.layoutPreset ?? null,
            video: stored.video ?? null
          };
        `
      })
    ])
    const scene = await request(ws, timeoutMs, 'scene.get')
    assertLayoutLoop(layout, selected, surface, scene, previewWindow, captureState.result)
    // The SEEING layer: window bounds and persisted config can both flip while
    // the compositor keeps rendering frames at its old spawn-time dimensions
    // (the 0.9.37 stale-orientation preview bug). Assert the pipeline itself —
    // the render dimensions and, when Metal presents, the actual target — has
    // adopted the expected orientation.
    await assertPresentedOrientation(ws, layout)
    console.log(
      `Layout source loop [${layout.preset}] OK - scene ${sourceKinds(scene).join(' + ') || 'empty'}, ${captureState.result.video.width}x${captureState.result.video.height} preview, surface revision ${surface.sceneRevision}.`
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

function assertLayoutLoop(layout, selected, surface, scene, previewWindow, captureState) {
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

  const expectsPortrait = layout.preset.startsWith('vertical-')
  if (captureState?.layoutPreset !== layout.preset) {
    throw new Error(
      `Stored capture config stayed on ${captureState?.layoutPreset}, expected ${layout.preset}.`
    )
  }
  if (!captureState?.video) {
    throw new Error(`Stored capture config has no video settings for ${layout.preset}.`)
  }
  const canvasIsPortrait = captureState.video.height > captureState.video.width
  if (canvasIsPortrait !== expectsPortrait) {
    throw new Error(
      `${layout.preset} kept a ${captureState.video.width}x${captureState.video.height} ${canvasIsPortrait ? 'portrait' : 'landscape'} canvas.`
    )
  }
  const bounds = previewWindow?.contentBounds
  if (!previewWindow?.open || !previewWindow.visible || !bounds) {
    throw new Error(
      `Preview window was not visibly presenting ${layout.preset}: ${JSON.stringify(previewWindow)}`
    )
  }
  const previewIsPortrait = bounds.height > bounds.width
  if (previewIsPortrait !== expectsPortrait) {
    throw new Error(
      `${layout.preset} kept ${bounds.width}x${bounds.height} ${previewIsPortrait ? 'portrait' : 'landscape'} preview bounds.`
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

// The compositor resizes on the NEXT tick after the surface bounds land, and
// the bounds themselves follow the renderer's post-proof config commit — poll
// briefly instead of asserting one instantaneous read.
async function assertPresentedOrientation(ws, layout) {
  const expectsPortrait = layout.preset.startsWith('vertical-')
  const deadline = Date.now() + 10000
  let status = null
  while (Date.now() < deadline) {
    status = await request(ws, timeoutMs, 'compositor.status')
    const renderIsPortrait = status.height > status.width
    const target =
      typeof status.metalTargetWidth === 'number' && typeof status.metalTargetHeight === 'number'
        ? { width: status.metalTargetWidth, height: status.metalTargetHeight }
        : null
    const targetMatches = !target || target.height > target.width === expectsPortrait
    if (renderIsPortrait === expectsPortrait && targetMatches) {
      return
    }
    await sleep(200)
  }
  throw new Error(
    `Compositor kept rendering ${status?.width}x${status?.height} (metal target ${status?.metalTargetWidth ?? '-'}x${status?.metalTargetHeight ?? '-'}) for ${layout.preset}, expected ${expectsPortrait ? 'portrait' : 'landscape'} — the preview pipeline did not adopt the new canvas.`
  )
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
