import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WINDOWS_D3D11_HARDWARE_CLASSES,
  WINDOWS_D3D11_MEDIA_STAGES,
  WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS,
  WINDOWS_D3D11_REQUIRED_RUST_TESTS,
  WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS,
  assertWindowsD3d11RustDiscovery,
  combineWindowsD3d11PathEvidence,
  createWindowsD3d11PathManifest,
  createWindowsD3d11StageReport,
  deriveWindowsD3d11HostIdentity,
  expectedWindowsD3d11Selection,
  mergeWindowsD3d11HostEvidence,
  normalizeWindowsD3d11InvariantSummary,
  parseWindowsD3d11MediaArgs,
  parseWindowsD3d11RustTestList,
  requiredWindowsD3d11StageAssertionIds,
  sha256Bytes,
  sha256CanonicalJson,
  validateWindowsD3d11HostManifest,
  validateWindowsD3d11PathManifest,
  windowsD3d11StageProducerSpec,
  windowsD3d11RustDiscoveryCommand
} from './lib/windows-d3d11-media.mjs'
import { evaluateWindowsStreamRun } from './lib/windows-stream-performance.mjs'
import {
  finalizePreparedJsonArtifact,
  prepareExclusiveJsonArtifact
} from './lib/exclusive-json-artifact.mjs'
import {
  WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
  validateWindowsPerformanceBudget,
  verifyWindowsD3d11PerformanceBudgetDerivation
} from './lib/windows-performance-budget.mjs'
import { validateSupportBundle } from './lib/support-bundle-verifier.mjs'
import { verifyInstalledWindowsCandidate } from './lib/windows-local-gates.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parseWindowsD3d11MediaArgs(process.argv.slice(2))

switch (options.operation) {
  case 'list':
    console.log(
      JSON.stringify(
        {
          stages: WINDOWS_D3D11_MEDIA_STAGES,
          hardwareClasses: WINDOWS_D3D11_HARDWARE_CLASSES,
          requiredWindowsRustTests: WINDOWS_D3D11_REQUIRED_RUST_TESTS
        },
        null,
        2
      )
    )
    break
  case 'verify-windows-rust':
    verifyWindowsRust(options)
    break
  case 'stage':
    await runStage(options)
    break
  case 'merge-evidence':
    await mergeEvidence(options)
    break
  case 'combine-path-evidence':
  case 'finalize-fallback-evidence':
    await combinePathEvidence(options)
    break
  case 'gate':
    await runGate(options)
    break
  default:
    throw new Error(`Unsupported Windows D3D11 media operation: ${options.operation}`)
}

function verifyWindowsRust({ listOnly, stage = 'preview' }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `Windows D3D11 Rust verification is UNSUPPORTED on ${process.platform}/${process.arch}; run it from an x64 Windows source checkout.`
    )
  }
  const [command, args] = windowsD3d11RustDiscoveryCommand()
  const listed = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false
  })
  if (listed.error) throw listed.error
  if (listed.status !== 0) {
    throw new Error(
      `Windows D3D11 Rust discovery failed with exit code ${listed.status}: ${listed.stderr?.trim() || 'no stderr'}`
    )
  }
  const discovered = parseWindowsD3d11RustTestList(listed.stdout)
  assertWindowsD3d11RustDiscovery(discovered, { stage })
  console.log(`Windows D3D11 Rust discovery PASS: ${discovered.length} exact tests.`)
  if (listOnly) {
    return {
      discovered,
      listingSha256: sha256Bytes(Buffer.from(listed.stdout, 'utf8')),
      testOutputSha256: null
    }
  }

  const tested = spawnSync(
    'cargo',
    ['test', '-p', 'videorc-backend', '--bin', 'videorc-backend', 'windows_d3d11'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false
    }
  )
  if (tested.error) throw tested.error
  if (tested.status !== 0) {
    throw new Error(
      `Windows D3D11 focused Rust tests failed with exit code ${tested.status}: ${tested.stderr?.trim() || 'no stderr'}`
    )
  }
  process.stdout.write(tested.stdout)
  process.stderr.write(tested.stderr)
  return {
    discovered,
    listingSha256: sha256Bytes(Buffer.from(listed.stdout, 'utf8')),
    testOutputSha256: sha256Bytes(
      Buffer.from(`${tested.stdout ?? ''}\n${tested.stderr ?? ''}`, 'utf8')
    )
  }
}

async function runStage({ stage, output }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `Windows D3D11 ${stage} stage is UNSUPPORTED on ${process.platform}/${process.arch}; physical Windows source evidence is required.`
    )
  }
  const source = verifyWindowsRust({ stage, listOnly: false })
  if (stage === 'contract') {
    const report = createWindowsD3d11StageReport({
      stage,
      sourceCommit: nullableIdentity(process.env.VIDEORC_RELEASE_SOURCE_COMMIT, 40),
      installerSha256: nullableIdentity(process.env.VIDEORC_RELEASE_EXPECTED_SHA256, 64),
      appSha256: nullableIdentity(process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256, 64),
      payloadSha256: nullableIdentity(
        process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256,
        64
      ),
      assertions: [
        { id: 'exact-windows-rust-discovery', passed: source.discovered.length > 0 },
        { id: 'focused-windows-rust-tests', passed: true }
      ],
      metrics: { discoveredTests: source.discovered.length },
      host: { platform: process.platform, arch: process.arch },
      sourceEvidence: {
        listingSha256: source.listingSha256,
        testOutputSha256: source.testOutputSha256
      }
    })
    if (output) {
      requireAbsolute(output, '--output')
      await writeJsonExclusive(resolve(output, 'contract-stage.json'), report)
    }
    console.log(JSON.stringify(report, null, 2))
    return
  }

  requireAbsolute(output, '--output')
  assertSelectionEnvironmentIsRunnerOwned()
  const expectedCandidate = requiredPhysicalStageCandidateEnvironment()
  const producerRoot = resolve(output, 'installed-app-producer')
  const producerSpec = windowsD3d11StageProducerSpec({ stage, output: producerRoot })
  const producer = spawnSync(
    process.execPath,
    [resolve(repoRoot, 'scripts/smoke-windows-stream-performance.mjs'), ...producerSpec.args],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false
    }
  )
  if (producer.error) throw producer.error
  if (producer.status !== 0) {
    throw new Error(
      `Installed packaged-app ${stage} producer did not pass (exit ${producer.status}).`
    )
  }

  const aggregateArtifact = await readExactJsonArtifact(
    resolve(producerRoot, 'aggregate.json'),
    `${stage} installed-app producer aggregate`
  )
  const aggregate = aggregateArtifact.document
  if (
    aggregate?.kind !== 'videorc.windows-stream-performance-aggregate' ||
    aggregate?.status !== 'diagnostic' ||
    aggregate?.mode !== 'diagnostic' ||
    !equalStringArrays(aggregate?.scenarios, [producerSpec.scenario]) ||
    aggregate?.runs?.length !== 1
  ) {
    throw new Error(`${stage} installed-app producer aggregate was incomplete or mismatched.`)
  }
  const candidate = normalizeCandidate(aggregate.candidate)
  if (sha256CanonicalJson(candidate) !== sha256CanonicalJson(expectedCandidate)) {
    throw new Error(`${stage} installed-app producer used a different candidate identity.`)
  }
  const runSummary = aggregate.runs[0]
  if (
    runSummary?.verdict !== 'PASS' ||
    runSummary?.scenarioId !== producerSpec.scenario ||
    runSummary?.repetition !== 1 ||
    !isAbsolute(runSummary?.reportPath ?? '') ||
    !lowercaseSha256(runSummary?.reportSha256)
  ) {
    throw new Error(`${stage} installed-app producer did not retain one exact PASS report.`)
  }
  const producerReport = await readExactJsonArtifact(
    runSummary.reportPath,
    `${stage} installed-app producer report`
  )
  if (producerReport.sha256 !== runSummary.reportSha256) {
    throw new Error(`${stage} installed-app producer report digest did not match the aggregate.`)
  }
  const evidence = producerReport.document?.evidence
  const reevaluated = evaluateWindowsStreamRun(evidence)
  if (
    producerReport.document?.result?.verdict !== 'PASS' ||
    reevaluated.verdict !== 'PASS' ||
    evidence?.scenarioId !== producerSpec.scenario ||
    evidence?.mode !== 'diagnostic'
  ) {
    throw new Error(`${stage} installed-app producer evidence did not re-evaluate to PASS.`)
  }
  const assertions = physicalStageAssertions({ stage, source, evidence, candidate })
  const failedAssertions = assertions.filter((assertion) => !assertion.passed)
  const report = createWindowsD3d11StageReport({
    stage,
    status: failedAssertions.length === 0 ? 'PASS' : 'FAIL',
    sourceCommit: candidate.sourceCommit,
    installerSha256: candidate.installerSha256,
    appSha256: candidate.appSha256,
    payloadSha256: candidate.payloadSha256,
    assertions,
    metrics: {
      scenario: producerSpec.scenario,
      pipeline: evidence.pipeline,
      media: evidence.media
    },
    host: {
      platform: aggregate.operatingSystem?.platform,
      arch: aggregate.operatingSystem?.arch,
      release: aggregate.operatingSystem?.release,
      hardwareClass: aggregate.hardwareClass
    },
    sourceEvidence: {
      producer: producerSpec.producer,
      producerAggregatePath: aggregateArtifact.path,
      producerAggregateSha256: aggregateArtifact.sha256,
      producerReportPath: producerReport.path,
      producerReportSha256: producerReport.sha256,
      listingSha256: source.listingSha256,
      testOutputSha256: source.testOutputSha256
    }
  })
  if (failedAssertions.length > 0) {
    await writeJsonExclusive(resolve(output, `${stage}-stage.json`), report)
    throw new Error(
      `Windows D3D11 ${stage} stage failed: ${failedAssertions.map(({ id }) => id).join(', ')}.`
    )
  }
  const preparedReport = await prepareExclusiveJsonArtifact(
    resolve(output, `${stage}-stage.json`),
    report
  )
  await finalizePreparedJsonArtifact(preparedReport, async () => {
    await assertArtifactsUnchanged([aggregateArtifact, producerReport])
    await revalidateD3dFinalCandidate(candidate)
  })
  console.log(`Windows D3D11 ${stage} stage PASS.`)
}

