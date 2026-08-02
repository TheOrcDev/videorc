import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND = 'videorc.windows-d3d11-performance-budget'
export const WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES = Object.freeze([
  'nvidia-turing-floor',
  'intel-xe-integrated'
])
export const WINDOWS_D3D11_PERFORMANCE_PROFILES = Object.freeze(['1080p30', '1080p60'])
export const WINDOWS_D3D11_UNQUALIFIED_LIVESTREAM_PROFILES = Object.freeze([
  '1440p30',
  '1440p60',
  '4k30',
  '4k60'
])
export const WINDOWS_D3D11_PERFORMANCE_SCENARIOS = Object.freeze(windowsD3d11PerformanceScenarios())
const WINDOWS_D3D11_PREVIEW = Object.freeze({
  transport: 'd3d11-shared-texture',
  backing: 'directcomposition-swapchain',
  hostKind: 'backend-d3d11-presenter'
})
const WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS = 'unsupported-natural-fallback'

function windowsD3d11PerformanceScenarios() {
  const scenarios = []
  for (const fps of [30, 60]) {
    for (const sourceComposition of ['screen-only', 'screen-camera']) {
      for (const topology of ['stream-only', 'record-plus-stream']) {
        for (const previewOpen of [true, false]) {
          const topologyId = topology === 'stream-only' ? 'stream' : 'record-stream'
          const sourceId = sourceComposition === 'screen-only' ? '' : 'screen-camera-'
          scenarios.push(
            Object.freeze({
              id: `1080p${fps}-${sourceId}${topologyId}-${previewOpen ? 'preview' : 'no-preview'}`,
              profile: fps === 60 ? '1080p60' : '1080p30',
              sourceComposition,
              topology,
              previewOpen,
              warmupMs: 60_000,
              measurementMs: 180_000,
              intervalMs: 1_000,
              repetitions: 3
            })
          )
        }
      }
    }
  }
  for (const [id, profile] of [
    ['youtube-1080p30', '1080p30'],
    ['youtube-1080p60', '1080p60']
  ]) {
    scenarios.push(
      Object.freeze({
        id,
        profile,
        sourceComposition: 'screen-only',
        topology: 'stream-only',
        previewOpen: true,
        warmupMs: 60_000,
        measurementMs: 180_000,
        intervalMs: 1_000,
        repetitions: 3
      })
    )
  }
  scenarios.push(
    Object.freeze({
      id: '1080p60-av-endurance',
      profile: '1080p60',
      sourceComposition: 'screen-only',
      topology: 'stream-only',
      previewOpen: true,
      warmupMs: 60_000,
      measurementMs: 600_000,
      intervalMs: 1_000,
      repetitions: 1
    })
  )
  return scenarios
}

export class WindowsPerformanceBudgetError extends Error {
  constructor(failures) {
    super(`Windows performance budget was invalid or did not match:\n${failures.join('\n')}`)
    this.name = 'WindowsPerformanceBudgetError'
    this.failures = failures
  }
}

export async function loadWindowsPerformanceBudget({
  path,
  profileId,
  context,
  read = readFile,
  requireComparison = false,
  verifyArtifact = verifyWindowsPerformanceBudgetArtifact
}) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new WindowsPerformanceBudgetError([
      'VIDEORC_WINDOWS_PERF_BUDGET_PATH is required for a Windows performance gate'
    ])
  }
  let document
  try {
    document = JSON.parse(await read(path, 'utf8'))
  } catch (error) {
    throw new WindowsPerformanceBudgetError([
      `could not read Windows performance budget ${path}: ${error?.message ?? String(error)}`
    ])
  }
  const validationFailures = validateWindowsPerformanceBudget(document, { requireComparison })
  if (validationFailures.length > 0) throw new WindowsPerformanceBudgetError(validationFailures)
  const d3d11Budget = document.kind === WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND
  const strictScope = d3d11Budget || requireComparison || isRecord(document.comparison)
  const candidates =
    d3d11Budget && context?.hardwareClass === WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS
      ? document.naturalFallbackPolicy
        ? [document.naturalFallbackPolicy]
        : []
      : document.profiles

  const profiles = candidates.filter((profile) =>
    profileId
      ? profile.id === profileId
      : budgetScopeFailures(document, profile.scope, context, strictScope).length === 0
  )
  if (profiles.length === 0) {
    throw new WindowsPerformanceBudgetError([
      profileId
        ? `Windows performance budget did not contain profile ${profileId}`
        : `Windows performance budget did not contain a profile for ${formatContext(context)}`
    ])
  }
  if (profiles.length > 1) {
    throw new WindowsPerformanceBudgetError([
      `Windows performance budget matched multiple profiles for ${formatContext(context)}: ${profiles.map((profile) => profile.id).join(', ')}`
    ])
  }
  const profile = profiles[0]
  const scopeFailures = budgetScopeFailures(document, profile.scope, context, strictScope)
  scopeFailures.push(...budgetCandidateScopeFailures(document, profile, context))
  if (scopeFailures.length > 0) {
    throw new WindowsPerformanceBudgetError([
      `Windows performance budget profile ${profile.id} did not match: ${scopeFailures.join('; ')}`
    ])
  }
  if (strictScope) {
    const artifactFailures = await verifyWindowsPerformanceBudgetArtifacts({
      document,
      budgetPath: path,
      verifyArtifact
    })
    if (artifactFailures.length > 0) {
      throw new WindowsPerformanceBudgetError(artifactFailures)
    }
  }
  return { path, profile, document }
}

