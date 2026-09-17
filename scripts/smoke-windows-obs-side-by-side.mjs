import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { release, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WINDOWS_OBS_D3D11_HARDWARE_CLASSES,
  WINDOWS_OBS_REQUIRED_ORDER,
  WINDOWS_OBS_SCENARIO,
  WINDOWS_OBS_SETTINGS,
  WINDOWS_OBS_TIMING,
  buildWindowsObsPortableProfile,
  buildWindowsObsRunPlan,
  deriveWindowsD3d11PerformanceBudget,
  deriveWindowsStreamPerformanceBudget,
  evaluateWindowsObsEndpointMapping,
  extractWindowsAudioEndpointId,
  mergeWindowsObsRunEvidence,
  normalizedWindowsObsSettings,
  parseWindowsObsSideBySideArgs,
  summarizeWindowsObsProcessTelemetry,
  windowsObsSelectionEnvironment,
  windowsObsSettingsIdentity
} from './lib/windows-obs-side-by-side.mjs'
import {
  WINDOWS_STREAM_PERFORMANCE_THRESHOLDS,
  evaluateWindowsReceiverProgressClock,
  evaluateWindowsStreamDiagnosticTimeline,
  evaluateWindowsStreamProcessTelemetry,
  evaluateWindowsStreamTargetLifecycle,
  parseWindowsDxgiOutputDeviceName,
  parseWindowsStreamDisplayBounds,
  receiverBitrateEvidence,
  summarizeWindowsStreamDiagnosticSamples
} from './lib/windows-stream-performance.mjs'
import {
  revalidateInstalledWindowsCandidate,
  verifyInstalledWindowsCandidate
} from './lib/windows-local-gates.mjs'
import {
  finalizePreparedJsonArtifact,
  prepareExclusiveJsonArtifact
} from './lib/exclusive-json-artifact.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const options = parseWindowsObsSideBySideArgs(process.argv.slice(2))

if (options.mode === 'list') {
  printList()
  process.exit(0)
}

if (options.mode === 'derive-budget') {
  const comparison = {
    ...(await readJson(options.comparison)),
    aggregatePath: portableResolve(options.comparison),
    aggregateSha256: await sha256File(options.comparison)
  }
  const calibrations = await loadLegacyCalibrations(options.streamCalibrations)
  const budget = deriveWindowsStreamPerformanceBudget({ comparison, calibrations })
  await writeJsonNew(options.output, budget)
  console.log(`windows-obs-side-by-side: DRAFT budget written to ${resolve(options.output)}`)
  console.log('Independent human review is required before activation.')
  process.exit(0)
}

if (options.mode === 'derive-d3d11-budget') {
  const comparisons = await Promise.all(
    options.comparisons.map(async (path) => {
      const comparison = await readJson(path)
      return {
        ...comparison,
        aggregatePath: portableResolve(path),
        aggregateSha256: await sha256File(path)
      }
    })
  )
  const calibrationRoots = await Promise.all(
    options.streamCalibrations.map(loadD3d11CalibrationRoot)
  )
  const budget = deriveWindowsD3d11PerformanceBudget({
    comparisons,
    calibrations: calibrationRoots.flatMap((root) => root.calibrations)
  })
  await writeJsonNew(options.output, budget)
  console.log(`windows-obs-side-by-side: D3D11 DRAFT budget written to ${resolve(options.output)}`)
  console.log('Natural-fallback evidence and independent human review are still required.')
  process.exit(0)
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error(
    `windows-obs-side-by-side: UNSUPPORTED/BLOCKED — physical Windows 11 x64 is required; current host is ${process.platform}/${process.arch}.`
  )
  process.exit(2)
}

try {
  const aggregate = await executeCalibration()
  console.log(
    `windows-obs-side-by-side: ${aggregate.verdict} (${aggregate.aggregatePath ?? 'aggregate.json'})`
  )
  process.exit(aggregate.verdict === 'PASS' ? 0 : aggregate.verdict === 'BLOCKED' ? 2 : 1)
} catch (error) {
  const blocked = error instanceof BlockedRunError
  console.error(`windows-obs-side-by-side: ${blocked ? 'BLOCKED' : 'FAIL'} — ${message(error)}`)
  process.exit(blocked ? 2 : 1)
}

