import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  WINDOWS_STREAM_PERFORMANCE_THRESHOLDS,
  WINDOWS_STREAM_PERFORMANCE_TIMING,
  WINDOWS_STREAM_D3D11_PREVIEW,
  WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS,
  WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS,
  WINDOWS_CAPTURE_PROTECTION_MARKERS,
  attachWindowsStreamNaturalFallbackPolicy,
  buildWindowsD3d11StreamCalibrations,
  evaluateWindowsCaptureProtectionPlacement,
  evaluateWindowsCaptureProtectionEvidence,
  evaluateWindowsStreamAggregate,
  evaluateWindowsStreamResourceBudget,
  evaluateWindowsStreamRun,
  formatWindowsStreamPerformanceMatrix,
  loadWindowsStreamPerformanceBudget,
  measureWindowsCaptureProtectionMarkerPixels,
  parseWindowsStreamPerformanceArgs,
  parseWindowsStreamDisplayBounds,
  redactWindowsStreamSecrets,
  receiverBitrateEvidence,
  resolveWindowsStreamPathEvidence,
  summarizeWindowsStreamBmpBudgetMetrics,
  summarizeWindowsStreamBudgetProcessTelemetry,
  windowsStreamCalibrationMetrics,
  windowsStreamCandidateIdentity,
  summarizeWindowsStreamDiagnosticSamples,
  isWindowsD3d11StreamPerformanceBudget,
  normalizeWindowsNaturalFallbackCalibration,
  windowsStreamSecretLeaks,
  windowsStreamCaptureProtectionPlacement
} from './lib/windows-stream-performance.mjs'

const options = parseWindowsStreamPerformanceArgs(process.argv.slice(2))

// `--list` is intentionally an import-light, zero-launch operation. In
// particular, it works on non-Windows planning hosts without loading ws or any
// packaged-app helper.
if (options.list) {
  console.log(formatWindowsStreamPerformanceMatrix())
  process.exit(0)
}

if (options.deriveNaturalFallbackPolicy) {
  try {
    const result = await deriveNaturalFallbackPolicy(options)
    console.log(
      `windows-stream-performance: natural fallback policy attached to DRAFT budget (${result.budgetPath})`
    )
    console.log('Independent human review is still required before activation.')
    process.exit(0)
  } catch (error) {
    console.error(`windows-stream-performance: FAIL: ${message(error)}`)
    process.exit(1)
  }
}

const outputDirectory = windowsStreamOutputDirectory(options)
if (existsSync(join(outputDirectory, 'aggregate.json'))) {
  console.error(
    `windows-stream-performance: FAIL: immutable evidence already exists at ${join(outputDirectory, 'aggregate.json')}`
  )
  process.exit(1)
}
await mkdir(outputDirectory, { recursive: true })

const aggregatePath = join(outputDirectory, 'aggregate.json')
const aggregate = {
  schemaVersion: 1,
  kind: 'videorc.windows-stream-performance-aggregate',
  status: 'running',
  mode: options.mode,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  timing: WINDOWS_STREAM_PERFORMANCE_TIMING,
  scenarios: options.scenarios.map((scenario) => scenario.id),
  repetitions: Object.fromEntries(
    options.scenarios.map((scenario) => [
      scenario.id,
      options.scenarioId ? options.repetitions : scenario.repetitions
    ])
  ),
  candidate: null,
  runs: [],
  error: null
}
await writeJson(aggregatePath, aggregate)

if (process.platform !== 'win32' || process.arch !== 'x64') {
  await finishBlocked(
    `The packaged stream-performance gate requires a physical Windows 11 x64 host; current host is ${process.platform}/${process.arch}.`
  )
  process.exit(2)
}

let runtime
try {
  runtime = await loadRuntime()
  const spawnSpec = runtime.performanceAppSpawnSpec({
    ...process.env,
    VIDEORC_PERF_APP_EXECUTABLE:
      process.env.VIDEORC_PERF_APP_EXECUTABLE ?? process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE
  })
  if (!spawnSpec || !existsSync(spawnSpec.command)) {
    throw new BlockedRunError(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE (or VIDEORC_PERF_APP_EXECUTABLE) must point to the installed packaged Videorc.exe.'
    )
  }
  const candidateSha256 = await runtime.sha256File(spawnSpec.command)
  const sourceCommit = process.env.VIDEORC_RELEASE_SOURCE_COMMIT?.trim()
  const installerSha256 = process.env.VIDEORC_RELEASE_EXPECTED_SHA256?.trim()
  const expectedCandidateSha256 = process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256?.trim()
  const candidatePayload = await runtime.packagedAppPayloadIdentity(spawnSpec.command, {
    osPlatform: 'win32'
  })
  const expectedPayloadSha256 =
    process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256?.trim()
  const requiresPremiumProfile =
    options.preparePremiumProfile ||
    options.scenarios.some((scenario) => scenario.fps === 60 || scenario.provider === 'youtube')
  const requiresStep6Identity =
    options.mode === 'gate' ||
    options.profiles.length > 0 ||
    options.d3d11 ||
    options.requireD3d11 ||
    options.expectFallback === 'natural'
  if (
    requiresStep6Identity &&
    (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(installerSha256 ?? ''))
  ) {
    throw new BlockedRunError(
      'VIDEORC_RELEASE_SOURCE_COMMIT and VIDEORC_RELEASE_EXPECTED_SHA256 are required lowercase final-candidate identities.'
    )
  }
  if (
    (options.mode === 'gate' || requiresPremiumProfile) &&
    !/^[a-f0-9]{64}$/.test(expectedCandidateSha256 ?? '')
  ) {
    throw new BlockedRunError(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 is required for protected/provider-aware runs.'
    )
  }
  if (expectedCandidateSha256 && candidateSha256 !== expectedCandidateSha256) {
    throw new BlockedRunError(
      'The installed Videorc.exe digest does not match the verified acceptance candidate.'
    )
  }
  if (
    (options.mode === 'gate' || requiresPremiumProfile) &&
    !/^[a-f0-9]{64}$/.test(expectedPayloadSha256 ?? '')
  ) {
    throw new BlockedRunError(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256 is required to bind Videorc.exe, app.asar, the backend, FFmpeg, and FFprobe to one installed candidate.'
    )
  }
  if (
    !candidatePayload.sha256 ||
    (expectedPayloadSha256 && candidatePayload.sha256 !== expectedPayloadSha256)
  ) {
    throw new BlockedRunError(
      'The installed packaged-app payload digest does not match the verified acceptance candidate.'
    )
  }
  if (options.mode === 'gate' && !windowsHardwareClass()) {
    throw new BlockedRunError(
      'VIDEORC_WINDOWS_HARDWARE_CLASS is required to bind the protected hardware budget.'
    )
  }
  if (
    options.expectFallback === 'natural' &&
    windowsHardwareClass() !== WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS
  ) {
    throw new BlockedRunError(
      `Natural fallback evidence requires VIDEORC_WINDOWS_HARDWARE_CLASS=${WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS}.`
    )
  }

  const acceptanceEnvironment = acceptanceAppEnvironment(outputDirectory)
  if (requiresPremiumProfile) {
    try {
      runtime.windowsAcceptanceProfileDir({
        env: acceptanceEnvironment,
        platform: 'win32'
      })
    } catch (error) {
      throw new BlockedRunError(
        `Provider-aware evidence requires the owner-controlled preserved Premium profile: ${message(error)}`
      )
    }
  }

  aggregate.candidate = {
    sourceCommit: sourceCommit ?? null,
    installerSha256: installerSha256 ?? null,
    executablePath: spawnSpec.command,
    sha256: candidateSha256,
    packagePayload: candidatePayload
  }
  aggregate.hardwareClass = windowsHardwareClass()
  aggregate.profileClass = process.env.VIDEORC_PERF_PROFILE_CLASS?.trim() || 'release'
  aggregate.operatingSystem = {
    platform: process.platform,
    arch: process.arch,
    release: release()
  }
  aggregate.pathEvidence = resolveWindowsStreamPathEvidence(options)
  await writeJson(aggregatePath, aggregate)

  if (options.preparePremiumProfile) {
    const preparation = await preparePremiumProfile({
      runtime,
      spawnSpec,
      candidateSha256,
      candidatePayload,
      acceptanceEnvironment,
      outputDirectory
    })
    aggregate.status = 'prepared'
    aggregate.finishedAt = new Date().toISOString()
    aggregate.preparation = preparation
    await writeJson(aggregatePath, aggregate)
    console.log(
      `windows-stream-performance: Premium profile prepared (${preparation.attestationPath})`
    )
    process.exit(0)
  }

  const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
  requireCommand(ffmpegPath, ['-version'], 'FFmpeg')
  requireCommand(ffprobePath, ['-version'], 'FFprobe')

  const browser = runtime.resolveScreenMotionStimulusBrowser({ platform: 'win32' })
  const avBrowser = runtime.resolveAvSyncStimulusBrowser({ platform: 'win32' })
  if (!browser.executablePath || !avBrowser.executablePath) {
    throw new BlockedRunError(
      `A visible Edge/Chrome stimulus browser is required. Checked: ${[
        ...(browser.searchedPaths ?? []),
        ...(avBrowser.searchedPaths ?? [])
      ].join(', ')}`
    )
  }

  let stopMatrix = false
  for (const scenario of options.scenarios) {
    const scenarioRepetitions = options.scenarioId ? options.repetitions : scenario.repetitions
    for (let repetition = 1; repetition <= scenarioRepetitions; repetition += 1) {
      console.log(
        `windows-stream-performance: ${scenario.id} repetition ${repetition}/${scenarioRepetitions}`
      )
      try {
        const run = await runScenario({
          runtime,
          // Normalize the implicit automatic path once at the aggregate
          // boundary. Preview-open default runs must exercise the same
          // physical OS-input probe as explicitly forced D3D11 runs; passing
          // the raw CLI options here left `pathEvidence` undefined and
          // incorrectly emitted NOT_REQUIRED evidence.
          options: { ...options, pathEvidence: aggregate.pathEvidence },
          scenario,
          repetition,
          outputDirectory,
          spawnSpec,
          candidateSha256,
          candidatePayload,
          sourceCommit,
          installerSha256,
          ffmpegPath,
          ffprobePath,
          acceptanceEnvironment
        })
        aggregate.runs.push(run)
        await writeJson(aggregatePath, aggregate)
        if (run.verdict === 'FAIL' || run.verdict === 'BLOCKED') {
          stopMatrix = true
          break
        }
      } catch (error) {
        const blocked = error instanceof BlockedRunError
        const runDirectory = join(
          outputDirectory,
          scenario.id,
          `run-${String(repetition).padStart(2, '0')}`
        )
        await mkdir(runDirectory, { recursive: true })
        const run = {
          scenarioId: scenario.id,
          repetition,
          verdict: blocked ? 'BLOCKED' : 'FAIL',
          failures: blocked ? [] : [message(error)],
          blockers: blocked ? [message(error)] : [],
          evidencePath: null
        }
        await writeJson(join(runDirectory, 'run-error.json'), {
          ...run,
          error: { name: error?.name ?? 'Error', message: message(error) }
        })
        aggregate.runs.push(run)
        await writeJson(aggregatePath, aggregate)
        stopMatrix = true
        break
      }
    }
    if (stopMatrix) break
  }

  const result = evaluateWindowsStreamAggregate({
    mode: options.mode,
    runs: aggregate.runs,
    scenarios: options.scenarios
  })
  aggregate.status = aggregateStatus(result.verdict)
  aggregate.finishedAt = new Date().toISOString()
  aggregate.failures = result.failures
  aggregate.blockers = result.blockers
  aggregate.error =
    result.verdict === 'BLOCKED'
      ? {
          message: result.blockers.join('\n') || 'Windows stream performance evidence was blocked.'
        }
      : result.verdict === 'FAIL'
        ? { message: result.failures.join('\n') || 'Windows stream performance evidence failed.' }
        : null
  if (
    result.verdict === 'CALIBRATION' &&
    (options.d3d11 || options.requireD3d11) &&
    options.expectFallback !== 'natural'
  ) {
    aggregate.d3d11Calibrations = buildWindowsD3d11StreamCalibrations({
      aggregate,
      aggregatePath
    })
  }
  await writeJson(aggregatePath, aggregate)
  console.log(`windows-stream-performance: ${result.verdict} (${aggregatePath})`)
  process.exit(result.verdict === 'FAIL' ? 1 : result.verdict === 'BLOCKED' ? 2 : 0)
} catch (error) {
  if (error instanceof BlockedRunError) {
    await finishBlocked(message(error))
    process.exit(2)
  }
  aggregate.status = 'failed'
  aggregate.finishedAt = new Date().toISOString()
  aggregate.error = { message: message(error) }
  await writeJson(aggregatePath, aggregate)
  console.error(`windows-stream-performance: FAIL: ${message(error)}`)
  process.exit(1)
}