export function validateWindowsPerformanceBudget(document, options = {}) {
  if (document?.kind === WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND) {
    return validateWindowsD3d11PerformanceBudget(document, options)
  }
  const failures = []
  if (document?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (document?.kind !== 'videorc.windows-performance-budget-set') {
    failures.push('kind must be videorc.windows-performance-budget-set')
  }
  const allowedStatuses =
    options.allowDraft === true ? new Set(['active', 'draft']) : new Set(['active'])
  if (!allowedStatuses.has(document?.status)) {
    failures.push(
      options.allowDraft === true ? 'status must be active or draft' : 'status must be active'
    )
  }
  const comparisonBound = isRecord(document?.comparison)
  const comparisonRequired = options.requireComparison === true
  const budgetCandidatePayloadValid = lowercaseSha256(document?.candidatePayloadSha256)
  if (!budgetCandidatePayloadValid) {
    failures.push('candidatePayloadSha256 must be a lowercase SHA-256 digest')
  }
  if (comparisonRequired && !comparisonBound) {
    failures.push('comparison-bound budget evidence was missing')
  }
  if (comparisonBound || comparisonRequired) {
    if (!sha256(document?.candidateSha256)) failures.push('candidateSha256 was invalid')
    if (comparisonBound) validateComparisonBinding(document.comparison, failures)
    if (document.status === 'active') {
      if (!nonEmptyString(document.reviewedBy))
        failures.push('active comparison budget reviewedBy was missing')
      if (!nonEmptyString(document.reviewedAt))
        failures.push('active comparison budget reviewedAt was missing')
    }
  }
  if (!Array.isArray(document?.profiles) || document.profiles.length === 0) {
    failures.push('profiles must contain at least one reviewed profile')
    return failures
  }
  const ids = new Set()
  for (const [index, profile] of document.profiles.entries()) {
    const label = `profile ${index + 1}`
    if (!nonEmptyString(profile?.id)) failures.push(`${label} id was missing`)
    else if (ids.has(profile.id)) failures.push(`${label} id ${profile.id} was duplicated`)
    else ids.add(profile.id)
    validateScope(profile?.scope, label, failures, {
      requireRelease: comparisonBound || comparisonRequired
    })
    validateEvidence(
      profile?.evidence,
      profile?.scope,
      label,
      failures,
      comparisonBound || comparisonRequired,
      document?.comparison
    )
    validateThresholds(profile?.thresholds, label, failures, comparisonBound || comparisonRequired)
    const profileCandidatePayloadValid = lowercaseSha256(profile?.candidatePayloadSha256)
    if (!profileCandidatePayloadValid) {
      failures.push(`${label} candidatePayloadSha256 must be a lowercase SHA-256 digest`)
    } else if (
      budgetCandidatePayloadValid &&
      profile.candidatePayloadSha256 !== document.candidatePayloadSha256
    ) {
      failures.push(`${label} candidatePayloadSha256 did not match the budget candidate payload`)
    }
    if (
      (comparisonBound || comparisonRequired) &&
      normalizeSha256(profile?.candidateSha256) !== normalizeSha256(document.candidateSha256)
    ) {
      failures.push(`${label} candidateSha256 did not match the budget candidate`)
    }
  }
  return failures
}

export function validateWindowsD3d11PerformanceBudget(document, options = {}) {
  const failures = []
  if (document?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (document?.kind !== WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND) {
    failures.push(`kind must be ${WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND}`)
  }
  const allowedStatuses =
    options.allowDraft === true ? new Set(['active', 'draft']) : new Set(['active'])
  if (!allowedStatuses.has(document?.status)) {
    failures.push(
      options.allowDraft === true ? 'status must be active or draft' : 'status must be active'
    )
  }
  if (document?.generatedBy !== 'smoke-windows-obs-side-by-side --derive-d3d11-budget') {
    failures.push('generatedBy did not identify the protected D3D11 derivation command')
  }
  validateD3d11Candidate(document?.candidate, 'candidate', failures)
  validateD3d11QualifiedProfiles(document?.qualifiedProfiles, failures)
  if (
    !equalArrays(
      document?.unqualifiedLivestreamProfiles ?? [],
      WINDOWS_D3D11_UNQUALIFIED_LIVESTREAM_PROFILES
    )
  ) {
    failures.push(
      `unqualifiedLivestreamProfiles must be exactly ${WINDOWS_D3D11_UNQUALIFIED_LIVESTREAM_PROFILES.join(', ')}`
    )
  }
  validateD3d11ComparisonEvidence(document?.comparisonEvidence, failures)
  validateD3d11Profiles(document?.profiles, document?.candidate, failures)

  if (document?.status === 'active') {
    if (!nonEmptyString(document?.reviewedBy)) failures.push('active budget reviewedBy was missing')
    if (!canonicalTimestamp(document?.reviewedAt)) {
      failures.push('active budget reviewedAt was invalid')
    }
    validateNaturalFallbackPolicy(document?.naturalFallbackPolicy, document?.candidate, failures)
    if (document?.activation?.allowed !== true) {
      failures.push('active budget activation.allowed must be true')
    }
    if (!nonEmptyString(document?.activation?.reason)) {
      failures.push('active budget activation.reason was missing')
    }
  } else {
    if (document?.naturalFallbackPolicy !== null) {
      validateNaturalFallbackPolicy(document.naturalFallbackPolicy, document?.candidate, failures)
    }
    if (document?.activation?.allowed !== false) {
      failures.push('draft budget activation.allowed must be false')
    }
    if (!nonEmptyString(document?.activation?.reason)) {
      failures.push('draft budget activation.reason was missing')
    }
  }
  return failures
}

function validateD3d11Candidate(candidate, label, failures) {
  if (!isRecord(candidate)) {
    failures.push(`${label} was missing`)
    return
  }
  if (!/^[0-9a-f]{40}$/.test(candidate.sourceCommit ?? '')) {
    failures.push(`${label} sourceCommit must be a lowercase 40-character commit`)
  }
  for (const field of ['installerSha256', 'executableSha256', 'packagePayloadSha256']) {
    if (!lowercaseSha256(candidate[field])) {
      failures.push(`${label} ${field} must be a lowercase SHA-256 digest`)
    }
  }
}

function validateD3d11QualifiedProfiles(value, failures) {
  if (!isRecord(value)) {
    failures.push('qualifiedProfiles was missing')
    return
  }
  const keys = Object.keys(value).sort()
  const expectedKeys = [...WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES].sort()
  if (!equalArrays(keys, expectedKeys)) {
    failures.push(
      `qualifiedProfiles must contain exactly ${WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.join(', ')}`
    )
    return
  }
  for (const hardwareClass of WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES) {
    if (!equalArrays(value[hardwareClass] ?? [], WINDOWS_D3D11_PERFORMANCE_PROFILES)) {
      failures.push(
        `qualifiedProfiles.${hardwareClass} must be exactly ${WINDOWS_D3D11_PERFORMANCE_PROFILES.join(', ')}`
      )
    }
  }
}

function validateD3d11ComparisonEvidence(value, failures) {
  if (!Array.isArray(value) || value.length !== 2) {
    failures.push('comparisonEvidence must retain exactly two supported-host aggregates')
    return
  }
  const classes = new Set()
  const fingerprints = new Set()
  for (const [index, evidence] of value.entries()) {
    const label = `comparisonEvidence ${index + 1}`
    if (!isRecord(evidence)) {
      failures.push(`${label} was invalid`)
      continue
    }
    if (!WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.includes(evidence.hardwareClass)) {
      failures.push(`${label} hardwareClass was unsupported`)
    } else if (classes.has(evidence.hardwareClass)) {
      failures.push(`${label} hardwareClass was duplicated`)
    } else {
      classes.add(evidence.hardwareClass)
    }
    for (const field of ['aggregateSha256', 'manifestSha256', 'obsSha256', 'fingerprint']) {
      if (!lowercaseSha256(evidence[field])) {
        failures.push(`${label} ${field} must be a lowercase SHA-256 digest`)
      }
    }
    if (lowercaseSha256(evidence.fingerprint)) {
      if (fingerprints.has(evidence.fingerprint)) {
        failures.push(`${label} fingerprint reused another physical host`)
      }
      fingerprints.add(evidence.fingerprint)
    }
    if (!portableAbsolutePath(evidence.aggregatePath)) {
      failures.push(`${label} aggregatePath must be absolute`)
    }
    if (!nonEmptyString(evidence.obsVersion)) failures.push(`${label} obsVersion was missing`)
    if (!nonEmptyString(evidence.bootId)) failures.push(`${label} bootId was missing`)
  }
  if (
    WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.some((hardwareClass) => !classes.has(hardwareClass))
  ) {
    failures.push('comparisonEvidence did not cover both supported hardware classes')
  }
}

function validateD3d11Profiles(profiles, candidate, failures) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    failures.push('profiles must contain D3D11 calibration contexts')
    return
  }
  const ids = new Set()
  const contexts = new Set()
  const qualified = new Map(
    WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.map((hardwareClass) => [hardwareClass, new Set()])
  )
  const scenariosByClass = new Map(
    WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.map((hardwareClass) => [hardwareClass, new Set()])
  )
  for (const [index, profile] of profiles.entries()) {
    const label = `profile ${index + 1}`
    if (!nonEmptyString(profile?.id)) failures.push(`${label} id was missing`)
    else if (ids.has(profile.id)) failures.push(`${label} id ${profile.id} was duplicated`)
    else ids.add(profile.id)
    const contextKey = stableJson(profile?.scope)
    if (contexts.has(contextKey)) failures.push(`${label} duplicated another scope`)
    contexts.add(contextKey)
    validateD3d11Scope(profile?.scope, label, failures)
    if (qualified.has(profile?.scope?.hardwareClass)) {
      qualified.get(profile.scope.hardwareClass).add(profile.scope.profile)
      scenariosByClass.get(profile.scope.hardwareClass).add(profile.scope.scenario)
    }
    validateD3d11Candidate(profile?.candidate, `${label} candidate`, failures)
    if (stableJson(profile?.candidate) !== stableJson(candidate)) {
      failures.push(`${label} candidate did not match the budget candidate`)
    }
    validateD3d11ProfileEvidence(profile?.evidence, profile?.scope, label, failures)
    validateD3d11Invariants(profile?.invariants, label, failures)
    validateThresholds(profile?.thresholds, label, failures, true)
  }
  for (const [hardwareClass, profilesForClass] of qualified) {
    if (
      [...profilesForClass].sort().join(',') !==
      [...WINDOWS_D3D11_PERFORMANCE_PROFILES].sort().join(',')
    ) {
      failures.push(
        `${hardwareClass} profiles must qualify exactly ${WINDOWS_D3D11_PERFORMANCE_PROFILES.join(', ')}`
      )
    }
    const scenarios = scenariosByClass.get(hardwareClass)
    if (
      scenarios.size !== WINDOWS_D3D11_PERFORMANCE_SCENARIOS.length ||
      WINDOWS_D3D11_PERFORMANCE_SCENARIOS.some(({ id }) => !scenarios.has(id))
    ) {
      failures.push(
        `${hardwareClass} profiles must cover the exact protected ${WINDOWS_D3D11_PERFORMANCE_SCENARIOS.length}-scenario matrix`
      )
    }
  }
}