function physicalStageAssertions({ stage, source, evidence, candidate }) {
  const d3d11 = evidence?.pipeline?.d3d11
  const zeroCounterFields = [
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
  ]
  const boundedFairness = [
    ['messageDispatchP95Ms', 50],
    ['messageDispatchMaxMs', 100],
    ['mediaCommandLagP95Ms', 50],
    ['mediaCommandLagMaxMs', 100],
    ['maximumConsecutiveMessageBatch', 32],
    ['maximumConsecutiveMediaBatch', 32]
  ].every(([field, maximum]) => {
    const value = d3d11?.[field]
    const integral = field.startsWith('maximumConsecutive') ? Number.isInteger(value) : true
    return integral && Number.isFinite(value) && value >= 0 && value <= maximum
  })
  const assertions = [
    {
      id: 'installed-packaged-candidate',
      passed:
        /^[a-f0-9]{40}$/.test(candidate?.sourceCommit ?? '') &&
        ['installerSha256', 'appSha256', 'payloadSha256'].every((field) =>
          lowercaseSha256(candidate?.[field])
        )
    },
    { id: 'exact-windows-rust-discovery', passed: source.discovered.length > 0 },
    { id: 'focused-windows-rust-tests', passed: lowercaseSha256(source.testOutputSha256) },
    {
      id: 'd3d11-live-same-adapter',
      passed:
        d3d11?.state === 'live' &&
        d3d11?.requested === true &&
        d3d11?.required === true &&
        d3d11RoleAdaptersMatchAuthority(d3d11, {
          auxiliaryRequired: evidence?.context?.topology === 'record-plus-stream'
        })
    },
    {
      id: 'zero-copy-counters',
      passed: zeroCounterFields.every((field) => d3d11?.[field] === 0)
    },
    { id: 'bounded-media-thread-fairness', passed: boundedFairness },
    {
      id: 'no-path-fallback',
      passed:
        !nonEmptyString(d3d11?.fallbackReason) &&
        d3d11?.stateChanged !== true &&
        d3d11?.adapterChanged !== true &&
        d3d11?.fallbackChanged !== true
    }
  ]
  const stagePassed =
    stage === 'capture'
      ? ['desktop-duplication', 'windows-graphics-capture-monitor'].includes(
          d3d11?.captureBackend
        ) && d3d11?.textureImportFrames > 0
      : stage === 'compositor'
        ? evidence?.context?.sourceComposition === 'screen-camera' &&
          d3d11?.cameraUploadFrames > 0 &&
          d3d11?.compositorCpuFallbackFrames === 0
        : stage === 'encoder'
          ? evidence?.pipeline?.effectiveBridgeOutput === 'windows-media-foundation-h264-mpegts' &&
            evidence?.pipeline?.encodedOutputBackend === 'media-foundation' &&
            d3d11?.encoderGpuSamples > 0 &&
            d3d11?.encoderSystemMemorySamples === 0
          : stage === 'preview'
            ? evidence?.context?.previewOpen === true &&
              d3d11?.previewPresents > 0 &&
              d3d11?.previewBmpRequests === 0 &&
              d3d11?.previewBmpBytes === 0 &&
              d3d11?.inputContinuityEvidence?.verdict === 'PASS' &&
              d3d11?.inputContinuityEvidence?.physicalInput === true
            : false
  const stageAssertionId = requiredWindowsD3d11StageAssertionIds(stage).at(-1)
  assertions.push({ id: stageAssertionId, passed: stagePassed })
  return assertions
}

