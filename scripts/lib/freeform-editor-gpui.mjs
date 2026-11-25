/**
 * GPUI path for `smoke:freeform-editor` (plan 260 C5): clicks and drags on the
 * Scene stage through `ui-click` / `ui-drag` absolute window points (gap 1
 * bounds + this PR's drag). DOM/`__freeformSmoke` observation stays Electron.
 */
import assert from 'node:assert/strict'
import { requestSmokeCommand } from './smoke-command-client.mjs'
import { createUiDriver } from './ui-driver.mjs'
import { request } from '../smoke-recording-session.mjs'

/** Matches `apps/videorc/.../stage/mod.rs` `GUTTER`. */
export const STAGE_GUTTER_PX = 28
const BASE_SOURCE_ID = 'source:test-pattern'

/**
 * Authoritative GPUI gesture gate: the backend scene moved (or stayed when
 * cancelled/noop), without DOM frame / pointer-capture evidence.
 */
export function evaluateFreeformGestureGpui(gesture) {
  const failures = []
  if (!gesture.cancelled && !gesture.noop) {
    if (!gesture.revisionAdvanced) failures.push('backend scene revision did not advance')
    if (!validBox(gesture.acceptedRect) || !validBox(gesture.beforeRect)) {
      failures.push('invalid before/after geometry')
    } else if (rectError(gesture.acceptedRect, gesture.beforeRect) < 0.5) {
      failures.push('accepted geometry did not move')
    }
  } else if (gesture.revisionAdvanced) {
    failures.push('cancelled/noop gesture advanced the scene revision')
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] }
}

function validBox(box) {
  return (
    box &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  )
}

function rectError(a, b) {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height)
  )
}

function sourceWindowBox(canvas, transform) {
  return {
    x: canvas.x + transform.x * canvas.width,
    y: canvas.y + transform.y * canvas.height,
    width: transform.width * canvas.width,
    height: transform.height * canvas.height
  }
}

function centre(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function seHandle(box) {
  return { x: box.x + box.width, y: box.y + box.height }
}

/** CDP mouse modifier bit → ui-driver modifiers list. */
function uiModifiers(bits) {
  const out = []
  if (bits & 1) out.push('alt')
  if (bits & 2) out.push('control')
  if (bits & 8) out.push('meta')
  return out
}

/**
 * Runs the GPUI freeform proof into `report`. Throws on hard failure; soft
 * gate failures append to `report.failures`.
 */
export async function runGpuiFreeformEditor({
  launched,
  report,
  outputDirectory,
  timeoutMs,
  connectBackend
}) {
  const smoke = launched.connections['preview-motion-ready']
  const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })
  const ui = createUiDriver(smoke)
  const backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const setScene = async (scene, layout = null) => {
    const status = await request(backend, timeoutMs, 'compositor.status')
    const revision = Number(status.sceneRevision ?? 0) + 1
    await command('backend-debug-rpc', {
      method: 'compositor.scene.update',
      params: {
        revision,
        scene,
        layout: layout ?? status.sceneLayout ?? status.layout ?? null,
        activeScreen: null
      },
      timeoutMs
    })
  }

  await command('studio-replay-buffer', { armed: false }).catch(() => undefined)
  await command('enable-synthetic-source', { settleMs: 200 })
  await command('select-camera-device', { settleMs: 200 })
  await ui.openTab('layout', { waitFor: { id: 'scene-stage' } })

  await command('select-layout-preset', { preset: 'screen-only', settleMs: 200 })
  await ui.click({ id: 'scene-layout-freeform' })
  await sleep(400)

  const stage = await ui.waitFor({ id: 'scene-stage' })
  const stageBounds = stage.bounds
  assert.ok(stageBounds, 'scene-stage has no bounds (gap 1 patch missing from smoke binary)')
  const canvas = {
    x: stageBounds.x + STAGE_GUTTER_PX,
    y: stageBounds.y + STAGE_GUTTER_PX,
    width: stageBounds.width - STAGE_GUTTER_PX * 2,
    height: stageBounds.height - STAGE_GUTTER_PX * 2
  }
  assert.ok(canvas.width > 40 && canvas.height > 40, `canvas too small: ${JSON.stringify(canvas)}`)

  report.display = { width: stageBounds.width, height: stageBounds.height, dpr: 1, app: 'gpui' }
  report.refreshIntervalMs = null
  report.gpui = { canvas, stage: stageBounds, path: 'ui-drag' }

  const seedTransform = { x: 0.3, y: 0.3, width: 0.3, height: 0.3 }
  await patchSourceTransform(backend, timeoutMs, BASE_SOURCE_ID, seedTransform, setScene)
  await sleep(300)

  // Select the test-pattern source by clicking its centre.
  {
    const scene = await request(backend, timeoutMs, 'scene.get')
    const source = scene.sources.find((candidate) => candidate.id === BASE_SOURCE_ID)
    assert.ok(source, `Missing ${BASE_SOURCE_ID}`)
    const box = sourceWindowBox(canvas, source.transform)
    await ui.clickAt(centre(box).x, centre(box).y)
    await sleep(150)
  }

  for (const orientation of ['landscape', 'portrait']) {
    console.log(`Freeform (GPUI): ${orientation} pointer matrix`)
    await command('select-layout-preset', {
      preset: orientation === 'landscape' ? 'screen-only' : 'vertical-screen-only',
      settleMs: 200
    })
    await ui.click({ id: 'scene-layout-freeform' }).catch(() => undefined)
    await sleep(300)
    await patchSourceTransform(backend, timeoutMs, BASE_SOURCE_ID, seedTransform, setScene)
    await sleep(200)

    for (let index = 0; index < 4; index++) {
      await gpuiGesture({
        ui,
        backend,
        timeoutMs,
        canvas,
        report,
        orientation,
        kind: 'move',
        index,
        delayMs: index % 2 ? 50 : 250
      })
      await gpuiGesture({
        ui,
        backend,
        timeoutMs,
        canvas,
        report,
        orientation,
        kind: 'resize',
        index,
        delayMs: index % 2 ? 250 : 50
      })
    }
    await gpuiGesture({
      ui,
      backend,
      timeoutMs,
      canvas,
      report,
      orientation,
      kind: 'move',
      index: 0,
      delayMs: 250,
      cancellation: 'escape'
    })
    await gpuiGesture({
      ui,
      backend,
      timeoutMs,
      canvas,
      report,
      orientation,
      kind: 'move',
      index: 1,
      delayMs: 250,
      noop: true
    })
    await gpuiGesture({
      ui,
      backend,
      timeoutMs,
      canvas,
      report,
      orientation,
      kind: 'move',
      index: 1,
      delayMs: 250,
      modifiers: 8
    })
  }

  // select-camera-shape (shared with preview-scene-commit).
  await command('select-layout-preset', { preset: 'screen-camera', settleMs: 200 })
  await command('select-camera-shape', { shape: 'circle', settleMs: 200 })
  const afterCircle = await request(backend, timeoutMs, 'compositor.status')
  const circleShape =
    afterCircle?.sceneLayout?.cameraShape ?? afterCircle?.layout?.cameraShape ?? null
  if (circleShape !== 'circle') {
    report.failures.push(`select-camera-shape circle → ${JSON.stringify(circleShape)}`)
  }
  await command('select-camera-shape', { shape: 'rectangle', settleMs: 200 })

  report.screenshots.push({
    note: 'GPUI freeform skips CDP visualMatrix; shape via select-camera-shape'
  })

  if (report.failures.length) throw new Error(report.failures.join('\n'))
  console.log(
    `Freeform editor smoke OK (GPUI): ${report.gestures.length} ui-drag gestures; evidence ${outputDirectory}`
  )
}