function validateD3d11Scope(scope, label, failures) {
  validateScope(scope, label, failures, { requireRelease: true })
  const scenario = WINDOWS_D3D11_PERFORMANCE_SCENARIOS.find(({ id }) => id === scope?.scenario)
  if (!scenario) {
    failures.push(`${label} scope scenario was outside the protected matrix`)
  } else {
    const expected = {
      profile: scenario.profile,
      topology: scenario.topology,
      sourceComposition: scenario.sourceComposition,
      previewOpen: scenario.previewOpen,
      warmupMs: scenario.warmupMs,
      measurementMs: scenario.measurementMs,
      intervalMs: scenario.intervalMs
    }
    const actual = {
      profile: scope?.profile,
      topology: scope?.topology,
      sourceComposition: scope?.sourceComposition,
      previewOpen: scope?.previewOpen,
      warmupMs: scope?.timing?.warmupMs,
      measurementMs: scope?.timing?.measurementMs,
      intervalMs: scope?.timing?.intervalMs
    }
    if (stableJson(actual) !== stableJson(expected)) {
      failures.push(`${label} scope did not match its protected scenario`)
    }
  }
  if (!WINDOWS_D3D11_PERFORMANCE_HARDWARE_CLASSES.includes(scope?.hardwareClass)) {
    failures.push(`${label} scope hardwareClass was unsupported`)
  }
  if (!WINDOWS_D3D11_PERFORMANCE_PROFILES.includes(scope?.profile)) {
    failures.push(`${label} scope profile was not qualified`)
  }
  if (scope?.mediaPath !== 'd3d11-native') {
    failures.push(`${label} scope mediaPath must be d3d11-native`)
  }
  if (!['stream-only', 'record-plus-stream'].includes(scope?.topology)) {
    failures.push(`${label} scope topology was unsupported`)
  }
  if (!['screen-only', 'screen-camera'].includes(scope?.sourceComposition)) {
    failures.push(`${label} scope sourceComposition was unsupported`)
  }
  if (typeof scope?.previewOpen !== 'boolean') {
    failures.push(`${label} scope previewOpen was missing`)
  } else if (scope.previewOpen) {
    if (stableJson(scope.preview) !== stableJson(WINDOWS_D3D11_PREVIEW)) {
      failures.push(`${label} scope preview did not use the canonical D3D11 triple`)
    }
  } else if (scope.preview !== undefined) {
    failures.push(`${label} closed-preview scope must not claim a presenter triple`)
  }
}

function validateD3d11ProfileEvidence(evidence, scope, label, failures) {
  if (!isRecord(evidence)) {
    failures.push(`${label} evidence was missing`)
    return
  }
  for (const field of ['calibrationPath', 'comparisonPath']) {
    if (!portableAbsolutePath(evidence[field])) {
      failures.push(`${label} evidence ${field} must be absolute`)
    }
  }
  for (const field of ['calibrationSha256', 'comparisonSha256']) {
    if (!lowercaseSha256(evidence[field])) {
      failures.push(`${label} evidence ${field} must be a lowercase SHA-256 digest`)
    }
  }
  const expectedRunCount =
    scope?.scenario === '1080p60-av-endurance' && scope?.timing?.measurementMs === 600_000 ? 1 : 3
  if (
    !Array.isArray(evidence.reportPaths) ||
    evidence.reportPaths.length !== expectedRunCount ||
    evidence.reportPaths.some((path) => !portableAbsolutePath(path)) ||
    new Set(evidence.reportPaths.map(canonicalEvidencePath)).size !== expectedRunCount
  ) {
    failures.push(
      `${label} evidence must retain ${expectedRunCount} distinct absolute report path${expectedRunCount === 1 ? '' : 's'}`
    )
  }
  if (
    !Array.isArray(evidence.reportSha256) ||
    evidence.reportSha256.length !== expectedRunCount ||
    evidence.reportSha256.some((digest) => !lowercaseSha256(digest)) ||
    new Set(evidence.reportSha256).size !== expectedRunCount
  ) {
    failures.push(
      `${label} evidence must retain ${expectedRunCount} distinct lowercase report digest${expectedRunCount === 1 ? '' : 's'}`
    )
  }
}

function validateD3d11Invariants(invariants, label, failures) {
  if (!isRecord(invariants)) {
    failures.push(`${label} invariants were missing`)
    return
  }
  const exact = {
    mediaPath: 'd3d11-native',
    captureReadbackFrames: 0,
    compositorCpuFallbackFrames: 0,
    rawVideoCopiedFrames: 0,
    encoderSystemMemorySamples: 0,
    previewBmpRequests: 0,
    previewBmpBytes: 0,
    cursorCorrect: true,
    inputContinuity: true,
    maximumMessageDispatchP95Ms: 50,
    maximumMessageDispatchMs: 100
  }
  for (const [field, expected] of Object.entries(exact)) {
    if (invariants[field] !== expected) {
      failures.push(`${label} invariant ${field} must be ${String(expected)}`)
    }
  }
}

function validateNaturalFallbackPolicy(policy, candidate, failures) {
  const label = 'naturalFallbackPolicy'
  if (!isRecord(policy)) {
    failures.push(`${label} was missing`)
    return
  }
  if (policy.id !== 'unsupported-natural-fallback-1080p30') {
    failures.push(`${label} id was invalid`)
  }
  const scope = policy.scope
  validateScope(scope, label, failures, { requireRelease: true })
  if (scope?.hardwareClass !== WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS) {
    failures.push(`${label} hardwareClass must be ${WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS}`)
  }
  if (scope?.profile !== '1080p30') failures.push(`${label} profile must be 1080p30`)
  if (scope?.mediaPath !== 'legacy-fallback') {
    failures.push(`${label} mediaPath must be legacy-fallback`)
  }
  if (scope?.selectionMode !== 'natural') {
    failures.push(`${label} selectionMode must be natural`)
  }
  if (!equalArrays(scope?.topologies ?? [], ['stream-only', 'record-plus-stream'])) {
    failures.push(`${label} topologies must be exactly stream-only, record-plus-stream`)
  }
  if (!equalArrays(scope?.previewModes ?? [], ['open', 'closed'])) {
    failures.push(`${label} previewModes must be exactly open, closed`)
  }
  validateD3d11Candidate(policy.candidate, `${label} candidate`, failures)
  if (stableJson(policy.candidate) !== stableJson(candidate)) {
    failures.push(`${label} candidate did not match the budget candidate`)
  }
  validateFallbackEvidence(policy.evidence, failures)
  if (!nonEmptyString(policy?.observed?.fallbackReason)) {
    failures.push(`${label} observed fallbackReason was missing`)
  }
  if (policy?.observed?.effectiveCaptureBackend !== 'legacy-ffmpeg') {
    failures.push(`${label} effectiveCaptureBackend must be legacy-ffmpeg`)
  }
  if (!nonEmptyString(policy?.observed?.effectiveEncoderBackend)) {
    failures.push(`${label} effectiveEncoderBackend was missing`)
  }
  const invariants = policy?.invariants
  const exact = {
    obsParityQualified: false,
    maximumFps: 30,
    maximumTotalRssSlopeMiBPerMinute: 5,
    maximumRoleRssSlopeMiBPerMinute: 2,
    minimumEncoderSpeedP05: 0.98,
    mediaVerdict: 'PASS',
    lifecycleVerdict: 'PASS',
    previewProofSurfaceVerdict: 'PASS'
  }
  for (const [field, expected] of Object.entries(exact)) {
    if (invariants?.[field] !== expected) {
      failures.push(`${label} invariant ${field} must be ${String(expected)}`)
    }
  }
  validateThresholds(policy?.thresholds, label, failures, true)
  if (policy?.thresholds?.bmp?.mode !== 'required') {
    failures.push(`${label} BMP mode must be required`)
  }
}

