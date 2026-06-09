#!/usr/bin/env node
// Preview glue probe — headless placement verification for the B1/B2 contract.
//
// Launches the dev app exactly like the user does (VIDEORC_NATIVE_PREVIEW_SURFACE=1)
// with the smoke command server and verifies, on the real pipeline:
//
//   Phase 1 (command-driven): the surface covers the CLIP rect when clipped, hides
//   entirely on visible:false, and recovers.
//   Phase 2 (renderer-driven): with the real renderer reporting the actual studio
//   slot — scroll glue, tab-switch hide/restore, and window-move tracking.
//
// Placement oracles: the `proof-window-state` smoke command (Electron proof window),
// and CGWindowList floating-level geometry for the native CAMetalLayer helper window
// (which owns the slot whenever presents are confirmed; the proof window then yields
// per the single-placement-authority rule). Both oracles work without Screen
// Recording permission.
//
//   node scripts/preview-glue-probe.mjs
//
// Exits 0 when all assertions pass, 1 otherwise.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const outputDirectory = join(tmpdir(), `videorc-preview-glue-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

// Distinctive geometry so the probe windows are unambiguous.
const SLOT = { screenX: 211, screenY: 173, width: 642, height: 414 }
const COMMON = { scaleFactor: 2, screenHeight: 982 }

