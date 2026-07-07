#!/usr/bin/env node
// Preview scene commit smoke: scene edits must advance through backend-owned
// revisions, even after the compositor has a high wallclock/session revision.

import { request as httpRequest } from 'node:http'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const settleMs = Number(process.env.VIDEORC_PREVIEW_SCENE_COMMIT_SETTLE_MS ?? 800)
const outputDirectory = join(tmpdir(), `videorc-preview-scene-commit-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
  }
})

let ws
try {
  const backend = launched.connections['backend-ready']
  const smoke = launched.connections['preview-motion-ready']
  ws = await connectBackend(backend, timeoutMs)

  await smokeCommand(smoke, 'open-tab', {
    tab: 'studio',
    waitFor: '[data-videorc-preview-card]'
  })
  await smokeCommand(smoke, 'preview-window-open')
  await waitForSurfaceLive(smoke)
  await smokeCommand(smoke, 'enable-synthetic-source', { settleMs })
  // Isolated smoke profiles persist no camera; screen-camera needs one selected.
  await smokeCommand(smoke, 'select-camera-device', { settleMs })
  await smokeCommand(smoke, 'select-layout-preset', { preset: 'screen-camera', settleMs })
  await sleep(settleMs)

  const beforeScene = await request(ws, timeoutMs, 'scene.get')
  const beforeCompositor = await request(ws, timeoutMs, 'compositor.status')
  const highRevision = Math.max(Number(beforeCompositor.sceneRevision ?? 0), Date.now() + 1_000_000)
  const layout = beforeCompositor.sceneLayout ?? defaultLayout()

  const highStatus = await request(ws, timeoutMs, 'compositor.scene.update', {
    revision: highRevision,
    scene: beforeScene,
    layout,
    activeScreen: null
  })
  if (highStatus.sceneRevision !== highRevision) {
    throw new Error(
      `High revision setup failed: expected ${highRevision}, got ${highStatus.sceneRevision}.`
    )
  }

  await smokeCommand(smoke, 'select-camera-shape', { shape: 'circle', settleMs })
  const shapeCompositor = await waitForCompositorCameraShape(ws, 'circle', highRevision)
  const shapeSurface = await waitForSurfaceCameraShape(
    smoke,
    'circle',
    shapeCompositor.sceneRevision
  )
  assertCameraShapeCommit({ compositor: shapeCompositor, surface: shapeSurface, highRevision })

  const marginValue = 18
  await smokeCommand(smoke, 'open-layout-tab')
  const marginInputResult = await smokeCommand(smoke, 'eval-js', {
    code: `
      const camera = document.querySelector('[data-videorc-stage-source="source:camera"]')
      camera?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
      camera?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
      camera?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

      const input = document.querySelector('input[aria-label="Margin value"]')
      if (!input) return { ok: false, reason: 'margin input missing' }

      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '${marginValue}')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      }))
      input.blur()
      await sleep(${settleMs})
      return { ok: true, value: input.value }
    `
  })
  if (marginInputResult?.ok === false) {
    throw new Error(`Margin input was not available: ${JSON.stringify(marginInputResult)}`)
  }
  const marginCompositor = await waitForCompositorCameraMargin(
    ws,
    marginValue,
    shapeCompositor.sceneRevision
  )
  const marginSurface = await waitForSurfaceRevision(smoke, marginCompositor.sceneRevision)
  const marginScene = await request(ws, timeoutMs, 'scene.get')
  assertCameraMarginCommit({
    compositor: marginCompositor,
    surface: marginSurface,
    scene: marginScene,
    margin: marginValue
  })

  const shapedScene = await request(ws, timeoutMs, 'scene.get')
  const source =
    shapedScene.sources.find((candidate) => candidate.visible) ?? shapedScene.sources[0]
  if (!source) {
    throw new Error(`Scene has no source to mutate: ${JSON.stringify(shapedScene)}`)
  }

  const nextX = Math.min(0.82, Math.max(0.02, Number(source.transform?.x ?? 0) + 0.03))
  const commit = await request(ws, timeoutMs, 'scene.source.transform.update', {
    sourceId: source.id,
    transform: { x: nextX }
  })
  if (typeof commit.sceneRevision !== 'number') {
    throw new Error(
      `Scene transform returned an uncommitted response instead of SceneCommitStatus: ${JSON.stringify(
        commit
      )}`
    )
  }
  if (commit.sceneRevision <= highRevision) {
    throw new Error(
      `Scene transform committed revision ${commit.sceneRevision}, expected > ${highRevision}.`
    )
  }

  const compositor = await waitForCompositorRevision(ws, commit.sceneRevision)
  const surface = await waitForSurfaceRevision(smoke, commit.sceneRevision)
  const scene = await request(ws, timeoutMs, 'scene.get')
  assertCommitResult({ commit, compositor, surface, scene, sourceId: source.id, nextX })

  console.log(
    `Preview scene commit smoke OK - stale revision ${highRevision} advanced through camera shape ${shapeCompositor.sceneRevision}, margin ${marginCompositor.sceneRevision}, and transform ${commit.sceneRevision}, surface ${surface.sceneRevision}.`
  )
} finally {
  try {
    ws?.close()
  } catch {
    // Best-effort cleanup.
  }
  await launched.stop()
}

async function waitForSurfaceLive(smoke) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await smokeCommand(smoke, 'native-preview-surface-status')
    if (last.state === 'live' && last.bounds?.width > 0 && last.bounds?.height > 0) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for live preview surface. Last status: ${JSON.stringify(last)}`
  )
}

