#!/usr/bin/env node
// Preview window probe — headless verification of the detached preview window
// This is the only production preview UI path.
//
// Verifies on the real pipeline:
//   1. Opening the preview window creates the surface session and the surface
//      covers the window's content rect.
//   2. Moving and resizing the window keep the surface aligned to the content rect.
//   3. Closing the window takes the surface off the screen.
//   4. Reopening brings the surface back.
//   5. Docked mode glues the surface to the Studio slot AND to the Scene canvas
//      (plan 058): each tab re-docks into its own slot, main-window moves are
//      followed from main-process state, overlays hide with a stated reason.
//   6. Pass-through: with the surface docked over the Scene canvas, a click on
//      a stage source reaches the SVG hit layer under the surface and never
//      focuses the preview window — at the DOM level (CDP) and, when the host
//      lets this process post HID events, at the OS level (CGEvent).
//
// Placement oracles: the `preview-window-state` smoke command (preview window +
// Electron proof surface geometry) and CGWindowList floating-level geometry for
// the native CAMetalLayer helper window. Both work without Screen Recording
// permission.
//
//   node scripts/preview-window-probe.mjs
//
// Exits 0 when all assertions pass, 1 otherwise.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import {
  windowsPreviewLifecycleDiagnosticFailures,
  windowsPreviewLifecycleOpenFailures,
  windowsPreviewPresenterFailures
} from './lib/windows-preview-lifecycle-gates.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const expectWindowsD3d11 = process.env.VIDEORC_EXPECT_WINDOWS_D3D11 === '1'
if (expectWindowsD3d11 && process.platform !== 'win32') {
  throw new Error('VIDEORC_EXPECT_WINDOWS_D3D11=1 requires a physical Windows host.')
}
const expectInProcessNative =
  process.platform === 'darwin' && process.env.VIDEORC_NATIVE_PREVIEW_HELPER_FALLBACK !== '1'
