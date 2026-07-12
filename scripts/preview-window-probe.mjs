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

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const expectInProcessNative =
  process.platform === 'darwin' && process.env.VIDEORC_NATIVE_PREVIEW_HELPER_FALLBACK !== '1'
const outputDirectory = join(tmpdir(), `videorc-preview-window-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
let smoke
const failures = []
let lastWindowDump = []
// PT4 (preview res/tearing plan): the transitional helper logs every surface
// sizing change. The production in-process host reports the same real drawable
// metrics through native status, so both paths remain regression-covered.
const surfaceSizingLines = []
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
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    onLine: (line) => {
      console.log(line)
      recordSurfaceSizing(line)
    }
  })
  smoke = launched.connections['preview-motion-ready']

  // Give the production CAMetalLayer a deterministic compositor target. The
  // older helper-only probe could validate window geometry before any pixels
  // existed; the in-process drawable contract must exercise an actual present.
  await smokeCommand('enable-synthetic-source', { settleMs: 250 })
  await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-card]' })

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
      'PASS — open, move, resize, toggle-close, toggle-reopen, dock-follow, dock-occlusion, and undock keep the surface aligned.'
    )
    return 0
  }
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  return 1
}

/** The Studio slot's live rect (window-relative CSS px) straight from the DOM. */
async function dockSlotRect() {
  const response = await smokeCommand('eval-js', {
    code: `
      const element = document.querySelector('[data-videorc-dock-slot]')
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
async function waitForDockedSurfaceAtSlot(label, tolerance = 6, timeoutMsLocal = 15000) {
  await smokeCommand('main-window-focus')
  const deadline = Date.now() + timeoutMsLocal
  let state = null
  let expected = null
  do {
    const slot = await dockSlotRect()
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