let launched
let smoke
const failures = []
let lastWindowDump = []
let exitCode = 0
try {
  exitCode = await main()
} catch (error) {
  console.error(`preview glue probe failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for preview glue probe…')
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: '1'
    },
    onLine: (line) => console.log(line)
  })
  const ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  smoke = launched.connections['preview-motion-ready']

  try {
    // --- Phase 1: command-driven placement contract --------------------------------
    const fullBounds = {
      ...SLOT,
      ...COMMON,
      clipX: SLOT.screenX,
      clipY: SLOT.screenY,
      clipWidth: SLOT.width,
      clipHeight: SLOT.height,
      visible: true
    }
    await request(ws, timeoutMs, 'preview.surface.create', {
      bounds: fullBounds,
      targetFps: 60,
      source: 'synthetic'
    })
    await applyHostCommands(ws)
    await assertSurfaceAt(
      { x: 211, y: 173, width: 642, height: 414 },
      'full-visible: surface covers the slot'
    )

    const halfHeight = SLOT.height / 2
    const clippedBounds = {
      ...SLOT,
      ...COMMON,
      clipX: SLOT.screenX,
      clipY: SLOT.screenY + halfHeight,
      clipWidth: SLOT.width,
      clipHeight: halfHeight,
      visible: true
    }
    await request(ws, timeoutMs, 'preview.surface.update_bounds', { bounds: clippedBounds })
    await applyHostCommands(ws)
    await assertSurfaceAt(
      { x: 211, y: 173 + halfHeight, width: 642, height: halfHeight },
      'clipped: surface covers exactly the CLIP rect (not the full slot)'
    )

    const hiddenBounds = { ...clippedBounds, clipWidth: 0, clipHeight: 0, visible: false }
    await request(ws, timeoutMs, 'preview.surface.update_bounds', { bounds: hiddenBounds })
    await applyHostCommands(ws)
    await assertSurfaceHidden('hidden: surface leaves the screen on visible:false', SLOT)

    await request(ws, timeoutMs, 'preview.surface.update_bounds', { bounds: fullBounds })
    await applyHostCommands(ws)
    await assertSurfaceAt(
      { x: 211, y: 173, width: 642, height: 414 },
      'recovery: surface returns when visible again'
    )

    // --- Phase 2: REAL renderer-driven behavior ------------------------------------
    console.log('\n--- Phase 2: renderer-driven glue ---')
    await smokeCommand('resume-native-preview-surface')
    const appBounds = await smokeCommand('move-window', {})
    await smokeCommand('move-window', { x: appBounds.x + 1, y: appBounds.y + 1 })
    await sleep(2500)

    const inspect = await smokeCommand('inspect-native-preview-runtime')
    const win = await smokeCommand('move-window', {})
    assertProbe(Boolean(inspect.surfaceRect), 'renderer: studio slot reports a rect', JSON.stringify(inspect))
    if (inspect.surfaceRect) {
      await assertSurfaceAt(
        {
          x: win.x + inspect.surfaceRect.left,
          y: win.y + inspect.surfaceRect.top,
          width: inspect.surfaceRect.width,
          height: inspect.surfaceRect.height
        },
        'renderer: surface sits on the studio slot'
      )
    }

    // Scroll glue: the surface must track the slot, clipped at the scroll container.
    const scrolled = await smokeCommand('scroll-studio', { deltaY: 240 })
    assertProbe(Boolean(scrolled.surfaceRect), 'scroll: slot rect still reported after scrolling', JSON.stringify(scrolled))
    if (scrolled.surfaceRect) {
      const clipTop = Math.max(scrolled.surfaceRect.top, scrolled.scrollerRect.top)
      const clipBottom = Math.min(
        scrolled.surfaceRect.top + scrolled.surfaceRect.height,
        scrolled.scrollerRect.top + scrolled.scrollerRect.height
      )
      await assertSurfaceAt(
        {
          x: win.x + scrolled.surfaceRect.left,
          y: win.y + clipTop,
          width: scrolled.surfaceRect.width,
          height: Math.max(1, Math.round(clipBottom - clipTop))
        },
        'scroll glue: surface tracks the scrolled slot with clipping'
      )
    }

    // Tab switch: surface gone on Library, back on Studio.
    await smokeCommand('open-tab', { tab: 'library' })
    await assertSurfaceHidden('tabs: surface hides when leaving the Studio tab', SLOT, 6000)

    await smokeCommand('open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-surface]' })
    await sleep(1500)
    const backInspect = await smokeCommand('inspect-native-preview-runtime')
    const backWin = await smokeCommand('move-window', {})
    if (backInspect.surfaceRect) {
      const backExpected = {
        x: backWin.x + backInspect.surfaceRect.left,
        y: backWin.y + backInspect.surfaceRect.top,
        width: backInspect.surfaceRect.width,
        height: backInspect.surfaceRect.height
      }
      await assertSurfaceAt(backExpected, 'tabs: surface returns on the Studio tab')

      // Window move: the surface follows the app window by the same delta.
      const movedWin = await smokeCommand('move-window', { x: backWin.x + 137, y: backWin.y + 93 })
      await assertSurfaceAt(
        {
          ...backExpected,
          x: backExpected.x + (movedWin.x - backWin.x),
          y: backExpected.y + (movedWin.y - backWin.y)
        },
        'window move: surface follows the app window',
        8
      )
    } else {
      assertProbe(false, 'tabs: studio slot reports a rect after returning', JSON.stringify(backInspect))
    }

    console.log('\n=== Preview glue probe summary ===')
    if (failures.length === 0) {
      console.log('PASS — clip placement, hide, scroll glue, tab hide/restore, and window-move tracking verified.')
      return 0
    }
    for (const failure of failures) console.log(`FAIL: ${failure}`)
    return 1
  } finally {
    ws.close()
  }
}

async function applyHostCommands(ws) {
  const commands = await request(ws, timeoutMs, 'preview.surface.take_native_host_commands')
  if (!Array.isArray(commands) || commands.length === 0) {
    return smokeCommand('native-preview-surface-status')
  }
  console.log(`applying ${commands.length} host command(s): ${commands.map((c) => c.kind).join(', ')}`)
  return smokeCommand('apply-native-preview-host-commands', { commands })
}

async function proofState() {
  return smokeCommand('proof-window-state')
}

/**
 * The surface is present at `expected` when EITHER the proof window is visible there,
 * OR native presents own the slot and a floating-level (>=3) window sits there.
 */
async function surfacePresence(expected, tolerance) {
  const state = await proofState()
  const match = (bounds) =>
    bounds &&
    Math.abs(bounds.x - expected.x) <= tolerance &&
    Math.abs(bounds.y - expected.y) <= tolerance &&
    Math.abs(bounds.width - expected.width) <= tolerance &&
    Math.abs(bounds.height - expected.height) <= tolerance
  if (state.visible === true && match(state.bounds)) {
    return { ok: true, via: 'proof-window', state }
  }
  if (state.nativeOwnsPlacement) {
    const native = windowList().find((w) => w.layer >= 3 && match(w))
    if (native) {
      return { ok: true, via: 'native-window', state }
    }
  }
  return { ok: false, via: 'none', state }
}

async function assertSurfaceAt(expected, label, tolerance = 4, timeoutMsLocal = 5000) {
  const deadline = Date.now() + timeoutMsLocal
  let last = null
  do {
    last = await surfacePresence(expected, tolerance)
    if (last.ok) {
      assertProbe(true, `${label} [${last.via}]`, '')
      return
    }
    await sleep(250)
  } while (Date.now() < deadline)
  assertProbe(
    false,
    label,
    `expected ${JSON.stringify(expected)}, proof: ${JSON.stringify(last?.state)}, floating: ${JSON.stringify(
      lastWindowDump.filter((w) => w.layer >= 3)
    )}`
  )
}

async function assertSurfaceHidden(label, sizeHint, timeoutMsLocal = 5000) {
  const deadline = Date.now() + timeoutMsLocal
  let state = null
  let floating = []
  do {
    state = await proofState()
    floating = windowList().filter(
      (w) =>
        w.layer >= 3 &&
        Math.abs(w.width - sizeHint.width) <= 8 &&
        w.height <= sizeHint.height + 8 &&
        w.height >= 24
    )
    if (state.visible === false && floating.length === 0) {
      assertProbe(true, label, '')
      return
    }
    await sleep(250)
  } while (Date.now() < deadline)
  assertProbe(false, label, `proof: ${JSON.stringify(state)}, floating: ${JSON.stringify(floating)}`)
}

async function smokeCommand(command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