async function waitForCompositorRevision(connection, revision) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await request(connection, timeoutMs, 'compositor.status')
    if (last.sceneRevision === revision && last.frameSceneRevision === revision) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for compositor rendered revision ${revision}. Last status: ${JSON.stringify(
      last
    )}`
  )
}

async function waitForCompositorCameraShape(connection, shape, minRevision) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await request(connection, timeoutMs, 'compositor.status')
    const camera = last.sceneSources?.find((source) => source.kind === 'camera')
    if (
      last.sceneRevision > minRevision &&
      last.frameSceneRevision === last.sceneRevision &&
      last.sceneLayout?.cameraShape === shape &&
      camera?.shape === shape
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for compositor camera shape ${shape} after revision ${minRevision}. Last status: ${JSON.stringify(
      last
    )}`
  )
}

async function waitForCompositorCameraMargin(connection, margin, minRevision) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await request(connection, timeoutMs, 'compositor.status')
    const camera = last.sceneSources?.find((source) => source.kind === 'camera')
    if (
      last.sceneRevision > minRevision &&
      last.frameSceneRevision === last.sceneRevision &&
      last.sceneLayout?.cameraMargin === margin &&
      camera
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for compositor camera margin ${margin} after revision ${minRevision}. Last status: ${JSON.stringify(
      last
    )}`
  )
}

async function waitForSurfaceRevision(smoke, revision) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await smokeCommand(smoke, 'preview-surface-scene-state')
    if (last.sceneRevision === revision) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for detached preview surface revision ${revision}. Last state: ${JSON.stringify(
      last
    )}`
  )
}

