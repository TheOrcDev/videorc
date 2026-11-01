#!/usr/bin/env node
// A banner and the Buddy dragged on the Scene canvas show where they will
// drop, as they will look, before the drop; so does the camera of an inset
// preset scene moved into a canvas corner, where the drop re-enters the
// preset (its box at that corner, not where the pointer let go).
//
// Trusted Chromium input drags each item on the mounted Scene stage in the dev
// app (isolated profile, synthetic sources), twice:
//
// - live: the native preview docked into the canvas (macOS). Every drag
//   sample's editor draft must carry the DOM ghost's rect, so the compositor
//   draws the banner's image and the Buddy's pet there (the pixels are
//   asserted in `compositor.rs`: `a_banner_draft_moves_the_picture_without_a_prepare`
//   and `a_buddy_draft_draws_the_pet_where_the_editor_drags_it`); the dropped
//   rect stays until its save lands, then the selection is held (a
//   chrome-only draft, which is also what keeps the Buddy on the idle
//   picture while it is selected).
// - floating: the preview in its own window, the canvas schematic. The
//   schematic draws each item's picture (the banner's image, the Buddy's
//   still) and moves it with the ghost; the floating preview follows the
//   drag's drafts and holds nothing at rest.
//
// Evidence (report.json, failure screenshot) goes to a temp directory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  createFreeformMouseSequence,
  freeformLiveSurfaceReady
} from './lib/freeform-editor-gate.mjs'
import {
  draftCarriesRectFor,
  evaluateIdleSelection,
  evaluateItemDrag,
  normalizeToCanvas,
  overlayRectAsStage
} from './lib/scene-item-drag-gate.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.serial = 0
    this.pending = new Map()
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), {
        once: true
      })
    })
  }
  send(method, params = {}) {
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    return result.result.value
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.socket.close()
  }
}

if (platform() !== 'darwin') {
  console.log('Scene item drag smoke: skipped, the live canvas is macOS only.')
  process.exit(0)
}

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-scene-item-drag-'))
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-scene-item-drag-user-data-'))
/** How long a drag sample may take to reach the backend, and a drop its rest. */
const MATCH_BUDGET_MS = 1000
const REST_BUDGET_MS = 3000
const report = {
  outputDirectory,
  drags: [],
  interrupted: [],
  idle: [],
  pictures: [],
  skipped: [],
  failures: []
}

const stripPath = join(outputDirectory, 'banner-strip.png')
const png = spawnSync(
  ffmpegPath,
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=magenta:s=1200x300',
    '-frames:v',
    '1',
    '-vf',
    'format=rgba',
    stripPath
  ],
  { encoding: 'utf8' }
)
assert.equal(png.status, 0, `ffmpeg could not make the banner fixture: ${png.stderr}`)