const outputDirectory = join(tmpdir(), `videorc-preview-window-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
let smoke
let devtoolsUrl
let cdp
const failures = []
let lastWindowDump = []
// PT4 (preview res/tearing plan): the transitional helper logs every surface
// sizing change. The production in-process host reports the same real drawable
// metrics through native status, so both paths remain regression-covered.
const surfaceSizingLines = []
// Dock-slot selectors (declared with the other module state: the scenario
// runner below is top-level code, so these must not sit lower in the file).
const STUDIO_SLOT = '[data-videorc-dock-slot="studio"]'
const SCENE_SLOT = '[data-videorc-dock-slot="scene"]'
// CDP client for the pass-through scenario; hoisted for the same TDZ reason.
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
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.socket.close()
  }
}
function recordSurfaceSizing(line) {
  const match = line.match(
    /\[videorc-native-preview-sizing\] \w+ bounds_pts=(\d+)x(\d+) scale=([\d.]+)(?: contentsScale=[\d.]+)? drawable_px=(\d+)x(\d+)/
  )
  if (match) {
    surfaceSizingLines.push({
      boundsWidth: Number(match[1]),
      boundsHeight: Number(match[2]),
      scale: Number(match[3]),
      drawableWidth: Number(match[4]),
      drawableHeight: Number(match[5])
    })
  }
}
let exitCode = 0
try {
  exitCode = await main()
} catch (error) {
  console.error(`preview window probe failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  cdp?.close()
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for preview window probe…')
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      // The pass-through scenario drives trusted Chromium input over CDP.
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      ...(expectWindowsD3d11
        ? {
            VIDEORC_WINDOWS_D3D11_MEDIA: '1',
            VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1',
            VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts'
          }
        : {})
    },
    onLine: (line) => {
      console.log(line)
      recordSurfaceSizing(line)
      const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (endpoint) devtoolsUrl = endpoint[1]
    }
  })
  smoke = launched.connections['preview-motion-ready']

  // Give the production CAMetalLayer a deterministic compositor target. The
  // older helper-only probe could validate window geometry before any pixels
  // existed; the in-process drawable contract must exercise an actual present.
  await smokeCommand('enable-synthetic-source', { settleMs: 250 })
  await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-card]' })
  if (expectWindowsD3d11) {
    return runWindowsD3d11WindowProbe()
  }

  // --- Open: surface session created at the window's content rect ---------------
  const opened = await smokeCommand('preview-window-open')
  assertProbe(opened.open === true, 'open: preview window reports open', JSON.stringify(opened))
  // Deterministic starting frame: persisted/relative frames drifted off-screen
  // across runs and macOS clamping broke the geometry asserts.
  await smokeCommand('preview-window-set-bounds', { x: 240, y: 160, width: 960, height: 568 })
  let state = await waitForSurfaceAtContentRect(
    'open: surface covers the preview window content rect'
  )

  // --- Move: surface follows -----------------------------------------------------
  await smokeCommand('preview-window-set-bounds', { x: 364, y: 246 })
  state = await waitForSurfaceAtContentRect('move: surface follows the preview window')

  // --- Resize: surface follows ----------------------------------------------------
  await smokeCommand('preview-window-set-bounds', { width: 720, height: 460 })
  state = await waitForSurfaceAtContentRect('resize: surface matches the resized content rect')
  assertProbe(
    Math.abs(state.contentBounds.width - 720) <= 4,
    'resize: content width tracks the requested window width',
    JSON.stringify(state.contentBounds)
  )

  // --- Close: surface leaves the screen AND the session tears down (U2) -----------
  const sizeHint = { width: state.contentBounds.width, height: state.contentBounds.height }
  const toggledClosed = await smokeCommand('preview-window-toggle')
  assertProbe(
    toggledClosed.open === false,
    'toggle close: preview window reports closed',
    JSON.stringify(toggledClosed)
  )
  await assertSurfaceHidden('close: surface leaves the screen with the window', sizeHint)
  const closedState = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.open === false && s.surface.exists === false && s.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(
    closedState.ok,
    'close: surface session destroyed and frame polling suppressed',
    JSON.stringify(closedState.last)
  )
  const decayed = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.nativeOwnsPlacement === false,
    4000
  )
  assertProbe(
    decayed.ok,
    'close: native presents stop (placement authority decays)',
    JSON.stringify(decayed.last)
  )

  // --- Reopen: surface returns and polling resumes ---------------------------------
  const toggledOpen = await smokeCommand('preview-window-toggle')
  assertProbe(
    toggledOpen.open === true,
    'toggle reopen: preview window reports open',
    JSON.stringify(toggledOpen)
  )
  await waitForSurfaceAtContentRect('reopen: surface returns at the window content rect')
  const reopened = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.framePollingSuppressedFlag === false,
    5000
  )
  assertProbe(reopened.ok, 'reopen: frame polling resumes', JSON.stringify(reopened.last))

  // --- Docked ("stick") mode -------------------------------------------------------
  // The REAL renderer reporter runs in this app, so the probe cooperates with
  // it: the Studio tab's actual slot rect is the expectation, and main-window
  // moves must keep the surface glued to it with no new slot report — the core
  // anti-drift contract (the renderer is never in the movement path).
  await smokeCommand('main-window-set-bounds', { x: 120, y: 120, width: 1180, height: 780 })
  await smokeCommand('main-window-focus')
  await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-card]' })
  // First-launch dialogs (What's New) legitimately occlude the docked slot;
  // dismiss them so the baseline asserts a VISIBLE docked surface.
  const dismissed = await smokeCommand('eval-js', {
    code: `
      for (let i = 0; i < 25; i++) {
        const scrim = document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')
        if (!scrim) return { dismissed: true }
        document.querySelectorAll('[data-slot="dialog-close"]').forEach((button) => button.click())
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(200)
      }
      return { dismissed: false }
    `
  })
  assertProbe(
    dismissed.result?.dismissed === true,
    'dock-setup: launch dialogs dismissed',
    JSON.stringify(dismissed)
  )

  let docked = await smokeCommand('preview-window-set-mode', { mode: 'docked' })
  assertProbe(
    docked.mode === 'docked',
    'dock: preview window reports docked mode',
    JSON.stringify(docked)
  )
  await waitForDockedSurfaceAtSlot('dock: surface covers the Studio slot rect')

  // Drawable-resolution regression gate: the surface's Metal drawable must be
  // the slot rect in PHYSICAL pixels (points × the display's scale factor) —
  // a lost scale factor halves the effective preview resolution on Retina.
  {
    const nativeSizingState = await waitFor(
      async () => smokeCommand('preview-window-state'),
      (candidate) =>
        candidate.surfaceStatus.nativePreviewHostKind === 'helper-process' ||
        inProcessDrawableMatchesContentBounds(candidate),
      8000
    )
    const state = nativeSizingState.last
    if (state.surfaceStatus.nativePreviewHostKind === 'in-process') {
      const sizing = {
        boundsWidth: state.contentBounds?.width,
        boundsHeight: state.contentBounds?.height,
        scale: state.surfaceStatus.nativePreviewContentsScale,
        drawableWidth: state.surfaceStatus.nativePreviewDrawableWidth,
        drawableHeight: state.surfaceStatus.nativePreviewDrawableHeight
      }
      const complete = Object.values(sizing).every(
        (value) => typeof value === 'number' && Number.isFinite(value)
      )
      assertProbe(
        complete,
        'dock-drawable: in-process host reported native sizing',
        JSON.stringify(sizing)
      )
      const widthMatches =
        complete && Math.abs(sizing.drawableWidth - sizing.boundsWidth * sizing.scale) <= 1
      const heightMatches =
        complete && Math.abs(sizing.drawableHeight - sizing.boundsHeight * sizing.scale) <= 1
      assertProbe(
        widthMatches && heightMatches,
        'dock-drawable: drawable equals slot points × scale',
        JSON.stringify(sizing)
      )
      assertProbe(
        typeof state.scaleFactor !== 'number' || Math.abs(sizing.scale - state.scaleFactor) < 0.01,
        'dock-drawable: native contents scale matches the display scale factor',
        `native=${sizing.scale} display=${state.scaleFactor}`
      )
    } else {
      const sizing = surfaceSizingLines[surfaceSizingLines.length - 1]
      assertProbe(
        Boolean(sizing),
        'dock-drawable: helper reported a surface sizing line',
        `captured=${surfaceSizingLines.length}`
      )
      if (sizing) {
        const widthMatches = Math.abs(sizing.drawableWidth - sizing.boundsWidth * sizing.scale) <= 1
        const heightMatches =
          Math.abs(sizing.drawableHeight - sizing.boundsHeight * sizing.scale) <= 1
        assertProbe(
          widthMatches && heightMatches,
          'dock-drawable: drawable equals slot points × scale',
          JSON.stringify(sizing)
        )
        assertProbe(
          typeof state.scaleFactor !== 'number' ||
            Math.abs(sizing.scale - state.scaleFactor) < 0.01,
          'dock-drawable: helper scale matches the display scale factor',
          `helper=${sizing.scale} display=${state.scaleFactor}`
        )
      }
    }
  }

  // Stale-epoch reports must be dropped, not applied.
  await smokeCommand('preview-window-report-dock-slot', {
    epoch: docked.dockEpoch - 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visibleFraction: 1,
    mounted: true
  })
  await waitForDockedSurfaceAtSlot('dock-stale-report: placement unchanged by a stale epoch')

  // Move the MAIN window: the docked surface follows from main-process state only.
  await smokeCommand('main-window-set-bounds', { x: 244, y: 208 })
  await waitForDockedSurfaceAtSlot('dock-move: surface follows the main window')

  // Storm tolerance: several immediate main-window mutations settle correctly.
  await smokeCommand('main-window-set-bounds', { x: 180, y: 160 })
  await smokeCommand('main-window-set-bounds', { x: 200, y: 180 })
  await waitForDockedSurfaceAtSlot('dock-storm: surface settles after rapid main-window changes')

  // Overlay occlusion: the docked surface yields while an in-app overlay is up.
  // (Injected via the same IPC path the renderer's overlay watcher uses; the
  // watcher only re-sends on change, so the injection is not raced.)
  await smokeCommand('preview-window-set-dock-overlay', { open: true })
  const overlayHidden = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.visible === false && s.dockHiddenReason === 'overlay-open',
    8000
  )
  assertProbe(
    overlayHidden.ok,
    'dock-overlay: surface hides behind an open overlay with a stated reason',
    JSON.stringify(overlayHidden.last)
  )
  await smokeCommand('preview-window-set-dock-overlay', { open: false })
  await waitForDockedSurfaceAtSlot('dock-overlay-close: surface returns when the overlay closes')

  // Scrolled-away slots hide with a stated reason instead of clipping. Drive
  // the REAL reporter — actually scroll the slot's container out of view —
  // rather than injecting a fraction, which the live reporter would overwrite
  // with the true (fully visible) value within a frame.
  const scrolled = await smokeCommand('eval-js', {
    code: `
      const slot = document.querySelector('[data-videorc-dock-slot]')
      if (!slot) return { scrolled: false }
      let node = slot.parentElement
      while (node) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break
        node = node.parentElement
      }
      const scroller = node ?? document.scrollingElement ?? document.documentElement
      scroller.scrollTop = scroller.scrollHeight
      await sleep(120)
      return { scrolled: true, top: scroller.scrollTop }
    `
  })
  if (scrolled.result?.scrolled && scrolled.result.top > 0) {
    const scrolledHidden = await waitFor(
      async () => smokeCommand('preview-window-state'),
      (s) => s.visible === false && s.dockHiddenReason === 'scrolled-away',
      8000
    )
    assertProbe(
      scrolledHidden.ok,
      'dock-scroll: surface hides when the slot scrolls mostly away',
      JSON.stringify(scrolledHidden.last)
    )
    await smokeCommand('eval-js', {
      code: `
        const slot = document.querySelector('[data-videorc-dock-slot]')
        let node = slot?.parentElement ?? null
        while (node) {
          const style = getComputedStyle(node)
          if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break
          node = node.parentElement
        }
        ;(node ?? document.scrollingElement ?? document.documentElement).scrollTop = 0
        await sleep(120)
        return { restored: true }
      `
    })
    await waitForDockedSurfaceAtSlot(
      'dock-scroll-back: surface returns when the slot is visible again'
    )
  } else {
    // The Studio page fit without scrolling on this run (short content / tall
    // window) — the scrolled-away decision is covered by dock-slot unit tests.
    assertProbe(true, 'dock-scroll: skipped — Studio page did not overflow', '')
  }

  // Tab switch: the docked preview must FULLY leave the screen — including
  // the native helper NSWindow, which is a separate window from the Electron
  // frame. Asserting only state flags missed the 0.9.4 leak where the helper
  // surface stayed painted over the next tab; CGWindowList is the oracle
  // that sees that layer.
  const dockedSlotBeforeSwitch = await dockSlotRect()
  await smokeCommand('open-tab', { tab: 'sources' })
  const tabHidden = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.visible === false && s.dockHiddenReason === 'slot-unmounted',
    8000
  )
  assertProbe(
    tabHidden.ok,
    'dock-tab-switch: state hides with slot-unmounted when leaving Studio',
    JSON.stringify(tabHidden.last)
  )
  const helperGone = await waitFor(
    async () => ({
      helpers: windowList().filter(
        (w) =>
          w.owner === 'native_preview_host_helper' &&
          Math.abs(w.width - dockedSlotBeforeSwitch.width) <= 12 &&
          Math.abs(w.height - dockedSlotBeforeSwitch.height) <= 12
      )
    }),
    (s) => s.helpers.length === 0,
    8000
  )
  assertProbe(
    helperGone.ok,
    'dock-tab-switch: the NATIVE helper window leaves the screen too',
    JSON.stringify(helperGone.last)
  )
  await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-dock-slot]' })
  await waitForDockedSurfaceAtSlot('dock-tab-return: surface returns when Studio remounts')

  await runSceneSlotScenarios()

  // Undock: floating chrome and the remembered floating frame come back.
  const floated = await smokeCommand('preview-window-set-mode', { mode: 'floating' })
  assertProbe(
    floated.mode === 'floating',
    'undock: preview window reports floating mode',
    JSON.stringify(floated)
  )
  await waitForSurfaceAtContentRect('undock: surface returns to the floating window rect')

  console.log('\n=== Preview window probe summary ===')
  if (failures.length === 0) {
    console.log(
      'PASS — open, move, resize, toggle-close, toggle-reopen, dock-follow, dock-occlusion, scene-slot dock, pass-through, and undock keep the surface aligned.'
    )
    return 0
  }
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  return 1
}