async function runScenario({
  runtime,
  options,
  scenario,
  repetition,
  outputDirectory,
  spawnSpec,
  candidateSha256,
  candidatePayload,
  sourceCommit,
  installerSha256,
  ffmpegPath,
  ffprobePath,
  acceptanceEnvironment
}) {
  const runDirectory = join(
    outputDirectory,
    scenario.id,
    `run-${String(repetition).padStart(2, '0')}`
  )
  await mkdir(runDirectory, { recursive: true })
  const artifacts = {
    receiverStaging: join(runDirectory, 'receiver-measurement-plus-tail.flv'),
    receiverMedia: join(runDirectory, 'receiver.flv'),
    ffprobeJson: join(runDirectory, 'receiver.ffprobe.json'),
    framemd5: join(runDirectory, 'receiver.framemd5'),
    analyzerJson: join(runDirectory, 'receiver.quality.json'),
    supportBundle: join(runDirectory, 'support-bundle.json'),
    processSamples: join(runDirectory, 'process-samples.json'),
    gpuSamples: join(runDirectory, 'gpu-samples.json'),
    captureProtection: join(runDirectory, 'capture-protection.json'),
    settings: join(runDirectory, 'settings.json'),
    verdict: join(runDirectory, 'verdict.json'),
    diagnostics: join(runDirectory, 'diagnostic-samples.json'),
    entitlement: join(runDirectory, 'entitlement-attestation.json')
  }

  const capability = randomBytes(32).toString('base64url')
  const appEnvironment = {
    ...acceptanceEnvironment,
    VIDEORC_SMOKE_OUTPUT_DIR: runDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_PACKAGED_SMOKE_TEST: '1',
    VIDEORC_SMOKE_COMMAND_CAPABILITY: capability,
    VIDEORC_NOTES_SMOKE_MARKER: '1',
    ...(options.requireBridge ? { VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE: '1' } : {}),
    ...(options.d3d11 ? { VIDEORC_WINDOWS_D3D11_MEDIA: '1' } : {}),
    ...(options.requireD3d11 ? { VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1' } : {}),
    ...(options.bridge === 'mf'
      ? {
          VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts'
        }
      : options.bridge === 'raw'
        ? { VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'raw-yuv420p' }
        : {})
  }
  const appDirectories = runtime.resolveSmokeAppDirs({
    env: appEnvironment,
    platform: 'win32'
  })
  const processLedgerPaths = runtime.ownedProcessLedgerPaths({
    appDataDir: appDirectories.appDataDir,
    userDataDir: appDirectories.userDataDir,
    workspaceRoot: dirname(spawnSpec.command),
    appName: 'Videorc'
  })

  let launched = null
  let smoke = null
  let ws = null
  let listener = null
  let motionStimulus = null
  let avStimulus = null
  let motionStimulusProcessIdentities = []
  let avStimulusProcessIdentities = []
  let motionStimulusLaunchCensus = null
  let avStimulusLaunchCensus = null
  let stimulusMeasurementStartCensuses = null
  let stimulusMeasurementEndCensuses = null
  let stimulusLiveness = {
    verdict: 'BLOCKED',
    blockers: ['controlled stimulus process liveness was not measured']
  }
  let motionStimulusTeardown = {
    state: 'skipped',
    forced: false,
    treeExited: true
  }
  let avStimulusTeardown = {
    state: 'skipped',
    forced: false,
    treeExited: true
  }
  let stimulusFinalCensuses = null
  let sessionActive = false
  let previewStarted = false
  let teardown = null
  let stoppedSession = null
  let listenerExit = null
  let processTelemetry = null
  let processTelemetryReadiness = {
    verdict: 'BLOCKED',
    blockers: ['process telemetry collection did not start']
  }
  let gpuCollection = null
  let gpuEvidence = {
    verdict: 'BLOCKED',
    blockers: ['GPU collection did not start'],
    summary: null
  }
  let diagnosticSamples = []
  let diagnosticTimeline = null
  let diagnosticTimelineReadiness = {
    verdict: 'BLOCKED',
    blockers: ['diagnostic timeline collection did not start']
  }
  let processCensus = null
  let pinnedProcessIdentities = []
  let launchProcessCensus = null
  let preQuitProcessCensus = null
  let quittingProcessCensus = null
  let postGracefulProcessCensus = null
  let finalProcessCensus = null
  let gracefulQuit = {
    requested: false,
    exited: false,
    exit: null,
    error: null
  }
  let processTimeline = null
  let processTimelineError = null
  let selectedScreen = null
  let selectedMicrophone = null
  let rendererRuntimeInfo = null
  let entitlement = null
  let capturePlacement = null
  let capturePlacementReadiness = null
  let supportBundlePresent = false
  let exportedSupportPath = null
  let localRecordingPath = null
  const streamSnapshots = []
  let streamTargetPoller = null
  let streamTargetPolling = null
  let streamMeasurementClock = null
  let streamLifecycle = {
    verdict: 'BLOCKED',
    failures: [],
    blockers: ['stream lifecycle measurement did not start']
  }
  let rtmpSecrets = []
  const writeRunJson = (path, value) =>
    writeJson(path, redactWindowsStreamSecrets(value, rtmpSecrets))

  try {
    launched = await runtime.launchDevApp({
      spawnSpec,
      timeoutMs: timeoutMs(),
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      packagedSmokeCommandCapability: capability,
      env: appEnvironment
    })
    ws = await runtime.connectBackend(launched.connections['backend-ready'], timeoutMs())
    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.event === 'stream.targets') {
          streamSnapshots.push({
            receivedAtMs: Date.now(),
            source: 'event',
            snapshot: payload.payload
          })
        }
      } catch {
        // Only structured target-state events are retained.
      }
    })

    const health = await runtime.request(ws, timeoutMs(), 'health.ping', {
      ffmpegPath
    })
    if (!health?.ffmpeg?.available) {
      throw new BlockedRunError(
        health?.ffmpeg?.message ?? 'The packaged FFmpeg health check did not pass.'
      )
    }
    const deviceList = await runtime.request(ws, timeoutMs(), 'devices.list', {
      ffmpegPath
    })
    const dxgiCandidates = runtime
      .nativeWindowsScreenCandidates(deviceList?.devices ?? [])
      .filter((device) => /^screen:dxgi:[0-9a-f]{16}:\d+$/i.test(device.id))
    const requestedDisplayId = process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID?.trim()
    if (!requestedDisplayId) {
      throw new BlockedRunError(
        'VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID is required to bind window placement and pixel evidence to one DXGI output.'
      )
    }
    selectedScreen = requestedDisplayId
      ? dxgiCandidates.find((device) => device.id === requestedDisplayId)
      : dxgiCandidates[0]
    if (!selectedScreen) {
      throw new BlockedRunError(
        requestedDisplayId
          ? `The required Windows DXGI display ${requestedDisplayId} was unavailable.`
          : 'No real Windows DXGI Desktop Duplication source was available; gdigrab cannot produce protected evidence.'
      )
    }
    let displayBounds
    try {
      displayBounds = parseWindowsStreamDisplayBounds(
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS
      )
    } catch (error) {
      throw new BlockedRunError(message(error))
    }
    if (
      selectedScreen.width !== displayBounds.width ||
      selectedScreen.height !== displayBounds.height
    ) {
      throw new BlockedRunError(
        `VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS ${displayBounds.width}x${displayBounds.height} did not match ${selectedScreen.id} ${selectedScreen.width ?? 'unknown'}x${selectedScreen.height ?? 'unknown'}.`
      )
    }
    capturePlacement = windowsStreamCaptureProtectionPlacement(displayBounds)
    selectedMicrophone = selectMicrophone(
      deviceList?.devices ?? [],
      process.env.VIDEORC_WINDOWS_STREAM_MICROPHONE_ID
    )
    if (!options.videoOnly && !selectedMicrophone) {
      throw new BlockedRunError(
        'No available physical Windows microphone was found for the audible A/V fixture.'
      )
    }

    entitlement = await attestEntitlement({
      runtime,
      ws,
      scenario,
      candidateSha256,
      path: artifacts.entitlement
    })

    const sources = {
      screenId: selectedScreen.id,
      microphoneId: selectedMicrophone?.id ?? null,
      testPattern: false
    }
    const video = {
      preset: scenario.videoPreset ?? 'custom',
      width: scenario.width,
      height: scenario.height,
      fps: scenario.fps,
      bitrateKbps: scenario.bitrateKbps
    }
    const preview = await runtime.request(ws, timeoutMs(), 'preview.screen.start', {
      sources,
      layout: screenOnlyLayout(),
      video,
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (preview?.state !== 'live') {
      throw new BlockedRunError(
        `DXGI preview did not become live: ${preview?.message ?? preview?.state ?? 'unknown'}`
      )
    }
    previewStarted = true
    await waitForPreviewFrame(runtime, ws, selectedScreen.id)

    const smoke = launched.connections['preview-motion-ready']
    const runtimeInspection = await runtime.requestSmokeCommand(
      smoke,
      'inspect-native-preview-runtime',
      {},
      { timeoutMs: timeoutMs() }
    )
    rendererRuntimeInfo = runtimeInspection?.runtimeInfo ?? null
    if (!rendererRuntimeInfo) {
      throw new BlockedRunError(
        'The packaged renderer did not provide runtime identity for Windows support-bundle verification.'
      )
    }
    await runtime.requestSmokeCommand(
      smoke,
      scenario.previewOpen ? 'preview-window-open' : 'preview-window-close',
      {},
      { timeoutMs: timeoutMs() }
    )

    // Keep both controlled pages visible. The A/V fixture itself contains
    // continuous per-frame motion, so the receiver analyzer remains the
    // authority even when window manager placement clips one page.
    try {
      motionStimulus = await runtime.launchScreenMotionStimulus({
        screenSource: selectedScreen,
        browserPath: process.env.VIDEORC_STIMULUS_BROWSER,
        ...capturePlacement.motion,
        verifyVisible: false,
        outputDirectory: runDirectory,
        ffmpegPath
      })
      ;({ census: motionStimulusLaunchCensus, identities: motionStimulusProcessIdentities } =
        await pinWindowsProcessTree(runtime, {
          rootPid: motionStimulus.child?.pid,
          label: 'screen-motion stimulus'
        }))
      if (!options.videoOnly) {
        avStimulus = await runtime.launchAvSyncStimulus({
          screenSource: selectedScreen,
          browserPath: process.env.VIDEORC_STIMULUS_BROWSER,
          ...capturePlacement.av
        })
        ;({ census: avStimulusLaunchCensus, identities: avStimulusProcessIdentities } =
          await pinWindowsProcessTree(runtime, {
            rootPid: avStimulus.child?.pid,
            label: 'A/V-sync stimulus'
          }))
      }
      await runtime.requestSmokeCommand(
        smoke,
        'main-window-set-bounds',
        capturePlacement.windows.main,
        { timeoutMs: timeoutMs() }
      )
      await runtime.requestSmokeCommand(smoke, 'main-window-focus', {}, { timeoutMs: timeoutMs() })
      await runtime.requestSmokeCommand(
        smoke,
        'notes-window-open',
        {},
        {
          timeoutMs: timeoutMs()
        }
      )
      await runtime.requestSmokeCommand(
        smoke,
        'notes-window-set-bounds',
        capturePlacement.windows.notes,
        { timeoutMs: timeoutMs() }
      )
      await runtime.requestSmokeCommand(
        smoke,
        'comments-window-open',
        {},
        {
          timeoutMs: timeoutMs()
        }
      )
      await runtime.requestSmokeCommand(
        smoke,
        'comments-window-set-bounds',
        capturePlacement.windows.comments,
        { timeoutMs: timeoutMs() }
      )
      await runtime.requestSmokeCommand(
        smoke,
        'captions-window-open',
        {},
        {
          timeoutMs: timeoutMs()
        }
      )
      await runtime.requestSmokeCommand(
        smoke,
        'captions-window-set-bounds',
        capturePlacement.windows.captions,
        { timeoutMs: timeoutMs() }
      )
      if (scenario.previewOpen) {
        await runtime.requestSmokeCommand(
          smoke,
          'preview-window-set-bounds',
          capturePlacement.windows.preview,
          { timeoutMs: timeoutMs() }
        )
      }
      capturePlacementReadiness = await waitForCaptureProtectionPlacement({
        runtime,
        smoke,
        placement: capturePlacement,
        previewOpen: scenario.previewOpen
      })
    } catch (error) {
      throw new BlockedRunError(
        `The controlled visible motion/A/V stimulus could not start: ${message(error)}`
      )
    }

    const target = await localRtmpTarget(artifacts.receiverMedia)
    rtmpSecrets = [target.streamKey, target.listenerUrl]
    listener = spawnReceiver({
      ffmpegPath,
      target,
      warmupSeconds: scenario.warmupMs / 1000,
      measurementSeconds: scenario.measurementMs / 1000
    })
    await ensureListenerStarted(listener, rtmpSecrets)

    const started = await runtime.request(
      ws,
      timeoutMs(),
      'session.start',
      streamSessionParams({
        scenario,
        sources,
        video,
        target,
        videoOnly: options.videoOnly
      })
    )
    if (started?.state !== 'recording') {
      throw new Error(
        `session.start returned ${started?.state ?? 'no state'}: ${started?.message ?? ''}`
      )
    }
    sessionActive = true
    localRecordingPath = started.outputPath ?? null

    const expectedGpuSamples = Math.ceil(scenario.measurementMs / scenario.sampleIntervalMs)
    const [processResult, diagnosticResult, gpuResult, timelineResult] = await Promise.allSettled([
      runtime.collectWindowsProcessTreeTelemetry({
        rootPid: launched.process.pid,
        warmupMs: scenario.warmupMs,
        measurementMs: scenario.measurementMs,
        intervalMs: scenario.sampleIntervalMs
      }),
      collectDiagnostics({
        runtime,
        ws,
        warmupMs: scenario.warmupMs,
        measurementMs: scenario.measurementMs,
        intervalMs: scenario.sampleIntervalMs
      }),
      collectGpuSamples({
        runtime,
        warmupMs: scenario.warmupMs,
        intervalMs: scenario.sampleIntervalMs,
        expectedSamples: expectedGpuSamples
      }),
      collectOwnedProcessTimeline({
        runtime,
        rootPid: launched.process.pid,
        warmupMs: scenario.warmupMs,
        measurementMs: scenario.measurementMs,
        intervalMs: scenario.sampleIntervalMs
      })
    ])
    if (processResult.status === 'fulfilled') processTelemetry = processResult.value
    if (diagnosticResult.status === 'fulfilled') {
      diagnosticSamples = diagnosticResult.value
    }
    if (gpuResult.status === 'fulfilled') gpuCollection = gpuResult.value
    if (timelineResult.status === 'fulfilled') {
      processTimeline = timelineResult.value
    } else {
      processTimelineError = message(timelineResult.reason)
    }

    processCensus = await runtime.collectProcessCensus({
      ledgerPaths: processLedgerPaths,
      rootPid: launched.process.pid,
      extraPids: pinnedProcessIdentities.map((identity) => identity.pid)
    })
    pinnedProcessIdentities = mergeProcessIdentities(
      pinnedProcessIdentities,
      processIdentitiesFromCensus(processCensus)
    )
    if (
      pinnedProcessIdentities.length === 0 ||
      pinnedProcessIdentities.some(
        (identity) =>
          !Number.isInteger(identity.pid) ||
          identity.pid <= 1 ||
          !nonEmptyString(identity.creationDate)
      )
    ) {
      processTelemetryReadiness = {
        verdict: 'BLOCKED',
        blockers: [
          ...processTelemetryReadiness.blockers,
          'every app-owned process identity must include PID and Windows CreationDate'
        ]
      }
    }
    const finalProcessIds = new Set(
      (processCensus?.processGroupRows ?? processCensus?.processRows ?? [])
        .map((row) => row.pid)
        .filter((pid) => Number.isInteger(pid))
    )
    const gpuAttribution = runtime.attributeWindowsGpuSamplesToProcessTimeline({
      samples: gpuCollection?.samples ?? [],
      timeline: processTimeline ?? {
        expectedSamples: expectedGpuSamples,
        intervalMs: scenario.sampleIntervalMs,
        observations: []
      },
      parseInstance: runtime.parseWindowsGpuCounterInstance
    })
    const processIds = new Set([...gpuAttribution.processIds, ...finalProcessIds])
    const gpuSummary = runtime.summarizeWindowsGpuSamples({
      samples: gpuAttribution.samples,
      expectedSamples: expectedGpuSamples,
      processIds,
      adapterLuid: adapterLuidFromDxgiId(selectedScreen.id)
    })
    gpuEvidence = {
      ...gpuSummary,
      verdict:
        gpuAttribution.verdict === 'PASS' && gpuSummary.verdict === 'PASS' ? 'PASS' : 'BLOCKED',
      blockers: [...gpuAttribution.blockers, ...gpuSummary.blockers]
    }
    await writeRunJson(artifacts.gpuSamples, {
      commandExitCode: gpuCollection?.exitCode ?? null,
      commandError: gpuCollection?.error ?? null,
      attribution: {
        ...gpuAttribution.timeline,
        processIds: gpuAttribution.processIds,
        collectionError: processTimelineError
      },
      samples: gpuAttribution.samples,
      ...gpuEvidence
    })

    const appExitedDuringMeasurement = launched.process.exitCode !== null
    stoppedSession = await runtime.request(ws, timeoutMs(), 'session.stop')
    sessionActive = false
    localRecordingPath = stoppedSession?.outputPath ?? localRecordingPath
    listenerExit = await waitForChildExit(listener.child, 15_000)
    listener = null

    let exportedSupportPath = null
    try {
      const support = await runtime.request(ws, timeoutMs(), 'diagnostics.supportBundle.export', {
        ffmpegPath,
        appVersion: rendererRuntimeInfo.version,
        rendererDiagnostics: {
          runtimeInfo: rendererRuntimeInfo,
          windowsStreamPerformance: {
            scenarioId: scenario.id,
            repetition,
            candidateSha256
          }
        }
      })
      if (support?.path && existsSync(support.path)) {
        exportedSupportPath = support.path
        const supportRaw = await readFile(support.path, 'utf8')
        const leakedSecrets = windowsStreamSecretLeaks(supportRaw, rtmpSecrets)
        if (leakedSecrets.length > 0) {
          throw new BlockedRunError(
            'The Windows acceptance support bundle contained an exact generated RTMP secret.'
          )
        }
        const supportDocument = JSON.parse(supportRaw)
        const supportValidation = runtime.validateSupportBundle(supportDocument, {
          windowsAcceptance: true
        })
        if (!supportValidation.ok) {
          throw new BlockedRunError(
            `The Windows acceptance support bundle failed validation: ${supportValidation.failures.join('; ')}`
          )
        }
        await copyFile(support.path, artifacts.supportBundle)
        supportBundlePresent = true
      }
    } catch {
      if (exportedSupportPath) {
        await unlink(exportedSupportPath).catch(() => undefined)
      }
      supportBundlePresent = false
    }

    await writeRunJson(artifacts.processSamples, {
      telemetry: processTelemetry,
      census: processCensus,
      timeline: processTimeline,
      timelineError: processTimelineError
    })
    await writeRunJson(artifacts.diagnostics, diagnosticSamples)
    await writeRunJson(artifacts.settings, {
      scenario,
      bridge: options.bridge,
      requireBridge: options.requireBridge,
      d3d11: options.d3d11,
      requireD3d11: options.requireD3d11,
      profiles: options.profiles,
      pathEvidence: options.pathEvidence,
      expectFallback: options.expectFallback,
      videoOnly: options.videoOnly,
      source: {
        screen: safeDevice(selectedScreen),
        microphone: safeDevice(selectedMicrophone),
        displayTopology,
        displayBinding
      },
      captureProtectionPlacement: capturePlacement,
      captureProtectionPlacementReadiness: capturePlacementReadiness,
      previewOpen: scenario.previewOpen,
      rtmp: {
        serverUrl: redactWindowsStreamSecrets(target.serverUrl, rtmpSecrets),
        streamKeyPresent: true
      },
      entitlement: entitlement
        ? {
            tier: entitlement.tier,
            source: entitlement.source,
            streamingMaxFps: entitlement.streamingMaxFps,
            attestationSha256: entitlement.attestationSha256
          }
        : null
    })

    // Preserve this before teardown; the result participates in network health.
    listenerExit = {
      ...listenerExit,
      appExitedDuringMeasurement
    }
  } catch (error) {
    throw redactedRunError(error, rtmpSecrets)
  } finally {
    if (streamTargetPoller && !streamTargetPolling) {
      streamTargetPolling = await streamTargetPoller
        .stop()
        .catch((error) => ({ verdict: 'BLOCKED', blockers: [message(error)] }))
    }
    if (ws && sessionActive) {
      await runtime.request(ws, 15_000, 'session.stop').catch(() => undefined)
    }
    if (ws && previewStarted) {
      await runtime.request(ws, 10_000, 'preview.camera.stop').catch(() => undefined)
      await runtime.request(ws, 10_000, 'preview.screen.stop').catch(() => undefined)
    }
    if (avStimulus) {
      try {
        avStimulusTeardown = await runtime.stopAvSyncStimulus(avStimulus)
      } catch (error) {
        avStimulusTeardown = {
          state: 'leaked',
          forced: true,
          treeExited: false,
          error: message(error)
        }
      }
    }
    if (motionStimulus) {
      try {
        motionStimulusTeardown = await runtime.stopScreenMotionStimulus(motionStimulus)
      } catch (error) {
        motionStimulusTeardown = {
          state: 'leaked',
          forced: true,
          treeExited: false,
          error: message(error)
        }
      }
    }
    stimulusFinalCensuses = await collectKnownStimulusProcessCensuses(runtime, {
      motion: {
        rootPid: motionStimulus?.child?.pid,
        identities: motionStimulusProcessIdentities
      },
      av: options.videoOnly
        ? null
        : {
            rootPid: avStimulus?.child?.pid,
            identities: avStimulusProcessIdentities
          }
    }).catch((error) => ({ error: message(error) }))
    if (
      stimulusFinalCensuses?.motion &&
      !stimulusFinalCensuses.motion.error &&
      matchingProcessIdentities(
        motionStimulusProcessIdentities,
        ownedCensusRows(stimulusFinalCensuses.motion)
      ).length > 0
    ) {
      motionStimulusTeardown = {
        ...motionStimulusTeardown,
        state: 'leaked',
        treeExited: false
      }
    }
    if (
      stimulusFinalCensuses?.av &&
      !stimulusFinalCensuses.av.error &&
      matchingProcessIdentities(
        avStimulusProcessIdentities,
        ownedCensusRows(stimulusFinalCensuses.av)
      ).length > 0
    ) {
      avStimulusTeardown = {
        ...avStimulusTeardown,
        state: 'leaked',
        treeExited: false
      }
    }
    if (listener) {
      listener.child.kill('SIGTERM')
      await waitForChildExit(listener.child, 5_000).catch(() => undefined)
    }
    if (exportedSupportPath) {
      try {
        await scrubAndDeleteSupportBundle(exportedSupportPath)
        exportedSupportPath = null
      } catch (error) {
        throw new BlockedRunError(
          `The exported support bundle could not be securely removed: ${message(error)}`
        )
      }
    }
    if (launched) {
      try {
        preQuitProcessCensus = await runtime.collectProcessCensus({
          ledgerPaths: processLedgerPaths,
          rootPid: launched.process.pid,
          extraPids: pinnedProcessIdentities.map((identity) => identity.pid)
        })
        pinnedProcessIdentities = mergeProcessIdentities(
          pinnedProcessIdentities,
          processIdentitiesFromCensus(preQuitProcessCensus)
        )
      } catch (error) {
        preQuitProcessCensus = { error: message(error), processRows: [] }
      }
    }
    if (
      launched &&
      smoke &&
      launched.process.exitCode === null &&
      launched.process.signalCode === null
    ) {
      gracefulQuit.requested = true
      try {
        await runtime.requestSmokeCommand(smoke, 'app-quit', {}, { timeoutMs: 10_000 })
      } catch (error) {
        gracefulQuit.error = message(error)
      }
      try {
        quittingProcessCensus = await runtime.collectProcessCensus({
          ledgerPaths: processLedgerPaths,
          rootPid:
            launched.process.exitCode === null && launched.process.signalCode === null
              ? launched.process.pid
              : undefined,
          extraPids: pinnedProcessIdentities.map((identity) => identity.pid)
        })
        pinnedProcessIdentities = mergeProcessIdentities(
          pinnedProcessIdentities,
          processIdentitiesFromCensus(quittingProcessCensus)
        )
      } catch (error) {
        quittingProcessCensus = { error: message(error), processRows: [] }
      }
      try {
        gracefulQuit.exit = await waitForChildExit(launched.process, 15_000)
        gracefulQuit.exited = gracefulQuit.exit?.code === 0 && gracefulQuit.exit?.signal === null
        if (!gracefulQuit.exited && !gracefulQuit.error) {
          gracefulQuit.error =
            `Packaged app did not exit cleanly after app-quit ` +
            `(code=${gracefulQuit.exit?.code ?? 'null'}, signal=${gracefulQuit.exit?.signal ?? 'null'}).`
        }
      } catch (error) {
        gracefulQuit.error ??= message(error)
      }
    } else if (launched) {
      gracefulQuit.error =
        'The packaged app exited before the harness could request a graceful app-quit.'
    }
    if (pinnedProcessIdentities.length > 0) {
      postGracefulProcessCensus = await runtime
        .collectProcessCensus({
          ledgerPaths: processLedgerPaths,
          extraPids: pinnedProcessIdentities.map((identity) => identity.pid)
        })
        .catch((error) => ({ error: message(error), processRows: [] }))
      const survivors = matchingProcessIdentities(
        pinnedProcessIdentities,
        ownedCensusRows(postGracefulProcessCensus)
      )
      gracefulQuit.descendantsExited =
        !postGracefulProcessCensus?.error &&
        (postGracefulProcessCensus?.aliveRecords?.length ?? 0) === 0 &&
        survivors.length === 0
      gracefulQuit.survivors = survivors
    } else {
      gracefulQuit.descendantsExited = false
      gracefulQuit.survivors = []
    }
    if (ws) ws.close()
    if (launched) {
      try {
        teardown = await launched.stop()
      } catch (error) {
        teardown = { state: 'leaked', forced: true, error: message(error) }
      }
    }
    if (pinnedProcessIdentities.length > 0) {
      finalProcessCensus = await runtime
        .collectProcessCensus({
          ledgerPaths: processLedgerPaths,
          extraPids: pinnedProcessIdentities.map((identity) => identity.pid)
        })
        .catch((error) => ({ error: message(error), processRows: [] }))
    }
  }

  if (!existsSync(artifacts.receiverMedia) || statSync(artifacts.receiverMedia).size <= 0) {
    throw new Error('The local RTMP receiver artifact was missing or empty.')
  }
  if (scenario.recordEnabled) {
    if (!localRecordingPath || !existsSync(localRecordingPath)) {
      throw new Error('The simultaneous local recording artifact was missing.')
    }
    await copyFile(
      localRecordingPath,
      join(runDirectory, `local-recording${extension(localRecordingPath)}`)
    )
  }

  const quality = await runtime.analyzeRecording(artifacts.receiverMedia, {
    ffmpegPath,
    ffprobePath,
    intendedFps: scenario.fps,
    expectAudio: !options.videoOnly,
    gates: {
      requireMotion: true,
      maxFreezeMs: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumFreezeMs,
      maxRepeatedFrameRun: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumRepeatedFrameRun,
      maxDuplicatePtsCount: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumDuplicatePtsCount,
      maxDuplicatePtsRun: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumDuplicatePtsRun,
      frameCountTolerance: WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.frameCountToleranceRatio,
      requireColorTags: true,
      keyframeMaxIntervalSeconds:
        WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumKeyframeIntervalSeconds,
      avSyncTargetMs: Number.POSITIVE_INFINITY,
      avSyncHardFailMs: Number.POSITIVE_INFINITY
    }
  })
  const qualityPaths = runtime.writeReports(quality, { outDir: runDirectory })
  if (qualityPaths.jsonPath !== artifacts.analyzerJson) {
    await copyFile(qualityPaths.jsonPath, artifacts.analyzerJson)
  }

  const ffprobe = runCaptured(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_packets',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    artifacts.receiverMedia
  ])
  await writeFile(artifacts.ffprobeJson, ffprobe.stdout)
  const probeDocument = JSON.parse(ffprobe.stdout)
  const framemd5 = runCaptured(ffmpegPath, [
    '-v',
    'error',
    '-i',
    artifacts.receiverMedia,
    '-map',
    '0:v:0',
    '-f',
    'framemd5',
    '-'
  ])
  await writeFile(artifacts.framemd5, framemd5.stdout)

  const protectedRoles = [
    'main',
    'comments',
    'notes',
    'captions',
    ...(scenario.previewOpen ? ['preview', 'proof-surface'] : [])
  ]
  const roleEvidence = Object.fromEntries(
    protectedRoles.map((role) => {
      const crop = capturePlacement.crops[role]
      const rgb = runCapturedBuffer(ffmpegPath, [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        artifacts.receiverMedia,
        '-an',
        '-vf',
        `fps=0.5,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=320:180:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        'pipe:1'
      ])
      return [
        role,
        {
          crop,
          markerMetrics: measureWindowsCaptureProtectionMarkerPixels(rgb, {
            marker: WINDOWS_CAPTURE_PROTECTION_MARKERS[role],
            width: 320,
            height: 180
          }),
          stimulusVisibility: runtime.stimulusTemporalVisibilityFromRgb(rgb, {
            width: 32,
            height: 18,
            expectedFrames: quality.metrics.observedFrames,
            minimumVisibleFrameRatio: 0.95,
            minimumColorPixels: 5,
            minimumDistinctColors: 7
          })
        }
      ]
    })
  )
  const captureProtection = evaluateWindowsCaptureProtectionEvidence({
    roles: roleEvidence,
    requiredRoles: protectedRoles
  })
  await writeJson(artifacts.captureProtection, captureProtection)

  const bitrate = receiverBitrateEvidence(probeDocument.packets, {
    durationSeconds: quality.metrics.durationSeconds
  })
  let avSync = {
    required: !options.videoOnly,
    measured: false,
    medianAbsoluteOffsetMs: null,
    maxAbsoluteOffsetMs: null,
    projectedDriftMsPer30Min: null,
    driftBinding: false
  }
  if (!options.videoOnly) {
    const measurement = await runtime.measureAvSync(artifacts.receiverMedia, {
      ffmpegPath,
      gates: { targetMs: 60, hardFailMs: 150, requireTarget: true }
    })
    const drift = runtime.fitOffsetDrift(measurement.pairs, {
      minPairs: 5,
      minSpanSec: 30
    })
    avSync = {
      required: true,
      measured:
        Number.isFinite(measurement.medianOffsetMs) && Number.isFinite(measurement.maxAbsOffsetMs),
      medianAbsoluteOffsetMs: Number.isFinite(measurement.medianOffsetMs)
        ? Math.abs(measurement.medianOffsetMs)
        : null,
      maxAbsoluteOffsetMs: measurement.maxAbsOffsetMs,
      projectedDriftMsPer30Min: runtime.driftMsPer30Min(drift),
      driftBinding: drift !== null,
      flashCount: measurement.flashCount,
      clickCount: measurement.clickCount,
      pairs: measurement.pairs
    }
  }

  const pipeline = {
    ...summarizeWindowsStreamDiagnosticSamples(diagnosticSamples, {
      fallbackAcknowledged:
        options.expectFallback === 'software-open-h264' ||
        options.expectFallback === 'natural' ||
        process.env.VIDEORC_WINDOWS_STREAM_ACKNOWLEDGE_FALLBACK === '1',
      recordEnabled: scenario.recordEnabled
    }),
    requireMediaFoundation: options.requireBridge,
    requireD3d11: options.requireD3d11,
    expectedD3d11Path: options.pathEvidence,
    expectedFallback: options.expectFallback,
    diagnosticTimelineVerdict: diagnosticTimelineReadiness.verdict,
    diagnosticTimelineBlockers: diagnosticTimelineReadiness.blockers
  }
  const reconnects = streamSnapshots.filter((event) =>
    (event?.snapshot?.targets ?? []).some((target) =>
      ['reconnecting', 'retrying'].includes(target?.state ?? target?.status)
    )
  ).length

  const budget = await evaluateBudget({
    options,
    scenario,
    candidateSha256,
    candidatePayloadSha256: candidatePayload.sha256,
    processTelemetry,
    gpuEvidence,
    teardown,
    diagnosticSamples,
    processTelemetryReadiness,
    teardownClean
  })
  const evidence = {
    schemaVersion: 1,
    kind: 'videorc.windows-stream-performance-run',
    mode: options.mode,
    scenarioId: scenario.id,
    repetition,
    candidate: {
      executablePath: spawnSpec.command,
      sha256: candidateSha256,
      packagePayload: candidatePayload
    },
    timing: {
      warmupMs: scenario.warmupMs,
      measurementMs: scenario.measurementMs,
      sampleIntervalMs: scenario.sampleIntervalMs
    },
    stimulus: {
      motion: {
        started: Boolean(motionStimulus),
        browserPath: motionStimulus?.browserPath ?? null,
        browserSource: motionStimulus?.browserSource ?? null
      },
      audio: {
        required: !options.videoOnly,
        started: options.videoOnly ? false : Boolean(avStimulus),
        browserPath: avStimulus?.browserPath ?? null,
        browserSource: avStimulus?.browserSource ?? null
      }
    },
    artifacts: {
      receiverMedia: artifacts.receiverMedia,
      ffprobeJson: artifacts.ffprobeJson,
      framemd5: artifacts.framemd5,
      analyzerJson: artifacts.analyzerJson,
      supportBundle: supportBundlePresent ? artifacts.supportBundle : null,
      processSamples: artifacts.processSamples,
      gpuSamples: artifacts.gpuSamples,
      captureProtection: artifacts.captureProtection,
      settings: artifacts.settings,
      verdict: artifacts.verdict
    },
    media: {
      width: quality.metrics.width,
      height: quality.metrics.height,
      fps: quality.metrics.avgFps ?? quality.metrics.nominalFps ?? quality.metrics.observedFps,
      durationSeconds: quality.metrics.durationSeconds,
      frameCount: quality.metrics.observedFrames,
      maxFrameGapMs: quality.metrics.maxFrameGapMs,
      longestCorroboratedFreezeMs: quality.metrics.longestCorroboratedFreezeMs,
      maxRepeatedFrameRun: quality.metrics.maxRepeatedFrameRun,
      duplicatePtsCount: quality.metrics.duplicatePtsCount,
      maxDuplicatePtsRun: quality.metrics.maxDuplicatePtsRun,
      maxKeyframeIntervalSeconds: quality.metrics.maxKeyframeIntervalSeconds,
      colorPrimaries: quality.metrics.colorPrimaries,
      colorTransfer: quality.metrics.colorTransfer,
      colorSpace: quality.metrics.colorSpace,
      colorRange: quality.metrics.colorRange
    },
    pipeline,
    network: {
      targetBitrateKbps: scenario.bitrateKbps,
      measuredBitrateKbps: bitrate.measuredBitrateKbps,
      rollingBitrateKbps: bitrate.rollingBitrateKbps,
      bitrateEvidence: bitrate,
      reconnects,
      lifecycle: streamLifecycle,
      measurementClock: streamMeasurementClock,
      unexpectedExit:
        listenerExit?.code !== 0 ||
        listenerExit?.signal != null ||
        listenerExit?.appExitedDuringMeasurement === true ||
        streamLifecycle.verdict !== 'PASS'
    },
    avSync,
    process: {
      telemetryCollected: processTelemetry !== null,
      telemetryVerdict: processTelemetryReadiness.verdict,
      telemetryBlockers: processTelemetryReadiness.blockers,
      gpuVerdict: gpuEvidence.verdict,
      gpu: gpuEvidence,
      teardownClean,
      leakDetected: finalProcessSurvivors.length > 0 || Boolean(finalProcessCensus?.error),
      gracefulQuit,
      teardown,
      finalProcessSurvivors
    },
    captureProtection,
    budget
  }
  const result = evaluateWindowsStreamRun(evidence)
  await writeRunJson(artifacts.verdict, { evidence, result })
  return {
    scenarioId: scenario.id,
    repetition,
    verdict: result.verdict,
    failures: result.failures,
    blockers: result.blockers,
    evidencePath: artifacts.verdict
  }
}

async function loadRuntime() {
  const [
    appLauncher,
    analyzer,
    avSync,
    avStimulus,
    motionStimulus,
    processEndurance,
    processCensus,
    smokeCommands,
    nativeScreen,
    streamAvSync,
    releaseHelpers,
    gpuSampler,
    supportBundleVerifier,
    performanceSampling,
    performanceContract,
    windowZOrder,
    session
  ] = await Promise.all([
    import('./lib/app-launcher.mjs'),
    import('./lib/recording-analyzer.mjs'),
    import('./lib/av-sync.mjs'),
    import('./lib/av-sync-stimulus.mjs'),
    import('./lib/screen-motion-stimulus.mjs'),
    import('./lib/process-endurance.mjs'),
    import('./lib/process-census.mjs'),
    import('./lib/smoke-command-client.mjs'),
    import('./lib/windows-native-screen-gates.mjs'),
    import('./lib/stream-av-sync.mjs'),
    import('./lib/windows-alpha-release.mjs'),
    import('./lib/windows-gpu-sampler.mjs'),
    import('./lib/support-bundle-verifier.mjs'),
    import('./lib/performance-sampling-schedule.mjs'),
    import('./lib/performance-contract.mjs'),
    import('./lib/windows-window-z-order.mjs'),
    import('./smoke-recording-session.mjs')
  ])
  return {
    ...appLauncher,
    ...analyzer,
    ...avSync,
    ...avStimulus,
    ...motionStimulus,
    ...processEndurance,
    ...processCensus,
    ...smokeCommands,
    ...nativeScreen,
    ...streamAvSync,
    ...releaseHelpers,
    ...gpuSampler,
    ...supportBundleVerifier,
    ...performanceSampling,
    ...performanceContract,
    ...windowZOrder,
    ...session
  }
}

async function preparePremiumProfile({
  runtime,
  spawnSpec,
  candidateSha256,
  acceptanceEnvironment,
  outputDirectory
}) {
  const attestationPath = join(outputDirectory, 'premium-profile-attestation.json')
  const launched = await runtime.launchDevApp({
    spawnSpec,
    timeoutMs: timeoutMs(),
    requiredMarkers: ['backend-ready'],
    env: {
      ...acceptanceEnvironment,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    }
  })
  let ws = null
  try {
    ws = await runtime.connectBackend(launched.connections['backend-ready'], timeoutMs())
    const preparationTimeoutMs = Number(
      process.env.VIDEORC_WINDOWS_PREMIUM_PROFILE_TIMEOUT_MS ?? 15 * 60_000
    )
    const deadline = Date.now() + preparationTimeoutMs
    console.log(
      'Complete the normal Videorc sign-in in the installed app. Waiting for a live Premium/Developer entitlement (maxFps >= 60).'
    )
    let current = null
    while (Date.now() < deadline) {
      try {
        await runtime.request(ws, 30_000, 'entitlements.refresh')
        current = await runtime.request(ws, 30_000, 'entitlements.get')
      } catch {
        current = null
      }
      if (
        ['premium', 'developer'].includes(current?.tier) &&
        current?.limits?.streaming?.maxFps >= 60
      ) {
        const fields = {
          candidateSha256,
          tier: current.tier,
          streamingMaxFps: current.limits.streaming.maxFps,
          verifiedAt: new Date().toISOString()
        }
        const attestation = {
          ...fields,
          attestationSha256: createHash('sha256').update(JSON.stringify(fields)).digest('hex')
        }
        await writeJson(attestationPath, attestation)
        return {
          attestationPath,
          candidateSha256,
          tier: attestation.tier,
          streamingMaxFps: attestation.streamingMaxFps,
          verifiedAt: attestation.verifiedAt,
          attestationSha256: attestation.attestationSha256
        }
      }
      await sleep(2_000)
    }
    throw new BlockedRunError(
      `Interactive Premium profile preparation timed out after ${preparationTimeoutMs}ms without a live Premium/Developer 60fps entitlement.`
    )
  } finally {
    if (ws) ws.close()
    await launched.stop().catch(() => undefined)
  }
}

async function attestEntitlement({ runtime, ws, scenario, candidateSha256, path }) {
  await runtime.request(ws, timeoutMs(), 'entitlements.refresh')
  const current = await runtime.request(ws, timeoutMs(), 'entitlements.get')
  const streamingMaxFps = current?.limits?.streaming?.maxFps
  const premiumRequired = scenario.fps === 60 || scenario.provider === 'youtube'
  if (
    premiumRequired &&
    (!['premium', 'developer'].includes(current?.tier) || streamingMaxFps < scenario.fps)
  ) {
    throw new BlockedRunError(
      `The preserved acceptance profile did not expose the provider-aware profile (tier=${current?.tier ?? 'missing'}, maxFps=${streamingMaxFps ?? 'missing'}).`
    )
  }
  const fields = {
    tier: current?.tier ?? null,
    source: current?.source ?? null,
    streamingMaxFps: streamingMaxFps ?? null,
    checkedAt: current?.checkedAt ?? null,
    expiresAt: current?.expiresAt ?? null,
    candidateSha256
  }
  const attestation = {
    ...fields,
    attestationSha256: createHash('sha256').update(JSON.stringify(fields)).digest('hex')
  }
  await writeJson(path, attestation)
  return attestation
}

async function evaluateBudget({
  options,
  scenario,
  candidateSha256,
  processTelemetry,
  gpuEvidence,
  teardown,
  diagnosticSamples,
  processTelemetryReadiness,
  teardownClean
}) {
  if (options.mode !== 'gate') {
    return {
      required: false,
      active: false,
      applicable: false,
      failures: []
    }
  }
  try {
    const loaded = await loadWindowsStreamPerformanceBudget({
      path: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PATH,
      profileId: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PROFILE,
      context: {
        scenario: scenario.id,
        hardwareClass: windowsHardwareClass(),
        profileClass: process.env.VIDEORC_PERF_PROFILE_CLASS?.trim() || 'release',
        buildMode: 'packaged',
        operatingSystem: {
          platform: process.platform,
          arch: process.arch,
          release: release()
        },
        timing: {
          warmupMs: scenario.warmupMs,
          measurementMs: scenario.measurementMs,
          intervalMs: scenario.sampleIntervalMs
        }
      }
    })
    if (
      loaded.document.candidateSha256.toLocaleLowerCase('en-US') !== candidateSha256 ||
      loaded.profile.candidateSha256.toLocaleLowerCase('en-US') !== candidateSha256 ||
      processTelemetryReadiness?.verdict !== 'PASS' ||
      teardownClean !== true
    ) {
      return {
        required: true,
        active: true,
        applicable: false,
        profileId: loaded.profile.id,
        failures: []
      }
    }
    return {
      required: true,
      active: true,
      applicable: true,
      profileId: loaded.profile.id,
      path: loaded.path,
      failures: evaluateWindowsStreamResourceBudget(loaded.profile, {
        processTree: summarizeWindowsStreamBudgetProcessTelemetry(processTelemetry),
        gpu: gpuEvidence,
        bmp: summarizeWindowsStreamBmpBudgetMetrics(diagnosticSamples, scenario.previewOpen),
        teardownClean
      })
    }
  } catch (error) {
    return {
      required: true,
      active: false,
      applicable: false,
      failures: [],
      blocker: message(error)
    }
  }
}

async function deriveNaturalFallbackPolicy(deriveOptions) {
  const root = resolve(deriveOptions.fallbackCalibrations)
  await assertUnaliasedPath(root, { directory: true, label: 'fallback calibration root' })
  const aggregateArtifact = await readExactJsonArtifact(join(root, 'aggregate.json'), {
    label: 'fallback aggregate'
  })
  const expectedCandidateSha256 = aggregateArtifact.document?.candidate?.sha256
  if (
    !/^[a-f0-9]{64}$/.test(expectedCandidateSha256 ?? '') ||
    basename(root).toLocaleLowerCase('en-US') !== expectedCandidateSha256
  ) {
    throw new Error(
      'Fallback calibration candidate-root digest did not match aggregate candidate.sha256.'
    )
  }
  const reports = []
  for (const scenarioId of WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      reports.push(
        await readExactJsonArtifact(
          join(root, scenarioId, `run-${String(repetition).padStart(2, '0')}`, 'verdict.json'),
          { label: `${scenarioId}#${repetition} verdict` }
        )
      )
    }
  }
  const calibration = normalizeWindowsNaturalFallbackCalibration({
    aggregate: aggregateArtifact.document,
    aggregatePath: aggregateArtifact.path,
    aggregateSha256: aggregateArtifact.sha256,
    reports
  })
  const budgetPath = resolve(deriveOptions.budget)
  const budgetArtifact = await readExactJsonArtifact(budgetPath, {
    label: 'D3D11 draft budget'
  })
  if (!isWindowsD3d11StreamPerformanceBudget(budgetArtifact.document)) {
    throw new Error('The budget was not a videorc.windows-d3d11-performance-budget.')
  }
  const updated = attachWindowsStreamNaturalFallbackPolicy({
    document: budgetArtifact.document,
    calibration
  })
  if (updated.status !== 'draft' || updated.activation?.allowed !== false) {
    throw new Error('Natural fallback derivation attempted to self-activate the budget.')
  }

  await assertArtifactsUnchanged([aggregateArtifact, ...reports])
  const currentBudget = await readFile(budgetPath)
  if (sha256Bytes(currentBudget) !== budgetArtifact.sha256) {
    throw new Error('The draft budget changed during derivation; refusing to overwrite it.')
  }
  await atomicReplaceJson(budgetPath, updated, budgetArtifact.sha256)
  return { budgetPath, calibration }
}