function validateFallbackEvidence(evidence, failures) {
  const label = 'naturalFallbackPolicy evidence'
  if (!isRecord(evidence)) {
    failures.push(`${label} was missing`)
    return
  }
  if (!portableAbsolutePath(evidence.calibrationPath)) {
    failures.push(`${label} calibrationPath must be absolute`)
  }
  if (!lowercaseSha256(evidence.calibrationSha256)) {
    failures.push(`${label} calibrationSha256 must be a lowercase SHA-256 digest`)
  }
  if (
    !Array.isArray(evidence.reportPaths) ||
    evidence.reportPaths.length !== 12 ||
    evidence.reportPaths.some((path) => !portableAbsolutePath(path)) ||
    new Set(evidence.reportPaths.map(canonicalEvidencePath)).size !== 12
  ) {
    failures.push(`${label} must retain twelve distinct absolute report paths`)
  }
  if (
    !Array.isArray(evidence.reportSha256) ||
    evidence.reportSha256.length !== 12 ||
    evidence.reportSha256.some((digest) => !lowercaseSha256(digest)) ||
    new Set(evidence.reportSha256).size !== 12
  ) {
    failures.push(`${label} must retain twelve distinct lowercase report digests`)
  }
}

export function attachWindowsNaturalFallbackPolicy({ document, calibration }) {
  const budgetFailures = validateWindowsD3d11PerformanceBudget(document, {
    allowDraft: true
  })
  if (budgetFailures.length > 0) {
    throw new WindowsPerformanceBudgetError(budgetFailures)
  }
  if (document.status !== 'draft' || document.activation?.allowed !== false) {
    throw new WindowsPerformanceBudgetError([
      'natural fallback policy may only be attached to a non-activated draft budget'
    ])
  }
  if (document.naturalFallbackPolicy !== null) {
    throw new WindowsPerformanceBudgetError([
      'natural fallback policy was already attached; immutable evidence cannot be overwritten'
    ])
  }
  const failures = validateNaturalFallbackCalibration(calibration, document.candidate)
  if (failures.length > 0) throw new WindowsPerformanceBudgetError(failures)

  const runs = calibration.runs
  const roles = [...new Set(runs.flatMap((run) => Object.keys(run.process.roles)))].sort()
  const fallbackReasons = new Set(runs.map((run) => run.observed.fallbackReason))
  const captureBackends = new Set(runs.map((run) => run.observed.effectiveCaptureBackend))
  const encoderBackends = new Set(runs.map((run) => run.observed.effectiveEncoderBackend))
  const policy = {
    id: 'unsupported-natural-fallback-1080p30',
    scope: {
      scenario: '1080p30-natural-fallback-matrix',
      profile: '1080p30',
      hardwareClass: WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS,
      profileClass: calibration.scope.profileClass,
      buildMode: 'packaged',
      operatingSystem: calibration.scope.operatingSystem,
      timing: calibration.scope.timing,
      mediaPath: 'legacy-fallback',
      selectionMode: 'natural',
      topologies: ['stream-only', 'record-plus-stream'],
      previewModes: ['open', 'closed']
    },
    candidate: document.candidate,
    evidence: {
      calibrationPath: calibration.aggregatePath,
      calibrationSha256: calibration.aggregateSha256,
      reportPaths: runs.map((run) => run.reportPath),
      reportSha256: runs.map((run) => run.reportSha256)
    },
    observed: {
      fallbackReason: [...fallbackReasons][0],
      effectiveCaptureBackend: [...captureBackends][0],
      effectiveEncoderBackend: [...encoderBackends][0]
    },
    invariants: {
      obsParityQualified: false,
      maximumFps: 30,
      maximumTotalRssSlopeMiBPerMinute: 5,
      maximumRoleRssSlopeMiBPerMinute: 2,
      minimumEncoderSpeedP05: 0.98,
      mediaVerdict: 'PASS',
      lifecycleVerdict: 'PASS',
      previewProofSurfaceVerdict: 'PASS'
    },
    thresholds: {
      maximumTotalCpuP95Percent: ceilTo(
        Math.max(...runs.map((run) => finite(run.process.cpuP95Percent))) * 1.1 + 1,
        0.1
      ),
      maximumTotalRssMiB: ceilTo(
        Math.max(...runs.map((run) => finite(run.process.rssMaxMiB))) * 1.1 + 1,
        0.1
      ),
      maximumTotalRssSlopeMiBPerMinute: 5,
      gpu: {
        maximumEngineP95Percent: Math.min(
          95,
          ceilTo(
            Math.max(...runs.map((run) => finite(run.gpu.engineBusyP95Percent))) * 1.1 + 1,
            0.1
          )
        ),
        maximumDedicatedMiB: ceilTo(
          Math.max(...runs.map((run) => finite(run.gpu.dedicatedMaxMiB))) * 1.1 + 16,
          0.1
        ),
        maximumSharedMiB: ceilTo(
          Math.max(...runs.map((run) => finite(run.gpu.sharedMaxMiB))) * 1.1 + 16,
          0.1
        )
      },
      bmp: {
        mode: 'required',
        maximumIntervalP95Ms: Math.min(
          250,
          ceilTo(Math.max(...runs.map((run) => finite(run.bmp.intervalP95Ms))) * 1.1 + 5, 0.1)
        ),
        minimumAdvancedFrames: Math.max(
          1,
          Math.floor(Math.min(...runs.map((run) => finite(run.bmp.advancedFrames))) * 0.9)
        )
      },
      media: {
        minimumEncoderSpeedP05: 0.98,
        maximumFrameGapMs: 100,
        maximumFreezeMs: 100,
        maximumRepeatedFrameRun: 2,
        maximumQueueLossRatio: 0.001,
        minimumRollingBitrateRatio: 0.9,
        maximumRollingBitrateRatio: 1.1
      },
      roles: Object.fromEntries(
        roles.map((role) => [
          role,
          {
            maximumRssMiB: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role].rssMaxMiB))) * 1.1 + 1,
              0.1
            ),
            maximumRssSlopeMiBPerMinute: 2,
            maximumAverageCpuPercent: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role].cpuAveragePercent))) *
                1.1 +
                1,
              0.1
            ),
            maximumP95CpuPercent: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role].cpuP95Percent))) * 1.1 +
                1,
              0.1
            )
          }
        ])
      )
    }
  }
  const updated = {
    ...document,
    naturalFallbackPolicy: policy,
    activation: {
      allowed: false,
      reason:
        'Natural fallback evidence is attached; independent human review must activate this budget.'
    }
  }
  const updatedFailures = validateWindowsD3d11PerformanceBudget(updated, {
    allowDraft: true
  })
  if (updatedFailures.length > 0) throw new WindowsPerformanceBudgetError(updatedFailures)
  return updated
}

