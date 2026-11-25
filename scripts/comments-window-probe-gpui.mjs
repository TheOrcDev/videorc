#!/usr/bin/env node
// GPUI-specific Comments / Stream Manager window probe (plan 260).
// Not a port of scripts/comments-window-probe.mjs: that one needs Electron
// chat fixtures (push/seed/person-card/layout-metrics). This probe covers
// what the GPUI app already answers — open/place/raise/hide, and the
// composited-window capture L6 landed in #2142 (macOS only).
//
//   VIDEORC_APP=gpui pnpm probe:comments-window
//   # or:
//   VIDEORC_APP=gpui node scripts/comments-window-probe-gpui.mjs
//
// Exits 0 on pass, 1 on assertion failure, 2 on crash. Off macOS it SKIPs
// by name (Win/Linux capture still answers "no capture").

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, smokeAppIsGpui } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const outputDirectory = join(tmpdir(), `videorc-comments-window-probe-gpui-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

/** Tier-boundary widths the Stream Manager must stay whole at. */
const CAPTURE_WIDTHS = [320, 420, 640, 1040]

let launched
let exitCode = 0
try {
  exitCode = await main()
} catch (error) {
  console.error(`gpui comments-window probe failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (launched) await launched.stop?.()
}
process.exit(exitCode)

async function main() {
  if (!smokeAppIsGpui()) {
    throw new Error('comments-window-probe-gpui.mjs requires VIDEORC_APP=gpui.')
  }
  if (process.platform !== 'darwin') {
    console.log(
      'SKIP: probe:comments-window on GPUI needs macOS window capture (#2142). Windows and Linux still answer that they have no capture.'
    )
    return 0
  }

  console.log('Launching GPUI app for comments-window probe…')
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_APP: 'gpui',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1'
    },
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_VERBOSE === '1') console.log(line)
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  const command = (name, params = {}, opts = {}) =>
    requestSmokeCommand(smoke, name, params, { timeoutMs: opts.timeoutMs ?? 15000 })

  const opened = await command('comments-window-open')
  assert(opened.open === true, `open: expected open, got ${JSON.stringify(opened)}`)
  assert(
    opened.protected === false,
    `capture policy: Stream Manager stays in recordings by default, got ${JSON.stringify(opened)}`
  )
  console.log('open ✓')

  await command('comments-window-set-bounds', { x: 200, y: 140, width: 420, height: 640 })
  const placed = await waitFor(
    () => command('comments-window-state'),
    (state) =>
      state?.open === true && near(state?.bounds?.width, 420) && near(state?.bounds?.height, 640),
    'Stream Manager did not land at 420×640'
  )
  console.log(`place ${Math.round(placed.bounds.width)}×${Math.round(placed.bounds.height)} ✓`)

  const raised = await command('raise-window', {
    role: 'chat',
    level: 'floating',
    focus: false
  })
  assert(
    raised?.role === 'chat' && raised?.level === 'floating',
    `raise-window failed: ${JSON.stringify(raised)}`
  )
  console.log('raise-window (floating) ✓')

  const defaultCapture = await command('comments-window-capture-page', {
    name: 'gpui-comments-default'
  })
  assertCapture(defaultCapture, 420, 640, 'default 420×640 capture')
  console.log(`capture default → ${defaultCapture.file} ✓`)

  for (const width of CAPTURE_WIDTHS) {
    const shot = await command('comments-window-capture-page', {
      name: `gpui-comments-w${width}`,
      width,
      height: 640
    })
    assertCapture(shot, width, 640, `width ${width}`)
    console.log(`capture ${width}×640 → ${shot.file} ✓`)
  }

  const page = await command('capture-page', {
    name: 'gpui-stream-manager-page',
    window: 'stream-manager'
  })
  assert(
    typeof page?.file === 'string' && existsSync(page.file),
    `capture-page stream-manager missing file: ${JSON.stringify(page)}`
  )
  assert(statSync(page.file).size > 0, `capture-page wrote an empty file: ${page.file}`)
  console.log(`capture-page stream-manager → ${page.file} ✓`)

  await command('comments-window-set-smoke-marker', { color: '#5f4b8b' })
  const marked = await command('comments-window-capture-page', {
    name: 'gpui-comments-smoke-marker',
    width: 420,
    height: 640
  })
  assertCapture(marked, 420, 640, 'smoke-marker capture')
  console.log('smoke-marker capture ✓')

  await command('comments-window-set-hidden-from-stream', { hidden: true })
  const hidden = await command('comments-window-state')
  assert(
    hidden?.hiddenFromStream === true,
    `hide from stream: expected hiddenFromStream true, got ${JSON.stringify(hidden)}`
  )
  console.log('set-hidden-from-stream on ✓')

  await command('comments-window-set-hidden-from-stream', { hidden: false })
  await command('comments-window-close')
  const closed = await command('comments-window-state')
  assert(closed.open === false, `close: expected closed, got ${JSON.stringify(closed)}`)
  console.log('close ✓')

  const toggled = await command('comments-window-toggle')
  assert(toggled.open === true, `toggle open: expected open, got ${JSON.stringify(toggled)}`)
  await command('comments-window-toggle')
  const toggledShut = await command('comments-window-state')
  assert(
    toggledShut.open === false,
    `toggle close: expected closed, got ${JSON.stringify(toggledShut)}`
  )
  console.log('toggle ✓')

  console.log('gpui comments-window probe: all checks passed')
  return 0
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function near(value, expected, slack = 2) {
  return typeof value === 'number' && Math.abs(value - expected) <= slack
}

function assertCapture(shot, width, height, label) {
  assert(typeof shot?.file === 'string', `${label}: no file in ${JSON.stringify(shot)}`)
  assert(existsSync(shot.file), `${label}: missing ${shot.file}`)
  assert(statSync(shot.file).size > 0, `${label}: empty ${shot.file}`)
  assert(
    near(shot.width, width, 4) && near(shot.height, height, 4),
    `${label}: expected ~${width}×${height}, got ${shot.width}×${shot.height}`
  )
}

async function waitFor(read, holds, label, budgetMs = 10000) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (holds(last)) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${label}: last=${JSON.stringify(last)}`)
}