async function runGate(gateOptions) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `Windows D3D11 final gate is UNSUPPORTED on ${process.platform}/${process.arch}; a packaged physical Windows candidate is required.`
    )
  }
  requireAbsolute(gateOptions.output, '--output')
  await assertFreshGateDirectory(gateOptions.output)
  const candidateRoot = windowsD3d11CandidateEvidenceRoot(gateOptions.output)
  assertSelectionEnvironmentIsRunnerOwned()
  if (process.env.VIDEORC_WINDOWS_PERF_BUDGET_PROFILE?.trim()) {
    throw new Error(
      'VIDEORC_WINDOWS_PERF_BUDGET_PROFILE must be unset so each exact context resolves itself.'
    )
  }
  if (process.env.VIDEORC_WINDOWS_HARDWARE_CLASS?.trim() !== gateOptions.hardwareClass) {
    throw new Error(
      `VIDEORC_WINDOWS_HARDWARE_CLASS must exactly equal ${gateOptions.hardwareClass}.`
    )
  }

  const budgetPath = configuredWindowsD3d11BudgetPath()
  const budgetArtifact = await readExactJsonArtifact(budgetPath, 'active D3D11 budget')
  const budgetFailures = validateWindowsPerformanceBudget(budgetArtifact.document)
  if (
    budgetArtifact.document.kind !== WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND ||
    budgetArtifact.document.status !== 'active' ||
    budgetFailures.length > 0
  ) {
    throw new Error(
      `Active D3D11 budget was invalid: ${budgetFailures.join('; ') || 'wrong kind/status'}`
    )
  }
  const derivedBudgetArtifacts = []
  const derivationFailures = await verifyWindowsD3d11PerformanceBudgetDerivation({
    document: budgetArtifact.document,
    budgetPath: budgetArtifact.path,
    candidateRoot,
    onArtifact: (artifact) => derivedBudgetArtifacts.push(artifact)
  })
  if (derivationFailures.length > 0) {
    throw new Error(`Active D3D11 budget derivation was invalid: ${derivationFailures.join('; ')}`)
  }
  const budgetEvidence = await verifyBudgetEvidenceForPath(
    budgetArtifact.document,
    gateOptions.hardwareClass
  )
  const performanceRoot = resolve(gateOptions.output, 'windows-stream-performance')
  const performanceArguments = [
    resolve(repoRoot, 'scripts/smoke-windows-stream-performance.mjs'),
    '--gate',
    '--profiles',
    gateOptions.profiles.join(','),
    '--path-evidence',
    gateOptions.pathEvidence,
    '--output',
    performanceRoot
  ]
  if (gateOptions.pathEvidence === 'forced') {
    performanceArguments.push('--bridge', 'mf', '--require-bridge', '--d3d11', '--require-d3d11')
  } else if (gateOptions.pathEvidence === 'natural') {
    performanceArguments.push('--expect-fallback', 'natural')
  }
  const performance = spawnSync(process.execPath, performanceArguments, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false
  })
  if (performance.error) throw performance.error
  if (performance.status !== 0) {
    throw new Error(
      `Real Windows stream-performance gate did not pass (exit ${performance.status}).`
    )
  }

  const pathManifest = await buildPathManifestFromPerformanceEvidence({
    gateOptions,
    performanceRoot,
    budgetArtifact,
    budgetEvidence,
    candidateRoot
  })
  const tracked = [
    budgetArtifact,
    ...derivedBudgetArtifacts,
    ...budgetEvidence.trackedArtifacts,
    ...pathManifest.trackedArtifacts
  ]
  assertArtifactsInsideCandidateRoot(tracked, candidateRoot, {
    allowedExternalPaths: [budgetArtifact.path]
  })
  const preparedManifest = await prepareExclusiveJsonArtifact(
    resolve(gateOptions.output, 'path-manifest.json'),
    pathManifest.document
  )
  await finalizePreparedJsonArtifact(preparedManifest, async () => {
    await assertArtifactsUnchanged(tracked)
    await revalidateD3dFinalCandidate(pathManifest.document.candidate)
  })
  console.log(`Windows D3D11 ${gateOptions.pathEvidence} PATH_PASS.`)
}

