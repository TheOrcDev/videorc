#!/usr/bin/env node
// Combined macOS preview continuity gate. Unlike the older focused smokes,
// this keeps sampling the real native CAMetalLayer while placement, focus,
// clicks, and scene intent all change without a settle period.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import {
  PREVIEW_INTERACTION_STRESS_PROFILE as profile,
  analyzeCgWindowObservations,
  analyzeNativeStatusSamples,
  cgOraclePreviewReady,
  effectivePresentFpsFloor
} from './lib/preview-interaction-stress.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'darwin') {
  throw new Error('Preview interaction stress targets the production macOS CAMetalLayer path.')
}

const deviceMode = process.env.VIDEORC_PREVIEW_INTERACTION_DEVICE_SMOKE === '1'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const deviceRecordingMs = Number(process.env.VIDEORC_PREVIEW_INTERACTION_RECORDING_MS ?? 60000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-preview-interaction-stress-${Date.now()}`)
)
const thresholds = {
  ...profile.thresholds,
  expectedHostKind: process.env.VIDEORC_PREVIEW_INTERACTION_EXPECT_HOST_KIND ?? 'in-process',
  requirePixelOracle: deviceMode,
  minPresentFps: numberEnv('VIDEORC_PREVIEW_INTERACTION_MIN_FPS', profile.thresholds.minPresentFps),
  maxIntervalP95Ms: numberEnv(
    'VIDEORC_PREVIEW_INTERACTION_MAX_INTERVAL_P95_MS',
    profile.thresholds.maxIntervalP95Ms
  ),
  maxInputToPresentP95Ms: numberEnv(
    'VIDEORC_PREVIEW_INTERACTION_MAX_INPUT_TO_PRESENT_P95_MS',
    profile.thresholds.maxInputToPresentP95Ms
  )
}

mkdirSync(outputDirectory, { recursive: true })

let launched
let ws
let oracle
let smoke
let expectedScreenSceneKind = 'test-pattern'
let deviceCaptureSources = null
const report = {
  contract: profile,
  thresholds,
  deviceMode,
  outputDirectory,
  pixelOracle: {
    enabled: deviceMode,
    ...profile.pixelOracle,
    reason: deviceMode
      ? 'A downsampled ScreenCaptureKit oracle samples the complete Electron preview window and fails when the #0D0D0F preview base is exposed.'
      : 'The default synthetic gate deliberately requires no Screen Recording permission. Persistent CGWindow geometry/order is the permission-free compositor oracle.'
  },
  phases: {},
  failures: []
}

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      ...(deviceMode ? {} : { VIDEORC_SMOKE_PREVIEW_MOTION: '1' }),
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
    },
    onLine: process.env.VIDEORC_SMOKE_VERBOSE === '1' ? console.log : undefined
  })
  const backend = launched.connections['backend-ready']
  smoke = launched.connections['preview-motion-ready']
  if (!Number.isSafeInteger(smoke.appPid) || smoke.appPid <= 0) {
    throw new Error(`Preview smoke handshake did not identify its Electron PID: ${smoke.appPid}`)
  }
  thresholds.expectedWindowPid = smoke.appPid
  ws = await connectBackend(backend, timeoutMs)

  await smokeCommand(smoke, 'open-tab', {
    tab: 'studio',
    waitFor: '[data-videorc-preview-card]'
  })
  await dismissLaunchDialogs(smoke)
  await smokeCommand(smoke, 'preview-window-open')
  await smokeCommand(smoke, 'preview-window-set-bounds', {
    x: 180,
    y: 120,
    width: 960,
    height: 568
  })
  await waitForNativeSurface(smoke)

  oracle = await startCgWindowOracle(outputDirectory, {
    pixelCapture: deviceMode,
    expectedWindowPid: smoke.appPid
  })
  await waitForCgHost(oracle, smoke)

  if (deviceMode) {
    const [screenSource, cameraSource] = await Promise.all([
      smokeCommand(smoke, 'select-screen-device', { settleMs: 1000 }),
      smokeCommand(smoke, 'select-camera-device', { settleMs: 1000 })
    ])
    expectedScreenSceneKind = screenSource.kind
    deviceCaptureSources = {
      ...(screenSource.kind === 'window'
        ? { windowId: screenSource.id }
        : { screenId: screenSource.id }),
      cameraId: cameraSource.cameraId,
      testPattern: false
    }
    report.deviceSources = { screenSource, cameraSource }
    await waitForDeviceSources(ws, screenSource.id, cameraSource.cameraId)
  } else {
    // Synthetic screen bars plus the selected camera exercise all four UI
    // presets without requiring ScreenCaptureKit permission.
    await smokeCommand(smoke, 'enable-synthetic-source', { settleMs: 250 })
    await smokeCommand(smoke, 'select-camera-device', { settleMs: 250 })
  }
  await smokeCommand(smoke, 'open-layout-tab')

  const scenePhase = await runRapidScenePhase({ smoke, ws, oracle })
  report.phases.rapidScenes = scenePhase
  report.failures.push(...scenePhase.failures)

  await smokeCommand(smoke, 'preview-window-set-mode', { mode: 'floating' })
  await smokeCommand(smoke, 'preview-window-set-bounds', {
    x: 180,
    y: 120,
    width: 960,
    height: 568
  })
  await waitForNativeSurface(smoke)
  await waitForCgHost(oracle, smoke)
  const floatingPhase = await runMovementPhase({
    label: 'floating movement/resize + focus/click',
    smoke,
    oracle,
    movement: profile.floating,
    command: 'preview-window-set-bounds',
    boundsForIndex: floatingBounds,
    interleaveClickFocus: true
  })
  report.phases.floating = floatingPhase
  report.failures.push(...floatingPhase.failures)

  const resizePhase = await runMovementPhase({
    label: 'floating continuous resize',
    smoke,
    oracle,
    movement: resizeMovementProfile(),
    command: 'preview-window-set-bounds',
    boundsForIndex: floatingResizeBounds,
    interleaveClickFocus: false
  })
  report.phases.resize = resizePhase
  report.failures.push(...resizePhase.failures)

  await smokeCommand(smoke, 'main-window-set-bounds', {
    x: 100,
    y: 90,
    width: 1180,
    height: 780
  })
  await smokeCommand(smoke, 'main-window-focus')
  const docked = await smokeCommand(smoke, 'preview-window-set-mode', { mode: 'docked' })
  if (docked.mode !== 'docked') {
    report.failures.push(`docked setup returned mode ${docked.mode ?? 'missing'}`)
  }
  await smokeCommand(smoke, 'open-tab', {
    tab: 'studio',
    waitFor: '[data-videorc-dock-slot]'
  })
  await dismissLaunchDialogs(smoke)
  await smokeCommand(smoke, 'preview-window-set-dock-overlay', { open: false })
  await waitForNativeSurface(smoke, { mode: 'docked' })
  await waitForCgHost(oracle, smoke)
  const dockedPhase = await runMovementPhase({
    label: 'docked main-window movement',
    smoke,
    oracle,
    movement: profile.docked,
    command: 'main-window-set-bounds',
    boundsForIndex: dockedMainBounds,
    interleaveClickFocus: false
  })
  report.phases.docked = dockedPhase
  report.failures.push(...dockedPhase.failures)

  if (deviceMode) {
    const recordingPhase = await runDeviceRecordingPhase({ smoke, ws, oracle })
    report.phases.recording = recordingPhase
    report.failures.push(...recordingPhase.failures)
  }

  report.failures = unique(report.failures)
  writeEvidence()
  printPhaseSummary('rapid scenes', scenePhase)
  printPhaseSummary('floating', floatingPhase)
  printPhaseSummary('resize', resizePhase)
  printPhaseSummary('docked', dockedPhase)
  console.log(`CGWindow/presentation evidence: ${join(outputDirectory, 'report.json')}`)
  console.log(
    `${deviceMode ? 'Pixel oracle' : 'Pixel oracle skipped'}: ${report.pixelOracle.reason}`
  )

  if (report.failures.length > 0) {
    const shown = report.failures.slice(0, 40)
    const remainder = report.failures.length - shown.length
    throw new Error(
      `Preview interaction stress failed (${report.failures.length} contract breach(es)):\n` +
        shown.map((failure) => `- ${failure}`).join('\n') +
        (remainder > 0 ? `\n- ... ${remainder} additional breach(es); see report.json` : '')
    )
  }

  console.log(
    'Preview interaction stress OK - native CAMetalLayer stayed live, aligned, front-most, and scene-current through floating/docked movement and rapid layout intent.'
  )
} finally {
  writeEvidence()
  try {
    ws?.close()
  } catch {
    // Best-effort cleanup.
  }
  await oracle?.stop()
  if (smoke) {
    await smokeCommand(smoke, 'preview-lifecycle-attempt-app-quit', {}, 2000).catch(() => undefined)
  }
  await launched?.stop()
}

async function runRapidScenePhase({ smoke, ws, oracle }) {
  const failures = []
  const transitions = []
  const sampler = startStatusSampler(smoke)
  const startedAt = Date.now()

  // Exercise the actual last-intent contract before the sequential human-speed
  // loop: these clicks overlap while the earlier backend requests are still in
  // flight. The final side-by-side intent must supersede both predecessors.
  try {
    const preset = 'side-by-side'
    const selected = await issueLayoutIntentBurst(smoke, ['camera-only', 'screen-only', preset])
    const transition = await waitForSceneConvergence({
      label: 'overlapping latest-intent burst',
      preset,
      selected,
      smoke,
      ws
    })
    transitions.push({ round: 0, ...transition })
    failures.push(...transition.failures)
  } catch (error) {
    failures.push(`overlapping latest-intent burst failed: ${error?.message ?? error}`)
  }

  for (let round = 1; round <= profile.sceneRounds; round += 1) {
    for (const preset of profile.sceneSequence) {
      const label = `scene round ${round} ${preset}`
      try {
        const selected = await smokeCommand(smoke, 'select-layout-preset', {
          preset,
          settleMs: 0
        })
        const transition = await waitForSceneConvergence({
          label,
          preset,
          selected,
          smoke,
          ws
        })
        transitions.push({ round, ...transition })
        failures.push(...transition.failures)
      } catch (error) {
        failures.push(`${label} command failed: ${error?.message ?? error}`)
      }
    }
  }

  await sleep(100)
  const samples = await sampler.stop()
  const finishedAt = Date.now()
  const continuity = analyzeNativeStatusSamples(samples, thresholds)
  const cgWindow = analyzeCgWindowObservations(
    joinOracleObservations(samples, oracle.samples, startedAt, finishedAt),
    thresholds
  )
  failures.push(...prefixFailures('rapid scenes', continuity.failures))
  failures.push(...prefixFailures('rapid scenes', cgWindow.failures))

  return {
    startedAt,
    finishedAt,
    transitionCount: transitions.length,
    transitions,
    continuity,
    cgWindow,
    failures: unique(failures)
  }
}

async function issueLayoutIntentBurst(smoke, sequence) {
  const response = await smokeCommand(smoke, 'eval-js', {
    sequence,
    interClickMs: 10,
    code: `
      const sequence = Array.isArray(params.sequence) ? params.sequence : [];
      for (const preset of sequence) {
        const button = Array.from(document.querySelectorAll('[data-videorc-layout-preset]'))
          .find((candidate) => candidate.getAttribute('data-videorc-layout-preset') === preset);
        if (!button) throw new Error('Missing layout button ' + preset);
        if (button.disabled) throw new Error('Layout button ' + preset + ' blocked a newer intent');
        button.click();
        await sleep(Number(params.interClickMs ?? 10));
      }
      const preset = sequence.at(-1);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const button = Array.from(document.querySelectorAll('[data-videorc-layout-preset]'))
          .find((candidate) => candidate.getAttribute('data-videorc-layout-preset') === preset);
        if (button?.getAttribute('aria-pressed') === 'true') {
          return { preset, pressed: true, disabled: Boolean(button.disabled), label: button.textContent?.trim() ?? '' };
        }
        await sleep(25);
      }
      throw new Error('Latest layout intent did not commit ' + preset);
    `
  })
  return response?.result ?? response
}

async function waitForSceneConvergence({ label, preset, selected, smoke, ws }) {
  const deadline = Date.now() + 8000
  let transition = null
  let failures = []
  while (Date.now() < deadline) {
    const [surface, scene, compositor, nativeStatus] = await Promise.all([
      smokeCommand(smoke, 'preview-surface-scene-state'),
      request(ws, timeoutMs, 'scene.get'),
      request(ws, timeoutMs, 'compositor.status'),
      smokeCommand(smoke, 'native-preview-surface-status')
    ])
    transition = { preset, selected, surface, scene, compositor, nativeStatus }
    failures = sceneConvergenceFailures(label, transition)
    if (failures.length === 0) {
      return { ...transition, failures }
    }
    await sleep(50)
  }
  return { ...transition, failures }
}

async function runDeviceRecordingPhase({ smoke, ws, oracle }) {
  if (!deviceCaptureSources) {
    throw new Error('Device recording phase has no real capture sources.')
  }
  const failures = []
  const startedAt = Date.now()
  const recordingDirectory = await smokeCommand(smoke, 'authorize-smoke-resource', {
    path: outputDirectory,
    kind: 'output-directory'
  })
  const started = await request(ws, timeoutMs, 'session.start', {
    sources: deviceCaptureSources,
    layout: deviceLayout('screen-camera'),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: recordingDirectory.capabilityId,
      video: deviceVideo(),
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  if (started.state !== 'recording') {
    throw new Error(`Device interaction recording did not start: ${JSON.stringify(started)}`)
  }
  await sleep(500)

  let stopped = null
  try {
    // The layout controls live outside Studio, so a docked preview intentionally
    // hides when that tab opens. Exercise recording scene switches with the
    // preview floating and visibly presenting instead of silently filtering the
    // hidden docked window out of the oracle.
    await smokeCommand(smoke, 'preview-window-set-mode', { mode: 'floating' })
    await smokeCommand(smoke, 'preview-window-set-bounds', {
      x: 180,
      y: 120,
      width: 960,
      height: 568
    })
    await waitForNativeSurface(smoke, { mode: 'floating' })
    await waitForCgHost(oracle, smoke)
    await smokeCommand(smoke, 'open-layout-tab')
    const rapidScenes = await runRapidScenePhase({ smoke, ws, oracle })
    failures.push(...prefixFailures('recording', rapidScenes.failures))

    await smokeCommand(smoke, 'preview-window-set-mode', { mode: 'floating' })
    await smokeCommand(smoke, 'preview-window-set-bounds', {
      x: 180,
      y: 120,
      width: 960,
      height: 568
    })
    await waitForNativeSurface(smoke, { mode: 'floating' })
    await waitForCgHost(oracle, smoke)
    const floating = await runMovementPhase({
      label: 'recording floating movement/resize + focus/click',
      smoke,
      oracle,
      movement: profile.floating,
      command: 'preview-window-set-bounds',
      boundsForIndex: floatingBounds,
      interleaveClickFocus: true,
      targetPresentFps: deviceVideo().fps
    })
    failures.push(...floating.failures)

    const resize = await runMovementPhase({
      label: 'recording floating continuous resize',
      smoke,
      oracle,
      movement: resizeMovementProfile(),
      command: 'preview-window-set-bounds',
      boundsForIndex: floatingResizeBounds,
      interleaveClickFocus: false,
      targetPresentFps: deviceVideo().fps
    })
    failures.push(...resize.failures)

    await smokeCommand(smoke, 'main-window-set-bounds', {
      x: 100,
      y: 90,
      width: 1180,
      height: 780
    })
    await smokeCommand(smoke, 'main-window-focus')
    await smokeCommand(smoke, 'preview-window-set-mode', { mode: 'docked' })
    await smokeCommand(smoke, 'open-tab', {
      tab: 'studio',
      waitFor: '[data-videorc-dock-slot]'
    })
    await dismissLaunchDialogs(smoke)
    await smokeCommand(smoke, 'preview-window-set-dock-overlay', { open: false })
    await waitForNativeSurface(smoke, { mode: 'docked' })
    await waitForCgHost(oracle, smoke)
    const docked = await runMovementPhase({
      label: 'recording docked main-window movement',
      smoke,
      oracle,
      movement: profile.docked,
      command: 'main-window-set-bounds',
      boundsForIndex: dockedMainBounds,
      interleaveClickFocus: false,
      targetPresentFps: deviceVideo().fps
    })
    failures.push(...docked.failures)

    const remainingMs = Math.max(0, deviceRecordingMs - (Date.now() - startedAt))
    if (remainingMs > 0) {
      await sleep(remainingMs)
    }
    const stopRequestedAt = Date.now()
    stopped = await request(ws, timeoutMs, 'session.stop')
    const outputPath = await resolveFinalRecordingPath({
      started,
      stopped,
      stopRequestedAt,
      timeoutMs
    })
    const artifact = await analyzeDeviceRecordingArtifact(outputPath, deviceRecordingMs)
    return {
      startedAt,
      finishedAt: Date.now(),
      sessionId: started.sessionId,
      rapidScenes,
      floating,
      resize,
      docked,
      artifact,
      failures: unique(failures)
    }
  } finally {
    if (!stopped) {
      await request(ws, timeoutMs, 'session.stop').catch(() => undefined)
    }
  }
}

async function runMovementPhase({
  label,
  smoke,
  oracle,
  movement,
  command,
  boundsForIndex,
  interleaveClickFocus,
  targetPresentFps
}) {
  const failures = []
  const sampler = startStatusSampler(smoke)
  const startedAt = Date.now()
  const measurementMs =
    movement.positionUpdates * movement.cadenceMs +
    movement.burstUpdates * movement.burstCadenceMs +
    900
  const measurementPromise = smokeCommand(smoke, 'measure-native-preview-surface', {
    durationMs: measurementMs
  })
  await sleep(50)

  let clickFocusPromise = null
  const steady = await dispatchBoundsStorm({
    smoke,
    command,
    count: movement.positionUpdates,
    cadenceMs: movement.cadenceMs,
    boundsForIndex,
    offset: 0,
    onDispatch: (index) => {
      if (interleaveClickFocus && index === 24 && !clickFocusPromise) {
        clickFocusPromise = smokeCommand(smoke, 'exercise-preview-click-focus', {
          preserveScene: deviceMode
        })
      }
    }
  })
  const burst = await dispatchBoundsStorm({
    smoke,
    command,
    count: movement.burstUpdates,
    cadenceMs: movement.burstCadenceMs,
    boundsForIndex,
    offset: movement.positionUpdates
  })
  failures.push(...requestFailureMessages(`${label} steady`, steady))
  failures.push(...requestFailureMessages(`${label} burst`, burst))

  if (interleaveClickFocus) {
    try {
      const clickFocus = await clickFocusPromise
      if (!clickFocus?.previewClicked || !clickFocus?.surfaceClicked) {
        failures.push(`${label} did not deliver both preview and native-surface clicks`)
      }
      if (!Array.isArray(clickFocus?.steps) || clickFocus.steps.length < 7) {
        failures.push(`${label} click/focus exercise omitted interaction steps`)
      }
    } catch (error) {
      failures.push(`${label} click/focus exercise failed: ${error?.message ?? error}`)
    }
  }

  let measurement = null
  try {
    measurement = await measurementPromise
    failures.push(...measurementFailures(label, measurement, targetPresentFps))
  } catch (error) {
    failures.push(`${label} measurement failed: ${error?.message ?? error}`)
  }

  await sleep(150)
  const samples = await sampler.stop()
  const finishedAt = Date.now()
  const continuity = analyzeNativeStatusSamples(samples, thresholds)
  const observations = joinOracleObservations(samples, oracle.samples, startedAt, finishedAt)
  const cgWindow = analyzeCgWindowObservations(observations, thresholds)
  failures.push(...prefixFailures(label, continuity.failures))
  failures.push(...prefixFailures(label, cgWindow.failures))
  failures.push(...movementObservabilityFailures(label, samples))

  return {
    startedAt,
    finishedAt,
    command,
    movement,
    measurement,
    continuity,
    cgWindow,
    failures: unique(failures)
  }
}

function sceneConvergenceFailures(
  label,
  { preset, selected, surface, scene, compositor, nativeStatus }
) {
  const failures = []
  const expectedKinds = expectedKindsForPreset(preset)
  const sceneKinds = scene.sources.map((source) => source.kind).sort()
  const visibleSceneIds = scene.sources
    .filter((source) => source.visible !== false)
    .map((source) => source.id)
    .sort()
  const visibleSurfaceIds = [...(surface.visibleSourceIds ?? [])].sort()

  if (selected?.preset !== preset || selected?.pressed !== true) {
    failures.push(`${label}: UI did not commit the requested preset`)
  }
  if (JSON.stringify(sceneKinds) !== JSON.stringify(expectedKinds)) {
    failures.push(
      `${label}: backend scene used ${sceneKinds.join(' + ') || 'no sources'}, expected ${expectedKinds.join(' + ')}`
    )
  }
  if (surface.layoutPreset !== preset) {
    failures.push(
      `${label}: native surface stayed on ${surface.layoutPreset ?? 'no layout'}, expected ${preset}`
    )
  }
  if (compositor.sceneLayout?.layoutPreset !== preset) {
    failures.push(
      `${label}: compositor layout stayed on ${compositor.sceneLayout?.layoutPreset ?? 'no layout'}, expected ${preset}`
    )
  }
  if (JSON.stringify(visibleSurfaceIds) !== JSON.stringify(visibleSceneIds)) {
    failures.push(
      `${label}: native surface sources ${visibleSurfaceIds.join(', ') || 'none'} did not match backend ${visibleSceneIds.join(', ') || 'none'}`
    )
  }
  if (
    !Number.isSafeInteger(surface.sceneRevision) ||
    surface.sceneRevision !== compositor.sceneRevision ||
    compositor.sceneRevision !== compositor.frameSceneRevision ||
    compositor.sceneRevision !== nativeStatus.nativePreviewPresentedSceneRevision
  ) {
    failures.push(
      `${label}: revision mismatch surface=${surface.sceneRevision ?? 'none'} compositor=${compositor.sceneRevision ?? 'none'} frame=${compositor.frameSceneRevision ?? 'none'} presented=${nativeStatus.nativePreviewPresentedSceneRevision ?? 'none'}`
    )
  }
  if (nativeStatus.firstFrameContract && nativeStatus.firstFrameContract !== 'met') {
    failures.push(
      `${label}: first-frame contract was ${nativeStatus.firstFrameContract} (${nativeStatus.firstFrameReason ?? 'no reason'})`
    )
  }
  if ((nativeStatus.compositorFrameLag ?? 0) > thresholds.maxCompositorFrameLag) {
    failures.push(
      `${label}: compositor frame lag ${nativeStatus.compositorFrameLag} exceeded ${thresholds.maxCompositorFrameLag}`
    )
  }
  failures.push(...nativeIdentityFailures(label, nativeStatus))
  return failures
}

function measurementFailures(label, measurement, targetPresentFps) {
  const failures = []
  const fps = finiteNumber(measurement.measuredFps)
  const minimumFps = effectivePresentFpsFloor(
    thresholds.minPresentFps,
    targetPresentFps ?? measurement.status?.targetFps
  )
  const intervalP95Ms = finiteNumber(measurement.intervalP95Ms)
  const latencyP95Ms = finiteNumber(measurement.inputToPresentLatencyP95Ms)
  if (fps === null || fps < minimumFps) {
    failures.push(`${label} present FPS ${format(fps)} was below ${format(minimumFps)}`)
  }
  if (intervalP95Ms === null || intervalP95Ms > thresholds.maxIntervalP95Ms) {
    failures.push(
      `${label} present interval p95 ${format(intervalP95Ms)}ms exceeded ${thresholds.maxIntervalP95Ms}ms`
    )
  }
  if (latencyP95Ms === null || latencyP95Ms > thresholds.maxInputToPresentP95Ms) {
    failures.push(
      `${label} input-to-present p95 ${format(latencyP95Ms)}ms exceeded ${thresholds.maxInputToPresentP95Ms}ms`
    )
  }
  failures.push(...nativeIdentityFailures(label, measurement.status ?? {}))
  return failures
}

function nativeIdentityFailures(label, status) {
  const failures = []
  if (status.state !== 'live') failures.push(`${label}: native status state was ${status.state}`)
  if (status.transport !== 'native-surface') {
    failures.push(`${label}: native transport was ${status.transport}`)
  }
  if (status.backing !== 'cametal-layer') {
    failures.push(`${label}: native backing was ${status.backing}`)
  }
  if (status.sourcePixelsPresent !== true) {
    failures.push(`${label}: native status did not report source pixels`)
  }
  if (status.nativePreviewHostKind !== thresholds.expectedHostKind) {
    failures.push(
      `${label}: native preview host kind was ${status.nativePreviewHostKind ?? 'missing'}, expected ${thresholds.expectedHostKind}`
    )
  }
  if (status.nativePreviewHostAttached !== true) {
    failures.push(`${label}: native preview host was not attached`)
  }
  return failures
}

function movementObservabilityFailures(label, samples) {
  const failures = []
  const first = samples[0]?.status ?? {}
  const last = samples.at(-1)?.status ?? {}
  const requiredMetrics = [
    'nativePreviewPlacementEventsReceived',
    'nativePreviewPlacementsCoalesced',
    'nativePreviewPlacementsApplied',
    'nativePreviewPresentRoundTripP95Ms',
    'nativePreviewIosurfaceCacheHits',
    'nativePreviewIosurfaceImports',
    'nativePreviewIosurfaceInvalidations',
    'nativePreviewIosurfaceImportFailures'
  ]
  for (const name of requiredMetrics) {
    if (finiteNumber(last[name]) === null) {
      failures.push(`${label}: native observability metric ${name} was missing`)
    }
  }

  const received = finiteNumber(last.nativePreviewPlacementEventsReceived)
  const coalesced = finiteNumber(last.nativePreviewPlacementsCoalesced)
  const applied = finiteNumber(last.nativePreviewPlacementsApplied)
  if (
    received !== null &&
    coalesced !== null &&
    applied !== null &&
    coalesced + applied > received
  ) {
    failures.push(
      `${label}: placement accounting applied ${applied} + coalesced ${coalesced} exceeded ${received} received`
    )
  }

  const invalidationDelta = counterDelta(
    first.nativePreviewIosurfaceInvalidations,
    last.nativePreviewIosurfaceInvalidations
  )
  if (invalidationDelta > 0) {
    failures.push(
      `${label}: window movement/resize invalidated ${invalidationDelta} cached compositor IOSurface import(s)`
    )
  }
  const importFailureDelta = counterDelta(
    first.nativePreviewIosurfaceImportFailures,
    last.nativePreviewIosurfaceImportFailures
  )
  if (importFailureDelta > 0) {
    failures.push(`${label}: IOSurface import failures increased by ${importFailureDelta}`)
  }
  if ((finiteNumber(last.nativePreviewIosurfaceImports) ?? 0) <= 0) {
    failures.push(`${label}: native host reported no IOSurface imports`)
  }
  if ((finiteNumber(last.nativePreviewIosurfaceCacheHits) ?? 0) <= 0) {
    failures.push(`${label}: native host reported no IOSurface cache hits`)
  }
  return failures
}

function counterDelta(first, last) {
  const firstValue = finiteNumber(first)
  const lastValue = finiteNumber(last)
  if (firstValue === null || lastValue === null) return 0
  return Math.max(0, lastValue - firstValue)
}

function dispatchBoundsStorm({
  smoke,
  command,
  count,
  cadenceMs,
  boundsForIndex,
  offset,
  onDispatch
}) {
  if (process.env.VIDEORC_PREVIEW_INTERACTION_HTTP_STORM !== '1') {
    const updates = Array.from({ length: count }, (_, index) => boundsForIndex(index + offset))
    if (onDispatch) {
      for (let index = 0; index < count; index += 1) {
        setTimeout(() => onDispatch(index), index * cadenceMs)
      }
    }
    return Promise.allSettled([
      smokeCommand(smoke, 'window-bounds-storm', {
        target: command === 'main-window-set-bounds' ? 'main' : 'preview',
        updates,
        cadenceMs
      })
    ])
  }

  const startedAt = performance.now()
  return Promise.allSettled(
    Array.from(
      { length: count },
      (_, index) =>
        new Promise((resolveDispatch, rejectDispatch) => {
          const delayMs = Math.max(0, startedAt + index * cadenceMs - performance.now())
          setTimeout(() => {
            onDispatch?.(index)
            smokeCommand(smoke, command, boundsForIndex(index + offset)).then(
              resolveDispatch,
              rejectDispatch
            )
          }, delayMs)
        })
    )
  )
}

function floatingBounds(index) {
  return {
    x: 140 + triangle(index, 48) * 12,
    y: 90 + triangle(index + 13, 36) * 7
  }
}

function floatingResizeBounds(index) {
  const width = 880 + triangle(index + 7, 30) * 6
  return {
    x: 180,
    y: 120,
    width,
    height: Math.round((width * 9) / 16) + 28
  }
}

function resizeMovementProfile() {
  return {
    positionUpdates: 60,
    cadenceMs: 16,
    burstUpdates: 30,
    burstCadenceMs: 8
  }
}

function dockedMainBounds(index) {
  return {
    x: 80 + triangle(index, 50) * 10,
    y: 70 + triangle(index + 11, 40) * 5
  }
}

function triangle(index, period) {
  const phase = ((index % period) + period) % period
  return phase <= period / 2 ? phase : period - phase
}

function startStatusSampler(smoke) {
  const samples = []
  let stopping = false
  const running = (async () => {
    while (!stopping) {
      const startedAt = Date.now()
      try {
        const [status, windowState] = await Promise.all([
          smokeCommand(smoke, 'native-preview-surface-status', {}, 5000),
          smokeCommand(smoke, 'preview-window-state', {}, 5000)
        ])
        samples.push({ at: Date.now(), status, windowState })
      } catch (error) {
        samples.push({
          at: Date.now(),
          status: { state: 'sampler-error' },
          windowState: null,
          error: error?.message ?? String(error)
        })
      }
      await sleep(Math.max(0, profile.sampleIntervalMs - (Date.now() - startedAt)))
    }
  })()
  return {
    async stop() {
      stopping = true
      await running
      return samples
    }
  }
}

function joinOracleObservations(samples, oracleSamples, startedAt, finishedAt) {
  const processes = processSnapshot()
  const phaseOracleSamples = oracleSamples.filter(
    (sample) => sample.receivedAt >= startedAt - 100 && sample.receivedAt <= finishedAt + 100
  )
  return samples
    .filter((sample) => sample.windowState?.visible && sample.windowState?.contentBounds)
    .map((sample) => {
      const oracleSample = nearestSample(phaseOracleSamples, sample.at)
      const oracleObserved = Boolean(
        oracleSample && Math.abs(oracleSample.receivedAt - sample.at) <= 120
      )
      return {
        at: sample.at,
        hostKind: sample.status.nativePreviewHostKind ?? null,
        expectedBounds: sample.windowState.contentBounds,
        processes,
        oracleObserved,
        pixel: oracleObserved ? (oracleSample.pixel ?? null) : null,
        windows: oracleObserved ? oracleSample.windows : []
      }
    })
}

function nearestSample(samples, at) {
  let nearest = null
  let distance = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    const candidateDistance = Math.abs(sample.receivedAt - at)
    if (candidateDistance < distance) {
      nearest = sample
      distance = candidateDistance
    }
  }
  return nearest
}

async function waitForNativeSurface(smoke, { mode } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  let lastWindow = null
  while (Date.now() < deadline) {
    ;[lastStatus, lastWindow] = await Promise.all([
      smokeCommand(smoke, 'native-preview-surface-status'),
      smokeCommand(smoke, 'preview-window-state')
    ])
    if (
      nativeIdentityFailures('wait', lastStatus).length === 0 &&
      lastWindow.open === true &&
      lastWindow.visible === true &&
      lastWindow.nativeOwnsPlacement === true &&
      (!mode || lastWindow.mode === mode)
    ) {
      return { status: lastStatus, window: lastWindow }
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for live native CAMetalLayer. Status=${JSON.stringify(lastStatus)} window=${JSON.stringify(lastWindow)}`
  )
}