async function patchSourceTransform(backend, timeoutMs, sourceId, transform, setScene) {
  const scene = await request(backend, timeoutMs, 'scene.get')
  const sources = scene.sources.map((source) =>
    source.id === sourceId ? { ...source, transform: { ...source.transform, ...transform } } : source
  )
  await setScene({ ...scene, sources })
}

async function gpuiGesture({
  ui,
  backend,
  timeoutMs,
  canvas,
  report,
  orientation,
  kind,
  index,
  delayMs,
  cancellation,
  noop = false,
  modifiers = 0
}) {
  const scene = await request(backend, timeoutMs, 'scene.get')
  const source = scene.sources.find((candidate) => candidate.id === BASE_SOURCE_ID)
  assert.ok(source, `Missing ${BASE_SOURCE_ID}`)
  const box = sourceWindowBox(canvas, source.transform)
  const origin = kind === 'resize' ? seHandle(box) : centre(box)
  const before = await request(backend, timeoutMs, 'compositor.status')
  const beforeRect = {
    x: canvas.x + source.transform.x * canvas.width,
    y: canvas.y + source.transform.y * canvas.height,
    width: source.transform.width * canvas.width,
    height: source.transform.height * canvas.height
  }

  if (cancellation === 'escape') {
    // Mid-gesture cancel needs a multi-step drag API; prove Escape on a
    // selected source does not commit a transform.
    await ui.clickAt(origin.x, origin.y)
    await ui.press('Escape')
  } else {
    const sign = index % 2 ? -1 : 1
    const points = (noop ? [0] : [2, 4, 6, 8]).map((amount) => ({
      x: origin.x + sign * amount,
      y: origin.y + (sign * amount) / 2
    }))
    const end = points.at(-1)
    await ui.drag(origin.x, origin.y, end.x, end.y, {
      steps: Math.max(1, points.length),
      modifiers: uiModifiers(modifiers)
    })
  }

  await sleep(delayMs + 200)

  const accepted = await request(backend, timeoutMs, 'scene.get')
  const status = await request(backend, timeoutMs, 'compositor.status')
  const transform = accepted.sources.find((candidate) => candidate.id === BASE_SOURCE_ID)?.transform
  const acceptedRect = transform && {
    x: canvas.x + transform.x * canvas.width,
    y: canvas.y + transform.y * canvas.height,
    width: transform.width * canvas.width,
    height: transform.height * canvas.height
  }
  const data = {
    orientation,
    kind,
    index,
    delayMs,
    cancelled: Boolean(cancellation),
    noop,
    modifiers,
    beforeRect,
    acceptedRect,
    revisionAdvanced: status.sceneRevision > before.sceneRevision,
    revisionBefore: before.sceneRevision,
    revisionAfter: status.sceneRevision,
    canvas,
    app: 'gpui'
  }
  const gate = evaluateFreeformGestureGpui(data)
  report.gestures.push({ ...data, gate, ok: gate.ok })
  if (!gate.ok) {
    report.failures.push(
      `GPUI ${orientation} ${kind}#${index}: ${gate.failures.join('; ')}`
    )
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