function validateNaturalFallbackCalibration(calibration, candidate) {
  const failures = []
  if (calibration?.schemaVersion !== 1)
    failures.push('fallback calibration schemaVersion must be 1')
  if (calibration?.kind !== 'videorc.windows-natural-fallback-calibration') {
    failures.push('fallback calibration kind was invalid')
  }
  if (calibration?.status !== 'CALIBRATION') {
    failures.push('fallback calibration status must be CALIBRATION')
  }
  validateD3d11Candidate(calibration?.candidate, 'fallback calibration candidate', failures)
  if (stableJson(calibration?.candidate) !== stableJson(candidate)) {
    failures.push('fallback calibration candidate did not match the D3D11 budget')
  }
  if (!portableAbsolutePath(calibration?.aggregatePath)) {
    failures.push('fallback calibration aggregatePath must be absolute')
  }
  if (!lowercaseSha256(calibration?.aggregateSha256)) {
    failures.push('fallback calibration aggregateSha256 must be a lowercase SHA-256 digest')
  }
  const scope = calibration?.scope
  if (scope?.hardwareClass !== WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS) {
    failures.push(
      `fallback calibration hardwareClass must be ${WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS}`
    )
  }
  if (scope?.profile !== '1080p30' || scope?.fps !== 30) {
    failures.push('fallback calibration must be exactly 1080p30')
  }
  if (
    scope?.mediaPath !== 'legacy-fallback' ||
    scope?.selectionMode !== 'natural' ||
    scope?.d3d11Requested !== false ||
    scope?.d3d11Required !== false
  ) {
    failures.push('fallback calibration must prove an unforced natural legacy fallback')
  }
  validateScope(
    {
      ...scope,
      scenario: scope?.scenario ?? '1080p30-natural-fallback-matrix',
      buildMode: scope?.buildMode
    },
    'fallback calibration',
    failures,
    { requireRelease: true }
  )
  const runs = calibration?.runs
  if (!Array.isArray(runs) || runs.length !== 12) {
    failures.push('fallback calibration must retain exactly twelve matrix runs')
    return failures
  }
  const contexts = new Map()
  const paths = new Set()
  const hashes = new Set()
  const reasons = new Set()
  const captureBackends = new Set()
  const encoderBackends = new Set()
  for (const [index, run] of runs.entries()) {
    const label = `fallback calibration run ${index + 1}`
    if (run?.verdict !== 'PASS') failures.push(`${label} did not pass`)
    if (!['stream-only', 'record-plus-stream'].includes(run?.topology)) {
      failures.push(`${label} topology was invalid`)
    }
    if (typeof run?.previewOpen !== 'boolean') failures.push(`${label} previewOpen was invalid`)
    if (!Number.isInteger(run?.repetition) || run.repetition < 1 || run.repetition > 3) {
      failures.push(`${label} repetition was invalid`)
    }
    const context = `${run?.topology}:${run?.previewOpen ? 'open' : 'closed'}`
    if (!contexts.has(context)) contexts.set(context, new Set())
    contexts.get(context).add(run?.repetition)
    if (
      !portableAbsolutePath(run?.reportPath) ||
      paths.has(canonicalEvidencePath(run.reportPath))
    ) {
      failures.push(`${label} reportPath was missing, relative, or duplicated`)
    } else {
      paths.add(canonicalEvidencePath(run.reportPath))
    }
    if (!lowercaseSha256(run?.reportSha256) || hashes.has(run.reportSha256)) {
      failures.push(`${label} reportSha256 was invalid or duplicated`)
    } else {
      hashes.add(run.reportSha256)
    }
    if (!nonEmptyString(run?.observed?.fallbackReason)) {
      failures.push(`${label} fallbackReason was missing`)
    } else {
      reasons.add(run.observed.fallbackReason)
    }
    captureBackends.add(run?.observed?.effectiveCaptureBackend)
    encoderBackends.add(run?.observed?.effectiveEncoderBackend)
    if (run?.observed?.effectiveCaptureBackend !== 'legacy-ffmpeg') {
      failures.push(`${label} capture backend was not legacy-ffmpeg`)
    }
    if (!nonEmptyString(run?.observed?.effectiveEncoderBackend)) {
      failures.push(`${label} encoder backend was missing`)
    }
    for (const field of ['mediaVerdict', 'lifecycleVerdict', 'previewProofSurfaceVerdict']) {
      if (run?.[field] !== 'PASS') failures.push(`${label} ${field} did not pass`)
    }
    if (!Number.isFinite(run?.encoderSpeedP05) || run.encoderSpeedP05 < 0.98) {
      failures.push(`${label} encoder speed was below 0.98x`)
    }
    if (
      !Number.isFinite(run?.process?.rssSlopeMiBPerMinute) ||
      run.process.rssSlopeMiBPerMinute > 5
    ) {
      failures.push(`${label} total RSS slope exceeded 5 MiB/minute`)
    }
    for (const [role, metrics] of Object.entries(run?.process?.roles ?? {})) {
      if (!Number.isFinite(metrics.rssSlopeMiBPerMinute) || metrics.rssSlopeMiBPerMinute > 2) {
        failures.push(`${label} ${role} RSS slope exceeded 2 MiB/minute`)
      }
    }
    if (Object.keys(run?.process?.roles ?? {}).length === 0) {
      failures.push(`${label} process roles were missing`)
    }
    for (const value of [
      run?.process?.cpuP95Percent,
      run?.process?.rssMaxMiB,
      run?.gpu?.engineBusyP95Percent,
      run?.gpu?.dedicatedMaxMiB,
      run?.gpu?.sharedMaxMiB,
      run?.bmp?.intervalP95Ms,
      run?.bmp?.advancedFrames
    ]) {
      if (!Number.isFinite(value) || value <= 0)
        failures.push(`${label} calibration metrics were incomplete`)
    }
  }
  for (const topology of ['stream-only', 'record-plus-stream']) {
    for (const preview of ['open', 'closed']) {
      const repetitions = contexts.get(`${topology}:${preview}`)
      if (!repetitions || [...repetitions].sort().join(',') !== '1,2,3') {
        failures.push(`fallback calibration did not cover ${topology}/${preview} three times`)
      }
    }
  }
  if (reasons.size !== 1) failures.push('fallback calibration reason changed across the matrix')
  if (captureBackends.size !== 1)
    failures.push('fallback capture backend changed across the matrix')
  if (encoderBackends.size !== 1)
    failures.push('fallback encoder backend changed across the matrix')
  return failures
}