let devtoolsUrl
let cdp
let backend
const launched = await launchDevApp({
  timeoutMs,
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_REMOTE_DEBUG_PORT: '0',
    VIDEORC_USER_DATA_DIR: userDataDir,
    // The Banners dir sits beside the database, like Screens.
    VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
  },
  onLine(line) {
    appendFileSync(join(outputDirectory, 'launch.log'), line + '\n')
    const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (endpoint) devtoolsUrl = endpoint[1]
  }
})
const mouseEvent = createFreeformMouseSequence()
const smoke = launched.connections['preview-motion-ready']
const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })
try {
  assert.ok(devtoolsUrl, 'Electron did not expose its development CDP endpoint')
  const targets = await (await fetch(`http://${new URL(devtoolsUrl).host}/json/list`)).json()
  const target = targets.find(
    (entry) => entry.type === 'page' && /^https?:\/\/localhost/.test(entry.url)
  )
  assert.ok(target, 'main renderer CDP target missing')
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.bringToFront')
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  await cdp.eval(`localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1')`)
  await cdp.eval(`(${installGestureEndRecorder.toString()})()`)
  // A cold dev server can still be transforming the lazy Sources tab here
  // (its fallback reads "Opening Videorc..."): give it a few tries.
  for (let attempt = 1; ; attempt++) {
    try {
      await command('enable-synthetic-source', { settleMs: 100 })
      break
    } catch (error) {
      if (attempt >= 6) throw error
      console.log(`Waiting for the Sources tab to load (attempt ${attempt})`)
    }
  }
  // The camera corner drop needs a camera; a dev app without the camera
  // permission has none, and the case is skipped, said in the report.
  const cameraSelected = await command('select-camera-device', { settleMs: 100 }).then(
    () => true,
    (error) => {
      report.skipped.push(`camera corner drop: ${error.message}`)
      console.log(`Skipping the camera corner drop: ${error.message}`)
      return false
    }
  )
  await cdp.eval(
    `(async () => {const deadline=performance.now()+5000;while(document.querySelector('[data-slot="dialog-overlay"][data-open]')){document.querySelectorAll('[data-slot="dialog-close"]').forEach(button=>button.click());document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(performance.now()>deadline)throw Error('Could not dismiss launch dialog');await new Promise(resolve=>setTimeout(resolve,100))}})()`
  )
  await command('select-layout-preset', {
    preset: cameraSelected ? 'screen-camera' : 'screen-only',
    settleMs: 100
  })
  await command('open-layout-tab')

  const capability = await command('authorize-smoke-resource', {
    path: stripPath,
    kind: 'input-file'
  })
  const imported = await request(backend, timeoutMs, 'banners.importImage', {
    sourceCapability: capability.capabilityId
  })
  const bannerId = imported?.id ?? imported?.banner?.id
  assert.ok(bannerId, `banners.importImage returned no id: ${JSON.stringify(imported)}`)
  await request(backend, timeoutMs, 'banners.show', { id: bannerId })
  // In the inset preset the camera drags too; a drop in a canvas corner
  // re-enters the preset there, and the stage shows that box before the drop.
  const camera = cameraSelected
    ? (await request(backend, timeoutMs, 'scene.get')).sources.find(
        (source) => source.kind === 'camera'
      )
    : null
  if (cameraSelected) assert.ok(camera, 'the preset scene has no camera source')
  const items = [
    {
      label: 'banner',
      picture: true,
      stageId: `banner:${bannerId}`,
      chip: `[data-videorc-stage-banner-chip="${bannerId}"]`,
      bounds: `[data-videorc-stage-banner="${bannerId}"] [data-videorc-stage-overlay-bounds]`,
      committed: async () => {
        const banner = (await request(backend, timeoutMs, 'banners.list')).find(
          (candidate) => candidate.id === bannerId
        )
        return banner ? overlayRectAsStage(banner.horizontal) : null
      }
    },
    {
      label: 'Buddy',
      picture: true,
      stageId: 'overlay:buddy',
      chip: '[data-videorc-stage-overlay-chip="buddy"]',
      bounds: '[data-videorc-stage-overlay="buddy"] [data-videorc-stage-overlay-bounds]',
      committed: async () =>
        overlayRectAsStage(
          (await request(backend, timeoutMs, 'overlays.layout.get')).buddy.horizontal
        )
    },
    camera && {
      label: 'camera',
      picture: false,
      corners: { live: 'top-left', floating: 'bottom-left' },
      stageId: camera.id,
      chip: `button[aria-label=${JSON.stringify(`Select ${camera.name}`)}]`,
      bounds: `[data-videorc-stage-source=${JSON.stringify(camera.id)}] [data-videorc-stage-bounds]`,
      committed: async () =>
        (await request(backend, timeoutMs, 'scene.get')).sources.find(
          (source) => source.id === camera.id
        )?.transform ?? null
    }
  ].filter(Boolean)
  await waitUntil(`document.querySelector(${JSON.stringify(items[0].bounds)}) !== null`)

  for (const mode of ['live', 'floating']) {
    console.log(`Scene item drag: ${mode}`)
    if (mode === 'live') await ensureLiveSurface()
    else await ensureFloatingPreview()
    for (const item of items) {
      await select(item)
      await assertIdle(item, mode)
      if (item.picture) await assertPicture(item, mode)
      const motions = item.corners
        ? [{ corner: item.corners[mode] }]
        : [
            { x: -14, y: -9 },
            { x: 11, y: 7 }
          ]
      for (const [index, motion] of motions.entries()) {
        // A window blur ends any gesture by design (the user left the app).
        // macOS can move focus while another app is frontmost: such a drag
        // is reported as interrupted and made once more, never passed.
        let attempt = await drag(item, mode, index, motion)
        if (attempt.interrupted) {
          report.interrupted.push(attempt.record)
          console.log(`  ${item.label} drag ${index}: interrupted by ${attempt.interrupted}, again`)
          await select(item)
          attempt = await drag(item, mode, index, motion)
        }
        report.drags.push(attempt.record)
        report.failures.push(...attempt.failures)
      }
    }
  }
  if (report.failures.length) throw new Error(report.failures.join('\n'))
  console.log(
    `Scene item drag smoke OK: ${report.drags.length} drags${report.skipped.length ? `; skipped: ${report.skipped.join('; ')}` : ''}; evidence ${outputDirectory}`
  )
} catch (error) {
  const failureShot = await cdp?.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (failureShot) {
    report.failureScreenshot = join(outputDirectory, 'failure.png')
    writeFileSync(report.failureScreenshot, Buffer.from(failureShot.data, 'base64'))
  }
  if (!report.failures.includes(error?.message)) report.failures.push(error?.stack ?? String(error))
  console.error(`Scene item drag evidence: ${outputDirectory}`)
  process.exitCode = 1
} finally {
  writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
  cdp?.close()
  backend?.close()
  await launched.stop()
}