async function readExactJsonArtifact(path, { label }) {
  const absolutePath = resolve(path)
  await assertUnaliasedPath(absolutePath, { directory: false, label })
  const bytes = await readFile(absolutePath)
  let document
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${message(error)}`)
  }
  return {
    path: absolutePath,
    sha256: sha256Bytes(bytes),
    bytes,
    document,
    label
  }
}

async function assertUnaliasedPath(path, { directory, label }) {
  const info = await lstat(path).catch((error) => {
    throw new Error(`${label} was missing: ${message(error)}`)
  })
  if (info.isSymbolicLink()) {
    throw new Error(`${label} may not be a symlink or alias.`)
  }
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${label} was not a ${directory ? 'directory' : 'regular file'}.`)
  }
}

async function assertArtifactsUnchanged(artifacts) {
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact.path)
    if (sha256Bytes(bytes) !== artifact.sha256) {
      throw new Error(`${artifact.label} changed during derivation.`)
    }
  }
}

async function atomicReplaceJson(path, document, expectedSha256) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
    const current = await readFile(path)
    if (sha256Bytes(current) !== expectedSha256) {
      throw new Error('The draft budget changed before the atomic replacement.')
    }
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function windowsStreamRunContext({ options, scenario }) {
  const natural = options.expectFallback === 'natural'
  const previewOpen = scenario.previewOpen === true
  return {
    scenario: scenario.id,
    hardwareClass: windowsHardwareClass(),
    profileClass: process.env.VIDEORC_PERF_PROFILE_CLASS?.trim() || 'release',
    buildMode: 'packaged',
    profile: scenario.fps === 60 ? '1080p60' : '1080p30',
    mediaPath: natural ? 'legacy-fallback' : 'd3d11-native',
    sourceComposition: scenario.sourceComposition,
    topology: scenario.topology,
    previewOpen,
    ...(natural
      ? { selectionMode: 'natural' }
      : previewOpen
        ? { preview: WINDOWS_STREAM_D3D11_PREVIEW }
        : {})
  }
}