export function evaluateWindowsPerformanceBudget(profile, metrics) {
  const failures = []
  const thresholds = profile?.thresholds
  const memory = metrics?.processTree?.memory?.summary
  const cpu = metrics?.processTree?.cpu?.summary?.byRole
  const bmp = metrics?.bmp
  const totalCpu =
    metrics?.processTree?.cpu?.summary?.totalP95Percent ??
    metrics?.processTree?.cpu?.summary?.total?.p95Percent
  const gpu = metrics?.gpu?.summary ?? metrics?.gpu

  if (Number.isFinite(thresholds?.maximumTotalCpuP95Percent)) {
    requireAtMost(
      failures,
      'total process-tree p95 CPU',
      totalCpu,
      thresholds.maximumTotalCpuP95Percent
    )
  }
  requireAtMost(
    failures,
    'total process-tree RSS',
    memory?.maxTotalRssKb,
    thresholds?.maximumTotalRssMiB * 1024
  )
  requireAtMost(
    failures,
    'total process-tree RSS slope',
    memory?.totalRss?.slopePerMinute,
    thresholds?.maximumTotalRssSlopeMiBPerMinute * 1024
  )
  if (thresholds?.bmp?.mode === 'disabled') {
    requireAtMost(failures, 'BMP request count', bmp?.requestCount, thresholds.bmp.maximumRequests)
    requireAtMost(failures, 'BMP bytes', bmp?.bytes, thresholds.bmp.maximumBytes)
  } else {
    requireAtMost(
      failures,
      'BMP polling interval p95',
      bmp?.intervalP95Ms,
      thresholds?.bmp?.maximumIntervalP95Ms
    )
    requireAtLeast(
      failures,
      'BMP advanced frames',
      bmp?.advancedFrames,
      thresholds?.bmp?.minimumAdvancedFrames
    )
  }
  if (isRecord(thresholds?.gpu)) {
    requireAtMost(
      failures,
      'GPU engine p95',
      gpu?.engineBusyP95Percent,
      thresholds.gpu.maximumEngineP95Percent
    )
    requireAtMost(
      failures,
      'GPU dedicated memory',
      gpu?.dedicatedMaxMiB,
      thresholds.gpu.maximumDedicatedMiB
    )
    requireAtMost(failures, 'GPU shared memory', gpu?.sharedMaxMiB, thresholds.gpu.maximumSharedMiB)
  }
  for (const [role, roleThresholds] of Object.entries(thresholds?.roles ?? {}).sort()) {
    const memoryMetrics = memory?.roles?.[role]
    const cpuMetrics = cpu?.[role]
    requireAtMost(
      failures,
      `${role} RSS`,
      memoryMetrics?.maxRssKb,
      roleThresholds.maximumRssMiB * 1024
    )
    requireAtMost(
      failures,
      `${role} RSS slope`,
      memoryMetrics?.slopeRssKbPerMinute,
      roleThresholds.maximumRssSlopeMiBPerMinute * 1024
    )
    requireAtMost(
      failures,
      `${role} average CPU`,
      cpuMetrics?.averagePercent,
      roleThresholds.maximumAverageCpuPercent
    )
    requireAtMost(
      failures,
      `${role} p95 CPU`,
      cpuMetrics?.p95Percent,
      roleThresholds.maximumP95CpuPercent
    )
  }
  if (profile?.invariants?.mediaPath === 'd3d11-native') {
    const d3d11 = metrics?.d3d11 ?? metrics?.pipeline ?? {}
    for (const field of [
      'captureReadbackFrames',
      'compositorCpuFallbackFrames',
      'rawVideoCopiedFrames',
      'encoderSystemMemorySamples'
    ]) {
      requireAtMost(failures, field, d3d11[field], profile.invariants[field])
    }
    requireAtMost(
      failures,
      'preview BMP requests',
      bmp?.requestCount,
      profile.invariants.previewBmpRequests
    )
    requireAtMost(failures, 'preview BMP bytes', bmp?.bytes, profile.invariants.previewBmpBytes)
    requireEqualMetric(failures, 'cursor correctness', d3d11.cursorCorrect, true)
    requireEqualMetric(failures, 'preview input continuity', d3d11.inputContinuity, true)
    requireAtMost(
      failures,
      'message dispatch p95',
      d3d11.messageDispatchP95Ms,
      profile.invariants.maximumMessageDispatchP95Ms
    )
    requireAtMost(
      failures,
      'message dispatch maximum',
      d3d11.messageDispatchMaxMs,
      profile.invariants.maximumMessageDispatchMs
    )
  }
  if (profile?.invariants?.obsParityQualified === false) {
    requireAtLeast(
      failures,
      'encoder speed p05',
      metrics?.encoderSpeedP05,
      profile.invariants.minimumEncoderSpeedP05
    )
    requireEqualMetric(failures, 'fallback media verdict', metrics?.mediaVerdict, 'PASS')
    requireEqualMetric(failures, 'fallback lifecycle verdict', metrics?.lifecycleVerdict, 'PASS')
    requireEqualMetric(
      failures,
      'fallback proof-surface verdict',
      metrics?.previewProofSurfaceVerdict,
      'PASS'
    )
  }
  if (metrics?.teardownClean !== true) failures.push('app-owned process teardown was not clean')
  return failures
}

function validateScope(scope, label, failures, options = {}) {
  if (!isRecord(scope)) {
    failures.push(`${label} scope was missing`)
    return
  }
  for (const field of ['scenario', 'hardwareClass', 'profileClass', 'buildMode']) {
    if (!nonEmptyString(scope[field])) failures.push(`${label} scope ${field} was missing`)
  }
  if (scope.buildMode !== 'packaged') failures.push(`${label} scope buildMode must be packaged`)
  if (scope.operatingSystem?.platform !== 'win32' || !nonEmptyString(scope.operatingSystem?.arch)) {
    failures.push(`${label} scope must target a Windows platform and architecture`)
  }
  if (options.requireRelease === true && !nonEmptyString(scope.operatingSystem?.release)) {
    failures.push(`${label} scope operatingSystem.release was missing`)
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (!positiveInteger(scope.timing?.[field]))
      failures.push(`${label} scope timing ${field} was invalid`)
  }
}

function validateEvidence(evidence, scope, label, failures, comparisonBound, comparison) {
  if (!isRecord(evidence)) {
    failures.push(`${label} evidence was missing`)
    return
  }
  const expectedRunCount = windowsBudgetEvidenceRunCount(scope)
  if (evidence.runCount !== expectedRunCount) {
    failures.push(`${label} evidence runCount must be ${expectedRunCount}`)
  }
  const reportPaths = evidence.reportPaths
  if (
    !Array.isArray(reportPaths) ||
    reportPaths.length !== expectedRunCount ||
    !reportPaths.every(nonEmptyString) ||
    new Set(reportPaths.map(canonicalEvidencePath)).size !== expectedRunCount
  ) {
    failures.push(
      `${label} evidence must retain ${expectedRunCount === 3 ? 'three' : expectedRunCount} report path${expectedRunCount === 1 ? '' : 's'}`
    )
  }
  if (!nonEmptyString(evidence.calibrationSha256) || !sha256(evidence.calibrationSha256)) {
    failures.push(`${label} evidence calibrationSha256 was invalid`)
  }
  if (comparisonBound) {
    if (!nonEmptyString(evidence.calibrationPath)) {
      failures.push(`${label} evidence calibrationPath was missing`)
    }
    for (const field of ['reportSha256']) {
      if (
        !Array.isArray(evidence[field]) ||
        evidence[field].length !== expectedRunCount ||
        !evidence[field].every(sha256) ||
        new Set(evidence[field].map(normalizeSha256)).size !== expectedRunCount
      ) {
        failures.push(
          `${label} evidence ${field} must retain ${expectedRunCount} SHA-256 digest${expectedRunCount === 1 ? '' : 's'}`
        )
      }
    }
    if (
      !Array.isArray(evidence.comparisonPaths) ||
      evidence.comparisonPaths.length !== 6 ||
      !evidence.comparisonPaths.every(nonEmptyString) ||
      new Set(evidence.comparisonPaths.map(canonicalEvidencePath)).size !== 6
    ) {
      failures.push(`${label} evidence must retain six comparison paths`)
    }
    if (
      !Array.isArray(evidence.comparisonSha256) ||
      evidence.comparisonSha256.length !== 6 ||
      !evidence.comparisonSha256.every(sha256) ||
      new Set(evidence.comparisonSha256.map((digest) => digest.toLocaleLowerCase('en-US'))).size !==
        6
    ) {
      failures.push(`${label} evidence must retain six comparison SHA-256 digests`)
    }
    if (
      Array.isArray(evidence.comparisonPaths) &&
      Array.isArray(comparison?.reportPaths) &&
      !equalArrays(evidence.comparisonPaths, comparison.reportPaths)
    ) {
      failures.push(`${label} evidence comparisonPaths did not match the budget comparison`)
    }
    if (
      Array.isArray(evidence.comparisonSha256) &&
      Array.isArray(comparison?.reportSha256) &&
      !equalSha256Arrays(evidence.comparisonSha256, comparison.reportSha256)
    ) {
      failures.push(`${label} evidence comparisonSha256 did not match the budget comparison`)
    }
  }
}

