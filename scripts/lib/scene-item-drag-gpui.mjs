/**
 * GPUI path for `smoke:scene-item-drag` (plan 260, Batch A): the same drags
 * and the same gate (`scene-item-drag-gate.mjs`) as Electron's CDP harness.
 *
 * Electron reads the DOM's ghost rects and sends trusted pointer events over
 * CDP; the GPUI app answers `scene-stage-state` (the stage's canvas in window
 * points, each item in canvas fractions, the gesture's ghost, the phase) and
 * takes `scene-stage-gesture` (press, move, release through the main window,
 * one at a time). Between moves the smoke reads the ghost and polls
 * `compositor.status` until the backend's editor draft carries it.
 *
 * Not ported, named in the report: Electron's per-step check that the
 * schematic picture sits at the ghost (`pictureFollows`); the GPUI stage
 * draws an item's picture inside its entry's rect, which is the ghost while
 * it is dragged (`smoke_stage_state` reads the same entries the render
 * draws).
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { enableTestPattern, launchGpuiApp, sleep } from './gpui-preview-probe.mjs'
import {
  draftCarriesRectFor,
  evaluateIdleSelection,
  evaluateItemDrag,
  overlayRectAsStage
} from './scene-item-drag-gate.mjs'
import { connectBackend, request } from '../smoke-recording-session.mjs'

/** A canvas-fraction rect as a box in window points. */
export function stageRectInWindow(rect, canvas) {
  return {
    x: canvas.x + rect.x * canvas.width,
    y: canvas.y + rect.y * canvas.height,
    width: rect.width * canvas.width,
    height: rect.height * canvas.height
  }
}

/**
 * A point inside `entry` (canvas fractions) that no entry drawn after it
 * covers, nearest its centre: the stage draws sources, banners, then overlay
 * items, and the top one takes the pointer. The selection's eight handles
 * (corners and edge midpoints) take it before any item: points within
 * `margin` (canvas fractions) of them are skipped too. Null when every point
 * is covered.
 */
export function uncoveredPoint(entry, entries, { selected = null, margin = { x: 0, y: 0 } } = {}) {
  const above = entries.slice(entries.findIndex((candidate) => candidate.id === entry.id) + 1)
  const handles = entries
    .filter((candidate) => candidate.id === selected)
    .flatMap(({ rect }) =>
      [0, 0.5, 1].flatMap((fx) =>
        [0, 0.5, 1]
          .filter((fy) => fx !== 0.5 || fy !== 0.5)
          .map((fy) => ({
            rect: {
              x: rect.x + rect.width * fx - margin.x,
              y: rect.y + rect.height * fy - margin.y,
              width: margin.x * 2,
              height: margin.y * 2
            }
          }))
      )
    )
  const covering = [...above, ...handles]
  const inside = (rect, x, y) =>
    x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height
  const { x, y, width, height } = entry.rect
  const candidates = []
  for (let i = 1; i < 40; i++)
    for (let j = 1; j < 40; j++)
      candidates.push({ x: x + (width * i) / 40, y: y + (height * j) / 40 })
  const centre = { x: x + width / 2, y: y + height / 2 }
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y)
  )
  return (
    candidates.find((point) => !covering.some((other) => inside(other.rect, point.x, point.y))) ??
    null
  )
}

/**
 * The six pointer steps of a drag (Electron's `drag`): `motion` points each,
 * or towards a canvas `corner` so the sixth step lands 2 points inside it.
 */
export function dragSteps(start, canvas, motion) {
  if (!motion.corner) return motion
  return {
    x:
      (motion.corner.endsWith('left')
        ? canvas.x + 2 - start.x
        : canvas.x + canvas.width - 2 - (start.x + start.width)) / 6,
    y:
      (motion.corner.startsWith('top')
        ? canvas.y + 2 - start.y
        : canvas.y + canvas.height - 2 - (start.y + start.height)) / 6
  }
}