function windowsPreviewProofSurfaceVerdict({
  expectedFallback,
  previewOpen,
  placementReadiness,
  pipeline
}) {
  if (placementReadiness?.verdict !== 'PASS') return 'BLOCKED'
  if (expectedFallback !== 'natural') {
    return pipeline?.d3d11?.state === 'live' ? 'PASS' : 'BLOCKED'
  }
  if (!previewOpen) return 'PASS'
  const evaluations = [
    placementReadiness.initial,
    ...(placementReadiness.timeline?.samples ?? []).map((sample) => sample?.evaluation),
    placementReadiness.final
  ]
  const proved = evaluations.every((evaluation) => {
    const preview = evaluation?.roles?.preview
    const surface = evaluation?.roles?.['proof-surface']
    const status = preview?.surfaceStatus
    return (
      evaluation?.verdict === 'PASS' &&
      surface?.exists === true &&
      surface?.visible === true &&
      status?.state === 'live' &&
      status?.transport === 'electron-proof-surface' &&
      status?.backing === 'electron-browser-window' &&
      status?.nativePreviewHostKind === 'electron-browser-window' &&
      status?.firstFrameContract === 'fallback' &&
      nonEmptyString(status?.firstFrameReason) &&
      status?.sourcePixelsPresent === true
    )
  })
  return proved ? 'PASS' : 'BLOCKED'
}