/**
 * Plan 058: the Scene tab's canvas is a second dock slot. Runs while the
 * preview is already docked (the Studio scenarios above) and leaves it docked
 * in the Studio slot again.
 */
async function runSceneSlotScenarios() {
  // --- Scene slot: the surface re-docks into the canvas rect --------------------
  await smokeCommand('open-tab', { tab: 'layout', waitFor: SCENE_SLOT })
  const sceneDocked = await waitForDockedSurfaceAtSlot(
    'scene-dock: surface covers the Scene canvas rect',
    { selector: SCENE_SLOT }
  )
  assertProbe(
    sceneDocked?.dockSlot === 'scene',
    'scene-dock: state names the scene slot as the owner',
    JSON.stringify({ dockSlot: sceneDocked?.dockSlot, hidden: sceneDocked?.dockHiddenReason })
  )
  assertProbe(
    sceneDocked?.dockHiddenReason === null,
    'scene-dock: docked surface is showing (no hidden reason)',
    JSON.stringify({ hidden: sceneDocked?.dockHiddenReason })
  )
  // Drawable-resolution gate at the canvas size too: the canvas slot is a
  // different size from the Studio slot, so a lost scale factor would show here.
  {
    const sized = await waitFor(
      async () => smokeCommand('preview-window-state'),
      (candidate) =>
        candidate.surfaceStatus.nativePreviewHostKind !== 'in-process' ||
        inProcessDrawableMatchesContentBounds(candidate),
      8000
    )
    assertProbe(
      sized.ok,
      'scene-drawable: drawable equals canvas points × scale',
      JSON.stringify(sized.last?.surfaceStatus)
    )
  }
  // The renderer must report the SVG canvas rect, never the 28px handle gutter.
  const gutterCheck = await smokeCommand('eval-js', {
    code: `
      const slot = document.querySelector('[data-videorc-dock-slot="scene"]')
      const svg = slot?.querySelector('svg')
      const canvas = document.querySelector('[data-videorc-stage-canvas]')
      if (!slot || !svg || !canvas) return null
      const s = slot.getBoundingClientRect(), v = svg.getBoundingClientRect(), c = canvas.getBoundingClientRect()
      return { slot: [s.x, s.y, s.width, s.height], svg: [v.x, v.y, v.width, v.height], canvas: [c.x, c.y, c.width, c.height] }
    `
  })
  const gutter = gutterCheck.result
  const rectsClose = (a, b) =>
    a && b && a.every((value, index) => Math.abs(value - b[index]) <= 1.5)
  assertProbe(
    Boolean(gutter) &&
      rectsClose(gutter.slot, gutter.svg) &&
      rectsClose(gutter.slot, gutter.canvas),
    'scene-dock: the slot is the canvas rect, not the handle gutter',
    JSON.stringify(gutter)
  )
  // Hit-only mode: the schematic paint is hidden under the live picture while
  // every pointer target stays reachable.
  const hitOnly = await smokeCommand('eval-js', {
    code: `
      const svg = document.querySelector('[data-videorc-stage-live="true"]')
      if (!svg) return { live: false }
      const hidden = (selector) => [...svg.querySelectorAll(selector)].map((el) => getComputedStyle(el).visibility)
      const bounds = [...svg.querySelectorAll('[data-videorc-stage-bounds]')]
      const reachable = bounds.map((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return hit === el || el.contains(hit) || (hit && hit.closest('[data-videorc-stage-source]') === el.closest('[data-videorc-stage-source]'))
      })
      return {
        live: true,
        painted: hidden('[data-videorc-stage-painted-shape]'),
        canvas: hidden('[data-videorc-stage-canvas]'),
        boundsVisibility: hidden('[data-videorc-stage-bounds]'),
        reachable
      }
    `
  })
  const hit = hitOnly.result
  assertProbe(
    hit?.live === true &&
      hit.painted.length > 0 &&
      hit.painted.every((value) => value === 'hidden') &&
      hit.canvas.every((value) => value === 'hidden') &&
      hit.boundsVisibility.every((value) => value === 'visible') &&
      hit.reachable.every(Boolean),
    'scene-hit-only: schematic paint hidden, pointer targets visible and reachable',
    JSON.stringify(hit)
  )
  // The footer offers Pop out while the surface lives in the canvas.
  const footer = await smokeCommand('eval-js', {
    code: `return {
      popOut: Boolean(document.querySelector('[data-videorc-stage-pop-out]')),
      showLive: Boolean(document.querySelector('[data-videorc-stage-show-live]'))
    }`
  })
  assertProbe(
    footer.result?.popOut === true && footer.result?.showLive === false,
    'scene-dock: footer offers Pop out (not Show live here) while docked here',
    JSON.stringify(footer.result)
  )

  // Move the MAIN window: the canvas-docked surface follows from main-process
  // state only (same anti-drift contract as the Studio slot).
  await smokeCommand('main-window-set-bounds', { x: 232, y: 196 })
  await waitForDockedSurfaceAtSlot('scene-move: surface follows the main window', {
    selector: SCENE_SLOT
  })

  // Overlay occlusion over the canvas (decision 8): the surface yields with a
  // stated reason and the schematic shows through; it returns on close.
  await smokeCommand('preview-window-set-dock-overlay', { open: true })
  const overlayHidden = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (s) => s.visible === false && s.dockHiddenReason === 'overlay-open',
    8000
  )
  assertProbe(
    overlayHidden.ok,
    'scene-overlay: surface hides behind an open overlay with a stated reason',
    JSON.stringify(overlayHidden.last)
  )
  const schematicBack = await waitFor(
    async () =>
      smokeCommand('eval-js', {
        code: `return {
          live: Boolean(document.querySelector('[data-videorc-stage-live="true"]')),
          hint: document.querySelector('[data-videorc-stage-live-hint]')?.textContent ?? null
        }`
      }),
    (s) => s.result?.live === false && typeof s.result?.hint === 'string',
    8000
  )
  assertProbe(
    schematicBack.ok,
    'scene-overlay: schematic returns with a tertiary hint while hidden',
    JSON.stringify(schematicBack.last)
  )
  await smokeCommand('preview-window-set-dock-overlay', { open: false })
  await waitForDockedSurfaceAtSlot('scene-overlay-close: surface returns when the overlay closes', {
    selector: SCENE_SLOT
  })

  await runPassThroughScenario()

  // --- Tab switch: Scene → Studio re-docks in the Studio slot and back ---------
  await smokeCommand('open-tab', { tab: 'studio', waitFor: STUDIO_SLOT })
  const studioAgain = await waitForDockedSurfaceAtSlot(
    'scene-to-studio: surface re-docks into the Studio slot',
    { selector: STUDIO_SLOT }
  )
  assertProbe(
    studioAgain?.dockSlot === 'studio',
    'scene-to-studio: state names the studio slot as the owner',
    JSON.stringify({ dockSlot: studioAgain?.dockSlot })
  )
  await smokeCommand('open-tab', { tab: 'layout', waitFor: SCENE_SLOT })
  const sceneAgain = await waitForDockedSurfaceAtSlot(
    'studio-to-scene: surface re-docks into the Scene canvas',
    { selector: SCENE_SLOT }
  )
  assertProbe(
    sceneAgain?.dockSlot === 'scene',
    'studio-to-scene: state names the scene slot as the owner',
    JSON.stringify({ dockSlot: sceneAgain?.dockSlot })
  )
  // Leave the probe where the Studio scenarios left it.
  await smokeCommand('open-tab', { tab: 'studio', waitFor: STUDIO_SLOT })
  await waitForDockedSurfaceAtSlot('scene-exit: surface back in the Studio slot', {
    selector: STUDIO_SLOT
  })
}

