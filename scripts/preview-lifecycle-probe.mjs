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
import { requestSmokeCommandWithRetry } from './lib/smoke-command-client.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const cycles = positiveInteger(process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES, 100)
const outputDirectory = join(tmpdir(), `videorc-preview-lifecycle-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
let smoke
let lastState = null
let lastSupervisorGeneration = 0
let exitCode = 0

try {
  exitCode = await main()
} catch (error) {
  console.error(`preview lifecycle probe failed: ${error?.message ?? error}`)
  if (lastState) {
    console.error(`last preview state: ${JSON.stringify(lastState)}`)
  }
  exitCode = 2
} finally {
  if (launched) {
    if (smoke) {
      await requestSmokeCommandWithRetry(
        smoke,
        'preview-lifecycle-allow-app-quit',
        {},
        { timeoutMs: 500 }
      ).catch(() => undefined)
    }
    await stopProcess(launched.process)
  }
}

process.exit(exitCode)

async function main() {
  console.log(`Launching dev app for preview lifecycle probe (${cycles} cycles)...`)
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_PREVIEW_LIFECYCLE_PROBE: '1',
      VIDEORC_GLASS_WALLPAPER: '0'
    },
    onLine: (line) => console.log(line)
  })
  smoke = launched.connections['preview-motion-ready']

  const initialState = await ensureClosed('initial close')
  lastSupervisorGeneration = supervisorGeneration(initialState)
  const quitAttempt = await smokeCommand('preview-lifecycle-attempt-app-quit')
  assertProbe(
    quitAttempt?.prevented === true,
    'probe ownership: unrelated app quit was prevented',
    quitAttempt
  )
  const afterQuitAttempt = await smokeCommand('preview-window-state')
  assertProbe(
    afterQuitAttempt.open === false && afterQuitAttempt.supervisor?.lifecycleState === 'closed',
    'probe ownership: app and command server remained live after the quit attempt',
    afterQuitAttempt
  )

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await toggleOpen(`cycle ${cycle}: toggle open`)
    if (cycle === 1) {
      await assertStaleDestroyIgnored('cycle 1: stale destroy is ignored')
      await assertPermissionRequiredStopsSurface('cycle 1: permission-required stops presentation')
    }
    await toggleClosed(`cycle ${cycle}: toggle close`)
    if (cycle === 1 || cycle === cycles || cycle % 10 === 0) {
      console.log(`OK   completed ${cycle}/${cycles} preview lifecycle cycles`)
    }
  }

  await toggleOpen('os close path: toggle open')
  await closeWithOsFrame('os close path: window frame close')
  await shortcutOpen('shortcut path: Cmd+P after OS close')
  await toggleClosed('shortcut path: cleanup close')

  await toggleOpen('final reopen')
  await toggleClosed('final close')

  console.log('\n=== Preview lifecycle probe summary ===')
  console.log(
    `PASS - ${cycles} repeated preview toggle cycles opened, closed, tore down surfaces, and suppressed frame polling.`
  )
  return 0
}

async function toggleOpen(label) {
  const toggled = await smokeCommand('preview-window-toggle', { expectedOpen: true })
  assertProbe(
    toggled.supervisor?.windowOpen === true || toggled.supervisor?.lifecycleState === 'opening',
    `${label}: supervisor reports window opening`,
    toggled
  )
  const generation = supervisorGeneration(toggled)
  assertProbe(generation > lastSupervisorGeneration, `${label}: supervisor generation advanced`, {
    previous: lastSupervisorGeneration,
    current: generation,
    state: toggled
  })
  lastSupervisorGeneration = generation
  const state = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.visible === true &&
      supervisorGeneration(candidate) === generation &&
      candidate.supervisor?.windowOpen === true &&
      candidate.supervisor?.lifecycleState !== 'closed' &&
      candidate.supervisor?.lifecycleState !== 'closing' &&
      candidate.framePollingSuppressedFlag === false,
    8000
  )
  assertProbe(state.ok, `${label}: preview became visible and polling resumed`, state.last)
}

async function toggleClosed(label) {
  const toggled = await smokeCommand('preview-window-toggle', { expectedOpen: false })
  assertProbe(toggled.open === false, `${label}: command reports closed`, toggled)
  assertProbe(
    supervisorGeneration(toggled) === lastSupervisorGeneration,
    `${label}: supervisor generation is stable while closing`,
    { expected: lastSupervisorGeneration, state: toggled }
  )
  await waitUntilClosed(`${label}: preview fully closed`)
}

async function closeWithOsFrame(label) {
  const closed = await smokeCommand('preview-window-os-close')
  assertProbe(closed.open === false, `${label}: command reports closed`, closed)
  assertProbe(
    supervisorGeneration(closed) === lastSupervisorGeneration,
    `${label}: supervisor generation is stable while closing`,
    { expected: lastSupervisorGeneration, state: closed }
  )
  await waitUntilClosed(`${label}: preview fully closed`)
}

async function shortcutOpen(label) {
  const opened = await smokeCommand('dispatch-preview-shortcut', { expectedOpen: true })
  assertProbe(
    opened.supervisor?.windowOpen === true || opened.supervisor?.lifecycleState === 'opening',
    `${label}: supervisor reports window opening`,
    opened
  )
  const generation = supervisorGeneration(opened)
  assertProbe(generation > lastSupervisorGeneration, `${label}: supervisor generation advanced`, {
    previous: lastSupervisorGeneration,
    current: generation,
    state: opened
  })
  lastSupervisorGeneration = generation
  const state = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.visible === true &&
      supervisorGeneration(candidate) === generation &&
      candidate.supervisor?.windowOpen === true &&
      candidate.supervisor?.lifecycleState !== 'closed' &&
      candidate.supervisor?.lifecycleState !== 'closing' &&
      candidate.framePollingSuppressedFlag === false,
    8000
  )
  assertProbe(state.ok, `${label}: preview became visible and polling resumed`, state.last)
}

async function assertStaleDestroyIgnored(label) {
  const currentGeneration = lastSupervisorGeneration
  if (currentGeneration <= 0) {
    return
  }
  const before = await waitForState(
    (candidate) => candidate.open === true && candidate.surface.exists === true,
    8000
  )
  assertProbe(before.ok, `${label}: preview surface exists before stale destroy`, before.last)
  await smokeCommand('apply-native-preview-host-commands', {
    commands: [{ kind: 'destroy' }],
    generation: currentGeneration - 1
  })
  const after = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.surface.exists === true &&
      supervisorGeneration(candidate) === currentGeneration,
    2000
  )
  assertProbe(after.ok, `${label}: current surface survived old generation destroy`, after.last)
}

async function assertPermissionRequiredStopsSurface(label) {
  const currentGeneration = lastSupervisorGeneration
  const before = await smokeCommand('preview-window-state')
  assertProbe(
    before.open === true && before.contentBounds,
    `${label}: preview is open before permission report`,
    before
  )
  const permission = await smokeCommand('preview-window-report-permission-required', {
    permissionStatus: 'screen-recording-required',
    message: 'Screen Recording permission is required for this source.',
    generation: currentGeneration
  })
  assertProbe(
    permission.supervisor?.lifecycleState === 'permission-required',
    `${label}: supervisor reports permission-required`,
    permission
  )
  assertProbe(
    permission.supervisor?.permissionStatus === 'screen-recording-required',
    `${label}: supervisor reports the screen-recording permission target`,
    permission
  )

  const blocked = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.supervisor?.lifecycleState === 'permission-required' &&
      candidate.supervisor?.surfaceRequested === false &&
      candidate.supervisor?.surfaceActive === false &&
      candidate.supervisor?.permissionStatus === 'screen-recording-required' &&
      candidate.surface.exists === false &&
      candidate.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(
    blocked.ok,
    `${label}: surface is torn down and frame polling is suppressed`,
    blocked.last
  )

  await smokeCommand('apply-native-preview-host-commands', {
    commands: [{ kind: 'create', bounds: previewSurfaceBoundsFromState(blocked.last) }],
    generation: currentGeneration
  })
  const afterReviveAttempt = await waitForState(
    (candidate) =>
      candidate.open === true &&
      candidate.supervisor?.lifecycleState === 'permission-required' &&
      candidate.surface.exists === false &&
      candidate.framePollingSuppressedFlag === true,
    2000
  )
  assertProbe(
    afterReviveAttempt.ok,
    `${label}: same-generation create is ignored while permission is required`,
    afterReviveAttempt.last
  )
}

async function ensureClosed(label) {
  const state = await smokeCommand('preview-window-state')
  lastSupervisorGeneration = supervisorGeneration(state)
  if (!state.open) {
    return waitUntilClosed(label)
  }
  await smokeCommand('preview-window-close')
  return waitUntilClosed(label)
}

async function waitUntilClosed(label) {
  const state = await waitForState(
    (candidate) =>
      candidate.open === false &&
      candidate.surface.exists === false &&
      candidate.supervisor?.lifecycleState === 'closed' &&
      candidate.supervisor?.windowOpen === false &&
      candidate.supervisor?.surfaceRequested === false &&
      candidate.supervisor?.surfaceActive === false &&
      candidate.framePollingSuppressedFlag === true,
    8000
  )
  assertProbe(state.ok, label, state.last)
  assertProbe(
    supervisorGeneration(state.last) === lastSupervisorGeneration,
    `${label}: supervisor generation stayed on the closed lifecycle`,
    { expected: lastSupervisorGeneration, state: state.last }
  )
  return state.last
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
  return requestSmokeCommandWithRetry(smoke, command, params)
}

function assertProbe(condition, label, detail) {
  if (!condition) {
    throw new Error(`${label}: ${JSON.stringify(detail)}`)
  }
}

function supervisorGeneration(state) {
  const generation = state?.supervisor?.generation
  assertProbe(Number.isInteger(generation), 'preview state includes a supervisor generation', state)
  return generation
}

function previewSurfaceBoundsFromState(state) {
  const contentBounds = state?.contentBounds
  assertProbe(contentBounds, 'preview state includes content bounds', state)
  return {
    screenX: contentBounds.x,
    screenY: contentBounds.y,
    width: contentBounds.width,
    height: contentBounds.height,
    scaleFactor: state.scaleFactor,
    screenHeight: state.screenHeight,
    visible: true
  }
}

function positiveInteger(raw, fallback) {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