async function executeCalibration() {
  const runtime = await loadRuntime()
  const selectionEnvironment = windowsObsSelectionEnvironment({
    env: process.env,
    d3d11: options.d3d11,
    requireD3d11: options.requireD3d11
  })
  const runnerEnvironment = { ...process.env, ...selectionEnvironment }
  const acceptanceRoot = requiredAbsoluteEnvironmentPath('VIDEORC_WINDOWS_ACCEPTANCE_DIR')
  const candidateExecutable = requiredAbsoluteEnvironmentPath(
    'VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE'
  )
  const obsExecutable = requiredAbsoluteEnvironmentPath('VIDEORC_OBS_EXECUTABLE')
  const profileDirectory = requiredAbsoluteEnvironmentPath('VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR')
  if (process.env.VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED !== '1') {
    throw new BlockedRunError(
      'VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1 is required; dev builds are forbidden.'
    )
  }
  const sourceCommit = requiredLowercaseHexEnvironment('VIDEORC_RELEASE_SOURCE_COMMIT', 40)
  const installerSha256 = requiredLowercaseHexEnvironment('VIDEORC_RELEASE_EXPECTED_SHA256', 64)
  const expectedCandidateSha256 = requiredLowercaseHexEnvironment(
    'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256',
    64
  )
  const expectedPayloadSha256 = requiredLowercaseHexEnvironment(
    'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256',
    64
  )
  const hardwareClass = requiredEnvironment('VIDEORC_WINDOWS_HARDWARE_CLASS')
  const monitorId = requiredEnvironment('VIDEORC_OBS_MONITOR_ID')
  const videorcDisplayId = requiredEnvironment('VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID')
  const videorcAudioId = requiredEnvironment('VIDEORC_WINDOWS_ACCEPTANCE_AUDIO_DEVICE_ID')
  const obsAudioId = requiredEnvironment('VIDEORC_OBS_AUDIO_DEVICE_ID')
  const displayBounds = process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS?.trim()
    ? parseWindowsStreamDisplayBounds(process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS)
    : null
  const displayRefreshHz = process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_REFRESH_HZ?.trim()
    ? positiveNumber(
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_REFRESH_HZ,
        'VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_REFRESH_HZ'
      )
    : null
  const obsEncoderId = resolveObsEncoderId(hardwareClass)
  const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
  requireCommand(ffmpegPath, ['-version'], 'FFmpeg')
  requireCommand(ffprobePath, ['-version'], 'FFprobe')
  requireCommand(obsExecutable, ['--version'], 'OBS')
  if (!existsSync(candidateExecutable) || !statSync(candidateExecutable).isFile()) {
    throw new BlockedRunError('The installed Videorc acceptance executable was not found.')
  }
  if (!existsSync(obsExecutable) || !statSync(obsExecutable).isFile()) {
    throw new BlockedRunError('VIDEORC_OBS_EXECUTABLE did not identify an OBS executable.')
  }

  const verifiedCandidate = await verifyInstalledWindowsCandidate({
    executablePath: candidateExecutable,
    repoRoot,
    env: process.env
  })
  const revalidateCandidate = () =>
    revalidateInstalledWindowsCandidate({
      expectedCandidate: verifiedCandidate,
      repoRoot,
      env: process.env,
      platform: process.platform
    })

  const spawnSpec = runtime.performanceAppSpawnSpec({
    ...runnerEnvironment,
    VIDEORC_PERF_APP_EXECUTABLE: candidateExecutable
  })
  if (
    resolve(spawnSpec.command).toLocaleLowerCase('en-US') !==
    resolve(candidateExecutable).toLocaleLowerCase('en-US')
  ) {
    throw new BlockedRunError('The performance launcher did not resolve the installed candidate.')
  }
  runtime.windowsAcceptanceProfileDir({
    env: {
      ...process.env,
      VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: profileDirectory,
      VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '1',
      VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: expectedCandidateSha256
    },
    platform: 'win32'
  })

  const candidateSha256 = verifiedCandidate.executableSha256
  const candidatePayload = verifiedCandidate.packagePayload
  const candidateSignature = verifiedCandidate.signature
  const [obsSha256, obsSignature] = await Promise.all([
    runtime.sha256File(obsExecutable),
    authenticodeIdentity(obsExecutable)
  ])
  if (candidateSha256 !== expectedCandidateSha256) {
    throw new BlockedRunError('Installed Videorc.exe did not match the expected app digest.')
  }
  if (candidatePayload.sha256 !== expectedPayloadSha256) {
    throw new BlockedRunError(
      'Installed app.asar/backend/FFmpeg payload did not match the expected payload digest.'
    )
  }
  requireValidSignature(obsSignature, null, 'OBS reference')
  const obsCliVersion = parseObsVersion(capturedText(obsExecutable, ['--version']))

  const hardware = await collectWindowsHardwareProvenance(hardwareClass, {
    requireD3d11: options.requireD3d11
  })
  const plan = buildWindowsObsRunPlan({
    evidenceDirectory: acceptanceRoot,
    candidateSha256,
    scenario: options.scenario,
    order: options.order
  })
  if (existsSync(plan.root)) {
    throw new BlockedRunError(
      `Immutable comparison evidence already exists for this candidate: ${plan.root}`
    )
  }
  await mkdir(join(plan.root, 'runs'), { recursive: true })

  const portableDirectory = await mkdtemp(join(tmpdir(), 'videorc-obs-portable-'))
  let manifestPath = null
  let manifestSha256 = null
  let manifest = null
  const completedRuns = []
  try {
    const portable = await createObsPortableCopy({
      runtime,
      inputExecutable: obsExecutable,
      inputSha256: obsSha256,
      destination: portableDirectory
    })
    const appEnvironment = acceptanceAppEnvironment({
      profileDirectory,
      evidenceDirectory: plan.root,
      selectionEnvironment
    })

    await assertExactExecutablesAbsent([candidateExecutable, obsExecutable, portable.executable])
    const videorcPreflight = await preflightVideorc({
      runtime,
      spawnSpec,
      appEnvironment,
      ffmpegPath,
      displayId: videorcDisplayId,
      audioId: videorcAudioId,
      displayBounds,
      displayRefreshHz,
      candidateSha256,
      candidatePayloadSha256: candidatePayload.sha256
    })
    const obsPreflight = await preflightObs({
      runtime,
      portable,
      monitorId,
      audioDeviceId: obsAudioId,
      obsEncoderId,
      obsCliVersion
    })
    const mapping = buildEndpointMapping({
      videorcPreflight,
      obsPreflight
    })
    if (mapping.verdict !== 'PASS') {
      throw new BlockedRunError(
        `Videorc/OBS physical endpoint mapping failed: ${mapping.blockers.join('; ')}`
      )
    }

    const stimulusAttestation = await attestStimulus({
      runtime,
      screen: videorcPreflight.screen,
      bounds: videorcPreflight.display.desktopBounds,
      ffmpegPath
    })
    const settings = windowsObsSettingsIdentity(
      normalizedWindowsObsSettings({
        display: mapping.display.videorc,
        audio: mapping.audio.videorc,
        obsEncoderId,
        d3d11: options.d3d11,
        requireD3d11: options.requireD3d11
      })
    )
    const rtmpTarget = await localRtmpTarget()
    const receiverIdentity = {
      ffmpegPath: resolveCommandPath(ffmpegPath),
      ffmpegSha256: await runtime.sha256File(resolveCommandPath(ffmpegPath)),
      ffprobePath: resolveCommandPath(ffprobePath),
      ffprobeSha256: await runtime.sha256File(resolveCommandPath(ffprobePath)),
      protocol: 'rtmp-listen-flv-copy',
      target: safeRtmpTargetIdentity(rtmpTarget),
      warmupMs: WINDOWS_OBS_TIMING.warmupMs,
      measurementMs: WINDOWS_OBS_TIMING.measurementMs
    }
    const candidate = {
      executablePath: candidateExecutable,
      sha256: candidateSha256,
      packagePayload: candidatePayload,
      sourceCommit,
      installerSha256,
      signed: true,
      signature: candidateSignature
    }
    const obs = {
      executablePath: obsExecutable,
      sha256: obsSha256,
      portableExecutablePath: portable.executable,
      portableSha256: portable.sha256,
      version: obsPreflight.version,
      cliVersion: obsCliVersion,
      signed: true,
      signature: obsSignature,
      encoderId: obsEncoderId
    }
    manifest = {
      schemaVersion: 1,
      kind: 'videorc.windows-obs-side-by-side-manifest',
      status: 'locked',
      scenario: WINDOWS_OBS_SCENARIO,
      timing: WINDOWS_OBS_TIMING,
      order: WINDOWS_OBS_REQUIRED_ORDER,
      candidate,
      obs,
      hardware,
      mapping,
      display: mapping.display,
      audio: mapping.audio,
      settings,
      stimulus: stimulusAttestation,
      receiver: receiverIdentity,
      createdAt: new Date().toISOString()
    }
    manifestPath = plan.manifestPath
    await writeJsonNew(manifestPath, manifest)
    manifestSha256 = await runtime.sha256File(manifestPath)
    manifest = { ...manifest, manifestPath, manifestSha256 }

    for (const runPlan of plan.runs) {
      console.log(
        `windows-obs-side-by-side: trial ${runPlan.index}/6 — ${runPlan.app.toUpperCase()}`
      )
      await assertExactExecutablesAbsent([candidateExecutable, obsExecutable, portable.executable])
      const report = await executeRun({
        runtime,
        runPlan,
        portable,
        spawnSpec,
        appEnvironment,
        candidate,
        obs,
        hardware,
        mapping,
        settings,
        stimulusAttestation,
        monitorId,
        obsAudioId,
        obsEncoderId,
        videorcPreflight,
        ffmpegPath,
        ffprobePath,
        d3d11: options.d3d11,
        requireD3d11: options.requireD3d11,
        rtmpTarget,
        revalidateCandidate
      })
      completedRuns.push(report)
      if (report.media.verdict !== 'PASS' || report.process.teardownClean !== true) {
        throw new Error(`Trial ${runPlan.index} failed its protected run contract.`)
      }
    }

    const aggregate = mergeWindowsObsRunEvidence({
      manifest,
      runs: completedRuns
    })
    aggregate.aggregatePath = plan.aggregatePath
    if (aggregate.verdict === 'PASS') {
      const preparedAggregate = await prepareExclusiveJsonArtifact(plan.aggregatePath, aggregate)
      const publishedAggregate = await finalizePreparedJsonArtifact(
        preparedAggregate,
        revalidateCandidate
      )
      return {
        ...aggregate,
        aggregatePath: plan.aggregatePath,
        aggregateSha256: publishedAggregate.sha256
      }
    }
    await writeJsonNew(plan.aggregatePath, aggregate)
    throw new BlockedRunError(
      [...aggregate.failures, ...aggregate.blockers].join('; ') || 'OBS comparison did not pass.'
    )
  } catch (error) {
    if (manifest && !existsSync(plan.aggregatePath)) {
      const failedAggregate = {
        schemaVersion: 1,
        kind: 'videorc.windows-obs-side-by-side',
        status: error instanceof BlockedRunError ? 'BLOCKED' : 'FAIL',
        scenario: WINDOWS_OBS_SCENARIO,
        timing: WINDOWS_OBS_TIMING,
        candidate: manifest.candidate,
        obs: manifest.obs,
        hardware: manifest.hardware,
        mapping: manifest.mapping,
        display: manifest.display,
        audio: manifest.audio,
        settings: manifest.settings,
        stimulus: manifest.stimulus,
        receiver: manifest.receiver,
        manifestPath,
        manifestSha256,
        runs: completedRuns,
        verdict: error instanceof BlockedRunError ? 'BLOCKED' : 'FAIL',
        failures: error instanceof BlockedRunError ? [] : [message(error)],
        blockers: error instanceof BlockedRunError ? [message(error)] : []
      }
      await writeJsonNew(plan.aggregatePath, failedAggregate).catch(() => undefined)
    }
    throw error
  } finally {
    await rm(portableDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function executeRun({
  runtime,
  runPlan,
  portable,
  spawnSpec,
  appEnvironment,
  candidate,
  obs,
  hardware,
  mapping,
  settings,
  stimulusAttestation,
  monitorId,
  obsAudioId,
  obsEncoderId,
  videorcPreflight,
  ffmpegPath,
  ffprobePath,
  d3d11,
  requireD3d11,
  rtmpTarget,
  revalidateCandidate
}) {
  await mkdir(runPlan.directory, { recursive: false })
  const artifacts = {
    receiverStaging: join(runPlan.directory, 'receiver-measurement-plus-tail.flv'),
    receiver: join(runPlan.directory, 'receiver.flv'),
    ffprobe: join(runPlan.directory, 'receiver.ffprobe.json'),
    framemd5: join(runPlan.directory, 'receiver.framemd5'),
    analyzer: join(runPlan.directory, 'receiver.quality.json'),
    avSync: join(runPlan.directory, 'receiver.av-sync.json'),
    process: join(runPlan.directory, 'process-samples.json'),
    gpu: join(runPlan.directory, 'gpu-samples.json'),
    status: join(runPlan.directory, 'application-status-samples.json'),
    stimulus: join(runPlan.directory, 'stimulus.json'),
    settings: join(runPlan.directory, 'settings.json'),
    supportBundle: join(runPlan.directory, 'support-bundle.json')
  }
  const startedAt = new Date().toISOString()
  const target = {
    ...rtmpTarget,
    receiverPath: artifacts.receiverStaging
  }
  const profile = buildWindowsObsPortableProfile({
    monitorId,
    audioDeviceId: obsAudioId,
    serverUrl: target.serverUrl,
    streamKey: target.streamKey,
    obsEncoderId
  })
  const runSettings = {
    settingsSha256: settings.sha256,
    normalized: settings.normalized,
    obsPortableProfileSha256: profile.normalizedSha256,
    receiver: {
      serverUrl: `${target.serverUrl}/<generated-key>`,
      streamKeyPresent: true
    }
  }
  await writeJsonNew(artifacts.settings, runSettings)

  let receiver = null
  let publisher = null
  let stimuli = null
  let processTelemetry = null
  let statusTimeline = null
  let gpuCollection = null
  let gpuEvidence = null
  let measurementClock = null
  let publisherStop = null
  let stimulusStop = null
  let receiverExit = null
  let supportBundlePresent = false
  let supportBundleValidation = null
  let supportBundleValidatedSha256 = null
  let caught = null
  try {
    stimuli = await launchStimuli({
      runtime,
      screen: videorcPreflight.screen,
      bounds: mapping.display.videorc.desktopBounds,
      ffmpegPath,
      runDirectory: runPlan.directory,
      expectedManifestSha256: stimulusAttestation.manifestSha256
    })
    receiver = spawnReceiver({
      ffmpegPath,
      target,
      warmupSeconds: WINDOWS_OBS_TIMING.warmupMs / 1000,
      measurementSeconds: WINDOWS_OBS_TIMING.measurementMs / 1000
    })
    await ensureReceiverListening(receiver)

    publisher =
      runPlan.app === 'obs'
        ? await startObsPublisher({
            runtime,
            portable,
            profile,
            runDirectory: runPlan.directory,
            expected: obs
          })
        : await startVideorcPublisher({
            runtime,
            spawnSpec,
            appEnvironment: {
              ...appEnvironment,
              VIDEORC_SMOKE_OUTPUT_DIR: runPlan.directory
            },
            ffmpegPath,
            screen: videorcPreflight.screen,
            microphone: videorcPreflight.microphone,
            target,
            candidate,
            d3d11,
            requireD3d11
          })

    const receiverMeasurementStart = await receiver.waitForMeasurementStart(
      WINDOWS_OBS_TIMING.warmupMs + 45_000
    )
    const expectedSamples = Math.ceil(
      WINDOWS_OBS_TIMING.measurementMs / WINDOWS_OBS_TIMING.sampleIntervalMs
    )
    const collectorsStartedAtMs = Date.now()
    const startSkewMs =
      Math.abs(collectorsStartedAtMs - receiverMeasurementStart.startedAtMs) +
      receiverMeasurementStart.clockEvidence.uncertaintyMs
    if (startSkewMs > WINDOWS_OBS_TIMING.sampleIntervalMs) {
      throw new BlockedRunError(
        `Receiver and telemetry clocks differed by ${startSkewMs}ms (maximum 1000ms).`
      )
    }
    measurementClock = {
      receiverMeasurementStart,
      collectorsStartedAtMs,
      startSkewMs,
      expectedEndedAtMs: receiverMeasurementStart.startedAtMs + WINDOWS_OBS_TIMING.measurementMs
    }

    const [processResult, statusResult, gpuResult, stimulusStartCensus] = await Promise.allSettled([
      runtime.collectWindowsProcessTreeTelemetry({
        rootPid: publisher.rootPid,
        warmupMs: 0,
        measurementMs: WINDOWS_OBS_TIMING.measurementMs,
        intervalMs: WINDOWS_OBS_TIMING.sampleIntervalMs,
        now: Date.now
      }),
      collectPublisherStatus({
        runtime,
        publisher,
        app: runPlan.app,
        measurementMs: WINDOWS_OBS_TIMING.measurementMs,
        intervalMs: WINDOWS_OBS_TIMING.sampleIntervalMs
      }),
      collectGpuSamples({
        runtime,
        intervalMs: WINDOWS_OBS_TIMING.sampleIntervalMs,
        expectedSamples
      }),
      collectStimulusCensus(runtime, stimuli)
    ])
    if (processResult.status !== 'fulfilled') {
      throw new BlockedRunError(`Process telemetry failed: ${message(processResult.reason)}`)
    }
    if (statusResult.status !== 'fulfilled') {
      throw new BlockedRunError(
        `Application status sampling failed: ${message(statusResult.reason)}`
      )
    }
    if (gpuResult.status !== 'fulfilled') {
      throw new BlockedRunError(`GPU sampling failed: ${message(gpuResult.reason)}`)
    }
    if (stimulusStartCensus.status !== 'fulfilled') {
      throw new BlockedRunError(
        `Stimulus process liveness sampling failed: ${message(stimulusStartCensus.reason)}`
      )
    }
    processTelemetry = processResult.value
    statusTimeline = statusResult.value
    gpuCollection = gpuResult.value
    const stimulusEndCensus = await collectStimulusCensus(runtime, stimuli)
    stimuli.liveness = evaluateStimulusLiveness(stimulusStartCensus.value, stimulusEndCensus)
    if (stimuli.liveness.verdict !== 'PASS') {
      throw new BlockedRunError(stimuli.liveness.blockers.join('; '))
    }
    if (receiver.child.exitCode !== null || receiver.child.signalCode !== null) {
      throw new Error('The local RTMP receiver exited before the measurement boundary.')
    }
    measurementClock = {
      ...measurementClock,
      measurementCheckedAtMs: Date.now(),
      endSkewMs: Math.abs(Date.now() - measurementClock.expectedEndedAtMs)
    }
    if (measurementClock.endSkewMs > WINDOWS_OBS_TIMING.sampleIntervalMs * 2) {
      throw new BlockedRunError(
        `Measurement collectors ended ${measurementClock.endSkewMs}ms from the receiver boundary.`
      )
    }

    publisherStop = await publisher.stop()
    receiverExit = await waitForChildExit(receiver.child, 20_000)
    receiver = null
    trimReceiverMeasurement({
      ffmpegPath,
      inputPath: artifacts.receiverStaging,
      outputPath: artifacts.receiver,
      measurementSeconds: WINDOWS_OBS_TIMING.measurementMs / 1000
    })

    if (runPlan.app === 'videorc') {
      if (typeof publisher.exportSupportBundle !== 'function') {
        throw new BlockedRunError('Videorc trial did not expose support-bundle export.')
      }
      const support = await publisher.exportSupportBundle()
      if (!support?.path || !existsSync(support.path)) {
        throw new BlockedRunError('Videorc trial did not retain exactly one support bundle.')
      }
      if (resolve(support.path) !== resolve(artifacts.supportBundle)) {
        await copyFile(support.path, artifacts.supportBundle)
        await rm(support.path, { force: true })
      }
      const supportRaw = await readFile(artifacts.supportBundle, 'utf8')
      assertNoSecrets(supportRaw, [target.streamKey, target.listenerUrl], 'support bundle')
      const bundle = JSON.parse(supportRaw)
      const validation = runtime.validateSupportBundle(bundle, { windowsAcceptance: true })
      if (!validation.ok) {
        throw new BlockedRunError(
          `Videorc support bundle failed validation: ${validation.failures.join('; ')}`
        )
      }
      supportBundleValidatedSha256 = createHash('sha256').update(supportRaw).digest('hex')
      supportBundlePresent = true
      supportBundleValidation = { verdict: 'PASS', validated: true, secretFree: true }
    }
  } catch (error) {
    caught = redactedRunError(error, [target.streamKey, target.listenerUrl])
  } finally {
    if (publisher && !publisherStop) {
      publisherStop = await publisher.stop().catch((error) => ({
        clean: false,
        forced: true,
        error: message(error)
      }))
    }
    if (receiver) {
      receiver.child.kill('SIGTERM')
      await waitForChildExit(receiver.child, 5_000).catch(() => undefined)
    }
    if (stimuli) {
      stimulusStop = await stopStimuli(runtime, stimuli).catch((error) => ({
        clean: false,
        error: message(error)
      }))
    }
  }
  if (caught) throw caught

  const processReadiness = evaluateWindowsStreamProcessTelemetry(processTelemetry, {
    measurementMs: WINDOWS_OBS_TIMING.measurementMs,
    intervalMs: WINDOWS_OBS_TIMING.sampleIntervalMs,
    requiredRoles:
      runPlan.app === 'videorc'
        ? ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
        : ['other']
  })
  if (processReadiness.verdict !== 'PASS') {
    throw new BlockedRunError(processReadiness.blockers.join('; '))
  }
  const processSummary = summarizeWindowsObsProcessTelemetry(processTelemetry)
  if (
    [
      processSummary.cpuP95Percent,
      processSummary.rssP95MiB,
      processSummary.rssMaxMiB,
      processSummary.rssSlopeMiBPerMinute
    ].some((value) => !Number.isFinite(value))
  ) {
    throw new BlockedRunError('Process telemetry summary contained non-finite metrics.')
  }

  const rootIdentity = publisher.rootIdentity
  const gpuAttribution = runtime.attributeWindowsGpuSamplesToProcessTimeline({
    samples: gpuCollection.samples,
    candidateRootPid: rootIdentity.pid,
    candidateRootCreationDate: rootIdentity.creationDate,
    expectedSamples: Math.ceil(
      WINDOWS_OBS_TIMING.measurementMs / WINDOWS_OBS_TIMING.sampleIntervalMs
    ),
    intervalMs: WINDOWS_OBS_TIMING.sampleIntervalMs,
    parseInstance: runtime.parseWindowsGpuCounterInstance
  })
  const gpuSummary = runtime.summarizeWindowsGpuSamples({
    samples: gpuAttribution.samples,
    expectedSamples: Math.ceil(
      WINDOWS_OBS_TIMING.measurementMs / WINDOWS_OBS_TIMING.sampleIntervalMs
    ),
    processIds: gpuAttribution.processIds,
    adapterLuid: adapterLuidForGpu(mapping.display.videorc.adapterLuid)
  })
  const gpuBlockers = [
    ...gpuAttribution.blockers,
    ...gpuSummary.blockers,
    ...(gpuCollection.exitCode === 0 && !gpuCollection.error
      ? []
      : [
          `GPU collector failed (exit ${gpuCollection.exitCode ?? 'missing'}): ${
            gpuCollection.error ?? 'no completion evidence'
          }`
        ])
  ]
  gpuEvidence = {
    verdict: gpuBlockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers: gpuBlockers,
    summary: gpuSummary.summary
  }
  if (gpuEvidence.verdict !== 'PASS') {
    throw new BlockedRunError(gpuEvidence.blockers.join('; '))
  }

  await writeJsonNew(artifacts.process, {
    telemetry: processTelemetry,
    readiness: processReadiness,
    summary: processSummary
  })
  await writeJsonNew(artifacts.gpu, {
    collection: gpuCollection,
    attribution: gpuAttribution,
    evidence: gpuEvidence
  })
  assertNoSecrets(
    JSON.stringify(statusTimeline),
    [target.streamKey, target.listenerUrl],
    'application status timeline'
  )
  await writeJsonNew(artifacts.status, statusTimeline)
  await writeJsonNew(artifacts.stimulus, {
    manifestSha256: stimulusAttestation.manifestSha256,
    liveness: stimuli.liveness,
    teardown: stimulusStop
  })

  const pipeline =
    runPlan.app === 'videorc'
      ? evaluateVideorcPipeline(statusTimeline, {
          requireD3d11,
          expectedAdapterLuid: mapping.display.videorc.adapterLuid
        })
      : {
          verdict: statusTimeline.verdict === 'PASS' ? 'PASS' : 'BLOCKED',
          failures: [],
          blockers: statusTimeline.blockers ?? [],
          zeroCopyVerdict: 'NOT_APPLICABLE',
          application: 'obs',
          statusSamples: statusTimeline.samples.length,
          streamLifecycle: statusTimeline.lifecycle
        }
  if (pipeline.verdict !== 'PASS') {
    throw new Error(
      `Application pipeline failed: ${[
        ...(pipeline.failures ?? []),
        ...(pipeline.blockers ?? [])
      ].join('; ')}`
    )
  }

  const quality = await runtime.analyzeRecording(artifacts.receiver, {
    ffmpegPath,
    ffprobePath,
    intendedFps: WINDOWS_OBS_SETTINGS.fps,
    expectAudio: true,
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
  await writeJsonNew(artifacts.analyzer, quality)
  const probe = runCaptured(ffprobePath, [
    '-v',
    'error',
    '-show_packets',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    artifacts.receiver
  ])
  await writeFile(artifacts.ffprobe, probe.stdout, { encoding: 'utf8', flag: 'wx' })
  const probeDocument = JSON.parse(probe.stdout)
  const framemd5 = runCaptured(ffmpegPath, [
    '-v',
    'error',
    '-i',
    artifacts.receiver,
    '-map',
    '0:v:0',
    '-f',
    'framemd5',
    '-'
  ])
  await writeFile(artifacts.framemd5, framemd5.stdout, { encoding: 'utf8', flag: 'wx' })
  const avSync = await runtime.measureAvSync(artifacts.receiver, {
    ffmpegPath,
    gates: { targetMs: 60, hardFailMs: 150, requireTarget: true }
  })
  await writeJsonNew(artifacts.avSync, avSync)
  const bitrate = receiverBitrateEvidence(probeDocument.packets, {
    durationSeconds: quality.metrics.durationSeconds
  })
  const mediaFailures = [...(quality.verdict?.failures ?? [])]
  if (
    quality.metrics.width !== WINDOWS_OBS_SETTINGS.width ||
    quality.metrics.height !== WINDOWS_OBS_SETTINGS.height
  ) {
    mediaFailures.push(
      `receiver dimensions were ${quality.metrics.width ?? 'missing'}x${quality.metrics.height ?? 'missing'}`
    )
  }
  const measuredFps =
    quality.metrics.avgFps ?? quality.metrics.nominalFps ?? quality.metrics.observedFps
  if (!Number.isFinite(measuredFps) || Math.abs(measuredFps - WINDOWS_OBS_SETTINGS.fps) > 0.5) {
    mediaFailures.push(`receiver fps was ${measuredFps ?? 'missing'}`)
  }
  const expectedDurationSeconds = WINDOWS_OBS_TIMING.measurementMs / 1_000
  if (
    !Number.isFinite(quality.metrics.durationSeconds) ||
    Math.abs(quality.metrics.durationSeconds - expectedDurationSeconds) / expectedDurationSeconds >
      0.03
  ) {
    mediaFailures.push(`receiver duration was ${quality.metrics.durationSeconds ?? 'missing'}s`)
  }
  if (quality.metrics.codec !== WINDOWS_OBS_SETTINGS.videoCodec) {
    mediaFailures.push(`receiver video codec was ${quality.metrics.codec ?? 'missing'}`)
  }
  const audioStream = probeDocument.streams?.find((stream) => stream?.codec_type === 'audio')
  if (
    Number(audioStream?.sample_rate) !== WINDOWS_OBS_SETTINGS.audioSampleRateHz ||
    Number(audioStream?.channels) !== WINDOWS_OBS_SETTINGS.audioChannels
  ) {
    mediaFailures.push(
      `receiver audio was ${audioStream?.sample_rate ?? 'missing'}Hz/${audioStream?.channels ?? 'missing'}ch`
    )
  }
  if (avSync.verdict?.pass !== true && avSync.pass !== true) {
    mediaFailures.push('A/V alignment stimulus did not pass')
  }
  if (!Number.isFinite(bitrate.measuredBitrateKbps) || bitrate.measuredBitrateKbps <= 0) {
    mediaFailures.push('receiver bitrate evidence was missing')
  }
  const minimumBitrate = WINDOWS_OBS_SETTINGS.bitrateKbps * 0.9
  const maximumBitrate = WINDOWS_OBS_SETTINGS.bitrateKbps * 1.1
  if (
    bitrate.measuredBitrateKbps < minimumBitrate ||
    bitrate.measuredBitrateKbps > maximumBitrate
  ) {
    mediaFailures.push(
      `total receiver bitrate ${bitrate.measuredBitrateKbps}kbps was outside ${minimumBitrate}-${maximumBitrate}kbps`
    )
  }
  if (
    !Array.isArray(bitrate.rollingBitrateKbps) ||
    bitrate.rollingBitrateKbps.some(
      (value) => !Number.isFinite(value) || value < minimumBitrate || value > maximumBitrate
    )
  ) {
    mediaFailures.push('rolling receiver bitrate left the protected ±10% band')
  }
  const media = {
    verdict: quality.verdict?.pass === true && mediaFailures.length === 0 ? 'PASS' : 'FAIL',
    failures: mediaFailures,
    freezeVerdict:
      Number(quality.metrics.longestCorroboratedFreezeMs ?? 0) <=
      WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumFreezeMs
        ? 'PASS'
        : 'FAIL',
    repeatVerdict:
      Number(quality.metrics.maxRepeatedFrameRun ?? 0) <=
      WINDOWS_STREAM_PERFORMANCE_THRESHOLDS.maximumRepeatedFrameRun
        ? 'PASS'
        : 'FAIL',
    metrics: quality.metrics,
    avSync: {
      medianOffsetMs: avSync.medianOffsetMs,
      maxAbsoluteOffsetMs: avSync.maxAbsOffsetMs,
      flashCount: avSync.flashCount,
      clickCount: avSync.clickCount
    },
    bitrate
  }
  if (media.verdict !== 'PASS') {
    throw new Error(`Receiver artifact failed media gates: ${mediaFailures.join('; ')}`)
  }

  const receiverEvidence = {
    verdict:
      receiverExit?.code === 0 &&
      receiverExit?.signal == null &&
      measurementClock.endSkewMs <= WINDOWS_OBS_TIMING.sampleIntervalMs * 2 &&
      statusTimeline?.lifecycle?.verdict === 'PASS'
        ? 'PASS'
        : 'FAIL',
    exit: receiverExit,
    measurementClock,
    publisherLifecycle: statusTimeline?.lifecycle ?? null,
    target: safeRtmpTargetIdentity(target)
  }
  if (receiverEvidence.verdict !== 'PASS') {
    throw new Error('Receiver lifecycle/measurement clock failed.')
  }
  const teardownClean =
    publisherStop?.clean === true && publisherStop?.forced !== true && stimulusStop?.clean === true
  const artifactPaths = [
    artifacts.receiver,
    artifacts.ffprobe,
    artifacts.framemd5,
    artifacts.analyzer,
    artifacts.avSync,
    artifacts.process,
    artifacts.gpu,
    artifacts.status,
    artifacts.stimulus,
    artifacts.settings,
    ...(supportBundlePresent ? [artifacts.supportBundle] : []),
    ...(publisher?.evidencePaths ?? [])
  ]
  const hashedArtifacts = await Promise.all(
    artifactPaths.map(async (path) => ({
      path,
      sha256: await sha256File(path),
      bytes: statSync(path).size
    }))
  )
  const supportArtifacts = hashedArtifacts.filter(
    (artifact) => resolve(artifact.path) === resolve(artifacts.supportBundle)
  )
  if (
    (runPlan.app === 'videorc' &&
      (!supportBundlePresent ||
        supportArtifacts.length !== 1 ||
        !supportBundleValidation ||
        supportArtifacts[0].sha256 !== supportBundleValidatedSha256)) ||
    (runPlan.app === 'obs' && supportArtifacts.length !== 0)
  ) {
    throw new BlockedRunError('OBS comparison support-bundle cardinality was invalid.')
  }
  const report = {
    schemaVersion: 1,
    kind: 'videorc.windows-obs-side-by-side-run',
    index: runPlan.index,
    app: runPlan.app,
    scenario: WINDOWS_OBS_SCENARIO,
    clean: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    bootId: hardware.bootId,
    hardwareClass: hardware.hardwareClass,
    timing: WINDOWS_OBS_TIMING,
    settingsSha256: settings.sha256,
    candidateSha256: runPlan.app === 'videorc' ? candidate.sha256 : undefined,
    candidate: runPlan.app === 'videorc' ? candidate : undefined,
    obs: runPlan.app === 'obs' ? obs : undefined,
    stimulus: {
      verdict: stimuli.liveness.verdict,
      manifestSha256: stimulusAttestation.manifestSha256,
      teardownClean: stimulusStop.clean === true,
      liveness: stimuli.liveness
    },
    media,
    pipeline,
    supportBundle:
      runPlan.app === 'videorc'
        ? { ...supportBundleValidation, ...supportArtifacts[0] }
        : { verdict: 'NOT_APPLICABLE' },
    receiver: receiverEvidence,
    process: {
      ...processSummary,
      rootIdentity,
      telemetryVerdict: processReadiness.verdict,
      telemetryBlockers: processReadiness.blockers,
      teardownClean,
      forced: publisherStop?.forced === true,
      applicationTeardown: publisherStop,
      stimulusTeardown: stimulusStop
    },
    gpu: gpuEvidence,
    artifacts: hashedArtifacts,
    reportPath: runPlan.reportPath
  }
  assertNoSecrets(JSON.stringify(report), [target.streamKey, target.listenerUrl], 'run report')
  const preparedReport = await prepareExclusiveJsonArtifact(runPlan.reportPath, report)
  const publishedReport = await finalizePreparedJsonArtifact(preparedReport, revalidateCandidate)
  return {
    ...report,
    reportSha256: publishedReport.sha256
  }
}

function printList() {
  console.log(
    [
      'Windows OBS side-by-side protected calibration',
      `scenario: ${WINDOWS_OBS_SCENARIO}`,
      `order: ${WINDOWS_OBS_REQUIRED_ORDER.join(',')}`,
      `timing: warm-up ${WINDOWS_OBS_TIMING.warmupMs}ms; measurement ${WINDOWS_OBS_TIMING.measurementMs}ms; sample ${WINDOWS_OBS_TIMING.sampleIntervalMs}ms`,
      `video: ${WINDOWS_OBS_SETTINGS.width}x${WINDOWS_OBS_SETTINGS.height}@${WINDOWS_OBS_SETTINGS.fps}; H.264 ${WINDOWS_OBS_SETTINGS.rateControl} ${WINDOWS_OBS_SETTINGS.bitrateKbps}kbps; GOP ${WINDOWS_OBS_SETTINGS.keyframeIntervalSeconds}s`,
      'execution: physical Windows 11 x64; installed signed Videorc; signed OBS portable copy; local RTMP only',
      `D3D11 derivation classes: ${WINDOWS_OBS_D3D11_HARDWARE_CLASSES.join(',')}`,
      'list/derive modes are non-launch operations; calibration never reports success on a non-Windows host'
    ].join('\n')
  )
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
    nativeScreen,
    releaseHelpers,
    gpuSampler,
    supportBundleVerifier,
    performanceSampling,
    session
  ] = await Promise.all([
    import('./lib/app-launcher.mjs'),
    import('./lib/recording-analyzer.mjs'),
    import('./lib/av-sync.mjs'),
    import('./lib/av-sync-stimulus.mjs'),
    import('./lib/screen-motion-stimulus.mjs'),
    import('./lib/process-endurance.mjs'),
    import('./lib/process-census.mjs'),
    import('./lib/windows-native-screen-gates.mjs'),
    import('./lib/windows-alpha-release.mjs'),
    import('./lib/windows-gpu-sampler.mjs'),
    import('./lib/support-bundle-verifier.mjs'),
    import('./lib/performance-sampling-schedule.mjs'),
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
    ...nativeScreen,
    ...releaseHelpers,
    ...gpuSampler,
    ...supportBundleVerifier,
    ...performanceSampling,
    ...session
  }
}

async function loadLegacyCalibrations(inputPath) {
  const documents = await loadJsonEvidenceDocuments(inputPath)
  const direct = documents.flatMap(({ value }) =>
    Array.isArray(value?.calibrations)
      ? value.calibrations
      : value?.kind === 'videorc.windows-stream-performance-calibration'
        ? [value]
        : []
  )
  if (direct.length === 0) {
    throw new BlockedRunError(
      'The stream-calibration root contained no explicit Windows stream calibration documents.'
    )
  }
  return direct
}

async function loadD3d11CalibrationRoot(rootPath) {
  if (!isAbsolutePortable(rootPath)) {
    throw new BlockedRunError('D3D11 stream calibration roots must be absolute.')
  }
  const resolvedRoot = portableResolve(rootPath)
  const documents = await loadJsonEvidenceDocuments(resolvedRoot)
  const rootDirectory = statSync(resolvedRoot).isDirectory() ? resolvedRoot : dirname(resolvedRoot)
  const rootAggregate = documents.find(
    ({ value }) => value?.kind === 'videorc.windows-stream-performance-aggregate'
  )
  const direct = documents.flatMap(({ path, value }) => {
    if (value?.kind === 'videorc.windows-d3d11-stream-calibration') {
      return [
        {
          ...value,
          aggregatePath: resolveEvidencePath(path, value.aggregatePath ?? path),
          aggregateSha256: value.aggregateSha256 ?? null,
          sourceDocumentPath: path
        }
      ]
    }
    if (Array.isArray(value?.d3d11Calibrations)) {
      return value.d3d11Calibrations.map((calibration) => ({
        ...calibration,
        aggregatePath: resolveEvidencePath(path, calibration.aggregatePath ?? path),
        aggregateSha256: calibration.aggregateSha256 ?? null,
        sourceDocumentPath: path
      }))
    }
    return []
  })
  if (direct.length === 0) {
    throw new BlockedRunError(
      `${rootPath} contained no videorc.windows-d3d11-stream-calibration evidence. The derivation runner does not infer protected contexts from loose run files.`
    )
  }
  const aggregateSha256 = rootAggregate
    ? await sha256File(rootAggregate.path)
    : await sha256DirectoryManifest(rootPath)
  const normalized = await Promise.all(
    direct.map(async (calibration) => {
      const aggregatePath = portableResolve(calibration.aggregatePath)
      if (!pathInside(rootDirectory, aggregatePath)) {
        throw new BlockedRunError(
          `Calibration ${calibration.id ?? '<unknown>'} aggregate escaped its supplied evidence root.`
        )
      }
      if (!existsSync(aggregatePath) || !statSync(aggregatePath).isFile()) {
        throw new BlockedRunError(
          `Calibration ${calibration.id ?? '<unknown>'} aggregate file was missing: ${aggregatePath}`
        )
      }
      const actualSha256 = await sha256File(aggregatePath)
      if (calibration.aggregateSha256 && calibration.aggregateSha256 !== actualSha256) {
        throw new BlockedRunError(
          `Calibration ${calibration.id ?? '<unknown>'} aggregate digest did not match its retained file.`
        )
      }
      const { sourceDocumentPath: _, ...retained } = calibration
      return {
        ...retained,
        aggregatePath,
        aggregateSha256: actualSha256
      }
    })
  )
  return {
    root: resolvedRoot,
    aggregatePath: rootAggregate?.path ?? resolvedRoot,
    aggregateSha256,
    calibrations: normalized
  }
}

function resolveEvidencePath(sourceDocumentPath, requestedPath) {
  return isAbsolutePortable(requestedPath)
    ? portableResolve(requestedPath)
    : resolve(dirname(sourceDocumentPath), requestedPath)
}

function pathInside(root, candidate) {
  const child = relative(root, candidate)
  return child === '' || (!/^\.\.(?:[\\/]|$)/.test(child) && !isAbsolute(child))
}

async function loadJsonEvidenceDocuments(inputPath) {
  const absolute = portableResolve(inputPath)
  if (!existsSync(absolute)) {
    throw new BlockedRunError(`Evidence path does not exist: ${absolute}`)
  }
  if (statSync(absolute).isFile()) {
    return [{ path: absolute, value: await readJson(absolute) }]
  }
  const files = await walkFiles(absolute)
  const jsonPaths = files.filter((path) => path.toLocaleLowerCase('en-US').endsWith('.json'))
  const documents = []
  for (const path of jsonPaths) {
    try {
      documents.push({ path, value: await readJson(path) })
    } catch {
      // A malformed JSON evidence file is not silently consumed as a calibration.
    }
  }
  return documents
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? await walkFiles(path) : entry.isFile() ? [path] : []
      })
  )
  return nested.flat()
}

async function sha256DirectoryManifest(directory) {
  const files = (await walkFiles(directory)).filter(
    (path) => basename(path).toLocaleLowerCase('en-US') !== 'service.json'
  )
  const entries = await Promise.all(
    files.map(async (path) => ({
      path: relative(directory, path).replaceAll('\\', '/'),
      sha256: await sha256File(path)
    }))
  )
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new BlockedRunError(`${name} is required.`)
  return value
}

function requiredAbsoluteEnvironmentPath(name) {
  const value = requiredEnvironment(name)
  if (!isAbsolutePortable(value)) {
    throw new BlockedRunError(`${name} must be an absolute path.`)
  }
  return portableResolve(value)
}

function requiredLowercaseHexEnvironment(name, length) {
  const value = requiredEnvironment(name)
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new BlockedRunError(`${name} must be lowercase ${length}-hex.`)
  }
  return value
}

function positiveNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new BlockedRunError(`${label} must be a positive number.`)
  }
  return number
}