/**
 * Plan 058 S0/S3: the docked preview window ignores mouse events, so pointer
 * input over the canvas lands on the SVG hit layer beneath it and the preview
 * never takes focus. Runs while the surface is docked in the Scene canvas.
 */
async function runPassThroughScenario() {
  const before = await smokeCommand('focused-window')
  assertProbe(
    before.previewIgnoresMouseEvents === true,
    'pass-through: docked preview window ignores mouse events',
    JSON.stringify(before)
  )
  // Instrument the stage: record every pointerdown that reaches a stage source
  // (capture phase, so no handler can swallow the evidence).
  const target = await smokeCommand('eval-js', {
    code: `
      window.__videorcPassThrough = { downs: [] }
      document.addEventListener('pointerdown', (event) => {
        const source = event.target?.closest?.('[data-videorc-stage-source]')
        window.__videorcPassThrough.downs.push({
          sourceId: source?.getAttribute('data-videorc-stage-source') ?? null,
          onBounds: Boolean(event.target?.hasAttribute?.('data-videorc-stage-bounds')),
          isTrusted: event.isTrusted
        })
      }, { capture: true })
      const sources = [...document.querySelectorAll('[data-videorc-stage-source]')]
      if (!sources.length) return null
      // The toolbar's source toggles render in the same order as the stage
      // sources (both map scene.sources), and Radix marks the pressed item
      // with data-state="on" (aria-checked in a single-select group).
      const toggles = [...document.querySelectorAll('[data-videorc-stage-toolbar] button[aria-label^="Select "]')]
      const isOn = (button) =>
        button?.dataset.state === 'on' ||
        button?.getAttribute('aria-checked') === 'true' ||
        button?.getAttribute('aria-pressed') === 'true'
      const selectedBefore = toggles.findIndex(isOn)
      let index = sources.findIndex((_el, i) => !isOn(toggles[i]))
      if (index < 0) index = 0
      const chosen = sources[index]
      const bounds = chosen.querySelector('[data-videorc-stage-bounds]').getBoundingClientRect()
      return {
        sourceId: chosen.getAttribute('data-videorc-stage-source'),
        index,
        sourceName: toggles[index]?.getAttribute('title') ?? null,
        sourceCount: sources.length,
        center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        selectedBefore
      }
    `
  })
  const pick = target.result
  assertProbe(Boolean(pick), 'pass-through: a stage source exists to click', JSON.stringify(target))
  if (!pick) return
  const stageState = (label) =>
    smokeCommand('eval-js', {
      code: `return {
        downs: window.__videorcPassThrough.downs,
        selectedIndex: [...document.querySelectorAll('[data-videorc-stage-toolbar] button[aria-label^="Select "]')]
          .findIndex((button) =>
            button.dataset.state === 'on' ||
            button.getAttribute('aria-checked') === 'true' ||
            button.getAttribute('aria-pressed') === 'true'),
        inspectorTitle: [...document.querySelectorAll('h3, h2, [data-slot="panel-section-title"]')].map((el) => el.textContent).join(' | '),
        live: Boolean(document.querySelector('[data-videorc-stage-live="true"]')),
        label: ${JSON.stringify(label)}
      }`
    })

  // (a) DOM level: trusted Chromium input over CDP at the source centre.
  if (!devtoolsUrl) {
    assertProbe(false, 'pass-through(cdp): Electron exposed a CDP endpoint', 'no DevTools line')
  } else {
    if (!cdp) {
      const targets = await (await fetch(`http://${new URL(devtoolsUrl).host}/json/list`)).json()
      const page = targets.find(
        (entry) => entry.type === 'page' && /^https?:\/\/localhost/.test(entry.url)
      )
      assertProbe(
        Boolean(page),
        'pass-through(cdp): main renderer target found',
        JSON.stringify(targets)
      )
      if (page) cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    }
    if (cdp) {
      const mouse = (type) =>
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x: pick.center.x,
          y: pick.center.y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: type === 'mouseMoved' ? 0 : 1
        })
      await mouse('mouseMoved')
      await mouse('mousePressed')
      await mouse('mouseReleased')
      const after = await waitFor(
        async () => stageState('cdp'),
        (s) => s.result?.downs?.some((down) => down.sourceId === pick.sourceId && down.onBounds),
        5000
      )
      assertProbe(
        after.ok,
        'pass-through(cdp): pointerdown reached the source hit rect under the live surface',
        JSON.stringify({ pick, state: after.last?.result })
      )
      assertProbe(
        after.last?.result?.selectedIndex === pick.index,
        'pass-through(cdp): the click selected the source',
        JSON.stringify({ pick, state: after.last?.result })
      )
      const focus = await smokeCommand('focused-window')
      assertProbe(
        focus.previewFocused === false && focus.role !== 'preview',
        'pass-through(cdp): preview window not focused after the click',
        JSON.stringify(focus)
      )
      // The surface must still be there: a click must not hide or undock it.
      await waitForDockedSurfaceAtSlot('pass-through(cdp): surface still docked over the canvas', {
        selector: SCENE_SLOT
      })
    }
  }

  // (b) OS level: a real HID click through the docked NSWindow. This is the
  // S0 spike proper — CDP input never crosses window hit-testing. Only counts
  // when the host let this process post events (the cursor visibly moved);
  // otherwise it is recorded as skipped, never as a pass.
  if (process.platform !== 'darwin') {
    assertProbe(true, 'pass-through(os): skipped — macOS only', '')
    return
  }
  const main = await smokeCommand('main-window-state')
  const screenPoint = {
    x: main.contentBounds.x + pick.center.x,
    y: main.contentBounds.y + pick.center.y
  }
  const downsBefore = (await stageState('os-before')).result.downs.length
  const posted = osClick(screenPoint)
  const delivered =
    posted && Math.abs(posted.x - screenPoint.x) <= 2 && Math.abs(posted.y - screenPoint.y) <= 2
  if (!delivered) {
    assertProbe(
      true,
      'pass-through(os): skipped — this process may not post HID events (cursor did not move)',
      JSON.stringify({ posted, screenPoint })
    )
    return
  }
  const osAfter = await waitFor(
    async () => stageState('os'),
    (s) =>
      (s.result?.downs ?? [])
        .slice(downsBefore)
        .some((down) => down.sourceId === pick.sourceId && down.onBounds && down.isTrusted),
    5000
  )
  assertProbe(
    osAfter.ok,
    'pass-through(os): a real HID click fell through the docked surface onto the stage source',
    JSON.stringify({ pick, screenPoint, state: osAfter.last?.result })
  )
  const osFocus = await smokeCommand('focused-window')
  assertProbe(
    osFocus.previewFocused === false && osFocus.role !== 'preview',
    'pass-through(os): preview window not focused after a real click',
    JSON.stringify(osFocus)
  )
  await waitForDockedSurfaceAtSlot('pass-through(os): surface still docked over the canvas', {
    selector: SCENE_SLOT
  })
}