async function buildPathManifestFromPerformanceEvidence({
  gateOptions,
  performanceRoot,
  budgetArtifact,
  budgetEvidence,
  candidateRoot,
  createdAt = new Date().toISOString()
}) {
  const trackedArtifacts = []
  const aggregateArtifact = await readExactJsonArtifact(
    resolve(performanceRoot, 'aggregate.json'),
    'stream-performance aggregate'
  )
  trackedArtifacts.push(aggregateArtifact)
  const aggregate = aggregateArtifact.document
  if (
    aggregate?.schemaVersion !== 1 ||
    aggregate?.kind !== 'videorc.windows-stream-performance-aggregate' ||
    aggregate?.status !== 'passed' ||
    aggregate?.mode !== 'gate' ||
    aggregate?.hardwareClass !== gateOptions.hardwareClass ||
    aggregate?.pathEvidence !== gateOptions.pathEvidence
  ) {
    throw new Error('Stream-performance aggregate did not retain a matching completed gate.')
  }
  const candidate = normalizeCandidate(aggregate.candidate)
  assertCandidateMatchesBudget(candidate, budgetArtifact.document.candidate)
  const expectedScenarios = expectedBudgetScenarios(
    budgetArtifact.document,
    gateOptions.hardwareClass
  )
  assertAggregateScenarioCoverage(aggregate, expectedScenarios)

  const scenarioRecords = []
  const normalizedRuns = []
  const workloadSettings = []
  let hostProjection = null
  const resolvedProfiles = new Map()
  const aggregateRuns = Array.isArray(aggregate.runs) ? aggregate.runs : []
  for (const runSummary of aggregateRuns) {
    if (
      runSummary?.verdict !== 'PASS' ||
      !isAbsolute(runSummary.reportPath ?? '') ||
      !lowercaseSha256(runSummary.reportSha256)
    ) {
      throw new Error('Stream-performance aggregate retained a non-PASS or unbound run.')
    }
    const reportArtifact = await readExactJsonArtifact(
      runSummary.reportPath,
      `${runSummary.scenarioId}#${runSummary.repetition} verdict`
    )
    trackedArtifacts.push(reportArtifact)
    if (reportArtifact.sha256 !== runSummary.reportSha256) {
      throw new Error(
        `${runSummary.scenarioId}#${runSummary.repetition} verdict bytes changed after aggregation.`
      )
    }
    const report = reportArtifact.document
    const evidence = report?.evidence
    const reevaluated = evaluateWindowsStreamRun(evidence)
    if (
      report?.result?.verdict !== 'PASS' ||
      report.result.failures?.length !== 0 ||
      report.result.blockers?.length !== 0 ||
      evidence?.mode !== 'gate' ||
      evidence?.scenarioId !== runSummary.scenarioId ||
      evidence?.repetition !== runSummary.repetition ||
      evidence?.context?.hardwareClass !== gateOptions.hardwareClass
    ) {
      throw new Error('A retained verdict did not prove one matching PASS run.')
    }
    if (
      reevaluated.verdict !== 'PASS' ||
      sha256CanonicalJson(reevaluated) !== sha256CanonicalJson(report.result)
    ) {
      throw new Error(
        'A retained verdict did not independently re-evaluate to its exact PASS result.'
      )
    }
    const runCandidate = normalizeCandidate(evidence.candidate)
    if (sha256CanonicalJson(runCandidate) !== sha256CanonicalJson(candidate)) {
      throw new Error('A run used a different final candidate.')
    }
    validateRunPath(evidence, gateOptions.pathEvidence, budgetArtifact.document)
    const profile = evidence.context.profile
    if (!gateOptions.profiles.includes(profile)) {
      throw new Error(`A run attempted to qualify out-of-scope profile ${profile}.`)
    }
    const budgetProfile = resolveBudgetProfile(
      budgetArtifact.document,
      gateOptions.hardwareClass,
      evidence
    )
    if (
      evidence.budget?.required !== true ||
      evidence.budget?.active !== true ||
      evidence.budget?.applicable !== true ||
      evidence.budget?.profileId !== budgetProfile.id ||
      evidence.budget?.failures?.length !== 0
    ) {
      throw new Error('A run did not resolve one active applicable budget profile.')
    }
    resolvedProfiles.set(budgetProfile.id, {
      id: budgetProfile.id,
      profile,
      scenario:
        gateOptions.pathEvidence === 'natural' ? 'natural-fallback-policy' : evidence.scenarioId,
      sha256: sha256CanonicalJson(budgetProfile)
    })

    const settingsArtifact = await readExactJsonArtifact(
      evidence.artifacts?.settings,
      `${evidence.scenarioId} settings`
    )
    const diagnosticsArtifact = await readExactJsonArtifact(
      resolve(dirname(reportArtifact.path), 'diagnostic-samples.json'),
      `${evidence.scenarioId} diagnostics`
    )
    trackedArtifacts.push(settingsArtifact, diagnosticsArtifact)
    const selectedScreen = settingsArtifact.document?.source?.screen
    const selectedScreenAdapterLuid = selectedAdapterLuid(selectedScreen?.id)
    const runHostProjection = {
      operatingSystem: aggregate.operatingSystem,
      selectedScreenId: selectedScreen?.id,
      selectedScreenDetail: selectedScreen?.detail,
      adapterLuid: selectedScreenAdapterLuid,
      screenSettingsSha256: sha256CanonicalJson(selectedScreen)
    }
    if (hostProjection === null) hostProjection = runHostProjection
    else if (sha256CanonicalJson(hostProjection) !== sha256CanonicalJson(runHostProjection)) {
      throw new Error('Runs did not retain one physical host/display identity.')
    }

    const diagnosticSamples = [
      ...(diagnosticsArtifact.document?.samples ?? []),
      ...(diagnosticsArtifact.document?.terminal ? [diagnosticsArtifact.document.terminal] : [])
    ]
    if (diagnosticSamples.length === 0) {
      throw new Error('A run retained no diagnostic samples.')
    }
    const previewOpen = evidence.context.previewOpen === true
    const presenterSamples = diagnosticSamples
      .map((sample) => sample?.previewSurfaceStatus?.windowsD3d11Presenter)
      .filter(Boolean)
    if (
      gateOptions.pathEvidence !== 'natural' &&
      previewOpen &&
      presenterSamples.length !== diagnosticSamples.length
    ) {
      throw new Error('A preview-open D3D run did not retain presenter proof in every sample.')
    }
    const d3dSamples = diagnosticSamples.map((sample) => sample?.windowsD3d11Media).filter(Boolean)
    if (d3dSamples.length !== diagnosticSamples.length) {
      throw new Error('A run did not retain Windows D3D media diagnostics in every sample.')
    }
    validateD3d11AdapterSamples(d3dSamples, {
      natural: gateOptions.pathEvidence === 'natural',
      auxiliaryRequired: evidence.context.topology === 'record-plus-stream'
    })
    const enrichedReport = structuredClone(report)
    enrichedReport.evidence.pipeline.d3d11 = {
      ...enrichedReport.evidence.pipeline.d3d11,
      texturePoolCapacitySamples: d3dSamples.map((sample) => sample.texturePoolCapacity),
      texturePoolInUseSamples: d3dSamples.map((sample) => sample.texturePoolInUse),
      staleGenerationCallbacks: maximumCounter(d3dSamples, 'staleGenerationCallbacks')
    }
    normalizedRuns.push({
      ...enrichedReport,
      selectedScreenAdapterLuid:
        gateOptions.pathEvidence === 'natural' ? null : selectedScreenAdapterLuid,
      presenterSamples
    })
    workloadSettings.push({
      id: evidence.scenarioId,
      repetition: evidence.repetition,
      profile,
      timing: evidence.timing,
      source: {
        screenId: settingsArtifact.document?.source?.screen?.id,
        cameraId: settingsArtifact.document?.source?.camera?.id ?? null,
        microphoneId: settingsArtifact.document?.source?.microphone?.id ?? null
      },
      topology: evidence.context.topology,
      sourceComposition: evidence.context.sourceComposition,
      previewOpen
    })

    const artifactBindings = {}
    let supportBundleArtifact = null
    for (const [name, artifactPath] of Object.entries({
      ...evidence.artifacts,
      diagnostics: diagnosticsArtifact.path
    })) {
      if (!artifactPath) throw new Error(`Run artifact ${name} was missing.`)
      const artifact =
        resolve(artifactPath) === reportArtifact.path
          ? reportArtifact
          : resolve(artifactPath) === settingsArtifact.path
            ? settingsArtifact
            : resolve(artifactPath) === diagnosticsArtifact.path
              ? diagnosticsArtifact
              : name === 'supportBundle'
                ? await readExactJsonArtifact(artifactPath, `${evidence.scenarioId} ${name}`)
                : await readExactFileArtifact(artifactPath, `${evidence.scenarioId} ${name}`)
      if (!trackedArtifacts.includes(artifact)) trackedArtifacts.push(artifact)
      artifactBindings[name] = { path: artifact.path, sha256: artifact.sha256 }
      if (name === 'supportBundle') supportBundleArtifact = artifact
    }
    if (!supportBundleArtifact) {
      throw new Error('Support-bundle artifact was missing while constructing path evidence.')
    }
    const supportBundleValidation = validateSupportBundle(supportBundleArtifact.document, {
      windowsAcceptance: true
    })
    if (!supportBundleValidation.ok) {
      throw new Error(
        `Support bundle did not pass strict Windows acceptance validation: ${supportBundleValidation.failures.join('; ')}`
      )
    }
    const lifecycleSha256 = sha256CanonicalJson(evidence.network?.lifecycle)
    const faultProjection = {
      d3d11: {
        state: evidence.pipeline?.d3d11?.state,
        fallbackReason: evidence.pipeline?.d3d11?.fallbackReason ?? null,
        texturePoolPressureEvents: evidence.pipeline?.d3d11?.texturePoolPressureEvents,
        adapterMismatches: evidence.pipeline?.d3d11?.adapterMismatches,
        deviceResets: evidence.pipeline?.d3d11?.deviceResets,
        staleGenerationCallbacks: maximumCounter(d3dSamples, 'staleGenerationCallbacks'),
        stateChanged: evidence.pipeline?.d3d11?.stateChanged,
        adapterChanged: evidence.pipeline?.d3d11?.adapterChanged,
        fallbackChanged: evidence.pipeline?.d3d11?.fallbackChanged
      },
      process: {
        teardownClean: evidence.process?.teardownClean,
        leakDetected: evidence.process?.leakDetected,
        gracefulQuit: evidence.process?.gracefulQuit
      },
      network: {
        reconnects: evidence.network?.reconnects,
        unexpectedExit: evidence.network?.unexpectedExit
      }
    }
    const faultSha256 = sha256CanonicalJson(faultProjection)
    const comparisonSha256 =
      gateOptions.pathEvidence === 'natural'
        ? sha256CanonicalJson({
            status: 'NOT_APPLICABLE',
            obsParityQualified: false,
            policySha256: budgetEvidence.policySha256
          })
        : budgetEvidence.comparisonSha256
    const inputEvidence = evidence.pipeline?.d3d11?.inputContinuityEvidence
    const inputContinuity = {
      verdict: inputEvidence?.verdict,
      applicable: inputEvidence?.applicable,
      physicalInput: inputEvidence?.physicalInput,
      evidenceSha256: sha256CanonicalJson(inputEvidence)
    }
    const inputContinuitySha256 = sha256CanonicalJson(inputContinuity)
    const cameraUpload = {
      sourceComposition: evidence.context.sourceComposition,
      frames: evidence.pipeline?.d3d11?.cameraUploadFrames
    }
    cameraUpload.sha256 = sha256CanonicalJson(cameraUpload)
    scenarioRecords.push({
      id: evidence.scenarioId,
      repetition: evidence.repetition,
      profile,
      sourceComposition: evidence.context.sourceComposition,
      previewOpen,
      report: { path: reportArtifact.path, sha256: reportArtifact.sha256 },
      scenarioSha256: sha256CanonicalJson({
        id: evidence.scenarioId,
        repetition: evidence.repetition,
        profile,
        reportSha256: reportArtifact.sha256,
        sourceComposition: evidence.context.sourceComposition,
        previewOpen
      }),
      artifacts: artifactBindings,
      artifactSetSha256: sha256CanonicalJson(artifactBindings),
      supportBundleSha256: artifactBindings.supportBundle.sha256,
      lifecycle: { verdict: 'PASS', sha256: lifecycleSha256 },
      lifecycleSha256,
      fault: { verdict: 'PASS', sha256: faultSha256 },
      faultSha256,
      comparison: {
        status: gateOptions.pathEvidence === 'natural' ? 'NOT_APPLICABLE' : 'BOUND',
        sha256: comparisonSha256
      },
      comparisonSha256,
      inputContinuity,
      inputContinuitySha256,
      cameraUpload,
      cameraUploadSha256: cameraUpload.sha256
    })
  }
  scenarioRecords.sort(compareScenarioRun)
  workloadSettings.sort(compareScenarioRun)
  const workloadScenarios = expectedScenarios.map(
    ({ id, profile, repetitions, sourceComposition, previewOpen }) => ({
      id,
      profile,
      repetitions,
      sourceComposition,
      previewOpen
    })
  )
  const scenarioCoordinates = workloadScenarios.map(
    ({ id, profile, repetitions, sourceComposition, previewOpen }) => ({
      id,
      profile,
      repetitions,
      sourceComposition,
      previewOpen
    })
  )
  const resolvedProfileList = [...resolvedProfiles.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
  const host = deriveWindowsD3d11HostIdentity({
    declaredClass: gateOptions.hardwareClass,
    operatingSystem: hostProjection.operatingSystem,
    selectedScreenId: hostProjection.selectedScreenId,
    selectedScreenDetail: hostProjection.selectedScreenDetail,
    adapterLuid: hostProjection.adapterLuid,
    settingsSha256: hostProjection.screenSettingsSha256
  })
  const invariants = normalizeWindowsD3d11InvariantSummary(normalizedRuns, {
    pathEvidence: gateOptions.pathEvidence
  })
  const authorityAdapterLuid =
    gateOptions.pathEvidence === 'natural'
      ? null
      : normalizedRuns[0]?.evidence?.pipeline?.d3d11?.adapterLuid
  const captureAdapterLuid = observedRoleAdapterLuid(normalizedRuns, 'captureAdapterLuid')
  const compositorAdapterLuid = observedRoleAdapterLuid(normalizedRuns, 'compositorAdapterLuid')
  const primaryEncoderAdapterLuid = observedRoleAdapterLuid(
    normalizedRuns,
    'primaryEncoderAdapterLuid'
  )
  const auxiliaryEncoderAdapterLuid = observedRoleAdapterLuid(
    normalizedRuns,
    'auxiliaryEncoderAdapterLuid'
  )
  const evidence = {
    performanceAggregate: {
      path: aggregateArtifact.path,
      sha256: aggregateArtifact.sha256
    },
    scenarios: scenarioRecords,
    scenarioEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ scenarioSha256 }) => scenarioSha256)
    ),
    artifactEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ artifactSetSha256 }) => artifactSetSha256)
    ),
    supportBundleEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ supportBundleSha256 }) => supportBundleSha256)
    ),
    lifecycleEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ lifecycleSha256 }) => lifecycleSha256)
    ),
    faultEvidenceSha256: sha256CanonicalJson(scenarioRecords.map(({ faultSha256 }) => faultSha256)),
    comparisonEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ comparisonSha256 }) => comparisonSha256)
    ),
    inputContinuityEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ inputContinuitySha256 }) => inputContinuitySha256)
    ),
    cameraUploadEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ cameraUploadSha256 }) => cameraUploadSha256)
    )
  }
  const document = createWindowsD3d11PathManifest({
    createdAt,
    candidate,
    host,
    profiles: gateOptions.profiles,
    selection: expectedWindowsD3d11Selection(gateOptions.pathEvidence),
    budget: {
      path: budgetArtifact.path,
      activeSha256: budgetArtifact.sha256,
      resolvedProfiles: resolvedProfileList,
      resolvedProfileSetSha256: sha256CanonicalJson(resolvedProfileList)
    },
    workload: {
      scenarios: workloadScenarios,
      scenarioSetSha256: sha256CanonicalJson(workloadScenarios),
      scenarioCoordinatesSha256: sha256CanonicalJson(scenarioCoordinates),
      settingsSha256: sha256CanonicalJson(workloadSettings)
    },
    adapterProof: {
      scope:
        gateOptions.pathEvidence === 'natural'
          ? 'named-natural-fallback-without-d3d-authority'
          : 'selected-dxgi-display-plus-per-role-session-authority',
      perRoleLuidsAvailable: gateOptions.pathEvidence !== 'natural',
      selectedScreenAdapterLuid:
        gateOptions.pathEvidence === 'natural' ? null : hostProjection.adapterLuid,
      mediaAuthorityAdapterLuid: authorityAdapterLuid,
      captureAdapterLuid,
      compositorAdapterLuid,
      primaryEncoderAdapterLuid,
      auxiliaryEncoderAdapterLuid,
      equal:
        gateOptions.pathEvidence === 'natural'
          ? null
          : hostProjection.adapterLuid === authorityAdapterLuid &&
            invariants.adapterRolesMatchAuthority
    },
    invariants,
    evidence,
    runtimeProofLimitations: []
  })
  assertArtifactsInsideCandidateRoot(
    [...budgetEvidence.trackedArtifacts, ...trackedArtifacts],
    candidateRoot
  )
  return { document, trackedArtifacts }
}