function candidateIdentityMatches(candidate, expected) {
  return (
    candidate?.sourceCommit === expected.sourceCommit &&
    candidate?.installerSha256 === expected.installerSha256 &&
    candidate?.executableSha256 === expected.executableSha256 &&
    candidate?.packagePayloadSha256 === expected.packagePayloadSha256
  )
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
}

function streamSessionParams({ scenario, sources, video, target, videoOnly }) {
  const timestamp = new Date().toISOString()
  const targetId = `local-${scenario.id}`
  return {
    sources,
    layout: layoutForScenario(scenario),
    output: {
      recordEnabled: scenario.recordEnabled,
      streamEnabled: true,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: target.serverUrl,
        streamKey: target.streamKey
      }
    },
    streaming: {
      enabled: true,
      mode: 'single',
      selectedTargetId: targetId,
      defaultOutputPreset: scenario.videoPreset ?? 'tutorial-1080p30',
      defaultBitrateKbps: scenario.bitrateKbps,
      enabledTargetIds: [targetId],
      targets: [
        {
          id: targetId,
          platform: scenario.provider ?? 'custom',
          label: 'Local protected RTMP receiver',
          enabled: true,
          serverUrl: target.serverUrl,
          urlMode: 'server-and-key',
          streamKey: target.streamKey,
          streamKeyPresent: true,
          authMode: 'manual-rtmp',
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: videoOnly,
      microphoneSyncOffsetMs: 0
    }
  }
}

function screenOnlyLayout() {
  return {
    layoutPreset: 'screen-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
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

function layoutForScenario(scenario) {
  return {
    ...screenOnlyLayout(),
    layoutPreset: scenario?.sourceComposition === 'screen-camera' ? 'screen-camera' : 'screen-only'
  }
}

async function localRtmpTarget(receiverPath) {
  const port = await freePort()
  const streamKey = randomBytes(24).toString('base64url')
  const serverUrl = `rtmp://127.0.0.1:${port}/live`
  return {
    port,
    streamKey,
    serverUrl,
    listenerUrl: `${serverUrl}/${streamKey}`,
    receiverPath
  }
}

function spawnReceiver({ ffmpegPath, target, warmupSeconds, measurementSeconds, tailSeconds = 5 }) {
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-stats_period',
      '0.25',
      '-progress',
      'pipe:2',
      '-listen',
      '1',
      '-i',
      target.listenerUrl,
      '-ss',
      String(warmupSeconds),
      '-t',
      String(measurementSeconds + tailSeconds),
      '-map',
      '0',
      '-c',
      'copy',
      '-flush_packets',
      '1',
      '-f',
      'flv',
      target.receiverPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  )
  let stderr = ''
  let pending = ''
  let measurementStart = null
  let resolveMeasurementStart
  let rejectMeasurementStart
  const measurementStarted = new Promise((resolveStart, rejectStart) => {
    resolveMeasurementStart = resolveStart
    rejectMeasurementStart = rejectStart
  })
  const progress = {}
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1)
      progress[key] = value
      if (
        key === 'progress' &&
        !measurementStart &&
        (Number(progress.frame) > 0 || Number(progress.total_size) > 13)
      ) {
        measurementStart = {
          startedAtMs: Date.now(),
          outTimeUs: Number(progress.out_time_us),
          frame: Number(progress.frame),
          totalSize: Number(progress.total_size)
        }
        resolveMeasurementStart(measurementStart)
      }
      if (key === 'progress') {
        for (const progressKey of Object.keys(progress)) delete progress[progressKey]
      }
    }
  })
  child.once('exit', (code, signal) => {
    if (!measurementStart) {
      rejectMeasurementStart(
        new Error(
          `The RTMP receiver exited before the measured output began (code=${code}, signal=${signal}).`
        )
      )
    }
  })
  return {
    child,
    stderr: () => stderr,
    measurementStart: () => measurementStart,
    waitForMeasurementStart: (timeout) =>
      promiseWithTimeout(
        measurementStarted,
        timeout,
        `The RTMP receiver did not reach its measured output after ${warmupSeconds}s of warm-up.`
      )
  }
}