/** Post a real left click at a global display point (Quartz top-left origin,
 * the same space as Electron's screen coordinates). Returns the cursor
 * position read back afterwards, or null when the event could not be posted. */
function osClick(point) {
  const swift = `
import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
let point = CGPoint(x: x, y: y)
let source = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType) {
  if let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) {
    event.post(tap: .cghidEventTap)
  }
  usleep(70_000)
}
post(.mouseMoved)
post(.leftMouseDown)
post(.leftMouseUp)
let location = CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1)
print("\\(location.x)\\t\\(location.y)")
`
  const file = join(outputDirectory, 'os-click.swift')
  writeFileSync(file, swift)
  const result = spawnSync('swift', [file, String(point.x), String(point.y)], {
    encoding: 'utf8',
    timeout: 60000
  })
  if (result.status !== 0) {
    console.log(`os-click: swift failed: ${result.stderr?.slice(0, 300)}`)
    return null
  }
  const [x, y] = result.stdout.trim().split('\t').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

async function runWindowsD3d11WindowProbe() {
  const opened = await smokeCommand('preview-window-open')
  assertProbe(
    opened.open === true,
    'open: Windows preview window reports open',
    JSON.stringify(opened)
  )
  await smokeCommand('preview-window-set-bounds', {
    x: 240,
    y: 160,
    width: 960,
    height: 568
  })
  let state = await waitForWindowsPresenter('open: D3D11 presenter matches the content rect')
  let sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  await smokeCommand('preview-window-set-bounds', { x: 364, y: 246 })
  state = await waitForWindowsPresenter(
    'move: D3D11 presenter follows and keeps presenting',
    sequence
  )
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  await smokeCommand('preview-window-set-bounds', { width: 720, height: 460 })
  state = await waitForWindowsPresenter(
    'resize: D3D11 presenter follows and keeps presenting',
    sequence
  )
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  const inputProbe = await smokeCommand('windows-preview-os-input-probe', {
    action: 'prepare'
  })
  runWindowsOsInputProbe(inputProbe)
  const inputResult = await waitFor(
    async () => smokeCommand('windows-preview-os-input-probe', { action: 'read' }),
    (candidate) =>
      candidate?.state?.clicks > 0 &&
      candidate?.state?.focusEvents > 0 &&
      candidate?.state?.inputEvents > 0 &&
      candidate?.state?.value === 'VIDEORC42' &&
      candidate?.state?.activeElementId === 'videorc-windows-preview-input-target' &&
      movedAtLeast(inputProbe.initialBounds, candidate.bounds, 12),
    8000
  )
  assertProbe(
    inputResult.ok,
    'input: real Win32 click, typing, and drag reached Electron through the presenter',
    JSON.stringify(inputResult.last)
  )
  if (inputResult.last) {
    assertProbe(
      inputResult.last.previewFocused === true &&
        inputResult.last.webContentsFocused === true &&
        inputResult.last.presenter?.windowActive === false &&
        inputResult.last.presenter?.windowFocused === false,
      'input: Electron owns focus and the presenter never activates',
      JSON.stringify(inputResult.last)
    )
  }
  await smokeCommand('windows-preview-os-input-probe', { action: 'cleanup' })
  state = await waitForWindowsPresenter(
    'input: presenter remains live after physical interaction',
    sequence
  )
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  const closed = await smokeCommand('preview-window-toggle')
  assertProbe(
    closed.open === false,
    'close: Windows preview reports closed',
    JSON.stringify(closed)
  )
  const fullyClosed = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (candidate) =>
      candidate.open === false &&
      candidate.surface?.exists === false &&
      candidate.framePollingSuppressedFlag === true &&
      candidate.nativeOwnsPlacement === false,
    8000
  )
  assertProbe(
    fullyClosed.ok,
    'close: presenter/proof surface leave the screen and polling stays suppressed',
    JSON.stringify(fullyClosed.last)
  )

  const reopened = await smokeCommand('preview-window-toggle')
  assertProbe(
    reopened.open === true,
    'reopen: Windows preview reports open',
    JSON.stringify(reopened)
  )
  state = await waitForWindowsPresenter('reopen: canonical presenter reattaches')
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  await smokeCommand('main-window-set-bounds', { x: 120, y: 120, width: 1180, height: 780 })
  await smokeCommand('main-window-focus')
  await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-dock-slot]' })
  const docked = await smokeCommand('preview-window-set-mode', { mode: 'docked' })
  assertProbe(
    docked.mode === 'docked',
    'dock: Windows preview reports docked mode',
    JSON.stringify(docked)
  )
  state = await waitForWindowsPresenter('dock: presenter matches the live Studio slot', sequence)
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  await smokeCommand('main-window-set-bounds', { x: 244, y: 208 })
  state = await waitForWindowsPresenter(
    'dock-move: presenter follows the main window without renderer placement authority',
    sequence
  )
  sequence = state.surfaceStatus.windowsD3d11Presenter.lastPresentedSequence

  const floating = await smokeCommand('preview-window-set-mode', { mode: 'floating' })
  assertProbe(
    floating.mode === 'floating',
    'undock: Windows preview reports floating mode',
    JSON.stringify(floating)
  )
  await waitForWindowsPresenter('undock: presenter returns to the floating content rect', sequence)

  const diagnostics = await smokeCommand('backend-debug-rpc', {
    method: 'diagnostics.stats',
    params: {},
    timeoutMs
  })
  const diagnosticsFailures = windowsPreviewLifecycleDiagnosticFailures(
    diagnostics,
    'windows-d3d11'
  )
  assertProbe(
    diagnosticsFailures.length === 0,
    'diagnostics: D3D11 presents advanced with zero BMP work or fallback',
    JSON.stringify({
      failures: diagnosticsFailures,
      media: diagnostics?.windowsD3d11Media
    })
  )

  console.log('\n=== Windows D3D11 preview window probe summary ===')
  if (failures.length === 0) {
    console.log(
      'PASS — open/move/resize/close/reopen/dock/undock and real OS click/type/drag preserved the canonical D3D11 presenter with zero proof polling.'
    )
    return 0
  }
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  return 1
}