async function verifyWindowsPerformanceBudgetArtifacts({ document, budgetPath, verifyArtifact }) {
  if (document.kind === WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND) {
    return verifyWindowsD3d11PerformanceBudgetArtifacts({
      document,
      budgetPath,
      verifyArtifact
    })
  }
  const references = [
    {
      label: 'comparison aggregate',
      path: document.comparison.aggregatePath,
      expectedSha256: document.comparison.aggregateSha256
    },
    ...document.comparison.reportPaths.map((path, index) => ({
      label: `comparison report ${index + 1}`,
      path,
      expectedSha256: document.comparison.reportSha256[index]
    })),
    ...document.profiles.flatMap((profile) => [
      {
        label: `profile ${profile.id} calibration aggregate`,
        path: profile.evidence.calibrationPath,
        expectedSha256: profile.evidence.calibrationSha256
      },
      ...profile.evidence.reportPaths.map((path, index) => ({
        label: `profile ${profile.id} calibration report ${index + 1}`,
        path,
        expectedSha256: profile.evidence.reportSha256[index]
      }))
    ])
  ]
  return (
    await Promise.all(
      references.map(async (reference) => {
        const artifactPath = resolve(dirname(budgetPath), reference.path.trim())
        const expectedSha256 = normalizeSha256(reference.expectedSha256)
        try {
          const actualSha256 = await verifyArtifact({
            path: artifactPath,
            expectedSha256,
            label: reference.label,
            budgetPath
          })
          if (!sha256(actualSha256)) {
            return `${reference.label} verifier did not return a SHA-256 digest for ${artifactPath}`
          }
          if (normalizeSha256(actualSha256) !== expectedSha256) {
            return `${reference.label} SHA-256 did not match ${artifactPath}`
          }
          return null
        } catch (error) {
          return `could not verify ${reference.label} ${artifactPath}: ${error?.message ?? String(error)}`
        }
      })
    )
  ).filter(Boolean)
}

async function verifyWindowsD3d11PerformanceBudgetArtifacts({
  document,
  budgetPath,
  verifyArtifact
}) {
  const references = [
    ...document.comparisonEvidence.flatMap((comparison) => [
      {
        label: `${comparison.hardwareClass} comparison aggregate`,
        path: comparison.aggregatePath,
        expectedSha256: comparison.aggregateSha256
      }
    ]),
    ...document.profiles.flatMap((profile) => [
      {
        label: `profile ${profile.id} calibration aggregate`,
        path: profile.evidence.calibrationPath,
        expectedSha256: profile.evidence.calibrationSha256
      },
      {
        label: `profile ${profile.id} comparison aggregate`,
        path: profile.evidence.comparisonPath,
        expectedSha256: profile.evidence.comparisonSha256
      },
      ...profile.evidence.reportPaths.map((path, index) => ({
        label: `profile ${profile.id} calibration report ${index + 1}`,
        path,
        expectedSha256: profile.evidence.reportSha256[index]
      }))
    ]),
    ...(document.naturalFallbackPolicy
      ? [
          {
            label: 'natural fallback calibration aggregate',
            path: document.naturalFallbackPolicy.evidence.calibrationPath,
            expectedSha256: document.naturalFallbackPolicy.evidence.calibrationSha256
          },
          ...document.naturalFallbackPolicy.evidence.reportPaths.map((path, index) => ({
            label: `natural fallback calibration report ${index + 1}`,
            path,
            expectedSha256: document.naturalFallbackPolicy.evidence.reportSha256[index]
          }))
        ]
      : [])
  ]
  return (
    await Promise.all(
      references.map(async (reference) => {
        const artifactPath = portableAbsolutePath(reference.path)
          ? reference.path
          : resolve(dirname(budgetPath), reference.path.trim())
        const expectedSha256 = normalizeSha256(reference.expectedSha256)
        try {
          const actualSha256 = await verifyArtifact({
            path: artifactPath,
            expectedSha256,
            label: reference.label,
            budgetPath
          })
          if (!sha256(actualSha256)) {
            return `${reference.label} verifier did not return a SHA-256 digest for ${artifactPath}`
          }
          if (normalizeSha256(actualSha256) !== expectedSha256) {
            return `${reference.label} SHA-256 did not match ${artifactPath}`
          }
          return null
        } catch (error) {
          return `could not verify ${reference.label} ${artifactPath}: ${error?.message ?? String(error)}`
        }
      })
    )
  ).filter(Boolean)
}

async function verifyWindowsPerformanceBudgetArtifact({ path }) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function validateThresholds(thresholds, label, failures, comparisonBound) {
  if (!isRecord(thresholds)) {
    failures.push(`${label} thresholds were missing`)
    return
  }
  for (const field of ['maximumTotalRssMiB', 'maximumTotalRssSlopeMiBPerMinute']) {
    if (!positiveNumber(thresholds[field]))
      failures.push(`${label} thresholds ${field} was invalid`)
  }
  if (!isRecord(thresholds.bmp)) {
    failures.push(`${label} BMP thresholds were missing`)
  } else if (thresholds.bmp.mode === 'disabled') {
    if (thresholds.bmp.maximumRequests !== 0 || thresholds.bmp.maximumBytes !== 0) {
      failures.push(`${label} disabled BMP thresholds must require zero requests and bytes`)
    }
  } else {
    if (comparisonBound && thresholds.bmp.mode !== 'required') {
      failures.push(`${label} BMP mode must be required or disabled`)
    }
    if (!positiveNumber(thresholds.bmp.maximumIntervalP95Ms)) {
      failures.push(`${label} BMP maximumIntervalP95Ms was invalid`)
    }
    if (!positiveInteger(thresholds.bmp.minimumAdvancedFrames)) {
      failures.push(`${label} BMP minimumAdvancedFrames was invalid`)
    }
  }
  if (comparisonBound) {
    if (!positiveNumber(thresholds.maximumTotalCpuP95Percent)) {
      failures.push(`${label} thresholds maximumTotalCpuP95Percent was invalid`)
    }
    for (const field of ['maximumEngineP95Percent', 'maximumDedicatedMiB', 'maximumSharedMiB']) {
      if (!positiveNumber(thresholds.gpu?.[field])) {
        failures.push(`${label} GPU threshold ${field} was invalid`)
      }
    }
  }
  const requiredRoles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  for (const role of requiredRoles) {
    const roleThresholds = thresholds.roles?.[role]
    for (const field of [
      'maximumRssMiB',
      'maximumRssSlopeMiBPerMinute',
      'maximumAverageCpuPercent',
      'maximumP95CpuPercent'
    ]) {
      if (!positiveNumber(roleThresholds?.[field])) {
        failures.push(`${label} ${role} threshold ${field} was invalid`)
      }
    }
  }
}

function validateComparisonBinding(comparison, failures) {
  if (!nonEmptyString(comparison.aggregatePath)) {
    failures.push('comparison aggregatePath was missing')
  }
  if (!sha256(comparison.aggregateSha256)) {
    failures.push('comparison aggregateSha256 was invalid')
  }
  if (
    !Array.isArray(comparison.reportPaths) ||
    comparison.reportPaths.length !== 6 ||
    !comparison.reportPaths.every(nonEmptyString) ||
    new Set(comparison.reportPaths.map(canonicalEvidencePath)).size !== 6
  ) {
    failures.push('comparison must retain six report paths')
  }
  if (
    !Array.isArray(comparison.reportSha256) ||
    comparison.reportSha256.length !== 6 ||
    !comparison.reportSha256.every(sha256) ||
    new Set(comparison.reportSha256.map((digest) => digest.toLocaleLowerCase('en-US'))).size !== 6
  ) {
    failures.push('comparison must retain six report SHA-256 digests')
  }
}