function validateRunPath(evidence, pathEvidence, budget) {
  const pipeline = evidence?.pipeline
  const d3d11 = pipeline?.d3d11
  if (pipeline?.expectedD3d11Path !== pathEvidence) {
    throw new Error('Run path-evidence label did not match the requested child mode.')
  }
  if (pathEvidence === 'natural') {
    const expectedBackend = budget.naturalFallbackPolicy?.observed?.effectiveEncoderBackend
    if (
      evidence.context?.mediaPath !== 'legacy-fallback' ||
      evidence.context?.selectionMode !== 'natural' ||
      pipeline?.expectedFallback !== 'natural' ||
      d3d11?.state !== 'fallback' ||
      d3d11?.captureBackend !== 'legacy-ffmpeg' ||
      !nonEmptyString(d3d11?.fallbackReason) ||
      pipeline?.effectiveEncodeBackend !== expectedBackend
    ) {
      throw new Error('Natural run did not prove the named legacy fallback path.')
    }
    if (
      [
        'adapterLuid',
        'captureAdapterLuid',
        'compositorAdapterLuid',
        'primaryEncoderAdapterLuid',
        'auxiliaryEncoderAdapterLuid'
      ].some((field) => nonEmptyString(d3d11?.[field]))
    ) {
      throw new Error('Natural run claimed a D3D11 adapter authority or role.')
    }
    return
  }
  if (
    evidence.context?.mediaPath !== 'd3d11-native' ||
    pipeline?.requestedBridgeOutput !== 'windows-media-foundation-h264-mpegts' ||
    pipeline?.effectiveBridgeOutput !== 'windows-media-foundation-h264-mpegts' ||
    pipeline?.effectiveEncodeBackend !== 'hardware-media-foundation' ||
    pipeline?.encodedOutputBackend !== 'media-foundation' ||
    d3d11?.state !== 'live' ||
    d3d11?.requested !== true ||
    d3d11?.required !== (pathEvidence === 'forced') ||
    !d3d11RoleAdaptersMatchAuthority(d3d11, {
      auxiliaryRequired: evidence.context?.topology === 'record-plus-stream'
    }) ||
    nonEmptyString(d3d11?.fallbackReason)
  ) {
    throw new Error('Supported run did not prove the requested/effective D3D11 + MF path.')
  }
}