async function waitForWindowsPresenter(label, previousPresentedSequence) {
  const result = await waitFor(
    async () => smokeCommand('preview-window-state'),
    (candidate) =>
      windowsPreviewLifecycleOpenFailures(candidate, 'windows-d3d11').length === 0 &&
      windowsPreviewPresenterFailures(candidate, { previousPresentedSequence }).length === 0,
    15000
  )
  const openFailures = windowsPreviewLifecycleOpenFailures(result.last, 'windows-d3d11')
  const presenterFailures = windowsPreviewPresenterFailures(result.last, {
    previousPresentedSequence
  })
  assertProbe(
    result.ok,
    label,
    JSON.stringify({ openFailures, presenterFailures, state: result.last })
  )
  return result.last
}

function runWindowsOsInputProbe(probe) {
  for (const name of ['inputPoint', 'dragPoint']) {
    if (!probe?.[name] || !Number.isInteger(probe[name].x) || !Number.isInteger(probe[name].y)) {
      throw new Error(`Windows OS-input probe did not return a valid ${name}.`)
    }
  }
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VideorcPreviewInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
Add-Type -AssemblyName System.Windows.Forms
function Click-Point([int]$x, [int]$y) {
  [VideorcPreviewInput]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 100
  [VideorcPreviewInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [VideorcPreviewInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
Click-Point ([int]$env:VIDEORC_INPUT_X) ([int]$env:VIDEORC_INPUT_Y)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('VIDEORC42')
Start-Sleep -Milliseconds 150
$startX = [int]$env:VIDEORC_DRAG_X
$startY = [int]$env:VIDEORC_DRAG_Y
[VideorcPreviewInput]::SetCursorPos($startX, $startY) | Out-Null
[VideorcPreviewInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
foreach ($step in 1..6) {
  [VideorcPreviewInput]::SetCursorPos($startX + (8 * $step), $startY + (6 * $step)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[VideorcPreviewInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        VIDEORC_INPUT_X: String(probe.inputPoint.x),
        VIDEORC_INPUT_Y: String(probe.inputPoint.y),
        VIDEORC_DRAG_X: String(probe.dragPoint.x),
        VIDEORC_DRAG_Y: String(probe.dragPoint.y)
      }
    }
  )
  if (result.error || result.status !== 0) {
    throw new Error(
      `Windows OS-input probe failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
    )
  }
}

function movedAtLeast(before, after, minimum) {
  return (
    before &&
    after &&
    (Math.abs(after.x - before.x) >= minimum || Math.abs(after.y - before.y) >= minimum)
  )
}

/** A dock slot's live rect (window-relative CSS px) straight from the DOM. */
async function dockSlotRect(selector = '[data-videorc-dock-slot]') {
  const response = await smokeCommand('eval-js', {
    code: `
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    `
  })
  if (!response.result) {
    throw new Error('Docked slot element is not mounted.')
  }
  return response.result
}

function inProcessDrawableMatchesContentBounds(state) {
  const status = state?.surfaceStatus
  const bounds = state?.contentBounds
  if (status?.nativePreviewHostKind !== 'in-process' || !bounds) {
    return false
  }
  const drawableWidth = status.nativePreviewDrawableWidth
  const drawableHeight = status.nativePreviewDrawableHeight
  const scale = status.nativePreviewContentsScale
  if (![drawableWidth, drawableHeight, scale].every(Number.isFinite)) {
    return false
  }
  return (
    Math.abs(drawableWidth - bounds.width * scale) <= 1 &&
    Math.abs(drawableHeight - bounds.height * scale) <= 1 &&
    (typeof state.scaleFactor !== 'number' || Math.abs(scale - state.scaleFactor) < 0.01)
  )
}

/**
 * Poll until the surface sits at (main window content origin + the LIVE Studio
 * slot rect). Both are re-fetched each poll, so main-window moves change the
 * expectation without any new slot report — exactly the docked-mode contract.
 */
async function waitForDockedSurfaceAtSlot(label, options = {}) {
  const {
    selector = '[data-videorc-dock-slot]',
    tolerance = 6,
    timeoutMs: timeoutMsLocal = 15000
  } = options
  await smokeCommand('main-window-focus')
  const deadline = Date.now() + timeoutMsLocal
  let state = null
  let expected = null
  do {
    const slot = await dockSlotRect(selector)
    const main = await smokeCommand('main-window-state')
    state = await smokeCommand('preview-window-state')
    if (main.open && main.contentBounds) {
      expected = {
        x: main.contentBounds.x + slot.x,
        y: main.contentBounds.y + slot.y,
        width: slot.width,
        height: slot.height
      }
      const match = (bounds) =>
        bounds &&
        Math.abs(bounds.x - expected.x) <= tolerance &&
        Math.abs(bounds.y - expected.y) <= tolerance &&
        Math.abs(bounds.width - expected.width) <= tolerance &&
        Math.abs(bounds.height - expected.height) <= tolerance
      const windowAtSlot = state.open && state.visible && match(state.contentBounds)
      if (
        !expectInProcessNative &&
        windowAtSlot &&
        state.surface.visible &&
        match(state.surface.bounds)
      ) {
        assertProbe(true, `${label} [proof-window]`, '')
        return state
      }
      if (windowAtSlot && state.nativeOwnsPlacement) {
        if (
          state.surfaceStatus.nativePreviewHostKind === 'in-process' &&
          state.surfaceStatus.transport === 'native-surface'
        ) {
          assertProbe(true, `${label} [in-process layer]`, '')
          return state
        }
        const native = windowList().find(
          (w) => w.owner === 'native_preview_host_helper' && match(w)
        )
        if (native) {
          assertProbe(
            native.layer === 0,
            `${label} [native-window at normal level]`,
            `helper window layer ${native.layer} — docked surfaces must never float over other apps`
          )
          return state
        }
      }
    }
    await sleep(250)
  } while (Date.now() < deadline)
  assertProbe(
    false,
    label,
    `expected: ${JSON.stringify(expected)}, state: ${JSON.stringify(state)}`
  )
  return state
}

/**
 * Poll preview-window-state until the surface (proof window, or native helper
 * window when it owns placement) sits on the preview window's content rect.
 */
async function waitForSurfaceAtContentRect(label, tolerance = 6, timeoutMsLocal = 15000) {
  // The surface hides while the app is unfocused (by design); anything stealing
  // focus from the headless app mid-probe (terminals, overlays) must not read as
  // a placement failure. preview-window-open is idempotent and re-focuses.
  await smokeCommand('preview-window-open')
  const deadline = Date.now() + timeoutMsLocal
  let state = null
  do {
    state = await smokeCommand('preview-window-state')
    const expected = state.contentBounds
    if (state.open && expected) {
      const match = (bounds) =>
        bounds &&
        Math.abs(bounds.x - expected.x) <= tolerance &&
        Math.abs(bounds.y - expected.y) <= tolerance &&
        Math.abs(bounds.width - expected.width) <= tolerance &&
        Math.abs(bounds.height - expected.height) <= tolerance
      if (!expectInProcessNative && state.surface.visible && match(state.surface.bounds)) {
        assertProbe(true, `${label} [proof-window]`, '')
        return state
      }
      if (state.nativeOwnsPlacement) {
        if (
          state.surfaceStatus.nativePreviewHostKind === 'in-process' &&
          state.surfaceStatus.transport === 'native-surface'
        ) {
          assertProbe(true, `${label} [in-process layer]`, '')
          return state
        }
        // Detached mode runs the helper window at NORMAL level (it stacks with
        // the preview window as one app), so match by owner, not layer.
        const native = windowList().find(
          (w) => w.owner === 'native_preview_host_helper' && match(w)
        )
        if (native) {
          assertProbe(
            native.layer === 0,
            `${label} [native-window at normal level]`,
            `helper window layer ${native.layer} — floating level means it covers every app`
          )
          return state
        }
      }
    }
    await sleep(250)
  } while (Date.now() < deadline)
  assertProbe(
    false,
    label,
    `state: ${JSON.stringify(state)}, floating: ${JSON.stringify(lastWindowDump.filter((w) => w.layer >= 3))}`
  )
  return state
}

async function assertSurfaceHidden(label, sizeHint, timeoutMsLocal = 8000) {
  const deadline = Date.now() + timeoutMsLocal
  let state = null
  let floating = []
  do {
    state = await smokeCommand('preview-window-state')
    floating = windowList().filter(
      (w) =>
        w.owner === 'native_preview_host_helper' &&
        Math.abs(w.width - sizeHint.width) <= 8 &&
        Math.abs(w.height - sizeHint.height) <= 8
    )
    if (state.surface.visible === false && floating.length === 0) {
      assertProbe(true, label, '')
      return
    }
    await sleep(250)
  } while (Date.now() < deadline)
  assertProbe(
    false,
    label,
    `state: ${JSON.stringify(state)}, floating: ${JSON.stringify(floating)}`
  )
}

async function waitFor(fetchState, predicate, timeoutMsLocal) {
  const deadline = Date.now() + timeoutMsLocal
  let last = null
  do {
    last = await fetchState()
    if (predicate(last)) {
      return { ok: true, last }
    }
    await sleep(250)
  } while (Date.now() < deadline)
  return { ok: false, last }
}

async function smokeCommand(command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${smoke.capability}`
    },
    body: JSON.stringify({ command, params })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}

function windowList() {
  const swift = `
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  print("\\(pid)\\t\\(owner)\\t\\(layer)\\t\\(b["X"] ?? -1)\\t\\(b["Y"] ?? -1)\\t\\(b["Width"] ?? -1)\\t\\(b["Height"] ?? -1)")
}
`
  const file = join(outputDirectory, 'windows.swift')
  writeFileSync(file, swift)
  const result = spawnSync('swift', [file], { encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) {
    throw new Error(`window list probe failed: ${result.stderr?.slice(0, 400)}`)
  }
  lastWindowDump = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, owner, layer, x, y, width, height] = line.split('\t')
      return {
        pid: Number(pid),
        owner,
        layer: Number(layer),
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height)
      }
    })
  return lastWindowDump
}

function assertProbe(condition, label, detail) {
  if (condition) {
    console.log(`OK   ${label}`)
  } else {
    console.log(`FAIL ${label} — ${detail}`)
    failures.push(`${label} — ${detail}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