function resolveObsEncoderId(hardwareClass) {
  const explicit = process.env.VIDEORC_OBS_ENCODER_ID?.trim()
  if (explicit) return explicit
  if (hardwareClass === 'nvidia-turing-floor' || hardwareClass === 'win11-i5-8400-gtx1650-super') {
    return 'obs_nvenc_h264_tex'
  }
  if (hardwareClass === 'intel-xe-integrated') return 'obs_qsv11_v2'
  throw new BlockedRunError(
    `VIDEORC_OBS_ENCODER_ID is required for unknown hardware class ${hardwareClass}.`
  )
}

function acceptanceAppEnvironment({ profileDirectory, evidenceDirectory, selectionEnvironment }) {
  return {
    ...selectionEnvironment,
    VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: profileDirectory,
    VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '1',
    VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: requiredEnvironment(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256'
    ),
    VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: requiredEnvironment(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256'
    ),
    VIDEORC_WINDOWS_ACCEPTANCE_DIR: evidenceDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_PACKAGED_SMOKE_TEST: '1'
  }
}

async function authenticodeIdentity(path) {
  const escapedPath = path.replaceAll("'", "''")
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    `$file = Get-Item -LiteralPath '${escapedPath}'`,
    '[pscustomobject]@{',
    'Status = [string]$signature.Status;',
    'StatusMessage = [string]$signature.StatusMessage;',
    'SignerSubject = [string]$signature.SignerCertificate.Subject;',
    'SignerThumbprint = [string]$signature.SignerCertificate.Thumbprint;',
    'FileVersion = [string]$file.VersionInfo.FileVersion;',
    'ProductVersion = [string]$file.VersionInfo.ProductVersion',
    '} | ConvertTo-Json -Compress'
  ].join(' ')
  const result = runCaptured('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ])
  const parsed = JSON.parse(result.stdout)
  return {
    status: parsed.Status ?? null,
    statusMessage: parsed.StatusMessage ?? null,
    signerSubject: parsed.SignerSubject ?? null,
    signerThumbprint: parsed.SignerThumbprint?.toLocaleLowerCase('en-US') ?? null,
    fileVersion: parsed.FileVersion ?? null,
    productVersion: parsed.ProductVersion ?? null
  }
}