async function waitForDeviceSources(connection, screenSourceId, cameraId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const [screenStatus, cameraStatus] = await Promise.all([
      request(connection, timeoutMs, 'preview.screen.status'),
      request(connection, timeoutMs, 'preview.camera.status')
    ])
    last = { screenStatus, cameraStatus }
    if (
      screenStatus?.state === 'live' &&
      screenStatus.sourceId === screenSourceId &&
      ((screenStatus.framesCaptured ?? 0) > 0 || screenStatus.sequence != null) &&
      cameraStatus?.state === 'live' &&
      cameraStatus.cameraId === cameraId &&
      ((cameraStatus.framesCaptured ?? 0) > 0 || cameraStatus.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for real preview sources: ${JSON.stringify(last)}`)
}

async function dismissLaunchDialogs(smoke) {
  const result = await smokeCommand(smoke, 'eval-js', {
    code: `
      for (let i = 0; i < 25; i++) {
        const scrim = document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')
        if (!scrim) return { dismissed: true }
        document.querySelectorAll('[data-slot="dialog-close"]').forEach((button) => button.click())
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(100)
      }
      return { dismissed: false }
    `
  })
  if (result.result?.dismissed !== true) {
    throw new Error(`Could not dismiss launch dialogs: ${JSON.stringify(result)}`)
  }
}

function smokeCommand(smoke, command, params = {}, requestTimeoutMs = Math.min(timeoutMs, 15000)) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCommand, rejectCommand) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${smoke.capability}`,
          connection: 'close'
        },
        timeout: requestTimeoutMs
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
            if (res.statusCode !== 200 || payload.error || payload.ok === false) {
              rejectCommand(
                new Error(
                  `${command} failed (${res.statusCode}): ${payload.error ?? data.slice(0, 400)}`
                )
              )
              return
            }
            resolveCommand(payload.result ?? payload)
          } catch (error) {
            rejectCommand(new Error(`${command} returned invalid JSON: ${error.message}`))
          }
        })
      }
    )
    req.on('timeout', () =>
      req.destroy(new Error(`${command} timed out after ${requestTimeoutMs}ms`))
    )
    req.on('error', rejectCommand)
    req.write(body)
    req.end()
  })
}