export async function runSceneItemDragGpui({
  outputDirectory,
  stripPath,
  timeoutMs,
  report,
  matchBudgetMs,
  restBudgetMs
}) {
  const { app, command, logs, ui } = await launchGpuiApp({
    stateDir: outputDirectory,
    timeoutMs,
    env: { VIDEORC_SMOKE_PREVIEW_MOTION: '1' }
  })
  const backend = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(backend, timeoutMs, method, params)
  const stage = () => command('scene-stage-state')
  const gesture = (action, point) =>
    command('scene-stage-gesture', { action, x: point.x, y: point.y })
  const waitFor = async (what, read, holds, budgetMs = 10000) => {
    const deadline = Date.now() + budgetMs
    let last
    for (;;) {
      last = await read()
      if (holds(last)) return last
      if (Date.now() > deadline)
        throw new Error(`${what} (last: ${JSON.stringify(last)?.slice(0, 2000)})`)
      await sleep(30)
    }
  }
  const draftNow = async () => (await rpc('compositor.status')).editorDraft ?? null
  const settled = () => waitFor('the stage never settled', stage, (state) => state.phase === 'idle')
  /** The Scene page scrolled so the whole canvas is in view (as the freeform
   * port does; Electron's `select` scrolls the stage into view too). */
  const reveal = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { canvas } = await stage()
      const bounds = (await command('main-window-id')).bounds
      assert.ok(canvas && bounds, 'the Scene canvas or the main window has no bounds')
      const viewport = { y: 40, height: bounds.height - 80 }
      if (
        canvas.y >= viewport.y + 20 &&
        canvas.y + canvas.height <= viewport.y + viewport.height - 20
      )
        return canvas
      await ui.scroll(undefined, {
        dy: canvas.y + canvas.height / 2 - (viewport.y + viewport.height / 2)
      })
      await sleep(150)
    }
    throw new Error('the Scene canvas did not scroll fully into view')
  }

  try {
    report.app = 'gpui'
    await enableTestPattern(command)
    const cameraSelected = await command('select-camera-device', { settleMs: 100 }).then(
      () => true,
      (error) => {
        report.skipped.push(`camera corner drop: ${error.message}`)
        console.log(`Skipping the camera corner drop: ${error.message}`)
        return false
      }
    )
    await command('select-layout-preset', {
      preset: cameraSelected ? 'screen-camera' : 'screen-only',
      settleMs: 100
    })
    await command('open-tab', { tab: 'layout' })

    const capability = await command('authorize-smoke-resource', {
      path: stripPath,
      kind: 'input-file'
    })
    const imported = await rpc('banners.importImage', { sourceCapability: capability.capabilityId })
    const bannerId = imported?.id ?? imported?.banner?.id
    assert.ok(bannerId, `banners.importImage returned no id: ${JSON.stringify(imported)}`)
    await rpc('banners.show', { id: bannerId })
    const camera = cameraSelected
      ? (await rpc('scene.get')).sources.find((source) => source.kind === 'camera')
      : null
    if (cameraSelected) assert.ok(camera, 'the preset scene has no camera source')

    const items = [
      {
        label: 'banner',
        stageId: `banner:${bannerId}`,
        committed: async () => {
          const banner = (await rpc('banners.list')).find((candidate) => candidate.id === bannerId)
          return banner ? overlayRectAsStage(banner.horizontal) : null
        }
      },
      {
        label: 'Buddy',
        stageId: 'overlay:buddy',
        committed: async () =>
          overlayRectAsStage((await rpc('overlays.layout.get')).buddy.horizontal)
      },
      camera && {
        label: 'camera',
        corners: { live: 'top-left', floating: 'bottom-left' },
        stageId: camera.id,
        committed: async () =>
          (await rpc('scene.get')).sources.find((source) => source.id === camera.id)?.transform ??
          null
      }
    ].filter(Boolean)
    await waitFor(
      'the banner never showed on the stage',
      stage,
      (state) => state.canvas && state.entries.some((entry) => entry.id === items[0].stageId)
    )
    report.pictures.push(
      'GPUI: the per-step schematic picture check is not ported; the stage draws each picture inside its entry rect, which is the ghost while dragged'
    )

    for (const mode of ['live', 'floating']) {
      console.log(`Scene item drag (GPUI): ${mode}`)
      if (mode === 'live') {
        await command('preview-window-close').catch(() => undefined)
        await waitFor(
          'the Scene canvas never hosted the docked preview',
          stage,
          (state) => state.live === true,
          20000
        )
      } else {
        await command('preview-window-open')
        await waitFor(
          'the Scene canvas never went schematic with the Preview in its window',
          stage,
          (state) => state.live === false,
          20000
        )
      }
      for (const item of items) {
        const present = (await stage()).entries.find((entry) => entry.id === item.stageId)
        if (!present) {
          report.skipped.push(`${mode} ${item.label}: not on the stage`)
          continue
        }
        await select(item)
        await assertIdle(item, mode)
        const motions = item.corners
          ? [{ corner: item.corners[mode] }]
          : [
              { x: -14, y: -9 },
              { x: 11, y: 7 }
            ]
        for (const [index, motion] of motions.entries()) {
          const attempt = await drag(item, mode, index, motion)
          report.drags.push(attempt.record)
          report.failures.push(...attempt.failures)
        }
      }
    }
    if (report.failures.length) throw new Error(report.failures.join('\n'))
    console.log(
      `Scene item drag smoke OK (GPUI): ${report.drags.length} drags${report.skipped.length ? `; skipped: ${report.skipped.join('; ')}` : ''}; evidence ${outputDirectory}`
    )
    return 0
  } catch (error) {
    if (!report.failures.includes(error?.message))
      report.failures.push(error?.stack ?? String(error))
    console.error(`Scene item drag evidence: ${outputDirectory}`)
    return 1
  } finally {
    report.appLog = join(outputDirectory, 'app.log')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(report.appLog, logs.join('\n'))
    backend?.close()
    await app.stop()
  }

  /** Where the pointer takes `entry`, in window points. */
  function grabPoint(entry, state) {
    // A handle takes the pointer ~8 points around its spot: keep 16 clear.
    const point = uncoveredPoint(entry, state.entries, {
      selected: state.selected,
      margin: { x: 16 / state.canvas.width, y: 16 / state.canvas.height }
    })
    assert.ok(point, `${entry.id}: every point of it is under another item`)
    return {
      x: state.canvas.x + point.x * state.canvas.width,
      y: state.canvas.y + point.y * state.canvas.height
    }
  }

  /** The item's chip clicked (`scene-stage-select`), as Electron's `select`. */
  async function select(item) {
    await settled()
    await reveal()
    await command('scene-stage-select', { id: item.stageId })
    await waitFor(
      `${item.label} was never selected`,
      stage,
      (seen) => seen.selected === item.stageId
    )
    await settled()
  }

  async function assertIdle(item, mode) {
    const deadline = Date.now() + (mode === 'live' ? 2000 : 700)
    let draft
    for (;;) {
      draft = await draftNow()
      if (evaluateIdleSelection({ stageId: item.stageId, mode, draft }).ok && mode === 'live') break
      if (Date.now() > deadline) break
      await sleep(20)
    }
    const gate = evaluateIdleSelection({ stageId: item.stageId, mode, draft })
    report.idle.push({ item: item.label, mode, draft, gate })
    for (const failure of gate.failures)
      report.failures.push(`${mode} ${item.label} idle: ${failure}`)
  }

  async function drag(item, mode, index, motion) {
    await settled()
    await reveal()
    const before = await stage()
    const canvas = before.canvas
    const entry = before.entries.find((candidate) => candidate.id === item.stageId)
    assert.ok(canvas && entry, `${item.label}: the stage has no canvas or no entry`)
    const start = stageRectInWindow(entry.rect, canvas)
    const origin = grabPoint(entry, before)
    const step = dragSteps(start, canvas, motion)
    await gesture('press', origin)
    await waitFor(`${item.label}: the press never started a drag`, stage, (state) =>
      Boolean(state.ghost)
    )
    const samples = []
    let point = origin
    for (let count = 1; count <= 6; count++) {
      point = { x: origin.x + step.x * count, y: origin.y + step.y * count }
      await gesture('move', point)
      const movedAt = Date.now()
      const ghost = (await stage()).ghost?.rect ?? null
      const sample = { ghost, draft: null, matchMs: null }
      const deadline = movedAt + matchBudgetMs
      do {
        sample.draft = await draftNow()
        if (ghost && draftCarriesRectFor(sample.draft, item.stageId, ghost)) {
          sample.matchMs = Date.now() - movedAt
          break
        }
        await sleep(5)
      } while (Date.now() < deadline)
      samples.push(sample)
    }
    await gesture('release', point)
    const landed = (await stage()).entries.find((candidate) => candidate.id === item.stageId)
    const released = landed?.rect ?? null
    const after = []
    let rest = null
    const deadline = Date.now() + restBudgetMs
    for (;;) {
      const draft = await draftNow()
      if (!after.length || JSON.stringify(after.at(-1)) !== JSON.stringify(draft)) after.push(draft)
      rest = draft
      const resting =
        mode === 'live' ? draft?.sourceId === item.stageId && !draft.transform : !draft
      if ((resting && (await stage()).phase === 'idle') || Date.now() > deadline) break
      await sleep(10)
    }
    const committed = await item.committed()
    const gate = evaluateItemDrag({
      stageId: item.stageId,
      mode,
      samples,
      released,
      after,
      rest,
      committed
    })
    const record = {
      item: item.label,
      mode,
      index,
      motion,
      samples,
      released,
      after,
      rest,
      committed,
      gate
    }
    const failures = gate.failures.map(
      (failure) => `${mode} ${item.label} drag ${index}: ${failure}`
    )
    const matches = samples.map((sample) => sample.matchMs).filter(Number.isFinite)
    console.log(
      `  ${item.label} drag ${index}: ${matches.length}/${samples.length} samples on the picture (max ${Math.max(...matches, 0).toFixed(0)} ms), rest ${JSON.stringify(rest)}, ${failures.length ? 'FAIL' : 'ok'}`
    )
    return { record, failures }
  }
}