function requireValidSignature(identity, requiredPublisher, label) {
  if (identity?.status !== 'Valid') {
    throw new BlockedRunError(
      `${label} Authenticode status was ${identity?.status ?? 'missing'}: ${identity?.statusMessage ?? 'no status message'}`
    )
  }
  if (
    requiredPublisher &&
    !identity?.signerSubject
      ?.toLocaleLowerCase('en-US')
      .includes(requiredPublisher.toLocaleLowerCase('en-US'))
  ) {
    throw new BlockedRunError(
      `${label} signer subject did not contain VIDEORC_WINDOWS_PUBLISHER_NAME.`
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(identity?.signerThumbprint ?? '')) {
    throw new BlockedRunError(`${label} signer thumbprint was missing.`)
  }
}

function parseObsVersion(value) {
  const match = /OBS(?: Studio)?\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][^\s]+)?)/i.exec(
    String(value ?? '')
  )
  if (!match) throw new BlockedRunError('OBS --version did not return a parseable version.')
  return match[1]
}

async function collectWindowsHardwareProvenance(hardwareClass, { requireD3d11 = false } = {}) {
  if (requireD3d11 && !WINDOWS_OBS_D3D11_HARDWARE_CLASSES.includes(hardwareClass)) {
    throw new BlockedRunError(
      `Protected D3D11 comparison hardware class must be one of ${WINDOWS_OBS_D3D11_HARDWARE_CLASSES.join(', ')}.`
    )
  }
  const script = [
    '$os = Get-CimInstance Win32_OperatingSystem;',
    '$cs = Get-CimInstance Win32_ComputerSystem;',
    '$bios = Get-CimInstance Win32_BIOS;',
    '$cpu = @(Get-CimInstance Win32_Processor | Select-Object Name,Manufacturer,ProcessorId);',
    '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion,AdapterRAM);',
    '[pscustomobject]@{',
    'osCaption=$os.Caption; osVersion=$os.Version; osBuild=$os.BuildNumber;',
    'lastBootUpTime=$os.LastBootUpTime.ToUniversalTime().ToString("o");',
    'manufacturer=$cs.Manufacturer; model=$cs.Model; totalPhysicalMemory=[int64]$cs.TotalPhysicalMemory;',
    'biosSerial=$bios.SerialNumber; biosVersion=[string]$bios.SMBIOSBIOSVersion;',
    'cpu=$cpu; gpu=$gpu',
    '} | ConvertTo-Json -Depth 6 -Compress'
  ].join(' ')
  const raw = JSON.parse(
    runCaptured('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
      .stdout
  )
  const bootTimestampMs = Date.parse(raw.lastBootUpTime)
  const maximumBootAgeMinutes = positiveNumber(
    process.env.VIDEORC_WINDOWS_MAX_BOOT_AGE_MINUTES ?? '120',
    'VIDEORC_WINDOWS_MAX_BOOT_AGE_MINUTES'
  )
  const bootAgeMinutes = (Date.now() - bootTimestampMs) / 60_000
  if (
    !Number.isFinite(bootTimestampMs) ||
    bootAgeMinutes < 0 ||
    bootAgeMinutes > maximumBootAgeMinutes
  ) {
    throw new BlockedRunError(
      `The Windows boot was not within the protected ${maximumBootAgeMinutes}-minute clean-boot window.`
    )
  }
  const fingerprintFields = {
    manufacturer: raw.manufacturer,
    model: raw.model,
    biosSerial: raw.biosSerial,
    cpu: raw.cpu,
    gpu: raw.gpu
  }
  return {
    hardwareClass,
    operatingSystem: {
      platform: process.platform,
      arch: process.arch,
      release: release(),
      caption: raw.osCaption,
      version: raw.osVersion,
      build: raw.osBuild
    },
    bootId: createHash('sha256').update(raw.lastBootUpTime).digest('hex'),
    bootedAt: raw.lastBootUpTime,
    bootAgeMinutes,
    cleanBootWindowVerified: true,
    cleanBootAttested: process.env.VIDEORC_WINDOWS_CLEAN_BOOT_ATTESTED === '1' ? true : null,
    fingerprint: createHash('sha256').update(JSON.stringify(fingerprintFields)).digest('hex'),
    system: {
      manufacturer: raw.manufacturer,
      model: raw.model,
      totalPhysicalMemory: raw.totalPhysicalMemory,
      biosVersion: raw.biosVersion,
      cpu: (Array.isArray(raw.cpu) ? raw.cpu : [raw.cpu])
        .filter(Boolean)
        .map(({ Name, Manufacturer }) => ({ name: Name, manufacturer: Manufacturer })),
      gpu: (Array.isArray(raw.gpu) ? raw.gpu : [raw.gpu])
        .filter(Boolean)
        .map(({ Name, DriverVersion, AdapterRAM }) => ({
          name: Name,
          driverVersion: DriverVersion,
          adapterRam: AdapterRAM
        }))
    }
  }
}

async function createObsPortableCopy({ runtime, inputExecutable, inputSha256, destination }) {
  const segments = win32.normalize(inputExecutable).split('\\')
  const binIndex = segments.findIndex(
    (segment, index) =>
      segment.toLocaleLowerCase('en-US') === 'bin' &&
      segments[index + 1]?.toLocaleLowerCase('en-US') === '64bit'
  )
  if (binIndex <= 0 || segments.at(-1)?.toLocaleLowerCase('en-US') !== 'obs64.exe') {
    throw new BlockedRunError(
      'VIDEORC_OBS_EXECUTABLE must identify the canonical obs-studio\\bin\\64bit\\obs64.exe.'
    )
  }
  const sourceRoot = segments.slice(0, binIndex).join('\\')
  const destinationRoot = join(destination, 'obs-studio')
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    errorOnExist: true,
    force: false
  })
  const executable = join(destinationRoot, 'bin', '64bit', 'obs64.exe')
  const sha256 = await runtime.sha256File(executable)
  if (sha256 !== inputSha256) {
    throw new BlockedRunError('The OBS portable-copy executable digest changed during copy.')
  }
  await writeFile(join(destinationRoot, 'portable_mode.txt'), '', {
    encoding: 'utf8',
    flag: 'wx'
  })
  return { sourceRoot, root: destinationRoot, executable, sha256 }
}