async function startCgWindowOracle(directory, { pixelCapture = false, expectedWindowPid } = {}) {
  const expectedPid = Number.isSafeInteger(expectedWindowPid) ? expectedWindowPid : -1
  const sourcePath = join(directory, 'cg-window-oracle.swift')
  const source = pixelCapture
    ? `
import CoreGraphics
import Foundation
import ScreenCaptureKit
import AppKit

_ = NSApplication.shared

func number(_ value: Any?) -> Double {
  if let number = value as? NSNumber { return number.doubleValue }
  return -1
}

func windowPayload() -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  return list.enumerated().map { order, window in
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return [
      "order": order,
      "id": Int(number(window[kCGWindowNumber as String])),
      "pid": Int(number(window[kCGWindowOwnerPID as String])),
      "owner": window[kCGWindowOwnerName as String] as? String ?? "",
      "name": window[kCGWindowName as String] as? String ?? "",
      "layer": Int(number(window[kCGWindowLayer as String])),
      "alpha": number(window[kCGWindowAlpha as String]),
      "x": number(bounds["X"]),
      "y": number(bounds["Y"]),
      "width": number(bounds["Width"]),
      "height": number(bounds["Height"])
    ]
  }
}

func pixelMetrics(_ image: CGImage) -> [String: Any]? {
  let width = image.width
  let height = image.height
  guard width > 1, height > 1 else { return nil }
  let bytesPerRow = width * 4
  var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
  let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(
      data: bytes.baseAddress,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  guard rendered else { return nil }

  // Exclude the 28pt drag bar and outer antialiasing. The remaining samples
  // are the native video region whose dark-base flash this gate prevents.
  let minY = max(0, Int(Double(height) * 0.08))
  let maxY = max(minY + 1, Int(Double(height) * 0.96))
  var sampleCount = 0
  var lumaSum = 0.0
  var nonDark = 0
  var blankBase = 0
  for y in stride(from: minY, to: maxY, by: 4) {
    for x in stride(from: 0, to: width, by: 4) {
      let offset = y * bytesPerRow + x * 4
      let red = Double(pixels[offset])
      let green = Double(pixels[offset + 1])
      let blue = Double(pixels[offset + 2])
      let luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
      sampleCount += 1
      lumaSum += luma
      if luma >= 24 { nonDark += 1 }
      if abs(red - 13) <= 4 && abs(green - 13) <= 4 && abs(blue - 15) <= 4 {
        blankBase += 1
      }
    }
  }
  guard sampleCount > 0 else { return nil }
  return [
    "sampleCount": sampleCount,
    "meanLuma": lumaSum / Double(sampleCount),
    "nonDarkFraction": Double(nonDark) / Double(sampleCount),
    "blankBaseFraction": Double(blankBase) / Double(sampleCount)
  ]
}

var previewWindow: SCWindow? = nil
while true {
  var pixel: [String: Any]? = nil
  var pixelError: String? = nil
  do {
    if previewWindow == nil {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      previewWindow = content.windows.first { window in
        let title = window.title ?? ""
        let owner = window.owningApplication?.applicationName ?? ""
        return title == "Videorc Preview" &&
          window.owningApplication?.processID == ${expectedPid} &&
          (owner.localizedCaseInsensitiveContains("Electron") ||
            owner.localizedCaseInsensitiveContains("Videorc"))
      }
    }
    if let window = previewWindow {
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let config = SCStreamConfiguration()
      let sourceWidth = max(1.0, Double(window.frame.width))
      let sourceHeight = max(1.0, Double(window.frame.height))
      let captureScale = min(
        1.0,
        min(
          Double(${profile.pixelOracle.maxWidth}) / sourceWidth,
          Double(${profile.pixelOracle.maxHeight}) / sourceHeight
        )
      )
      config.width = max(1, Int(sourceWidth * captureScale))
      config.height = max(1, Int(sourceHeight * captureScale))
      config.showsCursor = false
      let image: CGImage = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: config
      )
      pixel = pixelMetrics(image)
    }
  } catch {
    pixelError = String(describing: error)
    previewWindow = nil
  }

  var payload: [String: Any] = [
    "uptimeNs": DispatchTime.now().uptimeNanoseconds,
    "windows": windowPayload()
  ]
  if let pixel { payload["pixel"] = pixel }
  if let pixelError { payload["pixelError"] = pixelError }
  let data = try! JSONSerialization.data(withJSONObject: payload)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
  try await Task.sleep(nanoseconds: ${profile.pixelOracle.sampleIntervalMs * 1_000_000})
}
`
    : `
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double {
  if let number = value as? NSNumber { return number.doubleValue }
  return -1
}

while true {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  var windows: [[String: Any]] = []
  for (order, window) in list.enumerated() {
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    windows.append([
      "order": order,
      "id": Int(number(window[kCGWindowNumber as String])),
      "pid": Int(number(window[kCGWindowOwnerPID as String])),
      "owner": window[kCGWindowOwnerName as String] as? String ?? "",
      "name": window[kCGWindowName as String] as? String ?? "",
      "layer": Int(number(window[kCGWindowLayer as String])),
      "alpha": number(window[kCGWindowAlpha as String]),
      "x": number(bounds["X"]),
      "y": number(bounds["Y"]),
      "width": number(bounds["Width"]),
      "height": number(bounds["Height"])
    ])
  }
  let payload: [String: Any] = [
    "uptimeNs": DispatchTime.now().uptimeNanoseconds,
    "windows": windows
  ]
  let data = try! JSONSerialization.data(withJSONObject: payload)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
  Thread.sleep(forTimeInterval: 0.016)
}
`
  writeFileSync(sourcePath, source)
  const child = spawn('swift', [sourcePath], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const samples = []
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n')
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (!line.trim()) continue
      try {
        samples.push({ ...JSON.parse(line), receivedAt: Date.now() })
      } catch {
        stderr += `invalid CGWindow JSON: ${line.slice(0, 200)}\n`
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  return {
    child,
    samples,
    get stderr() {
      return stderr
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveStop) => child.once('exit', resolveStop)),
        sleep(2000).then(() => child.kill('SIGKILL'))
      ])
    }
  }
}