function validateD3d11AdapterSamples(samples, { natural, auxiliaryRequired }) {
  for (const [index, sample] of samples.entries()) {
    if (natural) {
      if (
        [
          'adapterLuid',
          'captureAdapterLuid',
          'compositorAdapterLuid',
          'primaryEncoderAdapterLuid',
          'auxiliaryEncoderAdapterLuid'
        ].some((field) => nonEmptyString(sample?.[field]))
      ) {
        throw new Error(`Natural diagnostic sample ${index + 1} claimed a D3D11 adapter role.`)
      }
    } else if (!d3d11RoleAdaptersMatchAuthority(sample, { auxiliaryRequired })) {
      throw new Error(
        `D3D11 diagnostic sample ${index + 1} did not bind every active role to the media authority adapter.`
      )
    }
  }
}

function d3d11RoleAdaptersMatchAuthority(d3d11, { auxiliaryRequired }) {
  const authority = d3d11?.adapterLuid
  if (!/^[a-f0-9]{16}$/.test(authority ?? '')) return false
  if (
    ['captureAdapterLuid', 'compositorAdapterLuid', 'primaryEncoderAdapterLuid'].some(
      (field) => d3d11?.[field] !== authority
    )
  ) {
    return false
  }
  const auxiliary = d3d11?.auxiliaryEncoderAdapterLuid
  return auxiliaryRequired ? auxiliary === authority : auxiliary == null || auxiliary === authority
}

function observedRoleAdapterLuid(runs, field) {
  const values = [
    ...new Set(
      runs
        .map((run) => run?.evidence?.pipeline?.d3d11?.[field])
        .filter((value) => nonEmptyString(value))
    )
  ]
  return values.length === 1 ? values[0] : null
}

async function verifyBudgetEvidenceForPath(document, hardwareClass) {
  const trackedArtifacts = []
  if (hardwareClass === 'unsupported-natural-fallback') {
    const policy = document.naturalFallbackPolicy
    if (policy?.invariants?.obsParityQualified !== false || policy?.invariants?.maximumFps !== 30) {
      throw new Error('Natural fallback policy was missing or attempted OBS/60fps qualification.')
    }
    const calibration = await readExactFileArtifact(
      policy.evidence?.calibrationPath,
      'natural fallback calibration aggregate'
    )
    if (calibration.sha256 !== policy.evidence?.calibrationSha256) {
      throw new Error('Natural fallback calibration bytes did not match the active policy.')
    }
    trackedArtifacts.push(calibration)
    const reports = await verifyPathHashPairs(
      policy.evidence?.reportPaths,
      policy.evidence?.reportSha256,
      'natural fallback report'
    )
    trackedArtifacts.push(...reports)
    return {
      trackedArtifacts,
      comparisonSha256: null,
      policySha256: sha256CanonicalJson(policy)
    }
  }

  const comparison = document.comparisonEvidence?.find(
    (entry) => entry?.hardwareClass === hardwareClass
  )
  if (!comparison) throw new Error(`Budget comparison evidence for ${hardwareClass} was missing.`)
  const comparisonArtifact = await readExactFileArtifact(
    comparison.aggregatePath,
    `${hardwareClass} OBS comparison aggregate`
  )
  if (comparisonArtifact.sha256 !== comparison.aggregateSha256) {
    throw new Error(`${hardwareClass} comparison aggregate bytes changed after budget review.`)
  }
  trackedArtifacts.push(comparisonArtifact)
  const profiles = document.profiles.filter(
    (profile) => profile?.scope?.hardwareClass === hardwareClass
  )
  for (const profile of profiles) {
    const calibration = await readExactFileArtifact(
      profile.evidence?.calibrationPath,
      `${profile.id} calibration aggregate`
    )
    if (calibration.sha256 !== profile.evidence?.calibrationSha256) {
      throw new Error(`${profile.id} calibration aggregate bytes changed after review.`)
    }
    trackedArtifacts.push(calibration)
    const reports = await verifyPathHashPairs(
      profile.evidence?.reportPaths,
      profile.evidence?.reportSha256,
      `${profile.id} calibration report`
    )
    trackedArtifacts.push(...reports)
    if (
      resolve(profile.evidence?.comparisonPath ?? '') !== comparisonArtifact.path ||
      profile.evidence?.comparisonSha256 !== comparisonArtifact.sha256
    ) {
      throw new Error(`${profile.id} did not bind the class comparison aggregate.`)
    }
  }
  return {
    trackedArtifacts: deduplicateArtifacts(trackedArtifacts),
    comparisonSha256: comparisonArtifact.sha256,
    policySha256: null
  }
}

async function verifyPathHashPairs(paths, hashes, label) {
  if (
    !Array.isArray(paths) ||
    !Array.isArray(hashes) ||
    paths.length === 0 ||
    paths.length !== hashes.length
  ) {
    throw new Error(`${label} path/hash pairs were incomplete.`)
  }
  const artifacts = []
  for (let index = 0; index < paths.length; index += 1) {
    const artifact = await readExactFileArtifact(paths[index], `${label} ${index + 1}`)
    if (artifact.sha256 !== hashes[index]) {
      throw new Error(`${label} ${index + 1} bytes changed after budget review.`)
    }
    artifacts.push(artifact)
  }
  return artifacts
}