function windowsBudgetPayloadScopeFailures(document, profile, context) {
  const actual = context?.candidatePayloadSha256
  if (!lowercaseSha256(actual)) {
    return [`candidatePayloadSha256 ${actual ?? 'missing'} was not a lowercase SHA-256 digest`]
  }
  const failures = []
  if (actual !== document.candidatePayloadSha256) {
    failures.push(
      `candidatePayloadSha256 ${actual} != ${document.candidatePayloadSha256 ?? 'missing'}`
    )
  }
  if (actual !== profile.candidatePayloadSha256) {
    failures.push(
      `profile candidatePayloadSha256 ${actual} != ${profile.candidatePayloadSha256 ?? 'missing'}`
    )
  }
  return failures
}

function budgetCandidateScopeFailures(document, profile, context) {
  if (document.kind !== WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND) {
    return windowsBudgetPayloadScopeFailures(document, profile, context)
  }
  const expected = document.candidate
  const actual = {
    sourceCommit: context?.sourceCommit,
    installerSha256: context?.installerSha256,
    executableSha256: context?.candidateSha256,
    packagePayloadSha256: context?.candidatePayloadSha256
  }
  const failures = []
  validateD3d11Candidate(actual, 'runtime candidate', failures)
  if (stableJson(actual) !== stableJson(expected)) {
    failures.push('runtime candidate identity did not match the D3D11 budget candidate')
  }
  if (stableJson(profile?.candidate) !== stableJson(expected)) {
    failures.push('profile candidate identity did not match the D3D11 budget candidate')
  }
  return failures
}

function budgetScopeFailures(document, scope, context, strictScope) {
  if (
    document.kind === WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND &&
    scope?.hardwareClass === WINDOWS_NATURAL_FALLBACK_HARDWARE_CLASS
  ) {
    return naturalFallbackScopeFailures(scope, context)
  }
  const failures = windowsBudgetScopeFailures(scope, context, {
    requireComparison: strictScope
  })
  if (document.kind !== WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND) return failures
  for (const field of ['profile', 'mediaPath', 'topology', 'sourceComposition', 'previewOpen']) {
    if (scope?.[field] !== context?.[field]) {
      failures.push(`${field} ${context?.[field] ?? 'missing'} != ${scope?.[field] ?? 'missing'}`)
    }
  }
  if (scope?.selectionMode !== undefined || context?.selectionMode !== undefined) {
    if (scope?.selectionMode !== context?.selectionMode) {
      failures.push(
        `selectionMode ${context?.selectionMode ?? 'missing'} != ${scope?.selectionMode ?? 'missing'}`
      )
    }
  }
  if (scope?.previewOpen === true) {
    if (stableJson(scope.preview) !== stableJson(context?.preview)) {
      failures.push('preview triple did not match the D3D11 budget scope')
    }
  }
  return failures
}

function naturalFallbackScopeFailures(scope, context) {
  const failures = []
  for (const field of ['hardwareClass', 'profileClass', 'buildMode', 'profile', 'mediaPath']) {
    if (scope?.[field] !== context?.[field]) {
      failures.push(`${field} ${context?.[field] ?? 'missing'} != ${scope?.[field] ?? 'missing'}`)
    }
  }
  if (scope?.selectionMode !== context?.selectionMode) {
    failures.push(
      `selectionMode ${context?.selectionMode ?? 'missing'} != ${scope?.selectionMode ?? 'missing'}`
    )
  }
  for (const field of ['platform', 'arch', 'release']) {
    if (scope?.operatingSystem?.[field] !== context?.operatingSystem?.[field]) {
      failures.push(
        `operatingSystem.${field} ${context?.operatingSystem?.[field] ?? 'missing'} != ${scope?.operatingSystem?.[field] ?? 'missing'}`
      )
    }
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (scope?.timing?.[field] !== context?.timing?.[field]) {
      failures.push(
        `timing.${field} ${context?.timing?.[field] ?? 'missing'} != ${scope?.timing?.[field] ?? 'missing'}`
      )
    }
  }
  if (!scope?.topologies?.includes(context?.topology)) {
    failures.push(`topology ${context?.topology ?? 'missing'} was not in the fallback policy`)
  }
  const previewMode = context?.previewOpen === true ? 'open' : 'closed'
  if (!scope?.previewModes?.includes(previewMode)) {
    failures.push(`preview mode ${previewMode} was not in the fallback policy`)
  }
  return failures
}

function windowsBudgetScopeFailures(scope, context, options = {}) {
  const failures = []
  for (const field of ['scenario', 'hardwareClass', 'profileClass', 'buildMode']) {
    if (scope?.[field] !== context?.[field]) {
      failures.push(`${field} ${context?.[field] ?? 'missing'} != ${scope?.[field] ?? 'missing'}`)
    }
  }
  for (const field of ['platform', 'arch']) {
    if (scope?.operatingSystem?.[field] !== context?.operatingSystem?.[field]) {
      failures.push(
        `operatingSystem.${field} ${context?.operatingSystem?.[field] ?? 'missing'} != ${scope?.operatingSystem?.[field] ?? 'missing'}`
      )
    }
  }
  if (
    options.requireComparison === true &&
    scope?.operatingSystem?.release !== context?.operatingSystem?.release
  ) {
    failures.push(
      `operatingSystem.release ${context?.operatingSystem?.release ?? 'missing'} != ${scope?.operatingSystem?.release ?? 'missing'}`
    )
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (scope?.timing?.[field] !== context?.timing?.[field]) {
      failures.push(
        `timing.${field} ${context?.timing?.[field] ?? 'missing'} != ${scope?.timing?.[field] ?? 'missing'}`
      )
    }
  }
  return failures
}

function requireAtMost(failures, label, value, maximum) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (!Number.isFinite(maximum)) failures.push(`${label} budget threshold was missing`)
  else if (value > maximum) failures.push(`${label} ${value} exceeded ${maximum}`)
}

function requireAtLeast(failures, label, value, minimum) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (!Number.isFinite(minimum)) failures.push(`${label} budget threshold was missing`)
  else if (value < minimum) failures.push(`${label} ${value} was below ${minimum}`)
}

function requireEqualMetric(failures, label, value, expected) {
  if (value !== expected) failures.push(`${label} ${value ?? 'missing'} did not equal ${expected}`)
}

function formatContext(context) {
  return `scenario=${context?.scenario ?? 'missing'}, hardwareClass=${context?.hardwareClass ?? 'missing'}, platform=${context?.operatingSystem?.platform ?? 'missing'}`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function canonicalEvidencePath(value) {
  return resolve('/', value.trim().replaceAll('\\', '/')).toLocaleLowerCase('en-US')
}

function portableAbsolutePath(value) {
  return (
    nonEmptyString(value) &&
    (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value))
  )
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function finite(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('calibration metric was not finite')
  return number
}

function ceilTo(value, precision) {
  return Math.ceil(value / precision) * precision
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function normalizeSha256(value) {
  return typeof value === 'string' ? value.toLocaleLowerCase('en-US') : value
}

function canonicalTimestamp(value) {
  if (!nonEmptyString(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function equalSha256Arrays(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => normalizeSha256(value) === normalizeSha256(right[index]))
  )
}

function windowsBudgetEvidenceRunCount(scope) {
  return scope?.scenario === '1080p60-av-endurance' && scope?.timing?.measurementMs === 600_000
    ? 1
    : 3
}