async function waitForCgHost(windowOracle, smoke) {
  const deadline = Date.now() + 60000
  let lastReceivedAt = -1
  let consecutiveReadySamples = 0
  while (Date.now() < deadline) {
    const status = await smokeCommand(smoke, 'native-preview-surface-status')
    const latest = windowOracle.samples.at(-1)
    if (latest && latest.receivedAt !== lastReceivedAt) {
      lastReceivedAt = latest.receivedAt
      const ready = cgOraclePreviewReady(latest, {
        hostKind: status.nativePreviewHostKind,
        expectedWindowPid: thresholds.expectedWindowPid,
        requirePixels: thresholds.requirePixelOracle
      })
      consecutiveReadySamples = ready ? consecutiveReadySamples + 1 : 0
      if (consecutiveReadySamples >= 2) {
        return
      }
    }
    if (windowOracle.child.exitCode !== null || windowOracle.child.signalCode !== null) {
      throw new Error(`CGWindow oracle exited early: ${windowOracle.stderr.slice(0, 1000)}`)
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for ${thresholds.expectedHostKind} in persistent CGWindow oracle: ${windowOracle.stderr.slice(0, 1000)}`
  )
}

function processSnapshot() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
    timeout: 10000
  })
  if (result.status !== 0) return []
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]
    }))
}

function requestFailureMessages(label, settled) {
  return settled
    .map((result, index) =>
      result.status === 'rejected'
        ? `${label} update ${index + 1} failed: ${result.reason?.message ?? result.reason}`
        : null
    )
    .filter(Boolean)
}

function expectedKindsForPreset(preset) {
  if (preset === 'camera-only') return ['camera']
  if (preset === 'screen-only') return [expectedScreenSceneKind]
  return ['camera', expectedScreenSceneKind].sort()
}

function deviceVideo() {
  return {
    preset: 'custom',
    width: 640,
    height: 360,
    fps: 30,
    bitrateKbps: 2000
  }
}

function deviceLayout(layoutPreset) {
  return {
    layoutPreset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
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

async function analyzeDeviceRecordingArtifact(outputPath, requestedRecordingMs) {
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(`Device interaction recording output is missing: ${outputPath ?? 'none'}`)
  }
  const bytes = statSync(outputPath).size
  if (bytes <= 0) {
    throw new Error(`Device interaction recording output is empty: ${outputPath}`)
  }
  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: deviceVideo().fps,
    expectAudio: false,
    gates: {
      requireMotion: false,
      avSyncTargetMs: Number.POSITIVE_INFINITY,
      avSyncHardFailMs: Number.POSITIVE_INFINITY
    }
  })
  const reports = writeReports(quality)
  if (!quality.verdict.pass) {
    throw new Error(
      `Device interaction recording analyzer failed: ${quality.verdict.failures.join('; ')} (report: ${reports.mdPath})`
    )
  }
  const minimumSeconds = Math.max(2, requestedRecordingMs / 1000 - 8)
  if ((quality.metrics.durationSeconds ?? 0) < minimumSeconds) {
    throw new Error(
      `Device interaction recording duration ${quality.metrics.durationSeconds ?? 'unknown'}s is below ${minimumSeconds}s.`
    )
  }
  console.log(
    `Device interaction recording PASS: ${outputPath} (${bytes} bytes, ${quality.metrics.durationSeconds}s, report: ${reports.mdPath})`
  )
  return {
    outputPath,
    bytes,
    durationSeconds: quality.metrics.durationSeconds,
    reportPath: reports.mdPath,
    verdict: quality.verdict
  }
}

function prefixFailures(label, failures) {
  return failures.map((failure) => `${label}: ${failure}`)
}

function printPhaseSummary(label, phase) {
  const continuity = phase.continuity
  const cgWindow = phase.cgWindow
  const measurement = phase.measurement
  console.log(
    `${label}: ${phase.transitionCount ?? phase.movement?.positionUpdates + phase.movement?.burstUpdates ?? 0} interactions, ` +
      `${continuity?.sampleCount ?? 0} status samples, max stall ${format(continuity?.maxFrameStallMs)}ms, ` +
      `dropped +${format(continuity?.droppedFrameDelta)}, CG max offset ${format(cgWindow?.maxSurfaceOffsetPx)}px` +
      (measurement
        ? `, ${format(measurement.measuredFps)}fps / interval p95 ${format(measurement.intervalP95Ms)}ms`
        : '')
  )
}

function writeEvidence() {
  if (!outputDirectory) return
  try {
    writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
    if (oracle?.samples) {
      writeFileSync(
        join(outputDirectory, 'cg-window-samples.jsonl'),
        oracle.samples.map((sample) => JSON.stringify(sample)).join('\n')
      )
    }
  } catch {
    // Do not hide the original gate result behind best-effort evidence writing.
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) ? value : fallback
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function format(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}

function unique(values) {
  return [...new Set(values)]
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
