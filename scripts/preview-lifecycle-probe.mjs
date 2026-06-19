#!/usr/bin/env node
// Preview lifecycle probe: repeated command-level open/close/toggle coverage.
//
// This complements preview-window-probe.mjs. The window probe proves placement;
// this probe proves the lifecycle does not get stuck after repeated close/reopen
// cycles and that close fully suppresses detached-preview presentation work.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const cycles = positiveInteger(process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES, 100)
const outputDirectory = join(tmpdir(), `videorc-preview-lifecycle-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
let smoke
let lastState = null

try {
  const exitCode = await main()
  process.exit(exitCode)
} catch (error) {
  console.error(`preview lifecycle probe failed: ${error?.message ?? error}`)
  if (lastState) {
    console.error(`last preview state: ${JSON.stringify(lastState)}`)
  }
  process.exit(2)
} finally {
  if (launched) await stopProcess(launched.process)
}

async function main() {
  console.log(`Launching dev app for preview lifecycle probe (${cycles} cycles)...`)
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    onLine: (line) => console.log(line)
  })
  smoke = launched.connections['preview-motion-ready']

  await ensureClosed('initial close')

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await toggleOpen(`cycle ${cycle}: toggle open`)
    await toggleClosed(`cycle ${cycle}: toggle close`)
    if (cycle === 1 || cycle === cycles || cycle % 10 === 0) {
      console.log(`OK   completed ${cycle}/${cycles} preview lifecycle cycles`)
    }
  }

  await toggleOpen('final reopen')
  await toggleClosed('final close')

  console.log('\n=== Preview lifecycle probe summary ===')
  console.log(
    `PASS - ${cycles} repeated preview toggle cycles opened, closed, tore down surfaces, and suppressed frame polling.`
  )
  return 0
}

async function toggleOpen(label) {
  const toggled = await smokeCommand('preview-window-toggle')
  assertProbe(toggled.open === true, `${label}: command reports open`, toggled)
  const state = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.visible === true &&
      candidate.framePollingSuppressedFlag === false,
    8000
  )
  assertProbe(state.ok, `${label}: preview became visible and polling resumed`, state.last)
}

async function toggleClosed(label) {
  const toggled = await smokeCommand('preview-window-toggle')
  assertProbe(toggled.open === false, `${label}: command reports closed`, toggled)
  await waitUntilClosed(`${label}: preview fully closed`)
}

async function ensureClosed(label) {
  const state = await smokeCommand('preview-window-state')
  if (!state.open) {
    await waitUntilClosed(label)
    return
  }
  await smokeCommand('preview-window-close')
  await waitUntilClosed(label)
}

async function waitUntilClosed(label) {
  const state = await waitForState(
    (candidate) =>
      candidate.open === false &&
      candidate.surface.exists === false &&
      candidate.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(state.ok, label, state.last)
}

async function waitForState(predicate, timeoutMsLocal) {
  const deadline = Date.now() + timeoutMsLocal
  do {
    lastState = await smokeCommand('preview-window-state')
    if (predicate(lastState)) {
      return { ok: true, last: lastState }
    }
    await sleep(150)
  } while (Date.now() < deadline)
  return { ok: false, last: lastState }
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

function assertProbe(condition, label, detail) {
  if (!condition) {
    throw new Error(`${label}: ${JSON.stringify(detail)}`)
  }
}

function positiveInteger(raw, fallback) {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