/** Six trusted pointer steps from the item's centre (`motion` CSS px each, or
 * into a canvas `corner`), then a release; every step's ghost must reach the
 * backend as a draft. */
async function drag(item, mode, index, motion) {
  await settled()
  const canvas = await box('[data-videorc-stage-canvas]')
  const start = await box(item.bounds)
  assert.ok(canvas && start, `${item.label}: stage boxes missing`)
  const origin = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
  const step = motion.corner
    ? {
        x:
          (motion.corner.endsWith('left')
            ? canvas.x + 2 - start.x
            : canvas.x + canvas.width - 2 - (start.x + start.width)) / 6,
        y:
          (motion.corner.startsWith('top')
            ? canvas.y + 2 - start.y
            : canvas.y + canvas.height - 2 - (start.y + start.height)) / 6
      }
    : motion
  await cdp.eval('window.__sceneItemDragEvents.length = 0')
  await mouse('mouseMoved', origin)
  await mouse('mousePressed', origin)
  await waitUntil(
    `document.querySelector('[data-videorc-stage-phase]')?.dataset.videorcStagePhase === 'dragging'`
  )
  const samples = []
  let point = origin
  for (let count = 1; count <= 6; count++) {
    point = { x: origin.x + step.x * count, y: origin.y + step.y * count }
    await mouse('mouseMoved', point)
    await frames(2)
    const movedAt = performance.now()
    const ghost = normalizeToCanvas(await box(item.bounds), canvas)
    const sample = { ghost, draft: null, matchMs: null }
    const deadline = movedAt + MATCH_BUDGET_MS
    do {
      sample.draft = (await request(backend, timeoutMs, 'compositor.status')).editorDraft ?? null
      if (draftCarriesRectFor(sample.draft, item.stageId, ghost)) {
        sample.matchMs = performance.now() - movedAt
        break
      }
      await sleep(5)
    } while (performance.now() < deadline)
    if (mode === 'floating' && item.picture)
      sample.picture = await pictureFollows(item, ghost, canvas)
    samples.push(sample)
  }
  // What could end the gesture early (the stage cancels on each of these).
  const events = await cdp.eval('window.__sceneItemDragEvents.splice(0)')
  await mouse('mouseReleased', point)
  await frames(1)
  const released = normalizeToCanvas(await box(item.bounds), canvas)
  const after = []
  let rest = null
  const deadline = performance.now() + REST_BUDGET_MS
  for (;;) {
    const draft = (await request(backend, timeoutMs, 'compositor.status')).editorDraft ?? null
    if (!after.length || JSON.stringify(after.at(-1)) !== JSON.stringify(draft)) after.push(draft)
    rest = draft
    const resting = mode === 'live' ? draft?.sourceId === item.stageId && !draft.transform : !draft
    if ((resting && (await phase()) === 'idle') || performance.now() > deadline) break
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
  const pictureFailures = samples
    .filter((sample) => sample.picture && !sample.picture.ok)
    .map(
      (sample) =>
        `the schematic picture did not move with the ghost: ${JSON.stringify(sample.picture)}`
    )
  const record = {
    item: item.label,
    mode,
    index,
    motion,
    events,
    samples,
    released,
    after,
    rest,
    committed,
    gate
  }
  const failures = [...gate.failures, ...pictureFailures].map(
    (failure) =>
      `${mode} ${item.label} drag ${index}: ${failure}${events.length ? ` (during the drag: ${events.map((event) => event.name).join(', ')})` : ''}`
  )
  const blur = events.find((event) => event.name === 'blur')
  if (failures.length && blur) return { record, failures, interrupted: 'a window blur' }
  const matches = samples.map((sample) => sample.matchMs).filter(Number.isFinite)
  console.log(
    `  ${item.label} drag ${index}: ${matches.length}/${samples.length} samples on the picture (max ${Math.max(...matches, 0).toFixed(0)} ms), rest ${JSON.stringify(rest)}, ${failures.length ? 'FAIL' : 'ok'}`
  )
  return { record, failures, interrupted: null }
}

/** On the schematic, the item's picture sits where its rect is drawn. */
async function pictureFollows(item, ghost, canvas) {
  const picture = await box(`[data-videorc-stage-item-picture="${item.stageId}"]`)
  if (!picture) return { ok: false, reason: 'no picture' }
  const rect = normalizeToCanvas(picture, canvas)
  // A banner's picture is its rect; the Buddy's pet sits inside its zone.
  const ok =
    item.label === 'banner'
      ? ['x', 'y', 'width', 'height'].every((key) => Math.abs(rect[key] - ghost[key]) <= 2e-3)
      : Math.abs(rect.x + rect.width / 2 - (ghost.x + ghost.width / 2)) <= 2e-3
  return { ok, rect, ghost }
}

async function select(item) {
  await settled()
  await cdp.eval(`document.querySelector(${JSON.stringify(item.chip)}).click()`)
  await waitUntil(
    `document.querySelector(${JSON.stringify(item.chip)})?.hasAttribute('data-pressed')`
  )
  await cdp.eval(
    `document.activeElement?.blur(); document.querySelector('[data-videorc-stage-phase]').scrollIntoView({block:'center',behavior:'instant'})`
  )
  await frames(3)
}

async function assertIdle(item, mode) {
  // The hold may take a heartbeat to land; the floating preview must stay clear.
  const deadline = performance.now() + (mode === 'live' ? 2000 : 700)
  let draft
  for (;;) {
    draft = (await request(backend, timeoutMs, 'compositor.status')).editorDraft ?? null
    if (evaluateIdleSelection({ stageId: item.stageId, mode, draft }).ok && mode === 'live') break
    if (performance.now() > deadline) break
    await sleep(20)
  }
  const gate = evaluateIdleSelection({ stageId: item.stageId, mode, draft })
  report.idle.push({ item: item.label, mode, draft, gate })
  for (const failure of gate.failures)
    report.failures.push(`${mode} ${item.label} idle: ${failure}`)
}

/** The schematic draws the item's picture; the live canvas leaves it to the compositor. */
async function assertPicture(item, mode) {
  const state = await cdp.eval(
    `(() => {const element=document.querySelector('[data-videorc-stage-item-picture="${item.stageId}"]');return element?{visibility:getComputedStyle(element).visibility,href:element.getAttribute('href')}:null})()`
  )
  report.pictures.push({ item: item.label, mode, state })
  if (!state?.href) report.failures.push(`${mode} ${item.label}: no picture on the stage`)
  else if (state.visibility !== (mode === 'live' ? 'hidden' : 'visible'))
    report.failures.push(
      `${mode} ${item.label}: picture is ${state.visibility} on the ${mode} canvas`
    )
}

async function ensureLiveSurface() {
  const before = await command('preview-window-state')
  if (!(before.open && before.mode === 'docked')) {
    await command('preview-window-set-mode', { mode: 'docked' })
    await command('preview-window-open')
  }
  // Plan 210 put Scenes and Layouts above the canvas, so on a laptop-height
  // window it starts below the fold. The docked surface hides while its slot is
  // scrolled away, and the stage never reads live until the canvas is in view.
  await cdp.eval(
    `document.querySelector('[data-videorc-stage-phase]')?.scrollIntoView({block:'center',behavior:'instant'})`
  )
  await waitUntil(`document.querySelector('[data-videorc-stage-live="true"]') !== null`)
  const deadline = performance.now() + 10000
  let readiness
  do {
    readiness = {
      before: await command('preview-window-state'),
      surface: await command('native-preview-surface-status'),
      after: await command('preview-window-state')
    }
    if (freeformLiveSurfaceReady(readiness)) break
    await frames(1)
  } while (performance.now() < deadline)
  assert.ok(freeformLiveSurfaceReady(readiness), 'the docked surface never became the canvas')
  await focusMainWindow()
}

async function ensureFloatingPreview() {
  await command('preview-window-set-mode', { mode: 'floating' })
  const state = await command('preview-window-state')
  if (!state.open) await command('preview-window-open')
  await waitUntil(`document.querySelector('[data-videorc-stage-live="true"]') === null`)
  await focusMainWindow()
}

/** Records, in the renderer, the events the stage ends a gesture on. */
function installGestureEndRecorder() {
  window.__sceneItemDragEvents = []
  for (const name of ['scroll', 'blur', 'resize', 'lostpointercapture', 'pointercancel'])
    window.addEventListener(
      name,
      (event) =>
        window.__sceneItemDragEvents.push({
          name,
          at: performance.now(),
          target:
            event.target === window
              ? 'window'
              : (event.target?.getAttribute?.('data-slot') ??
                event.target?.tagName ??
                String(event.target))
        }),
      true
    )
}

/** Gestures need no keyboard focus, only no blur while one runs (the stage
 * cancels on blur, which would fail that drag). macOS keeps a dev app in the
 * background while another app is frontmost: that is recorded, not fatal. */
async function focusMainWindow() {
  await cdp.send('Page.bringToFront')
  const { focused } = await command('main-window-focus')
  const deadline = performance.now() + 3000
  let hasFocus = await cdp.eval('document.hasFocus()')
  while (!hasFocus && performance.now() < deadline) {
    await sleep(50)
    hasFocus = await cdp.eval('document.hasFocus()')
  }
  report.focus ??= []
  report.focus.push({ focused, hasFocus })
  if (!hasFocus) console.log('  the main window is not focused (another app is frontmost)')
}

async function settled() {
  await waitUntil(
    `document.querySelector('[data-videorc-stage-phase]')?.dataset.videorcStagePhase === 'idle'`
  )
}
async function phase() {
  return cdp.eval(`document.querySelector('[data-videorc-stage-phase]')?.dataset.videorcStagePhase`)
}
async function box(selector) {
  return cdp.eval(
    `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const rect=element.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()`
  )
}
function mouse(type, point) {
  return cdp.send('Input.dispatchMouseEvent', mouseEvent(type, point))
}
function frames(count) {
  return cdp.eval(
    `new Promise(resolve=>{let n=${count};const tick=()=>--n<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick)})`
  )
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitUntil(expression) {
  await cdp.eval(
    `new Promise((resolve,reject)=>{const end=performance.now()+10000;const tick=()=>{if(${expression})resolve();else if(performance.now()>end)reject(Error('Timed out: '+${JSON.stringify(expression)}));else requestAnimationFrame(tick)};tick()})`
  )
}