function trimReceiverMeasurement({ ffmpegPath, inputPath, outputPath, measurementSeconds }) {
  runCaptured(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-t',
    String(measurementSeconds),
    '-map',
    '0',
    '-c',
    'copy',
    '-f',
    'flv',
    outputPath
  ])
}

async function ensureListenerStarted(listener, secrets) {
  await sleep(750)
  if (listener.child.exitCode !== null) {
    throw new BlockedRunError(
      redactWindowsStreamSecrets(
        `The local RTMP receiver exited before publishing: ${listener.stderr()}`,
        secrets
      )
    )
  }
}

function startStreamTargetSnapshotPoller({ runtime, ws, snapshots, intervalMs }) {
  const cadenceMs = Math.max(100, Math.min(500, Number(intervalMs) || 500))
  const observations = []
  const errors = []
  let stopRequested = false
  let wakeInterval = null
  let sampleChain = Promise.resolve(null)
  let stoppedResult = null

  const sampleOnce = async () => {
    const requestedAtMs = Date.now()
    try {
      const snapshot = await runtime.request(
        ws,
        Math.max(5_000, cadenceMs * 4),
        'stream.targets.snapshot',
        {}
      )
      const event = {
        requestedAtMs,
        receivedAtMs: Date.now(),
        source: 'rpc',
        snapshot
      }
      observations.push(event)
      snapshots.push(event)
      return event
    } catch (error) {
      const failure = {
        requestedAtMs,
        receivedAtMs: Date.now(),
        source: 'rpc-error',
        error: message(error)
      }
      errors.push(failure)
      snapshots.push(failure)
      return failure
    }
  }
  const sample = () => {
    sampleChain = sampleChain.then(sampleOnce, sampleOnce)
    return sampleChain
  }
  const loop = (async () => {
    while (!stopRequested) {
      await sample()
      if (stopRequested) break
      await new Promise((resolveWait) => {
        const timer = setTimeout(resolveWait, cadenceMs)
        wakeInterval = () => {
          clearTimeout(timer)
          resolveWait()
        }
      })
      wakeInterval = null
    }
    await sampleChain
  })()

  return {
    sample,
    async stop() {
      if (stoppedResult) return stoppedResult
      stopRequested = true
      wakeInterval?.()
      await loop
      const gaps = observations
        .slice(1)
        .map((event, index) => event.receivedAtMs - observations[index].receivedAtMs)
      const blockers = []
      if (observations.length === 0) {
        blockers.push('authoritative stream-target RPC returned no snapshots')
      }
      if (errors.length > 0) {
        blockers.push(`${errors.length} authoritative stream-target RPC request(s) failed`)
      }
      if (gaps.some((gap) => gap > cadenceMs + 250)) {
        blockers.push('authoritative stream-target RPC polling missed its bounded cadence')
      }
      stoppedResult = {
        verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
        blockers,
        cadenceMs,
        observations: observations.length,
        errors,
        maximumGapMs: gaps.length > 0 ? Math.max(...gaps) : 0
      }
      return stoppedResult
    }
  }
}

async function waitForStreamTargetLive({ snapshots, targetId, deadlineMs }) {
  const deadline = Date.now() + deadlineMs
  do {
    const event = [...snapshots]
      .reverse()
      .find(
        (candidate) =>
          candidate?.source === 'rpc' &&
          candidate?.snapshot?.targets?.some((target) => target?.targetId === targetId)
      )
    const target = event?.snapshot?.targets?.find((candidate) => candidate?.targetId === targetId)
    if (target?.state === 'live') return { receivedAtMs: event.receivedAtMs, target }
    if (['failed', 'stopped'].includes(target?.state)) {
      throw new BlockedRunError(
        `The selected local stream target entered ${target.state} before measurement: ${target.message ?? 'no message'}`
      )
    }
    await sleep(100)
  } while (Date.now() < deadline)
  throw new BlockedRunError('The selected local stream target was not confirmed live.')
}