function expectedBudgetScenarios(document, hardwareClass) {
  if (hardwareClass === 'unsupported-natural-fallback') {
    return WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS.map((id) => ({
      id,
      profile: '1080p30',
      repetitions: 3,
      sourceComposition: 'screen-only',
      previewOpen: !id.endsWith('-no-preview')
    }))
  }
  return document.profiles
    .filter((profile) => profile?.scope?.hardwareClass === hardwareClass)
    .map((profile) => ({
      id: profile.scope.scenario,
      profile: profile.scope.profile,
      repetitions: profile.evidence.reportSha256.length,
      sourceComposition: profile.scope.sourceComposition,
      previewOpen: profile.scope.previewOpen
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function assertAggregateScenarioCoverage(aggregate, expected) {
  const aggregateScenarios = [...(aggregate.scenarios ?? [])].sort()
  const expectedIds = expected.map(({ id }) => id).sort()
  if (
    aggregateScenarios.length !== expectedIds.length ||
    aggregateScenarios.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error('Stream-performance aggregate did not cover the exact budget scenario set.')
  }
  const expectedRuns = expected.reduce((sum, scenario) => sum + scenario.repetitions, 0)
  if (aggregate.runs?.length !== expectedRuns) {
    throw new Error(
      `Stream-performance aggregate retained ${aggregate.runs?.length}/${expectedRuns} runs.`
    )
  }
  for (const scenario of expected) {
    if (aggregate.repetitions?.[scenario.id] !== scenario.repetitions) {
      throw new Error(`${scenario.id} repetition count did not match reviewed evidence.`)
    }
  }
}

function resolveBudgetProfile(document, hardwareClass, evidence) {
  if (hardwareClass === 'unsupported-natural-fallback') {
    return document.naturalFallbackPolicy
  }
  const matches = document.profiles.filter(
    (profile) =>
      profile?.scope?.hardwareClass === hardwareClass &&
      profile.scope.scenario === evidence.scenarioId &&
      profile.scope.profile === evidence.context?.profile
  )
  if (matches.length !== 1) {
    throw new Error(`Run ${evidence.scenarioId} did not resolve exactly one budget profile.`)
  }
  return matches[0]
}

async function combinePathEvidence({ inputPaths, hardwareClass, output, operation }) {
  requireAbsolute(output, '--output')
  const candidateRoot = dirname(resolve(output))
  const artifacts = await Promise.all(
    inputPaths.map((path, index) => readExactJsonArtifact(path, `path manifest ${index + 1}`))
  )
  assertArtifactsInsideCandidateRoot(artifacts, candidateRoot)
  const verifiedTrees = []
  for (const artifact of artifacts) {
    verifiedTrees.push(await verifyPathManifestTree(artifact, candidateRoot))
  }
  const host = combineWindowsD3d11PathEvidence(artifacts, { hardwareClass, operation })
  const tracked = deduplicateArtifacts([
    ...artifacts,
    ...verifiedTrees.flatMap((tree) => tree.trackedArtifacts)
  ])
  assertArtifactsInsideCandidateRoot(tracked, candidateRoot, {
    allowedExternalPaths: verifiedTrees.flatMap((tree) => tree.externalAuthorityPaths)
  })
  const preparedManifest = await prepareExclusiveJsonArtifact(
    resolve(output, 'host-manifest.json'),
    host
  )
  await finalizePreparedJsonArtifact(preparedManifest, async () => {
    await assertArtifactsUnchanged(tracked)
    await revalidateD3dFinalCandidate(host.candidate)
  })
  console.log(`Windows D3D11 ${hardwareClass} HOST_PASS.`)
}

async function mergeEvidence({ inputPaths, output }) {
  requireAbsolute(output, '--output')
  const candidateRoot = dirname(resolve(output))
  const artifacts = await Promise.all(
    inputPaths.map((path, index) => readExactJsonArtifact(path, `host manifest ${index + 1}`))
  )
  assertArtifactsInsideCandidateRoot(artifacts, candidateRoot)
  const tracked = [...artifacts]
  const externalAuthorityPaths = []
  for (const [hostIndex, artifact] of artifacts.entries()) {
    const failures = validateWindowsD3d11HostManifest(artifact.document)
    if (failures.length > 0) {
      throw new Error(`Host manifest ${hostIndex + 1} was invalid: ${failures.join('; ')}`)
    }
    const pathArtifacts = []
    for (const [pathIndex, binding] of artifact.document.pathManifests.entries()) {
      const child = await readExactJsonArtifact(
        binding.path,
        `host manifest ${hostIndex + 1} path manifest ${pathIndex + 1}`
      )
      if (child.sha256 !== binding.sha256) {
        throw new Error(`Host manifest ${hostIndex + 1} child ${pathIndex + 1} bytes changed.`)
      }
      const verifiedTree = await verifyPathManifestTree(child, candidateRoot)
      pathArtifacts.push(child)
      tracked.push(child, ...verifiedTree.trackedArtifacts)
      externalAuthorityPaths.push(...verifiedTree.externalAuthorityPaths)
    }
    const rebuilt = combineWindowsD3d11PathEvidence(pathArtifacts, {
      hardwareClass: artifact.document.hardwareClass,
      operation:
        artifact.document.hardwareClass === 'unsupported-natural-fallback'
          ? 'finalize-fallback-evidence'
          : 'combine-path-evidence'
    })
    if (sha256CanonicalJson(rebuilt) !== sha256CanonicalJson(artifact.document)) {
      throw new Error(`Host manifest ${hostIndex + 1} did not match its recursively rebuilt tree.`)
    }
  }
  const aggregate = mergeWindowsD3d11HostEvidence(artifacts)
  assertArtifactsInsideCandidateRoot(tracked, candidateRoot, {
    allowedExternalPaths: externalAuthorityPaths
  })
  const preparedAggregate = await prepareExclusiveJsonArtifact(
    resolve(output, 'aggregate.json'),
    aggregate
  )
  await finalizePreparedJsonArtifact(preparedAggregate, async () => {
    await assertArtifactsUnchanged(tracked)
    await revalidateD3dFinalCandidate(aggregate.candidate)
  })
  console.log('Windows D3D11 aggregate evidence PASS.')
}

async function verifyPathManifestTree(manifestArtifact, candidateRoot) {
  assertArtifactsInsideCandidateRoot([manifestArtifact], candidateRoot)
  const manifestFailures = validateWindowsD3d11PathManifest(manifestArtifact.document)
  if (manifestFailures.length > 0) {
    throw new Error(`Path manifest was invalid: ${manifestFailures.join('; ')}`)
  }
  const manifest = manifestArtifact.document
  const configuredBudgetPath = configuredWindowsD3d11BudgetPath()
  if (canonicalPath(resolve(manifest.budget.path)) !== canonicalPath(configuredBudgetPath)) {
    throw new Error('Path manifest did not bind the exact configured active D3D11 budget.')
  }
  const budgetArtifact = await readExactJsonArtifact(manifest.budget.path, 'path budget')
  if (budgetArtifact.sha256 !== manifest.budget.activeSha256) {
    throw new Error('Path manifest active budget bytes changed.')
  }
  const budgetFailures = validateWindowsPerformanceBudget(budgetArtifact.document)
  if (
    budgetArtifact.document.kind !== WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND ||
    budgetArtifact.document.status !== 'active' ||
    budgetFailures.length > 0
  ) {
    throw new Error(`Path manifest active budget was invalid: ${budgetFailures.join('; ')}`)
  }
  const derivedBudgetArtifacts = []
  const derivationFailures = await verifyWindowsD3d11PerformanceBudgetDerivation({
    document: budgetArtifact.document,
    budgetPath: budgetArtifact.path,
    candidateRoot,
    onArtifact: (artifact) => derivedBudgetArtifacts.push(artifact)
  })
  if (derivationFailures.length > 0) {
    throw new Error(`Path budget derivation was invalid: ${derivationFailures.join('; ')}`)
  }
  const budgetEvidence = await verifyBudgetEvidenceForPath(
    budgetArtifact.document,
    manifest.host.declaredClass
  )
  const rebuilt = await buildPathManifestFromPerformanceEvidence({
    gateOptions: {
      hardwareClass: manifest.host.declaredClass,
      pathEvidence: manifest.selection.mode,
      profiles: manifest.profiles
    },
    performanceRoot: dirname(resolve(manifest.evidence.performanceAggregate.path)),
    budgetArtifact,
    budgetEvidence,
    candidateRoot,
    createdAt: manifest.createdAt
  })
  if (sha256CanonicalJson(rebuilt.document) !== sha256CanonicalJson(manifest)) {
    throw new Error('Path manifest did not match its recursively rebuilt retained evidence tree.')
  }
  const trackedArtifacts = deduplicateArtifacts([
    manifestArtifact,
    budgetArtifact,
    ...derivedBudgetArtifacts,
    ...budgetEvidence.trackedArtifacts,
    ...rebuilt.trackedArtifacts
  ])
  assertArtifactsInsideCandidateRoot(trackedArtifacts, candidateRoot, {
    allowedExternalPaths: [budgetArtifact.path]
  })
  return { trackedArtifacts, externalAuthorityPaths: [budgetArtifact.path] }
}

async function readExactJsonArtifact(path, label) {
  const file = await resolveUnaliasedFile(path, label)
  const bytes = await readFile(file)
  let document
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error.message}`)
  }
  return {
    path: file,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    document
  }
}

async function readExactFileArtifact(path, label) {
  const file = await resolveUnaliasedFile(path, label)
  const metadata = await stat(file)
  return {
    path: file,
    sha256: await sha256File(file),
    size: metadata.size
  }
}

async function resolveUnaliasedFile(path, label) {
  requireAbsolute(path, label)
  const requested = resolve(path)
  const link = await lstat(requested).catch((error) => {
    throw new Error(`${label} could not be read: ${error.message}`)
  })
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new Error(`${label} must be one regular, non-symlink file.`)
  }
  const actual = await realpath(requested)
  if (canonicalPath(actual) !== canonicalPath(requested)) {
    throw new Error(`${label} path was aliased: ${requested} -> ${actual}`)
  }
  return requested
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', resolveHash)
  })
  return hash.digest('hex')
}

async function assertArtifactsUnchanged(artifacts) {
  for (const artifact of deduplicateArtifacts(artifacts)) {
    const metadata = await stat(artifact.path)
    if (metadata.size !== artifact.size || (await sha256File(artifact.path)) !== artifact.sha256) {
      throw new Error(`Evidence artifact changed while finalizing: ${artifact.path}`)
    }
  }
}

async function assertFreshGateDirectory(path) {
  const existing = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error(`Gate output already exists; refusing overwrite: ${path}`)
}

async function writeJsonExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function assertSelectionEnvironmentIsRunnerOwned() {
  const inherited = WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.filter((key) =>
    process.env[key]?.trim()
  )
  if (inherited.length > 0) {
    throw new Error(
      `Selection environment must be absent before launch; the runner owns it: ${inherited.join(', ')}`
    )
  }
}

async function revalidateD3dFinalCandidate(expectedCandidate) {
  const executable =
    process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE?.trim() ||
    process.env.VIDEORC_PERF_APP_EXECUTABLE?.trim()
  if (!executable || !isAbsolute(executable)) {
    throw new Error(
      'D3D11 PASS finalization requires an absolute installed Videorc acceptance executable.'
    )
  }
  const verified = await verifyInstalledWindowsCandidate({
    executablePath: executable,
    repoRoot,
    env: process.env,
    platform: process.platform
  })
  const actualCandidate = normalizeCandidate({
    sourceCommit: verified.sourceCommit,
    installerSha256: verified.installerSha256,
    sha256: verified.executableSha256,
    packagePayload: verified.packagePayload
  })
  if (sha256CanonicalJson(actualCandidate) !== sha256CanonicalJson(expectedCandidate)) {
    throw new Error(
      'Installed Windows candidate changed or differed immediately before D3D11 PASS finalization.'
    )
  }
  return verified
}

function normalizeCandidate(value) {
  const candidate = {
    sourceCommit: value?.sourceCommit,
    installerSha256: value?.installerSha256,
    appSha256: value?.sha256,
    payloadSha256: value?.packagePayload?.sha256
  }
  if (
    !/^[a-f0-9]{40}$/.test(candidate.sourceCommit ?? '') ||
    !lowercaseSha256(candidate.installerSha256) ||
    !lowercaseSha256(candidate.appSha256) ||
    !lowercaseSha256(candidate.payloadSha256)
  ) {
    throw new Error('Stream evidence did not bind source, installer, app, and payload identity.')
  }
  return candidate
}

function assertCandidateMatchesBudget(candidate, budgetCandidate) {
  const normalizedBudget = {
    sourceCommit: budgetCandidate?.sourceCommit,
    installerSha256: budgetCandidate?.installerSha256,
    appSha256: budgetCandidate?.executableSha256,
    payloadSha256: budgetCandidate?.packagePayloadSha256
  }
  if (sha256CanonicalJson(candidate) !== sha256CanonicalJson(normalizedBudget)) {
    throw new Error('Stream candidate did not match the active D3D11 budget candidate.')
  }
}

function selectedAdapterLuid(screenId) {
  const match = /^screen:dxgi:([a-f0-9]{16}):\d+$/.exec(screenId ?? '')
  if (!match) throw new Error('Selected screen did not retain a canonical DXGI adapter LUID.')
  return match[1]
}

function nullableIdentity(value, length) {
  const normalized = value?.trim()
  return new RegExp(`^[a-f0-9]{${length}}$`).test(normalized ?? '') ? normalized : null
}

function requiredPhysicalStageCandidateEnvironment() {
  const candidate = {
    sourceCommit: nullableIdentity(process.env.VIDEORC_RELEASE_SOURCE_COMMIT, 40),
    installerSha256: nullableIdentity(process.env.VIDEORC_RELEASE_EXPECTED_SHA256, 64),
    appSha256: nullableIdentity(process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256, 64),
    payloadSha256: nullableIdentity(
      process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256,
      64
    )
  }
  const missing = Object.entries(candidate)
    .filter(([, value]) => value === null)
    .map(([field]) => field)
  if (missing.length > 0) {
    throw new Error(
      `Physical D3D11 stage producer requires final installed-candidate identity: ${missing.join(', ')}.`
    )
  }
  const executable =
    process.env.VIDEORC_PERF_APP_EXECUTABLE?.trim() ||
    process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE?.trim()
  if (!executable || !isAbsolute(executable)) {
    throw new Error(
      'Physical D3D11 stage producer requires an absolute installed Videorc executable.'
    )
  }
  return candidate
}

function equalStringArrays(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function maximumCounter(samples, field) {
  const values = samples.map((sample) => sample?.[field])
  return values.every(Number.isFinite) ? Math.max(...values) : null
}

function compareScenarioRun(left, right) {
  return left.id.localeCompare(right.id) || left.repetition - right.repetition
}

function deduplicateArtifacts(artifacts) {
  return [
    ...new Map(
      artifacts.filter(Boolean).map((artifact) => [`${artifact.path}:${artifact.sha256}`, artifact])
    ).values()
  ]
}

function canonicalPath(path) {
  return process.platform === 'win32' ? path.replaceAll('/', '\\').toLocaleLowerCase('en-US') : path
}

function windowsD3d11CandidateEvidenceRoot(output) {
  const acceptanceRoot = process.env.VIDEORC_WINDOWS_ACCEPTANCE_DIR?.trim()
  if (!acceptanceRoot || !isAbsolute(acceptanceRoot)) {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_DIR must be the exact absolute hardware-class evidence root.'
    )
  }
  assertPathInsideCandidateRoot(acceptanceRoot, output, '--output')
  return dirname(resolve(acceptanceRoot))
}

function configuredWindowsD3d11BudgetPath() {
  const value = process.env.VIDEORC_WINDOWS_PERF_BUDGET_PATH?.trim()
  requireAbsolute(value, 'VIDEORC_WINDOWS_PERF_BUDGET_PATH')
  return resolve(value)
}

function assertArtifactsInsideCandidateRoot(
  artifacts,
  candidateRoot,
  { allowedExternalPaths = [] } = {}
) {
  requireAbsolute(candidateRoot, 'candidate evidence root')
  const allowed = new Set(
    allowedExternalPaths.filter(Boolean).map((path) => canonicalPath(resolve(path)))
  )
  for (const artifact of deduplicateArtifacts(artifacts)) {
    if (allowed.has(canonicalPath(resolve(artifact.path)))) continue
    assertPathInsideCandidateRoot(candidateRoot, artifact.path, 'evidence artifact')
  }
}

function assertPathInsideCandidateRoot(candidateRoot, candidatePath, label) {
  requireAbsolute(candidateRoot, 'candidate evidence root')
  requireAbsolute(candidatePath, label)
  const child = relative(resolve(candidateRoot), resolve(candidatePath))
  if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) {
    throw new Error(`${label} escaped the candidate evidence root: ${candidatePath}`)
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${label} must be one exact absolute path.`)
  }
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}