async function assertExactExecutablesAbsent(executables) {
  const normalized = [
    ...new Set(
      executables.map((path) =>
        win32.normalize(path).replaceAll("'", "''").toLocaleLowerCase('en-US')
      )
    )
  ]
  const literals = normalized.map((path) => `'${path}'`).join(',')
  const script = [
    `$wanted = @(${literals});`,
    '$matches = @(Get-CimInstance Win32_Process | Where-Object {',
    '$p = ([string]$_.ExecutablePath).ToLowerInvariant(); $wanted -contains $p',
    '} | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath);',
    '$matches | ConvertTo-Json -Compress'
  ].join(' ')
  const stdout = runCaptured('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ]).stdout.trim()
  const parsed = stdout ? JSON.parse(stdout) : []
  const matches = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  if (matches.length > 0) {
    throw new BlockedRunError(
      `A comparison executable was already running (${matches
        .map((row) => `${row.ExecutablePath}:${row.ProcessId}`)
        .join(', ')}). Close it and rerun; the runner never performs broad cleanup.`
    )
  }
}

async function preflightVideorc({
  runtime,
  spawnSpec,
  appEnvironment,
  ffmpegPath,
  displayId,
  audioId,
  displayBounds,
  displayRefreshHz,
  candidateSha256,
  candidatePayloadSha256
}) {
  await assertCandidateIdentity(
    runtime,
    spawnSpec.command,
    candidateSha256,
    candidatePayloadSha256,
    'before Videorc endpoint preflight'
  )
  const launched = await runtime.launchDevApp({
    spawnSpec,
    timeoutMs: timeoutMs(),
    requiredMarkers: ['backend-ready'],
    env: {
      ...appEnvironment,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    }
  })
  let ws = null
  const preflightRootIdentity = await pinRootProcessIdentity(launched.process.pid)
  assertRootExecutable(
    preflightRootIdentity,
    spawnSpec.command,
    'Videorc endpoint-preflight root process'
  )
  let pinnedIdentities = [preflightRootIdentity]
  try {
    ws = await runtime.connectBackend(launched.connections['backend-ready'], timeoutMs())
    const health = await runtime.request(ws, timeoutMs(), 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new BlockedRunError(
        health?.ffmpeg?.message ?? 'The installed candidate FFmpeg health check failed.'
      )
    }
    const listed = await runtime.request(ws, timeoutMs(), 'devices.list', { ffmpegPath })
    const devices = Array.isArray(listed?.devices) ? listed.devices : []
    const screen = devices.find(
      (device) =>
        device?.id === displayId &&
        device?.kind === 'screen' &&
        device?.status === 'available' &&
        /^screen:dxgi:[0-9a-f]{16}:\d+$/i.test(device.id)
    )
    if (!screen) {
      throw new BlockedRunError(
        `The required physical DXGI source ${displayId} was unavailable in the installed candidate.`
      )
    }
    const microphone = devices.find(
      (device) =>
        device?.id === audioId && device?.kind === 'microphone' && device?.status === 'available'
    )
    if (!microphone) {
      throw new BlockedRunError(
        `The required Videorc audio input ${audioId} was unavailable in the installed candidate.`
      )
    }
    const sourceMatch = /^screen:dxgi:([0-9a-f]{16}):(\d+)$/i.exec(screen.id)
    const deviceName = parseWindowsDxgiOutputDeviceName(screen.detail)
    const operatingSystemDisplay = collectWindowsDisplayIdentity(deviceName)
    if (
      screen.width !== operatingSystemDisplay.desktopBounds.width ||
      screen.height !== operatingSystemDisplay.desktopBounds.height
    ) {
      throw new BlockedRunError(
        'Videorc DXGI dimensions did not match the canonical Win32 display mode.'
      )
    }
    if (
      displayBounds &&
      stableJson(displayBounds) !== stableJson(operatingSystemDisplay.desktopBounds)
    ) {
      throw new BlockedRunError(
        'VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS did not match the canonical Win32 display mode.'
      )
    }
    if (displayRefreshHz && Math.abs(displayRefreshHz - operatingSystemDisplay.refreshHz) > 0.01) {
      throw new BlockedRunError(
        'VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_REFRESH_HZ did not match the canonical Win32 display mode.'
      )
    }
    const endpointId =
      extractWindowsAudioEndpointId(microphone.symbolicLink) ??
      extractWindowsAudioEndpointId(microphone.detail) ??
      extractWindowsAudioEndpointId(microphone.id) ??
      (await resolveCoreAudioCaptureEndpoint(microphone))
    if (!endpointId) {
      throw new BlockedRunError(
        'Videorc did not expose an authoritative Core Audio endpoint GUID for the selected input.'
      )
    }
    const preview = await runtime.request(ws, timeoutMs(), 'preview.screen.start', {
      sources: { screenId: screen.id, microphoneId: microphone.id, testPattern: false },
      layout: screenOnlyLayout(),
      video: {
        preset: 'custom',
        width: WINDOWS_OBS_SETTINGS.width,
        height: WINDOWS_OBS_SETTINGS.height,
        fps: WINDOWS_OBS_SETTINGS.fps,
        bitrateKbps: WINDOWS_OBS_SETTINGS.bitrateKbps
      },
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (preview?.state !== 'live') {
      throw new BlockedRunError(
        `Videorc source preflight did not become live: ${preview?.message ?? preview?.state ?? 'unknown'}`
      )
    }
    await waitForVideorcPreview(runtime, ws, screen.id)
    await runtime.request(ws, timeoutMs(), 'preview.screen.stop')
    pinnedIdentities = await pinProcessTree(
      runtime,
      launched.process.pid,
      'Videorc endpoint preflight'
    )
    return {
      screen,
      microphone,
      display: {
        deviceName,
        adapterLuid: sourceMatch[1],
        outputIndex: Number(sourceMatch[2]),
        desktopBounds: operatingSystemDisplay.desktopBounds,
        refreshHz: operatingSystemDisplay.refreshHz
      },
      audio: {
        endpointId,
        friendlyName: microphone.name ?? null,
        selectedDeviceId: microphone.id,
        symbolicLinkPresent: Boolean(microphone.symbolicLink)
      },
      health: { ffmpegAvailable: true }
    }
  } finally {
    if (ws) ws.close()
    await launched.stop().catch(() => undefined)
    const processExit = await evaluateExitedProcessIdentities(
      runtime,
      launched.process.pid,
      pinnedIdentities
    )
    if (processExit.verdict !== 'PASS') {
      throw new BlockedRunError(
        'Videorc endpoint preflight did not tear down its exact process tree.'
      )
    }
    await assertCandidateIdentity(
      runtime,
      spawnSpec.command,
      candidateSha256,
      candidatePayloadSha256,
      'after Videorc endpoint preflight'
    )
  }
}

function collectWindowsDisplayIdentity(deviceName) {
  if (!/^\\\\\.\\DISPLAY\d+$/i.test(deviceName)) {
    throw new BlockedRunError(
      `Videorc did not expose a canonical Win32 display device name (${deviceName || 'missing'}).`
    )
  }
  const typeDefinition = String.raw`
using System;
using System.Runtime.InteropServices;

public static class VideorcCurrentDisplayMode
{
    private const int EnumCurrentSettings = -1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        public short SpecVersion;
        public short DriverVersion;
        public short Size;
        public short DriverExtra;
        public int Fields;
        public int PositionX;
        public int PositionY;
        public int DisplayOrientation;
        public int DisplayFixedOutput;
        public short Color;
        public short Duplex;
        public short YResolution;
        public short TTOption;
        public short Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FormName;
        public short LogPixels;
        public int BitsPerPel;
        public int PelsWidth;
        public int PelsHeight;
        public int DisplayFlags;
        public int DisplayFrequency;
        public int ICMMethod;
        public int ICMIntent;
        public int MediaType;
        public int DitherType;
        public int Reserved1;
        public int Reserved2;
        public int PanningWidth;
        public int PanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettings(
        string deviceName,
        int modeNumber,
        ref DevMode mode
    );

    public static object Get(string deviceName)
    {
        var mode = new DevMode();
        mode.Size = (short)Marshal.SizeOf(typeof(DevMode));
        if (!EnumDisplaySettings(deviceName, EnumCurrentSettings, ref mode))
        {
            throw new InvalidOperationException(
                "EnumDisplaySettings failed for " + deviceName + "."
            );
        }
        return new
        {
            deviceName,
            x = mode.PositionX,
            y = mode.PositionY,
            width = mode.PelsWidth,
            height = mode.PelsHeight,
            refreshHz = mode.DisplayFrequency
        };
    }
}`
  const escapedDeviceName = deviceName.replaceAll("'", "''")
  const script = [
    "$source = @'",
    typeDefinition,
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop;',
    `$mode = [VideorcCurrentDisplayMode]::Get('${escapedDeviceName}');`,
    '$mode | ConvertTo-Json -Compress'
  ].join('\n')
  let parsed
  try {
    const stdout = runCaptured('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ]).stdout.trim()
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new BlockedRunError(
      `The canonical Win32 display mode could not be read for ${deviceName}: ${message(error)}`
    )
  }
  const bounds = {
    x: Number(parsed?.x),
    y: Number(parsed?.y),
    width: Number(parsed?.width),
    height: Number(parsed?.height)
  }
  const refreshHz = Number(parsed?.refreshHz)
  if (
    String(parsed?.deviceName ?? '').toLocaleUpperCase('en-US') !==
      deviceName.toLocaleUpperCase('en-US') ||
    !Number.isInteger(bounds.x) ||
    !Number.isInteger(bounds.y) ||
    !Number.isInteger(bounds.width) ||
    bounds.width <= 0 ||
    !Number.isInteger(bounds.height) ||
    bounds.height <= 0 ||
    !Number.isFinite(refreshHz) ||
    refreshHz <= 0
  ) {
    throw new BlockedRunError(`The canonical Win32 display mode was incomplete for ${deviceName}.`)
  }
  return {
    deviceName,
    desktopBounds: bounds,
    refreshHz
  }
}

async function resolveCoreAudioCaptureEndpoint(microphone) {
  const script = [
    "$root = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture';",
    '$rows = @(Get-ChildItem -LiteralPath $root | ForEach-Object {',
    '$device = Get-ItemProperty -LiteralPath $_.PSPath;',
    '$properties = Get-ItemProperty -LiteralPath (Join-Path $_.PSPath "Properties");',
    '[pscustomobject]@{',
    'endpointId = ("{0.0.1.00000000}." + $_.PSChildName);',
    'friendlyName = [string]$properties."{a45c254e-df1c-4efd-8020-67d146a850e0},2";',
    'deviceState = [int]$device.DeviceState',
    '} });',
    '$rows | ConvertTo-Json -Compress'
  ].join(' ')
  const stdout = runCaptured('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ]).stdout.trim()
  const parsed = stdout ? JSON.parse(stdout) : []
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  const idName = decodeURIComponentSafe(
    String(microphone?.id ?? '').replace(/^microphone:dshow:/i, '')
  )
  const requested = process.env.VIDEORC_WINDOWS_ACCEPTANCE_AUDIO_ENDPOINT_ID?.trim()
  const matches = rows.filter((row) => {
    if (Number(row?.deviceState) !== 1) return false
    if (requested) {
      return (
        extractWindowsAudioEndpointId(row?.endpointId) === extractWindowsAudioEndpointId(requested)
      )
    }
    return [microphone?.name, idName].filter(nonEmpty).some(
      (name) =>
        String(row?.friendlyName ?? '')
          .trim()
          .toLocaleLowerCase('en-US') === String(name).trim().toLocaleLowerCase('en-US')
    )
  })
  if (matches.length !== 1) {
    throw new BlockedRunError(
      `The selected Videorc DirectShow input mapped to ${matches.length} active Core Audio capture endpoints; an exact unique endpoint is required.`
    )
  }
  const endpointId = extractWindowsAudioEndpointId(matches[0].endpointId)
  if (!endpointId) {
    throw new BlockedRunError(
      'The selected Windows Core Audio capture endpoint did not expose a canonical GUID.'
    )
  }
  return endpointId
}

async function waitForVideorcPreview(runtime, ws, sourceId) {
  const deadline = Date.now() + Math.min(timeoutMs(), 30_000)
  let status = null
  while (Date.now() < deadline) {
    status = await runtime.request(ws, timeoutMs(), 'preview.screen.status')
    if (
      status?.state === 'live' &&
      status?.sourceId === sourceId &&
      (Number(status?.framesCaptured) > 0 || status?.sequence != null)
    ) {
      return status
    }
    await sleep(100)
  }
  throw new BlockedRunError(
    `Videorc endpoint preflight did not produce a first DXGI frame: ${JSON.stringify(status)}`
  )
}

async function preflightObs({
  runtime,
  portable,
  monitorId,
  audioDeviceId,
  obsEncoderId,
  obsCliVersion
}) {
  const target = {
    serverUrl: 'rtmp://127.0.0.1:1/live',
    streamKey: 'preflight-not-a-live-secret'
  }
  const profile = buildWindowsObsPortableProfile({
    monitorId,
    audioDeviceId,
    serverUrl: target.serverUrl,
    streamKey: target.streamKey,
    obsEncoderId
  })
  const control = await launchObsControl({
    runtime,
    portable,
    profile,
    expectedExecutableSha256: portable.sha256
  })
  try {
    const [version, inputKindList, encoderKindList, videoSettings] = await Promise.all([
      control.request('GetVersion'),
      control.request('GetInputKindList', {
        unversioned: false
      }),
      control.request('GetEncoderKindList'),
      control.request('GetVideoSettings')
    ])
    if (
      !Array.isArray(inputKindList?.inputKinds) ||
      !inputKindList.inputKinds.includes('monitor_capture') ||
      !inputKindList.inputKinds.includes('wasapi_input_capture')
    ) {
      throw new BlockedRunError(
        'OBS portable preflight did not expose monitor_capture and wasapi_input_capture.'
      )
    }
    if (
      !Array.isArray(encoderKindList?.encoderKinds) ||
      !encoderKindList.encoderKinds.includes(obsEncoderId)
    ) {
      throw new BlockedRunError(
        `OBS portable preflight did not expose required encoder ${obsEncoderId}.`
      )
    }
    if (
      videoSettings?.baseWidth !== WINDOWS_OBS_SETTINGS.width ||
      videoSettings?.baseHeight !== WINDOWS_OBS_SETTINGS.height ||
      videoSettings?.outputWidth !== WINDOWS_OBS_SETTINGS.width ||
      videoSettings?.outputHeight !== WINDOWS_OBS_SETTINGS.height ||
      videoSettings?.fpsNumerator / videoSettings?.fpsDenominator !== WINDOWS_OBS_SETTINGS.fps
    ) {
      throw new BlockedRunError(
        'OBS portable preflight did not load the exact 1920x1080@60 video settings.'
      )
    }
    const [displaySettings, displayItems, audioSettings, audioItems] = await Promise.all([
      control.request('GetInputSettings', { inputName: profile.displayInputName }),
      control.request('GetInputPropertiesListPropertyItems', {
        inputName: profile.displayInputName,
        propertyName: 'monitor_id'
      }),
      control.request('GetInputSettings', { inputName: profile.audioInputName }),
      control.request('GetInputPropertiesListPropertyItems', {
        inputName: profile.audioInputName,
        propertyName: 'device_id'
      })
    ])
    const selectedMonitor =
      displaySettings?.inputSettings?.monitor_id ?? displaySettings?.inputSettings?.monitor ?? null
    const selectedAudio = audioSettings?.inputSettings?.device_id ?? null
    if (String(selectedMonitor) !== String(monitorId)) {
      throw new BlockedRunError(
        `OBS selected monitor ${selectedMonitor ?? '<missing>'}, not VIDEORC_OBS_MONITOR_ID.`
      )
    }
    if (String(selectedAudio) !== String(audioDeviceId)) {
      throw new BlockedRunError(
        'OBS selected audio property did not match VIDEORC_OBS_AUDIO_DEVICE_ID.'
      )
    }
    const monitorItem = selectedPropertyItem(displayItems, selectedMonitor)
    const audioItem = selectedPropertyItem(audioItems, selectedAudio)
    if (!monitorItem || !audioItem) {
      throw new BlockedRunError(
        'OBS could not bind the configured display/audio values to enabled property-list items.'
      )
    }
    const endpointId =
      extractWindowsAudioEndpointId(audioItem.itemValue) ??
      extractWindowsAudioEndpointId(audioItem.itemName)
    if (!endpointId) {
      throw new BlockedRunError(
        'OBS did not expose an authoritative Core Audio endpoint GUID for the selected WASAPI item.'
      )
    }
    const deviceName = extractObsDisplayDeviceName(
      monitorItem.itemValue,
      monitorItem.itemName,
      selectedMonitor
    )
    if (!deviceName) {
      throw new BlockedRunError(
        'OBS monitor properties did not expose a canonical \\\\.\\DISPLAYn identity.'
      )
    }
    const rpcVersion = String(version?.obsVersion ?? '').trim()
    if (!rpcVersion || !sameVersionPrefix(rpcVersion, obsCliVersion)) {
      throw new BlockedRunError(
        `OBS CLI/RPC versions differed (${obsCliVersion} versus ${rpcVersion || 'missing'}).`
      )
    }
    return {
      version: rpcVersion,
      websocketRpcVersion: version?.rpcVersion ?? null,
      display: {
        deviceName,
        selectedValue: String(selectedMonitor),
        selectedItemName: String(monitorItem.itemName ?? ''),
        selectedItemValue: String(monitorItem.itemValue ?? '')
      },
      audio: {
        endpointId,
        friendlyName: String(audioItem.itemName ?? ''),
        selectedValue: String(selectedAudio)
      }
    }
  } finally {
    const teardown = await control.stop()
    if (teardown.clean !== true) {
      throw new BlockedRunError('OBS portable preflight did not tear down its exact process tree.')
    }
  }
}

function buildEndpointMapping({ videorcPreflight, obsPreflight }) {
  const obsDisplay = {
    deviceName: obsPreflight.display.deviceName,
    adapterLuid: videorcPreflight.display.adapterLuid,
    outputIndex: videorcPreflight.display.outputIndex,
    desktopBounds: videorcPreflight.display.desktopBounds,
    refreshHz: videorcPreflight.display.refreshHz
  }
  const result = evaluateWindowsObsEndpointMapping({
    videorc: {
      display: videorcPreflight.display,
      audio: videorcPreflight.audio
    },
    obs: {
      display: obsDisplay,
      audio: obsPreflight.audio
    }
  })
  return {
    ...result,
    authority: {
      videorc: 'devices.list + canonical DXGI source/detail',
      obs: 'obs-websocket GetInputSettings + enabled property-list item',
      displayJoin: 'canonical Win32 DISPLAY device name',
      audioJoin: 'Core Audio endpoint GUID'
    },
    obsSelection: {
      display: obsPreflight.display,
      audio: obsPreflight.audio
    }
  }
}

function selectedPropertyItem(response, selectedValue) {
  return (response?.propertyItems ?? []).find(
    (item) => item?.itemEnabled !== false && String(item?.itemValue) === String(selectedValue)
  )
}

function extractObsDisplayDeviceName(...values) {
  for (const value of values) {
    const match = /(\\\\\.\\DISPLAY[1-9]\d*)/iu.exec(String(value ?? ''))
    if (match) return match[1].toLocaleUpperCase('en-US')
  }
  return null
}

function sameVersionPrefix(left, right) {
  const normalize = (value) => String(value).match(/[0-9]+(?:\.[0-9]+){1,3}/)?.[0] ?? null
  const leftVersion = normalize(left)
  const rightVersion = normalize(right)
  return Boolean(
    leftVersion &&
    rightVersion &&
    (leftVersion === rightVersion ||
      leftVersion.startsWith(`${rightVersion}.`) ||
      rightVersion.startsWith(`${leftVersion}.`))
  )
}

async function attestStimulus({ runtime, screen, bounds, ffmpegPath }) {
  const browserPath = requiredAbsoluteEnvironmentPath('VIDEORC_STIMULUS_BROWSER')
  if (!existsSync(browserPath) || !statSync(browserPath).isFile()) {
    throw new BlockedRunError('VIDEORC_STIMULUS_BROWSER did not identify Edge/Chrome.')
  }
  const manifest = await stimulusManifest({
    runtime,
    browserPath,
    screen,
    bounds
  })
  const manifestSha256 = sha256Text(stableJson(manifest))
  let launched = null
  try {
    launched = await launchStimuli({
      runtime,
      screen,
      bounds,
      ffmpegPath,
      runDirectory: tmpdir(),
      expectedManifestSha256: manifestSha256
    })
    const census = await collectStimulusCensus(runtime, launched)
    const liveness = evaluateStimulusLiveness(census, census)
    if (liveness.verdict !== 'PASS') {
      throw new BlockedRunError(
        `Stimulus preflight could not pin both browser trees: ${liveness.blockers.join('; ')}`
      )
    }
  } finally {
    if (launched) {
      const teardown = await stopStimuli(runtime, launched)
      if (teardown.clean !== true) {
        throw new BlockedRunError('Stimulus preflight did not tear down both exact browser trees.')
      }
    }
  }
  return { ...manifest, manifestSha256, preflight: 'PASS' }
}

async function stimulusManifest({ runtime, browserPath, screen, bounds }) {
  const [browserSha256, motionModuleSha256, avModuleSha256] = await Promise.all([
    runtime.sha256File(browserPath),
    sha256File(resolve('scripts/lib/screen-motion-stimulus.mjs')),
    sha256File(resolve('scripts/lib/av-sync-stimulus.mjs'))
  ])
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-obs-stimulus',
    browser: {
      path: browserPath,
      sha256: browserSha256
    },
    source: {
      id: screen.id,
      width: screen.width,
      height: screen.height
    },
    desktopBounds: { ...bounds },
    motion: stimulusPlacement(bounds).motion,
    av: stimulusPlacement(bounds).av,
    modules: {
      screenMotionSha256: motionModuleSha256,
      avSyncSha256: avModuleSha256
    },
    options: {
      chromiumBackgroundThrottlingDisabled: true,
      audibleFlashClick: true,
      everyFrameMotion: true,
      verifyVisible: false
    }
  }
}

function stimulusPlacement(bounds) {
  return {
    motion: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    },
    av: {
      x: bounds.x + Math.round(bounds.width * 0.02),
      y: bounds.y + Math.round(bounds.height * 0.63),
      width: Math.round(bounds.width * 0.46),
      height: Math.round(bounds.height * 0.34)
    }
  }
}

async function launchStimuli({
  runtime,
  screen,
  bounds,
  ffmpegPath,
  runDirectory,
  expectedManifestSha256
}) {
  const browserPath = requiredAbsoluteEnvironmentPath('VIDEORC_STIMULUS_BROWSER')
  const manifest = await stimulusManifest({ runtime, browserPath, screen, bounds })
  const manifestSha256 = sha256Text(stableJson(manifest))
  if (manifestSha256 !== expectedManifestSha256) {
    throw new BlockedRunError(
      'The deterministic stimulus/browser identity changed after the comparison manifest locked.'
    )
  }
  const placement = stimulusPlacement(bounds)
  let motion = null
  let av = null
  try {
    motion = await runtime.launchScreenMotionStimulus({
      screenSource: screen,
      browserPath,
      ...placement.motion,
      verifyVisible: false,
      outputDirectory: runDirectory,
      ffmpegPath
    })
    av = await runtime.launchAvSyncStimulus({
      screenSource: screen,
      browserPath,
      ...placement.av
    })
    const identities = {
      motion: await pinProcessTree(runtime, motion.child?.pid, 'screen-motion stimulus'),
      av: await pinProcessTree(runtime, av.child?.pid, 'A/V-sync stimulus')
    }
    return {
      motion,
      av,
      identities,
      manifestSha256,
      liveness: {
        verdict: 'BLOCKED',
        blockers: ['measurement-boundary stimulus census has not completed']
      }
    }
  } catch (error) {
    if (av) await runtime.stopAvSyncStimulus(av).catch(() => undefined)
    if (motion) await runtime.stopScreenMotionStimulus(motion).catch(() => undefined)
    throw error
  }
}

async function pinProcessTree(runtime, rootPid, label) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    throw new BlockedRunError(`${label} root PID was unavailable.`)
  }
  const census = await runtime.collectProcessCensus({ ledgerPaths: [], rootPid })
  const rows = censusRows(census)
  const identities = rows
    .filter((row) => Number.isInteger(row.pid) && row.pid > 1 && nonEmpty(row.creationDate))
    .map((row) => ({
      pid: row.pid,
      creationDate: row.creationDate,
      role: row.role ?? 'other'
    }))
  if (
    rows.length === 0 ||
    identities.length !== rows.length ||
    !identities.some((identity) => identity.pid === rootPid)
  ) {
    throw new BlockedRunError(
      `${label} process tree could not be pinned by PID and Windows CreationDate.`
    )
  }
  return identities
}

async function evaluateExitedProcessIdentities(runtime, rootPid, identities) {
  const census = await runtime.collectProcessCensus({
    ledgerPaths: [],
    rootPid,
    extraPids: (identities ?? []).map((identity) => identity.pid)
  })
  const rows = censusRows(census)
  const survivors = (identities ?? []).filter((identity) =>
    rows.some(
      (row) =>
        row.pid === identity.pid && String(row.creationDate ?? '') === String(identity.creationDate)
    )
  )
  return {
    verdict: survivors.length === 0 ? 'PASS' : 'FAIL',
    survivors,
    checkedIdentities: identities?.length ?? 0
  }
}

async function collectStimulusCensus(runtime, stimuli) {
  const collect = async (name) => {
    const rootPid = stimuli[name]?.child?.pid
    const expected = stimuli.identities[name]
    const census = await runtime.collectProcessCensus({
      ledgerPaths: [],
      rootPid,
      extraPids: expected.map((identity) => identity.pid)
    })
    const rows = censusRows(census)
    const live = expected.filter((identity) =>
      rows.some(
        (row) =>
          row.pid === identity.pid &&
          String(row.creationDate ?? '') === String(identity.creationDate)
      )
    )
    return {
      rootPid,
      expectedIdentities: expected,
      liveIdentities: live,
      rows
    }
  }
  const [motion, av] = await Promise.all([collect('motion'), collect('av')])
  return { observedAtMs: Date.now(), motion, av }
}

function evaluateStimulusLiveness(start, end) {
  const blockers = []
  for (const name of ['motion', 'av']) {
    for (const [boundary, evidence] of [
      ['start', start?.[name]],
      ['end', end?.[name]]
    ]) {
      if (
        !Number.isInteger(evidence?.rootPid) ||
        evidence?.expectedIdentities?.length === 0 ||
        evidence?.liveIdentities?.length !== evidence?.expectedIdentities?.length ||
        !evidence.liveIdentities.some((identity) => identity.pid === evidence.rootPid)
      ) {
        blockers.push(`${name} stimulus process tree was not fully pinned at ${boundary}`)
      }
    }
  }
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    start,
    end
  }
}