async function waitForCaptureProtectionPlacement({
  runtime,
  smoke,
  placement,
  previewOpen,
  deadlineMs = 15_000
}) {
  const requiredRoles = [
    'main',
    'comments',
    'notes',
    'captions',
    ...(previewOpen ? ['preview', 'proof-surface'] : [])
  ]
  const deadline = Date.now() + deadlineMs
  let evaluation = null
  do {
    const [main, comments, notes, captions, preview] = await Promise.all([
      runtime.requestSmokeCommand(smoke, 'main-window-state', {}, { timeoutMs: timeoutMs() }),
      runtime.requestSmokeCommand(smoke, 'comments-window-state', {}, { timeoutMs: timeoutMs() }),
      runtime.requestSmokeCommand(smoke, 'notes-window-state', {}, { timeoutMs: timeoutMs() }),
      runtime.requestSmokeCommand(smoke, 'captions-window-state', {}, { timeoutMs: timeoutMs() }),
      previewOpen
        ? runtime.requestSmokeCommand(smoke, 'preview-window-state', {}, { timeoutMs: timeoutMs() })
        : Promise.resolve(null)
    ])
    evaluation = evaluateWindowsCaptureProtectionPlacement({
      placement,
      requiredRoles,
      states: {
        main,
        comments,
        notes,
        captions,
        ...(previewOpen
          ? {
              preview,
              'proof-surface': preview?.surface
            }
          : {})
      }
    })
    if (evaluation.verdict === 'PASS') return evaluation
    await sleep(100)
  } while (Date.now() < deadline)

  throw new BlockedRunError(
    `Protected-window placement was not ready: ${evaluation?.blockers?.join('; ') ?? 'no state evidence'}`
  )
}

async function collectDiagnostics({ runtime, ws, measurementMs, intervalMs }) {
  const collectSample = async () => {
    const requestedAtMs = Date.now()
    const [diagnostics, previewSurfaceStatus, streamTargetsSnapshot] = await Promise.all([
      runtime.request(ws, Math.max(5_000, intervalMs), 'diagnostics.stats'),
      runtime.request(ws, Math.max(5_000, intervalMs), 'preview.surface.status'),
      runtime.request(ws, Math.max(5_000, intervalMs), 'stream.targets.snapshot', {})
    ])
    return {
      ...diagnostics,
      previewSurfaceStatus,
      streamTargetsSnapshot,
      streamTargetsSnapshotRequestedAtMs: requestedAtMs,
      streamTargetsSnapshotObservedAtMs: Date.now()
    }
  }
  const scheduled = await runtime.collectPerformanceSamplesOnSchedule({
    measurementMs,
    intervalMs,
    collectSample
  })
  const measurementEndedAtMs = scheduled.measurementEndedAtMs
  const terminal = await collectSample()
  const terminalObservedAtMs = runtime.monotonicNowMs()
  return {
    timing: { measurementMs, intervalMs },
    sampling: {
      ...scheduled.evidence,
      observations: scheduled.sampleTimings
    },
    samples: scheduled.samples,
    terminal,
    terminalTiming: {
      measurementEndedAtMs,
      observedAtMs: terminalObservedAtMs
    }
  }
}

async function collectGpuSamples({ runtime, warmupMs, intervalMs, expectedSamples }) {
  await sleep(warmupMs)
  const measurementStartedAtMs = Date.now()
  const script = runtime.windowsGpuCounterPowerShellScript({
    intervalSeconds: intervalMs / 1000,
    maxSamples: expectedSamples
  })
  return await new Promise((resolveCollection) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    const samples = []
    let pending = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          samples.push(runtime.normalizeWindowsGpuCounterBatch(JSON.parse(line)))
        } catch {
          // Coverage will block the run; never fabricate a sample.
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    child.on('error', (error) => {
      resolveCollection({
        samples,
        exitCode: null,
        error: message(error),
        measurementStartedAtMs,
        measurementEndedAtMs: Date.now()
      })
    })
    child.on('exit', (code) => {
      if (pending.trim()) {
        try {
          samples.push(runtime.normalizeWindowsGpuCounterBatch(JSON.parse(pending)))
        } catch {
          // Coverage will block the run.
        }
      }
      resolveCollection({
        samples,
        exitCode: code,
        error: code === 0 ? null : stderr || `PowerShell exited ${code}`,
        measurementStartedAtMs,
        measurementEndedAtMs: Date.now()
      })
    })
  })
}

async function collectOwnedProcessTimeline({
  runtime,
  rootPid,
  warmupMs,
  measurementMs,
  intervalMs
}) {
  await sleep(warmupMs)
  const expectedSamples = Math.ceil(measurementMs / intervalMs)
  const measurementStartedAtMs = Date.now()
  const observations = []
  for (let index = 0; index < expectedSamples; index += 1) {
    const scheduledAtMs = measurementStartedAtMs + index * intervalMs
    await sleep(Math.max(0, scheduledAtMs - Date.now()))
    try {
      const census = await runtime.collectProcessCensus({
        ledgerPaths: [],
        rootPid
      })
      const sampledAtMs = Date.now()
      const processIds = [
        ...new Set(
          (census?.processGroupRows ?? census?.processRows ?? [])
            .map((row) => row.pid)
            .filter((pid) => Number.isInteger(pid) && pid > 0)
        )
      ].sort((left, right) => left - right)
      observations.push({ scheduledAtMs, sampledAtMs, processIds })
    } catch (error) {
      observations.push({
        scheduledAtMs,
        sampledAtMs: Date.now(),
        processIds: [],
        error: message(error)
      })
    }
  }
  return {
    expectedSamples,
    intervalMs,
    measurementStartedAtMs,
    measurementEndedAtMs: Date.now(),
    observations
  }
}

function adapterLuidFromDxgiId(sourceId) {
  const match = /^screen:dxgi:([0-9a-f]{16}):\d+$/i.exec(sourceId ?? '')
  if (!match) return null
  return `0x${match[1].slice(0, 8)}:0x${match[1].slice(8)}`
}

async function waitForPreviewFrame(runtime, ws, sourceId) {
  const deadline = Date.now() + Math.min(timeoutMs(), 30_000)
  let last = null
  while (Date.now() < deadline) {
    last = await runtime.request(ws, timeoutMs(), 'preview.screen.status')
    if (
      last?.state === 'live' &&
      last?.sourceId === sourceId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return
    }
    await sleep(100)
  }
  throw new BlockedRunError(`DXGI preview did not produce a first frame: ${JSON.stringify(last)}`)
}

async function waitForCameraFrame(runtime, ws, cameraId) {
  const deadline = Date.now() + Math.min(timeoutMs(), 30_000)
  let last = null
  while (Date.now() < deadline) {
    last = await runtime.request(ws, timeoutMs(), 'preview.camera.status')
    if (
      last?.state === 'live' &&
      last?.cameraId === cameraId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return
    }
    await sleep(100)
  }
  throw new BlockedRunError(
    `DirectShow camera preview did not produce a first frame: ${JSON.stringify(last)}`
  )
}

function selectCamera(devices, preferredId) {
  const available = devices.filter(
    (device) =>
      device?.kind === 'camera' &&
      device?.status === 'available' &&
      /^camera:dshow:/i.test(device.id)
  )
  if (preferredId) {
    return available.find((device) => device.id === preferredId) ?? null
  }
  return [...available].sort((left, right) => left.id.localeCompare(right.id))[0] ?? null
}

function selectMicrophone(devices, preferredId) {
  const available = devices.filter(
    (device) => device?.kind === 'microphone' && device?.status === 'available'
  )
  if (preferredId) {
    return available.find((device) => device.id === preferredId) ?? null
  }
  return available.find((device) => /^microphone:dshow:/i.test(device.id)) ?? available[0] ?? null
}

function safeDevice(device) {
  if (!device) return null
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    detail: device.detail ?? null
  }
}

function acceptanceAppEnvironment(evidenceDirectory) {
  return Object.fromEntries(
    [
      [
        'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR',
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR
      ],
      [
        'VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED',
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED
      ],
      [
        'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256',
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256
      ],
      [
        'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256',
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256
      ],
      [
        'VIDEORC_WINDOWS_ACCEPTANCE_DIR',
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_DIR ?? evidenceDirectory
      ]
    ].filter(([, value]) => typeof value === 'string' && value.trim())
  )
}

function requireCommand(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
  if (result.error || result.status !== 0) {
    throw new BlockedRunError(
      `${label} was unavailable: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`
    )
  }
}

function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${basename(command)} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`
    )
  }
  return result
}

function runCapturedBuffer(command, args) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${basename(command)} pixel sampling failed: ${result.error?.message ?? result.stderr?.toString('utf8') ?? `exit ${result.status}`}`
    )
  }
  return result.stdout
}

function waitForChildExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`Process ${child.pid ?? 'unknown'} did not exit within ${timeout}ms.`))
    }, timeout)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
  })
}

function promiseWithTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(timeoutMessage)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })
}

function matchingProcessIdentities(expected, processRows) {
  const rows = Array.isArray(processRows) ? processRows : []
  return (expected ?? []).filter((identity) =>
    rows.some((row) => row?.pid === identity.pid && row?.creationDate === identity.creationDate)
  )
}

function ownedCensusRows(census) {
  const rows = [
    ...(Array.isArray(census?.processRows) ? census.processRows : []),
    ...(Array.isArray(census?.processGroupRows) ? census.processGroupRows : [])
  ]
  const unique = new Map()
  for (const row of rows) {
    if (!Number.isInteger(row?.pid) || row.pid <= 1) continue
    const key = `${row.pid}:${row.creationDate ?? ''}`
    unique.set(key, {
      ...unique.get(key),
      ...row,
      role: row.role ?? unique.get(key)?.role ?? 'unknown'
    })
  }
  return [...unique.values()].sort((left, right) => left.pid - right.pid)
}

function processIdentitiesFromCensus(census) {
  return ownedCensusRows(census)
    .filter((row) => nonEmptyString(row.creationDate))
    .map((row) => ({
      pid: row.pid,
      creationDate: row.creationDate,
      role: row.role ?? 'unknown'
    }))
}

function mergeProcessIdentities(...groups) {
  const identities = new Map()
  for (const group of groups) {
    for (const identity of group ?? []) {
      if (
        !Number.isInteger(identity?.pid) ||
        identity.pid <= 1 ||
        !nonEmptyString(identity.creationDate)
      ) {
        continue
      }
      const key = `${identity.pid}:${identity.creationDate}`
      identities.set(key, {
        ...identities.get(key),
        ...identity,
        role: identity.role ?? identities.get(key)?.role ?? 'unknown'
      })
    }
  }
  return [...identities.values()].sort((left, right) => left.pid - right.pid)
}

async function pinWindowsProcessTree(
  runtime,
  { rootPid, label, identities = [], ledgerPaths = [] }
) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    throw new BlockedRunError(`${label} root PID was unavailable.`)
  }
  const censusStartedAtMs = Date.now()
  const census = await runtime.collectProcessCensus({
    ledgerPaths,
    rootPid,
    extraPids: identities.map((identity) => identity.pid)
  })
  const rows = ownedCensusRows(census)
  const observedIdentities = processIdentitiesFromCensus(census)
  const merged = mergeProcessIdentities(identities, observedIdentities)
  const blockers = []
  if (census?.error) blockers.push(`${label} census failed: ${census.error}`)
  if (rows.length === 0) blockers.push(`${label} process tree was empty`)
  if (rows.some((row) => !nonEmptyString(row.creationDate))) {
    blockers.push(`${label} process identity was missing Windows CreationDate`)
  }
  if (!observedIdentities.some((identity) => identity.pid === rootPid)) {
    blockers.push(`${label} root process was not alive`)
  }
  const missing = merged.filter((identity) => !matchingProcessIdentities([identity], rows).length)
  if (missing.length > 0) {
    blockers.push(`${label} lost ${missing.length} pinned process identity/identities`)
  }
  if (blockers.length > 0) {
    throw new BlockedRunError(blockers.join('; '))
  }
  return {
    census,
    identities: merged,
    censusStartedAtMs,
    censusCompletedAtMs: Date.now(),
    liveness: {
      verdict: 'PASS',
      blockers: [],
      rootPid,
      observedIdentities: observedIdentities.length,
      pinnedIdentities: merged.length
    }
  }
}