async function waitForSurfaceCameraShape(smoke, shape, revision) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await smokeCommand(smoke, 'preview-surface-scene-state')
    if (last.sceneRevision === revision && last.cameraShape === shape) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for detached preview surface camera shape ${shape} at revision ${revision}. Last state: ${JSON.stringify(
      last
    )}`
  )
}

function assertCameraMarginCommit({ compositor, surface, scene, margin }) {
  if (compositor.sceneLayout?.cameraMargin !== margin) {
    throw new Error(
      `Compositor layout did not commit margin ${margin}: ${JSON.stringify(compositor)}`
    )
  }
  if (surface.sceneRevision !== compositor.sceneRevision) {
    throw new Error(
      `Preview surface revision ${surface.sceneRevision} did not match margin commit ${compositor.sceneRevision}.`
    )
  }
  if (surface.surfaceStatus?.state !== 'live') {
    throw new Error(`Preview surface is not live after margin commit: ${JSON.stringify(surface)}`)
  }

  const camera = scene.sources.find((source) => source.kind === 'camera')
  if (!camera) {
    throw new Error(`Committed scene lost camera source: ${JSON.stringify(scene)}`)
  }
  const output =
    scene.outputs?.find((candidate) => candidate.kind === 'recording') ?? scene.outputs?.[0]
  if (!output?.width || !output?.height) {
    throw new Error(`Committed scene has no recording output dimensions: ${JSON.stringify(scene)}`)
  }

  const rightMargin = 1 - (Number(camera.transform?.x ?? 0) + Number(camera.transform?.width ?? 0))
  const bottomMargin =
    1 - (Number(camera.transform?.y ?? 0) + Number(camera.transform?.height ?? 0))
  const scale = Math.min(output.width / 1280, output.height / 720)
  const scaledMargin = Math.max(1, Math.round(margin * scale))
  const expectedRightMargin = scaledMargin / output.width
  const expectedBottomMargin = scaledMargin / output.height
  if (Math.abs(rightMargin - expectedRightMargin) > 0.0001) {
    throw new Error(
      `Committed camera right margin ${rightMargin}, expected ${expectedRightMargin}: ${JSON.stringify(camera.transform)}`
    )
  }
  if (Math.abs(bottomMargin - expectedBottomMargin) > 0.0001) {
    throw new Error(
      `Committed camera bottom margin ${bottomMargin}, expected ${expectedBottomMargin}: ${JSON.stringify(camera.transform)}`
    )
  }
}

function assertCameraShapeCommit({ compositor, surface, highRevision }) {
  if (compositor.sceneRevision <= highRevision) {
    throw new Error(
      `Camera shape commit revision ${compositor.sceneRevision} did not advance past ${highRevision}.`
    )
  }
  if (compositor.sceneLayout?.cameraShape !== 'circle') {
    throw new Error(`Compositor layout did not commit circle: ${JSON.stringify(compositor)}`)
  }
  const camera = compositor.sceneSources?.find((source) => source.kind === 'camera')
  if (camera?.shape !== 'circle') {
    throw new Error(`Compositor camera source stayed ${camera?.shape}: ${JSON.stringify(camera)}`)
  }
  if (surface.cameraShape !== 'circle' || surface.sourceShapes?.['source:camera'] !== 'circle') {
    throw new Error(
      `Preview surface camera shape did not commit circle: ${JSON.stringify(surface)}`
    )
  }
}

function assertCommitResult({ commit, compositor, surface, scene, sourceId, nextX }) {
  if (compositor.sceneRevision !== commit.sceneRevision) {
    throw new Error(
      `Compositor revision ${compositor.sceneRevision} did not match commit ${commit.sceneRevision}.`
    )
  }
  if (compositor.frameSceneRevision !== commit.sceneRevision) {
    throw new Error(
      `Compositor frame revision ${compositor.frameSceneRevision} did not render commit ${commit.sceneRevision}.`
    )
  }
  if (surface.sceneRevision !== commit.sceneRevision) {
    throw new Error(
      `Preview surface revision ${surface.sceneRevision} did not match commit ${commit.sceneRevision}.`
    )
  }
  const source = scene.sources.find((candidate) => candidate.id === sourceId)
  if (!source) {
    throw new Error(`Committed scene lost source ${sourceId}: ${JSON.stringify(scene)}`)
  }
  if (Math.abs(Number(source.transform?.x ?? 0) - nextX) > 0.0001) {
    throw new Error(
      `Committed scene source ${sourceId} x=${source.transform?.x}, expected ${nextX}.`
    )
  }
  if (!surface.visibleSourceIds?.includes(sourceId)) {
    throw new Error(
      `Preview surface visible sources ${surface.visibleSourceIds?.join(', ') ?? '(none)'} did not include ${sourceId}.`
    )
  }
  if (surface.surfaceStatus?.state !== 'live') {
    throw new Error(`Preview surface is not live: ${JSON.stringify(surface.surfaceStatus)}`)
  }
}

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const payload = JSON.parse(data)
            if (res.statusCode !== 200 || payload.error) {
              reject(
                new Error(
                  `Smoke command ${command} failed (${res.statusCode}): ${payload.error ?? data}`
                )
              )
              return
            }
            resolve(payload.result ?? payload)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function defaultLayout() {
  return {
    layoutPreset: 'screen-camera',
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