async function stopStimuli(runtime, stimuli) {
  const [motion, av] = await Promise.all([
    runtime.stopScreenMotionStimulus(stimuli.motion).catch((error) => ({
      state: 'error',
      forced: true,
      treeExited: false,
      error: message(error)
    })),
    runtime.stopAvSyncStimulus(stimuli.av).catch((error) => ({
      state: 'error',
      forced: true,
      treeExited: false,
      error: message(error)
    }))
  ])
  const clean = [motion, av].every(
    (result) =>
      result?.forced === false &&
      result?.treeExited === true &&
      result?.directoryRemoved === true &&
      ['terminated', 'skipped'].includes(result?.state)
  )
  return { clean, forced: motion.forced === true || av.forced === true, motion, av }
}

function censusRows(census) {
  const unique = new Map()
  for (const row of [...(census?.processRows ?? []), ...(census?.processGroupRows ?? [])]) {
    if (!Number.isInteger(row?.pid) || row.pid <= 1) continue
    unique.set(`${row.pid}:${row.creationDate ?? ''}`, row)
  }
  return [...unique.values()]
}

async function localRtmpTarget() {
  const port = await freePort()
  const streamKey = randomBytes(24).toString('base64url')
  const serverUrl = `rtmp://127.0.0.1:${port}/live`
  return {
    port,
    streamKey,
    serverUrl,
    listenerUrl: `${serverUrl}/${streamKey}`
  }
}

function safeRtmpTargetIdentity(target) {
  const binding = {
    serverUrl: target.serverUrl,
    streamKeySha256: sha256Text(target.streamKey)
  }
  return {
    ...binding,
    bindingSha256: sha256Text(stableJson(binding))
  }
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

function spawnReceiver({ ffmpegPath, target, warmupSeconds, measurementSeconds }) {
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
      String(measurementSeconds + 5),
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
  const progress = {}
  const progressSamples = []
  let resolveMeasurementStart
  let rejectMeasurementStart
  const measurementStarted = new Promise((resolveStart, rejectStart) => {
    resolveMeasurementStart = resolveStart
    rejectMeasurementStart = rejectStart
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      progress[line.slice(0, separator)] = line.slice(separator + 1)
      if (line.slice(0, separator) !== 'progress') continue
      if (!measurementStart && (Number(progress.frame) > 0 || Number(progress.total_size) > 13)) {
        progressSamples.push({
          observedAtMs: Date.now(),
          outTimeUs: Number(progress.out_time_us),
          frame: Number(progress.frame),
          totalSize: Number(progress.total_size)
        })
        const clockEvidence = evaluateWindowsReceiverProgressClock(progressSamples)
        if (clockEvidence.verdict === 'PASS') {
          measurementStart = { startedAtMs: clockEvidence.startedAtMs, clockEvidence }
          resolveMeasurementStart(measurementStart)
        }
      }
      for (const key of Object.keys(progress)) delete progress[key]
    }
  })
  child.once('exit', (code, signal) => {
    if (!measurementStart) {
      rejectMeasurementStart(
        new Error(
          `The RTMP receiver exited before measurement (code=${code}, signal=${signal}): ${stderr}`
        )
      )
    }
  })
  return {
    child,
    stderr: () => stderr,
    waitForMeasurementStart: (timeout) =>
      promiseWithTimeout(
        measurementStarted,
        timeout,
        `The RTMP receiver did not reach measured output after ${warmupSeconds}s of warm-up.`
      )
  }
}

async function ensureReceiverListening(receiver) {
  await sleep(750)
  if (
    receiver.child.exitCode !== null ||
    receiver.child.signalCode !== null ||
    receiver.child.pid == null
  ) {
    throw new BlockedRunError(
      `The local RTMP receiver failed before publishing: ${receiver.stderr()}`
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

async function launchObsControl({
  runtime,
  portable,
  profile,
  expectedExecutableSha256,
  evidenceDirectory
}) {
  const actualSha256 = await sha256File(portable.executable)
  if (actualSha256 !== expectedExecutableSha256) {
    throw new BlockedRunError('The evidence-local OBS executable digest changed before launch.')
  }
  const websocketPort = await freePort()
  const profileFiles = await writeObsPortableProfile({
    portable,
    profile,
    websocketPort,
    evidenceDirectory
  })
  const child = spawn(
    portable.executable,
    [
      '--portable',
      '--minimize-to-tray',
      '--disable-shutdown-check',
      '--profile',
      profile.profileName,
      '--collection',
      profile.collectionName,
      '--scene',
      profile.sceneName
    ],
    {
      cwd: dirname(portable.executable),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  let stderr = ''
  let stdout = ''
  child.stderr.setEncoding('utf8')
  child.stdout.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_000)
  })
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-16_000)
  })
  let client = null
  try {
    client = await connectObsWebSocket(websocketPort, child)
    const rootIdentity = await pinRootProcessIdentity(child.pid)
    assertRootExecutable(rootIdentity, portable.executable, 'OBS portable root process')
    let pinnedIdentities = await pinProcessTree(runtime, child.pid, 'OBS portable')
    return {
      child,
      rootPid: child.pid,
      rootIdentity,
      request: (type, data) => client.request(type, data),
      evidencePaths: profileFiles.evidencePaths,
      logs: () => ({ stdout, stderr }),
      stop: async ({ streamActive = false } = {}) => {
        let forced = false
        let streamStopped = !streamActive
        let requestError = null
        try {
          pinnedIdentities = await pinProcessTree(
            runtime,
            child.pid,
            'OBS portable before teardown'
          )
        } catch (error) {
          requestError = `process pinning failed: ${message(error)}`
        }
        try {
          if (streamActive) {
            await client.request('StopStream')
            await waitForObsStreamState(client, false)
            streamStopped = true
          }
          await client.request('Exit')
        } catch (error) {
          requestError = message(error)
        }
        let exit = null
        try {
          exit = await waitForChildExit(child, 15_000)
        } catch {
          forced = true
          child.kill('SIGTERM')
          exit = await waitForChildExit(child, 5_000).catch(() => ({
            code: child.exitCode,
            signal: child.signalCode,
            timeout: true
          }))
        } finally {
          client.close()
          await scrubObsServiceSecret(portable, profile)
        }
        const processExit = await evaluateExitedProcessIdentities(
          runtime,
          child.pid,
          pinnedIdentities
        )
        return {
          clean:
            streamStopped &&
            forced === false &&
            exit?.signal == null &&
            (exit?.code === 0 || exit?.code === null) &&
            processExit.verdict === 'PASS' &&
            requestError === null,
          forced,
          streamStopped,
          requestError,
          exit,
          processExit
        }
      }
    }
  } catch (error) {
    client?.close()
    child.kill('SIGTERM')
    await waitForChildExit(child, 5_000).catch(() => undefined)
    await scrubObsServiceSecret(portable, profile).catch(() => undefined)
    throw new BlockedRunError(
      `OBS portable control startup failed: ${message(error)}; ${stderr || stdout || 'no OBS log output'}`
    )
  }
}