async function collectStimulusProcessCensuses(runtime, { motion, av }) {
  const [motionResult, avResult] = await Promise.all([
    pinWindowsProcessTree(runtime, {
      ...motion,
      label: 'screen-motion stimulus'
    }),
    av
      ? pinWindowsProcessTree(runtime, {
          ...av,
          label: 'A/V-sync stimulus'
        })
      : Promise.resolve(null)
  ])
  return { motion: motionResult, av: avResult }
}

async function collectKnownStimulusProcessCensuses(runtime, { motion, av }) {
  const collect = async (entry) => {
    if (!entry || (!Number.isInteger(entry.rootPid) && entry.identities.length === 0)) return null
    return await runtime.collectProcessCensus({
      ledgerPaths: [],
      rootPid: Number.isInteger(entry.rootPid) ? entry.rootPid : undefined,
      extraPids: entry.identities.map((identity) => identity.pid)
    })
  }
  const [motionCensus, avCensus] = await Promise.all([collect(motion), collect(av)])
  return { motion: motionCensus, av: avCensus }
}

function evaluateStimulusProcessLiveness({ videoOnly, measurementStart, measurementEnd }) {
  const evaluate = (label, start, end) => {
    const blockers = []
    if (start?.liveness?.verdict !== 'PASS') {
      blockers.push(`${label} process tree was not continuously pinned at measurement start`)
    }
    if (end?.liveness?.verdict !== 'PASS') {
      blockers.push(`${label} process tree was not continuously pinned at measurement end`)
    }
    return {
      verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
      blockers,
      start: start?.liveness ?? null,
      end: end?.liveness ?? null
    }
  }
  const motion = evaluate(
    'screen-motion stimulus',
    measurementStart?.motion,
    measurementEnd?.motion
  )
  const av = videoOnly
    ? { verdict: 'NOT_REQUIRED', blockers: [], start: null, end: null }
    : evaluate('A/V-sync stimulus', measurementStart?.av, measurementEnd?.av)
  const blockers = [...motion.blockers, ...av.blockers]
  if (measurementStart?.error) blockers.push(`stimulus start census: ${measurementStart.error}`)
  if (measurementEnd?.error) blockers.push(`stimulus end census: ${measurementEnd.error}`)
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    motion,
    av
  }
}

async function exerciseWindowsPreviewInputContinuity({
  runtime,
  smoke,
  scenario,
  requireD3d11,
  restoreBounds
}) {
  if (!scenario.previewOpen || !requireD3d11) {
    return {
      verdict: 'NOT_REQUIRED',
      applicable: false,
      physicalInput: false,
      blockers: []
    }
  }

  let prepared = false
  try {
    const before = await runtime.requestSmokeCommand(
      smoke,
      'windows-preview-os-input-probe',
      { action: 'prepare' },
      { timeoutMs: timeoutMs() }
    )
    prepared = true
    for (const field of ['inputPoint', 'dragPoint']) {
      if (
        !before?.[field] ||
        !Number.isInteger(before[field].x) ||
        !Number.isInteger(before[field].y)
      ) {
        throw new Error(`Windows preview input probe returned an invalid ${field}.`)
      }
    }

    runWindowsPreviewInputPowerShell(before)
    const deadline = Date.now() + 8_000
    let after = null
    do {
      after = await runtime.requestSmokeCommand(
        smoke,
        'windows-preview-os-input-probe',
        { action: 'read' },
        { timeoutMs: timeoutMs() }
      )
      if (
        evaluateWindowsD3d11PreviewInputContinuity({
          applicable: true,
          before,
          after
        }).verdict === 'PASS'
      ) {
        break
      }
      await sleep(100)
    } while (Date.now() < deadline)

    const blockers = []
    if (!(after?.state?.clicks > 0)) blockers.push('Electron did not receive the physical click')
    if (!(after?.state?.focusEvents > 0)) {
      blockers.push('Electron input did not receive focus')
    }
    if (!(after?.state?.inputEvents > 0) || after?.state?.value !== 'VIDEORC42') {
      blockers.push('Electron input did not receive the physical keyboard sequence')
    }
    if (after?.state?.activeElementId !== 'videorc-windows-preview-input-target') {
      blockers.push('Electron input did not remain the active element')
    }
    if (!windowsPreviewMovedAtLeast(before.initialBounds, after?.bounds, 12)) {
      blockers.push('Electron preview window did not move from the physical drag')
    }
    if (after?.previewFocused !== true || after?.webContentsFocused !== true) {
      blockers.push('Electron preview/webContents did not retain focus')
    }
    if (after?.presenter?.windowActive !== false || after?.presenter?.windowFocused !== false) {
      blockers.push('D3D11 presenter activated or took focus')
    }
    if (
      after?.presenter?.firstPresentSucceeded !== true ||
      after?.presenter?.sourceLive !== true ||
      !Number.isSafeInteger(before?.presenter?.lastPresentedSequence) ||
      !Number.isSafeInteger(after?.presenter?.lastPresentedSequence) ||
      after.presenter.lastPresentedSequence <= before.presenter.lastPresentedSequence
    ) {
      blockers.push('D3D11 presenter did not remain live and advance through physical input')
    }

    return {
      verdict: blockers.length === 0 ? 'PASS' : 'FAIL',
      applicable: true,
      physicalInput: true,
      blockers,
      clickCount: after?.state?.clicks ?? 0,
      focusEventCount: after?.state?.focusEvents ?? 0,
      inputEventCount: after?.state?.inputEvents ?? 0,
      typedValueMatched: after?.state?.value === 'VIDEORC42',
      electronWindowMoved: windowsPreviewMovedAtLeast(before.initialBounds, after?.bounds, 12),
      electronFocused: after?.previewFocused === true && after?.webContentsFocused === true,
      presenterNeverActivated:
        after?.presenter?.windowActive === false && after?.presenter?.windowFocused === false,
      presenterSequenceBefore: before?.presenter?.lastPresentedSequence ?? null,
      presenterSequenceAfter: after?.presenter?.lastPresentedSequence ?? null
    }
  } catch (error) {
    return {
      verdict: 'BLOCKED',
      applicable: true,
      physicalInput: true,
      blockers: [message(error)]
    }
  } finally {
    if (prepared) {
      await runtime
        .requestSmokeCommand(
          smoke,
          'windows-preview-os-input-probe',
          { action: 'cleanup' },
          { timeoutMs: timeoutMs() }
        )
        .catch(() => undefined)
    }
    if (restoreBounds) {
      await runtime
        .requestSmokeCommand(smoke, 'preview-window-set-bounds', restoreBounds, {
          timeoutMs: timeoutMs()
        })
        .catch(() => undefined)
    }
  }
}

function runWindowsPreviewInputPowerShell(probe) {
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VideorcStreamPreviewInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
Add-Type -AssemblyName System.Windows.Forms
function Click-Point([int]$x, [int]$y) {
  [VideorcStreamPreviewInput]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 100
  [VideorcStreamPreviewInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [VideorcStreamPreviewInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
Click-Point ([int]$env:VIDEORC_INPUT_X) ([int]$env:VIDEORC_INPUT_Y)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('VIDEORC42')
Start-Sleep -Milliseconds 150
$startX = [int]$env:VIDEORC_DRAG_X
$startY = [int]$env:VIDEORC_DRAG_Y
[VideorcStreamPreviewInput]::SetCursorPos($startX, $startY) | Out-Null
[VideorcStreamPreviewInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
foreach ($step in 1..6) {
  [VideorcStreamPreviewInput]::SetCursorPos($startX + (8 * $step), $startY + (6 * $step)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[VideorcStreamPreviewInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`
  const result = spawnSync(
    process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
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
      `Windows preview physical input failed: ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
      }`
    )
  }
}

function windowsPreviewMovedAtLeast(before, after, minimum) {
  return (
    before &&
    after &&
    (Math.abs(after.x - before.x) >= minimum || Math.abs(after.y - before.y) >= minimum)
  )
}

function stimulusTeardownResultClean(result) {
  return (
    result?.forced === false &&
    result?.treeExited === true &&
    ['skipped', 'terminated'].includes(result?.state) &&
    result?.directoryRemoved !== false
  )
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) rejectPort(error)
        else if (!port) rejectPort(new Error('Could not allocate a loopback port.'))
        else resolvePort(port)
      })
    })
  })
}

function timeoutMs() {
  return Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 300_000)
}

function windowsHardwareClass() {
  return (
    process.env.VIDEORC_WINDOWS_HARDWARE_CLASS?.trim() ||
    process.env.VIDEORC_PERF_HARDWARE_CLASS?.trim() ||
    null
  )
}

function windowsStreamOutputDirectory(runOptions) {
  const protectedEvidence =
    runOptions.mode === 'gate' ||
    (runOptions.mode === 'calibrate' &&
      (runOptions.profiles.length > 0 ||
        runOptions.d3d11 ||
        runOptions.expectFallback === 'natural'))
  const acceptanceRoot = process.env.VIDEORC_WINDOWS_ACCEPTANCE_DIR?.trim()
  const candidateSha256 = process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256?.trim()
  if (protectedEvidence && process.platform === 'win32') {
    if (!acceptanceRoot || !isAbsolute(acceptanceRoot)) {
      throw new Error(
        'VIDEORC_WINDOWS_ACCEPTANCE_DIR must be an absolute hardware-class evidence root.'
      )
    }
    if (!/^[a-f0-9]{64}$/.test(candidateSha256 ?? '')) {
      throw new Error(
        'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 is required to name the immutable candidate evidence root.'
      )
    }
  }
  const selected =
    runOptions.output ??
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    (runOptions.preparePremiumProfile && acceptanceRoot
      ? join(acceptanceRoot, 'windows-stream-performance', 'profile')
      : null) ??
    (protectedEvidence && acceptanceRoot && /^[a-f0-9]{64}$/.test(candidateSha256 ?? '')
      ? join(acceptanceRoot, 'windows-stream-performance', candidateSha256)
      : null) ??
    join(tmpdir(), `videorc-windows-stream-performance-${Date.now()}`)
  if (protectedEvidence && process.platform === 'win32' && !isAbsolute(selected)) {
    throw new Error('Protected Windows stream evidence output must be absolute.')
  }
  return resolve(selected)
}

function extension(path) {
  const match = /(\.[a-z0-9]+)$/i.exec(path)
  return match?.[1] ?? '.mkv'
}

function aggregateStatus(verdict) {
  switch (verdict) {
    case 'PASS':
      return 'passed'
    case 'BLOCKED':
      return 'blocked'
    case 'FAIL':
      return 'failed'
    case 'CALIBRATION':
      return 'calibration'
    default:
      return 'diagnostic'
  }
}

async function finishBlocked(reason) {
  aggregate.status = 'blocked'
  aggregate.finishedAt = new Date().toISOString()
  aggregate.error = { message: reason }
  aggregate.blockers = [reason]
  await writeJson(aggregatePath, aggregate)
  console.error(`windows-stream-performance: BLOCKED: ${reason}`)
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function redactedRunError(error, secrets) {
  const redactedMessage = redactWindowsStreamSecrets(message(error), secrets)
  if (error instanceof BlockedRunError) {
    return new BlockedRunError(redactedMessage)
  }
  const redacted = new Error(redactedMessage)
  redacted.name = error?.name ?? 'Error'
  return redacted
}

class BlockedRunError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedRunError'
  }
}