async function writeObsPortableProfile({ portable, profile, websocketPort, evidenceDirectory }) {
  const configRoot = join(portable.root, 'config', 'obs-studio')
  await rm(configRoot, { recursive: true, force: true })
  const allFiles = [...profile.safeFiles, ...profile.secretFiles]
  for (const file of allFiles) {
    const path = join(portable.root, file.relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents, { encoding: 'utf8', flag: 'wx' })
  }
  const websocketPath = join(configRoot, 'plugin_config', 'obs-websocket', 'config.json')
  await mkdir(dirname(websocketPath), { recursive: true })
  await writeFile(
    websocketPath,
    `${JSON.stringify(
      {
        ...profile.websocket,
        server_port: websocketPort
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', flag: 'wx' }
  )
  const evidencePaths = []
  if (evidenceDirectory) {
    for (const file of profile.safeFiles) {
      const evidencePath = join(
        evidenceDirectory,
        'obs-portable-profile',
        relative(join('config', 'obs-studio'), file.relativePath)
      )
      await mkdir(dirname(evidencePath), { recursive: true })
      await writeFile(evidencePath, file.contents, { encoding: 'utf8', flag: 'wx' })
      evidencePaths.push(evidencePath)
    }
    const identityPath = join(evidenceDirectory, 'obs-portable-profile', 'profile-identity.json')
    await writeJsonNew(identityPath, {
      normalized: profile.normalized,
      normalizedSha256: profile.normalizedSha256,
      secretFilesRetained: false,
      websocketPortRetained: false
    })
    evidencePaths.push(identityPath)
  }
  return { configRoot, websocketPath, evidencePaths }
}

async function scrubObsServiceSecret(portable, profile) {
  for (const file of profile.secretFiles) {
    const path = join(portable.root, file.relativePath)
    if (existsSync(path)) {
      await writeFile(path, '', { encoding: 'utf8' })
      await rm(path, { force: true })
    }
  }
}

async function connectObsWebSocket(port, child) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new BlockedRunError(
      'The protected OBS runner requires a Node runtime with the standard WebSocket client.'
    )
  }
  const deadline = Date.now() + 30_000
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `OBS exited before obs-websocket became ready (code=${child.exitCode}, signal=${child.signalCode}).`
      )
    }
    try {
      return await ObsWebSocketClient.connect(`ws://127.0.0.1:${port}`)
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }
  throw new Error(`obs-websocket did not become ready: ${message(lastError)}`)
}

class ObsWebSocketClient {
  static async connect(url) {
    const socket = new WebSocket(url)
    const client = new ObsWebSocketClient(socket)
    await client.ready
    return client
  }

  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.sequence = 0
    this.identified = false
    this.ready = promiseWithTimeout(
      new Promise((resolveReady, rejectReady) => {
        this.resolveReady = resolveReady
        this.rejectReady = rejectReady
      }),
      10_000,
      'obs-websocket handshake timed out.'
    )
    socket.addEventListener('message', (event) => this.onMessage(event))
    socket.addEventListener('error', () => {
      if (!this.identified) this.rejectReady(new Error('obs-websocket connection failed.'))
    })
    socket.addEventListener('close', () => {
      if (!this.identified) this.rejectReady(new Error('obs-websocket closed before identify.'))
      for (const pending of this.pending.values()) {
        pending.reject(new Error('obs-websocket closed with a request pending.'))
      }
      this.pending.clear()
    })
  }

  onMessage(event) {
    let envelope
    try {
      envelope = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (envelope?.op === 0) {
      if (envelope?.d?.authentication) {
        this.rejectReady(new Error('OBS portable WebSocket unexpectedly required authentication.'))
        return
      }
      this.socket.send(
        JSON.stringify({
          op: 1,
          d: { rpcVersion: 1, eventSubscriptions: 0 }
        })
      )
      return
    }
    if (envelope?.op === 2) {
      this.identified = true
      this.resolveReady()
      return
    }
    if (envelope?.op !== 7) return
    const requestId = envelope?.d?.requestId
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    if (envelope?.d?.requestStatus?.result === true) {
      pending.resolve(envelope.d.responseData ?? {})
    } else {
      pending.reject(
        new Error(
          `${envelope?.d?.requestType ?? 'OBS request'} failed (${envelope?.d?.requestStatus?.code ?? 'unknown'}): ${envelope?.d?.requestStatus?.comment ?? 'no comment'}`
        )
      )
    }
  }

  request(requestType, requestData = {}) {
    if (!this.identified) {
      return Promise.reject(new Error('obs-websocket is not identified.'))
    }
    const requestId = `videorc-${++this.sequence}-${randomBytes(8).toString('hex')}`
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        rejectRequest(new Error(`${requestType} timed out.`))
      }, timeoutMs())
      this.pending.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      })
      this.socket.send(
        JSON.stringify({
          op: 6,
          d: { requestType, requestId, requestData }
        })
      )
    })
  }

  close() {
    this.socket.close()
  }
}

async function waitForObsStreamState(client, active, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let status = null
  while (Date.now() < deadline) {
    status = await client.request('GetStreamStatus')
    if (status?.outputActive === active) return status
    await sleep(100)
  }
  throw new Error(
    `OBS stream did not become ${active ? 'active' : 'inactive'}: ${JSON.stringify(status)}`
  )
}

async function pinRootProcessIdentity(rootPid) {
  const escapedPid = Number(rootPid)
  if (!Number.isInteger(escapedPid) || escapedPid <= 1) {
    throw new BlockedRunError('Publisher root PID was unavailable.')
  }
  const script = [
    `$row = Get-CimInstance Win32_Process -Filter "ProcessId=${escapedPid}";`,
    'if ($null -eq $row) { exit 3 };',
    '$row | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath | ConvertTo-Json -Compress'
  ].join(' ')
  const parsed = JSON.parse(
    runCaptured('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
      .stdout
  )
  if (
    Number(parsed.ProcessId) !== escapedPid ||
    !nonEmpty(parsed.CreationDate) ||
    !nonEmpty(parsed.ExecutablePath)
  ) {
    throw new BlockedRunError(
      'Publisher root process could not be pinned by PID, CreationDate, and executable.'
    )
  }
  return {
    pid: escapedPid,
    creationDate: parsed.CreationDate,
    executablePath: parsed.ExecutablePath
  }
}

function assertRootExecutable(identity, expectedPath, label) {
  const actual = win32.normalize(String(identity?.executablePath ?? '')).toLocaleLowerCase('en-US')
  const expected = win32.normalize(String(expectedPath ?? '')).toLocaleLowerCase('en-US')
  if (!actual || !expected || actual !== expected) {
    throw new BlockedRunError(
      `${label} executable was ${identity?.executablePath ?? 'missing'}, expected ${expectedPath ?? 'missing'}.`
    )
  }
}

async function startObsPublisher({ runtime, portable, profile, runDirectory, expected }) {
  const control = await launchObsControl({
    runtime,
    portable,
    profile,
    expectedExecutableSha256: expected.portableSha256,
    evidenceDirectory: runDirectory
  })
  try {
    const version = await control.request('GetVersion')
    if (
      !sameVersionPrefix(version?.obsVersion, expected.version) ||
      (await sha256File(portable.executable)) !== expected.portableSha256
    ) {
      throw new BlockedRunError('OBS identity changed between manifest and trial launch.')
    }
    await control.request('StartStream')
    await waitForObsStreamState({ request: control.request }, true)
    let stopped = null
    return {
      rootPid: control.rootPid,
      rootIdentity: control.rootIdentity,
      evidencePaths: control.evidencePaths,
      status: () => control.request('GetStreamStatus'),
      stop: async () => {
        if (!stopped) stopped = await control.stop({ streamActive: true })
        return stopped
      }
    }
  } catch (error) {
    await control.stop({ streamActive: false }).catch(() => undefined)
    throw error
  }
}

async function startVideorcPublisher({
  runtime,
  spawnSpec,
  appEnvironment,
  ffmpegPath,
  screen,
  microphone,
  target,
  candidate,
  d3d11,
  requireD3d11
}) {
  await assertCandidateIdentity(
    runtime,
    spawnSpec.command,
    candidate.sha256,
    candidate.packagePayload.sha256,
    'before Videorc trial launch'
  )
  const launched = await runtime.launchDevApp({
    spawnSpec,
    timeoutMs: timeoutMs(),
    requiredMarkers: ['backend-ready'],
    env: {
      ...appEnvironment,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      ...(d3d11 ? { VIDEORC_WINDOWS_D3D11_MEDIA: '1' } : {}),
      ...(requireD3d11 ? { VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA: '1' } : {})
    }
  })
  let ws = null
  let stopped = null
  let support = null
  try {
    ws = await runtime.connectBackend(launched.connections['backend-ready'], timeoutMs())
    const [health, devices] = await Promise.all([
      runtime.request(ws, timeoutMs(), 'health.ping', { ffmpegPath }),
      runtime.request(ws, timeoutMs(), 'devices.list', { ffmpegPath })
    ])
    if (!health?.ffmpeg?.available) {
      throw new BlockedRunError('Videorc trial FFmpeg health check failed.')
    }
    const available = Array.isArray(devices?.devices) ? devices.devices : []
    if (
      !available.some(
        (device) =>
          device?.id === screen.id && device?.kind === 'screen' && device?.status === 'available'
      ) ||
      !available.some(
        (device) =>
          device?.id === microphone.id &&
          device?.kind === 'microphone' &&
          device?.status === 'available'
      )
    ) {
      throw new BlockedRunError(
        'Videorc trial no longer exposed the manifest-locked screen/audio inputs.'
      )
    }
    await runtime.request(ws, timeoutMs(), 'entitlements.refresh')
    const entitlement = await runtime.request(ws, timeoutMs(), 'entitlements.get')
    if (
      !['premium', 'developer'].includes(entitlement?.tier) ||
      Number(entitlement?.limits?.streaming?.maxFps) < WINDOWS_OBS_SETTINGS.fps
    ) {
      throw new BlockedRunError(
        'The preserved acceptance profile did not prove a live Premium/Developer 60fps entitlement.'
      )
    }
    const targetId = 'local-obs-parity'
    const started = await runtime.request(
      ws,
      timeoutMs(),
      'session.start',
      streamSessionParams({
        screen,
        microphone,
        target,
        targetId
      })
    )
    if (started?.state !== 'recording') {
      throw new Error(
        `Videorc session.start returned ${started?.state ?? 'missing'}: ${started?.message ?? ''}`
      )
    }
    const initialSnapshot = await waitForVideorcTargetLive(runtime, ws, targetId)
    const rootIdentity = await pinRootProcessIdentity(launched.process.pid)
    assertRootExecutable(rootIdentity, spawnSpec.command, 'Videorc trial root process')
    let pinnedIdentities = await pinProcessTree(runtime, launched.process.pid, 'Videorc trial')
    const stop = async () => {
      if (stopped) return stopped
      let sessionStop = null
      let supportError = null
      let appStopError = null
      let processPinError = null
      try {
        pinnedIdentities = await pinProcessTree(
          runtime,
          launched.process.pid,
          'Videorc trial before teardown'
        )
      } catch (error) {
        processPinError = message(error)
      }
      try {
        sessionStop = await runtime.request(ws, timeoutMs(), 'session.stop')
        support = await runtime.request(ws, timeoutMs(), 'diagnostics.supportBundle.export', {
          ffmpegPath,
          rendererDiagnostics: {
            windowsObsSideBySide: {
              scenario: WINDOWS_OBS_SCENARIO,
              candidateSha256: candidate.sha256
            }
          }
        })
        if (!support?.path || !existsSync(support.path)) {
          supportError = 'diagnostics.supportBundle.export did not return a retained file'
        }
      } catch (error) {
        supportError = message(error)
      } finally {
        ws?.close()
        try {
          await launched.stop()
        } catch (error) {
          appStopError = message(error)
        }
      }
      let identityError = null
      try {
        await assertCandidateIdentity(
          runtime,
          spawnSpec.command,
          candidate.sha256,
          candidate.packagePayload.sha256,
          'after Videorc trial teardown'
        )
      } catch (error) {
        identityError = message(error)
      }
      const processExit = await evaluateExitedProcessIdentities(
        runtime,
        launched.process.pid,
        pinnedIdentities
      )
      stopped = {
        clean:
          sessionStop !== null &&
          !supportError &&
          !appStopError &&
          !identityError &&
          !processPinError &&
          processExit.verdict === 'PASS',
        forced: false,
        sessionStop,
        supportError,
        appStopError,
        identityError,
        processPinError,
        processExit
      }
      return stopped
    }
    return {
      rootPid: launched.process.pid,
      rootIdentity,
      targetId,
      initialSnapshot,
      evidencePaths: [],
      status: async () => {
        const requestedAtMs = Date.now()
        const [diagnostics, targetSnapshot, previewSurface] = await Promise.all([
          runtime.request(
            ws,
            Math.max(5_000, WINDOWS_OBS_TIMING.sampleIntervalMs * 4),
            'diagnostics.stats'
          ),
          runtime.request(
            ws,
            Math.max(5_000, WINDOWS_OBS_TIMING.sampleIntervalMs * 4),
            'stream.targets.snapshot',
            {}
          ),
          runtime.request(
            ws,
            Math.max(5_000, WINDOWS_OBS_TIMING.sampleIntervalMs * 4),
            'preview.surface.status'
          )
        ])
        return {
          requestedAtMs,
          observedAtMs: Date.now(),
          diagnostics,
          targetSnapshot,
          previewSurface
        }
      },
      stop,
      exportSupportBundle: async () => support
    }
  } catch (error) {
    if (ws) {
      await runtime.request(ws, 15_000, 'session.stop').catch(() => undefined)
      ws.close()
    }
    await launched.stop().catch(() => undefined)
    throw error
  }
}

function streamSessionParams({ screen, microphone, target, targetId }) {
  const timestamp = new Date().toISOString()
  return {
    sources: {
      screenId: screen.id,
      microphoneId: microphone.id,
      testPattern: false
    },
    layout: screenOnlyLayout(),
    output: {
      recordEnabled: false,
      streamEnabled: true,
      video: {
        preset: 'custom',
        width: WINDOWS_OBS_SETTINGS.width,
        height: WINDOWS_OBS_SETTINGS.height,
        fps: WINDOWS_OBS_SETTINGS.fps,
        bitrateKbps: WINDOWS_OBS_SETTINGS.bitrateKbps
      },
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
      defaultOutputPreset: 'youtube-1080p60',
      defaultBitrateKbps: WINDOWS_OBS_SETTINGS.bitrateKbps,
      enabledTargetIds: [targetId],
      targets: [
        {
          id: targetId,
          platform: 'youtube',
          label: 'Local protected OBS-parity receiver',
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
      microphoneMuted: false,
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

async function waitForVideorcTargetLive(runtime, ws, targetId) {
  const deadline = Date.now() + timeoutMs()
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await runtime.request(ws, timeoutMs(), 'stream.targets.snapshot', {})
    const target = snapshot?.targets?.find((candidate) => candidate?.targetId === targetId)
    if (target?.state === 'live') {
      return { requestedAtMs: Date.now(), observedAtMs: Date.now(), snapshot }
    }
    if (['failed', 'stopped'].includes(target?.state)) {
      throw new Error(
        `Videorc local target entered ${target.state}: ${target.message ?? 'no message'}`
      )
    }
    await sleep(100)
  }
  throw new BlockedRunError(`Videorc local target did not become live: ${JSON.stringify(snapshot)}`)
}

async function collectPublisherStatus({ runtime, publisher, app, measurementMs, intervalMs }) {
  const initial = {
    scheduledAtMs: Date.now(),
    sampledAtMs: Date.now(),
    value: await publisher.status()
  }
  const scheduled = await runtime.collectPerformanceSamplesOnSchedule({
    measurementMs,
    intervalMs,
    nowMs: Date.now,
    collectSample: () => publisher.status()
  })
  const terminal = {
    scheduledAtMs: scheduled.measurementEndedAtMs,
    sampledAtMs: Date.now(),
    value: await publisher.status()
  }
  const samples = scheduled.samples.map((value, index) => ({
    scheduledAtMs: scheduled.sampleTimings[index]?.scheduledAtMs ?? null,
    sampledAtMs: scheduled.sampleTimings[index]?.observedAtMs ?? null,
    value
  }))
  if (app === 'obs') {
    const statuses = [initial, ...samples, terminal].map((entry) => entry.value)
    const blockers = []
    if (statuses.some((status) => status?.outputActive !== true)) {
      blockers.push('OBS stream output was not active for every sampled boundary')
    }
    for (const field of ['outputBytes', 'outputDuration', 'outputTotalFrames']) {
      if (!monotonicValues(statuses.map((status) => status?.[field]))) {
        blockers.push(`OBS ${field} was missing, non-finite, or decreased`)
      }
    }
    if (
      statuses.some(
        (status) => !Number.isFinite(status?.outputSkippedFrames) || status.outputSkippedFrames < 0
      )
    ) {
      blockers.push('OBS outputSkippedFrames was missing or invalid')
    }
    return {
      app,
      timing: { measurementMs, intervalMs },
      sampling: {
        ...scheduled.evidence,
        observations: scheduled.sampleTimings
      },
      initial,
      samples,
      terminal,
      verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
      blockers,
      lifecycle: {
        verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
        blockers,
        activeSamples: statuses.filter((status) => status?.outputActive === true).length,
        totalSamples: statuses.length
      }
    }
  }

  const diagnosticTimeline = {
    timing: { measurementMs, intervalMs },
    sampling: {
      ...scheduled.evidence,
      observations: scheduled.sampleTimings
    },
    samples: samples.map((sample) => sample.value.diagnostics),
    terminal: terminal.value.diagnostics,
    terminalTiming: {
      measurementEndedAtMs: scheduled.measurementEndedAtMs,
      observedAtMs: terminal.sampledAtMs
    }
  }
  const diagnosticReadiness = evaluateWindowsStreamDiagnosticTimeline(diagnosticTimeline, {
    measurementMs,
    intervalMs,
    recordEnabled: false
  })
  const snapshotEvents = [initial, ...samples, terminal].map((entry) => ({
    requestedAtMs: entry.value.requestedAtMs,
    receivedAtMs: entry.value.observedAtMs,
    source: 'rpc',
    snapshot: entry.value.targetSnapshot
  }))
  const sessionIds = [
    ...new Set(
      snapshotEvents.map((event) => event.snapshot?.sessionId).filter((value) => nonEmpty(value))
    )
  ]
  const lifecycle = evaluateWindowsStreamTargetLifecycle({
    snapshots: snapshotEvents,
    targetId: publisher.targetId,
    expectedSessionId:
      diagnosticReadiness.sessionId ?? (sessionIds.length === 1 ? sessionIds[0] : null),
    measurementStartedAtMs: scheduled.measurementStartedAtMs,
    measurementEndedAtMs: scheduled.measurementEndedAtMs,
    expectedMeasurementEndedAtMs: scheduled.measurementStartedAtMs + measurementMs,
    intervalMs,
    receiverAlive: true,
    pollingEvidence: {
      verdict: diagnosticReadiness.verdict,
      blockers: diagnosticReadiness.blockers
    }
  })
  const blockers = [
    ...(diagnosticReadiness.verdict === 'PASS' ? [] : diagnosticReadiness.blockers),
    ...(lifecycle.verdict === 'PASS'
      ? []
      : [...(lifecycle.failures ?? []), ...(lifecycle.blockers ?? [])])
  ]
  return {
    app,
    timing: { measurementMs, intervalMs },
    sampling: diagnosticTimeline.sampling,
    initial,
    samples,
    terminal,
    diagnosticTimeline,
    diagnosticReadiness,
    lifecycle,
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers
  }
}

function monotonicValues(values) {
  let previous = null
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return false
    if (previous !== null && value < previous) return false
    previous = value
  }
  return true
}

async function collectGpuSamples({ runtime, intervalMs, expectedSamples }) {
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
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveCollection(value)
    }
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
          // Coverage/normalization is evaluated below; malformed samples never count.
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.once('error', (error) => {
      finish({
        samples,
        exitCode: null,
        error: message(error),
        measurementStartedAtMs,
        measurementEndedAtMs: Date.now()
      })
    })
    child.once('exit', (code) => {
      if (pending.trim()) {
        try {
          samples.push(runtime.normalizeWindowsGpuCounterBatch(JSON.parse(pending)))
        } catch {
          // Coverage blocks incomplete output.
        }
      }
      finish({
        samples,
        exitCode: code,
        error: code === 0 ? null : stderr || `PowerShell exited ${code}`,
        measurementStartedAtMs,
        measurementEndedAtMs: Date.now()
      })
    })
  })
}

function evaluateVideorcPipeline(statusTimeline, { requireD3d11, expectedAdapterLuid }) {
  const failures = []
  const blockers = []
  if (statusTimeline?.verdict !== 'PASS') {
    blockers.push(...(statusTimeline?.blockers ?? ['application status timeline was incomplete']))
  }
  const diagnostics = [
    ...(statusTimeline?.diagnosticTimeline?.samples ?? []),
    ...(statusTimeline?.diagnosticTimeline?.terminal
      ? [statusTimeline.diagnosticTimeline.terminal]
      : [])
  ]
  const summary = summarizeWindowsStreamDiagnosticSamples(diagnostics, {
    recordEnabled: false
  })
  const d3d11 = summary.d3d11
  if (requireD3d11) {
    if (!d3d11) {
      failures.push('windowsD3d11Media diagnostics were missing')
    } else {
      if (d3d11.state !== 'live') failures.push(`D3D11 state was ${d3d11.state ?? 'missing'}`)
      if (d3d11.requested !== true || d3d11.required !== true) {
        failures.push('D3D11 selection/requirement was not acknowledged')
      }
      if (d3d11.captureBackend === 'legacy-ffmpeg' || !d3d11.captureBackend) {
        failures.push(`D3D11 capture backend was ${d3d11.captureBackend ?? 'missing'}`)
      }
      if (normalizeAdapterLuid(d3d11.adapterLuid) !== normalizeAdapterLuid(expectedAdapterLuid)) {
        failures.push('D3D11 media adapter LUID differed from the selected DXGI adapter')
      }
      for (const [field, value] of Object.entries({
        captureReadbackFrames: d3d11.captureReadbackFrames,
        compositorCpuFallbackFrames: d3d11.compositorCpuFallbackFrames,
        encoderSystemMemorySamples: d3d11.encoderSystemMemorySamples,
        rawVideoCopiedFrames: d3d11.rawVideoCopiedFrames,
        previewBmpRequests: d3d11.previewBmpRequests,
        previewBmpBytes: d3d11.previewBmpBytes,
        texturePoolPressureEvents: d3d11.texturePoolPressureEvents,
        adapterMismatches: d3d11.adapterMismatches,
        deviceResets: d3d11.deviceResets,
        synchronizationTimeouts: d3d11.synchronizationTimeouts
      })) {
        if (value !== 0) failures.push(`${field}=${value ?? 'missing'} (expected 0)`)
      }
      if (!(d3d11.textureImportFrames > 0)) {
        failures.push(`textureImportFrames=${d3d11.textureImportFrames ?? 'missing'}`)
      }
      if (!(d3d11.encoderGpuSamples > 0)) {
        failures.push(`encoderGpuSamples=${d3d11.encoderGpuSamples ?? 'missing'}`)
      }
      if (d3d11.fallbackReason) failures.push(`fallbackReason=${d3d11.fallbackReason}`)
      if (d3d11.stateChanged || d3d11.adapterChanged || d3d11.fallbackChanged) {
        failures.push('D3D11 state/adapter/fallback changed during measurement')
      }
    }
    for (const [index, sample] of diagnostics.entries()) {
      const media = sample?.windowsD3d11Media
      if (sample?.compositorBackend !== 'd3d11') {
        failures.push(`diagnostic sample ${index + 1} compositorBackend was not d3d11`)
      }
      if (
        !Number.isFinite(media?.messagePumpLagP95Ms) ||
        media.messagePumpLagP95Ms < 0 ||
        media.messagePumpLagP95Ms > 50 ||
        !Number.isFinite(media?.messagePumpLagMaxMs) ||
        media.messagePumpLagMaxMs < 0 ||
        media.messagePumpLagMaxMs > 100
      ) {
        failures.push(`diagnostic sample ${index + 1} exceeded/missed 50/100ms pump limits`)
      }
      if (
        !Number.isFinite(media?.mediaCommandLagP95Ms) ||
        media.mediaCommandLagP95Ms < 0 ||
        media.mediaCommandLagP95Ms > 50 ||
        !Number.isFinite(media?.mediaCommandLagMaxMs) ||
        media.mediaCommandLagMaxMs < 0 ||
        media.mediaCommandLagMaxMs > 100
      ) {
        failures.push(
          `diagnostic sample ${index + 1} exceeded/missed 50/100ms media-command limits`
        )
      }
      for (const field of ['maximumConsecutiveMessageBatch', 'maximumConsecutiveMediaBatch']) {
        if (!Number.isInteger(media?.[field]) || media[field] < 0 || media[field] > 32) {
          failures.push(`diagnostic sample ${index + 1} ${field} exceeded 32`)
        }
      }
      if (
        !Number.isFinite(media?.texturePoolCapacity) ||
        !Number.isFinite(media?.texturePoolInUse) ||
        media.texturePoolCapacity <= 0 ||
        media.texturePoolInUse < 0 ||
        media.texturePoolInUse > media.texturePoolCapacity
      ) {
        failures.push(`diagnostic sample ${index + 1} texture-pool bounds were invalid`)
      }
      for (const field of [
        'captureReadbackFrames',
        'compositorCpuFallbackFrames',
        'encoderSystemMemorySamples',
        'rawVideoCopiedFrames',
        'previewBmpRequests',
        'previewBmpBytes',
        'texturePoolPressureEvents',
        'adapterMismatches',
        'deviceResets',
        'staleGenerationCallbacks',
        'synchronizationTimeouts'
      ]) {
        if (Number(media?.[field]) !== 0) {
          failures.push(
            `diagnostic sample ${index + 1} ${field}=${media?.[field] ?? 'missing'} (expected cumulative zero)`
          )
        }
      }
      if (
        media?.cursorRequested !== true ||
        !['embedded', 'separate'].includes(media?.cursorMode)
      ) {
        failures.push(`diagnostic sample ${index + 1} did not prove cursor-enabled capture`)
      }
      if (
        !nonEmpty(media?.cursorPixelsSource) ||
        !Number.isFinite(media?.cursorShapeUploads) ||
        !Number.isFinite(media?.cursorCompositedFrames) ||
        media.cursorShapeUploads < 0 ||
        media.cursorCompositedFrames <= 0 ||
        media.cursorShapeUploads > media.cursorCompositedFrames
      ) {
        failures.push(
          `diagnostic sample ${index + 1} cursor shape/composition evidence was invalid`
        )
      }
    }
  }
  return {
    verdict: failures.length > 0 ? 'FAIL' : blockers.length > 0 ? 'BLOCKED' : 'PASS',
    failures,
    blockers,
    zeroCopyVerdict:
      requireD3d11 && failures.length === 0 && blockers.length === 0
        ? 'PASS'
        : requireD3d11
          ? 'FAIL'
          : 'NOT_REQUIRED',
    diagnosticTimelineVerdict: statusTimeline?.diagnosticReadiness?.verdict ?? null,
    streamLifecycle: statusTimeline?.lifecycle ?? null,
    summary
  }
}

function adapterLuidForGpu(value) {
  const compact = normalizeAdapterLuid(value)
  return compact ? `0x${compact.slice(0, 8)}:0x${compact.slice(8)}` : null
}

function normalizeAdapterLuid(value) {
  const compact = String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .replace(':0x', '')
    .replaceAll(':', '')
  return /^[0-9a-f]{16}$/i.test(compact) ? compact.toLocaleLowerCase('en-US') : null
}

async function assertCandidateIdentity(
  runtime,
  path,
  expectedExecutableSha256,
  expectedPayloadSha256,
  phase
) {
  let executableSha256
  let packagePayload
  try {
    ;[executableSha256, packagePayload] = await Promise.all([
      runtime.sha256File(path),
      runtime.packagedAppPayloadIdentity(path, { osPlatform: 'win32' })
    ])
  } catch (error) {
    throw new BlockedRunError(
      `The installed candidate could not be identified ${phase}: ${message(error)}`
    )
  }
  if (executableSha256 !== expectedExecutableSha256) {
    throw new BlockedRunError(
      `The installed candidate executable digest changed ${phase}; mixed-binary evidence is forbidden.`
    )
  }
  if (packagePayload?.sha256 !== expectedPayloadSha256) {
    throw new BlockedRunError(
      `The installed candidate package-payload digest changed ${phase}; mixed app/backend/tool evidence is forbidden.`
    )
  }
  return { executableSha256, packagePayload }
}

function requireCommand(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
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
    timeout: timeoutMs(),
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${basename(command)} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`
    )
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function capturedText(command, args) {
  return runCaptured(command, args).stdout.trim()
}

function resolveCommandPath(command) {
  if (isAbsolutePortable(command)) return portableResolve(command)
  const result = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000
  })
  const path = result.stdout
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean)
  if (result.error || result.status !== 0 || !path || !isAbsolutePortable(path)) {
    throw new BlockedRunError(`Could not resolve ${command} to an absolute executable path.`)
  }
  return portableResolve(path)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJsonNew(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  return JSON.stringify(stableJsonValue(value))
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)])
    )
  }
  return value
}

function isAbsolutePortable(path) {
  return (
    typeof path === 'string' &&
    Boolean(path.trim()) &&
    (isAbsolute(path) || windowsAbsolutePath(path))
  )
}

function portableResolve(path) {
  return windowsAbsolutePath(path) ? win32.normalize(path) : resolve(path)
}

function windowsAbsolutePath(path) {
  return typeof path === 'string' && (/^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]/.test(path))
}

function timeoutMs() {
  return positiveNumber(
    process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? '300000',
    'VIDEORC_SMOKE_TIMEOUT_MS'
  )
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function promiseWithTimeout(promise, timeout, timeoutMessage) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(timeoutMessage)), timeout)
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

function waitForChildExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () =>
        rejectExit(
          new Error(`Process ${child.pid ?? 'unknown'} did not exit within ${timeout}ms.`)
        ),
      timeout
    )
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function assertNoSecrets(text, secrets, label) {
  const leaks = secrets.filter((secret) => nonEmpty(secret) && String(text).includes(secret))
  if (leaks.length > 0) {
    throw new BlockedRunError(`The retained ${label} contained an exact generated RTMP secret.`)
  }
}

function redactedRunError(error, secrets) {
  let redacted = message(error)
  for (const secret of secrets) {
    if (nonEmpty(secret)) redacted = redacted.split(secret).join('<redacted>')
  }
  return error instanceof BlockedRunError
    ? new BlockedRunError(redacted)
    : Object.assign(new Error(redacted), { name: error?.name ?? 'Error' })
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

class BlockedRunError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedRunError'
  }
}
